import { describe, expect, it } from "vitest";
import { isAllowedOrigin, parseWireMessage } from "./security.js";

describe("Worker request boundaries", () => {
  it("restricts production origins and permits local ports only for local configuration", () => {
    expect(isAllowedOrigin("https://monopoly.example.com", "https://monopoly.example.com")).toBe(true);
    expect(isAllowedOrigin("https://evil.example.com", "https://monopoly.example.com")).toBe(false);
    expect(isAllowedOrigin("http://localhost:4173", "https://monopoly.example.com")).toBe(false);
    expect(isAllowedOrigin("http://localhost:4173", "http://localhost:5173")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:4173", "http://localhost:5173")).toBe(true);
  });

  it("rejects malformed and non-object WebSocket messages", () => {
    expect(parseWireMessage("null")).toBeNull();
    expect(parseWireMessage("[]")).toBeNull();
    expect(parseWireMessage("{\"payload\":1}")).toBeNull();
    expect(parseWireMessage("not json")).toBeNull();
    expect(parseWireMessage('{"event":"game:action","payload":{"type":"roll"}}')).toEqual({ event: "game:action", payload: { type: "roll" } });
  });
});
