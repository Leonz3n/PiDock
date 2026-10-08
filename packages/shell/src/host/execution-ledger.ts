/**
 * Host-side execution ledger for [PiDock 17] (#19).
 *
 * Wraps the pure rules of `main/execution-ledger.ts` with the two things the
 * Host owes and the rules must not know about:
 *
 * - **persistence**: `<taskDir>/execution.json` (via `TaskStore`), written after
 *   every transition, so a reopen reports the same executions, the same
 *   approvals (already spent) and the same unread state;
 * - **identity**: `exec-<n>` ids re-seeded from the restored ledger, so a
 *   restarted Host never re-mints an id an earlier process already used (which
 *   would collapse two executions into one row and re-open a read mark).
 *
 * The ledger is loaded once per Host instance and settled at that moment
 * (`settleExecutionsOnRestore`): a record that was in flight when the previous
 * process died can never resume by itself, a waiting confirmation expires, and
 * an approved-but-unconsumed confirmation is spent so a late approval after the
 * restart authorizes nothing (盒子 6). One Host instance serves one task folder,
 * which is what makes "load once" the same thing as "restart once".
 */

import {
  approvalDeadline,
  approvalDeadlinePassed,
  attentionItemsFromLedger,
  awaitApproval,
  completeExecution,
  consumeExecutionApproval,
  expireExecution,
  failExecution,
  highestExecutionSequence,
  liveScheduleExecutions,
  markAttentionRead,
  openExecution,
  planStep,
  recordAttempt,
  rejectExecution,
  settleExecutionsOnRestore,
  settleStep,
  splitExecutionStates,
  stopExecution,
  verifyExternalResult,
  type ExecutionApprovalRef,
  type ExecutionAttentionItem,
  type ControlExecutionKind,
  type ExecutionKind,
  type ExecutionLedgerRecord,
  type ExecutionRecord,
  type ExecutionState,
  type ServiceExecutionState,
  type ServiceRunObservation,
  type StepState,
} from "../main/execution-ledger.js";
import type { PiApprovalScope, PiPermission } from "../main/pi-session.js";

/** The persistence slice this recorder needs (satisfied by `TaskStore`). */
export interface ExecutionLedgerStore {
  readExecutions(taskDir: string): ExecutionLedgerRecord;
  writeExecutions(taskDir: string, ledger: ExecutionLedgerRecord): void;
}

export interface ExecutionStateReadout {
  /** Session-side state of the newest execution of the session (never a service's). */
  session: ExecutionState | null;
  /** Service-side states, a separate family (盒子 2). */
  services: { serviceId: string; state: ServiceExecutionState }[];
  /** Newest first. */
  executions: ExecutionRecord[];
}

/**
 * One Host-driven control operation's ledger record (盒子 1). The sequence that
 * owns the gate also owns the record, so the readout says the same thing the
 * gate decided: a minted confirmation leaves the record waiting, a refusal that
 * executed nothing fails it, and only a performed action completes it.
 *
 * The handle is mutable on purpose: a refreshed confirmation (the previous one
 * was rejected/expired and the Agent asks again) re-opens a record, so the
 * settled history row is kept and the live wait lands on a new row.
 */
export interface ControlExecutionHandle {
  /** Bind the confirmation this control now waits on. */
  awaitApproval(input: { approvalId: string; payloadVersion: string; scope: PiApprovalScope }): void;
  /** Settle the record for the outcome the gate returned. */
  settle(result: { ok: true } | { ok: false; reason: string }): void;
}

/**
 * The ledger slice a Host-driven control sequence records into. Injected (never
 * imported) so the sequence stays testable without a Host, and a caller with no
 * ledger simply records nothing.
 */
export interface ControlExecutionPort {
  /**
   * `approvalId` is the confirmation the caller is acting on, when it has one.
   * A retry that spends a confirmation keeps the row that minted it instead of
   * opening a second record for the same operation.
   */
  record(input: {
    sessionId: string;
    kind: ControlExecutionKind;
    label: string;
    step: string;
    approvalId?: unknown;
  }): ControlExecutionHandle;
}

export class TaskExecutionLedger {
  private ledgerState: ExecutionLedgerRecord;
  private sequence: number;
  private sdkPending: ExecutionLedgerRecord | null = null;
  private sdkAdmissionUncertain = false;
  private sdkProjectionUncertain = false;
  private readonly now: () => string;

  constructor(
    private readonly taskId: string,
    private readonly taskDir: string,
    private readonly store: ExecutionLedgerStore,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.now = now;
    this.ledgerState = store.readExecutions(taskDir);
    this.sequence = highestExecutionSequence(this.ledgerState, "exec");
    // Restart settlement, once, at load: nothing resumes silently.
    const settled = settleExecutionsOnRestore(this.ledgerState, { at: this.now() });
    this.ledgerState = settled.ledger;
    if (settled.stopped.length > 0 || settled.expired.length > 0 || settled.spentApprovals.length > 0) this.persist();
  }

  /** SDK JSONL remains authoritative; this is only the execution projection. */
  beginSdkTurn(sessionId: string, turnId: string): void {
    this.assertSdkDispatchReady();
    if (sessionId !== "main" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(turnId)) throw Error("invalid-sdk-turn-identity");
    if (this.ledgerState.executions.some((record) => record.callId === turnId)) throw Error("sdk-turn-already-recorded");
    const at = this.now();
    const record = planStep(openExecution({ executionId: `exec-${this.sequence + 1}`, taskId: this.taskId, sessionId, callId: turnId, kind: "turn", label: "SDK main 回合", at }), { stepId: turnId, label: "SDK 模型请求", at });
    const next = { ...this.ledgerState, executions: [...this.ledgerState.executions, record] };
    try { this.store.writeExecutions(this.taskDir, next); }
    catch {
      // A write may have renamed before failing to sync. This Host cannot
      // reuse its old sequence or dispatch again on an uncertain admission.
      this.sdkAdmissionUncertain = true;
      throw Error("sdk-execution-ledger-uncommitted");
    }
    this.ledgerState = next;
    this.sequence += 1;
  }

  settleSdkTurn(sessionId: string, turnId: string, state: "done" | "failed" | "cancelled"): void {
    this.assertSdkDispatchReady();
    try {
      const current = this.ledgerState.executions.find((record) => record.taskId === this.taskId && record.sessionId === sessionId && record.callId === turnId);
      if (!current || sessionId !== "main") throw Error("invalid-sdk-turn-identity");
      const at = this.now();
      let record = settleStep(current, { stepId: turnId, state: state === "done" ? "done" : state === "cancelled" ? "skipped" : "failed", at });
      record = recordAttempt(record, { attemptId: turnId, endState: state === "done" ? "completed" : state === "cancelled" ? "cancelled" : "failed", at });
      record = state === "done" ? completeExecution(record, { at }) : state === "cancelled" ? stopExecution(record, { at }) : failExecution(record, { at, reason: "sdk-turn-failed" });
      // Freeze the exact terminal projection before trying persistence. A retry
      // writes this version and attempt again, never reissues the model request.
      this.sdkPending = { ...this.ledgerState, executions: this.ledgerState.executions.map((entry) => entry.executionId === record.executionId ? record : entry) };
    } catch {
      // A competing transition or invalid identity cannot be repaired by
      // retrying persistence. Keep SDK history readable, but refuse ledger ACKs.
      this.sdkProjectionUncertain = true;
      throw Error("sdk-execution-ledger-uncommitted");
    }
    this.reconcileSdkProjection();
  }

  /** Also guards every ledger mutation against overwriting uncertain admission. */
  assertSdkDispatchReady(): void {
    if (this.sdkAdmissionUncertain) throw Error("sdk-execution-ledger-uncommitted");
    this.reconcileSdkProjection();
  }

  reconcileSdkProjection(): void {
    if (this.sdkProjectionUncertain) throw Error("sdk-execution-ledger-uncommitted");
    if (!this.sdkPending) return;
    if (this.sdkAdmissionUncertain) throw Error("sdk-execution-ledger-uncommitted");
    try { this.store.writeExecutions(this.taskDir, this.sdkPending); }
    catch { throw Error("sdk-execution-ledger-uncommitted"); }
    this.ledgerState = this.sdkPending;
    this.sdkPending = null;
  }

  /** Copy of the persisted ledger (read-only callers never mutate the live one). */
  get ledger(): ExecutionLedgerRecord {
    return {
      version: this.ledgerState.version,
      executions: this.ledgerState.executions.map((record) => cloneRecord(record)),
      readItems: this.ledgerState.readItems.map((entry) => ({ ...entry })),
    };
  }

  /** Newest first, so a readout shows the latest execution of a session. */
  forSession(sessionId: string): ExecutionRecord[] {
    return this.ledgerState.executions
      .filter((record) => record.sessionId === sessionId)
      .map((record) => cloneRecord(record))
      .sort((a, b) => {
        if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
        // Tied timestamps order by the minted sequence, never by the id string
        // (`exec-10` is newer than `exec-9`, not older).
        return executionSequence(b.executionId) - executionSequence(a.executionId);
      });
  }

  byId(executionId: string): ExecutionRecord | undefined {
    const record = this.ledgerState.executions.find((item) => item.executionId === executionId);
    return record === undefined ? undefined : cloneRecord(record);
  }

  /**
   * The execution of one session-bound confirmation whatever its state (盒子 3/6):
   * a record the ledger already settled still answers, so a late approve can be
   * refused instead of falling through to the session channel.
   */
  byApproval(sessionId: string, approvalId: string): ExecutionRecord | undefined {
    const record = this.ledgerState.executions.find(
      (item) => item.taskId === this.taskId && item.sessionId === sessionId && item.approval?.approvalId === approvalId,
    );
    return record === undefined ? undefined : cloneRecord(record);
  }

  /** The live execution waiting on one session-bound approval. */
  waitingOnApproval(sessionId: string, approvalId: string): ExecutionRecord | undefined {
    const record = this.byApproval(sessionId, approvalId);
    if (record === undefined) return undefined;
    return record.state === "pending-approval" || record.state === "executing" ? record : undefined;
  }

  open(input: {
    sessionId: string;
    kind: ExecutionKind;
    label: string;
    projectId?: string;
    callId?: string;
    scheduleId?: string;
    scheduleConfigVersion?: number;
  }): ExecutionRecord {
    this.assertSdkDispatchReady();
    this.sequence += 1;
    const record = openExecution({
      executionId: `exec-${this.sequence}`,
      taskId: this.taskId,
      sessionId: input.sessionId,
      kind: input.kind,
      label: input.label,
      at: this.now(),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.callId !== undefined ? { callId: input.callId } : {}),
      ...(input.scheduleId !== undefined ? { scheduleId: input.scheduleId } : {}),
      ...(input.scheduleConfigVersion !== undefined ? { scheduleConfigVersion: input.scheduleConfigVersion } : {}),
    });
    this.mutate([...this.ledgerState.executions, record]);
    return cloneRecord(record);
  }

  /**
   * Live execution of one scheduled task ([PiDock 18] #20 box 5): a previous
   * trigger still executing or waiting on a confirmation makes the next one skip.
   */
  liveSchedule(scheduleId: string): boolean {
    return liveScheduleExecutions(this.ledgerState, scheduleId).length > 0;
  }

  /**
   * Bind the call identity minted inside the turn ([PiDock 12] #12): the
   * execution and the usage/call record name the same attempt.
   */
  linkCall(executionId: string, callId: string): ExecutionRecord {
    return this.update(executionId, (record) => ({ ...record, callId, version: record.version + 1, updatedAt: this.now() }));
  }

  planStep(executionId: string, input: { stepId: string; label: string }): ExecutionRecord {
    return this.update(executionId, (record) => planStep(record, { ...input, at: this.now() }));
  }

  settleStep(executionId: string, input: { stepId: string; state: Exclude<StepState, "pending"> }): ExecutionRecord {
    return this.update(executionId, (record) => settleStep(record, { ...input, at: this.now() }));
  }

  attempt(executionId: string, input: { endState: Parameters<typeof recordAttempt>[1]["endState"]; usageId?: string }): ExecutionRecord {
    const at = this.now();
    const attemptId = this.nextAttemptId(executionId);
    return this.update(executionId, (record) =>
      recordAttempt(record, { attemptId, at, endState: input.endState, ...(input.usageId !== undefined ? { usageId: input.usageId } : {}) }),
    );
  }

  verifyExternal(executionId: string, input: { attemptId: string; resolved: "completed" | "failed" }): ExecutionRecord {
    return this.update(executionId, (record) => verifyExternalResult(record, { ...input, at: this.now() }));
  }

  /** Enter the confirmation wait and bind the request (盒子 1/3). */
  awaitApproval(
    executionId: string,
    input: { approvalId: string; payloadVersion: string; scope?: PiApprovalScope; expiresAt?: string },
  ): ExecutionRecord {
    const requestedAt = this.now();
    const approval: ExecutionApprovalRef = {
      approvalId: input.approvalId,
      status: "pending",
      payloadVersion: input.payloadVersion,
      requestedAt,
      // The Host always declares the deadline it will re-check before executing.
      expiresAt: input.expiresAt ?? approvalDeadline(requestedAt),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
    };
    return this.update(executionId, (record) => awaitApproval(record, { approval, at: requestedAt }));
  }

  /**
   * The user approved; re-check permission / deadline / payload version and spend
   * the confirmation exactly once before anything executes (盒子 3). The
   * `contentVersion` is what the caller is about to execute: absent means "the
   * version this approval was minted for" (nothing changed it).
   */
  authorize(
    executionId: string,
    input: { approvalId: string; permission: PiPermission; contentVersion?: string; requiredScope?: PiApprovalScope },
  ): ExecutionRecord {
    return this.update(executionId, (record) => {
      const ref = record.approval;
      if (!ref || ref.approvalId !== input.approvalId) throw new Error(`unknown-approval: ${input.approvalId}`);
      // Recording the user's decision only turns a *pending* request approved. A
      // ref the ledger already settled (expired / rejected) keeps its own status,
      // so the re-check below refuses it as `not-approved` instead of being
      // re-labelled here and slipping past.
      const decided: ExecutionRecord =
        ref.status === "pending" ? { ...record, approval: { ...ref, status: "approved" } } : record;
      return consumeExecutionApproval(decided, {
        approvalId: input.approvalId,
        approval: decided.approval as ExecutionApprovalRef,
        permission: input.permission,
        contentVersion: input.contentVersion ?? ref.payloadVersion,
        ...(input.requiredScope !== undefined ? { requiredScope: input.requiredScope } : {}),
        now: this.now(),
      });
    });
  }

  rejectApproval(sessionId: string, approvalId: string): ExecutionRecord | undefined {
    const waiting = this.waitingOnApproval(sessionId, approvalId);
    if (!waiting) return undefined;
    return this.update(waiting.executionId, (record) => rejectExecution(record, { approvalId, at: this.now() }));
  }

  /** Deadline reached without a decision; returns every execution it expired. */
  expireApprovals(sessionId: string, approvalIds: readonly string[]): ExecutionRecord[] {
    const expired: ExecutionRecord[] = [];
    for (const approvalId of approvalIds) {
      const waiting = this.waitingOnApproval(sessionId, approvalId);
      if (!waiting) continue;
      expired.push(this.update(waiting.executionId, (record) => expireExecution(record, { at: this.now() })));
    }
    return expired;
  }

  /**
   * Expire every waiting confirmation whose declared deadline has passed. The
   * Host has no background timer, so this runs on the read path (a state or
   * attention read) and before an execution — the re-check itself stays
   * fail-closed either way.
   */
  settleDueApprovals(): ExecutionRecord[] {
    const now = this.now();
    const due = this.ledgerState.executions.filter(
      (record) => record.state === "pending-approval" && record.approval?.status === "pending" && approvalDeadlinePassed(record.approval, now),
    );
    return due.map((record) => this.update(record.executionId, (current) => expireExecution(current, { at: now })));
  }

  complete(executionId: string): ExecutionRecord {
    return this.update(executionId, (record) => completeExecution(record, { at: this.now() }));
  }

  fail(executionId: string, reason?: string): ExecutionRecord {
    return this.update(executionId, (record) => failExecution(record, { at: this.now(), ...(reason !== undefined ? { reason } : {}) }));
  }

  /**
   * Stop (盒子 6): every live execution of the session is stopped, the derived
   * executions the caller reports are covered, and completed steps/attempts are
   * kept verbatim.
   */
  stopSession(sessionId: string, input: { derive?: readonly string[] } = {}): ExecutionRecord[] {
    const live = this.ledgerState.executions.filter(
      (record) => record.sessionId === sessionId && (record.state === "executing" || record.state === "pending-approval"),
    );
    return live.map((record) =>
      this.update(record.executionId, (current) => stopExecution(current, { at: this.now(), derive: input.derive ?? [] })),
    );
  }

  /**
   * Session-side state of the newest execution of a session plus the separate
   * service-side states (盒子 2): a running service never reads as a session that
   * is still executing.
   */
  state(sessionId: string, services: readonly ServiceRunObservation[] = []): ExecutionStateReadout {
    this.reconcileSdkProjection();
    this.settleDueApprovals();
    const executions = this.forSession(sessionId);
    const latest = executions[0];
    const split = splitExecutionStates({ services, ...(latest !== undefined ? { record: latest } : {}) });
    return { session: split.session, services: split.services, executions };
  }

  attention(input: { taskName: string }): ExecutionAttentionItem[] {
    this.reconcileSdkProjection();
    this.settleDueApprovals();
    return attentionItemsFromLedger(this.ledgerState, { taskId: this.taskId, taskName: input.taskName });
  }

  /** Read-clearing (盒子 5): only the unread kind clears; others are reported kept. */
  markRead(itemIds: readonly string[]): { cleared: string[]; kept: string[] } {
    this.assertSdkDispatchReady();
    const result = markAttentionRead(this.ledgerState, { itemIds, at: this.now() });
    if (result.cleared.length > 0) {
      this.ledgerState = result.ledger;
      this.persist();
    }
    return { cleared: result.cleared, kept: result.kept };
  }

  private nextAttemptId(executionId: string): string {
    const record = this.ledgerState.executions.find((item) => item.executionId === executionId);
    const count = record?.attempts.length ?? 0;
    return `${executionId}-attempt-${count + 1}`;
  }

  private update(executionId: string, apply: (record: ExecutionRecord) => ExecutionRecord): ExecutionRecord {
    this.assertSdkDispatchReady();
    const index = this.ledgerState.executions.findIndex((item) => item.executionId === executionId);
    if (index === -1) throw new Error(`unknown-execution: ${executionId}`);
    const next = apply(this.ledgerState.executions[index] as ExecutionRecord);
    this.mutate(this.ledgerState.executions.map((item, position) => (position === index ? next : item)));
    return cloneRecord(next);
  }

  private mutate(executions: ExecutionRecord[]): void {
    this.assertSdkDispatchReady();
    this.ledgerState = { ...this.ledgerState, executions };
    this.persist();
  }

  private persist(): void {
    this.store.writeExecutions(this.taskDir, this.ledgerState);
  }
}

/** Minted execution sequence (`exec-<n>`) for tie-breaking; 0 keeps insertion order. */
function executionSequence(executionId: string): number {
  const match = /^exec-(\d+)$/.exec(executionId);
  return match === null ? 0 : Number(match[1]);
}

function cloneRecord(record: ExecutionRecord): ExecutionRecord {
  return {
    ...record,
    steps: record.steps.map((step) => ({ ...step })),
    attempts: record.attempts.map((attempt) => ({ ...attempt })),
    ...(record.approval !== undefined ? { approval: { ...record.approval } } : {}),
    ...(record.stoppedDerived !== undefined ? { stoppedDerived: [...record.stoppedDerived] } : {}),
  };
}