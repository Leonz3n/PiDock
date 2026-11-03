import { hostText } from "./workspaceFiles";
import type { PidockBridge } from "./shellBridge";
import { listDesktopTasks, type DesktopTaskInventory } from "./desktopInventory";

export interface ProjectSource { id: string; name: string; path: string }
/** A workspace-level variable: main stores name/value only, never a renderer identity. */
export interface ProjectEnvironmentVariable { key: string; value: string }
export interface DesktopProject {
  id: string; name: string; description: string;
  repositories: ProjectSource[]; directories: ProjectSource[];
  /** `null` means the Host did not report this field — render that, never an empty list. */
  environment: ProjectEnvironmentVariable[] | null;
  branchTemplate: string | null;
}
export interface ProjectInput {
  name: string; description: string;
  repositories: Array<{ id?: string; name: string; path: string }>;
  directories: Array<{ id?: string; name: string; path: string }>;
  environment: ProjectEnvironmentVariable[];
  branchTemplate: string;
}
export interface TaskAssociation {
  taskId: string; projectId: string | null;
  state: "assigned" | "unassigned" | "needs-repair" | "unavailable";
}
export interface DesktopProjects {
  inventory: DesktopTaskInventory;
  projects: DesktopProject[];
  associations: TaskAssociation[];
  /**
   * Whether the main-owned Project registry exists on this machine. `false`
   * means no persistent project mapping was ever established, which the UI must
   * say explicitly (`项目映射未建立`) instead of showing an invented project or
   * treating absence of a Project as an unassigned-task state (#34 box 1).
   */
  projectsInitialized: boolean;
}

/** The template S10 shows; main owns the same default (`project-registry.ts`). */
export const DEFAULT_BRANCH_TEMPLATE = "feature/{task-name}";
/** The token a branch template is built from; the preview names it, main validates the ref. */
export const BRANCH_TEMPLATE_TOKEN = "{task-name}";

/** A fresh create draft. A factory, so two dialogs never share one mutable object. */
export function projectDraft(project?: DesktopProject | null): ProjectInput {
  if (!project) return { name: "", description: "", repositories: [], directories: [], environment: [], branchTemplate: DEFAULT_BRANCH_TEMPLATE };
  return { name: project.name, description: project.description,
    repositories: project.repositories.map((row) => ({ ...row })), directories: project.directories.map((row) => ({ ...row })),
    environment: (project.environment ?? []).map((row) => ({ ...row })),
    // The edit dialog must show the stored template; a Host that omitted it is
    // named in the field as unreported instead of being replaced by the default.
    branchTemplate: project.branchTemplate ?? "" };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, fields: string[]): boolean {
  return Object.keys(value).sort().join(",") === fields.sort().join(",");
}

/**
 * The name and the path one registered source is identified by: `source()` below
 * type-checks both (only `id` must be non-empty), so a blank one IS a reachable
 * Host payload. Naming it here is what keeps an empty label, an empty row and an
 * empty 「」 pair out of every surface that lists project sources.
 */
export const sourceName = (source: ProjectSource): string => hostText(source.name, "Host 未上报来源名称");
export const sourcePath = (source: ProjectSource): string => hostText(source.path, "Host 未上报来源路径");
/**
 * The name a Project is shown under: `parseDesktopProject` below type-checks
 * `name` (only `id` must be non-empty), so a blank name IS a reachable Host
 * payload. The shell renders that one name in the breadcrumb, in the bottom
 * strip, in the workspace card and in the 环境与服务 project choice, so it is
 * named once here instead of at each of those surfaces.
 */
export const projectName = (project: { name: string }): string => hostText(project.name, "Host 未上报项目名称");
function source(value: unknown): ProjectSource {
  if (!object(value) || !exact(value, ["id", "name", "path"]) ||
      typeof value.id !== "string" || !value.id || typeof value.name !== "string" ||
      typeof value.path !== "string") throw new Error("项目来源返回异常");
  return value as unknown as ProjectSource;
}
function environmentVariable(value: unknown): ProjectEnvironmentVariable {
  if (!object(value) || !exact(value, ["key", "value"]) || typeof value.key !== "string" || typeof value.value !== "string") {
    throw new Error("项目记录返回异常");
  }
  return { key: value.key, value: value.value };
}
export function parseDesktopProject(value: unknown): DesktopProject {
  if (!object(value) || typeof value.id !== "string" || !value.id || typeof value.name !== "string" ||
      typeof value.description !== "string" || !Array.isArray(value.repositories) || !Array.isArray(value.directories)) {
    throw new Error("项目记录返回异常");
  }
  // Settings are additions: an older main omits them, which is reported as
  // "unreported" rather than silently becoming an empty configuration.
  const allowed = ["id", "name", "description", "repositories", "directories", "environment", "branchTemplate"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("项目记录返回异常");
  const environment = value["environment"] === undefined ? null : Array.isArray(value["environment"]) ? value["environment"].map(environmentVariable) : null;
  const branchTemplate = value["branchTemplate"] === undefined ? null : typeof value["branchTemplate"] === "string" ? value["branchTemplate"] : null;
  if (value["environment"] !== undefined && environment === null) throw new Error("项目记录返回异常");
  if (value["branchTemplate"] !== undefined && branchTemplate === null) throw new Error("项目记录返回异常");
  return { id: value.id, name: value.name, description: value.description,
    repositories: value.repositories.map(source), directories: value.directories.map(source), environment, branchTemplate };
}
const ASSOCIATION_STATES = ["assigned", "unassigned", "needs-repair", "unavailable"] as const;
function association(value: unknown): TaskAssociation {
  if (!object(value) || !exact(value, ["taskId", "projectId", "state"]) ||
      typeof value.taskId !== "string" || !value.taskId ||
      (value.projectId !== null && typeof value.projectId !== "string") ||
      !ASSOCIATION_STATES.includes(value.state as TaskAssociation["state"]) ||
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
  return { inventory, projects, associations: rows, projectsInitialized: listed.initialized };
}

/** Per-source reality check, resolved by main from the workspace's own registry rows. */
export type ProjectSourceStatus = "ok" | "missing" | "not-directory";
export interface SourceVerification { id: string; kind: "repository" | "directory"; status: ProjectSourceStatus; error?: string }
export interface ProjectSourceReport { projectId: string; sources: SourceVerification[] }

export async function verifyProjectSources(bridge: PidockBridge, projectId: string): Promise<ProjectSourceReport> {
  const payload = await projectOperation(bridge, { op: "verifySources", projectId });
  if (!object(payload) || !exact(payload, ["projectId", "sources"]) || payload.projectId !== projectId || !Array.isArray(payload.sources)) {
    throw new Error("来源状态返回异常");
  }
  const sources = payload.sources.map((value) => {
    if (!object(value) || (value.status !== "ok" && value.status !== "missing" && value.status !== "not-directory") ||
        (value.kind !== "repository" && value.kind !== "directory") || typeof value.id !== "string" || !value.id ||
        (value.error !== undefined && typeof value.error !== "string") ||
        Object.keys(value).some((key) => !["id", "kind", "status", "error"].includes(key))) {
      throw new Error("来源状态返回异常");
    }
    return { id: value.id, kind: value.kind, status: value.status, ...(value.error === undefined ? {} : { error: value.error }) } as SourceVerification;
  });
  return { projectId, sources };
}

/** Health of both registry files. Read-only and non-throwing in main. */
export interface ProjectRegistryHealth {
  initialized: boolean;
  primary: "ok" | "missing" | "invalid";
  backup: "ok" | "missing" | "invalid";
  recoverable: boolean;
}
const FILE_STATES = ["ok", "missing", "invalid"] as const;
export async function projectRegistryHealth(bridge: PidockBridge): Promise<ProjectRegistryHealth> {
  const payload = await projectOperation(bridge, { op: "status" });
  if (!object(payload) || !exact(payload, ["initialized", "primary", "backup", "recoverable"]) ||
      typeof payload.initialized !== "boolean" || typeof payload.recoverable !== "boolean" ||
      !FILE_STATES.includes(payload.primary as ProjectRegistryHealth["primary"]) ||
      !FILE_STATES.includes(payload.backup as ProjectRegistryHealth["backup"])) {
    throw new Error("项目注册表状态返回异常");
  }
  return { initialized: payload.initialized, primary: payload.primary as ProjectRegistryHealth["primary"],
    backup: payload.backup as ProjectRegistryHealth["backup"], recoverable: payload.recoverable };
}
/** Confirmed restore of `projects.json.bak`; main re-validates it. */
export async function recoverProjectRegistry(bridge: PidockBridge): Promise<{ initialized: boolean; projects: DesktopProject[] }> {
  const payload = await projectOperation(bridge, { op: "recover", confirmed: true });
  if (!object(payload) || typeof payload.initialized !== "boolean" || !Array.isArray(payload.projects)) {
    throw new Error("项目注册表恢复返回异常");
  }
  return { initialized: payload.initialized, projects: payload.projects.map(parseDesktopProject) };
}

/** The tasks that block deleting a workspace, as main reports them. */
export interface ProjectDeleteBlockers { projectId: string; tasks: { taskId: string; state: TaskAssociation["state"] }[] }
export async function projectDeleteBlockers(bridge: PidockBridge, projectId: string): Promise<ProjectDeleteBlockers> {
  const payload = await projectOperation(bridge, { op: "blockers", projectId });
  if (!object(payload) || !exact(payload, ["projectId", "tasks"]) || payload.projectId !== projectId || !Array.isArray(payload.tasks)) {
    throw new Error("任务归属返回异常");
  }
  const tasks = payload.tasks.map((row) => {
    if (!object(row) || !exact(row, ["taskId", "state"]) || typeof row.taskId !== "string" || !row.taskId ||
        !ASSOCIATION_STATES.includes(row.state as TaskAssociation["state"])) throw new Error("任务归属返回异常");
    return { taskId: row.taskId, state: row.state as TaskAssociation["state"] };
  });
  return { projectId, tasks };
}
