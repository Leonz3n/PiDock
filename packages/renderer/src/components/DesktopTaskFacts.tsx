import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { DesktopTaskVariables } from "./DesktopVariables";
import { SHARED_DIR_MANAGED_PROTECTION } from "../data/sharedDirProtection";
import { fileRootsThroughShell, type PidockBridge } from "../data/shellBridge";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { createSession, readTaskSessions, subscribeSessionWrites, type SessionList } from "../data/taskSessions";
import {
  hostText,
  observedText,
  workspaceRootsFromHost,
  type WorkspaceModeView,
  type WorkspaceRootView,
  type WorkspaceVerificationView,
} from "../data/workspaceFiles";

/**
 * [Pencil UI U02] #157 / S08: an independent task facts destination.
 * The compact variant exposes read-only provenance on the separate session page.
 *
 * One row per real source — an independent worktree, an existing Git checkout
 * used in place, or a shared plain directory — with its mode badge, real path,
 * branch/HEAD where the source has Git, the shared-original wording, and the
 * per-source reopen verification result. A mixed task is never summarized as
 * one worktree, and a broken source names its state and repair path instead of
 * being hidden or falling back to a fixture.
 *
 * The only read here is the Host's `task/fileRoots` (which re-verifies the
 * record's identity on every open); the renderer derives nothing.
 */
const MODE_LABELS: Record<WorkspaceModeView, string> = {
  worktree: "独立 Worktree",
  "existing-git": "已有 Git 目录 · 共享原检出",
  "plain-dirs": "普通目录 · 共享原文件",
};
const VERIFICATION_LABELS: Record<WorkspaceVerificationView["state"], string> = {
  ready: "已核验",
  missing: "来源缺失",
  mismatch: "身份不符",
  "repair-required": "待修复",
  "branch-mismatch": "分支不符 · 需修复",
  "base-mismatch": "基线不符 · 需修复",
};
const VERIFICATION_STYLE: Record<WorkspaceVerificationView["state"], string> = {
  ready: "border-line text-muted",
  missing: "border-destructive text-destructive",
  mismatch: "border-destructive text-destructive",
  "repair-required": "border-orange text-orange",
  "branch-mismatch": "border-destructive text-destructive",
  "base-mismatch": "border-destructive text-destructive",
};

function rootBadge(root: WorkspaceRootView): string {
  if (root.kind === "worktree") return "独立 Git worktree (隔离副本)";
  if (root.kind === "existing-git") return "已有 Git 目录 · 共享原检出";
  return "普通目录 · 共享原文件";
}

function rootFact(root: WorkspaceRootView): string {
  if (root.kind === "worktree") {
    const branch = observedText(root.workingBranch, (value) => value, "Host 未上报工作分支");
    const base = root.baseCommit !== undefined && root.baseCommit.length > 0 ? ` @ ${root.baseCommit}` : "";
    // [Pencil T07] ticket 142: the LOCAL task branch, the worktree path, the pinned
    // base commit and the source checkout identity are four separate facts —
    // a row that showed only the observed branch would leave "which original
    // repository is this?" unanswerable on the facts surface.
    return `目标检出路径: ${hostText(root.path, "Host 未上报路径")} · 任务分支 ${hostText(root.expectedBranch, "Host 未上报任务分支")} · 工作分支 ${branch}（基线 ${hostText(root.baselineBranch, "未记录基线分支")}${base}）· 来源检出 ${hostText(root.sourceRealPath, "Host 未上报来源检出路径")}`;
  }
  if (root.kind === "existing-git") {
    const head = observedText(root.headCommit, (value) => value, "Host 未上报 HEAD");
    return `原检出真实路径: ${hostText(root.path, "Host 未上报路径")} · 当前分支 ${observedText(root.workingBranch, (value) => value, "Host 未上报分支")} · HEAD ${head} · 共享原文件，非隔离副本`;
  }
  return `本地真实路径: ${hostText(root.sourcePath ?? root.path, "Host 未上报路径")} · 非隔离副本，共享原文件`;
}

export function DesktopTaskFacts({ taskId, taskName, bridge, compact = false, destinationActive = true, headerInShell = false, onActiveSession, onOpenSession, onBack, onRepair }: {
  destinationActive?: boolean;
  compact?: boolean;
  headerInShell?: boolean;
  onActiveSession?: (taskId: string, sessionId: string | null) => void;
  onOpenSession?: (sessionId: string) => void;
  onBack?: () => void;
  onRepair?: () => void;
  taskId: string;
  taskName: string;
  bridge: PidockBridge;
}) {
  const [verificationRevision, setVerificationRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [roots, setRoots] = useState<WorkspaceRootView[]>([]);
  const [mode, setMode] = useState<WorkspaceModeView | null>(null);
  /**
   * [#139] How many sessions this task actually has, read from the Host's own
   * index, including archived history. `null` while outstanding, and a failed read is named rather than
   * printed as "one session" (the sentence this line used to carry unconditionally).
   */
  const [sessions, setSessions] = useState<SessionList | null>(null);
  const [sessionRevision, setSessionRevision] = useState(0);
  useEffect(() => subscribeSessionWrites((writtenTaskId) => {
    if (destinationActive && writtenTaskId === taskId) setSessionRevision((value) => value + 1);
  }), [taskId, destinationActive]);
  const [creating, setCreating] = useState(false);
  const [sessionCount, setSessionCount] = useState<number | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  // A creation is authorized for one mounted facts destination only. The Host
  // may finish after navigation; its result must not publish into a new page.
  const creationDestination = useRef<{ live: boolean } | null>(null);
  useEffect(() => {
    const destination = { live: !compact && destinationActive };
    creationDestination.current = destination;
    setCreating(false);
    return () => { destination.live = false; };
  }, [taskId, compact, destinationActive]);
  useEffect(() => {
    if (!destinationActive) return;
    let live = true;
    setSessions(null); setSessionCount(null); setSessionError(null);
    onActiveSession?.(taskId, null);
    void readTaskSessions(taskId).then((result) => {
      if (!live) return;
      if (result.ok) { onActiveSession?.(taskId, result.list.activeSessionId); setSessions(result.list); setSessionCount(result.list.sessions.length); return; }
      setSessionError(result.error);
    });
    return () => { live = false; };
  }, [taskId, onActiveSession, destinationActive, sessionRevision]);

  useEffect(() => {
    let live = true;
    setLoading(true); setError(null); setRoots([]); setMode(null);
    void fileRootsThroughShell(taskId).then((result) => {
      if (!live) return;
      if (!result.ok) { setError(result.error ?? "任务工作区事实读取失败"); return; }
      const parsed = workspaceRootsFromHost(result.payload);
      if (!parsed) { setError("任务工作区事实返回异常，未显示任何来源"); return; }
      setRoots(parsed.roots);
      setMode(parsed.workspaceMode ?? (parsed.roots.some((root) => root.kind === "existing-git")
        ? "existing-git" : parsed.roots.some((root) => root.kind === "worktree") ? "worktree" : "plain-dirs"));
    }).catch((failure: unknown) => {
      if (live) setError(failure instanceof Error ? failure.message : "任务工作区事实读取失败");
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [bridge, taskId, verificationRevision]);

  const newSession = async () => {
    const destination = creationDestination.current;
    if (creating || !destination?.live) return;
    setCreating(true); setSessionError(null);
    const result = await createSession(taskId);
    if (!destination.live || creationDestination.current !== destination) return;
    setCreating(false);
    if (!result.ok) { setSessionError(result.error); return; }
    onActiveSession?.(taskId, result.list.activeSessionId);
    setSessions(result.list);
    setSessionCount(result.list.sessions.length);
    if (result.list.activeSessionId) onOpenSession?.(result.list.activeSessionId);
  };
  if (compact) return <section aria-label="会话工作区摘要" data-testid="desktop-session-facts" className="flex shrink-0 items-center gap-3 border-b border-line bg-paper px-4 py-2 text-[10px] text-muted">
    <Button type="button" size="sm" variant="ghost" onClick={onBack}>返回任务事实</Button>
    <div className="min-w-0 flex-1">
      {loading && <span role="status">正在核验任务来源…</span>}
      {error && <span role="alert">{error}</span>}
      {roots.map((root) => <p key={root.id} className="truncate font-mono" title={rootFact(root)}>{rootBadge(root)} · {rootFact(root)}{root.verification && root.verification.state !== "ready" ? ` · ${VERIFICATION_LABELS[root.verification.state]}：${root.verification.reason}` : ""}</p>)}
      {!loading && !error && roots.length === 0 && <span>Host 未上报任何来源</span>}
    </div>
  </section>;

  return <section aria-label="任务工作区事实" data-testid="desktop-task-facts"
    className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-bg px-6 py-5 text-ink below-mid:px-4">
    {!headerInShell && <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
      <h1 className="min-w-0 break-words text-[14px] font-semibold">{hostText(taskName, "Host 未上报任务名称")} · 任务工作区</h1>
      <div className="flex flex-wrap items-center gap-2">
        {sessions?.activeSessionId && <Button type="button" size="sm" variant="default" onClick={() => onOpenSession?.(sessions.activeSessionId!)}>进入活跃对话</Button>}
        {onBack && <Button type="button" size="sm" variant="outline" onClick={onBack}>返回工作空间总览</Button>}
      </div>
    </div>}
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-[12px] font-semibold">任务工作区访问来源</h2>
      {mode !== null && <Badge data-testid="task-facts-mode" variant="outline">{MODE_LABELS[mode]}</Badge>}
    </div>
    <p className="mt-1 text-[10px] text-muted">混合来源分别展示事实，不以一个独立 worktree 概括全部；写入按本任务审批，共享真实路径由受管写协调跨任务互斥</p>
    {error !== null && <div className="mt-2"><p role="alert" className="text-[11px] text-destructive">{error}</p><Button type="button" size="sm" variant="outline" onClick={() => setVerificationRevision((value) => value + 1)}>重新核验来源</Button>{onRepair && <Button type="button" size="sm" variant="outline" onClick={onRepair}>修复来源路径</Button>}</div>}
    {loading && <p role="status" className="mt-2 text-[11px] text-muted">正在读取任务工作区事实…</p>}
    {!loading && error === null && roots.length === 0 && <p className="mt-2 text-[11px] text-muted">该任务没有可读来源（Host 未上报任何根）</p>}
    {roots.length > 0 && <ul aria-label="任务来源事实" className="mt-2 divide-y divide-line rounded-[6px] border border-line bg-paper">
      {roots.map((root) => {
        const verification = root.verification;
        const broken = verification !== undefined && verification.state !== "ready";
        return <li key={root.id} data-testid={`task-fact-${root.id}`} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold">
              <Icon name={root.kind === "shared-dir" ? "folder" : "branch"} className="text-muted" />
              <span className="truncate">{hostText(root.label, "Host 未上报来源名称")}</span>
              <span className={`rounded-[3px] border px-1 py-[1px] text-[9px] font-semibold ${root.kind === "worktree" ? "border-line text-accent" : "border-orange text-orange"}`}>{rootBadge(root)}</span>
            </p>
            <details className="mt-1 min-w-0 text-[10px] text-muted">
              <summary className="cursor-pointer truncate font-mono" title={rootFact(root)}>{hostText(root.sourcePath ?? root.path, "Host 未上报路径")} {root.kind !== "shared-dir" ? ` · ${observedText(root.workingBranch, (value) => value, "Host 未上报分支")} · ${root.baseCommit?.slice(0, 7) ?? observedText(root.headCommit, (value) => value.slice(0, 7), "Host 未上报 HEAD")}` : " · 非隔离副本，共享原文件"}</summary>
              <p className="mt-1 break-all font-mono">{rootFact(root)}</p>
            </details>
            {broken && <p className="mt-1 text-[10px] text-orange">修复路径：在「项目管理」中修复该来源后重新打开任务；记录未被改写，不认领其他目录{onRepair && <Button type="button" size="sm" variant="outline" onClick={onRepair}>修复来源路径</Button>}</p>}
          </div>
          {verification !== undefined && <span title={verification.reason}
            className={`max-w-full break-words rounded-[3px] border px-1.5 py-0.5 text-[9px] font-semibold ${VERIFICATION_STYLE[verification.state]}`}>
            {verification.state === "ready" ? VERIFICATION_LABELS[verification.state] : `${VERIFICATION_LABELS[verification.state]}：${verification.reason}`}
          </span>}
        </li>;
      })}
    </ul>}
    {roots.some((root) => root.kind === "shared-dir") && <div data-testid="shared-dir-managed-protection" title={SHARED_DIR_MANAGED_PROTECTION} className="mt-2 text-[10px] leading-4 text-muted">普通目录共享原文件 · 受管写入按真实路径跨任务互斥；外部编辑器按 ADR 0006 豁免。<details><summary className="cursor-pointer">查看写入保护范围</summary>{SHARED_DIR_MANAGED_PROTECTION}</details></div>}
    <section aria-label="任务会话历史" className="mt-5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[12px] font-semibold">任务下属会话历史（共享同一工作区）</h2>
        <span data-testid="task-facts-sessions" className="text-[10px] text-muted">会话 {sessionError !== null ? `列表读取失败：${sessionError}` : sessionCount === null ? "未读取" : `${sessionCount} 个`}</span>
      </div>
      <div className="flex flex-col gap-2">
        {sessions?.sessions.map((session) => <div key={session.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-paper px-4 py-3">
          <div className="min-w-0 flex-1">
            <h3 className="break-words text-[12px] font-semibold">{session.name} <Badge variant="outline">{session.archived ? "已归档 · 只读" : sessions.activeSessionId === session.id ? "当前活跃会话" : "可继续对话"}</Badge></h3>
            <p className="mt-1 break-all text-[10px] text-muted">最近更新 {session.updatedAt} · {session.binding?.modelId ?? "未绑定模型"} · {session.permission === "read" ? "只读权限" : session.permission === "auto" ? "自动权限" : "默认权限"}</p>
          </div>
          <Button type="button" size="sm" variant={sessions.activeSessionId === session.id ? "default" : "outline"} onClick={() => onOpenSession?.(session.id)} aria-label={`进入对话 · ${session.name}`}>{session.archived ? "查看历史" : "进入对话"}</Button>
        </div>)}
        {sessions?.sessions.length === 0 && <p className="text-[11px] text-muted">此任务尚无会话；新建会话使用全新上下文。</p>}
        {onOpenSession && <Button type="button" variant="outline" disabled={creating || sessions === null} onClick={() => void newSession()}>在当前任务工作区中新建会话（全新上下文）</Button>}
      </div>
    </section>
    {typeof bridge.projectOp === "function" && <details className="mt-5 rounded-lg border border-line bg-paper px-3 py-2"><summary className="cursor-pointer text-[12px] font-semibold">环境变量 · 工作空间继承与任务覆盖</summary><DesktopTaskVariables taskId={taskId} bridge={bridge} /></details>}
  </section>;
}
