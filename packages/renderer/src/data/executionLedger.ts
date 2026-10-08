/**
 * Renderer mirror of the Host execution readout ([PiDock 14] #17 / [PiDock 17] #19
 * `task/executionState`), kept Node-free so the pages can show the persisted
 * executions the Host recorded without a Node dependency.
 *
 * The Host owns the records; this module only parses and maps what it returns.
 * Nothing here estimates progress or mints an execution: an absent or malformed
 * payload yields `null`, and the page keeps its previous source instead of
 * inventing an execution state.
 */

import type { RunRecord, RunState } from "./types";

/** Session-side execution state, mirroring `shell/main/execution-ledger.ts`. */
export type SessionExecutionState =
  | "executing"
  | "pending-approval"
  | "failed"
  | "done"
  | "stopped"
  | "rejected"
  | "expired";

/** Service-side state, a **separate** family: a running service is not a running session. */
export type ServiceExecutionState = "starting" | "running" | "stopping" | "stopped" | "failed" | "unknown";

/** Execution classes the Host records; the three control classes are Host-driven. */
export type ExecutionKind =
  | "turn"
  | "service-control"
  | "browser-action"
  | "terminal-control"
  | "compaction"
  | "scheduled";

export const SESSION_EXECUTION_STATES: readonly SessionExecutionState[] = [
  "executing",
  "pending-approval",
  "failed",
  "done",
  "stopped",
  "rejected",
  "expired",
];

export const EXECUTION_KINDS: readonly ExecutionKind[] = [
  "turn",
  "service-control",
  "browser-action",
  "terminal-control",
  "compaction",
  "scheduled",
];

export type ExecutionStepView = {
  stepId: string;
  label: string;
  state: "pending" | "done" | "failed" | "skipped";
  at?: string;
};

export type ExecutionAttemptView = {
  attemptId: string;
  at: string;
  endState: string;
  usageId?: string;
  replayable: boolean;
  verifiedAt?: string;
};

export type ExecutionApprovalView = {
  approvalId: string;
  status: string;
  payloadVersion: string;
  requestedAt: string;
  scope?: string;
  expiresAt?: string;
  consumedAt?: string;
};

export type ExecutionRecordView = {
  executionId: string;
  kind: ExecutionKind;
  label: string;
  state: SessionExecutionState;
  version: number;
  startedAt: string;
  updatedAt: string;
  steps: ExecutionStepView[];
  attempts: ExecutionAttemptView[];
  approval?: ExecutionApprovalView;
  draftKept: boolean;
  failureReason?: string;
};

/** One `task/executionState` readout: session state, service states, records. */
export type SessionExecutionView = {
  session: SessionExecutionState | null;
  services: { serviceId: string; state: ServiceExecutionState }[];
  executions: ExecutionRecordView[];
};

const STEP_STATES = ["pending", "done", "failed", "skipped"] as const;
const SERVICE_STATES: readonly ServiceExecutionState[] = ["starting", "running", "stopping", "stopped", "failed", "unknown"];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asStep(value: unknown): ExecutionStepView | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const stepId = asNonEmptyString(record["stepId"]);
  const label = asNonEmptyString(record["label"]);
  const state = record["state"];
  if (stepId === undefined || label === undefined || !STEP_STATES.includes(state as never)) return undefined;
  const at = asNonEmptyString(record["at"]);
  return { stepId, label, state: state as ExecutionStepView["state"], ...(at !== undefined ? { at } : {}) };
}

function asAttempt(value: unknown): ExecutionAttemptView | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const attemptId = asNonEmptyString(record["attemptId"]);
  const at = asNonEmptyString(record["at"]);
  const endState = asNonEmptyString(record["endState"]);
  if (attemptId === undefined || at === undefined || endState === undefined) return undefined;
  const usageId = asNonEmptyString(record["usageId"]);
  const verifiedAt = asNonEmptyString(record["verifiedAt"]);
  return {
    attemptId,
    at,
    endState,
    replayable: record["replayable"] === true,
    ...(usageId !== undefined ? { usageId } : {}),
    ...(verifiedAt !== undefined ? { verifiedAt } : {}),
  };
}

function asApproval(value: unknown): ExecutionApprovalView | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const approvalId = asNonEmptyString(record["approvalId"]);
  const status = asNonEmptyString(record["status"]);
  const payloadVersion = asNonEmptyString(record["payloadVersion"]);
  const requestedAt = asNonEmptyString(record["requestedAt"]);
  if (approvalId === undefined || status === undefined || payloadVersion === undefined || requestedAt === undefined) {
    return undefined;
  }
  const scope = asNonEmptyString(record["scope"]);
  const expiresAt = asNonEmptyString(record["expiresAt"]);
  const consumedAt = asNonEmptyString(record["consumedAt"]);
  return {
    approvalId,
    status,
    payloadVersion,
    requestedAt,
    ...(scope !== undefined ? { scope } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(consumedAt !== undefined ? { consumedAt } : {}),
  };
}

/** One persisted execution; an unrecognizable row is dropped, never guessed. */
export function asExecutionRecord(value: unknown): ExecutionRecordView | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const executionId = asNonEmptyString(record["executionId"]);
  const kind = record["kind"];
  const label = asNonEmptyString(record["label"]);
  const state = record["state"];
  const startedAt = asNonEmptyString(record["startedAt"]);
  const updatedAt = asNonEmptyString(record["updatedAt"]);
  if (
    executionId === undefined ||
    !EXECUTION_KINDS.includes(kind as never) ||
    label === undefined ||
    !SESSION_EXECUTION_STATES.includes(state as never) ||
    startedAt === undefined ||
    updatedAt === undefined
  ) {
    return undefined;
  }
  const steps = Array.isArray(record["steps"]) ? record["steps"].map(asStep).filter((step) => step !== undefined) : [];
  const attempts = Array.isArray(record["attempts"])
    ? record["attempts"].map(asAttempt).filter((attempt) => attempt !== undefined)
    : [];
  const approval = asApproval(record["approval"]);
  const failureReason = asNonEmptyString(record["failureReason"]);
  return {
    executionId,
    kind: kind as ExecutionKind,
    label,
    state: state as SessionExecutionState,
    version: typeof record["version"] === "number" ? record["version"] : 0,
    startedAt,
    updatedAt,
    steps,
    attempts,
    draftKept: record["draftKept"] === true,
    ...(approval !== undefined ? { approval } : {}),
    ...(failureReason !== undefined ? { failureReason } : {}),
  };
}

/**
 * Parse one `task/executionState` payload (`{ state: { session, services,
 * executions } }`). A missing or unrecognizable readout returns `null` so the
 * caller keeps its existing source instead of showing an empty ledger as truth.
 */
export function executionStateFromHost(payload: unknown): SessionExecutionView | null {
  const state = asRecord(asRecord(payload)?.["state"]);
  if (!state) return null;
  const session = state["session"];
  if (session !== null && !SESSION_EXECUTION_STATES.includes(session as never)) return null;
  if (!Array.isArray(state["services"]) || !Array.isArray(state["executions"])) return null;
  const services: SessionExecutionView["services"] = [];
  for (const entry of state["services"]) {
    const row = asRecord(entry);
    const serviceId = asNonEmptyString(row?.["serviceId"]);
    const serviceState = row?.["state"];
    if (serviceId === undefined || !SERVICE_STATES.includes(serviceState as never)) return null;
    services.push({ serviceId, state: serviceState as ServiceExecutionState });
  }
  const executions: ExecutionRecordView[] = [];
  for (const entry of state["executions"]) {
    const record = asExecutionRecord(entry);
    if (record === undefined) return null;
    executions.push(record);
  }
  return { session: session as SessionExecutionState | null, services, executions };
}

/** Session-side execution state as the card's `RunState` (the two vocabularies differ). */
export function runStateOfExecution(state: SessionExecutionState | null | undefined): RunState | undefined {
  if (state === null || state === undefined) return undefined;
  return {
    executing: "running",
    "pending-approval": "approval",
    failed: "failed",
    done: "completed",
    stopped: "stopped",
    rejected: "rejected",
    expired: "expired",
  }[state] as RunState;
}

/**
 * The newest persisted execution as the card's `RunRecord` (盒子 1「按会话定位」).
 * The Host returns newest first, so this is the execution the card speaks about;
 * steps keep their recorded state so a reopened task shows the real trail
 * instead of an estimate.
 */
export function runRecordFromExecutionState(
  taskId: string,
  sessionId: string,
  view: SessionExecutionView | null | undefined,
): RunRecord | undefined {
  const latest = view?.executions[0];
  if (!latest) return undefined;
  return {
    id: `ledger-${latest.executionId}`,
    taskId,
    sessionId,
    state: runStateOfExecution(latest.state) ?? "idle",
    startedAt: latest.startedAt,
    summary: latest.failureReason ?? latest.label,
    steps: latest.steps.map((step) => ({ label: step.label, state: step.state })),
  };
}
