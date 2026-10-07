import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostStopper, createLastWindowShutdown, PerTaskHostRegistry, taskBrowserOriginsFromEnv } from "./runtime.js";
import { createDiskTaskDirResolver, defaultTasksRoot } from "./task-resolver.js";
import { TaskRootIndex } from "./task-root-index.js";
import type { HostTaskResult } from "../rpc/protocol.js";
import { TaskWorkspaceHost, diskTaskStore } from "../host/task-host.js";
import { buildLifecycleRecord, buildTaskDiskRecord, lifecycleFilePath, taskFilePath } from "../host/task-store.js";
import { TaskLifecycleHost } from "../host/task-lifecycle.js";
import { createLifecycleResources } from "../host/lifecycle-resources.js";

// Seam: per-task utilityProcess Host routing in main (S3a slice).
// `registerIpc(shell/taskOp)` routes through `PerTaskHostRegistry` when
// wired: one bound Host per task folder (fork-on-first-use), reused across
// ops. Task ids are globally unique under the single machine tasks root,
// so at most one folder wins per id; the registry is still keyed by
// `taskDir` internally and revalidates the resolved dir on every reuse.
// Unknown tasks fail closed before any fork (except `task/provision`,
// which bootstraps a never-recorded id from its validated `dirId`).

function fakeTransport(result: HostTaskResult) {
  return {
    task: vi.fn(async () => result),
    // The registry binds the per-task browser handler on every spawn.
    onBrowserRequest: vi.fn(),
    dispose: vi.fn(),
  };
}

function registryWith(
  resolveTaskDir: (taskId: string) => string | null,
  spawns: Array<{ taskId: string; taskDir: string }>,
  result: HostTaskResult,
) {
  const spawn = vi.fn(async (_workspaceId: string, task: { taskId: string; taskDir: string }) => {
    spawns.push(task);
    const transport = fakeTransport(result);
    return {
      // PerTaskHostRegistry needs only `{ task, dispose }` on the client
      // plus `kill` on the child; the cast keeps the seam Electron-free.
      client: transport as never,
      child: { kill: vi.fn() } as never,
    };
  });
  const registry = new PerTaskHostRegistry("workspace-a", spawn, resolveTaskDir);
  return { registry, spawn };
}

const TASK_RESULT: HostTaskResult = {
  workspaceId: "workspace-a",
  taskId: "task-a",
  op: "task/cancel",
  payload: { sessionId: "main" },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const QUIT_ORIGIN = { kind: "shell-ui" as const, senderWebContentsId: 7 };
const QUIT_RESULT: HostTaskResult = {
  workspaceId: "workspace-a", taskId: "task-a", op: "task/quit",
  payload: { quit: { applied: ["save-state:task-a"], plan: { failures: [], retainedTasks: [] } } },
};

describe("PerTaskHostRegistry main shutdown admission", () => {
  it("single-flights concurrent first use of the same task without serializing its operations", async () => {
    const started = deferred<void>(), ready = deferred<void>(), firstOp = deferred<HostTaskResult>();
    const transport = fakeTransport(TASK_RESULT);
    transport.task.mockImplementationOnce(() => firstOp.promise);
    const spawn = vi.fn(async () => {
      started.resolve(); await ready.promise;
      return { client: transport as never, child: { kill: vi.fn() } as never };
    });
    const registry = new PerTaskHostRegistry("workspace-a", spawn, () => "/tasks/a");
    const first = registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    await started.promise;
    const second = registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    ready.resolve();
    expect(await second).toEqual(TASK_RESULT);
    firstOp.resolve(TASK_RESULT); await first;
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(transport.task).toHaveBeenCalledTimes(2);
    expect(registry.size).toBe(1);
  });

  it("does not let a slow first fork serialize first use of another task", async () => {
    const ready = deferred<void>(), started = deferred<void>();
    const spawn = vi.fn(async (_ws: string, task: { taskId: string; taskDir: string }) => {
      if (task.taskId === "task-a") { started.resolve(); await ready.promise; }
      return { client: fakeTransport(TASK_RESULT) as never, child: { kill: vi.fn() } as never };
    });
    const registry = new PerTaskHostRegistry("workspace-a", spawn, (id) => `/tasks/${id}`);
    const first = registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    await started.promise;
    await registry.routeTaskOp({ taskId: "task-b", op: "task/cancel", payload: {} });
    expect(spawn).toHaveBeenCalledTimes(2); expect(registry.size).toBe(1);
    ready.resolve(); await first; expect(registry.size).toBe(2);
  });

  it("single-flights the provision bootstrap as well as existing tasks", async () => {
    const ready = deferred<void>(), started = deferred<void>(), transport = fakeTransport(TASK_RESULT);
    const spawn = vi.fn(async () => { started.resolve(); await ready.promise; return { client: transport as never, child: { kill: vi.fn() } as never }; });
    const registry = new PerTaskHostRegistry("workspace-a", spawn, () => null);
    const params = { taskId: "task-3b8f479a", op: "task/provision" as const,
      payload: { name: "Bootstrap", dirId: "task-3b8f479a", remoteBranch: "main", fetchedCommit: "abc123" } };
    const first = registry.routeTaskOp(params); await started.promise;
    const second = registry.routeTaskOp(params); ready.resolve();
    await Promise.all([first, second]);
    expect(spawn).toHaveBeenCalledTimes(1); expect(transport.task).toHaveBeenCalledTimes(2);
  });

  it("rejects another task claiming either a pending or an owned folder", async () => {
    const ready = deferred<void>(), started = deferred<void>(), transport = fakeTransport(TASK_RESULT);
    const spawn = vi.fn(async () => { started.resolve(); await ready.promise; return { client: transport as never, child: { kill: vi.fn() } as never }; });
    const registry = new PerTaskHostRegistry("workspace-a", spawn, () => "/tasks/a");
    const first = registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} }); await started.promise;
    await expect(registry.routeTaskOp({ taskId: "task-b", op: "task/cancel", payload: {} })).rejects.toThrow("task-moved");
    ready.resolve(); await first;
    await expect(registry.routeTaskOp({ taskId: "task-b", op: "task/cancel", payload: {} })).rejects.toThrow("task-moved");
    expect(spawn).toHaveBeenCalledTimes(1); expect(transport.task).toHaveBeenCalledTimes(1);
    expect(registry.entryForTaskId("task-a")?.taskDir).toBe("/tasks/a");
  });

  it("denies invalid quit authority or payload before sealing even an empty registry", async () => {
    const transport = fakeTransport(QUIT_RESULT), spawn = vi.fn(async () => ({ client: transport as never, child: { kill: vi.fn() } as never }));
    const registry = new PerTaskHostRegistry("workspace-a", spawn, () => "/tasks/a");
    for (const origin of [undefined, { kind: "agent-tool", senderWebContentsId: 7 }, { kind: "shell-ui", senderWebContentsId: "7" }]) {
      await expect(registry.quitAll({ origin: origin as never })).rejects.toThrow("permission-denied");
    }
    await expect(registry.quitAll({ origin: QUIT_ORIGIN, label: 5 as never })).rejects.toThrow("invalid-payload");
    await expect(registry.quitAll({ origin: QUIT_ORIGIN, sessionId: "main" } as never)).rejects.toThrow("permission-denied");
    expect(spawn).not.toHaveBeenCalled();
    await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    expect(await registry.quitAll({ origin: QUIT_ORIGIN })).toMatchObject({ ok: true });
    await expect(registry.quitAll({ origin: undefined as never })).rejects.toThrow("permission-denied");
    expect(transport.task).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["workspace", { workspaceId: "foreign-workspace-private-marker" }],
    ["task", { taskId: "foreign-task-private-marker" }],
    ["operation", { op: "task/cancel" }],
  ])("retains the owned Host when the quit reply names a foreign %s", async (_field, changed) => {
    const transport = fakeTransport({ ...QUIT_RESULT, ...changed } as HostTaskResult), kill = vi.fn();
    const registry = new PerTaskHostRegistry("workspace-a", async () => ({
      client: transport as never, child: { kill } as never,
    }), () => "/tasks/a");
    await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    const quit = registry.quitAll({ origin: QUIT_ORIGIN });
    const report = await quit;
    expect(report).toEqual({ ok: false, tasks: [{ taskId: "task-a", ok: false, applied: [], failures: [],
      retainedTasks: ["task-a"], error: "host-quit-report-invalid" }] });
    expect(registry.quitAll({ origin: QUIT_ORIGIN })).toBe(quit);
    expect(await registry.quitAll({ origin: QUIT_ORIGIN })).toEqual(report);
    expect(registry.entryForTaskId("task-a")?.taskDir).toBe("/tasks/a");
    expect(() => registry.disposeAll()).toThrow("main-task-shutdown-unconfirmed");
    expect(transport.dispose).not.toHaveBeenCalled(); expect(kill).not.toHaveBeenCalled();
    expect(transport.task).toHaveBeenCalledTimes(2);
    await expect(registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} })).rejects.toThrow("task-host-closing");
  });

  it.each([
    ["null applied", { applied: null }],
    ["non-array applied", { applied: { privateMarker: "malformed-reply-private-marker" } }],
    ["non-string applied entry", { applied: [17, "malformed-reply-private-marker"] }],
    ["sparse applied", { applied: Array(1) }],
    ["null retainedTasks", { retainedTasks: null }],
    ["non-array retainedTasks", { retainedTasks: "malformed-reply-private-marker" }],
    ["non-string retainedTasks entry", { retainedTasks: [null] }],
    ["sparse retainedTasks", { retainedTasks: Array(1) }],
  ])("retains the owned Host on a malformed quit report: %s", async (_shape, changed) => {
    const transport = fakeTransport({ ...QUIT_RESULT, payload: { quit: {
      applied: "applied" in changed ? changed.applied : [],
      plan: { failures: [], retainedTasks: "retainedTasks" in changed ? changed.retainedTasks : [] },
    } } }), kill = vi.fn();
    const registry = new PerTaskHostRegistry("workspace-a", async () => ({
      client: transport as never, child: { kill } as never,
    }), () => "/tasks/a");
    await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    const report = await registry.quitAll({ origin: QUIT_ORIGIN });
    expect(report).toEqual({ ok: false, tasks: [{ taskId: "task-a", ok: false, applied: [], failures: [],
      retainedTasks: ["task-a"], error: "host-quit-report-invalid" }] });
    transport.task.mockResolvedValue(QUIT_RESULT);
    expect(await registry.quitAll({ origin: QUIT_ORIGIN })).toEqual(report);
    expect(() => registry.disposeAll()).toThrow("main-task-shutdown-unconfirmed");
    expect(registry.size).toBe(1);
    expect(transport.dispose).not.toHaveBeenCalled(); expect(kill).not.toHaveBeenCalled();
    expect(transport.task).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["null envelope", null],
    ["missing envelope", undefined],
    ["null payload", { ...QUIT_RESULT, payload: null }],
    ["non-record payload", { ...QUIT_RESULT, payload: "malformed-reply-private-marker" }],
  ])("reports malformed quit envelopes with a fixed error: %s", async (_shape, reply) => {
    const transport = fakeTransport(reply as HostTaskResult), kill = vi.fn();
    const registry = new PerTaskHostRegistry("workspace-a", async () => ({
      client: transport as never, child: { kill } as never,
    }), () => "/tasks/a");
    await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    const report = await registry.quitAll({ origin: QUIT_ORIGIN });
    expect(report).toEqual({ ok: false, tasks: [{ taskId: "task-a", ok: false, applied: [], failures: [],
      retainedTasks: ["task-a"], error: "host-quit-report-invalid" }] });
    expect(() => registry.disposeAll()).toThrow("main-task-shutdown-unconfirmed");
    expect(transport.dispose).not.toHaveBeenCalled(); expect(kill).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps the cached quit result independent of transport array mutation (blocked=%s)", async (blocked) => {
    const applied = ["save-state:task-a"];
    const failures = blocked ? [{ code: "unconfirmed" }] : [];
    const retainedTasks = blocked ? ["task-a"] : [];
    const transport = fakeTransport({ ...QUIT_RESULT, payload: { quit: { applied, plan: { failures, retainedTasks } } } }), kill = vi.fn();
    const registry = new PerTaskHostRegistry("workspace-a", async () => ({
      client: transport as never, child: { kill } as never,
    }), () => "/tasks/a");
    await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    const report = await registry.quitAll({ origin: QUIT_ORIGIN });
    const expected = { ok: !blocked, tasks: [{ taskId: "task-a", ok: true, applied: ["save-state:task-a"],
      failures: blocked ? [{ code: "unconfirmed" }] : [], retainedTasks: blocked ? ["task-a"] : [] }] };
    expect(report).toEqual(expected);
    applied.push("transport-mutated-private-marker");
    failures.splice(0, failures.length, { code: "transport-mutated-private-marker" });
    retainedTasks.splice(0, retainedTasks.length, "transport-mutated-private-marker");
    expect(await registry.quitAll({ origin: QUIT_ORIGIN })).toEqual(expected);
    if (blocked) {
      expect(() => registry.disposeAll()).toThrow("main-task-shutdown-unconfirmed");
      expect(registry.size).toBe(1);
      expect(transport.dispose).not.toHaveBeenCalled(); expect(kill).not.toHaveBeenCalled();
    } else {
      registry.disposeAll(); expect(registry.size).toBe(0);
      expect(transport.dispose).toHaveBeenCalledTimes(1); expect(kill).toHaveBeenCalledTimes(1);
    }
    expect(transport.task).toHaveBeenCalledTimes(2);
  });

  it("rejects a recreated indexed directory with the same path and record before dispatch", async () => {
    const { mkdirSync, writeFileSync, renameSync, rmSync } = await import("node:fs");
    const home = mkdtempSync(join(tmpdir(), "pidock-pending-identity-")), root = join(home, "tasks"), taskId = "task-3b8f479a", taskDir = join(root, taskId);
    mkdirSync(taskDir, { recursive: true });
    const record = JSON.stringify({ taskId, name: "Identity", dirId: taskId, root, taskDir,
      branch: "task/main", remoteBranch: "main", baseCommit: "abc123", repos: [],
      createdAt: "2026-09-22T10:00:00Z", updatedAt: "2026-09-22T10:00:00Z" });
    writeFileSync(join(taskDir, "task.json"), record);
    try {
      const index = new TaskRootIndex(join(home, "userData"), root);
      const ready = deferred<void>(), started = deferred<void>(), transport = fakeTransport(TASK_RESULT), kill = vi.fn();
      const spawn = vi.fn(async () => { started.resolve(); await ready.promise; return { client: transport as never, child: { kill } as never }; });
      const registry = new PerTaskHostRegistry("workspace-a", spawn, (id) => index.resolve(id), undefined, index);
      const original = index.verifiedIdentity(taskId);
      expect(original).not.toBeNull();
      const route = registry.routeTaskOp({ taskId, op: "task/cancel", payload: {} });
      const moved = expect(route).rejects.toThrow("task-moved"); await started.promise;
      renameSync(taskDir, join(home, "original-task")); mkdirSync(taskDir); writeFileSync(join(taskDir, "task.json"), record);
      expect(index.resolve(taskId)).toBe(taskDir);
      expect(index.verifiedIdentity(taskId)?.directoryInode).not.toBe(original?.directoryInode);
      await expect(registry.routeTaskOp({ taskId, op: "task/cancel", payload: {} })).rejects.toThrow("task-moved");
      ready.resolve(); await moved;
      await expect(registry.routeTaskOp({ taskId, op: "task/cancel", payload: {} })).rejects.toThrow("task-moved");
      expect(spawn).toHaveBeenCalledTimes(1); expect(transport.task).not.toHaveBeenCalled(); expect(kill).not.toHaveBeenCalled();
      expect(registry.entryForTaskId(taskId)?.taskDir).toBe(taskDir);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("seals synchronously and inventories an accepted late fork without dispatching its business op", async () => {
    const started = deferred<void>(), ready = deferred<void>();
    const transport = fakeTransport(QUIT_RESULT), kill = vi.fn();
    const spawn = vi.fn(async () => {
      started.resolve(); await ready.promise;
      return { client: transport as never, child: { kill } as never };
    });
    const registry = new PerTaskHostRegistry("workspace-a", spawn, () => "/tasks/a");
    const first = registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    const refused = expect(first).rejects.toThrow("task-host-closing");
    await started.promise;
    let finished = false;
    const quit = registry.quitAll({ origin: QUIT_ORIGIN }).then((report) => { finished = true; return report; });
    const late = registry.routeTaskOp({ taskId: "task-b", op: "task/cancel", payload: {} });
    const lateRefused = expect(late).rejects.toThrow("task-host-closing");
    expect(finished).toBe(false);
    ready.resolve(); await Promise.all([refused, lateRefused]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(await quit).toMatchObject({ ok: true, tasks: [{ taskId: "task-a", ok: true }] });
    expect(transport.task.mock.calls).toEqual([[{
      workspaceId: "workspace-a", taskId: "task-a", op: "task/quit", payload: {}, origin: QUIT_ORIGIN,
    }, { timeoutMs: 120_000 }]]);
    expect(registry.entryForTaskId("task-a")?.taskDir).toBe("/tasks/a");
    expect(transport.dispose).not.toHaveBeenCalled(); expect(kill).not.toHaveBeenCalled();
    registry.disposeAll(); expect(kill).toHaveBeenCalledTimes(1);
    await expect(registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} })).rejects.toThrow("task-host-closing");
  });

  it("sends quit to all owned Hosts before waiting for an admitted prompt to settle", async () => {
    const prompt = deferred<HostTaskResult>(), started = deferred<void>();
    const first = fakeTransport(TASK_RESULT), second = fakeTransport(TASK_RESULT);
    first.task.mockImplementation(async (params: unknown) => {
      if ((params as { op: string }).op === "task/quit") { prompt.resolve(TASK_RESULT); return QUIT_RESULT; }
      started.resolve(); return prompt.promise;
    });
    second.task.mockResolvedValue({ ...QUIT_RESULT, taskId: "task-b" });
    const registry = new PerTaskHostRegistry("workspace-a", async (_ws, task) => ({
      client: (task.taskId === "task-a" ? first : second) as never, child: { kill: vi.fn() } as never,
    }), (id) => `/tasks/${id}`);
    await registry.routeTaskOp({ taskId: "task-b", op: "task/cancel", payload: {} });
    const route = registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    await started.promise;
    expect(await registry.quitAll({ origin: QUIT_ORIGIN })).toMatchObject({ ok: true });
    await route;
    expect(first.task).toHaveBeenCalledTimes(2);
    expect(second.task).toHaveBeenLastCalledWith(expect.objectContaining({ op: "task/quit" }), { timeoutMs: 120_000 });
  });

  it("bounds the whole quit and fans out despite a stuck Host, caching uncertainty and retaining children", async () => {
    vi.useFakeTimers();
    try {
      const stuck = deferred<HostTaskResult>(), kill = vi.fn();
      const first = fakeTransport(TASK_RESULT), second = fakeTransport(TASK_RESULT);
      first.task.mockResolvedValueOnce(TASK_RESULT).mockImplementation(() => stuck.promise);
      second.task.mockResolvedValue({ ...QUIT_RESULT, taskId: "task-b" });
      const registry = new PerTaskHostRegistry("workspace-a", async (_ws, task) => ({
        client: (task.taskId === "task-a" ? first : second) as never, child: { kill } as never,
      }), (id) => `/tasks/${id}`);
      await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
      await registry.routeTaskOp({ taskId: "task-b", op: "task/cancel", payload: {} });
      const quit = registry.quitAll({ origin: QUIT_ORIGIN });
      await vi.advanceTimersByTimeAsync(0);
      expect(second.task).toHaveBeenLastCalledWith(expect.objectContaining({ op: "task/quit" }), { timeoutMs: 120_000 });
      await vi.advanceTimersByTimeAsync(15_000);
      const report = await quit;
      expect(report.ok).toBe(false);
      expect(report.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: "task-a", ok: false, retainedTasks: ["task-a"] })]));
      expect(() => registry.disposeAll()).toThrow("shutdown-unconfirmed");
      expect(kill).not.toHaveBeenCalled(); expect(first.dispose).not.toHaveBeenCalled();
      stuck.resolve(QUIT_RESULT);
      expect(await registry.quitAll({ origin: QUIT_ORIGIN })).toEqual(report);
      expect(first.task).toHaveBeenCalledTimes(2); expect(second.task).toHaveBeenCalledTimes(2);
      await expect(registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} })).rejects.toThrow("task-host-closing");
    } finally { vi.useRealTimers(); }
  });

  it("retains ownership of a child arriving after the shared shutdown deadline without replay or disposal", async () => {
    vi.useFakeTimers();
    try {
      const started = deferred<void>(), ready = deferred<void>(), transport = fakeTransport(QUIT_RESULT), kill = vi.fn();
      const registry = new PerTaskHostRegistry("workspace-a", async () => {
        started.resolve(); await ready.promise;
        return { client: transport as never, child: { kill } as never };
      }, () => "/tasks/a");
      const route = registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
      const refused = expect(route).rejects.toThrow("task-host-closing");
      await started.promise;
      const quit = registry.quitAll({ origin: QUIT_ORIGIN });
      await vi.advanceTimersByTimeAsync(15_000);
      const report = await quit;
      expect(report).toMatchObject({ ok: false, tasks: [{ taskId: "task-a", ok: false, retainedTasks: ["task-a"] }] });
      expect(() => registry.disposeAll()).toThrow("shutdown-unconfirmed");
      ready.resolve(); await refused;
      expect(registry.entryForTaskId("task-a")?.taskDir).toBe("/tasks/a");
      expect(await registry.quitAll({ origin: QUIT_ORIGIN })).toEqual(report);
      expect(transport.task).not.toHaveBeenCalled(); expect(transport.dispose).not.toHaveBeenCalled(); expect(kill).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("shares one total deadline between fork ownership and settlement of an already-dispatched route", async () => {
    vi.useFakeTimers();
    try {
      const ready = deferred<void>(), started = deferred<void>(), running = deferred<HostTaskResult>();
      const first = fakeTransport(TASK_RESULT), second = fakeTransport({ ...QUIT_RESULT, taskId: "task-b" });
      first.task.mockImplementation(async (params: unknown) => {
        if ((params as { op: string }).op === "task/quit") return QUIT_RESULT;
        started.resolve(); return running.promise;
      });
      const registry = new PerTaskHostRegistry("workspace-a", async (_ws, task) => {
        if (task.taskId === "task-b") await ready.promise;
        return { client: (task.taskId === "task-a" ? first : second) as never, child: { kill: vi.fn() } as never };
      }, (id) => `/tasks/${id}`);
      const a = registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
      await started.promise;
      const b = registry.routeTaskOp({ taskId: "task-b", op: "task/cancel", payload: {} });
      const refused = expect(b).rejects.toThrow("task-host-closing");
      const quit = registry.quitAll({ origin: QUIT_ORIGIN });
      await vi.advanceTimersByTimeAsync(14_000); ready.resolve(); await refused;
      await vi.advanceTimersByTimeAsync(1_000);
      const report = await quit;
      expect(report.ok).toBe(false);
      expect(report.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: "task-a", ok: false, retainedTasks: ["task-a"] })]));
      expect(() => registry.disposeAll()).toThrow("shutdown-unconfirmed");
      running.resolve(TASK_RESULT); await a;
      expect(await registry.quitAll({ origin: QUIT_ORIGIN })).toEqual(report);
    } finally { vi.useRealTimers(); }
  });

  it("keeps failed spawn uncertainty instead of reporting an empty successful shutdown", async () => {
    const ready = deferred<void>(), started = deferred<void>();
    const registry = new PerTaskHostRegistry("workspace-a", async () => {
      started.resolve(); await ready.promise; throw Error("fork-unconfirmed");
    }, () => "/tasks/a");
    const route = registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    const failed = expect(route).rejects.toThrow("fork-unconfirmed");
    await started.promise;
    const quit = registry.quitAll({ origin: QUIT_ORIGIN });
    ready.resolve(); await failed;
    const report = await quit;
    expect(report).toMatchObject({ ok: false, tasks: [{ taskId: "task-a", ok: false, retainedTasks: ["task-a"] }] });
    expect(await registry.quitAll({ origin: QUIT_ORIGIN })).toEqual(report);
    expect(() => registry.disposeAll()).toThrow("shutdown-unconfirmed");
  });

  it("preserves an owned child when handler binding fails and reports one failed task", async () => {
    const transport = fakeTransport(QUIT_RESULT), kill = vi.fn();
    transport.onBrowserRequest.mockImplementationOnce(() => { throw Error("handler-binding-unconfirmed"); });
    const registry = new PerTaskHostRegistry("workspace-a", async () => ({ client: transport as never, child: { kill } as never }), () => "/tasks/a");
    await expect(registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} })).rejects.toThrow("handler-binding-unconfirmed");
    expect(registry.size).toBe(1); expect(registry.entryForTaskId("task-a")?.taskDir).toBe("/tasks/a");
    const report = await registry.quitAll({ origin: QUIT_ORIGIN });
    expect(report).toMatchObject({ ok: false, tasks: [{ taskId: "task-a", ok: false, applied: ["save-state:task-a"], retainedTasks: ["task-a"], error: "handler-binding-unconfirmed" }] });
    expect(report.tasks).toHaveLength(1);
    expect(() => registry.disposeAll()).toThrow("shutdown-unconfirmed");
    expect(transport.dispose).not.toHaveBeenCalled(); expect(kill).not.toHaveBeenCalled();
    expect(await registry.quitAll({ origin: QUIT_ORIGIN })).toEqual(report);
    expect(transport.task).toHaveBeenCalledTimes(1);
  });

  it("rejects a moved pending claim while preserving the original late child", async () => {
    const ready = deferred<void>(), started = deferred<void>(), transport = fakeTransport(TASK_RESULT);
    let dir = "/tasks/a";
    const spawn = vi.fn(async () => { started.resolve(); await ready.promise; return { client: transport as never, child: { kill: vi.fn() } as never }; });
    const registry = new PerTaskHostRegistry("workspace-a", spawn, () => dir);
    const route = registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    const moved = expect(route).rejects.toThrow("task-moved");
    await started.promise; dir = "/tasks/moved";
    await expect(registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} })).rejects.toThrow("task-moved");
    ready.resolve(); await moved;
    expect(spawn).toHaveBeenCalledTimes(1); expect(transport.task).not.toHaveBeenCalled();
    expect(registry.entryForTaskId("task-a")?.taskDir).toBe("/tasks/a");
  });
});

describe("PerTaskHostRegistry", () => {
  it("forks a bound Host on first use and reuses it for later ops", async () => {
    const spawns: Array<{ taskId: string; taskDir: string }> = [];
    const { registry, spawn } = registryWith(() => "/tasks/task-a", spawns, TASK_RESULT);
    const first = await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    expect(first).toEqual(TASK_RESULT);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith("workspace-a", { taskId: "task-a", taskDir: "/tasks/task-a" });
    expect(registry.size).toBe(1);

    const second = await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    expect(second).toEqual(TASK_RESULT);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(1);
  });

  it("forks a separate Host per task folder", async () => {
    const spawns: Array<{ taskId: string; taskDir: string }> = [];
    const dirs: Record<string, string> = { "task-a": "/tasks/a", "task-b": "/tasks/b" };
    const { registry, spawn } = registryWith((id) => dirs[id] ?? null, spawns, TASK_RESULT);
    await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    await registry.routeTaskOp({ taskId: "task-b", op: "task/cancel", payload: {} });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawns).toEqual([
      { taskId: "task-a", taskDir: "/tasks/a" },
      { taskId: "task-b", taskDir: "/tasks/b" },
    ]);
    expect(registry.size).toBe(2);
  });

  it("fails closed on unknown tasks before forking, and validates the op first", async () => {
    const spawns: Array<{ taskId: string; taskDir: string }> = [];
    const { registry, spawn } = registryWith(() => null, spawns, TASK_RESULT);
    await expect(registry.routeTaskOp({ taskId: "task-ghost", op: "task/cancel", payload: {} })).rejects.toThrow(
      "unknown task",
    );
    expect(spawn).not.toHaveBeenCalled();
    await expect(
      registry.routeTaskOp({ taskId: "task-ghost", op: "task/exec" as never, payload: {} }),
    ).rejects.toThrow("unknown-op");
  });

  it("a bound host/task op dispatches; an unbound Host stays task-unbound fail-closed", async () => {
    // Bound path: routed op reaches the forked (bound) client.
    const spawns: Array<{ taskId: string; taskDir: string }> = [];
    const { registry } = registryWith(() => "/tasks/task-a", spawns, TASK_RESULT);
    const routed = await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    expect(routed.taskId).toBe("task-a");
    // Unbound path: the Host-side rule (`routeTaskBinding`) rejects when
    // PIDOCK_TASK_ID/PIDOCK_TASK_DIR are unset — mirrored here without a
    // utilityProcess parent port.
    const { routeTaskBinding } = await import("../host/host-guards.js");
    expect(routeTaskBinding("task-a", undefined, undefined)).toBe("task-unbound");
    expect(routeTaskBinding("task-a", "task-a", "/tasks/task-a")).toBe("routable");
  });

  it("re-resolves the task dir on reuse and rejects a moved task instead of a stale Host", async () => {
    const spawns: Array<{ taskId: string; taskDir: string }> = [];
    let dir: string | null = "/tasks/a";
    const { registry, spawn } = registryWith(() => dir, spawns, TASK_RESULT);
    await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    expect(spawn).toHaveBeenCalledTimes(1);
    // Record moved away: reuse must fail closed, not ride the stale fork.
    dir = "/tasks/a-moved";
    await expect(registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} })).rejects.toThrow(
      "task-moved",
    );
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(registry.entryForTaskId("task-a")?.taskDir).toBe("/tasks/a");
    // Record deleted: same fail-closed, still no extra fork.
    dir = null;
    await expect(registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} })).rejects.toThrow(
      "task-moved",
    );
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("indexes a successful Host provision and retries a failed first index commit", async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const home = mkdtempSync(join(tmpdir(), "pidock-index-routing-"));
    const defaultRoot = join(home, "default");
    const override = join(home, "override");
    mkdirSync(defaultRoot);
    mkdirSync(override);
    const oldDefault = process.env["PIDOCK_DEFAULT_ROOT"];
    process.env["PIDOCK_DEFAULT_ROOT"] = defaultRoot;
    try {
      let fail = true;
      const index = new TaskRootIndex(join(home, "userData"), defaultRoot, { beforeCommit: () => {
        if (fail) { fail = false; throw new Error("disk full"); }
      } });
      const taskId = "task-abcdef12";
      const taskDir = join(override, taskId);
      const transport = fakeTransport(TASK_RESULT);
      transport.task.mockImplementation(async () => {
        mkdirSync(taskDir, { recursive: true });
        writeFileSync(join(taskDir, "task.json"), JSON.stringify({ taskId, name: "Recovered", dirId: taskId,
          root: override, taskDir, branch: "task/main", remoteBranch: "main", baseCommit: "abc123",
          repos: [], createdAt: "2026-09-22T10:00:00Z", updatedAt: "2026-09-22T10:00:00Z" }));
        return TASK_RESULT;
      });
      const spawn = vi.fn(async () => ({ client: transport as never, child: { kill: vi.fn() } as never }));
      const registry = new PerTaskHostRegistry("workspace-a", spawn, (id) => index.resolve(id), undefined, index);
      const payload = { name: "Recovered", dirId: taskId, rootOverride: override, remoteBranch: "main", fetchedCommit: "abc123" };
      await expect(registry.routeTaskOp({ taskId, op: "task/provision", payload })).rejects.toThrow("disk full");
      expect(index.resolve(taskId)).toBeNull();
      await expect(registry.routeTaskOp({ taskId, op: "task/cancel", payload: {} })).rejects.toThrow("task-moved");
      await registry.routeTaskOp({ taskId, op: "task/provision", payload });
      expect(index.resolve(taskId)).toBe(taskDir);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(new TaskRootIndex(join(home, "userData"), defaultRoot).inventory().tasks).toHaveLength(1);
    } finally {
      if (oldDefault === undefined) delete process.env["PIDOCK_DEFAULT_ROOT"];
      else process.env["PIDOCK_DEFAULT_ROOT"] = oldDefault;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("bootstraps a never-recorded id via task/provision from its dirId", async () => {
    const home = process.env["HOME"] ?? "/tmp";
    const defaultRoot = `${home}/PiDockTasks`;
    const spawns: Array<{ taskId: string; taskDir: string }> = [];
    // Null resolver: no task.json exists yet — the provision bootstrap
    // must still fork the bound Host at the derived folder.
    const { registry, spawn } = registryWith(() => null, spawns, TASK_RESULT);
    const payload = {
      name: "发布前检查",
      dirId: "task-abcdef12",
      remoteBranch: "main",
      fetchedCommit: "a5a4a0d1234",
    };
    const routed = await registry.routeTaskOp({ taskId: "task-abcdef12", op: "task/provision", payload });
    expect(routed).toEqual(TASK_RESULT);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawns[0]).toEqual({ taskId: "task-abcdef12", taskDir: `${defaultRoot}/task-abcdef12` });
    // A provision payload whose dirId does not match the task id cannot
    // bootstrap another task's folder.
    const { registry: blocked } = registryWith(() => null, [], TASK_RESULT);
    await expect(
      blocked.routeTaskOp({ taskId: "task-99999999", op: "task/provision", payload }),
    ).rejects.toThrow("unknown task");
    // Non-provision ops on never-recorded ids still fail closed.
    await expect(
      registry.routeTaskOp({ taskId: "task-ghost", op: "task/cancel", payload: {} }),
    ).rejects.toThrow("unknown task");
  });

  it("bootstraps the shell-side id from the form's dirId (renderer shell path)", async () => {
    // P1-2 regression: the renderer passes the previewed `task-oooooooo`
    // key as BOTH the memory `workspaceKey` and the shell-side task id
    // (`taskId === dirId`), so the bootstrap's exact-match coupling holds
    // and bridged provision forks instead of failing `unknown task`.
    const home = process.env["HOME"] ?? "/tmp";
    const defaultRoot = `${home}/PiDockTasks`;
    const spawns: Array<{ taskId: string; taskDir: string }> = [];
    const { registry, spawn } = registryWith(() => null, spawns, TASK_RESULT);
    const payload = {
      name: "表单任务",
      dirId: "task-a1f92c3d",
      remoteBranch: "origin/main",
      fetchedCommit: "9acb5b6",
    };
    const routed = await registry.routeTaskOp({ taskId: "task-a1f92c3d", op: "task/provision", payload });
    expect(routed).toEqual(TASK_RESULT);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawns[0]).toEqual({ taskId: "task-a1f92c3d", taskDir: `${defaultRoot}/task-a1f92c3d` });
  });

  it("provisions at a rootOverride root and reuses the fork on a second op", async () => {
    // Override-aware reuse (S3d): the default-root resolver never covers
    // override folders, so reuse accepts the forked folder while its own
    // record still names this task. The provisioned record is written to
    // disk here (as `TaskWorkspaceHost.provision` would) so the second op
    // exercises the real on-disk guard, not a stubbed re-resolution.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const override = mkdtempSync(join(tmpdir(), "pidock-override-"));
    const spawns: Array<{ taskId: string; taskDir: string }> = [];
    const { registry, spawn } = registryWith(() => null, spawns, TASK_RESULT);
    const payload = {
      name: "发布前检查",
      dirId: "task-abcdef12",
      remoteBranch: "main",
      fetchedCommit: "a5a4a0d1234",
      rootOverride: override,
    };
    await registry.routeTaskOp({ taskId: "task-abcdef12", op: "task/provision", payload });
    expect(spawn).toHaveBeenCalledTimes(1);
    const overrideTaskDir = join(override, "task-abcdef12");
    expect(spawns[0]).toEqual({ taskId: "task-abcdef12", taskDir: overrideTaskDir });
    // Host writes the task record on provision; reuse must ride the same
    // fork, not throw `task-moved` and not fork again.
    mkdirSync(overrideTaskDir, { recursive: true });
    writeFileSync(
      join(overrideTaskDir, "task.json"),
      JSON.stringify({
        taskId: "task-abcdef12",
        name: "发布前检查",
        dirId: "task-abcdef12",
        branch: "task/task-abcdef12",
        root: override,
        taskDir: overrideTaskDir,
        remoteBranch: "main",
        baseCommit: "a5a4a0d1234",
        repos: [],
        createdAt: "2026-09-22T10:00:00+08:00",
        updatedAt: "2026-09-22T10:00:00+08:00",
      }),
      "utf8",
    );
    const second = await registry.routeTaskOp({ taskId: "task-abcdef12", op: "task/cancel", payload: {} });
    expect(second).toEqual(TASK_RESULT);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("rejects reuse at an override folder whose record names another task", async () => {
    // Same override shape, but the folder's record was claimed by a
    // different task: reuse must fail closed with `task-moved`.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const override = mkdtempSync(join(tmpdir(), "pidock-override-evil-"));
    const spawns: Array<{ taskId: string; taskDir: string }> = [];
    const { registry, spawn } = registryWith(() => null, spawns, TASK_RESULT);
    const payload = {
      name: "发布前检查",
      dirId: "task-abcdef12",
      remoteBranch: "main",
      fetchedCommit: "a5a4a0d1234",
      rootOverride: override,
    };
    await registry.routeTaskOp({ taskId: "task-abcdef12", op: "task/provision", payload });
    expect(spawn).toHaveBeenCalledTimes(1);
    const overrideTaskDir = join(override, "task-abcdef12");
    mkdirSync(overrideTaskDir, { recursive: true });
    writeFileSync(
      join(overrideTaskDir, "task.json"),
      JSON.stringify({
        taskId: "task-evil0000",
        name: "冒名任务",
        dirId: "task-abcdef12",
        branch: "task/task-abcdef12",
        root: override,
        taskDir: overrideTaskDir,
        remoteBranch: "main",
        baseCommit: "a5a4a0d1234",
        repos: [],
        createdAt: "2026-09-22T10:00:00+08:00",
        updatedAt: "2026-09-22T10:00:00+08:00",
      }),
      "utf8",
    );
    await expect(
      registry.routeTaskOp({ taskId: "task-abcdef12", op: "task/cancel", payload: {} }),
    ).rejects.toThrow("task-moved");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("refuses to bootstrap into a folder already claimed by another task", async () => {
    // Folder-collision guard: a never-recorded id whose derived folder
    // already holds a different task's `task.json` cannot bootstrap it.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const override = mkdtempSync(join(tmpdir(), "pidock-override-taken-"));
    const spawns: Array<{ taskId: string; taskDir: string }> = [];
    const { registry, spawn } = registryWith(() => null, spawns, TASK_RESULT);
    const takenDir = join(override, "task-abcdef12");
    mkdirSync(takenDir, { recursive: true });
    writeFileSync(
      join(takenDir, "task.json"),
      JSON.stringify({
        taskId: "task-taken000",
        name: "已占任务",
        dirId: "task-abcdef12",
        branch: "task/task-abcdef12",
        root: override,
        taskDir: takenDir,
        remoteBranch: "main",
        baseCommit: "a5a4a0d1234",
        repos: [],
        createdAt: "2026-09-22T10:00:00+08:00",
        updatedAt: "2026-09-22T10:00:00+08:00",
      }),
      "utf8",
    );
    await expect(
      registry.routeTaskOp({
        taskId: "task-abcdef12",
        op: "task/provision",
        payload: {
          name: "发布前检查",
          dirId: "task-abcdef12",
          remoteBranch: "main",
          fetchedCommit: "a5a4a0d1234",
          rootOverride: override,
        },
      }),
    ).rejects.toThrow("unknown task");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("resolves provisioned tasks exactly as main.ts wires the registry (real resolver + fake spawn)", async () => {
    // Guards the regression where production never forked: seed a temp
    // tasks root with a real `task.json`, build the real disk resolver
    // over it, and assert first-use spawns the bound Host there.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const root = mkdtempSync(join(tmpdir(), "pidock-wiring-"));
    const taskDir = join(root, "task-abcdef12");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, "task.json"),
      JSON.stringify({
        taskId: "task-wired",
        name: "发布前检查",
        dirId: "task-abcdef12",
        branch: "task/task-abcdef12",
        root,
        taskDir,
        remoteBranch: "main",
        baseCommit: "a5a4a0d1234",
        repos: [],
        createdAt: "2026-09-22T10:00:00+08:00",
        updatedAt: "2026-09-22T10:00:00+08:00",
      }),
      "utf8",
    );
    const spawns: Array<{ taskId: string; taskDir: string }> = [];
    const { registry, spawn } = registryWith(createDiskTaskDirResolver(root), spawns, TASK_RESULT);
    const routed = await registry.routeTaskOp({ taskId: "task-wired", op: "task/cancel", payload: {} });
    expect(routed).toEqual(TASK_RESULT);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawns[0]).toEqual({ taskId: "task-wired", taskDir });
    // And the helper main.ts uses to build the production root is sane.
    expect(typeof defaultTasksRoot()).toBe("string");
  });

  it("disposeAll requires successful quit and then kills every owned Host", async () => {
    const spawns: Array<{ taskId: string; taskDir: string }> = [];
    const dirs: Record<string, string> = { "task-a": "/tasks/a", "task-b": "/tasks/b" };
    const { registry } = registryWith((id) => dirs[id] ?? null, spawns, QUIT_RESULT);
    expect(() => registry.disposeAll()).toThrow("shutdown-unconfirmed");
    await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    await registry.routeTaskOp({ taskId: "task-b", op: "task/cancel", payload: {} });
    expect(registry.size).toBe(2);
    const entries = [registry.entryForTaskId("task-a")!, registry.entryForTaskId("task-b")!];
    vi.mocked(entries[1]!.client.task).mockResolvedValue({ ...QUIT_RESULT, taskId: "task-b" });
    expect(() => registry.disposeAll()).toThrow("shutdown-unconfirmed");
    for (const entry of entries) {
      expect(entry.client.dispose).not.toHaveBeenCalled(); expect(entry.child.kill).not.toHaveBeenCalled();
    }
    expect(await registry.quitAll({ origin: QUIT_ORIGIN })).toMatchObject({ ok: true });
    registry.disposeAll();
    expect(registry.size).toBe(0);
    for (const entry of entries) {
      expect(entry.client.dispose).toHaveBeenCalledTimes(1); expect(entry.child.kill).toHaveBeenCalledTimes(1);
    }
  });

  it("restarts with a fresh registry only after quit and disposal of the sealed instance", async () => {
    const spawns: Array<{ taskId: string; taskDir: string }> = [];
    const { registry, spawn } = registryWith(() => "/tasks/task-a", spawns, QUIT_RESULT);
    await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    expect(spawn).toHaveBeenCalledTimes(1); expect(registry.size).toBe(1);
    expect(await registry.quitAll({ origin: QUIT_ORIGIN })).toMatchObject({ ok: true });
    registry.disposeAll(); expect(registry.size).toBe(0);
    await expect(registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} })).rejects.toThrow("task-host-closing");
    const restarted = registryWith(() => "/tasks/task-a", spawns, QUIT_RESULT);
    await restarted.registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    expect(restarted.spawn).toHaveBeenCalledTimes(1); expect(spawns).toHaveLength(2); expect(restarted.registry.size).toBe(1);
  });
});

describe("#6 append routing (S4)", () => {
  it("routes task/appendRepos to the resolved task folder without a new fork", async () => {
    const spawns: Array<{ taskId: string; taskDir: string }> = [];
    const { registry, spawn } = registryWith(() => "/tasks/task-abcdef12", spawns, TASK_RESULT);
    const routed = await registry.routeTaskOp({
      taskId: "task-abcdef12",
      op: "task/appendRepos",
      payload: {
        repoSelections: [
          { repoDir: "shipment", remote: "origin", remoteBranch: "main", mainCheckoutDir: "/src/shipment" },
        ],
        fetchedCommits: { shipment: "c0ffee1234" },
        takenPaths: [],
        branchesInUse: [],
      },
    });
    expect(routed).toEqual(TASK_RESULT);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawns[0]).toEqual({ taskId: "task-abcdef12", taskDir: "/tasks/task-abcdef12" });
  });

  it("fails closed on unrecorded ids for append (no bootstrap except provision)", async () => {
    const { registry } = registryWith(() => null, [], TASK_RESULT);
    await expect(
      registry.routeTaskOp({
        taskId: "task-ghost",
        op: "task/appendRepos",
        payload: { repoSelections: [], fetchedCommits: {}, takenPaths: [], branchesInUse: [] },
      }),
    ).rejects.toThrow("unknown task");
  });
});

// [PiDock 06] (#8): every forked Host client gets the per-task browser
// handler bound at spawn time, so the Host's browser requests route to
// main's capability; without a capability they fail closed.
describe("browser request binding", () => {
  function spawnCapturing(handlers: Array<(params: unknown) => Promise<unknown>>) {
    return vi.fn(async () => ({
      client: {
        task: vi.fn(async () => TASK_RESULT),
        onBrowserRequest: vi.fn((handler: (params: unknown) => Promise<unknown>) => {
          handlers.push(handler);
        }),
        dispose: vi.fn(),
      } as never,
      child: { kill: vi.fn() } as never,
    }));
  }

  it("routes a bound Host's browser request to the main capability", async () => {
    const handlers: Array<(params: unknown) => Promise<unknown>> = [];
    const browsers = {
      handleRequest: vi.fn(async () => ({ ok: true as const, payload: { performed: "page/state" } })),
    };
    const registry = new PerTaskHostRegistry("workspace-a", spawnCapturing(handlers) as never, () => "/tasks/task-a", browsers);
    await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    expect(handlers).toHaveLength(1);
    const result = await handlers[0]?.({ workspaceId: "workspace-a", taskId: "task-a", action: "page/state", actor: { kind: "human", label: "用户" } });
    expect(browsers.handleRequest).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-a", action: "page/state" }),
    );
    expect(result).toEqual({ ok: true, payload: { performed: "page/state" } });
  });

  it("fails closed when no browser capability is wired", async () => {
    const handlers: Array<(params: unknown) => Promise<unknown>> = [];
    const registry = new PerTaskHostRegistry("workspace-a", spawnCapturing(handlers) as never, () => "/tasks/task-a");
    await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    const result = await handlers[0]?.({ workspaceId: "workspace-a", taskId: "task-a", action: "page/state", actor: { kind: "human", label: "用户" } });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("browser-unavailable") });
  });
});

// [PiDock 06] (#8): the interim per-task navigation allowlist source.
describe("task browser origins", () => {
  it("keeps well-formed task entries and drops malformed ones", () => {
    const parsed = taskBrowserOriginsFromEnv(
      JSON.stringify({
        "task-a": ["http://localhost:5173", "https://saas.example.com", ""],
        "task-b": "http://localhost:8080",
        " ": ["http://localhost:1"],
        "task-c": [],
      }),
    );
    expect(parsed).toEqual({ "task-a": ["http://localhost:5173", "https://saas.example.com"] });
  });

  it("fails closed on missing or malformed values", () => {
    expect(taskBrowserOriginsFromEnv(undefined)).toEqual({});
    expect(taskBrowserOriginsFromEnv("")).toEqual({});
    expect(taskBrowserOriginsFromEnv("not json")).toEqual({});
    expect(taskBrowserOriginsFromEnv("[\"http://localhost:5173\"]")).toEqual({});
  });

  it("retries a failed Host shutdown without disposing pending Hosts", async () => {
    const quitAll = vi.fn().mockResolvedValueOnce({ ok: false, tasks: [{ taskId: "task-a", ok: false, retainedTasks: ["task-a"] }] })
      .mockRejectedValueOnce(new Error("temporary timeout"))
      .mockResolvedValue({ ok: true, tasks: [] });
    const dispose = vi.fn();
    const stop = createHostStopper({ quitAll }, { kind: "shell-ui", senderWebContentsId: 7 }, dispose);
    expect(await stop()).toBe(false);
    expect(dispose).not.toHaveBeenCalled();
    expect(await stop()).toBe(false);
    expect(dispose).not.toHaveBeenCalled();
    expect(await stop()).toBe(true);
    expect(await stop()).toBe(true);
    expect(quitAll).toHaveBeenCalledTimes(3);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("retries last-window shutdown after a failed Host report without killing the Host", async () => {
    vi.useFakeTimers();
    try {
      const quitAll = vi.fn().mockResolvedValueOnce({ ok: false, tasks: [{ taskId: "task-a", ok: false, retainedTasks: ["task-a"] }] })
        .mockResolvedValue({ ok: true, tasks: [] });
      const dispose = vi.fn();
      const quitApp = vi.fn();
      const stop = createHostStopper({ quitAll }, { kind: "shell-ui", senderWebContentsId: 7 }, dispose);
      const lastWindowClosed = createLastWindowShutdown(stop, quitApp, 5_000);
      await lastWindowClosed();
      expect(dispose).not.toHaveBeenCalled();
      expect(quitApp).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(quitAll).toHaveBeenCalledTimes(2);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(quitApp).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(quitAll).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it("[PiDock 14] (#17) quitAll sends the attested quit op to every forked Host and reports blocked resources", async () => {
    const spawns: Array<{ taskId: string; taskDir: string }> = [];
    const dirs: Record<string, string> = { "task-a": "/tasks/a", "task-b": "/tasks/b" };
    const calls: { taskId: string; op: string; payload: Record<string, unknown>; origin: unknown; timeoutMs?: number }[] = [];
    const spawn = vi.fn(async (_workspaceId: string, task: { taskId: string; taskDir: string }) => {
      spawns.push(task);
      const transport = {
        task: vi.fn(async (params: { taskId: string; op: string; payload?: Record<string, unknown>; origin?: unknown }, options?: { timeoutMs?: number }) => {
          calls.push({ taskId: params.taskId, op: params.op, payload: params.payload ?? {}, origin: params.origin, ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
          return {
            workspaceId: "workspace-a",
            taskId: params.taskId,
            op: params.op,
            payload:
              params.taskId === "task-a"
                ? { quit: { applied: ["abort-agent:main", "save-state:task-a"], plan: { failures: [], retainedTasks: [] } } }
                : { quit: { applied: ["save-state:task-b"], plan: { failures: [{ code: "port-only" }], retainedTasks: ["task-b"] } } },
          };
        }),
        onBrowserRequest: vi.fn(),
        dispose: vi.fn(),
      };
      return { client: transport as never, child: { kill: vi.fn() } as never };
    });
    const registry = new PerTaskHostRegistry("workspace-a", spawn, (id) => dirs[id] ?? null);
    await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    await registry.routeTaskOp({ taskId: "task-b", op: "task/cancel", payload: {} });

    const origin = { kind: "shell-ui" as const, senderWebContentsId: 7 };
    const report = await registry.quitAll({ origin, label: "应用明确退出" });

    expect(calls.filter((call) => call.op === "task/quit")).toEqual([
      { taskId: "task-a", op: "task/quit", payload: { label: "应用明确退出" }, origin, timeoutMs: 120_000 },
      { taskId: "task-b", op: "task/quit", payload: { label: "应用明确退出" }, origin, timeoutMs: 120_000 },
    ]);
    expect(report.tasks.map((task) => task.taskId)).toEqual(["task-a", "task-b"]);
    expect(report.ok).toBe(false);
    expect(report.tasks[1]).toMatchObject({ ok: true, retainedTasks: ["task-b"] });
    // Owned children remain retained, with new routes sealed, until successful disposal.
    expect(registry.size).toBe(2);
  });

  it("retains Hosts when quit reports failures even with an empty retainedTasks list", async () => {
    const kill = vi.fn(), dispose = vi.fn();
    const registry = new PerTaskHostRegistry("workspace-a", async () => ({ child: { kill } as never, client: {
      task: vi.fn(async (params) => ({ workspaceId: "workspace-a", taskId: params.taskId, op: params.op, payload: params.op === "task/quit" ? { quit: { applied: [], plan: { failures: [{ code: "unconfirmed" }], retainedTasks: [] } } } : {} })),
      onBrowserRequest: vi.fn(), dispose,
    } as never }), () => "/tasks/a");
    await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    const stop = createHostStopper(registry, { kind: "shell-ui", senderWebContentsId: 7 }, () => registry.disposeAll());
    expect(await stop()).toBe(false); expect(kill).not.toHaveBeenCalled(); expect(dispose).not.toHaveBeenCalled(); expect(registry.size).toBe(1);
    expect(() => registry.disposeAll()).toThrow("shutdown-unconfirmed");
    expect(await stop()).toBe(false); expect(kill).not.toHaveBeenCalled(); expect(dispose).not.toHaveBeenCalled();
  });
  it.each(["moved-root", "foreign-task"] as const)("retains a Host and reports a disk lifecycle refusal on quit after %s", async (change) => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-quit-ownership-")));
    const root = join(home, "tasks"), taskDir = join(root, "task-abcdef12"), moved = join(home, "moved-tasks");
    const kill = vi.fn(), dispose = vi.fn();
    try {
      const record = buildTaskDiskRecord({ taskId: "task-a", name: "Quit ownership", dirId: "task-abcdef12", branch: "task/abcdef12", root, taskDir, remoteBranch: "main", baseCommit: "abc123", repos: [], now: "2026-09-22T10:00:00Z" });
      diskTaskStore.writeTask(taskDir, record);
      const host = new TaskWorkspaceHost("task-a", taskDir, diskTaskStore);
      const lifecycle = new TaskLifecycleHost("task-a", taskDir, diskTaskStore, createLifecycleResources({ host, services: () => null, terminals: () => null, sessionIds: () => [], liveProcesses: () => [] }));
      lifecycle.archive();
      const index = new TaskRootIndex(join(home, "profile"), root);
      const registry = new PerTaskHostRegistry("workspace-a", async () => ({ child: { kill } as never, client: {
        task: vi.fn(async (params) => ({ workspaceId: "workspace-a", taskId: params.taskId, op: params.op, payload: params.op === "task/quit" ? { quit: lifecycle.quit() } : {} })),
        onBrowserRequest: vi.fn(), dispose,
      } as never }), (taskId) => index.resolve(taskId));
      await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
      if (change === "moved-root") renameSync(root, moved);
      else {
        diskTaskStore.writeTask(taskDir, { ...record, taskId: "foreign-task" });
        diskTaskStore.writeLifecycle(taskDir, buildLifecycleRecord({ taskId: "foreign-task", now: "2026-09-22T12:00:00Z" }));
      }
      const retainedDir = change === "moved-root" ? join(moved, "task-abcdef12") : taskDir;
      const before = readFileSync(lifecycleFilePath(retainedDir), "utf8"), taskBefore = readFileSync(taskFilePath(retainedDir), "utf8");
      expect(index.resolve("task-a")).toBeNull();
      const report = await registry.quitAll({ origin: QUIT_ORIGIN });
      expect(report).toMatchObject({ ok: false, tasks: [{ taskId: "task-a", ok: false, applied: [], failures: [], retainedTasks: ["task-a"], error: expect.stringContaining(change === "moved-root" ? "ENOENT" : "ownership mismatch") }] });
      const stop = createHostStopper(registry, QUIT_ORIGIN, () => registry.disposeAll());
      expect(await stop()).toBe(false);
      expect(registry.size).toBe(1);
      expect(() => registry.disposeAll()).toThrow("main-task-shutdown-unconfirmed");
      expect(kill).not.toHaveBeenCalled(); expect(dispose).not.toHaveBeenCalled();
      expect(existsSync(root)).toBe(change !== "moved-root");
      expect(readFileSync(lifecycleFilePath(retainedDir), "utf8")).toBe(before);
      expect(readFileSync(taskFilePath(retainedDir), "utf8")).toBe(taskBefore);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("[PiDock 14] (#17) quitAll reports a Host that fails to answer instead of dropping the task", async () => {
    const spawn = vi.fn(async () => ({
      client: {
        task: vi.fn(async (params: { taskId: string; op: string }) => {
          if (params.op === "task/quit") throw new Error("host-unreachable");
          return { workspaceId: "workspace-a", taskId: params.taskId, op: params.op, payload: {} };
        }),
        onBrowserRequest: vi.fn(),
        dispose: vi.fn(),
      } as never,
      child: { kill: vi.fn() } as never,
    }));
    const registry = new PerTaskHostRegistry("workspace-a", spawn, (id) => (id === "task-a" ? "/tasks/a" : null));
    await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });

    const report = await registry.quitAll({ origin: { kind: "shell-ui", senderWebContentsId: 7 } });

    expect(report.ok).toBe(false);
    expect(report.tasks).toEqual([
      { taskId: "task-a", ok: false, applied: [], failures: [], retainedTasks: ["task-a"], error: "host-unreachable" },
    ]);
  });
});