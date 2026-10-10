import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskWorkspaceHost } from "../host/task-host.js";
import { diskTaskStore, readTaskRecordOnDisk } from "../host/task-store.js";
import type { HostTaskResult, HostTaskOp } from "../rpc/protocol.js";
import { buildRepoChildName } from "./multi-repo-provision.js";
import { ProjectRegistry } from "./project-registry.js";
import { CreationIntentStore, ProjectTaskCreation } from "./project-task-creation.js";
import { performCreationOperation } from "./project-task-ipc.js";
import { performAppendOperation } from "./project-append-ipc.js";
import { createNodeAppendGit, ProjectTaskAppend, executeAppendPlan, describeFetchFailure } from "./task-append.js";
import { createNodePrepScanDeps, createPrepScanAuthority, derivePrepInputs } from "./task-prep-scan.js";
import { TaskRootIndex } from "./task-root-index.js";

// Seam: [PiDock 03] (#6) production append for an EXISTING task. These tests
// drive the REAL create flow, the REAL `TaskWorkspaceHost` (in process, the
// same boundary the other #6 evidence uses) and real temporary Git remotes,
// clones and worktrees. The Host is reached through a routing fake that
// reproduces the `host/task` contract: an op payload goes in, the Host's own
// refusals reject the promise, and the returned plan rides `payload.plan`.

const homes: string[] = [];
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
interface RepoFixture {
  repo: string;
  remote: string;
  branch: string;
}
function makeRepo(home: string, name: string, content: string): RepoFixture {
  const remote = join(home, `${name}-remote.git`);
  const repo = join(home, name);
  mkdirSync(repo);
  git(home, "init", "--bare", remote);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@localhost");
  git(repo, "config", "user.name", "Test");
  git(repo, "remote", "add", "origin", remote);
  writeFileSync(join(repo, "README.md"), `${content}\n`);
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", `${name} baseline`);
  git(repo, "push", "-u", "origin", "main");
  return { repo, remote, branch: "main" };
}
/**
 * Move a repository's remote branch from ANOTHER clone, so the fixture's own
 * checkout keeps a stale `origin/main`: creating from a cached local ref would
 * then take the wrong baseline.
 */
function advanceFromElsewhere(home: string, fixture: RepoFixture, name: string, content: string): string {
  const other = join(home, name);
  git(home, "clone", "-b", fixture.branch, fixture.remote, other);
  git(other, "config", "user.email", "test@localhost");
  git(other, "config", "user.name", "Test");
  writeFileSync(join(other, "README.md"), `${content}\n`);
  git(other, "add", "README.md");
  git(other, "commit", "-m", content);
  git(other, "push", "origin", fixture.branch);
  return git(other, "rev-parse", "HEAD");
}
async function setup() {
  const home = mkdtempSync(join(tmpdir(), "pidock-append-"));
  homes.push(home);
  const root = join(home, "tasks");
  mkdirSync(root);
  const first = makeRepo(home, "first", "first baseline");
  const second = makeRepo(home, "second", "second baseline");
  const third = makeRepo(home, "third", "third baseline");
  const profile = join(home, "profile");
  const projects = new ProjectRegistry(profile);
  const project = await projects.create({
    name: "Genuine",
    description: "",
    repositories: [
      { name: "first", path: first.repo },
      { name: "second", path: second.repo },
      { name: "third", path: third.repo },
    ],
    directories: [],
  });
  const roots = new TaskRootIndex(profile, root);
  const storage = new CreationIntentStore(profile);
  const payloads: Record<string, unknown>[] = [];
  const taskRootFor = (taskId: string, payload: Record<string, unknown>): string =>
    join((payload["rootOverride"] as string | undefined) ?? root, taskId);
  const host = {
    async routeTaskOp(params: { taskId: string; op: HostTaskOp; payload: Record<string, unknown> }): Promise<HostTaskResult> {
      const instance = new TaskWorkspaceHost(params.taskId, taskRootFor(params.taskId, params.payload), diskTaskStore);
      if (params.op === "task/provision") {
        const { record, plan } = instance.provision(params.payload as never);
        return { workspaceId: "w", taskId: params.taskId, op: params.op, payload: { ...record, plan } };
      }
      if (params.op === "task/appendRepos") {
        payloads.push(params.payload);
        // The Host refuses by throwing (the RPC boundary turns that into a
        // rejected route), so a refusal can never look like a success here.
        const result = instance.appendRepos(params.payload as never);
        return {
          workspaceId: "w",
          taskId: params.taskId,
          op: params.op,
          payload: { ...result.record, plan: result.plan, appended: result.appended, skipped: result.skipped },
        };
      }
      if (params.op === "task/resumeAppend") {
        const resumed = instance.resumeAppend(params.payload as never);
        return {
          workspaceId: "w",
          taskId: params.taskId,
          op: params.op,
          payload: {
            outcomes: resumed.outcomes,
            created: resumed.created,
            pending: resumed.pending,
            failed: resumed.failed,
            retry: resumed.retry,
            hold: resumed.hold,
            resumed: resumed.resumed,
            plan: resumed.plan,
          },
        };
      }
      if (params.op === "task/prepareStatus") {
        return {
          workspaceId: "w",
          taskId: params.taskId,
          op: params.op,
          payload: instance.prepareStatus() as unknown as Record<string, unknown>,
        };
      }
      throw new Error(`unexpected op ${params.op}`);
    },
  };
  const creation = new ProjectTaskCreation(storage, projects, roots, host, root);
  const created = await performCreationOperation(
    creation,
    {
      op: "prepare",
      input: {
        projectId: project.id,
        name: "Actual work",
        repositories: [{ sourceId: project.repositories[0]!.id, remote: "origin", remoteBranch: "main" }],
        directoryIds: [],
        sharedWriteConfirmed: false,
        override: false,
      },
    },
    async () => null,
    () => undefined,
  );
  const intent = (created as { intent: { id: string; taskId: string; taskDir: string; branch: string } }).intent;
  await performCreationOperation(creation, { op: "commit", id: intent.id }, async () => null, () => undefined);
  const append = new ProjectTaskAppend(host, createPrepScanAuthority(projects, roots), createNodePrepScanDeps(), createNodeAppendGit());
  return {
    home,
    root,
    profile,
    projects,
    roots,
    project,
    first,
    second,
    third,
    host,
    append,
    payloads,
    taskId: intent.taskId,
    taskDir: intent.taskDir,
    branch: intent.branch,
    recordBytes: () => readFileSync(join(intent.taskDir, "task.json")),
    worktreeOf: (fixture: RepoFixture) => join(intent.taskDir, buildRepoChildName(repoIdOf(project, fixture))),
    selection: (fixture: RepoFixture, remote = "origin", remoteBranch = "main") => ({
      sourceId: repoIdOf(project, fixture),
      remote,
      remoteBranch,
    }),
  };
}
function repoIdOf(project: { repositories: { id: string; name: string; path: string }[] }, fixture: RepoFixture): string {
  const found = project.repositories.find((row) => row.path === fixture.repo);
  if (!found) throw new Error("fixture is not a project repository");
  return found.id;
}
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("production task-source append", () => {
  it("fetches the selected remote branch in its own checkout and creates the worktree at the pinned commit, leaving the existing repo untouched", async () => {
    const env = await setup();
    const firstWorktree = env.worktreeOf(env.first);
    const firstHead = git(firstWorktree, "rev-parse", "HEAD");
    const firstStatus = git(firstWorktree, "status", "--porcelain");
    const firstBaseline = readTaskRecordOnDisk(env.taskDir)!.repoSources![0]!;
    // The second repository's source checkout is stale: its remote branch
    // moves on while its local `origin/main` keeps the old commit, so a
    // creation from a cached ref would take the wrong baseline.
    const fresh = advanceFromElsewhere(env.home, env.second, "second-other", "second moved on");
    const staleHead = git(env.second.repo, "rev-parse", "HEAD");
    expect(git(env.second.repo, "rev-parse", "origin/main")).toBe(staleHead);
    expect(staleHead).not.toBe(fresh);

    const result = await env.append.append({
      taskId: env.taskId,
      repositories: [env.selection(env.second)],
    });

    const repoDir = buildRepoChildName(repoIdOf(env.project, env.second));
    expect(result.skipped).toEqual([]);
    expect(result.appended).toHaveLength(1);
    const appended = result.appended[0]!;
    expect(appended).toMatchObject({
      repoDir,
      name: "second",
      remote: "origin",
      remoteBranch: "main",
      commit: fresh,
      worktree: join(env.taskDir, repoDir),
    });
    // The fetch happened in the second repo's OWN checkout and pinned the
    // exact fresh commit (not the stale local branch, not another repo's).
    expect(git(env.second.repo, "rev-parse", "FETCH_HEAD")).toBe(fresh);
    // The source checkout itself still sits on the old commit: the worktree's
    // fresh commit can only come from this append's fetch, never from a local
    // ref or cached state.
    expect(git(env.second.repo, "rev-parse", "HEAD")).toBe(staleHead);
    // The worktree exists at the pinned commit on the task branch.
    expect(git(appended.worktree, "rev-parse", "HEAD")).toBe(fresh);
    expect(git(appended.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(env.branch);
    expect(readFileSync(join(appended.worktree, "README.md"), "utf8")).toBe("second moved on\n");
    // Main-derived scan + checkouts rode the Host payload.
    const payload = env.payloads.at(-1)!;
    // `takenPaths` is the REAL task-folder listing (the existing worktree and
    // the task record), not anything the page supplied.
    expect(payload["takenPaths"]).toEqual(expect.arrayContaining([`${env.taskDir}/task.json`, firstWorktree]));
    // The scan lists the source checkout's own worktree branch too (`main`);
    // the task branch it gates on is absent, so the append is planned.
    expect(payload["branchesInUse"]).toEqual(["main"]);
    // Checkouts are resolved from the registry for every target repo (the
    // existing one is included) and each git op runs in its own.
    expect(payload["mainCheckouts"]).toEqual({
      [buildRepoChildName(repoIdOf(env.project, env.first))]: env.first.repo,
      [repoDir]: env.second.repo,
    });
    expect(payload["branch"]).toBe(env.branch);
    expect(payload["fetchedCommits"]).toEqual({ [repoDir]: fresh });
    // Both repositories are recorded, with their own pinned full commits.
    const record = readTaskRecordOnDisk(env.taskDir)!;
    expect(record.repos).toContain(repoDir);
    expect(record.repoSources?.map((source) => [source.repoDir, source.baseCommit])).toEqual(
      expect.arrayContaining([[firstBaseline.repoDir, firstBaseline.baseCommit], [repoDir, fresh]]),
    );
    expect(record.repoSources?.length).toBe(2);
    // ... and the existing repository's worktree, baseline and task identity
    // are byte-identical: the append only added a repository.
    expect(record.taskId).toBe(env.taskId);
    expect(record.root).toBe(env.root);
    expect(record.branch).toBe(env.branch);
    expect(record.repoSources?.[0]).toEqual(firstBaseline);
    expect(git(firstWorktree, "rev-parse", "HEAD")).toBe(firstHead);
    expect(git(firstWorktree, "status", "--porcelain")).toBe(firstStatus);
    expect(git(firstWorktree, "status", "--porcelain")).toBe("");
  });

  it("creates nothing and keeps the record byte-identical when one selected repository cannot be fetched, then succeeds on retry", async () => {
    const env = await setup();
    const before = env.recordBytes();
    const secondWorktrees = git(env.second.repo, "worktree", "list", "--porcelain");
    // The third repository's remote branch disappears: fetch fails for it.
    git(env.home, `--git-dir=${env.third.remote}`, "update-ref", "-d", "refs/heads/main");
    const attempt = env.append.append({
      taskId: env.taskId,
      repositories: [env.selection(env.second), env.selection(env.third)],
    });
    await expect(attempt).rejects.toThrow(/^fetch-failed: 仓库 repo-[0-9a-f]{8}（third）获取 origin\/main 失败（远程分支不存在或已删除）/);
    // Nothing was created, in either repository, and the record did not move.
    expect(env.recordBytes()).toEqual(before);
    expect(readdirSync(env.taskDir).sort()).toEqual([".pidock-creation", "task.json", buildRepoChildName(repoIdOf(env.project, env.first))].sort());
    expect(git(env.second.repo, "worktree", "list", "--porcelain")).toBe(secondWorktrees);
    expect(git(env.second.repo, "branch", "--list", env.branch)).toBe("");
    expect(git(env.third.repo, "branch", "--list", env.branch)).toBe("");
    expect(env.payloads).toHaveLength(0);
    // Fixing the remote makes the same intent succeed: the refusal is retryable.
    git(env.third.repo, "push", "origin", "main");
    const retry = await env.append.append({
      taskId: env.taskId,
      repositories: [env.selection(env.second), env.selection(env.third)],
    });
    expect(retry.appended.map((repo) => repo.repoDir)).toEqual([
      buildRepoChildName(repoIdOf(env.project, env.second)),
      buildRepoChildName(repoIdOf(env.project, env.third)),
    ]);
    for (const repo of retry.appended) {
      expect(git(repo.worktree, "rev-parse", "HEAD")).toBe(repo.commit);
      expect(git(repo.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(env.branch);
    }
    expect(readTaskRecordOnDisk(env.taskDir)!.repoSources?.length).toBe(3);
  });

  it("refuses a foreign worktree that already uses the task branch as branch-in-use, creating nothing", async () => {
    const env = await setup();
    const before = env.recordBytes();
    const foreign = join(env.home, "foreign-second");
    git(env.second.repo, "worktree", "add", "-b", env.branch, foreign);
    await expect(
      env.append.append({ taskId: env.taskId, repositories: [env.selection(env.second)] }),
    ).rejects.toThrow(/^branch-in-use: 分支已在其他 worktree 使用/);
    expect(env.recordBytes()).toEqual(before);
    expect(git(env.second.repo, "worktree", "list", "--porcelain")).toContain(foreign);
    expect(existsSync(env.worktreeOf(env.second))).toBe(false);
    expect(env.payloads.at(-1)?.["branchesInUse"]).toEqual(expect.arrayContaining(["main", env.branch]));
  });

  it("refuses an occupied target path as path-taken, leaving the occupancy untouched", async () => {
    const env = await setup();
    const before = env.recordBytes();
    const occupied = env.worktreeOf(env.second);
    mkdirSync(occupied);
    writeFileSync(join(occupied, "keep.txt"), "not ours\n");
    await expect(
      env.append.append({ taskId: env.taskId, repositories: [env.selection(env.second)] }),
    ).rejects.toThrow(/^path-taken: 路径已被占用/);
    expect(env.recordBytes()).toEqual(before);
    expect(readFileSync(join(occupied, "keep.txt"), "utf8")).toBe("not ours\n");
    expect(git(env.second.repo, "worktree", "list", "--porcelain")).not.toContain(occupied);
    expect(env.payloads.at(-1)?.["takenPaths"]).toContain(occupied);
  });

  it("refuses an unusable source checkout by name before any fetch", async () => {
    const env = await setup();
    const before = env.recordBytes();
    const notACheckout = join(env.home, "plain-dir");
    mkdirSync(notACheckout);
    await env.projects.update(env.project.id, {
      description: "",
      repositories: env.project.repositories.map((row) =>
        row.name === "second" ? { id: row.id, name: row.name, path: notACheckout } : { id: row.id, name: row.name, path: row.path },
      ),
      directories: [],
    });
    await expect(
      env.append.append({ taskId: env.taskId, repositories: [env.selection(env.second)] }),
    ).rejects.toThrow(new RegExp(`^repo-unusable: 仓库 repo-[0-9a-f]{8}（second）的来源检出不可用: ${notACheckout}$`));
    expect(env.recordBytes()).toEqual(before);
    expect(env.payloads).toHaveLength(0);
    expect(existsSync(env.worktreeOf(env.second))).toBe(false);
  });

  it("skips a repository the task already has without a second worktree or a duplicated repoSource", async () => {
    const env = await setup();
    const firstWorktree = env.worktreeOf(env.first);
    const firstWorktrees = git(env.first.repo, "worktree", "list", "--porcelain");
    const already = await env.append.append({ taskId: env.taskId, repositories: [env.selection(env.first)] });
    expect(already.appended).toEqual([]);
    expect(already.skipped).toEqual([{ repoDir: buildRepoChildName(repoIdOf(env.project, env.first)), name: "first" }]);
    // The idempotent path never reaches the Host: no record write at all.
    expect(env.payloads).toHaveLength(0);
    expect(git(env.first.repo, "worktree", "list", "--porcelain")).toBe(firstWorktrees);
    expect(readTaskRecordOnDisk(env.taskDir)!.repoSources?.length).toBe(1);
    // Mixed selection: only the new repository is appended.
    const mixed = await env.append.append({
      taskId: env.taskId,
      repositories: [env.selection(env.first), env.selection(env.second)],
    });
    expect(mixed.appended.map((repo) => repo.repoDir)).toEqual([buildRepoChildName(repoIdOf(env.project, env.second))]);
    expect(mixed.skipped.map((repo) => repo.repoDir)).toEqual([buildRepoChildName(repoIdOf(env.project, env.first))]);
    expect(readTaskRecordOnDisk(env.taskDir)!.repoSources?.map((source) => source.repoDir)).toEqual([
      buildRepoChildName(repoIdOf(env.project, env.first)),
      buildRepoChildName(repoIdOf(env.project, env.second)),
    ]);
    expect(git(firstWorktree, "status", "--porcelain")).toBe("");
  });

  it("refuses a task branch that exists without a worktree with the create flow's manual-recovery reason", async () => {
    const env = await setup();
    const before = env.recordBytes();
    git(env.second.repo, "branch", env.branch);
    await expect(
      env.append.append({ taskId: env.taskId, repositories: [env.selection(env.second)] }),
    ).rejects.toThrow(/^任务分支已存在但工作树不在原位置，请人工恢复（仓库 repo-[0-9a-f]{8}）$/);
    expect(env.recordBytes()).toEqual(before);
    expect(env.payloads).toHaveLength(0);
    expect(existsSync(env.worktreeOf(env.second))).toBe(false);
  });

  it("resolves repositories from the project registry and never from the request, and takes no caller-supplied scan", async () => {
    const env = await setup();
    // The append channel accepts project repository ids + remote/branch only:
    // a page-supplied path, repo folder name or scan is rejected outright.
    await expect(
      performAppendOperation(env.append, { taskId: env.taskId, repositories: [{ sourceId: repoIdOf(env.project, env.second), remote: "origin", remoteBranch: "main", mainCheckoutDir: "/tmp/evil" }] }, () => undefined),
    ).rejects.toThrow(/invalid append input/);
    await expect(
      performAppendOperation(env.append, { taskId: env.taskId, repositories: [env.selection(env.second)], takenPaths: [], branchesInUse: [] }, () => undefined),
    ).rejects.toThrow(/invalid append operation/);
    await expect(
      performAppendOperation(env.append, { taskId: env.taskId, repositories: [{ ...env.selection(env.second), sourceId: "1e2a7c4e-0000-4000-8000-000000000000" }] }, () => undefined),
    ).rejects.toThrow(/不在任务所属项目的仓库登记中/);
    expect(env.payloads).toHaveLength(0);
    // The derived scan is the real one, and the sender is re-attested right
    // before the plan creates resources.
    const attestations: number[] = [];
    await env.append.append({ taskId: env.taskId, repositories: [env.selection(env.second)] }, () => {
      attestations.push(env.payloads.length);
    });
    expect(attestations).toEqual([1]);
    expect(env.payloads.at(-1)?.["takenPaths"]).toContain(env.worktreeOf(env.first));
    expect(env.payloads.at(-1)?.["branchesInUse"]).toEqual(["main"]);
  });

  it("keeps the create-flow refusals and the existing prepare read coherent for an unfinished append", async () => {
    const env = await setup();
    // A record that names the second repo but whose worktree is absent reads
    // as `pending` and is resumable — the append never re-creates it silently
    // (the plan creation itself is asserted above); this pins the shared view
    // the renderer's recovery surface renders.
    await env.append.append({ taskId: env.taskId, repositories: [env.selection(env.second)] });
    const repoDir = buildRepoChildName(repoIdOf(env.project, env.second));
    rmSync(join(env.taskDir, repoDir), { recursive: true, force: true });
    const instance = new TaskWorkspaceHost(env.taskId, env.taskDir, diskTaskStore);
    const status = instance.prepareStatus();
    expect(status.outcomes.find((outcome) => outcome.repoDir === repoDir)?.status).toBe("pending");
    expect(status.retry).toEqual([repoDir]);
    expect(status.created).toEqual([buildRepoChildName(repoIdOf(env.project, env.first))]);
  });

  it("never reports a recorded-but-worktree-absent repo as an idempotent skip, and completes it through the resume plan", async () => {
    const env = await setup();
    const repoDir = buildRepoChildName(repoIdOf(env.project, env.second));
    const worktree = join(env.taskDir, repoDir);
    const appended = await env.append.append({ taskId: env.taskId, repositories: [env.selection(env.second)] });
    const pinned = appended.appended[0]!.commit;
    expect(existsSync(worktree)).toBe(true);
    // The partial state the Host write can leave: the repo is recorded but its
    // worktree is gone (execution failed, or the user removed it). This is a
    // real worktree deletion, so git no longer registers it either.
    git(env.second.repo, "worktree", "remove", worktree);
    expect(existsSync(worktree)).toBe(false);
    expect(readTaskRecordOnDisk(env.taskDir)!.repos).toContain(repoDir);

    // The retry must be TRUTHFUL: a repo that is recorded but whose worktree
    // is absent is refused by name, never reported as `skipped`.
    await expect(
      env.append.append({ taskId: env.taskId, repositories: [env.selection(env.second)] }),
    ).rejects.toThrow(/^worktree-missing: 仓库 repo-[0-9a-f]{8}（second）已记录但工作副本不存在/);

    // The recovery surface main now EXECUTES actually completes it: derive the
    // scan the shell route derives, take the Host's resume plan, execute it.
    const authority = createPrepScanAuthority(env.projects, env.roots);
    const prep = derivePrepInputs({ taskId: env.taskId, repoDirs: [] }, authority, createNodePrepScanDeps());
    const planResult = await env.host.routeTaskOp({
      taskId: env.taskId,
      op: "task/resumeAppend",
      payload: { takenPaths: prep.takenPaths, branchesInUse: prep.branchesInUse, mainCheckouts: prep.mainCheckouts },
    });
    const outcome = await env.append.executeResumePlan({
      taskId: env.taskId,
      planResult,
      mainCheckouts: prep.mainCheckouts,
    });
    expect(outcome["resumed"]).toBe(true);
    expect(outcome["created"]).toContain(repoDir);
    expect(outcome["retry"]).toEqual([]);
    // The worktree really exists at the pinned commit on the task branch.
    expect(existsSync(worktree)).toBe(true);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(pinned);
    expect(git(worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(env.branch);
    expect(readFileSync(join(worktree, "README.md"), "utf8")).toBe("second baseline\n");
  });

  it("refuses a worktree whose directory was deleted but is still registered, instead of reporting a false success", async () => {
    const env = await setup();
    const repoDir = buildRepoChildName(repoIdOf(env.project, env.second));
    const worktree = join(env.taskDir, repoDir);
    await env.append.append({ taskId: env.taskId, repositories: [env.selection(env.second)] });
    // `rmSync` removes only the directory: git still registers the worktree as
    // "missing but already registered" (a `prunable` entry), a state the
    // allowed capability set (fetch/branch/worktree add; no prune/force) cannot
    // silently clear. The retry stays truthful: the append refuses by name and
    // the resume reports a named git failure — never a success.
    rmSync(worktree, { recursive: true, force: true });
    await expect(
      env.append.append({ taskId: env.taskId, repositories: [env.selection(env.second)] }),
    ).rejects.toThrow(/^worktree-missing: 仓库 repo-[0-9a-f]{8}（second）已记录但工作副本不存在/);
    const authority = createPrepScanAuthority(env.projects, env.roots);
    const prep = derivePrepInputs({ taskId: env.taskId, repoDirs: [] }, authority, createNodePrepScanDeps());
    const planResult = await env.host.routeTaskOp({
      taskId: env.taskId,
      op: "task/resumeAppend",
      payload: { takenPaths: prep.takenPaths, branchesInUse: prep.branchesInUse, mainCheckouts: prep.mainCheckouts },
    });
    await expect(
      env.append.executeResumePlan({ taskId: env.taskId, planResult, mainCheckouts: prep.mainCheckouts }),
    ).rejects.toThrow(/^worktree-add-failed: 仓库 repo-[0-9a-f]{8}（second）执行 git worktree 失败，请人工处理后再试$/);
    expect(existsSync(worktree)).toBe(false);
  });

  it("wraps a plan-execution failure in a named refusal naming the repo, never raw git stderr", async () => {
    const env = await setup();
    // A git seam whose plan execution fails with a raw git message that
    // contains a machine path: it must not reach the caller verbatim.
    const failing = {
      ...createNodeAppendGit(),
      exec: (): void => {
        throw new Error("fatal: '/secret/path' is not a working tree");
      },
    };
    const append = new ProjectTaskAppend(
      env.host,
      createPrepScanAuthority(env.projects, env.roots),
      createNodePrepScanDeps(),
      failing,
    );
    let failure: unknown;
    try {
      await append.append({ taskId: env.taskId, repositories: [env.selection(env.second)] });
    } catch (error) {
      failure = error;
    }
    const message = (failure as Error).message;
    // The failing op here is the plan's `fetch` (buffered before the
    // worktree add), so the code names that op — but always the repo.
    expect(message).toMatch(/^append-op-failed: 仓库 repo-[0-9a-f]{8}（second）执行 git fetch 失败，请人工处理后再试$/);
    expect(message).not.toContain("fatal");
    expect(message).not.toContain("/secret/path");
  });

  it("never echoes raw git stderr through the append git seam", async () => {
    const env = await setup();
    // `rev-parse` on a non-existent ref fails with real git stderr; the seam
    // must not carry it (the caller wraps with a named refusal instead).
    expect(() => createNodeAppendGit().exec(env.second.repo, ["rev-parse", "definitely-not-a-ref"])).toThrow(
      "append git operation failed",
    );
  });
});

describe("append plan execution guard", () => {
  const repo = {
    repoDir: "repo-00000001",
    name: "source",
    remote: "origin",
    remoteBranch: "main",
    checkout: "/tmp/source",
    commit: "a".repeat(40),
  };
  const expected = { taskDir: "/tmp/tasks/task-00000001", branch: "task/task00000001", repos: [repo] };
  const plan = {
    mainCheckoutDir: repo.checkout,
    ops: [
      { kind: "fetch", cwd: repo.checkout, args: ["fetch", "origin", "main"] },
      { kind: "branch", cwd: repo.checkout, args: ["branch", expected.branch, "a".repeat(40)] },
      { kind: "worktree", cwd: repo.checkout, args: ["worktree", "add", `${expected.taskDir}/${repo.repoDir}`, expected.branch] },
    ],
  };
  const exec = (): void => undefined;

  it("executes the Host's fetch/branch/worktree ops in the resolved checkout", () => {
    const calls: string[][] = [];
    const created = executeAppendPlan({ plan, expected, exec: (cwd, args) => void calls.push([cwd, ...args]) });
    expect(created).toEqual([{ repoDir: repo.repoDir, worktree: `${expected.taskDir}/${repo.repoDir}` }]);
    expect(calls).toEqual([
      [repo.checkout, "fetch", "origin", "main"],
      [repo.checkout, "branch", expected.branch, "a".repeat(40)],
      [repo.checkout, "worktree", "add", `${expected.taskDir}/${repo.repoDir}`, expected.branch],
    ]);
  });

  it("refuses a plan that forces, resets, targets another checkout or another branch", () => {
    const force = { ...plan, ops: [...plan.ops.slice(0, 2), { kind: "worktree", cwd: repo.checkout, args: ["worktree", "add", "--force", `${expected.taskDir}/${repo.repoDir}`, expected.branch] }] };
    expect(() => executeAppendPlan({ plan: force, expected, exec })).toThrow(/不接受选项参数 --force/);
    const reset = { ...plan, ops: [{ kind: "reset", cwd: repo.checkout, args: ["reset", "--hard"] }] };
    // The forbidden-main-op guard runs first and names the operation.
    expect(() => executeAppendPlan({ plan: reset, expected, exec })).toThrow(/forbidden-main-op: 禁止对主检出目录执行 reset/);
    const bufferedReset = { ...plan, ops: [plan.ops[0]!, { kind: "reset", cwd: "/tmp/other", args: ["reset"] }, ...plan.ops.slice(1)] };
    expect(() => executeAppendPlan({ plan: bufferedReset, expected, exec })).toThrow(/未知操作 reset/);
    const elsewhere = { ...plan, ops: plan.ops.map((op) => ({ ...op, cwd: "/tmp/other" })) };
    expect(() => executeAppendPlan({ plan: elsewhere, expected, exec })).toThrow(/操作位置与来源检出不符/);
    const otherBranch = { ...plan, ops: plan.ops.map((op) => (op.kind === "worktree" ? { ...op, args: [...op.args.slice(0, 3), "task/other"] } : op)) };
    expect(() => executeAppendPlan({ plan: otherBranch, expected, exec })).toThrow(/任务分支与记录不符/);
    // The branch op must create the task branch at THIS repo's pinned commit,
    // not merely any 40-hex string a plan might carry.
    const otherCommit = { ...plan, ops: plan.ops.map((op) => (op.kind === "branch" ? { ...op, args: ["branch", expected.branch, "b".repeat(40)] } : op)) };
    expect(() => executeAppendPlan({ plan: otherCommit, expected, exec })).toThrow(/分支操作与固定提交不符/);
    const fetchOtherRemote = { ...plan, ops: plan.ops.map((op) => (op.kind === "fetch" ? { ...op, args: ["fetch", "upstream", "main"] } : op)) };
    expect(() => executeAppendPlan({ plan: fetchOtherRemote, expected, exec })).toThrow(/获取操作与所选远程分支不符/);
    const dropped = { ...plan, ops: plan.ops.slice(0, 1) };
    expect(() => executeAppendPlan({ plan: dropped, expected, exec })).toThrow(/缺少工作副本创建操作/);
    const missing = { ...plan, ops: plan.ops.slice(0, 2) };
    expect(() => executeAppendPlan({ plan: missing, expected, exec })).toThrow(/缺少工作副本创建操作/);
    const withoutRepo = { ...plan, ops: [] as typeof plan.ops };
    expect(() => executeAppendPlan({ plan: withoutRepo, expected, exec })).toThrow(/没有工作副本创建操作/);
  });

  it("classifies a failed fetch without inventing a cause it cannot see", () => {
    expect(describeFetchFailure("fatal: couldn't find remote ref refs/heads/main")).toBe("远程分支不存在或已删除");
    expect(describeFetchFailure("fatal: Authentication failed for 'https://host/repo'")).toBe("认证失败或没有访问权限");
    expect(describeFetchFailure("fatal: unable to access 'https://host/repo': Could not resolve host")).toBe("网络或远程不可达");
    expect(describeFetchFailure("fatal: something new")).toBe("获取失败");
  });
});
