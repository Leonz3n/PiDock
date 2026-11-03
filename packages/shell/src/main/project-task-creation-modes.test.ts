/**
 * [Pencil T02] #137: an explicit task workspace mode carried end-to-end —
 * renderer request → exact-key IPC → creation intent (`task-creations.json`,
 * with migration for pending intents written before the mode existed) →
 * commit → `task.json` → Host `task/fileRoots` facts.
 *
 * The cases below drive the real fixture (temp bare remotes, real clones and
 * fetches) because the mode rules are about real Git: existing-git must never
 * run `git worktree add` or create a task branch in the original, and
 * plain-dirs must refuse a Git repo selection in main, not only in the UI.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskWorkspaceHost } from "../host/task-host.js";
import { readTaskRecordOnDisk } from "../host/task-store.js";
import { diskTaskStore } from "../host/task-host.js";
import { TaskWorkspaceFiles } from "../host/workspace-files.js";
import { ProjectRegistry } from "./project-registry.js";
import { CreationIntentStore, ProjectTaskCreation } from "./project-task-creation.js";
import { performCreationOperation } from "./project-task-ipc.js";
import { TaskRootIndex } from "./task-root-index.js";

const homes: string[] = [];
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
async function setup() {
  const home = mkdtempSync(join(tmpdir(), "pidock-137-"));
  homes.push(home);
  const remote = join(home, "remote.git"), repo = join(home, "repo"), root = join(home, "tasks"), profile = join(home, "profile");
  mkdirSync(root); mkdirSync(repo);
  git(home, "init", "--bare", remote); git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@localhost"); git(repo, "config", "user.name", "Test");
  git(repo, "remote", "add", "origin", remote);
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md"); git(repo, "commit", "-m", "base"); git(repo, "push", "-u", "origin", "main");
  // Uncommitted work in the registered checkout: existing-git must never
  // overwrite it, reset it or stash it.
  writeFileSync(join(repo, "dirty.txt"), "keep me\n");
  const projects = new ProjectRegistry(profile);
  const project = await projects.create({ name: "Real", description: "", repositories: [{ name: "source", path: repo }], directories: [] });
  const roots = new TaskRootIndex(profile, root), storage = new CreationIntentStore(profile);
  const host = {
    routeTaskOp: async ({ taskId, payload }: { taskId: string; op: "task/provision"; payload: Record<string, unknown> }) => {
      const instance = new TaskWorkspaceHost(taskId, join(payload.rootOverride as string, taskId), diskTaskStore);
      instance.provision(payload as never);
      return { workspaceId: "test", taskId, op: "task/provision" as const, payload: {} };
    },
  };
  const service = new ProjectTaskCreation(storage, projects, roots, host, root);
  const repository = project.repositories[0]!;
  const worktreeRequest = {
    projectId: project.id, name: "Worktree work",
    repositories: [{ sourceId: repository.id, remote: "origin", remoteBranch: "main" }],
    directoryIds: [] as string[], sharedWriteConfirmed: false, override: false, workspaceMode: "worktree" as const,
  };
  const existingGitRequest = {
    projectId: project.id, name: "Existing checkout work",
    repositories: [{ sourceId: repository.id, remote: "origin", remoteBranch: "" }],
    directoryIds: [] as string[], sharedWriteConfirmed: false, override: false, workspaceMode: "existing-git" as const,
  };
  const files = (taskDir: string) => new TaskWorkspaceFiles(taskDir.slice(taskDir.lastIndexOf("task-")), taskDir, diskTaskStore);
  return { home, repo, root, profile, project, repository, projects, roots, storage, service, worktreeRequest, existingGitRequest, files };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("task workspace modes through the real creation path", { timeout: 30_000 }, () => {
  it("carries an explicit worktree mode through IPC, intent, task.json and fileRoots", async () => {
    const env = await setup();
    const prepared = await performCreationOperation(env.service,
      { op: "prepare", input: env.worktreeRequest }, async () => null, () => undefined) as { intent: { id: string; taskId: string; taskDir: string; workspaceMode: string } };
    expect(prepared.intent.workspaceMode).toBe("worktree");
    expect(env.storage.read()?.workspaceMode).toBe("worktree");
    await performCreationOperation(env.service, { op: "commit", id: prepared.intent.id }, async () => null, () => undefined);
    const record = readTaskRecordOnDisk(prepared.intent.taskDir);
    expect(record?.workspaceMode).toBe("worktree");
    expect(record?.repos).toHaveLength(1);
    expect(record?.sharedRepos).toBeUndefined();
    const facts = env.files(prepared.intent.taskDir);
    expect(facts.workspaceMode()).toBe("worktree");
    expect(facts.facts().map((root) => root.kind)).toEqual(["worktree"]);
  });

  it("rejects an unknown mode and any extra IPC key before creation", async () => {
    const env = await setup();
    await expect(performCreationOperation(env.service,
      { op: "prepare", input: { ...env.worktreeRequest, workspaceMode: "bogus" } }, async () => null, () => undefined))
      .rejects.toThrow("invalid workspace mode");
    await expect(performCreationOperation(env.service,
      { op: "prepare", input: { ...env.worktreeRequest, rendererOnlyMode: "existing-git" } }, async () => null, () => undefined))
      .rejects.toThrow("invalid creation operation");
    expect(env.storage.read()).toBeNull();
  });

  it("existing-git uses the registered checkout in place: no worktree, no task branch, dirty original untouched", async () => {
    const env = await setup();
    const head = git(env.repo, "rev-parse", "HEAD");
    const prepared = await performCreationOperation(env.service, { op: "prepare", input: env.existingGitRequest }, async () => null, () => undefined) as {
      intent: { id: string; taskId: string; taskDir: string; workspaceMode: string; repos: { commit: string; remoteBranch: string; repoDir: string }[] };
    };
    expect(prepared.intent.workspaceMode).toBe("existing-git");
    expect(prepared.intent.repos[0]).toMatchObject({ commit: head, remoteBranch: "main" });

    // The preview is read-only: nothing was fetched, no worktree or branch exists.
    expect(git(env.repo, "worktree", "list", "--porcelain")).toMatch(/^worktree /);
    expect(git(env.repo, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1);
    expect(git(env.repo, "branch", "--list", "task/*")).toBe("");
    expect(existsSync(join(env.repo, ".worktrees"))).toBe(false);

    await performCreationOperation(env.service, { op: "commit", id: prepared.intent.id }, async () => null, () => undefined);
    const record = readTaskRecordOnDisk(prepared.intent.taskDir);
    expect(record?.workspaceMode).toBe("existing-git");
    expect(record?.repos).toEqual([]);
    expect(record?.sharedRepos).toHaveLength(1);
    expect(record?.sharedRepos?.[0]).toMatchObject({
      sourcePath: realpathSync(env.repo), remote: "origin", remoteBranch: "main", headCommit: head,
    });
    expect(record?.sharedRepos?.[0]?.sourceDevice).toBeTruthy();
    expect(record?.sharedRepos?.[0]?.sourceInode).toBeTruthy();
    expect(record?.sharedRepos?.[0]?.commonDir).toBe(realpathSync(join(env.repo, ".git")));
    // The original checkout was not committed to, branched, fetched, reset or
    // stashed; the uncommitted file is exactly where the user left it.
    expect(readFileSync(join(env.repo, "dirty.txt"), "utf8")).toBe("keep me\n");
    expect(git(env.repo, "status", "--porcelain")).toContain("dirty.txt");
    expect(git(env.repo, "rev-parse", "HEAD")).toBe(head);
    expect(git(env.repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(env.repo, "branch", "--list", "task/*")).toBe("");
    expect(existsSync(join(env.repo, ".git", "FETCH_HEAD"))).toBe(false);
    // The task folder holds the record and links, not a copy of the checkout.
    expect(existsSync(join(prepared.intent.taskDir, prepared.intent.repos[0]!.repoDir))).toBe(false);
    expect(existsSync(join(prepared.intent.taskDir, "task.json"))).toBe(true);

    const facts = env.files(prepared.intent.taskDir);
    expect(facts.workspaceMode()).toBe("existing-git");
    const roots = facts.facts();
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({
      kind: "existing-git", path: realpathSync(env.repo), sharedOriginal: true, baselineBranch: "main",
      workingBranch: { state: "observed", value: "main" },
      headCommit: { state: "observed", value: head },
      dirty: { state: "observed", value: true },
      verification: { state: "ready" },
    });
    // A shared original has no task-branch Git delivery or baseline diff.
    expect(facts.delivery({ rootId: roots[0]!.id }).ok).toBe(false);
    expect(facts.diff({ rootId: roots[0]!.id }).ok).toBe(false);
  });

  it("existing-git re-reads the observed HEAD at commit but refuses a changed branch", async () => {
    const env = await setup();
    const prepared = await env.service.prepare(env.existingGitRequest);
    // A commit made between prepare and commit is observed work, not an overwrite.
    writeFileSync(join(env.repo, "later.txt"), "later\n");
    git(env.repo, "add", "later.txt");
    git(env.repo, "commit", "-m", "later");
    const movedHead = git(env.repo, "rev-parse", "HEAD");
    expect(movedHead).not.toBe(prepared.repos[0]!.commit);
    await env.service.commit(prepared.id);
    expect(readTaskRecordOnDisk(prepared.taskDir)?.sharedRepos?.[0]?.headCommit).toBe(movedHead);
    expect(git(env.repo, "status", "--porcelain")).toContain("dirty.txt");

    // A different branch at commit time refuses by name and creates nothing.
    const second = await setup();
    const pending = await second.service.prepare(second.existingGitRequest);
    git(second.repo, "checkout", "-b", "other");
    await expect(second.service.commit(pending.id)).rejects.toThrow("当前分支在准备后已改变");
    expect(existsSync(join(pending.taskDir, "task.json"))).toBe(false);
    expect(git(second.repo, "branch", "--list", "task/*")).toBe("");
  });

  it("completes a mixed existing-git + plain-directory task without copying either source", async () => {
    const env = await setup();
    const shared = join(env.home, "shared-configs");
    mkdirSync(shared);
    const project = await env.projects.update(env.project.id, {
      description: "", repositories: env.project.repositories, directories: [{ name: "configs", path: shared }],
    });
    const prepared = await env.service.prepare({
      projectId: project.id, name: "Mixed work",
      repositories: [{ sourceId: project.repositories[0]!.id, remote: "origin", remoteBranch: "" }],
      directoryIds: [project.directories[0]!.id], sharedWriteConfirmed: true, override: false, workspaceMode: "existing-git",
    });
    await env.service.commit(prepared.id);
    const record = readTaskRecordOnDisk(prepared.taskDir);
    expect(record?.workspaceMode).toBe("existing-git");
    expect(record?.sharedRepos).toHaveLength(1);
    expect(record?.dirLinks).toHaveLength(1);
    expect(record?.dirLinks?.[0]?.sourcePath).toBe(shared);
    const facts = env.files(prepared.taskDir).facts();
    expect(facts.map((root) => root.kind)).toEqual(["existing-git", "shared-dir"]);
    expect(facts[1]).toMatchObject({ path: join(prepared.taskDir, record!.dirLinks![0]!.linkName), sourcePath: shared });
    // The registered checkout still has its uncommitted work; no task branch.
    expect(readFileSync(join(env.repo, "dirty.txt"), "utf8")).toBe("keep me\n");
    expect(git(env.repo, "branch", "--list", "task/*")).toBe("");
  });

  it("plain-dirs refuses a Git repo selection in main and accepts directories only", async () => {
    const env = await setup();
    await expect(env.service.prepare({ ...env.worktreeRequest, workspaceMode: "plain-dirs" }))
      .rejects.toThrow("仅普通目录模式不接受 Git 仓库来源");
    expect(env.storage.read()).toBeNull();

    // A project with one plain directory: the same mode records only that link.
    const shared = join(env.home, "shared");
    mkdirSync(shared);
    const project = await env.projects.update(env.project.id, {
      description: "", repositories: env.project.repositories, directories: [{ name: "docs", path: shared }],
    });
    const prepared = await env.service.prepare({
      projectId: project.id, name: "Docs only", repositories: [], directoryIds: [project.directories[0]!.id],
      sharedWriteConfirmed: true, override: false, workspaceMode: "plain-dirs",
    });
    await env.service.commit(prepared.id);
    const record = readTaskRecordOnDisk(prepared.taskDir);
    expect(record?.workspaceMode).toBe("plain-dirs");
    expect(record?.repos).toEqual([]);
    expect(env.files(prepared.taskDir).facts().map((root) => root.kind)).toEqual(["shared-dir"]);
  });

  it("refuses Git modes without a repository and a legacy pure-directory intent stays recoverable", async () => {
    const env = await setup();
    await expect(env.service.prepare({ ...env.worktreeRequest, repositories: [] }))
      .rejects.toThrow("独立 Worktree 模式至少需要一个已登记的 Git 仓库来源");
    await expect(env.service.prepare({ ...env.existingGitRequest, repositories: [] }))
      .rejects.toThrow("已有 Git 目录模式至少需要一个已登记的 Git 仓库来源");

    // A pending intent written by the previous build has no `workspaceMode`:
    // it must still be readable and committable (migrated to worktree).
    const prepared = await env.service.prepare(env.worktreeRequest);
    const file = join(env.profile, "task-creations.json");
    const doc = JSON.parse(readFileSync(file, "utf8"));
    delete doc.intent.workspaceMode;
    writeFileSync(file, JSON.stringify(doc));
    const migrated = env.service.current();
    expect(migrated?.workspaceMode).toBe("worktree");
    await env.service.commit(prepared.id);
    expect(readTaskRecordOnDisk(prepared.taskDir)?.workspaceMode).toBe("worktree");
  });

  it("migrates a legacy pure-directory pending intent to plain-dirs", async () => {
    const env = await setup();
    const shared = join(env.home, "docs");
    mkdirSync(shared);
    const project = await env.projects.update(env.project.id, {
      description: "", repositories: env.project.repositories, directories: [{ name: "docs", path: shared }],
    });
    const prepared = await env.service.prepare({
      projectId: project.id, name: "Docs only", repositories: [], directoryIds: [project.directories[0]!.id],
      sharedWriteConfirmed: true, override: false, workspaceMode: "plain-dirs",
    });
    const file = join(env.profile, "task-creations.json");
    const doc = JSON.parse(readFileSync(file, "utf8"));
    delete doc.intent.workspaceMode;
    writeFileSync(file, JSON.stringify(doc));
    expect(env.service.current()?.workspaceMode).toBe("plain-dirs");
    await env.service.commit(prepared.id);
    expect(readTaskRecordOnDisk(prepared.taskDir)?.workspaceMode).toBe("plain-dirs");
  });
});
