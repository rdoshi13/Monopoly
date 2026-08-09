import { describe, expect, it } from "vitest";
import { DISCONNECT_GRACE_MS, EMPTY_ROOM_MS, nextWakeup } from "./scheduling.js";

const now = 1_000_000;
const connected = [{ connected: true }];
const empty = [{ connected: false }];

describe("Durable Object alarm scheduling", () => {
  it("schedules nothing for an idle room so it stops waking up", () => {
    expect(nextWakeup({ players: connected, lastEmptyAt: null })).toBeNull();
    expect(nextWakeup({ players: connected, lastEmptyAt: null, disconnectedAt: {}, turnDeadline: null })).toBeNull();
  });

  it("wakes for the soonest pending deadline", () => {
    expect(nextWakeup({ players: connected, lastEmptyAt: null, turnDeadline: now })).toBe(now);
    expect(nextWakeup({ players: connected, lastEmptyAt: null, disconnectedAt: { a: now } })).toBe(now + DISCONNECT_GRACE_MS);
    expect(nextWakeup({ players: empty, lastEmptyAt: now })).toBe(now + EMPTY_ROOM_MS);
    expect(nextWakeup({
      players: empty,
      lastEmptyAt: now,
      disconnectedAt: { a: now, b: now - 5_000 },
      turnDeadline: now + EMPTY_ROOM_MS + 1,
    })).toBe(now - 5_000 + DISCONNECT_GRACE_MS);
  });

  it("ignores an empty-room prune while anyone is still connected", () => {
    expect(nextWakeup({ players: connected, lastEmptyAt: now })).toBeNull();
  });
});
