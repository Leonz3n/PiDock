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
  | "task/sendMessage"
  | "task/cancel"
  | "task/approve"
  | "task/reject";

export interface HostTaskParams {
  workspaceId: string;
  taskId: string;
  op: HostTaskOp;
  /** Opaque per-op payload; validated per op by the Host. */
  payload?: Record<string, unknown>;
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
  "task/sendMessage",
  "task/cancel",
  "task/approve",
  "task/reject",
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
  return true;
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
