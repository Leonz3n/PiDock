import { createHash } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import type { TaskTerminalRegistry, TerminalInstanceRecord, TerminalPlan } from "../main/terminal-config.js";
import { MAX_PTY_ENVELOPE_BYTES, operationKey } from "./node-pty-protocol.js";
import { PTY_INPUT_BUDGET_ERROR, ptyProcessGroupOwnershipAvailable } from "./terminal-pty-driver.js";
import type { TerminalDriver, TerminalDriverReceipt, TerminalIdentity, TerminalLaunch, TerminalProcessIdentity } from "./terminal-execution.js";

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
 * Turn the planned program into the executable image the PTY will exec.
 *
 * POSIX: a bare name (`bash`) is resolved against the launch's own `PATH` and then
 * the fixed system paths; an unresolvable name is returned unchanged so no other
 * program is ever substituted for the planned one. win32: the launch `PATH` is
 * split at `;` and a bare name is completed with `PATHEXT`.
 *
 * On win32 this function is a PRE-resolution, not the resolution boundary: what it
 * returns (a bare name, or a name that carries a separator) is handed to the OS,
 * whose own search order decides. Measured on this host (#66):
 * `pty.spawn(".\\probe-cmd.exe", …, { cwd: <the dir holding probe-cmd.exe> })`
 * fails with `File not found`, while `cmd.exe` and `ping.exe` both START from an
 * env carrying no `PATH` at all. So a win32 name this function cannot resolve may
 * still start, and one it resolves may still be refused by the OS.
 *
 * The plan's displayed program is not rewritten, so the panel still shows what the
 * user chose. `platform` is the seam those rules are measured through, with the
 * same default as `buildHostEnv`.
 */
export function resolveProgram(program: string, env: Record<string, string>, platform: NodeJS.Platform = process.platform): string {
  if (isAbsolute(program)) return program;
  return platform === "win32" ? resolveWindowsProgram(program, env) : resolvePosixProgram(program, env);
}

/**
 * The suffixes a bare win32 name is completed with when `PATHEXT` is absent or
 * blank: the program kinds Windows' own documented default `PATHEXT` names
 * first, in that documented order. A plan env built from config rows (never
 * `process.env`) may carry no `PATHEXT` at all, and completing nothing there
 * would leave every bare name unresolved on win32.
 */
const DEFAULT_WINDOWS_PROGRAM_SUFFIXES = [".COM", ".EXE", ".BAT", ".CMD"] as const;

/** Windows environment names are case-insensitive, so a plan spelling `Path` or
 * `pathext` names the same variable; POSIX reads the exact name only. Same shape
 * as `buildHostEnv`. */
function envValue(env: Record<string, string>, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[name];
  const named = env[name];
  if (named !== undefined) return named;
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** The candidates one bare win32 name is completed with, per PATH directory: the
 * name itself when it already carries a `PATHEXT` suffix, else the name plus each
 * suffix in `PATHEXT`'s own order. The suffix match is case-insensitive because
 * that is how Windows compares the name. */
function windowsProgramCandidates(program: string, pathext: string | undefined): string[] {
  const listed = (pathext ?? "").split(";").filter((suffix) => suffix.length > 0);
  const suffixes: readonly string[] = listed.length > 0 ? listed : DEFAULT_WINDOWS_PROGRAM_SUFFIXES;
  const upper = program.toUpperCase();
  return suffixes.some((suffix) => upper.endsWith(suffix.toUpperCase())) ? [program] : suffixes.map((suffix) => program + suffix);
}

/**
 * win32 pre-resolution: a `;`-separated launch `PATH`, `PATHEXT` completion and
 * the `PATH`/`PATHEXT` names read case-insensitively. Candidate paths are only
 * stat'ed - remaining case differences are the Windows filesystem's to decide, and
 * win32 has no executable bit to check. A name that names nothing is returned
 * unchanged, so no other program is ever substituted for the planned one; the OS
 * search order resolves what this cannot (see `resolveProgram`).
 */
function resolveWindowsProgram(program: string, env: Record<string, string>): string {
  if (program.includes("/") || program.includes("\\")) return program;
  const searchPath = (envValue(env, "PATH", "win32") ?? "").split(";").filter((entry) => entry.length > 0);
  for (const directory of searchPath) {
    for (const candidate of windowsProgramCandidates(program, envValue(env, "PATHEXT", "win32"))) {
      const path = join(directory, candidate);
      try {
        if (statSync(path).isFile()) return path;
      } catch {
        // Try the next candidate.
      }
    }
  }
  return program;
}

/** POSIX resolution, unchanged: `:`-separated `PATH` entries in their own order,
 * then the fixed system paths, compared ordinally and case-sensitively. */
function resolvePosixProgram(program: string, env: Record<string, string>): string {
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
    if (receipt.status !== "tree-drained" && receipt.status !== "root-exited") {
      // An unproven end state keeps the instance addressable: the record stays
      // running with its recorded identity so a later stop can still contain it.
      return;
    }
    // Both proven exits mean the root really ended and every identity this Host
    // recorded for it is gone. `root-exited` additionally means the last control
    // request's window was never observed, so it must never be presented as
    // whole-tree containment; the record carries the exit code the pty reported
    // (or none at all when it was signalled / not observed).
    this.active.delete(identity.instanceId);
    this.registry.markExited(identity.instanceId, { exitCode: receipt.exitCode, reason: "exited" });
  }

  /**
   * The recorded identity against what the live session really holds. Where the
   * platform owns process groups, the group the spawner read is the identity a
   * signal is checked against, so a recorded pid that no longer leads exactly
   * that group - recycled or moved - refuses; a record without a group refuses
   * there too, because that is the evidence the signal would need. On win32 there
   * is no group and no signal by pid: containment is the Host-owned helper
   * handle, whose identity cannot be recycled, so the live session plus the
   * matching recorded pid is the whole identity.
   */
  private identityMatches(record: TerminalInstanceRecord, processId: number, observed: TerminalProcessIdentity | undefined): boolean {
    if (observed?.processId !== processId) return false;
    // win32: no pid is ever signalled - containment is the Host-owned helper
    // handle - so the group the POSIX path checks against is not part of the
    // identity here, and the matching recorded pid is the whole check.
    if (!ptyProcessGroupOwnershipAvailable()) return true;
    return observed.processGroupId !== undefined && observed.processGroupId === record.processGroupId;
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
      // The plan's cwd keeps the platform's own display spelling - the roots are
      // joined as `${taskDir}/${name}`, so on win32 the plan path mixes `\` and
      // `/` - while the driver's launch contract is a canonical absolute path
      // (`normalize(cwd) === cwd`). Canonicalize ONLY the value handed to the
      // driver: the plan is never rewritten, so what the panel shows and what
      // the record carries stay exactly as planned. On POSIX the joined path is
      // already canonical, so this is byte-identical there.
      cwd: normalize(input.plan.cwd),
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
    // no pid to stop) and must never be reported as a successful start. The
    // active entry is dropped with it: retaining a session that holds no
    // trackable process only wedges this instanceId (`terminal-owned` on every
    // retry, `unknown-process` on stop) and keeps one of the eight slots busy.
    if (spawned.status !== "started" || spawned.process === undefined) {
      this.active.delete(instanceId);
      return { ok: false, error: "terminal-start-unconfirmed: 无法确认终端进程已启动" };
    }
    this.generations.set(instanceId, generation);
    return { ok: true, instance };
  }

  /**
   * Stop exactly this instance's session. Fail-closed order: the registry must
   * have a recorded pid, this Host must hold the matching live session, and the
   * driver's observed identity must equal the recorded one - only then is the
   * driver asked to terminate it. A driver `unknown` keeps the instance running.
   * The identity that has to match is the platform's own: a process group that
   * has to still belong to the recorded pid where the platform owns groups, and
   * the live session plus the recorded pid on win32, where containment is the
   * Host-owned helper handle rather than a pid: the recorded pid is only compared,
   * never signalled, so a recycled pid cannot make this stop name a foreign
   * process (see `identityMatches`).
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
      return { ok: false, error: `unknown-process: 终端 ${instanceId} 没有本 Host 记录的运行会话，拒绝据此终止会话` };
    }
    if (!this.identityMatches(record, scope.scope.processId, this.driver.snapshot(session.identity).process)) {
      return { ok: false, error: `unknown-process: 终端 ${instanceId} 的记录身份与运行会话不一致，拒绝据此终止会话` };
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
    } catch (error) {
      // The lifetime input budget is a deliberate bound that fences the
      // terminal; the caller must be able to see which boundary it hit instead
      // of reading a generic delivery failure.
      if (error instanceof Error && error.message === PTY_INPUT_BUDGET_ERROR) {
        return { ok: false, error: `terminal-input-failed: 终端输入累计已达生命周期上限（${MAX_PTY_ENVELOPE_BYTES} 字节），该终端已被隔离，不再接受输入` };
      }
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
