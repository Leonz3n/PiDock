import type { Capability, Reference, Task } from "./types";

/**
 * [PiDock 13] (#16) renderer mirror of the shell composer rules
 * (`packages/shell/src/main/composer-input.ts` + `composer-references.ts` +
 * `composer-registry.ts`). The renderer must not import the shell package
 * (that would hand the sandbox Node access), so the candidate list, the
 * keyboard rules and the reference validation are mirrored here and locked
 * by `test/composerRules.test.ts`.
 *
 * The mirror covers the parts the input box needs: marker detection that
 * keeps emails/URLs/paths/code/`$HOME`/escapes literal, keyboard intent
 * (confirm-candidate never also sends, IME composition never submits),
 * candidates that carry their task source and stay bounded, and a draft
 * reference check that marks a moved/stale/cross-task source as needing
 * re-selection instead of resolving to another file.
 */

export type ComposerSymbol = "@" | "$" | "/";

export type CompletionToken = { symbol: ComposerSymbol; query: string; start: number; end: number };

export type CodeRegion = { start: number; end: number; kind: "inline-code" | "fence" };

export function scanCodeRegions(text: string): CodeRegion[] {
  const regions: CodeRegion[] = [];
  let index = 0;
  let fenceStart = -1;
  while (index < text.length) {
    if (text.startsWith("```", index)) {
      if (fenceStart === -1) {
        fenceStart = index;
        index += 3;
        continue;
      }
      regions.push({ start: fenceStart, end: index + 3, kind: "fence" });
      fenceStart = -1;
      index += 3;
      continue;
    }
    if (fenceStart === -1 && text[index] === "`") {
      const close = text.indexOf("`", index + 1);
      if (close !== -1 && !text.slice(index + 1, close).includes("\n")) {
        regions.push({ start: index, end: close + 1, kind: "inline-code" });
        index = close + 1;
        continue;
      }
    }
    index += 1;
  }
  if (fenceStart !== -1) regions.push({ start: fenceStart, end: text.length, kind: "fence" });
  return regions;
}

export function isInsideCode(text: string, index: number): boolean {
  return scanCodeRegions(text).some((region) => index > region.start && index < region.end);
}

export function isEnvStyleDollar(text: string, symbolIndex: number): boolean {
  if (text[symbolIndex] !== "$") return false;
  const rest = text.slice(symbolIndex + 1);
  return /^\{[A-Za-z_][A-Za-z0-9_]*\}/.test(rest) || /^[A-Z_][A-Z0-9_]*\b/.test(rest);
}

export function activeCompletionToken(text: string, caret: number): CompletionToken | null {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null;
  const prefix = text.slice(0, caret);
  const match = /(^|\s)([@$/])([^\s]*)$/.exec(prefix);
  if (!match) return null;
  const symbol = match[2] as ComposerSymbol;
  const start = caret - match[3].length - 1;
  if (isInsideCode(text, start)) return null;
  if (symbol === "/" && text.slice(0, start).trim().length > 0) return null;
  if (symbol !== "/" && start > 0 && prefix[start - 1] === "\\") return null;
  if (symbol === "$" && isEnvStyleDollar(text, start)) return null;
  return { symbol, query: match[3], start, end: caret };
}

export type ComposerKeyAction =
  | "ignore-composition"
  | "confirm-candidate"
  | "close-candidate"
  | "move-candidate-down"
  | "move-candidate-up"
  | "send"
  | "newline"
  | "none";

export function resolveComposerKey(input: { key: string; shift?: boolean; composing?: boolean; candidateCount?: number }): ComposerKeyAction {
  if (input.composing) return "ignore-composition";
  const open = (input.candidateCount ?? 0) > 0;
  if (open && input.key === "ArrowDown") return "move-candidate-down";
  if (open && input.key === "ArrowUp") return "move-candidate-up";
  if (open && (input.key === "Enter" || input.key === "Tab")) return "confirm-candidate";
  if (open && input.key === "Escape") return "close-candidate";
  if (input.key === "Enter" && input.shift) return "newline";
  if (input.key === "Enter") return "send";
  return "none";
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const top = previous[column];
      previous[column] = Math.min(previous[column] + 1, previous[column - 1] + 1, diagonal + (left[row - 1] === right[column - 1] ? 0 : 1));
      diagonal = top;
    }
  }
  return previous[right.length];
}

export function suggestCommand(name: string, known: readonly string[]): string | null {
  const target = name.replace(/^\//, "").toLowerCase();
  if (target.length === 0) return null;
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of known) {
    const distance = editDistance(target, candidate.replace(/^\//, "").toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best !== null && bestDistance <= (target.length <= 4 ? 1 : 2) ? best : null;
}

/** Default ignored directories for the task file candidate list. */
export const IGNORED_DIRECTORIES: readonly string[] = ["node_modules", ".git", "dist", "build", "out", "coverage", ".turbo", ".next", "target", "vendor"];

export function isIgnoredPath(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some((segment) => IGNORED_DIRECTORIES.includes(segment));
}

export type CandidateAvailability = "available" | "waiting" | "unavailable";

/** One row of the composer candidate list. */
export type CandidateRow = {
  key: string;
  kind: "file" | "directory" | "skill" | "command";
  /** Text inserted into the draft (`@`/`$`) or the command name (`/`). */
  value: string;
  label: string;
  detail: string;
  source: string;
  sourceId?: string;
  /** Task-reference provenance carried into the draft chip (box 4/15). */
  sourceKind?: "worktree" | "plain-dir";
  relativePath?: string;
  availability: CandidateAvailability;
  reason?: string;
};

export type ComposerCommandView = {
  name: string;
  category: "app" | "template" | "extension";
  source: string;
  description: string;
  availability: CandidateAvailability;
  reason?: string;
};

/**
 * Task file/directory entries with their source identity. `task.files`
 * paths are already `<source>/<relative>`; plain-directory links are
 * separate sources that never fake a Git version.
 */
export function taskSourceEntries(task: Pick<Task, "files" | "directories">): { sourceId: string; sourceKind: "worktree" | "plain-dir"; displayName: string; target?: string; relativePath: string; kind: "file" | "directory" }[] {
  const entries: { sourceId: string; sourceKind: "worktree" | "plain-dir"; displayName: string; target?: string; relativePath: string; kind: "file" | "directory" }[] = [];
  for (const file of task.files) {
    const separator = file.path.indexOf("/");
    const displayName = separator === -1 ? "workspace" : file.path.slice(0, separator);
    const relativePath = separator === -1 ? file.path : file.path.slice(separator + 1);
    entries.push({ sourceId: displayName, sourceKind: "worktree", displayName, relativePath, kind: "file" });
  }
  for (const directory of task.directories) {
    entries.push({ sourceId: directory.id, sourceKind: "plain-dir", displayName: directory.linkName, target: directory.path, relativePath: "", kind: "directory" });
  }
  return entries;
}

/** `@` candidates: task worktree files + plain-directory links, bounded. */
export function fileCandidates(task: Pick<Task, "files" | "directories">, query: string, limit = 20): CandidateRow[] {
  const needle = query.toLowerCase();
  const rows: CandidateRow[] = [];
  for (const entry of taskSourceEntries(task)) {
    if (entry.relativePath.length > 0 && isIgnoredPath(entry.relativePath)) continue;
    const label = entry.relativePath.length > 0 ? `${entry.displayName}/${entry.relativePath}` : `${entry.displayName}/`;
    if (needle.length > 0 && !label.toLowerCase().includes(needle)) continue;
    rows.push({
      key: `file:${entry.sourceId}:${entry.relativePath}`,
      kind: entry.kind,
      value: label,
      label,
      detail:
        entry.sourceKind === "worktree"
          ? `${entry.displayName} · 任务代码引用`
          : `${entry.displayName} → ${entry.target ?? "未知目标"} · 普通目录（无 Git 版本，修改影响原文件）`,
      source: entry.displayName,
      sourceId: entry.sourceId,
      sourceKind: entry.sourceKind,
      relativePath: entry.relativePath,
      availability: "available",
    });
  }
  rows.sort((left, right) => left.label.localeCompare(right.label));
  return rows.slice(0, limit);
}

/** `$` candidates: enabled skills with their source kept distinct. */
export function skillCandidates(capabilities: readonly Capability[], query: string): CandidateRow[] {
  const needle = query.toLowerCase();
  return capabilities
    .filter((capability) => capability.kind === "skill" && capability.status === "enabled")
    .filter((capability) => needle.length === 0 || `${capability.name} ${capability.source}`.toLowerCase().includes(needle))
    .map((capability) => ({
      key: `skill:${capability.id}`,
      kind: "skill" as const,
      value: `$${capability.name}`,
      label: `$${capability.name}`,
      detail: `${capability.source} · ${capability.scope} · 已启用技能`,
      source: capability.source,
      sourceId: capability.id,
      availability: "available" as const,
    }));
}

/** A stored draft reference: its label plus the provenance the check needs. */
export type DraftReferenceCheck = { state: "ok" } | { state: "invalid"; code: "cross-task" | "stale-source" | "moved" | "out-of-bounds"; message: string };

/**
 * Box 4/14/15: a reference whose source vanished, moved, left the task or
 * belongs to another task must be re-selected. Nothing here resolves to the
 * main checkout or to another task's same-named file.
 */
export function checkDraftReference(reference: Reference, task: Pick<Task, "id" | "files" | "directories">): DraftReferenceCheck {
  if (reference.kind === "attachment" || reference.kind === "skill") return { state: "ok" };
  if (reference.taskId !== undefined && reference.taskId !== task.id) {
    return { state: "invalid", code: "cross-task", message: "引用属于另一个任务，请重新选择来源" };
  }
  const relativePath = reference.relativePath;
  if (relativePath === undefined || relativePath.length === 0) return { state: "ok" };
  if (relativePath.startsWith("/") || relativePath.split(/[\\/]/).includes("..")) {
    return { state: "invalid", code: "out-of-bounds", message: "引用路径越界，请重新选择" };
  }
  const entries = taskSourceEntries(task);
  const sourceId = reference.sourceId;
  const sameSource = entries.filter((entry) => entry.sourceId === sourceId);
  if (sourceId !== undefined && sameSource.length === 0) {
    return { state: "invalid", code: "stale-source", message: "来源已失效（目录链接或仓库已移除），请重新选择" };
  }
  const found = sameSource.some((entry) => entry.relativePath === relativePath);
  if (!found && sameSource.length > 0) {
    return { state: "invalid", code: "moved", message: "文件已移动，请重新选择，不回退到主检出目录" };
  }
  return { state: "ok" };
}

/** What the Agent receives for one reference; sizes stay labelled as estimates. */
export function describeReferenceChip(reference: Reference): string {
  if (reference.kind === "attachment") return `${reference.label}：仅该文件，未授权访问所在目录`;
  if (reference.kind === "skill") return `${reference.label}：技能资源 ${reference.resourcePath ?? "（来源已记录）"}${reference.args ? ` · 参数 ${reference.args}` : ""}`;
  const origin = reference.sourceKind === "plain-dir" ? "普通目录（无 Git 版本）" : `worktree${reference.version ? ` @ ${reference.version}` : ""}`;
  return `${reference.label}：${origin}；内容范围按所选文件/片段读取，大小为估算，不计入实报 Token`;
}

export type ComposerCommandKind = "session" | "model" | "context" | "navigate" | "template" | "extension";

export type ComposerCommandEntry = {
  name: string;
  category: "app" | "template" | "extension";
  source: string;
  description: string;
  kind: ComposerCommandKind;
  args?: { name: string; description: string; required?: boolean }[];
};

/** Mirror of the shell `BUILTIN_COMMANDS` (box 9). */
export const BUILTIN_COMMANDS: readonly ComposerCommandEntry[] = [
  { name: "/new", category: "app", source: "PiDock", description: "新建会话", kind: "session" },
  { name: "/model", category: "app", source: "PiDock", description: "切换 Provider / 模型", kind: "model" },
  { name: "/compact", category: "app", source: "PiDock", description: "压缩当前上下文", kind: "context" },
  { name: "/skills", category: "app", source: "PiDock", description: "查看可用技能", kind: "navigate" },
  { name: "/session", category: "app", source: "PiDock", description: "当前会话信息", kind: "navigate" },
  { name: "/usage", category: "app", source: "PiDock", description: "查看 Token 用量", kind: "navigate" },
  { name: "/help", category: "app", source: "PiDock", description: "查看命令说明", kind: "navigate" },
];

export type ComposerRunContext = { runState: "idle" | "running" | "approval" | "stopped" | "failed"; permission: "read" | "default" | "auto" };

/** Mirror of the shell `commandAvailability` rules (busy turn, read-only session). */
export function commandAvailability(command: ComposerCommandEntry, context: ComposerRunContext): { availability: CandidateAvailability; reason?: string } {
  if (context.permission === "read" && (command.kind === "template" || command.kind === "extension")) {
    return { availability: "unavailable", reason: "只读会话不执行会改变任务的操作，请先调整会话权限" };
  }
  const busy = context.runState === "running" || context.runState === "approval";
  if (!busy) return { availability: "available" };
  if (command.kind === "template" || command.kind === "extension") {
    return { availability: "unavailable", reason: "扩展命令不能在执行中排队，请先等待完成或停止" };
  }
  if (command.kind === "model" || command.kind === "session" || command.kind === "context") {
    return { availability: "waiting", reason: "当前回合尚未结束，命令会等待完成后再执行" };
  }
  return { availability: "available" };
}

/** `/` candidates grouped by category, with source, args and availability. */
export function commandCandidates(
  commands: readonly ComposerCommandEntry[],
  query: string,
  context: ComposerRunContext,
): { category: "app" | "template" | "extension"; items: CandidateRow[] }[] {
  const needle = query.trim().replace(/^\//, "").toLowerCase();
  const rows: { category: "app" | "template" | "extension"; row: CandidateRow }[] = [];
  for (const command of commands) {
    if (needle.length > 0 && !`${command.name} ${command.description}`.replace(/^\//, "").toLowerCase().includes(needle)) continue;
    const availability = commandAvailability(command, context);
    rows.push({
      category: command.category,
      row: {
        key: `command:${command.category}:${command.source}:${command.name}`,
        kind: "command",
        value: command.name,
        label: command.name,
        detail: command.args && command.args.length > 0 ? `${command.description} · 参数 ${command.args.map((arg) => arg.name).join(" ")}` : command.description,
        source: command.source,
        availability: availability.availability,
        ...(availability.reason !== undefined ? { reason: availability.reason } : {}),
      },
    });
  }
  return (["app", "template", "extension"] as const)
    .map((category) => ({ category, items: rows.filter((item) => item.category === category).map((item) => item.row) }))
    .filter((group) => group.items.length > 0);
}
