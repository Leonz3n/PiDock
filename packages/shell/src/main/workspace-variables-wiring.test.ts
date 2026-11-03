/**
 * [Pencil T09] #144: the effective value is real, not a form echo.
 *
 * Chain under test:
 * 1. main resolves workspace + task override rows into one environment record;
 * 2. `buildHostEnv` puts it on the per-task Host fork and refuses reserved names;
 * 3. a real descendant process started with that fork environment prints it, and
 *    two tasks print different values;
 * 4. the managed `exec.run` command function (the same one the Host broker uses)
 *    executes a real `/bin/sh` that prints the Host's variable;
 * 5. the per-task registry reads the resolver exactly once per Host start, so an
 *    edit is not applied to a running Host/turn (next fork sees it).
 */
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHostEnv } from "../host/host-guards.js";
import { defaultRunCommand } from "../host/sdk-agent-tool-broker.js";
import { PerTaskHostRegistry } from "./runtime.js";
import { resolveTaskVariables, TaskVariableStore, variableEnvironment } from "./workspace-variables.js";
import type { HostTaskResult } from "../rpc/protocol.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function home() {
  const root = mkdtempSync(join(tmpdir(), "pidock-vars-wire-"));
  roots.push(root);
  return root;
}

const baseEnv = { PATH: "/usr/bin:/bin", HOME: "/home/someone", TMPDIR: "/tmp" };

function forkEnv(store: TaskVariableStore, taskId: string, workspaceRows = [
  { key: "NODE_ENV", value: "development" },
  { key: "API_BASE_URL", value: "https://api.dev.pidock.internal" },
]) {
  const effective = variableEnvironment(resolveTaskVariables(workspaceRows, store.list(taskId)).rows);
  return buildHostEnv(baseEnv, "workspace-a", { taskId, taskDir: `/tasks/${taskId}` }, "/profile", "/tasks", "posix", effective);
}

describe("variable injection into the managed Agent process", () => {
  it("puts inherited and overridden values on the Host fork env and isolates two tasks", () => {
    const store = new TaskVariableStore(home());
    store.set("task-a", "NODE_ENV", "task-a-only");
    const a = forkEnv(store, "task-a");
    const b = forkEnv(store, "task-b");
    expect(a).toMatchObject({ NODE_ENV: "task-a-only", API_BASE_URL: "https://api.dev.pidock.internal" });
    expect(b).toMatchObject({ NODE_ENV: "development", API_BASE_URL: "https://api.dev.pidock.internal" });
    expect(a["PIDOCK_TASK_ID"]).toBe("task-a");
    expect(b["PIDOCK_TASK_ID"]).toBe("task-b");
  });

  it.skipIf(process.platform === "win32")("is readable by a real descendant process started with that fork environment", () => {
    const store = new TaskVariableStore(home());
    store.set("task-a", "NODE_ENV", "task-a-only");
    const env = forkEnv(store, "task-a");
    const observed = execFileSync(process.execPath, ["-e", "console.log(JSON.stringify({node:process.env.NODE_ENV,api:process.env.API_BASE_URL,task:process.env.PIDOCK_TASK_ID}))"], { env, encoding: "utf8" });
    expect(JSON.parse(observed)).toEqual({ node: "task-a-only", api: "https://api.dev.pidock.internal", task: "task-a" });
  });

  it.skipIf(process.platform === "win32")("is printed by the real managed command boundary (exec.run's own function)", async () => {
    vi.stubEnv("PIDOCK_TEST_NODE_ENV", "task-a-only");
    vi.stubEnv("OPENAI_API_KEY", "synthetic-must-not-be-visible");
    const result = await defaultRunCommand({
      command: "printf 'node=%s key=%s' \"$PIDOCK_TEST_NODE_ENV\" \"${OPENAI_API_KEY:-absent}\"",
      cwd: home(), timeoutMs: 5_000,
    });
    expect(result.output).toBe("node=task-a-only key=absent");
    expect(result.exitCode).toBe(0);
  });

  it("refuses a reserved or credential name at the fork boundary by key, never by value", () => {
    expect(() => buildHostEnv(baseEnv, "workspace-a", undefined, undefined, undefined, "posix", { PATH: "/evil" }))
      .toThrow("host-env-invalid: PATH");
    expect(() => buildHostEnv(baseEnv, "workspace-a", undefined, undefined, undefined, "posix", { GITHUB_TOKEN: "synthetic-secret" }))
      .toThrow("host-env-invalid: GITHUB_TOKEN");
    try { buildHostEnv(baseEnv, "workspace-a", undefined, undefined, undefined, "posix", { PIDOCK_TASK_ID: "forged" }); } catch (error) {
      expect(String(error)).not.toContain("forged");
    }
  });

  it("captures variables at Host start: an edit never changes a running Host, the next fork sees it", async () => {
    const store = new TaskVariableStore(home());
    store.set("task-a", "NODE_ENV", "first");
    const captured: Array<Record<string, string> | undefined> = [];
    const result: HostTaskResult = { workspaceId: "workspace-a", taskId: "task-a", op: "task/cancel", payload: { sessionId: "main" } };
    const transport = { task: vi.fn(async () => result), onBrowserRequest: vi.fn(), onServiceTemplateRequest: vi.fn(), dispose: vi.fn() };
    const spawn = vi.fn(async (_ws: string, task: { taskId: string; taskDir: string }, env?: Record<string, string>) => {
      captured.push(env);
      const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
      return { client: transport as never, child: child as never };
    });
    const resolver = (taskId: string) => variableEnvironment(resolveTaskVariables([], store.list(taskId)).rows);
    const registry = new PerTaskHostRegistry("workspace-a", spawn, (id) => `/tasks/${id}`, undefined, undefined, resolver);
    await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel" });
    expect(captured).toEqual([{ NODE_ENV: "first" }]);

    // Change while the Host is running: the running process keeps "first" (no refork, no mutation).
    store.set("task-a", "NODE_ENV", "second");
    await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel" });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(captured[0]).toEqual({ NODE_ENV: "first" });

    // A fresh Host start (application restart / task reopen) resolves the current value.
    const restarted = new PerTaskHostRegistry("workspace-a", spawn, (id) => `/tasks/${id}`, undefined, undefined, resolver);
    await restarted.routeTaskOp({ taskId: "task-a", op: "task/cancel" });
    expect(captured[1]).toEqual({ NODE_ENV: "second" });
  });
});
