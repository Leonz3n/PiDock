/**
 * [PiDock 11] #9 renderer rules: provider status, model picker, context display.
 *
 * The renderer is sandboxed and must never import Node or Electron, so the
 * shell-side provider rules (`packages/shell/src/main/provider-config.ts`) are
 * mirrored here rather than imported. `providerState.test.ts` locks the shared
 * contract (same failure codes/messages, same strict `>`/`=`/`<` bounds, same
 * candidate-only sync, same no-substitute attribution).
 *
 * Everything in this module is pure: the discovery transport is injected, the
 * picker/keyboard/token helpers take plain data, and no function performs I/O.
 */

import type {
  ContextSource,
  ModelThinking,
  ProviderAvailability,
  ProviderDiscoveryView,
  ProviderIssue,
  ProviderModel,
  ProviderProfile,
  ProviderStatusView,
} from "./types";

/** Canonical reasoning-level order (the edit form's `REASONING_LABELS`). */
export const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Model-list fixtures used by the in-memory adapter (no real request is sent). */
export const PROTOCOL_MODEL_FIXTURES: Record<string, string[]> = {
  "anthropic-messages": ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1"],
  "openai-responses": ["gpt-5", "gpt-5-mini", "o5"],
  "openai-chat-completions": ["qwen3-coder", "llama3.3-70b"],
};

/** True for a literal credential (never a reference). */
export function isSecretLike(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (/^(sk|pk|rk|ghp|gho|ghs|xox[baprs])[-_]/i.test(trimmed)) return true;
  if (/^bearer\s+/i.test(trimmed)) return true;
  return !/\s/.test(trimmed) && /[A-Za-z]/.test(trimmed) && /\d/.test(trimmed) && /^[A-Za-z0-9+/=_.:-]{32,}$/.test(trimmed);
}

export function isAuthReference(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return false;
  if (/\s/.test(trimmed)) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(trimmed)) return false;
  return !isSecretLike(trimmed);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Validate the provider edit form. Returns every locatable issue (not just the
 * first) so the form can mark each field; an empty list means the draft saves.
 * Capabilities are read only from the declared row — a model id never implies
 * image support or reasoning tiers.
 */
export function validateProviderDraft(input: {
  name: string;
  protocol: string;
  baseUrl: string;
  authRef?: string;
  models: ProviderModel[];
}): ProviderIssue[] {
  const issues: ProviderIssue[] = [];
  if (input.name.trim().length === 0) issues.push({ code: "provider-name-required", field: "name", message: "请填写 Provider 名称" });
  if (input.protocol.trim().length === 0) {
    issues.push({ code: "protocol-required", field: "protocol", message: "请显式选择协议；不按供应商名或地址猜测协议" });
  }
  const baseUrl = input.baseUrl.trim();
  if (baseUrl.length === 0) issues.push({ code: "base-url-required", field: "baseUrl", message: "请填写服务地址" });
  else if (/\/\/[^/@\s]+:[^/@\s]+@/.test(baseUrl)) {
    issues.push({ code: "credentials-in-url", field: "baseUrl", message: "服务地址不能内嵌凭据，请改用本机私有配置的认证引用" });
  }
  const authRef = input.authRef?.trim() ?? "";
  if (authRef.length > 0) {
    if (isSecretLike(authRef)) {
      issues.push({ code: "auth-ref-looks-like-secret", field: "authRef", message: "认证引用不能是凭据明文，请填写本机私有配置的引用名" });
    } else if (!isAuthReference(authRef)) {
      issues.push({ code: "auth-ref-invalid", field: "authRef", message: "认证引用只能是短引用名，不能包含空格或凭据字符" });
    }
  }
  if (input.models.length === 0) issues.push({ code: "model-required", field: "models", message: "请至少填写一个模型" });
  const seen = new Set<string>();
  for (const model of input.models) {
    const id = model.id.trim();
    if (id.length === 0) {
      issues.push({ code: "model-id-required", field: "models", message: "模型 ID 不能为空，可手填列表外的 ID" });
      continue;
    }
    if (seen.has(id)) issues.push({ code: "model-id-duplicate", field: `models.${id}`, message: `同一 Provider 中的模型 ID 不可重复：${id}` });
    seen.add(id);
    if (!isPositiveInteger(model.contextWindow)) {
      issues.push({ code: "context-window-invalid", field: `models.${id}.contextWindow`, message: "上下文窗口必须为正整数 Tokens" });
    }
    if (model.maxOutput !== undefined) {
      if (!isPositiveInteger(model.maxOutput)) {
        issues.push({ code: "max-output-invalid", field: `models.${id}.maxOutput`, message: "最大输出必须为正整数 Tokens" });
      } else if (isPositiveInteger(model.contextWindow) && model.maxOutput > model.contextWindow) {
        issues.push({ code: "max-output-exceeds-window", field: `models.${id}.maxOutput`, message: "最大输出不能超过上下文窗口" });
      }
    }
    const thinking = model.thinking;
    if (thinking !== undefined && thinking.mode === "custom") {
      if (thinking.levels.length === 0) {
        issues.push({ code: "thinking-levels-empty", field: `models.${id}.thinking.levels`, message: "自定义推理档位不能为空" });
      }
      if (new Set(thinking.levels).size !== thinking.levels.length) {
        issues.push({ code: "thinking-level-duplicate", field: `models.${id}.thinking.levels`, message: "推理档位不能重复" });
      }
      if (thinking.levels.some((level) => !(REASONING_LEVELS as readonly string[]).includes(level))) {
        issues.push({ code: "thinking-level-unknown", field: `models.${id}.thinking.levels`, message: "存在未知推理档位" });
      }
      if (!thinking.levels.includes(thinking.default)) {
        issues.push({ code: "thinking-default-not-in-levels", field: `models.${id}.thinking.default`, message: "默认推理档位必须在可用档位内" });
      }
    }
  }
  return issues;
}

/** Display name: an absent name shows the model id (the follow state). */
export function modelDisplayName(model: { id: string; name?: string }): string {
  const name = model.name?.trim();
  return name !== undefined && name.length > 0 ? name : model.id;
}

export type ModelNameState = { name?: string; followsId: boolean };

/** Name follows the id until edited; clearing it (or retyping the id) restores the follow. */
export function followModelName(id: string, edited: string): ModelNameState {
  const next = edited.trim();
  if (next.length === 0 || next === id) return { name: undefined, followsId: true };
  return { name: next, followsId: false };
}

/** After the model id itself changed: a followed name re-mirrors it, a custom name stays. */
export function followModelNameOnIdChange(current: ModelNameState): ModelNameState {
  return current.followsId ? { name: undefined, followsId: true } : { name: current.name, followsId: false };
}

export type DiscoveryTransport = (request: { baseUrl: string; protocol: string; path: string }) => Promise<
  { ok: true; ids: unknown[] } | { ok: false; message: string }
>;

/** Protocol model-list endpoint (mirrors the shell protocol descriptor). */
export function modelListPath(protocol: string): string | null {
  return PROTOCOL_MODEL_FIXTURES[protocol] === undefined ? null : "/v1/models";
}

export function connectionFingerprint(connection: { protocol: string; baseUrl: string }): string {
  return `${connection.protocol}::${connection.baseUrl.trim()}`;
}

/**
 * One 「同步模型列表」 attempt. Candidates only: configured rows are never
 * overwritten, auto-added or removed, and each outcome (success / empty /
 * failure / unsupported) has its own message for the form.
 */
export async function syncModelCandidates(input: {
  connection: { protocol: string; baseUrl: string };
  transport: DiscoveryTransport;
}): Promise<ProviderDiscoveryView> {
  const fingerprint = connectionFingerprint(input.connection);
  const path = modelListPath(input.connection.protocol);
  if (path === null) {
    return {
      status: "unsupported",
      candidates: [],
      fingerprint,
      ignored: 0,
      message: "当前协议未声明模型发现端点；请直接填写模型 ID，已配置模型不受影响",
    };
  }
  let response: { ok: true; ids: unknown[] } | { ok: false; message: string };
  try {
    response = await input.transport({ baseUrl: input.connection.baseUrl, protocol: input.connection.protocol, path });
  } catch (error) {
    return {
      status: "failure",
      candidates: [],
      fingerprint,
      ignored: 0,
      message: `模型发现失败：${error instanceof Error ? error.message : String(error)}；已保留表单与已配置模型`,
    };
  }
  if (!response.ok) {
    return {
      status: "failure",
      candidates: [],
      fingerprint,
      ignored: 0,
      message: `模型发现失败：${response.message}；已保留表单与已配置模型`,
    };
  }
  const candidates: string[] = [];
  const seen = new Set<string>();
  let ignored = 0;
  for (const id of response.ids) {
    if (typeof id !== "string" || id.trim().length === 0) {
      ignored += 1;
      continue;
    }
    const trimmed = id.trim();
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    candidates.push(trimmed);
  }
  if (candidates.length === 0) {
    return {
      status: "empty",
      candidates: [],
      fingerprint,
      ignored,
      message: ignored > 0 ? `连接未返回可用模型（忽略 ${ignored} 个不可解析候选）` : "连接返回空模型列表，已配置模型保持不变",
    };
  }
  return {
    status: "success",
    candidates,
    fingerprint,
    ignored,
    message: ignored > 0 ? `已同步 ${candidates.length} 个候选，忽略 ${ignored} 个不可解析候选` : `已同步 ${candidates.length} 个候选`,
  };
}

export type ThinkingCatalog = "catalog-unknown" | "unsupported" | "declared";

/** Effective session level: a stored preference counts only while the model declares it. */
export function resolveSessionThinking(
  model: { thinking?: ModelThinking } | undefined,
  stored: string | undefined,
): { catalog: ThinkingCatalog; level: string; source: "session" | "model-default" | "none"; stale?: string } {
  const thinking = model?.thinking;
  if (thinking === undefined || thinking.mode === "auto") {
    return { catalog: "catalog-unknown", level: stored ?? "", source: stored === undefined ? "none" : "session" };
  }
  if (thinking.mode === "none") return { catalog: "unsupported", level: "", source: "none" };
  if (stored === undefined) return { catalog: "declared", level: thinking.default, source: "model-default" };
  if (!thinking.levels.includes(stored)) return { catalog: "declared", level: thinking.default, source: "model-default", stale: stored };
  return { catalog: "declared", level: stored, source: "session" };
}

export type ThinkingRefusalCode = "thinking-unsupported" | "thinking-catalog-unknown" | "thinking-level-not-declared" | "thinking-required";

/** Whether a level may be selected for the model (跳级/不可关闭 fail closed). */
export function evaluateThinkingSelection(input: {
  thinking?: ModelThinking;
  level: string;
}): { ok: true; level: string } | { ok: false; error: { code: ThinkingRefusalCode; message: string } } {
  const level = input.level.trim();
  const thinking = input.thinking;
  if (thinking !== undefined && thinking.mode === "none") {
    return { ok: false, error: { code: "thinking-unsupported", message: "当前模型不支持推理档位" } };
  }
  if (thinking === undefined || thinking.mode === "auto") {
    if (level.length === 0) {
      return { ok: false, error: { code: "thinking-catalog-unknown", message: "模型目录尚未提供可用档位，不能声明已关闭推理" } };
    }
    return { ok: true, level };
  }
  if (level.length === 0) {
    if (thinking.levels.includes("off")) return { ok: true, level: "off" };
    return { ok: false, error: { code: "thinking-required", message: "该模型不支持关闭推理，请选择已声明档位" } };
  }
  if (!thinking.levels.includes(level)) {
    return { ok: false, error: { code: "thinking-level-not-declared", message: `模型未声明该推理档位：${level}` } };
  }
  return { ok: true, level };
}

export type SwitchRefusalCode =
  | "busy-round"
  | "provider-disabled"
  | "model-unavailable"
  | "context-window-unknown"
  | "context-occupancy-unknown"
  | "context-over-limit";

export interface SwitchRefusal {
  code: SwitchRefusalCode;
  message: string;
  occupancy?: number;
  limit?: number;
}

/**
 * Whether a provider/model switch may run now, in fail-closed order: busy
 * round/tool first, then availability, then the context bound. Strict bounds:
 * `used > window` refuses, `used === window` and `used < window` pass; an
 * unknown window or a pending/unknown occupancy never passes. The caller
 * re-runs this immediately before executing the switch.
 */
export function evaluateSessionModelSwitch(input: {
  running: boolean;
  busyLabel?: string;
  provider?: ProviderProfile;
  model?: ProviderModel;
  contextUsed: number;
  contextSource: ContextSource;
}): { ok: true } | { ok: false; refusal: SwitchRefusal } {
  if (input.running) {
    const label = input.busyLabel ?? "当前执行";
    return { ok: false, refusal: { code: "busy-round", message: `${label}尚未结束，请先等待完成或停止当前执行后再切换模型` } };
  }
  if (input.provider === undefined || input.model === undefined) {
    return { ok: false, refusal: { code: "model-unavailable", message: "目标模型不可用，请重新选择" } };
  }
  if (!input.provider.enabled) {
    return { ok: false, refusal: { code: "provider-disabled", message: `Provider ${input.provider.id} 已停用，请先启用或选择其他配置` } };
  }
  if (!isPositiveInteger(input.model.contextWindow)) {
    return { ok: false, refusal: { code: "context-window-unknown", message: "目标模型的上下文窗口未知，不能按零占用放行" } };
  }
  const { contextUsed, contextSource } = input;
  if (contextSource === "pending" || contextSource === "unknown" || !Number.isFinite(contextUsed) || contextUsed < 0) {
    return { ok: false, refusal: { code: "context-occupancy-unknown", message: "上下文占用待更新，尚不能判定是否超限；请等待占用更新后再切换" } };
  }
  if (contextUsed > input.model.contextWindow) {
    return {
      ok: false,
      refusal: {
        code: "context-over-limit",
        message: `当前上下文占用 ${formatTokens(contextUsed * 1000)} Tokens 超过目标模型上限 ${formatTokens(input.model.contextWindow * 1000)} Tokens`,
        occupancy: contextUsed,
        limit: input.model.contextWindow,
      },
    };
  }
  return { ok: true };
}

/** Availability of the provider/model a session, schedule or history call names. */
export function describeProviderAvailability(input: {
  provider?: ProviderProfile;
  model?: { id: string };
  modelId?: string;
}): { availability: ProviderAvailability; message?: string } {
  if (input.provider === undefined) {
    return { availability: "missing", message: "该配置已不存在，会话与历史仍按原 Provider 归属显示" };
  }
  if (!input.provider.enabled) return { availability: "disabled", message: "该配置已停用，请重新启用或显式选择其他配置" };
  const modelId = input.modelId ?? input.model?.id;
  if (modelId !== undefined && !input.provider.models.some((item) => item.id === modelId)) {
    return { availability: "model-unavailable", message: `模型 ${modelId} 已不在该配置中，历史保持不变` };
  }
  return { availability: "available" };
}

/** History attribution: original provider/model ids, never a substitute. */
export function describeHistoryAttribution(
  providers: readonly ProviderProfile[],
  call: { providerId: string; model: string },
): { providerId: string; providerName: string | null; model: string; modelName: string | null; availability: ProviderAvailability; message?: string } {
  const provider = providers.find((item) => item.id === call.providerId);
  const model = provider?.models.find((item) => item.id === call.model);
  const described = describeProviderAvailability({
    ...(provider !== undefined ? { provider } : {}),
    modelId: call.model,
  });
  return {
    providerId: call.providerId,
    providerName: provider?.name ?? null,
    model: call.model,
    modelName: model ? modelDisplayName(model) : null,
    availability: described.availability,
    ...(described.message !== undefined ? { message: described.message } : {}),
  };
}

/** Provider status view: availability, auth *presence* (never the value) and issues. */
export function describeProviderStatus(profile: ProviderProfile): ProviderStatusView {
  const described = describeProviderAvailability({ provider: profile });
  return {
    availability: described.availability,
    ...(described.message !== undefined ? { availabilityMessage: described.message } : {}),
    auth: profile.authRef !== undefined && profile.authRef.trim().length > 0 ? "reference" : "none",
    issues: validateProviderDraft({
      name: profile.name,
      protocol: profile.protocol,
      baseUrl: profile.baseUrl,
      ...(profile.authRef !== undefined ? { authRef: profile.authRef } : {}),
      models: profile.models,
    }),
  };
}

/** Raw (unformatted) token count: never abbreviated, so 214000 is not shown as 214k. */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Math.max(0, Math.round(value)));
}

export interface ContextDisplay {
  /** Window in k Tokens (`0` = unknown). */
  window: number;
  /** Occupancy in k Tokens. */
  used: number;
  source: ContextSource;
  /** `null` while the window is unknown. */
  percent: number | null;
  /** Marker shown next to the numbers: `估算` / `待更新` / empty for a measured value. */
  marker: string;
  /** Unformatted occupancy / window / percentage line. */
  occupancyLabel: string;
  /** Estimated remaining tokens; `null` while the window is unknown. */
  remainingTokens: number | null;
}

/** Occupancy readout: unformatted tokens, an explicit estimate/pending marker and no stale exact value. */
export function describeContextDisplay(input: { used: number; window: number; source: ContextSource }): ContextDisplay {
  const marker = input.source === "estimated" ? "估算" : input.source === "pending" ? "待更新" : input.source === "unknown" ? "待更新" : "";
  const windowKnown = isPositiveInteger(input.window);
  const percent = windowKnown ? (input.used * 100) / input.window : null;
  const remainingTokens = windowKnown ? Math.max(0, (input.window - input.used) * 1000) : null;
  const parts = [
    `占用 ${formatTokens(input.used * 1000)} Tokens`,
    windowKnown ? `上限 ${formatTokens(input.window * 1000)} Tokens` : "上限未知",
  ];
  if (percent !== null) parts.push(`${percent.toFixed(1)}%`);
  if (marker.length > 0) parts.push(marker);
  return { window: input.window, used: input.used, source: input.source, percent, marker, occupancyLabel: parts.join(" · "), remainingTokens };
}

export interface PickerModel {
  id: string;
  label: string;
  contextWindow: number;
  maxOutput?: number;
  supportsImages: boolean;
  selected: boolean;
  /** Reason the row cannot be picked (greyed out), when any. */
  disabledReason?: string;
}

export interface PickerGroup {
  providerId: string;
  providerName: string;
  protocol: string;
  enabled: boolean;
  availability: ProviderAvailability;
  models: PickerModel[];
}

/**
 * Model picker groups: grouped by provider, filtered by provider name/id and
 * model id/display name, with the current selection marked, per-model capacity
 * + image capability shown and the over-limit rows greyed with their numbers.
 */
export function buildModelPickerGroups(input: {
  providers: readonly ProviderProfile[];
  query?: string;
  currentProviderId?: string;
  currentModelId?: string;
  contextUsed: number;
  contextSource: ContextSource;
}): PickerGroup[] {
  const query = (input.query ?? "").trim().toLowerCase();
  const groups: PickerGroup[] = [];
  for (const provider of input.providers) {
    const described = describeProviderAvailability({ provider });
    const providerMatches =
      query.length === 0 ||
      `${provider.name} ${provider.id} ${provider.protocol}`.toLowerCase().includes(query);
    const models: PickerModel[] = [];
    for (const model of provider.models) {
      const modelMatches =
        query.length === 0 || providerMatches || `${model.id} ${modelDisplayName(model)}`.toLowerCase().includes(query);
      if (!modelMatches) continue;
      const decision = evaluateSessionModelSwitch({
        running: false,
        provider,
        model,
        contextUsed: input.contextUsed,
        contextSource: input.contextSource,
      });
      const disabledReason = decision.ok
        ? undefined
        : decision.refusal.code === "provider-disabled"
          ? "Provider 已停用"
          : decision.refusal.message;
      models.push({
        id: model.id,
        label: modelDisplayName(model),
        contextWindow: model.contextWindow,
        ...(model.maxOutput !== undefined ? { maxOutput: model.maxOutput } : {}),
        supportsImages: model.supportsImages === true,
        selected: provider.id === input.currentProviderId && model.id === input.currentModelId,
        ...(disabledReason !== undefined ? { disabledReason } : {}),
      });
    }
    if (models.length === 0) continue;
    groups.push({
      providerId: provider.id,
      providerName: provider.name,
      protocol: provider.protocol,
      enabled: provider.enabled,
      availability: described.availability,
      models,
    });
  }
  return groups;
}

/** Flattened picker order (used by the arrow keys / Enter). */
export function flattenPickerGroups(groups: readonly PickerGroup[]): { group: PickerGroup; model: PickerModel }[] {
  return groups.flatMap((group) => group.models.map((model) => ({ group, model })));
}

/** Wrap-around cursor movement for ↑/↓ (Home/End use the bounds directly). */
export function movePickerCursor(length: number, current: number, delta: number): number {
  if (length <= 0) return -1;
  const next = (current + delta) % length;
  return next < 0 ? next + length : next;
}

/** First selectable row index (a greyed row is skipped), or -1 when none is selectable. */
export function firstSelectablePickerIndex(rows: readonly { model: PickerModel }[]): number {
  return rows.findIndex((row) => row.model.disabledReason === undefined);
}
