/**
 * Typed RPC protocol for main <-> utilityProcess (Node Host stub).
 *
 * S1 scope: only the `host/*` namespace exists. No CDP, no arbitrary IPC,
 * no shell/exec surface. New methods must be added to REQUEST_METHODS and
 * given an explicit Params/Result pair below.
 */

/** Whitelisted request methods (fail-closed: unknown methods are rejected). */
export const REQUEST_METHODS = ["host/ping", "host/getVersions"] as const;

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

export type RequestParams = HostPingParams | HostGetVersionsParams;

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
  payload: HostPingResult | HostVersionsResult;
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

/** Fail-closed guard: only whitelisted methods with a params object pass. */
export function isRpcRequest(value: unknown): value is RpcRequest {
  if (!isRecord(value)) return false;
  if (value["kind"] !== "request") return false;
  if (typeof value["id"] !== "string" || value["id"].length === 0) return false;
  if (!isRequestMethod(value["method"])) return false;
  if (!isRecord(value["params"])) return false;
  if (approxBytes(value) > MAX_MESSAGE_BYTES) return false;
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
