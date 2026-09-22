/**
 * Preload bridge whitelist (S1).
 *
 * The renderer is sandboxed (sandbox:true, contextIsolation:true,
 * nodeIntegration:false) and sees exactly one global — `window.pidock` —
 * with the methods listed below. No Node, no arbitrary `ipcRenderer`
 * access, no CDP surface. Main enforces the same list on the ipcMain side.
 */

export const PRELOAD_BRIDGE_NAME = "pidock" as const;

/** Renderer->main request channels exposed through the bridge. */
export const ALLOWED_INVOKE_CHANNELS = [
  "shell/getVersions",
  "shell/hostPing",
  "shell/taskOp",
] as const;

export type AllowedInvokeChannel = (typeof ALLOWED_INVOKE_CHANNELS)[number];

/** Renderer-subscribable event channels (main->renderer push). */
export const ALLOWED_EVENT_CHANNELS = ["shell/hostStatus"] as const;

export type AllowedEventChannel = (typeof ALLOWED_EVENT_CHANNELS)[number];

export function isAllowedInvokeChannel(value: unknown): value is AllowedInvokeChannel {
  return (
    typeof value === "string" &&
    (ALLOWED_INVOKE_CHANNELS as readonly string[]).includes(value)
  );
}

export function isAllowedEventChannel(value: unknown): value is AllowedEventChannel {
  return (
    typeof value === "string" &&
    (ALLOWED_EVENT_CHANNELS as readonly string[]).includes(value)
  );
}
