/* global require, process */
/**
 * Minimal preload bridge (plain script, no imports).
 *
 * Runs in the isolated preload world (contextIsolation:true) for a
 * sandboxed renderer (sandbox:true, nodeIntegration:false). Exposes only
 * the whitelisted request/event channels under `window.pidock` — never
 * raw `ipcRenderer`, never Node, never CDP.
 *
 * NOTE: this file must stay dependency-free (no `import`) because the
 * sandboxed preload has no module resolution for relative files; the
 * whitelist lives inline and is mirrored by
 * src/preload/allowlist.ts (unit-tested there).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports -- sandboxed preloads receive Electron through the built-in require.
const { contextBridge, ipcRenderer } = require("electron");

const BRIDGE_NAME = "pidock";
const INVOKE_CHANNELS = ["shell/getVersions", "shell/hostPing", "shell/taskOp"];
const EVENT_CHANNELS = ["shell/hostStatus"];

// Preload-only capabilities (NOT visible to the page itself). Sandboxed
// preloads receive Electron through the limited built-in `require`; only
// `window.pidock` is exposed to the page.

function isAllowedInvoke(channel) {
  return INVOKE_CHANNELS.indexOf(channel) !== -1;
}

function invoke(channel, args) {
  if (!isAllowedInvoke(channel)) {
    return Promise.reject(new Error("blocked invoke channel: " + String(channel)));
  }
  return ipcRenderer.invoke(channel, args);
}

const bridge = {
  getSecurityState: function () {
    return {
      sandboxed: process.sandboxed === true,
      contextIsolated: process.contextIsolated === true,
    };
  },
  getVersions: function () {
    return invoke("shell/getVersions");
  },
  hostPing: function (workspaceId) {
    return invoke(
      "shell/hostPing",
      workspaceId === undefined ? undefined : { workspaceId: workspaceId }
    );
  },
  taskOp: function (taskId, op, payload) {
    return invoke("shell/taskOp", {
      taskId: taskId,
      op: op,
      payload: payload === undefined ? {} : payload,
    });
  },
  onHostStatus: function (listener) {
    var channel = EVENT_CHANNELS[0];
    var wrapped = function (_event, payload) {
      listener(payload);
    };
    ipcRenderer.on(channel, wrapped);
    return function () {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
};

// The sandboxed page cannot reach them; only this isolated script can.
// NOTE: only `window.pidock` is exposed to the page. Do NOT add a second
// exposeInMainWorld (e.g. raw ipcRenderer): the page must never gain an
// arbitrary-IPC handle. Runtime probe in main.ts asserts exactly this.
contextBridge.exposeInMainWorld(BRIDGE_NAME, bridge);
