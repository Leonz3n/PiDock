import type { AttentionItem, RunState, ScheduledRun } from "../data/types";

export function runStateLabel(state: RunState) {
  // 原型 `closureLabels`（prototypes/pidock-ui/closure.js）：`failed` 是「失败」，
  // 与「需要处理」的 kind 文案一致（[UI 对齐 05] #29 验收 3）。
  return {
    idle: "空闲",
    running: "执行中",
    approval: "等待确认",
    failed: "失败",
    completed: "已完成",
    stopped: "已停止",
    rejected: "已拒绝",
    expired: "确认已过期",
  }[state];
}

export function approvalStatusLabel(status: "pending" | "approved" | "rejected" | "expired") {
  return { pending: "待处理", approved: "已批准", rejected: "已拒绝", expired: "已过期" }[status];
}

export function scheduledRunResultLabel(result: ScheduledRun["result"]) {
  return { completed: "完成", "awaiting-approval": "待确认", skipped: "跳过", failed: "失败" }[result];
}

export function attentionKindLabel(kind: AttentionItem["kind"]) {
  return { approval: "待确认", failed: "失败", expired: "过期", "completed-unread": "完成未读" }[kind];
}
