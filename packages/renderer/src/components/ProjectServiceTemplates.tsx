import { useEffect, useRef, useState } from "react";
import { serviceCatalogThroughShell, shellBridge } from "../data/shellBridge";
import {
  serviceTemplateUpdateFromMain,
  serviceTemplatesFromMain,
  sharedRowsForCatalog,
  type ServiceDependencyKind,
  type ServiceTemplateUpdateReviewView,
  type ServiceTemplateView,
} from "../data/serviceCatalog";
import type { ServiceImportHintView } from "../data/serviceImportHints";
import { servicePortsFromDraft, validateServiceTemplateDraft, type ServiceHealthKind } from "../data/serviceTemplateRules";
import { shellFailure } from "../data/taskServices";
import { Icon } from "./Icon";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { TaskServiceBinding } from "./TaskServiceBinding";

const runTypeLabel = { "long-lived": "常驻服务", "one-shot": "一次性命令", prepare: "准备步骤" } as const;
type RunType = keyof typeof runTypeLabel;
const healthKindLabel = { "": "不设置", http: "HTTP", tcp: "TCP", grpc: "gRPC" } as const;
type HealthKind = keyof typeof healthKindLabel;
/** The two dependency kinds, named as the spec names them (服务调用依赖 / 启动前置条件). */
const dependencyKindLabel = { call: "调用依赖", prestart: "启动前置" } as const satisfies Record<ServiceDependencyKind, string>;

interface Draft {
  name: string;
  program: string;
  args: string[];
  ports: string;
  runType: RunType;
  healthKind: HealthKind;
  healthTarget: string;
  /** Repo-relative working directory; empty means the repository root. */
  workdir: string;
  shared: { key: string; value: string }[];
  /**
   * The revision's 服务依赖声明 (ADR 0002). Empty is the honest "no declaration":
   * the save then sends no `dependencies` key at all and the plan keeps no edge.
   */
  dependencies: { to: string; kind: ServiceDependencyKind }[];
}
/** Editing an existing revision: its identity plus the version the page last read. */
type EditTarget = { serviceId: string; version: number };

const emptyDraft = (): Draft => ({ name: "", program: "", args: [""], ports: "", runType: "long-lived",
  healthKind: "", healthTarget: "", workdir: "", shared: [], dependencies: [] });

const draftFromTemplate = (row: ServiceTemplateView): Draft => ({
  name: row.descriptor.name,
  program: row.descriptor.program,
  args: row.descriptor.args.length > 0 ? [...row.descriptor.args] : [""],
  ports: row.descriptor.ports.join(", "),
  runType: row.descriptor.runType,
  healthKind: row.descriptor.healthCheck?.kind ?? "",
  healthTarget: row.descriptor.healthCheck?.target ?? "",
  workdir: row.descriptor.workdir ?? "",
  shared: row.shared.map((entry) => ({ key: entry.key, value: entry.value })),
  dependencies: (row.dependencies ?? []).map((dependency) => ({ ...dependency })),
});

/**
 * A scanned draft fills the form as candidates; empty fields stay visible for
 * review. A candidate the Host could not classify keeps that conservative
 * `one-shot` instead of the form's own default, and the notes say why.
 */
const draftFromHint = (hint: ServiceImportHintView): Draft => ({
  ...emptyDraft(),
  name: hint.name,
  program: hint.program,
  args: hint.args.length > 0 ? [...hint.args] : [""],
  runType: hint.runType ?? "long-lived",
  workdir: hint.workdir ?? "",
});

/**
 * The environment page's shared-template half ([PiDock 04] #7): the human
 * editing surface for the project's shared service templates, wired to the
 * real main-owned catalog - `shell/serviceCatalogOp {op:"list"|"create"|
 * "update"}`. Nothing here is a renderer-only store and nothing here starts a
 * process: a save writes one new revision, an edit of an existing revision is
 * reviewed by main (`diffServiceTemplate` rows + the pinned bindings that must
 * be restarted) before the page confirms it, and start/stop lives in the task
 * run panel behind the platform gate.
 *
 * A repository import hint can fill this form through one explicit human
 * action; a hint never saves, creates or binds anything, a
 * configuration-only hint cannot be applied as a run unit, and the form shows
 * each variable's source with its masked value - no value read from the
 * repository is ever written into the shared template.
 */
export function ProjectServiceTemplates({ projectId, environmentId, environmentName, tasks = [], fillFrom = null, onFillApplied }: {
  projectId: string | null;
  /**
   * The environment whose shared templates this surface edits. Required: a
   * template revision belongs to one environment, so with none selected the
   * section stays unloaded and says so instead of showing a project-wide list
   * that could be read as "the selected environment's".
   */
  environmentId: string | null;
  /** Display name of the selected environment; shown beside a binding so no page infers one. */
  environmentName?: string;
  tasks?: readonly { taskId: string; name: string }[];
  fillFrom?: ServiceImportHintView | null;
  /** Called with the hint only after the form really filled, so no caller announces a refused fill. */
  onFillApplied?: (applied: ServiceImportHintView) => void;
}) {
  const [rows, setRows] = useState<{ projectId: string; environmentId: string; values: ServiceTemplateView[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [review, setReview] = useState(false);
  const [update, setUpdate] = useState<ServiceTemplateUpdateReviewView | null>(null);
  const [saving, setSaving] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [fillNotes, setFillNotes] = useState<{ source: string; notes: string[] } | null>(null);
  const [bindingId, setBindingId] = useState<string | null>(null);
  const epoch = useRef(0);
  const appliedFill = useRef<ServiceImportHintView | null>(null);
  const fillApplied = useRef(onFillApplied);
  fillApplied.current = onFillApplied;
  const connected = typeof shellBridge()?.serviceCatalogOp === "function";
  const templates = rows?.projectId === projectId && rows.environmentId === environmentId ? rows.values : null;

  useEffect(() => {
    let cancelled = false;
    const request = ++epoch.current;
    setRows(null);
    setError(null);
    setEditing(false);
    setEditTarget(null);
    setDraft(emptyDraft());
    setReview(false);
    setUpdate(null);
    setSaving(false);
    setUncertain(false);
    setFillNotes(null);
    setBindingId(null);
    if (!projectId || !environmentId || !connected) { setLoading(false); return; }
    setLoading(true);
    void serviceCatalogThroughShell({ op: "list", projectId, environmentId }).then((response) => {
      if (cancelled || epoch.current !== request) return;
      setLoading(false);
      const parsed = response.ok ? serviceTemplatesFromMain(response.payload, projectId, environmentId) : null;
      if (!parsed) { setError(response.ok ? "服务配方清单响应无法核对" : shellFailure(response, "服务配方清单读取失败")); return; }
      setRows({ projectId, environmentId, values: parsed });
    });
    return () => { cancelled = true; };
  }, [projectId, environmentId, connected]);

  // One explicit human action carries a scanned draft into the form. It only
  // fills fields: no request, no save and no binding happens here, and a
  // configuration-only hint (runType === null) is refused as a run unit.
  useEffect(() => {
    if (!fillFrom) { appliedFill.current = null; return; }
    if (appliedFill.current === fillFrom) return;
    appliedFill.current = fillFrom;
    if (fillFrom.runType === null) {
      setError("该草案仅为配置来源（如 .env），不能作为运行单元填入服务模板");
      return;
    }
    if (!projectId || !environmentId || !connected) {
      // Named in the order of what really blocks the fill: the missing
      // capability first, then the two selection preconditions.
      setError(!connected ? "服务配方目录未接线，无法填入新建模板"
        : !projectId ? "尚无项目上下文，无法填入新建模板"
          : "尚未选择环境，无法填入新建模板");
      return;
    }
    setEditing(true);
    setEditTarget(null);
    setDraft(draftFromHint(fillFrom));
    setReview(false);
    setUpdate(null);
    setUncertain(false);
    setError(null);
    setFillNotes({ source: `${fillFrom.source} · ${fillFrom.name}`,
      notes: [`运行类型为草案判断：${runTypeLabel[fillFrom.runType]}（依据：${fillFrom.runTypeBasis}）；请核对后再保存`,
        ...(fillFrom.runTypeUncertain ? ["该草案未给出可判定的启动命令，已按最保守的一次性命令填入；请人工选择运行类型"] : []),
        ...fillFrom.variables.map((row) => `变量 ${row.key}（来源 ${row.source}）：${row.maskedValue}，仅显示遮蔽值，未写入共享模板`),
        ...fillFrom.invalidVars.map((key) => `无效变量：${key}`), ...fillFrom.toVerify] });
    fillApplied.current?.(fillFrom);
  }, [fillFrom, projectId, environmentId, connected]);

  const refresh = async () => {
    if (!projectId || !environmentId || loading) return;
    const request = ++epoch.current;
    setLoading(true);
    const response = await serviceCatalogThroughShell({ op: "list", projectId, environmentId });
    if (epoch.current !== request) return;
    setLoading(false);
    const parsed = response.ok ? serviceTemplatesFromMain(response.payload, projectId, environmentId) : null;
    if (!parsed) { setRows(null); setError("服务配方清单无法核对，请重试"); return; }
    setRows({ projectId, environmentId, values: parsed });
    const duplicate = uncertain && parsed.some((row) => row.descriptor.name === draft.name.trim() &&
      row.descriptor.program === draft.program.trim() && row.descriptor.args.join("\0") === draft.args.filter(Boolean).join("\0") &&
      row.descriptor.ports.join(",") === draft.ports.split(",").map((part) => part.trim()).filter(Boolean).join(",") &&
      row.descriptor.runType === draft.runType);
    setError(duplicate ? "清单中已有相同模板，请关闭编辑核对" : null);
    setUncertain(duplicate);
    setReview(false);
    setUpdate(null);
  };

  const change = (next: Draft) => { setDraft(next); setReview(false); setUpdate(null); if (!uncertain) setError(null); };
  const close = () => { setEditing(false); setEditTarget(null); setReview(false); setUpdate(null); setDraft(emptyDraft()); setError(null); setUncertain(false); setFillNotes(null); };
  const openCreate = () => { setEditing(true); setEditTarget(null); setDraft(emptyDraft()); setReview(false); setUpdate(null); setError(null); setFillNotes(null); };
  const openEdit = (row: ServiceTemplateView) => { setEditing(true); setEditTarget({ serviceId: row.serviceId, version: row.version });
    setDraft(draftFromTemplate(row)); setReview(false); setUpdate(null); setError(null); setUncertain(false); setFillNotes(null); };

  /** The exact request value, or the rules layer's own refusal message. */
  const buildValue = () => {
    const parsedPorts = servicePortsFromDraft(draft.ports);
    if ("error" in parsedPorts) { setError(parsedPorts.error.message); return null; }
    // A declaration needs a target this environment really has: a row without one
    // is refused HERE by name instead of being sent as an empty graph.
    const dependencies = draft.dependencies.map((row) => ({ to: row.to, kind: row.kind }));
    if (dependencies.some((row) => row.to === "")) {
      setError("服务依赖声明缺少目标服务，请选择本环境已保存的其他服务");
      return null;
    }
    const healthCheck = draft.healthKind === ""
      ? undefined
      : { kind: draft.healthKind as ServiceHealthKind, ...(draft.healthTarget.trim() === "" ? {} : { target: draft.healthTarget.trim() }) };
    const workdir = draft.workdir.trim() === "" ? undefined : draft.workdir;
    const candidate = { name: draft.name, program: draft.program, args: draft.args.filter((arg) => arg.length > 0), ports: parsedPorts.ports,
      runType: draft.runType, ...(healthCheck === undefined ? {} : { healthCheck }), ...(workdir === undefined ? {} : { workdir }),
      shared: draft.shared.map((row) => ({ key: row.key, value: row.value })) };
    const invalid = validateServiceTemplateDraft(candidate);
    if (invalid) { setError(invalid.message); return null; }
    return { descriptor: { name: candidate.name.trim(), program: candidate.program.trim(), args: candidate.args, ports: candidate.ports,
        runType: candidate.runType, ...(healthCheck === undefined ? {} : { healthCheck }), ...(workdir === undefined ? {} : { workdir: workdir.trim() }) },
      shared: sharedRowsForCatalog(candidate.shared),
      // No declaration => no `dependencies` key at all: the request keeps the
      // shape it had before this slice carried one, and no edge is implied.
      ...(dependencies.length === 0 ? {} : { dependencies }) };
  };

  /** The template the confirmed save must produce, or null when the list moved under us. */
  const nextVersionOf = (target: EditTarget) => {
    const current = templates?.find((row) => row.serviceId === target.serviceId);
    return current && current.version === target.version ? current.version + 1 : null;
  };

  /**
   * The services this revision may declare a dependency on: the environment's
   * OTHER services, by the catalog's own identity. The page never invents a
   * target and never offers a self-edge.
   */
  const dependencyTargets = (templates ?? []).filter((row) => row.serviceId !== editTarget?.serviceId);
  /** The name of a declared target (the raw service id when no row can name it - never an invented name). */
  const dependencyTargetName = (serviceId: string) =>
    templates?.find((row) => row.serviceId === serviceId)?.descriptor.name ?? serviceId;
  /** The next (target, kind) pair nobody has declared yet; undefined means there is nothing left to add. */
  const nextDependency = dependencyTargets
    .flatMap((row) => (["call", "prestart"] as ServiceDependencyKind[]).map((kind) => ({ to: row.serviceId, kind })))
    .find((candidate) => !draft.dependencies.some((row) => row.to === candidate.to && row.kind === candidate.kind));

  /** True when a projected row is exactly the revision the page asked main to write. */
  const matchesValue = (row: ServiceTemplateView, value: { descriptor: ServiceTemplateView["descriptor"]; shared: { key: string; value: string }[]; dependencies?: { to: string; kind: ServiceDependencyKind }[] }) =>
    row.descriptor.name === value.descriptor.name && row.descriptor.program === value.descriptor.program &&
    row.descriptor.args.join("\0") === value.descriptor.args.join("\0") &&
    row.descriptor.ports.join(",") === value.descriptor.ports.join(",") &&
    row.descriptor.runType === value.descriptor.runType &&
    JSON.stringify(row.descriptor.healthCheck ?? null) === JSON.stringify(value.descriptor.healthCheck ?? null) &&
    (row.descriptor.workdir ?? "") === (value.descriptor.workdir ?? "") &&
    JSON.stringify(row.shared) === JSON.stringify(value.shared.map((entry) => ({ key: entry.key, value: entry.value }))) &&
    JSON.stringify(row.dependencies ?? []) === JSON.stringify(value.dependencies ?? []);

  const createTemplate = async (targetProjectId: string, targetEnvironmentId: string) => {
    const value = buildValue();
    if (!value) { setReview(false); return; }
    const request = epoch.current;
    setSaving(true);
    setError(null);
    const response = await serviceCatalogThroughShell({ op: "create", projectId: targetProjectId, environmentId: targetEnvironmentId, ...value });
    if (epoch.current !== request) return;
    setSaving(false);
    const created = response.ok ? serviceTemplatesFromMain([response.payload], targetProjectId, targetEnvironmentId)?.[0] : null;
    if (!created || created.version !== 1 || !matchesValue(created, value)) {
      setUncertain(true);
      setReview(false);
      setError("保存结果无法确认，请刷新清单后核对");
      return;
    }
    setRows((current) => current?.projectId === targetProjectId && current.environmentId === targetEnvironmentId
      ? { projectId: targetProjectId, environmentId: targetEnvironmentId, values: [...current.values, created] } : current);
    close();
  };

  /** Step one of an edit: main reviews the revision without writing it. */
  const reviewUpdate = async (targetProjectId: string, targetEnvironmentId: string, target: EditTarget) => {
    const expected = nextVersionOf(target);
    if (expected === null) { setError("清单中的模板版本已变化，请刷新核对"); return; }
    const value = buildValue();
    if (!value) return;
    const request = epoch.current;
    setSaving(true);
    setError(null);
    const response = await serviceCatalogThroughShell({ op: "update", projectId: targetProjectId, environmentId: targetEnvironmentId,
      serviceId: target.serviceId, expectedVersion: target.version, ...value, confirm: false });
    if (epoch.current !== request) return;
    setSaving(false);
    const reviewed = response.ok
      ? serviceTemplateUpdateFromMain(response.payload, { projectId: targetProjectId, environmentId: targetEnvironmentId,
        serviceId: target.serviceId, version: expected })
      : null;
    if (!reviewed || reviewed.saved) {
      setUncertain(true);
      setError(response.ok ? "差异回执无法核对，请刷新清单后核对" : response.error ?? "差异核对失败，请重试");
      return;
    }
    setUpdate(reviewed);
    setReview(true);
  };

  /** Step two: the confirmed write, verified against the reviewed revision. */
  const confirmUpdate = async (targetProjectId: string, targetEnvironmentId: string, target: EditTarget) => {
    const expected = nextVersionOf(target);
    if (expected === null) { setError("清单中的模板版本已变化，请刷新核对"); return; }
    const value = buildValue();
    if (!value) return;
    const request = epoch.current;
    setSaving(true);
    setError(null);
    const response = await serviceCatalogThroughShell({ op: "update", projectId: targetProjectId, environmentId: targetEnvironmentId,
      serviceId: target.serviceId, expectedVersion: target.version, ...value, confirm: true });
    if (epoch.current !== request) return;
    const written = response.ok
      ? serviceTemplateUpdateFromMain(response.payload, { projectId: targetProjectId, environmentId: targetEnvironmentId,
        serviceId: target.serviceId, version: expected })
      : null;
    if (!written || !written.saved || !update || JSON.stringify(written.diff) !== JSON.stringify(update.diff) ||
        written.descriptorChanged !== update.descriptorChanged) {
      setSaving(false);
      setUncertain(true);
      setError(response.ok ? "保存结果无法确认，请刷新清单后核对" : response.error ?? "保存失败，请重试");
      return;
    }
    const listed = await serviceCatalogThroughShell({ op: "list", projectId: targetProjectId, environmentId: targetEnvironmentId });
    if (epoch.current !== request) return;
    setSaving(false);
    const parsed = listed.ok ? serviceTemplatesFromMain(listed.payload, targetProjectId, targetEnvironmentId) : null;
    const saved = parsed?.find((row) => row.serviceId === target.serviceId);
    // The list must show the exact revision the page reviewed - the same version
    // *and* the same descriptor and shared rows - or nothing is reported as saved.
    if (!parsed || !saved || saved.version !== expected || !matchesValue(saved, value)) {
      setRows(null);
      setUncertain(true);
      setError("清单未能确认新版本，请刷新核对");
      return;
    }
    setRows({ projectId: targetProjectId, environmentId: targetEnvironmentId, values: parsed });
    setUpdate(written);
    setUncertain(false);
  };

  const taskName = (taskId: string) => tasks.find((task) => task.taskId === taskId)?.name ?? taskId;
  const workdirLabel = (row: ServiceTemplateView) => row.descriptor.workdir ? `工作目录 ${row.descriptor.workdir}` : "工作目录 仓库根目录";

  return <section className="mt-8" aria-label="服务启动配方">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-semibold">服务启动配方 <Badge variant="soft" className="ml-1">共享模板目录已接线</Badge></h2>
      <div className="flex flex-wrap gap-1"><Button type="button" size="icon" variant="ghost" aria-label="刷新服务配方" title="刷新服务配方" disabled={!projectId || !environmentId || !connected || loading || saving} onClick={() => void refresh()}><Icon name="refresh" /></Button><Button type="button" size="sm" variant="outline" disabled={!projectId || !environmentId || !connected || loading || templates === null || editing} onClick={openCreate}><Icon name="plus" />添加服务</Button></div>
    </div>
    <p className="mt-1 text-xs text-muted">共享模板按环境保存在本机服务目录（主进程唯一写入），每次保存产生该环境内的新版本；启停入口在任务运行面板（POSIX 启用，其他平台具名拒绝），本节不会启动进程。</p>
    {!editing && error && <p role="alert" className="mt-3 text-xs text-[#ad4545]">{error}</p>}
    {!editing && templates === null && <p role="status" className="mt-3 border-t border-line py-5 text-xs text-muted">{loading ? "正在读取服务配方" : !connected ? "服务配方目录未接线" : !projectId ? "尚无项目上下文" : !environmentId ? "尚未选择环境：共享模板按环境保存，请先在上方创建或选择一个环境" : error ? "服务配方清单不可读取" : "正在核对项目"}</p>}
    {!editing && templates?.length === 0 && <p role="status" className="mt-3 border-t border-line py-5 text-xs text-muted">该环境尚未保存服务模板。</p>}
    {!editing && templates?.map((row) => <div key={row.serviceId} className="flex min-w-0 flex-wrap items-start justify-between gap-2 border-t border-line py-3 text-xs">
      <div className="min-w-0"><strong className="break-words font-medium">{row.descriptor.name}</strong><span className="ml-2 text-muted">v{row.version} · {runTypeLabel[row.descriptor.runType]} · {row.descriptor.healthCheck ? `健康检查 ${row.descriptor.healthCheck.kind}` : "未设置健康检查"} · {workdirLabel(row)}</span>
        <p className="mt-1 break-all text-muted">{[row.descriptor.program, ...row.descriptor.args].join(" ")}</p>
        {!!row.shared.length && <p className="mt-1 break-all text-muted">共享变量：{row.shared.map((entry) => entry.key).join("、")}</p>}
        {row.dependencies?.length
          ? <p className="mt-1 break-all text-muted">服务依赖声明：{row.dependencies.map((dependency) => `${dependencyKindLabel[dependency.kind]}→${dependencyTargetName(dependency.to)}`).join("、")}</p>
          : <p className="mt-1 text-muted">依赖声明：无（无依赖边，未做互验）</p>}
      </div><div className="flex gap-1"><Button type="button" size="sm" variant="outline" onClick={() => openEdit(row)}><Icon name="settings" />编辑</Button><Button type="button" size="sm" variant="outline" onClick={() => setBindingId(bindingId === row.serviceId ? null : row.serviceId)}><Icon name="link" />任务绑定</Button></div>
      {bindingId === row.serviceId && <div className="w-full"><TaskServiceBinding key={`${environmentId}/${row.serviceId}`} template={row} environmentName={environmentName} tasks={tasks} /></div>}
    </div>)}
    {editing && <div className="mt-3 border-t border-line pt-3 text-xs">
      <div className="flex items-center justify-between"><h3 className="font-medium">{editTarget ? `编辑共享模板 v${editTarget.version}` : "新建共享模板"}</h3><Button type="button" size="icon" variant="ghost" aria-label="关闭编辑" title="关闭编辑" disabled={saving} onClick={close}><Icon name="close" /></Button></div>
      {fillNotes && <div className="mt-2 border border-line bg-soft px-2 py-2">
        <p role="status">已从草案填入（{fillNotes.source}）：程序、参数、运行类型与工作目录为草案候选，端口与共享变量为空，请逐项核对；尚未保存。</p>
        {fillNotes.notes.map((note, index) => <p key={index} className="mt-1 break-words text-muted">{note}</p>)}
      </div>}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1">服务名称<input aria-label="服务名称" className="min-h-8 min-w-0 rounded-[4px] border border-line bg-paper px-2" value={draft.name} maxLength={128} onChange={(event) => change({ ...draft, name: event.target.value })} /></label>
        <label className="grid gap-1">程序名<input aria-label="程序名" className="min-h-8 min-w-0 rounded-[4px] border border-line bg-paper px-2" value={draft.program} maxLength={128} onChange={(event) => change({ ...draft, program: event.target.value })} /></label>
        <label className="grid gap-1">工作目录（仓库内相对目录）<input aria-label="工作目录" title="仓库内相对目录；留空表示仓库根目录" className="min-h-8 min-w-0 rounded-[4px] border border-line bg-paper px-2" value={draft.workdir} maxLength={512} onChange={(event) => change({ ...draft, workdir: event.target.value })} /></label>
        <label className="grid gap-1">端口<input aria-label="端口" title="多个端口以逗号分隔" className="min-h-8 min-w-0 rounded-[4px] border border-line bg-paper px-2" value={draft.ports} onChange={(event) => change({ ...draft, ports: event.target.value })} /></label>
        <label className="grid gap-1">运行类型<select aria-label="运行类型" className="min-h-8 rounded-[4px] border border-line bg-paper px-2" value={draft.runType} onChange={(event) => change({ ...draft, runType: event.target.value as RunType })}>{Object.entries(runTypeLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="grid gap-1">健康检查<select aria-label="健康检查" className="min-h-8 rounded-[4px] border border-line bg-paper px-2" value={draft.healthKind} onChange={(event) => change({ ...draft, healthKind: event.target.value as HealthKind })}>{Object.entries(healthKindLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        {draft.healthKind !== "" && <label className="grid gap-1">健康检查目标<input aria-label="健康检查目标" title="例如 http://127.0.0.1:3000/health；不填写表示仅记录类型" className="min-h-8 min-w-0 rounded-[4px] border border-line bg-paper px-2" value={draft.healthTarget} maxLength={512} onChange={(event) => change({ ...draft, healthTarget: event.target.value })} /></label>}
      </div>
      <p className="mt-1 text-muted">工作目录是共享模板的可移植默认值；任务绑定的工作子目录才是启动时解析的本机目录，并优先于此处的默认值。</p>
      <div className="mt-3 flex items-center justify-between"><span>参数</span><Button type="button" size="icon" variant="ghost" aria-label="添加参数" title="添加参数" disabled={draft.args.length >= 40} onClick={() => change({ ...draft, args: [...draft.args, ""] })}><Icon name="plus" /></Button></div>
      {draft.args.map((arg, index) => <div key={index} className="mb-2 flex gap-2"><input aria-label={`参数 ${index + 1}`} className="min-h-8 min-w-0 flex-1 rounded-[4px] border border-line bg-paper px-2" value={arg} onChange={(event) => change({ ...draft, args: draft.args.map((item, at) => at === index ? event.target.value : item) })} /><Button type="button" size="icon" variant="ghost" aria-label={`移除参数 ${index + 1}`} title="移除参数" onClick={() => change({ ...draft, args: draft.args.filter((_, at) => at !== index) })}><Icon name="close" /></Button></div>)}
      <div className="mt-3 flex items-center justify-between"><span>共享变量</span><Button type="button" size="icon" variant="ghost" aria-label="添加共享变量" title="添加共享变量" disabled={draft.shared.length >= 80} onClick={() => change({ ...draft, shared: [...draft.shared, { key: "", value: "" }] })}><Icon name="plus" /></Button></div>
      {draft.shared.map((row, index) => <div key={index} className="mb-2 flex min-w-0 gap-2"><input aria-label={`共享变量 KEY ${index + 1}`} className="min-h-8 min-w-0 w-2/5 rounded-[4px] border border-line bg-paper px-2" value={row.key} onChange={(event) => change({ ...draft, shared: draft.shared.map((item, at) => at === index ? { ...item, key: event.target.value } : item) })} /><input aria-label={`共享变量 VALUE ${index + 1}`} className="min-h-8 min-w-0 flex-1 rounded-[4px] border border-line bg-paper px-2" value={row.value} onChange={(event) => change({ ...draft, shared: draft.shared.map((item, at) => at === index ? { ...item, value: event.target.value } : item) })} /><Button type="button" size="icon" variant="ghost" aria-label={`移除共享变量 ${index + 1}`} title="移除共享变量" onClick={() => change({ ...draft, shared: draft.shared.filter((_, at) => at !== index) })}><Icon name="close" /></Button></div>)}
      <div className="mt-3 flex items-center justify-between"><span>服务依赖声明</span><Button type="button" size="icon" variant="ghost" aria-label="添加依赖" title="添加依赖" disabled={nextDependency === undefined || draft.dependencies.length >= 40} onClick={() => { if (nextDependency) change({ ...draft, dependencies: [...draft.dependencies, nextDependency] }); }}><Icon name="plus" /></Button></div>
      {draft.dependencies.length === 0 && <p className="mb-2 text-muted">{dependencyTargets.length === 0
        ? "本环境还没有其他已保存的服务可作为依赖目标；依赖声明按环境保存，先保存目标服务后再回来声明"
        : "无依赖声明：保存后计划里不会有任何依赖边，面板按名显示「无依赖边（未做互验）」"}</p>}
      {draft.dependencies.map((row, index) => <div key={index} className="mb-2 flex min-w-0 gap-2">
        <select aria-label={`依赖目标 ${index + 1}`} className="min-h-8 min-w-0 flex-1 rounded-[4px] border border-line bg-paper px-2" value={row.to} onChange={(event) => change({ ...draft, dependencies: draft.dependencies.map((item, at) => at === index ? { ...item, to: event.target.value } : item) })}>
          {dependencyTargets.map((target) => <option key={target.serviceId} value={target.serviceId}>{target.descriptor.name}</option>)}
          {dependencyTargets.every((target) => target.serviceId !== row.to) && <option value={row.to}>{row.to}</option>}
        </select>
        <select aria-label={`依赖类型 ${index + 1}`} className="min-h-8 rounded-[4px] border border-line bg-paper px-2" value={row.kind} onChange={(event) => change({ ...draft, dependencies: draft.dependencies.map((item, at) => at === index ? { ...item, kind: event.target.value as ServiceDependencyKind } : item) })}>
          {Object.entries(dependencyKindLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <Button type="button" size="icon" variant="ghost" aria-label={`移除依赖 ${index + 1}`} title="移除依赖" onClick={() => change({ ...draft, dependencies: draft.dependencies.filter((_, at) => at !== index) })}><Icon name="close" /></Button>
      </div>)}
      <p className="mt-1 text-muted">依赖声明保存在本环境的共享模板里（ADR 0002）；目标按服务身份选择，不能指向自己或本环境之外的服务，重复声明会被主进程按名拒绝。调用依赖=运行时调用（被调方先监听），启动前置=目标先就绪。没有声明就是没有边；依赖地址与本地端口属于任务覆盖，不在本页。</p>
      {error && <p role="alert" className="my-2 text-[#ad4545]">{error}</p>}
      {review && editTarget && update && <div role="status" className="mt-3 border-t border-line py-2">
        <p>将生成 {update.versionLabel}（当前 v{editTarget.version}）{update.saved ? " · 已保存" : " · 待确认"}</p>
        <p className="mt-1">共享变量差异：{update.diff.added.length === 0 && update.diff.changed.length === 0 && update.diff.removed.length === 0 ? "无" : ""}</p>
        {!!update.diff.added.length && <p>新增：{update.diff.added.join("、")}</p>}
        {update.diff.changed.map((entry) => <p key={entry.key}>修改：{entry.key}：{entry.before} → {entry.after}</p>)}
        {!!update.diff.removed.length && <p>移除：{update.diff.removed.join("、")}</p>}
        <p>启动字段差异：{update.descriptorChanged ? "有（程序、参数、端口、运行类型、健康检查或工作目录）" : "无"}</p>
        <p>服务依赖声明差异：{update.dependenciesChanged ? "有（本环境的新版本才带这些声明）" : "无"}</p>
        <p className="mt-1">保存配置不等于重启进程：本页与「任务绑定」都不会启动、停止或重启任何进程（processRestarted: 否）。{update.contentChanged
          ? "本次保存改变了启动材料。"
          : update.dependenciesChanged
            ? "本次保存没有改变任何启动字段与共享变量，只改变了服务依赖声明：它不重启任何进程，已固定旧版本的任务仍按它自己那份版本取边，需显式采用新版本才会使用新声明。"
            : "本次保存未改变任何启动字段与共享变量，因此不产生需重启项。"}</p>
        <p className="mt-1">已有任务绑定保留原模板版本；本页不会重启服务或让绑定改用新版本 —— 需要先显式采用新版本：关闭编辑后，在列表中该服务的「任务绑定」面板里核对并采用（需二次确认；面板显示的是该绑定自己固定的版本 → v{update.version}），本页保存与刷新都不会自动采用。</p>
        {update.restartNeeded.map((entry) => <p key={entry.taskId}>受影响：任务 {taskName(entry.taskId)} 的 {entry.name}（v{entry.from} → v{entry.to}）仍固定 v{entry.from}，需显式采用 v{entry.to} 并重新绑定该任务的服务所有者后才会用 v{entry.to} 启动</p>)}
        <p className="mt-1 text-muted">{update.restart.fencedTaskIds.length === 0
          ? "本次保存不会撤回任何任务的服务控制：已有任务绑定保留它们固定的版本，启停通道不受影响（需用新版本请在该服务的「任务绑定」面板显式采用）。"
          : `本次保存撤回了这些任务的服务控制：${update.restart.fencedTaskIds.map(taskName).join("、")}（启停会被拒绝为 service-owner-inventory-unconfirmed，需用「任务绑定」面板的「重新绑定服务所有者」恢复）。`}</p>
        <p className="mt-1 text-muted">Agent 侧修改共享模板并生成差异确认仍未接线（SDK 回合工具不含共享模板编辑）；本节与「任务绑定」只覆盖人工编辑与人工采用版本。</p>
      </div>}
      {review && !editTarget && <p role="status" className="mt-3 border-t border-line py-2 text-muted">待保存：{draft.name} · {runTypeLabel[draft.runType]} · {draft.shared.map((row) => row.key).join("、") || "无共享变量"}</p>}
      <div className="mt-3 flex justify-end gap-2"><Button type="button" size="sm" variant="ghost" disabled={saving} onClick={close}>取消</Button>
        {editTarget && update?.saved
          ? <Button type="button" size="sm" disabled>已保存 {update.versionLabel}</Button>
          : <Button type="button" size="sm" disabled={saving || uncertain || loading || templates === null || !environmentId} onClick={() => {
            if (!projectId) return;
            if (!environmentId) { setError("尚未选择环境，无法保存共享模板"); return; }
            if (editTarget) { if (review && update && !update.saved) void confirmUpdate(projectId, environmentId, editTarget); else void reviewUpdate(projectId, environmentId, editTarget); return; }
            if (review) { void createTemplate(projectId, environmentId); return; }
            if (buildValue()) { setError(null); setReview(true); }
          }}>{saving ? "正在处理" : editTarget ? (review ? "确认新版本" : "核对新版本") : review ? "确认保存" : "核对保存"}</Button>}
      </div>
    </div>}
  </section>;
}
