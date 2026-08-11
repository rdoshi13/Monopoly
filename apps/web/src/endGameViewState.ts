import type { FinalStanding, GameSnapshot } from "@monopoly/game-engine";
import type { RoomState } from "@monopoly/shared-types";

export const NET_WORTH_RULE = "Cash + full purchase price of unmortgaged properties + mortgage value of mortgaged properties + full purchase cost of houses and hotels.";
export const NET_WORTH_TIE_RULE = "Ties are resolved by higher cash, then original turn order.";

export function canHostEndGame(room: Pick<RoomState, "hostPlayerId">, game: Pick<GameSnapshot, "phase">, playerId: string) {
  return room.hostPlayerId === playerId && game.phase !== "lobby" && game.phase !== "finished";
}

export function acquireEndGameDispatch(lock: { current: boolean }) {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function standingPropertyValue(standing: FinalStanding) {
  return standing.unmortgagedPropertyValue + standing.mortgagedPropertyValue;
}
