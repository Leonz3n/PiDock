/**
 * Task-scoped file browsing, preview, diff and Git-delivery rules for
 * [PiDock 10] (#15), S1 slice.
 *
 * Pure rules: no filesystem, no git, no Electron. The Host reads the tree and
 * runs git; this module owns what a *valid* request looks like, how much of an
 * answer may cross the boundary, and what the answer must disclose.
 *
 * Design notes (from the #15 boxes):
 * - Every root carries its owning task and — for a worktree — its repo, so a
 *   multi-repo task never presents several repositories as one Git repo
 *   (盒子 2). Plain-directory links keep their own identity and the recorded
 *   original target (盒子 9).
 * - A link is a **shared view of the original**: writes through it modify the
 *   original, so it has no Git diff and no Git delivery entry point; the
 *   attribution says so explicitly (`修改影响原文件`) instead of silently
 *   showing an empty diff.
 * - Paths are relative to one root and are refused when they are absolute or
 *   contain `..`; a refused request never falls back to the host path space,
 *   so no browse request can read another task's folder.
 * - Preview/diff text is masked with the same scrubber the browser evidence
 *   uses (`scrubBrowserText`) and bounded, so a huge file or a credential in
 *   a diff cannot flood the session.
 */

import { scrubSecretText } from "./browser-rules.js";

/** A repository worktree inside the task folder (Git-capable). */
export const WORKSPACE_ROOT_KIND_WORKTREE = "worktree";
/** A plain-directory link: a shared view of its original target. */
export const WORKSPACE_ROOT_KIND_SHARED_DIR = "shared-dir";

export type WorkspaceRootKind = "worktree" | "shared-dir";

/** Max roots one task file panel lists; a bounded list, never unbounded growth. */
export const MAX_WORKSPACE_ROOTS = 32;
/** Max tree entries returned per directory listing. */
export const MAX_TREE_ENTRIES = 200;
/** Max characters of one preview body. */
export const MAX_PREVIEW_CHARS = 20_000;
/** Max lines / characters of one diff body. */
export const MAX_DIFF_LINES = 400;
export const MAX_DIFF_CHARS = 40_000;

/** One browsable root: a task repo worktree, or a plain-directory link. */
export interface WorkspaceRoot {
  /** Stable id within the task: `repoDir` for a worktree, `linkName` for a link. */
  id: string;
  kind: WorkspaceRootKind;
  /** Display label (repo folder name or link name). */
  label: string;
  /** Absolute in-task path of the root. */
  path: string;
  /** Worktree only: the repo folder name inside the task. */
  repoDir?: string;
  /** Shared-dir only: project directory identity of the linked entry. */
  directoryId?: string;
  /** Shared-dir only: absolute original target recorded at link time. */
  sourcePath?: string;
  /** Worktree only: baseline branch shown by the delivery entry point. */
  branch?: string;
  /** Worktree only: pinned baseline commit the diff compares against. */
  baseCommit?: string;
}

/**
 * Structural input for `workspaceRoots`: the fields of the task record the
 * file panel needs. Kept structural so `main/` never imports the Host store.
 */
export interface WorkspaceRootsInput {
  taskId: string;
  taskDir: string;
  /** Worktree folder names inside the task folder (single-repo tasks: one). */
  repos: readonly string[];
  /** Per-repo baselines ([PiDock 03] #6); absent on pre-#6 records. */
  repoSources?: readonly { repoDir: string; remoteBranch: string; baseCommit?: string }[];
  /** Plain-directory links ([PiDock 03] #6). */
  dirLinks?: readonly { linkName: string; directoryId: string; sourcePath: string }[];
  /** Task baseline branch when no per-repo source exists. */
  branch?: string;
  /** Task baseline commit when no per-repo source exists. */
  baseCommit?: string;
}

function joinRoot(taskDir: string, name: string): string {
  return `${taskDir.replace(/[\\/]+$/, "")}/${name}`;
}

/**
 * Build the browsable roots of one task in a stable order: worktrees first
 * (declaration order), then plain-directory links (link order). Never merges
 * two repos into one root, and never copies a link's target into the task —
 * the root path stays the in-task link path while `sourcePath` records the
 * original.
 */
export function workspaceRoots(input: WorkspaceRootsInput): WorkspaceRoot[] {
  const roots: WorkspaceRoot[] = [];
  const branchByRepo = new Map((input.repoSources ?? []).map((source) => [source.repoDir, source.remoteBranch] as const));
  const baseByRepo = new Map((input.repoSources ?? []).map((source) => [source.repoDir, source.baseCommit] as const));
  const seen = new Set<string>();
  for (const repoDir of input.repos) {
    const id = repoDir.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    const baseCommit = baseByRepo.get(id) ?? input.baseCommit;
    roots.push({
      id,
      kind: "worktree",
      label: id,
      path: joinRoot(input.taskDir, id),
      repoDir: id,
      branch: branchByRepo.get(id) ?? input.branch ?? "",
      ...(baseCommit !== undefined && baseCommit.length > 0 ? { baseCommit } : {}),
    });
  }
  for (const link of input.dirLinks ?? []) {
    const id = link.linkName.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    roots.push({
      id,
      kind: "shared-dir",
      label: id,
      path: joinRoot(input.taskDir, id),
      directoryId: link.directoryId,
      sourcePath: link.sourcePath,
    });
  }
  return roots.slice(0, MAX_WORKSPACE_ROOTS);
}

export function findWorkspaceRoot(roots: readonly WorkspaceRoot[], rootId: string): WorkspaceRoot | undefined {
  return roots.find((root) => root.id === rootId);
}

/** How one root is disclosed next to a file tree, preview or diff. */
export interface WorkspaceAttribution {
  taskId: string;
  rootId: string;
  rootKind: WorkspaceRootKind;
  rootLabel: string;
  /** Worktree: repo identity. Link: linked directory identity. */
  repo?: string;
  directoryId?: string;
  /** Unified pi working directory (always the task folder). */
  piWorkDir: string;
  /** Shared-dir only: where the link lives inside the task. */
  linkPath?: string;
  /** Shared-dir only: the original target the link points at. */
  sourcePath?: string;
  /** Shared-dir only: the write-through warning the UI must show. */
  sharedNote?: string;
}

export function workspaceAttribution(root: WorkspaceRoot, taskId: string, taskDir: string): WorkspaceAttribution {
  if (root.kind === "shared-dir") {
    return {
      taskId,
      rootId: root.id,
      rootKind: root.kind,
      rootLabel: root.label,
      directoryId: root.directoryId,
      piWorkDir: taskDir,
      linkPath: root.path,
      sourcePath: root.sourcePath ?? "",
      sharedNote: "普通目录链接：修改影响原文件，不提供 Git 差异与交付",
    };
  }
  return {
    taskId,
    rootId: root.id,
    rootKind: root.kind,
    rootLabel: root.label,
    repo: root.repoDir ?? root.id,
    piWorkDir: taskDir,
  };
}

/** A requested path that passed validation: relative to exactly one root. */
export interface WorkspacePathTarget {
  root: WorkspaceRoot;
  /** Normalized relative path inside the root ("" = the root itself). */
  relative: string;
  /** Absolute in-task path (root + relative). */
  absolute: string;
  attribution: WorkspaceAttribution;
}

export type WorkspacePathResult =
  | ({ ok: true } & WorkspacePathTarget)
  | { ok: false; error: string };

/**
 * Validate one requested path against one root. Absolute paths and `..`
 * segments are refused outright rather than resolved, so a request can never
 * name a path outside the selected root — a stale or hostile relative path
 * fails closed with `path-out-of-scope` instead of reading the host.
 */
export function resolveWorkspacePath(input: {
  roots: readonly WorkspaceRoot[];
  taskId: string;
  taskDir: string;
  rootId: unknown;
  relative?: unknown;
  /** Allow the root itself (tree listing); a file op requires a path. */
  allowRoot?: boolean;
}): WorkspacePathResult {
  if (typeof input.rootId !== "string" || input.rootId.trim().length === 0) {
    return { ok: false, error: "invalid-payload: rootId must be a non-empty string" };
  }
  const root = findWorkspaceRoot(input.roots, input.rootId.trim());
  if (!root) {
    return { ok: false, error: `unknown-root: ${input.rootId.trim()} 不是本任务的文件根（仓库或普通目录链接）` };
  }
  const raw = input.relative === undefined ? "" : input.relative;
  if (typeof raw !== "string") return { ok: false, error: "invalid-payload: relative path must be a string" };
  const segments = raw.trim().replace(/\\/g, "/").split("/");
  const kept: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      return { ok: false, error: `path-out-of-scope: 相对路径不能包含上级目录（${raw.trim()}）` };
    }
    if (segment.includes("\0")) return { ok: false, error: "path-out-of-scope: 路径包含非法字符" };
    kept.push(segment);
  }
  if (kept.length === 0 && input.allowRoot !== true) {
    return { ok: false, error: "invalid-payload: 需要相对文件路径" };
  }
  const relative = kept.join("/");
  return {
    ok: true,
    root,
    relative,
    absolute: relative.length === 0 ? root.path : `${root.path}/${relative}`,
    attribution: workspaceAttribution(root, input.taskId, input.taskDir),
  };
}

/** One entry of a directory listing. */
export interface WorkspaceTreeEntry {
  /** Entry name (single component). */
  name: string;
  /** Path relative to the listed root. */
  path: string;
  kind: "file" | "dir";
  /** Size in bytes when the reader reported one. */
  size?: number;
}

export interface WorkspaceTree {
  attribution: WorkspaceAttribution;
  /** Listed directory, relative to the root ("" = root). */
  path: string;
  entries: WorkspaceTreeEntry[];
  /** True when the reader had more entries than the bound allows. */
  truncated: boolean;
}

/**
 * Bound and order one directory listing: directories first, then names, at
 * most `MAX_TREE_ENTRIES` entries, with `truncated` set when the reader saw
 * more. Entries are re-derived from the plain name+kind so the reader can
 * never smuggle an absolute path or a nested path into the listing.
 */
export function boundTreeEntries(
  entries: readonly { name: string; kind: "file" | "dir"; size?: number }[],
  parentRelative: string,
  limit: number = MAX_TREE_ENTRIES,
): { entries: WorkspaceTreeEntry[]; truncated: boolean } {
  const clean = entries
    .flatMap((entry): WorkspaceTreeEntry[] => {
      const name = entry.name.trim();
      if (name.length === 0 || name === "." || name === "..") return [];
      if (name.includes("/") || name.includes("\\") || name.includes("\0")) return [];
      const path = parentRelative.length === 0 ? name : `${parentRelative}/${name}`;
      return [{ name, path, kind: entry.kind, ...(entry.size !== undefined ? { size: entry.size } : {}) }];
    })
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  return { entries: clean.slice(0, Math.max(0, limit)), truncated: clean.length > limit };
}

/** Preview payload the panel renders: bounded, masked, attributed. */
export interface WorkspacePreview {
  attribution: WorkspaceAttribution;
  /** Path relative to the root. */
  path: string;
  language: string;
  /** Masked, bounded source text. */
  source: string;
  truncated: boolean;
  /** Line count of the original when the reader reported one. */
  lineCount?: number;
}

/** Coarse language label from the file extension (display only). */
export function languageForPath(path: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    py: "python",
    go: "go",
    rs: "rust",
    md: "markdown",
    yml: "yaml",
    yaml: "yaml",
    sh: "shell",
    css: "css",
    html: "html",
  };
  return map[ext] ?? "text";
}

/**
 * Bound and mask one file body. `secrets` are the task/private values that
 * must never appear in a preview (same list the browser surface scrubs with),
 * and the size bound keeps one large file from becoming the session payload.
 */
export function boundPreview(input: {
  root: WorkspaceRoot;
  taskId: string;
  taskDir: string;
  path: string;
  source: string;
  secrets?: readonly string[];
  lineCount?: number;
}): WorkspacePreview {
  const masked = scrubSecretText(input.source, input.secrets ?? []);
  const truncated = masked.length > MAX_PREVIEW_CHARS;
  return {
    attribution: workspaceAttribution(input.root, input.taskId, input.taskDir),
    path: input.path,
    language: languageForPath(input.path),
    source: truncated ? `${masked.slice(0, MAX_PREVIEW_CHARS)}\n...(已截断)` : masked,
    truncated,
    ...(input.lineCount !== undefined ? { lineCount: input.lineCount } : {}),
  };
}

export type WorkspaceDiffResult =
  | { ok: true; attribution: WorkspaceAttribution; path: string; diff: string; truncated: boolean }
  | { ok: false; error: string };

/**
 * Bound and mask one git diff hunk. A plain-directory link has no Git view:
 * the request is refused with `plain-dir-no-diff` (and the attribution the UI
 * already shows says the link writes through to the original) instead of
 * reporting an empty diff that would read like "no changes".
 */
export function boundDiff(input: {
  root: WorkspaceRoot;
  taskId: string;
  taskDir: string;
  path: string;
  diff: string;
  secrets?: readonly string[];
}): WorkspaceDiffResult {
  if (input.root.kind !== "worktree") {
    return {
      ok: false,
      error: `plain-dir-no-diff: ${input.root.label} 是普通目录链接，修改影响原文件，不提供 Git 差异；请到原目录用 Git 工具查看`,
    };
  }
  const masked = scrubSecretText(input.diff, input.secrets ?? []);
  const lines = masked.split("\n");
  const lineBound = lines.length > MAX_DIFF_LINES;
  const charBound = masked.length > MAX_DIFF_CHARS;
  const bounded = (lineBound ? lines.slice(0, MAX_DIFF_LINES).join("\n") : masked).slice(0, MAX_DIFF_CHARS);
  return {
    ok: true,
    attribution: workspaceAttribution(input.root, input.taskId, input.taskDir),
    path: input.path,
    diff: lineBound || charBound ? `${bounded}\n...(差异已截断)` : bounded,
    truncated: lineBound || charBound,
  };
}

/** What a delivery entry point must disclose before the user runs git. */
export interface WorkspaceDeliveryTarget {
  attribution: WorkspaceAttribution;
  repo: string;
  branch: string;
  /** The panel shows the exact target; it never commits, pushes or merges itself. */
  autoCommit: false;
  autoPush: false;
  autoMerge: false;
}

export type WorkspaceDeliveryResult = { ok: true; target: WorkspaceDeliveryTarget } | { ok: false; error: string };

/**
 * The Git delivery entry point's target: the repo and branch the user would
 * act on, plus the explicit "nothing is automatic" flags. A plain-directory
 * link has no delivery target (`plain-dir-no-delivery`), matching box 9.
 */
export function deliveryTarget(input: {
  root: WorkspaceRoot;
  taskId: string;
  taskDir: string;
}): WorkspaceDeliveryResult {
  if (input.root.kind !== "worktree") {
    return {
      ok: false,
      error: `plain-dir-no-delivery: ${input.root.label} 是普通目录链接，不提供 Git 交付；请到原目录处理`,
    };
  }
  return {
    ok: true,
    target: {
      attribution: workspaceAttribution(input.root, input.taskId, input.taskDir),
      repo: input.root.repoDir ?? input.root.id,
      branch: input.root.branch ?? "",
      autoCommit: false,
      autoPush: false,
      autoMerge: false,
    },
  };
}
