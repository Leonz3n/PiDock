/**
 * Cross-process mutual exclusion for repository-level worktree metadata
 * operations ([PiDock 03] (#6) 盒子 9: 两个任务并发创建共享仓库的 worktree 不产生相互覆盖).
 *
 * WHY THIS EXISTS: the conflict gate (`branchesInUse` / `takenPaths`,
 * `multi-repo-provision.ts` `checkRepoConflicts`) is a READ taken right before
 * the real `git worktree add -b`, and the two production services each hold
 * only an INTRA-PROCESS queue (`project-task-creation.ts`, `task-append.ts`).
 * Two processes (or two service instances) against the SAME shared source
 * repository therefore both pass the scan and both run the fetch / branch /
 * `worktree add` sequence in that one source checkout: `FETCH_HEAD` and the
 * repository's own refs and worktree metadata are shared mutable state, so one
 * task can be pinned to another task's fetched commit and two `worktree add`
 * runs interleave. This module is the missing exclusion.
 *
 * THE KEY IS THE REAL SOURCE-REPO PATH, never a task id and never a task
 * folder: two tasks sharing one source repo must contend on the SAME key, and
 * two tasks in different repos must not contend at all. The derivation MIRRORS
 * `host/path-coordination.ts` `classifyRealPath` instead of reinventing it —
 * the path is resolved with `realpathSync` (never compared as a lexical
 * string) and then normalized by that module's own `normalizeScopePath`. The
 * key SET is exactly the real paths: worktree metadata is per repository, so a
 * registered repository nested inside another one keeps its own key (see
 * `sourceRepoLockKeys`).
 *
 * WHERE THE LOCK LIVES: app-private storage — `<userData>/<WORKTREE_LOCK_DIRECTORY>`,
 * the same `userData` seam the intent store, the task-root index and the
 * provider store already use. NOTHING is ever written into a user's repository
 * or its `.git`: the lock is one file (named by the SHA-256 of the key, so the
 * app data directory does not even spell a machine path), plus a short-lived
 * takeover marker while one stale record is being replaced, and the replaced
 * record kept afterwards as a receipt.
 *
 * ATOMICITY: acquisition is a single `fs.open(file, "wx")` — the kernel-level
 * exclusive create. A stat-then-write is NOT a lock and is not used here. The
 * takeover marker is published with `fs.link` for the same reason: a marker a
 * contender could observe half-written would make its owner unjudgeable.
 *
 * STALE-LOCK POLICY, named `WORKTREE_LOCK_STALE_TAKEOVER` and deliberately the
 * only takeover path: a lock whose record names a process that is provably
 * gone (`process.kill(pid, 0)` answers ESRCH) is taken over, because a crash
 * must not block the app forever. Replacing it is itself exclusive: the
 * contender first wins a marker file of its own (`<hash>.lock.takeover`,
 * published with a COMPLETE record through `link`, so it is never observable
 * half-written), and only then re-reads the record and re-verifies that it is
 * still the very record it judged dead before renaming it away — a contender
 * that replaced that record in the meantime is refused BY NAME instead of being
 * evicted. A live lock is therefore never stolen, not even by two contenders
 * racing one stale record. The takeover is never silent — the stale record is
 * renamed atomically to a durable receipt (`<hash>.stale-<uuid>.lock`) inside
 * the app data directory and announced through `notify`; a crash DURING a
 * takeover leaves a stale marker, which the same named policy takes over, so a
 * crash can never block the repository either. A lock whose owner is still
 * alive (including EPERM, which proves a process exists but is not signalable),
 * or whose record — or takeover marker — cannot be read or parsed at all, is
 * REFUSED BY NAME: no silent steal, ever. Residual boundary, named rather than
 * hidden: the owner is identified by pid + start time, so a recycled pid can
 * make a dead owner's lock read as live; that is fail-closed (refuse, name the
 * pid and the age) and is why the refusal carries the owner identity and the
 * age for a human to act on.
 *
 * The module needs nothing beyond `node:fs` / `node:crypto` / `node:path` (no
 * new dependency) and returns named refusals instead of throwing, so every
 * caller decides how the name reaches the user.
 */

import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { normalizeScopePath } from "../host/path-coordination.js";

/** App-private directory (under `userData`) that holds every coordination lock. */
export const WORKTREE_LOCK_DIRECTORY = "worktree-metadata-locks";

/** The named stale-lock outcome: a provably-dead owner was replaced. */
export const WORKTREE_LOCK_STALE_TAKEOVER = "worktree-lock-stale-takeover";

/**
 * Suffix of the takeover marker (`<hash>.lock.takeover`): the file a contender
 * must win exclusively before it may replace another owner's stale record.
 */
export const WORKTREE_LOCK_TAKEOVER_SUFFIX = ".takeover";

/** Who is performing the repository-level operation, for the refusal message. */
export interface WorktreeLockOwner {
  taskId: string;
  /** Human label of the operation (`创建任务` / `追加仓库` / `任务准备恢复`). */
  label: string;
}

/** One lock file's content: the key it guards and the identity of its holder. */
export interface WorktreeLockRecord {
  version: 1;
  key: string;
  taskId: string;
  label: string;
  pid: number;
  at: string;
}

export interface WorktreeLockOptions {
  now?: () => Date;
  /** Liveness of the recorded owner pid; injectable so tests can pin both edges. */
  isProcessAlive?: (pid: number) => boolean;
  /** Announcement seam for a stale takeover (production: main's logger). */
  notify?: (message: string) => void;
}

export type WorktreeLockAcquisition =
  | { ok: true; keys: readonly string[]; release: () => void }
  | { ok: false; error: string };

/**
 * The real-path keys of the given shared source repositories, or a named
 * reason. Fail-closed by design: a checkout whose real path cannot be resolved
 * refuses instead of quietly running WITHOUT exclusion.
 */
export function sourceRepoLockKeys(
  sourceCheckouts: readonly string[],
): { ok: true; keys: string[] } | { ok: false; error: string } {
  const real: string[] = [];
  for (const checkout of sourceCheckouts) {
    let resolved: string;
    try {
      resolved = normalizeScopePath(realpathSync(checkout));
    } catch {
      return {
        ok: false,
        error:
          `worktree-lock-unavailable: 共享仓库的真实路径无法解析，拒绝在未取得仓库级互斥的情况下创建 worktree: ${checkout}`,
      };
    }
    if (resolved.length === 0) {
      return {
        ok: false,
        error: `worktree-lock-unavailable: 共享仓库路径为空，拒绝在未取得仓库级互斥的情况下创建 worktree: ${checkout}`,
      };
    }
    real.push(resolved);
  }
  // Worktree metadata is PER REPOSITORY: `/a` and `/a/b` have separate `.git`
  // directories, so the key set is the real paths themselves — never reduced to
  // the outermost one. Reducing them would let a task that selected only the
  // nested repository run its `fetch`/`worktree add` (and pin `FETCH_HEAD`)
  // concurrently with a task that selected both, which is the very overlap this
  // module exists to prevent. Deadlock-free ordering comes from `acquireKeys`'
  // own sort, so the set is handed over sorted here too (one spelling).
  return { ok: true, keys: [...new Set(real)].sort() };
}

export class WorktreeMetadataLock {
  private readonly userData: string;
  private readonly now: () => Date;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly notify: (message: string) => void;
  /** Keys this instance currently holds, so a release can never free another's. */
  private readonly held = new Map<string, WorktreeLockRecord>();

  // Field declarations rather than constructor parameter properties: this
  // module is also loaded by a plain `node` child process in the cross-process
  // evidence suite, and Node's strip-only TypeScript does not transform
  // parameter properties.
  constructor(userData: string, options: WorktreeLockOptions = {}) {
    this.userData = userData;
    this.now = options.now ?? (() => new Date());
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.notify = options.notify ?? (() => undefined);
  }

  /** The absolute app-private lock file of one real-path key. */
  fileFor(key: string): string {
    return join(this.userData, WORKTREE_LOCK_DIRECTORY, `${createHash("sha256").update(key).digest("hex")}.lock`);
  }

  /**
   * Acquire every key derived from these shared source repositories, or refuse
   * by name and hold nothing. A partial acquisition is released again, so a
   * failed multi-repo acquisition leaves each earlier key free.
   */
  acquireFor(sourceCheckouts: readonly string[], owner: WorktreeLockOwner): WorktreeLockAcquisition {
    const derived = sourceRepoLockKeys(sourceCheckouts);
    if (!derived.ok) return { ok: false, error: derived.error };
    return this.acquireKeys(derived.keys, owner);
  }

  acquireKeys(keys: readonly string[], owner: WorktreeLockOwner): WorktreeLockAcquisition {
    const ordered = [...new Set(keys.map((key) => normalizeScopePath(key)))].filter((key) => key.length > 0).sort();
    if (ordered.length === 0) return { ok: true, keys: [], release: () => undefined };
    const directory = this.ensureDirectory();
    if (!directory.ok) return { ok: false, error: directory.error };
    const acquired: string[] = [];
    for (const key of ordered) {
      const outcome = this.acquireOne(key, owner);
      if (!outcome.ok) {
        for (const held of acquired.splice(0)) this.releaseKey(held);
        return { ok: false, error: outcome.error };
      }
      acquired.push(key);
      this.held.set(key, outcome.record);
    }
    let released = false;
    return {
      ok: true,
      keys: ordered,
      release: () => {
        // Idempotent: a caller that releases in `finally` and again on a
        // cleanup path must not free a lock a later operation acquired.
        if (released) return;
        released = true;
        for (const key of ordered) this.releaseKey(key);
      },
    };
  }

  private acquireOne(
    key: string,
    owner: WorktreeLockOwner,
  ): { ok: true; record: WorktreeLockRecord } | { ok: false; error: string } {
    const file = this.fileFor(key);
    // Bounded: one takeover attempt, then either we hold it or we refuse. No
    // spin, no sleep, no unbounded retry.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const record = this.newRecord(key, owner);
      const created = this.createExclusive(file, record);
      if (created.ok) return { ok: true, record };
      if (!created.exclusive) return { ok: false, error: created.error };
      const observed = this.readRecord(file);
      if (!observed.ok) {
        return { ok: false, error: this.unreadableLockError(key) };
      }
      if (this.isProcessAlive(observed.record.pid) || attempt === 1) {
        return { ok: false, error: this.heldError(key, observed.record) };
      }
      // Only a provably-gone owner reaches here, and only once.
      const taken = this.takeOver(file, key, observed.record, owner);
      if (!taken.ok) return { ok: false, error: taken.error };
    }
    // Unreachable: the loop returns on its second iteration.
    return { ok: false, error: `worktree-locked: 共享仓库 ${key} 的仓库级操作正在进行，本次操作未创建任何内容` };
  }

  private createExclusive(
    file: string,
    record: WorktreeLockRecord,
  ): { ok: true } | { ok: false; exclusive: boolean; error: string } {
    let fd: number;
    try {
      fd = openSync(file, "wx", 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return { ok: false, exclusive: true, error: "" };
      return {
        ok: false,
        exclusive: false,
        error: `worktree-lock-unavailable: 应用数据目录下的仓库级协调锁不可写入（${String(code)}），拒绝在未取得互斥的情况下继续`,
      };
    }
    try {
      writeFileSync(fd, JSON.stringify(record));
      fsyncSync(fd);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // The record never became durable: drop the half-written file so a failed
      // acquire cannot leave behind a lock this process does not hold.
      this.removeQuietly(file);
      return {
        ok: false,
        exclusive: false,
        error: `worktree-lock-unavailable: 仓库级协调锁写入失败（${String(code)}），拒绝在未取得互斥的情况下继续`,
      };
    } finally {
      try {
        closeSync(fd);
      } catch {
        /* the descriptor is not needed after the write attempt */
      }
    }
    this.syncDirectory(this.directory());
    return { ok: true };
  }

  private readRecord(file: string): { ok: true; record: WorktreeLockRecord } | { ok: false; reason: "absent" | "unreadable" } {
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
        typeof row["label"] !== "string" ||
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
          label: row["label"],
          pid: row["pid"],
          at: row["at"],
        },
      };
    } catch {
      return { ok: false, reason: "unreadable" };
    }
  }

  /**
   * Replace the record of a provably-gone owner, under two conditions that make
   * "never silently steal a live lock" true: (1) only ONE contender at a time
   * may replace this key's record, because it must win the takeover marker
   * first, and (2) the record is re-read and re-verified as the LAST step before
   * the rename, so a contender that installed its own live lock in the meantime
   * is refused by name instead of being evicted (two holders of one key).
   */
  private takeOver(
    file: string,
    key: string,
    stale: WorktreeLockRecord,
    owner: WorktreeLockOwner,
  ): { ok: true } | { ok: false; error: string } {
    const marker = `${file}${WORKTREE_LOCK_TAKEOVER_SUFFIX}`;
    const won = this.winTakeoverMarker(marker, key, owner);
    if (!won.ok) return won;
    try {
      const current = this.readRecord(file);
      if (!current.ok) {
        if (current.reason === "absent") {
          // Released under us between the read and the marker: the slot is free,
          // so the retry can just create.
          return { ok: true };
        }
        return { ok: false, error: this.unreadableLockError(key) };
      }
      if (current.record.pid !== stale.pid || current.record.at !== stale.at || current.record.taskId !== stale.taskId) {
        // Somebody else replaced the record while we were winning the marker:
        // the holder of THAT record is not ours to evict.
        return { ok: false, error: this.heldError(key, current.record) };
      }
      return this.retireRecord(file, current.record, `共享仓库 ${key} 的锁`);
    } finally {
      this.removeQuietly(marker);
    }
  }

  /**
   * Win the exclusive right to replace one key's stale record. Bounded: two
   * attempts, no spin, never a wait. A marker whose owner is provably gone is
   * itself taken over under the SAME named policy, so a crash during a takeover
   * cannot block the repository forever; a marker whose owner is alive, or that
   * cannot be read, is refused by name.
   */
  private winTakeoverMarker(marker: string, key: string, owner: WorktreeLockOwner): { ok: true } | { ok: false; error: string } {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const won = this.publishExclusive(marker, this.newRecord(key, owner));
      if (won.ok) return { ok: true };
      if (!won.exclusive) return { ok: false, error: won.error };
      const observed = this.readRecord(marker);
      if (!observed.ok) {
        // Gone under us (its owner finished or crashed): there is nothing to
        // clear and nothing to rename, so try the exclusive create once more.
        if (observed.reason === "absent") continue;
        return {
          ok: false,
          error: `worktree-lock-unreadable: 共享仓库 ${key} 的仓库级协调锁接管标记不可读取（标记损坏），拒绝在未确认接管状态的情况下继续`,
        };
      }
      if (this.isProcessAlive(observed.record.pid) || attempt === 1) {
        return { ok: false, error: this.takeoverInProgressError(key, observed.record) };
      }
      const cleared = this.retireRecord(marker, observed.record, `共享仓库 ${key} 的接管标记`);
      if (!cleared.ok) return cleared;
    }
    // Unreachable: the loop returns on its second iteration.
    return {
      ok: false,
      error: `worktree-locked: 共享仓库 ${key} 的失效锁接管未取得互斥标记，本次操作未创建任何分支、工作副本或记录，请稍后重试`,
    };
  }

  /**
   * Create `path` exclusively WITH its record already in place: the record goes
   * to a private temporary file first and is published with `link`, which is
   * atomic and fails with EEXIST when `path` already exists. `open` + `write`
   * alone would let a reader observe a half-written record and misjudge the
   * owner — and a marker whose owner cannot be judged would be indistinguishable
   * from a live one, i.e. a permanent refusal.
   */
  private publishExclusive(
    path: string,
    record: WorktreeLockRecord,
  ): { ok: true } | { ok: false; exclusive: boolean; error: string } {
    const temporary = `${path}.${randomUUID()}.tmp`;
    let prepared: { ok: true } | { ok: false; error: string } = { ok: true };
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
      prepared = { ok: false, error: this.markerUnavailableError((error as NodeJS.ErrnoException).code) };
    }
    try {
      if (!prepared.ok) return { ok: false, exclusive: false, error: prepared.error };
      try {
        linkSync(temporary, path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") return { ok: false, exclusive: true, error: "" };
        return { ok: false, exclusive: false, error: this.markerUnavailableError(code) };
      }
      this.syncDirectory(this.directory());
      return { ok: true };
    } finally {
      this.removeQuietly(temporary);
    }
  }

  /**
   * Atomically move a VERIFIED record out of the way into a durable receipt and
   * announce it. Only called for a record this process verified (a provably-dead
   * owner, and for the lock itself only while holding the marker), so the
   * receipt always names the owner that was actually evicted.
   */
  private retireRecord(path: string, stale: WorktreeLockRecord, what: string): { ok: true } | { ok: false; error: string } {
    const receipt = `${path}.stale-${randomUUID()}.lock`;
    try {
      renameSync(path, receipt);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ENOENT: the record was released (or replaced) between the verification
      // and the rename — the slot is free, so the retry can just create.
      if (code === "ENOENT") return { ok: true };
      return {
        ok: false,
        error: `worktree-lock-unavailable: 接管${what}失败（${String(code)}），拒绝在未取得互斥的情况下继续`,
      };
    }
    this.syncDirectory(this.directory());
    this.notify(
      `${WORKTREE_LOCK_STALE_TAKEOVER}: ${what}已失效（由任务 ${stale.taskId} 的${stale.label}持有 · ` +
        `进程 ${String(stale.pid)} 已不存在 · 开始于 ${stale.at}），本次操作接管并保留凭据 ${basename(receipt)}`,
    );
    return { ok: true };
  }

  private unreadableLockError(key: string): string {
    return (
      `worktree-lock-unreadable: 共享仓库 ${key} 的仓库级协调锁记录不可读取，无法确认持有者，` +
      `拒绝在未确认持有者的情况下继续（应用数据目录下的锁文件损坏）`
    );
  }

  private markerUnavailableError(code: unknown): string {
    return `worktree-lock-unavailable: 应用数据目录下的锁接管标记不可写入（${String(code)}），拒绝在未取得互斥的情况下继续`;
  }

  private takeoverInProgressError(key: string, record: WorktreeLockRecord): string {
    return (
      `worktree-locked: 共享仓库 ${key} 的失效锁正由任务 ${record.taskId} 的${record.label}接管` +
      `（进程 ${String(record.pid)} · 已持续 ${this.ageSeconds(record)} 秒），` +
      `本次操作未创建任何分支、工作副本或记录，请等待接管完成后重试`
    );
  }

  private releaseKey(key: string): void {
    const record = this.held.get(key);
    if (record === undefined) return;
    this.held.delete(key);
    const observed = this.readRecord(this.fileFor(key));
    // Never delete a lock somebody else now holds: only a record this instance
    // wrote is released.
    if (!observed.ok || observed.record.pid !== record.pid || observed.record.at !== record.at) return;
    this.removeQuietly(this.fileFor(key));
  }

  private ensureDirectory(): { ok: true } | { ok: false; error: string } {
    const directory = this.directory();
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!lstatSync(directory).isDirectory()) {
        return { ok: false, error: `worktree-lock-unavailable: 应用数据目录下的协调锁目录不是目录: ${directory}` };
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: `worktree-lock-unavailable: 应用数据目录下的协调锁目录不可用（${String((error as NodeJS.ErrnoException).code)}）`,
      };
    }
  }

  private directory(): string {
    return join(this.userData, WORKTREE_LOCK_DIRECTORY);
  }

  private newRecord(key: string, owner: WorktreeLockOwner): WorktreeLockRecord {
    return { version: 1, key, taskId: owner.taskId, label: owner.label, pid: process.pid, at: this.now().toISOString() };
  }

  private heldError(key: string, record: WorktreeLockRecord): string {
    return (
      `worktree-locked: 共享仓库 ${key} 的仓库级操作正在进行（任务 ${record.taskId} 的${record.label}` +
      ` · 进程 ${String(record.pid)} · 已持续 ${this.ageSeconds(record)} 秒），本次操作未创建任何分支、工作副本或记录，请等待其完成后重试`
    );
  }

  private ageSeconds(record: WorktreeLockRecord): string {
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

  private syncDirectory(directory: string): void {
    if (process.platform === "win32") return;
    try {
      const fd = openSync(directory, "r");
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

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH is the only answer that proves the owner is gone; EPERM (and any
    // other failure) means a process exists but is not signalable, which is NOT
    // proof of death, so a live-looking lock is never stolen.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
