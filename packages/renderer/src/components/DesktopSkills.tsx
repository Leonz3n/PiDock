import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Field, FieldLabel } from "./ui/field";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addSkillSource,
  openSkillFile,
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

const SOURCE_TONE: Record<SkillSourceScanView["status"], string> = {
  ok: "border-line text-accent",
  disabled: "border-line text-muted",
  missing: "border-orange/45 text-orange",
  unreadable: "border-orange/45 text-orange",
};

function StatusBadge({ status, label }: { status: string; label: string }) {
  const tone = status in SOURCE_TONE ? SOURCE_TONE[status as SkillSourceScanView["status"]] : "border-line text-muted";
  return <Badge variant="outline" className={tone}>{label}</Badge>;
}

function SkillRow({ entry, duplicateLabels, bridgeSource, onOpen }: {
  entry: SkillEntryView;
  duplicateLabels: string[];
  bridgeSource: string;
  onOpen: () => void;
}) {
  return (
    <li data-testid={`skill-row-${entry.key}`} className="flex min-w-0 flex-col gap-1 rounded-md border border-line bg-sidebar px-3 py-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <strong className="text-[11px] text-accent">{entry.name}</strong>
        <StatusBadge status={entry.status === "ok" ? "ok" : "unreadable"} label={skillStatusLabel(entry)} />
        {duplicateLabels.length > 0 ? (
          <span data-testid={`skill-duplicate-${entry.key}`} title={duplicateLabels.join(" / ")} className="rounded-[3px] border border-attention/40 px-1 py-[1px] text-[9px] text-attention">
            重名 · 按来源区分
          </span>
        ) : null}

      </div>
      <p className="truncate text-[10px] text-muted" title={entry.description}>{entry.description || "（SKILL.md 未声明 description）"}</p>
      <p className="truncate font-mono text-[9px] text-muted" title={entry.skillFile}>路径：{entry.skillFile}</p>
      <details><summary className="cursor-pointer text-[10px] text-muted">来源与资源详情</summary>
        <Button size="sm" variant="outline" data-testid={`skill-open-${entry.key}`} type="button" onClick={onOpen}>
          打开 SKILL.md
        </Button>
      <dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-2 gap-y-[2px] text-[10px] text-muted">
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
      <p className="break-all text-[9px] text-muted">来源 {bridgeSource}</p>
      {duplicateLabels.length > 0 ? <p className="break-all text-[10px] text-attention">重名来源：{duplicateLabels.join(" / ")}</p> : null}
      </details>
    </li>
  );
}

export function DesktopSkills({ bridge, onCount }: { bridge?: PidockBridge; onCount?: (count: number | null) => void }) {
  const [view, setView] = useState<SkillSourcesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);

  const apply = useCallback((reply: Awaited<ReturnType<typeof readSkillSources>>) => {
    if (!reply.ok || !reply.view) {
      setView(null);
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

  const counts = useMemo(() => (view && view.state !== "invalid" ? skillSourceCounts(view) : null), [view]);
  useEffect(() => { onCount?.(view && view.state !== "invalid" ? skillSourceCounts(view).skills : null); }, [view, onCount]);
  const sourcePathOf = (sourceId: string) => view?.sources.find((source) => source.id === sourceId)?.path ?? sourceId;

  return (
    <section data-testid="skills-pane" className="skills-pane flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-[14px] font-semibold text-ink">Skills 本地技能库</h2>
          <p className="text-[10px] text-muted">管理本地来源中的 SKILL.md 与支持文件。</p>
        </div>
        <span data-testid="skills-counts" className="text-[10px] text-muted">
          {counts
            ? `${counts.sources} 个来源 · ${counts.enabled} 启用 · ${counts.broken} 异常 · ${counts.skills} 个技能 · ${counts.invalid} 无效${counts.duplicates > 0 ? ` · ${counts.duplicates} 重名` : ""}`
            : error || view?.state === "invalid" ? "读取失败 · 数量未知" : "读取中…"}
        </span>
      <Button type="button" size="sm" disabled={busy} onClick={() => void run(() => readSkillSources(bridge))}>重新扫描目录</Button>
      </div>

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
        <Field>
          <FieldLabel htmlFor="skill-source-path">添加本地来源目录（绝对路径）</FieldLabel>
          <Input
            id="skill-source-path"
            data-testid="skills-add-path"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/Users/you/skills"
            aria-label="技能来源目录"
          />
        </Field>
        <Button data-testid="skills-add-submit" type="submit" className="self-end" disabled={busy || path.trim().length === 0}>
          添加来源
        </Button>
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

      <ul aria-label="本地技能来源" className="grid grid-cols-2 items-start gap-3 below-narrow:grid-cols-1">
        {(view?.sources ?? []).map((source) => (
          <li key={source.id} data-testid={`skill-source-${source.id}`} className="rounded-lg border border-line bg-paper p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 flex-1 basis-[150px]">
                <p className="truncate font-mono text-[11px] text-ink" title={source.path}>{source.path}</p>
                <p className="text-[10px] text-muted">
                  {source.status === "ok" ? `${source.skills.length} 个技能` : source.message ?? skillSourceStatusLabel(source.status)}
                  {source.diagnostics.length > 0 ? ` · ${source.diagnostics.length} 条警告` : ""}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <StatusBadge status={source.status} label={skillSourceStatusLabel(source.status)} />
                <Button size="sm" variant="outline" data-testid={`skill-toggle-${source.id}`} type="button" disabled={busy}
                  onClick={() => void run(() => setSkillSourceEnabled(bridge, source.id, !source.enabled))}>
                  {source.enabled ? "停用" : "启用"}
                </Button>
                <Button size="sm" variant="outline" data-testid={`skill-remove-${source.id}`} type="button" disabled={busy}
                  onClick={() => void run(() => removeSkillSource(bridge, source.id))}>
                  移除
                </Button>
              </div>
            </div>
            {source.diagnostics.map((diagnostic, index) => <p key={index} className="mb-2 break-all text-[11px] text-attention">验证警告：{diagnostic.message}{diagnostic.path ? ` · ${diagnostic.path}` : ""}</p>)}
            {source.skills.length > 0 ? (
              <ul aria-label={`${source.path} 中的技能`} className="grid gap-3">
                {source.skills.map((entry) => (
                  <SkillRow
                    key={entry.key}
                    entry={entry}
                    duplicateLabels={entry.duplicates.map((key) => sourcePathOf(key.split("::")[0] ?? ""))}
                    bridgeSource={source.path}
                    onOpen={() => void run(() => openSkillFile(bridge, entry.key))}
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

      <p className="note text-[10px] leading-[1.9] text-muted">{SKILL_LOAD_BOUNDARY}来源启停与变更只写入本机来源列表，技能不能扩大 Host 工具授权。</p>
    </section>
  );
}
