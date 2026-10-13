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
import { basename, join } from "node:path";
import {
  WORKTREE_LOCK_DIRECTORY,
  WORKTREE_LOCK_STALE_TAKEOVER,
  WORKTREE_LOCK_TAKEOVER_SUFFIX,
  WorktreeMetadataLock,
  type WorktreeLockAcquisition,
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

  it("keys a nested source repository by its OWN real path, so two tasks sharing that repo's .git contend", () => {
    const { source, profile } = setup();
    // Nesting is registerable: `/a` and `/a/b` are two repositories with two
    // `.git` directories, and both can be selected by one task.
    const nested = join(source, "nested");
    mkdirSync(nested);

    const both = new WorktreeMetadataLock(profile).acquireFor([source, nested], { taskId: "task-aaaaaaaa", label: "创建任务" });
    expect(both.ok).toBe(true);
    // Worktree metadata is PER REPOSITORY, so the key set never collapses the
    // nested repository into the outer one.
    expect(both.ok && both.keys).toEqual([realpathSync(source), realpathSync(nested)]);

    // A task selecting ONLY the nested repository writes that repository's
    // `.git` (the `FETCH_HEAD` pin of the wrong baseline): it must contend.
    const nestedOnly = new WorktreeMetadataLock(profile).acquireFor([nested], { taskId: "task-bbbbbbbb", label: "创建任务" });
    expect(nestedOnly.ok).toBe(false);
    if (!nestedOnly.ok) {
      expect(nestedOnly.error).toMatch(/^worktree-locked: /);
      expect(nestedOnly.error).toContain("task-aaaaaaaa");
    }
    if (both.ok) both.release();

    // And the reverse direction: nested first, then the pair.
    const nestedFirst = new WorktreeMetadataLock(profile).acquireFor([nested], { taskId: "task-bbbbbbbb", label: "追加仓库" });
    expect(nestedFirst.ok).toBe(true);
    const pair = new WorktreeMetadataLock(profile).acquireFor([source, nested], { taskId: "task-cccccccc", label: "创建任务" });
    expect(pair.ok).toBe(false);
    if (!pair.ok) expect(pair.error).toMatch(/^worktree-locked: /);
    // The failed batch freed the outer key it had already taken.
    const outerOnly = new WorktreeMetadataLock(profile).acquireFor([source], { taskId: "task-dddddddd", label: "创建任务" });
    expect(outerOnly.ok).toBe(true);
    if (outerOnly.ok) outerOnly.release();
    if (nestedFirst.ok) nestedFirst.release();
  });

  it("never evicts a live lock: a contender that already replaced the stale record keeps holding it", () => {
    const { source, profile } = setup();
    const directory = join(profile, WORKTREE_LOCK_DIRECTORY);
    const key = realpathSync(source);
    const file = new WorktreeMetadataLock(profile).fileFor(key);
    mkdirSync(directory, { recursive: true });
    const stalePid = deadPid();
    writeFileSync(file, JSON.stringify({
      version: 1, key, taskId: "task-deadbeef", label: "追加仓库", pid: stalePid, at: new Date(Date.now() - 5_000).toISOString(),
    }));

    // The interleave the takeover must survive: two contenders read the SAME
    // stale record, the second one completes the WHOLE takeover and becomes the
    // live holder, and only then does the first one reach its rename. The
    // injected liveness question is exactly the point at which production asks
    // "is the recorded owner gone?", and the competitor is a full, real
    // acquisition through the production module.
    const notices: string[] = [];
    const competitor: { acquisition: WorktreeLockAcquisition | null } = { acquisition: null };
    const recovering = new WorktreeMetadataLock(profile, {
      notify: (message) => notices.push(message),
      isProcessAlive: (pid) => {
        if (pid === stalePid && competitor.acquisition === null) {
          competitor.acquisition = new WorktreeMetadataLock(profile).acquireFor([source], { taskId: "task-competitor", label: "创建任务" });
        }
        return false;
      },
    });
    const recovery = recovering.acquireFor([source], { taskId: "task-aaaaaaaa", label: "创建任务" });

    const winner = competitor.acquisition;
    expect(winner?.ok).toBe(true);
    // The live holder was NOT evicted: it is still the holder of the key, and the
    // recovery refused by name instead of stealing from it.
    expect(recovery.ok).toBe(false);
    if (!recovery.ok) {
      expect(recovery.error).toMatch(/^worktree-locked: /);
      expect(recovery.error).toContain("task-competitor");
    }
    expect(readRecord(file)["taskId"]).toBe("task-competitor");
    expect(readRecord(file)["pid"]).toBe(process.pid);
    // The ONE receipt is the stale record, never the live one, and the takeover
    // marker was dropped again: nothing is left behind.
    const receipts = staleReceipts(directory);
    expect(receipts).toHaveLength(1);
    expect(readRecord(join(directory, receipts[0]!))["taskId"]).toBe("task-deadbeef");
    expect(notices.filter((message) => message.includes("task-competitor"))).toEqual([]);
    expect(readdirSync(directory).filter((name) => !name.includes(".stale-"))).toEqual([basename(file)]);

    // The winner really does hold it: releasing frees the key.
    if (winner !== null && winner.ok) winner.release();
    expect(existsSync(file)).toBe(false);
  });

  it("refuses by name while another contender is already taking the stale lock over, and never steals its marker", () => {
    const { source, profile } = setup();
    const directory = join(profile, WORKTREE_LOCK_DIRECTORY);
    const key = realpathSync(source);
    const file = new WorktreeMetadataLock(profile).fileFor(key);
    mkdirSync(directory, { recursive: true });
    const at = new Date(Date.now() - 3_000).toISOString();
    writeFileSync(file, JSON.stringify({ version: 1, key, taskId: "task-deadbeef", label: "追加仓库", pid: deadPid(), at: new Date(Date.now() - 5_000).toISOString() }));
    // A recovery in progress: the marker carries the recovering process's own
    // identity, written exactly as production writes it.
    const marker = `${file}${WORKTREE_LOCK_TAKEOVER_SUFFIX}`;
    writeFileSync(marker, JSON.stringify({ version: 1, key, taskId: "task-recovery", label: "创建任务", pid: process.pid, at }));

    const notify = vi.fn();
    const refused = new WorktreeMetadataLock(profile, { notify, now: () => new Date(Date.parse(at) + 3_000) })
      .acquireFor([source], { taskId: "task-aaaaaaaa", label: "创建任务" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error).toMatch(/^worktree-locked: /);
      expect(refused.error).toContain("task-recovery");
      expect(refused.error).toContain("接管");
      expect(refused.error).toContain(`进程 ${String(process.pid)}`);
      expect(refused.error).toContain("已持续 3 秒");
      expect(refused.error).toContain("未创建任何分支、工作副本或记录");
    }
    // Nothing was stolen: the live marker and the stale record are untouched.
    expect(existsSync(marker)).toBe(true);
    expect(readRecord(marker)["taskId"]).toBe("task-recovery");
    expect(readRecord(file)["taskId"]).toBe("task-deadbeef");
    expect(staleReceipts(directory)).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("recovers a takeover marker whose owner is provably gone, so a crash during recovery cannot block the repository", () => {
    const { source, profile } = setup();
    const directory = join(profile, WORKTREE_LOCK_DIRECTORY);
    const key = realpathSync(source);
    const file = new WorktreeMetadataLock(profile).fileFor(key);
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, key, taskId: "task-deadbeef", label: "追加仓库", pid: deadPid(), at: new Date(Date.now() - 9_000).toISOString() }));
    // The marker a recovery process that was killed mid-takeover left behind.
    const marker = `${file}${WORKTREE_LOCK_TAKEOVER_SUFFIX}`;
    writeFileSync(marker, JSON.stringify({ version: 1, key, taskId: "task-crashed", label: "创建任务", pid: deadPid(), at: new Date(Date.now() - 7_000).toISOString() }));

    const notices: string[] = [];
    const acquired = new WorktreeMetadataLock(profile, { notify: (message) => notices.push(message) })
      .acquireFor([source], { taskId: "task-aaaaaaaa", label: "创建任务" });
    expect(acquired.ok).toBe(true);
    expect(readRecord(file)["taskId"]).toBe("task-aaaaaaaa");
    // Both the stale lock and the stale marker are kept as receipts, and both are
    // announced: taking over a marker is as visible as taking over a lock.
    expect(existsSync(marker)).toBe(false);
    const receipts = staleReceipts(directory);
    expect(receipts).toHaveLength(2);
    expect(receipts.map((name) => readRecord(join(directory, name))["taskId"]).sort()).toEqual(["task-crashed", "task-deadbeef"]);
    expect(notices.filter((message) => message.includes(WORKTREE_LOCK_STALE_TAKEOVER))).toHaveLength(2);
    expect(notices.filter((message) => message.includes("task-crashed"))).toHaveLength(1);
    expect(readdirSync(directory).filter((name) => !name.includes(".stale-"))).toEqual([basename(file)]);
    if (acquired.ok) acquired.release();
  });

  it("refuses a takeover marker it cannot read instead of taking the stale lock over", () => {
    const { source, profile } = setup();
    const directory = join(profile, WORKTREE_LOCK_DIRECTORY);
    const key = realpathSync(source);
    const file = new WorktreeMetadataLock(profile).fileFor(key);
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, key, taskId: "task-deadbeef", label: "追加仓库", pid: deadPid(), at: new Date(Date.now() - 5_000).toISOString() }));
    const marker = `${file}${WORKTREE_LOCK_TAKEOVER_SUFFIX}`;
    writeFileSync(marker, "{ this is not a takeover marker");

    const notify = vi.fn();
    const refused = new WorktreeMetadataLock(profile, { notify }).acquireFor([source], { taskId: "task-aaaaaaaa", label: "创建任务" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/^worktree-lock-unreadable: /);
    // Nothing was taken over, and neither file was rewritten.
    expect(readFileSync(marker, "utf8")).toBe("{ this is not a takeover marker");
    expect(readRecord(file)["taskId"]).toBe("task-deadbeef");
    expect(staleReceipts(directory)).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
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
