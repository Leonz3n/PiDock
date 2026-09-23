/**
 * Renderer-side schedule rules for [PiDock 18] (#20).
 *
 * Node-free mirror of the *display and refusal* rules the UI needs, so the page
 * never states something the Host would contradict:
 *
 * - which rule texts are accepted at all (`validateRuleText`), with the same
 *   wording the shell rule layer uses, so the edit form can refuse before a save
 *   round trip;
 * - how a schedule's state, its next plan and its trigger history read
 *   (`scheduleStateLabel`, `scheduleNextRunText`, `scheduledRunDetail`);
 * - when 立即运行 is offered (`canRunScheduleNow`);
 * - that applying a template keeps project / provider / model / permission /
 *   timezone (`applyTemplateFields`).
 *
 * It deliberately does **not** compute a next trigger for arbitrary cron: the
 * real parse and the real clock live in the Host (`main/schedule-rules.ts`), and
 * the page shows the Host's plan instead of inventing one.
 */

import type { Schedule, ScheduleTemplate, ScheduledRun } from "./types";

/** Accepted editable forms, shown as the field hint. */
export const SCHEDULE_RULE_FORMS = ["每日 09:15", "每周五 15:00", "周一至周五 09:15", "一次性 2026-10-01T09:00", "*/15 9-17 * * 1-5"] as const;

export type ScheduleRuleIssueCode =
  | "empty"
  | "timezone-invalid"
  | "rule-unrecognized"
  | "time-invalid"
  | "weekday-invalid"
  | "once-time-invalid"
  | "cron-invalid";

export type ScheduleRuleCheck = { ok: true; kind: "once" | "daily" | "weekly" | "cron" } | { ok: false; code: ScheduleRuleIssueCode; message: string };

const WEEKDAY_CHARS = "日天一二三四五六";

/** True when the runtime can resolve `timezone` as an IANA zone. */
export function isKnownTimezone(timezone: string): boolean {
  if (timezone.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function clockOk(value: string): boolean {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return false;
  return Number(match[1]) <= 23 && Number(match[2]) <= 59;
}

function weekdayOk(value: string): boolean {
  const text = value.replace(/^每?周/, "").trim();
  const range = /^([日天一二三四五六])\s*(?:至|-|~)\s*周?([日天一二三四五六])$/.exec(text);
  if (range) return true;
  return new RegExp(`^[${WEEKDAY_CHARS}]$`).test(text);
}

function cronFieldOk(field: string, min: number, max: number): boolean {
  for (const segment of field.split(",")) {
    const [rangeText, stepText] = segment.split("/");
    if (rangeText === undefined || rangeText.length === 0) return false;
    if (stepText !== undefined && !(Number.isInteger(Number(stepText)) && Number(stepText) > 0)) return false;
    if (rangeText === "*") continue;
    const bounds = rangeText.includes("-") ? rangeText.split("-") : [rangeText, rangeText];
    for (const bound of bounds) {
      const value = Number(bound);
      if (!Number.isInteger(value) || value < min || value > max) return false;
    }
  }
  return true;
}

/**
 * Same acceptance set as the shell rule parser: a text outside these forms is
 * refused here with the reason, so a save round trip is not needed to learn it.
 */
export function validateRuleText(text: string, timezone: string): ScheduleRuleCheck {
  const raw = text.trim();
  if (raw.length === 0) return { ok: false, code: "empty", message: "规则不能为空" };
  if (!isKnownTimezone(timezone)) {
    return { ok: false, code: "timezone-invalid", message: `时区 ${timezone || "(空)"} 不是可解析的 IANA 时区` };
  }
  const once = /^一次性\s*(.+)$/.exec(raw);
  if (once) {
    const value = (once[1] as string).trim();
    const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
    if (local) {
      const month = Number(local[2]);
      const day = Number(local[3]);
      const hour = Number(local[4]);
      const minute = Number(local[5]);
      const asDate = new Date(Date.UTC(Number(local[1]), month - 1, day));
      const realDate = asDate.getUTCMonth() + 1 === month && asDate.getUTCDate() === day;
      if (!realDate || hour > 23 || minute > 59) {
        return { ok: false, code: "once-time-invalid", message: `${value} 不是有效的一次性时间` };
      }
      return { ok: true, kind: "once" };
    }
    if (Number.isFinite(Date.parse(value))) return { ok: true, kind: "once" };
    return { ok: false, code: "once-time-invalid", message: `一次性时间 ${value} 不是可解析的时间` };
  }
  const daily = /^每日\s*(\d{1,2}:\d{2})$/.exec(raw);
  if (daily) {
    if (!clockOk(daily[1] as string)) return { ok: false, code: "time-invalid", message: `时间 ${daily[1]} 不是 HH:MM` };
    return { ok: true, kind: "daily" };
  }
  const weekly = /^((?:每)?周[^\s]*?)\s*(\d{1,2}:\d{2})$/.exec(raw);
  if (weekly) {
    if (!weekdayOk(weekly[1] as string)) return { ok: false, code: "weekday-invalid", message: `星期 ${weekly[1]} 不是可识别的星期范围` };
    if (!clockOk(weekly[2] as string)) return { ok: false, code: "time-invalid", message: `时间 ${weekly[2]} 不是 HH:MM` };
    return { ok: true, kind: "weekly" };
  }
  const fields = raw.split(/\s+/);
  if (fields.length === 5) {
    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
    if (
      !cronFieldOk(minute, 0, 59) ||
      !cronFieldOk(hour, 0, 23) ||
      !cronFieldOk(dayOfMonth, 1, 31) ||
      !cronFieldOk(month, 1, 12) ||
      !cronFieldOk(dayOfWeek, 0, 7)
    ) {
      return { ok: false, code: "cron-invalid", message: `Cron ${raw} 的字段超出取值区间` };
    }
    return { ok: true, kind: "cron" };
  }
  return { ok: false, code: "rule-unrecognized", message: `无法识别的规则：${raw}` };
}

export type ScheduleState = { label: string; tone: "accent" | "neutral" | "warn"; detail?: string };

/**
 * How one schedule reads: 需要修复 wins over the enabled flag (a config that no
 * longer resolves will not run), and an archived task always reads 已归档（暂停）
 * regardless of the stored flag — restore never re-enables by itself.
 */
export function scheduleStateLabel(schedule: Pick<Schedule, "enabled"> & { repairIssue?: string }, input: { archived: boolean }): ScheduleState {
  if (schedule.repairIssue !== undefined) {
    return { label: "需要修复", tone: "warn", detail: schedule.repairIssue };
  }
  if (input.archived) return { label: "已归档（暂停）", tone: "neutral" };
  return schedule.enabled ? { label: "已启用", tone: "accent" } : { label: "已暂停", tone: "neutral" };
}

/** Next plan text: the Host's value, or an explicit paused/needs-repair notice. */
export function scheduleNextRunText(schedule: Pick<Schedule, "enabled" | "nextRun"> & { repairIssue?: string }, input: { archived: boolean }): string {
  if (schedule.repairIssue !== undefined) return "配置需要修复，下次触发已停止";
  if (input.archived) return "任务已归档，调度已暂停";
  return schedule.enabled ? schedule.nextRun : "已暂停";
}

export function scheduleRunTriggerLabel(trigger: ScheduledRun["trigger"]): string {
  return trigger === "manual" ? "立即运行" : "计划触发";
}

export function scheduleRunDetail(run: ScheduledRun): string | undefined {
  if (run.reason !== undefined && run.reason.length > 0) return run.reason;
  return run.sessionId === undefined ? undefined : `会话 ${run.sessionId}`;
}

/** 立即运行 needs an existing, non-archived schedule (归档任务不能绕过恢复). */
export function canRunScheduleNow(input: { archived: boolean }): { ok: boolean; reason?: string } {
  return input.archived ? { ok: false, reason: "已归档任务不能通过「立即运行」绕过恢复，请先恢复任务" } : { ok: true };
}

export interface TemplateScheduleFields {
  name: string;
  rule: string;
  prompt: string;
  providerId: string;
  model: string;
  permission: Schedule["permission"];
  timezone: string;
}

/**
 * Applying a template fills name / rule / prompt only: project, Provider
 * identity, model, session permission and timezone stay exactly as they were,
 * and the template never enables or runs anything.
 */
export function applyTemplateFields(template: Pick<ScheduleTemplate, "name" | "rule" | "prompt">, schedule: TemplateScheduleFields): TemplateScheduleFields {
  return {
    ...schedule,
    name: template.name,
    rule: template.rule,
    prompt: template.prompt,
  };
}

/** Template name is only filled when the field is empty or still the last template. */
export function templateNameFor(current: string, template: Pick<ScheduleTemplate, "name">, lastTemplateName?: string): string {
  const trimmed = current.trim();
  if (trimmed.length === 0 || trimmed === lastTemplateName) return template.name;
  return current;
}

/** A scheduled run's own session is independent: never the previous run's history. */
export function isIndependentRunSession(run: Pick<ScheduledRun, "sessionId">, previous?: Pick<ScheduledRun, "sessionId">): boolean {
  return previous === undefined || previous.sessionId !== run.sessionId;
}

/** History is read-only evidence: a run with no session never ran a turn. */
export function scheduleRunCreatedSession(run: Pick<ScheduledRun, "result" | "sessionId">): boolean {
  return run.result !== "skipped" && run.sessionId !== undefined;
}
