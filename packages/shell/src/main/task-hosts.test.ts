import { describe, expect, it, vi } from "vitest";
import { PerTaskHostRegistry } from "./runtime.js";
import type { HostTaskResult } from "../rpc/protocol.js";

// Seam: per-task utilityProcess Host routing in main (S3a slice).
// `registerIpc(shell/taskOp)` routes through `PerTaskHostRegistry` when
// wired: one bound Host per task folder (fork-on-first-use), reused across
// ops, keyed by taskDir so same-id tasks under different roots never share
// a process. Unknown tasks fail closed before any fork.

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
