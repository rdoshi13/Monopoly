import { once } from "node:events";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { io, type Socket } from "socket.io-client";
import { httpServer, resetRoomCreationLimits } from "./index.js";

let baseUrl = "";
const sockets: Socket[] = [];
beforeAll(async () => {
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(() => {
  sockets.forEach((socket) => socket.disconnect());
  return new Promise<void>((resolve) => httpServer.close(() => resolve()));
});
// Every test connects from the same loopback address and so shares one budget.
beforeEach(() => resetRoomCreationLimits());

async function connectSession(session: { roomCode: string; playerId: string; sessionToken: string }) {
  const socket = io(baseUrl, { transports: ["websocket"] });
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  const state = new Promise<unknown>((resolve) => socket.once("game:state", resolve));
  socket.emit("room:join", session);
  await state;
  return socket;
}

describe("local room API", () => {
  it("creates a room, joins a guest, and rejects a duplicate name", async () => {
    const create = await fetch(`${baseUrl}/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Alice" }) });
    const created = await create.json() as { roomCode: string };
    expect(create.status).toBe(201);
    expect(created.roomCode).toHaveLength(6);
    const join = await fetch(`${baseUrl}/rooms/${created.roomCode}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Bob" }) });
    expect(join.status).toBe(200);
    const duplicate = await fetch(`${baseUrl}/rooms/${created.roomCode}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Bob" }) });
    expect(duplicate.status).toBe(409);
  });

  it("keeps the lobby joinable after the first player readies", async () => {
    const create = await fetch(`${baseUrl}/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Host" }) });
    const host = await create.json() as { roomCode: string; playerId: string; sessionToken: string };
    const socket = await connectSession(host);
    sockets.push(socket);
    const updated = new Promise<{ phase: string; players: Array<{ ready: boolean }> }>((resolve) => socket.once("game:state", resolve));
    socket.emit("game:action", { type: "ready", ready: true });
    expect((await updated).phase).toBe("lobby");

    const join = await fetch(`${baseUrl}/rooms/${host.roomCode}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Late Player" }) });
    expect(join.status).toBe(200);
  });

  it("rejects malformed room:join payloads without crashing the process", async () => {
    const crashes: unknown[] = [];
    const record = (error: unknown) => crashes.push(error);
    process.on("uncaughtException", record);

    const socket = io(baseUrl, { transports: ["websocket"] });
    sockets.push(socket);
    await new Promise<void>((resolve) => socket.once("connect", resolve));

    for (const payload of [{ roomCode: 42, playerId: "x", sessionToken: "y" }, { roomCode: ["A"] }, "not an object", null, undefined, []]) {
      const failure = new Promise<{ code: string }>((resolve) => socket.once("game:error", resolve));
      socket.emit("room:join", payload);
      expect((await failure).code).toBe("AUTH_FAILED");
    }

    process.off("uncaughtException", record);
    expect(crashes).toEqual([]);
    expect(socket.connected).toBe(true);
  });

  it("distinguishes a missing room from a genuine conflict", async () => {
    const join = (code: string, name: string) => fetch(`${baseUrl}/rooms/${code}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    expect((await join("ZZZZZZ", "Nobody")).status).toBe(404);

    const created = await (await fetch(`${baseUrl}/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Host" }) })).json() as { roomCode: string };
    expect((await join(created.roomCode, "Host")).status).toBe(409);
    expect((await join(created.roomCode, "  ")).status).toBe(400);
  });

  it("rate-limits room creation instead of allowing unbounded allocation", async () => {
    const create = () => fetch(`${baseUrl}/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Flood" }) });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) statuses.push((await create()).status);

    // The window allows a handful of rooms per client, then rejects the rest.
    expect(statuses.filter((status) => status === 201).length).toBeLessThanOrEqual(5);
    expect(statuses.at(-1)).toBe(429);
    expect((await (await create()).json() as { error: string }).error).toMatch(/too many/i);
  });

  it("publishes a Run-Down deadline when the game starts", async () => {
    const create = await fetch(`${baseUrl}/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Timer Host" }) });
    const host = await create.json() as { roomCode: string; playerId: string; sessionToken: string };
    const join = await fetch(`${baseUrl}/rooms/${host.roomCode}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Timer Guest" }) });
    const guest = await join.json() as { roomCode: string; playerId: string; sessionToken: string };
    const hostSocket = await connectSession(host);
    const guestSocket = await connectSession(guest);
    sockets.push(hostSocket, guestSocket);

    const modeSelected = new Promise<void>((resolve) => hostSocket.once("game:state", () => resolve()));
    hostSocket.emit("game:action", { type: "select-mode", modeId: "run-down" });
    await modeSelected;
    const hostReady = new Promise<void>((resolve) => hostSocket.once("game:state", () => resolve()));
    hostSocket.emit("game:action", { type: "ready", ready: true });
    await hostReady;
    const started = new Promise<{ locked: boolean; turnDeadline: number | null }>((resolve) => hostSocket.once("room:state", resolve));
    guestSocket.emit("game:action", { type: "ready", ready: true });
    const room = await started;

    expect(room.locked).toBe(true);
    expect(room.turnDeadline).toBeGreaterThan(Date.now());
  });

  it("preserves the player, roll phase, revision, and deadline after a mortgage", async () => {
    const random = vi.spyOn(Math, "random").mockImplementationOnce(() => 0.87654321).mockReturnValue(1 / 3);
    try {
      const create = await fetch(`${baseUrl}/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Mortgage Host" }) });
      const host = await create.json() as { roomCode: string; playerId: string; sessionToken: string };
      const join = await fetch(`${baseUrl}/rooms/${host.roomCode}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Mortgage Guest" }) });
      const guest = await join.json() as { roomCode: string; playerId: string; sessionToken: string };
      const hostSocket = await connectSession(host);
      const guestSocket = await connectSession(guest);
      sockets.push(hostSocket, guestSocket);

      const act = async (socket: Socket, action: unknown) => {
        const roomState = new Promise<{ turnDeadline: number | null }>((resolve) => hostSocket.once("room:state", resolve));
        const gameState = new Promise<{ currentPlayerId: string | null; phase: string; turnRevision: number; players: Array<{ id: string; balance: number; properties: Array<{ posistion: number; mortgaged: boolean }> }> }>((resolve) => hostSocket.once("game:state", resolve));
        socket.emit("game:action", action);
        return { room: await roomState, game: await gameState };
      };

      await act(hostSocket, { type: "ready", ready: true });
      await act(guestSocket, { type: "ready", ready: true });
      await act(hostSocket, { type: "roll" });
      const purchased = await act(hostSocket, { type: "landing", decision: "buy" });
      const beforeDeadline = purchased.room.turnDeadline;
      const beforeRevision = purchased.game.turnRevision;
      const beforeBalance = purchased.game.players.find((player) => player.id === host.playerId)!.balance;

      const mortgaged = await act(hostSocket, { type: "mortgage", position: 6 });
      const owner = mortgaged.game.players.find((player) => player.id === host.playerId)!;
      expect(mortgaged.game).toMatchObject({ currentPlayerId: host.playerId, phase: "awaiting-roll", turnRevision: beforeRevision });
      expect(mortgaged.room.turnDeadline).toBe(beforeDeadline);
      expect(owner.balance).toBe(beforeBalance + 50);
      expect(owner.properties).toContainEqual(expect.objectContaining({ posistion: 6, mortgaged: true }));
    } finally {
      random.mockRestore();
    }
  });

  it("forwards the authoritative Go salary event and public history", async () => {
    const random = vi.spyOn(Math, "random").mockImplementationOnce(() => 0.7654321).mockReturnValue(0);
    try {
      const create = await fetch(`${baseUrl}/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Salary Host" }) });
      const host = await create.json() as { roomCode: string; playerId: string; sessionToken: string };
      const join = await fetch(`${baseUrl}/rooms/${host.roomCode}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Salary Guest" }) });
      const guest = await join.json() as { roomCode: string; playerId: string; sessionToken: string };
      const hostSocket = await connectSession(host);
      const guestSocket = await connectSession(guest);
      sockets.push(hostSocket, guestSocket);
      const waitForState = (socket: Socket) => new Promise<void>((resolve) => socket.once("game:state", () => resolve()));
      let state = waitForState(hostSocket);
      hostSocket.emit("game:action", { type: "ready", ready: true });
      await state;
      state = waitForState(hostSocket);
      guestSocket.emit("game:action", { type: "ready", ready: true });
      await state;

      const salary = new Promise<Record<string, unknown>>((resolve) => hostSocket.once("game:salary", resolve));
      const history = new Promise<{ action: string }>((resolve) => {
        const listener = (event: { action?: unknown }) => {
          if (typeof event.action !== "string" || !event.action.includes("collected £200")) return;
          hostSocket.off("game:history", listener);
          resolve({ action: event.action });
        };
        hostSocket.on("game:history", listener);
      });
      const snapshot = new Promise<{ players: Array<{ id: string; balance: number }> }>((resolve) => hostSocket.once("game:state", resolve));
      hostSocket.emit("game:action", { type: "roll" });

      expect(await salary).toEqual({ type: "salary", playerId: host.playerId, amount: 200, fromPosition: 2, position: 0, reason: "advanced" });
      expect(await history).toEqual({ action: "Salary Host advanced to Go and collected £200" });
      expect((await snapshot).players.find((player) => player.id === host.playerId)?.balance).toBe(1700);
    } finally {
      random.mockRestore();
    }
  });

  it("authorizes end game from the authenticated room host only", async () => {
    const create = await fetch(`${baseUrl}/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "End Host" }) });
    const host = await create.json() as { roomCode: string; playerId: string; sessionToken: string };
    const join = await fetch(`${baseUrl}/rooms/${host.roomCode}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "End Guest" }) });
    const guest = await join.json() as { roomCode: string; playerId: string; sessionToken: string };
    const hostSocket = await connectSession(host);
    const guestSocket = await connectSession(guest);
    sockets.push(hostSocket, guestSocket);
    let state = new Promise<void>((resolve) => hostSocket.once("game:state", () => resolve()));
    hostSocket.emit("game:action", { type: "ready", ready: true });
    await state;
    state = new Promise<void>((resolve) => hostSocket.once("game:state", () => resolve()));
    guestSocket.emit("game:action", { type: "ready", ready: true });
    await state;

    const rejected = new Promise<{ code: string; message: string }>((resolve) => guestSocket.once("game:error", resolve));
    guestSocket.emit("game:action", { type: "end-game", hostPlayerId: guest.playerId, isHost: true });
    expect(await rejected).toEqual({ code: "REJECTED", message: "Only the room host can end the game" });

    const result = new Promise<{ winnerId: string; standings: Array<{ playerId: string }> }>((resolve) => hostSocket.once("game:game-ended", resolve));
    const finished = new Promise<{ phase: string; winnerId: string; finalStandings: Array<{ playerId: string }> }>((resolve) => hostSocket.once("game:state", resolve));
    const roomState = new Promise<{ turnDeadline: number | null }>((resolve) => hostSocket.once("room:state", resolve));
    hostSocket.emit("game:action", { type: "end-game" });

    expect(await result).toMatchObject({ winnerId: host.playerId, standings: [{ playerId: host.playerId }, { playerId: guest.playerId }] });
    expect(await finished).toMatchObject({ phase: "finished", winnerId: host.playerId, finalStandings: [{ playerId: host.playerId }, { playerId: guest.playerId }] });
    expect((await roomState).turnDeadline).toBeNull();
  });

  it("authorizes the promoted host after the original host expires", async () => {
    const create = await fetch(`${baseUrl}/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Original Host" }) });
    const host = await create.json() as { roomCode: string; playerId: string; sessionToken: string };
    const firstJoin = await fetch(`${baseUrl}/rooms/${host.roomCode}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Promoted Host" }) });
    const promoted = await firstJoin.json() as { roomCode: string; playerId: string; sessionToken: string };
    const secondJoin = await fetch(`${baseUrl}/rooms/${host.roomCode}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Remaining Guest" }) });
    const guest = await secondJoin.json() as { roomCode: string; playerId: string; sessionToken: string };
    const hostSocket = await connectSession(host);
    const promotedSocket = await connectSession(promoted);
    const guestSocket = await connectSession(guest);
    sockets.push(hostSocket, promotedSocket, guestSocket);
    for (const socket of [hostSocket, promotedSocket, guestSocket]) {
      const state = new Promise<void>((resolve) => promotedSocket.once("game:state", () => resolve()));
      socket.emit("game:action", { type: "ready", ready: true });
      await state;
    }

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const paused = new Promise<void>((resolve) => promotedSocket.once("room:state", () => resolve()));
      hostSocket.disconnect();
      await paused;
      const hostChanged = new Promise<{ hostPlayerId: string }>((resolve) => {
        const listener = (room: { hostPlayerId: string }) => {
          if (room.hostPlayerId !== promoted.playerId) return;
          promotedSocket.off("room:state", listener);
          resolve(room);
        };
        promotedSocket.on("room:state", listener);
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await hostChanged).hostPlayerId).toBe(promoted.playerId);
    } finally {
      vi.useRealTimers();
    }

    const forged = new Promise<{ code: string }>((resolve) => guestSocket.once("game:error", resolve));
    guestSocket.emit("game:action", { type: "end-game", playerId: host.playerId, hostPlayerId: host.playerId });
    expect((await forged).code).toBe("REJECTED");

    const finished = new Promise<{ phase: string; winnerId: string }>((resolve) => promotedSocket.once("game:state", resolve));
    promotedSocket.emit("game:action", { type: "end-game" });
    expect(await finished).toMatchObject({ phase: "finished", winnerId: promoted.playerId });
  });
});
