import { describe, expect, it } from "vitest";
import { appendBounded, truncateText } from "./bounded-buffer.js";

describe("bounded evidence helpers", () => {
  it("keeps only the newest bounded items", () => {
    const values: number[] = [];
    for (const value of [1, 2, 3, 4]) appendBounded(values, value, 3);
    expect(values).toEqual([2, 3, 4]);
  });

  it("truncates long text with a stable suffix", () => {
    expect(truncateText("a".repeat(20), 12)).toBe("aaaaaaaaa...");
  });

  it("leaves short text unchanged", () => {
    expect(truncateText("short", 12)).toBe("short");
  });
});
