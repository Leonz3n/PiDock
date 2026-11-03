import { useState } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import type { DesktopShellProject } from "./DesktopShell";
import type { TaskAssociation } from "../data/desktopProjects";

/**
 * Deleting a workspace that still owns tasks: the blocker list is main's answer
 * (`{op:"blockers"}`), and each row can be moved to another workspace or unlinked
 * right here. The destructive action only becomes available once nothing blocks
 * it, so the user never gets a bare "project has associated tasks" string.
 */
export function DesktopWorkspaceDeleteDialog({
  projectName,
  tasks,
  projects,
  busy,
  error,
  onCancel,
  onDelete,
  onTransfer,
  onUnlink,
}: {
  projectName: string;
  /** `null` while main's blocker list is being read. */
  tasks: { taskId: string; name: string; state: TaskAssociation["state"] }[] | null;
  projects: readonly DesktopShellProject[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onDelete: () => void;
  onTransfer: (taskId: string, toProjectId: string) => void;
  onUnlink: (taskId: string) => void;
}) {
  const [targets, setTargets] = useState<Record<string, string>>({});
  const blocked = (tasks?.length ?? 0) > 0;
  return (
    <div role="presentation" className="fixed inset-0 z-40 grid place-items-center bg-ink/40 p-4">
      <div role="dialog" aria-modal="true" aria-label={`删除工作空间「${projectName}」`} className="w-full max-w-[560px] rounded-[10px] border border-line bg-paper p-5 shadow-xl">
        <h2 className="text-[15px] font-semibold text-ink">删除工作空间「{projectName}」</h2>
        {tasks === null
          ? <p className="mt-3 text-xs text-muted">正在核对关联任务…</p>
          : blocked
            ? <>
              <p className="mt-2 text-xs text-muted">有 {tasks.length} 个任务仍关联此工作空间。请先为每个任务选择转移或解绑，才能删除工作空间。</p>
              <ul className="mt-3 flex flex-col gap-2">
                {tasks.map((task) => {
                  const unavailable = task.state === "unavailable";
                  const repair = task.state === "needs-repair";
                  return <li key={task.taskId} className="flex flex-wrap items-center gap-2 rounded-[6px] border border-line bg-bg px-2.5 py-2" data-blocking-task={task.taskId}>
                    <div className="min-w-[140px] flex-1">
                      <strong className="block truncate text-[12px] font-semibold text-ink">{task.name}</strong>
                      <span className="block truncate font-mono text-[10px] text-muted">{task.taskId}</span>
                    </div>
                    {repair ? <Badge variant="soft" className="text-[#805c28]">关联待修复</Badge> : null}
                    {unavailable ? <Badge variant="soft" className="text-[#805c28]">任务不可用</Badge> : null}
                    <select aria-label={`${task.name} 转移目标`} className="h-8 max-w-[160px] rounded-[5px] border border-line bg-paper px-2 text-xs"
                      value={targets[task.taskId] ?? ""} disabled={busy || repair || unavailable}
                      onChange={(event) => setTargets((current) => ({ ...current, [task.taskId]: event.target.value }))}>
                      <option value="">转移至…</option>
                      {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                    </select>
                    <Button type="button" size="sm" variant="outline" disabled={busy || repair || unavailable || !targets[task.taskId]}
                      onClick={() => { const target = targets[task.taskId]; if (target) onTransfer(task.taskId, target); }}>转移</Button>
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onUnlink(task.taskId)}>解绑</Button>
                  </li>;
                })}
              </ul>
            </>
            : <p className="mt-2 text-xs text-muted">没有关联任务。删除后无法恢复，但不会删除本机磁盘上的仓库或目录。</p>}
        {error ? <p role="alert" className="mt-3 text-[11px] text-[#ad4545]">{error}</p> : null}
        <div className="mt-4 flex justify-end gap-2 border-t border-line pt-3">
          <Button type="button" onClick={onCancel} disabled={busy}>取消</Button>
          <Button type="button" variant="destructive" disabled={busy || tasks === null || blocked} onClick={onDelete}>删除工作空间</Button>
        </div>
      </div>
    </div>
  );
}
