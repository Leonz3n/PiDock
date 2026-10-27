import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DesktopConversation } from "../components/DesktopConversation";
import type { PidockBridge } from "../data/shellBridge";

const roots = [{ label: "默认任务根", state: "ready" }];
const association = (id: string) => ({ taskId: id, projectId: null, state: "unassigned" });
const snapshot = (messages: unknown[] = [], pending = false) => ({ source: "sdk-jsonl", sessionId: "main", messages, pending, interrupted: false });
const turn = (taskId: string, requestId: string, state = "accepted") => ({ taskId, sessionId: "main", requestId, turnId: requestId, state, needsResync: false });
const hostContext = (overrides: Record<string, unknown> = {}) => ({
  providerId: "provider-anthropic",
  providerName: "Anthropic 官方",
  model: "claude-sonnet-4-5",
  modelName: "Claude Sonnet",
  availability: { status: "available" },
  window: 200,
  used: 24.8,
  source: "estimated",
  tokens: 4321,
  percent: 12.4,
  thinking: "medium",
  thinkingCatalog: "declared",
  ...overrides,
});

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
  return render(<DesktopConversation taskId={taskId} name="Task" branch="task/main" repoCount={1} roots={JSON.stringify(roots)} association={JSON.stringify(association(taskId))} onBack={vi.fn()} onOpenProviders={vi.fn()} onArchived={vi.fn()} />);
}
const send = async (text: string) => {
  fireEvent.change(screen.getByRole("textbox", { name: "消息" }), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
};
afterEach(() => { cleanup(); localStorage.clear(); delete window.pidock; vi.restoreAllMocks(); });

describe("Desktop SDK conversation", () => {
  it("offers the remaining desktop tools without a terminal launcher or terminal IPC", async () => {
    const fixture = setup();
    const taskOp = vi.fn(async (_taskId: string, _op: string) => ({ ok: false as const, error: "fixture" }));
    fixture.bridge.taskOp = taskOp;
    mount(fixture);
    await screen.findByText(/尚未开始/);
    expect(screen.queryByRole("button", { name: "终端" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("终端输入")).not.toBeInTheDocument();
    for (const name of ["运行", "浏览器", "文件", "日志", "协议"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(taskOp.mock.calls.some(([, op]) => op === "task/planTerminal" || String(op).startsWith("task/terminal"))).toBe(false);
  });
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
    view.rerender(<DesktopConversation taskId="task-b" name="B" branch="task/main" repoCount={1} roots={JSON.stringify(roots)} association={JSON.stringify(association("task-b"))} onBack={vi.fn()} onOpenProviders={vi.fn()} onArchived={vi.fn()} />);
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

  it("reports, in the window line's hover only, what this route's two reads show without making it the Host's statement", async () => {
    const f = setup();
    f.setMessages([{ role: "assistant", text: "reply", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 } }]);
    f.bridge.taskOp = vi.fn(async (_taskId: string, op: string) => op === "task/sessionContext"
      ? { ok: true, payload: { context: hostContext({ tokens: 0 }) } }
      : { ok: true, payload: {} }) as never;
    mount(f);
    const usage = await screen.findByTestId("composer-usage");
    // Two reads disagree: the Host's session total is 0 while this SDK window has
    // reported 120. The hover reports the comparison of those two numbers and
    // names it as this page's conclusion, scoped to this route: the Host returned
    // two numbers, not a cause, so the clause may not read as its statement.
    await waitFor(() => expect(usage.getAttribute("title")).toContain("Host 会话账本本次读数 0 tokens，而本窗口已报告 120 tokens；对照这两项读数，本路由的 SDK 回合用量未计入 Host 会话账本（此为本页两项读数的对照结论，并非 Host 返回的说明）。"));
    expect(usage.getAttribute("title")).toContain("最近最多 80 条 SDK 消息；不是会话累计，可能不含更早用量。");
    expect(usage.getAttribute("title")).not.toContain("Host 报告");
    // The label itself is unchanged: it counts the bounded window, never a session total.
    expect(usage).toHaveTextContent("近期已报告输入+输出 120 tokens");
    expect(usage).not.toHaveTextContent(/本会话/);
  });

  it("shows the Host's own session total in the hover when it has one, without the gap sentence", async () => {
    const f = setup();
    f.setMessages([{ role: "assistant", text: "reply", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 } }]);
    f.bridge.taskOp = vi.fn(async (_taskId: string, op: string) => op === "task/sessionContext"
      ? { ok: true, payload: { context: hostContext({ tokens: 4321 }) } }
      : { ok: true, payload: {} }) as never;
    mount(f);
    const usage = await screen.findByTestId("composer-usage");
    await waitFor(() => expect(usage.getAttribute("title")).toContain("Host 会话账本读数 4321 tokens。"));
    expect(usage.getAttribute("title")).not.toContain("未计入 Host 会话账本");
    expect(usage.getAttribute("title")).not.toContain("对照这两项读数");
    expect(usage).toHaveTextContent("近期已报告输入+输出 120 tokens");
    expect(usage).not.toHaveTextContent(/本会话/);
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

  it("explains text-only messaging from the keyboard without sending the saved draft", async () => {
    const f = setup(); mount(f);
    const user = userEvent.setup();
    await screen.findByText(/尚未开始/);
    const input = screen.getByRole("textbox", { name: "消息" });
    expect(input).toHaveAttribute("placeholder", "描述你想做什么（仅支持文本消息）");
    // [PiDock 16] (#16 盒 1) the `+` entry is now a real local picker. Its scope
    // is stated before a file is chosen: page-only, never sent to the Agent.
    const attachment = screen.getByRole("button", { name: "添加附件" });
    expect(attachment).toBeEnabled();
    await user.click(input);
    await user.type(input, "saved text draft");
    const draft = localStorage.getItem("pidock-sdk-draft-v1:task-a:main");
    await user.tab();
    const explanation = screen.getByLabelText("附件说明");
    expect(explanation).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("附件只在本页输入区保留：内容不上传、不读取，附件不会发给 Agent（当前 SDK 发送路径只发送文本）");
    expect(explanation).toHaveAccessibleDescription("附件只在本页输入区保留：内容不上传、不读取，附件不会发给 Agent（当前 SDK 发送路径只发送文本）");
    await user.keyboard("{Enter} ");
    expect(attachment).toBeEnabled();
    expect(input).toHaveValue("saved text draft");
    expect(localStorage.getItem("pidock-sdk-draft-v1:task-a:main")).toBe(draft);
    expect(localStorage.getItem("pidock-sdk-main-pending-v1:task-a")).toBeNull();
    expect(f.calls.some((call) => call.action === "start")).toBe(false);
    // The picker exists and is multi-select; choosing a file is page state only,
    // which `desktopAttachments.test.tsx` drives end to end.
    expect(document.querySelector('input[type="file"]')).toHaveAttribute("multiple");
  });

  it("keeps Provider navigation and SDK send/cancel available without offering a reasoning tier it cannot read", async () => {
    const f = setup(); window.pidock = f.bridge;
    const onOpenProviders = vi.fn();
    render(<DesktopConversation taskId="task-a" name="Task" branch="task/main" repoCount={1} roots={JSON.stringify(roots)} association={JSON.stringify(association("task-a"))} onBack={vi.fn()} onOpenProviders={onOpenProviders} onArchived={vi.fn()} />);
    await screen.findByText(/尚未开始/);
    // `setup`'s bridge has no `taskOp`, so the Host read cannot answer at all.
    // The control says THAT (「推理 · 读取失败」), never 「未接线」: the capability
    // exists (`task/sessionContext`), the read is what failed.
    const reasoning = await screen.findByTestId("composer-thinking");
    await waitFor(() => expect(reasoning).toHaveTextContent("推理 · 读取失败"));
    expect(reasoning).not.toBeDisabled();
    expect(screen.getByTestId("composer-context")).toHaveTextContent("上下文 读取失败");
    expect(screen.queryByText("推理（未接线）")).toBeNull();
    expect(screen.queryByLabelText("推理设置说明")).toBeNull();
    expect(reasoning.getAttribute("title")).toContain("Host 会话推理档位读取失败");
    fireEvent.click(reasoning);
    expect(screen.getByRole("dialog", { name: "推理档位" })).toHaveTextContent("重新读取 Host 读数");
    expect(onOpenProviders).not.toHaveBeenCalled();
    expect(f.calls.some((call) => call.action === "start")).toBe(false);
    fireEvent.click(screen.getByTestId("composer-model"));
    expect(onOpenProviders).toHaveBeenCalledOnce();
    await send("still connected");
    await screen.findByRole("button", { name: "停止" });
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(await screen.findByText(/已取消/)).toBeInTheDocument();
  });

  it("names a selected profile whose own name and model the Host left blank instead of a bare separator", async () => {
    // `parseProviderStatus` (`data/providerProfile.ts:37`) checks only
    // `typeof === "string" && length <= 2048` for `name`/`modelId`, so a SELECTED
    // profile can carry two blanks; the composer label used to be exactly ` · `.
    const profileStatus = (name: string, modelId: string) => ({
      state: "configured",
      profileId: "p-11111111-2222-3333-4444-555555555555",
      generation: 1,
      profiles: [{ id: "p-11111111-2222-3333-4444-555555555555", name, baseUrl: "https://models.example.test/v1", modelId, contextWindow: 128000, maxTokens: 8192, authRef: "PIDOCK_PROVIDER_EXAMPLE", generation: 1, credentialAvailable: true }],
    });
    const blank = setup();
    blank.bridge.providerOp = vi.fn(async () => ({ ok: true, payload: profileStatus("", "") }));
    const first = mount(blank);
    // The exact text, so a dangling ` · ` cannot hide behind a substring match.
    await waitFor(() => expect(screen.getByTestId("composer-model").textContent).toBe("Host 未上报配置名称 · Host 未上报模型标识"));
    first.unmount();
    const real = setup();
    real.bridge.providerOp = vi.fn(async () => ({ ok: true, payload: profileStatus("Local gateway", "gpt-5-mini") }));
    mount(real);
    await waitFor(() => expect(screen.getByTestId("composer-model").textContent).toBe("Local gateway · gpt-5-mini"));
    expect(screen.queryByText(/Host 未上报/)).toBeNull();
  });

  it("shows the reasoning tier the Host reports and names the read as 未读取 until it answers", async () => {
    const f = setup();
    let release: ((value: { ok: true; payload: unknown }) => void) | undefined;
    const taskOp = vi.fn(async (_taskId: string, op: string) => op === "task/sessionContext"
      ? new Promise<{ ok: true; payload: unknown }>((resolve) => { release = resolve; })
      : { ok: true, payload: {} });
    f.bridge.taskOp = taskOp as never;
    mount(f);
    // While the read is outstanding the control names that state: no tier is shown
    // (not even the one the Host would default to) and 未接线 never appears.
    const reasoning = await screen.findByTestId("composer-thinking");
    await waitFor(() => expect(reasoning).toHaveTextContent("推理 · 未读取"));
    expect(reasoning).toBeDisabled();
    expect(screen.getByTestId("composer-context")).toHaveTextContent("上下文 未读取");
    await act(async () => release!({ ok: true, payload: { context: hostContext({ thinking: "xhigh" }) } }));
    // `xhigh` is a tier no default in this engagement produces (the seeded demo
    // model `本地 Qwen` declares `default: "medium"`, `data/memoryHost.ts:929`, and
    // the prototype falls back to `medium` too, `prototypes/pidock-ui/app.js:123`),
    // so only the Host read can account for this label.
    await waitFor(() => expect(reasoning).toHaveTextContent("推理 · 极高（xhigh）"));
    expect(reasoning).not.toBeDisabled();
    expect(taskOp).toHaveBeenCalledWith("task-a", "task/sessionContext", { sessionId: "main" });
  });

  it("sends the selected tier through the existing Host op and applies the Host's post-write readout", async () => {
    const f = setup();
    const sent: Array<Record<string, unknown>> = [];
    f.bridge.taskOp = vi.fn(async (_taskId: string, op: string, payload?: Record<string, unknown>) => {
      if (op === "task/sessionContext") return { ok: true, payload: { context: hostContext({ thinking: "low", thinkingCatalog: "declared" }) } };
      if (op === "task/setSessionThinking") {
        sent.push(payload ?? {});
        return { ok: true, payload: { context: hostContext({ thinking: String(payload?.["level"]), thinkingCatalog: "declared" }) } };
      }
      return { ok: true, payload: {} };
    }) as never;
    mount(f);
    const reasoning = await screen.findByTestId("composer-thinking");
    await waitFor(() => expect(reasoning).toHaveTextContent("推理 · 低（low）"));
    fireEvent.click(reasoning);
    fireEvent.click(within(screen.getByRole("dialog", { name: "推理档位" })).getByRole("button", { name: /最高/ }));
    await waitFor(() => expect(reasoning).toHaveTextContent("推理 · 最高（max）"));
    expect(sent).toEqual([{ sessionId: "main", level: "max" }]);
    expect(screen.queryByRole("dialog", { name: "推理档位" })).toBeNull();
  });

  it("shows the Host's own refusal wording for a tier it declines, without faking success", async () => {
    const f = setup();
    f.bridge.taskOp = vi.fn(async (_taskId: string, op: string) => op === "task/sessionContext"
      ? { ok: true, payload: { context: hostContext({ thinking: "medium", thinkingCatalog: "declared" }) } }
      : op === "task/setSessionThinking" ? { ok: false, error: "thinking-level-not-declared: 模型未声明该推理档位：max" }
        : { ok: true, payload: {} }) as never;
    mount(f);
    const reasoning = await screen.findByTestId("composer-thinking");
    await waitFor(() => expect(reasoning).toHaveTextContent("推理 · 中（medium）"));
    fireEvent.click(reasoning);
    fireEvent.click(within(screen.getByRole("dialog", { name: "推理档位" })).getByRole("button", { name: /最高/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("thinking-level-not-declared: 模型未声明该推理档位：max");
    expect(reasoning).toHaveTextContent("推理 · 中（medium）");
    expect(screen.getByRole("dialog", { name: "推理档位" })).toBeInTheDocument();
  });

  it("reads the Host occupancy as used/window/percent", async () => {
    const f = setup();
    f.bridge.taskOp = vi.fn(async (_taskId: string, op: string) => op === "task/sessionContext"
      ? { ok: true, payload: { context: hostContext() } }
      : { ok: true, payload: {} }) as never;
    mount(f);
    const context = await screen.findByTestId("composer-context");
    await waitFor(() => expect(context).toHaveTextContent("上下文 24.8k / 200k · 12.4% · 估算"));
    expect(context.getAttribute("title")).toBe("Anthropic 官方 · Claude Sonnet · 已用 24.8k Tokens（来源 estimated）· 窗口 200k Tokens · 占用比例 12.4%；数字即 Host 会话读数，未做推断");
  });

  it("names a blank Host provider identity in the context hover instead of a bare separator", async () => {
    // `data/sessionContext.ts:68-75` type-checks `providerId`/`providerName`/
    // `model`/`modelName` and keeps `""` for all four, so the hover line used to
    // read ` ·  · 已用 24.8k Tokens…` — the same identity the visible composer
    // label names.
    const f = setup();
    f.bridge.taskOp = vi.fn(async (_taskId: string, op: string) => op === "task/sessionContext"
      ? { ok: true, payload: { context: hostContext({ providerId: "", providerName: "", model: "", modelName: "" }) } }
      : { ok: true, payload: {} }) as never;
    mount(f);
    const context = await screen.findByTestId("composer-context");
    await waitFor(() => expect(context).toHaveTextContent("上下文 24.8k / 200k · 12.4% · 估算"));
    expect(context.getAttribute("title")).toContain("Host 未上报配置名称 · Host 未上报模型标识 · 已用 24.8k Tokens（来源 estimated）");
    expect(context.getAttribute("title")).not.toContain(" ·  · ");
  });

  it("shows the Host's own occupancy percent when a ratio recomputed here would differ", async () => {
    const f = setup();
    // The Host's payload is the authoritative source, so this fixture is the one
    // case the fix must survive: a Host whose `percent` is no longer `used/window`
    // (`shell/src/main/pi-session.ts:727` defines it today). used 24.8 / window 200
    // recomputes to 12.4%, so only reading the Host's `percent` can produce 31.5%.
    f.bridge.taskOp = vi.fn(async (_taskId: string, op: string) => op === "task/sessionContext"
      ? { ok: true, payload: { context: hostContext({ used: 24.8, window: 200, percent: 31.5 }) } }
      : { ok: true, payload: {} }) as never;
    mount(f);
    const context = await screen.findByTestId("composer-context");
    await waitFor(() => expect(context).toHaveTextContent("上下文 24.8k / 200k · 31.5% · 估算"));
    // The locally recomputed ratio never reaches the DOM, and the hover prints
    // the same authoritative number as the visible line.
    expect(context).not.toHaveTextContent("12.4%");
    expect(context.getAttribute("title")).toContain("占用比例 31.5%");
  });

  it("names an unknown window instead of rendering a 0% nobody measured", async () => {
    const f = setup();
    f.bridge.taskOp = vi.fn(async (_taskId: string, op: string) => op === "task/sessionContext"
      ? { ok: true, payload: { context: hostContext({ window: 0, used: 0, source: "unknown", percent: null, tokens: 0 }) } }
      : { ok: true, payload: {} }) as never;
    mount(f);
    const context = await screen.findByTestId("composer-context");
    await waitFor(() => expect(context).toHaveTextContent("上下文 0.0k / 窗口未知 · 占比未知 · 待更新"));
    expect(context).not.toHaveTextContent("0%");
    expect(context.getAttribute("title")).toContain("窗口 未知 · 占用比例 未知");
  });

  it("names a model the Host reports as unable to reason instead of offering tiers", async () => {
    const f = setup();
    f.bridge.taskOp = vi.fn(async (_taskId: string, op: string) => op === "task/sessionContext"
      ? { ok: true, payload: { context: hostContext({ thinking: "", thinkingCatalog: "unsupported" }) } }
      : { ok: true, payload: {} }) as never;
    mount(f);
    const reasoning = await screen.findByTestId("composer-thinking");
    await waitFor(() => expect(reasoning).toHaveTextContent("推理 · 不支持"));
    fireEvent.click(reasoning);
    expect(screen.getByRole("dialog", { name: "推理档位" })).toHaveTextContent("Host 报告该模型不支持推理档位，本会话无可选档位。");
    expect(within(screen.getByRole("dialog", { name: "推理档位" })).queryAllByRole("button")).toEqual([]);
  });

  it("follows the model catalog instead of naming a tier when the Host has no session preference", async () => {
    const f = setup();
    f.bridge.taskOp = vi.fn(async (_taskId: string, op: string) => op === "task/sessionContext"
      ? { ok: true, payload: { context: hostContext({ thinking: "", thinkingCatalog: "catalog-unknown" }) } }
      : { ok: true, payload: {} }) as never;
    mount(f);
    const reasoning = await screen.findByTestId("composer-thinking");
    // An empty level is the Host saying "no session preference", not a tier to guess.
    await waitFor(() => expect(reasoning).toHaveTextContent("推理 · 跟随模型"));
    expect(reasoning).not.toHaveTextContent(/高|中|低/);
    fireEvent.click(reasoning);
    expect(screen.getByRole("dialog", { name: "推理档位" })).toHaveTextContent("Host 尚未声明该模型的可用档位，选中档位按模型目录执行");
  });

  // The header used to claim 「Agent 工具未接线 / 只读 · 无工具」, which the Host's
  // own wiring contradicts: every model context is built with `toolHost`
  // (`task-host.ts` `installSdkProvider`) and offered exactly the declared task
  // tools (`sdk-text-kernel.ts` `expectedTools`), and every call is decided and
  // performed by the Host broker. What really is unwired on this page is the
  // permission switch — that, and only that, is what the copy still says.
  it("states the Host tool and write-gate facts instead of claiming there are no tools", async () => {
    const f = setup(); mount(f);
    await screen.findByText(/尚未开始/);
    const page = screen.getByTestId("desktop-conversation");
    // No copy on the page may repeat the falsehood: not the header badges, not
    // the permission button, not its tooltip.
    expect(page).not.toHaveTextContent("无工具");
    expect(page).not.toHaveTextContent("不申请写权限");
    expect(page).not.toHaveTextContent("Agent 工具未接线");
    expect(screen.getByText("工具由 Host 代执行")).toBeVisible();
    expect(screen.getByText("写操作受 Host 写权约束")).toBeVisible();
    const permission = screen.getByRole("button", { name: "权限（未接线）：本页不能切换档位" });
    expect(permission).toBeDisabled();
    // The switch really is unwired here: no tier is offered on this page.
    expect(screen.queryByRole("button", { name: "默认权限" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "自动执行" })).not.toBeInTheDocument();
    fireEvent.focus(screen.getByLabelText("权限说明"));
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("权限切换未接线");
    // Every clause below is a code fact the copy is allowed to name: `read`
    // denies every non-read tool and `default` asks once for a command tool
    // (`pi-session.ts` `previewGate`), and a mutating tool claims the task write
    // right and writes only inside a worktree (`sdk-agent-tool-broker.ts`).
    expect(tooltip).toHaveTextContent("工具已接线，由 Host 决定并代执行");
    expect(tooltip).toHaveTextContent("只读档拒绝一切写与命令");
    expect(tooltip).toHaveTextContent("默认档下命令类工具先要一次确认");
    expect(tooltip).toHaveTextContent("文件写入只在任务工作副本内");
    expect(tooltip).not.toHaveTextContent("无工具");
    expect(tooltip).not.toHaveTextContent("不申请写权限");
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
    render(<DesktopConversation taskId="task-a" name="Task" branch="task/main" repoCount={1} roots={JSON.stringify(roots)} association={JSON.stringify(association("task-a"))} onBack={vi.fn()} onOpenProviders={vi.fn()} onArchived={onArchived} />);
    await screen.findByText(/尚未开始/);
    fireEvent.click(screen.getByRole("button", { name: "任务操作" }));
    fireEvent.click(screen.getByRole("button", { name: "归档当前任务" }));
    expect(screen.getByRole("dialog", { name: "归档当前任务" })).toBeInTheDocument();
    // The composer's own 推理/上下文 read (`task/sessionContext`) and the #24
    // execution-status read (`task/executionState`, read only) are not the dialog:
    // confirming is what may write, so no other op — and no write op at all — has
    // left the page here. The exact call set is pinned so a new op cannot slip in.
    expect(taskOp.mock.calls.map(([, op]) => op).sort()).toEqual(["task/executionState", "task/sessionContext"]);
    fireEvent.click(screen.getByRole("button", { name: "确认归档" }));
    await waitFor(() => expect(onArchived).toHaveBeenCalledOnce());
    expect(taskOp).toHaveBeenCalledWith("task-a", "task/archive", {});
    expect(f.calls.some((call) => call.action === "projection")).toBe(true);
  });

  it("blocks archive during an active SDK turn", async () => {
    const f = setup();
    const ops: string[] = [];
    const taskOp = vi.fn(async (_taskId: string, op: string) => { ops.push(op); return { ok: false, error: "task-locked" }; });
    f.bridge.taskOp = taskOp;
    mount(f);
    await screen.findByText(/尚未开始/);
    await send("active");
    await screen.findByRole("button", { name: "停止" });
    fireEvent.click(screen.getByRole("button", { name: "任务操作" }));
    fireEvent.click(screen.getByRole("button", { name: "归档当前任务" }));
    expect(screen.getByRole("button", { name: "确认归档" })).toBeDisabled();
    expect(screen.getByText(/会话尚未连接、正在执行或请求状态未核验/)).toBeInTheDocument();
    // The two status reads (推理/上下文 and #24 执行状态) still issue nothing else:
    // the turn runs on the SDK channel, and no archive/cleanup op left the page.
    expect(ops.filter((op) => op !== "task/sessionContext" && op !== "task/executionState")).toEqual([]);
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
    render(<DesktopConversation taskId="task-b" name="B" branch="task/main" repoCount={1} roots={JSON.stringify(roots)} association={JSON.stringify(association("task-b"))} onBack={vi.fn()} onOpenProviders={vi.fn()} onArchived={vi.fn()} />);
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

  it("labels the append entry for repositories AND plain directories", async () => {
    const f = setup();
    f.bridge.appendTaskRepos = vi.fn(async () => ({ ok: true, payload: {} }));
    mount(f);
    await screen.findByText(/尚未开始/);
    // The surface appends plain directories too, so the entry must not promise
    // only repositories.
    const entry = screen.getByRole("button", { name: "追加仓库或目录" });
    expect(entry).toHaveAttribute("title", "从项目登记中选择仓库或普通目录并追加到本任务");
  });

  it("freezes and unsubscribes on an unreadable fresh inventory before send", async () => {
    const f = setup(); mount(f); await screen.findByText(/尚未开始/);
    f.unreadable(); await send("do not send");
    expect(await screen.findByText(/root unreadable/)).toBeInTheDocument();
    await waitFor(() => expect(f.subscribed()).toBe(false));
    expect(f.calls.filter((call) => call.action === "start")).toHaveLength(0);
  });
});
