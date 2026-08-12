import { describe, expect, it } from "vitest";
import type { GameSnapshot } from "@monopoly/game-engine";
import { buildAvailability, compareBalances, landingPresentationKey, mortgageConfirmationProperty, purchaseAvailability, sellAvailability } from "./gameViewState";

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

describe("development availability", () => {
  const snapshot = (players: unknown, bank = { houses: 32, hotels: 12 }) => ({ players, bankSupply: bank } as unknown as Parameters<typeof buildAvailability>[0]);
  const brown = (count: number | "h", mortgaged = false) => ({ posistion: 1, count, group: "Brown", mortgaged });
  const brown3 = (count: number | "h", mortgaged = false) => ({ posistion: 3, count, group: "Brown", mortgaged });

  it("blocks building on an incomplete colour group", () => {
    const game = snapshot([{ id: "a", balance: 1000, properties: [brown(0)] }]);
    expect(buildAvailability(game, "a", 1)).toEqual({ allowed: false, reason: "You need the complete Brown set to build" });
  });

  it("blocks building on a station", () => {
    const game = snapshot([{ id: "a", balance: 1000, properties: [{ posistion: 5, count: 0, group: "Railroad", mortgaged: false }] }]);
    expect(buildAvailability(game, "a", 5).allowed).toBe(false);
  });

  it("allows building on a complete group and then enforces even development", () => {
    const complete = snapshot([{ id: "a", balance: 1000, properties: [brown(0), brown3(0)] }]);
    expect(buildAvailability(complete, "a", 1)).toEqual({ allowed: true });
    const uneven = snapshot([{ id: "a", balance: 1000, properties: [brown(1), brown3(0)] }]);
    expect(buildAvailability(uneven, "a", 1)).toEqual({ allowed: false, reason: "Build evenly: develop the rest of the set first" });
    expect(buildAvailability(uneven, "a", 3)).toEqual({ allowed: true });
  });

  it("blocks building without the cash or bank stock", () => {
    expect(buildAvailability(snapshot([{ id: "a", balance: 10, properties: [brown(0), brown3(0)] }]), "a", 1))
      .toEqual({ allowed: false, reason: "You need £50 to build here" });
    expect(buildAvailability(snapshot([{ id: "a", balance: 1000, properties: [brown(0), brown3(0)] }], { houses: 0, hotels: 12 }), "a", 1))
      .toEqual({ allowed: false, reason: "The bank has no houses left" });
  });

  it("blocks a mortgaged set and a completed hotel", () => {
    expect(buildAvailability(snapshot([{ id: "a", balance: 1000, properties: [brown(0), brown3(0, true)] }]), "a", 1).reason).toMatch(/Redeem/);
    expect(buildAvailability(snapshot([{ id: "a", balance: 1000, properties: [brown("h"), brown3("h")] }]), "a", 1).reason).toMatch(/hotel/);
  });

  it("only sells from the most developed property in the set", () => {
    const game = snapshot([{ id: "a", balance: 1000, properties: [brown(2), brown3(1)] }]);
    expect(sellAvailability(game, "a", 1)).toEqual({ allowed: true });
    expect(sellAvailability(game, "a", 3)).toEqual({ allowed: false, reason: "Sell evenly: take from the most developed property first" });
    expect(sellAvailability(snapshot([{ id: "a", balance: 1, properties: [brown(0)] }]), "a", 1).reason).toBe("Nothing built here");
  });
});

describe("purchase availability", () => {
  const game = (balance: number) => ({ players: [{ id: "a", balance, properties: [] }], bankSupply: { houses: 32, hotels: 12 } } as unknown as Parameters<typeof purchaseAvailability>[0]);

  it("allows a purchase the player can afford", () => {
    // Old Kent Road is £60.
    expect(purchaseAvailability(game(60), "a", 1)).toEqual({ allowed: true });
  });

  it("blocks a purchase the player cannot afford and points at the auction", () => {
    expect(purchaseAvailability(game(59), "a", 1)).toEqual({ allowed: false, reason: "You need £60 to buy this — auction it instead" });
    // Fenchurch St. Station is £200 — the case seen with £40 in hand.
    expect(purchaseAvailability(game(40), "a", 25)).toEqual({ allowed: false, reason: "You need £200 to buy this — auction it instead" });
  });

  it("blocks spaces that are not for sale", () => {
    expect(purchaseAvailability(game(1000), "a", 20).allowed).toBe(false);
  });
});
