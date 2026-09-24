import { useEffect, useState } from "react";
import { Badge, Button, EmptyState } from "../components/ui";
import { Card, PageIntro, PageTitle } from "../components/Management";
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
    <div className="flex flex-col gap-4" data-testid="archive-page">
      <header>
        <PageTitle>已归档</PageTitle>
      </header>
      <PageIntro>
        归档停止运行并保留代码、会话和浏览器状态；清理是另一个操作。恢复任务不自动启动服务或重新启用调度。
      </PageIntro>

      {archived.length === 0 ? (
        <Card>
          <EmptyState>还没有归档任务。可从任务右上角的「···」菜单体验归档。</EmptyState>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {archived.map((task) => {
            const state = states[task.id];
            const error = stateErrors[task.id];
            const summary = state ? lifecycleSummary(state) : null;
            const receipt = state?.cleanup ?? null;
            const directoryCount = task.directories?.length ?? 0;
            const shape =
              task.repos.length > 0 ? `${task.repos.length} 个仓库` : directoryCount > 0 ? `${directoryCount} 个普通目录` : "普通目录";
            return (
              <li key={task.id}>
                <Card>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-[13px] font-[650] text-ink">{task.name}</h3>
                      <small className="text-[11px] text-muted">{shape} · 会话与浏览器状态已保留</small>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="warn">已归档</Badge>
                      <Button size="sm" onClick={() => void restoreTask(task.id)}>
                        恢复任务
                      </Button>
                      <Button size="sm" variant="primary" onClick={() => openModal({ type: "cleanup", taskId: task.id })}>
                        预览清理清单
                      </Button>
                    </div>
                  </div>

                  <p className="mt-3 text-xs text-muted">
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
                  <p className="mt-3 text-[11px] text-muted">
                    整理前先确认未交付范围（未提交与未推送提交）并保留独立副本或所选导出，未清理的归档任务仍然阻止所属项目被删除，清理成功后才解除项目关联。
                  </p>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
