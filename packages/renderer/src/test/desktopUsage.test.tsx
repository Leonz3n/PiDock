import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopUsagePage } from "../components/DesktopUsagePage";

const tasks = [{ taskId: "task-1", name: "对账单详情" }, { taskId: "task-2", name: "结账页无障碍" }];
const message = (role: "user" | "assistant", usage: null | { input: number; output: number; cacheRead: number; cacheWrite: number }) => ({ role, text: `${role} 文本`, usage });

function bridge(snapshots: Record<string, unknown>) {
  const calls: unknown[] = [];
  const sdkTurn = vi.fn(async (request: { action: string; taskId: string }) => {
    calls.push(request);
    if (request.action === "unsubscribe") return { ok: true, payload: { unsubscribed: true } };
    const snapshot = snapshots[request.taskId];
    if (snapshot === undefined) return { ok: false, error: "sdk-session-unavailable" };
    return { ok: true, payload: { snapshot, turn: null } };
  });
  (window as unknown as { pidock?: unknown }).pidock = { sdkTurn };
  return { calls, sdkTurn };
}

afterEach(() => { cleanup(); delete (window as { pidock?: unknown }).pidock; });

it("totals the real SDK JSONL usage of the selected task", async () => {
  bridge({ "task-1": { source: "sdk-jsonl", sessionId: "main", pending: false, interrupted: false, messages: [message("user", null), message("assistant", { input: 24800, output: 421, cacheRead: 12, cacheWrite: 3 })] } });
  render(<DesktopUsagePage tasks={tasks} taskId="task-1" onSelectTask={() => {}} />);
  expect(await screen.findByTestId("usage-summary")).toHaveTextContent("2 条已确认消息 · 1 个助手回合");
  const total = (label: string) => document.querySelector(`[data-usage-total="${label}"]`)?.textContent ?? "";
  expect(total("输入 tokens")).toContain("24,800");
  expect(total("输出 tokens")).toContain("421");
  expect(total("缓存读取")).toContain("12");
  expect(total("缓存写入")).toContain("3");
});

it("switches task, unsubscribes the previous session and shows the new real numbers", async () => {
  const { calls } = bridge({
    "task-1": { source: "sdk-jsonl", sessionId: "main", pending: false, interrupted: false, messages: [message("assistant", { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 })] },
    "task-2": { source: "sdk-jsonl", sessionId: "main", pending: false, interrupted: false, messages: [message("assistant", { input: 20, output: 2, cacheRead: 0, cacheWrite: 0 })] },
  });
  const view = render(<DesktopUsagePage tasks={tasks} taskId="task-1" onSelectTask={() => {}} />);
  await screen.findByTestId("usage-summary");
  view.rerender(<DesktopUsagePage tasks={tasks} taskId="task-2" onSelectTask={() => {}} />);
  await waitFor(() => expect(document.querySelector('[data-usage-total="输入 tokens"]')?.textContent ?? "").toContain("20"));
  expect(calls).toContainEqual({ action: "unsubscribe", taskId: "task-1", sessionId: "main" });
});

it("reports a failed read instead of an empty table", async () => {
  bridge({});
  render(<DesktopUsagePage tasks={tasks} taskId="task-1" onSelectTask={() => {}} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("sdk-session-unavailable");
  expect(screen.queryByTestId("usage-summary")).toBeNull();
});

it("refuses a malformed snapshot rather than inventing totals", async () => {
  bridge({ "task-1": { source: "sdk-jsonl", sessionId: "main", pending: false, interrupted: false, messages: [{ role: "assistant", text: "x", usage: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } }] } });
  render(<DesktopUsagePage tasks={tasks} taskId="task-1" onSelectTask={() => {}} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("SDK 消息返回异常");
  expect(screen.queryByTestId("usage-summary")).toBeNull();
  expect((window as unknown as { pidock: { sdkTurn: ReturnType<typeof vi.fn> } }).pidock.sdkTurn).toHaveBeenCalledWith({ action: "unsubscribe", taskId: "task-1", sessionId: "main" });
});

it("asks for a task instead of showing a zero total, and keeps unwired dimensions explicit", async () => {
  bridge({});
  render(<DesktopUsagePage tasks={tasks} taskId={null} onSelectTask={() => {}} />);
  expect(screen.getByTestId("usage-needs-task")).toBeInTheDocument();
  expect(screen.queryByTestId("usage-summary")).toBeNull();
  expect(screen.getByText("按 Provider / 模型 / 类型 / 日期分组")).toBeInTheDocument();
  expect(screen.getAllByText("未接线").length).toBeGreaterThan(0);
});

it("releases a subscription whose response arrives after unmount", async () => {
  let resolve!: (value: unknown) => void;
  const sdkTurn = vi.fn((request: { action: string }) => request.action === "unsubscribe"
    ? Promise.resolve({ ok: true })
    : new Promise((done) => { resolve = done; }));
  (window as unknown as { pidock?: unknown }).pidock = { sdkTurn };
  const view = render(<DesktopUsagePage tasks={tasks} taskId="task-1" onSelectTask={() => {}} />);
  await waitFor(() => expect(sdkTurn).toHaveBeenCalledTimes(1));
  view.unmount();
  resolve({ ok: true, payload: { snapshot: { source: "sdk-jsonl", sessionId: "main", pending: false, interrupted: false, messages: [] } } });
  await waitFor(() => expect(sdkTurn).toHaveBeenCalledWith({ action: "unsubscribe", taskId: "task-1", sessionId: "main" }));
});

it("labels the projection cap and never calls its sum a lifetime total", async () => {
  bridge({ "task-1": { source: "sdk-jsonl", sessionId: "main", pending: false, interrupted: false, messages: Array.from({ length: 80 }, () => message("assistant", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })) } });
  render(<DesktopUsagePage tasks={tasks} taskId="task-1" onSelectTask={() => {}} />);
  expect(await screen.findByTestId("usage-summary")).toHaveTextContent("已达投影上限，较早用量未计入");
  expect(screen.getByText(/不是会话累计/)).toBeInTheDocument();
});

it("offers the real task list and reports it back", async () => {
  bridge({});
  const onSelectTask = vi.fn();
  render(<DesktopUsagePage tasks={tasks} taskId={null} onSelectTask={onSelectTask} />);
  fireEvent.click(screen.getByRole("button", { name: "结账页无障碍" }));
  expect(onSelectTask).toHaveBeenCalledWith("task-2");
});
