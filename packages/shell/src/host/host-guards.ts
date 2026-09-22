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
    const root = payload["root"];
    const dirId = payload["dirId"];
    if (typeof root !== "string" || root.trim().length === 0) {
      return {
        ok: false,
        error: "invalid-payload: task/provision.root must be a non-empty string",
      };
    }
    if (typeof dirId !== "string" || !/^task-[0-9a-f]{8}$/.test(dirId)) {
      return {
        ok: false,
        error: "invalid-payload: task/provision.dirId must match task-oooooooo",
      };
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
