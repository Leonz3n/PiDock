/**
 * [#139] The ONE reply shape for the task's session list — reads and writes.
 *
 * `task/sessionList` and every session write (`create|activate|rename|archive|
 * restore|delete`) answer with the same keys: `activeSessionId`, `sessions` and
 * `provider` (`task/sessionCreate` additionally names the created `session`).
 * Before this module the writes answered without `provider`; the renderer
 * replaced its whole list with that reply, so `parseSessionList` read
 * `provider: null` and the model menu went unusable after any session switch
 * until a remount (real-Electron evidence for #139).
 *
 * `provider` is a redacted app-level row: profile/model ids, the generation and
 * the declared model rows with the reasoning levels each one actually declares.
 * `null` means "no Provider installed" and is always an explicit key, never an
 * omitted one — a missing key would be indistinguishable from a lost field.
 */
import { availableReasoningLevels, type ExplicitTextProvider } from "./explicit-text-provider.js";
import type { SessionIndex, TaskSessionRecord } from "./session-index.js";

/** One declared model row, with the levels its own declaration makes available. */
export interface SessionProviderModelPayload {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  reasoningLevels: string[];
}

export interface SessionProviderPayload {
  profileId: string;
  modelId: string;
  generation: number;
  models: SessionProviderModelPayload[];
}

export interface SessionListPayload extends Record<string, unknown> {
  activeSessionId: string | null;
  sessions: TaskSessionRecord[];
  provider: SessionProviderPayload | null;
}

export interface SessionCreatedPayload extends SessionListPayload {
  session: TaskSessionRecord;
}

/** The installed Provider the Host reads (`TaskWorkspaceHost.sdkProviderConfig`). */
export type InstalledProvider = { config: ExplicitTextProvider; generation: number } | null;

function providerOf(installed: InstalledProvider): SessionProviderPayload | null {
  if (installed === null) return null;
  return {
    profileId: installed.config.profileId,
    modelId: installed.config.modelId,
    generation: installed.generation,
    models: installed.config.models.map((row) => ({
      id: row.id, name: row.name, contextWindow: row.contextWindow, maxTokens: row.maxTokens,
      reasoning: row.reasoning, reasoningLevels: availableReasoningLevels(row),
    })),
  };
}

/** The reply of `task/sessionList` and of every session mutation. */
export function sessionListPayload(index: SessionIndex, installed: InstalledProvider): SessionListPayload {
  return {
    activeSessionId: index.activeSessionId,
    sessions: index.sessions,
    provider: providerOf(installed),
  };
}

/** The reply of `task/sessionCreate`: the same list payload plus the new session. */
export function sessionCreatedPayload(
  created: { index: SessionIndex; session: TaskSessionRecord },
  installed: InstalledProvider,
): SessionCreatedPayload {
  return { session: created.session, ...sessionListPayload(created.index, installed) };
}
