import { Badge, Button, EmptyState, Panel } from "../components/ui";
import { useHostStore } from "../stores/host";
import { useUiStore } from "../stores/ui";

export function ArchivePage() {
  const workspace = useHostStore((state) => state.workspace);
  const archived = (workspace?.tasks ?? []).filter((task) => task.archived);
  const restoreTask = useHostStore((state) => state.restoreTask);
  const openModal = useUiStore((state) => state.openModal);

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-base font-medium text-ink">归档与清理</h1>
        <p className="mt-1 text-xs text-muted">
          归档停止执行、使未执行确认失效并暂停调度；恢复任务不自动启动服务或重新启用调度。清理只面向已归档任务。
        </p>
      </header>

      {archived.length === 0 ? (
        <EmptyState>还没有归档任务。</EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {archived.map((task) => (
            <li key={task.id}>
              <Panel
                title={task.name}
                actions={<Badge tone="warn">已归档</Badge>}
              >
                <p className="text-xs text-muted">
                  工作区 {task.workspaceKey} · 会话 {task.sessions.length} 个 · 归档时间 {task.cleanupAvailableAt?.slice(0, 10) ?? "—"}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => void restoreTask(task.id)}>
                    恢复任务
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => openModal({ type: "cleanup", taskId: task.id })}>
                    预览清理清单
                  </Button>
                </div>
                <p className="mt-2 text-[11px] text-muted">
                  未清理的归档任务仍然阻止所属项目被删除；清理成功后才解除项目关联。
                </p>
              </Panel>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
