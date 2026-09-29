import { useEffect, useState } from "react";
import { lifecycleStateThroughShell, setTaskArchivedThroughShell } from "../data/shellBridge";
import { Button } from "./ui/button";

type Task = { taskId: string; name: string; repoCount: number };
type ArchivedTask = Task & { archivedAt: string | null };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export function parseLifecycle(value: unknown, taskId: string): { archived: boolean; archivedAt: string | null } {
  if (!object(value) || !object(value.lifecycle) || value.lifecycle.taskId !== taskId || typeof value.lifecycle.archived !== "boolean" ||
    !(value.lifecycle.archivedAt === null || typeof value.lifecycle.archivedAt === "string") ||
    (value.lifecycle.archived && !value.lifecycle.archivedAt)) throw new Error("归档状态返回异常");
  return { archived: value.lifecycle.archived, archivedAt: value.lifecycle.archivedAt };
}

async function readArchived(tasks: readonly Task[]): Promise<{ rows: ArchivedTask[]; errors: string[] }> {
  const settled = await Promise.all(tasks.map(async (task) => {
    try {
      const response = await lifecycleStateThroughShell(task.taskId);
      if (!response.ok) throw new Error(response.error ?? "读取失败");
      const state = parseLifecycle(response.payload, task.taskId);
      return { row: state.archived ? { ...task, archivedAt: state.archivedAt } : null, error: "" };
    } catch (error) {
      return { row: null, error: `${task.name}：${error instanceof Error ? error.message : "读取失败"}` };
    }
  }));
  return { rows: settled.flatMap((item) => item.row ? [item.row] : []), errors: settled.map((item) => item.error).filter(Boolean) };
}

export function DesktopArchivePage({ tasks, onRestored }: { tasks: readonly Task[]; onRestored: () => void }) {
  const [result, setResult] = useState<{ rows: ArchivedTask[]; errors: string[] } | null>(null);
  const [revision, setRevision] = useState(0);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  useEffect(() => {
    let live = true;
    setResult(null);
    void readArchived(tasks).then((next) => { if (live) setResult(next); });
    return () => { live = false; };
  }, [tasks, revision]);
  const restore = async (taskId: string) => {
    setActionError("");
    setRestoring(taskId);
    try {
      const response = await setTaskArchivedThroughShell({ taskId, archived: false });
      if (!response.ok) throw new Error(response.error ?? "恢复失败");
      const lifecycle = parseLifecycle(response.payload, taskId);
      if (lifecycle.archived) throw new Error("恢复返回的归档状态异常，请重新读取");
      setRevision((value) => value + 1);
      onRestored();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "恢复失败");
    } finally {
      setRestoring(null);
    }
  };
  return <div data-testid="desktop-archive-page" className="px-[34px] py-[30px] below-narrow:px-5">
    <div className="flex items-start justify-between gap-3">
      <div><p className="text-[10px] uppercase tracking-[1.8px] text-[#95979c]">Archived Tasks</p><h1 className="mt-1.5 text-[26px] font-semibold text-ink">已归档</h1></div>
      <Button type="button" size="sm" variant="outline" onClick={() => setRevision((value) => value + 1)}>刷新</Button>
    </div>
    <p className="mt-1.5 text-xs text-muted">归档保留任务记录；恢复不会自动重新启动服务或定时任务。清理与导出的生产界面未接线。</p>
    {actionError && <p role="alert" className="mt-4 border border-[#e0b4b4] bg-[#fdf3f3] p-3 text-xs text-[#ad4545]">{actionError}</p>}
    {!result ? <p role="status" className="mt-6 text-xs text-muted">正在读取任务归档状态…</p> : <>
      {result.errors.length > 0 && <div role="alert" className="mt-5 border border-[#e0b4b4] bg-[#fdf3f3] p-3 text-xs text-[#ad4545]">部分任务读取失败，列表可能不完整。<ul className="mt-1 list-inside list-disc">{result.errors.map((error) => <li key={error}>{error}</li>)}</ul></div>}
      <div className="mt-6 divide-y divide-line border-y border-line">
        {result.rows.map((task) => <article key={task.taskId} data-archived-task={task.taskId} className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div className="min-w-0"><h2 className="break-words text-sm font-semibold">{task.name}</h2><p className="mt-1 text-xs text-muted">{task.repoCount} 个仓库 · 归档于 {task.archivedAt}</p></div>
          <div className="flex items-center gap-2"><Button size="sm" variant="outline" disabled={restoring !== null} onClick={() => void restore(task.taskId)}>恢复</Button><Button size="sm" variant="outline" disabled title="清理的生产界面未接线">清理…</Button></div>
        </article>)}
        {result.rows.length === 0 && <p className="py-8 text-center text-xs text-muted">{result.errors.length ? "成功读取的任务中没有归档项。" : "还没有归档任务。"}</p>}
      </div>
    </>}
  </div>;
}
