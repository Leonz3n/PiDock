/**
 * #167 regression: a conversation selects a pair from the GLOBAL Provider
 * catalog, and a model-switch error never reshapes the composer.
 *
 * The Host's task-level installed Provider is deliberately a different profile
 * than the session's binding here: the red case from #167.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopConversation } from "../components/DesktopConversation";
import type { PidockBridge } from "../data/shellBridge";

const taskId = "task-a";
const roots = [{ label: "默认任务根", state: "ready" }];
const association = { taskId, projectId: null, state: "unassigned" };

const PROFILE_A = {
  id: "p-11111111-1111-1111-1111-111111111111",
  name: "Anthropic 官方",
  notes: null,
  protocol: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  models: [
    { id: "claude-sonnet-4-5", name: "Claude Sonnet", contextWindow: 200000, maxTokens: 8192, reasoning: true, reasoningLevels: ["low", "medium", "high"], cost: null },
    { id: "claude-haiku-4-5", name: "Claude Haiku", contextWindow: 200000, maxTokens: 8192, reasoning: false, reasoningLevels: ["off"], cost: null },
  ],
  modelId: "claude-sonnet-4-5",
  thinkingLevel: "high",
  contextWindow: 200000,
  maxTokens: 8192,
  credentialSource: "store",
  credentialAvailable: true,
  authRef: "p-11111111-1111-1111-1111-111111111111",
  generation: 1,
  native: { providerId: "pidock-p-11111111-1111-1111-1111-111111111111", state: "synced" },
};
const PROFILE_B = {
  ...PROFILE_A,
  id: "p-22222222-2222-2222-2222-222222222222",
  name: "OpenAI 官方",
  protocol: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  models: [
    { id: "gpt-5", name: "GPT-5", contextWindow: 400000, maxTokens: 128000, reasoning: true, reasoningLevels: ["low", "medium", "high"], cost: null },
  ],
  modelId: "gpt-5",
  contextWindow: 400000,
  maxTokens: 128000,
  authRef: "p-22222222-2222-2222-2222-222222222222",
  native: { providerId: "pidock-p-22222222-2222-2222-2222-222222222222", state: "synced" },
};

const session = {
  id: "main", name: "主会话", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
  archived: false, permission: "default",
  // The session was originally bound to A's model; the task installed B later.
  binding: { profileId: PROFILE_A.id, modelId: "claude-sonnet-4-5", thinkingLevel: "high", generation: 1 },
};
const readout = {
  session, active: true,
  // The installed task Provider is B, so A's model is not resolved here.
  model: null,
  reasoningLevels: [],
  context: { used: 1200, window: 200000, source: "sdk-usage" },
  usage: null, turns: 1, transcriptModel: null, pending: false, interrupted: false,
};

function bridge(taskOp?: (op: string, payload: Record<string, unknown>) => unknown) {
  const ops: Array<{ op: string; payload: Record<string, unknown> }> = [];
  const providerCalls: Array<Record<string, unknown>> = [];
  const value = ({
    listTasks: vi.fn(async () => ({ ok: true, payload: { tasks: [{ taskId, name: "Task", branch: "main", repoCount: 0, updatedAt: "now" }], roots } })),
    projectOp: vi.fn(async (request) => ({ ok: true, payload: request.op === "list" ? { initialized: true, projects: [] } : { roots, tasks: [association] } })),
    providerOp: vi.fn(async (request) => {
      providerCalls.push(request as Record<string, unknown>);
      const call = request as Record<string, unknown>;
      const selected = call["op"] === "select"
        ? { profileId: String(call["profileId"]), modelId: String(call["modelId"]) }
        : { profileId: PROFILE_B.id, modelId: "gpt-5" };
      return { ok: true, payload: {
        state: "configured", profileId: selected.profileId, modelId: selected.modelId, thinkingLevel: "high", generation: 1,
        profiles: [PROFILE_A, PROFILE_B], nativePath: "/tmp/models.json", secretsAvailable: true,
      } };
    }),
    onSdkTurnEvent: vi.fn(() => () => undefined),
    sdkTurn: vi.fn(async (request) => {
      if (request.action === "subscribe") return { ok: true, payload: { taskId, sessionId: "main", snapshot: { source: "sdk-jsonl", sessionId: "main", messages: [], pending: false, interrupted: false }, turn: null } };
      if (request.action === "projection") return { ok: true, payload: { source: "sdk-jsonl", sessionId: "main", messages: [], pending: false, interrupted: false } };
      if (request.action === "status") return { ok: true, payload: { turn: null } };
      return { ok: true, payload: { unsubscribed: true } };
    }),
    taskOp: vi.fn(async (_task: string, op: string, payload: Record<string, unknown> = {}) => {
      ops.push({ op, payload });
      const envelope = (inner: unknown) => ({ ok: true as const, payload: inner });
      const custom = taskOp?.(op, payload);
      if (custom !== undefined) return custom;
      if (op === "task/sessionList") return envelope({
        activeSessionId: "main", sessions: [session],
        // Task-level installed Provider, still B.
        provider: { profileId: PROFILE_B.id, modelId: "gpt-5", generation: 1, models: PROFILE_B.models },
      });
      if (op === "task/sessionReadout") return envelope(readout);
      if (op === "task/sessionModel") {
        const modelId = String(payload["modelId"]);
        const profileId = payload["profileId"] === undefined ? PROFILE_B.id : String(payload["profileId"]);
        expect(profileId).toBe(PROFILE_A.id);
        const model = [PROFILE_A, PROFILE_B].flatMap((profile) => profile.models).find((row) => row.id === modelId) ?? null;
        return envelope({
          ...readout,
          session: { ...session, binding: { profileId, modelId, thinkingLevel: "high", generation: 1 } },
          model: model === null ? null : { id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens, reasoning: model.reasoning },
          reasoningLevels: model?.reasoningLevels ?? [],
        });
      }
      if (op === "task/readDraft") return envelope({ sessionId: "main", draft: null });
      if (op === "task/saveDraft" || op === "task/clearDraft") return envelope({ sessionId: "main" });
      if (op === "task/listApprovals") return envelope({ approvals: [] });
      if (op === "task/executionState") return envelope({ executions: [] });
      return envelope({});
    }),
  } as unknown) as PidockBridge;
  return { bridge: value, ops, providerCalls };
}

function mount(fixture: ReturnType<typeof bridge>) {
  window.pidock = fixture.bridge;
  return render(<DesktopConversation taskId={taskId} name="Task" branch="task/main" repoCount={1} roots={JSON.stringify(roots)} association={JSON.stringify(association)} onBack={vi.fn()} onOpenProviders={vi.fn()} onArchived={vi.fn()} />);
}

afterEach(() => { cleanup(); localStorage.clear(); delete (window as { pidock?: unknown }).pidock; vi.restoreAllMocks(); });

describe("#167 global Provider selection in the conversation", () => {
  it("offers every configured profile's models even when the task installed another profile", async () => {
    const fixture = bridge();
    mount(fixture);
    await screen.findByText(/尚未开始/);
    // The session's original binding names A's model even though the installed
    // task Provider is B: the pill must not degrade to 未绑定模型.
    await waitFor(() => expect(screen.getByTestId("composer-model-name")).toHaveTextContent("Claude Sonnet"));
    fireEvent.click(screen.getByTestId("composer-model"));
    const menu = await screen.findByRole("menu", { name: "会话模型" });
    const names = within(menu).getAllByRole("menuitemradio").map((row) => row.querySelector("[data-model-name]")?.textContent);
    expect(names).toEqual(expect.arrayContaining(["Claude Sonnet", "Claude Haiku", "GPT-5"]));
    // The original pair is selectable (marked selected), not hidden.
    const row = within(menu).getByRole("menuitemradio", { name: /Claude Sonnet/ });
    expect(row).toHaveAttribute("aria-checked", "true");
  });

  it("switches the session to a model of another profile by exact profile+model identity", async () => {
    const fixture = bridge();
    mount(fixture);
    await screen.findByText(/尚未开始/);
    await waitFor(() => expect(screen.getByTestId("composer-model-name")).toHaveTextContent("Claude Sonnet"));
    fireEvent.click(screen.getByTestId("composer-model"));
    const menu = await screen.findByRole("menu", { name: "会话模型" });
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /Claude Haiku/ }));
    await waitFor(() => expect(fixture.ops.some((entry) => entry.op === "task/sessionModel" &&
      entry.payload["profileId"] === PROFILE_A.id && entry.payload["modelId"] === "claude-haiku-4-5")).toBe(true));
    await waitFor(() => expect(screen.getByTestId("composer-model-name")).toHaveTextContent("Claude Haiku"));
  });

  it("installs the active session's profile before sending, not only when the menu is used", async () => {
    const fixture = bridge();
    mount(fixture);
    await screen.findByText(/尚未开始/);
    await waitFor(() => expect(screen.getByTestId("composer-model-name")).toHaveTextContent("Claude Sonnet"));
    fireEvent.change(screen.getByLabelText("消息"), { target: { value: "继续" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(fixture.providerCalls.some((call) =>
      call["op"] === "select" && call["profileId"] === PROFILE_A.id && call["modelId"] === "claude-sonnet-4-5")).toBe(true));
    // Sending does not rewrite the session binding; it only makes the bound
    // profile live for the turn.
    expect(fixture.ops.some((entry) => entry.op === "task/sessionModel")).toBe(false);
  });

  it("renders a refused model switch outside the composer box so its shape cannot change", async () => {
    const refusal = "sdk-context-over-limit: 本会话已用上下文 900000 tokens，超过目标模型声明的 200000 tokens 窗口";
    const fixture = bridge((op) => op === "task/sessionModel" ? { ok: false, error: refusal } : undefined);
    mount(fixture);
    await screen.findByText(/尚未开始/);
    await waitFor(() => expect(screen.getByTestId("composer-model-name")).toHaveTextContent("Claude Sonnet"));
    const composer = screen.getByTestId("desktop-composer");
    fireEvent.click(screen.getByTestId("composer-model"));
    const menu = await screen.findByRole("menu", { name: "会话模型" });
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /Claude Haiku/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(refusal);
    // The alert is not a flex item inside the composer's control row (that is
    // what wrapped the row and deformed the box); it sits above the form.
    expect(composer.contains(alert)).toBe(false);
    expect(composer.querySelector('[data-testid="composer-model-reasoning"] [role="alert"]')).toBeNull();
    // The failed switch did not leave the other profile installed: the task is
    // put back on B, so the next turn cannot run under an unbound pair.
    await waitFor(() => expect(fixture.providerCalls.filter((call) => call["op"] === "select")
      .map((call) => call["profileId"])).toEqual([PROFILE_A.id, PROFILE_B.id]));
  });
});
