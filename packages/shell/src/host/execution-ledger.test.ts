import { describe, expect, it } from "vitest";
import { TaskExecutionLedger } from "./execution-ledger.js";
import { TaskWorkspaceHost, memoryTaskStore } from "./task-host.js";
import { parseExecutionLedger, serializeExecutionLedger } from "./task-store.js";
import { resetPiSequencesForTests } from "../main/pi-session.js";

const TASK_ID = "task-aaaaaaaa";
const TASK_DIR = "/tasks/task-aaaaaaaa";
const AT = "2026-09-22T10:00:00.000Z";

function host(store: ReturnType<typeof memoryTaskStore>, now: () => string = () => AT) {
  return new TaskWorkspaceHost(TASK_ID, TASK_DIR, store, now);
}

/** Smallest persisted ledger the reader accepts, so one field can be tampered with. */
function persistedLedger(input: { record?: Record<string, unknown>; ledger?: Record<string, unknown> } = {}): string {
  return JSON.stringify({
    version: 1,
    executions: [
      {
        executionId: "exec-1",
        taskId: TASK_ID,
        sessionId: "main",
        kind: "turn",
        label: "回合工具 exec.run",
        state: "done",
        startedAt: AT,
        updatedAt: AT,
        version: 1,
        draftKept: false,
        steps: [],
        attempts: [{ attemptId: "exec-1-attempt-1", at: AT, endState: "completed", replayable: true }],
        ...input.record,
      },
    ],
    readItems: [],
    ...input.ledger,
  });
}

/** Scripted `exec.run` plan (the Host injects this closure for a real op). */
function execPlan(target = `${TASK_DIR}/notes.md`) {
  return {
    tool: "exec.run",
    target,
    execute: () => ({ tool: "exec.run", target, contentVersion: "v1", output: "planned" }),
  };
}

describe("TaskExecutionLedger", () => {
  it("persists every transition and re-seeds its sequence from the restored ledger", () => {
    const store = memoryTaskStore();
    let clock = AT;
    const ledger = new TaskExecutionLedger(TASK_ID, TASK_DIR, store, () => clock);
    const first = ledger.open({ sessionId: "main", kind: "turn", label: "回合工具 fs.write" });
    ledger.planStep(first.executionId, { stepId: "turn", label: "回合检查" });
    ledger.settleStep(first.executionId, { stepId: "turn", state: "done" });
    ledger.attempt(first.executionId, { endState: "completed", usageId: "call-1" });
    ledger.complete(first.executionId);
    expect(first.executionId).toBe("exec-1");

    clock = "2026-09-22T10:05:00.000Z";
    const restored = new TaskExecutionLedger(TASK_ID, TASK_DIR, store, () => clock);
    expect(restored.byId("exec-1")?.state).toBe("done");
    expect(restored.byId("exec-1")?.attempts[0]).toMatchObject({ endState: "completed", usageId: "call-1" });
    // A restarted Host never re-mints an id an earlier process already used.
    expect(restored.open({ sessionId: "main", kind: "turn", label: "第二回合" }).executionId).toBe("exec-2");
  });

  it("settles what the previous process left in flight, spending any unconsumed approval", () => {
    const store = memoryTaskStore();
    let clock = AT;
    const ledger = new TaskExecutionLedger(TASK_ID, TASK_DIR, store, () => clock);
    const running = ledger.open({ sessionId: "main", kind: "turn", label: "在途回合" });
    ledger.attempt(running.executionId, { endState: "awaiting-approval", usageId: "call-1" });
    const waiting = ledger.open({ sessionId: "main", kind: "turn", label: "等待确认" });
    ledger.awaitApproval(waiting.executionId, { approvalId: "approval-1", payloadVersion: "v1" });

    clock = "2026-09-22T11:00:00.000Z";
    const restored = new TaskExecutionLedger(TASK_ID, TASK_DIR, store, () => clock);
    expect(restored.byId(running.executionId)?.state).toBe("stopped");
    // The in-flight attempt's outside result was never observed: not replayable.
    expect(restored.byId(running.executionId)?.attempts[0]).toMatchObject({ endState: "unknown-external", replayable: false });
    const settled = restored.byId(waiting.executionId);
    expect(settled?.state).toBe("expired");
    expect(settled?.approval?.consumedAt).toBe("2026-09-22T11:00:00.000Z");
    // A late approval after the restart can no longer authorize anything.
    expect(() =>
      restored.authorize(waiting.executionId, { approvalId: "approval-1", permission: "default", contentVersion: "v1" }),
    ).toThrow(/not-approved|already-consumed/);
  });

  it("expires a waiting confirmation whose declared deadline passed", () => {
    const store = memoryTaskStore();
    let clock = AT;
    const ledger = new TaskExecutionLedger(TASK_ID, TASK_DIR, store, () => clock);
    const waiting = ledger.open({ sessionId: "main", kind: "turn", label: "等待确认" });
    ledger.awaitApproval(waiting.executionId, { approvalId: "approval-1", payloadVersion: "v1" });
    expect(ledger.settleDueApprovals()).toEqual([]);

    clock = "2026-09-23T11:00:00.000Z";
    const expired = ledger.settleDueApprovals();
    expect(expired.map((record) => record.state)).toEqual(["expired"]);
    expect(ledger.attention({ taskName: "发布" }).map((item) => item.kind)).toEqual(["expired"]);
    // Persisted: the next Host instance reads the same expired record.
    expect(new TaskExecutionLedger(TASK_ID, TASK_DIR, store, () => clock).byId(waiting.executionId)?.state).toBe("expired");
  });

  it("reports the session state and the service states as two separate families", () => {
    const ledger = new TaskExecutionLedger(TASK_ID, TASK_DIR, memoryTaskStore(), () => AT);
    const running = ledger.open({ sessionId: "main", kind: "turn", label: "回合工具 exec.run" });
    const readout = ledger.state("main", [
      { serviceId: "api", running: true },
      { serviceId: "worker", running: false, lastExit: { ok: false } },
    ]);
    expect(readout.session).toBe("executing");
    expect(readout.services).toEqual([
      { serviceId: "api", state: "running" },
      { serviceId: "worker", state: "failed" },
    ]);
    expect(readout.executions.map((record) => record.executionId)).toEqual([running.executionId]);
  });

  it("orders a session's executions by sequence when the timestamps tie", () => {
    const ledger = new TaskExecutionLedger(TASK_ID, TASK_DIR, memoryTaskStore(), () => AT);
    const ids = Array.from({ length: 10 }, () => ledger.open({ sessionId: "main", kind: "turn", label: "回合" }).executionId);
    expect(ids.at(-1)).toBe("exec-10");
    // The readout takes executions[0] as the newest; an id-string compare would
    // put exec-9 first on a tied updatedAt and report the older state.
    expect(ledger.forSession("main").map((record) => record.executionId)).toEqual([
      "exec-10",
      "exec-9",
      "exec-8",
      "exec-7",
      "exec-6",
      "exec-5",
      "exec-4",
      "exec-3",
      "exec-2",
      "exec-1",
    ]);
  });

  it("refuses to authorize a confirmation the ledger already settled", () => {
    const ledger = new TaskExecutionLedger(TASK_ID, TASK_DIR, memoryTaskStore(), () => AT);
    const waiting = ledger.open({ sessionId: "main", kind: "turn", label: "等待确认" });
    ledger.awaitApproval(waiting.executionId, { approvalId: "approval-1", payloadVersion: "v1" });
    ledger.rejectApproval("main", "approval-1");
    // The user's decision is recorded only on a live request; a settled ref
    // reaches the re-check with its own status and is refused there.
    expect(() => ledger.authorize(waiting.executionId, { approvalId: "approval-1", permission: "default", contentVersion: "v1" })).toThrow(
      /not-approved/,
    );
    expect(ledger.byId(waiting.executionId)?.state).toBe("rejected");
    expect(ledger.byId(waiting.executionId)?.approval?.consumedAt).toBeUndefined();
  });

  it("rejects only the named session's approval and leaves colliding attention and records unchanged", () => {
    const ledger = new TaskExecutionLedger(TASK_ID, TASK_DIR, memoryTaskStore(), () => AT);
    const original = ledger.open({ sessionId: "original", kind: "turn", label: "original" });
    ledger.awaitApproval(original.executionId, { approvalId: "approval-1", payloadVersion: "v1" });
    const review = ledger.open({ sessionId: "review", kind: "turn", label: "review" });
    ledger.awaitApproval(review.executionId, { approvalId: "approval-1", payloadVersion: "v1" });
    const before = JSON.stringify(ledger.forSession("original"));
    const attention = ledger.attention({ taskName: "Release" }).find((item) => item.sessionId === "original");

    expect(ledger.rejectApproval("review", "approval-1")?.executionId).toBe(review.executionId);
    expect(ledger.state("review").session).toBe("rejected");
    expect(JSON.stringify(ledger.forSession("original"))).toBe(before);
    expect(ledger.attention({ taskName: "Release" })).toEqual([attention]);
    expect(ledger.rejectApproval("unknown", "approval-1")).toBeUndefined();
    expect(ledger.rejectApproval("review", "approval-1")).toBeUndefined();
    expect(JSON.stringify(ledger.forSession("original"))).toBe(before);
  });

  it("expires a session-bound approval batch without spending another session's identical id", () => {
    const store = memoryTaskStore();
    const ledger = new TaskExecutionLedger(TASK_ID, TASK_DIR, store, () => AT);
    const original = ledger.open({ sessionId: "original", kind: "turn", label: "original" });
    ledger.awaitApproval(original.executionId, { approvalId: "approval-1", payloadVersion: "v1" });
    const review = ledger.open({ sessionId: "review", kind: "turn", label: "review" });
    ledger.awaitApproval(review.executionId, { approvalId: "approval-1", payloadVersion: "v1" });
    const before = JSON.stringify(ledger.forSession("original"));
    expect(ledger.expireApprovals("unknown", ["approval-1"])).toEqual([]);
    expect(ledger.expireApprovals("review", ["approval-1", "approval-1", "missing"]).map((record) => record.executionId)).toEqual([review.executionId]);
    expect(ledger.state("review").session).toBe("expired");
    expect(JSON.stringify(ledger.forSession("original"))).toBe(before);
    expect(JSON.stringify(store.readExecutions(TASK_DIR).executions.filter((record) => record.sessionId === "original"))).toBe(before);
    expect(ledger.attention({ taskName: "Release" }).map((item) => [item.sessionId, item.kind])).toEqual([["original", "approval"], ["review", "expired"]]);
    expect(() => ledger.authorize(review.executionId, { approvalId: "approval-1", permission: "default" })).toThrow(/not-approved|already-consumed/);
    expect(JSON.stringify(ledger.forSession("original"))).toBe(before);
  });

  it("refuses a persisted ledger whose record shape is not trustworthy", () => {
    // A real ledger round-trips and the hand-built baseline below is accepted, so
    // each rejection is the tampered field and not an unrelated shape error.
    const real = new TaskExecutionLedger(TASK_ID, TASK_DIR, memoryTaskStore(), () => AT);
    real.open({ sessionId: "main", kind: "turn", label: "回合" });
    expect(parseExecutionLedger(serializeExecutionLedger(real.ledger)).executions).toHaveLength(1);
    expect(parseExecutionLedger(persistedLedger()).executions).toHaveLength(1);
    expect(() => parseExecutionLedger(persistedLedger({ record: { state: "waiting" } }))).toThrow(/execution record.state/);
    expect(() =>
      parseExecutionLedger(
        persistedLedger({ record: { attempts: [{ attemptId: "exec-1-attempt-1", at: AT, endState: "completed", replayable: "yes" }] } }),
      ),
    ).toThrow(/attempt.replayable must be a boolean/);
    expect(() => parseExecutionLedger(persistedLedger({ ledger: { readItems: [{ itemId: "attention-completed-unread-exec-1" }] } }))).toThrow(
      /readItems.readAt/,
    );
    expect(() => parseExecutionLedger(persistedLedger({ ledger: { version: 0 } }))).toThrow(/ledger.version/);
  });
});

describe("TaskWorkspaceHost execution wiring", () => {
  it("approves only the requested session when a recovered session has the same approval id", () => {
    const store = memoryTaskStore();
    resetPiSequencesForTests();
    const previous = host(store);
    const old = previous.sendMessage("original", "original command", execPlan());
    previous.approve("original", old.approvalId as string);
    const originalRecord = JSON.stringify(previous.executionState("original").executions);
    const originalHistory = JSON.stringify(store.readSession(TASK_DIR, "original"));

    // Simulate a legacy process that minted the same id before opening the
    // other session's recovered history. No user data or native tools run.
    resetPiSequencesForTests();
    const workspace = host(store);
    const current = workspace.sendMessage("review", "review command", execPlan());
    expect(current.approvalId).toBe(old.approvalId);
    expect(workspace.approve("review", current.approvalId as string)).toBe(current.callId);
    expect(workspace.executionState("review").session).toBe("done");
    expect(JSON.stringify(workspace.executionState("original").executions)).toBe(originalRecord);
    expect(JSON.stringify(store.readSession(TASK_DIR, "original"))).toBe(originalHistory);
    expect(workspace.attention().items.filter((item) => item.kind === "completed-unread").map((item) => item.sessionId)).toEqual(["original", "review"]);
    expect(() => workspace.approve("review", current.approvalId as string)).toThrow(/已处理/);
  });

  it("rejects the requested session's colliding approval without changing recovered history", () => {
    const store = memoryTaskStore();
    resetPiSequencesForTests();
    const previous = host(store);
    const old = previous.sendMessage("original", "original command", execPlan());
    previous.approve("original", old.approvalId as string);
    const originalRecord = JSON.stringify(previous.executionState("original").executions);
    const originalHistory = JSON.stringify(store.readSession(TASK_DIR, "original"));
    resetPiSequencesForTests();
    const workspace = host(store);
    const current = workspace.sendMessage("review", "review command", execPlan());
    expect(current.approvalId).toBe(old.approvalId);
    workspace.reject("review", current.approvalId as string);
    expect(workspace.executionState("review").session).toBe("rejected");
    expect(workspace.openSession("review").snapshot().approvals[0]?.status).toBe("rejected");
    expect(JSON.stringify(workspace.executionState("original").executions)).toBe(originalRecord);
    expect(JSON.stringify(store.readSession(TASK_DIR, "original"))).toBe(originalHistory);
    expect(workspace.attention().items.map((item) => [item.sessionId, item.kind])).toEqual([["original", "completed-unread"]]);
    const restarted = host(store);
    expect(restarted.executionState("review").session).toBe("rejected");
    expect(JSON.stringify(restarted.executionState("original").executions)).toBe(originalRecord);
  });

  it("refuses another session's approval without consuming its record or attention item", () => {
    const workspace = host(memoryTaskStore());
    const current = workspace.sendMessage("original", "original command", execPlan());
    const before = JSON.stringify(workspace.executionState("original").executions);
    const attention = workspace.attention().items;
    expect(() => workspace.approve("review", current.approvalId as string)).toThrow("确认请求不存在");
    expect(JSON.stringify(workspace.executionState("original").executions)).toBe(before);
    expect(workspace.attention().items).toEqual(attention);
    expect(workspace.openSession("original").snapshot().approvals[0]?.status).toBe("pending");
  });

  it("refuses a stopped session's colliding approval while leaving the other session pending", () => {
    resetPiSequencesForTests();
    const workspace = host(memoryTaskStore());
    const old = workspace.sendMessage("original", "original command", execPlan());
    workspace.cancel("original");
    resetPiSequencesForTests();
    const current = workspace.sendMessage("review", "review command", execPlan());
    expect(current.approvalId).toBe(old.approvalId);
    const before = JSON.stringify(workspace.executionState("review").executions);
    const history = JSON.stringify(workspace.openSession("review").snapshot());
    const attention = workspace.attention().items;
    expect(() => workspace.approve("original", old.approvalId as string)).toThrow(/invalid-execution-transition/);
    expect(JSON.stringify(workspace.executionState("review").executions)).toBe(before);
    expect(JSON.stringify(workspace.openSession("review").snapshot())).toBe(history);
    expect(workspace.attention().items).toEqual(attention);
    expect(workspace.approve("review", current.approvalId as string)).toBe(current.callId);
  });

  it("settles only a due colliding session approval and preserves the other session's completed record", () => {
    const store = memoryTaskStore();
    resetPiSequencesForTests();
    const previous = host(store);
    const old = previous.sendMessage("original", "original command", execPlan());
    previous.approve("original", old.approvalId as string);
    const originalRecord = JSON.stringify(previous.executionState("original").executions);
    const originalHistory = JSON.stringify(store.readSession(TASK_DIR, "original"));
    resetPiSequencesForTests();
    let clock = AT;
    const workspace = host(store, () => clock);
    const current = workspace.sendMessage("review", "review command", execPlan());
    expect(current.approvalId).toBe(old.approvalId);
    clock = "2026-09-23T11:00:00.000Z";
    workspace.evaluateSchedules();
    expect(workspace.executionState("review").session).toBe("expired");
    expect(workspace.openSession("review").snapshot().approvals[0]?.status).toBe("expired");
    expect(workspace.writeLockOwner).toBeNull();
    expect(JSON.stringify(workspace.executionState("original").executions)).toBe(originalRecord);
    expect(JSON.stringify(store.readSession(TASK_DIR, "original"))).toBe(originalHistory);
    expect(workspace.attention().items.map((item) => [item.sessionId, item.kind])).toEqual([["review", "expired"], ["original", "completed-unread"]]);
    const before = JSON.stringify(store.readExecutions(TASK_DIR));
    expect(() => workspace.approve("review", current.approvalId as string)).toThrow(/invalid-execution-transition/);
    expect(JSON.stringify(store.readExecutions(TASK_DIR))).toBe(before);
  });

  it("records a turn as one execution with its step, its attempt usage and its terminal state", () => {
    const store = memoryTaskStore();
    const workspace = host(store);
    const result = workspace.sendMessage("main", "写一条记录", { tool: "fs.write", target: `${TASK_DIR}/notes.md` });
    expect(result.state).toBe("done");

    const readout = workspace.executionState("main", [{ serviceId: "api", running: true }]);
    expect(readout.session).toBe("done");
    // A running service is its own state, never the session's (盒子 2).
    expect(readout.services).toEqual([{ serviceId: "api", state: "running" }]);
    const record = readout.executions[0];
    expect(record).toMatchObject({ callId: result.callId, state: "done", kind: "turn", draftKept: false });
    expect(record?.steps).toEqual([{ stepId: "tool-fs.write", label: `fs.write ${TASK_DIR}/notes.md`, state: "done", at: AT }]);
    expect(record?.attempts).toEqual([
      { attemptId: `${record?.executionId}-attempt-1`, at: AT, endState: "completed", usageId: result.callId, replayable: true },
    ]);
    // No attention item for a completed-but-unread execution until it is read;
    // the item exists and is unread.
    expect(workspace.attention().items.map((item) => item.kind)).toEqual(["completed-unread"]);
  });

  it("records a refused turn as failed instead of leaving it executing forever", () => {
    const store = memoryTaskStore();
    const workspace = host(store);
    workspace.sendMessage("main", "第一轮", execPlan());
    expect(() => workspace.sendMessage("main", "并行第二轮", { tool: "fs.write", target: `${TASK_DIR}/notes.md` })).toThrow(
      /当前执行尚未结束/,
    );
    const records = workspace.executionState("main").executions;
    expect(records.map((record) => record.state)).toEqual(["failed", "pending-approval"]);
    expect(records[0]?.draftKept).toBe(true);
  });

  it("waits on the confirmation, re-checks it, then executes it exactly once", () => {
    const store = memoryTaskStore();
    const workspace = host(store);
    const result = workspace.sendMessage("main", "运行命令", execPlan());
    expect(result.state).toBe("approval");
    const approvalId = result.approvalId as string;

    const waiting = workspace.executionState("main");
    expect(waiting.session).toBe("pending-approval");
    expect(waiting.executions[0]?.approval).toMatchObject({
      approvalId,
      status: "pending",
      payloadVersion: "v1",
      expiresAt: "2026-09-23T10:00:00.000Z",
    });
    expect(workspace.attention().items).toMatchObject([{ kind: "approval", detail: "待确认：回合工具 exec.run /tasks/task-aaaaaaaa/notes.md" }]);

    const callId = workspace.approve("main", approvalId);
    expect(callId).toBe(result.callId);
    const approved = workspace.executionState("main");
    expect(approved.session).toBe("done");
    expect(approved.executions[0]?.approval).toMatchObject({ status: "approved", consumedAt: AT });
    expect(approved.executions[0]?.attempts.at(-1)).toMatchObject({ endState: "completed", usageId: callId });
    // Already handled: a replay is refused and mints no second execution.
    expect(() => workspace.approve("main", approvalId)).toThrow(/已处理/);
    expect(workspace.executionState("main").executions).toHaveLength(1);
  });

  it("refuses to execute an approval whose payload version moved, leaving the request pending", () => {
    const store = memoryTaskStore();
    const workspace = host(store);
    const result = workspace.sendMessage("main", "运行命令", execPlan());
    const approvalId = result.approvalId as string;

    expect(() => workspace.approve("main", approvalId, "v9")).toThrow(/version-mismatch/);
    // Nothing executed: the request is still pending, no consumption, no attempt.
    const readout = workspace.executionState("main");
    expect(readout.session).toBe("pending-approval");
    expect(readout.executions[0]?.approval).toMatchObject({ status: "pending" });
    expect(readout.executions[0]?.approval?.consumedAt).toBeUndefined();
    expect(readout.executions[0]?.attempts).toHaveLength(1);
  });

  it("stops derived executions on cancel but never rolls back a completed step or attempt", () => {
    const store = memoryTaskStore();
    const workspace = host(store);
    const result = workspace.sendMessage("main", "运行命令", execPlan());
    expect(result.state).toBe("approval");
    // A derived execution (child process / sub-agent) outlives its turn.
    workspace.claimDerivedExecution({ resourceId: "service-release-api", sessionId: "main", label: "服务 api" });
    workspace.cancel("main");

    const readout = workspace.executionState("main");
    expect(readout.session).toBe("stopped");
    expect(readout.executions[0]?.stoppedDerived).toEqual(["service-release-api"]);
    expect(readout.executions[0]?.attempts).toEqual([
      {
        attemptId: `${readout.executions[0]?.executionId}-attempt-1`,
        at: AT,
        endState: "awaiting-approval",
        usageId: result.callId,
        replayable: true,
      },
    ]);
    expect(readout.executions[0]?.steps.every((step) => step.state !== "pending")).toBe(true);
  });

  it("never executes a late approval after a restart", () => {
    const store = memoryTaskStore();
    const first = host(store);
    const result = first.sendMessage("main", "运行命令", execPlan());
    const approvalId = result.approvalId as string;

    const second = host(store, () => "2026-09-22T11:00:00.000Z");
    expect(second.executionState("main").session).toBe("expired");
    expect(second.executionState("main").executions[0]?.approval?.consumedAt).toBe("2026-09-22T11:00:00.000Z");
    expect(() => second.approve("main", approvalId)).toThrow(/已处理|过期|不能执行/);
    // The restarted session kept its history and ran nothing new.
    expect(second.executionState("main").executions[0]?.attempts).toHaveLength(1);
  });

  it("refuses an approve whose confirmation the read path already expired", () => {
    const store = memoryTaskStore();
    let clock = AT;
    const workspace = new TaskWorkspaceHost(TASK_ID, TASK_DIR, store, () => clock);
    const result = workspace.sendMessage("main", "运行命令", execPlan());
    const approvalId = result.approvalId as string;

    // Any app refresh reads the state (the renderer fans `task/attention` out per
    // task), and that read settles the deadline that passed while the Host lived.
    clock = "2026-09-23T11:00:00.000Z";
    expect(workspace.executionState("main").session).toBe("expired");
    expect(() => workspace.approve("main", approvalId)).toThrow(/invalid-execution-transition/);
    // Nothing executed: no second attempt, no completion, and the session keeps
    // the claim the waiting turn held (approved/reject/cancel are what release it).
    expect(workspace.executionState("main").executions[0]?.attempts).toHaveLength(1);
    expect(workspace.executionState("main").executions[0]?.state).toBe("expired");
    expect(workspace.writeLockOwner).toBe("main");
  });

  it("clears the unread items on read and keeps pending items for handling", () => {
    const store = memoryTaskStore();
    const workspace = host(store);
    workspace.sendMessage("main", "写一条记录", { tool: "fs.write", target: `${TASK_DIR}/notes.md` });
    workspace.sendMessage("main", "运行命令", execPlan());
    const items = workspace.attention().items;
    const unread = items.find((item) => item.kind === "completed-unread");
    const approval = items.find((item) => item.kind === "approval");
    expect(unread).toBeDefined();
    expect(approval).toBeDefined();

    const cleared = workspace.markAttentionRead([unread?.id as string, approval?.id as string]);
    expect(cleared.cleared).toEqual([unread?.id]);
    expect(cleared.kept).toEqual([approval?.id]);
    // The read mark is persisted and the item id is stable across a restart.
    const restarted = host(store, () => "2026-09-22T11:00:00.000Z");
    expect(restarted.attention().items.find((item) => item.id === unread?.id)?.read).toBe(true);
  });
});
