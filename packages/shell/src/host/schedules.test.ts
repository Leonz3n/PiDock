import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskSchedules, type SchedulePorts, type ScheduleStartResult } from "./schedules.js";
import { TaskWorkspaceHost } from "./task-host.js";
import { parseScheduleRecord, serializeScheduleRecord } from "./task-store.js";
import { emptyScheduleRecord, type ScheduleDiskRecord, type StoredSchedule } from "../main/schedule-rules.js";
import { resetPiSequencesForTests } from "../main/pi-session.js";
import { TaskLifecycleHost } from "./task-lifecycle.js";
import { createLifecycleResources } from "./lifecycle-resources.js";
import { memoryTaskStore as memoryStore } from "./task-host.js";

const TASK_ID = "task-a";
const TASK_DIR = join(mkdtempSync(join(tmpdir(), "pidock-s18-")), "task-abcdef12");
const BASE = { name: "每日巡检", ruleText: "每日 09:15", timezone: "Asia/Shanghai", prompt: "检查风险", providerId: "provider-anthropic", model: "claude-sonnet", permission: "default" as const };

function memorySchedules(): { store: { readSchedules(taskDir: string): ScheduleDiskRecord; writeSchedules(taskDir: string, record: ScheduleDiskRecord): void }; record(): ScheduleDiskRecord } {
  let record: ScheduleDiskRecord = emptyScheduleRecord();
  return {
    store: {
      readSchedules: () => parseScheduleRecord(serializeScheduleRecord(record)),
      writeSchedules: (_taskDir, next) => {
        record = parseScheduleRecord(serializeScheduleRecord(next));
      },
    },
    record: () => record,
  };
}

function fakePorts(overrides: Partial<SchedulePorts> = {}) {
  const started: { runId: string; sessionId: string; schedule: StoredSchedule; approvalExpiresAt: string }[] = [];
  const results: ScheduleStartResult[] = [];
  const ports: SchedulePorts = {
    startRun: (input) => {
      started.push(input);
      return results.shift() ?? { state: "done" };
    },
    liveExecution: () => false,
    archived: () => false,
    catalog: () => [{ id: "provider-anthropic", enabled: true, models: [{ id: "claude-sonnet" }] }],
    now: () => "2026-09-23T01:20:00.000Z",
    ...overrides,
  };
  return { ports, started, results };
}

beforeEach(() => {
  resetPiSequencesForTests();
});

describe("[PiDock 18] schedule manager", () => {
  it("saves a validated config with its own version and previews the next trigger", () => {
    const { store } = memorySchedules();
    const { ports } = fakePorts();
    const schedules = new TaskSchedules(TASK_ID, TASK_DIR, store, ports);
    const saved = schedules.save(BASE);
    expect(saved.ok && saved.schedule).toMatchObject({ scheduleId: "schedule-1", configVersion: 1, enabled: false, taskId: TASK_ID });
    const again = schedules.save({ ...BASE, scheduleId: "schedule-1", ruleText: "每周五 15:00" });
    expect(again.ok && again.schedule).toMatchObject({ configVersion: 2, createdAt: saved.ok ? saved.schedule.createdAt : "" });
    expect(schedules.preview({ ruleText: "每周五 15:00", timezone: "Asia/Shanghai" })).toMatchObject({
      ok: true,
      nextTriggerAt: "2026-09-25T07:00:00.000Z",
    });
    expect(schedules.preview({ ruleText: "每天跑一下", timezone: "Asia/Shanghai" })).toMatchObject({ ok: false, code: "rule-unrecognized" });
    expect(schedules.save({ ...BASE, model: "claude-opus" })).toMatchObject({ ok: false, code: "model-missing" });
    expect(schedules.save({ ...BASE, extraKeys: ["webhook"] })).toMatchObject({ ok: false, code: "delivery-field" });
    expect(schedules.save({ ...BASE, scheduleId: "schedule-404" })).toMatchObject({ ok: false, code: "unknown-schedule" });
  });

  it("applies a template without touching project/provider/model/permission/timezone or enabling it", () => {
    const { store } = memorySchedules();
    const { ports } = fakePorts();
    const schedules = new TaskSchedules(TASK_ID, TASK_DIR, store, ports);
    const saved = schedules.save(BASE);
    const scheduleId = saved.ok ? saved.schedule.scheduleId : "";
    const applied = schedules.applyTemplate(scheduleId, "tl-standup");
    expect(applied.ok && applied.schedule).toMatchObject({
      name: "站会主题准备",
      ruleText: "周一至周五 09:15",
      providerId: "provider-anthropic",
      model: "claude-sonnet",
      permission: "default",
      timezone: "Asia/Shanghai",
      enabled: false,
    });
    expect(schedules.templates().map((template) => template.id)).toHaveLength(5);
  });

  it("refuses to enable a schedule on an archived task and re-seeds the watermark on resume", () => {
    const { store } = memorySchedules();
    let archived = false;
    const { ports } = fakePorts({ archived: () => archived });
    const schedules = new TaskSchedules(TASK_ID, TASK_DIR, store, ports);
    const saved = schedules.save(BASE);
    const scheduleId = saved.ok ? saved.schedule.scheduleId : "";
    expect(schedules.setEnabled(scheduleId, true)).toMatchObject({ ok: true, schedule: { enabled: true } });
    archived = true;
    expect(schedules.setEnabled(scheduleId, false)).toMatchObject({ ok: true });
    expect(schedules.setEnabled(scheduleId, true)).toMatchObject({ ok: false, code: "archived" });
    expect(schedules.evaluateDue()).toEqual([]);
  });

  it("runs one independent session per due trigger, records the config version, and never replays the occurrence", () => {
    let now = "2026-09-23T02:00:00.000Z";
    const { store } = memorySchedules();
    const { ports, started } = fakePorts({ now: () => now });
    const schedules = new TaskSchedules(TASK_ID, TASK_DIR, store, ports);
    const saved = schedules.save({ ...BASE, enabled: true });
    const scheduleId = saved.ok ? saved.schedule.scheduleId : "";

    now = "2026-09-24T01:20:00.000Z";
    const runs = schedules.evaluateDue();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      trigger: "due",
      result: "completed",
      scheduledAt: "2026-09-24T01:15:00.000Z",
      occurrenceKey: `${scheduleId}@2026-09-24T01:15:00.000Z`,
      configVersion: 1,
      sessionId: "scheduled-run-1",
    });
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ sessionId: "scheduled-run-1", schedule: { scheduleId } });
    // The confirmation a scheduled run waits on lives until min(24h, next plan).
    expect(started[0]?.approvalExpiresAt).toBe("2026-09-25T01:15:00.000Z");

    // Re-evaluating the same window never triggers the same occurrence twice.
    expect(schedules.evaluateDue()).toEqual([]);
    expect(schedules.runs(scheduleId)).toHaveLength(1);
  });

  it("records the earlier occurrences of a missed window as offline misses instead of catching up", () => {
    let now = "2026-09-22T01:00:00.000Z";
    const { store } = memorySchedules();
    const { ports, started } = fakePorts({ now: () => now });
    const schedules = new TaskSchedules(TASK_ID, TASK_DIR, store, ports);
    const saved = schedules.save({ ...BASE, enabled: true });
    const scheduleId = saved.ok ? saved.schedule.scheduleId : "";
    now = "2026-09-24T01:20:00.000Z";
    const runs = schedules.evaluateDue();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ result: "skipped" });
    expect(runs[0]?.sessionId).toBeUndefined();
    expect(runs[0]?.reason).toContain("离线期间不补跑");
    expect(started).toHaveLength(0);
    expect(schedules.runs(scheduleId)[0]?.result).toBe("skipped");
  });

  it("skips a due trigger while the previous run is still executing and records why", () => {
    let now = "2026-09-24T01:00:00.000Z";
    const { store } = memorySchedules();
    let live = false;
    const { ports, started } = fakePorts({ now: () => now, liveExecution: () => live });
    const schedules = new TaskSchedules(TASK_ID, TASK_DIR, store, ports);
    const saved = schedules.save({ ...BASE, enabled: true });
    const scheduleId = saved.ok ? saved.schedule.scheduleId : "";
    now = "2026-09-24T01:20:00.000Z";
    live = true;
    const runs = schedules.evaluateDue();
    expect(runs[0]).toMatchObject({ result: "skipped" });
    expect(runs[0]?.reason).toContain("上一次执行仍未结束");
    expect(started).toHaveLength(0);
    expect(schedules.find(scheduleId)?.lastEvaluatedAt).toBe(now);
  });

  it("fails the run and flags 需要修复 when the saved config no longer resolves", () => {
    let catalog = [{ id: "provider-anthropic", enabled: true, models: [{ id: "claude-sonnet" }] }];
    const { store } = memorySchedules();
    let now = "2026-09-23T02:00:00.000Z";
    const { ports, started } = fakePorts({ now: () => now, catalog: () => catalog });
    const schedules = new TaskSchedules(TASK_ID, TASK_DIR, store, ports);
    const saved = schedules.save({ ...BASE, enabled: true });
    const scheduleId = saved.ok ? saved.schedule.scheduleId : "";
    catalog = [{ id: "provider-anthropic", enabled: true, models: [{ id: "claude-haiku" }] }];
    now = "2026-09-24T01:20:00.000Z";
    const runs = schedules.evaluateDue();
    expect(runs[0]).toMatchObject({ result: "failed" });
    expect(runs[0]?.reason).toContain("配置需要修复");
    expect(runs[0]?.sessionId).toBeUndefined();
    expect(started).toHaveLength(0);
    expect(schedules.find(scheduleId)?.repairIssue).toContain("模型 claude-sonnet");
  });

  it("立即运行 creates its own run without moving the plan and refuses an archived task", () => {
    let archived = false;
    const { store } = memorySchedules();
    const { ports, started } = fakePorts({ archived: () => archived });
    const schedules = new TaskSchedules(TASK_ID, TASK_DIR, store, ports);
    const saved = schedules.save(BASE);
    const scheduleId = saved.ok ? saved.schedule.scheduleId : "";
    const watermark = schedules.find(scheduleId)?.lastEvaluatedAt;
    const run = schedules.runNow(scheduleId);
    expect(run).toMatchObject({ trigger: "manual", result: "completed", sessionId: "scheduled-run-1" });
    expect(run.occurrenceKey).toContain("#manual@");
    expect(schedules.find(scheduleId)?.lastEvaluatedAt).toBe(watermark);
    expect(started).toHaveLength(1);
    archived = true;
    expect(() => schedules.runNow(scheduleId)).toThrow("archived");
    expect(() => schedules.runNow("schedule-404")).toThrow("unknown-schedule");
  });

  it("never re-triggers an occurrence after a clock rollback and re-advance", () => {
    let now = "2026-09-23T02:00:00.000Z";
    const { store } = memorySchedules();
    const { ports, started } = fakePorts({ now: () => now });
    const schedules = new TaskSchedules(TASK_ID, TASK_DIR, store, ports);
    const saved = schedules.save({ ...BASE, enabled: true });
    const scheduleId = saved.ok ? saved.schedule.scheduleId : "";
    now = "2026-09-24T01:20:00.000Z";
    expect(schedules.evaluateDue()).toHaveLength(1);
    // The clock jumps backwards: nothing is due, and nothing is replayed.
    now = "2026-09-23T12:00:00.000Z";
    expect(schedules.evaluateDue()).toEqual([]);
    // Forward again to the same instant: the occurrence key is already recorded.
    now = "2026-09-24T01:20:00.000Z";
    expect(schedules.evaluateDue()).toEqual([]);
    now = "2026-09-24T23:00:00.000Z";
    expect(schedules.evaluateDue()).toEqual([]);
    expect(schedules.runs(scheduleId)).toHaveLength(1);
    expect(started).toHaveLength(1);
  });

  it("records a failed run when starting the session throws, and keeps the history", () => {
    const { store } = memorySchedules();
    const { ports } = fakePorts({
      startRun: () => {
        throw new Error("只读会话仅允许阅读分析，请先调整会话权限");
      },
    });
    const schedules = new TaskSchedules(TASK_ID, TASK_DIR, store, ports);
    const saved = schedules.save(BASE);
    const scheduleId = saved.ok ? saved.schedule.scheduleId : "";
    const run = schedules.runNow(scheduleId);
    expect(run).toMatchObject({ result: "failed", reason: "只读会话仅允许阅读分析，请先调整会话权限" });
    expect(run.sessionId).toBeUndefined();
    // Deleting the schedule keeps the history (删除定时任务不删除已有历史会话和用量记录).
    expect(schedules.remove(scheduleId)).toEqual({ removed: true });
    expect(schedules.list()).toEqual([]);
    expect(schedules.runs(scheduleId)).toHaveLength(1);
  });

  it("records a run parked on a confirmation as awaiting-approval, not completed", () => {
    const { store } = memorySchedules();
    const { ports, results } = fakePorts();
    const schedules = new TaskSchedules(TASK_ID, TASK_DIR, store, ports);
    const saved = schedules.save(BASE);
    const scheduleId = saved.ok ? saved.schedule.scheduleId : "";
    results.push({ state: "approval", approvalId: "approval-1" });
    const run = schedules.runNow(scheduleId);
    expect(run).toMatchObject({ result: "awaiting-approval", sessionId: "scheduled-run-1" });
    // The history never claims 完成 for a run the ledger still tracks as waiting.
    expect(schedules.runs(scheduleId)[0]?.result).toBe("awaiting-approval");
    results.push({ state: "done" });
    expect(schedules.runNow(scheduleId).result).toBe("completed");
  });

  it("orders tied run history by the minted sequence, not the id string", () => {
    const { store } = memorySchedules();
    const { ports } = fakePorts();
    const schedules = new TaskSchedules(TASK_ID, TASK_DIR, store, ports);
    const saved = schedules.save(BASE);
    const scheduleId = saved.ok ? saved.schedule.scheduleId : "";
    // The fixed clock gives every run the same `startedAt`, so only the sequence
    // decides the order (`run-10` is newer than `run-9`).
    for (let index = 0; index < 10; index += 1) schedules.runNow(scheduleId);
    expect(schedules.runs().map((run) => run.runId)).toEqual([
      "run-10",
      "run-9",
      "run-8",
      "run-7",
      "run-6",
      "run-5",
      "run-4",
      "run-3",
      "run-2",
      "run-1",
    ]);
  });

  it("re-seeds schedule and run id sequences from the restored record", () => {
    const { store } = memorySchedules();
    const { ports } = fakePorts();
    const first = new TaskSchedules(TASK_ID, TASK_DIR, store, ports);
    const a = first.save(BASE);
    const b = first.save({ ...BASE, name: "第二个" });
    first.runNow(a.ok ? a.schedule.scheduleId : "");
    const second = new TaskSchedules(TASK_ID, TASK_DIR, store, ports);
    const c = second.save({ ...BASE, name: "第三个" });
    expect(a.ok && b.ok && c.ok && [a.schedule.scheduleId, b.schedule.scheduleId, c.schedule.scheduleId]).toEqual([
      "schedule-1",
      "schedule-2",
      "schedule-3",
    ]);
    expect(second.runNow(b.ok ? b.schedule.scheduleId : "").runId).toBe("run-2");
  });

  it("never re-mints the id of a removed schedule whose run history was kept", () => {
    const { store } = memorySchedules();
    const { ports } = fakePorts();
    const first = new TaskSchedules(TASK_ID, TASK_DIR, store, ports);
    const a = first.save(BASE);
    const b = first.save({ ...BASE, name: "第二个" });
    const c = first.save({ ...BASE, name: "第三个" });
    expect(a.ok && a.schedule.scheduleId).toBe("schedule-1");
    expect(b.ok && b.schedule.scheduleId).toBe("schedule-2");
    const third = c.ok ? c.schedule.scheduleId : "";
    expect(third).toBe("schedule-3");
    first.runNow(third);
    expect(first.remove(third)).toEqual({ removed: true });
    // The removed schedule's run history is kept, so its id must stay reserved:
    // re-minting it would merge two schedules' histories under one id.
    const second = new TaskSchedules(TASK_ID, TASK_DIR, store, ports);
    const d = second.save({ ...BASE, name: "第四个" });
    expect(d.ok && d.schedule.scheduleId).toBe("schedule-4");
    expect(second.runs(third)).toHaveLength(1);
    expect(second.runs("schedule-4")).toEqual([]);
  });
});

describe("[PiDock 18] Host wiring", () => {
  function host(now: () => string) {
    return new TaskWorkspaceHost(TASK_ID, TASK_DIR, memoryStore(), now);
  }

  /** Archive through the real lifecycle host, sharing the task's store. */
  function archive(taskHost: TaskWorkspaceHost) {
    const store = taskHost.store;
    const lifecycle = new TaskLifecycleHost(
      TASK_ID,
      TASK_DIR,
      store,
      createLifecycleResources({ host: taskHost, services: () => null, terminals: () => null, sessionIds: () => taskHost.sessionIds() }),
      () => "2026-09-24T01:00:00.000Z",
    );
    const archived = lifecycle.archive();
    const paused = taskHost.pauseSchedulesForArchive();
    return { archived, paused };
  }

  it("creates one independent session per trigger in the same task workspace and records a scheduled execution", () => {
    let now = "2026-09-23T02:00:00.000Z";
    const taskHost = host(() => now);
    taskHost.provision({ name: "定时巡检", dirId: "task-abcdef12", remoteBranch: "main", fetchedCommit: "a5a4a0d1234", repos: ["front-monorepo"] });
    taskHost.setProviderCatalog([
      { id: "provider-anthropic", name: "Anthropic 官方", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", enabled: true, models: [{ id: "claude-sonnet-4-5", name: "Claude Sonnet", contextWindow: 200_000 }] },
    ]);
    const saved = taskHost.saveSchedule({ name: "每日巡检", ruleText: "每日 09:15", timezone: "Asia/Shanghai", prompt: "检查风险", providerId: "provider-anthropic", model: "claude-sonnet-4-5", permission: "default", enabled: true });
    expect(saved.ok).toBe(true);
    const scheduleId = saved.ok ? saved.schedule.scheduleId : "";

    now = "2026-09-24T01:20:00.000Z";
    const runs = taskHost.evaluateSchedules();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ result: "completed", sessionId: "scheduled-run-1" });
    // The run's session is a real, persisted session of this task.
    expect(taskHost.sessionIds()).toContain("scheduled-run-1");
    const [execution] = taskHost.executionState("scheduled-run-1").executions;
    expect(execution).toMatchObject({
      kind: "scheduled",
      scheduleId,
      scheduleConfigVersion: 1,
      label: `定时执行 ${scheduleId}（配置 v1）`,
    });
    // A second trigger while the first session still exists is not an overlap (the
    // first run settled), but the same occurrence never runs twice.
    expect(taskHost.evaluateSchedules()).toEqual([]);
    expect(taskHost.scheduleRuns(scheduleId)).toHaveLength(1);
  });

  it("a scheduled confirmation expires at min(24h, next plan) and stays a scheduled execution", () => {
    const now = "2026-09-23T02:00:00.000Z";
    const taskHost = host(() => now);
    taskHost.provision({ name: "定时巡检", dirId: "task-abcdef12", remoteBranch: "main", fetchedCommit: "a5a4a0d1234", repos: ["front-monorepo"] });
    // The scheduled origin is what a scheduled turn would carry; a gated tool
    // parks the execution on a confirmation so the deadline is observable.
    const turn = taskHost.sendMessage(
      "scheduled-run-9",
      "运行命令",
      {
        tool: "exec.run",
        target: `${TASK_DIR}/run.sh`,
        execute: (call) => ({ tool: call.tool, kind: call.kind, target: call.target, contentVersion: call.contentVersion, output: "pending" }),
      },
      { scheduleId: "schedule-1", scheduleConfigVersion: 3, approvalExpiresAt: "2026-09-23T12:00:00.000Z" },
    );
    expect(turn.state).toBe("approval");
    const [execution] = taskHost.executionState("scheduled-run-9").executions;
    expect(execution).toMatchObject({
      kind: "scheduled",
      scheduleId: "schedule-1",
      scheduleConfigVersion: 3,
      state: "pending-approval",
      approval: { approvalId: turn.approvalId, expiresAt: "2026-09-23T12:00:00.000Z" },
    });
    // The deadline the Host re-checks is the one it was handed, and a settled
    // confirmation never authorizes: this is the same one-shot rule as #19.
    expect(taskHost.approve("scheduled-run-9", turn.approvalId ?? "")).toBeTruthy();
    const [after] = taskHost.executionState("scheduled-run-9").executions;
    expect(after).toMatchObject({ state: "done", approval: { status: "approved" } });
  });

  it("records a failed run when the session permission refuses the scheduled turn", () => {
    let now = "2026-09-23T02:00:00.000Z";
    const taskHost = host(() => now);
    taskHost.provision({ name: "定时巡检", dirId: "task-abcdef12", remoteBranch: "main", fetchedCommit: "a5a4a0d1234", repos: ["front-monorepo"] });
    const saved = taskHost.saveSchedule({ name: "只读巡检", ruleText: "每日 09:15", timezone: "Asia/Shanghai", prompt: "检查风险", providerId: "provider-local", model: "pidock-default", permission: "read", enabled: true });
    const scheduleId = saved.ok ? saved.schedule.scheduleId : "";
    now = "2026-09-24T01:20:00.000Z";
    const runs = taskHost.evaluateSchedules();
    expect(runs[0]).toMatchObject({ result: "failed" });
    expect(runs[0]?.reason).toContain("只读会话");
    expect(runs[0]?.sessionId).toBeUndefined();
    expect(taskHost.scheduleRuns(scheduleId)[0]?.result).toBe("failed");
  });

  it("settles an expired scheduled confirmation before judging the next cycle, and an edit never extends it", () => {
    let now = "2026-09-23T02:00:00.000Z";
    const taskHost = host(() => now);
    taskHost.provision({ name: "定时巡检", dirId: "task-abcdef12", remoteBranch: "main", fetchedCommit: "a5a4a0d1234", repos: ["front-monorepo"] });
    const saved = taskHost.saveSchedule({ name: "每日巡检", ruleText: "每日 09:15", timezone: "Asia/Shanghai", prompt: "检查风险", providerId: "provider-local", model: "pidock-default", permission: "default", enabled: true });
    const scheduleId = saved.ok ? saved.schedule.scheduleId : "";
    // A scheduled turn parked on a confirmation whose deadline is min(24h, next plan).
    const waiting = taskHost.sendMessage(
      "scheduled-parked-1",
      "运行命令",
      {
        tool: "exec.run",
        target: `${TASK_DIR}/run.sh`,
        execute: (call) => ({ tool: call.tool, kind: call.kind, target: call.target, contentVersion: call.contentVersion, output: "pending" }),
      },
      { scheduleId, scheduleConfigVersion: 1, approvalExpiresAt: "2026-09-23T12:00:00.000Z" },
    );
    expect(waiting.state).toBe("approval");
    // Editing the rule (a later plan) must not move the already-minted deadline.
    now = "2026-09-23T06:00:00.000Z";
    expect(taskHost.saveSchedule({ name: "每日巡检", ruleText: "每周五 15:00", timezone: "Asia/Shanghai", prompt: "检查风险", providerId: "provider-local", model: "pidock-default", permission: "default", scheduleId }).ok).toBe(true);
    const [still] = taskHost.executionState("scheduled-parked-1").executions;
    expect(still?.approval?.expiresAt).toBe("2026-09-23T12:00:00.000Z");
    // Past the deadline the evaluation ends the old confirmation first, then the
    // new cycle runs (先结束旧确认再判断新周期).
    now = "2026-09-25T08:00:00.000Z";
    const runs = taskHost.evaluateSchedules();
    const [settled] = taskHost.executionState("scheduled-parked-1").executions;
    expect(settled).toMatchObject({ state: "expired", approval: { status: "expired" } });
    // The expired confirmation can never authorize the old run afterwards.
    expect(() => taskHost.approve("scheduled-parked-1", waiting.approvalId ?? "")).toThrow("invalid-execution-transition");
    expect(runs[0]).toMatchObject({ result: "completed", sessionId: "scheduled-run-1" });
    expect(taskHost.scheduleRuns(scheduleId).filter((run) => run.result === "completed")).toHaveLength(1);
  });

  it("settles an expired confirmation before 立即运行, so a dead wait never blocks it", () => {
    let now = "2026-09-23T02:00:00.000Z";
    const taskHost = host(() => now);
    taskHost.provision({ name: "定时巡检", dirId: "task-abcdef12", remoteBranch: "main", fetchedCommit: "a5a4a0d1234", repos: ["front-monorepo"] });
    const saved = taskHost.saveSchedule({ name: "每日巡检", ruleText: "每日 09:15", timezone: "Asia/Shanghai", prompt: "检查风险", providerId: "provider-local", model: "pidock-default", permission: "default", enabled: true });
    const scheduleId = saved.ok ? saved.schedule.scheduleId : "";
    const waiting = taskHost.sendMessage(
      "scheduled-parked-1",
      "运行命令",
      {
        tool: "exec.run",
        target: `${TASK_DIR}/run.sh`,
        execute: (call) => ({ tool: call.tool, kind: call.kind, target: call.target, contentVersion: call.contentVersion, output: "pending" }),
      },
      { scheduleId, scheduleConfigVersion: 1, approvalExpiresAt: "2026-09-23T12:00:00.000Z" },
    );
    expect(waiting.state).toBe("approval");
    // Before the deadline the wait really is in flight and blocks the manual run.
    expect(taskHost.runScheduleNow(scheduleId)).toMatchObject({ result: "skipped" });
    // Past it, 立即运行 ends the dead wait first instead of reporting 「上一次执行仍在执行」.
    now = "2026-09-23T13:00:00.000Z";
    expect(taskHost.runScheduleNow(scheduleId)).toMatchObject({ result: "completed", sessionId: "scheduled-run-2" });
    const [settled] = taskHost.executionState("scheduled-parked-1").executions;
    expect(settled).toMatchObject({ state: "expired", approval: { status: "expired" } });
  });

  it("does not run a schedule of an archived task and refuses 立即运行 until restored", () => {
    let now = "2026-09-24T01:00:00.000Z";
    const taskHost = host(() => now);
    taskHost.provision({ name: "定时巡检", dirId: "task-abcdef12", remoteBranch: "main", fetchedCommit: "a5a4a0d1234", repos: ["front-monorepo"] });
    const saved = taskHost.saveSchedule({ name: "每日巡检", ruleText: "每日 09:15", timezone: "Asia/Shanghai", prompt: "检查风险", providerId: "provider-local", model: "pidock-default", permission: "default", enabled: true });
    const scheduleId = saved.ok ? saved.schedule.scheduleId : "";
    expect(archive(taskHost).paused.map((schedule) => schedule.scheduleId)).toEqual([scheduleId]);
    now = "2026-09-25T01:20:00.000Z";
    expect(taskHost.evaluateSchedules()).toEqual([]);
    expect(() => taskHost.runScheduleNow(scheduleId)).toThrow("archived");
    expect(taskHost.setScheduleEnabled(scheduleId, true)).toMatchObject({ ok: false, code: "archived" });
  });
});
