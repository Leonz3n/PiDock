import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { ServiceStartPlan } from "./service-runtime.js";
import {
  newServiceOwnershipNonce,
  processGroupMemberPids,
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
interface OwnedProcess {
  child: ChildProcessByStdio<null, Readable, Readable>;
  done: Promise<void>;
  launch: OwnedLaunch;
  /**
   * Set once this launch's process group has been observed empty. Carried on the
   * launch (not a local of `settled`) so it survives the two `settled` phases of
   * one `stop`: a group number that reappears after being seen empty can only be
   * a recycled number, and its members must never be signalled as ours.
   */
  leaderGroupObservedEmpty: boolean;
}

/** Poll cadence for confirming that a recovered launch's identity is gone. */
const STOP_POLL_MS = 25;

/** Device+inode of a directory: the identity the cwd check and spawn must agree on. */
interface DirectoryIdentity { dev: number; ino: number }

function directoryIdentity(path: string): DirectoryIdentity | null {
  try {
    const stat = statSync(path);
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

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
 *   before `spawn`. The `realpath`→`spawn` window is not an atomic open, so a
 *   swap of the checked directory is **detected, not eliminated**: its
 *   device+inode identity is re-read after `spawn`, and a change refuses the
 *   launch and kills the just-spawned child (see the TOCTOU note in `start`).
 *   A swap that is reverted before that re-read is invisible.
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
 * - `stop` signals the leader's own process group (SIGTERM, then SIGKILL), then
 *   reclaims any *descendant* that outlived the leader. A launch is spawned
 *   `detached: true`, so it is a process-group leader; a descendant that
 *   inherited the leader's stdout/stderr and stayed in that group is named by
 *   the OS as a member of the same pgid. Termination is confirmed only by
 *   positive evidence - the leader's own `close` **and** an empty process
 *   group - never by elapsed time and never by pipe closure alone (a descendant
 *   holding the pipes keeps `close` pending). A descendant that escaped the
 *   group (its own `setsid`) **while it still holds the launch's stdout/stderr**
 *   is not reclaimable: it cannot be named, `close` stays pending, and the stop
 *   fails closed as `termination-unconfirmed` keeping the durable record. A
 *   descendant that both escaped the group **and** closed its inherited stdio
 *   is beyond this Host's evidence model: it is unobservable, so a clean stop
 *   may be reported while it lives (stated, not hidden; a cgroup/Job-Object
 *   would be needed to bound it). Windows process-tree termination is UNTESTED -
 *   `start` refuses on win32 and no descendant reclaim runs there.
 * - Out of scope here (stated, not claimed): a launch recovered from a durable
 *   record holds no pipe, so "stopped" there means exactly "the recorded launch
 *   identity is no longer alive"; descendants of such a record are not
 *   reclaimed.
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
    // Identity of the directory the cwd check just validated. It is re-read
    // after `spawn` (see below) so a symlink/directory swapped into the
    // checked path between the check and the real spawn is detected, not raced.
    const checkedIdentity = directoryIdentity(cwd);
    if (!checkedIdentity) throw new Error("invalid-launch: cwd is not a readable directory");
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
    this.running.set(plan.serviceId, { child, done, launch, leaderGroupObservedEmpty: false });
    let pid: number;
    try { pid = await started; }
    catch (error) { await done; throw error; }
    // TOCTOU re-verification - DETECTION, not elimination. Between the cwd
    // check above and this `spawn`, a same-UID actor can rename the checked
    // directory and leave a symlink to somewhere else in its place. That window
    // cannot be closed portably: Node's `spawn` takes a path, not an open
    // directory descriptor, so check and spawn are two path lookups. What this
    // does guarantee: the checked directory's device+inode is re-read here (a)
    // via the original path and (b) after re-resolving it to the real path, and
    // unless both still name the directory the check validated (and stay inside
    // the task root) the just-spawned child is killed and the launch is refused.
    // The child is therefore never allowed to keep running after its cwd was
    // swapped while the swap was in place at this read. What it does NOT
    // guarantee: a swap that is reverted before this read is invisible, so the
    // window is reduced, not removed (see the class notes).
    const reResolved = (() => { try { return realpathSync(plan.cwd); } catch { return null; } })();
    let escapesAgain = true;
    let identityAgain: DirectoryIdentity | null = null;
    if (reResolved !== null) {
      const withinAgain = relative(this.taskDir, reResolved);
      escapesAgain = withinAgain === ".." || withinAgain.startsWith(`..${sep}`) || isAbsolute(withinAgain);
      identityAgain = directoryIdentity(reResolved);
    }
    if (escapesAgain || identityAgain === null || identityAgain.dev !== checkedIdentity.dev || identityAgain.ino !== checkedIdentity.ino) {
      // Terminate the just-spawned child before refusing: a rejected launch must
      // not leave a live process behind. Its identity is the handle we hold.
      // Drop the reservation first so the `close` handler's guard sees no launch
      // and does NOT report this never-started child as an exit to the runtime.
      this.running.delete(plan.serviceId);
      child.kill("SIGKILL");
      await done;
      throw new Error(`invalid-launch: cwd changed between check and spawn (${plan.serviceId})`);
    }
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
    const { child, launch } = owned;

    // Entry check: reject pid <= 1 before ANY signal path
    if (!Number.isInteger(launch.pid) || launch.pid <= 1) {
      throw new Error(serviceOwnershipUnverifiedError(serviceId, launch.pid, "进程 PID 尚未就绪或无效"));
    }

    // Signal the launch's own process group while the *leader* is still ours to
    // identify. Once the leader's handle reports it exited, the numeric group
    // handle is no longer proof of ownership (a recycled pid could lead a
    // foreign group), so descendants are then reclaimed individually by OS
    // group membership (see `settled`) and never by a blind `-pid`.
    const signalLeaderGroup = (kind: NodeJS.Signals) => {
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
    signalLeaderGroup("SIGTERM");
    if (await this.settled(owned, this.stopGraceMs)) return;
    signalLeaderGroup("SIGKILL");
    if (await this.settled(owned, this.stopConfirmMs)) return;
    // No positive evidence of settlement: the leader is still alive, a
    // descendant still holds the launch's output, or a descendant left the
    // group and cannot be named. Fail closed and keep the durable record.
    throw new Error(`termination-unconfirmed: ${serviceId} 的启动未被证实结束（进程组仍有存活成员或输出仍被持有）`);
  }

  /**
   * Wait (bounded) for positive evidence that a launch this Host spawned is
   * over, reclaiming reclaimable descendants as it goes.
   *
   * Escaping an unrelated recycled pid - the whole point of this method:
   * - The launch is spawned `detached: true`, so its leader is a process-group
   *   leader whose pgid equals its pid. A descendant that inherited the leader's
   *   stdout/stderr and did not call `setsid` stays in that group, so the OS
   *   process table names it as a member of pgid `leaderPid`; while it holds the
   *   pipes the leader's `close` event stays pending.
   * - A pid number cannot be recycled while it is still the pgid of a live
   *   process group. So a group observed non-empty while its number is still an
   *   active pgid belongs to this launch, and this method NEVER signals a member
   *   of a group it has already seen empty: that number can only be a *recycled*
   *   group by then, never our launch. The seen-empty guard is carried on the
   *   launch (`leaderGroupObservedEmpty`), so it holds across the two `settled`
   *   phases of one `stop`. Membership is re-read immediately before each
   *   signal, because a pid cannot be trusted across calls. Residual: a group
   *   that empties and whose number is reallocated *between probes* - with no
   *   observed-empty transition - is not distinguishable by this evidence model;
   *   reaching it needs pid-number wrap inside one poll window.
   * - Success requires BOTH that the leader's `close` fired (it exited and its
   *   stdio closed) AND that the process group is empty. Pipe closure alone is
   *   not accepted as proof (a descendant can close the pipes and live on), and
   *   elapsed time is never accepted. If the OS probe itself is unavailable
   *   (`null`) the evidence cannot be read, so the wait fails closed.
   *
   * A descendant that escaped the group (`setsid`) cannot be named here; while
   * it holds the launch's pipes `close` stays pending, so the wait ends
   * unsuccessful and the caller fails closed. One that also closed its inherited
   * stdio is unobservable to this method (no group membership, no pending
   * `close`) and may therefore look settled. Returns `true` only on the positive
   * evidence above.
   */
  private async settled(owned: OwnedProcess, timeoutMs: number): Promise<boolean> {
    const leaderPid = owned.launch.pid;
    if (!Number.isInteger(leaderPid) || leaderPid <= 1) return false;
    if (process.platform === "win32") {
      // No process-group reclaim on Windows (start refuses there): settle only
      // on the leader's own handle. Windows termination is UNTESTED.
      return this.closedWithin(owned.done, timeoutMs);
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const allMembers = processGroupMemberPids(leaderPid);
      if (allMembers === null) return false;
      if (allMembers.length === 0) owned.leaderGroupObservedEmpty = true;
      const descendants = allMembers.filter((pid) => pid !== leaderPid && pid > 1);
      if (descendants.length > 0 && !owned.leaderGroupObservedEmpty) {
        const current = new Set(processGroupMemberPids(leaderPid) ?? []);
        for (const pid of descendants) {
          if (!current.has(pid)) continue;
          try { process.kill(pid, "SIGKILL"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
      }
      const groupEmpty = allMembers.every((pid) => pid === leaderPid);
      if (groupEmpty) {
        return this.closedWithin(owned.done, Math.max(0, deadline - Date.now()));
      }
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
    }
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
