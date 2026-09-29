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
  protocolStateThroughShell,
  terminalStateThroughShell,
} from "../data/shellBridge";
import { protocolBindingFromHost } from "../data/protocolBinding";
import { ProtocolPanel } from "./ToolPanels";
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
 * falling back to sample data. `协议` reads `task/protocolState`. Tools the Host
 * cannot answer yet (`运行` needs a per-task service listing op, `浏览器` has
 * no production page read, `日志` needs service enumeration) stay unwired.
 */
export type DesktopTool = "files" | "terminal" | "protocol";

export const DESKTOP_TOOL_LABELS: Record<DesktopTool, string> = {
  files: "文件",
  terminal: "终端",
  protocol: "协议",
};

/** Tools the prototype shows that this build cannot answer from the Host yet. */
export const DESKTOP_TOOLS_UNWIRED: { id: string; label: string; reason: string }[] = [
  { id: "runtime", label: "运行", reason: "Host 尚未提供本任务服务清单 op，无法枚举服务" },
  { id: "browser", label: "浏览器", reason: "生产浏览器视图尚未接线到主进程 BrowserWindow" },
  { id: "logs", label: "日志", reason: "Host 尚未提供本任务服务清单，无法选择服务读取日志" },
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function validProtocolState(payload: unknown, taskId: string): boolean {
  if (!isRecord(payload) || !isRecord(payload.state)) return false;
  const state = payload.state;
  const protocol = state.protocol;
  const generation = state.generation;
  const toolchain = state.toolchain;
  const assessment = state.switchAssessment;
  const row = (value: unknown) => isRecord(value);
  const text = (value: unknown) => typeof value === "string";
  const entries = (value: unknown, check: (entry: Record<string, unknown>) => boolean) =>
    Array.isArray(value) && value.every((entry: unknown) => row(entry) && check(entry));
  const stringList = (value: unknown) => Array.isArray(value) && value.every(text);
  const validBinding = (value: unknown): boolean => {
    if (!isRecord(value)) return false;
    if (value.kind === "release") return text(value.dependency);
    if (value.kind === "go-workspace") return text(value.path) && stringList(value.useDirectories) &&
      stringList(value.excludedConsumers) && stringList(value.releaseManifestsUntouched) &&
      isRecord(value.env) && text(value.env.GOWORK);
    if (value.kind === "ts-link") return text(value.linkPath) && text(value.artifact) && text(value.marker) &&
      isRecord(value.link) && text(value.link.program) && stringList(value.link.args) &&
      isRecord(value.restore) && text(value.restore.program) && stringList(value.restore.args);
    return false;
  };
  return state.taskId === taskId && (state.mode === "release" || state.mode === "local") &&
    isRecord(protocol) && ["repoDir", "goGenDir", "tsGenDir"].every((key) => text(protocol[key])) &&
    (state.generatedVersion === null || text(state.generatedVersion)) &&
    isRecord(generation) && typeof generation.runsGeneration === "boolean" && text(generation.reason) &&
    entries(generation.steps, (step) => (step.kind === "generate" || step.kind === "postprocess") && text(step.program) && text(step.cwd) && Array.isArray(step.args) && step.args.every(text)) &&
    isRecord(toolchain) && typeof toolchain.ok === "boolean" && text(toolchain.platform) && text(toolchain.note) &&
    entries(toolchain.entries, (entry) => text(entry.toolId) && text(entry.label) && text(entry.detail) &&
      ["ready", "missing", "unverified", "unsupported-platform"].includes(String(entry.status))) &&
    isRecord(assessment) && entries(assessment.blockers, (entry) => text(entry.consumerId) && text(entry.code) && text(entry.message)) &&
    entries(state.consumers, (consumer) => text(consumer.consumerId) && text(consumer.name) && text(consumer.repoDir) &&
      text(consumer.releaseDependency) && (consumer.language === "go" || consumer.language === "ts") &&
      validBinding(consumer.binding) && isRecord(consumer.staleness) &&
      (consumer.resolution === undefined || (isRecord(consumer.resolution) && typeof consumer.resolution.ok === "boolean" && text(consumer.resolution.message))) &&
      ["ready", "needs-regenerate", "needs-binding", "needs-compile", "needs-restart"].includes(String(consumer.staleness.state)) && text(consumer.staleness.detail)) &&
    entries(state.prepare, (entry) => text(entry.state) && text(entry.label) && typeof entry.ok === "boolean" && text(entry.detail)) &&
    entries(state.diagnostics, (entry) => text(entry.code) && text(entry.message));
}

function ProtocolTool({ taskId }: { taskId: string }) {
  const [result, setResult] = useState<{ view: ReturnType<typeof protocolBindingFromHost>; error: string } | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    setResult(null);
    void protocolStateThroughShell(taskId).then((response) => {
      if (!live) return;
      if (!response.ok) { setResult({ view: undefined, error: shellError(response, "读取协议状态失败") }); return; }
      const view = validProtocolState(response.payload, taskId) ? protocolBindingFromHost(taskId, response.payload) : undefined;
      setResult(view ? { view, error: "" } : { view: undefined, error: "Host 协议状态响应无法解析" });
    }).catch((error: unknown) => {
      if (live) setResult({ view: undefined, error: error instanceof Error ? error.message : "读取协议状态失败" });
    });
    return () => { live = false; };
  }, [taskId, revision]);
  return <div className="min-w-0 space-y-3">
    <div className="flex items-center justify-between gap-2"><p className="text-[11px] text-muted">本任务协议状态 · 只读</p><Button type="button" size="sm" variant="outline" onClick={() => setRevision((value) => value + 1)}>刷新</Button></div>
    {!result && <p role="status" className="text-xs text-muted">正在读取协议状态…</p>}
    {result?.error && <p role="alert" className="break-words border border-[#e0b4b4] bg-[#fdf3f3] p-2 text-xs text-[#ad4545]">{result.error}</p>}
    {result?.view && <ProtocolPanel view={result.view} />}
  </div>;
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
      className="flex h-full w-[380px] min-w-0 shrink-0 flex-col overflow-hidden border-l border-line bg-paper below-mid:w-[300px] below-narrow:w-full below-narrow:flex-1 below-narrow:border-l-0"
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
        {tool === "files" ? <FilesTool taskId={taskId} /> : tool === "terminal" ? <TerminalTool taskId={taskId} /> : <ProtocolTool key={taskId} taskId={taskId} />}
      </div>
    </aside>
    </TooltipProvider>
  );
}
