import { describe, expect, it } from "vitest";
import { matchingSalaryPresentationId, parseSalaryPresentation, readySalaryPresentations, removeSalaryPresentation } from "./salaryPresentation";

const aliceSalary = { type: "salary", playerId: "alice", amount: 200, fromPosition: 39, position: 1, reason: "passed" };

describe("salary presentation ingestion", () => {
  it("accepts a public typed salary for any credited player and rejects malformed payloads", () => {
    expect(parseSalaryPresentation(aliceSalary, 7)).toEqual({ id: 7, playerId: "alice", amount: 200, fromPosition: 39, position: 1, reason: "passed" });
    expect(parseSalaryPresentation({ ...aliceSalary, amount: 400 }, 8)).toBeNull();
    expect(parseSalaryPresentation({ ...aliceSalary, position: 40 }, 9)).toBeNull();
  });

  it("suppresses one matching generic +£200 delta and expires only the completed animation", () => {
    const alice = parseSalaryPresentation(aliceSalary, 7)!;
    const bob = parseSalaryPresentation({ ...aliceSalary, playerId: "bob" }, 8)!;
    const events = [alice, bob];

    expect(matchingSalaryPresentationId("alice", 200, events, new Set())).toBe(7);
    expect(matchingSalaryPresentationId("alice", 200, events, new Set([7]))).toBeNull();
    expect(matchingSalaryPresentationId("alice", 150, events, new Set())).toBeNull();
    expect(readySalaryPresentations(events, new Set(["alice"]))).toEqual([bob]);
    expect(removeSalaryPresentation(events, 7)).toEqual([bob]);
  });
});
