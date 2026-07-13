import board from "./monopoly.json";
import { MonopolyMode, MonopolyModes, PlayerProprety } from "./types";

export type GamePhase = "lobby" | "awaiting-roll" | "awaiting-landing" | "finished";
export type ModeId = "classic" | "monopol" | "run-down";
export type EngineEvent =
    | { type: "state"; state: GameSnapshot }
    | { type: "dice"; playerId: string; dice: [number, number]; position: number }
    | { type: "card"; playerId: string; card: Card }
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
    properties: PlayerProprety[];
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
    winnerId: string | null;
}

export type GameAction =
    | { type: "ready"; ready: boolean }
    | { type: "select-mode"; modeId: ModeId }
    | { type: "roll" }
    | { type: "landing"; decision: "buy" | "skip" }
    | { type: "unjail"; option: "pay" | "card" }
    | { type: "build"; position: number }
    | { type: "mortgage"; position: number }
    | { type: "unmortgage"; position: number }
    | { type: "trade-propose"; to: string; offeredPositions: number[]; requestedPositions: number[]; offeredCash: number; requestedCash: number }
    | { type: "trade-accept" }
    | { type: "trade-reject" }
    | { type: "trade-cancel" };

const modes: Record<ModeId, MonopolyMode> = {
    classic: MonopolyModes[0],
    monopol: MonopolyModes[1],
    "run-down": MonopolyModes[2],
};

const properties = board.properties as Array<Record<string, unknown>>;
const propertyByPosition = new Map(properties.map((property) => [Number(property.posistion), property]));
const propertyById = new Map(properties.map((property) => [String(property.id), property]));

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
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
            return { type: value.type };
        case "landing":
            return value.decision === "buy" || value.decision === "skip" ? { type: "landing", decision: value.decision } : null;
        case "unjail":
            return value.option === "pay" || value.option === "card" ? { type: "unjail", option: value.option } : null;
        case "build":
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
    private winnerId: string | null = null;
    private listeners = new Set<(event: EngineEvent) => void>();

    public constructor(private readonly maxPlayers: number, private readonly random: () => number = Math.random) {}

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
        this.players.delete(id);
        this.order.splice(removedIndex, 1);
        if (this.pendingTrade && (this.pendingTrade.from === id || this.pendingTrade.to === id)) this.pendingTrade = null;
        if (this.lobbyHostId === id) this.lobbyHostId = this.order[0] ?? null;
        if (this.order.length === 0) {
            this.currentIndex = 0;
            this.phase = "lobby";
            this.pendingLanding = null;
        } else if (wasCurrent) {
            this.currentIndex = removedIndex % this.order.length;
            this.pendingLanding = null;
            if (this.phase !== "lobby") this.phase = "awaiting-roll";
        } else if (removedIndex < this.currentIndex) {
            this.currentIndex -= 1;
        }
        this.resolveWinner();
        this.publish();
    }

    public handle(actorId: string, rawAction: unknown): boolean {
        const action = parseAction(rawAction);
        if (!action) return this.reject(actorId, "Invalid action payload");
        const actor = this.players.get(actorId);
        if (!actor) return this.reject(actorId, "Unknown player");
        switch (action.type) {
            case "ready": return this.setReady(actor, action.ready);
            case "select-mode": return this.selectMode(actor, action.modeId);
            case "roll": return this.roll(actor);
            case "landing": return this.resolveLandingChoice(actor, action.decision);
            case "unjail": return this.unjail(actor, action.option);
            case "build": return this.build(actor, action.position);
            case "mortgage": return this.mortgage(actor, action.position, true);
            case "unmortgage": return this.mortgage(actor, action.position, false);
            case "trade-propose": return this.proposeTrade(actor, action);
            case "trade-accept": return this.acceptTrade(actor);
            case "trade-reject":
            case "trade-cancel": return this.clearTrade(actor);
        }
    }

    public snapshot(): GameSnapshot {
        return clone({
            phase: this.phase, gameStarted: this.phase !== "lobby", currentPlayerId: this.currentPlayerId,
            lobbyHostId: this.lobbyHostId, modeId: this.modeId, selectedMode: modes[this.modeId],
            players: this.order.map((id) => this.players.get(id)).filter((player): player is EnginePlayer => Boolean(player)),
            pendingLanding: this.pendingLanding, pendingTrade: this.pendingTrade, winnerId: this.winnerId,
        });
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
        if (player.isInJail) {
            if (dice[0] === dice[1]) { player.isInJail = false; player.jailTurnsRemaining = 0; }
            else {
                player.jailTurnsRemaining -= 1;
                if (player.jailTurnsRemaining <= 0) player.isInJail = false;
                this.emit({ type: "dice", playerId: player.id, dice, position: player.position });
                this.endTurn();
                return true;
            }
        }
        const previous = player.position;
        player.position = (player.position + dice[0] + dice[1]) % 40;
        if (player.position < previous) player.balance += 200;
        this.emit({ type: "dice", playerId: player.id, dice, position: player.position });
        this.resolveSpace(player, dice[0] + dice[1]);
        this.publish();
        return true;
    }

    private resolveSpace(player: EnginePlayer, rollTotal: number): void {
        const space = propertyByPosition.get(player.position);
        if (!space) return this.endTurn();
        const id = String(space.id);
        if (id === "gotojail") { this.sendToJail(player); return this.endTurn(); }
        if (id === "incometax" || id === "luxerytax") { player.balance -= id === "incometax" ? 200 : 100; return this.endTurn(); }
        if (id === "chance" || id === "communitychest") return this.drawCard(player, id, rollTotal);
        if (String(space.group) === "Special") return this.endTurn();
        const owner = this.ownerOf(player.position);
        if (!owner) { this.pendingLanding = { playerId: player.id, position: player.position }; this.phase = "awaiting-landing"; return; }
        if (owner.id !== player.id) this.transfer(player, owner, this.rentFor(owner, player.position, rollTotal), `rent for ${String(space.name)}`);
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
        }
        this.pendingLanding = null;
        this.endTurn();
        return true;
    }

    private unjail(player: EnginePlayer, option: "pay" | "card") {
        if (!this.isTurn(player) || this.phase !== "awaiting-roll" || !player.isInJail) return this.reject(player.id, "You cannot leave jail now");
        if (option === "card") {
            if (player.getoutCards < 1) return this.reject(player.id, "No Get Out of Jail Free card available");
            player.getoutCards -= 1;
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
        player.balance -= cost;
        property.count = level === 4 ? "h" : (level + 1) as 1 | 2 | 3 | 4;
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
        const interest = offered.filter((property) => property.mortgaged).reduce((sum, property) => sum + this.mortgageValue(property.posistion) * 0.1, 0);
        if (nextTo.balance < interest) return this.reject(player.id, "Insufficient funds for transferred mortgage interest");
        nextTo.balance -= interest;
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

    private drawCard(player: EnginePlayer, deck: "chance" | "communitychest", rollTotal: number): void {
        const cards = board[deck] as Card[];
        const card = cards[Math.floor(this.random() * cards.length)];
        this.emit({ type: "card", playerId: player.id, card });
        this.history(`${player.username} drew ${card.title}`);
        switch (card.action) {
            case "addfunds": player.balance += card.amount ?? 0; break;
            case "removefunds": player.balance -= card.amount ?? 0; break;
            case "propertycharges": player.balance -= this.propertyCharge(player, card); break;
            case "jail":
                if (card.subaction === "getout") player.getoutCards += 1;
                else this.sendToJail(player);
                break;
            case "removefundstoplayers": for (const other of this.players.values()) if (other.id !== player.id) this.transfer(player, other, card.amount ?? 0, "card payment"); break;
            case "addfundsfromplayers": for (const other of this.players.values()) if (other.id !== player.id) this.transfer(other, player, card.amount ?? 0, "card payment"); break;
            case "move":
                this.moveByCard(player, card);
                return this.resolveSpace(player, rollTotal);
            case "movenearest":
                this.moveNearest(player, card.groupid);
                return this.resolveSpace(player, rollTotal * (card.rentmultiplier ?? 1));
        }
        this.endTurn();
    }

    private propertyCharge(player: EnginePlayer, card: Card) {
        const houses = player.properties.reduce((sum, property) => sum + (typeof property.count === "number" ? property.count : 0), 0);
        const hotels = player.properties.filter((property) => property.count === "h").length;
        return houses * (card.buildings ?? 0) + hotels * (card.hotels ?? 0);
    }

    private moveByCard(player: EnginePlayer, card: Card) {
        if (typeof card.count === "number") { player.position = (player.position + card.count + 40) % 40; return; }
        const destination = propertyById.get(card.tileid ?? "");
        if (!destination) return;
        const next = Number(destination.posistion);
        if (next < player.position && card.tileid !== "go") player.balance += 200;
        player.position = next;
    }

    private moveNearest(player: EnginePlayer, groupId?: string) {
        const group = groupId === "utility" ? "Utilities" : "Railroad";
        const locations = properties.filter((property) => property.group === group).map((property) => Number(property.posistion)).sort((a, b) => a - b);
        const next = locations.find((position) => position > player.position) ?? locations[0];
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
        return Number(space.rent ?? 0);
    }

    private transfer(from: EnginePlayer, to: EnginePlayer, amount: number, reason: string) {
        if (amount <= 0) return;
        from.balance -= amount;
        to.balance += amount;
        this.history(`${from.username} paid ${amount} for ${reason}`);
    }

    private sendToJail(player: EnginePlayer) { player.position = 10; player.isInJail = true; player.jailTurnsRemaining = 3; }
    private endTurn() {
        this.pendingLanding = null;
        this.resolveWinner();
        if (this.phase === "finished" || this.order.length === 0) { this.publish(); return; }
        this.currentIndex = (this.currentIndex + 1) % this.order.length;
        this.phase = "awaiting-roll";
        this.publish();
    }

    private resolveWinner() {
        const solvent = this.order.map((id) => this.players.get(id)).filter((player): player is EnginePlayer => Boolean(player && player.balance >= 0));
        if (this.phase !== "lobby" && solvent.length <= 1) { this.winnerId = solvent[0]?.id ?? null; this.phase = "finished"; }
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
