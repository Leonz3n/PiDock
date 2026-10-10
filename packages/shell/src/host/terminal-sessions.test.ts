/**
 * Real-process tests for the [PiDock 10] (#15) terminal spawner.
 *
 * These spawn a REAL `/bin/sh` under node-pty through `TerminalPtyDriver` +
 * `TaskTerminalSessions`, then verify the recorded identity against `ps`, the
 * output/input/resize round trip, real process-group containment, task
 * isolation and the fail-closed refusals. Everything spawned here is stopped by
 * `cleanup()`, including on failure, and every recorded pid is asserted gone.
 *
 * Environment: Darwin arm64 with node-pty 1.1.0's `spawn-helper` prepared
 * (`pnpm --filter @pidock/shell prepare:pty:darwin`). On any other host the
 * suite skips: the preflight only ships darwin-arm64 binaries.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { TaskTerminalRegistry, planTerminal, type TerminalPlan } from "../main/terminal-config.js";
import { workspaceRoots } from "../main/workspace-files.js";
import { inspectNodePtyPrebuild, prepareNodePtyPrebuild } from "./node-pty-preflight.js";
import { descendantPids, resolvePtyRuntime, TerminalPtyDriver, workerEntryUrl } from "./terminal-pty-driver.js";
import { resolveProgram, TaskTerminalSessions } from "./terminal-sessions.js";

const supported = process.platform === "darwin" && process.arch === "arm64" && existsSync(fileURLToPath(workerEntryUrl())) && (() => {
  try {
    // Explicit dev-environment preparation of the pinned helper; never an
    // implicit worker fallback. The preflight re-verifies hash/size/mode after.
    return inspectNodePtyPrebuild().ready || prepareNodePtyPrebuild().after.ready;
  } catch {
    return false;
  }
})();
const realIt = it.skipIf(!supported);

function alive(pid: number): boolean {
  try {
    return execFileSync("/bin/ps", ["-o", "pid=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
  } catch {
    return false;
  }
}

function pgidOf(pid: number): number | null {
  try {
    const printed = execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const value = Number.parseInt(printed, 10);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

async function until(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(25);
  }
}

const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.cleanup();
    for (const pid of fixture.pids) expect(alive(pid), `stray terminal pid ${pid}`).toBe(false);
  }
});

function planFor(taskId: string, taskDir: string, instanceId: string, program: string, args: string[] = []): TerminalPlan {
  mkdirSync(join(taskDir, "work"), { recursive: true });
  const result = planTerminal({
    roots: workspaceRoots({ taskId, taskDir, repos: ["work"] }),
    taskId,
    taskDir,
    rootId: "work",
    program,
    args,
    layers: {
      repoDefaults: [
        { key: "PATH", value: "/usr/bin:/bin:/usr/sbin:/sbin", secret: false },
        { key: "TERM", value: "xterm-256color", secret: false },
      ],
      shared: [], privateEntries: [], task: [],
    },
    owner: { taskId, sessionId: null, label: "用户显式操作" },
    instanceId,
  });
  if (!result.ok) throw new Error(result.error);
  return result.plan;
}

class Fixture {
  readonly taskDir: string;
  readonly taskId: string;
  readonly registry: TaskTerminalRegistry;
  readonly driver: TerminalPtyDriver;
  readonly sessions: TaskTerminalSessions;
  readonly pids: number[] = [];

  constructor(tag: string) {
    this.taskDir = realpathSync(mkdtempSync(join(tmpdir(), `pidock-term-${tag}-`)));
    this.taskId = `task-${tag}`;
    this.registry = new TaskTerminalRegistry(this.taskId);
    const holder: { sessions?: TaskTerminalSessions } = {};
    this.driver = new TerminalPtyDriver({
      workspaceId: this.taskId,
      runtime: resolvePtyRuntime,
      onOutput: (identity, sequence, data) => holder.sessions?.ingest(identity, sequence, data),
    });
    this.sessions = new TaskTerminalSessions(this.registry, this.driver, () => []);
    holder.sessions = this.sessions;
    fixtures.push(this);
  }

  plan(instanceId = "term-1", program = "sh", args: string[] = []): TerminalPlan {
    return planFor(this.taskId, this.taskDir, instanceId, program, args);
  }

  history(instanceId = "term-1"): string {
    return this.registry.history(instanceId).map((entry) => entry.line).join("\n");
  }

  async start(instanceId = "term-1", program = "sh", args: string[] = []) {
    const plan = this.plan(instanceId, program, args);
    this.registry.register(plan);
    const started = await this.sessions.start({ plan, sessionId: null });
    const instance = this.registry.get(instanceId);
    if (instance?.processId !== undefined) this.pids.push(instance.processId);
    return { plan, started, instance };
  }

  async cleanup(): Promise<void> {
    try {
      await this.sessions.stopAll("test-cleanup");
    } catch {
      // A failed containment is reported by the pid assertions below.
    }
    rmSync(this.taskDir, { recursive: true, force: true });
  }
}

realIt("spawns a real PTY, records the pid/pgid `ps` confirms, and round-trips output/input/resize", { timeout: 30_000 }, async () => {
  const f = new Fixture("spawn");
  const { started, instance } = await f.start();
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  expect(instance?.processId).toBeGreaterThan(1);
  expect(instance?.processGroupId).toBe(instance?.processId);
  expect(pgidOf(instance!.processId!)).toBe(instance!.processGroupId);
  expect(instance?.lifecycle).toBe("running");
  expect(instance?.cwd).toBe(join(f.taskDir, "work"));

  await f.sessions.input("term-1", "echo MARK-$((6*7))\r");
  await until(() => f.history().includes("MARK-42"), 8000, "real PTY output");
  // Output reaches the state surface too (the instance record carries history).
  expect(f.registry.get("term-1")!.history.some((entry) => entry.line.includes("MARK-42"))).toBe(true);

  const resized = await f.sessions.resize("term-1", 100, 44);
  expect(resized.ok).toBe(true);
  expect(f.registry.get("term-1")!.cols).toBe(100);
  expect(f.registry.get("term-1")!.rows).toBe(44);
  await f.sessions.input("term-1", "stty size\r");
  await until(() => f.history().includes("44 100"), 8000, "real TTY resize");

  const stopped = await f.sessions.stop("term-1", "user-request");
  expect(stopped.ok).toBe(true);
  if (!stopped.ok) return;
  expect(stopped.instance.lifecycle).toBe("exited");
  expect(stopped.instance.exitReason).toBe("user-request");
  await until(() => !alive(instance!.processId!), 5000, "stopped shell to exit");
  // A stop of an already-exited instance is idempotent, never a fake restart.
  expect(await f.sessions.stop("term-1", "user-request")).toMatchObject({ ok: true });
});

realIt("contains the whole process group and the observed descendant tree before reporting tree-drained", { timeout: 30_000 }, async () => {
  // `set +m` turns off job control, so both sleeps stay in the shell's own
  // group: a single-pid kill would leave them alive and fail these assertions.
  const f = new Fixture("group");
  const { instance } = await f.start();
  await f.sessions.input("term-1", "set +m\r");
  await f.sessions.input("term-1", "sleep 300 & echo BG=$!\r");
  await until(() => /BG=(\d+)/.test(f.history()), 8000, "background pid");
  const background = Number(/BG=(\d+)/.exec(f.history())![1]);
  expect(background).toBeGreaterThan(1);
  expect(pgidOf(background)).toBe(instance!.processGroupId);
  expect(alive(background)).toBe(true);
  // A foreground child in the same group too, so the group signal must reach it.
  await f.sessions.input("term-1", "sleep 300\r");

  const stopped = await f.sessions.stop("term-1", "user-request");
  expect(stopped.ok).toBe(true);
  if (!stopped.ok) return;
  expect(stopped.instance.lifecycle).toBe("exited");
  await until(() => !alive(instance!.processId!) && !alive(background), 8000, "whole group to drain");
  expect(pgidOf(instance!.processId!)).toBeNull();
});

realIt("reclaims the group when the shell exits on its own with a HUP-proof child still alive", { timeout: 30_000 }, async () => {
  // No stop call in this test: the natural-exit path must not report an exit
  // while a member of its own group is still alive.
  const f = new Fixture("natural");
  const { instance } = await f.start();
  await f.sessions.input("term-1", "set +m\r");
  await f.sessions.input("term-1", "sh -c 'trap \"\" HUP; sleep 300' & echo BG=$!\r");
  await until(() => /BG=(\d+)/.test(f.history()), 8000, "HUP-proof background pid");
  const background = Number(/BG=(\d+)/.exec(f.history())![1]);
  expect(background).toBeGreaterThan(1);
  expect(pgidOf(background)).toBe(instance!.processGroupId);

  await f.sessions.input("term-1", "exit\r");
  await until(() => f.registry.get("term-1")?.lifecycle === "exited", 15_000, "natural-exit receipt");
  expect(f.registry.get("term-1")?.exitReason).toBe("exited");
  await until(() => !alive(background), 8000, "HUP-proof child to be reclaimed");
  expect(pgidOf(background)).toBeNull();
});

realIt("reclaims a job-controlled descendant that left the shell's process group", { timeout: 30_000 }, async () => {
  // An interactive shell gives each job its own group, so `-pgid` alone leaves
  // the background job alive: this is the descendant-reclaim assertion.
  const f = new Fixture("descendant");
  const { instance } = await f.start();
  await f.sessions.input("term-1", "sleep 300 & echo BG=$!\r");
  await until(() => /BG=(\d+)/.test(f.history()), 8000, "background job pid");
  const background = Number(/BG=(\d+)/.exec(f.history())![1]);
  await until(() => pgidOf(background) !== null, 3000, "background job to start");
  expect(pgidOf(background)).toBe(background);
  expect(pgidOf(background)).not.toBe(instance!.processGroupId);

  const stopped = await f.sessions.stop("term-1", "user-request");
  expect(stopped.ok).toBe(true);
  await until(() => !alive(background), 8000, "reclaimed descendant");
});

realIt("stops only its own task's terminal: the other task keeps running", { timeout: 30_000 }, async () => {
  const a = new Fixture("iso-a"), b = new Fixture("iso-b");
  await a.start();
  await b.start();
  expect(await a.sessions.stop("term-1", "user-request")).toMatchObject({ ok: true });
  expect(a.registry.get("term-1")!.lifecycle).toBe("exited");
  expect(b.registry.get("term-1")!.lifecycle).toBe("running");
  await b.sessions.input("term-1", "echo B-ALIVE\r");
  await until(() => b.history().includes("B-ALIVE"), 8000, "second task's shell to answer");
  expect(await b.sessions.stop("term-1", "user-request")).toMatchObject({ ok: true });
});

realIt("fails closed on a missing or mismatching recorded identity without signalling", { timeout: 30_000 }, async () => {
  const f = new Fixture("identity");
  // Omitted identity: a registered but never-started instance refuses to stop.
  f.registry.register(f.plan("term-omit"));
  expect(await f.sessions.stop("term-omit", "user-request")).toMatchObject({ ok: false, error: expect.stringContaining("unknown-process") });

  const { instance } = await f.start();
  const realPid = instance!.processId!;
  try {
    // Corrupt identity: the record names a pid this Host's live session did not
    // record, so no signal may be sent and the real shell must survive.
    f.registry.markProcess("term-1", { processId: realPid + 1, processGroupId: realPid + 1 });
    expect(await f.sessions.stop("term-1", "user-request")).toMatchObject({ ok: false, error: expect.stringContaining("不一致") });
    expect(alive(realPid)).toBe(true);
    expect(f.registry.get("term-1")!.lifecycle).toBe("running");
  } finally {
    // Restore the recorded identity so the intended leak is cleaned up; the
    // refusal above was the identity check, not a missing stop path.
    f.registry.markProcess("term-1", { processId: realPid, processGroupId: instance!.processGroupId! });
  }
  expect(await f.sessions.stop("term-1", "user-request")).toMatchObject({ ok: true });
  await until(() => !alive(realPid), 5000, "restored stop");
});

it("derives the descendant set from one process-table snapshot", () => {
  const table = [
    { pid: 10, ppid: 1, pgid: 10 },
    { pid: 11, ppid: 10, pgid: 11 },
    { pid: 12, ppid: 11, pgid: 11 },
    { pid: 13, ppid: 1, pgid: 13 },
  ];
  expect(descendantPids(table, 10)).toEqual([11, 12]);
  expect(descendantPids(table, 13)).toEqual([]);
  expect(descendantPids(table, 999)).toEqual([]);
});

it("resolves a bare planned program against the launch PATH without rewriting the plan", () => {
  expect(resolveProgram("/bin/sh", {})).toBe("/bin/sh");
  expect(resolveProgram("sh", { PATH: "/usr/bin:/bin" })).toBe("/bin/sh");
  expect(resolveProgram("definitely-not-a-planned-program", { PATH: "/bin" })).toBe("definitely-not-a-planned-program");
});
