import { useEffect, useMemo, useState } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { SDK_SESSION_ID, sdkSnapshot, sumSdkUsage, type SdkMessage, type SdkSnapshot } from "../data/sdkSession";
import { clearUsageThroughShell, usageRecordsThroughShell } from "../data/shellBridge";
import type { UsageCleanupScope } from "../data/types";

const number = (value: number) => value.toLocaleString("en-US");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** `task/usageRecords` answers `{report:{details}}`; the ledger's size is the Host's, not ours. */
function ledgerCount(payload: unknown): number {
  const report = object(payload) ? payload["report"] : undefined;
  const details = object(report) ? report["details"] : undefined;
  if (!Array.isArray(details)) throw new Error("用量账本返回异常");
  return details.length;
}

/**
 * The scope in this page's words. `UsageCleanupScope`'s `all` always means
 * "all details in *this task's* ledger" here: the op is sent with one taskId,
 * so the wording must never read as "the whole machine".
 */
function scopeLabel(scope: UsageCleanupScope): string {
  if (scope.kind === "all") return "本任务账本全部";
  if (scope.kind === "session") return `本任务账本中会话 ${scope.sessionId} 的条目`;
  return `本任务账本中 ${scope.before} 当日结束之前的条目`;
}

/**
 * [UI 对齐 S8e] #47 `Token 用量`。
 *
 * 真实来源：每个任务私有的 SDK JSONL 会话投影（与会话视图同一份证据）。
 * 投影只返回最近最多 80 条消息；这里的求和不是会话累计。
 * 这是本机实际发生的用量，不是服务商的账单或配额。
 *
 * 原型那一页还有 provider / model / kind / 日期 维度与 per-call 记录表；生产里
 * 这些维度来自旧的 session 通道账本（`task/usageRecords`），而 SDK 回合不写那条
 * 通道，所以那一部分**没有**数据可显示——页面明确写出这一点，而不是拿空表充当
 * 「没有用量」。
 */
export function DesktopUsagePage({
  tasks,
  taskId,
  onSelectTask,
}: {
  tasks: readonly { taskId: string; name: string }[];
  taskId: string | null;
  onSelectTask: (taskId: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<SdkSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!taskId) {
      setSnapshot(null);
      setError("");
      return;
    }
    let live = true;
    let subscribed = false;
    const unsubscribe = () => {
      void window.pidock?.sdkTurn?.({ action: "unsubscribe", taskId, sessionId: SDK_SESSION_ID } as never).catch(() => undefined);
    };
    setBusy(true);
    setSnapshot(null);
    void (async () => {
      try {
        const next = await sdkSnapshot(window.pidock, taskId);
        subscribed = true;
        if (live) { setSnapshot(next); setError(""); }
        else unsubscribe();
      } catch (caught) {
        if (live) { setSnapshot(null); setError(caught instanceof Error ? caught.message : "SDK 会话读取失败"); }
      } finally {
        if (live) setBusy(false);
      }
    })();
    return () => {
      live = false;
      if (subscribed) unsubscribe();
    };
  }, [taskId]);

  const totals = useMemo(() => sumSdkUsage(snapshot?.messages ?? []), [snapshot]);
  const rows = (snapshot?.messages ?? []).filter((message): message is SdkMessage & { usage: NonNullable<SdkMessage["usage"]> } => message.usage !== null);

  /**
   * The Host's usage ledger ([PiDock 12] #12) is a *different* store from the
   * SDK JSONL projection above: `task/usageRecords` reads the ledger, and
   * `task/clearUsage` only removes ledger details. The count and the cleanup
   * receipt both come from the Host; this page never estimates either.
   */
  const [ledger, setLedger] = useState<{ taskId: string; count: number } | null>(null);
  const [ledgerError, setLedgerError] = useState("");
  const [ledgerBusy, setLedgerBusy] = useState(false);
  const [cleanupSession, setCleanupSession] = useState(SDK_SESSION_ID);
  const [cleanupBefore, setCleanupBefore] = useState("");
  const [pendingScope, setPendingScope] = useState<UsageCleanupScope | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanupNote, setCleanupNote] = useState("");
  const [cleanupError, setCleanupError] = useState("");

  useEffect(() => {
    // A receipt or a pending confirmation belongs to the task that produced
    // it; switching tasks must not carry it under another ledger.
    setPendingScope(null);
    setCleanupNote("");
    setCleanupError("");
    if (!taskId) {
      setLedger(null);
      setLedgerError("");
      return;
    }
    let live = true;
    setLedgerError("");
    setLedgerBusy(true);
    void (async () => {
      try {
        const response = await usageRecordsThroughShell({ taskId });
        if (!response.ok) throw new Error(response.error ?? "用量账本读取失败");
        const count = ledgerCount(response.payload);
        if (live) setLedger({ taskId, count });
      } catch (error) {
        if (live) setLedgerError(error instanceof Error ? error.message : "用量账本读取失败");
      } finally {
        if (live) setLedgerBusy(false);
      }
    })();
    return () => { live = false; };
  }, [taskId]);

  const taskName = tasks.find((task) => task.taskId === taskId)?.name ?? taskId ?? "";

  const runCleanup = async (scope: UsageCleanupScope) => {
    if (!taskId) return;
    setPendingScope(null);
    setCleaning(true);
    setCleanupNote("");
    setCleanupError("");
    try {
      const response = await clearUsageThroughShell({ taskId, scope });
      if (!response.ok) throw new Error(response.error ?? "用量账本清理失败");
      const payload = object(response.payload) ? response.payload : {};
      const removed = typeof payload["removed"] === "number" ? payload["removed"] : null;
      const remaining = typeof payload["remaining"] === "number" ? payload["remaining"] : null;
      if (removed === null || remaining === null) throw new Error("清理结果缺少 Host 的移除/剩余条数，请刷新核验");
      setCleanupNote(
        removed === 0 && remaining === 0
          ? `账本里原本没有可清理的条目（${scopeLabel(scope)}）。`
          : `${scopeLabel(scope)}：移除 ${removed} 条，剩余 ${remaining} 条。`,
      );
      // The receipt's numbers are the Host's; the visible count is refreshed
      // from the Host too, so a stale number can never pass as the new one.
      try {
        const reread = await usageRecordsThroughShell({ taskId });
        if (!reread.ok) throw new Error(reread.error ?? "用量账本重读失败");
        setLedger({ taskId, count: ledgerCount(reread.payload) });
        setLedgerError("");
      } catch (error) {
        setLedgerError(`重读失败，数字可能已过期（${error instanceof Error ? error.message : "用量账本重读失败"}）`);
      }
    } catch (error) {
      setCleanupError(error instanceof Error ? error.message : "用量账本清理失败，状态未知");
    } finally {
      setCleaning(false);
    }
  };

  return (
    <div className="px-[34px] py-[30px] below-narrow:px-5" data-testid="desktop-usage-page">
      <p className="text-[10px] tracking-[1.8px] text-[#95979c] uppercase">Usage</p>
      <h1 className="mt-1.5 text-[26px] font-semibold tracking-[-0.6px] text-ink">Token 用量</h1>
      <p className="mt-1.5 mb-6 text-xs text-muted">
        最近最多 80 条 SDK 消息的已报告用量（与会话视图同一份证据），不是会话累计，也不是服务商的账单或配额。
      </p>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-muted">任务</span>
        {tasks.map((task) => (
          <Button
            key={task.taskId}
            type="button"
            size="sm"
            variant={task.taskId === taskId ? "secondary" : "outline"}
            onClick={() => onSelectTask(task.taskId)}
            data-usage-task={task.taskId}
          >
            {task.name}
          </Button>
        ))}
        {!tasks.length && <span className="text-[11px] text-muted">本机还没有任务。</span>}
      </div>

      {!taskId && <p className="text-xs text-muted" data-testid="usage-needs-task">选择一个任务后显示它的真实用量。</p>}
      {busy && <p role="status" className="text-xs text-muted">正在读取该任务的 SDK 会话记录…</p>}
      {error && <p role="alert" className="break-words border border-[#e0b4b4] bg-[#fdf3f3] px-3 py-2 text-xs text-[#ad4545]">{error}</p>}

      {taskId && snapshot && (
        <>
          <div className="grid grid-cols-4 gap-4 below-mid:grid-cols-2">
            {[
              { label: "输入 tokens", value: totals.input },
              { label: "输出 tokens", value: totals.output },
              { label: "缓存读取", value: totals.cacheRead },
              { label: "缓存写入", value: totals.cacheWrite },
            ].map((card) => (
              <div key={card.label} className="rounded-[9px] border border-line bg-paper p-5" data-usage-total={card.label}>
                <p className="text-[11px] text-muted">{card.label}</p>
                <p className="mt-1.5 text-[22px] font-semibold text-ink">{number(card.value)}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] text-muted" data-testid="usage-summary">
            最近 {snapshot.messages.length} 条已确认消息 · {totals.turns} 个助手回合
            {snapshot.messages.length === 80 ? " · 已达投影上限，较早用量未计入" : ""}
            {snapshot.pending ? " · 有进行中的回合" : ""}
            {snapshot.interrupted ? " · 上次中断" : ""}
          </p>

          <h2 className="mt-7 mb-3 text-[13px] font-semibold text-ink">逐条记录</h2>
          {rows.length === 0 ? (
            <p className="text-xs text-muted" data-testid="usage-no-records">
              {snapshot.messages.length === 0 ? "该任务还没有 SDK 会话记录。" : "该任务的消息没有携带 SDK 用量报告。"}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse text-xs">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] text-muted">
                    <th className="py-2 pr-3 font-medium">#</th>
                    <th className="py-2 pr-3 font-medium">角色</th>
                    <th className="py-2 pr-3 font-medium">输入</th>
                    <th className="py-2 pr-3 font-medium">输出</th>
                    <th className="py-2 pr-3 font-medium">缓存读取</th>
                    <th className="py-2 font-medium">缓存写入</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.messages.map((message, index) => (
                    <tr key={index} className="border-b border-line" data-usage-row={index}>
                      <td className="py-2 pr-3 text-muted">{index + 1}</td>
                      <td className="py-2 pr-3">{message.role === "user" ? "你" : "Pi"}</td>
                      <td className="py-2 pr-3">{message.usage ? number(message.usage.input) : "—"}</td>
                      <td className="py-2 pr-3">{message.usage ? number(message.usage.output) : "—"}</td>
                      <td className="py-2 pr-3">{message.usage ? number(message.usage.cacheRead) : "—"}</td>
                      <td className="py-2">{message.usage ? number(message.usage.cacheWrite) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <section className="mt-7 rounded-[9px] border border-line bg-paper p-5" data-testid="usage-ledger">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[13px] font-semibold text-ink">用量账本 · 本任务</h3>
          <Badge variant="soft">Host 用量账本</Badge>
        </div>
        <p className="mt-1.5 text-xs text-muted" data-testid="usage-ledger-scope">
          {taskId ? `本任务（${taskName}）的 Host 用量账本` : "选择一个任务后显示该任务的 Host 用量账本"}
        </p>
        <p className="mt-1 text-[11px] text-[#9a6032]" data-testid="usage-ledger-note">
          口径：这是 Host 用量账本的当前条数，与上方 SDK JSONL 投影不是同一份存储；两边数字不能互相替代。
        </p>
        {taskId && (
          <>
            <p className="mt-2 text-xs text-ink" data-testid="usage-ledger-count">
              {ledger?.taskId === taskId
                ? `Host 用量账本当前 ${ledger.count} 条`
                : ledgerBusy
                  ? "正在读取 Host 用量账本…"
                  : "Host 用量账本尚未读取"}
            </p>
            {ledgerError && (
              <p role="alert" data-testid="usage-ledger-error" className="mt-2 break-words border border-[#dfc99f] bg-[#fff8e9] px-3 py-2 text-xs text-[#9a6032]">
                {ledgerError}
              </p>
            )}
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 text-[11px] text-muted">
                清理会话 ID
                <input
                  aria-label="清理会话 ID"
                  className="w-28 border border-line bg-paper px-2 py-1 text-xs text-ink"
                  value={cleanupSession}
                  onChange={(event) => setCleanupSession(event.target.value)}
                />
              </label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={cleaning || cleanupSession.trim().length === 0}
                onClick={() => setPendingScope({ kind: "session", sessionId: cleanupSession.trim() })}
              >
                清理本任务账本中该会话的用量
              </Button>
              <label className="flex flex-col gap-1 text-[11px] text-muted">
                此前日期
                <input
                  aria-label="清理此前日期"
                  className="w-32 border border-line bg-paper px-2 py-1 text-xs text-ink"
                  placeholder="YYYY-MM-DD"
                  value={cleanupBefore}
                  onChange={(event) => setCleanupBefore(event.target.value)}
                />
              </label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={cleaning || cleanupBefore.trim().length === 0}
                onClick={() => setPendingScope({ kind: "before", before: cleanupBefore.trim() })}
              >
                清理本任务账本中此日期之前的用量
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={cleaning} onClick={() => setPendingScope({ kind: "all" })}>
                清理本任务账本全部
              </Button>
            </div>
            {pendingScope && (
              <div data-testid="usage-cleanup-confirm" className="mt-3 border-l-2 border-[#dfc99f] pl-3">
                <p className="text-xs text-ink">
                  清理本任务（{taskName}）的用量账本：{scopeLabel(pendingScope)}。不删除会话记录，也不影响其他任务。
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="outline" disabled={cleaning} onClick={() => void runCleanup(pendingScope)}>
                    确认清理
                  </Button>
                  <Button type="button" size="sm" variant="ghost" disabled={cleaning} onClick={() => setPendingScope(null)}>
                    取消清理
                  </Button>
                </div>
              </div>
            )}
            {cleanupError && (
              <p role="alert" data-testid="usage-cleanup-error" className="mt-2 break-words border border-[#dfc99f] bg-[#fff8e9] px-3 py-2 text-xs text-[#9a6032]">
                {cleanupError}
              </p>
            )}
            {cleanupNote && (
              <p role="status" data-testid="usage-cleanup-note" className="mt-2 text-[11px] text-muted">
                {cleanupNote}
              </p>
            )}
          </>
        )}
      </section>

      <section className="mt-7 rounded-[9px] border border-line bg-paper p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[13px] font-semibold text-ink">按 Provider / 模型 / 类型 / 日期分组</h3>
          <Badge variant="soft">未接线</Badge>
        </div>
        <p className="mt-2 text-xs text-muted">
          原型的这一页还按 Provider、模型、调用类型与日期筛选。生产里这些维度来自旧的 session 通道账本（`task/usageRecords`），
          而 SDK 回合不写那条通道，因此这里没有数据可显示——不会用空表或估算值充当用量。
        </p>
      </section>
    </div>
  );
}
