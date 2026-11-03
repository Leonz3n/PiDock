/**
 * [Pencil T06] #141 the app-private shared real-path lock: the real-path /
 * overlap matrix, holder naming, dead-owner recovery and the "never steal a live
 * owner" rule.
 *
 * The cross-PROCESS proof lives in `shared-path-lock-cross-process.test.ts` (two
 * real child processes). THIS suite pins the protocol with real files: real
 * directories, a real symlink that is retargeted between two acquisitions, real
 * lock files under a real (temp) `userData`, real stale records and real
 * receipts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_SHARED_PATH_LOCK_FILES,
  SHARED_PATH_LOCK_DIRECTORY,
  SHARED_PATH_LOCK_OWNER_DEAD,
  SharedPathLock,
} from "./shared-path-lock.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** A real userData + two real shared directories, all resolved with `realpath`. */
function fixture() {
  const userData = temp("pidock-shared-path-lock-");
  const shared = temp("pidock-shared-docs-");
  const other = temp("pidock-shared-other-");
  const nested = join(shared, "nested");
  mkdirSync(nested);
  const real = (...parts: string[]) => realpathSync(join(...parts));
  return { userData, shared: real(shared), other: real(other), nested: real(nested) };
}

function lockFor(userData: string, options: { alive?: number[]; notify?: (message: string) => void } = {}) {
  return new SharedPathLock(userData, {
    isProcessAlive: (pid) => (options.alive ?? [process.pid]).includes(pid),
    ...(options.notify ? { notify: options.notify } : {}),
  });
}

const owner = (taskId: string, sessionId = "main", label = "回合工具 fs.write") => ({ taskId, sessionId, label });

describe("真实路径与祖先／后代重叠判定", () => {
  it("同一真实路径互斥，拒绝说明实际持有者（任务／会话／Host 实例／进程），不是只给 pid", () => {
    const f = fixture();
    const first = lockFor(f.userData);
    const second = lockFor(f.userData);
    expect(first.claim(owner("task-a"), [f.shared]).ok).toBe(true);
    const refused = second.claim(owner("task-b", "main", "Agent 工具 fs.write"), [f.shared]);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toContain("shared-path-locked");
    expect(refused.error).toContain("task-a");
    expect(refused.error).toContain("main");
    expect(refused.error).toContain(first.instanceId);
    expect(refused.error).toContain(`进程 ${String(process.pid)}`);
    // The refused claim left nothing behind: task-b holds no key at all.
    expect(second.heldKeys("task-b", "main")).toEqual([]);
  });

  it("祖先与后代都算重叠（两个方向），兄弟／不相干目录不重叠且可并行", () => {
    const f = fixture();
    const holder = lockFor(f.userData);
    expect(holder.claim(owner("task-a"), [f.shared]).ok).toBe(true);
    // descendant of a held ancestor
    expect(lockFor(f.userData).claim(owner("task-b"), [f.nested]).ok).toBe(false);
    // sibling inside the same parent: inside the held ancestor -> still refused
    mkdirSync(join(f.shared, "sibling"));
    expect(lockFor(f.userData).claim(owner("task-c"), [realpathSync(join(f.shared, "sibling"))]).ok).toBe(false);
    // the reverse direction: a held DESCENDANT blocks an ancestor claim
    const descendantHolder = lockFor(f.userData);
    expect(descendantHolder.claim(owner("task-d"), [f.other]).ok).toBe(true);
    expect(lockFor(f.userData).claim(owner("task-e"), [f.other]).ok).toBe(false);
    // a disjoint directory runs in parallel (no global single-session lock)
    const free = realpathSync(temp("pidock-shared-free-"));
    expect(lockFor(f.userData).claim(owner("task-f"), [free]).ok).toBe(true);
    holder.releaseTask("task-a");
    descendantHolder.releaseTask("task-d");
  });

  it("段感知：/a/bc 与 /a/b 不视为重叠", () => {
    const f = fixture();
    const parent = join(f.userData, "seg");
    mkdirSync(parent);
    mkdirSync(join(parent, "b"));
    mkdirSync(join(parent, "bc"));
    const holder = lockFor(f.userData);
    expect(holder.claim(owner("task-a"), [realpathSync(join(parent, "b"))]).ok).toBe(true);
    expect(lockFor(f.userData).claim(owner("task-b"), [realpathSync(join(parent, "bc"))]).ok).toBe(true);
  });

  it("链接改指后重新解析真实路径：旧键随释放消失，新目标不继承旧归属", () => {
    const f = fixture();
    const taskDir = temp("pidock-shared-task-");
    const link = join(taskDir, "dir-aaaa1111");
    symlinkSync(f.shared, link, process.platform === "win32" ? "junction" : "dir");
    const first = lockFor(f.userData);
    // Acquisition 1 resolves the link to the FIRST original.
    expect(first.claim(owner("task-a"), [realpathSync(link)]).ok).toBe(true);
    // The link is retargeted while task-a holds the old real path.
    rmSync(link);
    symlinkSync(f.other, link, process.platform === "win32" ? "junction" : "dir");
    // A new acquisition resolves the NEW real path: it does not overlap the old
    // key, so it is granted (retargeting cannot widen, and does not inherit).
    const second = lockFor(f.userData);
    const retargeted = second.claim(owner("task-b"), [realpathSync(link)]);
    expect(retargeted.ok).toBe(true);
    // The old real path stays held by task-a until it releases.
    expect(lockFor(f.userData).claim(owner("task-c"), [f.shared]).ok).toBe(false);
    first.releaseTask("task-a");
    expect(lockFor(f.userData).claim(owner("task-c"), [f.shared]).ok).toBe(true);
  });
});

describe("释放、取消与崩溃回收", () => {
  it("release 归还全部键；keepPaths 只保留声明过的键（部分释放）", () => {
    const f = fixture();
    const holder = lockFor(f.userData);
    expect(holder.claim(owner("task-a"), [f.shared]).ok).toBe(true);
    expect(holder.claim(owner("task-a"), [f.other]).ok).toBe(true);
    holder.release({ taskId: "task-a", sessionId: "main", keepPaths: [f.shared] });
    expect(holder.heldKeys("task-a", "main")).toEqual([f.shared]);
    // the kept key still refuses another task; the released one is free
    expect(lockFor(f.userData).claim(owner("task-b"), [f.shared]).ok).toBe(false);
    expect(lockFor(f.userData).claim(owner("task-c"), [f.other]).ok).toBe(true);
    holder.release({ taskId: "task-a", sessionId: "main" });
    expect(existsSync(holder.fileFor(f.shared))).toBe(false);
  });

  it("持有者进程已不存在 → lock-owner-dead 具名恢复并保留凭据（不静默强夺）", () => {
    const f = fixture();
    const deadPid = 987_654_321;
    const doomed = lockFor(f.userData, { alive: [] });
    // A record written by a process this test pretends is gone.
    const record = {
      version: 1 as const, key: f.shared, taskId: "task-crashed", sessionId: "main",
      label: "回合工具 fs.write", hostInstance: doomed.instanceId, pid: deadPid, at: new Date().toISOString(),
    };
    mkdirSync(join(f.userData, SHARED_PATH_LOCK_DIRECTORY), { recursive: true });
    writeFileSync(doomed.fileFor(f.shared), JSON.stringify(record));
    const announcements: string[] = [];
    const contender = lockFor(f.userData, { notify: (message) => announcements.push(message) });
    const taken = contender.claim(owner("task-live"), [f.shared]);
    expect(taken.ok).toBe(true);
    // Named, not silent: the announcer names what it evicted, and a receipt stays.
    const announced = announcements.join("\n");
    expect(announced).toContain(SHARED_PATH_LOCK_OWNER_DEAD);
    expect(announced).toContain("task-crashed");
    expect(announced).toContain(String(deadPid));
    const receipts = readdirSync(join(f.userData, SHARED_PATH_LOCK_DIRECTORY)).filter((name) => name.includes(".stale-"));
    expect(receipts).toHaveLength(1);
    const receipt = JSON.parse(readFileSync(join(f.userData, SHARED_PATH_LOCK_DIRECTORY, receipts[0]!), "utf8")) as { taskId: string };
    expect(receipt.taskId).toBe("task-crashed");
  });

  it("仍然活着（含 EPERM 之外的可信号进程）的持有者永不被顶替", () => {
    const f = fixture();
    const live = lockFor(f.userData);
    expect(live.claim(owner("task-live"), [f.shared]).ok).toBe(true);
    const contender = lockFor(f.userData);
    const refused = contender.claim(owner("task-other"), [f.shared]);
    expect(refused.ok).toBe(false);
    // The live holder's record was NOT replaced: it is byte-identical and the
    // contender holds nothing.
    const record = JSON.parse(readFileSync(live.fileFor(f.shared), "utf8")) as { taskId: string; pid: number };
    expect(record.taskId).toBe("task-live");
    expect(record.pid).toBe(process.pid);
    expect(contender.heldKeys("task-other", "main")).toEqual([]);
  });

  it("回收的 pid 不是原持有者：Host 实例标记已不存在时按 lock-owner-dead 恢复", () => {
    const f = fixture();
    mkdirSync(join(f.userData, SHARED_PATH_LOCK_DIRECTORY), { recursive: true });
    const writer = lockFor(f.userData);
    // Process pid is alive (this test process), but the NAMED Host instance's
    // marker is gone: a recycled pid, not the original holder.
    writeFileSync(writer.fileFor(f.shared), JSON.stringify({
      version: 1, key: f.shared, taskId: "task-gone", sessionId: "main", label: "Agent 工具 fs.write",
      hostInstance: "11111111-2222-4333-8444-555555555555", pid: process.pid, at: new Date().toISOString(),
    }));
    const announcements: string[] = [];
    const contender = lockFor(f.userData, { notify: (m) => announcements.push(m) });
    expect(contender.claim(owner("task-live"), [f.shared]).ok).toBe(true);
    expect(announcements.join("\n")).toContain(SHARED_PATH_LOCK_OWNER_DEAD);
  });

  it("不可读取的锁记录：具名拒绝，绝不静默强夺", () => {
    const f = fixture();
    mkdirSync(join(f.userData, SHARED_PATH_LOCK_DIRECTORY), { recursive: true });
    const lock = lockFor(f.userData);
    writeFileSync(lock.fileFor(f.shared), "{ this is not a record");
    const refused = lock.claim(owner("task-a"), [f.shared]);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toContain("shared-path-lock-unreadable");
    // Nothing was taken and the corrupt record is still there for a human.
    expect(existsSync(lock.fileFor(f.shared))).toBe(true);
    expect(lock.heldKeys("task-a", "main")).toEqual([]);
  });

  it("锁目录记录过多时具名拒绝，而不是无界扫描", () => {
    const f = fixture();
    const directory = join(f.userData, SHARED_PATH_LOCK_DIRECTORY);
    mkdirSync(directory, { recursive: true });
    for (let index = 0; index < MAX_SHARED_PATH_LOCK_FILES + 1; index += 1) {
      writeFileSync(join(directory, `${index.toString(16).padStart(64, "0")}.lock`), "{}");
    }
    const refused = lockFor(f.userData).claim(owner("task-a"), [f.shared]);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toContain("shared-path-lock-unavailable");
  });
});
