/**
 * Task provisioning rules for [PiDock 02] (#5), S1 slice.
 *
 * Pure, dependency-free module so it runs identically in main, the
 * utilityProcess Host, and unit tests. It covers the spec boxes that do not
 * need Electron or git:
 *
 * - 中文显示名称、自动英文数字目录标识和可编辑任务分支分别保存
 * - 本机默认任务根目录 + 单次覆盖 + 路径预览；任务保存实际根目录
 * - 路径不可用和标识冲突明确处理（typed errors, no throws for form cases)
 * - 创建前 fetch 并固定提交；获取失败保留表单及重试入口 (pinBaseline)
 * - 不对主检出目录执行 pull/merge/reset (FORBIDDEN_MAIN_OPS + plan guard)
 * - pi 统一以任务文件夹作为启动 cwd，各 worktree 位于其下
 */

export const TASK_DIR_PREFIX = "task-" as const;
export const TASK_BRANCH_PREFIX = "task/" as const;

/** Git operations that must never target the main checkout directory. */
export const FORBIDDEN_MAIN_OPS = ["pull", "merge", "reset"] as const;

export type ProvisionErrorCode =
  | "empty-name"
  | "invalid-root"
  | "identifier-conflict"
  | "fetch-failed"
  | "invalid-branch"
  | "invalid-commit"
  | "forbidden-main-op";

export interface ProvisionError {
  code: ProvisionErrorCode;
  message: string;
}

export interface ProvisionPaths {
  /** Task folder: the pi working directory (cwd). */
  taskDir: string;
  /** Per-repo worktree directories under the task folder. */
  worktrees: Record<string, string>;
  /** Per-directory symlink names under the task folder. */
  links: Record<string, string>;
}

export interface ProvisionPlanOp {
  kind: string;
  cwd: string;
  args: readonly string[];
}

export interface ProvisionPlan {
  ops: ProvisionPlanOp[];
  mainCheckoutDir: string;
}

/**
 * Generate an ASCII-only task directory id (`task-` + 8 hex chars).
 * A sample may be injected for deterministic tests; otherwise crypto-grade
 * randomness is used when available.
 */
export function generateTaskDirId(sample?: string): string {
  if (sample !== undefined) {
    const hex = sample.replace(/[^0-9a-f]/gi, "").toLowerCase().slice(0, 8).padEnd(8, "0");
    return `${TASK_DIR_PREFIX}${hex}`;
  }
  const source =
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2);
  const hex = source.replace(/[^0-9a-f]/gi, "").toLowerCase().slice(0, 8).padEnd(8, "0");
  return `${TASK_DIR_PREFIX}${hex}`;
}

/** Directory ids are machine names: `task-` + exactly 8 lowercase hex chars. */
export function isTaskDirId(value: string): boolean {
  return /^task-[0-9a-f]{8}$/.test(value);
}

/** Display names may be Chinese; they must simply be non-blank. */
export function validateTaskName(name: unknown): { ok: true; name: string } | { ok: false; error: ProvisionError } {
  if (typeof name !== "string" || name.trim().length === 0) {
    return { ok: false, error: { code: "empty-name", message: "请填写任务名称" } };
  }
  return { ok: true, name: name.trim() };
}

/**
 * A task root must be absolute so task folders are never created relative to
 * the process working directory. Mirrors the renderer rule (POSIX, `~/`,
 * Windows drive, UNC).
 */
export function isAbsoluteTaskRoot(root: string): boolean {
  const value = root.trim();
  return (
    value.startsWith("/") ||
    value.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^\\\\[^\\]+\\[^\\]+/.test(value)
  );
}

function stripTrailingSeparators(root: string): string {
  const stripped = root.trim().replace(/[\\/]+$/, "");
  return stripped.length > 0 ? stripped : root.trim();
}

/** Canonical form for comparing task folders across POSIX/Windows spellings. */
export function normalizeTaskPath(value: string): string {
  const noDot = value.trim().replace(/\.([\\/])/g, "$1");
  const stripped = noDot.replace(/[\\/]+$/, "");
  const unified = stripped.replace(/\\/g, "/");
  const withDrive = /^[A-Za-z]:\//.test(unified) ? unified[0].toUpperCase() + unified.slice(1) : unified;
  return withDrive.length > 0 ? withDrive : value.trim();
}

/**
 * Resolve the effective task root. The default persists on the machine; a
 * per-creation override wins for this task only and never migrates tasks
 * created earlier (the caller stores the resolved root on the task record).
 */
export function resolveTaskRoot(
  defaultRoot: string,
  overrideRoot?: string,
): { ok: true; root: string; overridden: boolean } | { ok: false; error: ProvisionError } {
  const candidate = overrideRoot !== undefined ? overrideRoot : defaultRoot;
  if (typeof candidate !== "string" || !isAbsoluteTaskRoot(candidate)) {
    return { ok: false, error: { code: "invalid-root", message: "任务根目录不可用，请填写完整的本机绝对路径" } };
  }
  return {
    ok: true,
    root: stripTrailingSeparators(candidate),
    overridden: overrideRoot !== undefined && overrideRoot.trim() !== defaultRoot.trim(),
  };
}

/** Detect a directory-identifier conflict against already-used ids. */
export function checkDirIdConflict(dirId: string, usedDirIds: readonly string[]): ProvisionError | null {
  if (usedDirIds.includes(dirId)) {
    return { code: "identifier-conflict", message: `任务目录标识 ${dirId} 已存在，请重新生成` };
  }
  return null;
}

/** Single safe path component: no separators, no traversal, non-empty. */
export function isSafeTaskChildName(name: string): boolean {
  if (typeof name !== "string" || name.length === 0) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  if (name.trim() !== name) return false;
  return true;
}

/** Preview the real paths before creation (what the form shows is what is stored). */
export function previewTaskPaths(
  root: string,
  dirId: string,
  repoNames: readonly string[],
  linkNames: readonly string[],
): ProvisionPaths {
  for (const name of [...repoNames, ...linkNames]) {
    if (!isSafeTaskChildName(name)) {
      throw new Error(`invalid-path: task child name must be a single safe component: ${name}`);
    }
  }
  const base = `${stripTrailingSeparators(root)}/${dirId}`;
  const worktrees: Record<string, string> = {};
  for (const name of repoNames) worktrees[name] = `${base}/${name}`;
  const links: Record<string, string> = {};
  for (const name of linkNames) links[name] = `${base}/${name}`;
  return { taskDir: base, worktrees, links };
}

/**
 * Editable task branch, stored separately from the display name and the
 * directory id. Defaults to `task/<dirId>`; a custom value must be a
 * non-blank, space-free ref fragment.
 */
export function buildTaskBranch(
  dirId: string,
  custom?: string,
): { ok: true; branch: string } | { ok: false; error: ProvisionError } {
  if (custom === undefined || custom.trim().length === 0) {
    return { ok: true, branch: `${TASK_BRANCH_PREFIX}${dirId}` };
  }
  const branch = custom.trim();
  // eslint-disable-next-line no-control-regex -- git ref rules forbid control chars; the class is the check.
  const hasControlChar = /[\0-\x1f\x7f]/.test(branch);
  if (
    /[\s~^:?*[\]\\]/.test(branch) ||
    branch.includes("..") ||
    hasControlChar ||
    branch.includes("@{") ||
    branch.endsWith(".lock") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("//")
  ) {
    return { ok: false, error: { code: "invalid-branch", message: "任务分支格式不正确，请使用不含空格的分支名" } };
  }
  return { ok: true, branch };
}

const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

/**
 * Pin the remote baseline fetched for this creation. A missing/blank commit
 * means the fetch failed: the caller keeps the form and offers a retry
 * instead of creating from a stale reference.
 */
export function pinBaseline(
  remoteBranch: string,
  fetchedCommit: string,
): { ok: true; remoteBranch: string; commit: string } | { ok: false; error: ProvisionError } {
  if (remoteBranch.trim().length === 0 || !COMMIT_PATTERN.test(fetchedCommit.trim())) {
    return { ok: false, error: { code: "fetch-failed", message: "获取远程基线失败，已保留表单，请重试获取后再创建" } };
  }
  return { ok: true, remoteBranch: remoteBranch.trim(), commit: fetchedCommit.trim().toLowerCase() };
}

/** Guard: no plan may pull/merge/reset the main checkout directory. */
export function assertProvisionPlanSafe(plan: ProvisionPlan): void {
  const main = normalizeTaskPath(plan.mainCheckoutDir);
  for (const op of plan.ops) {
    if (
      normalizeTaskPath(op.cwd) === main &&
      (FORBIDDEN_MAIN_OPS as readonly string[]).includes(op.kind)
    ) {
      const error: ProvisionError = {
        code: "forbidden-main-op",
        message: `禁止对主检出目录执行 ${op.kind}`,
      };
      throw new Error(`${error.code}: ${error.message}`);
    }
  }
}

export interface WorktreePlanInput {
  taskDir: string;
  mainCheckoutDir: string;
  repoDir: string;
  remoteBranch: string;
  commit: string;
  branch: string;
}

/**
 * Plan the git operations for one repo: fetch the remote branch, pin the
 * fetched commit, then create an independent branch + worktree under the task
 * folder. Never touches the main checkout directory. The cwd for every op
 * is `mainCheckoutDir`, which MUST be an absolute task root so a relative
 * or empty cwd can never enter an executable plan.
 */
export function planWorktreeCreation(input: WorktreePlanInput): ProvisionPlan {
  if (!isSafeTaskChildName(input.repoDir)) {
    throw new Error(`invalid-path: repoDir must be a single safe component: ${input.repoDir}`);
  }
  if (!isAbsoluteTaskRoot(input.mainCheckoutDir)) {
    throw new Error(`invalid-payload: mainCheckoutDir must be an absolute task root: ${input.mainCheckoutDir}`);
  }
  const worktreeDir = `${stripTrailingSeparators(input.taskDir)}/${input.repoDir}`;
  const plan: ProvisionPlan = {
    mainCheckoutDir: input.mainCheckoutDir,
    ops: [
      { kind: "fetch", cwd: input.mainCheckoutDir, args: ["fetch", "origin", input.remoteBranch] },
      {
        kind: "branch",
        cwd: input.mainCheckoutDir,
        args: ["branch", input.branch, input.commit],
      },
      {
        kind: "worktree",
        cwd: input.mainCheckoutDir,
        args: ["worktree", "add", worktreeDir, input.branch],
      },
    ],
  };
  assertProvisionPlanSafe(plan);
  return plan;
}
