/**
 * Real-filesystem evidence for [PiDock 14] (#17) link cleanup: removing an
 * in-task link must delete only the directory entry, never the recorded source
 * directory or its contents.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createLifecycleResources } from "./lifecycle-resources.js";
import type { TaskWorkspaceHost } from "./task-host.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function resources() {
  return createLifecycleResources({
    host: {} as TaskWorkspaceHost,
    services: () => null,
    terminals: () => null,
    sessionIds: () => [],
  });
}

describe("[T12] #147 original checkout paths", () => {
  const fakeHost = (record: Record<string, unknown>) => ({
    taskDir: "/tmp/pidock/tasks/task-abcdef12",
    store: { readTask: () => record },
  }) as unknown as TaskWorkspaceHost;

  it("names the source repository, never the task root that contains every worktree", () => {
    const lifecycle = createLifecycleResources({
      host: fakeHost({
        taskId: "task-abcdef12",
        taskDir: "/tmp/pidock/tasks/task-abcdef12",
        // The production task-root layout: `root` is the PARENT of task dirs.
        root: "/tmp/pidock/tasks",
        branch: "ticket/task-abcdef12-t18",
        baseCommit: "eac51ee4",
        repos: ["repo-c1249264"],
        repoSources: [{ repoDir: "repo-c1249264", remote: "origin", remoteBranch: "main", baseCommit: "eac51ee4",
          sourcePath: "/tmp/pidock/sources/alpha-service", sourceRealPath: "/private/tmp/pidock/sources/alpha-service" }],
      }),
      services: () => null,
      terminals: () => null,
      sessionIds: () => [],
    });
    const originals = lifecycle.originalCheckoutPaths();
    expect(originals).toEqual(["/private/tmp/pidock/sources/alpha-service", "/tmp/pidock/sources/alpha-service"]);
    // The managed worktree is NOT inside an original checkout, so an explicit
    // clean scope can really remove it (#147) — `record.root` would have made
    // this an "inside the original checkout" refusal.
    const worktree = "/tmp/pidock/tasks/task-abcdef12/repo-c1249264";
    expect(originals.some((original) => worktree === original || worktree.startsWith(`${original}/`))).toBe(false);
  });

  it("keeps the old fallback for records written before the source binding existed", () => {
    const lifecycle = createLifecycleResources({
      host: fakeHost({ taskId: "task-abcdef12", taskDir: "/tmp/pidock/tasks/task-abcdef12", root: "/tmp/pidock/sources/legacy", branch: "main", baseCommit: "eac51ee4", repos: ["repo-c1249264"] }),
      services: () => null,
      terminals: () => null,
      sessionIds: () => [],
    });
    expect(lifecycle.originalCheckoutPaths()).toEqual(["/tmp/pidock/sources/legacy"]);
  });
});

describe("[T12] #147 managed worktree removal on the production task-root layout", () => {
  it("removes the managed worktree from the repository that owns it and keeps the source checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "pidock-worktree-cleanup-"));
    roots.push(root);
    const source = join(root, "sources", "alpha-service");
    const taskDir = join(root, "tasks", "task-abcdef12");
    const worktree = join(taskDir, "repo-c1249264");
    mkdirSync(source, { recursive: true });
    mkdirSync(taskDir, { recursive: true });
    const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    execFileSync("git", ["init", "-b", "main", source], { stdio: "ignore", cwd: root });
    git(source, ["config", "user.email", "evidence@pidock.local"]);
    git(source, ["config", "user.name", "PiDock Evidence"]);
    writeFileSync(join(source, "README.md"), "source checkout\n");
    git(source, ["add", "."]);
    git(source, ["commit", "-m", "base"]);
    const base = git(source, ["rev-parse", "HEAD"]);
    git(source, ["worktree", "add", "-b", "ticket/task-abcdef12-t18", worktree, base]);

    const record = {
      taskId: "task-abcdef12", taskDir,
      // The production layout: `root` is the PARENT of every task directory.
      root: join(root, "tasks"),
      branch: "ticket/task-abcdef12-t18", branchKind: "task-worktree", remoteBranch: "main", baseCommit: base,
      repos: ["repo-c1249264"],
      repoSources: [{ repoDir: "repo-c1249264", remote: "origin", remoteBranch: "main", baseCommit: base,
        sourcePath: source, sourceRealPath: realpathSync(source) }],
      workspaceMode: "worktree",
    };
    const lifecycle = createLifecycleResources({
      host: { taskDir, store: { readTask: () => record } } as unknown as TaskWorkspaceHost,
      services: () => null,
      terminals: () => null,
      sessionIds: () => [],
    });
    expect(existsSync(join(worktree, "README.md"))).toBe(true);
    const removal = lifecycle.removeManagedWorktree(worktree);
    expect(removal.ok).toBe(true);
    // The worktree is really gone; the source checkout, its branch and its files stay.
    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(join(source, "README.md"))).toBe(true);
    expect(git(source, ["rev-parse", "HEAD"])).toBe(base);
    expect(git(source, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
    expect(git(source, ["worktree", "list", "--porcelain"])).not.toContain(worktree);
    expect(git(source, ["rev-parse", "--verify", "ticket/task-abcdef12-t18"])).toBe(base);
  });

  it("refuses a path that is not one of this task's registered worktrees", () => {
    const root = mkdtempSync(join(tmpdir(), "pidock-worktree-refuse-"));
    roots.push(root);
    const taskDir = join(root, "tasks", "task-abcdef12");
    mkdirSync(taskDir, { recursive: true });
    const elsewhere = join(root, "not-a-task-worktree");
    mkdirSync(elsewhere, { recursive: true });
    const lifecycle = createLifecycleResources({
      host: { taskDir, store: { readTask: () => ({ taskId: "task-abcdef12", taskDir, root: join(root, "tasks"), branch: "main", baseCommit: "eac51ee4", repos: [] }) } } as unknown as TaskWorkspaceHost,
      services: () => null,
      terminals: () => null,
      sessionIds: () => [],
    });
    expect(lifecycle.removeManagedWorktree(elsewhere)).toMatchObject({ ok: false, reason: expect.stringContaining("不在本任务登记的工作副本中") });
    expect(existsSync(elsewhere)).toBe(true);
  });
});

describe("createLifecycleResources link removal", () => {
  it("removes only the in-task symlink and preserves the source directory contents", () => {
    const root = mkdtempSync(join(tmpdir(), "pidock-link-cleanup-"));
    roots.push(root);
    const source = join(root, "invoice-docs");
    mkdirSync(source);
    writeFileSync(join(source, "spec.md"), "original content");
    const taskDir = join(root, "task-abcdef12");
    mkdirSync(taskDir);
    const link = join(taskDir, "dir-invoice-docs");
    // win32: a plain directory symlink needs SeCreateSymbolicLinkPrivilege; a junction is the directory link this platform can create without it (#57).
    symlinkSync(source, link, process.platform === "win32" ? "junction" : "dir");

    const lifecycle = resources();
    expect(lifecycle.observeInTaskPath(link)).toMatchObject({ isSymlink: true, isDirectory: false, currentTarget: source });
    lifecycle.removeInTaskPath(link);

    expect(existsSync(link)).toBe(false);
    expect(readFileSync(join(source, "spec.md"), "utf8")).toBe("original content");
  });

  it("reports a link retargeted outside the task and still removes only the entry, preserving both targets", () => {
    const root = mkdtempSync(join(tmpdir(), "pidock-link-cleanup-"));
    roots.push(root);
    const original = join(root, "original-docs");
    mkdirSync(original);
    writeFileSync(join(original, "spec.md"), "original content");
    const elsewhere = join(root, "external-docs");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "notes.md"), "external content");
    const taskDir = join(root, "task-abcdef12");
    mkdirSync(taskDir);
    const link = join(taskDir, "dir-docs");
    symlinkSync(original, link, process.platform === "win32" ? "junction" : "dir");
    // The user (or another tool) points the link at a different directory.
    rmSync(link);
    symlinkSync(elsewhere, link, process.platform === "win32" ? "junction" : "dir");

    const lifecycle = resources();
    expect(lifecycle.observeInTaskPath(link)).toMatchObject({ isSymlink: true, currentTarget: elsewhere });
    lifecycle.removeInTaskPath(link);

    expect(existsSync(link)).toBe(false);
    expect(readFileSync(join(original, "spec.md"), "utf8")).toBe("original content");
    expect(readFileSync(join(elsewhere, "notes.md"), "utf8")).toBe("external content");
  });

  it("removes the identity-confirmed link and keeps going past a replaced entry without deleting it", () => {
    const root = mkdtempSync(join(tmpdir(), "pidock-link-cleanup-"));
    roots.push(root);
    const source = join(root, "invoice-docs");
    mkdirSync(source);
    writeFileSync(join(source, "spec.md"), "original content");
    const taskDir = join(root, "task-abcdef12");
    mkdirSync(taskDir);
    const link = join(taskDir, "dir-invoice-docs");
    symlinkSync(source, link, process.platform === "win32" ? "junction" : "dir");
    // The link was replaced by a real directory that is NOT this task's link:
    // `verifyLinkRemoval` refuses it, and the removal call itself must never
    // recurse into it.
    const replaced = join(taskDir, "dir-replaced");
    mkdirSync(replaced);
    writeFileSync(join(replaced, "keep.md"), "must survive");

    const lifecycle = resources();
    expect(lifecycle.observeInTaskPath(replaced)).toMatchObject({ isSymlink: false, isDirectory: true });
    expect(() => lifecycle.removeInTaskPath(replaced)).toThrow();
    lifecycle.removeInTaskPath(link);

    expect(existsSync(link)).toBe(false);
    expect(readFileSync(join(replaced, "keep.md"), "utf8")).toBe("must survive");
    expect(readFileSync(join(source, "spec.md"), "utf8")).toBe("original content");
  });

  it("removes a dangling or self-referential link without resolving through it", () => {
    const root = mkdtempSync(join(tmpdir(), "pidock-link-cleanup-"));
    roots.push(root);
    const taskDir = join(root, "task-abcdef12");
    mkdirSync(taskDir);
    const dangling = join(taskDir, "dir-missing");
    symlinkSync(join(root, "missing-source"), dangling, process.platform === "win32" ? "junction" : "dir");
    const loop = join(taskDir, "dir-loop");
    symlinkSync(loop, loop, process.platform === "win32" ? "junction" : "dir");

    const lifecycle = resources();
    expect(lifecycle.observeInTaskPath(dangling)).toMatchObject({ isSymlink: true, isDirectory: false });
    lifecycle.removeInTaskPath(dangling);
    expect(existsSync(dangling)).toBe(false);

    expect(lifecycle.observeInTaskPath(loop)).toMatchObject({ isSymlink: true, isDirectory: false });
    lifecycle.removeInTaskPath(loop);
    expect(existsSync(loop)).toBe(false);
  });
});

// [Pencil T13] #148: cleanup's "undelivered changes" answer is real git, never
// a success ledger. A commit no remote-tracking ref contains is undelivered; a
// commit that is reachable from a remote ref is not.
describe("cleanup delivery state from real git", () => {
  function git(cwd: string, args: string[]): string {
    return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args], { cwd, encoding: "utf8" });
  }

  function withRepo() {
    const root = mkdtempSync(join(tmpdir(), "pidock-cleanup-delivery-"));
    roots.push(root);
    const taskDir = join(root, "task-148");
    const repoDir = join(taskDir, "repo-a");
    mkdirSync(repoDir, { recursive: true });
    git(repoDir, ["init", "-q", "-b", "ticket/148"]);
    writeFileSync(join(repoDir, "a.txt"), "one");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-q", "-m", "one"]);
    const lifecycle = createLifecycleResources({
      host: {
        taskDir,
        store: { readTask: () => ({ taskId: "148", name: "T", taskDir, branch: "ticket/148", repos: ["repo-a"], baseCommit: "abc1234" }) },
      } as unknown as TaskWorkspaceHost,
      services: () => null,
      terminals: () => null,
      sessionIds: () => [],
    });
    return { repoDir, lifecycle };
  }

  it("reads an unpushed commit and a dirty tree from the checkout itself", () => {
    const { repoDir, lifecycle } = withRepo();
    expect(lifecycle.delivery()).toEqual({ uncommitted: false, undelivered: true });
    // A remote-tracking ref that contains the commit means it was delivered.
    git(repoDir, ["update-ref", "refs/remotes/origin/ticket/148", "HEAD"]);
    expect(lifecycle.delivery()).toEqual({ uncommitted: false, undelivered: false });
    writeFileSync(join(repoDir, "a.txt"), "uncommitted");
    expect(lifecycle.delivery()).toEqual({ uncommitted: true, undelivered: false });
  });
});
