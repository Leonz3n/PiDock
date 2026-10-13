import { useEffect, useRef, useState } from "react";
import { fileRootsThroughShell, serviceCatalogThroughShell } from "../data/shellBridge";
import { serviceBindingAdoptionFromMain, serviceBindingsFromMain, type ServiceBindingAdoptionView, type ServiceBindingView, type ServiceTemplateView } from "../data/serviceCatalog";
import { shellFailure } from "../data/taskServices";
import { hostText, workspaceRootsFromHost, type WorkspaceRootView } from "../data/workspaceFiles";
import { Icon } from "./Icon";
import { Button } from "./ui/button";
import { SavedServiceConfigPreview } from "./SavedServiceConfigPreview";
import { ServiceOwnerRebind } from "./ServiceOwnerRebind";

export function TaskServiceBinding({ template, environmentName, tasks }: {
  template: ServiceTemplateView;
  /** Display name of the environment the displayed revision belongs to; shown so a page never has to infer it. */
  environmentName?: string;
  tasks: readonly { taskId: string; name: string }[];
}) {
  const [requestedTask, setRequestedTask] = useState("");
  const taskId = tasks.some((task) => task.taskId === requestedTask) ? requestedTask : tasks[0]?.taskId ?? "";
  const [state, setState] = useState<{ taskId: string; roots: WorkspaceRootView[]; bindings: ServiceBindingView[] } | null>(null);
  const [rootId, setRootId] = useState("");
  const [subdir, setSubdir] = useState("");
  const [subdirTouched, setSubdirTouched] = useState(false);
  // The template's portable workdir is a prefill snapshot, not a reactive input: a later
  // template revision must not overwrite the human's local subdir while they are editing it.
  const templateWorkdir = useRef(template.descriptor.workdir ?? "");
  templateWorkdir.current = template.descriptor.workdir ?? "";
  const [refs, setRefs] = useState<{ key: string; envRef: string }[]>([]);
  const [pending, setPending] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const [adoption, setAdoption] = useState<ServiceBindingAdoptionView | null>(null);
  const [review, setReview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const epoch = useRef(0);
  const roots = state?.taskId === taskId ? state.roots : [];
  const selectedRoot = roots.some((root) => root.id === rootId) ? rootId : roots[0]?.id ?? "";
  // A task has one binding per service. The binding is only "this environment's"
  // when main says it selected THIS environment: a binding that points at
  // another environment is named as such and never read as this revision's.
  const existing = state?.taskId === taskId ? state.bindings.find((row) => row.serviceId === template.serviceId) : undefined;
  const bound = existing?.environmentId === template.environmentId ? existing : undefined;
  const foreignBinding = existing !== undefined && bound === undefined ? existing : undefined;
  const adoptable = bound !== undefined && template.version > bound.templateVersion;
  const taskName = (id: string) => tasks.find((task) => task.taskId === id)?.name ?? id;

  useEffect(() => {
    const token = epoch;
    const request = ++token.current;
    let live = true;
    setState(null); setError(null); setReview(false); setRootId(""); setSubdir(templateWorkdir.current); setSubdirTouched(false); setRefs([]);
    setAdoption(null); setAdopting(false);
    if (!taskId) { setPending(false); return; }
    setPending(true);
    void Promise.all([fileRootsThroughShell(taskId), serviceCatalogThroughShell({ op: "taskBindings", taskId, projectId: template.projectId })]).then(([files, catalog]) => {
      if (!live || token.current !== request) return;
      setPending(false);
      const roots = files.ok ? workspaceRootsFromHost(files.payload) : null;
      const bindings = catalog.ok ? serviceBindingsFromMain(catalog.payload, taskId) : null;
      if (!roots || !bindings) { setError("任务配方或工作副本无法核对"); return; }
      setState({ taskId, roots: roots.roots.filter((row) => row.kind === "worktree"), bindings });
    });
    return () => { live = false; token.current++; };
  }, [taskId, template.projectId, template.serviceId, revision]);

  const bind = async () => {
    if (!review || pending || !taskId || !selectedRoot || bound) return;
    const request = epoch.current;
    setPending(true); setError(null);
    const result = await serviceCatalogThroughShell({ op: "bind", projectId: template.projectId, environmentId: template.environmentId,
      taskId, serviceId: template.serviceId, templateVersion: template.version, rootId: selectedRoot, subdir, privateRefs: refs });
    if (epoch.current !== request) return;
    setPending(false); setReview(false);
    if (!result.ok || !result.payload || typeof result.payload !== "object") { setState(null); setError("绑定结果无法确认，请刷新核对"); return; }
    const response = result.payload as { cancelled?: unknown; binding?: unknown };
    if (response.cancelled === true) return;
    const parsed = response.cancelled === false ? serviceBindingsFromMain([response.binding], taskId)?.[0] : null;
    if (!parsed || parsed.serviceId !== template.serviceId || parsed.environmentId !== template.environmentId ||
        parsed.templateVersion !== template.version || parsed.rootId !== selectedRoot ||
        parsed.subdir !== subdir || parsed.privateKeys.join("\0") !== refs.map((ref) => ref.key).join("\0")) {
      setState(null); setError("绑定回执无法核对，请刷新核对"); return;
    }
    setState((current) => current?.taskId === taskId ? { ...current, bindings: [...current.bindings, parsed] } : current);
    setRefs([]);
  };

  /**
   * One explicit human adoption of the displayed revision for this binding.
   * The first call only reviews (main writes nothing); only the confirmed call
   * re-pins the version, and the page never touches the local program path,
   * the working subdirectory or the private references. A refusal keeps the
   * displayed version exactly as it is.
   */
  const adopt = async (confirm: boolean) => {
    if (!bound || !adoptable || pending || adopting || (confirm && !adoption)) return;
    const from = bound.templateVersion;
    const to = template.version;
    const request = epoch.current;
    setAdopting(true); setError(null);
    const result = await serviceCatalogThroughShell({ op: "adoptBinding", projectId: template.projectId, taskId,
      serviceId: template.serviceId, templateVersion: to, confirm });
    if (epoch.current !== request) return;
    setAdopting(false);
    const parsed = result.ok
      ? serviceBindingAdoptionFromMain(result.payload, { taskId, serviceId: template.serviceId, environmentId: bound.environmentId, from, to })
      : null;
    if (!parsed || parsed.adopted !== confirm) {
      setAdoption(null);
      setError(result.ok ? "采用回执无法核对，请刷新核对" : shellFailure(result, "采用新版本失败，请重试"));
      return;
    }
    if (!confirm) { setAdoption(parsed); return; }
    if (JSON.stringify(parsed.restartNeeded) !== JSON.stringify(adoption?.restartNeeded ?? null)) {
      setAdoption(null);
      setError("采用结果无法确认，请刷新核对");
      return;
    }
    setAdoption(parsed);
    setState((current) => current?.taskId === taskId
      ? { ...current, bindings: current.bindings.map((row) => row.serviceId === parsed.serviceId ? { ...row, templateVersion: parsed.to } : row) }
      : current);
  };

  return <div className="mt-3 border-t border-line pt-3" aria-label={`${template.descriptor.name}任务绑定`}>
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex min-w-0 items-center gap-2">任务<select aria-label="绑定任务" disabled={pending || !tasks.length} value={taskId} onChange={(event) => setRequestedTask(event.target.value)} className="min-h-8 min-w-0 max-w-[240px] rounded-[4px] border border-line bg-paper px-2"><option value="" hidden>选择任务</option>{tasks.map((task) => <option key={task.taskId} value={task.taskId}>{task.name}</option>)}</select></label>
      <Button type="button" size="icon" variant="ghost" title="刷新任务绑定" aria-label="刷新任务绑定" disabled={pending || !taskId} onClick={() => setRevision((value) => value + 1)}><Icon name="refresh" /></Button>
    </div>
    {error && <p role="alert" className="mt-2 text-[#ad4545]">{error}</p>}
    {pending && <p role="status" className="mt-2 text-muted">正在核对本机绑定</p>}
    {bound && <div className="mt-2 break-words text-muted"><p>已绑定 · 环境 {bound.environmentName} · v{bound.templateVersion} · {hostText(bound.rootId, "Host 未上报绑定根")}{bound.subdir ? `/${bound.subdir}` : ""}</p>{!!bound.privateKeys.length && <p>私有变量：{bound.privateKeys.join("、")}</p>}<p>启停入口在任务运行面板（POSIX 启用，其他平台具名拒绝）；绑定工作子目录即启动时的工作目录。</p></div>}
    {adoptable && !adoption && <div className="mt-2 flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" variant="outline" disabled={pending || adopting} onClick={() => void adopt(false)}><Icon name="arrow" />核对采用 v{template.version}</Button>
      <span className="break-words text-muted">当前绑定固定 v{bound.templateVersion}；采用只重指该绑定的模板版本，不会启动、停止或重启进程。</span>
    </div>}
    {adoption && !adoption.adopted && <div className="mt-2 border border-line bg-soft px-2 py-2 break-words">
      <div role="status">
        <p>待采用：{template.descriptor.name} · v{adoption.from} → v{adoption.to}（仅该绑定的模板版本）</p>
        <p className="mt-1">本次只重指固定的模板版本，未启动、停止或重启任何进程；若该服务当前正在运行，它仍运行 v{adoption.from}。采用会改变该任务的执行快照：主进程据此撤销该任务的运行面板启停通道，之后的启停会遭到拒绝（service-owner-inventory-unconfirmed）；确认后可用本面板的「重新绑定服务所有者」恢复启停（只替换所有者绑定，不重启任何进程），在那之前 v{adoption.to} 不会在运行面板生效。</p>
        {adoption.restartNeeded.length > 0 && <p className="mt-1">重启影响：{adoption.restartNeeded.map((entry) => entry.taskId === taskId
          ? `本次采用的任务 ${taskName(entry.taskId)} 的 ${entry.name}（v${entry.from} → v${entry.to}）`
          : `任务 ${taskName(entry.taskId)} 的 ${entry.name} 仍固定 v${entry.from}，需显式采用 v${entry.to} 并重新绑定该任务的服务所有者`).join("；")}</p>}
      </div>
      <div className="mt-2 flex justify-end gap-2"><Button type="button" size="sm" variant="ghost" disabled={adopting} onClick={() => setAdoption(null)}>取消</Button><Button type="button" size="sm" disabled={adopting} onClick={() => void adopt(true)}>确认采用 v{adoption.to}</Button></div>
    </div>}
    {adoption?.adopted && <div className="mt-2"><p role="status" className="break-words text-muted">已采用 v{adoption.to}（原 v{adoption.from}）；仅改动固定的模板版本，未重启任何进程。该任务的运行面板启停通道已随执行快照撤销，启停会遭到拒绝（service-owner-inventory-unconfirmed），可在下方重新绑定该任务的服务所有者来恢复（不重启任何进程），届时启动使用 v{adoption.to}。</p>{adoption.restart.fencedTaskIds.includes(taskId) && <ServiceOwnerRebind projectId={template.projectId} taskId={taskId} surfacedBy="service-owner-inventory-unconfirmed" onRebound={() => setRevision((value) => value + 1)} />}</div>}
    {bound && <SavedServiceConfigPreview key={`${taskId}/${bound.templateVersion}`} projectId={template.projectId} taskId={taskId} serviceId={bound.serviceId} templateVersion={bound.templateVersion} />}
    {foreignBinding && <p role="status" className="mt-2 break-words text-[#9a6032]">该任务在此服务上绑定的是环境「{foreignBinding.environmentName}」的 v{foreignBinding.templateVersion}，不是当前环境的模板；本面板不会把它当成当前环境的绑定，也不会改写它（同一任务同一服务只能有一个绑定）。</p>}
    {!bound && !foreignBinding && state?.taskId === taskId && <fieldset disabled={pending} className="mt-3 min-w-0">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1">工作副本<select aria-label="绑定工作副本" value={selectedRoot} disabled={!roots.length} onChange={(event) => { setRootId(event.target.value); setReview(false); }} className="min-h-8 min-w-0 rounded-[4px] border border-line bg-paper px-2"><option value="" hidden>选择工作副本</option>{roots.map((root) => <option key={root.id} value={root.id}>{hostText(root.label, "Host 未上报根名称")}</option>)}</select></label>
        <label className="grid gap-1">工作子目录<input aria-label="绑定工作子目录" value={subdir} maxLength={512} placeholder={template.descriptor.workdir ?? "仓库根目录"} className="min-h-8 min-w-0 rounded-[4px] border border-line bg-paper px-2" onChange={(event) => { setSubdir(event.target.value); setSubdirTouched(true); setReview(false); }} /></label>
      </div>
      <div className="mt-2 flex items-center justify-between"><span>本机凭据引用</span><Button type="button" size="icon" variant="ghost" aria-label="添加私有引用" title="添加私有引用" disabled={refs.length >= 80} onClick={() => { setRefs([...refs, { key: "", envRef: "" }]); setReview(false); }}><Icon name="plus" /></Button></div>
      {refs.map((ref, index) => <div key={index} className="mt-2 flex min-w-0 gap-2"><input aria-label={`私有 KEY ${index + 1}`} value={ref.key} maxLength={100} className="min-h-8 min-w-0 w-2/5 rounded-[4px] border border-line bg-paper px-2" onChange={(event) => { setRefs(refs.map((row, at) => at === index ? { ...row, key: event.target.value } : row)); setReview(false); }} /><input aria-label={`本机环境引用 ${index + 1}`} value={ref.envRef} maxLength={100} className="min-h-8 min-w-0 flex-1 rounded-[4px] border border-line bg-paper px-2" onChange={(event) => { setRefs(refs.map((row, at) => at === index ? { ...row, envRef: event.target.value } : row)); setReview(false); }} /><Button type="button" size="icon" variant="ghost" aria-label={`移除私有引用 ${index + 1}`} title="移除私有引用" onClick={() => { setRefs(refs.filter((_, at) => at !== index)); setReview(false); }}><Icon name="close" /></Button></div>)}
      <p className="mt-2 break-words text-muted">{template.descriptor.workdir && !subdirTouched
        ? `已带入模板默认工作目录：${template.descriptor.workdir}。本机绑定的工作子目录才是启动时解析的工作目录，可直接修改。`
        : "本机绑定的工作子目录即启动时的工作目录；留空表示工作副本根目录。"}</p>
      {review && <p role="status" className="mt-3 break-words text-muted">待绑定：{template.descriptor.name} · 环境 {environmentName ?? "（名称未读取）"} · v{template.version} · {selectedRoot}{subdir ? `/${subdir}` : ""}</p>}
      <div className="mt-3 flex justify-end"><Button type="button" size="sm" disabled={!selectedRoot} onClick={() => { if (review) void bind(); else setReview(true); }}><Icon name="folder" />{review ? "选择程序并保存绑定" : "核对任务绑定"}</Button></div>
    </fieldset>}
    {!taskId && <p className="mt-2 text-muted">当前项目无可绑定任务</p>}
  </div>;
}
