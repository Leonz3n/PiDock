import type { PidockBridge } from "./shellBridge";

export const CREATION_RETENTION_NOTICE = "磁盘上的任务目录、工作区、链接与会话都会保留（不会替你删除）";

/** How the task treats its Git sources ([Pencil T02] #137). */
export type WorkspaceModeView = "worktree" | "existing-git" | "plain-dirs";
export const WORKSPACE_MODE_LABELS: Record<WorkspaceModeView, string> = {
  worktree: "独立 Worktree（默认）",
  "existing-git": "已有 Git 目录",
  "plain-dirs": "仅普通目录",
};
export interface CreationIntentView {
  id: string; taskId: string; name: string; projectId: string; taskDir: string; root: string; branch: string;
  state: "pending" | "complete";
  workspaceMode: WorkspaceModeView;
  repos: { id: string; name: string; remote: string; remoteBranch: string; commit: string; repoDir: string; path?: string }[];
  directories: { id: string; name: string; linkName: string; path: string }[];
}
export interface CreationInput {
  projectId: string; name: string;
  repositories: { sourceId: string; remote: string; remoteBranch: string }[];
  directoryIds: string[]; sharedWriteConfirmed: boolean; override: boolean;
  workspaceMode: WorkspaceModeView;
}
function parse(value: unknown): CreationIntentView {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("本机任务创建意图返回异常");
  const row = value as Record<string, unknown>;
  for (const key of ["id", "taskId", "name", "projectId", "taskDir", "root", "branch"])
    if (typeof row[key] !== "string" || !row[key]) throw new Error("本机任务创建意图返回异常");
  if ((row.state !== "pending" && row.state !== "complete") || !Array.isArray(row.repos) || !Array.isArray(row.directories) ||
      !row.repos.every((repo) => repo && typeof repo === "object" && typeof repo.commit === "string" && typeof repo.repoDir === "string" && typeof repo.name === "string" &&
        (repo.path === undefined || typeof repo.path === "string")) ||
      !row.directories.every((dir) => dir && typeof dir === "object" && typeof dir.linkName === "string" && typeof dir.path === "string" && typeof dir.name === "string")) {
    throw new Error("本机任务创建意图返回异常");
  }
  // A legacy intent written before the mode existed is migrated by main; a
  // payload that still has no mode is named by its sources, never guessed from
  // the UI. An unknown mode is a broken answer, not a default.
  const mode = row.workspaceMode === undefined
    ? ((row.repos as unknown[]).length > 0 ? "worktree" : "plain-dirs")
    : row.workspaceMode;
  if (mode !== "worktree" && mode !== "existing-git" && mode !== "plain-dirs") throw new Error("本机任务创建意图返回异常");
  return { ...(value as CreationIntentView), workspaceMode: mode };
}
async function request(bridge: PidockBridge, input: Parameters<NonNullable<PidockBridge["createTask"]>>[0]): Promise<unknown> {
  if (typeof bridge.createTask !== "function") throw new Error("桌面壳真实任务创建接口不可用，请重启应用");
  const result = await bridge.createTask(input);
  if (!result || result.ok !== true) throw new Error(result?.error || "创建任务失败，请检查本机数据后重试");
  return result.payload;
}
export async function currentCreation(bridge: PidockBridge): Promise<CreationIntentView | null> {
  const value = await request(bridge, { op: "current" });
  return value === null ? null : parse(value);
}
export async function prepareCreation(bridge: PidockBridge, input: CreationInput): Promise<CreationIntentView | null> {
  const value = await request(bridge, { op: "prepare", input });
  if (!value || typeof value !== "object" || !("canceled" in value) || typeof value.canceled !== "boolean") throw new Error("本机任务创建预览返回异常");
  if (value.canceled) return null;
  if (!("intent" in value)) throw new Error("本机任务创建预览返回异常");
  return parse(value.intent);
}
/**
 * #88: main only abandons a creation on explicit operator confirmation, and the
 * answer states what it did **not** delete (the task folder, worktrees, links
 * and sessions stay). The caller shows that sentence: the user has to know the
 * half-made workspace is still there before creating a replacement.
 */
/**
 * [Pencil T08]: which resources an abandon touches. `keep` is the
 * historical behaviour (nothing is deleted); `owned` removes only resources
 * whose ownership and identity main confirms and never the user's source.
 */
export type AbandonCleanupView = "keep" | "owned";
export async function abandonCreation(bridge: PidockBridge, id: string, cleanup: AbandonCleanupView = "keep"): Promise<string> {
  // `cleanup` is sent only when it changes the default: a keep abandon keeps
  // the exact request surface it always had.
  const value = await request(bridge, { op: "abandon", id, confirmed: true, ...(cleanup === "owned" ? { cleanup } : {}) });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("放弃创建结果返回异常，请重读确认");
  const row = value as Record<string, unknown>;
  if (row.abandoned !== true || typeof row.message !== "string" || !row.message) throw new Error("放弃创建结果返回异常，请重读确认");
  return row.message;
}
export async function commitCreation(bridge: PidockBridge, id: string): Promise<string> {
  const value = await request(bridge, { op: "commit", id });
  if (!value || typeof value !== "object" || !("taskId" in value) || typeof value.taskId !== "string") throw new Error("本机任务创建结果返回异常，请重读确认");
  return value.taskId;
}

/** [Pencil T08]: one repository's real provisioning state. */
export type RepoPhaseView = "pending" | "created" | "failed";
export interface CreationRepoStatusView {
  repoDir: string;
  phase: RepoPhaseView;
  label: string;
  branch: string;
  baseCommit: string;
  worktreePath: string;
  managed: boolean;
  createdByPidock: boolean;
  failure?: { code: string; detail: string };
  previousFailure?: { code: string; detail: string };
  orphan?: { commit: string; adoptable: boolean };
}
export interface CreationStatusView {
  intent: { id: string; taskId: string; name: string; taskDir: string; root: string; branch: string;
    state: "pending" | "complete" | "abandoned"; workspaceMode: WorkspaceModeView } | null;
  repos: CreationRepoStatusView[];
  directories: { id: string; name: string; path: string; linkName: string; linkPresent: boolean }[];
  canRetry: boolean;
  canAdoptOrphans: boolean;
  createdRepos: number;
  message: string;
}
function repoStatus(value: unknown): CreationRepoStatusView {
  const row = value as Record<string, unknown>;
  if (!row || typeof row !== "object" || typeof row.repoDir !== "string" || !row.repoDir ||
      (row.phase !== "pending" && row.phase !== "created" && row.phase !== "failed") ||
      typeof row.branch !== "string" || typeof row.worktreePath !== "string" || typeof row.baseCommit !== "string" ||
      typeof row.managed !== "boolean" || typeof row.createdByPidock !== "boolean") {
    throw new Error("任务准备状态返回异常");
  }
  // A failed row MUST carry its named code: an unnamed failure is a broken
  // payload, never a bare "失败" the surface would have to guess about.
  const failure = row.phase === "failed" ? failureView(row.failure) : undefined;
  if (row.phase === "failed" && !failure) throw new Error("任务准备状态返回异常");
  return {
    repoDir: row.repoDir as string, phase: row.phase as RepoPhaseView,
    label: typeof row.label === "string" && row.label ? row.label : row.phase,
    branch: row.branch as string, baseCommit: row.baseCommit as string, worktreePath: row.worktreePath as string,
    managed: row.managed as boolean, createdByPidock: row.createdByPidock as boolean,
    ...(failure ? { failure } : {}),
    ...(failureView(row.previousFailure) ? { previousFailure: failureView(row.previousFailure)! } : {}),
    ...(orphanView(row.orphan) ? { orphan: orphanView(row.orphan)! } : {}),
  };
}
function failureView(value: unknown): { code: string; detail: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.code !== "string" || !row.code || typeof row.detail !== "string" || !row.detail) return undefined;
  return { code: row.code, detail: row.detail };
}
function orphanView(value: unknown): { commit: string; adoptable: boolean } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.commit !== "string" || typeof row.adoptable !== "boolean") return undefined;
  return { commit: row.commit, adoptable: row.adoptable };
}
/** Read-only per-repository recovery state; never derived from the page. */
export async function creationStatus(bridge: PidockBridge): Promise<CreationStatusView> {
  const value = await request(bridge, { op: "status" });
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row !== "object" || Array.isArray(row) || !Array.isArray(row.repos) ||
      typeof row.canRetry !== "boolean" || typeof row.canAdoptOrphans !== "boolean" ||
      typeof row.createdRepos !== "number" || typeof row.message !== "string" || row.message.length === 0) {
    throw new Error("任务准备状态返回异常");
  }
  const intent = row.intent === null ? null : row.intent as Record<string, unknown>;
  if (intent !== null && (typeof intent !== "object" || typeof intent.taskId !== "string" || typeof intent.taskDir !== "string")) {
    throw new Error("任务准备状态返回异常");
  }
  return {
    intent: intent === null ? null : { id: String(intent.id), taskId: String(intent.taskId), name: String(intent.name),
      taskDir: String(intent.taskDir), root: String(intent.root), branch: String(intent.branch),
      state: (intent.state === "complete" || intent.state === "abandoned" ? intent.state : "pending"),
      workspaceMode: (intent.workspaceMode === "existing-git" || intent.workspaceMode === "plain-dirs" ? intent.workspaceMode : "worktree") },
    repos: row.repos.map((entry) => repoStatus(entry)),
    directories: Array.isArray(row.directories) ? row.directories.map((entry) => {
      const dir = entry as Record<string, unknown>;
      return { id: String(dir.id), name: String(dir.name), path: String(dir.path), linkName: String(dir.linkName), linkPresent: dir.linkPresent === true };
    }) : [],
    canRetry: row.canRetry, canAdoptOrphans: row.canAdoptOrphans, createdRepos: row.createdRepos, message: row.message,
  };
}
/**
 * Retry ONLY the failing repositories (main proves the set from the disk).
 * `adoptOrphanBranches` is the explicit adopt choice for a task branch that
 * exists without a worktree; main never adopts one on its own.
 */
export async function retryCreation(bridge: PidockBridge, id: string, adoptOrphanBranches = false): Promise<{ taskId: string; retried: string[] }> {
  const value = await request(bridge, { op: "retry", id, adoptOrphanBranches });
  const row = value as Record<string, unknown>;
  if (!row || typeof row !== "object" || typeof row.taskId !== "string" || !Array.isArray(row.retried)) {
    throw new Error("任务准备恢复结果返回异常，请重读确认");
  }
  return { taskId: row.taskId, retried: row.retried.filter((entry): entry is string => typeof entry === "string") };
}
