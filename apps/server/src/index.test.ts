import { once } from "node:events";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
});
