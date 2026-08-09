import { DurableObject } from "cloudflare:workers";
import { GameEngine, type GameSnapshot } from "@monopoly/game-engine";
import type { GuestSession, RoomPlayer } from "@monopoly/shared-types";
import { isAllowedOrigin, parseWireMessage } from "./security";
import { DISCONNECT_GRACE_MS, EMPTY_ROOM_MS, nextWakeup } from "./scheduling";

interface Env { GAME_HUB: DurableObjectNamespace<GameHub>; ROOM_LIMITER: DurableObjectNamespace<RoomLimiter>; ALLOWED_ORIGIN: string; }
type Room = { roomCode: string; hostPlayerId: string; players: RoomPlayer[]; snapshot: GameSnapshot | null; lastEmptyAt: number | null; disconnectedAt: Record<string, number>; turnDeadline?: number | null; turnTimeoutSeconds?: number | null };
type Identity = { roomCode: string; playerId: string };
const json = (status: number, body: unknown, origin: string) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "access-control-allow-origin": origin } });
const clean = (name: string) => name.trim().slice(0, 32);
const newRoomCode = () => crypto.randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
const ROOM_CREATIONS_PER_WINDOW = 5;
const ROOM_CREATION_WINDOW_MS = 60_000;
const CREATE_ATTEMPTS = 5;

/**
 * Rate-limits room creation. Sharding rooms across Durable Objects left no
 * shared instance to hold this, so one named instance owns it. Held in memory
 * only: an eviction resets the window, which is acceptable for a throttle.
 */
export class RoomLimiter extends DurableObject<Env> {
  private attempts = new Map<string, number[]>();
  async fetch(request: Request): Promise<Response> {
    const client = new URL(request.url).searchParams.get("client") ?? "unknown";
    const now = Date.now();
    const recent = (this.attempts.get(client) ?? []).filter((at) => now - at < ROOM_CREATION_WINDOW_MS);
    this.attempts.set(client, recent);
    if (recent.length >= ROOM_CREATIONS_PER_WINDOW) return new Response(null, { status: 429 });
    recent.push(now);
    return new Response(null, { status: 204 });
  }
}

/**
 * One instance owns exactly one room, addressed by `idFromName(roomCode)`.
 * Rooms therefore never share memory, a storage value, or a request queue.
 */
export class GameHub extends DurableObject<Env> {
  private room: Room | null = null;
  private sockets = new Map<WebSocket, Identity>();
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); this.ctx.blockConcurrencyWhile(async () => { this.room = (await this.ctx.storage.get<Room>("room")) ?? null; }); }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") ?? this.env.ALLOWED_ORIGIN;
    const code = (url.searchParams.get("room") ?? "").toUpperCase();
    if (url.pathname === "/ws") return this.upgrade(request, code);
    if (request.method === "POST" && url.pathname === "/rooms") return this.create(request, code, origin);
    if (request.method === "POST" && url.pathname === "/join") return this.join(request, origin);
    return json(404, { error: "Not found" }, origin);
  }

  /** A 409 means this code is already taken, so the entrypoint retries with another. */
  private async create(request: Request, code: string, origin: string) {
    if (this.room) return json(409, { error: "Room code already in use" }, origin);
    const body = await request.json<{ name?: unknown }>().catch(() => ({}));
    const name = typeof body.name === "string" ? clean(body.name) : "";
    if (!name) return json(400, { error: "Name is required" }, origin);
    const playerId = crypto.randomUUID(), sessionToken = crypto.randomUUID();
    const engine = new GameEngine(6);
    engine.connect(playerId, name);
    this.room = { roomCode: code, hostPlayerId: playerId, players: [{ playerId, name, sessionToken, connected: false }], snapshot: engine.snapshot(), lastEmptyAt: Date.now(), disconnectedAt: {}, turnDeadline: null, turnTimeoutSeconds: null };
    await this.persist();
    return json(201, { roomCode: code, playerId, sessionToken }, origin);
  }

  private async join(request: Request, origin: string) {
    const room = this.room;
    const body = await request.json<{ name?: unknown }>().catch(() => ({}));
    const name = typeof body.name === "string" ? clean(body.name) : "";
    if (!room) return json(404, { error: "Room not found" }, origin);
    if (!name) return json(400, { error: "Name is required" }, origin);
    if (room.snapshot?.gameStarted || room.players.length >= 6) return json(409, { error: room.snapshot?.gameStarted ? "Game already started" : "Room is full" }, origin);
    if (room.players.some((player) => player.name.toLowerCase() === name.toLowerCase())) return json(409, { error: "Name is already in use" }, origin);
    const playerId = crypto.randomUUID(), sessionToken = crypto.randomUUID();
    const engine = room.snapshot ? GameEngine.fromSnapshot(room.snapshot) : new GameEngine(6);
    if (!room.snapshot) for (const player of room.players) engine.connect(player.playerId, player.name);
    if (!engine.connect(playerId, name)) return json(409, { error: "Unable to join game lobby" }, origin);
    room.snapshot = engine.snapshot();
    room.players.push({ playerId, name, sessionToken, connected: false });
    await this.persist();
    return json(200, { roomCode: room.roomCode, playerId, sessionToken }, origin);
  }

  private upgrade(request: Request, code: string) { if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json(426, { error: "Expected WebSocket" }, this.env.ALLOWED_ORIGIN); if (!this.room || this.room.roomCode !== code) return json(404, { error: "Room not found" }, this.env.ALLOWED_ORIGIN); const pair = new WebSocketPair(); const [client, server] = Object.values(pair); this.ctx.acceptWebSocket(server); return new Response(null, { status: 101, webSocket: client }); }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer) {
    const message = parseWireMessage(raw);
    if (!message) return this.error(socket, "BAD_REQUEST", "Malformed message");
    const room = this.room;
    if (!room) return this.error(socket, "ROOM_NOT_FOUND", "Room not found");
    if (message.event === "room:join") return this.socketJoin(socket, room, message.payload);
    const identity = this.sockets.get(socket) ?? socket.deserializeAttachment() as Identity | null;
    if (!identity) return this.error(socket, "NOT_JOINED", "Join a room first");
    if (message.event === "state:sync_request") return this.emitState(socket, room);
    if (message.event === "game:action") return this.action(socket, room, identity.playerId, message.payload);
    if (message.event === "message" && typeof message.payload === "string") return this.broadcast("game:message", { from: room.players.find((player) => player.playerId === identity.playerId)?.name, message: message.payload.slice(0, 500) });
    return this.error(socket, "BAD_EVENT", "Unsupported event");
  }

  private async socketJoin(socket: WebSocket, room: Room, payload: unknown) {
    const value = payload as Partial<GuestSession> | null;
    const player = typeof value?.playerId === "string" && typeof value.sessionToken === "string"
      ? room.players.find((candidate) => candidate.playerId === value.playerId && candidate.sessionToken === value.sessionToken)
      : undefined;
    if (!player) return this.error(socket, "AUTH_FAILED", "Invalid room session");
    room.disconnectedAt ??= {};
    delete room.disconnectedAt[player.playerId];
    player.connected = true;
    if (room.snapshot) {
      const wasPaused = room.snapshot.pausedPlayerId === player.playerId;
      const engine = GameEngine.fromSnapshot(room.snapshot);
      engine.resumePlayer(player.playerId);
      room.snapshot = engine.snapshot();
      this.updateTurnDeadline(room, wasPaused);
    }
    room.lastEmptyAt = null;
    const identity = { roomCode: room.roomCode, playerId: player.playerId };
    this.sockets.set(socket, identity);
    socket.serializeAttachment(identity);
    await this.persist();
    this.emitState(socket, room);
    this.broadcastRoom(room);
  }

  private async action(socket: WebSocket, room: Room, playerId: string, action: unknown) {
    let engine: GameEngine;
    if (room.snapshot) engine = GameEngine.fromSnapshot(room.snapshot);
    else { engine = new GameEngine(6); for (const player of room.players) engine.connect(player.playerId, player.name); }
    const beforeRevision = engine.snapshot().turnRevision;
    const events: Array<{ type: string; reason?: string }> = [];
    engine.on((event) => events.push(event));
    if (!engine.handle(playerId, action)) return this.error(socket, "REJECTED", events.find((event) => event.type === "rejected")?.reason ?? "Action rejected");
    room.snapshot = engine.snapshot();
    this.updateTurnDeadline(room, room.snapshot.turnRevision !== beforeRevision);
    await this.persist();
    for (const event of events) if (event.type !== "state" && event.type !== "rejected") this.broadcast(`game:${event.type}`, event);
    this.broadcastRoom(room);
  }

  private emitState(socket: WebSocket, room: Room) { this.emit(socket, "room:state", { roomCode: room.roomCode, hostPlayerId: room.hostPlayerId, locked: room.snapshot?.gameStarted ?? false, turnDeadline: room.turnDeadline ?? null, players: room.players.map(({ playerId, name, connected }) => ({ playerId, name, connected })) }); if (room.snapshot) this.emit(socket, "game:state", room.snapshot); }
  private broadcastRoom(room: Room) { for (const socket of this.ctx.getWebSockets()) this.emitState(socket, room); }
  private broadcast(event: string, payload: unknown) { for (const socket of this.ctx.getWebSockets()) this.emit(socket, event, payload); }
  private emit(socket: WebSocket, event: string, payload?: unknown) { if (socket.readyState === 1) socket.send(JSON.stringify({ event, payload })); }
  private error(socket: WebSocket, code: string, message: string) { this.emit(socket, "game:error", { code, message }); }

  async webSocketClose(socket: WebSocket) {
    const identity = this.sockets.get(socket) ?? socket.deserializeAttachment() as Identity | null;
    const room = this.room;
    if (!identity || !room) return;
    this.sockets.delete(socket);
    if (this.ctx.getWebSockets().some((candidate) => candidate !== socket && (candidate.deserializeAttachment() as Identity | null)?.playerId === identity.playerId)) return;
    const player = room.players.find((candidate) => candidate.playerId === identity.playerId);
    if (!player) return;
    room.disconnectedAt ??= {};
    player.connected = false;
    room.disconnectedAt[player.playerId] = Date.now();
    if (room.snapshot) {
      const engine = GameEngine.fromSnapshot(room.snapshot);
      engine.pauseForReconnect(player.playerId);
      room.snapshot = engine.snapshot();
      this.updateTurnDeadline(room, false);
    }
    room.lastEmptyAt = room.players.some((candidate) => candidate.connected) ? null : Date.now();
    await this.persist();
    this.broadcastRoom(room);
  }

  async alarm() {
    const room = this.room;
    if (!room) return this.ctx.storage.deleteAll();
    const now = Date.now();
    if (room.turnDeadline && room.turnDeadline <= now && room.snapshot) {
      const engine = GameEngine.fromSnapshot(room.snapshot);
      room.turnDeadline = null;
      if (engine.expireTurn()) { room.snapshot = engine.snapshot(); this.updateTurnDeadline(room, true); this.broadcastRoom(room); }
    }
    room.disconnectedAt ??= {};
    for (const [playerId, disconnectedAt] of Object.entries(room.disconnectedAt)) {
      if (now - disconnectedAt < DISCONNECT_GRACE_MS) continue;
      delete room.disconnectedAt[playerId];
      room.players = room.players.filter((player) => player.playerId !== playerId);
      if (room.snapshot) {
        const engine = GameEngine.fromSnapshot(room.snapshot);
        engine.disconnect(playerId);
        room.snapshot = engine.snapshot();
        room.hostPlayerId = room.snapshot.lobbyHostId ?? room.players[0]?.playerId ?? "";
        this.updateTurnDeadline(room, true);
      }
      this.broadcastRoom(room);
    }
    if (room.lastEmptyAt && !room.players.some((player) => player.connected) && now - room.lastEmptyAt >= EMPTY_ROOM_MS) {
      this.room = null;
      return this.ctx.storage.deleteAll();
    }
    await this.persist();
  }

  private updateTurnDeadline(room: Room, reset: boolean) { const snapshot = room.snapshot; const seconds = snapshot?.turnTimeoutSeconds; if (!snapshot || !seconds || !snapshot.gameStarted || snapshot.phase === "finished" || snapshot.pausedPlayerId) { room.turnDeadline = null; room.turnTimeoutSeconds = null; return; } if (reset || !room.turnDeadline || room.turnTimeoutSeconds !== seconds) { room.turnDeadline = Date.now() + seconds * 1000; room.turnTimeoutSeconds = seconds; } }

  private async persist() {
    if (!this.room) return this.ctx.storage.deleteAll();
    await this.ctx.storage.put("room", this.room);
    const wakeup = nextWakeup(this.room);
    if (wakeup === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(wakeup);
  }
}

const roomStub = (env: Env, code: string) => env.GAME_HUB.get(env.GAME_HUB.idFromName(code));

/** Room codes are minted here so a room can be addressed by `idFromName` without a registry. */
async function createRoom(request: Request, env: Env, origin: string, url: URL) {
  const limiter = env.ROOM_LIMITER.get(env.ROOM_LIMITER.idFromName("global"));
  const client = request.headers.get("cf-connecting-ip") ?? "unknown";
  if ((await limiter.fetch(`${url.origin}/limit?client=${encodeURIComponent(client)}`)).status === 429) {
    return json(429, { error: "Too many rooms created, try again in a minute" }, origin);
  }
  const body = await request.text();
  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
    const code = newRoomCode();
    const response = await roomStub(env, code).fetch(new Request(`${url.origin}/rooms?room=${code}`, { method: "POST", headers: request.headers, body }));
    if (response.status !== 409) return response;
  }
  return json(503, { error: "Could not allocate a room, try again shortly" }, origin);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestOrigin = request.headers.get("origin");
    if (requestOrigin && !isAllowedOrigin(requestOrigin, env.ALLOWED_ORIGIN)) return json(403, { error: "Origin not allowed" }, env.ALLOWED_ORIGIN);
    const origin = requestOrigin ?? env.ALLOWED_ORIGIN;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": origin, "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" } });
    const url = new URL(request.url);
    // Health and preflight are answered here so they never spin up a room object.
    if (url.pathname === "/health") return json(200, { ok: true }, origin);
    if (url.pathname === "/ws") {
      const code = (url.searchParams.get("room") ?? "").toUpperCase();
      if (!code) return json(400, { error: "A room code is required" }, origin);
      return roomStub(env, code).fetch(new Request(`${url.origin}/ws?room=${code}`, request));
    }
    if (request.method === "POST" && url.pathname === "/rooms") return createRoom(request, env, origin, url);
    const join = url.pathname.match(/^\/rooms\/([^/]+)\/join$/);
    if (request.method === "POST" && join) {
      const code = join[1].toUpperCase();
      return roomStub(env, code).fetch(new Request(`${url.origin}/join?room=${code}`, { method: "POST", headers: request.headers, body: await request.text() }));
    }
    return json(404, { error: "Not found" }, origin);
  },
};
