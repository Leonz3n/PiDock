/**
 * Seam: [PiDock 10] (#15 box 28) the SAVE path for the external-editor setting.
 *
 * The launch reads `external-editor.json` from this application's
 * machine-private profile directory. Before this slice nothing in the app could
 * write it, so 盒子 28 was only reachable by hand-editing that file. These tests
 * pin the write itself with real files: validation by name, no overwrite of a
 * valid setting by a refused one, atomic persistence that a FRESH read sees,
 * machine-private permissions, and a clear that returns the feature to the
 * honest `editor-not-configured` state.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXTERNAL_EDITOR_SETTINGS_FILE,
  externalEditorSettingsPath,
  loadExternalEditorSettings,
  MAX_EDITOR_SETTINGS_BYTES,
} from "./external-editor.js";
import { TrustDomainViolation } from "./trust-domain.js";
import {
  clearExternalEditorSetting,
  performEditorSettingsOperation,
  readEditorSettingsStatus,
  saveExternalEditorSetting,
} from "./external-editor-settings.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), "pidock-editor-settings-"));
  roots.push(dir);
  return dir;
}

/** A real executable program for the probe (this Node binary). */
const NODE = process.execPath;

function documentOf(dir: string): string {
  return readFileSync(externalEditorSettingsPath(dir), "utf8");
}

function refused(result: { ok: boolean; error?: string }, name: string): void {
  expect(result.ok, JSON.stringify(result)).toBe(false);
  expect(result.error).toContain(name);
}

describe("#15 box 28 the external-editor setting save path", () => {
  it("reports the honest 未配置 state and names main's own document when nothing is saved", () => {
    const dir = profile();
    const status = readEditorSettingsStatus(dir);
    expect(status).toEqual({ ok: true, status: { program: null, args: [], settingsPath: externalEditorSettingsPath(dir) } });
    expect(existsSync(externalEditorSettingsPath(dir))).toBe(false);
  });

  it("saves a program and its own args to the document the launch reads, atomically and read-back verified", () => {
    const dir = profile();
    const saved = saveExternalEditorSetting(dir, { program: NODE, args: ["--new-window", "--"] });

    expect(saved.ok, JSON.stringify(saved)).toBe(true);
    if (!saved.ok) return;
    // The answer is a fresh read of what was written.
    expect(saved.status.program).toBe(NODE);
    expect(saved.status.args).toEqual(["--new-window", "--"]);
    expect(saved.status.settingsPath).toBe(externalEditorSettingsPath(dir));

    // The launch's own loader reads the same document back.
    const loaded = loadExternalEditorSettings(dir);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.settings).toEqual({ program: NODE, args: ["--new-window", "--"] });

    // Exactly the documented shape, and the write left no temporary file.
    expect(JSON.parse(documentOf(dir))).toEqual({ program: NODE, args: ["--new-window", "--"] });
    expect(readdirSync(dir)).toEqual([EXTERNAL_EDITOR_SETTINGS_FILE]);
  });

  // win32 (#57): POSIX mode bits are the only place "machine-private" is observable at all, and on
  // win32 `statSync().mode & 0o077` reads a synthesized 0o066 whatever `mkdirSync({mode: 0o700})` /
  // `openSync(temporary, "wx", 0o600)` asked for (measured on this host). The save path sets no ACL
  // there, so group/other access is unenforced on win32 - unobserved, not asserted against a number
  // that carries no information.
  it.skipIf(process.platform === "win32")("writes the document with no group or other access (POSIX mode bits)", () => {
    const dir = profile();
    expect(saveExternalEditorSetting(dir, { program: NODE, args: undefined }).ok).toBe(true);
    expect(statSync(externalEditorSettingsPath(dir)).mode & 0o077).toBe(0);
  });

  it("omits args entirely when the user gave none, so the document stays exactly the launch's shape", () => {
    const dir = profile();
    const saved = saveExternalEditorSetting(dir, { program: NODE, args: undefined });
    expect(saved.ok).toBe(true);
    expect(JSON.parse(documentOf(dir))).toEqual({ program: NODE });
    expect(saved.ok && saved.status.args).toEqual([]);
  });

  it("refuses every invalid program BY NAME and never overwrites a valid saved setting", () => {
    const dir = profile();
    const valid = saveExternalEditorSetting(dir, { program: NODE, args: ["--keep"] });
    expect(valid.ok).toBe(true);
    const before = documentOf(dir);

    const notExecutable = join(dir, "not-executable.txt");
    writeFileSync(notExecutable, "no\n");
    chmodSync(notExecutable, 0o644);
    // A `.app`-style bundle directory is a directory, refused like the launch refuses it.
    const bundle = join(dir, "Fake Editor.app");
    mkdirSync(bundle, { recursive: true });

    const cases: { program: unknown; args: unknown; name: string }[] = [
      { program: "relative-editor", args: undefined, name: "editor-program-invalid" },
      { program: "/usr/../etc/passwd", args: undefined, name: "editor-program-invalid" },
      { program: `${dir}/./editor`, args: undefined, name: "editor-program-invalid" },
      { program: join(dir, "missing-editor"), args: undefined, name: "editor-program-not-found" },
      // win32 (#57): the save path's own probe is existence-only there (`accessSync(program, F_OK)`,
      // main/external-editor.ts:197), so this 0o644 regular file IS executable and the named refusal
      // cannot be produced for it (observed: win32 saves it instead). The directory entry below
      // reaches the same `editor-program-not-executable` branch on every platform, so the refusal
      // stays covered; the X_OK dimension is unobserved on win32.
      ...(process.platform === "win32" ? [] : [{ program: notExecutable, args: undefined, name: "editor-program-not-executable" }]),
      { program: bundle, args: undefined, name: "editor-program-not-executable" },
      { program: "", args: undefined, name: "editor-settings-invalid" },
      { program: 7, args: undefined, name: "editor-settings-invalid" },
      { program: NODE, args: [1], name: "editor-settings-invalid" },
      { program: NODE, args: Array.from({ length: 17 }, () => "--x"), name: "editor-settings-invalid" },
      { program: `${NODE}\0`, args: undefined, name: "editor-settings-invalid" },
      // A document larger than the read cap the launch enforces would store a
      // setting that can never be read back: refused instead of written.
      { program: NODE, args: Array.from({ length: 4 }, () => "a".repeat(4096)), name: "editor-settings-too-large" },
    ];
    for (const entry of cases) {
      const result = saveExternalEditorSetting(dir, { program: entry.program, args: entry.args });
      refused(result, entry.name);
      // Fail-closed: the previously valid setting is untouched.
      expect(documentOf(dir), JSON.stringify(entry)).toBe(before);
    }
    // The saved setting is still the valid one, and still launches from it.
    const loaded = loadExternalEditorSettings(dir);
    expect(loaded.ok && loaded.settings).toEqual({ program: NODE, args: ["--keep"] });
    expect(statSync(externalEditorSettingsPath(dir)).size).toBeLessThanOrEqual(MAX_EDITOR_SETTINGS_BYTES);
  });

  it("clears the document, returning the launch's honest editor-not-configured refusal that names the path", () => {
    const dir = profile();
    expect(saveExternalEditorSetting(dir, { program: NODE, args: undefined }).ok).toBe(true);

    const cleared = clearExternalEditorSetting(dir);
    expect(cleared).toEqual({ ok: true, status: { program: null, args: [], settingsPath: externalEditorSettingsPath(dir) } });
    expect(existsSync(externalEditorSettingsPath(dir))).toBe(false);

    const loaded = loadExternalEditorSettings(dir);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error).toContain("editor-not-configured");
      expect(loaded.error).toContain(externalEditorSettingsPath(dir));
    }
    // Clearing twice is not an error: the honest state is idempotent.
    expect(clearExternalEditorSetting(dir).ok).toBe(true);
  });

  it("reports a malformed document BY NAME instead of 未配置, and clearing it is the recovery path", () => {
    const dir = profile();
    writeFileSync(externalEditorSettingsPath(dir), "{ not json");
    const status = readEditorSettingsStatus(dir);
    refused(status, "editor-settings-invalid");

    // A hand-edited document with an unknown key is refused the same way.
    writeFileSync(externalEditorSettingsPath(dir), JSON.stringify({ program: NODE, extra: true }));
    refused(readEditorSettingsStatus(dir), "editor-settings-invalid");

    const cleared = clearExternalEditorSetting(dir);
    expect(cleared.ok).toBe(true);
    expect(cleared.ok && cleared.status.program).toBeNull();
  });

  it("refuses a document that is a directory BY NAME instead of a raw fs error", () => {
    const dir = profile();
    // A hand-made directory at the document path: `read` already refuses that
    // state as `editor-settings-invalid`, so clearing must fail closed with the
    // same name instead of letting rmSync throw ERR_FS_EISDIR.
    mkdirSync(externalEditorSettingsPath(dir), { recursive: true });

    expect(() => clearExternalEditorSetting(dir)).not.toThrow();
    refused(clearExternalEditorSetting(dir), "editor-settings-invalid");
    // Nothing was removed or half-removed: the path is exactly as it was.
    expect(statSync(externalEditorSettingsPath(dir)).isDirectory()).toBe(true);

    // The attested op answers the same way instead of crashing main.
    expect(() => performEditorSettingsOperation({ op: "clear" }, dir)).not.toThrow();
    refused(performEditorSettingsOperation({ op: "clear" }, dir), "editor-settings-invalid");
  });

  it("refuses an unknown operation and any extra key instead of ignoring it", () => {
    const dir = profile();
    const cases: unknown[] = [
      undefined,
      null,
      "save",
      { op: "write", program: NODE },
      { op: "read", program: NODE },
      { op: "read", path: join(dir, "elsewhere.json") },
      { op: "clear", taskId: "t1" },
      { op: "save", program: NODE, args: [], settingsPath: "/tmp/elsewhere.json" },
      { op: "save", args: [] },
    ];
    for (const request of cases) {
      // The refusal carries the trust code main's envelope prefixes
      // (`invalid-payload: ...`); a shape the page can talk into being ignored
      // would be the whole hole this op must not have.
      let thrown: unknown;
      try {
        performEditorSettingsOperation(request, dir);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, JSON.stringify(request)).toBeInstanceOf(TrustDomainViolation);
      expect((thrown as TrustDomainViolation).code, JSON.stringify(request)).toBe("invalid-payload");
      expect(existsSync(externalEditorSettingsPath(dir))).toBe(false);
    }
  });

  it("writes only main's own document even when the request tries to name another file", () => {
    const dir = profile();
    const elsewhere = join(dir, "nested", "elsewhere.json");
    const result = performEditorSettingsOperation({ op: "save", program: NODE }, dir);
    expect(result.ok).toBe(true);
    expect(existsSync(externalEditorSettingsPath(dir))).toBe(true);
    expect(existsSync(elsewhere)).toBe(false);
  });
});
