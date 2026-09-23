/**
 * Built-in terminal domain for [PiDock 10] (#15), S2 slice.
 *
 * Pure rules + a bounded per-task registry: no pty, no `child_process`, no
 * filesystem. The Host owns the real spawn behind these guards; this module
 * owns what a valid terminal launch looks like, how the terminal is bound to
 * one task and one selected root, and how its stop scope is proven.
 *
 * Design notes (from the #15 boxes):
 * - The terminal's cwd is one of the task's file roots (a repo worktree or a
 *   plain-directory link), never the app's cwd and never another task's folder.
 * - The child env comes from the #7 resolution order (仓库默认配置 → 共享模板 →
 *   本机私有配置 → 任务覆盖 → 运行时绑定) and is a fresh object per terminal;
 *   `process.env` is never read or written, so one terminal cannot leak into
 *   another and the app's global environment stays untouched.
 * - Program and argv are explicit: inline `FOO=bar cmd` and shell chaining are
 *   refused, because a terminal that is a shell string cannot be attributed or
 *   permission-gated per command.
 * - Every instance records its owning task, owning session (null = human UI
 *   explicit) and process identity, so stopping one terminal matches
 *   instance+pid+startedAt and can never stop another task's process.
 * - History is bounded and scrubbed with the shared secret scrubber; the real
 *   pty/streaming/exit observation remains a recorded residual (no spawn here).
 */

import { resolveServiceEnv, validateServiceDescriptor, buildChildEnv, type ResolvedServiceRow, type ServiceEnvLayers } from "./service-config.js";
import { appendBounded, truncateText } from "./bounded-buffer.js";
import { scrubSecretText } from "./browser-rules.js";
import { resolveWorkspacePath, type WorkspaceAttribution, type WorkspaceRoot } from "./workspace-files.js";

/** Bounded terminal history: lines kept per instance and characters per line. */
export const MAX_TERMINAL_HISTORY = 200;
export const MAX_TERMINAL_LINE = 2000;
/** Max live terminal instances one task Host tracks. */
export const MAX_TERMINAL_INSTANCES = 8;
/** Window bounds: a resize outside this range is refused, not clamped silently. */
export const MIN_TERMINAL_COLS = 20;
export const MIN_TERMINAL_ROWS = 5;
export const MAX_TERMINAL_COLS = 500;
export const MAX_TERMINAL_ROWS = 200;

/** Who opened the terminal: an agent session, or an explicit human action. */
export interface TerminalOwner {
  taskId: string;
  /** `null` = human-UI explicit; never a session claim the Host did not resolve. */
  sessionId: string | null;
  label: string;
}

export interface TerminalPlan {
  instanceId: string;
  taskId: string;
  rootId: string;
  attribution: WorkspaceAttribution;
  /** Explicit program + argv (never a shell string). */
  program: string;
  args: string[];
  /** The selected root: repo worktree cwd or the plain-directory link itself. */
  cwd: string;
  /** Fresh per-terminal env object; never `process.env`. */
  env: Record<string, string>;
  /** Display rows of the resolved env, values masked where secret. */
  resolved: ResolvedServiceRow[];
  cols: number;
  rows: number;
  owner: TerminalOwner;
  historyLimit: number;
}

export type TerminalPlanResult = { ok: true; plan: TerminalPlan } | { ok: false; error: string };

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Plan one terminal for a task root. Fail-closed at every step: an unknown
 * root, a root-less selection, an invalid program/argv, an out-of-range window
 * or a broken env layer (duplicate keys, secrets in the shared template,
 * missing `${REF}`) all refuse instead of launching something unexpected.
 */
export function planTerminal(input: {
  roots: readonly WorkspaceRoot[];
  taskId: string;
  taskDir: string;
  rootId: unknown;
  /** Optional subdirectory inside the root; still confined to that root. */
  relative?: unknown;
  program: unknown;
  args?: unknown;
  layers: ServiceEnvLayers;
  cols?: unknown;
  rows?: unknown;
  owner: TerminalOwner;
  instanceId: string;
  secrets?: readonly string[];
}): TerminalPlanResult {
  const target = resolveWorkspacePath({
    roots: input.roots,
    taskId: input.taskId,
    taskDir: input.taskDir,
    rootId: input.rootId,
    relative: input.relative,
    allowRoot: true,
  });
  if (!target.ok) return { ok: false, error: target.error };
  if (typeof input.program !== "string") return { ok: false, error: "invalid-payload: program must be a string" };
  const args = input.args === undefined ? [] : input.args;
  if (!Array.isArray(args) || !args.every((entry) => typeof entry === "string")) {
    return { ok: false, error: "invalid-payload: args must be an array of strings" };
  }
  // Reuse the #7 launch rule instead of restating it: blank program, inline env
  // assignment and shell chaining are all refused the same way a service launch
  // refuses them, so a terminal cannot become the un-gated exec path.
  const invalid = validateServiceDescriptor({
    name: "终端",
    program: input.program,
    args,
    ports: [],
    runType: "long-lived",
  });
  if (invalid) return { ok: false, error: `invalid-terminal: ${invalid.message}` };
  const cols = input.cols === undefined ? 80 : input.cols;
  const rows = input.rows === undefined ? 24 : input.rows;
  if (!isPositiveInt(cols) || cols < MIN_TERMINAL_COLS || cols > MAX_TERMINAL_COLS) {
    return { ok: false, error: `invalid-terminal: 终端列数必须在 ${MIN_TERMINAL_COLS}–${MAX_TERMINAL_COLS} 之间` };
  }
  if (!isPositiveInt(rows) || rows < MIN_TERMINAL_ROWS || rows > MAX_TERMINAL_ROWS) {
    return { ok: false, error: `invalid-terminal: 终端行数必须在 ${MIN_TERMINAL_ROWS}–${MAX_TERMINAL_ROWS} 之间` };
  }
  const resolved = resolveServiceEnv(input.layers);
  if (!resolved.ok) return { ok: false, error: `invalid-terminal: ${resolved.error.message}` };
  const masked = resolved.rows.map((row) => ({ ...row, value: row.secret ? "••••••••" : row.value }));
  return {
    ok: true,
    plan: {
      instanceId: input.instanceId,
      taskId: input.taskId,
      rootId: target.root.id,
      attribution: target.attribution,
      program: input.program.trim(),
      args: [...args],
      cwd: target.absolute,
      env: buildChildEnv(resolved.rows),
      resolved: masked,
      cols,
      rows,
      owner: input.owner,
      historyLimit: MAX_TERMINAL_HISTORY,
    },
  };
}

/** One live-or-exited terminal instance of one task. */
export interface TerminalInstanceRecord {
  instanceId: string;
  taskId: string;
  rootId: string;
  attribution: WorkspaceAttribution;
  program: string;
  args: string[];
  cwd: string;
  owner: TerminalOwner;
  cols: number;
  rows: number;
  /** Non-secret env keys only: values stay Host-side (`plan.env`). */
  envKeys: string[];
  lifecycle: "running" | "exited";
  /** OS process identity; absent until the spawner reports it. */
  processId?: number;
  startedAt: string;
  /** Observed state after exit (box 5: show the real end state). */
  exitedAt?: string;
  exitCode?: number;
  exitReason?: string;
  history: { at: string; line: string }[];
}

/** What a stop request must match: instance + process identity, never a port. */
export interface TerminalStopScope {
  taskId: string;
  instanceId: string;
  processId: number;
  startedAt: string;
}

export type TerminalStopResult = { ok: true; scope: TerminalStopScope } | { ok: false; error: string };

/**
 * Bounded registry of one task's terminal instances. Ownership is explicit:
 * `taskId` is fixed at construction, so an instance of another task is
 * `task-mismatch` and can never be stopped from here. Stop scopes are proven
 * from the recorded process identity — a port is not an identity, and a
 * missing pid fails closed (`unknown-process`) rather than stopping whatever
 * happens to listen there.
 */
export class TaskTerminalRegistry {
  private readonly instances = new Map<string, TerminalInstanceRecord>();

  constructor(
    readonly taskId: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  list(): TerminalInstanceRecord[] {
    return [...this.instances.values()].map((record) => this.copy(record));
  }

  get(instanceId: string): TerminalInstanceRecord | undefined {
    const record = this.instances.get(instanceId);
    return record ? this.copy(record) : undefined;
  }

  /** Register a planned terminal. Bounded; re-registering the same id keeps its history/lifecycle. */
  register(plan: TerminalPlan): TerminalInstanceRecord {
    if (plan.taskId !== this.taskId) {
      throw new Error(`task-mismatch: 终端 ${plan.instanceId} 属于任务 ${plan.taskId}，不能注册到 ${this.taskId}`);
    }
    const existing = this.instances.get(plan.instanceId);
    if (!existing && this.instances.size >= MAX_TERMINAL_INSTANCES) {
      throw new Error(`terminal-limit: 本任务已登记 ${MAX_TERMINAL_INSTANCES} 个终端，请先停止不再使用的终端`);
    }
    const record: TerminalInstanceRecord = {
      instanceId: plan.instanceId,
      taskId: this.taskId,
      rootId: plan.rootId,
      attribution: plan.attribution,
      program: plan.program,
      args: [...plan.args],
      cwd: plan.cwd,
      owner: { ...plan.owner },
      cols: plan.cols,
      rows: plan.rows,
      envKeys: Object.keys(plan.env).sort(),
      lifecycle: existing?.lifecycle ?? "running",
      ...(existing?.processId !== undefined ? { processId: existing.processId } : {}),
      startedAt: existing?.startedAt ?? this.now(),
      ...(existing?.exitedAt !== undefined ? { exitedAt: existing.exitedAt } : {}),
      ...(existing?.exitCode !== undefined ? { exitCode: existing.exitCode } : {}),
      ...(existing?.exitReason !== undefined ? { exitReason: existing.exitReason } : {}),
      history: existing ? existing.history.map((entry) => ({ ...entry })) : [],
    };
    this.instances.set(plan.instanceId, record);
    return this.copy(record);
  }

  /** Record the OS process identity the spawner reported (real pty: residual). */
  markProcess(instanceId: string, input: { processId: unknown; startedAt?: unknown }): TerminalInstanceRecord {
    const record = this.require(instanceId);
    if (!isPositiveInt(input.processId)) throw new Error("invalid-process: 终端进程号必须是正整数");
    record.processId = input.processId;
    if (typeof input.startedAt === "string" && input.startedAt.trim().length > 0) record.startedAt = input.startedAt.trim();
    return this.copy(record);
  }

  /** Window resize inside the documented bounds; a bad size is refused, not clamped. */
  resize(instanceId: string, input: { cols: unknown; rows: unknown }): TerminalInstanceRecord {
    const record = this.require(instanceId);
    if (
      !isPositiveInt(input.cols) ||
      !isPositiveInt(input.rows) ||
      input.cols < MIN_TERMINAL_COLS ||
      input.cols > MAX_TERMINAL_COLS ||
      input.rows < MIN_TERMINAL_ROWS ||
      input.rows > MAX_TERMINAL_ROWS
    ) {
      throw new Error(`invalid-terminal: 终端窗口大小超出 ${MIN_TERMINAL_COLS}x${MIN_TERMINAL_ROWS}–${MAX_TERMINAL_COLS}x${MAX_TERMINAL_ROWS}`);
    }
    record.cols = input.cols;
    record.rows = input.rows;
    return this.copy(record);
  }

  /** Append one output line: bounded history, masked, bounded line length. */
  appendOutput(instanceId: string, line: string, secrets: readonly string[] = []): TerminalInstanceRecord {
    const record = this.require(instanceId);
    appendBounded(
      record.history,
      { at: this.now(), line: truncateText(scrubSecretText(line, secrets), MAX_TERMINAL_LINE) },
      MAX_TERMINAL_HISTORY,
    );
    return this.copy(record);
  }

  history(instanceId: string, limit = 50): { at: string; line: string }[] {
    const record = this.require(instanceId);
    return record.history.slice(-Math.max(1, limit)).map((entry) => ({ ...entry }));
  }

  /** Record the real exit state so the panel never shows a stale "running". */
  markExited(instanceId: string, input: { exitCode?: unknown; reason?: unknown } = {}): TerminalInstanceRecord {
    const record = this.require(instanceId);
    record.lifecycle = "exited";
    record.exitedAt = this.now();
    if (typeof input.exitCode === "number" && Number.isInteger(input.exitCode)) record.exitCode = input.exitCode;
    if (typeof input.reason === "string" && input.reason.trim().length > 0) record.exitReason = input.reason.trim();
    return this.copy(record);
  }

  /** Terminal instances still owned by one agent session (write coordination readout). */
  ownedBySession(sessionId: string): TerminalInstanceRecord[] {
    return this.list().filter((record) => record.owner.sessionId === sessionId && record.lifecycle === "running");
  }

  /**
   * Prove what a stop request may act on: same task, known instance, recorded
   * process identity. Anything else fails closed with a reason the UI shows.
   */
  stopScope(instanceId: string): TerminalStopResult {
    const record = this.instances.get(instanceId);
    if (!record) return { ok: false, error: `unknown-instance: 本任务没有终端实例 ${instanceId}` };
    if (record.taskId !== this.taskId) {
      return { ok: false, error: `task-mismatch: 终端 ${instanceId} 属于任务 ${record.taskId}，不会停止其他任务的进程` };
    }
    if (record.processId === undefined) {
      return { ok: false, error: `unknown-process: 终端 ${instanceId} 尚未报告进程号，无法安全停止` };
    }
    return { ok: true, scope: { taskId: record.taskId, instanceId: record.instanceId, processId: record.processId, startedAt: record.startedAt } };
  }

  /** Drop one instance (panel closed after exit, or task disposed). */
  remove(instanceId: string): void {
    this.instances.delete(instanceId);
  }

  private require(instanceId: string): TerminalInstanceRecord {
    const record = this.instances.get(instanceId);
    if (!record) throw new Error(`unknown-instance: 本任务没有终端实例 ${instanceId}`);
    return record;
  }

  private copy(record: TerminalInstanceRecord): TerminalInstanceRecord {
    return {
      ...record,
      args: [...record.args],
      owner: { ...record.owner },
      envKeys: [...record.envKeys],
      attribution: { ...record.attribution },
      history: record.history.map((entry) => ({ ...entry })),
    };
  }
}
