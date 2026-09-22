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
