import { isAbsolute, normalize } from "node:path";
import { MAX_TERMINAL_LINE, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS } from "../main/terminal-config.js";
import type { TerminalIdentity, TerminalLaunch } from "./terminal-execution.js";

export const MAX_PTY_OUTPUT_BYTES = 4096;
export const MAX_PTY_ENVELOPE_BYTES = 65_536;
export interface PtyEnvelope { workspaceId: string; identity: TerminalIdentity; operationId: string }
export type PtyRequest = PtyEnvelope & { requestId: number } & (
  | { action: "spawn"; launch: TerminalLaunch }
  | { action: "input"; data: string }
  | { action: "resize"; cols: number; rows: number }
);
export type PtyPhase = "preflight" | "library-load" | "native-spawn";
export type PtyReason = "preflight-unavailable" | "library-load-unconfirmed" | "native-spawn-unconfirmed" | "protocol-unconfirmed" | "output-limit";
export type PtyEvent = PtyEnvelope & (
  | { kind: "phase"; phase: PtyPhase }
  | { kind: "reply"; requestId: number; status: "started" | "accepted" | "not-started" | "unknown"; rootPid?: number; reason?: PtyReason }
  | { kind: "output"; sequence: number; data: string }
  | { kind: "exit"; exitCode: number; signal: number }
);
export function operationKey(identity: TerminalIdentity): string {
  return JSON.stringify([identity.taskId, identity.sessionId, identity.instanceId, identity.generation]);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid-pty-message");
  return value as Record<string, unknown>;
}
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 160 && !value.includes("\0"); }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
export function validDimensions(cols: unknown, rows: unknown): boolean {
  return Number.isInteger(cols) && (cols as number) >= MIN_TERMINAL_COLS && (cols as number) <= MAX_TERMINAL_COLS &&
    Number.isInteger(rows) && (rows as number) >= MIN_TERMINAL_ROWS && (rows as number) <= MAX_TERMINAL_ROWS;
}
function envelope(value: unknown): Record<string, unknown> {
  const row = record(value), identity = record(row.identity);
  if (!text(row.workspaceId) || typeof row.operationId !== "string" || !/^[a-f0-9-]{36}$/.test(row.operationId) ||
      !text(identity.taskId) || !text(identity.sessionId) || !text(identity.instanceId) || !positive(identity.generation) ||
      Object.keys(identity).sort().join(",") !== "generation,instanceId,sessionId,taskId" ||
      Buffer.byteLength(JSON.stringify(row)) > MAX_PTY_ENVELOPE_BYTES) throw Error("invalid-pty-message");
  return row;
}
export function sameEnvelope(left: PtyEnvelope, right: PtyEnvelope): boolean {
  return left.workspaceId === right.workspaceId && left.operationId === right.operationId && operationKey(left.identity) === operationKey(right.identity);
}
export function parsePtyRequest(value: unknown): PtyRequest {
  const row = envelope(value);
  if (!positive(row.requestId)) throw Error("invalid-pty-request");
  const keys = ["workspaceId", "identity", "operationId", "requestId", "action"];
  if (row.action === "spawn") {
    keys.push("launch");
    const launch = record(row.launch), env = record(launch.env);
    if (typeof launch.program !== "string" || !isAbsolute(launch.program) || launch.program.includes("\0") ||
        !Array.isArray(launch.args) || !launch.args.every((arg) => typeof arg === "string" && !arg.includes("\0")) ||
        Buffer.byteLength(JSON.stringify([launch.program, launch.args])) > MAX_TERMINAL_LINE ||
        typeof launch.cwd !== "string" || !isAbsolute(launch.cwd) || normalize(launch.cwd) !== launch.cwd || launch.cwd.includes("\0") ||
        !text(launch.envRevision) || !validDimensions(launch.cols, launch.rows) ||
        Object.entries(env).some(([key, value]) => !key || key.includes("=") || key.includes("\0") || typeof value !== "string" || value.includes("\0")) ||
        Object.keys(launch).sort().join(",") !== "args,cols,cwd,env,envRevision,program,rows") throw Error("invalid-pty-launch");
  } else if (row.action === "input") {
    keys.push("data");
    if (typeof row.data !== "string" || !row.data || Buffer.byteLength(row.data) > MAX_TERMINAL_LINE) throw Error("invalid-pty-input");
  } else if (row.action === "resize") {
    keys.push("cols", "rows");
    if (!validDimensions(row.cols, row.rows)) throw Error("invalid-pty-resize");
  } else throw Error("invalid-pty-action");
  if (Object.keys(row).sort().join(",") !== keys.sort().join(",")) throw Error("invalid-pty-request");
  return row as unknown as PtyRequest;
}
export function parsePtyEvent(value: unknown): PtyEvent {
  const row = envelope(value), keys = ["workspaceId", "identity", "operationId", "kind"];
  if (row.kind === "reply") {
    keys.push("requestId", "status");
    if (!positive(row.requestId) || !["started", "accepted", "not-started", "unknown"].includes(String(row.status))) throw Error("invalid-pty-reply");
    if (row.rootPid !== undefined) { keys.push("rootPid"); if (!positive(row.rootPid)) throw Error("invalid-pty-pid"); }
    if (row.reason !== undefined) {
      keys.push("reason");
      if (!["preflight-unavailable", "library-load-unconfirmed", "native-spawn-unconfirmed", "protocol-unconfirmed", "output-limit"].includes(String(row.reason))) throw Error("invalid-pty-reason");
    }
  } else if (row.kind === "phase") {
    keys.push("phase");
    if (!["preflight", "library-load", "native-spawn"].includes(String(row.phase))) throw Error("invalid-pty-phase");
  } else if (row.kind === "output") {
    keys.push("sequence", "data");
    if (!positive(row.sequence) || typeof row.data !== "string" || !row.data || Buffer.byteLength(row.data) > MAX_PTY_OUTPUT_BYTES) throw Error("invalid-pty-output");
  } else if (row.kind === "exit") {
    keys.push("exitCode", "signal");
    if (!Number.isInteger(row.exitCode) || !Number.isInteger(row.signal) || (row.signal as number) < 0) throw Error("invalid-pty-exit");
  } else throw Error("invalid-pty-event");
  if (Object.keys(row).sort().join(",") !== keys.sort().join(",")) throw Error("invalid-pty-event");
  return row as unknown as PtyEvent;
}
