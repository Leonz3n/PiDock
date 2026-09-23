/**
 * Unified execution record for [PiDock 17] (#19).
 *
 * One persistent record per execution (a turn, a Host-driven control action, a
 * compaction, a scheduled run), located by project / task / session:
 *
 * - 执行、步骤、调用尝试、确认请求及其版本 (盒子 1): every record carries its own
 *   `version`, its `steps`, its `attempts` (each with its own usage key) and the
 *   confirmation it waits on (with the payload version it was minted for).
 * - 状态转换 (盒子 2): `ExecutionState` is the session-side state machine
 *   (`executing` / `pending-approval` / `failed` / `done` / `stopped` /
 *   `rejected` / `expired`). Service-side state is a **separate** family
 *   (`ServiceExecutionState`) that is never folded into the session state.
 * - 确认只消费一次且执行前复核权限／期限／版本 (盒子 3): one verifier decides that,
 *   and `consumeExecutionApproval` is the only writer of `consumedAt`.
 * - 失败保留草稿与已完成步骤、未知外部结果先核对、每次尝试单独记用量 (盒子 4).
 * - 关注列表 (盒子 5): pending + completed-unread items with a stable id, and
 *   read-clearing that only ever clears the unread kind.
 * - 重启/重连/迟到批准不重复执行、停止覆盖派生但不回滚已完成 (盒子 6):
 *   `settleExecutionsOnRestore` and `stopExecution`.
 *
 * The module is pure (no fs, no process, no clock): the Host owns persistence
 * and passes the timestamps in, so every rule below is unit-testable and the
 * renderer can mirror it without a Node dependency.
 */

import type { PiApprovalScope, PiPermission } from "./pi-session.js";

/** What opened an execution record. */
export type ExecutionKind = "turn" | "service-control" | "browser-action" | "terminal-control" | "compaction" | "scheduled";

export const EXECUTION_KINDS: readonly ExecutionKind[] = [
  "turn",
  "service-control",
  "browser-action",
  "terminal-control",
  "compaction",
  "scheduled",
];

/** Session-side execution state (盒子 2). */
export type ExecutionState = "executing" | "pending-approval" | "failed" | "done" | "stopped" | "rejected" | "expired";

export const EXECUTION_STATES: readonly ExecutionState[] = [
  "executing",
  "pending-approval",
  "failed",
  "done",
  "stopped",
  "rejected",
  "expired",
];

/**
 * Service-side state family (盒子 2). A service that keeps running is *not* a
 * session that keeps executing: the two families are reported separately and
 * never merged into one state.
 */
export type ServiceExecutionState = "starting" | "running" | "stopping" | "stopped" | "failed" | "unknown";

export const SERVICE_EXECUTION_STATES: readonly ServiceExecutionState[] = [
  "starting",
  "running",
  "stopping",
  "stopped",
  "failed",
  "unknown",
];

export type StepState = "pending" | "done" | "failed" | "skipped";

export interface ExecutionStep {
  stepId: string;
  label: string;
  state: StepState;
  at?: string;
}

/**
 * How one attempt ended. `unknown-external` means the outside effect was never
 * observed (a killed send, a lost response): `replayable` stays false until the
 * result is verified, so nothing auto-replays it.
 */
export type AttemptEndState = "completed" | "failed" | "cancelled" | "awaiting-approval" | "unknown-external";

export interface ExecutionAttempt {
  attemptId: string;
  at: string;
  endState: AttemptEndState;
  /** Usage detail key of this attempt ([PiDock 12] #12); never shared between attempts. */
  usageId?: string;
  /** True only for an attempt whose outside result is known (or verified). */
  replayable: boolean;
  /** Set once a human/Host verified what the outside actually did. */
  verifiedAt?: string;
}

/** The confirmation one execution waits on, with the version it was minted for. */
export interface ExecutionApprovalRef {
  approvalId: string;
  scope?: PiApprovalScope;
  status: "pending" | "approved" | "rejected" | "expired";
  /** Content version the approval was minted for (execution re-checks it). */
  payloadVersion: string;
  requestedAt: string;
  /** Deadline; absent = no deadline was declared. */
  expiresAt?: string;
  /** One-shot spend stamp; a spent approval can never authorize twice. */
  consumedAt?: string;
}

export interface ExecutionRecord {
  executionId: string;
  projectId?: string;
  taskId: string;
  sessionId: string;
  kind: ExecutionKind;
  /** Human label (shown in the attention list and the approval card). */
  label: string;
  state: ExecutionState;
  /** Record version, bumped by every transition (盒子 1「及其版本」). */
  version: number;
  startedAt: string;
  updatedAt: string;
  steps: ExecutionStep[];
  attempts: ExecutionAttempt[];
  approval?: ExecutionApprovalRef;
  /** A failed execution keeps the unsent draft (盒子 4). */
  draftKept: boolean;
  /** Failure reason, when the state is `failed`. */
  failureReason?: string;
  /** Turn call identity when the execution is one call ([PiDock 12] #12). */
  callId?: string;
  /** [PiDock 18] #20: the scheduled task that opened this execution. */
  scheduleId?: string;
  /** [PiDock 18] #20: the schedule config version this run was started with. */
  scheduleConfigVersion?: number;
  /** Derived executions a stop covered (盒子 6); completed steps are untouched. */
  stoppedDerived?: string[];
}

/** What must survive a restart: the executions plus the attention read state. */
export interface ExecutionLedgerRecord {
  version: number;
  executions: ExecutionRecord[];
  /** Ids of attention items the user has read (盒子 5). */
  readItems: { itemId: string; readAt: string }[];
}

export function emptyExecutionLedger(): ExecutionLedgerRecord {
  return { version: 1, executions: [], readItems: [] };
}

/** Every transition bumps the record version and its `updatedAt`. */
function advanced(record: ExecutionRecord, at: string, patch: Partial<ExecutionRecord>): ExecutionRecord {
  return { ...record, ...patch, version: record.version + 1, updatedAt: at };
}

function requireState(record: ExecutionRecord, allowed: readonly ExecutionState[]): void {
  if (!allowed.includes(record.state)) {
    throw new Error(`invalid-execution-transition: 不能从 ${record.state} 转换（当前执行 ${record.executionId}）`);
  }
}

export function openExecution(input: {
  executionId: string;
  taskId: string;
  sessionId: string;
  kind: ExecutionKind;
  label: string;
  at: string;
  projectId?: string;
  callId?: string;
  scheduleId?: string;
  scheduleConfigVersion?: number;
}): ExecutionRecord {
  if (input.executionId.trim().length === 0) throw new Error("invalid-payload: executionId must be non-empty");
  if (input.taskId.trim().length === 0) throw new Error("invalid-payload: taskId must be non-empty");
  if (input.sessionId.trim().length === 0) throw new Error("invalid-payload: sessionId must be non-empty");
  if (!EXECUTION_KINDS.includes(input.kind)) throw new Error(`invalid-payload: kind must be ${EXECUTION_KINDS.join("/")}`);
  return {
    executionId: input.executionId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    kind: input.kind,
    label: input.label,
    state: "executing",
    version: 1,
    startedAt: input.at,
    updatedAt: input.at,
    steps: [],
    attempts: [],
    draftKept: false,
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    ...(input.callId !== undefined ? { callId: input.callId } : {}),
    ...(input.scheduleId !== undefined ? { scheduleId: input.scheduleId } : {}),
    ...(input.scheduleConfigVersion !== undefined ? { scheduleConfigVersion: input.scheduleConfigVersion } : {}),
  };
}

/** Record one planned step as pending (boxes 1/4: the step trail is explicit). */
export function planStep(record: ExecutionRecord, input: { stepId: string; label: string; at: string }): ExecutionRecord {
  requireState(record, ["executing", "pending-approval"]);
  if (record.steps.some((step) => step.stepId === input.stepId)) {
    throw new Error(`invalid-payload: step ${input.stepId} 已存在`);
  }
  return advanced(record, input.at, { steps: [...record.steps, { stepId: input.stepId, label: input.label, state: "pending" }] });
}

/** Settle one step. A later `done` never rewrites an already settled step. */
export function settleStep(
  record: ExecutionRecord,
  input: { stepId: string; state: Exclude<StepState, "pending">; at: string },
): ExecutionRecord {
  const step = record.steps.find((item) => item.stepId === input.stepId);
  if (!step) throw new Error(`unknown-step: ${input.stepId}`);
  if (step.state !== "pending") throw new Error(`invalid-execution-transition: 步骤 ${input.stepId} 已结算（${step.state}）`);
  const steps = record.steps.map((item) =>
    item.stepId === input.stepId ? { ...item, state: input.state, at: input.at } : item,
  );
  return advanced(record, input.at, { steps });
}

/** Append one attempt (盒子 4: every attempt is its own row with its own usage). */
export function recordAttempt(
  record: ExecutionRecord,
  input: { attemptId: string; at: string; endState: AttemptEndState; usageId?: string },
): ExecutionRecord {
  requireState(record, ["executing", "pending-approval"]);
  if (record.attempts.some((attempt) => attempt.attemptId === input.attemptId)) {
    throw new Error(`invalid-payload: attempt ${input.attemptId} 已存在`);
  }
  const attempt: ExecutionAttempt = {
    attemptId: input.attemptId,
    at: input.at,
    endState: input.endState,
    // An unobserved outside result is never replayable until it is verified.
    replayable: input.endState !== "unknown-external",
    ...(input.usageId !== undefined ? { usageId: input.usageId } : {}),
  };
  return advanced(record, input.at, { attempts: [...record.attempts, attempt] });
}

/**
 * Verify what an `unknown-external` attempt actually did, then allow a replay
 * decision (盒子 4「未知外部结果先核对，不自动重放发送」). A verified-success result
 * is replayable; a verified-failure result is not (the caller must re-plan).
 */
export function verifyExternalResult(
  record: ExecutionRecord,
  input: { attemptId: string; resolved: "completed" | "failed"; at: string },
): ExecutionRecord {
  const attempt = record.attempts.find((item) => item.attemptId === input.attemptId);
  if (!attempt) throw new Error(`unknown-attempt: ${input.attemptId}`);
  if (attempt.endState !== "unknown-external" || attempt.verifiedAt !== undefined) {
    throw new Error(`invalid-execution-transition: 尝试 ${input.attemptId} 不需要核对`);
  }
  const attempts = record.attempts.map((item) =>
    item.attemptId === input.attemptId
      ? {
          ...item,
          endState: input.resolved,
          replayable: input.resolved === "completed",
          verifiedAt: input.at,
        }
      : item,
  );
  return advanced(record, input.at, { attempts });
}

/**
 * Replay guard: only an attempt whose outside result is known and verified can
 * be re-sent. An `unknown-external` attempt must be verified first, and a
 * verified failure is never auto-replayed.
 */
export function assertAttemptReplayable(record: ExecutionRecord, attemptId: string): void {
  const attempt = record.attempts.find((item) => item.attemptId === attemptId);
  if (!attempt) throw new Error(`unknown-attempt: ${attemptId}`);
  if (attempt.endState === "unknown-external") {
    throw new Error(`external-result-unverified: 尝试 ${attemptId} 的外部结果未知，先核对再决定是否重放`);
  }
  if (!attempt.replayable) throw new Error(`attempt-not-replayable: 尝试 ${attemptId} 已确认失败，不自动重放`);
}

/** Enter the approval wait and bind the confirmation to the record (盒子 1/3). */
export function awaitApproval(
  record: ExecutionRecord,
  input: { approval: ExecutionApprovalRef; at: string },
): ExecutionRecord {
  requireState(record, ["executing", "pending-approval"]);
  return advanced(record, input.at, { state: "pending-approval", approval: { ...input.approval } });
}

/**
 * Deadline the Host mints for a confirmation, in ms from its request. The task
 * page documents the same 24h window (「等待起点后 24 小时」), so the Host-side
 * expiry rule and the label the user reads are one value, not two.
 */
export const APPROVAL_DEADLINE_MS = 24 * 60 * 60 * 1000;

export function approvalDeadline(at: string): string {
  return new Date(Date.parse(at) + APPROVAL_DEADLINE_MS).toISOString();
}

/** True when a declared deadline has already passed at `now`. */
export function approvalDeadlinePassed(approval: { expiresAt?: string }, now: string): boolean {
  if (approval.expiresAt === undefined) return false;
  const deadline = Date.parse(approval.expiresAt);
  const instant = Date.parse(now);
  return Number.isFinite(deadline) && Number.isFinite(instant) && deadline <= instant;
}

export type ApprovalCheckCode =
  | "not-approved"
  | "already-consumed"
  | "expired"
  | "permission-changed"
  | "version-mismatch"
  | "scope-mismatch";

export interface ApprovalCheckInput {
  approval: ExecutionApprovalRef;
  /** Live permission tier of the session at execution time (never a caller claim). */
  permission: PiPermission;
  /** Content version the caller is about to execute. */
  contentVersion: string;
  /** Scope this action accepts; a mismatched scope authorizes nothing. */
  requiredScope?: PiApprovalScope;
  now: string;
}

/**
 * Re-check one approval immediately before executing it (盒子 3): still
 * approved, never consumed, not past its deadline, the live tier still permits
 * the action, the payload version still matches, and the mint purpose still
 * matches the action. Fail-closed: any doubt refuses.
 */
export function verifyExecutionApproval(input: ApprovalCheckInput): { ok: true } | { ok: false; code: ApprovalCheckCode; reason: string } {
  const { approval } = input;
  // Spend check first: an authorization a restart already spent (or an action
  // already ran) is refused as consumed even when its status also moved on.
  if (approval.consumedAt !== undefined) {
    return { ok: false, code: "already-consumed", reason: "确认请求已被消费，请重新确认" };
  }
  if (approval.status !== "approved") {
    return { ok: false, code: "not-approved", reason: `确认请求状态为 ${approval.status}，不能执行` };
  }
  if (approvalDeadlinePassed(approval, input.now)) {
    return { ok: false, code: "expired", reason: `确认请求已于 ${approval.expiresAt} 过期` };
  }
  if (input.permission === "read") {
    return { ok: false, code: "permission-changed", reason: "会话已降为只读，不能执行已批准的写操作" };
  }
  if (approval.payloadVersion !== input.contentVersion) {
    return {
      ok: false,
      code: "version-mismatch",
      reason: `载荷版本已变化（确认于 ${approval.payloadVersion}，当前 ${input.contentVersion}），请重新确认`,
    };
  }
  if (input.requiredScope !== undefined && approval.scope !== input.requiredScope) {
    return { ok: false, code: "scope-mismatch", reason: "确认请求的用途与本次操作不一致" };
  }
  return { ok: true };
}

/**
 * The only writer of `consumedAt`. Runs the pre-execution re-check first, so an
 * approval can never authorize a second action, an expired one, a downgraded
 * session or a changed payload. A late approval after a restart arrives with
 * `consumedAt` already stamped by `settleApprovalsOnRestore`, so it refuses.
 */
export function consumeExecutionApproval(
  record: ExecutionRecord,
  input: ApprovalCheckInput & { approvalId: string },
): ExecutionRecord {
  const approval = record.approval;
  if (!approval || approval.approvalId !== input.approvalId) {
    throw new Error(`unknown-approval: ${input.approvalId}`);
  }
  const check = verifyExecutionApproval({ ...input, approval });
  if (!check.ok) throw new Error(`${check.code}: ${check.reason}`);
  return advanced(record, input.now, {
    state: "executing",
    approval: { ...approval, status: "approved", consumedAt: input.now },
  });
}

/** Rejection: nothing executes (盒子 2). */
export function rejectExecution(record: ExecutionRecord, input: { approvalId: string; at: string }): ExecutionRecord {
  requireState(record, ["pending-approval", "executing"]);
  if (!record.approval || record.approval.approvalId !== input.approvalId) {
    throw new Error(`unknown-approval: ${input.approvalId}`);
  }
  return advanced(record, input.at, {
    state: "rejected",
    approval: { ...record.approval, status: "rejected" },
    steps: record.steps.map((step) => (step.state === "pending" ? { ...step, state: "skipped", at: input.at } : step)),
  });
}

/** Deadline reached without a decision (盒子 2). */
export function expireExecution(record: ExecutionRecord, input: { at: string }): ExecutionRecord {
  requireState(record, ["pending-approval", "executing"]);
  return advanced(record, input.at, {
    state: "expired",
    ...(record.approval !== undefined
      ? { approval: { ...record.approval, status: "expired" as const, ...(record.approval.consumedAt !== undefined ? { consumedAt: record.approval.consumedAt } : {}) } }
      : {}),
    steps: record.steps.map((step) => (step.state === "pending" ? { ...step, state: "skipped", at: input.at } : step)),
  });
}

/**
 * Failure keeps the draft and every completed step (盒子 4): pending steps are
 * skipped, settled steps and recorded attempts are left exactly as they were.
 */
export function failExecution(record: ExecutionRecord, input: { at: string; reason?: string }): ExecutionRecord {
  requireState(record, ["executing", "pending-approval"]);
  return advanced(record, input.at, {
    state: "failed",
    draftKept: true,
    ...(input.reason !== undefined ? { failureReason: input.reason } : {}),
    steps: record.steps.map((step) => (step.state === "pending" ? { ...step, state: "skipped", at: input.at } : step)),
  });
}

export function completeExecution(record: ExecutionRecord, input: { at: string }): ExecutionRecord {
  requireState(record, ["executing", "pending-approval"]);
  return advanced(record, input.at, {
    state: "done",
    steps: record.steps.map((step) => (step.state === "pending" ? { ...step, state: "skipped", at: input.at } : step)),
  });
}

/**
 * Stop (盒子 6): covers the derived executions it reports but never rolls back a
 * completed step or a recorded attempt. The returned record keeps every `done`
 * step and every attempt verbatim — only still-pending steps are marked
 * skipped, so nothing that already happened is rewritten.
 */
export function stopExecution(
  record: ExecutionRecord,
  input: { at: string; derive?: readonly string[] },
): ExecutionRecord {
  requireState(record, ["executing", "pending-approval"]);
  const derive = [...(input.derive ?? [])];
  return advanced(record, input.at, {
    state: "stopped",
    steps: record.steps.map((step) => (step.state === "pending" ? { ...step, state: "skipped", at: input.at } : step)),
    attempts: record.attempts.map((attempt) => ({ ...attempt })),
    ...(derive.length > 0 ? { stoppedDerived: derive } : {}),
  });
}

/**
 * Restart settlement (盒子 6). A record that was mid-flight when the Host died
 * can never resume by itself: `executing` becomes `stopped` (its outside result
 * is unknown, so its attempts stay non-replayable) and `pending-approval`
 * becomes `expired`. Approved-but-unconsumed confirmations are spent here, so a
 * late approval replayed after a restart authorizes nothing. Read state and
 * completed executions survive unchanged.
 */
export function settleExecutionsOnRestore(
  ledger: ExecutionLedgerRecord,
  input: { at: string },
): { ledger: ExecutionLedgerRecord; stopped: string[]; expired: string[]; spentApprovals: string[] } {
  const stopped: string[] = [];
  const expired: string[] = [];
  const spentApprovals: string[] = [];
  const executions = ledger.executions.map((record) => {
    if (record.state === "executing") {
      stopped.push(record.executionId);
      return {
        ...record,
        state: "stopped" as const,
        version: record.version + 1,
        updatedAt: input.at,
        steps: record.steps.map((step) => (step.state === "pending" ? { ...step, state: "skipped" as const, at: input.at } : step)),
        // The in-flight attempt's outside result is unobserved: it stays
        // non-replayable until someone verifies it.
        attempts: record.attempts.map((attempt) =>
          attempt.endState === "awaiting-approval"
            ? { ...attempt, endState: "unknown-external" as const, replayable: false }
            : { ...attempt },
        ),
      };
    }
    if (record.state === "pending-approval") {
      expired.push(record.executionId);
      const approval = record.approval;
      return {
        ...record,
        state: "expired" as const,
        version: record.version + 1,
        updatedAt: input.at,
        ...(approval !== undefined
          ? {
              approval: {
                ...approval,
                status: "expired" as const,
                // A never-consumed authorization is spent by the restart.
                ...(approval.consumedAt === undefined ? { consumedAt: input.at } : {}),
              },
            }
          : {}),
        steps: record.steps.map((step) => (step.state === "pending" ? { ...step, state: "skipped" as const, at: input.at } : step)),
      };
    }
    if (record.approval !== undefined && record.approval.status === "approved" && record.approval.consumedAt === undefined) {
      // Approved and already executing when the Host died: the authorization
      // must not survive to authorize a second run after the restart.
      spentApprovals.push(record.approval.approvalId);
      return advanced(record, input.at, {
        approval: { ...record.approval, consumedAt: input.at },
      });
    }
    return { ...record, steps: record.steps.map((step) => ({ ...step })), attempts: record.attempts.map((attempt) => ({ ...attempt })) };
  });
  return { ledger: { ...ledger, executions }, stopped, expired, spentApprovals };
}

/** One observation of a service-side run, as the Host reads it. */
export interface ServiceRunObservation {
  serviceId: string;
  running: boolean;
  /** Report the runtime gave about the last exit, when any. */
  lastExit?: { ok: boolean; reason?: string };
  starting?: boolean;
  stopping?: boolean;
  /** The runtime observed the process end (a clean stop, not a failure). */
  stopped?: boolean;
}

/** Service state of one observation (its own family; never the session's). */
export function serviceExecutionStateOf(observation: ServiceRunObservation): ServiceExecutionState {
  if (observation.starting === true) return "starting";
  if (observation.stopping === true) return "stopping";
  if (observation.running) return "running";
  if (observation.lastExit !== undefined) return observation.lastExit.ok ? "stopped" : "failed";
  if (observation.stopped === true) return "stopped";
  return "unknown";
}

/**
 * Split the two state families (盒子 2). A running service never makes a session
 * read as `executing`, and a stopped session never implies its service stopped.
 */
export function splitExecutionStates(input: {
  record?: ExecutionRecord;
  services: readonly ServiceRunObservation[];
}): { session: ExecutionState | null; services: { serviceId: string; state: ServiceExecutionState }[] } {
  return {
    session: input.record?.state ?? null,
    services: input.services
      .map((observation) => ({ serviceId: observation.serviceId, state: serviceExecutionStateOf(observation) }))
      .sort((a, b) => (a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0)),
  };
}

/** 盒子 5: which attention kinds the list shows. */
export type AttentionKind = "approval" | "failed" | "expired" | "completed-unread";

export interface ExecutionAttentionItem {
  id: string;
  kind: AttentionKind;
  executionId: string;
  taskId: string;
  sessionId: string;
  /** Task name the Host knows; the caller labels it with the project name. */
  taskName: string;
  detail: string;
  at: string;
  read: boolean;
}

/**
 * Attention item ids are derived from the execution (plus its approval), so the
 * same item keeps the same id across a refresh, a reconnect and a restart — a
 * read mark therefore survives all three.
 */
export function attentionItemId(record: ExecutionRecord, kind: AttentionKind): string {
  const suffix = kind === "approval" && record.approval !== undefined ? record.approval.approvalId : record.executionId;
  return `attention-${kind}-${record.taskId}-${suffix}`;
}

/** Reading clears unread only: pending/failed/expired items must be handled. */
export function attentionKindClearsOnRead(kind: AttentionKind): boolean {
  return kind === "completed-unread";
}

export function attentionLabel(projectName: string | undefined, taskName: string): string {
  return projectName !== undefined && projectName.length > 0 ? `${projectName} · ${taskName}` : taskName;
}

export function attentionItemsFromLedger(
  ledger: ExecutionLedgerRecord,
  input: { taskId: string; taskName: string },
): ExecutionAttentionItem[] {
  const read = new Set(ledger.readItems.map((entry) => entry.itemId));
  const items: ExecutionAttentionItem[] = [];
  for (const record of ledger.executions) {
    const base = {
      executionId: record.executionId,
      taskId: record.taskId,
      sessionId: record.sessionId,
      taskName: input.taskName,
      at: record.updatedAt,
    };
    if (record.state === "pending-approval" && record.approval?.status === "pending") {
      const id = attentionItemId(record, "approval");
      items.push({
        ...base,
        id,
        kind: "approval",
        detail: `待确认：${record.label}`,
        read: false,
      });
      continue;
    }
    if (record.state === "failed") {
      const id = attentionItemId(record, "failed");
      items.push({
        ...base,
        id,
        kind: "failed",
        detail: `执行失败：${record.failureReason ?? record.label}`,
        read: false,
      });
      continue;
    }
    if (record.state === "expired") {
      const id = attentionItemId(record, "expired");
      items.push({ ...base, id, kind: "expired", detail: `确认已过期：${record.label}`, read: false });
      continue;
    }
    if (record.state === "done") {
      const id = attentionItemId(record, "completed-unread");
      items.push({ ...base, id, kind: "completed-unread", detail: `完成未读：${record.label}`, read: read.has(id) });
    }
  }
  return items.sort(compareAttentionItems);
}

/** Pending kinds first, then newest first, then by id: a stable list order. */
function compareAttentionItems(a: ExecutionAttentionItem, b: ExecutionAttentionItem): number {
  const weight: Record<AttentionKind, number> = { approval: 0, failed: 1, expired: 2, "completed-unread": 3 };
  if (weight[a.kind] !== weight[b.kind]) return weight[a.kind] - weight[b.kind];
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Read the completed items (盒子 5「读取完成清除未读」). Only the unread kind can be
 * cleared by reading; a pending/failed/expired id is returned in `kept` so the
 * caller can tell the user it must be handled instead. Unknown ids are ignored
 * (a stale list must not fail the read).
 */
export function markAttentionRead(
  ledger: ExecutionLedgerRecord,
  input: { itemIds: readonly string[]; at: string },
): { ledger: ExecutionLedgerRecord; cleared: string[]; kept: string[] } {
  const known = new Set(ledger.readItems.map((entry) => entry.itemId));
  const cleared: string[] = [];
  const kept: string[] = [];
  const additions: { itemId: string; readAt: string }[] = [];
  for (const itemId of input.itemIds) {
    if (itemId.startsWith("attention-completed-unread-")) {
      if (known.has(itemId)) continue;
      known.add(itemId);
      additions.push({ itemId, readAt: input.at });
      cleared.push(itemId);
      continue;
    }
    if (itemId.startsWith("attention-")) kept.push(itemId);
  }
  if (additions.length === 0) return { ledger, cleared, kept };
  return { ledger: { ...ledger, readItems: [...ledger.readItems, ...additions] }, cleared, kept };
}

/** 盒子 5: the list shows 待处理 first, then 完成未读. */
export function groupAttentionItems(items: readonly ExecutionAttentionItem[]): {
  pending: ExecutionAttentionItem[];
  unread: ExecutionAttentionItem[];
} {
  const sorted = [...items].sort(compareAttentionItems);
  const unread = sorted.filter((item) => item.kind === "completed-unread" && !item.read);
  return { pending: sorted.filter((item) => item.kind !== "completed-unread"), unread };
}

/** Remove one execution record (cleanup); never renumbers the others. */
export function dropExecution(ledger: ExecutionLedgerRecord, executionId: string): ExecutionLedgerRecord {
  return { ...ledger, executions: ledger.executions.filter((record) => record.executionId !== executionId) };
}

/** Highest `n` in ids shaped `<prefix>-<n>`, so a restart never re-mints an id. */
export function highestExecutionSequence(ledger: ExecutionLedgerRecord, prefix: string): number {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let highest = 0;
  for (const record of ledger.executions) {
    const match = pattern.exec(record.executionId);
    if (match) highest = Math.max(highest, Number.parseInt(match[1] as string, 10));
  }
  return highest;
}

/**
 * Live execution of one scheduled task ([PiDock 18] #20 box 5): a previous trigger
 * that is still executing or waiting on a confirmation must make the next one
 * skip instead of queueing.
 */
export function liveScheduleExecutions(ledger: ExecutionLedgerRecord, scheduleId: string): ExecutionRecord[] {
  return ledger.executions.filter(
    (record) =>
      record.scheduleId === scheduleId && (record.state === "executing" || record.state === "pending-approval"),
  );
}
