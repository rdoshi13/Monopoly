export const DISCONNECT_GRACE_MS = 30_000;
export const EMPTY_ROOM_MS = 600_000;

export interface SchedulableRoom {
  players: Array<{ connected: boolean }>;
  lastEmptyAt: number | null;
  disconnectedAt?: Record<string, number>;
  turnDeadline?: number | null;
}

/**
 * The earliest moment a room needs attention, or null when nothing is pending.
 *
 * Returning null is the point: the Durable Object previously rearmed a 30s alarm
 * from every persist, and its own alarm handler persisted again, so a room woke
 * up forever even with no players and nothing to do.
 */
export function nextWakeup(room: SchedulableRoom): number | null {
  const candidates: number[] = [];
  if (typeof room.turnDeadline === "number") candidates.push(room.turnDeadline);
  for (const disconnectedAt of Object.values(room.disconnectedAt ?? {})) candidates.push(disconnectedAt + DISCONNECT_GRACE_MS);
  if (room.lastEmptyAt && !room.players.some((player) => player.connected)) candidates.push(room.lastEmptyAt + EMPTY_ROOM_MS);
  return candidates.length ? Math.min(...candidates) : null;
}
