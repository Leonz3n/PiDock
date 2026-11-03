/**
 * [Pencil T06] #141 the REAL Host write path wires the cross-process lock: two
 * task Hosts (each with its own in-process table, exactly like two
 * utilityProcesses) that share one resolved directory exclude each other, a
 * disjoint directory stays parallel, and completion / cancel / dispose release
 * the lock.
 *
 * This is the Host-level half; the two-REAL-process half is
 * `shared-path-lock-cross-process.test.ts`.
 */
import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedPathLock } from "./shared-path-lock.js";
import { SharedPathCoordinator } from "./path-coordination.js";
import { TaskWorkspaceHost, memoryTaskStore } from "./task-host.js";
import { buildTaskDiskRecord, readTaskRecordOnDisk, serializeTaskRecord } from "./task-store.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

const LINK_NAME = "dir-aaaa1111";
const DIRECTORY_ID = "aaaa1111-0000-4000-8000-000000000001";
const OTHER_DIRECTORY_ID = "bbbb2222-0000-4000-8000-000000000002";

/** One task folder whose plain-directory link points at `source`. */
function taskWithSharedDir(input: { root: string; taskId: string; source: string; directoryId?: string }): string {
  const taskDir = join(input.root, input.taskId);
  mkdirSync(taskDir);
  symlinkSync(input.source, join(taskDir, LINK_NAME), process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(taskDir, "task.json"), serializeTaskRecord(buildTaskDiskRecord({
    taskId: input.taskId, name: input.taskId, dirId: input.taskId, branch: "task-branch", root: input.root, taskDir,
    remoteBranch: "main", baseCommit: "test", repos: [],
    dirLinks: [{ linkName: LINK_NAME, directoryId: input.directoryId ?? DIRECTORY_ID, sourcePath: input.source, snapshotAt: new Date().toISOString() }],
    now: new Date().toISOString(),
  })));
  return taskDir;
}

/** A Host wired exactly like production: its own table + the shared disk lock. */
function hostFor(input: { taskDir: string; taskId: string; userData: string }): TaskWorkspaceHost {
  const store = memoryTaskStore();
  store.tasks.set(input.taskDir, readTaskRecordOnDisk(input.taskDir)!);
  return new TaskWorkspaceHost(
    input.taskId, input.taskDir, store, () => "2026-09-22T10:00:00+08:00",
    () => [], new SharedPathCoordinator(), undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    new SharedPathLock(input.userData),
  );
}

it("两个任务的真实 Host 写同一共享目录时互斥，拒绝说明实际持有者；不重叠目录并行", () => {
  const userData = temp("pidock-sp-host-userdata-");
  const root = temp("pidock-sp-host-tasks-");
  const shared = realpathSync(temp("pidock-sp-host-shared-"));
  const disjoint = realpathSync(temp("pidock-sp-host-disjoint-"));
  const a = hostFor({ taskDir: taskWithSharedDir({ root, taskId: "task-aaaaaaaa", source: shared }), taskId: "task-aaaaaaaa", userData });
  const b = hostFor({ taskDir: taskWithSharedDir({ root, taskId: "task-bbbbbbbb", source: shared }), taskId: "task-bbbbbbbb", userData });
  const other = hostFor({ taskDir: taskWithSharedDir({ root, taskId: "task-cccccccc", source: disjoint, directoryId: OTHER_DIRECTORY_ID }), taskId: "task-cccccccc", userData });

  // Task A's shared plain-directory write holds the REAL path.
  const claimed = a.claimAgentPath("main", "Agent 工具 fs.write", `${a.taskDir}/${LINK_NAME}/spec.txt`);
  expect(claimed.ok).toBe(true);

  // Task B writes the same original through its OWN link name: same real path.
  const refused = b.claimAgentPath("main", "Agent 工具 fs.write", `${b.taskDir}/${LINK_NAME}/spec.txt`);
  expect(refused.ok).toBe(false);
  if (refused.ok) return;
  expect(refused.reason).toContain("shared-path-locked");
  expect(refused.reason).toContain("task-aaaaaaaa");
  expect(refused.reason).toContain("main");
  // Not named by pid alone: the refusal names the Host instance too.
  expect(refused.reason).toMatch(/Host 实例 [0-9a-f-]{36}/);

  // A disjoint shared directory runs in parallel (no global lock).
  const parallel = other.claimAgentPath("main", "Agent 工具 fs.write", `${other.taskDir}/${LINK_NAME}/note.txt`);
  expect(parallel.ok).toBe(true);
  if (parallel.ok) parallel.release();

  // Completion releases: task A's release lets task B take the same real path.
  if (claimed.ok) claimed.release();
  const afterRelease = b.claimAgentPath("main", "Agent 工具 fs.write", `${b.taskDir}/${LINK_NAME}/spec.txt`);
  expect(afterRelease.ok).toBe(true);
  if (afterRelease.ok) afterRelease.release();
});

it("任务私有路径不占共享键（两个任务各自的工作副本可并行）", () => {
  const userData = temp("pidock-sp-host-userdata-");
  const root = temp("pidock-sp-host-tasks-");
  const shared = realpathSync(temp("pidock-sp-host-shared-"));
  const a = hostFor({ taskDir: taskWithSharedDir({ root, taskId: "task-aaaaaaaa", source: shared }), taskId: "task-aaaaaaaa", userData });
  const b = hostFor({ taskDir: taskWithSharedDir({ root, taskId: "task-bbbbbbbb", source: shared }), taskId: "task-bbbbbbbb", userData });
  const first = a.claimAgentPath("main", "Agent 工具 fs.write", `${a.taskDir}/notes.txt`);
  const second = b.claimAgentPath("main", "Agent 工具 fs.write", `${b.taskDir}/notes.txt`);
  expect(first.ok && second.ok).toBe(true);
  if (first.ok) first.release();
  if (second.ok) second.release();
});

it("取消与 Host 退出释放真实路径锁：另一任务立刻可写，且不留锁记录", async () => {
  const userData = temp("pidock-sp-host-userdata-");
  const root = temp("pidock-sp-host-tasks-");
  const shared = realpathSync(temp("pidock-sp-host-shared-"));
  const a = hostFor({ taskDir: taskWithSharedDir({ root, taskId: "task-aaaaaaaa", source: shared }), taskId: "task-aaaaaaaa", userData });
  const b = hostFor({ taskDir: taskWithSharedDir({ root, taskId: "task-bbbbbbbb", source: shared }), taskId: "task-bbbbbbbb", userData });
  expect(a.claimAgentPath("main", "回合工具 fs.write", `${a.taskDir}/${LINK_NAME}/spec.txt`).ok).toBe(true);
  expect(b.claimAgentPath("main", "回合工具 fs.write", `${b.taskDir}/${LINK_NAME}/spec.txt`).ok).toBe(false);
  a.cancel("main");
  const afterCancel = b.claimAgentPath("main", "回合工具 fs.write", `${b.taskDir}/${LINK_NAME}/spec.txt`);
  expect(afterCancel.ok).toBe(true);
  if (afterCancel.ok) afterCancel.release();
  // Host exit releases too: the same real path is free right after dispose and
  // no record is left for the stale-owner policy to recover.
  expect(a.claimAgentPath("main", "回合工具 fs.write", `${a.taskDir}/${LINK_NAME}/spec.txt`).ok).toBe(true);
  await a.dispose();
  const afterExit = b.claimAgentPath("main", "回合工具 fs.write", `${b.taskDir}/${LINK_NAME}/spec.txt`);
  expect(afterExit.ok).toBe(true);
  if (afterExit.ok) afterExit.release();
  const directory = join(userData, "shared-path-locks");
  expect(readdirSync(directory).filter((name) => /^[0-9a-f]{64}\.lock$/.test(name))).toEqual([]);
});

it("链接改指后重新解析：另一个任务的新目标不继承旧的真实路径归属", () => {
  const userData = temp("pidock-sp-host-userdata-");
  const root = temp("pidock-sp-host-tasks-");
  const first = realpathSync(temp("pidock-sp-host-shared-first-"));
  const second = realpathSync(temp("pidock-sp-host-shared-second-"));
  const taskDir = taskWithSharedDir({ root, taskId: "task-aaaaaaaa", source: first });
  const a = hostFor({ taskDir, taskId: "task-aaaaaaaa", userData });
  expect(a.claimAgentPath("main", "Agent 工具 fs.write", `${taskDir}/${LINK_NAME}/spec.txt`).ok).toBe(true);
  // Retarget the link to another original while the first claim is held.
  rmSync(join(taskDir, LINK_NAME));
  symlinkSync(second, join(taskDir, LINK_NAME), process.platform === "win32" ? "junction" : "dir");
  // The same link name now resolves elsewhere: a new acquisition is granted on
  // the new real path (authorization is not widened, it is re-decided).
  const retargeted = a.claimAgentPath("main", "Agent 工具 fs.write", `${taskDir}/${LINK_NAME}/spec.txt`);
  expect(retargeted.ok).toBe(true);
  if (retargeted.ok) retargeted.release();
});

it("确认读数带真实路径与共享原目录（批准前可核对真实目标）", () => {
  const userData = temp("pidock-sp-host-userdata-");
  const root = temp("pidock-sp-host-tasks-");
  const shared = realpathSync(temp("pidock-sp-host-shared-"));
  const taskDir = taskWithSharedDir({ root, taskId: "task-aaaaaaaa", source: shared });
  const a = hostFor({ taskDir, taskId: "task-aaaaaaaa", userData });
  const real = a.realTargetOf(`${taskDir}/${LINK_NAME}/spec.txt`);
  expect(real?.realPath).toBe(join(shared, "spec.txt"));
  expect(real?.linkedOriginal?.sourcePath).toBe(shared);
  // A task-private target is not a linked original (not "unknown").
  expect(a.realTargetOf(`${taskDir}/notes.txt`)).toMatchObject({ realPath: realpathSync(taskDir) + "/notes.txt", linkedOriginal: null });
  // An unresolvable target is `null`, never a guessed path.
  expect(a.realTargetOf("")).toBeNull();
  expect(readFileSync(join(taskDir, "task.json"), "utf8")).toContain("\"dirLinks\"");
});
