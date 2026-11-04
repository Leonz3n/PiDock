import { homedir } from "node:os";
import { app, powerMonitor, safeStorage, shell } from "electron";
import { resolveShellCommand } from "./command.js";
import {
  DEFAULT_WORKSPACE_ID,
  PerTaskHostRegistry,
  SHELL_WEB_PREFERENCES,
  TASK_WEB_PREFERENCES,
  createTaskBrowserCapability,
  taskBrowserOriginsFromEnv,
  assertProductionWindowEvidence,
  assertTrustedWindowEvidence,
  createHost,
  createHostStopper,
  createTrustedWindow,
  errorMessage,
  loadTrustedViews,
  registerIpc,
  trustedWindowEvidence,
  versionsTriple,
  webPreferencesEvidence,
} from "./runtime.js";
import { registerApplicationLifecycle } from "./application-lifecycle.js";
import { ScheduleDriver } from "./schedule-driver.js";
import { QuitReportStore, SchedulerGate } from "./schedule-supervision.js";
import { runSmoke } from "./smoke.js";
import { defaultTasksRoot } from "./task-resolver.js";
import { initializeDefaultTaskRoot } from "./default-root-init.js";
import { TaskRootIndex } from "./task-root-index.js";
import { ProjectRegistry } from "./project-registry.js";
import { resolveTaskVariables, TaskVariableStore, variableEnvironment } from "./workspace-variables.js";
import { ServiceCatalog, serviceCatalogAuthority } from "./service-catalog.js";
import { ProviderProfileStore } from "./provider-profile-store.js";
import { ProviderSecretStore } from "./provider-secret-store.js";
import { NativeModelsFile, resolveAgentDir } from "./native-models-config.js";
import { NativeMcpFile, resolveMcpAgentDir } from "./native-mcp-config.js";
import { McpOAuth } from "./mcp-oauth.js";
import { McpWiring } from "./mcp-ipc.js";
import { ProviderWiring } from "./provider-ipc.js";
import { CreationIntentStore, ProjectTaskCreation } from "./project-task-creation.js";
import { createNodeAppendGit, ProjectTaskAppend } from "./task-append.js";
import { WorktreeMetadataLock } from "./worktree-metadata-lock.js";
import { createNodePrepScanDeps, createPrepScanAuthority } from "./task-prep-scan.js";
import {
  runTaskBrowserSmoke,
  type TaskBrowserSmokePhase,
} from "./task-browser-smoke.js";
import { runTaskBrowserS4Smoke } from "./task-browser-s4-smoke.js";
import { runTaskBrowserS5Smoke } from "./task-browser-s5-smoke.js";

/**
 * PiDock Electron shell entry point.
 *
 * Runtime boundaries live in `runtime.ts`; smoke-only probing and evidence
 * live in `smoke.ts` and `task-browser-smoke.ts`.
 */

function taskBrowserSmokePhase(value: string | undefined): TaskBrowserSmokePhase {
  if (value === "prepare" || value === "verify") return value;
  throw new Error(`PIDOCK_S3_PHASE must be prepare or verify, got ${String(value)}`);
}

async function runVersions(workspaceId: string): Promise<void> {
  // Versions path: workspace-only Host (getVersions only; no task ops,
  // so no per-task binding is forked).
  const { client, child } = await createHost(workspaceId);
  try {
    const hostVersions = await client.getVersions({ workspaceId });
    console.log(JSON.stringify(versionsTriple(hostVersions.node)));
  } finally {
    client.dispose();
    child.kill();
  }
}

async function run(): Promise<void> {
  const workspaceId =
    process.env["PIDOCK_WORKSPACE_ID"] ?? DEFAULT_WORKSPACE_ID;
  const command = resolveShellCommand(process.argv, process.env);
  const profile = process.env["PIDOCK_S3_PROFILE"];
  if (profile) app.setPath("userData", profile);

  await app.whenReady();

  if (command.kind === "versions") {
    await runVersions(workspaceId);
    app.exit(0);
    return;
  }

  if (command.kind === "startup") {
    const startedAt = Date.now();
    // Startup timing path: workspace-only Host (no task ops run here,
    // so no per-task binding is forked).
    const { client, child } = await createHost(workspaceId);
    const views = await createTrustedWindow(workspaceId);
    const loaded = await loadTrustedViews(views);
    process.stdout.write(
      `PIDOCK_STARTUP_RESULT=${JSON.stringify({
        electron: process.versions["electron"] ?? "unknown",
        processUptimeMs: Math.round(process.uptime() * 1000),
        readyToLoadedMs: Date.now() - startedAt,
        shellUrl: loaded.shellUrl,
      })}\n`,
    );
    client.dispose();
    child.kill();
    app.exit(0);
    return;
  }

  if (command.kind === "smoke") {
    const report = await runSmoke(workspaceId);
    process.stdout.write(`PIDOCK_SMOKE_RESULT=${JSON.stringify(report)}\n`);
    app.exit(report.ok ? 0 : 1);
    return;
  }

  if (command.kind === "task-automation-smoke") {
    const report = await runTaskBrowserS4Smoke();
    process.stdout.write(`PIDOCK_S4_RESULT=${JSON.stringify(report)}\n`);
    app.exit(report.ok ? 0 : 1);
    return;
  }

  if (command.kind === "task-browser-s5-smoke") {
    const report = await runTaskBrowserS5Smoke();
    process.stdout.write(`PIDOCK_S5_RESULT=${JSON.stringify(report)}\n`);
    app.exit(report.ok ? 0 : 1);
    return;
  }

  if (command.kind === "task-browser-smoke") {
    const report = await runTaskBrowserSmoke(
      workspaceId,
      taskBrowserSmokePhase(process.env["PIDOCK_S3_PHASE"]),
    );
    process.stdout.write(`PIDOCK_S3_RESULT=${JSON.stringify(report)}\n`);
    app.exit(report.ok ? 0 : 1);
    return;
  }

  // Production shell: workspace-only Host serves getVersions/hostPing;
  // task-scoped `shell/taskOp` routes through the per-task registry so
  // every production task op dispatches to a utilityProcess bound with
  // PIDOCK_TASK_ID/PIDOCK_TASK_DIR (fork-on-first-use, resolved from the
  // task record — the renderer only selects the task id). The registry owns
  // the forked Hosts; the workspace-only client stays for ping/versions.
  // (`runVersions`/startup/smoke above intentionally keep workspace-only
  // Hosts: those paths run no task ops.)
  const { client, disposal } = await createHost(workspaceId);
  const dualView = process.env["PIDOCK_TASK_URL"] !== undefined;
  const views = await createTrustedWindow(workspaceId, dualView ? "dual" : "production");
  // [PiDock 06] (#8) browser capability: per-task visible pages + gateways.
  // `PIDOCK_TASK_BROWSER_ORIGINS` holds each task's own frontend addresses
  // (JSON map taskId -> origins); a task without an entry can navigate
  // nowhere (fail-closed), and external hosts are refused for every task.
  const taskOrigins = taskBrowserOriginsFromEnv(process.env["PIDOCK_TASK_BROWSER_ORIGINS"]);
  const browsers = createTaskBrowserCapability({
    window: views.window,
    trust: views.registry,
    workspaceId,
    originsFor: (taskId) => taskOrigins[taskId] ?? [],
    ...(views.layout ? { layout: views.layout } : {}),
  });
  // Production resolver: main owns the default root plus a versioned index of
  // explicitly registered override roots. Every lookup checks disk identity;
  // unknown or conflicting tasks cannot pick a folder by ID alone.
  const userData = app.getPath("userData");
  const defaultRoot = defaultTasksRoot();
  const projects = new ProjectRegistry(userData);
  // [PiDock #81] Establish the machine-local default root on a first run. The
  // creation flow refuses by name while any root is in the 待修复 state, and no
  // in-app affordance can create the default root, so a clean machine would be a
  // dead end; a root this profile already used stays in that state (ADR 0001).
  const defaultRootInit = initializeDefaultTaskRoot(defaultRoot, () => projects.usedTaskRoot(defaultRoot));
  if (defaultRootInit.state === "unavailable") {
    console.error(`[main] 默认任务根保持待修复状态（${defaultRootInit.reason}）：${defaultRootInit.root}`);
  }
  const taskRoots = new TaskRootIndex(userData, defaultRoot);
  // [Pencil T09] #144: workspace variables (registry) + task overrides (this
  // store) are resolved once per Host fork. The resolver is read at fork time,
  // so a variable edit never rewrites a running Host's environment or turn.
  const taskVariables = new TaskVariableStore(userData);
  const taskEnvironment = (taskId: string): Record<string, string> => {
    try {
      const association = projects.association(taskId, taskRoots);
      const project = association.projectId === null ? undefined : projects.get(association.projectId);
      const resolved = resolveTaskVariables(project?.environment ?? [], taskVariables.list(taskId));
      if (resolved.refused.length > 0) {
        // Keys only: a value never reaches a log, even when a legacy row is refused.
        console.error(`[main] task ${taskId} workspace variables refused: ${resolved.refused.map((row) => row.key).join(", ")}`);
      }
      return variableEnvironment(resolved.rows);
    } catch (error) {
      console.error(`[main] task ${taskId} variables unavailable: ${errorMessage(error)}`);
      return {};
    }
  };
  // [Pencil T15] #150: Pi's native `mcp.json` in the SAME agent directory
  // `models.json` lives in. The manager writes only the `pidock-mcp-<uuid>`
  // namespace; the exact file path is also what every task Host receives, so a
  // session loads the file the manager edits instead of a second copy.
  const nativeMcp = new NativeMcpFile(resolveMcpAgentDir(process.env, homedir()));
  let oauth: McpOAuth | undefined;
  try { oauth = await McpOAuth.create(nativeMcp, userData, safeStorage, url => shell.openExternal(url)); }
  catch { console.error("[main] MCP private credential store unavailable; sign-in disabled"); }
  const mcp = new McpWiring(nativeMcp, process.env, undefined, oauth);
  const tasks = new PerTaskHostRegistry(
    workspaceId,
    // A task Host gets the exact MCP config path; each SDK session binds the MCP
    // extension against it only when it starts, so a save never mutates a
    // session that is already open.
    (ws, task, variables) => createHost(ws, true, task, variables, nativeMcp.path),
    (taskId) => taskRoots.resolve(taskId),
    browsers.registry,
    taskRoots,
    taskEnvironment,
  );
  const catalog = new ServiceCatalog(userData, serviceCatalogAuthority(taskRoots, projects));
  // [PiDock 03] (#6 盒子 9) repository-level mutual exclusion: ONE app-private
  // lock, keyed by the REAL path of the shared source repository, shared by the
  // creation flow and the append flow. It lives in `userData` (never inside a
  // user's repository or its `.git`), so two service instances — or two app
  // instances on one profile — cannot both run the conflict scan and the real
  // `git worktree add` for one source checkout.
  const worktreeLock = new WorktreeMetadataLock(app.getPath("userData"), {
    notify: (message) => console.error(`[main] ${message}`),
  });
  const creation = new ProjectTaskCreation(new CreationIntentStore(app.getPath("userData")), projects, taskRoots, tasks, defaultRoot, undefined, worktreeLock);
  // [PiDock 03] (#6) production append: fetch/pin each selected repository in
  // its own source checkout, derive the conflict scan, route `task/appendRepos`
  // and execute the returned plan with real git. The registry is the only
  // source of repository paths, so the page never supplies one.
  const append = new ProjectTaskAppend(
    tasks,
    createPrepScanAuthority(projects, taskRoots),
    createNodePrepScanDeps(),
    createNodeAppendGit(),
    worktreeLock,
  );
  // [PiDock 02m] (#46) explicit Provider selection. Metadata lives in userData;
  // the credential value is read from the profile's PIDOCK_PROVIDER_* reference
  // at install time and is handed only to the task's isolated SDK context.
  const providerProfiles = new ProviderProfileStore(app.getPath("userData"));
  // [PiDock T03] #138: the credential value lives only in the OS-encrypted
  // store, and Pi's native `models.json` is the Provider management object.
  // `PIDOCK_AGENT_DIR` overrides the agent directory for tests/alternate homes.
  const providerSecrets = new ProviderSecretStore(app.getPath("userData"), safeStorage);
  const nativeModels = new NativeModelsFile(resolveAgentDir(process.env, homedir()));
  const providers = new ProviderWiring(providerProfiles, async (taskId, provider, senderWebContentsId) => {
    const payload = provider === null
      ? { provider: null }
      : {
          provider: {
            config: providerProfiles.config(provider.profileId, provider.modelId),
            credential: provider.credential,
            ...(oauth ? { mcpPrivate: await oauth.hostBinding() } : {}),
            thinkingLevel: provider.thinkingLevel,
          },
        };
    const request = { workspaceId, taskId, op: "task/sdkProvider", payload, origin: { kind: "shell-ui", senderWebContentsId } } as const;
    if (tasks) { await tasks.routeTaskOp(request); return; }
    await client.task(request);
  }, process.env, { secrets: providerSecrets, native: nativeModels });
  // [Pencil T18] #153: quitting and sleeping are the two phases in which no due
  // trigger may start; waking plans forward instead of backfilling. The gate is
  // the single answer the driver, the wake fan-out and the quit path read, and
  // the quit-report store makes an unconfirmed shutdown visible after restart.
  const quitReports = new QuitReportStore(userData);
  const gate = new SchedulerGate(quitReports);
  const schedulerState = (): ReturnType<SchedulerGate["view"]> => {
    const persisted = gate.view().lastQuitUnconfirmed ?? quitReports.pending() ?? undefined;
    return { ...gate.view(), ...(persisted !== undefined ? { lastQuitUnconfirmed: persisted } : {}) };
  };
  registerIpc(client, views.registry, tasks, projects, taskRoots, undefined, creation, providers, catalog, undefined, append, taskVariables, { state: schedulerState }, mcp);
  // [PiDock 18] (#20) the Host-borne scheduler: main owns the Host processes, so
  // the driver asks each *running* Host to evaluate its own due triggers. It
  // never forks a Host and never overlaps its own ticks; stop it wherever the
  // Hosts go away.
  const schedules = new ScheduleDriver({
    hostTaskIds: () => tasks.activeTaskIds(),
    evaluate: async (taskId) => {
      await tasks.routeTaskOp({ taskId, op: "task/scheduleEvaluate" });
    },
    onError: (error, taskId) => console.error(`[main] schedule evaluation failed for ${taskId}: ${errorMessage(error)}`),
    blockedReason: () => gate.blockedReason(),
  });
  if (views.window.isDestroyed()) throw Error("application-window-unavailable");
  if (views.layout) assertProductionWindowEvidence(views);
  else assertTrustedWindowEvidence(trustedWindowEvidence(views));
  // Install before renderer loading so close/activate are handled while it loads.
  // Initial createTrustedWindow construction still precedes these listeners.
  const stopHosts = createHostStopper(tasks, { kind: "shell-ui", senderWebContentsId: views.shellView.webContents.id },
    () => disposal.disposeAfterTasks(tasks, client, () => schedules.stop()));
  // The quit path owns the gate: no due trigger starts between "quit" and the
  // Hosts going away, and a refused quit puts scheduling back (with the refusal
  // recorded) instead of leaving a half-dead scheduler.
  const gatedStopHosts = async (): Promise<boolean> => {
    gate.beginQuit();
    schedules.stop();
    await oauth?.close();
    const stopped = await stopHosts();
    if (stopped) {
      gate.completeQuit();
      quitReports.clear();
    } else {
      oauth?.resume();
      gate.abortQuit({ at: new Date().toISOString(), hosts: stopHosts.unsatisfiedHosts() });
      schedules.start();
    }
    return stopped;
  };
  registerApplicationLifecycle({ app, window: views.window, platform: process.platform, stopHosts: gatedStopHosts,
    unsatisfiedHosts: stopHosts.unsatisfiedHosts,
    onQuitUnconfirmed: (report) => { gate.abortQuit(report); }});
  // Sleep/wake: no execution while asleep, and waking moves every enabled plan
  // forward (no backfill). A Host that is not running is skipped; it will read
  // its own persisted plan when it is forked next.
  powerMonitor.on("suspend", () => { gate.sleep(new Date().toISOString()); });
  powerMonitor.on("resume", () => {
    const woke = gate.wake(new Date().toISOString());
    if (woke === null) return;
    for (const taskId of tasks.activeTaskIds()) {
      void tasks.routeTaskOp({ taskId, op: "task/scheduleWake", payload: { at: woke.at } })
        .catch((error: unknown) => console.error(`[main] schedule wake failed for ${taskId}: ${errorMessage(error)}`));
    }
  });
  schedules.start();
  const loaded = await loadTrustedViews(views);
  console.log(
    `[main] trust domains: ${JSON.stringify({
      workspaceId,
      shellUrl: loaded.shellUrl,
      taskUrl: loaded.taskUrl,
      shellWebPreferences: webPreferencesEvidence(
        SHELL_WEB_PREFERENCES,
        true,
      ),
      taskWebPreferences: webPreferencesEvidence(TASK_WEB_PREFERENCES, false),
    })}`,
  );
}

void run().catch((error: unknown) => {
  console.error(`[main] fatal: ${errorMessage(error)}`);
  app.exit(1);
});
