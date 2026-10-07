import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopAttentionPage } from "../components/DesktopAttentionPage";

const tasks = [{ taskId: "a", name: "任务 A", projectId: "project-a" }, { taskId: "b", name: "任务 B", projectId: null }];
const projects = [{ id: "project-a", name: "项目 A" }];
const item = (taskId: string, kind: string, read = false) => ({ id: `attention-${kind}-${taskId}`, kind, executionId: `run-${taskId}`, taskId, sessionId: "session-1", taskName: `任务 ${taskId}`, detail: "真实执行记录", at: "2026-09-29T09:00:00Z", read });
const bridge = (handler: (taskId: string, op: string, payload: Record<string, unknown>) => unknown) => {
  const taskOp = vi.fn(async (taskId: string, op: string, payload: Record<string, unknown>) => handler(taskId, op, payload));
  window.pidock = { taskOp: taskOp as never };
  return taskOp;
};
afterEach(() => { cleanup(); delete window.pidock; });

it("shows the Host main session identity and offers its supported conversation destination", async () => {
  bridge((taskId) => ({ ok: true, payload: { taskName: taskId, items: [{ ...item(taskId, "completed-unread"), sessionId: "main" }] } }));
  const onOpenTask = vi.fn();
  render(<DesktopAttentionPage tasks={[tasks[0]!]} projects={projects} lifecyclePending={false} lifecycleErrors={[]} onOpenTask={onOpenTask} />);
  expect(await screen.findByText("会话 · main")).toBeInTheDocument();
  expect(screen.getByText(/SDK main 回合的执行结果已接入/)).toBeInTheDocument();
  expect(screen.queryByText(/SDK main 回合尚未写入/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "查看 main 会话" }));
  expect(onOpenTask).toHaveBeenCalledWith("a");
  expect(screen.getByText("完成未读 · 1")).toBeInTheDocument();
});

it("groups real cross-project records while refusing to substitute main for legacy sessions", async () => {
  const taskOp = bridge((taskId) => ({ ok: true, payload: { taskName: taskId, items: [item(taskId, taskId === "a" ? "approval" : "failed")] } }));
  const onOpenTask = vi.fn();
  render(<DesktopAttentionPage tasks={tasks} projects={projects} lifecyclePending={false} lifecycleErrors={[]} onOpenTask={onOpenTask} />);
  expect(await screen.findByText("项目 A · 任务 A")).toBeInTheDocument();
  expect(screen.getByText("任务 B")).toBeInTheDocument();
  expect(screen.getByText("待处理 · 2")).toBeInTheDocument();
  expect(screen.getAllByText("会话 · session-1")).toHaveLength(2);
  const destinations = screen.getAllByRole("button", { name: "原会话定位未接线" });
  for (const destination of destinations) {
    expect(destination).toBeDisabled();
    fireEvent.click(destination);
  }
  expect(onOpenTask).not.toHaveBeenCalled();
  expect(taskOp).not.toHaveBeenCalledWith("a", "task/markAttentionRead", expect.anything());
});

it("clears only a completed-unread item after verified Host acknowledgement", async () => {
  let read = false;
  const taskOp = bridge((taskId, op, payload) => {
    if (op === "task/markAttentionRead") { read = true; return { ok: true, payload: { cleared: payload.itemIds, kept: [] } }; }
    return { ok: true, payload: { taskName: taskId, items: [item(taskId, "completed-unread", read), item(taskId, "failed")] } };
  });
  render(<DesktopAttentionPage tasks={[tasks[0]!]} projects={projects} lifecyclePending={false} lifecycleErrors={[]} onOpenTask={() => {}} />);
  expect(await screen.findByText("完成未读 · 1")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "标记已读" }));
  await waitFor(() => expect(screen.getByText("完成未读 · 0")).toBeInTheDocument());
  expect(screen.getByText("待处理 · 1")).toBeInTheDocument();
  expect(taskOp).toHaveBeenCalledWith("a", "task/markAttentionRead", { itemIds: ["attention-completed-unread-a"] });
});

it("keeps a completed item visible when Host refuses the read", async () => {
  bridge((taskId, op) => op === "task/markAttentionRead" ? { ok: false, error: "ledger-unavailable" } : { ok: true, payload: { taskName: taskId, items: [item(taskId, "completed-unread")] } });
  render(<DesktopAttentionPage tasks={[tasks[0]!]} projects={projects} lifecyclePending={false} lifecycleErrors={[]} onOpenTask={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "标记已读" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("ledger-unavailable");
  expect(screen.getByText("完成未读 · 1")).toBeInTheDocument();
});

it("shows failed task and lifecycle reads without inventing a global empty result", async () => {
  bridge((taskId) => taskId === "a" ? { ok: false, error: "host-unavailable" } : { ok: true, payload: { taskName: "b", items: [item("wrong-task", "failed")] } });
  render(<DesktopAttentionPage tasks={tasks} projects={projects} lifecyclePending={false} lifecycleErrors={["任务 C：归档状态未知"]} onOpenTask={() => {}} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("任务 A：host-unavailable");
  expect(screen.getByRole("alert")).toHaveTextContent("任务 B：关注列表返回异常");
  expect(screen.getByRole("alert")).toHaveTextContent("任务 C：归档状态未知");
  expect(screen.getByText("成功读取的任务中没有关注项。")).toBeInTheDocument();
});

it("waits for verified lifecycle before requesting Host attention", async () => {
  const taskOp = bridge(() => { throw new Error("unexpected call"); });
  render(<DesktopAttentionPage tasks={tasks} projects={projects} lifecyclePending lifecycleErrors={[]} onOpenTask={() => {}} />);
  expect(screen.getByRole("status")).toHaveTextContent("正在核验任务");
  expect(taskOp).not.toHaveBeenCalled();
});
