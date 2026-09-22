/**
 * Renderer-local task-form helpers for [PiDock 02] (#5), S2 slice.
 *
 * Pure, dependency-free module (no Node, no Electron, no workspace
 * sharing): renderer pages import this for the create-task form while main
 * and the per-task Host keep using the shell-side `task-provision.ts`. The rules mirror each other — Chinese display name,
 * auto `task-oooooooo` dir id, editable branch, absolute default root +
 * per-creation override + live path preview — but the renderer never
 * imports the shell module (that would hand the sandbox Node access).
 * A `task-provision-parity.test.ts` below locks the shared contract.
 */

import type { ProjectDirectory, Task, TaskDirectory } from "./types";

/**
 * Stable in-task symlink name from the prototype's `directoryLinkName`:
 * `dir-` plus the first 8 alphanumerics of the directory id, lowercased. The
 * Chinese display name never becomes a folder or link name.
 */
export function directoryLinkName(directory: Pick<ProjectDirectory, "id">): string {
  return `dir-${directory.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toLowerCase()}`;
}

/** `root / workspaceKey / linkName`; `linkName` may be omitted for the task folder itself. */
export function workspacePath(root: string, workspaceKey: string, linkName = ""): string {
  const base = `${root.replace(/[\\/]+$/, "")}/${workspaceKey}`;
  return linkName ? `${base}/${linkName}` : base;
}

/**
 * A fresh `task-<8 位英文数字标识>` workspace key. The create-task form previews
 * one and hands the same value to the adapter, so the shown path is the path the
 * created task actually gets (matching the prototype's `pendingWorkspaceKey`).
 */
export function newWorkspaceKey(): string {
  const source = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2);
  const hex = source.replace(/[^0-9a-f]/gi, "").toLowerCase().slice(0, 8).padEnd(8, "0");
  return `task-${hex}`;
}

/** The in-task path of a directory's symlink. */
export function directoryLinkPath(workspaceRoot: string, workspaceKey: string, directory: Pick<TaskDirectory, "linkName">): string {
  return workspacePath(workspaceRoot, workspaceKey, directory.linkName);
}

/** Snapshot a project directory into a task, attaching its stable link name. */
export function toTaskDirectory(directory: ProjectDirectory): TaskDirectory {
  return { ...directory, linkName: directoryLinkName(directory) };
}

/**
 * A task made only of ordinary directories: no Git worktree, so the task page
 * must not offer branch / remote / worktree / diff / commit entry points.
 */
export function isDirectoryOnlyTask(task: Task): boolean {
  return task.repos.length === 0 && task.directories.length > 0;
}

/** Trailing separators are ignored when detecting duplicate directory paths. */
export function normalizeDirectoryPath(path: string): string {
  return path.trim().replace(/[\\/]+$/, "");
}

export const TASK_DIR_PREFIX = "task-" as const;
export const TASK_BRANCH_PREFIX = "task/" as const;

export type TaskFormErrorCode =
  | "empty-name"
  | "invalid-root"
  | "identifier-conflict"
  | "fetch-failed"
  | "invalid-branch";

export interface TaskFormError {
  code: TaskFormErrorCode;
  message: string;
}

/** Directory ids are machine names: `task-` + exactly 8 lowercase hex chars. */
export function isTaskDirId(value: string): boolean {
  return /^task-[0-9a-f]{8}$/.test(value);
}

/** Display names may be Chinese; they must simply be non-blank. */
export function validateTaskFormName(name: unknown): { ok: true; name: string } | { ok: false; error: TaskFormError } {
  if (typeof name !== "string" || name.trim().length === 0) {
    return { ok: false, error: { code: "empty-name", message: "请填写任务名称" } };
  }
  return { ok: true, name: name.trim() };
}

/**
 * A task root must be absolute so task folders are never created relative
 * to the process working directory. Mirrors the shell-side rule (POSIX,
 * `~/`, Windows drive, UNC) so the form rejects what the Host would reject.
 */
export function isAbsoluteTaskFormRoot(root: string): boolean {
  const value = root.trim();
  return (
    value.startsWith("/") ||
    value.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^\\\\[^\\]+\\[^\\]+/.test(value)
  );
}

/**
 * Resolve the effective task root. The default persists in local settings;
 * a per-creation override wins for this task only and never migrates tasks
 * created earlier (the caller stores the resolved root on the task record).
 */
export function resolveTaskFormRoot(
  defaultRoot: string,
  overrideRoot?: string,
): { ok: true; root: string; overridden: boolean } | { ok: false; error: TaskFormError } {
  const candidate = overrideRoot !== undefined ? overrideRoot : defaultRoot;
  if (typeof candidate !== "string" || !isAbsoluteTaskFormRoot(candidate)) {
    return { ok: false, error: { code: "invalid-root", message: "任务根目录不可用，请填写完整的本机绝对路径" } };
  }
  const root = candidate.trim().replace(/[\\/]+$/, "") || candidate.trim();
  return {
    ok: true,
    root,
    overridden: overrideRoot !== undefined && overrideRoot.trim() !== defaultRoot.trim(),
  };
}

/** Detect a directory-identifier conflict against already-used ids. */
export function checkTaskFormDirIdConflict(dirId: string, usedDirIds: readonly string[]): TaskFormError | null {
  if (usedDirIds.includes(dirId)) {
    return { code: "identifier-conflict", message: `任务目录标识 ${dirId} 已存在，请重新生成` };
  }
  return null;
}

export interface TaskFormPaths {
  /** Task folder: the pi working directory (cwd). */
  taskDir: string;
  /** Per-repo worktree directories under the task folder. */
  worktrees: Record<string, string>;
  /** Per-directory symlink names under the task folder. */
  links: Record<string, string>;
}

function isSafeTaskFormChildName(name: string): boolean {
  if (typeof name !== "string" || name.length === 0) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  if (name.trim() !== name) return false;
  return true;
}

/** Preview the real paths before creation (what the form shows is what is stored). */
export function previewTaskFormPaths(
  root: string,
  dirId: string,
  repoNames: readonly string[],
  linkNames: readonly string[],
): TaskFormPaths {
  for (const name of [...repoNames, ...linkNames]) {
    if (!isSafeTaskFormChildName(name)) {
      throw new Error(`invalid-path: task child name must be a single safe component: ${name}`);
    }
  }
  const base = `${root.trim().replace(/[\\/]+$/, "")}/${dirId}`;
  const worktrees: Record<string, string> = {};
  for (const name of repoNames) worktrees[name] = `${base}/${name}`;
  const links: Record<string, string> = {};
  for (const name of linkNames) links[name] = `${base}/${name}`;
  return { taskDir: base, worktrees, links };
}

/**
 * Editable task branch, stored separately from the display name and the
 * directory id. Defaults to `task/<dirId>`; a custom value must be a
 * non-blank, space-free ref fragment (mirrors the shell-side rule).
 */
export function buildTaskFormBranch(
  dirId: string,
  custom?: string,
): { ok: true; branch: string } | { ok: false; error: TaskFormError } {
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

const TASK_FORM_COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

/**
 * Pin the remote baseline fetched for this creation. A missing/blank commit
 * means the fetch failed: the caller keeps the form and offers a retry
 * instead of creating from a stale reference.
 */
export function pinTaskFormBaseline(
  remoteBranch: string,
  fetchedCommit: string,
): { ok: true; remoteBranch: string; commit: string } | { ok: false; error: TaskFormError } {
  if (remoteBranch.trim().length === 0 || !TASK_FORM_COMMIT_PATTERN.test(fetchedCommit.trim())) {
    return { ok: false, error: { code: "fetch-failed", message: "获取远程基线失败，已保留表单，请重试获取后再创建" } };
  }
  return { ok: true, remoteBranch: remoteBranch.trim(), commit: fetchedCommit.trim().toLowerCase() };
}
