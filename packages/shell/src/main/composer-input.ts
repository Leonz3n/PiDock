/**
 * Pure composer-input rules for [PiDock 13] (#16).
 *
 * The desktop composer has its own candidate UI, keyboard rules and
 * structured reference model, so the raw text is not handed to pi
 * unchanged. These rules are shared by the main process (what actually
 * reaches the session) and mirrored in the renderer so the candidate list
 * matches what will be sent:
 *
 * - a marker only counts as an entry point when it starts a trailing token
 *   and is not inside code; `@`/`$`/`/` in emails, URLs, Unix/Windows
 *   paths, inline code, fenced blocks, `$HOME` and escaped symbols stay
 *   literal text and never trigger an operation (no shell expansion)
 * - `/` is a command entry only at the very start of the message
 * - a skill is invoked by `$name` (PiDock's shortcut) or `/skill:name`
 *   (pi's own syntax); args follow on the same line, and an unresolved
 *   marker stays text instead of dispatching anything
 * - keyboard intent is resolved without touching the DOM so "confirm the
 *   candidate" can never also send, and an IME composition confirm never
 *   submits the message
 */

export type ComposerSymbol = "@" | "$" | "/";

/** A trailing marker token the candidate list should serve. */
export type CompletionToken = {
  symbol: ComposerSymbol;
  query: string;
  /** Index of the marker in the raw text; the replaced region starts here. */
  start: number;
  /** Caret index; the token runs from `start` to here. */
  end: number;
};

export type CodeRegion = { start: number; end: number; kind: "inline-code" | "fence" };

export type SkillInvocation = {
  name: string;
  args: string;
  /** `$name` (PiDock shortcut) or `/skill:name` (pi syntax). */
  style: "dollar" | "slash";
  /** `false` for `/skill:name` naming a skill no enabled source declares. */
  resolved: boolean;
  /** The source text of the invocation without its args. */
  raw: string;
  start: number;
  end: number;
};

export type ComposerSegment = { kind: "text"; value: string } | { kind: "skill"; invocation: SkillInvocation };

/**
 * Regions whose contents are literal text. Unterminated fences run to the
 * end of the input (never a silent escape hatch for marker parsing).
 */
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

/**
 * `${VAR}` and `$HOME` are ordinary text (the spec keeps a plain `$HOME`
 * as-is); only a lowercase skill-shaped name opens the skill candidate list.
 */
export function isEnvStyleDollar(text: string, symbolIndex: number): boolean {
  if (text[symbolIndex] !== "$") return false;
  const rest = text.slice(symbolIndex + 1);
  return /^\{[A-Za-z_][A-Za-z0-9_]*\}/.test(rest) || /^[A-Z_][A-Z0-9_]*\b/.test(rest);
}

/** The trailing `@`/`$`/`/` token at the caret, or `null` when none applies. */
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

/**
 * `$name` and `/skill:name` invocations in source order. Args run to the
 * next invocation or the end of the line, so combining skills never makes
 * one skill swallow the next.
 */
export function parseSkillInvocations(text: string, knownSkills: readonly string[]): SkillInvocation[] {
  const known = new Set(knownSkills);
  const regions = scanCodeRegions(text);
  const inCode = (index: number) => regions.some((region) => index > region.start && index < region.end);
  const candidates: {
    name: string;
    style: "dollar" | "slash";
    start: number;
    nameEnd: number;
  }[] = [];
  const dollar = /(^|\s)\$([a-z0-9][a-z0-9_-]*)/g;
  for (let match = dollar.exec(text); match !== null; match = dollar.exec(text)) {
    const marker = match.index + match[1].length;
    if (match.index > 0 && text[match.index - 1] === "\\") continue;
    if (isEnvStyleDollar(text, marker)) continue;
    if (inCode(marker)) continue;
    if (!known.has(match[2])) continue;
    candidates.push({ name: match[2], style: "dollar", start: marker, nameEnd: marker + 1 + match[2].length });
  }
  const slash = /(^|\s)\/skill:([A-Za-z0-9][A-Za-z0-9_-]*)/g;
  for (let match = slash.exec(text); match !== null; match = slash.exec(text)) {
    const marker = match.index + match[1].length;
    if (match.index > 0 && text[match.index - 1] === "\\") continue;
    if (inCode(marker)) continue;
    candidates.push({ name: match[2], style: "slash", start: marker, nameEnd: marker + 7 + match[2].length });
  }
  candidates.sort((a, b) => a.start - b.start);
  return candidates.map((candidate, position) => {
    const next = candidates[position + 1];
    const lineEnd = text.indexOf("\n", candidate.nameEnd);
    const argsEnd = Math.min(next ? next.start : Number.POSITIVE_INFINITY, lineEnd === -1 ? Number.POSITIVE_INFINITY : lineEnd);
    const args = text.slice(candidate.nameEnd, argsEnd).trim();
    return {
      name: candidate.name,
      args,
      style: candidate.style,
      resolved: known.has(candidate.name),
      raw: text.slice(candidate.start, candidate.nameEnd),
      start: candidate.start,
      end: candidate.nameEnd,
    };
  });
}

/**
 * Structured input for one message: literal text stays verbatim, each skill
 * becomes exactly one segment (SDK expansion must not duplicate it), and a
 * resolved invocation's source text is removed from the literal text while
 * its args stay with the skill.
 */
export function splitComposerSegments(text: string, knownSkills: readonly string[]): ComposerSegment[] {
  const invocations = parseSkillInvocations(text, knownSkills);
  if (invocations.length === 0) return text.length > 0 ? [{ kind: "text", value: text }] : [];
  const segments: ComposerSegment[] = [];
  let cursor = 0;
  for (const invocation of invocations) {
    const literal = text.slice(cursor, invocation.start);
    if (literal.length > 0) segments.push({ kind: "text", value: literal });
    segments.push({ kind: "skill", invocation });
    cursor = invocation.end;
  }
  const tail = text.slice(cursor);
  if (tail.length > 0) segments.push({ kind: "text", value: tail });
  return segments;
}

export type ComposerKeyInput = {
  key: string;
  shift?: boolean;
  /** True while an IME composition is active (`event.isComposing`). */
  composing?: boolean;
  /** Number of candidates the current completion list shows. */
  candidateCount?: number;
};

export type ComposerKeyAction =
  | "ignore-composition"
  | "confirm-candidate"
  | "close-candidate"
  | "move-candidate-down"
  | "move-candidate-up"
  | "send"
  | "newline"
  | "none";

/** Keyboard intent for one keydown; "confirm-candidate" never also sends. */
export function resolveComposerKey(input: ComposerKeyInput): ComposerKeyAction {
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
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      diagonal = top;
    }
  }
  return previous[right.length];
}

/**
 * Correction for an unknown `/command`: the closest known entry, or `null`
 * when nothing is close enough (the composer then says the command is
 * unknown instead of guessing).
 */
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
  const threshold = target.length <= 4 ? 1 : 2;
  return best !== null && bestDistance <= threshold ? best : null;
}
