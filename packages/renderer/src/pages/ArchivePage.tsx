import { useEffect, useState } from "react";
import { Badge, Button, EmptyState, Panel } from "../components/ui";
import { cleanupReceiptLines, cleanupRecoveryLines, lifecycleSummary, resourceIdentityLabel } from "../data/taskLifecycle";
import type { TaskLifecycleState } from "../data/types";
import { useHostStore } from "../stores/host";
import { useUiStore } from "../stores/ui";

/**
 * [PiDock 14] (#17) archive & cleanup page. Each archived task shows the
 * lifecycle readout the Host owns: what archiving kept, the paused schedule,
 * the retained token-usage scope, the cleanup receipt/recovery entries and the
 * worktree/process identity verdicts (never a stale pid or a port).
 */
export function ArchivePage() {
  const workspace = useHostStore((state) => state.workspace);
  const archived = (workspace?.tasks ?? []).filter((task) => task.archived);
  const restoreTask = useHostStore((state) => state.restoreTask);
  const loadLifecycleState = useHostStore((state) => state.loadLifecycleState);
  const openModal = useUiStore((state) => state.openModal);
  const [states, setStates] = useState<Record<string, TaskLifecycleState>>({});
  const [stateErrors, setStateErrors] = useState<Record<string, string>>({});

  const taskIds = archived.map((task) => task.id).join(",");
  useEffect(() => {
    let active = true;
    for (const taskId of taskIds.split(",").filter((id) => id.length > 0)) {
      void loadLifecycleState(taskId)
        .then((state) => {
          if (active) setStates((current) => ({ ...current, [taskId]: state }));
        })
        .catch((error: unknown) => {
          if (!active) return;
          const message = error instanceof Error ? error.message : String(error);
          setStateErrors((current) => ({ ...current, [taskId]: message }));
        });
    }
    return () => {
      active = false;
    };
  }, [loadLifecycleState, taskIds]);

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-base font-medium text-ink">归档与清理</h1>
        <p className="mt-1 text-xs text-muted">
          归档停止执行、使未执行确认失效并暂停调度；恢复任务不自动启动服务或重新启用调度。清理只面向已归档任务，且与归档相互独立。
        </p>
      </header>

      {archived.length === 0 ? (
        <EmptyState>还没有归档任务。</EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {archived.map((task) => {
            const state = states[task.id];
            const error = stateErrors[task.id];
            const summary = state ? lifecycleSummary(state) : null;
            const receipt = state?.cleanup ?? null;
            return (
              <li key={task.id}>
                <Panel title={task.name} actions={<Badge tone="warn">已归档</Badge>}>
                  <p className="text-xs text-muted">
                    工作区 {task.workspaceKey} · 会话 {task.sessions.length} 个 · 归档时间 {task.cleanupAvailableAt?.slice(0, 10) ?? "—"}
                  </p>
                  {error ? <p className="mt-2 text-xs text-orange">生命周期读取失败：{error}</p> : null}
                  {summary ? (
                    <ul className="mt-2 flex flex-col gap-0.5 text-[11px] text-muted">
                      {summary.lines.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                      <li>{summary.scheduleNote}</li>
                      <li>{summary.usageNote}</li>
                    </ul>
                  ) : null}
                  {state && (state.worktrees.length > 0 || state.processes.length > 0) ? (
                    <div className="mt-2 text-[11px] text-muted">
                      <p>资源身份校验（不凭过期进程号或端口认领）</p>
                      <ul className="mt-0.5 flex flex-col gap-0.5">
                        {state.worktrees.map((worktree) => (
                          <li key={`wt-${worktree.repoDir}`}>
                            工作副本 {worktree.repoDir}：{resourceIdentityLabel({ ok: worktree.ok, reason: worktree.reason })}
                          </li>
                        ))}
                        {state.processes.map((process) => (
                          <li key={`${process.kind}-${process.id}`}>
                            {process.kind} {process.id}：{resourceIdentityLabel(process)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {receipt ? (
                    <div className="mt-2 text-[11px] text-muted">
                      <p>清理回执</p>
                      <ul className="mt-0.5 flex flex-col gap-0.5">
                        {cleanupReceiptLines(receipt).map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                        {cleanupRecoveryLines(state?.recovery ?? []).map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => void restoreTask(task.id)}>
                      恢复任务
                    </Button>
                    <Button size="sm" variant="primary" onClick={() => openModal({ type: "cleanup", taskId: task.id })}>
                      预览清理清单
                    </Button>
                  </div>
                  <p className="mt-2 text-[11px] text-muted">
                    整理前先确认未交付范围（未提交与未推送提交）并保留独立副本或所选导出，未清理的归档任务仍然阻止所属项目被删除，清理成功后才解除项目关联。
                  </p>
                </Panel>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
