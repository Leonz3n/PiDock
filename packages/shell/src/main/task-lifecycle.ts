/**
 * Task lifecycle rules for [PiDock 14] (#17): background/quit/relaunch,
 * archive/restore and cleanup.
 *
 * Pure rules only — no fs, no process control, no Electron. The Host owns the
 * state and the (injected) resource probes; this module owns the decisions the
 * issue pins down so both the Host and the renderer mirror can be tested
 * against one spelling:
 *
 * - an existing process is claimed or stopped by **identity** (pid + start time
 *   + command + cwd), never by a stale pid or a port;
 * - a task worktree is verified as a *worktree on the recorded branch whose
 *   history still contains the pinned base commit*, never the original checkout;
 * - explicit quit aborts the Agent first, then services/terminals/subprocess
 *   trees, and saves state; a resource whose identity cannot be proven is
 *   reported and the task is retained instead of being silently dropped;
 * - relaunch restores tasks/sessions/browser pages, revalidates draft
 *   references, restores each session's recorded permission without escalating,
 *   never replays pending/executed approvals, and never auto-connects services;
 * - archive stops runs, expires pending confirmations and pauses scheduling
 *   while keeping code/sessions/template version/generation bindings/browser
 *   state, and never changes the recorded token usage;
 * - cleanup is independent of archive, lists the scope it will touch, keeps an
 *   independent copy of undelivered code and the selected exports **before**
 *   removing anything, only removes identity-confirmed in-task resources, and
 *   keeps the registration plus per-item recovery entries when anything fails.
 */

/**
 * Identity of a resource this task started. `startedAt` is the OS-reported
 * start time (as reported, compared verbatim) and is what tells a live pid
 * apart from the same pid reused by another process after a crash. `command`
 * and `cwd` strengthen the check when both sides know them (a recorded
 * service/terminal identity only carries pid + start time, so they stay
 * optional rather than making every recorded identity unverifiable).
 */
export interface TaskProcessIdentity {
  pid: number;
  startedAt: string;
  /** Command the process was started with, when recorded. */
  command?: string;
  /** Working directory the process was started in, when recorded. */
  cwd?: string;
}

/** A process observed on the machine right now (the OS answer). */
export interface LiveProcessObservation extends TaskProcessIdentity {
  /** Port the process is observed to listen on: never identity on its own. */
  port?: number;
}

export type ProcessIdentityErrorCode =
  | "incomplete-claim"
  | "port-only"
  | "unknown-process"
  | "stale-pid"
  | "identity-mismatch";

export type ProcessIdentityVerdict =
  | { ok: true; identity: TaskProcessIdentity; matchedBy: "identity" }
  | { ok: false; code: ProcessIdentityErrorCode; reason: string };

/**
 * Prove that the process we recorded is still the one running: pid alone is
 * never enough (a pid is reused) and a port is never identity at all.
 */
export function verifyProcessIdentity(
  claim: {
    pid?: unknown;
    startedAt?: unknown;
    command?: unknown;
    cwd?: unknown;
    port?: unknown;
  },
  live: readonly LiveProcessObservation[],
): ProcessIdentityVerdict {
  const pid = claim.pid;
  const hasPid = typeof pid === "number" && Number.isInteger(pid) && pid > 0;
  const startedAt = claim.startedAt;
  const command = typeof claim.command === "string" ? claim.command.trim() : undefined;
  const cwd = typeof claim.cwd === "string" ? claim.cwd.trim() : undefined;
  if (!hasPid && claim.port !== undefined) {
    return { ok: false, code: "port-only", reason: "端口不是进程身份：不能凭端口认领或停止进程" };
  }
  if (!hasPid || typeof startedAt !== "string" || startedAt.trim().length === 0) {
    return {
      ok: false,
      code: "incomplete-claim",
      reason: "进程身份不完整（需要进程号与启动时间，可选命令与工作目录），已拒绝",
    };
  }
  const found = live.find((entry) => entry.pid === (pid as number));
  if (!found) {
    return { ok: false, code: "unknown-process", reason: `进程 ${String(pid)} 已不存在，不能认领或停止` };
  }
  if (found.startedAt !== startedAt) {
    return {
      ok: false,
      code: "stale-pid",
      reason: `进程号 ${String(pid)} 已被另一个进程复用（启动时间不同），拒绝按过期进程号操作`,
    };
  }
  if (command !== undefined && found.command !== undefined && found.command.trim() !== command) {
    return { ok: false, code: "identity-mismatch", reason: `进程 ${String(pid)} 的命令与记录不符` };
  }
  if (cwd !== undefined && found.cwd !== undefined && found.cwd.trim() !== cwd) {
    return { ok: false, code: "identity-mismatch", reason: `进程 ${String(pid)} 的工作目录与记录不符` };
  }
  return {
    ok: true,
    matchedBy: "identity",
    identity: { pid: pid as number, startedAt, ...(command !== undefined ? { command } : {}), ...(cwd !== undefined ? { cwd } : {}) },
  };
}

export interface GitResourceRecord {
  repoDir: string;
  /** Task branch checked out in the worktree. */
  branch: string;
  /** Pinned base commit fixed at fetch time. */
  baseCommit: string;
}

export interface GitResourceObservation {
  repoDir: string;
  /** `null` when the path has no git repository. */
  head: string | null;
  branch: string | null;
  /** True only for a registered worktree of the recorded repo (not the main checkout). */
  isWorktree: boolean;
  /** Whether the pinned base commit is still reachable from HEAD; `null` unknown. */
  baseCommitReachable: boolean | null;
}

export type GitIdentityVerdict =
  | { ok: true; repoDir: string; head: string; branch: string }
  | { ok: false; repoDir: string; code: "missing" | "not-a-worktree" | "branch-mismatch" | "base-unverified" | "history-rewritten"; reason: string };

/**
 * After an abnormal exit the recorded task worktree must still be *this*
 * task's worktree: on the task branch and still carrying the pinned base
 * commit. Another checkout (the original main checkout, a link to it, or a
 * folder that replaced the worktree) fails closed.
 */
export function verifyGitResourceIdentity(input: {
  record: GitResourceRecord;
  observed: GitResourceObservation | undefined;
}): GitIdentityVerdict {
  const repoDir = input.record.repoDir;
  const observed = input.observed;
  if (!observed || observed.head === null) {
    return { ok: false, repoDir, code: "missing", reason: `工作副本 ${repoDir} 不存在，不能凭记录直接认领` };
  }
  if (!observed.isWorktree) {
    return {
      ok: false,
      repoDir,
      code: "not-a-worktree",
      reason: `${repoDir} 不是本任务登记的 Git 工作副本（可能是原检出目录或其他检出），拒绝认领`,
    };
  }
  if (observed.branch !== input.record.branch) {
    return {
      ok: false,
      repoDir,
      code: "branch-mismatch",
      reason: `工作副本当前分支 ${String(observed.branch)} 与记录的任务分支 ${input.record.branch} 不符`,
    };
  }
  if (observed.baseCommitReachable === null) {
    return { ok: false, repoDir, code: "base-unverified", reason: `${repoDir} 的基线提交可达性未知，未验证前不认领` };
  }
  if (!observed.baseCommitReachable) {
    return {
      ok: false,
      repoDir,
      code: "history-rewritten",
      reason: `记录基线 ${input.record.baseCommit} 已不在 ${repoDir} 历史中（工作副本被外部替换或改写）`,
    };
  }
  return { ok: true, repoDir, head: observed.head, branch: observed.branch };
}

export interface BackgroundPolicy {
  platform: string;
  /** Closing the window keeps Agent/service execution running. */
  windowClosedContinues: boolean;
  /** How the user gets the window back after closing it. */
  reEntry: "reopen-window" | "tray" | "unavailable";
  /** Only an explicit quit stops the task's resources. */
  explicitQuitStopsResources: true;
  detail: string;
}

/**
 * Cross-platform background policy. macOS keeps the app (and therefore the
 * Host-owned Agent/service execution) alive after the last window closes and
 * reopens the window through the dock entry; without an implemented tray entry
 * the other platforms still quit, so the window-close continuation is not
 * claimed for them.
 */
export function backgroundPolicyFor(input: { platform: string }): BackgroundPolicy {
  if (input.platform === "darwin") {
    return {
      platform: input.platform,
      windowClosedContinues: true,
      reEntry: "reopen-window",
      explicitQuitStopsResources: true,
      detail: "关闭窗口不结束 Agent 与服务；通过 Dock 或 activate 重新打开窗口；只有明确退出才停止资源",
    };
  }
  return {
    platform: input.platform,
    windowClosedContinues: false,
    reEntry: "unavailable",
    explicitQuitStopsResources: true,
    detail: "本平台尚无托盘等后台入口，关闭最后一个窗口仍然退出应用（后台常驻属未实现范围）",
  };
}

export type QuitPhase = "abort-agent" | "stop-services" | "stop-terminals" | "stop-process-tree" | "save-state";

export interface QuitStep {
  phase: QuitPhase;
  subject: string;
  action: string;
  status: "needed" | "already-stopped" | "blocked";
  detail: string;
}

export interface QuitFailure {
  taskId: string;
  subject: string;
  code: ProcessIdentityErrorCode;
  reason: string;
}

export interface QuitPlan {
  steps: QuitStep[];
  failures: QuitFailure[];
  /** Tasks with at least one unverified resource: kept and reported, never dropped. */
  retainedTasks: string[];
}

interface QuitResource {
  taskId: string;
  sessions: readonly { sessionId: string; runState: string }[];
  services: readonly { serviceId: string; running: boolean; process?: QuitProcessClaim }[];
  terminals: readonly { instanceId: string; live: boolean; process?: QuitProcessClaim }[];
  processTrees: readonly { resourceId: string; live: boolean; process?: QuitProcessClaim }[];
}

export type QuitProcessClaim = {
  pid?: unknown;
  startedAt?: unknown;
  command?: unknown;
  cwd?: unknown;
  port?: unknown;
};

function quitStep(input: {
  phase: QuitPhase;
  subject: string;
  action: string;
  claim: QuitProcessClaim | undefined;
  live: readonly LiveProcessObservation[];
  absentDetail: string;
}): { step: QuitStep; failure: QuitFailure | null } {
  if (input.claim === undefined) {
    // A resource that is not running (or never reported a process) needs no
    // stop step; a *live* one without identity is where we fail closed.
    return {
      step: { phase: input.phase, subject: input.subject, action: input.action, status: "already-stopped", detail: input.absentDetail },
      failure: null,
    };
  }
  const verdict = verifyProcessIdentity(input.claim, input.live);
  if (!verdict.ok) {
    return {
      step: {
        phase: input.phase,
        subject: input.subject,
        action: input.action,
        status: "blocked",
        detail: `身份未验证（${verdict.code}）：${verdict.reason}`,
      },
      failure: { taskId: "", subject: input.subject, code: verdict.code, reason: verdict.reason },
    };
  }
  return {
    step: {
      phase: input.phase,
      subject: input.subject,
      action: input.action,
      status: "needed",
      detail: `按身份停止（进程 ${verdict.identity.pid}，启动时间 ${verdict.identity.startedAt}）`,
    },
    failure: null,
  };
}

/**
 * Explicit quit order ([PiDock 14] #17 box 2): abort the Agent, then stop the
 * task's services, terminals and subprocess trees (each by proven identity),
 * then save state. A resource whose identity cannot be proven is reported as a
 * failure and keeps its task in the result so the caller never silently loses
 * a task with work still running.
 */
export function planExplicitQuit(input: {
  tasks: readonly QuitResource[];
  live: readonly LiveProcessObservation[];
}): QuitPlan {
  const steps: QuitStep[] = [];
  const failures: QuitFailure[] = [];
  const retainedTasks: string[] = [];
  for (const task of input.tasks) {
    let retained = false;
    const record = (failure: QuitFailure | null): void => {
      if (failure === null) return;
      failures.push({ ...failure, taskId: task.taskId });
      retained = true;
    };
    for (const session of task.sessions) {
      if (session.runState === "running" || session.runState === "approval") {
        steps.push({
          phase: "abort-agent",
          subject: session.sessionId,
          action: "中止 Agent 回合",
          status: "needed",
          detail: `会话 ${session.sessionId} 处于 ${session.runState}，明确退出前先中止`,
        });
      }
    }
    for (const service of task.services) {
      if (!service.running) {
        steps.push({
          phase: "stop-services",
          subject: service.serviceId,
          action: "停止服务",
          status: "already-stopped",
          detail: `服务 ${service.serviceId} 未在运行`,
        });
        continue;
      }
      const { step, failure } = quitStep({
        phase: "stop-services",
        subject: service.serviceId,
        action: "停止服务",
        claim: service.process,
        live: input.live,
        absentDetail: `服务 ${service.serviceId} 未报告进程`,
      });
      steps.push(step);
      record(failure);
    }
    for (const terminal of task.terminals) {
      if (!terminal.live) {
        steps.push({ phase: "stop-terminals", subject: terminal.instanceId, action: "停止终端", status: "already-stopped", detail: `终端 ${terminal.instanceId} 未在运行` });
        continue;
      }
      const { step, failure } = quitStep({
        phase: "stop-terminals",
        subject: terminal.instanceId,
        action: "停止终端",
        claim: terminal.process,
        live: input.live,
        absentDetail: `终端 ${terminal.instanceId} 未报告进程`,
      });
      steps.push(step);
      record(failure);
    }
    for (const tree of task.processTrees) {
      if (!tree.live) {
        steps.push({ phase: "stop-process-tree", subject: tree.resourceId, action: "停止子进程树", status: "already-stopped", detail: `子进程树 ${tree.resourceId} 未在运行` });
        continue;
      }
      const { step, failure } = quitStep({
        phase: "stop-process-tree",
        subject: tree.resourceId,
        action: "停止子进程树",
        claim: tree.process,
        live: input.live,
        absentDetail: `子进程树 ${tree.resourceId} 未报告进程`,
      });
      steps.push(step);
      record(failure);
    }
    steps.push({
      phase: "save-state",
      subject: task.taskId,
      action: "保存任务状态",
      status: "needed",
      detail: "保存会话、草稿、用量与生命周期状态；退出失败可定位且不静默丢失任务",
    });
    if (retained) retainedTasks.push(task.taskId);
  }
  return { steps, failures, retainedTasks: [...new Set(retainedTasks)].sort() };
}

export interface VersionedRecordKeep {
  label: string;
  detail: string;
}

export interface ArchiveInput {
  taskId: string;
  sessions: readonly { sessionId: string; runState: string }[];
  pendingApprovals: readonly string[];
  schedules: readonly { scheduleId: string; enabled: boolean }[];
  kept: {
    worktrees: number;
    protocolBindings: number;
    browserPages: number;
    templateVersion: string | null;
  };
  usageDetails: number;
}

export interface ArchivePlan {
  taskId: string;
  stoppedSessions: string[];
  expiredApprovals: string[];
  pausedSchedules: string[];
  /** Records the archive keeps (never removed by archiving). */
  kept: VersionedRecordKeep[];
  /** Archiving must not zero or double-count usage. */
  usage: { detailsBefore: number; detailsAfter: number; preserved: true };
  /** Restoring does not resume scheduling on its own. */
  scheduleResumedOnRestore: false;
  steps: QuitStep[];
}

/**
 * Archiving ([PiDock 14] #17 box 6): stop this task's runs, expire its
 * un-executed confirmations, pause its schedules, and keep code, sessions,
 * drafts, template version, generation bindings and browser state. Usage
 * details are untouched (`detailsAfter === detailsBefore`).
 */
export function planArchive(input: ArchiveInput): ArchivePlan {
  const stoppedSessions = input.sessions
    .filter((session) => session.runState === "running" || session.runState === "approval")
    .map((session) => session.sessionId)
    .sort();
  const pausedSchedules = input.schedules.filter((schedule) => schedule.enabled).map((schedule) => schedule.scheduleId).sort();
  return {
    taskId: input.taskId,
    stoppedSessions,
    expiredApprovals: [...input.pendingApprovals].sort(),
    pausedSchedules,
    kept: [
      { label: "代码工作副本", detail: `${input.kept.worktrees} 个任务工作副本保留（不删除、不回到原检出目录）` },
      { label: "会话与草稿", detail: `${input.sessions.length} 个会话及其结构化草稿保留` },
      { label: "模板版本", detail: input.kept.templateVersion === null ? "未记录模板版本" : `保留模板版本 ${input.kept.templateVersion}` },
      { label: "生成绑定记录", detail: `${input.kept.protocolBindings} 条协议生成／消费者绑定记录保留` },
      { label: "浏览器状态", detail: `${input.kept.browserPages} 个任务页面的持久状态保留` },
    ],
    usage: { detailsBefore: input.usageDetails, detailsAfter: input.usageDetails, preserved: true },
    scheduleResumedOnRestore: false,
    steps: [
      ...stoppedSessions.map<QuitStep>((sessionId) => ({
        phase: "abort-agent",
        subject: sessionId,
        action: "停止执行",
        status: "needed",
        detail: `归档停止会话 ${sessionId} 的执行`,
      })),
      {
        phase: "save-state",
        subject: input.taskId,
        action: "写入归档状态",
        status: "needed",
        detail: "保留代码、会话、模板版本、生成绑定与浏览器状态；使未执行确认失效并暂停调度",
      },
    ],
  };
}

function normalizePath(value: string): string {
  const parts = value.trim().replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  const out: string[] = [];
  for (const segment of parts) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return value.trim().startsWith("/") ? `/${out.join("/")}` : out.join("/");
}

function isInside(target: string, root: string): boolean {
  const t = normalizePath(target);
  const r = normalizePath(root);
  return t === r || t.startsWith(`${r}/`);
}

export interface CleanupIdentityInput {
  taskId: string;
  taskDir: string;
  /** In-task link name -> recorded link target. */
  knownLinkNames: Readonly<Record<string, string>>;
  /** Original checkout directories of the project: never removed. */
  originalCheckoutPaths: readonly string[];
  /** Other tasks' folders: never removed. */
  otherTaskDirs: readonly string[];
}

export type CleanupTargetVerdict =
  | { ok: true; kind: "task-dir" | "in-task-link"; path: string }
  | { ok: false; code: "outside-task" | "original-checkout" | "other-task" | "unknown-path"; reason: string };

/**
 * Only identity-confirmed task resources may be removed ([PiDock 14] #17 box 8):
 * a path outside the task folder, an original checkout of the project, another
 * task's folder or an in-task path that is not one of the recorded links is
 * refused.
 */
export function verifyCleanupTarget(path: string, identity: CleanupIdentityInput): CleanupTargetVerdict {
  const requested = path.trim();
  if (requested.length === 0) return { ok: false, code: "unknown-path", reason: "空路径不可清理" };
  if (!isInside(requested, identity.taskDir)) {
    if (identity.originalCheckoutPaths.some((original) => isInside(requested, original))) {
      return { ok: false, code: "original-checkout", reason: `${requested} 是项目原检出目录，绝不清理` };
    }
    if (identity.otherTaskDirs.some((other) => isInside(requested, other))) {
      return { ok: false, code: "other-task", reason: `${requested} 属于另一个任务，拒绝接管或删除` };
    }
    return { ok: false, code: "outside-task", reason: `${requested} 不在任务工作区内，拒绝清理` };
  }
  const linkName = normalizePath(requested).slice(normalizePath(identity.taskDir).length + 1);
  if (linkName.length === 0) return { ok: true, kind: "task-dir", path: requested };
  const recorded = identity.knownLinkNames[linkName];
  if (recorded !== undefined) return { ok: true, kind: "in-task-link", path: requested };
  if (linkName.includes("/")) {
    return { ok: false, code: "outside-task", reason: `${requested} 不在任务根内的登记链接上，拒绝清理` };
  }
  return { ok: true, kind: "task-dir", path: requested };
}

export type CleanupDisposition = "remove" | "keep-copy" | "keep";

export interface CleanupItemPlan {
  id: string;
  resource: string;
  disposition: CleanupDisposition;
  detail: string;
  /** What this item can be exported as, when the user selects an export. */
  exportable?: "sessions" | "drafts" | "usage";
}

export interface CleanupSelection {
  exportSessions: boolean;
  exportDrafts: boolean;
  exportUsage: boolean;
}

export interface CleanupPreview {
  items: CleanupItemPlan[];
  warnings: string[];
  /** True when unselected records will be removed: the user must see this. */
  recordsWillBeRemoved: boolean;
  selectionLabels: string[];
}

/** Cleanup addresses archived tasks only ([PiDock 14] #17 + #1 生效配置与清理). */
export function evaluateCleanupGate(input: { archived: boolean }): { ok: true } | { ok: false; error: string } {
  if (!input.archived) return { ok: false, error: "只有已归档任务可清理；归档与清理相互独立" };
  return { ok: true };
}

export function cleanupSelectionLabels(selection: CleanupSelection): string[] {
  const labels: string[] = [];
  if (selection.exportSessions) labels.push("导出会话");
  if (selection.exportDrafts) labels.push("导出草稿");
  if (selection.exportUsage) labels.push("导出用量");
  return labels;
}

/**
 * The scope shown before anything is removed ([PiDock 14] #17 boxes 7–9):
 * undelivered/uncommitted code is kept as an independent copy (conservative
 * path), plain-directory originals are always kept (only the in-task link is
 * removed), and unselected records are removed explicitly rather than by
 * accident.
 */
export function previewCleanup(input: {
  archived: boolean;
  code: { uncommitted: boolean; undelivered: boolean };
  counts: { sessions: number; drafts: number; usageRecords: number; browserPages: number; terminals: number };
  worktree: boolean;
  links: readonly { linkName: string; sourcePath: string }[];
  selection: CleanupSelection;
}): CleanupPreview {
  const gate = evaluateCleanupGate({ archived: input.archived });
  if (!gate.ok) return { items: [], warnings: [gate.error], recordsWillBeRemoved: false, selectionLabels: [] };
  const labels = cleanupSelectionLabels(input.selection);
  const items: CleanupItemPlan[] = [];
  const warnings: string[] = [];
  const undelivered = input.code.uncommitted || input.code.undelivered;
  if (input.worktree) {
    items.push(
      undelivered
        ? {
            id: "code",
            resource: "任务工作副本（含未提交／未交付代码）",
            disposition: "keep-copy",
            detail: "先保留一份独立代码副本并核验成功，再解除登记；不把未交付代码当作可直接删除的数据",
          }
        : { id: "code", resource: "任务工作副本", disposition: "keep-copy", detail: "保留独立代码副本并核验成功后再解除登记" },
    );
  }
  if (input.counts.sessions > 0) {
    items.push({
      id: "sessions",
      resource: `会话（${input.counts.sessions} 个）`,
      disposition: "remove",
      exportable: "sessions",
      detail: input.selection.exportSessions ? "先导出会话记录，核验成功后再移除" : "未选择导出：会话记录将随清理移除",
    });
  }
  if (input.counts.drafts > 0) {
    items.push({
      id: "drafts",
      resource: `结构化草稿（${input.counts.drafts} 个）`,
      disposition: "remove",
      exportable: "drafts",
      detail: input.selection.exportDrafts ? "先导出草稿，核验成功后再移除" : "未选择导出：草稿将随清理移除",
    });
  }
  if (input.counts.usageRecords > 0) {
    items.push({
      id: "usage",
      resource: `Token 用量记录（${input.counts.usageRecords} 条）`,
      disposition: "remove",
      exportable: "usage",
      detail: input.selection.exportUsage
        ? `先导出这 ${input.counts.usageRecords} 条用量记录，核验成功后再移除；历史文件删除不静默改变其他统计`
        : `处理范围为这 ${input.counts.usageRecords} 条用量记录；未选择导出时将被移除，且不会静默改写其他任务的统计`,
    });
  }
  if (input.counts.browserPages > 0) {
    items.push({
      id: "browser",
      resource: `浏览器状态（${input.counts.browserPages} 个页面）`,
      disposition: "remove",
      detail: "移除该任务持久分区页面数据；任务页与 PiDock 自有界面分属不同信任范围",
    });
  }
  if (input.counts.terminals > 0) {
    items.push({ id: "terminals", resource: `终端（${input.counts.terminals} 个）`, disposition: "remove", detail: "终端记录随任务清理移除" });
  }
  for (const link of input.links) {
    items.push({
      id: `link:${link.linkName}`,
      resource: `普通目录链接 · ${link.linkName}`,
      disposition: "remove",
      detail: `只移除任务内软链接 ${link.linkName}；永不沿链接删除原目录 ${link.sourcePath} 及其文件`,
    });
  }
  const recordsWillBeRemoved =
    (!input.selection.exportSessions && input.counts.sessions > 0) ||
    (!input.selection.exportDrafts && input.counts.drafts > 0) ||
    (!input.selection.exportUsage && input.counts.usageRecords > 0);
  if (recordsWillBeRemoved) {
    warnings.push("未选择导出的会话／草稿／用量记录将被移除，清理不是可一键撤销的归档恢复");
  }
  warnings.push("清理只面向已归档任务，且独立于归档：清理成功后才解除项目关联");
  return { items, warnings, recordsWillBeRemoved, selectionLabels: labels };
}

export interface CleanupStep {
  phase: "verify-keep" | "remove-managed" | "deregister-project";
  subject: string;
  action: string;
  status: "ready" | "blocked";
  detail: string;
}

export interface CleanupPlan {
  ok: boolean;
  error?: string;
  steps: CleanupStep[];
  /** Per-item recovery entry: the registration stays so each item can be retried. */
  recovery: { item: string; reason: string }[];
  receipt: { keptPosition: string | null; removed: string[]; partialFailure: boolean } | null;
}

/**
 * Removal order ([PiDock 14] #17 boxes 7–9 + #1 生效配置与清理): verify the kept
 * code copy and the selected exports first, only then remove managed resources
 * and deregister the project. A failed verification or a partial removal keeps
 * the registration and leaves a per-item recovery entry instead of wiping the
 * metadata.
 */
export function planCleanupRemoval(input: {
  items: readonly CleanupItemPlan[];
  verification: { codeCopyOk: boolean; exportsOk: boolean; retainedPosition: string | null };
  outcomes?: readonly { id: string; ok: boolean; reason?: string }[];
}): CleanupPlan {
  const keepBlocked: string[] = [];
  if (!input.verification.codeCopyOk) keepBlocked.push("独立代码副本未核验成功");
  if (!input.verification.exportsOk) keepBlocked.push("所选导出未核验成功");
  if (keepBlocked.length > 0) {
    return {
      ok: false,
      error: `cleanup-keep-failed: ${keepBlocked.join("；")}，保留登记与逐项恢复入口`,
      steps: [
        {
          phase: "verify-keep",
          subject: "保留核验",
          action: "核验代码副本与导出",
          status: "blocked",
          detail: keepBlocked.join("；"),
        },
      ],
      recovery: input.items.map((item) => ({ item: item.id, reason: "保留核验未通过，未移除任何受管资源" })),
      receipt: null,
    };
  }
  const outcomes = new Map((input.outcomes ?? []).map((outcome) => [outcome.id, outcome]));
  const steps: CleanupStep[] = [];
  const recovery: { item: string; reason: string }[] = [];
  const removed: string[] = [];
  for (const item of input.items) {
    const outcome = outcomes.get(item.id);
    const failed = outcome !== undefined && !outcome.ok;
    if (failed) {
      recovery.push({ item: item.id, reason: outcome.reason ?? "移除失败" });
      steps.push({
        phase: "remove-managed",
        subject: item.id,
        action: item.disposition === "remove" ? "移除受管资源" : "保留副本",
        status: "blocked",
        detail: outcome.reason ?? "移除失败",
      });
      continue;
    }
    if (item.disposition === "remove") removed.push(item.id);
    steps.push({
      phase: "remove-managed",
      subject: item.id,
      action: item.disposition === "remove" ? "移除受管资源" : "保留副本",
      status: "ready",
      detail: item.detail,
    });
  }
  const partialFailure = recovery.length > 0;
  steps.push({
    phase: "deregister-project",
    subject: "项目关联",
    action: "解除项目关联",
    status: partialFailure ? "blocked" : "ready",
    detail: partialFailure
      ? "局部清理失败：保留任务与项目关联登记，保留逐项恢复入口"
      : `清理成功留下保留位置与结果回执，项目不再被该任务阻止删除`,
  });
  return {
    ok: true,
    steps,
    recovery,
    receipt: { keptPosition: input.verification.retainedPosition, removed, partialFailure },
  };
}

export interface LinkRemovalObservation {
  /** `lstat` of the in-task link path. */
  isSymlink: boolean;
  isDirectory: boolean;
  /** Current link target, as read now. */
  currentTarget: string | null;
}

export type LinkRemovalVerdict =
  | { ok: true; retargeted: boolean; detail: string }
  | { ok: false; code: "not-a-link" | "already-removed"; reason: string };

/**
 * Removing an in-task plain-directory link ([PiDock 14] #17 box 12): the link
 * itself may go, its target never does — not even when the target was replaced
 * externally, which is reported as a recovery-relevant retarget instead of being
 * followed. A path that is no longer a link (a real directory was put in its
 * place, or a loop was resolved into a plain dir) is refused.
 */
export function verifyLinkRemoval(input: {
  expectedLinkName: string;
  recordedSourcePath: string;
  observation: LinkRemovalObservation | undefined;
}): LinkRemovalVerdict {
  const observation = input.observation;
  if (!observation) {
    return { ok: false, code: "already-removed", reason: `任务内链接 ${input.expectedLinkName} 已不存在，无需移除` };
  }
  if (!observation.isSymlink) {
    return {
      ok: false,
      code: "not-a-link",
      reason: `${input.expectedLinkName} 当前不是软链接（可能是被替换的真实目录或已展开的循环），拒绝删除`,
    };
  }
  if (observation.currentTarget !== null && observation.currentTarget !== input.recordedSourcePath) {
    return {
      ok: true,
      retargeted: true,
      detail: `链接目标已从 ${input.recordedSourcePath} 改指为 ${observation.currentTarget}：只移除链接本身，保留当前目标目录`,
    };
  }
  return { ok: true, retargeted: false, detail: `移除任务内软链接 ${input.expectedLinkName}，原目录 ${input.recordedSourcePath} 及其文件保留` };
}

export interface RelaunchSessionInput {
  sessionId: string;
  /** Recorded permission choice; unknown values are not a pass. */
  permission?: string;
  /** Permission the last request actually used (permission record). */
  actualPermission?: string;
  runState: string;
  draft?: {
    text: string;
    /** Persisted refs are shape-checked on restore, never trusted as typed. */
    references?: readonly unknown[];
  };
  approvals: readonly { id: string; status: string; executed?: boolean; consumedAt?: string }[];
}

export interface RelaunchInput {
  tasks: readonly {
    taskId: string;
    archived: boolean;
    sessions: readonly RelaunchSessionInput[];
    services: readonly { serviceId: string; running: boolean }[];
    browserPages: readonly { pageId: string; url: string }[];
  }[];
  availableFiles: readonly string[];
  availableSkills: readonly string[];
}

export interface RestoredReference {
  id: string;
  label: string;
  state: "ok" | "missing" | "skill-unavailable";
  detail: string;
}

export interface RestoredSession {
  sessionId: string;
  permission: string;
  permissionRestored: boolean;
  permissionEscalated: false;
  actualPermission: string | null;
  runState: string;
  linkedTo: "none" | "cancelled" | "crashed" | "in-flight";
  draftKept: boolean;
  draftText: string | null;
  autoSent: false;
  expandedHistory: false;
  commandsRerun: false;
  references: RestoredReference[];
  approvals: { replayed: string[]; expiredOnRestore: string[]; alreadyHandled: string[] };
}

export interface RelaunchPlan {
  tasks: {
    taskId: string;
    archived: boolean;
    sessions: RestoredSession[];
    browser: { pageId: string; url: string; restored: true }[];
    services: { serviceId: string; action: "start-on-demand"; autoConnect: false; detail: string }[];
  }[];
  warnings: string[];
  autoConnectServices: false;
}

const KNOWN_PERMISSIONS = ["read", "default", "auto"] as const;

function restoredRunState(runState: string): { runState: string; linkedTo: RestoredSession["linkedTo"] } {
  if (runState === "running") return { runState: "idle", linkedTo: "crashed" };
  if (runState === "approval") return { runState: "idle", linkedTo: "in-flight" };
  if (runState === "cancelled") return { runState: "cancelled", linkedTo: "cancelled" };
  return { runState, linkedTo: "none" };
}

function revalidateReferences(
  references: readonly unknown[],
  input: { availableFiles: readonly string[]; availableSkills: readonly string[] },
): RestoredReference[] {
  return references.flatMap<RestoredReference>((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    const reference = {
      id: typeof record["id"] === "string" ? record["id"] : "",
      kind: typeof record["kind"] === "string" ? record["kind"] : "",
      label: typeof record["label"] === "string" ? record["label"] : "",
      sourceId: typeof record["sourceId"] === "string" ? record["sourceId"] : undefined,
      resourcePath: typeof record["resourcePath"] === "string" ? record["resourcePath"] : undefined,
    };
    if (reference.id.length === 0 || reference.label.length === 0) {
      return [{ id: reference.id || reference.label || "unknown", label: reference.label || "未知引用", state: "missing" as const, detail: "引用记录形状不可识别，恢复后需重新选择" }];
    }
    if (reference.kind === "skill") {
      if (reference.sourceId === undefined || reference.resourcePath === undefined) {
        return { id: reference.id, label: reference.label, state: "skill-unavailable" as const, detail: "技能来源未记录，恢复后需重新选择具体来源" };
      }
      const available = input.availableSkills.includes(reference.resourcePath);
      return available
        ? { id: reference.id, label: reference.label, state: "ok" as const, detail: `技能来源 ${reference.resourcePath} 仍可用` }
        : { id: reference.id, label: reference.label, state: "skill-unavailable" as const, detail: `技能来源 ${reference.resourcePath} 已不可用，需重新选择` };
    }
    const available = input.availableFiles.includes(reference.label);
    return available
      ? { id: reference.id, label: reference.label, state: "ok" as const, detail: "文件仍可用，发送前再次校验" }
      : { id: reference.id, label: reference.label, state: "missing" as const, detail: "文件已移动或不可用，需重新选择来源" };
  });
}

/**
 * Relaunch after exit/crash ([PiDock 14] #17 boxes 3–5, 11, 12): restore
 * tasks/sessions/browser pages, restore each session's recorded permission
 * (unknown values fall back to `read`, never escalated), revalidate draft
 * references, keep drafts without sending them, and describe every service as
 * start-on-demand. Pending confirmations become expired and executed ones stay
 * handled: nothing is replayed.
 */
export function planRelaunch(input: RelaunchInput): RelaunchPlan {
  const warnings: string[] = [];
  const tasks = input.tasks.map((task) => {
    const sessions = task.sessions.map<RelaunchedSession>((session) => {
      const recorded = typeof session.permission === "string" ? session.permission : "";
      const known = (KNOWN_PERMISSIONS as readonly string[]).includes(recorded);
      if (!known) {
        warnings.push(`会话 ${session.sessionId} 的权限记录不可识别，按只读恢复（不自动升权）`);
      }
      const permission = known ? recorded : "read";
      const state = restoredRunState(session.runState);
      const pending = session.approvals.filter((approval) => approval.status === "pending").map((approval) => approval.id);
      const handled = session.approvals
        .filter((approval) => approval.status !== "pending")
        .map((approval) => approval.id);
      const references = revalidateReferences(session.draft?.references ?? [], input);
      const draftKept = session.draft !== undefined;
      return {
        sessionId: session.sessionId,
        permission,
        permissionRestored: known,
        permissionEscalated: false,
        actualPermission: typeof session.actualPermission === "string" && session.actualPermission.length > 0 ? session.actualPermission : null,
        runState: state.runState,
        linkedTo: state.linkedTo,
        draftKept,
        draftText: session.draft?.text ?? null,
        autoSent: false,
        expandedHistory: false,
        commandsRerun: false,
        references,
        approvals: { replayed: [], expiredOnRestore: pending.sort(), alreadyHandled: handled.sort() },
      };
    });
    return {
      taskId: task.taskId,
      archived: task.archived,
      sessions,
      browser: task.browserPages.map((page) => ({ pageId: page.pageId, url: page.url, restored: true as const })),
      services: task.services.map((service) => ({
        serviceId: service.serviceId,
        action: "start-on-demand" as const,
        autoConnect: false as const,
        detail: `服务 ${service.serviceId} 不自动连接业务环境，由用户或 Agent 重新启动`,
      })),
    };
  });
  if (input.tasks.some((task) => task.services.length > 0)) {
    warnings.push("恢复不自动启动服务，也不自动连接业务环境");
  }
  return { tasks, warnings, autoConnectServices: false };
}

/** Kept for readability of the plan shape above. */
type RelaunchedSession = RelaunchPlan["tasks"][number]["sessions"][number];
