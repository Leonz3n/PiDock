/**
 * Per-task-workspace Host orchestration for [PiDock 02] (#5), S2 slice.
 *
 * A `TaskWorkspaceHost` serves exactly one task folder inside the
 * utilityProcess Node Host. It owns:
 *
 * - the task record (provision writes `task.json` under the task dir),
 * - one `PiSessionChannel` per session id, restored from disk when present
 *   and persisted after every turn/approval/cancel so reopen restores the
 *   designated session (never another task's latest),
 * - the Host-owned task write lock shared across sessions of this task:
 *   at most one session holds it; a second concurrent session is rejected
 *   with `task-locked` (the renderer-module lock only mirrors this).
 *
 * The class is transport-free: `host.ts` maps `host/task` ops onto it, and
 * unit tests inject an in-memory store instead of the filesystem.
 */

import { PiSessionChannel, type PiPermission, type PiReportedUsage, type PiRunState, type PiSessionSnapshot, type PiTurnInput, type PiModelSwitchEvent, type PiSessionContextView, type PiUsageSource } from "../main/pi-session.js";
import {
  TaskExecutionLedger,
  type ExecutionStateReadout,
} from "./execution-ledger.js";
import type { ExecutionAttentionItem, ExecutionState, ServiceRunObservation } from "../main/execution-ledger.js";
import {
  TaskWriteCoordinator,
  writeClaimError,
  type AgentOwnedResource,
  type DerivedExecutionClaim,
  type WriteIntent,
  type WriteLockView,
} from "./write-coordination.js";
import {
  SharedPathCoordinator,
  classifyRealPath,
  normalizeScopePath,
  pathScopeOverlaps,
  sharedPathClaimError,
  type AllowedPathScope,
  type PathScopeVerdict,
  type SharedRoot,
} from "./path-coordination.js";
import { validateProviderProfile, type ProviderProfileRow } from "../main/provider-config.js";
import {
  buildTaskBranch,
  isTaskDirId,
  pinBaseline,
  planWorktreeCreation,
  previewTaskPaths,
  assertProvisionPlanSafe,
  resolveTaskRoot,
  validateTaskName,
  type ProvisionPlan,
} from "../main/task-provision.js";
import {
  checkLinkNameCollisions,
  checkRepoConflicts,
  classifyLinkTarget,
  filterAppendRepos,
  pinRepoBaselines,
  previewMixedTaskPaths,
  snapshotPlainDirLink,
  validateRepoSelections,
  type MultiRepoError,
  type PlainDirLinkSnapshot,
  type PinnedRepoBaseline,
  type RepoSelection,
} from "../main/multi-repo-provision.js";
import {
  buildTaskDiskRecord,
  deleteSessionOnDisk,
  listSessionIdsOnDisk,
  parseExecutionLedger,
  readExecutionLedgerOnDisk,
  readLifecycleOnDisk,
  readSessionSnapshotOnDisk,
  readTaskRecordOnDisk,
  readUsageOnDisk,
  serializeExecutionLedger,
  serializeUsageLedger,
  writeExecutionLedgerOnDisk,
  writeLifecycleOnDisk,
  writeSessionSnapshotOnDisk,
  writeTaskRecordOnDisk,
  writeUsageOnDisk,
  type LifecycleRecord,
  type TaskDiskRecord,
} from "./task-store.js";
import { emptyExecutionLedger, type ExecutionLedgerRecord } from "../main/execution-ledger.js";
import {
  PI_USAGE_GROUP_LABELS,
  UNVERSIONED_PROVIDER_CONFIG,
  USAGE_DEFINITIONS,
  applyRecordedUsageCleanup,
  applyUsageCleanup,
  dedupeInheritedUsage,
  describeUsageCleanupScope,
  filterUsageDetails,
  groupUsageDetails,
  mergeUsageDetails,
  normalizeReportedUsage,
  resolveUsageWindow,
  sumUsageDetails,
  toUsageDetail,
  unparsableUsageTimes,
  type PiUsageCleanupScope,
  type PiUsageDetail,
  type PiUsageFilter,
  type PiUsageGroup,
  type PiUsageGroupBy,
  type PiUsageTotals,
} from "../main/usage-ledger.js";

export interface TaskStore {
  readTask(taskDir: string): TaskDiskRecord | null;
  writeTask(taskDir: string, record: TaskDiskRecord): void;
  readSession(taskDir: string, sessionId: string): PiSessionSnapshot | null;
  writeSession(taskDir: string, snapshot: PiSessionSnapshot): void;
  listSessions(taskDir: string): string[];
  /** [PiDock 14] #17: cleanup removes one session snapshot (archiving never does). */
  deleteSession(taskDir: string, sessionId: string): void;
  /** [PiDock 12] #12: persisted usage ledger of this task. */
  readUsage(taskDir: string): { details: PiUsageDetail[]; exclusions: PiUsageCleanupScope[] };
  writeUsage(taskDir: string, details: readonly PiUsageDetail[], exclusions: readonly PiUsageCleanupScope[]): void;
  /** [PiDock 14] #17: archive/cleanup state and receipts. */
  readLifecycle(taskDir: string): LifecycleRecord | null;
  writeLifecycle(taskDir: string, record: LifecycleRecord): void;
  /** [PiDock 17] #19: execution/step/attempt/approval records + read marks. */
  readExecutions(taskDir: string): ExecutionLedgerRecord;
  writeExecutions(taskDir: string, ledger: ExecutionLedgerRecord): void;
}

/**
 * True when `target` (absolute or task-relative one-hop readlink result)
 * resolves to the task folder itself or a path under it. Callers MUST
 * treat a `true` result as loop-risk: creating a link whose target lives
 * inside the task folder would recurse. Pure string comparison on
 * slash-normalized, trailing-separator-stripped paths (same normalization
 * as `classifyLinkTarget`), so a relative readlink result like
 * `../task-abcdef12/evil` resolves against the task's parent first.
 */
export function isPathInsideTask(target: string | null, taskDir: string): boolean {
  if (typeof target !== "string" || target.trim().length === 0) return false;
  const normalize = (value: string): string => value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const raw = target.trim().replace(/\\/g, "/");
  const parent = taskDir.trim().replace(/\\/g, "/").replace(/\/+$/, "").split("/").slice(0, -1).join("/");
  const absolute = raw.startsWith("/") || /^[A-Za-z]:\//.test(raw) ? raw : `${parent}/${raw}`;
  const parts: string[] = [];
  for (const segment of absolute.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  const resolved = (absolute.startsWith("/") ? "/" : "") + parts.join("/");
  const task = normalize(taskDir);
  return resolved === task || resolved.startsWith(`${task}/`);
}

/**
 * Real path of a possibly not-yet-existing path: fs `realpath` of the deepest
 * existing ancestor plus the remaining segments. Lazily imported so the Host
 * stays transport-free for tests that inject their own resolver.
 */
function defaultRealPath(path: string): string {
  const { existsSync, realpathSync } = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const { basename, dirname } = process.getBuiltinModule("node:path") as typeof import("node:path");
  const suffix: string[] = [];
  let current = path.trim();
  while (current.length > 0 && !existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    suffix.unshift(basename(current));
    current = parent;
  }
  let resolved = current;
  try {
    resolved = realpathSync(current);
  } catch {
    resolved = current;
  }
  return suffix.length > 0 ? `${resolved.replace(/[\\/]+$/, "")}/${suffix.join("/")}` : resolved;
}

/**
 * The same cleanup scope with the ledger keys it removed, rebuilt per variant
 * so the union stays exact (`PiUsageCleanupScope` is the wire shape).
 */
function withRemovedIds(scope: PiUsageCleanupScope, removedIds: readonly string[]): PiUsageCleanupScope {
  if (scope.kind === "all") return { kind: "all", removedIds };
  if (scope.kind === "session") return { kind: "session", sessionId: scope.sessionId, removedIds };
  return { kind: "before", before: scope.before, removedIds };
}

export const diskTaskStore: TaskStore = {
  readTask: (taskDir) => readTaskRecordOnDisk(taskDir),
  writeTask: (taskDir, record) => writeTaskRecordOnDisk(taskDir, record),
  readSession: (taskDir, sessionId) => readSessionSnapshotOnDisk(taskDir, sessionId),
  writeSession: (taskDir, snapshot) => writeSessionSnapshotOnDisk(taskDir, snapshot),
  listSessions: (taskDir) => listSessionIdsOnDisk(taskDir),
  deleteSession: (taskDir, sessionId) => deleteSessionOnDisk(taskDir, sessionId),
  readUsage: (taskDir) => readUsageOnDisk(taskDir),
  writeUsage: (taskDir, details) => writeUsageOnDisk(taskDir, details),
  readLifecycle: (taskDir) => readLifecycleOnDisk(taskDir),
  writeLifecycle: (taskDir, record) => writeLifecycleOnDisk(taskDir, record),
  readExecutions: (taskDir) => readExecutionLedgerOnDisk(taskDir),
  writeExecutions: (taskDir, ledger) => writeExecutionLedgerOnDisk(taskDir, ledger),
};

export function memoryTaskStore(): TaskStore & {
  tasks: Map<string, TaskDiskRecord>;
  sessions: Map<string, PiSessionSnapshot>;
  usage: Map<string, { details: PiUsageDetail[]; exclusions: PiUsageCleanupScope[] }>;
  lifecycle: Map<string, LifecycleRecord>;
  executions: Map<string, ExecutionLedgerRecord>;
} {
  const tasks = new Map<string, TaskDiskRecord>();
  const sessions = new Map<string, PiSessionSnapshot>();
  const usage = new Map<string, { details: PiUsageDetail[]; exclusions: PiUsageCleanupScope[] }>();
  const lifecycle = new Map<string, LifecycleRecord>();
  const executions = new Map<string, ExecutionLedgerRecord>();
  return {
    tasks,
    sessions,
    usage,
    lifecycle,
    executions,
    readTask: (taskDir) => tasks.get(taskDir) ?? null,
    writeTask: (taskDir, record) => {
      tasks.set(taskDir, record);
    },
    readSession: (taskDir, sessionId) => sessions.get(`${taskDir}::${sessionId}`) ?? null,
    writeSession: (taskDir, snapshot) => {
      sessions.set(`${taskDir}::${snapshot.sessionId}`, snapshot);
    },
    deleteSession: (taskDir, sessionId) => {
      sessions.delete(`${taskDir}::${sessionId}`);
    },
    listSessions: (taskDir) =>
      [...sessions.keys()]
        .filter((key) => key.startsWith(`${taskDir}::`))
        .map((key) => key.slice(taskDir.length + 2))
        .sort(),
    readUsage: (taskDir) => {
      const ledger = usage.get(taskDir);
      return ledger === undefined
        ? { details: [], exclusions: [] }
        : { details: ledger.details.map((detail) => ({ ...detail, usage: { ...detail.usage } })), exclusions: ledger.exclusions.map((scope) => ({ ...scope })) };
    },
    writeUsage: (taskDir, details, exclusions) => {
      usage.set(taskDir, {
        details: details.map((detail) => ({ ...detail, usage: { ...detail.usage } })),
        exclusions: exclusions.map((scope) => ({ ...scope })),
      });
    },
    readLifecycle: (taskDir) => lifecycle.get(taskDir) ?? null,
    writeLifecycle: (taskDir, record) => {
      lifecycle.set(taskDir, { ...record, recovery: record.recovery.map((entry: LifecycleRecord["recovery"][number]) => ({ ...entry })) });
    },
    // Round-tripped through the disk shape so the memory store cannot accept a
    // record the real store would refuse (parity with the other mirrors).
    readExecutions: (taskDir) => {
      const ledger = executions.get(taskDir);
      return ledger === undefined ? emptyExecutionLedger() : parseExecutionLedger(serializeExecutionLedger(ledger));
    },
    writeExecutions: (taskDir, ledger) => {
      executions.set(taskDir, parseExecutionLedger(serializeExecutionLedger(ledger)));
    },
  };
}

export interface ProvisionTaskInput {
  name: string;
  dirId: string;
  branch?: string;
  rootOverride?: string;
  remoteBranch: string;
  fetchedCommit: string;
  repos?: readonly string[];
  /**
   * [PiDock 03] (#6) per-repo sources: each repo names its own remote +
   * baseline branch. When present and non-empty, the Host pins every repo
   * (all-success gate) and persists `repoSources` on the task record.
   * The legacy single `remoteBranch`/`fetchedCommit` above stays as the
   * task's primary baseline for backward compatibility.
   */
  repoSelections?: readonly RepoSelection[];
  /**
   * [PiDock 03] (#6) plain-directory entries: `{ directoryId, sourcePath }`
   * pairs snapshotted into `dirLinks` on the task record. Links are shared
   * views of the originals (writes modify the original), never copies.
   */
  plainDirs?: readonly { directoryId: string; sourcePath: string }[];
  /**
   * Per-repo source checkout the git ops run in (fetch/branch/worktree
   * `cwd`). `provision()` validates each entry with
   * `planWorktreeCreation` (which rejects relative/empty cwds), so
   * unknown keys and unchecked cwds fail closed instead of executing in
   * the Host cwd. When absent, `provision()` defaults the cwd to the
   * validated task root; the returned plan is still not executed by the
   * Host (S2 returns the plan and persists the record only).
   */
  mainCheckouts?: Readonly<Record<string, string>>;
  /**
   * [PiDock 03] (#6) per-repo fetched commits keyed by `repoDir`, used
   * with `repoSelections` for the all-success pin gate. Absent entries
   * are `fetch-failed`: one missing fetch must never silently cross-use
   * another repo's commit or the task-level `fetchedCommit`.
   */
  fetchedCommits?: Readonly<Record<string, string>>;
  now?: string;
}

export interface ProvisionTaskResult {
  record: TaskDiskRecord;
  plan: ProvisionPlan;
}

export interface HostTurnResult {
  state: string;
  callId: string;
  approvalId?: string;
  /** Gated tool awaiting approval (present only when `state` is `approval`). */
  tool?: string;
  /** Approval target (present only when `state` is `approval`). */
  target?: string;
  /** Payload version the confirmation was minted for ([PiDock 17] #19 box 3). */
  contentVersion?: string;
  /** Send-record association: user input + agent reply message ids. */
  userMessageId: string;
  agentMessageId: string;
}

/** What the ledger's terminal states read as in an approve refusal message. */
const SETTLED_APPROVAL_LABEL: Partial<Record<ExecutionState, string>> = {
  expired: "过期",
  rejected: "拒绝",
  stopped: "停止",
  failed: "失败",
  done: "处理",
};

function parentDirOf(taskDir: string): string {
  const trimmed = taskDir.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index > 0 ? trimmed.slice(0, index) : trimmed;
}

function maxMessageSequence(messages: { id: string }[]): number {
  let max = 0;
  for (const message of messages) {
    const match = /^msg-(\d+)$/.exec(message.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

/**
 * One session's coordination readout ([PiDock 09] #11): the state the session
 * navigation shows (permission tier, run state, pending confirmation, last
 * activity) without opening the whole conversation.
 */
export interface HostSessionState {
  sessionId: string;
  permission: PiPermission;
  runState: PiRunState;
  updatedAt: string;
  pendingApproval: boolean;
  hasDraft: boolean;
}

export interface HostWriteState {
  /** Who holds the write right, who queues, who is read-only. */
  write: WriteLockView;
  sessions: HostSessionState[];
  /** Agent-owned resources still running without a live claim. */
  orphans: AgentOwnedResource[];
  derived: DerivedExecutionClaim[];
}

/**
 * One Host instance serves one task folder. `taskId` is fixed at
 * construction (main binds it from the trusted sender); ops naming any
 * other task are rejected with `task-unknown` instead of continuing with
 * that task.
 */
export interface HostApprovalListing {
  id: string;
  callId: string;
  taskId: string;
  sessionId: string;
  tool: string;
  target: string;
  permissionAtRequest: string;
  contentVersion: string;
  status: string;
  executed: boolean;
}

/**
 * Result of one attempt's shared real-path claim: what it added plus the keys
 * the session already held. A failed attempt releases exactly its addition and
 * keeps `heldBefore` — the post-claim read is unusable for that, because
 * `SharedPathCoordinator.claim` reduces overlapping keys to the outermost one
 * (an ancestor target would replace a finer held key and leave nothing to keep).
 */
interface ClaimedPathScope {
  /** Keys this claim added; empty when the held keys already covered the target. */
  added: readonly string[];
  /** Keys the session held before this claim. */
  heldBefore: readonly string[];
}

export class TaskWorkspaceHost {
  private readonly channels = new Map<string, PiSessionChannel>();
  /**
   * [PiDock 09] (#11) task-scoped write coordination: at most one session holds
   * the write right, reads are never blocked, and a derived execution keeps the
   * right after its turn settles. `liveResources` is the probe for agent-owned
   * resources that outlived their session (wire it to the service runtime).
   */
  private readonly write: TaskWriteCoordinator;
  /** Write claims kept by turns that settled into an approval wait. */
  private readonly approvalClaims = new Map<string, string>();
  /**
   * [PiDock 17] (#19) persistent execution ledger of this task: one record per
   * turn/compaction with its steps, per-attempt usage keys, the confirmation it
   * waits on and the attention read marks. Loaded once per Host instance, which
   * settles whatever the previous process left in flight (盒子 6).
   */
  private readonly executions: TaskExecutionLedger;
  /**
   * Redacted provider catalog ([PiDock 11] #9): ids/names/protocols/model
   * declarations pushed by main. Never carries an auth reference: the Host
   * validates selections against it while credentials stay in the app layer.
   */
  private catalog: ProviderProfileRow[] = [];

  constructor(
    readonly taskId: string,
    readonly taskDir: string,
    readonly store: TaskStore = diskTaskStore,
    private readonly now: () => string = () => new Date().toISOString(),
    liveResources: () => readonly AgentOwnedResource[] = () => [],
    /**
     * [PiDock 09] (#11) cross-task real-path coordination. One instance is
     * shared by every task Host of the app (wired in `host.ts`); a standalone
     * Host gets its own, which is enough for one task.
     */
    private readonly sharedPaths: SharedPathCoordinator = new SharedPathCoordinator(),
    /**
     * Resolve a path to its real path (fs `realpath` of the deepest existing
     * ancestor + the remaining segments). Injectable so tests never touch the
     * filesystem and so "link retargeted" is expressed as a probe result.
     */
    private readonly resolveRealPath: (path: string) => string = defaultRealPath,
  ) {
    if (taskId.trim().length === 0) throw new Error("taskId must be non-empty");
    if (taskDir.trim().length === 0) throw new Error("taskDir must be non-empty");
    this.write = new TaskWriteCoordinator(liveResources);
    this.executions = new TaskExecutionLedger(taskId, taskDir, store, now);
  }

  /**
   * [PiDock 09] (#11) the task's shared plain-directory roots, resolved now.
   * `sourcePath` is the recorded link target, `realPath` the fs answer: a
   * retargeted link moves the root, which is exactly what the real-path rule
   * must see (`#6` plain dirs are shared views, never copies).
   */
  sharedRoots(): SharedRoot[] {
    const record = this.store.readTask(this.taskDir);
    return (record?.dirLinks ?? []).map((link) => ({
      directoryId: link.directoryId,
      sourcePath: link.sourcePath,
      realPath: this.resolveRealPath(link.sourcePath),
    }));
  }

  /**
   * Validate one requested target on its **real** path: inside the task folder,
   * inside one of its shared plain-directory roots, or `outside` (refused).
   * Relative targets resolve against the task folder.
   */
  pathScopeOf(target: string): PathScopeVerdict {
    const requested = target.trim();
    const absolute = requested.startsWith("/") || /^[A-Za-z]:[\\/]/.test(requested);
    const real = this.resolveRealPath(absolute ? requested : `${this.taskDir.replace(/[\\/]+$/, "")}/${requested}`);
    return classifyRealPath({ resolvedPath: real, taskDir: this.resolveRealPath(this.taskDir), roots: this.sharedRoots() });
  }

  /**
   * Lexical (no fs) containment in the task folder, the same normalization the
   * session tool gate uses. Tells the two `outside` cases apart: a target the
   * gate already refuses (no claim worth taking) versus a target that looks
   * in-task but resolves elsewhere.
   */
  private lexicallyInTask(target: string): boolean {
    const requested = target.trim();
    const absolute = requested.startsWith("/") || /^[A-Za-z]:[\\/]/.test(requested);
    const lexical = normalizeScopePath(absolute ? requested : `${this.taskDir.replace(/[\\/]+$/, "")}/${requested}`);
    return pathScopeOverlaps(lexical, normalizeScopePath(this.taskDir));
  }

  /**
   * Claim the shared real-path keys of one side-effecting target, if the target
   * lives in a shared plain directory. Task-private paths claim nothing: two
   * tasks always have distinct worktree paths, so they stay parallel (盒子 6).
   * Returns the keys **this claim added** plus the keys held before it (a
   * target already covered by the session's holder adds nothing), so a failed
   * attempt can release exactly its own keys and leave the keys an open
   * confirmation still holds.
   */
  private claimPathScope(input: { sessionId: string; label: string; scope: AllowedPathScope }): ClaimedPathScope {
    if (input.scope.kind === "task") return { added: [], heldBefore: [] };
    const heldBefore = this.sessionPathKeys(input.sessionId);
    const claim = this.sharedPaths.claim({
      taskId: this.taskId,
      sessionId: input.sessionId,
      label: `${input.label}（共享目录 ${input.scope.directoryId}）`,
      paths: [input.scope.key],
    });
    if (!claim.ok) throw new Error(sharedPathClaimError(claim));
    return { added: claim.keys.filter((key) => !heldBefore.includes(key)), heldBefore };
  }

  /** Shared real-path keys one session of this task currently holds. */
  private sessionPathKeys(sessionId: string): string[] {
    return this.sharedPaths.snapshot().find((entry) => entry.taskId === this.taskId && entry.sessionId === sessionId)?.keys ?? [];
  }

  /** Derived executions of one session that still hold the write right. */
  private liveDerivedExecutionIds(sessionId: string): string[] {
    return this.write.snapshot().derived.filter((entry) => entry.sessionId === sessionId).map((entry) => entry.resourceId);
  }

  /** Release one session's shared path keys, keeping those a live derived execution still writes. */
  private releasePathScope(sessionId: string): void {
    this.sharedPaths.release({ taskId: this.taskId, sessionId, keepDerivedExecutionIds: this.liveDerivedExecutionIds(sessionId) });
  }

  /**
   * Release only the keys one attempt added, keeping the session's other keys
   * ([PiDock 09] #11): an open confirmation keeps holding its keys, so a later
   * failed attempt of the same session must not free the same original path
   * for other tasks. The kept keys are the pre-claim ones, so a target that is
   * an ancestor of a held key still releases to the finer key it replaced.
   */
  private releaseClaimedPathScope(sessionId: string, claimed: ClaimedPathScope): void {
    if (claimed.added.length === 0) return;
    this.sharedPaths.release({
      taskId: this.taskId,
      sessionId,
      keepPaths: claimed.heldBefore,
      keepDerivedExecutionIds: this.liveDerivedExecutionIds(sessionId),
    });
  }

  /** Session currently holding the Host-owned task write right, if any. */
  get writeLockOwner(): string | null {
    return this.write.owner;
  }

  /** Claim the write right for one side-effecting intent (fail-closed). */
  claimWrite(sessionId: string, permission: PiPermission, intent: WriteIntent) {
    return this.write.claimWrite(sessionId, permission, intent);
  }

  releaseWrite(claimId: string) {
    return this.write.releaseWrite(claimId);
  }

  /**
   * Record a derived execution (child process / sub-agent) that must keep the
   * write right after its turn settles ([PiDock 09] #11 box 4). Real spawning is
   * a later slice; the rule and its state are what this slice owes.
   */
  claimDerivedExecution(input: DerivedExecutionClaim): boolean {
    const channel = this.channels.get(input.sessionId);
    if (!channel) throw new Error(`unknown-session: ${input.sessionId} 尚未打开，不能声明派生执行`);
    if (channel.currentPermission === "read") throw new Error("只读会话不持有写操作权，不能声明派生执行");
    return this.write.claimDerivedExecution(input);
  }

  endDerivedExecution(resourceId: string) {
    if (resourceId.trim().length === 0) throw new Error("invalid-payload: resourceId must be a non-empty string");
    const release = this.write.endDerivedExecution(resourceId);
    // The last derived execution of a session ends the shared real-path keys it
    // was still holding (nothing is writing those paths any more).
    if (release.releasedOwner !== null) this.releasePathScope(release.releasedOwner);
    return release;
  }

  /**
   * Sessions of this task with the coordination readout the navigation shows:
   * run state, permission tier, pending confirmation, draft and last activity.
   */
  writeState(): HostWriteState {
    const ids = [...new Set([...this.channels.keys(), ...this.sessionIds()])].sort();
    const sessions: HostSessionState[] = [];
    for (const sessionId of ids) {
      const channel = this.openSession(sessionId);
      const snapshot: PiSessionSnapshot = channel.snapshot();
      sessions.push({
        sessionId,
        permission: snapshot.permission,
        runState: snapshot.runState,
        updatedAt: snapshot.updatedAt,
        pendingApproval: snapshot.approvals.some((approval) => approval.status === "pending"),
        hasDraft: snapshot.draft !== undefined,
      });
    }
    const view = this.write.view({
      sessions: sessions.map(({ sessionId, permission, runState }) => ({ sessionId, permission, runState })),
    });
    return { write: view, sessions, orphans: view.orphans, derived: view.derived };
  }

  /**
   * [PiDock 17] (#19) execution readout of one session: the session-side state of
   * its newest execution plus the **separate** service-side states (盒子 2).
   * `services` is the caller's observation of this task's services (the Host's
   * service runtime is wired in `host.ts`), so a running service never makes the
   * session read as `executing`.
   */
  executionState(sessionId: string, services: readonly ServiceRunObservation[] = []): ExecutionStateReadout {
    if (sessionId.trim().length === 0) throw new Error("invalid-payload: sessionId must be a non-empty string");
    return this.executions.state(sessionId, services);
  }

  /** Cross-project attention items of this task (盒子 5), newest pending first. */
  attention(): { taskName: string; items: ExecutionAttentionItem[] } {
    const taskName = this.store.readTask(this.taskDir)?.name ?? this.taskId;
    return { taskName, items: this.executions.attention({ taskName }) };
  }

  /**
   * Read the completed items of this task (盒子 5「读取完成清除未读」). Only unread
   * items clear; a pending/failed/expired id comes back in `kept` so the caller
   * can tell the user it still needs handling.
   */
  markAttentionRead(itemIds: readonly string[]): { cleared: string[]; kept: string[] } {
    if (!Array.isArray(itemIds)) throw new Error("invalid-payload: itemIds must be an array");
    return this.executions.markRead(itemIds);
  }

  provision(input: ProvisionTaskInput): ProvisionTaskResult {
    const named = validateTaskName(input.name);
    if (!named.ok) throw new Error(`${named.error.code}: ${named.error.message}`);
    if (!isTaskDirId(input.dirId)) {
      throw new Error("invalid-path: dirId must match task-oooooooo");
    }
    const defaultRoot = process.env["PIDOCK_DEFAULT_ROOT"] ?? parentDirOf(this.taskDir);
    const resolved = resolveTaskRoot(defaultRoot, input.rootOverride);
    if (!resolved.ok) throw new Error(`${resolved.error.code}: ${resolved.error.message}`);
    const branched = buildTaskBranch(input.dirId, input.branch);
    if (!branched.ok) throw new Error(`${branched.error.code}: ${branched.error.message}`);
    const pinned = pinBaseline(input.remoteBranch, input.fetchedCommit);
    if (!pinned.ok) throw new Error(`${pinned.error.code}: ${pinned.error.message} (form kept, retry fetch)`);
    // #6 per-repo sources (optional): validate selections, pin every repo
    // (all-success gate), persist `repoSources`. The pinned commits ride
    // `fetchedCommits` only; a missing per-repo entry is `fetch-failed`
    // (no fallback to the task-level commit, no cross-use).
    const selections = input.repoSelections !== undefined ? [...input.repoSelections] : null;
    let pinnedRepos: PinnedRepoBaseline[] | null = null;
    if (selections !== null) {
      const validated = validateRepoSelections(selections);
      if (!validated.ok) {
        const error: MultiRepoError = validated.error;
        throw new Error(`${error.code}: ${error.message} (form kept, retry fetch)`);
      }
      const fetchedCommits: Record<string, string> = {};
      for (const selection of validated.selections) {
        // No fallback to the task-level commit: with per-repo selections
        // each repo must pin its own freshly fetched commit, otherwise one
        // missing fetch would silently cross-use another repo's commit.
        const commit = input.fetchedCommits?.[selection.repoDir];
        if (typeof commit !== "string") {
          throw new Error(`fetch-failed: 仓库 ${selection.repoDir} 尚未获取基线，已保留表单，请重试获取后再创建 (form kept, retry fetch)`);
        }
        fetchedCommits[selection.repoDir] = commit;
      }
      const batch = pinRepoBaselines(validated.selections, fetchedCommits);
      if (!batch.ok) {
        const error: MultiRepoError = batch.error;
        throw new Error(`${error.code}: ${error.message} (form kept, retry fetch)`);
      }
      pinnedRepos = [...batch.pinned];
      const repoDirs = pinnedRepos.map((repo) => repo.repoDir);
      const mixed = previewMixedTaskPaths(this.taskDir, repoDirs, []);
      void mixed;
    }
    // #6 plain-dir links (optional): snapshot each entry (shared view of
    // the original, never a copy). Fail-closed per entry with the form kept.
    let linkSnapshots: PlainDirLinkSnapshot[] | null = null;
    if (input.plainDirs !== undefined) {
      // Two directory ids mapping to one link name would silently share a
      // link: fail closed instead (never auto-rename).
      const collision = checkLinkNameCollisions(input.plainDirs.map((entry) => entry.directoryId));
      if (!collision.ok) {
        throw new Error(`${collision.error.code}: ${collision.error.message} (form kept)`);
      }
      linkSnapshots = [];
      for (const entry of input.plainDirs) {
        const snap = snapshotPlainDirLink({ directoryId: entry.directoryId, sourcePath: entry.sourcePath, now: input.now ?? this.now() });
        if (!snap.ok) {
          const error: MultiRepoError = snap.error;
          throw new Error(`${error.code}: ${error.message} (form kept)`);
        }
        linkSnapshots.push(snap.snapshot);
      }
    }
    const repos = pinnedRepos !== null ? pinnedRepos.map((repo) => repo.repoDir) : [...(input.repos ?? [])];
    const paths = previewTaskPaths(resolved.root, input.dirId, repos, []);
    if (paths.taskDir !== this.taskDir) {
      throw new Error(`invalid-payload: provision paths ${paths.taskDir} do not match this Host's task dir ${this.taskDir}`);
    }
    const at = input.now ?? this.now();
    const previous = this.store.readTask(this.taskDir);
    const record = buildTaskDiskRecord({
      taskId: this.taskId,
      name: named.name,
      dirId: input.dirId,
      branch: branched.branch,
      root: resolved.root,
      taskDir: this.taskDir,
      remoteBranch: pinned.remoteBranch,
      baseCommit: pinned.commit,
      repos,
      repoSources:
        pinnedRepos !== null
          ? pinnedRepos.map((repo) => ({
              repoDir: repo.repoDir,
              remote: repo.remote,
              remoteBranch: repo.remoteBranch,
              baseCommit: repo.commit,
            }))
          : undefined,
      dirLinks:
        linkSnapshots !== null
          ? linkSnapshots.map((link) => ({
              linkName: link.linkName,
              directoryId: link.directoryId,
              sourcePath: link.sourcePath,
              snapshotAt: link.snapshotAt,
            }))
          : undefined,
      now: at,
    });
    // Re-provision bumps only `updatedAt`: the first creation time stays.
    // #6 append path: re-provision keeps previously persisted `repoSources`
    // / `dirLinks` entries not named in this call (existing baselines and
    // running state are untouched; only new repos/links are added).
    if (previous) {
      record.createdAt = previous.createdAt;
      if (pinnedRepos !== null && previous.repoSources !== undefined) {
        const incoming = new Set(pinnedRepos.map((repo) => repo.repoDir));
        const kept = previous.repoSources.filter((source) => !incoming.has(source.repoDir));
        record.repoSources = [...kept, ...(record.repoSources ?? [])];
        record.repos = [...new Set([...(previous.repos ?? []), ...record.repos])];
      }
      if (linkSnapshots !== null && previous.dirLinks !== undefined) {
        const incoming = new Set(linkSnapshots.map((link) => link.directoryId));
        const kept = previous.dirLinks.filter((link) => !incoming.has(link.directoryId));
        record.dirLinks = [...kept, ...(record.dirLinks ?? [])];
      }
      if (pinnedRepos === null && previous.repoSources !== undefined) record.repoSources = previous.repoSources;
      if (linkSnapshots === null && previous.dirLinks !== undefined) record.dirLinks = previous.dirLinks;
    }
    this.store.writeTask(this.taskDir, record);
    // Plan with real cwds via `planWorktreeCreation` (never ""): one
    // fetch/branch/worktree triple per repo, each executed in that repo's
    // main checkout directory. `planWorktreeCreation` rejects
    // relative/empty `mainCheckoutDir` values, so unchecked `mainCheckouts`
    // entries fail closed here instead of entering an executable plan.
    // The Host does NOT execute git (S2 returns the plan and persists the
    // record only); the caller executes the returned plan via
    // `assertProvisionPlanSafe` + real git. With zero repos the plan
    // carries no ops; `mainCheckoutDir` is the validated task root so the
    // plan shape never carries an empty checkout dir.
    const plan: ProvisionPlan = {
      mainCheckoutDir: resolved.root,
      ops: [],
    };
    for (const repoDir of repos) {
      const mainCheckoutDir = input.mainCheckouts?.[repoDir] ?? resolved.root;
      // #6: per-repo pinned commits win over the task-level commit so two
      // repos never share one fixed commit (no cross-use); per-repo remote
      // rides the fetch op (never hardcoded to `origin`).
      const pinnedRepo = pinnedRepos !== null ? pinnedRepos.find((repo) => repo.repoDir === repoDir) : undefined;
      const commit = pinnedRepo?.commit ?? pinned.commit;
      const remoteBranch = pinnedRepo?.remoteBranch ?? pinned.remoteBranch;
      const remote = pinnedRepo?.remote;
      const repoPlan = planWorktreeCreation({
        taskDir: this.taskDir,
        mainCheckoutDir,
        repoDir,
        remote,
        remoteBranch,
        commit,
        branch: branched.branch,
      });
      plan.ops.push(...repoPlan.ops);
    }
    assertProvisionPlanSafe(plan);
    return { record, plan };
  }

  /**
   * [PiDock 03] (#6) append: only repos not already in the task are
   * fetched/planned. Existing baselines (`repoSources`), running state
   * (write lock), and the stored root/dirId are untouched; busy sessions
   * are NOT silently rebound — the caller refreshes them at an explicit
   * boundary (the append returns the new repos for the view/Agent to pick
   * up). Returns the appended subset plus the full plan for new repos.
   */
  appendRepos(input: {
    repoSelections: readonly RepoSelection[];
    fetchedCommits: Readonly<Record<string, string>>;
    branch?: string;
    mainCheckouts?: Readonly<Record<string, string>>;
    /**
     * Caller-scanned conflict inputs (REQUIRED, never defaulted): the
     * task-dir listing + `git worktree list` scan runs caller-side;
     * omitting them would silently disable `checkRepoConflicts`, so an
     * omitted list fails closed here instead of planning against `[]`.
     */
    takenPaths?: readonly string[];
    branchesInUse?: readonly string[];
  }): { record: TaskDiskRecord; plan: ProvisionPlan; appended: string[]; skipped: string[] } {
    const stored = this.store.readTask(this.taskDir);
    if (!stored) throw new Error("unknown task: no task record; provision the task before appending");
    if (stored.taskId !== this.taskId) throw new Error("task-unknown: this Host serves a different task");
    const validated = validateRepoSelections(input.repoSelections);
    if (!validated.ok) {
      const error: MultiRepoError = validated.error;
      throw new Error(`${error.code}: ${error.message} (form kept, retry fetch)`);
    }
    const { appended, skipped } = filterAppendRepos(stored.repos, validated.selections.map((selection) => selection.repoDir));
    const fresh = validated.selections.filter((selection) => appended.includes(selection.repoDir));
    const fetched: Record<string, string> = {};
    for (const selection of fresh) {
      const commit = input.fetchedCommits[selection.repoDir];
      if (typeof commit !== "string") {
        throw new Error(`fetch-failed: 仓库 ${selection.repoDir} 尚未获取基线，已保留表单，请重试获取后再追加 (form kept, retry fetch)`);
      }
      fetched[selection.repoDir] = commit;
    }
    // All-success gate over the NEW repos only (existing baselines stay).
    const batch = pinRepoBaselines(fresh, fetched);
    if (!batch.ok) {
      const error: MultiRepoError = batch.error;
      throw new Error(`${error.code}: ${error.message} (form kept, retry fetch)`);
    }
    const branch = input.branch ?? stored.branch;
    // Fail closed when the caller omits the conflict scan: defaulting to
    // `[]` here would plan worktrees without any path/branch check.
    if (input.takenPaths === undefined || input.branchesInUse === undefined) {
      throw new Error(
        "invalid-payload: appendRepos requires caller-scanned takenPaths + branchesInUse " +
          "(task-dir listing + `git worktree list`); refusing to plan without the conflict gate",
      );
    }
    const mixed = previewMixedTaskPaths(this.taskDir, appended, []);
    const conflict = checkRepoConflicts({
      wantedWorktreeDirs: appended.map((repoDir) => mixed.worktrees[repoDir]),
      takenPaths: input.takenPaths,
      branchesInUse: input.branchesInUse,
      wantedBranch: branch,
    });
    if (!conflict.ok) {
      const error: MultiRepoError = conflict.error;
      throw new Error(`${error.code}: ${error.message}`);
    }
    const plan: ProvisionPlan = { mainCheckoutDir: stored.root, ops: [] };
    const checkouts: Record<string, string> = {};
    for (const selection of fresh) {
      checkouts[selection.repoDir] = input.mainCheckouts?.[selection.repoDir] ?? stored.root;
    }
    for (const repo of batch.pinned) {
      const repoPlan = planWorktreeCreation({
        taskDir: this.taskDir,
        mainCheckoutDir: checkouts[repo.repoDir] ?? stored.root,
        repoDir: repo.repoDir,
        // #6 per-repo remote rides the fetch op (never hardcoded).
        remote: repo.remote,
        remoteBranch: repo.remoteBranch,
        commit: repo.commit,
        branch,
      });
      plan.ops.push(...repoPlan.ops);
    }
    assertProvisionPlanSafe(plan);
    const at = this.now();
    const record = buildTaskDiskRecord({
      taskId: stored.taskId,
      name: stored.name,
      dirId: stored.dirId,
      branch: stored.branch,
      root: stored.root,
      taskDir: stored.taskDir,
      remoteBranch: stored.remoteBranch,
      baseCommit: stored.baseCommit,
      repos: [...stored.repos, ...appended],
      repoSources: [
        ...(stored.repoSources ?? []),
        ...batch.pinned.map((repo) => ({
          repoDir: repo.repoDir,
          remote: repo.remote,
          remoteBranch: repo.remoteBranch,
          baseCommit: repo.commit,
        })),
      ],
      dirLinks: stored.dirLinks !== undefined ? [...stored.dirLinks] : undefined,
      now: at,
    });
    record.createdAt = stored.createdAt;
    this.store.writeTask(this.taskDir, record);
    return { record, plan, appended, skipped };
  }

  /**
   * [PiDock 03] (#6) plain-dir link target probe (Host-side, needs fs).
   * Lexical `loop-risk`/`nested` classification lives in
   * `classifyLinkTarget` (unit-tested without fs); this probe answers the
   * remaining question: does the source still exist, and is it a symlink
   * loop back into the task? Never creates or follows links beyond one
   * `readlink` — report only, no takeover.
   */
  probeLinkTarget(sourcePath: string): {
    shape: "ok" | "dead";
    detail: string;
    /** Lexical classification (no fs): `ok`/`nested`/`loop-risk`. */
    lexical: "ok" | "nested" | "loop-risk";
    /** One-hop readlink target when `sourcePath` itself is a symlink (null otherwise). */
    linkTarget: string | null;
    /**
     * True when the one-hop readlink target resolves inside this task
     * folder: callers MUST treat it as loop-risk (a link pointing back
     * into the task would recurse on creation). Report-only, never
     * followed beyond the single `readlink` hop above.
     */
    linkTargetInTask: boolean;
  } {
    // Lazy Node fs import keeps the class transport-free for tests that
    // never probe; dynamic require is avoided (ESM) via createRequire.
    const { existsSync, lstatSync, readlinkSync } = process.getBuiltinModule("node:fs") as typeof import("node:fs");
    // Report-only: lexical shape rides the payload alongside the fs
    // answer (one `readlink` hop max, never followed beyond it).
    const lexical = classifyLinkTarget(sourcePath, this.taskDir, []);
    let linkTarget: string | null = null;
    try {
      if (lstatSync(sourcePath).isSymbolicLink()) {
        linkTarget = readlinkSync(sourcePath);
      }
    } catch {
      linkTarget = null;
    }
    const linkTargetInTask = isPathInsideTask(linkTarget, this.taskDir);
    if (!existsSync(sourcePath))
      return { shape: "dead", detail: `普通目录来源不存在: ${sourcePath}`, lexical, linkTarget, linkTargetInTask };
    return { shape: "ok", detail: "来源可用", lexical, linkTarget, linkTargetInTask };
  }

  taskRecord(): TaskDiskRecord | null {
    return this.store.readTask(this.taskDir);
  }

  sessionIds(): string[] {
    return this.store.listSessions(this.taskDir);
  }

  /**
   * Open the designated session, restoring its persisted snapshot when one
   * exists. A snapshot naming a different task is rejected: reopen never
   * continues with another task's latest session.
   */
  /** Save/refresh the unsent composer draft for a session (never auto-sent). */
  saveDraft(sessionId: string, draft: { text: string; references?: unknown[]; skillSource?: string }): void {
    const channel = this.openSession(sessionId);
    channel.saveDraft(draft);
    this.store.writeSession(this.taskDir, channel.snapshot());
  }

  clearDraft(sessionId: string): void {
    const channel = this.openSession(sessionId);
    channel.clearDraft();
    this.store.writeSession(this.taskDir, channel.snapshot());
  }

  /**
   * Current permission tier of one session **without** opening/creating it:
   * `null` when the session is neither live nor persisted. Read-only callers
   * (e.g. [PiDock 10] #15 terminal *planning*) need the tier to refuse a
   * `read` session, but must not materialize a session just to read it.
   */
  permissionOf(sessionId: string): PiPermission | null {
    const live = this.channels.get(sessionId);
    if (live) return live.currentPermission;
    const saved = this.store.readSession(this.taskDir, sessionId);
    return saved?.permission ?? null;
  }

  openSession(
    sessionId: string,
    options?: { providerId?: string; model?: string; credentialRef?: string; permission?: PiPermission },
  ): PiSessionChannel {    const existing = this.channels.get(sessionId);
    if (existing) {
      existing.setProviderCatalog(this.catalog);
      return existing;
    }
    const saved = this.store.readSession(this.taskDir, sessionId);
    if (saved) {
      if (saved.taskId !== this.taskId) {
        throw new Error("task-unknown: snapshot names a different task; refusing to continue with it");
      }
      // Restore with the current catalog: a configuration that is gone reports
      // unavailable through `contextView()` instead of rerouting the session.
      const restored = PiSessionChannel.restore(saved, this.taskDir, this.catalog);
      this.channels.set(sessionId, restored);
      return restored;
    }
    const channel = new PiSessionChannel({
      taskId: this.taskId,
      sessionId,
      taskDir: this.taskDir,
      providerId: options?.providerId ?? this.defaultProviderId(),
      model: options?.model ?? this.defaultModelId(),
      credentialRef: options?.credentialRef,
      permission: options?.permission,
      catalog: this.catalog,
      // One clock per Host: a call's `at` is the same instant the task record,
      // approvals and drafts use, instead of drifting on a second clock.
      now: this.now,
    });
    this.channels.set(sessionId, channel);
    this.store.writeSession(this.taskDir, channel.snapshot());
    return channel;
  }

  private defaultProviderId(): string {
    return this.catalog[0]?.id ?? "provider-local";
  }

  private defaultModelId(): string {
    return this.catalog[0]?.models[0]?.id ?? "pidock-default";
  }

  /**
   * Replace the redacted provider catalog. Every entry is validated with the
   * same rules as the profile form, so a malformed catalog (or one carrying an
   * auth *value* instead of a reference) fails closed instead of entering
   * session resolution.
   */
  setProviderCatalog(profiles: readonly unknown[]): ProviderProfileRow[] {
    const validated: ProviderProfileRow[] = [];
    for (const entry of profiles) {
      const result = validateProviderProfile(entry);
      if (!result.ok) {
        throw new Error(`invalid-payload: provider catalog entry rejected (${result.error.code}): ${result.error.message}`);
      }
      if (result.profile.id.length === 0) {
        throw new Error("invalid-payload: provider catalog entry needs an id");
      }
      validated.push(result.profile);
    }
    this.catalog = validated;
    for (const channel of this.channels.values()) channel.setProviderCatalog(validated);
    return validated.map((profile) => ({ ...profile, models: profile.models.map((model) => ({ ...model })) }));
  }

  providerCatalog(): ProviderProfileRow[] {
    return this.catalog.map((profile) => ({ ...profile, models: profile.models.map((model) => ({ ...model })) }));
  }

  /**
   * Switch one session's provider/model ([PiDock 11] #9). Busy rounds/tools and
   * an over-limit/unknown occupancy refuse before any state changes, so a
   * refusal leaves the original model, history and draft untouched; history
   * keeps each call's own attribution and the switch itself is logged.
   */
  setSessionModel(input: {
    sessionId: string;
    providerId: string;
    model: string;
    reason?: PiModelSwitchEvent["reason"];
    catalog?: readonly unknown[];
  }): { context: PiSessionContextView; switchEvent: PiModelSwitchEvent } {
    if (input.catalog !== undefined) this.setProviderCatalog(input.catalog);
    const channel = this.openSession(input.sessionId);
    const allowed = channel.canSwitchModel({ providerId: input.providerId, model: input.model });
    if (!allowed.ok) {
      const { code, message } = allowed.refusal;
      throw new Error(`${code}: ${message}`);
    }
    const switchEvent = channel.applyModelSwitch({
      providerId: input.providerId,
      model: input.model,
      reason: input.reason ?? "human-switch",
    });
    this.store.writeSession(this.taskDir, channel.snapshot());
    return { context: channel.contextView(), switchEvent };
  }

  /** Session reasoning level; an undeclared/cleared tier fails closed. */
  setSessionThinking(input: { sessionId: string; level: string; catalog?: readonly unknown[] }): PiSessionContextView {
    if (input.catalog !== undefined) this.setProviderCatalog(input.catalog);
    const channel = this.openSession(input.sessionId);
    channel.setThinkingLevel(input.level);
    this.store.writeSession(this.taskDir, channel.snapshot());
    return channel.contextView();
  }

  /** Context compaction: occupancy becomes a pending estimate, cumulative tokens stay. */
  compactSession(input: { sessionId: string; catalog?: readonly unknown[]; usageSource?: PiUsageSource; usage?: PiReportedUsage }): PiSessionContextView {
    if (input.catalog !== undefined) this.setProviderCatalog(input.catalog);
    const channel = this.openSession(input.sessionId);
    channel.compactContext({
      ...(input.usageSource !== undefined ? { usageSource: input.usageSource } : {}),
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
    });
    // [PiDock 17] #19 box 1: a compaction is its own execution kind, so its own
    // consumption is attributed to a compaction row (never to a turn).
    const compaction = this.executions.open({ sessionId: input.sessionId, kind: "compaction", label: "上下文压缩" });
    const call = channel.snapshot().calls[channel.snapshot().calls.length - 1];
    if (call !== undefined) {
      this.executions.linkCall(compaction.executionId, call.callId);
      this.executions.attempt(compaction.executionId, { endState: "completed", usageId: call.callId });
    }
    this.executions.complete(compaction.executionId);
    this.store.writeSession(this.taskDir, channel.snapshot());
    this.syncUsageLedger();
    return channel.contextView();
  }

  /** Provider/model identity, occupancy, tokens and reasoning readout for one session. */
  sessionContext(input: { sessionId: string; catalog?: readonly unknown[] }): PiSessionContextView {
    if (input.catalog !== undefined) this.setProviderCatalog(input.catalog);
    return this.openSession(input.sessionId).contextView();
  }

  /** Record a context reading for the switch gate (tests/turn integration). */
  recordSessionContext(input: { sessionId: string; used: number; source: "actual" | "estimated" | "pending" | "unknown" }): PiSessionContextView {
    const channel = this.openSession(input.sessionId);
    channel.recordContextUsage({ used: input.used, source: input.source });
    this.store.writeSession(this.taskDir, channel.snapshot());
    return channel.contextView();
  }

  /**
   * Build the usage details this task's persisted sessions currently hold
   * ([PiDock 12] #12). Every call record becomes its own detail; the call id
   * is the ledger key, so restoring a session re-derives the same set instead
   * of adding consumption.
   */
  private usageDetailsFromSessions(): PiUsageDetail[] {
    const details: PiUsageDetail[] = [];
    for (const sessionId of this.sessionIds()) {
      const snapshot = this.store.readSession(this.taskDir, sessionId);
      if (snapshot === null) continue;
      for (const call of snapshot.calls) {
        details.push(
          toUsageDetail({
            callId: call.callId,
            taskId: this.taskId,
            sessionId,
            providerId: call.providerId,
            providerVersion: call.providerVersion ?? UNVERSIONED_PROVIDER_CONFIG,
            requestModel: call.model,
            ...(call.responseModel !== undefined ? { responseModel: call.responseModel } : {}),
            kind: call.kind,
            endState: call.endState,
            at: call.at,
            usage: call.usage ?? normalizeReportedUsage(undefined, "unreported"),
          }),
        );
      }
    }
    return details;
  }

  /**
   * Bring the persisted ledger in line with the sessions and return it.
   * The merge is replay-safe (keyed by call id) and every recorded cleanup is
   * re-applied by the ledger keys it removed, so a legacy task backfills once,
   * a cleaned scope stays cleaned, and a call made *after* a cleanup is still
   * recorded (its key was never removed). The file is only rewritten when the
   * result actually changed.
   */
  private syncUsageLedger(): { details: PiUsageDetail[]; exclusions: PiUsageCleanupScope[] } {
    const stored = this.store.readUsage(this.taskDir);
    const merged = mergeUsageDetails(stored.details, this.usageDetailsFromSessions());
    const details = stored.exclusions.reduce((current, exclusion) => applyRecordedUsageCleanup(current, exclusion), merged);
    if (serializeUsageLedger(details, stored.exclusions) !== serializeUsageLedger(stored.details, stored.exclusions)) {
      this.store.writeUsage(this.taskDir, details, stored.exclusions);
    }
    return { details, exclusions: stored.exclusions };
  }

  /**
   * Usage detail + totals + groups for the statistics page. Totals count an
   * inherited copy once (by origin) and never fold reasoning into output or a
   * provider total into the cache counters. The window/definition metadata is
   * returned so the UI can show what it is counting instead of guessing.
   */
  usageReport(input: PiUsageFilter & { groupBy?: PiUsageGroupBy } = {}): {
    details: PiUsageDetail[];
    totals: PiUsageTotals;
    groups: PiUsageGroup[];
    window: { label: string; offsetMinutes: number };
    unparsable: string[];
    definitions: typeof USAGE_DEFINITIONS;
  } {
    const ledger = this.syncUsageLedger();
    const details = filterUsageDetails(ledger.details, input);
    const window = resolveUsageWindow(input);
    return {
      details: details.map((detail) => ({ ...detail, usage: { ...detail.usage } })),
      totals: sumUsageDetails(dedupeInheritedUsage(details)),
      groups: input.groupBy === undefined ? [] : groupUsageDetails(details, input.groupBy),
      window: { label: window.label, offsetMinutes: window.offsetMinutes },
      unparsable: unparsableUsageTimes(details),
      definitions: USAGE_DEFINITIONS,
    };
  }

  /**
   * Remove usage details in one explicit scope ([PiDock 12] #12 box 8).
   * Archiving a conversation never removes usage; only this op does, and the
   * ledger keys it removed are recorded so a later sync does not restore them
   * — and so calls made after the cleanup are still recorded.
   */
  clearUsage(scope: PiUsageCleanupScope): { removed: number; remaining: number; description: string } {
    const ledger = this.syncUsageLedger();
    const details = applyUsageCleanup(ledger.details, scope);
    const survivorIds = new Set(details.map((detail) => detail.id));
    const removedIds = ledger.details.filter((detail) => !survivorIds.has(detail.id)).map((detail) => detail.id);
    this.store.writeUsage(this.taskDir, details, [...ledger.exclusions, withRemovedIds(scope, removedIds)]);
    return { removed: removedIds.length, remaining: details.length, description: describeUsageCleanupScope(scope) };
  }

  /** Grouping dimensions the statistics page offers (labels included). */
  usageDimensions(): { id: PiUsageGroupBy; label: string }[] {
    return (Object.keys(PI_USAGE_GROUP_LABELS) as PiUsageGroupBy[]).map((id) => ({ id, label: PI_USAGE_GROUP_LABELS[id] }));
  }

  sendMessage(
    sessionId: string,
    text: string,
    turn?: Omit<PiTurnInput, "text" | "stream">,
  ): HostTurnResult {
    const channel = this.openSession(sessionId);
    // [PiDock 09] (#11) box 3: a read-only session never runs an execution
    // round; the tool gate stays the second line. Matches the shipped renderer
    // composer (disabled for `read`) and the memory mirror.
    if (channel.currentPermission === "read") {
      throw new Error("只读会话仅允许阅读分析，请先调整会话权限");
    }
    // The write right is claimed per side-effecting action, not per turn: a
    // turn with no tool plan (pure analysis) must keep running while another
    // session writes the task, which is exactly box 3's "safe read" rule.
    // Fail-closed on an unnamed plan: a turn that can run a tool at all
    // (`execute`/`target` without a `tool`) defaults to the channel's
    // `fs.write`, so it claims the right.
    const plannedTool = typeof turn?.tool === "string" ? turn.tool : undefined;
    const mayRunTool = plannedTool !== undefined || turn?.execute !== undefined || turn?.target !== undefined;
    const sideEffecting = mayRunTool && plannedTool !== "fs.read";
    // [PiDock 09] (#11) real-path scope: a side-effecting plan naming a target
    // is validated on the resolved real path before any right is claimed, so a
    // retargeted link or a path outside the task's allowed roots never writes.
    const target = typeof turn?.target === "string" && turn.target.trim().length > 0 ? turn.target : undefined;
    const scope = sideEffecting && target !== undefined ? this.pathScopeOf(target) : undefined;
    // A lexically out-of-task target is already refused by the session tool gate,
    // so no side effect can happen: the turn runs, fails and records why, and
    // nothing claims the task write right. A target that looks in-task but
    // resolves outside (retargeted link, symlink) is the case the real-path rule
    // must refuse before any right is claimed.
    const gateRefuses = scope?.kind === "outside" && !this.lexicallyInTask(target as string);
    if (scope?.kind === "outside" && !gateRefuses) throw new Error(`path-out-of-scope: ${scope.reason}`);
    const writesAnything = sideEffecting && !gateRefuses;
    let claimId: string | undefined;
    let claimedPathScope: ClaimedPathScope = { added: [], heldBefore: [] };
    if (writesAnything) {
      const claim = this.claimWrite(sessionId, channel.currentPermission, {
        kind: "turn",
        label: `回合工具 ${plannedTool ?? "fs.write"}`,
      });
      if (!claim.ok) throw new Error(writeClaimError(claim));
      claimId = claim.claimId;
      // Cross-task real-path claim: only a shared plain-directory target needs
      // one, and a conflict releases the task claim so nothing is half-held.
      if (scope !== undefined && scope.kind !== "outside") {
        try {
          claimedPathScope = this.claimPathScope({ sessionId, label: `回合工具 ${plannedTool ?? "fs.write"}`, scope });
        } catch (error) {
          this.releaseWrite(claimId);
          throw error;
        }
      }
    }
    let result: ReturnType<PiSessionChannel["runTurn"]>;
    // [PiDock 17] #19 box 1: the execution record exists before the turn runs, so
    // a turn that dies midway is still recorded with its step trail and attempt.
    const execution = this.executions.open({
      sessionId,
      kind: "turn",
      label: plannedTool !== undefined && target !== undefined ? `回合工具 ${plannedTool} ${target}` : `回合工具 ${plannedTool ?? "fs.write"}`,
    });
    const stepId = plannedTool !== undefined ? `tool-${plannedTool}` : "turn";
    this.executions.planStep(execution.executionId, {
      stepId,
      label: plannedTool !== undefined && target !== undefined ? `${plannedTool} ${target}` : "回合检查",
    });
    try {
      result = channel.runTurn({ text, ...turn });
    } catch (error) {
      // The turn never started (busy round/approval, fail-closed validation):
      // the record names the refusal instead of staying `executing` forever.
      this.executions.fail(execution.executionId, error instanceof Error ? error.message : "回合未能启动");
      if (claimId !== undefined) {
        // A failed attempt releases only what it took: the session's write
        // right may be retained by an open confirmation's claim, whose shared
        // real-path keys must stay held ([PiDock 09] #11).
        const release = this.releaseWrite(claimId);
        if (release.releasedOwner === sessionId) this.releasePathScope(sessionId);
        else this.releaseClaimedPathScope(sessionId, claimedPathScope);
      }
      throw error;
    }
    this.recordTurnOutcome(execution.executionId, stepId, result);
    // Box 4: the right is kept while the turn waits on a confirmation and is
    // released only when the turn settles; a live derived execution keeps it
    // even then (`releaseWrite` retains the owner).
    if (claimId !== undefined) {
      if (result.state === "approval") this.approvalClaims.set(sessionId, claimId);
      else {
        const release = this.releaseWrite(claimId);
        if (release.releasedOwner === sessionId) this.releasePathScope(sessionId);
        else this.releaseClaimedPathScope(sessionId, claimedPathScope);
      }
    }
    // [PiDock 12] #12: the settled turn's usage detail joins the ledger right
    // after the session snapshot is persisted (sync reads the store), so
    // archiving/cleaning the conversation later never loses the consumption
    // it already produced.
    this.store.writeSession(this.taskDir, channel.snapshot());
    this.syncUsageLedger();
    const pending = channel.pendingApproval();
    return {
      state: result.state,
      callId: result.call.callId,
      approvalId: result.approval?.id,
      tool: result.state === "approval" ? pending?.tool : undefined,
      target: result.state === "approval" ? pending?.target : undefined,
      contentVersion: result.state === "approval" ? pending?.contentVersion : undefined,
      userMessageId: result.userMessageId,
      agentMessageId: result.agentMessageId,
    };
  }

  /**
   * Turn outcome → execution record ([PiDock 17] #19): the call id binds the
   * execution to its usage row, the step settles, and the session-side state
   * moves to its terminal value (盒子 2). A waiting confirmation binds the request
   * with the payload version it was minted for (盒子 3).
   */
  private recordTurnOutcome(
    executionId: string,
    stepId: string,
    result: ReturnType<PiSessionChannel["runTurn"]>,
  ): void {
    this.executions.linkCall(executionId, result.call.callId);
    if (result.state === "approval") {
      const approval = result.approval;
      if (approval) {
        this.executions.awaitApproval(executionId, {
          approvalId: approval.id,
          payloadVersion: approval.contentVersion,
          ...(approval.scope !== undefined ? { scope: approval.scope } : {}),
        });
      }
      this.executions.attempt(executionId, { endState: "awaiting-approval", usageId: result.call.callId });
      return;
    }
    this.executions.settleStep(executionId, { stepId, state: result.state === "done" ? "done" : "failed" });
    this.executions.attempt(executionId, {
      endState: result.state === "done" ? "completed" : "failed",
      usageId: result.call.callId,
    });
    if (result.state === "done") this.executions.complete(executionId);
    else this.executions.fail(executionId, "工具调用被拒绝或失败，已完成步骤与草稿保留");
  }

  /**
   * Resolve a turn that settled into an approval wait ([PiDock 09] #11): the
   * session's kept write claim ends with approve/reject, so another session of
   * the task may write afterwards. Shared real-path keys end with it too.
   */
  private settleApprovalClaim(sessionId: string): void {
    const claimId = this.approvalClaims.get(sessionId);
    if (claimId === undefined) return;
    this.approvalClaims.delete(sessionId);
    const release = this.releaseWrite(claimId);
    if (release.releasedOwner === sessionId) this.releasePathScope(sessionId);
  }

  /**
   * Approve and execute one request ([PiDock 17] #19 box 3). The execution record
   * authorizes first — permission / deadline / payload version re-checked, the
   * confirmation spent exactly once — and only then does the turn flow run the
   * gated tool. A stale version, an expired deadline or an already-spent request
   * throws before anything executes.
   */
  approve(sessionId: string, approvalId: string, contentVersion?: string): string {
    const channel = this.openSession(sessionId);
    const waiting = this.executions.waitingOnApproval(approvalId);
    if (waiting) {
      this.executions.authorize(waiting.executionId, {
        approvalId,
        permission: channel.currentPermission,
        ...(contentVersion !== undefined ? { contentVersion } : {}),
      });
    } else {
      // A settled confirmation never reaches the session channel: the terminal
      // record drops out of `waitingOnApproval`, so without this the re-check
      // (deadline included) would be skipped and a late approve would execute.
      this.refuseSettledApproval(approvalId);
    }
    const call = channel.approve(approvalId);
    this.settleApprovalClaim(sessionId);
    this.store.writeSession(this.taskDir, channel.snapshot());
    this.syncUsageLedger();
    if (waiting) {
      this.executions.attempt(waiting.executionId, { endState: "completed", usageId: call.callId });
      this.executions.complete(waiting.executionId);
    }
    return call.callId;
  }

  /**
   * A confirmation the ledger already settled (过期/拒绝/停止/失败/处理) must refuse
   * here ([PiDock 17] #19 盒子 3/6). An approval the ledger never recorded (service,
   * terminal and browser control live on the session channel only) passes through.
   */
  private refuseSettledApproval(approvalId: string): void {
    const settled = this.executions.byApproval(approvalId);
    if (!settled) return;
    throw new Error(
      `invalid-execution-transition: 确认请求已${SETTLED_APPROVAL_LABEL[settled.state] ?? "处理"}，不能执行且不可重放`,
    );
  }

  reject(sessionId: string, approvalId: string): void {
    const channel = this.openSession(sessionId);
    channel.reject(approvalId);
    this.executions.rejectApproval(approvalId);
    this.settleApprovalClaim(sessionId);
    this.store.writeSession(this.taskDir, channel.snapshot());
    this.syncUsageLedger();
  }

  /** Forward-only permission change for future turns (never rewrites in-flight approval). */
  setPermission(sessionId: string, permission: PiPermission): void {
    const channel = this.openSession(sessionId);
    channel.setPermission(permission);
    this.store.writeSession(this.taskDir, channel.snapshot());
  }

  /**
   * Host-owned approval listing: real persisted approvals across sessions
   * of this task (open on-disk sessions on demand so a reopen lists them
   * without a live channel). `sessionId` narrows; absent = all sessions.
   * Used by the `task/listApprovals` / `task/getApproval` RPC reads.
   */
  listApprovals(sessionId?: string): HostApprovalListing[] {
    const ids = new Set<string>([...this.channels.keys(), ...this.sessionIds()]);
    const out: HostApprovalListing[] = [];
    for (const id of [...ids].sort()) {
      if (sessionId !== undefined && id !== sessionId) continue;
      const channel = this.openSession(id);
      for (const approval of channel.snapshot().approvals) {
        out.push({ ...approval });
      }
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  getApproval(approvalId: string): HostApprovalListing | undefined {
    if (approvalId.trim().length === 0) throw new Error("invalid-payload: approvalId must be a non-empty string");
    return this.listApprovals().find((approval) => approval.id === approvalId);
  }

  /**
   * Stop one session ([PiDock 09] #11 boxes 2/5): cancel the waiting turn,
   * expire its pending confirmation, and drop every write claim, derived entry
   * and queue slot it held — so no leftover process keeps the right and a new
   * session can write. Returns the coordination view after the release.
   */
  cancel(sessionId: string): HostWriteState {
    const channel = this.openSession(sessionId);
    channel.cancel();
    this.approvalClaims.delete(sessionId);
    // 盒子 6：停止覆盖派生执行（子进程/子 Agent），但不回滚已完成的步骤与尝试。
    const derived = this.write.snapshot().derived.filter((entry) => entry.sessionId === sessionId).map((entry) => entry.resourceId);
    this.write.forgetSession(sessionId);
    this.executions.stopSession(sessionId, { derive: derived });
    // 盒子 5：中止后不留共享真实路径的旧声明（派生条目已一并丢弃）。
    this.sharedPaths.release({ taskId: this.taskId, sessionId });
    this.store.writeSession(this.taskDir, channel.snapshot());
    return this.writeState();
  }

  /**
   * `maxSeq` is an in-memory diagnostic over open channels only: after
   * `dispose()` (or a fresh Host with sessions only on disk) it reports 0
   * even though persisted messages exist. Callers needing the persisted
   * count must read the snapshots via `store`/`sessionIds()`.
   */
  /** Drop in-memory channels (e.g. on Host dispose); disk state is already saved. */
  dispose(): void {
    this.channels.clear();
    this.approvalClaims.clear();
    this.write.reset();
    // With no live holder left to release them, this task's shared real-path
    // keys end here instead of blocking other tasks for the process lifetime.
    this.sharedPaths.releaseTask(this.taskId);
  }

  describe(): { taskId: string; taskDir: string; sessions: string[]; lockOwner: string | null; maxSeq: number } {
    const sessions = this.sessionIds();
    let maxSeq = 0;
    for (const sessionId of [...this.channels.keys()]) {
      const channel = this.channels.get(sessionId);
      if (channel) maxSeq = Math.max(maxSeq, maxMessageSequence(channel.snapshot().messages));
    }
    return { taskId: this.taskId, sessions, lockOwner: this.write.owner, taskDir: this.taskDir, maxSeq };
  }
}
