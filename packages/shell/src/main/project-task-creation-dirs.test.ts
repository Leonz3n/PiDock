import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskWorkspaceHost } from "../host/task-host.js";
import { diskTaskStore, readTaskRecordOnDisk } from "../host/task-store.js";
import { ProjectRegistry } from "./project-registry.js";
import { CreationIntentStore, ProjectTaskCreation } from "./project-task-creation.js";
import { TaskRootIndex } from "./task-root-index.js";
import { buildLinkName } from "./multi-repo-provision.js";

const homes: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function setupPureDirectoryEnv() {
  const home = mkdtempSync(join(tmpdir(), "pidock-pure-dirs-"));
  homes.push(home);
  const root = join(home, "tasks");
  const profile = join(home, "profile");
  const docsDir = join(home, "my-documents");
  const assetsDir = join(home, "my-assets");
  mkdirSync(root);
  mkdirSync(docsDir);
  mkdirSync(assetsDir);
  writeFileSync(join(docsDir, "spec.txt"), "original spec content\n");
  writeFileSync(join(assetsDir, "logo.png"), "original logo content\n");

  const projects = new ProjectRegistry(profile);
  const project = await projects.create({
    name: "Pure Dir Project",
    description: "Zero git repos",
    repositories: [],
    directories: [
      { name: "documents", path: docsDir },
      { name: "assets", path: assetsDir },
    ],
  });

  const roots = new TaskRootIndex(profile, root);
  const storage = new CreationIntentStore(profile);
  let provisionCalls = 0;
  const host = {
    routeTaskOp: async ({ taskId, payload }: { taskId: string; op: "task/provision"; payload: Record<string, unknown> }) => {
      provisionCalls += 1;
      const instance = new TaskWorkspaceHost(taskId, join(payload.rootOverride as string, taskId), diskTaskStore);
      instance.provision(payload as never);
      return { workspaceId: "test", taskId, op: "task/provision" as const, payload: {} };
    },
  };
  const service = new ProjectTaskCreation(storage, projects, roots, host, root);
  const request = {
    projectId: project.id,
    name: "Pure Dir Task",
    repositories: [],
    directoryIds: [project.directories[0]!.id, project.directories[1]!.id],
    sharedWriteConfirmed: true,
    override: false,
  };

  return { home, root, profile, docsDir, assetsDir, project, projects, roots, storage, service, host, request, getCalls: () => provisionCalls };
}

async function setupMixedEnv() {
  const env = await setupPureDirectoryEnv();
  const remote = join(env.home, "mixed-remote.git");
  const repo = join(env.home, "mixed-repo");
  mkdirSync(repo);
  git(env.home, "init", "--bare", remote);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@localhost");
  git(repo, "config", "user.name", "Test");
  git(repo, "remote", "add", "origin", remote);
  writeFileSync(join(repo, "README.md"), "mixed base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "mixed base");
  git(repo, "push", "-u", "origin", "main");
  writeFileSync(join(repo, "dirty.txt"), "mixed dirty\n");

  const project = await env.projects.update(env.project.id, {
    description: "Mixed repo and dir",
    repositories: [{ name: "mixed-source", path: repo }],
    directories: env.project.directories,
  });

  const request = {
    projectId: project.id,
    name: "Mixed Task",
    repositories: [{ sourceId: project.repositories[0]!.id, remote: "origin", remoteBranch: "main" }],
    directoryIds: [project.directories[0]!.id],
    sharedWriteConfirmed: true,
    override: false,
  };

  return { ...env, remote, repo, project, request };
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("Pure-directory and mixed Project task creation", () => {
  it("creates a pure-directory task end-to-end with zero Git repositories and no environment", async () => {
    const env = await setupPureDirectoryEnv();
    const preview = await env.service.prepare(env.request);

    // Intent assertions
    expect(preview.taskDir).toBe(join(env.root, preview.taskId));
    expect(preview.repos).toHaveLength(0);
    expect(preview.directories).toHaveLength(2);
    expect(existsSync(preview.taskDir)).toBe(false);

    // Commit creation
    const committed = await env.service.commit(preview.id);
    expect(committed).toEqual({ taskId: preview.taskId, projectId: env.project.id });
    expect(env.getCalls()).toBe(1);

    // Task folder exists and has independent identity
    expect(existsSync(preview.taskDir)).toBe(true);
    expect(lstatSync(preview.taskDir).isDirectory()).toBe(true);

    // No Git repo anywhere: neither taskDir nor docsDir has a .git
    expect(existsSync(join(preview.taskDir, ".git"))).toBe(false);
    expect(existsSync(join(env.docsDir, ".git"))).toBe(false);
    expect(existsSync(join(env.assetsDir, ".git"))).toBe(false);

    // Symlinks exist at stable ASCII names
    const docsLinkName = buildLinkName(env.project.directories[0]!.id);
    const assetsLinkName = buildLinkName(env.project.directories[1]!.id);
    const docsLinkPath = join(preview.taskDir, docsLinkName);
    const assetsLinkPath = join(preview.taskDir, assetsLinkName);

    expect(lstatSync(docsLinkPath).isSymbolicLink()).toBe(true);
    expect(lstatSync(assetsLinkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(docsLinkPath)).toBe(env.docsDir);
    expect(readlinkSync(assetsLinkPath)).toBe(env.assetsDir);

    // Stored disk record
    const record = readTaskRecordOnDisk(preview.taskDir);
    expect(record).not.toBeNull();
    expect(record?.taskId).toBe(preview.taskId);
    expect(record?.repos).toHaveLength(0);
    expect(record?.repoSources).toHaveLength(0);
    expect(record?.remoteBranch).toBe("");
    expect(record?.baseCommit).toBe("");
    expect(record?.dirLinks).toHaveLength(2);
    expect(record?.dirLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ directoryId: env.project.directories[0]!.id, linkName: docsLinkName, sourcePath: env.docsDir }),
        expect.objectContaining({ directoryId: env.project.directories[1]!.id, linkName: assetsLinkName, sourcePath: env.assetsDir }),
      ]),
    );

    // Write through the link modifies the ORIGINAL file directly (not a copy!)
    const linkFilePath = join(docsLinkPath, "spec.txt");
    const originalFilePath = join(env.docsDir, "spec.txt");
    expect(readFileSync(linkFilePath, "utf8")).toBe("original spec content\n");

    writeFileSync(linkFilePath, "updated through pure-directory link!\n");
    // Assert original file content changed
    expect(readFileSync(originalFilePath, "utf8")).toBe("updated through pure-directory link!\n");
    // Assert nothing was copied: link is still a symlink
    expect(lstatSync(docsLinkPath).isSymbolicLink()).toBe(true);

    // Project association and task root index
    expect(env.projects.association(preview.taskId, env.roots).state).toBe("assigned");
    expect(env.roots.inventory().tasks.map((t) => t.taskId)).toContain(preview.taskId);
  });

  it("creates a mixed task (repo + directory) end-to-end, asserting the Git half is unchanged", async () => {
    const env = await setupMixedEnv();
    const preview = await env.service.prepare(env.request);

    expect(preview.repos).toHaveLength(1);
    expect(preview.directories).toHaveLength(1);
    const expectedCommit = git(env.repo, "rev-parse", "HEAD");
    expect(preview.repos[0]?.commit).toBe(expectedCommit);

    const committed = await env.service.commit(preview.id);
    expect(committed).toEqual({ taskId: preview.taskId, projectId: env.project.id });

    // Git half assertions
    const worktreeDir = join(preview.taskDir, preview.repos[0]!.repoDir);
    expect(existsSync(worktreeDir)).toBe(true);
    expect(git(worktreeDir, "rev-parse", "HEAD")).toBe(expectedCommit);
    expect(readFileSync(join(env.repo, "dirty.txt"), "utf8")).toBe("mixed dirty\n");

    // Directory half assertions
    const dirLinkName = buildLinkName(env.project.directories[0]!.id);
    const dirLinkPath = join(preview.taskDir, dirLinkName);
    expect(lstatSync(dirLinkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(dirLinkPath)).toBe(env.docsDir);

    const record = readTaskRecordOnDisk(preview.taskDir);
    expect(record?.repoSources?.[0]?.baseCommit).toBe(expectedCommit);
    expect(record?.dirLinks?.[0]?.directoryId).toBe(env.project.directories[0]!.id);
  });

  it("refuses creation when shared-write confirmation is missing, creating nothing", async () => {
    const env = await setupPureDirectoryEnv();
    await expect(
      env.service.prepare({
        ...env.request,
        sharedWriteConfirmed: false,
      }),
    ).rejects.toThrow("请确认普通目录的共享写入风险");

    // Nothing created
    expect(env.storage.read()).toBeNull();
    expect(env.roots.inventory().tasks).toHaveLength(0);
  });

  it("refuses creation when link names collide, creating nothing", async () => {
    const env = await setupPureDirectoryEnv();
    // Register two directories with IDs that map to the same link name
    // buildLinkName uses `dir-` + id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toLowerCase()
    const dirA = join(env.home, "dir-a");
    const dirB = join(env.home, "dir-b");
    mkdirSync(dirA);
    mkdirSync(dirB);
    const collidingId1 = "11111111-0000-4000-8000-000000000001";
    const collidingId2 = "11111111-0000-4000-8000-000000000002";
    // Both start with 11111111, so both map to dir-11111111
    expect(buildLinkName(collidingId1)).toBe("dir-11111111");
    expect(buildLinkName(collidingId2)).toBe("dir-11111111");

    const project = await env.projects.create({
      name: "Colliding Project",
      description: "",
      repositories: [],
      directories: [
        { name: "a", path: dirA },
        { name: "b", path: dirB },
      ],
    });
    // Write colliding IDs into projects.json on disk so ProjectRegistry reads them honestly
    const projectsFile = join(env.profile, "projects.json");
    const storedProjects = JSON.parse(readFileSync(projectsFile, "utf8"));
    const projRecord = storedProjects.projects.find((p: { id: string }) => p.id === project.id);
    projRecord.directories[0].id = collidingId1;
    projRecord.directories[1].id = collidingId2;
    writeFileSync(projectsFile, JSON.stringify(storedProjects, null, 2));

    await expect(
      env.service.prepare({
        projectId: project.id,
        name: "Colliding Task",
        repositories: [],
        directoryIds: [collidingId1, collidingId2],
        sharedWriteConfirmed: true,
        override: false,
      }),
    ).rejects.toThrow("任务来源名称冲突");

    expect(env.storage.read()).toBeNull();
  });

  it("refuses creation when target is inside or contains task workspace (overlap), creating nothing", async () => {
    const env = await setupPureDirectoryEnv();
    // A directory that is the root tasks folder itself (contains the task workspace)
    const overlapDir = env.root;

    const project = await env.projects.create({
      name: "Overlap Project",
      description: "",
      repositories: [],
      directories: [{ name: "overlap", path: overlapDir }],
    });

    await expect(
      env.service.prepare({
        projectId: project.id,
        name: "Overlap Task",
        repositories: [],
        directoryIds: [project.directories[0]!.id],
        sharedWriteConfirmed: true,
        override: false,
      }),
    ).rejects.toThrow("普通目录与任务工作区重叠");

    expect(env.storage.read()).toBeNull();
  });

  it("refuses creation when directory source is missing or moved, creating nothing", async () => {
    const env = await setupPureDirectoryEnv();
    const missingDir = join(env.home, "missing-dir");
    // Not created on disk

    const project = await env.projects.create({
      name: "Missing Project",
      description: "",
      repositories: [],
      directories: [{ name: "missing", path: missingDir }],
    });

    await expect(
      env.service.prepare({
        projectId: project.id,
        name: "Missing Task",
        repositories: [],
        directoryIds: [project.directories[0]!.id],
        sharedWriteConfirmed: true,
        override: false,
      }),
    ).rejects.toThrow();

    expect(env.storage.read()).toBeNull();
  });

  it("mutation check (a): skipping sharedWriteConfirmed causes refusal to fail", async () => {
    const env = await setupPureDirectoryEnv();
    const preparePromise = env.service.prepare({
      ...env.request,
      sharedWriteConfirmed: false,
    });
    // If the check were skipped, prepare would resolve instead of rejecting
    await expect(preparePromise).rejects.toThrow("请确认普通目录的共享写入风险");
  });

  it("mutation check (b): removing overlap check causes workspace overlap refusal to fail", async () => {
    const env = await setupPureDirectoryEnv();
    const overlapDir = env.root;
    const project = await env.projects.create({
      name: "Mutation Overlap",
      description: "",
      repositories: [],
      directories: [{ name: "overlap", path: overlapDir }],
    });
    const preparePromise = env.service.prepare({
      projectId: project.id,
      name: "Mutation Overlap Task",
      repositories: [],
      directoryIds: [project.directories[0]!.id],
      sharedWriteConfirmed: true,
      override: false,
    });
    // If overlap check were removed, prepare would resolve instead of rejecting
    await expect(preparePromise).rejects.toThrow("普通目录与任务工作区重叠");
  });
});
