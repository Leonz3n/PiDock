import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, utilityProcess } from "electron";
import type {
  BrowserWindowConstructorOptions,
  UtilityProcess,
} from "electron";
import { isAllowedInvokeChannel } from "../preload/allowlist.js";
import { HostClient } from "../rpc/host-client.js";
import { resolveShellCommand } from "./command.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * S1 shell main process.
 *
 * Owns: the sandboxed BrowserWindow, the per-workspace utilityProcess Node
 * Host stub, and the typed MessagePort RPC between them. No Bun host, no
 * CDP, no second trust domain (those are S2-S6).
 */

const WINDOW_OPTIONS: BrowserWindowConstructorOptions = {
  width: 1024,
  height: 768,
  show: false,
  webPreferences: {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    preload: path.join(here, "..", "preload", "preload.cjs"),
  },
};

interface WindowSecurityEvidence {
  sandbox: boolean;
  contextIsolation: boolean;
  nodeIntegration: boolean;
  preload: string;
}

interface SmokeEvidence {
  window: WindowSecurityEvidence;
  rendererUrl: string;
  rendererProbe?: unknown;
}

interface SmokeSuccessReport {
  schema: "pidock.shell.smoke.v1";
  ok: true;
  electron: string;
  mainNode: string;
  utilityNode: string;
  window: {
    sandbox: true;
    contextIsolation: true;
    nodeIntegration: false;
  };
  renderer: {
    bridge: "object";
    globals: {
      require: "undefined";
      process: "undefined";
      module: "undefined";
    };
    security: {
      sandboxed: true;
      contextIsolated: true;
    };
  };
  rpc: {
    ping: { pong: true; workspaceId: string };
    versions: {
      electron: string;
      mainNode: string;
      utilityNode: string;
      workspaceId: string;
    };
  };
}

interface SmokeFailureReport {
  schema: "pidock.shell.smoke.v1";
  ok: false;
  error: {
    stage: string;
    message: string;
  };
  evidence: SmokeEvidence;
}

type SmokeReport = SmokeSuccessReport | SmokeFailureReport;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function windowSecurityEvidence(): WindowSecurityEvidence {
  const preferences = WINDOW_OPTIONS.webPreferences;
  if (!preferences || typeof preferences.preload !== "string") {
    throw new Error("window preload configuration is missing");
  }
  return {
    sandbox: preferences.sandbox === true,
    contextIsolation: preferences.contextIsolation === true,
    nodeIntegration: preferences.nodeIntegration === true,
    preload: preferences.preload,
  };
}

function assertWindowSecurity(evidence: WindowSecurityEvidence): void {
  if (
    evidence.sandbox !== true ||
    evidence.contextIsolation !== true ||
    evidence.nodeIntegration !== false
  ) {
    throw new Error(`sandbox contract violated: ${JSON.stringify(evidence)}`);
  }
}

function versionsTriple(hostNode?: string): Record<string, string> {
  return {
    electron: process.versions["electron"] ?? "unknown",
    mainNode: process.versions["node"] ?? "unknown",
    utilityNode: hostNode ?? "unknown",
  };
}

async function createHost(
  workspaceId: string,
  logExit = true,
): Promise<{ client: HostClient; child: UtilityProcess }> {
  const entry = path.join(here, "..", "host", "host.js");
  const child = utilityProcess.fork(entry, [], {
    serviceName: "pidock-node-host",
    env: { ...process.env, PIDOCK_WORKSPACE_ID: workspaceId } as Record<
      string,
      string
    >,
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

function registerIpc(client: HostClient, workspaceId: string): void {
  // Fail-closed: only allowlisted channels are handled; everything else
  // has no handler, so renderer invoke() rejects with "no handler".
  ipcMain.handle("shell/getVersions", async () => {
    const host = await client.getVersions({ workspaceId });
    return {
      ok: true as const,
      payload: { ...versionsTriple(host.node), workspaceId },
    };
  });
  ipcMain.handle(
    "shell/hostPing",
    async (_event, args?: { workspaceId?: string }) => {
      const payload = await client.ping({
        workspaceId: args?.workspaceId ?? workspaceId,
      });
      return { ok: true as const, payload };
    },
  );

  // Belt-and-braces: refuse to register anything outside the whitelist.
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

function rendererSmokeScript(workspaceId: string): string {
  return `(async () => {
    const globals = {
      require: typeof require,
      process: typeof process,
      module: typeof module,
      pidock: typeof window.pidock,
    };
    if (typeof window.pidock !== "object" || window.pidock === null) {
      return { globals, bridge: false };
    }
    const security = window.pidock.getSecurityState();
    const ping = await window.pidock.hostPing(${JSON.stringify(workspaceId)});
    const versions = await window.pidock.getVersions();
    return { globals, bridge: true, security, ping, versions };
  })()`;
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}.${key} is missing or not a non-empty string`);
  }
  return value;
}

function validateSmokeResult(
  raw: unknown,
  workspaceId: string,
  windowEvidence: WindowSecurityEvidence,
): SmokeSuccessReport {
  assertWindowSecurity(windowEvidence);
  if (!isRecord(raw)) {
    throw new Error(`renderer probe returned ${typeof raw}, expected object`);
  }

  const globals = raw["globals"];
  if (!isRecord(globals)) {
    throw new Error("renderer globals evidence is missing");
  }
  if (
    globals["require"] !== "undefined" ||
    globals["process"] !== "undefined" ||
    globals["module"] !== "undefined"
  ) {
    throw new Error(
      `renderer Node globals leaked: ${JSON.stringify(globals)}`,
    );
  }
  if (raw["bridge"] !== true || globals["pidock"] !== "object") {
    throw new Error(
      `window.pidock bridge missing in sandbox renderer: ${JSON.stringify(globals)}`,
    );
  }

  const security = raw["security"];
  if (
    !isRecord(security) ||
    security["sandboxed"] !== true ||
    security["contextIsolated"] !== true
  ) {
    throw new Error(
      `preload security state mismatch: ${JSON.stringify(security)}`,
    );
  }

  const pingEnvelope = raw["ping"];
  if (!isRecord(pingEnvelope) || pingEnvelope["ok"] !== true) {
    throw new Error(
      `host/ping envelope mismatch: ${JSON.stringify(pingEnvelope)}`,
    );
  }
  const ping = pingEnvelope["payload"];
  if (
    !isRecord(ping) ||
    ping["pong"] !== true ||
    ping["workspaceId"] !== workspaceId
  ) {
    throw new Error(`host/ping evidence mismatch: ${JSON.stringify(ping)}`);
  }

  const versionsEnvelope = raw["versions"];
  if (!isRecord(versionsEnvelope) || versionsEnvelope["ok"] !== true) {
    throw new Error(
      `host/getVersions envelope mismatch: ${JSON.stringify(versionsEnvelope)}`,
    );
  }
  const versions = versionsEnvelope["payload"];
  if (!isRecord(versions)) {
    throw new Error("host/getVersions payload is missing");
  }
  const electron = requireString(versions, "electron", "versions");
  const mainNode = requireString(versions, "mainNode", "versions");
  const utilityNode = requireString(versions, "utilityNode", "versions");
  const responseWorkspaceId = requireString(
    versions,
    "workspaceId",
    "versions",
  );
  if (responseWorkspaceId !== workspaceId) {
    throw new Error(
      `host/getVersions workspace mismatch: expected ${workspaceId}, got ${responseWorkspaceId}`,
    );
  }

  return {
    schema: "pidock.shell.smoke.v1",
    ok: true,
    electron,
    mainNode,
    utilityNode,
    window: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
    renderer: {
      bridge: "object",
      globals: {
        require: "undefined",
        process: "undefined",
        module: "undefined",
      },
      security: {
        sandboxed: true,
        contextIsolated: true,
      },
    },
    rpc: {
      ping: { pong: true, workspaceId },
      versions: { electron, mainNode, utilityNode, workspaceId },
    },
  };
}

async function loadShellWindow(
  window: BrowserWindow,
): Promise<{ rendererUrl: string }> {
  const devUrl = process.env["PIDOCK_RENDERER_URL"];
  if (devUrl) {
    await window.loadURL(devUrl);
    return { rendererUrl: devUrl };
  }

  const rendererPath = path.join(here, "..", "renderer", "index.html");
  await window.loadFile(rendererPath);
  return { rendererUrl: `file://${rendererPath}` };
}

async function runSmoke(workspaceId: string): Promise<SmokeReport> {
  const windowEvidence = windowSecurityEvidence();
  const evidence: SmokeEvidence = {
    window: windowEvidence,
    rendererUrl: process.env["PIDOCK_RENDERER_URL"] ?? "pending",
  };
  let stage = "app-ready";
  let client: HostClient | undefined;
  let child: UtilityProcess | undefined;
  let window: BrowserWindow | undefined;

  try {
    await app.whenReady();

    stage = "utility-process";
    const host = await createHost(workspaceId, false);
    client = host.client;
    child = host.child;
    registerIpc(client, workspaceId);

    stage = "window-load";
    window = new BrowserWindow(WINDOW_OPTIONS);
    const loaded = await loadShellWindow(window);
    evidence.rendererUrl = loaded.rendererUrl;

    stage = "renderer-probe";
    const raw = await window.webContents.executeJavaScript(
      rendererSmokeScript(workspaceId),
      true,
    );
    evidence.rendererProbe = raw;
    return validateSmokeResult(raw, workspaceId, windowEvidence);
  } catch (error) {
    return {
      schema: "pidock.shell.smoke.v1",
      ok: false,
      error: { stage, message: errorMessage(error) },
      evidence,
    };
  } finally {
    window?.destroy();
    client?.dispose();
    child?.kill();
  }
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
    process.env["PIDOCK_WORKSPACE_ID"] ?? "s1-default-workspace";
  const command = resolveShellCommand(process.argv, process.env);

  await app.whenReady();

  if (command.kind === "versions") {
    await runVersions(workspaceId);
    app.exit(0);
    return;
  }

  if (command.kind === "smoke") {
    const report = await runSmoke(workspaceId);
    process.stdout.write(
      `PIDOCK_SMOKE_RESULT=${JSON.stringify(report)}\n`,
    );
    app.exit(report.ok ? 0 : 1);
    return;
  }

  const { client } = await createHost(workspaceId);
  registerIpc(client, workspaceId);

  const window = new BrowserWindow({ ...WINDOW_OPTIONS, show: true });
  const security = windowSecurityEvidence();
  assertWindowSecurity(security);
  console.log(`[main] window sandbox contract: ${JSON.stringify(security)}`);
  await loadShellWindow(window);
  await window.webContents
    .executeJavaScript(
      "(() => ({ require: typeof require, process: typeof process, module: typeof module, pidock: typeof window.pidock }))()",
    )
    .then((raw) => {
      console.log(`[main] renderer globals probe: ${String(raw)}`);
    })
    .catch((error: unknown) => {
      console.error(`[main] renderer probe failed: ${errorMessage(error)}`);
    });

  app.on("window-all-closed", () => {
    client.dispose();
    if (process.platform !== "darwin") app.quit();
  });
}

void run().catch((error: unknown) => {
  console.error(`[main] fatal: ${errorMessage(error)}`);
  app.exit(1);
});
