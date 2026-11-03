/**
 * [Pencil T07] #142: 默认自动创建独立 worktree — the remaining acceptance through
 * the REAL creation path (main), the REAL Host record and REAL git.
 *
 * What this suite exists for, stated first. #137 built the explicit modes and
 * #6 built the worktree machinery (fetch-pinned base, `git worktree add -b
 * task/<id>`, per-repo lock, intent recovery). This suite pins the #142
 * behaviour that was still open:
 *
 * - S02's default IS an independent worktree: a request that omits
 *   `workspaceMode` and one that names `worktree` behave identically.
 * - Each selected Git repo is created from the commit THIS creation fetched,
 *   and the record keeps the baseline (remote, remoteBranch, pinned commit)
 *   beside the ACTUAL observed checkout identity (target real path, branch,
 *   HEAD) — not a derived guess.
 * - A failed fetch refuses BY NAME, keeps the pending intent recoverable, and
 *   never falls back to a stale ref or silently becomes an existing-directory
 *   task.
 * - Creating a worktree never pushes and never creates a remote branch.
 * - Two tasks of one repository get different worktrees and different local
 *   branches, sequentially and concurrently, and concurrent creation cannot
 *   corrupt the repository's metadata (the per-repo lock).
 *
 * Evidence split (stated, not implied):
 * - REAL git: a temp bare remote and a temp clone; every assertion reads git
 *   itself (`worktree list`, `rev-parse`, `for-each-ref`) or the record.
 * - REAL production services: `ProjectTaskCreation` (through
 *   `performCreationOperation`, the IPC trust boundary), `TaskWorkspaceHost`
 *   (the record owner) and `WorktreeMetadataLock` (the production lock).
 * - The no-push case additionally runs the creation under a PATH `git` shim that
 *   logs every invocation and delegates to the real binary; it is skipped on
 *   win32 because the shim is a shebang script.
 * - FIXTURE: no Electron GUI, no Provider turn, no network git.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskWorkspaceHost, diskTaskStore } from "../host/task-host.js";
import { readTaskRecordOnDisk } from "../host/task-store.js";
import { TaskWorkspaceFiles } from "../host/workspace-files.js";
import { ProjectRegistry } from "./project-registry.js";
import { CreationIntentStore, ProjectTaskCreation } from "./project-task-creation.js";
import { performCreationOperation } from "./project-task-ipc.js";
import { TaskRootIndex } from "./task-root-index.js";
import { WorktreeMetadataLock } from "./worktree-metadata-lock.js";

const TEST_TIMEOUT_MS = 90_000;
const homes: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** `git worktree list --porcelain` without the source checkout itself. */
function worktrees(repo: string): string[] {
  return git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .filter((path) => realpathSync(path) !== realpathSync(repo))
    .sort();
}

function taskBranches(repo: string): string[] {
  const listed = git(repo, "for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/heads/task/");
  return listed.length === 0 ? [] : listed.split("\n").map((line) => line.split("\t")[0]!).sort();
}

/** Every ref of the bare remote, read before and after a creation. */
function remoteRefs(remote: string): string {
  return git(remote, "for-each-ref", "--format=%(refname)%09%(objectname)");
}

async function setup(options: { lock?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "pidock-142-"));
  homes.push(home);
  const remote = join(home, "remote.git");
  const repo = join(home, "repo");
  const root = join(home, "tasks");
  const profile = join(home, "profile");
  mkdirSync(root);
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
  const projects = new ProjectRegistry(profile);
  const project = await projects.create({ name: "Real", description: "", repositories: [{ name: "source", path: repo }], directories: [] });
  const roots = new TaskRootIndex(profile, root);
  const storage = new CreationIntentStore(profile);
  const host = {
    routeTaskOp: async ({ taskId, payload }: { taskId: string; op: string; payload: Record<string, unknown> }) => {
      const taskDir = join(payload["rootOverride"] as string, taskId);
      const instance = new TaskWorkspaceHost(taskId, taskDir, diskTaskStore);
      instance.provision(payload as never);
      return { workspaceId: "test", taskId, op: "task/provision" as const, payload: {} };
    },
  };
  const lock = options.lock === false ? undefined : new WorktreeMetadataLock(profile);
  const service = new ProjectTaskCreation(storage, projects, roots, host, root, undefined, lock);
  const repository = project.repositories[0]!;
  const selection = { sourceId: repository.id, remote: "origin", remoteBranch: "main" };
  const request = (name: string, mode?: "worktree" | "existing-git" | "plain-dirs") => ({
    projectId: project.id, name,
    repositories: [selection],
    directoryIds: [] as string[], sharedWriteConfirmed: false, override: false,
    ...(mode !== undefined ? { workspaceMode: mode } : {}),
  });
  const create = async (name: string): Promise<{ taskId: string; taskDir: string; branch: string }> => {
    const prepared = (await performCreationOperation(service, { op: "prepare", input: request(name) }, async () => null, () => undefined)) as {
      canceled: boolean; intent: { id: string; taskId: string; taskDir: string; branch: string };
    };
    if (prepared.canceled) throw new Error("creation was canceled");
    await performCreationOperation(service, { op: "commit", id: prepared.intent.id }, async () => null, () => undefined);
    return prepared.intent;
  };
  const prepare = async (name: string) => {
    const prepared = (await performCreationOperation(service, { op: "prepare", input: request(name) }, async () => null, () => undefined)) as {
      canceled: boolean; intent: { id: string; taskId: string; taskDir: string; branch: string; workspaceMode: string };
    };
    if (prepared.canceled) throw new Error("creation was canceled");
    return prepared.intent;
  };
  return {
    home, remote, repo, root, profile, project, projects, roots, storage, service, lock, request, create, prepare,
    files: (taskDir: string) => new TaskWorkspaceFiles(taskDir.slice(taskDir.lastIndexOf("task-")), taskDir, diskTaskStore),
  };
}

afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("[Pencil T07] #142 worktree-by-default through the real creation path", { timeout: TEST_TIMEOUT_MS }, () => {
  it("treats an omitted workspace mode exactly as 独立 Worktree, and records the pinned baseline with the observed checkout identity", async () => {
    const env = await setup();
    // A commit that exists ONLY on the remote: the source checkout's local
    // branch and stale remote-tracking ref must not be the base.
    writeFileSync(join(env.repo, "next.txt"), "next\n");
    git(env.repo, "add", "next.txt");
    git(env.repo, "commit", "-m", "next");
    const pushed = git(env.repo, "rev-parse", "HEAD");
    git(env.repo, "push", "origin", "main");
    git(env.repo, "reset", "--hard", "HEAD~1");
    // A stale remote-tracking ref pointing at the OLD commit, as a previous
    // fetch would have left it.
    git(env.repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    expect(git(env.repo, "rev-parse", "refs/remotes/origin/main")).not.toBe(pushed);

    const prepared = await env.prepare("Worktree work");
    expect(prepared.workspaceMode).toBe("worktree");
    await env.service.commit(prepared.id);
    const record = readTaskRecordOnDisk(prepared.taskDir);
    expect(record?.workspaceMode).toBe("worktree");
    expect(record?.branch).toBe(prepared.branch);
    expect(record?.repos).toHaveLength(1);
    const source = record?.repoSources?.[0];
    // Baseline: the remote name, the branch and the commit THIS creation fetched.
    expect(source).toMatchObject({ remote: "origin", remoteBranch: "main", baseCommit: pushed });
    // Observed checkout identity: the real target path, the branch it is really
    // on and the HEAD it really points at (read back by git, and recorded).
    const worktree = join(prepared.taskDir, record!.repos[0]!);
    expect(source?.targetRealPath).toBe(realpathSync(worktree));
    expect(source?.targetBranch).toBe(git(worktree, "rev-parse", "--abbrev-ref", "HEAD"));
    expect(source?.targetHead).toBe(git(worktree, "rev-parse", "HEAD"));
    expect(source?.targetHead).toBe(pushed);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(pushed);
    // The S08 facts read shows, per repo: the worktree path, the LOCAL task
    // branch, the pinned base commit and the source checkout identity.
    const facts = env.files(prepared.taskDir).facts();
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      kind: "worktree",
      path: `${prepared.taskDir}/${record!.repos[0]!}`,
      expectedBranch: prepared.branch,
      baseCommit: pushed,
      sourceRealPath: realpathSync(env.repo),
      workingBranch: { state: "observed", value: prepared.branch },
    });
    // The source checkout itself was never moved to the fetched commit.
    expect(git(env.repo, "rev-parse", "HEAD")).toBe(git(env.repo, "rev-parse", "HEAD~0"));
    expect(git(env.repo, "rev-parse", "HEAD")).not.toBe(pushed);
    expect(existsSync(join(env.repo, "next.txt"))).toBe(false);

    // An EXPLICIT worktree request produces the same shape.
    const explicit = await performCreationOperation(env.service,
      { op: "prepare", input: env.request("Explicit worktree", "worktree") }, async () => null, () => undefined) as {
        canceled: boolean; intent: { id: string; workspaceMode: string } };
    expect(explicit.intent.workspaceMode).toBe("worktree");
    await env.service.commit(explicit.intent.id);
  });

  it("names a failed fetch, creates nothing, and never falls back to a stale ref or an existing checkout", async () => {
    const env = await setup();
    const prepared = await env.prepare("Fetch failure work");
    // The remote branch disappears after `prepare` pinned it: the creation's own
    // fetch must fail, not reuse the pin, the local branch or a cached ref.
    git(env.home, "--git-dir", env.remote, "update-ref", "-d", "refs/heads/main");
    await expect(env.service.commit(prepared.id)).rejects.toThrow(/获取失败.*repo-[0-9a-f]{8}.*origin\/main/);
    // The refusal is named for the task's repository AND the branch, and says
    // what it did NOT do. A silent downgrade to existing-git would create a
    // task here.
    await expect(env.service.commit(prepared.id)).rejects.toThrow(/未使用旧基线/);
    expect(existsSync(join(prepared.taskDir, "task.json"))).toBe(false);
    expect(worktrees(env.repo)).toEqual([]);
    expect(taskBranches(env.repo)).toEqual([]);
    // The intent is still recoverable AS a worktree task (no mode downgrade).
    const pending = env.storage.read();
    expect(pending?.state).toBe("pending");
    expect(pending?.workspaceMode).toBe("worktree");

    // Restore the remote branch and retry the SAME intent: it succeeds.
    git(env.repo, "push", "origin", "main");
    await env.service.commit(prepared.id);
    const record = readTaskRecordOnDisk(prepared.taskDir);
    expect(record?.workspaceMode).toBe("worktree");
    expect(record?.repoSources?.[0]?.baseCommit).toBe(git(env.remote, "rev-parse", "refs/heads/main"));
    expect(worktrees(env.repo)).toHaveLength(1);
  });

  it("refuses a remote branch that moved after prepare instead of creating from the old baseline", async () => {
    const env = await setup();
    const prepared = await env.prepare("Moved remote work");
    writeFileSync(join(env.repo, "moved.txt"), "moved\n");
    git(env.repo, "add", "moved.txt");
    git(env.repo, "commit", "-m", "moved");
    git(env.repo, "push", "origin", "main");
    const moved = git(env.remote, "rev-parse", "refs/heads/main");
    await expect(env.service.commit(prepared.id)).rejects.toThrow("远程分支已变化，不使用旧基线");
    expect(existsSync(join(prepared.taskDir, "task.json"))).toBe(false);
    expect(worktrees(env.repo)).toEqual([]);
    expect(taskBranches(env.repo)).toEqual([]);
    // The baseline moved on the remote; that fetch was refused, so the source
    // checkout's own branch is still where the user left it.
    expect(moved).toBe(git(env.remote, "rev-parse", "refs/heads/main"));
    expect(git(env.repo, "rev-parse", "HEAD")).toBe(moved);
  });

  it("never pushes and never creates a remote branch while creating a worktree", async () => {
    const env = await setup();
    const before = remoteRefs(env.remote);
    const remoteTracking = git(env.repo, "for-each-ref", "--format=%(refname)%09%(objectname)", "refs/remotes");

    // Every `git` invocation of the creation is logged through a PATH shim that
    // then runs the real binary: the assertion below is about what production
    // actually executed, not about what the source code appears to say.
    const shim = join(env.home, "bin");
    mkdirSync(shim);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const log = join(env.home, "git-invocations.log");
    writeFileSync(join(shim, "git"), `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(process.env.PIDOCK_GIT_LOG, JSON.stringify(args) + "\\n");
const result = spawnSync(process.env.PIDOCK_REAL_GIT, args, { stdio: "inherit" });
process.exit(result.status === null ? 1 : result.status);
`);
    chmodSync(join(shim, "git"), 0o755);
    const originalPath = process.env["PATH"];
    const originalLog = process.env["PIDOCK_GIT_LOG"];
    const originalReal = process.env["PIDOCK_REAL_GIT"];
    process.env["PATH"] = `${shim}${process.platform === "win32" ? ";" : ":"}${originalPath ?? ""}`;
    process.env["PIDOCK_GIT_LOG"] = log;
    process.env["PIDOCK_REAL_GIT"] = realGit;
    try {
      await env.create("No push work");
    } finally {
      if (originalPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = originalPath;
      if (originalLog === undefined) delete process.env["PIDOCK_GIT_LOG"]; else process.env["PIDOCK_GIT_LOG"] = originalLog;
      if (originalReal === undefined) delete process.env["PIDOCK_REAL_GIT"]; else process.env["PIDOCK_REAL_GIT"] = originalReal;
    }
    const invocations = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    // The shim was really used: the creation's own git commands are in the log.
    expect(invocations.some((args) => args[0] === "worktree" && args[1] === "add")).toBe(true);
    // No push, no remote-branch creation, no mirror/refspec write.
    expect(invocations.filter((args) => args[0] === "push")).toEqual([]);
    expect(invocations.filter((args) => args[0] === "update-ref" || args[0] === "branch" && args.includes("-r"))).toEqual([]);
    // The remote is byte-for-byte where it was, and no remote-tracking ref moved.
    expect(remoteRefs(env.remote)).toBe(before);
    expect(git(env.repo, "for-each-ref", "--format=%(refname)%09%(objectname)", "refs/remotes")).toBe(remoteTracking);
    // The local task branch exists on the shared source repository, which is
    // the only ref a worktree creation adds.
    expect(taskBranches(env.repo)).toHaveLength(1);
  });

  it("gives two sequential tasks of one repository different worktrees and different local branches", async () => {
    const env = await setup();
    const before = remoteRefs(env.remote);
    const first = await env.create("First task");
    const second = await env.create("Second task");
    const firstRecord = readTaskRecordOnDisk(first.taskDir)!;
    const secondRecord = readTaskRecordOnDisk(second.taskDir)!;
    const firstWorktree = join(first.taskDir, firstRecord.repos[0]!);
    const secondWorktree = join(second.taskDir, secondRecord.repos[0]!);

    expect(firstWorktree).not.toBe(secondWorktree);
    expect(firstRecord.branch).not.toBe(secondRecord.branch);
    expect(git(firstWorktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(firstRecord.branch);
    expect(git(secondWorktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(secondRecord.branch);
    // `git worktree list` (git's own metadata) holds exactly the source checkout
    // plus both task worktrees, and both task branches point at the pinned base.
    expect(worktrees(env.repo)).toEqual([realpathSync(firstWorktree), realpathSync(secondWorktree)].sort());
    expect(taskBranches(env.repo)).toEqual([firstRecord.branch, secondRecord.branch].sort());
    const base = firstRecord.repoSources![0]!.baseCommit;
    expect(secondRecord.repoSources![0]!.baseCommit).toBe(base);
    for (const branch of taskBranches(env.repo)) expect(git(env.repo, "rev-parse", branch)).toBe(base);
    // No task was created by pushing: the remote is exactly as it was.
    expect(remoteRefs(env.remote)).toBe(before);
  });

  it("refuses concurrent creations while the repository lock is held, then creates two distinct worktrees concurrently", async () => {
    const env = await setup();
    // Two independent creation services on the SAME app data directory, the way
    // two app instances share one profile: separate intent stores and queues,
    // one shared repository-level lock (the production exclusion).
    const secondProfile = join(env.home, "profile-2");
    mkdirSync(secondProfile);
    const serviceA = env.service;
    const serviceB = new ProjectTaskCreation(new CreationIntentStore(secondProfile), env.projects, env.roots,
      { routeTaskOp: async ({ taskId, payload }: { taskId: string; op: string; payload: Record<string, unknown> }) => {
        const taskDir = join(payload["rootOverride"] as string, taskId);
        new TaskWorkspaceHost(taskId, taskDir, diskTaskStore).provision(payload as never);
        return { workspaceId: "test", taskId, op: "task/provision" as const, payload: {} };
      } },
      env.root, undefined, new WorktreeMetadataLock(env.profile));
    const prepareOn = async (service: ProjectTaskCreation, name: string) => {
      const prepared = (await performCreationOperation(service, { op: "prepare", input: env.request(name) }, async () => null, () => undefined)) as {
        canceled: boolean; intent: { id: string; taskId: string; taskDir: string; branch: string } };
      if (prepared.canceled) throw new Error("creation was canceled");
      return prepared.intent;
    };
    const a = await prepareOn(serviceA, "Concurrent A");
    const b = await prepareOn(serviceB, "Concurrent B");
    const before = remoteRefs(env.remote);

    // Phase 1: the repository is being worked on by someone else. Both
    // concurrent creations refuse BY NAME and create nothing at all — no
    // branch, no worktree, no record, no partial metadata.
    const holder = new WorktreeMetadataLock(env.profile).acquireFor([env.repo], { taskId: "task-other0000", label: "其他任务" });
    expect(holder.ok).toBe(true);
    const refused = await Promise.allSettled([serviceA.commit(a.id), serviceB.commit(b.id)]);
    expect(refused.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    for (const result of refused) {
      if (result.status === "rejected") expect(String(result.reason)).toMatch(/worktree-locked: .*本次操作未创建任何分支、工作副本或记录/);
    }
    if (holder.ok) holder.release();
    expect(worktrees(env.repo)).toEqual([]);
    expect(taskBranches(env.repo)).toEqual([]);
    expect(existsSync(join(a.taskDir, "task.json"))).toBe(false);
    expect(existsSync(join(b.taskDir, "task.json"))).toBe(false);

    // Phase 2: the same two intents, committed concurrently without a holder.
    // Both really succeed; git's own metadata parses and lists exactly the
    // source checkout plus two worktrees on two different task branches.
    const committed = await Promise.all([serviceA.commit(a.id), serviceB.commit(b.id)]);
    expect(committed.map((result) => result.taskId).sort()).toEqual([a.taskId, b.taskId].sort());
    const list = git(env.repo, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "));
    expect(list).toHaveLength(3);
    const recordA = readTaskRecordOnDisk(a.taskDir)!;
    const recordB = readTaskRecordOnDisk(b.taskDir)!;
    const worktreeA = realpathSync(join(a.taskDir, recordA.repos[0]!));
    const worktreeB = realpathSync(join(b.taskDir, recordB.repos[0]!));
    expect(worktreeA).not.toBe(worktreeB);
    expect(recordA.branch).not.toBe(recordB.branch);
    expect(worktrees(env.repo)).toEqual([worktreeA, worktreeB].sort());
    expect(taskBranches(env.repo)).toEqual([recordA.branch, recordB.branch].sort());
    const base = recordA.repoSources![0]!.baseCommit;
    for (const branch of [recordA.branch, recordB.branch]) expect(git(env.repo, "rev-parse", branch)).toBe(base);
    // Git can still read every worktree entry it wrote (no corrupted metadata).
    expect(() => git(env.repo, "worktree", "list", "--porcelain")).not.toThrow();
    expect(git(env.repo, "rev-parse", "--verify", "HEAD")).toHaveLength(40);
    expect(remoteRefs(env.remote)).toBe(before);
  });
});
