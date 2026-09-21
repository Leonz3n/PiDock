import { useMemo, useState } from "react";
import { Badge, Button, EmptyState, Field, Modal, Segmented } from "./ui";
import { VirtualList } from "./VirtualList";
import { runStateLabel } from "../pages/runState";
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

  if (modal.type === "new-task") {
    return (
      <Modal
        title="新建任务"
        onClose={closeModal}
        footer={
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              closeModal();
              pushToast("新建任务需要真实 worktree 准备，将在 03 工单接入；当前为界面演示");
            }}
          >
            创建任务
          </Button>
        }
      >
        <Field label="任务名称" hint="显示名称可为中文；任务目录使用独立自动生成的英文数字标识">
          <input aria-label="任务名称" className="rounded-md border border-line px-2 py-1.5 text-sm" placeholder="例如 发布前检查" />
        </Field>
        <p className="mt-3 text-[11px] text-muted">任务目录预览：task-&lt;8 位标识&gt;，默认分支 task/&lt;同一标识&gt; 且可独立编辑。</p>
      </Modal>
    );
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
