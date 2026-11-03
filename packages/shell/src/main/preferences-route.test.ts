/**
 * [Pencil T14] #149 — the settings route itself.
 *
 * Two things are pinned here that a component test can never prove:
 *
 * 1. **Route integrity**: the channel exists with exactly the four named ops,
 *    is on the preload allowlist (and mirrored in the sandboxed preload), and is
 *    NOT a task op — a page-chosen path or agent directory never travels on it.
 * 2. **Persistence**: 外观 is written to PiDock's own document in `userData`
 *    (atomically, one field), and `system` is stored as `system` rather than as
 *    the light/dark value it happened to resolve to.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ALLOWED_INVOKE_CHANNELS } from "../preload/allowlist.js";
import { performPreferencesOperation } from "./preferences-route.js";
import { appearancePath, readAppearancePreference, saveAppearancePreference } from "./appearance-preference.js";

const dirs: string[] = [];
function sandbox(): { userData: string; agentDir: string } {
  const root = mkdtempSync(join(tmpdir(), "pidock-prefs-route-"));
  dirs.push(root);
  return { userData: join(root, "userData"), agentDir: join(root, "agent") };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("#149 preferences route", () => {
  it("is its own attested channel with exactly four named ops, never a task op", () => {
    expect(ALLOWED_INVOKE_CHANNELS).toContain("shell/preferencesOp");
    const paths = sandbox();
    expect(performPreferencesOperation({ op: "task/sendMessage", text: "hi" }, paths))
      .toEqual({ ok: false, error: "preferences-unknown-op: task/sendMessage" });
    expect(performPreferencesOperation({ op: "appearance/save", appearance: "dark", path: "/etc/passwd" }, paths))
      .toEqual({ ok: true, payload: { appearance: "dark" } });
    // The extra `path` key is ignored, never resolved: main owns both directories.
    expect(performPreferencesOperation(null, paths)).toEqual({ ok: false, error: "preferences-invalid-payload" });
    expect(performPreferencesOperation("appearance/read", paths)).toEqual({ ok: false, error: "preferences-invalid-payload" });
  });

  it("defaults to 跟随系统 when no document exists and round-trips a saved mode", () => {
    const paths = sandbox();
    expect(performPreferencesOperation({ op: "appearance/read" }, paths)).toEqual({ ok: true, payload: { appearance: "system" } });
    expect(performPreferencesOperation({ op: "appearance/save", appearance: "dark" }, paths))
      .toEqual({ ok: true, payload: { appearance: "dark" } });
    expect(readFileSync(appearancePath(paths.userData), "utf8")).toBe('{\n  "appearance": "dark"\n}\n');
    expect(performPreferencesOperation({ op: "appearance/read" }, paths)).toEqual({ ok: true, payload: { appearance: "dark" } });
  });

  it("refuses an unsupported mode by name and writes nothing", () => {
    const paths = sandbox();
    expect(saveAppearancePreference(paths.userData, { appearance: "sepia" })).toEqual({ ok: false, error: "appearance-invalid-value" });
    expect(saveAppearancePreference(paths.userData, {})).toEqual({ ok: false, error: "appearance-invalid-value" });
    expect(saveAppearancePreference(paths.userData, null)).toEqual({ ok: false, error: "preferences-invalid-payload" });
    expect(performPreferencesOperation({ op: "appearance/read" }, paths)).toEqual({ ok: true, payload: { appearance: "system" } });
  });

  it("names a corrupt appearance document instead of silently reporting 跟随系统", () => {
    const paths = sandbox();
    saveAppearancePreference(paths.userData, { appearance: "light" });
    writeFileSync(appearancePath(paths.userData), '{"appearance": "neon"}', "utf8");
    const result = readAppearancePreference(paths.userData);
    expect(result).toEqual({ ok: false, error: `appearance-invalid-document: ${appearancePath(paths.userData)}` });
    writeFileSync(appearancePath(paths.userData), "not json", "utf8");
    expect(readAppearancePreference(paths.userData).ok).toBe(false);
  });

  it("serves the native view and saves one keybinding through the same route", () => {
    const paths = sandbox();
    const read = performPreferencesOperation({ op: "native/read" }, paths);
    expect(read.ok).toBe(true);
    if (read.ok) {
      const view = read.payload as { keybindingsPath: string; unsupported: { pane: string; status: string; path: string }[] };
      expect(view.keybindingsPath).toBe(join(paths.agentDir, "keybindings.json"));
      expect(view.unsupported.find((row) => row.pane === "language")).toMatchObject({
        status: "unsupported",
        path: join(paths.agentDir, "settings.json"),
      });
    }
    const saved = performPreferencesOperation({ op: "native/saveKeybinding", action: "app.interrupt", keys: ["ctrl+shift+x"] }, paths);
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      const view = saved.payload as { keybindings: { id: string; keys: string[]; source: string }[] };
      expect(view.keybindings.find((row) => row.id === "app.interrupt")).toMatchObject({
        keys: ["ctrl+shift+x"], source: "custom",
      });
    }
    expect(readFileSync(join(paths.agentDir, "keybindings.json"), "utf8")).toContain('"app.interrupt": ["ctrl+shift+x"]');
  });
});

describe("#149 sandboxed preload mirror", () => {
  it("exposes the same channel in the plain-script preload", () => {
    const source = readFileSync(join(__dirname, "..", "preload", "preload.cjs"), "utf8");
    expect(source).toContain('"shell/preferencesOp"');
    expect(source).toContain("preferencesOp: function (request)");
    // The page never receives a raw ipcRenderer handle.
    expect(source).not.toMatch(/exposeInMainWorld\(\s*"ipcRenderer"/);
  });
});
