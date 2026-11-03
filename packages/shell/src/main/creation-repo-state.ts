/**
 * [Pencil T08] #143: per-repository provisioning state of an automatic
 * worktree task.
 *
 * A creation that has several repositories is not all-or-nothing: one
 * repository can be created while the next one fails. Before this module the
 * creation intent only knew `pending | complete | abandoned` for the whole
 * task, so a half-created task could not say which repository had succeeded,
 * why the failing one failed, or that a retry must only touch the failed ones.
 *
 * The rules here are pure (no git, no fs) so the same spelling is used by main
 * (`project-task-creation.ts`), the renderer parser and the tests:
 *
 * - every repository independently carries `pending | created | failed`;
 * - the failure is a NAMED code plus a detail sentence, never a bare error;
 * - a successful repository is never re-created on retry (its state stays
 *   `created` and the retry set is exactly the failed ones);
 * - an orphan task branch (ref exists, no worktree) is its own state with an
 *   explicit adopt/clean choice, not a permanent refusal.
 */

/** Phase of ONE repository of an interrupted/partial creation. */
export type RepoProvisionPhase = "pending" | "created" | "failed";

/**
 * Named per-repository failure codes. `WORKTREE_FETCH_FAILED` is the #142
 * refusal (named repository + branch, no stale baseline, no downgrade), the
 * `ORPHAN`/`DIVERGED`/`HELD` trio is the branch-exists-without-worktree family
 * that used to be one permanent deadlock (`TASK_BRANCH_EXISTS_NO_WORKTREE`).
 */
export type RepoFailureCode =
  | "WORKTREE_FETCH_FAILED"
  | "WORKTREE_BASE_CHANGED"
  | "WORKTREE_BRANCH_ORPHANED"
  | "WORKTREE_BRANCH_DIVERGED"
  | "WORKTREE_BRANCH_HELD_ELSEWHERE"
  | "WORKTREE_ADD_FAILED"
  | "WORKTREE_IDENTITY_MISMATCH"
  | "WORKTREE_SOURCE_CHANGED";

export interface RepoFailure { code: RepoFailureCode; detail: string }

/**
 * Persisted state of one repository. It lives in the creation intent next to
 * the task facts (`repoStates`, keyed by `repoDir`), so it survives a restart
 * and an interrupted creation still explains itself after the app is reopened.
 */
export interface RepoProvisionState {
  /** The registered source checkout this worktree was made from. */
  repoRoot: string;
  /** The task branch this repository owns (one branch per repository). */
  branch: string;
  /** The pinned baseline commit the worktree was created from. */
  baseCommit: string;
  /** The worktree path inside the task folder. */
  worktreePath: string;
  phase: RepoProvisionPhase;
  failure?: RepoFailure;
  /**
   * The failure this repository recorded BEFORE the latest one. A retry that
   * fails differently keeps the earlier evidence instead of overwriting it, so
   * "retry fails again" is explainable rather than a single moving sentence.
   */
  previousFailure?: RepoFailure;
  /** True only for resources this app created (never a user's own folder). */
  managed: boolean;
  /** Ownership marker: the worktree was created by PiDock, not adopted by hand. */
  createdByPidock: boolean;
}

/** What the disk really says about one repository right now. */
export interface RepoObservation {
  /** The task worktree exists AND is on the task branch at the pinned lineage. */
  worktreeIdentityOk: boolean;
  /** A failure observed during this attempt (wins over the persisted one). */
  failure?: RepoFailure;
  /** The task branch ref exists but no worktree holds it. */
  orphan?: { commit: string; adoptable: boolean };
}

export interface RepoSeed {
  repoDir: string;
  repoRoot: string;
  branch: string;
  baseCommit: string;
  worktreePath: string;
  createdByPidock: boolean;
}

/**
 * Derive one repository's state from what the disk says now, falling back to
 * the persisted state so a restart (or a later read with no fresh attempt)
 * still reports the failure it really recorded. A real successful worktree
 * clears a stale failure; a fresh observation always wins over the record.
 */
export function deriveRepoState(
  seed: RepoSeed,
  recorded: RepoProvisionState | undefined,
  observed: RepoObservation | undefined,
): RepoProvisionState {
  const base = {
    repoRoot: seed.repoRoot,
    branch: seed.branch,
    baseCommit: seed.baseCommit,
    worktreePath: seed.worktreePath,
    managed: seed.createdByPidock,
    createdByPidock: seed.createdByPidock,
  };
  if (observed?.worktreeIdentityOk) return { ...base, phase: "created" };
  if (observed?.failure) return { ...base, phase: "failed", failure: observed.failure };
  if (observed?.orphan && !observed.orphan.adoptable) {
    return { ...base, phase: "failed", failure: {
      code: "WORKTREE_BRANCH_DIVERGED",
      detail: `任务分支 ${seed.branch} 已存在但不在固定提交 ${seed.baseCommit} 上，无法接管；可放弃本次创建并清理该分支，或人工处理后重试`,
    } };
  }
  if (observed?.orphan) {
    return { ...base, phase: "failed", failure: {
      code: "WORKTREE_BRANCH_ORPHANED",
      detail: `任务分支 ${seed.branch} 已存在但工作树不在 ${seed.worktreePath}；可显式接管（同一固定提交）或放弃创建并清理该分支`,
    } };
  }
  if (recorded?.phase === "failed" && recorded.failure) {
    return { ...base, phase: "failed", failure: recorded.failure,
      ...(recorded.previousFailure ? { previousFailure: recorded.previousFailure } : {}) };
  }
  if (recorded?.phase === "created") {
    // The record said created but the worktree is gone now: that is a repair
    // state, never a silent "pending" that would read as "never attempted".
    return { ...base, phase: "failed", failure: {
      code: "WORKTREE_IDENTITY_MISMATCH",
      detail: `任务工作副本 ${seed.worktreePath} 已不存在或已改变，需要明确修复`,
    } };
  }
  return { ...base, phase: "pending" };
}

/** The retry set: exactly the repositories that are still failing. */
export function failedRepoDirs(states: readonly RepoProvisionState[]): string[] {
  return states.filter((state) => state.phase === "failed").map((state) => state.worktreePath);
}

/** True when at least one repository is still failing. */
export function hasFailedRepos(states: readonly RepoProvisionState[]): boolean {
  return states.some((state) => state.phase === "failed");
}

/** Repositories whose worktree was really created (retry never re-creates them). */
export function createdRepoCount(states: readonly RepoProvisionState[]): number {
  return states.filter((state) => state.phase === "created").length;
}

export function phaseLabel(phase: RepoProvisionPhase): string {
  if (phase === "created") return "已创建";
  if (phase === "failed") return "失败";
  return "待准备";
}

/**
 * The one sentence a partial creation shows. It names each repository's real
 * state, so the surface never summarizes "创建失败" over resources that exist.
 */
export function summarizePartialFailure(
  rows: readonly { repoDir: string; state: RepoProvisionState }[],
): string {
  const failed = rows.filter((row) => row.state.phase === "failed");
  const created = rows.filter((row) => row.state.phase === "created");
  const parts = [
    ...created.map((row) => `${row.repoDir} 已创建（保留）`),
    ...failed.map((row) => `${row.repoDir} 失败：${row.state.failure?.code ?? "WORKTREE_ADD_FAILED"} ${row.state.failure?.detail ?? ""}`.trim()),
  ];
  return `部分仓库创建失败：${parts.join("；")}。重试只会处理失败的仓库，不会重建已成功的工作副本`;
}

/** Per-resource cleanup outcome of an abandon that removes owned resources. */
export type CleanupAction = "removed" | "kept" | "failed";

export interface CleanupResourceResult {
  resource: string;
  path: string;
  action: CleanupAction;
  reason?: string;
}

/**
 * The abandon summary. A partial cleanup is reported per resource and leaves
 * an explainable state instead of the old "everything is kept, nothing is
 * listed" sentence.
 */
export function summarizeCleanup(results: readonly CleanupResourceResult[], mode: "keep" | "owned"): string {
  if (mode === "keep") {
    // The keep mode is the historical contract: nothing is touched and the
    // sentence says exactly that. What really exists on disk is read from
    // `status()` (per-repository `created`/`failed`), never claimed here.
    return "本次创建已放弃。已产生的任务目录、工作区、链接与会话均已保留；如任务记录已存在，该任务现为未归属任务。";
  }
  const removed = results.filter((row) => row.action === "removed");
  const kept = results.filter((row) => row.action === "kept");
  const failed = results.filter((row) => row.action === "failed");
  const parts = [
    removed.length ? `已清理 ${removed.map((row) => row.resource).join("、")}` : "",
    kept.length ? `已保留 ${kept.map((row) => `${row.resource}（${row.reason ?? "非本应用所有"}）`).join("、")}` : "",
    failed.length ? `清理失败 ${failed.map((row) => `${row.resource}（${row.reason ?? "未知原因"}）`).join("、")}，可按资源重试` : "",
  ].filter((part) => part.length > 0);
  return `本次创建已放弃。${parts.join("；")}。用户源目录与来源仓库从未被删除${failed.length ? "；清理部分失败，已保留逐项恢复入口" : ""}。`;
}
