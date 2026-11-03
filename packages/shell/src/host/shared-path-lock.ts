/**
 * Cross-process shared real-path write lock ([Pencil T06] #141).
 *
 * WHY THIS EXISTS: `path-coordination.ts` is a *pure table* and the production
 * wiring gives every task Host its own copy (`host.ts`), because one task is one
 * utillyProcess. Two real tasks that share a plain directory (or an existing Git
 * checkout used directly) are therefore two processes, and an in-memory table
 * cannot serialize them: it would only claim coordination while the same
 * resolved path is written by two tasks of the SAME process. This module is the
 * missing cross-process half, and it reuses the atomic lock primitive that
 * #6 盒 9 built for worktree metadata (`main/worktree-metadata-lock.ts`): an
 * app-private directory (`<userData>`), a single `fs.open(..., "wx")` (or an
 * `fs.link` publish of a COMPLETE record) for the exclusive create, a named
 * stale-owner policy and a durable receipt — never a stat-then-write, never a
 * silent steal.
 *
 * THE KEY IS THE REAL PATH, never a task id, never a lexical spelling and never
 * a link name. The caller hands in paths that are already resolved with
 * `fs.realpath` (Host: `TaskWorkspaceHost.pathScopeOf` → `classifyRealPath`,
 * i.e. the SAME rule the in-process table uses), and the keys are normalized by
 * that module's own `normalizeScopePath`. A link retargeted between two
 * acquisitions therefore resolves to a different key and is judged again from
 * scratch: retargeting a link can never widen what the previous claim covered.
 *
 * OVERLAP = same real path, or one is an ancestor of the other (segment-aware:
 * `/a/bc` never overlaps `/a/b`), decided by the production `pathScopeOverlaps`.
 * Disjoint directories run in parallel; no global lock is introduced.
 *
 * BECAUSE OVERLAP IS ANCESTOR/DESCENDANT, one file per key is not enough to
 * decide a claim: `/a` and `/a/b` are different files. Acquisition is therefore
 * "publish my complete record(s) exclusively, then read every other record and
 * judge the overlap". Two contenders that start at the same instant can both see
 * each other, so the winner is chosen by a TOTAL order over
 * `(at, hostInstance, pid, key)` that both sides compute from the same records:
 * the later record yields. Exactly one holder remains (the earlier one), and a
 * contender that is refused always withdraws its own record before returning —
 * so a refusal leaves nothing behind.
 *
 * STALE OWNERSHIP IS RECOVERED BY NAME, never silently: a record is provably
 * dead when its pid is provably gone (`process.kill(pid, 0)` → ESRCH) OR when
 * the named Host instance's marker file is gone while the owning process is not
 * signalable (a recycled pid). Recovery is announced as `lock-owner-dead`, names
 * the task/session/Host instance/pid/age it evicted, and keeps the evicted
 * record as a durable receipt. A LIVE owner, an unreadable record or an
 * unreadable takeover marker is refused by name — the lock never steals what it
 * cannot judge.
 *
 * The module needs nothing beyond `node:fs` / `node:crypto` / `node:path` and
 * the one rule module, and it answers named refusals instead of throwing, so
 * every caller decides how the name reaches the user.
 */

import {
  closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { normalizeScopePath, pathScopeOverlaps, scopeKeysFor } from "./path-coordination.js";

/** App-private directory (under `userData`) that holds the shared-path locks. */
export const SHARED_PATH_LOCK_DIRECTORY = "shared-path-locks";

/** The named stale-owner outcome: a provably-dead holder was replaced. */
export const SHARED_PATH_LOCK_OWNER_DEAD = "lock-owner-dead";

/** Suffix of the takeover marker a contender must win before replacing a record. */
export const SHARED_PATH_LOCK_TAKEOVER_SUFFIX = ".takeover";

/** Bound on records read for one claim: one directory, never an unbounded scan. */
export const MAX_SHARED_PATH_LOCK_FILES = 512;

/** Who is writing, for the refusal and the receipt. Never a pid alone. */
export interface SharedPathLockOwner {
  taskId: string;
  sessionId: string;
  /** Human label of the operation (`回合工具 fs.write` / `Agent 工具 fs.write`). */
  label: string;
}

/** One lock file's content: the real path it holds and the identity of its holder. */
export interface SharedPathLockRecord {
  version: 1;
  /** Normalized REAL path (`realpath` + `normalizeScopePath`). */
  key: string;
  taskId: string;
  sessionId: string;
  label: string;
  /** Nonce of the Host instance that took the lock (never reused across starts). */
  hostInstance: string;
  pid: number;
  at: string;
}

export interface SharedPathLockOptions {
  now?: () => Date;
  /** Liveness of the recorded owner pid; injectable so tests pin both edges. */
  isProcessAlive?: (pid: number) => boolean;
  /** Announcement seam for a named stale takeover (production: the Host logger). */
  notify?: (message: string) => void;
  /** Host-instance nonce; production default is a fresh random value per instance. */
  hostInstance?: string;
  /** Bound on records read for one claim; injectable so a test need not write 512 files. */
  maxRecords?: number;
}

export type SharedPathLockOutcome =
  | { ok: true; added: readonly string[] }
  | { ok: false; error: string };

const RECORD_FILE = /^[0-9a-f]{64}\.lock$/;

/**
 * One process's view of the app-private shared-path lock. A claim covers the
 * session's whole key set (claims merge, exactly like
 * `SharedPathCoordinator.claim`), and `release` mirrors its `keepPaths` /
 * release-all semantics, so the two layers cannot disagree about who still holds
 * what.
 */
export class SharedPathLock {
  private readonly root: string;
  private readonly now: () => Date;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly notify: (message: string) => void;
  private readonly hostInstance: string;
  private readonly maxRecords: number;
  /** taskId::sessionId -> key -> the exact record this process wrote. */
  private readonly held = new Map<string, Map<string, SharedPathLockRecord>>();
  private instancePublished = false;

  // Field declarations rather than constructor parameter properties: this
  // module is also loaded by a plain `node` child process in the cross-process
  // suite, and Node's strip-only TypeScript does not transform them.
  constructor(userDataOrLockDirectory: string, options: SharedPathLockOptions = {}) {
    this.root = userDataOrLockDirectory.endsWith(SHARED_PATH_LOCK_DIRECTORY)
      ? userDataOrLockDirectory
      : join(userDataOrLockDirectory, SHARED_PATH_LOCK_DIRECTORY);
    this.now = options.now ?? (() => new Date());
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.notify = options.notify ?? (() => undefined);
    this.hostInstance = options.hostInstance ?? randomUUID();
    this.maxRecords = options.maxRecords ?? MAX_SHARED_PATH_LOCK_FILES;
    // A crashed process leaves its marker behind, which is harmless: the pid
    // check still proves it gone. The marker is what proves a RECYCLED pid is
    // not the original holder.
    process.once("exit", () => this.removeInstanceMarker());
  }

  /** The nonce naming this Host instance in every record and refusal. */
  get instanceId(): string {
    return this.hostInstance;
  }

  /** The app-private lock directory (tests and evidence read it directly). */
  get directory(): string {
    return this.root;
  }

  /** The absolute lock file of one real-path key. */
  fileFor(key: string): string {
    return join(this.root, `${createHash("sha256").update(normalizeScopePath(key)).digest("hex")}.lock`);
  }

  /** The keys a session of one task currently holds in this process. */
  heldKeys(taskId: string, sessionId: string): string[] {
    return [...(this.held.get(`${taskId}::${sessionId}`)?.keys() ?? [])].sort();
  }

  /**
   * Hold every key of one session's claim, or refuse by name and hold nothing
   * new. Keys the session already holds are not re-acquired (a nested tool
   * inside a turn is not a conflict with itself).
   */
  claim(owner: SharedPathLockOwner, paths: readonly string[]): SharedPathLockOutcome {
    const keys = scopeKeysFor(paths).filter((key) => key.length > 0);
    if (keys.length === 0) return { ok: true, added: [] };
    const id = `${owner.taskId}::${owner.sessionId}`;
    const already = this.held.get(id);
    const wanted = keys.filter((key) => already?.has(key) !== true);
    if (wanted.length === 0) return { ok: true, added: [] };
    const published = this.publish(owner, wanted);
    if (!published.ok) return published;
    return { ok: true, added: published.added };
  }

  /**
   * Release one session's keys, keeping `keepPaths` (the pre-claim keys of a
   * failed attempt) — the same partial-release rule the in-process table uses.
   */
  release(input: { taskId: string; sessionId: string; keepPaths?: readonly string[] }): string[] {
    const id = `${input.taskId}::${input.sessionId}`;
    const records = this.held.get(id);
    if (records === undefined) return [];
    const keep = new Set(scopeKeysFor(input.keepPaths ?? []));
    const released: string[] = [];
    for (const [key, record] of [...records.entries()]) {
      // A kept key is kept by itself or by an ancestor/descendant spelling of
      // itself: the claim reduction is one rule, so the keep check is too.
      const kept = [...keep].some((kept) => pathScopeOverlaps(kept, key));
      if (kept) continue;
      this.removeOwn(record);
      records.delete(key);
      released.push(key);
    }
    if (records.size === 0) this.held.delete(id);
    return released;
  }

  /** Cancel / dispose: drop every key of one task. */
  releaseTask(taskId: string): string[] {
    const released: string[] = [];
    for (const [id, records] of [...this.held.entries()]) {
      if (!id.startsWith(`${taskId}::`)) continue;
      for (const [key, record] of [...records.entries()]) {
        this.removeOwn(record);
        records.delete(key);
        released.push(key);
      }
      this.held.delete(id);
    }
    return released;
  }

  /** Best-effort instance marker removal (process exit and explicit dispose). */
  dispose(): void {
    this.releaseTask("");
    this.removeInstanceMarker();
  }

  /**
   * Publish one record per new key, then judge every other record. The overall
   * result is all-or-nothing: a refusal withdraws exactly the records this call
   * published.
   */
  private publish(owner: SharedPathLockOwner, keys: readonly string[]): SharedPathLockOutcome {
    const directory = this.ensureDirectory();
    if (!directory.ok) return directory;
    const mine: SharedPathLockRecord[] = [];
    const added: string[] = [];
    const withdraw = (): void => {
      for (const record of mine) this.removeOwn(record);
      // Also drop the in-memory registration for a half-published claim.
      const id = `${owner.taskId}::${owner.sessionId}`;
      const records = this.held.get(id);
      for (const record of mine) records?.delete(record.key);
      if (records?.size === 0) this.held.delete(id);
    };
    for (const key of keys) {
      const outcome = this.publishOne(owner, key);
      if (!outcome.ok) {
        withdraw();
        return outcome;
      }
      mine.push(outcome.record);
      added.push(outcome.record.key);
    }
    const id = `${owner.taskId}::${owner.sessionId}`;
    this.hold(id, mine);
    const judged = this.judge(mine);
    if (!judged.ok) {
      withdraw();
      return judged;
    }
    return { ok: true, added };
  }

  private hold(id: string, records: readonly SharedPathLockRecord[]): void {
    const existing = this.held.get(id) ?? new Map<string, SharedPathLockRecord>();
    for (const record of records) existing.set(record.key, record);
    this.held.set(id, existing);
  }

  /**
   * Read every record this process does NOT hold and judge the overlap:
   *   - a provably dead owner is recovered by name (receipt + `lock-owner-dead`);
   *   - an unreadable record/marker is refused (never judged, never stolen);
   *   - a live overlapping holder wins when its record orders BEFORE ours (it
   *     published first, so it is the holder) and we refuse naming it;
   *   - a live overlapping holder that orders AFTER ours is a contender that
   *     will see our record and yield, so we keep the claim.
   */
  private judge(mine: readonly SharedPathLockRecord[]): SharedPathLockOutcome {
    const directory = this.enumerate();
    if (!directory.ok) return directory;
    for (const file of directory.files) {
      const observed = this.readRecord(file);
      if (!observed.ok) {
        if (observed.reason === "absent") continue;
        return { ok: false, error: this.unreadableError(file) };
      }
      const other = observed.record;
      if (other.hostInstance === this.hostInstance) continue;
      const overlaps = mine.filter((record) => pathScopeOverlaps(record.key, other.key));
      if (overlaps.length === 0) continue;
      const dead = this.provablyDead(other);
      if (!dead) {
        const lost = overlaps.find((record) => compareRecords(other, record) < 0);
        if (lost !== undefined) return { ok: false, error: this.heldError(lost.key, other) };
        continue;
      }
      const recovered = this.retire(file, other);
      if (!recovered.ok) return recovered;
    }
    return { ok: true, added: mine.map((record) => record.key) };
  }

  /** Publish (or take over) exactly one key's record. */
  private publishOne(
    owner: SharedPathLockOwner,
    key: string,
  ): { ok: true; record: SharedPathLockRecord } | { ok: false; error: string } {
    const file = this.fileFor(key);
    // Bounded: one takeover attempt, then either we hold it or we refuse.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const record = this.newRecord(key, owner);
      const created = this.publishExclusive(file, record);
      if (created.ok) return { ok: true, record };
      if (!created.exclusive) return { ok: false, error: created.error };
      const observed = this.readRecord(file);
      if (!observed.ok) return { ok: false, error: this.unreadableError(file) };
      if (!this.provablyDead(observed.record) || attempt === 1) {
        return { ok: false, error: this.heldError(key, observed.record) };
      }
      const recovered = this.retire(file, observed.record);
      if (!recovered.ok) return recovered;
    }
    return { ok: false, error: `shared-path-locked: 真实路径 ${key} 的写入协调未取得互斥，本次写入未执行` };
  }

  /**
   * Create `file` exclusively WITH its record already in place: the record goes
   * to a private temporary file first and is published with `link`, which is
   * atomic and fails with EEXIST when the file already exists. `open`+`write`
   * alone would let a scan observe a half-written record and misjudge the owner
   * (an unjudgeable owner would be a permanent refusal).
   */
  private publishExclusive(
    file: string,
    record: SharedPathLockRecord,
  ): { ok: true } | { ok: false; exclusive: boolean; error: string } {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(record));
        fsyncSync(fd);
      } finally {
        try {
          closeSync(fd);
        } catch {
          /* the descriptor is not needed after the write attempt */
        }
      }
    } catch (error) {
      return { ok: false, exclusive: false, error: this.unavailableError((error as NodeJS.ErrnoException).code) };
    }
    try {
      try {
        linkSync(temporary, file);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") return { ok: false, exclusive: true, error: "" };
        return { ok: false, exclusive: false, error: this.unavailableError(code) };
      }
      this.syncDirectory();
      return { ok: true };
    } finally {
      this.removeQuietly(temporary);
    }
  }

  /**
   * Replace a record of a provably-dead owner, announcing it by name and keeping
   * it as a durable receipt. `rename` is atomic: if the record changed under us
   * (ENOENT) the slot is free and the caller's retry creates its own — a live
   * record that replaced it is never touched.
   */
  private retire(file: string, stale: SharedPathLockRecord): { ok: true } | { ok: false; error: string } {
    const receipt = `${file}.stale-${randomUUID()}.lock`;
    try {
      renameSync(file, receipt);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { ok: true };
      return { ok: false, error: this.unavailableError(code) };
    }
    this.syncDirectory();
    this.notify(
      `${SHARED_PATH_LOCK_OWNER_DEAD}: 共享真实路径 ${stale.key} 的写入持有者已不存在` +
        `（任务 ${stale.taskId} 的会话 ${stale.sessionId} · ${stale.label} · Host 实例 ${stale.hostInstance} · ` +
        `进程 ${String(stale.pid)} · 开始于 ${stale.at}），本次写入按具名恢复接管并保留凭据 ${basename(receipt)}`,
    );
    return { ok: true };
  }

  /** The owner is provably gone: its pid is gone, or its Host instance marker is. */
  private provablyDead(record: SharedPathLockRecord): boolean {
    if (!this.isProcessAlive(record.pid)) return true;
    // A recycled pid is not the original holder: the marker names the instance.
    return !existsSync(this.instanceMarker(record.hostInstance));
  }

  private readRecord(file: string): { ok: true; record: SharedPathLockRecord } | { ok: false; reason: "absent" | "unreadable" } {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(file, { bigint: true });
    } catch {
      return { ok: false, reason: "absent" };
    }
    if (!stat.isFile() || stat.size <= 0n || stat.size > 4096n) return { ok: false, reason: "unreadable" };
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "unreadable" };
      const row = parsed as Record<string, unknown>;
      if (
        row["version"] !== 1 ||
        typeof row["key"] !== "string" ||
        typeof row["taskId"] !== "string" ||
        typeof row["sessionId"] !== "string" ||
        typeof row["label"] !== "string" ||
        typeof row["hostInstance"] !== "string" ||
        typeof row["pid"] !== "number" ||
        !Number.isInteger(row["pid"]) ||
        typeof row["at"] !== "string" ||
        !Number.isFinite(Date.parse(row["at"]))
      ) {
        return { ok: false, reason: "unreadable" };
      }
      return {
        ok: true,
        record: {
          version: 1,
          key: row["key"],
          taskId: row["taskId"],
          sessionId: row["sessionId"],
          label: row["label"],
          hostInstance: row["hostInstance"],
          pid: row["pid"],
          at: row["at"],
        },
      };
    } catch {
      return { ok: false, reason: "unreadable" };
    }
  }

  /** Every key record in the lock directory, bounded (receipts and markers skipped). */
  private enumerate(): { ok: true; files: string[] } | { ok: false; error: string } {
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch (error) {
      return { ok: false, error: this.unavailableError((error as NodeJS.ErrnoException).code) };
    }
    const files = names.filter((name) => RECORD_FILE.test(name)).map((name) => join(this.root, name));
    if (files.length > this.maxRecords) {
      return {
        ok: false,
        error: `shared-path-lock-unavailable: 共享路径锁目录记录过多（${files.length} > ${this.maxRecords}），拒绝在未核验其他持有者的情况下写入`,
      };
    }
    return { ok: true, files };
  }

  private removeOwn(record: SharedPathLockRecord): void {
    const file = this.fileFor(record.key);
    const observed = this.readRecord(file);
    // Never delete a record somebody else now holds.
    if (!observed.ok) return;
    if (
      observed.record.pid !== record.pid ||
      observed.record.at !== record.at ||
      observed.record.hostInstance !== record.hostInstance
    ) {
      return;
    }
    this.removeQuietly(file);
  }

  private ensureDirectory(): { ok: true } | { ok: false; error: string } {
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      if (!lstatSync(this.root).isDirectory()) {
        return { ok: false, error: `shared-path-lock-unavailable: 应用数据目录下的共享路径锁目录不是目录: ${this.root}` };
      }
    } catch (error) {
      return { ok: false, error: this.unavailableError((error as NodeJS.ErrnoException).code) };
    }
    if (!this.instancePublished) {
      // A live instance always has its marker; this is what lets a recycled pid
      // be told apart from the original holder later.
      try {
        writeFileSync(this.instanceMarker(this.hostInstance), JSON.stringify({
          version: 1, hostInstance: this.hostInstance, pid: process.pid, at: this.now().toISOString(),
        }), { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          return { ok: false, error: this.unavailableError((error as NodeJS.ErrnoException).code) };
        }
      }
      this.instancePublished = true;
    }
    return { ok: true };
  }

  private instanceMarker(hostInstance: string): string {
    return join(this.root, `host-instance-${hostInstance}.json`);
  }

  private removeInstanceMarker(): void {
    if (!this.instancePublished) return;
    this.instancePublished = false;
    this.removeQuietly(this.instanceMarker(this.hostInstance));
  }

  private newRecord(key: string, owner: SharedPathLockOwner): SharedPathLockRecord {
    return {
      version: 1,
      key: normalizeScopePath(key),
      taskId: owner.taskId,
      sessionId: owner.sessionId,
      label: owner.label,
      hostInstance: this.hostInstance,
      pid: process.pid,
      at: this.now().toISOString(),
    };
  }

  /** The refusal names the REAL holder: task, session, label, Host instance, pid, age. */
  private heldError(key: string, record: SharedPathLockRecord): string {
    return (
      `shared-path-locked: 真实路径 ${key} 正由任务 ${record.taskId} 的会话 ${record.sessionId} 写入` +
      `（${record.label} · Host 实例 ${record.hostInstance} · 进程 ${String(record.pid)} · 已持续 ${this.ageSeconds(record)} 秒），` +
      `本次写入未执行；持有者不会被他人的写入静默顶替`
    );
  }

  private unreadableError(file: string): string {
    return (
      `shared-path-lock-unreadable: 共享路径锁记录 ${basename(file)} 不可读取，无法确认持有者，` +
      `拒绝在未确认持有者的情况下写入（应用数据目录下的锁记录损坏）`
    );
  }

  private unavailableError(code: unknown): string {
    return `shared-path-lock-unavailable: 应用数据目录下的共享路径锁不可用（${String(code)}），拒绝在未取得互斥的情况下写入`;
  }

  private ageSeconds(record: SharedPathLockRecord): string {
    const started = Date.parse(record.at);
    if (!Number.isFinite(started)) return "未知";
    return String(Math.max(0, Math.round((this.now().getTime() - started) / 1000)));
  }

  private removeQuietly(file: string): void {
    try {
      unlinkSync(file);
    } catch {
      /* already gone: releasing twice is not a failure */
    }
  }

  private syncDirectory(): void {
    if (process.platform === "win32") return;
    try {
      const fd = openSync(this.root, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      /* the directory fsync is durability, never a reason to refuse */
    }
  }
}

/** Total order over records; both contenders compute the same winner. */
function compareRecords(left: SharedPathLockRecord, right: SharedPathLockRecord): number {
  const order = [`${left.at}`, left.hostInstance, String(left.pid), left.key].join("\u0000");
  const other = [`${right.at}`, right.hostInstance, String(right.pid), right.key].join("\u0000");
  return order < other ? -1 : order > other ? 1 : 0;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH is the only answer that proves the owner is gone; EPERM means a
    // process exists but is not signalable, which is NOT proof of death.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
