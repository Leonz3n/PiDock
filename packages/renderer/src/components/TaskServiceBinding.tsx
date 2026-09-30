import { useEffect, useRef, useState } from "react";
import { fileRootsThroughShell, serviceCatalogThroughShell } from "../data/shellBridge";
import { serviceBindingsFromMain, type ServiceBindingView, type ServiceTemplateView } from "../data/serviceCatalog";
import { workspaceRootsFromHost, type WorkspaceRootView } from "../data/workspaceFiles";
import { Icon } from "./Icon";
import { Button } from "./ui/button";
import { SavedServiceConfigPreview } from "./SavedServiceConfigPreview";

export function TaskServiceBinding({ template, tasks }: {
  template: ServiceTemplateView; tasks: readonly { taskId: string; name: string }[];
}) {
  const [requestedTask, setRequestedTask] = useState("");
  const taskId = tasks.some((task) => task.taskId === requestedTask) ? requestedTask : tasks[0]?.taskId ?? "";
  const [state, setState] = useState<{ taskId: string; roots: WorkspaceRootView[]; bindings: ServiceBindingView[] } | null>(null);
  const [rootId, setRootId] = useState("");
  const [subdir, setSubdir] = useState("");
  const [refs, setRefs] = useState<{ key: string; envRef: string }[]>([]);
  const [pending, setPending] = useState(false);
  const [review, setReview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const epoch = useRef(0);
  const roots = state?.taskId === taskId ? state.roots : [];
  const selectedRoot = roots.some((root) => root.id === rootId) ? rootId : roots[0]?.id ?? "";
  const bound = state?.taskId === taskId ? state.bindings.find((row) => row.serviceId === template.serviceId) : undefined;

  useEffect(() => {
    const token = epoch;
    const request = ++token.current;
    let live = true;
    setState(null); setError(null); setReview(false); setRootId(""); setSubdir(""); setRefs([]);
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
    const result = await serviceCatalogThroughShell({ op: "bind", projectId: template.projectId, taskId,
      serviceId: template.serviceId, templateVersion: template.version, rootId: selectedRoot, subdir, privateRefs: refs });
    if (epoch.current !== request) return;
    setPending(false); setReview(false);
    if (!result.ok || !result.payload || typeof result.payload !== "object") { setState(null); setError("绑定结果无法确认，请刷新核对"); return; }
    const response = result.payload as { cancelled?: unknown; binding?: unknown };
    if (response.cancelled === true) return;
    const parsed = response.cancelled === false ? serviceBindingsFromMain([response.binding], taskId)?.[0] : null;
    if (!parsed || parsed.serviceId !== template.serviceId || parsed.templateVersion !== template.version || parsed.rootId !== selectedRoot ||
        parsed.subdir !== subdir || parsed.privateKeys.join("\0") !== refs.map((ref) => ref.key).join("\0")) {
      setState(null); setError("绑定回执无法核对，请刷新核对"); return;
    }
    setState((current) => current?.taskId === taskId ? { ...current, bindings: [...current.bindings, parsed] } : current);
    setRefs([]);
  };

  return <div className="mt-3 border-t border-line pt-3" aria-label={`${template.descriptor.name}任务绑定`}>
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex min-w-0 items-center gap-2">任务<select aria-label="绑定任务" disabled={pending || !tasks.length} value={taskId} onChange={(event) => setRequestedTask(event.target.value)} className="min-h-8 min-w-0 max-w-[240px] rounded-[4px] border border-line bg-paper px-2"><option value="" hidden>选择任务</option>{tasks.map((task) => <option key={task.taskId} value={task.taskId}>{task.name}</option>)}</select></label>
      <Button type="button" size="icon" variant="ghost" title="刷新任务绑定" aria-label="刷新任务绑定" disabled={pending || !taskId} onClick={() => setRevision((value) => value + 1)}><Icon name="refresh" /></Button>
    </div>
    {error && <p role="alert" className="mt-2 text-[#ad4545]">{error}</p>}
    {pending && <p role="status" className="mt-2 text-muted">正在核对本机绑定</p>}
    {bound && <div className="mt-2 break-words text-muted"><p>已绑定 · v{bound.templateVersion} · {bound.rootId}{bound.subdir ? `/${bound.subdir}` : ""}</p>{!!bound.privateKeys.length && <p>私有变量：{bound.privateKeys.join("、")}</p>}<p>运行未接线</p></div>}
    {bound && <SavedServiceConfigPreview key={`${taskId}/${bound.templateVersion}`} projectId={template.projectId} taskId={taskId} serviceId={bound.serviceId} templateVersion={bound.templateVersion} />}
    {!bound && state?.taskId === taskId && <fieldset disabled={pending} className="mt-3 min-w-0">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1">工作副本<select aria-label="绑定工作副本" value={selectedRoot} disabled={!roots.length} onChange={(event) => { setRootId(event.target.value); setReview(false); }} className="min-h-8 min-w-0 rounded-[4px] border border-line bg-paper px-2"><option value="" hidden>选择工作副本</option>{roots.map((root) => <option key={root.id} value={root.id}>{root.label}</option>)}</select></label>
        <label className="grid gap-1">工作子目录<input aria-label="绑定工作子目录" value={subdir} maxLength={512} className="min-h-8 min-w-0 rounded-[4px] border border-line bg-paper px-2" onChange={(event) => { setSubdir(event.target.value); setReview(false); }} /></label>
      </div>
      <div className="mt-2 flex items-center justify-between"><span>本机凭据引用</span><Button type="button" size="icon" variant="ghost" aria-label="添加私有引用" title="添加私有引用" disabled={refs.length >= 80} onClick={() => { setRefs([...refs, { key: "", envRef: "" }]); setReview(false); }}><Icon name="plus" /></Button></div>
      {refs.map((ref, index) => <div key={index} className="mt-2 flex min-w-0 gap-2"><input aria-label={`私有 KEY ${index + 1}`} value={ref.key} maxLength={100} className="min-h-8 min-w-0 w-2/5 rounded-[4px] border border-line bg-paper px-2" onChange={(event) => { setRefs(refs.map((row, at) => at === index ? { ...row, key: event.target.value } : row)); setReview(false); }} /><input aria-label={`本机环境引用 ${index + 1}`} value={ref.envRef} maxLength={100} className="min-h-8 min-w-0 flex-1 rounded-[4px] border border-line bg-paper px-2" onChange={(event) => { setRefs(refs.map((row, at) => at === index ? { ...row, envRef: event.target.value } : row)); setReview(false); }} /><Button type="button" size="icon" variant="ghost" aria-label={`移除私有引用 ${index + 1}`} title="移除私有引用" onClick={() => { setRefs(refs.filter((_, at) => at !== index)); setReview(false); }}><Icon name="close" /></Button></div>)}
      {review && <p role="status" className="mt-3 break-words text-muted">待绑定：{template.descriptor.name} · v{template.version} · {selectedRoot}{subdir ? `/${subdir}` : ""}</p>}
      <div className="mt-3 flex justify-end"><Button type="button" size="sm" disabled={!selectedRoot} onClick={() => { if (review) void bind(); else setReview(true); }}><Icon name="folder" />{review ? "选择程序并保存绑定" : "核对任务绑定"}</Button></div>
    </fieldset>}
    {!taskId && <p className="mt-2 text-muted">当前项目无可绑定任务</p>}
  </div>;
}
