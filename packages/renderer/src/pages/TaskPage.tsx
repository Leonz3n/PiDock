import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, EmptyState, Panel } from "../components/ui";
import { CodeBlock } from "../components/CodeBlock";
import {
  BrowserPanel,
  DirectoryFilesPanel,
  DirectoryRootChoices,
  DirectoryTerminalPanel,
  FilesPanel,
  LogsPanel,
  RuntimePanel,
  SessionSubagentList,
  SubagentPanel,
  TerminalPanel,
} from "../components/ToolPanels";
import type { Approval, Message, Reference, Task } from "../data/types";
import { isDirectoryOnlyTask } from "../data/directories";
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
  const pushToast = useUiStore((state) => state.pushToast);

  const directoryOnly = isDirectoryOnlyTask(task);
  // Ordinary directories belong to every task that has them, mixed included;
  // only the Git branch / remote-baseline / worktree / diff surfaces stay
  // directory-only-exclusive (the prototype keeps them and adds the badge).
  const hasDirectories = task.directories.length > 0;
  const [activeDirectoryId, setActiveDirectoryId] = useState("");
  useEffect(() => setActiveDirectoryId(""), [task.id]);
  const activeDirectory = task.directories.find((directory) => directory.id === activeDirectoryId);
  const availablePanels = directoryOnly ? (["files", "terminal"] as ToolPanel[]) : TOOL_PANELS;

  const subagents = task.subagentsBySession?.[session.id] ?? [];
  const [subagentOpen, setSubagentOpen] = useState(false);
  const [selectedSubagentId, setSelectedSubagentId] = useState("");
  const [subagentSession, setSubagentSession] = useState(session.id);
  if (subagentSession !== session.id) {
    // Switching sessions must not leak another session's child-agent selection.
    setSubagentSession(session.id);
    setSubagentOpen(false);
    setSelectedSubagentId("");
  }

  if (!session) return <EmptyState>当前任务还没有会话。</EmptyState>;

  const visibleSessions = sessionTabs(task, session.id);

  return (
    <div className="flex min-h-0 flex-1 gap-4">
      <section className="flex min-h-0 flex-1 flex-col gap-3">
        <TaskHeader task={task} />
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {subagents.length > 0 ? (
              <Button
                size="sm"
                variant={subagentOpen ? "primary" : "default"}
                aria-label={`查看 Subagent，共 ${subagents.length} 个`}
                onClick={() => {
                  setSubagentOpen((value) => !value);
                  if (!selectedSubagentId) setSelectedSubagentId(subagents[0]?.id ?? "");
                }}
              >
                Subagent {subagents.length}
              </Button>
            ) : null}
            <Button size="sm" onClick={() => openModal({ type: "task-sources", taskId: task.id })}>
              添加目录
            </Button>
            {!directoryOnly && !task.archived ? (
              <Button size="sm" onClick={() => openModal({ type: "delivery", taskId: task.id })}>
                审阅与交付
              </Button>
            ) : null}
            {availablePanels.map((panel) => (
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

        {subagents.length > 0 ? (
          <SessionSubagentList
            agents={subagents}
            selectedId={selectedSubagentId}
            onSelect={(id) => {
              setSelectedSubagentId(id);
              setSubagentOpen(true);
            }}
          />
        ) : null}

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
              {panel === "runtime" && !directoryOnly ? (
                <RuntimePanel
                  task={task}
                  readonly={session.permission === "read"}
                  onReadonlyAttempt={() => pushToast("当前是只读会话，请先调整会话权限")}
                  onToggleService={(serviceId, running) => {
                    void useHostStore.getState().setServiceRunning(task.id, serviceId, running);
                  }}
                  onSetServiceMode={(serviceId, mode) => {
                    void useHostStore.getState().setServiceMode(task.id, serviceId, mode);
                    pushToast("依赖去向已模拟重新解析");
                  }}
                />
              ) : null}
              {panel === "browser" && !directoryOnly ? <BrowserPanel pages={task.browserPages} /> : null}
              {panel === "logs" && !directoryOnly ? <LogsPanel task={task} /> : null}
              {panel === "files" ? (
                directoryOnly ? (
                  <DirectoryFilesPanel task={task} />
                ) : activeDirectory ? (
                  <DirectoryFilesPanel task={task} selectedId={activeDirectory.id} onSelect={setActiveDirectoryId} />
                ) : (
                  <div className="flex flex-col gap-3">
                    {hasDirectories ? <DirectoryRootChoices task={task} selected={undefined} onSelect={setActiveDirectoryId} /> : null}
                    <FilesPanel files={task.files} />
                  </div>
                )
              ) : null}
              {panel === "terminal" ? (
                directoryOnly ? (
                  <DirectoryTerminalPanel task={task} />
                ) : activeDirectory ? (
                  <DirectoryTerminalPanel task={task} selectedId={activeDirectory.id} onSelect={setActiveDirectoryId} />
                ) : (
                  <div className="flex flex-col gap-3">
                    {hasDirectories ? <DirectoryRootChoices task={task} selected={undefined} onSelect={setActiveDirectoryId} /> : null}
                    <TerminalPanel taskId={task.id} seed={task.terminalSeed} />
                  </div>
                )
              ) : null}
            </Panel>
          ))}
        </aside>
      ) : null}

      {subagentOpen && subagents.length > 0 ? (
        <aside className="w-[360px] shrink-0 overflow-auto" data-testid="subagent-sidebar">
          <SubagentPanel
            agents={subagents}
            selectedId={selectedSubagentId}
            parentLabel={task.name}
            sessionName={session.name}
            onSelect={setSelectedSubagentId}
          />
        </aside>
      ) : null}
    </div>
  );
}

const COMPOSER_COMMANDS = [
  { name: "/new", detail: "新建会话" },
  { name: "/model", detail: "切换 Provider / 模型" },
  { name: "/compact", detail: "压缩当前上下文" },
  { name: "/skills", detail: "查看可用技能" },
  { name: "/session", detail: "当前会话信息" },
  { name: "/usage", detail: "查看 Token 用量" },
  { name: "/help", detail: "查看命令说明" },
];

function panelName(panel: ToolPanel) {
  return { runtime: "运行", browser: "浏览器", files: "文件", terminal: "终端", logs: "日志" }[panel];
}

/**
 * [PiDock 02] task header: name / repos / branch / ready-state /
 * code-change, read from the task record + session state. The branch and
 * root shown here are the values stored at creation (local settings in
 * dev/memory, `task.json` through the shell); errors stay bound to this
 * task id so a failure never surfaces as another task's header.
 */
function TaskHeader({ task }: { task: Task }) {
  const adapter = useHostStore((state) => state.adapter);
  // [PiDock 02] the header reads the same `getTaskHeader` contract the
  // provision tests lock (name/repo/branch/ready/code-change + task-bound
  // error); `getTaskProvision` is not a second header source — the header
  // falls back to the task record only when the adapter predates the seam.
  const [branch, setBranch] = useState(`task/${task.workspaceKey}`);
  const [root, setRoot] = useState(task.workspaceRoot);
  const [ready, setReady] = useState(task.repos.length > 0 || task.directories.length > 0);
  const [headerError, setHeaderError] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const header = adapter.getTaskHeader;
    if (typeof header === "function") {
      void header
        .call(adapter, task.id)
        .then((state) => {
          if (cancelled) return;
          setBranch(state.branch);
          setRoot(state.root);
          setReady(state.ready);
          setHeaderError(state.error);
        })
        .catch((error: unknown) => {
          if (!cancelled) setHeaderError(error instanceof Error ? error.message : String(error));
        });
      return () => {
        cancelled = true;
      };
    }
    void adapter
      .getTaskProvision?.(task.id)
      .then((provision) => {
        if (cancelled || !provision) return;
        setBranch(provision.branch);
        setRoot(provision.root);
        setReady(provision.ready);
        setHeaderError(provision.lastError ? `${provision.lastError.code}: ${provision.lastError.message}` : undefined);
      })
      .catch((error: unknown) => {
        if (!cancelled) setHeaderError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [adapter, task.id]);
  const project = useHostStore((state) => state.project(task.projectId));
  const repoNames = task.repos.map((id) => project?.repositories.find((r) => r.id === id)?.name ?? id);
  const changedCount = task.files.length;
  const directoryOnly = task.repos.length === 0 && task.directories.length > 0;
  return (
    <header className="flex flex-wrap items-center justify-between gap-3" data-testid={`task-header-${task.id}`}>
      <div>
        {directoryOnly ? <div className="text-[11px] tracking-wide text-muted">TASK · 普通目录</div> : null}
        <div className="flex items-center gap-3">
          <h1 className="text-base font-medium text-ink">{task.name}</h1>
          <Badge>{task.workspaceKey}</Badge>
          {task.directories.length > 0 && !directoryOnly ? <Badge>{task.directories.length} 个普通目录</Badge> : null}
          {task.archived ? <Badge tone="warn">已归档</Badge> : null}
          <Badge tone={ready ? "accent" : "neutral"}>{ready ? "已就绪" : "准备中"}</Badge>
        </div>
        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted">
          <span>仓库：{repoNames.length > 0 ? repoNames.join("、") : "—"}</span>
          <span className="font-mono">分支：{branch}</span>
          <span className="font-mono">目录：{root}/{task.workspaceKey}</span>
          <span>代码变化：{changedCount > 0 ? `${changedCount} 个文件` : "无"}</span>
        </p>
        {directoryOnly ? (
          <p className="mt-1 text-[11px] text-muted">
            {task.directories.length} 个普通目录 · 通过软链接加入 · 修改影响原目录，不提供 Git 分支／差异／提交
          </p>
        ) : null}
        {headerError ? (
          <p role="alert" className="mt-1 text-[11px] text-orange">
            本任务异常：{headerError}
          </p>
        ) : null}
      </div>
    </header>
  );
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
  const openModal = useUiStore((state) => state.openModal);
  const pushToast = useUiStore((state) => state.pushToast);
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
          {run.state === "failed" ? (
            <Button size="sm" onClick={() => openModal({ type: "retry", taskId, sessionId })}>
              检查并重试
            </Button>
          ) : null}
          {run.state === "expired" ? (
            <Button size="sm" onClick={() => pushToast("已移出关注列表，执行记录保留")}>
              标记已处理
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
  const createSession = useHostStore((state) => state.createSession);
  const compactSessionContext = useHostStore((state) => state.compactSessionContext);
  const workspace = useHostStore((state) => state.workspace);
  const navigate = useNavigationStore((state) => state.navigate);
  const pushToast = useUiStore((state) => state.pushToast);
  const openModal = useUiStore((state) => state.openModal);
  const approvals = useHostStore((state) => state.approvals);
  const providers = useHostStore((state) => state.workspace?.providers ?? []);
  const [sending, setSending] = useState(false);

  const approval = approvals.find((item) => item.taskId === task.id && item.sessionId === sessionId);
  const provider = providers.find((item) => item.id === session?.providerId);
  const model = provider?.models.find((item) => item.id === session?.model);
  const permissionLabel = { read: "只读", default: "默认权限", auto: "自动执行" }[session?.permission ?? "default"];
  const thinkingLevel = session?.thinking ?? model?.thinking?.default;
  const thinkingLabel = model?.thinking?.mode === "custom" ? `推理 · ${thinkingLevel ?? "待选择"}` : "推理 · 跟随模型";
  const attachInput = useRef<HTMLInputElement | null>(null);
  const attachments = draft.references.filter((reference) => reference.kind === "attachment");
  const plainReferences = draft.references.filter((reference) => reference.kind !== "attachment");
  // Images require the selected model to declare image input; the prototype blocks
  // the send and keeps the draft rather than silently dropping the attachment.
  const hasUnsupportedImage = attachments.some((reference) => reference.previewUrl) && !model?.supportsImages;

  // Prototype `completions(symbol, query)`: @ lists task files/directories, $
  // lists enabled skills, / lists the app commands. The candidate list is shown
  // for a trailing token and inserts or dispatches on click (prototype's
  // `chooseCompletion` / `command()`).
  const completion = useMemo(() => {
    const match = /(?:^|\s)([@$/])([^\s]*)$/.exec(draft.text);
    if (!match) return null;
    const symbol = match[1];
    const query = match[2].toLowerCase();
    const items =
      symbol === "@"
        ? [
            ...task.files.map((file) => ({ name: file.path, detail: "当前任务文件" })),
            ...task.directories.map((directory) => ({ name: `${directory.linkName}/`, detail: `${directory.name} → ${directory.path} · 软链接` })),
          ]
        : symbol === "$"
          ? (workspace?.capabilities ?? [])
              .filter((capability) => capability.kind === "skill" && capability.status === "enabled")
              .map((capability) => ({ name: capability.name, detail: `${capability.source} · 已启用技能` }))
          : COMPOSER_COMMANDS;
    const filtered = items.filter((item) => `${item.name} ${item.detail}`.toLowerCase().includes(query));
    return filtered.length > 0 ? { symbol, items: filtered } : null;
  }, [draft.text, task.files, task.directories, workspace?.capabilities]);

  const stripCompletionToken = () => setText(task.id, sessionId, draft.text.replace(/(?:^|\s)[@$/][^\s]*$/, "").trimEnd());

  const runCommand = async (name: string) => {
    stripCompletionToken();
    if (name === "/new") {
      const created = await createSession(task.id);
      pushToast("当前任务中新建会话，worktree 与原会话保留");
      navigate({ view: "task", projectId: task.projectId, taskId: task.id, sessionId: created.id });
    } else if (name === "/model") {
      openModal({ type: "model-picker", taskId: task.id, sessionId });
    } else if (name === "/compact") {
      await compactSessionContext(task.id, sessionId);
      pushToast("已模拟上下文压缩；累计 Token 保留");
    } else if (name === "/usage") {
      navigate({ view: "usage" });
    } else if (name === "/skills") {
      openModal({ type: "composer-info", taskId: task.id, topic: "skills" });
    } else if (name === "/session") {
      openModal({ type: "composer-info", taskId: task.id, topic: "session" });
    } else if (name === "/help") {
      openModal({ type: "composer-info", taskId: task.id, topic: "help" });
    }
  };

  const chooseCompletion = (name: string, detail: string) => {
    if (completion?.symbol === "/") {
      void runCommand(name);
      return;
    }
    const isSkill = completion?.symbol === "$";
    addReference(task.id, sessionId, {
      id: `${isSkill ? "skill" : "file"}-${name}`,
      kind: isSkill ? "skill" : "file",
      label: name,
      detail,
    });
    stripCompletionToken();
  };

  return (
    <div className="flex flex-col gap-2">
      {approval ? <ApprovalCard approval={approval} /> : null}
      <form
        className="rounded-panel border border-line bg-paper px-3 py-2.5"
        onSubmit={async (event) => {
          event.preventDefault();
          const text = draft.text.trim();
          if (!text || sending) return;
          // A bare command runs the app command instead of sending a message
          // (prototype `send()`).
          if (/^\/\S+$/.test(text) && !draft.references.length) {
            await runCommand(text);
            return;
          }
          if (hasUnsupportedImage) {
            pushToast("当前模型未启用图片输入，请移除图片或选择支持图片的模型");
            return;
          }
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
        {attachments.length > 0 ? (
          <ul className="mb-2 flex flex-wrap gap-2" data-testid="composer-attachments">
            {attachments.map((reference) => (
              <li key={reference.id} className="flex items-center gap-2 rounded-md border border-line bg-soft px-2 py-1 text-[11px] text-muted">
                {reference.previewUrl ? (
                  <img src={reference.previewUrl} alt={reference.label} className="h-8 w-8 rounded object-cover" data-testid={`attachment-image-${reference.id}`} />
                ) : null}
                <span>{reference.label}</span>
                <button type="button" aria-label={`移除附件 ${reference.label}`} onClick={() => removeReference(task.id, sessionId, reference.id)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {hasUnsupportedImage ? (
          <p className="mb-2 flex items-center gap-2 text-[11px] text-orange" role="status">
            当前模型未启用图片输入，请切换模型后发送。
            <Button size="sm" onClick={() => openModal({ type: "model-picker", taskId: task.id, sessionId })}>
              选择模型
            </Button>
          </p>
        ) : null}
        {plainReferences.length > 0 ? (
          <ul className="mb-2 flex flex-wrap gap-1.5">
            {plainReferences.map((reference) => (
              <li key={reference.id} className="flex items-center gap-1 rounded-full border border-line bg-soft px-2 py-0.5 text-[11px] text-muted">
                引用 · {reference.label}
                <button type="button" aria-label={`移除引用 ${reference.label}`} onClick={() => removeReference(task.id, sessionId, reference.id)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {completion ? (
          <ul role="listbox" aria-label="输入候选" className="mb-2 max-h-40 overflow-auto rounded-md border border-line bg-paper text-xs">
            {completion.items.slice(0, 8).map((item) => (
              <li key={item.name}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="flex w-full items-center justify-between gap-3 px-2.5 py-1.5 text-left hover:bg-soft"
                  onClick={() => chooseCompletion(item.name, item.detail)}
                >
                  <span className="font-mono text-[11px] text-ink">{item.name}</span>
                  <small className="text-muted">{item.detail}</small>
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
            <Button size="sm" variant="ghost" aria-label="添加附件" onClick={() => attachInput.current?.click()}>
              +
            </Button>
            <input
              ref={attachInput}
              type="file"
              multiple
              aria-label="附件选择"
              className="hidden"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                files.forEach((file) => {
                  const isImage = file.type.startsWith("image/");
                  const previewUrl =
                    isImage && typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
                      ? URL.createObjectURL(file)
                      : undefined;
                  addReference(task.id, sessionId, {
                    id: `attach-${Date.now()}-${file.name}`,
                    kind: "attachment",
                    label: file.name,
                    detail: isImage ? "图片附件 · 仅本页预览" : "文件附件 · 仅保留名称",
                    previewUrl,
                  });
                });
                event.target.value = "";
              }}
            />
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
            <Button
              size="sm"
              variant="ghost"
              aria-label={`选择权限：${permissionLabel}`}
              onClick={() => openModal({ type: "permission", taskId: task.id, sessionId })}
            >
              {permissionLabel}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`选择模型：${session?.model ?? "未选择"}`}
              onClick={() => openModal({ type: "model-picker", taskId: task.id, sessionId })}
            >
              {session?.model ?? "模型"} · 上下文 {session?.contextUsed ?? 0}k / {session?.contextWindow ?? 0}k
            </Button>
            {model?.thinking && model.thinking.mode !== "none" ? (
              <Button
                size="sm"
                variant="ghost"
                aria-label="选择推理档位"
                onClick={() => openModal({ type: "thinking-picker", taskId: task.id, sessionId })}
              >
                {thinkingLabel}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              aria-label="查看上下文占用"
              onClick={() => openModal({ type: "context", taskId: task.id, sessionId })}
            >
              上下文 {session?.contextUsed ?? 0}k / {session?.contextWindow ?? 0}k
            </Button>
          </div>
          <Button size="sm" variant="primary" type="submit" disabled={sending || session?.permission === "read" || hasUnsupportedImage}>
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
