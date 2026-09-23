import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  BrowserWindow,
  ipcMain,
  utilityProcess,
  WebContentsView,
} from "electron";
import type {
  BrowserWindowConstructorOptions,
  Rectangle,
  UtilityProcess,
  WebPreferences,
} from "electron";
import { isAllowedInvokeChannel } from "../preload/allowlist.js";
import { HostClient } from "../rpc/host-client.js";
import { buildHostEnv, validateHostTaskOp } from "../host/host-guards.js";
import {
  isAbsoluteTaskRoot,
  isTaskDirId,
  normalizeTaskPath,
  previewTaskPaths,
  resolveTaskRoot,
} from "./task-provision.js";
import { readTaskRecordOnDisk } from "../host/task-store.js";
import { defaultTasksRoot } from "./task-resolver.js";
import type { BrowserPerformResult, BrowserRequestParams, HostTaskOp, HostTaskResult, TaskOpOrigin } from "../rpc/protocol.js";
import { isHostTaskOp } from "../rpc/protocol.js";
import { TaskBrowser } from "./task-browser.js";
import { TaskBrowserSurface } from "./task-browser-surface.js";
import { createBrowserGatewayRegistry } from "./browser-gateway.js";
import { deriveNavigationAllowlist, type NavigationAllowlist } from "./browser-rules.js";
import {
  TrustDomainRegistry,
  TrustDomainViolation,
  validateShellInvocationPayload,
} from "./trust-domain.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_WORKSPACE_ID = "s1-default-workspace";
export const TASK_ID = "s2-task";
export const PAGE_ID = "s2-page";

const SHELL_VIEW_ID = "shell-view";
const TASK_VIEW_ID = "task-view";

const SAFE_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
} satisfies WebPreferences;

const SHELL_PRELOAD = path.join(here, "..", "preload", "preload.cjs");

export const SHELL_WEB_PREFERENCES = {
  ...SAFE_WEB_PREFERENCES,
  preload: SHELL_PRELOAD,
} satisfies WebPreferences;

export const TASK_WEB_PREFERENCES = {
  ...SAFE_WEB_PREFERENCES,
} satisfies WebPreferences;

const WINDOW_OPTIONS: BrowserWindowConstructorOptions = {
  width: 1024,
  height: 768,
  show: false,
  webPreferences: SAFE_WEB_PREFERENCES,
};

export interface WebPreferencesEvidence {
  sandbox: boolean;
  contextIsolation: boolean;
  nodeIntegration: boolean;
  preload: string | null;
}

export interface TrustedWindowViews {
  window: BrowserWindow;
  shellView: WebContentsView;
  taskView: WebContentsView;
  taskBrowser: TaskBrowser;
  registry: TrustDomainRegistry;
}

export interface ViewPlacementEvidence {
  viewId: string;
  domain: "shell" | "task";
  webContentsId: number;
  bounds: Rectangle;
  visible: boolean;
  attached: boolean;
}

export interface TrustedWindowEvidence {
  browserWindowId: number;
  visible: boolean;
  childCount: number;
  distinctWebContents: boolean;
  shell: ViewPlacementEvidence;
  task: ViewPlacementEvidence;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function webPreferencesEvidence(
  preferences: WebPreferences,
  requirePreload: boolean,
): WebPreferencesEvidence {
  const preload =
    typeof preferences.preload === "string" ? preferences.preload : null;
  if (requirePreload && preload === null) {
    throw new Error("shell view preload configuration is missing");
  }
  if (!requirePreload && preload !== null) {
    throw new Error(`task view must not configure a preload: ${preload}`);
  }
  return {
    sandbox: preferences.sandbox === true,
    contextIsolation: preferences.contextIsolation === true,
    nodeIntegration: preferences.nodeIntegration === true,
    preload,
  };
}

export function assertSafeWebPreferences(
  evidence: WebPreferencesEvidence,
  label: string,
): void {
  if (
    evidence.sandbox !== true ||
    evidence.contextIsolation !== true ||
    evidence.nodeIntegration !== false
  ) {
    throw new Error(
      `${label} sandbox contract violated: ${JSON.stringify(evidence)}`,
    );
  }
}

export function versionsTriple(hostNode?: string): Record<string, string> {
  return {
    electron: process.versions["electron"] ?? "unknown",
    mainNode: process.versions["node"] ?? "unknown",
    utilityNode: hostNode ?? "unknown",
  };
}

export async function createHost(
  workspaceId: string,
  logExit = true,
  task?: { taskId: string; taskDir: string },
): Promise<{ client: HostClient; child: UtilityProcess }> {
  const entry = path.join(here, "..", "host", "host.js");
  const child = utilityProcess.fork(entry, [], {
    serviceName: task ? `pidock-node-host-${task.taskId}` : "pidock-node-host",
    env: buildHostEnv(process.env, workspaceId, task),
    stdio: "pipe",
  });
  const client = new HostClient(child);
  if (logExit) {
    child.on("exit", (code) => console.log(`[main] host exit code=${code}`));
  }
  child.stderr?.on("data", (chunk) =>
    process.stderr.write(`[host:stderr] ${chunk}`),
  );
  return { client, child };
}

function taskBounds(width: number, height: number): Rectangle {
  const shellWidth = Math.min(380, Math.max(280, Math.floor(width * 0.36)));
  return {
    x: shellWidth,
    y: 0,
    width: Math.max(1, width - shellWidth),
    height,
  };
}

function layoutTrustedViews(
  window: BrowserWindow,
  shellView: WebContentsView,
  taskBrowser: TaskBrowser,
): void {
  const { width, height } = window.getContentBounds();
  const bounds = taskBounds(width, height);
  shellView.setBounds({ x: 0, y: 0, width: bounds.x, height });
  shellView.setVisible(true);
  taskBrowser.setBounds(bounds);
}

export async function createTrustedWindow(
  workspaceId: string,
): Promise<TrustedWindowViews> {
  const window = new BrowserWindow({ ...WINDOW_OPTIONS, show: true });
  const shellView = new WebContentsView({
    webPreferences: SHELL_WEB_PREFERENCES,
  });
  const registry = new TrustDomainRegistry();
  registry.registerShell({
    webContentsId: shellView.webContents.id,
    viewId: SHELL_VIEW_ID,
    workspaceId,
  });

  window.contentView.addChildView(shellView);
  const contentBounds = window.getContentBounds();
  const bounds = taskBounds(contentBounds.width, contentBounds.height);
  shellView.setBounds({ x: 0, y: 0, width: bounds.x, height: bounds.height });
  shellView.setVisible(true);

  const taskBrowser = new TaskBrowser({
    window,
    workspaceId,
    taskId: TASK_ID,
    bounds,
    registry,
  });
  const taskTab = await taskBrowser.openTab("about:blank", PAGE_ID);
  if (taskTab.taskId !== TASK_ID) {
    throw new Error(`unexpected task binding for ${TASK_ID}`);
  }

  window.on("resize", () => layoutTrustedViews(window, shellView, taskBrowser));
  window.on("closed", () => registry.unregister(shellView.webContents.id));

  return {
    window,
    shellView,
    taskView: taskTab.view,
    taskBrowser,
    registry,
  };
}

async function loadView(
  view: WebContentsView,
  overrideUrl: string | undefined,
  fileName: string,
): Promise<string> {
  if (overrideUrl) {
    await view.webContents.loadURL(overrideUrl);
    return overrideUrl;
  }
  const filePath = path.join(here, "..", "renderer", fileName);
  await view.webContents.loadFile(filePath);
  return pathToFileURL(filePath).href;
}

export async function loadTrustedViews(
  views: TrustedWindowViews,
): Promise<{ shellUrl: string; taskUrl: string }> {
  const [shellUrl, taskUrl] = await Promise.all([
    loadView(
      views.shellView,
      process.env["PIDOCK_RENDERER_URL"],
      "index.html",
    ),
    loadView(
      views.taskView,
      process.env["PIDOCK_TASK_URL"],
      "task.html",
    ),
  ]);
  return { shellUrl, taskUrl };
}

function trustFailureEnvelope(
  error: unknown,
): { ok: false; error: string } {
  if (error instanceof TrustDomainViolation) {
    return { ok: false, error: `${error.code}: ${error.message}` };
  }
  throw error;
}

/**
 * Per-task Host registry for main ([PiDock 02] #5, S3a slice).
 *
 * One utilityProcess serves one task folder: the first `shell/taskOp` for
 * a task forks a bound Host (`buildHostEnv(..., { taskId, taskDir })`) and
 * later ops for the same task reuse it; ops for another task fork their own
 * Host. Task ids are globally unique under the single machine tasks root,
 * so at most one folder can win per id; the registry is still keyed by
 * `taskDir` internally and revalidates the resolved dir on every reuse: a
 * task whose record moved/changed since the fork is rejected with
 * `task-moved` instead of silently reusing a stale Host. The task dir is
 * resolved from the task record on first spawn (production injects the
 * disk-backed resolver from `task-resolver.ts`) and never taken from a
 * renderer payload beyond the task id selector.
 *
 * S2 note: `registerIpc` currently takes one workspace-only client (used by
 * `getVersions`/`hostPing` smoke paths). Per-task `shell/taskOp` routing
 * through this registry lands with the caller below; until that caller
 * migrates, per-task Hosts are reachable via `routeTaskOp` (covered below)
 * and workspace-only call sites stay limited to ping/versions.
 */
export interface PerTaskHostEntry {
  taskId: string;
  taskDir: string;
  client: HostClient;
  child: UtilityProcess;
}

export class PerTaskHostRegistry {
  private readonly byTaskDir = new Map<string, PerTaskHostEntry>();
  private readonly byTaskId = new Map<string, Set<string>>();

  constructor(
    private readonly workspaceId: string,
    private readonly spawn: (
      workspaceId: string,
      task: { taskId: string; taskDir: string },
    ) => Promise<{ client: HostClient; child: UtilityProcess }> = (ws, task) =>
      createHost(ws, true, task),
    private readonly resolveTaskDir: (taskId: string) => string | null = () => null,
    /**
     * Handles the Host's browser requests ([PiDock 06] #8): main owns the
     * visible page, so the Host asks main for one already-gated action.
     * Without it every browser request fails closed.
     */
    private readonly browsers?: {
      handleRequest(request: BrowserRequestParams): Promise<BrowserPerformResult>;
    },
  ) {}

  private bindHostRequests(client: HostClient): HostClient {
    client.onBrowserRequest(async (params) =>
      this.browsers
        ? this.browsers.handleRequest(params)
        : { ok: false, error: "browser-unavailable: 主进程未挂载任务浏览器能力" },
    );
    return client;
  }

  /** Hosts currently forked (test seam: no Electron needed). */
  get size(): number {
    return this.byTaskDir.size;
  }

  hasTaskDir(taskDir: string): boolean {
    return this.byTaskDir.has(taskDir);
  }

  /**
   * [PiDock 18] (#20) task ids whose Host is currently forked. The schedule
   * driver evaluates only these: forking a Host just to look at a clock would
   * start a process for a task nobody is using.
   */
  activeTaskIds(): string[] {
    return [...this.byTaskId.keys()].sort();
  }

  entryForTaskId(taskId: string): PerTaskHostEntry | undefined {
    const dirs = this.byTaskId.get(taskId);
    if (!dirs) return undefined;
    const [first] = [...dirs];
    if (first === undefined) return undefined;
    return this.byTaskDir.get(first);
  }

  /** Route one op to the bound per-task Host, forking it on first use.
   *
   * `task/provision` is the bootstrap exception: a never-recorded id has
   * no `task.json` yet, so the resolver returns `null` by design. The
   * bootstrap derives the task folder from the validated `dirId` (plus an
   * optional `rootOverride`) via `previewTaskPaths`, forks the bound Host
   * there, and lets the Host itself write the record (`host.provision`).
   * `rootOverride` tasks provision at the override root and are
   * re-resolved there on reuse (see `resolveProvisionTaskDir`), so
   * override folders are first-class tasks, not `unknown task` forever.
   */
  async routeTaskOp(params: {
    taskId: string;
    op: HostTaskOp;
    payload?: Record<string, unknown>;
    /** Main-stamped sender attestation; forwarded verbatim. */
    origin?: TaskOpOrigin;
  }): Promise<HostTaskResult> {
    const { taskId, op, payload, origin } = params;
    const perOp = validateHostTaskOp(op, payload ?? {});
    if (!perOp.ok) {
      throw new TrustDomainViolation("invalid-payload", perOp.error);
    }
    const existing = this.entryForTaskId(taskId);
    if (existing) {
      // Task ids are globally unique, but re-resolve every reuse so a
      // task whose record moved/changed since the fork cannot silently
      // ride a stale Host binding. The default-root resolver never
      // covers `rootOverride` tasks, so reuse is override-aware: the
      // forked folder stays valid while its own record still names this
      // task (exact taskId match via `overrideTaskDirStillOurs`; the
      // path compare below is the normalized one); anything else is
      // `task-moved`.
      const current = this.resolveTaskDir(taskId);
      const overrideStillOurs = this.overrideTaskDirStillOurs(taskId, existing.taskDir);
      const resolvedDir = current ?? (overrideStillOurs ? existing.taskDir : null);
      if (
        resolvedDir === null ||
        normalizeTaskPath(resolvedDir) !== normalizeTaskPath(existing.taskDir)
      ) {
        throw new TrustDomainViolation(
          "invalid-payload",
          `task-moved: ${taskId} no longer resolves to the forked task folder; re-provision or restart before sending ops`,
        );
      }
      return existing.client.task({ workspaceId: this.workspaceId, taskId, op, payload, origin });
    }
    const taskDir = this.resolveTaskDir(taskId);
    const provisionDir =
      op === "task/provision" && taskDir === null
        ? this.resolveProvisionTaskDir(taskId, payload ?? {})
        : null;
    if (op === "task/provision" && taskDir === null && provisionDir !== null) {
      const bootstrapDir = provisionDir;
      const spawned = await this.spawn(this.workspaceId, { taskId, taskDir: bootstrapDir });
      const client = this.bindHostRequests(spawned.client);
      this.byTaskDir.set(bootstrapDir, { taskId, taskDir: bootstrapDir, client, child: spawned.child });
      const dirs = this.byTaskId.get(taskId) ?? new Set<string>();
      dirs.add(bootstrapDir);
      this.byTaskId.set(taskId, dirs);
      return client.task({ workspaceId: this.workspaceId, taskId, op, payload, origin });
    }
    if (taskDir === null || !isAbsoluteTaskRoot(taskDir)) {
      throw new TrustDomainViolation(
        "invalid-payload",
        `unknown task: ${taskId} (no task record; provision the task before sending ops)`,
      );
    }
    const spawned = await this.spawn(this.workspaceId, { taskId, taskDir });
    const client = this.bindHostRequests(spawned.client);
    this.byTaskDir.set(taskDir, { taskId, taskDir, client, child: spawned.child });
    const dirs = this.byTaskId.get(taskId) ?? new Set<string>();
    dirs.add(taskDir);
    this.byTaskId.set(taskId, dirs);
    return client.task({ workspaceId: this.workspaceId, taskId, op, payload, origin });
  }

  /**
   * Bootstrap folder for `task/provision` on a never-recorded id: derive
   * the task dir from the validated S2 `dirId` (+ optional `rootOverride`)
   * via `previewTaskPaths`. Non-provision ops never reach here.
   *
   * `rootOverride` is NOT unsupported: an override provisions at the
   * override root and the returned folder is where the Host writes the
   * record, so the task is re-resolvable on reuse through the same
   * derivation (per-task `TaskWorkspaceHost.provision` enforces
   * `paths.taskDir === this.taskDir`, closing substitution).
   */
  /**
   * S2 taskId/dirId coupling, documented until a taskId generator
   * exists: today the renderer creates both together and uses
   * `taskId === dirId` (e.g. `task-abcdef12`), so the bootstrap accepts
   * an exact match or the legacy `taskId`-suffix shape. Two taskIds that
   * merely share a trailing 8 (`evil-abcdef12`) must NOT bootstrap the
   * same folder — the folder-collision guard below makes that explicit:
   * a folder already claimed by a different task's `task.json` never
   * bootstraps. Remove this coupling once a real generator assigns
   * taskIds and dirIds together.
   */
  private dirIdMatchesTaskId(taskId: string, dirId: string): boolean {
    if (taskId === dirId) return true;
    return dirId.endsWith(taskId.slice(-8));
  }

  /**
   * `rootOverride` reuse guard: the forked folder stays valid while its
   * own on-disk record still names this task. Read failures (missing /
   * corrupt / unreadable records) resolve to `false` so reuse fails
   * closed with `task-moved` instead of trusting a folder with no record.
   */
  private overrideTaskDirStillOurs(taskId: string, taskDir: string): boolean {
    if (!isAbsoluteTaskRoot(taskDir)) return false;
    let record: { taskId: string } | null;
    try {
      record = readTaskRecordOnDisk(taskDir);
    } catch {
      return false;
    }
    return record?.taskId === taskId;
  }

  private resolveProvisionTaskDir(taskId: string, payload: Record<string, unknown>): string | null {
    const dirId = payload["dirId"];
    if (typeof dirId !== "string" || !isTaskDirId(dirId) || !this.dirIdMatchesTaskId(taskId, dirId)) {
      // `taskId` (opaque selector) and `dirId` (`task-oooooooo` folder
      // name) are different identifiers; the bootstrap requires the
      // payload dirId to match the task id segment so one task cannot
      // bootstrap another task's folder. See `dirIdMatchesTaskId` for
      // the accepted shapes.
      return null;
    }
    const override = payload["rootOverride"];
    if (override !== undefined && (typeof override !== "string" || override.trim().length === 0)) {
      return null;
    }
    const resolved = resolveTaskRoot(
      defaultTasksRoot(),
      typeof override === "string" ? override : undefined,
    );
    if (!resolved.ok) return null;
    try {
      const bootstrapDir = previewTaskPaths(resolved.root, dirId, [], []).taskDir;
      // Folder-collision guard: never bootstrap into a folder already
      // claimed by a different task's record. (S2 has no taskId
      // generator yet; claimants are `task.json` files written by
      // `TaskWorkspaceHost.provision`. Only an absent record (ENOENT)
      // is unclaimed here — an unreadable/corrupt record fails closed
      // (`null`) so the bootstrap never rides a folder it cannot verify.
      // The Host's own `paths.taskDir === this.taskDir` check still
      // binds the fork.)
      let claimant: { taskId: string } | null = null;
      try {
        claimant = readTaskRecordOnDisk(bootstrapDir);
      } catch {
        return null;
      }
      if (claimant !== null && claimant.taskId !== taskId) return null;
      return bootstrapDir;
    } catch {
      return null;
    }
  }

  /**
   * Ordered explicit quit ([PiDock 14] #17 box 2) for every forked task Host:
   * each Host aborts its Agent, stops its services/terminals/subprocess trees
   * by verified identity and saves state. Failures are collected and returned
   * so the caller can surface them instead of losing the task silently; the
   * forked Hosts stay alive until the caller disposes them.
   */
  async quitAll(input: { origin: TaskOpOrigin; label?: string }): Promise<{
    ok: boolean;
    tasks: { taskId: string; ok: boolean; applied: string[]; failures: unknown[]; retainedTasks: string[]; error?: string }[];
  }> {
    const tasks: { taskId: string; ok: boolean; applied: string[]; failures: unknown[]; retainedTasks: string[]; error?: string }[] = [];
    const payload: Record<string, unknown> = input.label === undefined ? {} : { label: input.label };
    for (const entry of this.byTaskDir.values()) {
      try {
        const result = await entry.client.task({
          workspaceId: this.workspaceId,
          taskId: entry.taskId,
          op: "task/quit",
          payload,
          origin: input.origin,
        });
        const quit = (result.payload as { quit?: { applied?: string[]; plan?: { failures?: unknown[]; retainedTasks?: string[] } } }).quit;
        tasks.push({
          taskId: entry.taskId,
          ok: true,
          applied: quit?.applied ?? [],
          failures: quit?.plan?.failures ?? [],
          retainedTasks: quit?.plan?.retainedTasks ?? [],
        });
      } catch (error) {
        tasks.push({ taskId: entry.taskId, ok: false, applied: [], failures: [], retainedTasks: [entry.taskId], error: errorMessage(error) });
      }
    }
    return { ok: tasks.every((task) => task.ok && task.retainedTasks.length === 0), tasks };
  }

  /** Dispose every forked Host (app exit / window-all-closed). */
  disposeAll(): void {
    for (const entry of this.byTaskDir.values()) {
      entry.client.dispose();
      entry.child.kill();
    }
    this.byTaskDir.clear();
    this.byTaskId.clear();
  }
}

/**
 * Interim per-task navigation allowlist source for [PiDock 06] (#8).
 *
 * `PIDOCK_TASK_BROWSER_ORIGINS` is a JSON map of task id to the task's own
 * frontend addresses (the addresses the user configures for that task's run
 * configuration, including any pilot BFF override). The browser gateway
 * compares every navigation against the entry, so the page's real network
 * target stays the task's own instance and an external host is refused.
 * Absent or malformed entries fail closed (that task can open no page)
 * rather than falling back to "any host". #7/#9 move this source onto the
 * persisted task run configuration.
 */
export function taskBrowserOriginsFromEnv(
  value: string | undefined,
): Record<string, string[]> {
  if (typeof value !== "string" || value.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const origins: Record<string, string[]> = {};
  for (const [taskId, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (taskId.trim().length === 0 || !Array.isArray(entry)) continue;
    const addresses = entry.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    if (addresses.length > 0) origins[taskId] = addresses;
  }
  return origins;
}

export interface TaskBrowserCapability {
  surfaces: Map<string, TaskBrowserSurface>;
  registry: ReturnType<typeof createBrowserGatewayRegistry>;
}

/**
 * Main-owned task browser capability ([PiDock 06] #8): one visible
 * `TaskBrowser` (WebContentsView on the task's persistent partition) and
 * one gateway per task, created on first use. The gateways validate every
 * request before it touches a page, and the renderer never speaks to
 * Chromium/CDP directly — it uses `task/browserAction`.
 */
export function createTaskBrowserCapability(input: {
  window: BrowserWindow;
  trust: TrustDomainRegistry;
  workspaceId: string;
  originsFor: (taskId: string) => readonly string[];
  secretsFor?: (taskId: string) => readonly string[];
}): TaskBrowserCapability {
  const surfaces = new Map<string, TaskBrowserSurface>();
  const registry = createBrowserGatewayRegistry({
    workspaceId: input.workspaceId,
    surfaceFor: (taskId) => {
      const existing = surfaces.get(taskId);
      if (existing) return existing;
      const { width, height } = input.window.getContentBounds();
      const browser = new TaskBrowser({
        window: input.window,
        workspaceId: input.workspaceId,
        taskId,
        bounds: taskBounds(width, height),
        registry: input.trust,
      });
      const surface = new TaskBrowserSurface(taskId, browser);
      surfaces.set(taskId, surface);
      return surface;
    },
    allowlistFor: (taskId): NavigationAllowlist =>
      deriveNavigationAllowlist({ addresses: [...input.originsFor(taskId)] }),
    ...(input.secretsFor !== undefined ? { secretsFor: input.secretsFor } : {}),
  });
  return { surfaces, registry };
}

export function registerIpc(
  client: HostClient,
  registry: TrustDomainRegistry,
  tasks?: PerTaskHostRegistry,
): void {
  ipcMain.handle("shell/getVersions", async (event) => {
    try {
      const sender = registry.requireShellSender(event);
      const { workspaceId } = validateShellInvocationPayload(
        "shell/getVersions",
        undefined,
        sender.workspaceId,
      );
      const host = await client.getVersions({ workspaceId });
      return {
        ok: true as const,
        payload: { ...versionsTriple(host.node), workspaceId },
      };
    } catch (error) {
      return trustFailureEnvelope(error);
    }
  });

  ipcMain.handle("shell/hostPing", async (event, payload?: unknown) => {
    try {
      const sender = registry.requireShellSender(event);
      const { workspaceId } = validateShellInvocationPayload(
        "shell/hostPing",
        payload,
        sender.workspaceId,
      );
      const result = await client.ping({ workspaceId });
      return { ok: true as const, payload: result };
    } catch (error) {
      return trustFailureEnvelope(error);
    }
  });

  // Task-scoped op from the sandboxed renderer: main binds the workspace
  // from the trusted sender (never from the payload) and forwards the
  // validated op to the per-task utilityProcess Host bound to that task's
  // folder. When a per-task registry is wired, the op routes through it
  // (fork-on-first-use with PIDOCK_TASK_ID/PIDOCK_TASK_DIR); otherwise it
  // falls back to the single workspace-only client (ping/versions smoke
  // paths), which stays task-unbound fail-closed in the Host.
  ipcMain.handle("shell/taskOp", async (event, payload?: unknown) => {
    try {
      const sender = registry.requireShellSender(event);
      const { workspaceId } = validateShellInvocationPayload(
        "shell/taskOp",
        payload,
        sender.workspaceId,
      );
      const record =
        typeof payload === "object" && payload !== null
          ? (payload as Record<string, unknown>)
          : {};
      const taskId = record["taskId"];
      const op = record["op"];
      if (typeof taskId !== "string" || taskId.length === 0) {
        throw new TrustDomainViolation("invalid-payload", "shell/taskOp requires a taskId");
      }
      if (!isHostTaskOp(op)) {
        throw new TrustDomainViolation("invalid-payload", `unknown task op: ${String(op)}`);
      }
      const opPayload =
        typeof record["payload"] === "object" && record["payload"] !== null
          ? (record["payload"] as Record<string, unknown>)
          : {};
      const perOp = validateHostTaskOp(op, opPayload);
      if (!perOp.ok) {
        throw new TrustDomainViolation("invalid-payload", perOp.error);
      }
      // Sender attestation ([PiDock 04] #7): only main can mint this from
      // the validated shell-domain sender, so the Host can tell a
      // session-less human-UI service control from an unattested
      // session-less call that is trying to claim the human path.
      const origin: TaskOpOrigin = {
        kind: "shell-ui",
        senderWebContentsId: sender.webContentsId,
      };
      if (tasks) {
        const result = await tasks.routeTaskOp({ taskId, op, payload: opPayload, origin });
        return { ok: true as const, payload: result };
      }
      const result = await client.task({ workspaceId, taskId, op, payload: opPayload, origin });
      return { ok: true as const, payload: result };
    } catch (error) {
      return trustFailureEnvelope(error);
    }
  });

  for (const channel of ipcMain.eventNames()) {
    if (
      typeof channel === "string" &&
      channel.startsWith("shell/") &&
      !isAllowedInvokeChannel(channel)
    ) {
      throw new Error(`non-allowlisted IPC channel registered: ${channel}`);
    }
  }
}

export function trustedWindowEvidence(
  views: TrustedWindowViews,
): TrustedWindowEvidence {
  const { window, shellView, taskView } = views;
  const children = window.contentView.children;
  return {
    browserWindowId: window.id,
    visible: window.isVisible(),
    childCount: children.length,
    distinctWebContents: shellView.webContents.id !== taskView.webContents.id,
    shell: {
      viewId: SHELL_VIEW_ID,
      domain: "shell",
      webContentsId: shellView.webContents.id,
      bounds: shellView.getBounds(),
      visible: shellView.getVisible(),
      attached: children.includes(shellView),
    },
    task: {
      viewId: TASK_VIEW_ID,
      domain: "task",
      webContentsId: taskView.webContents.id,
      bounds: taskView.getBounds(),
      visible: taskView.getVisible(),
      attached: children.includes(taskView),
    },
  };
}

export function assertTrustedWindowEvidence(
  evidence: TrustedWindowEvidence,
): void {
  if (
    evidence.visible !== true ||
    evidence.childCount !== 2 ||
    evidence.distinctWebContents !== true ||
    evidence.shell.attached !== true ||
    evidence.task.attached !== true ||
    evidence.shell.visible !== true ||
    evidence.task.visible !== true ||
    evidence.shell.bounds.width <= 0 ||
    evidence.shell.bounds.height <= 0 ||
    evidence.task.bounds.width <= 0 ||
    evidence.task.bounds.height <= 0 ||
    evidence.shell.bounds.x + evidence.shell.bounds.width >
      evidence.task.bounds.x
  ) {
    throw new Error(`trusted view layout failed: ${JSON.stringify(evidence)}`);
  }
}
