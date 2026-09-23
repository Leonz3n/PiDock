/**
 * Renderer mirror of the [PiDock 12] #12 usage rules (`usage-ledger.ts`).
 *
 * The sandboxed renderer cannot import the shell module (that would hand it
 * Node access), so the display-side reading of a usage detail is mirrored
 * here: the same declared timezone for date boundaries, the same rule that
 * reasoning sits inside output and a provider total is never re-added, the
 * same "unknown is not zero" counting, and the same grouping dimensions.
 * Real aggregation authority stays Host-side (`task/usageRecords`); this
 * module keeps the page honest when the in-memory adapter is the source.
 */
import type { UsageCleanupScope, UsageCompleteness, UsageEndState, UsageKind, UsageRecord } from "./types";

/** Declared timezone for date-only boundaries (matches the ledger). */
export const USAGE_TIMEZONE_OFFSET_MINUTES = 8 * 60;

export const USAGE_KIND_LABELS: Record<UsageKind, string> = {
  turn: "回合",
  compaction: "压缩",
  "branch-summary": "分支摘要",
  "model-tool": "模型型工具",
};

export const USAGE_END_STATE_LABELS: Record<UsageEndState, string> = {
  completed: "完成",
  failed: "失败",
  cancelled: "取消",
  "awaiting-approval": "待确认",
};

export const USAGE_COMPLETENESS_LABELS: Record<UsageCompleteness, string> = {
  reported: "已报告",
  partial: "部分报告",
  missing: "未报告",
};

export type UsageGroupBy = "project" | "task" | "session" | "provider" | "model" | "kind" | "day";

export const USAGE_GROUP_OPTIONS: readonly { id: UsageGroupBy; label: string }[] = [
  { id: "project", label: "项目" },
  { id: "task", label: "任务" },
  { id: "session", label: "会话" },
  { id: "provider", label: "Provider" },
  { id: "model", label: "模型" },
  { id: "kind", label: "调用类型" },
  { id: "day", label: "日期" },
];

export type UsageFilter = {
  taskId?: string;
  projectId?: string;
  sessionId?: string;
  providerId?: string;
  model?: string;
  kind?: UsageKind;
  from?: string;
  to?: string;
};

export type UsageTotals = {
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
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseInstant(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Resolve a range on the declared timezone: a date-only `from` means the start
 * of that day and a date-only `to` the end of it, both in UTC+08:00, so every
 * machine buckets the same rows identically.
 */
export function usageWindow(range: { from?: string; to?: string }, offsetMinutes: number = USAGE_TIMEZONE_OFFSET_MINUTES): {
  fromMs: number | null;
  toMs: number | null;
  label: string;
} {
  const boundary = (value: string | undefined, endOfDay: boolean): number | null => {
    if (value === undefined || value.trim().length === 0) return null;
    const trimmed = value.trim();
    if (!DATE_ONLY.test(trimmed)) return parseInstant(trimmed);
    const [year, month, day] = trimmed.split("-").map((part) => Number.parseInt(part, 10));
    const startOfDayUtc = Date.UTC(year, month - 1, day) - offsetMinutes * 60_000;
    return endOfDay ? startOfDayUtc + 24 * 60 * 60_000 - 1 : startOfDayUtc;
  };
  const fromMs = boundary(range.from, false);
  const toMs = boundary(range.to, true);
  const describe = (value: string | undefined, endOfDay: boolean): string => {
    if (value === undefined || value.trim().length === 0) return endOfDay ? "不限" : "最早";
    const trimmed = value.trim();
    return DATE_ONLY.test(trimmed) ? (endOfDay ? `${trimmed} 当日结束` : `${trimmed} 当日开始`) : trimmed;
  };
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const zone = `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
  return { fromMs, toMs, label: `${describe(range.from, false)} → ${describe(range.to, true)}（UTC${zone}，含边界）` };
}

export function usageDayKey(at: string, offsetMinutes: number = USAGE_TIMEZONE_OFFSET_MINUTES): string | null {
  const instant = parseInstant(at);
  return instant === null ? null : new Date(instant + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function filterUsageRecords(records: readonly UsageRecord[], filter: UsageFilter): UsageRecord[] {
  const window = usageWindow(filter);
  return records.filter((record) => {
    if (filter.taskId !== undefined && record.taskId !== filter.taskId) return false;
    if (filter.projectId !== undefined && record.projectId !== filter.projectId) return false;
    if (filter.sessionId !== undefined && record.sessionId !== filter.sessionId) return false;
    if (filter.providerId !== undefined && record.providerId !== filter.providerId) return false;
    if (filter.model !== undefined && record.model !== filter.model && record.responseModel !== filter.model) return false;
    if (filter.kind !== undefined && record.kind !== filter.kind) return false;
    if (window.fromMs === null && window.toMs === null) return true;
    const instant = parseInstant(record.at);
    if (instant === null) return false;
    if (window.fromMs !== null && instant < window.fromMs) return false;
    if (window.toMs !== null && instant > window.toMs) return false;
    return true;
  });
}

/**
 * Totals. Counters of an unreported record are excluded (counted as `missing`)
 * so unknown usage is never displayed as a zero consumption; reasoning is
 * summarised separately and never added to `output`.
 */
export function sumUsageRecords(records: readonly UsageRecord[]): UsageTotals {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0, reported: 0, partial: 0, missing: 0 };
  for (const record of records) {
    totals.calls += 1;
    if (record.completeness === "missing") {
      totals.missing += 1;
      continue;
    }
    totals[record.completeness] += 1;
    totals.input += record.input;
    totals.output += record.output;
    totals.cacheRead += record.cacheRead;
    totals.cacheWrite += record.cacheWrite;
    totals.reasoning += record.reasoning ?? 0;
  }
  return totals;
}

export type UsageGroup = { key: string; label: string; totals: UsageTotals };

/** Grouping by the offered dimensions; same keys/labels as the Host report. */
export function groupUsageRecords(records: readonly UsageRecord[], groupBy: UsageGroupBy): UsageGroup[] {
  const buckets = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const key =
      groupBy === "project"
        ? record.projectId
        : groupBy === "task"
          ? record.taskId
          : groupBy === "session"
            ? `${record.taskId} · ${record.sessionId}`
            : groupBy === "provider"
              ? record.providerId
              : groupBy === "model"
                ? record.model
                : groupBy === "kind"
                  ? record.kind
                  : (usageDayKey(record.at) ?? "时间未知");
    buckets.set(key, [...(buckets.get(key) ?? []), record]);
  }
  return [...buckets.entries()]
    .map(([key, items]) => ({ key, label: groupBy === "kind" ? (USAGE_KIND_LABELS[key as UsageKind] ?? key) : key, totals: sumUsageRecords(items) }))
    .sort((a, b) => b.totals.input + b.totals.output - (a.totals.input + a.totals.output) || a.key.localeCompare(b.key));
}

/** Records whose `at` cannot be placed on the time axis. */
export function unparsableUsageTimes(records: readonly UsageRecord[]): string[] {
  return records.filter((record) => parseInstant(record.at) === null).map((record) => record.id);
}

/** Human-readable cleanup scope, mirrored from the ledger's wording. */
export function describeUsageCleanupScope(scope: UsageCleanupScope): string {
  if (scope.kind === "all") return "清理全部用量明细";
  if (scope.kind === "session") return `仅清理会话 ${scope.sessionId} 的用量明细（不影响其他会话）`;
  return `清理 ${usageWindow({ to: scope.before }).label} 之前的用量明细`;
}

/**
 * Statistics definitions the page shows (spec: 统计定义在界面可查). Kept
 * identical in meaning to the Host-side list so the page never explains a
 * different rule than the one the ledger applies.
 */
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
