import { describe, expect, it } from "vitest";
import {
  assertAttemptReplayable,
  attentionItemId,
  attentionItemsFromLedger,
  attentionKindClearsOnRead,
  awaitApproval,
  completeExecution,
  consumeExecutionApproval,
  emptyExecutionLedger,
  expireExecution,
  failExecution,
  groupAttentionItems,
  highestExecutionSequence,
  markAttentionRead,
  openExecution,
  planStep,
  recordAttempt,
  rejectExecution,
  settleExecutionsOnRestore,
  settleStep,
  splitExecutionStates,
  serviceExecutionStateOf,
  stopExecution,
  verifyExecutionApproval,
  verifyExternalResult,
  type ExecutionRecord,
} from "./execution-ledger.js";

const AT = "2026-09-22T10:00:00.000Z";

function execution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    ...openExecution({
      executionId: "exec-1",
      taskId: "release",
      sessionId: "main",
      kind: "turn",
      label: "回合工具 exec.run",
      at: AT,
      projectId: "atlas",
    }),
    ...overrides,
  };
}

function approvedRef(overrides: Partial<NonNullable<ExecutionRecord["approval"]>> = {}) {
  return {
    approvalId: "approval-1",
    status: "approved" as const,
    payloadVersion: "v1",
    requestedAt: AT,
    ...overrides,
  };
}

describe("execution records", () => {
  it("opens with its own version and keeps a step/attempt trail located by task and session", () => {
    const record = execution();
    expect(record.state).toBe("executing");
    expect(record.version).toBe(1);
    expect(record.projectId).toBe("atlas");

    const planned = planStep(record, { stepId: "step-1", label: "写入 notes.md", at: AT });
    const settled = settleStep(planned, { stepId: "step-1", state: "done", at: AT });
    const attempted = recordAttempt(settled, { attemptId: "attempt-1", at: AT, endState: "completed", usageId: "usage-1" });
    expect(attempted.steps.map((step) => `${step.label}:${step.state}`)).toEqual(["写入 notes.md:done"]);
    expect(attempted.attempts[0]).toEqual({ attemptId: "attempt-1", at: AT, endState: "completed", usageId: "usage-1", replayable: true });
    // Every transition bumps the version (盒子 1「及其版本」).
    expect(attempted.version).toBe(4);
  });

  it("refuses a transition from a settled state instead of silently rewriting it", () => {
    const done = completeExecution(execution(), { at: AT });
    expect(done.state).toBe("done");
    expect(() => planStep(done, { stepId: "step-late", label: "迟到步骤", at: AT })).toThrow(/invalid-execution-transition/);
    expect(() => failExecution(done, { at: AT })).toThrow(/invalid-execution-transition/);
  });

  it("keeps the draft and every completed step on failure, skipping only the pending ones", () => {
    const planned = planStep(planStep(execution(), { stepId: "step-1", label: "拉取基线", at: AT }), {
      stepId: "step-2",
      label: "写入代码",
      at: AT,
    });
    const firstDone = settleStep(planned, { stepId: "step-1", state: "done", at: AT });
    const failed = failExecution(firstDone, { at: AT, reason: "模型调用失败" });
    expect(failed.state).toBe("failed");
    expect(failed.draftKept).toBe(true);
    expect(failed.failureReason).toBe("模型调用失败");
    expect(failed.steps).toEqual([
      { stepId: "step-1", label: "拉取基线", state: "done", at: AT },
      { stepId: "step-2", label: "写入代码", state: "skipped", at: AT },
    ]);
  });
});

describe("attempts and unknown external results", () => {
  it("marks an unobserved external result non-replayable and refuses a replay until it is verified", () => {
    const attempted = recordAttempt(execution(), { attemptId: "attempt-1", at: AT, endState: "unknown-external", usageId: "usage-1" });
    expect(attempted.attempts[0]?.replayable).toBe(false);
    expect(() => assertAttemptReplayable(attempted, "attempt-1")).toThrow(/external-result-unverified/);

    const verified = verifyExternalResult(attempted, { attemptId: "attempt-1", resolved: "completed", at: AT });
    expect(verified.attempts[0]).toMatchObject({ endState: "completed", replayable: true, verifiedAt: AT });
    expect(() => assertAttemptReplayable(verified, "attempt-1")).not.toThrow();
  });

  it("never auto-replays an attempt whose verification says it failed", () => {
    const attempted = recordAttempt(execution(), { attemptId: "attempt-1", at: AT, endState: "unknown-external" });
    const failed = verifyExternalResult(attempted, { attemptId: "attempt-1", resolved: "failed", at: AT });
    expect(() => assertAttemptReplayable(failed, "attempt-1")).toThrow(/attempt-not-replayable/);
    // Verifying twice is refused: the result is already known.
    expect(() => verifyExternalResult(failed, { attemptId: "attempt-1", resolved: "completed", at: AT })).toThrow(
      /invalid-execution-transition/,
    );
  });

  it("records each attempt separately with its own usage key", () => {
    const first = recordAttempt(execution(), { attemptId: "attempt-1", at: AT, endState: "failed", usageId: "usage-1" });
    const second = recordAttempt(first, { attemptId: "attempt-2", at: AT, endState: "completed", usageId: "usage-2" });
    expect(second.attempts.map((attempt) => attempt.usageId)).toEqual(["usage-1", "usage-2"]);
  });
});

describe("approval re-check and one-shot consumption", () => {
  const base = { permission: "default" as const, contentVersion: "v1", now: AT };

  it("refuses a consumed, expired, downgraded, changed-version or wrong-scope approval", () => {
    expect(verifyExecutionApproval({ ...base, approval: approvedRef({ consumedAt: AT }) })).toMatchObject({
      ok: false,
      code: "already-consumed",
    });
    expect(verifyExecutionApproval({ ...base, approval: approvedRef({ expiresAt: "2026-09-22T09:00:00.000Z" }) })).toMatchObject({
      ok: false,
      code: "expired",
    });
    expect(verifyExecutionApproval({ ...base, permission: "read", approval: approvedRef() })).toMatchObject({
      ok: false,
      code: "permission-changed",
    });
    expect(verifyExecutionApproval({ ...base, contentVersion: "v2", approval: approvedRef() })).toMatchObject({
      ok: false,
      code: "version-mismatch",
    });
    expect(
      verifyExecutionApproval({
        ...base,
        approval: approvedRef({ scope: "browser-control" }),
        requiredScope: "service-control",
      }),
    ).toMatchObject({ ok: false, code: "scope-mismatch" });
    expect(verifyExecutionApproval({ ...base, approval: approvedRef({ status: "pending" }) })).toMatchObject({
      ok: false,
      code: "not-approved",
    });
  });

  it("accepts an unconsumed, unexpired, version-matching approval and spends it exactly once", () => {
    const waiting = awaitApproval(execution(), { approval: approvedRef(), at: AT });
    expect(waiting.state).toBe("pending-approval");
    expect(verifyExecutionApproval({ ...base, approval: waiting.approval as NonNullable<ExecutionRecord["approval"]> })).toEqual({ ok: true });

    const consumed = consumeExecutionApproval(waiting, { ...base, approvalId: "approval-1" });
    expect(consumed.approval?.consumedAt).toBe(AT);
    expect(consumed.state).toBe("executing");
    // A second execution attempt with the same id is refused (盒子 3).
    expect(() => consumeExecutionApproval(consumed, { ...base, approvalId: "approval-1" })).toThrow(/already-consumed/);
  });

  it("refuses to consume a stale payload version before executing", () => {
    const waiting = awaitApproval(execution(), { approval: approvedRef(), at: AT });
    expect(() => consumeExecutionApproval(waiting, { ...base, contentVersion: "v9", approvalId: "approval-1" })).toThrow(/version-mismatch/);
    expect(waiting.approval?.consumedAt).toBeUndefined();
  });

  it("rejects and expires without executing", () => {
    const waiting = awaitApproval(execution(), { approval: approvedRef({ status: "pending" }), at: AT });
    const rejected = rejectExecution(waiting, { approvalId: "approval-1", at: AT });
    expect(rejected.state).toBe("rejected");
    expect(rejected.approval?.status).toBe("rejected");

    const expired = expireExecution(waiting, { at: AT });
    expect(expired.state).toBe("expired");
    expect(expired.approval?.status).toBe("expired");
  });
});

describe("restart settlement", () => {
  it("stops an in-flight execution, expires a waiting confirmation and spends an unconsumed approval", () => {
    const running = recordAttempt(
      recordAttempt(execution(), { attemptId: "attempt-1", at: AT, endState: "awaiting-approval" }),
      { attemptId: "attempt-2", at: AT, endState: "completed", usageId: "usage-2" },
    );
    const waiting = awaitApproval(execution({ executionId: "exec-2" }), { approval: approvedRef(), at: AT });
    const ledger = { ...emptyExecutionLedger(), executions: [running, waiting], readItems: [{ itemId: "attention-completed-unread-release-exec-9", readAt: AT }] };

    const settled = settleExecutionsOnRestore(ledger, { at: "2026-09-22T11:00:00.000Z" });
    expect(settled.stopped).toEqual(["exec-1"]);
    expect(settled.expired).toEqual(["exec-2"]);
    const stopped = settled.ledger.executions[0];
    expect(stopped?.state).toBe("stopped");
    // The in-flight attempt's outside result was never observed: it must not
    // silently become replayable across a restart (盒子 6「不重复执行」).
    expect(stopped?.attempts[0]).toMatchObject({ endState: "unknown-external", replayable: false });
    // The completed attempt is untouched.
    expect(stopped?.attempts[1]).toMatchObject({ endState: "completed", replayable: true, usageId: "usage-2" });
    // A late approval after the restart arrives already spent.
    const expired = settled.ledger.executions[1];
    expect(expired?.approval?.consumedAt).toBe("2026-09-22T11:00:00.000Z");
    expect(() =>
      consumeExecutionApproval(expired as ExecutionRecord, {
        approvalId: "approval-1",
        approval: expired?.approval as NonNullable<ExecutionRecord["approval"]>,
        permission: "default",
        contentVersion: "v1",
        now: "2026-09-22T11:05:00.000Z",
      }),
    ).toThrow(/already-consumed/);
    // Read marks survive a restart.
    expect(settled.ledger.readItems).toHaveLength(1);
  });
});

describe("stop semantics", () => {
  it("covers derived executions but never rolls back a completed step or attempt", () => {
    const planned = planStep(planStep(execution(), { stepId: "step-1", label: "写入配置", at: AT }), {
      stepId: "step-2",
      label: "启动服务",
      at: AT,
    });
    const done = settleStep(planned, { stepId: "step-1", state: "done", at: AT });
    const attempted = recordAttempt(done, { attemptId: "attempt-1", at: AT, endState: "completed", usageId: "usage-1" });

    const stopped = stopExecution(attempted, { at: AT, derive: ["service-release-api"] });
    expect(stopped.state).toBe("stopped");
    expect(stopped.stoppedDerived).toEqual(["service-release-api"]);
    expect(stopped.steps).toEqual([
      { stepId: "step-1", label: "写入配置", state: "done", at: AT },
      { stepId: "step-2", label: "启动服务", state: "skipped", at: AT },
    ]);
    expect(stopped.attempts).toEqual(attempted.attempts);
  });
});

describe("service and session state separation", () => {
  it("reports a running service as its own state, never as a session that is executing", () => {
    const stoppedSession = stopExecution(execution(), { at: AT });
    const split = splitExecutionStates({
      record: stoppedSession,
      services: [
        { serviceId: "api", running: true },
        { serviceId: "worker", running: false, lastExit: { ok: false, reason: "crash" } },
        { serviceId: "db", running: false, lastExit: { ok: true } },
        { serviceId: "fresh", running: false },
      ],
    });
    expect(split.session).toBe("stopped");
    expect(split.services).toEqual([
      { serviceId: "api", state: "running" },
      { serviceId: "db", state: "stopped" },
      { serviceId: "fresh", state: "unknown" },
      { serviceId: "worker", state: "failed" },
    ]);
    // A session with no execution record at all reports no session state.
    expect(splitExecutionStates({ services: [] }).session).toBeNull();
    expect(serviceExecutionStateOf({ serviceId: "api", running: false, starting: true })).toBe("starting");
    expect(serviceExecutionStateOf({ serviceId: "api", running: true, stopping: true })).toBe("stopping");
  });
});

describe("attention list", () => {
  function ledgerWith(executions: ExecutionRecord[], readItems: { itemId: string; readAt: string }[] = []) {
    return { ...emptyExecutionLedger(), executions, readItems };
  }

  it("lists pending approvals plus failed/expired items and unread completions, located by task and session", () => {
    const waiting = awaitApproval(execution({ executionId: "exec-wait" }), { approval: approvedRef({ status: "pending" }), at: AT });
    const failed = failExecution(execution({ executionId: "exec-fail" }), { at: AT, reason: "命令失败" });
    const expired = expireExecution(execution({ executionId: "exec-exp" }), { at: AT });
    const done = completeExecution(execution({ executionId: "exec-done" }), { at: AT });

    const items = attentionItemsFromLedger(ledgerWith([waiting, failed, expired, done]), {
      taskId: "release",
      taskName: "发布",
      projectId: "atlas",
      projectName: "Atlas",
    });
    expect(items.map((item) => item.kind)).toEqual(["approval", "failed", "expired", "completed-unread"]);
    expect(items[0]).toMatchObject({
      id: attentionItemId(waiting, "approval"),
      taskId: "release",
      projectId: "atlas",
      sessionId: "main",
      label: "Atlas · 发布",
      detail: "待确认：回合工具 exec.run",
      read: false,
    });

    const grouped = groupAttentionItems(items);
    expect(grouped.pending.map((item) => item.kind)).toEqual(["approval", "failed", "expired"]);
    expect(grouped.unread.map((item) => item.id)).toEqual([attentionItemId(done, "completed-unread")]);
  });

  it("clears unread on read, keeps the same item id across refreshes, and never read-clears a pending item", () => {
    const done = completeExecution(execution({ executionId: "exec-done" }), { at: AT });
    const waiting = awaitApproval(execution({ executionId: "exec-wait" }), { approval: approvedRef({ status: "pending" }), at: AT });
    const ledger = ledgerWith([done, waiting]);
    const doneId = attentionItemId(done, "completed-unread");
    const approvalId = attentionItemId(waiting, "approval");

    const read = markAttentionRead(ledger, { itemIds: [doneId, approvalId], at: "2026-09-22T11:00:00.000Z" });
    expect(read.cleared).toEqual([doneId]);
    expect(read.kept).toEqual([approvalId]);
    expect(attentionKindClearsOnRead("approval")).toBe(false);
    expect(attentionKindClearsOnRead("completed-unread")).toBe(true);

    const items = attentionItemsFromLedger(read.ledger, { taskId: "release", taskName: "发布" });
    // The id is stable, so the refresh shows the same item as read.
    expect(items.map((item) => item.id)).toEqual([approvalId, doneId]);
    expect(items.find((item) => item.id === doneId)?.read).toBe(true);
    expect(groupAttentionItems(items).unread).toEqual([]);
    // Re-reading is a no-op, not a duplicate row.
    expect(markAttentionRead(read.ledger, { itemIds: [doneId], at: "2026-09-22T12:00:00.000Z" }).ledger.readItems).toHaveLength(1);
  });

  it("re-seeds the execution id sequence from a restored ledger", () => {
    expect(highestExecutionSequence(ledgerWith([execution({ executionId: "exec-7" })]), "exec")).toBe(7);
    expect(highestExecutionSequence(emptyExecutionLedger(), "exec")).toBe(0);
  });
});
