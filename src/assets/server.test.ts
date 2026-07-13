import { describe, expect, it } from "vitest";
import { HostSocket, createHostController } from "./server";

class FakeSocket implements HostSocket {
    public disconnected = false;
    public emitted: Array<{ event: string; args: unknown }> = [];
    private handlers = new Map<string, (args: unknown) => void>();

    public constructor(public id: string) {}

    public on(event: string, handler: (args: unknown) => void) { this.handlers.set(event, handler); }
    public emit(event: string, args?: unknown) { this.emitted.push({ event, args }); }
    public disconnect() { this.disconnected = true; }
    public receive(event: string, args?: unknown) { this.handlers.get(event)?.(args); }
    public events(event: string) { return this.emitted.filter((entry) => entry.event === event); }
}

describe("host protocol adapter", () => {
    it("delivers an initial snapshot, rejects malformed actions, and never accepts raw state", () => {
        const host = createHostController(2);
        const alice = new FakeSocket("alice");
        host.attach(alice);
        alice.receive("name", "Alice");
        expect(alice.events("game-state")).toHaveLength(1);
        alice.receive("action", { type: "player_update", balance: 999999 });
        expect(alice.events("action-rejected").at(-1)?.args).toBe("Invalid action payload");
        expect(host.engine.snapshot().players[0].balance).toBe(1500);
    });

    it("enforces capacity before admission and disconnects the rejected peer", () => {
        const host = createHostController(1);
        const alice = new FakeSocket("alice");
        const bob = new FakeSocket("bob");
        host.attach(alice);
        host.attach(bob);
        alice.receive("name", "Alice");
        bob.receive("name", "Bob");
        expect(bob.disconnected).toBe(true);
        expect(bob.events("state").at(-1)?.args).toBe(2);
    });

    it("broadcasts only validated chat/cursor data and advances the turn after a current-player disconnect", () => {
        const host = createHostController(2);
        const alice = new FakeSocket("alice");
        const bob = new FakeSocket("bob");
        host.attach(alice);
        host.attach(bob);
        alice.receive("name", "<img src=x>");
        bob.receive("name", "Bob");
        alice.receive("message", "hello");
        expect(bob.events("message").at(-1)?.args).toEqual({ from: "<img src=x>", message: "hello" });
        alice.receive("mouse", { x: "not-a-number", y: 2 });
        expect(bob.events("mouse")).toHaveLength(0);
        alice.receive("mouse", { x: 1, y: 2 });
        expect(bob.events("mouse").at(-1)?.args).toEqual({ id: "alice", x: 1, y: 2 });
        alice.receive("action", { type: "ready", ready: true });
        bob.receive("action", { type: "ready", ready: true });
        alice.receive("disconnect");
        expect(host.engine.snapshot().currentPlayerId).toBe("bob");
    });
});
