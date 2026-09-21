import { useMemo, useState } from "react";
import { Badge, Button, Panel } from "../components/ui";
import { ConfigTable } from "../components/ConfigTable";
import { useHostStore } from "../stores/host";
import { useUiStore } from "../stores/ui";

export function EnvPage() {
  const workspace = useHostStore((state) => state.workspace);
  const environments = useMemo(() => workspace?.environments ?? [], [workspace]);
  const tasks = workspace?.tasks ?? [];
  const [selectedId, setSelectedId] = useState(environments[0]?.id ?? "");
  const environment = environments.find((item) => item.id === selectedId) ?? environments[0];
  const [selectedTaskId, setSelectedTaskId] = useState(tasks[0]?.id ?? "");
  const task = tasks.find((item) => item.id === selectedTaskId) ?? tasks[0];
  const [selectedServiceId, setSelectedServiceId] = useState("");
  const service = task?.services.find((item) => item.id === selectedServiceId) ?? task?.services[0];
  const pushToast = useUiStore((state) => state.pushToast);

  const otherEnvironments = useMemo(
    () => environments.filter((item) => item.projectId === environment?.projectId && item.id !== environment?.id),
    [environments, environment?.projectId, environment?.id],
  );

  if (!environment) return <p className="text-xs text-muted">还没有环境配置。</p>;

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-base font-medium text-ink">环境与服务</h1>
        <p className="mt-1 text-xs text-muted">
          图形界面维护共享模板与任务覆盖；业务服务继续读取仓库默认配置，本机私有配置单独保存。
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[260px_1fr]">
        <Panel title="环境">
          <ul className="flex flex-col gap-1.5">
            {environments.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  className={`w-full rounded-md border px-2.5 py-2 text-left text-xs ${
                    item.id === environment.id ? "border-accent/40 bg-accent/10 text-accent" : "border-line text-muted hover:text-ink"
                  }`}
                >
                  <span className="block text-ink">{item.name}</span>
                  <span className="text-[11px]">模板 {item.templateVersion} · {item.projectId}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] text-muted">环境被任务引用时不能删除；最后一个引用移除后才可删除。</p>
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel
            title={`变量 · ${environment.name}`}
            actions={
              <div className="flex items-center gap-2">
                <Badge>共享模板 {environment.templateVersion}</Badge>
                <Button size="sm" onClick={() => pushToast("已保存草稿；受影响服务需要重启后生效")}>
                  保存
                </Button>
              </div>
            }
          >
            <ConfigTable rows={environment.variables} />
            <div className="mt-3 text-[11px] text-muted">
              <p>与另一个环境的差异需要确认后写入新版本：{otherEnvironments.map((item) => item.name).join("、") || "无同项目环境"}。</p>
              <p className="mt-1">Agent 修改共享模板前必须展示差异并等待确认；任务覆盖只作用于当前任务。</p>
            </div>
          </Panel>

          <Panel title="按服务查看生效配置">
            <div className="flex flex-wrap gap-2">
              <select
                aria-label="选择任务"
                value={task?.id ?? ""}
                onChange={(event) => setSelectedTaskId(event.target.value)}
                className="rounded-md border border-line bg-paper px-2 py-1 text-xs"
              >
                {tasks.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="选择服务"
                value={service?.id ?? ""}
                onChange={(event) => setSelectedServiceId(event.target.value)}
                className="rounded-md border border-line bg-paper px-2 py-1 text-xs"
              >
                {task?.services.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
            {service ? (
              <div className="mt-3">
                <ConfigTable rows={service.resolved} valueHeader="最终值" />
              </div>
            ) : null}
            <p className="mt-2 text-[11px] text-muted">
              只读视图：敏感值遮蔽，未保存草稿不参与；应用解析与业务框架内部配置优先级不混用。
            </p>
          </Panel>
        </div>
      </div>
    </div>
  );
}
