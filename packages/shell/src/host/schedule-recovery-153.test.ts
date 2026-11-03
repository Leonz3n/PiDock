import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskSchedules, type SchedulePorts, type ScheduleStartResult } from "./schedules.js";
import { parseScheduleRecord, serializeScheduleRecord } from "./task-store.js";
import { emptyScheduleRecord, type ScheduleDiskRecord, type StoredSchedule } from "../main/schedule-rules.js";

const TASK_ID = "task-a";
const TASK_DIR = join(mkdtempSync(join(tmpdir(), "pidock-s153-")), "task-abcdef12");
mkdirSync(TASK_DIR, { recursive: true });
const BASE = { name: "每日巡检", ruleText: "每日 09:15", timezone: "Asia/Shanghai", prompt: "检查风险", providerId: "provider-anthropic", model: "claude-sonnet", permission: "default" as const };

function disk(initial: ScheduleDiskRecord = emptyScheduleRecord()): {
  store: { readSchedules(taskDir: string): ScheduleDiskRecord; writeSchedules(taskDir: string, record: ScheduleDiskRecord): void };
  record(): ScheduleDiskRecord;
  writes(): number;
} {
  let record = initial;
  let writes = 0;
  return {
    store: {
      readSchedules: () => parseScheduleRecord(serializeScheduleRecord(record)),
      writeSchedules: (_taskDir, next) => {
        record = parseScheduleRecord(serializeScheduleRecord(next));
        writes += 1;
      },
    },
    record: () => record,
    writes: () => writes,
  };
}

function ports(overrides: Partial<SchedulePorts> = {}): { ports: SchedulePorts; started: string[]; results: ScheduleStartResult[] } {
  const started: string[] = [];
  const results: ScheduleStartResult[] = [];
  return {
    ports: {
      startRun: (input) => {
        started.push(input.runId);
        return results.shift() ?? { state: "running", sessionId: "scheduled-" + input.runId };
      },
      liveExecution: () => false,
      archived: () => false,
      catalog: () => [{ id: "provider-anthropic", enabled: true, models: [{ id: "claude-sonnet" }] }],
      now: () => "2026-09-24T01:20:00.000Z",
      ...overrides,
    },
    started,
    results,
  };
}

function enabled(schedules: TaskSchedules): StoredSchedule {
  const saved = schedules.save(BASE);
  if (!saved.ok) throw new Error(saved.message);
  const on = schedules.setEnabled(saved.schedule.scheduleId, true);
  if (!on.ok) throw new Error(on.message);
  return on.schedule;
}

describe("[Pencil T18] #153 persisted trigger intent", () => {
  it("writes the trigger record before the execution starts and binds the session it created", () => {
    const store = disk();
    const { ports: p, started } = ports();
    const schedules = new TaskSchedules(TASK_ID, TASK_DIR, store.store, { ...p, now: () => "2026-09-24T01:15:00.000Z" });
    enabled(schedules);
    const run = schedules.runNow("schedule-1");
    expect(started).toEqual(["run-1"]);
    expect(run).toMatchObject({ result: "running", sessionId: "scheduled-run-1" });
    // The intent row was persisted before the start and then completed in place:
    // exactly one row with this occurrence key.
    const rows = store.record().runs.filter((item) => item.occurrenceKey === run.occurrenceKey);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.runId).toBe("run-1");
    expect(schedules.hasRunningRun("schedule-1")).toBe(true);
  });

  it("names a crash mid-trigger uncertain instead of success or a duplicate", () => {
    // A trigger record written before the start, with no session bound, is what a
    // crash between the write and the accepted turn leaves on disk.
    const seed = emptyScheduleRecord();
    const now = "2026-09-24T01:20:00.000Z";
    const store = disk({
      ...seed,
      schedules: [{ scheduleId: "schedule-1", taskId: TASK_ID, name: "每日巡检", ruleText: "每日 09:15", timezone: "Asia/Shanghai", prompt: "检查风险", providerId: "provider-anthropic", model: "claude-sonnet", permission: "default", enabled: true, configVersion: 1, lastEvaluatedAt: "2026-09-23T00:00:00.000Z", createdAt: now, updatedAt: now }],
      runs: [{ runId: "run-1", scheduleId: "schedule-1", taskId: TASK_ID, configVersion: 1, trigger: "due", occurrenceKey: "schedule-1@2026-09-24T01:15:00.000Z", scheduledAt: "2026-09-24T01:15:00.000Z", startedAt: "2026-09-24T01:15:00.000Z", result: "running", providerId: "provider-anthropic", model: "claude-sonnet", permission: "default", ruleText: "每日 09:15" }],
    });
    const { ports: p, started } = ports();
    const restarted = new TaskSchedules(TASK_ID, TASK_DIR, store.store, { ...p, now: () => now });
    expect(restarted.recoveredRuns).toEqual([{ runId: "run-1", result: "uncertain" }]);
    expect(restarted.runs()[0]).toMatchObject({ result: "uncertain", failureCode: "trigger-unconfirmed" });
    expect(restarted.runs()[0]!.reason).toContain("触发状态不确定");
    // The occurrence key was kept: re-evaluating the same window may record a
    // skip, but it can never start a second execution or claim success.
    restarted.evaluateDue(now);
    const sameKey = restarted.runs().filter((item) => item.occurrenceKey === "schedule-1@2026-09-24T01:15:00.000Z");
    expect(sameKey.filter((item) => item.result === "running" || item.result === "completed")).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  it("never re-triggers a reconciled occurrence after restart", () => {
    const store = disk();
    const { ports: p } = ports();
    const first = new TaskSchedules(TASK_ID, TASK_DIR, store.store, { ...p, now: () => "2026-09-24T01:00:00.000Z" });
    const saved = enabled(first);
    // A due run at 09:15 is accepted but never settles before the "restart".
    first.evaluateDue("2026-09-24T01:15:15.000Z");
    expect(store.record().runs.filter((item) => item.result === "running")).toHaveLength(1);
    const key = store.record().runs[0]!.occurrenceKey;
    const restarted = new TaskSchedules(TASK_ID, TASK_DIR, store.store, { ...p, now: () => "2026-09-24T01:16:00.000Z", startRun: () => ({ state: "running", sessionId: "scheduled-again" }) });
    // Restart names the dead run interrupted, then evaluating the same window
    // must not mint a second run for the same occurrence.
    const recovered = restarted.runs().find((item) => item.occurrenceKey === key)!;
    expect(recovered.result).toBe("interrupted");
    const again = restarted.evaluateDue("2026-09-24T01:16:00.000Z");
    expect(again.filter((item) => item.occurrenceKey === key)).toHaveLength(0);
    expect(restarted.runs().filter((item) => item.occurrenceKey === key)).toHaveLength(1);
    expect(saved.enabled).toBe(true);
  });

  it("skips a due trigger while a run is running or awaiting approval, recording the reason", () => {
    const store = disk();
    let live = false;
    const { ports: p, started, results } = ports({ liveExecution: () => live });
    results.push({ state: "approval", approvalId: "approval-1" });
    const schedules = new TaskSchedules(TASK_ID, TASK_DIR, store.store, { ...p, now: () => "2026-09-24T01:00:00.000Z" });
    enabled(schedules);
    const firstRuns = schedules.evaluateDue("2026-09-24T01:15:15.000Z");
    expect(firstRuns[0]).toMatchObject({ result: "awaiting-approval", trigger: "due" });
    // The approval wait is a live execution too: the next due trigger is skipped.
    live = true;
    const second = schedules.evaluateDue("2026-09-25T01:15:15.000Z");
    expect(second[0]).toMatchObject({ result: "skipped", trigger: "due" });
    expect(second[0]!.reason).toContain("跳过");
    expect(started).toHaveLength(1);
    live = false;
    // A manual continuation is represented by the same live execution check.
    expect(schedules.runNow("schedule-1").result).not.toBe("skipped");
  });

  it("moves the plan forward on wake without minting a run for the sleep window", () => {
    const store = disk();
    const { ports: p } = ports();
    const schedules = new TaskSchedules(TASK_ID, TASK_DIR, store.store, { ...p, now: () => "2026-09-24T01:15:15.000Z" });
    enabled(schedules);
    const before = store.record().runs.length;
    const moved = schedules.resumeForward("2026-09-27T03:00:00.000Z");
    expect(moved.moved).toEqual(["schedule-1"]);
    const after = schedules.list()[0]!;
    expect(after.lastEvaluatedAt).toBe("2026-09-27T03:00:00.000Z");
    expect(store.record().runs).toHaveLength(before);
    // Nothing due immediately after wake.
    expect(schedules.evaluateDue("2026-09-27T03:00:05.000Z")).toEqual([]);
  });
});
