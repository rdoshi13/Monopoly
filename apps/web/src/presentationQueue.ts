export type PlayerPresentation = { kind: "dice" | "card"; result: { playerId: string } };

export function isCardPresentationForPlayer(eventPlayerId: string, localPlayerId: string): boolean {
  return eventPlayerId === localPlayerId;
}
