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

import { boundWorkspaceId, routeHostTask, validateHostTaskOp } from "./host-guards.js";
import { TaskWorkspaceHost, diskTaskStore } from "./task-host.js";
import {
  isHostTaskParams,
  isRpcRequest,
  type HostPingResult,
  type HostTaskResult,
  type HostVersionsResult,
  type RpcResponse,
} from "../rpc/protocol.js";

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
  return boundWorkspaceId();
}

function reply(response: RpcResponse): void {
  hostPort.postMessage(response);
}

// Single-task Host binding: one utilityProcess serves one task folder.
// `PIDOCK_TASK_ID` selects the task, `PIDOCK_TASK_DIR` its folder; both
// are fixed at fork time so an op naming another task can never continue with it.
// Lazily created on first dispatch so `host/ping` smoke paths that never
// touch tasks do not require the task env.
let workspaceHost: TaskWorkspaceHost | null = null;

function taskHostFor(taskId: string): TaskWorkspaceHost | { error: string } {
  const boundTaskId = process.env["PIDOCK_TASK_ID"];
  const taskDir = process.env["PIDOCK_TASK_DIR"];
  // Pure, unit-tested form of this rule is `routeTaskBinding` in
  // `host-guards.ts` (this file needs a utilityProcess parent port).
  if (typeof boundTaskId !== "string" || boundTaskId.length === 0) {
    return { error: "task-unbound: Host has no PIDOCK_TASK_ID/PIDOCK_TASK_DIR binding" };
  }
  if (typeof taskDir !== "string" || taskDir.length === 0) {
    return { error: "task-unbound: Host has no PIDOCK_TASK_ID/PIDOCK_TASK_DIR binding" };
  }
  if (taskId !== boundTaskId) {
    return { error: "task-unknown: this Host serves a different task" };
  }
  if (!workspaceHost || workspaceHost.taskId !== boundTaskId || workspaceHost.taskDir !== taskDir) {
    workspaceHost = new TaskWorkspaceHost(boundTaskId, taskDir, diskTaskStore);
  }
  return workspaceHost;
}

function asRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

/**
 * `repos` is fail-closed: present-but-not-a-string-array (e.g. `[123]`)
 * is an invalid payload, not silently coerced to `[]`.
 */
function asStrictStringArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (typeof item !== "string") return null;
  }
  return value as string[];
}

/**
 * `mainCheckouts` is fail-closed: when present it must be a plain object
 * mapping repo names to path strings; anything else (arrays, strings,
 * nested objects) is rejected before it can enter an executable plan.
 */
function isMainCheckouts(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (typeof entry !== "string") return false;
  }
  return true;
}

function dispatchTaskOp(
  taskId: string,
  op: string,
  payload: unknown,
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  const host = taskHostFor(taskId);
  if ("error" in host) return { ok: false, error: host.error };
  const record = asRecord(payload);
  try {
    switch (op) {
      case "task/provision": {
        const name = record["name"];
        const dirId = record["dirId"];
        const remoteBranch = record["remoteBranch"];
        const fetchedCommit = record["fetchedCommit"];
        if (
          typeof name !== "string" ||
          typeof dirId !== "string" ||
          typeof remoteBranch !== "string" ||
          typeof fetchedCommit !== "string"
        ) {
          return { ok: false, error: "invalid-payload: task/provision requires name/dirId/remoteBranch/fetchedCommit" };
        }
        const branch = typeof record["branch"] === "string" ? (record["branch"] as string) : undefined;
        const rootOverride = typeof record["rootOverride"] === "string" ? (record["rootOverride"] as string) : undefined;
        const repos = asStrictStringArray(record["repos"]);
        if (repos === null) {
          return { ok: false, error: "invalid-payload: task/provision.repos must be a string array" };
        }
        const mainCheckouts = record["mainCheckouts"];
        const checkouts =
          mainCheckouts === undefined
            ? undefined
            : isMainCheckouts(mainCheckouts)
              ? (mainCheckouts as Record<string, string>)
              : null;
        if (checkouts === null) {
          return { ok: false, error: "invalid-payload: task/provision.mainCheckouts must map repo names to path strings" };
        }
        // `host.provision` returns the persisted record AND the executable
        // plan (real cwds; empty only in the sense of zero ops). Both ride
        // the `host/task` result payload so a caller can persist-then-execute
        // without re-deriving git ops from the record.
        const { record: saved, plan } = host.provision({
          name,
          dirId,
          branch,
          rootOverride,
          remoteBranch,
          fetchedCommit,
          repos,
          mainCheckouts: checkouts,
        });
        return { ok: true, payload: { ...saved, plan } };
      }
      case "task/sendMessage": {
        const sessionId = record["sessionId"];
        const text = record["text"];
        if (typeof sessionId !== "string" || typeof text !== "string") {
          return { ok: false, error: "invalid-payload: task/sendMessage requires sessionId/text" };
        }
        const result = host.sendMessage(sessionId, text);
        return { ok: true, payload: { ...result } };
      }
      case "task/cancel": {
        const sessionId = record["sessionId"];
        if (typeof sessionId !== "string") {
          return { ok: false, error: "invalid-payload: task/cancel requires sessionId" };
        }
        host.cancel(sessionId);
        return { ok: true, payload: { sessionId } };
      }
      case "task/approve": {
        const sessionId = record["sessionId"];
        const approvalId = record["approvalId"];
        if (typeof sessionId !== "string" || typeof approvalId !== "string") {
          return { ok: false, error: "invalid-payload: task/approve requires sessionId/approvalId" };
        }
        const callId = host.approve(sessionId, approvalId);
        return { ok: true, payload: { sessionId, approvalId, callId } };
      }
      case "task/reject": {
        const sessionId = record["sessionId"];
        const approvalId = record["approvalId"];
        if (typeof sessionId !== "string" || typeof approvalId !== "string") {
          return { ok: false, error: "invalid-payload: task/reject requires sessionId/approvalId" };
        }
        host.reject(sessionId, approvalId);
        return { ok: true, payload: { sessionId, approvalId } };
      }
      default:
        return { ok: false, error: `unknown-op: ${op}` };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
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
    // `routeHostTask` is the pure, unit-tested form of this rule.
    const taskParams: unknown = message.params;
    const bound = boundWorkspaceId();
    const route = routeHostTask(taskParams, bound);
    if (route === "task-workspace-mismatch") {
      reply({ kind: "response", id: message.id, ok: false, error: "task-workspace-mismatch" });
      return;
    }
    if (route === "invalid-params" || !isHostTaskParams(taskParams)) {
      reply({ kind: "response", id: message.id, ok: false, error: "invalid-params" });
      return;
    }
    const perOp = validateHostTaskOp(taskParams.op, taskParams.payload);
    if (!perOp.ok) {
      reply({ kind: "response", id: message.id, ok: false, error: perOp.error });
      return;
    }
    const result = dispatchTaskOp(taskParams.taskId, taskParams.op, taskParams.payload ?? {});
    if (!result.ok) {
      reply({ kind: "response", id: message.id, ok: false, error: result.error });
      return;
    }
    const payload: HostTaskResult = {
      workspaceId: bound,
      taskId: taskParams.taskId,
      op: taskParams.op,
      payload: { ...result.payload, hostTime: Date.now() },
    };
    reply({ kind: "response", id: message.id, ok: true, payload });
    return;
  }
  reply({ kind: "response", id: message.id, ok: false, error: "unknown-method" });
});

// Let the parent know the host is alive (bounded, single line).
process.stdout.write(`[host] ready node=${process.versions["node"] ?? "unknown"}\n`);
