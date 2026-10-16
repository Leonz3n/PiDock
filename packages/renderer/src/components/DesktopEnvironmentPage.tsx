import { useCallback, useEffect, useRef, useState } from "react";
import { fileRootsThroughShell, serviceCatalogThroughShell, serviceImportHintsThroughShell, shellBridge } from "../data/shellBridge";
import { serviceEnvironmentsFromMain, type ServiceEnvironmentView } from "../data/serviceCatalog";
import { serviceImportScanFromHost, type ServiceImportHintView, type ServiceImportScanView } from "../data/serviceImportHints";
import { hostText, workspaceRootsFromHost, type WorkspaceRootView } from "../data/workspaceFiles";
import { Icon } from "./Icon";
import { ProjectServiceTemplates } from "./ProjectServiceTemplates";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

interface Project { id: string; name: string }
interface Task { taskId: string; name: string }
const runTypeLabel = { "long-lived": "常驻服务", "one-shot": "一次性命令", prepare: "准备步骤" } as const;

/**
 * Repository import hints are read-only until a human fills the template form
 * with one: `onFillForm` is that one explicit action, and a configuration-only
 * hint (runType `null`, e.g. `.env`) cannot be applied as a run unit.
 */
function RepositoryImportDrafts({ tasks, pending, filled, onFillForm }: {
  tasks: readonly Task[]; pending: boolean; filled: string | null; onFillForm: (hint: ServiceImportHintView) => void;
}) {
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
    <p className="mt-1 text-xs text-muted">扫描只读取仓库配置并给出候选。这不是「从 .vscode 导入」：Host 尚无环境变量导入与自动写入操作。变量只保留键名与来源（值一律遮蔽），命令已按去敏规则过滤。草案不会自动保存、绑定或启动，需由你显式填入上方「服务启动配方」的表单后逐项核对。</p>
    {filled && <p role="status" className="mt-2 text-xs text-muted">已把草案「{filled}」填入上方新建模板表单；尚未保存。</p>}
    <div className="mt-3 flex flex-wrap gap-3 border-y border-line py-3 text-xs">
      <label className="flex min-w-0 items-center gap-2">任务<select aria-label="扫描任务" value={taskId} disabled={!tasks.length || pending} onChange={(event) => setRequestedTaskId(event.target.value)} className="min-h-8 max-w-[240px] min-w-0 rounded-[4px] border border-line bg-paper px-2 text-ink"><option value="" hidden>选择任务</option>{tasks.map((task) => <option key={task.taskId} value={task.taskId}>{task.name}</option>)}</select></label>
      <label className="flex min-w-0 items-center gap-2">仓库<select aria-label="扫描仓库来源" value={selectedRoot} disabled={!roots.length || loadingRoots} onChange={(event) => { epoch.current++; setLoadingScan(false); setScanState(null); setRootId(event.target.value); setError(null); }} className="min-h-8 max-w-[240px] min-w-0 rounded-[4px] border border-line bg-paper px-2 text-ink"><option value="" hidden>选择仓库</option>{roots.map((root) => <option key={root.id} value={root.id}>{hostText(root.label, "Host 未上报根名称")}</option>)}</select></label>
    </div>
    {error && <p role="alert" className="py-3 text-xs text-[#ad4545]">{error}</p>}
    {!error && !scan && <p role="status" className="py-4 text-xs text-muted">{pending || loadingRoots ? "正在读取任务仓库" : loadingScan ? "正在扫描仓库配置" : !tasks.length ? "当前项目无可用任务" : !roots.length ? "该任务无仓库工作副本" : "尚未扫描"}</p>}
    {scan && <div className="text-xs">
      {scan.truncated && <p role="status" className="border-b border-line py-2 text-[#9a6032]">草案数量已截断，请缩小仓库配置范围后核对。</p>}
      {scan.errors.map((item) => <p key={item.source} role="alert" className="border-b border-line py-2 text-[#ad4545]">{item.source}：{hostText(item.reason, "Host 未给出原因")}</p>)}
      {!scan.hints.length && <p className="py-4 text-muted">{scan.errors.length ? "部分配置读取失败，无法确认是否存在草案" : "未发现可核对的启动草案"}</p>}
      {scan.hints.map((hint, index) => {
        // `serviceImportScanFromHost` keeps `program: ""` (the scanner found no
        // command: dropped or absent) and keeps `""` elements in `args`
        // (`shortTexts`), so the joined candidate can itself be blank; that is the
        // "no command" state, and the line is skipped rather than rendering a
        // bare `命令候选：` for a command the Host never reported.
        const candidate = [hint.program, ...hint.args].join(" ").trim();
        return <div key={`${hint.source}-${hint.name}-${index}`} className="grid min-w-0 gap-2 border-b border-line py-3 sm:grid-cols-[minmax(0,1fr)_110px]">
        <div className="min-w-0"><strong className="block break-words font-medium text-ink">{hostText(hint.name, "Host 未上报候选名称")}</strong><span className="break-all text-muted">{hint.source}</span>
          {candidate !== "" && <p className="mt-1 break-all text-muted">命令候选：{candidate}</p>}
          {hint.workdir !== undefined && <p className="mt-1 break-all text-muted">工作目录候选：{hint.workdir}</p>}
          {!!hint.variables.length && <p className="mt-1 break-all text-muted">变量：{hint.variables.map((row) => `${row.key}（来源 ${row.source} · 值 ${row.maskedValue}）`).join("、")}</p>}
          {hint.invalidVars.map((key, at) => <p key={at} className="mt-1 break-all text-[#ad4545]">无效变量：{hostText(key, "Host 未上报变量名")}</p>)}
          {hint.toVerify.map((note, at) => <p key={at} className="mt-1 break-words text-muted">{hostText(note, "Host 未上报待核对项")}</p>)}
        </div><div className="flex flex-col items-start gap-2 sm:items-end"><span className={hint.runTypeUncertain ? "text-[#9a6032]" : "text-muted"}>{hint.runType === null
          ? "配置来源"
          : hint.runTypeUncertain ? `${runTypeLabel[hint.runType]}（待确认）` : runTypeLabel[hint.runType]}</span>
          <span className="break-words text-right text-muted">{hostText(hint.runTypeBasis, "Host 未上报判定依据")}</span>
          {hint.runType === null
            ? <Button type="button" size="sm" variant="outline" disabled title="配置来源草案不能作为运行单元填入服务模板">仅配置来源</Button>
            : <Button type="button" size="sm" variant="outline" onClick={() => onFillForm(hint)}>填入新建模板</Button>}
        </div>
      </div>;
      })}
    </div>}
  </section>;
}

/**
 * Prototype-A layout with only authoritative Project context. The environment
 * dimension of [PiDock 04] #7 box 1 is real here: the list, the creation and the
 * selection all go through main's own store (`shell/serviceCatalogOp
 * {op:"listEnvironments"|"createEnvironment"}`) and the shared-template half
 * below is scoped to the SELECTED environment. Nothing is preselected: with no
 * environment chosen the section says so instead of showing a project-wide
 * template list that could be read as the selected environment's, and a project
 * with no environment really shows an empty list.
 */
export function DesktopEnvironmentPage({ projects, projectId, taskCount, tasks, tasksPending = false, onSelectProject }: {
  projects: readonly Project[];
  projectId: string | null;
  taskCount: number;
  tasks: readonly Task[];
  tasksPending?: boolean;
  onSelectProject: (id: string) => void;
}) {
  // One explicit human action moves a scanned draft into the template form;
  // the success banner comes back from the form itself, so a refused fill is
  // never announced as applied.
  const [pendingFill, setPendingFill] = useState<ServiceImportHintView | null>(null);
  const [filledName, setFilledName] = useState<string | null>(null);
  const appliedFill = useCallback((applied: ServiceImportHintView) => {
    // `serviceImportScanFromHost` reads `name` with `shortText` (a length cap
    // only), so the banner names the blank name instead of ending at `· `.
    setFilledName(`${applied.source} · ${hostText(applied.name, "Host 未上报候选名称")}`);
    setPendingFill(null);
  }, []);
  const connected = typeof shellBridge()?.serviceCatalogOp === "function";
  const [environmentRows, setEnvironmentRows] = useState<{ projectId: string; values: ServiceEnvironmentView[] } | null>(null);
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState("");
  const [creatingEnvironment, setCreatingEnvironment] = useState(false);
  const [newEnvironmentName, setNewEnvironmentName] = useState("");
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const [environmentPending, setEnvironmentPending] = useState(false);
  const environmentEpoch = useRef(0);
  const environments = environmentRows?.projectId === projectId && projectId !== null ? environmentRows.values : null;
  const selectedEnvironment = environments?.find((row) => row.environmentId === selectedEnvironmentId) ?? null;

  const loadEnvironments = useCallback(async (targetProjectId: string) => {
    const request = ++environmentEpoch.current;
    setEnvironmentPending(true);
    const response = await serviceCatalogThroughShell({ op: "listEnvironments", projectId: targetProjectId });
    if (environmentEpoch.current !== request) return null;
    setEnvironmentPending(false);
    const parsed = response.ok ? serviceEnvironmentsFromMain(response.payload, targetProjectId) : null;
    if (!parsed) {
      // A refused or unreadable list is named, never rendered as "no environments".
      setEnvironmentRows(null);
      setEnvironmentError(response.ok ? "环境清单响应无法核对" : "环境清单读取失败");
      return null;
    }
    setEnvironmentRows({ projectId: targetProjectId, values: parsed });
    return parsed;
  }, []);

  useEffect(() => {
    environmentEpoch.current++;
    setEnvironmentRows(null);
    setSelectedEnvironmentId("");
    setCreatingEnvironment(false);
    setNewEnvironmentName("");
    setEnvironmentError(null);
    setEnvironmentPending(false);
    if (!projectId || !connected) return;
    void loadEnvironments(projectId);
  }, [projectId, connected, loadEnvironments]);

  /**
   * One explicit human creation. Main mints the id and owns the document; the
   * newly created environment is then selected because the human just named it
   * - never a silent default, and never on behalf of another environment.
   */
  const createEnvironment = async () => {
    if (!projectId || !connected || environmentPending) return;
    const name = newEnvironmentName;
    const request = ++environmentEpoch.current;
    const project = projectId;
    setEnvironmentPending(true);
    setEnvironmentError(null);
    const response = await serviceCatalogThroughShell({ op: "createEnvironment", projectId: project, name });
    if (environmentEpoch.current !== request) return;
    setEnvironmentPending(false);
    const created = response.ok ? serviceEnvironmentsFromMain([response.payload], project)?.[0] : null;
    if (!created) {
      setEnvironmentError(response.ok ? "环境创建回执无法核对" : response.error ?? "环境创建失败，请重试");
      return;
    }
    setNewEnvironmentName("");
    setCreatingEnvironment(false);
    // Main owns the full list, so re-read it instead of appending to whatever
    // state the page holds: a create can never turn a refused read into a
    // partial list the page then reports as the observed environment list.
    const refreshed = await loadEnvironments(project);
    if (refreshed?.some((row) => row.environmentId === created.environmentId)) setSelectedEnvironmentId(created.environmentId);
  };

  return <div data-testid="desktop-environment-page" className="px-[34px] py-[30px] below-narrow:px-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><p className="text-[10px] uppercase tracking-[1.8px] text-[#95979c]">Environments</p><h1 className="mt-1.5 text-[26px] font-semibold text-ink">环境与服务</h1></div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled title="Host 环境目录操作仅支持列出与创建，不支持重命名或删除">管理环境</Button>
        <Button type="button" variant="outline" disabled={!projectId || !connected || environmentPending || creatingEnvironment} title={!connected ? "服务配方目录未接线" : !projectId ? "尚无项目上下文" : "创建一个有名称的项目环境"} onClick={() => { setCreatingEnvironment((open) => !open); setEnvironmentError(null); }}><Icon name="plus" />新增环境</Button>
      </div>
    </div>
    <p className="mt-1.5 text-xs text-muted">继续使用仓库默认配置，通过环境变量调整服务运行方式。配置与服务状态必须以真实 Host 为准。</p>
    <p className="mt-2 text-[11px] text-muted">环境列表与创建已接线；重命名和删除不可用：Host 环境目录操作仅支持列出与创建。</p>
    <div className="mt-6 flex flex-wrap items-center gap-2">
      <label htmlFor="desktop-env-project" className="text-xs text-muted">项目</label>
      <select id="desktop-env-project" className="min-h-8 max-w-full rounded-[4px] border border-line bg-paper px-2 text-xs text-ink" value={projectId ?? ""} disabled={!projects.length} onChange={(event) => onSelectProject(event.target.value)}>
        {!projects.length && <option value="">尚无项目</option>}
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
      <span className="text-[11px] text-muted">{projectId ? `关联任务 ${taskCount}` : "尚无项目上下文"}</span>
    </div>
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <label htmlFor="desktop-env-list" className="text-xs text-muted">环境</label>
      <select id="desktop-env-list" aria-label="环境" value={selectedEnvironment ? selectedEnvironment.environmentId : ""} disabled={!environments || !environments.length || environmentPending}
        onChange={(event) => { setSelectedEnvironmentId(event.target.value); setEnvironmentError(null); }}
        className="min-h-8 max-w-full rounded-[4px] border border-line bg-paper px-2 text-xs text-ink">
        <option value="">尚未选择环境</option>
        {(environments ?? []).map((row) => <option key={row.environmentId} value={row.environmentId}>{row.name}</option>)}
      </select>
      <Badge variant="soft">{!connected ? "服务配方目录未接线" : environments === null ? (environmentPending ? "正在读取环境清单" : "环境清单不可读取") : `环境清单已接线 · ${environments.length} 个环境`}</Badge>
      <span className="text-[11px] text-muted">{!connected ? "环境由主进程保存" : environments === null ? "环境清单以主进程为准" : !environments.length ? "该项目尚无环境，请先新增并命名" : !selectedEnvironment ? "尚未选择环境：下方共享模板按环境保存" : `已选环境：${selectedEnvironment.name}`}</span>
    </div>
    {environmentError && <p role="alert" data-testid="desktop-environment-error" className="mt-2 text-xs text-[#ad4545]">{environmentError}</p>}
    {creatingEnvironment && <div className="mt-2 flex flex-wrap items-end gap-2">
      <label className="grid gap-1 text-xs">环境名称<input aria-label="环境名称" className="min-h-8 min-w-0 rounded-[4px] border border-line bg-paper px-2" value={newEnvironmentName} maxLength={64} onChange={(event) => setNewEnvironmentName(event.target.value)} /></label>
      <Button type="button" size="sm" disabled={!newEnvironmentName.trim() || environmentPending} onClick={() => void createEnvironment()}>保存环境</Button>
      <span className="text-[11px] text-muted">名称由你填写，主进程保存并分配 ID；同名环境会被具名拒绝。</span>
    </div>}
    <div className="mt-5 flex flex-wrap gap-1 border-b border-line pb-2" role="group" aria-label="配置作用范围">
      {["任务覆盖", "共享模板", "本机私有配置"].map((scope) => <Button key={scope} type="button" variant="ghost" size="sm" disabled title={scope === "共享模板"
        ? "共享服务模板已在下方接线；环境变量作用域切换未接线"
        : `${scope}的通用项目环境变量操作未接线`}>{scope}</Button>)}
    </div>
    <p data-testid="desktop-environment-unwired-scopes" className="mt-2 text-[11px] text-muted">任务覆盖未接线：Host 无项目环境变量与任务覆盖操作。共享服务模板已接线于下方「服务启动配方」；作用域切换未接线。通用本机私有环境变量未接线：Host 无该变量表操作。</p>
    <section className="mt-5" aria-label="环境变量">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">环境变量 <Badge variant="soft" className="ml-1">未接线</Badge></h2><Button type="button" size="sm" disabled title="Host 尚无项目环境变量读取与变更预览操作">保存更改</Button></div>
      <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[320px] text-left text-xs"><thead className="border-b border-line text-muted"><tr><th className="py-2 font-medium">KEY</th><th className="py-2 font-medium">VALUE</th><th className="py-2 font-medium">生效来源</th></tr></thead><tbody><tr className="border-b border-line"><td colSpan={3} className="py-5 text-muted">Host 尚未提供项目环境变量表、任务覆盖、敏感值遮蔽后的生效配置读取操作。这里不展示示例 KEY 或 VALUE。</td></tr></tbody></table></div>
    </section>
    <ProjectServiceTemplates projectId={projectId} environmentId={selectedEnvironment?.environmentId ?? null} environmentName={selectedEnvironment?.name}
      tasks={tasksPending ? [] : tasks} fillFrom={pendingFill} onFillApplied={appliedFill} />
    <RepositoryImportDrafts tasks={tasks} pending={tasksPending} filled={filledName} onFillForm={setPendingFill} />
  </div>;
}
