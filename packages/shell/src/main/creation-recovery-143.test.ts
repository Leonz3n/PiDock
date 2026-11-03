import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskWorkspaceHost } from "../host/task-host.js";
import { diskTaskStore, readTaskRecordOnDisk } from "../host/task-store.js";
import { ProjectRegistry } from "./project-registry.js";
import { ProjectTaskCreation, CreationIntentStore } from "./project-task-creation.js";
import { performCreationOperation } from "./project-task-ipc.js";
import { TaskRootIndex } from "./task-root-index.js";
import { saveTestDeliverySettings } from "./creation-delivery-settings.fixture.js";

/**
 * [Pencil T08] #143: worktree partial-failure recovery, driven through the real
 * creation service. Every case builds real bare remotes, real clones and real
 * worktrees, then reads back the persisted per-repository state — nothing here
 * fabricates a "created" or "failed" row.
 */
const homes: string[] = [];
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function setupTwoRepositories() {
  const home = mkdtempSync(join(tmpdir(), "pidock-143-"));
  homes.push(home);
  const remote = join(home, "remote.git"), repo = join(home, "repo"), root = join(home, "tasks"), profile = join(home, "profile");
  mkdirSync(root); mkdirSync(repo);
  git(home, "init", "--bare", remote); git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@localhost"); git(repo, "config", "user.name", "Test");
  git(repo, "remote", "add", "origin", remote);
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md"); git(repo, "commit", "-m", "base"); git(repo, "push", "-u", "origin", "main");
  writeFileSync(join(repo, "dirty.txt"), "keep me\n");
  const secondRemote = join(home, "second-remote.git"), second = join(home, "second-repo");
  git(home, "clone", "--bare", repo, secondRemote);
  git(home, "clone", "-b", "main", secondRemote, second);
  git(second, "config", "user.email", "test@localhost"); git(second, "config", "user.name", "Test");
  writeFileSync(join(second, "README.md"), "second baseline\n");
  git(second, "add", "README.md"); git(second, "commit", "-m", "second baseline"); git(second, "push", "origin", "main");
  const projects = new ProjectRegistry(profile);
  const project = await projects.create({ name: "Genuine", description: "",
    repositories: [{ name: "source", path: repo }, { name: "second", path: second }], directories: [] });
  saveTestDeliverySettings(profile);
  const roots = new TaskRootIndex(profile, root), storage = new CreationIntentStore(profile);
  let calls = 0;
  const host = { routeTaskOp: async ({ taskId, payload }: { taskId: string; op: "task/provision"; payload: Record<string, unknown> }) => {
    calls += 1;
    const instance = new TaskWorkspaceHost(taskId, join(payload.rootOverride as string, taskId), diskTaskStore);
    instance.provision(payload as never);
    return { workspaceId: "test", taskId, op: "task/provision" as const, payload: {} };
  } };
  const service = new ProjectTaskCreation(storage, projects, roots, host, root);
  const request = { projectId: project.id, name: "Recovery work", sharedWriteConfirmed: false, override: false,
    directoryIds: [] as string[],
    repositories: project.repositories.map((row) => ({ sourceId: row.id, remote: "origin", remoteBranch: "main" })) };
  /** A fresh instance over the same profile: proves the state survived a restart. */
  const restarted = () => new ProjectTaskCreation(new CreationIntentStore(profile), new ProjectRegistry(profile),
    new TaskRootIndex(profile, root), host, root);
  return { home, repo, second, root, profile, remote, project, projects, roots, storage, service, restarted, request, getCalls: () => calls };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

/** Block `git worktree add` for ONE repository only, without touching its fetch. */
function blockWorktreeAdd(source: string): void {
  writeFileSync(join(source, ".git", "worktrees"), "not a directory\n");
}
function unblockWorktreeAdd(source: string): void {
  rmSync(join(source, ".git", "worktrees"), { force: true });
}

describe("worktree partial-failure recovery (#143)", { timeout: 30_000 }, () => {
  it("names a fetch failure per repository, persists it, and never falls back to a stale baseline", async () => {
    const env = await setupTwoRepositories();
    const intent = await env.service.prepare(env.request);
    // The second repository's remote branch disappears after `prepare` pinned it.
    git(env.home, "--git-dir", join(env.home, "second-remote.git"), "update-ref", "-d", "refs/heads/main");
    await expect(env.service.commit(intent.id)).rejects.toThrow(/获取失败.*WORKTREE_FETCH_FAILED|获取失败（/);

    const status = await env.restarted().status();
    const second = status.repos.find((row) => row.repoDir === intent.repos[1]!.repoDir)!;
    expect(second.phase).toBe("failed");
    expect(second.failure?.code).toBe("WORKTREE_FETCH_FAILED");
    // The reason is classified (deleted branch), not one opaque sentence.
    expect(second.failure?.detail).toContain("远程分支不存在或已删除");
    expect(second.failure?.detail).toContain("未使用旧基线");
    // No worktree and no task branch was created from a stale ref anywhere.
    expect(readdirSync(intent.taskDir).filter((name) => name !== ".pidock-creation")).toEqual([]);
    expect(git(env.repo, "branch", "--list", intent.branch)).toBe("");
    expect(git(env.second, "branch", "--list", intent.branch)).toBe("");

    // Restoring the remote and retrying the SAME intent creates both.
    git(env.second, "push", "origin", "main");
    const retried = await env.service.retry(intent.id);
    expect(retried.retried).toEqual([intent.repos[1]!.repoDir]);
    expect((await env.service.status()).createdRepos).toBe(2);
  });

  it("keeps the successful repository, records each state, and retries only the failed one", async () => {
    const env = await setupTwoRepositories();
    const intent = await env.service.prepare(env.request);
    blockWorktreeAdd(env.second);
    await expect(env.service.commit(intent.id)).rejects.toThrow(/部分仓库创建失败/);
    unblockWorktreeAdd(env.second);

    const status = await env.restarted().status();
    const [first, second] = [status.repos[0]!, status.repos[1]!];
    expect(first.phase).toBe("created");
    expect(second.phase).toBe("failed");
    // The failed `git worktree add` left its branch behind: the DERIVED state is
    // the orphan (with the explicit adopt choice), while the persisted state
    // keeps what really failed. Neither is overwritten by the other.
    expect(second.failure?.code).toBe("WORKTREE_BRANCH_ORPHANED");
    expect(second.orphan).toMatchObject({ adoptable: true, commit: intent.repos[1]!.commit });
    expect(status.canAdoptOrphans).toBe(true);
    expect(status.canRetry).toBe(true);
    expect(status.createdRepos).toBe(1);
    // The persisted state survives a restart: the intent file itself carries it.
    expect(env.storage.read()?.repoStates?.[intent.repos[1]!.repoDir]?.failure?.code).toBe("WORKTREE_ADD_FAILED");

    // Proof the successful copy is NOT re-created: a file only the first
    // creation could have left behind is still there after the retry.
    const firstWorktree = join(intent.taskDir, intent.repos[0]!.repoDir);
    writeFileSync(join(firstWorktree, "user-work.txt"), "not recreated\n");
    const firstHead = git(firstWorktree, "rev-parse", "HEAD");

    // The orphan branch is at the pinned commit and held by nobody, so the
    // explicit adopt request is what completes the retry.
    const retried = await env.service.retry(intent.id, true);
    expect(retried.retried).toEqual([intent.repos[1]!.repoDir]);
    expect(readFileSync(join(firstWorktree, "user-work.txt"), "utf8")).toBe("not recreated\n");
    expect(git(firstWorktree, "rev-parse", "HEAD")).toBe(firstHead);
    expect(git(join(intent.taskDir, intent.repos[1]!.repoDir), "rev-parse", "HEAD")).toBe(intent.repos[1]!.commit);
    expect(readTaskRecordOnDisk(intent.taskDir)?.repoSources).toHaveLength(2);
  });

  it("reports a retry that fails again instead of overwriting the earlier failure with a success", async () => {
    const env = await setupTwoRepositories();
    const intent = await env.service.prepare(env.request);
    blockWorktreeAdd(env.second);
    await expect(env.service.commit(intent.id)).rejects.toThrow(/部分仓库创建失败/);
    const firstFailure = env.storage.read()!.repoStates![intent.repos[1]!.repoDir]!;

    // A retry that fails again refuses by name and does NOT overwrite the
    // failure it recorded the first time.
    await expect(env.service.retry(intent.id)).rejects.toThrow(/任务分支已存在/);
    const afterRetry = (await env.restarted().status()).repos[1]!;
    expect(afterRetry.phase).toBe("failed");
    expect(["WORKTREE_ADD_FAILED", "WORKTREE_BRANCH_ORPHANED"]).toContain(afterRetry.failure?.code);
    // The earlier failure is kept as `previousFailure`, so the retry's new
    // refusal never erases what happened first.
    expect(env.storage.read()?.repoStates?.[intent.repos[1]!.repoDir]?.previousFailure?.code).toBe(firstFailure.failure?.code);
    // The successful repository is still the one that existed before the retry.
    expect((await env.service.status()).repos[0]!.phase).toBe("created");
    expect(firstFailure.phase).toBe("failed");
    expect(readdirSync(intent.taskDir)).toContain(intent.repos[0]!.repoDir);
  });

  it("recovers an interrupted creation from the persisted intent and re-derives real states", async () => {
    const env = await setupTwoRepositories();
    const storage = new CreationIntentStore(env.profile);
    let crashed = false;
    const crashing = new ProjectTaskCreation(storage, env.projects, env.roots, {
      routeTaskOp: async ({ taskId, payload }) => {
        const instance = new TaskWorkspaceHost(taskId, join(payload.rootOverride as string, taskId), diskTaskStore);
        instance.provision(payload as never);
        return { workspaceId: "test", taskId, op: "task/provision" as const, payload: {} };
      },
    }, env.root, (boundary) => { if (boundary === "task-marked" && !crashed) { crashed = true; throw new Error("interrupted"); } });
    const intent = await crashing.prepare(env.request);
    await expect(crashing.commit(intent.id)).rejects.toThrow("interrupted");

    // After the restart the creation is still pending with real, uncreated repos.
    const status = await env.restarted().status();
    expect(status.intent?.taskId).toBe(intent.taskId);
    expect(status.repos.map((row) => row.phase)).toEqual(["pending", "pending"]);
    expect(status.canRetry).toBe(true);
    expect(await env.restarted().retry(intent.id)).toMatchObject({ taskId: intent.taskId });
    expect(existsSync(join(intent.taskDir, intent.repos[0]!.repoDir))).toBe(true);
  });

  it("adopts an orphan task branch only on an explicit request and refuses it by default", async () => {
    const env = await setupTwoRepositories();
    const intent = await env.service.prepare(env.request);
    // The branch exists at the pinned commit but no worktree holds it: the old
    // permanent refusal (`TASK_BRANCH_EXISTS_NO_WORKTREE`) is now an explicit
    // adopt/clean choice, never an automatic takeover.
    git(env.repo, "branch", intent.branch, intent.repos[0]!.commit);
    await expect(env.service.commit(intent.id)).rejects.toThrow(/任务分支已存在/);
    const status = await env.restarted().status();
    expect(status.canAdoptOrphans).toBe(true);
    expect(status.repos[0]!.failure?.code).toBe("WORKTREE_BRANCH_ORPHANED");
    expect(status.repos[0]!.orphan).toMatchObject({ adoptable: true, commit: intent.repos[0]!.commit });
    expect(existsSync(join(intent.taskDir, intent.repos[0]!.repoDir))).toBe(false);

    await env.service.retry(intent.id, true);
    const worktree = join(intent.taskDir, intent.repos[0]!.repoDir);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(intent.repos[0]!.commit);
    expect(git(worktree, "symbolic-ref", "--short", "HEAD")).toBe(intent.branch);
  });

  it("refuses to adopt a task branch held by another worktree", async () => {
    const env = await setupTwoRepositories();
    const intent = await env.service.prepare(env.request);
    const elsewhere = join(env.home, "hand-made");
    git(env.repo, "worktree", "add", "-b", intent.branch, elsewhere, intent.repos[0]!.commit);
    await expect(env.service.retry(intent.id, true)).rejects.toThrow(/占用/);
    const status = await env.restarted().status();
    expect(status.repos[0]!.failure?.code).toBe("WORKTREE_BRANCH_HELD_ELSEWHERE");
    expect(status.canAdoptOrphans).toBe(false);
    // The other worktree is untouched and the task never created a copy of it.
    expect(existsSync(elsewhere)).toBe(true);
    expect(existsSync(join(intent.taskDir, intent.repos[0]!.repoDir))).toBe(false);
  });

  it("abandons with keep and lists what is really there instead of claiming nothing", async () => {
    const env = await setupTwoRepositories();
    const intent = await env.service.prepare(env.request);
    blockWorktreeAdd(env.second);
    await expect(env.service.commit(intent.id)).rejects.toThrow(/部分仓库创建失败/);
    const result = await env.service.abandon(intent.id, true);
    expect(result.cleanup).toBeUndefined();
    expect(result.message).toBe("本次创建已放弃。已产生的任务目录、工作区、链接与会话均已保留；如任务记录已存在，该任务现为未归属任务。");
    // "Nothing was touched" is verifiable from the real state, not from a claim:
    // the created worktree is still there and still reported as created.
    expect(existsSync(join(intent.taskDir, intent.repos[0]!.repoDir))).toBe(true);
    const after = await env.restarted().status();
    expect(after.repos[0]!.phase).toBe("created");
    expect(after.repos[1]!.phase).toBe("failed");
  });

  it("abandons owned-only: removes the managed worktree and branch, never the user's source", async () => {
    const env = await setupTwoRepositories();
    const intent = await env.service.prepare(env.request);
    blockWorktreeAdd(env.second);
    await expect(env.service.commit(intent.id)).rejects.toThrow(/部分仓库创建失败/);
    unblockWorktreeAdd(env.second);
    const worktree = join(intent.taskDir, intent.repos[0]!.repoDir);
    expect(existsSync(worktree)).toBe(true);

    const result = await env.restarted().abandon(intent.id, true, "owned");
    expect(result.cleanup.filter((row) => row.action === "removed").map((row) => row.resource))
      .toEqual(expect.arrayContaining([`工作树 ${intent.repos[0]!.repoDir}`, `任务分支 ${intent.branch}`, "任务目录"]));
    expect(existsSync(worktree)).toBe(false);
    expect(git(env.repo, "branch", "--list", intent.branch)).toBe("");
    expect(existsSync(intent.taskDir)).toBe(false);
    // The user's own checkout and its uncommitted work are byte-for-byte intact.
    expect(readFileSync(join(env.repo, "dirty.txt"), "utf8")).toBe("keep me\n");
    expect(readFileSync(join(env.repo, "README.md"), "utf8")).toBe("base\n");
    expect(git(env.repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    // A per-resource receipt explains what was removed, kept or failed.
    const receipt = JSON.parse(readFileSync(join(env.profile, `task-creation-cleanup-${intent.id}.json`), "utf8"));
    expect(receipt.partialFailure).toBe(false);
    expect(receipt.removed).toContain(`工作树 ${intent.repos[0]!.repoDir}`);
  });

  it("reports a partial cleanup per resource and leaves an explainable state", async () => {
    const env = await setupTwoRepositories();
    const intent = await env.service.prepare(env.request);
    blockWorktreeAdd(env.second);
    await expect(env.service.commit(intent.id)).rejects.toThrow(/部分仓库创建失败/);
    unblockWorktreeAdd(env.second);
    // Uncommitted work inside the managed worktree blocks `git worktree remove`.
    const worktree = join(intent.taskDir, intent.repos[0]!.repoDir);
    writeFileSync(join(worktree, "README.md"), "uncommitted inside the worktree\n");

    const result = await env.restarted().abandon(intent.id, true, "owned");
    const worktreeRow = result.cleanup.find((row) => row.resource === `工作树 ${intent.repos[0]!.repoDir}`)!;
    expect(worktreeRow.action).toBe("failed");
    expect(worktreeRow.reason).toContain("重试清理");
    expect(existsSync(worktree)).toBe(true);
    expect(result.message).toContain("清理部分失败");
    const receipt = JSON.parse(readFileSync(join(env.profile, `task-creation-cleanup-${intent.id}.json`), "utf8"));
    expect(receipt.partialFailure).toBe(true);
    expect(receipt.failed[0].resource).toBe(`工作树 ${intent.repos[0]!.repoDir}`);
    // Nothing of the user's checkout was touched by the partial cleanup.
    expect(readFileSync(join(env.repo, "README.md"), "utf8")).toBe("base\n");
  });

  it("never cleans a task folder whose creation marker is not this intent", async () => {
    const env = await setupTwoRepositories();
    const intent = await env.service.prepare(env.request);
    blockWorktreeAdd(env.second);
    await expect(env.service.commit(intent.id)).rejects.toThrow(/部分仓库创建失败/);
    unblockWorktreeAdd(env.second);
    writeFileSync(join(intent.taskDir, ".pidock-creation"), "someone-else");
    const result = await env.restarted().abandon(intent.id, true, "owned");
    expect(result.cleanup).toEqual([{ resource: "任务目录", path: intent.taskDir, action: "kept", reason: "任务创建标记不匹配，拒绝清理任何资源" }]);
    expect(existsSync(join(intent.taskDir, intent.repos[0]!.repoDir))).toBe(true);
  });

  it("keeps the exact-key IPC surface of the new recovery operations", async () => {
    const env = await setupTwoRepositories();
    const intent = await env.service.prepare(env.request);
    const status = await performCreationOperation(env.service, { op: "status" }, async () => null, () => undefined) as {
      repos: { phase: string; repoDir: string }[]; canRetry: boolean };
    expect(status.repos.map((row) => row.repoDir)).toEqual(intent.repos.map((row) => row.repoDir));
    expect(status.canRetry).toBe(true);
    // Extra keys, unknown ops and an invalid cleanup scope are refused before main.
    await expect(performCreationOperation(env.service, { op: "status", input: {} }, async () => null, () => undefined))
      .rejects.toThrow(/invalid creation operation/);
    await expect(performCreationOperation(env.service, { op: "retry" }, async () => null, () => undefined))
      .rejects.toThrow(/invalid creation operation/);
    await expect(performCreationOperation(env.service, { op: "abandon", id: intent.id, confirmed: true, cleanup: "everything" },
      async () => null, () => undefined)).rejects.toThrow(/invalid abandon cleanup scope/);
    const retried = await performCreationOperation(env.service, { op: "retry", id: intent.id }, async () => null, () => undefined) as {
      taskId: string; retried: string[] };
    expect(retried.taskId).toBe(intent.taskId);
  });
});
