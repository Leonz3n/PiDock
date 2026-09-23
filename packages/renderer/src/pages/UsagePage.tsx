import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Panel, Segmented } from "../components/ui";
import { VirtualList } from "../components/VirtualList";
import { useHostStore } from "../stores/host";
import type { UsageCleanupScope, UsageKind } from "../data/types";
import {
  USAGE_COMPLETENESS_LABELS,
  USAGE_DEFINITIONS,
  USAGE_END_STATE_LABELS,
  USAGE_GROUP_OPTIONS,
  USAGE_KIND_LABELS,
  filterUsageRecords,
  groupUsageRecords,
  sumUsageRecords,
  unparsableUsageTimes,
  usageWindow,
  type UsageGroupBy,
} from "../data/usageState";

/**
 * Token usage statistics ([PiDock 12] #12).
 *
 * Detail rows come from persisted per-call records; the reading is the one in
 * `usageState.ts`: reasoning is a subset of output (shown nested, never added),
 * an unreported call is counted as unknown instead of zero, and the window
 * label states the timezone the date boundaries use. The page says explicitly
 * that these are this app's records, not the provider's bill or quota.
 */
export function UsagePage() {
  const usage = useHostStore((state) => state.usage);
  const loadUsage = useHostStore((state) => state.loadUsage);
  const clearUsage = useHostStore((state) => state.clearUsage);
  const workspace = useHostStore((state) => state.workspace);
  const [providerId, setProviderId] = useState("all");
  const [taskId, setTaskId] = useState("all");
  const [kind, setKind] = useState<"all" | UsageKind>("all");
  const [groupBy, setGroupBy] = useState<UsageGroupBy>("session");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [cleanupSession, setCleanupSession] = useState("main");
  const [cleanupBefore, setCleanupBefore] = useState("");
  const [cleanupNote, setCleanupNote] = useState<string | null>(null);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  const rows = useMemo(
    () =>
      filterUsageRecords(usage, {
        ...(providerId === "all" ? {} : { providerId }),
        ...(taskId === "all" ? {} : { taskId }),
        ...(kind === "all" ? {} : { kind }),
        ...(from.trim().length > 0 ? { from } : {}),
        ...(to.trim().length > 0 ? { to } : {}),
      }),
    [usage, providerId, taskId, kind, from, to],
  );

  const totals = useMemo(() => sumUsageRecords(rows), [rows]);
  const groups = useMemo(() => groupUsageRecords(rows, groupBy), [rows, groupBy]);
  const unknownTimes = useMemo(() => unparsableUsageTimes(rows), [rows]);
  const window = useMemo(() => usageWindow({ from, to }), [from, to]);

  const cleanup = async (scope: UsageCleanupScope) => {
    try {
      const result = await clearUsage(scope);
      setCleanupNote(`${result.description}：移除 ${result.removed} 条，剩余 ${result.remaining} 条。`);
    } catch (error) {
      setCleanupNote(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-base font-medium text-ink">Token 用量</h1>
          <p className="mt-1 text-xs text-muted">
            按实际模型调用记录，归属执行时的会话与 Provider 配置；上下文压缩或切换模型不清零已有消耗。
          </p>
          <p className="mt-1 text-[11px] text-muted">
            统计范围为本应用记录，不等同账户账单或供应商配额；未观测到的外部调用不伪造。
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
          <Segmented
            ariaLabel="按调用类型过滤"
            value={kind}
            onChange={(value) => setKind(value as "all" | UsageKind)}
            options={[
              { value: "all", label: "全部类型" },
              ...(Object.keys(USAGE_KIND_LABELS) as UsageKind[]).map((value) => ({ value, label: USAGE_KIND_LABELS[value] })),
            ]}
          />
        </div>
      </header>

      <Panel title="时间范围与分组">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[11px] text-muted">
            起始日期
            <input
              aria-label="起始日期"
              className="rounded border border-line bg-soft/40 px-2 py-1 text-xs text-ink"
              placeholder="YYYY-MM-DD"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-muted">
            结束日期
            <input
              aria-label="结束日期"
              className="rounded border border-line bg-soft/40 px-2 py-1 text-xs text-ink"
              placeholder="YYYY-MM-DD"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
          <Segmented
            ariaLabel="分组维度"
            value={groupBy}
            onChange={(value) => setGroupBy(value as UsageGroupBy)}
            options={USAGE_GROUP_OPTIONS.map((option) => ({ value: option.id, label: option.label }))}
          />
        </div>
        <p className="mt-2 text-[11px] text-muted">{window.label}</p>
        {unknownTimes.length > 0 ? (
          <p className="mt-1 text-[11px] text-amber-600">有 {unknownTimes.length} 条记录时间不可解析，未按时间归组：{unknownTimes.slice(0, 3).join("、")}</p>
        ) : null}
      </Panel>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_360px]">
        <Panel title={`明细 · ${rows.length} 条`}>
          <VirtualList
            testId="usage-table"
            items={rows}
            rowHeight={34}
            height={420}
            className="rounded-md border border-line"
            getRowKey={(row) => row.id}
            renderRow={(row) => (
              <div className="grid grid-cols-[132px_148px_1fr_84px_84px_84px_84px] items-center gap-2 border-b border-line px-2.5 py-1.5 text-[11px] odd:bg-soft/30">
                <span className="truncate text-muted">{row.at.slice(5, 16).replace("T", " ")}</span>
                <span className="truncate text-ink" title={row.responseModel ? `${row.model} → ${row.responseModel}` : row.model}>
                  {row.model}
                  {row.responseModel ? <span className="text-muted"> → {row.responseModel}</span> : null}
                </span>
                <span className="truncate font-mono text-muted">
                  {row.taskId} · {row.sessionId}
                  <span className="ml-1 text-muted">[{USAGE_KIND_LABELS[row.kind]}]</span>
                  {row.completeness === "partial" ? <span className="ml-1 text-orange">部分报告</span> : null}
                  {row.endState !== "completed" ? <span className="ml-1 text-orange">{row.endState === "failed" ? "失败" : row.endState === "cancelled" ? "已取消" : "待确认"}</span> : null}
                </span>
                <span className="text-right">{row.completeness === "missing" ? "未报告" : row.input.toLocaleString()}</span>
                <span className="text-right">
                  {row.completeness === "missing" ? "未报告" : row.output.toLocaleString()}
                  {row.reasoning !== undefined && row.completeness !== "missing" ? (
                    <span className="ml-1 text-muted">(含 {row.reasoning.toLocaleString()})</span>
                  ) : null}
                </span>
                <span className="text-right text-muted">{row.completeness === "missing" ? "未报告" : row.cacheRead.toLocaleString()}</span>
                <span className="text-right text-muted">{row.completeness === "missing" ? "未报告" : row.cacheWrite.toLocaleString()}</span>
              </div>
            )}
          />
          <p className="mt-2 text-[11px] text-muted">
            列：时间 / 模型（→ 实际响应模型）/ 任务 · 会话 · 类型 / 输入 / 输出（含 reasoning）/ 缓存读取 / 缓存写入。未报告的行显示「未报告」，不计为 0；部分报告与失败／取消调用在类型列标注。
          </p>
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel title="汇总">
            <dl className="grid grid-cols-2 gap-2 text-xs">
              <dt className="text-muted">调用数</dt>
              <dd className="text-right">{totals.calls.toLocaleString()}</dd>
              <dt className="text-muted">输入</dt>
              <dd className="text-right">{totals.input.toLocaleString()}</dd>
              <dt className="text-muted">输出</dt>
              <dd className="text-right">{totals.output.toLocaleString()}</dd>
              <dt className="text-muted">其中 reasoning</dt>
              <dd className="text-right text-muted">{totals.reasoning.toLocaleString()}</dd>
              <dt className="text-muted">缓存读取</dt>
              <dd className="text-right">{totals.cacheRead.toLocaleString()}</dd>
              <dt className="text-muted">缓存写入</dt>
              <dd className="text-right">{totals.cacheWrite.toLocaleString()}</dd>
              <dt className="text-muted">已报告 / 部分 / 未报告</dt>
              <dd className="text-right">
                {totals.reported} / {totals.partial} / {totals.missing}
              </dd>
            </dl>
            <p className="mt-2 text-[11px] text-muted">reasoning 已包含在 output 内，只展开不重复相加；Provider 报告的总量不与缓存项重复相加。</p>
          </Panel>

          <Panel title={`分组 · ${USAGE_GROUP_OPTIONS.find((option) => option.id === groupBy)?.label ?? groupBy}`}>
            <ul className="flex flex-col gap-1.5 text-xs">
              {groups.slice(0, 8).map((group) => (
                <li key={group.key} className="flex items-center justify-between gap-2">
                  <span className="truncate text-muted" title={group.key}>
                    {group.label}
                  </span>
                  <span className="text-ink">
                    {(group.totals.input + group.totals.output).toLocaleString()}
                    {group.totals.missing > 0 ? <span className="ml-1 text-muted">（未报告 {group.totals.missing}）</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="统计定义">
            <dl className="flex flex-col gap-1.5 text-[11px]">
              {USAGE_DEFINITIONS.map((item) => (
                <div key={item.term}>
                  <dt className="text-ink">{item.term}</dt>
                  <dd className="text-muted">{item.definition}</dd>
                </div>
              ))}
            </dl>
          </Panel>

          <Panel title="清理范围">
            <p className="text-[11px] text-muted">归档保留用量；只有下列范围会移除明细，且不影响会话历史本身。</p>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 text-[11px] text-muted">
                会话 ID
                <input
                  aria-label="清理会话 ID"
                  className="w-28 rounded border border-line bg-soft/40 px-2 py-1 text-xs text-ink"
                  value={cleanupSession}
                  onChange={(event) => setCleanupSession(event.target.value)}
                />
              </label>
              <Button size="sm" variant="ghost" onClick={() => void cleanup({ kind: "session", sessionId: cleanupSession.trim() })}>
                清理该会话用量
              </Button>
              <label className="flex flex-col gap-1 text-[11px] text-muted">
                此前日期
                <input
                  aria-label="清理此前日期"
                  className="w-32 rounded border border-line bg-soft/40 px-2 py-1 text-xs text-ink"
                  placeholder="YYYY-MM-DD"
                  value={cleanupBefore}
                  onChange={(event) => setCleanupBefore(event.target.value)}
                />
              </label>
              <Button size="sm" variant="ghost" onClick={() => void cleanup({ kind: "before", before: cleanupBefore.trim() })}>
                清理该日期之前
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void cleanup({ kind: "all" })}>
                清理全部用量
              </Button>
            </div>
            {cleanupNote ? <p className="mt-2 text-[11px] text-muted">{cleanupNote}</p> : null}
          </Panel>

          <Panel title="归属与完整性">
            <Badge>样例数据</Badge>
            <p className="mt-2 text-[11px] text-muted">
              每行保留调用时的 Provider 配置指纹与请求/实际响应模型；Provider 改名或切换不重写历史。未报告、部分报告与失败/取消分别标注。
            </p>
            <p className="mt-1 text-[11px] text-muted">
              状态分布：{Object.entries(USAGE_END_STATE_LABELS)
                .map(([state, label]) => `${label} ${rows.filter((row) => row.endState === state).length}`)
                .join(" / ")}
              ；完整度：{Object.entries(USAGE_COMPLETENESS_LABELS)
                .map(([value, label]) => `${label} ${rows.filter((row) => row.completeness === value).length}`)
                .join(" / ")}
              。
            </p>
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
