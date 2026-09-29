import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopArchivePage } from "../components/DesktopArchivePage";

const tasks = [{ taskId: "a", name: "任务 A", repoCount: 1 }, { taskId: "b", name: "任务 B", repoCount: 0 }];
const lifecycle = (taskId: string, archived: boolean) => ({ lifecycle: { taskId, archived, archivedAt: archived ? "2026-09-29T09:00:00Z" : null } });
function bridge(handler: (taskId: string, op: string) => unknown) {
  const taskOp = vi.fn(async (taskId: string, op: string) => handler(taskId, op));
  window.pidock = { taskOp: taskOp as never };
  return taskOp;
}
afterEach(() => { cleanup(); delete window.pidock; });

it("shows only archived Host tasks and restores through the human UI operation", async () => {
  let archived = true;
  const taskOp = bridge((taskId, op) => {
    if (op === "task/restore") { archived = false; return { ok: true, payload: lifecycle(taskId, false) }; }
    return { ok: true, payload: lifecycle(taskId, taskId === "a" && archived) };
  });
  const onRestored = vi.fn();
  render(<DesktopArchivePage tasks={tasks} onRestored={onRestored} />);
  expect(await screen.findByText("任务 A")).toBeInTheDocument();
  expect(screen.queryByText("任务 B")).toBeNull();
  expect(screen.getByRole("button", { name: "清理…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "清理…" })).toHaveAttribute("title", "清理的生产界面未接线");
  fireEvent.click(screen.getByRole("button", { name: "恢复" }));
  await waitFor(() => expect(onRestored).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.queryByText("任务 A")).toBeNull());
  expect(taskOp).toHaveBeenCalledWith("a", "task/restore", {});
});

it("keeps archived row on a refused restore", async () => {
  bridge((taskId, op) => op === "task/restore" ? { ok: false, error: "task-locked" } : { ok: true, payload: lifecycle(taskId, true) });
  render(<DesktopArchivePage tasks={[tasks[0]!]} onRestored={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "恢复" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("task-locked");
  expect(screen.getByText("任务 A")).toBeInTheDocument();
});

it("reports a partial read failure and rejects another task's lifecycle", async () => {
  bridge((taskId) => taskId === "a" ? { ok: false, error: "host-unavailable" } : { ok: true, payload: lifecycle("wrong-task", true) });
  render(<DesktopArchivePage tasks={tasks} onRestored={() => {}} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("任务 A：host-unavailable");
  expect(screen.getByRole("alert")).toHaveTextContent("任务 B：归档状态返回异常");
  expect(screen.getByText("成功读取的任务中没有归档项。")).toBeInTheDocument();
});

it("shows an honest empty state with no tasks and does not call Host", async () => {
  const taskOp = bridge(() => { throw new Error("unexpected call"); });
  render(<DesktopArchivePage tasks={[]} onRestored={() => {}} />);
  expect(await screen.findByText("还没有归档任务。")).toBeInTheDocument();
  expect(taskOp).not.toHaveBeenCalled();
});
