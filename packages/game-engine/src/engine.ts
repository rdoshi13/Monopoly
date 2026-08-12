import board from "./monopoly.json";
import type { MonopolyMode, PlayerProperty } from "@monopoly/shared-types";

const MonopolyModes: MonopolyMode[] = [
    { AllowDeals: true, WinningMode: "last-standing", Name: "Classic", startingCash: 1500, mortageAllowed: true, turnTimer: undefined },
    { AllowDeals: false, WinningMode: "monopols & trains", Name: "Monopol", startingCash: 1500, mortageAllowed: false, turnTimer: undefined },
    { AllowDeals: false, WinningMode: "last-standing", Name: "Run-Down", startingCash: 1500, mortageAllowed: false, turnTimer: 30 },
];

/**
 * Backstop deadlines. A mode's own `turnTimer` still wins when it is shorter.
 * Without these, one idle-but-connected player freezes a room indefinitely:
 * disconnect-based removal never fires because the socket is still open.
 */
const IDLE_TURN_SECONDS = 300;
const AUCTION_SECONDS = 60;
const SETTLEMENT_SECONDS = 120;

export type GamePhase = "lobby" | "awaiting-roll" | "awaiting-landing" | "awaiting-auction" | "awaiting-settlement" | "finished";
export type ModeId = "classic" | "monopol" | "run-down";
export interface FinalStanding {
    playerId: string;
    username: string;
    rank: number;
    cash: number;
    unmortgagedPropertyValue: number;
    mortgagedPropertyValue: number;
    buildingValue: number;
    netWorth: number;
}
export type EngineEvent =
    | { type: "state"; state: GameSnapshot }
    | { type: "dice"; playerId: string; dice: [number, number]; fromPosition: number; position: number; moved: boolean; fromJail: boolean }
    | { type: "card"; playerId: string; deck: CardDeckName; card: Card; fromPosition: number; position: number; moved: boolean; fromJail: boolean; toJail: boolean }
    | { type: "salary"; playerId: string; amount: 200; fromPosition: number; position: number; reason: "passed" | "advanced" }
    | { type: "game-ended"; winnerId: string; standings: FinalStanding[] }
    | { type: "history"; action: string }
    | { type: "rejected"; playerId: string; reason: string };

export interface Card {
    title: string;
    action: string;
    tileid?: string;
    groupid?: string;
    rentmultiplier?: number;
    amount?: number;
    subaction?: string;
    count?: number;
    buildings?: number;
    hotels?: number;
}

export interface EnginePlayer {
    id: string;
    username: string;
    icon: number;
    position: number;
    balance: number;
    properties: PlayerProperty[];
    isInJail: boolean;
    jailTurnsRemaining: number;
    getoutCards: number;
    ready: boolean;
}

export interface TradeOffer {
    from: string;
    to: string;
    offeredPositions: number[];
    requestedPositions: number[];
    offeredCash: number;
    requestedCash: number;
    /** Get Out of Jail Free cards may be sold to another player at any agreed price. */
    offeredJailCards: number;
    requestedJailCards: number;
}

/**
 * A debt the player cannot cover from cash. Play pauses on the debtor so they can
 * choose how to raise it — selling buildings, mortgaging, or trading — rather than
 * the engine liquidating their board for them.
 */
export interface PendingDebt {
    playerId: string;
    /** Total still owed; for a split debt this is the sum of every share. */
    amount: number;
    /** null means the debt is owed to the bank. */
    creditorId: string | null;
    /** Set when one obligation is owed to several players at once. */
    shares?: Array<{ creditorId: string; amount: number }>;
    reason: string;
    label?: string;
}

export interface AuctionState {
    position: number;
    bids: Record<string, number>;
    highestBidderId: string | null;
    highestBid: number;
    passedPlayerIds: string[];
}

export type CardDeckName = "chance" | "communitychest";
interface CardDeckState { remaining: number[]; discard: number[]; }

export interface GameSnapshot {
    phase: GamePhase;
    gameStarted: boolean;
    currentPlayerId: string | null;
    lobbyHostId: string | null;
    modeId: ModeId;
    selectedMode: MonopolyMode;
    players: EnginePlayer[];
    pendingLanding: { playerId: string; position: number } | null;
    pendingTrade: TradeOffer | null;
    pendingAuction: AuctionState | null;
    pendingDebt: PendingDebt | null;
    winnerId: string | null;
    finalStandings: FinalStanding[] | null;
    pausedPlayerId: string | null;
    consecutiveDoubles: number;
    extraRollPending: boolean;
    cardDecks: Record<CardDeckName, CardDeckState>;
    heldJailCards: Record<string, CardDeckName[]>;
    turnRevision: number;
    bankSupply: { houses: number; hotels: number };
    /** Seconds the current phase may last before `expireTurn` should be called. */
    turnTimeoutSeconds: number | null;
}

export type GameAction =
    | { type: "ready"; ready: boolean }
    | { type: "select-mode"; modeId: ModeId }
    | { type: "roll" }
    | { type: "landing"; decision: "buy" | "skip" }
    | { type: "unjail"; option: "pay" | "card" }
    | { type: "build"; position: number }
    | { type: "sell-building"; position: number }
    | { type: "mortgage"; position: number }
    | { type: "unmortgage"; position: number }
    | { type: "trade-propose"; to: string; offeredPositions: number[]; requestedPositions: number[]; offeredCash: number; requestedCash: number; offeredJailCards: number; requestedJailCards: number }
    | { type: "trade-accept" }
    | { type: "trade-reject" }
    | { type: "trade-cancel" }
    | { type: "auction-bid"; amount: number }
    | { type: "auction-pass" }
    | { type: "declare-bankruptcy" }
    | { type: "end-game" }
    | { type: "restart" };

const modes: Record<ModeId, MonopolyMode> = {
    classic: MonopolyModes[0],
    monopol: MonopolyModes[1],
    "run-down": MonopolyModes[2],
};

const properties = board.properties as Array<Record<string, unknown>>;
const propertyByPosition = new Map(properties.map((property) => [Number(property.posistion), property]));

/** Ids are not unique: `chance` and `communitychest` each appear three times. */
const positionsById = properties.reduce((map, property) => {
    const id = String(property.id);
    return map.set(id, [...(map.get(id) ?? []), Number(property.posistion)].sort((first, second) => first - second));
}, new Map<string, number[]>());

/**
 * Resolves a card's target space. For the repeated ids this picks the next
 * matching space forward, which is what "advance to" means to a player; a map
 * keyed by id would silently keep whichever entry happened to be last.
 */
function destinationById(from: number, tileId: string | undefined): number | null {
    const positions = positionsById.get(tileId ?? "");
    if (!positions?.length) return null;
    return positions.find((candidate) => candidate > from) ?? positions[0];
}

export interface BoardSpace {
    id: string;
    name: string;
    posistion: number;
    group: string;
    price?: number;
    rent?: number;
    multpliedrent?: number[];
    housecost?: number;
}

export const boardSpaces: BoardSpace[] = properties
    .map((property) => ({
        id: String(property.id),
        name: String(property.name),
        posistion: Number(property.posistion),
        group: String(property.group),
        ...(Number.isFinite(Number(property.price)) ? { price: Number(property.price) } : {}),
        ...(Number.isFinite(Number(property.rent)) ? { rent: Number(property.rent) } : {}),
        ...(Array.isArray(property.multpliedrent) ? { multpliedrent: property.multpliedrent.map(Number) } : {}),
        ...(Number.isFinite(Number(property.housecost)) ? { housecost: Number(property.housecost) } : {}),
    }))
    .sort((a, b) => a.posistion - b.posistion);

function freshCardDecks(): Record<CardDeckName, CardDeckState> {
    return {
        chance: { remaining: (board.chance as Card[]).map((_, index) => index), discard: [] },
        communitychest: { remaining: (board.communitychest as Card[]).map((_, index) => index), discard: [] },
    };
}

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

/** A hotel counts as the fifth level above four houses. */
function buildingLevel(property: PlayerProperty): number {
    return property.count === "h" ? 5 : property.count;
}

/**
 * Card titles carry their own instruction ("Hospital fees; pay £100"), so using
 * one verbatim as a payment reason reads "paid £100 for Hospital fees; pay £100".
 * Keep the clause before the instruction.
 */
function cardReason(card: Card): string {
    return card.title.split(/[;:]/)[0].trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPosition(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 40;
}

function isMoney(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isInteger(value);
}

/** At most one card exists per deck, so a sane offer never exceeds two. */
function isCardCount(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2;
}

function parsePositions(value: unknown): number[] | null {
    if (!Array.isArray(value) || !value.every(isPosition) || new Set(value).size !== value.length) return null;
    return value;
}

/** Runtime validation at the network boundary; no caller supplied state enters the engine. */
export function parseAction(value: unknown): GameAction | null {
    if (!isObject(value) || typeof value.type !== "string") return null;
    switch (value.type) {
        case "ready":
            return typeof value.ready === "boolean" ? { type: "ready", ready: value.ready } : null;
        case "select-mode":
            return value.modeId === "classic" || value.modeId === "monopol" || value.modeId === "run-down"
                ? { type: "select-mode", modeId: value.modeId }
                : null;
        case "roll":
        case "declare-bankruptcy":
        case "end-game":
        case "restart":
        case "trade-accept":
        case "trade-reject":
        case "trade-cancel":
        case "auction-pass":
            return { type: value.type };
        case "landing":
            return value.decision === "buy" || value.decision === "skip" ? { type: "landing", decision: value.decision } : null;
        case "unjail":
            return value.option === "pay" || value.option === "card" ? { type: "unjail", option: value.option } : null;
        case "build":
        case "sell-building":
        case "mortgage":
        case "unmortgage":
            return isPosition(value.position) ? { type: value.type, position: value.position } : null;
        case "trade-propose": {
            const offeredPositions = parsePositions(value.offeredPositions);
            const requestedPositions = parsePositions(value.requestedPositions);
            // Jail-card fields are optional so a client that predates them still trades.
            const offeredJailCards = value.offeredJailCards ?? 0;
            const requestedJailCards = value.requestedJailCards ?? 0;
            return typeof value.to === "string" && value.to.length > 0 && offeredPositions !== null && requestedPositions !== null &&
                isMoney(value.offeredCash) && isMoney(value.requestedCash) && isCardCount(offeredJailCards) && isCardCount(requestedJailCards)
                ? { type: "trade-propose", to: value.to, offeredPositions, requestedPositions, offeredCash: value.offeredCash, requestedCash: value.requestedCash, offeredJailCards, requestedJailCards }
                : null;
        }
        case "auction-bid":
            return isMoney(value.amount) ? { type: "auction-bid", amount: value.amount } : null;
        default:
            return null;
    }
}

export class GameEngine {
    private players = new Map<string, EnginePlayer>();
    private order: string[] = [];
    private currentIndex = 0;
    private phase: GamePhase = "lobby";
    private modeId: ModeId = "classic";
    private lobbyHostId: string | null = null;
    private pendingLanding: { playerId: string; position: number } | null = null;
    private pendingTrade: TradeOffer | null = null;
    private pendingAuction: AuctionState | null = null;
    private pendingDebt: PendingDebt | null = null;
    private winnerId: string | null = null;
    private finalStandings: FinalStanding[] | null = null;
    private pausedPlayerId: string | null = null;
    private consecutiveDoubles = 0;
    private extraRollPending = false;
    private cardDecks = freshCardDecks();
    private heldJailCards: Record<string, CardDeckName[]> = {};
    /** Bumped whenever the active deadline should restart: a new turn, or auction activity. */
    private turnRevision = 0;
    private bankSupply = { houses: 32, hotels: 12 };
    private currentPlayerRemoved = false;
    private listeners = new Set<(event: EngineEvent) => void>();

    public constructor(private readonly maxPlayers: number, private readonly random: () => number = Math.random) {}

    /** Rehydrates persisted authority state after a Durable Object wake-up. */
    public static fromSnapshot(snapshot: GameSnapshot, maxPlayers = 6): GameEngine {
        const engine = new GameEngine(maxPlayers);
        engine.players = new Map(snapshot.players.map((player) => [player.id, clone(player)]));
        engine.order = snapshot.players.map((player) => player.id);
        engine.currentIndex = Math.max(0, engine.order.indexOf(snapshot.currentPlayerId ?? ""));
        engine.phase = snapshot.phase;
        engine.modeId = snapshot.modeId;
        engine.lobbyHostId = snapshot.lobbyHostId;
        engine.pendingLanding = clone(snapshot.pendingLanding);
        engine.pendingTrade = clone(snapshot.pendingTrade);
        engine.pendingAuction = clone(snapshot.pendingAuction ?? null);
        engine.pendingDebt = clone(snapshot.pendingDebt ?? null);
        engine.winnerId = snapshot.winnerId;
        engine.finalStandings = clone(snapshot.finalStandings ?? null);
        engine.pausedPlayerId = snapshot.pausedPlayerId ?? null;
        engine.consecutiveDoubles = snapshot.consecutiveDoubles ?? 0;
        engine.extraRollPending = snapshot.extraRollPending ?? false;
        engine.cardDecks = clone(snapshot.cardDecks ?? freshCardDecks());
        engine.heldJailCards = clone(snapshot.heldJailCards ?? {});
        engine.turnRevision = snapshot.turnRevision ?? 0;
        engine.bankSupply = clone(snapshot.bankSupply ?? { houses: 32, hotels: 12 });
        return engine;
    }

    public on(listener: (event: EngineEvent) => void) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    public connect(id: string, username: string): boolean {
        const safeName = username.trim().slice(0, 40);
        if (!safeName || this.phase !== "lobby" || this.players.size >= this.maxPlayers || this.players.has(id)) return false;
        const player: EnginePlayer = {
            id, username: safeName, icon: this.players.size, position: 0, balance: modes[this.modeId].startingCash,
            properties: [], isInJail: false, jailTurnsRemaining: 0, getoutCards: 0, ready: false,
        };
        this.players.set(id, player);
        this.order.push(id);
        this.lobbyHostId ??= id;
        this.history(`${safeName} joined the game`);
        this.publish();
        return true;
    }

    public disconnect(id: string) {
        const removedIndex = this.order.indexOf(id);
        if (removedIndex < 0) return;
        const wasCurrent = this.currentPlayerId === id;
        if (this.pausedPlayerId === id) this.pausedPlayerId = null;
        for (const deck of this.heldJailCards[id] ?? []) this.returnJailCard(deck);
        delete this.heldJailCards[id];
        this.players.delete(id);
        this.order.splice(removedIndex, 1);
        if (this.pendingTrade && (this.pendingTrade.from === id || this.pendingTrade.to === id)) this.pendingTrade = null;
        if (this.pendingDebt?.playerId === id) {
            this.pendingDebt = null;
            if (this.phase === "awaiting-settlement") this.phase = "awaiting-roll";
        }
        if (this.pendingAuction) {
            delete this.pendingAuction.bids[id];
            this.pendingAuction.passedPlayerIds = this.pendingAuction.passedPlayerIds.filter((playerId) => playerId !== id);
            this.recalculateAuctionLeader();
        }
        if (this.lobbyHostId === id) this.lobbyHostId = this.order[0] ?? null;
        if (this.order.length === 0) {
            this.currentIndex = 0;
            this.phase = "lobby";
            this.pendingLanding = null;
            this.pendingAuction = null;
        } else if (wasCurrent) {
            this.currentIndex = removedIndex % this.order.length;
            this.pendingLanding = null;
            this.pendingAuction = null;
            this.consecutiveDoubles = 0;
            this.extraRollPending = false;
            if (this.phase !== "lobby") this.phase = "awaiting-roll";
            if (this.phase !== "lobby") this.turnRevision += 1;
        } else if (removedIndex < this.currentIndex) {
            this.currentIndex -= 1;
        }
        this.resolveWinner();
        if (this.pendingAuction) this.settleAuctionIfComplete();
        this.publish();
    }

    public handle(actorId: string, rawAction: unknown): boolean {
        const action = parseAction(rawAction);
        if (!action) return this.reject(actorId, "Invalid action payload");
        const actor = this.players.get(actorId);
        if (!actor) return this.reject(actorId, "Unknown player");
        if (action.type === "declare-bankruptcy") return this.declareBankruptcy(actor);
        if (action.type === "end-game") return this.endGame(actor);
        if (action.type === "restart") return this.restart(actor);
        if (this.pausedPlayerId) return this.reject(actorId, "Game is paused while a player reconnects");
        switch (action.type) {
            case "ready": return this.setReady(actor, action.ready);
            case "select-mode": return this.selectMode(actor, action.modeId);
            case "roll": return this.roll(actor);
            case "landing": return this.resolveLandingChoice(actor, action.decision);
            case "unjail": return this.unjail(actor, action.option);
            case "build": return this.build(actor, action.position);
            case "sell-building": return this.sellBuilding(actor, action.position);
            case "mortgage": return this.mortgage(actor, action.position, true);
            case "unmortgage": return this.mortgage(actor, action.position, false);
            case "trade-propose": return this.proposeTrade(actor, action);
            case "trade-accept": return this.acceptTrade(actor);
            case "trade-reject":
            case "trade-cancel": return this.clearTrade(actor);
            case "auction-bid": return this.auctionBid(actor, action.amount);
            case "auction-pass": return this.auctionPass(actor);
        }
    }

    public snapshot(): GameSnapshot {
        return clone({
            phase: this.phase, gameStarted: this.phase !== "lobby", currentPlayerId: this.currentPlayerId,
            lobbyHostId: this.lobbyHostId, modeId: this.modeId, selectedMode: modes[this.modeId],
            players: this.order.map((id) => this.players.get(id)).filter((player): player is EnginePlayer => Boolean(player)),
            pendingLanding: this.pendingLanding, pendingTrade: this.pendingTrade, pendingAuction: this.pendingAuction, pendingDebt: this.pendingDebt, winnerId: this.winnerId, pausedPlayerId: this.pausedPlayerId,
            finalStandings: this.finalStandings,
            consecutiveDoubles: this.consecutiveDoubles, extraRollPending: this.extraRollPending,
            cardDecks: this.cardDecks, heldJailCards: this.heldJailCards,
            turnRevision: this.turnRevision,
            bankSupply: this.bankSupply,
            turnTimeoutSeconds: this.turnTimeoutSeconds,
        });
    }

    /**
     * The deadline the transport should enforce for the current phase. Auctions
     * get their own short clock because they block every player, not just the
     * one whose turn it is.
     */
    private get turnTimeoutSeconds(): number | null {
        if (this.phase === "lobby" || this.phase === "finished") return null;
        const modeTimer = this.mode.turnTimer;
        if (this.phase === "awaiting-settlement") return SETTLEMENT_SECONDS;
        if (this.phase === "awaiting-auction") return Math.min(AUCTION_SECONDS, modeTimer ?? AUCTION_SECONDS);
        return Math.min(IDLE_TURN_SECONDS, modeTimer ?? IDLE_TURN_SECONDS);
    }

    public pauseForReconnect(playerId: string): void {
        if (this.currentPlayerId === playerId && this.phase !== "lobby" && this.phase !== "finished") { this.pausedPlayerId = playerId; this.publish(); }
    }

    public resumePlayer(playerId: string): void {
        if (this.pausedPlayerId === playerId) { this.pausedPlayerId = null; this.publish(); }
    }

    public expireTurn(): boolean {
        if (this.pausedPlayerId || (this.phase !== "awaiting-roll" && this.phase !== "awaiting-landing" && this.phase !== "awaiting-auction" && this.phase !== "awaiting-settlement")) return false;
        if (this.phase === "awaiting-settlement") {
            this.forceSettlement();
            return true;
        }
        const player = this.currentPlayerId ? this.players.get(this.currentPlayerId) : undefined;
        if (!player) return false;
        if (this.phase === "awaiting-auction") {
            this.finalizeAuction();
            return true;
        }
        if (this.pendingTrade && (this.pendingTrade.from === player.id || this.pendingTrade.to === player.id)) this.pendingTrade = null;
        this.extraRollPending = false;
        this.consecutiveDoubles = 0;
        this.history(`${player.username}'s turn expired`);
        this.endTurn();
        return true;
    }

    private get currentPlayerId(): string | null { return this.order[this.currentIndex] ?? null; }
    private get mode(): MonopolyMode { return modes[this.modeId]; }
    private emit(event: EngineEvent) { this.listeners.forEach((listener) => listener(event)); }
    private publish() { this.emit({ type: "state", state: this.snapshot() }); }
    private history(action: string) { this.emit({ type: "history", action }); }
    private reject(playerId: string, reason: string) { this.emit({ type: "rejected", playerId, reason }); return false; }
    private isTurn(player: EnginePlayer) { return this.phase !== "lobby" && this.currentPlayerId === player.id; }

    private setReady(player: EnginePlayer, ready: boolean) {
        if (this.phase !== "lobby") return this.reject(player.id, "The game has already started");
        player.ready = ready;
        if (this.players.size >= 2 && [...this.players.values()].every((candidate) => candidate.ready)) {
            this.phase = "awaiting-roll";
            this.currentIndex = 0;
            this.turnRevision += 1;
            this.history("Game started");
        }
        this.publish();
        return true;
    }

    private selectMode(player: EnginePlayer, modeId: ModeId) {
        if (this.phase !== "lobby" || player.id !== this.lobbyHostId) return this.reject(player.id, "Only the lobby host can select a mode");
        this.modeId = modeId;
        for (const candidate of this.players.values()) candidate.balance = modes[modeId].startingCash;
        this.publish();
        return true;
    }

    private roll(player: EnginePlayer) {
        if (!this.isTurn(player) || this.phase !== "awaiting-roll") return this.reject(player.id, "It is not your roll phase");
        const dice: [number, number] = [Math.floor(this.random() * 6) + 1, Math.floor(this.random() * 6) + 1];
        const doubles = dice[0] === dice[1];
        const fromPosition = player.position;
        const fromJail = player.isInJail;
        const emitDice = (moved: boolean) => this.emit({ type: "dice", playerId: player.id, dice, fromPosition, position: player.position, moved, fromJail });
        if (player.isInJail) {
            this.consecutiveDoubles = 0;
            this.extraRollPending = false;
            if (doubles) {
                player.isInJail = false;
                player.jailTurnsRemaining = 0;
                this.history(`${player.username} rolled a double and left Jail`);
            } else {
                player.jailTurnsRemaining -= 1;
                if (player.jailTurnsRemaining > 0) {
                    this.history(`${player.username} did not roll a double and stays in Jail (${player.jailTurnsRemaining} ${player.jailTurnsRemaining === 1 ? "try" : "tries"} left)`);
                    emitDice(false);
                    this.endTurn();
                    return true;
                }
                if (!this.chargeBank(player, 50, "jail fine")) {
                    emitDice(false);
                    this.endTurn();
                    return true;
                }
                player.isInJail = false;
                player.jailTurnsRemaining = 0;
                this.history(`${player.username} paid the fine and left Jail`);
            }
        } else {
            this.consecutiveDoubles = doubles ? this.consecutiveDoubles + 1 : 0;
            if (this.consecutiveDoubles >= 3) {
                emitDice(false);
                this.sendToJail(player);
                this.endTurn();
                return true;
            }
            this.extraRollPending = doubles;
        }
        const previous = player.position;
        player.position = (player.position + dice[0] + dice[1]) % 40;
        const passedGo = player.position < previous;
        emitDice(true);
        if (passedGo) this.awardGoSalary(player, previous, player.position, "passed");
        this.resolveSpace(player, dice[0] + dice[1]);
        this.publish();
        return true;
    }

    private resolveSpace(player: EnginePlayer, rollTotal: number, rentMultiplier = 1, utilityCardRent = false): void {
        const space = propertyByPosition.get(player.position);
        if (!space) return this.endTurn();
        const id = String(space.id);
        if (id === "gotojail") { this.sendToJail(player); return this.endTurn(); }
        if (id === "incometax" || id === "supertax") { this.chargeBank(player, id === "incometax" ? 200 : 100, id === "incometax" ? "income tax" : "super tax"); return this.endTurn(); }
        if (id === "chance" || id === "communitychest") return this.drawCard(player, id, rollTotal);
        if (String(space.group) === "Special") return this.endTurn();
        const owner = this.ownerOf(player.position);
        if (!owner) { this.pendingLanding = { playerId: player.id, position: player.position }; this.phase = "awaiting-landing"; return; }
        if (owner.id !== player.id) {
            const rent = utilityCardRent ? rollTotal * rentMultiplier : this.rentFor(owner, player.position, rollTotal) * rentMultiplier;
            this.transfer(player, owner, rent, `rent for ${String(space.name)}`, `${player.username} paid ${owner.username} £${rent} rent for ${String(space.name)}`);
        }
        this.endTurn();
    }

    private resolveLandingChoice(player: EnginePlayer, decision: "buy" | "skip") {
        if (!this.isTurn(player) || this.phase !== "awaiting-landing" || this.pendingLanding?.playerId !== player.id) return this.reject(player.id, "No landing decision is pending");
        const space = propertyByPosition.get(this.pendingLanding.position);
        if (!space) return this.reject(player.id, "Invalid landing position");
        if (decision === "buy") {
            const price = Number(space.price);
            if (!Number.isFinite(price) || player.balance < price) return this.reject(player.id, "Insufficient funds to buy this property");
            player.balance -= price;
            player.properties.push({ posistion: player.position, count: 0, group: String(space.group), mortgaged: false });
            this.history(`${player.username} bought ${String(space.name)}`);
            this.pendingLanding = null;
            this.endTurn();
            return true;
        }
        this.pendingLanding = null;
        this.pendingAuction = { position: player.position, bids: {}, highestBidderId: null, highestBid: 0, passedPlayerIds: [] };
        this.phase = "awaiting-auction";
        this.history(`${String(space.name)} is up for auction`);
        this.publish();
        return true;
    }

    private auctionBid(player: EnginePlayer, amount: number) {
        if (this.phase !== "awaiting-auction" || !this.pendingAuction) return this.reject(player.id, "No auction is active");
        if (this.pendingAuction.passedPlayerIds.includes(player.id)) return this.reject(player.id, "You have already passed this auction");
        if (amount <= this.pendingAuction.highestBid || amount > player.balance) return this.reject(player.id, "Bid must exceed the current bid and fit your balance");
        this.pendingAuction.bids[player.id] = amount;
        this.pendingAuction.highestBid = amount;
        this.pendingAuction.highestBidderId = player.id;
        this.history(`${player.username} bid £${amount}`);
        this.turnRevision += 1;
        if (!this.settleAuctionIfComplete()) this.publish();
        return true;
    }

    private auctionPass(player: EnginePlayer) {
        if (this.phase !== "awaiting-auction" || !this.pendingAuction) return this.reject(player.id, "No auction is active");
        if (this.pendingAuction.passedPlayerIds.includes(player.id)) return this.reject(player.id, "You have already passed this auction");
        this.pendingAuction.passedPlayerIds.push(player.id);
        delete this.pendingAuction.bids[player.id];
        this.recalculateAuctionLeader();
        this.history(`${player.username} passed the auction`);
        this.turnRevision += 1;
        if (!this.settleAuctionIfComplete()) this.publish();
        return true;
    }

    private recalculateAuctionLeader() {
        if (!this.pendingAuction) return;
        const bids = Object.entries(this.pendingAuction.bids).sort(([, first], [, second]) => second - first);
        this.pendingAuction.highestBidderId = bids[0]?.[0] ?? null;
        this.pendingAuction.highestBid = bids[0]?.[1] ?? 0;
    }

    private settleAuctionIfComplete() {
        if (!this.pendingAuction) return false;
        const active = this.order.filter((id) => !this.pendingAuction!.passedPlayerIds.includes(id));
        if (!this.pendingAuction.highestBidderId && active.length > 0) return false;
        if (this.pendingAuction.highestBidderId && active.some((id) => id !== this.pendingAuction!.highestBidderId)) return false;
        this.finalizeAuction();
        return true;
    }

    private finalizeAuction() {
        const auction = this.pendingAuction;
        if (!auction) return;
        const winner = auction.highestBidderId ? this.players.get(auction.highestBidderId) : undefined;
        const space = propertyByPosition.get(auction.position);
        if (winner && space && winner.balance >= auction.highestBid) {
            winner.balance -= auction.highestBid;
            winner.properties.push({ posistion: auction.position, count: 0, group: String(space.group), mortgaged: false });
            this.history(`${winner.username} won ${String(space.name)} for £${auction.highestBid}`);
        } else if (space) {
            this.history(`${String(space.name)} received no bids`);
        }
        this.pendingAuction = null;
        this.endTurn();
    }

    private unjail(player: EnginePlayer, option: "pay" | "card") {
        if (!this.isTurn(player) || this.phase !== "awaiting-roll" || !player.isInJail) return this.reject(player.id, "You cannot leave jail now");
        if (option === "card") {
            if (player.getoutCards < 1) return this.reject(player.id, "No Get Out of Jail Free card available");
            player.getoutCards -= 1;
            const deck = this.heldJailCards[player.id]?.pop();
            this.returnJailCard(deck ?? "chance");
        } else {
            if (player.balance < 50) return this.reject(player.id, "Insufficient funds for jail fine");
            player.balance -= 50;
        }
        player.isInJail = false;
        player.jailTurnsRemaining = 0;
        this.history(`${player.username} left Jail ${option === "card" ? "with a Get Out of Jail Free card" : "by paying the £50 fine"}`);
        this.publish();
        return true;
    }

    private build(player: EnginePlayer, position: number) {
        if (!this.isTurn(player) || this.phase !== "awaiting-roll") return this.reject(player.id, "Buildings can only be bought during your roll phase");
        const property = this.propertyOf(player, position);
        const space = propertyByPosition.get(position);
        if (!property || !space || !this.isStreet(space) || property.mortgaged || !this.ownsCompleteGroup(player, property.group) || this.groupHasMortgage(player, property.group)) return this.reject(player.id, "You do not have an eligible complete color group");
        const group = player.properties.filter((candidate) => candidate.group === property.group);
        const level = property.count === "h" ? 5 : property.count;
        const lowest = Math.min(...group.map((candidate) => candidate.count === "h" ? 5 : candidate.count));
        if (level !== lowest || level >= 5) return this.reject(player.id, "Buildings must be purchased evenly");
        const cost = level === 4 ? Number(space.ohousecost) : Number(space.housecost);
        if (!Number.isFinite(cost) || player.balance < cost) return this.reject(player.id, "Insufficient funds for building");
        if (level === 4) {
            if (this.bankSupply.hotels < 1) return this.reject(player.id, "The bank has no hotels available");
            this.bankSupply.hotels -= 1;
            this.bankSupply.houses += 4;
        } else {
            if (this.bankSupply.houses < 1) return this.reject(player.id, "The bank has no houses available");
            this.bankSupply.houses -= 1;
        }
        player.balance -= cost;
        property.count = level === 4 ? "h" : (level + 1) as 1 | 2 | 3 | 4;
        this.publish();
        return true;
    }

    private sellBuilding(player: EnginePlayer, position: number) {
        if (!this.isSettling(player) && (!this.isTurn(player) || this.phase !== "awaiting-roll")) return this.reject(player.id, "Buildings can only be sold during your roll phase");
        const property = this.propertyOf(player, position);
        const space = propertyByPosition.get(position);
        if (!property || !space || !this.isStreet(space) || property.count === 0) return this.reject(player.id, "There is no building to sell");
        const group = player.properties.filter((candidate) => candidate.group === property.group);
        const level = property.count === "h" ? 5 : property.count;
        const highest = Math.max(...group.map((candidate) => candidate.count === "h" ? 5 : candidate.count));
        if (level !== highest) return this.reject(player.id, "Buildings must be sold evenly");
        const cost = Number(space.housecost);
        if (!Number.isFinite(cost)) return this.reject(player.id, "Building value is unavailable");
        if (property.count === "h") {
            if (this.bankSupply.houses < 4) return this.reject(player.id, "The bank cannot exchange this hotel for four houses");
            this.bankSupply.houses -= 4;
            this.bankSupply.hotels += 1;
            property.count = 4;
        } else {
            this.bankSupply.houses += 1;
            property.count = (property.count - 1) as 0 | 1 | 2 | 3;
        }
        player.balance += Math.floor(cost / 2);
        this.settleDebtIfPossible();
        this.publish();
        return true;
    }

    private mortgage(player: EnginePlayer, position: number, mortgaging: boolean) {
        // Redeeming costs money, so only raising it is allowed while settling a debt.
        const settling = this.isSettling(player) && mortgaging;
        if (!settling && (!this.isTurn(player) || this.phase !== "awaiting-roll" || !this.mode.mortageAllowed)) return this.reject(player.id, "Mortgages are not available now");
        const property = this.propertyOf(player, position);
        const space = propertyByPosition.get(position);
        if (!property || !space || String(space.group) === "Special") return this.reject(player.id, "You do not own this property");
        const group = player.properties.filter((candidate) => candidate.group === property.group);
        if (group.some((candidate) => candidate.count !== 0)) return this.reject(player.id, "Sell buildings before mortgaging this group");
        const value = Math.floor(Number(space.price) / 2);
        if (!Number.isFinite(value)) return this.reject(player.id, "Property cannot be mortgaged");
        if (mortgaging) {
            if (property.mortgaged) return this.reject(player.id, "Property is already mortgaged");
            property.mortgaged = true;
            player.balance += value;
            this.settleDebtIfPossible();
        } else {
            const cost = value + Math.ceil(value / 10);
            if (!property.mortgaged || player.balance < cost) return this.reject(player.id, "Cannot redeem this mortgage");
            property.mortgaged = false;
            player.balance -= cost;
        }
        this.publish();
        return true;
    }

    private proposeTrade(player: EnginePlayer, offer: Extract<GameAction, { type: "trade-propose" }>) {
        const settling = this.isSettling(player);
        if ((!settling && (!this.isTurn(player) || this.phase !== "awaiting-roll")) || !this.mode.AllowDeals || this.pendingTrade || offer.to === player.id) return this.reject(player.id, "Trade cannot be proposed now");
        const recipient = this.players.get(offer.to);
        const candidate: TradeOffer = { from: player.id, to: offer.to, offeredPositions: offer.offeredPositions, requestedPositions: offer.requestedPositions, offeredCash: offer.offeredCash, requestedCash: offer.requestedCash, offeredJailCards: offer.offeredJailCards, requestedJailCards: offer.requestedJailCards };
        if (!recipient || !this.validTrade(candidate)) return this.reject(player.id, "Invalid trade offer");
        this.pendingTrade = clone(candidate);
        this.publish();
        return true;
    }

    private acceptTrade(player: EnginePlayer) {
        const offer = this.pendingTrade;
        if (!offer || offer.to !== player.id || !this.mode.AllowDeals || !this.validTrade(offer)) return this.reject(player.id, "Trade cannot be accepted");
        const from = this.players.get(offer.from);
        const to = this.players.get(offer.to);
        if (!from || !to) return this.reject(player.id, "Trade participants are unavailable");
        const nextFrom = clone(from);
        const nextTo = clone(to);
        const offered = this.takeProperties(nextFrom, offer.offeredPositions);
        const requested = this.takeProperties(nextTo, offer.requestedPositions);
        nextFrom.balance = nextFrom.balance - offer.offeredCash + offer.requestedCash;
        nextTo.balance = nextTo.balance - offer.requestedCash + offer.offeredCash;
        nextFrom.properties.push(...requested);
        nextTo.properties.push(...offered);
        nextFrom.getoutCards = nextFrom.getoutCards - offer.offeredJailCards + offer.requestedJailCards;
        nextTo.getoutCards = nextTo.getoutCards - offer.requestedJailCards + offer.offeredJailCards;
        const movedToRecipient = (this.heldJailCards[nextFrom.id] ??= []).splice(0, offer.offeredJailCards);
        const movedToProposer = (this.heldJailCards[nextTo.id] ??= []).splice(0, offer.requestedJailCards);
        this.heldJailCards[nextTo.id].push(...movedToRecipient);
        this.heldJailCards[nextFrom.id].push(...movedToProposer);
        // Each side pays 10% on the mortgaged property it receives, ceilinged to
        // whole pounds exactly as an ordinary redemption is.
        const interestOn = (properties: PlayerProperty[]) => properties
            .filter((property) => property.mortgaged)
            .reduce((sum, property) => sum + Math.ceil(this.mortgageValue(property.posistion) / 10), 0);
        const fromInterest = interestOn(requested);
        const toInterest = interestOn(offered);
        if (nextFrom.balance < fromInterest || nextTo.balance < toInterest) return this.reject(player.id, "Insufficient funds for transferred mortgage interest");
        nextFrom.balance -= fromInterest;
        nextTo.balance -= toInterest;
        this.players.set(nextFrom.id, nextFrom);
        this.players.set(nextTo.id, nextTo);
        this.pendingTrade = null;
        this.settleDebtIfPossible();
        const describe = (cash: number, positions: number[], jailCards: number) => {
            const parts = [
                ...(cash > 0 ? [`£${cash}`] : []),
                ...positions.map((position) => String(propertyByPosition.get(position)?.name ?? `space ${position}`)),
                ...(jailCards > 0 ? [`${jailCards} Get Out of Jail Free card${jailCards === 1 ? "" : "s"}`] : []),
            ];
            return parts.length ? parts.join(" and ") : "nothing";
        };
        this.history(`${from.username} gave ${describe(offer.offeredCash, offer.offeredPositions, offer.offeredJailCards)} to ${to.username} for ${describe(offer.requestedCash, offer.requestedPositions, offer.requestedJailCards)}`);
        this.publish();
        return true;
    }

    private clearTrade(player: EnginePlayer) {
        if (!this.pendingTrade || (this.pendingTrade.from !== player.id && this.pendingTrade.to !== player.id)) return this.reject(player.id, "No trade to cancel");
        this.pendingTrade = null;
        this.publish();
        return true;
    }

    private validTrade(offer: TradeOffer) {
        const from = this.players.get(offer.from);
        const to = this.players.get(offer.to);
        if (!from || !to || from.balance < offer.offeredCash || to.balance < offer.requestedCash) return false;
        if (from.getoutCards < offer.offeredJailCards || to.getoutCards < offer.requestedJailCards) return false;
        const owns = (player: EnginePlayer, positions: number[]) => positions.every((position) => {
            const property = this.propertyOf(player, position);
            return property !== undefined && property.count === 0;
        });
        return owns(from, offer.offeredPositions) && owns(to, offer.requestedPositions);
    }

    private takeProperties(player: EnginePlayer, positions: number[]) {
        const moved = player.properties.filter((property) => positions.includes(property.posistion));
        player.properties = player.properties.filter((property) => !positions.includes(property.posistion));
        return moved;
    }

    /** Guarantees a non-empty draw pile so a draw can never dereference a missing card. */
    private replenishDeck(deck: CardDeckName): void {
        const deckState = this.cardDecks[deck];
        if (deckState.remaining.length > 0) return;
        deckState.remaining = deckState.discard.splice(0);
        if (deckState.remaining.length > 0) return;
        // Normal play cannot empty both piles, because only the single Get Out of
        // Jail Free card is ever held back. Persisted state that lost them can, so
        // rebuild the full deck rather than drawing an undefined card.
        deckState.remaining = (board[deck] as Card[]).map((_, index) => index);
    }

    private drawCard(player: EnginePlayer, deck: CardDeckName, rollTotal: number): void {
        const cards = board[deck] as Card[];
        const deckState = this.cardDecks[deck];
        this.replenishDeck(deck);
        const selected = Math.floor(this.random() * deckState.remaining.length);
        const cardIndex = deckState.remaining.splice(selected, 1)[0];
        const card = cards[cardIndex];
        if (!card) return this.endTurn();
        const fromPosition = player.position;
        const fromJail = player.isInJail;
        const destination = this.cardDestination(player, card);
        this.emit({ type: "card", playerId: player.id, deck, card, fromPosition, position: destination?.position ?? fromPosition, moved: destination !== null && destination.position !== fromPosition, fromJail, toJail: destination?.toJail ?? false });
        this.history(`${player.username} drew ${card.title}`);
        const heldForJail = card.action === "jail" && card.subaction === "getout";
        if (heldForJail) (this.heldJailCards[player.id] ??= []).push(deck);
        else deckState.discard.push(cardIndex);
        switch (card.action) {
            case "addfunds": player.balance += card.amount ?? 0; break;
            case "removefunds": this.chargeBank(player, card.amount ?? 0, cardReason(card)); break;
            case "propertycharges": this.chargeBank(player, this.propertyCharge(player, card), cardReason(card)); break;
            case "jail":
                if (card.subaction === "getout") player.getoutCards += 1;
                else this.sendToJail(player);
                break;
            case "removefundstoplayers": this.payEveryPlayer(player, card); break;
            case "addfundsfromplayers": {
                // Solvent payers settle immediately; the first who cannot enters a
                // settlement, and we stop so their debt is not overwritten.
                const amount = card.amount ?? 0;
                const payers = [...this.players.values()].filter((other) => other.id !== player.id);
                for (const other of payers.filter((candidate) => candidate.balance >= amount)) {
                    this.transfer(other, player, amount, "card payment", `${other.username} paid ${player.username} £${amount} for ${cardReason(card)}`);
                }
                const short = payers.find((candidate) => candidate.balance < amount);
                if (short) this.transfer(short, player, amount, "card payment", `${short.username} paid ${player.username} £${amount} for ${cardReason(card)}`);
                break;
            }
            case "move":
                this.moveByCard(player, card);
                return this.resolveSpace(player, rollTotal);
            case "movenearest":
                this.moveNearest(player, card.groupid);
                if (card.groupid === "utility" && this.ownerOf(player.position)) {
                    const utilityDice: [number, number] = [Math.floor(this.random() * 6) + 1, Math.floor(this.random() * 6) + 1];
                    this.emit({ type: "dice", playerId: player.id, dice: utilityDice, fromPosition: player.position, position: player.position, moved: false, fromJail: player.isInJail });
                    return this.resolveSpace(player, utilityDice[0] + utilityDice[1], card.rentmultiplier ?? 10, true);
                }
                return this.resolveSpace(player, rollTotal, card.rentmultiplier ?? 1);
        }
        this.endTurn();
    }

    private returnJailCard(deck: CardDeckName) {
        const cards = board[deck] as Card[];
        const cardIndex = cards.findIndex((card) => card.action === "jail" && card.subaction === "getout");
        if (cardIndex >= 0) this.cardDecks[deck].discard.push(cardIndex);
    }

    private propertyCharge(player: EnginePlayer, card: Card) {
        const houses = player.properties.reduce((sum, property) => sum + (typeof property.count === "number" ? property.count : 0), 0);
        const hotels = player.properties.filter((property) => property.count === "h").length;
        return houses * (card.buildings ?? 0) + hotels * (card.hotels ?? 0);
    }

    private moveByCard(player: EnginePlayer, card: Card) {
        if (typeof card.count === "number") {
            const fromPosition = player.position;
            player.position = (player.position + card.count + 40) % 40;
            if (card.count > 0 && fromPosition + card.count >= 40) this.awardGoSalary(player, fromPosition, player.position, "passed");
            return;
        }
        const fromPosition = player.position;
        const next = destinationById(player.position, card.tileid);
        if (next === null) return;
        player.position = next;
        if (next < fromPosition) this.awardGoSalary(player, fromPosition, next, next === 0 ? "advanced" : "passed");
    }

    private cardDestination(player: EnginePlayer, card: Card): { position: number; toJail: boolean } | null {
        if (card.action === "move") {
            if (typeof card.count === "number") return { position: (player.position + card.count + 40) % 40, toJail: false };
            const next = destinationById(player.position, card.tileid);
            return next === null ? null : { position: next, toJail: false };
        }
        if (card.action === "movenearest") return { position: this.nearestPosition(player.position, card.groupid), toJail: false };
        if (card.action === "jail" && card.subaction === "goto") return { position: 10, toJail: true };
        return null;
    }

    private nearestPosition(position: number, groupId?: string) {
        const group = groupId === "utility" ? "Utilities" : "Railroad";
        const locations = properties.filter((property) => property.group === group).map((property) => Number(property.posistion)).sort((a, b) => a - b);
        return locations.find((candidate) => candidate > position) ?? locations[0];
    }

    private moveNearest(player: EnginePlayer, groupId?: string) {
        const fromPosition = player.position;
        const next = this.nearestPosition(player.position, groupId);
        player.position = next;
        if (next < fromPosition) this.awardGoSalary(player, fromPosition, next, "passed");
    }

    private awardGoSalary(player: EnginePlayer, fromPosition: number, position: number, reason: "passed" | "advanced") {
        player.balance += 200;
        this.emit({ type: "salary", playerId: player.id, amount: 200, fromPosition, position, reason });
        this.history(`${player.username} ${reason === "advanced" ? "advanced to" : "passed"} Go and collected £200`);
    }

    private rentFor(owner: EnginePlayer, position: number, rollTotal: number) {
        const property = this.propertyOf(owner, position);
        const space = propertyByPosition.get(position);
        if (!property || !space || property.mortgaged) return 0;
        const group = String(space.group);
        if (group === "Utilities") return rollTotal * (owner.properties.filter((candidate) => candidate.group === group && !candidate.mortgaged).length === 2 ? 10 : 4);
        if (group === "Railroad") return [0, 25, 50, 100, 200][owner.properties.filter((candidate) => candidate.group === group && !candidate.mortgaged).length];
        if (property.count === "h") return Number((space.multpliedrent as number[] | undefined)?.[4] ?? 0);
        if (property.count > 0) return Number((space.multpliedrent as number[] | undefined)?.[property.count - 1] ?? 0);
        const baseRent = Number(space.rent ?? 0);
        return this.ownsCompleteGroup(owner, group) ? baseRent * 2 : baseRent;
    }

    private transfer(from: EnginePlayer, to: EnginePlayer, amount: number, reason: string, label?: string) {
        if (amount <= 0) return true;
        if (from.balance < amount) return this.openSettlement(from, amount, to, reason, label);
        from.balance -= amount;
        to.balance += amount;
        this.history(label ?? `${from.username} paid £${amount} for ${reason}`);
        return true;
    }

    private chargeBank(player: EnginePlayer, amount: number, reason: string) {
        if (amount <= 0) return true;
        if (player.balance < amount) return this.openSettlement(player, amount, undefined, reason);
        player.balance -= amount;
        this.history(`${player.username} paid £${amount} for ${reason}`);
        return true;
    }

    /**
     * "Pay each player" is a single obligation. Charging it one creditor at a time
     * let a shortfall abandon the rest, so the total is checked up front and either
     * paid in full or carried into one settlement that distributes on completion.
     */
    private payEveryPlayer(player: EnginePlayer, card: Card) {
        const each = card.amount ?? 0;
        const others = [...this.players.values()].filter((other) => other.id !== player.id);
        if (each <= 0 || others.length === 0) return true;
        const total = each * others.length;
        if (player.balance >= total) {
            for (const other of others) this.transfer(player, other, each, "card payment", `${player.username} paid ${other.username} £${each} for ${cardReason(card)}`);
            return true;
        }
        return this.openSettlement(player, total, undefined, cardReason(card), undefined, others.map((other) => ({ creditorId: other.id, amount: each })));
    }

    /**
     * Pauses play on the debtor. Returns false so the interrupted flow stops; the
     * turn is resumed by `settleDebt` or ended by bankruptcy. Trading can bring in
     * money the debtor cannot raise alone, so this never pre-judges bankruptcy.
     */
    private openSettlement(debtor: EnginePlayer, amount: number, creditor: EnginePlayer | undefined, reason: string, label?: string, shares?: Array<{ creditorId: string; amount: number }>) {
        this.pendingDebt = { playerId: debtor.id, amount, creditorId: creditor?.id ?? null, reason, ...(label ? { label } : {}), ...(shares ? { shares } : {}) };
        this.phase = "awaiting-settlement";
        this.turnRevision += 1;
        this.history(`${debtor.username} owes £${amount} for ${reason} and must raise £${amount - debtor.balance} more`);
        return false;
    }

    /** Whether this player is the one who owes money right now. */
    private isSettling(player: EnginePlayer) {
        return this.phase === "awaiting-settlement" && this.pendingDebt?.playerId === player.id;
    }

    /** Pays a pending debt the moment the debtor can cover it, then resumes play. */
    private settleDebtIfPossible() {
        const debt = this.pendingDebt;
        if (!debt) return;
        const debtor = this.players.get(debt.playerId);
        if (!debtor || debtor.balance < debt.amount) return;
        debtor.balance -= debt.amount;
        if (debt.shares) {
            for (const share of debt.shares) {
                const creditor = this.players.get(share.creditorId);
                if (creditor) creditor.balance += share.amount;
                this.history(`${debtor.username} paid ${creditor?.username ?? "a player"} £${share.amount} for ${debt.reason}`);
            }
        } else {
            const creditor = debt.creditorId ? this.players.get(debt.creditorId) : undefined;
            if (creditor) creditor.balance += debt.amount;
            this.history(debt.label ?? `${debtor.username} paid £${debt.amount} for ${debt.reason}`);
        }
        this.pendingDebt = null;
        this.phase = "awaiting-roll";
        this.endTurn();
    }

    private declareBankruptcy(player: EnginePlayer) {
        const debt = this.pendingDebt;
        if (!debt || !this.isSettling(player)) return this.reject(player.id, "You have no debt to settle");
        this.bankruptFor(debt, player);
        return true;
    }

    /**
     * Retires the debtor. A debt split across several players has no single
     * creditor to inherit the estate, so the cash on hand is shared out as far as
     * it goes and the properties return to the bank.
     */
    private bankruptFor(debt: PendingDebt, debtor: EnginePlayer) {
        this.pendingDebt = null;
        this.phase = "awaiting-roll";
        if (debt.shares) {
            for (const share of debt.shares) {
                const paid = Math.min(share.amount, debtor.balance);
                if (paid <= 0) break;
                const creditor = this.players.get(share.creditorId);
                debtor.balance -= paid;
                if (creditor) creditor.balance += paid;
                this.history(`${debtor.username} paid ${creditor?.username ?? "a player"} £${paid} of £${share.amount} for ${debt.reason}`);
            }
            this.bankrupt(debtor, undefined, debt.reason);
        } else {
            this.bankrupt(debtor, debt.creditorId ? this.players.get(debt.creditorId) : undefined, debt.reason);
        }
        this.endTurn();
    }

    /** Deadline backstop: liquidate what we can, then bankrupt if still short. */
    private forceSettlement() {
        const debt = this.pendingDebt;
        if (!debt) return;
        const debtor = this.players.get(debt.playerId);
        if (!debtor) {
            this.pendingDebt = null;
            this.phase = "awaiting-roll";
            this.endTurn();
            return;
        }
        this.raiseCash(debtor, debt.amount);
        if (debtor.balance >= debt.amount) {
            this.history(`${debtor.username} ran out of time and the bank liquidated their assets`);
            this.settleDebtIfPossible();
            return;
        }
        this.bankruptFor(debt, debtor);
    }

    /**
     * Sells one building level at a time from the most developed property, so a
     * forced sale keeps colour groups even and stops as soon as the debt is met.
     */
    private sellBuildingsToRaise(player: EnginePlayer, amount: number) {
        while (player.balance < amount) {
            const developed = player.properties.filter((property) => buildingLevel(property) > 0);
            if (developed.length === 0) return;
            const highest = Math.max(...developed.map(buildingLevel));
            const property = developed.find((candidate) => buildingLevel(candidate) === highest)!;
            const halfCost = Math.floor(Number(propertyByPosition.get(property.posistion)?.housecost ?? 0) / 2);
            if (property.count === "h") {
                this.bankSupply.hotels += 1;
                if (this.bankSupply.houses >= 4) {
                    this.bankSupply.houses -= 4;
                    property.count = 4;
                    player.balance += halfCost;
                } else {
                    // The bank cannot supply the four replacement houses, so the whole hotel is sold.
                    property.count = 0;
                    player.balance += halfCost * 5;
                }
            } else {
                this.bankSupply.houses += 1;
                property.count = (property.count - 1) as 0 | 1 | 2 | 3;
                player.balance += halfCost;
            }
        }
    }

    private raiseCash(player: EnginePlayer, amount: number) {
        if (player.balance >= amount) return;
        this.sellBuildingsToRaise(player, amount);
        for (const property of player.properties) {
            if (player.balance >= amount) break;
            if (property.mortgaged) continue;
            property.mortgaged = true;
            player.balance += this.mortgageValue(property.posistion);
        }
    }

    private bankrupt(player: EnginePlayer, creditor: EnginePlayer | undefined, reason: string) {
        const removedIndex = this.order.indexOf(player.id);
        if (removedIndex < 0) return;
        const wasCurrent = this.currentPlayerId === player.id;
        if (creditor) {
            creditor.balance += Math.max(0, player.balance);
            let interest = 0;
            for (const property of player.properties) {
                this.returnBuildings(property);
                if (property.mortgaged) interest += Math.ceil(this.mortgageValue(property.posistion) / 10);
                creditor.properties.push(property);
            }
            creditor.balance -= interest;
        } else {
            for (const property of player.properties) this.returnBuildings(property);
        }
        player.balance = 0;
        player.properties = [];
        this.players.delete(player.id);
        this.order.splice(removedIndex, 1);
        for (const deck of this.heldJailCards[player.id] ?? []) this.returnJailCard(deck);
        delete this.heldJailCards[player.id];
        if (this.pendingTrade && (this.pendingTrade.from === player.id || this.pendingTrade.to === player.id)) this.pendingTrade = null;
        if (this.pendingAuction) {
            delete this.pendingAuction.bids[player.id];
            this.pendingAuction.passedPlayerIds = this.pendingAuction.passedPlayerIds.filter((id) => id !== player.id);
            this.recalculateAuctionLeader();
        }
        if (this.lobbyHostId === player.id) this.lobbyHostId = this.order[0] ?? null;
        if (wasCurrent) {
            this.currentIndex = this.order.length ? removedIndex % this.order.length : 0;
            this.currentPlayerRemoved = true;
        } else if (removedIndex < this.currentIndex) {
            this.currentIndex -= 1;
        }
        this.history(`${player.username} went bankrupt because of ${reason}`);
    }

    /** Buildings must go back to the bank's finite supply before a property moves or leaves play. */
    private returnBuildings(property: PlayerProperty) {
        if (property.count === "h") this.bankSupply.hotels += 1;
        else this.bankSupply.houses += property.count;
        property.count = 0;
    }

    private sendToJail(player: EnginePlayer) {
        this.history(`${player.username} was sent to Jail`); player.position = 10; player.isInJail = true; player.jailTurnsRemaining = 3; this.consecutiveDoubles = 0; this.extraRollPending = false; }
    private scoreFinalStandings(): FinalStanding[] {
        const originalOrder = new Map(this.order.map((id, index) => [id, index]));
        return this.order.map((id) => this.players.get(id)).filter((player): player is EnginePlayer => Boolean(player)).map((player) => {
            let unmortgagedPropertyValue = 0;
            let mortgagedPropertyValue = 0;
            let buildingValue = 0;
            for (const property of player.properties) {
                const space = propertyByPosition.get(property.posistion);
                const price = Number(space?.price ?? 0);
                const houseCost = Number(space?.housecost ?? 0);
                if (property.mortgaged) mortgagedPropertyValue += Math.floor(price / 2);
                else unmortgagedPropertyValue += price;
                buildingValue += buildingLevel(property) * houseCost;
            }
            return {
                playerId: player.id,
                username: player.username,
                rank: 0,
                cash: player.balance,
                unmortgagedPropertyValue,
                mortgagedPropertyValue,
                buildingValue,
                netWorth: player.balance + unmortgagedPropertyValue + mortgagedPropertyValue + buildingValue,
            };
        }).sort((left, right) => right.netWorth - left.netWorth || right.cash - left.cash || (originalOrder.get(left.playerId) ?? 0) - (originalOrder.get(right.playerId) ?? 0))
            .map((standing, index) => ({ ...standing, rank: index + 1 }));
    }

    /** Host rematch: same players and seating, everything else back to a fresh lobby. */
    private restart(player: EnginePlayer) {
        if (this.phase !== "finished") return this.reject(player.id, "The game can only be restarted once it has finished");
        if (player.id !== this.lobbyHostId) return this.reject(player.id, "Only the room host can start a new game");
        for (const candidate of this.players.values()) {
            candidate.position = 0;
            candidate.balance = this.mode.startingCash;
            candidate.properties = [];
            candidate.isInJail = false;
            candidate.jailTurnsRemaining = 0;
            candidate.getoutCards = 0;
            candidate.ready = false;
        }
        this.currentIndex = 0;
        this.phase = "lobby";
        this.pendingLanding = null;
        this.pendingTrade = null;
        this.pendingAuction = null;
        this.pendingDebt = null;
        this.pausedPlayerId = null;
        this.consecutiveDoubles = 0;
        this.extraRollPending = false;
        this.currentPlayerRemoved = false;
        this.cardDecks = freshCardDecks();
        this.heldJailCards = {};
        this.bankSupply = { houses: 32, hotels: 12 };
        this.winnerId = null;
        this.finalStandings = null;
        this.turnRevision += 1;
        this.history(`${player.username} started a new game`);
        this.publish();
        return true;
    }

    private endGame(player: EnginePlayer) {
        if (this.phase === "lobby" || this.phase === "finished") return this.reject(player.id, "The game cannot be ended now");
        if (player.id !== this.lobbyHostId) return this.reject(player.id, "Only the room host can end the game");
        const standings = this.scoreFinalStandings();
        const winner = standings[0];
        if (!winner) return this.reject(player.id, "No players are available to score");
        this.pendingLanding = null;
        this.pendingTrade = null;
        this.pendingAuction = null;
        this.pendingDebt = null;
        this.pausedPlayerId = null;
        this.consecutiveDoubles = 0;
        this.extraRollPending = false;
        this.currentPlayerRemoved = false;
        this.finalStandings = standings;
        this.winnerId = winner.playerId;
        this.phase = "finished";
        this.turnRevision += 1;
        this.history(`${player.username} ended the game. ${winner.username} won with a net worth of £${winner.netWorth}`);
        this.emit({ type: "game-ended", winnerId: winner.playerId, standings });
        this.publish();
        return true;
    }

    private endTurn() {
        // A pending debt suspends the turn; settleDebtIfPossible or bankruptcy resumes it.
        if (this.pendingDebt) return;
        this.pendingLanding = null;
        this.pendingAuction = null;
        this.resolveWinner();
        if (this.phase === "finished" || this.order.length === 0) { this.publish(); return; }
        if (this.currentPlayerRemoved) {
            this.currentPlayerRemoved = false;
            this.consecutiveDoubles = 0;
            this.extraRollPending = false;
            this.phase = "awaiting-roll";
            this.turnRevision += 1;
            this.publish();
            return;
        }
        if (this.extraRollPending) {
            this.extraRollPending = false;
            this.phase = "awaiting-roll";
            this.turnRevision += 1;
            this.publish();
            return;
        }
        this.consecutiveDoubles = 0;
        this.currentIndex = (this.currentIndex + 1) % this.order.length;
        this.phase = "awaiting-roll";
        this.turnRevision += 1;
        this.publish();
    }

    private resolveWinner() {
        if (this.phase === "finished") return;
        const solvent = this.order.map((id) => this.players.get(id)).filter((player): player is EnginePlayer => Boolean(player && player.balance >= 0));
        if (this.phase === "lobby") return;
        if (this.mode.WinningMode === "monopols & trains") {
            const modeWinner = solvent.find((player) => {
                const railroads = player.properties.filter((property) => property.group === "Railroad").length;
                const streetGroups = new Set(player.properties.filter((property) => !["Railroad", "Utilities", "Special"].includes(property.group)).map((property) => property.group));
                return railroads === 4 && [...streetGroups].some((group) => this.ownsCompleteGroup(player, group));
            });
            if (modeWinner) {
                this.winnerId = modeWinner.id;
                this.phase = "finished";
                return;
            }
        }
        if (solvent.length <= 1) { this.winnerId = solvent[0]?.id ?? null; this.phase = "finished"; }
    }
    private ownerOf(position: number) { return [...this.players.values()].find((player) => this.propertyOf(player, position)); }
    private propertyOf(player: EnginePlayer, position: number) { return player.properties.find((property) => property.posistion === position); }
    private isStreet(space: Record<string, unknown>) { return !["Special", "Railroad", "Utilities"].includes(String(space.group)); }
    private ownsCompleteGroup(player: EnginePlayer, group: string) {
        const boardCount = properties.filter((space) => space.group === group).length;
        return boardCount > 0 && player.properties.filter((property) => property.group === group).length === boardCount;
    }
    private groupHasMortgage(player: EnginePlayer, group: string) { return player.properties.some((property) => property.group === group && property.mortgaged); }
    private mortgageValue(position: number) { const space = propertyByPosition.get(position); return Math.floor(Number(space?.price ?? 0) / 2); }
}
