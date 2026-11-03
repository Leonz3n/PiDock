import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Icon } from "./Icon";
import { SharedRepoIsolation } from "./SharedRepoIsolation";
import { DesktopWorkspaceVariables } from "./DesktopVariables";
import { projectName, sourceName, sourcePath, type DesktopProject, type SourceVerification, type TaskAssociation } from "../data/desktopProjects";
import type { DesktopShellTask } from "./DesktopShell";
import { hostText } from "../data/workspaceFiles";
import { serviceCatalogThroughShell, shellBridge } from "../data/shellBridge";
import { serviceEnvironmentsFromMain, type ServiceEnvironmentView } from "../data/serviceCatalog";

/**
 * What the 运行环境 line states, from these facts only. It reuses the environment
 * page's own answer (`listEnvironments` parsed by `serviceEnvironmentsFromMain`),
 * so the count and the names are main's list, not a derived guess. A refused or
 * unreadable list is named as such — never rendered as "no environments" — and a
 * workspace nobody named an environment in really says it has none.
 */
function environmentReadout({ projectId, connected, environments, error }: {
  projectId: string | undefined;
  connected: boolean;
  environments: ServiceEnvironmentView[] | null;
  error: string | null;
}): { value: string; detail: string; count: boolean } {
  if (projectId === undefined) return { value: "无工作空间上下文", detail: "环境按工作空间保存；「环境与服务」页可查看全部环境。", count: false };
  if (!connected) return { value: "本机未提供环境清单接口", detail: "环境由主进程保存；没有该接口时本页不显示数量。", count: false };
  if (environments === null) return error === null
    ? { value: "正在读取环境清单", detail: "环境由主进程保存，本页只读清单。", count: false }
    : { value: error, detail: "读取失败不等于没有环境；请在「环境与服务」页重试。", count: false };
  if (environments.length === 0) return { value: "尚未创建环境", detail: "在「环境与服务」页新增并命名一个环境。", count: false };
  return { value: String(environments.length), detail: environments.map((row) => row.name).join("、"), count: true };
}

/** S07 `CbsS5`: 复用来源 · 下属任务台账 · 环境与推送. Real Host data only. */
const COLUMNS = "grid grid-cols-[minmax(0,260px)_minmax(0,280px)_minmax(0,1fr)_minmax(0,1fr)_110px] items-center gap-3";
const SECTION = "rounded-[8px] border border-line bg-paper";
const CARD = "flex min-w-0 flex-col gap-1.5 rounded-[8px] border border-line bg-paper p-3";
const CARD_TITLE = "flex min-w-0 items-center gap-2 text-[12px] font-semibold text-ink";
const MONO = "break-all font-mono text-[10px] text-muted";

const STATUS_LABEL: Record<SourceVerification["status"], string> = { ok: "路径可用", missing: "来源缺失", "not-directory": "不是目录" };
function statusTone(status: SourceVerification["status"]): string {
  return status === "ok" ? "text-[#496174]" : "text-[#805c28]";
}

export function DesktopProjectOverview({
  project,
  tasks,
  lifecyclePending,
  associations,
  roots,
  projectsInitialized,
  onOpenTask,
  onManage,
  onCreateTask,
  onEdit,
  onRepairSource,
  onDelete,
  onManageDirectories,
  creationIncompleteTaskId,
  sourceStatus,
  sourceStatusError,
  unassignedCounts,
}: {
  project: DesktopProject | null;
  tasks: readonly DesktopShellTask[];
  lifecyclePending: boolean;
  associations: readonly TaskAssociation[];
  roots: readonly { label: string; state: string }[];
  /** The main-owned Project registry exists. `false` is stated, never faked. */
  projectsInitialized: boolean;
  onOpenTask: (taskId: string) => void;
  onManage: () => void;
  onCreateTask: () => void;
  onEdit: () => void;
  /** Opens the same dialog with this source's path input focused (#136 bullet 4). */
  onRepairSource: (sourceId: string) => void;
  onDelete: () => void;
  onManageDirectories: () => void;
  /**
   * The task whose creation is still unfinished, from main's real pending
   * creation intent (#88); `null` whenever main reports none. The row then says
   * so and points at the management page, where the two exits live.
   */
  creationIncompleteTaskId: string | null;
  /** Per-source verification keyed by main's source id, or `undefined` while unread. */
  sourceStatus: Record<string, SourceVerification> | null;
  sourceStatusError: string | null;
  unassignedCounts: { claimable: number; unavailable: number };
}) {
  const projectId = project?.id;
  const connected = typeof shellBridge()?.serviceCatalogOp === "function";
  const [environmentRows, setEnvironmentRows] = useState<{ projectId: string; values: ServiceEnvironmentView[] } | null>(null);
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const environmentEpoch = useRef(0);
  const environments = projectId !== undefined && environmentRows !== null && environmentRows.projectId === projectId ? environmentRows.values : null;
  const loadEnvironments = useCallback(async (targetProjectId: string) => {
    const request = ++environmentEpoch.current;
    const response = await serviceCatalogThroughShell({ op: "listEnvironments", projectId: targetProjectId });
    if (environmentEpoch.current !== request) return;
    const parsed = response.ok ? serviceEnvironmentsFromMain(response.payload, targetProjectId) : null;
    if (!parsed) {
      setEnvironmentRows(null);
      setEnvironmentError(response.ok ? "环境清单响应无法核对" : "环境清单读取失败");
      return;
    }
    setEnvironmentRows({ projectId: targetProjectId, values: parsed });
  }, []);
  useEffect(() => {
    environmentEpoch.current++;
    setEnvironmentRows(null);
    setEnvironmentError(null);
    if (!projectId || !connected) return;
    void loadEnvironments(projectId);
  }, [projectId, connected, loadEnvironments]);
  const environment = environmentReadout({ projectId, connected, environments, error: environmentError });
  const scoped = tasks.filter((task) => (projectId === undefined ? task.projectId === null : task.projectId === projectId));
  const sourceRows = [
    ...(project?.repositories ?? []).map((row) => ({ row, kind: "repository" as const })),
    ...(project?.directories ?? []).map((row) => ({ row, kind: "directory" as const })),
  ];
  const taskRow = (task: DesktopShellTask) => {
    const association = associations.find((row) => row.taskId === task.taskId);
    const status = task.taskId === creationIncompleteTaskId
      ? { text: "创建未完成", tone: "text-[#805c28]" }
      : association?.state === "needs-repair"
        ? { text: "关联待修复", tone: "text-[#805c28]" }
        : lifecyclePending ? { text: "核验中", tone: "text-muted" } : { text: "进行中", tone: "text-[#496174]" };
    return (
      <li key={task.taskId} className="border-t border-line px-3">
        <div className={`${COLUMNS} min-h-[42px] py-2 text-[11px]`}>
          <div className="min-w-0">
            <strong className="block truncate text-[12px] font-semibold text-ink">{task.name}</strong>
            <span className="block truncate font-mono text-[10px] text-muted">{task.taskId}</span>
          </div>
          <div className="min-w-0">
            <span className="block truncate font-mono text-[11px] text-accent">{hostText(task.branch, "Host 未上报分支")}</span>
            <span className="block truncate text-[10px] text-muted">{task.repoCount > 0 ? `${task.repoCount} 个仓库` : "无仓库来源"}</span>
          </div>
          <span className="min-w-0 truncate text-muted">{hostText(task.updatedAt.slice(0, 10), "Host 未上报更新时间")}</span>
          <span className={`min-w-0 truncate font-semibold ${status.tone}`}>{status.text}</span>
          <span className="justify-self-end"><Button type="button" size="sm" variant="outline" onClick={() => onOpenTask(task.taskId)}>进入任务</Button></span>
        </div>
      </li>
    );
  };

  return (
    <div className="px-[24px] py-[20px] below-narrow:px-4" data-testid="desktop-project-overview">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-[20px] font-semibold tracking-[-0.4px] text-ink" data-testid="overview-title">
            {project ? projectName(project) : projectsInitialized ? "未归属任务" : "项目映射未建立"}
          </h1>
          <p className="mt-1 text-[11px] text-muted">
            {project?.description || (projectsInitialized ? "尚未填写描述与业务用途。" : "本机尚未建立持久工作空间映射；任务以未归属状态列出，不编造归属。")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {project ? <>
            <Button type="button" variant="default" onClick={onCreateTask}><Icon name="plus" />在此工作空间新建任务</Button>
            <Button type="button" onClick={onManageDirectories}><Icon name="plus" />添加来源仓库/目录</Button>
            <Button type="button" onClick={onManage}>项目管理</Button>
            <Button type="button" onClick={onEdit}>编辑工作空间</Button>
            <Button type="button" variant="destructive" onClick={onDelete}>删除</Button>
          </> : <Button type="button" onClick={onManage}>项目管理</Button>}
        </div>
      </div>
      {project ? <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted">
        <Badge variant="soft">
          <span data-testid="overview-repo-count">{project.repositories.length}</span> 来源代码库 · {project.directories.length} 普通目录 ·
          {" "}<span data-testid="overview-task-count">{lifecyclePending ? "未核验" : scoped.length}</span> 进行中的任务
        </Badge>
        <span>磁盘上的身份由 Host 保存；重命名不改变工作空间身份。</span>
      </div> : null}

      {project ? <>
        <section className="mt-5 flex flex-col gap-2" aria-label="复用来源">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <h2 className="text-[12px] font-bold text-ink">工作空间复用来源（Git 仓库与普通目录）</h2>
            <p className="text-[11px] text-muted">下属任务按需选定来源，可选择独立 worktree 或共享已有目录</p>
          </div>
          <div className="grid grid-cols-2 gap-3 below-narrow:grid-cols-1">
            {sourceRows.map(({ row, kind }) => {
              const status = sourceStatus?.[row.id];
              return <div key={row.id} className={CARD} data-source-id={row.id}>
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className={CARD_TITLE}>
                    <Icon name={kind === "repository" ? "branch" : "folder"} className="shrink-0 text-accent" />
                    <span className="truncate">{sourceName(row)}（{kind === "repository" ? "Git 仓库" : "普通目录"}）</span>
                  </span>
                  {status ? <Badge variant="soft" className={statusTone(status.status)}>{STATUS_LABEL[status.status]}</Badge> : <Badge variant="outline">未检查</Badge>}
                </div>
                <span className={MONO}>{sourcePath(row)}</span>
                <span className="text-[10px] text-muted">
                  {kind === "repository" ? "Git 仓库：任务可派生独立 worktree" : "纯普通目录，非 Git 仓库；修改直接作用于原路径（共享原文件 · 需协调写入）"}
                </span>
                {status && status.status !== "ok" ? <div className="flex flex-wrap items-center gap-2">
                  <span role="note" className="text-[10px] text-[#805c28]">
                    来源{status.status === "missing" ? "路径已缺失" : "不是目录"}{status.error ? `（${status.error}）` : ""}，请在编辑工作空间中修复路径。
                  </span>
                  <Button type="button" size="sm" variant="outline" onClick={() => onRepairSource(row.id)}>修复路径</Button>
                </div> : null}
              </div>;
            })}
            {sourceRows.length === 0 ? <p className="text-xs text-muted">尚未登记 Git 仓库或普通目录。</p> : null}
          </div>
          {sourceStatusError ? <p className="text-[10px] text-[#805c28]" data-testid="source-status-error" aria-live="polite">来源检查未完成：{sourceStatusError}</p> : null}
        </section>

        <section className={`mt-5 ${SECTION}`} aria-label="下属任务台账">
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <h2 className="text-[12px] font-bold text-ink">工作空间下属任务台账（点击任务可直接进入任务或对话）</h2>
            <span className="text-[11px] text-muted">共 <span data-testid="overview-task-count-inline">{lifecyclePending ? "未核验" : scoped.length}</span> 个进行中任务</span>
          </div>
          <div className={`${COLUMNS} border-y border-line bg-bg px-3 py-1.5 text-[10px] font-semibold text-muted`} role="row">
            <span role="columnheader">任务名称</span>
            <span role="columnheader">分支与仓库</span>
            <span role="columnheader">最近更新</span>
            <span role="columnheader">状态</span>
            <span role="columnheader" className="justify-self-end">操作</span>
          </div>
          {scoped.length > 0
            ? <ul>{scoped.map(taskRow)}</ul>
            : <p className="px-3 py-4 text-xs text-muted" data-testid="overview-no-tasks">
              {lifecyclePending ? "正在核验任务归档状态；暂不显示进行中任务。" : "这个工作空间还没有进行中任务。"}
            </p>}
        </section>

        <section className={`mt-5 ${SECTION}`} aria-label="环境与推送">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
            <h2 className="text-[12px] font-bold text-ink">工作空间环境与推送规范</h2>
            <span className="text-[11px] text-muted" data-testid="overview-env">
              运行环境：{environment.count ? `${environment.value} 个 · ${environment.detail}` : `${environment.value}${environment.detail ? ` · ${environment.detail}` : ""}`}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-5 p-3 below-narrow:grid-cols-1">
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[12px] font-semibold text-ink">工作空间全局环境变量（下属各任务默认继承）</h3>
                <Button type="button" size="sm" variant="ghost" onClick={onEdit}>管理变量</Button>
              </div>
              {project.environment === null
                ? <div className="rounded-[5px] bg-bg px-3 py-2"><p className="text-[10px] text-muted">Host 未上报环境变量</p></div>
                : <DesktopWorkspaceVariables projectId={project.id} initialRows={project.environment} />}
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[12px] font-semibold text-ink">Git 远程分支模板（推送时按模板建立远端分支）</h3>
                <Button type="button" size="sm" variant="ghost" onClick={onEdit}>编辑模板</Button>
              </div>
              <div className="rounded-[5px] bg-bg px-3 py-2">
                <p className="flex items-center gap-2 text-[10px] text-muted">特性分支模板：<span className="rounded-[3px] border border-line bg-paper px-1.5 py-0.5 font-mono text-[10px] font-semibold text-accent">{project.branchTemplate === null ? "Host 未上报分支模板" : project.branchTemplate}</span></p>
                <p className="mt-1 text-[10px] text-muted">推送仍需你在任务里明确操作触发；此处只保存模板，不会自动推送。</p>
              </div>
            </div>
          </div>
        </section>
      </> : null}

      {project ? <>
        <SharedRepoIsolation tasks={scoped.map((task) => ({ taskId: task.taskId, name: task.name }))} />
        <p className="mt-4 text-[10px] text-muted">
          任务根 {roots.filter((root) => root.state === "ready").length}/{roots.length} 就绪 · 全部数据来自本机真实 Host。
        </p>
      </> : null}

      {unassignedCounts.claimable > 0 || unassignedCounts.unavailable > 0 ? (
        <p className="mt-4 text-[11px] text-muted" data-testid="overview-unassigned">
          {unassignedCounts.claimable > 0 && `另有 ${unassignedCounts.claimable} 个任务尚未归属任何工作空间，可在「未归属任务」中显式认领。`}
          {unassignedCounts.unavailable > 0 && `${unassignedCounts.claimable > 0 ? "其中 " : "另有 "}${unassignedCounts.unavailable} 个任务当前不可用，无法认领，请先检查任务根。`}
        </p>
      ) : null}
    </div>
  );
}
