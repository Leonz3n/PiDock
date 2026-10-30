/**
 * [PiDock 13] (#16 盒 3) 引用与附件怎么到达 Agent（#117 第 1 项，业主定 A）。
 *
 * `session.prompt()` only takes a string, so the Host — not the renderer and not
 * the SDK — composes one fixed trailing section from the turn's structured
 * references and attachments. That keeps three things true at once:
 *
 * - the Agent sees the identities (kind, root/source, path) but never file
 *   contents: nothing here reads a file;
 * - the renderer cannot smuggle arbitrary prompt text through the context
 *   fields (every field is one bounded line, and the block is appended, never
 *   interleaved with what the user typed);
 * - the prompt fingerprint covers the composed text, so the same request id
 *   replays only when the same references came with it.
 */

export const PROMPT_CONTEXT_KINDS = ["file", "directory", "snippet", "attachment", "skill"] as const;
export type PromptContextKind = (typeof PROMPT_CONTEXT_KINDS)[number];

export type PromptContextEntry = {
  kind: PromptContextKind;
  label: string;
  /** Where the identity came from: root name, 普通目录, 外部附件… */
  source?: string;
  /** The in-source relative path or the attachment's own line. */
  detail?: string;
};

export type PromptContext = {
  references?: readonly PromptContextEntry[];
  attachments?: readonly PromptContextEntry[];
};

/** Bounds: one entry per line, at most 20 lines per list, 4096 bytes of block. */
export const PROMPT_CONTEXT_LIMITS = { entries: 20, label: 200, source: 200, detail: 400, block: 4096 } as const;

const SECTION_TITLE = "—— PiDock 引用与附件（Host 附加，共 {count} 项）——";
const SECTION_NOTE = "以上是清单与来源身份，不是文件内容；需要时请用工具自行读取。";

function validEntry(entry: unknown): entry is PromptContextEntry {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["kind", "label", "source", "detail"].includes(key))) return false;
  if (!PROMPT_CONTEXT_KINDS.includes(record["kind"] as PromptContextKind)) return false;
  const label = record["label"];
  if (typeof label !== "string" || label.trim().length === 0 || label.length > PROMPT_CONTEXT_LIMITS.label) return false;
  for (const key of ["source", "detail"] as const) {
    const value = record[key];
    if (value !== undefined && (typeof value !== "string" || value.length > PROMPT_CONTEXT_LIMITS[key])) return false;
  }
  return true;
}

function line(entry: PromptContextEntry): string {
  const parts = [entry.source, entry.detail].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return `- [${entry.kind}] ${entry.label.trim()}${parts.length > 0 ? ` — ${parts.join(" · ")}` : ""}`;
}

/**
 * Validate the envelope before anything is journaled or sent. Returns the named
 * refusal, or `null` when the context is acceptable. The Host's payload guard
 * and the composer below share this one rule set.
 */
export function promptContextError(input: { references?: unknown; attachments?: unknown }): string | null {
  for (const list of [input.references, input.attachments]) {
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > PROMPT_CONTEXT_LIMITS.entries) return "sdk-prompt-context-invalid: 条目过多或不是数组";
    if (!list.every(validEntry)) return "sdk-prompt-context-invalid: 条目字段不合法";
  }
  return null;
}

/**
 * Compose the prompt the Host will hand to the SDK. Without any context the
 * caller's text is returned unchanged (no empty section, no drifting prompt).
 */
export function composePromptContext(text: string, context?: PromptContext): { ok: true; prompt: string } | { ok: false; error: string } {
  const references = context?.references ?? [];
  const attachments = context?.attachments ?? [];
  if (references.length === 0 && attachments.length === 0) return { ok: true, prompt: text };
  const invalid = promptContextError({ references, attachments });
  if (invalid) return { ok: false, error: invalid };
  const sections: string[] = [SECTION_TITLE.replace("{count}", String(references.length + attachments.length))];
  if (references.length > 0) sections.push("引用", ...references.map(line));
  if (attachments.length > 0) sections.push("附件", ...attachments.map(line));
  sections.push(SECTION_NOTE);
  const block = sections.join("\n");
  if (Buffer.byteLength(block, "utf8") > PROMPT_CONTEXT_LIMITS.block) return { ok: false, error: "sdk-prompt-context-invalid: 附加段落超长" };
  return { ok: true, prompt: `${text}\n\n${block}` };
}
