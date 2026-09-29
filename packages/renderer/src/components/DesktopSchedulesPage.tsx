import { useEffect, useState } from "react";
import { shellTaskOp } from "../data/shellBridge";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

type Task = { taskId: string; name: string };
type Schedule = { scheduleId: string; taskId: string; name: string; ruleText: string; timezone: string; enabled: boolean; providerId: string; model: string; prompt: string; repairIssue?: string };
type Run = { runId: string; scheduleId: string; taskId: string; startedAt: string; result: "completed" | "awaiting-approval" | "skipped" | "failed"; reason?: string };
type Result = { schedules: Schedule[]; runs: Run[]; errors: string[] };
const runLabels: Record<Run["result"], string> = { completed: "已完成", "awaiting-approval": "待确认", skipped: "已跳过", failed: "失败" };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";

function parseSchedules(value: unknown, taskId: string): Schedule[] {
  if (!object(value) || !Array.isArray(value.schedules)) throw new Error("定时配置返回异常");
  return value.schedules.map((item: unknown) => {
    if (!object(item) || !["scheduleId", "taskId", "name", "ruleText", "timezone", "providerId", "model", "prompt"].every((key) => text(item[key])) ||
        item.taskId !== taskId || typeof item.enabled !== "boolean" || (item.repairIssue !== undefined && !text(item.repairIssue))) throw new Error("定时配置返回异常");
    return item as Schedule;
  });
}
function parseRuns(value: unknown, taskId: string): Run[] {
  if (!object(value) || !Array.isArray(value.runs)) throw new Error("执行记录返回异常");
  return value.runs.map((item: unknown) => {
    if (!object(item) || !["runId", "scheduleId", "taskId", "startedAt"].every((key) => text(item[key])) || item.taskId !== taskId ||
        !["completed", "awaiting-approval", "skipped", "failed"].includes(String(item.result)) || (item.reason !== undefined && !text(item.reason))) throw new Error("执行记录返回异常");
    return item as Run;
  });
}
async function readSchedules(tasks: readonly Task[]): Promise<Result> {
  const settled = await Promise.all(tasks.map(async (task) => {
    try {
      const list = await shellTaskOp(task.taskId, "task/scheduleList");
      if (!list.ok) throw new Error(list.error ?? "读取失败");
      const schedules = parseSchedules(list.payload, task.taskId);
      try {
        const history = await shellTaskOp(task.taskId, "task/scheduleRuns");
        if (!history.ok) throw new Error(history.error ?? "读取失败");
        return { schedules, runs: parseRuns(history.payload, task.taskId), error: "" };
      } catch (error) {
        return { schedules, runs: [] as Run[], error: `${task.name}：执行记录 ${error instanceof Error ? error.message : "读取失败"}` };
      }
    } catch (error) {
      return { schedules: [], runs: [], error: `${task.name}：${error instanceof Error ? error.message : "读取失败"}` };
    }
  }));
  return { schedules: settled.flatMap((row) => row.schedules), runs: settled.flatMap((row) => row.runs).sort((a, b) => b.startedAt.localeCompare(a.startedAt)), errors: settled.map((row) => row.error).filter(Boolean) };
}

export function DesktopSchedulesPage({ tasks, onOpenTask }: { tasks: readonly Task[]; onOpenTask: (taskId: string) => void }) {
  const [result, setResult] = useState<Result | null>(null);
  const [filter, setFilter] = useState<"all" | "active" | "paused">("all");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    setResult(null);
    void readSchedules(tasks).then((data) => { if (live) setResult(data); });
    return () => { live = false; };
  }, [tasks, revision]);
  const schedules = result?.schedules ?? [];
  const shown = schedules.filter((row) => filter === "all" || row.enabled === (filter === "active"));
  const taskNames = new Map(tasks.map((task) => [task.taskId, task.name]));
  const scheduleNames = new Map(schedules.map((row) => [row.scheduleId, row.name]));
  return <div data-testid="desktop-schedules-page" className="px-[34px] py-[30px] below-narrow:px-5">
    <div className="flex items-start justify-between gap-3">
      <div><p className="text-[10px] uppercase tracking-[1.8px] text-[#95979c]">Scheduled Tasks</p><h1 className="mt-1.5 text-[26px] font-semibold text-ink">定时任务</h1></div>
      <Button type="button" variant="outline" size="sm" onClick={() => setRevision((value) => value + 1)}>刷新</Button>
    </div>
    <p className="mt-1.5 text-xs text-muted">每项配置属于一个真实任务；执行记录来自任务 Host。创建、编辑与立即运行的生产入口未接线。</p>
    {!result ? <p role="status" className="mt-6 text-xs text-muted">正在读取任务的定时配置…</p> : <>
      {result.errors.length > 0 && <div role="alert" className="mt-5 border border-[#e0b4b4] bg-[#fdf3f3] p-3 text-xs text-[#ad4545]">部分数据读取失败，以下仅展示成功读取的配置与记录。<ul className="mt-1 list-inside list-disc">{result.errors.map((error) => <li key={error}>{error}</li>)}</ul></div>}
      <div className="mt-6 grid grid-cols-3 gap-3 below-mid:grid-cols-1">
        <div className="rounded-[7px] border border-line bg-paper p-4"><p className="text-xs text-muted">已启用{result.errors.length ? "（部分）" : ""}</p><strong className="text-xl">{schedules.filter((row) => row.enabled).length}</strong></div>
        <div className="rounded-[7px] border border-line bg-paper p-4"><p className="text-xs text-muted">已暂停{result.errors.length ? "（部分）" : ""}</p><strong className="text-xl">{schedules.filter((row) => !row.enabled).length}</strong></div>
        <div className="rounded-[7px] border border-line bg-paper p-4"><p className="text-xs text-muted">最近执行</p><strong className="text-sm">{result.runs[0] ? runLabels[result.runs[0].result] : "暂无"}</strong></div>
      </div>
      <div className="mt-6 flex gap-1" role="group" aria-label="定时任务筛选">{([ ["all", "全部"], ["active", "已启用"], ["paused", "已暂停"] ] as const).map(([key, label]) => <Button key={key} size="sm" variant={filter === key ? "secondary" : "ghost"} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</Button>)}</div>
      <div className="mt-3 divide-y divide-line border-y border-line">
        {shown.map((row) => <article key={`${row.taskId}:${row.scheduleId}`} className="grid grid-cols-[minmax(130px,0.8fr)_minmax(0,2fr)_auto] items-center gap-4 py-4 below-mid:grid-cols-1" data-schedule-row={row.scheduleId}>
          <div className="min-w-0"><strong className="block break-words text-xs">{row.ruleText}</strong><span className="text-[11px] text-muted">{row.timezone}</span></div>
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{row.name}</strong><Badge variant="soft">{row.repairIssue ? "配置待修复" : row.enabled ? "已启用" : "已暂停"}</Badge></div><p className="mt-1 text-xs text-muted">{taskNames.get(row.taskId) ?? row.taskId} · {row.providerId} / {row.model}</p><p className="mt-1 line-clamp-2 break-words text-xs text-muted">{row.repairIssue || row.prompt}</p></div>
          <Button size="sm" variant="outline" onClick={() => onOpenTask(row.taskId)}>查看任务</Button>
        </article>)}
        {shown.length === 0 && <p className="py-7 text-center text-xs text-muted">{result.errors.length ? "成功读取的任务中没有符合筛选的定时配置。" : "当前筛选下没有定时任务。"}</p>}
      </div>
      <div className="mt-7 flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">执行记录</h2><span className="text-xs text-muted">{result.runs.length} 条{result.errors.length ? "（部分）" : ""}</span></div>
      <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[550px] text-left text-xs"><thead className="border-b border-line text-muted"><tr><th className="py-2 font-medium">开始时间</th><th className="font-medium">定时任务</th><th className="font-medium">结果</th><th className="font-medium">详情</th></tr></thead><tbody>{result.runs.map((run) => <tr key={`${run.taskId}:${run.runId}`} className="border-b border-line" data-schedule-run={run.runId}><td className="py-2">{run.startedAt}</td><td>{scheduleNames.get(run.scheduleId) ?? "已删除的定时任务"}</td><td>{runLabels[run.result]}</td><td className="break-words">{run.reason ?? "—"}</td></tr>)}</tbody></table>{result.runs.length === 0 && <p className="py-4 text-xs text-muted">{result.errors.length ? "成功读取的任务中没有执行记录。" : "暂无执行记录。"}</p>}</div>
    </>}
  </div>;
}
