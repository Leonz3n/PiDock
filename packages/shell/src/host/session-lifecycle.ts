/**
 * Session lifecycle: 停止 / 归档 / 恢复 / 删除 ([Pencil T11] #146).
 *
 * #139 gave a task several real sessions and the basic index writes. What it
 * did NOT do is make an operation on a *running* session safe: deleting an id
 * while its turn streamed left the SDK writing its JSONL into a directory the
 * Host had already declared gone, and archiving a running session left the turn
 * writing into a session the user had just made read-only.
 *
 * This module owns the ONE order every lifecycle write follows:
 *
 *   1. read the session (a session the index does not have is `session-unknown`,
 *      never invented);
 *   2. refuse by name when the action does not apply to that state (an archived
 *      session cannot be stopped/archived again, a live session cannot be
 *      restored, a session with nothing running cannot be "stopped");
 *   3. if anything is live — an SDK turn, a Host turn, a pending confirmation —
 *      ABORT it, await turn settlement, release the session's tool/resource
 *      claims and expire its pending approvals BEFORE touching history;
 *   4. only then write: archive / restore / delete (delete also retires the id
 *      on the turn transport first, so a late `start` is refused by identity —
 *      `session-deleted` — instead of appending one more JSONL line to a
 *      session that no longer exists);
 *   5. report what really happened (`stopped`, the aborted turn ids, the new
 *      index). A caller never has to guess whether an abort was needed.
 *
 * The ports are the Host's own reads/writes; the policy never reaches around
 * them, so this sequence is testable without a live model, a worker or an
 * Electron window, and there is exactly one place that decides it.
 */

import type { SessionIndex } from "./session-index.js";

export const SESSION_LIFECYCLE_ACTIONS = ["stop", "archive", "restore", "delete"] as const;
export type SessionLifecycleAction = (typeof SESSION_LIFECYCLE_ACTIONS)[number];

export const SESSION_LIFECYCLE_ACTION_TEXT: Record<SessionLifecycleAction, string> = {
  stop: "停止",
  archive: "归档",
  restore: "恢复",
  delete: "删除",
};

/** What the Host can observe about one session without opening it. */
export interface SessionLifecycleState {
  id: string;
  archived: boolean;
  /** An SDK turn or a Host turn is in flight for this session. */
  busy: boolean;
  /** Confirmations parked on this session (a turn waiting on approval counts as live). */
  pendingApprovals: number;
}

export function sessionIsLive(state: SessionLifecycleState): boolean {
  return state.busy || state.pendingApprovals > 0;
}

/**
 * The named refusal for one action in one state, or `null` when it applies.
 * The order is the order the Host applies it: a state refusal never hides
 * behind an abort, so an invalid archive of an archived session does not stop
 * anything first.
 */
export function sessionLifecycleRefusal(action: SessionLifecycleAction, state: SessionLifecycleState): string | null {
  switch (action) {
    case "stop":
      if (state.archived) return "session-archived: 已归档的会话没有正在执行的回合，不能停止；请先恢复";
      if (!sessionIsLive(state)) return "session-not-running: 该会话没有正在执行的回合或待确认操作，无需停止";
      return null;
    case "archive":
      if (state.archived) return "session-archived: 该会话已归档，不能重复归档";
      return null;
    case "restore":
      if (!state.archived) return "session-not-archived: 该会话未归档，无需恢复";
      return null;
    case "delete":
      return null;
  }
}

export function assertSessionLifecycle(action: SessionLifecycleAction, state: SessionLifecycleState): void {
  const refusal = sessionLifecycleRefusal(action, state);
  if (refusal !== null) throw new Error(refusal);
}

/** What the Host must provide for one lifecycle write. Each port is an owned read/write. */
export interface SessionLifecyclePorts {
  /** The session's state; throws `session-unknown` when the index has no such session. */
  state(sessionId: string): SessionLifecycleState;
  /** Abort every live turn of this session and await settlement; returns the stopped turn ids. */
  abortTurn(sessionId: string): Promise<string[]>;
  /** Release the session's Host-side claims, derived executions and pending approvals. */
  releaseSession(sessionId: string): void;
  /** The current index (used to report a stop, which writes no session field). */
  index(): SessionIndex;
  archive(sessionId: string): SessionIndex;
  restore(sessionId: string): SessionIndex;
  /** Remove the record, its snapshots, its drafts and its SDK artifacts. */
  remove(sessionId: string): SessionIndex;
  /** Refuse any future turn for this id, by identity. */
  retire(sessionId: string): void;
}

export interface SessionLifecycleOutcome {
  action: SessionLifecycleAction;
  sessionId: string;
  /** True only when a live turn/confirmation was really aborted before the write. */
  stopped: boolean;
  abortedTurnIds: string[];
  index: SessionIndex;
}

/**
 * Perform one lifecycle write in the documented order. A live session is
 * stopped first, and the write happens only after the abort settled and the
 * session's claims/approvals were released; a delete additionally retires the
 * id before the record disappears, so nothing can accept a late turn for it.
 */
export async function runSessionLifecycle(
  action: SessionLifecycleAction,
  sessionId: string,
  ports: SessionLifecyclePorts,
): Promise<SessionLifecycleOutcome> {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(sessionId)) throw new Error("invalid-payload: invalid session id");
  const before = ports.state(sessionId);
  assertSessionLifecycle(action, before);
  // Restore is the only action that must NOT stop anything: a restored session
  // keeps its history and replays no turn, approval or tool.
  if (action === "restore") {
    return { action, sessionId, stopped: false, abortedTurnIds: [], index: ports.restore(sessionId) };
  }
  let abortedTurnIds: string[] = [];
  const live = sessionIsLive(before);
  if (live) {
    abortedTurnIds = await ports.abortTurn(sessionId);
    // Release even when the kernel reported no live turn: a pending
    // confirmation or a derived execution is itself a live resource.
    ports.releaseSession(sessionId);
    const after = ports.state(sessionId);
    if (sessionIsLive(after)) throw new Error("sdk-turn-unsettled: 回合或待确认操作未结算，未更新会话历史");
  }
  if (action === "stop") {
    // A stop changes no session field: it ends the live work and leaves the
    // identity, history, archive flag and draft exactly as they were.
    return { action, sessionId, stopped: true, abortedTurnIds, index: ports.index() };
  }
  if (action === "archive") {
    return { action, sessionId, stopped: live, abortedTurnIds, index: ports.archive(sessionId) };
  }
  // Delete: refuse late turns by identity BEFORE the record and artifacts go,
  // so the window between "aborted" and "removed" cannot accept a new turn.
  ports.retire(sessionId);
  return { action, sessionId, stopped: live, abortedTurnIds, index: ports.remove(sessionId) };
}

/** The Host's own ports for `runSessionLifecycle`; the only place that wires a real task. */
export interface LifecycleHost {
  sessionIndex(): SessionIndex;
  sessionActivity(sessionId: string): { running: boolean; pendingApprovals: number };
  cancel(sessionId: string): void;
  archiveTaskSession(sessionId: string): SessionIndex;
  restoreTaskSession(sessionId: string): SessionIndex;
  deleteTaskSession(sessionId: string): SessionIndex;
}

/** The turn transport half of the lifecycle (SDK turns only; `null` = no SDK route yet). */
export interface LifecycleTurns {
  busy(sessionId: string): boolean;
  abortSession(sessionId: string): Promise<{ turnId: string }[]>;
  retire(sessionId: string): void;
}

export function hostSessionLifecyclePorts(host: LifecycleHost, turns: LifecycleTurns | null): SessionLifecyclePorts {
  return {
    state: (sessionId) => {
      const session = host.sessionIndex().sessions.find((entry) => entry.id === sessionId);
      if (!session) throw new Error("session-unknown");
      const activity = host.sessionActivity(sessionId);
      return {
        id: session.id,
        archived: session.archived,
        busy: activity.running || (turns?.busy(sessionId) ?? false),
        pendingApprovals: activity.pendingApprovals,
      };
    },
    abortTurn: async (sessionId) => (turns === null ? [] : (await turns.abortSession(sessionId)).map((turn) => turn.turnId)),
    releaseSession: (sessionId) => { host.cancel(sessionId); },
    index: () => host.sessionIndex(),
    archive: (sessionId) => host.archiveTaskSession(sessionId),
    restore: (sessionId) => host.restoreTaskSession(sessionId),
    remove: (sessionId) => host.deleteTaskSession(sessionId),
    retire: (sessionId) => { turns?.retire(sessionId); },
  };
}
