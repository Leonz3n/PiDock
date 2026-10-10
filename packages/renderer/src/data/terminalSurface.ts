/**
 * Human terminal takeover surface for the renderer ([PiDock 10] #15).
 *
 * The renderer owns no process: it asks the Host for one terminal op at a time
 * through the typed shell bridge and renders what came back. So the panel can
 * say what the Host proved and nothing more:
 *
 * - the instance list is the Host's own registry (`lifecycle`, the recorded
 *   pid or its absence, the exit code the pty really reported);
 * - a start/stop/input/resize is a labelled **human** action: the Host refuses
 *   an Agent session for raw input and window changes, so a session id is never
 *   named here (and no boolean stands in for one - the Host classifies the
 *   caller from the session channel itself);
 * - a refusal is shown with the Host's reason verbatim, never re-worded into a
 *   generic failure.
 *
 * Receipt vocabulary this module keeps honest: a verified exit may be
 * `tree-drained` (the exit was covered by an observation), `root-exited` (the
 * same verified exit, whole-tree containment explicitly NOT claimed) or
 * `unknown` (survivors, or an unreadable process table - the instance stays
 * running). Nothing here claims whole-tree containment, and an exit code no
 * observation saw is shown as 未观测 - never as `0`, which a signalled child
 * would otherwise fake.
 *
 * Outside the shell (`isShellConnected() === false`: Vite dev, tests) the panel
 * keeps the in-memory prototype echo and never calls into here.
 */

import {
  controlTerminalThroughShell,
  fileRootsThroughShell,
  planTerminalThroughShell,
  terminalHistoryThroughShell,
  terminalStateThroughShell,
  type ShellTaskOpResult,
} from "./shellBridge";
import {
  terminalHistoryFromHost,
  terminalPlanFromHost,
  terminalStateFromHost,
  workspaceRootsFromHost,
  type TerminalHistoryEntryView,
  type TerminalInstanceView,
  type TerminalPlanView,
  type TerminalStateView,
  type WorkspaceRootView,
} from "./workspaceFiles";

/** History the panel asks for: the Host keeps at most this many lines per instance. */
export const TERMINAL_HISTORY_LIMIT = 200;
/**
 * Poll cadence while an instance runs. The read is one bounded history tail plus
 * one state read, with the next tick scheduled only after the previous read
 * settled, so a slow Host cannot accumulate overlapping reads.
 */
export const TERMINAL_HISTORY_POLL_MS = 1500;
/** The label a panel-initiated terminal action carries; main attests the origin. */
export const TERMINAL_HUMAN_LABEL = "终端面板（用户显式操作）";

export type TerminalRead<T> = { ok: true; value: T } | { ok: false; error: string };
export type TerminalAck = { ok: true } | { ok: false; error: string };

/** The Host's own reason for a refused op, verbatim; the fallback only fills an empty envelope. */
export function terminalRefusalText(error: string | undefined, fallback: string): string {
  return typeof error === "string" && error.trim().length > 0 ? error : fallback;
}

function ack(result: ShellTaskOpResult, fallback: string): TerminalAck {
  return result.ok ? { ok: true } : { ok: false, error: terminalRefusalText(result.error, fallback) };
}

/** This task's terminal instances, with the Host's honest `spawnImplemented` gate. */
export async function readTerminalState(taskId: string): Promise<TerminalRead<TerminalStateView>> {
  const result = await terminalStateThroughShell(taskId);
  if (!result.ok) return { ok: false, error: terminalRefusalText(result.error, "终端状态读取失败") };
  const parsed = terminalStateFromHost(result.payload);
  if (!parsed) return { ok: false, error: "Host 终端状态响应无法解析" };
  return { ok: true, value: parsed };
}

/**
 * The task's file roots: the terminal's cwd is one of them (a repo worktree or a
 * plain-directory link), never the app's own cwd and never another task's
 * folder. An empty list is the Host's own answer, not an error to hide.
 */
export async function readTerminalRoots(taskId: string): Promise<TerminalRead<WorkspaceRootView[]>> {
  const result = await fileRootsThroughShell(taskId);
  if (!result.ok) return { ok: false, error: terminalRefusalText(result.error, "终端工作根读取失败") };
  const parsed = workspaceRootsFromHost(result.payload);
  if (!parsed) return { ok: false, error: "Host 文件根响应无法解析" };
  if (parsed.roots.length === 0) return { ok: false, error: "本任务没有可用的文件根，终端无法确定工作目录" };
  return { ok: true, value: parsed.roots };
}

/** One bounded history tail (the Host bounds both the line count and the characters per line). */
export async function readTerminalHistory(input: {
  taskId: string;
  instanceId: string;
  limit?: number;
}): Promise<TerminalRead<TerminalHistoryEntryView[]>> {
  const limit = input.limit ?? TERMINAL_HISTORY_LIMIT;
  const result = await terminalHistoryThroughShell({ taskId: input.taskId, instanceId: input.instanceId, limit });
  if (!result.ok) return { ok: false, error: terminalRefusalText(result.error, "终端历史读取失败") };
  const parsed = terminalHistoryFromHost(result.payload);
  if (!parsed) return { ok: false, error: "Host 终端历史响应无法解析" };
  return { ok: true, value: parsed };
}

/** Plan one terminal for a selected root: the cwd, masked env rows and owner the user sees before starting. */
export async function planTerminalForRoot(input: {
  taskId: string;
  instanceId: string;
  rootId: string;
  program: string;
  args?: string[];
}): Promise<TerminalRead<TerminalPlanView>> {
  const result = await planTerminalThroughShell({
    taskId: input.taskId,
    instanceId: input.instanceId,
    rootId: input.rootId,
    program: input.program,
    ...(input.args !== undefined ? { args: input.args } : {}),
  });
  if (!result.ok) return { ok: false, error: terminalRefusalText(result.error, "终端计划失败") };
  const plan = terminalPlanFromHost(result.payload);
  if (!plan) return { ok: false, error: "Host 终端计划响应无法解析" };
  return { ok: true, value: plan };
}

/** Start (or reopen) one planned terminal as a labelled human action. */
export async function startTerminal(input: {
  taskId: string;
  instanceId: string;
  rootId: string;
  program: string;
  args?: string[];
}): Promise<TerminalAck> {
  const result = await controlTerminalThroughShell({
    taskId: input.taskId,
    instanceId: input.instanceId,
    action: "start",
    rootId: input.rootId,
    program: input.program,
    ...(input.args !== undefined ? { args: input.args } : {}),
    label: TERMINAL_HUMAN_LABEL,
  });
  return ack(result, "终端启动失败");
}

/**
 * Stop one terminal. The Host signals only the group it recorded and only when
 * the driver proves the tree drained; a stop it cannot prove fails (verbatim,
 * e.g. `terminal-termination-unconfirmed`) and keeps the instance running.
 */
export async function stopTerminal(input: { taskId: string; instanceId: string }): Promise<TerminalAck> {
  const result = await controlTerminalThroughShell({
    taskId: input.taskId,
    instanceId: input.instanceId,
    action: "stop",
    label: TERMINAL_HUMAN_LABEL,
  });
  return ack(result, "终端停止失败");
}

/** Send raw input to a running instance; a terminal with no live process refuses. */
export async function sendTerminalInput(input: {
  taskId: string;
  instanceId: string;
  data: string;
}): Promise<TerminalAck> {
  const result = await controlTerminalThroughShell({
    taskId: input.taskId,
    instanceId: input.instanceId,
    action: "input",
    data: input.data,
  });
  return ack(result, "终端输入未被接受");
}

/** Apply one window size; the Host's range check refuses an out-of-range window. */
export async function resizeTerminal(input: {
  taskId: string;
  instanceId: string;
  cols: number;
  rows: number;
}): Promise<TerminalAck> {
  const result = await controlTerminalThroughShell({
    taskId: input.taskId,
    instanceId: input.instanceId,
    action: "resize",
    cols: input.cols,
    rows: input.rows,
  });
  return ack(result, "终端窗口调整未被接受");
}

/** The Host's recorded exit reason, in the words the panel shows. */
const EXIT_REASON_TEXT: Record<string, string> = {
  exited: "自然退出（Host 观测到 root 已结束）",
  "user-request": "用户请求停止",
  "agent-request": "Agent 请求停止",
  "app-quit": "应用退出时停止",
};

/**
 * Honest one-line state of one instance. An exit code the Host never observed
 * reads 未观测 (a signalled child reports none, and `0` would be a fabrication);
 * a running instance keeps whatever process identity the Host recorded, and the
 * panel never states one it did not get.
 */
export function terminalInstanceStateText(instance: TerminalInstanceView): string {
  if (instance.lifecycle === "running") {
    return instance.processKnown ? `运行中 · pid ${instance.processId ?? "?"}` : "运行中 · Host 未报告进程号";
  }
  const reason =
    instance.exitReason === undefined
      ? "退出原因未报告"
      : (EXIT_REASON_TEXT[instance.exitReason] ?? instance.exitReason);
  const code =
    instance.exitCode === undefined ? "退出码未观测（Host 未收到可读退出码，进程可能由信号结束）" : `退出码 ${instance.exitCode}`;
  return `已退出 · ${reason} · ${code}`;
}

/**
 * What an exit does NOT prove, shown beside it. `root-exited` means the same
 * verified drain as `tree-drained` but explicitly without a whole-tree claim,
 * and an `unknown` receipt keeps the instance running (so it never reaches this
 * note) - either way the panel must not read as "the whole tree is confirmed
 * gone".
 */
export function terminalExitScopeNote(instance: TerminalInstanceView): string | undefined {
  return instance.lifecycle === "exited"
    ? "Host 只证实该终端本身已结束：退出未被观测覆盖时不主张整棵进程树（面板不做整树确认）。"
    : undefined;
}
