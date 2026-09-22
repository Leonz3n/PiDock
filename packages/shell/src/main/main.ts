import { app } from "electron";
import { resolveShellCommand } from "./command.js";
import {
  DEFAULT_WORKSPACE_ID,
  PerTaskHostRegistry,
  SHELL_WEB_PREFERENCES,
  TASK_WEB_PREFERENCES,
  assertTrustedWindowEvidence,
  createHost,
  createTrustedWindow,
  errorMessage,
  loadTrustedViews,
  registerIpc,
  trustedWindowEvidence,
  versionsTriple,
  webPreferencesEvidence,
} from "./runtime.js";
import { runSmoke } from "./smoke.js";
import { createDiskTaskDirResolver, defaultTasksRoot } from "./task-resolver.js";
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
  const { client, child } = await createHost(workspaceId);
  const views = await createTrustedWindow(workspaceId);
  // Production resolver: scan the machine tasks root for a `task.json`
  // matching the routed task id. First-use of a provisioned task forks
  // its bound Host; unprovisioned ids still fail closed (`unknown task`).
  // Task ids are globally unique, so at most one folder wins per id; the
  // registry revalidates the resolved dir on every reuse (`task-moved`).
  const tasks = new PerTaskHostRegistry(
    workspaceId,
    (ws, task) => createHost(ws, true, task),
    createDiskTaskDirResolver(defaultTasksRoot()),
  );
  registerIpc(client, views.registry, tasks);
  const loaded = await loadTrustedViews(views);
  assertTrustedWindowEvidence(trustedWindowEvidence(views));
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

  app.on("window-all-closed", () => {
    client.dispose();
    child.kill();
    tasks.disposeAll();
    if (process.platform !== "darwin") app.quit();
  });
}

void run().catch((error: unknown) => {
  console.error(`[main] fatal: ${errorMessage(error)}`);
  app.exit(1);
});
