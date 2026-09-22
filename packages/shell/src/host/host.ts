/**
 * utilityProcess entry: Node Host stub (S1).
 *
 * Runs in a per-task-workspace utilityProcess as plain Node (no Chromium,
 * no renderer, no CDP). Speaks the typed `host/*` RPC protocol over the
 * parent port and nothing else. Real Pi AgentSession wiring is S5+;
 * this stub proves the process boundary and the round-trip.
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
  isRpcRequest,
  type HostPingResult,
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
  reply({ kind: "response", id: message.id, ok: false, error: "unknown-method" });
});

// Let the parent know the host is alive (bounded, single line).
process.stdout.write(`[host] ready node=${process.versions["node"] ?? "unknown"}\n`);
