import { describe, expect, it } from "vitest";
import { compareBalances, landingPresentationKey } from "./gameViewState";

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
