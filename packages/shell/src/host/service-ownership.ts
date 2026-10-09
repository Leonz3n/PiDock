/**
 * Verifiable service-launch ownership identity for [PiDock 04] (#48).
 *
 * Problem this module exists for: `TaskServiceProcesses` starts real children
 * with `detached: true`, so after an abnormal Host/main exit the child keeps
 * running while the in-memory handle is gone. A pid alone is not an identity -
 * the OS recycles pids, so "the pid is alive" can describe an unrelated
 * process, and signalling it would be a guess. This module defines, persists,
 * verifies and classifies an identity strong enough to answer two questions
 * without guessing: "is the process at this pid really the launch we recorded?"
 * and "if we cannot tell, what do we say instead?".
 *
 * Chosen mechanism: **the pair (pid, per-launch 128-bit random nonce), with the
 * nonce carried in the child's own environment and read back from the OS.**
 * - The Host injects `PIDOCK_SERVICE_OWNERSHIP_NONCE=<nonce>` into the child's
 *   fresh environment at spawn (never into the Host's `process.env`).
 * - Tri-state verification semantics:
 *   1. `verified`: STRONG evidence only. The 128-bit nonce carried in child's
 *      environment is read back from the OS and matches. Across restart, this
 *      reconciles as `own-verified` and permits safe termination.
 *   2. `mismatch`: POSITIVE evidence the live process is NOT ours (env readable
 *      AND the nonce absent).
 *   3. `unobservable`: cannot tell (e.g. Apple platform binaries like /bin/sleep
 *      hide their environment; unsupported platform; zombie). NEVER treated as
 *      mismatch, NEVER as verified.
 * - Invariants that MUST hold for `unobservable`, exactly as for `mismatch`:
 *   never send any signal without verified evidence; never report stopped/exited
 *   while alive; refuse a second start (fail-closed); report truthfully as
 *   `orphaned-unverified`.
 * - Cross-restart: when the nonce cannot be read, pid-alive + start-time alone
 *   is WEAK evidence -> `orphaned-unverified`, NEVER verified.
 * - Why not process start time: on macOS `ps -o lstart=` is locale/time-zone
 *   dependent and only second-granular, so two processes can share it. The
 *   nonce is exact, per launch, and unforgeable; `startedAt` is kept for human
 *   audit only and never gates a decision.
 *
 * Hard boundary enforced by this module's callers (`TaskServiceProcesses`): no
 * signal is ever sent to a pid whose identity was not verified in the same call.
 * Only `verified` may permit signalling, and every signal goes through it.
 *
 * Platform boundaries (stated, not implied):
 * - POSIX only. On Windows the environment probe returns `"unobservable"`, so
 *   nothing is ever signalled there; `start` is refused on Windows already, and
 *   Windows process-tree termination semantics are UNTESTED in this slice.
 * - Reading another process's environment needs the same user (true for a
 *   service child); an unreadable pid is treated as unverified, never as ours.
 * - A pid whose process is a not-yet-reaped zombie reports no environment; it is
 *   classified `orphaned-unverified` (fail-closed) rather than assumed over, and
 *   a stop of such a launch keeps polling until the pid is really free.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  readServiceOwnershipOnDisk,
  SERVICE_OWNERSHIP_SCHEMA_VERSION,
  writeServiceOwnershipOnDisk,
  type ServiceOwnershipDiskRecord,
  type ServiceOwnershipRecord,
} from "./task-store.js";

/** Environment key carrying a launch's ownership nonce inside the child. */
export const SERVICE_OWNERSHIP_NONCE_ENV = "PIDOCK_SERVICE_OWNERSHIP_NONCE";

/**
 * A fresh 128-bit launch nonce. Never reused, never derived from the pid, the
 * service id or any path: the identity must not be guessable from anything an
 * unrelated process can observe about the pid it recycled.
 */
export function newServiceOwnershipNonce(): string {
  return randomBytes(16).toString("hex");
}

/** What the OS says about one recorded (pid, nonce) pair. */
export type ServiceOwnershipVerdict =
  /** The live pid carries this exact launch nonce: it is that launch. */
  | "verified"
  /** A live, inspectable process holds the pid and carries another identity. */
  | "mismatch"
  /** No process holds the pid any more. */
  | "gone"
  /** The identity could not be observed (unsupported platform, zombie, other user). */
  | "unobservable";

/** Reconciled state of a durable record; never a guess about a live process. */
export type ServiceOwnershipState =
  /** The recorded launch is alive and its identity was verified. */
  | "own-verified"
  /** A process holds the recorded pid but is not verifiably that launch. */
  | "orphaned-unverified"
  /** The recorded launch is not alive. */
  | "gone";

export interface ServiceOwnershipIdentity {
  pid: number;
  ownershipNonce: string;
}

/** One durable record in the state the real process is in. */
export interface ServiceOwnershipEntry extends ServiceOwnershipIdentity {
  serviceId: string;
  startedAt: string;
  state: ServiceOwnershipState;
}

/**
 * Read the OS-observed environment of one pid as `KEY=VALUE` entries.
 * `null` means the environment could not be read (the pid names no process, the
 * process is a not-yet-reaped zombie, it belongs to someone else, or the probe
 * is unavailable) - never "read and empty", so a caller cannot mistake an
 * unreadable identity for a mismatching one.
 */
function readProcessEnvironment(pid: number): string[] | null {
  try {
    if (process.platform === "linux") {
      const entries = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter((entry) => entry.includes("="));
      return entries.length > 0 ? entries : null;
    }
    if (process.platform === "darwin") {
      // `-E` appends the process's own environment block to the row; entries
      // are whitespace-separated, which is enough to read an exact nonce value.
      const printed = execFileSync("/bin/ps", ["-E", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const entries = printed.split(/\s+/).filter((token) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
      return entries.length > 0 ? entries : null;
    }
  } catch {
    return null;
  }
  return null;
}

/** Whether the pid currently names a process (a not-yet-reaped child included). */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Read the process group ID (PGID) of one pid from the OS.
 * Returns null if the process does not exist, belongs to another user,
 * is on an unsupported platform (e.g. Windows), or cannot be read.
 */
export function readProcessPgid(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  if (process.platform === "win32") return null;
  try {
    if (process.platform === "linux") {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const lastParen = stat.lastIndexOf(")");
        if (lastParen !== -1) {
          const fields = stat.slice(lastParen + 1).trim().split(/\s+/);
          const pgid = Number.parseInt(fields[2] ?? "", 10);
          if (Number.isInteger(pgid) && pgid > 0) return pgid;
        }
      } catch {
        // Fall back to ps if procfs stat is unreadable
      }
    }
    let printed: string;
    try {
      printed = execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        printed = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
      } else {
        throw error;
      }
    }
    const pgid = Number.parseInt(printed.trim(), 10);
    return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
  } catch {
    return null;
  }
}

/** One row of the OS process table: the fields descendant reclaim needs. */
export interface ProcessTableRow {
  pid: number;
  ppid: number;
  pgid: number;
}

/**
 * Snapshot of the OS process table (`pid`, `ppid`, `pgid`) via `ps`.
 *
 * Returns `null` when the probe itself is unavailable (Windows, `ps` missing or
 * failing): "the probe failed" is NOT the same as "the table was empty", and a
 * caller that reclaims descendants must fail closed in the former case rather
 * than read a failed probe as proof that no descendant exists. An actually
 * empty table is `[]`.
 *
 * Fragility considered: the three columns are numeric, so locale and column
 * alignment cannot change their meaning; header suppression (`=`) and the
 * whitespace split tolerate multiple spaces and a leading header-less line;
 * stderr is discarded; a missing `/bin/ps` falls back to `ps` on PATH; and a
 * non-zero exit or oversized output (`ENOBUFS`, bounded by `maxBuffer`) is
 * treated as an unavailable probe, never as "no processes".
 */
export function readProcessTable(): ProcessTableRow[] | null {
  if (process.platform === "win32") return null;
  let printed: string;
  try {
    printed = execFileSync("/bin/ps", ["-eo", "pid=,ppid=,pgid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    try {
      printed = execFileSync("ps", ["-eo", "pid=,ppid=,pgid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 });
    } catch {
      return null;
    }
  }
  const rows: ProcessTableRow[] = [];
  for (const line of printed.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) continue;
    const pid = Number.parseInt(fields[0]!, 10);
    const ppid = Number.parseInt(fields[1]!, 10);
    const pgid = Number.parseInt(fields[2]!, 10);
    if (Number.isInteger(pid) && Number.isInteger(ppid) && Number.isInteger(pgid) && pid >= 1 && ppid >= 0 && pgid >= 1) {
      rows.push({ pid, ppid, pgid });
    }
  }
  return rows;
}

/**
 * The live pids the OS reports as members of process group `pgid` (its leader
 * included while it is alive), or `null` when the OS probe is unavailable.
 *
 * `null` is deliberately distinct from `[]`: a caller that reclaims descendants
 * must fail closed when it cannot read the evidence, so it must never confuse
 * "the probe could not run" with "the group has no members".
 */
export function processGroupMemberPids(pgid: number): number[] | null {
  if (!Number.isInteger(pgid) || pgid <= 1) return null;
  const table = readProcessTable();
  if (table === null) return null;
  return table
    .filter((row) => row.pgid === pgid && row.pid > 1)
    .map((row) => row.pid)
    .sort((a, b) => a - b);
}

/**
 * The only identity decision in this slice. Signal nothing unless this returns
 * `"verified"`.
 */
export function verifyServiceOwnershipIdentity(identity: ServiceOwnershipIdentity): ServiceOwnershipVerdict {
  // A pid that could name our own process group (`0`) or init (`1`) is never a
  // service launch; refusing up front keeps a corrupt record from ever reaching
  // a signalling call.
  if (!Number.isInteger(identity.pid) || identity.pid <= 1) return "unobservable";
  if (process.platform === "win32") return "unobservable";
  if (!processExists(identity.pid)) return "gone";
  const environment = readProcessEnvironment(identity.pid);
  if (environment === null) return "unobservable";
  return environment.includes(`${SERVICE_OWNERSHIP_NONCE_ENV}=${identity.ownershipNonce}`) ? "verified" : "mismatch";
}

/**
 * Positive evidence that a launch is not alive any more: its pid names no
 * process, or names one whose environment we did read (so it is inspectable)
 * and which does not carry this launch's marker. `unobservable` deliberately
 * does *not* count - a process that is exiting can no longer be inspected, and
 * that is not yet proof of anything.
 */
export function serviceOwnershipLaunchEnded(identity: ServiceOwnershipIdentity): boolean {
  const verdict = verifyServiceOwnershipIdentity(identity);
  return verdict === "gone" || verdict === "mismatch";
}

/** Truthful state name for a verdict: unverified survivors are never "ours". */
export function serviceOwnershipState(verdict: ServiceOwnershipVerdict): ServiceOwnershipState {
  if (verdict === "verified") return "own-verified";
  if (verdict === "gone") return "gone";
  return "orphaned-unverified";
}

/**
 * Classify durable records against the real process state. Pure read: it never
 * signals, never adopts a process, never rewrites a record. Directly usable as
 * the boot/read-time reconciliation and as the conflict check before a start.
 */
export function classifyServiceOwnership(records: readonly ServiceOwnershipRecord[]): ServiceOwnershipEntry[] {
  return records
    .map((record) => ({
      serviceId: record.serviceId,
      pid: record.pid,
      ownershipNonce: record.ownershipNonce,
      startedAt: record.startedAt,
      state: serviceOwnershipState(verifyServiceOwnershipIdentity(record)),
    }))
    .sort((a, b) => (a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0));
}

/**
 * One spelling for "a durable record says a process is alive and we must not
 * act as if it were gone, ours, or absent". The state name is part of the
 * message so a control refusal and a status read report the same truth.
 */
export function serviceOwnershipRecordError(entry: Pick<ServiceOwnershipEntry, "serviceId" | "pid" | "state">): string {
  const detail =
    entry.state === "own-verified"
      ? "记录的启动仍存活（所有权已核验），本 Host 未接管该进程"
      : entry.state === "orphaned-unverified"
        ? "记录的启动仍存活，但无法核验其所有权，拒绝任何信号与重复启动"
        : "记录的启动已结束，尚未清理";
  return `service-ownership-${entry.state}: ${entry.serviceId} pid ${entry.pid} ${detail}`;
}

/** Named refusal for a stop whose target identity could not be verified. */
export function serviceOwnershipUnverifiedError(serviceId: string, pid: number, detail: string): string {
  return `service-ownership-unverified: ${serviceId} pid ${pid} 身份未核验，拒绝发送信号（${detail}）`;
}

/**
 * Durable log of this task's service-launch identities. Deliberately dumb:
 * `get`/`all` return raw records, and every classification happens through
 * `classifyServiceOwnership` (so the same records always yield the same state
 * from the same OS state, and no cached truth can go stale).
 */
export interface ServiceOwnershipLog {
  /** The recorded launch of one service, raw (never a classified claim). */
  get(serviceId: string): ServiceOwnershipRecord | undefined;
  /** Every record of this task, raw. */
  all(): ServiceOwnershipRecord[];
  /** Persist one launch's identity; must be durable before the start resolves. */
  record(launch: { serviceId: string; pid: number; ownershipNonce: string; startedAt: string }): void;
  /**
   * Drop the record of a launch whose process is confirmed over. Scoped by the
   * nonce so a late writer cannot delete a newer launch's record.
   */
  release(launch: { serviceId: string; ownershipNonce: string }): void;
}

/** The on-disk log for one task folder. */
export function diskServiceOwnershipLog(input: { taskId: string; taskDir: string }): ServiceOwnershipLog {
  const read = (): ServiceOwnershipDiskRecord => readServiceOwnershipOnDisk(input.taskDir);
  // A record naming another task is never this log's own data: it is not
  // classified as ours and it is never deleted by our writes (the file is
  // task-scoped, so such an entry is corrupt or foreign and is left intact).
  const mine = (): ServiceOwnershipRecord[] => read().entries.filter((entry) => entry.taskId === input.taskId);
  const foreign = (): ServiceOwnershipRecord[] => read().entries.filter((entry) => entry.taskId !== input.taskId);
  const write = (entries: readonly ServiceOwnershipRecord[], previous: readonly ServiceOwnershipRecord[]): void => {
    if (entries.length === previous.length && entries.every((entry, index) => entry === previous[index])) return;
    writeServiceOwnershipOnDisk(input.taskDir, {
      version: SERVICE_OWNERSHIP_SCHEMA_VERSION,
      entries: [...foreign(), ...entries],
    });
  };
  return {
    get: (serviceId) => mine().find((entry) => entry.serviceId === serviceId),
    all: () => mine(),
    record: (launch) => {
      const previous = mine();
      const entry: ServiceOwnershipRecord = {
        schemaVersion: SERVICE_OWNERSHIP_SCHEMA_VERSION,
        taskId: input.taskId,
        serviceId: launch.serviceId,
        pid: launch.pid,
        ownershipNonce: launch.ownershipNonce,
        startedAt: launch.startedAt,
      };
      write([...previous.filter((existing) => existing.serviceId !== launch.serviceId), entry], previous);
    },
    release: (launch) => {
      const previous = mine();
      const kept = previous.filter((entry) => !(entry.serviceId === launch.serviceId && entry.ownershipNonce === launch.ownershipNonce));
      write(kept, previous);
    },
  };
}
