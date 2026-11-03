import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopConversation } from "../components/DesktopConversation";
import type { PidockBridge } from "../data/shellBridge";
// The SHIPPED Host composer builds the identity block this suite parses, so the
// history chips and the Host's own format cannot drift apart silently.
import { composePromptContext } from "../../../shell/src/host/sdk-prompt-context.js";

/**
 * [Pencil T10] #145 引用来源闭环 in the PRODUCTION desktop conversation:
 *
 * - 历史的用户消息把 Host 拼在提示词末尾的身份清单渲染为来源芯片，正文只剩用户
 *   实际输入的文字（Host 的 `composePromptContext` 造出这段文字，不是手写样例）；
 * - 发送前用 Host 真实读到的 `task/fileRoots` 重检引用：失效来源按名字拒绝发送，
 *   草稿与芯片都保留，且不会偷偷改用另一个根目录；
 * - 会话切换后焦点回到本条会话的输入区。
 */

const TASK_ID = "task-a";
const roots = [{ label: "默认任务根", state: "ready" }];
const association = { taskId: TASK_ID, projectId: null, state: "unassigned" };
const REFERENCE = {
  id: "task-file:repo-a:src/api.ts",
  kind: "file" as const,
  label: "repo-a/src/api.ts",
  detail: "repo-a · worktree @ 版本未记录",
  taskId: TASK_ID,
  sourceId: "repo-a",
  sourceKind: "worktree" as const,
  relativePath: "src/api.ts",
  version: null,
};

function setup(options: { draftReference?: boolean; rootIds?: string[] } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const rootIds = options.rootIds ?? ["repo-a"];
  const snapshot = (messages: unknown[] = []) => ({ source: "sdk-jsonl", sessionId: "main", messages, pending: false, interrupted: false });
  const envelope = (taskId: string, op: string, inner: Record<string, unknown>) => ({ ok: true as const, payload: { workspaceId: "w", taskId, op, payload: inner } });
  const taskOp = vi.fn(async (taskId: string, op: string, payload: Record<string, unknown> = {}) => {
    if (op === "task/readDraft") {
      return envelope(taskId, op, { sessionId: "main", draft: options.draftReference ? { text: "看一下这个接口", references: [REFERENCE] } : null });
    }
    if (op === "task/saveDraft") return envelope(taskId, op, { sessionId: "main" });
    if (op === "task/fileRoots") {
      return envelope(taskId, op, {
        taskDir: "/tmp/task-a",
        roots: rootIds.map((id) => ({ id, kind: "worktree", label: id, path: `/tmp/task-a/${id}` })),
      });
    }
    if (op === "task/sessionList") {
      return envelope(taskId, op, {
        activeSessionId: "main",
        sessions: [
          { id: "main", name: "实现", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", archived: false, permission: "default", binding: null },
          { id: "s-2", name: "复核", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", archived: false, permission: "default", binding: null },
        ],
        provider: null,
      });
    }
    if (op === "task/sessionReadout") {
      return envelope(taskId, op, { modelId: "m", reasoningLevel: "medium", reasoningLevels: ["low", "high"], context: { used: null, window: 200000, source: "unknown" }, usage: null, turns: 0, pending: false, interrupted: false });
    }
    if (op === "task/executionState" || op === "task/listApprovals") return envelope(taskId, op, op === "task/listApprovals" ? { approvals: [] } : { execution: null });
    return { ok: false as const, error: `unexpected ${op}` };
  });
  const bridge: PidockBridge = {
    listTasks: vi.fn(async () => ({ ok: true, payload: { tasks: [{ taskId: TASK_ID, name: "Task", branch: "main", repoCount: 1, updatedAt: "now" }], roots } })),
    projectOp: vi.fn(async (request) => ({ ok: true, payload: request.op === "list" ? { initialized: true, projects: [] } : { roots, tasks: [association] } })),
    onSdkTurnEvent: vi.fn(() => () => {}),
    providerOp: vi.fn(async () => ({ ok: true, payload: { state: "configured", profileId: "p", generation: 1, profiles: [] } })),
    sdkTurn: vi.fn(async (request) => {
      calls.push(request);
      if (request.action === "subscribe") return { ok: true, payload: { taskId: TASK_ID, sessionId: "main", snapshot: snapshot(messages) } };
      if (request.action === "projection") return { ok: true, payload: snapshot(messages) };
      if (request.action === "start") {
        return { ok: true, payload: { turn: { taskId: TASK_ID, sessionId: "main", requestId: String(request.requestId), turnId: "11111111-1111-1111-1111-111111111111", state: "accepted", needsResync: false } } };
      }
      return { ok: true, payload: snapshot(messages) };
    }),
    taskOp,
  };
  let messages: unknown[] = [];
  const setMessages = (value: unknown[]) => { messages = value; };
  window.pidock = bridge;
  return { bridge, calls, taskOp, setMessages, snapshot };
}

const mount = () => render(<DesktopConversation taskId={TASK_ID} name="Task" branch="task/main" repoCount={1} roots={JSON.stringify(roots)} association={JSON.stringify(association)} onBack={vi.fn()} onOpenProviders={vi.fn()} onArchived={vi.fn()} />);

afterEach(() => { cleanup(); localStorage.clear(); delete window.pidock; vi.restoreAllMocks(); });

describe("[Pencil T10] #145 历史引用芯片", () => {
  it("renders the Host's identity block as source chips and keeps the prose the user typed", async () => {
    const fixture = setup();
    const composed = composePromptContext("看一下这个接口", {
      references: [
        { kind: "file", label: "repo-a/src/api.ts", source: "repo-a/worktree", detail: "src/api.ts" },
        { kind: "attachment", label: "shot.png", detail: "图片附件 · 仅 shot.png 本身" },
      ],
    });
    expect(composed.ok).toBe(true);
    fixture.setMessages([{ role: "user", text: composed.ok ? composed.prompt : "", usage: null }, { role: "assistant", text: "好的", usage: null }]);
    mount();

    const chips = await screen.findAllByTestId("history-reference");
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveAttribute("data-reference-kind", "file");
    expect(chips[0]).toHaveTextContent("文件");
    expect(chips[0]).toHaveTextContent("repo-a/src/api.ts");
    expect(chips[0]).toHaveTextContent("repo-a/worktree");
    expect(chips[1]).toHaveAttribute("data-reference-kind", "attachment");
    expect(chips[1]).toHaveTextContent("shot.png");
    // 正文只有用户输入：Host 的尾注不再混进消息气泡。
    const article = screen.getByText("看一下这个接口").closest("article")!;
    expect(within(article).getByText("看一下这个接口")).toBeInTheDocument();
    expect(within(article).queryByText(/PiDock 引用与附件/)).not.toBeInTheDocument();
  });

  it("shows a plain message unchanged when there is no Host block", async () => {
    const fixture = setup();
    fixture.setMessages([{ role: "user", text: "普通消息\n第二行", usage: null }]);
    mount();
    await screen.findByText(/普通消息/);
    expect(screen.queryAllByTestId("history-reference")).toEqual([]);
  });
});

describe("[Pencil T10] #145 发送前的引用重检", () => {
  it("refuses a stale source by name, reads the live roots from the Host and keeps the draft", async () => {
    // The Host no longer lists `repo-a`: the chip came from a task whose worktree is gone.
    const fixture = setup({ draftReference: true, rootIds: ["repo-b"] });
    mount();
    const input = await screen.findByRole("textbox", { name: "消息" });
    await waitFor(() => expect(input).toHaveValue("看一下这个接口"));
    await screen.findByTestId(`composer-file-reference-${REFERENCE.id}`);

    fireEvent.change(input, { target: { value: "看一下这个接口，顺便跑测试" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    const refusal = await screen.findByTestId("composer-reference-refusal");
    expect(refusal).toHaveTextContent("repo-a/src/api.ts");
    expect(refusal).toHaveTextContent("来源已失效");
    expect(refusal).toHaveTextContent("未发送任何内容");
    // The Host really read the task's roots; nothing was sent and no other root was used.
    expect(fixture.taskOp.mock.calls.some(([, op]) => op === "task/fileRoots")).toBe(true);
    expect(fixture.calls.some((request) => request.action === "start")).toBe(false);
    // The chip names the problem and the draft survives.
    const chip = screen.getByTestId(`composer-file-reference-${REFERENCE.id}`);
    expect(chip).toHaveAttribute("data-reference-state", "invalid");
    expect(screen.getByTestId(`composer-file-reference-problem-${REFERENCE.id}`)).toHaveTextContent("来源已失效");
    expect(input).toHaveValue("看一下这个接口，顺便跑测试");
  });

  it("sends once the same reference matches a root the Host reports", async () => {
    const fixture = setup({ draftReference: true, rootIds: ["repo-a"] });
    mount();
    const input = await screen.findByRole("textbox", { name: "消息" });
    await waitFor(() => expect(input).toHaveValue("看一下这个接口"));
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(fixture.calls.some((request) => request.action === "start")).toBe(true));
    expect(screen.queryByTestId("composer-reference-refusal")).not.toBeInTheDocument();
  });
});

describe("[Pencil T10] #145 焦点与会话草稿", () => {
  it("puts focus back in this session's input after switching sessions", async () => {
    const fixture = setup();
    mount();
    const input = await screen.findByRole("textbox", { name: "消息" });
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.click(await screen.findByTestId("session-tab-s-2"));
    const next = await screen.findByRole("textbox", { name: "消息" });
    await waitFor(() => expect(next).toHaveFocus());
    expect(fixture.calls.filter((request) => request.action === "start")).toEqual([]);
  });
});
