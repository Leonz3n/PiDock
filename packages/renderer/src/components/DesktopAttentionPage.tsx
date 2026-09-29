import { useEffect, useState } from "react";
import { attentionThroughShell, markAttentionReadThroughShell } from "../data/shellBridge";
import { asHostAttentionItem, attentionItemFromHost, groupAttentionItems, type HostAttentionItem } from "../data/attentionRules";
import type { AttentionItem } from "../data/types";
import { Button } from "./ui/button";

type Task = { taskId: string; name: string; projectId: string | null };
type Project = { id: string; name: string };
type Result = { items: AttentionItem[]; errors: string[] };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const labels: Record<AttentionItem["kind"], string> = { approval: "待确认", failed: "失败", expired: "确认过期", "completed-unread": "完成未读" };

function parseItems(value: unknown, taskId: string): HostAttentionItem[] {
  if (!object(value) || typeof value.taskName !== "string" || !Array.isArray(value.items)) throw new Error("关注列表返回异常");
  return value.items.map((entry: unknown) => {
    const item = asHostAttentionItem(entry);
    if (!item || item.taskId !== taskId || !object(entry) || typeof entry.read !== "boolean" || (entry.taskName !== undefined && typeof entry.taskName !== "string")) throw new Error("关注列表返回异常");
    return item;
  });
}
async function readAttention(tasks: readonly Task[], projects: readonly Project[]): Promise<Result> {
  const states = await Promise.all(tasks.map(async (task) => {
    try {
      const response = await attentionThroughShell(task.taskId);
      if (!response.ok) throw new Error(response.error ?? "读取失败");
      const project = projects.find((row) => row.id === task.projectId);
      return { items: parseItems(response.payload, task.taskId).map((item) => attentionItemFromHost({ ...item, taskName: task.name }, project)), error: "" };
    } catch (error) {
      return { items: [] as AttentionItem[], error: `${task.name}：${error instanceof Error ? error.message : "读取失败"}` };
    }
  }));
  return { items: states.flatMap((state) => state.items), errors: states.map((state) => state.error).filter(Boolean) };
}

export function DesktopAttentionPage({ tasks, projects, lifecyclePending, lifecycleErrors, onOpenTask }: {
  tasks: readonly Task[]; projects: readonly Project[]; lifecyclePending: boolean; lifecycleErrors: readonly string[]; onOpenTask: (taskId: string) => void;
}) {
  const [result, setResult] = useState<Result | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  useEffect(() => {
    if (lifecyclePending) { setResult(null); return; }
    let live = true;
    setResult(null);
    void readAttention(tasks, projects).then((next) => { if (live) setResult(next); });
    return () => { live = false; };
  }, [tasks, projects, lifecyclePending, revision]);
  const groups = groupAttentionItems(result?.items ?? []);
  const read = async (item: AttentionItem) => {
    setBusy(item.id);
    setActionError("");
    try {
      const response = await markAttentionReadThroughShell({ taskId: item.taskId, itemIds: [item.id] });
      if (!response.ok) throw new Error(response.error ?? "标记已读失败");
      if (!object(response.payload) || !Array.isArray(response.payload.cleared) || !response.payload.cleared.includes(item.id)) throw new Error("已读结果无法核验，请刷新列表");
      setRevision((value) => value + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "已读状态未知，请刷新核验");
    } finally { setBusy(null); }
  };
  const list = (items: AttentionItem[]) => items.map((item) => <li key={`${item.taskId}:${item.id}`} className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-3" data-attention-item={item.id}>
    <div className="min-w-0"><strong className="break-words text-xs text-ink">{item.label}</strong><p className="mt-1 text-[11px] text-muted">{labels[item.kind]} · {item.detail}</p></div>
    <div className="flex items-center gap-2">
      <Button type="button" size="sm" variant="outline" onClick={() => onOpenTask(item.taskId)}>查看任务</Button>
      {item.kind === "completed-unread" && <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void read(item)}>标记已读</Button>}
    </div>
  </li>);
  return <div data-testid="desktop-attention-page" className="px-[34px] py-[30px] below-narrow:px-5">
    <div className="flex items-start justify-between gap-3"><div><p className="text-[10px] uppercase tracking-[1.8px] text-[#95979c]">Attention</p><h1 className="mt-1.5 text-[26px] font-semibold text-ink">需要处理</h1></div><Button type="button" size="sm" variant="outline" onClick={() => { setActionError(""); setRevision((value) => value + 1); }}>刷新</Button></div>
    <p className="mt-1.5 text-xs text-muted">所有项目的任务执行账本：待确认、失败、确认过期和完成未读。SDK main 回合尚未写入这条账本；查看仅定位任务，不冒充已打开原会话。</p>
    {actionError && <p role="alert" className="mt-4 border border-[#e0b4b4] bg-[#fdf3f3] p-3 text-xs text-[#ad4545]">{actionError}</p>}
    {lifecyclePending || !result ? <p role="status" className="mt-6 text-xs text-muted">正在核验任务与关注记录…</p> : <>
      {(lifecycleErrors.length > 0 || result.errors.length > 0) && <div role="alert" className="mt-5 border border-[#e0b4b4] bg-[#fdf3f3] p-3 text-xs text-[#ad4545]">部分任务读取失败，结果可能不完整。<ul className="mt-1 list-inside list-disc">{[...lifecycleErrors, ...result.errors].map((error) => <li key={error}>{error}</li>)}</ul></div>}
      <section className="mt-6"><h2 className="text-sm font-semibold">待处理 · {groups.pending.length}</h2><ul className="mt-2 border-t border-line">{list(groups.pending)}</ul></section>
      <section className="mt-7"><h2 className="text-sm font-semibold">完成未读 · {groups.unread.length}</h2><ul className="mt-2 border-t border-line">{list(groups.unread)}</ul></section>
      {result.items.length === 0 && <p className="mt-6 text-xs text-muted">{lifecycleErrors.length || result.errors.length ? "成功读取的任务中没有关注项。" : "当前执行账本暂无需要处理的事项。"}</p>}
    </>}
  </div>;
}
