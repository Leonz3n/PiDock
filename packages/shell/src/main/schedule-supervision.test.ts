import { describe, expect, it } from "vitest";
import {
  emptyScheduleRecord,
  reconcileScheduledRuns,
  wakeSchedulesForward,
  type ScheduleDiskRecord,
  type ScheduledRunRecord,
  type StoredSchedule,
} from "./schedule-rules.js";
import { ScheduleDriver } from "./schedule-driver.js";
import { QuitReportStore, SchedulerGate } from "./schedule-supervision.js";

function run(overrides: Partial<ScheduledRunRecord>): ScheduledRunRecord {
  return {
    runId: "run-1",
    scheduleId: "schedule-1",
    taskId: "task-a",
    configVersion: 1,
    trigger: "due",
    occurrenceKey: "schedule-1@2026-09-24T01:15:00.000Z",
    scheduledAt: "2026-09-24T01:15:00.000Z",
    startedAt: "2026-09-24T01:15:00.000Z",
    result: "running",
    providerId: "provider-anthropic",
    model: "claude-sonnet",
    permission: "default",
    ruleText: "每日 09:15",
    ...overrides,
  };
}

function schedule(overrides: Partial<StoredSchedule> = {}): StoredSchedule {
  return {
    scheduleId: "schedule-1",
    taskId: "task-a",
    name: "每日巡检",
    ruleText: "每日 09:15",
    timezone: "Asia/Shanghai",
    prompt: "检查风险",
    providerId: "provider-anthropic",
    model: "claude-sonnet",
    permission: "default",
    enabled: true,
    configVersion: 1,
    lastEvaluatedAt: "2026-09-23T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function record(runs: ScheduledRunRecord[], schedules: StoredSchedule[] = [schedule()]): ScheduleDiskRecord {
  return { ...emptyScheduleRecord(), schedules, runs };
}

describe("[Pencil T18] #153 restart reconciliation", () => {
  it("names a dead bound run interrupted, never completed, and keeps its occurrence key", () => {
    const before = record([run({ sessionId: "scheduled-run-1" })]);
    const outcome = reconcileScheduledRuns({
      record: before,
      presence: () => "absent",
      resolvedAt: "2026-09-24T02:00:00.000Z",
    });
    expect(outcome.recovered).toEqual([
      expect.objectContaining({ runId: "run-1", result: "interrupted", failureCode: "execution-interrupted" }),
    ]);
    const after = outcome.record.runs[0]!;
    expect(after).toMatchObject({ result: "interrupted", endedAt: "2026-09-24T02:00:00.000Z", sessionId: "scheduled-run-1" });
    expect(after.result).not.toBe("completed");
    // The occurrence key survives: a restart can never start the same occurrence again.
    expect(after.occurrenceKey).toBe(before.runs[0]!.occurrenceKey);
  });

  it("names a crash mid-trigger uncertain: the record is written but the start was never confirmed", () => {
    const before = record([run({})]);
    const outcome = reconcileScheduledRuns({
      record: before,
      presence: () => "absent",
      resolvedAt: "2026-09-24T02:00:00.000Z",
    });
    expect(outcome.recovered[0]).toMatchObject({ result: "uncertain", failureCode: "trigger-unconfirmed" });
    expect(outcome.record.runs[0]!.sessionId).toBeUndefined();
    expect(outcome.record.runs[0]!.reason).toContain("触发状态不确定");
  });

  it("keeps a live execution running and names an unreadable one uncertain", () => {
    const live = reconcileScheduledRuns({ record: record([run({ sessionId: "scheduled-run-1" })]), presence: () => "live", resolvedAt: "2026-09-24T02:00:00.000Z" });
    expect(live.recovered).toEqual([]);
    expect(live.record.runs[0]!.result).toBe("running");
    const unknown = reconcileScheduledRuns({ record: record([run({ sessionId: "scheduled-run-1" })]), presence: () => "unknown", resolvedAt: "2026-09-24T02:00:00.000Z" });
    expect(unknown.recovered[0]).toMatchObject({ result: "uncertain", failureCode: "execution-presence-unknown" });
  });

  it("never rewrites a settled record", () => {
    const settled = record([run({ result: "completed", sessionId: "scheduled-run-1", endedAt: "2026-09-24T01:20:00.000Z" })]);
    const outcome = reconcileScheduledRuns({ record: settled, presence: () => "absent", resolvedAt: "2026-09-24T02:00:00.000Z" });
    expect(outcome.recovered).toEqual([]);
    expect(outcome.record.runs[0]!.result).toBe("completed");
  });
});

describe("[Pencil T18] #153 sleep/wake", () => {
  it("wakes forward: no backfill, the plan moves past the resume instant", () => {
    const outcome = wakeSchedulesForward({ schedules: [schedule()], resumedAt: "2026-09-26T03:00:00.000Z" });
    expect(outcome.moved).toEqual(["schedule-1"]);
    const next = outcome.schedules[0]!;
    expect(next.lastEvaluatedAt).toBe("2026-09-26T03:00:00.000Z");
    // A daily 09:15 Asia/Shanghai rule: the next occurrence is the NEXT day's, not the slept-through one.
    expect(next.nextRunAt).toBe("2026-09-27T01:15:00.000Z");
  });

  it("leaves paused schedules untouched", () => {
    const outcome = wakeSchedulesForward({ schedules: [schedule({ enabled: false })], resumedAt: "2026-09-26T03:00:00.000Z" });
    expect(outcome.moved).toEqual([]);
    expect(outcome.schedules[0]!.lastEvaluatedAt).toBe("2026-09-23T00:00:00.000Z");
  });
});

describe("[Pencil T18] #153 scheduler phase gate", () => {
  it("refuses every due evaluation while quitting or asleep and resumes after wake", () => {
    const gate = new SchedulerGate();
    expect(gate.blockedReason()).toBeNull();
    gate.beginQuit();
    expect(gate.blockedReason()).toContain("正在退出");
    gate.abortQuit({ at: "2026-09-24T02:00:00.000Z", hosts: ["task-a"] });
    expect(gate.blockedReason()).toBeNull();
    gate.sleep("2026-09-25T22:00:00.000Z");
    expect(gate.blockedReason()).toContain("休眠");
    const wake = gate.wake("2026-09-26T03:00:00.000Z");
    expect(wake).toEqual({ since: "2026-09-25T22:00:00.000Z", at: "2026-09-26T03:00:00.000Z" });
    expect(gate.blockedReason()).toBeNull();
    expect(gate.wake("2026-09-26T03:00:01.000Z")).toBeNull();
    gate.beginQuit();
    expect(gate.wake("2026-09-26T04:00:00.000Z")).toBeNull();
  });

  it("keeps a failed quit visible after the app continued", () => {
    const writes: { path: string; contents: string }[] = [];
    const store = new QuitReportStore("/tmp/pidock-quit", {
      writeFile: (path, contents) => writes.push({ path, contents }),
      readFile: () => writes[writes.length - 1]!.contents,
    });
    const gate = new SchedulerGate(store);
    gate.beginQuit();
    gate.abortQuit({ at: "2026-09-24T02:00:00.000Z", hosts: ["task-b"], attempts: 3 });
    const view = gate.view();
    expect(view.phase).toBe("active");
    expect(view.lastQuitUnconfirmed).toEqual({ at: "2026-09-24T02:00:00.000Z", hosts: ["task-b"], attempts: 3 });
    expect(store.pending()).toEqual({ at: "2026-09-24T02:00:00.000Z", hosts: ["task-b"], attempts: 3 });
    expect(writes[0]!.path).toBe("/tmp/pidock-quit/quit-unconfirmed.json");
    gate.completeQuit();
    expect(gate.view().lastQuitUnconfirmed).toBeUndefined();
  });

  it("makes the driver tick a named no-op while blocked", async () => {
    let blocked: string | null = "系统休眠中：不执行定时触发";
    const calls: string[] = [];
    const driver = new ScheduleDriver({
      hostTaskIds: () => ["task-a"],
      evaluate: async (taskId) => { calls.push(taskId); },
      blockedReason: () => blocked,
    });
    expect(await driver.tick()).toEqual({ evaluated: [], skipped: ["task-a"], failures: [], blocked: "系统休眠中：不执行定时触发" });
    expect(calls).toEqual([]);
    blocked = null;
    expect((await driver.tick()).evaluated).toEqual(["task-a"]);
    expect(calls).toEqual(["task-a"]);
  });
});
