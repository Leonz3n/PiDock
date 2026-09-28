import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { App } from "../App";
import { memoryHost } from "../data/memoryHost";
import type { PidockBridge } from "../data/shellBridge";

const tasks = [{ taskId: "real-1", name: "真实任务", branch: "task/main", repoCount: 1, updatedAt: "2026-09-22" }];
const roots = [{ label: "默认任务根", state: "ready" as const }];
const project = { id: "bcedc870-22bd-474e-ac55-78d30a9d763d", name: "真实项目", description: "系统 A", repositories: [{ id: "source-1", name: "Web", path: "/private/work/web" }], directories: [] };
const bridge = (settings: { projectPresent?: boolean; assigned?: boolean; fail?: string } = {}): PidockBridge => ({
  listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })),
  importTaskRoot: vi.fn(async () => ({ ok: true, payload: { canceled: false, count: 1 } })),
  projectOp: vi.fn(async (request) => {
    if (settings.fail) return { ok: false, error: settings.fail };
    if (request.op === "list") return { ok: true, payload: { initialized: settings.projectPresent ?? true, projects: settings.projectPresent === false ? [] : [project] } };
    if (request.op === "associations") return { ok: true, payload: { roots, tasks: [{ taskId: "real-1", projectId: settings.assigned ? project.id : null, state: settings.assigned ? "assigned" : "unassigned" }] } };
    return { ok: true, payload: { id: "receipt-1" } };
  }),
});

afterEach(() => { cleanup(); delete window.pidock; vi.restoreAllMocks(); });

describe("Desktop production data", () => {
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
    expect(await screen.findByText("真实任务")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "未归属任务" })).toBeInTheDocument();
    expect(screen.queryByText("/private/work/web")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "真实项目" }));
    expect(screen.getByText("/private/work/web")).toBeInTheDocument();
    expect(screen.getByText("此项目暂无任务")).toBeInTheDocument();
    expect(screen.queryByText("Atlas Web")).not.toBeInTheDocument();
    expect(demoRead).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "创建任务（尚未接线）" })).toBeDisabled();
  });

  it("claims an explicitly chosen task, rereads authority, then transfers and unlinks", async () => {
    const data = { assigned: false, projectPresent: true };
    const projectOp = vi.fn(async (request: { op: string }) => {
      if (request.op === "list") return { ok: true, payload: { initialized: true, projects: [project, { ...project, id: "second-id", name: "另一个项目", repositories: [] }] } };
      if (request.op === "associations") return { ok: true, payload: { roots, tasks: [{ taskId: "real-1", projectId: data.assigned ? project.id : null, state: data.assigned ? "assigned" : "unassigned" }] } };
      if (request.op === "claim") data.assigned = true;
      return { ok: true, payload: {} };
    });
    window.pidock = { listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })), projectOp };
    render(<App />);
    const target = await screen.findByRole("combobox", { name: "真实任务 目标项目" });
    fireEvent.change(target, { target: { value: project.id } });
    fireEvent.click(screen.getByRole("button", { name: "认领" }));
    await waitFor(() => expect(projectOp).toHaveBeenCalledWith({ op: "claim", taskId: "real-1", projectId: project.id }));
    await waitFor(() => expect(screen.getByText("已检查的任务根暂无未归属任务")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "真实项目" }));
    fireEvent.change(screen.getByRole("combobox", { name: "真实任务 目标项目" }), { target: { value: "second-id" } });
    fireEvent.click(screen.getByRole("button", { name: "转移" }));
    await waitFor(() => expect(projectOp).toHaveBeenCalledWith({ op: "transfer", taskId: "real-1", fromProjectId: project.id, toProjectId: "second-id" }));
    fireEvent.click(screen.getByRole("button", { name: "解绑" }));
    await waitFor(() => expect(projectOp).toHaveBeenCalledWith({ op: "unlink", taskId: "real-1", expectedProjectId: project.id }));
  });

  it("creates and edits only through main, retaining stable Project IDs", async () => {
    const current = { ...project, repositories: [...project.repositories] };
    const projectOp = vi.fn(async (request: Parameters<NonNullable<PidockBridge["projectOp"]>>[0]) => {
      if (request.op === "list") return { ok: true, payload: { initialized: true, projects: [current] } };
      if (request.op === "associations") return { ok: true, payload: { roots, tasks: [{ taskId: "real-1", projectId: null, state: "unassigned" }] } };
      if (request.op === "update") current.description = (request.input as { description: string }).description;
      if (request.op === "rename") current.name = request.name!;
      return { ok: true, payload: {} };
    });
    window.pidock = { listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })), projectOp };
    render(<App />);
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
    window.pidock = { listTasks: vi.fn(async () => ({ ok: true, payload: { tasks: [], roots } })), projectOp };
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
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
    const projectOp = vi.fn(async (request: { op: string }) => {
      if (request.op === "list") return { ok: true, payload: { initialized: true, projects: [project] } };
      if (request.op === "associations") return { ok: true, payload: { roots, tasks: [{ taskId: "real-1", projectId: null, state: "unassigned" }] } };
      if (request.op === "create" && rejectCreate) return { ok: false, error: "项目名称重复" };
      return { ok: true, payload: {} };
    });
    window.pidock = { listTasks, projectOp };
    render(<App />);
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
    const projectOp = vi.fn(async (request: { op: string }) => {
      if (request.op === "create") { failNextRead = true; return { ok: true, payload: {} }; }
      if (request.op === "list" && failNextRead) { failNextRead = false; return { ok: false, error: "注册表暂不可读" }; }
      if (request.op === "list") return { ok: true, payload: { initialized: true, projects: [project] } };
      return { ok: true, payload: { roots, tasks: [{ taskId: "real-1", projectId: null, state: "unassigned" }] } };
    });
    window.pidock = { listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })), projectOp };
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /^项目$/ }));
    fireEvent.change(screen.getByLabelText("项目名称"), { target: { value: "待核验" } });
    fireEvent.click(screen.getByRole("button", { name: "添加目录" }));
    fireEvent.change(screen.getByLabelText("目录名称 1"), { target: { value: "Documents" } });
    fireEvent.change(screen.getByLabelText("目录路径 1"), { target: { value: "/local/documents" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("注册表暂不可读")).toBeInTheDocument();
    expect(screen.getByText(/操作结果无法核验/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByLabelText("项目名称")).toHaveValue("待核验");
    expect(screen.getByLabelText("目录路径 1")).toHaveValue("/local/documents");
  });

  it("preserves the attempted rename after partial edit and distinguishes committed details", async () => {
    const current = { ...project, repositories: [...project.repositories], directories: [] as Array<{ id: string; name: string; path: string }> };
    let rejectRename = true;
    const projectOp = vi.fn(async (request: Parameters<NonNullable<PidockBridge["projectOp"]>>[0]) => {
      if (request.op === "list") return { ok: true, payload: { initialized: true, projects: [current] } };
      if (request.op === "associations") return { ok: true, payload: { roots, tasks: [{ taskId: "real-1", projectId: null, state: "unassigned" }] } };
      if (request.op === "update") {
        const details = request.input as { description: string; repositories: typeof current.repositories; directories: typeof current.directories };
        Object.assign(current, { ...details, directories: details.directories.map((row) => ({ ...row, id: row.id ?? "new-directory-id" })) });
      }
      if (request.op === "rename") {
        if (rejectRename) return { ok: false, error: "名称冲突" };
        current.name = request.name!;
      }
      return { ok: true, payload: {} };
    });
    window.pidock = { listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })), projectOp };
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "真实项目" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("项目名称"), { target: { value: "目标名称" } });
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "已写入描述" } });
    fireEvent.click(screen.getByRole("button", { name: "添加目录" }));
    fireEvent.change(screen.getByLabelText("目录名称 1"), { target: { value: "Notes" } });
    fireEvent.change(screen.getByLabelText("目录路径 1"), { target: { value: "/local/notes" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("资料已保存，但重命名失败");
    expect(screen.getByRole("heading", { name: "真实项目" })).toBeInTheDocument();
    expect(screen.getByText("已写入描述", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByLabelText("项目名称")).toHaveValue("目标名称");
    expect(screen.getByLabelText("目录路径 1")).toHaveValue("/local/notes");
    rejectRename = false;
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("heading", { name: "目标名称" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("项目名称"), { target: { value: "取消重命名" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(screen.getByLabelText("项目名称")).toHaveValue("目标名称");
  });

  it("shows unavailable inventory tasks without enabling claim", async () => {
    const projectOp = vi.fn(async (request: { op: string }) => ({ ok: true, payload: request.op === "list" ?
      { initialized: true, projects: [project] } : { roots, tasks: [{ taskId: "real-1", projectId: null, state: "unavailable" }] } }));
    window.pidock = { listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })), projectOp };
    render(<App />);
    expect(await screen.findByText(/任务不可用/)).toBeInTheDocument();
    expect(screen.getByText("真实任务")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "认领" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "真实任务 目标项目" })).toBeDisabled();
    expect(screen.queryByText("已检查的任务根暂无未归属任务")).not.toBeInTheDocument();
  });

  it("returns to unassigned after deleting selected A or externally removing it, never targeting B", async () => {
    let projects = [project, { ...project, id: "second-id", name: "B", repositories: [] }];
    const projectOp = vi.fn(async (request: { op: string }) => {
      if (request.op === "list") return { ok: true, payload: { initialized: true, projects } };
      if (request.op === "associations") return { ok: true, payload: { roots, tasks: [{ taskId: "real-1", projectId: null, state: "unassigned" }] } };
      if (request.op === "delete") projects = projects.filter((item) => item.id !== project.id);
      return { ok: true, payload: {} };
    });
    window.pidock = { listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })), projectOp };
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
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
    fireEvent.click(await screen.findByRole("button", { name: "找回任务根" }));
    await waitFor(() => expect(window.pidock?.importTaskRoot).toHaveBeenCalledTimes(1));
  });
});
