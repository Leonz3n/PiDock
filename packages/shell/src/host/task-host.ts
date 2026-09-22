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

import { PiSessionChannel, type PiSessionSnapshot, type PiTurnInput } from "../main/pi-session.js";
import {
  buildTaskBranch,
  isTaskDirId,
  pinBaseline,
  previewTaskPaths,
  resolveTaskRoot,
  validateTaskName,
  type ProvisionPlan,
} from "../main/task-provision.js";
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
 * other task are rejected with `task-unknown` instead of接续 that task.
 */
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
    const repos = [...(input.repos ?? [])];
    const paths = previewTaskPaths(resolved.root, input.dirId, repos, []);
    if (paths.taskDir !== this.taskDir) {
      throw new Error(`invalid-payload: provision paths ${paths.taskDir} do not match this Host's task dir ${this.taskDir}`);
    }
    const at = input.now ?? this.now();
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
      now: at,
    });
    this.store.writeTask(this.taskDir, record);
    const plan: ProvisionPlan = {
      mainCheckoutDir: "",
      ops: [
        { kind: "fetch", cwd: "", args: ["fetch", "origin", pinned.remoteBranch] },
        { kind: "branch", cwd: "", args: ["branch", branched.branch, pinned.commit] },
        { kind: "worktree", cwd: "", args: ["worktree", "add", paths.taskDir, branched.branch] },
      ],
    };
    return { record, plan };
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
   *接续 another task's latest session.
   */
  openSession(sessionId: string, options?: { providerId?: string; model?: string }): PiSessionChannel {
    const existing = this.channels.get(sessionId);
    if (existing) return existing;
    const saved = this.store.readSession(this.taskDir, sessionId);
    if (saved) {
      if (saved.taskId !== this.taskId) {
        throw new Error("task-unknown: snapshot names a different task; refusing to接续");
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
    });
    this.channels.set(sessionId, channel);
    this.store.writeSession(this.taskDir, channel.snapshot());
    return channel;
  }

  sendMessage(sessionId: string, text: string, turn?: Omit<PiTurnInput, "text">): HostTurnResult {
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
    return {
      state: result.state,
      callId: result.call.callId,
      approvalId: result.approval?.id,
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

  cancel(sessionId: string): void {
    const channel = this.openSession(sessionId);
    channel.cancel();
    if (this.lockOwner === sessionId) this.lockOwner = null;
    this.store.writeSession(this.taskDir, channel.snapshot());
  }

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
