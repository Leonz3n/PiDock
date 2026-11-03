import { useState } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Icon } from "./Icon";
import type { DesktopShellProject, DesktopShellTask } from "./DesktopShell";
import type { TaskAssociation } from "../data/desktopProjects";

/**
 * 「未归属任务」— the one view that exists only for tasks no workspace owns
 * (#136 bullet 3). Main decides which rows are claimable; this page never infers
 * an owner from a task name or a path, and an unavailable task cannot be claimed.
 */
export function DesktopUnassignedTasks({
  tasks,
  associations,
  projects,
  lifecyclePending,
  projectsInitialized,
  busy,
  creationIncompleteTaskId,
  onOpenTask,
  onClaim,
  onManage,
}: {
  tasks: readonly DesktopShellTask[];
  associations: readonly TaskAssociation[];
  projects: readonly DesktopShellProject[];
  lifecyclePending: boolean;
  projectsInitialized: boolean;
  busy: boolean;
  creationIncompleteTaskId: string | null;
  onOpenTask: (taskId: string) => void;
  onClaim: (taskId: string, projectId: string) => void;
  /** 项目管理 still owns task-root import and the per-task claim/transfer rows. */
  onManage: () => void;
}) {
  const [choice, setChoice] = useState<Record<string, string>>({});
  const rows = associations.filter((row) => row.projectId === null);
  return (
    <div className="px-[24px] py-[20px] below-narrow:px-4" data-testid="desktop-unassigned">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-[20px] font-semibold tracking-[-0.4px] text-ink">{projectsInitialized ? "未归属任务" : "项目映射未建立"}</h1>
          <p className="mt-1 text-[11px] text-muted">
            {projectsInitialized
              ? "这些任务还没有被用户确认归属。必须由你显式选择一个工作空间认领；不会按名称或路径自动归属。"
              : "本机尚未建立持久工作空间映射。任务以未归属状态列出，不编造归属。"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="soft">{rows.length} 个未归属任务</Badge>
          <Button type="button" size="sm" variant="outline" onClick={onManage}>项目管理</Button>
        </div>
      </div>

      {rows.length === 0 ? <p className="mt-6 text-sm text-muted">已检查的任务根暂无未归属任务。</p> : <ul className="mt-4 flex flex-col gap-2">
        {rows.map((row) => {
          const task = tasks.find((item) => item.taskId === row.taskId);
          const name = task?.name ?? row.taskId;
          const unavailable = row.state === "unavailable";
          const options = projects.filter((project) => project.id !== row.projectId);
          return <li key={row.taskId} className="flex flex-wrap items-center gap-2 rounded-[8px] border border-line bg-paper px-3 py-2" data-unassigned-task={row.taskId}>
            <div className="min-w-[180px] flex-1">
              <strong className="block truncate text-[13px] font-semibold text-ink">{name}</strong>
              <span className="block truncate font-mono text-[10px] text-muted">{row.taskId}{unavailable ? " · 任务不可用，请检查任务根" : ""}</span>
            </div>
            {task ? <span className="truncate text-[10px] text-muted">{task.repoCount > 0 ? `${task.repoCount} 个仓库 · ${task.branch}` : task.branch}</span> : null}
            {row.taskId === creationIncompleteTaskId ? <Badge variant="soft" className="text-[#805c28]">创建未完成 · 到「项目管理」处理</Badge> : null}
            <select aria-label={`${name} 目标工作空间`} className="h-8 max-w-[180px] rounded-[5px] border border-line bg-paper px-2 text-xs text-ink"
              value={choice[row.taskId] ?? ""} disabled={busy || unavailable || lifecyclePending}
              onChange={(event) => setChoice((current) => ({ ...current, [row.taskId]: event.target.value }))}>
              <option value="">选择工作空间</option>
              {options.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <Button type="button" size="sm" variant="default" disabled={busy || unavailable || !choice[row.taskId]}
              onClick={() => { const target = choice[row.taskId]; if (target) onClaim(row.taskId, target); }}>认领</Button>
            <Button type="button" size="sm" variant="outline" disabled={busy || unavailable} onClick={() => onOpenTask(row.taskId)}>
              <Icon name="grid" />进入任务
            </Button>
          </li>;
        })}
      </ul>}
      {projects.length === 0 ? <p className="mt-4 text-[11px] text-muted">还没有可认领的工作空间。先在「{projectsInitialized ? "工作空间" : "项目管理"}」中创建一个。</p> : null}
    </div>
  );
}
