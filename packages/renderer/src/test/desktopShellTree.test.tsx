import { waitFor, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SidebarMenu } from "../components/SidebarMenu";
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
  const onNewTask = vi.fn();
  render(<DesktopShell view={{ view: "project", projectId: "workspace-one" }} onNavigate={vi.fn()} onNewTask={onNewTask}
    projects={[{ id: "workspace-one", name: "核心开发", description: "", taskCount: 0 }]} projectsInitialized unassignedCount={0}
    tasks={[]} allTaskCount={0} lifecyclePending={false} lifecycleErrors={[]} roots={[]}
    rootRetry={{ busy: false, pending: false, error: null, run: vi.fn() }} breadcrumb={{ project: "核心开发" }}>内容</DesktopShell>);
  // The compact rail's controls are CSS-hidden at the jsdom default viewport.
  fireEvent.click(screen.getByLabelText("展开导航"));
  fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
  expect(onNewTask).toHaveBeenCalledOnce();
  expect(screen.getByLabelText("展开导航")).toHaveAttribute("aria-expanded", "false");
});

it("keeps the workspace creation trigger exposed so modal closure can restore its focus", () => {
  render(<DesktopShell view={{ view: "project", projectId: "workspace-one" }} onNavigate={vi.fn()} onNewWorkspace={vi.fn()}
    projects={[{ id: "workspace-one", name: "核心开发", description: "", taskCount: 0 }]} projectsInitialized unassignedCount={0}
    tasks={[]} allTaskCount={0} lifecyclePending={false} lifecycleErrors={[]} roots={[]}
    rootRetry={{ busy: false, pending: false, error: null, run: vi.fn() }} breadcrumb={{ project: "核心开发" }}>内容</DesktopShell>);
  fireEvent.click(screen.getByLabelText("展开导航"));
  fireEvent.click(screen.getByRole("button", { name: "新建工作空间" }));
  expect(screen.getByLabelText("收起导航")).toHaveAttribute("aria-expanded", "true");
});

it("opens a keyboard context menu on the addressed session without selecting it; Escape returns row focus", async () => {
  const onNavigate = vi.fn(), onSidebarAction = vi.fn();
  window.pidock = { taskOp: vi.fn(async () => ({ ok: true, payload: { activeSessionId: "main", provider: null, sessions: [{ id: "main", name: "边界复查", createdAt: "2026-01-01", updatedAt: "2026-01-01", archived: false, permission: "default", binding: null }] } })) } as unknown as typeof window.pidock;
  render(<DesktopShell view={{ view: "project", projectId: "workspace-one" }} onNavigate={onNavigate} onSidebarAction={onSidebarAction}
    projects={[{ id: "workspace-one", name: "核心开发", description: "", taskCount: 1 }]} projectsInitialized unassignedCount={0}
    tasks={[task]} allTaskCount={1} lifecyclePending={false} lifecycleErrors={[]} roots={[]}
    rootRetry={{ busy: false, pending: false, error: null, run: vi.fn() }} breadcrumb={{ project: "核心开发" }}>内容</DesktopShell>);
  const row = await screen.findByRole("button", { name: "边界复查" });
  row.focus();
  fireEvent.keyDown(row, { key: "F10", shiftKey: true });
  const menu = await screen.findByRole("menu", { name: "边界复查 会话菜单" });
  expect(onNavigate).not.toHaveBeenCalled();
  fireEvent.click(within(menu).getByRole("menuitem", { name: "重命名" }));
  await waitFor(() => expect(onSidebarAction).toHaveBeenCalledExactlyOnceWith({ taskId: "task-one", sessionId: "main", action: "rename" }));
  expect(onNavigate).not.toHaveBeenCalled();
});

it("keeps expand and select separate even if workspace and task IDs collide", async () => {
  const onNavigate = vi.fn();
  window.pidock = { taskOp: vi.fn(async () => ({ ok: true, payload: { activeSessionId: null, provider: null, sessions: [] } })) } as unknown as typeof window.pidock;
  render(<DesktopShell view={{ view: "project", projectId: "task-one" }} onNavigate={onNavigate}
    projects={[{ id: "task-one", name: "核心开发", description: "", taskCount: 1 }]} projectsInitialized unassignedCount={0}
    tasks={[{ ...task, projectId: "task-one" }]} allTaskCount={1} lifecyclePending={false} lifecycleErrors={[]} roots={[]}
    rootRetry={{ busy: false, pending: false, error: null, run: vi.fn() }} breadcrumb={{ project: "核心开发" }}>内容</DesktopShell>);
  await screen.findByText("暂无会话");
  fireEvent.click(screen.getByRole("button", { name: "收起工作空间 核心开发" }));
  fireEvent.click(screen.getByRole("button", { name: "展开工作空间 核心开发" }));
  expect(screen.getByRole("button", { name: "收起任务 修复分页" })).toHaveAttribute("aria-expanded", "true");
  expect(onNavigate).not.toHaveBeenCalled();
});


it("focuses keyboard menu entry after the portal mounts even when animation frames arrive early", async () => {
  const frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { callback(0); return 1; });
  try {
    render(<SidebarMenu label="archived session" items={[{ label: "Unavailable", reason: "archived" }, {label:"Restore",run:vi.fn()}]}><button data-row-select onContextMenu={() => fireEvent.pointerMove(document.body)}>Session</button></SidebarMenu>);
    const row=screen.getByRole("button",{name:"Session"});
    row.focus();
    fireEvent.keyDown(row,{key:"F10",shiftKey:true});
    // A native pointer can move while Radix defers mounting its focus scope.
    fireEvent.pointerMove(document.body);
    const item=await screen.findByRole("menuitem",{name:"Restore"});
    await waitFor(() => expect(item).toHaveFocus());
    fireEvent.keyDown(item,{key:"Escape"});
    await waitFor(() => expect(row).toHaveFocus());
  } finally { frame.mockRestore(); }
});
