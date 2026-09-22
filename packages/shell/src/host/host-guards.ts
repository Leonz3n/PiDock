/**
 * Shared per-op payload guards for `host/task` routing ([PiDock 02] #5).
 *
 * Lives in its own module so both the main sender-side check (`runtime.ts`)
 * and the utilityProcess Host (`host.ts`) validate the same rules without
 * importing an Electron entry point into unit tests. `host.ts` re-exports
 * `validateHostTaskOp` for backward-compatible imports.
 */
import { isHostTaskOp } from "../rpc/protocol.js";
import { isAbsoluteTaskRoot } from "../main/task-provision.js";

export const DEFAULT_WORKSPACE_ID = "s1-default-workspace";

export type HostTaskRouteResult = "routable" | "task-workspace-mismatch" | "invalid-params";

/**
 * Pure routing rule shared by the Host handler and unit tests: the routed
 * workspace must equal the Host's own binding, and the envelope must name
 * a task, a known op and an object payload. `host.ts` enforces this before
 * dispatching; the string-compare test below exercises this function
 * directly because `host.ts` requires a utilityProcess parent port.
 */
export function routeHostTask(params: unknown, boundWorkspaceId: string): HostTaskRouteResult {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return "invalid-params";
  const record = params as Record<string, unknown>;
  const workspaceId = record["workspaceId"];
  const taskId = record["taskId"];
  const op = record["op"];
  if (typeof workspaceId !== "string" || workspaceId.length === 0) return "invalid-params";
  if (typeof taskId !== "string" || taskId.length === 0) return "invalid-params";
  if (!isHostTaskOp(op)) return "invalid-params";
  const payload = record["payload"];
  if (payload !== undefined && (typeof payload !== "object" || payload === null || Array.isArray(payload))) {
    return "invalid-params";
  }
  if (workspaceId !== boundWorkspaceId) return "task-workspace-mismatch";
  return "routable";
}

export function boundWorkspaceId(): string {
  return process.env["PIDOCK_WORKSPACE_ID"] ?? DEFAULT_WORKSPACE_ID;
}

/** Fork-time task binding: one utilityProcess serves one task folder. */
export interface HostTaskBinding {
  taskId: string;
  taskDir: string;
}

export type TaskBindingRoute = "routable" | "task-unbound" | "task-unknown";

/**
 * Pure form of the per-task binding rule `host.ts` enforces before
 * dispatching: the Host must be bound at fork time (`PIDOCK_TASK_ID` +
 * `PIDOCK_TASK_DIR`), and the op must name the bound task. A routed call
 * naming any other task is rejected even though the envelope itself is
 * well-formed. Tested directly because `host.ts` needs a utilityProcess
 * parent port.
 */
export function routeTaskBinding(
  taskId: unknown,
  boundTaskId: unknown,
  boundTaskDir: unknown,
): TaskBindingRoute {
  if (typeof boundTaskId !== "string" || boundTaskId.length === 0) return "task-unbound";
  if (typeof boundTaskDir !== "string" || boundTaskDir.length === 0) return "task-unbound";
  if (typeof taskId !== "string" || taskId.length === 0) return "task-unknown";
  if (taskId !== boundTaskId) return "task-unknown";
  return "routable";
}

/**
 * Fork-time env for `utilityProcess.fork`: binds the workspace and,
 * when given, the single task folder this Host serves. Partial bindings
 * fail closed here so main never forks a Host that silently serves the
 * wrong task. Pure (base env injected) so unit tests cover it without
 * Electron; `runtime.ts createHost` is the only production caller.
 */
export function buildHostEnv(
  baseEnv: Record<string, string | undefined>,
  workspaceId: string,
  task?: HostTaskBinding,
): Record<string, string> {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("invalid-payload: workspaceId must be a non-empty string");
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === "string") env[key] = value;
  }
  env["PIDOCK_WORKSPACE_ID"] = workspaceId;
  if (task !== undefined) {
    if (typeof task.taskId !== "string" || task.taskId.length === 0) {
      throw new Error("invalid-payload: taskId must be a non-empty string");
    }
    if (typeof task.taskDir !== "string" || !isAbsoluteTaskRoot(task.taskDir)) {
      throw new Error("invalid-payload: taskDir must be an absolute task root");
    }
    env["PIDOCK_TASK_ID"] = task.taskId;
    env["PIDOCK_TASK_DIR"] = task.taskDir;
  }
  return env;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Per-op payload validation (S1 minimal scope). provision/sendMessage reuse
 * the embedded guards; cancel/approve/reject keep an opaque object payload.
 * Unknown ops can never reach here (isHostTaskParams rejects them).
 */
export function validateHostTaskOp(
  op: string,
  payload: unknown,
): { ok: true } | { ok: false; error: string } {
  if (!isHostTaskOp(op)) return { ok: false, error: "unknown-op" };
  if (op === "task/provision") {
    if (!isRecord(payload))
      return {
        ok: false,
        error: "invalid-payload: task/provision requires a payload object",
      };
    // S2 dispatch shape: Host-owned provision fields (name/dirId/baseline).
    // The S1 transport shape (root/dirId) stays accepted for sender-side
    // compatibility until the renderer form migrates to the S2 fields.
    const dirId = payload["dirId"];
    if (typeof dirId !== "string" || !/^task-[0-9a-f]{8}$/.test(dirId)) {
      return {
        ok: false,
        error: "invalid-payload: task/provision.dirId must match task-oooooooo",
      };
    }
    if ("root" in payload) {
      const root = payload["root"];
      if (typeof root !== "string" || root.trim().length === 0) {
        return {
          ok: false,
          error: "invalid-payload: task/provision.root must be a non-empty string",
        };
      }
      return { ok: true };
    }
    for (const key of ["name", "remoteBranch", "fetchedCommit"] as const) {
      const value = payload[key];
      if (typeof value !== "string" || value.trim().length === 0) {
        return {
          ok: false,
          error: `invalid-payload: task/provision.${key} must be a non-empty string`,
        };
      }
    }
    return { ok: true };
  }
  if (op === "task/sendMessage") {
    if (!isRecord(payload))
      return {
        ok: false,
        error: "invalid-payload: task/sendMessage requires a payload object",
      };
    const sessionId = payload["sessionId"];
    const text = payload["text"];
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      return {
        ok: false,
        error:
          "invalid-payload: task/sendMessage.sessionId must be a non-empty string",
      };
    }
    if (typeof text !== "string" || text.trim().length === 0) {
      return {
        ok: false,
        error: "invalid-payload: task/sendMessage.text must be a non-empty string",
      };
    }
    // S6 batch 1 turn options ride the same payload (all optional, all
    // fail-closed): provider/model override for per-turn selection,
    // usage counters + source for the persisted call record. `stream` is
    // a local Host-side callback and never crosses the RPC boundary.
    // S6 batch 2: structured input refs (`references`) + skill source
    // (`skillSource`) ride verbatim for send-record association; the Host
    // persists them but never interprets them.
    for (const key of ["providerId", "model"] as const) {
      const value = payload[key];
      if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
        return { ok: false, error: `invalid-payload: task/sendMessage.${key} must be a non-empty string` };
      }
    }
    const usageSource = payload["usageSource"];
    // Intentional asymmetry with `normalizeCallUsage` (pi-session.ts): the
    // internal `approve()` path mints `usageSource:"approval"` for the
    // executed call, but clients can never mint it — a client-supplied
    // `"approval"` is fail-closed here so usage provenance stays honest.
    if (
      usageSource !== undefined &&
      usageSource !== "actual" &&
      usageSource !== "estimated" &&
      usageSource !== "unreported" &&
      usageSource !== "test-double"
    ) {
      return { ok: false, error: "invalid-payload: task/sendMessage.usageSource must be actual/estimated/unreported/test-double" };
    }
    const usage = payload["usage"];
    if (usage !== undefined) {
      if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
        return { ok: false, error: "invalid-payload: task/sendMessage.usage must be an object" };
      }
      for (const key of ["input", "output", "cacheRead"] as const) {
        const value = (usage as Record<string, unknown>)[key];
        if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
          return { ok: false, error: `invalid-payload: task/sendMessage.usage.${key} must be a non-negative number` };
        }
      }
    }
    const credentialRef = payload["credentialRef"];
    if (credentialRef !== undefined && (typeof credentialRef !== "string" || credentialRef.trim().length === 0)) {
      return { ok: false, error: "invalid-payload: task/sendMessage.credentialRef must be a non-empty reference" };
    }
    const skillSource = payload["skillSource"];
    if (skillSource !== undefined && (typeof skillSource !== "string" || skillSource.trim().length === 0)) {
      return { ok: false, error: "invalid-payload: task/sendMessage.skillSource must be a non-empty string" };
    }
    const references = payload["references"];
    if (references !== undefined && !Array.isArray(references)) {
      return { ok: false, error: "invalid-payload: task/sendMessage.references must be an array" };
    }
    return { ok: true };
  }
  // S6 batch 2 follow-up: draft/permission ops are Host-reachable (P1).
  // `task/saveDraft` stores an unsent composer draft (never auto-sends);
  // `task/clearDraft` drops it; `task/setPermission` mutates future turns
  // only (forward-only, never rewrites the in-flight approval).
  if (op === "task/saveDraft") {
    if (!isRecord(payload))
      return { ok: false, error: "invalid-payload: task/saveDraft requires a payload object" };
    const sessionId = payload["sessionId"];
    const text = payload["text"];
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      return { ok: false, error: "invalid-payload: task/saveDraft.sessionId must be a non-empty string" };
    }
    if (typeof text !== "string") {
      return { ok: false, error: "invalid-payload: task/saveDraft.text must be a string" };
    }
    const references = payload["references"];
    if (references !== undefined && !Array.isArray(references)) {
      return { ok: false, error: "invalid-payload: task/saveDraft.references must be an array" };
    }
    const skillSource = payload["skillSource"];
    if (skillSource !== undefined && (typeof skillSource !== "string" || skillSource.trim().length === 0)) {
      return { ok: false, error: "invalid-payload: task/saveDraft.skillSource must be a non-empty string" };
    }
    return { ok: true };
  }
  if (op === "task/clearDraft") {
    if (!isRecord(payload))
      return { ok: false, error: "invalid-payload: task/clearDraft requires a payload object" };
    const sessionId = payload["sessionId"];
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      return { ok: false, error: "invalid-payload: task/clearDraft.sessionId must be a non-empty string" };
    }
    return { ok: true };
  }
  if (op === "task/setPermission") {
    if (!isRecord(payload))
      return { ok: false, error: "invalid-payload: task/setPermission requires a payload object" };
    const sessionId = payload["sessionId"];
    const permission = payload["permission"];
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      return { ok: false, error: "invalid-payload: task/setPermission.sessionId must be a non-empty string" };
    }
    if (permission !== "read" && permission !== "default" && permission !== "auto") {
      return { ok: false, error: "invalid-payload: task/setPermission.permission must be read/default/auto" };
    }
    return { ok: true };
  }
  if (payload !== undefined && !isRecord(payload)) {
    return { ok: false, error: `invalid-payload: ${op} payload must be an object` };
  }
  return { ok: true };
}
