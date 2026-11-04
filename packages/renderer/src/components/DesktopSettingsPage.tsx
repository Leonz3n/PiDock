import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  APPEARANCE_OPTIONS,
  PIDOCK_SHORTCUTS,
  appearanceModeLabel,
  appearancePreferenceLabel,
  nativePreferencesFromHost,
  preferencesAvailable,
  readNativePreferences,
  saveNativeKeybinding,
  type KeybindingView,
  type NativePreferencesView,
  type UnsupportedField,
} from "../data/preferences";
import { useAppearanceStore, watchSystemAppearance } from "../stores/appearance";
import {
  clearEditorSettings,
  editorSettingsAvailable,
  readEditorSettings,
  saveEditorSettings,
  type EditorSettingsView,
} from "../data/editorSettings";
import { Icon } from "./Icon";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { Separator } from "./ui/separator";

const field = "min-w-0 w-full border border-line bg-bg px-2 py-1 text-xs disabled:opacity-70";

/**
 * [Pencil T14] #149 设置 — its OWN nav destination (S11 `Pkb7d` light / `L28xKD`
 * dark), separate from 能力管理 (S03/S09).
 *
 * Structure follows the design: a 240px 应用偏好 nav with exactly four entries
 * (外观 / 快捷键 / 语言 / 通用), 外观 as the default pane, a back entry to the task
 * the user came from, and a footer card naming the current 外观 preference. The
 * content area is the whole window — this page replaces the workspace nav, and
 * returning keeps the task, session, draft, focus and scroll (the parent owns
 * that state; nothing here resets it).
 *
 * Honesty rules this page keeps:
 *
 * - 外观 is PiDock's own preference and applies instantly; it is NOT written to
 *   Pi's `settings.json` (which has no such field).
 * - 快捷键 edits exactly the Pi actions main verified, one keybinding per save,
 *   preserving every other byte of `keybindings.json`. The reload boundary is
 *   stated: Pi's file drives Pi's TUI, so a saved binding takes effect there on
 *   restart, and PiDock's own shortcuts are listed separately because a Pi
 *   binding cannot retarget them.
 * - 语言 names the one UI language PiDock actually ships and marks Pi's
 *   language/locale as 不支持 with the real settings path and the reason.
 * - 通用 keeps the wired 外部编辑器 setting and lists the real paths; fields
 *   PiDock does not support (selfUpdateCommand) are shown as 未接线 with why.
 *   There is no blank placeholder pane, and no Extensions / Computer Use /
 *   Browser entry anywhere in this nav.
 */

type Pane = "appearance" | "keybindings" | "language" | "general";

const NAV: { key: Pane; label: string; icon: "grid" | "key" | "globe" | "settings" }[] = [
  { key: "appearance", label: "外观", icon: "grid" },
  { key: "keybindings", label: "快捷键", icon: "key" },
  { key: "language", label: "语言", icon: "globe" },
  { key: "general", label: "通用", icon: "settings" },
];

const SECTION_TITLE = "text-[10px] font-bold uppercase tracking-[1.4px] text-muted";
const CARD = "rounded-[8px] border border-line bg-paper px-3 py-2.5";

export function DesktopSettingsPage({
  taskName = null,
  onBack,
}: {
  /** The task the user came from; returning restores it unchanged. */
  taskName?: string | null;
  onBack?: () => void;
}) {
  const [pane, setPane] = useState<Pane>("appearance");
  const close = useCallback(() => onBack?.(), [onBack]);

  // Esc is PiDock's OWN shortcut and is handled here, not by Pi's keybindings.
  // It is installed only while this page is mounted, so no other page inherits
  // it; the input fields keep their own Esc behaviour (blur) first.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  // Hydrate on open (the shell already did, so this is a no-op there) and keep
  // 跟随系统 live while the page is mounted: an OS appearance change repaints
  // without a save and without leaving the page.
  useEffect(() => {
    void useAppearanceStore.getState().hydrate();
    return watchSystemAppearance();
  }, []);

  const preference = useAppearanceStore((state) => state.preference);
  const resolved = useAppearanceStore((state) => state.resolved);

  return <div data-testid="desktop-settings-page" className="settings-window management-window flex h-screen min-h-0 w-full text-ink">
    <nav aria-label="设置" className="settings-nav flex w-[240px] shrink-0 flex-col border-r border-line bg-sidebar px-3 py-4 ">
      {onBack ? <button type="button" aria-label="返回任务工作区" onClick={close}
        className="mb-3 flex items-center gap-1.5 rounded-[6px] border border-line bg-paper px-2.5 py-1.5 text-left text-[11px] text-muted hover:text-ink">
        <span aria-hidden>←</span>
        <span className="min-w-0 truncate">返回任务工作区{taskName ? ` · ${taskName}` : ""}</span>
        <kbd className="ml-auto shrink-0 text-[10px] text-muted">Esc</kbd>
      </button> : null}
      <div className="flex items-center gap-2 px-1 py-2">
        <Icon name="settings-2" />
        <span className="text-[14px] font-semibold text-ink">设置</span>
      </div>
      <p className={`${SECTION_TITLE} px-1 pt-1`}>应用偏好</p>
      <ul className="mt-1 flex flex-col gap-1">{NAV.map((item) => <li key={item.key}>
        <button type="button" aria-current={pane === item.key ? "page" : undefined} onClick={() => setPane(item.key)}
          className={`flex w-full items-center gap-2 h-[30px] rounded-[7px] px-2.5 text-left text-[12px] ${pane === item.key ? "border border-accent bg-soft font-medium text-ink" : "border border-transparent text-muted hover:bg-paper hover:text-ink"}`}>
          <Icon name={item.icon} />
          <span>{item.label}</span>
        </button>
      </li>)}</ul>
      <div className="mt-auto rounded-md bg-bg p-2 text-[10px] leading-4 text-muted">
        <p className="font-medium text-ink">PiDock · 桌面外观</p>
        <p data-testid="settings-preference-card">当前偏好：{appearancePreferenceLabel(preference)}</p>
        <p>返回时保留当前任务</p>
      </div>
    </nav>
    <div className="settings-content min-w-0 flex-1 overflow-auto bg-bg">
      <header data-testid="management-header" className="flex h-[52px] shrink-0 items-center justify-between gap-2 border-b border-line bg-paper px-10 below-narrow:px-5">
        <h1 className="text-[14px] font-semibold text-ink">{[...NAV].find((item) => item.key === pane)?.label ?? "设置"}</h1>
        <p className="text-[11px] text-muted">{pane === "appearance"
          ? `${appearancePreferenceLabel(preference)} · 当前为${appearanceModeLabel(resolved)}`
          : pane === "keybindings" ? "Pi 原生快捷键（有界投影）"
          : pane === "language" ? "PiDock 界面语言"
          : "本机通用偏好"}</p>
      </header>
      <div className="settings-body px-12 py-10 below-narrow:px-5">
        {pane === "appearance" ? <AppearancePane /> : null}
        {pane === "keybindings" ? <KeybindingsPane /> : null}
        {pane === "language" ? <LanguagePane /> : null}
        {pane === "general" ? <GeneralPane /> : null}
      </div>
    </div>
  </div>;
}

function AppearancePane() {
  const preference = useAppearanceStore((state) => state.preference);
  const status = useAppearanceStore((state) => state.status);
  const readError = useAppearanceStore((state) => state.readError);
  const persistError = useAppearanceStore((state) => state.persistError);
  const setPreference = useAppearanceStore((state) => state.setPreference);

  return <section aria-label="外观" className="min-w-0">
    <h2 className="appearance-title">让工作界面适应当前光线</h2>
    <p className="mt-2 max-w-[620px] text-xs leading-6 text-muted">柔和的中性底色、清晰的文字层次，以及克制的雾蓝强调色。</p>
    <ToggleGroup type="single" role="radiogroup" aria-label="外观偏好" value={preference}
      className="appearance-options" spacing={1} onValueChange={(value) => { if (value) void setPreference(value as typeof preference); }}
      onKeyDown={(event) => {
        const offset = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
        if (!offset) return;
        event.preventDefault();
        const index = APPEARANCE_OPTIONS.findIndex((option) => option.mode === preference);
        const next = APPEARANCE_OPTIONS[(index + offset + APPEARANCE_OPTIONS.length) % APPEARANCE_OPTIONS.length];
        if (!next) return;
        void setPreference(next.mode);
        event.currentTarget.querySelector<HTMLElement>(`[data-appearance-option="${next.mode}"]`)?.focus();
      }}>
      {APPEARANCE_OPTIONS.map((option) => {
        const active = preference === option.mode;
        return <ToggleGroupItem key={option.mode} value={option.mode} role="radio" aria-checked={active}
          tabIndex={active ? 0 : -1} data-appearance-option={option.mode} className="appearance-option">
          <AppearancePreview mode={option.mode} />
          <span className="appearance-option-label">{option.label}<span aria-hidden className="appearance-radio">{active ? "✓" : ""}</span></span>
          <span className="appearance-description">{option.description}</span>
        </ToggleGroupItem>;
      })}
    </ToggleGroup>
    <p className="mt-4 flex items-center gap-2 text-[11px] text-muted">
      <Icon name="check" />
      选择后立即生效并自动保存，下次打开继续使用。
    </p>
    {status === "unavailable" ? <p role="status" className="mt-3 border border-line bg-soft px-3 py-2 text-[11px] text-muted">当前不在桌面壳内：外观只会在此次会话生效，不会写入应用偏好。</p> : null}
    {readError ? <p role="alert" className="mt-3 break-words border border-line bg-soft px-3 py-2 text-[11px] text-ink">外观偏好读取失败：{readError}</p> : null}
    {persistError ? <p role="alert" className="mt-3 break-words border border-line bg-soft px-3 py-2 text-[11px] text-ink">外观偏好保存失败：{persistError}（当前选择仅此次会话有效）</p> : null}
    <Separator className="appearance-divider" />
    <div className="appearance-status">
      <h3 className="text-[16px] font-semibold text-ink">清晰、安静的状态提示</h3>
      <ul className="mt-3 flex flex-wrap gap-3 text-[11px]">
        {[{ variant: "running", label: "运行中" }, { variant: "settled", label: "已完成" }, { variant: "attention", label: "等待确认" }, { variant: "danger", label: "执行失败" }].map((item) => (
          <li key={item.variant}><Badge variant={item.variant as "running" | "settled" | "attention" | "danger"}><span aria-hidden>•</span>{item.label}</Badge></li>
        ))}
      </ul>
      <p className="mt-3 max-w-[620px] text-[11px] leading-5 text-muted">状态同时使用文字与颜色表达；正文、路径与辅助信息在两种模式下保持清晰可读。</p>
    </div>
  </section>;
}

/** A miniature conversation rendered with the SAME tokens as the real shell. */
function AppearancePreview({ mode }: { mode: "light" | "dark" | "system" }) {
  const panel = (theme: "light" | "dark") => <span data-preview-theme={theme} data-theme={theme} className="appearance-preview-panel">
    <span className="appearance-preview-nav">{[0, 1, 2, 3].map((line) => <i key={line} />)}</span>
    <span className="appearance-preview-conversation"><span>任务对话</span><i /><i /><span className="appearance-preview-composer"><i /></span></span>
  </span>;
  return <span aria-hidden className="appearance-preview">
    {mode === "system" ? <>{panel("light")}{panel("dark")}</> : panel(mode)}
  </span>;
}

function useNativePreferences() {
  const connected = preferencesAvailable();
  const [view, setView] = useState<NativePreferencesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!connected) return;
    const result = await readNativePreferences();
    if (!result.ok) { setError(result.error); setView(null); return; }
    setView(result.value);
    setError(null);
  }, [connected]);
  useEffect(() => { void load(); }, [load]);
  const apply = useCallback((payload: unknown) => {
    const parsed = nativePreferencesFromHost(payload);
    if (parsed === undefined) { setError("invalid-payload: 原生配置响应无法解析"); return; }
    setView(parsed);
    setError(null);
  }, []);
  return { connected, view, error, setError, busy, setBusy, load, apply };
}

function KeybindingsPane() {
  const { connected, view, error, setError, busy, setBusy, apply } = useNativePreferences();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);

  const save = (row: KeybindingView) => {
    if (busy || !connected) return;
    const text = drafts[row.id] ?? row.keys.join(", ");
    const keys = text.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    setBusy(true);
    void (async () => {
      const result = await saveNativeKeybinding(row.id, keys);
      setBusy(false);
      if (!result.ok) { setError(result.error); setSaved(null); return; }
      apply(result.value);
      setSaved(row.id);
      setDrafts((current) => ({ ...current, [row.id]: keys.join(", ") }));
    })();
  };

  return <section aria-label="快捷键" className="min-w-0">
    <h2 className="text-[15px] font-semibold text-ink">Pi 的快捷键（由 Pi 管理）</h2>
    <p className="mt-2 max-w-[720px] text-xs leading-6 text-muted">
      下列动作来自 Pi 1.5.0 的 keybindings.json。PiDock 只改写你保存的那一个动作的按键值，文件里其他动作、$schema 与其他任何字段都按原字节保留。
    </p>
    <dl className="mt-3 grid min-w-0 max-w-[860px] grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px]">
      <dt className="text-muted">快捷键文件</dt>
      <dd data-testid="native-keybindings-path" className="min-w-0 break-all font-mono">{view?.keybindingsPath ?? (connected ? "读取中…" : "未读取")}</dd>
      <dt className="text-muted">Pi 配置目录</dt>
      <dd className="min-w-0 break-all font-mono">{view?.agentDir ?? "未读取"}</dd>
    </dl>
    {!connected ? <p role="status" className="mt-3 border border-line bg-soft px-3 py-2 text-[11px] text-muted">当前不在桌面壳内，无法读写 Pi 的 keybindings.json。</p> : null}
    {error ? <p role="alert" data-testid="keybindings-error" className="mt-3 break-words border border-line bg-soft px-3 py-2 text-[11px] text-ink">快捷键读取／保存失败：{error}</p> : null}
    {view?.keybindingsError ? <p role="alert" className="mt-3 break-words border border-line bg-soft px-3 py-2 text-[11px] text-ink">文件中有无法识别的按键值（已按 Pi 默认显示）：{view.keybindingsError}</p> : null}
    <ul className="mt-5 flex flex-col gap-2">
      {(view?.keybindings ?? []).map((row) => <li key={row.id} className={`${CARD} flex flex-wrap items-center gap-2`}>
        <span className="min-w-[180px] flex-1">
          <span className="block text-[12px] font-medium text-ink">{row.label}</span>
          <span className="block font-mono text-[10px] text-muted">{row.id} · 默认 {row.defaultKeys.length > 0 ? row.defaultKeys.join(" / ") : "未分配"}</span>
        </span>
        <label className="sr-only" htmlFor={`keybinding-${row.id}`}>{row.label} 按键</label>
        <input id={`keybinding-${row.id}`} className={`${field} max-w-[220px] font-mono`} value={drafts[row.id] ?? row.keys.join(", ")}
          onChange={(event) => setDrafts((current) => ({ ...current, [row.id]: event.target.value }))} />
        <Badge variant="outline" className="rounded-[4px]">{row.source === "custom" ? "已自定义" : "Pi 默认"}</Badge>
        <Button type="button" variant="outline" disabled={busy || !connected} onClick={() => save(row)}>保存</Button>
        {saved === row.id ? <span role="status" className="text-[10px] text-muted">已写入文件</span> : null}
      </li>)}
    </ul>
    <div className="mt-5 border-t border-line pt-4">
      <h3 className="text-[13px] font-semibold text-ink">重载边界</h3>
      <p data-testid="native-reload-boundary" className="mt-2 max-w-[720px] text-[11px] leading-5 text-muted">{view?.reloadBoundary ?? "正在读取 main 给出的重载说明…"}</p>
    </div>
    <div className="mt-5 border-t border-line pt-4">
      <h3 className="text-[13px] font-semibold text-ink">PiDock 自己的快捷键</h3>
      <p className="mt-2 max-w-[720px] text-[11px] leading-5 text-muted">下面这两项由 PiDock 的界面代码处理，不受 Pi 的 keybindings.json 影响，也不能在这里改写。</p>
      <ul aria-label="PiDock 快捷键" className="mt-1 flex flex-col gap-1 text-[11px]">
        {PIDOCK_SHORTCUTS.map((item) => <li key={item.keys} className="flex flex-wrap items-baseline gap-2">
          <kbd className="rounded-[4px] border border-line bg-soft px-1.5 py-0.5 font-mono text-[10px] text-ink">{item.keys}</kbd>
          <span className="text-muted">{item.label}</span>
        </li>)}
      </ul>
    </div>
  </section>;
}

function UnsupportedNotice({ field }: { field: UnsupportedField }) {
  return <div data-testid={`unsupported-${field.pane}`} className="mt-4 border border-line bg-soft px-3 py-2.5 text-[11px] leading-5">
    <p className="flex flex-wrap items-center gap-2">
      <Badge variant="outline" className="rounded-[4px]">{field.status === "unsupported" ? "不支持" : "未接线"}</Badge>
      <span className="font-mono text-ink">{field.field}</span>
    </p>
    <p className="mt-1 break-words text-muted">路径：<span className="font-mono">{field.path}</span></p>
    <p className="mt-1 text-muted">{field.reason}</p>
  </div>;
}

function LanguagePane() {
  const { connected, view, error } = useNativePreferences();
  const languageField = view?.unsupported.find((item) => item.pane === "language");
  return <section aria-label="语言" className="min-w-0">
    <h2 className="text-[15px] font-semibold text-ink">PiDock 界面语言</h2>
    <p className="mt-2 max-w-[720px] text-xs leading-6 text-muted">界面语言是 PiDock 自己的偏好。当前版本只交付了简体中文字符串，因此这里只有一项可选，不提供没有实际翻译的选项。</p>
    <div role="radiogroup" aria-label="界面语言" className="mt-4 max-w-[420px]">
      <div aria-checked="true" role="radio" className={`${CARD} flex items-center gap-2`}>
        <Icon name="globe" />
        <span className="text-[12px] font-medium text-ink">简体中文</span>
        <Badge variant="soft" className="ml-auto rounded-[4px]">当前</Badge>
      </div>
    </div>
    <p className="mt-3 max-w-[720px] text-[11px] leading-5 text-muted">英文等其它语言没有交付的界面字符串，切换不会改变任何文案，因此不列为可选项。</p>
    <div className="mt-8 border-t border-line pt-5">
      <h3 className="text-[13px] font-semibold text-ink">Pi 原生的语言设置</h3>
      <p className="mt-2 max-w-[720px] text-[11px] leading-5 text-muted">语言不是 Pi 的配置字段，所以这里没有可写的原生项：</p>
      {languageField ? <UnsupportedNotice field={languageField} /> : <p role="status" className="mt-3 text-[11px] text-muted">{connected ? "正在读取 Pi 的配置路径…" : "当前不在桌面壳内，无法读取 Pi 的配置路径。"}</p>}
      {error ? <p role="alert" className="mt-3 break-words text-[11px] text-ink">读取失败：{error}</p> : null}
    </div>
  </section>;
}

/**
 * 通用: the REAL settings this app wires (external editor) plus the paths main
 * actually resolves, and Pi's unsupported general fields named honestly.
 */
function GeneralPane() {
  const { connected, view, error } = useNativePreferences();
  const unsupported = view?.unsupported.filter((item) => item.pane === "general") ?? [];
  return <section aria-label="通用" className="min-w-0">
    <ExternalEditorSection />
    <div className="mt-8 border-t border-line pt-5">
      <h2 className="text-[13px] font-semibold text-ink">本机路径</h2>
      <dl className="mt-2 grid min-w-0 max-w-[860px] grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px]">
        <dt className="text-muted">Pi 配置目录</dt>
        <dd data-testid="general-agent-dir" className="min-w-0 break-all font-mono">{view?.agentDir ?? (connected ? "读取中…" : "未读取")}</dd>
        <dt className="text-muted">Pi settings.json</dt>
        <dd className="min-w-0 break-all font-mono">{view?.settingsPath ?? "未读取"}{view ? ` · ${view.settingsState === "missing" ? "尚未创建" : view.settingsState === "present" ? "已存在（只读）" : "无法解析（只读）"}` : ""}</dd>
        <dt className="text-muted">Pi keybindings.json</dt>
        <dd className="min-w-0 break-all font-mono">{view?.keybindingsPath ?? "未读取"}</dd>
      </dl>
      <p className="mt-2 text-[11px] text-muted">PiDock 只读 settings.json 以确认支持范围，从不改写它；需要修改请使用 Pi 自己的 /settings。</p>
      {unsupported.map((item) => <UnsupportedNotice key={item.field} field={item} />)}
      {error ? <p role="alert" className="mt-3 break-words text-[11px] text-ink">读取失败：{error}</p> : null}
    </div>
  </section>;
}

/**
 * [PiDock 10] (#15 box 28) 外部编辑器: the REAL settings surface for the program
 * 「用外部编辑器打开」 launches. Before this section existed the launch read a
 * machine-private document nothing in the app could write, so the box was only
 * reachable by hand-editing an app-private file.
 *
 * What the user may do here is exactly what main accepts: name a program (an
 * absolute path to an existing executable file) and its own extra arguments,
 * save them, or clear them. Main validates with the launch's own rules, probes
 * the program on disk, and writes its own document atomically — so an invalid
 * program is refused BY NAME here and the previous setting survives; the page
 * only ever shows main's answer, never a saved-looking draft.
 */
function ExternalEditorSection() {
  const connected = editorSettingsAvailable();
  const [settings, setSettings] = useState<EditorSettingsView | null>(null);
  // A failed read is its own state: the named refusal says WHY, and the fields
  // must stop claiming 「正在读取…」 that will never finish.
  const [readFailed, setReadFailed] = useState(false);
  const [program, setProgram] = useState("");
  const [args, setArgs] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((next: EditorSettingsView) => {
    setSettings(next);
    setProgram(next.program ?? "");
    setArgs(next.args.join("\n"));
  }, []);

  const load = useCallback(async () => {
    const result = await readEditorSettings();
    if (!result.ok) {
      setReadFailed(true);
      setError(result.error);
      return;
    }
    setReadFailed(false);
    setError(null);
    apply(result.settings);
  }, [apply]);

  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || !connected) return;
    setBusy(true);
    void (async () => {
      const extra = args
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const result = await saveEditorSettings(program.trim(), extra);
      setBusy(false);
      if (!result.ok) {
        // A refused save changed nothing: the draft stays so it can be fixed.
        setError(result.error);
        return;
      }
      setError(null);
      apply(result.settings);
    })();
  };

  const clear = () => {
    if (busy || !connected) return;
    setBusy(true);
    void (async () => {
      const result = await clearEditorSettings();
      setBusy(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      apply(result.settings);
    })();
  };

  return (
    <section aria-label="外部编辑器" className="min-w-0">
      <h2 className="text-[13px] font-semibold text-ink">外部编辑器</h2>
      <p className="mt-2 max-w-[720px] text-xs leading-6 text-muted">
        任务文件面板的「用外部编辑器打开」使用这里保存的程序。程序必须是本机可执行的绝对路径；保存时会先校验并在磁盘上确认可执行，未通过则不写入。
      </p>
      <form className="mt-3 max-w-[620px] flex flex-col gap-3" onSubmit={submit}>
        <div>
          <label className="text-xs text-muted" htmlFor="external-editor-program">外部编辑器程序</label>
          <input
            id="external-editor-program"
            className={`${field} mt-1`}
            value={program}
            maxLength={4096}
            disabled={!connected}
            placeholder="/绝对路径/编辑器"
            onChange={(event) => setProgram(event.target.value)}
          />
          <p className="mt-1 text-[11px] text-muted">macOS 上要填可执行文件本身（例如 /usr/local/bin/code）；.app 应用包目录会被拒绝。</p>
        </div>
        <div>
          <label className="text-xs text-muted" htmlFor="external-editor-args">附加参数（每行一项）</label>
          <textarea
            id="external-editor-args"
            className={`${field} mt-1 min-h-16 font-mono`}
            value={args}
            rows={2}
            disabled={!connected}
            onChange={(event) => setArgs(event.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={busy || !connected}>保存外部编辑器</Button>
          <Button type="button" variant="outline" disabled={busy || !connected} onClick={clear}>清除外部编辑器设置</Button>
          <span className="text-[10px] text-muted">不会读取、复制或生成任何编辑器配置（不写入 .vscode、launch.json、settings 或 tasks 文件）</span>
        </div>
      </form>
      <dl className="mt-3 grid min-w-0 max-w-[720px] grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px]">
        <dt className="text-muted">当前程序</dt>
        <dd className="min-w-0 break-all font-mono">
          {settings !== null
            ? settings.program ?? "未配置（打开外部编辑器会返回 editor-not-configured，且不启动任何程序）"
            : !connected ? "未读取" : readFailed ? "读取失败" : "正在读取…"}
        </dd>
        <dt className="text-muted">附加参数</dt>
        <dd className="min-w-0 break-all font-mono">{settings ? (settings.args.length ? settings.args.join(" ") : "无") : "未读取"}</dd>
        <dt className="text-muted">设置文件</dt>
        <dd className="min-w-0 break-all font-mono">{settings?.settingsPath ?? "未读取"}</dd>
      </dl>
      {!connected && (
        <p role="status" className="mt-3 border border-line bg-soft px-2 py-1.5 text-[11px] text-muted">
          当前不在桌面壳内，无法读写外部编辑器设置
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 break-words border border-line bg-soft px-2 py-1.5 text-[11px] text-ink">
          {error}
        </p>
      )}
    </section>
  );
}
