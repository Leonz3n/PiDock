/**
 * [Pencil T14] #149 — Pi's native keybindings as a bounded, byte-preserving
 * projection.
 *
 * The assertions below are about the FILE, not about a returned object: every
 * write is read back from disk, and the cases where the document must not be
 * touched assert the exact bytes that were there before.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  KEYBINDINGS_SCHEMA_URL,
  MANAGED_KEYBINDINGS,
  normalizeKey,
  readNativePreferences,
  saveNativeKeybinding,
  spliceTopLevelValue,
} from "./native-preferences.js";

const dirs: string[] = [];
function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pidock-native-prefs-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("#149 native keybindings read", () => {
  it("shows Pi's documented defaults and the REAL paths when nothing is saved", () => {
    const dir = agentDir();
    const result = readNativePreferences(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.keybindingsPath).toBe(join(dir, "keybindings.json"));
    expect(result.view.settingsPath).toBe(join(dir, "settings.json"));
    expect(result.view.settingsState).toBe("missing");
    const interrupt = result.view.keybindings.find((row) => row.id === "app.interrupt");
    expect(interrupt).toMatchObject({ defaultKeys: ["escape"], keys: ["escape"], source: "default" });
    // Every listed action is one of the verified managed ids.
    expect(result.view.keybindings.map((row) => row.id)).toEqual(MANAGED_KEYBINDINGS.map((item) => item.id));
  });

  it("reports a custom binding as custom and keeps Pi's default alongside it", () => {
    const dir = agentDir();
    writeFileSync(join(dir, "keybindings.json"), `${JSON.stringify({
      "$schema": KEYBINDINGS_SCHEMA_URL,
      "app.interrupt": ["ctrl+shift+x", "alt+escape"],
    }, null, 2)}\n`, "utf8");
    const result = readNativePreferences(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.view.keybindings.find((item) => item.id === "app.interrupt");
    expect(row).toMatchObject({ source: "custom", keys: ["ctrl+shift+x", "alt+escape"], defaultKeys: ["escape"] });
  });

  it("names an unparseable document and a malformed value instead of showing defaults as saved", () => {
    const broken = agentDir();
    writeFileSync(join(broken, "keybindings.json"), "{ not json", "utf8");
    const failed = readNativePreferences(broken);
    expect(failed).toMatchObject({ ok: false });
    if (!failed.ok) expect(failed.error).toContain(join(broken, "keybindings.json"));

    const bad = agentDir();
    writeFileSync(join(bad, "keybindings.json"), JSON.stringify({ "app.interrupt": "ctrl+nosuchkey" }), "utf8");
    const partial = readNativePreferences(bad);
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    expect(partial.view.keybindingsError).toContain("app.interrupt");
  });
});

describe("#149 native keybindings write", () => {
  it("replaces ONE value and preserves every other byte, including unknown fields", () => {
    const dir = agentDir();
    const original = [
      "{",
      `  "$schema": "${KEYBINDINGS_SCHEMA_URL}",`,
      '  "app.model.select": "ctrl+l",',
      '  "x.future.field": { "nested": [1, 2, { "keep": true }] },',
      '  "app.interrupt": [',
      '    "escape"',
      "  ]",
      "}",
      "",
    ].join("\n");
    writeFileSync(join(dir, "keybindings.json"), original, "utf8");

    const saved = saveNativeKeybinding(dir, { action: "app.interrupt", keys: ["ctrl+shift+x"] });
    expect(saved.ok).toBe(true);

    const after = readFileSync(join(dir, "keybindings.json"), "utf8");
    const expected = original
      .replace('"app.interrupt": [\n    "escape"\n  ]', '"app.interrupt": ["ctrl+shift+x"]');
    expect(after).toBe(expected);
    // Every unowned line survived verbatim.
    expect(after).toContain('"x.future.field": { "nested": [1, 2, { "keep": true }] },');
    expect(after).toContain('"app.model.select": "ctrl+l",');
    expect(after).toContain(`"$schema": "${KEYBINDINGS_SCHEMA_URL}"`);
  });

  it("appends a new action without disturbing the existing document, and creates the file when absent", () => {
    const dir = agentDir();
    const original = `{\n  "$schema": "${KEYBINDINGS_SCHEMA_URL}"\n}\n`;
    writeFileSync(join(dir, "keybindings.json"), original, "utf8");
    expect(saveNativeKeybinding(dir, { action: "app.session.new", keys: ["ctrl+shift+n"] }).ok).toBe(true);
    const after = readFileSync(join(dir, "keybindings.json"), "utf8");
    expect(JSON.parse(after)).toEqual({ "$schema": KEYBINDINGS_SCHEMA_URL, "app.session.new": ["ctrl+shift+n"] });
    expect(after.startsWith(`{\n  "$schema": "${KEYBINDINGS_SCHEMA_URL}",\n`)).toBe(true);

    const fresh = agentDir();
    expect(saveNativeKeybinding(fresh, { action: "app.thinking.cycle", keys: ["ctrl+shift+t"] }).ok).toBe(true);
    const created = JSON.parse(readFileSync(join(fresh, "keybindings.json"), "utf8"));
    expect(created).toEqual({ "$schema": KEYBINDINGS_SCHEMA_URL, "app.thinking.cycle": ["ctrl+shift+t"] });
  });

  it("refuses an unverified action, a key Pi does not document and a broken document — writing nothing", () => {
    const dir = agentDir();
    const original = '{\n  "app.interrupt": "escape",\n  "x.keep": 1\n}\n';
    writeFileSync(join(dir, "keybindings.json"), original, "utf8");

    expect(saveNativeKeybinding(dir, { action: "app.not.real", keys: ["ctrl+x"] }))
      .toEqual({ ok: false, error: "keybinding-unsupported-action: app.not.real" });
    expect(saveNativeKeybinding(dir, { action: "app.interrupt", keys: ["hyper+esc"] }))
      .toEqual({ ok: false, error: "keybinding-invalid-syntax: hyper+esc" });
    expect(saveNativeKeybinding(dir, { action: "app.interrupt", keys: "escape" }))
      .toEqual({ ok: false, error: "preferences-invalid-payload" });
    expect(saveNativeKeybinding(dir, { action: "app.interrupt", keys: ["ctrl+x", "ctrl+x"] }))
      .toEqual({ ok: false, error: "keybinding-duplicate-key: app.interrupt" });
    expect(readFileSync(join(dir, "keybindings.json"), "utf8")).toBe(original);

    const broken = agentDir();
    writeFileSync(join(broken, "keybindings.json"), "[1,2,3]", "utf8");
    expect(saveNativeKeybinding(broken, { action: "app.interrupt", keys: ["ctrl+x"] })).toMatchObject({ ok: false });
    expect(readFileSync(join(broken, "keybindings.json"), "utf8")).toBe("[1,2,3]");
    expect(existsSync(join(broken, "keybindings.json"))).toBe(true);
  });
});

describe("#149 key syntax + splice", () => {
  it("accepts exactly the documented key forms", () => {
    for (const key of ["escape", "ctrl+l", "shift+tab", "alt+ctrl+x", "super+k", "ctrl+1", "f12", "ctrl+shift+alt+x"]) {
      expect(normalizeKey(key)).toBe(key);
    }
    for (const key of ["", "ctrl+", "hyper+x", "ctrl+ctrl+x", "ctrl+nope", 42, null]) {
      expect(normalizeKey(key)).toBeNull();
    }
    expect(normalizeKey("  CTRL+L  ")).toBe("ctrl+l");
  });

  it("splices single-line documents and refuses a non-object", () => {
    expect(spliceTopLevelValue('{"a":1,"b":2}', "b", ["k"])).toBe('{"a":1,"b":["k"]}');
    expect(() => spliceTopLevelValue("nope", "b", ["k"])).toThrow("keybindings-invalid-json");
  });
});
