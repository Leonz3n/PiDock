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
 * Environment: two real-process gates. The POSIX group-ownership suite
 * (`realIt`) needs Darwin arm64 with node-pty 1.1.0's `spawn-helper` prepared
 * (`pnpm --filter @pidock/shell prepare:pty:darwin`); its `descendantPids` path
 * reads a POSIX process table, so it skips everywhere else - the `supported`
 * note below says why it stays POSIX-only even though the product now admits
 * win32-x64. The win32 stop/reap suite (`win32RealIt`) runs where
 * `readWin32ProcessTable` works and the pinned ConPTY prebuild verifies
 * (`inspectNodePtyPrebuild().ready`), i.e. on a win32-x64 host - those tests
 * drive a REAL ConPTY terminal, not a mock.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { MAX_TERMINAL_INSTANCES, TaskTerminalRegistry, planTerminal, type TerminalPlan } from "../main/terminal-config.js";
import { workspaceRoots } from "../main/workspace-files.js";
import { inspectNodePtyPrebuild, prepareNodePtyPrebuild } from "./node-pty-preflight.js";
import { MAX_PTY_ENVELOPE_BYTES } from "./node-pty-protocol.js";
import { memoryTaskStore } from "./task-host.js";
import { descendantPids, PTY_INPUT_BUDGET_ERROR, ptyProcessGroupOwnershipAvailable, ptySpawnerAvailable, resolvePtyRuntime, TerminalPtyDriver, workerEntryUrl, type PtyHelper } from "./terminal-pty-driver.js";
import { readWin32ProcessTable, win32ProcessAlive } from "./win32-process-probe.js";
import { TaskWorkspaceFiles } from "./workspace-files.js";
import type { ProcessTableRow } from "./service-ownership.js";
import type { TerminalDriver, TerminalDriverReceipt, TerminalLaunch } from "./terminal-execution.js";
import { resolveProgram, TaskTerminalSessions } from "./terminal-sessions.js";

// Stays POSIX-gated although the product now admits win32-x64: this suite's descendantPids path needs a POSIX process table (recorded coverage gap, not solved here).
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

/**
 * The win32 real-process gate: this host, the helper-handle stop path, and the
 * pinned ConPTY prebuild (`ready`). win32-x64 is admitted for STARTING a real
 * terminal (#55), so the win32 stop/reap paths are driven against a REAL ConPTY
 * terminal here instead of being recorded as unobserved.
 */
const win32HelperStop = process.platform === "win32";
const win32It = it.skipIf(!win32HelperStop);
const win32RealIt = it.skipIf(!win32HelperStop || !(() => {
  try {
    return existsSync(fileURLToPath(workerEntryUrl())) && inspectNodePtyPrebuild().ready;
  } catch {
    return false;
  }
})());

/**
 * POSIX process-group ownership, named by the production predicate so the tests
 * branch on the same spelling the driver does. The group tests below assert what
 * this Host really records and what `stop` really contains, so where the platform
 * has no group to read (`readProcessPgid` returns null on win32 by design) or to
 * signal (`kill(-pgid)` has no equivalent) each one branches by name, asserts the
 * degradation the driver really reports (pid recorded without a group, `stop`
 * `unknown`) and records its POSIX assertion as UNOBSERVED on win32 - never as a
 * pass, and never by deleting the assertion.
 */
const groupOwnership = ptyProcessGroupOwnershipAvailable();

/** The identity the spawner records on this platform: the pid always, the group
 * only where the platform exposes one (see `groupOwnership`). */
function recordedIdentity(pid: number): { processId: number; processGroupId?: number } {
  return groupOwnership ? { processId: pid, processGroupId: pid } : { processId: pid };
}

/**
 * Whether `pid` currently names a process, on the platform running this suite.
 * POSIX reads it from `ps`; win32 has no `/bin/ps`, so the OS existence probe is
 * used there (`win32ProcessAlive`, the same spelling the driver uses) - which is
 * what makes the win32 real tests' cleanup assertion real rather than vacuous.
 */
function alive(pid: number): boolean {
  if (process.platform === "win32") return win32ProcessAlive(pid);
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

function ppidOf(pid: number): number | null {
  try {
    const printed = execFileSync("/bin/ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const value = Number.parseInt(printed, 10);
    return Number.isInteger(value) ? value : null;
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

/**
 * The `node-pty-worker` helpers this test process currently hosts, read from the
 * OS. A helper is a `node.exe` the Host forks itself, so by the parent link it is
 * a direct child of this process; a leaked helper keeps its pid in this list
 * after the terminal it belonged to is stopped. The query's own PowerShell is not
 * a `node.exe` child, so it never appears here.
 */
function win32HelperPids(): number[] {
  const printed = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid} AND Name='node.exe'" | ForEach-Object { $_.ProcessId }) -join ','`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return printed.trim().split(",").filter(Boolean).map(Number).filter(Number.isInteger).sort((left, right) => left - right);
}

/**
 * The helpers a test's own terminal forked: the `node.exe` children that appeared
 * since its baseline. Keying the leak assertion on the delta - and on that one
 * pid afterwards - keeps it about THIS terminal instead of every child the
 * worker process happens to hold while the whole suite runs in parallel.
 */
function forkedHelperPids(baseline: readonly number[]): number[] {
  return win32HelperPids().filter((pid) => !baseline.includes(pid));
}

/** A System32 executable path, so a win32 launch never has to resolve a bare name. */
function win32System32(name: string): string {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);
}

/**
 * A real win32 launch: `ComSpec` plus this host's own environment, because the
 * POSIX `sh` the darwin real tests drive does not exist here. `envRevision` is a
 * fixture tag - the pty is driven directly, so nothing else binds it.
 */
function win32Launch(args: string[]): TerminalLaunch {
  return {
    program: process.env.ComSpec ?? win32System32("cmd.exe"),
    args,
    cwd: normalize(tmpdir()),
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    envRevision: "fixture-win32",
    cols: 80,
    rows: 24,
  };
}

/**
 * The forked-helper stand-in for the protocol tests that need no real pty: the
 * test drives every reply itself, so no binary is ever forked.
 */
class DriverWorker extends EventEmitter {
  readonly requests: Record<string, unknown>[] = [];
  send(message: Record<string, unknown>, callback: (error: Error | null) => void): boolean {
    this.requests.push(message);
    callback(null);
    return true;
  }
  /** Answer the last request with a driver reply carrying the same envelope. */
  reply(fields: Record<string, unknown>, request = this.requests.at(-1)!): void {
    this.emit("message", {
      workspaceId: request["workspaceId"], identity: request["identity"], operationId: request["operationId"],
      kind: "reply", requestId: request["requestId"], status: "started", ...fields,
    });
  }
}

/**
 * The win32 stop/reap unit seam: a `DriverWorker` that also carries the
 * Host-owned handle. `kill` terminates the helper the way the real
 * `ChildProcess` does - the exit is reported back to the driver - and the
 * injected tree probe lets a test decide whether the tree really died with it.
 */
class HelperHandle extends DriverWorker {
  killed = false;
  constructor(private readonly onKill: () => void = () => {}) { super(); }
  kill(): void {
    this.killed = true;
    this.onKill();
    this.emit("exit", 0, null);
  }
}

/**
 * A real process that leads its own process group, so the driver's `pgid === pid`
 * identity check accepts it without a real pty. The caller always kills it.
 * `process.execPath` runs the same long-lived child on either platform; a
 * `/bin/sleep` helper only exists on POSIX.
 */
function detachedGroupLeader(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { detached: true, stdio: "ignore" });
  child.unref();
  return child;
}

function killPid(pid: number | undefined): void {
  if (pid === undefined || pid <= 1) return;
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

/** A hand-built launch for driver-level tests: absolute, normalized and bounded.
 * The cwd is the host's temp directory because the protocol rejects a
 * non-normalized absolute path and `/tmp` is not normalized on win32. */
const unitLaunch: TerminalLaunch = { program: "/bin/sh", args: [], cwd: normalize(tmpdir()), env: {}, envRevision: "fixture-unit", cols: 80, rows: 24 };
const unitIdentity = { taskId: "task-unit", sessionId: "human-ui", instanceId: "term-1", generation: 1 };

/** Real directories holding the exact file names a `resolveProgram` case probes
 * for: the resolve only ever stats a candidate, so existence and the exact
 * spelling are the whole fixture. */
const programDirs: string[] = [];

const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const dir of programDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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

  constructor(
    tag: string,
    options: {
      stopGraceMs?: number;
      stopConfirmMs?: number;
      observeCadenceMs?: number;
      /** Injected OS snapshot, so the fail-closed no-snapshot path is testable. */
      processTable?: () => ProcessTableRow[] | null;
      /** Injected forked helper, so a protocol test never forks a real binary. */
      spawnWorker?: () => PtyHelper;
    } = {},
  ) {
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

  /** The exact launch the driver dispatches for one plan, for driver-level tests. */
  launch(instanceId = "term-1", revision = "fixture-unit", program = "sh", args: string[] = []): TerminalLaunch {
    const plan = this.plan(instanceId, program, args);
    return {
      program: resolveProgram(plan.program, plan.env),
      args: [...plan.args],
      cwd: plan.cwd,
      env: { ...plan.env },
      envRevision: revision,
      cols: plan.cols,
      rows: plan.rows,
    };
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
    // The terminal's launch cwd is `<taskDir>/work`, and the pty the driver
    // starts with it (helper forked with that cwd, `terminal-pty-driver.ts`) can
    // still hold the directory for a few tens of milliseconds after the stop
    // verified the tree gone - measured EPERM on a `tree-drained` stop of the
    // session-layer case, clearing 66 ms later. The delete retries that short
    // window only: a process that really leaked keeps the handle, so the delete
    // still throws after the last retry and the stray-pid assertions stay real.
    rmSync(this.taskDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

it("hands the driver a canonical launch cwd while the plan keeps its own spelling", async () => {
  // A workspace root is joined as `${taskDir}/${name}`, so the plan's cwd is the
  // platform's display spelling and on win32 mixes `\` and `/`. The driver's
  // launch contract is a canonical absolute path (`normalize(cwd) === cwd` in
  // `parsePtyRequest`), so a start canonicalizes ONLY the value it hands the
  // driver and never rewrites the plan or the registered record.
  const taskDir = realpathSync(mkdtempSync(join(tmpdir(), "pidock-term-launch-cwd-")));
  try {
    const plan = planFor("task-launch-cwd", taskDir, "term-1", "sh");
    let delivered: TerminalLaunch | undefined;
    const driver: TerminalDriver = {
      spawn: async (_identity, launch) => { delivered = launch; return { status: "started", process: { processId: 4500, processGroupId: 4500 } }; },
      input: async () => {}, resize: async () => {},
      stop: async (identity) => ({ ...identity, status: "tree-drained" }),
      snapshot: () => ({ status: "running", process: { processId: 4500, processGroupId: 4500 } }),
    };
    const registry = new TaskTerminalRegistry("task-launch-cwd");
    const sessions = new TaskTerminalSessions(registry, driver);
    registry.register(plan);
    expect(await sessions.start({ plan, sessionId: null })).toMatchObject({ ok: true });
    expect(delivered!.cwd).toBe(normalize(plan.cwd));
    expect(plan.cwd).toBe(`${taskDir.replace(/[\\/]+$/, "")}/work`);
    expect(registry.get("term-1")!.cwd).toBe(plan.cwd);
    if (process.platform === "win32") {
      // The mixed-separator plan path is exactly what the launch contract would
      // refuse, and the canonical form differs from it only in separators.
      expect(normalize(plan.cwd)).not.toBe(plan.cwd);
      expect(normalize(plan.cwd)).toBe(plan.cwd.replace(/\//g, "\\"));
    } else {
      // POSIX no-op, proven rather than argued: `joinRoot`'s path is already
      // canonical - no `..`, no duplicate separator and no `\` to normalize - so
      // the cwd handed to the driver is byte-identical to `plan.cwd`.
      expect(normalize(plan.cwd)).toBe(plan.cwd);
      expect(delivered!.cwd).toBe(plan.cwd);
    }
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
  // The cadence is the driver's maximum so the only observations in this test are
  // the explicit control-request ones below (each `input` snapshots before it
  // dispatches). That is what makes this exit deterministically NOT covered: the
  // last dispatched request is the newest evidence. With a live cadence a tick
  // landing between the `exit` dispatch and the pty exit event would cover it and
  // this receipt would flake to `tree-drained` under load.
  const f = new Fixture("reap", { stopGraceMs: 250, stopConfirmMs: 250, observeCadenceMs: 30_000 });
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
    // The `exit` request is dispatched after the last observation of the live
    // root, so that final window is not covered by the evidence: the accurate
    // receipt for this natural exit is `root-exited` (the root is gone with the
    // code it reported and every recorded identity is gone - but a descendant
    // that request could have created is explicitly not denied). It must never
    // be reported as `tree-drained`.
    await until(() => receipts.includes("root-exited"), 15_000, "natural-exit receipt");
    expect(receipts).not.toContain("tree-drained");

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
  const row = (pid: number, ppid: number, pgid: number) => ({ pid, ppid, pgid, tty: "??", state: "S" });
  const table = [row(10, 1, 10), row(11, 10, 11), row(12, 11, 11), row(13, 1, 13)];
  expect(descendantPids(table, 10)).toEqual([11, 12]);
  expect(descendantPids(table, 13)).toEqual([]);
  expect(descendantPids(table, 999)).toEqual([]);
});

it("refuses a descendant whose creation time says it predates the pid its ppid names", () => {
  // #68's measured shape: our fresh root is handed a pid a long-dead process used
  // to own, so the OS's never-rewritten `ppid` hangs that dead owner's whole
  // still-living family (created 18 h earlier) off our root. Creation time is the
  // evidence that refuses it, and a real child created after the root stays.
  const root = 900, foreign = 700, foreignChild = 800, real = 950, realChild = 960, foreignGrandchild = 770;
  const measured = [
    { pid: root, ppid: 8, createdAt: 3_600_000 },
    { pid: foreign, ppid: root, createdAt: 1_000 },
    { pid: foreignChild, ppid: foreign, createdAt: 1_100 },
    { pid: real, ppid: root, createdAt: 3_600_500 },
  ];
  expect(descendantPids(measured, root)).toEqual([real]);
  // A refused candidate takes its own descendants with it, a kept one keeps its own.
  const nested = [...measured, { pid: realChild, ppid: real, createdAt: 3_601_000 }, { pid: foreignGrandchild, ppid: foreignChild, createdAt: 1_200 }];
  expect(descendantPids(nested, root)).toEqual([real, realChild]);
  // A tie is not evidence: a child dated in the same millisecond as its parent stays.
  const tied = [{ pid: root, ppid: 8, createdAt: 3_600_000 }, { pid: real, ppid: root, createdAt: 3_600_000 }];
  expect(descendantPids(tied, root)).toEqual([real]);
  // No creation-time evidence refuses nothing - the POSIX table and a win32 row the
  // OS would not date walk exactly as they did before, so no real descendant can
  // be hidden by this rule.
  expect(descendantPids([{ pid: root, ppid: 8 }, { pid: foreign, ppid: root }, { pid: foreignChild, ppid: foreign }, { pid: real, ppid: root }], root))
    .toEqual([foreign, foreignChild, real]);
  // The root's own row is the first-level evidence: with the root already gone the
  // walk has none, which is what keeps an unverifiable tree at the named `unknown`.
  expect(descendantPids([{ pid: foreign, ppid: root, createdAt: 1_000 }, { pid: real, ppid: root, createdAt: 3_600_500 }], root))
    .toEqual([foreign, real]);
});

function programDir(tag: string, names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), `pidock-programs-${tag}-`));
  for (const name of names) writeFileSync(join(dir, name), "", { mode: 0o755 });
  programDirs.push(dir);
  return dir;
}

it("resolves a bare planned program against the launch PATH without rewriting the plan", () => {
  expect(resolveProgram("/bin/sh", {})).toBe("/bin/sh");
  // The launch PATH's delimiter and completion rules are the platform's own, so
  // the win32 claim is the same one - the bare name resolves to the real image
  // and the plan keeps its own name - measured on this host's Windows PATH.
  if (process.platform === "win32") {
    const resolved = resolveProgram("node", { PATH: process.env.PATH ?? "" });
    expect(resolved).not.toBe("node");
    expect(resolved.toUpperCase().endsWith("NODE.EXE")).toBe(true);
    expect(statSync(resolved).isFile()).toBe(true);
  } else {
    expect(resolveProgram("sh", { PATH: "/usr/bin:/bin" })).toBe("/bin/sh");
  }
  expect(resolveProgram("definitely-not-a-planned-program", { PATH: "/bin" })).toBe("definitely-not-a-planned-program");
});

it("completes a bare win32 planned name with its PATHEXT suffix", () => {
  const first = programDir("pathext", ["probe.COM", "probe.EXE"]);
  const second = programDir("pathext-second", ["probe.EXE"]);
  const resolved = resolveProgram("probe", { PATH: first, PATHEXT: ".COM;.EXE" }, "win32");
  // The name resolves to the absolute image carrying the first listed suffix.
  expect(resolved).toBe(join(first, "probe.COM"));
  expect(isAbsolute(resolved)).toBe(true);
  // `;` is the win32 entry delimiter and the entries keep their own order.
  expect(resolveProgram("probe", { PATH: `${first};${second}`, PATHEXT: ".EXE" }, "win32")).toBe(join(first, "probe.EXE"));
});

it("returns the planned win32 name when no candidate carries a listed suffix", () => {
  const dir = programDir("no-candidate", ["other.EXE"]);
  expect(resolveProgram("probe", { PATH: dir, PATHEXT: ".EXE" }, "win32")).toBe("probe");
  // A PATHEXT without `.EXE` completes nothing else: `.exe` is not assumed, and
  // the planned name travels on for the driver to refuse.
  expect(resolveProgram("other", { PATH: dir, PATHEXT: ".BAT;.CMD" }, "win32")).toBe("other");
});

it("completes a bare win32 name with the documented default list when PATHEXT is absent", () => {
  const dir = programDir("default-pathext", ["probe.EXE"]);
  expect(resolveProgram("probe", { PATH: dir }, "win32")).toBe(join(dir, "probe.EXE"));
  expect(resolveProgram("probe", { PATH: dir, PATHEXT: "" }, "win32")).toBe(join(dir, "probe.EXE"));
});

it("reads the win32 PATH and PATHEXT names case-insensitively", () => {
  const dir = programDir("env-spelling", ["probe.XYZ", "probe.exe"]);
  // Windows names a variable in whatever case it is spelled.
  expect(resolveProgram("probe", { Path: dir, pathext: ".XYZ" }, "win32")).toBe(join(dir, "probe.XYZ"));
  // A name that already carries a listed suffix is complete, whatever case either
  // side is spelled in, so it is not completed twice.
  expect(resolveProgram("probe.exe", { PATH: dir, PATHEXT: ".EXE" }, "win32")).toBe(join(dir, "probe.exe"));
});

it("leaves a win32 planned name that carries a separator to the launch cwd", () => {
  const dir = programDir("separator", ["probe.EXE"]);
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "sub", "probe.EXE"), "", { mode: 0o755 });
  const env = { PATH: dir, PATHEXT: ".EXE" };
  // Completing these inside the PATH entry would find a real file, but a relative
  // path is the launch cwd's to resolve: PATH is never consulted for it.
  expect(resolveProgram("sub/probe", env, "win32")).toBe("sub/probe");
  expect(resolveProgram("sub\\probe", env, "win32")).toBe("sub\\probe");
});

it("keeps the POSIX PATH rule for an entry that carries the win32 delimiter or suffix list", () => {
  const dir = programDir("posix-reverse", ["probe.EXE"]);
  const win32Env = { PATH: `${dir};/opt/bin`, PATHEXT: ".EXE" };
  // One launch env, two rules: win32 splits the entry at `;` and completes the
  // name, POSIX reads `;` as an ordinary character of one `:`-separated entry and
  // completes nothing - the win32 rule cannot leak into it.
  expect(resolveProgram("probe", win32Env, "win32")).toBe(join(dir, "probe.EXE"));
  expect(resolveProgram("probe", win32Env, "linux")).toBe("probe");
  expect(resolveProgram("probe", { PATH: dir, PATHEXT: ".EXE" }, "linux")).toBe("probe");
});

it.each([
  ["darwin", "arm64", true],
  ["darwin", "x64", false],
  ["linux", "arm64", false],
  ["win32", "x64", true],
] as const)("reports real PTY spawn availability on %s/%s as %s", (platform, arch, expected) => {
  // The reported capability is the worker's own platform gate: the pin record's
  // admitted set. A Host outside it can never fork the helper and must report
  // `spawnImplemented: false` so the renderer keeps its residual warning instead
  // of losing it while every start fails; win32/x64 is true once admitted, and
  // that stays honest because a ConPTY terminal really starts there (#55) - the
  // flag claims a START and never containment, which win32 does not have
  // (`ptyProcessGroupOwnershipAvailable`).
  vi.stubGlobal("process", { ...process, platform, arch });
  try {
    expect(ptySpawnerAvailable()).toBe(expected);
  } finally {
    vi.unstubAllGlobals();
  }
});

realIt("reclaims a terminal-session descendant whose parent chain broke before the stop", { timeout: 30_000 }, async () => {
  // Session-sweep finding: a job-control descendant leaves the shell's own
  // process group, and when the intermediate shell that started it exits it is
  // also re-parented to init - so the parent chain from the root no longer
  // reaches it. It still shares this terminal's session, which is exactly what
  // the controlling-terminal sweep records while the root is alive. Without that
  // sweep the stop would report `tree-drained` while this process lived on.
  const marker = 3276;
  const f = new Fixture("session-sweep", { stopGraceMs: 250, stopConfirmMs: 250, observeCadenceMs: 50 });
  const { instance } = await f.start();
  try {
    await f.sessions.input("term-1", `sh -c 'sleep ${marker} & exit' & echo BG=$!\r`);
    const descendant = await untilValue(() => markerPids(marker)[0], 8000, "session descendant");
    f.track(descendant);
    expect(descendant).not.toBe(instance!.processGroupId);
    expect(pgidOf(descendant)).not.toBe(instance!.processGroupId);
    await until(() => ppidOf(descendant) === 1, 5000, "descendant to be re-parented to init");
    // An input round trip is a deterministic observation point: the sweep has
    // then run with the descendant alive and recorded it.
    await f.sessions.input("term-1", "echo SYNC-$((1+1))\r");
    await until(() => f.history().includes("SYNC-2"), 8000, "observation round trip");

    expect(await f.sessions.stop("term-1", "user-request")).toMatchObject({ ok: true });
    await until(() => !alive(descendant), 8000, "session descendant to be reclaimed");
    expect(markerPids(marker)).toEqual([]);
  } finally {
    await f.sessions.stopAll("test-cleanup").catch(() => undefined);
    for (const pid of [...f.pids.filter(alive), ...markerPids(marker)]) killPid(pid);
    await until(() => markerPids(marker).length === 0, 5000, "marker processes to end");
  }
});

realIt("fails closed when a start plan daemonizes a descendant and exits inside one observation window", { timeout: 30_000 }, async () => {
  // P1 finding: this plan creates its descendant and exits inside one cadence, so
  // no snapshot ever sees the root alive. `setsid sleep 300 &` cannot be run as
  // such here (`setsid(1)` does not exist on macOS), so the plan runs the
  // equivalent: a detached child, which the OS puts into a brand-new session
  // that this driver cannot observe at all. The receipt must be `unknown` -
  // never `tree-drained` - while the daemon lives.
  //
  // The "no snapshot ever saw this root alive" premise is forced by the driver's
  // own injected cadence instead of being hoped for from the plan's race against
  // the production 500ms cadence. The cadence is set to the driver's maximum, so
  // this driver's first possible observation is 30s after `spawn` - while the
  // root's exit is awaited with an 8s bound below. No cadence tick can therefore
  // complete before the receipt is decided, which is exactly the state a root
  // that really exits inside one observation window leaves behind (under load a
  // 500ms cadence can observe the root alive and legitimately report
  // `tree-drained`).
  const marker = 3278;
  const f = new Fixture("daemonize", { observeCadenceMs: 30_000 });
  mkdirSync(join(f.taskDir, "work"), { recursive: true });
  const script = join(f.taskDir, "work", "daemonize.sh");
  writeFileSync(
    script,
    `#!/bin/sh\nset -m\n/usr/bin/nohup '${process.execPath}' -e "require('node:child_process').spawn('/bin/sleep',['${marker}'],{detached:true,stdio:'ignore'}).unref()" >/dev/null 2>&1 &\nexit\n`,
    { mode: 0o755 },
  );
  const identity = { taskId: f.taskId, sessionId: "human-ui", instanceId: "term-1", generation: 1 };
  const receipts: string[] = [];
  const daemons: number[] = [];
  try {
    const spawned = await f.driver.spawn(identity, f.launch("term-1", "fixture-daemonize", script), (receipt) => receipts.push(receipt.status));
    expect(spawned.status).toBe("started");
    const rootPid = spawned.process!.processId;
    f.track(rootPid);
    await until(() => !alive(rootPid), 8000, "self-daemonizing root to exit");
    const daemon = await untilValue(() => markerPids(marker)[0], 10_000, "daemonized descendant");
    daemons.push(daemon);
    expect(alive(daemon)).toBe(true);
    await until(() => receipts.length > 0, 8000, "exit receipt");
    expect(receipts).toEqual(["unknown"]);
    // The retained identity is still addressable, and a later stop reports the
    // one thing a stop can verify here - the identities this driver recorded
    // (recorded group + recorded descendants) are gone. It cannot deny a daemon
    // that left for a brand-new session: no OS process accounting exists on this
    // platform to prove that. The natural-exit receipt above must not claim it,
    // and it does not.
    expect(await f.driver.stop(identity)).toMatchObject({ status: "tree-drained" });
    expect(alive(daemon)).toBe(true);
  } finally {
    for (const pid of [...daemons, ...markerPids(marker), ...f.pids.filter(alive)]) killPid(pid);
    await until(() => markerPids(marker).length === 0, 5000, "daemon to end");
  }
});

realIt("keeps an instance addressable when a start plan leaves an unobserved job-control descendant", { timeout: 30_000 }, async () => {
  // The same window with a job-control descendant: `set -m` gives it its own
  // process group, `nohup` makes it HUP-proof, and the root exits before any
  // snapshot saw it, so the survivor cannot be named post-mortem either (the
  // terminal is revoked). This exit is not covered, so the instance must not be
  // marked exited behind it. The plan validation refuses shell connectors in an
  // argument, which is why the self-daemonizing program is a script.
  //
  // The cadence is forced to the driver's maximum for the same reason as the
  // self-daemonizing case above: "the root exits before any snapshot saw it" is
  // this test's premise, and a 500ms cadence only hopes for it. Under load a tick
  // lands while the root is still alive (and before it forked the descendant), so
  // the exit is covered by that observation and the driver legitimately reports
  // `tree-drained` - the race, observed for real: `expected 'exited' to be
  // 'running'`. No tick can land before the 8s root-exit wait below expires.
  const marker = 3279;
  const f = new Fixture("daemonize-job", { observeCadenceMs: 30_000 });
  mkdirSync(join(f.taskDir, "work"), { recursive: true });
  const script = join(f.taskDir, "work", "daemonize-job.sh");
  writeFileSync(script, `#!/bin/sh\nset -m\nnohup sleep ${marker} &\nexit\n`, { mode: 0o755 });
  try {
    const { started, instance } = await f.start("term-1", script);
    expect(started.ok).toBe(true);
    const rootPid = instance!.processId!;
    await until(() => !alive(rootPid), 8000, "root to exit");
    const descendant = await untilValue(() => markerPids(marker)[0], 10_000, "job-control descendant");
    f.track(descendant);
    expect(pgidOf(descendant)).toBe(descendant);
    expect(alive(descendant)).toBe(true);
    expect(f.registry.get("term-1")?.lifecycle).toBe("running");
    expect(f.registry.get("term-1")?.exitReason).toBeUndefined();
  } finally {
    for (const pid of [...f.pids.filter(alive), ...markerPids(marker)]) killPid(pid);
    await until(() => markerPids(marker).length === 0, 5000, "descendant to end");
  }
});

realIt("fails closed when the process-table snapshot is unavailable", { timeout: 30_000 }, async () => {
  // (d) snapshot-less environment: with no probe there is no evidence about the
  // tree at all, so a natural exit is `unknown` (never `tree-drained`) and a stop
  // cannot prove a stop either.
  const f = new Fixture("no-snapshot", { processTable: () => null, stopGraceMs: 250, stopConfirmMs: 250 });
  const identity = { taskId: f.taskId, sessionId: "human-ui", instanceId: "term-1", generation: 1 };
  const receipts: string[] = [];
  const spawned = await f.driver.spawn(identity, f.launch(), (receipt) => receipts.push(receipt.status));
  expect(spawned.status).toBe("started");
  const rootPid = spawned.process!.processId;
  f.track(rootPid);
  try {
    await f.driver.input(identity, "exit\r");
    await until(() => receipts.length > 0, 10_000, "exit receipt");
    expect(receipts).toEqual(["unknown"]);
    expect((await f.driver.stop(identity)).status).toBe("unknown");
  } finally {
    killPid(rootPid);
    await until(() => !alive(rootPid), 5000, "unverifiable shell to end");
  }
});

realIt("bounds the driver at eight terminals and lets a ninth start once one drains", { timeout: 60_000 }, async () => {
  // Cap finding: a finished lifecycle must not hold one of the eight slots, and
  // the ninth start must fail as `not-started` only while eight are really live.
  const f = new Fixture("cap", { stopGraceMs: 250, stopConfirmMs: 250 });
  const identityFor = (index: number) => ({ taskId: f.taskId, sessionId: "human-ui", instanceId: `term-${index}`, generation: 1 });
  const launch = f.launch("term-1", "fixture-cap");
  const live = Array.from({ length: MAX_TERMINAL_INSTANCES }, (_, index) => identityFor(index + 1));
  for (const identity of live) {
    const spawned = await f.driver.spawn(identity, launch, () => {});
    expect(spawned.status).toBe("started");
    f.track(spawned.process?.processId);
  }
  const ninth = identityFor(MAX_TERMINAL_INSTANCES + 1);
  expect(await f.driver.spawn(ninth, launch, () => {})).toEqual({ status: "not-started" });
  // One proven end frees its slot, so the ninth really starts.
  expect((await f.driver.stop(live[0]!)).status).toBe("tree-drained");
  const retried = await f.driver.spawn(ninth, launch, () => {});
  expect(retried.status).toBe("started");
  f.track(retried.process?.processId);
  for (const identity of [...live, ninth]) await f.driver.stop(identity);
});

win32RealIt("stops a real win32 terminal through its helper handle, verifies the tree gone, and reaps the helper", { timeout: 90_000 }, async () => {
  // The win32 stop is the Host terminating the ChildProcess it forked itself;
  // this drives that against a REAL ConPTY terminal with a real child, so the
  // tree-gone and helper-reaped claims are measured, not asserted about a stub.
  const baseline = win32HelperPids();
  const f = new Fixture("win32-stop");
  const identity = { taskId: f.taskId, sessionId: "human-ui", instanceId: "term-1", generation: 1 };
  const launch = win32Launch(["/c", `${win32System32("ping.exe")} -n 60 127.0.0.1 >nul`]);
  const spawned = await f.driver.spawn(identity, launch, () => {});
  expect(spawned.status).toBe("started");
  const root = spawned.process!.processId;
  f.track(root);
  // No process group is invented on win32: the pid is the whole recorded identity.
  expect(spawned.process).toEqual({ processId: root });
  // A real two-process tree: the shell plus PING.EXE, linked by the OS's own parent chain.
  const tree = await untilValue(() => {
    const rows = readWin32ProcessTable();
    if (rows === null) return undefined;
    const descendants = descendantPids(rows, root);
    return descendants.length > 0 ? [root, ...descendants] : undefined;
  }, 15_000, "the win32 terminal's child process");
  expect(tree.every(alive), `live tree ${tree.join(",")}`).toBe(true);
  const helpers = forkedHelperPids(baseline);
  expect(helpers, `helpers forked by this terminal: ${helpers.join(",")}`).toHaveLength(1);

  const stopped = await f.driver.stop(identity);
  expect(stopped).toEqual({ ...identity, status: "tree-drained" });
  for (const pid of tree) expect(alive(pid), `stopped win32 tree pid ${pid} still alive`).toBe(false);
  // The leak this test exists for: the forked helper is reaped with the stop.
  expect(win32HelperPids()).not.toContain(helpers[0]);
  // And the slot really is free: the same identity starts a fresh terminal instead
  // of resolving against the retained operation of the one just stopped.
  const fresh = await f.driver.spawn(identity, launch, () => {});
  expect(fresh.status).toBe("started");
  f.track(fresh.process?.processId);
  expect((await f.driver.stop(identity)).status).toBe("tree-drained");
  expect(win32HelperPids()).not.toContain(helpers[0]);
});

win32RealIt("frees a real win32 instance slot when a started terminal is stopped", { timeout: 120_000 }, async () => {
  // The instance cap is a driver-wide bound, so a stopped win32 terminal that
  // did not release its slot would refuse the ninth start forever.
  const f = new Fixture("win32-cap");
  const identityFor = (index: number) => ({ taskId: f.taskId, sessionId: "human-ui", instanceId: `term-${index}`, generation: 1 });
  const launch = win32Launch(["/c", `${win32System32("ping.exe")} -n 60 127.0.0.1 >nul`]);
  const live = Array.from({ length: MAX_TERMINAL_INSTANCES }, (_, index) => identityFor(index + 1));
  try {
    for (const identity of live) {
      const spawned = await f.driver.spawn(identity, launch, () => {});
      expect(spawned.status).toBe("started");
      f.track(spawned.process?.processId);
    }
    const ninth = identityFor(MAX_TERMINAL_INSTANCES + 1);
    expect(await f.driver.spawn(ninth, launch, () => {})).toEqual({ status: "not-started" });
    expect((await f.driver.stop(live[0]!)).status).toBe("tree-drained");
    const retried = await f.driver.spawn(ninth, launch, () => {});
    expect(retried.status).toBe("started");
    f.track(retried.process?.processId);
    for (const identity of live.slice(1)) await f.driver.stop(identity);
    expect((await f.driver.stop(ninth)).status).toBe("tree-drained");
  } finally {
    // Nothing may outlive the test: an unstoppable win32 terminal would keep a
    // live helper handle and hang the worker instead of failing.
    for (const identity of [...live, identityFor(MAX_TERMINAL_INSTANCES + 1)]) await f.driver.stop(identity).catch(() => undefined);
  }
});

win32RealIt("stops a real win32 terminal through the session layer and keeps the instance addressable again", { timeout: 90_000 }, async () => {
  // The user-visible half: the whole chain (registry -> session -> driver) must
  // really stop a win32 terminal, mark the instance exited, and leave the slot
  // usable - not refuse because the platform has no process group.
  const f = new Fixture("win32-session");
  const shell = process.env.ComSpec ?? win32System32("cmd.exe");
  const args = ["/c", `${win32System32("ping.exe")} -n 60 127.0.0.1 >nul`];
  const { started } = await f.start("term-1", shell, args);
  expect(started).toMatchObject({ ok: true });
  const root = f.registry.get("term-1")!.processId!;
  f.track(root);
  // The recorded identity is the pid alone: no group is invented for a platform
  // that has none.
  expect(f.registry.get("term-1")).toMatchObject({ processId: root });
  expect(f.registry.get("term-1")!.processGroupId).toBeUndefined();

  const stopped = await f.sessions.stop("term-1", "user-request");
  expect(stopped).toMatchObject({ ok: true });
  if (!stopped.ok) return;
  expect(stopped.instance.lifecycle).toBe("exited");
  expect(stopped.instance.exitReason).toBe("user-request");
  await until(() => !alive(root), 10_000, "stopped win32 shell to exit");
  // A stop of an already-exited instance is idempotent, never a fake restart.
  expect(await f.sessions.stop("term-1", "user-request")).toMatchObject({ ok: true });

  // The instance is addressable again: a fresh terminal really starts and is
  // really contained, instead of resolving against the stopped run.
  const restarted = await f.restart("term-1", shell, args);
  expect(restarted.started).toMatchObject({ ok: true });
  expect(f.registry.get("term-1")!.lifecycle).toBe("running");
  expect((await f.sessions.stop("term-1", "user-request")).ok).toBe(true);
});

win32RealIt("reaps the Host-owned helper when a real win32 terminal ends on its own", { timeout: 90_000 }, async () => {
  // The pty child can exit without any stop call, and the forked helper does not
  // follow it on win32: without the reap this leaks one helper per ended terminal
  // and keeps its slot.
  const baseline = win32HelperPids();
  const f = new Fixture("win32-exit");
  const identity = { taskId: f.taskId, sessionId: "human-ui", instanceId: "term-1", generation: 1 };
  const receipts: TerminalDriverReceipt[] = [];
  const spawned = await f.driver.spawn(identity, win32Launch(["/c", "exit 7"]), (receipt) => receipts.push(receipt));
  expect(spawned.status).toBe("started");
  f.track(spawned.process?.processId);
  await until(() => receipts.length > 0, 20_000, "win32 natural-exit receipt");
  // The real receipt with the code the pty really reported - never `unknown` for
  // an end whose tree this Host verified gone, and never a fabricated one.
  expect(receipts).toEqual([{ ...identity, status: "tree-drained", exitCode: 7 }]);
  // The reap: the terminal that just ended forked one helper, and no helper is
  // left among this process's children once its receipt is in.
  expect(forkedHelperPids(baseline), `helpers left over: ${win32HelperPids().join(",")}`).toEqual([]);
  // The slot is free again: the same identity really starts once more.
  const fresh = await f.driver.spawn(identity, win32Launch(["/c", "exit 0"]), () => {});
  expect(fresh.status).toBe("started");
  f.track(fresh.process?.processId);
});

win32RealIt("starts a real ConPTY terminal from the Host's own task record through plan, session and driver", { timeout: 90_000 }, async () => {
  // The residual gap the two-axis review named (spec check 2): the win32 tests
  // above build their plan with this file's `planFor` helper. This one climbs one
  // step up the real path - a task record in the store, read by the Host's own
  // `TaskWorkspaceFiles` (exactly the `roots` `host.ts` hands to `planTerminal`),
  // whose `joinRoot` is what produces the mixed-separator `plan.cwd` #61 had to
  // canonicalise. Nothing is mocked: the plan really starts a ConPTY terminal and
  // the stop really contains it.
  const f = new Fixture("win32-host-plan");
  const shell = process.env.ComSpec ?? win32System32("cmd.exe");
  const args = ["/c", `${win32System32("ping.exe")} -n 60 127.0.0.1 >nul`];
  mkdirSync(join(f.taskDir, "work"), { recursive: true });
  const store = memoryTaskStore();
  store.writeTask(f.taskDir, {
    taskId: f.taskId,
    name: "host-plan",
    dirId: f.taskId,
    branch: "work/host-plan",
    root: f.taskDir,
    taskDir: f.taskDir,
    remoteBranch: "main",
    baseCommit: "base-sha",
    repos: ["work"],
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
  });
  const files = new TaskWorkspaceFiles(f.taskId, f.taskDir, store);
  const planned = planTerminal({
    roots: files.roots(),
    taskId: f.taskId,
    taskDir: f.taskDir,
    rootId: "work",
    program: shell,
    args,
    layers: {
      repoDefaults: [
        { key: "PATH", value: `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`, secret: false },
        { key: "TERM", value: "xterm-256color", secret: false },
      ],
      shared: [], privateEntries: [], task: [],
    },
    owner: { taskId: f.taskId, sessionId: null, label: "用户显式操作" },
    instanceId: "term-1",
  });
  expect(planned.ok, planned.ok ? "" : planned.error).toBe(true);
  if (!planned.ok) return;
  // The Host's own producer really yields the display spelling (`joinRoot`'s `/`),
  // which on win32 is NOT the driver's canonical cwd contract - so this test fails
  // on the pre-#61 code for the same real reason the product path did.
  expect(planned.plan.cwd).toBe(`${f.taskDir.replace(/[\\/]+$/, "")}/work`);
  expect(normalize(planned.plan.cwd)).not.toBe(planned.plan.cwd);
  f.registry.register(planned.plan);
  const started = await f.sessions.start({ plan: planned.plan, sessionId: null });
  expect(started).toMatchObject({ ok: true });
  const root = f.registry.get("term-1")!.processId!;
  f.track(root);
  // A real process, not a recorded intent.
  expect(root).toBeGreaterThan(1);
  expect(alive(root)).toBe(true);
  // The registered record keeps the plan's own spelling (only the launch cwd was
  // canonicalised, the #61 fix) and no process group is invented on win32.
  expect(f.registry.get("term-1")).toMatchObject({ cwd: planned.plan.cwd, processId: root });
  expect(f.registry.get("term-1")!.processGroupId).toBeUndefined();
  // Honest stop: the session layer reports only what the helper-handle stop
  // proved, and the real process is gone afterwards.
  const stopped = await f.sessions.stop("term-1", "user-request");
  expect(stopped).toMatchObject({ ok: true });
  if (!stopped.ok) return;
  expect(stopped.instance.lifecycle).toBe("exited");
  await until(() => !alive(root), 15_000, "host-plan win32 terminal to exit");
});

it("forgets a not-started spawn so the same identity really starts afterwards", async () => {
  // P2-2: the retained `not-started` entry answered every later start for that
  // identity with the same stale error (even after the cause was fixed) and
  // counted against the instance cap.
  const first = new DriverWorker(), second = new DriverWorker();
  let next: DriverWorker = first;
  const driver = new TerminalPtyDriver({
    workspaceId: "workspace-unit", runtime: resolvePtyRuntime, spawnWorker: () => next, onOutput: () => {},
  });
  const leader = detachedGroupLeader();
  try {
    const starting = driver.spawn(unitIdentity, unitLaunch, () => {});
    first.reply({ status: "not-started" });
    expect(await starting).toEqual({ status: "not-started" });
    next = second;
    const retrying = driver.spawn(unitIdentity, unitLaunch, () => {});
    expect(second.requests).toHaveLength(1);
    second.reply({ status: "started", rootPid: leader.pid });
    expect(await retrying).toEqual({ status: "started", process: recordedIdentity(leader.pid!) });
    // The stop that proves the identity is not wedged signals the recorded group
    // on POSIX; on win32 containment is the Host-owned helper handle, and this
    // stand-in carries none, so the honest receipt is the named `unknown` (POSIX
    // `tree-drained` is unobserved on win32).
    expect((await driver.stop(unitIdentity)).status).toBe(groupOwnership ? "tree-drained" : "unknown");
  } finally {
    killPid(leader.pid);
  }
});

it("forgets an unconfirmed spawn that recorded no root identity so the identity is not wedged", async () => {
  // P2-3: an `unknown` spawn with no pid can never be stopped or retried, so the
  // retained entry only wedged the identity and held one of the eight slots.
  const first = new DriverWorker(), second = new DriverWorker();
  let next: DriverWorker = first;
  const driver = new TerminalPtyDriver({
    workspaceId: "workspace-unit", runtime: resolvePtyRuntime, spawnWorker: () => next, onOutput: () => {},
  });
  const receipts: string[] = [];
  const starting = driver.spawn(unitIdentity, unitLaunch, (receipt) => receipts.push(receipt.status));
  first.reply({ status: "unknown" });
  expect(await starting).toEqual({ status: "unknown" });
  expect(receipts).toEqual(["unknown"]);
  next = second;
  const retrying = driver.spawn(unitIdentity, unitLaunch, () => {});
  expect(second.requests).toHaveLength(1);
  second.reply({ status: "unknown" });
  expect(await retrying).toEqual({ status: "unknown" });
});

win32It("stops a win32 terminal by terminating the Host-owned helper handle, once the tree is verified gone", async () => {
  // The handle, not a pid: the helper this Host forked is terminated and the tree
  // the OS's fixed parent chain named is verified gone before a stop is claimed.
  const alivePids = new Set([5200, 5201]);
  const worker = new HelperHandle(() => alivePids.clear());
  const driver = new TerminalPtyDriver({
    workspaceId: "workspace-unit", runtime: resolvePtyRuntime, spawnWorker: () => worker, onOutput: () => {},
    win32ProcessTable: () => [{ pid: 5200, ppid: 1 }, { pid: 5201, ppid: 5200 }],
    win32ProcessAlive: (pid) => alivePids.has(pid), stopGraceMs: 50, stopConfirmMs: 50,
  });
  const starting = driver.spawn(unitIdentity, unitLaunch, () => {});
  worker.reply({ status: "started", rootPid: 5200 });
  expect(await starting).toEqual({ status: "started", process: { processId: 5200 } });
  expect(await driver.stop(unitIdentity)).toEqual({ ...unitIdentity, status: "tree-drained" });
  expect(worker.killed).toBe(true);
});

win32It("does not adopt a recycled pid's foreign family when it stops a win32 terminal", async () => {
  // #68, the measured shape: the root this Host spawned was handed a pid a dead
  // process used to own, so the OS's historical `ppid` hung three still-living
  // processes of ANOTHER application (dated 18 h earlier) off it. Today's walk waits
  // on them, can never verify the drain, and the user's stop fails; creation time is
  // what refuses them here, so the stop verifies the tree it really owns.
  const hour = 3_600_000, started = Date.now(), root = 5600, child = 5601;
  const foreign = [5700, 5701, 5702];
  const alivePids = new Set([root, child, ...foreign]);
  const worker = new HelperHandle(() => { for (const pid of [root, child]) alivePids.delete(pid); });
  const driver = new TerminalPtyDriver({
    workspaceId: "workspace-unit", runtime: resolvePtyRuntime, spawnWorker: () => worker, onOutput: () => {},
    win32ProcessTable: () => [
      { pid: root, ppid: 1, createdAt: started },
      { pid: child, ppid: root, createdAt: started + 1000 },
      { pid: foreign[0]!, ppid: root, createdAt: started - 18 * hour },
      { pid: foreign[1]!, ppid: foreign[0]!, createdAt: started - 18 * hour },
      { pid: foreign[2]!, ppid: foreign[1]!, createdAt: started - 18 * hour },
    ],
    win32ProcessAlive: (pid) => alivePids.has(pid), stopGraceMs: 50, stopConfirmMs: 50,
  });
  const starting = driver.spawn(unitIdentity, unitLaunch, () => {});
  worker.reply({ status: "started", rootPid: root });
  expect(await starting).toEqual({ status: "started", process: { processId: root } });
  expect(await driver.stop(unitIdentity)).toEqual({ ...unitIdentity, status: "tree-drained" });
  expect(worker.killed).toBe(true);
  // The unrelated family is still running, and nothing waited on it.
  expect(foreign.filter((pid) => alivePids.has(pid))).toEqual(foreign);
});

win32It("never claims a win32 stop while the tree survives the helper kill", async () => {
  // A helper the Host terminated, but a tree that is still there: the receipt
  // stays the named `unknown` and the operation is retained for a later stop. Both
  // rows are dated AFTER the root on purpose: the creation-time rule keeps a real
  // descendant, so this refusal is not that rule refusing a survivor it should
  // have kept.
  const worker = new HelperHandle();
  const driver = new TerminalPtyDriver({
    workspaceId: "workspace-unit", runtime: resolvePtyRuntime, spawnWorker: () => worker, onOutput: () => {},
    win32ProcessTable: () => [{ pid: 5300, ppid: 1, createdAt: 1_700_000_000_000 }, { pid: 5301, ppid: 5300, createdAt: 1_700_000_000_500 }],
    win32ProcessAlive: () => true, stopGraceMs: 50, stopConfirmMs: 50,
  });
  const starting = driver.spawn(unitIdentity, unitLaunch, () => {});
  worker.reply({ status: "started", rootPid: 5300 });
  expect(await starting).toEqual({ status: "started", process: { processId: 5300 } });
  expect(await driver.stop(unitIdentity)).toEqual({ ...unitIdentity, status: "unknown" });
  expect(worker.killed).toBe(true);
  // The retained identity keeps answering: a stop claims no tree it could not verify.
  expect(await driver.stop(unitIdentity)).toEqual({ ...unitIdentity, status: "unknown" });
});

win32It("reaps the win32 helper and reports the real receipt when the terminal ends on its own", async () => {
  // The pty child exits without a stop call: the helper must still be terminated
  // and the verified end reported with the code the pty really gave.
  const alivePids = new Set([5400]);
  const worker = new HelperHandle(() => alivePids.clear());
  const driver = new TerminalPtyDriver({
    workspaceId: "workspace-unit", runtime: resolvePtyRuntime, spawnWorker: () => worker, onOutput: () => {},
    win32ProcessTable: () => [], win32ProcessAlive: (pid) => alivePids.has(pid), stopGraceMs: 50, stopConfirmMs: 50,
  });
  const receipts: TerminalDriverReceipt[] = [];
  const starting = driver.spawn(unitIdentity, unitLaunch, (receipt) => receipts.push(receipt));
  worker.reply({ status: "started", rootPid: 5400 });
  expect(await starting).toEqual({ status: "started", process: { processId: 5400 } });
  const spawnRequest = worker.requests[0]!;
  worker.emit("message", { workspaceId: spawnRequest["workspaceId"], identity: spawnRequest["identity"],
    operationId: spawnRequest["operationId"], kind: "exit", exitCode: 0, signal: 0 });
  await until(() => receipts.length > 0, 3000, "win32 natural-exit receipt");
  expect(receipts).toEqual([{ ...unitIdentity, status: "tree-drained", exitCode: 0 }]);
  expect(worker.killed).toBe(true);
});

it("never reports a fabricated exit code for a stop with no observed child exit", async () => {
  // P2-5: node-pty prints `exitCode: 0` for a signalled child, so a stop that
  // killed the terminal must carry no code at all instead of a clean `0`.
  const worker = new DriverWorker();
  const driver = new TerminalPtyDriver({
    workspaceId: "workspace-unit", runtime: resolvePtyRuntime, spawnWorker: () => worker,
    processTable: () => [], onOutput: () => {}, stopGraceMs: 100, stopConfirmMs: 100,
  });
  const leader = detachedGroupLeader();
  try {
    const starting = driver.spawn(unitIdentity, unitLaunch, () => {});
    worker.reply({ status: "started", rootPid: leader.pid });
    expect(await starting).toEqual({ status: "started", process: recordedIdentity(leader.pid!) });
    const stopped = await driver.stop(unitIdentity);
    // `tree-drained` needs the recorded group to signal and re-verify on POSIX
    // (assertion unobserved on win32), where this stand-in helper carries no
    // Host-owned handle: a stop that really drained the group says so, a win32
    // stop without a killable handle reports the named `unknown` instead.
    expect(stopped).toEqual({ ...unitIdentity, status: groupOwnership ? "tree-drained" : "unknown" });
    // `toEqual` already fails on a fabricated `0`; assert the absence directly so
    // the claim this test makes is unambiguous.
    expect(stopped).not.toHaveProperty("exitCode");
  } finally {
    killPid(leader.pid);
  }
});

it("reports root-exited for a natural exit the last dispatched request did not cover", async () => {
  // The other half of the covered/uncovered distinction, pinned without racing a
  // cadence: with the cadence at the driver's maximum, the only snapshot this
  // operation contributes is the one `input` takes before it dispatches, so that
  // request is the newest evidence (`observations === requestFloor`). An exit
  // there is `root-exited` - the root is verified gone with the code it really
  // reported, while the window that request opened is explicitly NOT denied - and
  // never `tree-drained`, which would claim whole-tree containment for that
  // unobserved window.
  const worker = new DriverWorker();
  const leader = detachedGroupLeader();
  let live = true;
  const driver = new TerminalPtyDriver({
    workspaceId: "workspace-unit", runtime: resolvePtyRuntime, spawnWorker: () => worker, observeCadenceMs: 30_000,
    // One snapshot of the live root: the identity this operation can really
    // observe. After `live` is cleared the root and every recorded identity are
    // gone, which is the same table a really drained tree leaves.
    processTable: () => (live ? [{ pid: leader.pid!, ppid: 1, pgid: leader.pid!, tty: "ttys901", state: "S" }] : []),
    onOutput: () => {}, stopGraceMs: 100, stopConfirmMs: 100,
  });
  const receipts: TerminalDriverReceipt[] = [];
  try {
    const starting = driver.spawn(unitIdentity, unitLaunch, (receipt) => receipts.push(receipt));
    worker.reply({ status: "started", rootPid: leader.pid });
    expect(await starting).toEqual({ status: "started", process: recordedIdentity(leader.pid!) });
    // Land one completed observation, then clear the root so the exit below is
    // not covered by any observation after this dispatched request.
    const inputting = driver.input(unitIdentity, "echo covered\r");
    live = false;
    const inputRequest = worker.requests[1]!;
    worker.reply({ status: "accepted" }, inputRequest);
    await inputting;
    worker.emit("message", { workspaceId: inputRequest["workspaceId"], identity: inputRequest["identity"],
      operationId: inputRequest["operationId"], kind: "exit", exitCode: 0, signal: 0 });
    await until(() => receipts.length > 0, 3000, "natural-exit receipt");
    // The covered/uncovered distinction is a claim about a drained recorded group,
    // so on POSIX it cannot be expressed without one (assertion unobserved on
    // win32); a win32 stand-in helper with no Host-owned handle cannot be reaped
    // or verified, so the exit is the named `unknown` there.
    expect(receipts).toEqual(groupOwnership
      ? [{ ...unitIdentity, status: "root-exited", exitCode: 0 }]
      : [{ ...unitIdentity, status: "unknown" }]);
  } finally {
    killPid(leader.pid);
  }
});

it("never reports a fabricated exit code for a natural exit the OS reported as signalled", async () => {
  // The other source of a fabricated `0`: node-pty prints `exitCode: 0` for a
  // child killed by a signal, so the natural-exit receipt must carry no code when
  // the pty reported `signal !== 0`.
  const worker = new DriverWorker();
  const leader = detachedGroupLeader();
  let observed = false;
  const driver = new TerminalPtyDriver({
    workspaceId: "workspace-unit", runtime: resolvePtyRuntime, spawnWorker: () => worker, observeCadenceMs: 10,
    // The first snapshot sees the live root (the only moment its session is
    // attributable to it); every later one reports an empty table, i.e. the root
    // and its recorded identities are gone.
    processTable: () => {
      if (observed) return [];
      observed = true;
      return [{ pid: leader.pid!, ppid: 1, pgid: leader.pid!, tty: "ttys900", state: "S" }];
    },
    onOutput: () => {}, stopGraceMs: 100, stopConfirmMs: 100,
  });
  const receipts: TerminalDriverReceipt[] = [];
  try {
    const starting = driver.spawn(unitIdentity, unitLaunch, (receipt) => receipts.push(receipt));
    worker.reply({ status: "started", rootPid: leader.pid });
    expect(await starting).toEqual({ status: "started", process: recordedIdentity(leader.pid!) });
    await until(() => observed, 3000, "one snapshot of the live root");
    const spawnRequest = worker.requests[0]!;
    worker.emit("message", { workspaceId: spawnRequest["workspaceId"], identity: spawnRequest["identity"], operationId: spawnRequest["operationId"], kind: "exit", exitCode: 0, signal: 9 });
    await until(() => receipts.length > 0, 3000, "natural-exit receipt");
    // A verified drain of the recorded identity is `tree-drained` on POSIX; the
    // win32 stand-in helper carries no Host-owned handle to terminate or verify,
    // so the exit is the named `unknown` there (POSIX `tree-drained` is unobserved
    // on win32). The assertion this test exists for - no fabricated `0` for a
    // signalled child - holds on both.
    expect(receipts).toEqual(groupOwnership
      ? [{ ...unitIdentity, status: "tree-drained" }]
      : [{ ...unitIdentity, status: "unknown" }]);
    expect(receipts[0]).not.toHaveProperty("exitCode");
  } finally {
    killPid(leader.pid);
  }
});

it("does not wedge an instanceId when a start is unconfirmed", async () => {
  // P2-3 at the session layer: the unconfirmed path keeps no active entry, so the
  // same instanceId can start again instead of answering `terminal-owned`
  // forever and holding one of the eight slots.
  const taskDir = realpathSync(mkdtempSync(join(tmpdir(), "pidock-term-unconfirmed-")));
  try {
    const registry = new TaskTerminalRegistry("task-unconfirmed");
    let mode: "unknown" | "started" = "unknown";
    const process = { processId: 4200, processGroupId: 4200 };
    const driver: TerminalDriver = {
      spawn: async () => (mode === "unknown" ? { status: "unknown" as const } : { status: "started" as const, process: { ...process } }),
      input: async () => {}, resize: async () => {},
      stop: async (identity) => ({ ...identity, status: "tree-drained" }),
      snapshot: () => ({ status: "running", process: { ...process } }),
    };
    const sessions = new TaskTerminalSessions(registry, driver);
    const plan = planFor("task-unconfirmed", taskDir, "term-1", "sh");
    registry.register(plan);
    expect(await sessions.start({ plan, sessionId: null })).toMatchObject({ ok: false, error: expect.stringContaining("terminal-start-unconfirmed") });
    mode = "started";
    registry.register(plan);
    expect(await sessions.start({ plan, sessionId: null })).toMatchObject({ ok: true });
    expect(registry.get("term-1")).toMatchObject({ lifecycle: "running", processId: 4200 });
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

it("refuses to stop a recorded instance this Host holds no live session for", async () => {
  // Coverage note: the `!session` short-circuit is only reachable while the
  // record still carries an identity from an earlier Host generation and this
  // Host has no session for it - the state a restart-after-Host-death leaves.
  const taskDir = realpathSync(mkdtempSync(join(tmpdir(), "pidock-term-nosession-")));
  try {
    const registry = new TaskTerminalRegistry("task-nosession");
    const driver: TerminalDriver = {
      spawn: async () => ({ status: "not-started" }),
      input: async () => {}, resize: async () => {},
      stop: async (identity) => ({ ...identity, status: "tree-drained" }),
      snapshot: () => ({ status: "unknown" }),
    };
    const sessions = new TaskTerminalSessions(registry, driver);
    const plan = planFor("task-nosession", taskDir, "term-1", "sh");
    registry.register(plan);
    registry.markProcess("term-1", { processId: 4300, processGroupId: 4300 });
    expect(await sessions.stop("term-1", "user-request")).toMatchObject({
      ok: false,
      error: expect.stringContaining("没有本 Host 记录的运行会话"),
    });
    expect(registry.get("term-1")!.lifecycle).toBe("running");
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

it("names the lifetime input budget when input is refused", async () => {
  // P2-4: the lifetime byte budget fences the terminal, so the caller must see
  // which boundary it hit instead of a generic delivery failure.
  const taskDir = realpathSync(mkdtempSync(join(tmpdir(), "pidock-term-budget-")));
  try {
    const registry = new TaskTerminalRegistry("task-budget");
    const process = { processId: 4400, processGroupId: 4400 };
    const driver: TerminalDriver = {
      spawn: async () => ({ status: "started", process: { ...process } }),
      input: async () => { throw Error(PTY_INPUT_BUDGET_ERROR); },
      resize: async () => {},
      stop: async (identity) => ({ ...identity, status: "tree-drained" }),
      snapshot: () => ({ status: "running", process: { ...process } }),
    };
    const sessions = new TaskTerminalSessions(registry, driver);
    const plan = planFor("task-budget", taskDir, "term-1", "sh");
    registry.register(plan);
    expect(await sessions.start({ plan, sessionId: null })).toMatchObject({ ok: true });
    const typed = await sessions.input("term-1", "x");
    expect(typed).toMatchObject({ ok: false, error: expect.stringContaining("terminal-input-failed") });
    expect(typed).toMatchObject({ ok: false, error: expect.stringContaining(String(MAX_PTY_ENVELOPE_BYTES)) });
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});
