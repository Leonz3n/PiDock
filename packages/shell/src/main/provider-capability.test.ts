import { expect, it } from "vitest";
import { availableReasoningLevels, resolveThinkingLevel, supportsThinkingOff } from "./provider-capability.js";

it("offers exactly `off` for a model that does not declare reasoning", () => {
  expect(availableReasoningLevels({ id: "deepseek-chat", reasoning: false })).toEqual(["off"]);
  expect(supportsThinkingOff({ id: "deepseek-chat", reasoning: false })).toBe(true);
  expect(resolveThinkingLevel({ id: "deepseek-chat", reasoning: false }, "high")).toEqual({ ok: true, level: "off", clamped: true });
  expect(resolveThinkingLevel({ id: "deepseek-chat", reasoning: false }, "off")).toEqual({ ok: true, level: "off", clamped: false });
});

it("offers the canonical tiers for a reasoning model without a declared map", () => {
  expect(availableReasoningLevels({ id: "deepseek-reasoner", reasoning: true })).toEqual([
    "off", "minimal", "low", "medium", "high",
  ]);
  expect(resolveThinkingLevel({ id: "deepseek-reasoner", reasoning: true }, "high")).toEqual({ ok: true, level: "high", clamped: false });
});

it("removes a level the declared map marks unsupported", () => {
  const row = {
    id: "reasoner",
    reasoning: true,
    // `null` marks a level unsupported; the JSON shape mirrors models.json.
    thinkingLevelMap: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high" },
  };
  expect(availableReasoningLevels(row)).toEqual(["minimal", "low", "medium", "high"]);
  expect(supportsThinkingOff(row)).toBe(false);
  // A requested level the model does not declare is clamped, and says so.
  expect(resolveThinkingLevel(row, "off")).toEqual({ ok: true, level: "minimal", clamped: true });
  expect(resolveThinkingLevel(row, "max")).toEqual({ ok: true, level: "minimal", clamped: true });
});

it("offers xhigh/max only when the map names them", () => {
  expect(availableReasoningLevels({ id: "m", reasoning: true })).not.toContain("xhigh");
  expect(availableReasoningLevels({ id: "m", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } })).toEqual([
    "off", "minimal", "low", "medium", "high", "xhigh", "max",
  ]);
});

it("reports a model that declares no usable level instead of pretending off", () => {
  const row = { id: "m", reasoning: true, thinkingLevelMap: Object.fromEntries(["off", "minimal", "low", "medium", "high"].map((tier) => [tier, null])) };
  expect(availableReasoningLevels(row)).toEqual([]);
  expect(resolveThinkingLevel(row, "off")).toMatchObject({ ok: false, error: { code: "thinking-unsupported" } });
});

it("treats an undefined session preference as an unclamped default", () => {
  expect(resolveThinkingLevel({ id: "m", reasoning: true }, undefined)).toEqual({ ok: true, level: "minimal", clamped: true });
  expect(resolveThinkingLevel({ id: "m", reasoning: true }, "not-a-tier")).toMatchObject({ ok: true, clamped: true });
});
