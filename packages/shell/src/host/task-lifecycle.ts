/**
 * Host-owned task lifecycle state for [PiDock 14] (#17), S2 slice.
 *
 * The pure decisions live in `main/task-lifecycle.ts`; this module owns the
 * *state*: `<taskDir>/lifecycle.json` (archive flag + cleanup receipt +
 * partial-cleanup recovery entries) and the ordered application of archive /
 * restore / cleanup against injected resource probes.
 *
 * Everything that touches the machine (process observations, worktree
 * observation, link `lstat`/removal, code copy, exports) is injected through
 * `TaskLifecycleResources`, so the state machine is unit-testable without a
 * filesystem, a git binary or a live process tree — and so the transport layer
 * cannot smuggle a renderer-chosen path or identity into it.
 */

import {
  backgroundPolicyFor,
  evaluateCleanupGate,
  planArchive,
  planCleanupRemoval,
  planExplicitQuit,
  planRelaunch,
  previewCleanup,
  verifyCleanupTarget,
  verifyGitResourceIdentity,
  verifyLinkRemoval,
  verifyProcessIdentity,
  type ArchivePlan,
  type CleanupItemPlan,
  type CleanupPlan,
  type CleanupSelection,
  type GitResourceObservation,
  type LinkRemovalObservation,
  type LiveProcessObservation,
  type ProcessIdentityVerdict,
  type QuitPlan,
  type QuitProcessClaim,
  type RelaunchPlan,
} from "../main/task-lifecycle.js";
import { buildLifecycleRecord, type LifecycleRecord } from "./task-store.js";
import type { TaskStore } from "./task-host.js";

export interface LifecycleSession {
  sessionId: string;
  permission: string;
  /** Permission the last request actually used (the permission record). */
  actualPermission: string | null;
  runState: string;
  draft?: { text: string; references?: readonly unknown[] };
  approvals: readonly { id: string; status: string; executed: boolean; consumedAt?: string }[];
}

export interface LifecycleWorktree {
  repoDir: string;
  branch: string;
  baseCommit: string;
}

/**
 * Everything the lifecycle state machine may read or act on. Wired in `host.ts`
 * from the existing seams (session channels, task record, service topology,
 * terminal registry, path coordination) — never from the renderer payload.
 */
export interface TaskLifecycleResources {
  platform(): string;
  sessions(): readonly LifecycleSession[];
  /** Stop a running/awaiting turn; expires its pending confirmation. */
  cancelSession(sessionId: string): void;
  /** End this task's recorded run of one service (no real process kill yet). */
  stopService(serviceId: string): void;
  /** Mark one terminal instance exited. */
  stopTerminal(instanceId: string): void;
  /** End one recorded derived execution (releases the write right it held). */
  stopProcessTree(resourceId: string): void;
  worktrees(): readonly LifecycleWorktree[];
  observeRepo(worktree: LifecycleWorktree): GitResourceObservation | undefined;
  usageCount(): number;
  services(): readonly { serviceId: string; running: boolean; process?: QuitProcessClaim }[];
  terminals(): readonly { instanceId: string; live: boolean; process?: QuitProcessClaim }[];
  processTrees(): readonly { resourceId: string; live: boolean; process?: QuitProcessClaim }[];
  links(): readonly { linkName: string; sourcePath: string }[];
  observeInTaskPath(path: string): LinkRemovalObservation | undefined;
  /** Remove the in-task entry itself; never the link target. */
  removeInTaskPath(path: string): void;
  originalCheckoutPaths(): readonly string[];
  otherTaskDirs(): readonly string[];
  delivery(): { uncommitted: boolean; undelivered: boolean };
  browserPages(): readonly { pageId: string; url: string }[];
  availableFiles(): readonly string[];
  availableSkills(): readonly string[];
  liveProcesses(): readonly LiveProcessObservation[];
  /** Keep an independent code copy and the selected exports, then verify them. */
  keepAndExport(input: { selection: CleanupSelection; keepRoot: string }): {
    codeCopyOk: boolean;
    exportsOk: boolean;
    retainedPosition: string | null;
    detail: string;
  };
  /** Remove this task's session snapshots (cleanup only). */
  deleteSession(sessionId: string): void;
  /** Drop this task's persisted usage scope (cleanup only). */
  clearUsage(): void;
  /**
   * Remove something the Host does not own (browser persistent partition data)
   * or reports that there is nothing persisted to remove (terminal records are
   * in-memory only today). A missing handler fails closed.
   */
  delegateCleanup(itemId: string): { ok: boolean; reason: string };
}

export interface LifecycleView {
  taskId: string;
  archived: boolean;
  archivedAt: string | null;
  restoredAt: string | null;
  schedulePaused: boolean;
  projectReleased: boolean;
  cleanup: LifecycleRecord["cleanup"];
  recovery: LifecycleRecord["recovery"];
  background: ReturnType<typeof backgroundPolicyFor>;
  usageDetails: number;
  resources: {
    worktrees: { repoDir: string; verdict: ReturnType<typeof verifyGitResourceIdentity> }[];
    processes: { kind: "service" | "terminal" | "process-tree"; id: string; running: boolean; verdict: ProcessIdentityVerdict | null }[];
  };
  quit: QuitPlan;
  relaunch: RelaunchPlan;
}

export interface CleanupPreviewView {
  taskId: string;
  archived: boolean;
  items: CleanupItemPlan[];
  warnings: string[];
  recordsWillBeRemoved: boolean;
  selectionLabels: string[];
  keepRoot: string;
}

export interface CleanupRunResult extends CleanupPlan {
  items: CleanupItemPlan[];
  record: LifecycleRecord;
}

export class TaskLifecycleHost {
  constructor(
    readonly taskId: string,
    readonly taskDir: string,
    private readonly store: TaskStore,
    private readonly resources: TaskLifecycleResources,
    private readonly now: () => string = () => new Date().toISOString(),
    /** Default keep/export root for a cleanup when the caller names none. */
    private readonly defaultKeepRoot: string = `${taskDir.replace(/[\\/]+$/, "")}/../.pidock-kept`,
  ) {}

  /** Persisted record, or an in-memory default before the first archive. */
  private record(): LifecycleRecord {
    return this.store.readLifecycle(this.taskDir) ?? buildLifecycleRecord({ taskId: this.taskId, now: this.now() });
  }

  lifecycle(): LifecycleRecord {
    return this.record();
  }

  /**
   * Archive ([PiDock 14] #17 box 6): stop this task's runs, expire un-executed
   * confirmations, pause scheduling and keep every record. Usage details are
   * never touched, so archiving can neither zero nor double count tokens.
   */
  archive(): { plan: ArchivePlan; record: LifecycleRecord } {
    const current = this.record();
    const sessions = this.resources.sessions();
    const plan = planArchive({
      taskId: this.taskId,
      sessions: sessions.map((session) => ({ sessionId: session.sessionId, runState: session.runState })),
      pendingApprovals: sessions.flatMap((session) =>
        session.approvals.filter((approval) => approval.status === "pending").map((approval) => approval.id),
      ),
      // Scheduling lives app-side; the Host records that archiving paused it and
      // that restoring must not resume it.
      schedules: [],
      kept: {
        worktrees: this.resources.worktrees().length,
        protocolBindings: 0,
        browserPages: this.resources.browserPages().length,
        templateVersion: null,
      },
      usageDetails: this.resources.usageCount(),
    });
    for (const sessionId of plan.stoppedSessions) this.resources.cancelSession(sessionId);
    const at = this.now();
    const record: LifecycleRecord = {
      ...current,
      taskId: this.taskId,
      archived: true,
      archivedAt: at,
      schedulePaused: true,
      updatedAt: at,
    };
    this.store.writeLifecycle(this.taskDir, record);
    return { plan, record };
  }

  /** Restore an archived task; never resumes scheduling and never starts services. */
  restore(): { record: LifecycleRecord; scheduleResumed: false; servicesStarted: false } {
    const current = this.record();
    const at = this.now();
    const record: LifecycleRecord = {
      ...current,
      archived: false,
      restoredAt: at,
      // Kept paused: `restoreTask` must not re-enable scheduling.
      schedulePaused: true,
      updatedAt: at,
    };
    this.store.writeLifecycle(this.taskDir, record);
    return { record, scheduleResumed: false, servicesStarted: false };
  }

  /** Cleanup preview, including the retain root the code copy/exports will use. */
  cleanupPreview(input: { selection: CleanupSelection; keepRoot?: string }): CleanupPreviewView {
    const record = this.record();
    const gate = evaluateCleanupGate({ archived: record.archived });
    if (!gate.ok) throw new Error(gate.error);
    const preview = previewCleanup({
      archived: record.archived,
      code: this.resources.delivery(),
      counts: {
        sessions: this.resources.sessions().length,
        drafts: this.resources.sessions().filter((session) => session.draft !== undefined).length,
        usageRecords: this.resources.usageCount(),
        browserPages: this.resources.browserPages().length,
        terminals: this.resources.terminals().length,
      },
      worktree: this.resources.worktrees().length > 0,
      links: this.resources.links(),
      selection: input.selection,
    });
    return {
      taskId: this.taskId,
      archived: record.archived,
      items: preview.items,
      warnings: preview.warnings,
      recordsWillBeRemoved: preview.recordsWillBeRemoved,
      selectionLabels: preview.selectionLabels,
      keepRoot: input.keepRoot ?? this.defaultKeepRoot,
    };
  }

  /**
   * Run a cleanup ([PiDock 14] #17 boxes 7–9, 12): keep an independent code
   * copy and the selected exports first, verify them, then remove only
   * identity-confirmed managed resources in order, and finally record the
   * receipt. A failed keep-verification removes nothing; a partial removal
   * keeps the registration, the kept position and one recovery entry per
   * failed item.
   */
  runCleanup(input: { selection: CleanupSelection; keepRoot?: string }): CleanupRunResult {
    const preview = this.cleanupPreview(input);
    const kept = this.resources.keepAndExport({ selection: input.selection, keepRoot: preview.keepRoot });
    const outcomes: { id: string; ok: boolean; reason?: string }[] = [];
    const keepVerified = kept.codeCopyOk && kept.exportsOk;
    for (const item of preview.items) {
      if (!keepVerified) break;
      outcomes.push(this.removeItem(item));
    }
    const plan = planCleanupRemoval({
      items: preview.items,
      verification: { codeCopyOk: kept.codeCopyOk, exportsOk: kept.exportsOk, retainedPosition: kept.retainedPosition },
      outcomes,
    });
    const at = this.now();
    const record: LifecycleRecord = {
      ...this.record(),
      updatedAt: at,
      // Deregistration is only recorded when every managed item was handled;
      // otherwise the task keeps blocking the project deletion and stays
      // recoverable (`partialFailure` + per-item `recovery`).
      projectReleased: plan.receipt?.partialFailure === false,
      cleanup:
        plan.receipt === null
          ? this.record().cleanup
          : { ranAt: at, keptPosition: plan.receipt.keptPosition, exports: preview.selectionLabels, removed: plan.receipt.removed, partialFailure: plan.receipt.partialFailure },
      recovery: plan.recovery.map((entry) => ({ item: entry.item, reason: entry.reason, at })),
    };
    this.store.writeLifecycle(this.taskDir, record);
    return { ...plan, items: preview.items, record };
  }

  private removeItem(item: CleanupItemPlan): { id: string; ok: boolean; reason?: string } {
    if (item.disposition !== "remove") return { id: item.id, ok: true, reason: item.detail };
    if (item.id === "sessions" || item.id === "drafts") {
      try {
        for (const session of this.resources.sessions()) this.resources.deleteSession(session.sessionId);
        return { id: item.id, ok: true };
      } catch (error) {
        return { id: item.id, ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    }
    if (item.id === "usage") {
      try {
        this.resources.clearUsage();
        return { id: item.id, ok: true };
      } catch (error) {
        return { id: item.id, ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    }
    if (item.id.startsWith("link:")) {
      const linkName = item.id.slice("link:".length);
      const link = this.resources.links().find((entry) => entry.linkName === linkName);
      if (!link) return { id: item.id, ok: false, reason: `登记链接 ${linkName} 已不在任务记录中` };
      const path = `${this.taskDir.replace(/[\\/]+$/, "")}/${linkName}`;
      const identity = verifyCleanupTarget(path, {
        taskId: this.taskId,
        taskDir: this.taskDir,
        knownLinkNames: Object.fromEntries(this.resources.links().map((entry) => [entry.linkName, entry.sourcePath])),
        originalCheckoutPaths: this.resources.originalCheckoutPaths(),
        otherTaskDirs: this.resources.otherTaskDirs(),
      });
      if (!identity.ok) return { id: item.id, ok: false, reason: identity.reason };
      const removal = verifyLinkRemoval({
        expectedLinkName: linkName,
        recordedSourcePath: link.sourcePath,
        observation: this.resources.observeInTaskPath(path),
      });
      if (!removal.ok) return { id: item.id, ok: false, reason: removal.reason };
      try {
        this.resources.removeInTaskPath(path);
      } catch (error) {
        return { id: item.id, ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
      return { id: item.id, ok: true, reason: removal.detail };
    }
    return { id: item.id, ...this.resources.delegateCleanup(item.id) };
  }

  /**
   * Crash-recovery readout ([PiDock 14] #17 box 5): every recorded worktree and
   * every live process is verified by identity, so nothing is claimed or stopped
   * from a stale pid or a port.
   */
  state(): LifecycleView {
    const record = this.record();
    const live = this.resources.liveProcesses();
    const worktrees = this.resources.worktrees().map((worktree) => ({
      repoDir: worktree.repoDir,
      verdict: verifyGitResourceIdentity({
        record: { repoDir: worktree.repoDir, branch: worktree.branch, baseCommit: worktree.baseCommit },
        observed: this.resources.observeRepo(worktree),
      }),
    }));
    const processes: LifecycleView["resources"]["processes"] = [];
    for (const service of this.resources.services()) {
      processes.push({
        kind: "service",
        id: service.serviceId,
        running: service.running,
        verdict: service.running && service.process !== undefined ? verifyProcessIdentity(service.process, live) : null,
      });
    }
    for (const terminal of this.resources.terminals()) {
      processes.push({
        kind: "terminal",
        id: terminal.instanceId,
        running: terminal.live,
        verdict: terminal.live && terminal.process !== undefined ? verifyProcessIdentity(terminal.process, live) : null,
      });
    }
    for (const tree of this.resources.processTrees()) {
      processes.push({
        kind: "process-tree",
        id: tree.resourceId,
        running: tree.live,
        verdict: tree.live && tree.process !== undefined ? verifyProcessIdentity(tree.process, live) : null,
      });
    }
    return {
      taskId: this.taskId,
      archived: record.archived,
      archivedAt: record.archivedAt,
      restoredAt: record.restoredAt,
      schedulePaused: record.schedulePaused,
      projectReleased: record.projectReleased,
      cleanup: record.cleanup,
      recovery: record.recovery,
      background: backgroundPolicyFor({ platform: this.resources.platform() }),
      usageDetails: this.resources.usageCount(),
      resources: { worktrees, processes },
      quit: this.quitPlan(),
      relaunch: this.relaunchPlan(),
    };
  }

  /**
   * Apply the explicit-quit plan ([PiDock 14] #17 box 2): abort the Agent,
   * stop services/terminals/subprocess trees whose identity was verified, then
   * save state. Blocked resources are reported, never guessed at, and the task
   * is retained so the failure is locatable instead of a silent loss. Real OS
   * process termination is the spawner's job (residual): this stops the
   * recorded/owned state.
   */
  quit(): { plan: QuitPlan; applied: string[]; record: LifecycleRecord } {
    const plan = this.quitPlan();
    const applied: string[] = [];
    for (const step of plan.steps) {
      if (step.status !== "needed") continue;
      try {
        if (step.phase === "abort-agent") this.resources.cancelSession(step.subject);
        else if (step.phase === "stop-services") this.resources.stopService(step.subject);
        else if (step.phase === "stop-terminals") this.resources.stopTerminal(step.subject);
        else if (step.phase === "stop-process-tree") this.resources.stopProcessTree(step.subject);
        applied.push(`${step.phase}:${step.subject}`);
      } catch {
        // A failed step keeps its reason in the plan's failures (identity) or in
        // the applied list missing that subject; the task stays retained below.
        plan.failures.push({ taskId: this.taskId, subject: step.subject, code: "identity-mismatch", reason: `退出步骤失败：${step.phase}:${step.subject}` });
        plan.retainedTasks.push(this.taskId);
      }
    }
    const at = this.now();
    const record: LifecycleRecord = { ...this.record(), updatedAt: at };
    this.store.writeLifecycle(this.taskDir, record);
    return { plan, applied, record };
  }

  quitPlan(): QuitPlan {
    const sessions = this.resources.sessions();
    return planExplicitQuit({
      tasks: [
        {
          taskId: this.taskId,
          sessions: sessions.map((session) => ({ sessionId: session.sessionId, runState: session.runState })),
          services: this.resources.services(),
          terminals: this.resources.terminals(),
          processTrees: this.resources.processTrees(),
        },
      ],
      live: this.resources.liveProcesses(),
    });
  }

  relaunchPlan(): RelaunchPlan {
    const sessions = this.resources.sessions();
    return planRelaunch({
      tasks: [
        {
          taskId: this.taskId,
          archived: this.record().archived,
          sessions: sessions.map((session) => ({
            sessionId: session.sessionId,
            permission: session.permission,
            actualPermission: session.actualPermission ?? undefined,
            runState: session.runState,
            ...(session.draft !== undefined ? { draft: session.draft } : {}),
            approvals: session.approvals,
          })),
          services: this.resources.services().map((service) => ({ serviceId: service.serviceId, running: service.running })),
          browserPages: this.resources.browserPages(),
        },
      ],
      availableFiles: this.resources.availableFiles(),
      availableSkills: this.resources.availableSkills(),
    });
  }
}
