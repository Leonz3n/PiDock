import { useMemo, useState } from "react";
import { Badge, Button, EmptyState, Field, Modal, Segmented } from "./ui";
import { VirtualList } from "./VirtualList";
import { runStateLabel } from "../pages/runState";
import { diffConfigRows, isSensitiveKey, nextTemplateVersion } from "../data/configRows";
import { directoryLinkName, newWorkspaceKey, workspacePath } from "../data/directories";
import type { ConfigEntry, ProjectDirectory } from "../data/types";
import { useEnvDraftStore } from "../stores/envDrafts";
import { useHostStore } from "../stores/host";
import { useNavigationStore } from "../stores/navigation";
import { useUiStore } from "../stores/ui";

export function Modals() {
  const modal = useUiStore((state) => state.modal);
  const closeModal = useUiStore((state) => state.closeModal);
  const pushToast = useUiStore((state) => state.pushToast);
  const workspace = useHostStore((state) => state.workspace);
  const tasks = workspace?.tasks ?? [];
  const [sessionFilter, setSessionFilter] = useState<"active" | "archived">("active");
  const [sessionSearch, setSessionSearch] = useState("");
  const [cleanup, setCleanup] = useState<{ resource: string; action: string; detail: string }[] | null>(null);
  const [cleanupError, setCleanupError] = useState<string | null>(null);

  const task = modal && "taskId" in modal ? tasks.find((item) => item.id === modal.taskId) : undefined;

  const sessions = useMemo(() => {
    if (!task) return [];
    return task.sessions
      .filter((session) => session.archived === (sessionFilter === "archived"))
      .filter((session) => session.name.toLowerCase().includes(sessionSearch.trim().toLowerCase()));
  }, [task, sessionFilter, sessionSearch]);

  if (!modal) return null;

  if (modal.type === "sessions" && task) {
    return (
      <Modal
        title="全部会话"
        onClose={closeModal}
        footer={
          <Button
            size="sm"
            onClick={async () => {
              const created = await useHostStore.getState().createSession(task.id);
              closeModal();
              useNavigationStore.getState().navigate({ view: "task", projectId: task.projectId, taskId: task.id, sessionId: created.id });
            }}
          >
            新建会话
          </Button>
        }
      >
        <Field label="搜索会话">
          <input
            aria-label="搜索会话"
            value={sessionSearch}
            onChange={(event) => setSessionSearch(event.target.value)}
            placeholder="按会话名称查找"
            className="rounded-md border border-line px-2 py-1.5 text-xs"
          />
        </Field>
        <div className="my-3">
          <Segmented
            ariaLabel="会话分组"
            value={sessionFilter}
            onChange={setSessionFilter}
            options={[
              { value: "active", label: `未归档 ${task.sessions.filter((item) => !item.archived).length}` },
              { value: "archived", label: `已归档 ${task.sessions.filter((item) => item.archived).length}` },
            ]}
          />
        </div>
        <p className="mb-2 text-[11px] text-muted">归档保留历史和草稿；打开可继续对话，恢复后重新加入未归档列表。</p>
        {sessions.length === 0 ? (
          <EmptyState>没有匹配的会话</EmptyState>
        ) : (
          <VirtualList
            items={sessions}
            rowHeight={56}
            height={280}
            testId="session-list"
            getRowKey={(session) => session.id}
            renderRow={(session) => (
              <div className="flex items-center justify-between gap-2 border-b border-line px-1 py-2">
                <button
                  type="button"
                  className="text-left text-xs"
                  onClick={() => {
                    closeModal();
                    useNavigationStore.getState().navigate({ view: "task", projectId: task.projectId, taskId: task.id, sessionId: session.id });
                  }}
                >
                  <strong className="block text-ink">{session.name}</strong>
                  <small className="text-muted">
                    {session.id === task.activeSessionId ? "当前会话 · " : ""}
                    {session.archived ? "已归档" : "未归档"} · {session.permission === "read" ? "只读" : "可对话"}
                  </small>
                </button>
                <div className="flex items-center gap-1.5">
                  <Badge>{runStateLabel(session.runState)}</Badge>
                  <Button
                    size="sm"
                    onClick={async () => {
                      await useHostStore.getState().archiveSession(task.id, session.id, !session.archived);
                      pushToast(session.archived ? "会话已恢复" : "会话已归档，可在全部会话中查看或恢复");
                    }}
                  >
                    {session.archived ? "恢复" : "归档"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => useUiStore.getState().openModal({ type: "rename-session", taskId: task.id, sessionId: session.id, value: session.name })}
                  >
                    重命名
                  </Button>
                </div>
              </div>
            )}
          />
        )}
      </Modal>
    );
  }

  if (modal.type === "rename-task" && task) {
    return <RenameTaskModal taskId={task.id} initialValue={modal.value} onClose={closeModal} />;
  }

  if (modal.type === "rename-session" && task) {
    return <RenameSessionModal taskId={task.id} sessionId={modal.sessionId} initialValue={modal.value} onClose={closeModal} />;
  }

  if (modal.type === "archive-task" && task) {
    return (
      <Modal
        title="归档任务"
        onClose={closeModal}
        footer={
          <Button
            size="sm"
            variant="primary"
            onClick={async () => {
              await useHostStore.getState().archiveTask(task.id);
              closeModal();
              pushToast("任务已归档，执行停止；未批准的操作不再执行");
            }}
          >
            归档任务
          </Button>
        }
      >
        <p className="text-xs text-muted">
          归档「{task.name}」将停止本任务的运行并保留代码、会话与草稿。
          {task.type === "scheduled" ? "同时暂停后续定时触发。" : ""}
        </p>
      </Modal>
    );
  }

  if (modal.type === "cleanup" && task) {
    return (
      <Modal
        title="清理清单预览"
        onClose={() => {
          setCleanup(null);
          setCleanupError(null);
          closeModal();
        }}
        footer={
          <>
            <Button
              size="sm"
              onClick={() => {
                void useHostStore
                  .getState()
                  .loadCleanupPreview(task.id)
                  .then(setCleanup)
                  .catch((error: unknown) => setCleanupError(error instanceof Error ? error.message : String(error)));
              }}
            >
              生成清单
            </Button>
            <Button size="sm" variant="primary" onClick={() => pushToast("真实清理需要完成代码保留与所选导出后才删除；当前为预览")}>
              确认执行清理
            </Button>
          </>
        }
      >
        <p className="text-xs text-muted">
          首版遇到未交付代码采用保留独立副本的保守路径，普通目录原始文件始终保留。未选择导出时对应记录将移除。
        </p>
        {cleanupError ? <p className="mt-3 text-xs text-orange">{cleanupError}</p> : null}
        {cleanup ? (
          <table className="mt-3 w-full text-xs">
            <thead className="text-left text-muted">
              <tr>
                <th className="pb-1.5">资源</th>
                <th className="pb-1.5">处理方式</th>
                <th className="pb-1.5">说明</th>
              </tr>
            </thead>
            <tbody>
              {cleanup.map((item) => (
                <tr key={item.resource} className="border-t border-line">
                  <td className="py-1.5 pr-2 text-ink">{item.resource}</td>
                  <td className="py-1.5 pr-2">{item.action}</td>
                  <td className="py-1.5 text-muted">{item.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Modal>
    );
  }

  if (modal.type === "pair-device") {
    return (
      <Modal
        title="配对远程设备"
        onClose={closeModal}
        footer={
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              closeModal();
              pushToast("已生成一次性配对凭据（模拟）；成功配对后换取独立设备凭据");
            }}
          >
            生成配对凭据
          </Button>
        }
      >
        <p className="text-xs text-muted">
          配对凭据为一次性短时证明，不编码长期令牌、项目名称或本机路径。设备配对后获得独立权限，可单独撤销。
        </p>
      </Modal>
    );
  }

  if (modal.type === "new-provider") {
    return (
      <Modal
        title="添加 Provider"
        onClose={closeModal}
        footer={
          <Button size="sm" variant="primary" onClick={() => {
            closeModal();
            pushToast("已保存到内存；同步模型列表为示例候选，未调用真实发现接口");
          }}>
            保存
          </Button>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="显示名称">
            <input aria-label="显示名称" className="rounded-md border border-line px-2 py-1.5 text-sm" placeholder="例如 团队网关" />
          </Field>
          <Field label="协议">
            <select aria-label="协议" className="rounded-md border border-line px-2 py-1.5 text-sm">
              <option>anthropic-messages</option>
              <option>openai-responses</option>
              <option>openai-chat-completions</option>
            </select>
          </Field>
          <Field label="服务地址" hint="凭据通过本机私有配置引用，不写入共享模板">
            <input aria-label="服务地址" className="rounded-md border border-line px-2 py-1.5 text-sm" placeholder="https://" />
          </Field>
          <Field label="模型 ID">
            <input aria-label="模型 ID" className="rounded-md border border-line px-2 py-1.5 text-sm" placeholder="支持直接填写或从候选选择" />
          </Field>
        </div>
      </Modal>
    );
  }

  if (modal.type === "config-diff") {
    const environment = (workspace?.environments ?? []).find((item) => item.id === modal.environmentId);
    if (!environment) return null;
    const diff = diffConfigRows(environment.variables, modal.rows);
    const entries: ConfigEntry[] = modal.rows.map((row) => ({
      key: row.key.trim(),
      value: row.value,
      secret: isSensitiveKey(row.key.trim()),
    }));
    const nextVersion = nextTemplateVersion(environment.templateVersion);
    const show = (key: string, value: string | undefined) =>
      value === undefined ? "（无）" : isSensitiveKey(key) ? "[敏感值引用]" : value || "（空值）";
    const empty = diff.added.length === 0 && diff.changed.length === 0 && diff.removed.length === 0;
    return (
      <Modal
        title="审阅共享模板变更"
        onClose={closeModal}
        footer={
          <Button
            size="sm"
            variant="primary"
            onClick={async () => {
              await useHostStore
                .getState()
                .saveEnvironmentConfig({ environmentId: environment.id, scope: "shared", rows: entries });
              useEnvDraftStore.getState().commit(modal.draftKey, entries);
              closeModal();
              pushToast(`共享模板已保存为 ${nextVersion}（内存模拟）；已有任务保留采用的版本`);
            }}
          >
            确认保存新版本
          </Button>
        }
      >
        <p className="text-xs text-muted">
          {environment.name}：{environment.templateVersion} → {nextVersion}。已有任务保留采用的版本。
        </p>
        <div className="mt-3 flex flex-col gap-2 text-xs">
          {empty ? <p className="text-muted">没有字段差异，当前仅预览保存流程。</p> : null}
          {diff.added.map((key) => (
            <div key={`add-${key}`}>
              <strong>{key}</strong>
              <br />
              新增：{show(key, modal.rows.find((row) => row.key.trim() === key)?.value)}
            </div>
          ))}
          {diff.changed.map((change) => (
            <div key={`changed-${change.key}`}>
              <strong>{change.key}</strong>
              <br />
              {show(change.key, change.before)} → {show(change.key, change.after)}
            </div>
          ))}
          {diff.removed.map((key) => (
            <div key={`removed-${key}`}>
              <strong>{key}</strong>
              <br />
              删除：{show(key, environment.variables.find((entry) => entry.key === key)?.value)}
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] text-muted">KEY 改名会同时显示为一行移除与一行新增。</p>
      </Modal>
    );
  }

  if (modal.type === "project-directories") {
    const project = (workspace?.projects ?? []).find((item) => item.id === modal.projectId);
    if (!project) return null;
    return <ProjectDirectoriesModal projectId={project.id} onClose={closeModal} />;
  }

  if (modal.type === "task-directories") {
    if (!task) return null;
    return <TaskDirectoriesModal taskId={task.id} onClose={closeModal} />;
  }

  if (modal.type === "service-recipe") {
    return (
      <ServiceRecipeModal environmentId={modal.environmentId} recipeId={modal.recipeId} onClose={closeModal} />
    );
  }

  if (modal.type === "new-task") {
    const project = (workspace?.projects ?? []).find((item) => item.id === modal.projectId);
    if (!project) return null;
    return <NewTaskModal projectId={project.id} onClose={closeModal} />;
  }

  return null;
}

function RenameTaskModal({ taskId, initialValue, onClose }: { taskId: string; initialValue: string; onClose: () => void }) {
  const renameTask = useHostStore((state) => state.renameTask);
  const pushToast = useUiStore((state) => state.pushToast);
  const [value, setValue] = useState(initialValue);
  return (
    <Modal
      title="重命名任务"
      onClose={onClose}
      footer={
        <Button
          size="sm"
          variant="primary"
          onClick={async () => {
            const next = value.trim();
            if (!next) return pushToast("请输入名称");
            await renameTask(taskId, next);
            onClose();
          }}
        >
          保存
        </Button>
      }
    >
      <Field label="名称">
        <input
          aria-label="任务名称"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="rounded-md border border-line px-2 py-1.5 text-sm"
        />
      </Field>
      <p className="mt-3 text-[11px] text-muted">重命名不影响任务工作区目录、分支与工作副本。</p>
    </Modal>
  );
}

function RenameSessionModal({
  taskId,
  sessionId,
  initialValue,
  onClose,
}: {
  taskId: string;
  sessionId: string;
  initialValue: string;
  onClose: () => void;
}) {
  const renameSession = useHostStore((state) => state.renameSession);
  const pushToast = useUiStore((state) => state.pushToast);
  const [value, setValue] = useState(initialValue);
  return (
    <Modal
      title="重命名会话"
      onClose={onClose}
      footer={
        <Button
          size="sm"
          variant="primary"
          onClick={async () => {
            const next = value.trim();
            if (!next) return pushToast("请输入名称");
            await renameSession(taskId, sessionId, next);
            onClose();
          }}
        >
          保存
        </Button>
      }
    >
      <Field label="名称">
        <input
          aria-label="会话名称"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="rounded-md border border-line px-2 py-1.5 text-sm"
        />
      </Field>
    </Modal>
  );
}

function ProjectDirectoriesModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const workspace = useHostStore((state) => state.workspace);
  const setProjectDirectories = useHostStore((state) => state.setProjectDirectories);
  const pushToast = useUiStore((state) => state.pushToast);
  const project = workspace?.projects.find((item) => item.id === projectId);
  // A directory referenced by any task is locked: its name/path must not change
  // silently underneath an in-flight task.
  const lockedIds = new Set(
    (workspace?.tasks ?? []).filter((item) => item.projectId === projectId).flatMap((item) => item.directories.map((directory) => directory.id)),
  );
  const [rows, setRows] = useState<ProjectDirectory[]>(() => (project?.directories ?? []).map((directory) => ({ ...directory })));
  if (!project) return null;
  const update = (id: string, field: "name" | "path", value: string) =>
    setRows((items) => items.map((item) => (item.id === id ? { ...item, [field]: value } : item)));
  return (
    <Modal
      title="管理普通目录"
      onClose={onClose}
      footer={
        <Button
          size="sm"
          variant="primary"
          onClick={async () => {
            try {
              await setProjectDirectories(projectId, rows);
              onClose();
              pushToast("项目普通目录已保存到内存");
            } catch (error) {
              pushToast(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          保存目录
        </Button>
      }
    >
      <p className="text-xs text-muted">普通目录可与 Git 仓库同时加入项目，任务中按需选择；路径仅作原型展示。</p>
      <div className="mt-3 flex flex-col gap-2">
        {rows.map((row, index) => {
          const locked = lockedIds.has(row.id);
          return (
            <div key={row.id} className="flex flex-wrap items-center gap-2">
              <input
                aria-label={`目录名称 第 ${index + 1} 行`}
                value={row.name}
                readOnly={locked}
                placeholder="例如：设计资料"
                onChange={(event) => update(row.id, "name", event.target.value)}
                className="w-40 rounded-md border border-line px-2 py-1.5 text-xs read-only:bg-soft"
              />
              <input
                aria-label={`目录路径 第 ${index + 1} 行`}
                value={row.path}
                readOnly={locked}
                placeholder="/Users/name/Documents/design"
                onChange={(event) => update(row.id, "path", event.target.value)}
                className="flex-1 rounded-md border border-line px-2 py-1.5 font-mono text-[11px] read-only:bg-soft"
              />
              <Badge>普通目录</Badge>
              {locked ? <Badge tone="warn">任务使用中</Badge> : null}
              <Button
                size="sm"
                variant="ghost"
                aria-label={`移除目录 第 ${index + 1} 行`}
                disabled={locked}
                onClick={() => setRows((items) => items.filter((item) => item.id !== row.id))}
              >
                移除
              </Button>
            </div>
          );
        })}
        <div>
          <Button size="sm" onClick={() => setRows((items) => [...items, { id: `dir-new-${items.length + 1}`, name: "", path: "" }])}>
            添加目录
          </Button>
        </div>
      </div>
      <p className="mt-3 text-[11px] text-muted">名称与完整路径必填；同一路径不能重复。被任务引用的目录在任务处理前不能改动或移除。</p>
    </Modal>
  );
}

function TaskDirectoriesModal({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const workspace = useHostStore((state) => state.workspace);
  const setTaskDirectories = useHostStore((state) => state.setTaskDirectories);
  const pushToast = useUiStore((state) => state.pushToast);
  const task = workspace?.tasks.find((item) => item.id === taskId);
  const project = workspace?.projects.find((item) => item.id === task?.projectId);
  const [selected, setSelected] = useState<string[]>(() => (task?.directories ?? []).map((directory) => directory.id));
  if (!task || !project) return null;
  const existing = new Set(task.directories.map((directory) => directory.id));
  return (
    <Modal
      title="添加普通目录"
      onClose={onClose}
      footer={
        <Button
          size="sm"
          variant="primary"
          onClick={async () => {
            try {
              await setTaskDirectories(taskId, selected);
              onClose();
              pushToast("任务普通目录已更新；已有链接与 worktree 保留（内存模拟）");
            } catch (error) {
              pushToast(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          保存目录
        </Button>
      }
    >
      <p className="text-xs text-muted">普通目录通过软链接加入任务目录，不复制文件、不初始化 Git；修改会影响原目录。</p>
      <div className="mt-3 flex flex-col gap-2">
        {project.directories.length === 0 ? <EmptyState>该项目还没有登记普通目录。</EmptyState> : null}
        {project.directories.map((directory) => {
          const added = existing.has(directory.id);
          return (
            <label key={directory.id} className="flex items-start gap-2 rounded-md border border-line px-2.5 py-2 text-xs">
              <input
                type="checkbox"
                className="mt-0.5"
                aria-label={`任务目录 ${directory.name}`}
                checked={selected.includes(directory.id)}
                disabled={added}
                onChange={(event) =>
                  setSelected((items) =>
                    event.target.checked ? [...items, directory.id] : items.filter((id) => id !== directory.id),
                  )
                }
              />
              <span>
                <strong className="block text-ink">{directory.name}</strong>
                <small className="font-mono text-[11px] text-muted">
                  {directory.path}
                  {added ? " · 已加入" : ""}
                </small>
                <small className="mt-0.5 block text-[11px] text-muted">
                  软链接 {directoryLinkName(directory)}/ · 修改影响原目录
                </small>
              </span>
            </label>
          );
        })}
      </div>
      <p className="mt-3 text-[11px] text-muted">
        任务中自动生成英文数字链接名，中文名称只用于显示。同一目录被多个任务引用时共享文件，不承诺隔离。
      </p>
    </Modal>
  );
}

function ServiceRecipeModal({
  environmentId,
  recipeId,
  onClose,
}: {
  environmentId: string;
  recipeId?: string;
  onClose: () => void;
}) {
  const workspace = useHostStore((state) => state.workspace);
  const saveServiceRecipe = useHostStore((state) => state.saveServiceRecipe);
  const pushToast = useUiStore((state) => state.pushToast);
  const environment = workspace?.environments.find((item) => item.id === environmentId);
  const existing = environment?.recipes.find((item) => item.id === recipeId);
  const [name, setName] = useState(existing?.name ?? "");
  const [repo, setRepo] = useState(existing?.repo ?? "");
  const [runtime, setRuntime] = useState(existing?.runtime ?? "Node.js");
  const [startNote, setStartNote] = useState(existing?.startNote ?? "使用项目脚本启动");
  if (!environment) return null;
  return (
    <Modal
      title={existing ? "编辑服务配方" : "添加服务"}
      onClose={onClose}
      footer={
        <Button
          size="sm"
          variant="primary"
          onClick={async () => {
            try {
              await saveServiceRecipe({ environmentId, recipe: { id: recipeId, name, repo, runtime, startNote } });
              onClose();
              pushToast(existing ? "服务配方已更新（内存模拟）" : "服务配方已添加（内存模拟）");
            } catch (error) {
              pushToast(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          保存配方
        </Button>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="服务名称">
          <input
            aria-label="服务名称"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="rounded-md border border-line px-2 py-1.5 text-sm"
            placeholder="例如 saas-web"
          />
        </Field>
        <Field label="仓库（可空）">
          <input
            aria-label="配方仓库"
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
            className="rounded-md border border-line px-2 py-1.5 text-sm"
            placeholder="例如 front-monorepo"
          />
        </Field>
        <Field label="运行时">
          <select
            aria-label="配方运行时"
            value={runtime}
            onChange={(event) => setRuntime(event.target.value)}
            className="rounded-md border border-line px-2 py-1.5 text-sm"
          >
            <option>Node.js</option>
            <option>Go</option>
          </select>
        </Field>
        <Field label="启动方式说明">
          <input
            aria-label="启动方式"
            value={startNote}
            onChange={(event) => setStartNote(event.target.value)}
            className="rounded-md border border-line px-2 py-1.5 text-sm"
            placeholder="使用项目脚本启动"
          />
        </Field>
      </div>
      <p className="mt-3 text-[11px] text-muted">
        保存只写入内存模拟数据，不写入仓库默认配置也不启动进程；真实仓库扫描与配方转换属后续工单。
      </p>
    </Modal>
  );
}

function NewTaskModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const workspace = useHostStore((state) => state.workspace);
  const localSettings = useHostStore((state) => state.localSettings);
  const createTask = useHostStore((state) => state.createTask);
  const navigate = useNavigationStore((state) => state.navigate);
  const pushToast = useUiStore((state) => state.pushToast);
  const project = workspace?.projects.find((item) => item.id === projectId);
  const environments = (workspace?.environments ?? []).filter((item) => item.projectId === projectId);
  const [name, setName] = useState("");
  const [repos, setRepos] = useState<string[]>([]);
  const [directories, setDirectories] = useState<string[]>([]);
  const [environmentId, setEnvironmentId] = useState(environments[0]?.id ?? "");
  // The previewed key is handed to the adapter, so the shown pi working
  // directory is the one the created task actually gets (prototype's
  // `pendingWorkspaceKey`).
  const [workspaceKey] = useState(() => newWorkspaceKey());
  if (!project) return null;
  const root = localSettings?.workspaceRoot ?? "~/PiDockTasks";
  const workspacePreview = workspacePath(root, workspaceKey);
  return (
    <Modal
      title="新建任务"
      onClose={onClose}
      footer={
        <Button
          size="sm"
          variant="primary"
          onClick={async () => {
            try {
              const created = await createTask({ projectId, name, repoIds: repos, directoryIds: directories, environmentId, workspaceKey });
              onClose();
              navigate({ view: "task", projectId, taskId: created.id, sessionId: created.activeSessionId });
              pushToast("已在内存中创建任务；真实 worktree 准备属 03 工单");
            } catch (error) {
              pushToast(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          创建任务
        </Button>
      }
    >
      <Field label="任务名称" hint="显示名称可为中文；任务目录使用独立自动生成的英文数字标识">
        <input
          aria-label="任务名称"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="rounded-md border border-line px-2 py-1.5 text-sm"
          placeholder="例如 发布前检查"
        />
      </Field>
      <fieldset className="mt-3">
        <legend className="text-xs text-muted">Git 仓库</legend>
        <div className="mt-1.5 flex flex-col gap-1.5">
          {project.repositories.map((repository) => (
            <label key={repository.id} className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                aria-label={`仓库 ${repository.name}`}
                checked={repos.includes(repository.id)}
                onChange={(event) => setRepos((items) => (event.target.checked ? [...items, repository.id] : items.filter((id) => id !== repository.id)))}
              />
              <span>{repository.name}</span>
              <span className="text-muted">基线 {repository.baseBranch}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="mt-3">
        <legend className="text-xs text-muted">普通目录 · 通过软链接加入</legend>
        <div className="mt-1.5 flex flex-col gap-1.5">
          {project.directories.length === 0 ? <p className="text-[11px] text-muted">该项目还没有登记普通目录。</p> : null}
          {project.directories.map((directory) => (
            <label key={directory.id} className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                className="mt-0.5"
                aria-label={`任务目录 ${directory.name}`}
                checked={directories.includes(directory.id)}
                onChange={(event) =>
                  setDirectories((items) => (event.target.checked ? [...items, directory.id] : items.filter((id) => id !== directory.id)))
                }
              />
              <span>
                <strong className="block text-ink">{directory.name}</strong>
                <small className="font-mono text-[11px] text-muted">{directory.path}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <Field label="环境">
        <select
          aria-label="任务环境"
          value={environmentId}
          onChange={(event) => setEnvironmentId(event.target.value)}
          className="rounded-md border border-line px-2 py-1.5 text-xs"
        >
          {environments.map((environment) => (
            <option key={environment.id} value={environment.id}>
              {environment.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="mt-3 rounded-md border border-line bg-soft/40 px-3 py-2 text-xs" data-testid="workspace-preview">
        <div className="flex items-center justify-between gap-2">
          <strong className="text-ink">任务文件夹 · pi 工作目录</strong>
          <span className="text-[11px] text-muted">自动生成 · 英文与数字</span>
        </div>
        <code className="mt-1 block break-all font-mono text-[11px] text-ink" data-testid="workspace-preview-path">
          {workspacePreview}
        </code>
        <ul className="mt-2 flex flex-col gap-1 text-[11px] text-muted">
          {repos.map((repoId) => {
            const repository = project.repositories.find((item) => item.id === repoId);
            if (!repository) return null;
            return (
              <li key={repoId}>
                <span className="text-ink">{repository.name}</span> · worktree
                <code className="ml-2 break-all font-mono">{workspacePath(root, workspaceKey, repository.name)}</code>
              </li>
            );
          })}
          {directories.map((directoryId) => {
            const directory = project.directories.find((item) => item.id === directoryId);
            if (!directory) return null;
            return (
              <li key={directoryId}>
                <span className="text-ink">{directory.name}</span> · 软链接 · 修改影响原目录
                <code className="ml-2 break-all font-mono" data-testid={`preview-link-${directory.id}`}>
                  {workspacePath(root, workspaceKey, directoryLinkName(directory))}
                </code>
                <span className="ml-1 break-all">→ {directory.path}</span>
              </li>
            );
          })}
        </ul>
        {repos.length === 0 && directories.length === 0 ? (
          <p className="mt-1 text-[11px] text-muted">请选择本次需要的仓库或普通目录。</p>
        ) : null}
        <p className="mt-2 text-[11px] text-muted">
          pi 从此目录启动，通过子目录访问 worktree 和普通目录。名称仅作显示，不影响路径。
        </p>
      </div>
    </Modal>
  );
}
