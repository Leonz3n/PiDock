/**
 * utilityProcess entry: per-task-workspace Node Host ([PiDock 02] #5).
 *
 * Runs as plain Node (no Chromium, no renderer, no CDP). Speaks the typed
 * `host/*` RPC protocol over the parent port and nothing else. `host/ping`
 * and `host/getVersions` prove the process boundary; `host/task` routes
 * task-scoped ops (provision/sendMessage/cancel/approve/reject) with the
 * same runtime payload validation main enforces. The Host never trusts a
 * renderer-chosen workspace: the routed ids must equal the Host's own
 * workspace binding.
 */

// Runs only inside utilityProcess: `process.parentPort` exists there and
// nowhere else (plain node has no such property). It is NOT exported from
// the `electron` module — it hangs off the Node `process` object.
interface UtilityParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
}

function getParentPort(): UtilityParentPort {
  const candidate = (process as unknown as Record<string, unknown>)["parentPort"];
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof (candidate as UtilityParentPort).postMessage !== "function" ||
    typeof (candidate as UtilityParentPort).on !== "function"
  ) {
    throw new Error("[host] no parent port: must run inside utilityProcess");
  }
  return candidate as UtilityParentPort;
}

const hostPort = getParentPort();
import {
  isHostTaskParams,
  isRpcRequest,
  type HostPingResult,
  type HostTaskResult,
  type HostVersionsResult,
  type RpcResponse,
} from "../rpc/protocol.js";

const DEFAULT_WORKSPACE_ID = "s1-default-workspace";

function workspaceOf(params: unknown): string {
  if (
    typeof params === "object" &&
    params !== null &&
    "workspaceId" in params &&
    typeof (params as { workspaceId?: unknown }).workspaceId === "string" &&
    ((params as { workspaceId: string }).workspaceId.length ?? 0) > 0
  ) {
    return (params as { workspaceId: string }).workspaceId;
  }
  return process.env["PIDOCK_WORKSPACE_ID"] ?? DEFAULT_WORKSPACE_ID;
}

function reply(response: RpcResponse): void {
  hostPort.postMessage(response);
}

hostPort.on("message", (event: { data: unknown }) => {
  const message: unknown = event.data;
  if (!isRpcRequest(message)) {
    reply({ kind: "response", id: "unknown", ok: false, error: "invalid-request" });
    return;
  }
  const workspaceId = workspaceOf(message.params);
  if (message.method === "host/ping") {
    const payload: HostPingResult = { pong: true, workspaceId, hostTime: Date.now() };
    reply({ kind: "response", id: message.id, ok: true, payload });
    return;
  }
  if (message.method === "host/getVersions") {
    const payload: HostVersionsResult = {
      node: process.versions["node"] ?? "unknown",
      v8: process.versions["v8"] ?? "unknown",
      workspaceId,
    };
    reply({ kind: "response", id: message.id, ok: true, payload });
    return;
  }
  if (message.method === "host/task") {
    // The Host is bound to one workspace (env at fork time). A routed call
    // naming any other workspace is rejected even though the envelope
    // itself is well-formed — main already compared sender vs payload.
    const taskParams: unknown = message.params;
    if (!isHostTaskParams(taskParams) || taskParams.workspaceId !== workspaceId) {
      reply({ kind: "response", id: message.id, ok: false, error: "task-workspace-mismatch" });
      return;
    }
    const payload: HostTaskResult = {
      workspaceId,
      taskId: taskParams.taskId,
      op: taskParams.op,
      payload: { ...(taskParams.payload ?? {}), hostTime: Date.now() },
    };
    reply({ kind: "response", id: message.id, ok: true, payload });
    return;
  }
  reply({ kind: "response", id: message.id, ok: false, error: "unknown-method" });
});

// Let the parent know the host is alive (bounded, single line).
process.stdout.write(`[host] ready node=${process.versions["node"] ?? "unknown"}\n`);
