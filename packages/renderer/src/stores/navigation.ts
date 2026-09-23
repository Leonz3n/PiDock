import { create } from "zustand";

export type Route =
  | { view: "attention" }
  | { view: "project"; projectId: string }
  | { view: "task"; projectId: string; taskId: string; sessionId: string }
  | { view: "env" }
  | { view: "providers" }
  | { view: "usage" }
  | { view: "schedules" }
  | { view: "capabilities" }
  | { view: "remote" }
  | { view: "archive" }
  | { view: "settings" };

/**
 * Sidebar and breadcrumb wording per view ([UI 对齐 01] #25): one spelling per
 * concept across the shell, the breadcrumb and the page headings.
 */
export const ROUTE_LABELS: Record<Route["view"], string> = {
  attention: "需要处理",
  project: "项目总览",
  task: "任务工作区",
  env: "环境与服务",
  providers: "模型与 Provider",
  usage: "Token 用量",
  schedules: "定时任务",
  capabilities: "能力管理",
  remote: "远程访问",
  archive: "已归档",
  settings: "本机设置",
};

const simpleViews = ["env", "providers", "usage", "schedules", "capabilities", "remote", "archive", "attention", "settings"] as const;

type SimpleView = (typeof simpleViews)[number];

export function routeToPath(route: Route): string {
  if (route.view === "task") return `/projects/${route.projectId}/tasks/${route.taskId}?session=${route.sessionId}`;
  if (route.view === "project") return `/projects/${route.projectId}`;
  return `/${route.view}`;
}

export function parseLocation(pathname: string, search: string): Route {
  const segments = pathname.split("/").filter(Boolean);
  const sessionId = new URLSearchParams(search.startsWith("?") ? search : `?${search}`).get("session");
  if (segments[0] === "projects" && segments[1]) {
    const projectId = segments[1];
    if (segments[2] === "tasks" && segments[3]) {
      return { view: "task", projectId, taskId: segments[3], sessionId: sessionId ?? "" };
    }
    return { view: "project", projectId };
  }
  const candidate = segments[0] as SimpleView | undefined;
  if (candidate && (simpleViews as readonly string[]).includes(candidate)) return { view: candidate } as Route;
  return { view: "attention" };
}

type NavigationState = {
  route: Route;
  syncFromLocation: () => void;
  navigate: (route: Route, options?: { replace?: boolean }) => void;
};

export const useNavigationStore = create<NavigationState>((set) => ({
  route:
    typeof window === "undefined"
      ? { view: "attention" }
      : parseLocation(window.location.pathname, window.location.search),
  syncFromLocation: () => {
    if (typeof window === "undefined") return;
    set({ route: parseLocation(window.location.pathname, window.location.search) });
  },
  navigate: (route, options) => {
    if (typeof window !== "undefined") {
      const path = routeToPath(route);
      if (options?.replace) window.history.replaceState({}, "", path);
      else window.history.pushState({}, "", path);
    }
    set({ route });
  },
}));
