import type { PidockBridge } from "./shellBridge";

export interface DesktopTaskSummary {
  taskId: string;
  name: string;
  branch: string;
  repoCount: number;
  updatedAt: string;
}

/** A broken preload is an error in Electron, never permission to show demo fixtures. */
export function desktopMode(bridge: PidockBridge | undefined, userAgent: string): boolean {
  return bridge !== undefined || /Electron\/\d/.test(userAgent);
}

export async function listDesktopTasks(bridge: PidockBridge): Promise<DesktopTaskSummary[]> {
  if (typeof bridge.listTasks !== "function") throw new Error("桌面壳任务读取接口不可用，请重启应用");
  const result = await bridge.listTasks();
  if (!result || result.ok !== true) throw new Error(result?.error || "任务记录读取失败，请重试");
  const payload = result.payload;
  if (!payload || typeof payload !== "object" || !("tasks" in payload) || !Array.isArray(payload.tasks)) {
    throw new Error("桌面壳任务记录返回异常");
  }
  return payload.tasks.map((raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("桌面壳任务记录返回异常");
    const row = raw as Record<string, unknown>;
    if (Object.keys(row).sort().join(",") !== "branch,name,repoCount,taskId,updatedAt" ||
        typeof row.taskId !== "string" || !row.taskId || typeof row.name !== "string" || !row.name ||
        typeof row.branch !== "string" || typeof row.updatedAt !== "string" ||
        typeof row.repoCount !== "number" || !Number.isSafeInteger(row.repoCount) || row.repoCount < 0) {
      throw new Error("桌面壳任务记录返回异常");
    }
    return row as unknown as DesktopTaskSummary;
  });
}
