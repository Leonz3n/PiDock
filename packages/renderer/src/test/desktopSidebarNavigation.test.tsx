import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
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
    if (request.op === "associations") return { ok: true, payload: { roots, tasks: [{ taskId: "real-1", projectId: null, state: "unassigned" }] } };
    return { ok: true, payload: { id: "ced35ecc-2d27-4ff8-a3cb-02dc5900e7a9" } };
  }),
});


afterEach(() => { cleanup(); delete window.pidock; vi.restoreAllMocks(); });

async function sessionMenu(action: string) {
  const row = await sidebar().findByRole("button", { name: "主会话" });
  row.focus();
  fireEvent.keyDown(row, { key: "F10", shiftKey: true });
  const menu = await screen.findByRole("menu", { name: "主会话 会话菜单" });
  if (action === "打开会话") expect(within(menu).getByRole("menuitem", { name: "重命名" })).not.toHaveAttribute("aria-disabled", "true");
  const item = within(menu).getByRole("menuitem", { name: action });
  expect(item).not.toHaveAttribute("aria-disabled", "true");
  fireEvent.click(item);
  await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
}

it.each(["inventory", "lifecycle", "archived"])("cancels a Sidebar archive after %s validation fails; ordinary Open cannot replay it", async (failure) => {
  const api = bridge();
  window.pidock = api;
  render(<App />);
  await screen.findByTestId("desktop-project-overview");
  await sidebar().findByRole("button", { name: "主会话" });
  const originalOp = vi.mocked(api.taskOp!).getMockImplementation()!;
  if (failure === "inventory") vi.mocked(api.listTasks!).mockResolvedValueOnce({ ok: false, error: "transient inventory failure" });
  else vi.mocked(api.taskOp!).mockImplementationOnce(async (id, op) => op === "task/lifecycleState"
    ? failure === "archived"
      ? { ok: true, payload: { lifecycle: { taskId: id, archived: true, archivedAt: "2026-01-01" } } }
      : { ok: false, error: "transient lifecycle failure" }
    : originalOp(id, op));
  await sessionMenu("归档");
  await screen.findByText(failure === "inventory" ? "transient inventory failure" : failure === "archived" ? "该任务已归档，请先从已归档页恢复" : "transient lifecycle failure");
  expect(vi.mocked(api.taskOp!).mock.calls.filter(([, op]) => op === "task/sessionArchive")).toHaveLength(0);
  // Recovery must release mutation entries, and Open must remain just Open.
  await sessionMenu("打开会话");
  await screen.findByTestId("desktop-conversation");
  await screen.findByRole("tab", { name: "主会话" });
  expect(vi.mocked(api.taskOp!).mock.calls.filter(([, op]) => op === "task/sessionArchive")).toHaveLength(0);
  await sessionMenu("重命名");
  expect(await screen.findByRole("dialog", { name: "全部会话" })).toBeVisible();
});

it("discards a pending Sidebar archive when another destination supersedes its navigation", async () => {
  const api = bridge();
  window.pidock = api;
  render(<App />);
  await screen.findByTestId("desktop-project-overview");
  await sidebar().findByRole("button", { name: "主会话" });
  const inventory = { ok: true as const, payload: { tasks, roots } };
  let finish!: (value: typeof inventory) => void;
  vi.mocked(api.listTasks!).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await sessionMenu("归档");
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  fireEvent.click(sidebar().getByRole("button", { name: "定时任务" }));
  await screen.findByTestId("desktop-schedules-page");
  await act(async () => finish(inventory));
  expect(screen.getByTestId("desktop-schedules-page")).toBeVisible();
  await sessionMenu("打开会话");
  await screen.findByTestId("desktop-conversation");
  await screen.findByRole("tab", { name: "主会话" });
  expect(vi.mocked(api.taskOp!).mock.calls.filter(([, op]) => op === "task/sessionArchive")).toHaveLength(0);
  await sessionMenu("重命名");
  expect(await screen.findByRole("dialog", { name: "全部会话" })).toBeVisible();
});

it("does not dispatch an intent to an already mounted conversation before navigation validation succeeds", async () => {
  const api = bridge();
  window.pidock = api;
  render(<App />);
  await screen.findByTestId("desktop-project-overview");
  fireEvent.click(await sidebar().findByRole("button", { name: "主会话" }));
  await screen.findByTestId("desktop-conversation");
  await screen.findByRole("tab", { name: "主会话" });
  // A same-task destination already has an intent consumer mounted. Hold just
  // the action's validation read; ordinary background session reads stay real.
  const originalOp = vi.mocked(api.taskOp!).getMockImplementation()!;
  let rejectEntry!: (value: { ok: false; error: string }) => void;
  let held = false;
  vi.mocked(api.taskOp!).mockImplementation((id, op, payload) => {
    if (op === "task/lifecycleState" && !held) {
      held = true;
      return new Promise(resolve => { rejectEntry = resolve; });
    }
    return originalOp(id, op, payload);
  });
  await sessionMenu("归档");
  await waitFor(() => expect(rejectEntry).toBeTypeOf("function"));
  expect(vi.mocked(api.taskOp!).mock.calls.filter(([, op]) => op === "task/sessionArchive")).toHaveLength(0);
  await act(async () => rejectEntry({ ok: false, error: "validation interrupted" }));
  await screen.findByText("validation interrupted");
  expect(vi.mocked(api.taskOp!).mock.calls.filter(([, op]) => op === "task/sessionArchive")).toHaveLength(0);
  vi.mocked(api.taskOp!).mockImplementation(originalOp);
  await sessionMenu("打开会话");
  await waitFor(() => expect(screen.queryByText("validation interrupted")).not.toBeInTheDocument());
  expect(vi.mocked(api.taskOp!).mock.calls.filter(([, op]) => op === "task/sessionArchive")).toHaveLength(0);
});

it("cancels pending action navigation when a workspace dialog supersedes it", async () => {
  const api = bridge();
  window.pidock = api;
  render(<App />);
  await screen.findByTestId("desktop-project-overview");
  await sidebar().findByRole("button", { name: "主会话" });
  const inventory = { ok: true as const, payload: { tasks, roots } };
  let finish!: (value: typeof inventory) => void;
  vi.mocked(api.listTasks!).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await sessionMenu("归档");
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  fireEvent.click(sidebar().getByRole("button", { name: "新建工作空间" }));
  const dialog = await screen.findByRole("dialog", { name: "新建工作空间" });
  await act(async () => finish(inventory));
  expect(dialog).toBeVisible();
  expect(screen.queryByTestId("desktop-conversation")).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  await sessionMenu("打开会话");
  await screen.findByRole("tab", { name: "主会话" });
  expect(vi.mocked(api.taskOp!).mock.calls.filter(([, op]) => op === "task/sessionArchive")).toHaveLength(0);
});
