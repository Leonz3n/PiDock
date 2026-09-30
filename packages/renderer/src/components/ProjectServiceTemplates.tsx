import { useEffect, useRef, useState } from "react";
import { serviceCatalogThroughShell, shellBridge } from "../data/shellBridge";
import { serviceTemplatesFromMain, type ServiceTemplateView } from "../data/serviceCatalog";
import { Icon } from "./Icon";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

const runTypeLabel = { "long-lived": "常驻服务", "one-shot": "一次性命令", prepare: "准备步骤" } as const;
type RunType = keyof typeof runTypeLabel;
type Draft = { name: string; program: string; args: string[]; ports: string; runType: RunType; shared: { key: string; value: string }[] };
const emptyDraft = (): Draft => ({ name: "", program: "", args: [""], ports: "", runType: "long-lived", shared: [] });

/** Only explicit human creation is offered; scanned hints cannot populate this form. */
export function ProjectServiceTemplates({ projectId }: { projectId: string | null }) {
  const [rows, setRows] = useState<{ projectId: string; values: ServiceTemplateView[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [review, setReview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const epoch = useRef(0);
  const connected = typeof shellBridge()?.serviceCatalogOp === "function";
  const templates = rows?.projectId === projectId ? rows.values : null;

  useEffect(() => {
    let cancelled = false;
    const request = ++epoch.current;
    setRows(null);
    setError(null);
    setEditing(false);
    setDraft(emptyDraft());
    setReview(false);
    setSaving(false);
    setUncertain(false);
    if (!projectId || !connected) { setLoading(false); return; }
    setLoading(true);
    void serviceCatalogThroughShell({ op: "list", projectId }).then((response) => {
      if (cancelled || epoch.current !== request) return;
      setLoading(false);
      const parsed = response.ok ? serviceTemplatesFromMain(response.payload, projectId) : null;
      if (!parsed) { setError(response.ok ? "服务配方清单响应无法核对" : "服务配方清单读取失败"); return; }
      setRows({ projectId, values: parsed });
    });
    return () => { cancelled = true; };
  }, [projectId, connected]);

  const refresh = async () => {
    if (!projectId || loading) return;
    const request = ++epoch.current;
    setLoading(true);
    const response = await serviceCatalogThroughShell({ op: "list", projectId });
    if (epoch.current !== request) return;
    setLoading(false);
    const parsed = response.ok ? serviceTemplatesFromMain(response.payload, projectId) : null;
    if (!parsed) { setRows(null); setError("服务配方清单无法核对，请重试"); return; }
    setRows({ projectId, values: parsed });
    const duplicate = uncertain && parsed.some((row) => row.descriptor.name === draft.name.trim() &&
      row.descriptor.program === draft.program.trim() && row.descriptor.args.join("\0") === draft.args.filter(Boolean).join("\0") &&
      row.descriptor.ports.join(",") === draft.ports.split(",").map((part) => part.trim()).filter(Boolean).join(",") &&
      row.descriptor.runType === draft.runType);
    setError(duplicate ? "清单中已有相同模板，请关闭编辑核对" : null);
    setUncertain(duplicate);
    setReview(false);
  };

  const change = (next: Draft) => { setDraft(next); setReview(false); if (!uncertain) setError(null); };
  const close = () => { setEditing(false); setReview(false); setDraft(emptyDraft()); setError(null); setUncertain(false); };
  const validateDraft = () => {
    const args = draft.args.filter((arg) => arg.length > 0);
    const parts = draft.ports.trim() === "" ? [] : draft.ports.split(",").map((part) => part.trim());
    if (!draft.name.trim() || !draft.program.trim() || parts.some((part) => !/^[0-9]+$/.test(part) || Number(part) < 1 || Number(part) > 65535) ||
        draft.shared.some((row) => !row.key.trim() || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.key.trim()))) {
      setError("请核对名称、程序、端口和共享变量 KEY");
      return null;
    }
    return { descriptor: { name: draft.name.trim(), program: draft.program.trim(), args, ports: parts.map(Number), runType: draft.runType },
      shared: draft.shared.map((row) => ({ key: row.key.trim(), value: row.value, secret: false })) };
  };
  const save = async () => {
    if (!projectId || saving || !review || uncertain) return;
    const value = validateDraft();
    if (!value) { setReview(false); return; }
    const request = epoch.current;
    setSaving(true);
    setError(null);
    const response = await serviceCatalogThroughShell({ op: "create", projectId, ...value });
    if (epoch.current !== request) return;
    setSaving(false);
    const created = response.ok ? serviceTemplatesFromMain([response.payload], projectId)?.[0] : null;
    if (!created || created.version !== 1 || created.descriptor.name !== value.descriptor.name ||
        created.descriptor.program !== value.descriptor.program || created.descriptor.args.join("\0") !== value.descriptor.args.join("\0") ||
        created.descriptor.ports.join(",") !== value.descriptor.ports.join(",") || created.descriptor.runType !== value.descriptor.runType ||
        created.sharedKeys.join("\0") !== value.shared.map((row) => row.key).join("\0")) {
      setUncertain(true);
      setReview(false);
      setError("保存结果无法确认，请刷新清单后核对");
      return;
    }
    setRows((current) => current?.projectId === projectId ? { projectId, values: [...current.values, created] } : current);
    close();
  };

  return <section className="mt-8" aria-label="服务启动配方">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-semibold">服务启动配方 <Badge variant="soft" className="ml-1">运行未接线</Badge></h2>
      <div className="flex flex-wrap gap-1"><Button type="button" size="icon" variant="ghost" aria-label="刷新服务配方" title="刷新服务配方" disabled={!projectId || !connected || loading || saving} onClick={() => void refresh()}><Icon name="refresh" /></Button><Button type="button" size="sm" variant="outline" disabled={!projectId || !connected || loading || templates === null || editing} onClick={() => { setEditing(true); setError(null); }}><Icon name="plus" />添加服务</Button></div>
    </div>
    {!editing && error && <p role="alert" className="mt-3 text-xs text-[#ad4545]">{error}</p>}
    {!editing && templates === null && <p role="status" className="mt-3 border-t border-line py-5 text-xs text-muted">{loading ? "正在读取服务配方" : !connected ? "服务配方目录未接线" : !projectId ? "尚无项目上下文" : error ? "服务配方清单不可读取" : "正在核对项目"}</p>}
    {!editing && templates?.length === 0 && <p className="mt-3 border-t border-line py-5 text-xs text-muted">该项目尚未保存服务模板。</p>}
    {!editing && templates?.map((row) => <div key={row.serviceId} className="flex min-w-0 flex-wrap items-start justify-between gap-2 border-t border-line py-3 text-xs">
      <div className="min-w-0"><strong className="break-words font-medium">{row.descriptor.name}</strong><span className="ml-2 text-muted">v{row.version} · {runTypeLabel[row.descriptor.runType]}</span>
        <p className="mt-1 break-all text-muted">{[row.descriptor.program, ...row.descriptor.args].join(" ")}</p>
        {!!row.sharedKeys.length && <p className="mt-1 break-all text-muted">共享变量：{row.sharedKeys.join("、")}</p>}
      </div><span className="text-muted">未绑定任务</span>
    </div>)}
    {editing && <div className="mt-3 border-t border-line pt-3 text-xs">
      <div className="flex items-center justify-between"><h3 className="font-medium">新建共享模板</h3><Button type="button" size="icon" variant="ghost" aria-label="关闭编辑" title="关闭编辑" disabled={saving} onClick={close}><Icon name="close" /></Button></div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1">服务名称<input aria-label="服务名称" className="min-h-8 min-w-0 rounded-[4px] border border-line bg-paper px-2" value={draft.name} maxLength={128} onChange={(event) => change({ ...draft, name: event.target.value })} /></label>
        <label className="grid gap-1">程序名<input aria-label="程序名" className="min-h-8 min-w-0 rounded-[4px] border border-line bg-paper px-2" value={draft.program} maxLength={128} onChange={(event) => change({ ...draft, program: event.target.value })} /></label>
        <label className="grid gap-1">端口<input aria-label="端口" title="多个端口以逗号分隔" className="min-h-8 min-w-0 rounded-[4px] border border-line bg-paper px-2" value={draft.ports} onChange={(event) => change({ ...draft, ports: event.target.value })} /></label>
        <label className="grid gap-1">运行类型<select aria-label="运行类型" className="min-h-8 rounded-[4px] border border-line bg-paper px-2" value={draft.runType} onChange={(event) => change({ ...draft, runType: event.target.value as RunType })}>{Object.entries(runTypeLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      </div>
      <div className="mt-3 flex items-center justify-between"><span>参数</span><Button type="button" size="icon" variant="ghost" aria-label="添加参数" title="添加参数" disabled={draft.args.length >= 40} onClick={() => change({ ...draft, args: [...draft.args, ""] })}><Icon name="plus" /></Button></div>
      {draft.args.map((arg, index) => <div key={index} className="mb-2 flex gap-2"><input aria-label={`参数 ${index + 1}`} className="min-h-8 min-w-0 flex-1 rounded-[4px] border border-line bg-paper px-2" value={arg} onChange={(event) => change({ ...draft, args: draft.args.map((item, at) => at === index ? event.target.value : item) })} /><Button type="button" size="icon" variant="ghost" aria-label={`移除参数 ${index + 1}`} title="移除参数" onClick={() => change({ ...draft, args: draft.args.filter((_, at) => at !== index) })}><Icon name="close" /></Button></div>)}
      <div className="mt-3 flex items-center justify-between"><span>共享变量</span><Button type="button" size="icon" variant="ghost" aria-label="添加共享变量" title="添加共享变量" disabled={draft.shared.length >= 80} onClick={() => change({ ...draft, shared: [...draft.shared, { key: "", value: "" }] })}><Icon name="plus" /></Button></div>
      {draft.shared.map((row, index) => <div key={index} className="mb-2 flex min-w-0 gap-2"><input aria-label={`共享变量 KEY ${index + 1}`} className="min-h-8 min-w-0 w-2/5 rounded-[4px] border border-line bg-paper px-2" value={row.key} onChange={(event) => change({ ...draft, shared: draft.shared.map((item, at) => at === index ? { ...item, key: event.target.value } : item) })} /><input aria-label={`共享变量 VALUE ${index + 1}`} className="min-h-8 min-w-0 flex-1 rounded-[4px] border border-line bg-paper px-2" value={row.value} onChange={(event) => change({ ...draft, shared: draft.shared.map((item, at) => at === index ? { ...item, value: event.target.value } : item) })} /><Button type="button" size="icon" variant="ghost" aria-label={`移除共享变量 ${index + 1}`} title="移除共享变量" onClick={() => change({ ...draft, shared: draft.shared.filter((_, at) => at !== index) })}><Icon name="close" /></Button></div>)}
      {error && <p role="alert" className="my-2 text-[#ad4545]">{error}</p>}
      {review && <p role="status" className="mt-3 border-t border-line py-2 text-muted">待保存：{draft.name} · {runTypeLabel[draft.runType]} · {draft.shared.map((row) => row.key).join("、") || "无共享变量"}</p>}
      <div className="mt-3 flex justify-end gap-2"><Button type="button" size="sm" variant="ghost" disabled={saving} onClick={close}>取消</Button><Button type="button" size="sm" disabled={saving || uncertain || loading || templates === null} onClick={() => { if (review) void save(); else if (validateDraft()) { setError(null); setReview(true); } }}>{saving ? "正在保存" : review ? "确认保存" : "核对保存"}</Button></div>
    </div>}
  </section>;
}
