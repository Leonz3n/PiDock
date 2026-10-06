import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DesktopTaskCreation } from "../components/DesktopTaskCreation";
import type { DesktopProject } from "../data/desktopProjects";
import type { PidockBridge } from "../data/shellBridge";

const project: DesktopProject = { id: "bcedc870-22bd-474e-ac55-78d30a9d763d", name: "Real", description: "", repositories: [
  { id: "dad5fcb4-c91f-4ab0-bc33-fbb82053f871", name: "Web", path: "/local/web" },
], directories: [{ id: "e2eb192a-108b-4f9b-89a4-cd1fd8fb1fd0", name: "Documents", path: "/local/documents" }] };
const intent = { id: "a01fe61e-d112-487e-a7e8-113943b91072", taskId: "task-abc", name: "Work", projectId: project.id,
  root: "/local/tasks", taskDir: "/local/tasks/task-abc", branch: "task/abc", state: "pending", sharedWriteConfirmed: true,
  repos: [{ id: project.repositories[0]!.id, name: "Web", remote: "origin", remoteBranch: "main", commit: "a".repeat(40), repoDir: "repo-web" }],
  directories: [{ id: project.directories[0]!.id, name: "Documents", path: "/local/documents", linkName: "dir-documents" }] };
function bridge(operation: NonNullable<PidockBridge["createTask"]>): PidockBridge { return { createTask: operation }; }
afterEach(cleanup);

describe("Desktop task creation", () => {
  it("requires explicit remote, branch and shared writable directory confirmation before preview; commits fixed intent only once", async () => {
    const createTask = vi.fn(async (request: { op: string; input?: unknown; id?: string }) => {
      if (request.op === "current") return { ok: true, payload: null };
      if (request.op === "prepare") return { ok: true, payload: { canceled: false, intent } };
      return { ok: true, payload: { taskId: intent.taskId, projectId: project.id } };
    });
    const onCreated = vi.fn(async () => {});
    render(<DesktopTaskCreation project={project} bridge={bridge(createTask)} onCreated={onCreated} />);
    fireEvent.click(screen.getByRole("button", { name: "任务" }));
    fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "Work" } });
    const web = screen.getByRole("checkbox", { name: "Web" });
    fireEvent.click(web);
    fireEvent.change(screen.getByLabelText("远程名称"), { target: { value: "origin" } });
    fireEvent.change(screen.getByLabelText("远程分支"), { target: { value: "main" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Documents/ }));
    expect(screen.getByText(/共享可写链接接入任务/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /我确认普通目录/ }));
    fireEvent.click(screen.getByRole("button", { name: "固定基线并预览路径" }));
    await waitFor(() => expect(createTask).toHaveBeenCalledWith({ op: "prepare", input: { projectId: project.id, name: "Work",
      repositories: [{ sourceId: project.repositories[0]!.id, remote: "origin", remoteBranch: "main" }], directoryIds: [project.directories[0]!.id], sharedWriteConfirmed: true, override: false } }));
    expect(await screen.findByText(intent.taskDir)).toBeInTheDocument();
    expect(screen.getByText(/a{40}/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认创建 / 恢复" }));
    await waitFor(() => expect(createTask).toHaveBeenCalledWith({ op: "commit", id: intent.id }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(project.id));
    expect(createTask.mock.calls.filter(([request]) => request.op === "commit")).toHaveLength(1);
  });
  it.each(["cancel", "error"] as const)("retains selected inputs after picker/prepare %s and previews the same request on retry", async (outcome) => {
    let attempts = 0;
    const createTask = vi.fn(async (request: { op: string; input?: unknown; id?: string }) => {
      if (request.op === "current") return { ok: true, payload: null };
      if (request.op === "prepare" && attempts++ === 0) return outcome === "cancel"
        ? { ok: true, payload: { canceled: true } }
        : { ok: false, error: "remote branch unavailable" };
      if (request.op === "prepare") return { ok: true, payload: { canceled: false, intent } };
      throw new Error("must not commit before confirmation");
    });
    const onCreated = vi.fn(async () => {});
    render(<DesktopTaskCreation project={project} bridge={bridge(createTask)} onCreated={onCreated} />);
    fireEvent.click(screen.getByRole("button", { name: "任务" }));
    const name = screen.getByLabelText("任务名称");
    fireEvent.change(name, { target: { value: "Retained draft" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Web" }));
    fireEvent.change(screen.getByLabelText("远程名称"), { target: { value: "origin" } });
    fireEvent.change(screen.getByLabelText("远程分支"), { target: { value: "main" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Documents/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /我确认普通目录/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /单次选择其他任务根/ }));
    fireEvent.click(screen.getByRole("button", { name: "固定基线并预览路径" }));
    await waitFor(() => expect(createTask.mock.calls.filter(([request]) => request.op === "prepare")).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "固定基线并预览路径" })).toBeEnabled());
    expect(screen.getByLabelText("任务名称")).toBe(name);
    expect(name).toHaveValue("Retained draft");
    expect(screen.getByLabelText("远程名称")).toHaveValue("origin");
    expect(screen.getByLabelText("远程分支")).toHaveValue("main");
    for (const label of ["Web", /Documents/, /我确认普通目录/, /单次选择其他任务根/]) {
      expect(screen.getByRole("checkbox", { name: label })).toBeChecked();
    }
    expect(screen.queryByText(intent.taskDir)).not.toBeInTheDocument();
    expect(createTask.mock.calls.some(([request]) => request.op === "commit")).toBe(false);
    expect(onCreated).not.toHaveBeenCalled();
    if (outcome === "error") expect(screen.getByRole("alert")).toHaveTextContent("remote branch unavailable");
    else expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "固定基线并预览路径" }));
    expect(await screen.findByText(intent.taskDir)).toBeInTheDocument();
    const expected = { op: "prepare", input: { projectId: project.id, name: "Retained draft",
      repositories: [{ sourceId: project.repositories[0]!.id, remote: "origin", remoteBranch: "main" }],
      directoryIds: [project.directories[0]!.id], sharedWriteConfirmed: true, override: true } };
    expect(createTask.mock.calls.filter(([request]) => request.op === "prepare").map(([request]) => request)).toEqual([expected, expected]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
  });
  it("recovers a pending creation after remount, reports failed commit, and retries unchanged ID", async () => {
    let failures = 1;
    const createTask = vi.fn(async (request: { op: string; id?: string }) => {
      if (request.op === "current") return { ok: true, payload: intent };
      if (request.op === "commit" && failures--) return { ok: false, error: "fetch failed" };
      return { ok: true, payload: { taskId: intent.taskId, projectId: project.id } };
    });
    render(<DesktopTaskCreation project={project} bridge={bridge(createTask)} onCreated={vi.fn(async () => {})} />);
    expect(await screen.findByText(intent.taskDir)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认创建 / 恢复" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("fetch failed");
    expect(screen.getByText(intent.taskDir)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认创建 / 恢复" }));
    await waitFor(() => expect(createTask.mock.calls.filter(([request]) => request.op === "commit")).toHaveLength(2));
    expect(createTask.mock.calls.filter(([request]) => request.op === "commit").map(([request]) => request.id)).toEqual([intent.id, intent.id]);
  });
  it("explicitly abandons a pending intent without deleting anything and permits a new form", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const createTask = vi.fn(async (request: { op: string; id?: string }) => request.op === "current"
      ? { ok: true, payload: intent }
      : { ok: true, payload: { taskId: intent.taskId, abandoned: true } });
    render(<DesktopTaskCreation project={project} bridge={bridge(createTask)} onCreated={vi.fn(async () => {})} />);
    expect(await screen.findByText(intent.taskDir)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "放弃并重新创建" }));
    await waitFor(() => expect(createTask).toHaveBeenCalledWith({ op: "abandon", id: intent.id }));
    expect(confirm).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByText(intent.taskDir)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "任务" }));
    expect(screen.getByLabelText("任务名称")).toHaveValue("");
    confirm.mockRestore();
  });
  it("refuses to submit stale source IDs when Project selection changes", async () => {
    const createTask = vi.fn(async (_request: { op: string }) => ({ ok: true, payload: null }));
    const view = render(<DesktopTaskCreation project={project} bridge={bridge(createTask)} onCreated={vi.fn(async () => {})} />);
    fireEvent.click(screen.getByRole("button", { name: "任务" }));
    fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "Draft" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Web" }));
    view.rerender(<DesktopTaskCreation project={{ ...project, id: "f988454a-659d-41d7-b454-c738791a2324", repositories: [] }} bridge={bridge(createTask)} onCreated={vi.fn(async () => {})} />);
    expect(screen.getByText(/项目选择已变化/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "固定基线并预览路径" })).toBeDisabled();
    expect(createTask.mock.calls.filter(([request]) => request.op === "prepare")).toHaveLength(0);
  });
});
