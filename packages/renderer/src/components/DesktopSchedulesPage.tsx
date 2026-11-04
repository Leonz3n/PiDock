import { useEffect, useState } from "react";
import { shellSchedulerState, shellTaskOp } from "../data/shellBridge";
import { parseProviderStatus, providerCall } from "../data/providerProfile";
import { hostText } from "../data/workspaceFiles";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

type Task = { taskId: string; name: string };
type Permission = "read" | "default" | "auto";
type Schedule = { scheduleId: string; taskId: string; name: string; ruleText: string; timezone: string; enabled: boolean; providerId: string; model: string; prompt: string; permission: Permission; repairIssue?: string };
/**
 * [Pencil T17] one run as the Host persisted it. `running` is an accepted
 * SDK turn that has not settled yet; `actualModel` is the model that really
 * served it (absent = never started); `sessionId` is the run's own session, the
 * one 「继续对话」 opens.
 */
type Run = { runId: string; scheduleId: string; taskId: string; startedAt: string; result: "running" | "completed" | "awaiting-approval" | "skipped" | "failed" | "interrupted" | "uncertain"; reason?: string; model?: string; actualModel?: string; sessionId?: string; failureCode?: string };
/**
 * [Pencil T18] 工单 153 the scheduler's own phase plus the last quit that could not
 * prove every Host stopped. Both are main-owned facts, not derived from a run.
 */
type SchedulerState = { phase: "active" | "asleep" | "quitting"; blockedReason: string | null; sleepingSince?: string; lastQuitUnconfirmed?: { at: string; hosts: string[]; attempts?: number } };
type Result = { schedules: Schedule[]; runs: Run[]; errors: string[] };
const runLabels: Record<Run["result"], string> = { running: "执行中", completed: "已完成", "awaiting-approval": "待确认", skipped: "已跳过", failed: "失败", interrupted: "已中断", uncertain: "状态不确定" };
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
        !["running", "completed", "awaiting-approval", "skipped", "failed", "interrupted", "uncertain"].includes(String(item.result)) ||
        (item.reason !== undefined && !text(item.reason)) ||
        (item.model !== undefined && !text(item.model)) ||
        (item.actualModel !== undefined && !text(item.actualModel)) ||
        (item.sessionId !== undefined && !text(item.sessionId)) ||
        (item.failureCode !== undefined && !text(item.failureCode))) throw new Error("执行记录返回异常");
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

export function DesktopSchedulesPage({ tasks, onOpenTask, onOpenSession, onCreate }: { tasks: readonly Task[]; onOpenTask: (taskId: string) => void; onOpenSession?: (taskId: string, sessionId: string) => void; onCreate?: () => void }) {
  const [result, setResult] = useState<Result | null>(null);
  const [scheduler, setScheduler] = useState<SchedulerState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
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
    // [Pencil T18] 工单 153 the scheduler phase + last unconfirmed quit are main-owned;
    // a failed read keeps the previous banner instead of claiming 「运行中」.
    void shellSchedulerState().then((state) => { if (live && state !== null) setScheduler(state); });
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
        const status = parseProviderStatus(await providerCall({ taskId: editingTaskId, op: "list" }));
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
  const scheduleNames = new Map(schedules.map((row) => [`${row.taskId}:${row.scheduleId}`, row.name]));
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
  const chosen = shown.find((row) => `${row.taskId}:${row.scheduleId}` === selected) ?? shown[0];
  const runs = result?.runs.filter((run) => (chosen && run.taskId === chosen.taskId && run.scheduleId === chosen.scheduleId) || !scheduleNames.has(`${run.taskId}:${run.scheduleId}`)) ?? [];
  return <div data-testid="desktop-schedules-page" className="min-w-0">
    <div className="flex min-h-[52px] flex-wrap items-center justify-between gap-2 border-b border-line px-6 py-2">
      <div className="flex flex-wrap items-center gap-3"><h1 className="text-sm font-semibold">定时任务</h1><span className="below-mid:hidden"><Badge variant="soft">应用运行期间调度中 · 关窗后后台托盘继续 · 休眠不补跑</Badge></span></div>
      <div className="flex gap-2"><Button type="button" variant="ghost" size="sm" onClick={() => setRevision((value) => value + 1)}>刷新</Button>{onCreate && <Button type="button" size="sm" onClick={onCreate}>＋ 新建定时规则</Button>}</div>
    </div>
    {actionError && <p role="alert" data-testid="desktop-schedule-action-error" className="m-4 break-words text-xs text-destructive">{actionError}</p>}
    {scheduler && (scheduler.phase !== "active" || scheduler.lastQuitUnconfirmed !== undefined) && <div role="status" data-testid="desktop-scheduler-state" className="m-4 rounded border border-line p-3 text-xs text-muted">
      <strong>{{ active: "调度运行中", asleep: "系统休眠：不会执行或补跑，唤醒后按未来时间重新计划", quitting: "应用正在退出：不再执行定时触发" }[scheduler.phase]}</strong>
      {scheduler.lastQuitUnconfirmed && <p data-testid="desktop-scheduler-quit-unconfirmed">上次退出未确认（{scheduler.lastQuitUnconfirmed.at}）：{scheduler.lastQuitUnconfirmed.hosts.join("、") || "退出报告未指明任务"} 未确认停止；请检查是否仍有进程在运行。</p>}
    </div>}
    {!result ? <p role="status" className="p-6 text-xs text-muted">正在读取任务的定时配置…</p> : <>
      {result.errors.length > 0 && <div role="alert" className="m-4 rounded border border-line p-3 text-xs text-destructive">部分数据读取失败，以下仅展示成功读取的配置与记录。<ul>{result.errors.map((error) => <li key={error}>{error}</li>)}</ul></div>}
      <div className="grid min-w-0 grid-cols-[360px_minmax(0,1fr)] items-start gap-5 px-6 py-5 below-mid:grid-cols-1" data-testid="schedule-master-detail">
        <section aria-label="定时任务规则" className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center justify-between gap-2"><h2 className="text-xs font-semibold">定时任务规则 ({schedules.length})</h2><span className="text-[11px] text-muted">{schedules.filter((r) => r.enabled).length} 启用 · {schedules.filter((r) => !r.enabled).length} 暂停</span></div>
          <ToggleGroup type="single" value={filter} onValueChange={(value) => { if (value === "all" || value === "active" || value === "paused") setFilter(value); }} aria-label="定时任务筛选">{([["all", "全部"], ["active", "已启用"], ["paused", "已暂停"]] as const).map(([key,label]) => <ToggleGroupItem size="sm" value={key} key={key}>{label}</ToggleGroupItem>)}</ToggleGroup>
          {shown.map((row) => <button type="button" key={`${row.taskId}:${row.scheduleId}`} data-schedule-row={row.scheduleId} aria-label={`选择规则 ${hostText(row.name, "Host 未上报定时任务名称")}`} aria-pressed={chosen === row} onClick={() => setSelected(`${row.taskId}:${row.scheduleId}`)} className="flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-paper p-3 text-left text-xs aria-pressed:border-primary focus-visible:outline-2 focus-visible:outline-primary">
            <span className="flex w-full items-start justify-between gap-2"><strong className="min-w-0 break-words">{hostText(row.name, "Host 未上报定时任务名称")}</strong><Badge variant="soft">{row.repairIssue ? "配置待修复" : row.enabled ? "已启用" : "已暂停"}</Badge></span>
            <span className="break-all text-[11px] text-muted">{hostText(row.ruleText, "Host 未上报规则")} · {hostText(row.timezone, "Host 未上报时区")}</span>
            <span className="break-words text-[11px] text-muted">目标：{taskNames.get(row.taskId) ?? row.taskId}</span>
          </button>)}
          {shown.length === 0 && <p className="py-7 text-xs text-muted">{result.errors.length ? "成功读取的任务中没有符合筛选的定时配置。" : "当前筛选下没有定时任务。"}</p>}
        </section>
        <section aria-label="定时任务详情" className="min-w-0">
          {chosen && <div className="rounded-lg border border-line bg-paper p-4" data-testid="schedule-detail">
            <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h2 className="break-words text-sm font-semibold">{hostText(chosen.name, "Host 未上报定时任务名称")}</h2><p className="mt-1 break-all text-[11px] text-muted">规则: {hostText(chosen.ruleText, "Host 未上报规则")} · 时区 {hostText(chosen.timezone, "Host 未上报时区")}</p></div>
              <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy !== null} aria-label={`立即运行 ${chosen.name}`} onClick={() => void act(chosen, "task/scheduleRunNow", { label: "定时任务页" })}>立即运行</Button><Button size="sm" variant="outline" disabled={busy !== null} aria-label={`编辑 ${chosen.name}`} onClick={() => edit(chosen)}>编辑</Button><Button size="sm" variant="outline" disabled={busy !== null} aria-label={`${chosen.enabled ? "暂停" : "启用"} ${chosen.name}`} onClick={() => void act(chosen, "task/scheduleSetEnabled", { enabled: !chosen.enabled })}>{chosen.enabled ? "暂停" : "启用"}</Button><Button size="sm" variant="ghost" onClick={() => onOpenTask(chosen.taskId)}>查看任务</Button></div>
            </div>
            <div className="mt-3 rounded bg-sunken p-3 text-xs"><p className="whitespace-pre-wrap break-words">提示词: {chosen.prompt || "Host 未上报提示词"}</p><p className="mt-2 break-words text-[11px] text-muted">绑定模型: {hostText(chosen.providerId, "Host 未上报 Provider")} / {hostText(chosen.model, "Host 未上报模型")} · 固定任务工作区 · 每次独立会话 · {permissionLabels[chosen.permission]}</p>{chosen.repairIssue && <p role="alert" className="mt-2 break-words text-destructive">配置待修复：{chosen.repairIssue}</p>}</div>
          </div>}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2"><h2 className="text-xs font-semibold">定时执行记录（每次触发生成独立会话，历史可继续对话）</h2><span className="text-[11px] text-muted">同一任务已有执行未结束时跳过，不补跑</span></div>
          <div className="mt-2 overflow-hidden rounded-lg border border-line text-xs">
            <div className="bg-sunken px-3 py-2 text-[11px] text-muted">触发时间 · 会话 · 实际模型 · 执行结果</div>
            {runs.map((run) => <article key={`${run.taskId}:${run.runId}`} data-schedule-run={run.runId} className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-line bg-paper px-3 py-2">
              <div className="min-w-0 flex-1 break-words"><span className="font-mono text-[11px]">{hostText(run.startedAt, "Host 未上报开始时间")}</span> · {scheduleNames.has(`${run.taskId}:${run.scheduleId}`) ? hostText(scheduleNames.get(`${run.taskId}:${run.scheduleId}`), "Host 未上报定时任务名称") : "已删除的定时任务"} · <strong>{runLabels[run.result]}</strong><p className="mt-1 break-all text-[11px] text-muted">{run.sessionId ? `会话 ${run.sessionId}` : "未创建独立会话"} · {run.actualModel !== undefined ? hostText(run.actualModel, "Host 未上报模型") : run.model !== undefined ? `${hostText(run.model, "Host 未上报模型")}（未实际运行）` : "—"}</p>{(run.reason || run.failureCode) && <p className="mt-1 break-words text-[11px]">{run.failureCode && <span className="text-destructive">{run.failureCode}：</span>}{hostText(run.reason, "—")}</p>}</div>
              {run.sessionId && onOpenSession && <Button size="sm" variant="outline" onClick={() => onOpenSession(run.taskId, run.sessionId!)}>继续对话</Button>}
            </article>)}
            {runs.length === 0 && <p className="p-4 text-xs text-muted">{result.errors.length ? "成功读取的任务中没有执行记录。" : "暂无执行记录。"}</p>}
          </div>
        </section>
      </div>
    </>}
    {editing && <Dialog open onOpenChange={(open) => { if (!open && !pending) setEditing(null); }}>
      <DialogContent aria-labelledby={undefined} aria-label="编辑定时任务" className="max-w-[560px]" onInteractOutside={(event) => event.preventDefault()} onEscapeKeyDown={(event) => { if (pending) event.preventDefault(); }}>
        <DialogTitle>编辑定时任务</DialogTitle>
        <DialogDescription>归属任务：{taskNames.get(editing.taskId) ?? editing.taskId}（编排不改归属）。规则、时区与 Provider 由 Host 校验；保存成功后以 Host 的下一份清单为准。</DialogDescription>
        {profilesError && <p role="alert" className="mt-3 border border-line bg-paper p-2 text-xs text-destructive">Provider 列表读取失败：{profilesError}。不改用其它 Provider：保存仍用该定时任务已存的 Provider / 模型。</p>}
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
        {preview?.kind === "refused" && <p role="alert" className="mt-3 border border-line bg-paper p-2 text-xs text-destructive">{preview.message}</p>}
        {editorError && <p role="alert" className="mt-3 border border-line bg-paper p-2 break-words text-xs text-destructive">{editorError}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending !== null} onClick={() => setEditing(null)}>取消</Button>
          <Button type="button" variant="outline" disabled={pending !== null} onClick={() => void runPreview()}>{pending === "preview" ? "校验中…" : "校验并预览"}</Button>
          <Button type="button" disabled={pending !== null} onClick={() => void save()}>{pending === "save" ? "保存中…" : "保存"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>}
  </div>;
}
