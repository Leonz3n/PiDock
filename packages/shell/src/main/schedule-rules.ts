/**
 * Schedule rules for [PiDock 18] (#20).
 *
 * The pure half of the scheduled-task feature: what a rule means, when it next
 * fires in its saved IANA timezone, which occurrences a Host evaluation may
 * still act on, how long a scheduled confirmation lives, what the five built-in
 * templates fill in, and which config problems refuse a run instead of silently
 * swapping a provider or a project. No fs, no process, no timer and no SDK: the
 * Host owns persistence and the wall clock and passes both in, so every rule
 * here is unit-testable and the renderer can mirror it without Node.
 *
 * 盒子 1 保存 Provider 身份／模型、权限、提示词、规则、IANA 时区及版本；每日／每周／
 * 一次性／五段 Cron 真实校验并预览下一次触发 — `parseRuleText` / `nextTriggerAt`.
 * 盒子 4 待确认至 24 小时或下次计划时刻较早者过期 — `scheduledApprovalDeadline`.
 * 盒子 5 运行重叠跳过、离线不补跑、时钟回拨／夏令时／重启不重复触发 — `planTrigger`
 * plus the occurrence key (`occurrenceKey`) recorded with every run.
 * 盒子 6 归档停止并暂停、恢复不自动启用、配置失效不静默换模型或项目 —
 * `planTrigger` refusals plus `validateScheduleConfig`.
 * 盒子 7 失败获取不使用陈旧数据声称成功 — `remoteFetchVerdict`.
 */

import { APPROVAL_DEADLINE_MS } from "./execution-ledger.js";
import type { PiPermission } from "./pi-session.js";

/** The four rule shapes the first version must validate (盒子 1). */
export const SCHEDULE_RULE_KINDS = ["once", "daily", "weekly", "cron"] as const;

export type ScheduleRuleKind = (typeof SCHEDULE_RULE_KINDS)[number];

export interface OnceRule {
  kind: "once";
  /** Local wall time in `timezone` (ISO without offset) or an absolute instant. */
  at: string;
  timezone: string;
}

export interface DailyRule {
  kind: "daily";
  /** `HH:MM` local wall time. */
  time: string;
  timezone: string;
}

export interface WeeklyRule {
  kind: "weekly";
  /** Weekdays, 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** `HH:MM` local wall time. */
  time: string;
  timezone: string;
}

export interface CronRule {
  kind: "cron";
  /** Five-field cron: minute hour day-of-month month day-of-week. */
  expression: string;
  timezone: string;
}

export type ScheduleRule = OnceRule | DailyRule | WeeklyRule | CronRule;

export type RuleParseCode =
  | "empty"
  | "timezone-invalid"
  | "rule-unrecognized"
  | "time-invalid"
  | "weekday-invalid"
  | "once-time-invalid"
  | "cron-invalid";

export type RuleParseResult =
  | { ok: true; rule: ScheduleRule }
  | { ok: false; code: RuleParseCode; message: string };

const WEEKDAYS: Readonly<Record<string, number>> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** True when `timezone` is an IANA zone this runtime can actually resolve. */
export function isIanaTimezone(timezone: string): boolean {
  if (timezone.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function parseClock(time: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function clockText(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(instant: number, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const out: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(instant))) {
    if (part.type !== "literal") out[part.type] = part.value;
  }
  return {
    year: Number(out["year"]),
    month: Number(out["month"]),
    day: Number(out["day"]),
    hour: Number(out["hour"]),
    minute: Number(out["minute"]),
    second: Number(out["second"]),
  };
}

function offsetMs(instant: number, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(instant / 1000) * 1000;
}

/**
 * Wall-clock time in `timeZone` -> instant. A wall time the zone skips (the
 * spring-forward gap) has no instant and returns `null`, so a scheduled time
 * that simply does not exist that day is skipped instead of firing twice.
 */
function wallToInstant(wall: { year: number; month: number; day: number; hour: number; minute: number }, timeZone: string): number | null {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0);
  const firstOffset = offsetMs(guess, timeZone);
  let instant = guess - firstOffset;
  const secondOffset = offsetMs(instant, timeZone);
  if (secondOffset !== firstOffset) instant = guess - secondOffset;
  const check = zonedParts(instant, timeZone);
  if (
    check.year !== wall.year ||
    check.month !== wall.month ||
    check.day !== wall.day ||
    check.hour !== wall.hour ||
    check.minute !== wall.minute
  ) {
    return null;
  }
  return instant;
}

function parseWeekdayList(text: string): number[] | null {
  const trimmed = text.replace(/^每?周/, "").trim();
  const range = /^([日天一二三四五六])\s*(?:至|-|~)\s*周?([日天一二三四五六])$/.exec(trimmed);
  if (range) {
    const from = WEEKDAYS[range[1] as string];
    const to = WEEKDAYS[range[2] as string];
    if (from === undefined || to === undefined) return null;
    const days: number[] = [];
    for (let day = from; ; day = (day + 1) % 7) {
      days.push(day);
      if (day === to) break;
      if (days.length === 7) return null;
    }
    return days;
  }
  const single = /^([日天一二三四五六])$/.exec(trimmed);
  if (single) {
    const day = WEEKDAYS[single[1] as string];
    return day === undefined ? null : [day];
  }
  return null;
}

/**
 * Parse the editable rule text (盒子 1). Accepted forms:
 * `每日 09:15`, `每周五 15:00`, `周一至周五 09:15`, `一次性 2026-10-01T09:00`
 * (local wall time in `timezone`, or an absolute instant carrying an offset),
 * or a five-field cron expression (`*&#47;15 9-17 * * 1-5`). Anything else is
 * refused with the reason instead of being coerced into a nearby rule.
 */
export function parseRuleText(text: string, timezone: string): RuleParseResult {
  const raw = text.trim();
  if (raw.length === 0) return { ok: false, code: "empty", message: "规则不能为空" };
  if (!isIanaTimezone(timezone)) {
    return { ok: false, code: "timezone-invalid", message: `时区 ${timezone || "(空)"} 不是可解析的 IANA 时区` };
  }
  const once = /^一次性\s*(.+)$/.exec(raw);
  if (once) {
    const value = once[1] as string;
    const parts = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
    if (parts) {
      const wall = {
        year: Number(parts[1]),
        month: Number(parts[2]),
        day: Number(parts[3]),
        hour: Number(parts[4]),
        minute: Number(parts[5]),
      };
      if (wallToInstant(wall, timezone) === null) {
        return { ok: false, code: "once-time-invalid", message: `${value} 在 ${timezone} 不存在（夏令时跳过的本地时间）` };
      }
      return { ok: true, rule: { kind: "once", at: value.trim(), timezone } };
    }
    if (Number.isFinite(Date.parse(value))) {
      return { ok: true, rule: { kind: "once", at: new Date(Date.parse(value)).toISOString(), timezone } };
    }
    return { ok: false, code: "once-time-invalid", message: `一次性时间 ${value} 不是可解析的时间` };
  }
  const daily = /^每日\s*(\d{1,2}:\d{2})$/.exec(raw);
  if (daily) {
    const clock = parseClock(daily[1] as string);
    if (!clock) return { ok: false, code: "time-invalid", message: `时间 ${daily[1]} 不是 HH:MM` };
    return { ok: true, rule: { kind: "daily", time: clockText(clock.hour, clock.minute), timezone } };
  }
  const weekly = /^((?:每)?周[\u4e00-\u9fa5]*?)\s*(\d{1,2}:\d{2})$/.exec(raw);
  if (weekly) {
    const days = parseWeekdayList(weekly[1] as string);
    if (!days) return { ok: false, code: "weekday-invalid", message: `星期 ${weekly[1]} 不是可识别的星期范围` };
    const clock = parseClock(weekly[2] as string);
    if (!clock) return { ok: false, code: "time-invalid", message: `时间 ${weekly[2]} 不是 HH:MM` };
    return { ok: true, rule: { kind: "weekly", days, time: clockText(clock.hour, clock.minute), timezone } };
  }
  const fields = raw.split(/\s+/);
  if (fields.length === 5) {
    const parsed = parseCronFields(fields);
    if (!parsed.ok) return { ok: false, code: "cron-invalid", message: parsed.message };
    return { ok: true, rule: { kind: "cron", expression: fields.join(" "), timezone } };
  }
  return { ok: false, code: "rule-unrecognized", message: `无法识别的规则：${raw}` };
}

interface CronSets {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  /** True when the field was `*` (standard cron dom/dow matching rule). */
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseCronField(field: string, min: number, max: number, label: string): { ok: true; values: number[]; restricted: boolean } | { ok: false; message: string } {
  const values = new Set<number>();
  for (const segment of field.split(",")) {
    const [rangeText, stepText] = segment.split("/");
    if (rangeText === undefined || rangeText.length === 0) return { ok: false, message: `${label} 字段 ${segment} 为空` };
    const step = stepText === undefined ? 1 : Number.parseInt(stepText, 10);
    if (!Number.isInteger(step) || step <= 0) return { ok: false, message: `${label} 字段步长 ${stepText} 不合法` };
    let from: number;
    let to: number;
    if (rangeText === "*") {
      from = min;
      to = max;
    } else if (rangeText.includes("-")) {
      const [a, b] = rangeText.split("-");
      from = Number.parseInt(a as string, 10);
      to = Number.parseInt(b as string, 10);
    } else {
      from = Number.parseInt(rangeText, 10);
      to = stepText === undefined ? from : max;
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
      return { ok: false, message: `${label} 字段 ${segment} 超出 ${min}-${max}` };
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return { ok: true, values: [...values].sort((a, b) => a - b), restricted: field !== "*" };
}

function parseCronFields(fields: readonly string[]): { ok: true; sets: CronSets } | { ok: false; message: string } {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const minutes = parseCronField(minute as string, 0, 59, "分钟");
  if (!minutes.ok) return minutes;
  const hours = parseCronField(hour as string, 0, 23, "小时");
  if (!hours.ok) return hours;
  const dom = parseCronField(dayOfMonth as string, 1, 31, "日");
  if (!dom.ok) return dom;
  const months = parseCronField(month as string, 1, 12, "月");
  if (!months.ok) return months;
  const dow = parseCronField(dayOfWeek as string, 0, 7, "星期");
  if (!dow.ok) return dow;
  return {
    ok: true,
    sets: {
      minutes: minutes.values,
      hours: hours.values,
      daysOfMonth: dom.values,
      months: months.values,
      // 7 = Sunday in the DOW field.
      daysOfWeek: [...new Set(dow.values.map((value) => (value === 7 ? 0 : value)))].sort((a, b) => a - b),
      domRestricted: dom.restricted,
      dowRestricted: dow.restricted,
    },
  };
}

/** Readable form of a rule (界面显示可读规则). */
export function describeRule(rule: ScheduleRule): string {
  switch (rule.kind) {
    case "once":
      return `一次性 ${rule.at}`;
    case "daily":
      return `每日 ${rule.time}`;
    case "weekly": {
      const days = [...new Set(rule.days)].sort((a, b) => a - b);
      if (days.length === 7) return `每日 ${rule.time}`;
      const names = days.map((day) => WEEKDAY_NAMES[day] ?? `周${day}`).join("、");
      return `每${names} ${rule.time}`;
    }
    case "cron":
      return `Cron ${rule.expression}`;
  }
}

const MAX_SCAN_DAYS = 400;

function cronMatchesDay(sets: CronSets, parts: ZonedParts): boolean {
  if (!sets.months.includes(parts.month)) return false;
  const domMatch = sets.daysOfMonth.includes(parts.day);
  const dowMatch = sets.daysOfWeek.includes(new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay());
  // Standard cron: when both day fields are restricted, either may match.
  if (sets.domRestricted && sets.dowRestricted) return domMatch || dowMatch;
  if (sets.domRestricted) return domMatch;
  if (sets.dowRestricted) return dowMatch;
  return true;
}

function nextCronInstant(sets: CronSets, timezone: string, after: number): number | null {
  const start = zonedParts(after, timezone);
  for (let dayOffset = 0, date = new Date(Date.UTC(start.year, start.month - 1, start.day)); dayOffset < MAX_SCAN_DAYS; dayOffset += 1) {
    const day = {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
    };
    if (cronMatchesDay(sets, { ...day, hour: 0, minute: 0, second: 0 })) {
      for (const hour of sets.hours) {
        for (const minute of sets.minutes) {
          const instant = wallToInstant({ ...day, hour, minute }, timezone);
          if (instant !== null && instant > after) return instant;
        }
      }
    }
    date = new Date(date.getTime() + 24 * 60 * 60 * 1000);
  }
  return null;
}

function nextRuleInstant(rule: ScheduleRule, after: number): number | null {
  if (!Number.isFinite(after)) return null;
  if (rule.kind === "once") {
    const wall = parseOnceWall(rule.at);
    const absolute =
      /T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(rule.at) ? Date.parse(rule.at) : wall === null ? null : wallToInstant(wall, rule.timezone);
    if (absolute === null || !Number.isFinite(absolute) || absolute <= after) return null;
    return absolute;
  }
  if (rule.kind === "cron") {
    const fields = parseCronFields(rule.expression.split(/\s+/));
    if (!fields.ok) return null;
    return nextCronInstant(fields.sets, rule.timezone, after);
  }
  const clock = parseClock(rule.time);
  if (!clock) return null;
  const allowed =
    rule.kind === "daily" ? new Set([0, 1, 2, 3, 4, 5, 6]) : new Set(rule.days.map((day) => day % 7));
  const start = zonedParts(after, rule.timezone);
  for (let dayOffset = 0, date = new Date(Date.UTC(start.year, start.month - 1, start.day)); dayOffset < MAX_SCAN_DAYS; dayOffset += 1) {
    const weekday = date.getUTCDay();
    if (allowed.has(weekday)) {
      const instant = wallToInstant(
        { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: clock.hour, minute: clock.minute },
        rule.timezone,
      );
      if (instant !== null && instant > after) return instant;
    }
    date = new Date(date.getTime() + 24 * 60 * 60 * 1000);
  }
  return null;
}

function parseOnceWall(at: string): { year: number; month: number; day: number; hour: number; minute: number } | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(at);
  if (!parts) return null;
  return {
    year: Number(parts[1]),
    month: Number(parts[2]),
    day: Number(parts[3]),
    hour: Number(parts[4]),
    minute: Number(parts[5]),
  };
}

/** Next trigger strictly after `after`, in the rule's own IANA timezone. */
export function nextTriggerAt(rule: ScheduleRule, input: { after: string }): string | null {
  const instant = nextRuleInstant(rule, Date.parse(input.after));
  return instant === null ? null : new Date(instant).toISOString();
}

/**
 * Every occurrence in `(after, now]`, oldest first — the input the Host needs to
 * tell "due now" from "missed while nobody evaluated". `limit` bounds the list
 * (a very old `after` must not enumerate years of daily triggers).
 */
export function occurrencesBetween(rule: ScheduleRule, input: { after: string; now: string; limit?: number }): string[] {
  const limit = input.limit ?? 32;
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) return [];
  const out: string[] = [];
  let cursor = input.after;
  while (out.length < limit) {
    const next = nextTriggerAt(rule, { after: cursor });
    if (next === null) break;
    if (Date.parse(next) > now) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/**
 * Dedup key of one planned occurrence (盒子 5: 同一预定时间不重复执行). Every
 * decided trigger — ran or skipped — records this key, so a restart, a clock
 * rollback or a second evaluation cannot act on the same occurrence twice.
 */
export function occurrenceKey(scheduleId: string, occurrence: string): string {
  return `${scheduleId}@${occurrence}`;
}

/**
 * Deadline of a confirmation a scheduled run is waiting on (盒子 4): the earlier
 * of 24 hours from the request and the next planned time. A once-only schedule
 * has no next plan, so its confirmation lives the full 24 hours.
 */
export function scheduledApprovalDeadline(input: { requestedAt: string; nextTriggerAt: string | null }): string {
  const requested = Date.parse(input.requestedAt);
  const deadline = requested + APPROVAL_DEADLINE_MS;
  if (input.nextTriggerAt === null) return new Date(deadline).toISOString();
  const nextPlan = Date.parse(input.nextTriggerAt);
  return new Date(Math.min(deadline, nextPlan)).toISOString();
}

export interface ScheduleTemplateDefinition {
  id: string;
  name: string;
  rule: string;
  prompt: string;
}

/** The five built-in, editable templates (盒子 2). */
export const SCHEDULE_TEMPLATES: readonly ScheduleTemplateDefinition[] = [
  {
    id: "tl-weekly-repo",
    name: "每周仓库改动摘要",
    rule: "每周日 18:00",
    prompt: "汇总本任务各仓库本周的提交、未合并分支与需要人工确认的改动。",
  },
  {
    id: "tl-standup",
    name: "站会主题准备",
    rule: "周一至周五 09:15",
    prompt: "根据工作区当前改动与未完成事项，列出今天站会要同步的三个要点。",
  },
  {
    id: "tl-weekly-contribution",
    name: "每周代码贡献统计",
    rule: "每周日 19:00",
    prompt: "统计本任务涉及的仓库本周代码贡献，按仓库与目录分组，并标注异常提交。",
  },
  {
    id: "tl-daily-risk",
    name: "每日代码风险巡检",
    rule: "周一至周五 17:00",
    prompt: "检查本任务工作区中未提交改动、过期依赖和明显风险点，给出处理建议。",
  },
  {
    id: "tl-release-prep",
    name: "每周发布准备检查",
    rule: "每周五 15:00",
    prompt: "核对发布前检查清单：构建、测试、配置差异和待合并分支。",
  },
];

/** The schedule fields a template is allowed to fill (盒子 2）。 */
export interface TemplateTargetSchedule {
  name: string;
  rule: string;
  prompt: string;
  providerId: string;
  model: string;
  permission: PiPermission;
  timezone: string;
}

export type ApplyTemplateResult =
  | { ok: true; schedule: TemplateTargetSchedule; previousName: string }
  | { ok: false; code: RuleParseCode; message: string };

/**
 * Apply one template (盒子 2): fills name / rule / prompt and changes nothing
 * else — the project, provider identity and model, session permission and the
 * IANA timezone stay exactly as they were. A template never enables or runs a
 * schedule by itself.
 */
export function applyScheduleTemplate(
  template: { id: string; name: string; rule: string; prompt: string },
  schedule: TemplateTargetSchedule,
): ApplyTemplateResult {
  const parsed = parseRuleText(template.rule, schedule.timezone);
  if (!parsed.ok) return { ok: false, code: parsed.code, message: parsed.message };
  return {
    ok: true,
    previousName: schedule.name,
    schedule: {
      ...schedule,
      name: template.name,
      rule: template.rule,
      prompt: template.prompt,
    },
  };
}

export type ScheduleConfigCode =
  | "provider-missing"
  | "provider-disabled"
  | "model-missing"
  | "permission-invalid"
  | "timezone-invalid"
  | "rule-invalid"
  | "prompt-empty"
  | "delivery-field";

export interface ScheduleConfigInput {
  providerId: string;
  model: string;
  permission: string;
  prompt: string;
  timezone: string;
  ruleText: string;
  /** Catalog as the Host knows it; only enabled providers with the model listed pass. */
  catalog: readonly { id: string; enabled?: boolean; models: readonly { id: string }[] }[];
  /** Extra keys the payload carried; delivery/nofification config is not a thing. */
  extraKeys?: readonly string[];
}

/**
 * Config validity (盒子 6「配置失效不静默换模型或项目」): every problem is named, and
 * a failing config refuses the run so the schedule shows 需要修复 instead of
 * quietly using another provider, model or project. Result handling lives in
 * the prompt, so a delivery-shaped field is refused rather than stored.
 */
export function validateScheduleConfig(input: ScheduleConfigInput): { ok: true } | { ok: false; code: ScheduleConfigCode; message: string } {
  for (const key of input.extraKeys ?? []) {
    if (DELIVERY_FIELDS.includes(key)) {
      return { ok: false, code: "delivery-field", message: `结果处理写在提示词中，不接受「${key}」这类发送配置` };
    }
  }
  if (input.providerId.trim().length === 0) return { ok: false, code: "provider-missing", message: "未选择 Provider 配置" };
  if (input.model.trim().length === 0) return { ok: false, code: "model-missing", message: "未选择模型" };
  // An empty catalog means the Host has not been handed one yet (no live
  // Provider config to check against): only the non-empty identity is required
  // then. Once a catalog exists, a provider/model missing from it is a real
  // failure and the run refuses instead of using another target.
  if (input.catalog.length > 0) {
    const provider = input.catalog.find((entry) => entry.id === input.providerId);
    if (!provider) return { ok: false, code: "provider-missing", message: `Provider 配置 ${input.providerId} 已不存在` };
    if (provider.enabled === false) return { ok: false, code: "provider-disabled", message: `Provider 配置 ${input.providerId} 已停用` };
    if (!provider.models.some((model) => model.id === input.model)) {
      return { ok: false, code: "model-missing", message: `模型 ${input.model} 不在 Provider ${input.providerId} 的可用列表中` };
    }
  }
  if (input.permission !== "read" && input.permission !== "default" && input.permission !== "auto") {
    return { ok: false, code: "permission-invalid", message: `会话权限 ${input.permission} 不是三档之一` };
  }
  if (!isIanaTimezone(input.timezone)) return { ok: false, code: "timezone-invalid", message: `时区 ${input.timezone} 不是 IANA 时区` };
  if (input.prompt.trim().length === 0) return { ok: false, code: "prompt-empty", message: "提示词不能为空（结果处理写在提示词中）" };
  const parsed = parseRuleText(input.ruleText, input.timezone);
  if (!parsed.ok) return { ok: false, code: "rule-invalid", message: parsed.message };
  return { ok: true };
}

/** Delivery/notification config is refused: the prompt carries result handling. */
export const DELIVERY_FIELDS: readonly string[] = ["deliver", "deliverTo", "notify", "notifyTo", "send", "sendTo", "channel", "webhook"];

export type TriggerSkipReason =
  | "disabled"
  | "archived"
  | "overlap"
  | "not-due"
  | "already-triggered"
  | "missed-offline"
  | "config-invalid";

export type TriggerDecision =
  | { decision: "run"; occurrence: string; occurrenceKey: string }
  | { decision: "skip"; reason: TriggerSkipReason; message: string; occurrence: string; occurrenceKey: string }
  | { decision: "idle"; message: string };

export interface TriggerInput {
  scheduleId: string;
  enabled: boolean;
  /** The task is archived: scheduling is paused and 立即运行 must not bypass it. */
  archived: boolean;
  rule: ScheduleRule;
  /** Evaluation watermark: occurrences after this one are new. */
  lastEvaluatedAt: string;
  now: string;
  /** A previous run of this schedule is still executing or waiting on a confirmation. */
  liveExecution: boolean;
  /** Occurrence keys already recorded (ran or skipped). */
  recordedKeys: readonly string[];
  /** Set when the saved config no longer resolves (Provider/model/timezone/rule). */
  configIssue?: string;
}

/**
 * Decide what one evaluation of a due schedule does (盒子 4/5/6).
 *
 * - Disabled / archived / invalid config: nothing runs (`立即运行` also refuses).
 * - The *latest* missed occurrence is the one this evaluation acts on; earlier
 *   occurrences in the same window are reported as `missed-offline` and are
 *   never replayed (离线不补跑). The caller records them as skipped runs.
 * - A still-running previous run skips the occurrence instead of queueing it.
 * - An occurrence whose key is already recorded can never run twice.
 */
export function planTrigger(input: TriggerInput): TriggerDecision {
  if (!input.enabled) return { decision: "idle", message: "已暂停" };
  if (input.configIssue !== undefined) {
    return { decision: "idle", message: `配置需要修复：${input.configIssue}` };
  }
  if (input.archived) return { decision: "idle", message: "任务已归档，调度已暂停" };
  const occurrences = occurrencesBetween(input.rule, { after: input.lastEvaluatedAt, now: input.now });
  if (occurrences.length === 0) return { decision: "idle", message: "未到期" };
  const occurrence = occurrences[occurrences.length - 1] as string;
  const key = occurrenceKey(input.scheduleId, occurrence);
  if (occurrences.length > 1) {
    const first = occurrences[0] as string;
    return {
      decision: "skip",
      reason: "missed-offline",
      message: `错过 ${occurrences.length - 1} 次触发（最早 ${first}）：离线期间不补跑，只记录原因`,
      occurrence,
      occurrenceKey: key,
    };
  }
  if (input.recordedKeys.includes(key)) {
    return { decision: "skip", reason: "already-triggered", message: "该预定时间已处理过，不重复触发", occurrence, occurrenceKey: key };
  }
  if (input.liveExecution) {
    return { decision: "skip", reason: "overlap", message: "上一次执行仍未结束，本次触发跳过并记录原因", occurrence, occurrenceKey: key };
  }
  return { decision: "run", occurrence, occurrenceKey: key };
}

/** Manual 立即运行 has its own result identity and never moves the plan (盒子 4). */
export function manualRunKey(scheduleId: string, requestedAt: string): string {
  return `${scheduleId}#manual@${requestedAt}`;
}

/** A scheduled run's own session id: independent, never a reused conversation. */
export function scheduledSessionId(runId: string): string {
  return `scheduled-${runId}`;
}

export type RemoteFetchVerdict =
  | { latest: true; statement: string }
  | { latest: false; statement: string; staleFrom?: string };

/**
 * 盒子 7：模板／统计获取远程记录失败时不得用陈旧数据声称「最新」。A failed fetch
 * always yields `latest: false` and names the cached snapshot the numbers came
 * from; only a successful fetch may claim the records are the newest.
 */
export function remoteFetchVerdict(input: {
  attemptedAt: string;
  fetchedAt?: string;
  failureReason?: string;
}): RemoteFetchVerdict {
  if (input.failureReason !== undefined && input.failureReason.trim().length > 0) {
    return {
      latest: false,
      ...(input.fetchedAt !== undefined ? { staleFrom: input.fetchedAt } : {}),
      statement:
        input.fetchedAt === undefined
          ? `本次获取远程记录失败（${input.failureReason}），没有可用记录，不能声称最新`
          : `本次获取远程记录失败（${input.failureReason}），以下基于 ${input.fetchedAt} 的快照，不是最新`,
    };
  }
  if (input.fetchedAt === undefined) {
    return { latest: false, statement: `尚未获取远程记录（请求于 ${input.attemptedAt}），不能声称最新` };
  }
  return { latest: true, statement: `远程记录获取成功（${input.fetchedAt}）` };
}

/**
 * One saved scheduled task (盒子 1): a stable schedule id, the fixed task
 * workspace it belongs to (`taskId`), the Provider identity + model id pair
 * (never a display name), the session permission of each new session, the
 * prompt, the rule text and its IANA timezone, plus the config version every
 * historic run keeps (`configVersion`).
 */
export interface StoredSchedule {
  scheduleId: string;
  taskId: string;
  projectId?: string;
  name: string;
  ruleText: string;
  timezone: string;
  prompt: string;
  providerId: string;
  model: string;
  permission: PiPermission;
  enabled: boolean;
  /** Bumped by every config save; historic runs report the version they used. */
  configVersion: number;
  /** Evaluation watermark: occurrences after this one are new (盒子 5). */
  lastEvaluatedAt: string;
  createdAt: string;
  updatedAt: string;
  /** Set when a run refused because the saved config no longer resolves. */
  repairIssue?: string;
}

export type ScheduledRunTrigger = "due" | "manual";
export type ScheduledRunResult = "completed" | "skipped" | "failed";

/**
 * One trigger result (盒子 4 定时执行是独立记录): the schedule config version it
 * used, the planned instant (or the manual request time), the created session,
 * the end state and the error/reason. A skipped trigger keeps the session field
 * empty — no session is created for a run that never starts.
 */
export interface ScheduledRunRecord {
  runId: string;
  scheduleId: string;
  taskId: string;
  configVersion: number;
  trigger: ScheduledRunTrigger;
  /** Dedup key of the planned occurrence (`manualRunKey` for 立即运行). */
  occurrenceKey: string;
  scheduledAt: string;
  startedAt: string;
  endedAt?: string;
  sessionId?: string;
  result: ScheduledRunResult;
  reason?: string;
  /** Values actually used by this run, so history does not follow later edits. */
  providerId: string;
  model: string;
  permission: PiPermission;
  ruleText: string;
}

/** What must survive a restart: the schedules plus every trigger record. */
export interface ScheduleDiskRecord {
  version: number;
  schedules: StoredSchedule[];
  runs: ScheduledRunRecord[];
}

export function emptyScheduleRecord(): ScheduleDiskRecord {
  return { version: 1, schedules: [], runs: [] };
}

/** Highest `n` in ids shaped `<prefix>-<n>`, so a restart never re-mints an id. */
export function highestSequence(ids: readonly string[], prefix: string): number {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let highest = 0;
  for (const id of ids) {
    const match = pattern.exec(id);
    if (match) highest = Math.max(highest, Number.parseInt(match[1] as string, 10));
  }
  return highest;
}

/**
 * Valid shape of a whole saved schedule config (盒子 6): every field the run
 * path later relies on is required, and `permission` is one of the three tiers.
 * The rule text is *not* parsed here — a config that no longer resolves is
 * reported as `repairIssue` by the run path instead of being dropped on load.
 */
export function scheduleConfigIssue(
  schedule: Pick<StoredSchedule, "providerId" | "model" | "permission" | "timezone" | "prompt" | "ruleText">,
  catalog: readonly { id: string; enabled?: boolean; models: readonly { id: string }[] }[],
): string | undefined {
  const result = validateScheduleConfig({
    providerId: schedule.providerId,
    model: schedule.model,
    permission: schedule.permission,
    prompt: schedule.prompt,
    timezone: schedule.timezone,
    ruleText: schedule.ruleText,
    catalog,
  });
  return result.ok ? undefined : result.message;
}
