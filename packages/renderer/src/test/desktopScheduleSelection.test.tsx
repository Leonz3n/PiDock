import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopSchedulesPage } from "../components/DesktopSchedulesPage";
afterEach(() => {
  cleanup();
  delete window.pidock;
});
it("selects a rule and opens only its real task/session result", async () => {
  window.pidock = {
    taskOp: async (taskId: string, op: string) => ({
      ok: true,
      payload:
        op === "task/scheduleList"
          ? {
              schedules: [
                {
                  taskId,
                  scheduleId: "schedule-1",
                  name: `规则 ${taskId}`,
                  ruleText: "0 9 * * *",
                  timezone: "UTC",
                  enabled: true,
                  providerId: "private-fixture",
                  model: "loopback",
                  prompt: `提示 ${taskId}`,
                  permission: "read",
                },
              ],
            }
          : {
              runs: [
                {
                  taskId,
                  scheduleId: "schedule-1",
                  runId: taskId,
                  sessionId: `session-${taskId}`,
                  startedAt: "2026-11-04T09:00Z",
                  result: "completed",
                  actualModel: "loopback",
                },
              ],
            },
    }),
  } as never;
  const open = vi.fn();
  render(
    <DesktopSchedulesPage
      tasks={[
        { taskId: "a", name: "任务 A" },
        { taskId: "b", name: "任务 B" },
      ]}
      onOpenTask={() => {}}
      onOpenSession={open}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "选择规则 规则 b" }),
  );
  const detail = screen.getByRole("region", { name: "定时任务详情" });
  expect(detail).toHaveTextContent("提示 b");
  expect(detail).not.toHaveTextContent("提示 a");
  expect(
    within(
      document.querySelector('[data-schedule-run="b"]') as HTMLElement,
    ).getByText(/规则 b/),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "选择规则 规则 a" }));
  expect(
    within(
      document.querySelector('[data-schedule-run="a"]') as HTMLElement,
    ).getByText(/规则 a/),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "选择规则 规则 b" }));
  fireEvent.click(within(detail).getByRole("button", { name: "继续对话" }));
  expect(open).toHaveBeenCalledWith("b", "session-b");
});

it("keeps historical failures visible when their rule no longer exists", async () => {
  window.pidock = {
    taskOp: async (taskId: string, op: string) => ({
      ok: true,
      payload:
        op === "task/scheduleList"
          ? { schedules: [] }
          : {
              runs: [
                {
                  taskId,
                  scheduleId: "removed",
                  runId: "retained",
                  startedAt: "2026-11-04T09:00Z",
                  result: "failed",
                  failureCode: "credential-missing",
                  reason: "没有可用凭据",
                },
              ],
            },
    }),
  } as never;
  render(
    <DesktopSchedulesPage
      tasks={[{ taskId: "a", name: "任务 A" }]}
      onOpenTask={() => {}}
    />,
  );
  expect(await screen.findByText(/已删除的定时任务/)).toBeInTheDocument();
  expect(screen.getByText(/credential-missing/)).toHaveTextContent(
    "没有可用凭据",
  );
  expect(screen.queryByRole("button", { name: "继续对话" })).toBeNull();
});
