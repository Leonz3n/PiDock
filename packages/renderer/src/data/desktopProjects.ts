import type { PidockBridge } from "./shellBridge";
import { listDesktopTasks, type DesktopTaskInventory } from "./desktopInventory";

export interface ProjectSource { id: string; name: string; path: string }
export interface DesktopProject {
  id: string; name: string; description: string;
  repositories: ProjectSource[]; directories: ProjectSource[];
}
export interface ProjectInput {
  name: string; description: string;
  repositories: Array<{ id?: string; name: string; path: string }>;
  directories: Array<{ id?: string; name: string; path: string }>;
}
export interface TaskAssociation {
  taskId: string; projectId: string | null;
  state: "assigned" | "unassigned" | "needs-repair" | "unavailable";
}
export interface DesktopProjects {
  inventory: DesktopTaskInventory;
  projects: DesktopProject[];
  associations: TaskAssociation[];
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, fields: string[]): boolean {
  return Object.keys(value).sort().join(",") === fields.sort().join(",");
}
function source(value: unknown): ProjectSource {
  if (!object(value) || !exact(value, ["id", "name", "path"]) ||
      typeof value.id !== "string" || !value.id || typeof value.name !== "string" ||
      typeof value.path !== "string") throw new Error("项目来源返回异常");
  return value as unknown as ProjectSource;
}
export function parseDesktopProject(value: unknown): DesktopProject {
  if (!object(value) || !exact(value, ["id", "name", "description", "repositories", "directories"]) ||
      typeof value.id !== "string" || !value.id || typeof value.name !== "string" ||
      typeof value.description !== "string" || !Array.isArray(value.repositories) || !Array.isArray(value.directories)) {
    throw new Error("项目记录返回异常");
  }
  return { id: value.id, name: value.name, description: value.description,
    repositories: value.repositories.map(source), directories: value.directories.map(source) };
}
function association(value: unknown): TaskAssociation {
  if (!object(value) || !exact(value, ["taskId", "projectId", "state"]) ||
      typeof value.taskId !== "string" || !value.taskId ||
      (value.projectId !== null && typeof value.projectId !== "string") ||
      !["assigned", "unassigned", "needs-repair", "unavailable"].includes(String(value.state)) ||
      ((value.state === "assigned" || value.state === "needs-repair") !== (typeof value.projectId === "string"))) {
    throw new Error("任务归属返回异常");
  }
  return value as unknown as TaskAssociation;
}

export async function projectOperation(bridge: PidockBridge, request: Parameters<NonNullable<PidockBridge["projectOp"]>>[0]): Promise<unknown> {
  if (typeof bridge.projectOp !== "function") throw new Error("桌面壳项目接口不可用，请重启应用");
  const result = await bridge.projectOp(request);
  if (!result || result.ok !== true) throw new Error(result?.error || "项目操作失败，请检查本机数据后重试");
  return result.payload;
}

/** All three reads are required; a partial bridge response never becomes an empty project list. */
export async function loadDesktopProjects(bridge: PidockBridge): Promise<DesktopProjects> {
  const inventory = await listDesktopTasks(bridge);
  const listed = await projectOperation(bridge, { op: "list" });
  const associations = await projectOperation(bridge, { op: "associations" });
  if (!object(listed) || typeof listed.initialized !== "boolean" || !Array.isArray(listed.projects) ||
      !object(associations) || !Array.isArray(associations.tasks) || !Array.isArray(associations.roots)) {
    throw new Error("项目或任务归属返回异常");
  }
  const projects = listed.projects.map(parseDesktopProject);
  const rows = associations.tasks.map(association);
  const ids = new Set(projects.map((item) => item.id));
  const taskIds = new Set(rows.map((row) => row.taskId));
  if (ids.size !== projects.length || taskIds.size !== rows.length ||
      rows.some((row) => row.projectId !== null && !ids.has(row.projectId)) ||
      inventory.tasks.some((task) => !taskIds.has(task.taskId)) ||
      rows.some((row) => row.state === "unassigned" && !inventory.tasks.some((task) => task.taskId === row.taskId))) {
    throw new Error("项目与任务清单不一致，请重试");
  }
  if (JSON.stringify(inventory.roots) !== JSON.stringify(associations.roots)) throw new Error("任务根状态已变化，请重试");
  return { inventory, projects, associations: rows };
}
