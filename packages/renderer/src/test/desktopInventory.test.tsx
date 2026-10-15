import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopInventory } from "../components/DesktopInventory";
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

function makeBridge(createTask?: NonNullable<PidockBridge["createTask"]>): PidockBridge {
  return {
    listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })),
    projectOp: vi.fn(async (request: { op: string }) => request.op === "list"
      ? { ok: true, payload: { initialized: true, projects: [] } }
      : { ok: true, payload: { roots, tasks: tasks.map((task) => ({ taskId: task.taskId, projectId: null, state: "unassigned" })) } }),
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

    // Wait for the labelled card itself, so the card list cannot be mid-load.
    const label = await screen.findByText(/创建未完成/);
    const card = label.closest("[data-overview-task]")!;
    expect(card).toHaveAttribute("data-overview-task", taskId);
    expect(card).toHaveTextContent("到「项目管理」恢复完成或放弃");
    const otherCard = (await screen.findByText("普通任务", { selector: "h3" })).closest("[data-overview-task]")!;
    expect(otherCard).not.toHaveTextContent("创建未完成");
  });
  it("leaves every overview card unlabelled when there is no real pending creation", async () => {
    const createTask = vi.fn(async () => ({ ok: true, payload: null }));
    window.pidock = makeBridge(createTask);
    render(<DesktopInventory />);
    await screen.findByTestId("desktop-project-overview");

    await screen.findByText("普通任务", { selector: "h3" });
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
});
