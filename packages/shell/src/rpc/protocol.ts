/**
 * Typed RPC protocol for main <-> utilityProcess (Node Host).
 *
 * Only the `host/*` namespace exists. No CDP, no arbitrary IPC, no
 * shell/exec surface. New methods must be added to REQUEST_METHODS and
 * given an explicit Params/Result pair below. S3 slice adds the task-scoped
 * `host/task` routing used by [PiDock 02] (#5): every params object carries
 * the sender-bound workspaceId/taskId, validated at runtime on both sides.
 */

/** Whitelisted request methods (fail-closed: unknown methods are rejected). */
export const REQUEST_METHODS = [
  "host/ping",
  "host/getVersions",
  "host/task",
] as const;

export type RequestMethod = (typeof REQUEST_METHODS)[number];

/** Upper bound for a single decoded message envelope (1 MiB). */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

export interface HostPingParams {
  /** Workspace this host serves (opaque to the transport; used for isolation). */
  workspaceId?: string;
}

export interface HostPingResult {
  pong: true;
  workspaceId: string;
  /** Host-side wall clock, for smoke assertions only. */
  hostTime: number;
}

export interface HostGetVersionsParams {
  workspaceId?: string;
}

export interface HostVersionsResult {
  node: string;
  v8: string;
  workspaceId: string;
}

/** Task-scoped operation routed to one task workspace Host. */
export type HostTaskOp =
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
  | "task/browserAction"
  | "task/setProviderCatalog"
  | "task/sessionContext"
  | "task/setSessionModel"
  | "task/setSessionThinking"
  | "task/compactSession";

/**
 * Sender attestation stamped by the trusted main process on a routed
 * `host/task` call ([PiDock 04] #7). It rides the envelope main builds
 * from the validated sender (`registry.requireShellSender`), never the
 * renderer payload, so a browser-side caller cannot mint it. The Host
 * reads it only to decide that a session-less service control came from
 * the human UI; ops arriving any other way must name their session.
 */
export interface TaskOpOrigin {
  kind: "shell-ui";
  /** webContents id of the shell trust-domain sender (audit only). */
  senderWebContentsId: number;
}

export function isTaskOpOrigin(value: unknown): value is TaskOpOrigin {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record["kind"] !== "shell-ui") return false;
  const sender = record["senderWebContentsId"];
  return typeof sender === "number" && Number.isInteger(sender) && sender > 0;
}

export interface HostTaskParams {
  workspaceId: string;
  taskId: string;
  op: HostTaskOp;
  /** Opaque per-op payload; validated per op by the Host. */
  payload?: Record<string, unknown>;
  /** Main-stamped sender attestation; see `TaskOpOrigin`. */
  origin?: TaskOpOrigin;
}

export interface HostTaskResult {
  workspaceId: string;
  taskId: string;
  op: HostTaskOp;
  payload: Record<string, unknown>;
}

export type RequestParams = HostPingParams | HostGetVersionsParams | HostTaskParams;

export interface RpcRequest {
  kind: "request";
  id: string;
  method: RequestMethod;
  params: RequestParams;
}

export interface RpcOkResponse {
  kind: "response";
  id: string;
  ok: true;
  payload: HostPingResult | HostVersionsResult | HostTaskResult;
}

export interface RpcErrorResponse {
  kind: "response";
  id: string;
  ok: false;
  error: string;
}

export type RpcResponse = RpcOkResponse | RpcErrorResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function approxBytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? MAX_MESSAGE_BYTES + 1;
  } catch {
    return MAX_MESSAGE_BYTES + 1;
  }
}

export function isRequestMethod(value: unknown): value is RequestMethod {
  return (
    typeof value === "string" &&
    (REQUEST_METHODS as readonly string[]).includes(value)
  );
}

const HOST_TASK_OPS: readonly string[] = [
  "task/provision",
  "task/appendRepos",
  "task/probeLink",
  "task/sendMessage",
  "task/cancel",
  "task/approve",
  "task/reject",
  "task/saveDraft",
  "task/clearDraft",
  "task/setPermission",
  "task/listApprovals",
  "task/getApproval",
  "task/registerService",
  "task/planServiceStart",
  "task/controlService",
  "task/serviceStatus",
  "task/serviceLog",
  "task/planServiceGroup",
  "task/serviceRunRecords",
  "task/serviceStopScope",
  "task/browserAction",
  "task/setProviderCatalog",
  "task/sessionContext",
  "task/setSessionModel",
  "task/setSessionThinking",
  "task/compactSession",
];

export function isHostTaskOp(value: unknown): value is HostTaskOp {
  return typeof value === "string" && HOST_TASK_OPS.includes(value);
}

/** Fail-closed guard: only whitelisted methods with a params object pass. */
export function isRpcRequest(value: unknown): value is RpcRequest {
  if (!isRecord(value)) return false;
  if (value["kind"] !== "request") return false;
  if (typeof value["id"] !== "string" || value["id"].length === 0) return false;
  if (!isRequestMethod(value["method"])) return false;
  if (!isRecord(value["params"])) return false;
  if (value["method"] === "host/task" && !isHostTaskParams(value["params"])) return false;
  if (approxBytes(value) > MAX_MESSAGE_BYTES) return false;
  return true;
}

/**
 * Runtime payload validation for task routing: the Host only accepts
 * requests that name both the workspace and the task, plus a known op.
 * The sender binding (workspace/task from main) must match these ids;
 * main enforces that comparison before forwarding.
 */
export function isHostTaskParams(value: unknown): value is HostTaskParams {
  if (!isRecord(value)) return false;
  const workspaceId = value["workspaceId"];
  const taskId = value["taskId"];
  if (typeof workspaceId !== "string" || workspaceId.length === 0) return false;
  if (typeof taskId !== "string" || taskId.length === 0) return false;
  if (!isHostTaskOp(value["op"])) return false;
  const payload = value["payload"];
  if (payload !== undefined && !isRecord(payload)) return false;
  // Fail-closed: an absent origin is fine (unattested route), a present
  // one must be the main-stamped shape — a malformed attestation is
  // rejected rather than ignored.
  if (value["origin"] !== undefined && !isTaskOpOrigin(value["origin"])) return false;
  return true;
}

/** Host -> main browser request ([PiDock 06] #8).
 *
 * The Agent Host runs in a utilityProcess and never holds a WebContents, so
 * a browser action it decides to run is a *request* to main: main owns the
 * visible page, so main validates the page handle, the navigation allowlist
 * and the takeover state before anything touches the page. The Host names
 * its own workspace/task (fixed at fork time); main refuses another one.
 */
export type BrowserPerformResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string };

export type BrowserRequestActor =
  | { kind: "agent"; sessionId: string }
  | { kind: "human"; label: string };

export function isBrowserRequestActor(value: unknown): value is BrowserRequestActor {
  if (!isRecord(value)) return false;
  const kind = value["kind"];
  if (kind === "agent") return typeof value["sessionId"] === "string" && (value["sessionId"] as string).length > 0;
  if (kind === "human") return typeof value["label"] === "string";
  return false;
}

export interface BrowserRequestParams {
  workspaceId: string;
  taskId: string;
  action: string;
  page?: unknown;
  params?: Record<string, unknown>;
  actor: BrowserRequestActor;
}

export interface BrowserRequest {
  kind: "browser-request";
  id: string;
  params: BrowserRequestParams;
}

export interface BrowserResponseOk {
  kind: "browser-response";
  id: string;
  ok: true;
  payload: Record<string, unknown>;
}

export interface BrowserResponseError {
  kind: "browser-response";
  id: string;
  ok: false;
  error: string;
}

export type BrowserResponse = BrowserResponseOk | BrowserResponseError;

/** Fail-closed guard: ids, a task route and an actor shape are required. */
export function isBrowserRequest(value: unknown): value is BrowserRequest {
  if (!isRecord(value)) return false;
  if (value["kind"] !== "browser-request") return false;
  if (typeof value["id"] !== "string" || value["id"].length === 0) return false;
  const params = value["params"];
  if (!isRecord(params)) return false;
  if (typeof params["workspaceId"] !== "string" || params["workspaceId"].length === 0) return false;
  if (typeof params["taskId"] !== "string" || params["taskId"].length === 0) return false;
  if (typeof params["action"] !== "string" || params["action"].length === 0) return false;
  if (params["params"] !== undefined && !isRecord(params["params"])) return false;
  if (!isBrowserRequestActor(params["actor"])) return false;
  return approxBytes(value) <= MAX_MESSAGE_BYTES;
}

export function isBrowserResponse(value: unknown): value is BrowserResponse {
  if (!isRecord(value)) return false;
  if (value["kind"] !== "browser-response") return false;
  if (typeof value["id"] !== "string" || value["id"].length === 0) return false;
  if (value["ok"] === true) return isRecord(value["payload"]);
  if (value["ok"] === false) return typeof value["error"] === "string";
  return false;
}

/** Fail-closed guard for the response direction. */
export function isRpcResponse(value: unknown): value is RpcResponse {
  if (!isRecord(value)) return false;
  if (value["kind"] !== "response") return false;
  if (typeof value["id"] !== "string" || value["id"].length === 0) return false;
  if (approxBytes(value) > MAX_MESSAGE_BYTES) return false;
  if (value["ok"] === true) {
    return isRecord(value["payload"]);
  }
  if (value["ok"] === false) {
    return typeof value["error"] === "string";
  }
  return false;
}

/** Wire envelope for renderer-facing preload responses (same guard shape). */
export type PreloadInvokeResult =
  | { ok: true; payload: unknown }
  | { ok: false; error: string };
