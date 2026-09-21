import { Badge, Button, Panel } from "../components/ui";
import { useHostStore } from "../stores/host";
import { useNavigationStore } from "../stores/navigation";
import { useUiStore } from "../stores/ui";

export function ProjectPage({ projectId }: { projectId: string }) {
  const project = useHostStore((state) => state.workspace?.projects.find((item) => item.id === projectId));
  const workspace = useHostStore((state) => state.workspace);
  const navigate = useNavigationStore((state) => state.navigate);
  const openModal = useUiStore((state) => state.openModal);

  if (!project) return <p className="text-xs text-muted">项目不存在。</p>;

  const tasks = (workspace?.tasks ?? []).filter((task) => task.projectId === project.id);
  const environments = (workspace?.environments ?? []).filter((environment) => environment.projectId === project.id);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-base font-medium text-ink">{project.name}</h1>
          <p className="mt-1 text-xs text-muted">项目保存仓库、普通目录、服务与按环境组织的共享模板；任务按需选择其中一部分。</p>
        </div>
        <Button size="sm" variant="primary" onClick={() => openModal({ type: "new-task", projectId: project.id })}>
          新建任务
        </Button>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="仓库">
          <ul className="flex flex-col gap-1.5 text-xs">
            {project.repositories.map((repository) => (
              <li key={repository.id} className="flex items-center justify-between gap-2 border-b border-line pb-1.5">
                <span className="font-mono text-[11px] text-ink">{repository.name}</span>
                <span className="text-muted">基线 {repository.baseBranch}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-muted">任务使用仓库时创建独立 worktree；同一仓库参与不同任务拥有独立分支与目录。</p>
        </Panel>

        <Panel title="普通目录">
          {project.directories.length === 0 ? (
            <p className="text-xs text-muted">该项目没有普通目录。普通目录的原始文件在任务之间共享，不承诺隔离。</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-xs">
              {project.directories.map((directory) => (
                <li key={directory} className="font-mono text-[11px] text-muted">
                  {directory}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={`任务 · ${tasks.length}`}>
          <ul className="flex flex-col gap-2 text-xs">
            {tasks.map((task) => (
              <li key={task.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-2.5 py-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-ink">{task.name}</span>
                    {task.archived ? <Badge tone="warn">已归档</Badge> : null}
                    {task.unread > 0 ? <Badge tone="accent">{task.unread} 条未读</Badge> : null}
                  </div>
                  <p className="mt-1 text-[11px] text-muted">
                    {task.workspaceKey} · {task.repos.length} 个仓库 · {task.sessions.length} 个会话
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={() => navigate({ view: "task", projectId: project.id, taskId: task.id, sessionId: task.activeSessionId })}
                >
                  打开任务
                </Button>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="环境">
          <ul className="flex flex-col gap-1.5 text-xs">
            {environments.map((environment) => (
              <li key={environment.id} className="flex items-center justify-between gap-2">
                <span className="text-ink">{environment.name}</span>
                <span className="text-muted">共享模板 {environment.templateVersion}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-muted">不同任务可以选择同一个环境，同时拥有各自的本地服务实例。</p>
        </Panel>
      </div>
    </div>
  );
}
