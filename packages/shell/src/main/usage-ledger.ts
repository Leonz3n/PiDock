/**
 * Per-call usage detail and aggregation rules for [PiDock 12] #12.
 *
 * One stable call record -> one persistable usage detail. The rules here
 * decide what a provider report means (a field the upstream never sent is
 * *unknown*, not zero), how details aggregate without double counting
 * (reasoning is inside output; a provider total is never re-added), how a
 * streamed/final/replayed event updates the same call instead of appending a
 * new one, and how boundaries/grouping stay deterministic across machines.
 *
 * Zero declarations of the Provider/usage concepts live anywhere else: the
 * session channel, the Host and the renderer mirror all speak this shape.
 */

/** Where a usage number came from. Declared here as the single spelling. */
export type PiUsageSource = "actual" | "estimated" | "unreported" | "test-double" | "approval";

/**
 * What produced the model call. Compaction, branch summaries and model-typed
 * tool calls are counted under their own kind so consumption can be read per
 * type (and so a compaction never looks like a user turn).
 */
export type PiUsageKind = "turn" | "compaction" | "branch-summary" | "model-tool";

export const PI_USAGE_KINDS = ["turn", "compaction", "branch-summary", "model-tool"] as const;

export const PI_USAGE_KIND_LABELS: Record<PiUsageKind, string> = {
  turn: "回合",
  compaction: "压缩",
  "branch-summary": "分支摘要",
  "model-tool": "模型型工具",
};

/**
 * How the call ended. `awaiting-approval` is a settled attempt whose usage is
 * already reported (the model answered, the tool did not run); it is still
 * counted, never silently dropped.
 */
export type PiUsageEndState = "completed" | "failed" | "cancelled" | "awaiting-approval";

export const PI_USAGE_END_STATES = ["completed", "failed", "cancelled", "awaiting-approval"] as const;

export const PI_USAGE_END_STATE_LABELS: Record<PiUsageEndState, string> = {
  completed: "完成",
  failed: "失败",
  cancelled: "取消",
  "awaiting-approval": "待确认",
};

/**
 * How complete a provider report was. `missing` = the upstream never reported
 * usage (an SDK zero-initialised counter is `missing`, not a real zero);
 * `partial` = some counters reported, others unknown.
 */
export type PiUsageCompleteness = "reported" | "partial" | "missing";

/** Normalised counters plus the provenance needed to read them honestly. */
export interface PiCallUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  source: PiUsageSource;
  completeness: PiUsageCompleteness;
  /**
   * Reasoning tokens **reported inside `output`**. Displayed as a nested
   * "其中 reasoning" line only — never added to any output sum.
   */
  reasoning?: number;
  /**
   * Provider-reported grand total, kept for cross-checking. Never added to a
   * sum: cache counters are already part of it in some providers and absent in
   * others, so adding it would double count.
   */
  reportedTotal?: number;
}

const USAGE_COUNTER_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

export interface PiReportedUsage {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  reasoning?: unknown;
  totalTokens?: unknown;
}

/** A finite, non-negative integer, or `null` when the field is unusable. */
function reportedNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function assertUsageSource(source: PiUsageSource): void {
  if (source !== "actual" && source !== "estimated" && source !== "unreported" && source !== "test-double" && source !== "approval") {
    throw new Error(`invalid-payload: usageSource must be actual/estimated/unreported/test-double/approval, got ${String(source)}`);
  }
}

/**
 * Normalise one provider report.
 *
 * Fail-honest rules (spec: 未知用量不按零消耗处理):
 * - only fields the caller actually supplied count as reported;
 * - `source: "unreported"` marks the whole report as `missing` even when the
 *   numbers arrived as SDK zero-initialised values;
 * - `reasoning`/`totalTokens` are carried for display/cross-check and never
 *   enter the input/output/cache sums.
 */
export function normalizeReportedUsage(raw: PiReportedUsage | undefined, source: PiUsageSource = "test-double"): PiCallUsage {
  assertUsageSource(source);
  const counters = USAGE_COUNTER_KEYS.map((key) => reportedNumber(raw?.[key]));
  const present = counters.filter((value) => value !== null).length;
  const completeness: PiUsageCompleteness =
    source === "unreported" ? "missing" : present === USAGE_COUNTER_KEYS.length ? "reported" : present === 0 ? "missing" : "partial";
  const reasoning = reportedNumber(raw?.reasoning);
  const reportedTotal = reportedNumber(raw?.totalTokens);
  return {
    input: counters[0] ?? 0,
    output: counters[1] ?? 0,
    cacheRead: counters[2] ?? 0,
    cacheWrite: counters[3] ?? 0,
    source,
    completeness,
    ...(reasoning !== null ? { reasoning } : {}),
    ...(reportedTotal !== null ? { reportedTotal } : {}),
  };
}

/** True when this call carries at least one provider-reported counter. */
export function usageCarriesReport(usage: PiCallUsage | undefined): usage is PiCallUsage {
  return usage !== undefined && usage.completeness !== "missing";
}

/** Provider identity a call was made with. `name` is excluded on purpose. */
export interface PiProviderConfigIdentity {
  protocol: string;
  baseUrl: string;
  models: readonly { id: string }[];
}

/**
 * Stable version tag of one Provider configuration. Excludes the display name,
 * so renaming a Provider never rewrites historical statistics (spec box 8);
 * changing protocol/address/models does produce a new tag.
 */
export function providerConfigVersion(identity: PiProviderConfigIdentity): string {
  return `${identity.protocol}::${identity.baseUrl.trim()}::${identity.models.map((model) => model.id).join(",")}`;
}

/** Who a detail is attributed to when it is inherited by another session. */
export interface PiUsageOrigin {
  taskId: string;
  sessionId: string;
  callId: string;
}

export interface PiUsageDetail {
  /** Stable call identity — the ledger's primary key. */
  id: string;
  taskId: string;
  /**
   * Project the task belongs to. Optional: the Host owns task/session
   * attribution and knows no project mapping, so the dimension is attached
   * where that mapping exists (the statistics layer) instead of invented here.
   */
  projectId?: string;
  sessionId: string;
  providerId: string;
  /** `providerConfigVersion` at call time; a fingerprint, not an upstream version. */
  providerVersion: string;
  /** Model the call was made with. */
  requestModel: string;
  /** Model the response actually reported, when it differs/was reported. */
  responseModel?: string;
  kind: PiUsageKind;
  endState: PiUsageEndState;
  /** Call start, ISO string. */
  at: string;
  usage: PiCallUsage;
  /**
   * Set when this record is inherited (restore/branch/clone/re-import). The
   * original call keeps its own attribution; inherited copies are shown but
   * counted once (spec box 7).
   */
  origin?: PiUsageOrigin;
}

/** Identity a detail is counted under: its origin when inherited, else itself. */
export function countedIdentity(detail: PiUsageDetail): PiUsageOrigin {
  return detail.origin ?? { taskId: detail.taskId, sessionId: detail.sessionId, callId: detail.id };
}

/** Origin of a call record, when the channel knows it was inherited. */
export interface PiUsageDetailInput {
  callId: string;
  taskId: string;
  projectId?: string;
  sessionId: string;
  providerId: string;
  providerVersion: string;
  requestModel: string;
  responseModel?: string;
  kind: PiUsageKind;
  endState: PiUsageEndState;
  at: string;
  usage: PiCallUsage;
  origin?: PiUsageOrigin;
}

export function toUsageDetail(input: PiUsageDetailInput): PiUsageDetail {
  if (input.callId.trim().length === 0) throw new Error("invalid-payload: usage detail requires a call id");
  return {
    id: input.callId,
    taskId: input.taskId,
    ...(input.projectId !== undefined && input.projectId.length > 0 ? { projectId: input.projectId } : {}),
    sessionId: input.sessionId,
    providerId: input.providerId,
    providerVersion: input.providerVersion,
    requestModel: input.requestModel,
    ...(input.responseModel !== undefined && input.responseModel.length > 0 ? { responseModel: input.responseModel } : {}),
    kind: input.kind,
    endState: input.endState,
    at: input.at,
    usage: { ...input.usage },
    ...(input.origin !== undefined ? { origin: { ...input.origin } } : {}),
  };
}

export interface PiUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Reported reasoning, a subset of `output` (display only). */
  reasoning: number;
  calls: number;
  reported: number;
  partial: number;
  missing: number;
}

/**
 * Aggregate details. Only records that carry a report contribute counters;
 * `missing`/`partial` records are counted so the UI can say "N 次调用未报告"
 * instead of silently passing them as zero consumption.
 */
export function sumUsageDetails(details: readonly PiUsageDetail[]): PiUsageTotals {
  const totals: PiUsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0, reported: 0, partial: 0, missing: 0 };
  for (const detail of details) {
    totals.calls += 1;
    const usage = detail.usage;
    if (usage.completeness === "missing") {
      totals.missing += 1;
      continue;
    }
    totals[usage.completeness] += 1;
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.reasoning += usage.reasoning ?? 0;
  }
  return totals;
}

/** Drop inherited duplicates, keeping the copy that owns the call. */
export function dedupeInheritedUsage(details: readonly PiUsageDetail[]): PiUsageDetail[] {
  const byIdentity = new Map<string, PiUsageDetail>();
  for (const detail of details) {
    const identity = countedIdentity(detail);
    const key = `${identity.taskId}\u0000${identity.sessionId}\u0000${identity.callId}`;
    const existing = byIdentity.get(key);
    if (existing === undefined || (existing.origin !== undefined && detail.origin === undefined)) byIdentity.set(key, detail);
  }
  return [...byIdentity.values()];
}

/** Totals counted once per original call (inherited copies excluded). */
export function sumOwnedUsage(details: readonly PiUsageDetail[]): PiUsageTotals {
  return sumUsageDetails(dedupeInheritedUsage(details));
}

/**
 * Merge one report into the record it re-reports.
 *
 * The record is keyed by the call id, so the *owning* copy (the one without
 * `origin`) always supplies task/session attribution: an inherited copy shown
 * in another session must never move the call to the session that displays it.
 * The newest report wins the usage numbers and the earliest `at` is kept (a
 * call starts once).
 */
function mergeDetail(previous: PiUsageDetail, detail: PiUsageDetail): PiUsageDetail {
  const owner = previous.origin === undefined ? previous : detail;
  const merged: PiUsageDetail = { ...detail, id: previous.id, taskId: owner.taskId, sessionId: owner.sessionId, at: previous.at };
  if (owner.origin === undefined) delete merged.origin;
  else merged.origin = { ...owner.origin };
  return merged;
}

/**
 * Replay-safe merge: the same call id updates its record instead of adding a
 * new one, so streamed increments, the final message and a replayed event
 * never inflate a total. The earliest `at` wins and an inherited copy never
 * overwrites the owning record's attribution.
 */
export function mergeUsageDetails(existing: readonly PiUsageDetail[], incoming: readonly PiUsageDetail[]): PiUsageDetail[] {
  const byId = new Map<string, PiUsageDetail>();
  for (const detail of existing) byId.set(detail.id, detail);
  for (const detail of incoming) {
    const previous = byId.get(detail.id);
    byId.set(detail.id, previous === undefined ? detail : mergeDetail(previous, detail));
  }
  return [...byId.values()];
}

/** Declared timezone offset for date-only boundaries (Asia/Shanghai). */
export const USAGE_TIMEZONE_OFFSET_MINUTES = 8 * 60;

/**
 * Version tag for a call whose provider configuration fingerprint was never
 * captured (records written before [PiDock 12] #12). Kept explicit so a
 * missing fingerprint is never shown as a real configuration version.
 */
export const UNVERSIONED_PROVIDER_CONFIG = "unversioned";

export interface PiUsageRange {
  /** Inclusive lower bound as supplied (`YYYY-MM-DD` or ISO instant). */
  from?: string;
  /** Inclusive upper bound as supplied (`YYYY-MM-DD` or ISO instant). */
  to?: string;
}

export interface PiUsageWindow {
  fromMs: number | null;
  toMs: number | null;
  /** Human-readable boundary description used in the UI definitions panel. */
  label: string;
  offsetMinutes: number;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Epoch ms of an ISO instant, or `null` when the value is unusable. */
export function parseUsageInstant(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Resolve a filter range on one declared timezone. A date-only bound means
 * "start of that day" for `from` and "end of that day" for `to`, both in the
 * declared offset regardless of the host machine's timezone, so two machines
 * bucket the same records identically. Instants keep their own offset.
 */
export function resolveUsageWindow(range: PiUsageRange, offsetMinutes: number = USAGE_TIMEZONE_OFFSET_MINUTES): PiUsageWindow {
  const boundary = (value: string | undefined, endOfDay: boolean): number | null => {
    if (value === undefined || value.trim().length === 0) return null;
    const trimmed = value.trim();
    if (!DATE_ONLY.test(trimmed)) return parseUsageInstant(trimmed);
    const [year, month, day] = trimmed.split("-").map((part) => Number.parseInt(part, 10));
    const startOfDayUtc = Date.UTC(year, month - 1, day) - offsetMinutes * 60_000;
    return endOfDay ? startOfDayUtc + 24 * 60 * 60_000 - 1 : startOfDayUtc;
  };
  const fromMs = boundary(range.from, false);
  const toMs = boundary(range.to, true);
  const zone = formatOffset(offsetMinutes);
  const describe = (value: string | undefined, endOfDay: boolean): string => {
    if (value === undefined || value.trim().length === 0) return endOfDay ? "不限" : "最早";
    const trimmed = value.trim();
    return DATE_ONLY.test(trimmed) ? (endOfDay ? `${trimmed} 当日结束` : `${trimmed} 当日开始`) : trimmed;
  };
  return {
    fromMs,
    toMs,
    label: `${describe(range.from, false)} → ${describe(range.to, true)}（UTC${zone}，含边界）`,
    offsetMinutes,
  };
}

function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` bucket key of an instant in the declared timezone. */
export function usageDayKey(at: string, offsetMinutes: number = USAGE_TIMEZONE_OFFSET_MINUTES): string | null {
  const instant = parseUsageInstant(at);
  if (instant === null) return null;
  return new Date(instant + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

export interface PiUsageFilter extends PiUsageRange {
  taskId?: string;
  /**
   * Host-written details never carry a project (the Host knows no task ->
   * project mapping), so a Host-side filter on this dimension matches nothing
   * and always has. The statistics layer applies the project join after the
   * RPC instead of inventing one here.
   */
  projectId?: string;
  sessionId?: string;
  providerId?: string;
  model?: string;
  kind?: PiUsageKind;
}

/**
 * Filter by the same windows the statistics page offers. A record with an
 * unparsable `at` is kept only when no time bound was given (it is real
 * consumption; dropping it would understate) and is reported by
 * `unparsableUsageTimes` for the UI to flag.
 */
export function filterUsageDetails(details: readonly PiUsageDetail[], filter: PiUsageFilter, offsetMinutes: number = USAGE_TIMEZONE_OFFSET_MINUTES): PiUsageDetail[] {
  const window = resolveUsageWindow(filter, offsetMinutes);
  return details.filter((detail) => {
    if (filter.taskId !== undefined && detail.taskId !== filter.taskId) return false;
    if (filter.projectId !== undefined && detail.projectId !== filter.projectId) return false;
    if (filter.sessionId !== undefined && detail.sessionId !== filter.sessionId) return false;
    if (filter.providerId !== undefined && detail.providerId !== filter.providerId) return false;
    if (filter.model !== undefined && detail.requestModel !== filter.model && detail.responseModel !== filter.model) return false;
    if (filter.kind !== undefined && detail.kind !== filter.kind) return false;
    if (window.fromMs === null && window.toMs === null) return true;
    const instant = parseUsageInstant(detail.at);
    if (instant === null) return false;
    if (window.fromMs !== null && instant < window.fromMs) return false;
    if (window.toMs !== null && instant > window.toMs) return false;
    return true;
  });
}

/** Grouping key for details whose project dimension is not recorded. */
export const UNRECORDED_PROJECT = "未记录项目";

/** Details whose `at` cannot be placed on the time axis. */
export function unparsableUsageTimes(details: readonly PiUsageDetail[]): string[] {
  return details.filter((detail) => parseUsageInstant(detail.at) === null).map((detail) => detail.id);
}

export type PiUsageGroupBy = "project" | "task" | "session" | "provider" | "model" | "kind" | "day";

export const PI_USAGE_GROUP_BY: readonly PiUsageGroupBy[] = ["project", "task", "session", "provider", "model", "kind", "day"];

export const PI_USAGE_GROUP_LABELS: Record<PiUsageGroupBy, string> = {
  project: "项目",
  task: "任务",
  session: "会话",
  provider: "Provider",
  model: "模型",
  kind: "调用类型",
  day: "日期",
};

export interface PiUsageGroup {
  key: string;
  label: string;
  totals: PiUsageTotals;
}

/**
 * Group for the statistics page. Grouping counts an inherited copy under its
 * *origin* owner, so a clone/branch shows the entries without inflating the
 * owner's totals twice.
 */
export function groupUsageDetails(
  details: readonly PiUsageDetail[],
  groupBy: PiUsageGroupBy,
  offsetMinutes: number = USAGE_TIMEZONE_OFFSET_MINUTES,
): PiUsageGroup[] {
  const buckets = new Map<string, PiUsageDetail[]>();
  for (const detail of details) {
    const identity = detail.origin ?? { taskId: detail.taskId, sessionId: detail.sessionId, callId: detail.id };
    const key =
      groupBy === "project"
        ? (detail.projectId ?? UNRECORDED_PROJECT)
        : groupBy === "task"
          ? identity.taskId
          : groupBy === "session"
            ? `${identity.taskId} · ${identity.sessionId}`
            : groupBy === "provider"
              ? detail.providerId
              : groupBy === "model"
                ? detail.requestModel
                : groupBy === "kind"
                  ? detail.kind
                  : (usageDayKey(detail.at, offsetMinutes) ?? "时间未知");
    buckets.set(key, [...(buckets.get(key) ?? []), detail]);
  }
  return [...buckets.entries()]
    .map(([key, items]) => ({ key, label: groupLabel(key, groupBy), totals: sumUsageDetails(dedupeInheritedUsage(items)) }))
    .sort((a, b) => b.totals.input + b.totals.output - (a.totals.input + a.totals.output) || a.key.localeCompare(b.key));
}

function groupLabel(key: string, groupBy: PiUsageGroupBy): string {
  if (groupBy === "kind") return PI_USAGE_KIND_LABELS[key as PiUsageKind] ?? key;
  return key;
}

/**
 * Cleanup scope. Archiving keeps usage records; only an explicit cleanup
 * removes them, and the scope is one of the three expressible shapes below
 * so "delete the session" and "delete the usage" never get conflated.
 *
 * A *recorded* scope also carries `removedIds`: the ledger keys the cleanup
 * actually removed. Applying those keys is what keeps a cleanup from turning
 * into a permanent filter — a call made after the cleanup has a new key and is
 * recorded normally, while the sessions' still-present call records for the
 * cleaned keys are never re-added by a later sync.
 */
export type PiUsageCleanupScope =
  | { kind: "all"; removedIds?: readonly string[] }
  | { kind: "session"; sessionId: string; removedIds?: readonly string[] }
  | { kind: "before"; before: string; removedIds?: readonly string[] };

export function describeUsageCleanupScope(scope: PiUsageCleanupScope, offsetMinutes: number = USAGE_TIMEZONE_OFFSET_MINUTES): string {
  if (scope.kind === "all") return "清理全部用量明细";
  if (scope.kind === "session") return `仅清理会话 ${scope.sessionId} 的用量明细（不影响其他会话）`;
  const window = resolveUsageWindow({ to: scope.before }, offsetMinutes);
  return `清理 ${window.label} 之前的用量明细`;
}

export function applyUsageCleanup(
  details: readonly PiUsageDetail[],
  scope: PiUsageCleanupScope,
  offsetMinutes: number = USAGE_TIMEZONE_OFFSET_MINUTES,
): PiUsageDetail[] {
  if (scope.kind === "all") return [];
  if (scope.kind === "session") return details.filter((detail) => detail.sessionId !== scope.sessionId);
  const window = resolveUsageWindow({ to: scope.before }, offsetMinutes);
  if (window.toMs === null) return [...details];
  const cutoff = window.toMs;
  return details.filter((detail) => {
    const instant = parseUsageInstant(detail.at);
    return instant === null || instant > cutoff;
  });
}

/**
 * Survivors of one *recorded* cleanup. A scope that carries `removedIds` is
 * applied key-by-key, so only the calls that existed at cleanup time are
 * dropped: a later call of the same session has a new key and is recorded, and
 * the cleaned keys stay gone even though the sessions still hold them.
 *
 * A legacy record (no keys) falls back to its scope predicate and keeps that
 * semantics: the Host never rewrites it into the key form, because a scope-only
 * exclusion names no calls and so cannot be converted into one. Only pre-#12
 * ledgers can hold one, and this feature was unreleased, so no such file exists
 * in practice; the fallback exists so an old file still parses.
 */
export function applyRecordedUsageCleanup(
  details: readonly PiUsageDetail[],
  scope: PiUsageCleanupScope,
  offsetMinutes: number = USAGE_TIMEZONE_OFFSET_MINUTES,
): PiUsageDetail[] {
  if (scope.removedIds === undefined) return applyUsageCleanup(details, scope, offsetMinutes);
  const removed = new Set(scope.removedIds);
  return details.filter((detail) => !removed.has(detail.id));
}

/** Statistics definitions shown in the UI (spec: 统计定义在界面可查). */
export const USAGE_DEFINITIONS: readonly { term: string; definition: string }[] = [
  { term: "统计范围", definition: "仅统计本应用记录的模型调用；不等同账户账单或供应商配额，未观测的外部调用不计入也不伪造。" },
  { term: "输入 / 输出", definition: "上游报告的 prompt 与 completion Tokens；reasoning 已在 output 内，界面仅作嵌套展开，不重复相加。" },
  { term: "缓存读取 / 缓存写入", definition: "上游报告的 cache read / cache write；供应商 totalTokens 不与这些缓存值重复相加。" },
  { term: "未知用量", definition: "上游未报告的调用计为「未报告」，不按零消耗处理；缺失与失败、取消分别标注。" },
  { term: "调用类型", definition: "回合、压缩、分支摘要、模型型工具分别统计；上下文占用下降不冲减累计消耗。" },
  { term: "重试与重放", definition: "每次重试是独立尝试并分别计入；流式增量、最终消息和事件重放按调用 id 更新同一条记录。" },
  { term: "恢复与克隆", definition: "恢复/分支/克隆/重新导入保留来源身份；原历史只计一次，继承展示不改变原调用的任务与会话归属。" },
  { term: "清理范围", definition: "清理只移除操作当时已记录的明细（按调用 id）；之后的新调用照常记录，归档对话不清理用量。" },
  { term: "日期边界", definition: "日期型边界按 UTC+08:00 当日开始／当日结束（含边界）；带偏移的时刻按其自身偏移比较，跨机器口径一致。" },
];
