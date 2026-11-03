/**
 * [Pencil T14] #149 — PiDock's OWN appearance preference (日间 / 夜间 / 跟随系统).
 *
 * This is deliberately NOT a Pi setting: `docs/design/APPEARANCE.md` and the
 * parent spec state that 外观 is managed by PiDock (`settings.json` has no such
 * field and Pi's `theme` key names a *terminal* theme). The document therefore
 * lives in this application's `userData` directory next to the other
 * machine-private app documents, is written atomically, and holds one field.
 *
 * "跟随系统" is stored as the literal `system`; the resolved light/dark value is
 * NOT persisted, so a later OS change is honoured instead of being frozen.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const APPEARANCE_FILE = "appearance.json";

export const APPEARANCE_MODES = ["light", "dark", "system"] as const;
export type AppearanceMode = (typeof APPEARANCE_MODES)[number];

/** Default per docs/design/APPEARANCE.md: 默认跟随系统. */
export const DEFAULT_APPEARANCE: AppearanceMode = "system";

export function isAppearanceMode(value: unknown): value is AppearanceMode {
  return typeof value === "string" && (APPEARANCE_MODES as readonly string[]).includes(value);
}

export function appearancePath(userData: string): string {
  return join(userData, APPEARANCE_FILE);
}

export type AppearanceResult = { ok: true; value: AppearanceMode } | { ok: false; error: string };

/**
 * Read the saved preference. A missing document is the honest default
 * (`system`); a document that exists but does not name a supported mode is a
 * NAMED refusal, so the page never silently shows 跟随系统 while a different
 * value sits on disk.
 */
export function readAppearancePreference(userData: string): AppearanceResult {
  const path = appearancePath(userData);
  if (!existsSync(path)) return { ok: true, value: DEFAULT_APPEARANCE };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ok: false, error: `appearance-invalid-document: ${path}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `appearance-invalid-document: ${path}` };
  }
  const value = (parsed as Record<string, unknown>)["appearance"];
  if (value === undefined) return { ok: true, value: DEFAULT_APPEARANCE };
  if (!isAppearanceMode(value)) return { ok: false, error: `appearance-invalid-document: ${path}` };
  return { ok: true, value };
}

/** Save one validated mode atomically; a refused payload writes nothing. */
export function saveAppearancePreference(userData: string, payload: unknown): AppearanceResult {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, error: "preferences-invalid-payload" };
  }
  const value = (payload as Record<string, unknown>)["appearance"];
  if (!isAppearanceMode(value)) return { ok: false, error: "appearance-invalid-value" };
  const path = appearancePath(userData);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(userData, { recursive: true, mode: 0o700 });
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify({ appearance: value }, null, 2)}\n`, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch {
    return { ok: false, error: `appearance-unwritable: ${path}` };
  }
  return { ok: true, value };
}
