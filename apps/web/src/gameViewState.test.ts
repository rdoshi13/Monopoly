import { describe, expect, it } from "vitest";
import type { GameSnapshot } from "@monopoly/game-engine";
import { compareBalances, landingPresentationKey, mortgageConfirmationProperty } from "./gameViewState";

const mortgageGame = {
  currentPlayerId: "alice",
  phase: "awaiting-roll",
  pausedPlayerId: null,
  selectedMode: { mortageAllowed: true },
  players: [
    { id: "alice", properties: [{ posistion: 5, mortgaged: false }] },
    { id: "bob", properties: [{ posistion: 15, mortgaged: false }] },
  ],
} as GameSnapshot;

describe("landingPresentationKey", () => {
  it("distinguishes revisits by the same player to the same position", () => {
    const landing = { playerId: "alice", position: 6 };
    expect(landingPresentationKey(landing, 10)).not.toBe(landingPresentationKey(landing, 11));
    expect(landingPresentationKey(null, 11)).toBeNull();
  });
});

describe("compareBalances", () => {
  it("reports gains and losses without treating the initial snapshot as a change", () => {
    const initial = compareBalances(null, [{ id: "alice", balance: 1500 }, { id: "bob", balance: 1500 }]);
    expect(initial.changes).toEqual([]);
    expect(compareBalances(initial.current, [{ id: "alice", balance: 1350 }, { id: "bob", balance: 1650 }]).changes).toEqual([
      { playerId: "alice", amount: -150 },
      { playerId: "bob", amount: 150 },
    ]);
  });
});

describe("mortgageConfirmationProperty", () => {
  it("requires live ownership, turn, phase, mode, mortgage status, and presentation eligibility", () => {
    expect(mortgageConfirmationProperty(mortgageGame, "alice", 5, false)?.posistion).toBe(5);
    expect(mortgageConfirmationProperty({ ...mortgageGame, currentPlayerId: "bob" }, "alice", 5, false)).toBeNull();
    expect(mortgageConfirmationProperty({ ...mortgageGame, pausedPlayerId: "alice" }, "alice", 5, false)).toBeNull();
    expect(mortgageConfirmationProperty({ ...mortgageGame, phase: "awaiting-landing" }, "alice", 5, false)).toBeNull();
    expect(mortgageConfirmationProperty({ ...mortgageGame, selectedMode: { ...mortgageGame.selectedMode, mortageAllowed: false } }, "alice", 5, false)).toBeNull();
    expect(mortgageConfirmationProperty(mortgageGame, "alice", 15, false)).toBeNull();
    expect(mortgageConfirmationProperty({ ...mortgageGame, players: [{ ...mortgageGame.players[0], properties: [{ ...mortgageGame.players[0].properties[0], mortgaged: true }] }, mortgageGame.players[1]] }, "alice", 5, false)).toBeNull();
    expect(mortgageConfirmationProperty(mortgageGame, "alice", 5, true)).toBeNull();
  });
});
