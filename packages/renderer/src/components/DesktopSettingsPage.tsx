import { useCallback, useEffect, useState, type FormEvent } from "react";
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

const field = "min-w-0 w-full border border-line bg-bg px-2 py-1 text-xs disabled:opacity-70";

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
  // Outside the desktop shell there is nothing to read or write, so the section
  // says so directly instead of pretending to load a setting.
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
    <section className="border-t border-line pt-5" aria-label="外部编辑器">
      <h2 className="text-sm font-semibold text-ink">外部编辑器</h2>
      <p className="mt-2 text-xs text-muted">
        任务文件面板的「用外部编辑器打开」使用这里保存的程序。程序必须是本机可执行的绝对路径；保存时会先校验并在磁盘上确认可执行，未通过则不写入。
      </p>
      <form className="mt-3 space-y-3" onSubmit={submit}>
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
      <dl className="mt-3 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px]">
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
        <p role="status" className="mt-3 border border-line bg-paper px-2 py-1.5 text-[11px] text-muted">
          当前不在桌面壳内，无法读写外部编辑器设置
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 break-words border border-[#e0b4b4] bg-[#fdf3f3] px-2 py-1.5 text-[11px] text-[#8a3b3b]">
          {error}
        </p>
      )}
    </section>
  );
}

/** Production settings structure; the Host exposes no authoritative settings read/write API for the default task root. */
export function DesktopSettingsPage() {
  return <div data-testid="desktop-settings-page" className="px-[34px] py-[30px] below-narrow:px-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="text-[10px] uppercase tracking-[1.8px] text-[#95979c]">Local Settings</p><h1 className="mt-1.5 text-[26px] font-semibold text-ink">本机设置</h1></div>
      <Badge variant="soft">外部编辑器已接线</Badge>
    </div>
    <div className="mt-6 max-w-[620px] space-y-6">
      <section className="border-t border-line pt-5" aria-label="应用配置目录">
        <h2 className="text-sm font-semibold text-ink">应用配置目录</h2>
        <p className="mt-2 text-xs text-muted">Host 尚未提供权威配置路径。这里不展示原型中的示意路径。</p>
        <div className="mt-3 flex min-h-10 items-center border border-line bg-paper px-3 text-xs text-muted">未接线</div>
      </section>
      <ExternalEditorSection />
      <section className="border-t border-line pt-5" aria-label="默认任务根目录">
        <h2 className="text-sm font-semibold text-ink">默认任务根目录</h2>
        <p className="mt-2 text-xs text-muted">此设置仅影响后续创建的任务；已有任务不会迁移。当前 Host 尚未提供该设置的读取、目录校验或保存操作。</p>
        <div className="mt-3 flex flex-wrap gap-2"><input aria-label="默认任务根目录" disabled placeholder="默认任务根目录未接线" className="min-h-9 min-w-0 flex-1 rounded-[4px] border border-line bg-paper px-3 text-xs text-muted disabled:opacity-70" /><Button type="button" variant="outline" disabled title="Host 尚无默认任务根选择接口"><Icon name="folder" />选择目录</Button></div>
      </section>
      <div className="flex justify-end border-t border-line pt-5"><Button type="button" disabled title="Host 尚无本机设置保存接口">保存设置</Button></div>
    </div>
  </div>;
}
