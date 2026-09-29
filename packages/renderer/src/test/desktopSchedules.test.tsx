import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopSchedulesPage } from "../components/DesktopSchedulesPage";

const tasks = [{ taskId: "a", name: "任务 A" }, { taskId: "b", name: "任务 B" }];
const schedule = (taskId: string, enabled: boolean) => ({ scheduleId: `schedule-${taskId}`, taskId, name: `计划 ${taskId}`, ruleText: "0 9 * * *", timezone: "Asia/Shanghai", providerId: "provider-x", model: "model-x", prompt: "整理报告", enabled });
const run = (taskId: string) => ({ runId: `run-${taskId}`, scheduleId: `schedule-${taskId}`, taskId, startedAt: "2026-09-29T09:00:00Z", result: "completed" });
const bridge = (handler: (taskId: string, op: string) => unknown) => {
  const taskOp = vi.fn(async (taskId: string, op: string) => handler(taskId, op));
  window.pidock = { taskOp: taskOp as never };
  return taskOp;
};
afterEach(() => { cleanup(); delete window.pidock; });

it("lists Host schedules and runs across tasks with working filters and task navigation", async () => {
  const taskOp = bridge((taskId, op) => ({ ok: true, payload: { workspaceId: "local", taskId, op, payload: op === "task/scheduleList"
    ? { schedules: [schedule(taskId, taskId === "a")], templates: [] } : { runs: [run(taskId)] } } }));
  const onOpenTask = vi.fn();
  render(<DesktopSchedulesPage tasks={tasks} onOpenTask={onOpenTask} />);
  await waitFor(() => expect(screen.getAllByText("0 9 * * *")).toHaveLength(2));
  expect(within(document.querySelector('[data-schedule-row="schedule-a"]')!).getByText("计划 a")).toBeInTheDocument();
  expect(screen.getAllByText("已完成").length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "已暂停" }));
  expect(document.querySelector('[data-schedule-row="schedule-a"]')).toBeNull();
  expect(within(document.querySelector('[data-schedule-row="schedule-b"]')!).getByText("计划 b")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "查看任务" }));
  expect(onOpenTask).toHaveBeenCalledWith("b");
  expect(taskOp).toHaveBeenCalledWith("b", "task/scheduleRuns", {});
});

it("shows partial failure without presenting a global empty result", async () => {
  bridge((taskId, op) => taskId === "a" ? { ok: false, error: "host-unavailable" } : { ok: true, payload: op === "task/scheduleList" ? { schedules: [schedule(taskId, true)] } : { runs: [] } });
  render(<DesktopSchedulesPage tasks={tasks} onOpenTask={() => {}} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("任务 A：host-unavailable");
  expect(screen.getByText("计划 b")).toBeInTheDocument();
  expect(screen.getByText("已启用（部分）")).toBeInTheDocument();
});

it("retains schedules when only the execution history fails", async () => {
  bridge((taskId, op) => op === "task/scheduleList" ? { ok: true, payload: { schedules: [schedule(taskId, true)] } } : { ok: false, error: "history-unavailable" });
  render(<DesktopSchedulesPage tasks={[tasks[0]!]} onOpenTask={() => {}} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("任务 A：执行记录 history-unavailable");
  expect(screen.getByText("计划 a")).toBeInTheDocument();
  expect(screen.getByText("成功读取的任务中没有执行记录。")).toBeInTheDocument();
});

it("rejects malformed records and exposes a retry", async () => {
  let valid = false;
  const taskOp = bridge((taskId, op) => ({ ok: true, payload: op === "task/scheduleList" ? { schedules: valid ? [] : [{ ...schedule(taskId, true), taskId: "other-task" }] } : { runs: [] } }));
  render(<DesktopSchedulesPage tasks={[tasks[0]!]} onOpenTask={() => {}} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("定时配置返回异常");
  valid = true;
  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getByText("当前筛选下没有定时任务。")).toBeInTheDocument();
  expect(taskOp).toHaveBeenCalledTimes(3);
});

it("does not invent records when no task exists", async () => {
  const taskOp = bridge(() => { throw new Error("unexpected Host call"); });
  render(<DesktopSchedulesPage tasks={[]} onOpenTask={() => {}} />);
  expect(await screen.findByText("当前筛选下没有定时任务。")).toBeInTheDocument();
  expect(taskOp).not.toHaveBeenCalled();
});
