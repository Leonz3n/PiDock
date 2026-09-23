/**
 * [PiDock 14] (#17) renderer mirror of the lifecycle display rules.
 *
 * Display-only: the renderer never decides a permission, an identity or a
 * removal here — the Host owns those (`host/task-lifecycle.ts`) and the shell
 * adapter reads them back. This module only turns the lifecycle readout into
 * the labels the archive/cleanup views show, so the wording stays in one place
 * and can be unit-tested without a Host.
 */

import type { CleanupDisposition, CleanupItem, CleanupReceipt, CleanupSelection, TaskLifecycleState } from "./types";

export function cleanupSelectionLabels(selection: CleanupSelection): string[] {
  const labels: string[] = [];
  if (selection.exportSessions) labels.push("导出会话");
  if (selection.exportDrafts) labels.push("导出草稿");
  if (selection.exportUsage) labels.push("导出用量");
  return labels;
}

/** True when a record that is not exported will be removed by this cleanup. */
export function cleanupRemovesUnselectedRecords(selection: CleanupSelection, counts: { sessions: number; drafts: number; usage: number }): boolean {
  return (
    (!selection.exportSessions && counts.sessions > 0) ||
    (!selection.exportDrafts && counts.drafts > 0) ||
    (!selection.exportUsage && counts.usage > 0)
  );
}

export function cleanupDispositionLabel(disposition: CleanupDisposition | undefined): string {
  if (disposition === "keep-copy") return "保留独立副本";
  if (disposition === "keep") return "保留";
  if (disposition === "remove") return "移除";
  return "—";
}

/**
 * The rows the cleanup modal shows for one preview (resource / action / detail).
 * The disposition label leads the action; a row whose recorded action already
 * is that label shows it once, and a row without a disposition keeps its own
 * wording.
 */
export function cleanupRows(items: readonly CleanupItem[]): { key: string; resource: string; action: string; detail: string; disposition: string }[] {
  return items.map((item, index) => {
    const disposition = cleanupDispositionLabel(item.disposition);
    const action =
      item.disposition === undefined || item.action.trim() === "" || item.action === disposition
        ? item.action.trim() === "" ? disposition : item.action
        : `${disposition} · ${item.action}`;
    return {
      key: item.id ?? `${item.resource}-${index}`,
      resource: item.resource,
      action,
      detail: item.detail,
      disposition,
    };
  });
}

/** Human summary of a cleanup receipt (kept position, exports, removed, partial). */
export function cleanupReceiptLines(receipt: CleanupReceipt): string[] {
  const lines: string[] = [];
  if (receipt.keptPosition !== null) lines.push(`保留位置：${receipt.keptPosition}`);
  lines.push(receipt.exports.length > 0 ? `已导出：${receipt.exports.join("、")}` : "未选择导出");
  lines.push(receipt.removed.length > 0 ? `已移除：${receipt.removed.join("、")}` : "未移除受管资源");
  lines.push(
    receipt.partialFailure
      ? "局部清理失败：保留任务登记与逐项恢复入口，项目关联未解除"
      : "清理成功：留下保留位置与回执，项目不再被该任务阻止删除",
  );
  return lines;
}

/**
 * Archive readout: what archiving keeps (code/sessions/template/generation
 * bindings/browser state), that scheduling stays paused, and that token usage
 * is not zeroed by archiving or restoring.
 */
export function lifecycleSummary(state: TaskLifecycleState): { lines: string[]; scheduleNote: string; usageNote: string } {
  return {
    lines: [
      state.archived ? `已归档（${state.archivedAt?.slice(0, 19) ?? "时间未记录"}）` : "未归档",
      state.restoredAt === null ? "尚未恢复" : `最近恢复：${state.restoredAt.slice(0, 19)}`,
      state.cleanup === null ? "尚未清理" : state.cleanup.partialFailure ? "清理局部失败（保留登记）" : "清理已完成",
    ],
    scheduleNote: state.schedulePaused
      ? "归档暂停调度；恢复任务不会自动重新启用调度或启动服务"
      : "调度未被归档暂停",
    usageNote: `归档／恢复不清零或重复累计 Token；当前保留用量记录 ${state.usageDetails} 条`,
  };
}

/** Identity verdicts shown next to a worktree / live process (never a port claim). */
export function resourceIdentityLabel(input: { running?: boolean; ok?: boolean | null; reason?: string }): string {
  if (input.running === false) return "未运行";
  if (input.ok === null || input.ok === undefined) return "无进程身份记录";
  return input.ok ? "身份已验证" : `未验证：${input.reason ?? "身份不符"}`;
}

/** Recovery entries the archive page shows after a partial cleanup. */
export function cleanupRecoveryLines(recovery: readonly { item: string; reason: string }[]): string[] {
  return recovery.map((entry) => `${entry.item}：${entry.reason}`);
}
