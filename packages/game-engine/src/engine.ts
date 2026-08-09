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

export type GamePhase = "lobby" | "awaiting-roll" | "awaiting-landing" | "awaiting-auction" | "finished";
export type ModeId = "classic" | "monopol" | "run-down";
export type EngineEvent =
    | { type: "state"; state: GameSnapshot }
    | { type: "dice"; playerId: string; dice: [number, number]; fromPosition: number; position: number; moved: boolean; fromJail: boolean }
    | { type: "card"; playerId: string; deck: CardDeckName; card: Card; fromPosition: number; position: number; moved: boolean; fromJail: boolean; toJail: boolean }
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
    winnerId: string | null;
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
    | { type: "trade-propose"; to: string; offeredPositions: number[]; requestedPositions: number[]; offeredCash: number; requestedCash: number }
    | { type: "trade-accept" }
    | { type: "trade-reject" }
    | { type: "trade-cancel" }
    | { type: "auction-bid"; amount: number }
    | { type: "auction-pass" };

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

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPosition(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 40;
}

function isMoney(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isInteger(value);
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
            return typeof value.to === "string" && value.to.length > 0 && offeredPositions !== null && requestedPositions !== null &&
                isMoney(value.offeredCash) && isMoney(value.requestedCash)
                ? { type: "trade-propose", to: value.to, offeredPositions, requestedPositions, offeredCash: value.offeredCash, requestedCash: value.requestedCash }
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
    private winnerId: string | null = null;
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
        engine.winnerId = snapshot.winnerId;
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
            pendingLanding: this.pendingLanding, pendingTrade: this.pendingTrade, pendingAuction: this.pendingAuction, winnerId: this.winnerId, pausedPlayerId: this.pausedPlayerId,
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
        if (this.pausedPlayerId || (this.phase !== "awaiting-roll" && this.phase !== "awaiting-landing" && this.phase !== "awaiting-auction")) return false;
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
            if (doubles) { player.isInJail = false; player.jailTurnsRemaining = 0; }
            else {
                player.jailTurnsRemaining -= 1;
                if (player.jailTurnsRemaining > 0) {
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
        if (player.position < previous) player.balance += 200;
        emitDice(true);
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
            this.transfer(player, owner, rent, `rent for ${String(space.name)}`);
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
        if (!this.isTurn(player) || this.phase !== "awaiting-roll") return this.reject(player.id, "Buildings can only be sold during your roll phase");
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
        this.publish();
        return true;
    }

    private mortgage(player: EnginePlayer, position: number, mortgaging: boolean) {
        if (!this.isTurn(player) || this.phase !== "awaiting-roll" || !this.mode.mortageAllowed) return this.reject(player.id, "Mortgages are not available now");
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
        if (!this.isTurn(player) || this.phase !== "awaiting-roll" || !this.mode.AllowDeals || this.pendingTrade || offer.to === player.id) return this.reject(player.id, "Trade cannot be proposed now");
        const recipient = this.players.get(offer.to);
        const candidate: TradeOffer = { from: player.id, to: offer.to, offeredPositions: offer.offeredPositions, requestedPositions: offer.requestedPositions, offeredCash: offer.offeredCash, requestedCash: offer.requestedCash };
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
        this.history(`${from.username} traded with ${to.username}`);
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
            case "removefunds": this.chargeBank(player, card.amount ?? 0, card.title); break;
            case "propertycharges": this.chargeBank(player, this.propertyCharge(player, card), card.title); break;
            case "jail":
                if (card.subaction === "getout") player.getoutCards += 1;
                else this.sendToJail(player);
                break;
            case "removefundstoplayers": for (const other of [...this.players.values()]) if (other.id !== player.id && this.players.has(player.id) && !this.transfer(player, other, card.amount ?? 0, "card payment")) break; break;
            case "addfundsfromplayers": for (const other of [...this.players.values()]) if (other.id !== player.id && this.players.has(other.id)) this.transfer(other, player, card.amount ?? 0, "card payment"); break;
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
        if (typeof card.count === "number") { player.position = (player.position + card.count + 40) % 40; return; }
        const next = destinationById(player.position, card.tileid);
        if (next === null) return;
        if (next < player.position) player.balance += 200;
        player.position = next;
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
        const next = this.nearestPosition(player.position, groupId);
        if (next < player.position) player.balance += 200;
        player.position = next;
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

    private transfer(from: EnginePlayer, to: EnginePlayer, amount: number, reason: string) {
        if (amount <= 0) return true;
        this.raiseCash(from, amount);
        if (from.balance < amount) {
            this.bankrupt(from, to, reason);
            return false;
        }
        from.balance -= amount;
        to.balance += amount;
        this.history(`${from.username} paid £${amount} for ${reason}`);
        return true;
    }

    private chargeBank(player: EnginePlayer, amount: number, reason: string) {
        if (amount <= 0) return true;
        this.raiseCash(player, amount);
        if (player.balance < amount) {
            this.bankrupt(player, undefined, reason);
            return false;
        }
        player.balance -= amount;
        this.history(`${player.username} paid £${amount} for ${reason}`);
        return true;
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

    private sendToJail(player: EnginePlayer) { player.position = 10; player.isInJail = true; player.jailTurnsRemaining = 3; this.consecutiveDoubles = 0; this.extraRollPending = false; }
    private endTurn() {
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
