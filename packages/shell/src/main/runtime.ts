import path from "node:path";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  BrowserWindow,
  dialog,
  ipcMain,
  utilityProcess,
  WebContentsView,
} from "electron";
import type {
  BrowserWindowConstructorOptions,
  Rectangle,
  UtilityProcess,
  WebPreferences,
  WebContents,
  IpcMainInvokeEvent,
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
import { TaskRootIndex } from "./task-root-index.js";
import { ProjectRegistry } from "./project-registry.js";
import { ServiceCatalog } from "./service-catalog.js";
import { performServiceBindingOperation, performServiceCatalogOperation, performServiceConfigPreview } from "./service-catalog-ipc.js";
import { performProjectOperation } from "./project-ipc.js";
import type { ProviderWiring } from "./provider-ipc.js";
import { ProjectTaskCreation } from "./project-task-creation.js";
import { performCreationOperation } from "./project-task-ipc.js";
import type { BrowserPerformResult, BrowserRequestParams, HostTaskOp, HostTaskResult, TaskOpOrigin } from "../rpc/protocol.js";
import { isHostTaskOp } from "../rpc/protocol.js";
import { TaskBrowser } from "./task-browser.js";
import { TaskBrowserSurface } from "./task-browser-surface.js";
import { DesktopLayout, splitTaskBounds } from "./desktop-layout.js";
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

// The wide layout of prototype A (sidebar 226px + a 43% tool rail) needs more
// than the prototype's 1180px tier boundary to look like the design, so the
// window opens at 1440x900. `minWidth`/`minHeight` stop the window from being
// dragged below the prototype's narrowest stacked tier (720px), which the
// renderer does not define a layout for.
const WINDOW_OPTIONS: BrowserWindowConstructorOptions = {
  width: 1440,
  height: 900,
  minWidth: 720,
  minHeight: 560,
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
  layout?: DesktopLayout;
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
  const entry = path.join(here, "..", "host", "host-entry.js");
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

function layoutTrustedViews(
  window: BrowserWindow,
  shellView: WebContentsView,
  taskBrowser: TaskBrowser,
): void {
  const { width, height } = window.getContentBounds();
  const bounds = splitTaskBounds(width, height);
  shellView.setBounds({ x: 0, y: 0, width: bounds.x, height });
  shellView.setVisible(true);
  taskBrowser.setBounds(bounds);
}

export async function createTrustedWindow(
  workspaceId: string,
  mode: "dual" | "production" = "dual",
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
  const bounds = splitTaskBounds(contentBounds.width, contentBounds.height);
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

  const layout = mode === "production"
    ? new DesktopLayout(() => window.getContentBounds(), shellView, taskTab.view)
    : undefined;
  window.on("resize", () => {
    if (layout) layout.resize();
    else layoutTrustedViews(window, shellView, taskBrowser);
  });
  window.on("closed", () => registry.unregister(shellView.webContents.id));

  return {
    window,
    shellView,
    taskView: taskTab.view,
    taskBrowser,
    registry,
    ...(layout ? { layout } : {}),
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
      views.layout ? "index.html" : "smoke.html",
    ),
    views.layout ? Promise.resolve("about:blank") : loadView(
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
 * Host. Main resolves task IDs from the default root and the explicitly
 * registered override roots. The resolver verifies disk identity on every
 * route and never takes a task directory from the renderer payload.
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
    private readonly taskRoots?: TaskRootIndex,
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
      // A bound Host cannot bypass a failed disk/index lookup. Legacy
      // no-index tests retain the earlier record guard only at that seam.
      if (op === "task/provision" && this.taskRoots && this.resolveTaskDir(taskId) === null) {
        // A Host may have persisted the task before its first index write failed.
        // Explicit provision retry verifies that record and retries the index.
        await this.taskRoots.register(existing.taskDir);
      }
      const current = this.resolveTaskDir(taskId);
      const overrideStillOurs = this.taskRoots ? false : this.overrideTaskDirStillOurs(taskId, existing.taskDir);
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
      const result = await existing.client.task({ workspaceId: this.workspaceId, taskId, op, payload, origin },
        op === "task/sdkCancel" || op === "task/quit" ? { timeoutMs: 120_000 } : undefined);
      if (op === "task/provision") await this.taskRoots?.register(existing.taskDir);
      return result;
    }
    const taskDir = this.resolveTaskDir(taskId);
    const provisionDir =
      op === "task/provision" && taskDir === null
        ? this.resolveProvisionTaskDir(taskId, payload ?? {})
        : null;
    if (op === "task/provision" && taskDir === null && provisionDir !== null) {
      if (this.taskRoots?.inventory().roots.some((root) => root.state === "error")) {
        throw new TrustDomainViolation("invalid-payload", "task root index unavailable; repair before provisioning");
      }
      const bootstrapDir = provisionDir;
      const spawned = await this.spawn(this.workspaceId, { taskId, taskDir: bootstrapDir });
      const client = this.bindHostRequests(spawned.client);
      this.byTaskDir.set(bootstrapDir, { taskId, taskDir: bootstrapDir, client, child: spawned.child });
      const dirs = this.byTaskId.get(taskId) ?? new Set<string>();
      dirs.add(bootstrapDir);
      this.byTaskId.set(taskId, dirs);
      const result = await client.task({ workspaceId: this.workspaceId, taskId, op, payload, origin });
      await this.taskRoots?.register(bootstrapDir);
      return result;
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
    return client.task({ workspaceId: this.workspaceId, taskId, op, payload, origin },
      op === "task/sdkCancel" || op === "task/quit" ? { timeoutMs: 120_000 } : undefined);
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
        }, { timeoutMs: 120_000 });
        const quit = (result.payload as { quit?: { applied?: string[]; plan?: { failures?: unknown[]; retainedTasks?: string[] } } }).quit;
        if (!quit || !Array.isArray(quit.applied) || !quit.plan || !Array.isArray(quit.plan.failures) || !Array.isArray(quit.plan.retainedTasks)) throw new Error("host-quit-report-invalid");
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

export function createHostStopper(tasks: Pick<PerTaskHostRegistry, "quitAll">, origin: TaskOpOrigin, onStopped: () => void): () => Promise<boolean> {
  let pending: Promise<boolean> | undefined;
  return () => {
    if (pending) return pending;
    pending = tasks.quitAll({ origin, label: "应用退出" }).then((report) => {
      console.log(`[main] quit report: ${JSON.stringify(report)}`);
      if (!report.ok) {
        console.error(`[main] unresolved Host shutdown; retaining processes: ${JSON.stringify(report.tasks.filter((task) => !task.ok || task.retainedTasks.length))}`);
        return false;
      }
      onStopped();
      return true;
    }).catch((error: unknown) => {
      console.error(`[main] quit report failed; retaining Hosts: ${errorMessage(error)}`);
      return false;
    }).then((stopped) => {
      if (!stopped) pending = undefined;
      return stopped;
    });
    return pending;
  };
}

export function createLastWindowShutdown(stopHosts: () => Promise<boolean>, onStopped: () => void, retryMs = 5_000): () => Promise<void> {
  let pending: Promise<void> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const attempt = (): Promise<void> => {
    if (finished) return Promise.resolve();
    if (pending) return pending;
    pending = Promise.resolve().then(stopHosts).catch((error: unknown) => {
      console.error(`[main] last-window shutdown failed: ${errorMessage(error)}`);
      return false;
    }).then((stopped) => {
      if (stopped) {
        finished = true;
        if (retry) clearTimeout(retry);
        onStopped();
      } else if (!retry) {
        console.error(`[main] Host shutdown remains pending; retrying in ${retryMs} ms`);
        retry = setTimeout(() => { retry = undefined; void attempt(); }, retryMs);
      }
    }).finally(() => { pending = undefined; });
    return pending;
  };
  return attempt;
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
  layout?: DesktopLayout;
  secretsFor?: (taskId: string) => readonly string[];
}): TaskBrowserCapability {
  const surfaces = new Map<string, TaskBrowserSurface>();
  const layout = input.layout;
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
        bounds: splitTaskBounds(width, height),
        registry: input.trust,
        ...(layout ? { onActiveTabChange: (changed: TaskBrowser) => layout.browserChanged(changed) } : {}),
      });
      layout?.addBrowser(browser);
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
  projects?: ProjectRegistry,
  taskRoots?: TaskRootIndex,
  pickRoot: () => Promise<string | null> = async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  },
  creation?: ProjectTaskCreation,
  providers?: ProviderWiring,
  catalog?: ServiceCatalog,
  pickProgram: () => Promise<string | null> = async () => {
    const result = await dialog.showOpenDialog({ title: "选择本机服务程序", properties: ["openFile"] });
    if (result.canceled || !result.filePaths[0]) return null;
    const selected = realpathSync(result.filePaths[0]);
    if (!statSync(selected).isFile()) throw new Error("invalid service program file");
    accessSync(selected, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    // Metadata selection only; execution must recheck the file and its identity.
    return selected;
  },
): void {
  type TurnMessage = Parameters<Parameters<HostClient["onTurnEvent"]>[0]>[0];
  type PendingStart = { requestId: string; buffered: TurnMessage[]; bytes: number; overflow: boolean };
  type Subscription = { taskId: string; sessionId: string; frame: { processId: number; routingId: number }; webContents: WebContents; detach: () => void; deliver: (message: TurnMessage) => void; onNavigation: () => void; onInPageNavigation: () => void; onDestroyed: () => void; turns: Map<string, { sequence: number; resync: boolean; terminal: boolean }>; evictedTurns: boolean; pendingStart: PendingStart | null };
  const subscriptions = new Map<number, Subscription>();
  const pendingNavigation = new Map<number, { webContents: WebContents; listener: () => void }>();
  const revisions = new Map<number, number>();
  function revoke(webContentsId: number): void {
    revisions.set(webContentsId, (revisions.get(webContentsId) ?? 0) + 1);
    const pending = pendingNavigation.get(webContentsId);
    if (pending) {
      pendingNavigation.delete(webContentsId);
      pending.webContents.removeListener("did-start-navigation", pending.listener);
    }
    const sub = subscriptions.get(webContentsId);
    if (!sub) return;
    subscriptions.delete(webContentsId);
    sub.webContents.removeListener("did-start-navigation", sub.onNavigation);
    sub.webContents.removeListener("did-navigate-in-page", sub.onInPageNavigation);
    sub.webContents.removeListener("destroyed", sub.onDestroyed);
    sub.pendingStart = null;
    sub.detach();
  }
  function routeMatches(sub: Subscription): boolean {
    try {
      const url = new URL(sub.webContents.getURL());
      // Production inventory has no URL task route; main owns its binding.
      if (url.protocol === "file:") return fileURLToPath(url) === path.join(here, "..", "renderer", "index.html");
      const match = /^\/projects\/[^/]+\/tasks\/([^/]+)$/.exec(url.pathname);
      return !!match && decodeURIComponent(match[1]!) === sub.taskId && url.searchParams.get("session") === sub.sessionId;
    } catch { return false; }
  }
  function live(event: IpcMainInvokeEvent, sub: Subscription): boolean {
    if (!routeMatches(sub) || sub.webContents.isDestroyed() || event.sender !== sub.webContents ||
        event.sender.mainFrame.processId !== sub.frame.processId || event.sender.mainFrame.routingId !== sub.frame.routingId) return false;
    try { registry.requireShellSender({ sender: event.sender, senderFrame: event.sender.mainFrame }); return true; }
    catch { return false; }
  }
  ipcMain.handle("shell/sdkTurn", async (event, raw?: unknown) => {
    try {
      const sender = registry.requireShellSender(event);
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("invalid-sdk-payload");
      const input = raw as Record<string, unknown>;
      const action = input["action"];
      if (!["subscribe", "unsubscribe", "start", "status", "projection", "cancel"].includes(String(action))) throw new Error("invalid-sdk-action");
      const taskId = input["taskId"];
      const sessionId = input["sessionId"];
      if (typeof taskId !== "string" || !taskId || typeof sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(sessionId)) throw new Error("invalid-sdk-identity");
      const keys = action === "start" ? ["action", "taskId", "sessionId", "requestId", "text"] :
        action === "status" ? ["action", "taskId", "sessionId", "requestId"] :
        action === "subscribe" ? ["action", "taskId", "sessionId", "requestId"] :
        action === "cancel" ? ["action", "taskId", "sessionId", "turnId"] : ["action", "taskId", "sessionId"];
      if (Object.keys(input).some((key) => !keys.includes(key))) throw new Error("invalid-sdk-payload: extra key");
      if (action === "subscribe" && input["requestId"] !== undefined &&
          (typeof input["requestId"] !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(input["requestId"]))) throw new Error("invalid-sdk-request");
      const previous = subscriptions.get(sender.webContentsId);
      if (action === "unsubscribe") {
        if (previous?.taskId !== taskId || previous.sessionId !== sessionId) {
          if (pendingNavigation.has(sender.webContentsId)) revoke(sender.webContentsId);
          throw new Error("sdk-subscription-mismatch");
        }
        revoke(sender.webContentsId);
        return { ok: true as const, payload: { unsubscribed: true } };
      }
      if (!tasks) throw new Error("sdk-task-registry-unavailable");
      // #47: install the persisted Provider selection before the first SDK op of a
      // task, exactly like `shell/taskOp`. Without this a turn issued right after
      // opening a task could race the panel's own restore and fail closed with
      // `provider-not-configured` even though a selection exists.
      if (providers) { try { await providers.ensure(taskId, sender.webContentsId); } catch { /* surfaced by shell/providerOp list */ } }
      if (action === "subscribe") {
        revoke(sender.webContentsId);
        const revision = revisions.get(sender.webContentsId);
        const initialUrl = event.sender.getURL();
        let navigated = false;
        const onNavigation = () => {
          navigated = true;
          if (revisions.get(sender.webContentsId) === revision) revoke(sender.webContentsId);
        };
        event.sender.once("did-start-navigation", onNavigation);
        pendingNavigation.set(sender.webContentsId, { webContents: event.sender, listener: onNavigation });
        try {
        await tasks.routeTaskOp({ taskId, op: "task/sdkProjection", payload: { sessionId }, origin: { kind: "shell-ui", senderWebContentsId: sender.webContentsId } });
        registry.requireShellSender(event);
        const frame = event.sender.mainFrame;
        if (navigated || revision !== revisions.get(sender.webContentsId) || initialUrl !== event.sender.getURL() ||
            frame.processId !== event.senderFrame?.processId || frame.routingId !== event.senderFrame.routingId || event.sender.isDestroyed()) throw new Error("sdk-sender-navigated");
        const hostClient = tasks.entryForTaskId(taskId)?.client;
        if (!hostClient) throw new Error("sdk-host-unavailable");
        const sub: Subscription = { taskId, sessionId, frame: { processId: frame.processId, routingId: frame.routingId }, webContents: event.sender, detach: () => {}, deliver: () => {}, onNavigation,
          onInPageNavigation: () => {}, onDestroyed: () => {}, turns: new Map(), evictedTurns: false, pendingStart: null };
        const remember = (turnId: string, sequence: number, resync: boolean, terminal = false) => {
          sub.turns.delete(turnId);
          sub.turns.set(turnId, { sequence, resync, terminal });
          if (sub.turns.size > 64) {
            sub.turns.delete(sub.turns.keys().next().value!);
            sub.evictedTurns = true;
          }
        };
        const deliverTurn = (message: TurnMessage) => {
          if (subscriptions.get(sender.webContentsId) !== sub) return;
          if (!live(event, sub)) { revoke(sender.webContentsId); return; }
          const item = message.kind === "sdk-turn-event" ? message.event : message.kind === "sdk-turn-status" ? message.turn : message;
          if (item.taskId !== taskId || item.sessionId !== sessionId) return;
          if (message.kind === "sdk-turn-resync") {
            remember(item.turnId, sub.turns.get(item.turnId)?.sequence ?? 0, true);
            try { sub.webContents.send("shell/sdkTurnEvent", { kind: "needs-resync", taskId, sessionId, turnId: item.turnId }); }
            catch { revoke(sender.webContentsId); }
            return;
          }
          if (message.kind === "sdk-turn-event") {
            const previousTurn = sub.turns.get(item.turnId);
            const last = previousTurn?.sequence ?? 0;
            if (previousTurn?.terminal || previousTurn?.resync) return;
            if (!previousTurn && sub.evictedTurns) {
              remember(item.turnId, 0, true);
              try { sub.webContents.send("shell/sdkTurnEvent", { kind: "needs-resync", taskId, sessionId, turnId: item.turnId }); }
              catch { revoke(sender.webContentsId); }
              return;
            }
            if (message.event.sequence !== last + 1 || last >= 256) {
              remember(item.turnId, last, true);
              try { sub.webContents.send("shell/sdkTurnEvent", { kind: "needs-resync", taskId, sessionId, turnId: item.turnId }); }
              catch { revoke(sender.webContentsId); }
              return;
            }
            remember(item.turnId, message.event.sequence, false);
          }
          try {
            sub.webContents.send("shell/sdkTurnEvent", message.kind === "sdk-turn-status" && (sub.turns.get(item.turnId)?.resync || (sub.evictedTurns && !sub.turns.has(item.turnId)))
              ? { ...message, turn: { ...message.turn, needsResync: true } } : message);
            if (message.kind === "sdk-turn-status") {
              const prior = sub.turns.get(item.turnId);
              remember(item.turnId, prior?.sequence ?? 0, prior?.resync ?? sub.evictedTurns, true);
            }
          }
          catch { revoke(sender.webContentsId); }
        };
        sub.deliver = deliverTurn;
        sub.detach = hostClient.onTurnEvent((message) => {
          const item = message.kind === "sdk-turn-event" ? message.event : message.kind === "sdk-turn-status" ? message.turn : message;
          if (sub.pendingStart && sub.evictedTurns && !sub.turns.has(item.turnId) && item.taskId === taskId && item.sessionId === sessionId) {
            const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
            if (!sub.pendingStart.overflow && sub.pendingStart.buffered.length < 256 && sub.pendingStart.bytes + bytes <= 262_144) {
              sub.pendingStart.buffered.push(message);
              sub.pendingStart.bytes += bytes;
            } else {
              sub.pendingStart.overflow = true;
              sub.pendingStart.buffered.length = 0;
            }
            return;
          }
          deliverTurn(message);
        });
        if (!routeMatches(sub)) { sub.detach(); throw new Error("sdk-task-route-mismatch"); }
        pendingNavigation.delete(sender.webContentsId);
        subscriptions.set(sender.webContentsId, sub);
        sub.onInPageNavigation = () => { if (subscriptions.get(sender.webContentsId) === sub && !routeMatches(sub)) revoke(sender.webContentsId); };
        sub.onDestroyed = () => { if (subscriptions.get(sender.webContentsId) === sub) revoke(sender.webContentsId); };
        event.sender.on("did-navigate-in-page", sub.onInPageNavigation);
        event.sender.on("destroyed", sub.onDestroyed);
        // A turn can settle between the first Host read and listener attachment.
        // Read authoritative JSONL again while the guarded listener is live.
        const snapshot = await tasks.routeTaskOp({ taskId, op: "task/sdkProjection", payload: { sessionId }, origin: { kind: "shell-ui", senderWebContentsId: sender.webContentsId } });
        const status = input["requestId"] === undefined ? null : await tasks.routeTaskOp({ taskId, op: "task/sdkStatus",
          payload: { sessionId, requestId: input["requestId"] }, origin: { kind: "shell-ui", senderWebContentsId: sender.webContentsId } });
        const turn = (status?.payload as { turn?: { turnId?: string; state?: string; needsResync?: boolean } | null } | undefined)?.turn ?? null;
        // The turn can settle between the first JSONL read and the status read.
        const reconciled = turn && ["done", "failed", "cancelled"].includes(turn.state ?? "")
          ? await tasks.routeTaskOp({ taskId, op: "task/sdkProjection", payload: { sessionId }, origin: { kind: "shell-ui", senderWebContentsId: sender.webContentsId } })
          : snapshot;
        if (subscriptions.get(sender.webContentsId) !== sub || !live(event, sub)) throw new Error("sdk-sender-navigated");
        const needsResync = turn?.turnId && (sub.turns.get(turn.turnId)?.resync || (sub.evictedTurns && !sub.turns.has(turn.turnId)));
        if (turn?.turnId && ["done", "failed", "cancelled", "interrupted"].includes(turn.state ?? "")) {
          const prior = sub.turns.get(turn.turnId);
          remember(turn.turnId, prior?.sequence ?? 0, prior?.resync ?? Boolean(needsResync), true);
        }
        return { ok: true as const, payload: { taskId, sessionId, snapshot: reconciled.payload,
          turn: needsResync ? { ...turn, needsResync: true } : turn } };
        } catch (error) {
          if (subscriptions.get(sender.webContentsId)?.onNavigation === onNavigation) revoke(sender.webContentsId);
          if (pendingNavigation.get(sender.webContentsId)?.listener === onNavigation) {
            pendingNavigation.delete(sender.webContentsId);
            event.sender.removeListener("did-start-navigation", onNavigation);
          }
          throw error;
        }
      }
      if (!previous || previous.taskId !== taskId || previous.sessionId !== sessionId || !live(event, previous)) throw new Error("sdk-subscription-required");
      const op = action === "start" ? "task/sendMessage" : action === "status" ? "task/sdkStatus" : action === "cancel" ? "task/sdkCancel" : "task/sdkProjection";
      const payload: Record<string, unknown> = { sessionId };
      if (action === "start") { payload["requestId"] = input["requestId"]; payload["text"] = input["text"]; }
      if (action === "status") payload["requestId"] = input["requestId"];
      if (action === "cancel") payload["turnId"] = input["turnId"];
      const pending = action === "start" ? { requestId: input["requestId"] as string, buffered: [] as TurnMessage[], bytes: 0, overflow: false } : null;
      if (pending && previous.pendingStart) throw new Error("sdk-start-pending");
      if (pending) previous.pendingStart = pending;
      let result: Awaited<ReturnType<PerTaskHostRegistry["routeTaskOp"]>>;
      try {
        result = await tasks.routeTaskOp({ taskId, op, payload, origin: { kind: "shell-ui", senderWebContentsId: sender.webContentsId } });
      } catch (error) {
        if (pending && previous.pendingStart === pending) previous.pendingStart = null;
        throw error;
      }
      if (!live(event, previous) || subscriptions.get(sender.webContentsId) !== previous) throw new Error("sdk-sender-navigated");
      if (action === "start" && result.payload && typeof result.payload === "object") {
        const turn = (result.payload as { turn?: { turnId?: string; state?: string; lastSequence?: number } }).turn;
        if (pending && previous.pendingStart === pending) previous.pendingStart = null;
        if (turn?.turnId && turn.state === "accepted" && !previous.turns.has(turn.turnId)) {
          // A Host-issued ACK distinguishes a new turn from replay after tombstone eviction.
          previous.turns.set(turn.turnId, { sequence: 0, resync: Boolean(pending?.overflow) ||
            (previous.evictedTurns && (turn.lastSequence ?? 0) > 0 && !pending?.buffered.some((message) =>
              (message.kind === "sdk-turn-event" ? message.event : message.kind === "sdk-turn-status" ? message.turn : message).turnId === turn.turnId)), terminal: false });
          if (previous.turns.size > 64) {
            previous.turns.delete(previous.turns.keys().next().value!);
            previous.evictedTurns = true;
          }
        }
        if (pending && turn?.turnId) {
          if (pending.overflow) previous.deliver({ kind: "sdk-turn-resync", taskId, sessionId, turnId: turn.turnId });
          else for (const message of pending.buffered) {
            const item = message.kind === "sdk-turn-event" ? message.event : message.kind === "sdk-turn-status" ? message.turn : message;
            if (item.turnId === turn.turnId) previous.deliver(message);
            else previous.deliver({ kind: "sdk-turn-resync", taskId, sessionId, turnId: item.turnId });
          }
        }
      } else if (pending && previous.pendingStart === pending) previous.pendingStart = null;
      if (action === "status" && result.payload && typeof result.payload === "object") {
        const value = result.payload as { turn?: { turnId?: string; needsResync?: boolean } | null };
        if (value.turn?.turnId && (previous.turns.get(value.turn.turnId)?.resync || (previous.evictedTurns && !previous.turns.has(value.turn.turnId)))) {
          return { ok: true as const, payload: { ...value, turn: { ...value.turn, needsResync: true } } };
        }
      }
      return { ok: true as const, payload: result.payload };
    } catch (error) { return { ok: false as const, error: errorMessage(error) }; }
  });
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

  ipcMain.handle("shell/listTasks", async (event, payload?: unknown) => {
    try {
      const sender = registry.requireShellSender(event);
      validateShellInvocationPayload("shell/listTasks", payload, sender.workspaceId);
      if (!taskRoots) return { ok: false as const, error: "任务根索引尚未接入" };
      return { ok: true as const, payload: taskRoots.inventory() };
    } catch (error) {
      if (error instanceof TrustDomainViolation) return trustFailureEnvelope(error);
      return { ok: false as const, error: "任务记录不可读取，请检查本机任务目录后重试" };
    }
  });

  ipcMain.handle("shell/importTaskRoot", async (event, payload?: unknown) => {
    try {
      const sender = registry.requireShellSender(event);
      if (payload !== undefined) throw new TrustDomainViolation("invalid-payload", "task root picker accepts no path or options");
      if (!taskRoots) return { ok: false as const, error: "任务根索引尚未接入" };
      const selected = await pickRoot();
      registry.requireShellSender(event);
      if (!selected) return { ok: true as const, payload: { canceled: true } };
      return { ok: true as const, payload: { canceled: false, count: await taskRoots.importRoot(selected), workspaceId: sender.workspaceId } };
    } catch (error) {
      if (error instanceof TrustDomainViolation) return trustFailureEnvelope(error);
      return { ok: false as const, error: "任务根导入失败：目录或任务身份无效，请检查后重试" };
    }
  });

  ipcMain.handle("shell/createTask", async (event, payload?: unknown) => {
    try {
      registry.requireShellSender(event);
      if (!creation) return { ok: false as const, error: "真实任务创建尚未接入" };
      const result = await performCreationOperation(creation, payload, pickRoot, () => { registry.requireShellSender(event); });
      return { ok: true as const, payload: result };
    } catch (error) {
      if (error instanceof TrustDomainViolation) return trustFailureEnvelope(error);
      return { ok: false as const, error: errorMessage(error) };
    }
  });

  ipcMain.handle("shell/providerOp", async (event, payload?: unknown) => {
    try {
      const sender = registry.requireShellSender(event);
      if (!providers) return { ok: false as const, error: "Provider 配置尚未接入" };
      // Sender-scoped, never payload-scoped: main attests this webContents to
      // the task Host when it installs a selection or restores one.
      const result = await providers.perform(payload, sender.webContentsId);
      return { ok: true as const, payload: result };
    } catch (error) {
      if (error instanceof TrustDomainViolation) return trustFailureEnvelope(error);
      return { ok: false as const, error: "Provider 配置操作失败，请检查本机凭据环境后重试" };
    }
  });

  ipcMain.handle("shell/projectOp", async (event, payload?: unknown) => {
    try {
      registry.requireShellSender(event);
      if (!projects) return { ok: false as const, error: "项目注册表尚未接入" };
      return { ok: true as const, payload: await performProjectOperation(projects, payload, taskRoots) };
    } catch (error) {
      if (error instanceof TrustDomainViolation) return trustFailureEnvelope(error);
      return { ok: false as const, error: "项目注册表操作失败，请检查本机项目数据后重试" };
    }
  });

  ipcMain.handle("shell/serviceCatalogOp", async (event, payload?: unknown) => {
    try {
      registry.requireShellSender(event);
      if (!catalog) return { ok: false as const, error: "服务配方目录尚未接入" };
      if (payload && typeof payload === "object" && (payload as Record<string, unknown>)["op"] === "previewConfig") {
        return { ok: true as const, payload: performServiceConfigPreview(catalog, payload, process.env) };
      }
      if (payload && typeof payload === "object" && ["bind", "taskBindings"].includes(String((payload as Record<string, unknown>)["op"]))) {
        const url = event.sender.getURL();
        const frame = { processId: event.sender.mainFrame.processId, routingId: event.sender.mainFrame.routingId };
        let navigated = false;
        const onNavigation = () => { navigated = true; };
        event.sender.on("did-start-navigation", onNavigation);
        try {
          const requireLive = () => {
            registry.requireShellSender(event);
            if (navigated || event.sender.isDestroyed() || url !== event.sender.getURL() ||
                frame.processId !== event.sender.mainFrame.processId || frame.routingId !== event.sender.mainFrame.routingId) {
              throw new Error("service binding sender changed");
            }
          };
          return { ok: true as const, payload: await performServiceBindingOperation(catalog, payload, pickProgram, requireLive) };
        } finally { event.sender.removeListener("did-start-navigation", onNavigation); }
      }
      return { ok: true as const, payload: performServiceCatalogOperation(catalog, payload) };
    } catch (error) {
      if (error instanceof TrustDomainViolation) return trustFailureEnvelope(error);
      return { ok: false as const, error: "服务配方保存或读取失败，请核对项目及配置后重试" };
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
      if (!isHostTaskOp(op) || op.startsWith("task/sdk") || op === "task/sendMessage") {
        throw new TrustDomainViolation("invalid-payload", `unknown task op: ${String(op)}`);
      }
      if (pendingNavigation.has(sender.webContentsId) || subscriptions.get(sender.webContentsId)?.taskId !== taskId) revoke(sender.webContentsId);
      // A persisted Provider selection is reinstalled on first contact with the
      // task, before any turn op can run against an unconfigured context. The
      // status route reports failures, so an install failure never turns an
      // unrelated op into an error.
      if (providers) { try { await providers.ensure(taskId, sender.webContentsId); } catch { /* surfaced by shell/providerOp list */ } }
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

export function assertProductionWindowEvidence(views: TrustedWindowViews): void {
  const { window, shellView, taskView, registry, layout } = views;
  if (!layout) throw new Error("production layout is missing");
  const children = window.contentView.children;
  const { width, height } = window.getContentBounds();
  const shell = shellView.getBounds();
  const browser = layout.activeBrowser as TaskBrowser | undefined;
  const tab = browser?.activeTab;
  registry.requireShellSender({ sender: shellView.webContents, senderFrame: shellView.webContents.mainFrame });
  registry.requireTaskBinding(taskView.webContents.id, { taskId: TASK_ID, pageId: PAGE_ID });
  if (tab) registry.requireTaskBinding(tab.webContentsId, { taskId: browser.taskId, pageId: tab.pageId });
  const task = splitTaskBounds(width, height);
  const visibleChildren = children.filter((child) => child.getVisible());
  const expectedVisible = tab ? [shellView, tab.view] : [shellView];
  const pageBounds = tab?.view.getBounds();
  if (!window.isVisible() || !children.includes(shellView) || !children.includes(taskView) ||
      shellView.webContents.id === taskView.webContents.id || taskView.getVisible() ||
      visibleChildren.length !== expectedVisible.length ||
      expectedVisible.some((view) => !visibleChildren.includes(view)) ||
      shell.x !== 0 || shell.y !== 0 || shell.height !== height ||
      shell.width !== (tab ? task.x : width) ||
      (tab && (!children.includes(tab.view) || pageBounds?.x !== task.x ||
        pageBounds.y !== task.y || pageBounds.width !== task.width || pageBounds.height !== task.height))) {
    throw new Error("production trusted view layout failed");
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
