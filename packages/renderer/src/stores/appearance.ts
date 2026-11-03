/**
 * [Pencil T14] #149 — 外观 store（日间 / 夜间 / 跟随系统）.
 *
 * Three responsibilities, kept apart from Pi's native settings:
 *
 * 1. Apply: the resolved mode is written to `document.documentElement`
 *    (`data-theme="light|dark"`), which is the only thing `styles/tokens.css`
 *    switches on. Every surface reads semantic tokens (`bg-bg`, `text-ink`,
 *    `border-line`, `bg-paper`, `bg-sidebar`, `text-accent`…), so no component
 *    knows a theme name and no page can paint an ad-hoc palette.
 * 2. Persist: the PREFERENCE (not the resolved mode) goes to main's
 *    `appearance.json` in `userData`. `system` is stored as `system`, so a later
 *    OS switch is honoured instead of being frozen at the last resolved value.
 * 3. Follow the OS: while the preference is `system`, a
 *    `prefers-color-scheme` change event re-resolves immediately. A manual
 *    choice ignores that event — the user's explicit choice wins.
 *
 * The store also exposes the honest states the page renders: `loading` while
 * main answers, and the named `persistError` when a save is refused (the UI
 * keeps showing the applied mode, but never claims it was saved).
 */

import { create } from "zustand";
import {
  isAppearanceMode,
  preferencesAvailable,
  readAppearancePreference,
  resolveAppearance,
  saveAppearancePreference,
  type AppearanceMode,
  type ResolvedAppearance,
} from "../data/preferences";

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia(DARK_QUERY).matches === true;
  } catch {
    return false;
  }
}

/** The one DOM write; exported so the test can assert the exact attribute. */
export function applyResolvedAppearance(mode: ResolvedAppearance): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset["theme"] = mode;
  // `color-scheme` also lets native controls (scrollbars, form widgets) match.
  root.style.colorScheme = mode;
}

type AppearanceState = {
  /** The persisted preference. `system` is a real choice, not "unknown". */
  preference: AppearanceMode;
  /** What is painted right now (preference resolved against the OS). */
  resolved: ResolvedAppearance;
  /** `loading` until main answered; `unavailable` outside the desktop shell. */
  status: "idle" | "loading" | "ready" | "unavailable";
  readError: string | null;
  persistError: string | null;
  setPreference: (mode: AppearanceMode) => Promise<void>;
  hydrate: () => Promise<void>;
  /** Re-resolve against the OS; called by the `prefers-color-scheme` listener. */
  refreshSystem: () => void;
};

export const useAppearanceStore = create<AppearanceState>((set, get) => ({
  preference: "system",
  resolved: "light",
  status: "idle",
  readError: null,
  persistError: null,
  setPreference: async (mode) => {
    if (!isAppearanceMode(mode)) return;
    const resolved = resolveAppearance(mode, systemPrefersDark());
    // Instant apply: the paint changes before the write completes, so the user
    // sees the choice without waiting on disk.
    applyResolvedAppearance(resolved);
    set({ preference: mode, resolved, persistError: null });
    if (!preferencesAvailable()) {
      // Outside the shell there is nothing to persist; the page says so and the
      // in-memory choice still applies for this session.
      set({ status: "unavailable" });
      return;
    }
    const result = await saveAppearancePreference(mode);
    if (!result.ok) {
      // The refusal never silently reverts the paint (the user asked for this
      // mode); it is NAMED so the page can say it will not survive a restart.
      set({ persistError: result.error });
      return;
    }
    // Main echoes what it wrote; a mismatch means the choice is not what is
    // stored, so the page must not show a saved state.
    if (result.value !== mode) {
      set({ persistError: `外观偏好未按选择保存（磁盘为 ${result.value}，选择为 ${mode}）` });
    }
  },
  hydrate: async () => {
    const initial = systemPrefersDark();
    set({ status: "loading", resolved: resolveAppearance(get().preference, initial) });
    applyResolvedAppearance(resolveAppearance(get().preference, initial));
    if (!preferencesAvailable()) {
      set({ status: "unavailable" });
      return;
    }
    const result = await readAppearancePreference();
    if (!result.ok) {
      set({ status: "ready", readError: result.error });
      return;
    }
    const resolved = resolveAppearance(result.value, systemPrefersDark());
    applyResolvedAppearance(resolved);
    set({ preference: result.value, resolved, status: "ready", readError: null });
  },
  refreshSystem: () => {
    const { preference } = get();
    if (preference !== "system") return;
    const resolved = resolveAppearance(preference, systemPrefersDark());
    applyResolvedAppearance(resolved);
    set({ resolved });
  },
}));

/**
 * Subscribe to OS appearance changes. Returns the unsubscribe function; the
 * caller (settings page / shell mount) owns the lifetime.
 */
export function watchSystemAppearance(): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  // A test double (or a webview without matchMedia) may answer with nothing:
  // the appearance still applies, it just cannot follow the OS.
  const media = window.matchMedia(DARK_QUERY) as MediaQueryList | undefined;
  if (media === undefined || media === null || typeof media !== "object") return () => {};
  const listener = () => useAppearanceStore.getState().refreshSystem();
  // Safari < 14 only has the deprecated `addListener`; jsdom in tests provides
  // both shapes through the setup stub.
  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }
  const legacy = media as unknown as { addListener?: (fn: () => void) => void; removeListener?: (fn: () => void) => void };
  legacy.addListener?.(listener);
  return () => legacy.removeListener?.(listener);
}
