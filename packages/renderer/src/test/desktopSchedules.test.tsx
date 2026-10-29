import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopSchedulesPage } from "../components/DesktopSchedulesPage";

const tasks = [{ taskId: "a", name: "任务 A" }, { taskId: "b", name: "任务 B" }];
const schedule = (taskId: string, enabled: boolean) => ({ scheduleId: `schedule-${taskId}`, taskId, name: `计划 ${taskId}`, ruleText: "0 9 * * *", timezone: "Asia/Shanghai", providerId: "provider-x", model: "model-x", prompt: "整理报告", enabled });
const run = (taskId: string) => ({ runId: `run-${taskId}`, scheduleId: `schedule-${taskId}`, taskId, startedAt: "2026-09-29T09:00:00Z", result: "completed" });
const bridge = (handler: (taskId: string, op: string, payload: Record<string, unknown>) => unknown) => {
  const taskOp = vi.fn(async (taskId: string, op: string, payload: Record<string, unknown>) => handler(taskId, op, payload));
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

it("names a blank schedule field instead of an empty rule, name or table cell", async () => {
  // `parseSchedules`/`parseRuns` read every string with `text = typeof ===
  // "string"`, so a blank Host field really reaches this page; each fact names
  // its own absence instead of emptying a column or a row's own identity.
  bridge((taskId, op) => ({ ok: true, payload: { workspaceId: "local", taskId, op, payload: op === "task/scheduleList"
    ? { schedules: [{ ...schedule(taskId, true), name: "", ruleText: "", timezone: "", providerId: "", model: "" }], templates: [] }
    : { runs: [{ ...run(taskId), startedAt: "", reason: "" }] } } }));
  render(<DesktopSchedulesPage tasks={[tasks[0]!]} onOpenTask={() => {}} />);
  await screen.findByText("Host 未上报规则");
  const row = document.querySelector('[data-schedule-row="schedule-a"]') as HTMLElement;
  expect(row).toHaveTextContent("Host 未上报规则");
  expect(row).toHaveTextContent("Host 未上报时区");
  expect(row).toHaveTextContent("Host 未上报定时任务名称");
  expect(row).toHaveTextContent("Host 未上报 Provider / Host 未上报模型");
  const runRow = within(document.querySelector('[data-schedule-run="run-a"]') as HTMLElement);
  expect(runRow.getByText("Host 未上报开始时间")).toBeInTheDocument();
  // `??` used to miss a real `""`; the em dash is the named absence for this column.
  expect(runRow.getByText("—")).toBeInTheDocument();
  // The run table's 定时任务 cell names the same blank schedule name instead of
  // rendering a blank cell under a column header (the card above is not the only
  // render path of `parseSchedules.name`).
  expect(runRow.getByText("Host 未上报定时任务名称")).toBeInTheDocument();
  // ...and a run whose schedule really is gone keeps its own wording, so the two
  // cases stay distinguishable instead of collapsing into one string.
  expect(runRow.queryByText("已删除的定时任务")).toBeNull();
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

it("toggles a schedule through the Host and re-reads its answer instead of flipping the row", async () => {
  let paused = true;
  const taskOp = bridge((taskId, op) => {
    if (op === "task/scheduleSetEnabled") { paused = false; return { ok: true, payload: { schedule: schedule(taskId, true) } }; }
    return { ok: true, payload: op === "task/scheduleList" ? { schedules: [schedule(taskId, !paused)] } : { runs: [] } };
  });
  const listReads = () => taskOp.mock.calls.filter(([, op]) => op === "task/scheduleList").length;
  render(<DesktopSchedulesPage tasks={[tasks[0]!]} onOpenTask={() => {}} />);
  await waitFor(() => expect(document.querySelector('[data-schedule-row="schedule-a"')).not.toBeNull());
  const row = () => document.querySelector('[data-schedule-row="schedule-a"]') as HTMLElement;
  expect(within(row()).getByText("已暂停")).toBeInTheDocument();
  expect(listReads()).toBe(1);
  fireEvent.click(within(row()).getByRole("button", { name: "启用 计划 a" }));
  await waitFor(() => expect(within(row()).getByText("已启用")).toBeInTheDocument());
  expect(taskOp).toHaveBeenCalledWith("a", "task/scheduleSetEnabled", { scheduleId: "schedule-a", enabled: true });
  // The badge comes from the Host's next list answer, not from the click: the row
  // is re-read after the Host accepts, so no optimistic flip can outlive a refusal.
  expect(listReads()).toBe(2);
});

it("keeps the previous state and quotes the Host refusal when a pause is refused", async () => {
  const taskOp = bridge((taskId, op) => op === "task/scheduleSetEnabled"
    ? { ok: false, error: "unknown-schedule: 定时任务 schedule-a 不存在" }
    : { ok: true, payload: op === "task/scheduleList" ? { schedules: [schedule(taskId, true)] } : { runs: [] } });
  render(<DesktopSchedulesPage tasks={[tasks[0]!]} onOpenTask={() => {}} />);
  await waitFor(() => expect(document.querySelector('[data-schedule-row="schedule-a"')).not.toBeNull());
  const row = () => document.querySelector('[data-schedule-row="schedule-a"]') as HTMLElement;
  fireEvent.click(within(row()).getByRole("button", { name: "暂停 计划 a" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("计划 a：unknown-schedule: 定时任务 schedule-a 不存在");
  // A refusal is not a new answer about the list: no re-read, no flipped badge.
  expect(taskOp.mock.calls.filter(([, op]) => op === "task/scheduleList")).toHaveLength(1);
  expect(within(row()).getByText("已启用")).toBeInTheDocument();
});

it("runs a schedule now through the Host, then shows the run the Host recorded", async () => {
  let runs: unknown[] = [];
  const taskOp = bridge((taskId, op, payload) => {
    if (op === "task/scheduleRunNow") {
      expect(payload).toEqual({ scheduleId: "schedule-a", label: "定时任务页" });
      runs = [{ runId: "run-manual", scheduleId: "schedule-a", taskId, startedAt: "2026-10-27T09:00:00Z", result: "awaiting-approval" }];
      return { ok: true, payload: { run: runs[0] } };
    }
    return { ok: true, payload: op === "task/scheduleList" ? { schedules: [schedule(taskId, true)] } : { runs } };
  });
  render(<DesktopSchedulesPage tasks={[tasks[0]!]} onOpenTask={() => {}} />);
  await waitFor(() => expect(document.querySelector('[data-schedule-row="schedule-a"')).not.toBeNull());
  expect(screen.getByText("暂无执行记录。")).toBeInTheDocument();
  fireEvent.click(within(document.querySelector('[data-schedule-row="schedule-a"]') as HTMLElement).getByRole("button", { name: "立即运行 计划 a" }));
  await waitFor(() => expect(document.querySelector('[data-schedule-run="run-manual"]')).not.toBeNull());
  expect(within(document.querySelector('[data-schedule-run="run-manual"]') as HTMLElement).getByText("待确认")).toBeInTheDocument();
  expect(screen.queryByText("暂无执行记录。")).toBeNull();
  expect(taskOp).toHaveBeenCalledWith("a", "task/scheduleRunNow", { scheduleId: "schedule-a", label: "定时任务页" });
});

it("shows the Host refusal when 立即运行 is refused and never claims a run", async () => {
  const taskOp = bridge((taskId, op) => op === "task/scheduleRunNow"
    ? { ok: false, error: "archived: 已归档任务不能通过「立即运行」绕过恢复" }
    : { ok: true, payload: op === "task/scheduleList" ? { schedules: [schedule(taskId, true)] } : { runs: [] } });
  render(<DesktopSchedulesPage tasks={[tasks[0]!]} onOpenTask={() => {}} />);
  await waitFor(() => expect(document.querySelector('[data-schedule-row="schedule-a"')).not.toBeNull());
  fireEvent.click(within(document.querySelector('[data-schedule-row="schedule-a"]') as HTMLElement).getByRole("button", { name: "立即运行 计划 a" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("计划 a：archived: 已归档任务不能通过「立即运行」绕过恢复");
  expect(document.querySelector('[data-schedule-run]')).toBeNull();
  expect(screen.getByText("暂无执行记录。")).toBeInTheDocument();
  // Nothing was minted, so there is nothing new to read.
  expect(taskOp.mock.calls.filter(([, op]) => op === "task/scheduleRuns")).toHaveLength(1);
});
