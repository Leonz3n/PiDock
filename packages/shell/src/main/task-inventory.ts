import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readTaskRecordOnDisk } from "../host/task-store.js";
import { isSafeTaskChildName, normalizeTaskPath } from "./task-provision.js";

export interface PersistedTaskSummary {
  taskId: string;
  name: string;
  branch: string;
  repoCount: number;
  updatedAt: string;
}

/** Main-owned inventory of immediate children of the configured tasks root. */
export function listPersistedTasks(root: string): PersistedTaskSummary[] {
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("invalid task root");
  const seen = new Set<string>();
  const tasks: PersistedTaskSummary[] = [];
  for (const entry of readdirSync(root).sort()) {
    if (entry.startsWith(".") || !isSafeTaskChildName(entry)) continue;
    const dir = join(root, entry);
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink()) throw new Error("symlinked task folder");
    if (!stat.isDirectory()) continue;
    let recordFile;
    try {
      recordFile = lstatSync(join(dir, "task.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!recordFile.isFile() || recordFile.isSymbolicLink()) throw new Error("invalid task record file");
    const record = readTaskRecordOnDisk(dir);
    if (!record || !isSafeTaskChildName(record.taskId) || record.dirId !== entry ||
        normalizeTaskPath(record.taskDir) !== normalizeTaskPath(dir) ||
        normalizeTaskPath(record.root) !== normalizeTaskPath(root) || seen.has(record.taskId)) {
      throw new Error("invalid task record identity");
    }
    seen.add(record.taskId);
    tasks.push({ taskId: record.taskId, name: record.name, branch: record.branch, repoCount: record.repos.length, updatedAt: record.updatedAt });
  }
  return tasks;
}
