/**
 * Session navigation rules ([PiDock 09] #11, 产品设计收口「会话导航」).
 *
 * 标签保持创建顺序、最多显示四个；隐藏的当前会话替换最后一个可见位置后仍按
 * 创建顺序展示；窄屏只显示当前会话。标签文本有界，会话名再长也不会把导航撑开
 * （完整名走 `title`）。规则放在这里，让导航、全部会话列表和测试共用同一份实现。
 */

import type { Session } from "./types";

/** Visible session tabs; the hidden active session takes the last slot. */
export const MAX_VISIBLE_SESSION_TABS = 4;

/** Bounded tab label: long session names are marked, never wrapped. */
export function sessionTabLabel(name: string, max = 10): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "未命名会话";
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

/**
 * Tabs to show for a task: the first four in creation order, plus the active
 * session when it is hidden — it replaces the last visible slot, so the active
 * conversation is always reachable without reordering the list. Narrow layouts
 * (`narrow`) show the active session only.
 */
export function visibleSessionTabs(
  sessions: readonly Session[],
  activeSessionId: string,
  options: { narrow?: boolean } = {},
): Session[] {
  const active = sessions.find((session) => session.id === activeSessionId);
  if (options.narrow === true) return active ? [active] : sessions.slice(0, 1);
  const visible = sessions.slice(0, MAX_VISIBLE_SESSION_TABS);
  if (active === undefined || visible.some((session) => session.id === activeSessionId)) return visible;
  return [...visible.slice(0, MAX_VISIBLE_SESSION_TABS - 1), active];
}

export type SessionMenuAction = "open" | "rename" | "archive" | "restore" | "stop" | "browse";

/** Right-click actions for one session tab (order = menu order). */
export function sessionMenuActions(
  session: Pick<Session, "archived" | "runState">,
  options: { isOwner: boolean; isWaiting: boolean },
): SessionMenuAction[] {
  const actions: SessionMenuAction[] = ["open", "rename"];
  if (session.archived) actions.push("restore");
  else actions.push("archive");
  if (options.isOwner || options.isWaiting || session.runState === "running" || session.runState === "approval") {
    actions.push("stop");
  }
  actions.push("browse");
  return actions;
}

export const SESSION_MENU_LABEL: Record<SessionMenuAction, string> = {
  open: "设为当前会话",
  rename: "重命名",
  archive: "归档会话",
  restore: "恢复会话",
  stop: "中止该会话",
  browse: "在全部会话中查看",
};
