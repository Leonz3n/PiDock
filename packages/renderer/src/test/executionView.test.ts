import { describe, expect, it } from "vitest";
import type { Approval, RunRecord, Session } from "../data/types";
import {
  EXECUTION_ACTION_LABEL,
  executionActions,
  executionCardVisible,
  executionLabel,
  executionStateOf,
  otherBusySession,
  outcomeApprovalFor,
  pendingApprovalsFor,
} from "../pages/executionView";

/**
 * [UI 对齐 05] (#29) the execution card's rules, kept out of the component so
 * the state source, the per-state entries and the dismissal rule are testable
 * without a DOM.
 */

function approval(patch: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    taskId: "release",
    sessionId: "deploy",
    title: "部署到 Staging",
    command: "bun run deploy:staging",
    cwd: "/workspace/atlas-web",
    impact: "更新 staging.atlas.example.com，预计 2 分钟",
    payloadVersion: "v1",
    status: "pending",
    executed: false,
    requestedAt: "2026-09-22T08:00:00.000Z",
    expiresAt: "2026-09-23T08:00:00.000Z",
    ...patch,
  };
}

function record(state: RunRecord["state"]): RunRecord {
  return { id: `run-${state}`, taskId: "release", sessionId: "failed", state, startedAt: "2026-09-22T08:00:00.000Z", summary: "", steps: [] };
}

function session(id: string, runState: Session["runState"]): Session {
  return {
    id,
    name: id,
    archived: false,
    permission: "default",
    providerId: "provider-local",
    model: "qwen",
    contextUsed: 0,
    contextWindow: 1000,
    tokens: 0,
    runState,
    unread: 0,
    lastActivity: "刚刚",
    messages: [],
  };
}

describe("execution card state", () => {
  it("keeps the prototype's eight labels", () => {
    expect(
      (["idle", "running", "approval", "failed", "completed", "stopped", "rejected", "expired"] as const).map(executionLabel),
    ).toEqual(["空闲", "执行中", "等待确认", "失败", "已完成", "已停止", "已拒绝", "确认已过期"]);
  });

  it("prefers the pending approval, then the live record, then the session state", () => {
    // A pending confirmation is the only state that needs the user right now.
    expect(
      executionStateOf({ sessionRunState: "idle", record: record("failed"), pendingApproval: approval() }),
    ).toBe("approval");
    // The live record is the newest event of this turn.
    expect(executionStateOf({ sessionRunState: "completed", record: record("failed") })).toBe("failed");
    // Without either, the persisted session state still tells the truth.
    expect(executionStateOf({ sessionRunState: "running" })).toBe("running");
    // An idle record never masks the session state.
    expect(executionStateOf({ sessionRunState: "stopped", record: record("idle") })).toBe("stopped");
  });

  it("offers only the entries the state allows", () => {
    expect(executionActions("running")).toEqual(["stop"]);
    expect(executionActions("approval")).toEqual(["approve", "reject"]);
    expect(executionActions("failed")).toEqual(["retry"]);
    expect(executionActions("expired")).toEqual(["dismiss"]);
    for (const state of ["idle", "completed", "stopped", "rejected"] as const) {
      expect(executionActions(state)).toEqual([]);
    }
    expect(EXECUTION_ACTION_LABEL).toEqual({
      stop: "停止执行",
      approve: "批准本次操作",
      reject: "拒绝",
      retry: "检查并重试",
      dismiss: "标记已处理",
    });
  });

  it("hides the card when idle and after the state was handled", () => {
    expect(executionCardVisible({ state: "idle" })).toBe(false);
    // An idle session still gets the card when another session is busy: that is
    // where the cross-session hint belongs.
    expect(executionCardVisible({ state: "idle", otherBusy: true })).toBe(true);
    expect(executionCardVisible({ state: "expired", dismissedState: "expired" })).toBe(false);
    // A later state change brings the card back.
    expect(executionCardVisible({ state: "running", dismissedState: "expired" })).toBe(true);
    expect(executionCardVisible({ state: "failed" })).toBe(true);
  });
});

describe("pending approvals", () => {
  it("keeps only this session's pending requests", () => {
    const approvals = [
      approval(),
      approval({ id: "approval-2", title: "执行数据库迁移" }),
      approval({ id: "approval-3", sessionId: "main" }),
      approval({ id: "approval-4", status: "approved" }),
    ];
    expect(pendingApprovalsFor(approvals, "release", "deploy").map((item) => item.id)).toEqual([
      "approval-1",
      "approval-2",
    ]);
  });
});

describe("approval outcome line", () => {
  it("reports the resolution the card's state is derived from", () => {
    const rejections = [
      approval({ id: "approval-deploy", status: "rejected", requestedAt: "2026-09-22T09:30:00+08:00" }),
      approval({ id: "approval-migrate", status: "rejected", requestedAt: "2026-09-22T09:31:00+08:00" }),
    ];
    // The latest request wins: taking the first non-pending record instead put
    // one request's outcome next to another request's state (P2-A).
    expect(outcomeApprovalFor(rejections, "release", "deploy", "rejected")?.id).toBe("approval-migrate");
    // 执行中 is the state of the approved turn, so the approved record explains it.
    expect(
      outcomeApprovalFor(
        [
          approval({ id: "approval-deploy", status: "rejected" }),
          approval({ id: "approval-migrate", status: "approved", executed: true }),
        ],
        "release",
        "deploy",
        "running",
      )?.id,
    ).toBe("approval-migrate");
  });

  it("has nothing to report in the states no resolution explains", () => {
    const approvals = [approval({ id: "a", status: "rejected" }), approval({ id: "b", status: "approved", executed: true })];
    for (const state of ["idle", "approval", "failed", "completed", "stopped"] as const) {
      expect(outcomeApprovalFor(approvals, "release", "deploy", state)).toBeUndefined();
    }
  });

  it("never borrows another task's or session's resolution", () => {
    const approvals = [
      approval({ id: "other-session", status: "rejected", sessionId: "main" }),
      approval({ id: "other-task", status: "rejected", taskId: "checkout" }),
    ];
    expect(outcomeApprovalFor(approvals, "release", "deploy", "rejected")).toBeUndefined();
  });
});

describe("other busy session", () => {
  it("names the first other session that runs or waits", () => {
    const sessions = [session("main", "idle"), session("deploy", "approval"), session("failed", "running")];
    expect(otherBusySession(sessions, "main", (item) => item.runState)?.id).toBe("deploy");
    // The active session never reports itself.
    expect(otherBusySession(sessions, "deploy", (item) => item.runState)?.id).toBe("failed");
    expect(otherBusySession([session("main", "idle")], "main", (item) => item.runState)).toBeUndefined();
  });
});
