/**
 * [Pencil T13] #148b — the create-task form's preview against a REAL repository.
 *
 * Every case drives the production creation path (`performCreationOperation` →
 * `ProjectTaskCreation` → real git) on temp bare remotes and real clones. It
 * proves the three things prose cannot:
 *
 * 1. the preview rows come from main's read of the SAVED convention/remote and
 *    of the real checkouts (no page-side branch name),
 * 2. an unset/invalid convention or remote REFUSES creation by name (nothing is
 *    created: no task dir, no branch, no worktree),
 * 3. the branch the creation really makes is the branch the preview showed, and
 *    the task id the preview proposed is the id that was created.
 */

import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskWorkspaceHost } from "../host/task-host.js";
import { readTaskRecordOnDisk } from "../host/task-store.js";
import { ProjectRegistry } from "./project-registry.js";
import { ProjectTaskCreation, CreationIntentStore, type CreationRequest } from "./project-task-creation.js";
import { performCreationOperation } from "./project-task-ipc.js";
import { TaskRootIndex } from "./task-root-index.js";
import { GIT_DELIVERY_SETTINGS_FILE, NO_GIT_DELIVERY } from "./git-delivery.js";

const homes: string[] = [];
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "pidock-148b-"));
  homes.push(home);
  const remote = join(home, "remote.git"), repo = join(home, "repo"), root = join(home, "tasks");
  const profile = join(home, "profile");
  mkdirSync(root); mkdirSync(profile); mkdirSync(repo);
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
  const project = await projects.create({
    name: "Preview", description: "",
    repositories: [{ name: "Web", path: repo }], directories: [],
  });
  const roots = new TaskRootIndex(profile, root), storage = new CreationIntentStore(profile);
  const host = {
    routeTaskOp: async ({ taskId, payload }: { taskId: string; op: "task/provision" | "task/scheduleSave"; payload: Record<string, unknown> }) => {
      const instance = new TaskWorkspaceHost(taskId, join(payload.rootOverride as string, taskId), undefined);
      instance.provision(payload as never);
      return { workspaceId: "test", taskId, op: "task/provision" as const, payload: {} };
    },
  };
  const service = new ProjectTaskCreation(storage, projects, roots, host as never, root);
  const request: CreationRequest = {
    projectId: project.id, name: "Preview Branch",
    repositories: [{ sourceId: project.repositories[0]!.id, remote: "origin", remoteBranch: "main" }],
    directoryIds: [], sharedWriteConfirmed: false, override: false, workspaceMode: "worktree",
  };
  /** Save the convention/remote exactly as the delivery sheet would. */
  const saveSettings = (branchTemplate: unknown, remoteName: unknown) => {
    const saved = service.saveDeliverySettings({ branchTemplate, remote: remoteName });
    return saved;
  };
  return { home, remote, repo, root, profile, project, projects, roots, storage, service, request, saveSettings };
}

/** Add a second independent clone so multi-repo rows are real repositories. */
async function withSecondRepo(env: Awaited<ReturnType<typeof setup>>) {
  const secondRemote = join(env.home, "second-remote.git"), second = join(env.home, "second");
  git(env.home, "clone", "--bare", env.repo, secondRemote);
  git(env.home, "clone", "-b", "main", secondRemote, second);
  git(second, "config", "user.email", "test@localhost");
  git(second, "config", "user.name", "Test");
  writeFileSync(join(second, "README.md"), "second\n");
  git(second, "add", "README.md");
  git(second, "commit", "-m", "second");
  git(second, "push", "origin", "main");
  const project = await env.projects.update(env.project.id, {
    description: "", repositories: [...env.project.repositories, { name: "API", path: second }],
    directories: env.project.directories,
  });
  const request: CreationRequest = {
    ...env.request,
    repositories: [...env.request.repositories, { sourceId: project.repositories[1]!.id, remote: "origin", remoteBranch: "main" }],
  };
  return { ...env, second, secondRemote, project, request };
}

async function prepareAndCommit(env: { service: ProjectTaskCreation }, request: CreationRequest) {
  const prepared = await performCreationOperation(env.service, { op: "prepare", input: request }, async () => null, () => undefined) as {
    canceled: boolean; intent: { id: string; taskId: string; taskDir: string; branch: string; repos: { repoDir: string }[] };
  };
  await performCreationOperation(env.service, { op: "commit", id: prepared.intent.id }, async () => null, () => undefined);
  return prepared.intent;
}

afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("creation preview against a real repository", { timeout: 60_000 }, () => {
  it("previews one row from the saved convention and then creates exactly that branch", async () => {
    const env = await setup();
    env.saveSettings("ticket/{taskId}-{slug}", "origin");
    const plan = await performCreationOperation(env.service, { op: "deliveryPreview", input: env.request }, async () => null, () => undefined) as {
      taskId: string; ready: boolean; gitDelivery: string; remote: string;
      rows: { localBranch: string; pushTarget: string; problem: unknown; repoPath: string }[];
    };
    expect(plan.ready).toBe(true);
    expect(plan.gitDelivery).toBe("branch");
    expect(plan.remote).toBe("origin");
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]?.localBranch).toBe(`ticket/${plan.taskId}-preview-branch`);
    expect(plan.rows[0]?.pushTarget).toBe(`origin ticket/${plan.taskId}-preview-branch`);
    expect(plan.rows[0]?.repoPath).toBe(env.repo);
    // The preview is read-only: nothing exists yet.
    expect(git(env.repo, "branch", "--list", plan.rows[0]!.localBranch)).toBe("");
    expect(existsSync(join(env.root, plan.taskId))).toBe(false);

    const intent = await prepareAndCommit(env, env.request);
    // The proposed id and the previewed branch are the ones really created.
    expect(intent.taskId).toBe(plan.taskId);
    expect(intent.branch).toBe(plan.rows[0]!.localBranch);
    expect(git(env.repo, "branch", "--list", plan.rows[0]!.localBranch, "--format=%(refname:short)")).toBe(plan.rows[0]!.localBranch);
    const worktree = join(intent.taskDir, intent.repos[0]!.repoDir);
    expect(git(worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(plan.rows[0]!.localBranch);
    const record = readTaskRecordOnDisk(intent.taskDir);
    expect(record?.branch).toBe(plan.rows[0]!.localBranch);
    // The push target stayed a preview: creation never pushes.
    expect(git(env.remote, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/main");
  });

  it("previews a ready row per repository for two repositories and creates both branches", async () => {
    const env = await withSecondRepo(await setup());
    env.saveSettings("ticket/{taskId}", "origin");
    const plan = await performCreationOperation(env.service, { op: "deliveryPreview", input: env.request }, async () => null, () => undefined) as {
      taskId: string; ready: boolean; rows: { name: string; localBranch: string; pushTarget: string; problem: unknown }[];
    };
    expect(plan.ready).toBe(true);
    expect(plan.rows.map((row) => [row.name, row.localBranch, row.pushTarget])).toEqual([
      ["Web", `ticket/${plan.taskId}`, `origin ticket/${plan.taskId}`],
      ["API", `ticket/${plan.taskId}`, `origin ticket/${plan.taskId}`],
    ]);
    const intent = await prepareAndCommit(env, env.request);
    for (const [index, worktreeRepo] of intent.repos.entries()) {
      const worktree = join(intent.taskDir, worktreeRepo.repoDir);
      expect(git(worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(plan.rows[index]!.localBranch);
    }
    expect(git(env.repo, "branch", "--list", plan.rows[0]!.localBranch, "--format=%(refname:short)")).toBe(plan.rows[0]!.localBranch);
    expect(git(env.second, "branch", "--list", plan.rows[1]!.localBranch, "--format=%(refname:short)")).toBe(plan.rows[1]!.localBranch);
  });

  it("refuses creation when no convention is saved, naming it, and creates nothing", async () => {
    const env = await setup();
    const plan = await performCreationOperation(env.service, { op: "deliveryPreview", input: env.request }, async () => null, () => undefined) as {
      ready: boolean; problem: { code: string; message: string }; rows: { localBranch: string; problem: { code: string } }[];
    };
    expect(plan.ready).toBe(false);
    expect(plan.problem.code).toBe("branch-template-unset");
    expect(plan.rows[0]?.localBranch).toBe("");
    await expect(env.service.prepare(env.request)).rejects.toThrow(/branch-template-unset/);
    expect(env.storage.read()).toBeNull();
    expect(git(env.repo, "branch", "--list", "ticket/*")).toBe("");
    expect(git(env.repo, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1);
  });

  it("refuses creation when the saved remote is unset or invalid, naming it", async () => {
    const env = await setup();
    // No settings document at all: both halves are empty, and the convention
    // is named first because it is what the branch would be.
    await expect(env.service.prepare(env.request)).rejects.toThrow(/branch-template-unset/);
    writeFileSync(join(env.profile, GIT_DELIVERY_SETTINGS_FILE),
      JSON.stringify({ branchTemplate: "ticket/{taskId}", remote: "", savedAt: null }), { mode: 0o600 });
    await expect(env.service.prepare(env.request)).rejects.toThrow(/remote-unset/);
    // A remote name the checkout does not have is refused per repository.
    writeFileSync(join(env.profile, GIT_DELIVERY_SETTINGS_FILE),
      JSON.stringify({ branchTemplate: "ticket/{taskId}", remote: "upstream", savedAt: null }), { mode: 0o600 });
    const plan = await performCreationOperation(env.service, { op: "deliveryPreview", input: env.request }, async () => null, () => undefined) as {
      ready: boolean; rows: { problem: { code: string; message: string } | null; pushTarget: string }[];
    };
    expect(plan.ready).toBe(false);
    expect(plan.rows[0]?.problem?.code).toBe("remote-invalid");
    expect(plan.rows[0]?.problem?.message).toContain("upstream");
    expect(plan.rows[0]?.pushTarget).toBe("");
    await expect(env.service.prepare(env.request)).rejects.toThrow(/远程/);
    expect(env.storage.read()).toBeNull();
    expect(git(env.repo, "branch", "--list", "ticket/*")).toBe("");
  });

  it("names an invalid saved convention and refuses to create from it", async () => {
    const env = await setup();
    writeFileSync(join(env.profile, GIT_DELIVERY_SETTINGS_FILE),
      JSON.stringify({ branchTemplate: "feature/{slug}", remote: "origin", savedAt: null }), { mode: 0o600 });
    const plan = await performCreationOperation(env.service, { op: "deliveryPreview", input: env.request }, async () => null, () => undefined) as {
      ready: boolean; problem: { code: string; message: string };
    };
    expect(plan.ready).toBe(false);
    expect(plan.problem.code).toBe("branch-template-invalid");
    expect(plan.problem.message).toContain("{taskId}");
    await expect(env.service.prepare(env.request)).rejects.toThrow(/branch-template-invalid/);
    expect(env.storage.read()).toBeNull();
  });

  it("re-reads the saved convention so the preview follows a settings change", async () => {
    const env = await setup();
    env.saveSettings("ticket/{taskId}", "origin");
    const first = await performCreationOperation(env.service, { op: "deliveryPreview", input: env.request }, async () => null, () => undefined) as {
      taskId: string; rows: { localBranch: string }[];
    };
    expect(first.rows[0]?.localBranch).toBe(`ticket/${first.taskId}`);
    env.saveSettings("feature/{taskId}-{slug}", "origin");
    const second = await performCreationOperation(env.service, { op: "deliveryPreview", input: env.request }, async () => null, () => undefined) as {
      taskId: string; rows: { localBranch: string }[];
    };
    expect(second.rows[0]?.localBranch).toBe(`feature/${second.taskId}-preview-branch`);
    // A changed CONVENTION must not silently keep the old previewed branch: the
    // creation follows the new saved setting, and the preview said so first.
    const intent = await prepareAndCommit(env, env.request);
    expect(intent.branch).toBe(second.rows[0]!.localBranch);
  });

  it("shows 无 Git 交付 for a plain-directory task and creates no branch", async () => {
    const env = await setup();
    const dirSource = join(env.home, "shared");
    mkdirSync(dirSource);
    const project = await env.projects.update(env.project.id, {
      description: "", repositories: env.project.repositories,
      directories: [{ name: "shared", path: dirSource }],
    });
    const request: CreationRequest = {
      projectId: project.id, name: "Plain only", repositories: [], directoryIds: [project.directories[0]!.id],
      sharedWriteConfirmed: true, override: false, workspaceMode: "plain-dirs",
    };
    const plan = await performCreationOperation(env.service, { op: "deliveryPreview", input: request }, async () => null, () => undefined) as {
      gitDelivery: string; ready: boolean; rows: unknown[]; message: string; taskId: string;
    };
    expect(plan.gitDelivery).toBe("none");
    expect(plan.ready).toBe(true);
    expect(plan.rows).toEqual([]);
    expect(plan.message).toContain(NO_GIT_DELIVERY);
    const intent = await prepareAndCommit(env, request);
    expect(intent.branch).toBe("");
    const record = readTaskRecordOnDisk(intent.taskDir);
    expect(record?.branch).toBe("");
    expect(record?.branchKind).toBe("none");
    expect(git(env.repo, "branch", "--list", "ticket/*")).toBe("");
  });
});
