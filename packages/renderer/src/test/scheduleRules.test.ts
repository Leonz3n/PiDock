/**
 * [PiDock 18] (#20) renderer mirror: the display/refusal rules the schedule page
 * and the edit dialog use. The mirror must accept exactly the rule forms the
 * shell parser accepts and must never invent a next trigger for arbitrary cron.
 */
import { describe, expect, it } from "vitest";
import {
  applyTemplateFields,
  canRunScheduleNow,
  isKnownTimezone,
  isIndependentRunSession,
  scheduleNextRunText,
  scheduleRunCreatedSession,
  scheduleRunDetail,
  scheduleRunTriggerLabel,
  scheduleStateLabel,
  templateNameFor,
  validateRuleText,
} from "../data/scheduleRules";

describe("schedule rule mirror", () => {
  it("accepts the same forms as the shell parser and names every refusal", () => {
    expect(validateRuleText("每日 09:15", "Asia/Shanghai")).toEqual({ ok: true, kind: "daily" });
    expect(validateRuleText("每周五 15:00", "Asia/Shanghai")).toEqual({ ok: true, kind: "weekly" });
    expect(validateRuleText("周一至周五 09:15", "Asia/Shanghai")).toEqual({ ok: true, kind: "weekly" });
    expect(validateRuleText("一次性 2026-10-01T09:00", "Asia/Shanghai")).toEqual({ ok: true, kind: "once" });
    expect(validateRuleText("*/15 9-17 * * 1-5", "Asia/Shanghai")).toEqual({ ok: true, kind: "cron" });
    expect(validateRuleText("", "Asia/Shanghai")).toMatchObject({ ok: false, code: "empty" });
    expect(validateRuleText("每日 09:15", "Mars/Olympus")).toMatchObject({ ok: false, code: "timezone-invalid" });
    expect(validateRuleText("每日 25:00", "Asia/Shanghai")).toMatchObject({ ok: false, code: "time-invalid" });
    expect(validateRuleText("每周八 09:15", "Asia/Shanghai")).toMatchObject({ ok: false, code: "weekday-invalid" });
    expect(validateRuleText("一次性 2026-02-30T09:00", "Asia/Shanghai")).toMatchObject({ ok: false, code: "once-time-invalid" });
    expect(validateRuleText("一次性 明天", "Asia/Shanghai")).toMatchObject({ ok: false, code: "once-time-invalid" });
    expect(validateRuleText("60 * * * *", "Asia/Shanghai")).toMatchObject({ ok: false, code: "cron-invalid" });
    expect(validateRuleText("随便跑一下", "Asia/Shanghai")).toMatchObject({ ok: false, code: "rule-unrecognized" });
    expect(isKnownTimezone("Asia/Shanghai")).toBe(true);
    expect(isKnownTimezone("Nowhere/Else")).toBe(false);
  });
});

describe("schedule display rules", () => {
  const schedule = { enabled: true, nextRun: "2026-09-25T15:00:00+08:00" };

  it("reads a schedule's state with repair and archive taking precedence", () => {
    expect(scheduleStateLabel(schedule, { archived: false })).toMatchObject({ label: "已启用", tone: "accent" });
    expect(scheduleStateLabel({ enabled: false }, { archived: false })).toMatchObject({ label: "已暂停" });
    expect(scheduleStateLabel({ ...schedule, repairIssue: "模型已移除" }, { archived: false })).toMatchObject({
      label: "需要修复",
      tone: "warn",
      detail: "模型已移除",
    });
    expect(scheduleStateLabel(schedule, { archived: true })).toMatchObject({ label: "已归档（暂停）" });
    expect(scheduleNextRunText(schedule, { archived: false })).toBe("2026-09-25T15:00:00+08:00");
    expect(scheduleNextRunText({ enabled: false, nextRun: "已暂停" }, { archived: false })).toBe("已暂停");
    expect(scheduleNextRunText(schedule, { archived: true })).toContain("已归档");
    expect(scheduleNextRunText({ ...schedule, repairIssue: "模型已移除" }, { archived: false })).toContain("需要修复");
  });

  it("refuses 立即运行 for an archived task and describes one run's trigger and reason", () => {
    expect(canRunScheduleNow({ archived: false })).toEqual({ ok: true });
    expect(canRunScheduleNow({ archived: true })).toMatchObject({ ok: false });
    expect(canRunScheduleNow({ archived: true }).reason).toContain("绕过恢复");
    expect(scheduleRunTriggerLabel("manual")).toBe("立即运行");
    expect(scheduleRunTriggerLabel("due")).toBe("计划触发");
    expect(scheduleRunDetail({ id: "run-1", scheduleId: "s", taskId: "t", at: "x", result: "skipped", reason: "上一次执行仍未结束" })).toBe(
      "上一次执行仍未结束",
    );
    expect(scheduleRunDetail({ id: "run-1", scheduleId: "s", taskId: "t", at: "x", result: "completed", sessionId: "scheduled-run-1" })).toBe(
      "会话 scheduled-run-1",
    );
    expect(scheduleRunCreatedSession({ result: "skipped" })).toBe(false);
    expect(scheduleRunCreatedSession({ result: "completed", sessionId: "scheduled-run-1" })).toBe(true);
    // A run parked on a confirmation is not a skipped run: its session exists.
    expect(scheduleRunCreatedSession({ result: "awaiting-approval", sessionId: "scheduled-run-2" })).toBe(true);
    expect(isIndependentRunSession({ sessionId: "scheduled-run-2" }, { sessionId: "scheduled-run-1" })).toBe(true);
  });

  it("applies a template without touching provider/model/permission/timezone and only fills an empty name", () => {
    const target = {
      name: "旧名称",
      rule: "每日 09:15",
      prompt: "旧提示词",
      providerId: "provider-anthropic",
      model: "claude-sonnet",
      permission: "default" as const,
      timezone: "Asia/Shanghai",
    };
    expect(applyTemplateFields({ name: "站会主题准备", rule: "周一至周五 09:15", prompt: "新提示词" }, target)).toEqual({
      ...target,
      name: "站会主题准备",
      rule: "周一至周五 09:15",
      prompt: "新提示词",
    });
    expect(templateNameFor("", { name: "站会主题准备" })).toBe("站会主题准备");
    expect(templateNameFor("站会主题准备", { name: "站会主题准备" }, "站会主题准备")).toBe("站会主题准备");
    expect(templateNameFor("我自己的名字", { name: "站会主题准备" })).toBe("我自己的名字");
  });
});
