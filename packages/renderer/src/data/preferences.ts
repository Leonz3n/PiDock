/**
 * [Pencil T14] #149 — 设置的渲染层契约.
 *
 * Two independent sources, deliberately not merged:
 *
 * 1. **PiDock's own appearance preference** (`userData/appearance.json`, main's
 *    document). 日间 / 夜间 / 跟随系统 is an application preference, so it never
 *    rides on Pi's `settings.json`.
 * 2. **Pi's native configuration** as a bounded projection: only the actions
 *    main verified are listed, only ONE keybinding is written per save, and
 *    every unsupported field comes back with its real path and reason instead
 *    of a control that would write nothing.
 *
 * Every parser here is fail-closed: a payload that is not the documented shape
 * is dropped and reported, so a broken round trip can never render as a
 * plausible-looking setting.
 */

import { shellBridge, type PreferencesRequest } from "./shellBridge";

export const APPEARANCE_OPTIONS = [
  { mode: "light", label: "日间", description: "暖灰与纸白，适合明亮环境" },
  { mode: "dark", label: "夜间", description: "炭灰与浅墨，降低暗处亮度反差" },
  { mode: "system", label: "跟随系统", description: "随系统外观自动切换" },
] as const;

export type AppearanceMode = (typeof APPEARANCE_OPTIONS)[number]["mode"];
export type ResolvedAppearance = "light" | "dark";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function isAppearanceMode(value: unknown): value is AppearanceMode {
  return value === "light" || value === "dark" || value === "system";
}

/**
 * The one resolution rule the whole app shares: a manual mode wins, `system`
 * follows the OS. Pure so the test can drive both branches without a browser.
 */
export function resolveAppearance(preference: AppearanceMode, systemPrefersDark: boolean): ResolvedAppearance {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

/** Wording for the header's 「跟随系统 · 当前为日间」 line and the nav card. */
export function appearancePreferenceLabel(preference: AppearanceMode): string {
  return APPEARANCE_OPTIONS.find((option) => option.mode === preference)?.label ?? "跟随系统";
}

export function appearanceModeLabel(mode: ResolvedAppearance): string {
  return mode === "dark" ? "夜间" : "日间";
}

export type KeybindingView = {
  id: string;
  label: string;
  defaultKeys: string[];
  keys: string[];
  source: "custom" | "default";
};

export type UnsupportedField = {
  pane: "language" | "general";
  field: string;
  path: string;
  status: "unsupported" | "unwired";
  reason: string;
};

export type NativePreferencesView = {
  agentDir: string;
  keybindingsPath: string;
  settingsPath: string;
  keybindings: KeybindingView[];
  keybindingsError: string | null;
  settingsState: "missing" | "present" | "invalid";
  unsupported: UnsupportedField[];
  reloadBoundary: string;
};

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...(value as string[])] : undefined;

export function nativePreferencesFromHost(payload: unknown): NativePreferencesView | undefined {
  if (!record(payload)) return undefined;
  const { agentDir, keybindingsPath, settingsPath, keybindingsError, settingsState, unsupported, reloadBoundary } = payload;
  if (typeof agentDir !== "string" || typeof keybindingsPath !== "string" || typeof settingsPath !== "string") return undefined;
  if (typeof reloadBoundary !== "string") return undefined;
  if (keybindingsError !== null && typeof keybindingsError !== "string") return undefined;
  if (settingsState !== "missing" && settingsState !== "present" && settingsState !== "invalid") return undefined;
  if (!Array.isArray(payload["keybindings"])) return undefined;
  const keybindings: KeybindingView[] = [];
  for (const row of payload["keybindings"] as unknown[]) {
    if (!record(row)) return undefined;
    const defaultKeys = strings(row["defaultKeys"]);
    const keys = strings(row["keys"]);
    const { id, label, source } = row;
    if (typeof id !== "string" || typeof label !== "string") return undefined;
    if (source !== "custom" && source !== "default") return undefined;
    if (!defaultKeys || !keys) return undefined;
    keybindings.push({ id, label, defaultKeys, keys, source });
  }
  if (!Array.isArray(unsupported)) return undefined;
  const fields: UnsupportedField[] = [];
  for (const row of unsupported as unknown[]) {
    if (!record(row)) return undefined;
    const { pane, field, path, status, reason } = row;
    if (pane !== "language" && pane !== "general") return undefined;
    if (status !== "unsupported" && status !== "unwired") return undefined;
    if (typeof field !== "string" || typeof path !== "string" || typeof reason !== "string") return undefined;
    fields.push({ pane, field, path, status, reason });
  }
  return { agentDir, keybindingsPath, settingsPath, keybindings, keybindingsError, settingsState, unsupported: fields, reloadBoundary };
}

export type PreferencesCall<T> = { ok: true; value: T } | { ok: false; error: string };

/** True when the page runs inside the desktop shell with the settings channel. */
export function preferencesAvailable(): boolean {
  return typeof shellBridge()?.preferencesOp === "function";
}

async function roundTrip<T>(request: PreferencesRequest, parse: (payload: unknown) => T | undefined, shapeError: string): Promise<PreferencesCall<T>> {
  const bridge = shellBridge();
  if (!bridge?.preferencesOp) return { ok: false, error: "当前不在桌面壳内，无法读写设置" };
  let result: Awaited<ReturnType<NonNullable<typeof bridge.preferencesOp>>>;
  try {
    result = await bridge.preferencesOp(request);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!result || typeof result !== "object" || typeof result.ok !== "boolean") {
    return { ok: false, error: "invalid-payload: 设置返回异常，请重试" };
  }
  if (!result.ok) return { ok: false, error: result.error ?? "设置操作未完成" };
  const value = parse(result.payload);
  if (value === undefined) return { ok: false, error: shapeError };
  return { ok: true, value };
}

const appearanceFromHost = (payload: unknown): AppearanceMode | undefined =>
  record(payload) && isAppearanceMode(payload["appearance"]) ? payload["appearance"] : undefined;

export const readAppearancePreference = (): Promise<PreferencesCall<AppearanceMode>> =>
  roundTrip({ op: "appearance/read" }, appearanceFromHost, "外观偏好响应无法解析");

export const saveAppearancePreference = (appearance: AppearanceMode): Promise<PreferencesCall<AppearanceMode>> =>
  roundTrip({ op: "appearance/save", appearance }, appearanceFromHost, "外观偏好保存响应无法解析");

export const readNativePreferences = (): Promise<PreferencesCall<NativePreferencesView>> =>
  roundTrip({ op: "native/read" }, nativePreferencesFromHost, "原生配置响应无法解析");

export const saveNativeKeybinding = (action: string, keys: string[]): Promise<PreferencesCall<NativePreferencesView>> =>
  roundTrip({ op: "native/saveKeybinding", action, keys }, nativePreferencesFromHost, "快捷键保存响应无法解析");

/**
 * PiDock's OWN shortcuts. These are the ones a saved Pi binding can never
 * retarget, and the 快捷键 pane states that in the same words the surfaces use.
 * Each entry is real: it is the handler the component actually installs.
 */
export const PIDOCK_SHORTCUTS = [
  { keys: "Esc", label: "从设置／能力管理返回原任务" },
  { keys: "← 返回任务工作区", label: "设置与能力管理的返回按钮（与 Esc 同一目的地）" },
] as const;
