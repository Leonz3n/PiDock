import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PerTaskHostRegistry } from "./runtime.js";
import { createDiskTaskDirResolver, defaultTasksRoot } from "./task-resolver.js";
import type { HostTaskResult } from "../rpc/protocol.js";

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

  it("disposeAll kills every forked Host", async () => {
    const spawns: Array<{ taskId: string; taskDir: string }> = [];
    const dirs: Record<string, string> = { "task-a": "/tasks/a", "task-b": "/tasks/b" };
    const { registry } = registryWith((id) => dirs[id] ?? null, spawns, TASK_RESULT);
    await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    await registry.routeTaskOp({ taskId: "task-b", op: "task/cancel", payload: {} });
    expect(registry.size).toBe(2);
    registry.disposeAll();
    expect(registry.size).toBe(0);
  });
});
