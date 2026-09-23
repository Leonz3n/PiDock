/**
 * Renderer view of the [PiDock 10] (#15) task file browser and built-in
 * terminal.
 *
 * The renderer never reads the filesystem or runs git: it renders what the
 * adapter reported and keeps the memory-mode projection for the non-shell
 * case. Parsers here are fail-closed — a payload that does not have the shape
 * the Host documents is dropped instead of being shown as an empty tree, so a
 * broken round-trip never reads like "the task has no files".
 *
 * The rule layer lives Host-side (`main/workspace-files.ts`,
 * `main/terminal-config.ts`); this module only mirrors the view shapes.
 */

import type { Task, WorkspaceFile } from "./types";

export type WorkspaceRootKindView = "worktree" | "shared-dir";

export type WorkspaceRootView = {
  id: string;
  kind: WorkspaceRootKindView;
  label: string;
  path: string;
  repo?: string;
  directoryId?: string;
  sourcePath?: string;
  branch?: string;
  baseCommit?: string;
};

export type WorkspaceAttributionView = {
  taskId: string;
  rootId: string;
  rootKind: WorkspaceRootKindView;
  rootLabel: string;
  repo?: string;
  directoryId?: string;
  /** Unified pi working directory (the task folder). */
  piWorkDir: string;
  linkPath?: string;
  sourcePath?: string;
  sharedNote?: string;
};

export type WorkspaceTreeEntryView = { name: string; path: string; kind: "file" | "dir"; size?: number };

export type WorkspaceTreeView = {
  attribution: WorkspaceAttributionView;
  path: string;
  entries: WorkspaceTreeEntryView[];
  truncated: boolean;
};

export type WorkspacePreviewView = {
  attribution: WorkspaceAttributionView;
  path: string;
  language: string;
  source: string;
  truncated: boolean;
  lineCount?: number;
};

export type WorkspaceDiffView = {
  attribution: WorkspaceAttributionView;
  path: string;
  diff: string;
  truncated: boolean;
};

export type WorkspaceDeliveryView = {
  attribution: WorkspaceAttributionView;
  repo: string;
  branch: string;
  autoCommit: boolean;
  autoPush: boolean;
  autoMerge: boolean;
};

export type TerminalEnvRowView = { key: string; value: string; secret: boolean; source: string };

export type TerminalPlanView = {
  instanceId: string;
  rootId: string;
  attribution: WorkspaceAttributionView;
  program: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  resolved: TerminalEnvRowView[];
  historyLimit: number;
  owner: { taskId: string; sessionId: string | null; label: string };
};

export type TerminalInstanceView = {
  instanceId: string;
  rootId: string;
  attribution: WorkspaceAttributionView;
  program: string;
  args: string[];
  cwd: string;
  owner: { taskId: string; sessionId: string | null; label: string };
  cols: number;
  rows: number;
  envKeys: string[];
  lifecycle: "running" | "exited";
  processKnown: boolean;
  processId?: number;
  startedAt: string;
  exitedAt?: string;
  exitCode?: number;
  exitReason?: string;
};

export type TerminalStateView = {
  /** False while the Host plans/tracks terminals but owns no real pty yet. */
  spawnImplemented: boolean;
  instances: TerminalInstanceView[];
};

export type TerminalHistoryEntryView = { at: string; line: string };

/** Result of one adapter terminal start/stop (agent or labelled human action). */
export type TerminalControlResultView = {
  instanceId: string;
  action: "start" | "stop";
  actor: "agent" | "human";
  /** Present on start; on stop the recorded exit state is reported instead. */
  instance?: TerminalInstanceView;
};

/** What the file panel renders for one task: roots plus the current selection. */
export type WorkspaceBrowserView = {
  taskId: string;
  taskDir: string;
  roots: WorkspaceRootView[];
  selected?: {
    rootId: string;
    relative: string;
    tree?: WorkspaceTreeView;
    preview?: WorkspacePreviewView;
    diff?: WorkspaceDiffView;
    delivery?: WorkspaceDeliveryView;
  };
};

export type WorkspaceBrowserRequest = { rootId?: string; relative?: string };
export type TerminalPlanRequest = {
  instanceId: string;
  rootId: string;
  program: string;
  args?: string[];
  cols?: number;
  rows?: number;
  /** Agent control (session gate) when present; absent = labelled human action. */
  sessionId?: string;
  label?: string;
};
/** Start/stop one terminal: a stop needs only the instance id. */
export type TerminalControlRequest = {
  instanceId: string;
  action: "start" | "stop";
  /** Start only: the root/program/args the Host re-plans and registers. */
  rootId?: string;
  program?: string;
  args?: string[];
  cols?: number;
  rows?: number;
  /** Agent control (session gate) when present; absent = labelled human action. */
  sessionId?: string;
  label?: string;
  approvalId?: string;
};

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? (value as string[]) : undefined;
}

function attribution(value: unknown): WorkspaceAttributionView | undefined {
  const source = record(value);
  if (!source) return undefined;
  const taskId = str(source["taskId"]);
  const rootId = str(source["rootId"]);
  const rootKind = str(source["rootKind"]);
  const rootLabel = str(source["rootLabel"]);
  const piWorkDir = str(source["piWorkDir"]);
  if (
    taskId === undefined ||
    rootId === undefined ||
    (rootKind !== "worktree" && rootKind !== "shared-dir") ||
    rootLabel === undefined ||
    piWorkDir === undefined
  ) {
    return undefined;
  }
  const repo = str(source["repo"]);
  const directoryId = str(source["directoryId"]);
  const linkPath = str(source["linkPath"]);
  const sourcePath = str(source["sourcePath"]);
  const sharedNote = str(source["sharedNote"]);
  return {
    taskId,
    rootId,
    rootKind,
    rootLabel,
    piWorkDir,
    ...(repo !== undefined ? { repo } : {}),
    ...(directoryId !== undefined ? { directoryId } : {}),
    ...(linkPath !== undefined ? { linkPath } : {}),
    ...(sourcePath !== undefined ? { sourcePath } : {}),
    ...(sharedNote !== undefined ? { sharedNote } : {}),
  };
}

/** Parse the `task/fileRoots` payload; `undefined` when the shape is unusable. */
export function workspaceRootsFromHost(payload: unknown): { roots: WorkspaceRootView[]; taskDir: string } | undefined {
  const source = record(payload);
  const taskDir = source ? str(source["taskDir"]) : undefined;
  const roots = source ? source["roots"] : undefined;
  if (taskDir === undefined || !Array.isArray(roots)) return undefined;
  const parsed: WorkspaceRootView[] = [];
  for (const entry of roots) {
    const item = record(entry);
    if (!item) return undefined;
    const id = str(item["id"]);
    const kind = str(item["kind"]);
    const label = str(item["label"]);
    const path = str(item["path"]);
    if (id === undefined || (kind !== "worktree" && kind !== "shared-dir") || label === undefined || path === undefined) {
      return undefined;
    }
    const repo = str(item["repo"] ?? item["repoDir"]);
    const directoryId = str(item["directoryId"]);
    const sourcePath = str(item["sourcePath"]);
    const branch = str(item["branch"]);
    const baseCommit = str(item["baseCommit"]);
    parsed.push({
      id,
      kind,
      label,
      path,
      ...(repo !== undefined ? { repo } : {}),
      ...(directoryId !== undefined ? { directoryId } : {}),
      ...(sourcePath !== undefined ? { sourcePath } : {}),
      ...(branch !== undefined ? { branch } : {}),
      ...(baseCommit !== undefined ? { baseCommit } : {}),
    });
  }
  return { roots: parsed, taskDir };
}

export function workspaceTreeFromHost(payload: unknown): WorkspaceTreeView | undefined {
  const source = record(payload);
  const tree = source ? record(source["tree"]) : undefined;
  if (!tree) return undefined;
  const attributionView = attribution(tree["attribution"]);
  const path = str(tree["path"]);
  const entries = tree["entries"];
  const truncated = bool(tree["truncated"]);
  if (!attributionView || path === undefined || !Array.isArray(entries) || truncated === undefined) return undefined;
  const parsed: WorkspaceTreeEntryView[] = [];
  for (const entry of entries) {
    const item = record(entry);
    if (!item) return undefined;
    const name = str(item["name"]);
    const entryPath = str(item["path"]);
    const kind = str(item["kind"]);
    if (name === undefined || entryPath === undefined || (kind !== "file" && kind !== "dir")) return undefined;
    const size = num(item["size"]);
    parsed.push({ name, path: entryPath, kind, ...(size !== undefined ? { size } : {}) });
  }
  return { attribution: attributionView, path, entries: parsed, truncated };
}

export function workspacePreviewFromHost(payload: unknown): WorkspacePreviewView | undefined {
  const source = record(payload);
  const preview = source ? record(source["preview"]) : undefined;
  if (!preview) return undefined;
  const attributionView = attribution(preview["attribution"]);
  const path = str(preview["path"]);
  const language = str(preview["language"]);
  const text = str(preview["source"]);
  const truncated = bool(preview["truncated"]);
  if (!attributionView || path === undefined || language === undefined || text === undefined || truncated === undefined) return undefined;
  const lineCount = num(preview["lineCount"]);
  return { attribution: attributionView, path, language, source: text, truncated, ...(lineCount !== undefined ? { lineCount } : {}) };
}

export function workspaceDiffFromHost(payload: unknown): WorkspaceDiffView | undefined {
  const source = record(payload);
  if (!source) return undefined;
  const attributionView = attribution(source["attribution"]);
  const path = str(source["path"]);
  const diff = str(source["diff"]);
  const truncated = bool(source["truncated"]);
  if (!attributionView || path === undefined || diff === undefined || truncated === undefined) return undefined;
  return { attribution: attributionView, path, diff, truncated };
}

export function workspaceDeliveryFromHost(payload: unknown): WorkspaceDeliveryView | undefined {
  const source = record(payload);
  const target = source ? record(source["target"]) : undefined;
  if (!target) return undefined;
  const attributionView = attribution(target["attribution"]);
  const repo = str(target["repo"]);
  const branch = str(target["branch"]);
  const autoCommit = bool(target["autoCommit"]);
  const autoPush = bool(target["autoPush"]);
  const autoMerge = bool(target["autoMerge"]);
  if (
    !attributionView ||
    repo === undefined ||
    branch === undefined ||
    autoCommit === undefined ||
    autoPush === undefined ||
    autoMerge === undefined
  ) {
    return undefined;
  }
  return { attribution: attributionView, repo, branch, autoCommit, autoPush, autoMerge };
}

export function terminalPlanFromHost(payload: unknown): TerminalPlanView | undefined {
  const source = record(payload);
  const plan = source ? record(source["plan"]) : undefined;
  if (!plan) return undefined;
  const attributionView = attribution(plan["attribution"]);
  const instanceId = str(plan["instanceId"]);
  const rootId = str(plan["rootId"]);
  const program = str(plan["program"]);
  const args = strings(plan["args"]);
  const cwd = str(plan["cwd"]);
  const cols = num(plan["cols"]);
  const rows = num(plan["rows"]);
  const historyLimit = num(plan["historyLimit"]);
  const owner = record(plan["owner"]);
  const rowsRaw = Array.isArray(plan["resolved"]) ? plan["resolved"] : undefined;
  if (
    !attributionView ||
    instanceId === undefined ||
    rootId === undefined ||
    program === undefined ||
    args === undefined ||
    cwd === undefined ||
    cols === undefined ||
    rows === undefined ||
    historyLimit === undefined ||
    !owner ||
    rowsRaw === undefined
  ) {
    return undefined;
  }
  const ownerTaskId = str(owner["taskId"]);
  const ownerLabel = str(owner["label"]);
  const ownerSession = owner["sessionId"] === null ? null : str(owner["sessionId"]);
  if (ownerTaskId === undefined || ownerLabel === undefined || ownerSession === undefined) return undefined;
  const resolved: TerminalEnvRowView[] = [];
  for (const entry of rowsRaw) {
    const item = record(entry);
    if (!item) return undefined;
    const key = str(item["key"]);
    const value = str(item["value"]);
    const secret = bool(item["secret"]);
    const rowSource = str(item["source"]);
    if (key === undefined || value === undefined || secret === undefined || rowSource === undefined) return undefined;
    resolved.push({ key, value, secret, source: rowSource });
  }
  return {
    instanceId,
    rootId,
    attribution: attributionView,
    program,
    args,
    cwd,
    cols,
    rows,
    resolved,
    historyLimit,
    owner: { taskId: ownerTaskId, sessionId: ownerSession, label: ownerLabel },
  };
}

export function terminalStateFromHost(payload: unknown): TerminalStateView | undefined {
  const source = record(payload);
  const spawnImplemented = source ? bool(source["spawnImplemented"]) : undefined;
  const instances = source ? source["instances"] : undefined;
  if (spawnImplemented === undefined || !Array.isArray(instances)) return undefined;
  const parsed: TerminalInstanceView[] = [];
  for (const entry of instances) {
    const item = record(entry);
    if (!item) return undefined;
    const instanceId = str(item["instanceId"]);
    const rootId = str(item["rootId"]);
    const attributionView = attribution(item["attribution"]);
    const program = str(item["program"]);
    const args = strings(item["args"]);
    const cwd = str(item["cwd"]);
    const cols = num(item["cols"]);
    const rows = num(item["rows"]);
    const envKeys = strings(item["envKeys"]);
    const lifecycle = str(item["lifecycle"]);
    const processKnown = bool(item["processKnown"]);
    const startedAt = str(item["startedAt"]);
    const owner = record(item["owner"]);
    if (
      instanceId === undefined ||
      rootId === undefined ||
      !attributionView ||
      program === undefined ||
      args === undefined ||
      cwd === undefined ||
      cols === undefined ||
      rows === undefined ||
      envKeys === undefined ||
      (lifecycle !== "running" && lifecycle !== "exited") ||
      processKnown === undefined ||
      startedAt === undefined ||
      !owner
    ) {
      return undefined;
    }
    const ownerTaskId = str(owner["taskId"]);
    const ownerLabel = str(owner["label"]);
    const ownerSession = owner["sessionId"] === null ? null : str(owner["sessionId"]);
    if (ownerTaskId === undefined || ownerLabel === undefined || ownerSession === undefined) return undefined;
    const processId = num(item["processId"]);
    const exitedAt = str(item["exitedAt"]);
    const exitCode = num(item["exitCode"]);
    const exitReason = str(item["exitReason"]);
    parsed.push({
      instanceId,
      rootId,
      attribution: attributionView,
      program,
      args,
      cwd,
      owner: { taskId: ownerTaskId, sessionId: ownerSession, label: ownerLabel },
      cols,
      rows,
      envKeys,
      lifecycle,
      processKnown,
      startedAt,
      ...(processId !== undefined ? { processId } : {}),
      ...(exitedAt !== undefined ? { exitedAt } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(exitReason !== undefined ? { exitReason } : {}),
    });
  }
  return { spawnImplemented, instances: parsed };
}

export function terminalHistoryFromHost(payload: unknown): TerminalHistoryEntryView[] | undefined {
  const source = record(payload);
  const history = source ? source["history"] : undefined;
  if (!Array.isArray(history)) return undefined;
  const parsed: TerminalHistoryEntryView[] = [];
  for (const entry of history) {
    const item = record(entry);
    const at = item ? str(item["at"]) : undefined;
    const line = item ? str(item["line"]) : undefined;
    if (at === undefined || line === undefined) return undefined;
    parsed.push({ at, line });
  }
  return parsed;
}

/**
 * Memory-mode projection of the same view: roots from the task's repos and
 * plain-directory links, tree/preview/diff from the seeded `task.files`, and
 * the delivery target from the repository's base branch. Labelled as
 * simulated by the caller (`spawnImplemented: false`, no Host round-trip).
 */
export function memoryWorkspaceBrowser(
  task: Pick<Task, "id" | "workspaceRoot" | "repos" | "directories" | "files">,
  baseBranchOf: (repoId: string) => string | undefined,
  request: WorkspaceBrowserRequest,
): WorkspaceBrowserView {
  const taskDir = `${task.workspaceRoot}/tasks/${task.id}`;
  const roots: WorkspaceRootView[] = [
    ...task.repos.map((repo) => ({
      id: repo,
      kind: "worktree" as const,
      label: repo,
      path: `${taskDir}/${repo}`,
      repo,
      ...(baseBranchOf(repo) !== undefined ? { branch: baseBranchOf(repo) as string } : {}),
    })),
    ...task.directories.map((directory) => ({
      id: directory.linkName,
      kind: "shared-dir" as const,
      label: directory.name,
      path: `${taskDir}/${directory.linkName}`,
      directoryId: directory.id,
      sourcePath: directory.path,
    })),
  ];
  const root = roots.find((entry) => entry.id === request.rootId) ?? roots[0];
  if (!root) return { taskId: task.id, taskDir, roots };
  const attributionView: WorkspaceAttributionView =
    root.kind === "shared-dir"
      ? {
          taskId: task.id,
          rootId: root.id,
          rootKind: "shared-dir",
          rootLabel: root.label,
          ...(root.directoryId !== undefined ? { directoryId: root.directoryId } : {}),
          piWorkDir: taskDir,
          linkPath: root.path,
          sourcePath: root.sourcePath ?? "",
          sharedNote: "普通目录链接：修改影响原文件，不提供 Git 差异与交付",
        }
      : {
          taskId: task.id,
          rootId: root.id,
          rootKind: "worktree",
          rootLabel: root.label,
          ...(root.repo !== undefined ? { repo: root.repo } : {}),
          piWorkDir: taskDir,
        };
  const relative = request.relative ?? "";
  const prefix = relative.length > 0 ? `${relative}/` : "";
  const inRoot = task.files.filter((file) => file.path.startsWith(`${root.id}/`));
  const entries: WorkspaceTreeEntryView[] = relative.length === 0
    ? inRoot.map((file) => ({
        name: file.path.slice(root.id.length + 1),
        path: file.path,
        kind: "file" as const,
      }))
    : inRoot
        .filter((file) => file.path.startsWith(`${root.id}/${prefix}`))
        .map((file) => ({
          name: file.path.slice(root.id.length + 1 + prefix.length),
          path: file.path,
          kind: "file" as const,
        }));
  const tree: WorkspaceTreeView = { attribution: attributionView, path: relative, entries, truncated: false };
  const file: WorkspaceFile | undefined = inRoot.find((candidate) => candidate.path === `${root.id}/${relative}`);
  const preview: WorkspacePreviewView | undefined =
    file && relative.length > 0
      ? {
          attribution: attributionView,
          path: relative,
          language: file.preview?.language ?? "text",
          source: file.preview?.source ?? "（内存投影：该文件没有可预览内容）",
          truncated: false,
        }
      : undefined;
  const diff: WorkspaceDiffView | undefined =
    file && root.kind === "worktree"
      ? {
          attribution: attributionView,
          path: relative,
          diff: `--- a/${relative}\n+++ b/${relative}\n@@\n${file.status === "added" ? "+（内存投影：新增文件）" : file.status === "deleted" ? "-（内存投影：已删除文件）" : " （内存投影：已修改文件）"}`,
          truncated: false,
        }
      : undefined;
  const delivery: WorkspaceDeliveryView | undefined =
    root.kind === "worktree"
      ? {
          attribution: attributionView,
          repo: root.repo ?? root.id,
          branch: root.branch ?? "",
          autoCommit: false,
          autoPush: false,
          autoMerge: false,
        }
      : undefined;
  return {
    taskId: task.id,
    taskDir,
    roots,
    selected: { rootId: root.id, relative, tree, ...(preview ? { preview } : {}), ...(diff ? { diff } : {}), ...(delivery ? { delivery } : {}) },
  };
}
