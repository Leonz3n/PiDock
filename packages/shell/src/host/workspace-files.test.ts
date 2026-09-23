/**
 * Tests for the [PiDock 10] (#15) S3 Host file access: real rules, injected
 * readers (no filesystem, no git) and secret masking at the boundary.
 */
import { describe, expect, it } from "vitest";
import { type TaskDiskRecord } from "./task-store.js";
import { memoryTaskStore } from "./task-host.js";
import { TaskWorkspaceFiles, MAX_PREVIEW_BYTES, type WorkspaceFileReaders } from "./workspace-files.js";

const TASK_DIR = "/tasks/task-aaaaaaaa";

function record(): TaskDiskRecord {
  return {
    taskId: "task-aaaaaaaa",
    name: "结账",
    dirId: "task-aaaaaaaa",
    branch: "work/checkout",
    root: "/repos/task-aaaaaaaa",
    taskDir: TASK_DIR,
    remoteBranch: "main",
    baseCommit: "base-sha",
    repos: ["front-monorepo", "invoice-service"],
    repoSources: [
      { repoDir: "front-monorepo", remote: "origin", remoteBranch: "main", baseCommit: "base-front" },
      { repoDir: "invoice-service", remote: "origin", remoteBranch: "release/v2", baseCommit: "base-invoice" },
    ],
    dirLinks: [{ linkName: "dir-51cd20bb", directoryId: "dir-51cd20bb", sourcePath: "/work/invoice-docs", snapshotAt: "2026-09-20T00:00:00.000Z" }],
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  };
}

function store(overrides: Partial<TaskDiskRecord> = {}) {
  const disk = memoryTaskStore();
  disk.writeTask(TASK_DIR, { ...record(), ...overrides });
  return disk;
}

function readers(overrides: Partial<WorkspaceFileReaders> = {}): WorkspaceFileReaders {
  return {
    listDirectory: () => [],
    readTextFile: () => ({ ok: true, text: "", bytes: 0 }),
    runGit: () => ({ ok: true, stdout: "" }),
    ...overrides,
  };
}

describe("TaskWorkspaceFiles", () => {
  it("derives one root per repo and per plain-directory link, with baselines", () => {
    const files = new TaskWorkspaceFiles("task-aaaaaaaa", TASK_DIR, store(), readers());
    expect(files.roots().map((root) => [root.id, root.kind, root.baseCommit ?? null])).toEqual([
      ["front-monorepo", "worktree", "base-front"],
      ["invoice-service", "worktree", "base-invoice"],
      ["dir-51cd20bb", "shared-dir", null],
    ]);
    expect(files.attribution("dir-51cd20bb")?.sharedNote).toContain("修改影响原文件");
  });

  it("lists a directory through the reader and reports truncation", () => {
    const files = new TaskWorkspaceFiles(
      "task-aaaaaaaa",
      TASK_DIR,
      store(),
      readers({
        listDirectory: (path) => {
          expect(path).toBe(`${TASK_DIR}/front-monorepo/src`);
          return [
            { name: "checkout", kind: "dir" },
            { name: "api.ts", kind: "file", size: 12 },
          ];
        },
      }),
    );
    const result = files.tree({ rootId: "front-monorepo", relative: "src" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tree.entries.map((entry) => entry.path)).toEqual(["src/checkout", "src/api.ts"]);
    expect(result.tree.attribution).toMatchObject({ taskId: "task-aaaaaaaa", repo: "front-monorepo", piWorkDir: TASK_DIR });
  });

  it("refuses an unknown root and an escaping relative path before reading anything", () => {
    let touched = false;
    const files = new TaskWorkspaceFiles(
      "task-aaaaaaaa",
      TASK_DIR,
      store(),
      readers({
        listDirectory: () => {
          touched = true;
          return [];
        },
      }),
    );
    expect(files.tree({ rootId: "other-task" }).ok).toBe(false);
    const escape = files.tree({ rootId: "front-monorepo", relative: "../invoice-service" });
    expect(escape.ok).toBe(false);
    if (escape.ok) return;
    expect(escape.error).toContain("path-out-of-scope");
    expect(touched).toBe(false);
  });

  it("masks task-private values in a preview and reports the line count", () => {
    const files = new TaskWorkspaceFiles(
      "task-aaaaaaaa",
      TASK_DIR,
      store(),
      readers({
        readTextFile: () => ({ ok: true, text: "db_password = sup3r-secret\nowner = ops", bytes: 40 }),
      }),
      () => ["sup3r-secret"],
    );
    const result = files.preview({ rootId: "invoice-service", relative: "config/db.toml" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.source).not.toContain("sup3r-secret");
    expect(result.preview.lineCount).toBe(2);
    expect(result.preview.path).toBe("config/db.toml");
  });

  it("surfaces a reader refusal (binary/oversized) as an error instead of text", () => {
    const files = new TaskWorkspaceFiles(
      "task-aaaaaaaa",
      TASK_DIR,
      store(),
      readers({ readTextFile: () => ({ ok: false, error: `file-too-large: 超过 ${MAX_PREVIEW_BYTES} 字节，未读取` }) }),
    );
    const result = files.preview({ rootId: "front-monorepo", relative: "big.bin" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("file-too-large");
  });

  it("runs git diff with a fixed argv in the root cwd and no shell", () => {
    const calls: { args: readonly string[]; cwd: string }[] = [];
    const files = new TaskWorkspaceFiles(
      "task-aaaaaaaa",
      TASK_DIR,
      store(),
      readers({
        runGit: (args, cwd) => {
          calls.push({ args, cwd });
          return { ok: true, stdout: "diff --git a/api.ts b/api.ts\n+const token = 'tok_live_abcdef'\n" };
        },
      }),
    );
    const result = files.diff({ rootId: "invoice-service", relative: "src/api.ts" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls[0]).toEqual({ args: ["diff", "--no-color", "base-invoice", "--", "src/api.ts"], cwd: `${TASK_DIR}/invoice-service` });
    expect(result.diff).not.toContain("tok_live_abcdef");
    expect(result.attribution.repo).toBe("invoice-service");
  });

  it("omits the path for a whole-worktree diff and refuses a diff for a plain-dir link", () => {
    const calls: readonly string[][] = [];
    const files = new TaskWorkspaceFiles(
      "task-aaaaaaaa",
      TASK_DIR,
      store(),
      readers({
        runGit: (args) => {
          (calls as string[][]).push([...args]);
          return { ok: true, stdout: "" };
        },
      }),
    );
    expect(files.diff({ rootId: "front-monorepo" }).ok).toBe(true);
    expect((calls as string[][])[0]).toEqual(["diff", "--no-color", "base-front", "--"]);
    const link = files.diff({ rootId: "dir-51cd20bb", relative: "spec.md" });
    expect(link.ok).toBe(false);
    if (link.ok) return;
    expect(link.error).toContain("plain-dir-no-diff");
    expect((calls as string[][]).length).toBe(1);
  });

  it("falls back to the task baseline commit when a repo has no source record", () => {
    const calls: readonly string[][] = [];
    const files = new TaskWorkspaceFiles(
      "task-aaaaaaaa",
      TASK_DIR,
      store({ repoSources: undefined }),
      readers({
        runGit: (args) => {
          (calls as string[][]).push([...args]);
          return { ok: true, stdout: "" };
        },
      }),
    );
    files.diff({ rootId: "front-monorepo" });
    expect((calls as string[][])[0]).toEqual(["diff", "--no-color", "base-sha", "--"]);
  });

  it("reports a git failure instead of an empty diff", () => {
    const files = new TaskWorkspaceFiles(
      "task-aaaaaaaa",
      TASK_DIR,
      store(),
      readers({ runGit: () => ({ ok: false, error: "git-failed: not a git repository" }) }),
    );
    const result = files.diff({ rootId: "front-monorepo", relative: "a.ts" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("git-failed");
  });

  it("gives the delivery target for a worktree and refuses it for a link", () => {
    const files = new TaskWorkspaceFiles("task-aaaaaaaa", TASK_DIR, store(), readers());
    const worktree = files.delivery({ rootId: "front-monorepo" });
    expect(worktree.ok).toBe(true);
    if (!worktree.ok) return;
    expect(worktree.target).toMatchObject({ repo: "front-monorepo", branch: "main", autoCommit: false, autoPush: false, autoMerge: false });
    const link = files.delivery({ rootId: "dir-51cd20bb" });
    expect(link.ok).toBe(false);
    const unknown = files.delivery({ rootId: "nope" });
    expect(unknown.ok).toBe(false);
  });

  it("refuses to read a task record that is not on disk", () => {
    const files = new TaskWorkspaceFiles("task-aaaaaaaa", "/tasks/missing", memoryTaskStore(), readers());
    expect(() => files.roots()).toThrow(/task-unknown/);
  });
});
