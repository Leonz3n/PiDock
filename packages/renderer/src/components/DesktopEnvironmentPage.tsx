import { useEffect, useRef, useState } from "react";
import { fileRootsThroughShell, serviceImportHintsThroughShell } from "../data/shellBridge";
import { serviceImportScanFromHost, type ServiceImportScanView } from "../data/serviceImportHints";
import { workspaceRootsFromHost, type WorkspaceRootView } from "../data/workspaceFiles";
import { Icon } from "./Icon";
import { ProjectServiceTemplates } from "./ProjectServiceTemplates";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

interface Project { id: string; name: string }
interface Task { taskId: string; name: string }
const runTypeLabel = { "long-lived": "常驻服务", "one-shot": "一次性命令", prepare: "准备步骤" } as const;

/** Repository import hints are read-only until a durable service catalog exists. */
function RepositoryImportDrafts({ tasks, pending }: { tasks: readonly Task[]; pending: boolean }) {
  const [requestedTaskId, setRequestedTaskId] = useState("");
  const taskId = tasks.some((task) => task.taskId === requestedTaskId) ? requestedTaskId : tasks[0]?.taskId ?? "";
  const [rootState, setRootState] = useState<{ taskId: string; roots: WorkspaceRootView[] }>({ taskId: "", roots: [] });
  const [rootId, setRootId] = useState("");
  const [loadingRoots, setLoadingRoots] = useState(false);
  const [loadingScan, setLoadingScan] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanState, setScanState] = useState<{ taskId: string; rootId: string; scan: ServiceImportScanView } | null>(null);
  const epoch = useRef(0);
  const roots = rootState.taskId === taskId ? rootState.roots : [];
  const selectedRoot = roots.some((root) => root.id === rootId) ? rootId : roots[0]?.id ?? "";
  const scan = scanState?.taskId === taskId && scanState.rootId === selectedRoot ? scanState.scan : null;

  useEffect(() => {
    let live = true;
    const request = ++epoch.current;
    setRootState({ taskId: "", roots: [] });
    setScanState(null);
    setLoadingScan(false);
    setError(null);
    if (!taskId || pending) { setLoadingRoots(false); return; }
    setLoadingRoots(true);
    void (async () => {
      const response = await fileRootsThroughShell(taskId);
      if (!live || epoch.current !== request) return;
      setLoadingRoots(false);
      const parsed = response.ok ? workspaceRootsFromHost(response.payload) : null;
      if (!parsed) { setError("无法核对任务仓库来源"); return; }
      setRootState({ taskId, roots: parsed.roots.filter((root) => root.kind === "worktree") });
      setRootId("");
    })();
    return () => { live = false; };
  }, [taskId, pending]);

  const scanRepository = async () => {
    if (!taskId || !selectedRoot) return;
    const request = ++epoch.current;
    setScanState(null);
    setError(null);
    setLoadingScan(true);
    const response = await serviceImportHintsThroughShell({ taskId, rootId: selectedRoot });
    if (epoch.current !== request) return;
    setLoadingScan(false);
    const parsed = response.ok ? serviceImportScanFromHost(response.payload) : null;
    if (!parsed) { setError(response.ok ? "Host 导入草案响应无法核对" : "仓库配置读取失败"); return; }
    setScanState({ taskId, rootId: selectedRoot, scan: parsed });
  };

  return <section className="mt-8" aria-label="仓库配置草案">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-sm font-semibold">仓库配置草案</h2><Button type="button" size="sm" variant="outline" disabled={!selectedRoot || loadingRoots || loadingScan} onClick={() => void scanRepository()}><Icon name="file" />扫描仓库</Button></div>
    <div className="mt-3 flex flex-wrap gap-3 border-y border-line py-3 text-xs">
      <label className="flex min-w-0 items-center gap-2">任务<select aria-label="扫描任务" value={taskId} disabled={!tasks.length || pending} onChange={(event) => setRequestedTaskId(event.target.value)} className="min-h-8 max-w-[240px] min-w-0 rounded-[4px] border border-line bg-paper px-2 text-ink"><option value="" hidden>选择任务</option>{tasks.map((task) => <option key={task.taskId} value={task.taskId}>{task.name}</option>)}</select></label>
      <label className="flex min-w-0 items-center gap-2">仓库<select aria-label="扫描仓库来源" value={selectedRoot} disabled={!roots.length || loadingRoots} onChange={(event) => { epoch.current++; setLoadingScan(false); setScanState(null); setRootId(event.target.value); setError(null); }} className="min-h-8 max-w-[240px] min-w-0 rounded-[4px] border border-line bg-paper px-2 text-ink"><option value="" hidden>选择仓库</option>{roots.map((root) => <option key={root.id} value={root.id}>{root.label}</option>)}</select></label>
    </div>
    {error && <p role="alert" className="py-3 text-xs text-[#ad4545]">{error}</p>}
    {!error && !scan && <p role="status" className="py-4 text-xs text-muted">{pending || loadingRoots ? "正在读取任务仓库" : loadingScan ? "正在扫描仓库配置" : !tasks.length ? "当前项目无可用任务" : !roots.length ? "该任务无仓库工作副本" : "尚未扫描"}</p>}
    {scan && <div className="text-xs">
      {scan.truncated && <p role="status" className="border-b border-line py-2 text-[#9a6032]">草案数量已截断，请缩小仓库配置范围后核对。</p>}
      {scan.errors.map((item) => <p key={item.source} role="alert" className="border-b border-line py-2 text-[#ad4545]">{item.source}：{item.reason}</p>)}
      {!scan.hints.length && <p className="py-4 text-muted">{scan.errors.length ? "部分配置读取失败，无法确认是否存在草案" : "未发现可核对的启动草案"}</p>}
      {scan.hints.map((hint, index) => <div key={`${hint.source}-${hint.name}-${index}`} className="grid min-w-0 gap-2 border-b border-line py-3 sm:grid-cols-[minmax(0,1fr)_110px]">
        <div className="min-w-0"><strong className="block break-words font-medium text-ink">{hint.name}</strong><span className="break-all text-muted">{hint.source}</span>
          {!!hint.envKeys.length && <p className="mt-1 break-all text-muted">变量键：{hint.envKeys.join("、")}</p>}
          {hint.invalidVars.map((key, at) => <p key={at} className="mt-1 break-all text-[#ad4545]">无效变量：{key}</p>)}
          {hint.toVerify.map((note, at) => <p key={at} className="mt-1 break-words text-muted">{note}</p>)}
        </div><span className="text-muted sm:text-right">{runTypeLabel[hint.runType]}</span>
      </div>)}
    </div>}
  </section>;
}

/** Prototype-A layout with only authoritative Project context; no environment model is exposed by Host yet. */
export function DesktopEnvironmentPage({ projects, projectId, taskCount, tasks, tasksPending = false, onSelectProject }: {
  projects: readonly Project[];
  projectId: string | null;
  taskCount: number;
  tasks: readonly Task[];
  tasksPending?: boolean;
  onSelectProject: (id: string) => void;
}) {
  return <div data-testid="desktop-environment-page" className="px-[34px] py-[30px] below-narrow:px-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><p className="text-[10px] uppercase tracking-[1.8px] text-[#95979c]">Environments</p><h1 className="mt-1.5 text-[26px] font-semibold text-ink">环境与服务</h1></div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled title="Host 尚无项目环境管理接口">管理环境</Button>
        <Button type="button" disabled title="Host 尚无项目环境创建接口"><Icon name="plus" />新增环境</Button>
      </div>
    </div>
    <p className="mt-1.5 text-xs text-muted">继续使用仓库默认配置，通过环境变量调整服务运行方式。配置与服务状态必须以真实 Host 为准。</p>
    <div className="mt-6 flex flex-wrap items-center gap-2">
      <label htmlFor="desktop-env-project" className="text-xs text-muted">项目</label>
      <select id="desktop-env-project" className="min-h-8 max-w-full rounded-[4px] border border-line bg-paper px-2 text-xs text-ink" value={projectId ?? ""} disabled={!projects.length} onChange={(event) => onSelectProject(event.target.value)}>
        {!projects.length && <option value="">尚无项目</option>}
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
      <span className="text-[11px] text-muted">{projectId ? `关联任务 ${taskCount}` : "尚无项目上下文"}</span>
    </div>
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <label className="text-xs text-muted">环境</label>
      <select aria-label="环境" disabled value="unwired" className="min-h-8 max-w-full rounded-[4px] border border-line bg-paper px-2 text-xs text-muted"><option value="unwired">环境清单未接线</option></select>
      <Badge variant="soft">模板版本 · 未接线</Badge>
    </div>
    <div className="mt-5 flex flex-wrap gap-1 border-b border-line pb-2" role="group" aria-label="配置作用范围">
      {(["任务覆盖", "共享模板", "本机私有配置"] as const).map((scope) => <Button key={scope} type="button" variant="ghost" size="sm" disabled title={`${scope}的生产数据未接线`}>{scope}</Button>)}
    </div>
    <section className="mt-5" aria-label="环境变量">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">环境变量 <Badge variant="soft" className="ml-1">未接线</Badge></h2><Button type="button" size="sm" disabled title="缺少真实配置及变更预览">保存更改</Button></div>
      <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[320px] text-left text-xs"><thead className="border-b border-line text-muted"><tr><th className="py-2 font-medium">KEY</th><th className="py-2 font-medium">VALUE</th><th className="py-2 font-medium">生效来源</th></tr></thead><tbody><tr className="border-b border-line"><td colSpan={3} className="py-5 text-muted">Host 尚未提供项目环境、任务覆盖与敏感值遮蔽后的生效配置。这里不展示示例 KEY 或 VALUE。</td></tr></tbody></table></div>
    </section>
    <ProjectServiceTemplates projectId={projectId} />
    <RepositoryImportDrafts tasks={tasks} pending={tasksPending} />
  </div>;
}
