import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import { GameEngine, type EngineEvent } from "@monopoly/game-engine";
import type { GuestSession, RoomPlayer } from "@monopoly/shared-types";

type Room = {
  roomCode: string;
  hostPlayerId: string;
  players: RoomPlayer[];
  engine: GameEngine;
  lastEmptyAt: number | null;
  turnDeadline: number | null;
};

type Identity = { roomCode: string; playerId: string };

const rooms = new Map<string, Room>();
const identities = new Map<string, Identity>();
const connections = new Map<string, Set<string>>();
const pendingDisconnects = new Map<string, ReturnType<typeof setTimeout>>();
const turnTimers = new Map<string, ReturnType<typeof setTimeout>>();
const code = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const cleanName = (name: string) => name.trim().slice(0, 32);
const identityKey = ({ roomCode, playerId }: Identity) => `${roomCode}:${playerId}`;

const roomView = (room: Room) => ({
  roomCode: room.roomCode,
  hostPlayerId: room.hostPlayerId,
  locked: room.engine.snapshot().gameStarted,
  turnDeadline: room.turnDeadline,
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

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());
app.get("/health", (_req, res) => res.json({ ok: true }));
app.post("/rooms", (req, res) => {
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
const io = new Server(httpServer, { cors: { origin: true } });

function broadcast(room: Room) {
  io.to(room.roomCode).emit("room:state", roomView(room));
  io.to(room.roomCode).emit("game:state", room.engine.snapshot());
}

function updateTurnDeadline(room: Room, reset: boolean) {
  const existing = turnTimers.get(room.roomCode);
  if (existing) clearTimeout(existing);
  turnTimers.delete(room.roomCode);
  const snapshot = room.engine.snapshot();
  const seconds = snapshot.selectedMode.turnTimer;
  if (!seconds || !snapshot.gameStarted || snapshot.phase === "finished" || snapshot.pausedPlayerId) {
    room.turnDeadline = null;
    return;
  }
  if (reset || !room.turnDeadline) room.turnDeadline = Date.now() + seconds * 1000;
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
  socket.on("room:join", (payload: GuestSession) => {
    const room = rooms.get(payload?.roomCode?.toUpperCase());
    const player = room?.players.find((candidate) => candidate.playerId === payload?.playerId && candidate.sessionToken === payload?.sessionToken);
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

  socket.on("game:action", (action: unknown) => {
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

  socket.on("disconnect", () => {
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

export { app, httpServer };
