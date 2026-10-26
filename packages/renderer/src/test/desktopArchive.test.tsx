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
afterEach(() => { cleanup(); delete window.pidock; vi.restoreAllMocks(); });

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
  // #47 wires this production action, so replace the former disabled/title assertions with the enabled state.
  expect(screen.getByRole("button", { name: "清理…" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "清理…" })).not.toHaveAttribute("title", "清理的生产界面未接线");
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

// Host resource verdicts as `task/lifecycleState` returns them: the verdicts
// live on each worktree / process entry, never on a port.
const verdictResources = {
  worktrees: [
    { repoDir: "/task/a/invoice", verdict: { ok: true, repoDir: "/task/a/invoice", head: "deadbeef", branch: "task/a" } },
    {
      repoDir: "/task/a/ledger",
      verdict: { ok: false, repoDir: "/task/a/ledger", code: "branch-mismatch", reason: "工作副本当前分支 release 与记录的任务分支 task/a 不符" },
    },
  ],
  processes: [{ kind: "service", id: "svc-billing", running: true, verdict: null }],
};
const withResources = (taskId: string, resources: unknown) => ({
  lifecycle: { taskId, archived: true, archivedAt: "2026-09-29T09:00:00Z", resources },
});

it("shows every Host resource verdict with its cleanup conclusion and named reason", async () => {
  const taskOp = bridge((taskId) => ({ ok: true, payload: withResources(taskId, verdictResources) }));
  render(<DesktopArchivePage tasks={[tasks[0]!]} onRestored={() => {}} />);
  const region = await screen.findByRole("region", { name: "任务 A资源判定" });
  expect(region).toHaveTextContent("工作副本 /task/a/invoice：可清理（Host 已验证身份）");
  expect(region).toHaveTextContent("工作副本 /task/a/ledger：不可清理：工作副本当前分支 release 与记录的任务分支 task/a 不符");
  expect(region).toHaveTextContent("服务 svc-billing：尚未判定：Host 未上报身份判定");
  // Rendering the readout is read-only: no op beyond the existing lifecycle read.
  expect(taskOp.mock.calls.every(([, op]) => op === "task/lifecycleState")).toBe(true);
});

it("shows an explicit empty verdict state instead of a clean bill of health", async () => {
  bridge((taskId) => ({ ok: true, payload: withResources(taskId, { worktrees: [], processes: [] }) }));
  render(<DesktopArchivePage tasks={[tasks[0]!]} onRestored={() => {}} />);
  const region = await screen.findByRole("region", { name: "任务 A资源判定" });
  expect(region).toHaveTextContent("Host 上报 0 项资源判定，尚无可判定项：这不代表资源可清理。");
  expect(region).not.toHaveTextContent("可清理（Host 已验证身份）");
  expect(region).not.toHaveTextContent("一切正常");
});

it("does not claim verdicts were computed when the Host omits resources", async () => {
  bridge((taskId) => ({ ok: true, payload: lifecycle(taskId, true) }));
  render(<DesktopArchivePage tasks={[tasks[0]!]} onRestored={() => {}} />);
  const region = await screen.findByRole("region", { name: "任务 A资源判定" });
  expect(region).toHaveTextContent("Host 未上报资源判定，尚未计算：未判定的资源不能当作可清理。");
  expect(region).not.toHaveTextContent("可清理（Host 已验证身份）");
});

const preview = {
  items: [
    { id: "sessions", resource: "会话记录", disposition: "remove", detail: "Host 将删除 3 个会话" },
    { id: "worktree", resource: "工作副本", disposition: "keep", detail: "Host 将保留工作副本 /task/repo" },
  ],
  warnings: ["Host 提醒：导出清单先写入保留位置"],
  recordsWillBeRemoved: true,
  selectionLabels: ["导出会话"],
  keepRoot: "/host/kept/task-a",
};
const cleanupResult = {
  items: preview.items,
  receipt: { ranAt: "2026-10-01T12:00:00Z", keptPosition: "/host/kept/task-a", exports: ["导出会话"], removed: ["sessions"], partialFailure: false },
  recovery: [],
};
function cleanupBridge(runResponse: unknown = { ok: true, payload: { cleanup: cleanupResult } }, previewResponse: unknown = { ok: true, payload: { preview } }) {
  return bridge((taskId, op) => {
    if (op === "task/cleanupPreview") return previewResponse;
    if (op === "task/runCleanup") return runResponse;
    return { ok: true, payload: lifecycle(taskId, true) };
  });
}
async function openHostPreview() {
  fireEvent.click(await screen.findByRole("button", { name: "清理…" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "导出会话" }));
  fireEvent.click(screen.getByRole("button", { name: "生成清单" }));
  await screen.findByText("会话记录：Host 将删除 3 个会话");
}

it("shows cleanup preview details and selection returned by Host", async () => {
  const taskOp = cleanupBridge();
  render(<DesktopArchivePage tasks={[tasks[0]!]} onRestored={() => {}} />);
  await openHostPreview();
  expect(screen.getByRole("region", { name: "任务 A清理预览" })).toHaveTextContent("工作副本：Host 将保留工作副本 /task/repo");
  expect(screen.getByText("Host 提醒：导出清单先写入保留位置")).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "任务 A清理预览" })).toHaveTextContent("Host 保留位置：/host/kept/task-a");
  expect(taskOp).toHaveBeenCalledWith("a", "task/cleanupPreview", {
    selection: { exportSessions: true, exportDrafts: false, exportUsage: false },
  });
});

it("does not call runCleanup when the user cancels the destructive confirmation", async () => {
  const taskOp = cleanupBridge();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(<DesktopArchivePage tasks={[tasks[0]!]} onRestored={() => {}} />);
  await openHostPreview();
  const callsBeforeConfirmation = taskOp.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "确认清理" }));
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Host 将删除 3 个会话"));
  expect(taskOp).toHaveBeenCalledTimes(callsBeforeConfirmation);
  expect(taskOp.mock.calls.some(([, op]) => op === "task/runCleanup")).toBe(false);
});

it("does not claim an incomplete Host preview has no destructive items", async () => {
  const incompletePreview = { ...preview, items: preview.items.map(({ disposition: _disposition, ...item }) => item) };
  const taskOp = cleanupBridge(undefined, { ok: true, payload: { preview: incompletePreview } });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(<DesktopArchivePage tasks={[tasks[0]!]} onRestored={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "清理…" }));
  fireEvent.click(screen.getByRole("button", { name: "生成清单" }));
  expect(await screen.findByText("Host 未上报将删除项目")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "确认清理" }));
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Host 预览将删除：Host 未上报将删除项目"));
  expect(taskOp.mock.calls.some(([, op]) => op === "task/runCleanup")).toBe(false);
});

it("shows the Host cleanup receipt and refreshes the archived list after execution", async () => {
  const taskOp = cleanupBridge();
  const onRestored = vi.fn();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<DesktopArchivePage tasks={[tasks[0]!]} onRestored={onRestored} />);
  await openHostPreview();
  fireEvent.click(screen.getByRole("button", { name: "确认清理" }));
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Host 将删除 3 个会话"));
  const panel = screen.getByRole("region", { name: "任务 A清理预览" });
  await waitFor(() => expect(panel).toHaveTextContent("实际移除：sessions"));
  expect(panel).toHaveTextContent("保留位置：/host/kept/task-a");
  expect(panel).toHaveTextContent("Host 清理项目结果");
  expect(panel).toHaveTextContent("将保留：工作副本：Host 将保留工作副本 /task/repo");
  expect(panel).toHaveTextContent("失败项：Host 上报无失败项");
  expect(screen.getByText("清理已执行")).toBeInTheDocument();
  await waitFor(() => expect(onRestored).toHaveBeenCalledOnce());
  await waitFor(() => expect(taskOp.mock.calls.filter(([, op]) => op === "task/lifecycleState").length).toBeGreaterThan(1));
});

it("shows a Host cleanup refusal verbatim without reporting success", async () => {
  const refusal = "permission-denied: 清理只允许界面显式操作，不能由 Agent 会话发起";
  const taskOp = cleanupBridge({ ok: false, error: refusal });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<DesktopArchivePage tasks={[tasks[0]!]} onRestored={() => {}} />);
  await openHostPreview();
  fireEvent.click(screen.getByRole("button", { name: "确认清理" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(refusal);
  expect(screen.queryByText("清理已执行")).toBeNull();
  expect(taskOp.mock.calls.some(([, op]) => op === "task/runCleanup")).toBe(true);
});
