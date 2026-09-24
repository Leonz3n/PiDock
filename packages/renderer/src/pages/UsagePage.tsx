import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Panel, Segmented } from "../components/ui";
import { VirtualList } from "../components/VirtualList";
import { Card, CardGrid, Note, PageEmpty, PageIntro, PageTitle, SectionHeader, StatCard, Table, TableWrap, Td, Th, ViewLabel } from "../components/Management";
import { useHostStore } from "../stores/host";
import type { UsageCleanupScope, UsageKind } from "../data/types";
import {
  USAGE_COMPLETENESS_LABELS,
  USAGE_DEFINITIONS,
  USAGE_END_STATE_LABELS,
  USAGE_GROUP_OPTIONS,
  USAGE_KIND_LABELS,
  USAGE_TIMEZONE_OFFSET_MINUTES,
  filterUsageRecords,
  groupUsageRecords,
  sumUsageRecords,
  unparsableUsageTimes,
  usageDayKey,
  usageWindow,
  type UsageGroupBy,
} from "../data/usageState";

/**
 * Prototype `usagePage()`'s 统计日期 select. The prototype always has a
 * selected task and a seven-day sample; this page reads a whole ledger, so it
 * adds 全部 (the unbounded default the ledger had before the alignment) and
 * 自定义 (typed dates) as two more positions ([UI 对齐 09] #33).
 */
const USAGE_RANGES = ["全部", "近 7 天", "今天", "近 30 天"] as const;
type UsageRange = (typeof USAGE_RANGES)[number] | "自定义";

/**
 * The prototype prints `1.28M` where we have raw tokens; the same reading, one
 * unit up, so the stat card keeps its prototype width.
 */
function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  return value.toLocaleString();
}

/** One total definition for the whole page: input + output + cache read/write. */
function recordTotal(totals: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  return totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
}

function dayKeyOf(date: Date): string {
  const local = new Date(date.getTime() + USAGE_TIMEZONE_OFFSET_MINUTES * 60_000);
  return local.toISOString().slice(0, 10);
}

/** The `统计日期` select sets the same `from`/`to` the date fields edit by hand. */
function rangeBounds(range: UsageRange, today: string): { from: string; to: string } {
  if (range === "今天") return { from: today, to: today };
  const days = range === "近 30 天" ? 29 : 6;
  const start = new Date(`${today}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - days);
  return { from: start.toISOString().slice(0, 10), to: today };
}
function shortDay(day: string): string {
  return day.slice(5).replace("-", "/");
}

/**
 * Token usage statistics ([PiDock 12] #12), laid out as the prototype's
 * `usagePage()`: view label + title with the two selects, the four stat cards,
 * the daily bars and the composition donut, then the six-column summary table
 * ([UI 对齐 09] #33).
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
  const [groupBy, setGroupBy] = useState<UsageGroupBy>("provider");
  const [range, setRange] = useState<UsageRange>("全部");
  // No bound by default: the ledger holds every recorded call, and only the
  // range control narrows it (the prototype's own default is its 7-day sample).
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
  const total = recordTotal(totals);

  /**
   * The 7 (or 30) bars of the selected window. A day with no recorded call is
   * drawn as a hairline instead of a value-sized bar, so an idle day cannot
   * read as a small number.
   */
  const chart = useMemo(() => {
    const days: string[] = [];
    if (window.fromMs !== null && window.toMs !== null) {
      for (let ms = window.fromMs; ms <= window.toMs && days.length < 31; ms += 24 * 60 * 60_000) {
        days.push(dayKeyOf(new Date(ms)));
      }
    } else {
      days.push(...[...new Set(rows.map((row) => usageDayKey(row.at)).filter((day): day is string => day !== null))].sort());
    }
    const perDay = new Map<string, number>();
    for (const row of rows) {
      const key = usageDayKey(row.at);
      if (key === null) continue;
      perDay.set(key, (perDay.get(key) ?? 0) + recordTotal(row));
    }
    const values = days.map((day) => ({ day, value: perDay.get(day) ?? 0 }));
    const max = Math.max(1, ...values.map((item) => item.value));
    return { days: values, max };
  }, [window.fromMs, window.toMs, rows]);

  /** Prototype `.usage-donut` sectors, computed from the filtered records. */
  const composition = useMemo(() => {
    const parts = [
      { label: "输入", value: totals.input, color: "#344a7d" },
      { label: "缓存读取", value: totals.cacheRead, color: "#929db6" },
      { label: "输出", value: totals.output, color: "#dce0e8" },
      { label: "缓存写入", value: totals.cacheWrite, color: "#f0f2f5" },
    ];
    const sum = Math.max(1, parts.reduce((accumulator, part) => accumulator + part.value, 0));
    let cursor = 0;
    return parts.map((part) => {
      const start = (cursor / sum) * 100;
      cursor += part.value;
      return { ...part, start, end: (cursor / sum) * 100 };
    });
  }, [totals]);

  const cleanup = async (scope: UsageCleanupScope) => {
    try {
      const result = await clearUsage(scope);
      setCleanupNote(`${result.description}：移除 ${result.removed} 条，剩余 ${result.remaining} 条。`);
    } catch (error) {
      setCleanupNote(error instanceof Error ? error.message : String(error));
    }
  };

  const selectRange = (next: UsageRange) => {
    setRange(next);
    if (next === "全部") {
      setFrom("");
      setTo("");
      return;
    }
    if (next === "自定义") return;
    const bounds = rangeBounds(next, dayKeyOf(new Date()));
    setFrom(bounds.from);
    setTo(bounds.to);
  };

  const groupLabel = USAGE_GROUP_OPTIONS.find((option) => option.id === groupBy)?.label ?? groupBy;
  // A bucket key is an id; the table shows the name the rest of the app uses.
  const groupName = (group: { key: string; label: string }): string => {
    if (groupBy === "provider") return workspace?.providers.find((provider) => provider.id === group.key)?.name ?? group.label;
    if (groupBy === "task") return workspace?.tasks.find((task) => task.id === group.key)?.name ?? group.label;
    if (groupBy === "project") return workspace?.projects.find((project) => project.id === group.key)?.name ?? group.label;
    return group.label;
  };
  const latest = rows.reduce<(typeof rows)[number] | undefined>((newest, row) => (newest === undefined || row.at > newest.at ? row : newest), undefined);

  return (
    <div className="flex flex-col gap-4" data-testid="usage-page">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <ViewLabel>USAGE</ViewLabel>
          <PageTitle>Token 用量</PageTitle>
        </div>
        <div className="usage-controls flex flex-wrap items-center gap-2">
          <select
            data-testid="usage-range"
            aria-label="统计日期"
            className="rounded-md border border-line bg-paper px-2 py-[5px] text-[11px] text-ink"
            value={range}
            onChange={(event) => selectRange(event.target.value as UsageRange)}
          >
            {USAGE_RANGES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
            <option value="自定义">自定义</option>
          </select>
          <select
            aria-label="统计维度"
            className="rounded-md border border-line bg-paper px-2 py-[5px] text-[11px] text-ink"
            value={groupBy}
            onChange={(event) => setGroupBy(event.target.value as UsageGroupBy)}
          >
            {USAGE_GROUP_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </header>

      <PageIntro>
        按实际调用累计，压缩上下文不会减少消耗。统计范围为本应用记录，不等同账户账单或供应商配额；未观测到的外部调用不伪造。本页数据为样例数据。
      </PageIntro>

      <CardGrid cols={4}>
        <StatCard label="累计 Token" value={compactTokens(total)} detail="包含已报告的缓存用量" />
        <StatCard
          label="最近一次调用"
          value={
            latest === undefined ? (
              "—"
            ) : (
              <>
                {compactTokens(recordTotal(latest))}
                <small className="text-[11px] font-normal tracking-normal"> Tokens</small>
              </>
            )
          }
          detail={latest === undefined ? "当前筛选内没有调用记录" : `${latest.taskId} · ${latest.sessionId}`}
        />
        <StatCard label="已记录调用" value={rows.length.toLocaleString()} detail="按独立调用去重" />
        <StatCard
          label="未完整报告"
          value={
            <>
              {totals.missing + totals.partial}
              <small className="text-[11px] font-normal tracking-normal"> 次</small>
            </>
          }
          detail="未知用量不按零计算"
        />
      </CardGrid>

      {rows.length === 0 ? (
        <Card>
          <PageEmpty title="当前筛选没有可查看用量的调用">切换时间范围或筛选条件，或先在任务里发起一次模型调用。</PageEmpty>
        </Card>
      ) : (
        <CardGrid cols={2}>
          <Card>
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-[13px] font-[650] text-ink">每日消耗</h3>
              <small className="text-[11px] text-muted">{range === "自定义" ? `${from || "最早"} → ${to || "不限"}` : range}</small>            </div>
            <div className="bar-chart mt-[15px] flex h-[155px] items-end gap-3.5 pt-[15px]">
              {chart.days.map((item, index) => (
                <div key={item.day} className="bar-column flex h-full flex-1 flex-col items-center justify-end gap-[5px] text-center" title={`${item.day}：${item.value.toLocaleString()} Tokens`}>
                  {/* A zero day keeps the prototype's 5px minimum but at 40%
                      opacity, so it cannot read as a small consumption. */}
                  <span
                    aria-hidden="true"
                    className={`bar w-[65%] max-w-[38px] rounded-t-[3px] ${
                      index === chart.days.length - 1 ? "bg-accent" : "bg-[#aeb7cd]"
                    } ${item.value === 0 ? "min-h-[5px] opacity-40" : "min-h-[5px]"}`}
                    style={{ height: `${Math.round((item.value / chart.max) * 100)}%` }}
                  />
                  <small className="font-mono text-[9px]">{index === 0 || index === chart.days.length - 1 || chart.days.length <= 10 || index % 5 === 0 ? shortDay(item.day) : ""}</small>
                </div>
              ))}
            </div>
          </Card>
          <Card>
            <h3 className="text-[13px] font-[650] text-ink">Token 构成</h3>
            <div className="mt-[22px] flex items-center justify-around">
              <div
                className="usage-donut grid h-[120px] w-[120px] place-items-center rounded-full"
                style={{ background: `conic-gradient(${composition.map((part) => `${part.color} ${part.start}% ${part.end}%`).join(", ")})` }}
              >
                <div className="grid h-[88px] w-[88px] place-items-center rounded-full bg-paper text-[21px] font-[550]">{compactTokens(total)}</div>
              </div>
              <div className="text-[11px] leading-[2.4]">
                {composition.map((part) => (
                  <div key={part.label}>
                    <span aria-hidden="true" style={{ color: part.color === "#dce0e8" || part.color === "#f0f2f5" ? "#c9ced9" : part.color }}>
                      ●
                    </span>{" "}
                    {part.label} <strong className="font-[650]">{compactTokens(part.value)}</strong>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        </CardGrid>
      )}

      <SectionHeader title={`按${groupLabel}汇总`} actions={<Badge>示例 · 不代表账单</Badge>} />

      <TableWrap>
        <Table>
          <thead>
            <tr>
              <Th>{groupLabel}</Th>
              <Th>输入</Th>
              <Th>输出</Th>
              <Th>缓存读取</Th>
              <Th>总计</Th>
              <Th>完整性</Th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <tr key={group.key} data-testid={`usage-group-${group.key.replace(/[^\w-]+/g, "-")}`}>
                <Td className="[overflow-wrap:anywhere]">{groupName(group)}</Td>
                <Td className="mono">{compactTokens(group.totals.input)}</Td>
                <Td className="mono">{compactTokens(group.totals.output)}</Td>
                <Td className="mono">{compactTokens(group.totals.cacheRead)}</Td>
                <Td className="mono">{compactTokens(recordTotal(group.totals))}</Td>
                <Td>
                  <Badge tone={group.totals.missing > 0 ? "warn" : "accent"}>{group.totals.missing > 0 ? "部分未报告" : "已报告"}</Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>
      <Note>
        总计为输入 + 输出 + 缓存读取 + 缓存写入；表中单列缓存写入会撑宽六列表格，因此缓存写入只在明细与汇总里逐项列出。完整性为「已报告」时该组所有调用都带用量；有未报告调用时整组标为「部分未报告」。
      </Note>

      <SectionHeader title={`明细 · ${rows.length} 条`} />
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
      <Note>
        列：时间 / 模型（→ 实际响应模型）/ 任务 · 会话 · 类型 / 输入 / 输出（含 reasoning）/ 缓存读取 / 缓存写入。未报告的行显示「未报告」，不计为 0；部分报告与失败／取消调用在类型列标注。
      </Note>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
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
          <label className="flex flex-col gap-1 text-[11px] text-muted">
            起始日期
            <input
              aria-label="起始日期"
              className="rounded border border-line bg-soft/40 px-2 py-1 text-xs text-ink"
              placeholder="YYYY-MM-DD"
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
                setRange("自定义");
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-muted">
            结束日期
            <input
              aria-label="结束日期"
              className="rounded border border-line bg-soft/40 px-2 py-1 text-xs text-ink"
              placeholder="YYYY-MM-DD"
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
                setRange("自定义");
              }}
            />
          </label>
        </div>
        <Note>{window.label}</Note>
        {unknownTimes.length > 0 ? (
          <p className="mt-1 text-[11px] text-amber-600">有 {unknownTimes.length} 条记录时间不可解析，未按时间归组：{unknownTimes.slice(0, 3).join("、")}</p>
        ) : null}
      </Card>

      <CardGrid cols={2}>
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
      </CardGrid>

      <CardGrid cols={2}>
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
      </CardGrid>

      <p className="text-[11px] text-muted">静态草稿只按固定数量演示，不能作为容量证据；本页数据量固定为 240 行用于验证虚拟滚动。</p>
      <Button size="sm" variant="ghost" onClick={() => void loadUsage()}>
        重新加载
      </Button>
    </div>
  );
}
