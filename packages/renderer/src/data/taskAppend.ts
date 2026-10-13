/**
 * Renderer view of the production append result for [PiDock 03] (#6).
 *
 * Pure and transport-free: it shapes the payload `shell/appendTaskRepos`
 * returns into what the append surface shows. The renderer never fetches,
 * never scans a worktree and never invents a repo: a payload that does not
 * carry the task's identity and the named per-repo outcome is rejected
 * instead of shown as a successful append.
 */

export interface AppendedRepoView {
  repoDir: string;
  name: string;
  remote: string;
  remoteBranch: string;
  commit: string;
  worktree: string;
}

export interface AppendedRepoSkipView {
  repoDir: string;
  name: string;
}

export interface AppendedDirView {
  directoryId: string;
  name: string;
  linkName: string;
  sourcePath: string;
  linkPath: string;
}

export interface AppendedDirSkipView {
  directoryId: string;
  name: string;
  linkName: string;
}

export interface AppendReposView {
  appended: AppendedRepoView[];
  /** Repositories the task already had: skipped, nothing created twice. */
  skipped: AppendedRepoSkipView[];
  appendedDirs?: AppendedDirView[];
  skippedDirs?: AppendedDirSkipView[];
}

const COMMIT = /^[0-9a-f]{40}$/;

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Parse an append payload for `taskId`. Returns `null` for anything that is
 * not the typed shape (another task, a missing list, a repo without its
 * pinned full commit or its worktree path), so the surface keeps its last
 * known state instead of claiming an append that main did not report.
 */
export function readAppendReposView(payload: unknown, taskId: string): AppendReposView | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (record["taskId"] !== taskId) return null;
  const rawAppended = record["appended"];
  const rawSkipped = record["skipped"];
  if (!Array.isArray(rawAppended) || !Array.isArray(rawSkipped)) return null;
  const appended: AppendedRepoView[] = [];
  for (const entry of rawAppended) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const row = entry as Record<string, unknown>;
    if (Object.keys(row).sort().join(",") !== "commit,name,remote,remoteBranch,repoDir,worktree") return null;
    const repoDir = text(row["repoDir"]);
    const name = text(row["name"]);
    const remote = text(row["remote"]);
    const remoteBranch = text(row["remoteBranch"]);
    const commit = text(row["commit"]);
    const worktree = text(row["worktree"]);
    if (!repoDir || !name || !remote || !remoteBranch || !commit || !worktree || !COMMIT.test(commit)) return null;
    appended.push({ repoDir, name, remote, remoteBranch, commit, worktree });
  }
  const skipped: AppendedRepoSkipView[] = [];
  for (const entry of rawSkipped) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const row = entry as Record<string, unknown>;
    if (Object.keys(row).sort().join(",") !== "name,repoDir") return null;
    const repoDir = text(row["repoDir"]);
    const name = text(row["name"]);
    if (!repoDir || !name) return null;
    skipped.push({ repoDir, name });
  }

  let appendedDirs: AppendedDirView[] | undefined;
  const rawAppendedDirs = record["appendedDirs"];
  if (Array.isArray(rawAppendedDirs)) {
    appendedDirs = [];
    for (const entry of rawAppendedDirs) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const row = entry as Record<string, unknown>;
      const directoryId = text(row["directoryId"]);
      const name = text(row["name"]);
      const linkName = text(row["linkName"]);
      const sourcePath = text(row["sourcePath"]);
      const linkPath = text(row["linkPath"]);
      if (!directoryId || !name || !linkName || !sourcePath || !linkPath) return null;
      appendedDirs.push({ directoryId, name, linkName, sourcePath, linkPath });
    }
  }

  let skippedDirs: AppendedDirSkipView[] | undefined;
  const rawSkippedDirs = record["skippedDirs"];
  if (Array.isArray(rawSkippedDirs)) {
    skippedDirs = [];
    for (const entry of rawSkippedDirs) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const row = entry as Record<string, unknown>;
      const directoryId = text(row["directoryId"]);
      const name = text(row["name"]);
      const linkName = text(row["linkName"]);
      if (!directoryId || !name || !linkName) return null;
      skippedDirs.push({ directoryId, name, linkName });
    }
  }

  return {
    appended,
    skipped,
    ...(appendedDirs !== undefined ? { appendedDirs } : {}),
    ...(skippedDirs !== undefined ? { skippedDirs } : {}),
  };
}
