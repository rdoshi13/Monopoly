import { describe, expect, it } from "vitest";
import { GameEngine } from "./gameEngine";

function game(random: number[] = [0]) {
    let index = 0;
    return new GameEngine(6, () => random[index++] ?? 0);
}

function ready(engine: GameEngine) {
    engine.connect("a", "Alice");
    engine.connect("b", "Bob");
    engine.handle("a", { type: "ready", ready: true });
    engine.handle("b", { type: "ready", ready: true });
}

function player(engine: GameEngine, id: string) {
    return engine.snapshot().players.find((candidate) => candidate.id === id)!;
}

describe("GameEngine authority", () => {
    it("rejects raw state and out-of-turn rolls", () => {
        const engine = game();
        ready(engine);
        expect(engine.handle("b", { type: "roll" })).toBe(false);
        expect(engine.handle("a", { type: "player_update", balance: 999999 })).toBe(false);
        expect(player(engine, "a").balance).toBe(1500);
    });

    it("enforces admission capacity and preset-only host mode selection", () => {
        const engine = new GameEngine(2);
        expect(engine.connect("a", "Alice")).toBe(true);
        expect(engine.connect("b", "Bob")).toBe(true);
        expect(engine.connect("c", "Cara")).toBe(false);
        expect(engine.handle("b", { type: "select-mode", modeId: "run-down" })).toBe(false);
        expect(engine.handle("a", { type: "select-mode", modeId: "run-down" })).toBe(true);
        expect(engine.snapshot().modeId).toBe("run-down");
    });

    it("correctly charges houses and hotels for property-charge cards", () => {
        const engine = game();
        ready(engine);
        const internal = engine as unknown as { players: Map<string, { properties: Array<{ posistion: number; count: number | "h"; group: string }> }> };
        internal.players.get("a")!.properties = [
            { posistion: 1, count: 3, group: "Purple" }, { posistion: 3, count: "h", group: "Purple" },
        ];
        const charge = (engine as unknown as { propertyCharge: (p: unknown, card: { buildings: number; hotels: number }) => number }).propertyCharge(player(engine, "a"), { buildings: 25, hotels: 100 });
        expect(charge).toBe(175);
        const repairCharge = (engine as unknown as { propertyCharge: (p: unknown, card: { buildings: number; hotels: number }) => number }).propertyCharge(player(engine, "a"), { buildings: 40, hotels: 115 });
        expect(repairCharge).toBe(235);
    });

    it("moves a valid accepted trade atomically and charges mortgage transfer interest", () => {
        const engine = game();
        ready(engine);
        const internal = engine as unknown as { players: Map<string, { balance: number; properties: Array<{ posistion: number; count: 0; group: string; mortgaged?: boolean }> }> };
        internal.players.get("a")!.properties = [{ posistion: 5, count: 0, group: "Railroad", mortgaged: true }];
        internal.players.get("b")!.properties = [{ posistion: 1, count: 0, group: "Purple" }];
        expect(engine.handle("a", { type: "trade-propose", to: "b", offeredPositions: [5], requestedPositions: [1], offeredCash: 0, requestedCash: 0 })).toBe(true);
        expect(engine.handle("b", { type: "trade-accept" })).toBe(true);
        expect(player(engine, "a").properties.map((property) => property.posistion)).toEqual([1]);
        expect(player(engine, "b").properties.map((property) => property.posistion)).toEqual([5]);
        expect(player(engine, "b").balance).toBe(1490);
    });

    it("requires a complete group before building and advances correctly when the current player disconnects", () => {
        const engine = game();
        ready(engine);
        const internal = engine as unknown as { players: Map<string, { properties: Array<{ posistion: number; count: 0; group: string }> }> };
        internal.players.get("a")!.properties = [{ posistion: 1, count: 0, group: "Purple" }];
        expect(engine.handle("a", { type: "build", position: 1 })).toBe(false);
        internal.players.get("a")!.properties.push({ posistion: 3, count: 0, group: "Purple" });
        expect(engine.handle("a", { type: "build", position: 1 })).toBe(true);
        engine.disconnect("a");
        expect(engine.snapshot().currentPlayerId).toBe("b");
    });

    it("enforces jail payment/card authorization and locks the mode after game start", () => {
        const engine = game();
        ready(engine);
        const internal = engine as unknown as { players: Map<string, { isInJail: boolean; jailTurnsRemaining: number; getoutCards: number; balance: number }> };
        const alice = internal.players.get("a")!;
        alice.isInJail = true;
        alice.jailTurnsRemaining = 3;
        alice.getoutCards = 1;
        expect(engine.handle("b", { type: "unjail", option: "card" })).toBe(false);
        expect(engine.handle("a", { type: "unjail", option: "card" })).toBe(true);
        expect(player(engine, "a").isInJail).toBe(false);
        expect(engine.handle("a", { type: "select-mode", modeId: "monopol" })).toBe(false);
    });

    it("applies mortgages only to undeveloped owned property and suppresses rent", () => {
        const engine = game([0, 0]);
        ready(engine);
        const internal = engine as unknown as { players: Map<string, { properties: Array<{ posistion: number; count: 0; group: string }>; position: number; balance: number }> };
        internal.players.get("a")!.properties = [{ posistion: 5, count: 0, group: "Railroad" }];
        expect(engine.handle("a", { type: "mortgage", position: 5 })).toBe(true);
        expect(player(engine, "a").balance).toBe(1600);
        internal.players.get("b")!.position = 3;
        expect(engine.handle("a", { type: "roll" })).toBe(true);
        expect(engine.handle("b", { type: "roll" })).toBe(true);
        expect(player(engine, "b").balance).toBe(1500);
    });

    it("applies the community-chest repair card from host-selected card data", () => {
        const engine = game([0, 0, 13 / 16]);
        ready(engine);
        const internal = engine as unknown as { players: Map<string, { properties: Array<{ posistion: number; count: number | "h"; group: string }> }> };
        internal.players.get("a")!.properties = [
            { posistion: 1, count: 3, group: "Purple" }, { posistion: 3, count: "h", group: "Purple" },
        ];
        expect(engine.handle("a", { type: "roll" })).toBe(true);
        expect(player(engine, "a").balance).toBe(1265);
        expect(engine.snapshot().currentPlayerId).toBe("b");
    });

    it("rejects a stale trade without changing either player", () => {
        const engine = game();
        ready(engine);
        const internal = engine as unknown as { players: Map<string, { properties: Array<{ posistion: number; count: 0; group: string }> }> };
        internal.players.get("a")!.properties = [{ posistion: 1, count: 0, group: "Purple" }];
        internal.players.get("b")!.properties = [{ posistion: 3, count: 0, group: "Purple" }];
        expect(engine.handle("a", { type: "trade-propose", to: "b", offeredPositions: [1], requestedPositions: [3], offeredCash: 0, requestedCash: 0 })).toBe(true);
        internal.players.get("a")!.properties = [];
        expect(engine.handle("b", { type: "trade-accept" })).toBe(false);
        expect(player(engine, "b").properties.map((property) => property.posistion)).toEqual([3]);
    });

    it("calculates tax and railroad rent from host state", () => {
        const taxGame = game([0, 1 / 6]);
        ready(taxGame);
        const taxInternal = taxGame as unknown as { players: Map<string, { position: number }> };
        taxInternal.players.get("a")!.position = 1;
        expect(taxGame.handle("a", { type: "roll" })).toBe(true);
        expect(player(taxGame, "a").balance).toBe(1300);

        const rentGame = game([0, 1 / 6]);
        ready(rentGame);
        const rentInternal = rentGame as unknown as { players: Map<string, { position: number; properties: Array<{ posistion: number; count: 0; group: string }> }>; currentIndex: number };
        rentInternal.players.get("a")!.properties = [{ posistion: 5, count: 0, group: "Railroad" }];
        rentInternal.players.get("b")!.position = 2;
        rentInternal.currentIndex = 1;
        expect(rentGame.handle("b", { type: "roll" })).toBe(true);
        expect(player(rentGame, "a").balance).toBe(1525);
        expect(player(rentGame, "b").balance).toBe(1475);
    });

    it("releases a jailed player on doubles and charges the official mortgage redemption fee", () => {
        const engine = game([0, 0]);
        ready(engine);
        const internal = engine as unknown as { players: Map<string, { isInJail: boolean; jailTurnsRemaining: number; position: number; properties: Array<{ posistion: number; count: 0; group: string }> }> };
        const alice = internal.players.get("a")!;
        alice.isInJail = true;
        alice.jailTurnsRemaining = 3;
        alice.position = 10;
        alice.properties = [{ posistion: 5, count: 0, group: "Railroad" }];
        expect(engine.handle("a", { type: "mortgage", position: 5 })).toBe(true);
        expect(engine.handle("a", { type: "unmortgage", position: 5 })).toBe(true);
        expect(player(engine, "a").balance).toBe(1490);
        expect(engine.handle("a", { type: "roll" })).toBe(true);
        expect(player(engine, "a").isInJail).toBe(false);
    });

    it("enforces disabled trade modes and cancels a pending trade when a participant disconnects", () => {
        const disabled = game();
        disabled.connect("a", "Alice");
        disabled.connect("b", "Bob");
        disabled.handle("a", { type: "select-mode", modeId: "monopol" });
        disabled.handle("a", { type: "ready", ready: true });
        disabled.handle("b", { type: "ready", ready: true });
        expect(disabled.handle("a", { type: "trade-propose", to: "b", offeredPositions: [], requestedPositions: [], offeredCash: 0, requestedCash: 0 })).toBe(false);

        const active = game();
        ready(active);
        expect(active.handle("a", { type: "trade-propose", to: "b", offeredPositions: [], requestedPositions: [], offeredCash: 0, requestedCash: 0 })).toBe(true);
        active.disconnect("b");
        expect(active.snapshot().pendingTrade).toBeNull();
    });
});
