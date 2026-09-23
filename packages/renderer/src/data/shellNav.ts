/**
 * Application shell view helpers ([UI 对齐 01] #25).
 *
 * Pure derivations for the sidebar task cards and the bottom summary bar, so
 * the shell components stay about layout. Every value comes from the workspace
 * snapshot the adapter already reported (memory host or desktop Host); nothing
 * is invented when the snapshot has no value.
 */

import { scheduleNextRunText } from "./scheduleRules";
import type { Environment, Service, Task, Workspace } from "./types";

/** Running services the task card's live dot and the summary bar count. */
export function runningServiceCount(services: readonly Service[]): number {
  return services.filter((service) => service.running).length;
}

export function environmentLabel(task: Task, environments: readonly Environment[]): string {
  return environments.find((environment) => environment.id === task.environmentId)?.name ?? task.environmentId;
}

/**
 * Left half of a task card's meta line, mirroring prototype A: a scheduled
 * task shows its next run, a plain-directory task its shared files, and a
 * repository task its workspace size and environment.
 */
export function taskCardMeta(task: Task, workspace: Pick<Workspace, "environments" | "schedules">): string {
  if (task.type === "scheduled") {
    const schedule = workspace.schedules.find((item) => item.taskId === task.id);
    return schedule === undefined ? "等待设置" : scheduleNextRunText(schedule, { archived: task.archived });
  }
  if (task.repos.length === 0 && task.directories.length > 0) return "普通目录 · 共享文件";
  return `${task.repos.length} 仓库 · ${environmentLabel(task, workspace.environments)}`;
}

/** Coarse relative time for a task card; `now` is injectable for tests. */
export function relativeActivity(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const minutes = Math.floor((now.getTime() - then) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return iso.slice(0, 10);
}

/** Right half of a task card's meta line: the task's most recent session activity. */
export function taskCardActivity(task: Task, now: Date = new Date()): string {
  const latest = task.sessions.reduce<string | undefined>((current, session) => {
    if (!session.lastActivity) return current;
    if (current === undefined || new Date(session.lastActivity).getTime() > new Date(current).getTime()) {
      return session.lastActivity;
    }
    return current;
  }, undefined);
  return latest === undefined ? "" : relativeActivity(latest, now);
}

export type SummarySegment = {
  key: "task" | "services" | "browser";
  label: string;
  /** Full wording for the hover title; the bar itself stays one short line. */
  title: string;
};

/**
 * Bottom summary bar content: the current task, how many of its services run,
 * and who holds the task browser. Without a task the bar falls back to the
 * selected workspace, exactly like the prototype's switcher state line.
 */
export function summarySegments(input: { task?: Task; workspaceName?: string; takeoverPaused: boolean }): SummarySegment[] {
  const { task } = input;
  if (task === undefined) {
    return [{ key: "task", label: input.workspaceName ?? "未选择工作区", title: "当前工作区 · 未选择任务" }];
  }
  const running = runningServiceCount(task.services);
  const browser = task.browserPages.length === 0 ? "浏览器未打开" : input.takeoverPaused ? "人工接管中" : "Agent 控制中";
  return [
    { key: "task", label: task.name, title: `当前任务 · ${task.name}` },
    { key: "services", label: `${running} 服务`, title: `${running} / ${task.services.length} 个服务在运行` },
    { key: "browser", label: browser, title: `浏览器控制者 · ${browser}` },
  ];
}
