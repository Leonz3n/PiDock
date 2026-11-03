/**
 * [Pencil T14] #149 — the single attested route for the settings surface.
 *
 * Four operations, each naming its own bounded payload; the page never names a
 * file, never names an agent directory and never names a Pi action outside the
 * verified managed subset. Everything else is refused by name:
 *
 * | op | effect |
 * | --- | --- |
 * | `appearance/read` | read PiDock's own appearance document (userData) |
 * | `appearance/save` | write one of light/dark/system, atomically |
 * | `native/read` | read `<agent-dir>/keybindings.json` + `settings.json` state |
 * | `native/saveKeybinding` | replace ONE managed Pi keybinding, byte-preserving |
 *
 * This is NOT a task op: nothing here travels on `shell/taskOp`, and the
 * renderer's task-op set is unchanged.
 */

import { readAppearancePreference, saveAppearancePreference } from "./appearance-preference.js";
import { readNativePreferences, saveNativeKeybinding } from "./native-preferences.js";

export type PreferencesOp =
  | "appearance/read"
  | "appearance/save"
  | "native/read"
  | "native/saveKeybinding";

const OPS = new Set<string>(["appearance/read", "appearance/save", "native/read", "native/saveKeybinding"]);

export type PreferencesResult = { ok: true; payload: unknown } | { ok: false; error: string };

export function performPreferencesOperation(
  request: unknown,
  paths: { userData: string; agentDir: string },
): PreferencesResult {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return { ok: false, error: "preferences-invalid-payload" };
  }
  const input = request as Record<string, unknown>;
  const op = input["op"];
  if (typeof op !== "string" || !OPS.has(op)) return { ok: false, error: `preferences-unknown-op: ${String(op)}` };

  switch (op as PreferencesOp) {
    case "appearance/read": {
      const result = readAppearancePreference(paths.userData);
      return result.ok ? { ok: true, payload: { appearance: result.value } } : result;
    }
    case "appearance/save": {
      const result = saveAppearancePreference(paths.userData, input);
      return result.ok ? { ok: true, payload: { appearance: result.value } } : result;
    }
    case "native/read": {
      const result = readNativePreferences(paths.agentDir);
      return result.ok ? { ok: true, payload: result.view } : result;
    }
    case "native/saveKeybinding": {
      const result = saveNativeKeybinding(paths.agentDir, input);
      return result.ok ? { ok: true, payload: result.view } : result;
    }
  }
}
