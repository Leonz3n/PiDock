/**
 * Production application shell (historical [UI 对齐 S8] #47 implementation).
 * Current UI design: docs/design/PiDock.pen (see docs/design/README.md).
 * References to prototype A below describe this existing implementation only.
 *
 * The desktop path used to open on a flat management page (`DesktopInventory`) with no
 * app chrome, while prototype A's structure was already implemented for the demo path.
 * This shell gives the **real Host** path the same structure — grouped sidebar, workspace
 * card, breadcrumb header, bottom status bar — over real task/Project data only.
 *
 * Honesty rules this component keeps:
 *
 * - Every nav entry opens its own real page; where the Host has no read op for a part of
 *   that page, the page says `未接线` with the Host reason — the renderer never falls back
 *   to the demo `memoryHost` fixtures in desktop mode.
 * - Counts come from the loaded inventory (`tasks`, `projects`, `roots`); a count that
 *   has no real source is not shown at all instead of being invented.
 * - The bottom strip carries only segments `data/desktopShellSummary.ts` can build
 *   from that same inventory: prototype A's running-service count and browser owner
 *   are readable only inside a task's own tool dock, so they stay absent here.
 * - The window width tiers match prototype A (1180/960/850/720 via `below-*` variants).
 */

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Icon, type IconName } from "./Icon";
import { BrandMark, LocalUserAvatar } from "./ui";
import { desktopSummarySegments, type DesktopSummarySegment } from "../data/desktopShellSummary";
import { hostText } from "../data/workspaceFiles";
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
  // task's active session (the Host's own pointer).
  | { view: "task"; taskId: string; sessionId?: string }
  | { view: "usage" }
  | { view: "schedules" }
  | { view: "archive" }
  | { view: "attention" }
  | { view: "env" }
  | { view: DesktopLocalPageKey };

/**
 * 能力管理 and 设置: the 系统 group's TWO SEPARATE local pages, each routed to its
 * own full-window page (#24, [Pencil T14] #149). They are separate destinations
 * with separate navs — 能力管理 defaults to Providers, 设置 defaults to 外观 — and
 * neither list carries Extensions / Computer Use / Browser entries.
 */
export type DesktopLocalPageKey = "capabilities" | "settings";

const LABELS: Record<DesktopLocalPageKey, string> = {
  capabilities: "能力管理",
  settings: "设置",
};

/** The compact rail's glyphs per design S06: blocks for 能力管理, sliders for 设置. */
const LOCAL_PAGE_ICONS: Record<DesktopLocalPageKey, IconName> = {
  capabilities: "grid",
  settings: "sliders",
};

const NAV_ITEM_CLASS = "flex w-full items-center gap-[10px] rounded-[7px] px-[11px] py-[9px] text-left text-[12px] below-mid:justify-center";
const HEADING_CLASS = "mt-6 mb-[7px] flex items-center justify-between px-[10px] text-[10px] tracking-[1.4px] text-[#91999f] uppercase below-mid:hidden";

function SidebarNavButton({ label, icon, active, count, countLabel, tone, disabled, onSelect }: { label: string; icon: IconName; active: boolean; count?: number; countLabel?: string; tone?: "attention"; disabled?: boolean; onSelect: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      title={label}
      // The workspace rows are found by their own name; the count is a trailing
      // meta chip, so it never becomes part of the accessible name.
      aria-label={label}
      aria-current={active ? "page" : undefined}
      disabled={disabled}
      onClick={onSelect}
      className={`${NAV_ITEM_CLASS} my-0.5 h-auto border-transparent bg-transparent disabled:cursor-default disabled:opacity-45 ${
        active ? "bg-[#e3e6ec] font-semibold text-[#283c6c]" : tone === "attention" ? "text-[#805c28] hover:bg-[#f0e6d4]" : "text-[#69737a] hover:bg-[#eaebec]"
      }`}
    >
      <Icon name={icon} />
      {/* The 64px rail keeps an accessible name per button (`sr-only`), unlike the
          prototype's `display:none`, without changing the wide layout. */}
      <span className="min-w-0 flex-1 truncate below-mid:sr-only">{label}</span>
      {count === undefined ? null : <Badge variant="soft" className="ml-auto rounded-[5px] border-transparent bg-[#e7eaea] px-1.5 text-[10px] below-mid:hidden">{countLabel ?? count}</Badge>}
    </Button>
  );
}

function TaskNavCard({ task, selected, onSelect }: { task: DesktopShellTask; selected: boolean; onSelect: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      data-task-nav={task.taskId}
      aria-current={selected ? "page" : undefined}
      onClick={onSelect}
      className={`mb-[5px] flex h-auto w-full flex-col items-stretch justify-start gap-0 rounded-[7px] px-[10px] py-[10px] text-left ${
        selected ? "border-[#e5e5e6] bg-paper shadow-sm" : "border-transparent hover:bg-paper"
      }`}
    >
      <span className="flex items-center gap-[9px] text-[12px]">
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#9aa4ab]" />
        <Badge variant="outline" className="shrink-0 rounded-[4px] border-[#d9dde6] bg-[#f8f9fb] px-1 text-[8px] leading-4 text-[#858e9d]">任务</Badge>
        <span className="truncate text-ink">{task.name}</span>
      </span>
      <span className="mt-1 ml-[14px] flex justify-between gap-2 text-[10px] text-[#959da2]">
        <span className="truncate">{task.repoCount > 0 ? `${task.repoCount} 仓库 · ${hostText(task.branch, "Host 未上报分支")}` : hostText(task.branch, "Host 未上报分支")}</span>
        <span className="shrink-0">{hostText(task.updatedAt.slice(0, 10), "Host 未上报更新时间")}</span>
      </span>
    </Button>
  );
}

/**
 * [#139] S01's session rows: the sessions the Host reports under ONE task
 * (the selected one), with the active marker. A failure is stated, never
 * hidden — and the rows are read from the Host's index, not guessed.
 */
function TaskSessionRows({ taskId, activeSessionId, onOpen }: { taskId: string; activeSessionId: string | null; onOpen: (sessionId: string) => void }) {
  const [state, setState] = useState<{ phase: "reading" } | { phase: "read"; list: SessionList } | { phase: "failed"; error: string }>({ phase: "reading" });
  /**
   * [#139] Re-read after every session write, not only when `taskId` changes.
   * The evidence caught a new session missing from these rows until the task was
   * re-selected. `taskSessions` announces each accepted write (create / rename /
   * archive / restore / delete / activate) and this row list — which is not the
   * writer — reloads the Host's index on that signal.
   */
  const [writeRevision, setWriteRevision] = useState(0);
  useEffect(() => subscribeSessionWrites((written) => {
    if (written === taskId) setWriteRevision((value) => value + 1);
  }), [taskId]);
  useEffect(() => {
    let live = true;
    setState({ phase: "reading" });
    void readTaskSessions(taskId).then((result) => {
      if (!live) return;
      setState(result.ok ? { phase: "read", list: result.list } : { phase: "failed", error: result.error });
    });
    return () => { live = false; };
  }, [taskId, writeRevision]);
  if (state.phase === "reading") return <p className="mb-1 ml-[27px] text-[10px] text-muted">正在读取会话…</p>;
  if (state.phase === "failed") return <p role="status" className="mb-1 ml-[27px] text-[10px] text-[#9a6032]">会话列表读取失败：{state.error}</p>;
  const visible = state.list.sessions.filter((session) => !session.archived);
  return <div data-session-tree={taskId} className="mb-1 ml-[27px] border-l border-line pl-2">
    {visible.length === 0 && <p className="text-[10px] text-muted">暂无会话</p>}
    {visible.map((session) => {
      const current = (activeSessionId ?? state.list.activeSessionId) === session.id;
      return <button key={session.id} type="button" data-session-nav={session.id} aria-current={current ? "true" : undefined}
        onClick={() => onOpen(session.id)}
        className={`flex w-full min-w-0 items-center gap-1.5 rounded-[5px] px-1.5 py-1 text-left text-[11px] ${current ? "bg-[#e3e6ec] font-semibold text-[#283c6c]" : "text-[#69737a] hover:bg-[#eaebec]"}`}>
        <span aria-hidden className={`h-1 w-1 shrink-0 rounded-full ${current ? "bg-[#283c6c]" : "bg-[#b6bcc4]"}`} />
        <span className="truncate">{session.name}</span>
      </button>;
    })}
  </div>;
}

type DesktopRoot = { label: string; state: "ready" | "error"; message?: string };

/**
 * The strip at the foot of the shell column ([UI 对齐 S8a] #47).
 *
 * It reuses the demo bar's visual vocabulary — prototype A's dark `.switcher`
 * strip (`components/ShellSummaryBar.tsx`) — but is not that component: the
 * demo bar reads `stores/host`, so mounting it here would pull the fixture
 * graph into the production shell. Prototype A's tier rule is kept: at/below
 * 960px the strip keeps only the current task/Project name
 * (`prototypes/pidock-ui/style.css`: `.switcher .state{display:none}`), and a
 * long name truncates instead of widening the column.
 */
function DesktopSummaryBar({ segments }: { segments: DesktopSummarySegment[] }) {
  // Non-scope segments are `below-mid:hidden` (prototype A's
  // `.switcher .state{display:none}` at 960). On a view that names neither a task
  // nor a Project (用量/已归档/需要处理…) that left the section painting its border
  // and background as an empty ~22×14px pill at the mid tier, so the pill itself
  // is hidden there when there is no `scope` segment to show. The wide tier and
  // the bar's real segments are unchanged.
  const hasScope = segments.some((segment) => segment.key === "scope");
  return (
    <div className="shrink-0 bg-bg px-4 py-2 below-mid:px-3 below-stack:px-2">
      <section
        aria-label="当前任务摘要"
        data-testid="desktop-summary"
        className={`mx-auto flex w-fit min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-[10px] border border-[#3b465c] bg-[#293142] px-[10px] py-1.5 text-[10px] whitespace-nowrap text-[#b5bfd4] shadow-[0_4px_15px_#151a2522] below-stack:gap-1 below-stack:px-1.5 ${hasScope ? "" : "below-mid:hidden"}`}
      >
        {segments.map((segment, index) => (
          <span
            key={segment.key}
            data-summary-segment={segment.key}
            title={segment.title}
            className={`flex items-center gap-2 ${segment.key === "scope" ? "min-w-0 truncate" : "below-mid:hidden"}`}
          >
            {index > 0 ? (
              <span aria-hidden className="text-[#5b657c]">
                ·
              </span>
            ) : null}
            {segment.label}
          </span>
        ))}
      </section>
    </div>
  );
}

export function DesktopRootErrors({ roots, busy, retryPending, retryError, onRetry, className }: {
  roots: DesktopRoot[];
  busy: boolean;
  retryPending: boolean;
  retryError: string | null;
  onRetry: () => void;
  className?: string;
}) {
  return <div className={className} aria-busy={retryPending}>
    {roots.filter((root) => root.state === "error").map((root) => <div role="alert" key={root.label} className="flex min-w-0 items-center gap-2 py-2 text-[11px] text-[#ad4545]">
      <span className="min-w-0 flex-1 break-words">{root.label}：{root.message}</span>
      <Button type="button" variant="outline" aria-label={`重试读取${root.label}`} title={`重试读取${root.label}`} disabled={busy} onClick={onRetry} className="h-8 w-8 shrink-0 rounded-[5px] p-0">
        <Icon name="refresh" className={retryPending ? "animate-spin" : undefined} />
      </Button>
    </div>)}
    {roots.filter((root) => root.state !== "error" && root.message).map((root) => <p role="status" key={root.label} className="border-b border-[#dfc99f] py-2 text-[11px] text-[#9a6032]">
      {root.label}：{root.message}
    </p>)}
    {retryPending && <p role="status" className="pb-2 text-[11px] text-muted">正在重读任务根</p>}
    {retryError && <p role="alert" className="pb-2 text-[11px] text-[#ad4545]">{retryError}</p>}
  </div>;
}

export function DesktopShell({
  view,
  onNavigate,
  projects,
  projectsInitialized,
  unassignedCount,
  onNewWorkspace,
  tasks,
  allTaskCount,
  lifecyclePending,
  lifecycleErrors,
  roots,
  rootRetry,
  breadcrumb,
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
  tasks: DesktopShellTask[];
  allTaskCount: number;
  lifecyclePending: boolean;
  lifecycleErrors: string[];
  /** Real task-root labels; a broken root is surfaced, never hidden. */
  roots: DesktopRoot[];
  rootRetry: { busy: boolean; pending: boolean; error: string | null; run: () => void };
  /** Real names for the header breadcrumb; omitted parts stay hidden. */
  breadcrumb: { project?: string; task?: string; page?: string };
  children: ReactNode;
}) {
  const activeTaskId = view.view === "task" ? view.taskId : undefined;
  const brokenRoots = roots.filter((root) => root.state === "error");
  // One condition for "the lifecycle was verified": the sidebar count, the
  // alert below and the strip must never disagree about it.
  const lifecycleUnverified = lifecyclePending || lifecycleErrors.length > 0;
  // The strip names what the shell is showing from the same real names the
  // breadcrumb already resolved out of the inventory read, so a pending
  // lifecycle read does not blank the name; a view that names neither a task
  // nor a Project (用量/已归档/需要处理…) yields no scope segment.
  const summaryScope = view.view === "task"
    ? (breadcrumb.task === undefined ? undefined : { kind: "task" as const, name: breadcrumb.task })
    : view.view === "project"
      ? (breadcrumb.project === undefined ? undefined : { kind: "project" as const, name: breadcrumb.project })
      : undefined;
  return (
    <div className="flex h-screen min-h-0 w-full bg-bg text-ink" data-testid="desktop-shell">
      <aside data-testid="desktop-sidebar" className="flex min-h-0 w-[260px] shrink-0 flex-col border-r border-line bg-sidebar px-[13px] below-wide:w-[212px] below-mid:w-16 below-mid:px-2">
        <div className="flex h-16 items-center gap-[9px] px-2 below-mid:justify-center below-mid:px-0">
          <BrandMark />
          <span className="text-[19px] font-[680] tracking-[-0.8px] text-ink below-mid:hidden">PiDock</span>
        </div>

        <div data-testid="desktop-workspace-card" className="mt-[5px] mb-[18px] flex w-full items-center gap-[9px] rounded-lg border border-line bg-paper p-[10px] below-mid:hidden">
          <span aria-hidden className="grid h-[29px] w-[29px] shrink-0 place-items-center rounded-[7px] bg-[#eaf0f6] font-semibold text-[#61788d]">
            {projects[0]?.name.slice(0, 1) ?? "本"}
          </span>
          <span className="flex min-w-0 flex-1 flex-col text-left">
            <strong className="truncate text-[12px] font-semibold text-ink">本机工作区</strong>
            <small className="truncate text-[10px] text-muted">
              {projects.length > 0 ? `${projects.length} 个项目 · ${allTaskCount} 个任务` : `${allTaskCount} 个任务`}
            </small>
          </span>
        </div>

        <nav aria-label="主导航" className="flex min-h-0 flex-1 flex-col">
          <div data-nav-group="workspaces" role="group" aria-label="工作空间与任务" className="flex min-h-0 flex-col">
            <div className={HEADING_CLASS}>
              <span>工作空间与任务</span>
              <span className="flex items-center gap-1 text-[10px] normal-case">{projects.length}
                {onNewWorkspace ? <Button type="button" variant="ghost" size="icon-sm" aria-label="新建工作空间" title="新建工作空间" onClick={onNewWorkspace} className="h-5 w-5 border-transparent p-0 text-muted hover:bg-[#eaebec]"><Icon name="plus" /></Button> : null}
              </span>
            </div>
            <div className="flex min-h-0 flex-col overflow-y-auto below-mid:hidden">
              {projects.map((project) => (
                <SidebarNavButton
                  key={project.id}
                  label={project.name}
                  icon="folder"
                  count={project.taskCount ?? undefined}
                  countLabel={project.taskCount === null ? "未核验" : undefined}
                  active={view.view === "project" && view.projectId === project.id}
                  onSelect={() => onNavigate({ view: "project", projectId: project.id })}
                />
              ))}
              <SidebarNavButton
                label="未归属任务"
                icon="inbox"
                tone="attention"
                count={unassignedCount ?? undefined}
                countLabel={unassignedCount === null ? "未核验" : undefined}
                active={view.view === "unassigned"}
                onSelect={() => onNavigate({ view: "unassigned" })}
              />
              {projects.length === 0 ? <p className="px-[10px] pb-2 text-[10px] text-muted">{projectsInitialized ? "尚无工作空间；用「项目管理」新建。" : "项目映射未建立。"}</p> : null}
            </div>

            <div className={`${HEADING_CLASS} mt-4`}>
              <span>进行中的任务</span>
              <span className="text-[10px] normal-case">{lifecycleUnverified ? "未核验" : tasks.length}</span>
            </div>
            <div className="flex min-h-0 flex-col overflow-y-auto below-mid:hidden">
              {tasks.length === 0 ? <p className="px-[10px] pb-2 text-[10px] text-muted">{lifecycleUnverified ? "任务归档状态未核验完整。" : "已检查的任务根暂无进行中任务。"}</p> : null}
              {tasks.map((task) => (
                <Fragment key={task.taskId}>
                  <TaskNavCard task={task} selected={task.taskId === activeTaskId} onSelect={() => onNavigate({ view: "task", taskId: task.taskId })} />
                  {task.taskId === activeTaskId && (
                    <TaskSessionRows taskId={task.taskId} activeSessionId={view.view === "task" ? view.sessionId ?? null : null} onOpen={(sessionId) => onNavigate({ view: "task", taskId: task.taskId, sessionId })} />
                  )}
                </Fragment>
              ))}
            </div>
            <SidebarNavButton label="已归档" icon="archive" active={view.view === "archive"} onSelect={() => onNavigate({ view: "archive" })} />
          </div>

          <div data-nav-group="system" className="mt-auto border-t border-line pt-[11px]">
            <SidebarNavButton label="需要处理" icon="clock" active={view.view === "attention"} onSelect={() => onNavigate({ view: "attention" })} />
            <SidebarNavButton label="定时任务" icon="clock" active={view.view === "schedules"} onSelect={() => onNavigate({ view: "schedules" })} />
            <SidebarNavButton label="环境与服务" icon="settings" active={view.view === "env"} onSelect={() => onNavigate({ view: "env" })} />
            <SidebarNavButton label="Token 用量" icon="chart" active={view.view === "usage"} onSelect={() => onNavigate({ view: "usage" })} />
            <SidebarNavButton label={LABELS.capabilities} icon={LOCAL_PAGE_ICONS.capabilities} active={view.view === "capabilities"} onSelect={() => onNavigate({ view: "capabilities" })} />
            <SidebarNavButton label={LABELS.settings} icon={LOCAL_PAGE_ICONS.settings} active={view.view === "settings"} onSelect={() => onNavigate({ view: "settings" })} />
            <div data-user-chip="local-workspace" title="本机工作区" className="flex items-center gap-[9px] px-2 py-[10px]">
              <LocalUserAvatar />
              <span className="truncate text-[11px] text-ink below-mid:hidden">本机工作区</span>
              <small className="ml-auto shrink-0 text-[10px] text-muted below-mid:hidden">真实 Host</small>
            </div>
          </div>
        </nav>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* #49: at the production minimum a task page leaves the column ~192px of
            breadcrumb; without `shrink-0`/`whitespace-nowrap` on the literal
            segments, CJK text wrapped one character per line and pushed the 48px
            bar taller. The project/task names are the only parts that truncate. */}
        <header data-testid="desktop-breadcrumb" className="flex min-h-[52px] shrink-0 items-center gap-2 border-b border-line bg-paper px-4 text-[12px] below-mid:px-3">
          <span className="shrink-0 whitespace-nowrap text-muted">工作区</span>
          <span className="shrink-0 text-[#cfd3d7]">/</span>
          <span className="min-w-0 truncate text-muted">{breadcrumb.project ?? "工作区"}</span>
          {breadcrumb.task ? <>
            <span className="shrink-0 text-[#cfd3d7]">/</span>
            <span className="min-w-0 truncate font-semibold text-ink">{breadcrumb.task}</span>
          </> : null}
          {breadcrumb.page ? <>
            <span className="shrink-0 text-[#cfd3d7]">/</span>
            <span className="min-w-0 truncate font-semibold text-ink">{breadcrumb.page}</span>
          </> : null}
          <span className="ml-auto shrink-0 text-[11px] text-muted below-narrow:hidden">
            {brokenRoots.length === 0 ? `任务根 ${roots.length}/${roots.length} 就绪` : `${brokenRoots.length} 个任务根不可用`}
          </span>
        </header>
        <DesktopRootErrors roots={roots} busy={rootRetry.busy} retryPending={rootRetry.pending} retryError={rootRetry.error} onRetry={rootRetry.run} className="shrink-0 border-b border-line bg-paper px-4 empty:hidden" />
        {lifecycleErrors.length > 0 && <p role="alert" className="shrink-0 border-b border-line bg-paper px-4 py-2 text-[11px] text-[#ad4545]">任务归档状态未核验：{lifecycleErrors.join("；")}</p>}
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-testid="desktop-shell-content">{children}</main>
        <DesktopSummaryBar
          segments={desktopSummarySegments({
            scope: summaryScope,
            activeTaskCount: lifecycleUnverified ? null : tasks.length,
            roots,
          })}
        />
      </div>
    </div>
  );
}

/** Nav wording, shared so pages and the shell cannot drift apart. */
export const DESKTOP_LABELS = LABELS;
