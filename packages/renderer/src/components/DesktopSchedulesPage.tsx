import { useEffect, useState } from "react";
import { shellTaskOp } from "../data/shellBridge";
import { parseProviderStatus, providerCall } from "../data/providerProfile";
import { hostText } from "../data/workspaceFiles";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

type Task = { taskId: string; name: string };
type Permission = "read" | "default" | "auto";
type Schedule = { scheduleId: string; taskId: string; name: string; ruleText: string; timezone: string; enabled: boolean; providerId: string; model: string; prompt: string; permission: Permission; repairIssue?: string };
type Run = { runId: string; scheduleId: string; taskId: string; startedAt: string; result: "completed" | "awaiting-approval" | "skipped" | "failed"; reason?: string };
type Result = { schedules: Schedule[]; runs: Run[]; errors: string[] };
const runLabels: Record<Run["result"], string> = { completed: "已完成", "awaiting-approval": "待确认", skipped: "已跳过", failed: "失败" };
const permissionLabels: Record<Permission, string> = { read: "只读", default: "默认权限 · 需要时等待确认", auto: "自动执行 · 仍受任务边界约束" };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";

function parseSchedules(value: unknown, taskId: string): Schedule[] {
  if (!object(value) || !Array.isArray(value.schedules)) throw new Error("定时配置返回异常");
  return value.schedules.map((item: unknown) => {
    if (!object(item) || !["scheduleId", "taskId", "name", "ruleText", "timezone", "providerId", "model", "prompt"].every((key) => text(item[key])) ||
        !["read", "default", "auto"].includes(String(item.permission)) ||
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
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  /** The schedule being edited, copied from the Host's row; `null` = no editor. */
  const [editing, setEditing] = useState<Schedule | null>(null);
  /** The task's real Provider profiles, as `shell/providerOp list` answered. */
  const [profiles, setProfiles] = useState<{ id: string; name: string; modelId: string }[] | null>(null);
  const [profilesError, setProfilesError] = useState("");
  const [preview, setPreview] = useState<{ kind: "ok"; description: string; next: string | null } | { kind: "refused"; message: string } | null>(null);
  const [editorError, setEditorError] = useState("");
  const [pending, setPending] = useState<"preview" | "save" | null>(null);
  useEffect(() => {
    let live = true;
    setResult(null);
    void readSchedules(tasks).then((data) => { if (live) setResult(data); });
    return () => { live = false; };
  }, [tasks, revision]);
  // The Provider list belongs to the schedule's task: it is read once per opened
  // editor, and a failed read never substitutes another task's profiles.
  const editingTaskId = editing ? editing.taskId : null;
  const editingScheduleId = editing ? editing.scheduleId : null;
  useEffect(() => {
    if (editingTaskId === null) return undefined;
    let live = true;
    setProfiles(null);
    setProfilesError("");
    void (async () => {
      try {
        const status = parseProviderStatus(await providerCall(editingTaskId, { op: "list" }));
        if (live) setProfiles(status.profiles.map(({ id, name, modelId }) => ({ id, name, modelId })));
      } catch (error) {
        if (live) setProfilesError(error instanceof Error ? error.message : "Provider 列表读取失败");
      }
    })();
    return () => { live = false; };
  }, [editingTaskId, editingScheduleId]);
  /** Open the editor on the Host's row, not on re-parsed rule text. */
  const edit = (row: Schedule) => { setEditing({ ...row }); setPreview(null); setEditorError(""); setPending(null); };
  const patch = (change: Partial<Schedule>) => setEditing((current) => (current ? { ...current, ...change } : current));
  /** Rule validation and the next trigger are the Host's answer; the editor never derives them. */
  const runPreview = async () => {
    if (!editing) return;
    setPending("preview");
    setEditorError("");
    setPreview(null);
    try {
      const answer = await shellTaskOp(editing.taskId, "task/schedulePreview", { ruleText: editing.ruleText, timezone: editing.timezone });
      if (!answer.ok) { setPreview({ kind: "refused", message: answer.error ?? "Host 未返回原因" }); return; }
      const previewed = object(answer.payload) ? answer.payload["preview"] : undefined;
      if (object(previewed) && previewed["ok"] === true && text(previewed["description"])) {
        setPreview({ kind: "ok", description: previewed["description"], next: text(previewed["nextTriggerAt"]) ? previewed["nextTriggerAt"] : null });
        return;
      }
      if (object(previewed) && previewed["ok"] === false && text(previewed["message"])) {
        setPreview({ kind: "refused", message: previewed["message"] });
        return;
      }
      setPreview({ kind: "refused", message: "预览返回异常" });
    } catch (error) {
      setPreview({ kind: "refused", message: error instanceof Error ? error.message : "Host 调用失败" });
    } finally {
      setPending(null);
    }
  };
  const save = async () => {
    if (!editing) return;
    setPending("save");
    setEditorError("");
    try {
      const answer = await shellTaskOp(editing.taskId, "task/scheduleSave", {
        scheduleId: editing.scheduleId,
        name: editing.name,
        ruleText: editing.ruleText,
        timezone: editing.timezone,
        prompt: editing.prompt,
        providerId: editing.providerId,
        model: editing.model,
        permission: editing.permission,
      });
      if (!answer.ok) { setEditorError(answer.error ?? "Host 未返回原因"); return; }
      setEditing(null);
      setRevision((value) => value + 1);
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "Host 调用失败");
    } finally {
      setPending(null);
    }
  };
  const schedules = result?.schedules ?? [];
  const shown = schedules.filter((row) => filter === "all" || row.enabled === (filter === "active"));
  const taskNames = new Map(tasks.map((task) => [task.taskId, task.name]));
  const scheduleNames = new Map(schedules.map((row) => [row.scheduleId, row.name]));
  /**
   * Both row actions are Host decisions, never local edits: an accepted call is
   * followed by a full re-read (the badge and the run table come from the Host's
   * next answer), a refused one keeps the previous rows and quotes the reason
   * verbatim. `scheduleRunNow` is what mints the run record, so nothing is shown
   * as started until the Host has answered.
   */
  const act = async (row: Schedule, op: "task/scheduleSetEnabled" | "task/scheduleRunNow", payload: Record<string, unknown>) => {
    const key = `${row.taskId}:${row.scheduleId}:${op}`;
    setBusy(key);
    setActionError("");
    try {
      const answer = await shellTaskOp(row.taskId, op, { ...payload, scheduleId: row.scheduleId });
      if (!answer.ok) { setActionError(`${hostText(row.name, row.scheduleId)}：${answer.error ?? "Host 未返回原因"}`); return; }
      setRevision((value) => value + 1);
    } catch (error) {
      setActionError(`${hostText(row.name, row.scheduleId)}：${error instanceof Error ? error.message : "Host 调用失败"}`);
    } finally {
      setBusy(null);
    }
  };
  return <div data-testid="desktop-schedules-page" className="px-[34px] py-[30px] below-narrow:px-5">
    <div className="flex items-start justify-between gap-3">
      <div><p className="text-[10px] uppercase tracking-[1.8px] text-[#95979c]">Scheduled Tasks</p><h1 className="mt-1.5 text-[26px] font-semibold text-ink">定时任务</h1></div>
      <Button type="button" variant="outline" size="sm" onClick={() => setRevision((value) => value + 1)}>刷新</Button>
    </div>
    <p className="mt-1.5 text-xs text-muted">每项配置属于一个真实任务；执行记录来自任务 Host。启用、暂停、立即运行与编辑由 Host 决定并回执；新建定时任务的生产入口未接线。</p>
    {actionError && <p role="alert" data-testid="desktop-schedule-action-error" className="mt-2 break-words text-xs text-[#ad4545]">{actionError}</p>}
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
          <div className="min-w-0"><strong className="block break-words text-xs">{hostText(row.ruleText, "Host 未上报规则")}</strong><span className="text-[11px] text-muted">{hostText(row.timezone, "Host 未上报时区")}</span></div>
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{hostText(row.name, "Host 未上报定时任务名称")}</strong><Badge variant="soft">{row.repairIssue ? "配置待修复" : row.enabled ? "已启用" : "已暂停"}</Badge></div><p className="mt-1 text-xs text-muted">{taskNames.get(row.taskId) ?? row.taskId} · {hostText(row.providerId, "Host 未上报 Provider")} / {hostText(row.model, "Host 未上报模型")}</p><p className="mt-1 line-clamp-2 break-words text-xs text-muted">{row.repairIssue || row.prompt}</p></div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button size="sm" variant="outline" disabled={busy !== null} aria-label={`${row.enabled ? "暂停" : "启用"} ${hostText(row.name, "Host 未上报定时任务名称")}`} onClick={() => void act(row, "task/scheduleSetEnabled", { enabled: !row.enabled })}>{row.enabled ? "暂停" : "启用"}</Button>
            <Button size="sm" variant="outline" disabled={busy !== null} aria-label={`立即运行 ${hostText(row.name, "Host 未上报定时任务名称")}`} onClick={() => void act(row, "task/scheduleRunNow", { label: "定时任务页" })}>立即运行</Button>
            <Button size="sm" variant="outline" disabled={busy !== null} aria-label={`编辑 ${hostText(row.name, "Host 未上报定时任务名称")}`} onClick={() => edit(row)}>编辑</Button>
            <Button size="sm" variant="outline" onClick={() => onOpenTask(row.taskId)}>查看任务</Button>
          </div>
        </article>)}
        {shown.length === 0 && <p className="py-7 text-center text-xs text-muted">{result.errors.length ? "成功读取的任务中没有符合筛选的定时配置。" : "当前筛选下没有定时任务。"}</p>}
      </div>
      <div className="mt-7 flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">执行记录</h2><span className="text-xs text-muted">{result.runs.length} 条{result.errors.length ? "（部分）" : ""}</span></div>
      <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[550px] text-left text-xs"><thead className="border-b border-line text-muted"><tr><th className="py-2 font-medium">开始时间</th><th className="font-medium">定时任务</th><th className="font-medium">结果</th><th className="font-medium">详情</th></tr></thead><tbody>{result.runs.map((run) => <tr key={`${run.taskId}:${run.runId}`} className="border-b border-line" data-schedule-run={run.runId}><td className="py-2">{hostText(run.startedAt, "Host 未上报开始时间")}</td>{/* `parseSchedules` reads `name` with `text = typeof === "string"`, so a blank
              name is a reachable value; `??` only catches a MISSING schedule, so
              the blank one is named like the card's own heading instead of
              rendering an empty 定时任务 cell. */}<td>{scheduleNames.get(run.scheduleId) === undefined ? "已删除的定时任务" : hostText(scheduleNames.get(run.scheduleId), "Host 未上报定时任务名称")}</td><td>{runLabels[run.result]}</td><td className="break-words">{hostText(run.reason, "—")}</td></tr>)}</tbody></table>{result.runs.length === 0 && <p className="py-4 text-xs text-muted">{result.errors.length ? "成功读取的任务中没有执行记录。" : "暂无执行记录。"}</p>}</div>
    </>}
    {editing && <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4">
      <div role="dialog" aria-modal="true" aria-label="编辑定时任务" className="max-h-[90vh] w-full max-w-[560px] overflow-y-auto rounded-[7px] border border-line bg-paper p-5 shadow-lg">
        <h2 className="text-base font-semibold">编辑定时任务</h2>
        <p className="mt-2 text-xs text-muted">归属任务：{taskNames.get(editing.taskId) ?? editing.taskId}（编排不改归属）。规则、时区与 Provider 由 Host 校验；保存成功后以 Host 的下一份清单为准。</p>
        {profilesError && <p role="alert" className="mt-3 border border-[#e0b4b4] bg-[#fdf3f3] p-2 text-xs text-[#ad4545]">Provider 列表读取失败：{profilesError}。不改用其它 Provider：保存仍用该定时任务已存的 Provider / 模型。</p>}
        <div className="mt-4 grid gap-3">
          <label className="grid gap-1 text-xs">名称<input aria-label="名称" className="min-h-8 rounded-[4px] border border-line bg-paper px-2" value={editing.name} onChange={(event) => patch({ name: event.target.value })} /></label>
          <label className="grid gap-1 text-xs">Provider / 模型<select aria-label="Provider / 模型" className="min-h-8 rounded-[4px] border border-line bg-paper px-2" value={`${editing.providerId}\u0000${editing.model}`} onChange={(event) => { const [providerId = "", model = ""] = event.target.value.split("\u0000"); patch({ providerId, model }); }}>
            {!profiles?.some((entry) => entry.id === editing.providerId && entry.modelId === editing.model) && <option value={`${editing.providerId}\u0000${editing.model}`}>{`${hostText(editing.providerId, "Host 未上报 Provider")} / ${hostText(editing.model, "Host 未上报模型")}（不在当前 Provider 列表）`}</option>}
            {(profiles ?? []).map((entry) => <option key={`${entry.id}\u0000${entry.modelId}`} value={`${entry.id}\u0000${entry.modelId}`}>{`${hostText(entry.name, "Host 未上报 Provider 名称")} / ${entry.modelId}`}</option>)}
          </select><span className="text-[11px] text-muted">{profiles === null && !profilesError ? "正在读取该任务的 Provider…" : "选项来自该任务的真实 Provider 配置；不会回退到本机其它凭据。"}</span></label>
          <label className="grid gap-1 text-xs">规则<input aria-label="规则" className="min-h-8 rounded-[4px] border border-line bg-paper px-2 font-mono" value={editing.ruleText} onChange={(event) => { patch({ ruleText: event.target.value }); setPreview(null); }} /><span className="text-[11px] text-muted">Host 接受的写法：每日 09:15 / 每周五 15:00 / 周一至周五 09:15 / 一次性 2026-10-01T09:00 / 五段 Cron。</span></label>
          <label className="grid gap-1 text-xs">时区<input aria-label="时区" className="min-h-8 rounded-[4px] border border-line bg-paper px-2" value={editing.timezone} list="desktop-schedule-timezones" onChange={(event) => { patch({ timezone: event.target.value }); setPreview(null); }} /><datalist id="desktop-schedule-timezones"><option value="Asia/Shanghai" /><option value="UTC" /><option value="America/Los_Angeles" /></datalist></label>
          <label className="grid gap-1 text-xs">新会话权限<select aria-label="新会话权限" className="min-h-8 rounded-[4px] border border-line bg-paper px-2" value={editing.permission} onChange={(event) => patch({ permission: event.target.value as Permission })}>{(Object.keys(permissionLabels) as Permission[]).map((key) => <option key={key} value={key}>{permissionLabels[key]}</option>)}</select></label>
          <label className="grid gap-1 text-xs">提示词<textarea aria-label="提示词" rows={5} className="rounded-[4px] border border-line bg-paper px-2 py-1" value={editing.prompt} onChange={(event) => patch({ prompt: event.target.value })} /><span className="text-[11px] text-muted">结果如何使用写在提示词里；不接受额外的发送 / 通知配置字段。</span></label>
        </div>
        {preview?.kind === "ok" && <div className="mt-3 text-xs"><p data-testid="desktop-schedule-preview">{preview.description}</p><p className="text-muted">{preview.next === null ? "Host 未给出下次触发时间" : `下次触发 ${preview.next}`}</p></div>}
        {preview?.kind === "refused" && <p role="alert" className="mt-3 border border-[#e0b4b4] bg-[#fdf3f3] p-2 text-xs text-[#ad4545]">{preview.message}</p>}
        {editorError && <p role="alert" className="mt-3 border border-[#e0b4b4] bg-[#fdf3f3] p-2 break-words text-xs text-[#ad4545]">{editorError}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={pending !== null} onClick={() => setEditing(null)}>取消</Button>
          <Button type="button" variant="outline" disabled={pending !== null} onClick={() => void runPreview()}>{pending === "preview" ? "校验中…" : "校验并预览"}</Button>
          <Button type="button" disabled={pending !== null} onClick={() => void save()}>{pending === "save" ? "保存中…" : "保存"}</Button>
        </div>
      </div>
    </div>}
  </div>;
}
