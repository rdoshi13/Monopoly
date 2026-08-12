import { boardSpaces, type GameSnapshot } from "@monopoly/game-engine";
import { isStreetGroup } from "./boardColors";

type PendingLanding = GameSnapshot["pendingLanding"];
type PlayerBalance = Pick<GameSnapshot["players"][number], "id" | "balance">;

export type BalanceChange = { playerId: string; amount: number };

/** Mortgage confirmation is valid only while the authoritative snapshot still permits it. */
export function mortgageConfirmationProperty(game: GameSnapshot, playerId: string, position: number, presentationBlocking: boolean) {
  if (presentationBlocking || game.pausedPlayerId !== null || game.currentPlayerId !== playerId || game.phase !== "awaiting-roll" || !game.selectedMode.mortageAllowed) return null;
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
