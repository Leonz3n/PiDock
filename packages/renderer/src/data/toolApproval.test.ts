import { describe, expect, it } from "vitest";
import {
  APPROVAL_IMPACT_TEXT,
  SHARED_ROOT_IMPACT_TEXT,
  approvalFailureText,
  approvalRefusal,
  approvalRequest,
  approvalStatusText,
  approvalToolLabel,
  parseTaskApprovals,
  type TaskApproval,
} from "./toolApproval";

/**
 * [Pencil T05] ticket 140 审批的渲染层规则：Host 的记录怎么解析、一次决定发什么、以及
 * 哪些读数必须被当成「不可用」而不是「没有」。
 */

const TASK_ID = "task-a";
const SESSION = "main";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "approval-1",
    callId: "call-1",
    taskId: TASK_ID,
    sessionId: SESSION,
    tool: "exec.run",
    target: "repo-a",
    permissionAtRequest: "default",
    contentVersion: "v1",
    status: "pending",
    executed: false,
    operation: "pnpm test",
    ...overrides,
  };
}

describe("ticket 140 审批读数解析", () => {
  it("解析本任务的确认记录并保留真实际命令与会话身份", () => {
    const approvals = parseTaskApprovals({ approvals: [row()] }, TASK_ID, SESSION);
    expect(approvals).not.toBeNull();
    expect(approvals![0]).toMatchObject({
      approvalId: "approval-1",
      sessionId: SESSION,
      tool: "exec.run",
      target: "repo-a",
      operation: "pnpm test",
      payloadVersion: "v1",
      status: "pending",
      executed: false,
      foreign: false,
    });
  });

  it("读数不可用返回 null，而不是空列表：读取失败不能被渲染成没有待确认", () => {
    expect(parseTaskApprovals(undefined, TASK_ID, SESSION)).toBeNull();
    expect(parseTaskApprovals({}, TASK_ID, SESSION)).toBeNull();
    expect(parseTaskApprovals({ approvals: "none" }, TASK_ID, SESSION)).toBeNull();
    expect(parseTaskApprovals({ approvals: [] }, TASK_ID, SESSION)).toEqual([]);
  });

  it("任务身份不符或字段缺失时整条读数不可解析，不猜一条记录", () => {
    expect(parseTaskApprovals({ approvals: [row({ taskId: "task-b" })] }, TASK_ID, SESSION)).toBeNull();
    expect(parseTaskApprovals({ approvals: [row({ status: "unknown" })] }, TASK_ID, SESSION)).toBeNull();
    expect(parseTaskApprovals({ approvals: [row({ executed: "false" })] }, TASK_ID, SESSION)).toBeNull();
    expect(parseTaskApprovals({ approvals: [row({ id: "" })] }, TASK_ID, SESSION)).toBeNull();
    expect(parseTaskApprovals({ approvals: [row({ operation: undefined })] }, TASK_ID, SESSION)).toMatchObject([
      { operation: null },
    ]);
  });

  it("其他会话的记录被标记为 foreign，本页不代为确认", () => {
    const approvals = parseTaskApprovals({ approvals: [row({ sessionId: "s-other" })] }, TASK_ID, SESSION);
    expect(approvals![0].foreign).toBe(true);
    expect(approvalRefusal(approvals![0])).toContain("s-other");
  });
});

describe("ticket 140 一次决定只发两个键", () => {
  const pending: TaskApproval = parseTaskApprovals({ approvals: [row()] }, TASK_ID, SESSION)![0];

  it("批准发 task/approve，拒绝发 task/reject，载荷恰好是 sessionId/approvalId", () => {
    const approve = approvalRequest(pending, "approved");
    expect(approve.op).toBe("task/approve");
    expect(Object.keys(approve.payload).sort()).toEqual(["approvalId", "sessionId"]);
    expect(approve.payload).toEqual({ sessionId: SESSION, approvalId: "approval-1" });
    expect(approvalRequest(pending, "rejected").op).toBe("task/reject");
  });

  it("已过期/已拒绝/已批准/其他会话的确认都有具名拒绝原因", () => {
    expect(approvalRefusal(pending)).toBeNull();
    expect(approvalRefusal({ ...pending, status: "expired" })).toContain("过期");
    expect(approvalRefusal({ ...pending, status: "rejected" })).toContain("拒绝");
    expect(approvalRefusal({ ...pending, status: "approved", executed: true })).toContain("不能重复执行");
    expect(approvalRefusal({ ...pending, status: "approved", executed: false })).toContain("未结算");
  });

  it("Host 的拒绝文本原样保留并翻成可行动的一句", () => {
    expect(approvalFailureText("确认请求不存在")).toContain("不存在");
    expect(approvalFailureText("invalid-execution-transition: 确认请求已过期，不能执行且不可重放")).toContain("不可重放");
    expect(approvalFailureText(undefined)).toContain("Host 未说明原因");
    expect(approvalFailureText("blocked-other")).toBe("Host 拒绝：blocked-other");
  });
});

describe("ticket 140 状态与影响文本不夸大", () => {
  it("已批准不等于已执行", () => {
    const pending: TaskApproval = parseTaskApprovals({ approvals: [row()] }, TASK_ID, SESSION)![0];
    expect(approvalStatusText(pending)).toBe("待批准");
    expect(approvalStatusText({ ...pending, status: "approved", executed: false })).toBe("已批准 · 未结算");
    expect(approvalStatusText({ ...pending, status: "approved", executed: true })).toBe("已批准 · 已执行");
    expect(approvalStatusText({ ...pending, status: "expired" })).toBe("已过期（未执行）");
  });

  it("影响文本写明一次性授权、共享原目录真实影响与 ticket 141 前的跨任务边界", () => {
    expect(APPROVAL_IMPACT_TEXT).toContain("仅授权这一次");
    expect(SHARED_ROOT_IMPACT_TEXT).toContain("不是副本");
    expect(SHARED_ROOT_IMPACT_TEXT).toContain("ticket 141");
  });

  it("工具名有中文标签，未知工具名不被改写", () => {
    expect(approvalToolLabel("exec.run")).toBe("运行命令");
    expect(approvalToolLabel("mcp.thing")).toBe("mcp.thing");
  });
});
