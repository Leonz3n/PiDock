import { afterEach, describe, expect, it, vi } from "vitest";
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
import * as fs from "node:fs";

// Partial mock (repo precedent: `service-host-binding.test.ts`): only `symlinkSync`
// is replaced. It throws the real de-privileged EPERM shape for a directory
// symlink and delegates a `"junction"` attempt to the real call, so the append's
// PRODUCTION create/compare sites are exercised, not a test-only stand-in.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    symlinkSync: (target: string, path: string, type?: "dir" | "file" | "junction") => {
      if (type !== "junction") {
        throw Object.assign(new Error(`EPERM: operation not permitted, symlink '${target}' -> '${path}'`), {
          code: "EPERM",
          errno: -4048,
          syscall: "symlink",
        });
      }
      actual.symlinkSync(target, path, "junction");
    },
  };
});

const win32It = it.skipIf(process.platform !== "win32");
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

async function setup() {
  const home = fs.mkdtempSync(join(tmpdir(), "pidock-append-junction-"));
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
  const preview = await createService.prepare({
    projectId: project.id,
    name: "Existing Task",
    repositories: [{ sourceId: project.repositories[0]!.id, remote: "origin", remoteBranch: "main" }],
    directoryIds: [project.directories[0]!.id],
    sharedWriteConfirmed: true,
    override: false,
  });
  await createService.commit(preview.id);

  const appendService = new ProjectTaskAppend(host, createPrepScanAuthority(projects, roots), createNodePrepScanDeps(), createNodeAppendGit());

  return { home, root, dir1, dir2, project, taskId: preview.taskId, taskDir: preview.taskDir, appendService };
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("Append falls back to a junction on EPERM", () => {
  win32It("appends a fresh directory as a junction and keeps the recorded junction link passing the compare", async () => {
    const env = await setup();
    const dir1Id = env.project.directories[0]!.id;
    const dir2Id = env.project.directories[1]!.id;
    const dir1Link = join(env.taskDir, buildLinkName(dir1Id));
    const dir2Link = join(env.taskDir, buildLinkName(dir2Id));

    // Creation already produced the dir1 link through the same fallback.
    expect(fs.lstatSync(dir1Link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(dir1Link)).toBe(env.dir1);

    // Append dir2 (fresh → create site) together with dir1 (recorded → compare site).
    const result = await env.appendService.append({ taskId: env.taskId, directoryIds: [dir1Id, dir2Id], sharedWriteConfirmed: true });
    expect(result.appendedDirs!.some((d) => d.linkPath === dir2Link)).toBe(true);

    // The fresh link is a junction (a link, not a plain directory) and is usable.
    expect(fs.lstatSync(dir2Link).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(dir2Link).isDirectory()).toBe(false);
    expect(fs.readlinkSync(dir2Link)).toBe(env.dir2);
    expect(fs.readFileSync(join(dir2Link, "file2.txt"), "utf8")).toBe("content of dir 2\n");

    // The recorded-link compare and the truthful-commit compare both passed for
    // the junction links (no `link-mismatch` / `path-taken` was raised).
    const record = readTaskRecordOnDisk(env.taskDir)!;
    expect(record.dirLinks?.some((l) => l.directoryId === dir2Id && l.sourcePath === env.dir2)).toBe(true);
  });

  win32It("still refuses by name when a recorded junction is repointed at another directory", async () => {
    const env = await setup();
    const dir1Id = env.project.directories[0]!.id;
    const dir1Link = join(env.taskDir, buildLinkName(dir1Id));

    // Repoint the recorded link at a different directory (a junction, so this
    // file's mock lets it through) — the retarget must not be adopted.
    const bogusDir = join(env.home, "bogus");
    fs.mkdirSync(bogusDir);
    fs.unlinkSync(dir1Link);
    fs.symlinkSync(bogusDir, dir1Link, "junction");

    await expect(
      env.appendService.append({ taskId: env.taskId, directoryIds: [dir1Id], sharedWriteConfirmed: true }),
    ).rejects.toThrow("link-mismatch");
  });
});
