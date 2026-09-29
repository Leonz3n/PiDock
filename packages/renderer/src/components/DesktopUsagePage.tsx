import { useEffect, useMemo, useState } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { SDK_SESSION_ID, sdkSnapshot, sumSdkUsage, type SdkMessage, type SdkSnapshot } from "../data/sdkSession";

const number = (value: number) => value.toLocaleString("en-US");

/**
 * [UI 对齐 S8e] #47 `Token 用量`。
 *
 * 真实来源：每个任务私有的 SDK JSONL 会话投影（与会话视图同一份证据）。
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
    setBusy(true);
    setSnapshot(null);
    void (async () => {
      try {
        const next = await sdkSnapshot(window.pidock, taskId);
        if (live) { setSnapshot(next); setError(""); }
      } catch (caught) {
        if (live) { setSnapshot(null); setError(caught instanceof Error ? caught.message : "SDK 会话读取失败"); }
      } finally {
        if (live) setBusy(false);
      }
    })();
    return () => {
      live = false;
      void window.pidock?.sdkTurn?.({ action: "unsubscribe", taskId, sessionId: SDK_SESSION_ID } as never).catch(() => undefined);
    };
  }, [taskId]);

  const totals = useMemo(() => sumSdkUsage(snapshot?.messages ?? []), [snapshot]);
  const rows = (snapshot?.messages ?? []).filter((message): message is SdkMessage & { usage: NonNullable<SdkMessage["usage"]> } => message.usage !== null);

  return (
    <div className="px-[34px] py-[30px] below-narrow:px-5" data-testid="desktop-usage-page">
      <p className="text-[10px] tracking-[1.8px] text-[#95979c] uppercase">Usage</p>
      <h1 className="mt-1.5 text-[26px] font-semibold tracking-[-0.6px] text-ink">Token 用量</h1>
      <p className="mt-1.5 mb-6 text-xs text-muted">
        本机实际发生的用量，记录在任务私有的 SDK 会话里（与会话视图同一份证据）。这不是服务商的账单或配额。
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
            {snapshot.messages.length} 条已确认消息 · {totals.turns} 个助手回合
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
