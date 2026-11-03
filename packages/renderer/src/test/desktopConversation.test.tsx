import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DesktopConversation } from "../components/DesktopConversation";
import type { PidockBridge } from "../data/shellBridge";

const roots = [{ label: "默认任务根", state: "ready" }];
const association = (id: string) => ({ taskId: id, projectId: null, state: "unassigned" });
const snapshot = (messages: unknown[] = [], pending = false) => ({ source: "sdk-jsonl", sessionId: "main", messages, pending, interrupted: false });
const turn = (taskId: string, requestId: string, state = "accepted") => ({ taskId, sessionId: "main", requestId, turnId: requestId, state, needsResync: false });
/** [#139] The Host's own session index row for the migrated single session. */
const sessionMain = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "main", name: "主会话", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
  archived: false, permission: "default", binding: null, ...overrides,
});
/** [#139] One session's readout as the Host derives it from that session's SDK JSONL. */
const sessionReadout = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  session: sessionMain(), active: true,
  model: { id: "claude-sonnet-4-5", name: "Claude Sonnet", contextWindow: 200000, maxTokens: 8000, reasoning: true },
  reasoningLevels: ["low", "medium", "high"],
  context: { used: null, window: 200000, source: "unknown" },
  usage: null, turns: 0, transcriptModel: null, pending: false, interrupted: false,
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
  // [#117 第 7 项] The desktop draft is Host state now: this map is the Host's
  // `task/saveDraft`/`task/readDraft` memory, so "restart" = a new mount.
  const drafts = new Map<string, { text: string; references?: unknown[] }>();
  let draftRefuse = "";
  let draftSaveRefuse = "";
  let draftRecord: unknown;
  const draftTaskOp = async (taskId_: string, op: string, payload: Record<string, unknown> = {}) => {
    const envelope = (inner: Record<string, unknown>) => ({ ok: true as const, payload: { workspaceId: "w", taskId: taskId_, op, payload: inner } });
    if (!op.startsWith("task/")) return { ok: false as const, error: `unexpected ${op}` };
    if (op === "task/readDraft") {
      if (draftRefuse) return { ok: false as const, error: draftRefuse };
      if (draftRecord !== undefined) return envelope({ sessionId: "main", draft: draftRecord });
      return envelope({ sessionId: "main", draft: drafts.get(taskId_) ?? null });
    }
    if (op === "task/saveDraft") {
      if (draftRefuse || draftSaveRefuse) return { ok: false as const, error: draftRefuse || draftSaveRefuse };
      drafts.set(taskId_, { text: String(payload["text"]), ...(payload["references"] !== undefined ? { references: payload["references"] as unknown[] } : {}) });
      return envelope({ sessionId: "main" });
    }
    if (op === "task/clearDraft") {
      if (draftRefuse) return { ok: false as const, error: draftRefuse };
      drafts.delete(taskId_);
      return envelope({ sessionId: "main" });
    }
    return undefined;
  };
  /** The draft half is always the Host's; a test's own handler sees everything else. */
  const taskOpWithDraft = (handler?: (taskId: string, op: string, payload: Record<string, unknown>) => unknown) =>
    vi.fn(async (taskId_: string, op: string, payload: Record<string, unknown> = {}) => {
      const drafted = await draftTaskOp(taskId_, op, payload);
      if (drafted !== undefined) return drafted;
      const answered = handler ? handler(taskId_, op, payload) : undefined;
      if (answered !== undefined) return answered;
      return sessionTaskOp(op, payload) ?? { ok: false as const, error: `unexpected ${op}` };
    });
  let installedTaskOp = taskOpWithDraft() as never;
  /** [#139] This fixture's Host session state; a test overrides per case. */
  let readout = sessionReadout();
  let sessions: Array<Record<string, unknown>> = [sessionMain()];
  let activeSessionId: string | null = "main";
  const sessionTaskOp = (op: string, payload: Record<string, unknown>) => {
    const envelope = (inner: Record<string, unknown>) => ({ ok: true as const, payload: { workspaceId: "w", taskId, op, payload: inner } });
    if (op === "task/sessionList") return envelope({ activeSessionId, sessions, provider: null });
    if (op === "task/sessionReadout") {
      const wanted = String(payload["sessionId"] ?? "");
      if (!sessions.some((session) => session["id"] === wanted)) return { ok: false as const, error: "session-unknown" };
      return envelope(readout);
    }
    return undefined;
  };
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
  // A test may replace `taskOp` wholesale; the draft half stays the Host's, so
  // "the fixture forgot the draft channel" is never the reason a test fails.
  Object.defineProperty(bridge, "taskOp", {
    configurable: true,
    get: () => installedTaskOp,
    set: (handler: (taskId: string, op: string, payload: Record<string, unknown>) => unknown) => { installedTaskOp = taskOpWithDraft(handler) as never; },
  });
  return { bridge, calls, drafts, setDraftRefuse: (value: string) => { draftRefuse = value; }, setDraftSaveRefuse: (value: string) => { draftSaveRefuse = value; }, setDraftRecord: (value: unknown) => { draftRecord = value; }, setTaskOp: (handler: (taskId: string, op: string, payload: Record<string, unknown>) => unknown) => { bridge.taskOp = taskOpWithDraft(handler) as never; }, setReadout: (value: typeof readout) => { readout = value; }, setSessions: (value: Array<Record<string, unknown>>, active: string | null = null) => { sessions = value; activeSessionId = active ?? (value[0]?.["id"] as string | undefined) ?? null; }, readout: () => readout, emit: (value: unknown) => listener?.(value), setStatus: (value: unknown) => { status = value; }, setMessages: (value: unknown[]) => { messages = value; }, setFail: (value: string) => { fail = value; }, invalidate: () => { associationState = "unavailable"; }, unreadable: () => { unreadable = true; }, subscribed: () => Boolean(listener) };
}
function mount(fixture: ReturnType<typeof setup>, taskId = "task-a", onOpenProviders = vi.fn()) {
  window.pidock = fixture.bridge;
  return render(<DesktopConversation taskId={taskId} name="Task" branch="task/main" repoCount={1} roots={JSON.stringify(roots)} association={JSON.stringify(association(taskId))} onBack={vi.fn()} onOpenProviders={onOpenProviders} onArchived={vi.fn()} />);
}
const send = async (text: string) => {
  fireEvent.change(screen.getByRole("textbox", { name: "消息" }), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
};
afterEach(() => { cleanup(); localStorage.clear(); delete window.pidock; vi.restoreAllMocks(); });

describe("Desktop SDK conversation", () => {
  it("requires Provider configuration on the conversation entry instead of choosing a model or calling one", async () => {
    // [Pencil T07] ticket 142: landing on a freshly created task's `main` entry must
    // not invent a Provider/model selection and must not auto-call a model. The
    // conversation entry stays open; the missing configuration is a named state
    // with the route to 能力管理 → Providers.
    const fixture = setup();
    const openProviders = vi.fn();
    mount(fixture, "task-a", openProviders);
    const requirement = await screen.findByTestId("provider-requirement");
    expect(requirement).toHaveTextContent(/未配置/);
    expect(requirement).toHaveTextContent(/不会自动选择或调用模型/);
    expect(requirement).toHaveTextContent(/能力管理 → Providers/);
    fireEvent.click(within(requirement).getByRole("button", { name: /前往能力管理/ }));
    expect(openProviders).toHaveBeenCalledTimes(1);
    // Mounting the entry (and opening Providers) sent nothing to a model.
    expect(fixture.calls.some((request) => request["action"] === "start")).toBe(false);
  });

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

  it("stores an emptied draft in the Host so a restart never revives acknowledged receipt text", async () => {
    const f = setup(); let view = mount(f); await screen.findByText(/尚未开始/);
    const input = screen.getByRole("textbox", { name: "消息" });
    fireEvent.change(input, { target: { value: "erase me" } });
    await waitFor(() => expect(f.drafts.get("task-a")).toEqual({ text: "erase me" }));
    fireEvent.change(input, { target: { value: "" } });
    // An emptied composer is an EMPTY draft record, not "no record": the composer
    // uses that difference to keep a pending receipt's text out of the box.
    await waitFor(() => expect(f.drafts.get("task-a")).toEqual({ text: "" }));
    view.unmount(); view = mount(f); await screen.findByText(/尚未开始/);
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("");
    await send("accepted original"); await screen.findByRole("button", { name: "停止" });
    await waitFor(() => expect(f.drafts.get("task-a")).toEqual({ text: "" }));
    expect(localStorage.getItem("pidock-sdk-pending-v1:task-a:main")).not.toBeNull();
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
    expect(localStorage.getItem("pidock-sdk-pending-v1:task-a:main")).toBeNull();
    cleanup(); mount(f); await screen.findByText(/尚未开始/);
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("next draft");
    expect(f.calls.filter((call) => call.action === "start")).toHaveLength(2);
  });

  it.each([
    // An unreadable text is not guessed at: the box stays empty and says why.
    { draft: { text: 42 }, text: "" },
    // A readable text survives a bad reference list; the note names what was ignored.
    { draft: { text: "ok", references: "not-a-list" }, text: "ok" },
    { draft: "nonsense", text: "" },
  ])("reports an unreadable Host draft by name and never rewrites it (%#)", async (record) => {
    const f = setup();
    f.setDraftRecord(record.draft);
    mount(f); await screen.findByText(/尚未开始/);
    // Named refusal, not a silently empty composer.
    expect(screen.getByRole("alert")).toHaveTextContent("草稿读取失败");
    expect(screen.getByRole("alert")).toHaveTextContent("仍可编辑和发送");
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue(record.text);
    // Reading never repairs the Host's record: the user's edit is the first write.
    expect(f.drafts.has("task-a")).toBe(false);
    await send("explicit new text"); await screen.findByRole("button", { name: "停止" });
    expect(f.calls.filter((call) => call.action === "start")[0]).toMatchObject({ text: "explicit new text" });
  });

  it("names a failed Host draft read instead of pretending the composer was empty", async () => {
    const f = setup();
    f.setDraftRefuse("task-host-closing");
    mount(f); await screen.findByText(/尚未开始/);
    expect(screen.getByRole("alert")).toHaveTextContent("草稿读取失败：task-host-closing");
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("");
    await send("explicit request"); await screen.findByRole("button", { name: "停止" });
    expect(f.calls.find((call) => call.action === "start")?.text).toBe("explicit request");
  });

  it("refuses an over-long draft locally, keeps the last saved one in the Host, and never truncates the editor", async () => {
    const f = setup(); const view = mount(f); await screen.findByText(/尚未开始/);
    const input = screen.getByRole("textbox", { name: "消息" });
    const within = "中".repeat(5461);
    fireEvent.change(input, { target: { value: within } });
    await waitFor(() => expect(f.drafts.get("task-a")).toMatchObject({ text: within }));
    const beyond = within + "中";
    fireEvent.change(input, { target: { value: beyond } });
    // Over the SDK cap: refused by name, and the Host still holds the last good draft.
    expect(await screen.findByText(/文字超过 16 KiB/)).toBeInTheDocument();
    expect(input).toHaveValue(beyond);
    expect(f.drafts.get("task-a")).toMatchObject({ text: within });
    view.unmount(); mount(f); await screen.findByText(/尚未开始/);
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue(within);
    expect(f.calls.filter((call) => call.action === "start")).toHaveLength(0);
  });

  it("quotes a Host draft-save refusal while keeping the independent receipt send usable", async () => {
    const f = setup(); mount(f); await screen.findByText(/尚未开始/);
    fireEvent.change(screen.getByRole("textbox", { name: "消息" }), { target: { value: "previous draft" } });
    await waitFor(() => expect(f.drafts.get("task-a")).toMatchObject({ text: "previous draft" }));
    const saved = f.drafts.get("task-a");
    f.setDraftSaveRefuse("invalid-payload: task/saveDraft.references[0].label must be a non-empty string");
    await send("new unsaved text"); await screen.findByRole("button", { name: "停止" });
    // The Host's own words, not a generic "storage unavailable".
    expect(screen.getByRole("alert")).toHaveTextContent("草稿未保存：invalid-payload: task/saveDraft.references[0].label");
    expect(screen.getByRole("alert")).toHaveTextContent("仍可编辑和发送");
    expect(f.drafts.get("task-a")).toEqual(saved);
    expect(f.calls.filter((call) => call.action === "start")[0]).toMatchObject({ text: "new unsaved text" });
    expect(localStorage.getItem("pidock-sdk-pending-v1:task-a:main")).not.toBeNull();
  });

  it("does not restore or save drafts before fresh identity verification, or for an unavailable task", async () => {
    const f = setup();
    // The Host already holds a draft for this task; an unavailable association
    // must keep it out of the composer AND keep this page from writing over it.
    f.drafts.set("task-a", { text: "saved task text" });
    f.invalidate(); mount(f);
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("");
    await screen.findByText(/任务或任务根已变化/);
    fireEvent.change(screen.getByRole("textbox", { name: "消息" }), { target: { value: "unverified edit" } });
    expect(f.drafts.get("task-a")).toEqual({ text: "saved task text" });
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
    // No Host draft record exists for this task: the retry text comes from the
    // local receipt, not from a saved draft.
    view.unmount(); f.drafts.delete("task-a"); f.setFail("");
    const reopened = mount(f); await screen.findByText(/请求状态未知/);
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("legacy request");
    fireEvent.click(screen.getByRole("button", { name: "按原 ID 重试" })); await screen.findByRole("button", { name: "停止" });
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("legacy request");
    f.setStatus(turn("task-a", String(first.requestId), "done"));
    act(() => f.emit({ kind: "sdk-turn-status", turn: turn("task-a", String(first.requestId), "done") }));
    await screen.findByText(/已从 SDK 历史核验/);
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("legacy request");
    // Still no draft record: the retry never became a saved draft on its own.
    expect(f.drafts.has("task-a")).toBe(false);
    reopened.unmount(); mount(f); await screen.findByText(/尚未开始/);
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("");
    expect(f.calls.filter((call) => call.action === "start")).toHaveLength(2);
  });

  it("keeps independent receipt sending usable when the Host refuses the draft read", async () => {
    const f = setup(); f.setDraftRefuse("task-host-closing");
    mount(f); await screen.findByText(/尚未开始/);
    expect(screen.getByRole("alert")).toHaveTextContent("草稿读取失败：task-host-closing");
    await send("explicit request"); await screen.findByRole("button", { name: "停止" });
    expect(f.calls.find((call) => call.action === "start")?.text).toBe("explicit request");
  });

  it("blocks sending when both the Host draft save and the local receipt write fail", async () => {
    const f = setup(); f.setDraftSaveRefuse("task-host-closing");
    mount(f); await screen.findByText(/尚未开始/);
    // The pending-receipt record is still this window's own storage.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    await send("unsaved draft and request");
    await screen.findByText("storage unavailable");
    expect(screen.getByText(/草稿未保存：task-host-closing/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("unsaved draft and request");
    expect(f.calls.filter((call) => call.action === "start")).toHaveLength(0);
  });

  it("shows this session's own SDK cumulative usage in the hover instead of a task ledger comparison", async () => {
    const f = setup();
    f.setMessages([{ role: "assistant", text: "reply", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 } }]);
    // [#139] The cumulative number is this SESSION's own SDK reading — the Host
    // sums this session's JSONL once, so a replayed message cannot be counted
    // twice. `turns` is the number of assistant replies it summed.
    f.setReadout(sessionReadout({ usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 30 }, turns: 3 }));
    mount(f);
    const usage = await screen.findByTestId("composer-usage");
    await waitFor(() => expect(usage.getAttribute("title")).toContain("本会话 SDK 累计：输入 100 / 输出 20 / 缓存读 900 / 写 30（3 条回复）"));
    expect(usage.getAttribute("title")).toContain("最近最多 80 条 SDK 消息；不是会话累计，可能不含更早用量。");
    // The visible label stays the bounded window's count, never the session total.
    expect(usage).toHaveTextContent("近期已报告输入+输出 120 tokens");
    expect(usage).not.toHaveTextContent(/本会话/);
  });

  it("names an unreported SDK usage as unknown in the hover rather than printing zeros", async () => {
    const f = setup();
    f.setMessages([{ role: "assistant", text: "reply", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 } }]);
    f.setReadout(sessionReadout({ usage: null, turns: 0 }));
    mount(f);
    const usage = await screen.findByTestId("composer-usage");
    await waitFor(() => expect(usage.getAttribute("title")).toContain("本会话 SDK 累计：SDK 未报告"));
    expect(usage.getAttribute("title")).not.toContain("输入 0 /");
    await waitFor(() => expect(usage).toHaveTextContent("近期已报告输入+输出 120 tokens"));
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
    expect(usage.getAttribute("title")).toContain("最近最多 80 条 SDK 消息；不是会话累计，可能不含更早用量。79 条助手消息未报告用量。");
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
    expect(localStorage.getItem("pidock-sdk-pending-v1:task-a:main")).toBeNull();
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
    expect(localStorage.getItem("pidock-sdk-pending-v1:task-a:main")).toBeNull();
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
    expect(localStorage.getItem("pidock-sdk-pending-v1:task-a:main")).toBeNull();
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
    expect(localStorage.getItem("pidock-sdk-pending-v1:task-a:main")).toBeNull();
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
    // [#117 第 7 项] The saved draft is Host state now, not a localStorage key.
    await waitFor(() => expect(f.drafts.get("task-a")).toMatchObject({ text: "saved text draft" }));
    const draft = f.drafts.get("task-a");
    await user.tab();
    const explanation = screen.getByLabelText("附件说明");
    expect(explanation).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("附件随消息提交：Host 只附上名称与来源行，内容不上传、不读取，Agent 拿到的是清单而不是文件");
    expect(explanation).toHaveAccessibleDescription("附件随消息提交：Host 只附上名称与来源行，内容不上传、不读取，Agent 拿到的是清单而不是文件");
    await user.keyboard("{Enter} ");
    expect(attachment).toBeEnabled();
    expect(input).toHaveValue("saved text draft");
    expect(f.drafts.get("task-a")).toEqual(draft);
    expect(localStorage.getItem("pidock-sdk-pending-v1:task-a:main")).toBeNull();
    expect(f.calls.some((call) => call.action === "start")).toBe(false);
    // The picker exists and is multi-select; choosing a file is page state only,
    // which `desktopAttachments.test.tsx` drives end to end.
    expect(document.querySelector('input[type="file"]')).toHaveAttribute("multiple");
  });

  it("keeps Provider navigation and SDK send/cancel available while naming a failed session read", async () => {
    const f = setup();
    // A Host that refuses the readout at all: the control says THAT, never 未接线.
    f.setTaskOp((_taskId, op) => (op === "task/sessionReadout" ? { ok: false, error: "host-closing" } : undefined));
    window.pidock = f.bridge;
    const onOpenProviders = vi.fn();
    render(<DesktopConversation taskId="task-a" name="Task" branch="task/main" repoCount={1} roots={JSON.stringify(roots)} association={JSON.stringify(association("task-a"))} onBack={vi.fn()} onOpenProviders={onOpenProviders} onArchived={vi.fn()} />);
    await screen.findByText(/尚未开始/);
    const reasoning = await screen.findByTestId("composer-reasoning");
    await waitFor(() => expect(reasoning).toHaveTextContent("推理档位读取失败"));
    expect(screen.getByTestId("composer-context")).toHaveTextContent("上下文 读取失败");
    expect(screen.queryByText("推理（未接线）")).toBeNull();
    expect(reasoning.getAttribute("title")).toContain("推理档位读取失败：host-closing");
    expect(onOpenProviders).not.toHaveBeenCalled();
    expect(f.calls.some((call) => call.action === "start")).toBe(false);
    await send("still connected");
    await screen.findByRole("button", { name: "停止" });
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(await screen.findByText(/已取消/)).toBeInTheDocument();
  });

  it("names the session's bound model in the pill instead of joining a provider name to it", async () => {
    // [#139] The pill shows THIS session's bound model; the Provider's own name is
    // no longer glued onto it, so a blank Host identity cannot leave ` · ` behind.
    const f = setup();
    f.bridge.providerOp = vi.fn(async () => ({ ok: true, payload: { state: "configured", profileId: "p-1", generation: 1, profiles: [{ id: "p-1", name: "", baseUrl: "https://models.example.test/v1", modelId: "", contextWindow: 128000, maxTokens: 8192, authRef: "PIDOCK_PROVIDER_EXAMPLE", generation: 1, credentialAvailable: true }] } }));
    const installed = mount(f);
    await waitFor(() => expect(screen.getByTestId("composer-model-name").textContent).toBe("Claude Sonnet"));
    installed.unmount();
    // A session with its own binding wins over the installed default.
    const bound = setup();
    bound.setReadout(sessionReadout({ session: sessionMain({ binding: { profileId: "p-1", modelId: "gpt-5-mini", thinkingLevel: "high", generation: 1 } }), model: { id: "gpt-5-mini", name: "GPT-5 mini", contextWindow: 128000, maxTokens: 8192, reasoning: true }, reasoningLevels: ["low", "high"] }));
    mount(bound);
    await waitFor(() => expect(screen.getByTestId("composer-model-name").textContent).toBe("GPT-5 mini"));
  });

  it("names the read as 未读取 until this session's readout answers", async () => {
    const f = setup();
    let release: ((value: { ok: true; payload: unknown }) => void) | undefined;
    f.setTaskOp((_taskId, op) => (op === "task/sessionReadout"
      ? new Promise<{ ok: true; payload: unknown }>((resolve) => { release = resolve; })
      : undefined));
    mount(f);
    // While the read is outstanding the control names that state: no level is
    // shown (not even the one the model would default to).
    const reasoning = await screen.findByTestId("composer-reasoning");
    await waitFor(() => expect(reasoning).toHaveTextContent("推理档位未读取"));
    expect(screen.getByTestId("composer-context")).toHaveTextContent("上下文 未读取");
    await act(async () => release!({ ok: true, payload: { workspaceId: "w", taskId: "task-a", op: "task/sessionReadout", payload: sessionReadout({ session: sessionMain({ binding: { profileId: "p-1", modelId: "claude-sonnet-4-5", thinkingLevel: "xhigh", generation: 1 } }), reasoningLevels: ["medium", "xhigh"] }) } }));
    // `xhigh` is a level only the Host's own answer can account for.
    await waitFor(() => expect(reasoning).toHaveTextContent("很高"));
    expect(within(reasoning).getByRole("button", { name: "很高" })).toHaveAttribute("aria-pressed", "true");
    // Only the levels this model declares are offered.
    expect(within(reasoning).getAllByRole("button").map((button) => button.textContent)).toEqual(["中", "很高"]);
  });

  it("sends the chosen level through the session reasoning op and applies the Host's post-write readout", async () => {
    const f = setup();
    const sent: Array<Record<string, unknown>> = [];
    f.setTaskOp((_taskId, op, payload) => {
      if (op === "task/sessionReasoning") {
        sent.push(payload);
        return { ok: true, payload: { workspaceId: "w", taskId: "task-a", op, payload: sessionReadout({ session: sessionMain({ binding: { profileId: "p-1", modelId: "claude-sonnet-4-5", thinkingLevel: "high", generation: 1 } }) }) } };
      }
      return undefined;
    });
    mount(f);
    const reasoning = await screen.findByTestId("composer-reasoning");
    await waitFor(() => expect(within(reasoning).getByRole("button", { name: "中" })).toBeInTheDocument());
    fireEvent.click(within(reasoning).getByRole("button", { name: "高" }));
    await waitFor(() => expect(within(reasoning).getByRole("button", { name: "高" })).toHaveAttribute("aria-pressed", "true"));
    expect(sent).toEqual([{ sessionId: "main", level: "high" }]);
  });

  it("shows the Host's own refusal wording for a level it declines, without faking success", async () => {
    const f = setup();
    f.setTaskOp((_taskId, op) => (op === "task/sessionReasoning" ? { ok: false, error: "thinking-level-not-declared: 模型未声明该推理档位：max" } : undefined));
    mount(f);
    const reasoning = await screen.findByTestId("composer-reasoning");
    await waitFor(() => expect(within(reasoning).getByRole("button", { name: "高" })).toBeInTheDocument());
    fireEvent.click(within(reasoning).getByRole("button", { name: "高" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("thinking-level-not-declared: 模型未声明该推理档位：max");
    expect(within(reasoning).getByRole("button", { name: "高" })).toHaveAttribute("aria-pressed", "false");
  });

  it("reads this session's context occupancy from its own SDK usage", async () => {
    const f = setup();
    f.setReadout(sessionReadout({ context: { used: 24800, window: 200000, source: "sdk-usage" }, usage: { input: 24800, output: 400, cacheRead: 0, cacheWrite: 0 }, turns: 1 }));
    mount(f);
    const context = await screen.findByTestId("composer-context");
    await waitFor(() => expect(context).toHaveTextContent("上下文 24.8k / 200k"));
    expect(context.getAttribute("title")).toContain("24800 tokens");
    expect(context.getAttribute("title")).toContain("来源 sdk-usage");
    expect(context.getAttribute("title")).toContain("绑定模型窗口 200000 tokens");
  });

  it("never renders an unknown occupancy as zero and never invents a percentage", async () => {
    const f = setup();
    f.setReadout(sessionReadout({ context: { used: null, window: null, source: "unknown" } }));
    mount(f);
    const context = await screen.findByTestId("composer-context");
    await waitFor(() => expect(context).toHaveTextContent("上下文 未报告 / 窗口未知"));
    expect(context).not.toHaveTextContent("0.0k");
    expect(context).not.toHaveTextContent("%");
    expect(context.getAttribute("title")).toContain("SDK 未报告时保持未知，不按 0 显示");
  });

  it("offers no fabricated `off` level to a model that declares no reasoning", async () => {
    const f = setup();
    f.setReadout(sessionReadout({ model: { id: "plain", name: "Plain", contextWindow: 128000, maxTokens: 4096, reasoning: false }, reasoningLevels: [] }));
    mount(f);
    const reasoning = await screen.findByTestId("composer-reasoning");
    await waitFor(() => expect(reasoning).toHaveTextContent("无推理档位"));
    expect(within(reasoning).queryAllByRole("button")).toEqual([]);
    expect(reasoning).not.toHaveTextContent("关闭");
  });

  it("shows 跟随模型 instead of naming a level when the session has no preference", async () => {
    const f = setup();
    mount(f);
    const reasoning = await screen.findByTestId("composer-reasoning");
    await waitFor(() => expect(reasoning.getAttribute("title")).toBe("推理 · 跟随模型"));
    // An empty binding level means "no session preference", not a level to guess.
    expect(within(reasoning).getAllByRole("button").every((button) => button.getAttribute("aria-pressed") === "false")).toBe(true);
  });

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
    // [#117 第 4 项] The dialog names the real scope: the Agent turn stops,
    // running services and terminals do not.
    expect(screen.getByRole("dialog", { name: "归档当前任务" }))
      .toHaveTextContent("归档只停止正在执行的 Agent 回合；已在运行的服务与终端不会被它停止");
    // The composer's own session-list/session-readout reads and the #24
    // execution-status read (`task/executionState`, read only) are not the dialog:
    // confirming is what may write, so no other op — and no write op at all — has
    // left the page here. The exact call set is pinned so a new op cannot slip in.
    // [Pencil T05] ticket 140 会话内的确认记录读取（`task/listApprovals`）也是只读，
    // 与执行读数一起被钉在同一个集合里。
    expect(taskOp.mock.calls.map(([, op]) => op).sort()).toEqual(["task/executionState", "task/listApprovals", "task/sessionList", "task/sessionReadout"]);
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
    // The status reads (会话列表/会话读数/执行状态) still issue nothing else:
    // the turn runs on the SDK channel, and no archive/cleanup op left the page.
    // [#139] The session list and this session's readout are reads too; no write op
    // (archive/cleanup/session mutation) left the page.
    expect(ops.filter((op) => !["task/sessionList", "task/sessionReadout", "task/executionState", "task/listApprovals"].includes(op))).toEqual([]);
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

  it("cold reopens exact SDK history, anchors a late-arriving stream and resyncs a real sequence gap", async () => {
    const f = setup();
    f.setMessages([{ role: "user", text: "earlier", usage: null }, { role: "assistant", text: "stored", usage: null }]);
    const view = mount(f);
    expect(await screen.findByText("stored")).toBeInTheDocument();
    expect(f.calls.find((call) => call.action === "subscribe")).toMatchObject({ taskId: "task-a", sessionId: "main" });
    await send("now");
    await waitFor(() => expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument());
    const requestId = String(f.calls.find((call) => call.action === "start")?.requestId);
    const emit = (sequence: number, text: string) => f.emit({ kind: "sdk-turn-event", event: { taskId: "task-a", sessionId: "main", turnId: turn("task-a", requestId).turnId, sequence, type: "delta", text } });
    const projections = f.calls.filter((call) => call.action === "projection").length;
    // [#138] The first observed delta of a turn anchors the baseline: sequence 2
    // (this page subscribed after 1) is staged instead of being called a gap.
    act(() => emit(2, "unverified-"));
    expect(await screen.findByText("unverified-")).toBeInTheDocument();
    expect(f.calls.filter((call) => call.action === "projection")).toHaveLength(projections);
    // A real hole after the baseline (2 then 4, 3 missing) is still resynced and
    // nothing is appended to the history.
    act(() => emit(4, "unverified-rest"));
    await waitFor(() => expect(f.calls.filter((call) => call.action === "projection")).toHaveLength(projections + 1));
    expect(screen.queryByText(/unverified/)).not.toBeInTheDocument();
    view.unmount();
    mount(f);
    expect(await screen.findByText("stored")).toBeInTheDocument();
    expect(screen.queryByText(/unverified/)).not.toBeInTheDocument();
  });

  it("streams a second turn whose deltas beat the ACK and whose sequence begins at 3", async () => {
    // [#138] Real Electron: the Host buffers a turn's deltas and replays them as
    // soon as it hands out the ACK, so the renderer can receive delta 1..n
    // BEFORE `start` has written `turnId`. The old gate dropped those and then
    // treated the first accepted delta (sequence > 1) as a gap, clearing the
    // staging on every delta — no turn after the first one ever streamed.
    const f = setup();
    mount(f);
    await screen.findByText(/尚未开始/);
    await send("first turn");
    await screen.findByRole("button", { name: "停止" });
    const firstId = String(f.calls.find((call) => call.action === "start")?.requestId);
    f.setStatus(turn("task-a", firstId, "done"));
    act(() => f.emit({ kind: "sdk-turn-status", turn: turn("task-a", firstId, "done") }));
    await screen.findByText(/已从 SDK 历史核验/);

    // Delay this turn's ACK so deltas can arrive first.
    const sdkTurn = f.bridge.sdkTurn!;
    let release: (() => void) | undefined;
    let pending: Record<string, unknown> | undefined;
    f.bridge.sdkTurn = (request) => {
      if (request.action !== "start") return sdkTurn(request);
      pending = request as unknown as Record<string, unknown>;
      return new Promise((resolve) => { release = () => { void sdkTurn(request).then(resolve); }; });
    };
    await send("second turn");
    await waitFor(() => expect(release).toBeDefined());
    const turnId = turn("task-a", String(pending!.requestId)).turnId;
    const emit = (sequence: number, text: string, id = turnId) =>
      act(() => f.emit({ kind: "sdk-turn-event", event: { taskId: "task-a", sessionId: "main", turnId: id, sequence, type: "delta", text } }));
    // Three deltas, starting at 3 (1 and 2 never reached this page), all before
    // the ACK: buffered, not dropped and not rendered as verified text.
    emit(3, "STREAM-B-3 ");
    emit(4, "STREAM-B-4 ");
    emit(5, "STREAM-B-5");
    expect(screen.queryByText(/STREAM-B/)).not.toBeInTheDocument();
    await act(async () => release!());
    await screen.findByRole("button", { name: "停止" });
    // The ACK replays them in sequence order: visible staged text at last.
    expect(await screen.findByText("STREAM-B-3 STREAM-B-4 STREAM-B-5")).toBeInTheDocument();
    // Duplicate/out-of-order replays do not wipe the staging.
    emit(5, "STREAM-B-5");
    emit(4, "STREAM-B-4 ");
    expect(screen.getByText("STREAM-B-3 STREAM-B-4 STREAM-B-5")).toBeInTheDocument();
    // The live stream continues from the anchored sequence.
    emit(6, " STREAM-B-6");
    expect(await screen.findByText("STREAM-B-3 STREAM-B-4 STREAM-B-5 STREAM-B-6")).toBeInTheDocument();
    // A delta belonging to another turn is still ignored.
    emit(7, " wrong", "00000000-0000-0000-0000-000000000000");
    expect(screen.queryByText(/wrong/)).not.toBeInTheDocument();
  });

  it("owns its scrolling so the composer stays reachable at 900 and 560 window heights", async () => {
    // [#138] 720×560 实测：`desktop-conversation` 高 ~239px、内容 ~512px，历史区的
    // `flex-1` 被顶部 `shrink-0` 区域挤到 0，composer 被面板的 `overflow-hidden` 裁掉，
    // 而祖先（包括 desktop-shell-content）没有可滚动区能到达它。
    // jsdom 没有布局，所以这里锁的是结构契约：面板自己拥有滚动区（历史连同任务头在
    // `overflow-y-auto` 内），composer 是该列最后一个 `shrink-0` 行；像素验证仍属于
    // 真实 Electron 采集（见 docs/evidence/pencil-v1-t03 README §5.4 的残留项）。
    const f = setup();
    f.setMessages(Array.from({ length: 40 }, (_, index) => ({ role: index % 2 === 0 ? "user" : "assistant", text: `message ${index}`, usage: null })));
    const view = mount(f);
    await screen.findByText("message 0");
    const panel = screen.getByTestId("desktop-conversation");
    // A definite-height column: it never grows with its content, and nothing in
    // it may be silently clipped instead of scrolled.
    expect(panel.className).toContain("h-full");
    expect(panel.className).toContain("min-h-0");
    expect(panel.className).toContain("flex-col");
    expect(panel.className).not.toContain("overflow-y-hidden");
    expect(panel.className).not.toMatch(/\bh-\[/);

    const scroller = screen.getByTestId("desktop-conversation-scroll");
    expect(scroller.className).toContain("overflow-y-auto");
    expect(scroller.className).toContain("flex-1");
    expect(scroller.className).toContain("min-h-0");
    expect(scroller.className).not.toContain("overflow-hidden");
    expect(panel.contains(scroller)).toBe(true);

    // The header, the session strip and the whole history scroll together, so
    // a short window loses none of them.
    expect(scroller.contains(screen.getByTestId("desktop-conversation-header"))).toBe(true);
    expect(scroller.contains(screen.getByTestId("desktop-session-strip"))).toBe(true);
    const history = screen.getByLabelText("SDK 对话历史");
    expect(scroller.contains(history)).toBe(true);
    const messages = [...history.querySelectorAll("article")];
    expect(messages).toHaveLength(40);
    for (const message of messages) expect(scroller.contains(message)).toBe(true);
    // No intermediate element opens a second scroller or a clipping box between
    // the messages and the panel's own scroll region.
    for (let node = history.parentElement; node && node !== panel; node = node.parentElement) {
      expect(node.className).not.toContain("overflow-hidden");
      // The only scroller in the chain is the panel's own scroll region.
      if (node !== scroller) expect(node.className).not.toContain("overflow-y-auto");
    }

    // The composer is pinned: the last `shrink-0` row of the same column that
    // owns the scroll region, a sibling of it, and not inside it.
    const form = screen.getByRole("textbox", { name: "消息" }).closest("form")!;
    expect(scroller.contains(form)).toBe(false);
    const composerRow = form.parentElement?.parentElement ?? null;
    expect(composerRow).not.toBeNull();
    expect(composerRow!.className).toContain("shrink-0");
    expect(composerRow!.previousElementSibling).toBe(scroller);
    expect(composerRow!.parentElement).toBe(scroller.parentElement);
    expect(scroller.parentElement!.className).toContain("flex-col");
    // Reachability does not depend on the window height: there is no pixel
    // height in the chain, so 560px only shrinks the scroll region (the
    // composer keeps its natural height) instead of clipping it.
    for (const height of [900, 560]) {
      Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
      fireEvent(window, new Event("resize"));
      expect(screen.getByRole("textbox", { name: "消息" })).toBeVisible();
      expect(composerRow!).toBeVisible();
      expect(scroller.isConnected).toBe(true);
    }
    view.unmount();
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
    await waitFor(() => expect(localStorage.getItem("pidock-sdk-pending-v1:task-a:main")).toBeNull());
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
    expect(localStorage.getItem("pidock-sdk-pending-v1:task-a:main")).toContain(nextId);
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
    expect(localStorage.getItem("pidock-sdk-pending-v1:task-a:main")!.length).toBeGreaterThan(18000);
    view.unmount(); f.setFail(""); mount(f);
    await screen.findByText(/请求状态未知/);
    fireEvent.click(screen.getByRole("button", { name: "按原 ID 重试" }));
    await waitFor(() => expect(f.calls.filter((call) => call.action === "start")).toHaveLength(2));
    expect(f.calls.filter((call) => call.action === "start")[1]).toMatchObject({ requestId: first.requestId, text });
  });

  it("blocks corrupt receipts and failed storage writes before start", async () => {
    localStorage.setItem("pidock-sdk-pending-v1:task-a:main", "{invalid");
    const f = setup(); const view = mount(f);
    expect(await screen.findByRole("alert")).toHaveTextContent("本机待确认请求记录不可读取");
    expect(await screen.findByText(/尚未开始/)).toBeInTheDocument();
    await send("blocked");
    expect(f.calls.filter((call) => call.action === "start")).toHaveLength(0);
    view.unmount(); localStorage.clear();
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith("pidock-sdk-pending-v1:")) throw new Error("storage unavailable");
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
