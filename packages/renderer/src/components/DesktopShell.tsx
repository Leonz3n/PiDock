/**
 * Production application shell ([UI 对齐 S8] #47, baseline `prototypes/pidock-ui/?variant=A`).
 *
 * The desktop path used to open on a flat management page (`DesktopInventory`) with no
 * app chrome, while prototype A's structure was already implemented for the demo path.
 * This shell gives the **real Host** path the same structure — grouped sidebar, workspace
 * card, breadcrumb header, bottom status bar — over real task/Project data only.
 *
 * Honesty rules this component keeps:
 *
 * - Every nav entry is either backed by real data or explicitly marked `未接线`; the
 *   renderer never falls back to the demo `memoryHost` fixtures in desktop mode.
 * - Counts come from the loaded inventory (`tasks`, `projects`, `roots`); a count that
 *   has no real source is not shown at all instead of being invented.
 * - The window width tiers match prototype A (1180/960/850/720 via `below-*` variants).
 */

import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import { BrandMark, LocalUserAvatar } from "./ui";

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
}

/** Pages the shell can show. `unwired` names a nav entry with no real Host data yet. */
export type DesktopView =
  | { view: "project"; projectId: string }
  | { view: "unassigned" }
  | { view: "task"; taskId: string }
  | { view: "unwired"; key: DesktopUnwiredKey };

export type DesktopUnwiredKey = "env" | "usage" | "archive" | "attention" | "schedules" | "capabilities" | "remote" | "settings" | "providers";

const LABELS: Record<DesktopUnwiredKey, string> = {
  env: "环境与服务",
  usage: "Token 用量",
  archive: "已归档",
  attention: "需要处理",
  schedules: "定时任务",
  capabilities: "能力管理",
  remote: "远程访问",
  settings: "本机设置",
  providers: "模型与 Provider",
};

const NAV_ITEM_CLASS = "flex w-full items-center gap-[10px] rounded-[7px] px-[11px] py-[9px] text-left text-[12px] below-mid:justify-center";
const HEADING_CLASS = "mt-6 mb-[7px] flex items-center justify-between px-[10px] text-[10px] tracking-[1.4px] text-[#91999f] uppercase below-mid:hidden";

/**
 * A nav entry whose real Host data does not exist yet. The page states that plainly
 * instead of filling the screen with sample data.
 */
export function DesktopUnwired({ name, onBack }: { name: string; onBack: () => void }) {
  return (
    <div data-testid="desktop-unwired" className="mx-auto max-w-[760px] px-6 py-10">
      <h2 className="text-[15px] font-semibold text-ink">{name} · 未接线</h2>
      <p className="mt-3 text-[12px] leading-6 text-muted">
        真实 Host 尚未提供这项数据，界面不会用样例内容填充。此入口保留，接入后在此页展示真实状态。
      </p>
      <button type="button" onClick={onBack} className="mt-5 rounded-[7px] border border-line bg-paper px-[11px] py-[7px] text-[12px] text-ink hover:border-[#bec0c3]">
        返回任务
      </button>
    </div>
  );
}

function SidebarNavButton({ label, icon, active, count, disabled, onSelect }: { label: string; icon: IconName; active: boolean; count?: number; disabled?: boolean; onSelect: () => void }) {
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
      <Icon name={icon} />
      {/* The 64px rail keeps an accessible name per button (`sr-only`), unlike the
          prototype's `display:none`, without changing the wide layout. */}
      <span className="below-mid:sr-only">{label}</span>
      {count === undefined ? null : <span className="ml-auto rounded-[5px] bg-[#e7eaea] px-1.5 text-[10px] below-mid:hidden">{count}</span>}
    </button>
  );
}

function TaskNavCard({ task, selected, onSelect }: { task: DesktopShellTask; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      data-task-nav={task.taskId}
      aria-current={selected ? "page" : undefined}
      onClick={onSelect}
      className={`mb-[5px] flex w-full flex-col rounded-[7px] border px-[10px] py-[10px] text-left ${
        selected ? "border-[#e5e5e6] bg-paper shadow-sm" : "border-transparent hover:bg-paper"
      }`}
    >
      <span className="flex items-center gap-[9px] text-[12px]">
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#9aa4ab]" />
        <span className="shrink-0 rounded-[4px] border border-[#d9dde6] bg-[#f8f9fb] px-1 text-[8px] leading-4 text-[#858e9d]">任务</span>
        <span className="truncate text-ink">{task.name}</span>
      </span>
      <span className="mt-1 ml-[14px] flex justify-between gap-2 text-[10px] text-[#959da2]">
        <span className="truncate">{task.repoCount > 0 ? `${task.repoCount} 仓库 · ${task.branch}` : task.branch}</span>
        <span className="shrink-0">{task.updatedAt.slice(0, 10)}</span>
      </span>
    </button>
  );
}

export function DesktopShell({
  view,
  onNavigate,
  projects,
  tasks,
  roots,
  breadcrumb,
  children,
}: {
  view: DesktopView;
  onNavigate: (next: DesktopView) => void;
  projects: DesktopShellProject[];
  tasks: DesktopShellTask[];
  /** Real task-root labels; a broken root is surfaced, never hidden. */
  roots: { label: string; state: "ready" | "error"; message?: string }[];
  /** Real names for the header breadcrumb; omitted parts stay hidden. */
  breadcrumb: { project?: string; task?: string };
  children: ReactNode;
}) {
  const activeTaskId = view.view === "task" ? view.taskId : undefined;
  const brokenRoots = roots.filter((root) => root.state === "error");
  return (
    <div className="flex h-screen min-h-0 w-full bg-bg text-ink" data-testid="desktop-shell">
      <aside data-testid="desktop-sidebar" className="flex min-h-0 w-[226px] shrink-0 flex-col border-r border-line bg-sidebar px-[13px] below-wide:w-[192px] below-mid:w-16 below-mid:px-2">
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
              {projects.length > 0 ? `${projects.length} 个项目 · ${tasks.length} 个任务` : `${tasks.length} 个任务`}
            </small>
          </span>
        </div>

        <nav aria-label="主导航" className="flex min-h-0 flex-1 flex-col">
          <div data-nav-group="workspace" role="group" aria-label="工作区" className="flex flex-col">
            <SidebarNavButton label="项目总览" icon="grid" active={view.view === "project" || view.view === "unassigned"} onSelect={() => { const first = projects[0]; if (first) onNavigate({ view: "project", projectId: first.id }); else onNavigate({ view: "unassigned" }); }} />
            <SidebarNavButton label={LABELS.env} icon="settings" active={view.view === "unwired" && view.key === "env"} onSelect={() => onNavigate({ view: "unwired", key: "env" })} />
            <SidebarNavButton label={LABELS.usage} icon="chart" active={view.view === "unwired" && view.key === "usage"} onSelect={() => onNavigate({ view: "unwired", key: "usage" })} />
          </div>

          <div data-nav-group="tasks" role="group" aria-label="进行中的任务" className="flex min-h-0 flex-col">
            <div className={HEADING_CLASS}>
              <span>进行中的任务</span>
              <span className="text-[10px] normal-case">{tasks.length}</span>
            </div>
            <div className="flex min-h-0 flex-col overflow-y-auto below-mid:hidden">
              {tasks.length === 0 ? <p className="px-[10px] pb-2 text-[10px] text-muted">已检查的任务根暂无任务。</p> : null}
              {tasks.map((task) => (
                <TaskNavCard key={task.taskId} task={task} selected={task.taskId === activeTaskId} onSelect={() => onNavigate({ view: "task", taskId: task.taskId })} />
              ))}
            </div>
            <SidebarNavButton label={LABELS.archive} icon="archive" active={view.view === "unwired" && view.key === "archive"} onSelect={() => onNavigate({ view: "unwired", key: "archive" })} />
          </div>

          <div data-nav-group="system" className="mt-auto border-t border-line pt-[11px]">
            <SidebarNavButton label={LABELS.attention} icon="clock" active={view.view === "unwired" && view.key === "attention"} onSelect={() => onNavigate({ view: "unwired", key: "attention" })} />
            <SidebarNavButton label={LABELS.schedules} icon="clock" active={view.view === "unwired" && view.key === "schedules"} onSelect={() => onNavigate({ view: "unwired", key: "schedules" })} />
            <SidebarNavButton label={LABELS.capabilities} icon="book" active={view.view === "unwired" && view.key === "capabilities"} onSelect={() => onNavigate({ view: "unwired", key: "capabilities" })} />
            <SidebarNavButton label={LABELS.remote} icon="globe" active={view.view === "unwired" && view.key === "remote"} onSelect={() => onNavigate({ view: "unwired", key: "remote" })} />
            <SidebarNavButton label={LABELS.settings} icon="folder" active={view.view === "unwired" && view.key === "settings"} onSelect={() => onNavigate({ view: "unwired", key: "settings" })} />
            <SidebarNavButton label={LABELS.providers} icon="key" active={view.view === "unwired" && view.key === "providers"} onSelect={() => onNavigate({ view: "unwired", key: "providers" })} />
            <div data-user-chip="local-workspace" title="本机工作区" className="flex items-center gap-[9px] px-2 py-[10px]">
              <LocalUserAvatar />
              <span className="truncate text-[11px] text-ink below-mid:hidden">本机工作区</span>
              <small className="ml-auto shrink-0 text-[10px] text-muted below-mid:hidden">真实 Host</small>
            </div>
          </div>
        </nav>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header data-testid="desktop-breadcrumb" className="flex min-h-12 shrink-0 items-center gap-2 border-b border-line bg-paper px-4 text-[12px] below-mid:px-3">
          <span className="text-muted">工作区</span>
          <span className="text-[#cfd3d7]">/</span>
          <span className="truncate text-muted">{breadcrumb.project ?? "未归属任务"}</span>
          {breadcrumb.task ? <>
            <span className="text-[#cfd3d7]">/</span>
            <span className="min-w-0 truncate font-semibold text-ink">{breadcrumb.task}</span>
          </> : null}
          <span className="ml-auto shrink-0 text-[11px] text-muted below-narrow:hidden">
            {brokenRoots.length === 0 ? `任务根 ${roots.length}/${roots.length} 就绪` : `${brokenRoots.length} 个任务根不可用`}
          </span>
        </header>
        {brokenRoots.map((root) => <p role="alert" key={root.label} className="shrink-0 border-b border-line bg-paper px-4 py-2 text-[11px] text-[#ad4545]">{root.label}：{root.message}</p>)}
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-testid="desktop-shell-content">{children}</main>
      </div>
    </div>
  );
}

/** Nav wording, shared so pages and the shell cannot drift apart. */
export const DESKTOP_LABELS = LABELS;
