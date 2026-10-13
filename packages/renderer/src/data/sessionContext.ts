/**
 * [UI 对齐 S8c] #47 会话推理档位与上下文读数的渲染层契约。
 *
 * Both directions are existing Host capabilities, reached here through the
 * bridge functions that already carry them — no op, channel or Host semantic is
 * added by this module:
 *
 * - read: `sessionContextThroughShell` → `task/sessionContext`
 *   (`shell/src/host/host.ts:1757` → `host/task-host.ts:2532` →
 *   `PiSessionContextView`, `shell/src/main/pi-session.ts:152`).
 * - write: `setSessionThinkingThroughShell` → `task/setSessionThinking`
 *   (`shell/src/host/host.ts:1793` → `host/task-host.ts:2501`).
 *
 * The parser is strict for the same reason `providerProfile.ts` is: a shape the
 * Host did not promise must fail here instead of reaching the composer as a
 * half-read control. `thinking`/`thinkingCatalog` are the Host's own resolution
 * (`resolveSessionThinking`, `shell/src/main/provider-config.ts:386`) — an empty
 * level means "no session preference", never a tier invented here.
 *
 * The write names only the session and the level. The production renderer holds
 * no provider catalog to send along (`providerOp list` answers `ProviderView`,
 * which carries no model `thinking` row), so which tiers a model declares stays
 * the Host's own validation: a level it does not declare comes back as the
 * Host's refusal text, which is what the composer shows.
 */

import { sessionContextThroughShell, setSessionThinkingThroughShell } from "./shellBridge";

/** Which reasoning tiers the Host resolved for the current model. */
export type ThinkingCatalog = "catalog-unknown" | "unsupported" | "declared";

/** The Host's own word for where an occupancy reading came from. */
export type SessionContextSource = "actual" | "estimated" | "pending" | "unknown";

const THINKING_CATALOGS: readonly ThinkingCatalog[] = ["catalog-unknown", "unsupported", "declared"];
const CONTEXT_SOURCES: readonly SessionContextSource[] = ["actual", "estimated", "pending", "unknown"];

/** The fields the composer reads out of `PiSessionContextView`. */
export interface SessionContextView {
  providerId: string;
  providerName: string | null;
  model: string;
  modelName: string | null;
  /** Window in k Tokens; `0` = unknown (`percent` is then `null`). */
  window: number;
  /** Occupancy in k Tokens. */
  used: number;
  source: SessionContextSource;
  /** Cumulative tokens this session consumed, as the Host counts them. */
  tokens: number;
  /** Occupancy ratio; `null` while the window is unknown. */
  percent: number | null;
  /** Effective reasoning tier; empty means no session preference. */
  thinking: string;
  thinkingCatalog: ThinkingCatalog;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Strict parse of main's `{context}` payload; a surprise throws instead of defaulting. */
export function parseSessionContext(payload: unknown): SessionContextView {
  const context = object(payload) ? payload["context"] : undefined;
  if (!object(context)) throw new Error("Host 会话读数返回异常");
  const record: Record<string, unknown> = context;
  const bad = () => new Error("Host 会话读数返回异常");
  const text = (key: string): string => {
    const value = record[key];
    if (typeof value !== "string") throw bad();
    return value;
  };
  const optionalText = (key: string): string | null => {
    const value = record[key];
    if (value === null) return null;
    if (typeof value !== "string") throw bad();
    return value;
  };
  const count = (key: string): number => {
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw bad();
    return value;
  };
  const optionalRatio = (key: string): number | null => {
    const value = record[key];
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) throw bad();
    return value;
  };
  if (!(THINKING_CATALOGS as readonly string[]).includes(String(record["thinkingCatalog"]))) throw bad();
  if (!(CONTEXT_SOURCES as readonly string[]).includes(String(record["source"]))) throw bad();
  return {
    providerId: text("providerId"),
    providerName: optionalText("providerName"),
    model: text("model"),
    modelName: optionalText("modelName"),
    window: count("window"),
    used: count("used"),
    source: record["source"] as SessionContextSource,
    tokens: count("tokens"),
    percent: optionalRatio("percent"),
    thinking: text("thinking"),
    thinkingCatalog: record["thinkingCatalog"] as ThinkingCatalog,
  };
}

/**
 * Either a Host-confirmed readout or the Host's own wording for why there is
 * none. A refusal is never turned into a value: `ok:false` carries the text the
 * UI must show instead of a level or a `0`.
 */
export type SessionContextResult = { ok: true; context: SessionContextView } | { ok: false; error: string };

function unwrap(result: { ok: boolean; payload?: unknown; error?: string }, fallback: string): SessionContextResult {
  if (!result.ok) return { ok: false, error: result.error && result.error.length > 0 ? result.error : fallback };
  try {
    return { ok: true, context: parseSessionContext(result.payload) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : fallback };
  }
}

/** Read the session's current reasoning tier + context readout. */
export async function readSessionContext(input: { taskId: string; sessionId: string }): Promise<SessionContextResult> {
  try {
    return unwrap(await sessionContextThroughShell(input), "Host 未返回会话读数");
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "会话读数请求失败" };
  }
}

/**
 * Select a reasoning tier for this session. The Host owns the decision (an
 * undeclared tier, an unsupported model and a refused clear all come back as its
 * error text); on success its post-write readout is the new state, not a guess.
 */
export async function writeSessionThinking(input: { taskId: string; sessionId: string; level: string }): Promise<SessionContextResult> {
  try {
    return unwrap(await setSessionThinkingThroughShell(input), "Host 未接受该推理档位");
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "推理档位写入失败" };
  }
}
