import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Panel, Segmented } from "../components/ui";
import { VirtualList } from "../components/VirtualList";
import { useHostStore } from "../stores/host";

export function UsagePage() {
  const usage = useHostStore((state) => state.usage);
  const loadUsage = useHostStore((state) => state.loadUsage);
  const workspace = useHostStore((state) => state.workspace);
  const [providerId, setProviderId] = useState("all");
  const [taskId, setTaskId] = useState("all");

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  const rows = useMemo(
    () =>
      usage.filter((record) => (providerId === "all" || record.providerId === providerId) && (taskId === "all" || record.taskId === taskId)),
    [usage, providerId, taskId],
  );

  const totals = useMemo(
    () =>
      rows.reduce(
        (accumulator, record) => ({
          input: accumulator.input + record.input,
          output: accumulator.output + record.output,
          cacheRead: accumulator.cacheRead + record.cacheRead,
        }),
        { input: 0, output: 0, cacheRead: 0 },
      ),
    [rows],
  );

  const bySession = useMemo(() => {
    const map = new Map<string, number>();
    for (const record of rows) {
      const key = `${record.taskId} · ${record.sessionId}`;
      map.set(key, (map.get(key) ?? 0) + record.input + record.output);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [rows]);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-base font-medium text-ink">Token 用量</h1>
          <p className="mt-1 text-xs text-muted">
            按实际模型调用记录，归属执行时的会话与 Provider 配置；上下文压缩或切换模型不清零已有消耗。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            ariaLabel="按 Provider 过滤"
            value={providerId}
            onChange={setProviderId}
            options={[
              { value: "all", label: "全部 Provider" },
              ...(workspace?.providers ?? []).map((provider) => ({ value: provider.id, label: provider.name })),
            ]}
          />
          <Segmented
            ariaLabel="按任务过滤"
            value={taskId}
            onChange={setTaskId}
            options={[{ value: "all", label: "全部任务" }, ...(workspace?.tasks ?? []).map((task) => ({ value: task.id, label: task.name }))]}
          />
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_320px]">
        <Panel title={`明细 · ${rows.length} 条`}>
          <VirtualList
            testId="usage-table"
            items={rows}
            rowHeight={34}
            height={420}
            className="rounded-md border border-line"
            getRowKey={(row) => row.id}
            renderRow={(row) => (
              <div className="grid grid-cols-[132px_120px_1fr_84px_84px_84px] items-center gap-2 border-b border-line px-2.5 py-1.5 text-[11px] odd:bg-soft/30">
                <span className="truncate text-muted">{row.at.slice(5, 16).replace("T", " ")}</span>
                <span className="truncate text-ink">{row.model}</span>
                <span className="truncate font-mono text-muted">
                  {row.taskId} · {row.sessionId}
                </span>
                <span className="text-right">{row.input.toLocaleString()}</span>
                <span className="text-right">{row.output.toLocaleString()}</span>
                <span className="text-right text-muted">{row.cacheRead.toLocaleString()}</span>
              </div>
            )}
          />
          <p className="mt-2 text-[11px] text-muted">
            列：时间 / 模型 / 会话 · 输入 / 输出 / 缓存读取。密集场景使用 TanStack Virtual，仅渲染可视行。
          </p>
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel title="汇总">
            <dl className="grid grid-cols-2 gap-2 text-xs">
              <dt className="text-muted">输入</dt>
              <dd className="text-right">{totals.input.toLocaleString()}</dd>
              <dt className="text-muted">输出</dt>
              <dd className="text-right">{totals.output.toLocaleString()}</dd>
              <dt className="text-muted">缓存读取</dt>
              <dd className="text-right">{totals.cacheRead.toLocaleString()}</dd>
            </dl>
          </Panel>
          <Panel title="会话排行">
            <ul className="flex flex-col gap-1.5 text-xs">
              {bySession.map(([label, value]) => (
                <li key={label} className="flex items-center justify-between gap-2">
                  <span className="truncate text-muted">{label}</span>
                  <span className="text-ink">{value.toLocaleString()}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-muted">未知用量不按零消耗处理；导出与清理在归档流程中确认。</p>
          </Panel>
          <Panel title="成本提示">
            <Badge>样例数据</Badge>
            <p className="mt-2 text-xs text-muted">当前为内存模拟数据，未接入真实 Provider 计费；价格与配额接入在 11/12 工单中完成。</p>
          </Panel>
        </div>
      </div>

      <p className="text-[11px] text-muted">
        静态草稿只按固定数量演示，不能作为容量证据；本页数据量固定为 240 行用于验证虚拟滚动。
      </p>
      <Button size="sm" variant="ghost" onClick={() => void loadUsage()}>
        重新加载
      </Button>
    </div>
  );
}
