import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io, type Socket } from "socket.io-client";
import { httpServer } from "./index.js";

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
