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
 * - A worktree root keeps its OWN observed working branch and uncommitted
 *   state apart from the pinned baseline branch it was prepared from (盒子 6):
 *   the observation fields are optional here because no reading happens in
 *   this pure module — the Host fills them with real reads or a named unknown,
 *   and the panel never renders the baseline as if it were the working branch.
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
/** An existing registered Git checkout used in place (shared original, no copy). */
export const WORKSPACE_ROOT_KIND_EXISTING_GIT = "existing-git";

export type WorkspaceRootKind = "worktree" | "shared-dir" | "existing-git";

/**
 * How one task treats its Git sources ([Pencil T02] #137): an independent
 * worktree per repo (the default), an existing registered checkout used in
 * place, or no Git source at all (plain directories only). Plain-directory
 * sources share their original files in every mode.
 */
export type WorkspaceMode = "worktree" | "existing-git" | "plain-dirs";

/**
 * Per-source reopen verification ([Pencil T02] #137). `missing` / `mismatch`
 * name a source that moved, disappeared or was replaced; `repair-required`
 * names a record that cannot be verified at all (its identity is not stored).
 * Never a silent rewrite: the record is the record, this is a reading of it.
 */
export type WorkspaceVerificationState = "ready" | "missing" | "mismatch" | "repair-required";

export interface WorkspaceVerification {
  state: WorkspaceVerificationState;
  /** Named reason the state is not `ready` (or the confirmation when it is). */
  reason: string;
}

/** Max roots one task file panel lists; a bounded list, never unbounded growth. */
export const MAX_WORKSPACE_ROOTS = 32;
/** Max tree entries returned per directory listing. */
export const MAX_TREE_ENTRIES = 200;
/** Max characters of one preview body. */
export const MAX_PREVIEW_CHARS = 20_000;
/** Max lines / characters of one diff body. */
export const MAX_DIFF_LINES = 400;
export const MAX_DIFF_CHARS = 40_000;

/**
 * One fact a Host read really produced, or the NAMED reason it could not be
 * read. Declared record fields are never spelled as an observation: an
 * unobserved branch or change state is `unknown` with its reason, and no
 * reader may substitute the pinned baseline branch or "clean" for it.
 */
export type WorkspaceObservation<T> = { state: "observed"; value: T } | { state: "unknown"; reason: string };

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
  /**
   * Worktree only, DECLARED: the pinned remote baseline this worktree was
   * prepared from, and the branch the delivery entry point names. It is a
   * record fact, never the branch the worktree is on.
   */
  baselineBranch?: string;
  /**
   * Worktree only, DECLARED: the branch the task created this worktree with
   * (`task/<taskDirId>`, `main/task-provision.ts` `buildTaskBranch`). Shown as
   * the expectation beside an unobserved `workingBranch`, never as a reading.
   */
  expectedBranch?: string;
  /** Worktree only, OBSERVED: the branch this worktree is really on. */
  workingBranch?: WorkspaceObservation<string>;
  /**
   * Worktree only, OBSERVED: whether `git status --porcelain` reported anything
   * in this worktree (uncommitted, including untracked) — the same fact
   * `main/service-code-observation.ts` records as `dirty`. An unread state is
   * `unknown`, never `false`: "no uncommitted change" is a reading, not a
   * default. A committed change since `baseCommit` is not visible here; it is
   * what `boundDiff` against `baseCommit` reports.
   */
  dirty?: WorkspaceObservation<boolean>;
  /** Worktree only: pinned baseline commit the diff compares against. */
  baseCommit?: string;
  /**
   * Worktree only, RECORDED: the registered source checkout the worktree came
   * from, as its resolved real path ([Pencil T07] #142, #137 leftover). The
   * worktree path alone cannot tell WHICH original repository this task reads
   * and writes around, so the facts surface shows both.
   */
  sourceRealPath?: string;
  /**
   * Existing-git only: this root is the original checkout itself, not a copy.
   * Writes modify the original files and there is no task baseline to diff or
   * deliver against.
   */
  sharedOriginal?: boolean;
  /** Existing-git only, OBSERVED: the checkout's real HEAD commit at read time. */
  headCommit?: WorkspaceObservation<string>;
  /**
   * Every source: the per-source result of re-verifying the recorded identity
   * on open. Absent only on a payload that carries no verification at all. A
   * missing/mismatched source is a named state, never an empty list.
   */
  verification?: WorkspaceVerification;
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
  repoSources?: readonly { repoDir: string; remoteBranch: string; baseCommit?: string; sourceRealPath?: string }[];
  /** Plain-directory links ([PiDock 03] #6). */
  dirLinks?: readonly { linkName: string; directoryId: string; sourcePath: string }[];
  /** Existing-Git-dir sources ([Pencil T02] #137): the registered checkout in place. */
  sharedRepos?: readonly {
    rootId: string;
    sourcePath: string;
    remote: string;
    remoteBranch: string;
    headCommit: string;
  }[];
  /** Recorded task workspace mode; absent on pre-#137 records. */
  workspaceMode?: WorkspaceMode;
  /** Pinned baseline branch of the task when no per-repo source exists. */
  baselineBranch?: string;
  /** The task's own declared branch (record `branch`); same for every worktree. */
  taskBranch?: string;
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
  const sourceRealPathByRepo = new Map((input.repoSources ?? []).map((source) => [source.repoDir, source.sourceRealPath] as const));
  const seen = new Set<string>();
  for (const repoDir of input.repos) {
    const id = repoDir.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    const baseCommit = baseByRepo.get(id) ?? input.baseCommit;
    const sourceRealPath = sourceRealPathByRepo.get(id);
    roots.push({
      id,
      kind: "worktree",
      label: id,
      path: joinRoot(input.taskDir, id),
      repoDir: id,
      baselineBranch: branchByRepo.get(id) ?? input.baselineBranch ?? "",
      ...(input.taskBranch !== undefined && input.taskBranch.length > 0 ? { expectedBranch: input.taskBranch } : {}),
      ...(baseCommit !== undefined && baseCommit.length > 0 ? { baseCommit } : {}),
      ...(sourceRealPath !== undefined && sourceRealPath.length > 0 ? { sourceRealPath } : {}),
    });
  }
  // Existing-Git-dir sources ([Pencil T02] #137): the root IS the registered
  // checkout, so its path is the source path — never a task-folder child. The
  // task folder holds only the record, so a shared checkout cannot be mistaken
  // for an independent copy.
  for (const repo of input.sharedRepos ?? []) {
    const id = repo.rootId.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    roots.push({
      id,
      kind: "existing-git",
      label: repo.sourcePath.split(/[\\/]/).filter((part) => part.length > 0).pop() ?? id,
      path: repo.sourcePath,
      repoDir: id,
      baselineBranch: repo.remoteBranch,
      sharedOriginal: true,
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
  if (root.kind === "existing-git") {
    return {
      taskId,
      rootId: root.id,
      rootKind: root.kind,
      rootLabel: root.label,
      repo: root.repoDir ?? root.id,
      piWorkDir: taskDir,
      sourcePath: root.path,
      sharedNote: "已有 Git 目录：直接使用原检出，修改影响原文件，不提供任务基线差异与交付",
    };
  }
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
  if (input.root.kind === "existing-git") {
    return {
      ok: false,
      error: `shared-checkout-no-diff: ${input.root.label} 是已有 Git 目录（共享原检出），没有任务基线可比较；请到原目录用 Git 工具查看`,
    };
  }
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
  if (input.root.kind === "existing-git") {
    return {
      ok: false,
      error: `shared-checkout-no-delivery: ${input.root.label} 是已有 Git 目录（共享原检出），没有任务分支可交付；请到原目录处理`,
    };
  }
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
      // The delivery target is the pinned baseline the user would deliver to,
      // which is a DECLARED record fact, not the worktree's own branch.
      branch: input.root.baselineBranch ?? "",
      autoCommit: false,
      autoPush: false,
      autoMerge: false,
    },
  };
}

/**
 * Recorded identity of one source ([Pencil T02] #137): what the task record
 * says the source is. Every field but `path` is optional because older records
 * did not store it; an unverifiable record is `repair-required`, never a
 * silent pass.
 */
export interface RecordedSourceIdentity {
  /** The path recorded for the source (checkout, link target or worktree). */
  path: string;
  /** Real path observed when the source was recorded. */
  realPath?: string;
  /** Device/inode observed when the source was recorded. */
  device?: string;
  inode?: string;
  /** Git common dir observed when the source was recorded. */
  commonDir?: string;
  /** Remote URL digest observed when the source was recorded. */
  remoteDigest?: string;
}

/**
 * What the filesystem really answered for one source now. `missing` and
 * `other` are answers, not errors: a path that is gone or no longer a
 * directory is exactly the named state the facts surface must show.
 */
export interface ObservedSourceIdentity {
  kind: "dir" | "other" | "missing";
  realPath?: string;
  device?: string;
  inode?: string;
  /** Current Git common dir; `null` when it could not be read. */
  commonDir?: string | null;
  /** Current remote URL digest; `null` when it could not be read. */
  remoteDigest?: string | null;
}

/**
 * Re-verify one source's recorded identity ([Pencil T02] #137 bullet 4).
 *
 * Rules:
 * - a missing path is `missing`; a non-directory is `mismatch`;
 * - a different real path or device/inode is `mismatch` (the directory was
 *   moved or replaced at the same path);
 * - a record without device/inode cannot be verified at all and is
 *   `repair-required` — it is never treated as verified by default;
 * - a recorded Git common dir / remote digest that differs is `mismatch`;
 *   one that cannot be read is `repair-required`.
 *
 * The reason is always a named sentence, so the facts surface never shows a
 * bare "error" and never guesses a replacement path.
 */
export function verifyWorkspaceSource(
  recorded: RecordedSourceIdentity,
  observed: ObservedSourceIdentity,
): WorkspaceVerification {
  if (observed.kind === "missing") {
    return { state: "missing", reason: `来源缺失：${recorded.path} 不存在或不可读` };
  }
  if (observed.kind !== "dir") {
    return { state: "mismatch", reason: `身份不符：${recorded.path} 已不是目录` };
  }
  if (recorded.realPath !== undefined && observed.realPath !== undefined && recorded.realPath !== observed.realPath) {
    return { state: "mismatch", reason: `身份不符：来源真实路径已改变（记录 ${recorded.realPath}，实际 ${observed.realPath}）` };
  }
  const identified = recorded.device !== undefined && recorded.inode !== undefined;
  if (identified && (recorded.device !== observed.device || recorded.inode !== observed.inode)) {
    return { state: "mismatch", reason: "身份不符：来源目录已被替换（设备/索引节点与记录不一致）" };
  }
  if (!identified) {
    return { state: "repair-required", reason: "待修复：任务记录缺少来源身份（设备/索引节点），无法核验" };
  }
  if (recorded.commonDir !== undefined) {
    if (observed.commonDir === undefined || observed.commonDir === null) {
      return { state: "repair-required", reason: "待修复：无法读取来源的 Git 公共目录" };
    }
    if (observed.commonDir !== recorded.commonDir) {
      return { state: "mismatch", reason: "身份不符：来源的 Git 公共目录已改变" };
    }
  }
  if (recorded.remoteDigest !== undefined) {
    if (observed.remoteDigest === undefined || observed.remoteDigest === null) {
      return { state: "repair-required", reason: "待修复：无法读取来源的 Git 远程地址" };
    }
    if (observed.remoteDigest !== recorded.remoteDigest) {
      return { state: "mismatch", reason: "身份不符：来源的 Git 远程地址已改变" };
    }
  }
  return { state: "ready", reason: "已核验：来源身份与记录一致" };
}
