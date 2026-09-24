import { useState } from "react";
import { Badge, Button, EmptyState, IconButton, Panel } from "../components/ui";
import { Icon } from "../components/Icon";
import { Card, CardStack, PageIntro, PageTitle, ViewLabel } from "../components/Management";
import { VirtualList } from "../components/VirtualList";
import { scheduledRunResultLabel } from "./runState";
import { canRunScheduleNow, scheduleNextRunText, scheduleRunDetail, scheduleRunTriggerLabel, scheduleStateLabel } from "../data/scheduleRules";
import type { Permission, Schedule } from "../data/types";
import { useHostStore } from "../stores/host";
import { useNavigationStore } from "../stores/navigation";
import { useUiStore } from "../stores/ui";

const PERMISSION_LABEL: Record<Permission, string> = { read: "只读", default: "默认权限", auto: "自动执行" };

/** Prototype `schedulesPage()`'s `.segmented` filter. */
const SCHEDULE_FILTERS = [
  { value: "all", label: "全部" },
  { value: "active", label: "已启用" },
  { value: "paused", label: "已暂停" },
] as const;

type ScheduleFilter = (typeof SCHEDULE_FILTERS)[number]["value"];

/** Prototype `.schedule-history`'s five columns, shared by the header and the rows. */
const HISTORY_COLUMNS = "grid-cols-[150px_minmax(150px,1fr)_110px_minmax(150px,1.4fr)_104px]";

export function SchedulesPage() {
  const workspace = useHostStore((state) => state.workspace);
  const schedules = workspace?.schedules ?? [];
  const runs = workspace?.scheduledRuns ?? [];
  const templates = workspace?.templates ?? [];
  // [PiDock 18] (#20) an archived task keeps its schedules but pauses them, and
  // 立即运行 must not bypass the restore step.
  const archivedTasks = new Set((workspace?.tasks ?? []).filter((task) => task.archived).map((task) => task.id));
  const setScheduleEnabled = useHostStore((state) => state.setScheduleEnabled);
  const runScheduleNow = useHostStore((state) => state.runScheduleNow);
  const navigate = useNavigationStore((state) => state.navigate);
  const pushToast = useUiStore((state) => state.pushToast);
  const openModal = useUiStore((state) => state.openModal);
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [filter, setFilter] = useState<ScheduleFilter>("all");

  const taskName = (taskId: string) => workspace?.tasks.find((task) => task.id === taskId)?.name ?? taskId;
  const scheduleName = (scheduleId: string) => schedules.find((schedule) => schedule.id === scheduleId)?.name ?? scheduleId;
  const isEnabled = (schedule: Schedule) => schedule.enabled && !archivedTasks.has(schedule.taskId);
  const shown = schedules.filter((schedule) => (filter === "all" ? true : filter === "active" ? isEnabled(schedule) : !isEnabled(schedule)));
  const nextEnabled = schedules.find((schedule) => isEnabled(schedule));
  // The newest run wins: the list is not guaranteed to be ordered.
  const latestRun = runs.reduce<(typeof runs)[number] | undefined>((newest, run) => (newest === undefined || run.at > newest.at ? run : newest), undefined);

  const openRun = (taskId: string, sessionId: string | undefined) => {
    const task = workspace?.tasks.find((item) => item.id === taskId);
    if (task && sessionId !== undefined) navigate({ view: "task", projectId: task.projectId, taskId: task.id, sessionId });
  };

  return (
    <div className="flex flex-col gap-4" data-testid="schedules-page">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <ViewLabel>SCHEDULED TASKS</ViewLabel>
          <PageTitle>定时任务</PageTitle>
        </div>
        {workspace?.projects[0] ? (
          <Button size="sm" variant="primary" onClick={() => openModal({ type: "new-task", projectId: workspace.projects[0].id })}>
            <Icon name="plus" />
            新建定时任务
          </Button>
        ) : null}
      </header>

      <PageIntro>
        定时任务拥有固定任务工作区，按规则新建独立会话；每次执行不继承上一次对话上下文，历史会话可查看并继续。
      </PageIntro>

      <div className="schedule-summary grid grid-cols-[repeat(3,minmax(0,1fr))] rounded-[8px] border border-line bg-paper below-stack:grid-cols-1">
        <div className="grid gap-1.5 border-r border-line px-[18px] py-4 last:border-r-0">
          <small className="text-[10px] text-muted">已启用</small>
          <strong className="text-[15px] font-[550] text-ink">{schedules.filter(isEnabled).length}</strong>
        </div>
        <div className="grid gap-1.5 border-r border-line px-[18px] py-4 last:border-r-0">
          <small className="text-[10px] text-muted">最近执行</small>
          <strong className="text-[15px] font-[550] text-ink">{latestRun === undefined ? "暂无" : scheduledRunResultLabel(latestRun.result)}</strong>
        </div>
        <div className="grid gap-1.5 border-r border-line px-[18px] py-4 last:border-r-0">
          <small className="text-[10px] text-muted">下次触发</small>
          <strong className="text-[15px] font-[550] text-ink [overflow-wrap:anywhere]">
            {nextEnabled === undefined ? "暂无" : scheduleNextRunText(nextEnabled, { archived: false })}
          </strong>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="按状态筛选定时任务" className="segmented inline-flex rounded-[7px] border border-line bg-[#f4f5f7] p-[3px]">
          {SCHEDULE_FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={filter === item.value}
              onClick={() => setFilter(item.value)}
              className={`rounded-[5px] px-[11px] py-1.5 text-[10px] ${filter === item.value ? "bg-paper text-accent shadow-[0_1px_4px_#26365018]" : "text-[#7f8794]"}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <small className="text-[11px] text-muted">时区按每个定时任务保存</small>
      </div>

      <div className="schedule-list overflow-hidden rounded-[8px] border border-line bg-paper">
        {shown.length === 0 ? (
          <EmptyState>当前筛选下没有定时任务。</EmptyState>
        ) : (
          shown.map((schedule) => {
            const archived = archivedTasks.has(schedule.taskId);
            const state = scheduleStateLabel(schedule, { archived });
            const runNow = canRunScheduleNow({ archived });
            return (
              <article
                key={schedule.id}
                data-testid={`schedule-row-${schedule.id}`}
                className="schedule-row grid grid-cols-[155px_minmax(0,1fr)_auto] items-center gap-[18px] border-b border-line px-[18px] py-4 last:border-b-0 below-mid:grid-cols-[130px_minmax(0,1fr)] below-stack:grid-cols-1"
              >
                <div className="schedule-time grid grid-cols-[20px_1fr] items-center gap-x-2 gap-y-[3px]">
                  <span aria-hidden="true" className="row-span-2 grid h-5 w-5 place-items-center text-accent">
                    <Icon name="clock" />
                  </span>
                  <strong className="text-[11px] font-[550] text-ink [overflow-wrap:anywhere]">{schedule.rule}</strong>
                  <small className="text-[9px] text-muted">{schedule.timezone}</small>
                </div>

                <button
                  type="button"
                  onClick={() => openModal({ type: "schedule-edit", scheduleId: schedule.id })}
                  className="schedule-main min-w-0 text-left"
                >
                  <span className="flex items-center justify-between gap-3">
                    <strong className="text-[12px] text-ink">{schedule.name}</strong>
                    <Badge tone={state.tone}>{state.label}</Badge>
                  </span>
                  <small className="mt-1 block text-[11px] text-muted">
                    {taskName(schedule.taskId)} · {schedule.model} · 权限 {PERMISSION_LABEL[schedule.permission]}
                  </small>
                  <p className="my-[7px] truncate text-[11px] text-[#6f7887]">结果处理写在提示词中：{schedule.prompt}</p>
                  <small className="block text-[11px] text-muted">
                    下次：{scheduleNextRunText(schedule, { archived })} · {schedule.configVersion === undefined ? "未记录配置版本" : `配置版本 v${schedule.configVersion}`}
                  </small>
                  {state.detail ? <small className="mt-1 block text-[11px] text-warn">{state.detail}</small> : null}
                  {runNow.ok ? null : <small className="mt-1 block text-[11px] text-warn">{runNow.reason}</small>}
                </button>

                <div className="schedule-actions flex flex-wrap items-center justify-end gap-2 below-stack:justify-start">
                  <Button size="sm" onClick={() => openRun(schedule.taskId, workspace?.tasks.find((task) => task.id === schedule.taskId)?.activeSessionId)}>
                    查看任务
                  </Button>
                  <Button
                    size="sm"
                    disabled={!runNow.ok}
                    onClick={async () => {
                      try {
                        const run = await runScheduleNow(schedule.id);
                        // A skipped or failed run did nothing; a run parked on a
                        // confirmation is a real run whose session exists.
                        if (run.result === "skipped" || run.result === "failed") {
                          pushToast(run.reason ?? "本次立即运行未执行");
                          return;
                        }
                        pushToast(run.result === "awaiting-approval" ? "本次执行已进入待确认，可在任务中处理" : "已触发一次执行，并在该任务下新建独立会话");
                        openRun(schedule.taskId, run.sessionId);
                      } catch (error) {
                        pushToast(error instanceof Error ? error.message : String(error));
                      }
                    }}
                  >
                    <Icon name="play" />
                    立即运行
                  </Button>
                  <Button size="sm" onClick={() => void setScheduleEnabled(schedule.id, !schedule.enabled)}>
                    <Icon name={schedule.enabled ? "stop" : "play"} />
                    {schedule.enabled ? "暂停" : "启用"}
                  </Button>
                  <IconButton
                    icon="settings"
                    label="编辑"
                    title={`编辑定时任务 ${schedule.name}`}
                    onClick={() => openModal({ type: "schedule-edit", scheduleId: schedule.id })}
                  />
                </div>
              </article>
            );
          })
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-[650] text-ink">执行记录</h2>
          <small className="mt-1 block text-[11px] text-muted">打开历史会话后可以继续对话</small>
        </div>
        <Badge>最近 {runs.length} 次</Badge>
      </div>

      <div className="table-wrap overflow-auto rounded-[9px] border border-line bg-paper">
        {/* `table` is Tailwind's `display:table` utility, not a harmless marker:
            carrying it next to `grid` made the five header cells anonymous
            table-rows stacked in one 66px column ([UI 对齐 09] #33 review P1-1).
            The run history is virtualised, so its header is a grid row and must
            share the row body's `HISTORY_COLUMNS` instead. */}
        <div data-testid="run-history-head" className={`grid ${HISTORY_COLUMNS} below-stack:min-w-[650px]`}>
          <div className="border-b border-line bg-[#fafbfc] px-[13px] py-[11px] text-[10px] font-medium text-[#96999e]">开始时间</div>
          <div className="border-b border-line bg-[#fafbfc] px-[13px] py-[11px] text-[10px] font-medium text-[#96999e]">定时任务</div>
          <div className="border-b border-line bg-[#fafbfc] px-[13px] py-[11px] text-[10px] font-medium text-[#96999e]">结果</div>
          <div className="border-b border-line bg-[#fafbfc] px-[13px] py-[11px] text-[10px] font-medium text-[#96999e]">详情</div>
          <div className="border-b border-line bg-[#fafbfc] px-[13px] py-[11px] text-[10px] font-medium text-[#96999e]">
            <span className="sr-only">操作</span>
          </div>
        </div>
        <VirtualList
          testId="run-history"
          items={runs}
          rowHeight={44}
          height={280}
          getRowKey={(run) => run.id}
          renderRow={(run) => (
            <div className={`grid ${HISTORY_COLUMNS} items-center border-b border-[#f0f0f1] text-[11px] last:border-b-0`}>
              <span className="px-[13px] text-muted [overflow-wrap:anywhere]">{run.at.slice(0, 16).replace("T", " ")}</span>
              <span className="px-[13px] text-ink [overflow-wrap:anywhere]">
                {scheduleName(run.scheduleId)}
                <small className="ml-1.5 text-muted">{scheduleRunTriggerLabel(run.trigger ?? "due")}</small>
              </span>
              <span className="px-[13px]">
                <Badge tone={run.result === "failed" ? "warn" : run.result === "skipped" ? "neutral" : "accent"}>{scheduledRunResultLabel(run.result)}</Badge>
              </span>
              <span className="px-[13px] text-muted [overflow-wrap:anywhere]">{scheduleRunDetail(run) ?? "无会话"}</span>
              <span className="flex justify-end px-[13px]">
                <Button size="sm" variant="ghost" disabled={run.sessionId === undefined} onClick={() => openRun(run.taskId, run.sessionId)}>
                  打开会话
                </Button>
              </span>
            </div>
          )}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <CardStack>
          <Card>
            <h3 className="text-[13px] font-[650] text-ink">常用模板</h3>
            <ul className="mt-3 flex flex-col gap-2 text-xs">
              {templates.map((template) => (
                <li key={template.id} className="rounded-md border border-line px-2.5 py-2">
                  <label className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="schedule-template"
                      className="mt-0.5 accent-accent"
                      checked={templateId === template.id}
                      onChange={() => setTemplateId(template.id)}
                      aria-label={template.name}
                    />
                    <span>
                      <span className="block text-ink">{template.name}</span>
                      <span className="text-[11px] text-muted">{template.rule}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-muted">
              模板只在新建定时任务时作为起点，不会自行启用或运行；选择后预填周期与提示词。
            </p>
            <Button size="sm" className="mt-2" variant="primary" onClick={() => pushToast("模板已作为新建定时任务的起点（内存模拟）")}>
              使用模板
            </Button>
          </Card>
        </CardStack>

        <Panel title="规则说明">
          <ul className="flex list-disc flex-col gap-1.5 pl-4 text-[11px] text-muted">
            <li>等待确认计入未结束执行并阻止同任务重叠；确认有效期为 24 小时与下一次计划时刻的较早者。</li>
            <li>运行中跨过下一周期跳过并记录；设备关机或 PiDock 未运行时离线不补跑。</li>
            <li>支持一次性、每日、每周与五段 Cron；不虚构任意 Cron 的计算结果。</li>
            <li>仓库模板先获取所选远程分支的最新记录，获取失败不使用缓存冒充最新。</li>
            <li>周一覆盖周末；工作日为周一至周五，不自动跳过节假日。</li>
          </ul>
        </Panel>
      </div>
    </div>
  );
}
