/**
 * [#151] The one read-only capability a registered Skills source grants the
 * Agent: `SKILL.md` and the relative files it references may be READ even when
 * the source directory lives outside the task.
 *
 * The gap this closes: Pi advertises a skill by name, description and absolute
 * location, and loads the instructions only when the model reads that location.
 * A source the user added under `userData` (the 能力管理 → Skills pane) is
 * normally outside the task folder, so the task-scoped `fs.read` confinement
 * refused the very file the prompt had just advertised. The pane tests showed
 * the rows; a real turn could not use them.
 *
 * What is granted is deliberately narrow:
 *
 * - only a path whose LEXICAL spelling is inside an explicitly registered source
 *   directory is considered at all; anything else keeps the task refusal (there
 *   is no "the real path happens to be inside a source" shortcut, so a link the
 *   task planted cannot pull an external source into scope);
 * - the source must be `enabled` in the CURRENT app-private document: the
 *   document is re-read and the source re-resolved on every call, so switching a
 *   source off or removing it withdraws the capability immediately - a running
 *   session keeps its advertised skills but cannot read them any more, exactly
 *   like the session boundary documented in `sdk-text-kernel.ts`;
 * - containment is decided on REAL paths: the source root is `realpath`ed and
 *   the requested real path must stay inside it. A symlink inside the source
 *   that resolves outside is refused by name (`skill-source-escape`), never
 *   followed;
 * - only the source that contains the requested lexical path is consulted (the
 *   first one in list order). A disabled/missing/unreadable match is a named
 *   refusal - the lookup never falls through to another source;
 * - the caller does not gain `fs.search`, `fs.write` or `exec.run` anywhere:
 *   those keep the task-only rules, and a directory target is not listed.
 *
 * Nothing here writes, caches or remembers a grant: every call reads the real
 * document and stats the real disk, which is what makes a toggle/removal
 * effective on the next read.
 */

import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeScopePath } from "./path-coordination.js";
import { readSkillConfig, type SkillConfigSource } from "./skill-sources.js";

/** The path spellings one `fs.read` request produced (lexical + fully resolved). */
export type SkillResourceTarget = {
  /** `resolve(taskDir, requested)` - what the model literally named. */
  lexical: string;
  /** The same path with every symlink followed (real path). */
  real: string;
};

export type SkillResourceRefusalCode =
  | "tool-refused:skill-source-disabled"
  | "tool-refused:skill-source-missing"
  | "tool-refused:skill-source-unreadable"
  | "tool-refused:skill-source-escape"
  | "tool-refused:skill-source-unknown";

export type SkillResourceDecision =
  /** The requested path resolves inside this enabled source and may be read. */
  | { kind: "grant"; sourceId: string; sourcePath: string; real: string }
  | { kind: "refused"; code: SkillResourceRefusalCode; reason: string };

function inside(path: string, root: string): boolean {
  const target = normalizeScopePath(path);
  const scope = normalizeScopePath(root);
  if (target.length === 0 || scope.length === 0) return false;
  return target === scope || target.startsWith(`${scope}/`);
}

function sourceRoot(source: SkillConfigSource): { ok: true; real: string } | { ok: false; code: "missing" | "unreadable" } {
  try {
    if (!statSync(source.path).isDirectory()) return { ok: false, code: "missing" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, code: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable" };
  }
  try {
    return { ok: true, real: realpathSync(source.path) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, code: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable" };
  }
}

/**
 * Decide one `fs.read` against the CURRENT Skills source document.
 *
 * `null` means "this is not a Skills resource request": the caller keeps its own
 * task-scoped refusal. Any registered-source match answers with a grant or a
 * named refusal, and never tries a later source.
 */
export function decideSkillResourceRead(
  configFile: string | undefined,
  target: SkillResourceTarget,
): SkillResourceDecision | null {
  if (!configFile) return null;
  const read = readSkillConfig(configFile);
  // No usable document = no grant at all. A corrupt list is reported by the
  // pane; it must never be interpreted as "every source is on".
  if (read.state !== "ok") return null;
  for (const source of read.config.sources) {
    if (!inside(target.lexical, resolve(source.path))) continue;
    if (!source.enabled) {
      return {
        kind: "refused",
        code: "tool-refused:skill-source-disabled",
        reason: `来源 ${source.path} 已停用，技能资源需重新启用后才能读取`,
      };
    }
    const root = sourceRoot(source);
    if (!root.ok) {
      return root.code === "missing"
        ? { kind: "refused", code: "tool-refused:skill-source-missing", reason: `来源目录 ${source.path} 不存在或不是目录` }
        : { kind: "refused", code: "tool-refused:skill-source-unreadable", reason: `来源目录 ${source.path} 不可访问` };
    }
    if (!inside(target.real, root.real)) {
      return {
        kind: "refused",
        code: "tool-refused:skill-source-escape",
        reason: `目标解析为 ${target.real}，已在来源目录 ${root.real} 之外，拒绝跟随链接`,
      };
    }
    return { kind: "grant", sourceId: source.id, sourcePath: source.path, real: target.real };
  }
  return null;
}
