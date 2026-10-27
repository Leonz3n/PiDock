import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopConversation } from "../components/DesktopConversation";
import type { PidockBridge } from "../data/shellBridge";

/**
 * #24 the desktop task page's 会话执行状态 card.
 *
 * The Host already answers one session's execution readout
 * (`task/executionState`, `shell/src/host/host.ts:2249`) and the web task page
 * renders it (`pages/TaskPage.tsx` `RunStateCard`, `pages/executionView.ts`).
 * The desktop route — the one a reader actually works in — only offered the stop
 * button, so the same facts must appear there: the Host's own state and the
 * detail it recorded, with the SAME view model (no second copy of the mapping)
 * and no second stop entry.
 *
 * Honesty rules pinned here:
 *  - a refused read names the failure and the Host's own text; it never renders
 *    as 空闲 or 正常;
 *  - a readout the Host leaves empty is named 未上报, not filled in;
 *  - the card adds no write op and no timer: one read on mount plus one per
 *    attempt-phase transition the page already observes.
 */

const TASK_ID = "task-a";
const roots = [{ label: "默认任务根", state: "ready" }];
const association = { taskId: TASK_ID, projectId: null, state: "unassigned" };
const emptySnapshot = { source: "sdk-jsonl", sessionId: "main", messages: [], pending: false, interrupted: false };

type HostRead = { ok: boolean; payload?: unknown; error?: string };

/** One `task/executionState` readout (`ExecutionStateReadout`), newest execution first. */
function hostExecution(session: string | null = "executing", detail: Record<string, unknown> = {}) {
  const executions = session === null ? [] : [{
    executionId: "exec-1",
    taskId: TASK_ID,
    sessionId: "main",
    kind: "turn",
    label: "SDK 回合",
    state: session,
    version: 1,
    startedAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:00:01.000Z",
    steps: [
      { stepId: "s1", label: "读取任务", state: "done" },
      { stepId: "s2", label: "写入文件", state: "pending" },
    ],
    attempts: [],
    draftKept: true,
    ...detail,
  }];
  return { state: { session, services: [], executions } };
}

function setup(read: () => HostRead) {
  let status: unknown = null;
  const sdkCalls: Array<Record<string, unknown>> = [];
  const taskOp = vi.fn(async (_taskId: string, op: string) => {
    if (op === "task/executionState") return read();
    if (op === "task/sessionContext") return { ok: false as const, error: "session-context-not-wired" };
    return { ok: false as const, error: `unexpected ${op}` };
  });
  const bridge: PidockBridge = {
    listTasks: vi.fn(async () => ({ ok: true, payload: { tasks: [{ taskId: TASK_ID, name: "Task", branch: "task/main", repoCount: 1, updatedAt: "now" }], roots } })),
    projectOp: vi.fn(async (request: { op: string }) => ({ ok: true, payload: request.op === "list" ? { initialized: true, projects: [] } : { roots, tasks: [association] } })),
    providerOp: vi.fn(async () => ({ ok: true, payload: { state: "not-configured", profileId: null, generation: null, profiles: [] } })),
    onSdkTurnEvent: vi.fn(() => () => {}),
    sdkTurn: vi.fn(async (request: Record<string, unknown>) => {
      sdkCalls.push(request);
      if (request["action"] === "subscribe") return { ok: true, payload: { taskId: TASK_ID, sessionId: "main", snapshot: emptySnapshot, turn: status } };
      if (request["action"] === "projection") return { ok: true, payload: emptySnapshot };
      if (request["action"] === "status") return { ok: true, payload: { turn: status } };
      if (request["action"] === "start") {
        status = { taskId: TASK_ID, sessionId: "main", requestId: String(request["requestId"]), turnId: String(request["requestId"]), state: "accepted", needsResync: false };
        return { ok: true, payload: { turn: status } };
      }
      if (request["action"] === "cancel") {
        status = { ...(status as object), state: "cancelled" };
        return { ok: true, payload: { turn: status } };
      }
      return { ok: true, payload: { unsubscribed: true } };
    }),
    taskOp,
  };
  window.pidock = bridge;
  return { taskOp, sdkCalls };
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

const send = async (text: string) => {
  fireEvent.change(screen.getByRole("textbox", { name: "消息" }), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
};

afterEach(() => { cleanup(); localStorage.clear(); delete window.pidock; vi.restoreAllMocks(); });

describe("#24 desktop task page execution state", () => {
  it("shows the Host's execution state and the detail it recorded", async () => {
    const fixture = setup(() => ({ ok: true, payload: hostExecution() }));
    mount();
    expect(await screen.findByTestId("desktop-execution-state")).toHaveTextContent("执行状态 · 执行中");
    expect(screen.getByTestId("desktop-execution-summary")).toHaveTextContent("SDK 回合");
    const steps = screen.getByTestId("desktop-execution-steps");
    expect(steps).toHaveTextContent("读取任务");
    expect(steps).toHaveTextContent("完成");
    expect(steps).toHaveTextContent("写入文件");
    expect(steps).toHaveTextContent("等待");
    expect(fixture.taskOp).toHaveBeenCalledWith(TASK_ID, "task/executionState", { sessionId: "main" });
    cleanup();

    // The label is the Host's own state mapped through the existing view model,
    // not a fixed word: the same card reads 等待确认 for `pending-approval`.
    setup(() => ({ ok: true, payload: hostExecution("pending-approval") }));
    mount();
    expect(await screen.findByTestId("desktop-execution-state")).toHaveTextContent("执行状态 · 等待确认");
  });

  it("names a failed execution-state read instead of rendering 空闲 or 正常", async () => {
    setup(() => ({ ok: false, error: "execution-ledger-unavailable" }));
    mount();
    expect(await screen.findByTestId("desktop-execution-error")).toHaveTextContent("执行状态读取失败：execution-ledger-unavailable");
    const card = screen.getByTestId("desktop-execution-card");
    expect(card).not.toHaveTextContent("空闲");
    expect(card).not.toHaveTextContent("正常");
    expect(screen.queryByTestId("desktop-execution-state")).not.toBeInTheDocument();
  });

  it("names an unreported execution state instead of filling it in", async () => {
    setup(() => ({ ok: true, payload: hostExecution(null) }));
    mount();
    expect(await screen.findByTestId("desktop-execution-unreported")).toHaveTextContent("Host 未上报执行状态");
    expect(screen.getByTestId("desktop-execution-card")).not.toHaveTextContent("空闲");
    expect(screen.queryByTestId("desktop-execution-state")).not.toBeInTheDocument();
  });

  it("keeps the Host's own text when the readout cannot be parsed", async () => {
    setup(() => ({ ok: true, payload: { state: { session: "not-a-state", services: [], executions: [] } } }));
    mount();
    expect(await screen.findByTestId("desktop-execution-error")).toHaveTextContent("执行状态读取失败");
    expect(screen.getByTestId("desktop-execution-error")).toHaveTextContent("not-a-state");
  });

  it("issues only the read op, bounds its reads by attempt-phase transitions and keeps the existing stop button", async () => {
    const fixture = setup(() => ({ ok: true, payload: hostExecution() }));
    mount();
    await screen.findByTestId("desktop-execution-state");
    const reads = () => fixture.taskOp.mock.calls.map(([, op]) => String(op)).filter((op) => op === "task/executionState");
    // One read on mount, plus at most one per phase this page observed
    // (starting → accepted). No timer: nothing else can add a read.
    await send("hello");
    await screen.findByRole("button", { name: "停止" });
    const duringTurn = reads().length;
    expect(duringTurn).toBeGreaterThanOrEqual(1);
    expect(duringTurn).toBeLessThanOrEqual(3);
    // The card adds no stop entry of its own: the composer's one button stays.
    expect(screen.getAllByRole("button", { name: "停止" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(await screen.findByText(/已取消/)).toBeInTheDocument();
    expect(fixture.sdkCalls.some((call) => call["action"] === "cancel")).toBe(true);
    // The terminal phase is the one event that adds a read, and it adds exactly
    // one: the count is bounded by the page's own transitions.
    await waitFor(() => expect(reads().length).toBeGreaterThan(duringTurn));
    expect(reads().length).toBe(duringTurn + 1);
    const ops = fixture.taskOp.mock.calls.map(([, op]) => String(op));
    expect(ops.every((op) => op === "task/executionState" || op === "task/sessionContext")).toBe(true);
  });
});
