/**
 * Privileged read-only conflict scan for [PiDock 03] (#6) append/resume
 * (boundary B of the partial-prepare recovery slice).
 *
 * The Host requires `takenPaths` + `branchesInUse` on `task/appendRepos` and
 * `task/resumeAppend` and fails closed without them, but the sandboxed
 * renderer cannot scan: it has no fs and no git. Main is therefore the
 * authoritative producer. For those two ops arriving on the renderer route,
 * main derives both lists from:
 *
 * - the REAL task folder resolved for that task id (its immediate children),
 *   so a taken worktree path is reported even though the page never sees it;
 * - each target repository's OWN source checkout (`git worktree list
 *   --porcelain`, fixed argv through the existing read-only `RepoProbe`
 *   seam), constrained to the task's recorded repositories and to the repos
 *   this call wants to add.
 *
 * The task's own worktrees are excluded: every repository of one task shares
 * the branch `task/<dirId>`, so a union across the task's repositories
 * without that exclusion would report the task's own already-created
 * worktrees as "branch in use" and refuse every partially-created task. A
 * worktree whose path lies inside the resolved task folder belongs to THIS
 * task and is skipped; anything else is genuine foreign usage.
 *
 * Every failure — unreadable task folder, a recorded repo with no
 * confirmable source checkout, a failing/timed-out git — is a named
 * `task-scan-unavailable` refusal. The scan never degrades to `[]`, which
 * would silently disable the path/branch gate.
 *
 * Precedence rule (documented on the guard too): on the renderer route main
 * OVERWRITES a page-supplied `takenPaths`/`branchesInUse`/`mainCheckouts`
 * with the derived values, so the page can neither forge nor disable the
 * gate. Below that boundary the op is unchanged: the Host keeps requiring
 * both lists and a caller that reaches the Host directly (main-internal
 * executor, tests) still supplies its own scan.
 */

import { createNodeRepoProbe, type RepoProbe } from "../host/repo-identity.js";
import { isPathInsideTask } from "../host/task-host.js";
import type { TaskDiskRecord } from "../host/task-store.js";

/** Named refusal for a scan that cannot be produced (never a `[]` fallback). */
export const PREP_SCAN_UNAVAILABLE = "task-scan-unavailable";

export class PrepScanUnavailableError extends Error {
  readonly code = PREP_SCAN_UNAVAILABLE;
  constructor(message: string) {
    super(`${PREP_SCAN_UNAVAILABLE}: ${message}`);
    this.name = "PrepScanUnavailableError";
  }
}

/** One `git worktree list --porcelain` block: its path and attached branch. */
export interface WorktreeListEntry {
  path: string;
  branch: string | null;
}

const BRANCH_REF_PREFIX = "refs/heads/";

/**
 * Parse `git worktree list --porcelain`. Each block starts with
 * `worktree <path>`; an attached worktree adds `branch refs/heads/<name>`
 * (detached worktrees carry `detached` instead and stay `null`), and
 * `bare`/`locked`/`prunable`/`HEAD` lines are not branches. Parsing is
 * deliberately strict: an unknown line is ignored rather than guessed.
 */
export function parseWorktreeList(porcelain: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let path: string | null = null;
  let branch: string | null = null;
  const flush = (): void => {
    if (path !== null) entries.push({ path, branch });
    path = null;
    branch = null;
  };
  for (const raw of porcelain.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("worktree ")) {
      flush();
      path = line.slice("worktree ".length);
      continue;
    }
    if (line.startsWith("branch ") && path !== null) {
      const ref = line.slice("branch ".length);
      branch = ref.startsWith(BRANCH_REF_PREFIX) ? ref.slice(BRANCH_REF_PREFIX.length) : ref;
    }
  }
  flush();
  return entries;
}

/** Injected fs/git access; the real deps are a thin Node wrapper. */
export interface PrepScanDeps {
  /** Immediate children (names only) of a directory. Throws when unreadable. */
  listTaskDir(taskDir: string): readonly string[];
  /** Read-only git probe (fixed argv, no shell); `null` on any failure. */
  probe: Pick<RepoProbe, "runGit">;
  /**
   * Canonicalize a path for the ownership comparison; falls back to the input
   * for a path that no longer exists. Git reports worktree paths canonically
   * (`/tmp/x` is `/private/tmp/x` on macOS), so without this the task's OWN
   * worktree under a symlinked root would read as foreign usage of the task
   * branch and every partially-created resume would refuse itself.
   */
  canonicalPath(path: string): string;
}

export function createNodePrepScanDeps(): PrepScanDeps {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  return {
    listTaskDir: (taskDir: string): readonly string[] => fs.readdirSync(taskDir),
    probe: createNodeRepoProbe(),
    canonicalPath: (path: string): string => {
      try {
        return fs.realpathSync(path);
      } catch {
        return path;
      }
    },
  };
}

export interface PrepConflictScan {
  /** Absolute paths already present in the task folder. */
  takenPaths: string[];
  /** Branches attached to a worktree of a TARGET repo that is not this task's. */
  branchesInUse: string[];
}

/** One target repository and the source checkout its worktrees are listed in. */
export interface TargetCheckout {
  repoDir: string;
  checkout: string;
}

/**
 * Derive the conflict scan. Fail-closed and read-only: it lists the task
 * folder and runs one `git -C <checkout> worktree list --porcelain` per
 * target repo (no fetch, no branch/worktree mutation).
 */
export function scanPrepConflicts(
  input: { taskDir: string; checkouts: readonly TargetCheckout[] },
  deps: PrepScanDeps,
): PrepConflictScan {
  const { taskDir, checkouts } = input;
  let children: readonly string[];
  try {
    children = deps.listTaskDir(taskDir);
  } catch {
    throw new PrepScanUnavailableError(`任务目录不可读取，拒绝在未扫描占用路径的情况下继续: ${taskDir}`);
  }
  if (checkouts.length === 0) {
    throw new PrepScanUnavailableError("没有可扫描的目标仓库，拒绝在未扫描分支占用的情况下继续");
  }
  // Same slash spelling as `previewMixedTaskPaths` (the wanted worktree dirs
  // the Host compares against), so the comparison is one string form.
  const base = taskDir.replace(/[\\/]+$/, "");
  const takenPaths = children.map((name) => `${base}/${name}`);
  // Ownership is a path question, so compare canonical spellings too: a
  // symlinked task root (`/tmp/...` vs `/private/tmp/...`) must not make this
  // task's own worktree look foreign.
  const taskSpellings = new Set([taskDir, deps.canonicalPath(taskDir)]);
  const belongsToThisTask = (worktreePath: string): boolean => {
    for (const spelling of new Set([worktreePath, deps.canonicalPath(worktreePath)])) {
      for (const task of taskSpellings) {
        if (isPathInsideTask(spelling, task)) return true;
      }
    }
    return false;
  };
  const branches = new Set<string>();
  for (const { repoDir, checkout } of checkouts) {
    const listed = deps.probe.runGit(["-C", checkout, "worktree", "list", "--porcelain"]);
    if (listed === null) {
      throw new PrepScanUnavailableError(`仓库 ${repoDir} 的 worktree 列表读取失败，无法确认分支占用: ${checkout}`);
    }
    for (const entry of parseWorktreeList(listed)) {
      if (entry.branch === null) continue;
      // A worktree inside this task's own folder IS this task's worktree: the
      // task's repos all share `task/<dirId>`, so keeping them would make
      // every partially-created task refuse its own branch as in use.
      if (belongsToThisTask(entry.path)) continue;
      branches.add(entry.branch);
    }
  }
  return { takenPaths, branchesInUse: [...branches].sort() };
}

/**
 * The project repository a recorded `repoDir` names. The production creation
 * flow fixed the spelling `repo-` + the first 8 hex characters of the project
 * repository id; an unknown or ambiguous name resolves to `null` (never a
 * guess), which makes the scan refuse instead of scanning the wrong repo.
 */
export function projectRepositoryForRepoDir(
  repoDir: string,
  repositories: readonly { id: string; path: string }[],
): { id: string; path: string } | null {
  const matches = repositories.filter((repository) => repoDir === `repo-${repository.id.slice(0, 8)}`);
  return matches.length === 1 ? matches[0]! : null;
}

/** Recorded repository names of a task (`repos` is the authoritative list). */
export function recordedRepoDirs(record: TaskDiskRecord): string[] {
  return [...record.repos];
}

/** Repo dirs a `task/appendRepos` payload wants to add (shape-tolerant). */
export function selectedRepoDirs(payload: Record<string, unknown>): string[] {
  const selections = payload["repoSelections"];
  if (!Array.isArray(selections)) return [];
  const dirs: string[] = [];
  for (const entry of selections) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const repoDir = (entry as Record<string, unknown>)["repoDir"];
    if (typeof repoDir === "string" && repoDir.length > 0 && !dirs.includes(repoDir)) dirs.push(repoDir);
  }
  return dirs;
}

/**
 * Resolve every target repo's source checkout from the task's project
 * repositories. A repo with no confirmable checkout refuses by name: the
 * branch gate cannot be computed for it, and skipping it would silently
 * weaken the scan.
 */
export function resolveTargetCheckouts(input: {
  repoDirs: readonly string[];
  repositories: readonly { id: string; path: string }[];
}): TargetCheckout[] {
  const checkouts: TargetCheckout[] = [];
  const seen = new Set<string>();
  for (const repoDir of input.repoDirs) {
    if (seen.has(repoDir)) continue;
    seen.add(repoDir);
    const repository = projectRepositoryForRepoDir(repoDir, input.repositories);
    if (!repository) {
      throw new PrepScanUnavailableError(
        `仓库 ${repoDir} 没有可确认的来源检出，无法完成路径与分支占用扫描，请人工处理`,
      );
    }
    checkouts.push({ repoDir, checkout: repository.path });
  }
  return checkouts;
}

/** Main-owned authority the scan derives from (no renderer input). */
export interface PrepScanAuthority {
  /** Task folder resolved for the task id (index-verified), or `null`. */
  resolveTaskDir(taskId: string): string | null;
  readRecord(taskDir: string): TaskDiskRecord | null;
  /** Project repositories of the task's confirmed association. */
  projectRepositories(taskId: string): readonly { id: string; path: string }[];
}

export interface DerivedPrepInputs {
  taskDir: string;
  takenPaths: string[];
  branchesInUse: string[];
  /** Source checkout per repoDir, for the op's git ops (main-owned). */
  mainCheckouts: Record<string, string>;
}

/**
 * Derive the authoritative conflict inputs (and the source checkouts) for one
 * renderer-routed append/resume. Throws `PrepScanUnavailableError` — a named,
 * fail-closed refusal — for every input the authority cannot confirm.
 */
export function derivePrepInputs(
  input: { taskId: string; repoDirs: readonly string[] },
  authority: PrepScanAuthority,
  deps: PrepScanDeps,
): DerivedPrepInputs {
  const taskDir = authority.resolveTaskDir(input.taskId);
  if (taskDir === null) {
    throw new PrepScanUnavailableError(`任务目录无法确认，拒绝在未扫描的情况下继续: ${input.taskId}`);
  }
  const record = authority.readRecord(taskDir);
  if (!record || record.taskId !== input.taskId) {
    throw new PrepScanUnavailableError(`任务记录不可读取，拒绝在未扫描的情况下继续: ${taskDir}`);
  }
  const repoDirs = [...recordedRepoDirs(record), ...input.repoDirs];
  const repositories = authority.projectRepositories(input.taskId);
  const checkouts = resolveTargetCheckouts({ repoDirs, repositories });
  const scan = scanPrepConflicts({ taskDir, checkouts }, deps);
  const mainCheckouts: Record<string, string> = {};
  for (const { repoDir, checkout } of checkouts) mainCheckouts[repoDir] = checkout;
  return { taskDir, takenPaths: scan.takenPaths, branchesInUse: scan.branchesInUse, mainCheckouts };
}

/** The ops that need the privileged scan on the renderer route. */
export type PrepScanOp = "task/appendRepos" | "task/resumeAppend";

export function needsPrepScan(op: string): op is PrepScanOp {
  return op === "task/appendRepos" || op === "task/resumeAppend";
}

export type DerivedPrepPayload =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Build the payload main forwards to the Host for a renderer-routed append or
 * resume: the derived `takenPaths`/`branchesInUse`/`mainCheckouts` OVERWRITE
 * whatever the page sent, so a forged or emptied scan cannot disable the gate
 * the Host keeps requiring.
 */
export function deriveRendererPrepPayload(
  input: { op: PrepScanOp; taskId: string; payload: Record<string, unknown> },
  authority: PrepScanAuthority,
  deps: PrepScanDeps,
): DerivedPrepPayload {
  try {
    const wanted = input.op === "task/appendRepos" ? selectedRepoDirs(input.payload) : [];
    const derived = derivePrepInputs({ taskId: input.taskId, repoDirs: wanted }, authority, deps);
    return {
      ok: true,
      payload: {
        ...input.payload,
        takenPaths: derived.takenPaths,
        branchesInUse: derived.branchesInUse,
        mainCheckouts: derived.mainCheckouts,
      },
    };
  } catch (error) {
    if (error instanceof PrepScanUnavailableError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}
