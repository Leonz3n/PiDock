/**
 * Local Skills sources: the PiDock-managed source list and the real disk scan
 * behind the 能力管理 → Skills pane — [Pencil T16] #151.
 *
 * Pi 1.5's own boundary (`docs/skills.md`, `docs/configuration.md`,
 * `docs/settings.md#resources`): a skill is a directory containing `SKILL.md`;
 * Pi discovers configured locations recursively, advertises name + description
 * + path in the system prompt, and loads the full instructions only when the
 * model (or `/skill:name`) reads `SKILL.md`. Invalid frontmatter, a missing
 * description or an unreadable file produces a *warning* and the skill is not
 * loaded; a name collision keeps the first discovered skill and warns. Pi reads
 * the `skills` resource list from settings and `/reload` is the documented
 * boundary for a running session.
 *
 * PiDock therefore does NOT invent a loader. The scan below calls the SDK's own
 * `loadSkillsFromDir`, so the rows the pane shows are the skills Pi would see,
 * and the persistence is PiDock's app-private config (never a project file):
 *
 * - the source list is an explicit, ordered list of real directories, each with
 *   a stable id, a path and an `enabled` flag; nothing is discovered implicitly
 *   and no example row is fabricated when the list is empty
 * - a source that disappeared is reported by name (`missing`), an unreadable
 *   one is `unreadable`; a source that is switched off is `disabled` and is not
 *   silently skipped as if it did not exist
 * - a `SKILL.md` that the SDK refused is listed as `invalid` with the SDK's own
 *   diagnostic message, never dropped from the list and never replaced by a
 *   same-named sibling
 * - two sources declaring the same name stay two rows; the second is never
 *   "substituted" for the first, and the session prompt carries both with their
 *   distinct locations
 * - a path key folds Windows drive-letter/case variants of the SAME directory
 *   (`C:\skills` = `c:\skills`), so one real source is loaded once and is not
 *   reported as a fake name collision
 * - unreadable/broken content is isolated per source and per skill: one bad
 *   directory never removes the other sources from the scan
 *
 * Reading this module never writes. Persistence lives in
 * `main/skill-source-store.ts`; the isolated model context reads the same file
 * when it opens a session (see `sdk-text-kernel.ts`), which is the documented
 * boundary — a running session is never mutated behind the user's back.
 */

import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";

/** The app-private config file name, resolved under Electron's `userData`. */
export const SKILL_CONFIG_FILE = "skill-sources.json";
export const SKILL_CONFIG_VERSION = 1;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_RESOURCES = 200;
const MAX_SCAN_DEPTH = 6;
const MAX_SKILL_FILE_BYTES = 512 * 1024;

export type SkillConfigSource = {
  id: string;
  /** Absolute directory the user added. */
  path: string;
  enabled: boolean;
};

export type SkillConfig = {
  version: typeof SKILL_CONFIG_VERSION;
  sources: SkillConfigSource[];
};

export type SkillConfigRead =
  | { state: "missing" }
  /** The file exists but is not a usable config; it is reported, never reset. */
  | { state: "invalid"; message: string }
  | { state: "ok"; config: SkillConfig };

const SOURCE_ID = /^src-[0-9a-f]{8}$/;

/** Windows drive-letter/case variants of one directory are the same source. */
export function sourcePathKey(path: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = resolve(path).replace(/[\\/]+$/, "");
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function absolutePath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0")) return null;
  if (!isAbsolute(value) || value.startsWith("~")) return null;
  return resolve(value);
}

/** Validate a parsed config document. Unknown fields are refused, never guessed. */
export function parseSkillConfig(value: unknown): { ok: true; config: SkillConfig } | { ok: false; message: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, message: "配置不是对象" };
  const record = value as Record<string, unknown>;
  if (record["version"] !== SKILL_CONFIG_VERSION) return { ok: false, message: "配置版本不支持" };
  const raw = record["sources"];
  if (!Array.isArray(raw)) return { ok: false, message: "sources 不是数组" };
  const sources: SkillConfigSource[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return { ok: false, message: "来源条目不是对象" };
    const entry = item as Record<string, unknown>;
    const id = entry["id"];
    const path = absolutePath(entry["path"]);
    const enabled = entry["enabled"];
    if (typeof id !== "string" || !SOURCE_ID.test(id)) return { ok: false, message: "来源 id 无效" };
    if (path === null) return { ok: false, message: "来源路径必须是绝对路径" };
    if (typeof enabled !== "boolean") return { ok: false, message: "来源 enabled 必须是布尔值" };
    if (ids.has(id)) return { ok: false, message: "来源 id 重复" };
    const key = sourcePathKey(path, "win32");
    if (paths.has(key)) return { ok: false, message: "同一来源目录被重复添加" };
    ids.add(id);
    paths.add(key);
    sources.push({ id, path, enabled });
  }
  return { ok: true, config: { version: SKILL_CONFIG_VERSION, sources } };
}

/** Bytes on disk, decoded with their own reason instead of a sample config. */
export function readSkillConfig(file: string): SkillConfigRead {
  let size: number;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return { state: "invalid", message: "配置路径不是文件" };
    size = stat.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    return { state: "invalid", message: "配置无法读取" };
  }
  if (size > MAX_CONFIG_BYTES) return { state: "invalid", message: "配置过大" };
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch { return { state: "invalid", message: "配置无法读取" }; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { state: "invalid", message: "配置不是合法 JSON" }; }
  const result = parseSkillConfig(parsed);
  if (!result.ok) return { state: "invalid", message: result.message };
  return { state: "ok", config: result.config };
}

/** Enabled source directories, in list order, one entry per real directory. */
export function enabledSkillPaths(config: SkillConfig, platform: NodeJS.Platform = process.platform): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const source of config.sources) {
    if (!source.enabled) continue;
    const key = sourcePathKey(source.path, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(source.path);
  }
  return paths;
}

export type SkillSourceStatus = "ok" | "disabled" | "missing" | "unreadable";
export type SkillStatus = "ok" | "invalid";

export type SkillResource = {
  /** POSIX relative path inside the skill directory (never `SKILL.md`). */
  path: string;
  bytes: number;
};

export type SkillEntry = {
  /** Stable per source: the same name in two sources is two keys. */
  key: string;
  name: string;
  description: string;
  sourceId: string;
  sourcePath: string;
  /** Absolute `SKILL.md` (or standalone `.md`) the SDK loaded. */
  skillFile: string;
  /** Absolute skill directory the model resolves relative paths against. */
  skillDir: string;
  resources: SkillResource[];
  status: SkillStatus;
  /** Why the skill is not usable; the SDK's own diagnostic when it gave one. */
  reason?: string;
  /** Keys of same-named skills in other sources (never substituted). */
  duplicates: string[];
};

export type SkillSourceScan = {
  id: string;
  path: string;
  enabled: boolean;
  status: SkillSourceStatus;
  /** Named reason for `missing` / `unreadable`; absent for a healthy source. */
  message?: string;
  skills: SkillEntry[];
  diagnostics: Array<{ message: string; path?: string }>;
};

/** True when the directory can be listed at all; a permission error is `unreadable`, not empty. */
function listable(dir: string): { ok: true } | { ok: false; code: "missing" | "unreadable" } {
  if (!existsSync(dir)) return { ok: false, code: "missing" };
  try {
    if (!statSync(dir).isDirectory()) return { ok: false, code: "missing" };
    readdirSync(dir, { withFileTypes: true });
    return { ok: true };
  } catch {
    return { ok: false, code: "unreadable" };
  }
}

/** Every `SKILL.md` under one source, so an SDK-refused file is still listed. */
function collectSkillFiles(dir: string, depth: number, out: string[], problems: Array<{ message: string; path?: string }>): void {
  if (depth > MAX_SCAN_DEPTH) return;
  let entries: Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }) as Dirent[]; }
  catch { problems.push({ message: "目录不可访问", path: dir }); return; }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const stat = statSync(full);
        isDirectory = stat.isDirectory();
        isFile = stat.isFile();
      } catch { continue; }
    }
    if (isDirectory) collectSkillFiles(full, depth + 1, out, problems);
    else if (isFile && entry.name === "SKILL.md") out.push(full);
  }
}

function listResources(skillDir: string): SkillResource[] {
  const resources: SkillResource[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH || resources.length >= MAX_RESOURCES) return;
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }) as Dirent[]; } catch { return; }
    for (const entry of entries) {
      if (resources.length >= MAX_RESOURCES) return;
      if (entry.name === "SKILL.md" && depth === 0) continue;
      const full = join(dir, entry.name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stat = statSync(full);
          isDirectory = stat.isDirectory();
          isFile = stat.isFile();
        } catch { continue; }
      }
      if (isDirectory) { walk(full, depth + 1); continue; }
      if (!isFile) continue;
      let bytes = 0;
      try { bytes = statSync(full).size; } catch { bytes = 0; }
      resources.push({ path: relative(skillDir, full).split(sep).join("/"), bytes });
    }
  };
  walk(skillDir, 0);
  return resources;
}

function scanSource(source: SkillConfigSource): SkillSourceScan {
  const base: SkillSourceScan = { id: source.id, path: source.path, enabled: source.enabled, status: "ok", skills: [], diagnostics: [] };
  if (!source.enabled) return { ...base, status: "disabled" };
  const listed = listable(source.path);
  if (!listed.ok) {
    return { ...base, status: listed.code, message: listed.code === "missing" ? "来源目录不存在或不是目录" : "来源目录不可访问" };
  }
  let loaded: { skills: Skill[]; diagnostics: Array<{ message: string; path?: string }> } = { skills: [], diagnostics: [] };
  try {
    const result = loadSkillsFromDir({ dir: source.path, source: "path" });
    loaded = { skills: result.skills, diagnostics: result.diagnostics.map((item) => ({ message: item.message, ...(item.path ? { path: item.path } : {}) })) };
  } catch {
    // The SDK loader reports discovery failures as diagnostics; a throw here is
    // an unexpected filesystem error for this source only.
    return { ...base, status: "unreadable", message: "来源扫描失败" };
  }
  const byFile = new Map(loaded.skills.map((skill) => [skill.filePath, skill]));
  const found: string[] = [];
  collectSkillFiles(source.path, 0, found, loaded.diagnostics);
  const skills: SkillEntry[] = [];
  for (const skill of loaded.skills) {
    const skillDir = skill.baseDir;
    skills.push({
      key: `${source.id}::${skill.name}`,
      name: skill.name,
      description: skill.description,
      sourceId: source.id,
      sourcePath: source.path,
      skillFile: skill.filePath,
      skillDir,
      resources: listResources(skillDir),
      status: "ok",
      duplicates: [],
    });
  }
  // A `SKILL.md` the SDK refused keeps an explicit row instead of vanishing.
  for (const file of found) {
    if (byFile.has(file)) continue;
    const diagnostic = loaded.diagnostics.find((item) => item.path === file);
    const dir = dirname(file);
    let raw = "";
    let readable = true;
    try {
      const size = statSync(file).size;
      raw = readFileSync(file, "utf8").slice(0, MAX_SKILL_FILE_BYTES);
      if (size === 0) readable = false;
    } catch { readable = false; }
    const declared = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? "";
    const declaredName = /^name:\s*(.+)$/m.exec(declared)?.[1]?.trim().replace(/^["']|["']$/g, "");
    const name = declaredName && declaredName.length > 0 ? declaredName : basename(dir);
    skills.push({
      key: `${source.id}::${name}`,
      name,
      description: /^description:\s*(.+)$/m.exec(declared)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "",
      sourceId: source.id,
      sourcePath: source.path,
      skillFile: file,
      skillDir: dir,
      resources: [],
      status: "invalid",
      reason: !readable ? "SKILL.md 不可读取" : diagnostic?.message ?? "SKILL.md 缺少有效 description，Pi 不会加载该技能",
      duplicates: [],
    });
  }
  return { ...base, status: "ok", skills, diagnostics: loaded.diagnostics };
}

/**
 * Scan every configured source against the real disk. Duplicate names across
 * sources are marked in place (`duplicates`) so the UI names both sources.
 */
export function scanSkillSources(config: SkillConfig): SkillSourceScan[] {
  const sources = config.sources.map(scanSource);
  const byName = new Map<string, SkillEntry[]>();
  for (const source of sources) {
    for (const skill of source.skills) {
      if (skill.status !== "ok") continue;
      byName.set(skill.name, [...(byName.get(skill.name) ?? []), skill]);
    }
  }
  for (const entries of byName.values()) {
    if (entries.length < 2) continue;
    for (const entry of entries) entry.duplicates = entries.filter((other) => other !== entry).map((other) => other.key);
  }
  return sources;
}

export type SessionSkills = {
  /** The SDK skill objects a new session advertises (enabled, loaded skills only). */
  skills: Skill[];
  /** Enabled source directories actually loaded, in list order. */
  paths: string[];
  /** Named scan problems a session must not hide (missing/unreadable sources). */
  diagnostics: string[];
};

/**
 * What a NEW session gets from the current config. Called at session creation
 * (never against a running session): enabled sources are loaded through the
 * real SDK loader, duplicate names keep both entries (each with its own
 * location), and a bad source contributes nothing while the others stay.
 */
export function sessionSkills(config: SkillConfig, platform: NodeJS.Platform = process.platform): SessionSkills {
  const paths = enabledSkillPaths(config, platform);
  const skills: Skill[] = [];
  const diagnostics: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const listed = listable(path);
    if (!listed.ok) {
      diagnostics.push(`${path}: ${listed.code === "missing" ? "来源目录不存在" : "来源目录不可访问"}`);
      continue;
    }
    let result: { skills: Skill[]; diagnostics: Array<{ message: string; path?: string }> };
    try { result = loadSkillsFromDir({ dir: path, source: "path" }); }
    catch { diagnostics.push(`${path}: 来源扫描失败`); continue; }
    for (const item of result.diagnostics) diagnostics.push(`${item.path ?? path}: ${item.message}`);
    for (const skill of result.skills) {
      const key = resolve(skill.filePath);
      if (seen.has(key)) continue;
      seen.add(key);
      skills.push(skill);
    }
  }
  return { skills, paths, diagnostics };
}
