import { describe, expect, it } from "vitest";
import { isCardPresentationForPlayer, type PlayerPresentation } from "./presentationQueue";

const dice = (playerId: string): PlayerPresentation => ({ kind: "dice", result: { playerId } });
const card = (playerId: string): PlayerPresentation => ({ kind: "card", result: { playerId } });

function ingest(localPlayerId: string, events: PlayerPresentation[]) {
  return events.reduce((queue, event) => event.kind === "card" && !isCardPresentationForPlayer(event.result.playerId, localPlayerId)
    ? queue
    : [...queue, event], [] as PlayerPresentation[]);
}

describe("isCardPresentationForPlayer", () => {
  it("keeps the drawer's dice-card-dice sequence but omits the interactive card for other players", () => {
    const compoundSequence = [dice("alice"), card("alice"), dice("alice")];

    expect(ingest("alice", compoundSequence).map((event) => event.kind)).toEqual(["dice", "card", "dice"]);
    expect(ingest("bob", compoundSequence).map((event) => event.kind)).toEqual(["dice", "dice"]);
  });

  it("continues to synchronize ordinary dice presentations", () => {
    expect(ingest("bob", [dice("alice")])).toEqual([dice("alice")]);
  });
});
