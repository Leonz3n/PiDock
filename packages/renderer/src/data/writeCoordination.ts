/**
 * Renderer mirror of the task write coordination ([PiDock 09] #11).
 *
 * The renderer never decides who may write — the Host does (`write-coordination.ts`
 * in the shell). This module only turns the coordination state the adapter
 * returns into the view the navigation shows: 持有者 / 排队（含位置）/ 只读 /
 * 遗留资源，以及「中止」入口要用的会话。规则与展示分开，避免 renderer 再实现
 * 一份权限判定（那样两份判定必然漂移）。
 */

import type { Session, Task, TaskWriteLockView } from "./types";

export type { TaskWriteLockView } from "./types";

/** Coordination state of one task as the navigation reads it. */
export type TaskWriteLock = TaskWriteLockView;

export type SessionWriteRole = "owner" | "waiting" | "readonly" | "idle";

export type SessionWriteState = {
  sessionId: string;
  role: SessionWriteRole;
  /** 1-based queue position for a waiting session. */
  queuePosition?: number;
};

export function emptyTaskWriteLock(): TaskWriteLockView {
  return { owner: null, waiting: [], orphans: [], derived: [] };
}

/** Roles of every session of a task; unknown sessions default to `idle`. */
export function sessionWriteStates(task: Pick<Task, "sessions" | "writeLock">): SessionWriteState[] {
  const lock = task.writeLock ?? emptyTaskWriteLock();
  return task.sessions.map((session) => {
    if (session.id === lock.owner) return { sessionId: session.id, role: "owner" as const };
    const index = lock.waiting.indexOf(session.id);
    if (index !== -1) return { sessionId: session.id, role: "waiting" as const, queuePosition: index + 1 };
    if (session.permission === "read") return { sessionId: session.id, role: "readonly" as const };
    return { sessionId: session.id, role: "idle" as const };
  });
}

/** Short badge text for one session's coordination role. */
export function sessionWriteRoleLabel(state: SessionWriteState): string | null {
  if (state.role === "owner") return "持有写操作权";
  if (state.role === "waiting") return `排队第 ${state.queuePosition ?? 1} 位`;
  if (state.role === "readonly") return "只读";
  return null;
}

/**
 * Whether the coordination bar has anything to show: a holder, a queue, a
 * read-only session or a leftover resource. Without one of those the task is
 * "idle" and the bar stays out of the way.
 */
export function writeCoordinationVisible(task: Pick<Task, "sessions" | "writeLock">): boolean {
  const lock = task.writeLock ?? emptyTaskWriteLock();
  return lock.owner !== null || lock.waiting.length > 0 || lock.orphans.length > 0 || lock.derived.length > 0;
}

/** Human text for the coordination bar (never claims a state the Host did not send). */
export function writeCoordinationSummary(task: Pick<Task, "sessions" | "writeLock">): string {
  const lock = task.writeLock ?? emptyTaskWriteLock();
  if (lock.owner === null) {
    return lock.orphans.length > 0
      ? `遗留执行资源待核验：${lock.orphans.map((orphan) => orphan.label ?? orphan.resourceId).join("、")}`
      : "无会话持有写操作权";
  }
  const owner = task.sessions.find((session) => session.id === lock.owner);
  const derived = lock.derived.filter((item) => item.sessionId === lock.owner);
  return [
    `${owner?.name ?? lock.owner} 持有写操作权${lock.ownerLabel !== undefined ? `（${lock.ownerLabel}）` : ""}`,
    ...(derived.length > 0 ? [`派生执行中：${derived.map((item) => item.label).join("、")}`] : []),
    ...(lock.waiting.length > 0 ? [`排队 ${lock.waiting.length} 个会话`] : []),
  ].join(" · ");
}

/** Session records queued behind the holder, in queue order. */
export function waitingSessions(task: Pick<Task, "sessions" | "writeLock">): Session[] {
  const lock = task.writeLock ?? emptyTaskWriteLock();
  return lock.waiting
    .map((sessionId) => task.sessions.find((session) => session.id === sessionId))
    .filter((session): session is Session => session !== undefined);
}
