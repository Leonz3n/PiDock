/**
 * The two production-bound panels that read no fixture state ([UI 对齐 S8a] #47).
 *
 * 协议 and the 终端 takeover are the only `ToolPanels` exports the packaged dock
 * renders (`components/DesktopToolDock.tsx`). They used to live in
 * `ToolPanels.tsx`, which imports `stores/host` for the demo-only panels around
 * them — an edge that pulls the in-memory fixture (`data/memoryHost.ts`) into
 * the production renderer graph. Their code is unchanged here; `ToolPanels.tsx`
 * re-exports both so the demo path and the existing tests keep their import.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Panel } from "./ui";
import { useUiStore } from "../stores/ui";
import {
  protocolConsumerStateLabel,
  protocolModeLabel,
  toolchainStatusLabel,
  type ProtocolBindingView,
} from "../data/protocolBinding";
import {
  TERMINAL_HISTORY_LIMIT,
  TERMINAL_HISTORY_POLL_MS,
  planTerminalForRoot,
  readTerminalHistory,
  readTerminalRoots,
  readTerminalState,
  resizeTerminal,
  sendTerminalInput,
  startTerminal,
  stopTerminal,
  terminalExitScopeNote,
  terminalInstanceStateText,
} from "../data/terminalSurface";
import {
  hostText,
  type TerminalHistoryEntryView,
  type TerminalInstanceView,
  type TerminalPlanView,
  type WorkspaceRootView,
} from "../data/workspaceFiles";

/**
 * [PiDock 08] (#14) protocol preparation panel: the protocol repository, the
 * generation steps, the *actual* generated version, each consumer's binding
 * and staleness, the platform toolchain result and the reasons a switch is
 * stopped. Display only — the Host owns the decisions; the panel never shows a
 * generated version it was not given.
 */
export function ProtocolPanel({ view }: { view: ProtocolBindingView }) {
  const staleConsumers = view.consumers.filter((consumer) => consumer.state !== "ready");
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-1.5 text-xs" data-testid="protocol-summary">
        <li className="rounded-md border border-line px-2 py-1.5">
          <span className="text-ink">协议仓库 {view.protocol.repoDir || "未配置"}</span>
          <span className="block text-[10px] text-muted">
            绑定方式：{protocolModeLabel(view.mode)}
            {view.simulated ? " · 内存投影（非 Host 结果）" : ""}
          </span>
        </li>
        <li className="rounded-md border border-line px-2 py-1.5" data-testid="protocol-generated-version">
          <span className="text-ink">实际生成版本：{view.generatedVersion ?? "尚未生成"}</span>
          {view.generatedAt ? <span className="block text-[10px] text-muted">生成时间：{view.generatedAt}</span> : null}
          <span className="block text-[10px] text-muted">{hostText(view.generationReason, "Host 未上报生成说明")}</span>
        </li>
        {view.runsGeneration ? (
          <li className="rounded-md border border-line px-2 py-1.5" data-testid="protocol-steps">
            <span className="text-ink">生成步骤</span>
            <ul className="mt-1 flex flex-col gap-0.5 text-[11px] text-muted">
              {view.generationSteps.map((step) => (
                <li key={`${step.kind}-${step.program}`}>
                  · {step.kind === "postprocess" ? "后处理" : "生成"} {hostText(step.program, "Host 未上报步骤程序")} {step.args.join(" ")}
                </li>
              ))}
            </ul>
          </li>
        ) : null}
      </ul>

      <Panel title="准备状态">
        <ul className="flex flex-col gap-1 text-[11px] text-muted" data-testid="protocol-prepare">
          {view.prepare.map((entry) => (
            <li key={entry.state}>
              {entry.ok ? "✓" : "○"} {hostText(entry.label, "Host 未上报准备项名称")}：{hostText(entry.detail, "Host 未上报准备项说明")}
            </li>
          ))}
        </ul>
      </Panel>

      {view.consumers.length > 0 ? (
        <Panel title="消费者绑定">
          <ul className="flex flex-col gap-1.5 text-xs" data-testid="protocol-consumers">
            {view.consumers.map((consumer) => (
              <li key={consumer.consumerId} className="rounded-md border border-line px-2 py-1.5">
                <div className="text-ink">
                  {hostText(consumer.name, "Host 未上报消费者名称")} · {consumer.language === "go" ? "Go" : "TS"} · {protocolConsumerStateLabel(consumer.state)}
                </div>
                <span className="block text-[10px] text-muted">
                  {consumer.binding.kind === "release"
                    ? `发布依赖：${hostText(consumer.binding.dependency, "Host 未上报发布依赖")}`
                    : consumer.binding.kind === "go-workspace"
                      ? `任务工作区：${hostText(consumer.binding.path, "Host 未上报工作区文件")}`
                      : `受管链接：${hostText(consumer.binding.linkPath, "Host 未上报受管链接路径")}`}
                </span>
                {consumer.binding.kind === "go-workspace" && consumer.binding.excludedConsumers.length > 0 ? (
                  <span className="block text-[10px] text-muted">
                    未并入（避免合并依赖选择）：{consumer.binding.excludedConsumers.join("、")}
                  </span>
                ) : null}
                {consumer.binding.kind === "go-workspace" ? (
                  <span className="block text-[10px] text-muted">不改写发布配置：{consumer.binding.releaseManifestsUntouched.join("、")}</span>
                ) : null}
                {consumer.binding.kind === "ts-link" ? (
                  <span className="block text-[10px] text-muted">
                    恢复绑定：{hostText(consumer.binding.restore.program, "Host 未上报恢复程序")} {consumer.binding.restore.args.join(" ")}
                  </span>
                ) : null}
                <span className="block text-[10px] text-muted">{hostText(consumer.stateDetail, "Host 未上报状态说明")}</span>
                {consumer.resolution ? (
                  <span className="block text-[10px] text-muted">
                    解析路径：{consumer.resolution.ok ? "已确认" : "未通过"} {hostText(consumer.resolution.message, "Host 未给出解析说明")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {staleConsumers.length > 0 ? (
            <p className="mt-2 text-[10px] text-muted" data-testid="protocol-stale-note">
              {staleConsumers.length} 个消费者需要重新生成/编译/重启后才算使用新协议
            </p>
          ) : null}
        </Panel>
      ) : null}

      {view.blockers.length > 0 || view.diagnostics.length > 0 ? (
        <Panel title="停止原因与诊断">
          <ul className="flex flex-col gap-1 text-[11px] text-muted" data-testid="protocol-diagnostics">
            {view.blockers.map((blocker) => (
              <li key={`${blocker.code}-${blocker.consumerId}`}>· [{hostText(blocker.code, "Host 未上报停止原因代码")}] {hostText(blocker.message, "Host 未上报停止原因")}</li>
            ))}
            {view.diagnostics.map((diagnostic) => (
              <li key={`${diagnostic.code}-${diagnostic.message}`}>· [{hostText(diagnostic.code, "Host 未上报诊断代码")}] {hostText(diagnostic.message, "Host 未上报诊断说明")}</li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel title="生成工具链">
        <p className="text-[11px] text-muted">
          平台：{view.toolchain.platform || "未探测"} · {view.toolchain.ok ? "就绪" : "未就绪"}；桌面可启动不等同于生成支持。
        </p>
        <ul className="mt-1 flex flex-col gap-0.5 text-[11px] text-muted" data-testid="protocol-toolchain">
          {view.toolchain.entries.map((entry) => (
            <li key={entry.toolId}>
              · {hostText(entry.label, "Host 未上报工具名称")}：{toolchainStatusLabel(entry.status)}

              {entry.version ? ` (${entry.version})` : ""}
            </li>
          ))}
          {view.toolchain.entries.length === 0 ? <li>· {hostText(view.toolchain.note, "Host 未上报工具链说明")}</li> : null}
        </ul>
      </Panel>
    </div>
  );
}

type TerminalTaskState = { taskId: string; spawnImplemented: boolean; instances: TerminalInstanceView[] };

/**
 * Who owns a terminal, as the plan row and the instance row both state it. The
 * Host may send an empty label or session id (`str()` keeps `""`), so each
 * branch NAMES the value it did not get instead of ending at `Agent 会话 ` or
 * `人工 · `.
 */
function ownerText(owner: { sessionId: string | null; label: string }): string {
  return owner.sessionId === null
    ? `人工 · ${hostText(owner.label, "Host 未上报操作者名称")}`
    : `Agent 会话 ${hostText(owner.sessionId, "Host 未上报会话标识")}`;
}

/**
 * [PiDock 10] (#15) the real terminal tool: the human takeover surface for one
 * task's Host-spawned PTY.
 *
 * Every row is a Host answer through the typed bridge - the plan (cwd, masked
 * env rows, owner), the instance list, the bounded history - and every control
 * is a labelled human action: the Host refuses an Agent session for raw input
 * and window changes, so no `sessionId` is sent and no boolean stands in for it
 * (main attests the labelled human origin itself).
 *
 * Honesty rules: the state shown is the Host's own (lifecycle, the recorded pid
 * or its absence, the exit code the pty really reported); an exit whose code was
 * never observed reads 未观测 instead of `0`; a refusal is shown with the Host's
 * reason verbatim; and no exit is presented as a whole-tree drain - the Host's
 * `root-exited` receipt means exactly that the containment claim is not made,
 * while an `unknown` receipt leaves the instance running.
 */
export function TerminalTakeoverPanel({
  taskId,
  program = "bash",
  args = ["-l"],
}: {
  taskId: string;
  /** Program the plan asks the Host to run; the Host resolves a bare name itself. */
  program?: string;
  args?: string[];
}) {
  // The draft survives a tab swap in the ui store: the rail unmounts the panel.
  const panelState = useUiStore((state) => state.toolPanelState[taskId]);
  const setPanelState = useUiStore((state) => state.setToolPanelState);
  const draft = panelState?.terminalValue ?? "";
  const [sandbox, setSandbox] = useState<TerminalTaskState | null>(null);
  const [rootState, setRootState] = useState<{ taskId: string; roots: WorkspaceRootView[] } | null>(null);
  const [rootId, setRootId] = useState("");
  const [planState, setPlanState] = useState<{ taskId: string; plan: TerminalPlanView } | null>(null);
  const [historyState, setHistoryState] = useState<{ taskId: string; entries: TerminalHistoryEntryView[] } | null>(null);
  const [noticeState, setNoticeState] = useState<{ taskId: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Freshness guards: a task/instance change, or a newer read of the same kind,
  // supersedes every in-flight answer, so a slow response for a previous task or
  // instance cannot overwrite the current one (the guard the sibling async
  // panels use). Each epoch is checked before any state is written.
  const stateEpoch = useRef(0);
  const historyEpoch = useRef(0);
  // The task this panel is currently showing. A callback of a previous task must
  // not fence (or write) the new task's reads, so it compares against the latest
  // value instead of the value its own render captured.
  const shownTask = useRef(taskId);
  shownTask.current = taskId;
  // Rows are tagged with the task that produced them: another task's answer is
  // never shown as this task's state, even while a read is still in flight.
  const known = sandbox !== null && sandbox.taskId === taskId;
  const instances = known ? sandbox.instances : [];
  const roots = rootState !== null && rootState.taskId === taskId ? rootState.roots : [];
  const plan = planState !== null && planState.taskId === taskId ? planState.plan : null;
  // History is tagged like every other row: a task switch must not paint the
  // previous task's lines even for the frame before the mount effect clears them.
  const history = historyState !== null && historyState.taskId === taskId ? historyState.entries : [];
  const notice = noticeState !== null && noticeState.taskId === taskId ? noticeState.text : undefined;
  const running = instances.filter((instance) => instance.lifecycle === "running");
  const watched = running[running.length - 1] ?? instances[instances.length - 1];
  const watchId = watched?.instanceId;
  const selectedRoot = roots.find((root) => root.id === rootId) ?? roots[0];

  const readState = useCallback(async () => {
    if (shownTask.current !== taskId) return;
    const request = ++stateEpoch.current;
    const result = await readTerminalState(taskId);
    if (stateEpoch.current !== request) return;
    if (!result.ok) {
      setNoticeState({ taskId, text: result.error });
      return;
    }
    setSandbox({ taskId, spawnImplemented: result.value.spawnImplemented, instances: result.value.instances });
  }, [taskId]);

  const readHistory = useCallback(
    async (instanceId: string) => {
      if (shownTask.current !== taskId) return;
      const request = ++historyEpoch.current;
      const result = await readTerminalHistory({ taskId, instanceId, limit: TERMINAL_HISTORY_LIMIT });
      if (historyEpoch.current !== request) return;
      if (result.ok) setHistoryState({ taskId, entries: result.value });
      else setNoticeState({ taskId, text: result.error });
    },
    [taskId],
  );

  useEffect(() => {
    // A task change starts a fresh read; the previous task's rows are dropped by
    // their task tag and its in-flight answers are fenced by the new epoch.
    const request = ++stateEpoch.current;
    setHistoryState(null);
    setPlanState(null);
    setNoticeState(null);
    setRootId("");
    void (async () => {
      const [state, rootList] = await Promise.all([readTerminalState(taskId), readTerminalRoots(taskId)]);
      if (stateEpoch.current !== request) return;
      if (!state.ok) {
        setNoticeState({ taskId, text: state.error });
        return;
      }
      setSandbox({ taskId, spawnImplemented: state.value.spawnImplemented, instances: state.value.instances });
      if (!rootList.ok) {
        setNoticeState({ taskId, text: rootList.error });
        return;
      }
      setRootState({ taskId, roots: rootList.value });
      setRootId(rootList.value[0]?.id ?? "");
    })();
  }, [taskId]);

  useEffect(() => {
    if (watchId === undefined) {
      // No target: fence whatever read was still in flight and clear the output,
      // so the previous task's history cannot appear as this task's.
      ++historyEpoch.current;
      setHistoryState(null);
      return;
    }
    // Read once when the watched instance changes, then re-read while it runs:
    // one bounded read at a time, and the next tick is scheduled only after the
    // previous one settled, so a slow Host never accumulates overlapping reads.
    void readHistory(watchId);
    if (watched?.lifecycle !== "running") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await readHistory(watchId);
      await readState();
      if (!stopped) timer = setTimeout(() => void tick(), TERMINAL_HISTORY_POLL_MS);
    };
    timer = setTimeout(() => void tick(), TERMINAL_HISTORY_POLL_MS);
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [watchId, watched?.lifecycle, readHistory, readState]);

  const start = async () => {
    if (!selectedRoot) {
      setNoticeState({ taskId, text: "本任务没有可用的文件根，无法打开终端" });
      return;
    }
    // Same instance id as the memory flow, so restarting reopens the instance the
    // Host already recorded instead of leaking one of its bounded slots.
    const instanceId = `term-${taskId}-1`;
    setBusy(true);
    const planned = await planTerminalForRoot({ taskId, instanceId, rootId: selectedRoot.id, program, args });
    if (planned.ok) setPlanState({ taskId, plan: planned.value });
    const started = planned.ok ? await startTerminal({ taskId, instanceId, rootId: selectedRoot.id, program, args }) : planned;
    await readState();
    setBusy(false);
    setNoticeState(started.ok ? null : { taskId, text: started.error });
  };

  const stop = async () => {
    if (watchId === undefined) return;
    setBusy(true);
    const result = await stopTerminal({ taskId, instanceId: watchId });
    await readState();
    setBusy(false);
    setNoticeState(result.ok ? null : { taskId, text: result.error });
  };

  const widen = async () => {
    if (watched === undefined) return;
    setBusy(true);
    const result = await resizeTerminal({ taskId, instanceId: watched.instanceId, cols: watched.cols + 20, rows: watched.rows });
    if (result.ok) await readState();
    setBusy(false);
    setNoticeState(result.ok ? null : { taskId, text: result.error });
  };

  const submit = async () => {
    const line = draft.trim();
    if (line.length === 0) return;
    setPanelState(taskId, { terminalValue: "" });
    if (watchId === undefined || watched?.lifecycle !== "running") {
      setNoticeState({ taskId, text: "终端没有运行中的真实进程，输入未发送" });
      return;
    }
    setBusy(true);
    const result = await sendTerminalInput({ taskId, instanceId: watchId, data: `${line}\n` });
    if (result.ok) {
      await readHistory(watchId);
      await readState();
    }
    setBusy(false);
    setNoticeState(result.ok ? null : { taskId, text: result.error });
  };

  return (
    <div className="flex min-h-0 flex-col gap-2">
      {!known ? <p className="text-[11px] text-muted">正在读取终端状态…</p> : null}
      {notice ? (
        <p role="status" data-testid="terminal-notice" className="rounded border border-warn/40 px-2 py-1 text-[11px] text-warn">
          {notice}
        </p>
      ) : null}
      {roots.length > 1 ? (
        <label className="flex items-center gap-2 text-[11px] text-muted">
          终端仓库
          <select
            aria-label="终端仓库"
            value={selectedRoot?.id ?? ""}
            onChange={(event) => setRootId(event.target.value)}
            className="rounded-md border border-line bg-paper px-2 py-1 text-xs"
          >
            {roots.map((root) => (
              <option key={root.id} value={root.id}>
                {hostText(root.label, "Host 未上报根名称")}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {known && sandbox.spawnImplemented === false ? (
        <p className="rounded border border-warn/40 px-2 py-1 text-[11px] text-warn" data-testid="terminal-spawn-residual">
          Host 无法启动真实 pty（平台不受支持或预检未通过）：面板只显示计划与实例记录，不会启动进程。
        </p>
      ) : null}
      {plan ? (
        <div className="flex flex-col gap-1 text-[11px] text-muted" data-testid="terminal-plan">
          <span>
            工作目录 <span className="font-mono text-ink">{hostText(plan.cwd, "Host 未上报终端工作目录")}</span> · 程序 {hostText(plan.program, "Host 未上报终端程序")} {plan.args.join(" ")}
          </span>
          <span>终端归属：{ownerText(plan.owner)}</span>
          <span>
            窗口 {plan.cols}×{plan.rows} · 历史上限 {plan.historyLimit}
          </span>
          {plan.attribution.sharedNote ? <span className="text-warn">{plan.attribution.sharedNote}</span> : null}
          <ul className="flex flex-col gap-0.5">
            {plan.resolved.map((row) => (
              <li key={row.key} className="font-mono text-[10px]">
                {row.key}={row.value} <span className="text-muted">（{row.source}）</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {watched ? (
        <div className="flex flex-col gap-1 text-[11px] text-muted" data-testid="terminal-instance">
          <span>
            {hostText(watched.instanceId, "Host 未上报实例标识")} · {terminalInstanceStateText(watched)}
          </span>
          {/* Who owns the instance being driven: a human may type into an
              Agent-owned terminal, and the row must say so (the plan row only
              describes this panel's own human plan). */}
          <span>终端归属：{ownerText(watched.owner)}</span>
          {terminalExitScopeNote(watched) ? <span data-testid="terminal-exit-scope">{terminalExitScopeNote(watched)}</span> : null}
          <div className="flex gap-2">
            {watched.lifecycle === "running" ? (
              <Button size="sm" disabled={busy} onClick={() => void stop()}>
                停止终端
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || watched.lifecycle !== "running"}
              title={watched.lifecycle === "running" ? undefined : "终端已退出，没有可调整窗口的进程"}
              onClick={() => void widen()}
            >
              加宽（{watched.cols}×{watched.rows}）
            </Button>
          </div>
        </div>
      ) : null}
      {known && sandbox.spawnImplemented && running.length === 0 ? (
        <Button size="sm" disabled={busy || selectedRoot === undefined} onClick={() => void start()}>
          按计划启动终端
        </Button>
      ) : null}
      <p className="text-[11px] text-muted">
        {watched?.lifecycle === "running"
          ? "输出是 Host 的有界历史；输入与窗口调整经受控桥发送给运行中的真实终端（人工显式操作，不携带会话授权）。"
          : "终端未运行：输入与窗口调整不可用，下面是 Host 记录的历史。"}
      </p>
      <div
        className="h-56 overflow-auto rounded-md border border-line bg-ink/95 p-3 font-mono text-[11px] leading-5 text-white/90"
        data-testid="terminal-output"
      >
        {history.map((entry, index) => (
          <div key={`${index}-${entry.line}`}>{entry.line}</div>
        ))}
        {history.length === 0 ? (
          <div className="text-white/40">{watched?.lifecycle === "running" ? "等待终端输出…" : "尚无可显示的终端历史。"}</div>
        ) : null}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          aria-label="终端输入"
          value={draft}
          onChange={(event) => setPanelState(taskId, { terminalValue: event.target.value })}
          className="flex-1 rounded-md border border-line bg-paper px-2.5 py-1.5 font-mono text-xs"
          placeholder={watched?.lifecycle === "running" ? "输入命令" : "终端未运行"}
        />
        <Button size="sm" type="submit" disabled={busy || watched?.lifecycle !== "running"}>
          执行
        </Button>
      </form>
    </div>
  );
}
