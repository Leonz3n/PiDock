/**
 * Pure composer-reference rules for [PiDock 13] (#16).
 *
 * One message can mix task code references, a snippet copied from the file
 * view, a machine-local attachment and skill invocations. The rules here
 * keep the four apart and bound what actually reaches the session:
 *
 * - a task reference records the owning task, the source identity (repo
 *   worktree or plain-directory link), the display name and the real
 *   target separately, plus the in-task relative path. The same relative
 *   path in two repos or two tasks is never "the same file".
 * - the Git version comes from the selected worktree; a plain directory
 *   link never fakes one (`version: null`)
 * - file search respects the default ignore rules, and directories, large
 *   files, binary files and long snippets have explicit limits
 * - a draft reference that moved, lost its source, left its root or belongs
 *   to another task is reported so the user re-selects; validation never
 *   falls back to the main checkout
 * - an estimated size is labelled as an estimate and never counted as
 *   reported Token usage
 * - a selected local attachment authorizes exactly that file, not the
 *   directory it lives in
 */

export type ReferenceSourceKind = "worktree" | "plain-dir";

export type TaskFileEntry = {
  /** Repo id or plain-directory link id, unique within one task. */
  sourceId: string;
  sourceKind: ReferenceSourceKind;
  /** Display name kept separate from the real target (repo name / link name). */
  displayName: string;
  /** Real target of a plain-directory link; the link name is display-only. */
  target?: string;
  /** Source-relative path (`src/api.ts`). */
  relativePath: string;
  kind: "file" | "directory";
  size?: number;
  binary?: boolean;
};

export type ComposerReference = {
  id: string;
  kind: "file" | "directory" | "snippet";
  /** Owning task: a reference never resolves inside another task. */
  taskId: string;
  sourceId: string;
  sourceKind: ReferenceSourceKind;
  displayName: string;
  target?: string;
  relativePath: string;
  /** Git version of the selected worktree; `null` for a plain-directory link. */
  version: string | null;
  /** Inclusive line range for a snippet copied from the file view. */
  lines?: { from: number; to: number };
  label: string;
  detail: string;
};

/** Directory names a default file search never descends into. */
export const DEFAULT_IGNORED_DIRECTORIES: readonly string[] = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".turbo",
  ".next",
  "target",
  "vendor",
];

export const FILE_SEARCH_LIMIT = 20;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT_ATTACHMENT_BYTES = 1024 * 1024;
export const MAX_SNIPPET_LINES = 200;
export const MAX_SNIPPET_CHARS = 20_000;

const IMAGE_TYPES = /^image\/(png|jpeg|jpg|gif|webp|bmp)$/i;
const TEXT_TYPES = /^text\/|application\/(json|xml|yaml|x-yaml|toml|javascript|typescript)/i;
const TEXT_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|txt|yml|yaml|toml|go|rs|py|java|kt|rb|sh|css|html|sql|c|h|cpp|hpp)$/i;

export function isDefaultIgnored(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return segments.some((segment) => DEFAULT_IGNORED_DIRECTORIES.includes(segment));
}

/** Subsequence match with a contiguous/earlier-is-better score; `null` = no match. */
export function fuzzyScore(query: string, target: string): number | null {
  const needle = query.toLowerCase();
  if (needle.length === 0) return 0;
  const haystack = target.toLowerCase();
  let score = 0;
  let cursor = 0;
  let streak = 0;
  for (const character of needle) {
    const found = haystack.indexOf(character, cursor);
    if (found === -1) return null;
    if (found === cursor) {
      streak += 1;
      score += 4 + streak;
    } else {
      streak = 0;
      score += 1 - Math.min(found - cursor, 4) * 0.25;
    }
    cursor = found + 1;
  }
  return score - haystack.length * 0.01;
}

export type FileSearchItem = {
  sourceId: string;
  sourceKind: ReferenceSourceKind;
  displayName: string;
  /** `displayName/relativePath`, what the candidate row shows. */
  label: string;
  relativePath: string;
  kind: "file" | "directory";
};

/**
 * Candidate files/directories for one task: both worktrees and plain-dir
 * links, ignore rules applied, bounded, and labelled with the source they
 * belong to (a same-named path in another repo stays a separate row).
 */
export function searchTaskFiles(
  entries: readonly TaskFileEntry[],
  query: string,
  options: { limit?: number } = {},
): { items: FileSearchItem[]; truncated: boolean } {
  const limit = options.limit ?? FILE_SEARCH_LIMIT;
  const matches: { item: FileSearchItem; score: number }[] = [];
  for (const entry of entries) {
    if (isDefaultIgnored(entry.relativePath)) continue;
    const label = `${entry.displayName}/${entry.relativePath}${entry.kind === "directory" ? "/" : ""}`;
    const score = fuzzyScore(query, label);
    if (score === null) continue;
    matches.push({
      item: {
        sourceId: entry.sourceId,
        sourceKind: entry.sourceKind,
        displayName: entry.displayName,
        label,
        relativePath: entry.relativePath,
        kind: entry.kind,
      },
      score,
    });
  }
  matches.sort((left, right) => right.score - left.score || left.item.label.localeCompare(right.item.label));
  return { items: matches.slice(0, limit).map((match) => match.item), truncated: matches.length > limit };
}

export type AttachmentDecision =
  | { ok: true; kind: "image" | "text" | "other"; scope: string; detail: string }
  | { ok: false; code: "too-large" | "unsupported-type"; message: string };

/**
 * Pre-send check for a machine-local attachment. A refused attachment never
 * reports as delivered, and an accepted one authorizes only itself.
 */
export function classifyComposerAttachment(input: { name: string; size: number; type?: string }): AttachmentDecision {
  const type = input.type ?? "";
  const image = IMAGE_TYPES.test(type);
  const text = image ? false : TEXT_TYPES.test(type) || TEXT_EXTENSIONS.test(input.name);
  if (!image && !text && type.length > 0) {
    return {
      ok: false,
      code: "unsupported-type",
      message: `不支持的类型 ${type}：请选择图片或文本文件，或先转换为文本`,
    };
  }
  const limit = text ? MAX_TEXT_ATTACHMENT_BYTES : MAX_ATTACHMENT_BYTES;
  if (input.size > limit) {
    return {
      ok: false,
      code: "too-large",
      message: `文件 ${input.name} 超过上限 ${Math.round(limit / (1024 * 1024))}MB，未发送`,
    };
  }
  return {
    ok: true,
    kind: image ? "image" : text ? "text" : "other",
    scope: input.name,
    detail: `${image ? "图片" : "文本"}附件 · 仅 ${input.name} 本身，未授权访问所在目录`,
  };
}

export function buildFileReference(input: {
  id: string;
  taskId: string;
  entry: TaskFileEntry;
  /** Git version read from the selected worktree; omitted for a plain-dir link. */
  worktreeVersion?: string;
  lines?: { from: number; to: number };
}): ComposerReference {
  const { entry } = input;
  const version = entry.sourceKind === "worktree" ? (input.worktreeVersion ?? null) : null;
  const suffix = input.lines ? `:${input.lines.from}-${input.lines.to}` : "";
  const origin =
    entry.sourceKind === "worktree"
      ? `${entry.displayName} · worktree${version ? ` @ ${version}` : ""}`
      : `${entry.displayName} → ${entry.target ?? "未知目标"} · 普通目录（无 Git 版本，修改影响原文件）`;
  return {
    id: input.id,
    kind: input.lines ? "snippet" : entry.kind,
    taskId: input.taskId,
    sourceId: entry.sourceId,
    sourceKind: entry.sourceKind,
    displayName: entry.displayName,
    target: entry.target,
    relativePath: entry.relativePath,
    version,
    lines: input.lines,
    label: `${entry.displayName}/${entry.relativePath}${suffix}`,
    detail: origin,
  };
}

/** Bounds a snippet copied from the file view; over-long selections are refused. */
export function boundSnippet(lines: { from: number; to: number }, text: string): { ok: true; lines: { from: number; to: number }; chars: number } | { ok: false; code: "too-many-lines" | "too-long"; message: string } {
  const count = lines.to - lines.from + 1;
  if (lines.from < 1 || lines.to < lines.from) {
    return { ok: false, code: "too-many-lines", message: "请选择有效的行范围" };
  }
  if (count > MAX_SNIPPET_LINES) {
    return { ok: false, code: "too-many-lines", message: `片段超过 ${MAX_SNIPPET_LINES} 行，请缩小范围` };
  }
  if (text.length > MAX_SNIPPET_CHARS) {
    return { ok: false, code: "too-long", message: `片段超过 ${MAX_SNIPPET_CHARS} 字符，请缩小范围` };
  }
  return { ok: true, lines, chars: text.length };
}

function isInsideSource(relativePath: string): boolean {
  if (relativePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(relativePath)) return false;
  return !relativePath.split(/[\\/]/).includes("..");
}

export type ReferenceStatus =
  | { state: "ok" }
  | { state: "invalid"; code: "cross-task" | "stale-source" | "moved" | "out-of-bounds" | "no-version"; message: string };

/**
 * Re-checks a stored draft reference against the live task. Failures require
 * re-selection; none of them silently resolve to another source.
 */
export function validateDraftReference(
  reference: Pick<ComposerReference, "taskId" | "sourceId" | "sourceKind" | "relativePath" | "version">,
  context: {
    taskId: string;
    entries: readonly TaskFileEntry[];
    /** Git version currently pinned on that worktree, when refreshed. */
    worktreeVersion?: string;
  },
): ReferenceStatus {
  if (reference.taskId !== context.taskId) {
    return { state: "invalid", code: "cross-task", message: "引用属于另一个任务，请重新选择来源" };
  }
  if (!isInsideSource(reference.relativePath)) {
    return { state: "invalid", code: "out-of-bounds", message: "引用路径越界，请重新选择" };
  }
  const entry = context.entries.find(
    (candidate) => candidate.sourceId === reference.sourceId && candidate.relativePath === reference.relativePath,
  );
  if (!entry) {
    const source = context.entries.some((candidate) => candidate.sourceId === reference.sourceId);
    return source
      ? { state: "invalid", code: "moved", message: "文件已移动，请重新选择，不回退到主检出目录" }
      : { state: "invalid", code: "stale-source", message: "来源已失效（目录链接或仓库已移除），请重新选择" };
  }
  if (entry.sourceKind === "worktree") {
    if (context.worktreeVersion === undefined || reference.version === null) {
      return { state: "invalid", code: "no-version", message: "无法确认该 worktree 的版本，请重新选择" };
    }
    if (context.worktreeVersion !== reference.version) {
      return { state: "invalid", code: "no-version", message: `引用版本 ${reference.version} 与当前 ${context.worktreeVersion} 不一致，请重新选择` };
    }
  }
  return { state: "ok" };
}

export type DraftReferenceReport = {
  references: { id: string; status: ReferenceStatus }[];
  /** True when at least one reference must be re-selected before sending. */
  requiresReselect: boolean;
};

export function validateDraftReferences(
  references: readonly (Pick<ComposerReference, "id" | "taskId" | "sourceId" | "sourceKind" | "relativePath" | "version">)[],
  context: { taskId: string; entries: readonly TaskFileEntry[]; worktreeVersion?: string },
): DraftReferenceReport {
  const reports = references.map((reference) => ({
    id: reference.id,
    status: validateDraftReference(reference, context),
  }));
  return { references: reports, requiresReselect: reports.some((report) => report.status.state === "invalid") };
}

/**
 * What the Agent actually receives for one reference, plus the estimate
 * rule: an estimated size is labelled and never counted as reported Token
 * usage (that only comes from real model responses).
 */
export function describeReferenceScope(reference: ComposerReference): string {
  const where =
    reference.sourceKind === "worktree"
      ? `${reference.displayName}/${reference.relativePath}${reference.version ? ` @ ${reference.version}` : ""}`
      : `${reference.displayName}/${reference.relativePath}（普通目录 → ${reference.target ?? "未知目标"}，不伪造 Git 版本）`;
  const amount =
    reference.kind === "directory"
      ? "目录清单（有界，不递归展开全部内容）"
      : reference.kind === "snippet"
        ? `第 ${reference.lines?.from ?? 1}-${reference.lines?.to ?? 1} 行片段`
        : "完整文件内容（有界，超限则拒绝而非截断冒充）";
  return `${where}：提供 ${amount}；大小仅为估算，不计入实报 Token 用量`;
}
