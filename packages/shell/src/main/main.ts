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

/**
 * PiDock Electron shell entry point.
 *
 * Runtime boundaries live in `runtime.ts`; smoke-only probing and evidence
 * live in `smoke.ts`. This module only dispatches the requested shell mode.
 */

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

  await app.whenReady();

  if (command.kind === "versions") {
    await runVersions(workspaceId);
    app.exit(0);
    return;
  }

  if (command.kind === "smoke") {
    const report = await runSmoke(workspaceId);
    process.stdout.write(`PIDOCK_SMOKE_RESULT=${JSON.stringify(report)}\n`);
    app.exit(report.ok ? 0 : 1);
    return;
  }

  const { client, child } = await createHost(workspaceId);
  const views = createTrustedWindow(workspaceId);
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
