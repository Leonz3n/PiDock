/**
 * Real-process tests for the [PiDock 10] (#15) terminal spawner.
 *
 * These spawn a REAL `/bin/sh` under node-pty through `TerminalPtyDriver` +
 * `TaskTerminalSessions`, then verify the recorded identity against `ps`, the
 * output/input/resize round trip, real process-group and observed-descendant
 * containment (a stop, a natural exit, a restart after exit), task isolation and
 * the fail-closed refusals. Two further tests drive the driver directly with a
 * real pty (the drained-operation reap); the remaining unit tests use no
 * process.
 *
 * Everything spawned here is stopped by `cleanup()`, including on failure, and
 * every recorded pid is asserted gone - the afterEach records the assertion and
 * then terminates the stray, so a containment failure fails the test instead of
 * outliving the run.
 *
 * Environment: Darwin arm64 with node-pty 1.1.0's `spawn-helper` prepared
 * (`pnpm --filter @pidock/shell prepare:pty:darwin`). On any other host the
 * real-process tests skip: the preflight only ships darwin-arm64 binaries.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { TaskTerminalRegistry, planTerminal, type TerminalPlan } from "../main/terminal-config.js";
import { workspaceRoots } from "../main/workspace-files.js";
import { inspectNodePtyPrebuild, prepareNodePtyPrebuild } from "./node-pty-preflight.js";
import { descendantPids, ptySpawnerAvailable, resolvePtyRuntime, TerminalPtyDriver, workerEntryUrl } from "./terminal-pty-driver.js";
import type { TerminalDriver } from "./terminal-execution.js";
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

/** The same poll cadence, returning the first value the probe yields. */
async function untilValue<T>(predicate: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(25);
  }
}

/**
 * Pids whose command line is exactly `sleep <marker>`: a terminal this suite
 * started with `exec sleep <marker>` is addressable even when a bug left it
 * without a recorded pid, so a failed containment can still be cleaned up
 * instead of outliving the run. The marker is a unique duration, never a path.
 */
function markerPids(marker: number): number[] {
  try {
    return execFileSync("/bin/ps", ["-eo", "pid=,args="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .filter((line) => line.trim().endsWith(`sleep ${marker}`))
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 1);
  } catch {
    return [];
  }
}

const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.cleanup();
    for (const pid of fixture.pids.filter(alive)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    // A containment failure is asserted (never hidden), and the stray is
    // terminated right after so the suite cannot outlive its own processes.
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

  constructor(tag: string, options: { stopGraceMs?: number; stopConfirmMs?: number; observeCadenceMs?: number } = {}) {
    this.taskDir = realpathSync(mkdtempSync(join(tmpdir(), `pidock-term-${tag}-`)));
    this.taskId = `task-${tag}`;
    this.registry = new TaskTerminalRegistry(this.taskId);
    const holder: { sessions?: TaskTerminalSessions } = {};
    this.driver = new TerminalPtyDriver({
      workspaceId: this.taskId,
      runtime: resolvePtyRuntime,
      onOutput: (identity, sequence, data) => holder.sessions?.ingest(identity, sequence, data),
      ...options,
    });
    this.sessions = new TaskTerminalSessions(this.registry, this.driver, () => []);
    holder.sessions = this.sessions;
    fixtures.push(this);
  }

  plan(instanceId = "term-1", program = "sh", args: string[] = []): TerminalPlan {
    return planFor(this.taskId, this.taskDir, instanceId, program, args);
  }

  /** Record every pid this fixture spawned, so the afterEach can prove it gone. */
  track(...pids: (number | undefined)[]): void {
    for (const pid of pids) if (pid !== undefined && pid > 1 && !this.pids.includes(pid)) this.pids.push(pid);
  }

  history(instanceId = "term-1"): string {
    return this.registry.history(instanceId).map((entry) => entry.line).join("\n");
  }

  async start(instanceId = "term-1", program = "sh", args: string[] = []) {
    const plan = this.plan(instanceId, program, args);
    this.registry.register(plan);
    const started = await this.sessions.start({ plan, sessionId: null });
    const instance = this.registry.get(instanceId);
    this.track(instance?.processId);
    return { plan, started, instance };
  }

  /** A second start for an instance this fixture already used: register then spawn. */
  async restart(instanceId = "term-1", program = "sh", args: string[] = []) {
    const plan = this.plan(instanceId, program, args);
    this.registry.register(plan);
    const started = await this.sessions.start({ plan, sessionId: null });
    this.track(this.registry.get(instanceId)?.processId);
    return { plan, started, instance: this.registry.get(instanceId) };
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

it("reopens an exited instance when a start records a fresh process identity", async () => {
  // Identity finding: a start that follows the instance's exit must record the
  // identity it really spawned. Skipping that left the record on the previous
  // run's `exited` state with a dead pid, so the next stop returned success
  // without signalling the live shell.
  const taskDir = realpathSync(mkdtempSync(join(tmpdir(), "pidock-term-restart-")));
  try {
    const registry = new TaskTerminalRegistry("task-restart");
    let spawned: { processId: number; processGroupId: number } | undefined;
    let spawns = 0;
    const driver: TerminalDriver = {
      spawn: async () => {
        spawns += 1;
        spawned = { processId: 4000 + spawns, processGroupId: 4000 + spawns };
        return { status: "started", process: { ...spawned } };
      },
      input: async () => {},
      resize: async () => {},
      stop: async (identity) => ({ ...identity, status: "tree-drained", exitCode: 0 }),
      snapshot: () => ({ status: "running", ...(spawned ? { process: { ...spawned } } : {}) }),
    };
    const sessions = new TaskTerminalSessions(registry, driver);
    const plan = planFor("task-restart", taskDir, "term-1", "sh");
    registry.register(plan);
    expect(await sessions.start({ plan, sessionId: null })).toMatchObject({ ok: true });
    expect(registry.get("term-1")).toMatchObject({ lifecycle: "running", processId: 4001 });
    expect(await sessions.stop("term-1", "user-request")).toMatchObject({ ok: true });
    expect(registry.get("term-1")!.lifecycle).toBe("exited");

    registry.register(plan);
    const restarted = await sessions.start({ plan, sessionId: null });
    expect(restarted).toMatchObject({ ok: true });
    expect(registry.get("term-1")).toMatchObject({ lifecycle: "running", processId: 4002, processGroupId: 4002 });
    // The reopened instance is really addressable again, and its stop is a real
    // stop rather than the idempotent success of an exited record.
    expect(await sessions.input("term-1", "echo again\r")).toMatchObject({ ok: true });
    const stopped = await sessions.stop("term-1", "user-request");
    expect(stopped).toMatchObject({ ok: true });
    expect(registry.get("term-1")!.lifecycle).toBe("exited");
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

it("stops every session at once so a slow stop cannot turn the quit deadline into a false failure", { timeout: 15_000 }, async () => {
  // Quit finding: `stopAll` awaited one terminal after another, up to
  // grace+confirm each, while the quitting Host has a single 15s deadline - four
  // running terminals could report `terminal-shutdown-unconfirmed` although
  // every one of them was still being stopped. Every stop must be in flight
  // before any of them settles (a sequential loop leaves the second pending).
  const taskDir = realpathSync(mkdtempSync(join(tmpdir(), "pidock-term-stopall-")));
  try {
    const registry = new TaskTerminalRegistry("task-stopall");
    const identities = new Map<string, { processId: number; processGroupId: number }>();
    let pid = 4100;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const inFlight: string[] = [];
    const driver: TerminalDriver = {
      spawn: async (identity) => {
        const process = { processId: (pid += 1), processGroupId: pid };
        identities.set(identity.instanceId, process);
        return { status: "started", process: { ...process } };
      },
      input: async () => {},
      resize: async () => {},
      stop: async (identity) => {
        inFlight.push(identity.instanceId);
        await gate;
        return { ...identity, status: "tree-drained", exitCode: 0 };
      },
      snapshot: (identity) => {
        const process = identities.get(identity.instanceId);
        return { status: "running", ...(process ? { process: { ...process } } : {}) };
      },
    };
    const sessions = new TaskTerminalSessions(registry, driver);
    const instanceIds = ["term-1", "term-2", "term-3", "term-4"];
    for (const instanceId of instanceIds) {
      const plan = planFor("task-stopall", taskDir, instanceId, "sh");
      registry.register(plan);
      expect(await sessions.start({ plan, sessionId: null })).toMatchObject({ ok: true });
    }
    const all = sessions.stopAll("host-quit");
    await until(() => inFlight.length === instanceIds.length, 5000, "every stop to be in flight");
    release();
    await expect(all).resolves.toBeUndefined();
    expect(registry.list().every((instance) => instance.lifecycle === "exited")).toBe(true);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

realIt("restarts an exited instance with a fresh shell and still contains it", { timeout: 30_000 }, async () => {
  const marker = 3271;
  const f = new Fixture("restart");
  try {
    const { instance } = await f.start("term-1", "sh", ["-c", `exec sleep ${marker}`]);
    const firstPid = instance!.processId!;
    expect(await f.sessions.stop("term-1", "user-request")).toMatchObject({ ok: true });
    await until(() => !alive(firstPid), 5000, "first shell to exit");

    const { started, instance: restarted } = await f.restart("term-1", "sh", ["-c", `exec sleep ${marker}`]);
    expect(started.ok).toBe(true);
    expect(restarted?.lifecycle).toBe("running");
    expect(restarted?.processId).toBeGreaterThan(1);
    expect(restarted?.processId).not.toBe(firstPid);
    expect(alive(restarted!.processId!)).toBe(true);
    expect(pgidOf(restarted!.processId!)).toBe(restarted!.processGroupId);

    const stopped = await f.sessions.stop("term-1", "user-request");
    expect(stopped).toMatchObject({ ok: true });
    await until(() => !alive(restarted!.processId!), 5000, "restarted shell to stop");
  } finally {
    // The restarted run must be terminated even when the assertions above fail
    // before its stop: the marker names exactly this suite's own sleeps.
    for (const pid of markerPids(marker)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    await until(() => markerPids(marker).length === 0, 5000, "marker processes to end");
  }
});

realIt("forgets a drained operation so the same terminal identity spawns fresh again", { timeout: 30_000 }, async () => {
  // Reap finding: a drained operation must leave the driver's bounded map. When
  // it is retained, the stale (already fenced) operation is what a later start
  // for that identity resolves against, and eight retained lifecycles make the
  // ninth real start fail as `terminal-not-started` with a runtime/preflight
  // blame that is not the real reason.
  const marker = 3273;
  const f = new Fixture("reap", { stopGraceMs: 250, stopConfirmMs: 250 });
  const plan = f.plan("term-1");
  const launch = {
    program: resolveProgram(plan.program, plan.env),
    args: [...plan.args],
    cwd: plan.cwd,
    env: { ...plan.env },
    envRevision: "fixture-reap-1",
    cols: plan.cols,
    rows: plan.rows,
  };
  const identity = { taskId: f.taskId, sessionId: "human-ui", instanceId: "term-1", generation: 1 };
  const receipts: string[] = [];
  try {
    const first = await f.driver.spawn(identity, launch, (receipt) => receipts.push(receipt.status));
    expect(first.status).toBe("started");
    f.track(first.process?.processId);
    // A HUP-proof child in the recorded group makes the natural-exit settlement
    // take the reclaim path (`set +m` keeps it in that group), which is the
    // window in which the helper has already exited before the operation is
    // reaped.
    await f.driver.input(identity, "set +m\r");
    await f.driver.input(identity, `sh -c 'trap "" HUP; exec sleep ${marker}' & echo BG=$!\r`);
    await f.driver.input(identity, "exit\r");
    await until(() => receipts.includes("tree-drained"), 15_000, "natural-exit receipt");

    const second = await f.driver.spawn(identity, launch, () => {});
    expect(second.status).toBe("started");
    f.track(second.process?.processId);
    expect(second.process?.processId).not.toBe(first.process?.processId);
    expect(alive(second.process!.processId)).toBe(true);
    expect((await f.driver.stop(identity)).status).toBe("tree-drained");
    await until(() => !alive(second.process!.processId), 5000, "respawned shell to stop");
  } finally {
    for (const pid of markerPids(marker)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    await until(() => markerPids(marker).length === 0, 5000, "marker processes to end");
  }
});

realIt("contains a job-control descendant observed before the shell exits on its own", { timeout: 30_000 }, async () => {
  // Containment finding: a natural exit must not be reported while a descendant
  // that left the shell's own process group is still alive. The descendant is
  // reclaimable only from the observation the driver made while the root was
  // alive, so this asserts the real reclaim and not a bookkeeping receipt.
  const marker = 3274;
  const f = new Fixture("natural-job", { stopGraceMs: 250, stopConfirmMs: 250 });
  const { instance } = await f.start();
  const command = `sh -c 'trap "" HUP; exec sleep ${marker}' & echo BG=$!`;
  try {
    await f.sessions.input("term-1", `${command}\r`);
    await until(() => /BG=(\d+)/.test(f.history()), 8000, "background job pid");
    const background = Number(/BG=(\d+)/.exec(f.history())![1]);
    f.track(background);
    await until(() => pgidOf(background) === background, 3000, "job-controlled group");
    expect(background).not.toBe(instance!.processGroupId);

    // The typed `exit` is itself an observation point: the job is recorded while
    // the shell is still alive, and the natural exit must then contain it.
    await f.sessions.input("term-1", "exit\r");
    await until(() => f.registry.get("term-1")?.lifecycle === "exited", 15_000, "natural-exit receipt");
    await until(() => !alive(background), 8000, "observed descendant to be reclaimed");
    expect(pgidOf(background)).toBeNull();
    expect(markerPids(marker)).toEqual([]);
  } finally {
    await f.sessions.stopAll("test-cleanup").catch(() => undefined);
    for (const pid of [...f.pids.filter(alive), ...markerPids(marker)]) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    await until(() => markerPids(marker).length === 0, 5000, "marker processes to end");
  }
});

realIt("records the descendants of a terminal that exits without any input", { timeout: 30_000 }, async () => {
  // The observer cadence is the only handle on an unattended exit: this terminal
  // starts a job in its own process group and exits on its own, with no
  // interaction that could record it. The cadence is injected (50ms) so the test
  // does not depend on the production cadence.
  const marker = 3275;
  const f = new Fixture("natural-cadence", { stopGraceMs: 250, stopConfirmMs: 250, observeCadenceMs: 50 });
  mkdirSync(join(f.taskDir, "work"), { recursive: true });
  const script = join(f.taskDir, "work", "unattended.sh");
  writeFileSync(script, `#!/bin/sh\nset -m\nsh -c 'trap "" HUP; exec sleep ${marker}' &\nsleep 1\nexit\n`, { mode: 0o755 });
  const { instance } = await f.start("term-1", script);
  try {
    const job = await untilValue(() => markerPids(marker)[0], 8000, "job-controlled descendant");
    f.track(job);
    expect(job).not.toBe(instance!.processGroupId);
    expect(pgidOf(job)).toBe(job);

    await until(() => f.registry.get("term-1")?.lifecycle === "exited", 15_000, "natural-exit receipt");
    await until(() => !alive(job), 8000, "recorded descendant to be reclaimed");
    expect(markerPids(marker)).toEqual([]);
  } finally {
    await f.sessions.stopAll("test-cleanup").catch(() => undefined);
    for (const pid of [...f.pids.filter(alive), ...markerPids(marker)]) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    await until(() => markerPids(marker).length === 0, 5000, "marker processes to end");
  }
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

it.each([
  ["darwin", "arm64", true],
  ["darwin", "x64", false],
  ["linux", "arm64", false],
  ["win32", "x64", false],
] as const)("reports real PTY spawn availability on %s/%s as %s", (platform, arch, expected) => {
  // The reported capability is the worker's own platform gate: a Host that can
  // never fork the helper must report `spawnImplemented: false` so the renderer
  // keeps its residual warning instead of losing it while every start fails.
  vi.stubGlobal("process", { ...process, platform, arch });
  try {
    expect(ptySpawnerAvailable()).toBe(expected);
  } finally {
    vi.unstubAllGlobals();
  }
});
