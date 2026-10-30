import { useEffect, useState } from "react";
import { cleanupPreviewThroughShell, lifecycleStateThroughShell, runCleanupThroughShell, setTaskArchivedThroughShell } from "../data/shellBridge";
import { resourceVerdictConclusion } from "../data/taskLifecycle";
import type { CleanupSelection } from "../data/types";
import { Button } from "./ui/button";

type Task = { taskId: string; name: string; repoCount: number };
/** One Host resource verdict as the archived row shows it: `ok === null` means the Host judged nothing. */
type ResourceVerdictView = { subject: string; ok: boolean | null; reason?: string };
type ArchivedTask = Task & { archivedAt: string | null; verdicts: ResourceVerdictView[] | undefined };
type CleanupDisposition = "remove" | "keep-copy" | "keep";
type CleanupItemView = { resource?: string; detail?: string; disposition?: CleanupDisposition };
type CleanupPreviewView = {
  items?: CleanupItemView[];
  warnings?: string[];
  recordsWillBeRemoved?: boolean;
  selectionLabels?: string[];
  keepRoot?: string;
};
type CleanupRunView = {
  items?: CleanupItemView[];
  receipt?: { keptPosition?: string | null; exports?: string[]; removed?: string[]; partialFailure?: boolean };
  recovery?: { item?: string; reason?: string }[];
  error?: string;
};
type CleanupPanel = {
  taskId: string;
  selection: CleanupSelection;
  preview?: CleanupPreviewView;
  result?: CleanupRunView;
  error?: string;
  previewing?: boolean;
  running?: boolean;
};
const defaultSelection: CleanupSelection = { exportSessions: false, exportDrafts: false, exportUsage: false };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): string[] | undefined => Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;

export function parseLifecycle(value: unknown, taskId: string): { archived: boolean; archivedAt: string | null; verdicts: ResourceVerdictView[] | undefined } {
  if (!object(value) || !object(value.lifecycle) || value.lifecycle.taskId !== taskId || typeof value.lifecycle.archived !== "boolean" ||
    !(value.lifecycle.archivedAt === null || typeof value.lifecycle.archivedAt === "string") ||
    (value.lifecycle.archived && !value.lifecycle.archivedAt)) throw new Error("归档状态返回异常");
  return { archived: value.lifecycle.archived, archivedAt: value.lifecycle.archivedAt, verdicts: resourceVerdicts(value.lifecycle.resources) };
}

function processKindLabel(kind: string | undefined): string {
  if (kind === "service") return "服务";
  if (kind === "terminal") return "终端";
  if (kind === "process-tree") return "派生子进程";
  return "未知资源";
}

/** `null` when the Host reported no verdict for this resource — never read as clearable. */
function verdictOk(verdict: Record<string, unknown> | undefined): boolean | null {
  if (verdict?.["ok"] === true) return true;
  if (verdict?.["ok"] === false) return false;
  return null;
}

/**
 * Host resource verdicts: each worktree/process entry carries its own `verdict`
 * (`resources.worktrees[].verdict` / `resources.processes[].verdict`). `undefined`
 * when the Host reported no resources at all, so the page can tell "未上报"
 * from "上报了 0 项".
 */
function resourceVerdicts(resources: unknown): ResourceVerdictView[] | undefined {
  if (!object(resources)) return undefined;
  const worktrees = resources["worktrees"];
  const processes = resources["processes"];
  if (worktrees === undefined && processes === undefined) return undefined;
  const entries: ResourceVerdictView[] = [];
  for (const entry of Array.isArray(worktrees) ? worktrees : []) {
    const row = object(entry) ? entry : {};
    const verdict = object(row["verdict"]) ? row["verdict"] : undefined;
    entries.push({
      subject: `工作副本 ${typeof row["repoDir"] === "string" ? row["repoDir"] : "Host 未上报路径"}`,
      ok: verdictOk(verdict),
      ...(typeof verdict?.["reason"] === "string" ? { reason: verdict["reason"] } : {}),
    });
  }
  for (const entry of Array.isArray(processes) ? processes : []) {
    const row = object(entry) ? entry : {};
    const verdict = object(row["verdict"]) ? row["verdict"] : undefined;
    entries.push({
      subject: `${processKindLabel(typeof row["kind"] === "string" ? row["kind"] : undefined)} ${typeof row["id"] === "string" ? row["id"] : "Host 未上报标识"}`,
      ok: verdictOk(verdict),
      ...(typeof verdict?.["reason"] === "string" ? { reason: verdict["reason"] } : {}),
    });
  }
  return entries;
}

function cleanupItems(value: unknown): CleanupItemView[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => {
    const item = object(entry) ? entry : {};
    return {
      ...(typeof item["resource"] === "string" ? { resource: item["resource"] } : {}),
      ...(typeof item["detail"] === "string" ? { detail: item["detail"] } : {}),
      ...(item["disposition"] === "remove" || item["disposition"] === "keep-copy" || item["disposition"] === "keep" ? { disposition: item["disposition"] } : {}),
    };
  });
}

function parseCleanupPreview(value: unknown): CleanupPreviewView {
  if (!object(value) || !object(value.preview)) throw new Error("清理预览返回异常");
  const preview = value.preview;
  return {
    ...(cleanupItems(preview["items"]) !== undefined ? { items: cleanupItems(preview["items"]) } : {}),
    ...(strings(preview["warnings"]) !== undefined ? { warnings: strings(preview["warnings"]) } : {}),
    ...(typeof preview["recordsWillBeRemoved"] === "boolean" ? { recordsWillBeRemoved: preview["recordsWillBeRemoved"] } : {}),
    ...(strings(preview["selectionLabels"]) !== undefined ? { selectionLabels: strings(preview["selectionLabels"]) } : {}),
    ...(typeof preview["keepRoot"] === "string" ? { keepRoot: preview["keepRoot"] } : {}),
  };
}

function parseCleanupRun(value: unknown): CleanupRunView {
  if (!object(value) || !object(value.cleanup)) return {};
  const cleanup = value.cleanup;
  const receiptValue = object(cleanup["receipt"]) ? cleanup["receipt"] : undefined;
  const recoveryValue = Array.isArray(cleanup["recovery"]) ? cleanup["recovery"] : undefined;
  return {
    ...(cleanupItems(cleanup["items"]) !== undefined ? { items: cleanupItems(cleanup["items"]) } : {}),
    ...(receiptValue ? { receipt: {
      ...(typeof receiptValue["keptPosition"] === "string" || receiptValue["keptPosition"] === null ? { keptPosition: receiptValue["keptPosition"] } : {}),
      ...(strings(receiptValue["exports"]) !== undefined ? { exports: strings(receiptValue["exports"]) } : {}),
      ...(strings(receiptValue["removed"]) !== undefined ? { removed: strings(receiptValue["removed"]) } : {}),
      ...(typeof receiptValue["partialFailure"] === "boolean" ? { partialFailure: receiptValue["partialFailure"] } : {}),
    } } : {}),
    ...(recoveryValue ? { recovery: recoveryValue.map((entry) => {
      const item = object(entry) ? entry : {};
      return {
        ...(typeof item["item"] === "string" ? { item: item["item"] } : {}),
        ...(typeof item["reason"] === "string" ? { reason: item["reason"] } : {}),
      };
    }) } : {}),
    ...(typeof cleanup["error"] === "string" ? { error: cleanup["error"] } : {}),
  };
}

function dispositionLabel(disposition: CleanupDisposition | undefined): string {
  if (disposition === "remove") return "将删除";
  if (disposition === "keep-copy") return "将保留独立副本";
  if (disposition === "keep") return "将保留";
  return "Host 未上报处理方式";
}

function itemDetails(items: CleanupItemView[] | undefined, disposition: CleanupDisposition): string[] {
  return (items ?? []).filter((item) => item.disposition === disposition).map((item) =>
    `${item.resource ?? "Host 未上报资源"}：${item.detail ?? "Host 未上报详情"}`,
  );
}

function confirmationText(taskName: string, preview: CleanupPreviewView): string {
  const removing = itemDetails(preview.items, "remove");
  const kept = [...itemDetails(preview.items, "keep-copy"), ...itemDetails(preview.items, "keep")];
  const hasUnreportedDisposition = preview.items?.some((item) => item.disposition === undefined) ?? false;
  const removeText = removing.length > 0 ? removing.join("；") : !preview.items ? "Host 未上报将删除项目" : hasUnreportedDisposition ? "Host 未上报将删除项目" : "Host 上报无待删除项目";
  const keepText = kept.length > 0 ? kept.join("；") : !preview.items ? "Host 未上报保留项目" : hasUnreportedDisposition ? "Host 未上报保留项目" : "Host 上报无保留项目";
  return `即将清理「${taskName}」。Host 预览将删除：${removeText}。Host 预览将保留：${keepText}。清理不可自动恢复，是否继续？`;
}

async function readArchived(tasks: readonly Task[]): Promise<{ rows: ArchivedTask[]; errors: string[] }> {
  const settled = await Promise.all(tasks.map(async (task) => {
    try {
      const response = await lifecycleStateThroughShell(task.taskId);
      if (!response.ok) throw new Error(response.error ?? "读取失败");
      const state = parseLifecycle(response.payload, task.taskId);
      return { row: state.archived ? { ...task, archivedAt: state.archivedAt, verdicts: state.verdicts } : null, error: "" };
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
  const [cleanup, setCleanup] = useState<CleanupPanel | null>(null);
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
  const openCleanup = (taskId: string) => {
    setCleanup((current) => current?.taskId === taskId ? null : { taskId, selection: { ...defaultSelection } });
  };
  const changeSelection = (key: keyof CleanupSelection, checked: boolean) => {
    setCleanup((current) => current ? { ...current, selection: { ...current.selection, [key]: checked }, preview: undefined, result: undefined, error: undefined } : current);
  };
  const previewCleanup = async (taskId: string) => {
    const current = cleanup;
    if (!current || current.taskId !== taskId) return;
    setCleanup({ ...current, previewing: true, error: undefined, result: undefined });
    const response = await cleanupPreviewThroughShell({ taskId, selection: current.selection });
    if (!response.ok) {
      setCleanup((latest) => latest?.taskId === taskId ? { ...latest, previewing: false, error: response.error ?? "Host 未上报拒绝原因" } : latest);
      return;
    }
    try {
      const preview = parseCleanupPreview(response.payload);
      setCleanup((latest) => latest?.taskId === taskId ? { ...latest, previewing: false, preview, error: undefined } : latest);
    } catch (error) {
      setCleanup((latest) => latest?.taskId === taskId ? { ...latest, previewing: false, error: error instanceof Error ? error.message : "清理预览返回异常" } : latest);
    }
  };
  const runCleanup = async (task: ArchivedTask) => {
    const current = cleanup;
    if (!current || current.taskId !== task.taskId || !current.preview || current.running) return;
    if (!window.confirm(confirmationText(task.name, current.preview))) return;
    setCleanup({ ...current, running: true, error: undefined, result: undefined });
    const response = await runCleanupThroughShell({ taskId: task.taskId, selection: current.selection, label: "清理任务" });
    if (!response.ok) {
      setCleanup((latest) => latest?.taskId === task.taskId ? { ...latest, running: false, error: response.error ?? "Host 未上报拒绝原因" } : latest);
      return;
    }
    setCleanup((latest) => latest?.taskId === task.taskId ? { ...latest, running: false, result: parseCleanupRun(response.payload) } : latest);
    setRevision((value) => value + 1);
    onRestored();
  };
  return <div data-testid="desktop-archive-page" className="px-[34px] py-[30px] below-narrow:px-5">
    <div className="flex items-start justify-between gap-3">
      <div><p className="text-[10px] uppercase tracking-[1.8px] text-[#95979c]">Archived Tasks</p><h1 className="mt-1.5 text-[26px] font-semibold text-ink">已归档</h1></div>
      <Button type="button" size="sm" variant="outline" onClick={() => setRevision((value) => value + 1)}>刷新</Button>
    </div>
    <p data-testid="desktop-archive-scope" className="mt-1.5 text-xs text-muted">归档只停止正在执行的 Agent 回合；已在运行的服务与终端不会被它停止；恢复不会自动重新启动服务或定时任务。独立导出文件浏览与下载界面未接线；清理中的导出由 Host 写入预览所示的保留位置。</p>
    {actionError && <p role="alert" className="mt-4 border border-[#e0b4b4] bg-[#fdf3f3] p-3 text-xs text-[#ad4545]">{actionError}</p>}
    {!result ? <p role="status" className="mt-6 text-xs text-muted">正在读取任务归档状态…</p> : <>
      {result.errors.length > 0 && <div role="alert" className="mt-5 border border-[#e0b4b4] bg-[#fdf3f3] p-3 text-xs text-[#ad4545]">部分任务读取失败，列表可能不完整。<ul className="mt-1 list-inside list-disc">{result.errors.map((error) => <li key={error}>{error}</li>)}</ul></div>}
      <div className="mt-6 divide-y divide-line border-y border-line">
        {result.rows.map((task) => <article key={task.taskId} data-archived-task={task.taskId} className="py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0"><h2 className="break-words text-sm font-semibold">{task.name}</h2><p className="mt-1 text-xs text-muted">{task.repoCount} 个仓库 · 归档于 {task.archivedAt}</p></div>
            <div className="flex items-center gap-2"><Button size="sm" variant="outline" disabled={restoring !== null || cleanup?.running === true} onClick={() => void restore(task.taskId)}>恢复</Button><Button size="sm" variant="outline" disabled={restoring !== null || cleanup?.running === true} onClick={() => openCleanup(task.taskId)}>{cleanup?.taskId === task.taskId ? "收起清理" : "清理…"}</Button></div>
          </div>
          <section aria-label={`${task.name}资源判定`} className="mt-3 text-xs">
            <h3 className="font-semibold">Host 资源判定</h3>
            <p className="mt-1 text-[11px] text-muted">Host 按身份核对工作副本与运行进程，不凭过期进程号或端口定论；这里只读展示判定，不能清理的资源按具名原因处理后重读。</p>
            {task.verdicts === undefined
              ? <p className="mt-1 text-[11px] text-muted">Host 未上报资源判定，尚未计算：未判定的资源不能当作可清理。</p>
              : task.verdicts.length === 0
                ? <p className="mt-1 text-[11px] text-muted">Host 上报 0 项资源判定，尚无可判定项：这不代表资源可清理。</p>
                : <ul className="mt-1 list-inside list-disc text-[11px]">{task.verdicts.map((verdict, index) => <li key={`${verdict.subject}-${index}`} className={verdict.ok === false ? "text-[#9a6032]" : "text-muted"}>{verdict.subject}：{resourceVerdictConclusion(verdict)}</li>)}</ul>}
          </section>
          {cleanup?.taskId === task.taskId && <section aria-label={`${task.name}清理预览`} className="mt-4 border border-line bg-paper p-3">
            <p className="text-xs font-semibold">先预览 Host 清理清单</p>
            <p className="mt-1 text-[11px] text-muted">选择要随清理导出的记录；未选择的记录可能随清理移除。独立导出下载界面未接线。</p>
            <div className="mt-2 flex flex-wrap gap-3 text-xs">
              {([ ["exportSessions", "导出会话"], ["exportDrafts", "导出草稿"], ["exportUsage", "导出用量"] ] as const).map(([key, label]) => <label key={key} className="flex items-center gap-1.5"><input type="checkbox" checked={cleanup.selection[key]} disabled={cleanup.previewing || cleanup.running} onChange={(event) => changeSelection(key, event.target.checked)} />{label}</label>)}
            </div>
            <div className="mt-3 flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={cleanup.previewing || cleanup.running} onClick={() => void previewCleanup(task.taskId)}>{cleanup.previewing ? "正在生成清单…" : "生成清单"}</Button>{cleanup.preview && <Button type="button" size="sm" disabled={cleanup.running} onClick={() => void runCleanup(task)}>{cleanup.running ? "正在清理…" : "确认清理"}</Button>}</div>
            {cleanup.error && <p role="alert" className="mt-3 border border-[#e0b4b4] bg-[#fdf3f3] p-2 text-xs text-[#ad4545]">{cleanup.error}</p>}
            {cleanup.preview && <div className="mt-3 space-y-2 text-xs">
              <p>Host 记录清理标记：{cleanup.preview.recordsWillBeRemoved === undefined ? "Host 未上报" : cleanup.preview.recordsWillBeRemoved ? "将删除所选范围中的记录" : "未标记删除记录"}</p>
              <p>Host 导出选择：{cleanup.preview.selectionLabels === undefined ? "Host 未上报" : cleanup.preview.selectionLabels.length ? cleanup.preview.selectionLabels.join("、") : "Host 上报未选择导出"}</p>
              <p>Host 保留位置：{cleanup.preview.keepRoot ?? "Host 未上报"}</p>
              <div><h3 className="font-semibold">将删除</h3>{cleanup.preview.items === undefined ? <p className="text-muted">Host 未上报清理项目</p> : itemDetails(cleanup.preview.items, "remove").length > 0 ? <ul className="mt-1 list-inside list-disc">{itemDetails(cleanup.preview.items, "remove").map((line) => <li key={line}>{line}</li>)}</ul> : <p className="text-muted">{cleanup.preview.items.some((item) => item.disposition === undefined) ? "Host 未上报将删除项目" : "Host 上报无待删除项目"}</p>}</div>
              <div><h3 className="font-semibold">将保留</h3>{cleanup.preview.items === undefined ? <p className="text-muted">Host 未上报清理项目</p> : [...itemDetails(cleanup.preview.items, "keep-copy"), ...itemDetails(cleanup.preview.items, "keep")].length > 0 ? <ul className="mt-1 list-inside list-disc">{[...itemDetails(cleanup.preview.items, "keep-copy"), ...itemDetails(cleanup.preview.items, "keep")].map((line) => <li key={line}>{line}</li>)}</ul> : <p className="text-muted">{cleanup.preview.items.some((item) => item.disposition === undefined) ? "Host 未上报保留项目" : "Host 上报无保留项目"}</p>}</div>
              <div><h3 className="font-semibold">Host 提醒</h3>{cleanup.preview.warnings === undefined ? <p className="text-muted">Host 未上报</p> : cleanup.preview.warnings.length > 0 ? <ul className="mt-1 list-inside list-disc">{cleanup.preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : <p className="text-muted">Host 上报无额外提醒</p>}</div>
            </div>}
            {cleanup.result && <div className="mt-3 border-t border-line pt-3 text-xs">
              <p className="font-semibold">{cleanup.result.error ? `清理未完成：${cleanup.result.error}` : cleanup.result.receipt?.partialFailure === true ? "清理部分失败" : cleanup.result.receipt?.partialFailure === false && cleanup.result.recovery?.length === 0 ? "清理已执行" : cleanup.result.receipt?.partialFailure === false ? "Host 未上报完整失败项状态" : "Host 未上报清理回执"}</p>
              <p className="mt-1">实际移除：{cleanup.result.receipt?.removed === undefined ? "Host 未上报" : cleanup.result.receipt.removed.length ? cleanup.result.receipt.removed.join("、") : "Host 上报未移除受管资源"}</p>
              <p>实际导出：{cleanup.result.receipt?.exports === undefined ? "Host 未上报" : cleanup.result.receipt.exports.length ? cleanup.result.receipt.exports.join("、") : "Host 上报未选择导出"}</p>
              <p>保留位置：{cleanup.result.receipt?.keptPosition === undefined ? "Host 未上报" : cleanup.result.receipt.keptPosition ?? "Host 未提供保留位置"}</p>
              <p>失败项：{cleanup.result.recovery === undefined ? "Host 未上报" : cleanup.result.recovery.length ? "" : "Host 上报无失败项"}</p>
              {cleanup.result.recovery?.map((entry, index) => <p key={`${entry.item ?? "unknown"}-${index}`} className="text-[#ad4545]">{entry.item ?? "Host 未上报失败项"}：{entry.reason ?? "Host 未上报失败原因"}</p>)}
              <div className="mt-2"><p className="font-semibold">Host 清理项目结果</p>{cleanup.result.items === undefined ? <p>Host 未上报清理项目结果</p> : cleanup.result.items.length === 0 ? <p>Host 上报无清理项目结果</p> : <ul className="mt-1 list-inside list-disc">{cleanup.result.items.map((item, index) => <li key={`${item.resource ?? "unknown"}-${index}`}>{dispositionLabel(item.disposition)}：{item.resource ?? "Host 未上报资源"}：{item.detail ?? "Host 未上报详情"}</li>)}</ul>}</div>
            </div>}
          </section>}
        </article>)}
        {result.rows.length === 0 && <p className="py-8 text-center text-xs text-muted">{result.errors.length ? "成功读取的任务中没有归档项。" : "还没有归档任务。"}</p>}
      </div>
    </>}
  </div>;
}
