/**
 * [Pencil T09] #144: variable operations cross one main-owned, exact-key IPC.
 * The page names a workspace/task, one key and one value; it never sends a
 * whole tracked-file path, another task's membership or a registry document.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performProjectOperation, projectFailureMessage } from "./project-ipc.js";
import { ProjectRegistry } from "./project-registry.js";
import { TaskRootIndex } from "./task-root-index.js";
import { TaskVariableStore } from "./workspace-variables.js";

const homes: string[] = [];
const TASK = "task-abcdef12";
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pidock-vars-ipc-"));
  homes.push(home);
  const data = join(home, "data");
  const defaultRoot = join(home, "default");
  mkdirSync(defaultRoot);
  const registry = new ProjectRegistry(data);
  const roots = new TaskRootIndex(data, defaultRoot);
  const dir = join(defaultRoot, TASK);
  mkdirSync(dir);
  writeFileSync(join(dir, "task.json"), JSON.stringify({ taskId: TASK, name: "变量任务", dirId: TASK,
    root: defaultRoot, taskDir: dir, branch: "task/main", remoteBranch: "main", baseCommit: "abc123", repos: [],
    createdAt: "2026-09-22T10:00:00Z", updatedAt: "2026-09-22T10:00:00Z" }));
  const variables = new TaskVariableStore(data);
  return { data, defaultRoot, registry, roots, variables };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

async function workspace(f: ReturnType<typeof fixture>) {
  const project = await f.registry.create({ name: "PiDock", description: "", repositories: [], directories: [],
    environment: [{ key: "NODE_ENV", value: "development" }] });
  await f.registry.claim(TASK, project.id, f.roots);
  return project;
}

describe("workspace/task variable IPC", () => {
  it("edits workspace variables by exact key and refuses reserved or credential names by key", async () => {
    const f = fixture();
    const project = await workspace(f);
    expect(await performProjectOperation(f.registry, { op: "variables", projectId: project.id }, f.roots, f.variables))
      .toEqual({ workspace: [{ key: "NODE_ENV", value: "development" }] });

    const added = await performProjectOperation(f.registry, { op: "setVariable", projectId: project.id, key: "DEBUG", value: "pidock:*" }, f.roots, f.variables);
    expect(added).toEqual({ workspace: [{ key: "NODE_ENV", value: "development" }, { key: "DEBUG", value: "pidock:*" }] });

    for (const key of ["PATH", "HOME", "PIDOCK_TASK_ID", "OPENAI_API_KEY", "GITHUB_TOKEN"]) {
      const failure = await performProjectOperation(f.registry, { op: "setVariable", projectId: project.id, key, value: "x" }, f.roots, f.variables)
        .then(() => null, (error: unknown) => error);
      expect(failure).not.toBeNull();
      expect(projectFailureMessage(failure)).toMatch(/variable-(reserved|credential)/);
    }
    expect(f.registry.get(project.id)?.environment).toEqual([{ key: "NODE_ENV", value: "development" }, { key: "DEBUG", value: "pidock:*" }]);

    await expect(performProjectOperation(f.registry, { op: "setVariable", projectId: project.id, key: "X", value: "v", extra: true }, f.roots, f.variables))
      .rejects.toThrow(/invalid project setVariable payload/);
    await expect(performProjectOperation(f.registry, { op: "setVariable", projectId: "../escape", key: "X", value: "v" }, f.roots, f.variables))
      .rejects.toThrow();
    const removed = await performProjectOperation(f.registry, { op: "removeVariable", projectId: project.id, key: "DEBUG" }, f.roots, f.variables);
    expect(removed).toEqual({ removed: true, workspace: [{ key: "NODE_ENV", value: "development" }] });
  });

  it("shows inherited, overridden and restored values with provenance for one associated task", async () => {
    const f = fixture();
    const project = await workspace(f);
    const inherited = await performProjectOperation(f.registry, { op: "taskVariables", taskId: TASK }, f.roots, f.variables) as {
      effective: Array<{ key: string; value: string; scope: string; inheritedValue: string | null }>; environment: Record<string, string>;
    };
    expect(inherited.effective).toEqual([{ key: "NODE_ENV", value: "development", scope: "workspace", inheritedValue: null }]);

    const overridden = await performProjectOperation(f.registry, { op: "setTaskVariable", taskId: TASK, key: "NODE_ENV", value: "test" }, f.roots, f.variables) as {
      overrides: unknown[]; effective: Array<{ key: string; value: string; scope: string; inheritedValue: string | null }>; environment: Record<string, string>;
    };
    expect(overridden.overrides).toEqual([{ key: "NODE_ENV", value: "test" }]);
    expect(overridden.effective).toEqual([{ key: "NODE_ENV", value: "test", scope: "task", inheritedValue: "development" }]);
    expect(overridden.environment).toEqual({ NODE_ENV: "test" });

    // A second task still inherits the workspace value: the override is not global.
    const other = await f.registry.create({ name: "Other", description: "", repositories: [], directories: [], environment: [{ key: "NODE_ENV", value: "development" }] });
    const otherDir = join(f.defaultRoot, "task-11112222");
    mkdirSync(otherDir);
    writeFileSync(join(otherDir, "task.json"), JSON.stringify({ taskId: "task-11112222", name: "另一个", dirId: "task-11112222",
      root: f.defaultRoot, taskDir: otherDir, branch: "task/main", remoteBranch: "main", baseCommit: "abc123",
      repos: [], createdAt: "2026-09-22T10:00:00Z", updatedAt: "2026-09-22T10:00:00Z" }));
    await f.registry.claim("task-11112222", other.id, f.roots);
    const isolated = await performProjectOperation(f.registry, { op: "taskVariables", taskId: "task-11112222" }, f.roots, f.variables) as { environment: Record<string, string> };
    expect(isolated.environment).toEqual({ NODE_ENV: "development" });

    const restored = await performProjectOperation(f.registry, { op: "removeTaskVariable", taskId: TASK, key: "NODE_ENV" }, f.roots, f.variables) as {
      removed: boolean; overrides: unknown[]; effective: Array<{ value: string; scope: string }>;
    };
    expect(restored).toMatchObject({ removed: true, overrides: [] });
    expect(restored.effective).toEqual([{ key: "NODE_ENV", value: "development", scope: "workspace", inheritedValue: null }]);
    expect(f.variables.list(TASK)).toEqual([]);

    // Restart: overrides survive a new store/registry pair.
    await performProjectOperation(f.registry, { op: "setTaskVariable", taskId: TASK, key: "DEBUG", value: "on" }, f.roots, f.variables);
    const reopened = await performProjectOperation(new ProjectRegistry(f.data), { op: "taskVariables", taskId: TASK },
      new TaskRootIndex(f.data, f.defaultRoot), new TaskVariableStore(f.data)) as { overrides: unknown[] };
    expect(reopened.overrides).toEqual([{ key: "DEBUG", value: "on" }]);
  });

  it("refuses task overrides for an unassociated task and never accepts a foreign task id", async () => {
    const f = fixture();
    await workspace(f);
    await expect(performProjectOperation(f.registry, { op: "setTaskVariable", taskId: "task-99999999", key: "X", value: "v" }, f.roots, f.variables))
      .rejects.toThrow(/task-variable-task-unassociated/);
    expect(projectFailureMessage(new Error("task-variable-task-unassociated"))).toContain("未归属工作空间");
    await expect(performProjectOperation(f.registry, { op: "taskVariables", taskId: TASK }, undefined, f.variables))
      .rejects.toThrow(/unavailable/);
    await expect(performProjectOperation(f.registry, { op: "taskVariables", taskId: TASK }, f.roots, undefined))
      .rejects.toThrow(/unavailable/);
  });
});
