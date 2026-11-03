import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { DesktopTaskVariables } from "./DesktopVariables";
import { SHARED_DIR_MANAGED_PROTECTION } from "../data/sharedDirProtection";
import { fileRootsThroughShell, type PidockBridge } from "../data/shellBridge";
import { readTaskSessions } from "../data/taskSessions";
import {
  hostText,
  observedText,
  workspaceRootsFromHost,
  type WorkspaceModeView,
  type WorkspaceRootView,
  type WorkspaceVerificationView,
} from "../data/workspaceFiles";

/**
 * [Pencil T02] #137 / S08: the always-visible task facts surface.
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
  missing: "border-[#e6c9c3] text-[#ad4545]",
  mismatch: "border-[#e6c9c3] text-[#ad4545]",
  "repair-required": "border-[#dfc99f] text-[#9a6032]",
  "branch-mismatch": "border-[#e6c9c3] text-[#ad4545]",
  "base-mismatch": "border-[#e6c9c3] text-[#ad4545]",
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

export function DesktopTaskFacts({ taskId, taskName, bridge }: {
  taskId: string;
  taskName: string;
  bridge: PidockBridge;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [roots, setRoots] = useState<WorkspaceRootView[]>([]);
  const [mode, setMode] = useState<WorkspaceModeView | null>(null);
  /**
   * [#139] How many sessions this task actually has, read from the Host's own
   * index. `null` while outstanding, and a failed read is named rather than
   * printed as "one session" (the sentence this line used to carry unconditionally).
   */
  const [sessionCount, setSessionCount] = useState<number | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSessionCount(null); setSessionError(null);
    void readTaskSessions(taskId).then((result) => {
      if (!live) return;
      if (result.ok) { setSessionCount(result.list.sessions.filter((session) => !session.archived).length); return; }
      setSessionError(result.error);
    });
    return () => { live = false; };
  }, [taskId]);

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
  }, [bridge, taskId]);

  const enterConversation = () => {
    document.querySelector('[data-testid="desktop-conversation"]')?.scrollIntoView?.({ block: "start" });
  };

  return <section aria-label="任务工作区事实" data-testid="desktop-task-facts"
    className="shrink-0 border-b border-line bg-paper px-4 py-3 text-ink below-mid:px-3">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <h2 className="text-[12px] font-semibold tracking-[0.2px]">任务工作区访问来源</h2>
        <p className="mt-0.5 text-[10px] text-muted">混合来源分别展示事实，不以一个独立 worktree 概括全部；写入按本任务审批，共享真实路径由受管写协调跨任务互斥</p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {mode !== null && <span data-testid="task-facts-mode" className="rounded-[3px] border border-line bg-bg px-1.5 py-0.5 text-[10px] font-semibold text-accent">{MODE_LABELS[mode]}</span>}
        <button type="button" onClick={enterConversation}
          className="inline-flex min-h-7 items-center gap-1 border border-line bg-paper px-2 py-0.5 text-[11px] hover:bg-bg">
          <Icon name="arrow" className="-rotate-90" />进入活跃对话（main）
        </button>
      </div>
    </div>
    {error !== null && <p role="alert" className="mt-2 text-[11px] text-[#ad4545]">{error}</p>}
    {loading && <p role="status" className="mt-2 text-[11px] text-muted">正在读取任务工作区事实…</p>}
    {!loading && error === null && roots.length === 0 && <p className="mt-2 text-[11px] text-muted">该任务没有可读来源（Host 未上报任何根）</p>}
    {roots.length > 0 && <ul aria-label="任务来源事实" className="mt-2 divide-y divide-line rounded-[6px] border border-line bg-bg">
      {roots.map((root) => {
        const verification = root.verification;
        const broken = verification !== undefined && verification.state !== "ready";
        return <li key={root.id} data-testid={`task-fact-${root.id}`} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold">
              <Icon name={root.kind === "shared-dir" ? "folder" : "branch"} className="text-muted" />
              <span className="truncate">{hostText(root.label, "Host 未上报来源名称")}</span>
              <span className={`rounded-[3px] border px-1 py-[1px] text-[9px] font-semibold ${root.kind === "worktree" ? "border-line text-accent" : "border-[#dfc99f] text-[#9a6032]"}`}>{rootBadge(root)}</span>
            </p>
            <p className="mt-1 break-all font-mono text-[10px] text-muted">{rootFact(root)}</p>
            {broken && <p className="mt-1 text-[10px] text-[#9a6032]">修复路径：在「项目管理」中修复该来源后重新打开任务；记录未被改写，不认领其他目录</p>}
          </div>
          {verification !== undefined && <span title={verification.reason}
            className={`shrink-0 rounded-[3px] border px-1.5 py-0.5 text-[9px] font-semibold ${VERIFICATION_STYLE[verification.state]}`}>
            {VERIFICATION_LABELS[verification.state]}：{verification.reason}
          </span>}
        </li>;
      })}
    </ul>}
    {roots.some((root) => root.kind === "shared-dir") && <p data-testid="shared-dir-managed-protection" className="mt-2 break-words text-[10px] leading-4 text-muted">{SHARED_DIR_MANAGED_PROTECTION}</p>}
    {typeof bridge.projectOp === "function" && <DesktopTaskVariables taskId={taskId} bridge={bridge} />}
    <p data-testid="task-facts-sessions" className="mt-2 text-[10px] text-muted">任务 {hostText(taskName, "Host 未上报任务名称")} · 会话 {sessionError !== null ? `列表读取失败：${sessionError}` : sessionCount === null ? "未读取" : `${sessionCount} 个（可在对话页新建、切换，各自独立上下文）`}</p>
  </section>;
}
