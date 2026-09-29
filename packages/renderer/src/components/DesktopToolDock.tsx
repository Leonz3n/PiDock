import { useCallback, useEffect, useState } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import {
  fileDiffThroughShell,
  filePreviewThroughShell,
  fileRootsThroughShell,
  fileTreeThroughShell,
  planTerminalThroughShell,
  terminalStateThroughShell,
} from "../data/shellBridge";
import {
  terminalPlanFromHost,
  terminalStateFromHost,
  workspaceDiffFromHost,
  workspacePreviewFromHost,
  workspaceRootsFromHost,
  workspaceTreeFromHost,
  type TerminalPlanView,
  type TerminalStateView,
  type WorkspaceAttributionView,
  type WorkspacePreviewView,
  type WorkspaceRootView,
  type WorkspaceTreeEntryView,
} from "../data/workspaceFiles";

/**
 * [UI 对齐] (#47 S8d) Production tool dock.
 *
 * Every row here comes from a real Host op (`task/fileRoots`, `task/fileTree`,
 * `task/filePreview`, `task/fileDiff`, `task/planTerminal`, `task/terminalState`)
 * and is parsed strictly; a failed op shows the Host's own refusal instead of
 * falling back to sample data. Tools the Host cannot answer yet (`运行` needs a
 * per-task service listing op, `浏览器`/`协议`/`日志` have no production read
 * path) stay visible-but-unwired rather than pretending.
 */
export type DesktopTool = "files" | "terminal";

export const DESKTOP_TOOL_LABELS: Record<DesktopTool, string> = {
  files: "文件",
  terminal: "终端",
};

/** Tools the prototype shows that this build cannot answer from the Host yet. */
export const DESKTOP_TOOLS_UNWIRED: { id: string; label: string; reason: string }[] = [
  { id: "runtime", label: "运行", reason: "Host 尚未提供本任务服务清单 op，无法枚举服务" },
  { id: "browser", label: "浏览器", reason: "生产浏览器视图尚未接线到主进程 BrowserWindow" },
  { id: "protocol", label: "协议", reason: "协议面板依赖服务拓扑，本轮未接线" },
  { id: "logs", label: "日志", reason: "日志面板依赖服务清单，本轮未接线" },
];

const shellError = (result: { error?: string }, fallback: string) => result.error ?? fallback;

function attribution(entry: WorkspaceAttributionView) {
  return entry.rootLabel;
}

function RootChips({
  roots,
  selectedId,
  onSelect,
}: {
  roots: readonly WorkspaceRootView[];
  selectedId?: string;
  onSelect: (rootId: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="dock-roots">
      {roots.map((root) => (
        <Button
          key={root.id}
          type="button"
          variant={root.id === selectedId ? "secondary" : "outline"}
          size="sm"
          onClick={() => onSelect(root.id)}
          aria-pressed={root.id === selectedId}
          className={root.id === selectedId ? "border-primary" : "text-muted-foreground"}
        >
          <span>{root.label}</span>
          {root.branch && <span className="text-[10px] text-muted">· {root.branch}</span>}
        </Button>
      ))}
    </div>
  );
}

function TreeList({
  entries,
  onOpenDirectory,
  onOpenFile,
  relative,
}: {
  entries: readonly WorkspaceTreeEntryView[];
  onOpenDirectory: (relative: string) => void;
  onOpenFile: (relative: string) => void;
  relative: string;
}) {
  return (
    <ul className="mt-2 flex flex-col" data-testid="dock-tree">
      <li className="flex items-center gap-1.5 px-1 py-1 text-[11px] text-muted">
        <span className="font-mono">/{relative}</span>
      </li>
      {entries.map((entry) => (
        <li key={`${entry.kind}:${entry.name}`}>
          <Button
            type="button"
            variant="ghost"
            onClick={() => (entry.kind === "dir" ? onOpenDirectory(entry.path) : onOpenFile(entry.path))}
            className="flex h-auto w-full justify-start gap-2 rounded-none px-1 py-1 text-left text-xs"
          >
            <span className="w-3 text-[10px] text-muted">{entry.kind === "dir" ? "▸" : "·"}</span>
            <span className="truncate font-mono">{entry.name}</span>
            {entry.kind === "file" && entry.size !== undefined && (
              <span className="ml-auto shrink-0 text-[10px] text-muted">{entry.size} B</span>
            )}
          </Button>
        </li>
      ))}
      {!entries.length && <li className="px-1 py-2 text-xs text-muted">目录为空</li>}
    </ul>
  );
}

function FilesTool({ taskId }: { taskId: string }) {
  const [roots, setRoots] = useState<WorkspaceRootView[] | null>(null);
  const [rootId, setRootId] = useState<string | undefined>(undefined);
  const [relative, setRelative] = useState("");
  const [tree, setTree] = useState<WorkspaceTreeEntryView[] | null>(null);
  const [preview, setPreview] = useState<WorkspacePreviewView | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [taskDirFailed, setTaskDirFailed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadTree = useCallback(
    async (nextRootId: string, nextRelative: string) => {
      setBusy(true);
      const result = await fileTreeThroughShell({ taskId, rootId: nextRootId, relative: nextRelative || undefined });
      setBusy(false);
      if (!result.ok) {
        setTree(null);
        setError(shellError(result, "读取目录失败"));
        return;
      }
      const view = workspaceTreeFromHost(result.payload);
      if (!view) {
        setTree(null);
        setError("Host 目录响应无法解析");
        return;
      }
      setTree(view.entries);
      setError(null);
    },
    [taskId],
  );

  useEffect(() => {
    let live = true;
    void (async () => {
      const result = await fileRootsThroughShell(taskId);
      if (!live) return;
      if (!result.ok) {
        setRoots([]);
        setError(shellError(result, "读取任务文件根失败"));
        return;
      }
      const parsed = workspaceRootsFromHost(result.payload);
      if (!parsed) {
        setRoots([]);
        setError("Host 文件根响应无法解析");
        return;
      }
      setRoots(parsed.roots);
      setTaskDirFailed(null);
      const first = parsed.roots[0];
      if (!first) {
        setError(null);
        return;
      }
      setRootId(first.id);
      await loadTree(first.id, "");
    })();
    return () => {
      live = false;
    };
  }, [taskId, loadTree]);

  const openFile = async (path: string) => {
    if (!rootId) return;
    setBusy(true);
    const result = await filePreviewThroughShell({ taskId, rootId, relative: path });
    setBusy(false);
    if (!result.ok) {
      setPreview(null);
      setDiff(null);
      setError(shellError(result, "读取文件失败"));
      return;
    }
    const view = workspacePreviewFromHost(result.payload);
    if (!view) {
      setPreview(null);
      setError("Host 文件响应无法解析");
      return;
    }
    setPreview(view);
    setDiff(null);
    setError(null);
  };

  const openDiff = async () => {
    if (!rootId || !preview) return;
    setBusy(true);
    const result = await fileDiffThroughShell({ taskId, rootId, relative: preview.path });
    setBusy(false);
    if (!result.ok) {
      setDiff(null);
      setError(shellError(result, "读取改动失败"));
      return;
    }
    const view = workspaceDiffFromHost(result.payload);
    if (!view) {
      setDiff(null);
      setError("Host 改动响应无法解析");
      return;
    }
    setDiff(view.diff.length > 0 ? view.diff : "该文件没有未提交改动");
    setError(null);
  };

  if (roots === null) return <p className="text-xs text-muted">正在读取任务文件根…</p>;

  return (
    <div className="flex min-h-0 flex-col gap-2">
      {error && (
        <p role="status" className="border border-[#e0b4b4] bg-[#fdf3f3] px-2 py-1.5 text-[11px] text-[#8a3b3b]">
          {error}
        </p>
      )}
      {taskDirFailed && <p className="text-[11px] text-muted">{taskDirFailed}</p>}
      {!roots.length && !error && <p className="text-xs text-muted">本任务没有可读取的文件根</p>}
      {roots.length > 0 && (
        <>
          <RootChips
            roots={roots}
            selectedId={rootId}
            onSelect={(next) => {
              setRootId(next);
              setRelative("");
              setPreview(null);
              setDiff(null);
              void loadTree(next, "");
            }}
          />
          {busy && <p className="text-[11px] text-muted">读取中…</p>}
          {tree && rootId && (
            <TreeList
              entries={tree}
              relative={relative}
              onOpenDirectory={(path) => {
                setRelative(path);
                setPreview(null);
                setDiff(null);
                void loadTree(rootId, path);
              }}
              onOpenFile={(path) => void openFile(path)}
            />
          )}
          {preview && (
            <section className="min-h-0 border-t border-line pt-2">
              <div className="flex items-center gap-2 text-[11px] text-muted">
                <span className="truncate font-mono">{preview.path}</span>
                <Badge className="shrink-0">{preview.language}</Badge>
                {preview.lineCount !== undefined && <Badge className="shrink-0">{preview.lineCount} 行</Badge>}
                <Button type="button" variant="link" size="sm" onClick={() => void openDiff()} className="ml-auto h-auto shrink-0 px-0">
                  改动
                </Button>
              </div>
              <pre className="mt-1.5 max-h-[320px] overflow-auto border border-line bg-paper p-2 text-[11px] leading-relaxed">
                {diff ?? preview.source}
              </pre>
              {preview.truncated && <p className="mt-1 text-[10px] text-muted">Host 已按上限截断内容</p>}
            </section>
          )}
        </>
      )}
    </div>
  );
}

function TerminalTool({ taskId }: { taskId: string }) {
  const [state, setState] = useState<TerminalStateView | null>(null);
  const [roots, setRoots] = useState<WorkspaceRootView[]>([]);
  const [rootId, setRootId] = useState<string | undefined>(undefined);
  const [plan, setPlan] = useState<TerminalPlanView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const [stateResult, rootsResult] = await Promise.all([
        terminalStateThroughShell(taskId),
        fileRootsThroughShell(taskId),
      ]);
      if (!live) return;
      if (!stateResult.ok) {
        setState({ spawnImplemented: false, instances: [] });
        setError(shellError(stateResult, "读取终端状态失败"));
        return;
      }
      const parsed = terminalStateFromHost(stateResult.payload);
      if (!parsed) {
        setState({ spawnImplemented: false, instances: [] });
        setError("Host 终端状态响应无法解析");
        return;
      }
      setState(parsed);
      const rootsParsed = rootsResult.ok ? workspaceRootsFromHost(rootsResult.payload) : undefined;
      const list = rootsParsed?.roots ?? [];
      setRoots(list);
      if (list[0]) setRootId(list[0].id);
      setError(null);
    })();
    return () => {
      live = false;
    };
  }, [taskId]);

  const planTerminal = async (nextRootId: string) => {
    const result = await planTerminalThroughShell({
      taskId,
      instanceId: `term-${taskId}-1`,
      rootId: nextRootId,
      program: "bash",
      args: ["-l"],
    });
    if (!result.ok) {
      setPlan(null);
      setError(shellError(result, "终端计划失败"));
      return;
    }
    const view = terminalPlanFromHost(result.payload);
    if (!view) {
      setPlan(null);
      setError("Host 终端计划响应无法解析");
      return;
    }
    setPlan(view);
    setError(null);
  };

  if (state === null) return <p className="text-xs text-muted">正在读取终端状态…</p>;

  return (
    <div className="flex min-h-0 flex-col gap-2">
      {error && (
        <p role="status" className="border border-[#e0b4b4] bg-[#fdf3f3] px-2 py-1.5 text-[11px] text-[#8a3b3b]">
          {error}
        </p>
      )}
      {!state.spawnImplemented && (
        <p className="border border-line bg-soft px-2 py-1.5 text-[11px] text-muted" data-testid="dock-terminal-plan-only">
          Host 尚未接管真实 pty：下面是计划视图（cwd、环境与实例记录），不会启动进程。
        </p>
      )}
      <section>
        <p className="text-[11px] text-muted">实例 {state.instances.length}</p>
        <ul className="mt-1 flex flex-col gap-1" data-testid="dock-terminal-instances">
          {state.instances.map((instance) => (
            <li key={instance.instanceId} className="border border-line bg-paper px-2 py-1.5 text-[11px]">
              <span className="font-mono">{instance.instanceId}</span>
              <span className="ml-1.5 text-muted">
                {instance.lifecycle === "running" ? "运行中" : "已退出"}
                {instance.processKnown ? "" : " · 进程未知"}
              </span>
              <span className="block truncate font-mono text-[10px] text-muted">{instance.cwd}</span>
              {instance.exitReason && <span className="block text-[10px] text-muted">退出：{instance.exitReason}</span>}
            </li>
          ))}
          {!state.instances.length && <li className="px-1 py-2 text-xs text-muted">本任务还没有终端实例</li>}
        </ul>
      </section>
      {roots.length > 0 && (
        <section className="border-t border-line pt-2">
          <p className="text-[11px] text-muted">计划终端（bash -l）</p>
          <RootChips
            roots={roots}
            selectedId={rootId}
            onSelect={(next) => {
              setRootId(next);
              void planTerminal(next);
            }}
          />
          {plan && (
            <div className="mt-2 border border-line bg-paper px-2 py-1.5 text-[11px]" data-testid="dock-terminal-plan">
              <p className="font-mono">
                {plan.program} {plan.args.join(" ")}
              </p>
              <p className="mt-0.5 truncate font-mono text-[10px] text-muted">{plan.cwd}</p>
              <p className="mt-0.5 text-[10px] text-muted">
                {attribution(plan.attribution)} · {plan.resolved.length} 项环境变量（密钥已打码）· 历史上限 {plan.historyLimit}
              </p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export function DesktopToolDock({
  taskId,
  tool,
  onClose,
}: {
  taskId: string;
  tool: DesktopTool | null;
  onClose: () => void;
}) {
  if (!tool) return null;
  return (
    <TooltipProvider>
    <aside
      data-testid="desktop-tool-dock"
      data-tool={tool}
      className="flex h-full w-[380px] min-w-0 shrink-0 flex-col overflow-hidden border-l border-line bg-paper below-mid:w-[300px] below-narrow:hidden"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5">
        <span className="text-xs font-semibold text-ink">{DESKTOP_TOOL_LABELS[tool]}</span>
        <Badge variant="soft">真实 Host</Badge>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭面板" className="ml-auto">
              ×
            </Button>
          </TooltipTrigger>
          <TooltipContent>关闭面板</TooltipContent>
        </Tooltip>
      </header>
      <Separator />
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {tool === "files" ? <FilesTool taskId={taskId} /> : <TerminalTool taskId={taskId} />}
      </div>
    </aside>
    </TooltipProvider>
  );
}
