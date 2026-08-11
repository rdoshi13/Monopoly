import type { GameSnapshot } from "@monopoly/game-engine";

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
