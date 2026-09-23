/**
 * Provider profile / model-row rules for [PiDock 11] #9.
 *
 * Pure rules shared by the Host-side session switch, the app-level provider
 * store and the renderer-facing status view:
 *
 * - profile + per-model row validation (positive-integer context window /
 *   max output, duplicate model ids, per-model image capability, reasoning
 *   tiers that follow the catalog / declare a per-model subset),
 * - display-name follow rules (follows the model id until the user edits it;
 *   clearing the name restores the follow),
 * - discovered-candidate merging that only ever updates candidates,
 * - model-switch evaluation with strict `>`/`=`/`<` context bounds and
 *   fail-closed unknown-window / pending-occupancy / busy-round cases,
 * - history attribution that keeps the original provider + model and reports
 *   an unavailable configuration instead of silently substituting another.
 *
 * Credentials never enter this module: a profile carries an auth *reference*,
 * a literal secret is rejected, and the renderer-facing view is redacted.
 */

import { isProviderProtocol } from "./provider-protocol.js";

/** Canonical reasoning-level order (prototype's `REASONING_LABELS`). */
export const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export type ModelThinkingMode = "auto" | "none" | "custom";

export interface ProviderThinkingRow {
  mode: ModelThinkingMode;
  /** Selectable levels when `mode === "custom"` (contiguous subset, see `validateThinkingRow`). */
  levels: string[];
  /** Model default level; a session may override it. */
  default: string;
}

export interface ProviderModelRow {
  id: string;
  /**
   * Display name. Absent means "follow the model id"; `followModelName`
   * keeps that state across edits/saves.
   */
  name?: string;
  /** Context window in k Tokens (positive integer; the renderer shows `N k`). */
  contextWindow: number;
  /** Max output in k Tokens (positive integer, never above the context window). */
  maxOutput?: number;
  /** Image input support. Declared per model — never inferred from the model id. */
  supportsImages?: boolean;
  /** Reasoning tiers; absent means the catalog is unknown (mode `auto`). */
  thinking?: ProviderThinkingRow;
}

export interface ProviderProfileRow {
  id: string;
  name: string;
  /** Explicit protocol id; see `resolveProtocol` in `provider-protocol.ts`. */
  protocol: string;
  baseUrl: string;
  /**
   * Reference to an entry in the machine-private configuration (env key /
   * keychain label). Never the secret itself.
   */
  authRef?: string;
  enabled: boolean;
  models: ProviderModelRow[];
}

export type ProviderConfigErrorCode =
  | "provider-name-required"
  | "model-required"
  | "model-id-required"
  | "model-id-duplicate"
  | "context-window-invalid"
  | "max-output-invalid"
  | "max-output-exceeds-window"
  | "thinking-mode-unknown"
  | "thinking-levels-empty"
  | "thinking-level-unknown"
  | "thinking-level-duplicate"
  | "thinking-default-not-in-levels";

export interface ProviderConfigIssue {
  code: ProviderConfigErrorCode | "base-url-required" | "credentials-in-url" | "auth-ref-invalid" | "auth-ref-looks-like-secret" | "protocol-required" | "protocol-unsupported";
  /** Field the issue can be located at (list page / edit form). */
  field: string;
  message: string;
}

export type ProviderValidation =
  | { ok: true; profile: ProviderProfileRow }
  | { ok: false; error: ProviderConfigIssue };

/**
 * A literal credential, never a reference. Used to reject a profile whose
 * "reference" is really the secret (which would then be persisted, displayed
 * and logged).
 */
export function isSecretLike(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (/^(sk|pk|rk|ghp|gho|ghs|xox[baprs])[-_]/i.test(trimmed)) return true;
  if (/^bearer\s+/i.test(trimmed)) return true;
  // Long high-entropy blob (letters + digits, no whitespace).
  return !/\s/.test(trimmed) && /[A-Za-z]/.test(trimmed) && /\d/.test(trimmed) && /^[A-Za-z0-9+/=_.:-]{32,}$/.test(trimmed);
}

/** A reference is a short identifier, not a value: no whitespace, no secret shape. */
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

function validateThinkingRow(id: string, thinking: unknown): ProviderConfigIssue | null {
  if (typeof thinking !== "object" || thinking === null || Array.isArray(thinking)) {
    return { code: "thinking-mode-unknown", field: `models.${id}.thinking`, message: "推理配置必须是 {mode, levels, default}" };
  }
  const row = thinking as Record<string, unknown>;
  const mode = row["mode"];
  if (mode !== "auto" && mode !== "none" && mode !== "custom") {
    return { code: "thinking-mode-unknown", field: `models.${id}.thinking.mode`, message: "推理模式必须是 auto / none / custom" };
  }
  if (mode !== "custom") return null;
  const levels = row["levels"];
  if (!Array.isArray(levels) || levels.length === 0) {
    return { code: "thinking-levels-empty", field: `models.${id}.thinking.levels`, message: "自定义推理档位不能为空" };
  }
  const seen = new Set<string>();
  for (const level of levels) {
    if (typeof level !== "string" || !(REASONING_LEVELS as readonly string[]).includes(level)) {
      return { code: "thinking-level-unknown", field: `models.${id}.thinking.levels`, message: `未知推理档位：${String(level)}` };
    }
    if (seen.has(level)) {
      return { code: "thinking-level-duplicate", field: `models.${id}.thinking.levels`, message: `推理档位重复：${level}` };
    }
    seen.add(level);
  }
  // 自定义档位子集: the subset may omit catalog levels (that is the point of a
  // per-model declaration); it must not invent, repeat or leave the default
  // outside the declared set. A stored session preference that names an
  // undeclared level is handled by `resolveSessionThinking` (stale pref).
  const fallback = row["default"];
  if (typeof fallback !== "string" || !seen.has(fallback)) {
    return { code: "thinking-default-not-in-levels", field: `models.${id}.thinking.default`, message: "默认推理档位必须在可用档位内" };
  }
  return null;
}

/**
 * Validate one profile (+ its model rows). Fail-closed: the first problem is
 * returned with the field it can be located at. Per-model capabilities are
 * taken only from the declared row — nothing is inferred from a model id.
 */
export function validateProviderProfile(input: unknown): ProviderValidation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: { code: "provider-name-required", field: "name", message: "Provider 配置必须是对象" } };
  }
  const record = input as Record<string, unknown>;
  const name = typeof record["name"] === "string" ? record["name"].trim() : "";
  if (name.length === 0) {
    return { ok: false, error: { code: "provider-name-required", field: "name", message: "请填写 Provider 名称" } };
  }
  const protocol = record["protocol"];
  if (protocol === undefined || protocol === null || protocol === "" || typeof protocol !== "string") {
    return { ok: false, error: { code: "protocol-required", field: "protocol", message: "请显式选择协议；不按供应商名或地址猜测协议" } };
  }
  if (!isProviderProtocol(protocol)) {
    return { ok: false, error: { code: "protocol-unsupported", field: "protocol", message: `不支持的协议：${protocol}` } };
  }
  const baseUrl = typeof record["baseUrl"] === "string" ? record["baseUrl"].trim() : "";
  if (baseUrl.length === 0) {
    return { ok: false, error: { code: "base-url-required", field: "baseUrl", message: "请填写服务地址" } };
  }
  if (/\/\/[^/@\s]+:[^/@\s]+@/.test(baseUrl)) {
    return { ok: false, error: { code: "credentials-in-url", field: "baseUrl", message: "服务地址不能内嵌凭据，请改用本机私有配置的认证引用" } };
  }
  const rawAuthRef = record["authRef"];
  let authRef: string | undefined;
  if (rawAuthRef !== undefined && rawAuthRef !== null && rawAuthRef !== "") {
    if (typeof rawAuthRef !== "string") {
      return { ok: false, error: { code: "auth-ref-invalid", field: "authRef", message: "认证引用必须是字符串" } };
    }
    const trimmed = rawAuthRef.trim();
    if (isSecretLike(trimmed)) {
      return { ok: false, error: { code: "auth-ref-looks-like-secret", field: "authRef", message: "认证引用不能是凭据明文，请填写本机私有配置的引用名" } };
    }
    if (!isAuthReference(trimmed)) {
      return { ok: false, error: { code: "auth-ref-invalid", field: "authRef", message: "认证引用只能是短引用名，不能包含空格或凭据字符" } };
    }
    authRef = trimmed;
  }
  const rawModels = record["models"];
  if (!Array.isArray(rawModels) || rawModels.length === 0) {
    return { ok: false, error: { code: "model-required", field: "models", message: "请至少填写一个模型" } };
  }
  const models: ProviderModelRow[] = [];
  const seenIds = new Set<string>();
  for (const entry of rawModels) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, error: { code: "model-id-required", field: "models", message: "模型行必须是对象" } };
    }
    const row = entry as Record<string, unknown>;
    const id = typeof row["id"] === "string" ? row["id"].trim() : "";
    if (id.length === 0) {
      return { ok: false, error: { code: "model-id-required", field: "models", message: "模型 ID 不能为空，可手填列表外的 ID" } };
    }
    if (seenIds.has(id)) {
      return { ok: false, error: { code: "model-id-duplicate", field: `models.${id}`, message: `同一 Provider 中的模型 ID 不可重复：${id}` } };
    }
    seenIds.add(id);
    const contextWindow = row["contextWindow"];
    if (!isPositiveInteger(contextWindow)) {
      return { ok: false, error: { code: "context-window-invalid", field: `models.${id}.contextWindow`, message: "上下文窗口必须为正整数 Tokens" } };
    }
    const rawMaxOutput = row["maxOutput"];
    let maxOutput: number | undefined;
    if (rawMaxOutput !== undefined && rawMaxOutput !== null) {
      if (!isPositiveInteger(rawMaxOutput)) {
        return { ok: false, error: { code: "max-output-invalid", field: `models.${id}.maxOutput`, message: "最大输出必须为正整数 Tokens" } };
      }
      if (rawMaxOutput > contextWindow) {
        return {
          ok: false,
          error: { code: "max-output-exceeds-window", field: `models.${id}.maxOutput`, message: "最大输出不能超过上下文窗口" },
        };
      }
      maxOutput = rawMaxOutput;
    }
    const rawImages = row["supportsImages"];
    if (rawImages !== undefined && typeof rawImages !== "boolean") {
      return { ok: false, error: { code: "model-id-required", field: `models.${id}.supportsImages`, message: "图片输入能力必须是布尔值" } };
    }
    if (row["thinking"] !== undefined) {
      const thinkingIssue = validateThinkingRow(id, row["thinking"]);
      if (thinkingIssue !== null) return { ok: false, error: thinkingIssue };
    }
    const displayName = typeof row["name"] === "string" ? row["name"].trim() : "";
    models.push({
      id,
      ...(displayName.length > 0 ? { name: displayName } : {}),
      contextWindow,
      ...(maxOutput !== undefined ? { maxOutput } : {}),
      ...(rawImages === true ? { supportsImages: true } : {}),
      ...(row["thinking"] !== undefined ? { thinking: row["thinking"] as ProviderThinkingRow } : {}),
    });
  }
  const id = typeof record["id"] === "string" ? record["id"].trim() : "";
  const enabled = record["enabled"] !== false;
  return {
    ok: true,
    profile: {
      id,
      name,
      protocol,
      baseUrl,
      ...(authRef !== undefined ? { authRef } : {}),
      enabled,
      models,
    },
  };
}

/** Display name resolution: an absent name shows the model id (follow state). */
export function resolveModelDisplayName(model: { id: string; name?: string }): string {
  const name = model.name?.trim();
  return name !== undefined && name.length > 0 ? name : model.id;
}

export interface ModelNameState {
  name?: string;
  /** True while the name mirrors the model id. */
  followsId: boolean;
}

/**
 * Display-name follow rule: while following, the name mirrors the model id;
 * editing it to a different non-empty value stops the follow; clearing it (or
 * editing it back to the id) restores the follow.
 */
export function followModelName(id: string, edited: string): ModelNameState {
  const next = edited.trim();
  if (next.length === 0 || next === id) return { name: undefined, followsId: true };
  return { name: next, followsId: false };
}

/** Next name state after the model id itself changed (a followed name re-mirrors it). */
export function followModelNameOnIdChange(current: ModelNameState): ModelNameState {
  return current.followsId ? { name: undefined, followsId: true } : { name: current.name, followsId: false };
}

export interface DiscoveryCandidateSet {
  providerId: string;
  /** Candidate model ids (never configured rows). */
  candidates: string[];
  /** Provider connection this set came from; a changed connection invalidates it. */
  fingerprint: string;
}

export interface DiscoveryMerge {
  /** Deduped candidate ids in discovery order. */
  candidates: string[];
  /** Configured model ids that also appear as candidates. */
  matchedConfigured: string[];
  /** Configured model ids missing from the candidate list — kept, never removed. */
  unmatchedConfigured: string[];
  /** Candidate ids not configured — offered for adding, never auto-added. */
  unmatchedCandidates: string[];
}

/**
 * Merge discovered candidates with the configured rows. Sync only refreshes
 * *candidates*: configured rows are never overwritten, auto-added or removed
 * (the operator decides), and no capability is inferred from a candidate id.
 */
export function mergeDiscoveryCandidates(input: {
  configured: readonly { id: string }[];
  candidates: readonly unknown[];
}): DiscoveryMerge {
  const configuredIds = input.configured.map((model) => model.id);
  const configuredSet = new Set(configuredIds);
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const candidate of input.candidates) {
    if (typeof candidate !== "string") continue;
    const id = candidate.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    candidates.push(id);
  }
  return {
    candidates,
    matchedConfigured: configuredIds.filter((id) => seen.has(id)),
    unmatchedConfigured: configuredIds.filter((id) => !seen.has(id)),
    unmatchedCandidates: candidates.filter((id) => !configuredSet.has(id)),
  };
}

/** Connection identity for discovery: protocol + address (never credentials). */
export function connectionFingerprint(connection: { protocol: string; baseUrl: string }): string {
  return `${connection.protocol}::${connection.baseUrl.trim()}`;
}

/** True when the recorded candidate set belongs to a different connection. */
export function candidateSetIsStale(set: DiscoveryCandidateSet, connection: { protocol: string; baseUrl: string }): boolean {
  return set.fingerprint !== connectionFingerprint(connection);
}

/** Which reasoning levels a model actually offers, and what a stored preference means. */
export type ThinkingCatalog = "catalog-unknown" | "unsupported" | "declared";

/**
 * Session reasoning level for a model: a stored preference is used only while
 * the model still declares it (跳级/旧偏好失效 otherwise), falling back to the
 * model default and reporting the stale value instead of coercing it.
 */
export function resolveSessionThinking(
  model: { thinking?: ProviderThinkingRow },
  stored: string | undefined,
): { catalog: ThinkingCatalog; level: string; source: "session" | "model-default" | "none"; stale?: string } {
  const thinking = model.thinking;
  if (thinking === undefined || thinking.mode === "auto") {
    return { catalog: "catalog-unknown", level: stored ?? "", source: stored === undefined ? "none" : "session" };
  }
  if (thinking.mode === "none") {
    return { catalog: "unsupported", level: "", source: "none" };
  }
  if (stored === undefined) return { catalog: "declared", level: thinking.default, source: "model-default" };
  if (!thinking.levels.includes(stored)) return { catalog: "declared", level: thinking.default, source: "model-default", stale: stored };
  return { catalog: "declared", level: stored, source: "session" };
}

export type ThinkingRefusalCode = "thinking-unsupported" | "thinking-catalog-unknown" | "thinking-level-not-declared" | "thinking-required";

/**
 * Decide whether a level may be selected for a model.
 *
 * - `none`: the model does not support reasoning — no level, incl. `off`, is
 *   selectable.
 * - `auto`/absent: the catalog is unknown, so an explicit level is accepted
 *   (it follows the catalog) but clearing it is refused: without the declared
 *   set the app cannot claim reasoning is off (不可关闭).
 * - `custom`: the level must be one of the declared tiers; clearing is refused
 *   unless the model declares `off`.
 */
export function evaluateThinkingSelection(input: {
  thinking?: ProviderThinkingRow;
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
  /** Occupancy in k Tokens, present for the context-fit refusals. */
  occupancy?: number;
  /** Target window in k Tokens, present for the context-fit refusals. */
  limit?: number;
}

export interface SwitchTarget {
  providerId: string;
  modelId: string;
  /** Target context window in k Tokens; `0`/non-integer means unknown (fail closed). */
  contextWindow: number;
  enabled: boolean;
  /** False when the model no longer exists in the provider's configured list. */
  exists: boolean;
}

export interface SwitchOccupancy {
  /** Session context usage in k Tokens as last reported. */
  used: number;
  /**
   * `actual` = measured; `estimated` = derived estimate; `pending` = the
   * occupancy is being recomputed (compaction/turn in flight); `unknown`.
   */
  source: "actual" | "estimated" | "pending" | "unknown";
}

/**
 * Decide whether a model switch may run now.
 *
 * Fail-closed ordering: a busy round/tool/compaction first (the switch waits
 * for the current execution to end or the user stops it), then provider/model
 * availability, then the context bound. The context bound is strict:
 * `used > window` refuses, `used === window` and `used < window` pass. An
 * unknown window or an unknown/pending occupancy is never treated as a zero
 * pass. The caller must re-run this immediately before executing the switch.
 */
export function evaluateModelSwitch(input: {
  running: boolean;
  /** Human label of the busy work, e.g. 工具执行中 / 上下文压缩中. */
  busyLabel?: string;
  target: SwitchTarget | null;
  occupancy: SwitchOccupancy;
}): { ok: true } | { ok: false; error: SwitchRefusal } {
  if (input.running) {
    const label = input.busyLabel ?? "当前执行";
    return { ok: false, error: { code: "busy-round", message: `${label}尚未结束，请先等待完成或停止当前执行后再切换模型` } };
  }
  if (input.target === null) {
    return { ok: false, error: { code: "model-unavailable", message: "目标模型不可用，请重新选择" } };
  }
  const { target } = input;
  if (!target.enabled) {
    return { ok: false, error: { code: "provider-disabled", message: `Provider ${target.providerId} 已停用，请先启用或选择其他配置` } };
  }
  if (!target.exists) {
    return { ok: false, error: { code: "model-unavailable", message: `模型 ${target.modelId} 已不在该 Provider 的配置中，历史保持不变` } };
  }
  if (!isPositiveInteger(target.contextWindow)) {
    return { ok: false, error: { code: "context-window-unknown", message: "目标模型的上下文窗口未知，不能按零占用放行" } };
  }
  const occupancy = input.occupancy;
  if (occupancy.source === "unknown" || occupancy.source === "pending" || !Number.isFinite(occupancy.used) || occupancy.used < 0) {
    return {
      ok: false,
      error: { code: "context-occupancy-unknown", message: "上下文占用待更新，尚不能判定是否超限；请等待占用更新后再切换" },
    };
  }
  if (occupancy.used > target.contextWindow) {
    return {
      ok: false,
      error: {
        code: "context-over-limit",
        message: `当前上下文占用 ${occupancy.used * 1000} Tokens 超过目标模型上限 ${target.contextWindow * 1000} Tokens`,
        occupancy: occupancy.used,
        limit: target.contextWindow,
      },
    };
  }
  return { ok: true };
}

export type ProviderAvailability =
  | { status: "available" }
  | { status: "disabled"; message: string }
  | { status: "missing"; message: string }
  | { status: "model-unavailable"; message: string };

/**
 * Availability of the provider/model a persisted record (history call,
 * schedule, session) names. A missing or disabled configuration reports
 * unavailable — it never substitutes another provider/model.
 */
export function resolveProviderAvailability(input: {
  exists: boolean;
  enabled?: boolean;
  model?: string;
  models?: readonly string[];
}): ProviderAvailability {
  if (!input.exists) {
    return { status: "missing", message: "该配置已不存在，会话与历史仍按原 Provider 归属显示" };
  }
  if (input.enabled === false) {
    return { status: "disabled", message: "该配置已停用，请重新启用或显式选择其他配置" };
  }
  if (input.model !== undefined && input.models !== undefined && !input.models.includes(input.model)) {
    return { status: "model-unavailable", message: `模型 ${input.model} 已不在该配置中，历史保持不变` };
  }
  return { status: "available" };
}

export interface HistoryAttribution {
  providerId: string;
  /** Original provider name, or `null` when the configuration is gone. */
  providerName: string | null;
  model: string;
  /** Original model display name at call time, or `null`. */
  modelName: string | null;
  availability: ProviderAvailability;
}

/** History attribution for one persisted call: original ids, never a substitute. */
export function describeHistoryAttribution(
  call: { providerId: string; model: string },
  profiles: readonly ProviderProfileRow[],
): HistoryAttribution {
  const provider = profiles.find((item) => item.id === call.providerId);
  if (!provider) {
    return {
      providerId: call.providerId,
      providerName: null,
      model: call.model,
      modelName: null,
      availability: resolveProviderAvailability({ exists: false }),
    };
  }
  const model = provider.models.find((item) => item.id === call.model);
  return {
    providerId: call.providerId,
    providerName: provider.name,
    model: call.model,
    modelName: model ? resolveModelDisplayName(model) : null,
    availability: resolveProviderAvailability({
      exists: true,
      enabled: provider.enabled,
      model: call.model,
      models: provider.models.map((item) => item.id),
    }),
  };
}

export type AuthStatus = "reference" | "none" | "missing";

export interface ProviderStatusView {
  id: string;
  name: string;
  protocol: string;
  enabled: boolean;
  modelCount: number;
  /** Model ids shown in the availability list (ids only, no capabilities inferred). */
  modelIds: string[];
  availability: ProviderAvailability;
  auth: AuthStatus;
  /** Locatable validation problems (field + code + message). */
  issues: ProviderConfigIssue[];
}

/**
 * Renderer-facing provider status: availability + authentication state and
 * locatable validation issues. The auth *reference value* never leaves the
 * Host: `auth` reports whether a reference is configured, not what it is.
 */
export function describeProviderStatus(profile: ProviderProfileRow): ProviderStatusView {
  const validation = validateProviderProfile(profile);
  const issues: ProviderConfigIssue[] = validation.ok ? [] : [validation.error];
  return {
    id: profile.id,
    name: profile.name,
    protocol: profile.protocol,
    enabled: profile.enabled,
    modelCount: profile.models.length,
    modelIds: profile.models.map((model) => model.id),
    availability: resolveProviderAvailability({ exists: true, enabled: profile.enabled }),
    auth: profile.authRef !== undefined ? "reference" : "none",
    issues,
  };
}

/**
 * Redacted profile for the renderer / logs / shared template: the auth
 * reference value is replaced by its presence, so a name that happens to be
 * sensitive still cannot leak through a display copy.
 */
export function redactProviderProfile(profile: ProviderProfileRow): Omit<ProviderProfileRow, "authRef"> & {
  authRefPresent: boolean;
} {
  const { authRef, ...rest } = profile;
  return { ...rest, authRefPresent: authRef !== undefined };
}
