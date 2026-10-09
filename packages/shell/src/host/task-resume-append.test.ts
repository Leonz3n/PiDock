import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskWorkspaceHost, diskTaskStore } from "./task-host.js";
import { buildTaskDiskRecord, readTaskRecordOnDisk, taskFilePath } from "./task-store.js";
import type { ProvisionPlanOp } from "../main/task-provision.js";

// Seam: [PiDock 03] (#6) partial-prepare recovery. Real temporary git remotes
// and worktrees (no fixtures): the Host classifies the REAL on-disk state and
// resumes only the unfinished repos. In-process `TaskWorkspaceHost` (the
// entry `host.ts` maps `task/*` ops onto) with the disk task store, so the
// result is read back from `task.json` and from the worktree directories.

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}

/** A real bare remote + a source checkout cloned from it, with `main` pushed. */
function realRepo(home: string, name: string): { bare: string; checkout: string; commit: string } {
  const bare = join(home, `${name}.git`);
  const checkout = join(home, name);
  git(home, "init", "--bare", "-b", "main", bare);
  git(home, "clone", bare, checkout);
  git(checkout, "config", "user.email", "test@localhost");
  git(checkout, "config", "user.name", "Test");
  writeFileSync(join(checkout, "README.md"), `${name} baseline\n`);
  git(checkout, "add", "README.md");
  git(checkout, "commit", "-m", `${name} baseline`);
  git(checkout, "push", "origin", "main");
  return { bare, checkout, commit: git(checkout, "rev-parse", "HEAD") };
}

function runOps(ops: readonly ProvisionPlanOp[]): void {
  for (const op of ops) git(op.cwd, ...op.args);
}

function workspace(home: string, taskId = "task-abcdef12") {
  const root = join(home, "tasks");
  const taskDir = join(root, taskId);
  mkdirSync(taskDir, { recursive: true });
  return { root, taskDir, taskId, branch: `task/${taskId}` };
}

function hostAt(taskId: string, taskDir: string): TaskWorkspaceHost {
  return new TaskWorkspaceHost(taskId, taskDir, diskTaskStore, () => "2026-09-24T10:00:00.000Z");
}

/** A recorded multi-repo selection with no worktrees yet (app-restart shape). */
function recordSelection(input: {
  home: string;
  taskId: string;
  repos: { repoDir: string; commit: string }[];
  prepareErrors?: { repoDir: string; code: string; message: string }[];
}) {
  const { root, taskDir, branch } = workspace(input.home, input.taskId);
  diskTaskStore.writeTask(
    taskDir,
    buildTaskDiskRecord({
      taskId: input.taskId,
      name: "多仓任务",
      dirId: input.taskId,
      branch,
      root,
      taskDir,
      remoteBranch: "main",
      baseCommit: input.repos[0]!.commit,
      repos: input.repos.map((repo) => repo.repoDir),
      repoSources: input.repos.map((repo) => ({
        repoDir: repo.repoDir,
        remote: "origin",
        remoteBranch: "main",
        baseCommit: repo.commit,
      })),
      repoPrepareErrors: input.prepareErrors,
      now: "2026-09-24T10:00:00.000Z",
    }),
  );
  return { root, taskDir, taskId: input.taskId, branch };
}

describe("#6 resumeAppend over real worktrees (S6)", () => {
  it("resumes only the unfinished repo and leaves the created worktree and its user edits byte-identical", () => {
    const home = mkdtempSync(join(tmpdir(), "pidock-resume-"));
    homes.push(home);
    const { taskDir, taskId, branch } = workspace(home);
    const frontend = realRepo(home, "frontend");
    const invoice = realRepo(home, "invoice");
    const host = hostAt(taskId, taskDir);

    // Record both selections the way production does: provision records the
    // first repo, append records the second. Only the first worktree is then
    // really created — the second prepare is interrupted before its git ops.
    const provisioned = host.provision({
      name: "多仓任务",
      dirId: taskId,
      remoteBranch: "main",
      fetchedCommit: frontend.commit,
      repoSelections: [
        { repoDir: "frontend", remote: "origin", remoteBranch: "main", mainCheckoutDir: frontend.checkout },
      ],
      fetchedCommits: { frontend: frontend.commit },
      mainCheckouts: { frontend: frontend.checkout },
    });
    runOps(provisioned.plan.ops);
    const appended = host.appendRepos({
      repoSelections: [
        { repoDir: "frontend", remote: "origin", remoteBranch: "main", mainCheckoutDir: frontend.checkout },
        { repoDir: "invoice", remote: "origin", remoteBranch: "main", mainCheckoutDir: invoice.checkout },
      ],
      fetchedCommits: { invoice: invoice.commit },
      mainCheckouts: { invoice: invoice.checkout },
      takenPaths: [],
      branchesInUse: [],
    });
    expect(appended.appended).toEqual(["invoice"]);
    expect(existsSync(join(taskDir, "invoice"))).toBe(false);

    // A user commit + a dirty file inside the created worktree: recovery must
    // keep both (no reset, no refetch, no overwrite).
    const worktreeFrontend = join(taskDir, "frontend");
    const worktreeInvoice = join(taskDir, "invoice");
    git(worktreeFrontend, "-c", "user.email=test@localhost", "-c", "user.name=Test", "commit", "--allow-empty", "-m", "user work");
    writeFileSync(join(worktreeFrontend, "notes.txt"), "user edit\n");
    const userHead = git(worktreeFrontend, "rev-parse", "HEAD");
    expect(userHead).not.toBe(frontend.commit);

    // Resume: the caller scans the task dir + the TARGET repo's worktree list.
    const takenPaths = readdirSync(taskDir).map((name) => join(taskDir, name));
    const resumed = host.resumeAppend({
      mainCheckouts: { frontend: frontend.checkout, invoice: invoice.checkout },
      takenPaths,
      branchesInUse: git(invoice.checkout, "worktree", "list", "--porcelain")
        .split("\n")
        .filter((line) => line.startsWith("branch "))
        .map((line) => line.slice("branch refs/heads/".length)),
    });

    expect(resumed.created).toEqual(["frontend"]);
    expect(resumed.pending).toEqual(["invoice"]);
    expect(resumed.retry).toEqual(["invoice"]);
    expect(resumed.hold).toEqual([]);
    expect(resumed.resumed).toBe(true);
    // Only the unfinished repo enters the plan; its ops run in its own checkout.
    expect(resumed.plan.ops.length).toBe(3);
    expect(resumed.plan.ops.every((op) => op.cwd === invoice.checkout)).toBe(true);

    runOps(resumed.plan.ops);
    expect(git(worktreeInvoice, "rev-parse", "HEAD")).toBe(invoice.commit);
    expect(git(worktreeInvoice, "symbolic-ref", "--quiet", "HEAD")).toBe(`refs/heads/${branch}`);

    // The created worktree is byte-identical: same HEAD, same dirty file.
    expect(git(worktreeFrontend, "rev-parse", "HEAD")).toBe(userHead);
    expect(readFileSync(join(worktreeFrontend, "notes.txt"), "utf8")).toBe("user edit\n");
    expect(git(worktreeFrontend, "status", "--porcelain").split("\n")).toContain("?? notes.txt");
    expect(existsSync(join(worktreeFrontend, "invoice"))).toBe(false);

    // The record read back from disk keeps both fixed baselines and clears
    // the (absent) prepare-error list once every repo is created.
    const onDisk = readTaskRecordOnDisk(taskDir);
    expect(onDisk?.repoSources?.map((source) => [source.repoDir, source.baseCommit])).toEqual([
      ["frontend", frontend.commit],
      ["invoice", invoice.commit],
    ]);
    expect(onDisk?.repoPrepareErrors).toBeUndefined();

    // A second resume is a no-op: nothing unfinished, nothing planned.
    const again = hostAt(taskId, taskDir).resumeAppend({ takenPaths, branchesInUse: [] });
    expect(again.created.sort()).toEqual(["frontend", "invoice"]);
    expect(again.resumed).toBe(false);
    expect(again.plan.ops).toEqual([]);
  });

  it("distinguishes pending from failed with the real reason after an app restart", () => {
    const home = mkdtempSync(join(tmpdir(), "pidock-resume-"));
    homes.push(home);
    const frontend = realRepo(home, "frontend");
    const invoice = realRepo(home, "invoice");
    // Selection recorded, no worktree on disk, one repo has a previously
    // reported per-repo error persisted on the record.
    const { taskDir, taskId } = recordSelection({
      home,
      taskId: "task-abcdef12",
      repos: [
        { repoDir: "frontend", commit: frontend.commit },
        { repoDir: "invoice", commit: invoice.commit },
      ],
      prepareErrors: [{ repoDir: "invoice", code: "fetch-failed", message: "仓库 invoice 获取远程基线失败" }],
    });

    // App restart: a fresh Host reads the record from disk.
    const restarted = hostAt(taskId, taskDir);
    const resumed = restarted.resumeAppend({
      mainCheckouts: { frontend: frontend.checkout, invoice: invoice.checkout },
      takenPaths: [],
      branchesInUse: [],
    });
    expect(resumed.pending).toEqual(["frontend"]);
    expect(resumed.failed.map((entry) => entry.repoDir)).toEqual(["invoice"]);
    expect(resumed.failed[0]!.error.message).toBe("仓库 invoice 获取远程基线失败");
    expect([...resumed.retry].sort()).toEqual(["frontend", "invoice"]);

    runOps(resumed.plan.ops);
    expect(git(join(taskDir, "frontend"), "rev-parse", "HEAD")).toBe(frontend.commit);
    expect(git(join(taskDir, "invoice"), "rev-parse", "HEAD")).toBe(invoice.commit);
  });

  it("persists a caller-reported per-repo error so a later restart still reads failed", () => {
    const home = mkdtempSync(join(tmpdir(), "pidock-resume-"));
    homes.push(home);
    const frontend = realRepo(home, "frontend");
    const { taskDir, taskId } = recordSelection({
      home,
      taskId: "task-abcdef12",
      repos: [{ repoDir: "frontend", commit: frontend.commit }],
    });
    const host = hostAt(taskId, taskDir);
    const resumed = host.resumeAppend({
      mainCheckouts: { frontend: frontend.checkout },
      takenPaths: [],
      branchesInUse: [],
      prepareErrors: { frontend: { code: "repo-unusable", message: "工作树创建失败：路径已被占用" } },
    });
    expect(resumed.failed.map((entry) => entry.repoDir)).toEqual(["frontend"]);
    expect(readTaskRecordOnDisk(taskDir)?.repoPrepareErrors).toEqual([
      { repoDir: "frontend", code: "repo-unusable", message: "工作树创建失败：路径已被占用" },
    ]);
    // A restarted Host classifies the still-absent repo as failed, not pending.
    const restarted = hostAt(taskId, taskDir).resumeAppend({
      mainCheckouts: { frontend: frontend.checkout },
      takenPaths: [],
      branchesInUse: [],
    });
    expect(restarted.pending).toEqual([]);
    expect(restarted.failed[0]!.error.message).toBe("工作树创建失败：路径已被占用");
  });

  it("holds a present path that is not this task's worktree instead of overwriting it", () => {
    const home = mkdtempSync(join(tmpdir(), "pidock-resume-"));
    homes.push(home);
    const frontend = realRepo(home, "frontend");
    const { taskDir, taskId } = recordSelection({
      home,
      taskId: "task-abcdef12",
      repos: [{ repoDir: "frontend", commit: frontend.commit }],
    });
    // An unknown directory already sits at the wanted path: never take over.
    mkdirSync(join(taskDir, "frontend"));
    writeFileSync(join(taskDir, "frontend", "keep.txt"), "do not touch\n");

    const resumed = hostAt(taskId, taskDir).resumeAppend({
      mainCheckouts: { frontend: frontend.checkout },
      takenPaths: [join(taskDir, "frontend")],
      branchesInUse: [],
    });
    expect(resumed.created).toEqual([]);
    expect(resumed.hold).toEqual(["frontend"]);
    expect(resumed.retry).toEqual([]);
    expect(resumed.resumed).toBe(false);
    expect(resumed.plan.ops).toEqual([]);
    expect(resumed.failed[0]!.error.message).toContain("不是");
    expect(readFileSync(join(taskDir, "frontend", "keep.txt"), "utf8")).toBe("do not touch\n");
  });

  it("reads the per-repo prepare state without planning or writing", () => {
    const home = mkdtempSync(join(tmpdir(), "pidock-resume-"));
    homes.push(home);
    const frontend = realRepo(home, "frontend");
    const invoice = realRepo(home, "invoice");
    const { taskDir, taskId } = recordSelection({
      home,
      taskId: "task-abcdef12",
      repos: [
        { repoDir: "frontend", commit: frontend.commit },
        { repoDir: "invoice", commit: invoice.commit },
      ],
      prepareErrors: [{ repoDir: "invoice", code: "fetch-failed", message: "仓库 invoice 获取远程基线失败" }],
    });
    const before = readFileSync(taskFilePath(taskDir), "utf8");

    // No conflict scan is needed for a read; the record is byte-identical.
    const status = hostAt(taskId, taskDir).prepareStatus();
    expect(status.pending).toEqual(["frontend"]);
    expect(status.failed.map((entry) => entry.repoDir)).toEqual(["invoice"]);
    expect(status.failed[0]!.error.message).toBe("仓库 invoice 获取远程基线失败");
    expect(status.canResume).toBe(true);
    expect(readFileSync(taskFilePath(taskDir), "utf8")).toBe(before);

    // Once both worktrees exist, the read reports them as created.
    const resumed = hostAt(taskId, taskDir).resumeAppend({
      mainCheckouts: { frontend: frontend.checkout, invoice: invoice.checkout },
      takenPaths: [],
      branchesInUse: [],
    });
    runOps(resumed.plan.ops);
    const after = hostAt(taskId, taskDir).prepareStatus();
    expect(after.created.sort()).toEqual(["frontend", "invoice"]);
    expect(after.canResume).toBe(false);

    // Missing/foreign task fails closed by name.
    const empty = workspace(home, "task-00000002");
    expect(() => hostAt(empty.taskId, empty.taskDir).prepareStatus()).toThrow("unknown task");
  });

  it("fails closed on a missing task, an unknown repo and an omitted conflict scan", () => {
    const home = mkdtempSync(join(tmpdir(), "pidock-resume-"));
    homes.push(home);

    // Missing task: nothing is written.
    const missing = workspace(home, "task-00000001");
    expect(() => hostAt(missing.taskId, missing.taskDir).resumeAppend({ takenPaths: [], branchesInUse: [] })).toThrow(
      "unknown task",
    );
    expect(existsSync(taskFilePath(missing.taskDir))).toBe(false);

    const frontend = realRepo(home, "frontend");
    const { taskDir, taskId } = recordSelection({
      home,
      taskId: "task-abcdef12",
      repos: [{ repoDir: "frontend", commit: frontend.commit }],
    });
    const before = readFileSync(taskFilePath(taskDir), "utf8");

    // Unknown repo in the caller's error report: refused, record untouched.
    expect(() =>
      hostAt(taskId, taskDir).resumeAppend({
        takenPaths: [],
        branchesInUse: [],
        prepareErrors: { ghost: { code: "fetch-failed", message: "x" } },
      }),
    ).toThrow("unknown repo");
    expect(readFileSync(taskFilePath(taskDir), "utf8")).toBe(before);

    // Omitted conflict scan: refused, no worktree created, record untouched.
    expect(() =>
      hostAt(taskId, taskDir).resumeAppend({ mainCheckouts: { frontend: frontend.checkout } }),
    ).toThrow("invalid-payload: resumeAppend requires caller-scanned takenPaths + branchesInUse");
    expect(existsSync(join(taskDir, "frontend"))).toBe(false);
    expect(readFileSync(taskFilePath(taskDir), "utf8")).toBe(before);

    // A fresh fetch that disagrees with the recorded fixed baseline: refused
    // (no stale baseline), nothing created.
    expect(() =>
      hostAt(taskId, taskDir).resumeAppend({
        mainCheckouts: { frontend: frontend.checkout },
        fetchedCommits: { frontend: "0".repeat(40) },
        takenPaths: [],
        branchesInUse: [],
      }),
    ).toThrow("fetch-failed");
    expect(existsSync(join(taskDir, "frontend"))).toBe(false);
  });
});
