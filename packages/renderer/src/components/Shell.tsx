import { Badge } from "./ui";
import { AttentionPage } from "../pages/AttentionPage";
import { ArchivePage } from "../pages/ArchivePage";
import { CapabilitiesPage } from "../pages/CapabilitiesPage";
import { EnvPage } from "../pages/EnvPage";
import { ProjectPage } from "../pages/ProjectPage";
import { ProvidersPage } from "../pages/ProvidersPage";
import { RemotePage } from "../pages/RemotePage";
import { SchedulesPage } from "../pages/SchedulesPage";
import { SettingsPage } from "../pages/SettingsPage";
import { TaskPage } from "../pages/TaskPage";
import { UsagePage } from "../pages/UsagePage";
import { useHostStore } from "../stores/host";
import { useNavigationStore, type Route } from "../stores/navigation";
import { useUiStore } from "../stores/ui";

const navItems: { label: string; route: Route }[] = [
  { label: "需要处理", route: { view: "attention" } },
  { label: "环境与服务", route: { view: "env" } },
  { label: "Provider 与上下文", route: { view: "providers" } },
  { label: "Token 用量", route: { view: "usage" } },
  { label: "定时任务", route: { view: "schedules" } },
  { label: "能力管理", route: { view: "capabilities" } },
  { label: "远程访问", route: { view: "remote" } },
  { label: "归档与清理", route: { view: "archive" } },
  { label: "本机设置", route: { view: "settings" } },
];

export function Shell() {
  const route = useNavigationStore((state) => state.route);
  const navigate = useNavigationStore((state) => state.navigate);
  const workspace = useHostStore((state) => state.workspace);
  const attention = useHostStore((state) => state.attention);
  const openModal = useUiStore((state) => state.openModal);

  const activeProjectId = route.view === "project" || route.view === "task" ? route.projectId : undefined;
  const activeTaskId = route.view === "task" ? route.taskId : undefined;
  const activeTask = workspace?.tasks.find((item) => item.id === activeTaskId);
  const sessionId =
    route.view === "task"
      ? activeTask?.sessions.some((session) => session.id === route.sessionId)
        ? route.sessionId
        : (activeTask?.activeSessionId ?? "")
      : undefined;

  return (
    <div className="flex h-screen overflow-hidden bg-bg text-ink">
      <aside className="flex w-[248px] shrink-0 flex-col gap-4 border-r border-line bg-sidebar px-3 py-4">
        <div className="flex flex-col items-center gap-1">
          <span
            aria-hidden
            data-testid="brand-mark"
            className="grid h-9 w-9 place-items-center rounded-full border border-line bg-paper text-base text-accent"
          >
            π
          </span>
          <span className="text-xs tracking-[0.3em] text-muted">PIDOCK</span>
        </div>

        <nav aria-label="主导航" className="flex flex-col gap-0.5">
          {navItems.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => navigate(item.route)}
              className={`flex items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs ${
                route.view === item.route.view ? "bg-accent/10 text-accent" : "text-muted hover:bg-soft hover:text-ink"
              }`}
            >
              <span>{item.label}</span>
              {item.route.view === "attention" && attention.length > 0 ? <Badge tone="warn">{attention.length}</Badge> : null}
            </button>
          ))}
        </nav>

        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <h2 className="px-2.5 text-[11px] tracking-wide text-muted">项目与任务</h2>
          <div className="flex flex-col gap-2 overflow-auto pr-1">
            {(workspace?.projects ?? []).map((project) => (
              <div key={project.id}>
                <button
                  type="button"
                  onClick={() => navigate({ view: "project", projectId: project.id })}
                  className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs ${
                    activeProjectId === project.id ? "text-accent" : "text-ink hover:bg-soft"
                  }`}
                >
                  <span>{project.name}</span>
                </button>
                <ul className="mt-0.5 flex flex-col gap-0.5 pl-2">
                  {(workspace?.tasks ?? [])
                    .filter((task) => task.projectId === project.id)
                    .map((task) => (
                      <li key={task.id} className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() =>
                            navigate({ view: "task", projectId: project.id, taskId: task.id, sessionId: task.activeSessionId })
                          }
                          onContextMenu={(event) => {
                            event.preventDefault();
                            openModal({ type: "rename-task", taskId: task.id, value: task.name });
                          }}
                          className={`flex flex-1 items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-xs ${
                            activeTaskId === task.id ? "bg-accent/10 text-accent" : "text-muted hover:bg-soft hover:text-ink"
                          }`}
                        >
                          <span className="truncate">{task.name}</span>
                          <span className="flex items-center gap-1">
                            {task.archived ? <Badge>已归档</Badge> : null}
                            {task.unread > 0 ? <Badge tone="accent">{task.unread}</Badge> : null}
                          </span>
                        </button>
                        <button
                          type="button"
                          aria-label={`任务操作：${task.name}`}
                          onClick={() => openModal({ type: "rename-task", taskId: task.id, value: task.name })}
                          className="rounded px-1 text-xs text-muted hover:bg-soft hover:text-ink"
                        >
                          ⋯
                        </button>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 px-6 py-5">
        <Breadcrumbs />
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          {route.view === "task" && activeTask ? <TaskPage task={activeTask} sessionId={sessionId ?? activeTask.activeSessionId} /> : null}
          {route.view === "attention" ? <AttentionPage /> : null}
          {route.view === "project" ? <ProjectPage projectId={route.projectId} /> : null}
          {route.view === "env" ? <EnvPage /> : null}
          {route.view === "providers" ? <ProvidersPage /> : null}
          {route.view === "usage" ? <UsagePage /> : null}
          {route.view === "schedules" ? <SchedulesPage /> : null}
          {route.view === "capabilities" ? <CapabilitiesPage /> : null}
          {route.view === "remote" ? <RemotePage /> : null}
          {route.view === "archive" ? <ArchivePage /> : null}
          {route.view === "settings" ? <SettingsPage /> : null}
          {route.view === "task" && !activeTask ? <p className="text-xs text-muted">任务不存在或已被移除。</p> : null}
        </div>
      </main>
    </div>
  );
}

function Breadcrumbs() {
  const route = useNavigationStore((state) => state.route);
  const workspace = useHostStore((state) => state.workspace);
  const project = route.view === "project" || route.view === "task" ? workspace?.projects.find((item) => item.id === route.projectId) : undefined;
  const task = route.view === "task" ? workspace?.tasks.find((item) => item.id === route.taskId) : undefined;
  const label = {
    attention: "需要处理",
    project: project?.name ?? "项目",
    task: `${project?.name ?? "项目"} / ${task?.name ?? "任务"}`,
    env: "环境与服务",
    providers: "Provider 与上下文",
    usage: "Token 用量",
    schedules: "定时任务",
    capabilities: "能力管理",
    remote: "远程访问",
    archive: "归档与清理",
    settings: "本机设置",
  }[route.view];
  const connected = typeof window !== "undefined" && typeof window.pidock === "object" && window.pidock !== null;
  return (
    <div className="flex items-center justify-between gap-3 text-xs text-muted">
      <span>{label}</span>
      <span>{connected ? "已连接桌面壳 Host" : "内存模拟数据 · 未连接 Host"}</span>
    </div>
  );
}
