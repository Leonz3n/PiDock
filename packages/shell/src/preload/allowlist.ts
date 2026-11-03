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
  "shell/listTasks",
  "shell/importTaskRoot",
  "shell/projectOp",
  "shell/serviceCatalogOp",
  "shell/createTask",
  "shell/appendTaskRepos",
  // [PiDock 10] (#15 box 28) 从任务打开外部编辑器: the page names a task and one of
  // that task's own roots; main reads the editor program from its own user
  // settings and launches it. This is a dedicated attested entry — the op is
  // deliberately absent from the renderer task-op set and refused by name on
  // `shell/taskOp`, so page code can never name the program.
  "shell/openTaskEditor",
  // [PiDock 10] (#15 box 28) the SAVE path for the editor program the launch
  // reads. The page names a program (and its own args) and nothing else: main
  // validates it with the launch's own rules, probes it on disk, and writes its
  // OWN machine-private document atomically. It is not a task op — nothing is
  // added to the renderer task-op set — so this write can never travel on
  // `shell/taskOp`.
  "shell/editorSettingsOp",
  // [Pencil T14] #149 the settings surface: PiDock's appearance document plus
  // Pi's native keybindings as a bounded projection. Four named ops; the page
  // names no path, no file and no unverified Pi action.
  "shell/preferencesOp",
  "shell/providerOp",
  // [Pencil T15] issue 150 the MCP management surface over Pi's native
  // mcp.json: list/save/remove/enable/disable/test only. The page names a
  // server (or a form draft), never a file, a path or a credential value.
  "shell/mcpOp",
  // [Pencil T16] #151 local Skills sources: one channel, four named ops. The
  // page names a directory or a source id; main owns the app-private document
  // and the real-disk scan.
  "shell/skillsOp",
  // [Pencil T18] #153 the scheduler phase (active / asleep / quitting) plus the
  // last unconfirmed quit. Read-only and main-owned; the page names no field.
  "shell/schedulerState",
  "shell/taskOp",
  "shell/sdkTurn",
] as const;

export type AllowedInvokeChannel = (typeof ALLOWED_INVOKE_CHANNELS)[number];

/** Renderer-subscribable event channels (main->renderer push). */
export const ALLOWED_EVENT_CHANNELS = ["shell/hostStatus", "shell/sdkTurnEvent"] as const;

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
