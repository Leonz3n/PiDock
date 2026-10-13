import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTaskDiskRecord, readTaskRecordOnDisk, taskFilePath } from "../host/task-store.js";
import {
  PREP_SCAN_UNAVAILABLE,
  PrepScanUnavailableError,
  createNodePrepScanDeps,
  derivePrepInputs,
  deriveRendererPrepPayload,
  parseWorktreeList,
  projectRepositoryForRepoDir,
  resolveTargetCheckouts,
  scanPrepConflicts,
  type PrepScanDeps,
} from "./task-prep-scan.js";

// Seam: #6 partial-prepare recovery, boundary B. Main is the authoritative
// producer of the `takenPaths`/`branchesInUse` scan the Host requires.
// Real temporary git repositories are used where the git answer matters
// (`git worktree list`); the pure parsing/mapping rules are covered without
// fs or git.

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

/** A real bare remote + a clone of it with `main` pushed. */
function realRepo(home: string, name: string): { checkout: string; commit: string } {
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
  return { checkout, commit: git(checkout, "rev-parse", "HEAD") };
}

describe("#6 privileged prep scan (boundary B)", () => {
  it("parses worktree porcelain blocks into path+branch rows", () => {
    const porcelain = [
      "worktree /src/frontend",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree /tasks/task-abcdef12/repo-11111111",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/task/task-abcdef12",
      "",
      "worktree /src/detached",
      "HEAD 3333333333333333333333333333333333333333",
      "detached",
      "",
      "worktree /src/locked",
      "HEAD 4444444444444444444444444444444444444444",
      "branch refs/heads/feature/x",
      "locked",
      "",
    ].join("\n");
    expect(parseWorktreeList(porcelain)).toEqual([
      { path: "/src/frontend", branch: "main" },
      { path: "/tasks/task-abcdef12/repo-11111111", branch: "task/task-abcdef12" },
      { path: "/src/detached", branch: null },
      { path: "/src/locked", branch: "feature/x" },
    ]);
    expect(parseWorktreeList("")).toEqual([]);
  });

  it("maps a recorded repo folder to exactly one project repository, never guessing", () => {
    const repository = { id: "11111111-1111-1111-1111-111111111111", path: "/src/frontend" };
    expect(projectRepositoryForRepoDir("repo-11111111", [repository])).toEqual(repository);
    expect(projectRepositoryForRepoDir("repo-22222222", [repository])).toBeNull();
    // An ambiguous 8-hex prefix is refused instead of scanning an arbitrary repo.
    expect(
      projectRepositoryForRepoDir("repo-11111111", [
        { id: "11111111-aaaa-1111-1111-111111111111", path: "/src/a" },
        { id: "11111111-bbbb-1111-1111-111111111111", path: "/src/b" },
      ]),
    ).toBeNull();
    expect(resolveTargetCheckouts({ repoDirs: ["repo-11111111", "repo-11111111"], repositories: [repository] })).toEqual([
      { repoDir: "repo-11111111", checkout: "/src/frontend" },
    ]);
    expect(() => resolveTargetCheckouts({ repoDirs: ["repo-22222222"], repositories: [repository] })).toThrow(
      "task-scan-unavailable: 仓库 repo-22222222 没有可确认的来源检出",
    );
  });

  it("excludes this task's own worktrees and still reports a foreign one on the task branch", () => {
    const home = mkdtempSync(join(tmpdir(), "pidock-prep-scan-"));
    homes.push(home);
    const taskId = "task-abcdef12";
    const branch = `task/${taskId}`;
    const taskDir = join(home, "tasks", taskId);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "task.json"), "{}\n");
    const frontend = realRepo(home, "frontend");
    const invoice = realRepo(home, "invoice");
    const repoDir = "repo-11111111";
    // The task's OWN already-created worktree: `<taskDir>/<repoDir>` on the
    // task branch (every repo of one task shares that branch name).
    git(frontend.checkout, "worktree", "add", "-b", branch, join(taskDir, repoDir), frontend.commit);
    const deps = createNodePrepScanDeps();

    // (a) only this task's own worktree exists on the task branch: the scan
    // must NOT report that branch, so a partially-created task never refuses
    // itself. The source checkout's own branch (`main`) IS genuinely attached
    // to a worktree and stays reported (the gate only asks about the task
    // branch, so it changes nothing here).
    const own = scanPrepConflicts(
      { taskDir, checkouts: [{ repoDir, checkout: frontend.checkout }] },
      deps,
    );
    expect(own.branchesInUse).toEqual(["main"]);
    expect(own.branchesInUse).not.toContain(branch);
    expect([...own.takenPaths].sort()).toEqual(
      [`${taskDir}/${repoDir}`, `${taskDir}/task.json`].sort(),
    );
    // The exclusion — not git — is what removed it: git really lists it.
    expect(git(frontend.checkout, "worktree", "list", "--porcelain")).toContain(branch);

    // (b) a genuinely foreign worktree on the same branch in another target
    // repo (an unknown leftover) IS reported.
    git(invoice.checkout, "worktree", "add", "-b", branch, join(home, "foreign-elsewhere"), invoice.commit);
    const foreign = scanPrepConflicts(
      {
        taskDir,
        checkouts: [
          { repoDir, checkout: frontend.checkout },
          { repoDir: "repo-22222222", checkout: invoice.checkout },
        ],
      },
      deps,
    );
    expect(foreign.branchesInUse).toEqual(["main", branch]);
  });

  it("refuses by name when a checkout cannot be listed or the task folder cannot be read", () => {
    const home = mkdtempSync(join(tmpdir(), "pidock-prep-scan-"));
    homes.push(home);
    const taskDir = join(home, "tasks", "task-abcdef12");
    mkdirSync(taskDir, { recursive: true });
    const real = realRepo(home, "frontend");
    const notARepo = join(home, "not-a-repo");
    mkdirSync(notARepo);
    const deps = createNodePrepScanDeps();

    // A failing git (no repository) must refuse, never return `[]`.
    let failure: unknown;
    try {
      scanPrepConflicts({ taskDir, checkouts: [{ repoDir: "repo-11111111", checkout: notARepo }] }, deps);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PrepScanUnavailableError);
    expect((failure as PrepScanUnavailableError).code).toBe(PREP_SCAN_UNAVAILABLE);
    expect((failure as Error).message).toContain("worktree 列表读取失败");

    // An unreadable task folder refuses before any git call.
    const unreadable: PrepScanDeps = {
      listTaskDir: () => {
        throw new Error("EACCES");
      },
      probe: deps.probe,
      canonicalPath: deps.canonicalPath,
    };
    expect(() =>
      scanPrepConflicts({ taskDir, checkouts: [{ repoDir: "repo-11111111", checkout: real.checkout }] }, unreadable),
    ).toThrow("task-scan-unavailable: 任务目录不可读取");

    // A scan with no target repo at all is a refusal, not an empty scan.
    expect(() => scanPrepConflicts({ taskDir, checkouts: [] }, deps)).toThrow(
      "task-scan-unavailable: 没有可扫描的目标仓库",
    );
  });

  it("derives the scan and checkouts from the authority alone", () => {
    const home = mkdtempSync(join(tmpdir(), "pidock-prep-scan-"));
    homes.push(home);
    const taskId = "task-abcdef12";
    const taskDir = join(home, "tasks", taskId);
    mkdirSync(taskDir, { recursive: true });
    const frontend = realRepo(home, "frontend");
    const repository = { id: "11111111-1111-1111-1111-111111111111", path: frontend.checkout };
    const repoDir = `repo-${repository.id.slice(0, 8)}`;
    git(frontend.checkout, "worktree", "add", "-b", `task/${taskId}`, join(taskDir, repoDir), frontend.commit);
    const record = buildTaskDiskRecord({
      taskId,
      name: "多仓任务",
      dirId: taskId,
      branch: `task/${taskId}`,
      root: join(home, "tasks"),
      taskDir,
      remoteBranch: "main",
      baseCommit: frontend.commit,
      repos: [repoDir],
      repoSources: [{ repoDir, remote: "origin", remoteBranch: "main", baseCommit: frontend.commit }],
      now: "2026-09-24T10:00:00.000Z",
    });
    const derive = (input: { taskId: string; repoDirs: string[] }, readRecord = () => record) =>
      derivePrepInputs(input, {
        resolveTaskDir: (id) => (id === taskId ? taskDir : null),
        readRecord,
        projectRepositories: () => [repository],
      }, createNodePrepScanDeps());

    const derived = derive({ taskId, repoDirs: [] });
    expect(derived.takenPaths).toContain(`${taskDir}/${repoDir}`);
    expect(derived.branchesInUse).toEqual(["main"]);
    expect(derived.branchesInUse).not.toContain(`task/${taskId}`);
    expect(derived.mainCheckouts).toEqual({ [repoDir]: frontend.checkout });

    expect(() => derive({ taskId: "task-00000000", repoDirs: [] })).toThrow(
      "task-scan-unavailable: 任务目录无法确认",
    );
    expect(() => derive({ taskId, repoDirs: [] }, () => null)).toThrow(
      "task-scan-unavailable: 任务记录不可读取",
    );
  });

  it("overwrites a page-supplied scan and reports a failing scan as a named envelope", () => {
    const home = mkdtempSync(join(tmpdir(), "pidock-prep-scan-"));
    homes.push(home);
    const taskId = "task-abcdef12";
    const taskDir = join(home, "tasks", taskId);
    mkdirSync(taskDir, { recursive: true });
    const frontend = realRepo(home, "frontend");
    const repository = { id: "11111111-1111-1111-1111-111111111111", path: frontend.checkout };
    const repoDir = `repo-${repository.id.slice(0, 8)}`;
    git(frontend.checkout, "worktree", "add", "-b", `task/${taskId}`, join(taskDir, repoDir), frontend.commit);
    const record = buildTaskDiskRecord({
      taskId,
      name: "多仓任务",
      dirId: taskId,
      branch: `task/${taskId}`,
      root: join(home, "tasks"),
      taskDir,
      remoteBranch: "main",
      baseCommit: frontend.commit,
      repos: [repoDir],
      now: "2026-09-24T10:00:00.000Z",
    });
    const authority = {
      resolveTaskDir: (id: string) => (id === taskId ? taskDir : null),
      readRecord: () => record,
      projectRepositories: () => [repository],
    };
    const deps = createNodePrepScanDeps();

    // A page-supplied scan (here: an empty list plus a forged checkout) is
    // overwritten by what main derived itself.
    const derived = deriveRendererPrepPayload(
      {
        op: "task/resumeAppend",
        taskId,
        payload: { takenPaths: [], branchesInUse: ["forged-branch"], mainCheckouts: { forged: "/tmp/forged" } },
      },
      authority,
      deps,
    );
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(derived.payload["takenPaths"]).toEqual([`${taskDir}/${repoDir}`]);
    expect(derived.payload["branchesInUse"]).toEqual(["main"]);
    expect(derived.payload["branchesInUse"]).not.toContain("forged-branch");
    expect(derived.payload["mainCheckouts"]).toEqual({ [repoDir]: frontend.checkout });

    // An append selection with no confirmable checkout refuses by name.
    const failed = deriveRendererPrepPayload(
      {
        op: "task/appendRepos",
        taskId,
        payload: { repoSelections: [{ repoDir: "repo-99999999" }] },
      },
      authority,
      deps,
    );
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error).toContain(PREP_SCAN_UNAVAILABLE);
  });

  it("refuses by name when a present task record cannot be read or parsed", () => {
    const home = mkdtempSync(join(tmpdir(), "pidock-prep-scan-"));
    homes.push(home);
    const taskId = "task-abcdef12";
    const taskDir = join(home, "tasks", taskId);
    mkdirSync(taskDir, { recursive: true });
    // A present-but-unparseable record: `readTaskRecordOnDisk` rethrows the
    // parse error (only ENOENT maps to `null`), so the scan must map ANY read
    // failure to its named refusal instead of leaking a raw error.
    writeFileSync(taskFilePath(taskDir), "{ not valid json\n");
    expect(() =>
      derivePrepInputs(
        { taskId, repoDirs: [] },
        {
          resolveTaskDir: () => taskDir,
          readRecord: (dir) => readTaskRecordOnDisk(dir),
          projectRepositories: () => [],
        },
        createNodePrepScanDeps(),
      ),
    ).toThrow("task-scan-unavailable: 任务记录不可读取");
  });

  it("reads the task folder the same way the Host spells wanted worktree paths", () => {
    const home = mkdtempSync(join(tmpdir(), "pidock-prep-scan-"));
    homes.push(home);
    const taskDir = join(home, "tasks", "task-abcdef12");
    mkdirSync(join(taskDir, "repo-11111111"), { recursive: true });
    writeFileSync(join(taskDir, "task.json"), "{}\n");
    const frontend = realRepo(home, "frontend");
    const scan = scanPrepConflicts(
      { taskDir, checkouts: [{ repoDir: "repo-11111111", checkout: frontend.checkout }] },
      createNodePrepScanDeps(),
    );
    // Slash spelling shared with `previewMixedTaskPaths` (the Host's wanted
    // dirs), so `checkRepoConflicts` compares one string form.
    expect(scan.takenPaths).toEqual(readdirSync(taskDir).map((name) => `${taskDir}/${name}`));
  });
});
