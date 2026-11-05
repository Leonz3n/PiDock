/**
 * Per-session model / reasoning switching ([Pencil T04] #139).
 *
 * A session's model binding is its **identity**: switching the model must keep
 * the same transcript, use the new model for the turns that follow and record
 * the new binding — or be refused by name. This module owns that decision so it
 * can be tested without a live Host, a worker or a Provider, and so there is
 * exactly one order of refusals:
 *
 *   1. `session-unknown` / `session-archived` — the session must be a real,
 *      unarchived session of this task (the caller's read, never a guess);
 *   2. `provider-not-configured` — no installed Provider means no model to bind;
 *   3. `sdk-model-unknown` — the target must be one of the profile's *declared*
 *      model rows; a session cannot name a model the credential cannot reach;
 *   4. `sdk-session-busy` — a turn in flight (per session, and the SDK kernel is
 *      single-turn per task) is waited for by the USER, never by the Host: no
 *      queueing, no switching a model under a running turn;
 *   5. `sdk-context-over-limit` — the session's stored context is larger than
 *      the target model's declared window: refused, never compacted/truncated;
 *   6. `sdk-context-occupancy-unknown` — history exists but the SDK reported no
 *      usable occupancy, so "does it fit" cannot be answered: refused, because
 *      guessing either way would be a silent compaction or a silent pass;
 *   7. `sdk-reasoning-unsupported` — an explicitly requested level the target
 *      model does not declare.
 *
 * Only then is anything written, and the writes are ordered so the two records
 * (the session's own index and the isolated kernel) cannot disagree: the index
 * first, the kernel second, and a kernel refusal rolls the index back.
 */

import { availableReasoningLevels } from "./explicit-text-provider.js";
import type { SessionBinding, SessionThinkingLevel } from "./session-index.js";

export interface SwitchModelRow {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
}

export interface SwitchProvider {
  profileId: string;
  generation: number;
  models: readonly SwitchModelRow[];
}

export interface SwitchSession {
  id: string;
  archived: boolean;
  binding: SessionBinding | null;
}

export interface SwitchDigest {
  /** Committed assistant replies in this session's own transcript. */
  turns: number;
  /** The last request's prompt size; `null` = the SDK reported nothing. */
  contextUsed: number | null;
}

/**
 * Everything the switch needs from the Host, as data. Each port is a read or a
 * write the Host already owns; the policy below never reaches further.
 */
export interface SessionSwitchPorts {
  provider(): SwitchProvider | null;
  session(sessionId: string): SwitchSession;
  busy(sessionId: string): boolean;
  digest(sessionId: string): SwitchDigest;
  /** Persist the session's own binding; returns the stored value. */
  persist(binding: SessionBinding): void;
  /** Ask the isolated kernel to bind the live session (may refuse). */
  bind(sessionId: string, binding: { modelId: string; thinkingLevel?: SessionThinkingLevel }): Promise<{ modelId: string; thinkingLevel: string }>;
  /** Undo `persist` when the kernel refused; must itself be durable-or-throw. */
  rollback(): void;
}

export interface SessionSwitchResult {
  sessionId: string;
  binding: SessionBinding;
  /** The level the SDK will actually run with (it clamps what a model cannot take). */
  effectiveThinkingLevel: SessionThinkingLevel | null;
  changed: boolean;
}

export const SESSION_THINKING_ORDER: readonly SessionThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The declared default level of a row: `off` when the model declares it, else its first level. */
export function defaultThinkingLevel(row: SwitchModelRow): SessionThinkingLevel | null {
  const levels = availableReasoningLevels(row);
  if (levels.length === 0) return null;
  return levels.includes("off") ? "off" : levels[0]!;
}

/**
 * Switch one session to `modelId`, and optionally to `thinkingLevel`.
 *
 * `undefined` = "keep this session's current level when the new model declares
 * it, otherwise use the new model's default"; `null` = "this model declares no
 * reasoning level" (only meaningful for a model without reasoning).
 */
export async function switchSessionModel(
  ports: SessionSwitchPorts,
  input: { sessionId: string; modelId: string; profileId?: string; thinkingLevel?: SessionThinkingLevel | null },
): Promise<SessionSwitchResult> {
  const session = ports.session(input.sessionId);
  if (session.archived) throw new Error("session-archived");
  const provider = ports.provider();
  if (!provider) throw new Error("provider-not-configured");
  // [#167] A model id is only unique inside its profile. The caller may name
  // the profile explicitly; a pair whose profile main did not install is
  // refused by name instead of binding the same id under another profile.
  if (input.profileId !== undefined && input.profileId !== provider.profileId) {
    throw new Error(`provider-profile-mismatch: ${input.modelId} 属于 ${input.profileId}，但当前安装的是 ${provider.profileId}`);
  }
  const row = provider.models.find((model) => model.id === input.modelId);
  if (!row) throw new Error(`sdk-model-unknown: ${input.modelId} 不在当前 Provider 声明的模型列表中`);
  if (ports.busy(input.sessionId)) throw new Error("sdk-session-busy: 本会话有回合正在执行，请等待其结束或先停止");

  const digest = ports.digest(input.sessionId);
  if (digest.contextUsed !== null && digest.contextUsed > row.contextWindow) {
    throw new Error(`sdk-context-over-limit: 本会话已用上下文 ${digest.contextUsed} tokens，超过 ${row.id} 声明的 ${row.contextWindow} tokens 窗口`);
  }
  if (digest.contextUsed === null && digest.turns > 0) {
    throw new Error(`sdk-context-occupancy-unknown: 本会话已有 ${digest.turns} 条回复但 SDK 未报告上下文占用，无法判定是否超过 ${row.id} 的窗口`);
  }

  const levels = availableReasoningLevels(row);
  if (input.thinkingLevel !== undefined && input.thinkingLevel !== null && !levels.includes(input.thinkingLevel)) {
    throw new Error(`sdk-reasoning-unsupported: ${row.id} 未声明推理档位 ${input.thinkingLevel}`);
  }
  const requested = input.thinkingLevel === null ? null
    : input.thinkingLevel ?? (session.binding?.thinkingLevel && levels.includes(session.binding.thinkingLevel) ? session.binding.thinkingLevel : defaultThinkingLevel(row));

  const binding: SessionBinding = {
    profileId: provider.profileId,
    modelId: row.id,
    thinkingLevel: requested !== null && levels.includes(requested) ? requested : null,
    generation: provider.generation,
  };
  ports.persist(binding);
  let bound: { modelId: string; thinkingLevel: string };
  try {
    bound = await ports.bind(input.sessionId, {
      modelId: row.id,
      ...(binding.thinkingLevel === null ? {} : { thinkingLevel: binding.thinkingLevel }),
    });
  } catch (error) {
    try { ports.rollback(); }
    catch { throw new Error("session-binding-uncommitted"); }
    throw error;
  }
  // The SDK clamps; report and store what it will actually run with, so the
  // control never shows a level the model will not honour. A model that declares
  // no reasoning level keeps `null`: the SDK's `off` there is not a choice.
  const effective = levels.length === 0 ? null
    : (SESSION_THINKING_ORDER as readonly string[]).includes(bound.thinkingLevel)
      ? bound.thinkingLevel as SessionThinkingLevel : null;
  const stored = effective === binding.thinkingLevel ? binding : { ...binding, thinkingLevel: effective };
  if (effective !== binding.thinkingLevel) ports.persist(stored);
  return {
    sessionId: input.sessionId,
    binding: stored,
    effectiveThinkingLevel: effective,
    changed: session.binding?.modelId !== stored.modelId || session.binding?.thinkingLevel !== stored.thinkingLevel ||
      session.binding?.generation !== stored.generation || session.binding?.profileId !== stored.profileId,
  };
}
