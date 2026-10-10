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
import type { HostTaskOp } from "../rpc/protocol.js";
import { ProjectRegistry } from "./project-registry.js";
import { createTrustedWindow, registerIpc } from "./runtime.js";
import { createNodeAppendGit, ProjectTaskAppend } from "./task-append.js";
import { createNodePrepScanDeps, createPrepScanAuthority } from "./task-prep-scan.js";
import { TaskRootIndex } from "./task-root-index.js";

// Seam: #6 boundary B through the REAL `shell/taskOp` handler (the sandboxed
// renderer boundary). Main must derive the conflict scan the Host requires
// from the resolved task folder and each target repo's own source checkout,
// ignore what the page sent, and fail closed by name when the scan cannot
// run. Real temporary git remotes/clones/worktrees plus the in-process
// `TaskWorkspaceHost` stand in for the utilityProcess Host; the Electron IPC
// transport itself is mocked (no `utilityProcess` round trip), so these are
// not Electron-IPC or native-UI evidence.

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: GIT_ENV }).trim();
}

/** A real bare remote + a clone of it with `main` pushed. */
function realRepo(home: string, name: string): { checkout: string; commit: string } {
  const bare = join(home, `${name}.git`);
  const checkout = join(home, name);
  git(home, "init", "--bare", "-b", "main", bare);
  git(home, "clone", bare, checkout);
  git(checkout, "config", "user.email", "test@localhost");
  git(checkout, "config", "user.name", "Test");
  writeFileSync(join(checkout, "README.md"), `${name} baseline\n`);
  git(checkout, "add", "README.md");
  git(checkout, "commit", "-m", `${name} baseline`);
  git(checkout, "push", "origin", "main");
  return { checkout, commit: git(checkout, "rev-parse", "HEAD") };
}

type RepoKey = "frontend" | "invoice" | "shipment";
const REPO_KEYS = ["frontend", "invoice", "shipment"] as const;

interface Route {
  home: string;
  taskId: string;
  taskDir: string;
  branch: string;
  sources: Record<RepoKey, { checkout: string; commit: string }>;
  /** In-task folder names, spelled the way the production creation flow does. */
  repos: Record<RepoKey, string>;
  forwarded: { op: string; payload: Record<string, unknown> }[];
  invoke: (op: string, payload?: Record<string, unknown>, taskId?: string) => Promise<unknown>;
  recordText: () => string;
}

/**
 * Wire the production renderer route for one task: a real task folder + record
 * under a real root index, a real project association (the main-owned source
 * of each repo's checkout), and the REAL `shell/taskOp` handler whose task
 * registry delegates to the in-process `TaskWorkspaceHost`.
 */
async function productionRoute(options: {
  recorded: readonly RepoKey[];
  created?: readonly RepoKey[];
  /** Recorded repo whose project checkout is not a git repository. */
  brokenCheckoutFor?: RepoKey;
  /** Runs in the Host delegate, i.e. AFTER main's privileged scan. */
  beforeHost?: () => void;
  /** Register `shell/taskOp` with NO resume executor in main. */
  noExecutor?: boolean;
}): Promise<Route> {
  const home = mkdtempSync(join(tmpdir(), "pidock-prep-route-"));
  homes.push(home);
  const root = join(home, "tasks");
  const taskId = "task-abcdef12";
  const taskDir = join(root, taskId);
  mkdirSync(taskDir, { recursive: true });
  const branch = `task/${taskId}`;
  const sources: Record<RepoKey, { checkout: string; commit: string }> = {
    frontend: realRepo(home, "frontend"),
    invoice: realRepo(home, "invoice"),
    shipment: realRepo(home, "shipment"),
  };
  const notARepo = join(home, "not-a-repo");
  mkdirSync(notARepo);
  const userData = join(home, "userData");
  const projects = new ProjectRegistry(userData);
  const project = await projects.create({
    name: "项目",
    description: "",
    repositories: REPO_KEYS.map((key) => ({
      name: key,
      path: key === options.brokenCheckoutFor ? notARepo : sources[key].checkout,
    })),
    directories: [],
  });
  const repos = Object.fromEntries(
    REPO_KEYS.map((key, index) => [key, `repo-${project.repositories[index]!.id.slice(0, 8)}`]),
  ) as Record<RepoKey, string>;
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
      baseCommit: sources.frontend.commit,
      repos: options.recorded.map((key) => repos[key]),
      repoSources: options.recorded.map((key) => ({
        repoDir: repos[key],
        remote: "origin",
        remoteBranch: "main",
        baseCommit: sources[key].commit,
      })),
      now: "2026-09-24T10:00:00.000Z",
    }),
  );
  const roots = new TaskRootIndex(userData, root);
  await projects.claim(taskId, project.id, roots);
  for (const key of options.created ?? []) {
    git(sources[key].checkout, "worktree", "add", "-b", branch, join(taskDir, repos[key]), sources[key].commit);
  }

  const host = new TaskWorkspaceHost(taskId, taskDir, diskTaskStore, () => "2026-09-24T11:00:00.000Z");
  const forwarded: { op: string; payload: Record<string, unknown> }[] = [];
  const routeTaskOp = vi.fn(async (params: { taskId: string; op: string; payload?: Record<string, unknown> }) => {
    const payload = params.payload ?? {};
    forwarded.push({ op: params.op, payload });
    // The Host RPC guard runs before the op, exactly as `host.ts` does.
    const guard = validateHostTaskOp(params.op as HostTaskOp, payload);
    if (!guard.ok) throw new Error(guard.error);
    options.beforeHost?.();
    if (params.op === "task/resumeAppend") {
      const resumed = host.resumeAppend(payload as never);
      return {
        workspaceId: "workspace-prep-route",
        taskId: params.taskId,
        op: params.op,
        payload: {
          outcomes: resumed.outcomes, created: resumed.created, pending: resumed.pending,
          failed: resumed.failed, retry: resumed.retry, hold: resumed.hold,
          resumed: resumed.resumed, plan: resumed.plan,
        },
      };
    }
    if (params.op === "task/prepareStatus") {
      return {
        workspaceId: "workspace-prep-route",
        taskId: params.taskId,
        op: params.op,
        payload: host.prepareStatus() as unknown as Record<string, unknown>,
      };
    }
    throw new Error(`unexpected op ${params.op}`);
  });
  const append = new ProjectTaskAppend(
    { routeTaskOp: routeTaskOp as never },
    createPrepScanAuthority(projects, roots),
    createNodePrepScanDeps(),
    createNodeAppendGit(),
  );
  const views = await createTrustedWindow("workspace-prep-route", "production");
  registerIpc({} as never, views.registry, { routeTaskOp } as never, projects, roots, undefined, undefined, undefined, undefined, undefined, options.noExecutor ? undefined : append);
  const handler = vi
    .mocked(ipcMain.handle)
    .mock.calls.findLast(([channel]) => channel === "shell/taskOp")?.[1] as unknown as (
    event: unknown,
    payload: unknown,
  ) => Promise<unknown>;
  const shell = { sender: views.shellView.webContents, senderFrame: views.shellView.webContents.mainFrame };
  return {
    home,
    taskId,
    taskDir,
    branch,
    sources,
    repos,
    forwarded,
    invoke: (op, payload = {}, id = taskId) => handler(shell, { taskId: id, op, payload }),
    recordText: () => readFileSync(taskFilePath(taskDir), "utf8"),
  };
}

function scanOf(route: Route): Record<string, unknown> {
  return route.forwarded.filter((entry) => entry.op === "task/resumeAppend").at(-1)!.payload;
}

describe("#6 privileged prep scan through the real shell/taskOp handler", () => {
  it("resumes the unfinished repo with no caller-supplied scan and no self-refusal", async () => {
    const route = await productionRoute({ recorded: ["frontend", "invoice"], created: ["frontend"] });
    const result = await route.invoke("task/resumeAppend", {
      // Everything here is a page-supplied lie: an empty scan and a forged
      // checkout. Main must overwrite all of it.
      takenPaths: [],
      branchesInUse: [],
      mainCheckouts: { forged: "/tmp/forged" },
    });
    const resumed = (result as { payload: Record<string, unknown> }).payload;
    // Main EXECUTED the resume plan: the unfinished repo is created and the
    // freshly re-read status reflects it (never a "planned, not executed" view).
    expect(resumed["created"]).toEqual(expect.arrayContaining([route.repos.frontend, route.repos.invoice]));
    expect(resumed["retry"]).toEqual([]);
    expect(resumed["resumed"]).toBe(true);

    const scan = scanOf(route);
    expect([...(scan["takenPaths"] as string[])].sort()).toEqual(
      [`${route.taskDir}/task.json`, `${route.taskDir}/${route.repos.frontend}`].sort(),
    );
    // The task's OWN already-created worktree shares `task/<dirId>`, and git
    // really lists it — the scan's ownership exclusion is what keeps it out,
    // so the partially-created task does not refuse its own branch.
    expect(scan["branchesInUse"]).toEqual(["main"]);
    expect(scan["branchesInUse"]).not.toContain(route.branch);
    expect(git(route.sources.frontend.checkout, "worktree", "list", "--porcelain")).toContain(route.branch);
    expect(scan["mainCheckouts"]).toEqual({
      [route.repos.frontend]: route.sources.frontend.checkout,
      [route.repos.invoice]: route.sources.invoice.checkout,
    });

    // The unfinished repo was REALLY created — at its pinned commit, on the
    // task branch, in its own source checkout.
    const invoiceWorktree = join(route.taskDir, route.repos.invoice);
    expect(git(invoiceWorktree, "rev-parse", "HEAD")).toBe(route.sources.invoice.commit);
    expect(git(invoiceWorktree, "symbolic-ref", "--quiet", "HEAD")).toBe(`refs/heads/${route.branch}`);
    // The already-created worktree is untouched.
    expect(git(join(route.taskDir, route.repos.frontend), "rev-parse", "HEAD")).toBe(route.sources.frontend.commit);
  });

  it("refuses a foreign worktree on the task branch whether the page forges an empty scan or omits it", async () => {
    const route = await productionRoute({ recorded: ["frontend", "invoice"], created: ["frontend"] });
    // A foreign leftover worktree in the invoice source checkout reuses the
    // task branch OUTSIDE this task's folder: genuinely foreign usage.
    git(route.sources.invoice.checkout, "worktree", "add", "-b", route.branch, join(route.home, "foreign"), route.sources.invoice.commit);
    const before = route.recordText();

    for (const payload of [{}, { takenPaths: [], branchesInUse: [] }]) {
      await expect(route.invoke("task/resumeAppend", payload)).rejects.toThrow("branch-in-use");
      // The derived scan — not the forged one — is what the Host saw.
      expect(scanOf(route)["branchesInUse"]).toEqual(["main", route.branch]);
    }
    expect(route.recordText()).toBe(before);
    expect(existsSync(join(route.taskDir, route.repos.invoice))).toBe(false);
  });

  it("refuses a path the scan saw as occupied, without taking it over", async () => {
    let leftover = "";
    const route = await productionRoute({
      recorded: ["frontend", "invoice"],
      // Models the real race the scan protects against: the occupied path is
      // gone by the time the Host plans (removed between scan and plan).
      beforeHost: () => rmSync(leftover, { recursive: true, force: true }),
    });
    leftover = join(route.taskDir, route.repos.invoice);
    mkdirSync(leftover);
    writeFileSync(join(leftover, "keep.txt"), "unknown leftover\n");
    const before = route.recordText();

    await expect(route.invoke("task/resumeAppend", {})).rejects.toThrow("path-taken");
    expect(route.recordText()).toBe(before);
    expect(existsSync(join(route.taskDir, route.repos.frontend))).toBe(false);
    expect(existsSync(join(route.taskDir, route.repos.invoice))).toBe(false);
  });

  it("refuses the legacy task/appendRepos op on shell/taskOp and never reaches the Host", async () => {
    const route = await productionRoute({ recorded: ["frontend"], created: ["frontend"] });
    const before = route.recordText();
    const result = (await route.invoke("task/appendRepos", {
      repoSelections: [
        // The page-supplied checkout must not even be looked at: the op is
        // refused before the Host (no executor in main on this legacy route).
        { repoDir: route.repos.invoice, remote: "origin", remoteBranch: "main", mainCheckoutDir: "/tmp/forged" },
      ],
      fetchedCommits: { [route.repos.invoice]: route.sources.invoice.commit },
      takenPaths: [],
      branchesInUse: [],
    })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("shell/appendTaskRepos");
    // The Host was never asked and nothing changed on disk: a page can no
    // longer persist a caller-supplied baseline with no executor in main.
    expect(route.forwarded).toEqual([]);
    expect(route.recordText()).toBe(before);
    expect(existsSync(join(route.taskDir, route.repos.invoice))).toBe(false);
  });

  it("refuses a resume with no executor in main before the Host writes anything", async () => {
    const route = await productionRoute({ recorded: ["frontend", "invoice"], created: ["frontend"], noExecutor: true });
    const before = route.recordText();
    const result = (await route.invoke("task/resumeAppend", {})) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("真实任务准备恢复尚未接入");
    // The check runs BEFORE routing: the Host never wrote a record update that
    // main has no executor to complete.
    expect(route.forwarded).toEqual([]);
    expect(route.recordText()).toBe(before);
    expect(existsSync(join(route.taskDir, route.repos.invoice))).toBe(false);
  });

  it("refuses by name and writes nothing when the scan cannot be produced", async () => {
    const route = await productionRoute({ recorded: ["frontend"], brokenCheckoutFor: "frontend" });
    const before = route.recordText();

    const failed = (await route.invoke("task/resumeAppend", {})) as { ok: boolean; error: string };
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("task-scan-unavailable");
    // Never a `[]` fallback: the Host was never asked and nothing changed.
    expect(route.forwarded).toEqual([]);
    expect(route.recordText()).toBe(before);
    expect(existsSync(join(route.taskDir, route.repos.frontend))).toBe(false);

    const unknown = (await route.invoke("task/resumeAppend", {}, "task-00000000")) as { ok: boolean; error: string };
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain("task-scan-unavailable");
    expect(route.forwarded).toEqual([]);
    expect(route.recordText()).toBe(before);
  });

  it("refuses by name and writes nothing when the task record is present but unparseable", async () => {
    const route = await productionRoute({ recorded: ["frontend", "invoice"], created: ["frontend"] });
    // Corrupt the on-disk record AFTER the route is wired, so a real read/parse
    // failure (not a missing record) is what main must turn into the named
    // `task-scan-unavailable` refusal, never a leaked parse error.
    const recordPath = join(route.taskDir, "task.json");
    writeFileSync(recordPath, "{ not valid json\n");
    const before = route.recordText();

    const failed = (await route.invoke("task/resumeAppend", {})) as { ok: boolean; error: string };
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("task-scan-unavailable");
    // Never a `[]` fallback: the Host was never asked and nothing changed.
    expect(route.forwarded).toEqual([]);
    expect(route.recordText()).toBe(before);
    expect(existsSync(join(route.taskDir, route.repos.invoice))).toBe(false);
  });
});
