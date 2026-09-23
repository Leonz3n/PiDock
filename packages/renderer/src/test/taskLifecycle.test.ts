/**
 * Tests for the [PiDock 14] (#17) renderer lifecycle display mirror. Pure
 * functions only: the Host owns the decisions, this module owns the wording.
 */
import { describe, expect, it } from "vitest";
import {
  cleanupDispositionLabel,
  cleanupReceiptLines,
  cleanupRecoveryLines,
  cleanupRemovesUnselectedRecords,
  cleanupRows,
  cleanupSelectionLabels,
  lifecycleSummary,
  resourceIdentityLabel,
} from "../data/taskLifecycle";
import type { CleanupItem, TaskLifecycleState } from "../data/types";

describe("cleanup selection helpers", () => {
  it("labels the chosen exports", () => {
    expect(cleanupSelectionLabels({ exportSessions: true, exportDrafts: false, exportUsage: true })).toEqual(["导出会话", "导出用量"]);
    expect(cleanupSelectionLabels({ exportSessions: false, exportDrafts: false, exportUsage: false })).toEqual([]);
  });

  it("warns that unselected records are removed", () => {
    const counts = { sessions: 2, drafts: 1, usage: 3 };
    expect(cleanupRemovesUnselectedRecords({ exportSessions: false, exportDrafts: true, exportUsage: true }, counts)).toBe(true);
    expect(cleanupRemovesUnselectedRecords({ exportSessions: true, exportDrafts: true, exportUsage: true }, counts)).toBe(false);
    // Nothing to remove: no warning even without an export.
    expect(cleanupRemovesUnselectedRecords({ exportSessions: false, exportDrafts: false, exportUsage: false }, { sessions: 0, drafts: 0, usage: 0 })).toBe(false);
  });
});

describe("cleanup rows and receipt", () => {
  const items: CleanupItem[] = [
    { id: "code", resource: "代码", action: "保留独立副本", detail: "先保留副本再解除登记", disposition: "keep-copy" },
    { id: "sessions", resource: "会话与草稿", action: "导出后删除", detail: "3 个会话", disposition: "remove" },
    { id: "usage", resource: "用量", action: "", detail: "Host 只回 disposition", disposition: "remove" },
    { resource: "未知", action: "保留", detail: "无 disposition" },
  ];

  it("renders one row per item with the disposition label in front of the action", () => {
    expect(cleanupRows(items)).toEqual([
      { key: "code", resource: "代码", action: "保留独立副本", detail: "先保留副本再解除登记", disposition: "保留独立副本" },
      { key: "sessions", resource: "会话与草稿", action: "移除 · 导出后删除", detail: "3 个会话", disposition: "移除" },
      { key: "usage", resource: "用量", action: "移除", detail: "Host 只回 disposition", disposition: "移除" },
      { key: "未知-3", resource: "未知", action: "保留", detail: "无 disposition", disposition: "—" },
    ]);
    expect(cleanupDispositionLabel(undefined)).toBe("—");
  });

  it("summarises a successful receipt and a partial failure differently", () => {
    expect(
      cleanupReceiptLines({ ranAt: "2026-09-22T12:00:00+08:00", keptPosition: "/kept/task-a", exports: ["导出用量"], removed: ["usage"], partialFailure: false }),
    ).toEqual(["保留位置：/kept/task-a", "已导出：导出用量", "已移除：usage", "清理成功：留下保留位置与回执，项目不再被该任务阻止删除"]);
    const partial = cleanupReceiptLines({ ranAt: "t", keptPosition: null, exports: [], removed: [], partialFailure: true });
    expect(partial).toEqual(["未选择导出", "未移除受管资源", "局部清理失败：保留任务登记与逐项恢复入口，项目关联未解除"]);
    expect(cleanupRecoveryLines([{ item: "browser", reason: "未接线" }])).toEqual(["browser：未接线"]);
  });
});

describe("lifecycle summary", () => {
  const base: TaskLifecycleState = {
    taskId: "task-a",
    archived: true,
    archivedAt: "2026-09-22T12:00:00+08:00",
    restoredAt: null,
    schedulePaused: true,
    cleanup: null,
    recovery: [],
    usageDetails: 7,
    worktrees: [],
    processes: [],
  };

  it("reports archive state, the paused schedule and the untouched usage scope", () => {
    const summary = lifecycleSummary(base);
    expect(summary.lines[0]).toContain("已归档");
    expect(summary.lines[2]).toBe("尚未清理");
    expect(summary.scheduleNote).toContain("恢复任务不会自动重新启用调度");
    expect(summary.usageNote).toContain("7 条");
  });

  it("distinguishes a partial cleanup from a completed one", () => {
    const partial = lifecycleSummary({ ...base, cleanup: { ranAt: "t", keptPosition: "/kept", exports: [], removed: [], partialFailure: true } });
    expect(partial.lines[2]).toBe("清理局部失败（保留登记）");
    const done = lifecycleSummary({ ...base, cleanup: { ranAt: "t", keptPosition: "/kept", exports: [], removed: ["usage"], partialFailure: false } });
    expect(done.lines[2]).toBe("清理已完成");
  });

  it("labels a resource identity verdict without ever implying a port claim", () => {
    expect(resourceIdentityLabel({ running: false })).toBe("未运行");
    expect(resourceIdentityLabel({ running: true, ok: null })).toBe("无进程身份记录");
    expect(resourceIdentityLabel({ running: true, ok: true })).toBe("身份已验证");
    expect(resourceIdentityLabel({ running: true, ok: false, reason: "端口不是进程身份" })).toBe("未验证：端口不是进程身份");
  });
});
