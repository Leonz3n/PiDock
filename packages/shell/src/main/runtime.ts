import path from "node:path";
import { createServer, type Server } from "node:net";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  app,
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
import { buildHostEnv, classifyControlCaller, serviceExecutionAdmitted, validateHostTaskOp } from "../host/host-guards.js";
import {
  isAbsoluteTaskRoot,
  isTaskDirId,
  normalizeTaskPath,
  previewTaskPaths,
  resolveTaskRoot,
} from "./task-provision.js";
import { readTaskRecordOnDisk } from "../host/task-store.js";
import {
  createNodePrepScanDeps,
  createPrepScanAuthority,
  deriveRendererPrepPayload,
  needsPrepScan,
  type PrepScanAuthority,
} from "./task-prep-scan.js";
import { defaultTasksRoot } from "./task-resolver.js";
import { TaskRootIndex, type VerifiedTaskIdentity } from "./task-root-index.js";
import { HostTaskAdmission } from "../host/host-task-admission.js";
import { shutdownDeadline } from "../host/shutdown-deadline.js";
import { ProjectRegistry } from "./project-registry.js";
import { ServiceCatalog, serviceCatalogAuthority, type ServiceLaunch } from "./service-catalog.js";
import { InstalledServiceHostAuthority, type ServiceOwnerChange, type ServiceOwnerDurableRecord } from "./service-host-binding.js";
import { createServiceTemplateHandler, parseServiceOwnerRebindRequest, parseTaskDependencyRoutingRequest, performServiceBindingOperation, performServiceCatalogOperation, performServiceConfigPreview, parseServiceRunGroupRequest, parseServiceRunRequest } from "./service-catalog-ipc.js";
import { deriveBoundServiceGroupPlan, readTaskDependencyRouting, unsatisfiedDeclarationMessage, type BoundServiceEntry } from "./service-dependency-routing.js";
import { resolveServiceEnv, type ServiceConfigEntry } from "./service-config.js";
import type { PortAssignment, PortReservation, ResolvedBinding, RunDiagnostic, RunUnit, StartGroup } from "./service-topology.js";
import { codeObservationFields } from "./service-code-observation.js";
import { loadExternalEditorSettings, type ExternalEditorSettingsResult } from "./external-editor.js";
import { performEditorSettingsOperation } from "./external-editor-settings.js";
import { performProjectOperation } from "./project-ipc.js";
import type { ProviderWiring } from "./provider-ipc.js";
import { ProjectTaskCreation } from "./project-task-creation.js";
import { performCreationOperation } from "./project-task-ipc.js";
import type { ProjectTaskAppend } from "./task-append.js";
import { performAppendOperation } from "./project-append-ipc.js";
import type { BrowserPerformResult, BrowserRequestParams, HostTaskOp, HostTaskResult, TaskOpOrigin } from "../rpc/protocol.js";
import { isHostTaskOp } from "../rpc/protocol.js";
import type { ServiceTemplateRequestHandler } from "../rpc/service-template-request.js";
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

// Adopt the actual child synchronously after fork, before client construction or any await.
export function createHostDisposer(child: Pick<UtilityProcess, "once" | "kill">) {
  let hasExited = false;
  const exited = new Promise<void>((done) => { child.once("exit", () => { hasExited = true; done(); }); });
  let receipt: Promise<void> | undefined;
  return {
    disposeAfterTasks(tasks: Pick<PerTaskHostRegistry, "disposeAll">, client: Pick<HostClient, "dispose">, stopSchedules: () => void): Promise<void> {
      return receipt ??= Promise.resolve().then(async () => {
        stopSchedules();
        await tasks.disposeAll();
        const disposed = shutdownDeadline(exited, 15_000, "main-workspace-disposal-unconfirmed");
        // Keep expiry observed if client disposal or the termination request throws synchronously.
        void disposed.catch(() => {});
        client.dispose();
        if (!hasExited) child.kill();
        await disposed;
      });
    },
  };
}

export async function createHost(
  workspaceId: string,
  logExit = true,
  task?: { taskId: string; taskDir: string },
): Promise<{ client: HostClient; child: UtilityProcess; disposal: ReturnType<typeof createHostDisposer> }> {
  const entry = path.join(here, "..", "host", "host-entry.js");
  const child = utilityProcess.fork(entry, [], {
    serviceName: task ? `pidock-node-host-${task.taskId}` : "pidock-node-host",
    env: { ...buildHostEnv(process.env, workspaceId, task, app.getPath("userData"), normalizeTaskPath(defaultTasksRoot())),
      // Only where service execution is admitted: a platform that cannot own a
      // service must not be told to verify one (see `serviceExecutionAdmitted`),
      // or its Host injects an orphan that no bootstrap can ever clear.
      ...(task && serviceExecutionAdmitted() ? { PIDOCK_SERVICE_OWNER_REQUIRED: "1" } : {}) },
    stdio: "pipe",
  });
  const disposal = createHostDisposer(child);
  const client = new HostClient(child);
  if (logExit) {
    child.on("exit", (code) => console.log(`[main] host exit code=${code}`));
  }
  child.stderr?.on("data", (chunk) =>
    process.stderr.write(`[host:stderr] ${chunk}`),
  );
  return { client, child, disposal };
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
 * A named refusal main resolved for one service operation - the Host's own
 * control fence, an unsettled durable owner record, a catalog that cannot be
 * resolved - is the page's only honest explanation for a refused start/stop or
 * re-bind, so the `shell/serviceCatalogOp` branches that drive real child
 * processes answer with it verbatim ([PiDock 04] #7 slice). A thrown
 * non-refusal would otherwise collapse into the generic catalog-save message or
 * the renderer's "request failed" fallback, which is exactly the untruthful
 * copy this slice removes. A trust domain violation keeps its own envelope.
 */
function namedServiceRefusal(error: unknown): { ok: false; error: string } {
  if (error instanceof TrustDomainViolation) throw error;
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
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
  /** Fingerprint of the confirmed catalog bindings already registered into this Host. */
  catalogServicesKey?: string;
  /** In-flight registration of those bindings, so concurrent routes register once. */
  catalogServicesPending?: Promise<void>;
}

type TaskHostQuitResult = { taskId: string; ok: boolean; applied: string[]; failures: unknown[]; retainedTasks: string[]; error?: string };
type TaskHostsQuitReport = { ok: boolean; tasks: TaskHostQuitResult[] };
interface PendingTaskHost {
  taskId: string;
  taskDir: string;
  identity: VerifiedTaskIdentity | null;
  promise: Promise<PerTaskHostEntry>;
}

export class PerTaskHostRegistry {
  private readonly byTaskDir = new Map<string, PerTaskHostEntry>();
  private readonly byTaskId = new Map<string, Set<string>>();
  private readonly identities = new Map<string, VerifiedTaskIdentity>();
  private readonly pendingHosts = new Map<string, PendingTaskHost>();
  private readonly spawnFailures = new Map<string, { taskId: string; error: string }>();
  private readonly activeTaskOps = new Map<string, number>();
  private readonly rebindings = new Set<string>();
  private readonly admission = new HostTaskAdmission();
  private closing = false;
  private quitConfirmed = false;
  private quitReceipt?: Promise<TaskHostsQuitReport>;
  private disposalReceipt?: Promise<void>;
  private readonly hostExits = new Map<UtilityProcess, { exited: boolean; receipt: Promise<void> }>();
  private catalogServiceLaunches?: (taskId: string, previousKey: string | undefined) => { key: string; launches: ServiceLaunch[] };
  private services?: InstalledServiceHostAuthority;
  /** Per-task shared-template handler bound by `registerIpc` once the catalog exists ([PiDock 04] #7 box 6). */
  private serviceTemplates?: (taskId: string) => ServiceTemplateRequestHandler;
  configureServices(create: (workspaceId: string) => InstalledServiceHostAuthority): void {
    if (this.services || this.closing || this.byTaskDir.size || this.pendingHosts.size) throw Error("service-owner-authority-already-bound");
    // #90: omitting the fork-time marker alone does not disable the parent
    // channel. A failed prepare sends service-owner-fenced, which creates an
    // unverified inventory in Host and gates terminal writes again. Keep the
    // entire authority lifecycle absent where service execution is not admitted.
    if (serviceExecutionAdmitted()) this.services = create(this.workspaceId);
  }
  /**
   * The per-task handler for the Host -> main shared-template requests
   * ([PiDock 04] #7 box 6). Bound late because the catalog exists after this
   * registry does, exactly like the owner authority above. Absent means every
   * request is refused by name and nothing is written.
   */
  configureServiceTemplates(create: (taskId: string) => ServiceTemplateRequestHandler): void {
    if (this.serviceTemplates) throw Error("service-template-handler-already-bound");
    this.serviceTemplates = create;
  }
  /** Main's task-open resolver for trusted catalog launches, bound after the catalog exists. */
  configureCatalogServiceLaunches(resolve: (taskId: string, previousKey: string | undefined) => { key: string; launches: ServiceLaunch[] }): void {
    if (this.catalogServiceLaunches || this.closing || this.byTaskDir.size || this.pendingHosts.size) {
      throw Error("service-catalog-launch-resolver-already-bound");
    }
    this.catalogServiceLaunches = resolve;
  }
  private async prepareServices(entry: PerTaskHostEntry): Promise<void> {
    if (!this.services) return;
    try { await this.services.prepare(entry.child, entry.taskId); this.services.verify(entry.child); }
    catch { /* The actual parent transport installs a sticky Host write/quit fence; reads keep their existing admission. */ }
  }
  private registerCatalogServices(entry: PerTaskHostEntry, senderWebContentsId: number | undefined): Promise<void> {
    const resolveLaunches = this.catalogServiceLaunches;
    if (!resolveLaunches) return Promise.resolve();
    if (entry.catalogServicesPending) return entry.catalogServicesPending;
    // Service processes are intentionally unavailable on unsupported platforms;
    // registering executable catalog rows there would imply a capability Host
    // cannot provide. The normal task route remains available.
    if (serviceExecutionRefusal() !== null) return Promise.resolve();
    if (senderWebContentsId === undefined) {
      console.error(`[main] task ${entry.taskId} catalog services were not registered: no main-attested sender webContents id`);
      return Promise.resolve();
    }
    const bootstrap = Promise.resolve().then(async () => {
      // The key covers the bindings, not one launch: a binding written after this
      // Host was opened (the ordinary UI order), a template version change, or a
      // rebuilt Host all produce a different key and are registered then.
      let resolved: { key: string; launches: ServiceLaunch[] };
      try { resolved = resolveLaunches(entry.taskId, entry.catalogServicesKey); }
      catch (error) {
        console.error(`[main] task ${entry.taskId} catalog service bindings could not be read: ${errorMessage(error)}`);
        return;
      }
      if (resolved.key === entry.catalogServicesKey) return;
      const origin = { kind: "service-catalog", senderWebContentsId } as const;
      for (const launch of resolved.launches) {
        try {
          await entry.client.task({
            workspaceId: this.workspaceId,
            taskId: entry.taskId,
            op: "task/registerService",
            payload: { serviceId: launch.serviceId, descriptor: launch.descriptor, layers: launch.layers, templateVersion: String(launch.templateVersion) },
            origin,
          });
        } catch (error) {
          console.error(`[main] task ${entry.taskId} service ${launch.serviceId} could not be registered from its confirmed catalog binding: ${errorMessage(error)}`);
        }
      }
      // Recorded even when a launch failed: that binding's own failure is named
      // above, and any change to it (or a rebuilt Host) retries.
      entry.catalogServicesKey = resolved.key;
    }).finally(() => { entry.catalogServicesPending = undefined; });
    entry.catalogServicesPending = bootstrap;
    return bootstrap;
  }

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

  private bindHostRequests(entry: PerTaskHostEntry): HostClient {
    const client = entry.client;
    client.onBrowserRequest(async (params) =>
      this.browsers
        ? this.browsers.handleRequest(params)
        : { ok: false, error: "browser-unavailable: 主进程未挂载任务浏览器能力" },
    );
    // The task identity is THIS child's own binding (`entry.taskId`, fixed when
    // main forked it), never a payload field: the handler refuses a request that
    // names another task.
    client.onServiceTemplateRequest(async (params) =>
      this.serviceTemplates
        ? await this.serviceTemplates(entry.taskId)(params)
        : { ok: false, error: "template-unavailable: 主进程未挂载共享模板通道" },
    );
    return client;
  }

  /** Hosts currently forked (test seam: no Electron needed). */
  get size(): number {
    return this.byTaskDir.size;
  }

  hasTaskDir(taskDir: string): boolean {
    return this.byTaskDir.has(normalizeTaskPath(taskDir));
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

  /**
   * Non-throwing owner-binding state of one task's forked Host ([PiDock 04] #7
   * slice): `absent` when no Host is forked (the next fork binds the current
   * revision), `current` when the forked Host's owner binding still matches the
   * authoritative catalog revision, `fenced` when it does not - which is the
   * real state in which the Host refuses start/stop with
   * `service-owner-inventory-unconfirmed`.
   */
  serviceOwnerState(taskId: string): "absent" | "current" | "fenced" {
    if (!this.services) return "absent";
    const entry = this.entryForTaskId(taskId);
    return entry ? this.services.state(entry.child, entry.taskId) : "absent";
  }

  /** Per-service owner-contract difference of the task's forked Host against the current catalog; `null` when unresolvable. */
  serviceOwnerChanges(taskId: string): ServiceOwnerChange[] | null {
    const entry = this.entryForTaskId(taskId);
    return entry && this.services ? this.services.changes(entry.child, entry.taskId) : null;
  }

  /** Durable owner records main can still read for a fenced binding; `null` when main holds no usable lease. */
  serviceOwnerOwners(taskId: string): ServiceOwnerDurableRecord[] | null {
    const entry = this.entryForTaskId(taskId);
    return entry && this.services ? this.services.owners(entry.child, entry.taskId) : null;
  }

  /**
   * Replace one task's owner binding at the current catalog revision ([PiDock 04]
   * #7 slice): the forked Host keeps running and only its owner binding and
   * durable lease are replaced, so a fenced start/stop channel is restored
   * without stopping anything. Idempotent when the task has no forked Host
   * (`absent`) or is already current; refuses by name while an op of the same
   * task is already in flight. A start/stop still admitted during the swap
   * cannot observe a half-replaced owner: the replaced inventory is sealed and
   * fenced before the replacement subscribes, so the Host refuses it by name
   * instead of starting anything (`HostTaskAdmission` tracks in-flight ops; it
   * is not a mutex).
   */
  rebindServiceOwner(taskId: string): Promise<"absent" | "current" | "rebound"> {
    this.assertRoutingOpen();
    if (!this.services) throw Error("service-owner-authority-unavailable");
    const entry = this.entryForTaskId(taskId);
    if (!entry) return Promise.resolve("absent" as const);
    if (this.activeTaskOps.get(taskId) || this.rebindings.has(taskId)) throw Error("service-owner-rebind-busy");
    const services = this.services;
    this.rebindings.add(taskId);
    return this.admission.run(() => services.rebind(entry.child, entry.taskId))
      .then((result) => (result === "current" ? "current" as const : "rebound" as const))
      .finally(() => { this.rebindings.delete(taskId); });
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
  routeTaskOp(params: {
    taskId: string;
    op: HostTaskOp;
    payload?: Record<string, unknown>;
    /** Main-stamped sender attestation; forwarded verbatim. */
    origin?: TaskOpOrigin;
  }): Promise<HostTaskResult> {
    return this.admission.run(async () => {
      const { taskId } = params;
      this.activeTaskOps.set(taskId, (this.activeTaskOps.get(taskId) ?? 0) + 1);
      try { return await this.routeAcceptedTaskOp(params); }
      finally {
        const remaining = this.activeTaskOps.get(taskId)! - 1;
        if (remaining) this.activeTaskOps.set(taskId, remaining);
        else this.activeTaskOps.delete(taskId);
      }
    });
  }

  private async routeAcceptedTaskOp(params: {
    taskId: string; op: HostTaskOp; payload?: Record<string, unknown>; origin?: TaskOpOrigin;
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
        if (this.identities.has(normalizeTaskPath(existing.taskDir))) this.taskMoved(taskId);
        // A Host may have persisted the task before its first index write failed.
        // Explicit provision retry verifies that record and retries the index.
        await this.taskRoots.register(existing.taskDir);
      }
      this.assertRoutingOpen();
      this.verifyTaskClaim(existing);
      if (op !== "task/provision") {
        await this.prepareServices(existing);
        await this.registerCatalogServices(existing, origin?.senderWebContentsId);
      }
      this.assertRoutingOpen();
      const result = await existing.client.task({ workspaceId: this.workspaceId, taskId, op, payload, origin },
        op === "task/sdkCancel" || op === "task/quit" ? { timeoutMs: 120_000 } : undefined);
      if (op === "task/provision") await this.indexProvisionedHost(existing);
      return result;
    }
    const taskDir = this.resolveTaskDir(taskId);
    const provisionDir =
      op === "task/provision" && taskDir === null
        ? this.resolveProvisionTaskDir(taskId, payload ?? {})
        : null;
    if (op === "task/provision" && taskDir === null && provisionDir !== null) {
      if (this.taskRoots && !this.taskRoots.isRootAvailable(path.dirname(provisionDir))) {
        throw new TrustDomainViolation("invalid-payload", "task root index unavailable; repair before provisioning");
      }
      const entry = await this.claimTaskHost(taskId, provisionDir, true);
      this.assertRoutingOpen();
      this.verifyTaskClaim(entry, payload ?? {});
      const result = await entry.client.task({ workspaceId: this.workspaceId, taskId, op, payload, origin });
      await this.indexProvisionedHost(entry);
      return result;
    }
    if (taskDir === null || !isAbsoluteTaskRoot(taskDir)) {
      throw new TrustDomainViolation(
        "invalid-payload",
        `unknown task: ${taskId} (no task record; provision the task before sending ops)`,
      );
    }
    const entry = await this.claimTaskHost(taskId, taskDir, false);
    this.assertRoutingOpen();
    this.verifyTaskClaim(entry);
    if (op !== "task/provision") {
      await this.prepareServices(entry);
      await this.registerCatalogServices(entry, origin?.senderWebContentsId);
    }
    this.assertRoutingOpen();
    return entry.client.task({ workspaceId: this.workspaceId, taskId, op, payload, origin },
      op === "task/sdkCancel" || op === "task/quit" ? { timeoutMs: 120_000 } : undefined);
  }

  private assertRoutingOpen(): void {
    if (this.closing) throw Error("task-host-closing");
  }

  private taskMoved(taskId: string): never {
    throw new TrustDomainViolation("invalid-payload", `task-moved: ${taskId} no longer resolves to the forked task identity; re-provision or restart before sending ops`);
  }

  private sameIdentity(a: VerifiedTaskIdentity | null, b: VerifiedTaskIdentity | null): boolean {
    if (!a || !b) return a === b;
    return a.taskId === b.taskId && a.createdAt === b.createdAt && a.root === b.root &&
      a.dirId === b.dirId && a.realRoot === b.realRoot &&
      a.directoryDevice === b.directoryDevice && a.directoryInode === b.directoryInode;
  }

  private verifyTaskClaim(entry: PerTaskHostEntry, bootstrapPayload?: Record<string, unknown>, requireCachedIdentity = false): void {
    const { taskId, taskDir } = entry;
    const current = this.resolveTaskDir(taskId);
    const fallback = bootstrapPayload
      ? this.resolveProvisionTaskDir(taskId, bootstrapPayload)
      : !this.taskRoots && this.overrideTaskDirStillOurs(taskId, taskDir) ? taskDir : null;
    const resolved = current ?? fallback;
    if (resolved === null || normalizeTaskPath(resolved) !== normalizeTaskPath(taskDir)) this.taskMoved(taskId);
    const identity = this.identities.get(normalizeTaskPath(taskDir));
    if (this.taskRoots && requireCachedIdentity && !identity) this.taskMoved(taskId);
    if (identity && !this.sameIdentity(identity, this.taskRoots?.verifiedIdentity(taskId) ?? null)) this.taskMoved(taskId);
  }

  private async indexProvisionedHost(entry: PerTaskHostEntry): Promise<void> {
    if (!this.taskRoots) return;
    await this.taskRoots.register(entry.taskDir);
    const identity = this.taskRoots.verifiedIdentity(entry.taskId);
    if (!identity) this.taskMoved(entry.taskId);
    const key = normalizeTaskPath(entry.taskDir);
    const original = this.identities.get(key);
    if (original && !this.sameIdentity(original, identity)) this.taskMoved(entry.taskId);
    this.identities.set(key, identity);
  }

  private claimTaskHost(taskId: string, taskDir: string, bootstrap: boolean): Promise<PerTaskHostEntry> {
    const key = normalizeTaskPath(taskDir);
    const identity = this.taskRoots?.verifiedIdentity(taskId) ?? null;
    if (this.taskRoots && !bootstrap && !identity) this.taskMoved(taskId);
    const sameTask = [...this.pendingHosts.values()].find((claim) => claim.taskId === taskId);
    if (sameTask && normalizeTaskPath(sameTask.taskDir) !== key) this.taskMoved(taskId);
    const pending = this.pendingHosts.get(key);
    if (pending) {
      if (pending.taskId !== taskId || !this.sameIdentity(pending.identity, identity)) this.taskMoved(taskId);
      return pending.promise;
    }
    const owned = this.byTaskDir.get(key);
    if (owned) {
      if (owned.taskId !== taskId) this.taskMoved(taskId);
      return Promise.resolve(owned);
    }
    // Publish ownership before invoking even a reentrant spawn. A late child
    // remains owned after sealing or deadline expiry; no business op is replayed.
    const promise = Promise.resolve().then(() => this.spawn(this.workspaceId, { taskId, taskDir })).then((spawned) => {
      const entry = { taskId, taskDir, client: spawned.client, child: spawned.child };
      this.byTaskDir.set(key, entry);
      let resolveExit!: () => void;
      const exit = { exited: false, receipt: new Promise<void>((done) => { resolveExit = done; }) };
      this.hostExits.set(entry.child, exit);
      entry.child.once("exit", () => { exit.exited = true; resolveExit(); });
      const dirs = this.byTaskId.get(taskId) ?? new Set<string>();
      dirs.add(key); this.byTaskId.set(taskId, dirs);
      if (identity) this.identities.set(key, identity);
      this.bindHostRequests(entry);
      return entry;
    });
    this.pendingHosts.set(key, { taskId, taskDir, identity, promise });
    void promise.then(() => { this.pendingHosts.delete(key); }, (error: unknown) => {
      this.pendingHosts.delete(key);
      this.spawnFailures.set(key, { taskId, error: errorMessage(error) });
    });
    return promise;
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
  quitAll(input: { origin: TaskOpOrigin; label?: string }): Promise<TaskHostsQuitReport> {
    const payloadCheck = validateHostTaskOp("task/quit", input.label === undefined ? {} : { label: input.label });
    if (!payloadCheck.ok) return Promise.reject(Error(payloadCheck.error));
    const caller = classifyControlCaller(input);
    if (!caller.ok) return Promise.reject(Error(caller.error));
    if (caller.kind !== "human") return Promise.reject(Error("permission-denied: main quit requires an attested UI caller"));
    if (this.quitReceipt) return this.quitReceipt;
    this.closing = true;
    this.admission.seal();
    let expired = false;
    const completed = new Map<string, TaskHostQuitResult>();
    const work = (async (): Promise<TaskHostsQuitReport> => {
      await Promise.allSettled([...this.pendingHosts.values()].map((claim) => claim.promise));
      if (expired) return { ok: false, tasks: [] };
      const payload: Record<string, unknown> = input.label === undefined ? {} : { label: input.label };
      // Host quit cancels accepted prompts/tools. Fan out before waiting for
      // main routes: their terminal state can depend on that cancellation.
      await Promise.all([...this.byTaskDir.values()].map(async (entry) => {
        let task: TaskHostQuitResult;
        try {
          // Quit is a lifecycle write. With the production task-root index,
          // a cached Host must not receive it after its task directory has
          // been replaced or re-created at the same path. Legacy no-index
          // seams keep the Host's own disk-identity refusal as their guard.
          if (this.taskRoots) this.verifyTaskClaim(entry, undefined, true);
          await this.prepareServices(entry);
          const result = await entry.client.task({
            workspaceId: this.workspaceId, taskId: entry.taskId,
            op: "task/quit", payload, origin: input.origin,
          }, { timeoutMs: 120_000 });
          if (!result || typeof result !== "object" || Array.isArray(result) ||
            result.workspaceId !== this.workspaceId || result.taskId !== entry.taskId || result.op !== "task/quit" ||
            !result.payload || typeof result.payload !== "object" || Array.isArray(result.payload)) throw Error("host-quit-report-invalid");
          const quit = (result.payload as { quit?: { applied?: string[]; plan?: { failures?: unknown[]; retainedTasks?: string[] } } }).quit;
          if (!quit || !Array.isArray(quit.applied) || ![...quit.applied].every((item) => typeof item === "string") ||
            !quit.plan || !Array.isArray(quit.plan.failures) || !Array.isArray(quit.plan.retainedTasks) ||
            ![...quit.plan.retainedTasks].every((item) => typeof item === "string")) throw Error("host-quit-report-invalid");
          if (this.services && quit.plan.failures.length === 0 && quit.plan.retainedTasks.length === 0) this.services.confirm(entry.child, (result.payload as Record<string, unknown>).serviceOwner);
          task = { taskId: entry.taskId, ok: true, applied: [...quit.applied], failures: [...quit.plan.failures], retainedTasks: [...quit.plan.retainedTasks] };
        } catch (error) {
          // #84 (B): with the task-root index, a Host whose verified identity
          // main never cached is one forked by a `task/provision` that failed at
          // or after the index step - every later op, the quit write included, is
          // refused by name for it. Retaining that process is what left a failed
          // creation's Host alive for the whole session and kept `stopHosts()`
          // false forever; main terminates what it can no longer address instead.
          // A Host whose cached identity merely moved keeps the retain-without-
          // write behaviour above, so its state folder is never written twice.
          task = this.taskRoots && !this.identities.has(normalizeTaskPath(entry.taskDir))
            ? await this.terminateUnverifiedHost(entry, error)
            : { taskId: entry.taskId, ok: false, applied: [], failures: [], retainedTasks: [entry.taskId], error: errorMessage(error) };
        }
        completed.set(entry.taskId, task);
      }));
      await this.admission.drain();
      for (const failure of this.spawnFailures.values()) {
        const previous = completed.get(failure.taskId);
        completed.set(failure.taskId, {
          taskId: failure.taskId, ok: false, applied: previous?.applied ?? [], failures: previous?.failures ?? [],
          retainedTasks: [...new Set([...(previous?.retainedTasks ?? []), failure.taskId])], error: failure.error,
        });
      }
      const ids = new Set([...this.byTaskDir.values()].map((entry) => entry.taskId));
      for (const taskId of completed.keys()) ids.add(taskId);
      const tasks = [...ids].map((taskId) => completed.get(taskId)!);
      return { ok: tasks.every((task) => task.ok && task.failures.length === 0 && task.retainedTasks.length === 0), tasks };
    })();
    // One budget covers ownership, Host cancellation/report, and main drain.
    // Expiry bounds only this receipt, not the lifetime of owned work.
    this.quitReceipt = shutdownDeadline(work, 15_000, "main-task-shutdown-unconfirmed").then((report) => {
      this.quitConfirmed = report.ok;
      return report;
    }, (error: unknown) => {
      expired = true;
      const ids = new Set([
        ...[...this.byTaskDir.values()].map((entry) => entry.taskId),
        ...[...this.pendingHosts.values()].map((claim) => claim.taskId),
        ...[...this.spawnFailures.values()].map((failure) => failure.taskId),
        ...this.activeTaskOps.keys(),
      ]);
      return { ok: false, tasks: [...ids].map((taskId) => ({
        taskId, ok: false, applied: completed.get(taskId)?.applied ?? [],
        failures: completed.get(taskId)?.failures ?? [], retainedTasks: [taskId], error: errorMessage(error),
      })) };
    });
    return this.quitReceipt;
  }

  /**
   * Terminate the Host main forked for a creation that never established a
   * verified task identity, and drop the ownership of it (#84 box B).
   *
   * Main refuses every op for such a Host - the quit write included, because a
   * task whose disk identity was never verified must not be handed a lifecycle
   * write - so the only stop left is termination. The exit is observed before
   * the report may claim the Host is gone, and the task is still reported as not
   * stopped cleanly, because no lifecycle write reached it. An unkillable child
   * stays owned so the sealed registry still names the process it did not stop.
   */
  private async terminateUnverifiedHost(entry: PerTaskHostEntry, refusal: unknown): Promise<TaskHostQuitResult> {
    const refusalMessage = errorMessage(refusal);
    const exit = this.hostExits.get(entry.child);
    entry.client.dispose();
    if (exit && !exit.exited) entry.child.kill();
    let exited = exit?.exited ?? false;
    if (exit && !exited) {
      try { await shutdownDeadline(exit.receipt, 5_000, "unverified-host-exit-unconfirmed"); exited = true; }
      catch { exited = false; }
    }
    if (exited) {
      const key = normalizeTaskPath(entry.taskDir);
      this.byTaskDir.delete(key);
      const dirs = this.byTaskId.get(entry.taskId);
      if (dirs) { dirs.delete(key); if (!dirs.size) this.byTaskId.delete(entry.taskId); }
      this.identities.delete(key);
      this.hostExits.delete(entry.child);
    }
    return {
      taskId: entry.taskId, ok: false, applied: [], failures: [],
      retainedTasks: exited ? [] : [entry.taskId],
      error: `${refusalMessage}; main ${exited ? "terminated" : "could not terminate"} the Host forked for this task (no verified task identity, so no lifecycle write was sent)`,
    };
  }

  /** Success requires observed exits and durable writer disposal; failure retains the sealed registry. */
  disposeAll(): Promise<void> {
    if (this.disposalReceipt) return this.disposalReceipt;
    if (!this.quitConfirmed || this.pendingHosts.size || this.activeTaskOps.size) {
      throw Error("main-task-shutdown-unconfirmed");
    }
    let expired = false;
    const work = Promise.resolve().then(async () => {
      const entries = [...this.byTaskDir.values()];
      const settled = Promise.all([
        ...entries.map((entry) => this.hostExits.get(entry.child)!.receipt),
        this.services?.disposeWhenExited(),
      ]);
      // Observe the authority receipt even when a synchronous dispose/signal request fails.
      void settled.catch(() => {});
      for (const entry of entries) {
        entry.client.dispose();
        if (!this.hostExits.get(entry.child)!.exited) entry.child.kill();
      }
      await settled;
      if (expired) throw Error("main-task-disposal-unconfirmed");
      this.byTaskDir.clear();
      this.byTaskId.clear();
      this.identities.clear();
      this.hostExits.clear();
    });
    this.disposalReceipt = shutdownDeadline(work, 15_000, "main-task-disposal-unconfirmed").catch((error: unknown) => {
      expired = true;
      throw error;
    });
    return this.disposalReceipt;
  }
}

export function createHostStopper(tasks: Pick<PerTaskHostRegistry, "quitAll">, origin: TaskOpOrigin, onStopped: () => void | Promise<void>): HostStopper {
  let pending: Promise<boolean> | undefined;
  let disposalRequested = false;
  let unsatisfied: string[] = [];
  const stop = (() => {
    if (pending) return pending;
    pending = tasks.quitAll({ origin, label: "应用退出" }).then(async (report) => {
      unsatisfied = report.tasks.filter((task) => !task.ok || task.retainedTasks.length).map((task) => task.taskId);
      console.log(`[main] quit report: ${JSON.stringify(report)}`);
      if (!report.ok) {
        console.error(`[main] unresolved Host shutdown; retaining processes: ${JSON.stringify(report.tasks.filter((task) => !task.ok || task.retainedTasks.length))}`);
        return false;
      }
      disposalRequested = true;
      await onStopped();
      return true;
    }).catch((error: unknown) => {
      console.error(`[main] quit report failed; retaining Hosts: ${errorMessage(error)}`);
      return false;
    }).then((stopped) => {
      if (!stopped && !disposalRequested) pending = undefined;
      return stopped;
    });
    return pending;
  }) as HostStopper;
  stop.unsatisfiedHosts = () => [...unsatisfied];
  return stop;
}

/**
 * Ordered quit of every forked Host, plus the last attempt's named refusals.
 *
 * The window-close path destroys the only window a windowless platform can
 * show, so its escalation has to name what did not stop by itself (#84 box A).
 */
export interface HostStopper {
  (): Promise<boolean>;
  /** Task ids the last quit report stopped neither cleanly nor at all; empty before the first attempt. */
  unsatisfiedHosts(): string[];
}

/**
 * Bounded last-window shutdown.
 *
 * `window-all-closed` on a platform without background continuation leaves no
 * window to report from, so an unstopped Host must not be retried silently
 * forever (#84: an unbounded 5 s retry left a windowless main process alive for
 * 11 hours and blocked a covering install). The attempts are bounded by count
 * and by wall clock - whichever trips first - and the exhausted path names every
 * task whose Host was not stopped cleanly before handing the exit to
 * `onExhausted`, which owns leaving the app without a window.
 */
export interface LastWindowShutdownPolicy {
  /** Delay between attempts. The bound is the attempt count, never this delay. */
  retryMs: number;
  /** Attempts allowed before escalation; 1 means no retry (the first attempt only). */
  maxAttempts: number;
  /** Wall-clock budget for the whole sequence, so one hanging attempt cannot retry forever. */
  timeoutMs: number;
  /** Task ids the last quit report did not stop cleanly, for the escalation message. */
  unsatisfiedHosts: () => string[];
  /** Escalation after exhaustion: the only remaining convergence is leaving the app. */
  onExhausted: (evidence: { attempts: number; unsatisfied: string[] }) => void;
}

export function createLastWindowShutdown(stopHosts: () => Promise<boolean>, onStopped: () => void, policy: LastWindowShutdownPolicy): () => Promise<void> {
  let pending: Promise<void> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let budget: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let finished = false;
  const exhaust = (): void => {
    if (finished) return;
    finished = true;
    if (retry) { clearTimeout(retry); retry = undefined; }
    if (budget) { clearTimeout(budget); budget = undefined; }
    const unsatisfied = policy.unsatisfiedHosts();
    console.error(
      `[main] last-window shutdown did not converge after ${attempts} attempt(s) (retry ${policy.retryMs} ms, budget ${policy.timeoutMs} ms); Hosts that did not stop cleanly: ${unsatisfied.length ? unsatisfied.join(", ") : "none named by the quit report"}`,
    );
    policy.onExhausted({ attempts, unsatisfied });
  };
  const attempt = (): Promise<void> => {
    if (finished) return Promise.resolve();
    if (pending) return pending;
    if (attempts === 0) budget = setTimeout(exhaust, policy.timeoutMs);
    attempts += 1;
    pending = Promise.resolve().then(stopHosts).catch((error: unknown) => {
      console.error(`[main] last-window shutdown failed: ${errorMessage(error)}`);
      return false;
    }).then((stopped) => {
      // A budget that ran out while this attempt was in flight owns the exit.
      if (finished) return;
      if (stopped) {
        finished = true;
        if (retry) clearTimeout(retry);
        if (budget) clearTimeout(budget);
        onStopped();
      } else if (attempts >= policy.maxAttempts) {
        exhaust();
      } else if (!retry) {
        console.error(`[main] Host shutdown remains pending; retrying in ${policy.retryMs} ms`);
        retry = setTimeout(() => { retry = undefined; void attempt(); }, policy.retryMs);
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

/**
 * The named production refusal for catalog-driven service execution on a
 * platform where ownership cannot be verified ([PiDock 04] #7, [PiDock 04]
 * #48). #48 delivered the prerequisite the previous block waited for: the
 * durable `(pid, 128-bit nonce)` launch identity, tri-state verification
 * (verified / mismatch / unobservable), "no signal without verified evidence
 * in the same call", descendant reclaim only from positive process-group
 * evidence, and an explicit `unsupported-platform` refusal on win32. The
 * remaining platform boundary is exactly the one #48 chose: POSIX (darwin,
 * linux) can verify and terminate a launch; every other platform is refused
 * fail-closed under the same wording, so production re-opens only where the
 * ownership module can actually answer "is this pid our launch?".
 */
export const SERVICE_EXECUTION_UNSUPPORTED_PLATFORM =
  "unsupported-platform: 服务启动身份核验与终止仅在 POSIX（darwin/linux）实现，本平台按 #48 拒绝执行（见 #48/#7）";

/**
 * The audit label main stamps on every catalog-driven service control
 * ([PiDock 04] #7). `runTaskService` has exactly one main-side entry
 * (`shell/serviceCatalogOp {op:"runTaskService"}`), which now serves both the
 * environment settings page and the task dock's run panel, so the label names
 * that entry instead of a specific page that would be wrong for one of the
 * two callers. It is main-built and never page-supplied: `parseServiceRunRequest`
 * rejects any key outside `{op,projectId,taskId,serviceId,action}`.
 */
export const SERVICE_RUN_HUMAN_LABEL = "主进程服务目录入口";

/**
 * The pure production gate for catalog-driven service execution: `null` when
 * execution is authorized, the named `/^unsupported-platform/` refusal when it
 * is not. It takes no caller input on purpose - no page- or caller-supplied
 * value may unlock execution on a platform whose ownership evidence cannot be
 * read - and the production trigger checks it before resolving a launch or
 * reaching any spawn-capable call.
 */
export function serviceExecutionRefusal(): string | null {
  return serviceExecutionAdmitted() ? null : SERVICE_EXECUTION_UNSUPPORTED_PLATFORM;
}

/**
 * Resolve the trusted launch for one task-bound service and drive the task
 * Host with it ([PiDock 04] #7): register the descriptor/layers/pinned
 * version, then start or stop through `task/controlService`. Registration
 * failure stops the sequence - main never asks the Host to control a
 * service it could not describe. Both ops carry the same main-built
 * `service-catalog` origin; neither the page nor the Host may supply it.
 *
 * Exported so the sequence can be driven end to end against a real Host and a
 * real child process without an Electron `IpcMainInvokeEvent`. The production
 * IPC trigger (`shell/serviceCatalogOp {op:"runTaskService"}`) calls it after
 * `serviceExecutionRefusal`, so the authorized platform and this seam run the
 * same sequence.
 */
export async function runTaskService(
  tasks: Pick<PerTaskHostRegistry, "routeTaskOp">,
  catalog: Pick<ServiceCatalog, "launchFor">,
  request: ReturnType<typeof parseServiceRunRequest>,
  senderWebContentsId: number,
): Promise<Record<string, unknown>> {
  const launch = catalog.launchFor(request.taskId, request.projectId, request.serviceId, process.env);
  const origin = { kind: "service-catalog", senderWebContentsId } as const;
  try {
    await tasks.routeTaskOp({
      taskId: request.taskId,
      op: "task/registerService",
      payload: {
        serviceId: launch.serviceId, descriptor: launch.descriptor, layers: launch.layers, templateVersion: String(launch.templateVersion),
        // Box 6: main reads the worktree the verified launch cwd lives in, right
        // before the start, and the registration carries either that observation
        // or the named reason it could not be made. The Host never fills the code
        // state in from a claim of its own. A `stop` records no run, so its code
        // state is not a fact the record needs: observing it would be pure cost
        // (two blocking git reads on main's event loop), so it is a start-only
        // read.
        ...(request.action === "start" ? codeObservationFields(launch.descriptor.cwd) : {}),
      },
      origin,
    });
  } catch (error) {
    // A failed registration never becomes a control request.
    throw new Error(`服务登记失败，未发起启停：${error instanceof Error ? error.message : String(error)}`);
  }
  const controlled = await tasks.routeTaskOp({
    taskId: request.taskId,
    op: "task/controlService",
    payload: { serviceId: launch.serviceId, action: request.action, label: SERVICE_RUN_HUMAN_LABEL },
    origin,
  });
  return controlled.payload;
}

/**
 * Start the task's planned run unit group ([PiDock 05] #10 box 4) - the
 * production caller `task/controlService {group:true}` never had.
 *
 * Main owns the group's MEMBERSHIP: it resolves the task's bound services from
 * the trusted persisted catalog, registers each trusted launch on the task Host
 * (the same `task/registerService` the single path uses, so the Host never
 * executes a launch it cannot describe) and then forwards ONE group start
 * through the SAME gated `task/controlService` every unit already goes through.
 * Nothing here spawns, signals or re-plans a unit, and the page supplies no unit
 * list - `parseServiceRunGroupRequest` accepts `{op,projectId,taskId}` only.
 *
 * Plan source, stated instead of implied: main is the ONLY writer of the plan a
 * group start runs. It writes the task's group from its own trusted catalog
 * BEFORE every start (units = the task's bound services, ports = the ports their
 * registrations declare, run type = the template's own, edges = the pinned
 * revisions' 服务依赖声明, binding rules + config layers = the same trusted read),
 * so a plan the dock's own topology read left on the Host - which carries no
 * declaration-derived edge and no rules/layers - can never decide what this start
 * runs. The plan's resolved task-override rows are then re-registered as the
 * Before the one gated control dispatch, main holds loopback TCP bind
 * reservations for every assigned port. An occupied port is fed back through the
 * same Host planner once; its complete task-address rows and the target service's
 * matching PORT row are re-resolved and re-registered before the single retry.
 *
 * The edges of that plan are the 服务依赖声明 of the revisions the task pins
 * (ADR 0002), mapped onto the plan's own unit ids: a declared `call`/`prestart`
 * edge is what makes the Host's real linkage step run for it, so 已互验 is
 * reachable in the shipped app WITHOUT anybody synthesising an edge. A revision
 * that declares nothing contributes none - the group then starts and listens but
 * has nothing to 互验, which the panel names instead of implying a linkage nobody
 * observed.
 *
 * Fail-closed: an unresolvable launch, an unbound task, a declared dependency
 * whose target is not bound to this task or a plan whose ports conflict refuses
 * the whole request by name BEFORE any unit is dispatched (a unit dropped from
 * the group could otherwise leave a green group missing a bound service).
 */
export async function runTaskServiceGroup(
  tasks: Pick<PerTaskHostRegistry, "routeTaskOp">,
  catalog: Pick<ServiceCatalog, "launchFor" | "taskBindings">,
  request: ReturnType<typeof parseServiceRunGroupRequest>,
  senderWebContentsId: number,
): Promise<Record<string, unknown>> {
  const origin = { kind: "service-catalog", senderWebContentsId } as const;
  const bindings = catalog.taskBindings(request.projectId, request.taskId);
  if (bindings.length === 0) {
    throw new Error("service-group-empty: 该任务在可信服务目录中没有已绑定的服务，未发起整组启动");
  }
  const bound = bindings.map(({ binding, template }) => {
    try {
      // The revision the binding PINS carries the launch material AND the
      // declaration the plan's edges come from; both are read from main's own
      // store, never from a page or a Host answer.
      return { binding, template, launch: catalog.launchFor(request.taskId, request.projectId, binding.serviceId, process.env) };
    } catch (error) {
      // `service-launch-unavailable` is main's fixed code and carries no path or
      // value, so it is safe to name verbatim beside the offending service. A
      // failed registration never becomes a control request.
      throw new Error(`服务登记失败，未发起整组启动：${binding.serviceId} 的启动材料无法从可信服务目录解析（${error instanceof Error ? error.message : String(error)}）`);
    }
  });
  // Box 6: the SAME per-unit worktree observation the single-service path makes,
  // read by main once per launch and carried by BOTH registrations below, so the
  // two cannot disagree about the code state a start really ran from.
  const observationOf = new Map(
    bound.map(({ launch }) => [launch.serviceId, codeObservationFields(launch.descriptor.cwd)] as const),
  );
  for (const { launch } of bound) {
    try {
      await tasks.routeTaskOp({
        taskId: request.taskId,
        op: "task/registerService",
        payload: {
          serviceId: launch.serviceId, descriptor: launch.descriptor, layers: launch.layers, templateVersion: String(launch.templateVersion),
          ...(observationOf.get(launch.serviceId) ?? {}),
        },
        origin,
      });
    } catch (error) {
      throw new Error(`服务登记失败，未发起整组启动：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // The plan is written from the catalog on EVERY group start, not only when the
  // Host happens to hold none. The Host's plan is also written by the dock's own
  // topology read (`task/planServiceGroup` over the visible projection), so the
  // old "start an existing plan as-is" branch would let a renderer-shaped,
  // edge-less plan decide what a group start runs - and the declared edges,
  // binding rules and config layers main derives here would never reach it.
  const initialPlan = await planBoundServiceGroup(tasks, bound, request, origin);
  const firstReservation = await reserveGroupPorts(initialPlan.assignments);
  if (firstReservation.failures.length > 0) {
    await releaseGroupPorts(firstReservation.held);
    return { group: portReservationFailure(initialPlan, bound, [...firstReservation.failures, ...firstReservation.occupied], []) };
  }

  let finalPlan = initialPlan;
  let portChanges: GroupPortChange[] = [];
  let ownPortRows: { serviceId: string; rows: ServiceConfigEntry[] }[] = [];
  let heldPorts = firstReservation.held;
  if (firstReservation.occupied.length > 0) {
    // The first bind attempt observed a real external occupant. Release every
    // successful bind, feed only those observed ports to the existing allocator,
    // then resolve the complete plan and its URL overrides again before retrying
    // the reservation exactly once.
    await releaseGroupPorts(heldPorts);
    heldPorts = [];
    const reservations: PortReservation[] = firstReservation.occupied.map(({ assignment }) => ({
      port: assignment.port,
      owner: "external",
      note: "启动前 TCP bind 检查返回 EADDRINUSE",
    }));
    finalPlan = await planBoundServiceGroup(tasks, bound, request, origin, reservations);
    portChanges = groupPortChanges(initialPlan, finalPlan, bound);
    const portRows = movedServicePortRows(finalPlan, bound);
    if (!portRows.ok) {
      const failure = {
        assignment: portRows.assignment,
        reason: portRows.reason,
        code: "port-unavailable",
      };
      return { group: portReservationFailure(finalPlan, bound, [failure], portChanges) };
    }
    ownPortRows = portRows.rows;
    const retryReservation = await reserveGroupPorts(finalPlan.assignments);
    if (retryReservation.occupied.length > 0 || retryReservation.failures.length > 0) {
      await releaseGroupPorts(retryReservation.held);
      const failures = [...retryReservation.occupied, ...retryReservation.failures];
      return { group: portReservationFailure(finalPlan, bound, failures, portChanges) };
    }
    heldPorts = retryReservation.held;
  }

  // The plan's resolved address overrides ARE the task's 任务覆盖, so they have to
  // reach the children. After an occupied-port reallocation, the same final task
  // rows are re-resolved with service-config's normal precedence; a moved target's
  // own PORT-like row is added only to that trusted service registration. This
  // updates its listener and every consumer without changing any launch identity.
  const serviceRows = new Map(ownPortRows.map(({ serviceId, rows }) => [serviceId, rows]));
  if (finalPlan.taskRows.length > 0 || serviceRows.size > 0) {
    for (const { launch } of bound) {
      const rows = mergeTaskConfigRows(finalPlan.taskRows, serviceRows.get(launch.serviceId) ?? []);
      const layers = { ...launch.layers, task: rows };
      const resolved = resolveServiceEnv(layers);
      if (!resolved.ok) {
        await releaseGroupPorts(heldPorts);
        throw new Error(`服务登记失败，未发起整组启动：${launch.serviceId} 的改址配置无法重新解析（${resolved.error.code}: ${resolved.error.message}）`);
      }
      try {
        await tasks.routeTaskOp({
          taskId: request.taskId,
          op: "task/registerService",
          payload: {
            serviceId: launch.serviceId, descriptor: launch.descriptor,
            layers,
            templateVersion: String(launch.templateVersion),
            ...(observationOf.get(launch.serviceId) ?? {}),
          },
          origin,
        });
      } catch (error) {
        await releaseGroupPorts(heldPorts);
        throw new Error(`服务登记失败，未发起整组启动：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  // Bind-then-release is a best-effort reservation: keep all sockets held until
  // every trusted registration is refreshed, then release immediately before
  // the existing gated Host dispatch. Another process can still win this narrow
  // hand-off race (TOCTOU), which the Host's normal named start failure retains.
  await releaseGroupPorts(heldPorts);
  const controlled = await tasks.routeTaskOp({
    taskId: request.taskId,
    op: "task/controlService",
    payload: { group: true, action: "start", label: SERVICE_RUN_HUMAN_LABEL },
    origin,
  });
  const group = controlled.payload["group"];
  if (typeof group !== "object" || group === null || Array.isArray(group)) return controlled.payload;
  return { ...controlled.payload, group: { ...(group as Record<string, unknown>), portChanges } };
}

/**
 * The task's own group plan, sent from main's trusted catalog to the Host: the
 * units, ports, run types, declaration-derived edges and the plan's binding rules
 * + config layers all come from `deriveBoundServiceGroupPlan`
 * (`./service-dependency-routing.js`), the SAME function main's read-only 依赖去向
 * read resolves without a Host - so the plan a group start runs and the values the
 * dock shows can never come from two derivations.
 *
 * What this function owns is the PAYLOAD convention for the three DERIVED
 * collections: `dependencies`, `rules` and `layers` are each omitted when the
 * trusted side derived no rows for it, while the plan's own spec keys (`units`,
 * `selectedRepoDirs`, `requests`, `runTypes`) are always sent as derived. An
 * absent `dependencies` is the honest "no declaration, no edge" plan (ADR 0002),
 * never an empty set that could read as a checked edge list. The other two keys
 * are omitted for INDEPENDENT reasons: an absent `rules` says no pinned revision
 * declared a dependency into a unit of this group (so no binding rule was
 * derived), and an absent `layers` says no config row was read at all - so
 * neither can read as a read-point audit that checked those rows and found them
 * clean.
 *
 * Returns the Host's derived plan collections, including its task-override rows
 * (`bindingsToTaskRows`), assignments, diagnostics and reallocation facts. The
 * caller applies those rows as the `task` layer of the trusted registrations.
 */
interface BoundHostGroupPlan {
  taskRows: ServiceConfigEntry[];
  assignments: PortAssignment[];
  reallocated: { unitId: string; before: number; after: number }[];
  units: RunUnit[];
  groups: StartGroup[];
  diagnostics: RunDiagnostic[];
  bindings: ResolvedBinding[];
}

async function planBoundServiceGroup(
  tasks: Pick<PerTaskHostRegistry, "routeTaskOp">,
  bound: BoundServiceEntry[],
  request: ReturnType<typeof parseServiceRunGroupRequest>,
  origin: { kind: "service-catalog"; senderWebContentsId: number },
  reservations: readonly PortReservation[] = [],
): Promise<BoundHostGroupPlan> {
  const derivation = deriveBoundServiceGroupPlan(bound);
  if (!derivation.ok) throw new Error(unsatisfiedDeclarationMessage(derivation.unsatisfied));
  const { units, dependencies, rules, layers, requests, runTypes, selectedRepoDirs } = derivation.plan;
  const layerRowCount = layers.repoDefaults.length + layers.shared.length + layers.privateEntries.length + layers.task.length;
  const answer = await tasks.routeTaskOp({
    taskId: request.taskId,
    op: "task/planServiceGroup",
    payload: {
      units,
      selectedRepoDirs,
      requests,
      runTypes,
      ...(reservations.length === 0 ? {} : { reservations }),
      // Sent ONLY when the pinned revisions really declare an edge: an empty or
      // absent key is the honest "no declaration, no edge" plan.
      ...(dependencies.length === 0 ? {} : { dependencies }),
      // The same convention: a key is present only when the trusted side really
      // derived rows/rules, so an absent `layers` reads as "no config row was read"
      // and never as a completed read-point audit over nothing.
      ...(rules.length === 0 ? {} : { rules }),
      ...(layerRowCount === 0 ? {} : { layers }),
    },
    origin,
  });
  return plannedGroupDataOf(answer.payload);
}

/**
 * The plan's own task-override rows, read back from the Host's plan answer.
 * Absent or malformed answers yield no rows instead of a fabricated override:
 * the plan's resolved addresses are the Host's allocation, so main never
 * derives them itself.
 */
function plannedTaskRowsOf(payload: Record<string, unknown>): ServiceConfigEntry[] {
  const plan = recordValue(payload["plan"]);
  const rows = plan?.["taskRows"];
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((entry) => {
    const row = recordValue(entry);
    const key = row?.["key"];
    const value = row?.["value"];
    const secret = row?.["secret"];
    if (typeof key !== "string" || key.trim().length === 0 || typeof value !== "string" || typeof secret !== "boolean") return [];
    return [{ key, value, secret }];
  });
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function plannedGroupDataOf(payload: Record<string, unknown>): BoundHostGroupPlan {
  const plan = recordValue(payload["plan"]);
  if (!plan) return { taskRows: [], assignments: [], reallocated: [], units: [], groups: [], diagnostics: [], bindings: [] };
  const assignments = Array.isArray(plan["assignments"]) ? plan["assignments"].flatMap((entry) => {
    const row = recordValue(entry);
    if (!row || typeof row["unitId"] !== "string" || typeof row["serviceId"] !== "string" || typeof row["port"] !== "number") return [];
    return [{ unitId: row["unitId"], serviceId: row["serviceId"], port: row["port"], instanceId: typeof row["instanceId"] === "string" ? row["instanceId"] : "" } satisfies PortAssignment];
  }) : [];
  const reallocated = Array.isArray(plan["reallocated"]) ? plan["reallocated"].flatMap((entry) => {
    const row = recordValue(entry);
    if (!row || typeof row["unitId"] !== "string" || typeof row["before"] !== "number" || typeof row["after"] !== "number") return [];
    return [{ unitId: row["unitId"], before: row["before"], after: row["after"] }];
  }) : [];
  const units = Array.isArray(plan["units"]) ? plan["units"].flatMap((entry) => {
    const row = recordValue(entry);
    if (!row || typeof row["unitId"] !== "string" || typeof row["serviceId"] !== "string" || typeof row["name"] !== "string" || (row["location"] !== "local" && row["location"] !== "remote")) return [];
    return [row as unknown as RunUnit];
  }) : [];
  const groups = Array.isArray(plan["groups"]) ? plan["groups"].flatMap((entry) => {
    const row = recordValue(entry);
    if (!row || typeof row["groupId"] !== "string" || !Array.isArray(row["members"])) return [];
    return [row as unknown as StartGroup];
  }) : [];
  const diagnostics = Array.isArray(plan["diagnostics"]) ? plan["diagnostics"].flatMap((entry) => {
    const row = recordValue(entry);
    if (!row || typeof row["code"] !== "string" || typeof row["message"] !== "string") return [];
    return [row as unknown as RunDiagnostic];
  }) : [];
  const bindings = Array.isArray(plan["bindings"]) ? plan["bindings"].flatMap((entry) => {
    const row = recordValue(entry);
    if (!row || typeof row["key"] !== "string" || typeof row["unitId"] !== "string" || typeof row["value"] !== "string") return [];
    return [row as unknown as ResolvedBinding];
  }) : [];
  return { taskRows: plannedTaskRowsOf(payload), assignments, reallocated, units, groups, diagnostics, bindings };
}

interface PortReservationIssue {
  assignment: PortAssignment;
  code: string;
  reason: string;
}

interface GroupPortReservation {
  held: Server[];
  occupied: PortReservationIssue[];
  failures: PortReservationIssue[];
}

/**
 * Hold IPv4 loopback TCP binds as a best-effort pre-spawn reservation. The shipped
 * service observation address is 127.0.0.1, so this matches its address family;
 * an IPv6-only listener can coexist and is not evidence of a conflicting bind for
 * this address. The close-before-spawn handoff remains a TOCTOU boundary.
 */
async function reserveGroupPorts(assignments: readonly PortAssignment[]): Promise<GroupPortReservation> {
  const held: Server[] = [];
  const occupied: PortReservationIssue[] = [];
  const failures: PortReservationIssue[] = [];
  for (const assignment of assignments) {
    const server = createServer((socket) => socket.destroy());
    const result = await new Promise<{ ok: true } | { ok: false; code: string; message: string }>((resolve) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.removeListener("listening", onListening);
        resolve({ ok: false, code: error.code ?? "bind-error", message: error.message });
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve({ ok: true });
      };
      server.once("error", onError);
      server.once("listening", onListening);
      try {
        server.listen({ port: assignment.port, host: "127.0.0.1", exclusive: true });
      } catch (error) {
        server.removeListener("error", onError);
        server.removeListener("listening", onListening);
        const failure = error instanceof Error ? error : new Error(String(error));
        resolve({ ok: false, code: (failure as NodeJS.ErrnoException).code ?? "bind-error", message: failure.message });
      }
    });
    if (result.ok) {
      held.push(server);
      continue;
    }
    const issue = { assignment, code: result.code, reason: result.message };
    (result.code === "EADDRINUSE" ? occupied : failures).push(issue);
  }
  return { held, occupied, failures };
}

async function releaseGroupPorts(servers: readonly Server[]): Promise<void> {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  })));
}

interface GroupPortChange {
  unitId: string;
  serviceId: string;
  before: number;
  after: number;
  consumers: string[];
}

function groupPortChanges(previous: BoundHostGroupPlan, next: BoundHostGroupPlan, bound: readonly BoundServiceEntry[]): GroupPortChange[] {
  const beforeByKey = new Map(previous.taskRows.map((row) => [row.key, row.value]));
  return next.reallocated.map((change) => {
    const unit = next.units.find((candidate) => candidate.unitId === change.unitId);
    const serviceId = unit?.serviceId ?? bound.find(({ binding }) => `${binding.rootId}:${binding.serviceId}` === change.unitId)?.launch.serviceId ?? change.unitId;
    const changedKeys = new Set(next.bindings
      .filter((binding) => binding.unitId === change.unitId && beforeByKey.get(binding.key) !== binding.value)
      .map((binding) => binding.key));
    const consumers = bound.flatMap(({ launch }) => {
      if (launch.serviceId === serviceId || changedKeys.size === 0) return [];
      const resolved = resolveServiceEnv(launch.layers);
      if (!resolved.ok) return [];
      return resolved.rows.some((row) => changedKeys.has(row.key)) ? [launch.serviceId] : [];
    });
    return { unitId: change.unitId, serviceId, before: change.before, after: change.after, consumers };
  });
}

function movedServicePortRows(
  plan: BoundHostGroupPlan,
  bound: readonly BoundServiceEntry[],
): { ok: true; rows: { serviceId: string; rows: ServiceConfigEntry[] }[] } | { ok: false; assignment: PortAssignment; reason: string } {
  const rows: { serviceId: string; rows: ServiceConfigEntry[] }[] = [];
  for (const change of plan.reallocated) {
    const assignment = plan.assignments.find((candidate) => candidate.unitId === change.unitId);
    const entry = bound.find(({ launch }) => launch.serviceId === assignment?.serviceId);
    if (!assignment || !entry) return { ok: false, assignment: assignment ?? { unitId: change.unitId, serviceId: change.unitId, port: change.after, instanceId: "" }, reason: "改址目标不在可信服务登记中" };
    const resolved = resolveServiceEnv(entry.launch.layers);
    if (!resolved.ok) return { ok: false, assignment, reason: `原启动配置无法解析：${resolved.error.code}: ${resolved.error.message}` };
    const portRows = resolved.rows.filter((row) => /PORT$/.test(row.key) && Number(row.value) === change.before);
    if (portRows.length === 0) return { ok: false, assignment, reason: `可信服务「${assignment.serviceId}」没有可改写原端口 ${change.before} 的 PORT 配置` };
    rows.push({
      serviceId: assignment.serviceId,
      rows: portRows.map((row) => ({ key: row.key, value: String(change.after), secret: row.secret })),
    });
  }
  return { ok: true, rows };
}

function mergeTaskConfigRows(taskRows: readonly ServiceConfigEntry[], ownPortRows: readonly ServiceConfigEntry[]): ServiceConfigEntry[] {
  const rows = new Map(taskRows.map((row) => [row.key, row]));
  for (const row of ownPortRows) rows.set(row.key, row);
  return [...rows.values()];
}

function portReservationFailure(
  plan: BoundHostGroupPlan,
  bound: readonly BoundServiceEntry[],
  failures: readonly PortReservationIssue[],
  portChanges: readonly GroupPortChange[],
): Record<string, unknown> {
  const diagnostics: RunDiagnostic[] = failures.map((failure) => {
    const unit = plan.units.find((candidate) => candidate.unitId === failure.assignment.unitId);
    const move = portChanges.find((candidate) => candidate.serviceId === failure.assignment.serviceId);
    const attempt = move ? `；改址尝试 ${move.before} → ${move.after}` : "；未进行改址重试";
    const code: "port-taken" | "port-unavailable" = failure.code === "EADDRINUSE" ? "port-taken" : "port-unavailable";
    return {
      code,
      scope: { unitId: failure.assignment.unitId, port: failure.assignment.port },
      message: `服务「${unit?.name ?? failure.assignment.serviceId}」（${failure.assignment.serviceId}）启动前端口 ${failure.assignment.port} 预约失败：${failure.reason}${attempt}`,
      hint: "请释放该端口或检查监听地址后重试整组启动",
    };
  });
  const units = (plan.units.length > 0 ? plan.units : bound.map(({ binding, launch }) => ({
    unitId: `${binding.rootId}:${launch.serviceId}`, serviceId: launch.serviceId, name: launch.descriptor.name,
    location: "local" as const,
  }))).map((unit) => ({
    unitId: unit.unitId,
    serviceId: unit.serviceId,
    start: "not-started",
    observedRun: false,
    listening: "not-probed",
    linked: false,
    steps: [],
    diagnostics: [],
  }));
  return {
    state: "start-failed",
    groups: plan.groups.map((group) => group.groupId),
    units,
    restartScope: [],
    reallocated: plan.reallocated,
    diagnostics: [...plan.diagnostics, ...diagnostics],
    portChanges,
  };
}

/**
 * One explicit re-bind of a task's service owner ([PiDock 04] #7 slice), as
 * main resolves and performs it. `state` is main's real observation of the
 * forked Host's owner binding: `absent` (no Host forked; the next start forks at
 * the current revision), `current` (the binding already matches, so this is an
 * idempotent no-op) or `fenced` (the write changed the task's owner snapshot, so
 * the Host refuses start/stop). `changes` is the named per-service difference
 * between the replaced owner and the authoritative catalog. `confirmed`/
 * `rebound` say whether the human-confirmed replacement ran. The copy facts are
 * explicit: the re-bind replaces only the ownership binding, so it never stops
 * or restarts a process, and a currently running service keeps running the
 * revision it was started with. Each change row names the pinned template
 * versions the re-bind moves (`was`/`now`) and says explicitly whether the
 * resolved owner contract's config digest also moved (`configChanged`): a
 * binding change that keeps the pinned version (another work subdirectory, a
 * changed local program, a private environment value) changes the owner
 * contract without changing the version, and such a row must stay renderable
 * instead of looking like no difference at all.
 */
export interface ServiceOwnerRebindProjection {
  taskId: string;
  projectId: string;
  state: "absent" | "current" | "fenced";
  confirmed: boolean;
  rebound: boolean;
  changes: { serviceId: string; name: string; was: number | null; now: number | null; configChanged: boolean }[];
  stopsProcesses: false;
  restartsProcesses: false;
}

/**
 * Re-bind one task's service owner at the current catalog revision ([PiDock 04]
 * #7 slice). The two-step contract matches the catalog ops: a request without
 * `confirm` only reports (real state, named changes); a confirmed request
 * replaces the fenced owner binding and its durable lease, so start/stop works
 * again at the new revision while the task's Host, its sessions, its terminals
 * and any running service process keep running. It refuses, by name, rather than
 * silently dropping an owner whose durable record is not settled - that record
 * may still stand for a live process. Exported so the sequence can be driven end
 * to end against a real Host without an Electron `IpcMainInvokeEvent`.
 */
export async function rebindTaskServiceOwner(
  tasks: Pick<PerTaskHostRegistry, "serviceOwnerState" | "serviceOwnerChanges" | "serviceOwnerOwners" | "rebindServiceOwner">,
  catalog: Pick<ServiceCatalog, "taskBindings">,
  request: ReturnType<typeof parseServiceOwnerRebindRequest>,
): Promise<ServiceOwnerRebindProjection> {
  // Main resolves the task's own bindings: an unknown task, a foreign project or
  // a missing pinned revision refuses here with the catalog's named error, and
  // no page-supplied identity is involved. Resolved after the state probe so the
  // idempotent `absent`/`current` answer never depends on a catalog read.
  const state = tasks.serviceOwnerState(request.taskId);
  const base: ServiceOwnerRebindProjection = { taskId: request.taskId, projectId: request.projectId, state,
    confirmed: false, rebound: false, changes: [], stopsProcesses: false, restartsProcesses: false };
  if (state !== "fenced") return base;
  const names = new Map(catalog.taskBindings(request.projectId, request.taskId)
    .map(({ binding, template }) => [binding.serviceId, template.descriptor.name]));
  const changes = tasks.serviceOwnerChanges(request.taskId);
  if (!changes) throw new Error("service-owner-catalog-unavailable");
  const review: ServiceOwnerRebindProjection = { ...base, changes: changes.map((row) => ({ serviceId: row.serviceId,
    name: names.get(row.serviceId) ?? row.serviceId, was: row.was?.templateVersion ?? null, now: row.now?.templateVersion ?? null,
    // `changes()` compares the whole resolved owner contract, so a row can be real
    // while both pinned versions are equal; `configChanged` is what makes that
    // difference visible instead of leaving the page with an unexplained row.
    configChanged: row.was === null || row.now === null || row.was.configRevision !== row.now.configRevision })) };
  if (!request.confirm) return review;
  // Refuse instead of tearing down an uncertain owner: a durable record that is
  // not stopped/exited (or still names an owner session) can still stand for a
  // live process, and replacing its owner would orphan that process.
  const live = (tasks.serviceOwnerOwners(request.taskId) ?? [])
    .filter((owner) => owner.ownerSessionId !== null || (owner.state !== "stopped" && owner.state !== "exited"));
  if (live.length > 0) throw new Error(`service-owner-rebind-blocked: ${live.map((owner) => owner.serviceId).join(",")}`);
  const rebound = await tasks.rebindServiceOwner(request.taskId);
  // The reported state is re-observed after the operation, so a caller never sees
  // a stale `fenced` for a task whose control actually came back.
  return { ...review, state: tasks.serviceOwnerState(request.taskId), confirmed: true, rebound: rebound === "rebound" };
}

/**
 * The honest restart consequence of one shared-template write ([PiDock 04] #7
 * slice), attached to the `update`/`adoptBinding` answer: whether the write
 * changed launch material at all (`changed`), the explicit fact that a config
 * write never restarts a process (`processRestarted: false`), and - recomputed
 * from the real forked Hosts after a confirmed write - the task ids whose
 * service-control channel it revoked (empty for a read-only review, because
 * nothing was written yet, and always empty for `update`: minting a shared
 * revision moves no binding's pin, so it revokes no task's control).
 */
export function serviceRestartConsequence(
  op: "update" | "adoptBinding", payload: Record<string, unknown>, tasks?: PerTaskHostRegistry,
): { changed: boolean; processRestarted: false; fencedTaskIds: string[] } {
  const repinned = op === "adoptBinding" && typeof payload["taskId"] === "string" ? [payload["taskId"]] : [];
  return { changed: op === "adoptBinding" ? payload["from"] !== payload["to"] : payload["contentChanged"] === true,
    processRestarted: false, fencedTaskIds: repinned.filter((taskId) => tasks?.serviceOwnerState(taskId) === "fenced") };
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
  /**
   * [PiDock 03] (#6) production append for an existing task. Kept last so every
   * existing `registerIpc` caller keeps its positional arguments; without it
   * `shell/appendTaskRepos` fails closed with "尚未接入".
   */
  append?: ProjectTaskAppend,
): void {
  if (tasks && catalog && taskRoots && projects) tasks.configureServices((workspaceId) => new InstalledServiceHostAuthority(
    app.getPath("userData"), catalog, serviceCatalogAuthority(taskRoots, projects), workspaceId, process.env));
  // [PiDock 04] (#7 box 6) the Agent's shared-template edit reaches main here:
  // one handler per forked task, bound to that child's own task id, using the
  // same catalog the page's edit path uses (main stays the only writer).
  if (tasks && catalog) tasks.configureServiceTemplates((taskId) => createServiceTemplateHandler(catalog, taskId));
  // The first non-provision route to a task Host registers every confirmed
  // binding from main's persisted catalog before that route reaches the Host.
  // `projectForTask` is the catalog's verified association; launch material is
  // still resolved only by the same `taskBindings` + `launchFor` path as a human
  // start, and each failed binding is named without preventing the others.
  if (tasks && catalog && typeof tasks.configureCatalogServiceLaunches === "function") tasks.configureCatalogServiceLaunches((taskId, previousKey) => {
    let projectId: string | null;
    try { projectId = catalog.projectForTask(taskId); }
    catch (error) {
      console.error(`[main] task ${taskId} catalog bindings could not be resolved: ${errorMessage(error)}`);
      return { key: previousKey ?? "", launches: [] };
    }
    if (projectId === null) return { key: "", launches: [] };
    let bindings: ReturnType<ServiceCatalog["taskBindings"]>;
    try { bindings = catalog.taskBindings(projectId, taskId); }
    catch (error) {
      console.error(`[main] task ${taskId} confirmed catalog bindings could not be read: ${errorMessage(error)}`);
      return { key: previousKey ?? "", launches: [] };
    }
    // Cheap fingerprint of the bound material, so a steady task does not re-read
    // every launch on every route: resolving is only paid when it changed.
    const key = bindings.map(({ binding }) => [binding.serviceId, binding.templateVersion, binding.environmentId, binding.rootId, binding.subdir, binding.programPath].join("\u0000")).sort().join("\u0001");
    if (previousKey !== undefined && key === previousKey) return { key, launches: [] };
    const launches: ServiceLaunch[] = [];
    for (const { binding } of bindings) {
      try { launches.push(catalog.launchFor(taskId, projectId, binding.serviceId, process.env)); }
      catch (error) {
        console.error(`[main] task ${taskId} service ${binding.serviceId} could not be resolved from its confirmed catalog binding: ${errorMessage(error)}`);
      }
    }
    return { key, launches };
  });
  type TurnMessage = Parameters<Parameters<HostClient["onTurnEvent"]>[0]>[0];
  type PendingStart = { requestId: string; buffered: TurnMessage[]; bytes: number; overflow: boolean };
  type Subscription = { taskId: string; sessionId: string; frame: { processId: number; routingId: number }; webContents: WebContents; detach: () => void; deliver: (message: TurnMessage) => void; onNavigation: () => void; onInPageNavigation: () => void; onDestroyed: () => void; turns: Map<string, { sequence: number; resync: boolean; terminal: boolean }>; evictedTurns: boolean; pendingStart: PendingStart | null };
  /**
   * Live-sender guard for main's child-owning service entries
   * (`runTaskService`, `bind`, `rebindServiceOwner`). `requireShellSender`
   * proves which webContents may call at all; this additionally proves the
   * same, un-navigated document is still the caller when the operation commits
   * a real child process or replaces a live ownership binding. It re-proves the
   * actual invoke event, so the frame check sees the frame the caller really
   * sent instead of a frame main synthesized itself.
   */
  const liveServiceSender = (event: IpcMainInvokeEvent, reason: string): { require: () => void; release: () => void } => {
    const sender = event.sender;
    const url = sender.getURL();
    const frame = { processId: sender.mainFrame.processId, routingId: sender.mainFrame.routingId };
    let navigated = false;
    const onNavigation = () => { navigated = true; };
    sender.on("did-start-navigation", onNavigation);
    return {
      require: () => {
        registry.requireShellSender(event);
        if (navigated || sender.isDestroyed() || url !== sender.getURL() ||
            frame.processId !== sender.mainFrame.processId || frame.routingId !== sender.mainFrame.routingId) throw new Error(reason);
      },
      release: () => sender.removeListener("did-start-navigation", onNavigation),
    };
  };
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
      const keys = action === "start" ? ["action", "taskId", "sessionId", "requestId", "text", "references", "attachments"] :
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
      let providerConfigured = true;
      if (providers) {
        try { providerConfigured = await providers.ensure(taskId, sender.webContentsId) === "configured"; }
        catch { providerConfigured = false; }
      }
      if (action === "start" && !providerConfigured) throw new Error("provider-not-configured");
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
      if (action === "start") {
        payload["requestId"] = input["requestId"];
        payload["text"] = input["text"];
        // #117 第 1 项（A）：引用与附件随回合下发，由 Host 拼成 prompt 末尾一段。
        if (input["references"] !== undefined) payload["references"] = input["references"];
        if (input["attachments"] !== undefined) payload["attachments"] = input["attachments"];
      }
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

  // [PiDock 03] (#6) production append for an EXISTING task: main fetches and
  // pins every selected repository's remote branch in its OWN source checkout
  // (all-success gate), derives the conflict scan itself, routes
  // `task/appendRepos` and executes the returned plan with real git. The same
  // sender-scoped trust pattern as `shell/createTask`: the page names project
  // repository ids/remote/branches only, and `reattest` re-proves the attested
  // shell sender right before the plan creates real resources.
  ipcMain.handle("shell/appendTaskRepos", async (event, payload?: unknown) => {
    try {
      registry.requireShellSender(event);
      if (!append) return { ok: false as const, error: "真实任务追加尚未接入" };
      const result = await performAppendOperation(append, payload, () => { registry.requireShellSender(event); });
      return { ok: true as const, payload: result };
    } catch (error) {
      if (error instanceof TrustDomainViolation) return trustFailureEnvelope(error);
      return { ok: false as const, error: errorMessage(error) };
    }
  });

  // [PiDock 10] (#15 box 28) 从任务打开外部编辑器: the production entry. The page
  // names a task and one of that task's own file roots — nothing else. The
  // editor program is read by main from its own machine-private settings
  // document (never from the payload, and never from page-supplied code), and
  // main stamps the attested `shell-ui` origin itself, so the Host's launch is
  // an explicit human action whose program the caller cannot choose. The op is
  // NOT part of the renderer task-op set: `shell/taskOp` refuses
  // `task/openEditor` by name (the same closure as `task/appendRepos`).
  ipcMain.handle("shell/openTaskEditor", async (event, payload?: unknown) => {
    try {
      const sender = registry.requireShellSender(event);
      const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
      // A page may name the task and one of its roots; every other key — a
      // program, args, a path — is refused instead of ignored, so a
      // caller-supplied program cannot reach the Host even as an extra field.
      const extra = Object.keys(record).filter((key) => key !== "taskId" && key !== "rootId");
      if (extra.length > 0) {
        throw new TrustDomainViolation(
          "invalid-payload",
          `shell/openTaskEditor 只接受 taskId 与 rootId，不接受 ${extra.sort().join(",")}`,
        );
      }
      const taskId = record["taskId"];
      const rootId = record["rootId"];
      if (typeof taskId !== "string" || taskId.length === 0) {
        throw new TrustDomainViolation("invalid-payload", "shell/openTaskEditor requires a taskId");
      }
      if (typeof rootId !== "string" || rootId.trim().length === 0) {
        throw new TrustDomainViolation("invalid-payload", "shell/openTaskEditor requires a rootId");
      }
      if (!tasks) return { ok: false as const, error: "外部编辑器尚未接入（任务 Host 未接线）" };
      // Main reads the user's own editor setting from its machine-private
      // document and refuses by name (nothing spawned, no Host call) when the
      // program is unconfigured or the document is unusable.
      const settings: ExternalEditorSettingsResult = loadExternalEditorSettings(app.getPath("userData"));
      if (!settings.ok) return { ok: false as const, error: settings.error };
      const origin: TaskOpOrigin = {
        kind: "shell-ui",
        senderWebContentsId: sender.webContentsId,
      };
      const result = await tasks.routeTaskOp({
        taskId,
        op: "task/openEditor",
        payload: { rootId, editor: settings.settings },
        origin,
      });
      return { ok: true as const, payload: result };
    } catch (error) {
      if (error instanceof TrustDomainViolation) return trustFailureEnvelope(error);
      return { ok: false as const, error: errorMessage(error) };
    }
  });

  // [PiDock 10] (#15 box 28) 外部编辑器的本机设置：the WRITE path for the very
  // program `shell/openTaskEditor` launches. Until this entry existed the
  // launch read a document nothing in the app could write, so the box was only
  // reachable by hand-editing an app-private file; the save now writes the SAME
  // document, atomically, after validating the program with the launch's own
  // rules (a refused save writes nothing, so a valid setting is never replaced
  // by something that cannot launch).
  //
  // Same boundary as `shell/providerOp`: the sender must be the attested shell
  // webContents, the operation set is fixed, extra keys are refused, and the
  // document path is main's own — page code names a program, never a file. It
  // is deliberately NOT a task op: nothing is added to the renderer task-op set
  // (`HOST_TASK_OPS`), so `shell/taskOp` cannot carry this write at all.
  ipcMain.handle("shell/editorSettingsOp", async (event, payload?: unknown) => {
    try {
      registry.requireShellSender(event);
      const result = performEditorSettingsOperation(payload, app.getPath("userData"));
      return result.ok ? { ok: true as const, payload: result.status } : { ok: false as const, error: result.error };
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
      // [PiDock 04] (#7) start/stop one task-bound service. Main resolves the
      // trusted persisted catalog launch (program path, pinned argv, cwd,
      // private values) itself and drives the task Host; the page only names
      // project/task/service. The `service-catalog` origin is main-built, so
      // nothing the page sends can register an executable launch.
      if (payload && typeof payload === "object" && (payload as Record<string, unknown>)["op"] === "runTaskService") {
        if (!tasks) return { ok: false as const, error: "任务 Host 尚未接入" };
        const request = parseServiceRunRequest(payload);
        // Production gate: authorized on POSIX (the ownership module can
        // verify a launch identity there), a named `unsupported-platform`
        // refusal everywhere else (#48's decision). It is checked before
        // resolving a launch, so an unsupported platform never reaches a
        // spawn-capable call. See `serviceExecutionRefusal`.
        const refusal = serviceExecutionRefusal();
        if (refusal !== null) return { ok: false as const, error: refusal };
        // Execution takes the same live-sender guard as the sibling binding
        // branch: `requireShellSender` proves which webContents may call, not
        // that the same, un-navigated document is still the one calling when
        // the operation commits a real child process.
        const live = liveServiceSender(event, "service execution sender changed");
        try {
          live.require();
          const result = await runTaskService(tasks, catalog, request, event.sender.id);
          live.require();
          return { ok: true as const, payload: result };
        } catch (error) {
          // The Host's own refusal (the owner fence, an uncertain durable
          // owner, an operation already in flight) is the page's only honest
          // explanation for a refused start/stop, so it reaches the page
          // verbatim instead of the generic catalog-save message below.
          return namedServiceRefusal(error);
        } finally { live.release(); }
      }
      // [PiDock 05] (#10 box 4) 整组启动: the task's own run unit group, started
      // through the SAME op and the SAME gate as one service. Main owns the
      // membership (it resolves the task's bound services from the trusted
      // catalog and registers each launch), the page names only project/task, and
      // the Host's `runGroupServiceStart` still dispatches every unit through the
      // one gated `task/controlService` path. No `HOST_TASK_OPS` entry is added.
      if (payload && typeof payload === "object" && (payload as Record<string, unknown>)["op"] === "runTaskServiceGroup") {
        if (!tasks) return { ok: false as const, error: "任务 Host 尚未接入" };
        const request = parseServiceRunGroupRequest(payload);
        // Same production platform gate as the single path, checked before a
        // launch is resolved or a group is planned.
        const refusal = serviceExecutionRefusal();
        if (refusal !== null) return { ok: false as const, error: refusal };
        const live = liveServiceSender(event, "service group execution sender changed");
        try {
          live.require();
          const result = await runTaskServiceGroup(tasks, catalog, request, event.sender.id);
          live.require();
          return { ok: true as const, payload: result };
        } catch (error) {
          // The group runner's named negatives (`refused`, `start-failed`, the
          // port plan's own `missing-port`) and main's registration refusals are
          // the page's only honest explanation, so they reach the page verbatim.
          return namedServiceRefusal(error);
        } finally { live.release(); }
      }
      if (payload && typeof payload === "object" && (payload as Record<string, unknown>)["op"] === "taskDependencyRouting") {
        const request = parseTaskDependencyRoutingRequest(payload);
        // A pure read of main's own catalog + the task's PINNED bindings: it
        // writes no plan, forks no Host and creates no child, so it takes neither
        // the platform gate nor the live-sender guard those child-owning entries
        // need. `requireShellSender` above still proves which webContents may
        // call. A named refusal (an unresolvable launch, a declaration whose
        // target is not bound) reaches the page verbatim instead of collapsing
        // into the generic catalog message.
        try {
          return { ok: true as const, payload: readTaskDependencyRouting(catalog, request) };
        } catch (error) {
          return namedServiceRefusal(error);
        }
      }
      // [PiDock 04] (#7 slice) the way back from a fenced task: after a write
      // moved the task's owner snapshot (a shared-template adoption, a binding
      // change, a project re-association), the Host refuses start/stop with
      // `service-owner-inventory-unconfirmed`. This is the privileged,
      // sender-attested entry that re-binds that task's service owner at the new
      // revision. It is a two-step like the catalog writes - `confirm:false` only
      // reports real state and the named changes, `confirm:true` replaces the
      // fenced binding and its lease - and it takes the same live-sender guard as
      // the sibling child-owning entries.
      if (payload && typeof payload === "object" && (payload as Record<string, unknown>)["op"] === "rebindServiceOwner") {
        if (!tasks) return { ok: false as const, error: "任务 Host 尚未接入" };
        const request = parseServiceOwnerRebindRequest(payload);
        const live = liveServiceSender(event, "service owner rebind sender changed");
        try {
          live.require();
          const result = await rebindTaskServiceOwner(tasks, catalog, request);
          live.require();
          return { ok: true as const, payload: result };
        } catch (error) {
          // `service-owner-rebind-blocked: <serviceId>` (an unsettled durable
          // owner) and `service-owner-catalog-unavailable` are the named
          // refusals the page must show verbatim - a silent drop is exactly
          // what this operation exists to prevent.
          return namedServiceRefusal(error);
        } finally { live.release(); }
      }
      if (payload && typeof payload === "object" && ["bind", "taskBindings"].includes(String((payload as Record<string, unknown>)["op"]))) {
        const live = liveServiceSender(event, "service binding sender changed");
        try {
          return { ok: true as const, payload: await performServiceBindingOperation(catalog, payload, pickProgram, live.require) };
        } finally { live.release(); }
      }
      // A shared-template `update` and a binding `adoptBinding` (like `create`)
      // are inert data: neither writes a child process, a program path or a task
      // binding's local identity, and the catalog re-validates every field
      // fail-closed and re-checks the version, so they do not take the sibling
      // `bind`/`runTaskService` live-sender guard. `requireShellSender` above
      // still proves which webContents may call at all. Their answer carries the
      // honest restart consequence - what changed, that a config write never
      // restarts a process, and which forked task Hosts this write revoked.
      const result = performServiceCatalogOperation(catalog, payload);
      const op = (payload as Record<string, unknown>)["op"];
      if (op === "update" || op === "adoptBinding") {
        const written = result as unknown as Record<string, unknown>;
        return { ok: true as const, payload: { ...written, restart: serviceRestartConsequence(op, written, tasks) } };
      }
      return { ok: true as const, payload: result };
    } catch (error) {
      if (error instanceof TrustDomainViolation) return trustFailureEnvelope(error);
      return { ok: false as const, error: "服务配方保存或读取失败，请核对项目及配置后重试" };
    }
  });

  /**
   * Project repositories of a task's confirmed association. Main-owned
   * authority for turning a recorded `repo-xxxxxxxx` folder into the source
   * checkout the scan and the plan must use; a task without a confirmed
   * association has no authoritative checkout source, so the scan refuses.
   * `shell/taskOp` and main's own production append both build it through
   * `createPrepScanAuthority`.
   */
  const prepScanAuthority: PrepScanAuthority = createPrepScanAuthority(projects, taskRoots);

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
      // #95: desktop terminal is retired. Keep internal Host execution and
      // cleanup available, but stale renderers cannot read or start terminals.
      if (op === "task/planTerminal" || op.startsWith("task/terminal")) {
        throw new TrustDomainViolation("invalid-payload", "内置终端已从桌面应用移除（#95）");
      }
      // #126: 远程访问移出首版（未来计划功能）。Host 侧实现与演示页保留，但
      // 正式桌面通道关闭：旧渲染层或旧脚本不能借遗留 op 读远程状态、配对或授权设备。
      if (op.startsWith("task/remote")) {
        throw new TrustDomainViolation("invalid-payload", "远程访问已移出首版（未来计划功能，#126）");
      }
      // [PiDock 03] (#6) legacy-route refusal: `shell/taskOp` used to accept
      // `task/appendRepos` from page code, letting the renderer supply the
      // `fetchedCommits` baseline the Host then persisted — with NO executor
      // in main. `shell/appendTaskRepos` is the production entry (registry-only
      // paths, main-derived scan, fetch/pin, plan execution), so the legacy op
      // is refused here; no production caller remains.
      if (op === "task/appendRepos") {
        throw new TrustDomainViolation(
          "invalid-payload",
          "shell/taskOp 不再接受 task/appendRepos，请使用 shell/appendTaskRepos（ref #6）",
        );
      }
      // [PiDock 03] (#6) the same legacy-route refusal for the plain-directory
      // twin: `task/appendDirs` records `{directoryId, sourcePath}` into the
      // task record. Reached from page code it would let the sandboxed
      // renderer write a RENDERER-CHOSEN `sourcePath` into `dirLinks` while
      // skipping every guard this slice relies on — registry resolution of the
      // directory id, the workspace-overlap check, the recorded source
      // identity check and the user's `sharedWriteConfirmed`. Those entries
      // then feed the Agent broker's shared scope. `shell/appendTaskRepos` is
      // the production entry (registry-only ids, main-derived source identity,
      // confirmation required), so refuse the legacy op here; no production
      // caller remains. `task/appendDirs` stays in `HOST_TASK_OPS` because
      // main→Host routing of the production append still needs it.
      if (op === "task/appendDirs") {
        throw new TrustDomainViolation(
          "invalid-payload",
          "shell/taskOp 不再接受 task/appendDirs，请使用 shell/appendTaskRepos（ref #6）",
        );
      }
      // [PiDock 10] (#15 box 28) the same legacy-route refusal for the external
      // editor: `task/openEditor` carries the user-configured editor program
      // and a launch authorization. Reached from page code it would let the
      // sandboxed renderer name the program (or the args) that main then hands
      // to the Host, and it would mint the attested human origin for a caller
      // that is not an explicit human action route. `shell/openTaskEditor` is
      // the only entry: main reads the program from its own settings document,
      // accepts `taskId` + `rootId` only, and stamps the origin itself. Keep
      // this op out of the renderer op set — no production caller remains here.
      if (op === "task/openEditor") {
        throw new TrustDomainViolation(
          "invalid-payload",
          "shell/taskOp 不接受 task/openEditor，外部编辑器只允许从文件面板经 shell/openTaskEditor 打开（ref #15）",
        );
      }
      // [PiDock 05] (#10 box 1/4 + ADR 0002) the plan's own inputs are TRUSTED
      // data, so this route refuses the three keys a page could otherwise name:
      // `dependencies` (the group's call/prestart edges), `rules` (which variable
      // a task override binds) and `layers` (the read points the audit checks). A
      // page that could send them would decide what a group start really runs and
      // what the read-point audit gets to look at - measured against rows it
      // supplied itself. Main derives all three from the trusted service catalog
      // (`runTaskServiceGroup` -> `planBoundServiceGroup`) and reaches the Host
      // through `PerTaskHostRegistry.routeTaskOp`, never through this handler, so
      // no production caller is lost here. Refused BY NAME per key, before the
      // Host is asked anything.
      if (op === "task/planServiceGroup") {
        const planPayload = typeof record["payload"] === "object" && record["payload"] !== null
          ? (record["payload"] as Record<string, unknown>)
          : {};
        for (const key of ["dependencies", "rules", "layers"] as const) {
          if (planPayload[key] === undefined) continue;
          throw new TrustDomainViolation(
            "invalid-payload",
            `shell/taskOp 不接受 task/planServiceGroup.${key}：计划的依赖边、变量绑定规则与配置层只从可信服务目录读取（ref #7）`,
          );
        }
      }
      // [PiDock 03] (#6) a resume needs its executor BEFORE the Host op runs:
      // `task/resumeAppend` writes the record, so checking after the route
      // would leave a record update with no executor in main to run the plan
      // it returns. Refuse first; the scan below then only runs for a resume
      // main can actually complete.
      if (op === "task/resumeAppend" && !append) {
        return { ok: false as const, error: "真实任务准备恢复尚未接入" };
      }
      if (pendingNavigation.has(sender.webContentsId) || subscriptions.get(sender.webContentsId)?.taskId !== taskId) revoke(sender.webContentsId);
      // A persisted Provider selection is reinstalled on first contact with the
      // task, before any turn op can run against an unconfigured context. The
      // status route reports failures, so an install failure never turns an
      // unrelated op into an error.
      if (providers) { try { await providers.ensure(taskId, sender.webContentsId); } catch { /* surfaced by shell/providerOp list */ } }
      let opPayload =
        typeof record["payload"] === "object" && record["payload"] !== null
          ? (record["payload"] as Record<string, unknown>)
          : {};
      // #6 boundary B: the sandboxed renderer cannot list the task folder or
      // run `git worktree list`, so main produces the scan `resumeAppend`
      // requires (the Host keeps requiring it) and OVERWRITES any
      // page-supplied `takenPaths`/`branchesInUse`/`mainCheckouts`, so a
      // forged or emptied scan can neither disable nor steer the gate. Every
      // scan failure refuses by name and plans nothing (never a `[]` default).
      // `task/appendRepos` no longer reaches this route (refused above); its
      // scan is derived by `prepareAppendHostPayload` inside
      // `ProjectTaskAppend` on the `shell/appendTaskRepos` channel.
      if (needsPrepScan(op)) {
        const derived = deriveRendererPrepPayload(
          { op, taskId, payload: opPayload },
          prepScanAuthority,
          createNodePrepScanDeps(),
        );
        if (!derived.ok) return { ok: false as const, error: derived.error };
        opPayload = derived.payload;
      }
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
        // [PiDock 03] (#6) a resume that only PLANNED is not a recovery: main
        // executes the returned plan through the same validated
        // `executeAppendPlan` rules the append uses and answers with the Host's
        // freshly re-read per-repo status. A recorded-but-worktree-absent repo
        // is therefore actually completed, never reported as success by plan.
        if (op === "task/resumeAppend") {
          const mainCheckouts = (opPayload["mainCheckouts"] ?? {}) as Record<string, string>;
          // The executor's presence was proven before routing (see the
          // `task/resumeAppend` guard above), so it exists here.
          const payload = await append!.executeResumePlan(
            { taskId, planResult: result, mainCheckouts },
            () => { registry.requireShellSender(event); },
          );
          return { ok: true as const, payload };
        }
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
