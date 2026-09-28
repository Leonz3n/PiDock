import type { PidockBridge } from "./shellBridge";

export interface CreationIntentView {
  id: string; taskId: string; name: string; projectId: string; taskDir: string; root: string; branch: string;
  state: "pending" | "complete";
  repos: { id: string; name: string; remote: string; remoteBranch: string; commit: string; repoDir: string }[];
  directories: { id: string; name: string; linkName: string; path: string }[];
}
export interface CreationInput {
  projectId: string; name: string;
  repositories: { sourceId: string; remote: string; remoteBranch: string }[];
  directoryIds: string[]; sharedWriteConfirmed: boolean; override: boolean;
}
function parse(value: unknown): CreationIntentView {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("本机任务创建意图返回异常");
  const row = value as Record<string, unknown>;
  for (const key of ["id", "taskId", "name", "projectId", "taskDir", "root", "branch"])
    if (typeof row[key] !== "string" || !row[key]) throw new Error("本机任务创建意图返回异常");
  if ((row.state !== "pending" && row.state !== "complete") || !Array.isArray(row.repos) || !Array.isArray(row.directories) ||
      !row.repos.every((repo) => repo && typeof repo === "object" && typeof repo.commit === "string" && typeof repo.repoDir === "string" && typeof repo.name === "string") ||
      !row.directories.every((dir) => dir && typeof dir === "object" && typeof dir.linkName === "string" && typeof dir.path === "string" && typeof dir.name === "string")) {
    throw new Error("本机任务创建意图返回异常");
  }
  return value as CreationIntentView;
}
async function request(bridge: PidockBridge, input: Parameters<NonNullable<PidockBridge["createTask"]>>[0]): Promise<unknown> {
  if (typeof bridge.createTask !== "function") throw new Error("桌面壳真实任务创建接口不可用，请重启应用");
  const result = await bridge.createTask(input);
  if (!result || result.ok !== true) throw new Error(result?.error || "创建任务失败，请检查本机数据后重试");
  return result.payload;
}
export async function currentCreation(bridge: PidockBridge): Promise<CreationIntentView | null> {
  const value = await request(bridge, { op: "current" });
  return value === null ? null : parse(value);
}
export async function prepareCreation(bridge: PidockBridge, input: CreationInput): Promise<CreationIntentView | null> {
  const value = await request(bridge, { op: "prepare", input });
  if (!value || typeof value !== "object" || !("canceled" in value) || typeof value.canceled !== "boolean") throw new Error("本机任务创建预览返回异常");
  if (value.canceled) return null;
  if (!("intent" in value)) throw new Error("本机任务创建预览返回异常");
  return parse(value.intent);
}
export async function commitCreation(bridge: PidockBridge, id: string): Promise<string> {
  const value = await request(bridge, { op: "commit", id });
  if (!value || typeof value !== "object" || !("taskId" in value) || typeof value.taskId !== "string") throw new Error("本机任务创建结果返回异常，请重读确认");
  return value.taskId;
}
