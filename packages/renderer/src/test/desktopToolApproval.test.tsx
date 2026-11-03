import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopConversation } from "../components/DesktopConversation";
import type { PidockBridge } from "../data/shellBridge";

/**
 * [Pencil T05] #140 生产对话页的审批卡。
 *
 * 事实来源只有 Host：`task/listApprovals` 读本会话真实持久化的确认记录，
 * `task/approve` / `task/reject` 是唯一的两个决定。这里把四件事钉住：
 *
 *  - 卡片显示的是 Host 记录的内容（工具、目标、真实际命令、载荷版本、会话）；
 *  - 批准/拒绝发的 op 与载荷键**精确**（`{sessionId, approvalId}`），不夹带字段；
 *  - 批准后重读记录，界面不自己写「已执行」；
 *  - 读取失败、过期、其他会话、Host 拒绝都各是具名状态，没有一个被渲染成成功。
 */

const TASK_ID = "task-a";
const roots = [{ label: "默认任务根", state: "ready" }];
const association = { taskId: TASK_ID, projectId: null, state: "unassigned" };
const emptySnapshot = { source: "sdk-jsonl", sessionId: "main", messages: [], pending: false, interrupted: false };

type HostRead = { ok: boolean; payload?: unknown; error?: string };

function approvalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "approval-1",
    callId: "call-1",
    taskId: TASK_ID,
    sessionId: "main",
    tool: "exec.run",
    target: "repo-a",
    permissionAtRequest: "default",
    contentVersion: "v3",
    status: "pending",
    executed: false,
    operation: "pnpm test",
    ...overrides,
  };
}

const IDLE_EXECUTION = { state: { session: "pending-approval", services: [], executions: [] } };

function setup(options: {
  approvals?: () => HostRead;
  resolve?: (op: string, payload: Record<string, unknown>) => HostRead;
} = {}) {
  const taskOp = vi.fn(async (_taskId: string, op: string, payload: Record<string, unknown> = {}) => {
    if (op === "task/executionState") return { ok: true as const, payload: IDLE_EXECUTION };
    if (op === "task/listApprovals") return (options.approvals ?? (() => ({ ok: true, payload: { approvals: [] } })))();
    if (op === "task/approve" || op === "task/reject") {
      return (options.resolve ?? (() => ({ ok: true, payload: {} })))(op, payload);
    }
    if (op === "task/sessionContext") return { ok: false as const, error: "session-context-not-wired" };
    if (op === "task/sessionList") return {
      ok: true as const,
      payload: {
        activeSessionId: "main",
        sessions: [{ id: "main", name: "主会话", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", archived: false, permission: "default", binding: null }],
        provider: null,
      },
    };
    if (op === "task/sessionReadout") return {
      ok: true as const,
      payload: {
        session: { id: "main", name: "主会话", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", archived: false, permission: "default", binding: null },
        active: true, model: null, reasoningLevels: [], context: { used: null, window: null, source: "unknown" }, usage: null, turns: 0, transcriptModel: null, pending: false, interrupted: false,
      },
    };
    return { ok: false as const, error: `unexpected ${op}` };
  });
  const bridge: PidockBridge = {
    listTasks: vi.fn(async () => ({ ok: true, payload: { tasks: [{ taskId: TASK_ID, name: "Task", branch: "task/main", repoCount: 1, updatedAt: "now" }], roots } })),
    projectOp: vi.fn(async (request: { op: string }) => ({ ok: true, payload: request.op === "list" ? { initialized: true, projects: [] } : { roots, tasks: [association] } })),
    providerOp: vi.fn(async () => ({ ok: true, payload: { state: "not-configured", profileId: null, generation: null, profiles: [] } })),
    onSdkTurnEvent: vi.fn(() => () => {}),
    sdkTurn: vi.fn(async (request: Record<string, unknown>) => {
      if (request["action"] === "subscribe") return { ok: true, payload: { taskId: TASK_ID, sessionId: "main", snapshot: emptySnapshot, turn: null } };
      if (request["action"] === "projection") return { ok: true, payload: emptySnapshot };
      if (request["action"] === "status") return { ok: true, payload: { turn: null } };
      return { ok: true, payload: { unsubscribed: true } };
    }),
    taskOp,
  };
  window.pidock = bridge;
  const calls = () => taskOp.mock.calls.map((entry) => ({ op: entry[1] as string, payload: entry[2] as Record<string, unknown> }));
  return { taskOp, calls };
}

function mount() {
  return render(
    <DesktopConversation
      taskId={TASK_ID}
      name="Task"
      branch="task/main"
      repoCount={1}
      roots={JSON.stringify(roots)}
      association={JSON.stringify(association)}
      onBack={vi.fn()}
      onOpenProviders={vi.fn()}
      onArchived={vi.fn()}
    />,
  );
}

afterEach(() => { cleanup(); localStorage.clear(); delete window.pidock; vi.restoreAllMocks(); });

describe("#140 会话内审批卡", () => {
  it("显示 Host 记录的工具、目标、真实际命令、载荷版本与会话", async () => {
    setup({ approvals: () => ({ ok: true, payload: { approvals: [approvalRow()] } }) });
    mount();
    expect(await screen.findByTestId("desktop-approval-approval-1")).toHaveTextContent("待批准：运行命令");
    expect(screen.getByTestId("desktop-approval-target")).toHaveTextContent("repo-a");
    expect(screen.getByTestId("desktop-approval-operation")).toHaveTextContent("pnpm test");
    expect(screen.getByTestId("desktop-approval-version")).toHaveTextContent("v3");
    expect(screen.getByTestId("desktop-approval-session")).toHaveTextContent("main");
    // 影响与边界必须写出来：一次性授权、共享原目录真实影响、#141 之前的跨任务边界。
    expect(screen.getByTestId("desktop-approval-impact")).toHaveTextContent("仅授权这一次");
    expect(screen.getByTestId("desktop-approval-shared")).toHaveTextContent("#141");
    expect(screen.getByTestId("desktop-approval-expiry")).toHaveTextContent("有效期由 Host 判定");
    expect(screen.getByTestId("desktop-approval-approve")).toBeTruthy();
  });

  it("批准只发 task/approve + {sessionId, approvalId}，之后重读记录而非自称已执行", async () => {
    let status = "pending";
    const { calls } = setup({
      approvals: () => ({ ok: true, payload: { approvals: [approvalRow({ status, executed: status === "approved" })] } }),
      resolve: () => { status = "approved"; return { ok: true, payload: {} }; },
    });
    mount();
    fireEvent.click(await screen.findByTestId("desktop-approval-approve"));
    await waitFor(() => expect(screen.getByTestId("desktop-approval-outcome")).toHaveTextContent("已批准"));
    const approveCalls = calls().filter((entry) => entry.op === "task/approve");
    expect(approveCalls).toHaveLength(1);
    expect(Object.keys(approveCalls[0].payload).sort()).toEqual(["approvalId", "sessionId"]);
    expect(approveCalls[0].payload).toEqual({ sessionId: "main", approvalId: "approval-1" });
    // 批准后重新读了确认记录与执行读数：状态来自 Host，不来自本页。
    expect(calls().filter((entry) => entry.op === "task/listApprovals").length).toBeGreaterThanOrEqual(2);
    await waitFor(() => expect(screen.getByTestId("desktop-approval-settled-approval-1")).toHaveTextContent("已执行"));
    expect(screen.queryByTestId("desktop-approval-approve")).toBeNull();
  });

  it("拒绝发 task/reject，并把拒绝原因标为本页记录", async () => {
    const { calls } = setup({
      approvals: () => ({ ok: true, payload: { approvals: [approvalRow()] } }),
      resolve: () => ({ ok: true, payload: {} }),
    });
    mount();
    fireEvent.change(await screen.findByLabelText("拒绝原因"), { target: { value: "目标不对" } });
    fireEvent.click(screen.getByTestId("desktop-approval-deny"));
    await waitFor(() => expect(screen.getByTestId("desktop-approval-outcome")).toHaveTextContent("已拒绝"));
    expect(screen.getByTestId("desktop-approval-outcome")).toHaveTextContent("本页记录的拒绝原因：目标不对");
    const rejectCalls = calls().filter((entry) => entry.op === "task/reject");
    expect(rejectCalls).toHaveLength(1);
    expect(rejectCalls[0].payload).toEqual({ sessionId: "main", approvalId: "approval-1" });
    // 原因不随请求下发（Host 的确认记录没有原因字段），不伪造已提交。
    expect(calls().some((entry) => Object.keys(entry.payload).includes("reason"))).toBe(false);
  });

  it("Host 拒绝时保留原因为具名失败，不显示成功", async () => {
    setup({
      approvals: () => ({ ok: true, payload: { approvals: [approvalRow()] } }),
      resolve: () => ({ ok: false, error: "invalid-execution-transition: 确认请求已过期，不能执行且不可重放" }),
    });
    mount();
    fireEvent.click(await screen.findByTestId("desktop-approval-approve"));
    expect(await screen.findByTestId("desktop-approval-failure")).toHaveTextContent("不可重放");
    expect(screen.queryByTestId("desktop-approval-outcome")).toBeNull();
    // 失败后仍可让读者看到这条确认，而不是悄悄消失。
    expect(screen.getByTestId("desktop-approval-approval-1")).toBeTruthy();
  });

  it("过期与其他会话的确认只列在已结算行，没有可点的批准", async () => {
    setup({
      approvals: () => ({
        ok: true,
        payload: { approvals: [approvalRow({ id: "approval-old", status: "expired" }), approvalRow({ id: "approval-other", sessionId: "s-other" })] },
      }),
    });
    mount();
    expect(await screen.findByTestId("desktop-approval-settled-approval-old")).toHaveTextContent("已过期（未执行）");
    expect(screen.getByTestId("desktop-approval-settled-approval-other")).toHaveTextContent("其他会话的确认，本页不代确认");
    expect(screen.queryByTestId("desktop-approval-approve")).toBeNull();
    expect(screen.queryByTestId("desktop-approval-approval-1")).toBeNull();
  });

  it("确认记录读取失败具名报错，不渲染「无待确认」也不给批准入口", async () => {
    setup({ approvals: () => ({ ok: false, error: "task-host-closed" }) });
    mount();
    expect(await screen.findByTestId("desktop-approval-error")).toHaveTextContent("task-host-closed");
    expect(screen.queryByTestId("desktop-approval-empty")).toBeNull();
    expect(screen.queryByTestId("desktop-approval-approve")).toBeNull();
  });

  it("没有待确认时说明记录为空（这是 Host 的空读数，不是失败）", async () => {
    setup({ approvals: () => ({ ok: true, payload: { approvals: [] } }) });
    mount();
    expect(await screen.findByTestId("desktop-approval-empty")).toHaveTextContent("本会话没有待确认的工具操作");
    expect(screen.queryByTestId("desktop-approval-error")).toBeNull();
  });
});
