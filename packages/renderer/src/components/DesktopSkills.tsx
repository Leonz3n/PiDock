import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addSkillSource,
  readSkillSources,
  removeSkillSource,
  setSkillSourceEnabled,
  SKILL_LOAD_BOUNDARY,
  skillSourceCounts,
  skillSourceStatusLabel,
  skillStatusLabel,
  type SkillEntryView,
  type SkillSourceScanView,
  type SkillSourcesView,
} from "../data/skillSources";
import type { PidockBridge } from "../data/shellBridge";

/**
 * [Pencil T16] Pencil T16 · S09 能力管理 → Skills.
 *
 * Every row is main's real-disk scan (`shell/skillsOp {op:"list"}`): a source
 * directory the user added, its named state (`ok` / `disabled` / `missing` /
 * `unreadable`), and the skills Pi's own loader found inside it with their
 * description, source path and supporting files. Nothing is a static card: an
 * empty list says so, a disappeared directory is named, and a `SKILL.md` the SDK
 * refused keeps an explicit invalid row instead of being dropped.
 *
 * The pane never mutates a running session. Adding, switching off or removing a
 * source only writes main's app-private list; the isolated context reads that
 * list when it creates a session, and Pi loads `SKILL.md` only for an explicit
 * request (the boundary line under the list states both).
 */

const BUTTON = "inline-flex min-h-6 items-center gap-1 rounded-[3px] border border-line bg-paper px-1.5 text-[10px] text-ink hover:bg-bg disabled:opacity-50";
const INPUT = "min-w-0 rounded-[3px] border border-line bg-paper px-1.5 py-1 font-mono text-[10px] text-ink outline-none focus:border-accent";
const SOURCE_TONE: Record<SkillSourceScanView["status"], string> = {
  ok: "border-line text-accent",
  disabled: "border-line text-muted",
  missing: "border-orange/45 text-orange",
  unreadable: "border-orange/45 text-orange",
};

function StatusBadge({ status, label }: { status: string; label: string }) {
  const tone = status in SOURCE_TONE ? SOURCE_TONE[status as SkillSourceScanView["status"]] : "border-line text-muted";
  return <span className={`shrink-0 rounded-[3px] border px-1 py-[1px] text-[9px] font-semibold ${tone}`}>{label}</span>;
}

function SkillRow({ entry, duplicateLabels, bridgeSource }: {
  entry: SkillEntryView;
  duplicateLabels: string[];
  bridgeSource: string;
}) {
  return (
    <li data-testid={`skill-row-${entry.key}`} className="grid gap-1 border-t border-line px-3 py-2 first:border-t-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <strong className="text-[11px] text-ink">{entry.name}</strong>
        <StatusBadge status={entry.status === "ok" ? "ok" : "unreadable"} label={skillStatusLabel(entry)} />
        {duplicateLabels.length > 0 ? (
          <span data-testid={`skill-duplicate-${entry.key}`} className="rounded-[3px] border border-[#dfc99f] px-1 py-[1px] text-[9px] text-[#9a6032]">
            重名 · 按来源区分：{duplicateLabels.join(" / ")}
          </span>
        ) : null}
      </div>
      <p className="text-[10px] text-muted">{entry.description || "（SKILL.md 未声明 description）"}</p>
      <dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-2 gap-y-[2px] text-[9px] text-[#8a94a2]">
        <dt>来源路径</dt>
        <dd data-testid={`skill-file-${entry.key}`} className="break-all font-mono">{entry.skillFile}</dd>
        <dt>技能目录</dt>
        <dd className="break-all font-mono">{entry.skillDir}</dd>
        <dt>资源文件</dt>
        <dd data-testid={`skill-resources-${entry.key}`}>
          {entry.resources.length === 0
            ? "无附带资源"
            : entry.resources.map((resource) => `${resource.path} (${resource.bytes} B)`).join("、" )}
        </dd>
      </dl>
      {entry.reason ? <p className="text-[10px] text-orange">无效原因：{entry.reason}</p> : null}
      <p className="text-[9px] text-muted">来源 {bridgeSource}</p>
    </li>
  );
}

export function DesktopSkills({ bridge }: { bridge?: PidockBridge }) {
  const [view, setView] = useState<SkillSourcesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);

  const apply = useCallback((reply: Awaited<ReturnType<typeof readSkillSources>>) => {
    if (!reply.ok || !reply.view) {
      setError(reply.error ?? "Skills 来源读取失败");
      return;
    }
    setError(null);
    setView(reply.view);
  }, []);

  useEffect(() => {
    let live = true;
    void readSkillSources(bridge).then((reply) => { if (live) apply(reply); });
    return () => { live = false; };
  }, [apply, bridge]);

  const run = useCallback(async (action: () => Promise<Awaited<ReturnType<typeof readSkillSources>>>) => {
    setBusy(true);
    try { apply(await action()); } finally { setBusy(false); }
  }, [apply]);

  const counts = useMemo(() => (view ? skillSourceCounts(view) : null), [view]);
  const sourcePathOf = (sourceId: string) => view?.sources.find((source) => source.id === sourceId)?.path ?? sourceId;

  return (
    <section data-testid="skills-pane" className="skills-pane grid gap-3 rounded-[8px] border border-line bg-paper px-[15px] py-[13px]">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="text-[12px] font-[550] text-ink">本地 Skills 来源</h3>
          <p className="text-[10px] text-muted">扫描真实磁盘目录；技能说明与来源路径来自 Pi 的加载结果，不是示例数据。</p>
        </div>
        <span data-testid="skills-counts" className="text-[10px] text-muted">
          {counts
            ? `${counts.sources} 个来源 · ${counts.enabled} 启用 · ${counts.broken} 异常 · ${counts.skills} 个技能 · ${counts.invalid} 无效${counts.duplicates > 0 ? ` · ${counts.duplicates} 重名` : ""}`
            : "读取中…"}
        </span>
      </header>

      <form
        className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 below-stack:grid-cols-1"
        onSubmit={(event) => {
          event.preventDefault();
          const value = path.trim();
          if (value.length === 0) return;
          void run(async () => {
            const reply = await addSkillSource(bridge, value);
            if (reply.ok) setPath("");
            return reply;
          });
        }}
      >
        <label className="grid gap-1">
          <span className="text-[10px] text-muted">添加本地来源目录（绝对路径）</span>
          <input
            data-testid="skills-add-path"
            className={INPUT}
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/Users/you/skills"
            aria-label="技能来源目录"
          />
        </label>
        <button data-testid="skills-add-submit" type="submit" className={`${BUTTON} self-end`} disabled={busy || path.trim().length === 0}>
          添加来源
        </button>
      </form>

      {error ? <p data-testid="skills-error" className="rounded-[4px] border border-orange/35 bg-orange/10 px-2 py-1 text-[10px] text-orange">{error}</p> : null}

      {view?.state === "invalid" ? (
        <p data-testid="skills-config-invalid" className="rounded-[4px] border border-orange/35 bg-orange/10 px-2 py-1 text-[10px] text-orange">
          技能来源配置无法读取（{view.message ?? "格式无效"}）。已保留原文件，不会用空白配置覆盖。
        </p>
      ) : null}

      {view !== null && view.sources.length === 0 && view.state !== "invalid" ? (
        <p data-testid="skills-empty" className="rounded-[4px] border border-dashed border-line px-2 py-3 text-[10px] text-muted">
          还没有添加本地技能来源。添加一个包含 SKILL.md 的目录后，这里显示真实扫描结果。
        </p>
      ) : null}

      <ul aria-label="本地技能来源" className="grid gap-2">
        {(view?.sources ?? []).map((source) => (
          <li key={source.id} data-testid={`skill-source-${source.id}`} className="rounded-[6px] border border-line bg-soft/40">
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <div className="min-w-0">
                <p className="break-all font-mono text-[11px] text-ink">{source.path}</p>
                <p className="text-[10px] text-muted">
                  {source.status === "ok" ? `${source.skills.length} 个技能` : source.message ?? skillSourceStatusLabel(source.status)}
                  {source.diagnostics.length > 0 ? ` · ${source.diagnostics.length} 条警告` : ""}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <StatusBadge status={source.status} label={skillSourceStatusLabel(source.status)} />
                <button data-testid={`skill-toggle-${source.id}`} type="button" className={BUTTON} disabled={busy}
                  onClick={() => void run(() => setSkillSourceEnabled(bridge, source.id, !source.enabled))}>
                  {source.enabled ? "停用" : "启用"}
                </button>
                <button data-testid={`skill-remove-${source.id}`} type="button" className={BUTTON} disabled={busy}
                  onClick={() => void run(() => removeSkillSource(bridge, source.id))}>
                  移除
                </button>
              </div>
            </div>
            {source.skills.length > 0 ? (
              <ul aria-label={`${source.path} 中的技能`} className="border-t border-line">
                {source.skills.map((entry) => (
                  <SkillRow
                    key={entry.key}
                    entry={entry}
                    duplicateLabels={entry.duplicates.map((key) => sourcePathOf(key.split("::")[0] ?? ""))}
                    bridgeSource={source.path}
                  />
                ))}
              </ul>
            ) : null}
            {source.status === "ok" && source.skills.length === 0 ? (
              <p className="border-t border-line px-3 py-2 text-[10px] text-muted">该目录下没有可加载的 SKILL.md。</p>
            ) : null}
          </li>
        ))}
      </ul>

      <p className="note text-[10px] leading-[1.9] text-[#939c9f]">{SKILL_LOAD_BOUNDARY}来源启停与变更只写入本机来源列表，技能不能扩大 Host 工具授权。</p>
    </section>
  );
}
