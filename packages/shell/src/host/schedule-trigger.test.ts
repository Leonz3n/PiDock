/**
 * [Pencil T17] #152 production trigger: one REAL SDK turn per scheduled run.
 *
 * The Provider context is a loopback client (the same seam `sdk-execution-ledger`
 * uses), everything else is real: the task folder, `task.json`, the #139 session
 * index, `SdkTurnTransport`, the execution ledger and `schedules.json`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskWorkspaceHost, diskTaskStore } from "./task-host.js";
import { buildTaskDiskRecord, serializeTaskRecord } from "./task-store.js";
import { sessionOf } from "./session-index.js";
import type { SdkContextClient } from "./sdk-context-client.js";
import type { SdkTextResult } from "./sdk-text-kernel.js";
import type { PiSdkTextKernel } from "./sdk-text-kernel.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const at = "2026-09-23T02:00:00.000Z";
const PROFILE = "p-11111111-2222-3333-4444-555555555555";
const config = {
  profileId: PROFILE, baseUrl: "http://127.0.0.1:9/v1", modelId: "loopback-model", contextWindow: 128000, maxTokens: 8192,
  authRef: "PIDOCK_PROVIDER_LOOPBACK", generation: 1, protocol: "openai-completions" as const, credentialSource: "env" as const,
  models: [
    { id: "loopback-model", name: "Loopback", contextWindow: 128000, maxTokens: 8192, reasoning: false },
    { id: "loopback-other", name: "Loopback other", contextWindow: 128000, maxTokens: 8192, reasoning: false },
  ],
};
const BASE = { name: "每日巡检", ruleText: "每日 09:15", timezone: "Asia/Shanghai", prompt: "检查风险", providerId: PROFILE, model: "loopback-model", permission: "default" as const };

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

function fixture(options: { kind?: "normal" | "scheduled"; withProvider?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "pidock-152-trigger-")); homes.push(home);
  const taskDir = join(home, "task-abcdef12"); mkdirSync(taskDir);
  const task = buildTaskDiskRecord({
    taskId: "task-a", name: "定时巡检", dirId: "task-abcdef12", branch: "main", root: home, taskDir,
    remoteBranch: "main", baseCommit: "fixture", repos: [], now: at,
    ...(options.kind === undefined || options.kind === "scheduled" ? { kind: "scheduled" as const } : {}),
  });
  const record = options.kind === "normal" ? { ...task, kind: "normal" as const } : task;
  const store = diskTaskStore;
  // `buildTaskDiskRecord` has no `kind` for normal; write the exact record.
  writeFileSync(join(taskDir, "task.json"), serializeTaskRecord(record));
  const opened: string[] = [];
  const prompts: { sessionId: string; text: string }[] = [];
  const pending: { resolve: (value: SdkTextResult) => void }[] = [];
  let servedModel: string | null = null;
  const client = {
    open: async (sessionId: string) => { opened.push(sessionId); return { sdkId: sessionId, file: `${sessionId}.jsonl`, tools: [] }; },
    prompt: (sessionId: string, text: string) => { prompts.push({ sessionId, text }); const result = deferred<SdkTextResult>(); pending.push({ resolve: result.resolve }); return result.promise; },
    cancel: async () => {}, seal: () => {}, dispose: async () => {},
  };
  const reader = {
    projection: (sessionId: string) => ({ source: "sdk-jsonl" as const, sessionId, messages: [], interrupted: false }),
    digest: (sessionId: string) => ({ sessionId, turns: prompts.filter((row) => row.sessionId === sessionId).length,
      contextUsed: null, usage: null, model: servedModel === null ? null : { provider: "loopback", modelId: servedModel }, interrupted: false }),
    dispose: async () => {},
  };
  const hosts: TaskWorkspaceHost[] = [];
  const createHost = () => {
    const host = new TaskWorkspaceHost("task-a", taskDir, store, () => at, () => [], undefined, (path) => path, undefined,
      () => reader as unknown as PiSdkTextKernel,
      () => client as unknown as SdkContextClient);
    hosts.push(host);
    return host;
  };
  return { home, taskDir, store, createHost, hosts, opened, prompts, pending,
    settle: (index: number, result: SdkTextResult) => pending[index]!.resolve(result),
    setServedModel: (model: string) => { servedModel = model; },
    taskDirExists: () => readFileSync(join(taskDir, "task.json"), "utf8").length > 0 };
}

function writeFileSync(path: string, value: string): void { (process.getBuiltinModule("node:fs") as typeof import("node:fs")).writeFileSync(path, value); }

describe("[Pencil T17] #152 real scheduled trigger", () => {
  it("creates a NEW indexed session per run, runs the prompt through SdkTurnTransport and settles the record with the real model", async () => {
    const f = fixture();
    const host = f.createHost();
    await host.configureSdkProvider({ config, credential: "synthetic" });
    // The saved model differs from the task-wide default on purpose: the run
    // must use the definition's model, not fall back to the installed default.
    const saved = host.saveSchedule({ ...BASE, model: "loopback-other", enabled: true });
    expect(saved.ok).toBe(true);
    const scheduleId = saved.ok ? saved.schedule.scheduleId : "";

    const first = host.runScheduleNow(scheduleId);
    expect(first).toMatchObject({ result: "running", trigger: "manual" });
    expect(first.sessionId).toMatch(/^s-[0-9a-f]{8}$/);
    const firstSession = first.sessionId as string;
    // The session exists in the #139 index with the saved binding and permission.
    expect(sessionOf(host.sessionIndex(), firstSession)).toMatchObject({ permission: "default", binding: { profileId: PROFILE, modelId: "loopback-other" } });
    await vi.waitFor(() => expect(f.prompts).toEqual([{ sessionId: firstSession, text: BASE.prompt }]));
    expect(f.opened).toContain(firstSession);

    f.setServedModel("loopback-other");
    f.settle(0, { state: "done", text: "done", events: [] });
    await host.currentSdkTurnTransport()?.waitForTerminal();
    const [settled] = host.scheduleRuns(scheduleId);
    expect(settled).toMatchObject({ runId: first.runId, result: "completed", sessionId: firstSession, actualModel: "loopback-other" });
    expect(settled?.endedAt).toBe(at);

    const second = host.runScheduleNow(scheduleId);
    expect(second).toMatchObject({ result: "running" });
    expect(second.sessionId).not.toBe(firstSession);
    await vi.waitFor(() => expect(f.prompts).toHaveLength(2));
    expect(sessionOf(host.sessionIndex(), second.sessionId as string)).toMatchObject({ binding: { modelId: "loopback-other" } });
    f.settle(1, { state: "done", text: "done", events: [] });
    await host.currentSdkTurnTransport()?.waitForTerminal();
    expect(host.scheduleRuns(scheduleId).filter((run) => run.result === "completed")).toHaveLength(2);
    // Same fixed workspace, two independent sessions: nothing inherits the first
    // run's conversation.
    expect(f.prompts.map((row) => row.sessionId)).toEqual([firstSession, second.sessionId]);
    expect(host.sessionIndex().sessions).toHaveLength(3);

    // A terminal record is never rewritten.
    const again = host.settleScheduleRun(first.runId, { result: "failed", reason: "should not win" });
    expect(again).toMatchObject({ result: "completed", actualModel: "loopback-other" });

    // Restart keeps the definition and every run record.
    const restarted = f.createHost();
    expect(restarted.listSchedules()).toMatchObject([{ scheduleId, providerId: PROFILE, model: "loopback-other", permission: "default", timezone: "Asia/Shanghai", ruleText: BASE.ruleText }]);
    expect(restarted.scheduleRuns(scheduleId)).toHaveLength(2);
    expect(restarted.taskKind()).toBe("scheduled");
  });

  it("refuses an overlapping run while an accepted turn is still in flight", async () => {
    const f = fixture();
    const host = f.createHost();
    await host.configureSdkProvider({ config, credential: "synthetic" });
    const saved = host.saveSchedule({ ...BASE, enabled: true });
    const scheduleId = saved.ok ? saved.schedule.scheduleId : "";
    expect(host.runScheduleNow(scheduleId)).toMatchObject({ result: "running" });
    const overlapping = host.runScheduleNow(scheduleId);
    expect(overlapping).toMatchObject({ result: "skipped" });
    expect(overlapping.reason).toContain("上一次执行仍未结束");
    // Only one turn was ever started.
    await vi.waitFor(() => expect(f.prompts).toHaveLength(1));
    f.settle(0, { state: "done", text: "done", events: [] });
    await host.currentSdkTurnTransport()?.waitForTerminal();
  });

  it("fails by name for a missing credential, an undeclared model, a foreign Provider and a missing task folder", async () => {
    const nameless = fixture();
    const host = nameless.createHost();
    const saved = host.saveSchedule({ ...BASE, enabled: true });
    const scheduleId = saved.ok ? saved.schedule.scheduleId : "";
    const noCredential = host.runScheduleNow(scheduleId);
    expect(noCredential).toMatchObject({ result: "failed", failureCode: "credential-missing" });
    expect(noCredential.sessionId).toBeUndefined();
    expect(nameless.prompts).toHaveLength(0);

    const foreign = fixture();
    const foreignHost = foreign.createHost();
    // Saved before any Provider is installed (nothing to check against); the
    // installed Provider then does not match, so the trigger refuses by name.
    const foreignSaved = foreignHost.saveSchedule({ ...BASE, providerId: "p-99999999-2222-3333-4444-555555555555", model: "loopback-model", enabled: true });
    expect(foreignSaved.ok).toBe(true);
    await foreignHost.configureSdkProvider({ config, credential: "synthetic" });
    expect(foreignHost.runScheduleNow(foreignSaved.ok ? foreignSaved.schedule.scheduleId : "")).toMatchObject({ result: "failed", failureCode: "provider-missing" });

    const undeclared = fixture();
    const undeclaredHost = undeclared.createHost();
    const undeclaredSaved = undeclaredHost.saveSchedule({ ...BASE, model: "not-declared", enabled: true });
    expect(undeclaredSaved.ok).toBe(true);
    await undeclaredHost.configureSdkProvider({ config, credential: "synthetic" });
    expect(undeclaredHost.runScheduleNow(undeclaredSaved.ok ? undeclaredSaved.schedule.scheduleId : "")).toMatchObject({ result: "failed", failureCode: "model-missing" });

    const missing = fixture();
    const missingHost = missing.createHost();
    await missingHost.configureSdkProvider({ config, credential: "synthetic" });
    const missingSaved = missingHost.saveSchedule({ ...BASE, enabled: true });
    rmSync(missing.taskDir, { recursive: true, force: true });
    expect(missingHost.runScheduleNow(missingSaved.ok ? missingSaved.schedule.scheduleId : "")).toMatchObject({ result: "failed", failureCode: "directory-missing" });
  });

  it("refuses an invalid definition on save and never bolts a schedule onto an ordinary task", async () => {
    const ordinary = fixture({ kind: "normal" });
    const ordinaryHost = ordinary.createHost();
    expect(ordinaryHost.saveSchedule(BASE)).toMatchObject({ ok: false, code: "not-schedule-task" });

    const f = fixture();
    const host = f.createHost();
    expect(host.saveSchedule({ ...BASE, prompt: "  " })).toMatchObject({ ok: false, code: "prompt-empty" });
    expect(host.saveSchedule({ ...BASE, timezone: "Mars/Olympus" })).toMatchObject({ ok: false, code: "timezone-invalid" });
    expect(host.saveSchedule({ ...BASE, ruleText: "每天跑一下" })).toMatchObject({ ok: false, code: "rule-invalid" });
    expect(host.saveSchedule({ ...BASE, permission: "root" as never })).toMatchObject({ ok: false, code: "permission-invalid" });
    expect(host.saveSchedule({ ...BASE, name: " " })).toMatchObject({ ok: false, code: "name-empty" });
    expect(host.listSchedules()).toEqual([]);
    // The fixed task directory is part of the definition.
    rmSync(f.taskDir, { recursive: true, force: true });
    expect(f.createHost().saveSchedule(BASE)).toMatchObject({ ok: false, code: "directory-missing" });
  });
});
