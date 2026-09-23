import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PerTaskHostRegistry, taskBrowserOriginsFromEnv } from "./runtime.js";
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

  it("never forks two Hosts for one task folder: restarts reuse the single registry entry", async () => {
    // Toolchain supplement: `root pnpm dev` starts main + Host + renderer
    // once; exit/restart disposes only this registry's Hosts and never
    // leaves a duplicate behind. The registry is the single fork point —
    // a second op for the same task reuses the entry, and `disposeAll`
    // clears it so a restart forks exactly one replacement.
    const spawns: Array<{ taskId: string; taskDir: string }> = [];
    const { registry, spawn } = registryWith(() => "/tasks/task-a", spawns, TASK_RESULT);
    await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(1);
    // Restart: dispose clears only this registry's Hosts, then the next op
    // forks exactly one replacement (no duplicate, no leak).
    registry.disposeAll();
    expect(registry.size).toBe(0);
    await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(registry.size).toBe(1);
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

  it("[PiDock 14] (#17) quitAll sends the attested quit op to every forked Host and reports blocked resources", async () => {
    const spawns: Array<{ taskId: string; taskDir: string }> = [];
    const dirs: Record<string, string> = { "task-a": "/tasks/a", "task-b": "/tasks/b" };
    const calls: { taskId: string; op: string; payload: Record<string, unknown>; origin: unknown }[] = [];
    const spawn = vi.fn(async (_workspaceId: string, task: { taskId: string; taskDir: string }) => {
      spawns.push(task);
      const transport = {
        task: vi.fn(async (params: { taskId: string; op: string; payload?: Record<string, unknown>; origin?: unknown }) => {
          calls.push({ taskId: params.taskId, op: params.op, payload: params.payload ?? {}, origin: params.origin });
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
      { taskId: "task-a", op: "task/quit", payload: { label: "应用明确退出" }, origin },
      { taskId: "task-b", op: "task/quit", payload: { label: "应用明确退出" }, origin },
    ]);
    expect(report.tasks.map((task) => task.taskId)).toEqual(["task-a", "task-b"]);
    expect(report.ok).toBe(false);
    expect(report.tasks[1]).toMatchObject({ ok: true, retainedTasks: ["task-b"] });
    // The Hosts stay forkable until the caller disposes them.
    expect(registry.size).toBe(2);
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