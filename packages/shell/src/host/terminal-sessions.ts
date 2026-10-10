import { createHash } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { TaskTerminalRegistry, TerminalInstanceRecord, TerminalPlan } from "../main/terminal-config.js";
import { operationKey } from "./node-pty-protocol.js";
import type { TerminalDriver, TerminalDriverReceipt, TerminalIdentity, TerminalLaunch } from "./terminal-execution.js";

/** One live real-process session of one registered terminal instance. */
interface ActiveSession {
  identity: TerminalIdentity;
}

export type TerminalSessionResult<T> = ({ ok: true } & T) | { ok: false; error: string };

/** ANSI/OSC control sequences are stripped before one bounded history line is kept. */
// eslint-disable-next-line no-control-regex -- a PTY emits real ESC/BEL bytes the history must not keep
const ANSI_SEQUENCE = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
// eslint-disable-next-line no-control-regex -- bounded display keeps only printable text and tab
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function stripControl(line: string): string {
  return line.replace(ANSI_SEQUENCE, "").replace(CONTROL_CHARACTERS, "");
}

/**
 * Turn the planned program into the executable image the PTY will exec. A bare
 * name (`bash`) is resolved against the launch's own `PATH` and then a fixed
 * system path; an unresolvable name is returned unchanged so the driver refuses
 * it as `not-started` instead of guessing. The plan's displayed program is not
 * rewritten, so the panel still shows what the user chose.
 */
export function resolveProgram(program: string, env: Record<string, string>): string {
  if (isAbsolute(program)) return program;
  const searchPath = (env["PATH"] ?? "").split(":").filter((entry) => entry.length > 0);
  for (const directory of [...searchPath, "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
    const candidate = join(directory, program);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next candidate directory.
    }
  }
  return program;
}

/**
 * The explicit launch this session drives. The revision binds the plan's
 * program/argv/cwd/env (never the private values themselves) to the identity.
 */
function revisionOf(plan: TerminalPlan): string {
  const env = Object.entries(plan.env).sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify([plan.program, plan.args, plan.cwd, env])).digest("hex");
}

/**
 * Per-task real terminal sessions for [PiDock 10] (#15).
 *
 * The registry ([`TaskTerminalRegistry`](../main/terminal-config.ts)) owns the
 * task attribution and the bounded history; this class owns the real process
 * session and is the only writer of that registry's process identity. A start
 * records the spawner's `pid` and `pgid` on the instance; output reaches the
 * bounded history; input and resize reach the running PTY; a stop is accepted
 * only when the recorded identity still matches this session and the driver
 * proves the tree drained. A terminal with no real session - or with an
 * identity that does not match - refuses to stop instead of reporting success.
 */
export class TaskTerminalSessions {
  private readonly generations = new Map<string, number>();
  private readonly active = new Map<string, ActiveSession>();

  constructor(
    readonly registry: TaskTerminalRegistry,
    private readonly driver: TerminalDriver,
    /** Private task values scrubbed out of every history line. */
    private readonly secrets: () => readonly string[] = () => [],
  ) {}

  /** Bounded output sink of the driver: one history line per delivered segment. */
  ingest(identity: TerminalIdentity, _sequence: number, data: string): void {
    if (!this.owns(identity)) return;
    const secrets = this.secrets();
    for (const segment of data.split(/\r\n|\r|\n/)) {
      const line = stripControl(segment);
      if (line.length === 0) continue;
      this.registry.appendOutput(identity.instanceId, line, secrets);
    }
  }

  private owns(identity: TerminalIdentity): boolean {
    const session = this.active.get(identity.instanceId);
    return session !== undefined && operationKey(session.identity) === operationKey(identity);
  }

  private observe(identity: TerminalIdentity, receipt: TerminalDriverReceipt): void {
    if (!this.owns(identity)) return;
    if (receipt.status !== "tree-drained") {
      // An unproven end state keeps the instance addressable: the record stays
      // running with its recorded identity so a later stop can still contain it.
      return;
    }
    this.active.delete(identity.instanceId);
    this.registry.markExited(identity.instanceId, { exitCode: receipt.exitCode, reason: "exited" });
  }

  /**
   * Spawn the real PTY for one planned terminal. The plan is registered first
   * (the Host does that before the permission gate resolves); this method
   * records the real process identity on it. A proven `not-started` removes the
   * registration because nothing was spawned; an unknown spawn keeps it
   * addressable and reports the uncertainty.
   */
  async start(input: { plan: TerminalPlan; sessionId: string | null }): Promise<TerminalSessionResult<{ instance: TerminalInstanceRecord }>> {
    const instanceId = input.plan.instanceId;
    if (this.active.has(instanceId)) return { ok: false, error: `terminal-owned: 终端 ${instanceId} 已有运行中的会话` };
    const generation = (this.generations.get(instanceId) ?? 0) + 1;
    const identity: TerminalIdentity = { taskId: input.plan.taskId, sessionId: input.sessionId ?? "human-ui", instanceId, generation };
    const launch: TerminalLaunch = {
      program: resolveProgram(input.plan.program, input.plan.env),
      args: [...input.plan.args],
      cwd: input.plan.cwd,
      env: { ...input.plan.env },
      envRevision: revisionOf(input.plan),
      cols: input.plan.cols,
      rows: input.plan.rows,
    };
    // Track the identity before dispatching so an immediate exit receipt is
    // matched to this generation instead of a later one.
    this.active.set(instanceId, { identity });
    let spawned: Awaited<ReturnType<TerminalDriver["spawn"]>>;
    try {
      spawned = await this.driver.spawn(identity, launch, (receipt) => this.observe(identity, receipt));
    } catch {
      this.active.delete(instanceId);
      return { ok: false, error: "terminal-start-unconfirmed: 无法确认终端进程已启动" };
    }
    if (spawned.status === "not-started") {
      this.active.delete(instanceId);
      this.registry.remove(instanceId);
      return { ok: false, error: "terminal-not-started: 本机无法启动真实 PTY（运行时或预检不可用）" };
    }
    if (spawned.process) {
      // The identity the spawner observed is recorded even when the instance
      // still carries the previous run's `exited` state: a start that follows an
      // exit is a new run, so the exit fields are cleared with it. Recording
      // only on `running` (and never reopening) left a live shell with no
      // recorded pid, which made the next stop a false success.
      const record = this.registry.get(instanceId);
      this.registry.markProcess(instanceId, { processId: spawned.process.processId, processGroupId: spawned.process.processGroupId });
      if (record?.lifecycle === "exited") this.registry.markRunning(instanceId);
    }
    const instance = this.registry.get(instanceId);
    if (!instance) {
      this.active.delete(instanceId);
      return { ok: false, error: `unknown-instance: 本任务没有终端实例 ${instanceId}` };
    }
    // A started spawn without an observed identity cannot be contained (there is
    // no pid to stop) and must never be reported as a successful start.
    if (spawned.status !== "started" || spawned.process === undefined) {
      return { ok: false, error: "terminal-start-unconfirmed: 无法确认终端进程已启动" };
    }
    this.generations.set(instanceId, generation);
    return { ok: true, instance };
  }

  /**
   * Stop exactly this instance's session. Fail-closed order: the registry must
   * have a recorded pid + pgid, this Host must hold the matching live session,
   * and the driver's observed identity must equal the recorded one - only then
   * is any signal sent. A driver `unknown` keeps the instance running.
   */
  async stop(instanceId: string, reason: string): Promise<TerminalSessionResult<{ instance: TerminalInstanceRecord }>> {
    const record = this.registry.get(instanceId);
    if (!record) return { ok: false, error: `unknown-instance: 本任务没有终端实例 ${instanceId}` };
    const session = this.active.get(instanceId);
    // An exited instance with no live session of this Host is an idempotent stop.
    // While this Host still holds a live session, `exited` is not proof: the
    // retained identity is checked and the real process is contained below.
    if (record.lifecycle === "exited" && !session) return { ok: true, instance: record };
    const scope = this.registry.stopScope(instanceId);
    if (!scope.ok) return { ok: false, error: scope.error };
    if (!session) {
      return { ok: false, error: `unknown-process: 终端 ${instanceId} 没有本 Host 记录的运行会话，拒绝按记录进程号发送信号` };
    }
    const observed = this.driver.snapshot(session.identity);
    if (record.processGroupId === undefined || observed.process?.processId !== scope.scope.processId ||
        observed.process.processGroupId !== record.processGroupId) {
      return { ok: false, error: `unknown-process: 终端 ${instanceId} 的记录身份与运行会话不一致，拒绝发送信号` };
    }
    const receipt = await this.driver.stop(session.identity);
    if (receipt.status !== "tree-drained") {
      return { ok: false, error: `terminal-termination-unconfirmed: 终端 ${instanceId} 及其子进程未被证实结束` };
    }
    this.active.delete(instanceId);
    return { ok: true, instance: this.registry.markExited(instanceId, { exitCode: receipt.exitCode, reason }) };
  }

  async input(instanceId: string, data: string): Promise<TerminalSessionResult<{ typed: true }>> {
    const session = this.active.get(instanceId);
    const record = this.registry.get(instanceId);
    if (!session || !record || record.lifecycle !== "running") {
      return { ok: false, error: `terminal-not-running: 终端 ${instanceId} 没有运行中的真实进程` };
    }
    try {
      await this.driver.input(session.identity, data);
    } catch {
      return { ok: false, error: "terminal-input-failed: 终端输入未被确认送达" };
    }
    return { ok: true, typed: true };
  }

  async resize(instanceId: string, cols: number, rows: number): Promise<TerminalSessionResult<{ instance: TerminalInstanceRecord }>> {
    const session = this.active.get(instanceId);
    const record = this.registry.get(instanceId);
    if (!session || !record || record.lifecycle !== "running") {
      return { ok: false, error: `terminal-not-running: 终端 ${instanceId} 没有运行中的真实进程` };
    }
    try {
      await this.driver.resize(session.identity, cols, rows);
    } catch {
      return { ok: false, error: "terminal-resize-failed: 终端窗口大小未被确认应用" };
    }
    return { ok: true, instance: this.registry.resize(instanceId, { cols, rows }) };
  }

  /**
   * Host shutdown: stop every session this Host spawned. The stops run in
   * parallel - like the service runtime's `stopAll` - because each one may wait
   * out its own grace+confirm bound while the quitting Host has a single shared
   * deadline: stopping four live terminals one after another would report
   * `terminal-shutdown-unconfirmed` for terminals that were all still being
   * stopped. Still fails closed on any stop this Host could not prove, and still
   * attempts the others.
   */
  async stopAll(reason: string): Promise<void> {
    const results = await Promise.all([...this.active.keys()].map(async (instanceId) => {
      try {
        const result = await this.stop(instanceId, reason);
        return result.ok ? undefined : `${instanceId}: ${result.error}`;
      } catch (error) {
        return `${instanceId}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }));
    const failures = results.filter((failure) => failure !== undefined);
    if (failures.length > 0) throw new Error(`terminal-shutdown-unconfirmed: ${failures.join("；")}`);
  }
}
