import type { GameSnapshot } from "@monopoly/game-engine";

type PendingLanding = GameSnapshot["pendingLanding"];
type PlayerBalance = Pick<GameSnapshot["players"][number], "id" | "balance">;

export type BalanceChange = { playerId: string; amount: number };

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
