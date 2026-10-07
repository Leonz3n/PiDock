import { app } from "electron";
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
import { runSmoke } from "./smoke.js";
import { defaultTasksRoot } from "./task-resolver.js";
import { TaskRootIndex } from "./task-root-index.js";
import { ProjectRegistry } from "./project-registry.js";
import { ServiceCatalog, serviceCatalogAuthority } from "./service-catalog.js";
import { ProviderProfileStore } from "./provider-profile-store.js";
import { ProviderWiring } from "./provider-ipc.js";
import { CreationIntentStore, ProjectTaskCreation } from "./project-task-creation.js";
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
  const taskRoots = new TaskRootIndex(app.getPath("userData"), defaultTasksRoot());
  const tasks = new PerTaskHostRegistry(
    workspaceId,
    (ws, task) => createHost(ws, true, task),
    (taskId) => taskRoots.resolve(taskId),
    browsers.registry,
    taskRoots,
  );
  const projects = new ProjectRegistry(app.getPath("userData"));
  const catalog = new ServiceCatalog(app.getPath("userData"), serviceCatalogAuthority(taskRoots, projects));
  const creation = new ProjectTaskCreation(new CreationIntentStore(app.getPath("userData")), projects, taskRoots, tasks, defaultTasksRoot());
  // [PiDock 02m] (#46) explicit Provider selection. Metadata lives in userData;
  // the credential value is read from the profile's PIDOCK_PROVIDER_* reference
  // at install time and is handed only to the task's isolated SDK context.
  const providerProfiles = new ProviderProfileStore(app.getPath("userData"));
  const providers = new ProviderWiring(providerProfiles, async (taskId, provider, senderWebContentsId) => {
    const payload = provider === null
      ? { provider: null }
      : { provider: { config: providerProfiles.config(provider.profileId), credential: provider.credential } };
    const request = { workspaceId, taskId, op: "task/sdkProvider", payload, origin: { kind: "shell-ui", senderWebContentsId } } as const;
    if (tasks) { await tasks.routeTaskOp(request); return; }
    await client.task(request);
  });
  registerIpc(client, views.registry, tasks, projects, taskRoots, undefined, creation, providers, catalog);
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
  });
  if (views.window.isDestroyed()) throw Error("application-window-unavailable");
  if (views.layout) assertProductionWindowEvidence(views);
  else assertTrustedWindowEvidence(trustedWindowEvidence(views));
  // Install before renderer loading so close/activate are handled while it loads.
  // Initial createTrustedWindow construction still precedes these listeners.
  const stopHosts = createHostStopper(tasks, { kind: "shell-ui", senderWebContentsId: views.shellView.webContents.id },
    () => disposal.disposeAfterTasks(tasks, client, () => schedules.stop()));
  registerApplicationLifecycle({ app, window: views.window, platform: process.platform, stopHosts });
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
