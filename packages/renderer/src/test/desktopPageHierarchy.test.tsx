import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { App } from "../App";
import type { PidockBridge } from "../data/shellBridge";

const tasks = [{ taskId: "real-1", name: "真实任务", branch: "task/main", repoCount: 1, updatedAt: "2026-09-22" }];
const roots = [{ label: "默认任务根", state: "ready" as const }];

const sidebar = () => within(screen.getByTestId("desktop-sidebar"));

const project = { id: "bcedc870-22bd-474e-ac55-78d30a9d763d", name: "真实项目", description: "系统 A", repositories: [{ id: "dad5fcb4-c91f-4ab0-bc33-fbb82053f871", name: "Web", path: "/private/work/web" }], directories: [] as Array<{ id: string; name: string; path: string }>, environment: [] as Array<{ key: string; value: string }>, branchTemplate: "feature/{task-name}" };
const bridge = (): PidockBridge => ({
  listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })),
  importTaskRoot: vi.fn(async () => ({ ok: true, payload: { canceled: false, count: 1 } })),
  // [#139] The production route reads a task's sessions and one session's readout;
  // this default answers the migrated single session, `main`.
  taskOp: vi.fn(async (taskId, op) => {
    if (op === "task/sessionList") return { ok: true, payload: { activeSessionId: "main", sessions: [{ id: "main", name: "主会话", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", archived: false, permission: "default", binding: null }], provider: null } };
    if (op === "task/sessionReadout") return { ok: true, payload: { session: { id: "main", name: "主会话", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", archived: false, permission: "default", binding: null }, active: true, model: null, reasoningLevels: [], context: { used: null, window: null, source: "unknown" }, usage: null, turns: 0, transcriptModel: null, pending: false, interrupted: false } };
    return { ok: true, payload: { lifecycle: { taskId, archived: false, archivedAt: null }, op } };
  }),
  projectOp: vi.fn(async (request) => {
    if (request.op === "list") return { ok: true, payload: { initialized: true, projects: [project] } };
    if (request.op === "associations") return { ok: true, payload: { roots, tasks: [{ taskId: "real-1", projectId: project.id, state: "assigned" }] } };
    return { ok: true, payload: { id: "ced35ecc-2d27-4ff8-a3cb-02dc5900e7a9" } };
  }),
});

afterEach(() => { cleanup(); delete window.pidock; vi.restoreAllMocks(); });

it("workspace, task facts and a named session are separate public destinations", async () => {
  const api = bridge();
  window.pidock = api;
  render(<App />);
  await screen.findByTestId("desktop-project-overview");
  fireEvent.click(await sidebar().findByRole("button", { name: "真实任务" }));
  expect(await screen.findByTestId("desktop-task-facts")).toBeVisible();
  expect(screen.queryByTestId("desktop-conversation")).not.toBeInTheDocument();
  expect(await sidebar().findByRole("button", { name: "主会话" })).not.toHaveAttribute("aria-current");
  expect(screen.queryByRole("textbox", { name: /消息/ })).not.toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: "进入对话 · 主会话" }));
  expect(await screen.findByTestId("desktop-conversation")).toBeVisible();
  expect(screen.queryByTestId("desktop-task-facts")).not.toBeInTheDocument();
  expect(screen.getByTestId("desktop-session-facts")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "返回任务事实" }));
  expect(await screen.findByTestId("desktop-task-facts")).toBeVisible();
  expect(screen.queryByTestId("desktop-conversation")).not.toBeInTheDocument();
  fireEvent.click(sidebar().getByRole("button", { name: "主会话" }));
  expect(await screen.findByTestId("desktop-conversation")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "返回任务事实" }));
  fireEvent.click(await screen.findByRole("button", { name: "返回工作空间总览" }));
  expect(await screen.findByTestId("desktop-project-overview")).toBeVisible();
  await waitFor(() => expect(api.taskOp).not.toHaveBeenCalledWith(expect.anything(), "task/sessionCreate", expect.anything()));
});

it("explicit session navigation keeps that identity when Host active points elsewhere", async () => {
  const api = bridge();
  const original = api.taskOp!;
  const session = { id: "review", name: "复核会话", createdAt: "2026-01-01", updatedAt: "2026-01-02", archived: false, permission: "default", binding: null };
  api.taskOp = vi.fn(async (taskId, op, payload) => {
    if (op === "task/sessionList") return { ok: true, payload: { activeSessionId: "main", sessions: [{ ...session, id: "main", name: "主会话" }, session], provider: null } };
    if (op === "task/sessionReadout") return { ok: true, payload: { session: payload?.sessionId === "review" ? session : { ...session, id: "main", name: "主会话" }, active: payload?.sessionId === "main", model: null, reasoningLevels: [], context: { used: null, window: null, source: "unknown" }, usage: null, turns: 0, transcriptModel: null, pending: false, interrupted: false } };
    return original(taskId, op, payload);
  });
  const sdkTurn = vi.fn(async (request: Record<string, unknown>) => ({ ok: true, payload: request.action === "subscribe" ? { taskId: "real-1", sessionId: request.sessionId, snapshot: { source: "sdk-jsonl", sessionId: request.sessionId, messages: [], pending: false, interrupted: false }, turn: null } : { unsubscribed: true } }));
  window.pidock = { ...api, sdkTurn, onSdkTurnEvent: vi.fn(() => vi.fn()) } as PidockBridge;
  render(<App />);
  await screen.findByTestId("desktop-project-overview");
  fireEvent.click(await sidebar().findByRole("button", { name: "复核会话" }));
  const conversation = await screen.findByTestId("desktop-conversation");
  await waitFor(() => expect(within(conversation).getByRole("tab", { name: "复核会话" })).toHaveAttribute("aria-selected", "true"));
  expect(sdkTurn).not.toHaveBeenCalledWith(expect.objectContaining({ action: "subscribe", sessionId: "main" }));
});

it.each(["empty", "failed"])("task facts names %s session lists without fabricating a conversation", async (state) => {
  const api = bridge();
  const original = api.taskOp!;
  api.taskOp = vi.fn(async (taskId, op, payload) => op === "task/sessionList"
    ? state === "failed" ? { ok: false, error: "会话索引不可读" } : { ok: true, payload: { activeSessionId: null, sessions: [], provider: null } }
    : original(taskId, op, payload));
  window.pidock = api;
  render(<App />);
  await screen.findByTestId("desktop-project-overview");
  fireEvent.click(await sidebar().findByRole("button", { name: "真实任务" }));
  const facts = await screen.findByTestId("desktop-task-facts");
  expect(await within(facts).findByText(state === "failed" ? /列表读取失败：会话索引不可读/ : /此任务尚无会话/)).toBeVisible();
  expect(within(facts).queryByRole("button", { name: /^进入对话/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "进入活跃对话" })).toBeDisabled();
  expect(screen.queryByTestId("desktop-conversation")).not.toBeInTheDocument();
});

it("keeps the verified facts destination while a direct-session task identity reread is pending", async () => {
  const api = bridge();
  const originalList = api.listTasks!;
  let hold = false;
  let release: (() => void) | undefined;
  api.listTasks = vi.fn(async () => {
    if (hold) await new Promise<void>((resolve) => { release = resolve; });
    return originalList();
  });
  window.pidock = api;
  render(<App />);
  await screen.findByTestId("desktop-project-overview");
  fireEvent.click(await sidebar().findByRole("button", { name: "真实任务" }));
  await screen.findByTestId("desktop-task-facts");
  hold = true;
  fireEvent.click(await sidebar().findByRole("button", { name: "主会话" }));
  await waitFor(() => expect(release).toBeTypeOf("function"));
  expect(screen.queryByTestId("desktop-conversation")).not.toBeInTheDocument();
  release?.();
  expect(await screen.findByTestId("desktop-conversation")).toBeVisible();
});

it("returning from a directly selected task opens its owning workspace", async () => {
  const api = bridge();
  const other = { ...project, id: "6fd712ce-a43b-4614-a459-de81d78a16aa", name: "任务所属工作空间" };
  const original = api.projectOp!;
  api.projectOp = vi.fn(async (request) => request.op === "list"
    ? { ok: true, payload: { initialized: true, projects: [project, other] } }
    : request.op === "associations" ? { ok: true, payload: { roots, tasks: [{ taskId: "real-1", projectId: other.id, state: "assigned" }] } } : original(request));
  window.pidock = api;
  render(<App />);
  await screen.findByTestId("desktop-project-overview");
  expect(screen.getByTestId("overview-title")).toHaveTextContent("真实项目");
  fireEvent.click(await sidebar().findByRole("button", { name: "真实任务" }));
  await screen.findByTestId("desktop-task-facts");
  fireEvent.click(screen.getByRole("button", { name: "返回工作空间总览" }));
  expect(await screen.findByTestId("overview-title")).toHaveTextContent(other.name);
});

it("task session history counts archived sessions as well as active sessions", async () => {
  const api = bridge();
  const original = api.taskOp!;
  const session = { id: "main", name: "主会话", createdAt: "2026-01-01", updatedAt: "2026-01-02", archived: false, permission: "default", binding: null };
  api.taskOp = vi.fn(async (taskId, op, payload) => op === "task/sessionList"
    ? { ok: true, payload: { activeSessionId: "main", sessions: [session, { ...session, id: "old", name: "归档历史", archived: true }], provider: null } }
    : original(taskId, op, payload));
  window.pidock = api;
  render(<App />);
  await screen.findByTestId("desktop-project-overview");
  fireEvent.click(await sidebar().findByRole("button", { name: "真实任务" }));
  await waitFor(() => expect(screen.getByTestId("task-facts-sessions")).toHaveTextContent("会话 2 个"));
  expect(screen.getByRole("button", { name: "进入对话 · 归档历史" })).toBeVisible();
});
