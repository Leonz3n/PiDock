import type { RunState } from "../data/types";

export function runStateLabel(state: RunState) {
  return {
    idle: "空闲",
    running: "执行中",
    approval: "等待确认",
    failed: "执行失败",
    completed: "已完成",
    stopped: "已停止",
    rejected: "已拒绝",
    expired: "确认已过期",
  }[state];
}

export function approvalStatusLabel(status: "pending" | "approved" | "rejected" | "expired") {
  return { pending: "待处理", approved: "已批准", rejected: "已拒绝", expired: "已过期" }[status];
}
