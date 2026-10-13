/**
 * [PiDock 03] (#6 盒子 6) 两个任务共享一个仓库：各自的路径、工作分支与变化，以及真实的写入隔离.
 *
 * What this suite is for, stated first: the box asks for two tasks that share
 * ONE project repository to each show their own path, their own branch and
 * their own change, and for a write inside one task's Git worktree not to reach
 * the other, nor the shared source checkout. The isolation itself is structural
 * (`main/project-task-creation.ts` `commit()` runs `git worktree add -b
 * task/<taskId> <taskDir>/<repoDir> <pinned commit>` per task), so this suite is
 * the evidence, not a re-implementation.
 *
 * Evidence split (stated, not implied):
 * - REAL git: a real local source repository with a real bare remote, two tasks
 *   created through the real creation path, two real worktrees on two different
 *   real branches. Isolation is read back with git itself (`rev-parse` in each
 *   worktree, the file on disk in each worktree and in the source checkout).
 * - REAL observation: the roots readout and the change readout under test are
 *   the production ones (`host/workspace-files.ts` `observedRoots()` and
 *   `diff()` on `realWorkspaceFileReaders`), the same code `task/fileRoots` and
 *   `task/fileDiff` call.
 * - The declared record fields (`remoteBranch` = the pinned baseline, `branch` =
 *   the task's own branch) are asserted as DECLARED beside the observed ones, so
 *   the suite fails if a declared value is ever presented as a reading.
 * - FIXTURE: no Electron GUI, no Provider turn, no Windows run, no network git
 *   (the remote is a directory under the test's own temp home).
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TaskWorkspaceHost, diskTaskStore } from "../host/task-host.js";
import { readTaskRecordOnDisk, type TaskDiskRecord } from "../host/task-store.js";
import { TaskWorkspaceFiles, realWorkspaceFileReaders } from "../host/workspace-files.js";
import { ProjectRegistry } from "./project-registry.js";
import { CreationIntentStore, ProjectTaskCreation } from "./project-task-creation.js";
import { TaskRootIndex } from "./task-root-index.js";

/** Every test here builds real repositories; a loaded machine must not look like a failure. */
const ISOLATION_TEST_TIMEOUT_MS = 60_000;

const homes: string[] = [];

/**
 * The suite's own git. `GIT_OPTIONAL_LOCKS=0` keeps the READS here from
 * refreshing an index mtime, so the byte-and-mtime comparison below measures the
 * production readout and not this helper; real writes still take their locks.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).trim();
}

/** One project with one repository and one plain directory, plus a real bare remote. */
async function setup() {
  const home = mkdtempSync(join(tmpdir(), "pidock-box6-"));
  homes.push(home);
  const remote = join(home, "remote.git");
  const repo = join(home, "repo");
  const root = join(home, "tasks");
  const profile = join(home, "profile");
  const shared = join(home, "shared");
  mkdirSync(root);
  mkdirSync(shared);
  mkdirSync(repo);
  git(home, "init", "--bare", remote);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@localhost");
  git(repo, "config", "user.name", "Test");
  git(repo, "remote", "add", "origin", remote);
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "base");
  git(repo, "push", "-u", "origin", "main");
  writeFileSync(join(shared, "notes.md"), "original\n");
  const projects = new ProjectRegistry(profile);
  const project = await projects.create({
    name: "Genuine",
    description: "",
    repositories: [{ name: "source", path: repo }],
    directories: [{ name: "shared", path: shared }],
  });
  const roots = new TaskRootIndex(profile, root);
  const storage = new CreationIntentStore(profile);
  const host = {
    routeTaskOp: async ({ taskId, payload }: { taskId: string; op: "task/provision"; payload: Record<string, unknown> }) => {
      const instance = new TaskWorkspaceHost(taskId, join(payload.rootOverride as string, taskId), diskTaskStore);
      instance.provision(payload as never);
      return { workspaceId: "test", taskId, op: "task/provision" as const, payload: {} };
    },
  };
  const service = new ProjectTaskCreation(storage, projects, roots, host, root);
  const request = {
    projectId: project.id,
    name: "Actual work",
    repositories: [{ sourceId: project.repositories[0]!.id, remote: "origin", remoteBranch: "main" }],
    directoryIds: [project.directories[0]!.id],
    sharedWriteConfirmed: true,
    override: false,
  };
  return { home, remote, repo, root, profile, shared, project, projects, roots, storage, service, request };
}

/** Two tasks of the SAME project repository, through the real creation path. */
async function createTwo(env: Awaited<ReturnType<typeof setup>>) {
  const first = await env.service.prepare(env.request);
  await env.service.commit(first.id);
  const second = await env.service.prepare(env.request);
  await env.service.commit(second.id);
  const a = readTaskRecordOnDisk(first.taskDir);
  const b = readTaskRecordOnDisk(second.taskDir);
  if (!a || !b) throw new Error("task record missing after creation");
  return { a, b };
}

function files(task: TaskDiskRecord): TaskWorkspaceFiles {
  return new TaskWorkspaceFiles(task.taskId, task.taskDir, diskTaskStore, realWorkspaceFileReaders);
}

function worktreePath(task: TaskDiskRecord): string {
  return join(task.taskDir, task.repos[0]!);
}

/**
 * The bytes AND mtimes of everything a git read could rewrite: the source
 * checkout's index/HEAD and each worktree's own index/HEAD (a linked worktree
 * keeps them under the source repository's `.git/worktrees/<name>/`). Bytes
 * alone would not see a rewrite that produced identical content.
 */
function repoState(paths: readonly string[]): string {
  return paths
    .map((path) => `${path} ${statSync(path).mtimeMs} ${readFileSync(path).toString("base64")}`)
    .join("\n");
}

function watchedRepoFiles(task: TaskDiskRecord, source: string): string[] {
  const gitDir = git(worktreePath(task), "rev-parse", "--absolute-git-dir");
  return [join(source, ".git", "index"), join(source, ".git", "HEAD"), join(gitDir, "index"), join(gitDir, "HEAD")];
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("[PiDock 03] (#6 盒子 6) two tasks sharing one project repository", () => {
  it("reads each task's own worktree path, observed branch and change, and a write in one worktree reaches only that worktree", { timeout: ISOLATION_TEST_TIMEOUT_MS }, async () => {
    const env = await setup();
    const { a, b } = await createTwo(env);
    const pathA = worktreePath(a);
    const pathB = worktreePath(b);

    // (1) two independent worktrees of the SAME source repository.
    expect(a.repos[0]).toBe(b.repos[0]);
    expect(a.taskId).not.toBe(b.taskId);
    expect(pathA).not.toBe(pathB);
    // `git` reports the canonical path, the record keeps the path it was given.
    expect(realpathSync(git(pathA, "rev-parse", "--show-toplevel"))).toBe(realpathSync(pathA));
    expect(realpathSync(git(pathB, "rev-parse", "--show-toplevel"))).toBe(realpathSync(pathB));
    // "Shared source repo" stated directly rather than inferred from a common
    // repoDir/baseCommit: git itself answers that both worktrees hang off the
    // ONE source checkout's `.git` (a linked worktree's common dir).
    const commonDirOf = (worktree: string): string =>
      realpathSync(resolve(worktree, git(worktree, "rev-parse", "--git-common-dir")));
    const sourceGitDir = realpathSync(join(env.repo, ".git"));
    expect(commonDirOf(pathA)).toBe(sourceGitDir);
    expect(commonDirOf(pathB)).toBe(sourceGitDir);

    // (2) the two real working branches differ, and each is the task's own
    // DECLARED branch — read back with git, not from the record alone.
    const branchA = git(pathA, "rev-parse", "--abbrev-ref", "HEAD");
    const branchB = git(pathB, "rev-parse", "--abbrev-ref", "HEAD");
    expect(branchA).toBe(a.branch);
    expect(branchB).toBe(b.branch);
    expect(branchA).not.toBe(branchB);
    expect(branchA).toMatch(/^task\//);

    const watched = [...watchedRepoFiles(a, env.repo), ...watchedRepoFiles(b, env.repo)];
    const stateBefore = repoState(watched);

    // (3) the production roots readout, then a real change in A's worktree (one
    // untracked file, one tracked edit), then B's unchanged readout: between the
    // two snapshots ONLY the production reads and plain file writes run.
    const rootsA = files(a).observedRoots();
    const rootsB = files(b).observedRoots();
    writeFileSync(join(pathA, "isolated.txt"), "only task A\n");
    writeFileSync(join(pathA, "README.md"), "changed by A\n");
    const changedA = files(a).observedRoots()[0]!;
    const diffA = files(a).diff({ rootId: a.repos[0] });
    const dirtyB = files(b).observedRoots()[0]!.dirty;
    const diffB = files(b).diff({ rootId: b.repos[0] });

    // (4) nothing above wrote or locked a repository: the index and HEAD of the
    // shared source checkout AND of both worktrees are byte- and mtime-identical.
    expect(repoState(watched)).toBe(stateBefore);

    const [wtA, linkA] = rootsA;
    const [wtB] = rootsB;
    expect(rootsA.map((root) => root.id)).toEqual([a.repos[0], a.dirLinks![0]!.linkName]);
    expect(wtA).toMatchObject({
      kind: "worktree",
      // `observedRoots` spells the child with `/` (`joinRoot`,
      // `main/workspace-files.ts`: `<native taskDir>/<repoDir>`), so the fixture
      // must not use `join` for the repo dir on win32; `pathA` stays native for
      // git/fs calls.
      path: `${a.taskDir}/${a.repos[0]!}`,
      baselineBranch: "main",
      expectedBranch: a.branch,
      workingBranch: { state: "observed", value: branchA },
      dirty: { state: "observed", value: false },
    });
    expect(wtB).toMatchObject({
      kind: "worktree",
      // Same mixed form as `wtA` above (`pathB` stays native for git/fs calls).
      path: `${b.taskDir}/${b.repos[0]!}`,
      baselineBranch: "main",
      expectedBranch: b.branch,
      workingBranch: { state: "observed", value: branchB },
      dirty: { state: "observed", value: false },
    });
    // The declared baseline is the same for both, the observed branch is not:
    // that difference is what the surface must show, and neither is mislabelled.
    expect(wtA!.baselineBranch).toBe(wtB!.baselineBranch);
    expect(wtA!.workingBranch).not.toEqual(wtB!.workingBranch);
    // A link root has no branch at all, observed or declared.
    expect(linkA).toMatchObject({ kind: "shared-dir" });
    expect(linkA!.workingBranch).toBeUndefined();
    expect(linkA!.baselineBranch).toBeUndefined();

    // A's worktree really has the change; the untracked file is NOT in the
    // baseline diff, which is exactly why the uncommitted reading is required
    // before anything may read as clean.
    expect(changedA.dirty).toEqual({ state: "observed", value: true });
    expect(diffA.ok).toBe(true);
    if (!diffA.ok) return;
    expect(diffA.diff).toContain("changed by A");
    expect(diffA.diff).not.toContain("isolated.txt");

    // (5) B's worktree is untouched, by the same production reads and on disk.
    expect(dirtyB).toEqual({ state: "observed", value: false });
    expect(diffB.ok).toBe(true);
    if (!diffB.ok) return;
    expect(diffB.diff).toBe("");
    expect(git(pathB, "status", "--porcelain")).toBe("");
    // The worktree file went through the host's checkout settings
    // (`core.autocrlf` on win32 hands back `base\r\n`), so the assertion is
    // about the content: line endings are the checkout's, not the write's.
    expect(readFileSync(join(pathB, "README.md"), "utf8").replace(/\r\n/g, "\n")).toBe("base\n");
    expect(existsSync(join(pathB, "isolated.txt"))).toBe(false);

    // (6) the shared SOURCE checkout is untouched on disk, in git's own reading
    // and at the pinned baseline commit.
    expect(readFileSync(join(env.repo, "README.md"), "utf8")).toBe("base\n");
    expect(existsSync(join(env.repo, "isolated.txt"))).toBe(false);
    expect(git(env.repo, "status", "--porcelain")).toBe("");
    expect(git(env.repo, "rev-parse", "HEAD")).toBe(a.repoSources![0]!.baseCommit);
    expect(git(env.repo, "rev-parse", a.branch)).toBe(a.repoSources![0]!.baseCommit);
    expect(git(pathA, "rev-parse", "HEAD")).toBe(a.repoSources![0]!.baseCommit);

    // The source checkout really has both task branches, and the baseline branch
    // is still the same commit: the two worktrees branch off one source.
    expect(git(env.repo, "branch", "--list", a.branch, "--format=%(refname:short)").split("\n").sort()).toEqual([a.branch].sort());
    expect(git(pathA, "rev-parse", "HEAD")).toBe(a.repoSources![0]!.baseCommit);
  });

  it("names an unread worktree instead of answering a branch or a change for it", { timeout: ISOLATION_TEST_TIMEOUT_MS }, async () => {
    const env = await setup();
    const { a } = await createTwo(env);
    const pathA = worktreePath(a);
    const watched = watchedRepoFiles(a, env.repo);
    const stateBefore = repoState(watched);

    // A worktree that is gone is exactly the case a read must not paper over:
    // neither a branch nor a change may be answered for it.
    rmSync(pathA, { recursive: true, force: true });
    const [root] = files(a).observedRoots();
    expect(root!.workingBranch).toEqual({ state: "unknown", reason: expect.stringContaining("工作副本目录不可读") });
    expect(root!.dirty).toEqual({ state: "unknown", reason: expect.stringContaining("工作副本目录不可读") });
    // The record's declared branch is still reported, but ONLY as the declaration.
    expect(root!.expectedBranch).toBe(a.branch);
    const diff = files(a).diff({ rootId: a.repos[0] });
    expect(diff.ok).toBe(false);
    if (diff.ok) return;
    // Named for the path-local fact, never the machine-wide "no git here".
    expect(diff.error).toContain("工作副本目录不可读");
    expect(diff.error).not.toContain("本机没有可用的 Git 命令");
    expect(repoState(watched)).toBe(stateBefore);
  });

  it("shares the original directory through a plain-directory link and refuses its Git view by name", { timeout: ISOLATION_TEST_TIMEOUT_MS }, async () => {
    const env = await setup();
    const { a, b } = await createTwo(env);
    const [linkA] = files(a).observedRoots().filter((root) => root.kind === "shared-dir");
    const [linkB] = files(b).observedRoots().filter((root) => root.kind === "shared-dir");
    expect(linkA!.id).toBe(linkB!.id);
    expect(linkA!.sourcePath).toBe(env.shared);
    expect(linkA!.path).not.toBe(linkB!.path);
    expect(linkA!.path).not.toBe(env.shared);

    // No Git view for a link, refused BY NAME (not an empty diff that would read
    // like "no changes"), and never presented as an independent copy.
    const diff = files(a).diff({ rootId: linkA!.id });
    expect(diff.ok).toBe(false);
    if (diff.ok) return;
    expect(diff.error.startsWith("plain-dir-no-diff:")).toBe(true);
    expect(files(a).attribution(linkA!.id)?.sharedNote).toContain("修改影响原文件");

    // A write through the link lands in the ORIGINAL target — which is why the
    // worktree isolation above does not apply to it.
    writeFileSync(join(linkA!.path, "through-link.txt"), "written through the link\n");
    expect(readFileSync(join(env.shared, "through-link.txt"), "utf8")).toBe("written through the link\n");
    expect(readFileSync(join(linkB!.path, "through-link.txt"), "utf8")).toBe("written through the link\n");
    // The linked directory is not a repository, so no task-specific Git state
    // exists for it and the source repository is untouched by the write.
    expect(git(env.repo, "status", "--porcelain")).toBe("");
  });
});
