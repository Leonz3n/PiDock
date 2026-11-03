import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopInventory } from "../components/DesktopInventory";
import { CREATION_RETENTION_NOTICE } from "../data/desktopCreation";
import type { PidockBridge } from "../data/shellBridge";

const taskId = "interrupted-task";
const tasks = [
  { taskId, name: "中断任务", branch: "task/interrupted", repoCount: 1, updatedAt: "2026-10-20" },
  { taskId: "ordinary-task", name: "普通任务", branch: "task/ordinary", repoCount: 0, updatedAt: "2026-10-20" },
];
const roots = [{ label: "默认任务根", state: "ready" as const }];
const intent = {
  id: "creation-intent-1", taskId, name: "中断任务", projectId: "project-1",
  taskDir: "/tasks/interrupted-task", root: "/tasks", branch: "task/interrupted", state: "pending" as const,
  repos: [], directories: [],
};
const retainedMessage = "本次创建已放弃。已产生的任务目录、工作区、链接与会话均已保留。";
const PROJECT_ID = "project-1";
/** One real workspace: the pending creation belongs to it, so S07 has a task ledger. */
const project = { id: PROJECT_ID, name: "默认工作空间", description: "", repositories: [], directories: [],
  environment: [], branchTemplate: "feature/{task-name}" };

function makeBridge(createTask?: NonNullable<PidockBridge["createTask"]>): PidockBridge {
  return {
    listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })),
    projectOp: vi.fn(async (request: { op: string }) => request.op === "list"
      ? { ok: true, payload: { initialized: true, projects: [project] } }
      : { ok: true, payload: { roots, tasks: tasks.map((task) => ({ taskId: task.taskId, projectId: PROJECT_ID, state: "assigned" })) } }),
    taskOp: vi.fn(async (id: string) => ({ ok: true, payload: { lifecycle: { taskId: id, archived: false, archivedAt: null } } })),
    ...(createTask ? { createTask } : {}),
  } as PidockBridge;
}

async function openTaskManagement(bridge: PidockBridge) {
  window.pidock = bridge;
  render(<DesktopInventory />);
  await screen.findByTestId("desktop-project-overview");
  fireEvent.click(screen.getByRole("button", { name: "项目管理" }));
  return await screen.findByText("中断任务", { selector: "strong" });
}

afterEach(() => {
  cleanup();
  delete window.pidock;
  vi.restoreAllMocks();
});

describe("Desktop inventory pending creation recovery", () => {
  it("marks only the matching task as creation incomplete and offers both recovery exits on its row", async () => {
    const createTask = vi.fn(async (request: { op: string }) => ({ ok: true, payload: request.op === "current" ? intent : null }));
    const bridge = makeBridge(createTask);
    await openTaskManagement(bridge);

    const row = screen.getByText("中断任务", { selector: "strong" }).closest("li")!;
    expect(within(row).getByText("创建未完成")).toBeInTheDocument();
    expect(within(row).getByText(/恢复完成；也可以放弃/)).toBeInTheDocument();
    expect(within(row).getByText(`这项任务的创建尚未完成。你可以恢复完成；也可以放弃（${CREATION_RETENTION_NOTICE}）。`)).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "恢复完成" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "放弃创建" })).toBeInTheDocument();
    expect(within(screen.getByText("普通任务", { selector: "strong" }).closest("li")!).queryByText("创建未完成")).not.toBeInTheDocument();
  });

  it("does not label any task when the real current-creation read returns null", async () => {
    const createTask = vi.fn(async () => ({ ok: true, payload: null }));
    await openTaskManagement(makeBridge(createTask));

    for (const name of ["中断任务", "普通任务"]) {
      const row = screen.getByText(name, { selector: "strong" }).closest("li")!;
      expect(within(row).queryByText("创建未完成")).not.toBeInTheDocument();
      expect(within(row).queryByRole("button", { name: "恢复完成" })).not.toBeInTheDocument();
      expect(within(row).queryByRole("button", { name: "放弃创建" })).not.toBeInTheDocument();
    }
  });

  it("labels the unfinished creation on the project overview card and points at the management page", async () => {
    const createTask = vi.fn(async (request: { op: string }) => ({ ok: true, payload: request.op === "current" ? intent : null }));
    window.pidock = makeBridge(createTask);
    render(<DesktopInventory />);
    await screen.findByTestId("desktop-project-overview");

    // Wait for the labelled ledger row itself, so the table cannot be mid-load.
    const label = await screen.findByText("创建未完成");
    const row = label.closest("li")!;
    expect(within(row).getByText("中断任务")).toBeInTheDocument();
    const otherRow = (await screen.findByText("普通任务", { selector: "strong" })).closest("li")!;
    expect(within(otherRow).queryByText("创建未完成")).not.toBeInTheDocument();
  });
  it("leaves every overview card unlabelled when there is no real pending creation", async () => {
    const createTask = vi.fn(async () => ({ ok: true, payload: null }));
    window.pidock = makeBridge(createTask);
    render(<DesktopInventory />);
    await screen.findByTestId("desktop-project-overview");

    await screen.findByText("普通任务", { selector: "strong" });
    expect(screen.queryByText(/创建未完成/)).not.toBeInTheDocument();
  });
  it("does not label a task when its real current-creation intent is already complete", async () => {
    const createTask = vi.fn(async () => ({ ok: true, payload: { ...intent, state: "complete" } }));
    await openTaskManagement(makeBridge(createTask));

    const row = screen.getByText("中断任务", { selector: "strong" }).closest("li")!;
    expect(within(row).queryByText("创建未完成")).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "恢复完成" })).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "放弃创建" })).not.toBeInTheDocument();
  });

  it("abandons from the task row, shows main's retained-files explanation, and refreshes the list", async () => {
    let current: unknown = intent;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const createTask = vi.fn(async (request: { op: string }) => {
      if (request.op === "current") return { ok: true, payload: current };
      if (request.op === "abandon") {
        current = null;
        return { ok: true, payload: { abandoned: true, message: retainedMessage } };
      }
      return { ok: true, payload: null };
    });
    const bridge = makeBridge(createTask);
    await openTaskManagement(bridge);

    const row = screen.getByText("中断任务", { selector: "strong" }).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "放弃创建" }));

    expect(await screen.findByText(retainedMessage)).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledOnce();
    expect(createTask).toHaveBeenCalledWith({ op: "abandon", id: intent.id, confirmed: true });
    await waitFor(() => expect(bridge.listTasks).toHaveBeenCalledTimes(2));
    const refreshedRow = screen.getByText("中断任务", { selector: "strong" }).closest("li")!;
    expect(within(refreshedRow).getByRole("status")).toHaveTextContent(retainedMessage);
    expect(within(refreshedRow).queryByText("创建未完成")).not.toBeInTheDocument();
  });

  it("keeps main's retained-files explanation visible if the post-abandon inventory refresh fails", async () => {
    let current: unknown = intent;
    let reads = 0;
    const createTask = vi.fn(async (request: { op: string }) => {
      if (request.op === "current") return { ok: true, payload: current };
      if (request.op === "abandon") {
        current = null;
        return { ok: true, payload: { abandoned: true, message: retainedMessage } };
      }
      return { ok: true, payload: null };
    });
    const listTasks = vi.fn(async () => reads++ === 0
      ? { ok: true, payload: { tasks, roots } }
      : { ok: false, error: "inventory refresh unavailable" });
    const bridge = { ...makeBridge(createTask), listTasks } as PidockBridge;
    await openTaskManagement(bridge);
    const row = screen.getByText("中断任务", { selector: "strong" }).closest("li")!;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(within(row).getByRole("button", { name: "放弃创建" }));

    expect(await screen.findByRole("status")).toHaveTextContent(retainedMessage);
    expect(screen.getByText("inventory refresh unavailable")).toBeInTheDocument();
  });

  it("restores completion from the task row and refreshes the list", async () => {
    let current: unknown = intent;
    const createTask = vi.fn(async (request: { op: string }) => {
      if (request.op === "current") return { ok: true, payload: current };
      if (request.op === "commit") {
        current = { ...intent, state: "complete" };
        return { ok: true, payload: { taskId } };
      }
      return { ok: true, payload: null };
    });
    const bridge = makeBridge(createTask);
    await openTaskManagement(bridge);

    const row = screen.getByText("中断任务", { selector: "strong" }).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "恢复完成" }));

    expect(createTask).toHaveBeenCalledWith({ op: "commit", id: intent.id });
    await waitFor(() => expect(bridge.listTasks).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const refreshedRow = screen.getByText("中断任务", { selector: "strong" }).closest("li")!;
      expect(within(refreshedRow).queryByText("创建未完成")).not.toBeInTheDocument();
      expect(within(refreshedRow).queryByRole("button", { name: "恢复完成" })).not.toBeInTheDocument();
    });
  });

  it("does not show a pending-creation marker when the desktop bridge has no createTask operation", async () => {
    const bridge = makeBridge();
    await openTaskManagement(bridge);

    const row = screen.getByText("中断任务", { selector: "strong" }).closest("li")!;
    expect(within(row).queryByText("创建未完成")).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "恢复完成" })).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "放弃创建" })).not.toBeInTheDocument();
  });

  it("does not label a task when reading the current creation intent fails", async () => {
    const createTask = vi.fn(async () => ({ ok: false, error: "creation status unavailable" }));
    await openTaskManagement(makeBridge(createTask));

    const row = screen.getByText("中断任务", { selector: "strong" }).closest("li")!;
    expect(within(row).queryByText("创建未完成")).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "恢复完成" })).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "放弃创建" })).not.toBeInTheDocument();
  });

  it("lands on the new task's workspace facts after a successful creation", async () => {
    const createdTaskId = "task-created01";
    const sourceProject = { id: PROJECT_ID, name: "默认工作空间", description: "",
      repositories: [{ id: "source-1", name: "Web", path: "/local/web" }], directories: [],
      environment: [], branchTemplate: "feature/{task-name}" };
    const created = { id: "creation-intent-2", taskId: createdTaskId, name: "Web work", projectId: PROJECT_ID,
      taskDir: `/tasks/${createdTaskId}`, root: "/tasks", branch: `task/${createdTaskId}`, state: "pending" as const,
      workspaceMode: "existing-git" as const,
      repos: [{ id: "source-1", name: "Web", remote: "origin", remoteBranch: "main", commit: "a".repeat(40), repoDir: "repo-web", path: "/local/web" }],
      directories: [] };
    const createdTasks = [...tasks, { taskId: createdTaskId, name: "Web work", branch: `task/${createdTaskId}`, repoCount: 0, updatedAt: "2026-10-21" }];
    const createTask = vi.fn(async (request: { op: string }) => {
      if (request.op === "current") return { ok: true, payload: null };
      if (request.op === "prepare") return { ok: true, payload: { canceled: false, intent: created } };
      return { ok: true, payload: { taskId: createdTaskId, projectId: PROJECT_ID } };
    });
    const bridge = {
      listTasks: vi.fn(async () => ({ ok: true, payload: { tasks: createdTasks, roots } })),
      projectOp: vi.fn(async (request: { op: string }) => request.op === "list"
        ? { ok: true, payload: { initialized: true, projects: [sourceProject] } }
        : { ok: true, payload: { roots, tasks: createdTasks.map((task) => ({ taskId: task.taskId, projectId: PROJECT_ID, state: "assigned" })) } }),
      taskOp: vi.fn(async (id: string, op: string) => op === "task/fileRoots"
        ? { ok: true, payload: { taskDir: `/tasks/${id}`, workspaceMode: "existing-git", roots: [{
            id: "repo-web", kind: "existing-git", label: "web", path: "/local/web", baselineBranch: "main", sharedOriginal: true,
            workingBranch: { state: "observed", value: "main" }, headCommit: { state: "observed", value: "a".repeat(40) },
            verification: { state: "ready", reason: "已核验：来源身份与记录一致" } }] } }
        : { ok: true, payload: { lifecycle: { taskId: id, archived: false, archivedAt: null } } }),
      createTask,
    } as PidockBridge;
    window.pidock = bridge;
    render(<DesktopInventory />);
    await screen.findByTestId("desktop-project-overview");
    fireEvent.click(screen.getByRole("button", { name: "项目管理" }));
    fireEvent.click(await screen.findByRole("button", { name: "任务" }));
    fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "Web work" } });
    fireEvent.click(screen.getByRole("radio", { name: "已有 Git 目录" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Web" }));
    fireEvent.change(screen.getByLabelText("远程名称"), { target: { value: "origin" } });
    fireEvent.click(screen.getByRole("button", { name: "读取原检出并预览" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认创建 / 恢复" }));
    // The task view (facts + conversation) replaces the project management page.
    expect(await screen.findByTestId("desktop-task-facts")).toBeInTheDocument();
    // The mode badge only exists once the Host facts read resolved: await it,
    // never assert it synchronously (the section renders while loading).
    expect(await screen.findByTestId("task-facts-mode")).toHaveTextContent("已有 Git 目录 · 共享原检出");
    expect(screen.queryByTestId("desktop-inventory")).not.toBeInTheDocument();
  });
});
