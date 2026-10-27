import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopUsagePage } from "../components/DesktopUsagePage";

const tasks = [{ taskId: "task-1", name: "对账单详情" }, { taskId: "task-2", name: "结账页无障碍" }];
const message = (role: "user" | "assistant", usage: null | { input: number; output: number; cacheRead: number; cacheWrite: number }) => ({ role, text: `${role} 文本`, usage });

/**
 * The Host's task ops the ledger section uses: `task/usageRecords` answers
 * `{report:{details}}`, `task/clearUsage` answers `{removed, remaining,
 * description}`. `after` is the detail count the re-read sees, so a test can
 * pin that the visible number comes from the Host's *new* answer.
 */
type LedgerStub = {
  count: number;
  after?: number;
  clear?: { removed: number; remaining: number; description: string };
  clearError?: string;
  rereadError?: string;
};

function bridge(snapshots: Record<string, unknown>, ledger: LedgerStub = { count: 2 }) {
  const calls: unknown[] = [];
  const ops: { taskId: string; op: string; payload: Record<string, unknown> }[] = [];
  const sdkTurn = vi.fn(async (request: { action: string; taskId: string }) => {
    calls.push(request);
    if (request.action === "unsubscribe") return { ok: true, payload: { unsubscribed: true } };
    const snapshot = snapshots[request.taskId];
    if (snapshot === undefined) return { ok: false, error: "sdk-session-unavailable" };
    return { ok: true, payload: { snapshot, turn: null } };
  });
  let ledgerReads = 0;
  const taskOp = vi.fn(async (taskId: string, op: string, payload: Record<string, unknown>) => {
    ops.push({ taskId, op, payload });
    if (op === "task/usageRecords") {
      const first = ledgerReads === 0;
      ledgerReads += 1;
      if (!first && ledger.rereadError !== undefined) return { ok: false, error: ledger.rereadError };
      const count = first ? ledger.count : ledger.after ?? ledger.count;
      return { ok: true, payload: { report: { details: Array.from({ length: count }, (_, index) => ({ id: `${taskId}-${index}` })) } } };
    }
    if (op === "task/clearUsage") {
      if (ledger.clearError !== undefined) return { ok: false, error: ledger.clearError };
      return { ok: true, payload: ledger.clear ?? { removed: ledger.count, remaining: ledger.after ?? 0, description: "清理全部用量明细" } };
    }
    return { ok: false, error: `unexpected-op:${op}` };
  });
  (window as unknown as { pidock?: unknown }).pidock = { sdkTurn, taskOp };
  return { calls, sdkTurn, ops, taskOp };
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

it("labels the task usage ledger as a different store from the SDK projection", async () => {
  bridge({}, { count: 4 });
  render(<DesktopUsagePage tasks={tasks} taskId="task-1" onSelectTask={() => {}} />);
  expect(await screen.findByText("Host 用量账本当前 4 条")).toBeInTheDocument();
  expect(screen.getByTestId("usage-ledger-scope")).toHaveTextContent("本任务");
  expect(screen.getByTestId("usage-ledger-note")).toHaveTextContent("与上方 SDK JSONL 投影不是同一份存储");
});

it("requires a confirmation that names the task ledger scope and makes no call on cancel", async () => {
  const { ops } = bridge({}, { count: 3 });
  render(<DesktopUsagePage tasks={tasks} taskId="task-1" onSelectTask={() => {}} />);
  await screen.findByText("Host 用量账本当前 3 条");
  fireEvent.click(screen.getByRole("button", { name: "清理本任务账本全部" }));
  const confirmation = screen.getByTestId("usage-cleanup-confirm");
  expect(confirmation).toHaveTextContent("清理本任务（对账单详情）的用量账本：本任务账本全部");
  expect(confirmation).toHaveTextContent("不删除会话记录");
  expect(confirmation).not.toHaveTextContent("全机器");
  fireEvent.click(screen.getByRole("button", { name: "取消清理" }));
  expect(ops.filter((entry) => entry.op === "task/clearUsage")).toHaveLength(0);
  expect(screen.queryByTestId("usage-cleanup-confirm")).toBeNull();
});

it("clears the task ledger with the confirmed scope and shows the Host's removed/remaining", async () => {
  const { ops } = bridge({}, { count: 3, after: 0, clear: { removed: 3, remaining: 0, description: "清理全部用量明细" } });
  render(<DesktopUsagePage tasks={tasks} taskId="task-1" onSelectTask={() => {}} />);
  await screen.findByText("Host 用量账本当前 3 条");
  fireEvent.click(screen.getByRole("button", { name: "清理本任务账本全部" }));
  fireEvent.click(screen.getByRole("button", { name: "确认清理" }));
  expect(await screen.findByTestId("usage-cleanup-note")).toHaveTextContent("本任务账本全部：移除 3 条，剩余 0 条。");
  const clears = ops.filter((entry) => entry.op === "task/clearUsage");
  expect(clears).toHaveLength(1);
  expect(clears[0]?.taskId).toBe("task-1");
  expect(clears[0]?.payload).toEqual({ scope: { kind: "all" } });
});

it("passes the session scope the confirmation named", async () => {
  const { ops } = bridge({}, { count: 1, after: 0, clear: { removed: 1, remaining: 0, description: "仅清理会话 main 的用量明细（不影响其他会话）" } });
  render(<DesktopUsagePage tasks={tasks} taskId="task-1" onSelectTask={() => {}} />);
  await screen.findByText("Host 用量账本当前 1 条");
  fireEvent.click(screen.getByRole("button", { name: "清理本任务账本中该会话的用量" }));
  expect(screen.getByTestId("usage-cleanup-confirm")).toHaveTextContent("本任务账本中会话 main 的条目");
  fireEvent.click(screen.getByRole("button", { name: "确认清理" }));
  await screen.findByTestId("usage-cleanup-note");
  expect(ops.filter((entry) => entry.op === "task/clearUsage")[0]?.payload).toEqual({ scope: { kind: "session", sessionId: "main" } });
});

it("re-reads the task ledger after clearing so the visible count is the Host's new one", async () => {
  bridge({}, { count: 5, after: 2, clear: { removed: 3, remaining: 2, description: "清理全部用量明细" } });
  render(<DesktopUsagePage tasks={tasks} taskId="task-1" onSelectTask={() => {}} />);
  await screen.findByText("Host 用量账本当前 5 条");
  fireEvent.click(screen.getByRole("button", { name: "清理本任务账本全部" }));
  fireEvent.click(screen.getByRole("button", { name: "确认清理" }));
  expect(await screen.findByText("Host 用量账本当前 2 条")).toBeInTheDocument();
  expect(screen.queryByText("Host 用量账本当前 5 条")).toBeNull();
});

it("keeps a failed clear as the Host's named error and never shows a removal receipt", async () => {
  bridge({}, { count: 3, clearError: "task-host-unavailable：Host 账本正被占用" });
  render(<DesktopUsagePage tasks={tasks} taskId="task-1" onSelectTask={() => {}} />);
  await screen.findByText("Host 用量账本当前 3 条");
  fireEvent.click(screen.getByRole("button", { name: "清理本任务账本全部" }));
  fireEvent.click(screen.getByRole("button", { name: "确认清理" }));
  expect(await screen.findByTestId("usage-cleanup-error")).toHaveTextContent("task-host-unavailable：Host 账本正被占用");
  expect(screen.queryByTestId("usage-cleanup-note")).toBeNull();
  expect(screen.queryByText(/移除 \d+ 条/)).toBeNull();
});

it("says the ledger had nothing to clear instead of a success tone", async () => {
  bridge({}, { count: 0, clear: { removed: 0, remaining: 0, description: "清理全部用量明细" } });
  render(<DesktopUsagePage tasks={tasks} taskId="task-1" onSelectTask={() => {}} />);
  await screen.findByText("Host 用量账本当前 0 条");
  fireEvent.click(screen.getByRole("button", { name: "清理本任务账本全部" }));
  fireEvent.click(screen.getByRole("button", { name: "确认清理" }));
  expect(await screen.findByTestId("usage-cleanup-note")).toHaveTextContent("账本里原本没有可清理的条目");
  expect(screen.queryByText(/移除 \d+ 条/)).toBeNull();
});

it("flags a failed re-read instead of presenting the old ledger count as new", async () => {
  bridge({}, { count: 3, after: 0, clear: { removed: 3, remaining: 0, description: "清理全部用量明细" }, rereadError: "usage-ledger-unreadable" });
  render(<DesktopUsagePage tasks={tasks} taskId="task-1" onSelectTask={() => {}} />);
  await screen.findByText("Host 用量账本当前 3 条");
  fireEvent.click(screen.getByRole("button", { name: "清理本任务账本全部" }));
  fireEvent.click(screen.getByRole("button", { name: "确认清理" }));
  expect(await screen.findByTestId("usage-ledger-error")).toHaveTextContent("重读失败，数字可能已过期（usage-ledger-unreadable）");
});

it("drops the previous task's cleanup receipt when the selected task changes", async () => {
  bridge({}, { count: 3, after: 0, clear: { removed: 3, remaining: 0, description: "清理全部用量明细" } });
  const view = render(<DesktopUsagePage tasks={tasks} taskId="task-1" onSelectTask={() => {}} />);
  await screen.findByText("Host 用量账本当前 3 条");
  fireEvent.click(screen.getByRole("button", { name: "清理本任务账本全部" }));
  fireEvent.click(screen.getByRole("button", { name: "确认清理" }));
  expect(await screen.findByTestId("usage-cleanup-note")).toHaveTextContent("移除 3 条");
  view.rerender(<DesktopUsagePage tasks={tasks} taskId="task-2" onSelectTask={() => {}} />);
  await screen.findByText("Host 用量账本当前 0 条");
  expect(screen.queryByTestId("usage-cleanup-note")).toBeNull();
});
