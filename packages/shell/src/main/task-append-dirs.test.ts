import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskWorkspaceHost } from "../host/task-host.js";
import { diskTaskStore, readTaskRecordOnDisk } from "../host/task-store.js";
import type { HostTaskResult, HostTaskOp } from "../rpc/protocol.js";
import { buildLinkName } from "./multi-repo-provision.js";
import { ProjectRegistry } from "./project-registry.js";
import { CreationIntentStore, ProjectTaskCreation } from "./project-task-creation.js";
import { ProjectTaskAppend, createNodeAppendGit } from "./task-append.js";
import { TaskRootIndex } from "./task-root-index.js";
import { createNodePrepScanDeps, createPrepScanAuthority } from "./task-prep-scan.js";
import { performAppendOperation } from "./project-append-ipc.js";
import * as fs from "node:fs";

const homes: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeRepo(home: string, name: string, content: string) {
  const remote = join(home, `${name}-remote.git`);
  const repo = join(home, name);
  fs.mkdirSync(repo);
  git(home, "init", "--bare", remote);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@localhost");
  git(repo, "config", "user.name", "Test");
  git(repo, "remote", "add", "origin", remote);
  fs.writeFileSync(join(repo, "README.md"), `${content}\n`);
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", `${name} baseline`);
  git(repo, "push", "-u", "origin", "main");
  return { repo, remote, branch: "main" };
}

async function setup(options: { lieAboutDirs?: boolean } = {}) {
  const home = fs.mkdtempSync(join(tmpdir(), "pidock-append-dirs-"));
  homes.push(home);
  const root = join(home, "tasks");
  fs.mkdirSync(root);
  const profile = join(home, "profile");

  const repoFixture = makeRepo(home, "base-repo", "initial repo baseline");
  const dir1 = join(home, "plain-dir-1");
  const dir2 = join(home, "plain-dir-2");
  fs.mkdirSync(dir1);
  fs.mkdirSync(dir2);
  fs.writeFileSync(join(dir1, "file1.txt"), "content of dir 1\n");
  fs.writeFileSync(join(dir2, "file2.txt"), "content of dir 2\n");

  const projects = new ProjectRegistry(profile);
  const project = await projects.create({
    name: "Mixed Append Project",
    description: "",
    repositories: [{ name: "base-repo", path: repoFixture.repo }],
    directories: [
      { name: "dir1", path: dir1 },
      { name: "dir2", path: dir2 },
    ],
  });

  const roots = new TaskRootIndex(profile, root);
  const storage = new CreationIntentStore(profile);

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
        const result = instance.appendRepos(params.payload as never);
        return {
          workspaceId: "w",
          taskId: params.taskId,
          op: params.op,
          payload: { ...result.record, plan: result.plan, appended: result.appended, skipped: result.skipped },
        };
      }
      if (params.op === "task/appendDirs") {
        if (options.lieAboutDirs) {
          // A Host that claims success without recording the link at all: the
          // sender must never surface that as an appended directory.
          const record = readTaskRecordOnDisk(taskRootFor(params.taskId, params.payload));
          return {
            workspaceId: "w",
            taskId: params.taskId,
            op: params.op,
            payload: { ...record, appended: (params.payload["plainDirs"] as { directoryId: string }[]).map((d) => d.directoryId), skipped: [] },
          };
        }
        const result = instance.appendDirs(params.payload as never);
        return {
          workspaceId: "w",
          taskId: params.taskId,
          op: params.op,
          payload: { ...result.record, appended: result.appended, skipped: result.skipped },
        };
      }
      throw new Error(`unsupported op: ${params.op}`);
    },
  };

  const createService = new ProjectTaskCreation(storage, projects, roots, host, root);
  // Create an initial task with base-repo and dir1
  const preview = await createService.prepare({
    projectId: project.id,
    name: "Existing Task",
    repositories: [{ sourceId: project.repositories[0]!.id, remote: "origin", remoteBranch: "main" }],
    directoryIds: [project.directories[0]!.id],
    sharedWriteConfirmed: true,
    override: false,
  });
  await createService.commit(preview.id);

  const scanAuthority = createPrepScanAuthority(projects, roots);

  const appendService = new ProjectTaskAppend(
    host,
    scanAuthority,
    createNodePrepScanDeps(),
    createNodeAppendGit(),
  );

  return {
    home,
    root,
    profile,
    dir1,
    dir2,
    project,
    projects,
    roots,
    taskId: preview.taskId,
    taskDir: preview.taskDir,
    appendService,
    host,
  };
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("Production plain-directory append for an existing task", () => {
  it("appends a plain directory preserving existing links, task roots, and Git baselines", async () => {
    const env = await setup();
    const existingDirLinkName = buildLinkName(env.project.directories[0]!.id);
    const existingDirLinkPath = join(env.taskDir, existingDirLinkName);

    // Initial state observations
    const oldInode = fs.lstatSync(existingDirLinkPath).ino;
    const oldReadlink = fs.readlinkSync(existingDirLinkPath);
    const beforeRecord = readTaskRecordOnDisk(env.taskDir)!;
    const beforeGitBaselines = beforeRecord.repoSources;
    const beforeBaseCommit = beforeRecord.baseCommit;
    const beforeRemoteBranch = beforeRecord.remoteBranch;
    const beforeRoot = beforeRecord.root;
    const beforeDirId = beforeRecord.dirId;

    // Append plain-dir-2
    const targetDirId = env.project.directories[1]!.id;
    const appendResult = await env.appendService.append({
      taskId: env.taskId,
      directoryIds: [targetDirId],
      sharedWriteConfirmed: true,
    });

    const expectedNewLinkName = buildLinkName(targetDirId);
    expect(appendResult.appendedDirs).toHaveLength(1);
    expect(appendResult.appendedDirs[0]).toEqual({
      directoryId: targetDirId,
      name: "dir2",
      linkName: expectedNewLinkName,
      sourcePath: env.dir2,
      linkPath: join(env.taskDir, expectedNewLinkName),
    });
    expect(appendResult.skippedDirs).toHaveLength(0);

    // 1. New link is present at stable ASCII name and points to original target
    const newLinkPath = join(env.taskDir, expectedNewLinkName);
    expect(fs.lstatSync(newLinkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(newLinkPath)).toBe(env.dir2);

    // 2. Old link is byte-identical: same inode and same target
    expect(fs.readlinkSync(existingDirLinkPath)).toBe(oldReadlink);
    expect(fs.lstatSync(existingDirLinkPath).ino).toBe(oldInode);

    // 3. Git baselines are completely untouched
    const afterRecord = readTaskRecordOnDisk(env.taskDir)!;
    expect(afterRecord.repoSources).toEqual(beforeGitBaselines);
    expect(afterRecord.baseCommit).toBe(beforeBaseCommit);
    expect(afterRecord.remoteBranch).toBe(beforeRemoteBranch);

    // 4. Saved root and dirId reused
    expect(afterRecord.root).toBe(beforeRoot);
    expect(afterRecord.dirId).toBe(beforeDirId);

    // 5. Writing to original through new link changes original file; nothing copied into task folder
    const fileInLink = join(newLinkPath, "file2.txt");
    fs.writeFileSync(fileInLink, "updated through appended link!\n");
    expect(fs.readFileSync(join(env.dir2, "file2.txt"), "utf8")).toBe("updated through appended link!\n");
    expect(fs.lstatSync(newLinkPath).isSymbolicLink()).toBe(true);
  });

  it("refuses append by name when a different directory was swapped in at the recorded source path", async () => {
    const env = await setup();
    const dir2Id = env.project.directories[1]!.id;
    const linkName = buildLinkName(dir2Id);
    const linkPath = join(env.taskDir, linkName);

    // The first append records the link. The record must carry the source's
    // device/inode, not only the path string: a path is not an identity.
    await env.appendService.append({ taskId: env.taskId, directoryIds: [dir2Id], sharedWriteConfirmed: true });
    const recorded = readTaskRecordOnDisk(env.taskDir)!.dirLinks!.find((link) => link.directoryId === dir2Id)!;
    expect(recorded.sourcePath).toBe(env.dir2);
    expect(recorded.sourceDevice).toBeTruthy();
    expect(recorded.sourceInode).toBeTruthy();

    // Replace the directory at the SAME path: `readlink` still matches and the
    // path string is unchanged, so only the recorded source identity can tell
    // that this is no longer the directory the link was created for.
    fs.rmSync(env.dir2, { recursive: true, force: true });
    fs.mkdirSync(env.dir2);
    fs.writeFileSync(join(env.dir2, "file2.txt"), "impostor content\n");
    const before = readTaskRecordOnDisk(env.taskDir);

    await expect(
      env.appendService.append({ taskId: env.taskId, directoryIds: [dir2Id], sharedWriteConfirmed: true }),
    ).rejects.toThrow(`source-changed: 普通目录 ${linkName}（dir2）`);

    // Fail closed, write nothing: the record keeps the original snapshot, the
    // recorded link is not repointed, and no source directory was touched.
    expect(readTaskRecordOnDisk(env.taskDir)).toEqual(before);
    expect(fs.readlinkSync(linkPath)).toBe(env.dir2);
    expect(fs.readFileSync(join(env.dir2, "file2.txt"), "utf8")).toBe("impostor content\n");
  });

  it("truthful retry / idempotent skip: second append skips directory and keeps record identical", async () => {
    const env = await setup();
    const dir2Id = env.project.directories[1]!.id;

    // First append
    await env.appendService.append({
      taskId: env.taskId,
      directoryIds: [dir2Id],
      sharedWriteConfirmed: true,
    });

    const recordAfterFirst = readTaskRecordOnDisk(env.taskDir);
    const linkPath = join(env.taskDir, buildLinkName(dir2Id));
    const inodeAfterFirst = fs.lstatSync(linkPath).ino;

    // Second append (retry with same directory)
    const retryResult = await env.appendService.append({
      taskId: env.taskId,
      directoryIds: [dir2Id],
      sharedWriteConfirmed: true,
    });

    expect(retryResult.appendedDirs).toHaveLength(0);
    expect(retryResult.skippedDirs).toHaveLength(1);
    expect(retryResult.skippedDirs[0]!.directoryId).toBe(dir2Id);
    expect(retryResult.skippedDirs[0]!.linkName).toBe(buildLinkName(dir2Id));

    // Record byte-identical and inode intact
    const recordAfterRetry = readTaskRecordOnDisk(env.taskDir);
    expect(recordAfterRetry).toEqual(recordAfterFirst);
    expect(fs.lstatSync(linkPath).ino).toBe(inodeAfterFirst);
  });

  it("truthful defect detection: refuses when recorded directory symlink was deleted from disk", async () => {
    const env = await setup();
    const dir1Id = env.project.directories[0]!.id;
    const dir1LinkPath = join(env.taskDir, buildLinkName(dir1Id));

    // Directory 1 is already recorded in task record. Now simulate external corruption: symlink deleted.
    fs.unlinkSync(dir1LinkPath);
    expect(fs.existsSync(dir1LinkPath)).toBe(false);

    // Append attempt including dir1 should detect link-missing
    await expect(
      env.appendService.append({
        taskId: env.taskId,
        directoryIds: [dir1Id],
        sharedWriteConfirmed: true,
      }),
    ).rejects.toThrow("link-missing");
  });

  it("truthful defect detection: refuses when recorded directory symlink points to wrong target", async () => {
    const env = await setup();
    const dir1Id = env.project.directories[0]!.id;
    const dir1LinkPath = join(env.taskDir, buildLinkName(dir1Id));

    // Replace symlink with a symlink to somewhere else
    fs.unlinkSync(dir1LinkPath);
    const bogusDir = join(env.home, "bogus");
    fs.mkdirSync(bogusDir);
    // win32: a plain directory symlink needs SeCreateSymbolicLinkPrivilege; a junction is the directory link this platform can create without it (#57).
    fs.symlinkSync(bogusDir, dir1LinkPath, process.platform === "win32" ? "junction" : "dir");

    await expect(
      env.appendService.append({
        taskId: env.taskId,
        directoryIds: [dir1Id],
        sharedWriteConfirmed: true,
      }),
    ).rejects.toThrow("link-mismatch");
  });

  it("refuses append when shared-write confirmation is missing", async () => {
    const env = await setup();
    const dir2Id = env.project.directories[1]!.id;

    await expect(
      env.appendService.append({
        taskId: env.taskId,
        directoryIds: [dir2Id],
        sharedWriteConfirmed: false,
      }),
    ).rejects.toThrow("请确认普通目录的共享写入风险");
  });

  it("refuses append when target directory is inside task workspace (overlap)", async () => {
    const env = await setup();
    // Create a directory inside the task workspace
    const insideTaskDir = join(env.taskDir, "inside-dir");
    fs.mkdirSync(insideTaskDir);

    // Add it to project
    const updatedProject = await env.projects.update(env.project.id, {
      description: "",
      repositories: env.project.repositories,
      directories: [...env.project.directories, { name: "inside", path: insideTaskDir }],
    });
    const insideDirId = updatedProject.directories.find((d) => d.name === "inside")!.id;

    await expect(
      env.appendService.append({
        taskId: env.taskId,
        directoryIds: [insideDirId],
        sharedWriteConfirmed: true,
      }),
    ).rejects.toThrow("普通目录与任务工作区重叠");
  });

  it("refuses append when the registered directory CONTAINS the task workspace (overlap, other direction)", async () => {
    const env = await setup();
    // The other overlap direction: the source is an ANCESTOR of the task
    // folder (the tasks root contains `<root>/<taskId>`). The sibling test
    // above covers a source INSIDE the task workspace; each direction is a
    // separate branch of the append's overlap check.
    const updatedProject = await env.projects.update(env.project.id, {
      description: "",
      repositories: env.project.repositories,
      directories: [...env.project.directories, { name: "tasks-root", path: env.root }],
    });
    const containingId = updatedProject.directories.find((d) => d.name === "tasks-root")!.id;

    await expect(
      env.appendService.append({
        taskId: env.taskId,
        directoryIds: [containingId],
        sharedWriteConfirmed: true,
      }),
    ).rejects.toThrow("普通目录与任务工作区重叠");
  });

  it("refuses append when directory source is unusable/absent", async () => {
    const env = await setup();
    const absentDir = join(env.home, "absent-dir");
    const updatedProject = await env.projects.update(env.project.id, {
      description: "",
      repositories: env.project.repositories,
      directories: [...env.project.directories, { name: "absent", path: absentDir }],
    });
    const absentDirId = updatedProject.directories.find((d) => d.name === "absent")!.id;

    await expect(
      env.appendService.append({
        taskId: env.taskId,
        directoryIds: [absentDirId],
        sharedWriteConfirmed: true,
      }),
    ).rejects.toThrow("repo-unusable");
  });

  it("refuses append when a new directory collides with an existing recorded link name, creating nothing", async () => {
    const env = await setup();
    // The task already records dir1 at its stable link name. A second project
    // directory whose id maps to the SAME link name must be refused, never
    // silently sharing one link (the reachable name-collision case: `dir-` and
    // `repo-` prefixes mean a link name can only ever collide with another link).
    const dir1Id = env.project.directories[0]!.id;
    const dir1LinkName = buildLinkName(dir1Id);
    const prefix = dir1Id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
    const collidingId = `${prefix}-0000-4000-8000-0000000000ff`;
    expect(buildLinkName(collidingId)).toBe(dir1LinkName);

    const dir3 = join(env.home, "plain-dir-3");
    fs.mkdirSync(dir3);
    const projectsFile = join(env.profile, "projects.json");
    const stored = JSON.parse(fs.readFileSync(projectsFile, "utf8"));
    const row = stored.projects.find((p: { id: string }) => p.id === env.project.id);
    row.directories.push({ id: collidingId, name: "dir3", path: dir3 });
    fs.writeFileSync(projectsFile, JSON.stringify(stored, null, 2));

    const before = readTaskRecordOnDisk(env.taskDir);
    await expect(
      env.appendService.append({
        taskId: env.taskId,
        directoryIds: [collidingId],
        sharedWriteConfirmed: true,
      }),
    ).rejects.toThrow(/链接名冲突/);

    // Nothing created: the record is untouched and no second link appeared.
    expect(readTaskRecordOnDisk(env.taskDir)).toEqual(before);
    expect(fs.existsSync(join(env.taskDir, dir1LinkName))).toBe(true);
    expect(fs.readlinkSync(join(env.taskDir, dir1LinkName))).toBe(env.dir1);
  });

  it("refuses append when two selected directories map to the same link name, creating nothing", async () => {
    const env = await setup();
    const shared = "22222222-0000-4000-8000-000000000001";
    const sharedB = "22222222-0000-4000-8000-000000000002";
    expect(buildLinkName(shared)).toBe(buildLinkName(sharedB));
    const dirA = join(env.home, "collide-a");
    const dirB = join(env.home, "collide-b");
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    const projectsFile = join(env.profile, "projects.json");
    const stored = JSON.parse(fs.readFileSync(projectsFile, "utf8"));
    const row = stored.projects.find((p: { id: string }) => p.id === env.project.id);
    row.directories.push({ id: shared, name: "collide-a", path: dirA }, { id: sharedB, name: "collide-b", path: dirB });
    fs.writeFileSync(projectsFile, JSON.stringify(stored, null, 2));

    const before = readTaskRecordOnDisk(env.taskDir);
    await expect(
      env.appendService.append({
        taskId: env.taskId,
        directoryIds: [shared, sharedB],
        sharedWriteConfirmed: true,
      }),
    ).rejects.toThrow(/链接名冲突/);
    expect(readTaskRecordOnDisk(env.taskDir)).toEqual(before);
  });

  it("routes a directory-only append through the production IPC guard", async () => {
    const env = await setup();
    const dir2Id = env.project.directories[1]!.id;
    // A directory append is refused until the shared write is confirmed.
    await expect(
      performAppendOperation(env.appendService, { taskId: env.taskId, directoryIds: [dir2Id] }, () => undefined),
    ).rejects.toThrow(/invalid append input/);
    // An empty request (no repo, no dir) is refused.
    await expect(
      performAppendOperation(env.appendService, { taskId: env.taskId }, () => undefined),
    ).rejects.toThrow(/invalid append input/);
    // A page-supplied path/link name/scan is not part of the accepted shape.
    await expect(
      performAppendOperation(env.appendService, { taskId: env.taskId, directoryIds: [dir2Id], sharedWriteConfirmed: true, linkName: "dir-ffffffff" }, () => undefined),
    ).rejects.toThrow(/invalid append operation/);
    // The accepted shape creates the link and records it.
    await performAppendOperation(env.appendService, { taskId: env.taskId, directoryIds: [dir2Id], sharedWriteConfirmed: true }, () => undefined);
    expect(fs.readlinkSync(join(env.taskDir, buildLinkName(dir2Id)))).toBe(env.dir2);
  });

  it("never reports a link the Host did not record as appended", async () => {
    const env = await setup({ lieAboutDirs: true });
    const dir2Id = env.project.directories[1]!.id;
    const before = readTaskRecordOnDisk(env.taskDir);
    await expect(
      env.appendService.append({ taskId: env.taskId, directoryIds: [dir2Id], sharedWriteConfirmed: true }),
    ).rejects.toThrow("link-missing");
    // The record is untouched and no false success was reported.
    expect(readTaskRecordOnDisk(env.taskDir)).toEqual(before);
  });

  it("recovers a partial preparation: an unrecorded correct link is recorded, not re-created", async () => {
    const env = await setup();
    const dir2Id = env.project.directories[1]!.id;
    const linkName = buildLinkName(dir2Id);
    const linkPath = join(env.taskDir, linkName);
    // Simulate a crash after link creation but before the record write: the
    // link exists at the correct stable name, the record does not name it.
    fs.symlinkSync(env.dir2, linkPath, process.platform === "win32" ? "junction" : "dir");
    const inodeBefore = fs.lstatSync(linkPath).ino;
    expect(readTaskRecordOnDisk(env.taskDir)?.dirLinks?.some((link) => link.directoryId === dir2Id)).not.toBe(true);

    const result = await env.appendService.append({
      taskId: env.taskId,
      directoryIds: [dir2Id],
      sharedWriteConfirmed: true,
    });
    expect(result.appendedDirs).toHaveLength(1);
    expect(result.appendedDirs[0]!.linkPath).toBe(linkPath);
    // The same link is kept (not re-pointed) and is now recorded.
    expect(fs.lstatSync(linkPath).ino).toBe(inodeBefore);
    expect(fs.readlinkSync(linkPath)).toBe(env.dir2);
    expect(readTaskRecordOnDisk(env.taskDir)?.dirLinks?.some((link) => link.directoryId === dir2Id && link.linkName === linkName && link.sourcePath === env.dir2)).toBe(true);
  });

  it("appends a repository and a directory in one call, preserving the old link and pinning the new baseline", async () => {
    const env = await setup();
    // A second repo added to the project registry (main resolves its checkout).
    const secondRepo = makeRepo(env.home, "second-repo", "second baseline");
    const updated = await env.projects.update(env.project.id, {
      description: "",
      repositories: [...env.project.repositories, { name: "second-repo", path: secondRepo.repo }],
      directories: env.project.directories,
    });
    const secondSourceId = updated.repositories[1]!.id;
    const dir2Id = updated.directories[1]!.id;
    const oldLinkPath = join(env.taskDir, buildLinkName(updated.directories[0]!.id));
    const oldInode = fs.lstatSync(oldLinkPath).ino;
    const beforeRecord = readTaskRecordOnDisk(env.taskDir)!;

    const result = await env.appendService.append({
      taskId: env.taskId,
      repositories: [{ sourceId: secondSourceId, remote: "origin", remoteBranch: secondRepo.branch }],
      directoryIds: [dir2Id],
      sharedWriteConfirmed: true,
    });

    expect(result.appended).toHaveLength(1);
    expect(result.appendedDirs).toHaveLength(1);
    const after = readTaskRecordOnDisk(env.taskDir)!;
    // Git half: the new repo carries its own pinned commit; the old baseline is intact.
    expect(after.repoSources?.find((s) => s.repoDir === result.appended[0]!.repoDir)?.baseCommit).toBe(result.appended[0]!.commit);
    expect(after.repoSources?.find((s) => s.repoDir === beforeRecord.repos[0])?.baseCommit).toBe(beforeRecord.repoSources?.[0]?.baseCommit);
    // Directory half: new link present, old link byte-identical.
    expect(fs.lstatSync(oldLinkPath).ino).toBe(oldInode);
    expect(fs.readlinkSync(join(env.taskDir, buildLinkName(dir2Id)))).toBe(env.dir2);
    expect(after.root).toBe(beforeRecord.root);
    expect(after.dirId).toBe(beforeRecord.dirId);
  });
});
