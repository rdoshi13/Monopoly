import { describe, expect, it, vi } from "vitest";
import { GameEngine, type GameSnapshot } from "@monopoly/game-engine";
import { GameHub } from "./index.js";

type DeadlineRoom = {
  snapshot: GameSnapshot | null;
  turnDeadline?: number | null;
  turnTimeoutSeconds?: number | null;
};

describe("Worker mortgage deadline handling", () => {
  it("preserves the authoritative player, roll phase, revision, and deadline", () => {
    const engine = new GameEngine(6);
    engine.connect("a", "Alice");
    engine.connect("b", "Bob");
    engine.handle("a", { type: "ready", ready: true });
    engine.handle("b", { type: "ready", ready: true });
    const internal = engine as unknown as { players: Map<string, { properties: Array<{ posistion: number; count: 0; group: string; mortgaged: boolean }> }> };
    internal.players.get("a")!.properties = [{ posistion: 5, count: 0, group: "Railroad", mortgaged: false }];
    const before = engine.snapshot();
    const deadline = 1_300_000;
    const room: DeadlineRoom = { snapshot: before, turnDeadline: deadline, turnTimeoutSeconds: before.turnTimeoutSeconds };

    const restored = GameEngine.fromSnapshot(before);
    expect(restored.handle("a", { type: "mortgage", position: 5 })).toBe(true);
    room.snapshot = restored.snapshot();
    const updateTurnDeadline = (GameHub.prototype as unknown as { updateTurnDeadline: (candidate: DeadlineRoom, reset: boolean) => void }).updateTurnDeadline;
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      updateTurnDeadline.call({}, room, room.snapshot.turnRevision !== before.turnRevision);
    } finally {
      now.mockRestore();
    }

    const alice = room.snapshot.players.find((player) => player.id === "a")!;
    expect(room.snapshot).toMatchObject({ currentPlayerId: "a", phase: "awaiting-roll", turnRevision: before.turnRevision });
    expect(room.turnDeadline).toBe(deadline);
    expect(alice.balance).toBe(1600);
    expect(alice.properties).toContainEqual(expect.objectContaining({ posistion: 5, mortgaged: true }));
  });

  it("forwards the authoritative Go salary event and public history", async () => {
    const engine = new GameEngine(6);
    engine.connect("a", "Alice");
    engine.connect("b", "Bob");
    engine.handle("a", { type: "ready", ready: true });
    engine.handle("b", { type: "ready", ready: true });
    const snapshot = engine.snapshot();
    snapshot.cardDecks.communitychest = { remaining: [0], discard: [] };
    const sent: string[] = [];
    const socket = { readyState: 1, send: (message: string) => sent.push(message) };
    const storage = { put: vi.fn(), setAlarm: vi.fn(), deleteAlarm: vi.fn(), deleteAll: vi.fn() };
    const room = {
      roomCode: "ABC123",
      hostPlayerId: "a",
      players: [{ playerId: "a", name: "Alice", sessionToken: "one", connected: true }, { playerId: "b", name: "Bob", sessionToken: "two", connected: true }],
      snapshot,
      lastEmptyAt: null,
      disconnectedAt: {},
      turnDeadline: 1_300_000,
      turnTimeoutSeconds: snapshot.turnTimeoutSeconds,
    };
    const hub = Object.assign(Object.create(GameHub.prototype), { room, ctx: { getWebSockets: () => [socket], storage } });
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const action = (GameHub.prototype as unknown as { action: (candidateSocket: typeof socket, candidateRoom: typeof room, playerId: string, payload: unknown) => Promise<void> }).action;
      await action.call(hub, socket, room, "a", { type: "roll" });
    } finally {
      random.mockRestore();
    }

    const messages = sent.map((message) => JSON.parse(message) as { event: string; payload: unknown });
    expect(messages).toContainEqual({ event: "game:salary", payload: { type: "salary", playerId: "a", amount: 200, fromPosition: 2, position: 0, reason: "advanced" } });
    expect(messages).toContainEqual({ event: "game:history", payload: { type: "history", action: "Alice advanced to Go and collected £200" } });
    expect(room.snapshot.players.find((player) => player.id === "a")?.balance).toBe(1700);
  });

  it("identifies a deadline expiry after mortgage instead of making it look like mortgage ended the turn", async () => {
    const engine = new GameEngine(6);
    engine.connect("a", "Alice");
    engine.connect("b", "Bob");
    engine.handle("a", { type: "ready", ready: true });
    engine.handle("b", { type: "ready", ready: true });
    const internal = engine as unknown as { players: Map<string, { properties: Array<{ posistion: number; count: 0; group: string; mortgaged: boolean }> }> };
    internal.players.get("a")!.properties = [{ posistion: 5, count: 0, group: "Railroad", mortgaged: false }];
    expect(engine.handle("a", { type: "mortgage", position: 5 })).toBe(true);

    const sent: string[] = [];
    const socket = { readyState: 1, send: (message: string) => sent.push(message) };
    const storage = { put: vi.fn(), setAlarm: vi.fn(), deleteAlarm: vi.fn(), deleteAll: vi.fn() };
    const room = {
      roomCode: "ABC123",
      hostPlayerId: "a",
      players: [{ playerId: "a", name: "Alice", sessionToken: "one", connected: true }, { playerId: "b", name: "Bob", sessionToken: "two", connected: true }],
      snapshot: engine.snapshot(),
      lastEmptyAt: null,
      disconnectedAt: {},
      turnDeadline: 1_000_000,
      turnTimeoutSeconds: engine.snapshot().turnTimeoutSeconds,
    };
    const hub = Object.assign(Object.create(GameHub.prototype), { room, ctx: { getWebSockets: () => [socket], storage } });
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      await (GameHub.prototype.alarm as (this: typeof hub) => Promise<void>).call(hub);
    } finally {
      now.mockRestore();
    }

    const messages = sent.map((message) => JSON.parse(message) as { event: string; payload: unknown });
    expect(messages).toContainEqual({ event: "game:history", payload: { type: "history", action: "Alice's turn expired" } });
    expect(messages.find((message) => message.event === "game:state")?.payload).toMatchObject({ currentPlayerId: "b", phase: "awaiting-roll" });
  });

  it("authorizes end game from the authenticated room host only", async () => {
    const engine = new GameEngine(6);
    engine.connect("a", "Alice");
    engine.connect("b", "Bob");
    engine.handle("a", { type: "ready", ready: true });
    engine.handle("b", { type: "ready", ready: true });
    const sent: string[] = [];
    const socket = { readyState: 1, send: (message: string) => sent.push(message) };
    const storage = { put: vi.fn(), setAlarm: vi.fn(), deleteAlarm: vi.fn(), deleteAll: vi.fn() };
    const room = {
      roomCode: "ABC123",
      hostPlayerId: "a",
      players: [{ playerId: "a", name: "Alice", sessionToken: "one", connected: true }, { playerId: "b", name: "Bob", sessionToken: "two", connected: true }],
      snapshot: engine.snapshot(),
      lastEmptyAt: null,
      disconnectedAt: {},
      turnDeadline: 1_300_000,
      turnTimeoutSeconds: engine.snapshot().turnTimeoutSeconds,
    };
    const hub = Object.assign(Object.create(GameHub.prototype), { room, ctx: { getWebSockets: () => [socket], storage } });
    const action = (GameHub.prototype as unknown as { action: (candidateSocket: typeof socket, candidateRoom: typeof room, playerId: string, payload: unknown) => Promise<void> }).action;

    await action.call(hub, socket, room, "b", { type: "end-game", hostPlayerId: "b", isHost: true });
    expect(sent.map((message) => JSON.parse(message))).toEqual([{ event: "game:error", payload: { code: "REJECTED", message: "Only the room host can end the game" } }]);
    expect(room.snapshot.phase).toBe("awaiting-roll");

    sent.length = 0;
    await action.call(hub, socket, room, "a", { type: "end-game" });
    const messages = sent.map((message) => JSON.parse(message) as { event: string; payload: unknown });
    expect(messages).toContainEqual({ event: "game:game-ended", payload: expect.objectContaining({ winnerId: "a", standings: [expect.objectContaining({ playerId: "a" }), expect.objectContaining({ playerId: "b" })] }) });
    expect(room.snapshot).toMatchObject({ phase: "finished", winnerId: "a", finalStandings: [{ playerId: "a" }, { playerId: "b" }] });
    expect(room.turnDeadline).toBeNull();
  });

  it("accepts the promoted host and rejects the removed original host", async () => {
    const engine = new GameEngine(6);
    engine.connect("a", "Alice");
    engine.connect("b", "Bob");
    engine.connect("c", "Cara");
    for (const id of ["a", "b", "c"]) engine.handle(id, { type: "ready", ready: true });
    engine.disconnect("a");
    const sent: string[] = [];
    const socket = { readyState: 1, send: (message: string) => sent.push(message) };
    const storage = { put: vi.fn(), setAlarm: vi.fn(), deleteAlarm: vi.fn(), deleteAll: vi.fn() };
    const room = {
      roomCode: "ABC123",
      // Simulate the stale room cache left by an engine-side host removal. The
      // action path must resynchronize from the authoritative snapshot first.
      hostPlayerId: "a",
      players: [{ playerId: "b", name: "Bob", sessionToken: "two", connected: true }, { playerId: "c", name: "Cara", sessionToken: "three", connected: true }],
      snapshot: engine.snapshot(),
      lastEmptyAt: null,
      disconnectedAt: {},
      turnDeadline: 1_300_000,
      turnTimeoutSeconds: engine.snapshot().turnTimeoutSeconds,
    };
    const hub = Object.assign(Object.create(GameHub.prototype), { room, ctx: { getWebSockets: () => [socket], storage } });
    const action = (GameHub.prototype as unknown as { action: (candidateSocket: typeof socket, candidateRoom: typeof room, playerId: string, payload: unknown) => Promise<void> }).action;

    await action.call(hub, socket, room, "a", { type: "end-game" });
    expect(sent.map((message) => JSON.parse(message))).toEqual([{ event: "game:error", payload: { code: "REJECTED", message: "Only the room host can end the game" } }]);
    expect(room.snapshot.phase).not.toBe("finished");

    sent.length = 0;
    await action.call(hub, socket, room, "b", { type: "end-game" });
    expect(room.snapshot).toMatchObject({ phase: "finished", winnerId: "b" });
  });
});
