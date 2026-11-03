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
const readoutOf = (id: string, overrides: Readout = {}, rows: SessionRow[] = SESSIONS): Readout => {
  const row = rows.find((entry) => entry.id === id) ?? rows[0]!;
  const boundId = (row.binding as { modelId: string } | null)?.modelId ?? "model-large";
  const model = MODELS.find((entry) => entry.id === boundId)!;
  return {
    session: row, active: row.id === "main", model,
    reasoningLevels: model.reasoningLevels,
    context: { used: 1200, window: model.contextWindow, source: "sdk-usage" },
    usage: { input: 1200, output: 40, cacheRead: 0, cacheWrite: 0 }, turns: 1,
    transcriptModel: { provider: "pidock-p-1", modelId: boundId }, pending: false, interrupted: false,
    ...overrides,
  };
};

function setup(options: { sessions?: SessionRow[]; activeSessionId?: string | null } = {}) {
  let sessions = options.sessions ?? SESSIONS;
  let activeSessionId: string | null = options.activeSessionId === undefined ? "s-1a2b3c4d" : options.activeSessionId;
  const ops: Array<{ op: string; payload: Record<string, unknown> }> = [];
  const drafts = new Map<string, string>();
  const snapshots: Record<string, unknown[]> = { main: [{ role: "assistant", text: "main 会话的回答", usage: null }], "s-1a2b3c4d": [{ role: "assistant", text: "重构认证会话的回答", usage: null }] };
  const readable = new Set<string>(["main", "s-1a2b3c4d"]);
  const refusals: Record<string, string> = {};
  const sdkCalls: Array<Record<string, unknown>> = [];
  let subscriptions = 0;

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
      const list = () => ({ activeSessionId, sessions, provider });
      if (op === "task/sessionList") return envelope(list());
      if (op === "task/sessionReadout") {
        if (!readable.has(sessionId)) return { ok: false as const, error: "session-unknown" };
        const refusal = refusals[`readout:${sessionId}`];
        if (refusal) return { ok: false as const, error: refusal };
        return envelope(readoutOf(sessionId, {}, sessions));
      }
      if (op === "task/sessionCreate") {
        const created = session("s-9f9f9f9f", String(payload["name"] ?? "新会话"));
        sessions = [...sessions, created];
        activeSessionId = created.id;
        readable.add(created.id);
        snapshots[created.id] = [];
        return envelope({ session: created, activeSessionId, sessions });
      }
      if (op === "task/sessionActivate") {
        activeSessionId = sessionId;
        return envelope(list());
      }
      if (op === "task/sessionRename") {
        sessions = sessions.map((entry) => (entry.id === sessionId ? { ...entry, name: String(payload["name"]) } : entry));
        return envelope(list());
      }
      if (op === "task/sessionArchive") {
        sessions = sessions.map((entry) => (entry.id === sessionId ? { ...entry, archived: true } : entry));
        if (activeSessionId === sessionId) activeSessionId = sessions.find((entry) => !entry.archived)?.id ?? null;
        return envelope(list());
      }
      if (op === "task/sessionRestore") {
        sessions = sessions.map((entry) => (entry.id === sessionId ? { ...entry, archived: false } : entry));
        return envelope(list());
      }
      if (op === "task/sessionDelete") {
        sessions = sessions.filter((entry) => entry.id !== sessionId);
        if (activeSessionId === sessionId) activeSessionId = sessions.find((entry) => !entry.archived)?.id ?? null;
        return envelope(list());
      }
      if (op === "task/sessionModel") {
        const refusal = refusals["model"];
        if (refusal) return { ok: false as const, error: refusal };
        const modelId = String(payload["modelId"]);
        const level = payload["thinkingLevel"] === undefined ? null : String(payload["thinkingLevel"]);
        sessions = sessions.map((entry) => (entry.id === sessionId ? { ...entry, binding: { profileId: "p-1", modelId, thinkingLevel: level, generation: 1 } } : entry));
        return envelope(readoutOf(sessionId, {}, sessions));
      }
      if (op === "task/sessionReasoning") {
        const level = String(payload["level"]);
        sessions = sessions.map((entry) => (entry.id === sessionId ? { ...entry, binding: { profileId: "p-1", modelId: (entry.binding as { modelId: string } | null)?.modelId ?? "model-large", thinkingLevel: level, generation: 1 } } : entry));
        return envelope(readoutOf(sessionId, {}, sessions));
      }
      if (op === "task/readDraft") return envelope({ sessionId, draft: drafts.has(sessionId) ? { text: drafts.get(sessionId), references: [] } : null });
      if (op === "task/saveDraft") { drafts.set(sessionId, String(payload["text"])); return envelope({ sessionId }); }
      if (op === "task/clearDraft") { drafts.delete(sessionId); return envelope({ sessionId }); }
      return { ok: true, payload: {} };
    }),
  };
  return { bridge, ops, drafts, snapshots, refusals, sdkCalls, subscriptions: () => subscriptions };
}

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
