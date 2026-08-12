import { boardSpaces, type GameSnapshot } from "@monopoly/game-engine";
import { isStreetGroup } from "./boardColors";

type PendingLanding = GameSnapshot["pendingLanding"];
type PlayerBalance = Pick<GameSnapshot["players"][number], "id" | "balance">;

export type BalanceChange = { playerId: string; amount: number };

/** True while this player is the one who owes money and play is paused on them. */
export function isSettlingPlayer(game: Pick<GameSnapshot, "phase" | "pendingDebt">, playerId: string) {
  return game.phase === "awaiting-settlement" && game.pendingDebt?.playerId === playerId;
}

/** Raising cash is allowed on your own roll phase, or while you are settling a debt. */
function canRaiseCash(game: GameSnapshot, playerId: string, presentationBlocking: boolean) {
  if (presentationBlocking || game.pausedPlayerId !== null) return false;
  return isSettlingPlayer(game, playerId) || (game.currentPlayerId === playerId && game.phase === "awaiting-roll");
}

/** Mortgage confirmation is valid only while the authoritative snapshot still permits it. */
export function mortgageConfirmationProperty(game: GameSnapshot, playerId: string, position: number, presentationBlocking: boolean) {
  if (!canRaiseCash(game, playerId, presentationBlocking) || !game.selectedMode.mortageAllowed) return null;
  const player = game.players.find((candidate) => candidate.id === playerId);
  const property = player?.properties.find((candidate) => candidate.posistion === position);
  return property && !property.mortgaged ? property : null;
}

/** A landing identity must change even when the same player revisits the same space. */
export function landingPresentationKey(pendingLanding: PendingLanding, turnRevision: number): string | null {
  return pendingLanding ? `${turnRevision}:${pendingLanding.playerId}:${pendingLanding.position}` : null;
}

export function compareBalances(previous: Record<string, number> | null, players: PlayerBalance[]) {
  const current: Record<string, number> = {};
  const changes: BalanceChange[] = [];
  for (const player of players) {
    current[player.id] = player.balance;
    const before = previous?.[player.id];
    if (before !== undefined && before !== player.balance) changes.push({ playerId: player.id, amount: player.balance - before });
  }
  return { current, changes };
}

const groupSizes = boardSpaces.reduce<Record<string, number>>((sizes, space) => {
  sizes[space.group] = (sizes[space.group] ?? 0) + 1;
  return sizes;
}, {});
const houseCostByPosition = new Map(boardSpaces.map((space) => [space.posistion, space.housecost ?? 0]));
const level = (count: number | "h") => (count === "h" ? 5 : count);

export type ActionAvailability = { allowed: boolean; reason?: string };

/**
 * Why building here is or is not possible. The engine rejects an ineligible
 * build, so an always-enabled button meant the only way to learn a rule was to
 * click and read an error. This lets the button explain itself up front.
 */
export function buildAvailability(game: GameSnapshot, playerId: string, position: number): ActionAvailability {
  const player = game.players.find((candidate) => candidate.id === playerId);
  const property = player?.properties.find((candidate) => candidate.posistion === position);
  const space = boardSpaces.find((candidate) => candidate.posistion === position);
  if (!player || !property || !space) return { allowed: false, reason: "You do not own this property" };
  if (!isStreetGroup(space.group)) return { allowed: false, reason: "Only streets can be developed" };
  const owned = player.properties.filter((candidate) => candidate.group === property.group);
  if (owned.length !== (groupSizes[property.group] ?? 0)) return { allowed: false, reason: `You need the complete ${property.group} set to build` };
  if (owned.some((candidate) => candidate.mortgaged)) return { allowed: false, reason: "Redeem the mortgaged property in this set first" };
  const current = level(property.count);
  if (current >= 5) return { allowed: false, reason: "Already developed with a hotel" };
  if (current !== Math.min(...owned.map((candidate) => level(candidate.count)))) return { allowed: false, reason: "Build evenly: develop the rest of the set first" };
  const cost = houseCostByPosition.get(position) ?? 0;
  if (player.balance < cost) return { allowed: false, reason: `You need £${cost} to build here` };
  if (current === 4) {
    if (game.bankSupply.hotels < 1) return { allowed: false, reason: "The bank has no hotels left" };
  } else if (game.bankSupply.houses < 1) return { allowed: false, reason: "The bank has no houses left" };
  return { allowed: true };
}

/** Mirror of buildAvailability for selling, which is bound by the same even-development rule. */
export function sellAvailability(game: GameSnapshot, playerId: string, position: number): ActionAvailability {
  const player = game.players.find((candidate) => candidate.id === playerId);
  const property = player?.properties.find((candidate) => candidate.posistion === position);
  const space = boardSpaces.find((candidate) => candidate.posistion === position);
  if (!player || !property || !space) return { allowed: false, reason: "You do not own this property" };
  if (!isStreetGroup(space.group)) return { allowed: false, reason: "Only streets can be developed" };
  const current = level(property.count);
  if (current === 0) return { allowed: false, reason: "Nothing built here" };
  const owned = player.properties.filter((candidate) => candidate.group === property.group);
  if (current !== Math.max(...owned.map((candidate) => level(candidate.count)))) return { allowed: false, reason: "Sell evenly: take from the most developed property first" };
  if (property.count === "h" && game.bankSupply.houses < 4) return { allowed: false, reason: "The bank cannot exchange this hotel for four houses" };
  return { allowed: true };
}

/**
 * The engine rejects an unaffordable purchase, so the deed's Buy button should
 * say so rather than letting the player click into an error. Auction stays open:
 * declining is always legal, and is the only route when the cash is not there.
 */
export function purchaseAvailability(game: GameSnapshot, playerId: string, position: number): ActionAvailability {
  const player = game.players.find((candidate) => candidate.id === playerId);
  const space = boardSpaces.find((candidate) => candidate.posistion === position);
  if (!player || !space || space.price === undefined) return { allowed: false, reason: "This space cannot be bought" };
  if (player.balance < space.price) return { allowed: false, reason: `You need £${space.price} to buy this — auction it instead` };
  return { allowed: true };
}

export type DevelopmentIntent = "build" | "sell";
export type DevelopmentConfirmation = {
  position: number;
  intent: DevelopmentIntent;
  /** Printed house cost for this row: 50, 100, 150 or 200. */
  houseCost: number;
  /** Charged on a build, refunded on a sale — a sale always returns half. */
  amount: number;
  hotel: boolean;
};

/**
 * Re-checks a build or sell against the live snapshot, mirroring
 * `mortgageConfirmationProperty`, so a confirmation cannot outlive the state
 * that made it legal.
 */
export function developmentConfirmation(game: GameSnapshot, playerId: string, position: number, intent: DevelopmentIntent, presentationBlocking: boolean): DevelopmentConfirmation | null {
  if (!canRaiseCash(game, playerId, presentationBlocking)) return null;
  // Building spends money, so it is not available while settling a debt.
  if (intent === "build" && isSettlingPlayer(game, playerId)) return null;
  const availability = intent === "build" ? buildAvailability(game, playerId, position) : sellAvailability(game, playerId, position);
  if (!availability.allowed) return null;
  const property = game.players.find((candidate) => candidate.id === playerId)?.properties.find((candidate) => candidate.posistion === position);
  if (!property) return null;
  const houseCost = houseCostByPosition.get(position) ?? 0;
  return {
    position,
    intent,
    houseCost,
    amount: intent === "build" ? houseCost : Math.floor(houseCost / 2),
    // A build at four houses produces the hotel; a sale at "h" removes one.
    hotel: intent === "build" ? level(property.count) === 4 : property.count === "h",
  };
}

/**
 * Why mortgaging or redeeming is unavailable. Official rules forbid mortgaging
 * while any property in the colour group carries buildings, so the button should
 * say that rather than rejecting the click.
 */
export function mortgageAvailability(game: GameSnapshot, playerId: string, position: number): ActionAvailability {
  const player = game.players.find((candidate) => candidate.id === playerId);
  const property = player?.properties.find((candidate) => candidate.posistion === position);
  const space = boardSpaces.find((candidate) => candidate.posistion === position);
  if (!player || !property || !space || space.price === undefined) return { allowed: false, reason: "You do not own this property" };
  if (!game.selectedMode.mortageAllowed && !isSettlingPlayer(game, playerId)) return { allowed: false, reason: "Mortgages are disabled in this mode" };
  const value = Math.floor(space.price / 2);
  if (property.mortgaged) {
    const cost = value + Math.ceil(value / 10);
    return player.balance < cost ? { allowed: false, reason: `You need £${cost} to redeem this` } : { allowed: true };
  }
  const owned = player.properties.filter((candidate) => candidate.group === property.group);
  if (owned.some((candidate) => level(candidate.count) > 0)) return { allowed: false, reason: `Sell the buildings in the ${property.group} set first` };
  return { allowed: true };
}
