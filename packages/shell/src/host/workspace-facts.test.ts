/**
 * [Pencil T02] #137 bullet 4: reopening a task re-verifies each source against
 * the identity the record holds, and names every non-ready source
 * (来源缺失 / 身份不符 / 待修复). The record is never rewritten by a read.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteDigest } from "../main/remote-identity.js";
import { memoryTaskStore } from "./task-host.js";
import { TaskWorkspaceFiles, realWorkspaceFileReaders, type WorkspaceFileReaders } from "./workspace-files.js";
import type { TaskDiskRecord } from "./task-store.js";

const TASK_DIR = "/tasks/task-aaaaaaaa";
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function record(overrides: Partial<TaskDiskRecord> = {}): TaskDiskRecord {
  return {
    taskId: "task-aaaaaaaa", name: "既有目录", dirId: "task-aaaaaaaa", branch: "task/task-aaaaaaaa",
    root: "/tasks", taskDir: TASK_DIR, remoteBranch: "", baseCommit: "", repos: [],
    workspaceMode: "existing-git",
    sharedRepos: [{
      rootId: "repo-12345678", sourcePath: "/src/repo", sourceRealPath: "/src/repo", remote: "origin",
      remoteBranch: "main", headCommit: "a".repeat(40), commonDir: "/src/repo/.git", remoteDigest: "d".repeat(64),
      sourceDevice: "10", sourceInode: "20", snapshotAt: "2026-11-01T00:00:00.000Z",
    }],
    createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

function store(value: TaskDiskRecord) {
  const disk = memoryTaskStore();
  disk.writeTask(TASK_DIR, value);
  return disk;
}

function readers(overrides: Partial<WorkspaceFileReaders> = {}): WorkspaceFileReaders {
  return {
    listDirectory: () => [],
    readTextFile: () => ({ ok: true, text: "", bytes: 0 }),
    runGit: () => ({ ok: true, stdout: "" }),
    realPath: (path) => path,
    identity: (path) => ({ kind: "dir", realPath: path, device: "10", inode: "20" }),
    ...overrides,
  };
}

function sharedFiles(overrides: Partial<WorkspaceFileReaders> = {}, overridesRecord: Partial<TaskDiskRecord> = {}) {
  return new TaskWorkspaceFiles("task-aaaaaaaa", TASK_DIR, store(record(overridesRecord)), readers(overrides));
}

describe("per-source reopen verification", () => {
  it("reports a deleted existing checkout as 来源缺失 without rewriting the record", () => {
    const disk = store(record());
    const files = new TaskWorkspaceFiles("task-aaaaaaaa", TASK_DIR, disk, readers({ identity: () => ({ kind: "missing" }) }));
    const [source] = files.facts();
    expect(source?.verification?.state).toBe("missing");
    expect(source?.verification?.reason).toContain("来源缺失");
    expect(disk.readTask(TASK_DIR)?.sharedRepos?.[0]?.sourcePath).toBe("/src/repo");
  });

  it("reports a replaced checkout (same path, other device/inode) as 身份不符", () => {
    const [source] = sharedFiles({ identity: (path) => ({ kind: "dir", realPath: path, device: "10", inode: "99" }) }).facts();
    expect(source?.verification).toMatchObject({ state: "mismatch" });
    expect(source?.verification?.reason).toContain("已被替换");
  });

  it("reports a changed Git common dir or remote digest as 身份不符", () => {
    const common = sharedFiles({
      runGit: (args) => args[0] === "rev-parse" && args.includes("--git-common-dir")
        ? { ok: true, stdout: "/other/.git\n" }
        : { ok: true, stdout: "origin\n" },
    }).facts()[0];
    expect(common?.verification?.state).toBe("mismatch");
    expect(common?.verification?.reason).toContain("Git 公共目录");

    const digest = sharedFiles({
      runGit: (args) => args[0] === "rev-parse" && args.includes("--git-common-dir")
        ? { ok: true, stdout: "/src/repo/.git\n" }
        : { ok: true, stdout: "https://example.com/other.git\n" },
    }).facts()[0];
    // Same common dir, different remote URL => digest differs.
    expect(digest?.verification?.state).toBe("mismatch");
    expect(digest?.verification?.reason).toContain("Git 远程地址");
  });

  it("reports a record without stored identity as 待修复, never as verified", () => {
    const [source] = sharedFiles({}, { sharedRepos: [{ ...record().sharedRepos![0]!, sourceDevice: undefined, sourceInode: undefined }] }).facts();
    expect(source?.verification?.state).toBe("repair-required");
    expect(source?.verification?.reason).toContain("待修复");
  });

  it("verifies a plain-directory link by its recorded device/inode", () => {
    const dirRecord = record({
      workspaceMode: "plain-dirs", sharedRepos: undefined, repos: [],
      dirLinks: [{ linkName: "dir-12345678", directoryId: "dir-12345678", sourcePath: "/work/docs", snapshotAt: "2026-11-01T00:00:00.000Z", sourceDevice: "30", sourceInode: "40" }],
    });
    const missing = new TaskWorkspaceFiles("task-aaaaaaaa", TASK_DIR, store(dirRecord), readers({ identity: () => ({ kind: "missing" }) })).facts();
    expect(missing[0]?.verification?.state).toBe("missing");
    const replaced = new TaskWorkspaceFiles("task-aaaaaaaa", TASK_DIR, store(dirRecord),
      readers({ identity: (path) => ({ kind: "dir", realPath: path, device: "30", inode: "41" }) })).facts();
    expect(replaced[0]?.verification?.state).toBe("mismatch");
    const ready = new TaskWorkspaceFiles("task-aaaaaaaa", TASK_DIR, store(dirRecord),
      readers({ identity: (path) => ({ kind: "dir", realPath: path, device: "30", inode: "40" }) })).facts();
    expect(ready[0]?.kind).toBe("shared-dir");
    expect(ready[0]?.verification).toMatchObject({ state: "ready" });
  });

  it("verifies a worktree by its recorded target identity and Git common dir", () => {
    const worktree = record({
      workspaceMode: "worktree", sharedRepos: undefined, repos: ["repo-12345678"],
      repoSources: [{ repoDir: "repo-12345678", remote: "origin", remoteBranch: "main", baseCommit: "b".repeat(40),
        commonDir: "/src/repo/.git", remoteDigest: "d".repeat(64), targetDevice: "10", targetInode: "20" }],
    });
    const missing = new TaskWorkspaceFiles("task-aaaaaaaa", TASK_DIR, store(worktree), readers({ identity: () => ({ kind: "missing" }) })).facts();
    expect(missing[0]?.verification?.state).toBe("missing");
    const mismatch = new TaskWorkspaceFiles("task-aaaaaaaa", TASK_DIR, store(worktree),
      readers({ identity: (path) => ({ kind: "dir", realPath: path, device: "10", inode: "21" }) })).facts();
    expect(mismatch[0]?.verification?.state).toBe("mismatch");
    const commonDir = "/src/repo/.git";
    const digestRecord = { ...worktree, repoSources: [{ ...worktree.repoSources![0]!, remoteDigest: remoteDigest("https://example.com/repo.git") }] };
    const ready = new TaskWorkspaceFiles("task-aaaaaaaa", TASK_DIR, store(digestRecord),
      readers({ identity: (path) => ({ kind: "dir", realPath: path, device: "10", inode: "20" }),
        runGit: (args) => ({ ok: true, stdout: args[0] === "rev-parse" ? commonDir : "https://example.com/repo.git" }) })).facts();
    expect(ready[0]?.verification).toMatchObject({ state: "ready" });
  });

  it("derives a legacy record's mode and never invents one from the UI", () => {
    const legacyWorktree = record({ workspaceMode: undefined, sharedRepos: undefined, repos: ["repo-12345678"],
      repoSources: [{ repoDir: "repo-12345678", remote: "origin", remoteBranch: "main", baseCommit: "b".repeat(40) }] });
    expect(new TaskWorkspaceFiles("task-aaaaaaaa", TASK_DIR, store(legacyWorktree), readers()).workspaceMode()).toBe("worktree");
    const legacyExisting = record({ workspaceMode: undefined });
    expect(new TaskWorkspaceFiles("task-aaaaaaaa", TASK_DIR, store(legacyExisting), readers()).workspaceMode()).toBe("existing-git");
    const legacyPlain = record({ workspaceMode: undefined, sharedRepos: undefined, repos: [], dirLinks: [] });
    expect(new TaskWorkspaceFiles("task-aaaaaaaa", TASK_DIR, store(legacyPlain), readers()).workspaceMode()).toBe("plain-dirs");
  });

  it("names a moved plain directory from the real filesystem instead of following it", () => {
    const home = mkdtempSync(join(tmpdir(), "pidock-facts-")); homes.push(home);
    const target = join(home, "docs");
    const { mkdirSync, renameSync } = process.getBuiltinModule("node:fs") as typeof import("node:fs");
    mkdirSync(target);
    const disk = memoryTaskStore();
    // Record the real identity first, exactly as a creation would.
    const identity = realWorkspaceFileReaders.identity(target);
    expect(identity.kind).toBe("dir");
    disk.writeTask(TASK_DIR, record({
      workspaceMode: "plain-dirs", sharedRepos: undefined, repos: [],
      dirLinks: [{ linkName: "dir-12345678", directoryId: "dir-12345678", sourcePath: target, snapshotAt: "2026-11-01T00:00:00.000Z",
        sourceDevice: identity.device!, sourceInode: identity.inode! }],
    }));
    const files = new TaskWorkspaceFiles("task-aaaaaaaa", TASK_DIR, disk, realWorkspaceFileReaders);
    expect(files.facts()[0]?.verification).toMatchObject({ state: "ready" });
    const moved = `${target}-moved`;
    renameSync(target, moved);
    expect(files.facts()[0]?.verification).toMatchObject({ state: "missing" });
    // A different directory at the same path is a replacement, not the original.
    mkdirSync(target);
    expect(files.facts()[0]?.verification?.state).toBe("mismatch");
  });
});
