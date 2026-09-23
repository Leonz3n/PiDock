import { describe, expect, it } from "vitest";
import {
  applyScheduleTemplate,
  describeRule,
  isIanaTimezone,
  manualRunKey,
  nextTriggerAt,
  occurrenceKey,
  occurrencesBetween,
  parseRuleText,
  planTrigger,
  remoteFetchVerdict,
  SCHEDULE_TEMPLATES,
  scheduledApprovalDeadline,
  templateFetchPlan,
  validateScheduleConfig,
  type ScheduleRule,
} from "./schedule-rules.js";

function rule(text: string, timezone = "Asia/Shanghai"): ScheduleRule {
  const parsed = parseRuleText(text, timezone);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.rule;
}

const CATALOG = [
  { id: "provider-anthropic", enabled: true, models: [{ id: "claude-sonnet" }, { id: "claude-haiku" }] },
  { id: "provider-local", enabled: false, models: [{ id: "local-small" }] },
];

describe("schedule rule parsing", () => {
  it("accepts daily / weekly / once / five-field cron and refuses anything else", () => {
    expect(rule("每日 09:15")).toEqual({ kind: "daily", time: "09:15", timezone: "Asia/Shanghai" });
    expect(rule("每周日 18:00")).toEqual({ kind: "weekly", days: [0], time: "18:00", timezone: "Asia/Shanghai" });
    expect(rule("周一至周五 09:15")).toEqual({ kind: "weekly", days: [1, 2, 3, 4, 5], time: "09:15", timezone: "Asia/Shanghai" });
    expect(rule("一次性 2026-10-01T09:00")).toEqual({ kind: "once", at: "2026-10-01T09:00", timezone: "Asia/Shanghai" });
    expect(rule("*/15 9-17 * * 1-5")).toEqual({ kind: "cron", expression: "*/15 9-17 * * 1-5", timezone: "Asia/Shanghai" });
    expect(parseRuleText("每周八 09:00", "Asia/Shanghai")).toMatchObject({ ok: false, code: "weekday-invalid" });
    expect(parseRuleText("每日 25:00", "Asia/Shanghai")).toMatchObject({ ok: false, code: "time-invalid" });
    expect(parseRuleText("60 * * * *", "Asia/Shanghai")).toMatchObject({ ok: false, code: "cron-invalid" });
    expect(parseRuleText("随便跑一下", "Asia/Shanghai")).toMatchObject({ ok: false, code: "rule-unrecognized" });
    expect(parseRuleText("每日 09:15", "Mars/Olympus")).toMatchObject({ ok: false, code: "timezone-invalid" });
    expect(parseRuleText("", "Asia/Shanghai")).toMatchObject({ ok: false, code: "empty" });
  });

  it("rejects a once-time the zone skips (spring-forward gap) instead of firing twice", () => {
    const skipped = parseRuleText("一次性 2026-03-08T02:30", "America/New_York");
    expect(skipped).toMatchObject({ ok: false, code: "once-time-invalid" });
    expect(isIanaTimezone("America/New_York")).toBe(true);
    expect(isIanaTimezone("Asia/Shanghai")).toBe(true);
    expect(isIanaTimezone("Nowhere/Else")).toBe(false);
  });

  it("describes a rule in readable form", () => {
    expect(describeRule(rule("每日 09:15"))).toBe("每日 09:15");
    expect(describeRule(rule("每周一至周五 09:15"))).toBe("每周一、周二、周三、周四、周五 09:15");
    expect(describeRule(rule("每周日 18:00"))).toBe("每周日 18:00");
    expect(describeRule(rule("一次性 2026-10-01T09:00"))).toBe("一次性 2026-10-01T09:00");
    expect(describeRule(rule("0 18 * * 0"))).toBe("Cron 0 18 * * 0");
  });
});

describe("next trigger in the saved IANA timezone", () => {
  it("computes the next daily / weekly / once / cron instant", () => {
    // 2026-09-23T09:00Z is 17:00 in Shanghai: the next daily 09:15 is the 24th.
    expect(nextTriggerAt(rule("每日 09:15"), { after: "2026-09-23T09:00:00.000Z" })).toBe("2026-09-24T01:15:00.000Z");
    // Same instant is 05:00 in New York: the daily 09:15 still fires that day.
    expect(nextTriggerAt(rule("每日 09:15", "America/New_York"), { after: "2026-09-23T09:00:00.000Z" })).toBe(
      "2026-09-23T13:15:00.000Z",
    );
    expect(nextTriggerAt(rule("每周五 15:00"), { after: "2026-09-23T09:00:00.000Z" })).toBe("2026-09-25T07:00:00.000Z");
    expect(nextTriggerAt(rule("0 18 * * 0"), { after: "2026-09-23T09:00:00.000Z" })).toBe("2026-09-27T10:00:00.000Z");
    expect(nextTriggerAt(rule("一次性 2026-10-01T09:00"), { after: "2026-09-23T09:00:00.000Z" })).toBe("2026-10-01T01:00:00.000Z");
  });

  it("has no next trigger once a once-only time has passed, and never invents one", () => {
    expect(nextTriggerAt(rule("一次性 2026-10-01T09:00"), { after: "2026-10-01T01:00:00.000Z" })).toBeNull();
  });

  it("keeps the wall-clock time across a DST change instead of drifting by an hour", () => {
    // US DST ends 2026-11-01: 09:00 New York is 13:00Z before, 14:00Z after.
    expect(nextTriggerAt(rule("每日 09:00", "America/New_York"), { after: "2026-10-30T12:30:00.000Z" })).toBe(
      "2026-10-30T13:00:00.000Z",
    );
    expect(nextTriggerAt(rule("每日 09:00", "America/New_York"), { after: "2026-11-02T14:30:00.000Z" })).toBe(
      "2026-11-03T14:00:00.000Z",
    );
  });
});

describe("occurrence window and dedup key", () => {
  it("lists occurrences in (after, now] oldest first and bounds the list", () => {
    expect(
      occurrencesBetween(rule("每日 09:15"), { after: "2026-09-20T09:00:00.000Z", now: "2026-09-24T02:00:00.000Z" }),
    ).toEqual(["2026-09-21T01:15:00.000Z", "2026-09-22T01:15:00.000Z", "2026-09-23T01:15:00.000Z", "2026-09-24T01:15:00.000Z"]);
    expect(
      occurrencesBetween(rule("每日 09:15"), { after: "2026-09-20T09:00:00.000Z", now: "2026-09-24T02:00:00.000Z", limit: 2 }),
    ).toHaveLength(2);
    expect(occurrencesBetween(rule("每日 09:15"), { after: "2026-09-23T02:00:00.000Z", now: "2026-09-23T02:30:00.000Z" })).toEqual([]);
  });

  it("derives a stable key from the schedule and the planned instant", () => {
    expect(occurrenceKey("schedule-1", "2026-09-24T01:15:00.000Z")).toBe("schedule-1@2026-09-24T01:15:00.000Z");
    expect(manualRunKey("schedule-1", "2026-09-23T09:00:00.000Z")).toContain("#manual@");
  });
});

describe("scheduled confirmation deadline", () => {
  it("expires at the earlier of 24h and the next planned time", () => {
    expect(
      scheduledApprovalDeadline({ requestedAt: "2026-09-23T09:00:00.000Z", nextTriggerAt: "2026-09-23T12:00:00.000Z" }),
    ).toBe("2026-09-23T12:00:00.000Z");
    expect(
      scheduledApprovalDeadline({ requestedAt: "2026-09-23T09:00:00.000Z", nextTriggerAt: "2026-09-30T12:00:00.000Z" }),
    ).toBe("2026-09-24T09:00:00.000Z");
    expect(scheduledApprovalDeadline({ requestedAt: "2026-09-23T09:00:00.000Z", nextTriggerAt: null })).toBe(
      "2026-09-24T09:00:00.000Z",
    );
  });

  it("never puts the deadline before the request when the next plan already passed", () => {
    // Evaluated late: the occurrence was 09:15, its next plan 09:16 is already
    // gone by the 09:16:30 request. The confirmation must not be born expired.
    expect(
      scheduledApprovalDeadline({ requestedAt: "2026-09-23T09:16:30.000Z", nextTriggerAt: "2026-09-23T09:16:00.000Z" }),
    ).toBe("2026-09-23T09:16:30.000Z");
  });
});

describe("trigger planning", () => {
  const base = {
    scheduleId: "schedule-1",
    enabled: true,
    archived: false,
    rule: rule("每日 09:15"),
    lastEvaluatedAt: "2026-09-22T01:20:00.000Z",
    now: "2026-09-24T01:20:00.000Z",
    liveExecution: false,
    recordedKeys: [] as string[],
  };

  it("runs the one due occurrence and skips the earlier ones as offline misses", () => {
    const decision = planTrigger(base);
    expect(decision).toMatchObject({ decision: "skip", reason: "missed-offline" });
    expect(planTrigger({ ...base, lastEvaluatedAt: "2026-09-24T01:00:00.000Z" })).toMatchObject({
      decision: "run",
      occurrence: "2026-09-24T01:15:00.000Z",
      occurrenceKey: "schedule-1@2026-09-24T01:15:00.000Z",
    });
  });

  it("skips a still-running previous run and a not-due schedule", () => {
    const due = { ...base, lastEvaluatedAt: "2026-09-24T01:00:00.000Z" };
    expect(planTrigger({ ...due, liveExecution: true })).toMatchObject({ decision: "skip", reason: "overlap" });
    expect(planTrigger({ ...due, lastEvaluatedAt: "2026-09-24T01:16:00.000Z" })).toMatchObject({ decision: "idle" });
  });

  it("never runs the same occurrence twice once its key is recorded", () => {
    const due = { ...base, lastEvaluatedAt: "2026-09-24T01:00:00.000Z" };
    expect(planTrigger({ ...due, recordedKeys: ["schedule-1@2026-09-24T01:15:00.000Z"] })).toMatchObject({
      decision: "skip",
      reason: "already-triggered",
    });
  });

  it("does nothing while paused, archived, or carrying a config problem", () => {
    const due = { ...base, lastEvaluatedAt: "2026-09-24T01:00:00.000Z" };
    expect(planTrigger({ ...due, enabled: false })).toEqual({ decision: "idle", message: "已暂停" });
    expect(planTrigger({ ...due, archived: true })).toMatchObject({ decision: "idle" });
    expect(planTrigger({ ...due, configIssue: "模型已移除" })).toMatchObject({
      decision: "idle",
      message: "配置需要修复：模型已移除",
    });
  });
});

describe("templates and config validity", () => {
  it("ships the five templates and keeps project/provider/model/permission/timezone on apply", () => {
    expect(SCHEDULE_TEMPLATES.map((template) => template.id)).toEqual([
      "tl-weekly-repo",
      "tl-standup",
      "tl-weekly-contribution",
      "tl-daily-risk",
      "tl-release-prep",
    ]);
    const applied = applyScheduleTemplate(SCHEDULE_TEMPLATES[1] as (typeof SCHEDULE_TEMPLATES)[number], {
      name: "",
      rule: "",
      prompt: "",
      providerId: "provider-anthropic",
      model: "claude-sonnet",
      permission: "default",
      timezone: "Asia/Shanghai",
    });
    expect(applied).toMatchObject({
      ok: true,
      schedule: {
        name: "站会主题准备",
        rule: "周一至周五 09:15",
        providerId: "provider-anthropic",
        model: "claude-sonnet",
        permission: "default",
        timezone: "Asia/Shanghai",
      },
    });
    const failing = applyScheduleTemplate(
      { id: "x", name: "x", rule: "每周八 09:00", prompt: "p" },
      { name: "", rule: "", prompt: "", providerId: "p", model: "m", permission: "default", timezone: "Asia/Shanghai" },
    );
    expect(failing).toMatchObject({ ok: false, code: "weekday-invalid" });
  });

  it("names every config problem instead of silently swapping a target", () => {
    const valid = {
      providerId: "provider-anthropic",
      model: "claude-sonnet",
      permission: "default",
      prompt: "汇总本周改动",
      timezone: "Asia/Shanghai",
      ruleText: "每日 09:15",
      catalog: CATALOG,
    };
    expect(validateScheduleConfig(valid)).toEqual({ ok: true });
    expect(validateScheduleConfig({ ...valid, providerId: "provider-gone" })).toMatchObject({ ok: false, code: "provider-missing" });
    expect(validateScheduleConfig({ ...valid, providerId: "provider-local" })).toMatchObject({ ok: false, code: "provider-disabled" });
    expect(validateScheduleConfig({ ...valid, model: "claude-opus" })).toMatchObject({ ok: false, code: "model-missing" });
    expect(validateScheduleConfig({ ...valid, permission: "superuser" })).toMatchObject({ ok: false, code: "permission-invalid" });
    expect(validateScheduleConfig({ ...valid, timezone: "Mars/Olympus" })).toMatchObject({ ok: false, code: "timezone-invalid" });
    expect(validateScheduleConfig({ ...valid, prompt: "   " })).toMatchObject({ ok: false, code: "prompt-empty" });
    expect(validateScheduleConfig({ ...valid, ruleText: "每天跑一下" })).toMatchObject({ ok: false, code: "rule-invalid" });
    expect(validateScheduleConfig({ ...valid, extraKeys: ["webhook"] })).toMatchObject({ ok: false, code: "delivery-field" });
  });
});

describe("stale remote records", () => {
  it("never claims the newest records when the fetch failed", () => {
    const failed = remoteFetchVerdict({ attemptedAt: "2026-09-23T09:00:00.000Z", fetchedAt: "2026-09-16T09:00:00.000Z", failureReason: "网络不可用" });
    expect(failed).toMatchObject({ latest: false, staleFrom: "2026-09-16T09:00:00.000Z" });
    expect(failed.statement).not.toContain("最新获取成功");
    expect(failed.statement).toContain("不是最新");
    expect(remoteFetchVerdict({ attemptedAt: "2026-09-23T09:00:00.000Z", failureReason: "认证失败" }).statement).toContain("不能声称最新");
    expect(remoteFetchVerdict({ attemptedAt: "2026-09-23T09:00:00.000Z" }).latest).toBe(false);
    expect(remoteFetchVerdict({ attemptedAt: "2026-09-23T09:00:00.000Z", fetchedAt: "2026-09-23T08:59:00.000Z" })).toMatchObject({ latest: true });
  });

  it("fetches remote records for a template without merging the workspace", () => {
    const plan = templateFetchPlan({ templateId: "tl-weekly-contribution", attemptedAt: "2026-09-23T09:00:00.000Z", failureReason: "网络不可用" });
    expect(plan).toMatchObject({ templateId: "tl-weekly-contribution", mergesWorkspace: false, writesWorkspace: false, verdict: { latest: false } });
    expect(plan.verdict.statement).toContain("不能声称最新");
    expect(templateFetchPlan({ templateId: "tl-release-prep", attemptedAt: "2026-09-23T09:00:00.000Z", fetchedAt: "2026-09-16T09:00:00.000Z", failureReason: "网络不可用" }).verdict.statement).toContain("基于");
    expect(templateFetchPlan({ templateId: "tl-standup", attemptedAt: "2026-09-23T09:00:00.000Z", fetchedAt: "2026-09-23T08:30:00.000Z" })).toMatchObject({
      verdict: { latest: true },
      mergesWorkspace: false,
    });
  });
});
