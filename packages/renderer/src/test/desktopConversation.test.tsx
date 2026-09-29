import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { DesktopConversation } from "../components/DesktopConversation";
import type { PidockBridge } from "../data/shellBridge";

const roots = [{ label: "默认任务根", state: "ready" }];
const association = (id: string) => ({ taskId: id, projectId: null, state: "unassigned" });
const snapshot = (messages: unknown[] = [], pending = false) => ({ source: "sdk-jsonl", sessionId: "main", messages, pending, interrupted: false });
const turn = (taskId: string, requestId: string, state = "accepted") => ({ taskId, sessionId: "main", requestId, turnId: requestId, state, needsResync: false });
function setup(taskId = "task-a") {
  let listener: ((event: unknown) => void) | undefined;
  let status: unknown = null;
  let messages: unknown[] = [];
  let fail = "";
  let unreadable = false;
  let associationState = "unassigned";
  const calls: Array<Record<string, unknown>> = [];
  const bridge: PidockBridge = {
    listTasks: vi.fn(async () => unreadable ? { ok: false, error: "root unreadable" } : { ok: true, payload: { tasks: [{ taskId, name: "Task", branch: "main", repoCount: 0, updatedAt: "now" }], roots } }),
    projectOp: vi.fn(async (request) => ({ ok: true, payload: request.op === "list" ? { initialized: true, projects: [] } : { roots, tasks: [{ ...association(taskId), state: associationState }] } })),
    onSdkTurnEvent: vi.fn((callback) => { listener = callback; return () => { listener = undefined; }; }),
    // Production always serves this channel; the panel must show a real state,
    // not an error, in the ordinary unconfigured case.
    providerOp: vi.fn(async () => ({ ok: true, payload: { state: "not-configured", profileId: null, generation: null, profiles: [] } })),
    sdkTurn: vi.fn(async (request) => {
      calls.push(request);
      if (request.action === "subscribe") return { ok: true, payload: { taskId, sessionId: "main", snapshot: snapshot(messages), turn: status } };
      if (request.action === "projection") return { ok: true, payload: snapshot(messages) };
      if (request.action === "status") return { ok: true, payload: { turn: status } };
      if (request.action === "start") {
        if (fail === "lost") throw new Error("invoke timeout");
        if (fail) return { ok: false, error: fail };
        status = turn(taskId, String(request.requestId));
        return { ok: true, payload: { turn: status } };
      }
      if (request.action === "cancel") { status = { ...(status as object), state: "cancelled" }; return { ok: true, payload: { turn: status } }; }
      return { ok: true, payload: { unsubscribed: true } };
    }),
  };
  return { bridge, calls, emit: (value: unknown) => listener?.(value), setStatus: (value: unknown) => { status = value; }, setMessages: (value: unknown[]) => { messages = value; }, setFail: (value: string) => { fail = value; }, invalidate: () => { associationState = "unavailable"; }, unreadable: () => { unreadable = true; }, subscribed: () => Boolean(listener) };
}
function mount(fixture: ReturnType<typeof setup>, taskId = "task-a") {
  window.pidock = fixture.bridge;
  return render(<DesktopConversation taskId={taskId} name="Task" roots={JSON.stringify(roots)} association={JSON.stringify(association(taskId))} onBack={vi.fn()} onOpenProviders={vi.fn()} onArchived={vi.fn()} />);
}
const send = async (text: string) => {
  fireEvent.change(screen.getByRole("textbox", { name: "消息" }), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
};
afterEach(() => { cleanup(); localStorage.clear(); delete window.pidock; vi.restoreAllMocks(); });

describe("Desktop SDK conversation", () => {
  it("does not allow projection refresh before SDK subscription is ready", async () => {
    const f = setup();
    mount(f);
    expect(screen.getByRole("button", { name: "核验" })).toBeDisabled();
    await screen.findByText(/尚未开始/);
    expect(screen.getByRole("button", { name: "核验" })).not.toBeDisabled();
  });

  it("archives only after confirmation and a verified Host result", async () => {
    const f = setup();
    const taskOp = vi.fn(async (taskId: string, op: string) => ({ ok: true, payload: { lifecycle: { taskId, archived: op === "task/archive", archivedAt: "2026-09-29T09:00:00Z" } } }));
    f.bridge.taskOp = taskOp;
    window.pidock = f.bridge;
    const onArchived = vi.fn();
    render(<DesktopConversation taskId="task-a" name="Task" roots={JSON.stringify(roots)} association={JSON.stringify(association("task-a"))} onBack={vi.fn()} onOpenProviders={vi.fn()} onArchived={onArchived} />);
    await screen.findByText(/尚未开始/);
    fireEvent.click(screen.getByRole("button", { name: "任务操作" }));
    fireEvent.click(screen.getByRole("button", { name: "归档当前任务" }));
    expect(screen.getByRole("dialog", { name: "归档当前任务" })).toBeInTheDocument();
    expect(taskOp).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认归档" }));
    await waitFor(() => expect(onArchived).toHaveBeenCalledOnce());
    expect(taskOp).toHaveBeenCalledWith("task-a", "task/archive", {});
    expect(f.calls.some((call) => call.action === "projection")).toBe(true);
  });

  it("blocks archive during an active SDK turn", async () => {
    const f = setup();
    const taskOp = vi.fn(async () => ({ ok: false, error: "task-locked" }));
    f.bridge.taskOp = taskOp;
    mount(f);
    await screen.findByText(/尚未开始/);
    await send("active");
    await screen.findByRole("button", { name: "停止" });
    fireEvent.click(screen.getByRole("button", { name: "任务操作" }));
    fireEvent.click(screen.getByRole("button", { name: "归档当前任务" }));
    expect(screen.getByRole("button", { name: "确认归档" })).toBeDisabled();
    expect(screen.getByText(/会话尚未连接、正在执行或请求状态未核验/)).toBeInTheDocument();
    expect(taskOp).not.toHaveBeenCalled();
  });

  it("freezes after a refused Host archive write and offers a status check", async () => {
    const f = setup();
    const taskOp = vi.fn(async () => ({ ok: false, error: "task-locked" }));
    f.bridge.taskOp = taskOp;
    mount(f);
    await screen.findByText(/尚未开始/);
    fireEvent.click(screen.getByRole("button", { name: "任务操作" }));
    fireEvent.click(screen.getByRole("button", { name: "归档当前任务" }));
    fireEvent.click(screen.getByRole("button", { name: "确认归档" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("task-locked");
    expect(screen.getByRole("button", { name: "查看归档状态" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("subscribes before sending, refuses unconfigured provider without a fabricated reply and retains draft", async () => {
    const f = setup(); f.setFail("provider-not-configured"); mount(f);
    await screen.findByText(/尚未开始/);
    await send("hello");
    expect(await screen.findByText(/无法发送：provider-not-configured/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("hello");
    expect(screen.queryByText("Agent")).not.toBeInTheDocument();
    expect(f.calls.findIndex((call) => call.action === "subscribe")).toBeLessThan(f.calls.findIndex((call) => call.action === "start"));
  });

  it("holds an unknown ACK and retries the exact request ID and original text after null status", async () => {
    const f = setup(); f.setFail("lost"); mount(f);
    await screen.findByText(/尚未开始/); await send("original");
    await screen.findByText(/请求结果未知/);
    const first = f.calls.find((call) => call.action === "start")!;
    fireEvent.change(screen.getByRole("textbox", { name: "消息" }), { target: { value: "edited" } });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "查询原请求" }));
    await screen.findByText(/请求状态未知/);
    f.setFail(""); fireEvent.click(screen.getByRole("button", { name: "按原 ID 重试" }));
    await waitFor(() => expect(f.calls.filter((call) => call.action === "start")).toHaveLength(2));
    expect(f.calls.filter((call) => call.action === "start")[1]).toMatchObject({ requestId: first.requestId, text: "original" });
  });

  it("replaces transient output with confirmed SDK projection on terminal and cancels only its own turn", async () => {
    const f = setup(); mount(f); await screen.findByText(/尚未开始/); await send("hello");
    await waitFor(() => expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument());
    const requestId = String(f.calls.find((call) => call.action === "start")?.requestId);
    act(() => {
      f.emit({ kind: "sdk-turn-event", event: { taskId: "other", sessionId: "main", turnId: turn("task-a", requestId).turnId, sequence: 1, type: "delta", text: "wrong" } });
      f.emit({ kind: "sdk-turn-event", event: { taskId: "task-a", sessionId: "main", turnId: turn("task-a", requestId).turnId, sequence: 1, type: "delta", text: "partial" } });
    });
    expect(await screen.findByText("partial")).toBeInTheDocument();
    f.setMessages([{ role: "user", text: "hello", usage: null }, { role: "assistant", text: "confirmed", usage: { input: 4, output: 2, cacheRead: 1, cacheWrite: 0 } }]);
    f.setStatus(turn("task-a", requestId, "done"));
    act(() => {
      f.emit({ kind: "sdk-turn-status", turn: turn("task-a", requestId, "done") });
      f.emit({ kind: "sdk-turn-status", turn: turn("task-a", requestId, "done") });
    });
    expect(await screen.findByText("confirmed")).toBeInTheDocument();
    expect(screen.queryByText("partial")).not.toBeInTheDocument();
    expect(screen.getByText(/SDK 用量/)).toHaveTextContent("输出 2");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await send("wait");
    await waitFor(() => expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument());
    const secondRequestId = String(f.calls.filter((call) => call.action === "start")[1]?.requestId);
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => expect(f.calls.some((call) => call.action === "cancel" && call.turnId === turn("task-a", secondRequestId).turnId)).toBe(true));
    expect(await screen.findByText(/已取消/)).toBeInTheDocument();
  });

  it("drops late events on switch, reconnects with projection, and freezes after changed association", async () => {
    const a = setup("task-a"); const view = mount(a);
    await screen.findByText(/尚未开始/);
    view.unmount(); expect(a.subscribed()).toBe(false);
    const b = setup("task-b"); window.pidock = b.bridge;
    render(<DesktopConversation taskId="task-b" name="B" roots={JSON.stringify(roots)} association={JSON.stringify(association("task-b"))} onBack={vi.fn()} onOpenProviders={vi.fn()} onArchived={vi.fn()} />);
    await screen.findByText(/尚未开始/);
    a.emit({ kind: "sdk-turn-event", event: { taskId: "task-a", sessionId: "main", turnId: "old", sequence: 1, type: "delta", text: "old" } });
    expect(screen.queryByText("old")).not.toBeInTheDocument();
    b.setMessages([{ role: "assistant", text: "recovered", usage: null }]);
    fireEvent.click(screen.getByRole("button", { name: "核验" }));
    expect(await screen.findByText("recovered")).toBeInTheDocument();
    b.invalidate(); await send("blocked");
    expect(await screen.findByText(/任务或任务根已变化/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(b.calls.filter((call) => call.action === "start")).toHaveLength(0);
  });

  it("cold reopens exact SDK history and resyncs a sequence gap without appending a reply", async () => {
    const f = setup();
    f.setMessages([{ role: "user", text: "earlier", usage: null }, { role: "assistant", text: "stored", usage: null }]);
    const view = mount(f);
    expect(await screen.findByText("stored")).toBeInTheDocument();
    expect(f.calls.find((call) => call.action === "subscribe")).toMatchObject({ taskId: "task-a", sessionId: "main" });
    await send("now");
    await waitFor(() => expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument());
    const requestId = String(f.calls.find((call) => call.action === "start")?.requestId);
    act(() => f.emit({ kind: "sdk-turn-event", event: { taskId: "task-a", sessionId: "main", turnId: turn("task-a", requestId).turnId, sequence: 2, type: "delta", text: "unverified" } }));
    await waitFor(() => expect(f.calls.some((call) => call.action === "projection")).toBe(true));
    expect(screen.queryByText("unverified")).not.toBeInTheDocument();
    view.unmount();
    mount(f);
    expect(await screen.findByText("stored")).toBeInTheDocument();
    expect(screen.queryByText("unverified")).not.toBeInTheDocument();
  });

  it("restores the exact unresolved ID and original text after a renderer restart, scoped to its task", async () => {
    const a = setup("task-a"); a.setFail("lost"); const view = mount(a);
    await screen.findByText(/尚未开始/); await send("must remain exact");
    await screen.findByText(/请求结果未知/);
    const first = a.calls.find((call) => call.action === "start")!;
    view.unmount();
    const other = setup("task-b"); mount(other, "task-b");
    await screen.findByText(/尚未开始/);
    expect(other.calls.find((call) => call.action === "subscribe")).toEqual({ action: "subscribe", taskId: "task-b", sessionId: "main" });
    cleanup();
    a.setFail(""); mount(a);
    expect(await screen.findByText(/请求状态未知/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("must remain exact");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "按原 ID 重试" }));
    await waitFor(() => expect(a.calls.filter((call) => call.action === "start")).toHaveLength(2));
    expect(a.calls.filter((call) => call.action === "start")[1]).toMatchObject({ requestId: first.requestId, text: "must remain exact" });
    a.setStatus(turn("task-a", String(first.requestId), "done"));
    act(() => a.emit({ kind: "sdk-turn-status", turn: turn("task-a", String(first.requestId), "done") }));
    await waitFor(() => expect(localStorage.getItem("pidock-sdk-main-pending-v1:task-a")).toBeNull());
  });

  it("ignores a delayed old reconciliation after a newer request starts", async () => {
    const f = setup();
    const sdkTurn = f.bridge.sdkTurn!;
    let unblock: ((value: { ok: boolean; payload: { turn: unknown } }) => void) | undefined;
    let firstId = "";
    let oldReads = 0;
    f.bridge.sdkTurn = async (request) => {
      if (request.action === "status" && request.requestId === firstId && ++oldReads === 2) {
        return new Promise((resolve) => { unblock = resolve; });
      }
      return sdkTurn(request);
    };
    mount(f); await screen.findByText(/尚未开始/); await send("first");
    await screen.findByRole("button", { name: "停止" });
    firstId = String(f.calls.find((call) => call.action === "start")?.requestId);
    f.setStatus(turn("task-a", firstId, "done"));
    act(() => {
      f.emit({ kind: "sdk-turn-status", turn: turn("task-a", firstId, "done") });
      f.emit({ kind: "sdk-turn-status", turn: turn("task-a", firstId, "done") });
    });
    await waitFor(() => expect(unblock).toBeDefined());
    await screen.findByText(/已从 SDK 历史核验/);
    await send("second");
    await screen.findByRole("button", { name: "停止" });
    const nextId = String(f.calls.filter((call) => call.action === "start")[1]?.requestId);
    expect(nextId).not.toBe(firstId);
    await act(async () => { unblock!({ ok: true, payload: { turn: turn("task-a", firstId, "done") } }); });
    expect(localStorage.getItem("pidock-sdk-main-pending-v1:task-a")).toContain(nextId);
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => expect(f.calls.filter((call) => call.action === "cancel")).toHaveLength(1));
    expect(f.calls.filter((call) => call.action === "cancel")[0]).toMatchObject({ turnId: turn("task-a", nextId).turnId });
    expect(f.calls.filter((call) => call.action === "cancel")[0]?.turnId).not.toBe(turn("task-a", firstId).turnId);
  });

  it("reopens an escaped but valid pending prompt with its original request ID", async () => {
    const f = setup(); f.setFail("lost");
    const view = mount(f); await screen.findByText(/尚未开始/);
    const text = "\\".repeat(10000);
    await send(text); await screen.findByText(/请求结果未知/);
    const first = f.calls.find((call) => call.action === "start")!;
    expect(localStorage.getItem("pidock-sdk-main-pending-v1:task-a")!.length).toBeGreaterThan(18000);
    view.unmount(); f.setFail(""); mount(f);
    await screen.findByText(/请求状态未知/);
    fireEvent.click(screen.getByRole("button", { name: "按原 ID 重试" }));
    await waitFor(() => expect(f.calls.filter((call) => call.action === "start")).toHaveLength(2));
    expect(f.calls.filter((call) => call.action === "start")[1]).toMatchObject({ requestId: first.requestId, text });
  });

  it("blocks corrupt receipts and failed storage writes before start", async () => {
    localStorage.setItem("pidock-sdk-main-pending-v1:task-a", "{invalid");
    const f = setup(); const view = mount(f);
    expect(await screen.findByRole("alert")).toHaveTextContent("本机待确认请求记录不可读取");
    expect(await screen.findByText(/尚未开始/)).toBeInTheDocument();
    await send("blocked");
    expect(f.calls.filter((call) => call.action === "start")).toHaveLength(0);
    view.unmount(); localStorage.clear();
    vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw new Error("storage unavailable"); });
    mount(f); await screen.findByText(/尚未开始/);
    await send("not sent");
    expect(await screen.findByText(/storage unavailable/)).toBeInTheDocument();
    expect(f.calls.filter((call) => call.action === "start")).toHaveLength(0);
  });

  it("freezes and unsubscribes on an unreadable fresh inventory before send", async () => {
    const f = setup(); mount(f); await screen.findByText(/尚未开始/);
    f.unreadable(); await send("do not send");
    expect(await screen.findByText(/root unreadable/)).toBeInTheDocument();
    await waitFor(() => expect(f.subscribed()).toBe(false));
    expect(f.calls.filter((call) => call.action === "start")).toHaveLength(0);
  });
});
