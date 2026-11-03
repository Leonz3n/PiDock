import { expect, it } from "vitest";
import { availableReasoningLevels, defaultThinkingLevel, resolveThinkingLevel, supportsThinkingOff } from "./provider-capability.js";

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
  // A requested level the model does not declare is clamped to the declared
  // default, and says so.
  expect(resolveThinkingLevel(row, "off")).toEqual({ ok: true, level: "high", clamped: true });
  expect(resolveThinkingLevel(row, "max")).toEqual({ ok: true, level: "high", clamped: true });
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
  expect(defaultThinkingLevel(row)).toBeNull();
  expect(resolveThinkingLevel(row, "off")).toMatchObject({ ok: false, error: { code: "thinking-unsupported" } });
});

it("defaults to the declared `high` tier instead of the weakest one", () => {
  // W9: an unrequested level must not silently be `minimal` for a model that
  // declares `high` — the whole point of the default is that a turn runs at the
  // level S03B names.
  expect(resolveThinkingLevel({ id: "m", reasoning: true }, undefined)).toEqual({ ok: true, level: "high", clamped: false });
  expect(defaultThinkingLevel({ id: "m", reasoning: true })).toBe("high");
  // A model that does not declare `high` defaults to its strongest declared
  // tier, never to `off` and never to the weakest.
  const narrow = { id: "narrow", reasoning: true, thinkingLevelMap: { off: null, medium: null, high: null } };
  expect(defaultThinkingLevel(narrow)).toBe("low");
  expect(resolveThinkingLevel(narrow, undefined)).toEqual({ ok: true, level: "low", clamped: false });
  // A non-reasoning model still runs with thinking off.
  expect(defaultThinkingLevel({ id: "chat", reasoning: false })).toBe("off");
  // An explicit garbage value is still clamped, and still reported as such.
  expect(resolveThinkingLevel({ id: "m", reasoning: true }, "not-a-tier")).toEqual({ ok: true, level: "high", clamped: true });
});
