import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, EmptyState, Panel } from "../components/ui";
import { CodeBlock } from "../components/CodeBlock";
import { BrowserPanel, FilesPanel, RuntimePanel, TerminalPanel } from "../components/ToolPanels";
import type { Approval, Message, Reference, Task } from "../data/types";
import { approvalStatusLabel, runStateLabel } from "./runState";
import { sessionKeyOf } from "../data/sessionKey";
import { useDraftStore } from "../stores/drafts";
import { useEventsStore } from "../stores/events";
import { useHostStore } from "../stores/host";
import { TOOL_PANELS, useUiStore, type ToolPanel } from "../stores/ui";
import { useNavigationStore } from "../stores/navigation";

const EMPTY_PANELS: ToolPanel[] = [];
const EMPTY_LIVE: Message[] = [];
const EMPTY_DRAFT: { text: string; references: Reference[] } = { text: "", references: [] };

export function TaskPage({ task, sessionId }: { task: Task; sessionId: string }) {
  const session = task.sessions.find((item) => item.id === sessionId) ?? task.sessions[0];
  const panels = useUiStore((state) => state.panels[task.id] ?? EMPTY_PANELS);
  const togglePanel = useUiStore((state) => state.togglePanel);
  const openModal = useUiStore((state) => state.openModal);

  if (!session) return <EmptyState>当前任务还没有会话。</EmptyState>;

  const visibleSessions = sessionTabs(task, session.id);

  return (
    <div className="flex min-h-0 flex-1 gap-4">
      <section className="flex min-h-0 flex-1 flex-col gap-3">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-base font-medium text-ink">{task.name}</h1>
            <Badge>{task.workspaceKey}</Badge>
            {task.archived ? <Badge tone="warn">已归档</Badge> : null}
          </div>
          <div className="flex items-center gap-2">
            {TOOL_PANELS.map((panel) => (
              <Button
                key={panel}
                size="sm"
                variant={panels.includes(panel) ? "primary" : "default"}
                onClick={() => togglePanel(task.id, panel)}
              >
                {panelName(panel)}
              </Button>
            ))}
            <Button size="sm" variant="ghost" onClick={() => openModal({ type: "archive-task", taskId: task.id })}>
              归档当前任务
            </Button>
          </div>
        </header>

        <SessionTabs task={task} visibleSessions={visibleSessions} activeSessionId={session.id} />

        <RunStateCard taskId={task.id} sessionId={session.id} />

        <Conversation taskId={task.id} sessionId={session.id} archived={task.archived} />

        <Composer task={task} sessionId={session.id} />
      </section>

      {panels.length > 0 ? (
        <aside className="flex w-[380px] shrink-0 flex-col gap-3 overflow-auto">
          {panels.map((panel) => (
            <Panel
              key={panel}
              title={panelName(panel)}
              actions={
                <Button size="sm" variant="ghost" onClick={() => togglePanel(task.id, panel)}>
                  收起
                </Button>
              }
            >
              {panel === "runtime" ? (
                <RuntimePanel
                  task={task}
                  onToggleService={(serviceId, running) => {
                    void useHostStore.getState().setServiceRunning(task.id, serviceId, running);
                  }}
                />
              ) : null}
              {panel === "browser" ? <BrowserPanel pages={task.browserPages} /> : null}
              {panel === "files" ? <FilesPanel files={task.files} /> : null}
              {panel === "terminal" ? <TerminalPanel taskId={task.id} seed={task.terminalSeed} /> : null}
            </Panel>
          ))}
        </aside>
      ) : null}
    </div>
  );
}

function panelName(panel: ToolPanel) {
  return { runtime: "运行", browser: "浏览器", files: "文件", terminal: "终端" }[panel];
}

function sessionTabs(task: Task, activeSessionId: string) {
  const visible = task.sessions.slice(0, 4);
  if (visible.some((item) => item.id === activeSessionId)) return visible;
  const active = task.sessions.find((item) => item.id === activeSessionId);
  if (!active) return visible;
  return [...visible.slice(0, 3), active];
}

function SessionTabs({
  task,
  visibleSessions,
  activeSessionId,
}: {
  task: Task;
  visibleSessions: ReturnType<typeof sessionTabs>;
  activeSessionId: string;
}) {
  const openModal = useUiStore((state) => state.openModal);
  const navigate = useNavigationStore((state) => state.navigate);
  return (
    <div className="flex items-center gap-2">
      <Button size="sm" onClick={() => openModal({ type: "sessions", taskId: task.id, filter: "active" })}>
        全部会话 {task.sessions.length}
      </Button>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {visibleSessions.map((session) => (
          <button
            key={session.id}
            type="button"
            onClick={() => navigate({ view: "task", projectId: task.projectId, taskId: task.id, sessionId: session.id })}
            onContextMenu={(event) => {
              event.preventDefault();
              openModal({ type: "rename-session", taskId: task.id, sessionId: session.id, value: session.name });
            }}
            title={`${session.name} · 右键操作`}
            className={`flex items-center gap-1.5 truncate rounded-md border px-2.5 py-1 text-xs ${
              session.id === activeSessionId ? "border-accent/40 bg-accent/10 text-accent" : "border-line bg-paper text-muted hover:text-ink"
            }`}
          >
            {session.name}
            {session.archived ? <Badge>已归档</Badge> : session.permission === "read" ? <Badge>只读</Badge> : null}
          </button>
        ))}
      </div>
      <Button
        size="sm"
        aria-label="新建会话"
        onClick={async () => {
          const created = await useHostStore.getState().createSession(task.id);
          navigate({ view: "task", projectId: task.projectId, taskId: task.id, sessionId: created.id });
        }}
      >
        新建会话
      </Button>
    </div>
  );
}

function RunStateCard({ taskId, sessionId }: { taskId: string; sessionId: string }) {
  const key = sessionKeyOf(taskId, sessionId);
  const run = useEventsStore((state) => state.runs[key]);
  const stopRun = useHostStore((state) => state.stopRun);
  if (!run || run.state === "idle") return null;
  return (
    <Panel
      title="会话执行状态"
      actions={
        <div className="flex items-center gap-2">
          <Badge tone={run.state === "failed" || run.state === "expired" ? "warn" : run.state === "running" ? "accent" : "neutral"}>
            {runStateLabel(run.state)}
          </Badge>
          {run.state === "running" ? (
            <Button size="sm" onClick={() => void stopRun(taskId, sessionId)}>
              停止
            </Button>
          ) : null}
        </div>
      }
    >
      <p className="text-xs text-muted">{run.summary}</p>
      {run.failedScope ? <p className="mt-1 text-xs text-orange">失败范围：{run.failedScope}</p> : null}
      <ol className="mt-2 flex flex-wrap gap-2 text-[11px]">
        {run.steps.map((step) => (
          <li key={step.label} className="rounded border border-line px-2 py-1">
            <span className={step.state === "failed" ? "text-orange" : step.state === "skipped" ? "text-muted/70" : "text-ink"}>
              {step.label}
            </span>
            <span className="ml-1 text-muted">{stepStateLabel(step.state)}</span>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-[11px] text-muted">停止不回滚已完成操作；恢复不自动重放已完成工具。</p>
    </Panel>
  );
}

function stepStateLabel(state: "done" | "failed" | "pending" | "skipped") {
  return { done: "完成", failed: "失败", pending: "等待", skipped: "跳过" }[state];
}

export function ApprovalCard({ approval, onResolved }: { approval: Approval; onResolved?: () => void }) {
  const resolveApproval = useHostStore((state) => state.resolveApproval);
  const simulateExpiry = useHostStore((state) => state.simulateExpiry);
  const pushToast = useUiStore((state) => state.pushToast);
  const expiresAt = new Date(approval.expiresAt);

  return (
    <Panel
      title="等待确认"
      actions={<Badge tone={approval.status === "pending" ? "warn" : "neutral"}>{approvalStatusLabel(approval.status)}</Badge>}
    >
      <dl className="grid grid-cols-[92px_1fr] gap-x-4 gap-y-2 text-xs">
        <dt className="text-muted">操作</dt>
        <dd>{approval.title}</dd>
        <dt className="text-muted">命令</dt>
        <dd className="font-mono text-[11px]">{approval.command}</dd>
        <dt className="text-muted">目录</dt>
        <dd className="font-mono text-[11px]">{approval.cwd}</dd>
        <dt className="text-muted">影响</dt>
        <dd>{approval.impact}</dd>
        {approval.recipient ? (
          <>
            <dt className="text-muted">接收人</dt>
            <dd>{approval.recipient}</dd>
          </>
        ) : null}
        <dt className="text-muted">有效期</dt>
        <dd>
          {expiresAt.toLocaleString("zh-CN")}（等待起点后 24 小时与下一次计划时刻取较早者）
        </dd>
        <dt className="text-muted">载荷版本</dt>
        <dd className="font-mono text-[11px]">{approval.payloadVersion}</dd>
      </dl>

      {approval.status === "pending" ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              void resolveApproval(approval.id, "approved");
              pushToast("已批准本次请求，执行前会再次校验内容版本与权限");
              onResolved?.();
            }}
          >
            批准
          </Button>
          <Button
            size="sm"
            onClick={() => {
              void resolveApproval(approval.id, "rejected");
              pushToast("已拒绝，本次请求不会执行");
              onResolved?.();
            }}
          >
            拒绝
          </Button>
          <Button
            size="sm"
            title="把有效期推进到截止时刻，用于演示；真实调度由 Host 承担"
            onClick={() => {
              void simulateExpiry(approval.id);
              pushToast("确认已过期，未执行");
              onResolved?.();
            }}
          >
            标记过期
          </Button>
        </div>
      ) : null}

      {approval.status === "approved" && approval.executed ? (
        <p className="mt-3 text-xs text-accent">正在执行 {approval.command}</p>
      ) : null}
      {approval.status === "rejected" ? <p className="mt-3 text-xs text-muted">已拒绝，未执行。</p> : null}
      {approval.status === "expired" ? <p className="mt-3 text-xs text-orange">确认已过期，未执行。</p> : null}
    </Panel>
  );
}

function Conversation({ taskId, sessionId, archived }: { taskId: string; sessionId: string; archived: boolean }) {
  const session = useHostStore((state) => state.session(taskId, sessionId));
  const liveKey = sessionKeyOf(taskId, sessionId);
  const live = useEventsStore((state) => state.liveMessages[liveKey] ?? EMPTY_LIVE);
  const refs = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);

  const messages = useMemo<Message[]>(() => {
    const persisted = session?.messages ?? [];
    const persistedIds = new Set(persisted.map((item) => item.id));
    return [...persisted, ...live.filter((item) => !persistedIds.has(item.id))];
  }, [session?.messages, live]);

  useEffect(() => {
    const element = refs.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [messages]);

  if (messages.length === 0) return <EmptyState>这个会话还没有消息。</EmptyState>;

  return (
    <div
      ref={refs}
      role="log"
      aria-label="会话消息"
      className="min-h-0 flex-1 overflow-auto rounded-panel border border-line bg-paper px-4 py-3"
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
      }}
    >
      <ul className="flex flex-col gap-4">
        {messages.map((message) => (
          <li key={message.id} className={message.role === "user" ? "text-right" : ""}>
            <div className="mb-1 text-[11px] text-muted">{message.role === "user" ? "你" : "Agent"}</div>
            <div
              className={`inline-block max-w-[92%] rounded-md border px-3 py-2 text-left text-sm ${
                message.role === "user" ? "border-accent/25 bg-accent/5 text-ink" : "border-line bg-soft/40 text-ink"
              }`}
            >
              <p className="whitespace-pre-wrap">{message.text}</p>
              {message.code ? <CodeBlock code={message.code.source} language={message.code.language} label={message.code.label} /> : null}
              {message.references && message.references.length > 0 ? (
                <ul className="mt-1.5 flex flex-wrap gap-1.5">
                  {message.references.map((reference) => (
                    <li key={reference.id} className="rounded-full border border-line bg-paper px-2 py-0.5 text-[11px] text-muted">
                      引用 · {reference.label}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {archived ? <p className="mt-3 text-[11px] text-muted">已归档会话仍可查看与继续对话；归档不是任务归档。</p> : null}
    </div>
  );
}

function Composer({ task, sessionId }: { task: Task; sessionId: string }) {
  const session = useHostStore((state) => state.session(task.id, sessionId));
  const draft = useDraftStore((state) => state.drafts[sessionKeyOf(task.id, sessionId)] ?? EMPTY_DRAFT);
  const setText = useDraftStore((state) => state.setText);
  const addReference = useDraftStore((state) => state.addReference);
  const removeReference = useDraftStore((state) => state.removeReference);
  const clear = useDraftStore((state) => state.clear);
  const sendMessage = useHostStore((state) => state.sendMessage);
  const createFileReference = useHostStore((state) => state.createFileReference);
  const pushToast = useUiStore((state) => state.pushToast);
  const approvals = useHostStore((state) => state.approvals);
  const [sending, setSending] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);

  const approval = approvals.find((item) => item.taskId === task.id && item.sessionId === sessionId);

  return (
    <div className="flex flex-col gap-2">
      {approval ? <ApprovalCard approval={approval} /> : null}
      <form
        className="rounded-panel border border-line bg-paper px-3 py-2.5"
        onSubmit={async (event) => {
          event.preventDefault();
          const text = draft.text.trim();
          if (!text || sending) return;
          setSending(true);
          try {
            const result = await sendMessage(task.id, sessionId, text, draft.references);
            if (result.state === "failed" || result.state === "stopped") {
              pushToast("执行失败：已保留输入、引用与已完成步骤，可修复后继续");
            } else {
              clear(task.id, sessionId);
            }
          } finally {
            setSending(false);
          }
        }}
      >
        {draft.references.length > 0 ? (
          <ul className="mb-2 flex flex-wrap gap-1.5">
            {draft.references.map((reference) => (
              <li key={reference.id} className="flex items-center gap-1 rounded-full border border-line bg-soft px-2 py-0.5 text-[11px] text-muted">
                引用 · {reference.label}
                <button type="button" aria-label={`移除引用 ${reference.label}`} onClick={() => removeReference(task.id, sessionId, reference.id)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <textarea
          aria-label="消息输入"
          value={draft.text}
          onChange={(event) => setText(task.id, sessionId, event.target.value)}
          rows={3}
          placeholder="描述要验证或修改的内容，输入 @ 引用文件、$ 调用技能、/ 打开命令"
          className="w-full resize-none border-0 bg-transparent text-sm text-ink outline-none"
          disabled={session?.permission === "read"}
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => addReference(task.id, sessionId, await createFileReference(task.id))}
            >
              + 引用文件
            </Button>
            {["@", "$", "/"].map((token) => (
              <Button key={token} size="sm" variant="ghost" onClick={() => setText(task.id, sessionId, `${draft.text}${token}`)}>
                {token}
              </Button>
            ))}
            <Button size="sm" variant="ghost" onClick={() => setModelOpen((value) => !value)}>
              {session?.model ?? "模型"} · 上下文 {session?.contextUsed ?? 0}k / {session?.contextWindow ?? 0}k
            </Button>
            {modelOpen ? (
              <span className="rounded-md border border-line bg-soft px-2 py-1 text-[11px] text-muted">
                切换模型会校验上下文窗口；超窗候选置灰并说明原因。当前占用不可压缩到窗口内时禁止切换。
              </span>
            ) : null}
          </div>
          <Button size="sm" variant="primary" type="submit" disabled={sending || session?.permission === "read"}>
            发送消息
          </Button>
        </div>
        <p className="mt-1.5 text-[11px] text-muted">
          图片与文件仅在本页预览，不写入业务仓库；真实 Host 接入在 02 中定义。
        </p>
      </form>
    </div>
  );
}
