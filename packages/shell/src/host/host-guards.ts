/**
 * Shared per-op payload guards for `host/task` routing ([PiDock 02] #5).
 *
 * Lives in its own module so both the main sender-side check (`runtime.ts`)
 * and the utilityProcess Host (`host.ts`) validate the same rules without
 * importing an Electron entry point into unit tests. `host.ts` re-exports
 * `validateHostTaskOp` for backward-compatible imports.
 */
import { isHostTaskOp } from "../rpc/protocol.js";

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
    return { ok: true };
  }
  if (payload !== undefined && !isRecord(payload)) {
    return { ok: false, error: `invalid-payload: ${op} payload must be an object` };
  }
  return { ok: true };
}
