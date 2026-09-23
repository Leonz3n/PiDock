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
  ProtocolPanel,
  RuntimePanel,
  SessionSubagentList,
  SubagentPanel,
  TerminalPanel,
} from "../components/ToolPanels";
import type { Approval, Message, Reference, Session, Task } from "../data/types";
import {
  BUILTIN_COMMANDS,
  activeCompletionToken,
  checkDraftReference,
  referenceProvenance,
  commandCandidates,
  describeReferenceChip,
  fileCandidates,
  resolveComposerKey,
  skillCandidates,
  suggestCommand,
  type CandidateRow,
} from "../data/composerRules";
import { isDirectoryOnlyTask } from "../data/directories";
import {
  SESSION_MENU_LABEL,
  sessionMenuActions,
  sessionTabLabel,
  visibleSessionTabs,
  type SessionMenuAction,
} from "../data/sessionNav";
import {
  sessionWriteRoleLabel,
  writeCoordinationSummary,
  writeCoordinationVisible,
  type SessionWriteState,
} from "../data/writeCoordination";
import { approvalStatusLabel, runStateLabel } from "./runState";
import { sessionKeyOf } from "../data/sessionKey";
import { describeContextDisplay, describeHistoryAttribution, formatTokens, resolveSessionThinking } from "../data/providerState";
import type { ServiceTopologyView } from "../data/serviceTopology";
import { projectProtocolBinding, type ProtocolBindingView } from "../data/protocolBinding";
import type { TerminalPlanView, TerminalStateView, WorkspaceBrowserView } from "../data/workspaceFiles";
import { useDraftStore } from "../stores/drafts";
import { useEventsStore } from "../stores/events";
import { useHostStore } from "../stores/host";
import { useWriteLockStore } from "../stores/writeLock";
import { TOOL_PANELS, useUiStore, type ToolPanel } from "../stores/ui";
import { useNavigationStore } from "../stores/navigation";

const EMPTY_PANELS: ToolPanel[] = [];
const EMPTY_LIVE: Message[] = [];
const EMPTY_DRAFT: { text: string; references: Reference[] } = { text: "", references: [] };
const EMPTY_REFERENCE: Reference = { id: "empty", kind: "file", label: "", detail: "" };

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
  // [PiDock 05] (#10) topology view for the runtime panel: the adapter's
  // projection (the Host plan when the shell answers `task/planServiceGroup`).
  const [serviceTopology, setServiceTopology] = useState<ServiceTopologyView | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void useHostStore
      .getState()
      .serviceTopology(task.id)
      .then((view) => {
        if (!cancelled) setServiceTopology(view);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [task.id, task.services]);
  // [PiDock 08] (#14) protocol plan + consumer binding view for the protocol
  // panel: the Host state when the shell answers `task/protocolState`, the
  // in-memory projection otherwise.
  const [protocolBinding, setProtocolBinding] = useState<ProtocolBindingView | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void useHostStore
      .getState()
      .protocolBinding(task.id)
      .then((view) => {
        if (!cancelled) setProtocolBinding(view);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [task.id, task.repos]);
  // [PiDock 10] (#15) file browser + terminal views. Both are loaded on demand
  // (only while their panel is open), so an unopened tool creates no resource:
  // no Host read, no terminal plan.
  const [workspaceBrowser, setWorkspaceBrowser] = useState<WorkspaceBrowserView | undefined>(undefined);
  const [browserRootId, setBrowserRootId] = useState<string | undefined>(undefined);
  const [browserRelative, setBrowserRelative] = useState<string | undefined>(undefined);
  const [terminalPlan, setTerminalPlan] = useState<TerminalPlanView | undefined>(undefined);
  const [terminalState, setTerminalState] = useState<TerminalStateView | undefined>(undefined);
  const [terminalError, setTerminalError] = useState<string | undefined>(undefined);
  const panelsOpen = useUiStore((state) => state.panels[task.id] ?? EMPTY_PANELS);
  const filesPanelOpen = panelsOpen.includes("files");
  const terminalPanelOpen = panelsOpen.includes("terminal");
  useEffect(() => {
    if (!filesPanelOpen) return;
    let cancelled = false;
    void useHostStore
      .getState()
      .workspaceBrowser(task.id, {
        ...(browserRootId !== undefined ? { rootId: browserRootId } : {}),
        ...(browserRelative !== undefined && browserRelative.length > 0 ? { relative: browserRelative } : {}),
      })
      .then((view) => {
        if (!cancelled) setWorkspaceBrowser(view);
      })
      .catch((error: unknown) => {
        if (!cancelled) pushToast(error instanceof Error ? error.message : "文件面板加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [filesPanelOpen, task.id, task.repos, browserRootId, browserRelative, pushToast]);
  useEffect(() => {
    if (!terminalPanelOpen) return;
    let cancelled = false;
    void useHostStore
      .getState()
      .terminalState(task.id)
      .then((state) => {
        if (!cancelled) setTerminalState(state);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [terminalPanelOpen, task.id, task.repos]);
  // Plan first (cwd + resolved env + owner), then run the same start request:
  // the Host re-plans at start time, so what the user sees before starting is
  // exactly what the gated start uses.
  const startTerminal = () => {
    const rootId = workspaceBrowser?.roots[0]?.id ?? task.repos[0];
    if (rootId === undefined) {
      pushToast("本任务没有可用的文件根，无法打开终端");
      return;
    }
    const instanceId = `term-${task.id}-1`;
    void useHostStore
      .getState()
      .planTerminal(task.id, { instanceId, rootId, program: "bash", args: ["-l"], sessionId: session.id })
      .then(async (plan) => {
        setTerminalPlan(plan);
        await useHostStore.getState().controlTerminal(task.id, {
          instanceId: plan.instanceId,
          action: "start",
          rootId: plan.rootId,
          program: plan.program,
          args: plan.args,
          sessionId: session.id,
        });
        setTerminalState(await useHostStore.getState().terminalState(task.id));
        setTerminalError(undefined);
      })
      .catch((error: unknown) => setTerminalError(error instanceof Error ? error.message : "终端计划失败"));
  };
  const controlTerminal = (action: "start" | "stop", instanceId?: string) => {
    const target = instanceId ?? terminalPlan?.instanceId;
    if (target === undefined) return;
    const rootId = terminalPlan?.rootId ?? workspaceBrowser?.roots[0]?.id;
    void useHostStore
      .getState()
      .controlTerminal(task.id, {
        instanceId: target,
        action,
        ...(rootId !== undefined ? { rootId } : {}),
        program: terminalPlan?.program ?? "bash",
        ...(terminalPlan ? { args: terminalPlan.args } : {}),
        sessionId: session.id,
      })
      .then(() => useHostStore.getState().terminalState(task.id))
      .then((state) => {
        setTerminalState(state);
        setTerminalError(undefined);
      })
      .catch((error: unknown) => setTerminalError(error instanceof Error ? error.message : "终端操作失败"));
  };

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

  // [PiDock 09] (#11): tabs keep the creation order (at most four) and the
  // hidden active session takes the last slot; the coordination bar below the
  // tabs shows who holds the task write right.
  const visibleSessions = visibleSessionTabs(task.sessions, session.id);

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

        <WriteCoordinationBar task={task} />

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
                  {...(serviceTopology !== undefined ? { topology: serviceTopology } : {})}
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
              {panel === "protocol" && !directoryOnly ? <ProtocolPanel view={protocolBinding ?? projectProtocolBinding(task)} /> : null}
              {panel === "browser" && !directoryOnly ? (
                <BrowserPanel
                  pages={task.browserPages}
                  taskId={task.id}
                  sessionId={session.id}
                  permission={session.permission}
                />
              ) : null}
              {panel === "logs" && !directoryOnly ? <LogsPanel task={task} /> : null}
              {panel === "files" ? (
                directoryOnly ? (
                  <DirectoryFilesPanel task={task} />
                ) : activeDirectory ? (
                  <DirectoryFilesPanel task={task} selectedId={activeDirectory.id} onSelect={setActiveDirectoryId} />
                ) : (
                  <div className="flex flex-col gap-3">
                    {hasDirectories ? <DirectoryRootChoices task={task} selected={undefined} onSelect={setActiveDirectoryId} /> : null}
                    <FilesPanel
                      files={task.files}
                      {...(workspaceBrowser !== undefined ? { browser: workspaceBrowser } : {})}
                      onSelectRoot={(rootId) => {
                        setBrowserRootId(rootId);
                        setBrowserRelative(undefined);
                      }}
                      onSelectFile={(relative) => setBrowserRelative(relative)}
                    />
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
                    <>
                      {terminalError ? <p className="text-[11px] text-warn">{terminalError}</p> : null}
                      <TerminalPanel
                        taskId={task.id}
                        seed={task.terminalSeed}
                        terminal={{
                          ...(terminalPlan !== undefined ? { plan: terminalPlan } : {}),
                          ...(terminalState !== undefined ? { state: terminalState } : {}),
                          onStart: startTerminal,
                          onStop: (instanceId: string) => controlTerminal("stop", instanceId),
                        }}
                      />
                    </>
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
  return { runtime: "运行", protocol: "协议", browser: "浏览器", files: "文件", terminal: "终端", logs: "日志" }[panel];
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

function SessionTabs({
  task,
  visibleSessions,
  activeSessionId,
}: {
  task: Task;
  visibleSessions: ReturnType<typeof visibleSessionTabs>;
  activeSessionId: string;
}) {
  const openModal = useUiStore((state) => state.openModal);
  const navigate = useNavigationStore((state) => state.navigate);
  const pushToast = useUiStore((state) => state.pushToast);
  const stopRun = useHostStore((state) => state.stopRun);
  const archiveSession = useHostStore((state) => state.archiveSession);
  const view = useWriteLockStore((state) => state.views[task.id]);
  const [menu, setMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  const roles = new Map<string, SessionWriteState>((view?.sessions ?? []).map((state) => [state.sessionId, state]));

  const runAction = async (action: SessionMenuAction, session: Session) => {
    setMenu(null);
    if (action === "open") navigate({ view: "task", projectId: task.projectId, taskId: task.id, sessionId: session.id });
    else if (action === "rename")
      openModal({ type: "rename-session", taskId: task.id, sessionId: session.id, value: session.name });
    else if (action === "archive" || action === "restore") {
      await archiveSession(task.id, session.id, action === "archive");
      pushToast(action === "archive" ? "会话已归档，可在全部会话中查看或恢复" : "会话已恢复");
    } else if (action === "stop") {
      // Abort entry ([PiDock 09] #11 box 2): ends this session's write right
      // and frees the queue.
      await stopRun(task.id, session.id);
      pushToast(`${session.name} 已中止，写操作权已释放`);
    } else openModal({ type: "sessions", taskId: task.id, filter: session.archived ? "archived" : "active" });
  };

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" onClick={() => openModal({ type: "sessions", taskId: task.id, filter: "active" })}>
        全部会话 {task.sessions.length}
      </Button>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {visibleSessions.map((session) => {
          const role = roles.get(session.id);
          const roleLabel = role ? sessionWriteRoleLabel(role) : null;
          const active = session.id === activeSessionId;
          return (
            <button
              key={session.id}
              type="button"
              data-testid={`session-tab-${session.id}`}
              onClick={() => runAction("open", session)}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ sessionId: session.id, x: event.clientX, y: event.clientY });
              }}
              title={`${session.name} · 右键操作`}
              className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs ${
                active ? "border-accent/40 bg-accent/10 text-accent" : "border-line bg-paper text-muted hover:text-ink"
              } ${active ? "" : "hidden md:flex"}`}
            >
              {/* Bounded label: a long name never widens the navigation. */}
              <span className="max-w-[9rem] truncate">{sessionTabLabel(session.name)}</span>
              {session.archived ? <Badge>已归档</Badge> : session.permission === "read" ? <Badge>只读</Badge> : null}
              {roleLabel ? <Badge tone={role?.role === "owner" ? "accent" : "warn"}>{roleLabel}</Badge> : null}
            </button>
          );
        })}
      </div>
      {menu ? (
        <SessionContextMenu
          label={task.sessions.find((session) => session.id === menu.sessionId)?.name ?? "会话"}
          point={{ x: menu.x, y: menu.y }}
          actions={sessionMenuActions(
            task.sessions.find((session) => session.id === menu.sessionId) ?? { archived: false, runState: "idle" },
            {
              isOwner: roles.get(menu.sessionId)?.role === "owner",
              isWaiting: roles.get(menu.sessionId)?.role === "waiting",
            },
          )}
          onSelect={(action) => {
            const session = task.sessions.find((item) => item.id === menu.sessionId);
            if (session) void runAction(action, session);
            else setMenu(null);
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}
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

/**
 * Right-click menu for one session tab ([PiDock 09] #11 收口：搜索归档列表及右键
 * 菜单). The actions are derived by `sessionMenuActions`, so a session that owns
 * or waits on the write right always offers the abort entry.
 */
function SessionContextMenu({
  label,
  point,
  actions,
  onSelect,
  onClose,
}: {
  label: string;
  point: { x: number; y: number };
  actions: SessionMenuAction[];
  onSelect: (action: SessionMenuAction) => void;
  onClose: () => void;
}) {
  return (
    <div
      data-testid="session-context-menu"
      className="fixed z-50 w-44 rounded-md border border-line bg-paper p-1 shadow-lg"
      style={{ left: point.x, top: point.y }}
    >
      <p className="px-2 py-1 text-[11px] text-muted">{label}</p>
      {actions.map((action) => (
        <button
          key={action}
          type="button"
          role="menuitem"
          className="block w-full rounded px-2 py-1 text-left text-xs text-ink hover:bg-soft"
          onClick={() => onSelect(action)}
        >
          {SESSION_MENU_LABEL[action]}
        </button>
      ))}
      <button type="button" role="menuitem" className="block w-full rounded px-2 py-1 text-left text-xs text-muted hover:bg-soft" onClick={onClose}>
        关闭
      </button>
    </div>
  );
}

/**
 * Task write-coordination bar ([PiDock 09] #11 box 2): holder (+ what the right
 * is held for), the queue with positions, derived executions, leftover
 * resources and the abort entry for the holder. Rendered only when there is
 * something to coordinate, so an idle task gets no extra chrome.
 */
function WriteCoordinationBar({ task }: { task: Task }) {
  const view = useWriteLockStore((state) => state.views[task.id]);
  const load = useWriteLockStore((state) => state.load);
  const stopRun = useHostStore((state) => state.stopRun);
  const pushToast = useUiStore((state) => state.pushToast);
  const lock = view?.writeLock ?? task.writeLock;
  useEffect(() => {
    void load(task.id);
  }, [load, task.id, task.sessions]);
  const state: Pick<Task, "sessions" | "writeLock"> = { sessions: task.sessions, ...(lock !== undefined ? { writeLock: lock } : {}) };
  if (!writeCoordinationVisible(state)) return null;
  const queue = (lock?.waiting ?? [])
    .map((sessionId, index) => `${task.sessions.find((session) => session.id === sessionId)?.name ?? sessionId}（第 ${index + 1} 位）`)
    .join("、");
  return (
    <Panel
      title="任务写操作权"
      actions={
        lock?.owner ? (
          <Button
            size="sm"
            onClick={async () => {
              const owner = lock.owner as string;
              await stopRun(task.id, owner);
              pushToast("已中止持有写操作权的会话");
            }}
          >
            中止持有者
          </Button>
        ) : null
      }
    >
      <p className="text-xs text-ink" data-testid="write-coordination">
        {writeCoordinationSummary(state)}
      </p>
      {queue.length > 0 ? <p className="mt-1 text-[11px] text-muted">排队：{queue}（持有者释放后重试即可写入）</p> : null}
      {(lock?.orphans ?? []).length > 0 ? (
        <p className="mt-1 text-[11px] text-orange" data-testid="write-orphans">
          遗留执行资源待核验：{(lock?.orphans ?? []).map((orphan) => orphan.label ?? orphan.resourceId).join("、")}；请先停止后再由新会话写入
        </p>
      ) : null}
      <p className="mt-1 text-[11px] text-muted">同一任务同时只有一个会话持有写操作权；只读会话不持有，读取与分析不受影响。</p>
    </Panel>
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

/**
 * Per-response attribution: the configured display name when it still exists,
 * an explicit unavailable note when the account was renamed/disabled/removed.
 */
function MessageAttribution({ attribution }: { attribution: { providerId: string; model: string } }) {
  const providers = useHostStore((state) => state.workspace?.providers ?? []);
  const resolved = describeHistoryAttribution(providers, attribution);
  const label = `${resolved.providerName ?? resolved.providerId} / ${resolved.modelName ?? resolved.model}`;
  return (
    <span
      className={`rounded-full border px-1.5 py-0.5 text-[10px] ${resolved.availability === "available" ? "border-line text-muted" : "border-orange/35 text-orange"}`}
      data-testid={`message-attribution-${attribution.providerId}`}
    >
      {label}
      {resolved.availability === "available" ? "" : ` · ${resolved.message ?? "配置不可用"}`}
    </span>
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
            <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted">
              <span>{message.role === "user" ? "你" : "Agent"}</span>
              {message.attribution !== undefined ? <MessageAttribution attribution={message.attribution} /> : null}
            </div>
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
  // [PiDock 11] #9: the composer shows the effective reasoning level
  // (declared-session pick -> model default -> catalog unknown) and flags a
  // stale preference instead of pretending it still applies.
  const thinkingResolved = resolveSessionThinking(model, session?.thinking);
  const thinkingLabel =
    thinkingResolved.catalog === "unsupported"
      ? "推理 · 不支持"
      : thinkingResolved.level.length > 0
        ? `推理 · ${thinkingResolved.level}${thinkingResolved.source === "model-default" ? "（模型默认）" : ""}`
        : "推理 · 跟随模型";
  const contextDisplay = describeContextDisplay({
    used: session?.contextUsed ?? 0,
    window: session?.contextWindow ?? 0,
    source: session?.contextSource ?? "actual",
  });
  const attribution = describeHistoryAttribution(providers, { providerId: session?.providerId ?? "", model: session?.model ?? "" });
  const switchLocked = session?.runState === "running" || session?.runState === "approval";
  const attachInput = useRef<HTMLInputElement | null>(null);
  // [PiDock 13] (#16): the composer keeps its own candidate list, caret and
  // dismissal state so the marker rules can be exercised without the DOM.
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState(0);
  const [completionDismissed, setCompletionDismissed] = useState(false);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [expandedReference, setExpandedReference] = useState<string | null>(null);
  const attachments = draft.references.filter((reference) => reference.kind === "attachment");
  const plainReferences = draft.references.filter((reference) => reference.kind !== "attachment");
  // Images require the selected model to declare image input; the prototype blocks
  // the send and keeps the draft rather than silently dropping the attachment.
  const hasUnsupportedImage = attachments.some((reference) => reference.previewUrl) && !model?.supportsImages;

  // [PiDock 13] (#16): one candidate source per symbol — `@` searches the
  // task's worktree files and plain-directory links together, `$` searches
  // enabled skills with their source kept distinct, `/` lists the app
  // commands with source/args/availability for the current run state.
  const completion = useMemo(() => {
    const token = activeCompletionToken(draft.text, caret);
    if (!token || completionDismissed) return null;
    const runContext = {
      runState: (session?.runState ?? "idle") as "idle" | "running" | "approval" | "stopped" | "failed",
      permission: session?.permission ?? "default",
    };
    const groups =
      token.symbol === "/"
        ? commandCandidates(BUILTIN_COMMANDS, token.query, runContext)
        : [
            {
              category: "app" as const,
              items: token.symbol === "@" ? fileCandidates(task, token.query) : skillCandidates(workspace?.capabilities ?? [], token.query),
            },
          ];
    const items = groups.flatMap((group) => group.items);
    return items.length > 0 ? { token, symbol: token.symbol, groups, items } : null;
  }, [draft.text, caret, completionDismissed, task, session?.runState, session?.permission, workspace?.capabilities]);

  const stripCompletionToken = () => {
    const token = completion?.token;
    if (!token) return;
    setText(task.id, sessionId, `${draft.text.slice(0, token.start)}${draft.text.slice(token.end)}`);
  };

  const insertCompletionValue = (value: string) => {
    const token = completion?.token;
    if (!token) return;
    const next = `${draft.text.slice(0, token.start)}${value} ${draft.text.slice(token.end)}`;
    setText(task.id, sessionId, next);
    setCaret(token.start + value.length + 1);
  };

  const runCommand = async (name: string) => {
    stripCompletionToken();
    if (name === "/new") {
      const created = await createSession(task.id);
      pushToast("当前任务中新建会话，worktree 与原会话保留");
      navigate({ view: "task", projectId: task.projectId, taskId: task.id, sessionId: created.id });
    } else if (name === "/model") {
      openModal({ type: "model-picker", taskId: task.id, sessionId });
    } else if (name === "/compact") {
      // [PiDock 11] #9: a busy round refuses compaction. The reason has to
      // reach the user; `runCommand` is fire-and-forget at the call site.
      try {
        await compactSessionContext(task.id, sessionId);
        pushToast("已压缩上下文；占用标记为待更新，累计 Token 保留");
      } catch (error) {
        pushToast(error instanceof Error ? error.message : String(error));
      }
    } else if (name === "/usage") {
      navigate({ view: "usage" });
    } else if (name === "/skills") {
      openModal({ type: "composer-info", taskId: task.id, topic: "skills" });
    } else if (name === "/session") {
      openModal({ type: "composer-info", taskId: task.id, topic: "session" });
    } else if (name === "/help") {
      openModal({ type: "composer-info", taskId: task.id, topic: "help" });
    } else {
      // Box 8: an unknown `/entry` is corrected instead of silently ignored.
      const known = COMPOSER_COMMANDS.map((command) => command.name);
      const suggestion = suggestCommand(name, known);
      pushToast(suggestion === null ? `未知命令 ${name}：请从候选列表选择，普通文字请直接输入` : `未知命令 ${name}，是否想输入 ${suggestion}？`);
    }
  };

  // Invalid draft references are reported per reference id (box 14/15); the
  // chip shows the reason and asks for a new selection instead of resolving
  // to another task's same-named file.
  const referenceIssues = useMemo(() => {
    const issues: Record<string, string> = {};
    for (const reference of draft.references) {
      const check = checkDraftReference(reference, task);
      if (check.state === "invalid") issues[reference.id] = check.message;
    }
    return issues;
  }, [draft.references, task]);

  const chooseCompletion = (row: CandidateRow) => {
    if (completion?.symbol === "/") {
      // Box 13: only an entry that can never run now is blocked here; a
      // "waiting" entry still runs and lets the operation itself enforce the
      // idle boundary (the adapter refuses a live round with its own reason).
      if (row.availability === "unavailable") {
        pushToast(row.reason ?? "当前状态下该命令不可用");
        return;
      }
      void runCommand(row.value);
      return;
    }
    const isSkill = completion?.symbol === "$";
    // The same provenance the `/skills` modal records; a worktree row pins the
    // commit it was picked at so a restored draft can be re-checked, and a
    // skill keeps its resource path plus any args already typed after `$name`.
    const typedArgs = isSkill ? (draft.text.slice(completion?.token.end ?? 0).trim()) : "";
    addReference(task.id, sessionId, {
      id: `${isSkill ? "skill" : "task"}-${row.key}`,
      kind: isSkill ? "skill" : row.kind === "directory" ? "directory" : "file",
      label: row.value,
      detail: row.detail,
      taskId: task.id,
      ...referenceProvenance(row),
      ...(isSkill && typedArgs.length > 0 ? { args: typedArgs } : {}),
    });
    insertCompletionValue(row.value);
    setCompletionDismissed(true);
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
          } catch (error) {
            // A refused write ([PiDock 09] #11) must say why instead of failing
            // silently: the Host text already names the task-lock holder, the
            // queue, or the shared real path that conflicts.
            pushToast(error instanceof Error ? error.message : "写入被拒绝，请稍后重试");
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
        {attribution.availability !== "available" ? (
          <p className="mb-2 flex items-center gap-2 text-[11px] text-orange" role="status" data-testid="session-provider-unavailable">
            当前配置不可用：{attribution.message ?? "请到 Provider 页检查配置"}
          </p>
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
            {plainReferences.map((reference) => {
              const issue = referenceIssues[reference.id];
              return (
                <li
                  key={reference.id}
                  className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${issue ? "border-orange text-orange" : "border-line bg-soft text-muted"}`}
                  data-testid={`composer-reference-${reference.id}`}
                  title={describeReferenceChip(reference)}
                >
                  {issue ? "失效 · " : "引用 · "}{reference.label}
                  <button
                    type="button"
                    aria-label={`${issue ? "重新选择" : "查看范围"} ${reference.label}`}
                    onClick={() =>
                      issue
                        ? (removeReference(task.id, sessionId, reference.id),
                          pushToast(`${issue}：请重新输入 @ 或 $ 选择来源`))
                        : setExpandedReference(expandedReference === reference.id ? null : reference.id)
                    }
                  >
                    {issue ? "重新选择" : "范围"}
                  </button>
                  <button type="button" aria-label={`移除引用 ${reference.label}`} onClick={() => removeReference(task.id, sessionId, reference.id)}>
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        {expandedReference ? (
          <p className="mb-2 text-[11px] text-muted" role="status" data-testid="composer-reference-scope">
            {describeReferenceChip(draft.references.find((reference) => reference.id === expandedReference) ?? EMPTY_REFERENCE)}
          </p>
        ) : null}
        {completion ? (
          <ul role="listbox" aria-label="输入候选" className="mb-2 max-h-40 overflow-auto rounded-md border border-line bg-paper text-xs">
            {completion.groups.map((group) => (
              <li key={group.category}>
                {completion.symbol === "/" ? (
                  <p className="px-2.5 pt-1.5 text-[10px] uppercase tracking-wide text-muted">
                    {group.category === "app" ? "应用操作" : group.category === "template" ? "提示模板" : "扩展命令"}
                  </p>
                ) : null}
                <ul>
                  {group.items.map((item) => {
                    const index = completion.items.indexOf(item);
                    return (
                      <li key={item.key}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={index === completionIndex}
                          disabled={item.availability === "unavailable"}
                          title={item.reason}
                          className={`flex w-full items-center justify-between gap-3 px-2.5 py-1.5 text-left hover:bg-soft ${index === completionIndex ? "bg-soft" : ""} ${item.availability === "unavailable" ? "opacity-60" : ""}`}
                          onClick={() => chooseCompletion(item)}
                        >
                          <span className="font-mono text-[11px] text-ink">{item.label}</span>
                          <small className="text-muted">
                            {item.source !== "PiDock" ? `${item.source} · ` : ""}
                            {item.detail}
                            {item.availability === "waiting" ? " · 等待空闲" : item.availability === "unavailable" ? ` · 不可用：${item.reason ?? ""}` : ""}
                          </small>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        ) : null}
        <textarea
          ref={textareaRef}
          aria-label="消息输入"
          value={draft.text}
          onChange={(event) => {
            setText(task.id, sessionId, event.target.value);
            setCaret(event.target.selectionStart ?? event.target.value.length);
            setCompletionDismissed(false);
            setCompletionIndex(0);
          }}
          onSelect={(event) => {
            setCaret(event.currentTarget.selectionStart ?? 0);
            setCompletionDismissed(false);
          }}
          onKeyDown={(event) => {
            // Box 11: the candidate list owns Tab/Enter/Esc/arrows while it is
            // open (confirming never sends), a plain Enter sends, Shift+Enter
            // breaks the line, and an IME composition confirm does nothing.
            const action = resolveComposerKey({
              key: event.key,
              shift: event.shiftKey,
              composing: event.nativeEvent.isComposing,
              candidateCount: completion ? completion.items.length : 0,
            });
            if (action === "ignore-composition" || action === "none" || action === "newline") return;
            if (action === "move-candidate-down" || action === "move-candidate-up") {
              event.preventDefault();
              const count = completion?.items.length ?? 0;
              if (count === 0) return;
              setCompletionIndex((index) => (action === "move-candidate-down" ? (index + 1) % count : (index - 1 + count) % count));
              return;
            }
            if (action === "close-candidate") {
              event.preventDefault();
              setCompletionDismissed(true);
              return;
            }
            if (action === "confirm-candidate") {
              event.preventDefault();
              const row = completion?.items[completionIndex];
              if (row) chooseCompletion(row);
              return;
            }
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
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
              aria-label={`选择权限：${permissionLabel}`}
              onClick={() => openModal({ type: "permission", taskId: task.id, sessionId })}
            >
              {permissionLabel}
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
              上下文 {formatTokens(contextDisplay.used * 1000)} / {formatTokens(contextDisplay.window * 1000)} Tokens
              {contextDisplay.percent === null ? " · 占比未知" : ` · ${contextDisplay.percent.toFixed(1)}%`}
              {contextDisplay.marker.length > 0 ? ` · ${contextDisplay.marker}` : ""}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              aria-label={`选择模型：${session?.model ?? "未选择"}`}
              title={switchLocked ? "执行中不可切换模型，请先等待完成或停止" : undefined}
              onClick={() => openModal({ type: "model-picker", taskId: task.id, sessionId })}
            >
              {provider?.name ? `${provider.name} · ` : ""}
              {session?.model ?? "模型"} · {session?.contextWindow ? `${formatTokens((session?.contextWindow ?? 0) * 1000)} Tokens` : "窗口未知"}
            </Button>
            <Button size="sm" variant="primary" type="submit" disabled={sending || session?.permission === "read" || hasUnsupportedImage}>
              发送消息
            </Button>
          </div>
        </div>
        <p className="mt-1.5 text-[11px] text-muted">
          图片与文件仅在本页预览，不写入业务仓库；真实 Host 接入在 02 中定义。
        </p>
      </form>
    </div>
  );
}
