import { useState } from "react";
import { Badge, Button, EmptyState, Panel } from "../components/ui";
import { useHostStore } from "../stores/host";
import { useNavigationStore } from "../stores/navigation";
import { useUiStore } from "../stores/ui";

export function SchedulesPage() {
  const workspace = useHostStore((state) => state.workspace);
  const schedules = workspace?.schedules ?? [];
  const runs = workspace?.scheduledRuns ?? [];
  const templates = workspace?.templates ?? [];
  const setScheduleEnabled = useHostStore((state) => state.setScheduleEnabled);
  const runScheduleNow = useHostStore((state) => state.runScheduleNow);
  const navigate = useNavigationStore((state) => state.navigate);
  const pushToast = useUiStore((state) => state.pushToast);
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-base font-medium text-ink">定时任务</h1>
        <p className="mt-1 text-xs text-muted">
          定时任务拥有固定任务工作区，按规则新建独立会话；每次执行不继承上一次对话上下文，历史会话可查看并继续。
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-4">
          <Panel title="已配置">
            {schedules.length === 0 ? (
              <EmptyState>还没有定时任务。</EmptyState>
            ) : (
              <ul className="flex flex-col gap-2">
                {schedules.map((schedule) => (
                  <li key={schedule.id} className="rounded-md border border-line px-3 py-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-ink">{schedule.name}</span>
                          <Badge tone={schedule.enabled ? "accent" : "neutral"}>{schedule.enabled ? "已启用" : "已暂停"}</Badge>
                          <Badge>{schedule.permission === "write" ? "可写" : "只读"}</Badge>
                        </div>
                        <p className="mt-1 text-xs text-muted">
                          {schedule.rule} · 时区 {schedule.timezone} · 下次执行 {schedule.nextRun} · {schedule.model}
                        </p>
                        <p className="mt-1 text-[11px] text-muted">结果处理写在提示词中：{schedule.prompt}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" onClick={() => void setScheduleEnabled(schedule.id, !schedule.enabled)}>
                          {schedule.enabled ? "暂停" : "启用"}
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={async () => {
                            try {
                              const run = await runScheduleNow(schedule.id);
                              pushToast("已触发一次执行，并在该任务下新建独立会话");
                              const task = workspace?.tasks.find((item) => item.id === schedule.taskId);
                              if (task) {
                                navigate({ view: "task", projectId: task.projectId, taskId: task.id, sessionId: run.sessionId });
                              }
                            } catch (error) {
                              pushToast(error instanceof Error ? error.message : String(error));
                            }
                          }}
                        >
                          立即运行
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-[11px] text-muted">
              等待确认计入未结束执行并阻止同任务重叠；确认有效期为 24 小时与下一次计划时刻的较早者。运行中跨过下一周期跳过并记录，离线不补跑。
            </p>
          </Panel>

          <Panel title="执行记录">
            <ul className="flex flex-col gap-1.5 text-xs">
              {runs.map((run) => (
                <li key={run.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-1.5">
                  <span className="text-muted">{run.at.slice(0, 16).replace("T", " ")}</span>
                  <span>{run.taskId} · {run.sessionId}</span>
                  <Badge tone={run.result === "completed" ? "accent" : "neutral"}>{run.result === "completed" ? "完成" : "跳过"}</Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const task = workspace?.tasks.find((item) => item.id === run.taskId);
                      if (task) navigate({ view: "task", projectId: task.projectId, taskId: task.id, sessionId: run.sessionId });
                    }}
                  >
                    打开会话
                  </Button>
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        <div className="flex flex-col gap-4">
          <Panel title="常用模板">
            <ul className="flex flex-col gap-2 text-xs">
              {templates.map((template) => (
                <li key={template.id} className="rounded-md border border-line px-2.5 py-2">
                  <label className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="schedule-template"
                      className="mt-0.5"
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
          </Panel>
          <Panel title="规则说明">
            <ul className="flex list-disc flex-col gap-1.5 pl-4 text-[11px] text-muted">
              <li>支持一次性、每日、每周与五段 Cron；原型不虚构任意 Cron 的计算结果。</li>
              <li>仓库模板先获取所选远程分支的最新记录，获取失败不使用缓存冒充最新。</li>
              <li>周一覆盖周末；工作日为周一至周五，不自动跳过节假日。</li>
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
