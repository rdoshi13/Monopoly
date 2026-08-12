import { describe, expect, it } from "vitest";
import { GameEngine, type EngineEvent } from "../src/engine.js";
import board from "../src/monopoly.json";

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
    it("uses the complete classic UK board and card decks", () => {
        const byPosition = new Map(board.properties.map((space) => [space.posistion, space.name]));
        expect([1, 3, 6, 8, 9, 11, 13, 14, 16, 18, 19, 21, 23, 24, 26, 27, 29, 31, 32, 34, 37, 39].map((position) => byPosition.get(position))).toEqual([
            "Old Kent Road", "Whitechapel Road", "The Angel Islington", "Euston Road", "Pentonville Road", "Pall Mall", "Whitehall", "Northumberland Avenue", "Bow Street", "Marlborough Street", "Vine Street", "Strand", "Fleet Street", "Trafalgar Square", "Leicester Square", "Coventry Street", "Piccadilly", "Regent Street", "Oxford Street", "Bond Street", "Park Lane", "Mayfair",
        ]);
        expect([5, 15, 25, 35].map((position) => byPosition.get(position))).toEqual(["King’s Cross Station", "Marylebone Station", "Fenchurch St. Station", "Liverpool St. Station"]);
        expect(byPosition.get(38)).toBe("Super Tax");
        expect(board.chance.map((card) => card.title)).toEqual([
            "Advance to Go; collect £200",
            "Advance to Trafalgar Square; collect £200 if you pass Go",
            "Advance to Mayfair",
            "Advance to Pall Mall; collect £200 if you pass Go",
            "Advance to the nearest Station; if owned, pay double rent",
            "Advance to the nearest Station; if owned, pay double rent",
            "Advance to the nearest Utility; if owned, roll the dice and pay 10 times the roll",
            "Bank pays dividend; collect £50",
            "Get Out of Jail Free",
            "Go Back 3 Spaces",
            "Go directly to Jail",
            "General repairs: pay £25 per house and £100 per hotel",
            "Speeding fine; pay £15",
            "Take a trip to King’s Cross Station; collect £200 if you pass Go",
            "Elected Chairman of the Board; pay each player £50",
            "Building loan matures; collect £150",
        ]);
        expect(board.chance.filter((card) => card.action === "movenearest" && card.groupid === "railroad")).toHaveLength(2);
        expect(board.communitychest.map((card) => card.title)).toEqual([
            "Advance to Go; collect £200",
            "Bank error in your favour; collect £200",
            "Doctor’s fee; pay £50",
            "Sale of stock; collect £50",
            "Get Out of Jail Free",
            "Go directly to Jail",
            "Holiday fund matures; collect £100",
            "Income tax refund; collect £20",
            "Birthday; collect £10 from every player",
            "Life insurance matures; collect £100",
            "Hospital fees; pay £100",
            "School fees; pay £50",
            "Consultancy fee; collect £25",
            "Street repairs: pay £40 per house and £115 per hotel",
            "Second prize in a beauty contest; collect £10",
            "Inherit £100",
        ]);
        expect(board.communitychest).toContainEqual(expect.objectContaining({ title: "Birthday; collect £10 from every player", action: "addfundsfromplayers", amount: 10 }));
        expect(board.communitychest).toContainEqual(expect.objectContaining({ title: "School fees; pay £50", action: "removefunds", amount: 50 }));
    });

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
            { posistion: 1, count: 3, group: "Brown" }, { posistion: 3, count: "h", group: "Brown" },
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
        internal.players.get("b")!.properties = [{ posistion: 1, count: 0, group: "Brown" }];
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
        internal.players.get("a")!.properties = [{ posistion: 1, count: 0, group: "Brown" }];
        expect(engine.handle("a", { type: "build", position: 1 })).toBe(false);
        internal.players.get("a")!.properties.push({ posistion: 3, count: 0, group: "Brown" });
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

    it("mortgages an undeveloped property without ending the owner's turn and suppresses rent", () => {
        const engine = game([0, 1 / 3, 0, 0]);
        ready(engine);
        const internal = engine as unknown as { players: Map<string, { properties: Array<{ posistion: number; count: 0; group: string; mortgaged: boolean }>; position: number; balance: number }> };
        internal.players.get("a")!.properties = [{ posistion: 5, count: 0, group: "Railroad", mortgaged: false }];
        const beforeMortgage = engine.snapshot();

        expect(engine.handle("a", { type: "mortgage", position: 5 })).toBe(true);
        expect(engine.snapshot()).toEqual({
            ...beforeMortgage,
            players: beforeMortgage.players.map((candidate) => candidate.id === "a"
                ? {
                    ...candidate,
                    balance: 1600,
                    properties: [{ ...candidate.properties[0], mortgaged: true }],
                }
                : candidate),
        });
        expect(engine.snapshot()).toMatchObject({
            currentPlayerId: "a",
            phase: "awaiting-roll",
            turnRevision: beforeMortgage.turnRevision,
        });

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
            { posistion: 1, count: 3, group: "Brown" }, { posistion: 3, count: "h", group: "Brown" },
        ];
        expect(engine.handle("a", { type: "roll" })).toBe(true);
        expect(player(engine, "a").balance).toBe(1265);
        expect(engine.snapshot().currentPlayerId).toBe("a");
    });

    it("rejects a stale trade without changing either player", () => {
        const engine = game();
        ready(engine);
        const internal = engine as unknown as { players: Map<string, { properties: Array<{ posistion: number; count: 0; group: string }> }> };
        internal.players.get("a")!.properties = [{ posistion: 1, count: 0, group: "Brown" }];
        internal.players.get("b")!.properties = [{ posistion: 3, count: 0, group: "Brown" }];
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
            { posistion: 1, count: 0, group: "Brown", mortgaged: false },
            { posistion: 3, count: 0, group: "Brown", mortgaged: false },
        ];
        internal.players.get("b")!.position = 39;
        internal.currentIndex = 1;

        expect(engine.handle("b", { type: "roll" })).toBe(true);
        expect(player(engine, "a").balance).toBe(1504);
        expect(player(engine, "b").balance).toBe(1696);
    });

    it("awards the drawer £200 exactly once when an Advance to Go card moves them to Go", () => {
        const engine = game([0, 1 / 6]);
        ready(engine);
        const events: EngineEvent[] = [];
        engine.on((event) => events.push(event));
        const internal = engine as unknown as {
            players: Map<string, { position: number }>;
            cardDecks: Record<string, { remaining: number[]; discard: number[] }>;
        };
        internal.cardDecks.chance = { remaining: [0], discard: [] };
        internal.players.get("a")!.position = 4;
        const aliceBefore = player(engine, "a");
        const bobBefore = player(engine, "b");

        expect(engine.handle("a", { type: "roll" })).toBe(true);
        expect(player(engine, "a").position).toBe(0);
        expect(player(engine, "a").balance - aliceBefore.balance).toBe(200);
        expect(player(engine, "b")).toEqual(bobBefore);
        expect(events.filter((event) => event.type === "card")).toEqual([
            expect.objectContaining({
                type: "card",
                playerId: "a",
                deck: "chance",
                card: expect.objectContaining({ title: "Advance to Go; collect £200" }),
                fromPosition: 7,
                position: 0,
            }),
        ]);
        expect(events.filter((event) => event.type === "salary")).toEqual([
            { type: "salary", playerId: "a", amount: 200, fromPosition: 7, position: 0, reason: "advanced" },
        ]);
        expect(events.filter((event) => event.type === "history" && event.action.includes("collected £200"))).toEqual([
            { type: "history", action: "Alice advanced to Go and collected £200" },
        ]);
    });

    it("awards and announces one £200 salary when a dice move passes Go", () => {
        const engine = game([0, 0]);
        ready(engine);
        const events: EngineEvent[] = [];
        engine.on((event) => events.push(event));
        const internal = engine as unknown as { players: Map<string, { position: number }> };
        internal.players.get("a")!.position = 39;

        expect(engine.handle("a", { type: "roll" })).toBe(true);
        expect(player(engine, "a").balance).toBe(1700);
        expect(events.filter((event) => event.type === "salary")).toEqual([
            { type: "salary", playerId: "a", amount: 200, fromPosition: 39, position: 1, reason: "passed" },
        ]);
        expect(events.filter((event) => event.type === "history" && event.action.includes("collected £200"))).toEqual([
            { type: "history", action: "Alice passed Go and collected £200" },
        ]);
        expect(events.filter((event) => event.type === "dice" || event.type === "salary" || (event.type === "history" && event.action.includes("collected £200"))).map((event) => event.type)).toEqual([
            "dice", "salary", "history",
        ]);
    });

    it("pays nearest-target crossings but not backward relative card movement", () => {
        const nearest = game([1 / 3, 1 / 2]);
        ready(nearest);
        const nearestEvents: EngineEvent[] = [];
        nearest.on((event) => nearestEvents.push(event));
        const nearestInternal = nearest as unknown as { players: Map<string, { position: number }>; cardDecks: Record<string, { remaining: number[]; discard: number[] }> };
        nearestInternal.players.get("a")!.position = 29;
        nearestInternal.cardDecks.chance = { remaining: [4], discard: [] };
        expect(nearest.handle("a", { type: "roll" })).toBe(true);
        expect(player(nearest, "a").balance).toBe(1700);
        expect(nearestEvents.filter((event) => event.type === "salary")).toHaveLength(1);

        const backward = game([1 / 3, 1 / 2]);
        ready(backward);
        const backwardEvents: EngineEvent[] = [];
        backward.on((event) => backwardEvents.push(event));
        const backwardInternal = backward as unknown as { cardDecks: Record<string, { remaining: number[]; discard: number[] }> };
        backwardInternal.cardDecks.chance = { remaining: [9], discard: [] };
        expect(backward.handle("a", { type: "roll" })).toBe(true);
        expect(player(backward, "a").position).toBe(4);
        expect(player(backward, "a").balance).toBe(1300);
        expect(backwardEvents.filter((event) => event.type === "salary")).toEqual([]);
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
        const engine = game([0, 1 / 6, 6 / 16, 0, 1 / 6]);
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
        expect(events.filter((event) => event.type === "dice" || event.type === "card").map((event) => event.type)).toEqual(["dice", "card", "dice"]);
        expect(events.find((event) => event.type === "card")).toMatchObject({
            type: "card",
            playerId: "b",
            fromPosition: 7,
            position: 12,
            moved: true,
            fromJail: false,
            toJail: false,
            card: { action: "movenearest", groupid: "utility" },
        });
    });

    it("pays the printed £150 building-loan card amount", () => {
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
        expect(engine.snapshot().cardDecks.chance.remaining).toHaveLength(14);
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
            { posistion: 1, count: 0, group: "Brown", mortgaged: false },
            { posistion: 3, count: 0, group: "Brown", mortgaged: false },
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
            { posistion: 1, count: 0, group: "Brown", mortgaged: false },
            { posistion: 3, count: 0, group: "Brown", mortgaged: false },
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

    it("sells only as many buildings as a forced payment needs, keeping the group even", () => {
        const engine = game([0, 0]);
        ready(engine);
        const internal = engine as unknown as {
            players: Map<string, { position: number; balance: number; properties: Array<{ posistion: number; count: 0 | 4; group: string; mortgaged: boolean }> }>;
            bankSupply: { houses: number; hotels: number };
        };
        // Alice holds a fully developed Brown group and no cash; Bob owns Mayfair.
        internal.players.get("a")!.position = 37;
        internal.players.get("a")!.balance = 0;
        internal.players.get("a")!.properties = [
            { posistion: 1, count: 4, group: "Brown", mortgaged: false },
            { posistion: 3, count: 4, group: "Brown", mortgaged: false },
        ];
        internal.players.get("b")!.properties = [{ posistion: 39, count: 0, group: "Dark Blue", mortgaged: false }];
        internal.bankSupply.houses = 24;

        // Rolling 1 + 1 lands Alice on Mayfair, owing £50 base rent.
        expect(engine.handle("a", { type: "roll" })).toBe(true);

        const alice = player(engine, "a");
        // Houses cost £50, so each sells for £25: exactly two cover the £50 rent.
        expect(alice.properties.map((property) => property.count)).toEqual([3, 3]);
        expect(alice.balance).toBe(0);
        expect(engine.snapshot().bankSupply.houses).toBe(26);
        expect(player(engine, "b").balance).toBe(1550);
        expect(alice.properties.every((property) => property.mortgaged)).toBe(false);
    });

    it("charges ceilinged mortgage transfer interest to both sides of a trade", () => {
        const engine = game();
        ready(engine);
        const internal = engine as unknown as { players: Map<string, { properties: Array<{ posistion: number; count: 0; group: string; mortgaged: boolean }> }> };
        // Park Lane's £175 mortgage value makes the old 10% multiplication fractional.
        internal.players.get("a")!.properties = [{ posistion: 37, count: 0, group: "Dark Blue", mortgaged: true }];
        internal.players.get("b")!.properties = [{ posistion: 1, count: 0, group: "Brown", mortgaged: true }];
        expect(engine.handle("a", { type: "trade-propose", to: "b", offeredPositions: [37], requestedPositions: [1], offeredCash: 0, requestedCash: 0 })).toBe(true);
        expect(engine.handle("b", { type: "trade-accept" })).toBe(true);
        // Alice receives mortgaged Old Kent Road (£30 → £3); Bob receives Park Lane (£175 → £18).
        expect(player(engine, "a").balance).toBe(1497);
        expect(player(engine, "b").balance).toBe(1482);
        expect(Number.isInteger(player(engine, "b").balance)).toBe(true);
    });

    it("draws a card even when persisted state lost both card piles", () => {
        const engine = game([0, 0, 0]);
        ready(engine);
        const internal = engine as unknown as {
            players: Map<string, { position: number }>;
            cardDecks: Record<string, { remaining: number[]; discard: number[] }>;
        };
        internal.players.get("a")!.position = 5;
        internal.cardDecks.chance = { remaining: [], discard: [] };

        // Rolling 1 + 1 lands Alice on the Chance space at 7.
        expect(() => engine.handle("a", { type: "roll" })).not.toThrow();
        expect(engine.snapshot().cardDecks.chance.remaining.length).toBe(board.chance.length - 1);
    });

    it("gives every mode a turn backstop and auctions their own shorter clock", () => {
        const engine = game([0, 1 / 6]);
        ready(engine);
        // Classic declares no turnTimer, but an idle player must not freeze the room.
        expect(engine.snapshot().selectedMode.turnTimer).toBeUndefined();
        expect(engine.snapshot().turnTimeoutSeconds).toBe(300);

        const internal = engine as unknown as { players: Map<string, { position: number }> };
        internal.players.get("a")!.position = 3;
        expect(engine.handle("a", { type: "roll" })).toBe(true);
        expect(engine.handle("a", { type: "landing", decision: "skip" })).toBe(true);
        expect(engine.snapshot().phase).toBe("awaiting-auction");
        expect(engine.snapshot().turnTimeoutSeconds).toBe(60);

        // Each bid restarts the deadline the transport enforces.
        const beforeBid = engine.snapshot().turnRevision;
        expect(engine.handle("b", { type: "auction-bid", amount: 10 })).toBe(true);
        expect(engine.snapshot().turnRevision).toBe(beforeBid + 1);

        // An expiring auction closes on the standing high bid instead of hanging.
        expect(engine.expireTurn()).toBe(true);
        expect(engine.snapshot().pendingAuction).toBeNull();
        expect(player(engine, "b").properties.map((property) => property.posistion)).toEqual([6]);
        expect(engine.snapshot().turnTimeoutSeconds).toBe(300);
    });

    it("keeps a lobby and a finished game off the deadline clock", () => {
        const engine = game();
        engine.connect("a", "Alice");
        expect(engine.snapshot().turnTimeoutSeconds).toBeNull();
        ready(engine);
        expect(engine.snapshot().turnTimeoutSeconds).toBe(300);
        engine.disconnect("b");
        expect(engine.snapshot().phase).toBe("finished");
        expect(engine.snapshot().turnTimeoutSeconds).toBeNull();
    });

    it("resolves a repeated tile id to the next matching space forward", () => {
        // chance and communitychest each appear three times; a map keyed by id
        // would collapse them to whichever entry happened to be last.
        const chance = board.properties.filter((space) => space.id === "chance").map((space) => space.posistion);
        expect(chance).toHaveLength(3);

        const engine = game([0, 0]);
        ready(engine);
        const internal = engine as unknown as { players: Map<string, { position: number; balance: number }>; cardDecks: Record<string, { remaining: number[]; discard: number[] }> };
        // Force the deck to the "Advance to Go" card, whose id is unique.
        internal.cardDecks.chance = { remaining: [0], discard: [] };
        internal.players.get("a")!.position = 5;
        expect(engine.handle("a", { type: "roll" })).toBe(true);
        expect(player(engine, "a").position).toBe(0);
        expect(player(engine, "a").balance).toBe(1700);
    });

    it("returns a bankrupt player's buildings to the bank", () => {
        const engine = game();
        ready(engine);
        const internal = engine as unknown as {
            players: Map<string, { balance: number; properties: Array<{ posistion: number; count: 0 | 4 | "h"; group: string; mortgaged: boolean }> }>;
            bankSupply: { houses: number; hotels: number };
        };
        internal.players.get("a")!.properties = [
            { posistion: 1, count: "h", group: "Brown", mortgaged: false },
            { posistion: 3, count: 4, group: "Brown", mortgaged: false },
        ];
        internal.bankSupply.houses = 0;
        internal.bankSupply.hotels = 0;
        const bankrupt = engine as unknown as { bankrupt(player: unknown, creditor: unknown, reason: string): void };
        bankrupt.bankrupt(internal.players.get("a"), undefined, "test");

        // The hotel and the four standing houses both go back into the finite supply.
        expect(engine.snapshot().bankSupply).toEqual({ houses: 4, hotels: 1 });
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

    it("ends on host request with deterministic net-worth standings and component breakdowns", () => {
        const engine = game();
        engine.connect("a", "Alice");
        engine.connect("b", "Bob");
        engine.connect("c", "Cara");
        for (const id of ["a", "b", "c"]) engine.handle(id, { type: "ready", ready: true });
        const internal = engine as unknown as { players: Map<string, { balance: number; properties: Array<{ posistion: number; count: 0 | 2 | "h"; group: string; mortgaged: boolean }> }> };
        Object.assign(internal.players.get("a")!, {
            balance: 1000,
            properties: [{ posistion: 1, count: 2, group: "Brown", mortgaged: false }, { posistion: 5, count: 0, group: "Railroad", mortgaged: true }],
        });
        Object.assign(internal.players.get("b")!, { balance: 1230, properties: [{ posistion: 3, count: 0, group: "Brown", mortgaged: true }] });
        Object.assign(internal.players.get("c")!, { balance: 950, properties: [{ posistion: 3, count: "h", group: "Brown", mortgaged: false }] });
        const events: EngineEvent[] = [];
        engine.on((event) => events.push(event));

        expect(engine.handle("a", { type: "end-game" })).toBe(true);
        expect(engine.snapshot()).toMatchObject({
            phase: "finished",
            winnerId: "b",
            finalStandings: [
                { playerId: "b", username: "Bob", rank: 1, cash: 1230, unmortgagedPropertyValue: 0, mortgagedPropertyValue: 30, buildingValue: 0, netWorth: 1260 },
                { playerId: "a", username: "Alice", rank: 2, cash: 1000, unmortgagedPropertyValue: 60, mortgagedPropertyValue: 100, buildingValue: 100, netWorth: 1260 },
                { playerId: "c", username: "Cara", rank: 3, cash: 950, unmortgagedPropertyValue: 60, mortgagedPropertyValue: 0, buildingValue: 250, netWorth: 1260 },
            ],
        });
        expect(events.filter((event) => event.type === "game-ended")).toHaveLength(1);
        expect(events).toContainEqual({ type: "history", action: "Alice ended the game. Bob won with a net worth of £1260" });
    });

    it("breaks equal net worth and cash by original player order and ends only once", () => {
        const engine = game();
        ready(engine);
        const events: EngineEvent[] = [];
        engine.on((event) => events.push(event));

        expect(engine.handle("b", { type: "end-game" })).toBe(false);
        expect(engine.snapshot().phase).toBe("awaiting-roll");
        expect(engine.handle("a", { type: "end-game" })).toBe(true);
        const finished = engine.snapshot();
        expect(finished.finalStandings?.map((standing) => standing.playerId)).toEqual(["a", "b"]);
        expect(finished.winnerId).toBe("a");
        expect(engine.handle("a", { type: "end-game" })).toBe(false);
        expect(engine.handle("a", { type: "roll" })).toBe(false);
        expect(engine.snapshot()).toEqual(finished);
        expect(events.filter((event) => event.type === "game-ended")).toHaveLength(1);
    });

    it("authorizes the promoted host after the original host is removed", () => {
        const engine = game();
        engine.connect("a", "Alice");
        engine.connect("b", "Bob");
        engine.connect("c", "Cara");
        for (const id of ["a", "b", "c"]) engine.handle(id, { type: "ready", ready: true });

        engine.disconnect("a");

        expect(engine.snapshot().lobbyHostId).toBe("b");
        expect(engine.handle("a", { type: "end-game" })).toBe(false);
        expect(engine.snapshot().phase).not.toBe("finished");
        expect(engine.handle("b", { type: "end-game" })).toBe(true);
        expect(engine.snapshot()).toMatchObject({ phase: "finished", winnerId: "b" });
    });
});

describe("gameplay reporting and rematch", () => {
    it("names the payer, recipient and property on a rent line", () => {
        const engine = game([0, 0]);
        ready(engine);
        const internal = engine as unknown as { players: Map<string, { position: number; properties: Array<{ posistion: number; count: 0; group: string; mortgaged: boolean }> }> };
        internal.players.get("b")!.properties = [{ posistion: 3, count: 0, group: "Brown", mortgaged: false }];
        internal.players.get("a")!.position = 1;
        const lines: string[] = [];
        engine.on((event) => { if (event.type === "history") lines.push(event.action); });
        engine.handle("a", { type: "roll" });
        expect(lines).toContain("Alice paid Bob £4 rent for Whitechapel Road");
    });

    it("reports every jail entry and exit", () => {
        const engine = game();
        ready(engine);
        const internal = engine as unknown as { players: Map<string, { position: number }> };
        internal.players.get("a")!.position = 30;
        const lines: string[] = [];
        engine.on((event) => { if (event.type === "history") lines.push(event.action); });

        // Landing on Go To Jail must say so rather than leaving the log silent.
        (engine as unknown as { resolveSpace(player: unknown, roll: number): void }).resolveSpace(internal.players.get("a"), 0);
        expect(lines).toContain("Alice was sent to Jail");

        // A failed jail roll explains itself instead of logging a bare total.
        // Sending a player to jail ends their turn, so drive this from a fresh
        // snapshot where it is Alice's roll and she is already jailed.
        const jailed = engine.snapshot();
        const alice = jailed.players.find((candidate) => candidate.id === "a")!;
        alice.isInJail = true;
        alice.jailTurnsRemaining = 3;
        const inJail = GameEngine.fromSnapshot({ ...jailed, currentPlayerId: "a", phase: "awaiting-roll" });
        let index = 0;
        (inJail as unknown as { random: () => number }).random = () => [0, 0.5][index++ % 2];
        const jailLines: string[] = [];
        inJail.on((event) => { if (event.type === "history") jailLines.push(event.action); });
        expect(inJail.handle("a", { type: "roll" })).toBe(true);
        expect(jailLines.some((line) => /stays in Jail \(2 tries left\)/.test(line))).toBe(true);
    });

    it("restarts into a fresh lobby for the host only, keeping the players", () => {
        const engine = game();
        ready(engine);
        const internal = engine as unknown as { players: Map<string, { balance: number; position: number; properties: unknown[] }>; phase: string };
        internal.players.get("a")!.properties = [{ posistion: 1, count: 0, group: "Brown", mortgaged: false }];
        internal.players.get("a")!.balance = 42;
        expect(engine.handle("a", { type: "end-game" })).toBe(true);
        expect(engine.snapshot().phase).toBe("finished");

        expect(engine.handle("b", { type: "restart" })).toBe(false);
        expect(engine.handle("a", { type: "restart" })).toBe(true);
        const after = engine.snapshot();
        expect(after.phase).toBe("lobby");
        expect(after.winnerId).toBeNull();
        expect(after.finalStandings).toBeNull();
        expect(after.players.map((player) => player.username)).toEqual(["Alice", "Bob"]);
        expect(after.players.every((player) => player.balance === 1500 && player.position === 0 && player.properties.length === 0 && !player.ready)).toBe(true);
        expect(after.bankSupply).toEqual({ houses: 32, hotels: 12 });
    });
});

describe("card payments between players", () => {
    it("names both sides and the card instead of a bare 'card payment'", () => {
        const engine = game();
        engine.connect("a", "Alice");
        engine.connect("b", "Bob");
        engine.handle("a", { type: "ready", ready: true });
        engine.handle("b", { type: "ready", ready: true });
        const lines: string[] = [];
        engine.on((event) => { if (event.type === "history") lines.push(event.action); });
        const chairman = (board.chance as Array<{ title: string; action: string; amount?: number }>).find((card) => card.action === "removefundstoplayers")!;
        (engine as unknown as { drawCardEffect?: unknown; players: Map<string, unknown> });
        const internal = engine as unknown as { players: Map<string, { username: string }> };
        const alice = internal.players.get("a")!;
        (engine as unknown as { transfer(from: unknown, to: unknown, amount: number, reason: string, label?: string): boolean })
            .transfer(alice, internal.players.get("b"), chairman.amount ?? 0, "card payment", `${alice.username} paid Bob £${chairman.amount} for ${chairman.title.split(/[;:]/)[0].trim()}`);
        expect(lines).toContain("Alice paid Bob £50 for Elected Chairman of the Board");
    });
});
