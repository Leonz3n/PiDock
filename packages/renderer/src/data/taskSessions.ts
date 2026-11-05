/**
 * 任务内多会话的渲染层契约（[Pencil T04] #139）。
 *
 * 一个任务只有一份工作区，但可以有多个真实会话。会话的**身份**（id、名称、
 * 是否归档、权限档位、模型/推理绑定）由 Host 的 `.pidock-sessions.json` 拥有；
 * 这一层只做两件事：把 Host 的回包解析成严格视图，和把用户的意图原样送回
 * `shell/taskOp`。
 *
 * 这里没有「默认新会话」「猜一个会话名」或「按 main 兜底」的代码：列表里没有
 * 的会话就是不存在（`session-unknown` 由 Host 拒绝），列表读不到时页面显示
 * 「未读取」而不是假装有会话。上下文占用与用量来自每个会话自己的 SDK JSONL
 * 读数：`null` = 未知，绝不当 0。
 */

import { shellTaskOp, type ShellTaskOpResult } from "./shellBridge";

export type SessionPermission = "read" | "default" | "auto";
export type SessionThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const SESSION_THINKING_LEVELS: readonly SessionThinkingLevel[] =
  ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const REASONING_LEVEL_TEXT: Record<string, string> = {
  off: "关闭", minimal: "最少", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高",
};

export type SessionBinding = { profileId: string; modelId: string; thinkingLevel: SessionThinkingLevel | null; generation: number };
export type TaskSession = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  permission: SessionPermission;
  binding: SessionBinding | null;
};
/** One declared model row of the installed Provider, with the levels it actually declares. */
export type SessionProviderModel = { id: string; name: string; contextWindow: number; maxTokens: number; reasoning: boolean; reasoningLevels: SessionThinkingLevel[] };
export type SessionProvider = { profileId: string; modelId: string; generation: number; models: SessionProviderModel[] };
export type SessionList = { activeSessionId: string | null; sessions: TaskSession[]; provider: SessionProvider | null };

export type SessionUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type SessionReadout = {
  session: TaskSession;
  active: boolean;
  model: { id: string; name: string; contextWindow: number; maxTokens: number; reasoning: boolean } | null;
  reasoningLevels: SessionThinkingLevel[];
  /**
   * `used` = the prompt size of this session's most recent request, `window` = the
   * bound model's declared window. Both `null` = unknown; `source` says which.
   */
  context: { used: number | null; window: number | null; source: "sdk-usage" | "unknown" };
  usage: SessionUsage | null;
  turns: number;
  transcriptModel: { provider: string; modelId: string } | null;
  pending: boolean;
  interrupted: boolean;
};

/**
 * [#139] A declared context window, honestly. Sub-1k windows keep their real
 * token count: the evidence caught `Math.round(8 / 1000)` rendering `0k` for a
 * model that declares 8 tokens. A whole-kilo window keeps the existing `k`
 * spelling so the menu still reads `131k · 3 档` for a normal model.
 */
export function formatWindow(tokens: number): string {
  if (!Number.isSafeInteger(tokens) || tokens < 0) return "窗口未知";
  return tokens < 1000 ? String(tokens) : `${Math.round(tokens / 1000)}k`;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const SAFE_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const nonNegative = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

function bindingOf(value: unknown): SessionBinding | null {
  if (value === null || value === undefined) return null;
  if (!object(value)) throw new Error("会话模型绑定返回异常");
  const level = value["thinkingLevel"];
  if (level !== null && !(typeof level === "string" && (SESSION_THINKING_LEVELS as readonly string[]).includes(level))) throw new Error("会话模型绑定返回异常");
  if (typeof value["profileId"] !== "string" || typeof value["modelId"] !== "string" || nonNegative(value["generation"]) === null) throw new Error("会话模型绑定返回异常");
  return { profileId: value["profileId"], modelId: value["modelId"], thinkingLevel: level as SessionThinkingLevel | null, generation: value["generation"] as number };
}

function sessionOf(value: unknown): TaskSession {
  if (!object(value) || typeof value["id"] !== "string" || !SAFE_ID.test(value["id"]) || typeof value["name"] !== "string" ||
      typeof value["archived"] !== "boolean" || typeof value["createdAt"] !== "string" || typeof value["updatedAt"] !== "string" ||
      !["read", "default", "auto"].includes(String(value["permission"]))) {
    throw new Error("会话列表返回异常");
  }
  return {
    id: value["id"], name: value["name"], createdAt: value["createdAt"], updatedAt: value["updatedAt"],
    archived: value["archived"], permission: value["permission"] as SessionPermission, binding: bindingOf(value["binding"]),
  };
}

function providerOf(value: unknown): SessionProvider | null {
  if (value === null || value === undefined) return null;
  if (!object(value) || typeof value["profileId"] !== "string" || typeof value["modelId"] !== "string" ||
      nonNegative(value["generation"]) === null || !Array.isArray(value["models"])) throw new Error("会话 Provider 返回异常");
  const models = value["models"].map((row: unknown): SessionProviderModel => {
    if (!object(row) || typeof row["id"] !== "string" || typeof row["name"] !== "string" || typeof row["reasoning"] !== "boolean" ||
        nonNegative(row["contextWindow"]) === null || nonNegative(row["maxTokens"]) === null || !Array.isArray(row["reasoningLevels"]) ||
        row["reasoningLevels"].some((level: unknown) => typeof level !== "string" || !(SESSION_THINKING_LEVELS as readonly string[]).includes(level))) {
      throw new Error("会话 Provider 返回异常");
    }
    return {
      id: row["id"], name: row["name"], reasoning: row["reasoning"],
      contextWindow: row["contextWindow"] as number, maxTokens: row["maxTokens"] as number,
      reasoningLevels: row["reasoningLevels"] as SessionThinkingLevel[],
    };
  });
  return { profileId: value["profileId"], modelId: value["modelId"], generation: value["generation"] as number, models };
}

export function parseSessionList(value: unknown): SessionList {
  if (!object(value) || !Array.isArray(value["sessions"]) || value["sessions"].length > 50) throw new Error("会话列表返回异常");
  const active = value["activeSessionId"];
  if (active !== null && (typeof active !== "string" || !SAFE_ID.test(active))) throw new Error("会话列表返回异常");
  const sessions = value["sessions"].map(sessionOf);
  if (new Set(sessions.map((session) => session.id)).size !== sessions.length) throw new Error("会话列表返回异常");
  if (typeof active === "string" && !sessions.some((session) => session.id === active && !session.archived)) throw new Error("会话列表返回异常：活跃会话不在列表中");
  return { activeSessionId: active as string | null, sessions, provider: providerOf(value["provider"]) };
}

export function parseSessionReadout(value: unknown): SessionReadout {
  if (!object(value) || typeof value["active"] !== "boolean" || typeof value["pending"] !== "boolean" || typeof value["interrupted"] !== "boolean" ||
      nonNegative(value["turns"]) === null || !Array.isArray(value["reasoningLevels"]) || !object(value["context"]) || !object(value["session"])) {
    throw new Error("会话读数返回异常");
  }
  const context = value["context"];
  const used = context["used"];
  const window = context["window"];
  if (used !== null && nonNegative(used) === null) throw new Error("会话读数返回异常");
  if (window !== null && nonNegative(window) === null) throw new Error("会话读数返回异常");
  if (context["source"] !== "sdk-usage" && context["source"] !== "unknown") throw new Error("会话读数返回异常");
  const model = value["model"];
  if (model !== null && (!object(model) || typeof model["id"] !== "string" || typeof model["name"] !== "string" ||
      typeof model["reasoning"] !== "boolean" || nonNegative(model["contextWindow"]) === null || nonNegative(model["maxTokens"]) === null)) {
    throw new Error("会话读数返回异常");
  }
  const usage = value["usage"];
  if (usage !== null && (!object(usage) || ["input", "output", "cacheRead", "cacheWrite"].some((key) => nonNegative(usage[key]) === null))) {
    throw new Error("会话读数返回异常");
  }
  return {
    session: sessionOf(value["session"]),
    active: value["active"],
    model: model === null ? null : {
      id: model["id"] as string, name: model["name"] as string, reasoning: model["reasoning"] as boolean,
      contextWindow: model["contextWindow"] as number, maxTokens: model["maxTokens"] as number,
    },
    reasoningLevels: value["reasoningLevels"] as SessionThinkingLevel[],
    context: { used: used as number | null, window: window as number | null, source: context["source"] },
    usage: usage === null ? null : {
      input: usage["input"] as number, output: usage["output"] as number,
      cacheRead: usage["cacheRead"] as number, cacheWrite: usage["cacheWrite"] as number,
    },
    turns: value["turns"] as number,
    transcriptModel: object(value["transcriptModel"]) && typeof value["transcriptModel"]["provider"] === "string" && typeof value["transcriptModel"]["modelId"] === "string"
      ? { provider: value["transcriptModel"]["provider"] as string, modelId: value["transcriptModel"]["modelId"] as string }
      : null,
    pending: value["pending"],
    interrupted: value["interrupted"],
  };
}

/**
 * [#139] Merge a list reply over the list the page already holds.
 *
 * A write reply is always a full list reply now (`session-list-payload`), but a
 * partial reply (an older Host, a field lost in transit) must not null the
 * provider the page already read: the model menu is the only way to switch
 * models, and an empty `provider` makes it say 切换模型不可用 until a remount.
 * `sessions`/`activeSessionId` always come from the reply — it is newer truth.
 */
export function mergeSessionList(previous: SessionList | null, next: SessionList): SessionList {
  return { ...next, provider: next.provider ?? previous?.provider ?? null };
}

/**
 * [#139] Every session-list writer announces its task after the Host accepted
 * the write. List readers that are NOT the writer (the sidebar's
 * `TaskSessionRows`) subscribe here instead of polling: creating/renaming/
 * archiving/restoring/deleting/activating in the conversation must refresh the
 * row the user is looking at. A refused write announces nothing.
 */
type SessionWriteListener = (taskId: string) => void;
const sessionWriteListeners = new Set<SessionWriteListener>();

export function subscribeSessionWrites(listener: SessionWriteListener): () => void {
  sessionWriteListeners.add(listener);
  return () => { sessionWriteListeners.delete(listener); };
}

function announceSessionWrite(taskId: string): void {
  for (const listener of [...sessionWriteListeners]) {
    // A reader's own failure is its own named state; it must not fail the write.
    try { listener(taskId); } catch { /* the listener reports its own read */ }
  }
}

type Op = (taskId: string, op: Parameters<typeof shellTaskOp>[1], payload?: Record<string, unknown>) => Promise<ShellTaskOpResult>;
const run: Op = (taskId, op, payload) => shellTaskOp(taskId, op, payload);

async function listFrom(result: ShellTaskOpResult): Promise<{ ok: true; list: SessionList } | { ok: false; error: string }> {
  if (!result.ok) return { ok: false, error: result.error ?? "会话操作失败" };
  try { return { ok: true, list: parseSessionList(result.payload) }; }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}

export async function readTaskSessions(taskId: string): Promise<{ ok: true; list: SessionList } | { ok: false; error: string }> {
  try { return await listFrom(await run(taskId, "task/sessionList")); }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}

async function sessionMutation(taskId: string, op: Parameters<typeof shellTaskOp>[1], payload: Record<string, unknown>) {
  try {
    const result = await listFrom(await run(taskId, op, payload));
    // The write landed: every other list reader re-reads the Host's index.
    if (result.ok) announceSessionWrite(taskId);
    return result;
  } catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : String(error) }; }
}

export const createSession = (taskId: string, input: { name?: string } = {}) =>
  sessionMutation(taskId, "task/sessionCreate", { ...(input.name === undefined ? {} : { name: input.name }) });
export const renameSession = (taskId: string, sessionId: string, name: string) =>
  sessionMutation(taskId, "task/sessionRename", { sessionId, name });

/**
 * [#146] 停止 / 归档 / 删除 share the Host's ordered lifecycle policy and answer
 * with what really happened beside the new list: `stopped` is true only when a
 * live turn/confirmation was actually aborted, and `abortedTurnIds` names the
 * turns. The page therefore never claims "已停止" for a session that was idle.
 */
export type SessionLifecycleReply = { list: SessionList; stopped: boolean; abortedTurnIds: string[] };
async function lifecycleMutation(taskId: string, op: Parameters<typeof shellTaskOp>[1], sessionId: string) {
  try {
    const result = await run(taskId, op, { sessionId });
    if (!result.ok) return { ok: false as const, error: result.error ?? "会话操作失败" };
    const list = parseSessionList(result.payload);
    announceSessionWrite(taskId);
    const payload = result.payload as Record<string, unknown>;
    const ids = Array.isArray(payload["abortedTurnIds"]) ? payload["abortedTurnIds"].filter((id): id is string => typeof id === "string") : [];
    // Same `list` key as every other session writer (#139); the lifecycle
    // outcome rides beside it so a page can quote what really happened.
    return { ok: true as const, list, stopped: payload["stopped"] === true, abortedTurnIds: ids };
  } catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : String(error) }; }
}

export const stopSession = (taskId: string, sessionId: string) => lifecycleMutation(taskId, "task/sessionStop", sessionId);
export const archiveSession = (taskId: string, sessionId: string) => lifecycleMutation(taskId, "task/sessionArchive", sessionId);
export const deleteSession = (taskId: string, sessionId: string) => lifecycleMutation(taskId, "task/sessionDelete", sessionId);
export const restoreSession = (taskId: string, sessionId: string) =>
  sessionMutation(taskId, "task/sessionRestore", { sessionId });
export const activateSession = (taskId: string, sessionId: string) =>
  sessionMutation(taskId, "task/sessionActivate", { sessionId });

/**
 * [#146] The six entries every session row offers (新建 lives on the list
 * itself) and whether each one applies to this state. The Host still enforces
 * the same rule by name; this only decides what the menu may present, so the
 * page never offers an action the Host would refuse for a reason it can see
 * (an archived session cannot be stopped/archived twice, a live one cannot be
 * restored, and 续聊 is the current session's already-open conversation).
 */
export type SessionActionId = "new" | "resume" | "stop" | "archive" | "restore" | "delete";
export interface SessionActionRow { id: SessionActionId; label: string; enabled: boolean; reason: string | null }
export function sessionActionRows(session: Pick<TaskSession, "id" | "archived">, state: { current: boolean }): SessionActionRow[] {
  return [
    { id: "resume", label: state.current ? "当前会话" : "继续对话", enabled: !session.archived && !state.current,
      reason: session.archived ? "已归档的会话不能继续对话；请先恢复" : state.current ? "已经是当前会话" : null },
    { id: "stop", label: "停止", enabled: !session.archived,
      reason: session.archived ? "已归档的会话没有正在执行的回合" : null },
    { id: "archive", label: "归档", enabled: !session.archived,
      reason: session.archived ? "该会话已归档" : null },
    { id: "restore", label: "恢复", enabled: session.archived,
      reason: session.archived ? null : "该会话未归档" },
    { id: "delete", label: "删除", enabled: true, reason: null },
  ];
}

/** One session's readout (identity + bound model + declared levels + real SDK numbers). */
export async function readSessionReadout(taskId: string, sessionId: string): Promise<{ ok: true; readout: SessionReadout } | { ok: false; error: string }> {
  try {
    const result = await run(taskId, "task/sessionReadout", { sessionId });
    if (!result.ok) return { ok: false, error: result.error ?? "会话读数失败" };
    return { ok: true, readout: parseSessionReadout(result.payload) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readoutMutation(taskId: string, op: Parameters<typeof shellTaskOp>[1], payload: Record<string, unknown>) {
  try {
    const result = await run(taskId, op, payload);
    if (!result.ok) return { ok: false as const, error: result.error ?? "会话写入失败" };
    return { ok: true as const, readout: parseSessionReadout(result.payload) };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Switch this session's model (and optionally its reasoning level), keeping its
 * history. [#167] `profileId` names the global profile that owns `modelId`; the
 * Host refuses a pair whose profile is not the one main installed, so a stale
 * renderer cannot bind the same model id under the wrong profile.
 */
export const switchSessionModel = (taskId: string, sessionId: string, modelId: string, thinkingLevel?: SessionThinkingLevel, profileId?: string) =>
  readoutMutation(taskId, "task/sessionModel", {
    sessionId, modelId,
    ...(profileId === undefined ? {} : { profileId }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  });

export const setSessionReasoning = (taskId: string, sessionId: string, level: SessionThinkingLevel) =>
  readoutMutation(taskId, "task/sessionReasoning", { sessionId, level });
