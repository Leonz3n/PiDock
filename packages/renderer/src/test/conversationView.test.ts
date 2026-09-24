import { describe, expect, it } from "vitest";
import {
  conversationBadge,
  conversationModeLabel,
  dayLabel,
  groupMessagesByDay,
  messageTimeLabel,
  toolResultView,
} from "../pages/conversationView";
import type { Message, RunRecord } from "../data/types";

/**
 * [UI 对齐 07] (#31) the conversation's derived data. The geometry lives in
 * `docs/evidence/ui-alignment-s6/capture-conversation.mjs`; what is asserted
 * here is the text, the grouping and — most of all — that the run-result card
 * cannot state anything the Host record does not carry.
 */

const at = (iso: string): Message => ({ id: iso, role: "agent", text: "x", createdAt: iso });

describe("conversation head labels", () => {
  it("names the session mode the way the prototype does", () => {
    expect(conversationModeLabel("read")).toBe("阅读与分析");
    expect(conversationModeLabel("default")).toBe("实现与验证");
    expect(conversationModeLabel("auto")).toBe("实现与验证");
  });

  it("keeps 只读 / 空闲 for the states the prototype always renders", () => {
    expect(conversationBadge({ permission: "read", runState: "idle" })).toEqual({ label: "只读", live: true });
    expect(conversationBadge({ permission: "default", runState: "idle" })).toEqual({ label: "空闲", live: true });
    expect(conversationBadge({ permission: "default", runState: "completed" })).toEqual({ label: "空闲", live: true });
  });

  it("never claims 空闲 while the session is busy", () => {
    expect(conversationBadge({ permission: "default", runState: "running" }).label).toBe("执行中");
    expect(conversationBadge({ permission: "default", runState: "approval" }).label).toBe("等待确认");
    // A terminal state reuses the execution card's own word and drops the live dot.
    expect(conversationBadge({ permission: "default", runState: "failed" })).toEqual({ label: "失败", live: false });
    expect(conversationBadge({ permission: "default", runState: "expired" }).label).toBe("确认已过期");
  });

  it("prints a message time only when the Host stamped one", () => {
    expect(messageTimeLabel("2026-09-22T09:29:00+08:00")).toMatch(/^\d{2}:\d{2}$/);
    expect(messageTimeLabel(undefined)).toBeUndefined();
    expect(messageTimeLabel("not-a-date")).toBeUndefined();
  });
});

describe("day grouping", () => {
  const now = new Date("2026-09-22T12:00:00+08:00");

  it("names today, yesterday and older days", () => {
    expect(dayLabel("2026-09-22T09:00:00+08:00", now)).toBe("今天");
    expect(dayLabel("2026-09-21T09:00:00+08:00", now)).toBe("昨天");
    expect(dayLabel("2026-09-19T09:00:00+08:00", now)).toBe("2026年9月19日");
  });

  it("groups by calendar day and labels each group with the session name", () => {
    const groups = groupMessagesByDay([at("2026-09-21T09:00:00+08:00"), at("2026-09-22T09:00:00+08:00"), at("2026-09-22T10:00:00+08:00")], {
      sessionName: "实现与验证",
      now,
    });
    expect(groups.map((group) => group.label)).toEqual(["昨天 · 实现与验证", "今天 · 实现与验证"]);
    expect(groups.map((group) => group.messages.length)).toEqual([1, 2]);
  });

  it("falls back to the session's own activity for messages that predate the field", () => {
    const [group] = groupMessagesByDay([{ id: "m", role: "agent", text: "x" }], {
      sessionName: "实现与验证",
      fallbackIso: "2026-09-21T09:00:00+08:00",
      now,
    });
    expect(group?.label).toBe("昨天 · 实现与验证");
  });

  it("says so instead of inventing a date when no source has one", () => {
    const [group] = groupMessagesByDay([{ id: "m", role: "agent", text: "x" }], { sessionName: "实现与验证", now });
    expect(group?.label).toBe("时间未知 · 实现与验证");
  });
});

describe("tool result card", () => {
  const base: RunRecord = {
    id: "run-1",
    taskId: "atlas",
    sessionId: "release:main",
    state: "running",
    startedAt: "2026-09-22T09:30:00+08:00",
    summary: "正在执行",
    steps: [
      { label: "读取任务上下文", state: "done" },
      { label: "运行工具", state: "pending" },
    ],
  };
  const counts = { repositories: 4, localServices: 5, remoteServices: 2 };

  it("renders nothing without a run record", () => {
    expect(toolResultView({ record: undefined, ...counts })).toBeUndefined();
  });

  it("takes its rows from the workspace the task already reports", () => {
    const view = toolResultView({ record: base, ...counts });
    expect(view?.rows).toEqual([
      { id: "workspace", label: "准备 4 个仓库工作副本", right: "查看文件 ↗", panel: "files" },
      { id: "services", label: "解析服务依赖与端口", right: "5 本地 · 2 远程" },
    ]);
  });

  it("marks the step a live turn is on with the live dot", () => {
    const running = toolResultView({ record: base, ...counts });
    expect(running?.steps.map((step) => step.live)).toEqual([false, true]);
    // The same step stops being live once the turn is over; the state word is
    // the only other thing that changes.
    const completed = toolResultView({ record: { ...base, state: "completed", summary: "执行完成" }, ...counts });
    expect(completed?.steps.map((step) => step.live)).toEqual([false, false]);
    expect(completed?.steps[1]?.state).toBe("pending");
  });

  it("prefixes the outcome mark and keeps the Host's own failure scope", () => {
    const failed = toolResultView({
      record: { ...base, state: "failed", summary: "构建失败，已保留现场", failedScope: "front-monorepo web 包编译失败" },
      ...counts,
    });
    expect(failed?.result).toBe("✗ 构建失败，已保留现场");
    expect(failed?.detail).toBe("失败范围：front-monorepo web 包编译失败");
    expect(failed?.warn).toBe(true);
  });

  it("does not repeat the state word when the summary already says it", () => {
    expect(toolResultView({ record: { ...base, summary: "执行中" }, ...counts })?.result).toBe("执行中");
    // An empty summary keeps the label rather than rendering an empty bar.
    expect(toolResultView({ record: { ...base, summary: "  " }, ...counts })?.result).toBe("执行中");
    expect(toolResultView({ record: { ...base, state: "stopped", summary: "已按请求停止" }, ...counts })?.result).toBe("已停止 · 已按请求停止");
  });

  it("states no step at all when the Host reported none", () => {
    const view = toolResultView({ record: { ...base, steps: [] }, ...counts });
    expect(view?.steps).toEqual([]);
    expect(view?.result).toBe("执行中 · 正在执行");
  });
});
