/**
 * Provider 配置的渲染层契约（[PiDock T03] #138）。
 *
 * 这一层把 main 的 `shell/providerOp` 回包解析成 StrictView：任何意外形状都
 * 会让页面停在错误态，而不是被当成「已配置」。这里不存在密钥字段——渲染层
 * 只在保存时把用户刚输入的 key 放进一次 `save` 请求体；列表、状态与回读都
 * 没有可以回显 key 的位置。
 *
 * 参数校验（`draftIssues`）与 main 的 `profileInput`/`validateExplicitTextProvider`
 * 是同一套规则的两侧：渲染层先给出行内错误，main 仍然是权威并会再次拒绝。
 */

export type ProviderProtocol = "openai-completions" | "openai-responses" | "anthropic-messages";
/**
 * The three protocols PiDock registers verbatim with Pi. `baseHint` is the one
 * place the version-prefix rule is spelled out: Pi's OpenAI transports append
 * `/chat/completions` or `/responses` to a base that already ends in `/v1`,
 * while its Anthropic transport appends `/v1/messages` itself, so that base is
 * the API root. The probe and discovery use the same rule, so what the user
 * tests is exactly what a turn will call.
 */
export const PROVIDER_PROTOCOLS: { id: ProviderProtocol; label: string; hint: string; baseHint: string }[] = [
  { id: "openai-completions", label: "OpenAI Chat Completions", hint: "POST /chat/completions · Bearer",
    baseHint: "填到版本前缀，例如 https://api.openai.com/v1（Pi 会在其后追加 /chat/completions）" },
  { id: "openai-responses", label: "OpenAI Responses", hint: "POST /responses · Bearer",
    baseHint: "填到版本前缀，例如 https://api.openai.com/v1（Pi 会在其后追加 /responses）" },
  { id: "anthropic-messages", label: "Anthropic Messages", hint: "POST /v1/messages · x-api-key",
    baseHint: "填 API 根地址，例如 https://api.anthropic.com（Pi 会补上 /v1/messages）" },
];

export type ProviderState = "configured" | "not-configured" | "pending" | "credential-missing" | "binding-stale" | "install-failed";
export const PROVIDER_STATES: ProviderState[] = ["configured", "not-configured", "pending", "credential-missing", "binding-stale", "install-failed"];

/** `synced` means the file still holds exactly what PiDock wrote. */
export type NativeState = "synced" | "modified" | "removed" | "never-written" | "unreadable";
export const NATIVE_STATES: NativeState[] = ["synced", "modified", "removed", "never-written", "unreadable"];

export type ProviderModel = {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  /** Levels this model actually declares, as derived by main from Pi's rules. */
  reasoningLevels: string[];
  /** `null` = not declared. Unknown cost must not render as 0. */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
};

export type ProviderView = {
  id: string;
  name: string;
  notes: string | null;
  protocol: string;
  baseUrl: string;
  models: ProviderModel[];
  modelId: string;
  contextWindow: number;
  maxTokens: number;
  credentialSource: "env" | "store";
  credentialAvailable: boolean;
  authRef: string;
  generation: number;
  native: { providerId: string; state: NativeState };
};

export type ProviderStatus = {
  state: ProviderState;
  profileId: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  generation: number | null;
  profiles: ProviderView[];
  nativePath: string | null;
  secretsAvailable: boolean;
};

export type Row = { id: string; name: string; contextWindow: string; maxTokens: string; reasoning: boolean; levels: string[]; cost: string };
export type ProviderDraft = {
  id?: string;
  name: string;
  notes: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  /** `store` = the key field below (or an already stored key); `env` = 环境变量引用. */
  credentialKind: "store" | "env";
  authRef: string;
  apiKey: string;
  hasStoredKey: boolean;
  models: Row[];
  modelId: string;
};

export const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const LEVEL_TEXT: Record<string, string> = {
  off: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高",
};

export const EMPTY_PROVIDER_DRAFT: ProviderDraft = {
  name: "", notes: "", protocol: "openai-completions", baseUrl: "", credentialKind: "store",
  authRef: "PIDOCK_PROVIDER_", apiKey: "", hasStoredKey: false,
  models: [{ id: "", name: "", contextWindow: "128000", maxTokens: "8192", reasoning: false, levels: [], cost: "" }], modelId: "",
};

export function draftFromView(view: ProviderView): ProviderDraft {
  return {
    id: view.id, name: view.name, notes: view.notes ?? "", protocol: view.protocol as ProviderProtocol, baseUrl: view.baseUrl,
    credentialKind: view.credentialSource, authRef: view.credentialSource === "env" ? view.authRef : "PIDOCK_PROVIDER_",
    apiKey: "", hasStoredKey: view.credentialSource === "store" && view.credentialAvailable,
    models: view.models.map((model) => ({
      id: model.id, name: model.name, contextWindow: String(model.contextWindow), maxTokens: String(model.maxTokens),
      // The declared levels are kept verbatim, including whether 关闭 itself is
      // one of them: the form must not add a level the model did not declare.
      // A non-reasoning model declares no levels at all (`["off"]` from main is
      // the SDK's "only off is available", not a level the user can configure).
      reasoning: model.reasoning, levels: model.reasoning ? model.reasoningLevels : [],
      cost: model.cost === null ? "" : String(model.cost.input),
    })),
    modelId: view.modelId,
  };
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === "string" && /^p-[0-9a-f-]{36}$/.test(value);
const bounded = (value: unknown, max = 2048): value is string => typeof value === "string" && value.length <= max;

function parseModel(value: unknown): ProviderModel {
  if (!object(value) || typeof value.id !== "string" || value.id.length === 0 || value.id.length > 200 ||
      typeof value.name !== "string" || value.name.length > 200 ||
      !Number.isSafeInteger(value.contextWindow) || (value.contextWindow as number) < 1 ||
      !Number.isSafeInteger(value.maxTokens) || (value.maxTokens as number) < 1 ||
      typeof value.reasoning !== "boolean" ||
      !Array.isArray(value.reasoningLevels) || value.reasoningLevels.length === 0 ||
      value.reasoningLevels.some((level) => typeof level !== "string" || !REASONING_LEVELS.includes(level as never))) {
    throw new Error("Provider 模型返回异常");
  }
  const cost = value.cost;
  if (cost !== null && (!object(cost) ||
      !["input", "output", "cacheRead", "cacheWrite"].every((key) => typeof cost[key] === "number" && Number.isFinite(cost[key])))) {
    throw new Error("Provider 模型价格返回异常");
  }
  return {
    id: value.id, name: value.name, contextWindow: value.contextWindow as number, maxTokens: value.maxTokens as number,
    reasoning: value.reasoning, reasoningLevels: value.reasoningLevels as string[],
    cost: cost === null ? null : cost as ProviderModel["cost"],
  };
}

function parseView(value: unknown): ProviderView {
  if (!object(value) || !isId(value.id) || !bounded(value.name, 128) ||
      !(value.notes === null || value.notes === undefined || bounded(value.notes, 500)) ||
      !(value.protocol === undefined || bounded(value.protocol, 40)) || !bounded(value.baseUrl) || !bounded(value.modelId, 200) ||
      !bounded(value.authRef) || typeof value.credentialAvailable !== "boolean" ||
      !Number.isSafeInteger(value.generation) || (value.generation as number) < 1 ||
      !(value.models === undefined || (Array.isArray(value.models) && value.models.length <= 20)) ||
      !Number.isSafeInteger(value.contextWindow) || !Number.isSafeInteger(value.maxTokens)) {
    throw new Error("Provider 配置返回异常");
  }
  const native = value.native;
  if (native !== undefined && (!object(native) || !bounded(native.providerId, 200) || !NATIVE_STATES.includes(native.state as NativeState))) {
    throw new Error("Provider 原生配置状态返回异常");
  }
  const modelId = value.modelId;
  // A profile saved before multi-model support carries exactly one model, no
  // cost declaration and no reasoning map. Those are read as declared-unknown,
  // never as a fabricated zero price or a guessed level.
  const models = value.models === undefined || value.models.length === 0
    ? [{ id: modelId, name: modelId, contextWindow: value.contextWindow as number, maxTokens: value.maxTokens as number,
         reasoning: false, reasoningLevels: ["off"], cost: null }]
    : value.models.map(parseModel);
  const credentialSource = value.credentialSource === "store" ? "store" : "env";
  return {
    id: value.id, name: value.name, notes: typeof value.notes === "string" ? value.notes : null,
    protocol: typeof value.protocol === "string" ? value.protocol : "openai-completions",
    baseUrl: value.baseUrl, models, modelId,
    contextWindow: value.contextWindow as number, maxTokens: value.maxTokens as number,
    credentialSource, credentialAvailable: value.credentialAvailable,
    authRef: value.authRef, generation: value.generation as number,
    native: native === undefined ? { providerId: `pidock-${value.id}`, state: "never-written" }
      : { providerId: (native as { providerId: string }).providerId, state: (native as { state: NativeState }).state },
  };
}

/**
 * main 的状态回包。v1 只带 `state/profileId/generation/profiles`；新增字段按
 * 缺省值补齐（多模型之前保存的档案就是「单模型、本地未声明价格」），但核心
 * 形状与档案行仍然严格校验。
 */
export function parseProviderStatus(value: unknown): ProviderStatus {
  if (!object(value) || !PROVIDER_STATES.includes(value.state as ProviderState) ||
      !(value.profileId === null || typeof value.profileId === "string") ||
      !(value.generation === null || Number.isSafeInteger(value.generation)) ||
      !Array.isArray(value.profiles) || value.profiles.length > 50) throw new Error("Provider 状态返回异常");
  const status = value as Record<string, unknown>;
  return {
    state: value.state as ProviderState,
    profileId: status.profileId as string | null,
    modelId: typeof status.modelId === "string" ? status.modelId : null,
    thinkingLevel: typeof status.thinkingLevel === "string" ? status.thinkingLevel : null,
    generation: status.generation as number | null,
    profiles: value.profiles.map(parseView),
    nativePath: typeof status.nativePath === "string" ? status.nativePath : null,
    secretsAvailable: status.secretsAvailable === true,
  };
}

export const PROVIDER_STATE_TEXT: Record<ProviderState, string> = {
  configured: "已配置 · 该任务的模型请求通过这份 Provider 发出",
  "not-configured": "未配置 · SDK 会话不会发出模型请求（不会回退到本机其它凭据）",
  pending: "已安装 · 该任务有进行中的请求，新的发送会在其结束后生效",
  "credential-missing": "凭据缺失 · 这份 Provider 的密钥不在本机存储中，未安装",
  "binding-stale": "会话绑定失效 · 该任务的 SDK 会话记录绑定的是另一份配置身份，已拒绝继续发送；请重新选用",
  "install-failed": "安装失败 · 隔离上下文拒绝了这份配置，未安装",
};

export const NATIVE_STATE_TEXT: Record<NativeState, string> = {
  synced: "已写入 models.json",
  modified: "外部修改",
  removed: "外部删除",
  "never-written": "尚未写入",
  unreadable: "无法读取",
};

export const CREDENTIAL_TEXT = { store: "本机加密存储", env: "环境变量引用" } as const;

/** One `shell/providerOp` round trip; throws with main's own wording on refusal. */
export async function providerCall(request: Record<string, unknown>): Promise<unknown> {
  const bridge = window.pidock;
  if (!bridge?.providerOp) throw new Error("桌面壳 Provider 接口不可用");
  const result = await bridge.providerOp(request as never);
  if (!result || result.ok !== true) throw new Error(result?.error || "Provider 配置不可用");
  return result.payload;
}

/** `save` answers with the stored profile plus whether the native write happened. */
export function parseSaved(value: unknown): { profile: ProviderView; written: boolean; conflict: NativeState | null } {
  if (!object(value) || typeof value.written !== "boolean") throw new Error("Provider 保存返回异常");
  const conflict = value.conflict;
  if (!(conflict === null || NATIVE_STATES.includes(conflict as NativeState))) throw new Error("Provider 保存返回异常");
  return { profile: parseView(value.profile), written: value.written, conflict: conflict as NativeState | null };
}

export type DiscoveryResult = { status: "ok" | "empty" | "failed" | "unsupported" | "refused"; candidates: string[]; message: string };
export function parseDiscovery(value: unknown): DiscoveryResult {
  if (!object(value) || !["ok", "empty", "failed", "unsupported", "refused"].includes(String(value.status)) ||
      !Array.isArray(value.candidates) || value.candidates.some((id) => typeof id !== "string" || id.length === 0 || id.length > 200) ||
      value.candidates.length > 500 || typeof value.message !== "string" || value.message.length > 500) {
    throw new Error("模型列表返回异常");
  }
  return { status: value.status as DiscoveryResult["status"], candidates: value.candidates as string[], message: value.message };
}

export type ProbeResult = { ok: boolean; code: string; message: string; status: number | null; latencyMs: number | null };
export function parseProbe(value: unknown): ProbeResult {
  if (!object(value) || typeof value.ok !== "boolean" || !bounded(value.code, 80) || !bounded(value.message, 500) ||
      !(value.status === null || (Number.isSafeInteger(value.status) && (value.status as number) > 0)) ||
      !(value.latencyMs === null || (Number.isSafeInteger(value.latencyMs) && (value.latencyMs as number) >= 0))) {
    throw new Error("连通性测试返回异常");
  }
  return { ok: value.ok, code: value.code, message: value.message, status: value.status as number | null, latencyMs: value.latencyMs as number | null };
}

/** 行内校验；`field` 是该行/该字段的锚点，`message` 直接展示。 */
export type FieldIssue = { field: string; message: string };

const positiveInteger = (value: string, label: string, field: string, issues: FieldIssue[]): number | null => {
  const text = value.trim();
  const parsed = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) issues.push({ field, message: `${label}需要是正整数` });
  return Number.isSafeInteger(parsed) ? parsed : null;
};

export function draftIssues(draft: ProviderDraft, existing: ProviderView[] = [], discovery?: DiscoveryResult | null): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const name = draft.name.trim();
  if (name.length === 0) issues.push({ field: "name", message: "请填写供应商名称" });
  else if (name.length > 128) issues.push({ field: "name", message: "名称最多 128 个字符" });
  if (draft.notes.length > 500) issues.push({ field: "notes", message: "备注最多 500 个字符" });

  if (!PROVIDER_PROTOCOLS.some((protocol) => protocol.id === draft.protocol)) issues.push({ field: "protocol", message: "请选择接口格式" });

  const baseUrl = draft.baseUrl.trim();
  if (baseUrl.length === 0) issues.push({ field: "baseUrl", message: "请填写 Base URL" });
  else {
    let url: URL | null = null;
    try { url = new URL(baseUrl); } catch { url = null; }
    if (!url || !["http:", "https:"].includes(url.protocol)) issues.push({ field: "baseUrl", message: "Base URL 需要是 http(s) 地址" });
    else if (url.username || url.password) issues.push({ field: "baseUrl", message: "Base URL 不能包含用户名或密码" });
  }

  if (draft.credentialKind === "env") {
    if (!/^PIDOCK_PROVIDER_[A-Z0-9_]{1,80}$/.test(draft.authRef)) {
      issues.push({ field: "authRef", message: "环境变量名需要形如 PIDOCK_PROVIDER_XXX（大写字母、数字与下划线）" });
    }
  } else if (draft.apiKey.length === 0 && !draft.hasStoredKey) {
    issues.push({ field: "apiKey", message: "请填写 API Key（没有密钥的端点请改用环境变量引用）" });
  } else if (draft.apiKey.length > 0 && (draft.apiKey.length < 8 || draft.apiKey.length > 4096 || draft.apiKey.trim() !== draft.apiKey)) {
    issues.push({ field: "apiKey", message: "API Key 需要 8–4096 个字符，且不含首尾空白" });
  }

  if (draft.models.length === 0) issues.push({ field: "models", message: "至少添加一个模型" });
  else if (draft.models.length > 20) issues.push({ field: "models", message: "最多 20 个模型" });
  const seen = new Set<string>();
  draft.models.forEach((row, index) => {
    const id = row.id.trim();
    const at = `models.${index}`;
    if (id.length === 0) issues.push({ field: `${at}.id`, message: `第 ${index + 1} 个模型缺少模型 ID` });
    else if (id.length > 200) issues.push({ field: `${at}.id`, message: `第 ${index + 1} 个模型 ID 过长` });
    else if (seen.has(id)) issues.push({ field: `${at}.id`, message: `模型 ID ${id} 重复` });
    seen.add(id);
    if (row.name.length > 200) issues.push({ field: `${at}.name`, message: `第 ${index + 1} 个模型的显示名称过长` });
    const window = positiveInteger(row.contextWindow, "上下文窗口", `${at}.contextWindow`, issues);
    const output = positiveInteger(row.maxTokens, "最大输出", `${at}.maxTokens`, issues);
    if (window !== null && output !== null && output > window) {
      issues.push({ field: `${at}.maxTokens`, message: "最大输出不能大于上下文窗口" });
    }
    if (row.levels.length > 0 && !row.reasoning) issues.push({ field: `${at}.reasoning`, message: "只有声明支持思维链的模型才能设置推理档位" });
    if (row.reasoning && row.levels.length === 0) issues.push({ field: `${at}.reasoning`, message: "请至少声明一个支持的推理档位（关闭也算一个）" });
    if (row.cost.trim() !== "") {
      const cost = Number(row.cost);
      if (!Number.isFinite(cost) || cost < 0) issues.push({ field: `${at}.cost`, message: "输入价格需要是不小于 0 的数字" });
    }
    // A newly discovered row that the endpoint later stops listing is still
    // saveable (discovery only ever ADDS candidates), but the user is told.
    if (discovery && discovery.status === "ok" && !discovery.candidates.includes(id) && id.length > 0) {
      issues.push({ field: `${at}.id`, message: `模型列表里没有 ${id}（仍可手动保存）`, });
    }
  });
  if (!draft.models.some((row) => row.id.trim() === draft.modelId.trim()) || draft.modelId.trim().length === 0) {
    issues.push({ field: "modelId", message: "请选择一个默认模型" });
  }
  const duplicate = existing.find((view) => view.id !== draft.id && view.name.trim() === name);
  if (duplicate) issues.push({ field: "name", message: `已存在同名供应商：${duplicate.name}` });
  return issues;
}

/** The exact-key `save` payload: the profile fields plus, only when newly typed, the key. */
export function draftRequest(draft: ProviderDraft): { profile: Record<string, unknown>; apiKey?: string } {
  const models = draft.models.map((row) => ({
    id: row.id.trim(), name: row.name.trim() || row.id.trim(),
    contextWindow: Number(row.contextWindow), maxTokens: Number(row.maxTokens),
    reasoning: row.reasoning,
    ...(row.reasoning && row.levels.length > 0 ? { reasoningLevels: REASONING_LEVELS.filter((level) => row.levels.includes(level)) } : {}),
    ...(row.cost.trim() === "" ? {} : { cost: { input: Number(row.cost), output: 0, cacheRead: 0, cacheWrite: 0 } }),
  }));
  return {
    profile: {
      ...(draft.id === undefined ? {} : { id: draft.id }),
      name: draft.name.trim(),
      notes: draft.notes.trim() === "" ? null : draft.notes.trim(),
      protocol: draft.protocol,
      baseUrl: draft.baseUrl.trim(),
      credential: draft.credentialKind === "env" ? { kind: "env", ref: draft.authRef } : { kind: "store" },
      models,
      modelId: draft.modelId.trim(),
    },
    ...(draft.credentialKind === "store" && draft.apiKey.length > 0 ? { apiKey: draft.apiKey } : {}),
  };
}
