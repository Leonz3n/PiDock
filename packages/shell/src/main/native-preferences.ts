/**
 * [Pencil T14] #149 — Pi's native preference files as a BOUNDED projection.
 *
 * Pi 1.5.0 keeps its user configuration in `<agent-dir>` (docs/configuration.md):
 * `settings.json` for settings and `keybindings.json` for keybindings. PiDock
 * may only edit *documented supported fields* of that surface, so this module
 * is deliberately narrow:
 *
 * - The editable slice is ONE named key of `keybindings.json` at a time. Every
 *   other property (other Pi actions, `$schema`, and anything Pi 1.5 adds
 *   later) is preserved byte-for-byte: the write splices the new value into the
 *   ORIGINAL text instead of re-serializing the document, so key order,
 *   indentation, comments-as-strings and unknown fields cannot be rewritten.
 * - `settings.json` is READ ONLY here and only to report the honest support
 *   boundary. Pi 1.5.0's `settings.schema.json` has no language/locale key, so
 *   the 语言 pane must say 不支持 with that file's real path rather than offer a
 *   control that writes nothing.
 * - `selfUpdateCommand` (Pi's own `pi update`) and extension-update notices are
 *   NOT exposed: PiDock ships a fixed SDK (see docs/architecture/
 *   pi-1.5-upgrade-design.md, "原生配置管理是受支持设置的有界投影").
 *
 * Reload boundary, stated to the user: `keybindings.json` is only read by Pi's
 * own terminal UI, and Pi applies it on `/reload` or the next start. PiDock's
 * React shell draws its own shortcuts, so a saved Pi binding takes effect in
 * Pi's TUI on restart and never silently claims to have retargeted a PiDock
 * key. `reloadBoundary` carries that fact so the page cannot invent a
 * different story.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The document Pi reads for custom keybindings (`<agent-dir>/keybindings.json`). */
export const KEYBINDINGS_FILE = "keybindings.json";
/** The document Pi reads for settings (`<agent-dir>/settings.json`); read-only here. */
export const SETTINGS_FILE = "settings.json";
export const KEYBINDINGS_SCHEMA_URL = "https://pi.dev/schemas/keybindings.schema.json";

const MAX_BYTES = 1024 * 1024;

/**
 * The PiDock-editable subset of Pi's documented actions. Every id below exists
 * in Pi 1.5.0's `keybindings.schema.json`; `defaults` are the documented
 * defaults from `docs/keybindings.md`. An action outside this list is refused
 * BY NAME, so PiDock can never write an id it cannot verify.
 */
export const MANAGED_KEYBINDINGS = [
  { id: "app.interrupt", label: "中止当前回合", defaults: ["escape"] },
  { id: "app.session.new", label: "新建会话", defaults: [] },
  { id: "app.session.tree", label: "打开会话树", defaults: [] },
  { id: "app.model.select", label: "打开模型选择", defaults: ["ctrl+l"] },
  { id: "app.thinking.cycle", label: "切换推理档位", defaults: ["shift+tab"] },
  { id: "app.tools.expand", label: "展开／收起工具输出", defaults: ["ctrl+o"] },
  { id: "app.editor.external", label: "在外部编辑器中打开", defaults: ["ctrl+g"] },
] as const;

export type ManagedKeybindingId = (typeof MANAGED_KEYBINDINGS)[number]["id"];

const MANAGED_IDS = new Set<string>(MANAGED_KEYBINDINGS.map((item) => item.id));

/**
 * Key syntax per `docs/keybindings.md`: `modifier+key`, modifiers
 * `ctrl|shift|alt|super`, letters, digits, the documented special/function
 * names and the documented symbol keys. A value Pi would silently ignore is
 * refused here instead of being written and shown as if it worked.
 */
const SPECIAL_KEYS = new Set([
  "escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear",
  "home", "end", "pageup", "pagedown", "up", "down", "left", "right",
  ...Array.from({ length: 12 }, (_unused, index) => `f${index + 1}`),
]);
const SYMBOL_KEYS = new Set([...'`-=[]\\;\',./!@#$%^&*()_+|~{}:<>?']);

/** `null` = not a key Pi documents (the caller turns that into a named refusal). */
export function normalizeKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  const parts = trimmed.split("+");
  const key = parts.pop() ?? "";
  for (const modifier of parts) {
    if (modifier !== "ctrl" && modifier !== "shift" && modifier !== "alt" && modifier !== "super") return null;
  }
  if (new Set(parts).size !== parts.length) return null;
  if (/^[a-z0-9]$/.test(key)) return trimmed;
  if (SPECIAL_KEYS.has(key) || SYMBOL_KEYS.has(key)) return trimmed;
  return null;
}

export type KeybindingView = {
  id: ManagedKeybindingId;
  label: string;
  /** What Pi documents as the default (unchanged when the file says nothing). */
  defaultKeys: string[];
  /** What `keybindings.json` currently assigns (empty = Pi's default / disabled). */
  keys: string[];
  /** `custom` once the file names this action; `default` otherwise. */
  source: "custom" | "default";
};

export type UnsupportedField = {
  pane: "language" | "general";
  /** The Pi field, or the fact that no field exists. */
  field: string;
  /** The real file the value would live in. */
  path: string;
  status: "unsupported" | "unwired";
  reason: string;
};

export type NativePreferencesView = {
  agentDir: string;
  keybindingsPath: string;
  settingsPath: string;
  keybindings: KeybindingView[];
  /** Every problem with the document, named; the page shows them verbatim. */
  keybindingsError: string | null;
  /** `missing` is the honest first-run state; `invalid` is a named refusal. */
  settingsState: "missing" | "present" | "invalid";
  unsupported: UnsupportedField[];
  reloadBoundary: string;
};

export type NativePreferencesResult =
  | { ok: true; view: NativePreferencesView }
  | { ok: false; error: string };

const RELOAD_BOUNDARY =
  "Pi 的 keybindings.json 只作用于 Pi 自己的终端界面：保存后需在 Pi 重启（或 Pi 会话内 /reload）后生效，不会改写 PiDock 自己的快捷键。";

function readBounded(path: string): { text: string } | { error: string } {
  try {
    const size = statSync(path).size;
    if (size > MAX_BYTES) return { error: "keybindings-too-large" };
    return { text: readFileSync(path, "utf8") };
  } catch {
    return { error: "keybindings-unreadable" };
  }
}

function recordOf(text: string): Record<string, unknown> | null {
  if (text.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function keysOf(value: unknown): string[] | null {
  if (typeof value === "string") {
    const one = normalizeKey(value);
    return one === null ? null : [one];
  }
  if (!Array.isArray(value)) return null;
  const keys: string[] = [];
  for (const entry of value) {
    const one = normalizeKey(entry);
    if (one === null) return null;
    keys.push(one);
  }
  return keys;
}

function keybindingViews(parsed: Record<string, unknown> | null): { keys: KeybindingView[]; error: string | null } {
  let error: string | null = null;
  const views = MANAGED_KEYBINDINGS.map((item): KeybindingView => {
    const configured = parsed?.[item.id];
    const keys = configured === undefined ? null : keysOf(configured);
    if (configured !== undefined && keys === null) error = `keybindings-invalid-value: ${item.id}`;
    return {
      id: item.id,
      label: item.label,
      defaultKeys: [...item.defaults],
      keys: keys ?? [...item.defaults],
      source: keys === null ? "default" : "custom",
    };
  });
  return { keys: views, error };
}

/** The support boundary the page must state; no invented translation controls. */
function unsupportedFields(settingsPath: string): UnsupportedField[] {
  return [
    {
      pane: "language",
      field: "language / locale",
      path: settingsPath,
      status: "unsupported",
      reason:
        "Pi 1.5.0 的 settings.json（schemas/settings.schema.json，61 个属性）没有语言／locale 字段：Pi 的界面文案随包固定为英文，没有可写的原生语言设置。PiDock 只切换自己已交付的中文字符串，不伪造翻译。",
    },
    {
      pane: "general",
      field: "selfUpdateCommand",
      path: settingsPath,
      status: "unwired",
      reason:
        "PiDock 使用随包固定的 SDK（不用全局 pi update 更新运行时），因此不提供 Pi 自更新命令与扩展更新通知的编辑入口。",
    },
  ];
}

export function readNativePreferences(agentDir: string): NativePreferencesResult {
  const keybindingsPath = join(agentDir, KEYBINDINGS_FILE);
  const settingsPath = join(agentDir, SETTINGS_FILE);
  let text = "";
  if (existsSync(keybindingsPath)) {
    const read = readBounded(keybindingsPath);
    if ("error" in read) return { ok: false, error: `${read.error}: ${keybindingsPath}` };
    text = read.text;
  }
  const parsed = text.length === 0 ? {} : recordOf(text);
  if (parsed === null) return { ok: false, error: `keybindings-invalid-json: ${keybindingsPath}` };

  let settingsState: NativePreferencesView["settingsState"] = "missing";
  if (existsSync(settingsPath)) {
    const read = readBounded(settingsPath);
    settingsState = "error" in read || recordOf(read.text) === null ? "invalid" : "present";
  }

  const { keys, error } = keybindingViews(parsed);
  const view: NativePreferencesView = {
    agentDir,
    keybindingsPath,
    settingsPath,
    keybindings: keys,
    keybindingsError: error,
    settingsState,
    unsupported: unsupportedFields(settingsPath),
    reloadBoundary: RELOAD_BOUNDARY,
  };
  return { ok: true, view };
}

/* ------------------------------------------------------------------ *
 * Byte-preserving splice into a JSON document's TOP-LEVEL object.
 * The write path must not rewrite what PiDock does not own: a full
 * parse + re-serialize would drop formatting and any field whose order
 * or shape Pi or another tool wrote (e.g. `$schema`, comments-as-strings,
 * unknown future ids). The scanner below only locates the one value span
 * (or the closing brace, for a new key) and replaces exactly that.
 * ------------------------------------------------------------------ */

type Span = { key: string; start: number; end: number };
type TopLevel = { spans: Span[]; close: number };

class ScanError extends Error {}

function scanTopLevel(raw: string): TopLevel {
  let i = 0;
  const skip = () => { while (i < raw.length && /\s/.test(raw[i] as string)) i += 1; };
  const readString = (): string => {
    if (raw[i] !== '"') throw new ScanError("expected-string");
    i += 1;
    let out = "";
    while (i < raw.length) {
      const ch = raw[i] as string;
      if (ch === "\\") { out += raw.slice(i, i + 2); i += 2; continue; }
      if (ch === '"') { i += 1; return out; }
      out += ch;
      i += 1;
    }
    throw new ScanError("unterminated-string");
  };
  const skipValue = (): void => {
    const ch = raw[i];
    if (ch === '"') { readString(); return; }
    if (ch === "{" || ch === "[") {
      let depth = 0;
      while (i < raw.length) {
        const current = raw[i] as string;
        if (current === '"') { readString(); continue; }
        if (current === "{" || current === "[") depth += 1;
        else if (current === "}" || current === "]") {
          depth -= 1;
          i += 1;
          if (depth === 0) return;
          continue;
        }
        i += 1;
      }
      throw new ScanError("unterminated-container");
    }
    const start = i;
    while (i < raw.length && !/[\s,}\]]/.test(raw[i] as string)) i += 1;
    if (i === start) throw new ScanError("empty-value");
  };

  skip();
  if (raw[i] !== "{") throw new ScanError("not-an-object");
  i += 1;
  const spans: Span[] = [];
  skip();
  if (raw[i] === "}") return { spans, close: i };
  for (;;) {
    skip();
    const key = readString();
    skip();
    if (raw[i] !== ":") throw new ScanError("expected-colon");
    i += 1;
    skip();
    const start = i;
    skipValue();
    spans.push({ key, start, end: i });
    skip();
    if (raw[i] === ",") { i += 1; continue; }
    if (raw[i] === "}") return { spans, close: i };
    throw new ScanError("expected-separator");
  }
}

/**
 * Replace ONE top-level property of a JSON document, leaving every other byte
 * untouched. Returns the new text; throws `keybindings-invalid-json` when the
 * existing document is not a single top-level object.
 */
export function spliceTopLevelValue(raw: string, key: string, value: unknown): string {
  const literal = JSON.stringify(value);
  const text = raw.trim().length === 0 ? "{}\n" : raw;
  let top: TopLevel;
  try {
    top = scanTopLevel(text);
  } catch {
    throw new Error("keybindings-invalid-json");
  }
  const existing = top.spans.find((span) => span.key === key);
  if (existing) return text.slice(0, existing.start) + literal + text.slice(existing.end);
  const head = text.slice(0, top.close);
  const tail = text.slice(top.close);
  const separator = top.spans.length === 0 ? "" : ",";
  if (!text.includes("\n")) return `${head}${separator}${JSON.stringify(key)}:${literal}${tail}`;
  // Multiline document: append after the last property line, keeping the
  // closing brace's own indent (and any trailing newline after it).
  const lastNewline = head.lastIndexOf("\n");
  const beforeLastLine = head.slice(0, lastNewline < 0 ? 0 : lastNewline + 1).replace(/\s+$/, "");
  const closingIndent = head.slice(lastNewline + 1);
  return `${beforeLastLine}${separator}\n${closingIndent}${JSON.stringify(key)}: ${literal}\n${closingIndent}${tail}`;
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export type SaveKeybindingResult = { ok: true; view: NativePreferencesView } | { ok: false; error: string };

/**
 * Save ONE managed Pi keybinding. The payload names the action and the keys;
 * the action must be in {@link MANAGED_KEYBINDINGS} and every key must parse
 * with Pi's documented syntax, so an unverifiable id or a typo is refused by
 * name and nothing is written. A refused save leaves the previous document
 * exactly as it was.
 */
export function saveNativeKeybinding(agentDir: string, payload: unknown): SaveKeybindingResult {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, error: "preferences-invalid-payload" };
  }
  const input = payload as Record<string, unknown>;
  const action = input["action"];
  if (typeof action !== "string" || !MANAGED_IDS.has(action)) {
    return { ok: false, error: `keybinding-unsupported-action: ${String(action)}` };
  }
  const rawKeys = input["keys"];
  if (!Array.isArray(rawKeys)) return { ok: false, error: "preferences-invalid-payload" };
  const keys: string[] = [];
  for (const entry of rawKeys) {
    const key = normalizeKey(entry);
    if (key === null) return { ok: false, error: `keybinding-invalid-syntax: ${String(entry)}` };
    keys.push(key);
  }
  if (new Set(keys).size !== keys.length) return { ok: false, error: `keybinding-duplicate-key: ${action}` };

  const path = join(agentDir, KEYBINDINGS_FILE);
  let raw = "";
  if (existsSync(path)) {
    const read = readBounded(path);
    if ("error" in read) return { ok: false, error: `${read.error}: ${path}` };
    raw = read.text;
    if (recordOf(raw) === null) return { ok: false, error: `keybindings-invalid-json: ${path}` };
  } else {
    try {
      mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    } catch {
      return { ok: false, error: `keybindings-unwritable: ${agentDir}` };
    }
  }
  const base = raw.trim().length === 0 ? `{\n  "$schema": ${JSON.stringify(KEYBINDINGS_SCHEMA_URL)}\n}\n` : raw;
  let next: string;
  try {
    next = spliceTopLevelValue(base, action, keys);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "keybindings-invalid-json" };
  }
  try {
    writeAtomic(path, next);
  } catch {
    return { ok: false, error: `keybindings-unwritable: ${path}` };
  }
  return readNativePreferences(agentDir);
}
