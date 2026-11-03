import { describe, expect, it } from "vitest";
import {
  firstScheduleRefusal,
  isDedicatedScheduleTask,
  nextRunAtOf,
  scheduleDefinitionIssues,
  scheduleRunView,
  taskKindMarker,
} from "./schedule-task.js";
import type { ScheduledRunRecord } from "./schedule-rules.js";

const catalog = [
  { id: "provider-a", enabled: true, models: [{ id: "model-a" }, { id: "model-b" }] },
  { id: "provider-off", enabled: false, models: [{ id: "model-a" }] },
];

function definition(overrides: Partial<Parameters<typeof scheduleDefinitionIssues>[0]> = {}) {
  return {
    name: "每日构建",
    prompt: "检查构建并报告结果",
    providerId: "provider-a",
    model: "model-a",
    permission: "default",
    ruleText: "每日 09:00",
    timezone: "Asia/Shanghai",
    catalog,
    credentialPresent: true,
    directoryPresent: true,
    ...overrides,
  };
}

function run(overrides: Partial<ScheduledRunRecord> = {}): ScheduledRunRecord {
  return {
    runId: "run-1",
    scheduleId: "schedule-1",
    taskId: "task-1",
    configVersion: 2,
    trigger: "due",
    occurrenceKey: "schedule-1@2026-03-01T01:00:00.000Z",
    scheduledAt: "2026-03-01T01:00:00.000Z",
    startedAt: "2026-03-01T01:00:01.000Z",
    endedAt: "2026-03-01T01:01:00.000Z",
    sessionId: "session-9",
    result: "completed",
    providerId: "provider-a",
    model: "model-a",
    permission: "default",
    ruleText: "每日 09:00",
    ...overrides,
  };
}

describe("dedicated schedule task invariant (#152)", () => {
  it("treats only an explicit scheduled marker as a schedule task", () => {
    expect(taskKindMarker("scheduled")).toBe("scheduled");
    expect(taskKindMarker("normal")).toBe("normal");
    // A record written before #152 has no kind at all.
    expect(taskKindMarker(undefined)).toBe("normal");
    expect(isDedicatedScheduleTask({ kind: "scheduled" })).toBe(true);
    expect(isDedicatedScheduleTask({ kind: "normal" })).toBe(false);
    expect(isDedicatedScheduleTask(null)).toBe(false);
  });

  it("refuses to bolt a first rule onto an ordinary task", () => {
    const refused = firstScheduleRefusal({ kind: "normal", existingSchedules: 0, creating: true });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("not-schedule-task");
      expect(refused.message).toContain("专属定时任务");
    }
    // A legacy record without a kind is an ordinary task too.
    expect(firstScheduleRefusal({ kind: undefined, existingSchedules: 0, creating: true }).ok).toBe(false);
  });

  it("allows creating inside a dedicated task and editing an existing rule", () => {
    expect(firstScheduleRefusal({ kind: "scheduled", existingSchedules: 0, creating: true }).ok).toBe(true);
    expect(firstScheduleRefusal({ kind: "normal", existingSchedules: 1, creating: false }).ok).toBe(true);
  });
});

describe("named definition failures (#152)", () => {
  it("accepts a complete definition", () => {
    expect(scheduleDefinitionIssues(definition())).toEqual({ ok: true });
  });

  it.each([
    [{ name: "  " }, "name-empty"],
    [{ prompt: " " }, "prompt-empty"],
    [{ providerId: "" }, "provider-missing"],
    [{ model: "" }, "model-missing"],
    [{ permission: "root" }, "permission-invalid"],
    [{ timezone: "Mars/Olympus" }, "timezone-invalid"],
    [{ timezone: "" }, "timezone-invalid"],
    [{ ruleText: "每日 25:00" }, "rule-invalid"],
    [{ ruleText: "每日 09:00", timezone: "Asia/Shanghai", prompt: "x", model: "model-a", providerId: "provider-a", catalog: [{ id: "provider-a", models: [] }] }, "model-not-declared"],
    [{ providerId: "provider-off" }, "provider-missing"],
    [{ providerId: "provider-missing" }, "provider-missing"],
    [{ credentialPresent: false }, "credential-missing"],
    [{ directoryPresent: false }, "directory-missing"],
  ] as const)("names the failure for %o", (overrides, code) => {
    const result = scheduleDefinitionIssues(definition(overrides));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(code);
  });

  it("does not invent a Provider failure before the Host has a catalog", () => {
    // An empty catalog means "not handed over yet", never "does not exist".
    expect(scheduleDefinitionIssues(definition({ catalog: [] })).ok).toBe(true);
  });

  it("reports a bad cron expression instead of substituting a rule", () => {
    const result = scheduleDefinitionIssues(definition({ ruleText: "*/5 * * *" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
  });
});

describe("persisted next plan (#152)", () => {
  it("computes the next trigger in the saved timezone", () => {
    const next = nextRunAtOf({ ruleText: "每日 09:00", timezone: "Asia/Shanghai" }, "2026-03-01T00:30:00.000Z");
    expect(next).toBe("2026-03-01T01:00:00.000Z");
  });

  it("returns null for an invalid rule instead of fabricating a time", () => {
    expect(nextRunAtOf({ ruleText: "不是规则", timezone: "Asia/Shanghai" }, "2026-03-01T00:30:00.000Z")).toBeNull();
  });

  it("returns null for a consumed one-shot", () => {
    expect(nextRunAtOf({ ruleText: "一次性 2026-02-01T09:00", timezone: "Asia/Shanghai" }, "2026-03-01T00:30:00.000Z")).toBeNull();
  });
});

describe("S04 run record view (#152)", () => {
  it("shows the actual model, the linked session and a resumable status", () => {
    const view = scheduleRunView(run({ actualModel: "model-b" }));
    expect(view.model).toBe("model-b");
    expect(view.actualModel).toBe(true);
    expect(view.sessionId).toBe("session-9");
    expect(view.status).toBe("completed");
    expect(view.statusLabel).toBe("完成");
    expect(view.resumable).toBe(true);
  });

  it("keeps a still-running accepted turn honest", () => {
    const view = scheduleRunView(run({ result: "running", endedAt: undefined, actualModel: "model-b" }));
    expect(view.status).toBe("running");
    expect(view.statusLabel).toBe("执行中");
    expect(view.resumable).toBe(true);
  });

  it("never claims a model was used by a run that never started", () => {
    const view = scheduleRunView(
      run({ result: "failed", sessionId: undefined, actualModel: undefined, reason: "配置需要修复：凭据失效" }),
    );
    expect(view.model).toBe("model-a");
    expect(view.actualModel).toBe(false);
    expect(view.sessionId).toBeUndefined();
    expect(view.resumable).toBe(false);
    expect(view.detail).toBe("配置需要修复：凭据失效");
    expect(view.statusLabel).toBe("失败");
  });

  it("does not offer a conversation for a skipped run", () => {
    const view = scheduleRunView(run({ result: "skipped", sessionId: undefined, reason: "上一次执行仍未结束" }));
    expect(view.statusLabel).toBe("已跳过");
    expect(view.resumable).toBe(false);
    expect(view.detail).toBe("上一次执行仍未结束");
  });

  it("reports an unknown persisted result as unknown, not as success", () => {
    const view = scheduleRunView(run({ result: "something-else" as ScheduledRunRecord["result"] }));
    expect(view.status).toBe("unknown");
    expect(view.statusLabel).toBe("未知");
  });
});
