import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import cors from "cors";
import express from "express";
import { Server, type Socket } from "socket.io";
import { GameEngine, type EngineEvent } from "@monopoly/game-engine";
import { isAllowedOrigin, type GuestSession, type RoomPlayer } from "@monopoly/shared-types";

type Room = {
  roomCode: string;
  hostPlayerId: string;
  players: RoomPlayer[];
  engine: GameEngine;
  lastEmptyAt: number | null;
  turnDeadline: number | null;
  /** Timeout the current deadline was derived from, so a phase change restarts it. */
  turnTimeoutSeconds: number | null;
};

type Identity = { roomCode: string; playerId: string };

const ROOM_CREATIONS_PER_WINDOW = 5;
const ROOM_CREATION_WINDOW_MS = 60_000;
const MAX_ROOMS = 500;

const rooms = new Map<string, Room>();
const roomCreations = new Map<string, number[]>();
const identities = new Map<string, Identity>();
const connections = new Map<string, Set<string>>();
const pendingDisconnects = new Map<string, ReturnType<typeof setTimeout>>();
const turnTimers = new Map<string, ReturnType<typeof setTimeout>>();
const code = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const cleanName = (name: string) => name.trim().slice(0, 32);
const identityKey = ({ roomCode, playerId }: Identity) => `${roomCode}:${playerId}`;

/** Rooms live in memory until pruned, so unbounded creation is a memory-exhaustion path. */
function allowRoomCreation(client: string, now = Date.now()): boolean {
  const recent = (roomCreations.get(client) ?? []).filter((at) => now - at < ROOM_CREATION_WINDOW_MS);
  roomCreations.set(client, recent);
  if (recent.length >= ROOM_CREATIONS_PER_WINDOW) return false;
  recent.push(now);
  return true;
}

/** Socket payloads are untrusted; every field is checked before it reaches a room lookup. */
function parseGuestSession(value: unknown): GuestSession | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { roomCode, playerId, sessionToken } = value as Record<string, unknown>;
  if (typeof roomCode !== "string" || typeof playerId !== "string" || typeof sessionToken !== "string") return null;
  return { roomCode, playerId, sessionToken };
}

/** Keeps one malformed payload from taking down every in-progress room. */
function onSocketEvent(socket: Socket, event: string, handler: (payload: unknown) => void) {
  socket.on(event, (payload: unknown) => {
    try {
      handler(payload);
    } catch (error) {
      console.error(`socket event ${event} failed`, error);
      socket.emit("game:error", { code: "SERVER_ERROR", message: "The server could not process that request" });
    }
  });
}

const roomView = (room: Room) => ({
  roomCode: room.roomCode,
  hostPlayerId: room.hostPlayerId,
  locked: room.engine.snapshot().gameStarted,
  turnDeadline: room.turnDeadline,
  serverTime: Date.now(),
  players: room.players.map(({ playerId, name, connected }) => ({ playerId, name, connected })),
});

function createRoom(name: string): GuestSession {
  const playerId = randomUUID();
  let roomCode = code();
  while (rooms.has(roomCode)) roomCode = code();
  const clean = cleanName(name);
  const sessionToken = randomUUID();
  const engine = new GameEngine(6);
  engine.connect(playerId, clean);
  rooms.set(roomCode, {
    roomCode,
    hostPlayerId: playerId,
    engine,
    lastEmptyAt: Date.now(),
    turnDeadline: null,
    turnTimeoutSeconds: null,
    players: [{ playerId, name: clean, sessionToken, connected: false }],
  });
  return { roomCode, playerId, sessionToken };
}

function joinRoom(roomCode: string, name: string): GuestSession {
  const room = rooms.get(roomCode.toUpperCase());
  if (!room) throw new Error("Room not found");
  if (room.engine.snapshot().gameStarted) throw new Error("Game already started");
  const clean = cleanName(name);
  if (!clean) throw new Error("Name is required");
  if (room.players.length >= 6) throw new Error("Room is full");
  if (room.players.some((player) => player.name.toLowerCase() === clean.toLowerCase())) throw new Error("Name is already in use");
  const playerId = randomUUID();
  const sessionToken = randomUUID();
  if (!room.engine.connect(playerId, clean)) throw new Error("Unable to join game lobby");
  room.players.push({ playerId, name: clean, sessionToken, connected: false });
  return { roomCode: room.roomCode, playerId, sessionToken };
}

// Defaults to the Vite dev origin, which also admits any other localhost port.
const allowedOrigin = process.env.ALLOWED_ORIGIN ?? "http://localhost:5173";
/** A same-origin or non-browser request sends no Origin, which stays permitted. */
const corsOrigin = (origin: string | undefined, callback: (error: Error | null, allowed?: boolean) => void) =>
  callback(null, !origin || isAllowedOrigin(origin, allowedOrigin));

const app = express();
app.use(cors({ origin: corsOrigin }));
app.use(express.json());
app.get("/health", (_req, res) => res.json({ ok: true }));
app.post("/rooms", (req, res) => {
  if (rooms.size >= MAX_ROOMS) return res.status(503).json({ error: "The server is at capacity, try again shortly" });
  if (!allowRoomCreation(req.ip ?? "unknown")) return res.status(429).json({ error: "Too many rooms created, try again in a minute" });
  try {
    const name = typeof req.body?.name === "string" ? req.body.name : "";
    if (!cleanName(name)) throw new Error("Name is required");
    res.status(201).json(createRoom(name));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});
app.post("/rooms/:code/join", (req, res) => {
  try {
    res.json(joinRoom(req.params.code, String(req.body?.name ?? "")));
  } catch (error) {
    res.status(409).json({ error: (error as Error).message });
  }
});

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: corsOrigin } });

function broadcast(room: Room) {
  io.to(room.roomCode).emit("room:state", roomView(room));
  io.to(room.roomCode).emit("game:state", room.engine.snapshot());
}

function updateTurnDeadline(room: Room, reset: boolean) {
  const existing = turnTimers.get(room.roomCode);
  if (existing) clearTimeout(existing);
  turnTimers.delete(room.roomCode);
  const snapshot = room.engine.snapshot();
  const seconds = snapshot.turnTimeoutSeconds;
  if (!seconds || !snapshot.gameStarted || snapshot.phase === "finished" || snapshot.pausedPlayerId) {
    room.turnDeadline = null;
    room.turnTimeoutSeconds = null;
    return;
  }
  if (reset || !room.turnDeadline || room.turnTimeoutSeconds !== seconds) {
    room.turnDeadline = Date.now() + seconds * 1000;
    room.turnTimeoutSeconds = seconds;
  }
  const timer = setTimeout(() => {
    if (rooms.get(room.roomCode) !== room || !room.turnDeadline || room.turnDeadline > Date.now()) return updateTurnDeadline(room, false);
    room.turnDeadline = null;
    if (room.engine.expireTurn()) {
      updateTurnDeadline(room, true);
      broadcast(room);
    }
  }, Math.max(0, room.turnDeadline - Date.now()));
  timer.unref();
  turnTimers.set(room.roomCode, timer);
}

function removeExpiredPlayer(room: Room, playerId: string) {
  const player = room.players.find((candidate) => candidate.playerId === playerId);
  if (!player || player.connected) return;
  room.engine.disconnect(playerId);
  room.players = room.players.filter((candidate) => candidate.playerId !== playerId);
  room.hostPlayerId = room.engine.snapshot().lobbyHostId ?? room.players[0]?.playerId ?? "";
  updateTurnDeadline(room, true);
  broadcast(room);
}

io.on("connection", (socket) => {
  onSocketEvent(socket, "room:join", (payload) => {
    const session = parseGuestSession(payload);
    const room = session ? rooms.get(session.roomCode.toUpperCase()) : undefined;
    const player = room?.players.find((candidate) => candidate.playerId === session?.playerId && candidate.sessionToken === session?.sessionToken);
    if (!room || !player) return socket.emit("game:error", { code: "AUTH_FAILED", message: "Invalid room session" });

    const identity = { roomCode: room.roomCode, playerId: player.playerId };
    const key = identityKey(identity);
    const pending = pendingDisconnects.get(key);
    if (pending) {
      clearTimeout(pending);
      pendingDisconnects.delete(key);
    }
    const activeSockets = connections.get(key) ?? new Set<string>();
    activeSockets.add(socket.id);
    connections.set(key, activeSockets);
    const wasPaused = room.engine.snapshot().pausedPlayerId === player.playerId;
    player.connected = true;
    room.engine.resumePlayer(player.playerId);
    updateTurnDeadline(room, wasPaused);
    room.lastEmptyAt = null;
    identities.set(socket.id, identity);
    socket.join(room.roomCode);
    broadcast(room);
  });

  onSocketEvent(socket, "game:action", (action) => {
    const identity = identities.get(socket.id);
    const room = identity && rooms.get(identity.roomCode);
    if (!room) return socket.emit("game:error", { code: "NOT_JOINED", message: "Join a room first" });

    const beforeRevision = room.engine.snapshot().turnRevision;
    const events: EngineEvent[] = [];
    const unsubscribe = room.engine.on((event) => events.push(event));
    const accepted = room.engine.handle(identity.playerId, action);
    unsubscribe();
    if (!accepted) {
      const rejection = events.find((event) => event.type === "rejected");
      return socket.emit("game:error", { code: "REJECTED", message: rejection?.type === "rejected" ? rejection.reason : "Action rejected" });
    }
    for (const event of events) {
      if (event.type !== "state" && event.type !== "rejected") io.to(room.roomCode).emit(`game:${event.type}`, event);
    }
    updateTurnDeadline(room, room.engine.snapshot().turnRevision !== beforeRevision);
    broadcast(room);
  });

  onSocketEvent(socket, "disconnect", () => {
    const identity = identities.get(socket.id);
    identities.delete(socket.id);
    if (!identity) return;
    const room = rooms.get(identity.roomCode);
    const player = room?.players.find((candidate) => candidate.playerId === identity.playerId);
    if (!room || !player) return;

    const key = identityKey(identity);
    const activeSockets = connections.get(key);
    activeSockets?.delete(socket.id);
    if (activeSockets?.size) return;
    connections.delete(key);

    player.connected = false;
    room.engine.pauseForReconnect(player.playerId);
    updateTurnDeadline(room, false);
    room.lastEmptyAt = room.players.some((candidate) => candidate.connected) ? null : Date.now();
    const disconnectTimer = setTimeout(() => {
      pendingDisconnects.delete(key);
      removeExpiredPlayer(room, player.playerId);
    }, 30000);
    disconnectTimer.unref();
    pendingDisconnects.set(key, disconnectTimer);
    broadcast(room);
  });
});

function pruneRooms(now = Date.now()) {
  for (const [client, attempts] of roomCreations) {
    const recent = attempts.filter((at) => now - at < ROOM_CREATION_WINDOW_MS);
    if (recent.length) roomCreations.set(client, recent);
    else roomCreations.delete(client);
  }
  for (const room of rooms.values()) {
    if (room.lastEmptyAt && !room.players.some((player) => player.connected) && now - room.lastEmptyAt >= 600000) {
      const timer = turnTimers.get(room.roomCode);
      if (timer) clearTimeout(timer);
      turnTimers.delete(room.roomCode);
      rooms.delete(room.roomCode);
    }
  }
}

setInterval(pruneRooms, 60000).unref();
if (process.env.NODE_ENV !== "test") httpServer.listen(Number(process.env.PORT ?? 4000));

/** Test hook: the limiter is keyed by client IP, so every test would share one budget. */
export function resetRoomCreationLimits() {
  roomCreations.clear();
}

export { app, httpServer };
