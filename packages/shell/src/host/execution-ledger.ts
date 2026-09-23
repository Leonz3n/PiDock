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

export class TaskExecutionLedger {
  private ledgerState: ExecutionLedgerRecord;
  private sequence: number;
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
   * The execution of one confirmation whatever its state (盒子 3/6): a record the
   * ledger already settled still answers, so a late approve can be refused
   * instead of falling through to the session channel.
   */
  byApproval(approvalId: string): ExecutionRecord | undefined {
    const record = this.ledgerState.executions.find((item) => item.approval?.approvalId === approvalId);
    return record === undefined ? undefined : cloneRecord(record);
  }

  /** The live execution waiting on one approval (盒子 3 resolves by approval id). */
  waitingOnApproval(approvalId: string): ExecutionRecord | undefined {
    const record = this.byApproval(approvalId);
    if (record === undefined) return undefined;
    return record.state === "pending-approval" || record.state === "executing" ? record : undefined;
  }

  open(input: { sessionId: string; kind: ExecutionKind; label: string; projectId?: string; callId?: string }): ExecutionRecord {
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
    });
    this.mutate([...this.ledgerState.executions, record]);
    return cloneRecord(record);
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

  rejectApproval(approvalId: string): ExecutionRecord | undefined {
    const waiting = this.waitingOnApproval(approvalId);
    if (!waiting) return undefined;
    return this.update(waiting.executionId, (record) => rejectExecution(record, { approvalId, at: this.now() }));
  }

  /** Deadline reached without a decision; returns every execution it expired. */
  expireApprovals(approvalIds: readonly string[]): ExecutionRecord[] {
    const expired: ExecutionRecord[] = [];
    for (const approvalId of approvalIds) {
      const waiting = this.waitingOnApproval(approvalId);
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
    this.settleDueApprovals();
    const executions = this.forSession(sessionId);
    const latest = executions[0];
    const split = splitExecutionStates({ services, ...(latest !== undefined ? { record: latest } : {}) });
    return { session: split.session, services: split.services, executions };
  }

  attention(input: { taskName: string }): ExecutionAttentionItem[] {
    this.settleDueApprovals();
    return attentionItemsFromLedger(this.ledgerState, { taskId: this.taskId, taskName: input.taskName });
  }

  /** Read-clearing (盒子 5): only the unread kind clears; others are reported kept. */
  markRead(itemIds: readonly string[]): { cleared: string[]; kept: string[] } {
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
    const index = this.ledgerState.executions.findIndex((item) => item.executionId === executionId);
    if (index === -1) throw new Error(`unknown-execution: ${executionId}`);
    const next = apply(this.ledgerState.executions[index] as ExecutionRecord);
    this.mutate(this.ledgerState.executions.map((item, position) => (position === index ? next : item)));
    return cloneRecord(next);
  }

  private mutate(executions: ExecutionRecord[]): void {
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
