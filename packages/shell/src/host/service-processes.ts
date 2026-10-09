import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { ServiceStartPlan } from "./service-runtime.js";
import {
  newServiceOwnershipNonce,
  readProcessPgid,
  serviceOwnershipLaunchEnded,
  serviceOwnershipRecordError,
  serviceOwnershipState,
  serviceOwnershipUnverifiedError,
  SERVICE_OWNERSHIP_NONCE_ENV,
  verifyServiceOwnershipIdentity,
  type ServiceOwnershipIdentity,
  type ServiceOwnershipLog,
} from "./service-ownership.js";

/** One launch's identity: leader pid plus the nonce only this launch carries. */
type OwnedLaunch = ServiceOwnershipIdentity;
interface OwnedProcess { child: ChildProcessByStdio<null, Readable, Readable>; done: Promise<void>; launch: OwnedLaunch }

/** Poll cadence for confirming that a recovered launch's identity is gone. */
const STOP_POLL_MS = 25;

/**
 * Host-owned process foundation for the task-bound service path ([PiDock 04] #7).
 *
 * Wired for services registered from main's trusted service catalog
 * (`ServiceLaunchSource: "catalog"`): `task/controlService` computes the
 * plan Host-side from the registered descriptor and reaches this class
 * through the #5 permission gate.
 *
 * Contract and boundaries - do not present them as stronger than they are:
 * - Launch is an explicit program + argv + cwd + a fresh per-child env
 *   object; the Host's own `process.env` is never read or mutated, and no
 *   ID is passed through a shell.
 * - The directory is resolved with `realpathSync` and must stay inside this
 *   task's real root; a foreign directory or an escaping symlink is refused
 *   before `spawn`. (The resolve→spawn window is not an atomic open: a
 *   same-UID actor that renames a checked component can still race it.)
 * - Output is captured per line, bounded to 2000 characters, and redacted by
 *   the injected redactor before it reaches the log.
 * - Every launch has a verifiable ownership identity: the leader pid plus a
 *   fresh 128-bit nonce placed in that child's own environment. When a durable
 *   `ServiceOwnershipLog` is injected, the identity is persisted before `start`
 *   resolves and removed only once the launch is confirmed over, so the durable
 *   layer never says "stopped" about a process it still verifies as alive
 *   (`./service-ownership.ts` explains why the pair resists pid recycling).
 * - **No signal is ever sent to a pid whose identity was not verified in the
 *   same call.** `stop` re-reads the (pid, nonce) identity from the OS before
 *   each signal; an unverifiable or mismatching identity is refused as
 *   `service-ownership-unverified` and reported as a failure, never as a stop.
 *   That also covers a launch recorded by an earlier Host: a record whose pid
 *   is alive but whose identity does not match is refused, never signalled.
 * - `stop` signals the child's own process group (SIGTERM, then SIGKILL) and
 *   confirms stdio closure. `termination-unconfirmed` means a descendant may
 *   still own the pipes; it is reported as a failure and must never be
 *   recorded as a clean stop. A descendant that leaves the process group
 *   (e.g. its own `setsid`) is outside this contract, and Windows refuses
 *   `start` entirely until a Job-Object-style ownership mechanism exists.
 * - Out of scope here (stated, not claimed): reclaiming a *descendant* that
 *   survived its leader and still holds the pipes. For a child this Host
 *   spawned, stdio closure still detects it; for a launch recovered from a
 *   durable record the Host holds no pipe, so "stopped" there means exactly
 *   "the recorded launch identity is no longer alive". Windows process-tree
 *   termination is UNTESTED in this slice.
 */
export class TaskServiceProcesses {
  private readonly running = new Map<string, OwnedProcess>();
  private closing = false;
  /** Real path of the task root this driver refuses to leave. */
  readonly taskDir: string;

  constructor(taskDir: string, private readonly onLine: (serviceId: string, line: string) => void,
    private readonly onExit: (serviceId: string, reason: string) => void,
    private readonly redact: (line: string) => string,
    private readonly stopGraceMs = 3000,
    private readonly stopConfirmMs = 1000,
    /** Durable per-launch ownership records; absent keeps the driver in-memory only. */
    private readonly ownership: ServiceOwnershipLog | undefined = undefined) {
    this.taskDir = realpathSync(taskDir);
  }

  ids(): string[] { return [...this.running.keys()].sort(); }

  async start(plan: ServiceStartPlan): Promise<number> {
    if (this.closing) throw new Error("host-closing: service starts are disabled");
    if (process.platform === "win32") throw new Error("unsupported-platform: Windows service process ownership is not implemented");
    if (this.running.has(plan.serviceId)) throw new Error(`already-running: ${plan.serviceId}`);
    if (!isAbsolute(plan.cwd) || !isAbsolute(plan.program)) throw new Error("invalid-launch: absolute cwd and program required");
    const cwd = realpathSync(plan.cwd);
    const within = relative(this.taskDir, cwd);
    if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error("invalid-launch: cwd escapes task root");
    this.refuseRecordedLaunch(plan.serviceId);
    // The ownership marker rides the child's own fresh environment: the kernel
    // fixes it for this image at execve, and no process can add it to another
    // image afterwards - which is what makes the identity unforgeable.
    const ownershipNonce = newServiceOwnershipNonce();
    const child = spawn(plan.program, plan.args, { cwd, env: { ...plan.env, [SERVICE_OWNERSHIP_NONCE_ENV]: ownershipNonce }, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const emit = (stream: NodeJS.ReadableStream) => {
      let pending = "";
      let oversized = false;
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        pending += chunk;
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end);
          if (!oversized && line.length <= 2000) this.onLine(plan.serviceId, this.redact(line.replace(/\r$/, "")).slice(0, 2000));
          else this.onLine(plan.serviceId, "[output line exceeded 2000 characters]");
          pending = pending.slice(end + 1);
          oversized = false;
        }
        if (pending.length > 2000) { pending = ""; oversized = true; }
      });
      stream.on("end", () => {
        if (oversized) this.onLine(plan.serviceId, "[output line exceeded 2000 characters]");
        else if (pending) this.onLine(plan.serviceId, this.redact(pending).slice(0, 2000));
      });
    };
    emit(child.stdout);
    emit(child.stderr);
    const started = new Promise<number>((resolve, reject) => {
      child.once("spawn", () => resolve(child.pid!));
      child.once("error", reject);
    });
    const done = new Promise<void>((resolve) => {
      child.once("close", (code, signal) => {
        if (this.running.get(plan.serviceId)?.child === child) {
          this.running.delete(plan.serviceId);
          // The launch is over (stdio closed): only now may its durable record
          // go. A record is never removed while its process could still be alive.
          this.ownership?.release({ serviceId: plan.serviceId, ownershipNonce: launch.ownershipNonce });
          this.onExit(plan.serviceId, signal ? `signal:${signal}` : `exit:${code ?? "unknown"}`);
        }
        resolve();
      });
    });
    // Reserve the identity before awaiting spawn; concurrent starts cannot run
    // twice. `pid` is filled in from the spawn event below; until then the
    // placeholder can never verify, so a concurrent stop refuses instead of
    // signalling a guess.
    const launch: OwnedLaunch = { pid: 0, ownershipNonce };
    this.running.set(plan.serviceId, { child, done, launch });
    let pid: number;
    try { pid = await started; }
    catch (error) { await done; throw error; }
    const owned = this.running.get(plan.serviceId);
    if (owned?.child === child) owned.launch = { pid, ownershipNonce };
    // Persist before resolving: no caller can observe a live child that the
    // durable layer does not know about. A child that already exited has no
    // record to keep (its `close` handler ran, or runs, with no record).
    if (child.exitCode === null && child.signalCode === null) {
      this.ownership?.record({ serviceId: plan.serviceId, pid, ownershipNonce, startedAt: new Date().toISOString() });
    }
    return pid;
  }

  /**
   * Refuse a start while a durable record of the same service names a launch
   * that is still alive - verified or not. A verified survivor is still a real
   * service instance of this task, so starting a second one would be the
   * "same service started twice" defect; an unverified survivor is exactly the
   * state nobody may guess about, so it is refused instead of adopted or
   * silently overwritten. A record whose process is confirmed gone is stale
   * bookkeeping and is cleared so the next launch can record itself.
   */
  private refuseRecordedLaunch(serviceId: string): void {
    const log = this.ownership;
    const record = log?.get(serviceId);
    if (!log || !record) return;
    const state = serviceOwnershipState(verifyServiceOwnershipIdentity(record));
    if (state === "gone") {
      log.release({ serviceId, ownershipNonce: record.ownershipNonce });
      return;
    }
    throw new Error(serviceOwnershipRecordError({ serviceId, pid: record.pid, state }));
  }

  /**
   * Stop every child *this Host* spawned. Deliberately not a reclaim of records
   * left by an earlier Host: those are stopped one by one through `stop`, which
   * verifies each identity, so a shutdown never signals a pid it cannot verify.
   */
  async stopAll(): Promise<void> {
    this.closing = true;
    const results = await Promise.allSettled(this.ids().map(async (serviceId) => {
      try { await this.stop(serviceId); }
      catch (error) { if (!(error instanceof Error && error.message.startsWith("not-running:"))) throw error; }
    }));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  private async closedWithin(done: Promise<void>, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        done.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async stop(serviceId: string): Promise<void> {
    const owned = this.running.get(serviceId);
    if (!owned) return this.stopRecordedLaunch(serviceId);
    const { child, done, launch } = owned;

    // Entry check: reject pid <= 1 before ANY signal path
    if (!Number.isInteger(launch.pid) || launch.pid <= 1) {
      throw new Error(serviceOwnershipUnverifiedError(serviceId, launch.pid, "进程 PID 尚未就绪或无效"));
    }

    const signal = (kind: NodeJS.Signals) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === "win32") {
        throw new Error("unsupported-platform: Windows service process signalling is not supported");
      }
      // Verify this exact launch from the OS before every signal. `gone` means
      // the process already ended, so nothing needs a signal; anything that is
      // not signalable throws before any `process.kill` runs.
      if (this.verifySameHostLaunch(serviceId, owned) === "gone") return;
      if (!Number.isInteger(launch.pid) || launch.pid <= 1) {
        throw new Error(serviceOwnershipUnverifiedError(serviceId, launch.pid, "进程 PID 尚未就绪或无效"));
      }
      try {
        process.kill(-launch.pid, kind);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    signal("SIGTERM");
    if (await this.closedWithin(done, this.stopGraceMs)) return;
    signal("SIGKILL");
    if (await this.closedWithin(done, this.stopConfirmMs)) return;
    // A descendant may still own stdout/stderr after the leader exits.
    throw new Error(`termination-unconfirmed: ${serviceId} still owns open process output`);
  }

  /**
   * Verify that an in-memory launch spawned by THIS Host is safe to signal.
   *
   * Invariants enforced before signalling:
   * 1. Reject pid <= 1: never signal 0, 1, or negative targets.
   * 2. In-memory handle must be live (exitCode === null && signalCode === null).
   * 3. Handle's pid must match the registered launch pid.
   * 4. Durable record (if configured) must agree on pid and nonce with this launch.
   * 5. OS verification:
   *    - "gone": process already ended, return "gone" (no signal needed).
   *    - "mismatch": OS environment exists and lacks this nonce -> throw refusal.
   *    - "verified": 128-bit nonce verified from OS environment -> signalable.
   *    - "unobservable": NEVER coerce to "verified". Permitted ONLY when corroborated
   *      by OS-observable process-group leadership evidence:
   *      the live handle is ours, and the OS confirms the pid still exists as a
   *      process-group leader whose pgid equals the pid (detached: true child).
   *      If pgid does not equal pid or cannot be read, fail closed.
   */
  private verifySameHostLaunch(serviceId: string, owned: OwnedProcess): "signalable" | "gone" {
    const { child, launch } = owned;
    if (!Number.isInteger(launch.pid) || launch.pid <= 1) {
      throw new Error(serviceOwnershipUnverifiedError(serviceId, launch.pid, "进程 PID 尚未就绪或无效"));
    }
    if (child.exitCode !== null || child.signalCode !== null) return "gone";
    if (child.pid !== launch.pid) {
      throw new Error(serviceOwnershipUnverifiedError(serviceId, launch.pid, "进程句柄 PID 与记录不一致"));
    }
    const stored = this.ownership?.get(serviceId);
    if (this.ownership && (stored === undefined || stored.pid !== launch.pid || stored.ownershipNonce !== launch.ownershipNonce)) {
      throw new Error(serviceOwnershipUnverifiedError(serviceId, launch.pid, "耐久所有权记录与本次启动不一致"));
    }
    const verdict = verifyServiceOwnershipIdentity(launch);
    if (verdict === "gone") return "gone";
    if (verdict === "mismatch") {
      throw new Error(serviceOwnershipUnverifiedError(serviceId, launch.pid, `OS 身份核验结果为 ${verdict}`));
    }
    if (verdict === "verified") {
      return "signalable";
    }
    // verdict is "unobservable" (e.g. macOS platform binary hiding its environment).
    // NEVER coerce "unobservable" into "verified".
    // Corroborate via OS-observable process group leadership: detached child is PG leader (pgid === pid).
    const pgid = readProcessPgid(launch.pid);
    if (pgid !== null && pgid === launch.pid) {
      return "signalable";
    }
    throw new Error(
      serviceOwnershipUnverifiedError(
        serviceId,
        launch.pid,
        `OS 身份无法核验（unobservable）且进程组领队佐证失败（pgid=${pgid ?? "null"}）`,
      ),
    );
  }

  /**
   * Stop a launch recorded by an earlier Host (no in-memory handle): the only
   * evidence is the durable (pid, nonce) record, so the only permitted action is
   * a signal gated on re-verifying that exact identity. A record whose pid is
   * alive but whose environment is unreadable is refused, never signalled, and
   * never rewritten to "stopped" while it may still be running.
   *
   * Confirmation here means "the recorded launch identity is no longer alive":
   * this Host holds no pipe for it, so stdio closure (and with it a descendant
   * that outlived the leader) is out of this path's reach - see the class notes.
   */
  private async stopRecordedLaunch(serviceId: string): Promise<void> {
    const log = this.ownership;
    const record = log?.get(serviceId);
    if (!log || !record) throw new Error(`not-running: ${serviceId}`);
    if (process.platform === "win32") {
      throw new Error("unsupported-platform: Windows service process signalling is not supported");
    }
    if (!Number.isInteger(record.pid) || record.pid <= 1) {
      throw new Error(serviceOwnershipUnverifiedError(serviceId, record.pid, "进程 PID 无效"));
    }
    const release = () => log.release({ serviceId, ownershipNonce: record.ownershipNonce });
    const verdict = verifyServiceOwnershipIdentity(record);
    if (verdict === "gone") {
      // The recorded launch is not alive any more: its pid names no process.
      // There is nothing to signal, and the record is now stale bookkeeping.
      release();
      return;
    }
    if (verdict !== "verified") throw new Error(serviceOwnershipUnverifiedError(serviceId, record.pid, `OS 身份核验结果为 ${verdict}`));
    // The identity matched this launch, so its own process group may be
    // signalled - re-checking right before each signal, because a pid cannot be
    // trusted across calls. After a signal the launch is confirmed over only by
    // positive evidence (`serviceOwnershipLaunchEnded`): a pid that is free
    // again, or one that now carries another identity. A process that is exiting
    // but no longer inspectable is NOT such evidence, so the loop keeps polling
    // instead of claiming a stop behind a live process.
    const signalVerified = (kind: NodeJS.Signals) => {
      if (process.platform === "win32") {
        throw new Error("unsupported-platform: Windows service process signalling is not supported");
      }
      if (!Number.isInteger(record.pid) || record.pid <= 1) return;
      if (verifyServiceOwnershipIdentity(record) !== "verified") return;
      try { process.kill(-record.pid, kind); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    const endedWithin = async (timeoutMs: number): Promise<boolean> => {
      for (let elapsed = 0; elapsed < timeoutMs; elapsed += STOP_POLL_MS) {
        if (serviceOwnershipLaunchEnded(record)) return true;
        await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
      }
      return serviceOwnershipLaunchEnded(record);
    };
    signalVerified("SIGTERM");
    if (await endedWithin(this.stopGraceMs)) { release(); return; }
    signalVerified("SIGKILL");
    if (await endedWithin(this.stopConfirmMs)) { release(); return; }
    throw new Error(`termination-unconfirmed: ${serviceId} 的已核验启动在停止期限内未结束`);
  }
}
