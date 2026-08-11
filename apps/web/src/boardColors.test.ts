import { describe, expect, it } from "vitest";
import { groupColors, inkOn } from "./boardColors";

describe("inkOn", () => {
  it("selects the higher-contrast ink for every street group", () => {
    expect(Object.fromEntries(Object.entries(groupColors).map(([group, color]) => [group, inkOn(color)]))).toEqual({
      Brown: "#ffffff",
      "Light Blue": "#15180f",
      Pink: "#15180f",
      Orange: "#15180f",
      Red: "#ffffff",
      Yellow: "#15180f",
      Green: "#15180f",
      "Dark Blue": "#ffffff",
    });
  });
});
