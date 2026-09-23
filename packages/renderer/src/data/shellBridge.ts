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
  | "task/serviceLog"
  | "task/planServiceGroup"
  | "task/serviceRunRecords"
  | "task/serviceStopScope"
  | "task/planProtocol"
  | "task/protocolState"
  | "task/recordProtocolRun"
  | "task/browserAction"
  | "task/setProviderCatalog"
  | "task/sessionContext"
  | "task/setSessionModel"
  | "task/setSessionThinking"
  | "task/sessionStates"
  | "task/compactSession"
  | "task/usageRecords"
  | "task/clearUsage";

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

/**
 * [PiDock 05] (#10) plan the task's multi-service topology on the Host
 * (`task/planServiceGroup`): units, final ports, variable bindings, routing,
 * start groups and diagnostics. Sending no `sessionId` keeps the attested
 * human-UI path (the plan is labelled with the actor). The response carries
 * no env layers and no secret values — only masked/derived task addresses.
 */
export async function planServiceGroupThroughShell(input: {
  taskId: string;
  units: Record<string, unknown>[];
  selectedRepoDirs?: string[];
  dependencies?: { from: string; to: string; kind: "call" | "prestart" }[];
  requests?: { unitId: string; port: number }[];
  reservations?: { port: number; owner: "external" | "task"; taskId?: string; unitId?: string; serviceId?: string; note?: string }[];
  rules?: { key: string; unitId: string; kind: "url" | "host-port"; template?: string }[];
  layers?: Record<string, unknown>;
  environment?: string;
  externalResources?: { resourceId: string; name: string; kind: string; isolatedByTask?: boolean }[];
}): Promise<ShellTaskOpResult> {
  const payload: Record<string, unknown> = { units: input.units };
  if (input.selectedRepoDirs !== undefined) payload["selectedRepoDirs"] = input.selectedRepoDirs;
  if (input.dependencies !== undefined) payload["dependencies"] = input.dependencies;
  if (input.requests !== undefined) payload["requests"] = input.requests;
  if (input.reservations !== undefined) payload["reservations"] = input.reservations;
  if (input.rules !== undefined) payload["rules"] = input.rules;
  if (input.layers !== undefined) payload["layers"] = input.layers;
  if (input.environment !== undefined) payload["environment"] = input.environment;
  if (input.externalResources !== undefined) payload["externalResources"] = input.externalResources;
  try {
    return await shellTaskOp(input.taskId, "task/planServiceGroup", payload);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * [PiDock 05] (#10) read the Host's run records + registered process
 * identities (`task/serviceRunRecords`) and the stop scope for one instance
 * or the whole task (`task/serviceStopScope`). Read-only: the scope is
 * computed from registered identities, never from a port or a stale PID.
 */
export async function serviceRunRecordsThroughShell(taskId: string): Promise<ShellTaskOpResult> {
  try {
    return await shellTaskOp(taskId, "task/serviceRunRecords", {});
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function serviceStopScopeThroughShell(input: {
  taskId: string;
  instanceId?: string;
}): Promise<ShellTaskOpResult> {
  const payload: Record<string, unknown> = {};
  if (input.instanceId !== undefined) payload["instanceId"] = input.instanceId;
  try {
    return await shellTaskOp(input.taskId, "task/serviceStopScope", payload);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * [PiDock 08] (#14) plan the task's protocol binding on the Host
 * (`task/planProtocol`): the protocol repository, the mode (release
 * dependencies vs. this task's artifact), the repository's own generation
 * steps and the selected consumers. Sending no `sessionId` keeps the
 * attested human-UI path; `acknowledged` carries the per-consumer
 * confirmation a cross-version switch requires before the Host marks a
 * consumer bound.
 */
export async function planProtocolThroughShell(input: {
  taskId: string;
  protocol: { repoDir: string; goGenDir: string; tsGenDir: string };
  mode: "release" | "local";
  steps?: { kind: "generate" | "postprocess"; program: string; args: string[]; cwd: string; note?: string }[];
  consumers: {
    consumerId: string;
    name: string;
    repoDir: string;
    language: "go" | "ts";
    serviceId?: string;
    releaseDependency: string;
    linkScript?: string;
    linkTarget?: string;
  }[];
  acknowledged?: string[];
}): Promise<ShellTaskOpResult> {
  const payload: Record<string, unknown> = { protocol: input.protocol, mode: input.mode, consumers: input.consumers };
  if (input.steps !== undefined) payload["steps"] = input.steps;
  if (input.acknowledged !== undefined) payload["acknowledged"] = input.acknowledged;
  try {
    return await shellTaskOp(input.taskId, "task/planProtocol", payload);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * [PiDock 08] (#14) read the Host's protocol state (`task/protocolState`):
 * prepare state, actual generated version, per-consumer binding and staleness,
 * toolchain result and the switch blockers. Read-only.
 */
export async function protocolStateThroughShell(taskId: string): Promise<ShellTaskOpResult> {
  try {
    return await shellTaskOp(taskId, "task/protocolState", {});
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * [PiDock 08] (#14) record what a real generation/binding run observed
 * (`task/recordProtocolRun`). Everything here is caller-reported evidence —
 * the generated version, the toolchain probe, the install state and each
 * consumer's resolved path — and the Host only marks a consumer bound when
 * that resolution really verifies.
 */
export async function recordProtocolRunThroughShell(input: {
  taskId: string;
  generatedVersion: string;
  ok: boolean;
  note?: string;
  toolchain?: { platform: string; probe?: Record<string, { ok: boolean; version?: string; note?: string }> };
  depsInstalled?: { consumerId: string; installed: boolean }[];
  resolutions?: { consumerId: string; path: string; version?: string | null }[];
  runtimeReachable?: { ok: boolean; detail: string };
}): Promise<ShellTaskOpResult> {
  const payload: Record<string, unknown> = { generatedVersion: input.generatedVersion, ok: input.ok };
  if (input.note !== undefined) payload["note"] = input.note;
  if (input.toolchain !== undefined) payload["toolchain"] = input.toolchain;
  if (input.depsInstalled !== undefined) payload["depsInstalled"] = input.depsInstalled;
  if (input.resolutions !== undefined) payload["resolutions"] = input.resolutions;
  if (input.runtimeReachable !== undefined) payload["runtimeReachable"] = input.runtimeReachable;
  try {
    return await shellTaskOp(input.taskId, "task/recordProtocolRun", payload);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function controlServiceThroughShell(input: {
  taskId: string;
  serviceId: string;
  action: "start" | "stop";
  /** Present = agent control via the session gate (verified `approvalId`); absent = human-explicit (labelled). */
  sessionId?: string;
  label?: string;
  /** Live approval id for default-tier agent control (verified Host-side; booleans are never trusted). */
  approvalId?: string;
}): Promise<ShellTaskOpResult> {
  const payload: Record<string, unknown> = { serviceId: input.serviceId, action: input.action };
  if (input.sessionId !== undefined) {
    payload["sessionId"] = input.sessionId;
    if (input.approvalId !== undefined) payload["approvalId"] = input.approvalId;
  } else if (input.label !== undefined) {
    payload["label"] = input.label;
  }
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

/**
 * [PiDock 06] (#8) one gated task-browser action through the shell
 * (`host/task` + `task/browserAction`). The renderer never speaks to
 * Chromium/CDP: main owns the visible page and validates the page handle,
 * the task's navigation allowlist and the takeover state; the Host adds the
 * session permission gate for agent calls. `{ok:false,error}` envelopes are
 * returned, never thrown, so the panel keeps its state and can show the
 * refusal (e.g. `approval-required: <id>`, `takeover-paused`, a denied
 * navigation target).
 */
export async function browserActionThroughShell(input: {
  taskId: string;
  action: string;
  /** Page handle of the task page the action addresses (absent for `page/open`). */
  page?: { taskId?: string; pageId: string; webContentsId?: number };
  params?: Record<string, unknown>;
  /** Agent calls name their session; UI calls omit it (attested human path). */
  sessionId?: string;
  approvalId?: string;
  /** Session a user marker is logged into; defaults to the task's session. */
  targetSessionId?: string;
  label?: string;
}): Promise<ShellTaskOpResult> {
  const payload: Record<string, unknown> = { action: input.action };
  if (input.page !== undefined) payload["page"] = input.page;
  if (input.params !== undefined) payload["params"] = input.params;
  if (input.sessionId !== undefined) {
    payload["sessionId"] = input.sessionId;
    if (input.approvalId !== undefined) payload["approvalId"] = input.approvalId;
  } else {
    if (input.targetSessionId !== undefined) payload["targetSessionId"] = input.targetSessionId;
    if (input.label !== undefined) payload["label"] = input.label;
  }
  try {
    return await shellTaskOp(input.taskId, "task/browserAction", payload);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * [PiDock 11] (#9) provider/model/context ops through the shell
 * (`host/task` + `task/setProviderCatalog|sessionContext|setSessionModel|
 * setSessionThinking|compactSession`). The redacted provider catalog (ids,
 * names, protocols and model declarations — never an auth reference value)
 * rides the switch so the Host validates the selection and enforces the switch
 * gate itself. `{ok:false,error}` envelopes are returned, never thrown, so the
 * picker keeps its state and shows the refusal (e.g. `busy-round`,
 * `context-over-limit`).
 */
export async function setProviderCatalogThroughShell(input: {
  taskId: string;
  catalog: Record<string, unknown>[];
}): Promise<ShellTaskOpResult> {
  try {
    return await shellTaskOp(input.taskId, "task/setProviderCatalog", { catalog: input.catalog });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function sessionContextThroughShell(input: {
  taskId: string;
  sessionId: string;
  catalog?: Record<string, unknown>[];
}): Promise<ShellTaskOpResult> {
  const payload: Record<string, unknown> = { sessionId: input.sessionId };
  if (input.catalog !== undefined) payload["catalog"] = input.catalog;
  try {
    return await shellTaskOp(input.taskId, "task/sessionContext", payload);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function setSessionModelThroughShell(input: {
  taskId: string;
  sessionId: string;
  providerId: string;
  model: string;
  reason?: "human-switch" | "agent-switch";
  catalog?: Record<string, unknown>[];
}): Promise<ShellTaskOpResult> {
  const payload: Record<string, unknown> = {
    sessionId: input.sessionId,
    providerId: input.providerId,
    model: input.model,
  };
  if (input.reason !== undefined) payload["reason"] = input.reason;
  if (input.catalog !== undefined) payload["catalog"] = input.catalog;
  try {
    return await shellTaskOp(input.taskId, "task/setSessionModel", payload);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function setSessionThinkingThroughShell(input: {
  taskId: string;
  sessionId: string;
  level: string;
  catalog?: Record<string, unknown>[];
}): Promise<ShellTaskOpResult> {
  const payload: Record<string, unknown> = { sessionId: input.sessionId, level: input.level };
  if (input.catalog !== undefined) payload["catalog"] = input.catalog;
  try {
    return await shellTaskOp(input.taskId, "task/setSessionThinking", payload);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function compactSessionThroughShell(input: {
  taskId: string;
  sessionId: string;
  catalog?: Record<string, unknown>[];
}): Promise<ShellTaskOpResult> {
  const payload: Record<string, unknown> = { sessionId: input.sessionId };
  if (input.catalog !== undefined) payload["catalog"] = input.catalog;
  try {
    return await shellTaskOp(input.taskId, "task/compactSession", payload);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * [PiDock 12] #12 usage read: the Host owns the ledger, so the statistics page
 * asks for the filtered/grouped report instead of re-deriving totals here.
 */
export async function usageRecordsThroughShell(input: {
  taskId: string;
  filter?: Record<string, unknown>;
}): Promise<ShellTaskOpResult> {
  try {
    return await shellTaskOp(input.taskId, "task/usageRecords", { ...(input.filter ?? {}) });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** [PiDock 12] #12 usage cleanup in one explicit scope (never on archive). */
export async function clearUsageThroughShell(input: {
  taskId: string;
  scope: { kind: "all" } | { kind: "session"; sessionId: string } | { kind: "before"; before: string };
}): Promise<ShellTaskOpResult> {
  try {
    return await shellTaskOp(input.taskId, "task/clearUsage", { scope: { ...input.scope } });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
