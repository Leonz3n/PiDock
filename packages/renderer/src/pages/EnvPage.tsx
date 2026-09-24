import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Panel, Segmented } from "../components/ui";
import {
  configDraftKey,
  isSensitiveKey,
  validateConfigRows,
} from "../data/configRows";
import type { ConfigScope } from "../data/types";
import { emptyConfigDraft, useEnvDraftStore } from "../stores/envDrafts";
import { useHostStore } from "../stores/host";
import { useUiStore } from "../stores/ui";

const SCOPE_TABS: { value: ConfigScope; label: string }[] = [
  { value: "shared", label: "共享模板" },
  { value: "private", label: "本机私有配置" },
  { value: "task", label: "任务覆盖" },
];

const SCOPE_NOTICE: Record<ConfigScope, string> = {
  shared: "共享模板可版本管理。保存前预览差异；已有任务保留采用的版本。",
  private: "本机凭据与路径单独保存，敏感值不进入共享模板。",
  task: "覆盖只作用于当前任务；自动地址在分配端口后解析。",
};

export function EnvPage() {
  const workspace = useHostStore((state) => state.workspace);
  const environments = useMemo(() => workspace?.environments ?? [], [workspace]);
  const tasks = useMemo(() => workspace?.tasks ?? [], [workspace]);
  const saveEnvironmentConfig = useHostStore((state) => state.saveEnvironmentConfig);
  const adoptLatestTemplate = useHostStore((state) => state.adoptLatestTemplate);
  const importVscodeConfig = useHostStore((state) => state.importVscodeConfig);
  const pushToast = useUiStore((state) => state.pushToast);
  const openModal = useUiStore((state) => state.openModal);

  const [selectedId, setSelectedId] = useState(environments[0]?.id ?? "");
  const environment = environments.find((item) => item.id === selectedId) ?? environments[0];
  const [scope, setScope] = useState<ConfigScope>("shared");
  // 任务覆盖 only ever applies to a task that uses the selected environment; the
  // prototype filters the tab (and the task selector) with `task().envId === state.envId`.
  const environmentTasks = useMemo(
    () => tasks.filter((item) => item.environmentId === environment?.id),
    [tasks, environment?.id],
  );
  const [selectedTaskId, setSelectedTaskId] = useState(tasks[0]?.id ?? "");
  const task = environmentTasks.find((item) => item.id === selectedTaskId) ?? environmentTasks[0];

  const original = useMemo(() => {
    if (!environment) return [];
    if (scope === "shared") return environment.variables;
    if (scope === "private") return environment.privateVariables;
    return task?.configOverrides ?? [];
  }, [environment, scope, task]);

  const projectId = environment?.projectId ?? "";
  const draftKey = configDraftKey(projectId, environment?.id ?? "", scope, scope === "task" ? task?.id : undefined);
  const ensure = useEnvDraftStore((state) => state.ensure);
  const draft = useEnvDraftStore((state) => state.drafts[draftKey]) ?? emptyConfigDraft();
  const { setField, addRow, removeRow, setError, commit } = useEnvDraftStore.getState();

  useEffect(() => {
    ensure(draftKey, original);
  }, [draftKey, ensure, original]);

  // Mirrors the prototype's `managedEnvironmentPage()`: a task scope that no
  // longer matches the selected environment falls back to the shared template.
  useEffect(() => {
    if (scope === "task" && environmentTasks.length === 0) setScope("shared");
  }, [scope, environmentTasks.length]);

  if (!environment) return <p className="text-xs text-muted">还没有环境配置。</p>;

  // 查看生效配置 resolves one task's services, so the entry passes whichever
  // task this page is already pointed at: the 任务覆盖 selection, else the
  // environment's own first task.
  const configTask = environmentTasks.find((item) => item.id === selectedTaskId) ?? environmentTasks[0];

  const scopeTabs =
    environmentTasks.length > 0 ? SCOPE_TABS : SCOPE_TABS.filter((item) => item.value !== "task");

  const save = async () => {
    const validationError = validateConfigRows(draft.rows);
    if (validationError) {
      setError(draftKey, validationError);
      return;
    }
    const entries = draft.rows.map((row) => ({ key: row.key.trim(), value: row.value, secret: isSensitiveKey(row.key.trim()) }));
    if (scope === "shared") {
      // Shared templates are versioned, so review the before/after diff first.
      openModal({
        type: "config-diff",
        environmentId: environment.id,
        draftKey,
        rows: draft.rows,
      });
      return;
    }
    await saveEnvironmentConfig({
      environmentId: environment.id,
      scope,
      rows: entries,
      taskId: scope === "task" ? task?.id : undefined,
    });
    commit(draftKey, entries);
    pushToast(scope === "private" ? "已保存本机私有配置（内存模拟）" : "已保存任务覆盖（内存模拟）；受影响服务需要重启后生效");
  };

  const importFromVscode = async () => {
    try {
      const added = await importVscodeConfig(environment.id);
      pushToast(
        added.length > 0
          ? `已从 .vscode 导入 ${added.length} 条示例配方（内存模拟，未扫描仓库）`
          : "没有新的可导入配方",
      );
    } catch (error) {
      pushToast(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-base font-medium text-ink">环境与服务</h1>
          <p className="mt-1 text-xs text-muted">
            图形界面维护共享模板、本机私有配置与任务覆盖；业务服务继续读取仓库默认配置，生效来源按服务只读核对。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => openModal({ type: "effective-config", taskId: configTask?.id })}>
            查看生效配置
          </Button>
          <Button size="sm" onClick={() => void importFromVscode()}>
            从 .vscode 导入
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[260px_1fr]">
        <Panel
          title="环境"
          actions={
            <Button size="sm" onClick={() => openModal({ type: "environment-list", projectId: environment.projectId })}>
              环境管理
            </Button>
          }
        >
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
                <Button size="sm" variant={draft.dirty ? "primary" : "default"} onClick={() => void save()}>
                  {draft.dirty ? "保存更改 · 未保存" : "保存更改"}
                </Button>
              </div>
            }
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <Segmented ariaLabel="配置作用范围" value={scope} onChange={setScope} options={scopeTabs} />
              {scope === "task" ? (
                <select
                  aria-label="选择覆盖的任务"
                  value={task?.id ?? ""}
                  onChange={(event) => setSelectedTaskId(event.target.value)}
                  className="rounded-md border border-line bg-paper px-2 py-1 text-xs"
                >
                  {environmentTasks.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>

            <p className="mb-3 text-[11px] text-muted">
              {scope === "task" && task ? `当前任务：${task.name} · ${SCOPE_NOTICE.task}` : SCOPE_NOTICE[scope]}
            </p>

            <table className="w-full table-fixed text-xs">
              <thead className="text-left text-muted">
                <tr>
                  <th className="w-[38%] pb-1.5">KEY</th>
                  <th className="pb-1.5">VALUE</th>
                  <th className="w-24 pb-1.5" />
                </tr>
              </thead>
              <tbody>
                {draft.rows.map((row, index) => (
                  <tr key={row.id} className="border-t border-line">
                    <td className="py-1.5 pr-2">
                      <input
                        aria-label={`第 ${index + 1} 行 KEY`}
                        value={row.key}
                        spellCheck={false}
                        onChange={(event) => setField(draftKey, row.id, "key", event.target.value)}
                        placeholder="例如 API_ENDPOINT"
                        className="w-full rounded border border-line bg-paper px-2 py-1 font-mono text-[11px]"
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input
                        aria-label={`第 ${index + 1} 行 VALUE`}
                        value={row.value}
                        spellCheck={false}
                        type={isSensitiveKey(row.key) ? "password" : "text"}
                        autoComplete="off"
                        onChange={(event) => setField(draftKey, row.id, "value", event.target.value)}
                        placeholder="变量值，可为空"
                        className="w-full rounded border border-line bg-paper px-2 py-1 font-mono text-[11px]"
                      />
                    </td>
                    <td className="py-1.5">
                      <Button size="sm" variant="ghost" aria-label={`删除第 ${index + 1} 行`} onClick={() => removeRow(draftKey, row.id)}>
                        删除
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <Button size="sm" className="mt-2" onClick={() => addRow(draftKey)}>
              新增一行
            </Button>
            {draft.error ? (
              <p className="mt-2 text-xs text-orange" role="alert">
                {draft.error}
              </p>
            ) : null}

            <div className="mt-3 text-[11px] text-muted">
              <p>直接编辑 KEY 和 VALUE；VALUE 可以为空。当前标签决定配置作用范围，任务覆盖不会改写共享模板。</p>
              <p className="mt-1">保存只写入内存模拟数据；保存修改不代表运行中的进程已加载，受影响服务需要显式重启。</p>
            </div>
          </Panel>

          <Panel
            title="服务启动配方"
            actions={
              <Button size="sm" onClick={() => openModal({ type: "service-recipe", environmentId: environment.id })}>
                添加服务
              </Button>
            }
          >
            {environment.recipes.length === 0 ? (
              <p className="text-xs text-muted">这个环境还没有服务启动配方。</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {environment.recipes.map((recipe) => (
                  <div key={recipe.id} className="rounded-md border border-line px-3 py-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-ink">{recipe.name}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => openModal({ type: "service-recipe", environmentId: environment.id, recipeId: recipe.id })}
                      >
                        编辑 {recipe.name}
                      </Button>
                    </div>
                    <p className="mt-1 text-[11px] text-muted">
                      {[recipe.repo, recipe.runtime].filter(Boolean).join(" · ")}
                    </p>
                    <p className="mt-1 font-mono text-[11px] text-muted">{recipe.startNote}</p>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-3 text-[11px] text-muted">
              配方只在内存中维护表单与列表；真实仓库扫描、写入仓库默认配置与进程启动不在本页范围。
            </p>
          </Panel>

          <Panel title="任务模板版本">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="text-muted">
                环境共享模板 {environment.templateVersion}
                {task ? ` · 「${task.name}」采用 ${task.templateVersion}` : ""}
              </span>
              {task && task.templateVersion !== environment.templateVersion ? (
                <Button
                  size="sm"
                  onClick={async () => {
                    await adoptLatestTemplate(task.id);
                    pushToast(`「${task.name}」已采用 ${environment.templateVersion}；服务等待显式重启`);
                  }}
                >
                  采用最新模板 {environment.templateVersion}
                </Button>
              ) : null}
            </div>
            <p className="mt-2 text-[11px] text-muted">已有任务保留创建时采用的版本；共享模板保存只新增版本，不自动迁移任务。</p>
          </Panel>

          <p className="text-[11px] text-muted">
            明确不在本页范围：真实仓库扫描、向仓库默认配置写入配方与进程启动。页面仅在内存中维护配方表单与列表，并模拟从 `.vscode` 导入，真实实现属后续工单。
          </p>
        </div>
      </div>
    </div>
  );
}
