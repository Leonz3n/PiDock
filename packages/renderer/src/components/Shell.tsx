import { ShellSidebar } from "./ShellSidebar";
import { ShellSummaryBar } from "./ShellSummaryBar";
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
import { ROUTE_LABELS, useNavigationStore } from "../stores/navigation";

export function Shell() {
  const route = useNavigationStore((state) => state.route);
  const workspace = useHostStore((state) => state.workspace);

  const activeTaskId = route.view === "task" ? route.taskId : undefined;
  const activeTask = workspace?.tasks.find((item) => item.id === activeTaskId);
  const sessionId =
    route.view === "task"
      ? activeTask?.sessions.some((session) => session.id === route.sessionId)
        ? route.sessionId
        : (activeTask?.activeSessionId ?? "")
      : undefined;

  return (
    <div className="flex h-screen overflow-hidden bg-bg pb-[57px] text-ink">
      <ShellSidebar />

      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-paper">
        <Breadcrumbs />
        {/* Prototype `.page`: `30px 34px`, `25px` below 960px and `20px` below 720px. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-[#fbfbfc] px-[34px] py-[30px] below-mid:px-[25px] below-stack:p-5">
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

      <ShellSummaryBar />
    </div>
  );
}

/** The prototype's topbar: `工作区 / <项目名> / <页面或任务>`. */
function Breadcrumbs() {
  const route = useNavigationStore((state) => state.route);
  const workspace = useHostStore((state) => state.workspace);
  const project =
    route.view === "project" || route.view === "task"
      ? workspace?.projects.find((item) => item.id === route.projectId)
      : workspace?.projects[0];
  const task = route.view === "task" ? workspace?.tasks.find((item) => item.id === route.taskId) : undefined;
  const label: string =
    route.view === "task"
      ? (task?.name ?? ROUTE_LABELS.task)
      : route.view === "project"
        ? (project?.name ?? ROUTE_LABELS.project)
        : ROUTE_LABELS[route.view];
  const connected = typeof window !== "undefined" && typeof window.pidock === "object" && window.pidock !== null;
  return (
    <div
      data-testid="breadcrumb"
      className="flex h-[49px] min-h-[49px] items-center justify-between gap-3 border-b border-line px-[25px] text-[11px] text-[#8b9298]"
    >
      <span className="flex items-center gap-2">
        <span>工作区</span>
        <span aria-hidden>/</span>
        <strong className="font-medium text-[#586169]">{project?.name ?? "未选择工作区"}</strong>
        <span aria-hidden>/</span>
        <span>{label}</span>
      </span>
      <span>{connected ? "已连接桌面壳 Host" : "内存模拟数据 · 未连接 Host"}</span>
    </div>
  );
}
