/** Workspace shell aligned with Pencil S01/S06; management replaces the whole window. */
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { SidebarMenu, type SidebarAction, type SidebarMenuItem } from "./SidebarMenu";
import { Button } from "./ui/button";
import { Icon, type IconName } from "./Icon";
import { cn } from "../lib/utils";
import { readTaskSessions, subscribeSessionWrites, type SessionList } from "../data/taskSessions";

export interface DesktopShellTask {
  taskId: string;
  name: string;
  branch: string;
  repoCount: number;
  updatedAt: string;
  /** Owning Project, or `null` for an explicitly unassigned task. */
  projectId: string | null;
}

export interface DesktopShellProject {
  id: string;
  name: string;
  description: string;
  /** Tasks main reports for this workspace; `null` while the lifecycle read is unverified. */
  taskCount: number | null;
}

/** Pages the shell can show; each nav entry names its own real page. */
export type DesktopView =
  | { view: "project"; projectId: string }
  | { view: "unassigned" }
  // [#139] A task page may name the session it opens; omitting it opens the
  // task facts. A session id explicitly enters its conversation.
  | { view: "task"; taskId: string; sessionId?: string }
  | { view: "usage" }
  | { view: "schedules" }
  | { view: "archive" }
  | { view: "attention" }
  | { view: "env" }
  | { view: DesktopLocalPageKey };

const LABELS: Record<DesktopLocalPageKey, string> = { capabilities: "能力管理", settings: "设置" };
export type DesktopLocalPageKey = "capabilities" | "settings";

type DesktopRoot = { label: string; state: "ready" | "error"; message?: string };

export function DesktopRootErrors({ roots, busy, retryPending, retryError, onRetry, className }: {
  roots: DesktopRoot[];
  busy: boolean;
  retryPending: boolean;
  retryError: string | null;
  onRetry: () => void;
  className?: string;
}) {
  return <div className={className} aria-busy={retryPending}>
    {roots.filter((root) => root.state === "error").map((root) => <div role="alert" key={root.label} className="flex min-w-0 items-center gap-2 py-2 text-[11px] text-destructive">
      <span className="min-w-0 flex-1 break-words">{root.label}：{root.message}</span>
      <Button type="button" variant="outline" aria-label={`重试读取${root.label}`} title={`重试读取${root.label}`} disabled={busy} onClick={onRetry} className="h-8 w-8 shrink-0 rounded-[5px] p-0">
        <Icon name="refresh" className={retryPending ? "animate-spin" : undefined} />
      </Button>
    </div>)}
    {roots.filter((root) => root.state !== "error" && root.message).map((root) => <p role="status" key={root.label} className="border-b border-line py-2 text-[11px] text-orange">
      {root.label}：{root.message}
    </p>)}
    {retryPending && <p role="status" className="pb-2 text-[11px] text-muted">正在重读任务根</p>}
    {retryError && <p role="alert" className="pb-2 text-[11px] text-destructive">{retryError}</p>}
  </div>;
}

export function DesktopShell({
  view,
  onNavigate,
  projects,
  projectsInitialized,
  unassignedCount,
  onNewWorkspace,
  onWorkspaceAction,
  onSidebarAction,
  tasks,
  allTaskCount,
  lifecyclePending,
  lifecycleErrors,
  roots,
  rootRetry,
  breadcrumb,
  onNewTask,
  management,
  headerActions,
  headerFacts,
  children,
}: {
  view: DesktopView;
  onNavigate: (next: DesktopView) => void;
  projects: DesktopShellProject[];
  /** Whether main's registry exists; `false` is stated in the sidebar, never faked. */
  projectsInitialized: boolean;
  /** Unassigned tasks main reports; `null` while unverified. */
  unassignedCount: number | null;
  /** The S10 create dialog; the shell offers it next to the workspace tree. */
  onNewWorkspace?: () => void;
  onWorkspaceAction?: (projectId: string, action: "edit" | "new-task" | "remove") => void;
  onSidebarAction?: (action: Omit<SidebarAction, "token">) => void;
  tasks: DesktopShellTask[];
  allTaskCount: number;
  lifecyclePending: boolean;
  lifecycleErrors: string[];
  /** Real task-root labels; a broken root is surfaced, never hidden. */
  roots: DesktopRoot[];
  rootRetry: { busy: boolean; pending: boolean; error: string | null; run: () => void };
  /** Real names for the header breadcrumb; omitted parts stay hidden. */
  breadcrumb: { project?: string; task?: string; page?: string };
  onNewTask?: () => void;
  management?: ReactNode;
  headerActions?: ReactNode;
  headerFacts?: ReactNode;
  children: ReactNode;
}) {
  const managementOpen = Boolean(management);
  const workspaceFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (managementOpen || !workspaceFocus.current) return;
    // Wait until the workspace is painted again; Chromium refuses focus while
    // the previously hidden management replacement is still being laid out.
    const target = workspaceFocus.current;
    const frame = requestAnimationFrame(() => {
      if (target.isConnected) target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [managementOpen]);
  const activeTaskId = view.view === "task" ? view.taskId : undefined;
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [railExpanded, setRailExpanded] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [sessions, setSessions] = useState<Record<string, SessionList | string>>({});
  const [showArchived, setShowArchived] = useState(false);
  const [revision, setRevision] = useState(0);
  const taskIds = tasks.map((task) => task.taskId).join(",");
  useEffect(() => subscribeSessionWrites(() => setRevision((value) => value + 1)), []);
  useEffect(() => {
    let live = true;
    for (const taskId of taskIds.split(",").filter(Boolean)) {
      void readTaskSessions(taskId).then((result) => {
        if (live) setSessions((current) => ({ ...current, [taskId]: result.ok ? result.list : result.error }));
      });
    }
    return () => { live = false; };
  }, [taskIds, revision]);
  const needle = query.trim().toLocaleLowerCase();
  const matches = (name: string) => name.toLocaleLowerCase().includes(needle);
  const visibleTasks = tasks.filter((task) => {
    const list = sessions[task.taskId];
    return !needle || matches(task.name) || matches(projects.find((project) => project.id === task.projectId)?.name ?? "未归属任务") ||
      (typeof list === "object" && list.sessions.some((session) => (showArchived || !session.archived) && matches(session.name)));
  });
  const toggle = (id: string) => setCollapsed((current) => {
    const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });
  const nav = (label: string, icon: IconName, destination: DesktopView) => <Button type="button" variant="ghost" title={label} aria-label={label}
    data-nav-destination={destination.view} onClick={() => { onNavigate(destination); setRailExpanded(false); }} className="shell-nav-row">
    <Icon name={icon} /><span className="shell-nav-label min-w-0 truncate">{label}</span>
  </Button>;
  const taskRows = (projectId: string | null) => visibleTasks.filter((task) => task.projectId === projectId).map((task) => {
    const list = sessions[task.taskId];
    const open = Boolean(needle) || !collapsed.has(`task:${task.taskId}`);
    const selected = task.taskId === activeTaskId;
    const command = (action: Omit<SidebarAction, "token" | "taskId">) => onSidebarAction?.({ taskId: task.taskId, ...action });
    const taskMenu: SidebarMenuItem[] = [
      { label: "打开任务", run: () => onNavigate({ view: "task", taskId: task.taskId }) },
      { label: "新建会话", run: onSidebarAction ? () => command({ action: "new" }) : undefined },
      { label: "重命名任务", reason: "当前任务接口不支持重命名" },
      { label: "归档任务…", run: onSidebarAction ? () => command({ action: "archive-task" }) : undefined },
      { label: "收尾清理…", run: onSidebarAction ? () => command({ action: "cleanup-task" }) : undefined },
      { label: "恢复任务", reason: "请在已归档页恢复已归档任务" },
    ];
    return <Fragment key={task.taskId}>
      <SidebarMenu label={`${task.name} 任务菜单`} items={taskMenu}><div data-tree-task-row data-selected={selected} data-open={open} className="sidebar-task-row">
        <button type="button" aria-label={`${open ? "收起" : "展开"}任务 ${task.name}`} aria-expanded={open} onClick={() => toggle(`task:${task.taskId}`)} className="sidebar-task-arrow"><Icon name={open ? "down" : "chevron-right"} /></button>
        <button type="button" data-row-select data-task-nav={task.taskId} aria-label={task.name} title={task.name} aria-current={selected ? "page" : undefined}
          onClick={() => onNavigate({ view: "task", taskId: task.taskId })}
          className="sidebar-task-select">
          <Icon name="branch" /><span className="truncate">{task.name}</span>
        </button>
      </div></SidebarMenu>
      {open && <div data-session-tree={task.taskId} className="sidebar-session-column">
        {list === undefined ? <p className="py-1 text-[10px] text-muted">正在读取会话…</p> : typeof list === "string" ? <div><p role="status" className="py-1 text-[10px] text-destructive">会话列表读取失败：{list}</p><Button type="button" variant="ghost" size="sm" aria-label={`重试读取${task.name}的会话`} onClick={() => setRevision((value) => value + 1)}>重试读取会话</Button></div> : <>
          {list.sessions.filter((session) => (showArchived || !session.archived) && (!needle || matches(session.name) || matches(task.name) || matches(projects.find((project) => project.id === projectId)?.name ?? "未归属任务"))).map((session) => <SidebarMenu key={session.id} label={`${session.name} 会话菜单`} items={[
            { label: "打开会话", run: () => onNavigate({ view: "task", taskId: task.taskId, sessionId: session.id }) },
            ...(["rename", "stop", "archive", "restore", "delete"] as const).map((action) => ({ label: ({ rename: "重命名", stop: "停止", archive: "归档", restore: "恢复", delete: "永久删除…" })[action],
              run: onSidebarAction && (action === "restore" ? session.archived : action === "stop" || action === "archive" ? !session.archived : true) ? () => command({ action, sessionId: session.id }) : undefined,
              reason: action === "restore" && !session.archived ? "会话未归档" : (action === "stop" || action === "archive") && session.archived ? "会话已归档" : undefined })),
            { label: "新建会话", run: onSidebarAction ? () => command({ action: "new" }) : undefined },
          ]}><button type="button" data-row-select data-session-nav={session.id} aria-label={session.name} title={session.name}
            aria-current={selected && (view.view === "task" ? view.sessionId : null) === session.id ? "true" : undefined}
            onClick={() => onNavigate({ view: "task", taskId: task.taskId, sessionId: session.id })}
            data-selected={selected && (view.view === "task" ? view.sessionId : null) === session.id} className="sidebar-session-row">
            <Icon name="message" /><span className="truncate">{session.name}</span>{session.archived && <span className="ml-auto text-[9px]">已归档</span>}
          </button></SidebarMenu>)}
          <button type="button" className="sidebar-new-session" aria-label={`新建会话 · ${task.name}`} disabled={!onSidebarAction} onClick={() => command({ action: "new" })}><Icon name="plus" />新建会话</button>
          {!showArchived && list.sessions.every((session) => session.archived) && <p className="py-1 text-[10px] text-muted">暂无会话</p>}
        </>}
      </div>}
    </Fragment>;
  });
  return <>
    <div hidden={Boolean(management)} className={cn("h-screen min-h-0 w-full bg-bg text-ink", management ? "hidden" : "flex")} data-testid="desktop-shell">
      {!management && <aside data-testid="desktop-sidebar" data-expanded={railExpanded} className="workspace-sidebar flex min-h-0 w-[260px] shrink-0 flex-col border-r border-line bg-sidebar px-3">
        <div className="shell-brand flex h-[52px] shrink-0 items-center gap-2">
          <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-md bg-accent text-primary-foreground"><Icon name="anchor" /></span><div className="shell-nav-label min-w-0"><strong className="block text-[14px] leading-4">PiDock</strong><span className="block text-[10px] text-muted">桌面 Agent 工作台</span></div>
          <span className="shell-nav-label ml-auto text-[10px] text-muted">{tasks.some((task) => typeof sessions[task.taskId] === "object") ? "Host 就绪" : "Host 未核验"}</span>
        </div>
        <Button type="button" variant="outline" aria-label="新建任务" title="新建任务" onClick={() => { setRailExpanded(false); onNewTask?.(); }} disabled={!onNewTask} className="shell-new-task mb-2 h-8 justify-start gap-2"><Icon name="plus" /><span className="shell-nav-label">新建任务</span></Button>
        <button type="button" className="shell-rail-toggle mb-2 hidden h-8 items-center justify-center rounded-md text-muted hover:bg-paper" aria-label={railExpanded ? "收起导航" : "展开导航"} aria-expanded={railExpanded} onClick={() => setRailExpanded((value) => !value)}><Icon name="panel" /></button>
        <button type="button" className="shell-task-picker mb-2 hidden h-8 items-center justify-center rounded-md bg-soft text-accent" aria-label="选择任务或会话" onClick={() => setRailExpanded(true)}><Icon name="folder" /></button>
        <label className="shell-nav-label mb-3 flex h-[30px] shrink-0 items-center gap-1.5 rounded-md border border-line bg-paper px-2 text-muted"><Icon name="search" /><input type="search" aria-label="过滤任务与会话" placeholder="过滤任务与会话…" value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-[11px] outline-none" /></label>
        <nav aria-label="主导航" className="flex min-h-0 flex-1 flex-col">
          <div className="shell-tree min-h-0 flex-1 overflow-y-auto" role="group" aria-label="工作空间与任务">
            <div className="mb-2 flex items-center justify-between px-1 text-[11px] text-muted"><span>工作空间与任务树</span>{onNewWorkspace && <Button type="button" variant="ghost" size="icon-sm" aria-label="新建工作空间" title="新建工作空间" onClick={onNewWorkspace}><Icon name="plus" /></Button>}</div>
            {projects.map((project) => {
              const open = Boolean(needle) || !collapsed.has(`workspace:${project.id}`);
              return <div key={project.id} data-workspace-tree={project.id}>
                <SidebarMenu label={`${project.name} 工作空间菜单`} items={[
                  { label: "打开工作空间", run: () => onNavigate({ view: "project", projectId: project.id }) },
                  ...(["edit", "new-task", "remove"] as const).map((action) => ({ label: ({ edit: "编辑工作空间…", "new-task": "在此新建任务…", remove: "移除工作空间…" })[action], run: onWorkspaceAction ? () => onWorkspaceAction(project.id, action) : undefined })),
                ]}><div className="sidebar-workspace-row" data-selected={view.view === "project" && view.projectId === project.id}>
                  <button type="button" aria-label={`${open ? "收起" : "展开"}工作空间 ${project.name}`} aria-expanded={open} onClick={() => toggle(`workspace:${project.id}`)} className="sidebar-workspace-arrow"><Icon name={open ? "down" : "chevron-right"} /></button>
                  <button type="button" data-row-select aria-label={project.name} title={project.name} aria-current={view.view === "project" && view.projectId === project.id ? "page" : undefined} onClick={() => onNavigate({ view: "project", projectId: project.id })} className="sidebar-workspace-select"><Icon name="folder" /><span className="truncate">{project.name}</span><span className="ml-auto shrink-0 text-[10px] text-muted">{project.taskCount === null ? "未核验" : `${project.taskCount} 任务`}</span></button>
                </div></SidebarMenu><div className="sidebar-task-column">{open && taskRows(project.id)}</div>
              </div>;
            })}
            {projects.length === 0 && <p className="px-1 py-2 text-[11px] text-muted">{projectsInitialized ? "暂无工作空间" : "项目映射未建立。"}</p>}
            <div className="sidebar-workspace-row"><button type="button" className="sidebar-workspace-arrow" aria-label={`${collapsed.has("unassigned") ? "展开" : "收起"}未归属任务`} aria-expanded={!collapsed.has("unassigned")} onClick={() => toggle("unassigned")}><Icon name={collapsed.has("unassigned") ? "chevron-right" : "down"} /></button><button type="button" className="sidebar-workspace-select" onClick={() => onNavigate({ view: "unassigned" })} aria-label="未归属任务"><Icon name="inbox" />未归属任务</button></div><div className="sidebar-task-column">{(!collapsed.has("unassigned") || needle) && taskRows(null)}</div>
            <button type="button" className="py-1 text-[10px] text-muted" aria-pressed={showArchived} onClick={() => setShowArchived((value) => !value)}>{showArchived ? "隐藏已归档会话" : "显示已归档会话"}</button>
            {needle && visibleTasks.length === 0 && <p role="status" className="px-1 py-2 text-[11px] text-muted">没有匹配的任务或会话</p>}
            {!needle && tasks.length === 0 && <p className="px-1 py-2 text-[11px] text-muted">{lifecyclePending || lifecycleErrors.length ? "任务归档状态未核验完整。" : "暂无进行中任务"}</p>}
            <span className="sr-only">未归属 {unassignedCount ?? "未核验"} · 所有任务 {allTaskCount}</span>
          </div>
          <div className="mt-auto flex shrink-0 flex-col border-t border-line py-2" data-nav-group="system">
            <Button type="button" variant="ghost" data-nav-destination="more" aria-label="更多" title="更多" aria-expanded={moreOpen} onClick={() => setMoreOpen((value) => !value)} className="shell-nav-row"><Icon name="more" /><span className="shell-nav-label">更多</span></Button>
            {moreOpen && <>{nav("需要处理", "clock", { view: "attention" })}{nav("环境与服务", "settings", { view: "env" })}{nav("Token 用量", "chart", { view: "usage" })}</>}
            {nav("定时任务", "clock", { view: "schedules" })}
            {nav(LABELS.capabilities, "blocks", { view: "capabilities" })}
            {nav(LABELS.settings, "settings-2", { view: "settings" })}
            {nav("已归档", "archive", { view: "archive" })}
          </div>
        </nav>
      </aside>}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!management && view.view !== "schedules" && <header data-testid="desktop-breadcrumb" className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line bg-paper px-5 text-[12px]">
          <span className="min-w-0 truncate text-muted">{breadcrumb.project ?? "工作区"}</span>
          {breadcrumb.task && <><span className="text-muted">/</span><span className="min-w-0 truncate font-semibold">{breadcrumb.task}</span></>}
          {breadcrumb.page && <><span className="text-muted">/</span><span className="min-w-0 truncate">{breadcrumb.page}</span></>}
          {headerFacts && <div className="min-w-0 flex-1">{headerFacts}</div>}
          {headerActions && <div className="ml-auto flex shrink-0 items-center gap-2">{headerActions}</div>}
        </header>}
        <DesktopRootErrors roots={roots} busy={rootRetry.busy} retryPending={rootRetry.pending} retryError={rootRetry.error} onRetry={rootRetry.run} className="shrink-0 border-b border-line bg-paper px-4 empty:hidden" />
        {lifecycleErrors.length > 0 && <p role="alert" className="shrink-0 border-b border-line bg-paper px-4 py-2 text-[11px] text-destructive">任务归档状态未核验：{lifecycleErrors.join("；")}</p>}
        <main onFocusCapture={(event) => { workspaceFocus.current = event.target as HTMLElement; }} className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-testid="desktop-shell-content">{children}</main>
      </div>
    </div>
    {management}
  </>;
}

export const DESKTOP_LABELS = LABELS;
