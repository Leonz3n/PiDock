import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopShell } from "../components/DesktopShell";

const task = { taskId: "task-one", name: "修复分页", branch: "fix/page", repoCount: 1, updatedAt: "2026-01-01", projectId: "workspace-one" };
afterEach(() => { cleanup(); delete window.pidock; });
it("filters real workspace/task/session names and opens the matching session through the tree", async () => {
  const onNavigate = vi.fn();
  window.pidock = { taskOp: vi.fn(async () => ({ ok: true, payload: { activeSessionId: "main", provider: null, sessions: [{ id: "main", name: "边界复查", createdAt: "2026-01-01", updatedAt: "2026-01-01", archived: false, permission: "default", binding: null }] } })) } as unknown as typeof window.pidock;
  render(<DesktopShell view={{ view: "project", projectId: "workspace-one" }} onNavigate={onNavigate}
    projects={[{ id: "workspace-one", name: "核心开发", description: "", taskCount: 1 }]} projectsInitialized unassignedCount={0}
    tasks={[task]} allTaskCount={1} lifecyclePending={false} lifecycleErrors={[]} roots={[]}
    rootRetry={{ busy: false, pending: false, error: null, run: vi.fn() }} breadcrumb={{ project: "核心开发" }}>内容</DesktopShell>);
  expect(screen.getByText("Host 未核验")).toBeVisible();
  const sidebar = within(screen.getByTestId("desktop-sidebar"));
  fireEvent.change(sidebar.getByRole("searchbox", { name: "过滤任务与会话" }), { target: { value: "边界复查" } });
  fireEvent.click(await sidebar.findByRole("button", { name: "边界复查" }));
  expect(screen.getByText("Host 就绪")).toBeVisible();
  expect(onNavigate).toHaveBeenLastCalledWith({ view: "task", taskId: "task-one", sessionId: "main" });
  fireEvent.change(sidebar.getByRole("searchbox"), { target: { value: "不存在的结果" } });
  expect(sidebar.queryByRole("button", { name: "修复分页" })).toBeNull();
  expect(sidebar.getByText("没有匹配的任务或会话")).toBeVisible();
});
it("names a failed session read and retries through the same Host boundary without inventing rows", async () => {
  const taskOp = vi.fn().mockResolvedValueOnce({ ok: false, error: "会话索引暂时不可读" }).mockResolvedValue({ ok: true, payload: { activeSessionId: null, sessions: [], provider: null } });
  window.pidock = { taskOp } as unknown as typeof window.pidock;
  render(<DesktopShell view={{ view: "project", projectId: "workspace-one" }} onNavigate={vi.fn()}
    projects={[{ id: "workspace-one", name: "核心开发", description: "", taskCount: 1 }]} projectsInitialized unassignedCount={0}
    tasks={[task]} allTaskCount={1} lifecyclePending={false} lifecycleErrors={[]} roots={[]}
    rootRetry={{ busy: false, pending: false, error: null, run: vi.fn() }} breadcrumb={{ project: "核心开发" }}>内容</DesktopShell>);
  expect(await screen.findByText(/会话列表读取失败：.*会话索引暂时不可读/)).toBeVisible();
  expect(screen.getByText("Host 未核验")).toBeVisible();
  expect(document.querySelectorAll("[data-session-nav]")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "重试读取修复分页的会话" }));
  expect(await screen.findByText("暂无会话")).toBeVisible();
  expect(taskOp.mock.calls.every(([, op]) => op === "task/sessionList")).toBe(true);
});
it("returns the compact navigation to its rail when opening a creation dialog", () => {
  const onNewWorkspace = vi.fn();
  render(<DesktopShell view={{ view: "project", projectId: "workspace-one" }} onNavigate={vi.fn()} onNewWorkspace={onNewWorkspace}
    projects={[{ id: "workspace-one", name: "核心开发", description: "", taskCount: 0 }]} projectsInitialized unassignedCount={0}
    tasks={[]} allTaskCount={0} lifecyclePending={false} lifecycleErrors={[]} roots={[]}
    rootRetry={{ busy: false, pending: false, error: null, run: vi.fn() }} breadcrumb={{ project: "核心开发" }}>内容</DesktopShell>);
  // The compact rail's controls are CSS-hidden at the jsdom default viewport.
  fireEvent.click(screen.getByLabelText("展开导航"));
  fireEvent.click(screen.getByRole("button", { name: "新建工作空间" }));
  expect(onNewWorkspace).toHaveBeenCalledOnce();
  expect(screen.getByLabelText("展开导航")).toHaveAttribute("aria-expanded", "false");
});
