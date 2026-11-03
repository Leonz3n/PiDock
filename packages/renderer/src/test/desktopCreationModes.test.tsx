/**
 * [Pencil T02] #137 / S02: the create form carries an explicit task workspace
 * mode. The mode changes which source rows are usable and what is sent to main,
 * and the env/push blocks only PREVIEW the workspace facts (#144/#148 own the
 * real behaviour).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DesktopTaskCreation } from "../components/DesktopTaskCreation";
import type { DesktopProject } from "../data/desktopProjects";
import type { PidockBridge } from "../data/shellBridge";

const project: DesktopProject = {
  id: "bcedc870-22bd-474e-ac55-78d30a9d763d", name: "Core", description: "",
  repositories: [
    { id: "dad5fcb4-c91f-4ab0-bc33-fbb82053f871", name: "Web", path: "/local/web" },
    { id: "e6f9b7b0-2e55-4acb-b655-0a1e3f7bbf0c", name: "API", path: "/local/api" },
  ],
  directories: [{ id: "e2eb192a-108b-4f9b-89a4-cd1fd8fb1fd0", name: "Documents", path: "/local/documents" }],
  environment: [{ key: "NODE_ENV", value: "development" }, { key: "API_BASE_URL", value: "https://api.dev" }],
  branchTemplate: "feature/{task-name}",
};
const existingIntent = {
  id: "a01fe61e-d112-487e-a7e8-113943b91072", taskId: "task-abc12345", name: "Refactor Auth", projectId: project.id,
  root: "/local/tasks", taskDir: "/local/tasks/task-abc12345", branch: "task/task-abc12345", state: "pending",
  workspaceMode: "existing-git",
  repos: [{ id: project.repositories[0]!.id, name: "Web", remote: "origin", remoteBranch: "main", commit: "a".repeat(40), repoDir: "repo-web", path: "/local/web" }],
  directories: [],
};
function bridge(operation: NonNullable<PidockBridge["createTask"]>): PidockBridge { return { createTask: operation }; }
afterEach(cleanup);

describe("task workspace mode in the S02 create form", () => {
  it("starts in the default worktree mode and disables Git repos in plain-dirs mode", async () => {
    const createTask = vi.fn(async (request: { op: string }) => {
      if (request.op === "current") return { ok: true, payload: null };
      return { ok: true, payload: { canceled: false, intent: existingIntent } };
    });
    render(<DesktopTaskCreation project={project} bridge={bridge(createTask)} onCreated={vi.fn(async () => {})} />);
    fireEvent.click(screen.getByRole("button", { name: "任务" }));
    expect(screen.getByRole("dialog", { name: "新建任务" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "独立 Worktree（默认）" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Web" })).toBeEnabled();
    expect(screen.getByText(/为每个选中仓库创建独立 Worktree/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "仅普通目录" }));
    expect(screen.getByRole("checkbox", { name: "Web" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Web" })).not.toBeChecked();
    expect(screen.getAllByText(/仅普通目录：共享原文件，不涉及 Git/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "预览路径" })).toBeDisabled();
  });

  it("sends existing-git with an empty remote branch (main reads the current checkout branch)", async () => {
    const createTask = vi.fn(async (request: { op: string; input?: unknown }) => {
      if (request.op === "current") return { ok: true, payload: null };
      return { ok: true, payload: { canceled: false, intent: existingIntent } };
    });
    render(<DesktopTaskCreation project={project} bridge={bridge(createTask)} onCreated={vi.fn(async () => {})} />);
    fireEvent.click(screen.getByRole("button", { name: "任务" }));
    fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "Refactor Auth" } });
    fireEvent.click(screen.getByRole("radio", { name: "已有 Git 目录" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Web" }));
    fireEvent.change(screen.getByLabelText("远程名称"), { target: { value: "origin" } });
    expect(screen.queryByLabelText("远程分支")).not.toBeInTheDocument();
    expect(screen.getByText(/使用该目录当前检出的分支/)).toBeInTheDocument();
    expect(screen.getAllByText(/不创建 Worktree、不创建任务分支/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "读取原检出并预览" }));
    await waitFor(() => expect(createTask).toHaveBeenCalledWith({ op: "prepare", input: {
      projectId: project.id, name: "Refactor Auth", workspaceMode: "existing-git",
      repositories: [{ sourceId: project.repositories[0]!.id, remote: "origin", remoteBranch: "" }],
      directoryIds: [], sharedWriteConfirmed: false, override: false,
    } }));
    // The preview names the real checkout, branch and HEAD — not a worktree.
    expect(await screen.findByText(/原检出 \/local\/web/)).toBeInTheDocument();
    expect(screen.getByText(/当前分支 main/)).toBeInTheDocument();
    expect(screen.getByText(/HEAD a{40}/)).toBeInTheDocument();
    expect(screen.getByText(/共享原文件，不创建 Worktree 或任务分支/)).toBeInTheDocument();
  });

  it("shows the workspace env as inherited (display only) and the branch template as a push preview only", () => {
    render(<DesktopTaskCreation project={project} bridge={bridge(vi.fn(async () => ({ ok: true, payload: null })))} onCreated={vi.fn(async () => {})} />);
    fireEvent.click(screen.getByRole("button", { name: "任务" }));
    fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "Refactor Auth" } });
    expect(screen.getByText(/运行环境变量（继承自工作区）/)).toBeInTheDocument();
    expect(screen.getByText(/NODE_ENV=development/)).toBeInTheDocument();
    expect(screen.getByText(/已读取 2 个工作区变量（仅展示；任务级注入见 #144）/)).toBeInTheDocument();
    expect(screen.getByText("origin/feature/refactor-auth")).toBeInTheDocument();
    expect(screen.getByText(/本任务创建不会推送.*#148/)).toBeInTheDocument();
    expect(screen.getByText(/跨任务隔离尚未完成（T06）/)).toBeInTheDocument();
  });

  it("lands on the created task after commit", async () => {
    const createTask = vi.fn(async (request: { op: string }) => {
      if (request.op === "current") return { ok: true, payload: null };
      if (request.op === "prepare") return { ok: true, payload: { canceled: false, intent: existingIntent } };
      return { ok: true, payload: { taskId: existingIntent.taskId, projectId: project.id } };
    });
    const onCreated = vi.fn(async () => {});
    render(<DesktopTaskCreation project={project} bridge={bridge(createTask)} onCreated={onCreated} />);
    fireEvent.click(screen.getByRole("button", { name: "任务" }));
    fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "Refactor Auth" } });
    fireEvent.click(screen.getByRole("radio", { name: "已有 Git 目录" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Web" }));
    fireEvent.change(screen.getByLabelText("远程名称"), { target: { value: "origin" } });
    fireEvent.click(screen.getByRole("button", { name: "读取原检出并预览" }));
    await screen.findByText(/原检出 \/local\/web/);
    fireEvent.click(screen.getByRole("button", { name: "确认创建 / 恢复" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(project.id, existingIntent.taskId));
  });

  it("reopens the pending intent after Esc instead of a form main would refuse", async () => {
    // Main keeps the pending intent when the dialog closes, so a bare form
    // could not prepare a second one (`已有待完成的任务`). Reopening must read it
    // back and show the resumable preview.
    const createTask = vi.fn(async (request: { op: string }) => {
      if (request.op === "current") return { ok: true, payload: existingIntent };
      return { ok: true, payload: { canceled: false, intent: existingIntent } };
    });
    render(<DesktopTaskCreation project={project} bridge={bridge(createTask)} onCreated={vi.fn(async () => {})} />);
    // The mount read opens the dialog on the pending intent by itself.
    expect(await screen.findByText(/原检出 \/local\/web/)).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "新建任务" })).not.toBeInTheDocument());
    const readsBefore = createTask.mock.calls.filter(([request]) => request.op === "current").length;
    fireEvent.click(screen.getByRole("button", { name: "任务" }));
    await waitFor(() => expect(createTask.mock.calls.filter(([request]) => request.op === "current").length).toBeGreaterThan(readsBefore));
    expect(await screen.findByText(/原检出 \/local\/web/)).toBeInTheDocument();
    expect(screen.queryByLabelText("任务名称")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "读取原检出并预览" })).not.toBeInTheDocument();
  });

  it("keeps the S02 keyboard contract: Esc closes and ⌘↵ submits", async () => {
    const createTask = vi.fn(async (request: { op: string }) => {
      if (request.op === "current") return { ok: true, payload: null };
      return { ok: true, payload: { canceled: true } };
    });
    render(<DesktopTaskCreation project={project} bridge={bridge(createTask)} onCreated={vi.fn(async () => {})} />);
    fireEvent.click(screen.getByRole("button", { name: "任务" }));
    expect(screen.getByRole("dialog", { name: "新建任务" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "新建任务" })).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "任务" }));
    fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "Keyboard" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Web" }));
    fireEvent.change(screen.getByLabelText("远程名称"), { target: { value: "origin" } });
    fireEvent.change(screen.getByLabelText("远程分支"), { target: { value: "main" } });
    fireEvent.keyDown(document, { key: "Enter", metaKey: true });
    await waitFor(() => expect(createTask.mock.calls.some(([request]) => request.op === "prepare")).toBe(true));
  });
});
