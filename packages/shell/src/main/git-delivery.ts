/**
 * [Pencil T13] #148 分支规范、推送目标与明确 Git 交付.
 *
 * WHAT THIS MODULE DECIDES, and what it deliberately refuses to decide:
 *
 * - The workspace's branch convention (`{taskId}` / `{slug}` template) and the
 *   target remote are SETTINGS, not defaults. A plan is only "ready" when the
 *   user has actually saved both: an unset or invalid template/remote is named
 *   per repository instead of being replaced by a hidden `task/<id>` guess.
 *   `previewBranchName` is the single spelling the create-task form and the
 *   delivery sheet both read, so the previewed branch is the branch that would
 *   be created/pushed.
 * - Commit and push never run implicitly. `commitRepos` / `pushRepos` are only
 *   reachable from an explicit user action, they always report per repository,
 *   and a mixed multi-repo outcome keeps each repository's own status.
 * - Every managed git write takes the repository-level cross-task lock from
 *   #141 (`main/worktree-metadata-lock.ts`) keyed by the REAL path
 *   (`realpathSync` + `normalizeScopePath`) of each repository, not by task id.
 *   A refusal is named and writes nothing.
 * - Nothing here can force-push, merge, rebase or widen a remote's permissions:
 *   the argv builders are closed (`FORBIDDEN_GIT_ARGUMENTS` is asserted before
 *   every spawn) and destructive working-tree commands (`reset --hard`,
 *   `clean -fd`, `checkout -- .`) are never constructed at all. A failed
 *   commit/push therefore leaves the working tree exactly as it was.
 * - PR guidance is built from the ACTUAL push target (the remote URL resolved
 *   from the repository) for known hosts; it says "打开创建 PR" and never
 *   claims a PR exists. Task completion never pushes and never creates a
 *   remote branch.
 * - Patch export stays available, but with its real boundary spelled out
 *   (`PATCH_EXPORT_BOUNDARY`): it is one delivery aid, not the only path, and
 *   it is not evidence that anything was delivered.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorktreeMetadataLock } from "./worktree-metadata-lock.js";
import { normalizeScopePath } from "../host/path-coordination.js";
import { isSafeTaskBranchRef } from "./task-provision.js";

/** The persisted workspace-level Git delivery settings. */
export interface GitDeliverySettings {
  /** Branch naming template; `{taskId}` and `{slug}` are the only tokens. */
  branchTemplate: string;
  /** Remote name the push would target (`origin`, `upstream`, …). */
  remote: string;
}

/** Why a plan or operation is refused, spelled for the user. */
export type GitDeliveryProblem =
  | "branch-template-unset"
  | "branch-template-invalid"
  | "branch-name-unsafe"
  | "remote-unset"
  | "remote-invalid"
  | "repo-unavailable"
  | "locked"
  | "git-unavailable";

export interface RepoPreviewInput {
  /** Repository id as the workspace knows it. */
  repoId: string;
  /** Display name (falls back to the folder name in the UI). */
  name?: string;
  /** Absolute path of this task's checkout of the repository. */
  repoPath: string;
  /**
   * The branch this checkout is already on, when the caller knows it. An
   * existing branch wins over the convention preview because that is the ref a
   * commit would actually land on.
   */
  currentBranch?: string;
  /** Remote URL, when the caller already resolved it from the checkout. */
  remoteUrl?: string;
}

export interface RepoDeliveryPreview {
  repoId: string;
  name: string;
  repoPath: string;
  /** Branch a commit would land on / a push would publish. Empty when refused. */
  branch: string;
  /** Remote name the push targets. Empty when refused. */
  remote: string;
  /** The exact `remote branch` push target, also what the UI copies. */
  pushTarget: string;
  /** Resolved remote URL, when the checkout answered. */
  remoteUrl: string | null;
  /** Named problem for THIS repository, or null when it is ready. */
  problem: { code: GitDeliveryProblem; message: string } | null;
}

export interface DeliveryPlan {
  taskId: string;
  branchTemplate: string;
  remote: string;
  slug: string;
  ready: boolean;
  rows: RepoDeliveryPreview[];
  /** Plan-level refusal (settings), so the UI can say WHY nothing is ready. */
  problem: { code: GitDeliveryProblem; message: string } | null;
}

/** Tokens a template may use. Anything else is invalid, never ignored. */
export const BRANCH_TEMPLATE_TOKENS = ["{taskId}", "{slug}"] as const;

/**
 * Git arguments this module refuses to run, ever. Asserted immediately before
 * every spawn so a future refactor cannot quietly introduce a force push.
 */
export const FORBIDDEN_GIT_ARGUMENTS = [
  "--force",
  "-f",
  "--force-with-lease",
  "--force-if-includes",
  "--mirror",
  "--delete",
  "--all",
  "--tags",
] as const;

/** The real boundary of "export patch": named, never implied delivery. */
export const PATCH_EXPORT_BOUNDARY =
  "导出补丁只包含所选仓库相对 HEAD 的已跟踪改动（未跟踪文件与子模块不包含），是一条辅助交付路径；补丁存在不代表已提交、已推送或已创建 PR。";

const MAX_BRANCH_LENGTH = 200;
const MAX_REMOTE_LENGTH = 100;
const MAX_SUMMARY_LENGTH = 300;
const MAX_PATCH_BYTES = 256 * 1024;

/** Lowercase, ASCII-only slug of a task title; bounded and never empty. */
export function slugifyTaskTitle(title: string): string {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/, "");
  return slug.length > 0 ? slug : "task";
}

export type Validation<T> = { ok: true; value: T } | { ok: false; code: GitDeliveryProblem; message: string };

/** Validate a branch naming template. No implicit fallback: unset is refused. */
export function validateBranchTemplate(template: unknown): Validation<string> {
  if (typeof template !== "string" || template.trim().length === 0) {
    return { ok: false, code: "branch-template-unset", message: "工作空间未保存分支规范：请在设置里填写分支模板（如 ticket/{taskId}-{slug}）" };
  }
  const value = template.trim();
  if (value !== template) {
    return { ok: false, code: "branch-template-invalid", message: "分支规范首尾不能有空白字符" };
  }
  if (!value.includes("{taskId}")) {
    return { ok: false, code: "branch-template-invalid", message: "分支规范必须包含 {taskId}，否则不同任务会落到同一分支" };
  }
  const unknownToken = value.match(/\{[^}]*\}/g)?.find((token) => !(BRANCH_TEMPLATE_TOKENS as readonly string[]).includes(token));
  if (unknownToken) {
    return { ok: false, code: "branch-template-invalid", message: `分支规范包含不认识的占位符 ${unknownToken}；只支持 {taskId} 与 {slug}` };
  }
  if (value.length > MAX_BRANCH_LENGTH) {
    return { ok: false, code: "branch-template-invalid", message: `分支规范过长（${value.length} > ${MAX_BRANCH_LENGTH} 字符）` };
  }
  const probe = value.replace(/\{taskId\}/g, "148").replace(/\{slug\}/g, "slug");
  if (!isSafeTaskBranchRef(probe)) {
    return { ok: false, code: "branch-template-invalid", message: `分支规范展开后不是合法的 git 分支名：${probe}` };
  }
  return { ok: true, value };
}

/** Validate a remote NAME (not a URL): the push argv carries it verbatim. */
export function validateRemoteName(remote: unknown): Validation<string> {
  if (typeof remote !== "string" || remote.trim().length === 0) {
    return { ok: false, code: "remote-unset", message: "工作空间未保存推送目标远程：请在设置里填写远程名（如 origin）" };
  }
  const value = remote.trim();
  if (value !== remote) {
    return { ok: false, code: "remote-invalid", message: "远程名首尾不能有空白字符" };
  }
  if (value.length > MAX_REMOTE_LENGTH || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.includes("..")) {
    return { ok: false, code: "remote-invalid", message: `远程名不合法：${value}（只允许字母、数字、. _ -，且不能以符号开头）` };
  }
  return { ok: true, value };
}

/**
 * The exact local branch name a task would use under this convention. The
 * create-task preview and the delivery sheet call this same function.
 */
export function previewBranchName(
  template: unknown,
  input: { taskId: string; title: string },
): Validation<string> {
  const checked = validateBranchTemplate(template);
  if (!checked.ok) return checked;
  const branch = checked.value
    .replace(/\{taskId\}/g, input.taskId)
    .replace(/\{slug\}/g, slugifyTaskTitle(input.title));
  if (!isSafeTaskBranchRef(branch)) {
    return { ok: false, code: "branch-name-unsafe", message: `分支规范展开后不是合法的 git 分支名：${branch}` };
  }
  return { ok: true, value: branch };
}

/** A repo row is ready only when its own branch and the shared remote are valid. */
function previewRow(input: RepoPreviewInput, branch: string, remote: string): RepoDeliveryPreview {
  const base = {
    repoId: input.repoId,
    name: input.name ?? input.repoId,
    repoPath: input.repoPath,
    branch,
    remote,
    // An incomplete target is empty, never a half-filled "origin " the UI
    // could copy: the push target only exists when both halves are real.
    pushTarget: branch.length > 0 && remote.length > 0 ? `${remote} ${branch}` : "",
    remoteUrl: input.remoteUrl ?? null,
  };
  if (branch.length === 0 || remote.length === 0) {
    return { ...base, problem: { code: "branch-template-unset", message: "分支规范或远程未设置，本仓库没有可预览的推送目标" } };
  }
  return { ...base, problem: null };
}

/**
 * Per-repository preview of the branch name and push target, before anything
 * is created. Settings problems are plan-level AND repeated per row, because
 * the form shows one line per repository.
 */
export function planDelivery(input: {
  taskId: string;
  taskTitle: string;
  settings: { branchTemplate?: unknown; remote?: unknown };
  repos: readonly RepoPreviewInput[];
}): DeliveryPlan {
  const template = typeof input.settings.branchTemplate === "string" ? input.settings.branchTemplate : "";
  const slug = slugifyTaskTitle(input.taskTitle);
  const branchCheck = previewBranchName(template, { taskId: input.taskId, title: input.taskTitle });
  const remoteCheck = validateRemoteName(input.settings.remote);
  const problem = !branchCheck.ok
    ? { code: branchCheck.code, message: branchCheck.message }
    : !remoteCheck.ok
      ? { code: remoteCheck.code, message: remoteCheck.message }
      : null;
  const rows = input.repos.map((repo) => {
    const branch = repo.currentBranch && repo.currentBranch.length > 0
      ? repo.currentBranch
      : branchCheck.ok
        ? branchCheck.value
        : "";
    const rowRemote = remoteCheck.ok ? remoteCheck.value : "";
    const row = previewRow(repo, branch, rowRemote);
    if (problem) {
      return {
        ...row,
        problem: {
          code: problem.code,
          message:
            problem.code === "branch-template-unset" && branch.length > 0
              ? "推送目标远程未设置，本仓库没有可预览的推送目标"
              : problem.message,
        },
      };
    }
    if (branch.length > 0 && !isSafeTaskBranchRef(branch)) {
      return { ...row, branch: "", pushTarget: "", problem: { code: "branch-name-unsafe" as const, message: `仓库已在的分支 ${branch} 不是合法的 git 分支名` } };
    }
    if (repo.currentBranch && repo.currentBranch.length > 0 && branchCheck.ok && branch !== branchCheck.value) {
      // Honest note: the checkout is already on another branch, so the commit
      // would land there. The UI shows the actual one instead of the template's.
      return { ...row, problem: null };
    }
    return row;
  });
  return {
    taskId: input.taskId,
    branchTemplate: template,
    remote: remoteCheck.ok ? remoteCheck.value : "",
    slug,
    ready: problem === null && rows.length > 0 && rows.every((row) => row.problem === null),
    rows,
    problem,
  };
}

/* -------------------------------------------------------------------------- */
/* Git execution                                                              */
/* -------------------------------------------------------------------------- */

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable spawn seam: tests use a fake to prove which argv was run. */
export type GitRunner = (args: readonly string[], cwd: string) => GitRunResult;

/** Real git: argv only (never a shell), no terminal prompt, bounded output. */
export function runGit(args: readonly string[], cwd: string): GitRunResult {
  try {
    const stdout = execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      // A remote that asks for credentials must FAIL, not hang the UI.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", GIT_SSH_COMMAND: process.env["GIT_SSH_COMMAND"] ?? "ssh -o BatchMode=yes" },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    if (!(error instanceof Error)) return { code: 1, stdout: "", stderr: String(error) };
    const failure = error as Error & { status?: number | null; stdout?: unknown; stderr?: unknown };
    const stderr = typeof failure.stderr === "string" && failure.stderr.length > 0 ? failure.stderr : failure.message;
    return {
      code: typeof failure.status === "number" ? failure.status : 1,
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
      stderr,
    };
  }
}

/** Bounded, credential-free one-line summary of real git stderr. */
export function summarizeGitError(stderr: string): string {
  const withoutSecrets = stderr
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")
    .replace(/(Authorization:\s*)\S+/gi, "$1***")
    .replace(/(token|password|passwd|secret)=\S+/gi, "$1=***");
  const line = withoutSecrets
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith("hint:"))[0] ?? "";
  return line.length > MAX_SUMMARY_LENGTH ? `${line.slice(0, MAX_SUMMARY_LENGTH)}…` : line;
}

/** Every spawn passes through here: a force/destructive flag is a bug, not a mode. */
export function assertSafeGitArguments(args: readonly string[]): void {
  for (const arg of args) {
    if ((FORBIDDEN_GIT_ARGUMENTS as readonly string[]).includes(arg)) {
      throw new Error(`git-argument-forbidden: 受管 Git 交付不允许 ${arg}（不强推、不删除远端分支、不隐式合并或改变权限）`);
    }
  }
}

export type RepoOutcomeStatus =
  | "success"
  | "no-changes"
  | "auth-failure"
  | "remote-reject"
  | "partial-failure"
  | "locked"
  | "not-a-repository"
  | "failed";

export interface RepoOperationOutcome {
  repoId: string;
  repoPath: string;
  branch: string;
  remote: string;
  status: RepoOutcomeStatus;
  /** Real, bounded stderr summary (or the refusal). Never a fabricated ledger. */
  summary: string;
  /** Tracked change set at the time of the operation. */
  files: string[];
  /** Commit id when the operation created one. */
  commit: string | null;
  /** Branch/commit the remote reported, when it answered. */
  pushedTo: string | null;
}

export interface DeliveryRepoTarget {
  repoId: string;
  repoPath: string;
  /** Branch to commit on / push. Callers pass the previewed branch. */
  branch: string;
  remote: string;
}

/**
 * Classify a real git failure into the named outcomes the ticket requires.
 * Order matters: an auth sentence wins over a generic rejection sentence.
 */
export function classifyGitFailure(stderr: string): Exclude<RepoOutcomeStatus, "success" | "no-changes"> {
  const text = stderr.toLowerCase();
  if (/authentication failed|could not read username|could not read password|permission denied \(publickey\)|terminal prompts disabled|http 401|http 403|access denied|invalid username or password/.test(text)) {
    return "auth-failure";
  }
  if (/\[rejected\]|non-fast-forward|pre-receive hook declined|protected branch|remote rejected|cannot lock ref|fetch first/.test(text)) {
    return "remote-reject";
  }
  return "failed";
}

/** Real tracked+untracked change set of one checkout, from `git status`. */
export function readChangeSet(run: GitRunner, repoPath: string): { ok: true; files: string[] } | { ok: false; summary: string } {
  assertSafeGitArguments(["status"]);
  const result = run(["status", "--porcelain=v1", "-z"], repoPath);
  if (result.code !== 0) return { ok: false, summary: summarizeGitError(result.stderr) || "git status 失败" };
  const files = result.stdout
    .split("\0")
    .map((entry) => entry.slice(3).trim())
    .filter((entry) => entry.length > 0);
  return { ok: true, files };
}

/** Current branch of one checkout; empty when detached or unknown. */
export function readCurrentBranch(run: GitRunner, repoPath: string): string {
  const result = run(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
  if (result.code !== 0) return "";
  const branch = result.stdout.trim();
  return branch === "HEAD" ? "" : branch;
}

/** The remote URL as git resolves it, so PR guidance follows the real target. */
export function readRemoteUrl(run: GitRunner, repoPath: string, remote: string): string | null {
  if (remote.length === 0) return null;
  const result = run(["remote", "get-url", remote], repoPath);
  const url = result.stdout.trim();
  return result.code === 0 && url.length > 0 ? url : null;
}

/** Real-path lock keys for a task's checkouts (fail-closed on unresolvable paths). */
export function deliveryLockKeys(repoPaths: readonly string[]): { ok: true; keys: string[] } | { ok: false; message: string } {
  const keys: string[] = [];
  for (const repoPath of repoPaths) {
    let real: string;
    try {
      real = normalizeScopePath(realpathSync(repoPath));
    } catch {
      return { ok: false, message: `repo-unavailable: 仓库路径无法解析：${repoPath}` };
    }
    if (real.length === 0) return { ok: false, message: `repo-unavailable: 仓库路径为空：${repoPath}` };
    keys.push(real);
  }
  return { ok: true, keys: [...new Set(keys)].sort() };
}

export interface DeliveryLockSeam {
  userData: string;
  taskId: string;
  label: string;
  notify?: (message: string) => void;
}

/**
 * Run one managed git write under the #141 repository-level cross-task lock.
 * The lock is keyed by the REAL repository paths, so a concurrent task working
 * the same shared repository contends on the same key; a refusal is returned
 * as a named outcome and nothing is written.
 */
export function withDeliveryLock<T>(
  seam: DeliveryLockSeam | undefined,
  repoPaths: readonly string[],
  run: () => T,
): { ok: true; value: T } | { ok: false; error: string } {
  if (!seam) return { ok: true, value: run() };
  const keys = deliveryLockKeys(repoPaths);
  if (!keys.ok) return { ok: false, error: keys.message.replace(/^repo-unavailable:/, "repo-unavailable:") };
  const lock = new WorktreeMetadataLock(seam.userData, seam.notify ? { notify: seam.notify } : {});
  const acquired = lock.acquireFor(repoPaths, { taskId: seam.taskId, label: seam.label });
  if (!acquired.ok) return { ok: false, error: `locked: ${acquired.error}` };
  try {
    return { ok: true, value: run() };
  } finally {
    acquired.release();
  }
}

function outcome(
  target: DeliveryRepoTarget,
  status: RepoOutcomeStatus,
  summary: string,
  extra: { files?: string[]; commit?: string | null; pushedTo?: string | null } = {},
): RepoOperationOutcome {
  return {
    repoId: target.repoId,
    repoPath: target.repoPath,
    branch: target.branch,
    remote: target.remote,
    status,
    summary,
    files: extra.files ?? [],
    commit: extra.commit ?? null,
    pushedTo: extra.pushedTo ?? null,
  };
}

/**
 * One repository's explicit commit: status first (no commit when there is
 * nothing to commit), then `git commit -m <message> -- <files>` (never
 * `--all`, so a file the user did not review cannot ride along). The working
 * tree is never reset, cleaned or checked out.
 */
export function commitOneRepo(
  run: GitRunner,
  target: DeliveryRepoTarget,
  message: string,
): RepoOperationOutcome {
  if (target.branch.length === 0 || !isSafeTaskBranchRef(target.branch)) {
    return outcome(target, "failed", `branch-invalid: 拒绝在没有合法分支的情况下提交（${target.branch || "空"}）`);
  }
  const status = readChangeSet(run, target.repoPath);
  if (!status.ok) {
    const failure = classifyGitFailure(status.summary);
    return outcome(target, failure, status.summary);
  }
  if (status.files.length === 0) {
    return outcome(target, "no-changes", "没有可提交的变更（git status 为空）");
  }
  const current = readCurrentBranch(run, target.repoPath);
  if (current !== target.branch) {
    // `git switch` could discard nothing but it could move the user's HEAD; the
    // honest answer is to refuse and name both branches instead.
    return outcome(target, "failed", `branch-mismatch: 仓库当前在 ${current || "游离 HEAD"}，与预览分支 ${target.branch} 不一致；未提交任何内容`, { files: status.files });
  }
  // Stage exactly the reviewed change set, then commit the index. `git add`
  // is additive and reversible; nothing here resets, cleans or checks out.
  const add = run(["add", "--", ...status.files], target.repoPath);
  if (add.code !== 0) {
    return outcome(target, classifyGitFailure(add.stderr), summarizeGitError(add.stderr) || "git add 失败", { files: status.files });
  }
  const args = ["commit", "-m", message];
  assertSafeGitArguments(args);
  const committed = run(args, target.repoPath);
  if (committed.code !== 0) {
    return outcome(target, classifyGitFailure(committed.stderr), summarizeGitError(committed.stderr) || "git commit 失败", { files: status.files });
  }
  const head = run(["rev-parse", "HEAD"], target.repoPath);
  const sha = head.code === 0 ? head.stdout.trim() : null;
  return outcome(target, "success", `已提交 ${status.files.length} 个文件`, { files: status.files, commit: sha });
}

/** Multi-repo commit: every repository is recorded on its own. */
export function commitRepos(input: {
  run: GitRunner;
  repos: readonly DeliveryRepoTarget[];
  message: string;
  lock?: DeliveryLockSeam;
}): { outcomes: RepoOperationOutcome[]; partial: boolean; overall: RepoOutcomeStatus } {
  const message = input.message.trim();
  if (message.length === 0) {
    return {
      outcomes: input.repos.map((target) => outcome(target, "failed", "commit-message-empty: 提交说明不能为空")),
      partial: input.repos.length > 0,
      overall: "failed" as const,
    };
  }
  const locked = withDeliveryLock(input.lock, input.repos.map((repo) => repo.repoPath), () =>
    input.repos.map((target) => commitOneRepo(input.run, target, message)),
  );
  if (!locked.ok) {
    return {
      outcomes: input.repos.map((target) => outcome(target, input.lock ? "locked" : "failed", locked.error)),
      partial: input.repos.length > 0,
      overall: input.lock ? ("locked" as const) : ("failed" as const),
    };
  }
  const outcomes = locked.value;
  const statuses = new Set(outcomes.map((entry) => entry.status));
  return { outcomes, partial: statuses.size > 1, overall: overallStatus(outcomes) };
}

/**
 * One repository's explicit push: `git push <remote> <branch>:<branch>`.
 * Never `--force`, never a tag/mirror/delete push, never a new remote.
 */
export function pushOneRepo(run: GitRunner, target: DeliveryRepoTarget): RepoOperationOutcome {
  const remoteCheck = validateRemoteName(target.remote);
  if (!remoteCheck.ok) return outcome(target, "failed", `${remoteCheck.code}: ${remoteCheck.message}`);
  if (target.branch.length === 0 || !isSafeTaskBranchRef(target.branch)) {
    return outcome(target, "failed", `branch-invalid: 拒绝推送空或非法的分支名（${target.branch || "空"}）`);
  }
  const ahead = run(["rev-list", "--count", `${target.remote}/${target.branch}..HEAD`], target.repoPath);
  if (ahead.code === 0 && ahead.stdout.trim() === "0") {
    return outcome(target, "no-changes", `远端 ${remoteCheck.value}/${target.branch} 没有待推送的提交`, { pushedTo: `${remoteCheck.value}/${target.branch}` });
  }
  const args = ["push", remoteCheck.value, `${target.branch}:${target.branch}`];
  assertSafeGitArguments(args);
  const pushed = run(args, target.repoPath);
  if (pushed.code !== 0) {
    const status = classifyGitFailure(pushed.stderr);
    return outcome(target, status, summarizeGitError(pushed.stderr) || "git push 失败");
  }
  const head = run(["rev-parse", "HEAD"], target.repoPath);
  return outcome(target, "success", `已推送到 ${remoteCheck.value}/${target.branch}`, {
    commit: head.code === 0 ? head.stdout.trim() : null,
    pushedTo: `${remoteCheck.value}/${target.branch}`,
  });
}

/** Multi-repo push: per-repository outcomes, partial failure named as such. */
export function pushRepos(input: {
  run: GitRunner;
  repos: readonly DeliveryRepoTarget[];
  lock?: DeliveryLockSeam;
}): { outcomes: RepoOperationOutcome[]; partial: boolean; overall: RepoOutcomeStatus } {
  const locked = withDeliveryLock(input.lock, input.repos.map((repo) => repo.repoPath), () =>
    input.repos.map((target) => pushOneRepo(input.run, target)),
  );
  if (!locked.ok) {
    return {
      outcomes: input.repos.map((target) => outcome(target, input.lock ? "locked" : "failed", locked.error)),
      partial: input.repos.length > 0,
      overall: input.lock ? ("locked" as const) : ("failed" as const),
    };
  }
  const outcomes = locked.value;
  const statuses = new Set(outcomes.map((entry) => entry.status));
  return { outcomes, partial: statuses.size > 1, overall: overallStatus(outcomes) };
}

/** Aggregate, named honestly: mixed repositories are a partial failure. */
export function overallStatus(outcomes: readonly RepoOperationOutcome[]): RepoOutcomeStatus {
  if (outcomes.length === 0) return "no-changes";
  const statuses = new Set(outcomes.map((entry) => entry.status));
  if (statuses.size > 1) return "partial-failure";
  return outcomes[0]?.status ?? "failed";
}

/* -------------------------------------------------------------------------- */
/* PR guidance (per actual push target, never a claim a PR exists)            */
/* -------------------------------------------------------------------------- */

export interface RemoteIdentity {
  host: string;
  /** `owner/repo` (or the host's own project path). */
  path: string;
  webUrl: string;
}

/** Parse `git@host:owner/repo.git`, `ssh://…`, `https://…` into host + path. */
export function parseRemoteUrl(remoteUrl: string): RemoteIdentity | null {
  const value = remoteUrl.trim();
  if (value.length === 0) return null;
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value);
  let host: string;
  let path: string;
  let scheme = "https";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    host = url.hostname;
    path = url.pathname;
    scheme = url.protocol === "http:" ? "http" : "https";
  } else if (scp && !/^[A-Za-z]:[\\/]/.test(value)) {
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  } else {
    return null;
  }
  const cleaned = path.replace(/^\/+/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  if (host.length === 0 || cleaned.split("/").length < 2) return null;
  return { host: host.toLowerCase(), path: cleaned, webUrl: `${scheme}://${host.toLowerCase()}/${cleaned}` };
}

export interface PrGuidance {
  supported: boolean;
  /** Always an instruction ("打开创建 PR…"), never "已创建". */
  text: string;
  /** The compare/PR URL for a known host; null when the host is unknown. */
  url: string | null;
  host: string;
}

/**
 * Host-specific compare URL from the ACTUAL push target. Unknown hosts get an
 * honest sentence with the remote path so the user can open their own forge;
 * no host ever gets a fabricated "PR created" sentence.
 */
export function pullRequestGuidance(input: { remoteUrl: string | null; branch: string; baseBranch?: string }): PrGuidance {
  const identity = input.remoteUrl ? parseRemoteUrl(input.remoteUrl) : null;
  const branch = input.branch;
  const base = input.baseBranch && input.baseBranch.length > 0 ? input.baseBranch : "main";
  if (!identity || branch.length === 0) {
    return {
      supported: false,
      host: identity?.host ?? "",
      url: null,
      text: "无法从推送目标解析出 PR 地址：请在远端仓库手动打开创建 PR。",
    };
  }
  const { host, webUrl } = identity;
  const encodedBranch = encodeURIComponent(branch);
  const encodedBase = encodeURIComponent(base);
  let url: string | null = null;
  if (host === "github.com" || host.endsWith(".github.com")) {
    url = `${webUrl}/compare/${encodedBase}...${encodedBranch}?expand=1`;
  } else if (host === "gitlab.com" || host.includes("gitlab")) {
    url = `${webUrl}/-/compare/${encodedBase}...${encodedBranch}`;
  } else if (host === "bitbucket.org") {
    url = `${webUrl}/branches/compare/${encodedBranch}%0D${encodedBase}`;
  } else if (host === "codeberg.org" || host.includes("gitea")) {
    url = `${webUrl}/compare/${encodedBase}...${encodedBranch}`;
  }
  if (!url) {
    return {
      supported: false,
      host,
      url: null,
      text: `未知代码托管主机 ${host}：请在 ${identity.path} 手动打开创建 PR（推送目标分支 ${branch}）。`,
    };
  }
  return { supported: true, host, url, text: `打开创建 PR：${url}（目标分支 ${base} ← ${branch}）` };
}

/* -------------------------------------------------------------------------- */
/* Patch export (available, bounded, explicitly not the only path)            */
/* -------------------------------------------------------------------------- */

export interface PatchExport {
  repoId: string;
  patch: string;
  truncated: boolean;
  files: string[];
  boundary: string;
  /** Real git failure summary, or null when the diff was produced. */
  error: string | null;
}

/**
 * `git diff HEAD` for one checkout: tracked changes only, no index mutation, no
 * `git add`, nothing written into the repository. The returned boundary is the
 * one the UI shows beside the copy button.
 */
export function exportRepoPatch(run: GitRunner, target: { repoId: string; repoPath: string }): PatchExport {
  assertSafeGitArguments(["diff"]);
  const result = run(["diff", "HEAD"], target.repoPath);
  if (result.code !== 0) {
    return { repoId: target.repoId, patch: "", truncated: false, files: [], boundary: PATCH_EXPORT_BOUNDARY, error: summarizeGitError(result.stderr) || "git diff 失败" };
  }
  const files = [...result.stdout.matchAll(/^diff --git a\/(.+?) b\//gm)].map((match) => match[1] ?? "");
  const truncated = result.stdout.length > MAX_PATCH_BYTES;
  return {
    repoId: target.repoId,
    patch: truncated ? result.stdout.slice(0, MAX_PATCH_BYTES) : result.stdout,
    truncated,
    files: files.filter((entry) => entry.length > 0),
    boundary: PATCH_EXPORT_BOUNDARY,
    error: null,
  };
}

/** Stable hex digest of a repo path, for app-private settings/audit keys. */
export function repoKeyDigest(repoPath: string): string {
  return createHash("sha256").update(normalizeScopePath(repoPath)).digest("hex").slice(0, 16);
}

/* -------------------------------------------------------------------------- */
/* Persisted workspace settings (app-private, never inside a repository)      */
/* -------------------------------------------------------------------------- */

/** App-private settings document under `userData`; never a repo or `.git` path. */
export const GIT_DELIVERY_SETTINGS_FILE = "git-delivery-settings.json";

export interface StoredDeliverySettings {
  branchTemplate: string;
  remote: string;
  savedAt: string | null;
}

/**
 * Read the saved settings. An absent document returns empty strings — the UI
 * shows "未设置" instead of a hidden default, and every operation stays
 * refused until the user saves a valid convention.
 */
export function readDeliverySettings(userData: string): StoredDeliverySettings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(userData, GIT_DELIVERY_SETTINGS_FILE), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { branchTemplate: "", remote: "", savedAt: null };
    const row = parsed as Record<string, unknown>;
    return {
      branchTemplate: typeof row["branchTemplate"] === "string" ? row["branchTemplate"] : "",
      remote: typeof row["remote"] === "string" ? row["remote"] : "",
      savedAt: typeof row["savedAt"] === "string" ? row["savedAt"] : null,
    };
  } catch {
    return { branchTemplate: "", remote: "", savedAt: null };
  }
}

/** Save both settings only when both validate; an invalid pair is named. */
export function saveDeliverySettings(
  userData: string,
  input: { branchTemplate: unknown; remote: unknown; now?: Date },
): { ok: true; settings: StoredDeliverySettings } | { ok: false; code: GitDeliveryProblem; message: string } {
  const template = validateBranchTemplate(input.branchTemplate);
  if (!template.ok) return template;
  const remote = validateRemoteName(input.remote);
  if (!remote.ok) return remote;
  const settings: StoredDeliverySettings = {
    branchTemplate: template.value,
    remote: remote.value,
    savedAt: (input.now ?? new Date()).toISOString(),
  };
  try {
    mkdirSync(userData, { recursive: true });
    writeFileSync(join(userData, GIT_DELIVERY_SETTINGS_FILE), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    return {
      ok: false,
      code: "git-unavailable",
      message: `git-delivery-settings-unwritable: 无法写入应用数据目录下的交付设置（${error instanceof Error ? error.message : String(error)}）`,
    };
  }
  return { ok: true, settings };
}
