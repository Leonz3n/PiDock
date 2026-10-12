/**
 * [PiDock 03] (#6 盒子 9) 仓库级 worktree 元数据操作的跨进程互斥：锁本身的证据.
 *
 * The behaviour under test is `main/worktree-metadata-lock.ts`: a lock keyed by
 * the REAL path of the shared source repository, living in app-private storage,
 * taken with one atomic `fs.open(..., "wx")`, refusing by name while somebody
 * else holds it, and applying a NAMED stale policy.
 *
 * Every assertion here is about the FILE protocol, so the real-path facts are
 * built from real temporary directories (`realpath` of a symlinked spelling
 * included) and the "provably gone" owner is a REAL exited process's pid. The
 * cross-process and real-git evidence (two processes, real worktrees, the
 * TOCTOU window) is `worktree-metadata-lock-concurrency.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WORKTREE_LOCK_DIRECTORY,
  WORKTREE_LOCK_STALE_TAKEOVER,
  WorktreeMetadataLock,
} from "./worktree-metadata-lock.js";

const homes: string[] = [];

/** A real source checkout look-alike plus the app-private storage of one profile. */
function setup(): { home: string; source: string; other: string; profile: string } {
  const home = mkdtempSync(join(tmpdir(), "pidock-lock-"));
  homes.push(home);
  const source = join(home, "source");
  const other = join(home, "other");
  const profile = join(home, "profile");
  mkdirSync(source);
  mkdirSync(other);
  mkdirSync(profile);
  // A marker so "nothing was written into the repository" is checkable.
  writeFileSync(join(source, "README.md"), "source\n");
  return { home, source, other, profile };
}

function readRecord(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function staleReceipts(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory).filter((name) => name.includes(".stale-")) : [];
}

/** A pid that is provably gone: a real child process that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  const pid = child.pid;
  if (typeof pid !== "number" || pid <= 0) throw new Error("could not spawn a throwaway process for a dead pid");
  return pid;
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("[PiDock 03] (#6 盒子 9) the repository-level worktree lock", () => {
  it("admits exactly one holder of one real source path and refuses the other BY NAME, holding nothing", () => {
    const { source, profile } = setup();
    const held = new WorktreeMetadataLock(profile);
    const first = held.acquireFor([source], { taskId: "task-aaaaaaaa", label: "追加仓库" });
    expect(first.ok).toBe(true);

    // A second instance (another service, another process in production) on the
    // SAME real path: refused, with the owner identity and the age in the name,
    // and it must not have half-acquired anything.
    const competing = new WorktreeMetadataLock(profile, { now: () => new Date(Date.now() + 42_000) });
    const started = Date.now();
    const second = competing.acquireFor([source], { taskId: "task-bbbbbbbb", label: "创建任务" });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toMatch(/^worktree-locked: /);
    expect(second.error).toContain("共享仓库");
    expect(second.error).toContain("task-aaaaaaaa");
    expect(second.error).toContain("追加仓库");
    expect(second.error).toContain(`进程 ${String(process.pid)}`);
    expect(second.error).toContain("已持续 42 秒");
    expect(second.error).toContain("未创建任何分支、工作副本或记录");
    // Bounded: a held lock is refused in the same tick, never after a spin.
    expect(Date.now() - started).toBeLessThan(1_000);
    // The refusal changed nothing: the holder's record is still exactly there.
    const file = held.fileFor(realpathSync(source));
    expect(readRecord(file)["taskId"]).toBe("task-aaaaaaaa");
    expect(staleReceipts(join(profile, WORKTREE_LOCK_DIRECTORY))).toEqual([]);

    // Released by the holder, the same operation then succeeds: the lock is not
    // a permanent barrier.
    if (first.ok) first.release();
    const retry = competing.acquireFor([source], { taskId: "task-bbbbbbbb", label: "创建任务" });
    expect(retry.ok).toBe(true);
    if (retry.ok) retry.release();
  });

  it("keys on the REAL path: a symlinked spelling of one repo contends, another repo does not", () => {
    const { home, source, other, profile } = setup();
    const alias = join(home, "alias");
    symlinkSync(source, alias, "dir");

    const holder = new WorktreeMetadataLock(profile);
    const viaAlias = holder.acquireFor([alias], { taskId: "task-aaaaaaaa", label: "创建任务" });
    expect(viaAlias.ok).toBe(true);
    expect(viaAlias.ok && viaAlias.keys).toEqual([realpathSync(source)]);
    // Same repository through the other spelling: the same key, so it contends.
    const competing = new WorktreeMetadataLock(profile).acquireFor([source], { taskId: "task-bbbbbbbb", label: "创建任务" });
    expect(competing.ok).toBe(false);
    if (!competing.ok) expect(competing.error).toMatch(/^worktree-locked: /);
    // A DIFFERENT source repository is not serialized by anything global.
    const different = new WorktreeMetadataLock(profile).acquireFor([other], { taskId: "task-bbbbbbbb", label: "创建任务" });
    expect(different.ok).toBe(true);
    if (different.ok) different.release();
    if (viaAlias.ok) viaAlias.release();
  });

  it("writes the lock into app-private storage only — never into the repository or its .git", () => {
    const { source, profile } = setup();
    mkdirSync(join(source, ".git"));
    writeFileSync(join(source, ".git", "HEAD"), "ref: refs/heads/main\n");
    const before = readdirSync(source).sort();
    const gitBefore = readdirSync(join(source, ".git")).sort();

    const lock = new WorktreeMetadataLock(profile);
    const acquisition = lock.acquireFor([source], { taskId: "task-aaaaaaaa", label: "创建任务" });
    expect(acquisition.ok).toBe(true);
    const file = lock.fileFor(realpathSync(source));
    expect(file.startsWith(join(profile, WORKTREE_LOCK_DIRECTORY))).toBe(true);
    expect(existsSync(file)).toBe(true);
    // The key is hashed, so the app data directory does not even spell a path…
    expect(file.includes(source)).toBe(false);
    // …and the repository itself is byte-for-byte the checkout it was.
    expect(readdirSync(source).sort()).toEqual(before);
    expect(readdirSync(join(source, ".git")).sort()).toEqual(gitBefore);
    expect(readFileSync(join(source, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
    if (acquisition.ok) acquisition.release();
    expect(existsSync(file)).toBe(false);
  });

  it("refuses the whole acquisition and frees the keys it took when one of several repositories is held", () => {
    const { source, other, profile } = setup();
    const holder = new WorktreeMetadataLock(profile).acquireFor([other], { taskId: "task-aaaaaaaa", label: "创建任务" });
    expect(holder.ok).toBe(true);

    const multi = new WorktreeMetadataLock(profile).acquireFor([source, other], { taskId: "task-bbbbbbbb", label: "追加仓库" });
    expect(multi.ok).toBe(false);
    if (!multi.ok) expect(multi.error).toMatch(/^worktree-locked: /);
    // The first key of the batch must be free again, or the failure would leak a
    // lock nobody can release.
    const free = new WorktreeMetadataLock(profile).acquireFor([source], { taskId: "task-cccccccc", label: "创建任务" });
    expect(free.ok).toBe(true);
    if (free.ok) free.release();
    if (holder.ok) holder.release();
  });

  it("releases on success, on a throwing critical section and twice", () => {
    const { source, profile } = setup();
    const lock = new WorktreeMetadataLock(profile);
    const key = realpathSync(source);
    const file = lock.fileFor(key);

    const success = lock.acquireFor([source], { taskId: "task-aaaaaaaa", label: "创建任务" });
    expect(success.ok).toBe(true);
    if (success.ok) success.release();
    expect(existsSync(file)).toBe(false);

    // A throwing critical section releases in `finally` — the same shape both
    // production services use — and a double release is not a failure.
    const throwing = lock.acquireFor([source], { taskId: "task-aaaaaaaa", label: "创建任务" });
    expect(throwing.ok).toBe(true);
    expect(() => {
      try {
        throw new Error("critical section failed");
      } finally {
        if (throwing.ok) throwing.release();
      }
    }).toThrow(/critical section failed/);
    if (throwing.ok) throwing.release();
    expect(existsSync(file)).toBe(false);

    const after = new WorktreeMetadataLock(profile).acquireFor([source], { taskId: "task-bbbbbbbb", label: "创建任务" });
    expect(after.ok).toBe(true);
    if (after.ok) after.release();
  });

  it("refuses by name when a real source path cannot be resolved instead of running unlocked", () => {
    const { home, profile } = setup();
    const lock = new WorktreeMetadataLock(profile);
    const absent = lock.acquireFor([join(home, "not-a-repo")], { taskId: "task-aaaaaaaa", label: "创建任务" });
    expect(absent.ok).toBe(false);
    if (!absent.ok) expect(absent.error).toMatch(/^worktree-lock-unavailable: /);
  });

  it("names the stale policy: only a provably-gone owner is taken over, with a durable receipt and a notice", () => {
    const { source, profile } = setup();
    const directory = join(profile, WORKTREE_LOCK_DIRECTORY);
    const key = realpathSync(source);
    const file = new WorktreeMetadataLock(profile).fileFor(key);

    // A live owner (a real, running process) is never stolen from: this test
    // process is that owner.
    const live = new WorktreeMetadataLock(profile).acquireFor([source], { taskId: "task-aaaaaaaa", label: "创建任务" });
    expect(live.ok).toBe(true);
    const notify = vi.fn();
    const againstLive = new WorktreeMetadataLock(profile, { notify }).acquireFor([source], { taskId: "task-bbbbbbbb", label: "创建任务" });
    expect(againstLive.ok).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    expect(staleReceipts(directory)).toEqual([]);
    if (live.ok) live.release();

    // A provably-gone owner (a real exited process's pid): taken over, under the
    // named outcome, with the stale record kept as a receipt and a notice sent.
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, JSON.stringify({
      version: 1, key, taskId: "task-deadbeef", label: "追加仓库", pid: deadPid(), at: new Date(Date.now() - 5_000).toISOString(),
    }));
    const takeover = new WorktreeMetadataLock(profile, { notify }).acquireFor([source], { taskId: "task-bbbbbbbb", label: "创建任务" });
    expect(takeover.ok).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    const notice = notify.mock.calls[0]?.[0] as string;
    expect(notice).toContain(WORKTREE_LOCK_STALE_TAKEOVER);
    expect(notice).toContain("task-deadbeef");
    const receipts = staleReceipts(directory);
    expect(receipts).toHaveLength(1);
    const receipt = readRecord(join(directory, receipts[0]!));
    expect(receipt["taskId"]).toBe("task-deadbeef");
    expect(receipt["key"]).toBe(key);
    expect(readRecord(file)["taskId"]).toBe("task-bbbbbbbb");
    if (takeover.ok) takeover.release();
  });

  it("refuses an unreadable lock record by name and never takes it over", () => {
    const { source, profile } = setup();
    const directory = join(profile, WORKTREE_LOCK_DIRECTORY);
    const key = realpathSync(source);
    const file = new WorktreeMetadataLock(profile).fileFor(key);
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, "{ this is not a lock record");

    const notify = vi.fn();
    const refused = new WorktreeMetadataLock(profile, { notify }).acquireFor([source], { taskId: "task-bbbbbbbb", label: "创建任务" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/^worktree-lock-unreadable: /);
    expect(notify).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf8")).toBe("{ this is not a lock record");
    expect(staleReceipts(directory)).toEqual([]);
  });
});
