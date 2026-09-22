/**
 * Renderer view of the sandboxed preload bridge (`window.pidock`).
 *
 * The renderer is sandboxed (sandbox:true, contextIsolation:true,
 * nodeIntegration:false) and must never import Node or Electron. All Host
 * traffic goes through the `shell/*` invoke channels main allowlists; task
 * routing ids stay sender-bound in main, so the page can name its own task
 * but never another workspace. Falls back to `null` outside the shell
 * (Vite dev, tests) so pages degrade to the in-memory adapter explicitly.
 */

export interface ShellTaskOpResult {
  ok: boolean;
  payload?: unknown;
  error?: string;
}

export interface PidockBridge {
  getSecurityState?: () => { sandboxed: boolean; contextIsolated: boolean };
  getVersions?: () => Promise<unknown>;
  hostPing?: (workspaceId?: string) => Promise<unknown>;
  taskOp?: (taskId: string, op: string, payload?: Record<string, unknown>) => Promise<ShellTaskOpResult>;
}

declare global {
  interface Window {
    pidock?: PidockBridge;
  }
}

/** `null` outside the Electron shell (Vite dev server, vitest/jsdom). */
export function shellBridge(): PidockBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = window.pidock;
  if (!bridge || typeof bridge !== "object") return null;
  return bridge;
}

/** True when the page runs inside the sandboxed shell view with task routing. */
export function isShellConnected(): boolean {
  return shellBridge()?.taskOp !== undefined && typeof shellBridge()?.taskOp === "function";
}

export type ShellTaskOp =
  | "task/provision"
  | "task/appendRepos"
  | "task/probeLink"
  | "task/sendMessage"
  | "task/cancel"
  | "task/approve"
  | "task/reject"
  | "task/saveDraft"
  | "task/clearDraft"
  | "task/setPermission"
  | "task/listApprovals"
  | "task/getApproval"
  | "task/registerService"
  | "task/planServiceStart"
  | "task/controlService"
  | "task/serviceStatus"
  | "task/serviceLog";

/**
 * Task-scoped op through main into the per-workspace Host. Rejects outside
 * the shell so dev/test callers must opt into the in-memory adapter instead
 * of silently assuming a Host round-trip. `{ok:false,error}` envelopes are
 * returned (never thrown as rejected invokes): callers branch on `ok` and
 * keep the form with a retry entry instead of crashing.
 */
export async function shellTaskOp(
  taskId: string,
  op: ShellTaskOp,
  payload: Record<string, unknown> = {},
): Promise<ShellTaskOpResult> {
  const bridge = shellBridge();
  if (!bridge?.taskOp) throw new Error("当前不在桌面壳内，任务操作走内存模拟数据");
  const result = await bridge.taskOp(taskId, op, payload);
  // Fail-closed envelope guard: a malformed bridge result (or a rejected
  // invoke that a preload shim rethrows) surfaces as `{ok:false}` so the
  // task form can keep its input and offer retry.
  if (!result || typeof result !== "object" || typeof (result as ShellTaskOpResult).ok !== "boolean") {
    return { ok: false, error: "invalid-payload: 任务操作返回异常，请重试" };
  }
  return result;
}

export type ShellTurnPayload = {
  text: string;
  tool?: string;
  target?: string;
  contentVersion?: string;
  /** Planner selector the Host maps to an in-Host script (never a function). */
  toolPlan?: "echo" | "deny";
  providerId?: string;
  model?: string;
  /** Structured input refs (`@` picks) persisted by the Host; never interpreted. */
  references?: Array<Record<string, unknown>>;
  /** Skill source (`$` pick) persisted by the Host; never interpreted. */
  skillSource?: string;
};

/**
 * [PiDock 02] send one chat turn through the shell (`host/task` +
 * `task/sendMessage`). Carries the scripted tool plan as plain data
 * (`tool`/`target`/`contentVersion` + `toolPlan` selector); the Host maps
 * it to an in-Host planner so the real `exec.run` approval path is
 * reachable end-to-end. `{ok:false,error}` envelopes are returned, never
 * thrown, so the composer keeps its input and offers retry.
 */
export async function sendMessageThroughShell(input: {
  taskId: string;
  sessionId: string;
} & ShellTurnPayload): Promise<ShellTaskOpResult> {
  const payload: Record<string, unknown> = { sessionId: input.sessionId, text: input.text };
  for (const key of ["tool", "target", "contentVersion", "toolPlan", "providerId", "model", "references", "skillSource"] as const) {
    const value = input[key];
    if (value !== undefined) payload[key] = value;
  }
  try {
    return await shellTaskOp(input.taskId, "task/sendMessage", payload);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * [PiDock 02] provision one task through the shell (`host/task` +
 * `task/provision`), with `{ok:false,error}` envelope handling. The caller
 * keeps the form on failure and offers retry; stale references never
 * create. `null` outside the shell so dev/test callers fall back to the
 * in-memory adapter explicitly.
 */
export async function provisionTaskThroughShell(input: {
  taskId: string;
  name: string;
  dirId: string;
  branch?: string;
  rootOverride?: string;
  remoteBranch: string;
  fetchedCommit: string;
  repos?: string[];
  mainCheckouts?: Record<string, string>;
  /**
   * [PiDock 03] (#6) per-repo sources: each entry names its own remote +
   * baseline branch; `fetchedCommits` pins each repo's fresh commit
   * (all-success gate Host-side). `plainDirs` snapshots plain-directory
   * links (shared views of the originals, never copies).
   */
  repoSelections?: { repoDir: string; remote: string; remoteBranch: string; mainCheckoutDir: string }[];
  fetchedCommits?: Record<string, string>;
  plainDirs?: { directoryId: string; sourcePath: string }[];
}): Promise<ShellTaskOpResult> {
  const payload: Record<string, unknown> = {
    name: input.name,
    dirId: input.dirId,
    remoteBranch: input.remoteBranch,
    fetchedCommit: input.fetchedCommit,
  };
  if (input.branch !== undefined) payload["branch"] = input.branch;
  if (input.rootOverride !== undefined) payload["rootOverride"] = input.rootOverride;
  if (input.repos !== undefined) payload["repos"] = input.repos;
  if (input.mainCheckouts !== undefined) payload["mainCheckouts"] = input.mainCheckouts;
  if (input.repoSelections !== undefined) payload["repoSelections"] = input.repoSelections;
  if (input.fetchedCommits !== undefined) payload["fetchedCommits"] = input.fetchedCommits;
  if (input.plainDirs !== undefined) payload["plainDirs"] = input.plainDirs;
  try {
    return await shellTaskOp(input.taskId, "task/provision", payload);
  } catch (error) {
    // A rejected invoke (bridge/transport failure) still arrives as an
    // envelope so the form can keep its input and offer retry.
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * [PiDock 03] (#6) append repos to a task through the shell (`host/task` +
 * `task/appendRepos`). Only repos not already in the task are
 * fetched/planned; the form stays on failure with a per-repo retry entry.
 */
export async function appendReposThroughShell(input: {
  taskId: string;
  repoSelections: { repoDir: string; remote: string; remoteBranch: string; mainCheckoutDir: string }[];
  fetchedCommits: Record<string, string>;
  branch?: string;
  mainCheckouts?: Record<string, string>;
  /**
   * Caller-scanned conflict inputs (REQUIRED, never defaulted): the
   * renderer scans the task folder + `git worktree list` first; the
   * Host and the RPC guard fail closed without them.
   */
  takenPaths: string[];
  branchesInUse: string[];
}): Promise<ShellTaskOpResult> {
  const payload: Record<string, unknown> = {
    repoSelections: input.repoSelections,
    fetchedCommits: input.fetchedCommits,
    takenPaths: input.takenPaths,
    branchesInUse: input.branchesInUse,
  };
  if (input.branch !== undefined) payload["branch"] = input.branch;
  if (input.mainCheckouts !== undefined) payload["mainCheckouts"] = input.mainCheckouts;
  try {
    return await shellTaskOp(input.taskId, "task/appendRepos", payload);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * [PiDock 03] (#6) probe a plain-dir link source through the shell
 * (`host/task` + `task/probeLink`). Report only: `{shape: ok/dead}` —
 * never creates, follows, or takes over the target.
 */
export async function probeLinkThroughShell(input: {
  taskId: string;
  sourcePath: string;
}): Promise<ShellTaskOpResult> {
  try {
    return await shellTaskOp(input.taskId, "task/probeLink", { sourcePath: input.sourcePath });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * [PiDock 04] (#7) service ops through the shell (`host/task` +
 * `task/registerService|planServiceStart|controlService|serviceStatus|
 * serviceLog`). `{ok:false,error}` envelopes are returned, never thrown,
 * so forms keep their input and offer retry. Resolved snapshots arrive
 * with secrets masked (`••••••••`); the real values stay Host-side.
 */
export async function registerServiceThroughShell(input: {
  taskId: string;
  serviceId: string;
  descriptor: Record<string, unknown>;
  layers: Record<string, unknown>;
  templateVersion: string;
}): Promise<ShellTaskOpResult> {
  try {
    return await shellTaskOp(input.taskId, "task/registerService", {
      serviceId: input.serviceId,
      descriptor: input.descriptor,
      layers: input.layers,
      templateVersion: input.templateVersion,
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function controlServiceThroughShell(input: {
  taskId: string;
  serviceId: string;
  action: "start" | "stop";
  /** Absent = human-explicit (labelled); present = agent control via the session gate. */
  sessionId?: string;
  label?: string;
  approvalGranted?: boolean;
}): Promise<ShellTaskOpResult> {
  const payload: Record<string, unknown> = { serviceId: input.serviceId, action: input.action };
  if (input.sessionId !== undefined) payload["sessionId"] = input.sessionId;
  else {
    payload["actor"] = "human";
    if (input.label !== undefined) payload["label"] = input.label;
  }
  if (input.approvalGranted !== undefined) payload["approvalGranted"] = input.approvalGranted;
  try {
    return await shellTaskOp(input.taskId, "task/controlService", payload);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function serviceStatusThroughShell(input: {
  taskId: string;
  serviceId: string;
}): Promise<ShellTaskOpResult> {
  try {
    return await shellTaskOp(input.taskId, "task/serviceStatus", { serviceId: input.serviceId });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function serviceLogThroughShell(input: {
  taskId: string;
  serviceId: string;
  limit?: number;
}): Promise<ShellTaskOpResult> {
  const payload: Record<string, unknown> = { serviceId: input.serviceId };
  if (input.limit !== undefined) payload["limit"] = input.limit;
  try {
    return await shellTaskOp(input.taskId, "task/serviceLog", payload);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
