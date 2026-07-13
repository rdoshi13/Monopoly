import { describe, expect, it } from "vitest";
import { GameEngine, type EngineEvent } from "../src/engine.js";

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

    it("emits authoritative movement metadata with each dice result", () => {
        const engine = game([0, 1 / 6]);
        ready(engine);
        const events: EngineEvent[] = [];
        engine.on((event) => events.push(event));

        expect(engine.handle("a", { type: "roll" })).toBe(true);
        expect(events.find((event) => event.type === "dice")).toEqual({
            type: "dice",
            playerId: "a",
            dice: [1, 2],
            fromPosition: 0,
            position: 3,
            moved: true,
            fromJail: false,
        });
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
        const engine = game([0, 1 / 3, 0, 0]);
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
        expect(engine.snapshot().currentPlayerId).toBe("a");
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

    it("grants an extra roll for doubles and sends a player to jail after three consecutive doubles", () => {
        const engine = game([0.34, 0.34, 0.34, 0.34, 0.34, 0.34]);
        ready(engine);

        expect(engine.handle("a", { type: "roll" })).toBe(true);
        expect(engine.handle("a", { type: "landing", decision: "buy" })).toBe(true);
        expect(engine.snapshot().currentPlayerId).toBe("a");

        expect(engine.handle("a", { type: "roll" })).toBe(true);
        expect(engine.handle("a", { type: "landing", decision: "buy" })).toBe(true);
        expect(engine.snapshot().currentPlayerId).toBe("a");

        expect(engine.handle("a", { type: "roll" })).toBe(true);
        expect(player(engine, "a").isInJail).toBe(true);
        expect(player(engine, "a").position).toBe(10);
        expect(engine.snapshot().currentPlayerId).toBe("b");
    });

    it("charges the fine and moves after the third failed jail roll", () => {
        const engine = game([0, 1 / 6]);
        ready(engine);
        const internal = engine as unknown as { players: Map<string, { isInJail: boolean; jailTurnsRemaining: number; position: number; balance: number }> };
        Object.assign(internal.players.get("a")!, { isInJail: true, jailTurnsRemaining: 1, position: 10 });

        expect(engine.handle("a", { type: "roll" })).toBe(true);
        expect(player(engine, "a").isInJail).toBe(false);
        expect(player(engine, "a").balance).toBe(1450);
        expect(player(engine, "a").position).toBe(13);
        expect(engine.snapshot().phase).toBe("awaiting-landing");
    });

    it("doubles base rent for an undeveloped complete color group", () => {
        const engine = game([0, 0]);
        ready(engine);
        const internal = engine as unknown as { players: Map<string, { position: number; properties: Array<{ posistion: number; count: 0; group: string; mortgaged: boolean }> }>; currentIndex: number };
        internal.players.get("a")!.properties = [
            { posistion: 1, count: 0, group: "Purple", mortgaged: false },
            { posistion: 3, count: 0, group: "Purple", mortgaged: false },
        ];
        internal.players.get("b")!.position = 39;
        internal.currentIndex = 1;

        expect(engine.handle("b", { type: "roll" })).toBe(true);
        expect(player(engine, "a").balance).toBe(1504);
        expect(player(engine, "b").balance).toBe(1696);
    });

    it("awards $200 when an Advance to Go card moves the player to Go", () => {
        const engine = game([0, 1 / 6, 0]);
        ready(engine);
        const internal = engine as unknown as { players: Map<string, { position: number }> };
        internal.players.get("a")!.position = 4;

        expect(engine.handle("a", { type: "roll" })).toBe(true);
        expect(player(engine, "a").position).toBe(0);
        expect(player(engine, "a").balance).toBe(1700);
    });

    it("charges twice the normal rent after advancing to the nearest Railroad", () => {
        const engine = game([0, 1 / 6, 0.27]);
        ready(engine);
        const internal = engine as unknown as { players: Map<string, { position: number; properties: Array<{ posistion: number; count: 0; group: string; mortgaged: false }> }> };
        internal.players.get("a")!.properties = [{ posistion: 15, count: 0, group: "Railroad", mortgaged: false }];
        internal.players.get("b")!.position = 4;
        (engine as unknown as { currentIndex: number }).currentIndex = 1;

        expect(engine.handle("b", { type: "roll" })).toBe(true);
        expect(player(engine, "a").balance).toBe(1550);
        expect(player(engine, "b").balance).toBe(1450);
    });

    it("rolls fresh host dice and charges ten times the roll for the nearest Utility card", () => {
        const engine = game([0, 1 / 6, 0.21, 0, 1 / 6]);
        ready(engine);
        const events: EngineEvent[] = [];
        engine.on((event) => events.push(event));
        const internal = engine as unknown as { players: Map<string, { position: number; properties: Array<{ posistion: number; count: 0; group: string; mortgaged: false }> }> };
        internal.players.get("a")!.properties = [{ posistion: 12, count: 0, group: "Utilities", mortgaged: false }];
        internal.players.get("b")!.position = 4;
        (engine as unknown as { currentIndex: number }).currentIndex = 1;

        expect(engine.handle("b", { type: "roll" })).toBe(true);
        expect(player(engine, "a").balance).toBe(1530);
        expect(player(engine, "b").balance).toBe(1470);
        const diceEvents = events.filter((event) => event.type === "dice");
        expect(diceEvents).toHaveLength(2);
        expect(diceEvents[0]).toMatchObject({ fromPosition: 4, moved: true });
        expect(diceEvents[1]).toMatchObject({ fromPosition: 12, position: 12, moved: false });
    });

    it("pays the printed $150 building-loan card amount", () => {
        const engine = game([0, 1 / 6, 0.99]);
        ready(engine);
        const internal = engine as unknown as { players: Map<string, { position: number }> };
        internal.players.get("a")!.position = 4;

        expect(engine.handle("a", { type: "roll" })).toBe(true);
        expect(player(engine, "a").balance).toBe(1650);
    });

    it("draws cards without replacement and persists deck state", () => {
        const engine = game([0, 0]);
        ready(engine);
        const cards: string[] = [];
        const decks: string[] = [];
        engine.on((event) => { if (event.type === "card") { cards.push(event.card.title); decks.push(event.deck); } });
        const internal = engine as unknown as { players: Map<string, unknown>; drawCard: (player: unknown, deck: "chance" | "communitychest", rollTotal: number) => void };

        internal.drawCard(internal.players.get("a")!, "chance", 7);
        internal.drawCard(internal.players.get("b")!, "chance", 7);

        expect(cards).toHaveLength(2);
        expect(cards[1]).not.toBe(cards[0]);
        expect(decks).toEqual(["chance", "chance"]);
        expect(engine.snapshot().cardDecks.chance.remaining).toHaveLength(13);
        internal.drawCard(internal.players.get("a")!, "communitychest", 7);
        expect(decks.at(-1)).toBe("communitychest");
        expect(GameEngine.fromSnapshot(engine.snapshot()).snapshot().cardDecks).toEqual(engine.snapshot().cardDecks);
    });

    it("ends Monopol mode when a player owns every Railroad and a complete street group", () => {
        const engine = game([0, 1 / 3]);
        engine.connect("a", "Alice");
        engine.connect("b", "Bob");
        engine.handle("a", { type: "select-mode", modeId: "monopol" });
        engine.handle("a", { type: "ready", ready: true });
        engine.handle("b", { type: "ready", ready: true });
        const internal = engine as unknown as { players: Map<string, { properties: Array<{ posistion: number; count: 0; group: string; mortgaged: false }> }> };
        internal.players.get("a")!.properties = [
            { posistion: 1, count: 0, group: "Purple", mortgaged: false },
            { posistion: 3, count: 0, group: "Purple", mortgaged: false },
            ...[5, 15, 25, 35].map((posistion) => ({ posistion, count: 0 as const, group: "Railroad", mortgaged: false as const })),
        ];

        expect(engine.handle("a", { type: "roll" })).toBe(true);
        expect(engine.snapshot().phase).toBe("finished");
        expect(engine.snapshot().winnerId).toBe("a");
    });

    it("lets the host authority expire a Run-Down turn and persists the turn revision", () => {
        const engine = game();
        engine.connect("a", "Alice");
        engine.connect("b", "Bob");
        engine.handle("a", { type: "select-mode", modeId: "run-down" });
        engine.handle("a", { type: "ready", ready: true });
        engine.handle("b", { type: "ready", ready: true });
        const before = engine.snapshot().turnRevision;

        expect(engine.expireTurn()).toBe(true);
        expect(engine.snapshot().currentPlayerId).toBe("b");
        expect(engine.snapshot().turnRevision).toBe(before + 1);
        expect(GameEngine.fromSnapshot(engine.snapshot()).snapshot().turnRevision).toBe(before + 1);
    });

    it("enforces finite building supply and returns houses when selling evenly", () => {
        const engine = game();
        ready(engine);
        const internal = engine as unknown as { players: Map<string, { properties: Array<{ posistion: number; count: 0 | 1; group: string; mortgaged: false }> }>; bankSupply: { houses: number; hotels: number } };
        internal.players.get("a")!.properties = [
            { posistion: 1, count: 0, group: "Purple", mortgaged: false },
            { posistion: 3, count: 0, group: "Purple", mortgaged: false },
        ];
        internal.bankSupply.houses = 0;
        expect(engine.handle("a", { type: "build", position: 1 })).toBe(false);
        internal.bankSupply.houses = 1;
        expect(engine.handle("a", { type: "build", position: 1 })).toBe(true);
        expect(engine.snapshot().bankSupply.houses).toBe(0);
        expect(player(engine, "a").balance).toBe(1450);
        expect(engine.handle("a", { type: "sell-building", position: 1 })).toBe(true);
        expect(engine.snapshot().bankSupply.houses).toBe(1);
        expect(player(engine, "a").balance).toBe(1475);
    });

    it("auctions a declined property with validated atomic bidding", () => {
        const engine = game([0, 1 / 6]);
        ready(engine);
        const internal = engine as unknown as { players: Map<string, { position: number }> };
        internal.players.get("a")!.position = 3;

        expect(engine.handle("a", { type: "roll" })).toBe(true);
        expect(engine.snapshot().pendingLanding?.position).toBe(6);
        expect(engine.handle("a", { type: "landing", decision: "skip" })).toBe(true);
        expect(engine.snapshot().phase).toBe("awaiting-auction");
        expect(engine.handle("b", { type: "auction-bid", amount: 2000 })).toBe(false);
        expect(engine.handle("b", { type: "auction-bid", amount: 100 })).toBe(true);
        expect(engine.handle("a", { type: "auction-pass" })).toBe(true);

        expect(player(engine, "b").balance).toBe(1400);
        expect(player(engine, "b").properties.map((property) => property.posistion)).toContain(6);
        expect(engine.snapshot().pendingAuction).toBeNull();
        expect(engine.snapshot().currentPlayerId).toBe("b");
    });

    it("liquidates assets and transfers the remaining estate on bankruptcy", () => {
        const engine = game([0, 1 / 6]);
        ready(engine);
        const internal = engine as unknown as { players: Map<string, { position: number; balance: number; properties: Array<{ posistion: number; count: 0 | "h"; group: string; mortgaged: boolean }> }> };
        Object.assign(internal.players.get("a")!, {
            position: 36,
            balance: 10,
            properties: [{ posistion: 5, count: 0, group: "Railroad", mortgaged: false }],
        });
        internal.players.get("b")!.properties = [{ posistion: 39, count: "h", group: "Blue", mortgaged: false }];

        expect(engine.handle("a", { type: "roll" })).toBe(true);
        expect(engine.snapshot().phase).toBe("finished");
        expect(engine.snapshot().winnerId).toBe("b");
        expect(engine.snapshot().players.map((candidate) => candidate.id)).toEqual(["b"]);
        expect(player(engine, "b").properties.map((property) => property.posistion)).toEqual(expect.arrayContaining([5, 39]));
        expect(player(engine, "b").properties.find((property) => property.posistion === 5)?.mortgaged).toBe(true);
    });
});
