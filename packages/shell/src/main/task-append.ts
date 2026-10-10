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
 *    links and the stored root/dirId are never touched.
 *
 * Two boundaries are deliberate and stated rather than papered over: the
 * `git fetch` runs before the conflict gate (the scan itself is read
 * immediately before the Host call, but the fetch writes only into the SOURCE
 * checkout, never into the task), and a failure between the Host write and the
 * last `worktree add` leaves an owned partial state which the recovery surface
 * (`task/prepareStatus` + `task/resumeAppend`) reports.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { createNodeRepoProbe } from "../host/repo-identity.js";
import { readTaskRecordOnDisk } from "../host/task-store.js";
import type { HostTaskResult } from "../rpc/protocol.js";
import {
  buildRepoChildName,
  filterAppendRepos,
  previewMixedTaskPaths,
  type RepoSelection,
} from "./multi-repo-provision.js";
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
  prepareAppendHostPayload,
  type PrepScanAuthorityWithSources,
  type PrepScanDeps,
} from "./task-prep-scan.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMMIT = /^[0-9a-f]{40}$/;

/** One repository the page selected, named by project repository id. */
export interface AppendRepoSelection {
  sourceId: string;
  remote: string;
  remoteBranch: string;
}

export interface AppendReposRequest {
  taskId: string;
  repositories: readonly AppendRepoSelection[];
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

export interface AppendReposResult {
  taskId: string;
  appended: AppendedRepoTarget[];
  skipped: AppendedRepoSkip[];
}

/** The Host seam: main routes `task/appendRepos` to the task's Host. */
export interface AppendHost {
  routeTaskOp(params: {
    taskId: string;
    op: "task/appendRepos";
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
    exec: (cwd, args) => {
      const result = run(cwd, args);
      if (!result.ok) throw new Error(result.stderr.trim().split("\n")[0] ?? "");
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

/** Read the executable plan out of the Host's `task/appendRepos` payload. */
export function appendPlanFromHost(taskId: string, result: HostTaskResult): ProvisionPlan {
  if (result.taskId !== taskId || result.op !== "task/appendRepos") throw new Error("追加计划的 Host 身份不符");
  const plan = result.payload["plan"] as unknown;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("追加计划不可读取，请重新核对任务状态");
  const row = plan as Record<string, unknown>;
  if (typeof row["mainCheckoutDir"] !== "string" || !Array.isArray(row["ops"])) {
    throw new Error("追加计划不可读取，请重新核对任务状态");
  }
  return { mainCheckoutDir: row["mainCheckoutDir"], ops: row["ops"].map(planOp) };
}

export interface AppendPlanExpectation {
  taskDir: string;
  branch: string;
  repos: readonly { repoDir: string; remote: string; remoteBranch: string; checkout: string }[];
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
  input: { plan: ProvisionPlan; expected: AppendPlanExpectation; exec: (cwd: string, args: readonly string[]) => void },
): { repoDir: string; worktree: string }[] {
  const { plan, expected, exec } = input;
  assertProvisionPlanSafe(plan);
  const sameDir = (left: string, right: string): boolean =>
    normalize(left).replace(/[\\/]+$/, "") === normalize(right).replace(/[\\/]+$/, "");
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
        if (pending.kind === "branch" &&
            (pending.args[0] !== "branch" || pending.args[1] !== expected.branch || !COMMIT.test(pending.args[2] ?? ""))) {
          throw new Error(`无效的追加计划: 分支操作与固定提交不符 ${repo.repoDir}`);
        }
        if (pending.kind !== "fetch" && pending.kind !== "branch") throw new Error(`无效的追加计划: 未知操作 ${pending.kind}`);
      }
      for (const pending of buffered) exec(pending.cwd, pending.args);
      buffered = [];
      exec(op.cwd, op.args);
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

/**
 * The production append. One instance owns the queue for its main process, so
 * two append clicks cannot interleave their fetch/plan/execution phases; the
 * cross-task/cross-process mutual exclusion for a shared repository stays a
 * separate, still-open concern.
 */
export class ProjectTaskAppend {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly host: AppendHost,
    private readonly authority: PrepScanAuthorityWithSources,
    private readonly deps: PrepScanDeps,
    private readonly git: AppendGit,
  ) {}

  private run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => undefined);
    return result;
  }

  append(request: AppendReposRequest, reattest: () => void = () => undefined): Promise<AppendReposResult> {
    return this.run(() => this.appendOnce(request, reattest));
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
    // Repository paths come from the project registry, never from the page.
    const sources = this.authority.repositorySources(taskId);
    const seen = new Set<string>();
    const requested: AppendTarget[] = [];
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
      requested.push({
        repoDir,
        name: source.name,
        remote: selection.remote.trim(),
        remoteBranch: selection.remoteBranch.trim(),
        checkout: source.path,
        commit: "",
      });
    }
    if (requested.length === 0) throw new Error("invalid-repo: 请至少选择一个要追加的仓库");
    const { appended, skipped } = filterAppendRepos(stored.repos, requested.map((repo) => repo.repoDir));
    const skippedRepos = requested
      .filter((repo) => skipped.includes(repo.repoDir))
      .map((repo) => ({ repoDir: repo.repoDir, name: repo.name }));
    const fresh = requested.filter((repo) => appended.includes(repo.repoDir));
    // Already-present repositories are skipped without a fetch, a worktree or
    // a record write: the append stays idempotent.
    if (fresh.length === 0) return { taskId, appended: [], skipped: skippedRepos };
    for (const repo of fresh) {
      if (!isAbsolute(repo.checkout) || this.git.topLevel(repo.checkout) !== canonicalPath(repo.checkout)) {
        throw new Error(`repo-unusable: 仓库 ${repo.repoDir}（${repo.name}）的来源检出不可用: ${repo.checkout}`);
      }
    }
    // ALL-SUCCESS gate: pin every new repository's freshly fetched commit
    // before anything is planned or written. One failure means no worktree and
    // no record change, and the refusal names the repo and the reason.
    const pinned: AppendTarget[] = [];
    for (const repo of fresh) {
      const fetched = this.git.fetchAndPin(repo.checkout, repo.remote, repo.remoteBranch);
      if (!fetched.ok) {
        throw new Error(
          `fetch-failed: 仓库 ${repo.repoDir}（${repo.name}）获取 ${repo.remote}/${repo.remoteBranch} 失败` +
            `（${fetched.reason}），已保留表单，请重试获取后再追加`,
        );
      }
      pinned.push({ ...repo, commit: fetched.commit });
    }
    // The conflict scan is derived here (the builder takes no scan parameter)
    // and the source checkouts come back with it.
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
    const wanted = previewMixedTaskPaths(prep.taskDir, appended, []);
    // A task branch that exists WITHOUT a worktree is the same manual-recovery
    // state the create flow refuses (same words). A branch another worktree
    // holds, or a taken target path, is left to the Host so the user sees the
    // real `branch-in-use` / `path-taken` classification instead.
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
    const plan = appendPlanFromHost(taskId, result);
    // The sender is re-attested immediately before the operations that create
    // real resources, the same boundary the sibling privileged writes use.
    reattest();
    const created = executeAppendPlan({
      plan,
      expected: { taskDir: prep.taskDir, branch: stored.branch, repos: pinned },
      exec: (cwd, args) => this.git.exec(cwd, args),
    });
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
    };
  }
}
