import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopSettingsPage } from "../components/DesktopSettingsPage";
import { DesktopCapabilitiesPage } from "../components/DesktopCapabilitiesPage";
import { useAppearanceStore, watchSystemAppearance } from "../stores/appearance";
import { APPEARANCE_OPTIONS, resolveAppearance } from "../data/preferences";

/**
 * [Pencil T14] #149 — 设置 as its own destination, 日间／夜间／跟随系统, and Pi's
 * native preferences as an honest bounded projection.
 *
 * Everything here targets the PRODUCTION settings page (`DesktopSettingsPage`),
 * never the demo shell: the acceptance is about the real desktop entry.
 */

const AGENT_DIR = "/Users/someone/.pi/agent";
const KEYBINDINGS_PATH = join(AGENT_DIR, "keybindings.json");
const SETTINGS_PATH = join(AGENT_DIR, "settings.json");
const RELOAD = "Pi 的 keybindings.json 只作用于 Pi 自己的终端界面：保存后需在 Pi 重启（或 Pi 会话内 /reload）后生效，不会改写 PiDock 自己的快捷键。";

const nativeView = (overrides: Record<string, unknown> = {}) => ({
  agentDir: AGENT_DIR,
  keybindingsPath: KEYBINDINGS_PATH,
  settingsPath: SETTINGS_PATH,
  keybindings: [
    { id: "app.interrupt", label: "中止当前回合", defaultKeys: ["escape"], keys: ["escape"], source: "default" },
    { id: "app.model.select", label: "打开模型选择", defaultKeys: ["ctrl+l"], keys: ["ctrl+shift+p"], source: "custom" },
  ],
  keybindingsError: null,
  settingsState: "present",
  unsupported: [
    {
      pane: "language",
      field: "language / locale",
      path: SETTINGS_PATH,
      status: "unsupported",
      reason: "Pi 1.5.0 的 settings.json 没有语言／locale 字段。",
    },
    {
      pane: "general",
      field: "selfUpdateCommand",
      path: SETTINGS_PATH,
      status: "unwired",
      reason: "PiDock 使用随包固定的 SDK。",
    },
  ],
  reloadBoundary: RELOAD,
  ...overrides,
});

type Prefs = (request: Record<string, unknown>) => Promise<{ ok: boolean; payload?: unknown; error?: string }>;

function stubPreferences(preferencesOp: ReturnType<typeof vi.fn>) {
  window.pidock = { preferencesOp } as unknown as typeof window.pidock;
  return preferencesOp;
}

/** A controllable `matchMedia` so 跟随系统 can be driven like a real OS flip. */
function controllableMedia(initialDark: boolean) {
  const state = { dark: initialDark };
  const listeners = new Set<() => void>();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    get matches() { return state.dark; },
    media: query,
    onchange: null,
    addListener: (listener: () => void) => { listeners.add(listener); },
    removeListener: (listener: () => void) => { listeners.delete(listener); },
    addEventListener: (_event: string, listener: () => void) => { listeners.add(listener); },
    removeEventListener: (_event: string, listener: () => void) => { listeners.delete(listener); },
    dispatchEvent: vi.fn(),
  }));
  return {
    flip(next: boolean) {
      state.dark = next;
      act(() => { for (const listener of listeners) listener(); });
    },
    listenerCount: () => listeners.size,
  };
}

/** Default: the OS reports light, so every test starts from a known mode. */
function defaultMedia() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

beforeEach(() => {
  defaultMedia();
  act(() => {
    useAppearanceStore.setState({ preference: "system", resolved: "light", status: "idle", readError: null, persistError: null });
  });
  delete document.documentElement.dataset["theme"];
});

afterEach(() => {
  cleanup();
  delete (window as { pidock?: unknown }).pidock;
  defaultMedia();
});

describe("#149 设置 is its own destination", () => {
  it("defaults to 外观 with exactly the four 应用偏好 entries and no forbidden management entries", () => {
    render(<DesktopSettingsPage />);
    const nav = screen.getByRole("navigation", { name: "设置" });
    const entries = within(nav).getAllByRole("button").map((button) => button.textContent);
    expect(entries.slice(0, 4)).toEqual(["外观", "快捷键", "语言", "通用"]);
    // 外观 is the default pane: its own heading and radios are on screen.
    expect(screen.getByRole("heading", { name: "外观" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "外观偏好" })).toBeInTheDocument();
    for (const forbidden of ["Extensions", "Computer Use", "Browser", "MCP", "Skills", "Providers"]) {
      expect(within(nav).queryByText(new RegExp(forbidden, "i"))).toBeNull();
    }
    expect(screen.queryByRole("navigation", { name: "能力管理" })).toBeNull();
  });

  it("keeps 能力管理 as a separate destination with only Providers / MCP / Skills", () => {
    render(<DesktopCapabilitiesPage />);
    const nav = screen.getByRole("navigation", { name: "能力管理" });
    // The nav itself holds the three entries plus the footer's disabled
    // 「打开配置目录」 button; the three entries come first and in this order.
    const entries = within(nav).getAllByRole("button").map((button) => button.textContent?.replace(/—|未接线|\d+/g, "").trim());
    expect(entries.slice(0, 3)).toEqual(["Providers", "MCP", "Skills"]);
    for (const forbidden of ["Extensions", "Computer Use", "Browser", "设置", "外观"]) {
      expect(within(nav).queryByText(new RegExp(`^${forbidden}$`))).toBeNull();
    }
  });
});

describe("#149 日间 / 夜间 / 跟随系统", () => {
  it("applies instantly, persists the PREFERENCE through its own op, and reports main's answer", async () => {
    const preferencesOp = stubPreferences(vi.fn(async (request: Record<string, unknown>) => request["op"] === "appearance/read"
      ? { ok: true, payload: { appearance: "system" } }
      : { ok: true, payload: { appearance: request["appearance"] } }));
    render(<DesktopSettingsPage />);
    await waitFor(() => expect(preferencesOp).toHaveBeenCalledWith({ op: "appearance/read" }));

    const option = (mode: string) => screen.getByTestId("desktop-settings-page").querySelector(`[data-appearance-option="${mode}"]`) as HTMLElement;
    fireEvent.click(option("dark"));
    // Instant: the attribute the whole CSS layer switches on.
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    await waitFor(() => expect(preferencesOp).toHaveBeenLastCalledWith({ op: "appearance/save", appearance: "dark" }));
    expect(screen.getByTestId("settings-preference-card")).toHaveTextContent("当前偏好：夜间");
    expect(option("dark")).toHaveAttribute("aria-checked", "true");

    fireEvent.click(option("light"));
    expect(document.documentElement.dataset["theme"]).toBe("light");
    await waitFor(() => expect(preferencesOp).toHaveBeenLastCalledWith({ op: "appearance/save", appearance: "light" }));
  });

  it("restores the saved mode on open and follows the OS only while 跟随系统 is chosen", async () => {
    const media = controllableMedia(true);
    stubPreferences(vi.fn(async (request: Record<string, unknown>) => request["op"] === "appearance/read"
      ? { ok: true, payload: { appearance: "system" } }
      : { ok: true, payload: { appearance: request["appearance"] } }));
    render(<DesktopSettingsPage />);
    await waitFor(() => expect(document.documentElement.dataset["theme"]).toBe("dark"));
    expect(screen.getByText("跟随系统 · 当前为夜间")).toBeInTheDocument();

    // OS flips to light while 跟随系统: the paint follows without a save.
    media.flip(false);
    expect(document.documentElement.dataset["theme"]).toBe("light");

    // A manual choice wins and ignores the OS afterwards.
    fireEvent.click(screen.getByTestId("desktop-settings-page").querySelector('[data-appearance-option="dark"]') as HTMLElement);
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    media.flip(false);
    expect(document.documentElement.dataset["theme"]).toBe("dark");
  });

  it("re-resolves 跟随系统 from the OS event and unsubscribes cleanly", () => {
    const media = controllableMedia(false);
    const stop = watchSystemAppearance();
    expect(media.listenerCount()).toBe(1);
    media.flip(true);
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    stop();
    expect(media.listenerCount()).toBe(0);
    // Resolution itself is pure and shared: a manual mode never consults the OS.
    expect(resolveAppearance("light", true)).toBe("light");
    expect(resolveAppearance("dark", false)).toBe("dark");
    expect(resolveAppearance("system", true)).toBe("dark");
    expect(APPEARANCE_OPTIONS.map((option) => option.mode)).toEqual(["light", "dark", "system"]);
  });

  it("states a refused save instead of showing a saved-looking preference", async () => {
    stubPreferences(vi.fn(async (request: Record<string, unknown>) => request["op"] === "appearance/read"
      ? { ok: true, payload: { appearance: "system" } }
      : { ok: false, error: "appearance-unwritable: /tmp/userData/appearance.json" }));
    render(<DesktopSettingsPage />);
    fireEvent.click(await screen.findByTestId("desktop-settings-page").then((page) => page.querySelector('[data-appearance-option="dark"]') as HTMLElement));
    expect(await screen.findByRole("alert")).toHaveTextContent("appearance-unwritable");
    expect(document.documentElement.dataset["theme"]).toBe("dark");
  });
});

describe("#149 semantic tokens: one palette, two modes, no green", () => {
  const css = readFileSync(join(__dirname, "..", "styles", "tokens.css"), "utf8");
  const tokens = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "docs", "design", "appearance.tokens.json"), "utf8")) as {
    colors: Record<string, { light: string; dark: string }>;
  };

  const luminance = (hex: string): number => {
    const value = hex.replace("#", "");
    const channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
    const [r, g, b] = channels.map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string): number => {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (light + 0.05) / (dark + 0.05);
  };
  const hue = (hex: string): number => {
    const value = hex.replace("#", "");
    const [r, g, b] = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255) as [number, number, number];
    const max = Math.max(r, g, b);
    const delta = max - Math.min(r, g, b);
    if (delta === 0) return 0;
    const raw = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    return (raw * 60 + 360) % 360;
  };

  it("keeps every documented pair above 4.5:1 in BOTH modes", () => {
    for (const mode of ["light", "dark"] as const) {
      for (const fg of ["ink-primary", "ink-secondary", "ink-muted"]) {
        for (const bg of ["bg-canvas", "bg-surface", "bg-sidebar", "bg-sunken", "bg-code"]) {
          expect(contrast(tokens.colors[fg]![mode], tokens.colors[bg]![mode]), `${mode} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("uses the design's fog-blue accent and contains no green", () => {
    expect(css).toContain(`--color-accent: ${tokens.colors["accent-primary"]!.light.toLowerCase()};`);
    expect(css).toContain(`--color-accent: ${tokens.colors["accent-primary"]!.dark.toLowerCase()};`);
    const declared = [...css.matchAll(/#[0-9a-fA-F]{6}/g)].map((match) => match[0].toLowerCase());
    const chromatic = declared.filter((hex) => {
      const value = hex.replace("#", "");
      const [r, g, b] = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16)) as [number, number, number];
      return Math.max(r, g, b) - Math.min(r, g, b) > 24;
    });
    expect(chromatic.length).toBeGreaterThan(0);
    for (const hex of chromatic) {
      const angle = hue(hex);
      expect(angle < 90 || angle > 150, `${hex} is a green hue`).toBe(true);
    }
    for (const token of Object.values(tokens.colors)) {
      for (const value of [token.light, token.dark]) {
        const angle = hue(value);
        expect(angle < 90 || angle > 150, `${value} is a green design token`).toBe(true);
      }
    }
  });

  it("defines the same semantic names in the dark block, so no surface keeps a light-only value", () => {
    const names = (block: string) => [...block.matchAll(/--color-([a-z-]+):/g)].map((match) => match[1]).sort();
    const themeBlock = css.slice(css.indexOf("@theme"), css.indexOf(":root[data-theme=\"dark\"]"));
    const darkBlock = css.slice(css.indexOf(":root[data-theme=\"dark\"]"), css.indexOf("@layer base"));
    const lightOnly = names(themeBlock).filter((name) => !names(darkBlock).includes(name));
    // Everything below is a token that must NOT change between modes (aliases
    // and radii are expressed through the semantic names above).
    expect(lightOnly).toEqual(expect.arrayContaining([]));
    for (const name of ["bg", "paper", "ink", "muted", "line", "accent", "soft", "sidebar", "orange"]) {
      expect(names(darkBlock)).toContain(name);
    }
    expect(css).toContain(':root[data-theme="dark"]');
  });
});

describe("#149 native preferences: bounded, honest", () => {
  it("edits ONE Pi action through the exact payload and preserves what main returns", async () => {
    const view = nativeView();
    const preferencesOp = stubPreferences(vi.fn(async (request: Record<string, unknown>) => {
      if (request["op"] === "native/read") return { ok: true, payload: view };
      if (request["op"] === "native/saveKeybinding") {
        return { ok: true, payload: nativeView({ keybindings: (view.keybindings as unknown[]).map((row) => (row as { id: string }).id === "app.interrupt" ? { ...(row as object), keys: ["ctrl+shift+x"], source: "custom" } : row) }) };
      }
      return { ok: true, payload: { appearance: "system" } };
    }));
    render(<DesktopSettingsPage />);
    fireEvent.click(within(screen.getByRole("navigation", { name: "设置" })).getByRole("button", { name: "快捷键" }));

    expect(await screen.findByTestId("native-keybindings-path")).toHaveTextContent(KEYBINDINGS_PATH);
    const input = screen.getByLabelText("中止当前回合 按键");
    expect(input).toHaveValue("escape");
    fireEvent.change(input, { target: { value: "ctrl+shift+x" } });
    fireEvent.click(within(input.closest("li") as HTMLElement).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(preferencesOp).toHaveBeenLastCalledWith({ op: "native/saveKeybinding", action: "app.interrupt", keys: ["ctrl+shift+x"] }));
    expect(await screen.findByText("已写入文件")).toBeInTheDocument();
    // The reload boundary and PiDock's own (non-Pi) shortcuts are stated, not implied.
    expect(screen.getByTestId("native-reload-boundary")).toHaveTextContent(RELOAD);
    const own = screen.getByRole("list", { name: "PiDock 快捷键" });
    expect(within(own).getByText("Esc")).toBeInTheDocument();
  });

  it("shows Pi's refusal by name instead of a saved-looking value", async () => {
    const preferencesOp = stubPreferences(vi.fn(async (request: Record<string, unknown>) => request["op"] === "native/read"
      ? { ok: true, payload: nativeView() }
      : { ok: false, error: "keybinding-invalid-syntax: hyper+x" }));
    render(<DesktopSettingsPage />);
    fireEvent.click(within(screen.getByRole("navigation", { name: "设置" })).getByRole("button", { name: "快捷键" }));
    const input = await screen.findByLabelText("中止当前回合 按键");
    fireEvent.change(input, { target: { value: "hyper+x" } });
    fireEvent.click(within(input.closest("li") as HTMLElement).getByRole("button", { name: "保存" }));
    expect(await screen.findByTestId("keybindings-error")).toHaveTextContent("keybinding-invalid-syntax: hyper+x");
    expect(preferencesOp).toHaveBeenLastCalledWith({ op: "native/saveKeybinding", action: "app.interrupt", keys: ["hyper+x"] });
  });

  it("names 不支持 / 未接线 with the real path and reason — never a blank placeholder", async () => {
    stubPreferences(vi.fn(async (request: Record<string, unknown>) => request["op"] === "native/read"
      ? { ok: true, payload: nativeView() }
      : { ok: true, payload: { appearance: "system" } }));
    render(<DesktopSettingsPage />);
    const nav = screen.getByRole("navigation", { name: "设置" });

    fireEvent.click(within(nav).getByRole("button", { name: "语言" }));
    const language = await screen.findByTestId("unsupported-language");
    expect(language).toHaveTextContent("不支持");
    expect(language).toHaveTextContent(SETTINGS_PATH);
    expect(language).toHaveTextContent("没有语言／locale 字段");
    // The only delivered UI language is named; no fabricated translation entry.
    expect(screen.getByRole("radio", { name: /简体中文/ })).toHaveAttribute("aria-checked", "true");
    expect(within(screen.getByRole("radiogroup", { name: "界面语言" })).getAllByRole("radio")).toHaveLength(1);

    fireEvent.click(within(nav).getByRole("button", { name: "通用" }));
    expect(await screen.findByTestId("general-agent-dir")).toHaveTextContent(AGENT_DIR);
    expect(await screen.findByTestId("unsupported-general")).toHaveTextContent("未接线");
    expect(screen.getByTestId("unsupported-general")).toHaveTextContent("selfUpdateCommand");
    // The wired external-editor setting lives here rather than in an empty pane.
    expect(screen.getByLabelText("外部编辑器程序")).toBeInTheDocument();
  });

  it("says it cannot read the native files outside the desktop shell", () => {
    render(<DesktopSettingsPage />);
    fireEvent.click(within(screen.getByRole("navigation", { name: "设置" })).getByRole("button", { name: "快捷键" }));
    expect(screen.getByRole("status")).toHaveTextContent("当前不在桌面壳内");
    expect(screen.queryByTestId("native-keybindings-path")).toHaveTextContent("未读取");
  });
});

describe("#149 return keeps context + compact layout", () => {
  it("leaves through the back entry and Esc, preserving the task name it was opened from", () => {
    const onBack = vi.fn();
    render(<DesktopSettingsPage taskName="真实任务" onBack={onBack} />);
    const back = screen.getByRole("button", { name: /返回任务工作区/ });
    expect(back).toHaveTextContent("真实任务");
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onBack).toHaveBeenCalledTimes(2);

    // Esc inside a field belongs to the field (blur), not to navigation.
    fireEvent.click(within(screen.getByRole("navigation", { name: "设置" })).getByRole("button", { name: "通用" }));
    const input = screen.getByLabelText("外部编辑器程序");
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onBack).toHaveBeenCalledTimes(2);
  });

  it("stays readable at the 720×560 minimum: stacked nav, scrolling content, no clipped previews", () => {
    render(<DesktopSettingsPage taskName="真实任务" onBack={() => {}} />);
    const nav = screen.getByRole("navigation", { name: "设置" });
    // Below 850px the 240px column becomes a full-width block and the content
    // scrolls instead of squeezing (the S06 tier).
    expect(nav.className).toContain("below-narrow:w-full");
    expect(nav.className).toContain("below-narrow:border-r-0");
    expect(screen.getByTestId("desktop-settings-page").querySelector(".overflow-auto")).not.toBeNull();
    const list = screen.getByRole("radiogroup", { name: "外观偏好" });
    expect(list.className).toContain("below-narrow:grid-cols-1");
    // Every option label stays in the DOM (nothing is hidden at the small tier).
    for (const option of APPEARANCE_OPTIONS) expect(screen.getByText(option.label)).toBeVisible();
  });
});
