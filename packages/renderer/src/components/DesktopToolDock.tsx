import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import {
  browserActionThroughShell,
  fileDiffThroughShell,
  filePreviewThroughShell,
  fileRootsThroughShell,
  fileTreeThroughShell,
  planTerminalThroughShell,
  protocolStateThroughShell,
  serviceLogThroughShell,
  terminalStateThroughShell,
} from "../data/shellBridge";
import { protocolBindingFromHost } from "../data/protocolBinding";
import {
  loadTaskServices,
  serviceLogFromHost,
  shellFailure,
  type BoundServiceRow,
  type ServiceStatusView,
  type TaskServicesLoad,
} from "../data/taskServices";
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
 * Every row here comes from a real Host op and is parsed strictly; a failed op
 * shows the Host's own refusal instead of falling back to sample data.
 *
 * - 文件/终端: `task/fileRoots|fileTree|filePreview|fileDiff`, `task/planTerminal|terminalState`
 * - 协议: `task/protocolState`
 * - 运行/日志: `shell/projectOp associations` + `serviceCatalogOp taskBindings|list`
 *   (the task's real bound services), `task/serviceStatus` (the Host's own
 *   runtime answer) and `task/serviceLog` (on-demand log tail).
 * - 浏览器: `task/browserAction` (`page/open`, `page/state`, `evidence`,
 *   `takeover/pause|resume`); main owns the visible page, so the page itself is
 *   never embedded here.
 *
 * Controls the Host cannot serve (service start/stop, local/remote switching,
 * remote dependency and routing reads, live log streaming, page discovery and
 * embedding, page marks) stay visible and explicitly marked 未接线 with the
 * Host-side reason; none of them is filled with sample data.
 */
export type DesktopTool = "runtime" | "browser" | "files" | "terminal" | "logs" | "protocol";

export const DESKTOP_TOOL_LABELS: Record<DesktopTool, string> = {
  runtime: "运行",
  browser: "浏览器",
  files: "文件",
  terminal: "终端",
  logs: "日志",
  protocol: "协议",
};

/**
 * Prototype-A tools that still have no production panel at all. S8d wired
 * 运行/浏览器/日志 to real Host reads, so this registry is empty; a tool that
 * loses its Host path must be listed here again instead of silently rendering
 * sample rows.
 */
export const DESKTOP_TOOLS_UNWIRED: { id: string; label: string; reason: string }[] = [];

/**
 * Prototype-A controls inside the S8d panels that this build cannot ask the
 * Host for. Each one is rendered disabled with its reason, never hidden and
 * never replaced by sample data.
 */
export const DESKTOP_TOOL_CONTROLS_UNWIRED: Record<string, string> = {
  "service-control": "Host 尚未接管真实服务进程：task/controlService 返回 service-execution-unavailable",
  "service-mode": "本地/远程切换需要任务覆盖写入，Host 无对应读写能力",
  "remote-deps": "Host 无本任务远程依赖清单读取 op",
  routing: "Host 无生效路由/请求去向读取 op",
  "log-stream": "Host 无日志订阅推送 op：只能按需读取一次日志尾部",
  "browser-embed": "任务页面由主进程窗口承载，渲染层不能内嵌（不复制第二套页面）",
  "browser-pages": "Host 无「本任务已打开页面」枚举读取 op，重开面板无法恢复页面句柄",
  "browser-marks": "页面标记与验证记录入口未接线到生产面板",
};

const SERVICE_STATE_TEXT: Record<ServiceStatusView["kind"], Record<string, string>> = {
  owner: { stopped: "已停止", starting: "启动中", running: "运行中", stopping: "停止中", exited: "已退出", unconfirmed: "终止未确认" },
  registry: { stopped: "已停止", running: "运行中" },
};

function UnwiredRow({ id, children }: { id: string; children?: ReactNode }) {
  return (
    <li className="flex min-w-0 flex-wrap items-baseline gap-1.5 text-[11px] text-muted" data-unwired={id}>
      <Badge variant="soft">未接线</Badge>
      <span className="min-w-0 break-words">{children ?? DESKTOP_TOOL_CONTROLS_UNWIRED[id]}</span>
    </li>
  );
}

function statusText(row: BoundServiceRow): string {
  const status = row.status;
  if (!status) return row.statusError ?? "状态未读取";
  if (status.kind === "owner") {
    const text = SERVICE_STATE_TEXT.owner[status.state] ?? status.state;
    return status.executionAvailable ? text : `${text} · Host 未接管进程`;
  }
  return `${SERVICE_STATE_TEXT.registry[status.lifecycle] ?? status.lifecycle} · 配方 v${status.templateVersion} · ${status.resolvedKeys.length} 项环境变量`;
}

function serviceName(row: BoundServiceRow): string {
  return row.template?.descriptor.name ?? row.binding.serviceId;
}

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
  const [taskDir, setTaskDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadTree = useCallback(
    async (nextRootId: string, nextRelative: string) => {
      setBusy(true);
      const result = await fileTreeThroughShell({ taskId, rootId: nextRootId, relative: nextRelative || undefined });
      setBusy(false);
      if (!result.ok) {
        setTree(null);
        setError(shellFailure(result, "读取目录失败"));
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
        setError(shellFailure(result, "读取任务文件根失败"));
        return;
      }
      const parsed = workspaceRootsFromHost(result.payload);
      if (!parsed) {
        setRoots([]);
        setError("Host 文件根响应无法解析");
        return;
      }
      setRoots(parsed.roots);
      setTaskDir(parsed.taskDir);
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
      setError(shellFailure(result, "读取文件失败"));
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
      setError(shellFailure(result, "读取改动失败"));
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

  const selectedRoot = roots?.find((root) => root.id === rootId);
  if (roots === null) return <p className="text-xs text-muted">正在读取任务文件根…</p>;

  return (
    <div className="flex min-h-0 flex-col gap-2">
      {error && (
        <p role="status" className="border border-[#e0b4b4] bg-[#fdf3f3] px-2 py-1.5 text-[11px] text-[#8a3b3b]">
          {error}
        </p>
      )}
      {taskDir !== null && (
        <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px]">
          <dt className="text-muted">任务目录</dt>
          <dd className="min-w-0 break-all font-mono">{taskDir}</dd>
          {selectedRoot && <>
            <dt className="text-muted">实际目录</dt>
            <dd className="min-w-0 break-all font-mono">{selectedRoot.path}</dd>
            {selectedRoot.kind === "worktree" && <>
              <dt className="text-muted">远程基线分支</dt>
              <dd className="min-w-0 break-all font-mono">{selectedRoot.branch || "Host 未提供"}</dd>
              <dt className="text-muted">创建提交</dt>
              <dd className="min-w-0 break-all font-mono">{selectedRoot.baseCommit || "Host 未提供"}</dd>
            </>}
          </>}
        </dl>
      )}
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
        setError(shellFailure(stateResult, "读取终端状态失败"));
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
      setError(shellFailure(result, "终端计划失败"));
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
      if (!response.ok) { setResult({ view: undefined, error: shellFailure(response, "读取协议状态失败") }); return; }
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

function UnwiredControls({ id, label }: { id: string; label: string }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5" data-unwired={id} title={DESKTOP_TOOL_CONTROLS_UNWIRED[id]}>
      <Button type="button" size="sm" variant="outline" disabled>{label}</Button>
      <Badge variant="soft">未接线</Badge>
    </div>
  );
}

function RunTool({ taskId }: { taskId: string }) {
  const [load, setLoad] = useState<TaskServicesLoad | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    setLoad(null);
    void loadTaskServices(taskId).then((result) => { if (live) setLoad(result); });
    return () => { live = false; };
  }, [taskId, revision]);

  if (load === null) return <p className="text-xs text-muted">正在读取任务服务…</p>;
  if (!load.ok) return <p role="alert" className="break-words border border-[#e0b4b4] bg-[#fdf3f3] p-2 text-xs text-[#ad4545]">{load.error}</p>;

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted">任务运行环境 · 只读</p>
        <Button type="button" size="sm" variant="outline" onClick={() => setRevision((value) => value + 1)}>刷新</Button>
      </div>
      {load.projectId === null ? (
        <p role="status" className="border border-line bg-soft px-2 py-1.5 text-[11px] text-muted" data-testid="dock-runtime-unassigned">
          该任务尚未由用户确认归属项目，Host 不在项目下保存服务绑定；此面板不列举服务，也不冒充空清单。
        </p>
      ) : (
        <>
          {load.templatesError && <p role="status" className="break-words border border-line bg-soft px-2 py-1.5 text-[11px] text-muted">{load.templatesError}</p>}
          <section>
            <p className="text-[11px] text-muted">本任务服务 · {load.rows.length}</p>
            <ul className="mt-1 flex flex-col gap-1" data-testid="dock-service-rows">
              {load.rows.map((row) => {
                const running = row.status?.kind === "owner" ? row.status.state === "running" : row.status?.kind === "registry" ? row.status.lifecycle === "running" : false;
                return (
                  <li key={row.binding.serviceId} className="border border-line bg-paper px-2 py-1.5 text-[11px]" data-service-id={row.binding.serviceId}>
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${running ? "bg-accent" : "bg-line"}`} aria-hidden="true" />
                      <span className="truncate font-semibold">{serviceName(row)}</span>
                      <span className="ml-auto shrink-0 text-muted">{statusText(row)}</span>
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[10px] text-muted">
                      {row.template ? row.template.descriptor.ports.map((port) => `127.0.0.1:${port}`).join(" ") || "配方未声明端口" : "Host 未提供配方描述"}
                    </p>
                    <p className="mt-0.5 truncate text-[10px] text-muted">
                      绑定 v{row.binding.templateVersion} · {row.binding.rootId}{row.binding.subdir ? `/${row.binding.subdir}` : ""}
                      {row.binding.privateKeys.length > 0 ? ` · 私有引用 ${row.binding.privateKeys.length} 项` : ""}
                    </p>
                    <UnwiredControls id="service-control" label="启动 / 停止" />
                    <UnwiredControls id="service-mode" label="本地 / 远程" />
                  </li>
                );
              })}
              {!load.rows.length && <li className="px-1 py-2 text-xs text-muted">本任务还没有绑定服务。绑定属于项目服务配方，不在此处新建。</li>}
            </ul>
          </section>
          <section className="border-t border-line pt-2">
            <p className="text-[11px] text-muted">远程依赖</p>
            <ul className="mt-1 flex flex-col gap-1"><UnwiredRow id="remote-deps" /></ul>
          </section>
          <section className="border-t border-line pt-2">
            <p className="text-[11px] text-muted">请求去向</p>
            <ul className="mt-1 flex flex-col gap-1"><UnwiredRow id="routing" /></ul>
          </section>
        </>
      )}
      <p className="text-[10px] text-muted" data-testid="dock-runtime-note">
        以上状态是 Host 当前应答；未列出进程不等于已停止，也不代表外部依赖可用。worktree、进程、端口和浏览器状态按任务独立。
      </p>
    </div>
  );
}

function LogsTool({ taskId }: { taskId: string }) {
  const [load, setLoad] = useState<TaskServicesLoad | null>(null);
  const [serviceId, setServiceId] = useState<string | undefined>(undefined);
  const [log, setLog] = useState<{ ok: true; lines: { at: string; line: string }[] } | { ok: false; error: string } | null>(null);
  useEffect(() => {
    let live = true;
    setLoad(null); setLog(null); setServiceId(undefined);
    void loadTaskServices(taskId).then((result) => {
      if (!live) return;
      setLoad(result);
      if (result.ok) setServiceId(result.rows[0]?.binding.serviceId);
    });
    return () => { live = false; };
  }, [taskId]);
  useEffect(() => {
    if (serviceId === undefined) { setLog(null); return; }
    let live = true;
    setLog(null);
    void serviceLogThroughShell({ taskId, serviceId, limit: 200 }).then((result) => {
      if (!live) return;
      if (!result.ok) { setLog({ ok: false, error: shellFailure(result, "读取服务日志失败") }); return; }
      const lines = serviceLogFromHost(result.payload);
      setLog(lines ? { ok: true, lines } : { ok: false, error: "Host 日志响应无法解析" });
    });
    return () => { live = false; };
  }, [taskId, serviceId]);

  if (load === null) return <p className="text-xs text-muted">正在读取任务服务…</p>;
  if (!load.ok) return <p role="alert" className="break-words border border-[#e0b4b4] bg-[#fdf3f3] p-2 text-xs text-[#ad4545]">{load.error}</p>;

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <p className="text-[11px] text-muted">运行日志 · 按需读取尾部</p>
        <Badge variant="soft">最多 200 行</Badge>
      </div>
      {load.projectId === null ? (
        <p role="status" className="border border-line bg-soft px-2 py-1.5 text-[11px] text-muted" data-testid="dock-logs-unassigned">
          该任务尚未由用户确认归属项目，Host 不在项目下保存服务绑定，因此没有可选的真实服务。
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5" data-testid="dock-log-services">
            {load.rows.map((row) => (
              <Button
                key={row.binding.serviceId}
                type="button"
                size="sm"
                variant={row.binding.serviceId === serviceId ? "secondary" : "outline"}
                aria-pressed={row.binding.serviceId === serviceId}
                onClick={() => setServiceId(row.binding.serviceId)}
                className={row.binding.serviceId === serviceId ? "border-primary" : "text-muted-foreground"}
              >{serviceName(row)}</Button>
            ))}
            {!load.rows.length && <span className="text-xs text-muted">本任务还没有绑定服务，没有可读取日志的真实服务</span>}
          </div>
          {log === null && serviceId !== undefined && <p className="text-xs text-muted">正在读取日志…</p>}
          {log?.ok && log.lines.length > 0 && (
            <ol className="flex flex-col gap-0.5 border-t border-line pt-2 font-mono text-[10px]" data-testid="dock-log-lines">
              {log.lines.map((line, index) => <li key={index} className="break-all"><span className="text-muted">{line.at}</span> {line.line}</li>)}
            </ol>
          )}
          {log?.ok && !log.lines.length && <p role="status" className="text-xs text-muted" data-testid="dock-log-empty">Host 返回 0 行日志</p>}
          {log && !log.ok && <p role="alert" className="break-words border border-[#e0b4b4] bg-[#fdf3f3] p-2 text-xs text-[#ad4545]" data-testid="dock-log-error">{log.error}</p>}
        </>
      )}
      <ul className="flex flex-col gap-1 border-t border-line pt-2"><UnwiredRow id="log-stream" /></ul>
      <p className="text-[10px] text-muted" data-testid="dock-logs-note">
        日志只来自 Host 已登记的服务；Host 尚未接管真实服务进程时，这里会显示 Host 的原话，而不是样例行。
      </p>
    </div>
  );
}

type BrowserPageHandle = { pageId: string; webContentsId?: number; url: string };
type PageState = { epoch: number; url: string; title: string };
type PageEvidence = { consoleErrors: string[]; failedRequests: { url: string; errorText: string }[] };

function browserPageFromHost(payload: unknown): BrowserPageHandle | null {
  if (!isRecord(payload) || typeof payload["pageId"] !== "string" || payload["pageId"].length === 0) return null;
  if (typeof payload["url"] !== "string") return null;
  const webContentsId = payload["webContentsId"];
  if (webContentsId !== undefined && typeof webContentsId !== "number") return null;
  return { pageId: payload["pageId"], url: payload["url"], ...(typeof webContentsId === "number" ? { webContentsId } : {}) };
}

function pageStateFromHost(payload: unknown): PageState | null {
  if (!isRecord(payload) || !isRecord(payload["state"])) return null;
  const state = payload["state"];
  if (typeof state["epoch"] !== "number" || typeof state["url"] !== "string" || typeof state["title"] !== "string") return null;
  return { epoch: state["epoch"], url: state["url"], title: state["title"] };
}

function pageEvidenceFromHost(payload: unknown): PageEvidence | null {
  if (!isRecord(payload) || !isRecord(payload["evidence"])) return null;
  const evidence = payload["evidence"];
  if (!Array.isArray(evidence["consoleErrors"]) || !Array.isArray(evidence["failedRequests"])) return null;
  const consoleErrors: string[] = [];
  for (const entry of evidence["consoleErrors"]) {
    if (!isRecord(entry) || typeof entry["text"] !== "string") return null;
    consoleErrors.push(entry["text"]);
  }
  const failedRequests: PageEvidence["failedRequests"] = [];
  for (const entry of evidence["failedRequests"]) {
    if (!isRecord(entry) || typeof entry["url"] !== "string" || typeof entry["errorText"] !== "string") return null;
    failedRequests.push({ url: entry["url"], errorText: entry["errorText"] });
  }
  return { consoleErrors, failedRequests };
}

function BrowserTool({ taskId }: { taskId: string }) {
  const [url, setUrl] = useState("");
  const [page, setPage] = useState<BrowserPageHandle | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "refused"; text: string } | null>(null);
  const [state, setState] = useState<PageState | null>(null);
  const [evidence, setEvidence] = useState<PageEvidence | null>(null);
  const [paused, setPaused] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const ask = useCallback(async (action: string, params?: Record<string, unknown>) => {
    if (page === null && action !== "page/open") return null;
    setBusy(true);
    const result = await browserActionThroughShell({
      taskId,
      action,
      ...(page !== null ? { page: { taskId, pageId: page.pageId, ...(page.webContentsId !== undefined ? { webContentsId: page.webContentsId } : {}) } } : {}),
      ...(params !== undefined ? { params } : {}),
      label: `用户从工具面板执行 ${action}`,
    });
    setBusy(false);
    return result;
  }, [page, taskId]);

  const open = async () => {
    setNotice(null); setState(null); setEvidence(null); setPaused(null);
    setBusy(true);
    const result = await browserActionThroughShell({ taskId, action: "page/open", params: { url: url.trim() }, label: "用户从工具面板打开任务页面" });
    setBusy(false);
    if (!result.ok) { setPage(null); setNotice({ kind: "refused", text: shellFailure(result, "打开任务页面被拒绝") }); return; }
    const opened = browserPageFromHost(result.payload);
    if (!opened) { setPage(null); setNotice({ kind: "refused", text: "Host 页面响应无法解析" }); return; }
    setPage(opened);
    setNotice({ kind: "ok", text: `主进程窗口已打开 ${opened.url}` });
  };

  const readState = async () => {
    const result = await ask("page/state");
    if (!result) return;
    if (!result.ok) { setState(null); setNotice({ kind: "refused", text: shellFailure(result, "读取页面状态被拒绝") }); return; }
    const parsed = pageStateFromHost(result.payload);
    if (!parsed) { setState(null); setNotice({ kind: "refused", text: "Host 页面状态响应无法解析" }); return; }
    setState(parsed); setNotice({ kind: "ok", text: "已按 Host 应答更新页面状态" });
  };

  const readEvidence = async () => {
    const result = await ask("evidence");
    if (!result) return;
    if (!result.ok) { setEvidence(null); setNotice({ kind: "refused", text: shellFailure(result, "读取页面证据被拒绝") }); return; }
    const parsed = pageEvidenceFromHost(result.payload);
    if (!parsed) { setEvidence(null); setNotice({ kind: "refused", text: "Host 页面证据响应无法解析" }); return; }
    setEvidence(parsed); setNotice({ kind: "ok", text: "已按 Host 应答更新控制台与网络证据" });
  };

  const takeOver = async (next: boolean) => {
    const result = await ask(next ? "takeover/pause" : "takeover/resume", next ? { reason: "用户接管浏览器" } : {});
    if (!result) return;
    if (!result.ok) { setNotice({ kind: "refused", text: shellFailure(result, next ? "接管页面被拒绝" : "交还页面被拒绝") }); return; }
    setPaused(next);
    setNotice({ kind: "ok", text: next ? "已接管页面：Agent 自动化暂停" : "已交还页面：Agent 可继续操作" });
  };

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <p className="text-[11px] text-muted">任务页面 · 主进程窗口（渲染层不内嵌页面）</p>
      <div className="flex min-w-0 items-center gap-1.5">
        <input
          aria-label="任务页面地址"
          value={url}
          placeholder="http://127.0.0.1:5173/"
          onChange={(event) => setUrl(event.target.value)}
          className="min-h-8 min-w-0 flex-1 rounded-[4px] border border-line bg-paper px-2 font-mono text-[11px]"
        />
        <Button type="button" size="sm" disabled={busy || url.trim().length === 0} onClick={() => void open()}>打开任务页面</Button>
      </div>
      {notice && (notice.kind === "refused"
        ? <p role="alert" className="break-words border border-[#e0b4b4] bg-[#fdf3f3] p-2 text-[11px] text-[#ad4545]" data-testid="dock-browser-notice">{notice.text}</p>
        : <p role="status" className="break-words border border-line bg-soft p-2 text-[11px] text-muted" data-testid="dock-browser-notice">{notice.text}</p>)}
      {page && (
        <section className="border border-line bg-paper px-2 py-1.5 text-[11px]" data-testid="dock-browser-page">
          <p className="truncate">页面句柄 <span className="font-mono">{page.pageId}</span>{page.webContentsId !== undefined ? <span className="text-muted"> · webContents {page.webContentsId}</span> : null}</p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted">{page.url}</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void readState()}>读取状态</Button>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void readEvidence()}>读取证据</Button>
            {paused === true
              ? <Button type="button" size="sm" disabled={busy} onClick={() => void takeOver(false)}>交还 Agent</Button>
              : <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void takeOver(true)}>接管浏览器</Button>}
          </div>
          {state && <p className="mt-1 text-[10px] text-muted" data-testid="dock-browser-state">epoch {state.epoch} · {state.title || "（无标题）"} · {state.url}</p>}
          {evidence && (
            <div className="mt-1 text-[10px] text-muted" data-testid="dock-browser-evidence">
              <p>控制台错误 {evidence.consoleErrors.length} · 失败请求 {evidence.failedRequests.length}</p>
              {evidence.consoleErrors.slice(-3).map((text, index) => <p key={index} className="break-all font-mono">{text}</p>)}
              {evidence.failedRequests.slice(-3).map((row, index) => <p key={index} className="break-all font-mono">{row.url} · {row.errorText}</p>)}
            </div>
          )}
        </section>
      )}
      <ul className="flex flex-col gap-1 border-t border-line pt-2">
        <UnwiredRow id="browser-pages" />
        <UnwiredRow id="browser-embed" />
        <UnwiredRow id="browser-marks" />
      </ul>
      <p className="text-[10px] text-muted">打开与导航按 Host 的任务导航白名单校验；被拒绝时显示 Host 原话。</p>
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
        {tool === "runtime" ? <RunTool key={taskId} taskId={taskId} />
          : tool === "browser" ? <BrowserTool key={taskId} taskId={taskId} />
          : tool === "files" ? <FilesTool key={taskId} taskId={taskId} />
          : tool === "terminal" ? <TerminalTool taskId={taskId} />
          : tool === "logs" ? <LogsTool key={taskId} taskId={taskId} />
          : <ProtocolTool key={taskId} taskId={taskId} />}
      </div>
    </aside>
    </TooltipProvider>
  );
}
