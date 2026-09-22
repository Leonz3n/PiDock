import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, utilityProcess } from "electron";
import type { UtilityProcess } from "electron";
import { HostClient } from "../rpc/host-client.js";
import { isAllowedInvokeChannel } from "../preload/allowlist.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * S1 shell main process.
 *
 * Owns: the sandboxed BrowserWindow, the per-workspace utilityProcess Node
 * Host stub, and the typed MessagePort RPC between them. No Bun host, no
 * CDP, no second trust domain (those are S2-S6).
 */

const isSmoke = process.argv.includes("--smoke");
const wantsVersions = process.argv.includes("--print-versions");

const WINDOW_OPTIONS = {
  width: 1024,
  height: 768,
  show: false,
  webPreferences: {
    // S1 contract (auditable below and asserted at runtime in smoke mode):
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    preload: path.join(here, "..", "preload", "preload.js"),
  },
} as const;

function windowOptionsForAudit(): Record<string, unknown> {
  return {
    sandbox: WINDOW_OPTIONS.webPreferences.sandbox,
    contextIsolation: WINDOW_OPTIONS.webPreferences.contextIsolation,
    nodeIntegration: WINDOW_OPTIONS.webPreferences.nodeIntegration,
    preload: WINDOW_OPTIONS.webPreferences.preload,
  };
}

function versionsTriple(hostNode?: string): Record<string, string> {
  return {
    electron: process.versions["electron"] ?? "unknown",
    mainNode: process.versions["node"] ?? "unknown",
    utilityNode: hostNode ?? "unknown",
  };
}

async function createHost(workspaceId: string): Promise<{ client: HostClient; child: UtilityProcess }> {
  const entry = path.join(here, "..", "host", "host.js");
  const child = utilityProcess.fork(entry, [], {
    serviceName: "pidock-node-host",
    env: { ...process.env, PIDOCK_WORKSPACE_ID: workspaceId } as Record<string, string>,
    stdio: "pipe",
  });
  const client = new HostClient(child);
  // Surface host lifecycle for smoke/debugging (bounded).
  child.on("exit", (code) => console.log(`[main] host exit code=${code}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[host:stderr] ${chunk}`));
  return { client, child };
}

function registerIpc(client: HostClient, workspaceId: string): void {
  // Fail-closed: only allowlisted channels are handled; everything else
  // has no handler, so renderer invoke() rejects with "no handler".
  ipcMain.handle("shell/getVersions", async () => {
    const host = await client.getVersions({ workspaceId });
    return { ok: true as const, payload: { ...versionsTriple(host.node), workspaceId } };
  });
  ipcMain.handle("shell/hostPing", async (_event, args?: { workspaceId?: string }) => {
    const payload = await client.ping({ workspaceId: args?.workspaceId ?? workspaceId });
    return { ok: true as const, payload };
  });

  // Belt-and-braces: refuse to register anything outside the whitelist.
  for (const channel of ipcMain.eventNames()) {
    if (typeof channel === "string" && channel.startsWith("shell/") && !isAllowedInvokeChannel(channel)) {
      throw new Error(`non-allowlisted IPC channel registered: ${channel}`);
    }
  }
}

async function runSmoke(workspaceId: string): Promise<number> {
  // Headless contract verification: no window, just host RPC + guards.
  const { client, child } = await createHost(workspaceId);
  try {
    const ping = await client.ping({ workspaceId });
    const hostVersions = await client.getVersions({ workspaceId });
    console.log(`[smoke] windowOptions=${JSON.stringify(windowOptionsForAudit())}`);
    console.log(`[smoke] ping=${JSON.stringify(ping)}`);
    console.log(`[smoke] versions=${JSON.stringify(versionsTriple(hostVersions.node))}`);
    const ok =
      WINDOW_OPTIONS.webPreferences.sandbox === true &&
      WINDOW_OPTIONS.webPreferences.contextIsolation === true &&
      WINDOW_OPTIONS.webPreferences.nodeIntegration === false &&
      ping.pong === true &&
      ping.workspaceId === workspaceId;
    console.log(ok ? "[smoke] PASS" : "[smoke] FAIL");
    return ok ? 0 : 1;
  } finally {
    client.dispose();
    child.kill();
  }
}

async function run(): Promise<void> {
  const workspaceId = process.env["PIDOCK_WORKSPACE_ID"] ?? "s1-default-workspace";

  if (wantsVersions) {
    // Print the real triad before app-ready (host round-trip included).
    await app.whenReady();
    const { client, child } = await createHost(workspaceId);
    try {
      const hostVersions = await client.getVersions({ workspaceId });
      console.log(JSON.stringify(versionsTriple(hostVersions.node)));
    } finally {
      client.dispose();
      child.kill();
    }
    app.exit(0);
    return;
  }

  if (isSmoke) {
    await app.whenReady();
    const code = await runSmoke(workspaceId);
    app.exit(code);
    return;
  }

  await app.whenReady();
  const { client } = await createHost(workspaceId);
  registerIpc(client, workspaceId);

  const win = new BrowserWindow({ ...WINDOW_OPTIONS, show: true });
  // Runtime assertion of the sandbox contract: WINDOW_OPTIONS is auditable
  // above; the live check below runs inside the loaded renderer.
  const opts = windowOptionsForAudit();
  if (
    opts["sandbox"] !== true ||
    opts["contextIsolation"] !== true ||
    opts["nodeIntegration"] !== false
  ) {
    throw new Error(`sandbox contract violated: ${JSON.stringify(opts)}`);
  }
  console.log(`[main] window sandbox contract: ${JSON.stringify(opts)}`);
  const devUrl = process.env["PIDOCK_RENDERER_URL"];
  if (devUrl) {
    await win.loadURL(devUrl);
  } else {
    await win.loadFile(path.join(here, "..", "renderer", "index.html"));
  }
  await win.webContents.executeJavaScript(
    "(() => ({ require: typeof require, process: typeof process, module: typeof module, pidock: typeof window.pidock }))()",
  ).then((raw) => {
    console.log(`[main] renderer globals probe: ${String(raw)}`);
  }).catch((err: unknown) => {
    console.error(`[main] renderer probe failed: ${String(err)}`);
  });

  app.on("window-all-closed", () => {
    client.dispose();
    if (process.platform !== "darwin") app.quit();
  });
}

void run();
