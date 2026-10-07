import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { App } from "../App";
import { memoryHost } from "../data/memoryHost";
import type { PidockBridge } from "../data/shellBridge";

const tasks = [{ taskId: "real-1", name: "真实任务", branch: "task/main", repoCount: 1, updatedAt: "2026-09-22" }];
const roots = [{ label: "默认任务根", state: "ready" as const }];

/** [UI 对齐 S8e] 项目总览 is the project page; management (create/claim/transfer) sits behind 项目管理. */
const openManagement = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "项目管理" }));
};

const project = { id: "bcedc870-22bd-474e-ac55-78d30a9d763d", name: "真实项目", description: "系统 A", repositories: [{ id: "dad5fcb4-c91f-4ab0-bc33-fbb82053f871", name: "Web", path: "/private/work/web" }], directories: [] };
const bridge = (settings: { projectPresent?: boolean; assigned?: boolean; fail?: string } = {}): PidockBridge => ({
  listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })),
  importTaskRoot: vi.fn(async () => ({ ok: true, payload: { canceled: false, count: 1 } })),
  taskOp: vi.fn(async (taskId, op) => ({ ok: true, payload: { lifecycle: { taskId, archived: false, archivedAt: null }, op } })),
  projectOp: vi.fn(async (request) => {
    if (settings.fail) return { ok: false, error: settings.fail };
    if (request.op === "list") return { ok: true, payload: { initialized: settings.projectPresent ?? true, projects: settings.projectPresent === false ? [] : [project] } };
    if (request.op === "associations") return { ok: true, payload: { roots, tasks: [{ taskId: "real-1", projectId: settings.assigned ? project.id : null, state: settings.assigned ? "assigned" : "unassigned" }] } };
    return { ok: true, payload: { id: "ced35ecc-2d27-4ff8-a3cb-02dc5900e7a9" } };
  }),
});

afterEach(() => { cleanup(); delete window.pidock; vi.restoreAllMocks(); });

describe("Desktop production data", () => {
  it("keeps Desktop authority after the preload disappears on rerender", async () => {
    const demoRead = vi.spyOn(memoryHost, "getWorkspace");
    const demoCreate = vi.spyOn(memoryHost, "createTask");
    const demoSend = vi.spyOn(memoryHost, "sendMessage");
    window.pidock = { ...bridge(), listTasks: vi.fn(async () => ({ ok: false, error: "Host offline" })) };
    const app = render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Host offline");

    delete window.pidock;
    app.rerender(<App />);
    expect(screen.getByTestId("desktop-inventory")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("桌面壳任务读取接口不可用");
    expect(screen.queryByText("Atlas Web")).not.toBeInTheDocument();
    expect(demoRead).not.toHaveBeenCalled();
    expect(demoCreate).not.toHaveBeenCalled();
    expect(demoSend).not.toHaveBeenCalled();
  });

  it("keeps Desktop authority through StrictMode rerenders with an invalid bridge", async () => {
    const demoRead = vi.spyOn(memoryHost, "getWorkspace");
    const demoApprovals = vi.spyOn(memoryHost, "listApprovals");
    const demoSend = vi.spyOn(memoryHost, "sendMessage");
    window.pidock = bridge({ fail: "项目数据损坏" });
    const app = render(<StrictMode><App /></StrictMode>);
    expect(await screen.findByRole("alert")).toHaveTextContent("项目数据损坏");

    window.pidock = {};
    app.rerender(<StrictMode><App /></StrictMode>);
    app.rerender(<StrictMode><App /></StrictMode>);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("桌面壳任务读取接口不可用");
    expect(screen.queryByText("Atlas Web")).not.toBeInTheDocument();
    expect(demoRead).not.toHaveBeenCalled();
    expect(demoApprovals).not.toHaveBeenCalled();
    expect(demoSend).not.toHaveBeenCalled();
  });

  it("starts missing-preload Electron in Desktop synchronously and recovers only through its retry", async () => {
    const demoRead = vi.spyOn(memoryHost, "getWorkspace");
    const demoCreate = vi.spyOn(memoryHost, "createTask");
    const userAgent = vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Electron/44 Chrome/100");
    const app = render(<StrictMode><App /></StrictMode>);
    expect(screen.getByTestId("desktop-inventory")).toBeInTheDocument();
    expect(screen.queryByTestId("shell-sidebar")).not.toBeInTheDocument();
    expect(demoRead).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent("桌面壳任务读取接口不可用");

    userAgent.mockReturnValue("Chrome/100");
    app.rerender(<StrictMode><App /></StrictMode>);
    expect(screen.getByTestId("desktop-inventory")).toBeInTheDocument();
    window.pidock = bridge();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByTestId("desktop-project-overview")).toBeInTheDocument();
    expect(screen.queryByText("Atlas Web")).not.toBeInTheDocument();
    expect(demoRead).not.toHaveBeenCalled();
    expect(demoCreate).not.toHaveBeenCalled();
  });

  it("keeps the initialized Vite demo after a late bridge, but selects Desktop on a fresh mount", async () => {
    const demoRead = vi.spyOn(memoryHost, "getWorkspace");
    const app = render(<StrictMode><App /></StrictMode>);
    await waitFor(() => expect(demoRead).toHaveBeenCalled());
    const demoSidebar = screen.getByTestId("shell-sidebar");
    const shell = bridge();
    window.pidock = shell;
    app.rerender(<StrictMode><App /></StrictMode>);
    app.rerender(<StrictMode><App /></StrictMode>);
    expect(screen.getByTestId("shell-sidebar")).toBe(demoSidebar);
    expect(screen.queryByTestId("desktop-inventory")).not.toBeInTheDocument();
    expect(screen.queryByTestId("desktop-shell")).not.toBeInTheDocument();
    expect(shell.listTasks).not.toHaveBeenCalled();
    expect(shell.projectOp).not.toHaveBeenCalled();

    app.unmount();
    demoRead.mockClear();
    render(<StrictMode><App /></StrictMode>);
    expect(await screen.findByTestId("desktop-project-overview")).toBeInTheDocument();
    expect(shell.listTasks).toHaveBeenCalled();
    expect(demoRead).not.toHaveBeenCalled();
    expect(screen.queryByTestId("shell-sidebar")).not.toBeInTheDocument();
  });

  it.each(["overview", "management"])("rereads an externally restored missing root from %s without import or changing identities", async (surface) => {
    let restored = false;
    const currentRoots = () => restored ? roots : [{ label: "默认任务根", state: "error" as const, message: "任务根目录已移走" }];
    const listTasks = vi.fn(async () => ({ ok: true, payload: { tasks: restored ? tasks : [], roots: currentRoots() } }));
    const projectOp = vi.fn(async (request: { op: string }) => ({ ok: true, payload: request.op === "list"
      ? { initialized: true, projects: [project] }
      : { roots: currentRoots(), tasks: [{ taskId: "real-1", projectId: project.id, state: restored ? "assigned" : "needs-repair" }] } }));
    const host = { ...bridge(), listTasks, projectOp };
    window.pidock = host;
    render(<App />);
    await screen.findByTestId("desktop-project-overview");
    if (surface === "management") await openManagement();
    const page = screen.getByTestId(surface === "management" ? "desktop-inventory" : "desktop-shell");
    const retry = within(page).getByRole("button", { name: "重试读取默认任务根" });
    expect(retry).toHaveAttribute("title", "重试读取默认任务根");
    restored = true;
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole("button", { name: "重试读取默认任务根" })).toBeNull());
    expect(within(screen.getByTestId("desktop-breadcrumb")).getByText(project.name)).toBeInTheDocument();
    if (surface === "overview") await waitFor(() => expect(screen.getByTestId("overview-task-count")).toHaveTextContent("1"));
    else {
      expect(screen.getByRole("button", { name: "进入工作区" })).toBeEnabled();
      expect(screen.getByText("real-1")).toBeInTheDocument();
    }
    expect(host.importTaskRoot).not.toHaveBeenCalled();
    expect(listTasks).toHaveBeenCalledTimes(2);
    expect(projectOp.mock.calls.map(([request]) => request.op)).toEqual(["list", "associations", "list", "associations"]);
    if (surface === "overview") await openManagement();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(screen.getByLabelText("仓库路径 1")).toHaveValue(project.repositories[0]?.path);
    expect(screen.getByRole("button", { name: project.name })).toBeInTheDocument();
  });

  it("keeps root Retry in place through busy and failed reads, preserving the edit draft and selection", async () => {
    let restored = false;
    let rejectRead: ((error: Error) => void) | undefined;
    const currentRoots = () => restored ? roots : [{ label: "默认任务根", state: "error" as const, message: "任务根目录已移走" }];
    const listTasks = vi.fn(async () => ({ ok: true, payload: { tasks: restored ? tasks : [], roots: currentRoots() } }));
    const projectOp = vi.fn(async (request: { op: string }) => ({ ok: true, payload: request.op === "list"
      ? { initialized: true, projects: [project] }
      : { roots: currentRoots(), tasks: [{ taskId: "real-1", projectId: project.id, state: restored ? "assigned" : "needs-repair" }] } }));
    const host = { ...bridge(), listTasks, projectOp };
    window.pidock = host;
    render(<App />);
    await openManagement();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const name = screen.getByLabelText("项目名称");
    fireEvent.change(name, { target: { value: "未保存的名称" } });
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "未保存的描述" } });
    listTasks.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRead = reject; }));
    const retries = screen.getAllByRole("button", { name: "重试读取默认任务根" });
    fireEvent.click(retries[0]!);
    fireEvent.click(retries[1]!);
    expect(listTasks).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("项目名称")).toBe(name);
    expect(name).toHaveValue("未保存的名称");
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    for (const retry of retries) expect(retry).toBeDisabled();
    expect(screen.getAllByRole("status")[0]).toHaveTextContent("正在重读任务根");
    rejectRead?.(new Error("任务根读取暂时失败"));
    await waitFor(() => expect(screen.getAllByText("任务根读取暂时失败").length).toBeGreaterThan(0));
    expect(screen.getByLabelText("项目名称")).toBe(name);
    expect(screen.getByLabelText("描述")).toHaveValue("未保存的描述");
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
    for (const retry of screen.getAllByRole("button", { name: "重试读取默认任务根" })) expect(retry).toBeEnabled();
    restored = true;
    fireEvent.click(screen.getAllByRole("button", { name: "重试读取默认任务根" })[1]!);
    await waitFor(() => expect(screen.queryByText("任务根读取暂时失败")).toBeNull());
    expect(screen.getByLabelText("项目名称")).toBe(name);
    expect(name).toHaveValue("未保存的名称");
    expect(screen.getByLabelText("描述")).toHaveValue("未保存的描述");
    expect(screen.getByRole("heading", { name: project.name })).toBeInTheDocument();
    expect(screen.getByText("real-1")).toBeInTheDocument();
    expect(host.importTaskRoot).not.toHaveBeenCalled();
    expect(projectOp.mock.calls.every(([request]) => request.op === "list" || request.op === "associations")).toBe(true);
  });

  it("keeps an unavailable root retryable and preserves navigation during its reread", async () => {
    const broken = [{ label: "默认任务根", state: "error" as const, message: "任务根目录已移走" }];
    let releaseRead: (() => void) | undefined;
    const listTasks = vi.fn(async () => ({ ok: true, payload: { tasks: [], roots: broken } }));
    window.pidock = { ...bridge(), listTasks, projectOp: vi.fn(async (request) => ({ ok: true, payload: request.op === "list"
      ? { initialized: true, projects: [project] }
      : { roots: broken, tasks: [] } })) };
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "重试读取默认任务根" }));
    await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "重试读取默认任务根" })).toBeEnabled());
    expect(screen.getByRole("alert")).toHaveTextContent("任务根目录已移走");
    listTasks.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseRead = resolve; });
      return { ok: true, payload: { tasks: [], roots: broken } };
    });
    fireEvent.click(screen.getByRole("button", { name: "重试读取默认任务根" }));
    fireEvent.click(screen.getByRole("button", { name: "本机设置" }));
    await screen.findByTestId("desktop-settings-page");
    releaseRead?.();
    await waitFor(() => expect(screen.getByRole("button", { name: "重试读取默认任务根" })).toBeEnabled());
    expect(screen.getByTestId("desktop-settings-page")).toBeInTheDocument();
    expect(screen.queryByTestId("desktop-project-overview")).toBeNull();
  });

  it("keeps archived tasks out of active navigation until the Host restores them", async () => {
    let archived = true;
    const taskOp = vi.fn(async (taskId: string, op: string) => {
      if (op === "task/restore") archived = false;
      return { ok: true, payload: { lifecycle: { taskId, archived, archivedAt: archived ? "2026-09-29T09:00:00Z" : null } } };
    });
    window.pidock = { ...bridge({ assigned: true }), taskOp };
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("overview-task-count")).toHaveTextContent("0"));
    expect(screen.queryByRole("button", { name: /真实任务/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "已归档" }));
    expect(await screen.findByText("真实任务")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    await waitFor(() => expect(taskOp).toHaveBeenCalledWith("real-1", "task/restore", {}));
    fireEvent.click(screen.getByRole("button", { name: "项目总览" }));
    await waitFor(() => expect(screen.getByTestId("overview-task-count")).toHaveTextContent("1"));
    expect(screen.getAllByRole("button", { name: /真实任务/ }).length).toBeGreaterThan(0);
  });

  it("opens usage without a task and switches cleanly to Provider and schedules", async () => {
    const taskOp = vi.fn(async () => ({ ok: true, payload: { schedules: [], runs: [] } }));
    window.pidock = { ...bridge(), listTasks: vi.fn(async () => ({ ok: true, payload: { tasks: [], roots } })), projectOp: vi.fn(async (request) => request.op === "list"
      ? { ok: true, payload: { initialized: true, projects: [project] } }
      : { ok: true, payload: { roots, tasks: [] } }), taskOp };
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Token 用量" }));
    expect(await screen.findByTestId("usage-needs-task")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "模型与 Provider" }));
    expect(await screen.findByTestId("desktop-providers-page")).toBeInTheDocument();
    expect(screen.queryByTestId("desktop-usage-page")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "定时任务" }));
    expect(await screen.findByTestId("desktop-schedules-page")).toBeInTheDocument();
    expect(screen.queryByTestId("desktop-providers-page")).toBeNull();
    expect(taskOp).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "需要处理" }));
    expect(await screen.findByTestId("desktop-attention-page")).toBeInTheDocument();
    expect(await screen.findByText("当前执行账本暂无需要处理的事项。")).toBeInTheDocument();
    expect(taskOp).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "环境与服务" }));
    expect(await screen.findByTestId("desktop-environment-page")).toBeInTheDocument();
    expect(screen.getByLabelText("项目")).toHaveValue(project.id);
    expect(screen.getByRole("option", { name: "环境清单未接线" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "远程访问" }));
    expect(await screen.findByTestId("desktop-remote-page")).toBeInTheDocument();
    expect(screen.getByText("没有已核验的活动任务；未读取远程状态。")).toBeInTheDocument();
    expect(taskOp).not.toHaveBeenCalled();
  });

  it("keeps standalone Vite in explicit demo mode", async () => {
    const demoRead = vi.spyOn(memoryHost, "getWorkspace");
    render(<App />);
    await waitFor(() => expect(demoRead).toHaveBeenCalled());
    expect(screen.queryByTestId("desktop-inventory")).not.toBeInTheDocument();
  });

  it("shows disk-backed Project metadata only in selected detail; no fixture fallback", async () => {
    const demoRead = vi.spyOn(memoryHost, "getWorkspace");
    window.pidock = bridge();
    render(<App />);
    // Prototype A opens on the first project; the unassigned list is an explicit pick.
    await openManagement();
    fireEvent.click(screen.getByRole("button", { name: /^未归属任务/ }));
    // The sidebar lists the real task as well (prototype A), so both surfaces are checked.
    expect(await screen.findAllByText("真实任务")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "未归属任务" })).toBeInTheDocument();
    expect(screen.queryByText("/private/work/web")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "真实项目" }));
    expect(screen.getByText("/private/work/web")).toBeInTheDocument();
    expect(screen.getByText("此项目暂无任务")).toBeInTheDocument();
    expect(screen.queryByText("Atlas Web")).not.toBeInTheDocument();
    expect(demoRead).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "任务" })).toBeDisabled();
    expect(screen.getByText("桌面壳真实任务创建接口不可用，请重启应用")).toBeInTheDocument();
  });

  it("claims an explicitly chosen task, rereads authority, then transfers and unlinks", async () => {
    const data = { assigned: false, projectPresent: true };
    const projectOp = vi.fn(async (request: { op: string }) => {
      if (request.op === "list") return { ok: true, payload: { initialized: true, projects: [project, { ...project, id: "6fd712ce-a43b-4614-a459-de81d78a16aa", name: "另一个项目", repositories: [] }] } };
      if (request.op === "associations") return { ok: true, payload: { roots, tasks: [{ taskId: "real-1", projectId: data.assigned ? project.id : null, state: data.assigned ? "assigned" : "unassigned" }] } };
      if (request.op === "claim") data.assigned = true;
      return { ok: true, payload: {} };
    });
    window.pidock = { ...bridge(), listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })), projectOp };
    render(<App />);
    await openManagement();
    fireEvent.click(screen.getByRole("button", { name: /^未归属任务/ }));
    const target = await screen.findByRole("combobox", { name: "真实任务 目标项目" });
    fireEvent.change(target, { target: { value: project.id } });
    fireEvent.click(screen.getByRole("button", { name: "认领" }));
    await waitFor(() => expect(projectOp).toHaveBeenCalledWith({ op: "claim", taskId: "real-1", projectId: project.id }));
    await waitFor(() => expect(screen.getByText("已检查的任务根暂无未归属任务")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "真实项目" }));
    fireEvent.change(screen.getByRole("combobox", { name: "真实任务 目标项目" }), { target: { value: "6fd712ce-a43b-4614-a459-de81d78a16aa" } });
    fireEvent.click(screen.getByRole("button", { name: "转移" }));
    await waitFor(() => expect(projectOp).toHaveBeenCalledWith({ op: "transfer", taskId: "real-1", fromProjectId: project.id, toProjectId: "6fd712ce-a43b-4614-a459-de81d78a16aa" }));
    fireEvent.click(screen.getByRole("button", { name: "解绑" }));
    await waitFor(() => expect(projectOp).toHaveBeenCalledWith({ op: "unlink", taskId: "real-1", expectedProjectId: project.id }));
  });

  it("creates and edits only through main, retaining stable Project IDs", async () => {
    const current = { ...project, repositories: [...project.repositories] };
    const created = { ...project, id: "ddca4190-322c-40b9-bf9e-fab9184ac499", name: "新增项目", repositories: [] };
    let createdPresent = false;
    const projectOp = vi.fn(async (request: Parameters<NonNullable<PidockBridge["projectOp"]>>[0]) => {
      if (request.op === "list") return { ok: true, payload: { initialized: true, projects: createdPresent ? [current, created] : [current] } };
      if (request.op === "associations") return { ok: true, payload: { roots, tasks: [{ taskId: "real-1", projectId: null, state: "unassigned" }] } };
      if (request.op === "update") { current.description = (request.input as { description: string }).description; return { ok: true, payload: { ...current } }; }
      if (request.op === "create") { createdPresent = true; return { ok: true, payload: created }; }
      if (request.op === "rename") current.name = request.name!;
      return { ok: true, payload: {} };
    });
    window.pidock = { ...bridge(), listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })), projectOp };
    render(<App />);
    await openManagement();
    fireEvent.click(await screen.findByRole("button", { name: "真实项目" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("项目名称"), { target: { value: "重新命名" } });
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "修改描述" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(projectOp).toHaveBeenCalledWith({ op: "rename", projectId: project.id, name: "重新命名" }));
    expect(projectOp).toHaveBeenCalledWith({ op: "update", projectId: project.id, input: { description: "修改描述", repositories: project.repositories, directories: [] } });
    expect(await screen.findByRole("heading", { name: "重新命名" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^项目$/ }));
    fireEvent.change(screen.getByLabelText("项目名称"), { target: { value: "新增项目" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(projectOp).toHaveBeenCalledWith({ op: "create", input: { name: "新增项目", description: "", repositories: [], directories: [] } }));
  });

  it("refuses delete of a bound project and exposes repair without offering transfer", async () => {
    const projectOp = vi.fn(async (request: { op: string }) => {
      if (request.op === "list") return { ok: true, payload: { initialized: true, projects: [project] } };
      if (request.op === "associations") return { ok: true, payload: { roots, tasks: [{ taskId: "real-1", projectId: project.id, state: "needs-repair" }] } };
      if (request.op === "delete") return { ok: false, error: "project has associated tasks" };
      return { ok: true, payload: {} };
    });
    window.pidock = { ...bridge(), listTasks: vi.fn(async () => ({ ok: true, payload: { tasks: [], roots } })), projectOp };
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await openManagement();
    fireEvent.click(await screen.findByRole("button", { name: "真实项目" }));
    expect(screen.getByText(/关联待修复/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "转移" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("project has associated tasks"));
    expect(projectOp).toHaveBeenCalledWith({ op: "delete", projectId: project.id });
  });

  it("retains a failed create draft with source rows through reread, retry and cancel", async () => {
    let rejectCreate = true;
    let holdRead = false;
    let releaseRead: (() => void) | undefined;
    const listTasks = vi.fn(async () => {
      if (holdRead) await new Promise<void>((resolve) => { releaseRead = resolve; });
      return { ok: true, payload: { tasks, roots } };
    });
    const created = { ...project, id: "02444ad5-a691-468d-8430-a87e4a936bd5", name: "未保存项目", description: "原样保留", repositories: [{ id: "eb862802-8dda-42de-8885-0e5751d5ac63", name: "Web", path: "/local/web" }], directories: [{ id: "3155d195-bfac-4eae-80e9-bf2215ae337b", name: "Notes", path: "/local/notes" }] };
    let createdPresent = false;
    const projectOp = vi.fn(async (request: { op: string }) => {
      if (request.op === "list") return { ok: true, payload: { initialized: true, projects: createdPresent ? [project, created] : [project] } };
      if (request.op === "associations") return { ok: true, payload: { roots, tasks: [{ taskId: "real-1", projectId: null, state: "unassigned" }] } };
      if (request.op === "create" && rejectCreate) return { ok: false, error: "项目名称重复" };
      if (request.op === "create") { createdPresent = true; return { ok: true, payload: created }; }
      return { ok: true, payload: {} };
    });
    window.pidock = { ...bridge(), listTasks, projectOp };
    render(<App />);
    await openManagement();
    fireEvent.click(await screen.findByRole("button", { name: /^项目$/ }));
    fireEvent.change(screen.getByLabelText("项目名称"), { target: { value: "未保存项目" } });
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "原样保留" } });
    fireEvent.click(screen.getByRole("button", { name: "添加仓库" }));
    fireEvent.change(screen.getByLabelText("仓库名称 1"), { target: { value: "Web" } });
    fireEvent.change(screen.getByLabelText("仓库路径 1"), { target: { value: "/local/web" } });
    fireEvent.click(screen.getByRole("button", { name: "添加目录" }));
    fireEvent.change(screen.getByLabelText("目录名称 1"), { target: { value: "Notes" } });
    fireEvent.change(screen.getByLabelText("目录路径 1"), { target: { value: "/local/notes" } });
    holdRead = true;
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("status")).toHaveTextContent("正在读取本机项目与任务");
    expect(screen.queryByLabelText("项目名称")).not.toBeInTheDocument();
    await waitFor(() => expect(releaseRead).toBeTypeOf("function"));
    holdRead = false;
    releaseRead?.();
    expect(await screen.findByRole("alert")).toHaveTextContent("项目名称重复");
    expect(screen.getByLabelText("项目名称")).toHaveValue("未保存项目");
    expect(screen.getByLabelText("仓库路径 1")).toHaveValue("/local/web");
    expect(screen.getByLabelText("目录路径 1")).toHaveValue("/local/notes");
    rejectCreate = false;
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(projectOp).toHaveBeenCalledTimes(6));
    expect(projectOp).toHaveBeenLastCalledWith({ op: "associations" });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "创建项目" })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^项目$/ }));
    fireEvent.change(screen.getByLabelText("项目名称"), { target: { value: "取消草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: /^项目$/ }));
    expect(screen.getByLabelText("项目名称")).toHaveValue("");
  });

  it("keeps the submitted draft when a write succeeds but authoritative reread fails", async () => {
    let failNextRead = false;
    const created = { ...project, id: "3b4a1dfb-480c-4f32-a71d-a3d41282b050", name: "待核验", repositories: [], directories: [{ id: "039b8a52-e7c9-4b28-af70-3cee22b19a89", name: "Documents", path: "/local/documents" }] };
    const projectOp = vi.fn(async (request: { op: string }) => {
      if (request.op === "create") { failNextRead = true; return { ok: true, payload: created }; }
      if (request.op === "list" && failNextRead) { failNextRead = false; return { ok: false, error: "注册表暂不可读" }; }
      if (request.op === "list") return { ok: true, payload: { initialized: true, projects: [project, created] } };
      return { ok: true, payload: { roots, tasks: [{ taskId: "real-1", projectId: null, state: "unassigned" }] } };
    });
    window.pidock = { ...bridge(), listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })), projectOp };
    render(<App />);
    await openManagement();
    fireEvent.click(await screen.findByRole("button", { name: /^项目$/ }));
    fireEvent.change(screen.getByLabelText("项目名称"), { target: { value: "待核验" } });
    fireEvent.click(screen.getByRole("button", { name: "添加目录" }));
    fireEvent.change(screen.getByLabelText("目录名称 1"), { target: { value: "Documents" } });
    fireEvent.change(screen.getByLabelText("目录路径 1"), { target: { value: "/local/documents" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("注册表暂不可读")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/项目创建已提交/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("heading", { name: "待核验" })).toBeInTheDocument();
    expect(screen.queryByLabelText("项目名称")).not.toBeInTheDocument();
    expect(screen.queryByText(/操作结果无法核验/)).not.toBeInTheDocument();
    expect(projectOp).toHaveBeenCalledWith({ op: "create", input: { name: "待核验", description: "", repositories: [], directories: [{ name: "Documents", path: "/local/documents" }] } });
    expect(projectOp.mock.calls.filter(([request]) => request.op === "create")).toHaveLength(1);
  });

  it("does not resubmit a committed create absent from a later authoritative list", async () => {
    const pending = { ...project, id: "22ba14c9-c5d9-4ba7-8b84-526e3619df11", name: "等待确认" };
    let failRead = false;
    const projectOp = vi.fn(async (request: { op: string }) => {
      if (request.op === "create") { failRead = true; return { ok: true, payload: pending }; }
      if (request.op === "list" && failRead) { failRead = false; return { ok: false, error: "读取失败" }; }
      if (request.op === "list") return { ok: true, payload: { initialized: true, projects: [project] } };
      return { ok: true, payload: { roots, tasks: [{ taskId: "real-1", projectId: null, state: "unassigned" }] } };
    });
    window.pidock = { ...bridge(), listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })), projectOp };
    render(<App />);
    await openManagement();
    fireEvent.click(await screen.findByRole("button", { name: /^项目$/ }));
    fireEvent.change(screen.getByLabelText("项目名称"), { target: { value: "等待确认" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("读取失败")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByLabelText("项目名称")).toHaveValue("等待确认");
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    await waitFor(() => expect(screen.getByText(/尚未在本机清单中确认/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "重新核验" }));
    expect(await screen.findByLabelText("项目名称")).toHaveValue("等待确认");
    expect(projectOp.mock.calls.filter(([request]) => request.op === "create")).toHaveLength(1);
  });

  it("confirming pending A leaves an unrelated unsaved edit of B intact", async () => {
    const pendingA = { ...project, id: "9eb46dbf-8681-4bd6-850d-f6c44906d101", name: "A", repositories: [] };
    const existingB = { ...project, id: "9eb46dbf-8681-4bd6-850d-f6c44906d102", name: "B", repositories: [] };
    let failRead = false;
    let showA = false;
    const projectOp = vi.fn(async (request: { op: string }) => {
      if (request.op === "create") { failRead = true; return { ok: true, payload: pendingA }; }
      if (request.op === "list" && failRead) { failRead = false; return { ok: false, error: "读取失败" }; }
      if (request.op === "list") return { ok: true, payload: { initialized: true, projects: showA ? [existingB, pendingA] : [existingB] } };
      return { ok: true, payload: { roots, tasks: [{ taskId: "real-1", projectId: null, state: "unassigned" }] } };
    });
    window.pidock = { ...bridge(), listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })), projectOp };
    render(<App />);
    await openManagement();
    fireEvent.click(await screen.findByRole("button", { name: /^项目$/ }));
    fireEvent.change(screen.getByLabelText("项目名称"), { target: { value: "A" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("读取失败")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("button", { name: "重新核验" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "B" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("项目名称"), { target: { value: "B 待改名" } });
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "B 未保存的描述" } });
    fireEvent.click(screen.getByRole("button", { name: "添加目录" }));
    fireEvent.change(screen.getByLabelText("目录名称 1"), { target: { value: "B notes" } });
    fireEvent.change(screen.getByLabelText("目录路径 1"), { target: { value: "/local/b-notes" } });
    showA = true;
    fireEvent.click(screen.getByRole("button", { name: "重新核验" }));
    expect(await screen.findByRole("heading", { name: "B" })).toBeInTheDocument();
    expect(screen.getByLabelText("项目名称")).toHaveValue("B 待改名");
    expect(screen.getByLabelText("描述")).toHaveValue("B 未保存的描述");
    expect(screen.getByLabelText("目录路径 1")).toHaveValue("/local/b-notes");
    expect(screen.queryByRole("button", { name: "重新核验" })).not.toBeInTheDocument();
    expect(projectOp.mock.calls.filter(([request]) => request.op === "create")).toHaveLength(1);
  });

  it("does not fabricate a created Project from a malformed operation response", async () => {
    const projectOp = vi.fn(async (request: { op: string }) => {
      if (request.op === "create") return { ok: true, payload: { name: "没有 ID" } };
      if (request.op === "list") return { ok: true, payload: { initialized: true, projects: [project] } };
      return { ok: true, payload: { roots, tasks: [{ taskId: "real-1", projectId: null, state: "unassigned" }] } };
    });
    window.pidock = { ...bridge(), listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })), projectOp };
    render(<App />);
    await openManagement();
    fireEvent.click(await screen.findByRole("button", { name: /^项目$/ }));
    fireEvent.change(screen.getByLabelText("项目名称"), { target: { value: "没有 ID" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText(/创建返回异常/)).toBeInTheDocument();
    expect(screen.getByLabelText("项目名称")).toHaveValue("没有 ID");
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(projectOp.mock.calls.filter(([request]) => request.op === "create")).toHaveLength(1);
  });

  it("preserves the attempted rename after partial edit and distinguishes committed details", async () => {
    const current = { ...project, repositories: [...project.repositories], directories: [] as Array<{ id: string; name: string; path: string }> };
    let rejectRename = true;
    let nextId = 0;
    let nextRepoId = 0;
    const issuedIds: string[] = [];
    const issuedRepoIds: string[] = [];
    const projectOp = vi.fn(async (request: Parameters<NonNullable<PidockBridge["projectOp"]>>[0]) => {
      if (request.op === "list") return { ok: true, payload: { initialized: true, projects: [current] } };
      if (request.op === "associations") return { ok: true, payload: { roots, tasks: [{ taskId: "real-1", projectId: null, state: "unassigned" }] } };
      if (request.op === "update") {
        const details = request.input as { description: string; repositories: typeof current.repositories; directories: typeof current.directories };
        Object.assign(current, { ...details, repositories: details.repositories.map((row) => {
          const id = row.id ?? `00000000-0000-4000-8000-${String(100 + ++nextRepoId).padStart(12, "0")}`;
          if (!row.id) issuedRepoIds.push(id);
          return { ...row, id };
        }), directories: details.directories.map((row) => {
          const id = row.id ?? `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;
          issuedIds.push(id);
          return { ...row, id };
        }) });
        return { ok: true, payload: { ...current } };
      }
      if (request.op === "rename") {
        if (rejectRename) return { ok: false, error: "名称冲突" };
        current.name = request.name!;
      }
      return { ok: true, payload: {} };
    });
    window.pidock = { ...bridge(), listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })), projectOp };
    render(<App />);
    await openManagement();
    fireEvent.click(await screen.findByRole("button", { name: "真实项目" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("项目名称"), { target: { value: "目标名称" } });
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "已写入描述" } });
    fireEvent.click(screen.getByRole("button", { name: "添加仓库" }));
    fireEvent.change(screen.getByLabelText("仓库名称 2"), { target: { value: "API" } });
    fireEvent.change(screen.getByLabelText("仓库路径 2"), { target: { value: "/local/api" } });
    fireEvent.click(screen.getByRole("button", { name: "添加目录" }));
    fireEvent.change(screen.getByLabelText("目录名称 1"), { target: { value: "Notes" } });
    fireEvent.change(screen.getByLabelText("目录路径 1"), { target: { value: "/local/notes" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("资料已保存，但重命名失败");
    expect(screen.getByRole("heading", { name: "真实项目" })).toBeInTheDocument();
    expect(screen.getByText("已写入描述", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByLabelText("项目名称")).toHaveValue("目标名称");
    expect(screen.getByLabelText("目录路径 1")).toHaveValue("/local/notes");
    const firstDirectoryId = "00000000-0000-4000-8000-000000000001";
    expect(issuedIds).toEqual([firstDirectoryId]);
    const firstRepoId = "00000000-0000-4000-8000-000000000101";
    expect(issuedRepoIds).toEqual([firstRepoId]);
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "再次修改描述" } });
    rejectRename = false;
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("heading", { name: "目标名称" })).toBeInTheDocument();
    expect(issuedIds).toEqual([firstDirectoryId, firstDirectoryId]);
    expect(issuedRepoIds).toEqual([firstRepoId]);
    expect(current.repositories[1]?.id).toBe(firstRepoId);
    expect(current.directories[0]?.id).toBe(firstDirectoryId);
    expect(current.description).toBe("再次修改描述");
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("项目名称"), { target: { value: "取消重命名" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(screen.getByLabelText("项目名称")).toHaveValue("目标名称");
  });

  it("shows unavailable inventory tasks without enabling claim", async () => {
    const projectOp = vi.fn(async (request: { op: string }) => ({ ok: true, payload: request.op === "list" ?
      { initialized: true, projects: [project] } : { roots, tasks: [{ taskId: "real-1", projectId: null, state: "unavailable" }] } }));
    window.pidock = { ...bridge(), listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })), projectOp };
    render(<App />);
    await openManagement();
    fireEvent.click(screen.getByRole("button", { name: /^未归属任务/ }));
    expect(await screen.findByText(/任务不可用/)).toBeInTheDocument();
    expect(screen.getAllByText("真实任务")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "认领" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "真实任务 目标项目" })).toBeDisabled();
    expect(screen.queryByText("已检查的任务根暂无未归属任务")).not.toBeInTheDocument();
  });

  it("returns to unassigned after deleting selected A or externally removing it, never targeting B", async () => {
    let projects = [project, { ...project, id: "6fd712ce-a43b-4614-a459-de81d78a16aa", name: "B", repositories: [] }];
    const projectOp = vi.fn(async (request: { op: string }) => {
      if (request.op === "list") return { ok: true, payload: { initialized: true, projects } };
      if (request.op === "associations") return { ok: true, payload: { roots, tasks: [{ taskId: "real-1", projectId: null, state: "unassigned" }] } };
      if (request.op === "delete") projects = projects.filter((item) => item.id !== project.id);
      return { ok: true, payload: {} };
    });
    window.pidock = { ...bridge(), listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })), projectOp };
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await openManagement();
    fireEvent.click(await screen.findByRole("button", { name: "真实项目" }));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(await screen.findByRole("heading", { name: "未归属任务" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "B" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除" })).not.toBeInTheDocument();
    expect(projectOp).toHaveBeenCalledWith({ op: "delete", projectId: project.id });
    fireEvent.click(screen.getByRole("button", { name: "B" }));
    projects = [];
    fireEvent.click(screen.getByRole("button", { name: "找回任务根" }));
    expect(await screen.findByRole("heading", { name: "未归属任务" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除" })).not.toBeInTheDocument();
  });

  it("shows a failed project operation and does not claim success or switch to demo", async () => {
    const demoRead = vi.spyOn(memoryHost, "getWorkspace");
    window.pidock = bridge({ fail: "项目数据损坏" });
    render(<App />);
    expect(await screen.findByText("项目数据损坏")).toBeInTheDocument();
    expect(screen.queryByText("Atlas Web")).not.toBeInTheDocument();
    expect(demoRead).not.toHaveBeenCalled();
  });

  it("opens main attention in the original fixed SDK main conversation without marking it read", async () => {
    const sdkTurn = vi.fn(async (request: Record<string, unknown>) => ({ ok: true, payload: request.action === "subscribe" ?
      { taskId: "real-1", sessionId: "main", snapshot: { source: "sdk-jsonl", sessionId: "main", messages: [{ role: "assistant", text: "SDK main 完成结果", usage: null }], pending: false, interrupted: false }, turn: null } :
      { unsubscribed: true } }));
    const shell = bridge({ assigned: true });
    const taskOp = vi.fn(async (taskId: string, op: string) => op === "task/attention" ? { ok: true, payload: { taskName: "真实任务", items: [{ id: "unread:sdk-main", kind: "completed-unread", executionId: "sdk-main", taskId, sessionId: "main", detail: "SDK 回合完成", at: "2026-10-07T09:00:00Z", read: false }] } } : shell.taskOp!(taskId, op, {}));
    window.pidock = { ...shell, taskOp, sdkTurn, onSdkTurnEvent: vi.fn(() => vi.fn()) };
    const demoRead = vi.spyOn(memoryHost, "getWorkspace");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "需要处理" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看 main 会话" }));
    const conversation = await screen.findByTestId("desktop-conversation");
    expect(await within(conversation).findByText("SDK main 完成结果")).toBeInTheDocument();
    expect(within(conversation).getByRole("tab", { name: "main" })).toBeInTheDocument();
    expect(within(screen.getByTestId("desktop-breadcrumb")).getByText("真实任务")).toBeInTheDocument();
    expect(sdkTurn).toHaveBeenCalledWith({ action: "subscribe", taskId: "real-1", sessionId: "main" });
    expect(sdkTurn).not.toHaveBeenCalledWith(expect.objectContaining({ action: "start" }));
    expect(taskOp).not.toHaveBeenCalledWith("real-1", "task/markAttentionRead", expect.anything());
    expect(demoRead).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "需要处理" }));
    expect(await screen.findByText("完成未读 · 1")).toBeInTheDocument();
  });

  it("keeps legacy attention visible without opening or subscribing to main", async () => {
    const shell = bridge({ assigned: true });
    const sdkTurn = vi.fn(async () => ({ ok: true, payload: {} }));
    const taskOp = vi.fn(async (taskId: string, op: string) => op === "task/attention" ? { ok: true, payload: { taskName: "真实任务", items: [{ id: "failed:legacy", kind: "failed", executionId: "legacy", taskId, sessionId: "legacy-session", detail: "原会话失败", at: "2026-10-07T09:00:00Z", read: false }] } } : shell.taskOp!(taskId, op, {}));
    window.pidock = { ...shell, taskOp, sdkTurn, onSdkTurnEvent: vi.fn(() => vi.fn()) };
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "需要处理" }));
    const destination = await screen.findByRole("button", { name: "原会话定位未接线" });
    expect(destination).toBeDisabled();
    expect(screen.getByText("会话 · legacy-session")).toBeInTheDocument();
    fireEvent.click(destination);
    expect(screen.getByTestId("desktop-attention-page")).toBeInTheDocument();
    expect(screen.queryByTestId("desktop-conversation")).not.toBeInTheDocument();
    expect(sdkTurn).not.toHaveBeenCalled();
    expect(taskOp).not.toHaveBeenCalledWith("real-1", "task/markAttentionRead", expect.anything());
  });

  it.each(["unavailable-root", "archived"])("refuses a main attention destination after the task becomes %s", async (unavailable) => {
    const shell = bridge({ assigned: true });
    let changed = false;
    const sdkTurn = vi.fn(async () => ({ ok: true, payload: {} }));
    const taskOp = vi.fn(async (taskId: string, op: string) => op === "task/attention" ? { ok: true, payload: { taskName: "真实任务", items: [{ id: "failed:main", kind: "failed", executionId: "sdk-main", taskId, sessionId: "main", detail: "SDK 回合失败", at: "2026-10-07T09:00:00Z", read: false }] } } : { ok: true, payload: { lifecycle: { taskId, archived: changed && unavailable === "archived", archivedAt: changed && unavailable === "archived" ? "2026-10-07T09:01:00Z" : null } } });
    const currentRoots = () => changed && unavailable === "unavailable-root" ? [{ label: "默认任务根", state: "error", message: "任务根已移走" }] : roots;
    const listTasks = vi.fn(async () => ({ ok: true, payload: { tasks, roots: currentRoots() } }));
    const projectOp: PidockBridge["projectOp"] = async (request) => request.op === "associations"
      ? { ok: true, payload: { roots: currentRoots(), tasks: [{ taskId: "real-1", projectId: project.id, state: "assigned" }] } }
      : shell.projectOp!(request);
    window.pidock = { ...shell, listTasks, projectOp, taskOp, sdkTurn, onSdkTurnEvent: vi.fn(() => vi.fn()) };
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "需要处理" }));
    const destination = await screen.findByRole("button", { name: "查看 main 会话" });
    changed = true;
    fireEvent.click(destination);
    const message = unavailable === "archived" ? "该任务已归档，请先从已归档页恢复" : "任务或任务根不可用，请重新选择";
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByTestId("desktop-conversation")).not.toBeInTheDocument();
    expect(sdkTurn).not.toHaveBeenCalled();
    expect(taskOp).not.toHaveBeenCalledWith("real-1", "task/markAttentionRead", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "项目总览" }));
    expect(screen.queryByText(message)).not.toBeInTheDocument();
  });

  it("opens a freshly verified assigned task in the fixed SDK main session and returns without DemoApp", async () => {
    const sdkTurn = vi.fn(async (request: Record<string, unknown>) => ({ ok: true, payload: request.action === "subscribe" ?
      { taskId: "real-1", sessionId: "main", snapshot: { source: "sdk-jsonl", sessionId: "main", messages: [], pending: false, interrupted: false }, turn: null } :
      { unsubscribed: true } }));
    const shell = { ...bridge({ assigned: true }), sdkTurn, onSdkTurnEvent: vi.fn(() => vi.fn()) };
    window.pidock = shell;
    const demoRead = vi.spyOn(memoryHost, "getWorkspace");
    render(<App />);
    await openManagement();
    fireEvent.click(await screen.findByRole("button", { name: "真实项目" }));
    fireEvent.click(screen.getByRole("button", { name: "进入工作区" }));
    expect(await screen.findByText(/尚未开始/)).toBeInTheDocument();
    // The shell keeps the workspace context visible: sidebar, breadcrumb and session tab.
    expect(screen.getByTestId("desktop-sidebar")).toBeInTheDocument();
    expect(within(screen.getByTestId("desktop-breadcrumb")).getByText("真实项目")).toBeInTheDocument();
    expect(within(screen.getByTestId("desktop-breadcrumb")).getByText("真实任务")).toBeInTheDocument();
    expect(sdkTurn).toHaveBeenCalledWith({ action: "subscribe", taskId: "real-1", sessionId: "main" });
    expect(shell.listTasks).toHaveBeenCalledTimes(3);
    expect(demoRead).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "返回任务列表" }));
    expect(await screen.findByRole("heading", { name: "真实项目" })).toBeInTheDocument();
    await waitFor(() => expect(sdkTurn).toHaveBeenCalledWith({ action: "unsubscribe", taskId: "real-1", sessionId: "main" }));
  });

  it("fails visibly without bridge and retains native task root import", async () => {
    const original = Object.getOwnPropertyDescriptor(window.navigator, "userAgent");
    Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: "Electron/44" });
    try {
      render(<App />);
      expect(await screen.findByRole("alert")).toHaveTextContent("桌面壳任务读取接口不可用");
    } finally {
      cleanup();
      if (original) Object.defineProperty(window.navigator, "userAgent", original);
    }
    window.pidock = bridge();
    render(<App />);
    await openManagement();
    fireEvent.click(await screen.findByRole("button", { name: "找回任务根" }));
    await waitFor(() => expect(window.pidock?.importTaskRoot).toHaveBeenCalledTimes(1));
  });
});

describe("[UI 对齐 S8e] project overview page", () => {
  it("counts real tasks/repos and marks 运行环境 as unwired instead of inventing a number", async () => {
    window.pidock = bridge({ projectPresent: true });
    render(<App />);
    expect(await screen.findByTestId("desktop-project-overview")).toBeInTheDocument();
    expect(screen.getByTestId("overview-repo-count")).toHaveTextContent("1");
    expect(screen.getByTestId("overview-env-unwired")).toHaveTextContent("未接线");
    // The project-scoped task is offered as a real 继续工作 card and opens the workspace.
    expect(screen.queryByTestId("overview-no-tasks")).toBeInTheDocument();
  });

  it("opens management from the overview instead of showing it by default", async () => {
    window.pidock = bridge({ projectPresent: true });
    render(<App />);
    await screen.findByTestId("desktop-project-overview");
    expect(screen.queryByLabelText("项目名称")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "项目管理" }));
    expect(await screen.findByRole("heading", { name: "真实项目" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回项目总览" }));
    expect(await screen.findByTestId("desktop-project-overview")).toBeInTheDocument();
  });
});
