import { describe, expect, it } from "vitest";
import {
  executionStateFromHost,
  runRecordFromExecutionState,
  runStateOfExecution,
} from "../data/executionLedger";

/**
 * [PiDock 14] (#17) renderer mirror of the Host execution readout
 * (`task/executionState`). The Host owns the records; this module only parses
 * what it returned, so the tests below are about the parse boundary and the
 * vocabulary mapping the execution card consumes.
 */
function hostReadout(overrides: Record<string, unknown> = {}) {
  return {
    state: {
      session: "failed",
      services: [{ serviceId: "saas-web", state: "running" }],
      executions: [
        {
          executionId: "exec-2",
          taskId: "task-a",
          sessionId: "main",
          kind: "browser-action",
          label: "页面变更 page/navigate",
          state: "failed",
          version: 4,
          startedAt: "2026-09-22T10:00:00.000Z",
          updatedAt: "2026-09-22T10:00:05.000Z",
          steps: [{ stepId: "control", label: "浏览器操作 page/navigate", state: "failed", at: "2026-09-22T10:00:05.000Z" }],
          attempts: [{ attemptId: "exec-2-attempt-1", at: "2026-09-22T10:00:05.000Z", endState: "failed", replayable: false }],
          draftKept: true,
          failureReason: "页面不可用",
        },
        {
          executionId: "exec-1",
          taskId: "task-a",
          sessionId: "main",
          kind: "turn",
          label: "SDK main 回合",
          state: "done",
          version: 9,
          startedAt: "2026-09-22T09:00:00.000Z",
          updatedAt: "2026-09-22T09:00:03.000Z",
          steps: [{ stepId: "turn", label: "SDK 模型请求", state: "done" }],
          attempts: [],
          draftKept: false,
        },
      ],
      ...overrides,
    },
  };
}

describe("execution readout parsing", () => {
  it("parses one Host readout into session, service and execution rows", () => {
    const view = executionStateFromHost(hostReadout());
    expect(view).not.toBeNull();
    expect(view).toMatchObject({
      session: "failed",
      services: [{ serviceId: "saas-web", state: "running" }],
    });
    // The service family is reported apart from the session state.
    expect(view?.executions).toHaveLength(2);
    expect(view?.executions[0]).toMatchObject({
      executionId: "exec-2",
      kind: "browser-action",
      state: "failed",
      draftKept: true,
      failureReason: "页面不可用",
      steps: [{ stepId: "control", state: "failed" }],
      attempts: [{ attemptId: "exec-2-attempt-1", endState: "failed", replayable: false }],
    });
    expect(view?.executions[1]).toMatchObject({ kind: "turn", state: "done" });
  });

  it("keeps the confirmation a waiting control row carries", () => {
    const view = executionStateFromHost(
      hostReadout({
        session: "pending-approval",
        executions: [
          {
            executionId: "exec-3",
            taskId: "task-a",
            sessionId: "main",
            kind: "terminal-control",
            label: "终端启动 term-1",
            state: "pending-approval",
            version: 2,
            startedAt: "2026-09-22T10:00:00.000Z",
            updatedAt: "2026-09-22T10:00:00.000Z",
            steps: [{ stepId: "control", label: "终端启动", state: "pending" }],
            attempts: [],
            draftKept: false,
            approval: {
              approvalId: "approval-4",
              status: "pending",
              scope: "terminal-control",
              payloadVersion: "v1",
              requestedAt: "2026-09-22T10:00:00.000Z",
              expiresAt: "2026-09-23T10:00:00.000Z",
            },
          },
        ],
      }),
    );
    expect(view?.executions[0]?.approval).toMatchObject({ approvalId: "approval-4", scope: "terminal-control", status: "pending" });
  });

  it("fails closed on a missing, malformed or unrecognizable readout", () => {
    expect(executionStateFromHost(undefined)).toBeNull();
    expect(executionStateFromHost({})).toBeNull();
    expect(executionStateFromHost({ state: {} })).toBeNull();
    // An unknown kind/state is not guessed into a row.
    expect(executionStateFromHost(hostReadout({ executions: [{ ...hostReadout().state.executions[0], kind: "unknown-kind" }] }))).toBeNull();
    expect(executionStateFromHost(hostReadout({ session: "unknown-state" }))).toBeNull();
    expect(executionStateFromHost(hostReadout({ services: [{ serviceId: "saas-web", state: "unknown-service-state" }] }))).toBeNull();
    expect(executionStateFromHost(hostReadout({ services: "not-an-array" }))).toBeNull();
  });

  it("maps the Host session vocabulary onto the card's RunState", () => {
    expect(runStateOfExecution("executing")).toBe("running");
    expect(runStateOfExecution("pending-approval")).toBe("approval");
    expect(runStateOfExecution("done")).toBe("completed");
    expect(runStateOfExecution("stopped")).toBe("stopped");
    expect(runStateOfExecution("rejected")).toBe("rejected");
    expect(runStateOfExecution("expired")).toBe("expired");
    expect(runStateOfExecution("failed")).toBe("failed");
    expect(runStateOfExecution(null)).toBeUndefined();
    expect(runStateOfExecution(undefined)).toBeUndefined();
  });

  it("turns the newest persisted execution into the card's run record", () => {
    const view = executionStateFromHost(hostReadout());
    const record = runRecordFromExecutionState("task-a", "main", view);
    expect(record).toMatchObject({
      id: "ledger-exec-2",
      taskId: "task-a",
      sessionId: "main",
      state: "failed",
      startedAt: "2026-09-22T10:00:00.000Z",
      summary: "页面不可用",
      steps: [{ label: "浏览器操作 page/navigate", state: "failed" }],
    });
    // No readout (or no execution) means the card keeps its own source.
    expect(runRecordFromExecutionState("task-a", "main", null)).toBeUndefined();
    expect(runRecordFromExecutionState("task-a", "main", { session: null, services: [], executions: [] })).toBeUndefined();
  });
});
