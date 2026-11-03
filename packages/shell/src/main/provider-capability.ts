/**
 * Reasoning-level derivation for [PiDock T03] #138.
 *
 * The UI must only offer levels the *declared* model capability supports, and
 * `off` may appear only when the model (as declared) supports turning thinking
 * off. Rather than re-implementing Pi's rule, this module asks the pinned SDK
 * (`getSupportedThinkingLevels`, Pi 1.5.0) about a model object built from the
 * declared row. The result is therefore the same set the SDK would accept, and
 * the UI never invents a level the request cannot carry.
 *
 * This is a *declared* capability, not a provider probe: nothing here contacts
 * the endpoint or infers capability from a model id.
 */

import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { REASONING_TIERS, type ReasoningTier } from "./provider-protocol.js";

export interface DeclaredModel {
  id: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
}

/**
 * A minimal model object for the SDK's own level derivation. It is never sent
 * anywhere; only `reasoning` and `thinkingLevelMap` are read.
 */
function modelShape(row: DeclaredModel): Model<Api> {
  return {
    id: row.id,
    name: row.id,
    api: "openai-completions",
    provider: "pidock-capability",
    baseUrl: "http://127.0.0.1/",
    reasoning: row.reasoning,
    ...(row.thinkingLevelMap ? { thinkingLevelMap: row.thinkingLevelMap } : {}),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
  };
}

/** The levels the declared capability supports, in canonical order. */
export function availableReasoningLevels(row: DeclaredModel): ReasoningTier[] {
  const supported = getSupportedThinkingLevels(modelShape(row)) as readonly string[];
  const levels = REASONING_TIERS.filter((tier) => supported.includes(tier));
  // A reasoning model whose declared map disables every tier has no selectable
  // level at all; it must not silently become "off".
  return levels;
}

export type LevelResolution =
  | { ok: true; level: ReasoningTier; clamped: boolean }
  | { ok: false; error: { code: "thinking-unsupported" | "thinking-level-not-declared"; message: string } };

/**
 * Resolve a requested level against the declared capability. An unsupported
 * request is clamped to the closest declared level (`off` for a non-reasoning
 * model) and reported as clamped, so a stale session preference cannot make the
 * request carry a level the endpoint was never declared to accept.
 */
export function resolveThinkingLevel(row: DeclaredModel, requested: unknown): LevelResolution {
  const levels = availableReasoningLevels(row);
  if (levels.length === 0) {
    return { ok: false, error: { code: "thinking-unsupported", message: "当前模型没有可用推理档位，也不能声明已关闭推理" } };
  }
  if (typeof requested === "string" && (levels as string[]).includes(requested)) {
    return { ok: true, level: requested as ReasoningTier, clamped: false };
  }
  if (!row.reasoning) {
    // "off" is supported exactly when the SDK lists it (a non-reasoning model).
    return levels.includes("off")
      ? { ok: true, level: "off", clamped: requested !== undefined }
      : { ok: false, error: { code: "thinking-unsupported", message: "当前模型不支持推理档位" } };
  }
  const fallback = levels.find((tier) => tier !== "off") ?? levels[0]!;
  return { ok: true, level: fallback, clamped: true };
}

/** True when the model declares that reasoning can be turned off. */
export function supportsThinkingOff(row: DeclaredModel): boolean {
  return availableReasoningLevels(row).includes("off");
}
