import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, within } from "@testing-library/react";
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

it("sidebar new task opens directly after visiting schedules", async () => {
  window.pidock = { ...bridge(), createTask: vi.fn(async () => ({ ok: true, payload: { intent: null } })) } as unknown as PidockBridge;
  render(<App />);
  await screen.findByTestId("desktop-project-overview");
  fireEvent.click(sidebar().getByRole("button", { name: "定时任务" }));
  await screen.findByTestId("desktop-schedules-page");
  fireEvent.click(sidebar().getByRole("button", { name: "新建任务" }));
  expect(await screen.findByRole("dialog", { name: "新建任务" })).toBeVisible();
});

// Each route is reached through the same public controls the desktop exposes.
// Management replaces the sidebar, so its New Task path starts with Back.
it.each([
  ["已归档", "desktop-archive-page"],
  ["需要处理", "desktop-attention-page"],
  ["环境与服务", "desktop-environment-page"],
  ["Token 用量", "desktop-usage-page"],
  ["真实项目", "desktop-project-overview"],
  ["未归属任务", "desktop-unassigned"],
  ["真实任务", "desktop-task-facts"],
  ["主会话", "desktop-task-facts"],
  ["能力管理", "management"],
  ["设置", "management"],
])("New Task opens after %s and navigation remains usable after cancel", async (destination, page) => {
  window.pidock = { ...bridge(), createTask: vi.fn(async () => ({ ok: true, payload: { intent: null } })) } as unknown as PidockBridge;
  render(<App />);
  await screen.findByTestId("desktop-project-overview");
  if (["需要处理", "环境与服务", "Token 用量"].includes(destination)) {
    fireEvent.click(sidebar().getByRole("button", { name: "更多" }));
  }
  fireEvent.click(await sidebar().findByRole("button", { name: destination }));
  if (page === "management") {
    fireEvent.click(await screen.findByRole("button", { name: "返回任务工作区" }));
  } else {
    await screen.findByTestId(page);
  }
  fireEvent.click(sidebar().getByRole("button", { name: "新建任务" }));
  const dialog = await screen.findByRole("dialog", { name: "新建任务" });
  expect(dialog).toBeVisible();
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog", { name: "新建任务" })).not.toBeInTheDocument();
  fireEvent.click(sidebar().getByRole("button", { name: "定时任务" }));
  expect(await screen.findByTestId("desktop-schedules-page")).toBeVisible();
});
