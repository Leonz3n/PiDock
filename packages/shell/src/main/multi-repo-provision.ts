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

/**
 * A remote name a repository selection may name: one safe token, never a
 * path, an option or something git would read as a ref. Exported once so the
 * create flow and the production append cannot drift on the spelling of
 * "this is a valid remote name".
 */
export const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type MultiRepoErrorCode =
  | "empty-selection"
  | "duplicate-repo"
  | "invalid-repo"
  | "fetch-failed"
  | "path-taken"
  | "branch-in-use"
  | "repo-unusable";

const MULTI_REPO_ERROR_CODES = [
  "empty-selection",
  "duplicate-repo",
  "invalid-repo",
  "fetch-failed",
  "path-taken",
  "branch-in-use",
  "repo-unusable",
] as const satisfies readonly MultiRepoErrorCode[];

/**
 * Runtime guard for a per-repo error code crossing the RPC/record boundary:
 * only the codes in `MultiRepoErrorCode` are accepted, so a caller-supplied
 * `prepareErrors[].code` or a persisted record cannot smuggle an arbitrary
 * string past an unchecked cast.
 */
export function isMultiRepoErrorCode(value: unknown): value is MultiRepoErrorCode {
  return typeof value === "string" && (MULTI_REPO_ERROR_CODES as readonly string[]).includes(value);
}

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
      // The fetch runs against this repo's own remote (#6 per-repo
      // remote box): `repo.remote` rides every executable fetch op.
      remote: repo.remote,
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
 *
 * The wired recovery flow is `TaskWorkspaceHost.resumeAppend`
 * (`task/resumeAppend`): it classifies each selected repo from the REAL
 * worktree on disk (`classifyRepoPrepareState`), feeds the outcomes here,
 * and plans only the retry set. `appendRepos` itself still resumes by
 * filtering against the stored `repos` list (`filterAppendRepos`), which
 * keeps finished worktrees untouched but cannot distinguish `pending` vs
 * `failed`; resume is the entry point that can.
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

/**
 * Real evidence the Host gathered about ONE selected repo's worktree on
 * disk. Every field is an observation, never a guess:
 *
 * - `worktreePresent`: `lstat(taskDir/<repoDir>)` succeeded.
 * - `worktreeMatchesPinnedCommit`: the present path is a linked Git
 *   worktree whose HEAD is the task branch and whose HEAD still contains
 *   the pinned commit (`RepoProbe` read-only git, same seam as [PiDock 14]
 *   #17); `null` when the probe could not verify it.
 * - `previousError`: a per-repo error already recorded for this repo.
 * - `recordedBaselineMissing`: the record lists the repo but carries no
 *   recorded remote baseline for it (`repoSources` entry absent), so no
 *   resume can plan it.
 */
export interface RepoPrepareEvidence {
  repoDir: string;
  worktreePresent: boolean;
  worktreeMatchesPinnedCommit?: boolean | null;
  /** Reason the present path is not this task's worktree (only for `failed`). */
  mismatchReason?: string;
  /** A per-repo error already reported for this repo (kept, never dropped). */
  previousError?: MultiRepoError;
  /** The record names the repo but records no remote baseline for it. */
  recordedBaselineMissing?: boolean;
}

/**
 * Classify ONE selected repo from real evidence (honest, fail-closed):
 *
 * - `created`: `lstat` found the worktree dir AND the git probe verified a
 *   linked worktree on the task branch with the pinned commit reachable.
 *   Never claimed from the record alone: with no probe the repo is not
 *   `created`.
 * - `failed`: the path is present but is NOT this task's pinned worktree
 *   (partial/broken leftover — never overwritten); OR the worktree is
 *   absent while a per-repo error was already reported for it (kept with
 *   its real reason, never silently dropped); OR the record names the repo
 *   without a recorded remote baseline, so no resume can plan it.
 * - `pending`: the selection is recorded WITH its remote baseline, the
 *   worktree is absent and no error was ever reported (worktree absent, no
 *   reported error — which git op ran, if any, is unknown).
 */
export function classifyRepoPrepareState(evidence: RepoPrepareEvidence): RepoPrepareOutcome {
  if (evidence.worktreePresent) {
    if (evidence.worktreeMatchesPinnedCommit === true) {
      return { repoDir: evidence.repoDir, status: "created" };
    }
    return {
      repoDir: evidence.repoDir,
      status: "failed",
      error: {
        code: "repo-unusable",
        repoDir: evidence.repoDir,
        message:
          evidence.mismatchReason ??
          `路径 ${evidence.repoDir} 已存在但不是本任务固定提交的工作副本，不会自动覆盖`,
      },
    };
  }
  if (evidence.recordedBaselineMissing) {
    // The read and the resume write must agree: a repo with no recorded
    // baseline is not resumable, so it is failed/needs-human here instead of
    // `pending` (which the resume would then refuse).
    return {
      repoDir: evidence.repoDir,
      status: "failed",
      error: {
        code: "repo-unusable",
        repoDir: evidence.repoDir,
        message: `仓库 ${evidence.repoDir} 缺少记录的远程基线，无法从此记录恢复，请人工处理`,
      },
    };
  }
  if (evidence.previousError) {
    return { repoDir: evidence.repoDir, status: "failed", error: evidence.previousError };
  }
  return { repoDir: evidence.repoDir, status: "pending" };
}

/**
 * Split classified outcomes into what a resume may retry (worktree absent
 * AND the record can be planned, so creating it takes over nothing) and what
 * it must hold (a present path that is not this task's worktree, or a record
 * with no recorded remote baseline: never reset/refetched/overwritten/planned).
 * `created` repos are never in either list, so their user edits survive.
 * `mustHold` carries the repo dirs a resume must keep out of its plan.
 */
export function resumeRepoSet(
  outcomes: readonly RepoPrepareOutcome[],
  mustHold: ReadonlySet<string>,
): { retry: string[]; hold: string[] } {
  const retry: string[] = [];
  const hold: string[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === "created") continue;
    if (mustHold.has(outcome.repoDir)) hold.push(outcome.repoDir);
    else retry.push(outcome.repoDir);
  }
  return { retry, hold };
}

/** Stable ASCII link name for a plain directory: `dir-` + up to 8
 * alphanumerics of the directory id (lowercased). The spelling is locked
 * by renderer parity (`directoryLinkName`); callers adding several links
 * must reject duplicate `linkName`s via `checkLinkNameCollisions`
 * (fail-closed, never auto-rename, never silently share one link).
 */
export function buildLinkName(directoryId: string): string {
  return `dir-${directoryId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toLowerCase()}`;
}

/**
 * Stable in-task folder name for a selected repository: `repo-` + the first 8
 * hex characters of the project repository id. The spelling is shared by the
 * creation-intent validator, the provisioning planner and the main-side prep
 * scan (`projectRepositoryForRepoDir`); a change here would make every
 * recorded `repoDir` unresolvable and refuse every append/resume.
 */
export function buildRepoChildName(repositoryId: string): string {
  return `repo-${repositoryId.slice(0, 8)}`;
}

/**
 * Fail-closed collision check for link names: two directory ids mapping
 * to the same `dir-oooooooo` name must be rejected, never auto-renamed
 * (auto-renaming would break the name <-> snapshot identity).
 */
export function checkLinkNameCollisions(
  directoryIds: readonly string[],
): { ok: true } | { ok: false; error: MultiRepoError } {
  const seen = new Map<string, string>();
  for (const directoryId of directoryIds) {
    const linkName = buildLinkName(directoryId);
    const first = seen.get(linkName);
    if (first !== undefined && first !== directoryId) {
      return {
        ok: false,
        error: {
          code: "duplicate-repo",
          repoDir: directoryId,
          message: `普通目录链接名冲突: ${directoryId} 与 ${first} 均映射到 ${linkName}，请更换目录标识`,
        },
      };
    }
    seen.set(linkName, directoryId);
  }
  return { ok: true };
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
  /**
   * Device + inode of `sourcePath` read from the real filesystem at snapshot
   * time. The caller supplies them (this module stays pure and fs-free); a
   * path string alone cannot tell a different directory swapped in at the
   * same path, so the append re-verifies this pair. Omitted when the caller
   * could not read them: the entry then stays path-only.
   */
  sourceDevice?: string;
  sourceInode?: string;
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
  identity?: { device: string; inode: string };
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
      ...(input.identity !== undefined
        ? { sourceDevice: input.identity.device, sourceInode: input.identity.inode }
        : {}),
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
