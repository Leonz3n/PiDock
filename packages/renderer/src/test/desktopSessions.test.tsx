/**
 * [#139] Pencil T04: one task, several real sessions — the renderer's side.
 *
 * The Host owns session identity (`.pidock-sessions.json`), the per-session
 * model/reasoning binding and the per-session SDK JSONL. What is pinned here is
 * that the UI never invents any of it:
 *
 *  - the sidebar tree and the conversation tabs show the sessions the Host
 *    reports, by name, with the active one marked;
 *  - 新建会话 goes through `task/sessionCreate` and then subscribes to the id the
 *    Host returned — no client-generated id, no "default session" fiction;
 *  - switching sessions re-subscribes and re-reads that session's own draft,
 *    readout and history: the other session's text is never delivered and no
 *    message crosses sessions;
 *  - the model pill and the reasoning segmented control send exactly the Host's
 *    own ops (`task/sessionModel` / `task/sessionReasoning`) and a refusal is
 *    quoted verbatim while the previous binding stays on screen;
 *  - the reasoning control offers only the levels the bound model declares, and
 *    no `off` is fabricated for a model without reasoning.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopConversation } from "../components/DesktopConversation";
import { DesktopShell } from "../components/DesktopShell";
import type { PidockBridge } from "../data/shellBridge";
import {
  activateSession, archiveSession, createSession, deleteSession, renameSession, restoreSession,
} from "../data/taskSessions";

const TASK_ID = "task-a";
const roots = [{ label: "默认任务根", state: "ready" }];
const association = { taskId: TASK_ID, projectId: null, state: "unassigned" };

type SessionRow = { id: string; name: string; createdAt: string; updatedAt: string; archived: boolean; permission: string; binding: null | { profileId: string; modelId: string; thinkingLevel: string | null; generation: number } };
const session = (id: string, name: string, overrides: Record<string, unknown> = {}): SessionRow => ({
  id, name, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
  archived: false, permission: "default", binding: null, ...overrides,
});
const SESSIONS = [session("main", "主会话"), session("s-1a2b3c4d", "重构认证", { binding: { profileId: "p-1", modelId: "model-large", thinkingLevel: "high", generation: 1 } })];
const MODELS = [
  { id: "model-large", name: "Large", contextWindow: 200000, maxTokens: 8192, reasoning: true, reasoningLevels: ["low", "medium", "high"] },
  { id: "model-fast", name: "Fast", contextWindow: 64000, maxTokens: 4096, reasoning: false, reasoningLevels: [] },
];
const provider = { profileId: "p-1", modelId: "model-large", generation: 1, models: MODELS };

type Readout = Record<string, unknown>;
const readoutOf = (id: string, overrides: Readout = {}, rows: SessionRow[] = SESSIONS, models: typeof MODELS = MODELS): Readout => {
  const row = rows.find((entry) => entry.id === id) ?? rows[0]!;
  const boundId = (row.binding as { modelId: string } | null)?.modelId ?? "model-large";
  const model = models.find((entry) => entry.id === boundId) ?? models[0]!;
  return {
    session: row, active: row.id === "main", model,
    reasoningLevels: model.reasoningLevels,
    context: { used: 1200, window: model.contextWindow, source: "sdk-usage" },
    usage: { input: 1200, output: 40, cacheRead: 0, cacheWrite: 0 }, turns: 1,
    transcriptModel: { provider: "pidock-p-1", modelId: boundId }, pending: false, interrupted: false,
    ...overrides,
  };
};

function setup(options: { sessions?: SessionRow[]; activeSessionId?: string | null; models?: typeof MODELS } = {}) {
  // [#139 hotfix] the declared model rows this fixture's Provider serves.
  const models = options.models ?? MODELS;
  const providerRow = { ...provider, models };
  let sessions = options.sessions ?? SESSIONS;
  let activeSessionId: string | null = options.activeSessionId === undefined ? "s-1a2b3c4d" : options.activeSessionId;
  const ops: Array<{ op: string; payload: Record<string, unknown> }> = [];
  const drafts = new Map<string, string>();
  const snapshots: Record<string, unknown[]> = { main: [{ role: "assistant", text: "main 会话的回答", usage: null }], "s-1a2b3c4d": [{ role: "assistant", text: "重构认证会话的回答", usage: null }] };
  // Every session this fixture reports is readable (a test may pass its own rows).
  const readable = new Set<string>(["main", "s-1a2b3c4d", ...(options.sessions ?? []).map((entry) => entry.id)]);
  const refusals: Record<string, string> = {};
  const sdkCalls: Array<Record<string, unknown>> = [];
  let subscriptions = 0;
  // [Pencil T04 hotfix] the real Host answers every write with the same provider
  // row it answers `task/sessionList` with; this switch reproduces an OLDER Host
  // that omits it, to prove the page merges instead of nulling the model menu.
  let writeProvider = true;

  const bridge: PidockBridge = {
    listTasks: vi.fn(async () => ({ ok: true, payload: { tasks: [{ taskId: TASK_ID, name: "Task", branch: "task/main", repoCount: 1, updatedAt: "now" }], roots } })),
    projectOp: vi.fn(async (request) => ({ ok: true, payload: request.op === "list" ? { initialized: true, projects: [] } : { roots, tasks: [association] } })),
    providerOp: vi.fn(async () => ({ ok: true, payload: { state: "not-configured", profileId: null, generation: null, profiles: [] } })),
    onSdkTurnEvent: vi.fn(() => () => undefined),
    sdkTurn: vi.fn(async (request: Record<string, unknown>) => {
      sdkCalls.push(request);
      const sessionId = String(request["sessionId"] ?? "");
      if (request["action"] === "subscribe") {
        subscriptions += 1;
        return { ok: true, payload: { taskId: TASK_ID, sessionId, snapshot: { source: "sdk-jsonl", sessionId, messages: snapshots[sessionId] ?? [], pending: false, interrupted: false }, turn: null } };
      }
      if (request["action"] === "projection") return { ok: true, payload: { source: "sdk-jsonl", sessionId, messages: snapshots[sessionId] ?? [], pending: false, interrupted: false } };
      if (request["action"] === "status") return { ok: true, payload: { turn: null } };
      return { ok: true, payload: { unsubscribed: true } };
    }),
    taskOp: vi.fn(async (_taskId: string, op: string, payload: Record<string, unknown> = {}) => {
      ops.push({ op, payload });
      const envelope = (inner: unknown) => ({ ok: true as const, payload: inner });
      const sessionId = String(payload["sessionId"] ?? "");
      const list = () => ({ activeSessionId, sessions, provider: providerRow });
      const writeList = () => (writeProvider ? list() : { activeSessionId, sessions });
      if (op === "task/sessionList") return envelope(list());
      if (op === "task/sessionReadout") {
        if (sessions.length === 0 || !readable.has(sessionId)) return { ok: false as const, error: "session-unknown" };
        const refusal = refusals[`readout:${sessionId}`];
        if (refusal) return { ok: false as const, error: refusal };
        return envelope(readoutOf(sessionId, {}, sessions, models));
      }
      if (op === "task/sessionCreate") {
        const created = session("s-9f9f9f9f", String(payload["name"] ?? "新会话"));
        sessions = [...sessions, created];
        activeSessionId = created.id;
        readable.add(created.id);
        snapshots[created.id] = [];
        return envelope({ session: created, ...writeList() });
      }
      if (op === "task/sessionActivate") {
        activeSessionId = sessionId;
        return envelope(writeList());
      }
      if (op === "task/sessionRename") {
        sessions = sessions.map((entry) => (entry.id === sessionId ? { ...entry, name: String(payload["name"]) } : entry));
        return envelope(writeList());
      }
      if (op === "task/sessionArchive") {
        sessions = sessions.map((entry) => (entry.id === sessionId ? { ...entry, archived: true } : entry));
        if (activeSessionId === sessionId) activeSessionId = sessions.find((entry) => !entry.archived)?.id ?? null;
        return envelope(writeList());
      }
      if (op === "task/sessionRestore") {
        sessions = sessions.map((entry) => (entry.id === sessionId ? { ...entry, archived: false } : entry));
        return envelope(writeList());
      }
      if (op === "task/sessionDelete") {
        sessions = sessions.filter((entry) => entry.id !== sessionId);
        if (activeSessionId === sessionId) activeSessionId = sessions.find((entry) => !entry.archived)?.id ?? null;
        return envelope(writeList());
      }
      if (op === "task/sessionModel") {
        const refusal = refusals["model"];
        if (refusal) return { ok: false as const, error: refusal };
        const modelId = String(payload["modelId"]);
        const level = payload["thinkingLevel"] === undefined ? null : String(payload["thinkingLevel"]);
        sessions = sessions.map((entry) => (entry.id === sessionId ? { ...entry, binding: { profileId: "p-1", modelId, thinkingLevel: level, generation: 1 } } : entry));
        return envelope(readoutOf(sessionId, {}, sessions, models));
      }
      if (op === "task/sessionReasoning") {
        const level = String(payload["level"]);
        sessions = sessions.map((entry) => (entry.id === sessionId ? { ...entry, binding: { profileId: "p-1", modelId: (entry.binding as { modelId: string } | null)?.modelId ?? "model-large", thinkingLevel: level, generation: 1 } } : entry));
        return envelope(readoutOf(sessionId, {}, sessions, models));
      }
      if (op === "task/readDraft") return envelope({ sessionId, draft: drafts.has(sessionId) ? { text: drafts.get(sessionId), references: [] } : null });
      if (op === "task/saveDraft") { drafts.set(sessionId, String(payload["text"])); return envelope({ sessionId }); }
      if (op === "task/clearDraft") { drafts.delete(sessionId); return envelope({ sessionId }); }
      return { ok: true, payload: {} };
    }),
  };
  return { bridge, ops, drafts, snapshots, refusals, sdkCalls, subscriptions: () => subscriptions, omitWriteProvider: () => { writeProvider = false; } };
}

/** The model name a menu row starts with (the window/levels span follows it directly). */
const rowName = (row: HTMLElement) => row.textContent?.replace(/(\d|·).*$/, "") ?? "";

function mount(fixture: ReturnType<typeof setup>) {
  window.pidock = fixture.bridge;
  return render(<DesktopConversation taskId={TASK_ID} name="Task" branch="task/main" repoCount={1} roots={JSON.stringify(roots)} association={JSON.stringify(association)} onBack={vi.fn()} onOpenProviders={vi.fn()} onArchived={vi.fn()} />);
}

afterEach(() => { cleanup(); localStorage.clear(); delete (window as { pidock?: unknown }).pidock; vi.restoreAllMocks(); });

describe("[#139] task sessions in the conversation", () => {
  it("shows the Host's sessions as named tabs with the active one marked", async () => {
    const fixture = setup();
    mount(fixture);
    const tabs = await screen.findByTestId("desktop-session-strip");
    await waitFor(() => expect(within(tabs).getByRole("tab", { name: "重构认证" })).toHaveAttribute("aria-selected", "true"));
    expect(within(tabs).getByRole("tab", { name: "主会话" })).toHaveAttribute("aria-selected", "false");
    // The active session is the one subscribed and the one read.
    expect(fixture.sdkCalls.filter((call) => call["action"] === "subscribe").map((call) => call["sessionId"]))
      .toEqual(["s-1a2b3c4d"]);
    expect(fixture.ops.filter((entry) => entry.op === "task/sessionReadout").map((entry) => entry.payload["sessionId"]))
      .toEqual(["s-1a2b3c4d"]);
    expect(screen.getByTestId("desktop-session-identity")).toHaveTextContent("会话 · 重构认证");
    // The header names this session's model, reasoning level and context next to
    // its name; the composer carries the same three as controls.
    expect(screen.getByTestId("desktop-session-model")).toHaveTextContent("模型 · Large");
    await waitFor(() => expect(screen.getByTestId("desktop-session-reasoning")).toHaveTextContent("推理 · 高"));
    await waitFor(() => expect(screen.getByTestId("desktop-session-context")).toHaveTextContent("上下文 1.2k / 200k"));
  });

  it("creates a session through the Host and subscribes to the id the Host returned", async () => {
    const fixture = setup();
    mount(fixture);
    await screen.findByRole("tab", { name: "主会话" });
    fireEvent.click(screen.getByTestId("session-new"));
    await waitFor(() => expect(fixture.ops.some((entry) => entry.op === "task/sessionCreate")).toBe(true));
    // A brand-new session starts empty: nothing of the previous session's
    // transcript is shown, and no client-side id was invented.
    await waitFor(() => expect(fixture.sdkCalls.filter((call) => call["action"] === "subscribe").map((call) => call["sessionId"]))
      .toEqual(["s-1a2b3c4d", "s-9f9f9f9f"]));
    expect(screen.queryByText("重构认证会话的回答")).not.toBeInTheDocument();
    expect(await screen.findByText(/尚未开始/)).toBeInTheDocument();
    expect(within(screen.getByTestId("desktop-session-strip")).getByRole("tab", { name: "新会话" })).toHaveAttribute("aria-selected", "true");
  });

  it("keeps each session's draft and never delivers one session's text into another", async () => {
    const fixture = setup();
    mount(fixture);
    const input = await screen.findByRole("textbox", { name: "消息" });
    // Typing only writes a draft once the session is subscribed.
    expect(await screen.findByText("重构认证会话的回答")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "重构认证的草稿" } });
    await waitFor(() => expect(fixture.drafts.get("s-1a2b3c4d")).toBe("重构认证的草稿"));

    fireEvent.click(screen.getByRole("tab", { name: "主会话" }));
    await waitFor(() => expect(fixture.ops.some((entry) => entry.op === "task/sessionActivate" && entry.payload["sessionId"] === "main")).toBe(true));
    // The other session's text is gone (its own draft record is untouched), and
    // the switched-to session shows ITS history, not the previous one.
    await waitFor(() => expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue(""));
    expect(await screen.findByText("main 会话的回答")).toBeInTheDocument();
    expect(screen.queryByText("重构认证会话的回答")).not.toBeInTheDocument();
    expect(fixture.drafts.get("s-1a2b3c4d")).toBe("重构认证的草稿");
    // Going back restores that session's own draft from the Host.
    fireEvent.change(screen.getByRole("textbox", { name: "消息" }), { target: { value: "主会话的草稿" } });
    await waitFor(() => expect(fixture.drafts.get("main")).toBe("主会话的草稿"));
    fireEvent.click(screen.getByRole("tab", { name: "重构认证" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("重构认证的草稿"));
    expect(fixture.drafts.get("main")).toBe("主会话的草稿");
    // No turn was started by any of this.
    expect(fixture.sdkCalls.some((call) => call["action"] === "start")).toBe(false);
  });

  it("switches the model through the session op, keeping the same session subscribed", async () => {
    const fixture = setup();
    mount(fixture);
    await screen.findByRole("tab", { name: "重构认证" });
    expect(screen.getByTestId("composer-model-name")).toHaveTextContent("Large");
    const before = fixture.sdkCalls.filter((call) => call["action"] === "subscribe").length;
    fireEvent.click(screen.getByTestId("composer-model"));
    fireEvent.click(within(screen.getByRole("menu", { name: "会话模型" })).getByRole("menuitemradio", { name: /Fast/ }));
    await waitFor(() => expect(fixture.ops.some((entry) => entry.op === "task/sessionModel" && entry.payload["modelId"] === "model-fast")).toBe(true));
    // Same session identity: switching the model is a binding change, not a new
    // conversation, so no re-subscribe and no history reset happened.
    expect(fixture.sdkCalls.filter((call) => call["action"] === "subscribe").length).toBe(before);
    expect(screen.getByText("重构认证会话的回答")).toBeInTheDocument();
    // The new model declares no reasoning levels: the control offers none and
    // never fabricates `off`.
    const reasoning = await screen.findByTestId("composer-reasoning");
    await waitFor(() => expect(reasoning).toHaveTextContent("无推理档位"));
    expect(within(reasoning).queryAllByRole("button")).toEqual([]);
    expect(screen.getByTestId("composer-model-name")).toHaveTextContent("Fast");
  });

  /**
   * [#139 hotfix] The evidence defect: a session WRITE reply used to carry only
   * `{activeSessionId, sessions}`; the page replaced its whole list with it, so
   * `provider` became `null` and the model menu said 切换模型不可用 until a
   * remount. Every write now answers with the same provider row as
   * `task/sessionList` (and the page merges a partial reply), so the menu keeps
   * working after switching, creating, renaming, archiving, restoring, deleting.
   */
  it("keeps the model menu usable after switching and after every session write", async () => {
    const fixture = setup();
    mount(fixture);
    await screen.findByRole("tab", { name: "主会话" });
    const expectModelMenu = async (label: string) => {
      fireEvent.click(screen.getByTestId("composer-model"));
      const menu = await screen.findByRole("menu", { name: "会话模型" });
      expect({ label, rows: within(menu).getAllByRole("menuitemradio").map((row) => rowName(row)) })
        .toEqual({ label, rows: ["Large", "Fast"] });
      fireEvent.click(screen.getByTestId("composer-model"));
      await waitFor(() => expect(screen.queryByRole("menu", { name: "会话模型" })).not.toBeInTheDocument());
    };
    await expectModelMenu("initial");

    // activate
    fireEvent.click(screen.getByRole("tab", { name: "主会话" }));
    await waitFor(() => expect(fixture.ops.some((entry) => entry.op === "task/sessionActivate")).toBe(true));
    await expectModelMenu("activate");

    // create
    fireEvent.click(screen.getByTestId("session-new"));
    await waitFor(() => expect(fixture.ops.some((entry) => entry.op === "task/sessionCreate")).toBe(true));
    await screen.findByRole("tab", { name: "新会话" });
    await expectModelMenu("create");

    // rename the new session through the 全部会话 panel
    fireEvent.click(screen.getByTestId("session-all"));
    let row = await screen.findByTestId("session-row-s-9f9f9f9f");
    fireEvent.click(within(row).getByRole("button", { name: "重命名" }));
    fireEvent.change(within(row).getByRole("textbox", { name: "会话名称" }), { target: { value: "改过的名字" } });
    fireEvent.click(within(row).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(fixture.ops.some((entry) => entry.op === "task/sessionRename")).toBe(true));
    await expectModelMenu("rename");

    // archive the current session (the page moves to the next real one)
    row = screen.getByTestId("session-row-s-9f9f9f9f");
    fireEvent.click(within(row).getByRole("button", { name: "归档" }));
    await waitFor(() => expect(fixture.ops.some((entry) => entry.op === "task/sessionArchive")).toBe(true));
    await expectModelMenu("archive");

    // restore it
    row = await screen.findByTestId("session-row-s-9f9f9f9f");
    fireEvent.click(within(row).getByRole("button", { name: "恢复" }));
    await waitFor(() => expect(fixture.ops.some((entry) => entry.op === "task/sessionRestore")).toBe(true));
    await expectModelMenu("restore");

    // delete it
    row = screen.getByTestId("session-row-s-9f9f9f9f");
    fireEvent.click(within(row).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(fixture.ops.some((entry) => entry.op === "task/sessionDelete")).toBe(true));
    await expectModelMenu("delete");
  });

  it("merges a partial write reply instead of emptying the model menu", async () => {
    const fixture = setup();
    // An older/partial Host reply: the page must keep the provider it read.
    fixture.omitWriteProvider();
    mount(fixture);
    await screen.findByRole("tab", { name: "主会话" });
    fireEvent.click(screen.getByRole("tab", { name: "主会话" }));
    await waitFor(() => expect(fixture.ops.some((entry) => entry.op === "task/sessionActivate")).toBe(true));
    fireEvent.click(screen.getByTestId("session-new"));
    await waitFor(() => expect(fixture.ops.some((entry) => entry.op === "task/sessionCreate")).toBe(true));
    fireEvent.click(screen.getByTestId("composer-model"));
    const menu = await screen.findByRole("menu", { name: "会话模型" });
    expect(within(menu).getAllByRole("menuitemradio").map((row) => rowName(row))).toEqual(["Large", "Fast"]);
    // And the switch itself still reaches the Host.
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /Fast/ }));
    await waitFor(() => expect(fixture.ops.some((entry) => entry.op === "task/sessionModel" && entry.payload["modelId"] === "model-fast")).toBe(true));
  });

  it("shows declared windows honestly: 8 stays 8, never 0k", async () => {
    const windowModels = [
      { id: "model-tiny", name: "Tiny", contextWindow: 8, maxTokens: 8, reasoning: false, reasoningLevels: [] },
      { id: "model-odd", name: "Odd", contextWindow: 999, maxTokens: 64, reasoning: false, reasoningLevels: [] },
      { id: "model-small", name: "Small", contextWindow: 1024, maxTokens: 128, reasoning: false, reasoningLevels: [] },
      { id: "model-large", name: "Large", contextWindow: 131072, maxTokens: 8192, reasoning: true, reasoningLevels: ["low"] },
    ];
    const tiny = session("s-12121212", "迷你窗口", { binding: { profileId: "p-1", modelId: "model-tiny", thinkingLevel: null, generation: 1 } });
    const fixture = setup({ models: windowModels, sessions: [...SESSIONS, tiny], activeSessionId: tiny.id });
    mount(fixture);
    await screen.findByRole("tab", { name: "主会话" });
    // The bound model's real window, in the header and the composer.
    await waitFor(() => expect(screen.getByTestId("composer-context")).toHaveTextContent("1.2k / 8"));
    const context = screen.getByTestId("composer-context");
    expect(context.textContent).not.toContain("0k");
    expect(context.getAttribute("title")).toContain("绑定模型窗口 8 tokens");
    // Every row in the menu names its own declared window.
    fireEvent.click(screen.getByTestId("composer-model"));
    const menu = await screen.findByRole("menu", { name: "会话模型" });
    const labels = within(menu).getAllByRole("menuitemradio").map((row) => row.textContent);
    expect(labels).toEqual([
      expect.stringContaining("8 · 无推理档位"),
      expect.stringContaining("999 · 无推理档位"),
      expect.stringContaining("1k · 无推理档位"),
      expect.stringContaining("131k · 1 档"),
    ]);
    expect(labels.join(" ")).not.toContain("0k");
  });

  it("names an unbound session as 未绑定模型 instead of claiming the model lacks reasoning", async () => {
    // No Provider installed: the Host reports `model: null`, `reasoningLevels: []`.
    // That is "nothing bound", not "the model does not support reasoning".
    const fixture = setup({ activeSessionId: "main" });
    fixture.bridge.taskOp = vi.fn(async (_taskId: string, op: string) => {
      if (op === "task/sessionList") return { ok: true as const, payload: { activeSessionId: "main", sessions: [session("main", "主会话")], provider: null } };
      if (op === "task/sessionReadout") return { ok: true as const, payload: readoutOf("main", { model: null, reasoningLevels: [], context: { used: null, window: null, source: "unknown" } }) };
      return { ok: true as const, payload: {} };
    });
    mount(fixture);
    await screen.findByRole("tab", { name: "主会话" });
    await waitFor(() => expect(screen.getByTestId("desktop-session-model")).toHaveTextContent("模型 · 未绑定模型"));
    expect(screen.getByTestId("desktop-session-reasoning")).toHaveTextContent("推理 · 未绑定模型");
    expect(screen.getByTestId("composer-model-name")).toHaveTextContent("未绑定模型");
    const reasoning = screen.getByTestId("composer-reasoning");
    expect(reasoning).toHaveTextContent("未绑定模型");
    expect(reasoning).not.toHaveTextContent("该模型不支持");
    expect(reasoning).not.toHaveTextContent("无推理档位");
  });

  it("quotes the Host's busy refusal by name and keeps the previous binding", async () => {
    const fixture = setup();
    fixture.refusals["model"] = "sdk-session-busy: 该会话正在执行回合，稍后再切换模型";
    mount(fixture);
    await screen.findByRole("tab", { name: "重构认证" });
    fireEvent.click(screen.getByTestId("composer-model"));
    fireEvent.click(within(screen.getByRole("menu", { name: "会话模型" })).getByRole("menuitemradio", { name: /Fast/ }));
    expect(await screen.findByText("sdk-session-busy: 该会话正在执行回合，稍后再切换模型")).toBeInTheDocument();
    // The pill still names the OLD model: a refused switch is not applied.
    expect(screen.getByTestId("composer-model-name")).toHaveTextContent("Large");
  });

  it("lists archived sessions in the session list and offers restore instead of activating them", async () => {
    const archived = [...SESSIONS, session("s-77777777", "旧尝试", { archived: true })];
    const fixture = setup({ sessions: archived });
    mount(fixture);
    await screen.findByRole("tab", { name: "主会话" });
    // Archived sessions are not tabs; they are in the list.
    expect(screen.queryByRole("tab", { name: "旧尝试" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("session-all"));
    const row = await screen.findByTestId("session-row-s-77777777");
    expect(row).toHaveTextContent("已归档");
    expect(within(row).getByRole("button", { name: "继续对话" })).toBeDisabled();
    fireEvent.click(within(row).getByRole("button", { name: "恢复" }));
    await waitFor(() => expect(fixture.ops.some((entry) => entry.op === "task/sessionRestore" && entry.payload["sessionId"] === "s-77777777")).toBe(true));
    expect(await screen.findByRole("tab", { name: "旧尝试" })).toBeInTheDocument();
  });
  it("names a task with no sessions and offers 新建会话 instead of subscribing to an id it lacks", async () => {
    const fixture = setup({ sessions: [], activeSessionId: null });
    mount(fixture);
    expect(await screen.findByTestId("desktop-sessions-empty")).toHaveTextContent("本任务暂无会话");
    // No subscribe for a session that does not exist: the page states the state.
    expect(fixture.sdkCalls.filter((call) => call["action"] === "subscribe")).toEqual([]);
    expect(await screen.findByText(/本任务暂无会话：新建一个会话后才能对话/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("session-new"));
    await waitFor(() => expect(fixture.sdkCalls.filter((call) => call["action"] === "subscribe").map((call) => call["sessionId"])).toEqual(["s-9f9f9f9f"]));
    expect(await screen.findByText(/尚未开始/)).toBeInTheDocument();
  });
});

describe("[#139] the sidebar session tree", () => {
  it("shows the selected task's Host sessions with the active marker and navigates by session id", async () => {
    const fixture = setup();
    window.pidock = fixture.bridge;
    const onNavigate = vi.fn();
    render(
      <DesktopShell
        view={{ view: "task", taskId: TASK_ID }}
        onNavigate={onNavigate}
        projects={[]}
        projectsInitialized
        unassignedCount={0}
        tasks={[{ taskId: TASK_ID, name: "Task", branch: "task/main", repoCount: 1, updatedAt: "2026-01-02", projectId: null }]}
        allTaskCount={1}
        lifecyclePending={false}
        lifecycleErrors={[]}
        roots={[]}
        rootRetry={{ busy: false, pending: false, error: null, run: vi.fn() }}
        breadcrumb={{}}
      >
        <div />
      </DesktopShell>,
    );
    await waitFor(() => expect(document.querySelector("[data-session-tree]")).not.toBeNull());
    const rows = Array.from(document.querySelectorAll("[data-session-nav]"));
    expect(rows.map((row) => row.textContent)).toEqual(["主会话", "重构认证"]);
    // The Host's active pointer marks the active row.
    expect(document.querySelector('[data-session-nav="s-1a2b3c4d"]')).toHaveAttribute("aria-current", "true");
    fireEvent.click(document.querySelector('[data-session-nav="main"]') as HTMLElement);
    expect(onNavigate).toHaveBeenCalledWith({ view: "task", taskId: TASK_ID, sessionId: "main" });
    expect(fixture.ops.some((entry) => entry.op === "task/sessionList")).toBe(true);
  });

  /**
   * [#139 hotfix] The evidence caught the sidebar's rows stale: `TaskSessionRows`
   * read on `[taskId]` only, so a session created (or renamed/archived/...) in the
   * conversation was missing until the task was re-selected. Every accepted write
   * now announces its task and this row list re-reads the Host's index.
   */
  it("re-reads the rows after create, rename, archive, restore, activate and delete", async () => {
    const fixture = setup();
    window.pidock = fixture.bridge;
    render(
      <DesktopShell
        view={{ view: "task", taskId: TASK_ID }}
        onNavigate={vi.fn()}
        projects={[]}
        projectsInitialized
        unassignedCount={0}
        tasks={[{ taskId: TASK_ID, name: "Task", branch: "task/main", repoCount: 1, updatedAt: "2026-01-02", projectId: null }]}
        allTaskCount={1}
        lifecyclePending={false}
        lifecycleErrors={[]}
        roots={[]}
        rootRetry={{ busy: false, pending: false, error: null, run: vi.fn() }}
        breadcrumb={{}}
      >
        <div />
      </DesktopShell>,
    );
    const row = (id: string) => document.querySelector(`[data-session-nav="${id}"]`);
    const reads = () => fixture.ops.filter((entry) => entry.op === "task/sessionList").length;
    await waitFor(() => expect(document.querySelectorAll("[data-session-nav]")).toHaveLength(2));

    await createSession(TASK_ID, { name: "第四会话" });
    await waitFor(() => expect(row("s-9f9f9f9f")?.textContent).toBe("第四会话"));

    await renameSession(TASK_ID, "s-9f9f9f9f", "改过的名字");
    await waitFor(() => expect(row("s-9f9f9f9f")?.textContent).toBe("改过的名字"));

    await archiveSession(TASK_ID, "s-9f9f9f9f");
    await waitFor(() => expect(row("s-9f9f9f9f")).toBeNull());

    await restoreSession(TASK_ID, "s-9f9f9f9f");
    await waitFor(() => expect(row("s-9f9f9f9f")?.textContent).toBe("改过的名字"));

    const before = reads();
    await activateSession(TASK_ID, "s-9f9f9f9f");
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    expect(row("s-9f9f9f9f")).not.toBeNull();

    await deleteSession(TASK_ID, "s-9f9f9f9f");
    await waitFor(() => expect(row("s-9f9f9f9f")).toBeNull());
    expect(document.querySelectorAll("[data-session-nav]")).toHaveLength(2);
  });

  it("names a failed session-list read in the sidebar instead of showing an empty tree", async () => {
    const fixture = setup();
    fixture.bridge.taskOp = vi.fn(async () => ({ ok: false as const, error: "sessions.json 损坏" }));
    window.pidock = fixture.bridge;
    render(
      <DesktopShell
        view={{ view: "task", taskId: TASK_ID }}
        onNavigate={vi.fn()}
        projects={[]}
        projectsInitialized
        unassignedCount={0}
        tasks={[{ taskId: TASK_ID, name: "Task", branch: "task/main", repoCount: 1, updatedAt: "2026-01-02", projectId: null }]}
        allTaskCount={1}
        lifecyclePending={false}
        lifecycleErrors={[]}
        roots={[]}
        rootRetry={{ busy: false, pending: false, error: null, run: vi.fn() }}
        breadcrumb={{}}
      >
        <div />
      </DesktopShell>,
    );
    expect(await screen.findByText(/会话列表读取失败：sessions\.json 损坏/)).toBeInTheDocument();
    expect(document.querySelectorAll("[data-session-nav]")).toHaveLength(0);
  });
});
