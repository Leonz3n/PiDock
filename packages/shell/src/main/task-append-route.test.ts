import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ nextId: 1 }));
vi.mock("electron", () => ({
  session: { fromPartition: (partition: string) => ({ partition }) },
  WebContentsView: class {
    private bounds = { x: 0, y: 0, width: 1, height: 1 };
    private visible = true;
    private url = "";
    webContents = {
      id: state.nextId++, mainFrame: { processId: 1, routingId: 1 },
      once: vi.fn(), on: vi.fn(), removeListener: vi.fn(), send: vi.fn(), setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn(async (url: string) => { this.url = url; }), loadFile: vi.fn(async (file: string) => { this.url = `file://${file}`; }),
      getURL: () => this.url,
      isDestroyed: () => false, close: vi.fn(),
    };
    setBounds(bounds: typeof this.bounds) { this.bounds = bounds; }
    getBounds() { return this.bounds; }
    setVisible(visible: boolean) { this.visible = visible; }
    getVisible() { return this.visible; }
  },
  BrowserWindow: class {
    id = state.nextId++;
    contentView = {
      children: [] as unknown[],
      addChildView: (view: unknown) => { this.contentView.children.push(view); },
      removeChildView: (view: unknown) => { this.contentView.children.splice(this.contentView.children.indexOf(view), 1); },
    };
    private listeners = new Map<string, () => void>();
    private bounds = { width: 1440, height: 900 };
    getContentBounds() { return this.bounds; }
    setContentBounds(bounds: typeof this.bounds) { this.bounds = bounds; this.listeners.get("resize")?.(); }
    on(event: string, listener: () => void) { this.listeners.set(event, listener); }
    once(event: string, listener: () => void) { this.listeners.set(event, listener); }
    isVisible() { return true; }
  },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn(), eventNames: () => [] },
  utilityProcess: { fork: vi.fn() },
}));

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ipcMain } from "electron";
import { validateHostTaskOp } from "../host/host-guards.js";
import { TaskWorkspaceHost, diskTaskStore } from "../host/task-host.js";
import { buildTaskDiskRecord, taskFilePath } from "../host/task-store.js";
import type { HostTaskOp, HostTaskResult } from "../rpc/protocol.js";
import { ProjectRegistry } from "./project-registry.js";
import { createTrustedWindow, registerIpc } from "./runtime.js";
import { createNodeAppendGit, ProjectTaskAppend } from "./task-append.js";
import { createNodePrepScanDeps, createPrepScanAuthority } from "./task-prep-scan.js";
import { TaskRootIndex } from "./task-root-index.js";

// Seam: the REAL `shell/appendTaskRepos` handler (the sandboxed renderer
// boundary) for [PiDock 03] (#6). Main owns the whole production append:
// repository paths come from the project registry, the fetch/pin and the
// worktree creation run in each repo's own checkout, and the conflict scan is
// derived by main. Real temporary git remotes/clones/worktrees plus the
// in-process `TaskWorkspaceHost` stand in for the utilityProcess Host; the
// Electron IPC transport itself is mocked (no `utilityProcess` round trip), so
// these are not Electron-IPC or native-UI evidence.

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: GIT_ENV }).trim();
}
function realRepo(home: string, name: string): { checkout: string; remote: string; commit: string } {
  const bare = join(home, `${name}.git`);
  const checkout = join(home, name);
  git(home, "init", "--bare", "-b", "main", bare);
  git(home, "clone", bare, checkout);
  git(checkout, "config", "user.email", "test@localhost");
  git(checkout, "config", "user.name", "Test");
  writeFileSync(join(checkout, "README.md"), `${name}\n`);
  git(checkout, "add", "README.md");
  git(checkout, "commit", "-m", `${name} baseline`);
  git(checkout, "push", "origin", "main");
  return { checkout, remote: bare, commit: git(checkout, "rev-parse", "HEAD") };
}

async function route() {
  const home = mkdtempSync(join(tmpdir(), "pidock-append-route-"));
  homes.push(home);
  const root = join(home, "tasks");
  const taskId = "task-abcdef12";
  const taskDir = join(root, taskId);
  mkdirSync(taskDir, { recursive: true });
  const branch = `task/${taskId}`;
  const first = realRepo(home, "first");
  const second = realRepo(home, "second");
  const userData = join(home, "userData");
  const projects = new ProjectRegistry(userData);
  const project = await projects.create({
    name: "项目",
    description: "",
    repositories: [
      { name: "first", path: first.checkout },
      { name: "second", path: second.checkout },
    ],
    directories: [],
  });
  const firstDir = `repo-${project.repositories[0]!.id.slice(0, 8)}`;
  diskTaskStore.writeTask(
    taskDir,
    buildTaskDiskRecord({
      taskId,
      name: "多仓任务",
      dirId: taskId,
      branch,
      root,
      taskDir,
      remoteBranch: "main",
      baseCommit: first.commit,
      repos: [firstDir],
      repoSources: [{ repoDir: firstDir, remote: "origin", remoteBranch: "main", baseCommit: first.commit }],
      now: "2026-09-24T10:00:00.000Z",
    }),
  );
  const roots = new TaskRootIndex(userData, root);
  await projects.claim(taskId, project.id, roots);
  git(first.checkout, "worktree", "add", "-b", branch, join(taskDir, firstDir), first.commit);
  const host = {
    async routeTaskOp(params: { taskId: string; op: HostTaskOp; payload: Record<string, unknown> }): Promise<HostTaskResult> {
      const instance = new TaskWorkspaceHost(params.taskId, taskDir, diskTaskStore);
      const guard = validateHostTaskOp(params.op, params.payload);
      if (!guard.ok) throw new Error(guard.error);
      if (params.op === "task/appendRepos") {
        const appended = instance.appendRepos(params.payload as never);
        return {
          workspaceId: "w",
          taskId: params.taskId,
          op: params.op,
          payload: { ...appended.record, plan: appended.plan, appended: appended.appended, skipped: appended.skipped },
        };
      }
      throw new Error(`unexpected op ${params.op}`);
    },
  };
  const append = new ProjectTaskAppend(host, createPrepScanAuthority(projects, roots), createNodePrepScanDeps(), createNodeAppendGit());
  const views = await createTrustedWindow("workspace-append-route", "production");
  registerIpc({} as never, views.registry, undefined, projects, roots, undefined, undefined, undefined, undefined, undefined, append);
  const handler = vi
    .mocked(ipcMain.handle)
    .mock.calls.findLast(([channel]) => channel === "shell/appendTaskRepos")?.[1] as unknown as (
    event: unknown,
    payload: unknown,
  ) => Promise<unknown>;
  return {
    home,
    taskId,
    taskDir,
    branch,
    first,
    second,
    firstDir,
    secondDir: `repo-${project.repositories[1]!.id.slice(0, 8)}`,
    secondId: project.repositories[1]!.id,
    shell: { sender: views.shellView.webContents, senderFrame: views.shellView.webContents.mainFrame },
    handler,
    recordText: () => readFileSync(taskFilePath(taskDir), "utf8"),
  };
}

/**
 * Every case below drives real git through `execFileSync` (bare remote, clone, commit) and then the
 * production handler's fetch, pin and worktree creation, so per-case cost is git process startup,
 * not compute. Measured on Windows 11 x64 / Node 24.21.0: the slowest of these 3 cases is 1.26s
 * running this file alone, 2.92s when the whole shell suite shares the pool, and 4.29s while one more
 * full suite runs alongside - that last number is why Vitest's 5000ms default produced the
 * load-dependent reds of #73. 30s is ~7x the worst case measured, and the same budget #63 (dbc997e)
 * set for project-task-creation.test.ts. No assertion is weakened, reordered or skipped, and a real
 * hang still fails.
 */
const GIT_CASE_TIMEOUT_MS = 30_000;

describe("shell/appendTaskRepos through the real main handler", { timeout: GIT_CASE_TIMEOUT_MS }, () => {
  it("creates the second repository's worktree at its pinned commit and records the source", async () => {
    const env = await route();
    const before = env.recordText();
    const result = (await env.handler(env.shell, {
      taskId: env.taskId,
      repositories: [{ sourceId: env.secondId, remote: "origin", remoteBranch: "main" }],
    })) as { ok: boolean; payload?: { appended: { repoDir: string; commit: string; worktree: string }[] }; error?: string };
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    const appended = result.payload!.appended;
    // The appended record spells the worktree as `<taskDir>/<repoDir>`
    // (`previewMixedTaskPaths`), so the fixture must not use `join` here.
    expect(appended).toEqual([
      { repoDir: env.secondDir, name: "second", remote: "origin", remoteBranch: "main", commit: env.second.commit, worktree: `${env.taskDir}/${env.secondDir}` },
    ]);
    expect(git(appended[0]!.worktree, "rev-parse", "HEAD")).toBe(env.second.commit);
    expect(git(appended[0]!.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(env.branch);
    expect(env.recordText()).not.toBe(before);
    expect(env.recordText()).toContain(env.secondDir);
  });

  it("refuses a sender outside the shell trust domain and any renderer-supplied checkout or scan", async () => {
    const env = await route();
    const before = env.recordText();
    const stranger = await env.handler(
      { sender: { id: 999, mainFrame: { processId: 1, routingId: 1 } }, senderFrame: { processId: 1, routingId: 1 } },
      { taskId: env.taskId, repositories: [{ sourceId: env.secondId, remote: "origin", remoteBranch: "main" }] },
    );
    expect(stranger).toMatchObject({ ok: false, error: expect.stringContaining("unknown-sender") });
    const withPath = await env.handler(env.shell, {
      taskId: env.taskId,
      repositories: [{ sourceId: env.secondId, remote: "origin", remoteBranch: "main", mainCheckoutDir: env.second.checkout }],
    });
    expect(withPath).toMatchObject({ ok: false, error: expect.stringContaining("invalid append input") });
    const withScan = await env.handler(env.shell, {
      taskId: env.taskId,
      repositories: [{ sourceId: env.secondId, remote: "origin", remoteBranch: "main" }],
      takenPaths: [],
      branchesInUse: [],
    });
    expect(withScan).toMatchObject({ ok: false, error: expect.stringContaining("invalid append operation") });
    expect(env.recordText()).toBe(before);
    expect(existsSync(join(env.taskDir, env.secondDir))).toBe(false);
  });

  it("reports a missing remote branch by name and leaves the record byte-identical", async () => {
    const env = await route();
    const before = env.recordText();
    git(env.home, `--git-dir=${env.second.remote}`, "update-ref", "-d", "refs/heads/main");
    const result = (await env.handler(env.shell, {
      taskId: env.taskId,
      repositories: [{ sourceId: env.secondId, remote: "origin", remoteBranch: "main" }],
    })) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^fetch-failed: 仓库 repo-[0-9a-f]{8}（second）获取 origin\/main 失败（远程分支不存在或已删除）/);
    expect(env.recordText()).toBe(before);
    expect(existsSync(join(env.taskDir, env.secondDir))).toBe(false);
  });
});
