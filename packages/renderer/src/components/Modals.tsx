import { useMemo, useState } from "react";
import { Badge, Button, EmptyState, Field, Modal, Segmented } from "./ui";
import { VirtualList } from "./VirtualList";
import { runStateLabel } from "../pages/runState";
import { diffConfigRows, isSensitiveKey, nextTemplateVersion } from "../data/configRows";
import { capabilityInvalidReason, isCapabilityEnabled, mcpBridgeStatus, mcpConnectionLabel, packageVersionState, sourceKindLabel } from "../data/capabilityRules";
import { referenceProvenance, skillCandidate } from "../data/composerRules";
import {
  buildTaskFormBranch,
  checkTaskFormDirIdConflict,
  directoryLinkName,
  isTaskDirId,
  newWorkspaceKey,
  pinTaskFormBaseline,
  previewTaskFormPaths,
  resolveTaskFormRoot,
  validateTaskFormName,
  workspacePath,
} from "../data/directories";
import { isShellConnected, provisionTaskThroughShell } from "../data/shellBridge";
import {
  CONTEXT_WINDOW_SOURCE_LABEL,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  REASONING_LEVELS,
  buildModelPickerGroups,
  connectionFingerprint,
  contextWindowSourceOf,
  describeContextDisplay,
  describeHistoryAttribution,
  evaluateThinkingSelection,
  firstSelectablePickerIndex,
  flattenPickerGroups,
  followModelName,
  followModelNameOnIdChange,
  formatTokens,
  modelDisplayName,
  movePickerCursor,
  resolveSessionThinking,
  validateProviderDraft,
} from "../data/providerState";
import { cleanupReceiptLines, cleanupRecoveryLines, cleanupRemovesUnselectedRecords, cleanupRows } from "../data/taskLifecycle";
import type { CapabilityFailureCode, CapabilitySourceKind, CleanupItem, CleanupRunResult, CleanupSelection, ConfigEntry, ContextWindowSource, ModelThinking, Permission, ProjectDirectory, Task } from "../data/types";
import { sessionWriteRoleLabel, type SessionWriteState } from "../data/writeCoordination";
import { useDraftStore } from "../stores/drafts";
import { useEnvDraftStore } from "../stores/envDrafts";
import { useHostStore } from "../stores/host";
import { useNavigationStore } from "../stores/navigation";
import { useUiStore } from "../stores/ui";
import { useWriteLockStore } from "../stores/writeLock";

/**
 * Recent-activity readout for the session list ([PiDock 09] #11 收口: 状态与最近活动).
 * The stored value is an ISO timestamp; the list shows a short local time.
 */
function formatSessionActivity(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "未知";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** Coordination role of one session in the list ([PiDock 09] #11 box 2). */
function SessionRoleBadge({ state }: { state?: SessionWriteState }) {
  const label = state ? sessionWriteRoleLabel(state) : null;
  if (label === null) return null;
  return <Badge tone={state?.role === "owner" ? "accent" : "warn"}>{label}</Badge>;
}

export function Modals() {
  const modal = useUiStore((state) => state.modal);
  const closeModal = useUiStore((state) => state.closeModal);
  const pushToast = useUiStore((state) => state.pushToast);
  const workspace = useHostStore((state) => state.workspace);
  const tasks = workspace?.tasks ?? [];
  const [sessionFilter, setSessionFilter] = useState<"active" | "archived">("active");
  const [sessionSearch, setSessionSearch] = useState("");
  // [PiDock 14] (#17) cleanup state: the preview rows the Host returned for the
  // current export selection, and the receipt/recovery of a completed run.
  const [cleanup, setCleanup] = useState<{ items: CleanupItem[]; selection: CleanupSelection; result: CleanupRunResult | null } | null>(null);
  const [cleanupSelection, setCleanupSelection] = useState<CleanupSelection>({ exportSessions: false, exportDrafts: false, exportUsage: false });
  const [cleanupError, setCleanupError] = useState<string | null>(null);

  const task = modal && "taskId" in modal ? tasks.find((item) => item.id === modal.taskId) : undefined;

  // [PiDock 09] (#11) session navigation readout: the coordination role of each
  // session (holder / queue position / read-only) next to its run state, last
  // activity and unread count. `task` may be undefined before the modal opens.
  const sessionRoles = useWriteLockStore((state) => (task ? state.views[task.id]?.sessions : undefined));

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
                    {session.archived ? "已归档" : "未归档"} · {session.permission === "read" ? "只读" : "可对话"} · 最近活动{" "}
                    {formatSessionActivity(session.lastActivity)}
                    {session.unread > 0 ? ` · ${session.unread} 条未读` : ""}
                  </small>
                </button>
                <div className="flex items-center gap-1.5">
                  <SessionRoleBadge state={sessionRoles?.find((item) => item.sessionId === session.id)} />
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
    const counts = {
      sessions: task.sessions.length,
      drafts: task.sessions.filter((session) => session.messages.some((message) => message.role === "user")).length,
    };
    const removesUnselected = cleanup !== null && cleanupRemovesUnselectedRecords(cleanup.selection, { ...counts, usage: 0 });
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
                  .loadCleanupPreview(task.id, cleanupSelection)
                  .then((items) => setCleanup({ items, selection: cleanupSelection, result: null }))
                  .catch((error: unknown) => setCleanupError(error instanceof Error ? error.message : String(error)));
              }}
            >
              生成清单
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={cleanup === null}
              onClick={() => {
                const current = cleanup;
                if (current === null) return;
                void useHostStore
                  .getState()
                  .runCleanup(task.id, current.selection)
                  .then((result) => {
                    setCleanup({ ...current, result });
                    if (result.receipt?.partialFailure) {
                      pushToast("清理局部失败：保留任务登记与逐项恢复入口，可在归档页查看");
                    } else {
                      pushToast("清理完成：保留位置与回执已记录");
                    }
                  })
                  .catch((error: unknown) => {
                    const message = error instanceof Error ? error.message : String(error);
                    setCleanupError(message);
                    pushToast(`清理未执行：${message}`);
                  });
              }}
            >
              确认执行清理
            </Button>
          </>
        }
      >
        <p className="text-xs text-muted">
          选择要导出的记录（先导出并核验，再移除）。未选择的记录会随清理移除；工作副本与原目录始终保留，只解除关联。
        </p>
        <div className="mt-2 flex flex-wrap gap-3 text-xs">
          {(
            [
              ["exportSessions", "导出会话"],
              ["exportDrafts", "导出草稿"],
              ["exportUsage", "导出用量"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={cleanupSelection[key]}
                onChange={(event) => setCleanupSelection({ ...cleanupSelection, [key]: event.target.checked })}
              />
              {label}
            </label>
          ))}
        </div>
        {removesUnselected ? (
          <p className="mt-2 text-[11px] text-orange">未选择导出的会话／草稿记录将被移除；清理不是归档恢复，移除后不再保留这些记录。</p>
        ) : null}
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
              {cleanupRows(cleanup.items).map((row) => (
                <tr key={row.key} className="border-t border-line">
                  <td className="py-1.5 pr-2 text-ink">{row.resource}</td>
                  <td className="py-1.5 pr-2">{row.action}</td>
                  <td className="py-1.5 text-muted">{row.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {cleanup?.result ? (
          <div className="mt-3 text-xs">
            <p className="text-ink">{cleanup.result.error ? `未完成：${cleanup.result.error}` : "清理回执"}</p>
            <ul className="mt-1 flex flex-col gap-0.5 text-muted">
              {cleanup.result.receipt ? cleanupReceiptLines(cleanup.result.receipt).map((line) => <li key={line}>{line}</li>) : null}
              {cleanupRecoveryLines(cleanup.result.recovery).map((line) => <li key={line}>{line}</li>)}
            </ul>
            <p className="mt-1 text-[11px] text-muted">未交付代码与未推送提交采用保留独立副本的保守路径；清理永不清零或改写其他任务的 Token 统计。</p>
          </div>
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

  if (modal.type === "provider-edit") {
    return <ProviderEditModal providerId={modal.providerId} onClose={closeModal} />;
  }

  if (modal.type === "project-list") {
    return <ProjectListModal onClose={closeModal} />;
  }

  if (modal.type === "project-edit") {
    return <ProjectEditModal projectId={modal.projectId} onClose={closeModal} />;
  }

  if (modal.type === "project-delete") {
    return <ProjectDeleteModal projectId={modal.projectId} onClose={closeModal} />;
  }

  if (modal.type === "environment-list") {
    return <EnvironmentListModal projectId={modal.projectId} onClose={closeModal} />;
  }

  if (modal.type === "environment-edit") {
    return <EnvironmentEditModal projectId={modal.projectId} environmentId={modal.environmentId} onClose={closeModal} />;
  }

  if (modal.type === "environment-delete") {
    return <EnvironmentDeleteModal environmentId={modal.environmentId} onClose={closeModal} />;
  }

  if (modal.type === "add-capability") {
    return <AddCapabilityModal kind={modal.kind} onClose={closeModal} />;
  }

  if (modal.type === "schedule-edit") {
    return <ScheduleEditModal scheduleId={modal.scheduleId} onClose={closeModal} />;
  }

  if (modal.type === "permission") {
    return <PermissionModal taskId={modal.taskId} sessionId={modal.sessionId} onClose={closeModal} />;
  }

  if (modal.type === "model-picker") {
    return <ModelPickerModal taskId={modal.taskId} sessionId={modal.sessionId} onClose={closeModal} />;
  }

  if (modal.type === "thinking-picker") {
    return <ThinkingPickerModal taskId={modal.taskId} sessionId={modal.sessionId} onClose={closeModal} />;
  }

  if (modal.type === "context") {
    return <ContextModal taskId={modal.taskId} sessionId={modal.sessionId} onClose={closeModal} />;
  }

  if (modal.type === "capability-detail") {
    return <CapabilityDetailModal capabilityId={modal.capabilityId} onClose={closeModal} />;
  }

  if (modal.type === "retry") {
    return <RetryModal taskId={modal.taskId} sessionId={modal.sessionId} onClose={closeModal} />;
  }

  if (modal.type === "remote-preview") {
    return <RemotePreviewModal onClose={closeModal} />;
  }

  if (modal.type === "repo-binding") {
    return <RepoBindingModal onClose={closeModal} />;
  }

  if (modal.type === "delivery" && task) {
    return <DeliveryModal task={task} onClose={closeModal} />;
  }

  if (modal.type === "composer-info" && task) {
    return <ComposerInfoModal task={task} topic={modal.topic} onClose={closeModal} />;
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

  if (modal.type === "task-sources") {
    if (!task) return null;
    return <TaskSourcesModal taskId={task.id} onClose={closeModal} />;
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

function TaskSourcesModal({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const workspace = useHostStore((state) => state.workspace);
  const addTaskSources = useHostStore((state) => state.addTaskSources);
  const pushToast = useUiStore((state) => state.pushToast);
  const task = workspace?.tasks.find((item) => item.id === taskId);
  const project = workspace?.projects.find((item) => item.id === task?.projectId);
  const [repos, setRepos] = useState<string[]>([]);
  const [directories, setDirectories] = useState<string[]>(() => (task?.directories ?? []).map((directory) => directory.id));
  if (!task || !project) return null;
  const existingRepos = new Set(task.repos);
  const existingDirectories = new Set(task.directories.map((directory) => directory.id));
  return (
    <Modal
      title="添加仓库或目录"
      onClose={onClose}
      footer={
        <Button
          size="sm"
          variant="primary"
          onClick={async () => {
            if (repos.length === 0 && directories.length === (task.directories?.length ?? 0)) {
              pushToast("请选择要追加的仓库或目录");
              return;
            }
            try {
              await addTaskSources(taskId, { repoIds: repos, directoryIds: directories });
              onClose();
              pushToast("任务来源已更新；已有链接与 worktree 保留（内存模拟）");
            } catch (error) {
              pushToast(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          获取最新基线并添加
        </Button>
      }
    >
      <p className="text-xs text-muted">
        Git 仓库建立独立工作副本，普通目录通过软链接加入任务目录；沿用当前任务文件夹。
      </p>
      <fieldset className="mt-3">
        <legend className="text-xs text-muted">选择代码仓库 · 远程基线分支</legend>
        <div className="mt-1.5 flex flex-col gap-1.5">
          {project.repositories.length === 0 ? <p className="text-[11px] text-muted">该项目还没有关联仓库。</p> : null}
          {project.repositories.map((repository) => {
            const added = existingRepos.has(repository.id);
            return (
              <label key={repository.id} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  aria-label={`任务仓库 ${repository.name}`}
                  checked={added || repos.includes(repository.id)}
                  disabled={added}
                  onChange={(event) =>
                    setRepos((items) => (event.target.checked ? [...items, repository.id] : items.filter((id) => id !== repository.id)))
                  }
                />
                <span>{repository.name}</span>
                <span className="text-muted">基线 {repository.baseBranch}{added ? " · 已加入" : ""}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <fieldset className="mt-3">
        <legend className="text-xs text-muted">普通目录 · 通过软链接加入</legend>
        <div className="mt-1.5 flex flex-col gap-2">
          {project.directories.length === 0 ? <EmptyState>该项目还没有登记普通目录。</EmptyState> : null}
          {project.directories.map((directory) => {
            const added = existingDirectories.has(directory.id);
            return (
              <label key={directory.id} className="flex items-start gap-2 rounded-md border border-line px-2.5 py-2 text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  aria-label={`任务目录 ${directory.name}`}
                  checked={directories.includes(directory.id)}
                  disabled={added}
                  onChange={(event) =>
                    setDirectories((items) =>
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
      </fieldset>
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
  const [runType, setRunType] = useState(existing?.runType ?? "常驻服务");
  const [healthCheck, setHealthCheck] = useState(existing?.healthCheck ?? "HTTP");
  const [dependencyBinding, setDependencyBinding] = useState(existing?.dependencyBinding ?? "");
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
              await saveServiceRecipe({
                environmentId,
                recipe: { id: recipeId, name, repo, runtime, startNote, runType, healthCheck, dependencyBinding },
              });
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
        <Field label="运行类型">
          <select
            aria-label="运行类型"
            value={runType}
            onChange={(event) => setRunType(event.target.value)}
            className="rounded-md border border-line px-2 py-1.5 text-sm"
          >
            <option>常驻服务</option>
            <option>准备步骤</option>
            <option>一次性命令</option>
          </select>
        </Field>
        <Field label="健康检查">
          <select
            aria-label="健康检查"
            value={healthCheck}
            onChange={(event) => setHealthCheck(event.target.value)}
            className="rounded-md border border-line px-2 py-1.5 text-sm"
          >
            <option>gRPC health</option>
            <option>HTTP</option>
            <option>TCP</option>
          </select>
        </Field>
        <Field label="依赖地址绑定">
          <input
            aria-label="依赖地址绑定"
            value={dependencyBinding}
            onChange={(event) => setDependencyBinding(event.target.value)}
            className="rounded-md border border-line px-2 py-1.5 text-sm"
            placeholder="选择依赖服务与环境变量"
          />
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
  const [failedTaskId, setFailedTaskId] = useState<string | null>(null);
  // [PiDock 02] P1-1 fail-fast needs the used dir ids; `tasks` here is the
  // sibling-modal name in this file, so the form uses its own binding.
  // S5 P2-2: exclude the just-failed task so retry does not self-conflict.
  // (state is declared above because `existingDirIds` reads it.)
  // [PiDock 02] S5 P2-2: the id of a memory task whose bridged provision
  // just failed. Its own `workspaceKey` is excluded from the dir-id
  // conflict check so a second submit retries instead of failing
  // `identifier-conflict` against itself.
  const existingDirIds = (workspace?.tasks ?? [])
    .filter((item) => item.id !== failedTaskId)
    .map((item) => item.workspaceKey);
  const environments = (workspace?.environments ?? []).filter((item) => item.projectId === projectId);
  const providers = workspace?.providers ?? [];
  const templates = workspace?.templates ?? [];
  const [name, setName] = useState("");
  const [repos, setRepos] = useState<string[]>([]);
  const [directories, setDirectories] = useState<string[]>([]);
  const [environmentId, setEnvironmentId] = useState(environments[0]?.id ?? "");
  const [taskType, setTaskType] = useState<"normal" | "scheduled">("normal");
  const [scheduleRule, setScheduleRule] = useState("");
  const [schedulePrompt, setSchedulePrompt] = useState("");
  const [scheduleTemplateId, setScheduleTemplateId] = useState("");
  const [scheduleModelKey, setScheduleModelKey] = useState(`${providers[0]?.id ?? ""}:${providers[0]?.models[0]?.id ?? ""}`);
  const [schedulePermission, setSchedulePermission] = useState<Permission>("default");
  // The previewed key is handed to the adapter, so the shown pi working
  // directory is the one the created task actually gets (prototype's
  // `pendingWorkspaceKey`). [PiDock 02]: the same key doubles as the
  // shell-side `dirId` (`task-oooooooo`), and the editable branch defaults
  // to `task/<dirId>` via `buildTaskFormBranch` (same rule as the Host).
  const [workspaceKey, setWorkspaceKey] = useState(() => newWorkspaceKey());
  const [branchInput, setBranchInput] = useState("");
  const [rootOverride, setRootOverride] = useState("");
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [remoteBranch, setRemoteBranch] = useState("");
  const [fetchedCommit, setFetchedCommit] = useState("");
  const [formError, setFormError] = useState("");
  const [provisioning, setProvisioning] = useState(false);
  if (!project) return null;
  const defaultRoot = localSettings?.workspaceRoot ?? "~/PiDockTasks";
  // Per-creation override wins for this task only; the stored task keeps
  // the resolved root so a later default change never migrates it.
  const effectiveRootInput = overrideEnabled && rootOverride.trim() ? rootOverride : defaultRoot;
  const resolvedRoot = resolveTaskFormRoot(defaultRoot, overrideEnabled ? rootOverride || defaultRoot : undefined);
  const branchResult = buildTaskFormBranch(workspaceKey, branchInput);
  const branchPreview = branchResult.ok ? branchResult.branch : `task/${workspaceKey}`;
  // Live path preview: what the form shows is what the task stores. Repo
  // names come from the selected project repos; directory link names use
  // the same stable `dir-xxxxxxxx` rule as the created task.
  let pathPreview: { taskDir: string; worktrees: Record<string, string>; links: Record<string, string> } | null = null;
  let pathPreviewError = "";
  if (resolvedRoot.ok && isTaskDirId(workspaceKey)) {
    try {
      const repoNames = project.repositories.filter((r) => repos.includes(r.id)).map((r) => r.name);
      const linkNames = project.directories
        .filter((d) => directories.includes(d.id))
        .map((d) => directoryLinkName(d));
      pathPreview = previewTaskFormPaths(resolvedRoot.root, workspaceKey, repoNames, linkNames);
    } catch (error) {
      pathPreviewError = error instanceof Error ? error.message : String(error);
    }
  }
  const workspacePreview = pathPreview?.taskDir ?? workspacePath(effectiveRootInput, workspaceKey);
  const [scheduleProviderId, scheduleModel] = scheduleModelKey.split(":");
  const applyTemplate = () => {
    const template = templates.find((item) => item.id === scheduleTemplateId);
    if (!template) {
      pushToast("请选择一个常用模板");
      return;
    }
    if (!name.trim()) setName(template.name);
    setScheduleRule(template.rule);
    setSchedulePrompt(template.prompt);
  };
  return (
    <Modal
      title="新建任务"
      onClose={onClose}
      footer={
        <div className="flex items-center gap-2">
          {formError ? (
            <span role="alert" className="text-[11px] text-orange">
              {formError}
            </span>
          ) : null}
          <Button
            size="sm"
            variant="primary"
            disabled={provisioning}
            aria-label={provisioning ? "正在创建任务" : "创建任务"}
            onClick={async () => {
              // [PiDock 02]: validate locally first (same rules as the Host),
              // then create + provision. Any failure keeps the form with a
              // retry entry — never a crash, never a create from stale ref.
              const named = validateTaskFormName(name);
              if (!named.ok) {
                setFormError(named.error.message);
                pushToast(named.error.message);
                return;
              }
              if (!resolvedRoot.ok) {
                setFormError(resolvedRoot.error.message);
                pushToast(resolvedRoot.error.message);
                return;
              }
              if (!branchResult.ok) {
                setFormError(branchResult.error.message);
                pushToast(branchResult.error.message);
                return;
              }
              // [PiDock 02] P1-1: run the same pure rules the Host
              // enforces before the task exists, so a duplicate
              // directory id, a malformed id, or a missing baseline
              // fails fast locally with the form kept — never an orphan
              // memory task followed by a late shell-provision error.
              if (!isTaskDirId(workspaceKey)) {
                const message = "任务目录标识格式不正确，请重新生成";
                setFormError(message);
                pushToast(message);
                return;
              }
              const dirIdConflict = checkTaskFormDirIdConflict(
                workspaceKey,
                existingDirIds,
              );
              if (dirIdConflict) {
                setFormError(dirIdConflict.message);
                pushToast(dirIdConflict.message);
                return;
              }
              const pinned = pinTaskFormBaseline(remoteBranch, fetchedCommit);
              if (!pinned.ok) {
                setFormError(pinned.error.message);
                pushToast(pinned.error.message);
                return;
              }
              setFormError("");
              setProvisioning(true);
              try {
                // S5 P2-2: a retry after a bridged provision failure reuses
                // the just-created memory task when the key is unchanged,
                // so the second submit provisions instead of creating a
                // duplicate task (or self-conflicting on its own key). A
                // changed key (after 换标识) creates fresh as usual.
                const retryTask = failedTaskId
                  ? useHostStore.getState().workspace?.tasks.find((item) => item.id === failedTaskId)
                  : undefined;
                const created =
                  retryTask && retryTask.workspaceKey === workspaceKey
                    ? retryTask
                    : await createTask({
                        projectId,
                        name: named.name,
                        repoIds: repos,
                        directoryIds: directories,
                        environmentId,
                        workspaceKey,
                        schedule:
                          taskType === "scheduled"
                            ? {
                                rule: scheduleRule,
                                timezone: "Asia/Shanghai",
                                prompt: schedulePrompt,
                                providerId: scheduleProviderId,
                                model: scheduleModel,
                                permission: schedulePermission,
                              }
                            : undefined,
                      });
                if (!retryTask) setFailedTaskId(null);
                // [PiDock 02] P1-2: the renderer creates the memory id and
                // the `task-oooooooo` dir id together and uses the dir id
                // as the shell-side task id (exact `taskId === dirId`
                // match the bootstrap accepts), so bridged provision never
                // fails closed with `unknown task` on memory-style ids.
                // P1-3: baseline is pinned locally above, so provision
                // always runs when bridged — a fetch failure already kept
                // the form instead of skipping to a no-op success that
                // leaves the shell `unknown task`.
                if (isShellConnected()) {
                  const provisioned = await provisionTaskThroughShell({
                    taskId: workspaceKey,
                    name: named.name,
                    dirId: workspaceKey,
                    branch: branchInput.trim() || undefined,
                    rootOverride: overrideEnabled && rootOverride.trim() ? rootOverride.trim() : undefined,
                    remoteBranch: pinned.remoteBranch,
                    fetchedCommit: pinned.commit,
                    repos: project.repositories.filter((r) => repos.includes(r.id)).map((r) => r.name),
                  });
                  if (!provisioned.ok) {
                    // Fetch/provision failure keeps the form + retry entry:
                    // the created task stays (with its stored actual root),
                    // the dialog stays open, and the error binds to the form.
                    // S5 P2-2: remember it so the retry submit excludes its
                    // own key from the conflict check instead of blocking.
                    setFailedTaskId(created.id);
                    setFormError(provisioned.error ?? "任务准备失败，已保留表单，请重试");
                    pushToast(provisioned.error ?? "任务准备失败，已保留表单，请重试");
                    return;
                  }
                }
                onClose();
                navigate({ view: "task", projectId, taskId: created.id, sessionId: created.activeSessionId });
                pushToast(
                  taskType === "scheduled"
                    ? "已创建定时任务；每次触发新建独立会话"
                    : "已在内存中创建任务；真实 worktree 准备属 03 工单",
                );
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                setFormError(message);
                pushToast(message);
              } finally {
                setProvisioning(false);
              }
            }}
          >
            {provisioning ? "创建中…" : "创建任务"}
          </Button>
        </div>
      }
    >
      <fieldset>
        <legend className="text-xs text-muted">任务类型</legend>
        <div className="mt-1.5 flex gap-3 text-xs">
          {([
            ["normal", "普通任务"],
            ["scheduled", "定时任务"],
          ] as const).map(([value, label]) => (
            <label key={value} className="flex items-center gap-1.5">
              <input
                type="radio"
                name="task-type"
                aria-label={label}
                checked={taskType === value}
                onChange={() => setTaskType(value)}
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
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
      {taskType === "scheduled" ? (
        <fieldset className="mt-3 rounded-md border border-line px-3 py-3">
          <legend className="text-xs text-muted">定时设置</legend>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-1 flex-col gap-1 text-xs text-muted">
              常用模板 · 可选
              <select
                aria-label="常用模板"
                value={scheduleTemplateId}
                onChange={(event) => setScheduleTemplateId(event.target.value)}
                className="rounded-md border border-line px-2 py-1.5 text-xs"
              >
                <option value="">自定义 · 从空白开始</option>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name} · {template.rule}
                  </option>
                ))}
              </select>
            </label>
            <Button size="sm" onClick={applyTemplate}>
              使用模板
            </Button>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="执行周期">
              <input
                aria-label="执行周期"
                value={scheduleRule}
                onChange={(event) => setScheduleRule(event.target.value)}
                className="rounded-md border border-line px-2 py-1.5 text-sm"
                placeholder="例如：每周五 15:00"
              />
            </Field>
            <Field label="Provider / 模型">
              <select
                aria-label="定时任务模型"
                value={scheduleModelKey}
                onChange={(event) => setScheduleModelKey(event.target.value)}
                className="rounded-md border border-line px-2 py-1.5 text-sm"
              >
                {providers.flatMap((provider) =>
                  provider.models.map((item) => (
                    <option key={`${provider.id}:${item.id}`} value={`${provider.id}:${item.id}`} disabled={!provider.enabled}>
                      {provider.name} / {item.name ?? item.id}
                    </option>
                  )),
                )}
              </select>
            </Field>
            <Field label="新会话权限">
              <select
                aria-label="定时任务权限"
                value={schedulePermission}
                onChange={(event) => setSchedulePermission(event.target.value as Permission)}
                className="rounded-md border border-line px-2 py-1.5 text-sm"
              >
                <option value="read">只读</option>
                <option value="default">默认权限 · 需要时等待确认</option>
                <option value="auto">自动执行</option>
              </select>
            </Field>
          </div>
          <div className="mt-3">
            <Field label="提示词">
              <textarea
                aria-label="定时任务提示词"
                rows={4}
                value={schedulePrompt}
                onChange={(event) => setSchedulePrompt(event.target.value)}
                className="w-full rounded-md border border-line px-2 py-1.5 text-xs"
                placeholder="包括要处理的内容，以及如何保存、发送或使用结果"
              />
            </Field>
          </div>
          <p className="mt-2 text-[11px] text-muted">每次触发在当前任务中创建新的独立会话；历史会话可查看并继续对话。</p>
        </fieldset>
      ) : null}
      <Field label="任务分支" hint="独立于显示名称与目录标识保存；默认 task/<目录标识>，可按需修改">
        <div className="flex gap-2">
          <input
            aria-label="任务分支"
            value={branchInput}
            onChange={(event) => setBranchInput(event.target.value)}
            className="flex-1 rounded-md border border-line px-2 py-1.5 font-mono text-xs"
            placeholder={branchPreview}
          />
          <Button
            size="sm"
            variant="ghost"
            aria-label="重新生成目录标识"
            title="重新生成目录标识（分支默认随之更新）"
            onClick={() => {
              setWorkspaceKey(newWorkspaceKey());
              setBranchInput("");
            }}
          >
            换标识
          </Button>
        </div>
        {!branchResult.ok ? (
          <span role="alert" className="text-[11px] text-orange">{branchResult.error.message}</span>
        ) : (
          <span className="text-[11px] text-muted">实际分支：<code className="font-mono">{branchPreview}</code></span>
        )}
      </Field>
      <Field label="任务根目录" hint="默认取本机设置；勾选覆盖仅作用于本次新建，已有任务不迁移">
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              aria-label="单次覆盖默认根目录"
              checked={overrideEnabled}
              onChange={(event) => setOverrideEnabled(event.target.checked)}
            />
            单次覆盖默认根目录
          </label>
          {overrideEnabled ? (
            <input
              aria-label="单次任务根目录"
              value={rootOverride}
              onChange={(event) => setRootOverride(event.target.value)}
              className="rounded-md border border-line px-2 py-1.5 font-mono text-xs"
              placeholder={defaultRoot}
            />
          ) : null}
          {!resolvedRoot.ok ? (
            <span role="alert" className="text-[11px] text-orange">{resolvedRoot.error.message}</span>
          ) : (
            <span className="text-[11px] text-muted">
              实际根目录：<code className="font-mono">{resolvedRoot.root}</code>
              {resolvedRoot.overridden ? " · 本次覆盖" : " · 默认"}
            </span>
          )}
        </div>
      </Field>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="远程基线分支" hint="创建前获取并固定提交；失败保留表单">
          <input
            aria-label="远程基线分支"
            value={remoteBranch}
            onChange={(event) => setRemoteBranch(event.target.value)}
            className="rounded-md border border-line px-2 py-1.5 font-mono text-xs"
            placeholder="例如 origin/main"
          />
        </Field>
        <Field label="基线提交" hint="留空表示尚未获取；提交后固定此次提交">
          <input
            aria-label="基线提交"
            value={fetchedCommit}
            onChange={(event) => setFetchedCommit(event.target.value)}
            className="rounded-md border border-line px-2 py-1.5 font-mono text-xs"
            placeholder="例如 9acb5b6（7–40 位十六进制）"
          />
        </Field>
      </div>
      <div className="mt-3 rounded-md border border-line bg-soft/40 px-3 py-2 text-xs" data-testid="workspace-preview">
        <div className="flex items-center justify-between gap-2">
          <strong className="text-ink">任务文件夹 · pi 工作目录</strong>
          <span className="text-[11px] text-muted">自动生成 · 英文与数字</span>
        </div>
        <code className="mt-1 block break-all font-mono text-[11px] text-ink" data-testid="workspace-preview-path">
          {workspacePreview}
        </code>
        {pathPreviewError ? (
          <p role="alert" className="mt-1 text-[11px] text-orange">{pathPreviewError}</p>
        ) : null}
        <ul className="mt-2 flex flex-col gap-1 text-[11px] text-muted">
          {repos.map((repoId) => {
            const repository = project.repositories.find((item) => item.id === repoId);
            if (!repository) return null;
            return (
              <li key={repoId}>
                <span className="text-ink">{repository.name}</span> · worktree
                <code className="ml-2 break-all font-mono">{pathPreview?.worktrees[repository.name] ?? workspacePath(effectiveRootInput, workspaceKey, repository.name)}</code>
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
                  {pathPreview?.links[directoryLinkName(directory)] ?? workspacePath(effectiveRootInput, workspaceKey, directoryLinkName(directory))}
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

const PERMISSION_TIERS: { id: Permission; name: string; description: string }[] = [
  { id: "read", name: "只读", description: "阅读任务文件、分析和回答问题；不修改文件，不执行命令或浏览器操作。" },
  { id: "default", name: "默认权限", description: "允许任务内文件读写；执行命令或操作浏览器前询问。" },
  { id: "auto", name: "自动执行", description: "允许任务内文件读写、命令和浏览器操作，无需逐次询问。" },
];

function PermissionModal({ taskId, sessionId, onClose }: { taskId: string; sessionId: string; onClose: () => void }) {
  const session = useHostStore((state) => state.session(taskId, sessionId));
  const setSessionPermission = useHostStore((state) => state.setSessionPermission);
  const pushToast = useUiStore((state) => state.pushToast);
  if (!session) return null;
  return (
    <Modal title="会话权限" onClose={onClose}>
      <p className="text-xs text-muted">
        {session.name} · 仅当前会话。所有档位均遵循任务范围与共享模板变更确认规则；选择用于后续请求，已启动的 Subagent 保留启动时权限。
      </p>
      <div className="mt-3 flex flex-col gap-2">
        {PERMISSION_TIERS.map((tier) => (
          <button
            key={tier.id}
            type="button"
            aria-pressed={session.permission === tier.id}
            data-testid={`permission-${tier.id}`}
            onClick={async () => {
              await setSessionPermission(taskId, sessionId, tier.id);
              onClose();
              pushToast(`当前会话已选择${tier.name}，用于后续请求`);
            }}
            className={`rounded-md border px-3 py-2 text-left text-xs ${
              session.permission === tier.id ? "border-accent/40 bg-accent/10 text-accent" : "border-line text-ink hover:bg-soft"
            }`}
          >
            <strong className="block">{tier.name}</strong>
            <small className="text-muted">{tier.description}</small>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function ModelPickerModal({ taskId, sessionId, onClose }: { taskId: string; sessionId: string; onClose: () => void }) {
  const workspace = useHostStore((state) => state.workspace);
  const session = useHostStore((state) => state.session(taskId, sessionId));
  const setSessionModel = useHostStore((state) => state.setSessionModel);
  const pushToast = useUiStore((state) => state.pushToast);
  const navigate = useNavigationStore((state) => state.navigate);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const providers = useMemo(() => workspace?.providers ?? [], [workspace]);
  const busyLabel = session?.runState === "approval" ? "等待确认中" : session?.runState === "running" ? "回合或工具执行中" : null;
  const groups = useMemo(
    () =>
      buildModelPickerGroups({
        providers,
        query,
        ...(session ? { currentProviderId: session.providerId, currentModelId: session.model } : {}),
        contextUsed: session?.contextUsed ?? 0,
        contextSource: session?.contextSource ?? "actual",
      }),
    [providers, query, session],
  );
  const rows = useMemo(() => flattenPickerGroups(groups), [groups]);
  if (!session) return null;
  const currentProvider = providers.find((provider) => provider.id === session.providerId);
  const currentModel = currentProvider?.models.find((model) => model.id === session.model);
  const attribution = describeHistoryAttribution(providers, { providerId: session.providerId, model: session.model });
  const display = describeContextDisplay({ used: session.contextUsed, window: session.contextWindow, source: session.contextSource ?? "actual" });
  const select = async (providerId: string, modelId: string) => {
    try {
      await setSessionModel(taskId, sessionId, providerId, modelId);
      onClose();
      pushToast(`当前会话已选择 ${modelId}；历史与累累计 Token 保留，并记录本次切换事件`);
    } catch (error) {
      // Refusals (busy round / over-limit / stale occupancy) leave the model,
      // history and draft untouched; the popover stays open to pick another.
      pushToast(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <Modal title="选择 Provider 与模型" onClose={onClose}>
      <p className="text-xs text-muted">
        按 Provider 分组切换；搜索支持 Provider 名称/ID 与模型 ID/显示名称。只改当前会话对后续请求的归属。
      </p>
      {busyLabel ? <p className="mt-2 text-[11px] text-orange" role="status">当前{busyLabel}，请先等待完成或停止执行后再切换。</p> : null}
      <input
        aria-label="搜索模型"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setCursor(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setCursor((index) => movePickerCursor(rows.length, index, 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setCursor((index) => movePickerCursor(rows.length, index, -1));
          } else if (event.key === "Home") {
            event.preventDefault();
            setCursor(firstSelectablePickerIndex(rows));
          } else if (event.key === "End") {
            event.preventDefault();
            setCursor(rows.length - 1);
          } else if (event.key === "Enter") {
            event.preventDefault();
            const row = rows[cursor];
            if (row && row.model.disabledReason === undefined) void select(row.group.providerId, row.model.id);
          }
        }}
        placeholder="搜索 Provider 或模型"
        className="mt-3 w-full rounded-md border border-line px-2 py-1.5 text-xs"
      />
      <div aria-label="可选模型" className="mt-2 flex max-h-72 flex-col gap-3 overflow-auto">
        {groups.length === 0 ? <p className="text-xs text-muted">没有匹配的 Provider 或模型。</p> : null}
        {groups.map((group) => (
          <div key={group.providerId} data-testid={`picker-group-${group.providerId}`}>
            <div className="flex items-center justify-between text-xs">
              <strong className="text-ink">{group.providerName}</strong>
              <span className="text-muted">
                {group.protocol}
                {group.enabled ? "" : " · 已停用"}
                {group.availability === "model-unavailable" ? " · 模型不可用" : ""}
              </span>
            </div>
            <div className="mt-1.5 flex flex-col gap-1.5">
              {group.models.map((model) => {
                const index = rows.findIndex((row) => row.group.providerId === group.providerId && row.model.id === model.id);
                return (
                  <button
                    key={model.id}
                    type="button"
                    aria-pressed={model.selected}
                    aria-label={`模型 ${model.id}`}
                    disabled={model.disabledReason !== undefined}
                    title={model.disabledReason}
                    onMouseEnter={() => setCursor(index)}
                    onClick={async () => {
                      if (model.disabledReason !== undefined) return;
                      await select(group.providerId, model.id);
                    }}
                    className={`flex items-center justify-between rounded-md border px-3 py-2 text-left text-xs disabled:opacity-50 ${
                      model.selected ? "border-accent/40 bg-accent/10 text-accent" : index === cursor ? "border-accent/30 bg-soft text-ink" : "border-line text-ink hover:bg-soft"
                    }`}
                  >
                    <span>
                      {model.label}
                      {model.label !== model.id ? <small className="ml-1.5 text-muted">{model.id}</small> : null}
                      <small className="ml-2 text-muted">{formatTokens(model.contextWindow * 1000)} Tokens 上下文</small>
                      {model.maxOutput !== undefined ? <small className="ml-2 text-muted">最大输出 {formatTokens(model.maxOutput * 1000)}</small> : null}
                      <small className="ml-2 text-muted">{model.supportsImages ? "支持图片" : "不支持图片"}</small>
                    </span>
                    {model.disabledReason ? <small className="text-orange">{model.disabledReason}</small> : model.selected ? <span className="badge">当前</span> : null}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-muted" data-testid="picker-current">
        当前 {attribution.providerName ?? "配置已不存在"} / {currentModel ? modelDisplayName(currentModel) : session.model} · {display.occupancyLabel}
      </p>
      {attribution.availability !== "available" ? (
        <p className="mt-1 text-[11px] text-orange" role="status" data-testid="picker-availability">
          {attribution.message ?? "当前配置不可用"}
        </p>
      ) : null}
      {currentProvider && !currentProvider.enabled ? (
        <p className="mt-1 text-[11px] text-orange">当前 Provider 已停用，请选择其他 Provider。</p>
      ) : null}
      <div className="mt-3 flex justify-end">
        <Button
          size="sm"
          onClick={() => {
            onClose();
            navigate({ view: "providers" });
          }}
        >
          管理 Provider
        </Button>
      </div>
    </Modal>
  );
}

const REASONING_LABELS: Record<string, string> = {
  off: "关闭",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};

function ThinkingPickerModal({ taskId, sessionId, onClose }: { taskId: string; sessionId: string; onClose: () => void }) {
  const workspace = useHostStore((state) => state.workspace);
  const session = useHostStore((state) => state.session(taskId, sessionId));
  const setSessionThinking = useHostStore((state) => state.setSessionThinking);
  const pushToast = useUiStore((state) => state.pushToast);
  const navigate = useNavigationStore((state) => state.navigate);
  if (!session) return null;
  const provider = workspace?.providers.find((item) => item.id === session.providerId);
  const model = provider?.models.find((item) => item.id === session.model);
  const thinking = model?.thinking;
  const resolved = resolveSessionThinking(model, session.thinking);
  const levels = thinking?.mode === "custom" ? thinking.levels : [];
  return (
    <Modal title="推理档位" onClose={onClose}>
      <p className="text-xs text-muted" data-testid="thinking-current">
        {model ? modelDisplayName(model) : session.model} · 当前 {resolved.level.length > 0 ? `${REASONING_LABELS[resolved.level] ?? resolved.level}（${resolved.level}）` : "跟随模型目录"} · 仅用于当前会话。
      </p>
      {resolved.stale !== undefined ? (
        <p className="mt-2 text-[11px] text-orange" role="status">
          原偏好 {resolved.stale} 已失效（模型未声明该档位），已回退到模型默认。
        </p>
      ) : null}
      {resolved.catalog === "catalog-unknown" ? (
        <p className="mt-3 text-xs text-muted">当前模型跟随模型目录，尚未获取可用档位；不能声明已关闭推理。可到「Provider 与上下文」配置可用档位。</p>
      ) : resolved.catalog === "unsupported" ? (
        <p className="mt-3 text-xs text-muted">该模型不支持推理档位。</p>
      ) : (
        <div className="mt-3 flex flex-col gap-1.5">
          {levels.map((level) => {
            const selected = resolved.level === level;
            const decision = evaluateThinkingSelection({ thinking, level });
            return (
              <button
                key={level}
                type="button"
                aria-pressed={selected}
                disabled={!decision.ok}
                title={decision.ok ? undefined : decision.error.message}
                onClick={async () => {
                  try {
                    await setSessionThinking(taskId, sessionId, level);
                    onClose();
                    pushToast(`当前会话推理档位已选择${REASONING_LABELS[level] ?? level}`);
                  } catch (error) {
                    pushToast(error instanceof Error ? error.message : String(error));
                  }
                }}
                className={`flex items-center justify-between rounded-md border px-3 py-2 text-left text-xs disabled:opacity-50 ${
                  selected ? "border-accent/40 bg-accent/10 text-accent" : "border-line text-ink hover:bg-soft"
                }`}
              >
                <span>
                  {REASONING_LABELS[level] ?? level} <small className="text-muted">{level}</small>
                </span>
                {level === thinking?.default ? <small className="text-muted">模型默认</small> : (level === resolved.level ? <small className="text-muted">会话选择</small> : null)}
              </button>
            );
          })}
          {levels.includes("off") ? null : <p className="text-[11px] text-muted">该模型未声明「关闭」档位，推理不可关闭。</p>}
        </div>
      )}
      <div className="mt-3 flex justify-between">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onClose();
            navigate({ view: "providers" });
          }}
        >
          模型设置
        </Button>
        <span className="text-[11px] text-muted">切换档位只影响后续请求；上下文压缩不会减少累计 Token。</span>
      </div>
    </Modal>
  );
}

function ContextModal({ taskId, sessionId, onClose }: { taskId: string; sessionId: string; onClose: () => void }) {
  const workspace = useHostStore((state) => state.workspace);
  const session = useHostStore((state) => state.session(taskId, sessionId));
  const compactSessionContext = useHostStore((state) => state.compactSessionContext);
  const pushToast = useUiStore((state) => state.pushToast);
  if (!session) return null;
  const providers = workspace?.providers ?? [];
  const provider = providers.find((item) => item.id === session.providerId);
  const model = provider?.models.find((item) => item.id === session.model);
  const attribution = describeHistoryAttribution(providers, { providerId: session.providerId, model: session.model });
  const display = describeContextDisplay({ used: session.contextUsed, window: session.contextWindow, source: session.contextSource ?? "actual" });
  return (
    <Modal title="上下文占用" onClose={onClose}>
      <div className="flex items-baseline gap-2">
        <strong className="text-lg text-ink">{display.percent === null ? "未知" : `${display.percent.toFixed(1)}%`}</strong>
        <span className="text-xs text-muted" data-testid="context-numbers">
          {display.occupancyLabel}
        </span>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-soft">
        <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, display.percent ?? 0)}%` }} />
      </div>
      <p className="mt-3 text-xs text-ink" data-testid="context-attribution">
        模型归属：{attribution.providerName ?? "配置已不存在"} / {attribution.modelName ?? session.model}
        {model ? ` · 窗口 ${formatTokens(model.contextWindow * 1000)} Tokens` : ""}
      </p>
      {attribution.availability !== "available" ? (
        <p className="mt-1 text-[11px] text-orange" role="status" data-testid="context-availability">
          {attribution.message ?? "当前配置不可用"}
        </p>
      ) : null}
      <p className="mt-2 text-[11px] text-muted">
        包含消息、指令和工具结果；估算或待更新的数值会明确标记，压缩后不继续展示失效精确值。窗口与预估剩余量随当前模型变化。
      </p>
      <p className="mt-3 flex items-center justify-between text-xs">
        <span className="text-muted">预估剩余</span>
        <strong className="text-ink">{display.remainingTokens === null ? "窗口未知" : `${formatTokens(display.remainingTokens)} Tokens`}</strong>
      </p>
      <p className="mt-2 flex items-center justify-between text-xs">
        <span className="text-muted">本会话累计消耗</span>
        <strong className="text-ink" data-testid="context-tokens">
          {session.tokens.toFixed(1)}k Tokens
        </strong>
      </p>
      <div className="mt-3 flex justify-end">
        <Button
          size="sm"
          onClick={async () => {
            try {
              await compactSessionContext(taskId, sessionId);
              onClose();
              pushToast("已压缩上下文；占用标记为待更新，累计 Token 保留");
            } catch (error) {
              // A busy round refuses compaction; show the reason and keep the
              // dialog open so the numbers stay readable.
              pushToast(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          模拟压缩
        </Button>
      </div>
    </Modal>
  );
}

const CAPABILITY_BOUNDARY: Record<string, string> = {
  skill: "技能提供按需加载的指引；其中脚本和实际工具调用继续遵循会话权限。",
  mcp: "MCP Server 由 PiDock 管理，并通过桥接 Extension 提供工具；连接凭据与项目共享配置分开保存。",
  package: "Package 是安装与更新单元；启用前需要审阅固定版本、所含资源及可执行代码。",
  extension: "Extension 与 Pi 进程拥有相同系统权限，可注册工具、命令和事件处理器；启用前需要审阅来源。",
};

function RetryModal({ onClose }: { taskId: string; sessionId: string; onClose: () => void }) {
  const pushToast = useUiStore((state) => state.pushToast);
  const [outcome, setOutcome] = useState("unknown");
  return (
    <Modal
      title="检查重试范围"
      onClose={onClose}
      footer={
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            if (outcome === "unknown") {
              pushToast("请先核对上一次操作结果");
              return;
            }
            if (outcome === "sent") {
              onClose();
              pushToast("已核对上次操作成功，不重复执行");
              return;
            }
            onClose();
            pushToast("仅重试失败步骤；已完成步骤保留，不重放");
          }}
        >
          继续
        </Button>
      }
    >
      <p className="text-xs text-muted">保留已经完成的摘要与工具结果，仅重试失败步骤。</p>
      <div className="mt-3">
        <Field label="上一次外部操作的结果">
          <select
            aria-label="上一次外部操作的结果"
            value={outcome}
            onChange={(event) => setOutcome(event.target.value)}
            className="rounded-md border border-line px-2 py-1.5 text-sm"
          >
            <option value="unknown">尚未核对</option>
            <option value="not-sent">已核对：没有送达 / 请求未发出</option>
            <option value="sent">已核对：已经成功，不应重复</option>
          </select>
        </Field>
      </div>
      <p className="mt-3 text-[11px] text-muted">不确定时先核对工具记录或接收方，不直接重发。</p>
    </Modal>
  );
}

function CapabilityDetailModal({ capabilityId, onClose }: { capabilityId: string; onClose: () => void }) {
  const workspace = useHostStore((state) => state.workspace);
  const setCapabilityEnabled = useHostStore((state) => state.setCapabilityEnabled);
  const retryMcpConnection = useHostStore((state) => state.retryMcpConnection);
  const installCapability = useHostStore((state) => state.installCapability);
  const pushToast = useUiStore((state) => state.pushToast);
  const capability = (workspace?.capabilities ?? []).find((item) => item.id === capabilityId);
  if (!capability) return null;
  const typeLabel = { skill: "Pi Skill", extension: "Extension", package: "Package", mcp: "MCP Server（bridge）" }[capability.kind];
  const statusLabel = { enabled: "已启用", disabled: "已停用", "update-available": "有可用更新", "pending-review": "待审阅" }[
    capability.status
  ];
  const enabled = isCapabilityEnabled(capability);
  const invalid = capabilityInvalidReason(capability);
  const version = packageVersionState(capability);
  const bridge = capability.kind === "mcp" ? mcpBridgeStatus(workspace?.capabilities ?? [], capability) : null;
  const fail = (error: unknown) => pushToast(error instanceof Error ? error.message : String(error));
  return (
    <Modal
      title={capability.name}
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          {capability.kind === "mcp" && capability.connection?.state !== "connected" ? (
            <Button
              size="sm"
              onClick={() =>
                void retryMcpConnection(capability.id)
                  .then(() => {
                    onClose();
                    pushToast(`${capability.name} 已重新连接（内存投影）`);
                  })
                  .catch(fail)
              }
            >
              重试连接
            </Button>
          ) : null}
          {version === "not-installed" || version === "update-available" ? (
            <Button
              size="sm"
              variant="primary"
              onClick={() =>
                void installCapability(capability.id)
                  .then((updated) => {
                    onClose();
                    pushToast(
                      updated.pendingChange
                        ? `${updated.name}：安装将在当前回合结束后生效`
                        : `${updated.name} 已记录安装 ${updated.installedVersion ?? ""}（内存投影）`,
                    );
                  })
                  .catch(fail)
              }
            >
              {version === "not-installed" ? `安装 ${capability.availableVersion ?? "此版本"}` : `更新到 ${capability.availableVersion}`}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={enabled ? "ghost" : "primary"}
            onClick={() =>
              void setCapabilityEnabled(capability.id, !enabled)
                .then(() => {
                  onClose();
                  pushToast(`${capability.name}：变更已提交，如有回合执行中将在结束后生效`);
                })
                .catch(fail)
            }
          >
            {enabled ? "停用" : "启用"}
          </Button>
        </div>
      }
    >
      <dl className="grid grid-cols-[80px_1fr] gap-x-4 gap-y-2 text-xs">
        <dt className="text-muted">类型</dt>
        <dd>{typeLabel}</dd>
        <dt className="text-muted">来源</dt>
        <dd className="font-mono text-[11px]">{capability.source}</dd>
        {capability.sourceKind ? (
          <>
            <dt className="text-muted">来源类型</dt>
            <dd>
              {sourceKindLabel(capability.sourceKind)}
            </dd>
          </>
        ) : null}
        <dt className="text-muted">作用域</dt>
        <dd>{capability.scope}</dd>
        <dt className="text-muted">状态</dt>
        <dd>{statusLabel}</dd>
        {capability.kind === "package" ? (
          <>
            <dt className="text-muted">安装版本</dt>
            <dd>
              已安装 {capability.installedVersion ?? "未安装"}
              {capability.availableVersion ? ` · 可用 ${capability.availableVersion}` : ""}
            </dd>
          </>
        ) : null}
        {capability.kind === "mcp" ? (
          <>
            <dt className="text-muted">连接</dt>
            <dd>
              {mcpConnectionLabel(capability.connection?.state ?? "disconnected")}
              {capability.connection?.attempts ? ` · 尝试 ${capability.connection.attempts} 次` : ""}
            </dd>
            <dt className="text-muted">bridge</dt>
            <dd>{bridge && bridge.ok ? bridge.bridge.extensionId : "未就绪，需要已启用的 bridge Extension"}</dd>
          </>
        ) : null}
        <dt className="text-muted">权限</dt>
        <dd>
          声明 {capability.requestedPermission ?? "未声明"} · 调用时以会话权限为准，能力不能扩权
        </dd>
        <dt className="text-muted">可用性</dt>
        <dd>{capability.verified === true ? "已在本机验证" : "仅声明（未验证，不代表 SDK 已支持）"}</dd>
      </dl>
      {invalid ? (
        <p className="mt-3 rounded-md border border-orange/35 bg-orange/10 px-3 py-2 text-xs text-orange">
          {invalidLabel(invalid.code)}：{invalid.message}
        </p>
      ) : null}
      <div className="mt-3 rounded-md border border-line bg-soft/40 px-3 py-2 text-xs text-muted">
        {CAPABILITY_BOUNDARY[capability.kind]}
      </div>
      <h3 className="mt-3 text-xs text-ink">声明的能力</h3>
      <p className="mt-1 text-xs text-muted">{capability.scope} · 来源内容、配置和权限均为内存投影示例，尚未读取、安装或执行真实资源。</p>
    </Modal>
  );
}

function invalidLabel(code: CapabilityFailureCode) {
  return {
    "source-disabled": "来源已停用",
    "source-missing": "来源已移除",
    "resource-missing": "资源缺失",
    "load-failed": "加载失败",
    "bridge-missing": "缺少 bridge Extension",
    "connect-failed": "连接失败",
    "not-installed": "尚未安装",
  }[code];
}

type ProviderModelDraft = {
  id: string;
  name: string;
  followsId: boolean;
  contextWindow: number;
  /** Provenance of the window value (directory / default / hand-typed). */
  contextWindowSource: ContextWindowSource;
  maxOutput?: number;
  supportsImages?: boolean;
  thinking?: ModelThinking;
};

function ProviderEditModal({ providerId, onClose }: { providerId?: string; onClose: () => void }) {
  const workspace = useHostStore((state) => state.workspace);
  const saveProvider = useHostStore((state) => state.saveProvider);
  const removeProvider = useHostStore((state) => state.removeProvider);
  const syncProviderModels = useHostStore((state) => state.syncProviderModels);
  const pushToast = useUiStore((state) => state.pushToast);
  const existing = workspace?.providers.find((item) => item.id === providerId);
  const [name, setName] = useState(existing?.name ?? "");
  const [protocol, setProtocol] = useState(existing?.protocol ?? "anthropic-messages");
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? "");
  const [authRef, setAuthRef] = useState(existing?.authRef ?? "");
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [models, setModels] = useState<ProviderModelDraft[]>(
    existing?.models.map((model) => ({
      id: model.id,
      name: model.name ?? "",
      followsId: !model.name || model.name === model.id,
      contextWindow: model.contextWindow,
      contextWindowSource: contextWindowSourceOf(model),
      ...(model.maxOutput !== undefined ? { maxOutput: model.maxOutput } : {}),
      supportsImages: model.supportsImages,
      thinking: model.thinking,
    })) ?? [{ id: "", name: "", followsId: true, contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW, contextWindowSource: "default" as const }],
  );
  // 「同步模型列表」 refreshes candidates only: configured rows are never
  // overwritten, auto-added or removed, and the candidate set is bound to the
  // connection it came from (a changed address/protocol invalidates it).
  const [candidates, setCandidates] = useState<string[]>([]);
  const [candidateFingerprint, setCandidateFingerprint] = useState<string | null>(null);
  const [catalogStatus, setCatalogStatus] = useState("");
  const [issues, setIssues] = useState<{ code: string; field: string; message: string }[]>([]);
  const candidatesStale = candidateFingerprint !== null && candidateFingerprint !== connectionFingerprint({ protocol, baseUrl });
  const update = (index: number, patch: Partial<ProviderModelDraft>) =>
    setModels((items) => items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  // The Add form syncs the draft connection; the Edit form syncs the saved
  // configuration. Either way only the candidate list changes.
  const sync = async () => {
    if (baseUrl.trim().length === 0) {
      setCatalogStatus("请先填写服务地址，再同步模型列表。");
      return;
    }
    try {
      const view = await syncProviderModels(existing?.id ?? "", { protocol, baseUrl });
      setCatalogStatus(view.message);
      setCandidates(view.candidates);
      setCandidateFingerprint(view.fingerprint);
    } catch (error) {
      setCatalogStatus(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <Modal
      title={existing ? "编辑 Provider" : "添加 Provider"}
      onClose={onClose}
      footer={
        <>
          {existing ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                await removeProvider(existing.id);
                onClose();
                pushToast("已移除 Provider；引用它的会话与历史仍显示原归属并提示配置不可用");
              }}
            >
              删除 Provider
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="primary"
            onClick={async () => {
              const draft = { name, protocol, baseUrl, ...(authRef.trim().length > 0 ? { authRef } : {}), models };
              const found = validateProviderDraft(draft);
              setIssues(found);
              if (found.length > 0) {
                pushToast(found[0].message);
                return;
              }
              try {
                await saveProvider({
                  id: providerId,
                  name,
                  protocol,
                  baseUrl,
                  ...(authRef.trim().length > 0 ? { authRef } : {}),
                  enabled,
                  models: models.map((model) => ({
                    id: model.id,
                    name: model.name.trim() && model.name.trim() !== model.id ? model.name.trim() : undefined,
                    contextWindow: model.contextWindow,
                    ...(model.maxOutput !== undefined ? { maxOutput: model.maxOutput } : {}),
                    contextWindowSource: model.contextWindowSource,
                    supportsImages: model.supportsImages,
                    thinking: model.thinking,
                  })),
                });
                onClose();
                pushToast("已保存 Provider 配置；凭据只保存引用，不写入共享模板与日志");
              } catch (error) {
                pushToast(error instanceof Error ? error.message : String(error));
              }
            }}
          >
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="显示名称">
          <input
            aria-label="显示名称"
            aria-invalid={issues.some((issue) => issue.field === "name")}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="rounded-md border border-line px-2 py-1.5 text-sm"
            placeholder="例如 团队网关"
          />
        </Field>
        <Field label="协议" hint="必须显式选择，不按供应商名或地址猜测">
          <select
            aria-label="协议"
            aria-invalid={issues.some((issue) => issue.field === "protocol")}
            value={protocol}
            onChange={(event) => setProtocol(event.target.value)}
            className="rounded-md border border-line px-2 py-1.5 text-sm"
          >
            <option value="anthropic-messages">anthropic-messages</option>
            <option value="openai-responses">openai-responses</option>
            <option value="openai-chat-completions">openai-chat-completions</option>
          </select>
        </Field>
        <Field label="服务地址" hint="凭据通过本机私有配置引用，不写入共享模板">
          <input
            aria-label="服务地址"
            aria-invalid={issues.some((issue) => issue.field === "baseUrl")}
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            className="rounded-md border border-line px-2 py-1.5 text-sm"
            placeholder="https://"
          />
        </Field>
        <Field label="认证引用" hint="本机私有配置中的引用名，不是凭据明文">
          <input
            aria-label="认证引用"
            aria-invalid={issues.some((issue) => issue.field === "authRef")}
            value={authRef}
            onChange={(event) => setAuthRef(event.target.value)}
            className="rounded-md border border-line px-2 py-1.5 text-sm"
            placeholder="例如 gateway-key"
          />
        </Field>
        <Field label="启用">
          <label className="flex items-center gap-2 text-xs text-ink">
            <input type="checkbox" aria-label="启用 Provider" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            启用此 Provider
          </label>
        </Field>
      </div>
      <fieldset className="mt-3">
        <legend className="text-xs text-muted">模型列表</legend>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={sync}>
            同步模型列表
          </Button>
          <small role="status" data-testid="provider-catalog-status" className="text-[11px] text-muted">
            {catalogStatus.length > 0 ? catalogStatus : "可直接填写模型 ID，或同步后从下拉列表选择。"}
          </small>
          {candidatesStale ? (
            <small className="text-[11px] text-orange" data-testid="provider-catalog-stale">
              连接已变化，候选已失效，请重新同步
            </small>
          ) : null}
        </div>
        <datalist id="provider-model-candidates">
          {candidates.map((candidate) => (
            <option key={candidate} value={candidate} />
          ))}
        </datalist>
        <div className="mt-2 flex flex-col gap-2">
          {models.map((model, index) => {
            const thinking = model.thinking;
            const mode = thinking?.mode ?? "auto";
            const levels = thinking?.levels ?? [];
            const rowIssues = issues.filter((issue) => issue.field.startsWith(`models.${model.id}`) || issue.field === "models");
            const setThinking = (next: ModelThinking) => update(index, { thinking: next });
            return (
              <div key={index} className="flex flex-wrap items-center gap-2">
                <input
                  aria-label={`模型 ID 第 ${index + 1} 行`}
                  list="provider-model-candidates"
                  value={model.id}
                  onChange={(event) => {
                    const id = event.target.value;
                    // The display name follows the ID until the user customises it.
                    const next = followModelNameOnIdChange({ name: model.name.trim() || undefined, followsId: model.followsId });
                    // While following, the name field mirrors the new id; a custom
                    // name stays as typed.
                    // Picking a synced candidate records `catalog` provenance; a row
                    // whose window was edited by hand keeps saying `manual`.
                    const fromCatalog = candidates.includes(id.trim());
                    update(index, {
                      id,
                      name: next.followsId ? id : (next.name ?? ""),
                      followsId: next.followsId,
                      contextWindowSource: fromCatalog && model.contextWindowSource !== "manual" ? "catalog" : model.contextWindowSource,
                    });
                  }}
                  aria-invalid={rowIssues.some((issue) => issue.field === "models" || issue.field === `models.${model.id}`)}
                  className="w-48 rounded-md border border-line px-2 py-1.5 text-xs"
                  placeholder="模型 ID"
                />
                <input
                  aria-label={`模型显示名称 第 ${index + 1} 行`}
                  value={model.name}
                  onChange={(event) => {
                    // The raw keystrokes are stored (trimming on every keystroke would
                    // swallow spaces); only the follow decision is normalized.
                    const raw = event.target.value;
                    const next = followModelName(model.id, raw);
                    // Clearing the field restores the follow: the field empties (the
                    // placeholder shows the id again) and saving stores no custom name.
                    update(index, {
                      name: next.followsId ? (raw.trim().length === 0 ? "" : model.id) : raw,
                      followsId: next.followsId,
                    });
                  }}
                  className="w-40 rounded-md border border-line px-2 py-1.5 text-xs"
                  placeholder="默认使用模型 ID"
                  title={model.followsId ? `跟随模型 ID：${model.id}` : undefined}
                />
                <input
                  aria-label={`模型上下文 第 ${index + 1} 行`}
                  type="number"
                  min="1"
                  value={model.contextWindow}
                  onChange={(event) => update(index, { contextWindow: Number(event.target.value), contextWindowSource: "manual" })}
                  className="w-32 rounded-md border border-line px-2 py-1.5 text-xs"
                />
                <span className="text-[11px] text-muted">k Tokens</span>
                <span className="text-[11px] text-muted" data-testid={`model-window-source-${index + 1}`}>
                  {CONTEXT_WINDOW_SOURCE_LABEL[model.contextWindowSource]}
                </span>
                <input
                  aria-label={`模型最大输出 第 ${index + 1} 行`}
                  type="number"
                  min="1"
                  value={model.maxOutput ?? ""}
                  placeholder="最大输出"
                  onChange={(event) => {
                    const raw = event.target.value;
                    update(index, raw.trim().length === 0 ? { maxOutput: undefined } : { maxOutput: Number(raw) });
                  }}
                  className="w-32 rounded-md border border-line px-2 py-1.5 text-xs"
                />
                <span className="text-[11px] text-muted">k Tokens</span>
                <label className="flex items-center gap-1 text-[11px] text-muted">
                  <input
                    type="checkbox"
                    aria-label={`支持图片输入 第 ${index + 1} 行`}
                    checked={Boolean(model.supportsImages)}
                    onChange={(event) => update(index, { supportsImages: event.target.checked })}
                  />
                  支持图片
                </label>
                <select
                  aria-label={`推理能力 第 ${index + 1} 行`}
                  value={mode}
                  onChange={(event) => setThinking({ mode: event.target.value as ModelThinking["mode"], levels, default: thinking?.default ?? "" })}
                  className="rounded-md border border-line px-2 py-1.5 text-xs"
                >
                  <option value="auto">跟随模型目录</option>
                  <option value="none">不支持推理</option>
                  <option value="custom">自定义可用档位</option>
                </select>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`移除模型 第 ${index + 1} 行`}
                  disabled={models.length === 1}
                  onClick={() => setModels((items) => items.filter((_, i) => i !== index))}
                >
                  移除
                </Button>
                {mode === "custom" ? (
                  <div className="flex w-full flex-wrap items-center gap-2 rounded-md border border-line px-2 py-1.5">
                    {REASONING_LEVELS.map((key) => {
                      const checked = levels.includes(key);
                      return (
                        <label key={key} className="flex items-center gap-1 text-[11px] text-muted">
                          <input
                            type="checkbox"
                            aria-label={`推理档位 ${index + 1} ${key}`}
                            checked={checked}
                            onChange={(event) => {
                              const nextLevels = event.target.checked ? [...levels, key] : levels.filter((item) => item !== key);
                              const fallback = nextLevels.includes(thinking?.default ?? "") ? (thinking?.default ?? "") : (nextLevels[0] ?? "");
                              setThinking({ mode: "custom", levels: nextLevels, default: fallback });
                            }}
                          />
                          {REASONING_LABELS[key] ?? key}
                        </label>
                      );
                    })}
                    <label className="flex items-center gap-1 text-[11px] text-muted">
                      默认档位
                      <select
                        aria-label={`默认推理档位 第 ${index + 1} 行`}
                        value={thinking?.default ?? ""}
                        onChange={(event) => setThinking({ mode: "custom", levels, default: event.target.value })}
                        className="rounded border border-line px-1.5 py-1 text-[11px]"
                      >
                        {levels.map((key) => (
                          <option key={key} value={key}>
                            {REASONING_LABELS[key] ?? key}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                ) : null}
              </div>
            );
          })}
          <div>
            <Button
              size="sm"
              onClick={() =>
                setModels((items) => [
                  ...items,
                  { id: "", name: "", followsId: true, contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW, contextWindowSource: "default" },
                ])
              }
            >
              添加模型
            </Button>
          </div>
        </div>
      </fieldset>
      {issues.length > 0 ? (
        <ul className="mt-3 list-disc pl-4 text-[11px] text-orange" data-testid="provider-issues">
          {issues.map((issue) => (
            <li key={`${issue.code}-${issue.field}`}>
              {issue.field}：{issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-3 text-[11px] text-muted">
        同一 Provider 中的模型 ID 不可重复；上下文窗口与最大输出必须为正整数。显示名称默认跟随模型 ID，可单独修改；同步候选不覆盖已配置模型，也不批量新增。
      </p>
    </Modal>
  );
}

function ProjectListModal({ onClose }: { onClose: () => void }) {
  const workspace = useHostStore((state) => state.workspace);
  const tasks = workspace?.tasks ?? [];
  const navigate = useNavigationStore((state) => state.navigate);
  const openModal = useUiStore((state) => state.openModal);
  const projects = workspace?.projects ?? [];
  return (
    <Modal
      title="项目管理"
      onClose={onClose}
      footer={
        <Button size="sm" variant="primary" onClick={() => openModal({ type: "project-edit" })}>
          新建项目
        </Button>
      }
    >
      <p className="text-xs text-muted">切换项目，或管理项目的目录、仓库与名称。</p>
      <div className="mt-3 flex flex-col gap-2">
        {projects.length === 0 ? <EmptyState>还没有项目</EmptyState> : null}
        {projects.map((project) => {
          const count = tasks.filter((task) => task.projectId === project.id).length;
          return (
            <div key={project.id} className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-xs">
              <div>
                <strong className="block text-ink">{project.name}</strong>
                <small className="text-muted">{project.description || "未填写说明"} · {count} 个任务</small>
              </div>
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  onClick={() => {
                    onClose();
                    navigate({ view: "project", projectId: project.id });
                  }}
                >
                  切换
                </Button>
                <Button size="sm" onClick={() => openModal({ type: "project-edit", projectId: project.id })}>
                  编辑
                </Button>
                <Button size="sm" variant="ghost" onClick={() => openModal({ type: "project-delete", projectId: project.id })}>
                  删除
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

function ProjectEditModal({ projectId, onClose }: { projectId?: string; onClose: () => void }) {
  const workspace = useHostStore((state) => state.workspace);
  const saveProject = useHostStore((state) => state.saveProject);
  const navigate = useNavigationStore((state) => state.navigate);
  const pushToast = useUiStore((state) => state.pushToast);
  const project = (workspace?.projects ?? []).find((item) => item.id === projectId);
  const registered = workspace?.repositories ?? [];
  const tasks = (workspace?.tasks ?? []).filter((item) => item.projectId === projectId);
  const usedRepoIds = new Set(tasks.flatMap((task) => task.repos));
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [repoIds, setRepoIds] = useState<string[]>(() => (project?.repositories ?? []).map((repository) => repository.id));
  const [directories, setDirectories] = useState<ProjectDirectory[]>(() => (project?.directories ?? []).map((item) => ({ ...item })));
  const updateDirectory = (id: string, field: "name" | "path", value: string) =>
    setDirectories((items) => items.map((item) => (item.id === id ? { ...item, [field]: value } : item)));
  return (
    <Modal
      title={project ? "编辑项目" : "新建项目"}
      onClose={onClose}
      footer={
        <Button
          size="sm"
          variant="primary"
          onClick={async () => {
            try {
              const saved = await saveProject({ id: projectId, name, description, repositoryIds: repoIds, directories });
              onClose();
              if (!projectId) {
                navigate({ view: "project", projectId: saved.id });
                pushToast("项目已保存到原型内存");
              } else {
                pushToast("项目已保存到原型内存");
              }
            } catch (error) {
              pushToast(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          {project ? "保存项目" : "创建项目"}
        </Button>
      }
    >
      <Field label="项目名称">
        <input
          aria-label="项目名称"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="rounded-md border border-line px-2 py-1.5 text-sm"
          placeholder="例如：订单系统"
        />
      </Field>
      <div className="mt-3">
        <Field label="说明">
          <input
            aria-label="项目说明"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            className="rounded-md border border-line px-2 py-1.5 text-sm"
          />
        </Field>
      </div>
      <fieldset className="mt-3">
        <legend className="text-xs text-muted">关联已注册仓库</legend>
        <small className="text-[11px] text-muted">任务使用中的仓库不能解除关联。</small>
        <div className="mt-1.5 flex flex-col gap-1.5">
          {registered.map((repository) => {
            const used = usedRepoIds.has(repository.id);
            return (
              <label key={repository.id} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  aria-label={`仓库 ${repository.name}`}
                  checked={used || repoIds.includes(repository.id)}
                  disabled={used}
                  onChange={(event) =>
                    setRepoIds((items) =>
                      event.target.checked ? [...items, repository.id] : items.filter((id) => id !== repository.id),
                    )
                  }
                />
                <span>{repository.name}</span>
                {used ? <small className="text-muted">任务使用中</small> : null}
              </label>
            );
          })}
        </div>
      </fieldset>
      <fieldset className="mt-3">
        <legend className="text-xs text-muted">普通目录</legend>
        <div className="mt-1.5 flex flex-col gap-2">
          {directories.map((directory, index) => {
            const locked = tasks.some((task) => task.directories.some((item) => item.id === directory.id));
            return (
              <div key={directory.id} className="flex flex-wrap items-center gap-2">
                <input
                  aria-label={`项目目录名称 第 ${index + 1} 行`}
                  value={directory.name}
                  readOnly={locked}
                  onChange={(event) => updateDirectory(directory.id, "name", event.target.value)}
                  className="w-40 rounded-md border border-line px-2 py-1.5 text-xs read-only:bg-soft"
                  placeholder="例如：设计资料"
                />
                <input
                  aria-label={`项目目录路径 第 ${index + 1} 行`}
                  value={directory.path}
                  readOnly={locked}
                  onChange={(event) => updateDirectory(directory.id, "path", event.target.value)}
                  className="flex-1 rounded-md border border-line px-2 py-1.5 font-mono text-[11px] read-only:bg-soft"
                  placeholder="/Users/name/Documents/design"
                />
                {locked ? <Badge tone="warn">任务使用中</Badge> : null}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`移除项目目录 第 ${index + 1} 行`}
                  disabled={locked}
                  onClick={() => setDirectories((items) => items.filter((item) => item.id !== directory.id))}
                >
                  移除
                </Button>
              </div>
            );
          })}
          <div>
            <Button
              size="sm"
              onClick={() => setDirectories((items) => [...items, { id: `dir-new-${items.length + 1}`, name: "", path: "" }])}
            >
              添加目录
            </Button>
          </div>
        </div>
      </fieldset>
    </Modal>
  );
}

function ProjectDeleteModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const workspace = useHostStore((state) => state.workspace);
  const deleteProject = useHostStore((state) => state.deleteProject);
  const navigate = useNavigationStore((state) => state.navigate);
  const pushToast = useUiStore((state) => state.pushToast);
  const project = (workspace?.projects ?? []).find((item) => item.id === projectId);
  const boundTasks = (workspace?.tasks ?? []).filter((item) => item.projectId === projectId);
  if (!project) return null;
  const environmentCount = (workspace?.environments ?? []).filter((item) => item.projectId === projectId).length;
  return (
    <Modal
      title="删除项目"
      onClose={onClose}
      footer={
        boundTasks.length === 0 ? (
          <Button
            size="sm"
            variant="primary"
            onClick={async () => {
              try {
                await deleteProject(projectId);
                onClose();
                const next = (workspace?.projects ?? []).find((item) => item.id !== projectId);
                navigate(next ? { view: "project", projectId: next.id } : { view: "attention" });
                pushToast("已移除模拟项目登记，未删除磁盘文件");
              } catch (error) {
                pushToast(error instanceof Error ? error.message : String(error));
              }
            }}
          >
            删除项目
          </Button>
        ) : undefined
      }
    >
      <h3 className="text-sm font-medium text-ink">{project.name}</h3>
      {boundTasks.length > 0 ? (
        <>
          <div className="mt-3 rounded-md border border-orange/35 bg-orange/10 px-3 py-2 text-xs text-orange">
            还有 {boundTasks.length} 个关联任务（包含已归档任务），暂不能删除项目。
          </div>
          <p className="mt-2 text-xs text-muted">请先在任务清理流程中处理这些任务；归档不会解除关联。</p>
          <ul className="mt-2 flex flex-col gap-1 text-xs">
            {boundTasks.map((task) => (
              <li key={task.id} className="flex items-center justify-between border-b border-line pb-1">
                <span className="text-ink">{task.name}</span>
                <small className="text-muted">{task.archived ? "已归档" : "进行中"}</small>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <p className="mt-2 text-xs text-muted">
            将移除该项目的登记、仓库绑定和 {environmentCount} 个环境配置。原始仓库和磁盘上的共享模板文件保留。
          </p>
          <p className="mt-2 text-[11px] text-muted">此操作仅演示删除范围，原型中刷新页面可重置。</p>
        </>
      )}
    </Modal>
  );
}

function EnvironmentListModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const workspace = useHostStore((state) => state.workspace);
  const navigate = useNavigationStore((state) => state.navigate);
  const openModal = useUiStore((state) => state.openModal);
  const project = (workspace?.projects ?? []).find((item) => item.id === projectId);
  const environments = (workspace?.environments ?? []).filter((item) => item.projectId === projectId);
  const tasks = (workspace?.tasks ?? []).filter((item) => item.projectId === projectId);
  if (!project) return null;
  return (
    <Modal
      title="环境管理"
      onClose={onClose}
      footer={
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            onClose();
            navigate({ view: "env" });
          }}
        >
          环境与服务页面
        </Button>
      }
    >
      <p className="text-xs text-muted">{project.name} · 环境的名称和说明在这里管理，变量与启动方式在环境页面编辑。</p>
      <div className="mt-3 flex flex-col gap-2">
        {environments.length === 0 ? <EmptyState>还没有环境</EmptyState> : null}
        {environments.map((environment) => (
          <div key={environment.id} className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-xs">
            <div>
              <strong className="block text-ink">{environment.name}</strong>
              <small className="text-muted">
                {environment.description || "未填写说明"} · {environment.templateVersion} ·{" "}
                {tasks.filter((task) => task.environmentId === environment.id).length} 个任务
              </small>
            </div>
            <div className="flex gap-1.5">
              <Button size="sm" onClick={() => openModal({ type: "environment-edit", projectId, environmentId: environment.id })}>
                编辑
              </Button>
              <Button size="sm" variant="ghost" onClick={() => openModal({ type: "environment-delete", environmentId: environment.id })}>
                删除
              </Button>
            </div>
          </div>
        ))}
        <div>
          <Button size="sm" variant="primary" onClick={() => openModal({ type: "environment-edit", projectId })}>
            新增环境
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function EnvironmentEditModal({
  projectId,
  environmentId,
  onClose,
}: {
  projectId: string;
  environmentId?: string;
  onClose: () => void;
}) {
  const workspace = useHostStore((state) => state.workspace);
  const saveEnvironment = useHostStore((state) => state.saveEnvironment);
  const navigate = useNavigationStore((state) => state.navigate);
  const pushToast = useUiStore((state) => state.pushToast);
  const existing = (workspace?.environments ?? []).find((item) => item.id === environmentId);
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  return (
    <Modal
      title={existing ? "编辑环境" : "新增环境"}
      onClose={onClose}
      footer={
        <Button
          size="sm"
          variant="primary"
          onClick={async () => {
            try {
              await saveEnvironment({ id: environmentId, projectId, name, description });
              onClose();
              if (!existing) {
                navigate({ view: "env" });
                pushToast("环境已保存；任务的模板版本与运行状态保留");
              } else {
                pushToast("环境已保存；任务的模板版本与运行状态保留");
              }
            } catch (error) {
              pushToast(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          {existing ? "保存环境" : "创建环境"}
        </Button>
      }
    >
      <Field label="环境名称">
        <input
          aria-label="环境名称"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="rounded-md border border-line px-2 py-1.5 text-sm"
          placeholder="例如：集成测试"
        />
      </Field>
      <div className="mt-3">
        <Field label="说明">
          <input
            aria-label="环境说明"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            className="rounded-md border border-line px-2 py-1.5 text-sm"
            placeholder="说明远程依赖和使用场景"
          />
        </Field>
      </div>
      <p className="mt-3 text-[11px] text-muted">
        {existing
          ? "修改名称和说明不改变任务采用的模板版本，也不重启服务。"
          : "创建空环境后，前往共享模板添加变量与服务配置；新环境作用域从共享模板开始。"}
      </p>
    </Modal>
  );
}

function EnvironmentDeleteModal({ environmentId, onClose }: { environmentId: string; onClose: () => void }) {
  const workspace = useHostStore((state) => state.workspace);
  const deleteEnvironment = useHostStore((state) => state.deleteEnvironment);
  const pushToast = useUiStore((state) => state.pushToast);
  const environment = (workspace?.environments ?? []).find((item) => item.id === environmentId);
  const referencing = (workspace?.tasks ?? []).filter((item) => item.environmentId === environmentId);
  if (!environment) return null;
  return (
    <Modal
      title="删除环境"
      onClose={onClose}
      footer={
        referencing.length === 0 ? (
          <Button
            size="sm"
            variant="primary"
            onClick={async () => {
              try {
                await deleteEnvironment(environmentId);
                onClose();
                pushToast("已删除模拟环境");
              } catch (error) {
                pushToast(error instanceof Error ? error.message : String(error));
              }
            }}
          >
            删除环境
          </Button>
        ) : undefined
      }
    >
      <h3 className="text-sm font-medium text-ink">{environment.name}</h3>
      {referencing.length > 0 ? (
        <>
          <div className="mt-3 rounded-md border border-orange/35 bg-orange/10 px-3 py-2 text-xs text-orange">
            {referencing.length} 个任务正在引用此环境（包含已归档任务），暂不能删除。
          </div>
          <ul className="mt-2 flex flex-col gap-1 text-xs">
            {referencing.map((task) => (
              <li key={task.id} className="flex items-center justify-between border-b border-line pb-1">
                <span className="text-ink">{task.name}</span>
                <small className="text-muted">{task.templateVersion}</small>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-2 text-xs text-muted">将移除此环境及其配置。其他环境和远程服务不受影响。</p>
      )}
    </Modal>
  );
}

const CAPABILITY_KINDS = {
  skill: { title: "添加技能来源", sourceLabel: "目录路径", placeholder: "例如 ~/.agents/skills" },
  mcp: { title: "添加 MCP Server", sourceLabel: "启动命令或远程地址", placeholder: "例如 npx @example/mcp-server" },
  extension: { title: "添加 Extension", sourceLabel: "文件路径", placeholder: "例如 ~/.pi/agent/extensions/team.ts" },
  package: { title: "安装扩展包", sourceLabel: "npm、git 或本地来源", placeholder: "例如 npm:@team/pi-toolkit@2.4.1" },
} as const;

function AddCapabilityModal({ kind, onClose }: { kind: "skill" | "extension" | "package" | "mcp"; onClose: () => void }) {
  const addCapability = useHostStore((state) => state.addCapability);
  const capabilities = useHostStore((state) => state.workspace?.capabilities ?? []);
  const pushToast = useUiStore((state) => state.pushToast);
  const labels = CAPABILITY_KINDS[kind];
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [scope, setScope] = useState("仅当前项目");
  const [sourceKind, setSourceKind] = useState<CapabilitySourceKind>("project");
  const [bridgeId, setBridgeId] = useState("");
  const [credentialRef, setCredentialRef] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // MCP is only reachable through an enabled bridge Extension ([PiDock 16] #18 box 3).
  // The predicate is the one `mcpBridgeStatus` applies, so an installed bridge
  // with a pending update is offered here too.
  const bridges = capabilities.filter((item) => item.kind === "extension" && isCapabilityEnabled(item));
  const selectedBridge = bridgeId || bridges[0]?.id || "";
  const submit = async () => {
    setSubmitting(true);
    try {
      if (kind === "mcp" && selectedBridge === "") throw new Error("MCP Server 必须选择一个已启用的 bridge Extension");
      await addCapability({
        kind,
        name,
        source,
        scope,
        sourceKind,
        ...(kind === "mcp" ? { bridge: { extensionId: selectedBridge, command: source.trim() } } : {}),
        ...(kind === "mcp" && credentialRef.trim().length > 0 ? { authRef: credentialRef } : {}),
      });
      onClose();
      pushToast("已添加为停用，不会加载或连接");
    } catch (error) {
      pushToast(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <Modal
      title={labels.title}
      onClose={onClose}
      footer={
        <Button size="sm" variant="primary" disabled={submitting} onClick={() => void submit()}>
          {kind === "package" ? "添加到待安装" : "添加为停用"}
        </Button>
      }
    >
      <Field label="名称">
        <input
          aria-label="能力名称"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="rounded-md border border-line px-2 py-1.5 text-sm"
          placeholder="便于识别的名称"
        />
      </Field>
      <div className="mt-3">
        <Field label={labels.sourceLabel}>
          <input
            aria-label="能力来源"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            className="rounded-md border border-line px-2 py-1.5 text-sm"
            placeholder={labels.placeholder}
          />
        </Field>
      </div>
      <div className="mt-3">
        <Field label="来源类型" hint="全局 / 项目 / 任务仓库 / 额外来源分开记录，同名能力按来源区分">
          <select
            aria-label="来源类型"
            value={sourceKind}
            onChange={(event) => setSourceKind(event.target.value as CapabilitySourceKind)}
            className="rounded-md border border-line px-2 py-1.5 text-sm"
          >
            <option value="global">全局</option>
            <option value="project">项目</option>
            <option value="task-repo">任务仓库</option>
            <option value="extra">额外来源</option>
          </select>
        </Field>
      </div>
      <div className="mt-3">
        <Field label="作用域">
          <select
            aria-label="能力作用域"
            value={scope}
            onChange={(event) => setScope(event.target.value)}
            className="rounded-md border border-line px-2 py-1.5 text-sm"
          >
            <option>仅当前项目</option>
            <option>所有项目</option>
          </select>
        </Field>
      </div>
      {kind === "mcp" ? (
        <>
          <div className="mt-3">
            <Field label="bridge Extension" hint="MCP Server 必须通过已启用的 bridge Extension 接入">
              <select
                aria-label="bridge Extension"
                value={selectedBridge}
                onChange={(event) => setBridgeId(event.target.value)}
                className="rounded-md border border-line px-2 py-1.5 text-sm"
              >
                {bridges.length === 0 ? <option value="">没有已启用的 Extension</option> : null}
                {bridges.map((bridge) => (
                  <option key={bridge.id} value={bridge.id}>
                    {bridge.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="mt-3">
            <Field label="凭据引用（可选）" hint="只保存本机私有配置里的引用名称，不保存密钥明文">
              <input
                aria-label="凭据引用"
                value={credentialRef}
                onChange={(event) => setCredentialRef(event.target.value)}
                className="rounded-md border border-line px-2 py-1.5 text-sm"
                placeholder="例如 figma-token"
              />
            </Field>
          </div>
        </>
      ) : null}
      <p className="mt-3 text-[11px] text-muted">
        {kind === "package"
          ? "先解析固定版本和资源清单，等待本机确认后才安装。"
          : "添加后先保持停用，审阅来源与权限后再显式启用。"}
      </p>
    </Modal>
  );
}

function ScheduleEditModal({ scheduleId, onClose }: { scheduleId: string; onClose: () => void }) {
  const workspace = useHostStore((state) => state.workspace);
  const saveSchedule = useHostStore((state) => state.saveSchedule);
  const pushToast = useUiStore((state) => state.pushToast);
  const schedule = (workspace?.schedules ?? []).find((item) => item.id === scheduleId);
  const providers = workspace?.providers ?? [];
  const [name, setName] = useState(schedule?.name ?? "");
  const [rule, setRule] = useState(schedule?.rule ?? "");
  const [timezone, setTimezone] = useState(schedule?.timezone ?? "Asia/Shanghai");
  const [prompt, setPrompt] = useState(schedule?.prompt ?? "");
  const [modelKey, setModelKey] = useState(`${schedule?.providerId ?? ""}:${schedule?.model ?? ""}`);
  const [permission, setPermission] = useState<Permission>(schedule?.permission ?? "default");
  if (!schedule) return null;
  const [providerId, model] = modelKey.split(":");
  return (
    <Modal
      title="编辑定时任务"
      onClose={onClose}
      footer={
        <Button
          size="sm"
          variant="primary"
          onClick={async () => {
            try {
              await saveSchedule({ id: scheduleId, name, rule, timezone, prompt, providerId, model, permission });
              onClose();
              pushToast("已保存模拟定时任务");
            } catch (error) {
              pushToast(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          保存更改
        </Button>
      }
    >
      <Field label="任务名称">
        <input
          aria-label="定时任务名称"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="rounded-md border border-line px-2 py-1.5 text-sm"
        />
      </Field>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="执行周期">
          <input
            aria-label="执行周期"
            value={rule}
            onChange={(event) => setRule(event.target.value)}
            className="rounded-md border border-line px-2 py-1.5 text-sm"
            placeholder="例如：每周五 15:00"
          />
        </Field>
        <Field label="时区">
          <select
            aria-label="时区"
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
            className="rounded-md border border-line px-2 py-1.5 text-sm"
          >
            <option>Asia/Shanghai</option>
            <option>UTC</option>
            <option>America/Los_Angeles</option>
          </select>
        </Field>
      </div>
      <div className="mt-3">
        <Field label="Provider / 模型">
          <select
            aria-label="调度模型"
            value={modelKey}
            onChange={(event) => setModelKey(event.target.value)}
            className="rounded-md border border-line px-2 py-1.5 text-sm"
          >
            {providers.flatMap((provider) =>
              provider.models.map((item) => (
                <option key={`${provider.id}:${item.id}`} value={`${provider.id}:${item.id}`} disabled={!provider.enabled}>
                  {provider.name} / {item.name ?? item.id}
                </option>
              )),
            )}
          </select>
        </Field>
      </div>
      <div className="mt-3">
        <Field label="新会话权限">
          <select
            aria-label="调度权限"
            value={permission}
            onChange={(event) => setPermission(event.target.value as Permission)}
            className="rounded-md border border-line px-2 py-1.5 text-sm"
          >
            <option value="read">只读</option>
            <option value="default">默认权限 · 需要时等待确认</option>
            <option value="auto">自动执行 · 仍受任务边界约束</option>
          </select>
        </Field>
      </div>
      <div className="mt-3">
        <Field label="提示词">
          <textarea
            aria-label="定时任务提示词"
            rows={5}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            className="w-full rounded-md border border-line px-2 py-1.5 text-xs"
          />
        </Field>
      </div>
      <p className="mt-2 text-[11px] text-muted">每次触发在当前任务中创建新的独立会话；历史会话可查看并继续对话。</p>
    </Modal>
  );
}

/** Prototype `remotePreview()`: a static mobile information-architecture mockup. */
function RemotePreviewModal({ onClose }: { onClose: () => void }) {
  const workspace = useHostStore((state) => state.workspace);
  const tasks = workspace?.tasks ?? [];
  const project = workspace?.projects[0];
  const first = tasks.find((item) => !item.archived);
  return (
    <Modal
      title="手机视图预览"
      onClose={onClose}
      footer={
        <Button size="sm" variant="primary" onClick={onClose}>
          关闭预览
        </Button>
      }
    >
      <div className="mx-auto w-64 rounded-2xl border border-line bg-soft/40 p-3 text-[11px]">
        <div className="flex justify-between text-muted">
          <span>9:41</span>
          <span>{workspace?.devices.some((device) => device.status === "active") ? "已连接" : "离线"}</span>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-full bg-accent text-paper">π</span>
          <div>
            <strong className="block text-ink">PiDock</strong>
            <small className="text-muted">本机任务</small>
          </div>
        </div>
        <div className="mt-2 text-muted">项目</div>
        <div className="mt-1 rounded-md border border-line bg-paper px-2 py-1.5">
          <strong className="block text-ink">{project?.name ?? "还没有项目"}</strong>
          <small className="text-muted">
            {project ? `${(workspace?.tasks ?? []).filter((item) => item.projectId === project.id).length} 个任务` : "—"}
          </small>
        </div>
        <div className="mt-2 text-muted">最近任务</div>
        {first ? (
          <div className="mt-1 rounded-md border border-line bg-paper px-2 py-1.5">
            <strong className="block text-ink">{first.name}</strong>
            <small className="text-muted">{first.activeSessionId} · 示例状态</small>
          </div>
        ) : null}
        <div className="mt-2 rounded-md border border-line bg-paper px-2 py-1.5">
          <strong className="block text-ink">对话</strong>
          <p className="mt-1 text-muted">发送消息…</p>
        </div>
        <nav className="mt-2 flex justify-between text-muted">
          {["项目", "任务", "对话", "设置"].map((item) => (
            <span key={item}>{item}</span>
          ))}
        </nav>
      </div>
      <p className="mt-3 text-[11px] text-muted">
        移动端优先覆盖查看状态、进入对话和少量管理；文件编辑、终端和浏览器控制不作为默认入口。此处仅为静态预览，不实现移动布局。
      </p>
    </Modal>
  );
}

/** Prototype `project-bind`: machine-local checkout paths for registered repositories. */
function RepoBindingModal({ onClose }: { onClose: () => void }) {
  const workspace = useHostStore((state) => state.workspace);
  const setRepositoryPath = useHostStore((state) => state.setRepositoryPath);
  const pushToast = useUiStore((state) => state.pushToast);
  const repositories = workspace?.repositories ?? [];
  const [paths, setPaths] = useState<Record<string, string>>(() =>
    Object.fromEntries(repositories.map((repository) => [repository.id, repository.localPath ?? ""])),
  );
  return (
    <Modal
      title="本机仓库绑定"
      onClose={onClose}
      footer={
        <Button
          size="sm"
          variant="primary"
          onClick={async () => {
            try {
              for (const repository of repositories) {
                await setRepositoryPath(repository.id, paths[repository.id] ?? "");
              }
              onClose();
              pushToast("已保存本机仓库路径（内存模拟）；不读取磁盘也不初始化仓库");
            } catch (error) {
              pushToast(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          保存绑定
        </Button>
      }
    >
      <p className="text-xs text-muted">路径属于本机设置，不进入项目共享模板；仅校验路径格式，不读取磁盘或初始化 Git。</p>
      <div className="mt-3 flex flex-col gap-2">
        {repositories.map((repository) => (
          <Field key={repository.id} label={repository.name}>
            <input
              aria-label={`${repository.name} 本机路径`}
              value={paths[repository.id] ?? ""}
              onChange={(event) => setPaths((items) => ({ ...items, [repository.id]: event.target.value }))}
              className="w-full rounded-md border border-line px-2 py-1.5 text-xs font-mono"
              placeholder="例如 /Users/name/Workspace/repo"
            />
          </Field>
        ))}
      </div>
    </Modal>
  );
}

/** Prototype `delivery` + `delivery-preview`: per-repository review and commit draft. */
function DeliveryModal({ task, onClose }: { task: Task; onClose: () => void }) {
  const workspace = useHostStore((state) => state.workspace);
  const pushToast = useUiStore((state) => state.pushToast);
  const repositories = (workspace?.repositories ?? []).filter((repository) => task.repos.includes(repository.id));
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState(false);
  return (
    <Modal
      title={preview ? "提交变更" : "审阅与交付"}
      onClose={onClose}
      footer={
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            if (!preview) {
              if (!message.trim()) {
                pushToast("请填写提交说明");
                return;
              }
              setPreview(true);
              return;
            }
            onClose();
            pushToast("已模拟提交草稿；此原型不连接 Git，未提交任何变更");
          }}
        >
          {preview ? "确认提交草稿" : "查看提交面板示意"}
        </Button>
      }
    >
      {preview ? (
        <>
          <p className="text-xs text-muted">仓库、目标分支、变更文件和验证记录会在此呈现。跨仓库交付失败需保留逐仓库结果。</p>
          <p className="mt-2 text-xs text-ink">
            提交说明：{message} · 目标分支 task/{task.workspaceKey} · {repositories.length} 个仓库
          </p>
        </>
      ) : (
        <>
          <p className="text-xs text-muted">各仓库分别审阅。提交、推送和合并需要明确触发。此原型不连接 Git。</p>
          <div className="mt-2 flex flex-col gap-2">
            {repositories.map((repository) => (
              <div key={repository.id} className="rounded-md border border-line px-3 py-2 text-xs">
                <strong className="block font-mono text-[11px] text-ink">{repository.name}</strong>
                <small className="text-muted">本地路径 {repository.localPath ?? "未绑定"} · 待审阅变更</small>
              </div>
            ))}
            {repositories.length === 0 ? <EmptyState>本任务没有 Git 仓库，交付不适用。</EmptyState> : null}
          </div>
          {repositories.length > 0 ? (
            <Field label="提交说明">
              <input
                aria-label="提交说明"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                className="w-full rounded-md border border-line px-2 py-1.5 text-xs"
                placeholder="描述当前任务的代码变更"
              />
            </Field>
          ) : null}
        </>
      )}
    </Modal>
  );
}

/** Prototype `command('/skills' | '/session' | '/help')` composer info modals. */
function ComposerInfoModal({ task, topic, onClose }: { task: Task; topic: "skills" | "session" | "help"; onClose: () => void }) {
  const workspace = useHostStore((state) => state.workspace);
  const addReference = useDraftStore((state) => state.addReference);
  const pushToast = useUiStore((state) => state.pushToast);
  const closeModal = useUiStore((state) => state.closeModal);
  const session = task.sessions.find((item) => item.id === task.activeSessionId);
  const skills = (workspace?.capabilities ?? []).filter((capability) => capability.kind === "skill" && capability.status === "enabled");
  const titles = { skills: "可用技能", session: "当前会话", help: "对话输入" };
  return (
    <Modal title={titles[topic]} onClose={onClose}>
      {topic === "skills" ? (
        skills.length === 0 ? (
          <EmptyState>还没有已启用的技能。</EmptyState>
        ) : (
          <div className="flex flex-col gap-2">
            {skills.map((skill) => (
              <div key={skill.id} className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-xs">
                <span>
                  <strong className="block text-ink">{skill.name}</strong>
                  <small className="text-muted">{skill.source}</small>
                </span>
                <Button
                  size="sm"
                  onClick={() => {
                    // The same candidate row the `$` picker uses, so a skill
                    // inserted here records the same source id and resource
                    // path instead of a bare label.
                    const candidate = skillCandidate(skill);
                    addReference(task.id, session?.id ?? "main", {
                      id: `skill-${skill.id}`,
                      kind: "skill",
                      label: skill.name,
                      detail: candidate.detail,
                      taskId: task.id,
                      ...referenceProvenance(candidate),
                    });
                    closeModal();
                    pushToast(`已把技能 ${skill.name} 插入当前会话`);
                  }}
                >
                  插入对话
                </Button>
              </div>
            ))}
          </div>
        )
      ) : null}
      {topic === "session" ? (
        <dl className="flex flex-col gap-1.5 text-xs">
          <div>任务：{task.name}</div>
          <div>会话：{session?.name ?? "—"}</div>
          <div>Provider：{workspace?.providers.find((item) => item.id === session?.providerId)?.name ?? "—"}</div>
          <div>模型：{session?.model ?? "—"}</div>
          <div>
            上下文：{session?.contextUsed ?? 0}k / {session?.contextWindow ?? 0}k（估算）
          </div>
          <div>累计消耗：{session?.tokens ?? 0}k tokens</div>
        </dl>
      ) : null}
      {topic === "help" ? (
        <div className="flex flex-col gap-1.5 text-xs">
          <p>
            <code>@</code> 当前任务文件、目录与所选代码
          </p>
          <p>
            <code>$</code> 已启用技能及来源
          </p>
          <p>
            <code>/</code> 应用命令菜单
          </p>
          <p>↑ ↓ 选择候选，Tab / Enter 确认，Esc 关闭。</p>
          <p>Enter 发送，Shift + Enter 换行，中文组合输入不提交。</p>
        </div>
      ) : null}
    </Modal>
  );
}
