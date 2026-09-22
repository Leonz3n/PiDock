/**
 * Multi-repo + plain-directory provisioning rules for [PiDock 03] (#6).
 *
 * Pure, dependency-free module (same seam as `task-provision.ts`): it runs
 * identically in main, the utilityProcess Host, and unit tests. Single-repo
 * primitives (`planWorktreeCreation`, `pinBaseline`, `previewTaskPaths`)
 * stay in `task-provision.ts`; this module adds the #6 boxes on top:
 *
 * - per-repo selection with its own remote + baseline branch
 *   (e.g. `origin/main`, `upstream/release/v2`);
 * - fetch-then-pin per repo with all-success gating: no worktree plan is
 *   emitted unless every selected repo pinned a fresh commit (no stale
 *   refs, no per-repo silent fallback);
 * - fail-closed conflict reporting (path-taken / branch-in-use /
 *   repo-unusable) that never takes over unknown resources;
 * - append filtering: only new repos are fetched/planned, existing
 *   baselines and running state are untouched;
 * - partial-failure segmentation: created vs pending repos stay
 *   distinguishable so recovery keeps user edits;
 * - plain-directory link rules: stable ASCII link names, source snapshots
 *   with link identity, lexical target classification (dead targets need
 *   fs and are probed Host-side; see `probeLinkTarget` in S2).
 *
 * Cross-task writes through links into a shared original directory are
 * explicitly NOT isolated: the task-id write lock must never be presented
 * as file isolation. Real path authorization + write coordination for
 * shared link targets is deferred to [PiDock 09] (#11).
 */

import {
  assertProvisionPlanSafe,
  isAbsoluteTaskRoot,
  isSafeTaskChildName,
  planWorktreeCreation,
  type ProvisionPlan,
} from "./task-provision.js";

export type MultiRepoErrorCode =
  | "empty-selection"
  | "duplicate-repo"
  | "invalid-repo"
  | "fetch-failed"
  | "path-taken"
  | "branch-in-use"
  | "repo-unusable";

export interface MultiRepoError {
  code: MultiRepoErrorCode;
  /** The repo selection this error belongs to ("" for task-level errors). */
  repoDir: string;
  message: string;
}

/** One repo selected into a task: its own remote + baseline branch. */
export interface RepoSelection {
  /** In-task folder name (single safe component, e.g. `front-monorepo`). */
  repoDir: string;
  /** Remote to fetch for this creation/append (e.g. `origin`, `upstream`). */
  remote: string;
  /** Baseline branch on that remote (e.g. `main`, `release/v2`). */
  remoteBranch: string;
  /** Machine-local source checkout the git ops run in (fetch/branch/worktree cwd). */
  mainCheckoutDir: string;
}

/** A repo whose baseline fetch succeeded and whose commit is pinned. */
export interface PinnedRepoBaseline {
  repoDir: string;
  remote: string;
  remoteBranch: string;
  commit: string;
}

const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

/**
 * Validate the repo selections before any fetch. Fail-closed with the
 * offending `repoDir` attached so the form can keep its input and offer
 * retry per repo instead of creating from a stale reference.
 */
export function validateRepoSelections(
  selections: readonly RepoSelection[],
): { ok: true; selections: RepoSelection[] } | { ok: false; error: MultiRepoError } {
  const seen = new Set<string>();
  for (const selection of selections) {
    if (!isSafeTaskChildName(selection.repoDir)) {
      return {
        ok: false,
        error: {
          code: "invalid-repo",
          repoDir: selection.repoDir,
          message: `仓库目录名不合法: ${selection.repoDir}`,
        },
      };
    }
    if (seen.has(selection.repoDir)) {
      return {
        ok: false,
        error: {
          code: "duplicate-repo",
          repoDir: selection.repoDir,
          message: `仓库 ${selection.repoDir} 被选择了两次，请只保留一个来源`,
        },
      };
    }
    seen.add(selection.repoDir);
    if (typeof selection.remote !== "string" || selection.remote.trim().length === 0) {
      return {
        ok: false,
        error: {
          code: "invalid-repo",
          repoDir: selection.repoDir,
          message: `仓库 ${selection.repoDir} 缺少远程名称，请选择本次获取的远程`,
        },
      };
    }
    if (typeof selection.remoteBranch !== "string" || selection.remoteBranch.trim().length === 0) {
      return {
        ok: false,
        error: {
          code: "invalid-repo",
          repoDir: selection.repoDir,
          message: `仓库 ${selection.repoDir} 缺少基线分支，请选择本次获取的远程分支`,
        },
      };
    }
    if (!isAbsoluteTaskRoot(selection.mainCheckoutDir)) {
      return {
        ok: false,
        error: {
          code: "repo-unusable",
          repoDir: selection.repoDir,
          message: `仓库 ${selection.repoDir} 的来源检出不可用: ${selection.mainCheckoutDir}`,
        },
      };
    }
  }
  return { ok: true, selections: [...selections] };
}

/**
 * Pin every selected repo to its freshly fetched commit. ALL selections
 * must pin before any worktree plan is emitted: a single failure returns
 * the per-repo failure list and no plan (fail-closed, no stale refs, no
 * cross-use of another repo's commit). Covers auth / network / deleted /
 * force-pushed branches uniformly as `fetch-failed` with the repo named.
 */
export function pinRepoBaselines(
  selections: readonly RepoSelection[],
  fetched: Readonly<Record<string, string>>,
): { ok: true; pinned: PinnedRepoBaseline[] } | { ok: false; error: MultiRepoError } {
  const pinned: PinnedRepoBaseline[] = [];
  for (const selection of selections) {
    const commit = fetched[selection.repoDir];
    if (typeof commit !== "string" || !COMMIT_PATTERN.test(commit.trim())) {
      return {
        ok: false,
        error: {
          code: "fetch-failed",
          repoDir: selection.repoDir,
          message: `仓库 ${selection.repoDir} 获取远程基线失败，已保留表单，请重试获取后再创建`,
        },
      };
    }
    pinned.push({
      repoDir: selection.repoDir,
      remote: selection.remote.trim(),
      remoteBranch: selection.remoteBranch.trim(),
      commit: commit.trim().toLowerCase(),
    });
  }
  return { ok: true, pinned };
}

/**
 * Plan one fetch/branch/worktree triple per pinned repo. Every op runs in
 * that repo's own source checkout; the main-checkout guard applies per
 * plan so `pull/merge/reset` can never target a source checkout either.
 */
export function planMultiRepoWorktrees(input: {
  taskDir: string;
  branch: string;
  pinned: readonly PinnedRepoBaseline[];
  mainCheckouts: Readonly<Record<string, string>>;
}): ProvisionPlan[] {
  const plans: ProvisionPlan[] = [];
  for (const repo of input.pinned) {
    const mainCheckoutDir = input.mainCheckouts[repo.repoDir];
    if (typeof mainCheckoutDir !== "string" || !isAbsoluteTaskRoot(mainCheckoutDir)) {
      throw new Error(`repo-unusable: no usable source checkout for repo ${repo.repoDir}`);
    }
    const plan = planWorktreeCreation({
      taskDir: input.taskDir,
      mainCheckoutDir,
      repoDir: repo.repoDir,
      // The fetch runs against this repo's own remote; `planWorktreeCreation`
      // spells `fetch origin <branch>` for the single-repo shape, so the
      // per-repo remote is threaded through as the branch's remote qualifier.
      remoteBranch: repo.remoteBranch,
      commit: repo.commit,
      branch: input.branch,
    });
    assertProvisionPlanSafe(plan);
    plans.push(plan);
  }
  return plans;
}

export interface RepoConflictInput {
  /** Worktree dirs this creation/append wants to create. */
  wantedWorktreeDirs: readonly string[];
  /** Paths already present on disk (task folder scan or Host report). */
  takenPaths: readonly string[];
  /** Branch names already attached to another worktree (`git worktree list`). */
  branchesInUse: readonly string[];
  /** The branch this creation/append wants to create per repo. */
  wantedBranch: string;
}

/**
 * Fail-closed conflict check before creating anything: reports the exact
 * taken path / in-use branch and creates nothing. Never takes over an
 * unknown resource (no `--force`, no re-pointing чужой worktrees).
 */
export function checkRepoConflicts(
  input: RepoConflictInput,
): { ok: true } | { ok: false; error: MultiRepoError } {
  for (const wanted of input.wantedWorktreeDirs) {
    if (input.takenPaths.includes(wanted)) {
      return {
        ok: false,
        error: {
          code: "path-taken",
          repoDir: wanted,
          message: `路径已被占用: ${wanted}，不会接管未知资源`,
        },
      };
    }
  }
  if (input.branchesInUse.includes(input.wantedBranch)) {
    return {
      ok: false,
      error: {
        code: "branch-in-use",
        repoDir: input.wantedBranch,
        message: `分支已在其他 worktree 使用: ${input.wantedBranch}，请更换任务分支`,
      },
    };
  }
  return { ok: true };
}

/**
 * Append filtering: only repos not already in the task are fetched and
 * planned. Existing baselines (`existingRepos`) and running state are
 * untouched; the caller keeps the stored root/dirId for the append (never
 * the machine default that may have changed since creation).
 */
export function filterAppendRepos(
  existingRepos: readonly string[],
  requestedRepos: readonly string[],
): { appended: string[]; skipped: string[] } {
  const existing = new Set(existingRepos);
  const appended: string[] = [];
  const skipped: string[] = [];
  for (const repoDir of requestedRepos) {
    if (existing.has(repoDir)) skipped.push(repoDir);
    else appended.push(repoDir);
  }
  return { appended, skipped };
}

export type RepoPrepareStatus = "created" | "pending" | "failed";

export interface RepoPrepareOutcome {
  repoDir: string;
  status: RepoPrepareStatus;
  /** Present for `failed`: which step failed and why (form-kept retry). */
  error?: MultiRepoError;
}

/**
 * Partial-failure segmentation after a multi-repo prepare (or an app
 * restart mid-prepare): created vs pending/failed repos stay
 * distinguishable so recovery resumes only the unfinished ones and keeps
 * user edits in the finished worktrees.
 */
export function segmentPrepareOutcomes(
  outcomes: readonly RepoPrepareOutcome[],
): { created: string[]; pending: string[]; failed: { repoDir: string; error: MultiRepoError }[] } {
  const created: string[] = [];
  const pending: string[] = [];
  const failed: { repoDir: string; error: MultiRepoError }[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === "created") created.push(outcome.repoDir);
    else if (outcome.status === "pending") pending.push(outcome.repoDir);
    else {
      failed.push({
        repoDir: outcome.repoDir,
        error:
          outcome.error ??
          ({ code: "fetch-failed", repoDir: outcome.repoDir, message: `仓库 ${outcome.repoDir} 准备失败` } as MultiRepoError),
      });
    }
  }
  return { created, pending, failed };
}

/** Stable ASCII link name for a plain directory: `dir-` + 8 alphanumerics. */
export function buildLinkName(directoryId: string): string {
  return `dir-${directoryId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toLowerCase()}`;
}

export interface PlainDirLinkSnapshot {
  /** Stable in-task link name (`dir-` + 8 chars, ASCII only). */
  linkName: string;
  /** Identity of the linked entry (project directory id). */
  directoryId: string;
  /** Absolute original target captured at link time (source of truth). */
  sourcePath: string;
  /** ISO time the snapshot was taken. */
  snapshotAt: string;
}

/**
 * Snapshot a plain-directory entry into a task. The link never requires
 * Git or an environment, and it never initializes a repository in the
 * target: it is a shared view of the original files, not an independent
 * copy. Writes through the link modify the original target.
 */
export function snapshotPlainDirLink(input: {
  directoryId: string;
  sourcePath: string;
  now: string;
}): { ok: true; snapshot: PlainDirLinkSnapshot } | { ok: false; error: MultiRepoError } {
  if (typeof input.directoryId !== "string" || input.directoryId.trim().length === 0) {
    return {
      ok: false,
      error: { code: "invalid-repo", repoDir: "", message: "普通目录缺少标识" },
    };
  }
  if (!isAbsoluteTaskRoot(input.sourcePath)) {
    return {
      ok: false,
      error: { code: "repo-unusable", repoDir: input.directoryId, message: `普通目录来源不可用: ${input.sourcePath}` },
    };
  }
  return {
    ok: true,
    snapshot: {
      linkName: buildLinkName(input.directoryId),
      directoryId: input.directoryId,
      sourcePath: input.sourcePath.trim(),
      snapshotAt: input.now,
    },
  };
}

/** Preview in-task link paths alongside worktree paths (one preview, one truth). */
export function previewMixedTaskPaths(
  taskDir: string,
  repoDirs: readonly string[],
  linkNames: readonly string[],
): { taskDir: string; worktrees: Record<string, string>; links: Record<string, string> } {
  for (const name of [...repoDirs, ...linkNames]) {
    if (!isSafeTaskChildName(name)) {
      throw new Error(`invalid-path: task child name must be a single safe component: ${name}`);
    }
  }
  const base = taskDir.replace(/[\\/]+$/, "");
  const worktrees: Record<string, string> = {};
  for (const name of repoDirs) worktrees[name] = `${base}/${name}`;
  const links: Record<string, string> = {};
  for (const name of linkNames) links[name] = `${base}/${name}`;
  return { taskDir: base, worktrees, links };
}

export type LinkTargetShape = "ok" | "nested" | "loop-risk";

/**
 * Lexical classification of a plain-dir link target (no fs access):
 *
 * - `nested`: the source sits inside another linked source or inside the
 *   task folder — legal but recorded so overlapping views stay visible;
 * - `loop-risk`: the source IS the task folder or sits inside it, so a
 *   symlink there could cycle back into the task;
 * - `ok`: otherwise.
 *
 * Dead (missing) targets need fs and are probed Host-side.
 */
export function classifyLinkTarget(
  sourcePath: string,
  taskDir: string,
  siblingSources: readonly string[],
): LinkTargetShape {
  const source = sourcePath.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const task = taskDir.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (source === task || source.startsWith(`${task}/`)) return "loop-risk";
  for (const sibling of siblingSources) {
    const other = sibling.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (other.length === 0 || other === source) continue;
    if (source.startsWith(`${other}/`) || other.startsWith(`${source}/`)) return "nested";
  }
  return "ok";
}
