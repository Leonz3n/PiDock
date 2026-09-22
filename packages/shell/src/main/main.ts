import { app } from "electron";
import { resolveShellCommand } from "./command.js";
import {
  DEFAULT_WORKSPACE_ID,
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

  const { client, child } = await createHost(workspaceId);
  const views = await createTrustedWindow(workspaceId);
  registerIpc(client, views.registry);
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
    if (process.platform !== "darwin") app.quit();
  });
}

void run().catch((error: unknown) => {
  console.error(`[main] fatal: ${errorMessage(error)}`);
  app.exit(1);
});
