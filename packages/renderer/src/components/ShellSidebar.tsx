/**
 * Application sidebar ([UI 对齐 01] #25).
 *
 * Three groups, mirroring prototype A: the project views, the running tasks of
 * the selected project (with `+` for a new task and the archive entry), and the
 * machine/system views above the local workspace chip. The card at the top is
 * the workspace picker; it reuses the existing project list modal, so switching
 * workspaces reuses the existing store and adds no backend call.
 */

import { taskCardActivity, taskCardMeta, runningServiceCount } from "../data/shellNav";
import type { Task, Workspace } from "../data/types";
import { Icon, type IconName } from "./Icon";
import { useHostStore } from "../stores/host";
import { ROUTE_LABELS, useNavigationStore, type Route } from "../stores/navigation";
import { useUiStore } from "../stores/ui";

/** Sidebar items carry the route only: the wording stays in `ROUTE_LABELS`. */
type NavItem = { route: Route; icon: IconName };

const NAV_ITEM_CLASS = "flex w-full items-center gap-[10px] rounded-[7px] px-[11px] py-[9px] text-left text-[12px]";

export function ShellSidebar() {
  const route = useNavigationStore((state) => state.route);
  const navigate = useNavigationStore((state) => state.navigate);
  const workspace = useHostStore((state) => state.workspace);
  const localSettings = useHostStore((state) => state.localSettings);
  const attention = useHostStore((state) => state.attention);
  const openModal = useUiStore((state) => state.openModal);

  const projects = workspace?.projects ?? [];
  const routableProjectId = route.view === "project" || route.view === "task" ? route.projectId : undefined;
  const activeProject = projects.find((project) => project.id === routableProjectId) ?? projects[0];
  const activeProjectId = activeProject?.id;
  const activeTaskId = route.view === "task" ? route.taskId : undefined;
  const tasks = (workspace?.tasks ?? []).filter((task) => task.projectId === activeProjectId && !task.archived);

  const workspaceViews: NavItem[] = [
    { route: { view: "project", projectId: activeProjectId ?? "" }, icon: "grid" },
    { route: { view: "env" }, icon: "settings" },
    { route: { view: "usage" }, icon: "chart" },
  ];

  return (
    <aside data-testid="shell-sidebar" className="flex min-h-0 w-[226px] shrink-0 flex-col border-r border-line bg-sidebar px-[13px]">
      <div className="flex h-16 items-center gap-[9px] px-2">
        <span
          aria-hidden
          data-testid="brand-mark"
          className="grid h-9 w-9 place-items-center rounded-full border border-line bg-paper text-base text-accent"
        >
          π
        </span>
        <span className="text-[19px] font-[680] tracking-[-0.8px] text-ink">PiDock</span>
      </div>

      <button
        type="button"
        aria-label={`切换工作区：${activeProject?.name ?? "未选择项目"}`}
        onClick={() => openModal({ type: "project-list" })}
        className="mt-[5px] mb-[18px] flex w-full items-center gap-[9px] rounded-lg border border-line bg-paper p-[10px] text-left hover:border-[#bec0c3]"
      >
        <span
          aria-hidden
          className="grid h-[29px] w-[29px] shrink-0 place-items-center rounded-[7px] bg-[#eaf0f6] font-semibold text-[#61788d]"
        >
          {activeProject?.name.slice(0, 1) ?? "+"}
        </span>
        <span className="flex min-w-0 flex-1 flex-col text-left">
          <strong className="truncate text-[12px] font-semibold text-ink">{activeProject?.name ?? "选择或新建项目"}</strong>
          <small className="truncate text-[10px] text-muted">{activeProject?.description || "管理项目"}</small>
        </span>
        <Icon name="down" className="text-muted" />
      </button>

      <nav aria-label="主导航" className="flex min-h-0 flex-1 flex-col">
        <div data-nav-group="workspace" role="group" aria-label="工作区" className="flex flex-col">
          {workspaceViews.map((item) => (
            <SidebarNavButton
              key={item.route.view}
              item={item}
              active={route.view === item.route.view}
              // 项目总览 needs a selected workspace; without one there is no page to open.
              disabled={item.route.view === "project" && activeProjectId === undefined}
              onSelect={() => navigate(item.route)}
            />
          ))}
        </div>

        <div data-nav-group="tasks" role="group" aria-label="进行中的任务" className="flex min-h-0 flex-col">
          <div className="mt-6 mb-[7px] flex items-center justify-between px-[10px] text-[10px] tracking-[1.4px] text-[#91999f] uppercase">
            <span>进行中的任务</span>
            <button
              type="button"
              aria-label="在当前工作区新建任务"
              title="新建任务"
              onClick={() => openModal({ type: "new-task", projectId: activeProjectId ?? "" })}
              className="grid h-7 w-7 place-items-center rounded-md text-[#69737a] hover:bg-[#e9eded]"
            >
              <Icon name="plus" />
            </button>
          </div>
          <div className="flex min-h-0 flex-col overflow-y-auto">
            {tasks.length === 0 ? <p className="px-[10px] pb-2 text-[10px] text-muted">当前工作区没有进行中的任务。</p> : null}
            {tasks.map((task) => (
              <TaskNavCard
                key={task.id}
                task={task}
                workspace={workspace}
                selected={task.id === activeTaskId && route.view === "task"}
                onSelect={() =>
                  navigate({
                    view: "task",
                    projectId: task.projectId,
                    taskId: task.id,
                    sessionId: task.activeSessionId,
                  })
                }
                onRename={() => openModal({ type: "rename-task", taskId: task.id, value: task.name })}
              />
            ))}
          </div>
          <SidebarNavButton
            item={{ route: { view: "archive" }, icon: "archive" }}
            active={route.view === "archive"}
            onSelect={() => navigate({ view: "archive" })}
          />
        </div>

        <div data-nav-group="system" className="mt-auto border-t border-line pt-[11px]">
          <SidebarNavButton
            item={{ route: { view: "attention" }, icon: "clock" }}
            active={route.view === "attention"}
            count={attention.length}
            onSelect={() => navigate({ view: "attention" })}
          />
          <SidebarNavButton
            item={{ route: { view: "schedules" }, icon: "clock" }}
            active={route.view === "schedules"}
            onSelect={() => navigate({ view: "schedules" })}
          />
          <SidebarNavButton
            item={{ route: { view: "capabilities" }, icon: "book" }}
            active={route.view === "capabilities"}
            onSelect={() => navigate({ view: "capabilities" })}
          />
          <SidebarNavButton
            item={{ route: { view: "remote" }, icon: "globe" }}
            active={route.view === "remote"}
            onSelect={() => navigate({ view: "remote" })}
          />
          <SidebarNavButton
            item={{ route: { view: "settings" }, icon: "folder" }}
            active={route.view === "settings"}
            onSelect={() => navigate({ view: "settings" })}
          />
          <SidebarNavButton
            item={{ route: { view: "providers" }, icon: "key" }}
            active={route.view === "providers"}
            onSelect={() => navigate({ view: "providers" })}
          />
          <div
            data-user-chip="local-workspace"
            title={`本机工作区 · ${localSettings?.workspaceRoot ?? "未设置"}`}
            className="flex items-center gap-[9px] px-2 py-[10px]"
          >
            <span aria-hidden className="grid h-[25px] w-[25px] shrink-0 place-items-center rounded-full bg-[#e3e4e5] text-[10px] text-accent">
              本
            </span>
            <span className="truncate text-[11px] text-ink">{localSettings?.workspaceRoot ?? "未设置"}</span>
            <small className="ml-auto shrink-0 text-[10px] text-muted">本机工作区</small>
          </div>
        </div>
      </nav>
    </aside>
  );
}

function SidebarNavButton({
  item,
  active,
  count,
  disabled,
  onSelect,
}: {
  item: NavItem;
  active: boolean;
  count?: number;
  disabled?: boolean;
  onSelect: () => void;
}) {
  const label = ROUTE_LABELS[item.route.view];
  return (
    <button
      type="button"
      title={label}
      aria-current={active ? "page" : undefined}
      disabled={disabled}
      onClick={onSelect}
      className={`${NAV_ITEM_CLASS} my-0.5 disabled:cursor-default disabled:opacity-45 ${
        active ? "bg-[#e3e6ec] font-semibold text-[#283c6c]" : "text-[#69737a] hover:bg-[#eaebec]"
      }`}
    >
      <Icon name={item.icon} />
      <span>{label}</span>
      {count !== undefined ? (
        <span className="ml-auto rounded-[5px] bg-[#e7eaea] px-1.5 text-[10px]">
          {count}
        </span>
      ) : null}
    </button>
  );
}

function TaskNavCard({
  task,
  workspace,
  selected,
  onSelect,
  onRename,
}: {
  task: Task;
  workspace: Pick<Workspace, "environments" | "schedules"> | undefined;
  selected: boolean;
  onSelect: () => void;
  onRename: () => void;
}) {
  const running = runningServiceCount(task.services) > 0;
  const meta = workspace === undefined ? "" : taskCardMeta(task, workspace);
  const activity = taskCardActivity(task);
  return (
    <button
      type="button"
      data-task-nav={task.id}
      data-services-running={running}
      aria-current={selected ? "page" : undefined}
      onClick={onSelect}
      onContextMenu={(event) => {
        event.preventDefault();
        onRename();
      }}
      className={`mb-[5px] flex w-full flex-col rounded-[7px] border px-[10px] py-[10px] text-left ${
        selected ? "border-[#e5e5e6] bg-paper shadow-sm" : "border-transparent hover:bg-paper"
      }`}
    >
      <span className="flex items-center gap-[9px] text-[12px]">
        {/* Prototype `.dot.live` keeps a 3px halo on the running card. */}
        <span
          aria-hidden
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${running ? "bg-[#425a93] shadow-[0_0_0_3px_#425a9312]" : "bg-[#9aa4ab]"}`}
        />
        <span
          className={`shrink-0 rounded-[4px] border px-1 text-[8px] leading-4 ${
            task.type === "scheduled" ? "border-[#cfd8f1] bg-soft text-accent" : "border-[#d9dde6] bg-[#f8f9fb] text-[#858e9d]"
          }`}
        >
          {task.type === "scheduled" ? "定时" : "普通"}
        </span>
        <span className="truncate text-ink">{task.name}</span>
      </span>
      <span className="mt-1 ml-[14px] flex justify-between gap-2 text-[10px] text-[#959da2]">
        <span className="truncate">{meta}</span>
        <span>{activity}</span>
      </span>
    </button>
  );
}
