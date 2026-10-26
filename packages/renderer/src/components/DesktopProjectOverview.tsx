import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { SharedRepoIsolation } from "./SharedRepoIsolation";
import { projectName, type DesktopProject, type TaskAssociation } from "../data/desktopProjects";
import type { DesktopShellTask } from "./DesktopShell";
import { hostText } from "../data/workspaceFiles";
import { serviceCatalogThroughShell, shellBridge } from "../data/shellBridge";
import { serviceEnvironmentsFromMain, type ServiceEnvironmentView } from "../data/serviceCatalog";

/**
 * What the 运行环境 card states, from these facts only. It reuses the environment
 * page's own answer (`listEnvironments` parsed by `serviceEnvironmentsFromMain`),
 * so the count and the names are main's list, not a derived guess. A refused or
 * unreadable list is named as such — never rendered as "no environments" — and a
 * project nobody named an environment in really says it has none.
 */
function environmentReadout({ projectId, connected, environments, error }: {
  projectId: string | undefined;
  connected: boolean;
  environments: ServiceEnvironmentView[] | null;
  error: string | null;
}): { value: string; detail: string; count: boolean } {
  if (projectId === undefined) return { value: "无项目上下文", detail: "环境按项目保存；「环境与服务」页可查看全部项目环境。", count: false };
  if (!connected) return { value: "本机未提供环境清单接口", detail: "环境由主进程保存；没有该接口时本页不显示数量。", count: false };
  if (environments === null) return error === null
    ? { value: "正在读取环境清单", detail: "环境由主进程保存，本页只读清单。", count: false }
    : { value: error, detail: "读取失败不等于没有环境；请在「环境与服务」页重试。", count: false };
  if (environments.length === 0) return { value: "尚未创建环境", detail: "在「环境与服务」页新增并命名一个环境。", count: false };
  return { value: String(environments.length), detail: environments.map((row) => row.name).join("、"), count: true };
}

/**
 * [UI 对齐 S8e] #47 `项目总览`，结构照 `prototypes/pidock-ui/management.js` 的
 * `managementProjectPage()`：view-label `PROJECT` + 项目名 + 项目管理/新建任务、
 * 一句描述、三张统计卡（进行中的任务 / 已绑定仓库 / 运行环境）、「继续工作」的
 * 任务卡网格、「项目仓库」列表。
 *
 * 真实数据边界：任务与仓库计数来自本机 Project 记录与任务清单；**运行环境**
 * 与环境页同源（`shell/serviceCatalogOp {op:"listEnvironments"}` +
 * `serviceEnvironmentsFromMain`），名称与数量都是主进程的清单原文。读不到时
 * 说读不到，空清单说空清单：这一格从不编一个数字，也不再声称未接线。
 */
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
  onManageDirectories,
  creationIncompleteTaskId,
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
  onManageDirectories: () => void;
  /**
   * The task whose creation is still unfinished, from main's real pending
   * creation intent (#88); `null` whenever main reports none. The card then says
   * so and points at the management page, where the two exits live — a task that
   * cannot be finished should not look like an ordinary one.
   */
  creationIncompleteTaskId: string | null;
}) {
  const projectId = project?.id;
  const connected = typeof shellBridge()?.serviceCatalogOp === "function";
  // The same read `DesktopEnvironmentPage` performs: main's own environment list,
  // parsed by the same adapter. The overview only reads; it never creates,
  // renames or selects an environment.
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
      // A refused or unreadable list is named, never rendered as "no environments".
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
  // `projectId === null` also covers rows the Host marks `unavailable`; those rows cannot be
  // claimed (DesktopInventory disables their 认领/转移/进入工作区 controls), so counting them
  // as claimable would tell the user to claim tasks they cannot (#41 audit P2). Split it.
  const unassignedRows = associations.filter((row) => row.projectId === null);
  const claimableUnassigned = unassignedRows.filter((row) => row.state === "unassigned").length;
  const unavailableUnassigned = unassignedRows.length - claimableUnassigned;
  return (
    <div className="px-[34px] py-[30px] below-narrow:px-5" data-testid="desktop-project-overview">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] tracking-[1.8px] text-[#95979c] uppercase">Project</p>
          <h1 className="mt-1.5 truncate text-[26px] font-semibold tracking-[-0.6px] text-ink">{project ? projectName(project) : projectsInitialized ? "未归属任务" : "项目映射未建立"}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={onManage}>项目管理</Button>
          <Button type="button" variant="default" onClick={onCreateTask}>新建任务</Button>
        </div>
      </div>
      <p className="mt-1.5 mb-6 text-xs text-muted">
        {project?.description || (projectsInitialized ? "在项目中组织仓库、任务与运行环境。" : "本机尚未建立持久项目映射；任务以未归属状态列出，不编造项目归属。")}
      </p>

      <div className="grid grid-cols-3 gap-4 below-mid:grid-cols-1">
        <div className="rounded-[9px] border border-line bg-paper p-5">
          <p className="text-[11px] text-muted">进行中的任务</p>
          <p className="mt-1.5 text-[26px] font-semibold text-ink" data-testid="overview-task-count">{lifecyclePending ? "未核验" : scoped.length}</p>
        </div>
        <div className="rounded-[9px] border border-line bg-paper p-5">
          <p className="text-[11px] text-muted">已绑定仓库</p>
          <p className="mt-1.5 text-[26px] font-semibold text-ink" data-testid="overview-repo-count">{project ? project.repositories.length : 0}</p>
          <p className="mt-1 text-[10px] text-muted">普通目录 {project ? project.directories.length : 0} 个</p>
        </div>
        <div className="rounded-[9px] border border-line bg-paper p-5" data-testid="overview-env">
          <p className="text-[11px] text-muted">运行环境</p>
          <p className={`mt-1.5 font-semibold ${environment.count ? "text-[26px] text-ink" : "text-[15px] text-[#95979c]"}`}>{environment.value}</p>
          <p className="mt-1 text-[10px] text-muted">{environment.detail}</p>
        </div>
      </div>

      <h2 className="mt-7 mb-3 text-[13px] font-semibold text-ink">继续工作</h2>
      <div className="grid grid-cols-2 gap-4 below-mid:grid-cols-1">
        {scoped.map((task) => (
          <button
            key={task.taskId}
            type="button"
            data-overview-task={task.taskId}
            onClick={() => onOpenTask(task.taskId)}
            className="min-w-0 rounded-[9px] border border-line bg-paper p-4 text-left hover:border-[#bec0c3]"
          >
            <h3 className="truncate text-[13px] font-semibold text-ink">{task.name}</h3>
            <p className="mt-1.5 truncate text-[11px] text-muted">
              {task.repoCount > 0 ? `${task.repoCount} 仓库 · ${hostText(task.branch, "Host 未上报分支")}` : "普通目录"}
            </p>
            {task.taskId === creationIncompleteTaskId && <p className="mt-1.5 text-[11px] font-semibold text-[#9a6032]">创建未完成 · 到「项目管理」恢复完成或放弃</p>}
            <span className="mt-2 inline-flex"><Badge>{hostText(task.updatedAt.slice(0, 10), "Host 未上报更新时间")}</Badge></span>
          </button>
        ))}
        {scoped.length === 0 && (
          <p className="text-xs text-muted" data-testid="overview-no-tasks">
            {lifecyclePending ? "正在核验任务归档状态；暂不显示进行中任务。" : "这个项目还没有进行中任务。"}
          </p>
        )}
      </div>

      {/* [PiDock 03] (#6 盒子 6) the tasks above are already shown together; this
          is the readout that keeps their shared repositories apart, and the
          plain-directory link that is NOT isolated. */}
      <SharedRepoIsolation tasks={scoped.map((task) => ({ taskId: task.taskId, name: task.name }))} />

      <div className="mt-7 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold text-ink">项目仓库与目录</h2>
        <Button type="button" size="sm" onClick={onManageDirectories}>管理仓库</Button>
      </div>
      <div className="mt-3 flex flex-col gap-2">
        {(project?.repositories ?? []).map((source) => (
          <div key={source.id} className="flex items-center gap-3 rounded-[7px] border border-line bg-paper px-3 py-2 text-xs">
            <span aria-hidden className="text-muted">▸</span>
            <strong className="truncate font-semibold text-ink">{hostText(source.name, "Host 未上报来源名称")}</strong>
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted">{hostText(source.path, "Host 未上报来源路径")}</span>
          </div>
        ))}
        {(project?.directories ?? []).map((source) => (
          <div key={source.id} className="flex items-center gap-3 rounded-[7px] border border-line bg-paper px-3 py-2 text-xs">
            <span aria-hidden className="text-muted">▸</span>
            <strong className="truncate font-semibold text-ink">{hostText(source.name, "Host 未上报来源名称")}</strong>
            <Badge variant="soft">普通目录</Badge>
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted">{hostText(source.path, "Host 未上报来源路径")}</span>
          </div>
        ))}
        {project !== null && project.repositories.length === 0 && project.directories.length === 0 && (
          <p className="text-xs text-muted">尚未绑定仓库或目录。</p>
        )}
      </div>

      {unassignedRows.length > 0 && (
        <p className="mt-6 text-[11px] text-muted" data-testid="overview-unassigned">
          {claimableUnassigned > 0 && `另有 ${claimableUnassigned} 个任务尚未归属任何项目，可在「项目管理」里认领或新建任务。`}
          {unavailableUnassigned > 0 && `${claimableUnassigned > 0 ? "其中 " : "另有 "}${unavailableUnassigned} 个任务当前不可用，无法认领，请先检查任务根。`}
        </p>
      )}
      <p className="mt-6 text-[10px] text-muted">
        任务根 {roots.filter((root) => root.state === "ready").length}/{roots.length} 就绪 · 全部数据来自本机真实 Host。
      </p>
    </div>
  );
}
