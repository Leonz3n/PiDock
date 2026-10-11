/**
 * [PiDock 10] (#15 box 28) the WRITE side of the user's external-editor setting.
 *
 * The launch (`main/external-editor.ts` + `host/open-editor.ts`) reads
 * `external-editor.json` from this application's machine-private profile
 * directory. Until this module existed nothing in the app could write that
 * document, so 盒子 28「用户可从任务打开外部编辑器」 was only reachable by
 * hand-editing an app-private file — every press returned
 * `editor-not-configured`. This is the one save path: the SAME document the
 * launch reads, written atomically, validated with the launch's own rules, and
 * reachable only through main's attested `shell/editorSettingsOp` entry (the
 * renderer names the program it wants; it never names a file, and this is not
 * a task op).
 *
 * Design notes:
 * - Validation is the LAUNCH's validation: an absolute path with no `.`/`..`
 *   segment and an existing executable regular file, so a `.app` bundle
 *   directory stays refused as `editor-program-not-executable`. A refused save
 *   writes nothing, so a previously valid setting is never replaced by
 *   something that could never launch.
 * - Clearing removes the document; the launch then returns the honest
 *   `editor-not-configured` refusal that names the settings path again. A
 *   malformed or unreadable document is reported BY NAME (not as
 *   「未配置」) and clearing it is the user's recovery path.
 * - The write is atomic (temp file in the same directory, fsync, rename) and
 *   the profile directory is created `0700` with a `0600` document, like the
 *   sibling Provider registry: this file is machine-private.
 * - The program comes from the user explicitly (the box forbids nothing here)
 *   and never from a page-supplied guess: the payload's `program` is the only
 *   path taken, and no default, environment variable or `PATH` lookup is
 *   consulted anywhere in this slice.
 */

import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXTERNAL_EDITOR_SETTINGS_FILE,
  externalEditorSettingsPath,
  loadExternalEditorSettings,
  probeEditorProgram,
  serializeEditorSettings,
  validateEditorProgramChoice,
  type ExternalEditorSettings,
} from "./external-editor.js";
import { TrustDomainViolation } from "./trust-domain.js";

/** What the settings surface shows about the program the next launch would use. */
export interface EditorSettingsStatus {
  /** The saved program, or `null` when nothing is saved (nothing will launch). */
  program: string | null;
  /** The user's own extra arguments, in order; empty when nothing is saved. */
  args: string[];
  /** Absolute path of the machine-private document the launch reads. */
  settingsPath: string;
}

export type EditorSettingsResult = { ok: true; status: EditorSettingsStatus } | { ok: false; error: string };

function statusOf(profileDir: string, settings: ExternalEditorSettings | null): EditorSettingsStatus {
  return {
    program: settings?.program ?? null,
    args: [...(settings?.args ?? [])],
    settingsPath: externalEditorSettingsPath(profileDir),
  };
}

/**
 * Read the saved setting for the settings surface. A missing document is the
 * honest 「未配置」 state; a malformed/unreadable one is a named refusal, so the
 * page can never show 「未配置」 while a broken document sits in the profile.
 */
export function readEditorSettingsStatus(profileDir: string): EditorSettingsResult {
  const loaded = loadExternalEditorSettings(profileDir);
  if (loaded.ok) return { ok: true, status: statusOf(profileDir, loaded.settings) };
  if (loaded.error.startsWith("editor-not-configured")) return { ok: true, status: statusOf(profileDir, null) };
  return { ok: false, error: loaded.error };
}

/**
 * Store one user-chosen program (+ optional args) in the document the launch
 * reads. The program is validated with the launch's own names and probed on
 * disk first; on any refusal nothing is written, so the previous setting
 * survives a bad save. The answer is a fresh READ of the document, so a save
 * that could not be read back is never reported as stored.
 */
export function saveExternalEditorSetting(profileDir: string, input: { program: unknown; args: unknown }): EditorSettingsResult {
  const validated = validateEditorProgramChoice(input);
  if (!validated.ok) return { ok: false, error: validated.error };
  const program = validated.settings.program;
  const probed = probeEditorProgram(program);
  if (probed === "missing") {
    return { ok: false, error: `editor-program-not-found: 外部编辑器程序不存在（${program}），未保存任何设置` };
  }
  if (probed !== "executable") {
    return { ok: false, error: `editor-program-not-executable: 外部编辑器程序不是可执行文件（${program}），未保存任何设置` };
  }
  writeEditorSettingsDocument(profileDir, validated.settings);
  return readEditorSettingsStatus(profileDir);
}

/**
 * Remove the document, returning the feature to the honest
 * `editor-not-configured` refusal the launch reports. Never reads the old
 * document, so this is also how a user recovers from a broken one.
 */
export function clearExternalEditorSetting(profileDir: string): EditorSettingsResult {
  rmSync(externalEditorSettingsPath(profileDir), { force: true });
  return readEditorSettingsStatus(profileDir);
}

/** Atomic, machine-private write of the one document the launch reads. */
function writeEditorSettingsDocument(profileDir: string, settings: ExternalEditorSettings): void {
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const temporary = join(profileDir, `.${EXTERNAL_EDITOR_SETTINGS_FILE}.${randomUUID()}.tmp`);
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, serializeEditorSettings(settings));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, externalEditorSettingsPath(profileDir));
  } finally {
    rmSync(temporary, { force: true });
  }
}

const OPERATIONS = ["read", "save", "clear"] as const;

/** Strict payload shape: exactly the named operation's own keys, nothing else. */
function shape(request: Record<string, unknown>, op: string, required: string[], optional: string[] = []): Record<string, unknown> {
  const allowed = ["op", ...required, ...optional];
  if (required.some((key) => !Object.hasOwn(request, key)) || Object.keys(request).some((key) => !allowed.includes(key))) {
    throw new TrustDomainViolation("invalid-payload", `invalid editor settings ${op} payload`);
  }
  return request;
}

/**
 * Main's attested `shell/editorSettingsOp` entry, shaped like the sibling
 * settings op (`shell/providerOp`): the caller is already the attested shell
 * sender (the handler's `requireShellSender`), the operation set is fixed, and
 * every extra key is refused instead of ignored. The document path is main's
 * own (`app.getPath("userData")`) and is never taken from the payload, so page
 * code can name a program but never a file to write.
 */
export function performEditorSettingsOperation(request: unknown, profileDir: string): EditorSettingsResult {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    throw new TrustDomainViolation("invalid-payload", "invalid editor settings operation");
  }
  const record = request as Record<string, unknown>;
  const op = record["op"];
  if (typeof op !== "string" || !(OPERATIONS as readonly string[]).includes(op)) {
    throw new TrustDomainViolation("invalid-payload", typeof op === "string" ? `unknown editor settings operation: ${op}` : "invalid editor settings operation");
  }
  if (op === "read") {
    shape(record, "read", []);
    return readEditorSettingsStatus(profileDir);
  }
  if (op === "save") {
    const args = shape(record, "save", ["program"], ["args"]);
    return saveExternalEditorSetting(profileDir, { program: args["program"], args: args["args"] });
  }
  shape(record, "clear", []);
  return clearExternalEditorSetting(profileDir);
}
