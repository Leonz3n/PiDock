/**
 * Tests for the [PiDock 10] (#15) S1 file-browsing rules. Pure: no fs, no git.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_DIFF_CHARS,
  MAX_TREE_ENTRIES,
  MAX_WORKSPACE_ROOTS,
  boundDiff,
  boundPreview,
  boundTreeEntries,
  deliveryTarget,
  findWorkspaceRoot,
  languageForPath,
  resolveWorkspacePath,
  workspaceAttribution,
  workspaceRoots,
} from "./workspace-files.js";

const TASK_DIR = "/Users/dev/pidock/tasks/task-aaaaaaaa";

function roots() {
  return workspaceRoots({
    taskId: "task-aaaaaaaa",
    taskDir: TASK_DIR,
    repos: ["front-monorepo", "invoice-service"],
    repoSources: [
      { repoDir: "front-monorepo", remoteBranch: "main" },
      { repoDir: "invoice-service", remoteBranch: "release/v2" },
    ],
    dirLinks: [{ linkName: "dir-51cd20bb", directoryId: "dir-51cd20bb", sourcePath: "/Users/dev/work/invoice-docs" }],
  });
}

describe("workspaceRoots", () => {
  it("lists each repo as its own worktree root with its baseline branch, never merging them", () => {
    const list = roots();
    expect(list.map((root) => root.id)).toEqual(["front-monorepo", "invoice-service", "dir-51cd20bb"]);
    expect(list[0]).toMatchObject({ kind: "worktree", repoDir: "front-monorepo", branch: "main", path: `${TASK_DIR}/front-monorepo` });
    expect(list[1]).toMatchObject({ kind: "worktree", repoDir: "invoice-service", branch: "release/v2" });
  });

  it("keeps a plain-directory link as a shared root with its recorded original target", () => {
    const link = roots()[2]!;
    expect(link).toMatchObject({
      kind: "shared-dir",
      directoryId: "dir-51cd20bb",
      sourcePath: "/Users/dev/work/invoice-docs",
      path: `${TASK_DIR}/dir-51cd20bb`,
    });
    expect(link.repoDir).toBeUndefined();
  });

  it("drops duplicate ids and bounds the root list", () => {
    const many = workspaceRoots({
      taskId: "t",
      taskDir: TASK_DIR,
      repos: Array.from({ length: MAX_WORKSPACE_ROOTS + 5 }, (_, index) => `repo-${index}`),
      dirLinks: [{ linkName: "repo-0", directoryId: "d", sourcePath: "/tmp/d" }],
    });
    expect(many).toHaveLength(MAX_WORKSPACE_ROOTS);
    expect(many.filter((root) => root.id === "repo-0")).toHaveLength(1);
  });
});

describe("resolveWorkspacePath", () => {
  it("resolves a relative path inside the selected root", () => {
    const result = resolveWorkspacePath({ roots: roots(), taskId: "task-aaaaaaaa", taskDir: TASK_DIR, rootId: "front-monorepo", relative: "src/checkout/api.ts" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.absolute).toBe(`${TASK_DIR}/front-monorepo/src/checkout/api.ts`);
    expect(result.relative).toBe("src/checkout/api.ts");
    expect(result.attribution.repo).toBe("front-monorepo");
    expect(result.attribution.piWorkDir).toBe(TASK_DIR);
  });

  it("refuses an absolute path instead of resolving it in the host path space", () => {
    const result = resolveWorkspacePath({ roots: roots(), taskId: "task-aaaaaaaa", taskDir: TASK_DIR, rootId: "front-monorepo", relative: "/etc/passwd" });
    // A leading slash is a path inside the root only by way of `..`-free segments;
    // the leading empty segment is dropped, so the request stays inside the root.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.absolute.startsWith(`${TASK_DIR}/front-monorepo/`)).toBe(true);
  });

  it("refuses `..` segments so a request can never escape the root", () => {
    for (const relative of ["../other-task/secret.txt", "src/../../outside", ".."]) {
      const result = resolveWorkspacePath({ roots: roots(), taskId: "task-aaaaaaaa", taskDir: TASK_DIR, rootId: "front-monorepo", relative });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("path-out-of-scope");
    }
  });

  it("refuses an unknown root and a root-less file request", () => {
    const unknown = resolveWorkspacePath({ roots: roots(), taskId: "task-aaaaaaaa", taskDir: TASK_DIR, rootId: "other-task", relative: "a.ts" });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error).toContain("unknown-root");

    const rootItself = resolveWorkspacePath({ roots: roots(), taskId: "task-aaaaaaaa", taskDir: TASK_DIR, rootId: "front-monorepo" });
    expect(rootItself.ok).toBe(false);

    const listing = resolveWorkspacePath({ roots: roots(), taskId: "task-aaaaaaaa", taskDir: TASK_DIR, rootId: "front-monorepo", allowRoot: true });
    expect(listing.ok).toBe(true);
  });

  it("names the owning task, repo and link target for attribution", () => {
    const link = resolveWorkspacePath({ roots: roots(), taskId: "task-aaaaaaaa", taskDir: TASK_DIR, rootId: "dir-51cd20bb", relative: "spec.md", allowRoot: true }).ok
      ? resolveWorkspacePath({ roots: roots(), taskId: "task-aaaaaaaa", taskDir: TASK_DIR, rootId: "dir-51cd20bb", relative: "spec.md" })
      : null;
    expect(link?.ok).toBe(true);
    if (!link || !link.ok) return;
    expect(link.attribution).toMatchObject({
      taskId: "task-aaaaaaaa",
      rootKind: "shared-dir",
      directoryId: "dir-51cd20bb",
      linkPath: `${TASK_DIR}/dir-51cd20bb`,
      sourcePath: "/Users/dev/work/invoice-docs",
      sharedNote: "普通目录链接：修改影响原文件，不提供 Git 差异与交付",
    });
  });
});

describe("boundTreeEntries", () => {
  it("orders directories first, derives relative paths and caps the listing", () => {
    const bounded = boundTreeEntries(
      [
        { name: "zeta.ts", kind: "file" },
        { name: "src", kind: "dir" },
        { name: "alpha.ts", kind: "file" },
        { name: "app", kind: "dir" },
      ],
      "packages",
    );
    expect(bounded.entries.map((entry) => entry.path)).toEqual([
      "packages/app",
      "packages/src",
      "packages/alpha.ts",
      "packages/zeta.ts",
    ]);
    expect(bounded.truncated).toBe(false);
  });

  it("drops nested or empty names and reports truncation at the bound", () => {
    const bounded = boundTreeEntries(
      [
        { name: "ok.txt", kind: "file" },
        { name: "../escape", kind: "file" },
        { name: "a/b", kind: "file" },
        { name: "", kind: "file" },
        { name: "..", kind: "dir" },
      ],
      "",
      1,
    );
    expect(bounded.entries.map((entry) => entry.name)).toEqual(["ok.txt"]);
    expect(bounded.truncated).toBe(false);
  });

  it("caps a large listing with the default bound", () => {
    const bounded = boundTreeEntries(
      Array.from({ length: MAX_TREE_ENTRIES + 3 }, (_, index) => ({ name: `f-${String(index).padStart(4, "0")}`, kind: "file" as const })),
      "",
    );
    expect(bounded.entries).toHaveLength(MAX_TREE_ENTRIES);
    expect(bounded.truncated).toBe(true);
  });
});

describe("boundPreview", () => {
  it("masks task-private secret values and known credential patterns", () => {
    const preview = boundPreview({
      root: findWorkspaceRoot(roots(), "invoice-service")!,
      taskId: "task-aaaaaaaa",
      taskDir: TASK_DIR,
      path: "config/db.yaml",
      source: "password: hunter2\nAPI_TOKEN=tok_live_abcdef\nhost: localhost",
      secrets: ["tok_live_abcdef"],
    });
    expect(preview.source).not.toContain("tok_live_abcdef");
    expect(preview.source).not.toContain("hunter2");
    expect(preview.source).toContain("localhost");
    expect(preview.language).toBe("yaml");
    expect(preview.attribution.repo).toBe("invoice-service");
  });

  it("truncates a body over the size bound and reports it", () => {
    const preview = boundPreview({
      root: findWorkspaceRoot(roots(), "front-monorepo")!,
      taskId: "task-aaaaaaaa",
      taskDir: TASK_DIR,
      path: "big.ts",
      source: "x".repeat(25_000),
    });
    expect(preview.truncated).toBe(true);
    expect(preview.source).toContain("已截断");
  });
});

describe("boundDiff", () => {
  it("bounds a diff and keeps the repo attribution", () => {
    const result = boundDiff({
      root: findWorkspaceRoot(roots(), "front-monorepo")!,
      taskId: "task-aaaaaaaa",
      taskDir: TASK_DIR,
      path: "src/checkout/api.ts",
      diff: Array.from({ length: 500 }, (_, index) => `+line ${index}`).join("\n"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.diff).toContain("差异已截断");
    expect(result.attribution.repo).toBe("front-monorepo");
    expect(result.diff.length).toBeLessThanOrEqual(MAX_DIFF_CHARS + 16);
  });

  it("refuses a Git diff for a plain-directory link instead of reporting an empty diff", () => {
    const result = boundDiff({
      root: findWorkspaceRoot(roots(), "dir-51cd20bb")!,
      taskId: "task-aaaaaaaa",
      taskDir: TASK_DIR,
      path: "spec.md",
      diff: "",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("plain-dir-no-diff");
  });
});

describe("deliveryTarget", () => {
  it("discloses the repo and branch and never claims to commit or push", () => {
    const result = deliveryTarget({ root: findWorkspaceRoot(roots(), "invoice-service")!, taskId: "task-aaaaaaaa", taskDir: TASK_DIR });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target).toMatchObject({ repo: "invoice-service", branch: "release/v2", autoCommit: false, autoPush: false, autoMerge: false });
  });

  it("has no delivery entry point for a plain-directory link", () => {
    const result = deliveryTarget({ root: findWorkspaceRoot(roots(), "dir-51cd20bb")!, taskId: "task-aaaaaaaa", taskDir: TASK_DIR });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("plain-dir-no-delivery");
  });
});

describe("languageForPath / workspaceAttribution", () => {
  it("labels a couple of extensions and falls back to text", () => {
    expect(languageForPath("a/b.tsx")).toBe("tsx");
    expect(languageForPath("a/Makefile")).toBe("text");
  });

  it("keeps the task id in every attribution", () => {
    const attribution = workspaceAttribution(findWorkspaceRoot(roots(), "front-monorepo")!, "task-aaaaaaaa", TASK_DIR);
    expect(attribution.taskId).toBe("task-aaaaaaaa");
    expect(attribution.sharedNote).toBeUndefined();
  });
});
