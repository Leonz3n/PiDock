/**
 * Production task-source append for [PiDock 03] (#6).
 *
 * `TaskWorkspaceHost.appendRepos` plans an append and persists the record,
 * and `shell/taskOp` can route that op, but the op alone neither fetches nor
 * creates anything (the Host is transport-free and never runs git). This
 * module is the missing production front half for an EXISTING task, mirroring
 * the `ProjectTaskCreation` create flow:
 *
 * 1. the selected repositories are resolved from the task's confirmed project
 *    registry association (`repo-` + the first 8 hex of the project repository
 *    id, the same spelling the record and the scan use) — never from a
 *    renderer-supplied path;
 * 2. every NEW repository is fetched in its OWN source checkout and pinned to
 *    the exact fetched commit (`git fetch --no-tags <remote>
 *    refs/heads/<branch>` then `rev-parse FETCH_HEAD`), and the ALL-SUCCESS
 *    gate runs before anything is planned or written: one failed fetch means
 *    no worktree, no record change, and a named, retryable refusal;
 * 3. a task branch that already exists without a worktree refuses with the
 *    create flow's named manual-recovery reason (the same state, the same
 *    words); a branch another worktree holds, or an occupied target path, is
 *    left to the Host's conflict gate so the real `branch-in-use` /
 *    `path-taken` classification reaches the user;
 * 4. the conflict scan is derived by `prepareAppendHostPayload`
 *    (`task-prep-scan.ts`) — that builder has no parameter to supply or omit
 *    the scan — and `task/appendRepos` is routed to the Host, which re-checks
 *    its own guard and persists `repoSources`;
 * 5. the plan the Host returned is executed with real git in each repository's
 *    own checkout, strictly through `assertProvisionPlanSafe` plus the
 *    expected-target/argv validation in `executeAppendPlan`: `fetch`, `branch`
 *    and `worktree add` only, no option-looking argv element (so no `--force`),
 *    and no op in a checkout the caller did not resolve;
 * 6. the appended/skipped repos come back named. Existing worktrees, baselines,
 *    links and the stored root/dirId are never touched. A repo is only reported
 *    as `skipped` when its folder really is THIS task's worktree for the pinned
 *    commit on the task branch; a recorded repo the record lists without such a
 *    worktree (absent, or a foreign leftover / non-worktree in that path) is
 *    refused by name and pointed at the recovery surface instead of being
 *    reported as an idempotent success.
 * 7. `executeResumePlan` executes the plan `task/resumeAppend` returns for a
 *    partial prepare through the SAME `executeAppendPlan` rules, then re-reads
 *    the Host's per-repo status, so a recorded-but-worktree-absent repo is
 *    actually completed in product.
 *
 * Two boundaries are deliberate and stated rather than papered over: the
 * `git fetch` runs before the conflict gate (the scan itself is read
 * immediately before the Host call, but the fetch writes only into the SOURCE
 * checkout, never into the task), and a failure between the Host write and the
 * last `worktree add` leaves an owned partial state which the recovery surface
 * (`task/prepareStatus` + `task/resumeAppend`) both reports AND now completes
 * (main executes the resume plan via `executeResumePlan`).
 */

import { execFileSync } from "node:child_process";
import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import { createNodeRepoProbe, observeRecordedRepo } from "../host/repo-identity.js";
import { readTaskRecordOnDisk, type TaskDiskRecord } from "../host/task-store.js";
import type { HostTaskResult } from "../rpc/protocol.js";
import { createDirectoryLink, linkTargetMatches } from "./directory-link.js";
import {
  buildLinkName,
  checkLinkNameCollisions,
  buildRepoChildName,
  checkRepoConflicts,
  filterAppendRepos,
  previewMixedTaskPaths,
  REMOTE_NAME,
  type RepoSelection,
} from "./multi-repo-provision.js";
import type { GitResourceObservation } from "./task-lifecycle.js";
import {
  assertProvisionPlanSafe,
  isSafeTaskBranchRef,
  isSafeTaskChildName,
  TASK_BRANCH_EXISTS_NO_WORKTREE,
  type ProvisionPlan,
  type ProvisionPlanOp,
  type TaskBranchRefState,
} from "./task-provision.js";
import {
  derivePrepInputs,
  prepareAppendHostPayload,
  type PrepScanAuthorityWithSources,
  type PrepScanDeps,
} from "./task-prep-scan.js";
import {
  WorktreeMetadataLock,
  type WorktreeLockAcquisition,
  type WorktreeLockOwner,
} from "./worktree-metadata-lock.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT = /^[0-9a-f]{40}$/;

/** One repository the page selected, named by project repository id. */
export interface AppendRepoSelection {
  sourceId: string;
  remote: string;
  remoteBranch: string;
}

export interface AppendReposRequest {
  taskId: string;
  repositories?: readonly AppendRepoSelection[];
  directoryIds?: readonly string[];
  sharedWriteConfirmed?: boolean;
}

export interface AppendedRepoTarget {
  repoDir: string;
  name: string;
  remote: string;
  remoteBranch: string;
  /** The exact fetched commit the new worktree was created at. */
  commit: string;
  worktree: string;
}

export interface AppendedRepoSkip {
  repoDir: string;
  name: string;
}

export interface AppendedDirTarget {
  directoryId: string;
  name: string;
  linkName: string;
  sourcePath: string;
  linkPath: string;
}

export interface AppendedDirSkip {
  directoryId: string;
  name: string;
  linkName: string;
}

export interface AppendReposResult {
  taskId: string;
  appended: AppendedRepoTarget[];
  skipped: AppendedRepoSkip[];
  appendedDirs?: AppendedDirTarget[];
  skippedDirs?: AppendedDirSkip[];
}

/**
 * The Host seam: main routes `task/appendRepos` to the task's Host, and
 * re-reads `task/prepareStatus` after executing a resume plan so the caller
 * sees what really happened.
 */
export interface AppendHost {
  routeTaskOp(params: {
    taskId: string;
    op: "task/appendRepos" | "task/appendDirs" | "task/resumeAppend" | "task/prepareStatus";
    payload: Record<string, unknown>;
  }): Promise<HostTaskResult>;
}

/** A repository selected for this append, resolved to its own source checkout. */
export interface AppendTarget {
  repoDir: string;
  name: string;
  remote: string;
  remoteBranch: string;
  /** The machine-local source checkout every git op for this repo runs in. */
  checkout: string;
  /** The freshly fetched commit this target is pinned to. */
  commit: string;
}

/**
 * The git capabilities the append needs. Split out so the ordering rules
 * (all-success gate, branch state, plan execution) are executable without
 * pretending a fake git is a real one: production uses `createNodeAppendGit`
 * and the evidence tests drive real temporary repositories.
 */
export interface AppendGit {
  /**
   * `git fetch --no-tags <remote> refs/heads/<branch>` in the repo's own
   * checkout, then pin the exact fetched commit with `rev-parse FETCH_HEAD`.
   * A failure is reported by category, never as a `null` the caller guesses at.
   */
  fetchAndPin(
    checkout: string,
    remote: string,
    remoteBranch: string,
  ): { ok: true; commit: string } | { ok: false; reason: string };
  /** Canonical top level of `<checkout>`, or `null` when it is not a checkout. */
  topLevel(checkout: string): string | null;
  /** Read-only task-branch probe (`rev-parse --verify --quiet`): present/absent/unknown. */
  probeBranchRef(checkout: string, branch: string): TaskBranchRefState;
  /**
   * Read-only identity observation of a recorded worktree candidate: whether
   * the folder is a linked worktree (not the source checkout or a foreign
   * leftover), the branch its HEAD is on, and whether the pinned base commit
   * is still reachable from that HEAD. `undefined` means nothing verifiable
   * is there and can never read as this task's verified worktree.
   */
  observeWorktree(worktreeDir: string, baseCommit: string): GitResourceObservation | undefined;
  /** Execute one validated plan op with fixed argv in its own cwd. */
  exec(cwd: string, args: readonly string[]): void;
}

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" } as const;

/**
 * Classify a failed fetch so the refusal names the reason (deleted branch /
 * auth / unreachable remote) instead of one opaque message. Unknown text stays
 * a generic failure: this never guesses a cause it cannot see.
 */
export function describeFetchFailure(stderr: string): string {
  const text = stderr.toLowerCase();
  if (/couldn't find remote ref|not our ref|unknown revision|remote branch .* not found/.test(text)) {
    return "远程分支不存在或已删除";
  }
  if (/authentication failed|could not read username|permission denied|repository not found|access denied/.test(text)) {
    return "认证失败或没有访问权限";
  }
  if (/could not resolve host|connection refused|connection timed out|network is unreachable|unable to access/.test(text)) {
    return "网络或远程不可达";
  }
  return "获取失败";
}

export function createNodeAppendGit(): AppendGit {
  const probe = createNodeRepoProbe();
  const run = (cwd: string, args: readonly string[]): { ok: true; stdout: string } | { ok: false; stderr: string } => {
    try {
      const stdout = execFileSync("git", [...args], {
        cwd,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, ...GIT_ENV },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: true, stdout: stdout.trim() };
    } catch (error) {
      const stderr = (error as { stderr?: unknown }).stderr;
      return { ok: false, stderr: typeof stderr === "string" ? stderr : "" };
    }
  };
  return {
    fetchAndPin: (checkout, remote, remoteBranch) => {
      const fetched = run(checkout, ["fetch", "--no-tags", remote, `refs/heads/${remoteBranch}`]);
      if (!fetched.ok) return { ok: false, reason: describeFetchFailure(fetched.stderr) };
      const pinned = run(checkout, ["rev-parse", "FETCH_HEAD"]);
      if (!pinned.ok || !COMMIT.test(pinned.stdout)) return { ok: false, reason: "获取失败" };
      return { ok: true, commit: pinned.stdout };
    },
    topLevel: (checkout) => {
      const top = probe.runGit(["-C", checkout, "rev-parse", "--show-toplevel"]);
      if (top === null || top.length === 0) return null;
      try {
        return realpathSync(top);
      } catch {
        return null;
      }
    },
    probeBranchRef: (checkout, branch) => probe.probeBranchRef(checkout, branch),
    observeWorktree: (worktreeDir, baseCommit) => observeRecordedRepo({ repoDir: worktreeDir, baseCommit }, probe),
    exec: (cwd, args) => {
      const result = run(cwd, args);
      // No raw git stderr crosses this seam: the caller (`ProjectTaskAppend`)
      // wraps a failure in a named refusal that names the repo, so machine
      // paths/tool output never reach the sandboxed page.
      if (!result.ok) throw new Error("append git operation failed");
    },
  };
}

/** One plan op as the Host returned it, validated before it can enter git argv. */
function planOp(value: unknown): ProvisionPlanOp {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("无效的追加计划");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "args,cwd,kind" || typeof row["kind"] !== "string" ||
      typeof row["cwd"] !== "string" || !Array.isArray(row["args"]) ||
      !row["args"].every((arg) => typeof arg === "string" && arg.length > 0 && !arg.includes("\0"))) {
    throw new Error("无效的追加计划");
  }
  return { kind: row["kind"], cwd: row["cwd"], args: [...(row["args"] as string[])] };
}

/** Read one executable plan out of a Host task result, validating the identity. */
function planFromHost(
  taskId: string,
  result: HostTaskResult,
  op: "task/appendRepos" | "task/resumeAppend",
  mismatch: string,
): ProvisionPlan {
  if (result.taskId !== taskId || result.op !== op) throw new Error(mismatch);
  const plan = result.payload["plan"] as unknown;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("追加计划不可读取，请重新核对任务状态");
  const row = plan as Record<string, unknown>;
  if (typeof row["mainCheckoutDir"] !== "string" || !Array.isArray(row["ops"])) {
    throw new Error("追加计划不可读取，请重新核对任务状态");
  }
  return { mainCheckoutDir: row["mainCheckoutDir"], ops: row["ops"].map(planOp) };
}

/** Read the executable plan out of the Host's `task/appendRepos` payload. */
export function appendPlanFromHost(taskId: string, result: HostTaskResult): ProvisionPlan {
  return planFromHost(taskId, result, "task/appendRepos", "追加计划的 Host 身份不符");
}

/** Read the executable plan out of the Host's `task/resumeAppend` payload. */
export function resumePlanFromHost(taskId: string, result: HostTaskResult): ProvisionPlan {
  return planFromHost(taskId, result, "task/resumeAppend", "恢复计划的 Host 身份不符");
}

export interface AppendPlanExpectation {
  taskDir: string;
  branch: string;
  repos: readonly {
    repoDir: string;
    /** Display name used only in a refusal that reaches the user. */
    name: string;
    remote: string;
    remoteBranch: string;
    checkout: string;
    /** The pinned commit the branch op must create the task branch at. */
    commit: string;
  }[];
}

/**
 * Execute the plan the Host returned, strictly:
 *
 * - `assertProvisionPlanSafe` first (no pull/merge/reset of a source checkout);
 * - only `fetch`, `branch` and `worktree` ops, and no argv element may look
 *   like an option, so `--force`/`-f`/`--detach` can never ride a plan;
 * - each op's cwd must be the resolved source checkout of a target repo, and
 *   every buffered `fetch`/`branch` must belong to the `worktree add` that
 *   follows it — `worktree add` is the only way this function mutates a
 *   repository's working copies;
 * - every target repo must be created exactly once; a plan that silently drops
 *   a repo refuses instead of reporting a success it did not achieve.
 */
export function executeAppendPlan(
  input: {
    plan: ProvisionPlan;
    expected: AppendPlanExpectation;
    exec: (cwd: string, args: readonly string[], repo: AppendPlanExpectation["repos"][number]) => void;
  },
): { repoDir: string; worktree: string }[] {
  const { plan, expected, exec } = input;
  const sameDir = (left: string, right: string): boolean =>
    normalize(left).replace(/[\\/]+$/, "") === normalize(right).replace(/[\\/]+$/, "");
  // Per-repo main-checkout guard. The Host's `plan.mainCheckoutDir` is the
  // record's task root, so asserting the whole plan against it is vacuous for
  // an append/resume (every op's cwd is a source checkout). Assert each repo's
  // OWN plan against its source checkout instead — exactly the guard
  // `planMultiRepoWorktrees` applies, so `pull/merge/reset` cannot target a
  // source checkout either.
  for (const repo of expected.repos) {
    assertProvisionPlanSafe({
      mainCheckoutDir: repo.checkout,
      ops: plan.ops.filter((op) => sameDir(op.cwd, repo.checkout)),
    });
  }
  const byWorktree = new Map<string, AppendPlanExpectation["repos"][number]>();
  for (const repo of expected.repos) {
    byWorktree.set(`${expected.taskDir.replace(/[\\/]+$/, "")}/${repo.repoDir}`, repo);
  }
  const created: { repoDir: string; worktree: string }[] = [];
  let buffered: ProvisionPlanOp[] = [];
  for (const op of plan.ops) {
    if (!isAbsolute(op.cwd)) throw new Error("无效的追加计划: cwd 必须是绝对路径");
    for (const arg of op.args) {
      if (arg.startsWith("-")) throw new Error(`无效的追加计划: 不接受选项参数 ${arg}`);
    }
    if (op.kind === "worktree") {
      const [command, action, worktreeDir, branch] = op.args;
      if (command !== "worktree" || action !== "add" || op.args.length !== 4 ||
          typeof worktreeDir !== "string" || typeof branch !== "string") {
        throw new Error("无效的追加计划: 只允许 worktree add <dir> <branch>");
      }
      const repo = byWorktree.get(worktreeDir);
      if (!repo) throw new Error(`无效的追加计划: worktree 目标不在本次追加的仓库中 ${worktreeDir}`);
      if (branch !== expected.branch) throw new Error("无效的追加计划: 任务分支与记录不符");
      if (!sameDir(op.cwd, repo.checkout)) throw new Error(`无效的追加计划: 操作位置与来源检出不符 ${repo.repoDir}`);
      for (const pending of buffered) {
        if (!sameDir(pending.cwd, repo.checkout)) throw new Error(`无效的追加计划: 操作位置与来源检出不符 ${repo.repoDir}`);
        if (pending.kind === "fetch" &&
            (pending.args[0] !== "fetch" || pending.args[1] !== repo.remote || pending.args[2] !== repo.remoteBranch)) {
          throw new Error(`无效的追加计划: 获取操作与所选远程分支不符 ${repo.repoDir}`);
        }
        // The branch op must create the task branch at THIS repo's pinned
        // commit — not merely any 40-hex string a plan might carry.
        if (pending.kind === "branch" &&
            (pending.args[0] !== "branch" || pending.args[1] !== expected.branch || pending.args[2] !== repo.commit)) {
          throw new Error(`无效的追加计划: 分支操作与固定提交不符 ${repo.repoDir}`);
        }
        if (pending.kind !== "fetch" && pending.kind !== "branch") throw new Error(`无效的追加计划: 未知操作 ${pending.kind}`);
      }
      for (const pending of buffered) exec(pending.cwd, pending.args, repo);
      buffered = [];
      exec(op.cwd, op.args, repo);
      created.push({ repoDir: repo.repoDir, worktree: worktreeDir });
      continue;
    }
    if (op.kind !== "fetch" && op.kind !== "branch") throw new Error(`无效的追加计划: 未知操作 ${op.kind}`);
    buffered.push(op);
  }
  if (buffered.length) throw new Error("无效的追加计划: 缺少工作副本创建操作");
  const createdDirs = new Set(created.map((row) => row.repoDir));
  for (const repo of expected.repos) {
    if (!createdDirs.has(repo.repoDir)) throw new Error(`无效的追加计划: 仓库 ${repo.repoDir} 没有工作副本创建操作`);
  }
  return created;
}

/** Canonical spelling of a path that may not exist yet. */
function canonicalPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

function overlaps(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel));
}

/**
 * Device + inode of a registered plain-directory source, read from the REAL
 * filesystem (never from the record or the page). `null` when the path is not
 * an accessible plain directory, so a caller that needs identity fails closed
 * rather than comparing against a missing pair.
 */
function sourceIdentity(path: string): { device: string; inode: string } | null {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.dev <= 0n || stat.ino <= 0n) return null;
    return { device: String(stat.dev), inode: String(stat.ino) };
  } catch {
    return null;
  }
}

/** True when a path exists on disk (`lstatSync`, never following a link). */
function pathPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * `null` when `${taskDir}/${repoDir}` really is THIS task's recorded worktree
 * for the pinned commit on the task branch — otherwise a short user-facing
 * reason. The create flow refuses this same state
 * (`project-task-creation.ts` `commit`); a `skipped` result that cannot be
 * proven here is refused by name instead of reading as an idempotent success.
 * Read-only: it observes, it never takes over or repairs anything.
 */
function verifyRecordedWorktree(
  git: AppendGit,
  input: { worktreeDir: string; taskDir: string; repoDir: string; branch: string; baseCommit: string | undefined },
): string | null {
  const { worktreeDir, taskDir, repoDir, branch, baseCommit } = input;
  let canonicalTaskDir: string;
  let canonicalTarget: string;
  try {
    canonicalTaskDir = realpathSync(taskDir);
    canonicalTarget = realpathSync(worktreeDir);
  } catch {
    return "工作副本不存在";
  }
  if (canonicalTarget !== join(canonicalTaskDir, repoDir)) {
    return "路径不是任务目录下记录的仓库文件夹";
  }
  if (typeof baseCommit !== "string" || baseCommit.length === 0) {
    return "任务记录缺少该仓库的固定基线提交";
  }
  const observed = git.observeWorktree(worktreeDir, baseCommit);
  if (observed === undefined) return "不是可核验的 Git 工作副本";
  if (observed.isWorktree !== true) return "不是本任务的 linked worktree（可能是来源检出或其他检出）";
  if (observed.branch !== branch) {
    return `HEAD 不在任务分支 ${branch}（实际 ${observed.branch ?? "detached"}）`;
  }
  if (observed.baseCommitReachable !== true) return `未包含固定提交 ${baseCommit}`;
  return null;
}

/**
 * The production append. One instance owns the queue for its main process, so
 * two appends — and a resume (`executeResumePlan`) — cannot interleave their
 * fetch/plan/execution phases. That queue is intra-process only; the
 * cross-process half of box 9 is the app-private, real-source-path-keyed lock
 * wired below (`worktree-metadata-lock.ts`), which production builds in
 * `main.ts` from the same `userData` directory the other stores use.
 */
export class ProjectTaskAppend {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly host: AppendHost,
    private readonly authority: PrepScanAuthorityWithSources,
    private readonly deps: PrepScanDeps,
    private readonly git: AppendGit,
    private readonly lock?: WorktreeMetadataLock,
  ) {}

  /**
   * The repository-level mutual exclusion of box 9, keyed by the REAL path of
   * each shared source repository. Without a wired lock this instance has only
   * its intra-process queue — the pre-box-9 behaviour, which production never
   * uses: `main.ts` wires the app-private lock into every creation/append
   * service. `WorktreeMetadataLock.acquireFor` realpaths each source itself and
   * refuses by name when a real path cannot be resolved, so a checkout whose
   * identity is unknown never runs unlocked.
   */
  private acquireWorktreeLock(sources: readonly string[], owner: WorktreeLockOwner): WorktreeLockAcquisition {
    if (!this.lock) return { ok: true, keys: [], release: () => undefined };
    return this.lock.acquireFor(sources, owner);
  }

  /**
   * The conflict re-check taken inside the critical section, immediately before
   * the real worktree adds. It re-derives the scan from the real filesystem and
   * git state (never from the earlier lists) and answers with the gate's own
   * named classification, so a state that changed after the planning scan is
   * refused rather than clobbered, duplicated or left to a generic git error.
   */
  private assertFreshTargetsStillFree(input: {
    taskId: string;
    taskDir: string;
    branch: string;
    appended: readonly string[];
    repos: readonly AppendTarget[];
  }): void {
    const rescanned = derivePrepInputs(
      { taskId: input.taskId, repoDirs: input.repos.map((repo) => repo.repoDir) },
      this.authority,
      this.deps,
    );
    const wanted = previewMixedTaskPaths(input.taskDir, input.appended, []);
    const conflict = checkRepoConflicts({
      wantedWorktreeDirs: input.repos.map((repo) => wanted.worktrees[repo.repoDir]!),
      takenPaths: rescanned.takenPaths,
      branchesInUse: rescanned.branchesInUse,
      wantedBranch: input.branch,
    });
    if (!conflict.ok) throw new Error(`${conflict.error.code}: ${conflict.error.message}`);
  }

  private run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => undefined);
    return result;
  }

  append(request: AppendReposRequest, reattest: () => void = () => undefined): Promise<AppendReposResult> {
    return this.run(() => this.appendOnce(request, reattest));
  }

  /**
   * Wrap every plan-execution git failure in a named refusal that names the
   * repo and the operation, so raw git stderr (machine paths, tool output)
   * never reaches the sandboxed page. The recovery surface is real and
   * executable: re-run the same append/resume, which re-derives its plan from
   * the record and the pinned baselines.
   */
  private runExec(): (
    cwd: string,
    args: readonly string[],
    repo: AppendPlanExpectation["repos"][number],
  ) => void {
    return (cwd, args, repo) => {
      try {
        this.git.exec(cwd, args);
      } catch {
        const code = args[0] === "worktree" ? "worktree-add-failed" : "append-op-failed";
        throw new Error(
          `${code}: 仓库 ${repo.repoDir}（${repo.name}）执行 git ${String(args[0])} 失败，请人工处理后再试`,
        );
      }
    };
  }

  /**
   * Execute the plan `task/resumeAppend` returned for a PARTIAL prepare, then
   * re-read the Host's per-repo status so the caller sees what really
   * happened. The plan is validated and executed by the SAME
   * `executeAppendPlan` rules the append uses (kind whitelist, per-repo cwd
   * binding, no `-`-prefixed argv), so a recorded-but-worktree-absent repo is
   * actually completed instead of being reported as `pending`/`skipped`.
   *
   * Routed through the same per-instance run queue as `append`, so a resume
   * cannot interleave its plan execution with a concurrent append's
   * fetch/plan/write in this process. The plan's execution (the real `git
   * worktree add`) additionally runs inside the cross-process,
   * real-source-path-keyed lock of box 9 (`worktree-metadata-lock.ts`), so it
   * cannot interleave with another process creating a worktree in the same
   * source repository.
   */
  executeResumePlan(
    input: {
      taskId: string;
      planResult: HostTaskResult;
      /** main-derived source checkouts (`repoDir` -> checkout), from the scan. */
      mainCheckouts: Readonly<Record<string, string>>;
    },
    reattest: () => void = () => undefined,
  ): Promise<Record<string, unknown>> {
    return this.run(() => this.executeResumePlanOnce(input, reattest));
  }

  private async executeResumePlanOnce(
    input: {
      taskId: string;
      planResult: HostTaskResult;
      /** main-derived source checkouts (`repoDir` -> checkout), from the scan. */
      mainCheckouts: Readonly<Record<string, string>>;
    },
    reattest: () => void = () => undefined,
  ): Promise<Record<string, unknown>> {
    const { taskId } = input;
    const taskDir = this.authority.resolveTaskDir(taskId);
    if (taskDir === null) throw new Error(`unknown task: ${taskId} 的任务目录不可确认，请先完成创建`);
    let stored;
    try {
      stored = readTaskRecordOnDisk(taskDir);
    } catch {
      throw new Error(`unknown task: ${taskId} 的任务记录不可读取，拒绝在未确认来源的情况下恢复`);
    }
    if (!stored || stored.taskId !== taskId) {
      throw new Error(`unknown task: ${taskId} 的任务记录不存在，拒绝在未确认来源的情况下恢复`);
    }
    const plan = resumePlanFromHost(taskId, input.planResult);
    const payload = input.planResult.payload as Record<string, unknown>;
    const retry = Array.isArray(payload["retry"])
      ? (payload["retry"] as unknown[]).filter((value): value is string => typeof value === "string")
      : [];
    const recorded = new Map((stored.repoSources ?? []).map((source) => [source.repoDir, source]));
    const names = new Map(
      this.authority.repositorySources(taskId).map((source) => [buildRepoChildName(source.id), source.name]),
    );
    const repos: AppendPlanExpectation["repos"][number][] = [];
    for (const repoDir of retry) {
      const source = recorded.get(repoDir);
      const checkout = input.mainCheckouts[repoDir];
      if (!source || typeof checkout !== "string") {
        throw new Error(`repo-unusable: 仓库 ${repoDir} 缺少记录的来源检出或固定基线，无法执行恢复`);
      }
      repos.push({
        repoDir,
        name: names.get(repoDir) ?? repoDir,
        remote: source.remote,
        remoteBranch: source.remoteBranch,
        checkout,
        commit: source.baseCommit,
      });
    }
    if (repos.length > 0) {
      // [PiDock 03] (#6 盒子 9) the worktree adds of a resume run inside the
      // same repository-level critical section as an append: the retry repos'
      // source checkouts are locked by their REAL paths, so a resume cannot
      // create a worktree in a source repository another process is mid-way
      // through. Named boundary: the resume's conflict scan and plan are
      // produced UPSTREAM of this call (the renderer route derives the scan and
      // `task/resumeAppend` plans in the Host), so this acquisition covers the
      // execution, not that earlier scan.
      const acquisition = this.acquireWorktreeLock(repos.map((repo) => repo.checkout), { taskId, label: "任务准备恢复" });
      if (!acquisition.ok) throw new Error(acquisition.error);
      try {
        // Re-attest immediately before the operations that create real
        // resources, the same boundary the append uses.
        reattest();
        executeAppendPlan({
          plan,
          expected: { taskDir, branch: stored.branch, repos },
          exec: this.runExec(),
        });
      } finally {
        // Released on success, on a refusal and on every throw.
        acquisition.release();
      }
    }
    // Truthful result: re-read the Host's real per-repo status instead of
    // returning the plan (which would read as a "planned, not executed"
    // success). `resumed` is true only when this call really executed work.
    const status = await this.host.routeTaskOp({ taskId, op: "task/prepareStatus", payload: {} });
    const statusPayload = (status.payload ?? {}) as Record<string, unknown>;
    return { ...statusPayload, resumed: repos.length > 0 };
  }

  private async appendOnce(request: AppendReposRequest, reattest: () => void): Promise<AppendReposResult> {
    const { taskId } = request;
    if (typeof taskId !== "string" || !isSafeTaskChildName(taskId)) {
      throw new Error("invalid-payload: 任务标识不合法");
    }
    const taskDir = this.authority.resolveTaskDir(taskId);
    if (taskDir === null) throw new Error(`unknown task: ${taskId} 的任务目录不可确认，请先完成创建`);
    // A present-but-unreadable record is the same refusal: never plan against
    // a record main could not confirm.
    let stored;
    try {
      stored = readTaskRecordOnDisk(taskDir);
    } catch {
      throw new Error(`unknown task: ${taskId} 的任务记录不可读取，拒绝在未确认来源的情况下追加`);
    }
    if (!stored || stored.taskId !== taskId) {
      throw new Error(`unknown task: ${taskId} 的任务记录不存在，拒绝在未确认来源的情况下追加`);
    }

    const hasRepoSelections = Array.isArray(request.repositories) && request.repositories.length > 0;
    const hasDirectorySelections = Array.isArray(request.directoryIds) && request.directoryIds.length > 0;
    if (!hasRepoSelections && !hasDirectorySelections) {
      throw new Error("invalid-repo: 请至少选择一个要追加的仓库或目录");
    }

    const requestedDirs: { directoryId: string; name: string; path: string; linkName: string }[] = [];
    const skippedDirs: AppendedDirSkip[] = [];
    const freshDirs: { directoryId: string; name: string; path: string; linkName: string }[] = [];

    if (hasDirectorySelections) {
      if (request.sharedWriteConfirmed !== true) throw new Error("请确认普通目录的共享写入风险");
      const dirSources = this.authority.directorySources(taskId);
      const dirSeen = new Set<string>();
      for (const id of request.directoryIds!) {
        if (!id || typeof id !== "string" || !UUID.test(id)) throw new Error("invalid-payload: 目录选择无效");
        if (dirSeen.has(id)) throw new Error("invalid-repo: 目录重复选择");
        dirSeen.add(id);
        const source = dirSources.find((row) => row.id === id);
        if (!source) throw new Error(`invalid-repo: 目录 ${id} 不在任务所属项目的登记中`);
        const linkName = buildLinkName(source.id);
        requestedDirs.push({ directoryId: source.id, name: source.name, path: source.path, linkName });
      }
      const dirCollision = checkLinkNameCollisions(requestedDirs.map((d) => d.directoryId));
      if (!dirCollision.ok) throw new Error(`${dirCollision.error.code}: ${dirCollision.error.message}`);

      const existingRepos = new Set(stored.repos);
      const existingDirLinks = stored.dirLinks ?? [];
      const existingLinksById = new Map(existingDirLinks.map((l) => [l.directoryId, l]));
      const existingLinksByName = new Map(existingDirLinks.map((l) => [l.linkName, l]));

      for (const dir of requestedDirs) {
        if (existingRepos.has(dir.linkName)) {
          throw new Error(`duplicate-repo: 普通目录链接名 ${dir.linkName} 与现有仓库文件夹冲突`);
        }
        const byName = existingLinksByName.get(dir.linkName);
        if (byName && byName.directoryId !== dir.directoryId) {
          throw new Error(`duplicate-repo: 普通目录链接名冲突: ${dir.directoryId} 与 ${byName.directoryId} 均映射到 ${dir.linkName}`);
        }
        if (existingLinksById.has(dir.directoryId)) {
          const target = join(taskDir, dir.linkName);
          let exists = false;
          try {
            lstatSync(target);
            exists = true;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          }
          if (!exists) {
            throw new Error(`link-missing: 普通目录 ${dir.linkName}（${dir.name}）已记录但软链接不存在，请恢复后再追加`);
          }
          const stat = lstatSync(target);
          if (!stat.isSymbolicLink() || !linkTargetMatches(readlinkSync(target), dir.path)) {
            throw new Error(`link-mismatch: 普通目录 ${dir.linkName}（${dir.name}）已记录但软链接指向不符，请人工处理后再追加`);
          }
          // A matching `readlink` is NOT identity: a DIFFERENT directory
          // swapped in at the same path keeps the link string identical. The
          // record captured the source's device/inode at link time (the same
          // pair the creation flow re-checks), so re-verify it here and fail
          // closed by name. A record written before identity was recorded has
          // no pair and stays path-only: it is never rewritten or invalidated.
          const recorded = existingLinksById.get(dir.directoryId)!;
          if (recorded.sourceDevice !== undefined && recorded.sourceInode !== undefined) {
            const current = sourceIdentity(dir.path);
            if (
              current === null ||
              current.device !== recorded.sourceDevice ||
              current.inode !== recorded.sourceInode
            ) {
              throw new Error(
                `source-changed: 普通目录 ${dir.linkName}（${dir.name}）的来源目录已被替换（设备/索引节点与登记不符），请人工确认后再追加`,
              );
            }
          }
          skippedDirs.push({ directoryId: dir.directoryId, name: dir.name, linkName: dir.linkName });
        } else {
          try {
            const sourceStat = statSync(dir.path);
            if (!sourceStat.isDirectory()) throw new Error("not directory");
          } catch {
            throw new Error(`repo-unusable: 普通目录 ${dir.name} 的来源不可用: ${dir.path}`);
          }
          const realSource = realpathSync(dir.path);
          const realTask = realpathSync(taskDir);
          if (overlaps(realSource, realTask) || overlaps(realTask, realSource)) {
            throw new Error("普通目录与任务工作区重叠");
          }
          const target = join(taskDir, dir.linkName);
          let targetExists = false;
          try {
            lstatSync(target);
            targetExists = true;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          }
          if (targetExists) {
            const stat = lstatSync(target);
            if (!stat.isSymbolicLink() || !linkTargetMatches(readlinkSync(target), dir.path)) {
              throw new Error("path-taken: 目标路径已占用");
            }
          }
          freshDirs.push(dir);
        }
      }
    }

    // Repository paths come from the project registry, never from the page.
    const sources = this.authority.repositorySources(taskId);
    const seen = new Set<string>();
    const requestedRepos: AppendTarget[] = [];
    for (const selection of request.repositories ?? []) {
      if (!selection || typeof selection !== "object" ||
          !UUID.test(String(selection.sourceId)) || !REMOTE_NAME.test(String(selection.remote)) ||
          !isSafeTaskBranchRef(selection.remoteBranch)) {
        throw new Error("invalid-payload: 仓库选择无效，请重新选择远程与基线分支");
      }
      const source = sources.find((row) => row.id === selection.sourceId);
      if (!source) throw new Error(`invalid-repo: 仓库 ${selection.sourceId} 不在任务所属项目的仓库登记中`);
      const repoDir = buildRepoChildName(source.id);
      if (seen.has(repoDir)) throw new Error(`invalid-repo: 仓库 ${repoDir} 被选择了两次，请只保留一个来源`);
      seen.add(repoDir);
      requestedRepos.push({
        repoDir,
        name: source.name,
        remote: selection.remote.trim(),
        remoteBranch: selection.remoteBranch.trim(),
        checkout: source.path,
        commit: "",
      });
    }

    const { appended, skipped } = filterAppendRepos(stored.repos, requestedRepos.map((repo) => repo.repoDir));
    const alreadyRecorded = requestedRepos.filter((repo) => skipped.includes(repo.repoDir));
    // A recorded repo counts as SKIPPED only when its folder really is THIS
    // task's worktree for the pinned commit on the task branch — not merely
    // when something exists on disk. The Host persists `repos` BEFORE main
    // executes anything, so a failed execution leaves a recorded repo whose
    // worktree is absent, and a foreign leftover / non-worktree can occupy the
    // same path; neither may read as an idempotent success. Name what is
    // recorded but missing or mismatched and point at the recovery surface
    // main now EXECUTES (`task/resumeAppend`, see `executeResumePlan`).
    const recordedSources = new Map((stored.repoSources ?? []).map((source) => [source.repoDir, source]));
    const absent = alreadyRecorded.filter((repo) => !pathPresent(join(taskDir, repo.repoDir)));
    if (absent.length > 0) {
      const named = absent.map((repo) => `${repo.repoDir}（${repo.name}）`).join("、");
      throw new Error(
        `worktree-missing: 仓库 ${named}已记录但工作副本不存在，请通过「任务准备恢复」继续准备后再追加`,
      );
    }
    const mismatched = alreadyRecorded.flatMap((repo) => {
      const reason = verifyRecordedWorktree(this.git, {
        worktreeDir: join(taskDir, repo.repoDir),
        taskDir,
        repoDir: repo.repoDir,
        branch: stored.branch,
        baseCommit: recordedSources.get(repo.repoDir)?.baseCommit,
      });
      return reason === null ? [] : [{ repo, reason }];
    });
    if (mismatched.length > 0) {
      const named = mismatched.map(({ repo }) => `${repo.repoDir}（${repo.name}）`).join("、");
      const reasons = mismatched.map(({ reason }) => reason).join("；");
      throw new Error(
        `worktree-mismatch: 仓库 ${named}已记录但工作副本不是本任务在任务分支 ${stored.branch} 上的固定提交（${reasons}），` +
          `请人工处理后再通过「任务准备恢复」继续`,
      );
    }
    const skippedRepos = alreadyRecorded.map((repo) => ({ repoDir: repo.repoDir, name: repo.name }));
    const freshRepos = requestedRepos.filter((repo) => appended.includes(repo.repoDir));

    // If nothing fresh in repos and nothing fresh in dirs:
    if (freshRepos.length === 0 && freshDirs.length === 0) {
      return {
        taskId,
        appended: [],
        skipped: skippedRepos,
        ...(hasDirectorySelections ? { appendedDirs: [], skippedDirs } : {}),
      };
    }

    for (const repo of freshRepos) {
      if (!isAbsolute(repo.checkout) || this.git.topLevel(repo.checkout) !== canonicalPath(repo.checkout)) {
        throw new Error(`repo-unusable: 仓库 ${repo.repoDir}（${repo.name}）的来源检出不可用: ${repo.checkout}`);
      }
    }

    // [PiDock 03] (#6 盒子 9) the repository-level critical section: every fresh
    // repository's source checkout is locked by its REAL path before the fetch,
    // so the fetch/`FETCH_HEAD` pin, the conflict scan (`prepareAppendHostPayload`
    // below), the Host's own `checkRepoConflicts` gate, the re-check of the real
    // state and the real `git worktree add` all run inside ONE cross-process
    // critical section. A competing process (or a second service instance)
    // working the same source repository is refused BY NAME here and creates no
    // branch, no worktree and no metadata record — which is what the
    // intra-process queue above can never provide.
    const acquisition = this.acquireWorktreeLock(freshRepos.map((repo) => repo.checkout), { taskId, label: "追加仓库" });
    if (!acquisition.ok) throw new Error(acquisition.error);
    try {
      return await this.appendFreshRepos({
        taskId,
        taskDir,
        stored,
        freshRepos,
        freshDirs,
        appended,
        skipped: skippedRepos,
        skippedDirs,
        hasDirectorySelections,
        reattest,
      });
    } finally {
      // Released on success, on a refusal and on every throw; a crash leaves the
      // named stale-lock policy (`worktree-metadata-lock.ts`) to clear it.
      acquisition.release();
    }
  }

  /**
   * Everything that must run inside the repository-level critical section,
   * unchanged: pin each fresh repository's fetched commit, derive the conflict
   * scan, route `task/appendRepos`, re-check the real state and execute the plan
   * with real git. Split out only so the acquisition above can wrap it in one
   * `finally` without moving a single rule.
   */
  private async appendFreshRepos(input: {
    taskId: string;
    taskDir: string;
    stored: TaskDiskRecord;
    freshRepos: AppendTarget[];
    freshDirs: { directoryId: string; name: string; path: string; linkName: string }[];
    appended: string[];
    skipped: { repoDir: string; name: string }[];
    skippedDirs: AppendedDirSkip[];
    hasDirectorySelections: boolean;
    reattest: () => void;
  }): Promise<AppendReposResult> {
    const { taskId, taskDir, stored, freshRepos, freshDirs, appended, reattest } = input;
    const skippedRepos = input.skipped;
    const skippedDirs = input.skippedDirs;
    const { hasDirectorySelections } = input;

    // ALL-SUCCESS gate: pin every new repository's freshly fetched commit
    // before anything is planned or written. One failure means no worktree and
    // no record change, and the refusal names the repo and the reason.
    const pinned: AppendTarget[] = [];
    for (const repo of freshRepos) {
      const fetched = this.git.fetchAndPin(repo.checkout, repo.remote, repo.remoteBranch);
      if (!fetched.ok) {
        throw new Error(
          `fetch-failed: 仓库 ${repo.repoDir}（${repo.name}）获取 ${repo.remote}/${repo.remoteBranch} 失败` +
            `（${fetched.reason}），已保留表单，请重试获取后再追加`,
        );
      }
      pinned.push({ ...repo, commit: fetched.commit });
    }

    let plan: ProvisionPlan | null = null;
    let prepTaskDir = taskDir;
    if (pinned.length > 0) {
      const { payload, prep } = prepareAppendHostPayload(
        {
          taskId,
          selections: pinned.map<RepoSelection>((repo) => ({
            repoDir: repo.repoDir,
            remote: repo.remote,
            remoteBranch: repo.remoteBranch,
            mainCheckoutDir: repo.checkout,
          })),
          fetchedCommits: Object.fromEntries(pinned.map((repo) => [repo.repoDir, repo.commit])),
          branch: stored.branch,
        },
        this.authority,
        this.deps,
      );
      prepTaskDir = prep.taskDir;
      const wanted = previewMixedTaskPaths(prep.taskDir, appended, []);
      for (const repo of pinned) {
        const observed = this.git.probeBranchRef(repo.checkout, stored.branch);
        if (observed.state === "unknown") {
          throw new Error(`repo-unusable: 仓库 ${repo.repoDir}（${repo.name}）的任务分支状态无法确认，请人工恢复`);
        }
        if (observed.state === "present" &&
            !prep.branchesInUse.includes(stored.branch) &&
            !prep.takenPaths.includes(wanted.worktrees[repo.repoDir]!)) {
          throw new Error(`${TASK_BRANCH_EXISTS_NO_WORKTREE}（仓库 ${repo.repoDir}）`);
        }
      }
      const result = await this.host.routeTaskOp({ taskId, op: "task/appendRepos", payload });
      plan = appendPlanFromHost(taskId, result);
    }

    // The sender is re-attested immediately before the operations that create
    // real resources, the same boundary the sibling privileged writes use.
    reattest();
    if (freshDirs.length > 0) {
      // Create each link FIRST, then record it (the create flow's order). A
      // crash between the two leaves a correct link the next append records
      // idempotently; the reverse order would leave a recorded link that is
      // absent on disk, which only manual repair could clear.
      for (const dir of freshDirs) {
        const target = join(taskDir, dir.linkName);
        if (!pathPresent(target)) createDirectoryLink(dir.path, target);
      }
      const recorded = await this.host.routeTaskOp({
        taskId,
        op: "task/appendDirs",
        payload: {
          plainDirs: freshDirs.map((d) => ({ directoryId: d.directoryId, sourcePath: d.path })),
        },
      });
      // Truthful commit: the record must name every link we just created, and
      // each link must really exist at its stable name pointing at the source.
      // A missing or wrong entry is a refusal, never a success-shaped result.
      const after = readTaskRecordOnDisk(taskDir);
      const recordedLinks = after?.dirLinks ?? [];
      for (const dir of freshDirs) {
        const target = join(taskDir, dir.linkName);
        if (!recordedLinks.some((link) => link.directoryId === dir.directoryId && link.linkName === dir.linkName && link.sourcePath === dir.path)) {
          throw new Error(`link-missing: 普通目录 ${dir.linkName}（${dir.name}）创建后未记录到任务，请重试追加`);
        }
        const stat = lstatSync(target);
        if (!stat.isSymbolicLink() || !linkTargetMatches(readlinkSync(target), dir.path)) {
          throw new Error(`link-mismatch: 普通目录 ${dir.linkName}（${dir.name}）已创建但指向不符，请人工处理后重试`);
        }
      }
      if (recorded.taskId !== taskId) throw new Error("Host 任务身份不符");
    }

    let created: { repoDir: string; worktree: string }[] = [];
    if (plan !== null && pinned.length > 0) {
      // Re-check the REAL state inside the critical section, immediately before
      // the worktree adds. The planning scan above ran before the Host route
      // (an await) and before the link writes: a competing state that appeared
      // in the meantime — a worktree now holding this task branch, a foreign
      // folder at the wanted path — is refused here BY THE SAME NAMED
      // classification the Host's gate uses (`branch-in-use` / `path-taken`),
      // instead of being left to a generic git failure or a duplicate creation.
      this.assertFreshTargetsStillFree({
        taskId,
        taskDir: prepTaskDir,
        branch: stored.branch,
        appended,
        repos: pinned,
      });
      created = executeAppendPlan({
        plan,
        expected: { taskDir: prepTaskDir, branch: stored.branch, repos: pinned },
        exec: this.runExec(),
      });
    }

    const appendedDirs: AppendedDirTarget[] = freshDirs.map((dir) => ({
      directoryId: dir.directoryId,
      name: dir.name,
      linkName: dir.linkName,
      sourcePath: dir.path,
      linkPath: join(taskDir, dir.linkName),
    }));

    const byRepoDir = new Map(pinned.map((repo) => [repo.repoDir, repo]));
    return {
      taskId,
      appended: created.map((row) => {
        const repo = byRepoDir.get(row.repoDir)!;
        return {
          repoDir: repo.repoDir,
          name: repo.name,
          remote: repo.remote,
          remoteBranch: repo.remoteBranch,
          commit: repo.commit,
          worktree: row.worktree,
        };
      }),
      skipped: skippedRepos,
      ...(hasDirectorySelections ? { appendedDirs, skippedDirs } : {}),
    };
  }
}
