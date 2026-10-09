/**
 * [PiDock 04] (#48) durable service-launch ownership identity, driven with REAL
 * child processes on POSIX.
 *
 * Evidence split (stated, not implied):
 * - REAL subprocesses: the fixtures below are real Node children spawned by the
 *   real `TaskServiceProcesses`; the "survivor" cases use real, separate
 *   processes that the OS is actually running while the assertions read them.
 * - REAL durable state: every record is written through the real
 *   `task-store.ts` (exclusive temp file + rename) into a real temp task folder.
 * - REAL identity probe: verification reads the live process's own environment
 *   block back from the OS (`/proc/<pid>/environ`, `ps -E -p <pid>`), never a
 *   value the test passed back to the code under test.
 * - NOT covered here (must stay labelled, never claimed): POSIX descendant
 *   reclaim when a detached descendant outlives its leader and keeps holding
 *   stdout/stderr; Windows process-tree termination (UNTESTED; `start` refuses
 *   there); the cwd realpath→spawn TOCTOU window.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskServiceProcesses } from "./service-processes.js";
import {
  classifyServiceOwnership,
  diskServiceOwnershipLog,
  SERVICE_OWNERSHIP_NONCE_ENV,
  serviceOwnershipState,
  verifyServiceOwnershipIdentity,
} from "./service-ownership.js";
import type { ServiceStartPlan } from "./service-runtime.js";
import {
  readServiceOwnershipOnDisk,
  writeServiceOwnershipOnDisk,
  SERVICE_OWNERSHIP_SCHEMA_VERSION,
  type ServiceOwnershipRecord,
} from "./task-store.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function taskDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pidock-ownership-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const TASK_ID = "task-48a0ownership";
const POLL_INTERVAL_MS = 25;
const POLL_BUDGET_MS = 30_000;

async function until(check: () => boolean, label: string): Promise<void> {
  for (let elapsed = 0; elapsed < POLL_BUDGET_MS; elapsed += POLL_INTERVAL_MS) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw Error(`timed out waiting for ${label}`);
}

/**
 * A pid that is not a usable positive integer cannot be probed: `kill(0, 0)`
 * signals this whole process group and always succeeds, so a `0` read would
 * look like a permanently live process and hang the run. Failing loudly with
 * the raw marker text keeps a recurrence self-diagnosing instead of a timeout.
 */
class InvalidPidError extends Error {
  constructor(readonly raw: string, readonly source: string) {
    super(`invalid-pid: ${source} yielded ${JSON.stringify(raw)}`);
    this.name = "InvalidPidError";
  }
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) throw new InvalidPidError(String(pid), "alive(pid)");
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Real, live, unrelated process that carries no ownership marker of ours. */
function foreignProcess(): number {
  const child: ChildProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  if (!child.pid) throw Error("foreign fixture did not start");
  const pid = child.pid;
  cleanups.push(() => { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } });
  return pid;
}

function plan(serviceId: string, cwd: string, args: string[] = ["-e", "setInterval(() => {}, 1000)"]): ServiceStartPlan {
  return { serviceId, cwd, program: process.execPath, args, env: { SERVICE_FIXTURE: serviceId }, runType: "long-lived" };
}

const record = (input: { serviceId: string; pid: number; ownershipNonce: string }): ServiceOwnershipRecord => ({
  schemaVersion: SERVICE_OWNERSHIP_SCHEMA_VERSION,
  taskId: TASK_ID,
  serviceId: input.serviceId,
  pid: input.pid,
  ownershipNonce: input.ownershipNonce,
  startedAt: "2026-01-01T00:00:00.000Z",
});

/** A driver whose durable records live in `dir`, with the given stop timeouts. */
function driver(dir: string, options: { graceMs?: number; confirmMs?: number; durable?: boolean; onExit?: (serviceId: string, reason: string) => void } = {}) {
  return new TaskServiceProcesses(dir, () => {}, options.onExit ?? (() => {}), (line) => line,
    options.graceMs ?? 3000, options.confirmMs ?? 1000,
    options.durable === false ? undefined : diskServiceOwnershipLog({ taskId: TASK_ID, taskDir: dir }));
}

describe.skipIf(process.platform === "win32")("#48 service-launch ownership identity with real processes", () => {
  it("reads the launched child's own identity back from the OS and records it before start resolves", async () => {
    const dir = taskDir();
    const processes = driver(dir);
    const pid = await processes.start(plan("one", dir));
    expect(alive(pid)).toBe(true);
    try {
      const stored = readServiceOwnershipOnDisk(dir);
      expect(stored.entries).toHaveLength(1);
      const entry = stored.entries[0]!;
      expect(entry).toMatchObject({ taskId: TASK_ID, serviceId: "one", pid });
      expect(entry.ownershipNonce).toMatch(/^[0-9a-f]{32}$/);
      // The identity is not a claim of the test: the code under test re-reads
      // the marker from the live process's OS-visible environment.
      expect(verifyServiceOwnershipIdentity(entry)).toBe("verified");
      expect(classifyServiceOwnership(stored.entries)).toEqual([
        { serviceId: "one", pid, ownershipNonce: entry.ownershipNonce, startedAt: entry.startedAt, state: "own-verified" },
      ]);
      // A wrong nonce can never verify the same live pid.
      expect(verifyServiceOwnershipIdentity({ pid, ownershipNonce: "0".repeat(32) })).toBe("mismatch");
    } finally {
      await processes.stop("one").catch(() => {});
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
    // A confirmed stop is the only thing that clears the record...
    expect(alive(pid)).toBe(false);
    expect(readServiceOwnershipOnDisk(dir).entries).toEqual([]);
  }, 30_000);

  it("clears the record for a launch that exited by itself, and never for a live one", async () => {
    const dir = taskDir();
    const exits: string[] = [];
    const processes = driver(dir, { onExit: (serviceId, reason) => exits.push(`${serviceId}:${reason}`) });
    const pid = await processes.start(plan("one-shot", dir, ["-e", "console.log('bye')"]));
    expect(pid).toBeGreaterThan(0);
    await until(() => exits.length === 1, "the one-shot child to exit");
    // The durable layer may not keep claiming a launch whose process is gone.
    expect(alive(pid)).toBe(false);
    expect(readServiceOwnershipOnDisk(dir).entries).toEqual([]);
  }, 30_000);

  it("refuses a duplicate start while a durable record of a live, unverifiable process exists", async () => {
    const dir = taskDir();
    const foreign = foreignProcess();
    const nonce = "a".repeat(32);
    writeServiceOwnershipOnDisk(dir, { version: SERVICE_OWNERSHIP_SCHEMA_VERSION, entries: [record({ serviceId: "one", pid: foreign, ownershipNonce: nonce })] });

    const processes = driver(dir);
    const before = readFileSync(join(dir, "service-ownership.json"), "utf8");
    // The state name is truthful: we recorded a launch, the pid is alive, and
    // it demonstrably is not that launch.
    const classified = classifyServiceOwnership(readServiceOwnershipOnDisk(dir).entries);
    expect(classified).toEqual([{ serviceId: "one", pid: foreign, ownershipNonce: nonce, startedAt: "2026-01-01T00:00:00.000Z", state: "orphaned-unverified" }]);
    await expect(processes.start(plan("one", dir))).rejects.toThrow(`service-ownership-orphaned-unverified: one pid ${foreign}`);
    // No second process was spawned, and nothing was signalled to the foreign pid.
    expect(processes.ids()).toEqual([]);
    expect(alive(foreign)).toBe(true);
    // The durable layer was not rewritten into a "stopped" claim while the
    // recorded pid is still alive.
    expect(readFileSync(join(dir, "service-ownership.json"), "utf8")).toBe(before);
  }, 30_000);

  it("refuses to signal a recorded pid whose identity does not verify, and reports it unconfirmed", async () => {
    const dir = taskDir();
    const foreign = foreignProcess();
    const nonce = "b".repeat(32);
    writeServiceOwnershipOnDisk(dir, { version: SERVICE_OWNERSHIP_SCHEMA_VERSION, entries: [record({ serviceId: "one", pid: foreign, ownershipNonce: nonce })] });
    const processes = driver(dir);
    const before = readFileSync(join(dir, "service-ownership.json"), "utf8");

    // No in-memory handle: the only path is the durable record, whose identity
    // does not match, so NOTHING may be signalled.
    await expect(processes.stop("one")).rejects.toThrow(`service-ownership-unverified: one pid ${foreign}`);
    expect(alive(foreign)).toBe(true);
    // Still not rewritten: an unverified survivor is not "stopped".
    expect(readFileSync(join(dir, "service-ownership.json"), "utf8")).toBe(before);
  }, 30_000);

  it("recovers a launch that survived its Host: verify, refuse double start, then stop only that verified identity", async () => {
    const dir = taskDir();
    // Host A starts a real service and then dies without stopping it (no
    // `stopAll`): the child is detached, so it survives and the durable record
    // is the only evidence left.
    const hostA = driver(dir);
    const pid = await hostA.start(plan("one", dir));
    expect(alive(pid)).toBe(true);
    cleanups.push(() => { if (alive(pid)) process.kill(pid, "SIGKILL"); });

    // Host B reconciles the same task folder.
    const hostB = driver(dir);
    expect(hostB.ids()).toEqual([]);
    const entry = classifyServiceOwnership(readServiceOwnershipOnDisk(dir).entries)[0]!;
    // Identified, not adopted: the survivor is classified by its real identity,
    // and Host B holds no child handle for it.
    expect(entry).toMatchObject({ serviceId: "one", pid, state: "own-verified" });
    // No double spawn: the same service may not be started a second time.
    await expect(hostB.start(plan("one", dir))).rejects.toThrow("service-ownership-own-verified");
    expect(hostB.ids()).toEqual([]);
    expect(alive(pid)).toBe(true);
    // A verified identity may be reclaimed; the child really dies and only then
    // does the record go.
    await hostB.stop("one");
    expect(alive(pid)).toBe(false);
    expect(readServiceOwnershipOnDisk(dir).entries).toEqual([]);
  }, 30_000);

  it("clears a stale record whose process is confirmed gone, then starts and records the new launch", async () => {
    const dir = taskDir();
    // A real process that has exited: its pid is a legitimately dead pid.
    const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await new Promise((resolve) => dead.once("exit", resolve));
    expect(alive(dead.pid!)).toBe(false);
    writeServiceOwnershipOnDisk(dir, { version: SERVICE_OWNERSHIP_SCHEMA_VERSION, entries: [record({ serviceId: "one", pid: dead.pid!, ownershipNonce: "c".repeat(32) })] });

    const processes = driver(dir);
    const pid = await processes.start(plan("one", dir));
    try {
      expect(alive(pid)).toBe(true);
      const stored = readServiceOwnershipOnDisk(dir).entries;
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ serviceId: "one", pid });
      expect(stored[0]!.ownershipNonce).not.toBe("c".repeat(32));
    } finally {
      await processes.stop("one").catch(() => {});
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  }, 30_000);

  it("never reports a stopped launch while its verified process is still alive, and vice versa", async () => {
    const dir = taskDir();
    const processes = driver(dir, { graceMs: 40, confirmMs: 40 });
    const pid = await processes.start(plan("one", dir));
    try {
      // Invariant, checked while the process is verifiably alive: the durable
      // record exists, classifies as own-verified, and the process is alive.
      const live = classifyServiceOwnership(readServiceOwnershipOnDisk(dir).entries);
      expect(live).toHaveLength(1);
      expect(live[0]!.state).toBe("own-verified");
      expect(alive(pid)).toBe(true);
      expect(serviceOwnershipState(verifyServiceOwnershipIdentity(live[0]!))).toBe("own-verified");
    } finally {
      await processes.stop("one");
    }
    // After a confirmed stop the record is gone AND the process is dead: the
    // durable layer never says "stopped" about a live verified process.
    expect(alive(pid)).toBe(false);
    expect(readServiceOwnershipOnDisk(dir).entries).toEqual([]);
  }, 30_000);

  it("keeps a service this Host never launched unknown instead of inventing a record", async () => {
    const dir = taskDir();
    const processes = driver(dir);
    await expect(processes.stop("never-started")).rejects.toThrow("not-running: never-started");
    expect(readServiceOwnershipOnDisk(dir).entries).toEqual([]);
    expect(existsSync(join(dir, "service-ownership.json"))).toBe(false);
  }, 30_000);
});

/**
 * The store and the probe are also exercised without children: the record
 * shape gates a later signal decision, so a corrupt one must be refused rather
 * than half-restored.
 */
describe("#48 service ownership records", () => {
  it("refuses a corrupt or unsafe record instead of restoring it half-shaped", () => {
    const dir = taskDir();
    const file = join(dir, "service-ownership.json");
    const good = { version: 1, entries: [record({ serviceId: "one", pid: 4242, ownershipNonce: "d".repeat(32) })] };
    writeServiceOwnershipOnDisk(dir, good);
    expect(readServiceOwnershipOnDisk(dir)).toEqual(good);
    const cases: unknown[] = [
      { version: 1, entries: [{ ...good.entries[0], pid: 0 }] },
      { version: 1, entries: [{ ...good.entries[0], pid: 1 }] },
      { version: 1, entries: [{ ...good.entries[0], pid: "4242" }] },
      { version: 1, entries: [{ ...good.entries[0], ownershipNonce: "not-a-nonce" }] },
      { version: 1, entries: [{ ...good.entries[0], ownershipNonce: "D".repeat(32) }] },
      { version: 1, entries: [{ ...good.entries[0], schemaVersion: 2 }] },
      { version: 1, entries: [{ ...good.entries[0], taskId: "" }] },
      { version: 1, entries: [good.entries[0], good.entries[0]] },
      { version: 2, entries: [] },
      { entries: [] },
    ];
    for (const corrupt of cases) {
      writeFileSync(file, JSON.stringify(corrupt));
      expect(() => readServiceOwnershipOnDisk(dir), JSON.stringify(corrupt)).toThrow(/invalid-payload/);
    }
    // A record naming another task is never this task's launch, and our writes
    // neither classify nor delete it.
    writeFileSync(file, JSON.stringify({ version: 1, entries: [{ ...good.entries[0], taskId: "task-other" }] }));
    const log = diskServiceOwnershipLog({ taskId: TASK_ID, taskDir: dir });
    expect(log.all()).toEqual([]);
    expect(() => log.record({ serviceId: "one", pid: 4242, ownershipNonce: "e".repeat(32), startedAt: "now" })).not.toThrow();
    const after = readServiceOwnershipOnDisk(dir).entries;
    expect(after.map((entry) => entry.taskId).sort()).toEqual([TASK_ID, "task-other"]);
    expect(log.all()).toHaveLength(1);
    // ... and our release never removes the foreign entry either.
    log.release({ serviceId: "one", ownershipNonce: "e".repeat(32) });
    expect(readServiceOwnershipOnDisk(dir).entries.map((entry) => entry.taskId)).toEqual(["task-other"]);
  });

  it("reports a pid that no process holds as gone, and an unusable pid as unobservable", () => {
    expect(verifyServiceOwnershipIdentity({ pid: 1, ownershipNonce: "f".repeat(32) })).toBe("unobservable");
    expect(verifyServiceOwnershipIdentity({ pid: 0, ownershipNonce: "f".repeat(32) })).toBe("unobservable");
    expect(verifyServiceOwnershipIdentity({ pid: -1, ownershipNonce: "f".repeat(32) })).toBe("unobservable");
    const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    return new Promise<void>((resolve) => dead.once("exit", () => {
      expect(verifyServiceOwnershipIdentity({ pid: dead.pid!, ownershipNonce: "f".repeat(32) })).toBe("gone");
      resolve();
    }));
  });

  it("puts the launch marker in the child's own environment, not in the Host's", async () => {
    const dir = taskDir();
    const lines: string[] = [];
    const processes = new TaskServiceProcesses(dir, (_, line) => lines.push(line), () => {}, (line) => line,
      3000, 1000, undefined);
    const pid = await processes.start(plan("env", dir, ["-e", `console.log('env:' + (process.env.${SERVICE_OWNERSHIP_NONCE_ENV} ? 'present' : 'absent')); setInterval(() => {}, 1000)`]));
    await until(() => lines.includes("env:present"), "the child to report its own environment");
    // The marker the verification reads back really is the child's own, and the
    // Host's own environment never gains it.
    expect(execFileSync("/bin/ps", ["-E", "-p", String(pid)], { encoding: "utf8" })).toContain(`${SERVICE_OWNERSHIP_NONCE_ENV}=`);
    expect(process.env[SERVICE_OWNERSHIP_NONCE_ENV]).toBeUndefined();
    await processes.stop("env").catch(() => {});
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }, 30_000);
});

/** Guard: this suite must not leave a real child of its own behind. */
describe("#48 ownership fixtures", () => {
  it("removes every real fixture child it created", async () => {
    const dir = taskDir();
    mkdirSync(dir, { recursive: true });
    const processes = driver(dir);
    const pid = await processes.start(plan("cleanup", dir));
    await processes.stop("cleanup");
    expect(alive(pid)).toBe(false);
  }, 30_000);
});
