import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import type { DesktopProject, TaskAssociation } from "../data/desktopProjects";
import type { DesktopShellTask } from "./DesktopShell";

/**
 * [UI 对齐 S8e] #47 `项目总览`，结构照 `prototypes/pidock-ui/management.js` 的
 * `managementProjectPage()`：view-label `PROJECT` + 项目名 + 项目管理/新建任务、
 * 一句描述、三张统计卡（进行中的任务 / 已绑定仓库 / 运行环境）、「继续工作」的
 * 任务卡网格、「项目仓库」列表。
 *
 * 真实数据边界：任务与仓库计数来自本机 Project 记录与任务清单；**运行环境**
 * 尚无 Host 侧数据来源，因此这一格显示 `未接线` 而不是编一个数字。
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
}) {
  const projectId = project?.id;
  const scoped = tasks.filter((task) => (projectId === undefined ? task.projectId === null : task.projectId === projectId));
  const unassigned = associations.filter((row) => row.projectId === null);
  return (
    <div className="px-[34px] py-[30px] below-narrow:px-5" data-testid="desktop-project-overview">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] tracking-[1.8px] text-[#95979c] uppercase">Project</p>
          <h1 className="mt-1.5 truncate text-[26px] font-semibold tracking-[-0.6px] text-ink">{project ? project.name : projectsInitialized ? "未归属任务" : "项目映射未建立"}</h1>
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
        <div className="rounded-[9px] border border-line bg-paper p-5">
          <p className="text-[11px] text-muted">运行环境</p>
          <p className="mt-1.5 text-[15px] font-semibold text-[#95979c]" data-testid="overview-env-unwired">未接线</p>
          <p className="mt-1 text-[10px] text-muted">Host 尚未提供本机环境清单，这里不编造数量。</p>
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
              {task.repoCount > 0 ? `${task.repoCount} 仓库 · ${task.branch}` : "普通目录"}
            </p>
            <span className="mt-2 inline-flex"><Badge>{task.updatedAt.slice(0, 10)}</Badge></span>
          </button>
        ))}
        {scoped.length === 0 && (
          <p className="text-xs text-muted" data-testid="overview-no-tasks">
            {lifecyclePending ? "正在核验任务归档状态；暂不显示进行中任务。" : "这个项目还没有进行中任务。"}
          </p>
        )}
      </div>

      <div className="mt-7 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold text-ink">项目仓库与目录</h2>
        <Button type="button" size="sm" onClick={onManageDirectories}>管理仓库</Button>
      </div>
      <div className="mt-3 flex flex-col gap-2">
        {(project?.repositories ?? []).map((source) => (
          <div key={source.id} className="flex items-center gap-3 rounded-[7px] border border-line bg-paper px-3 py-2 text-xs">
            <span aria-hidden className="text-muted">▸</span>
            <strong className="truncate font-semibold text-ink">{source.name}</strong>
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted">{source.path}</span>
          </div>
        ))}
        {(project?.directories ?? []).map((source) => (
          <div key={source.id} className="flex items-center gap-3 rounded-[7px] border border-line bg-paper px-3 py-2 text-xs">
            <span aria-hidden className="text-muted">▸</span>
            <strong className="truncate font-semibold text-ink">{source.name}</strong>
            <Badge variant="soft">普通目录</Badge>
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted">{source.path}</span>
          </div>
        ))}
        {project !== null && project.repositories.length === 0 && project.directories.length === 0 && (
          <p className="text-xs text-muted">尚未绑定仓库或目录。</p>
        )}
      </div>

      {unassigned.length > 0 && (
        <p className="mt-6 text-[11px] text-muted" data-testid="overview-unassigned">
          另有 {unassigned.length} 个任务尚未归属任何项目，可在「项目管理」里认领或新建任务。
        </p>
      )}
      <p className="mt-6 text-[10px] text-muted">
        任务根 {roots.filter((root) => root.state === "ready").length}/{roots.length} 就绪 · 全部数据来自本机真实 Host。
      </p>
    </div>
  );
}
