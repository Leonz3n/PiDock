/**
 * Pure composer registry rules for [PiDock 13] (#16): which skills and which
 * `/` entries the composer may offer, and whether they can run right now.
 *
 * - skills are aggregated from enabled global / project / task-repo sources
 *   plus explicitly added extra sources; a disabled source contributes
 *   nothing, and a name declared by two sources stays two rows so the user
 *   picks the source instead of getting whichever loaded first
 * - search matches the skill name or its description, and an invocation
 *   keeps the skill's resource relative path and its args (pi's own
 *   `/skill:name` syntax stays supported next to the `$name` shortcut)
 * - the `/` menu separates application actions, prompt templates and
 *   extension entries, shows their source/args/availability, and tells an
 *   unknown command what to type instead
 * - a busy turn, and a read-only session, bound what a shortcut may do: no
 *   shortcut opens a second execution or widens session/task permission
 */

import { suggestCommand, type ComposerSymbol } from "./composer-input.js";

export type SkillSourceKind = "global" | "project" | "task-repo" | "extra";

export type SkillSource = {
  id: string;
  kind: SkillSourceKind;
  /** What the candidate row shows, e.g. `全局 pi/skills`. */
  label: string;
  enabled: boolean;
};

export type SkillEntry = {
  id: string;
  name: string;
  description: string;
  sourceId: string;
  /** Resource relative path inside its source root, e.g. `skills/code-review/SKILL.md`. */
  resourcePath: string;
  /** True when running the skill can change the task (goes through the permission gate). */
  sideEffecting?: boolean;
};

export type SkillRow = {
  skillId: string;
  name: string;
  description: string;
  sourceId: string;
  sourceLabel: string;
  resourcePath: string;
  sideEffecting: boolean;
};

const SOURCE_ORDER: Record<SkillSourceKind, number> = { global: 0, project: 1, "task-repo": 2, extra: 3 };

/** Enabled sources in discovery order (global → project → task repo → explicit). */
export function enabledSkillSources(sources: readonly SkillSource[]): SkillSource[] {
  return sources
    .filter((source) => source.enabled)
    .slice()
    .sort((left, right) => SOURCE_ORDER[left.kind] - SOURCE_ORDER[right.kind] || left.label.localeCompare(right.label));
}

/**
 * Explicitly add an extra skill source (box 6). The id is unique; a disabled
 * extra source is added disabled and contributes nothing until enabled.
 */
export function addSkillSource(
  sources: readonly SkillSource[],
  input: { id: string; label: string; enabled?: boolean },
): { ok: true; sources: SkillSource[] } | { ok: false; code: "duplicate-source"; message: string } {
  if (sources.some((source) => source.id === input.id)) {
    return { ok: false, code: "duplicate-source", message: `技能来源 ${input.label} 已存在` };
  }
  return {
    ok: true,
    sources: [...sources, { id: input.id, kind: "extra", label: input.label, enabled: input.enabled ?? true }],
  };
}

/**
 * Search enabled skills by name or description. Rows keep their source, so
 * two sources declaring the same name yield two distinct candidates.
 */
export function searchSkills(registry: { sources: readonly SkillSource[]; skills: readonly SkillEntry[] }, query: string): SkillRow[] {
  const enabled = new Set(enabledSkillSources(registry.sources).map((source) => source.id));
  const byId = new Map(registry.sources.map((source) => [source.id, source]));
  const needle = query.trim().toLowerCase();
  const rows: SkillRow[] = [];
  for (const skill of registry.skills) {
    const source = byId.get(skill.sourceId);
    if (!source || !enabled.has(source.id)) continue;
    const name = skill.name.toLowerCase();
    const description = skill.description.toLowerCase();
    if (needle.length > 0 && !name.includes(needle) && !description.includes(needle)) continue;
    rows.push({
      skillId: skill.id,
      name: skill.name,
      description: skill.description,
      sourceId: source.id,
      sourceLabel: source.label,
      resourcePath: skill.resourcePath,
      sideEffecting: skill.sideEffecting ?? false,
    });
  }
  rows.sort((left, right) => {
    const leftName = left.name.toLowerCase().startsWith(needle) ? 0 : 1;
    const rightName = right.name.toLowerCase().startsWith(needle) ? 0 : 1;
    if (leftName !== rightName) return leftName - rightName;
    const leftSource = SOURCE_ORDER[byId.get(left.sourceId)?.kind ?? "extra"];
    const rightSource = SOURCE_ORDER[byId.get(right.sourceId)?.kind ?? "extra"];
    return leftSource - rightSource || left.name.localeCompare(right.name) || left.sourceLabel.localeCompare(right.sourceLabel);
  });
  return rows;
}

export type SkillInvocationPlan = {
  name: string;
  sourceId: string;
  sourceLabel: string;
  /** Resource relative path, preserved for pi's loader. */
  resourcePath: string;
  args: string;
  /** pi's own syntax, so the SDK expands the skill exactly once. */
  text: string;
  sideEffecting: boolean;
  candidateCount: number;
};

/**
 * Resolve `$name` / `/skill:name` to one concrete source. A duplicated name
 * has more than one candidate: the caller must pick a source, so this
 * returns without a plan (`ambiguous`) rather than choosing silently.
 */
export function planSkillInvocation(
  registry: { sources: readonly SkillSource[]; skills: readonly SkillEntry[] },
  input: { name: string; args?: string; sourceId?: string },
): { ok: true; plan: SkillInvocationPlan } | { ok: false; code: "unknown-skill" | "ambiguous-source"; message: string; candidates?: SkillRow[] } {
  const candidates = searchSkills(registry, input.name).filter((row) => row.name.toLowerCase() === input.name.toLowerCase());
  if (candidates.length === 0) return { ok: false, code: "unknown-skill", message: `未找到技能 ${input.name}，请从列表选择具体来源` };
  const chosen = input.sourceId ? candidates.filter((row) => row.sourceId === input.sourceId) : candidates;
  if (chosen.length === 0) {
    return { ok: false, code: "ambiguous-source", message: `技能 ${input.name} 不在所选来源中`, candidates };
  }
  if (chosen.length > 1) {
    return { ok: false, code: "ambiguous-source", message: `技能 ${input.name} 有多个来源，请选择具体来源`, candidates };
  }
  const row = chosen[0];
  const args = (input.args ?? "").trim();
  return {
    ok: true,
    plan: {
      name: row.name,
      sourceId: row.sourceId,
      sourceLabel: row.sourceLabel,
      resourcePath: row.resourcePath,
      args,
      text: `/skill:${row.name}${args.length > 0 ? ` ${args}` : ""}`,
      sideEffecting: row.sideEffecting,
      candidateCount: candidates.length,
    },
  };
}

export type CommandCategory = "app" | "template" | "extension";

export type CommandArgument = { name: string; description: string; required?: boolean };

export type ComposerCommand = {
  name: string;
  category: CommandCategory;
  /** Source of a template/extension entry; `PiDock` for application actions. */
  source: string;
  description: string;
  args?: readonly CommandArgument[];
  /** What the entry does, which decides the busy/idle rule below. */
  kind: "session" | "model" | "context" | "navigate" | "template" | "extension";
};

/** Box 9: the application actions the first release actually implements. */
export const BUILTIN_COMMANDS: readonly ComposerCommand[] = [
  { name: "/new", category: "app", source: "PiDock", description: "新建会话", kind: "session" },
  { name: "/model", category: "app", source: "PiDock", description: "切换 Provider / 模型", kind: "model" },
  { name: "/compact", category: "app", source: "PiDock", description: "压缩当前上下文", kind: "context" },
  { name: "/skills", category: "app", source: "PiDock", description: "查看可用技能", kind: "navigate" },
  { name: "/session", category: "app", source: "PiDock", description: "当前会话信息", kind: "navigate" },
  { name: "/usage", category: "app", source: "PiDock", description: "查看 Token 用量", kind: "navigate" },
  { name: "/help", category: "app", source: "PiDock", description: "查看命令说明", kind: "navigate" },
];

export type CommandAvailability = "available" | "waiting" | "unavailable";

export type CommandRow = {
  key: string;
  command: ComposerCommand;
  category: CommandCategory;
  source: string;
  args: readonly CommandArgument[];
  availability: CommandAvailability;
  /** Present when the entry cannot run now. */
  reason?: string;
};

export type ComposerRunContext = {
  runState: "idle" | "running" | "approval" | "stopped" | "failed";
  permission: "read" | "default" | "auto";
};

/**
 * Whether one `/` entry can run now (box 13):
 * - navigate/read-only entries always answer
 * - model/session/context changes wait for the current round to end
 * - template and extension entries are never queued mid-turn (pi refuses to
 *   queue extension commands), and a read-only session keeps them disabled
 *   so a shortcut can never widen the session's permission
 */
export function commandAvailability(command: ComposerCommand, context: ComposerRunContext): { availability: CommandAvailability; reason?: string } {
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

/**
 * The `/` menu, grouped by category with source/args/availability. A
 * duplicated entry name stays a separate row per source.
 */
export function listComposerCommands(
  commands: readonly ComposerCommand[],
  query: string,
  context: ComposerRunContext,
): { groups: { category: CommandCategory; items: CommandRow[] }[] } {
  const needle = query.trim().replace(/^\//, "").toLowerCase();
  const rows: CommandRow[] = [];
  for (const command of commands) {
    if (needle.length > 0 && !`${command.name} ${command.description}`.replace(/^\//, "").toLowerCase().includes(needle)) continue;
    const availability = commandAvailability(command, context);
    rows.push({
      key: `${command.category}:${command.source}:${command.name}`,
      command,
      category: command.category,
      source: command.source,
      args: command.args ?? [],
      ...availability,
    });
  }
  const order: CommandCategory[] = ["app", "template", "extension"];
  return {
    groups: order
      .map((category) => ({ category, items: rows.filter((row) => row.category === category) }))
      .filter((group) => group.items.length > 0),
  };
}

/**
 * What to show for an unknown `/entry`: the closest known name, or a plain
 * "unknown" message when nothing is close (never a guessed dispatch).
 */
export function describeUnknownCommand(name: string, known: readonly string[]): { message: string; suggestion: string | null } {
  const suggestion = suggestCommand(name, known);
  return {
    message:
      suggestion === null
        ? `未知命令 ${name}：请从列表选择，普通文字请直接输入`
        : `未知命令 ${name}，是否想输入 ${suggestion}？`,
    suggestion,
  };
}

export type { ComposerSymbol };
