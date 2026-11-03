/**
 * Dedicated scheduled task rules ([Pencil T17] #152).
 *
 * A schedule is its OWN task, created through the same task-creation pipeline as
 * any other task and owning a fixed task workspace. It is never a rule bolted
 * onto an arbitrary existing task: the task record carries the creation intent
 * (`kind: "scheduled"`), and a Host refuses to create the first schedule of a
 * task that was not created for that purpose.
 *
 * This module is the pure half — no fs, no clock, no SDK, no renderer:
 * - `taskKindMarker` / `isDedicatedScheduleTask` + `firstScheduleRefusal` state
 *   and enforce the dedicated-task invariant;
 * - `scheduleDefinitionIssues` validates a definition with NAMED failures
 *   (bad cron / bad timezone / missing model / missing directory / …) so the
 *   Host never silently substitutes a target;
 * - `scheduleRunView` is the S04 run-history row: start time, ACTUAL model,
 *   linked session, status, outcome/failure reason and whether that session can
 *   be opened to continue the conversation. Unknown and still-running states stay
 *   honest instead of being reported as success.
 */

import {
  nextTriggerAt,
  parseRuleText,
  type ScheduledRunRecord,
  type ScheduledRunResult,
  type StoredSchedule,
} from "./schedule-rules.js";

/** Creation intent persisted with the task record. */
export const SCHEDULE_TASK_KIND = "scheduled" as const;
export type TaskKind = "normal" | typeof SCHEDULE_TASK_KIND;

/**
 * The `kind` a task record carries. Records written before #152 have no kind and
 * are ordinary tasks; a schedule may never be created on them.
 */
export function taskKindMarker(kind: TaskKind | undefined): TaskKind {
  return kind === SCHEDULE_TASK_KIND ? SCHEDULE_TASK_KIND : "normal";
}

export function isDedicatedScheduleTask(record: { kind?: string } | null | undefined): boolean {
  return taskKindMarker(record?.kind as TaskKind | undefined) === SCHEDULE_TASK_KIND;
}

/**
 * A new schedule may only be created inside a task that was created as a
 * dedicated scheduled task. Editing an existing schedule is a different path and
 * is not gated by this rule.
 */
export function firstScheduleRefusal(input: {
  kind: TaskKind | undefined;
  existingSchedules: number;
  creating: boolean;
}): { ok: true } | { ok: false; code: "not-schedule-task"; message: string } {
  if (!input.creating || input.existingSchedules > 0) return { ok: true };
  if (taskKindMarker(input.kind) === SCHEDULE_TASK_KIND) return { ok: true };
  return {
    ok: false,
    code: "not-schedule-task",
    message: "定时规则只能保存在专属定时任务中：请用「新建定时任务」创建它自己的任务工作区，不能给现有普通任务加规则",
  };
}

export type ScheduleDefinitionCode =
  | "name-empty"
  | "prompt-empty"
  | "provider-missing"
  | "model-missing"
  | "model-not-declared"
  | "credential-missing"
  | "permission-invalid"
  | "timezone-invalid"
  | "rule-invalid"
  | "directory-missing";

export interface ScheduleDefinitionInput {
  name: string;
  prompt: string;
  providerId: string;
  model: string;
  permission: string;
  ruleText: string;
  timezone: string;
  /** Provider catalog the Host actually knows; empty = nothing handed over yet. */
  catalog: readonly { id: string; enabled?: boolean; models: readonly { id: string }[] }[];
  /** True when the Host has a usable credential for the named Provider. */
  credentialPresent: boolean;
  /** The fixed task workspace still exists and is a directory. */
  directoryPresent: boolean;
}

export type ScheduleDefinitionResult =
  | { ok: true }
  | { ok: false; code: ScheduleDefinitionCode; message: string };

/** Validate a whole definition with named, actionable failures. */
export function scheduleDefinitionIssues(input: ScheduleDefinitionInput): ScheduleDefinitionResult {
  if (input.name.trim().length === 0) return { ok: false, code: "name-empty", message: "定时任务名称不能为空" };
  if (input.prompt.trim().length === 0) {
    return { ok: false, code: "prompt-empty", message: "提示词不能为空（结果处理写在提示词中）" };
  }
  if (input.providerId.trim().length === 0) return { ok: false, code: "provider-missing", message: "必须选择 Provider，不会自动替换" };
  if (input.model.trim().length === 0) return { ok: false, code: "model-missing", message: "必须选择模型，不会自动替换" };
  if (input.permission !== "read" && input.permission !== "default" && input.permission !== "auto") {
    return { ok: false, code: "permission-invalid", message: `会话权限 ${input.permission} 不是三档之一` };
  }
  if (!isIana(input.timezone)) return { ok: false, code: "timezone-invalid", message: `时区 ${input.timezone || "(空)"} 不是 IANA 时区` };
  const parsed = parseRuleText(input.ruleText, input.timezone);
  if (!parsed.ok) return { ok: false, code: "rule-invalid", message: parsed.message };
  if (!input.directoryPresent) {
    return { ok: false, code: "directory-missing", message: "任务工作区目录不存在，不能运行；请修复任务目录后重试" };
  }
  // The catalog is only consulted once the Host actually has one: an empty
  // catalog means "not handed over yet", never "the Provider does not exist".
  if (input.catalog.length > 0) {
    const provider = input.catalog.find((row) => row.id === input.providerId);
    if (provider === undefined || provider.enabled === false) {
      return { ok: false, code: "provider-missing", message: `Provider ${input.providerId} 不存在或未启用，不会替换为其他 Provider` };
    }
    if (!provider.models.some((row) => row.id === input.model)) {
      return { ok: false, code: "model-not-declared", message: `Provider ${input.providerId} 未声明模型 ${input.model}，不会替换为其他模型` };
    }
  }
  if (!input.credentialPresent) {
    return { ok: false, code: "credential-missing", message: `Provider ${input.providerId} 没有可用凭据，不能运行；不会绕过审批或换用其他凭据` };
  }
  return { ok: true };
}

function isIana(timezone: string): boolean {
  if (timezone.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Persisted next planned instant. `null` = the rule has no further occurrence
 * (a consumed one-shot), which is different from "never computed" (`undefined`).
 */
export function nextRunAtOf(schedule: Pick<StoredSchedule, "ruleText" | "timezone">, after: string): string | null {
  const parsed = parseRuleText(schedule.ruleText, schedule.timezone);
  if (!parsed.ok) return null;
  // `nextTriggerAt` is the single implementation of "when does this rule next
  // fire in its own zone"; callers must not grow a second one.
  return nextTriggerAt(parsed.rule, { after });
}

export type ScheduleRunStatus = "running" | "completed" | "awaiting-approval" | "skipped" | "failed" | "unknown";

/**
 * [#146 / T18 boundary] How a run's linked conversation stands TODAY.
 *
 * `resumable`  — a real session still exists and can be opened to continue.
 * `retained`  — a real session exists but this run's outcome is not resumable
 *               (e.g. a run that was skipped/failed after creating one).
 * `deleted`   — the session this run pointed at was deleted by the user. The
 *               run record itself is NOT deleted: schedule history keeps an
 *               explicit state instead of silently looking like "no session".
 * `none`      — the run never created a session (skipped / pre-flight failure).
 */
export type ScheduleRunLinkState = "resumable" | "retained" | "deleted" | "none";

export interface ScheduleRunView {
  runId: string;
  /** Start time of the attempt (S04「开始时间」). */
  startedAt: string;
  /** Model this run actually used; a run that never started reports its intended model with `actual: false`. */
  model: string;
  actualModel: boolean;
  sessionId?: string;
  status: ScheduleRunStatus;
  statusLabel: string;
  /** Outcome or failure reason, exactly as recorded (plus a named deleted-session state). */
  detail?: string;
  /** True only when a real, still-existing session can be opened to continue the conversation. */
  resumable: boolean;
  /** The linked history state shown to the reader (never inferred from a missing read). */
  linkState: ScheduleRunLinkState;
}

const LINK_STATE_LABEL: Record<Exclude<ScheduleRunLinkState, "none">, string> = {
  resumable: "关联会话可继续",
  retained: "关联会话保留",
  deleted: "关联会话已删除（记录保留）",
};

const RESULT_LABEL: Record<ScheduledRunResult, string> = {
  completed: "完成",
  "awaiting-approval": "等待确认",
  skipped: "已跳过",
  failed: "失败",
  running: "执行中",
};

/**
 * S04 run row. `actualModel` stays false when the run never started (skipped or
 * failed before a turn), so history never claims a model was used.
 *
 * [#146] `sessionExists === false` is the ONLY way a link becomes `deleted`:
 * the Host checked the task's session index for that id. `undefined` means the
 * caller did not check (an older read), and the row then keeps the #152
 * behavior instead of claiming a session was deleted without having looked.
 */
export function scheduleRunView(run: ScheduledRunRecord, sessionExists?: boolean): ScheduleRunView {
  const status: ScheduleRunStatus = RESULT_LABEL[run.result] === undefined ? "unknown" : run.result;
  const startable = run.result === "completed" || run.result === "awaiting-approval" || run.result === "running";
  const linkState: ScheduleRunLinkState = run.sessionId === undefined
    ? "none"
    : sessionExists === false ? "deleted"
      : startable ? "resumable" : "retained";
  const detail = linkState === "deleted"
    ? [run.reason, "关联会话已删除；本次执行记录保留（T18）"].filter((part): part is string => typeof part === "string" && part.length > 0).join(" · ")
    : run.reason;
  return {
    runId: run.runId,
    startedAt: run.startedAt,
    model: run.actualModel ?? run.model,
    actualModel: run.actualModel !== undefined,
    ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
    status,
    statusLabel: RESULT_LABEL[run.result] ?? "未知",
    ...(detail !== undefined ? { detail } : {}),
    // A resumable link requires a session that really exists; a deleted one
    // keeps its record but offers no "continue" affordance.
    resumable: linkState === "resumable",
    linkState,
  };
}

/** The label the schedule history shows for a run's linked session, or `null` when it has none. */
export function scheduleRunLinkLabel(view: Pick<ScheduleRunView, "linkState">): string | null {
  return view.linkState === "none" ? null : LINK_STATE_LABEL[view.linkState];
}
