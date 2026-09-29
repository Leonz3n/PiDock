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
  projectOp: vi.fn(async (request) => {
    if (settings.fail) return { ok: false, error: settings.fail };
    if (request.op === "list") return { ok: true, payload: { initialized: settings.projectPresent ?? true, projects: settings.projectPresent === false ? [] : [project] } };
    if (request.op === "associations") return { ok: true, payload: { roots, tasks: [{ taskId: "real-1", projectId: settings.assigned ? project.id : null, state: settings.assigned ? "assigned" : "unassigned" }] } };
    return { ok: true, payload: { id: "ced35ecc-2d27-4ff8-a3cb-02dc5900e7a9" } };
  }),
});

afterEach(() => { cleanup(); delete window.pidock; vi.restoreAllMocks(); });

describe("Desktop production data", () => {
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
    window.pidock = { listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })), projectOp };
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
    window.pidock = { listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })), projectOp };
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
    window.pidock = { listTasks: vi.fn(async () => ({ ok: true, payload: { tasks: [], roots } })), projectOp };
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
    window.pidock = { listTasks, projectOp };
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
    window.pidock = { listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })), projectOp };
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
    window.pidock = { listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })), projectOp };
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
    window.pidock = { listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })), projectOp };
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
    window.pidock = { listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })), projectOp };
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
    window.pidock = { listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })), projectOp };
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
    window.pidock = { listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })), projectOp };
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
    window.pidock = { listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })), projectOp };
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
