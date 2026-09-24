import type { Message, Permission, RunRecord, Session } from "../data/types";
import { runStateLabel } from "./runState";

/**
 * [UI 对齐 07] (#31) the conversation's derived view data, kept out of the
 * component so the date grouping, the head labels and the run-result card can
 * be tested without a DOM.
 *
 * Two rules shaped this module:
 *  - the Host message model carries no per-message timestamp of its own (only
 *    `createdAt`, which the adapter stamps when it creates the message), so a
 *    message without one falls back to the session's `lastActivity` instead of
 *    inventing a time;
 *  - nothing here states a step, a result or a progress value the Host did not
 *    report — the card describes a real `RunRecord` or it does not render.
 */

export type ConversationMessageGroup = {
  key: string;
  /** `<day> · <session name>`, the prototype's `.date-label`. */
  label: string;
  messages: Message[];
};

export type ConversationBadge = { label: string; live: boolean };

export type ToolResultRow = {
  id: string;
  label: string;
  right: string;
  /** Row action that opens the matching tool panel; plain rows only state a count. */
  panel?: "files" | "browser";
};

export type ToolResultStep = {
  id: string;
  label: string;
  state: RunRecord["steps"][number]["state"];
  /** The prototype marks the step a running turn is on with `.dot.live`. */
  live: boolean;
};

export type ToolResultView = {
  rows: ToolResultRow[];
  steps: ToolResultStep[];
  result: string;
  detail?: string;
  live: boolean;
  warn: boolean;
};

const MODE_LABEL: Record<"read" | "other", string> = {
  read: "阅读与分析",
  other: "实现与验证",
};

/** Prototype `conversation()`: the session's own word for what it may do. */
export function conversationModeLabel(permission: Permission): string {
  return permission === "read" ? MODE_LABEL.read : MODE_LABEL.other;
}

/**
 * The head badge the prototype always renders on the agent row (`只读` / `空闲`).
 * A session that is actually running must not claim to be idle, so the busy and
 * terminal states reuse the execution state's own wording ([UI 对齐 05] #29).
 */
export function conversationBadge(session: Pick<Session, "permission" | "runState">): ConversationBadge {
  if (session.permission === "read") return { label: "只读", live: true };
  if (session.runState === "idle" || session.runState === "completed") return { label: "空闲", live: true };
  if (session.runState === "running") return { label: "执行中", live: true };
  if (session.runState === "approval") return { label: "等待确认", live: true };
  return { label: runStateLabel(session.runState), live: false };
}

/** Local `HH:MM` of a stamped message; `undefined` when the Host sent none. */
export function messageTimeLabel(createdAt: string | undefined): string | undefined {
  if (!createdAt) return undefined;
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return undefined;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function calendarKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** `今天` / `昨天` / `2026年9月22日` — computed against the passed clock. */
export function dayLabel(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (calendarKey(date) === calendarKey(now)) return "今天";
  if (calendarKey(date) === calendarKey(yesterday)) return "昨天";
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/**
 * One group per calendar day, in message order. `fallbackIso` is the session's
 * `lastActivity`: it is the only date the Host gives a message that predates
 * the `createdAt` field, so those messages group under it rather than under a
 * made-up "today".
 */
export function groupMessagesByDay(
  messages: readonly Message[],
  input: { sessionName: string; fallbackIso?: string | undefined; now: Date },
): ConversationMessageGroup[] {
  const groups: ConversationMessageGroup[] = [];
  const byDay = new Map<string, ConversationMessageGroup>();
  for (const message of messages) {
    const iso = message.createdAt ?? input.fallbackIso;
    const key = iso === undefined ? "unknown" : calendarKey(new Date(iso));
    let group = byDay.get(key);
    if (group === undefined) {
      group = {
        key,
        label: `${iso === undefined ? "时间未知" : dayLabel(iso, input.now)} · ${input.sessionName}`,
        messages: [],
      };
      byDay.set(key, group);
      groups.push(group);
    }
    group.messages.push(message);
  }
  return groups;
}

const RESULT_MARK: Partial<Record<RunRecord["state"], string>> = {
  completed: "✓",
  failed: "✗",
};

/**
 * The conversation's run-result card. It renders only from a real `RunRecord`:
 * the rows are counts the task workspace already reports and the steps/result
 * are the record's own fields, so nothing here can claim a tool run the Host
 * never reported. `undefined` means there is no execution to describe.
 */
export function toolResultView(input: {
  record: RunRecord | undefined;
  repositories: number;
  localServices: number;
  remoteServices: number;
}): ToolResultView | undefined {
  const { record } = input;
  if (record === undefined) return undefined;
  const mark = RESULT_MARK[record.state];
  const label = runStateLabel(record.state);
  const summary = record.summary.trim();
  // The Host names the outcome in some branches and describes the run in others
  // (`failed` keeps "构建失败，已保留现场", `approval` sets the state word itself), so
  // the state label only prefixes a summary that does not already say it.
  const result = mark === undefined ? (summary.length === 0 || summary.startsWith(label) ? summary || label : `${label} · ${summary}`) : `${mark} ${summary}`;
  return {
    rows: [
      { id: "workspace", label: `准备 ${input.repositories} 个仓库工作副本`, right: "查看文件 ↗", panel: "files" },
      {
        id: "services",
        label: "解析服务依赖与端口",
        right: `${input.localServices} 本地 · ${input.remoteServices} 远程`,
      },
    ],
    steps: record.steps.map((step, index) => ({
      id: `${index}-${step.label}`,
      label: step.label,
      state: step.state,
      // The prototype marks the step it is on (`app.js` `.dot.live`). A step that
      // has not happened yet and belongs to a turn that has not finished is that
      // step, whether the turn is running or waiting for its confirmation.
      live: step.state === "pending" && (record.state === "running" || record.state === "approval"),
    })),
    result,
    ...(record.failedScope === undefined ? {} : { detail: `失败范围：${record.failedScope}` }),
    live: record.state === "running" || record.state === "approval",
    warn: record.state === "failed" || record.state === "expired",
  };
}
