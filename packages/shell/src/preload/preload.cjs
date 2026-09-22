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

const BRIDGE_NAME = "pidock";
const INVOKE_CHANNELS = ["shell/getVersions", "shell/hostPing"];
const EVENT_CHANNELS = ["shell/hostStatus"];

// Preload-only globals (NOT visible to the page itself). `contextBridge`
// and `ipcRenderer` are injected by Electron into the isolated preload
// world; only `window.pidock` is ever exposed to the page.

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
  getVersions: function () {
    return invoke("shell/getVersions");
  },
  hostPing: function (workspaceId) {
    return invoke("shell/hostPing", { workspaceId: workspaceId });
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

// `contextBridge` / `ipcRenderer` are preload globals injected by Electron;
// they do not exist in a plain node typecheck context.
// The sandboxed page cannot reach them; only this isolated script can.
// NOTE: only `window.pidock` is exposed to the page. Do NOT add a second
// exposeInMainWorld (e.g. raw ipcRenderer): the page must never gain an
// arbitrary-IPC handle. Runtime probe in main.ts asserts exactly this.
contextBridge.exposeInMainWorld(BRIDGE_NAME, bridge);
