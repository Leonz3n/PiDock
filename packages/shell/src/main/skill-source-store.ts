/**
 * The PiDock-managed local Skills source list, persisted in the app-private
 * config directory — [Pencil T16] #151.
 *
 * Pi keeps *its* resource list in `<agent-dir>/settings.json`, but PiDock's
 * source rows also need stable ids, an order and an `enabled` flag that Pi's
 * plain `skills: string[]` cannot carry. Existing native user sources are read
 * on demand through a nativeAgentDir reference and a PiDock-only enable overlay;
 * native settings and source files are never rewritten. The list must never be written
 * into a user's project. So the list is PiDock's own document under Electron's
 * `userData` (`skill-sources.json`), and the *effective* list is handed to a
 * new SDK session as explicit skill paths (see `sdk-text-kernel.ts`). Pi still
 * does the loading; PiDock owns only "which directories, in what order, on or
 * off".
 *
 * Write rules:
 *
 * - a write is atomic: temp file in the same directory (mode 0600), fsync,
 *   rename. A crash cannot leave a half-written config PiDock would then read.
 * - a corrupt/oversized/unknown-version file is reported by name (`invalid`)
 *   and is NOT overwritten or reset to a sample; every mutation refuses with
 *   `skill-config-invalid` until the user fixes or removes it.
 * - temp files never live inside a project, a task or a skill source.
 * - adding the same real directory twice (including a Windows drive-letter or
 *   case variant) is refused by name instead of producing a fake second source.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  parseSkillConfig,
  readSkillConfig,
  scanSkillSources,
  SKILL_CONFIG_FILE,
  SKILL_CONFIG_VERSION,
  sourcePathKey,
  type SkillConfig,
  type SkillConfigRead,
  type SkillConfigSource,
  type SkillSourceScan,
} from "../host/skill-sources.js";

export type SkillConfigState = "ok" | "empty" | "invalid";

export type SkillSourcesView = {
  /** `empty` = no document yet (a real empty list, not a sample). */
  state: SkillConfigState;
  file: string;
  config: SkillConfig;
  sources: SkillSourceScan[];
  /** Why the document is unusable; absent unless `state === "invalid"`. */
  message?: string;
};

function emptyConfig(): SkillConfig {
  return { version: SKILL_CONFIG_VERSION, sources: [] };
}

export class SkillSourceStore {
  readonly file: string;

  constructor(userData: string, file?: string, nativeAgentDir?: string) {
    this.file = file ?? join(userData, SKILL_CONFIG_FILE);
    if (nativeAgentDir) {
      const existing = readSkillConfig(this.file, false);
      if (existing.state !== "invalid" && (existing.state === "missing" || existing.config.nativeAgentDir !== nativeAgentDir)) {
        const result = this.write({ ...(existing.state === "ok" ? existing.config : emptyConfig()), nativeAgentDir });
        if (!result.ok) throw new Error(result.error);
      }
    }
  }

  private read(): SkillConfigRead {
    return readSkillConfig(this.file);
  }

  /** The document plus the real-disk scan of every configured source. */
  view(): SkillSourcesView {
    const read = this.read();
    if (read.state === "invalid") {
      return { state: "invalid", file: this.file, config: emptyConfig(), sources: [], message: read.message };
    }
    if (read.state === "missing") return { state: "empty", file: this.file, config: emptyConfig(), sources: [] };
    return { state: "ok", file: this.file, config: read.config, sources: scanSkillSources(read.config) };
  }

  /** Enabled source directories a NEW session may load, in list order. */
  sessionPaths(): string[] {
    const read = this.read();
    if (read.state !== "ok") return [];
    return read.config.sources.filter((source) => source.enabled).map((source) => source.path);
  }

  /** Add one absolute directory. Returns the new source (or a named refusal). */
  add(path: string): { ok: true; source: SkillConfigSource; config: SkillConfig } | { ok: false; error: string } {
    const config = this.mutable();
    if (!config.ok) return { ok: false, error: config.error };
    const key = sourcePathKey(path);
    if (this.view().sources.some((source) => sourcePathKey(source.path) === key)) {
      return { ok: false, error: "该目录已在来源列表中" };
    }
    if (config.config.sources.length >= 32) return { ok: false, error: "来源数量已达上限" };
    const source: SkillConfigSource = { id: `src-${randomUUID().replace(/-/g, "").slice(0, 8)}`, path, enabled: true };
    const next: SkillConfig = { ...config.config, sources: [...config.config.sources, source] };
    const written = this.write(next);
    if (!written.ok) return written;
    return { ok: true, source, config: next };
  }

  remove(id: string): { ok: true; config: SkillConfig } | { ok: false; error: string } {
    const config = this.mutable();
    if (!config.ok) return config;
    if (this.view().config.sources.some((source) => source.id === id && source.ownership === "native")) return { ok: false, error: "原生来源保留原始所有权；可停用，不能从此删除" };
    if (!config.config.sources.some((source) => source.id === id)) return { ok: false, error: "来源不存在，可能已被移除" };
    const next: SkillConfig = { ...config.config, sources: config.config.sources.filter((source) => source.id !== id) };
    const written = this.write(next);
    if (!written.ok) return written;
    return { ok: true, config: next };
  }

  setEnabled(id: string, enabled: boolean): { ok: true; config: SkillConfig } | { ok: false; error: string } {
    const config = this.mutable();
    if (!config.ok) return config;
    const native = this.view().config.sources.find((source) => source.id === id && source.ownership === "native");
    if (native) {
      const disabled = new Set(config.config.nativeDisabled ?? []);
      if (enabled) disabled.delete(id); else disabled.add(id);
      const next = { ...config.config, nativeDisabled: [...disabled] };
      const written = this.write(next);
      return written.ok ? { ok: true, config: next } : written;
    }
    if (!config.config.sources.some((source) => source.id === id)) return { ok: false, error: "来源不存在，可能已被移除" };
    const next: SkillConfig = {
      ...config.config,
      sources: config.config.sources.map((source) => (source.id === id ? { ...source, enabled } : source)),
    };
    const written = this.write(next);
    if (!written.ok) return written;
    return { ok: true, config: next };
  }

  /** A corrupt document is a refusal, never a silent reset. */
  private mutable(): { ok: true; config: SkillConfig } | { ok: false; error: string } {
    const read = readSkillConfig(this.file, false);
    if (read.state === "invalid") return { ok: false, error: `skill-config-invalid: ${read.message}` };
    return { ok: true, config: read.state === "missing" ? emptyConfig() : read.config };
  }

  private write(config: SkillConfig): { ok: true } | { ok: false; error: string } {
    const parsed = parseSkillConfig(config);
    if (!parsed.ok) return { ok: false, error: `skill-config-invalid: ${parsed.message}` };
    const dir = this.file.slice(0, this.file.length - SKILL_CONFIG_FILE.length - 1) || ".";
    const temp = `${this.file}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      fd = openSync(temp, "w", 0o600);
      writeSync(fd, `${JSON.stringify(config, null, 2)}\n`);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, this.file);
      return { ok: true };
    } catch {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
      try { rmSync(temp, { force: true }); } catch { /* nothing to remove */ }
      return { ok: false, error: "skill-config-write-failed" };
    }
  }
}

/** Read the persisted config for callers that only need the document (tests, kernel). */
export function readPersistedSkillConfig(file: string): SkillConfigRead {
  return readSkillConfig(file);
}

/** The last write's bytes, for a restart-persistence assertion. */
export function readPersistedSkillBytes(file: string): string | null {
  try { return readFileSync(file, "utf8"); } catch { return null; }
}
