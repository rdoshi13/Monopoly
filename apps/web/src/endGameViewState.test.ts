import { describe, expect, it } from "vitest";
import type { FinalStanding, GameSnapshot } from "@monopoly/game-engine";
import type { RoomState } from "@monopoly/shared-types";
import { NET_WORTH_TIE_RULE, acquireEndGameDispatch, canHostEndGame, standingPropertyValue } from "./endGameViewState";

describe("canHostEndGame", () => {
  const room = { hostPlayerId: "host" } as RoomState;

  it("shows the action only to the room host while the game is active", () => {
    expect(canHostEndGame(room, { phase: "awaiting-roll" } as GameSnapshot, "host")).toBe(true);
    expect(canHostEndGame(room, { phase: "awaiting-roll" } as GameSnapshot, "guest")).toBe(false);
    expect(canHostEndGame(room, { phase: "lobby" } as GameSnapshot, "host")).toBe(false);
    expect(canHostEndGame(room, { phase: "finished" } as GameSnapshot, "host")).toBe(false);
  });
});

describe("final standings presentation", () => {
  it("combines both property components while keeping the tie rule explicit", () => {
    const standing = { unmortgagedPropertyValue: 240, mortgagedPropertyValue: 100 } as FinalStanding;
    expect(standingPropertyValue(standing)).toBe(340);
    expect(NET_WORTH_TIE_RULE).toBe("Ties are resolved by higher cash, then original turn order.");
  });

  it("acquires a confirmation dispatch lock only once until it is reset", () => {
    const lock = { current: false };

    expect(acquireEndGameDispatch(lock)).toBe(true);
    expect(acquireEndGameDispatch(lock)).toBe(false);
    lock.current = false;
    expect(acquireEndGameDispatch(lock)).toBe(true);
  });
});
