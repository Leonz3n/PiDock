import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  it("restores literal main drafts separately for two tasks without sending or replaying markers", async () => {
    const a = setup("task-a"); const first = mount(a);
    await screen.findByText(/尚未开始/);
    const text = "中文草稿\n@repo/file.ts $review /skill:review\n/tmp/build.log $HOME";
    fireEvent.change(screen.getByRole("textbox", { name: "消息" }), { target: { value: text } });
    first.unmount();
    const b = setup("task-b"); const second = mount(b, "task-b");
    await screen.findByText(/尚未开始/);
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("");
    fireEvent.change(screen.getByRole("textbox", { name: "消息" }), { target: { value: "other task draft" } });
    second.unmount();
    const reopened = mount(a);
    await screen.findByText(/尚未开始/);
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue(text);
    expect(a.calls.filter((call) => call.action === "start")).toHaveLength(0);
    reopened.unmount(); mount(b, "task-b");
    await screen.findByText(/尚未开始/);
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("other task draft");
    expect(b.calls.filter((call) => call.action === "start")).toHaveLength(0);
  });
  it("keeps later edits through a delayed positive ACK even when text changes back to the submitted string", async () => {
    const f = setup();
    const sdkTurn = f.bridge.sdkTurn!;
    let release: (() => void) | undefined;
    f.bridge.sdkTurn = (request) => request.action === "start"
      ? new Promise((resolve) => { release = () => { void sdkTurn(request).then(resolve); }; })
      : sdkTurn(request);
    const view = mount(f); await screen.findByText(/尚未开始/);
    await send("original");
    await waitFor(() => expect(release).toBeDefined());
    const input = screen.getByRole("textbox", { name: "消息" });
    fireEvent.change(input, { target: { value: "new edit" } });
    fireEvent.change(input, { target: { value: "original" } });
    await act(async () => release!());
    await screen.findByRole("button", { name: "停止" });
    expect(input).toHaveValue("original");
    view.unmount(); mount(f);
    await screen.findByRole("button", { name: "停止" });
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("original");
    expect(f.calls.filter((call) => call.action === "start")).toHaveLength(1);
  });

  it("persists an explicitly cleared draft and an acknowledged fresh send without reviving accepted receipt text", async () => {
    const f = setup(); let view = mount(f); await screen.findByText(/尚未开始/);
    const input = screen.getByRole("textbox", { name: "消息" });
    fireEvent.change(input, { target: { value: "erase me" } });
    fireEvent.change(input, { target: { value: "" } });
    view.unmount(); view = mount(f); await screen.findByText(/尚未开始/);
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("");
    await send("accepted original"); await screen.findByRole("button", { name: "停止" });
    expect(localStorage.getItem("pidock-sdk-main-pending-v1:task-a")).not.toBeNull();
    view.unmount(); mount(f); await screen.findByRole("button", { name: "停止" });
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("");
    expect(f.calls.filter((call) => call.action === "start")).toHaveLength(1);
  });

  it("preserves a next draft on reopen, original-ID retry and terminal reconciliation", async () => {
    const f = setup(); f.setFail("lost"); const view = mount(f);
    await screen.findByText(/尚未开始/); await send("original request");
    await screen.findByText(/请求结果未知/);
    const first = f.calls.find((call) => call.action === "start")!;
    fireEvent.change(screen.getByRole("textbox", { name: "消息" }), { target: { value: "next draft" } });
    view.unmount(); f.setFail(""); mount(f);
    await screen.findByText(/请求状态未知/);
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("next draft");
    expect(f.calls.filter((call) => call.action === "start")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "按原 ID 重试" }));
    await screen.findByRole("button", { name: "停止" });
    expect(f.calls.filter((call) => call.action === "start")[1]).toMatchObject({ requestId: first.requestId, text: "original request" });
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("next draft");
    f.setStatus(turn("task-a", String(first.requestId), "done"));
    act(() => f.emit({ kind: "sdk-turn-status", turn: turn("task-a", String(first.requestId), "done") }));
    await screen.findByText(/已从 SDK 历史核验/);
    expect(localStorage.getItem("pidock-sdk-main-pending-v1:task-a")).toBeNull();
    cleanup(); mount(f); await screen.findByText(/尚未开始/);
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("next draft");
    expect(f.calls.filter((call) => call.action === "start")).toHaveLength(2);
  });

  it.each([
    "{invalid",
    JSON.stringify({ schema: 2, taskId: "task-a", sessionId: "main", text: "unsupported" }),
    JSON.stringify({ schema: 1, taskId: "task-b", sessionId: "main", text: "foreign" }),
    JSON.stringify({ schema: 1, taskId: "task-a", sessionId: "other", text: "foreign session" }),
    JSON.stringify({ schema: 1, taskId: "task-a", sessionId: "main", text: "中".repeat(5462) }),
    " ".repeat(131073),
  ])("preserves unreadable draft bytes and allows editing and sending without repairing them (%#)", async (raw) => {
    const key = "pidock-sdk-draft-v1:task-a:main";
    localStorage.setItem(key, raw);
    const f = setup(); mount(f); await screen.findByText(/尚未开始/);
    expect(screen.getByRole("alert")).toHaveTextContent("本机草稿不可读取");
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("");
    await send("explicit new text"); await screen.findByRole("button", { name: "停止" });
    expect(localStorage.getItem(key)).toBe(raw);
    expect(f.calls.filter((call) => call.action === "start")[0]).toMatchObject({ text: "explicit new text" });
    expect(screen.getByRole("alert")).toHaveTextContent("原记录保留");
  });

  it("retains the last saved draft when UTF-8 storage limits are exceeded without truncating the editor", async () => {
    const f = setup(); const view = mount(f); await screen.findByText(/尚未开始/);
    const input = screen.getByRole("textbox", { name: "消息" });
    const within = "中".repeat(5461);
    fireEvent.change(input, { target: { value: within } });
    const saved = localStorage.getItem("pidock-sdk-draft-v1:task-a:main");
    expect(JSON.parse(saved!).text).toBe(within);
    const beyond = within + "中";
    fireEvent.change(input, { target: { value: beyond } });
    expect(screen.getByRole("alert")).toHaveTextContent("文字超过 16 KiB");
    expect(input).toHaveValue(beyond);
    expect(localStorage.getItem("pidock-sdk-draft-v1:task-a:main")).toBe(saved);
    view.unmount(); mount(f); await screen.findByText(/尚未开始/);
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue(within);
    expect(f.calls.filter((call) => call.action === "start")).toHaveLength(0);
  });

  it("warns on draft quota failure while preserving saved bytes and keeping independent receipt send usable", async () => {
    const f = setup(); mount(f); await screen.findByText(/尚未开始/);
    fireEvent.change(screen.getByRole("textbox", { name: "消息" }), { target: { value: "previous draft" } });
    const key = "pidock-sdk-draft-v1:task-a:main";
    const saved = localStorage.getItem(key);
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith("pidock-sdk-draft-v1:")) throw new DOMException("full", "QuotaExceededError");
      setItem.call(this, key, value);
    });
    await send("new unsaved text"); await screen.findByRole("button", { name: "停止" });
    expect(screen.getByRole("alert")).toHaveTextContent("草稿未保存：本机存储不可用");
    expect(localStorage.getItem(key)).toBe(saved);
    expect(f.calls.filter((call) => call.action === "start")[0]).toMatchObject({ text: "new unsaved text" });
    expect(localStorage.getItem("pidock-sdk-main-pending-v1:task-a")).not.toBeNull();
  });

  it("does not restore or save drafts before fresh identity verification, or for an unavailable task", async () => {
    const key = "pidock-sdk-draft-v1:task-a:main";
    const raw = JSON.stringify({ schema: 1, taskId: "task-a", sessionId: "main", text: "saved task text" });
    localStorage.setItem(key, raw);
    const f = setup(); f.invalidate(); mount(f);
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("");
    await screen.findByText(/任务或任务根已变化/);
    fireEvent.change(screen.getByRole("textbox", { name: "消息" }), { target: { value: "unverified edit" } });
    expect(localStorage.getItem(key)).toBe(raw);
    expect(f.calls.some((call) => call.action === "subscribe" || call.action === "start")).toBe(false);
  });

  it("drops a delayed old ACK on a task prop switch without changing either task's draft", async () => {
    const a = setup(); const sdkTurn = a.bridge.sdkTurn!;
    let release: (() => void) | undefined;
    a.bridge.sdkTurn = (request) => request.action === "start"
      ? new Promise((resolve) => { release = () => { void sdkTurn(request).then(resolve); }; })
      : sdkTurn(request);
    const view = mount(a); await screen.findByText(/尚未开始/); await send("task A in flight");
    await waitFor(() => expect(release).toBeDefined());
    fireEvent.change(screen.getByRole("textbox", { name: "消息" }), { target: { value: "task A next" } });
    const b = setup("task-b"); window.pidock = b.bridge;
    view.rerender(<DesktopConversation taskId="task-b" name="B" roots={JSON.stringify(roots)} association={JSON.stringify(association("task-b"))} onBack={vi.fn()} onOpenProviders={vi.fn()} onArchived={vi.fn()} />);
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("");
    await screen.findByText(/尚未开始/);
    fireEvent.change(screen.getByRole("textbox", { name: "消息" }), { target: { value: "task B draft" } });
    await act(async () => release!());
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("task B draft");
    expect(b.calls.filter((call) => call.action === "start")).toHaveLength(0);
    view.unmount(); mount(a); await screen.findByRole("button", { name: "停止" });
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("task A next");
  });

  it("keeps edits made while the fresh send is verifying task identity", async () => {
    const f = setup(); const listTasks = f.bridge.listTasks!;
    let release: (() => void) | undefined;
    let reads = 0;
    f.bridge.listTasks = () => ++reads === 2
      ? new Promise((resolve) => { release = () => { void listTasks().then(resolve); }; })
      : listTasks();
    mount(f); await screen.findByText(/尚未开始/); await send("before verification");
    await waitFor(() => expect(release).toBeDefined());
    fireEvent.change(screen.getByRole("textbox", { name: "消息" }), { target: { value: "during verification" } });
    await act(async () => release!()); await screen.findByRole("button", { name: "停止" });
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("during verification");
    expect(f.calls.find((call) => call.action === "start")?.text).toBe("before verification");
  });

  it("keeps the legacy receipt-only retry text editable after confirmation without automatically saving or sending it again", async () => {
    const f = setup(); f.setFail("lost"); const view = mount(f);
    await screen.findByText(/尚未开始/); await send("legacy request"); await screen.findByText(/请求结果未知/);
    const first = f.calls.find((call) => call.action === "start")!;
    view.unmount(); localStorage.removeItem("pidock-sdk-draft-v1:task-a:main"); f.setFail("");
    const reopened = mount(f); await screen.findByText(/请求状态未知/);
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("legacy request");
    fireEvent.click(screen.getByRole("button", { name: "按原 ID 重试" })); await screen.findByRole("button", { name: "停止" });
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("legacy request");
    f.setStatus(turn("task-a", String(first.requestId), "done"));
    act(() => f.emit({ kind: "sdk-turn-status", turn: turn("task-a", String(first.requestId), "done") }));
    await screen.findByText(/已从 SDK 历史核验/);
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("legacy request");
    expect(localStorage.getItem("pidock-sdk-draft-v1:task-a:main")).toBeNull();
    reopened.unmount(); mount(f); await screen.findByText(/尚未开始/);
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("");
    expect(f.calls.filter((call) => call.action === "start")).toHaveLength(2);
  });

  it("warns when draft reads are unavailable while keeping independent receipt sending usable", async () => {
    const getItem = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) {
      if (key.startsWith("pidock-sdk-draft-v1:")) throw new DOMException("denied", "SecurityError");
      return getItem.call(this, key);
    });
    const f = setup(); mount(f); await screen.findByText(/尚未开始/);
    expect(screen.getByRole("alert")).toHaveTextContent("本机草稿不可读取");
    await send("explicit request"); await screen.findByRole("button", { name: "停止" });
    expect(f.calls.find((call) => call.action === "start")?.text).toBe("explicit request");
  });

  it("blocks sending when both draft and pending-receipt storage writes fail", async () => {
    const f = setup(); mount(f); await screen.findByText(/尚未开始/);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    await send("unsaved draft and request");
    await screen.findByText("storage unavailable");
    expect(screen.getByText(/草稿未保存：本机存储不可用/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("unsaved draft and request");
    expect(f.calls.filter((call) => call.action === "start")).toHaveLength(0);
  });

  it("labels composer usage as recent reported input and output, not session cumulative usage", async () => {
    const f = setup();
    f.setMessages([
      { role: "user", text: "first request", usage: null },
      { role: "assistant", text: "first reply", usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 30 } },
      { role: "user", text: "second request", usage: null },
      { role: "assistant", text: "second reply", usage: { input: 50, output: 10, cacheRead: 800, cacheWrite: 40 } },
    ]);
    mount(f);
    expect(await screen.findByText("近期已报告输入+输出 180 tokens")).toBeInTheDocument();
    expect(screen.queryByText(/本会话.*tokens/)).not.toBeInTheDocument();
  });

  it.each([
    { messages: [] },
    { messages: [{ role: "user", text: "request", usage: null }] },
    { messages: [{ role: "assistant", text: "unreported reply", usage: null }] },
  ])("does not present an unreported window as zero usage ($messages)", async ({ messages }) => {
    const f = setup(); f.setMessages(messages); mount(f);
    await waitFor(() => expect(screen.getByText("已连接")).toBeInTheDocument());
    expect(screen.getByText("近期用量未报告")).toBeInTheDocument();
    expect(screen.queryByText(/0 tokens/)).not.toBeInTheDocument();
  });

  it("discloses the bounded window and missing assistant reports without inferring truncation", async () => {
    const f = setup();
    f.setMessages([
      { role: "assistant", text: "reported", usage: { input: 0, output: 0, cacheRead: 15, cacheWrite: 5 } },
      ...Array.from({ length: 79 }, (_, index) => ({ role: "assistant", text: `missing ${index}`, usage: null })),
    ]);
    mount(f);
    const usage = await screen.findByText("近期已报告输入+输出 0 tokens");
    expect(usage).toHaveAttribute("title", "最近最多 80 条 SDK 消息；不是会话累计，可能不含更早用量。79 条助手消息未报告用量。");
    expect(screen.queryByText(/已截断|较早用量未计入/)).not.toBeInTheDocument();
  });

  it("withdraws composer numbers after a failed projection instead of showing stale verified usage", async () => {
    const f = setup();
    f.setMessages([{ role: "assistant", text: "stored reply", usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 } }]);
    mount(f);
    expect(await screen.findByText("近期已报告输入+输出 12 tokens")).toBeInTheDocument();
    f.setMessages([{ role: "assistant", text: "invalid reply", usage: { input: -1 } }]);
    fireEvent.click(screen.getByRole("button", { name: "核验" }));
    await screen.findByText(/SDK 消息返回异常/);
    expect(screen.getByText("近期用量未核验")).toBeInTheDocument();
    expect(screen.queryByText("近期已报告输入+输出 12 tokens")).not.toBeInTheDocument();
  });

  it("does not reuse another task's usage while a fresh subscription is pending or after a late old reply", async () => {
    const a = setup("task-a");
    a.setMessages([{ role: "assistant", text: "task A reply", usage: { input: 20, output: 3, cacheRead: 0, cacheWrite: 0 } }]);
    const view = mount(a);
    expect(screen.getByText("近期用量未核验")).toBeInTheDocument();
    expect(await screen.findByText("近期已报告输入+输出 23 tokens")).toBeInTheDocument();
    view.unmount();
    const b = setup("task-b");
    let resolveSubscribe: ((value: { ok: boolean; payload: unknown }) => void) | undefined;
    const sdkTurn = b.bridge.sdkTurn!;
    b.bridge.sdkTurn = (request) => request.action === "subscribe"
      ? new Promise((resolve) => { resolveSubscribe = resolve; })
      : sdkTurn(request);
    const pending = mount(b, "task-b");
    await waitFor(() => expect(resolveSubscribe).toBeDefined());
    expect(screen.getByText("近期用量未核验")).toBeInTheDocument();
    expect(screen.queryByText(/23 tokens/)).not.toBeInTheDocument();
    pending.unmount();
    const c = setup("task-c"); mount(c, "task-c");
    await screen.findByText("近期用量未报告");
    await act(async () => resolveSubscribe!({ ok: true, payload: { taskId: "task-b", sessionId: "main", snapshot: snapshot([{ role: "assistant", text: "late reply", usage: { input: 40, output: 4, cacheRead: 0, cacheWrite: 0 } }]) } }));
    expect(screen.getByText("近期用量未报告")).toBeInTheDocument();
    expect(screen.queryByText(/44 tokens/)).not.toBeInTheDocument();
  });

  it("keeps composition confirmation local even when Enter reports isComposing false", async () => {
    const f = setup(); mount(f);
    await screen.findByText(/尚未开始/);
    const input = screen.getByRole("textbox", { name: "消息" });
    fireEvent.change(input, { target: { value: "composition draft" } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", isComposing: false });
    await act(async () => {});
    expect(f.calls.filter((call) => call.action === "start")).toHaveLength(0);
    expect(localStorage.getItem("pidock-sdk-main-pending-v1:task-a")).toBeNull();
    expect(input).toHaveValue("composition draft");
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", isComposing: false });
    await screen.findByRole("button", { name: "停止" });
    expect(f.calls.filter((call) => call.action === "start")).toHaveLength(1);
    expect(f.calls.find((call) => call.action === "start")?.text).toBe("composition draft");
    expect(input).toHaveValue("");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(f.calls.filter((call) => call.action === "start")).toHaveLength(1);
  });

  it("keeps the IME completion Enter local after compositionEnd when keyCode is 229", async () => {
    const f = setup(); mount(f);
    await screen.findByText(/尚未开始/);
    const input = screen.getByRole("textbox", { name: "消息" });
    fireEvent.change(input, { target: { value: "completed draft" } });
    fireEvent.compositionStart(input);
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229, isComposing: false });
    await act(async () => {});
    expect(f.calls.filter((call) => call.action === "start")).toHaveLength(0);
    expect(localStorage.getItem("pidock-sdk-main-pending-v1:task-a")).toBeNull();
    expect(input).toHaveValue("completed draft");
    fireEvent.keyDown(input, { key: "Enter", keyCode: 13, isComposing: false });
    await screen.findByRole("button", { name: "停止" });
    expect(f.calls.filter((call) => call.action === "start")).toHaveLength(1);
    expect(f.calls.find((call) => call.action === "start")?.text).toBe("completed draft");
  });

  it("preserves native composition and Shift+Enter without suppressing ordinary Enter", async () => {
    const f = setup(); mount(f);
    await screen.findByText(/尚未开始/);
    const input = screen.getByRole("textbox", { name: "消息" });
    const text = "first line\nsecond line";
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    await act(async () => {});
    expect(f.calls.filter((call) => call.action === "start")).toHaveLength(0);
    expect(localStorage.getItem("pidock-sdk-main-pending-v1:task-a")).toBeNull();
    expect(input).toHaveValue(text);
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("button", { name: "停止" });
    expect(f.calls.filter((call) => call.action === "start")).toHaveLength(1);
    expect(f.calls.find((call) => call.action === "start")?.text).toBe(text);
  });

  it("does not leave composition stuck across repeated cycles or a remount", async () => {
    const f = setup();
    const view = mount(f);
    await screen.findByText(/尚未开始/);
    let input = screen.getByRole("textbox", { name: "消息" });
    fireEvent.change(input, { target: { value: "repeated draft" } });
    for (let cycle = 0; cycle < 3; cycle++) {
      fireEvent.compositionStart(input);
      fireEvent.keyDown(input, { key: "Enter", isComposing: false });
      fireEvent.compositionEnd(input);
      fireEvent.keyDown(input, { key: "Enter", keyCode: 229, isComposing: false });
    }
    await act(async () => {});
    expect(f.calls.filter((call) => call.action === "start")).toHaveLength(0);
    expect(localStorage.getItem("pidock-sdk-main-pending-v1:task-a")).toBeNull();
    expect(input).toHaveValue("repeated draft");
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("button", { name: "停止" });
    expect(f.calls.filter((call) => call.action === "start")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await screen.findByText(/已取消/);
    fireEvent.compositionStart(input);
    view.unmount();
    mount(f);
    await screen.findByText(/尚未开始/);
    input = screen.getByRole("textbox", { name: "消息" });
    fireEvent.change(input, { target: { value: "remounted draft" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("button", { name: "停止" });
    expect(f.calls.filter((call) => call.action === "start")).toHaveLength(2);
    expect(f.calls.filter((call) => call.action === "start")[1]?.text).toBe("remounted draft");
  });

  it("explains text-only messaging from the keyboard without enabling attachments or sending the saved draft", async () => {
    const f = setup(); mount(f);
    const user = userEvent.setup();
    await screen.findByText(/尚未开始/);
    const input = screen.getByRole("textbox", { name: "消息" });
    expect(input).toHaveAttribute("placeholder", "描述你想做什么（仅支持文本消息）");
    const attachment = screen.getByRole("button", { name: "附件（未接线）" });
    expect(attachment).toBeDisabled();
    await user.click(input);
    await user.type(input, "saved text draft");
    const draft = localStorage.getItem("pidock-sdk-draft-v1:task-a:main");
    await user.tab();
    const explanation = screen.getByLabelText("附件说明");
    expect(explanation).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("附件未接线；当前会话仅支持文本消息");
    expect(explanation).toHaveAccessibleDescription("附件未接线；当前会话仅支持文本消息");
    await user.keyboard("{Enter} ");
    expect(attachment).toBeDisabled();
    expect(input).toHaveValue("saved text draft");
    expect(localStorage.getItem("pidock-sdk-draft-v1:task-a:main")).toBe(draft);
    expect(localStorage.getItem("pidock-sdk-main-pending-v1:task-a")).toBeNull();
    expect(f.calls.some((call) => call.action === "start")).toBe(false);
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it("marks reasoning settings unwired while keeping Provider navigation and SDK send/cancel available", async () => {
    const f = setup(); window.pidock = f.bridge;
    const onOpenProviders = vi.fn();
    render(<DesktopConversation taskId="task-a" name="Task" roots={JSON.stringify(roots)} association={JSON.stringify(association("task-a"))} onBack={vi.fn()} onOpenProviders={onOpenProviders} onArchived={vi.fn()} />);
    await screen.findByText(/尚未开始/);
    const reasoning = screen.getByRole("button", { name: "推理（未接线）" });
    expect(reasoning).toBeDisabled();
    expect(screen.queryByRole("button", { name: "推理 · 关闭" })).not.toBeInTheDocument();
    fireEvent.focus(screen.getByLabelText("推理设置说明"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("推理设置未接线；此处不表示模型的推理能力或当前档位");
    fireEvent.click(reasoning);
    expect(onOpenProviders).not.toHaveBeenCalled();
    expect(f.calls.some((call) => call.action === "start")).toBe(false);
    fireEvent.click(screen.getByTestId("composer-model"));
    expect(onOpenProviders).toHaveBeenCalledOnce();
    await send("still connected");
    await screen.findByRole("button", { name: "停止" });
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(await screen.findByText(/已取消/)).toBeInTheDocument();
  });

  it("shows the SDK zero-tool boundary without offering permission changes", async () => {
    const f = setup(); mount(f);
    await screen.findByText(/尚未开始/);
    expect(screen.getByText("Agent 工具未接线")).toBeVisible();
    const permission = screen.getByRole("button", { name: "权限（未接线）：只读 · 无工具" });
    expect(permission).toBeDisabled();
    expect(screen.queryByRole("button", { name: "默认权限" })).not.toBeInTheDocument();
    fireEvent.focus(screen.getByLabelText("权限说明"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("权限切换未接线；当前 SDK 回合无工具，不申请写权限");
    fireEvent.click(permission);
    expect(f.calls.some((call) => call.action === "start")).toBe(false);
  });

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
    cleanup(); mount(f); await screen.findByText(/尚未开始/);
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("hello");
    expect(f.calls.filter((call) => call.action === "start")).toHaveLength(1);
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
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith("pidock-sdk-main-pending-v1:")) throw new Error("storage unavailable");
      setItem.call(this, key, value);
    });
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
