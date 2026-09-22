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

import { PiSessionChannel, type PiPermission, type PiSessionSnapshot, type PiTurnInput } from "../main/pi-session.js";
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
  listSessionIdsOnDisk,
  readSessionSnapshotOnDisk,
  readTaskRecordOnDisk,
  writeSessionSnapshotOnDisk,
  writeTaskRecordOnDisk,
  type TaskDiskRecord,
} from "./task-store.js";

export interface TaskStore {
  readTask(taskDir: string): TaskDiskRecord | null;
  writeTask(taskDir: string, record: TaskDiskRecord): void;
  readSession(taskDir: string, sessionId: string): PiSessionSnapshot | null;
  writeSession(taskDir: string, snapshot: PiSessionSnapshot): void;
  listSessions(taskDir: string): string[];
}

export const diskTaskStore: TaskStore = {
  readTask: (taskDir) => readTaskRecordOnDisk(taskDir),
  writeTask: (taskDir, record) => writeTaskRecordOnDisk(taskDir, record),
  readSession: (taskDir, sessionId) => readSessionSnapshotOnDisk(taskDir, sessionId),
  writeSession: (taskDir, snapshot) => writeSessionSnapshotOnDisk(taskDir, snapshot),
  listSessions: (taskDir) => listSessionIdsOnDisk(taskDir),
};

export function memoryTaskStore(): TaskStore & { tasks: Map<string, TaskDiskRecord>; sessions: Map<string, PiSessionSnapshot> } {
  const tasks = new Map<string, TaskDiskRecord>();
  const sessions = new Map<string, PiSessionSnapshot>();
  return {
    tasks,
    sessions,
    readTask: (taskDir) => tasks.get(taskDir) ?? null,
    writeTask: (taskDir, record) => {
      tasks.set(taskDir, record);
    },
    readSession: (taskDir, sessionId) => sessions.get(`${taskDir}::${sessionId}`) ?? null,
    writeSession: (taskDir, snapshot) => {
      sessions.set(`${taskDir}::${snapshot.sessionId}`, snapshot);
    },
    listSessions: (taskDir) =>
      [...sessions.keys()]
        .filter((key) => key.startsWith(`${taskDir}::`))
        .map((key) => key.slice(taskDir.length + 2))
        .sort(),
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
  /** Send-record association: user input + agent reply message ids. */
  userMessageId: string;
  agentMessageId: string;
}

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

export class TaskWorkspaceHost {
  private readonly channels = new Map<string, PiSessionChannel>();
  private lockOwner: string | null = null;

  constructor(
    readonly taskId: string,
    readonly taskDir: string,
    private readonly store: TaskStore = diskTaskStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    if (taskId.trim().length === 0) throw new Error("taskId must be non-empty");
    if (taskDir.trim().length === 0) throw new Error("taskDir must be non-empty");
  }

  /** Session currently holding the Host-owned task write right, if any. */
  get writeLockOwner(): string | null {
    return this.lockOwner;
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
    if (!existsSync(sourcePath)) return { shape: "dead", detail: `普通目录来源不存在: ${sourcePath}`, lexical, linkTarget };
    return { shape: "ok", detail: "来源可用", lexical, linkTarget };
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

  openSession(
    sessionId: string,
    options?: { providerId?: string; model?: string; credentialRef?: string; permission?: PiPermission },
  ): PiSessionChannel {
    const existing = this.channels.get(sessionId);
    if (existing) return existing;
    const saved = this.store.readSession(this.taskDir, sessionId);
    if (saved) {
      if (saved.taskId !== this.taskId) {
        throw new Error("task-unknown: snapshot names a different task; refusing to continue with it");
      }
      const restored = PiSessionChannel.restore(saved, this.taskDir);
      this.channels.set(sessionId, restored);
      return restored;
    }
    const channel = new PiSessionChannel({
      taskId: this.taskId,
      sessionId,
      taskDir: this.taskDir,
      providerId: options?.providerId ?? "provider-local",
      model: options?.model ?? "pidock-default",
      credentialRef: options?.credentialRef,
      permission: options?.permission,
    });
    this.channels.set(sessionId, channel);
    this.store.writeSession(this.taskDir, channel.snapshot());
    return channel;
  }

  sendMessage(
    sessionId: string,
    text: string,
    turn?: Omit<PiTurnInput, "text" | "stream">,
  ): HostTurnResult {
    if (this.lockOwner !== null && this.lockOwner !== sessionId) {
      throw new Error("task-locked: 同一任务同时只能有一个会话执行，请先停止或等待当前会话");
    }
    const channel = this.openSession(sessionId);
    const result = channel.runTurn({ text, ...turn });
    if (result.state === "approval") {
      this.lockOwner = sessionId;
    } else if (this.lockOwner === sessionId) {
      this.lockOwner = null;
    }
    this.store.writeSession(this.taskDir, channel.snapshot());
    const pending = channel.pendingApproval();
    return {
      state: result.state,
      callId: result.call.callId,
      approvalId: result.approval?.id,
      tool: result.state === "approval" ? pending?.tool : undefined,
      target: result.state === "approval" ? pending?.target : undefined,
      userMessageId: result.userMessageId,
      agentMessageId: result.agentMessageId,
    };
  }

  approve(sessionId: string, approvalId: string): string {
    const channel = this.openSession(sessionId);
    const call = channel.approve(approvalId);
    if (this.lockOwner === sessionId) this.lockOwner = null;
    this.store.writeSession(this.taskDir, channel.snapshot());
    return call.callId;
  }

  reject(sessionId: string, approvalId: string): void {
    const channel = this.openSession(sessionId);
    channel.reject(approvalId);
    if (this.lockOwner === sessionId) this.lockOwner = null;
    this.store.writeSession(this.taskDir, channel.snapshot());
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

  cancel(sessionId: string): void {
    const channel = this.openSession(sessionId);
    channel.cancel();
    if (this.lockOwner === sessionId) this.lockOwner = null;
    this.store.writeSession(this.taskDir, channel.snapshot());
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
    this.lockOwner = null;
  }

  describe(): { taskId: string; taskDir: string; sessions: string[]; lockOwner: string | null; maxSeq: number } {
    const sessions = this.sessionIds();
    let maxSeq = 0;
    for (const sessionId of [...this.channels.keys()]) {
      const channel = this.channels.get(sessionId);
      if (channel) maxSeq = Math.max(maxSeq, maxMessageSequence(channel.snapshot().messages));
    }
    return { taskId: this.taskId, sessions, lockOwner: this.lockOwner, taskDir: this.taskDir, maxSeq };
  }
}
