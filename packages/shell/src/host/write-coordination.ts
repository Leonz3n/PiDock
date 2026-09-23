/**
 * Task-scoped write coordination for [PiDock 09] (#11).
 *
 * 同一任务同一时刻只有一个会话持有写操作权（盒子 2）；读取与分析不需要写操作
 * 权，因此不会被在写会话阻塞（盒子 3）。每个 `TaskWorkspaceHost` 各自持有一个
 * 协调器，跨任务／跨项目的非重叠资源依旧并行 —— 这里**不**引入项目级或应用级
 * 的全局单会话锁（盒子 6）。
 *
 * 规则是纯函数/纯状态机：Host 派发、服务与浏览器序列、renderer 镜像和它们的
 * 测试共用同一份判定，避免「写操作权」在多处各写一遍而漂移。
 *
 * 写操作权按**声明（claim）**计数：一次回合内的工具、一次 Host 驱动的一次性
 * 操作各自声明，声明全部结束后才释放持有者。派生执行（子进程／子 Agent）的
 * 声明比回合活得更久，因此「对话流结束」不会提前释放写操作权（盒子 4）。
 */

import type { PiPermission } from "../main/pi-session.js";

/** What is asking for the write right. Every kind is side-effecting. */
export type WriteIntentKind = "turn" | "service-control" | "browser-action" | "config" | "derived-execution";

export interface WriteIntent {
  kind: WriteIntentKind;
  /** Human label: shown in refusal text and in the coordination view. */
  label: string;
}

/** One live claim on the task's write right. */
export interface WriteClaim {
  claimId: string;
  sessionId: string;
  kind: WriteIntentKind;
  label: string;
}

/** A derived execution (child process / sub-agent) that outlives its turn. */
export interface DerivedExecutionClaim {
  resourceId: string;
  sessionId: string;
  label: string;
}

export interface WaitingSession {
  sessionId: string;
  label: string;
}

/** Whole coordination state of one task. */
export interface WriteLockSnapshot {
  claims: WriteClaim[];
  derived: DerivedExecutionClaim[];
  waiting: WaitingSession[];
}

/**
 * An agent-owned running resource the Host knows about (a started service, a
 * recorded process). `ownerSessionId` is the session that started it; `null`
 * means the actor was not a session (human UI) and is never an orphan.
 */
export interface AgentOwnedResource {
  resourceId: string;
  kind: "service" | "process" | "other";
  ownerSessionId: string | null;
  label?: string;
}

export type WriteClaimResult =
  | { ok: true; claimId: string }
  | { ok: false; verdict: "readonly"; reason: string }
  | {
      ok: false;
      verdict: "locked";
      reason: string;
      owner: string | null;
      /** 1-based queue position of this session while it waits. */
      queuePosition: number;
      /** Leftover agent-owned resources that must be verified/stopped first. */
      orphans?: AgentOwnedResource[];
    };

export interface WriteLockRelease {
  snapshot: WriteLockSnapshot;
  /** Session whose write right ended with this release, when any. */
  releasedOwner: string | null;
  /** Why the right is kept although a claim ended. */
  retained?: { sessionId: string; reason: "in-flight-claim" | "derived-execution" };
}

/** Read-only sessions never hold the right; `readonly` is the UI's third state. */
export type WriteSessionRole = "owner" | "waiting" | "readonly" | "idle";

export interface WriteSessionView {
  sessionId: string;
  role: WriteSessionRole;
  permission: PiPermission;
  runState: string;
  /** Claim/wait label when the session is the owner or queued. */
  label?: string;
  queuePosition?: number;
}

export interface WriteLockView {
  owner: string | null;
  waiting: string[];
  readonly: string[];
  derived: DerivedExecutionClaim[];
  orphans: AgentOwnedResource[];
  sessions: WriteSessionView[];
}

/** Bounded queue/list sizes: display state, never an unbounded growth path. */
export const MAX_WAITING_SESSIONS = 8;
const MAX_CLAIMS = 32;
const MAX_DERIVED = 16;

export function emptyWriteLock(): WriteLockSnapshot {
  return { claims: [], derived: [], waiting: [] };
}

/** Owner is the session with a live claim, or the one a derived execution holds. */
export function writeLockOwner(snapshot: WriteLockSnapshot): string | null {
  return snapshot.claims[0]?.sessionId ?? snapshot.derived[0]?.sessionId ?? null;
}

export function writeLockSnapshot(snapshot: WriteLockSnapshot): WriteLockSnapshot {
  return {
    claims: snapshot.claims.map((claim) => ({ ...claim })),
    derived: snapshot.derived.map((claim) => ({ ...claim })),
    waiting: snapshot.waiting.map((entry) => ({ ...entry })),
  };
}

/**
 * Leftover agent-owned resources the requester must not write alongside: a
 * running resource owned by **another** session that holds no live claim (its
 * process survived a cancel/restore). Resources owned by the requester itself
 * are its own work, and human-started resources have no session to coordinate
 * with, so neither is an orphan.
 */
export function orphanResourcesFor(input: {
  resources: readonly AgentOwnedResource[];
  requester: string;
  snapshot: WriteLockSnapshot;
}): AgentOwnedResource[] {
  const claiming = new Set(input.snapshot.claims.map((claim) => claim.sessionId));
  return input.resources
    .filter(
      (resource) =>
        resource.ownerSessionId !== null && resource.ownerSessionId !== input.requester && !claiming.has(resource.ownerSessionId),
    )
    .map((resource) => ({ ...resource }))
    .sort((a, b) => (a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0));
}

/**
 * Leftover resources for the coordination view: agent-owned and still running
 * while their owning session holds no live claim. Independent of the requester,
 * so the UI shows the same leftovers no matter which session asks next.
 */
export function orphanResourcesForView(
  resources: readonly AgentOwnedResource[],
  snapshot: WriteLockSnapshot,
): AgentOwnedResource[] {
  const claiming = new Set(snapshot.claims.map((claim) => claim.sessionId));
  return resources
    .filter((resource) => resource.ownerSessionId !== null && !claiming.has(resource.ownerSessionId))
    .map((resource) => ({ ...resource }))
    .sort((a, b) => (a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0));
}

function queuePositionOf(snapshot: WriteLockSnapshot, sessionId: string): number {
  const index = snapshot.waiting.findIndex((entry) => entry.sessionId === sessionId);
  return index === -1 ? snapshot.waiting.length + 1 : index + 1;
}

/** Bounded FIFO queue, one entry per session, requester never queues for itself. */
export function noteWaiting(snapshot: WriteLockSnapshot, sessionId: string, label: string): WriteLockSnapshot {
  if (snapshot.waiting.some((entry) => entry.sessionId === sessionId)) return snapshot;
  if (snapshot.waiting.length >= MAX_WAITING_SESSIONS) return snapshot;
  return { ...snapshot, waiting: [...snapshot.waiting, { sessionId, label }] };
}

function clearWaiting(snapshot: WriteLockSnapshot, sessionId: string): WriteLockSnapshot {
  if (!snapshot.waiting.some((entry) => entry.sessionId === sessionId)) return snapshot;
  return { ...snapshot, waiting: snapshot.waiting.filter((entry) => entry.sessionId !== sessionId) };
}

/**
 * The queue only means "blocked by the current holder": with a free right
 * nobody is queued, so a waiting session is shown as idle until it retries
 * (the UI has no push channel to grant the right to a queued session).
 */
function settleWaiting(snapshot: WriteLockSnapshot): WriteLockSnapshot {
  if (snapshot.waiting.length === 0 || writeLockOwner(snapshot) !== null) return snapshot;
  return { ...snapshot, waiting: [] };
}

export interface WriteClaimInput {
  sessionId: string;
  permission: PiPermission;
  intent: WriteIntent;
  /** Leftover agent-owned resources, already filtered to this requester. */
  orphans?: readonly AgentOwnedResource[];
}

export interface WriteClaimOutcome {
  snapshot: WriteLockSnapshot;
  result: WriteClaimResult;
}

/**
 * Decide and apply one claim. Fail-closed order:
 *
 * 1. a read-only session never obtains the write right (盒子 3),
 * 2. another session's live claim refuses the request and queues it (盒子 2),
 * 3. another session's leftover agent-owned resource refuses the request until
 *    it is verified/stopped (盒子 5),
 * 4. otherwise the claim is added and the owner keeps/receives the right.
 *
 * The requester's own claims need no re-check, so a nested tool inside a turn
 * does not deadlock against its own session's lock.
 */
export function claimWrite(snapshot: WriteLockSnapshot, input: WriteClaimInput): WriteClaimOutcome {
  if (input.permission === "read") {
    return { snapshot, result: { ok: false, verdict: "readonly", reason: "只读会话不持有写操作权，不获得可绕过限制的任意执行工具" } };
  }
  const owner = writeLockOwner(snapshot);
  if (owner !== null && owner !== input.sessionId) {
    const queued = noteWaiting(snapshot, input.sessionId, input.intent.label);
    return {
      snapshot: queued,
      result: {
        ok: false,
        verdict: "locked",
        owner,
        reason: `同一任务写操作权由会话 ${owner} 持有（${snapshot.claims[0]?.label ?? "进行中的写操作"}），排队等待或先中止该会话`,
        queuePosition: queuePositionOf(queued, input.sessionId),
      },
    };
  }
  const orphans = orphanResourcesFor({ resources: input.orphans ?? [], requester: input.sessionId, snapshot });
  if (orphans.length > 0) {
    return {
      snapshot,
      result: {
        ok: false,
        verdict: "locked",
        owner: orphans[0]?.ownerSessionId ?? null,
        reason: `会话 ${orphans[0]?.ownerSessionId ?? "未知"} 的遗留执行资源仍在运行（${orphans
          .map((resource) => resource.label ?? resource.resourceId)
          .join("、")}），请先核验并停止后再写入`,
        queuePosition: 1,
        orphans,
      },
    };
  }
  if (snapshot.claims.length >= MAX_CLAIMS) {
    return { snapshot, result: { ok: false, verdict: "locked", owner, reason: "写操作声明过多，请先结束当前执行", queuePosition: 1 } };
  }
  const claimId = `claim-${snapshot.claims.length + 1}-${input.sessionId}`;
  const claim: WriteClaim = { claimId, sessionId: input.sessionId, kind: input.intent.kind, label: input.intent.label };
  const granted: WriteLockSnapshot = { ...snapshot, claims: [...snapshot.claims, claim] };
  // Gaining the right removes the session's own queue entry (it is no longer
  // blocked) while other sessions stay queued behind it.
  return { snapshot: clearWaiting(granted, input.sessionId), result: { ok: true, claimId } };
}

/**
 * Release one claim. The write right ends only when the releasing session has
 * no other claim **and** no derived execution left: a settled turn while a
 * child process runs keeps the right (盒子 4), and the queue entry of a session
 * that got the right is cleared.
 */
export function releaseWrite(snapshot: WriteLockSnapshot, claimId: string): WriteLockRelease {
  const claim = snapshot.claims.find((item) => item.claimId === claimId);
  if (!claim) return { snapshot, releasedOwner: null };
  const claims = snapshot.claims.filter((item) => item.claimId !== claimId);
  const sessionId = claim.sessionId;
  let next: WriteLockSnapshot = { ...snapshot, claims };
  if (claims.some((item) => item.sessionId === sessionId)) {
    return { snapshot: next, releasedOwner: null, retained: { sessionId, reason: "in-flight-claim" } };
  }
  if (next.derived.some((item) => item.sessionId === sessionId)) {
    return { snapshot: next, releasedOwner: null, retained: { sessionId, reason: "derived-execution" } };
  }
  next = settleWaiting(clearWaiting(next, sessionId));
  return { snapshot: next, releasedOwner: sessionId };
}

/**
 * Record a derived execution that outlives its originating claim. It keeps the
 * session as the write-lock owner until `endDerivedExecution` is called, so a
 * new session cannot start writing while the child process still writes.
 */
export function claimDerivedExecution(
  snapshot: WriteLockSnapshot,
  input: DerivedExecutionClaim,
): { snapshot: WriteLockSnapshot; ok: boolean } {
  if (snapshot.derived.length >= MAX_DERIVED) return { snapshot, ok: false };
  if (snapshot.derived.some((item) => item.resourceId === input.resourceId)) return { snapshot, ok: false };
  return { snapshot: { ...snapshot, derived: [...snapshot.derived, { ...input }] }, ok: true };
}

/** End a derived execution; the right ends when nothing else holds it. */
export function endDerivedExecution(snapshot: WriteLockSnapshot, resourceId: string): WriteLockRelease {
  const derived = snapshot.derived.find((item) => item.resourceId === resourceId);
  if (!derived) return { snapshot, releasedOwner: null };
  const next: WriteLockSnapshot = { ...snapshot, derived: snapshot.derived.filter((item) => item.resourceId !== resourceId) };
  const sessionId = derived.sessionId;
  if (next.claims.some((item) => item.sessionId === sessionId) || next.derived.some((item) => item.sessionId === sessionId)) {
    return { snapshot: next, releasedOwner: null, retained: { sessionId, reason: "derived-execution" } };
  }
  return { snapshot: settleWaiting(clearWaiting(next, sessionId)), releasedOwner: sessionId };
}

/** Drop everything a session held (cancel/stop): claims, derived entries, queue slot. */
export function forgetSession(snapshot: WriteLockSnapshot, sessionId: string): WriteLockRelease {
  const heldClaims = snapshot.claims.filter((item) => item.sessionId === sessionId);
  const heldDerived = snapshot.derived.filter((item) => item.sessionId === sessionId);
  const next: WriteLockSnapshot = {
    claims: snapshot.claims.filter((item) => item.sessionId !== sessionId),
    derived: snapshot.derived.filter((item) => item.sessionId !== sessionId),
    waiting: snapshot.waiting.filter((item) => item.sessionId !== sessionId),
  };
  return {
    snapshot: settleWaiting(next),
    releasedOwner: heldClaims.length > 0 || heldDerived.length > 0 ? sessionId : null,
  };
}

/**
 * Coordination view for the session navigation: holder + claim label, the queue
 * with positions, read-only sessions, live derived executions and leftover
 * resources. Sessions are the union of the coordinator's own sessions and the
 * caller's list, sorted by id so the view is stable while a turn changes state.
 */
export function writeLockView(input: {
  snapshot: WriteLockSnapshot;
  sessions: readonly { sessionId: string; permission: PiPermission; runState: string }[];
  orphans?: readonly AgentOwnedResource[];
}): WriteLockView {
  const owner = writeLockOwner(input.snapshot);
  const ownerClaim = input.snapshot.claims.find((claim) => claim.sessionId === owner);
  const known = new Map<string, { sessionId: string; permission: PiPermission; runState: string }>();
  for (const session of input.sessions) known.set(session.sessionId, session);
  for (const claim of input.snapshot.claims) {
    if (!known.has(claim.sessionId)) known.set(claim.sessionId, { sessionId: claim.sessionId, permission: "default", runState: "unknown" });
  }
  for (const entry of input.snapshot.derived) {
    if (!known.has(entry.sessionId)) known.set(entry.sessionId, { sessionId: entry.sessionId, permission: "default", runState: "unknown" });
  }
  for (const entry of input.snapshot.waiting) {
    if (!known.has(entry.sessionId)) known.set(entry.sessionId, { sessionId: entry.sessionId, permission: "default", runState: "unknown" });
  }
  const sessions: WriteSessionView[] = [...known.values()]
    .map((session) => {
      const waitingIndex = input.snapshot.waiting.findIndex((entry) => entry.sessionId === session.sessionId);
      const role: WriteSessionRole =
        session.sessionId === owner
          ? "owner"
          : waitingIndex !== -1
            ? "waiting"
            : session.permission === "read"
              ? "readonly"
              : "idle";
      return {
        sessionId: session.sessionId,
        role,
        permission: session.permission,
        runState: session.runState,
        ...(role === "owner" && ownerClaim ? { label: ownerClaim.label } : {}),
        ...(role === "waiting" && waitingIndex !== -1
          ? { label: input.snapshot.waiting[waitingIndex]?.label, queuePosition: waitingIndex + 1 }
          : {}),
      };
    })
    .sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  return {
    owner,
    waiting: input.snapshot.waiting.map((entry) => entry.sessionId),
    readonly: sessions.filter((session) => session.role === "readonly").map((session) => session.sessionId),
    derived: input.snapshot.derived.map((item) => ({ ...item })),
    orphans: (input.orphans ?? []).map((resource) => ({ ...resource })),
    sessions,
  };
}

/** Refusal text a caller returns to the renderer (keeps the `task-locked` prefix). */
export function writeClaimError(result: Extract<WriteClaimResult, { ok: false }>): string {
  if (result.verdict === "readonly") return result.reason;
  return `task-locked: ${result.reason}`;
}

/**
 * The port the Host-driven sequences (`service-control.ts`,
 * `browser-control.ts`) use: claim before acting, release after. Structural, so
 * `TaskWorkspaceHost` satisfies it and a test can drive a coordinator directly.
 */
export interface WriteCoordinatorPort {
  claimWrite(sessionId: string, permission: PiPermission, intent: WriteIntent): WriteClaimResult;
  releaseWrite(claimId: string): WriteLockRelease;
}

/**
 * One task's write coordination state. `liveResources` is the probe that
 * answers "which agent-owned resources are still running?" (the Host wires it
 * to its service runtime); the default probe knows of none, which keeps the
 * pure tests deterministic.
 */
export class TaskWriteCoordinator implements WriteCoordinatorPort {
  private state: WriteLockSnapshot = emptyWriteLock();

  constructor(private readonly liveResources: () => readonly AgentOwnedResource[] = () => []) {}

  get owner(): string | null {
    return writeLockOwner(this.state);
  }

  snapshot(): WriteLockSnapshot {
    return writeLockSnapshot(this.state);
  }

  /** Live agent-owned resources another session would collide with. */
  orphansFor(sessionId: string): AgentOwnedResource[] {
    return orphanResourcesFor({ resources: this.liveResources(), requester: sessionId, snapshot: this.state });
  }

  claimWrite(sessionId: string, permission: PiPermission, intent: WriteIntent): WriteClaimResult {
    const outcome = claimWrite(this.state, { sessionId, permission, intent, orphans: this.liveResources() });
    this.state = outcome.snapshot;
    return outcome.result;
  }

  releaseWrite(claimId: string): WriteLockRelease {
    const outcome = releaseWrite(this.state, claimId);
    this.state = outcome.snapshot;
    return outcome;
  }

  claimDerivedExecution(input: DerivedExecutionClaim): boolean {
    const outcome = claimDerivedExecution(this.state, input);
    this.state = outcome.snapshot;
    return outcome.ok;
  }

  endDerivedExecution(resourceId: string): WriteLockRelease {
    const outcome = endDerivedExecution(this.state, resourceId);
    this.state = outcome.snapshot;
    return outcome;
  }

  /** Cancel/stop: drop every claim, derived entry and queue slot of a session. */
  forgetSession(sessionId: string): WriteLockRelease {
    const outcome = forgetSession(this.state, sessionId);
    this.state = outcome.snapshot;
    return outcome;
  }

  reset(): void {
    this.state = emptyWriteLock();
  }

  view(input: {
    sessions: readonly { sessionId: string; permission: PiPermission; runState: string }[];
    orphans?: readonly AgentOwnedResource[];
  }): WriteLockView {
    const orphans = input.orphans ?? orphanResourcesForView(this.liveResources(), this.state);
    return writeLockView({ snapshot: this.state, sessions: input.sessions, orphans });
  }
}
