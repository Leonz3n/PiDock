import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { MAX_TERMINAL_INSTANCES } from "../main/terminal-config.js";
import { readProcessPgid, readProcessTable, type ProcessTableRow } from "./service-ownership.js";
import { MAX_PTY_ENVELOPE_BYTES, operationKey, parsePtyEvent, parsePtyRequest, sameEnvelope, type PtyEnvelope, type PtyEvent, type PtyRequest } from "./node-pty-protocol.js";
import type { NodePtyWorker } from "./node-pty-driver.js";
import type { TerminalDriver, TerminalDriverReceipt, TerminalIdentity, TerminalLaunch, TerminalProcessIdentity } from "./terminal-execution.js";

/** The forked helper handle. `kill` reaps the helper itself, never the PTY group. */
export interface PtyHelper extends NodePtyWorker {
  kill?(signal?: NodeJS.Signals): unknown;
}

/**
 * The Node runtime that hosts one forked PTY helper: an executable plus the
 * environment that switches it into Node mode. The helper is forked, so the
 * native node-pty addon is never loaded in the Host process.
 */
export interface PtyRuntime {
  executable: string;
  env: Record<string, string>;
}

/**
 * Production runtime resolution. Inside an Electron utilityProcess
 * `process.execPath` is the Electron binary, which runs as plain Node when the
 * child is started with `ELECTRON_RUN_AS_NODE=1` (node-pty 1.1.0 is N-API, so
 * the same binding is ABI-compatible). Outside Electron the resolved Node
 * binary is used with an empty helper environment. The helper environment is
 * deliberately empty - the PTY child gets its own explicit `launch.env`.
 */
export function resolvePtyRuntime(): PtyRuntime {
  return process.versions.electron
    ? { executable: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } }
    : { executable: realpathSync(process.execPath), env: {} };
}

/** Poll cadence while proving a PTY group and its observed descendants drained. */
const STOP_POLL_MS = 25;
export const TERMINAL_STOP_GRACE_MS = 3000;
export const TERMINAL_STOP_CONFIRM_MS = 1000;
/**
 * Cadence of the descendant observer while a terminal is live. One unref'd
 * sampler serves the whole driver (one process-table read per cadence, no matter
 * how many terminals are open) and it is cleared as soon as none has a live root.
 */
export const TERMINAL_OBSERVE_MS = 500;
/** Bounded observation set: past it containment is no longer provable (unknown). */
const MAX_OBSERVED_DESCENDANTS = 1024;

interface Options {
  workspaceId: string;
  /** Trusted runtime resolver; injected so a test never forks a real binary. */
  runtime: () => PtyRuntime;
  onOutput(identity: TerminalIdentity, sequence: number, data: string): void;
  operationTimeoutMs?: number;
  spawnWorker?: () => PtyHelper;
  stopGraceMs?: number;
  stopConfirmMs?: number;
  /** Cadence of the descendant observer while a terminal is live (tests inject it). */
  observeCadenceMs?: number;
}

/**
 * The compiled helper entry. It sits beside the compiled driver; when the driver
 * itself runs from TypeScript sources (vitest), the compiled sibling is taken
 * from `dist` instead of the unreachable `src` path.
 */
export function workerEntryUrl(): URL {
  const sibling = new URL("./node-pty-worker.js", import.meta.url);
  return existsSync(fileURLToPath(sibling)) ? sibling : new URL("../../dist/host/node-pty-worker.js", import.meta.url);
}

interface Operation {
  envelope: PtyEnvelope;
  worker?: PtyHelper;
  status: "started" | "not-started" | "unknown";
  fenced: boolean;
  sequence: number;
  requestId: number;
  inputBytes: number;
  rootPid?: number;
  processGroupId?: number;
  ptyExit?: { exitCode: number; signal: number };
  workerExit?: { code: number | null; signal: string | null };
  /**
   * Descendants observed alive under this operation's root while it ran, with
   * the process group each was in at that moment. This is the only handle the
   * driver can ever have on a job-control descendant: it leaves the recorded
   * group, and once the root exits this platform revokes the terminal's session
   * and reparents it to init, leaving no post-mortem link to this terminal.
   */
  descendants: Map<number, number>;
  /** The observation cap was hit, so containment can no longer be proven. */
  descendantOverflow: boolean;
  observed: boolean;
  observe(receipt: TerminalDriverReceipt): void;
  pending?: { action: PtyRequest["action"]; resolve(event: PtyEvent & { kind: "reply" }): void };
}

/** Every pid whose parent chain reaches `rootPid` in one process-table snapshot. */
export function descendantPids(table: readonly ProcessTableRow[], rootPid: number): number[] {
  const children = new Map<number, number[]>();
  for (const row of table) {
    if (row.pid <= 1 || row.pid === rootPid) continue;
    const list = children.get(row.ppid);
    if (list) list.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }
  const found: number[] = [];
  const queue = [...(children.get(rootPid) ?? [])];
  const seen = new Set<number>(queue);
  while (queue.length > 0) {
    const pid = queue.shift()!;
    found.push(pid);
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return found.sort((left, right) => left - right);
}

/**
 * Production PTY driver for [PiDock 10] (#15).
 *
 * Contract and boundaries - do not present them as stronger than they are:
 * - `spawn` forks `node-pty-worker.js` with the injected runtime and dispatches
 *   the explicit program/argv/cwd/env/cols/rows. The native addon lives in the
 *   forked helper, never in the Host process. Output is forwarded to the caller's
 *   bounded sink; the driver itself keeps no history.
 * - The recorded identity is the pty child's pid plus its process-group id. A
 *   forkpty child is a session/group leader, so this driver reads the OS pgid
 *   and refuses to treat the group as its own unless `pgid === pid`. That check
 *   is re-read before every group signal, so a recycled pid cannot make this
 *   driver signal a foreign group through the group path. Individual members are
 *   signalled with the group they were captured in as their identity: a pid that
 *   is no longer in that group (recycled, or moved) is left alone, and the
 *   unproven drain is reported as `unknown` instead.
 * - `stop` signals only the recorded group (`-pgid`), then reclaims the
 *   descendant tree that was observed *before* the signal (an interactive shell
 *   puts each job in its own group, so the group alone does not contain it). A
 *   `tree-drained` receipt requires positive evidence from the OS process table:
 *   no member of the recorded group and none of the captured descendants is
 *   alive. Anything else - an unreadable table, a missing/mismatching identity,
 *   or survivors after the kill deadline - is reported as `unknown`, never as a
 *   stop that was not verified.
 * - The same evidence model governs an exit the terminal reaches on its own.
 *   While a root is alive the driver records the descendants it holds (before
 *   every control request and on a bounded cadence). On a natural exit it
 *   reclaims the members still in the recorded group *and* those recorded
 *   descendants, then requires the same positive evidence before the exit
 *   receipt is issued - so a job-control child that outlives its shell is
 *   contained, not abandoned behind a reported exit. Boundary: a descendant
 *   that left the group and was never recorded while the root was alive (its own
 *   `setsid`, or one created in the last observation interval before an
 *   unattended exit) has no OS-visible link to this terminal once the root dies -
 *   the parent link is gone, the session and controlling terminal are revoked -
 *   so it is out of this evidence model. The process group plus the recorded
 *   descendants are the boundary, not an OS sandbox.
 * - There is no `kill`/`destroy` request to the helper: termination is a Host
 *   signal to the group it recorded. The helper is reaped after the group
 *   drained so a stopped terminal leaves no helper behind.
 * - Windows process-group signalling is UNTESTED (`ps` backends are unavailable);
 *   the worker refuses non-darwin-arm64 prebuilds via its preflight.
 */
export class TerminalPtyDriver implements TerminalDriver {
  private readonly operations = new Map<string, Operation>();
  private readonly timeout: number;
  private readonly grace: number;
  private readonly confirm: number;
  private readonly observeCadence: number;
  private readonly options: Options;
  /** The shared descendant sampler; only alive while some root is live. */
  private observer?: NodeJS.Timeout;

  constructor(options: Options) {
    this.options = { ...options };
    this.timeout = options.operationTimeoutMs ?? 5000;
    this.grace = options.stopGraceMs ?? TERMINAL_STOP_GRACE_MS;
    this.confirm = options.stopConfirmMs ?? TERMINAL_STOP_CONFIRM_MS;
    this.observeCadence = options.observeCadenceMs ?? TERMINAL_OBSERVE_MS;
    if (!Number.isInteger(this.timeout) || this.timeout < 10 || this.timeout > 30_000) throw Error("invalid-pty-deadline");
    if (!Number.isInteger(this.grace) || this.grace < 10 || this.grace > 30_000) throw Error("invalid-pty-deadline");
    if (!Number.isInteger(this.confirm) || this.confirm < 10 || this.confirm > 30_000) throw Error("invalid-pty-deadline");
    if (!Number.isInteger(this.observeCadence) || this.observeCadence < 10 || this.observeCadence > 30_000) throw Error("invalid-pty-deadline");
  }

  /**
   * Start or clear the one descendant sampler this driver owns. It runs only
   * while some operation has a live root, is never a reason for the process to
   * stay alive (`unref`), and stops itself as soon as none is left.
   */
  private syncObserver(): void {
    const wanted = [...this.operations.values()].some((operation) =>
      operation.rootPid !== undefined && operation.status === "started" && !operation.fenced && !operation.observed);
    if (wanted && !this.observer) {
      this.observer = setInterval(() => {
        for (const operation of this.operations.values()) this.observeDescendants(operation);
        this.syncObserver();
      }, this.observeCadence);
      this.observer.unref();
    } else if (!wanted && this.observer) {
      clearInterval(this.observer);
      this.observer = undefined;
    }
  }

  /**
   * Record the live descendants of one operation's root. Called while that root
   * is still alive (before each control request and on the observer cadence): a
   * job-control descendant leaves the recorded group, and once the root exits
   * this platform revokes the session and reparents it to init, so a pid
   * recorded here is the only handle this driver can ever have on it. A
   * descendant recorded gone is forgotten, which also keeps a recycled pid from
   * being later treated as ours.
   */
  private observeDescendants(operation: Operation): void {
    const rootPid = operation.rootPid;
    if (rootPid === undefined || rootPid <= 1 || operation.fenced || operation.observed) return;
    const table = readProcessTable();
    if (table === null) return;
    const rows = new Map(table.map((row) => [row.pid, row]));
    for (const pid of [...operation.descendants.keys()]) if (!rows.has(pid)) operation.descendants.delete(pid);
    for (const pid of descendantPids(table, rootPid)) {
      if (operation.descendants.has(pid)) continue;
      if (operation.descendants.size >= MAX_OBSERVED_DESCENDANTS) { operation.descendantOverflow = true; return; }
      const row = rows.get(pid);
      if (row) operation.descendants.set(pid, row.pgid);
    }
  }

  private target(): PtyRuntime | null {
    try {
      const runtime = this.options.runtime();
      if (!isAbsolute(runtime.executable)) return null;
      // Only the Host's own runtime (either spelling) may host the helper, so a
      // caller can never point the forked process at an arbitrary binary.
      if (runtime.executable !== process.execPath && runtime.executable !== realpathSync(process.execPath)) return null;
      const invalid = Object.entries(runtime.env).some(([key, value]) =>
        !key || key.includes("=") || key.includes("\0") || typeof value !== "string" || value.includes("\0"));
      return invalid ? null : runtime;
    } catch {
      return null;
    }
  }

  private result(operation: Operation): { status: Operation["status"]; process?: TerminalProcessIdentity } {
    return {
      status: operation.status,
      ...(operation.rootPid !== undefined && operation.processGroupId !== undefined
        ? { process: { processId: operation.rootPid, processGroupId: operation.processGroupId } }
        : {}),
    };
  }

  private unknown(operation: Operation): void {
    if (operation.status === "not-started") return;
    const newlyFenced = !operation.fenced;
    operation.fenced = true;
    operation.status = "unknown";
    operation.pending?.resolve({ ...operation.envelope, kind: "reply", requestId: operation.requestId, status: "unknown" });
    if (newlyFenced) this.report(operation, { ...operation.envelope.identity, status: "unknown" });
    this.syncObserver();
  }

  private report(operation: Operation, receipt: TerminalDriverReceipt): void {
    if (operation.observed) return;
    operation.observed = true;
    try {
      operation.observe(receipt);
    } catch {
      // The retained identity cannot be changed by a caller-side observer.
    }
  }

  async spawn(identity: TerminalIdentity, launch: TerminalLaunch, observe: (receipt: TerminalDriverReceipt) => void) {
    const key = operationKey(identity), retained = this.operations.get(key);
    if (retained) return this.result(retained);
    if (this.operations.size >= MAX_TERMINAL_INSTANCES) return { status: "not-started" as const };
    const operation: Operation = {
      envelope: { workspaceId: this.options.workspaceId, identity: { ...identity }, operationId: randomUUID() },
      status: "unknown", fenced: false, sequence: 0, requestId: 0, inputBytes: 0,
      descendants: new Map(), descendantOverflow: false, observed: false, observe,
    };
    this.operations.set(key, operation);
    let request: PtyRequest & { action: "spawn" };
    let runtime: PtyRuntime;
    try {
      const parsed = parsePtyRequest({ ...operation.envelope, requestId: 1, action: "spawn", launch: structuredClone(launch) });
      const resolved = this.target();
      if (parsed.action !== "spawn" || !resolved) throw Error();
      request = parsed;
      runtime = resolved;
    } catch {
      this.operations.delete(key);
      return { status: "not-started" as const };
    }
    try {
      operation.worker = this.options.spawnWorker?.() ?? fork(workerEntryUrl(), [], {
        execPath: runtime.executable, execArgv: [], env: { ...runtime.env }, cwd: request.launch.cwd,
        stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json",
      });
    } catch {
      // `fork` threw before a helper existed: nothing was started, so this is a
      // proven `not-started` rather than an uncertain spawn.
      this.operations.delete(key);
      return { status: "not-started" as const };
    }
    operation.worker.on("message", (raw) => this.receive(operation, raw));
    // A helper that goes away while its PTY child is still alive makes the
    // operation uncontrollable (`unknown`). After the child's own exit event the
    // helper's shutdown is expected, so it must not clobber the pending
    // natural-exit receipt (the group may still need reclaiming).
    const workerGone = () => { if (operation.ptyExit === undefined) this.unknown(operation); };
    operation.worker.on("error", workerGone);
    operation.worker.on("disconnect", workerGone);
    operation.worker.on("exit", (code, signal) => { operation.workerExit = { code, signal }; workerGone(); });
    const reply = await this.dispatch(operation, request).catch(() => undefined);
    if (!reply || operation.fenced) return this.result(operation);
    if (reply.status === "started" && reply.rootPid !== undefined) {
      operation.rootPid = reply.rootPid;
      operation.processGroupId = reply.rootPid;
      // A forkpty child leads its own group. If the OS disagrees the group is
      // not ours to signal, so the spawn stays unknown and the single child we
      // did create is terminated directly instead of through a guessed group.
      if (readProcessPgid(reply.rootPid) !== reply.rootPid) {
        this.unknown(operation);
        try { process.kill(reply.rootPid, "SIGKILL"); } catch { /* already gone */ }
        return this.result(operation);
      }
      operation.status = "started";
      this.syncObserver();
      return this.result(operation);
    }
    if (reply.status === "not-started") operation.status = "not-started";
    else this.unknown(operation);
    return this.result(operation);
  }

  private receive(operation: Operation, raw: unknown): void {
    let event: PtyEvent;
    try {
      event = parsePtyEvent(raw);
      if (!sameEnvelope(operation.envelope, event)) throw Error();
    } catch {
      this.unknown(operation);
      return;
    }
    if (event.kind === "phase") return;
    if (event.kind === "exit") {
      if (operation.ptyExit) { this.unknown(operation); return; }
      operation.ptyExit = { exitCode: event.exitCode, signal: event.signal };
      void this.settle(operation);
      return;
    }
    if (event.kind === "output") {
      if (event.sequence !== operation.sequence + 1 || operation.ptyExit || operation.fenced) { this.unknown(operation); return; }
      operation.sequence = event.sequence;
      try {
        this.options.onOutput({ ...operation.envelope.identity }, event.sequence, event.data);
      } catch {
        this.unknown(operation);
      }
      return;
    }
    if (event.requestId > operation.requestId) { this.unknown(operation); return; }
    if (event.status === "unknown") { this.unknown(operation); return; }
    if (event.rootPid !== undefined) operation.rootPid ??= event.rootPid;
    if (!operation.pending || event.requestId !== operation.requestId) return;
    if ((operation.pending.action === "spawn" && !["started", "not-started", "unknown"].includes(event.status)) ||
        (operation.pending.action !== "spawn" && !["accepted", "unknown"].includes(event.status))) { this.unknown(operation); return; }
    operation.pending.resolve(event);
  }

  /**
   * A PTY root exit alone never proves the tree ended. The receipt is
   * `tree-drained` only when the OS process table reports no member of the
   * recorded group and no recorded descendant left; an unreadable table, a
   * saturated observation set, or a survivor after the kill deadline is
   * reported as `unknown`.
   */
  private async settle(operation: Operation): Promise<void> {
    if (operation.fenced || operation.observed) return;
    // The descendants recorded while the root was alive. There is no later
    // moment at which a job-control descendant can be named (this platform
    // revokes the session and reparents it to init when the leader exits), so
    // this set - not a post-mortem probe - is what the natural exit contains.
    const captured = new Map(operation.descendants);
    const capturedPids = [...captured.keys()];
    if (await this.drainWithin(operation, capturedPids, this.grace) !== true) {
      if (operation.fenced || operation.observed) return;
      // The root ended but members of its own group outlived it (a `set +m`
      // background child) or recorded descendants left the group. Reclaim both,
      // then require the same positive evidence before an exit receipt exists.
      this.signalCaptured(this.groupMemberIdentities(operation), "SIGKILL");
      this.signalCaptured(captured, "SIGKILL");
      if (await this.drainWithin(operation, capturedPids, this.confirm) !== true) {
        if (operation.fenced || operation.observed) return;
        this.fence(operation);
        this.report(operation, { ...operation.envelope.identity, status: "unknown" });
        this.syncObserver();
        return;
      }
    }
    this.fence(operation);
    this.forget(operation);
    this.report(operation, { ...operation.envelope.identity, status: "tree-drained", exitCode: operation.ptyExit?.exitCode ?? 0 });
    await this.reap(operation);
  }

  /** Pids still in the recorded group (excluding the root), keyed by that group. */
  private groupMemberIdentities(operation: Operation): Map<number, number> {
    const members = new Map<number, number>();
    const pgid = operation.processGroupId;
    if (pgid === undefined || pgid <= 1) return members;
    const table = readProcessTable();
    if (table === null) return members;
    for (const row of table) if (row.pgid === pgid && row.pid !== operation.rootPid && row.pid > 1) members.set(row.pid, pgid);
    return members;
  }

  private fence(operation: Operation): void {
    operation.fenced = true;
    operation.status = "unknown";
  }

  /**
   * Drop the operation from the bounded map. Called before its end receipt is
   * made visible (and again while reaping), so a caller that observed a proven
   * end can start the same identity again instead of resolving against a stale
   * operation - and so finished lifecycles never occupy the instance cap.
   */
  private forget(operation: Operation): void {
    const key = operationKey(operation.envelope.identity);
    // Compare-and-delete: a reap that finishes after a later operation took the
    // same key must not drop that operation (the identity is reused across a
    // restart, so a late delete would leave the new terminal untracked).
    if (this.operations.get(key) === operation) this.operations.delete(key);
    this.syncObserver();
  }

  private async dispatch(operation: Operation, request: PtyRequest): Promise<PtyEvent & { kind: "reply" }> {
    if (operation.pending) return Promise.reject(Error("terminal-pty-busy"));
    operation.requestId = request.requestId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.unknown(operation), this.timeout);
      operation.pending = { action: request.action, resolve: (event) => { clearTimeout(timer); operation.pending = undefined; resolve(event); } };
      try {
        operation.worker!.send(request, (error) => { if (error) this.unknown(operation); });
      } catch {
        this.unknown(operation);
      }
    });
  }

  private async control(identity: TerminalIdentity, payload: { action: "input"; data: string } | { action: "resize"; cols: number; rows: number }): Promise<void> {
    const operation = this.operations.get(operationKey(identity));
    if (!operation || operation.status !== "started" || operation.fenced || operation.pending) throw Error("terminal-pty-unconfirmed");
    // Record what this terminal owns before handing it input or a window size:
    // the root is alive here, which is the only time its descendants are
    // attributable to it.
    this.observeDescendants(operation);
    const request = parsePtyRequest({ ...operation.envelope, requestId: operation.requestId + 1, ...payload });
    if (payload.action === "input") {
      // node-pty has no write-drained acknowledgement; a lifetime byte budget
      // bounds its internal queue conservatively without inventing delivery.
      operation.inputBytes += Buffer.byteLength(payload.data);
      if (operation.inputBytes > MAX_PTY_ENVELOPE_BYTES) { this.unknown(operation); throw Error("terminal-pty-unconfirmed"); }
    }
    const reply = await this.dispatch(operation, request);
    if (reply.status !== "accepted" || operation.fenced) { this.unknown(operation); throw Error("terminal-pty-unconfirmed"); }
  }

  /** Success means node-pty accepted input into its write queue, not application delivery. */
  input(identity: TerminalIdentity, data: string): Promise<void> { return this.control(identity, { action: "input", data }); }

  resize(identity: TerminalIdentity, cols: number, rows: number): Promise<void> { return this.control(identity, { action: "resize", cols, rows }); }

  private signalGroup(operation: Operation, kind: NodeJS.Signals): void {
    const rootPid = operation.rootPid, pgid = operation.processGroupId;
    if (rootPid === undefined || pgid === undefined || pgid <= 1 || rootPid <= 1) return;
    // Re-read the identity immediately before the signal: a pid that no longer
    // leads exactly this group is not ours to signal.
    if (readProcessPgid(rootPid) !== pgid) return;
    try {
      process.kill(-pgid, kind);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  /**
   * Signal individual pids that this driver captured, requiring each to still be
   * in the process group it was captured in. A pid is a number the OS can
   * recycle between capture and signal; the group it belonged to is the
   * strongest identity left for an orphan whose parent link is already gone, so
   * a pid that is gone or changed group is left alone (and its drain then stays
   * unproven, which is reported as `unknown` rather than as a verified stop).
   */
  private signalCaptured(captured: ReadonlyMap<number, number>, kind: NodeJS.Signals): void {
    if (captured.size === 0) return;
    const table = readProcessTable();
    if (table === null) return;
    const groups = new Map(table.map((row) => [row.pid, row.pgid]));
    for (const [pid, pgid] of captured) {
      if (pid <= 1 || groups.get(pid) !== pgid) continue;
      try { process.kill(pid, kind); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  }

  /** Positive evidence: the recorded group and the captured subtree are gone. */
  private drained(operation: Operation, captured: readonly number[]): boolean | null {
    const rootPid = operation.rootPid;
    if (rootPid === undefined || operation.processGroupId === undefined) return null;
    // A saturated observation set cannot prove the tree ended: fail closed.
    if (operation.descendantOverflow) return false;
    const table = readProcessTable();
    if (table === null) return null;
    const pids = new Set(table.map((row) => row.pid));
    if (pids.has(rootPid)) return false;
    if (table.some((row) => row.pgid === operation.processGroupId)) return false;
    return !captured.some((pid) => pids.has(pid));
  }

  private async drainWithin(operation: Operation, captured: readonly number[], timeoutMs: number): Promise<boolean | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const drained = this.drained(operation, captured);
      if (drained !== false) return drained;
      if (Date.now() >= deadline) return false;
      await delay(STOP_POLL_MS);
    }
  }

  /** Bounded reap of the helper after its PTY session ended. */
  private async reap(operation: Operation): Promise<void> {
    // The drained operation leaves the bounded map in every path, including the
    // one where the helper is already gone: a retained entry is what a later
    // start for this identity resolves against, and enough of them make the next
    // real start fail as `not-started` (the cap) for no real reason.
    const worker = operation.worker;
    if (!worker || operation.workerExit !== undefined) {
      this.forget(operation);
      return;
    }
    const deadline = Date.now() + this.confirm;
    while (operation.workerExit === undefined && Date.now() < deadline) await delay(STOP_POLL_MS);
    if (operation.workerExit === undefined) {
      try { worker.kill?.(); } catch { /* helper already gone */ }
    }
    this.forget(operation);
  }

  /**
   * Kill exactly the terminal this driver spawned: the recorded group, plus the
   * descendant set observed before the signal. A missing or mismatching
   * recorded identity refuses (no signal), and a confirmed stop removes the
   * retained operation so a later generation starts cleanly.
   */
  async stop(identity: TerminalIdentity): Promise<TerminalDriverReceipt> {
    const key = operationKey(identity), operation = this.operations.get(key);
    if (!operation || operation.status === "not-started") return { ...identity, status: operation ? "not-started" : "unknown" };
    const rootPid = operation.rootPid, pgid = operation.processGroupId;
    if (rootPid === undefined || pgid === undefined || rootPid <= 1 || pgid <= 1) return { ...identity, status: "unknown" };
    const identityAlive = readProcessPgid(rootPid) === pgid;
    const table = readProcessTable();
    if (table === null) {
      // The OS probe is the only drain evidence; without it nothing may be
      // reported as a verified stop, though the recorded group is still signalled.
      if (identityAlive) this.signalGroup(operation, "SIGTERM");
      return { ...identity, status: "unknown" };
    }
    // What the root holds now, plus what this driver recorded while it was alive
    // (a descendant whose parent chain broke earlier is only in the latter).
    const rows = new Map(table.map((row) => [row.pid, row]));
    const captured = new Map<number, number>();
    if (identityAlive || table.some((row) => row.pid === rootPid)) {
      for (const pid of descendantPids(table, rootPid)) {
        const row = rows.get(pid);
        if (row) captured.set(pid, row.pgid);
      }
    }
    for (const [pid, group] of operation.descendants) if (!captured.has(pid)) captured.set(pid, group);
    const capturedPids = [...captured.keys()];
    // SIGHUP, not SIGTERM: the pty's own hangup is what an interactive shell
    // honours (it ignores SIGTERM while a job is in the foreground), and it is
    // what closing a real terminal sends. The confirm phase still SIGKILLs.
    if (identityAlive) this.signalGroup(operation, "SIGHUP");
    this.signalCaptured(this.groupMemberIdentities(operation), "SIGHUP");
    this.signalCaptured(captured, "SIGHUP");
    if (await this.drainWithin(operation, capturedPids, this.grace) === true) return this.finish(operation, identity);
    // Once the leader is gone `-pgid` can no longer be re-verified, so the
    // remaining members are signalled individually (each pid re-checked against
    // the recorded group) instead of trusting a recyclable group number.
    if (readProcessPgid(rootPid) === pgid) this.signalGroup(operation, "SIGKILL");
    else this.signalCaptured(this.groupMemberIdentities(operation), "SIGKILL");
    this.signalCaptured(captured, "SIGKILL");
    if (await this.drainWithin(operation, capturedPids, this.confirm) === true) return this.finish(operation, identity);
    return { ...identity, status: "unknown" };
  }

  private finish(operation: Operation, identity: TerminalIdentity): TerminalDriverReceipt {
    this.fence(operation);
    const receipt: TerminalDriverReceipt = { ...identity, status: "tree-drained", exitCode: operation.ptyExit?.exitCode ?? 0 };
    operation.observed = true;
    this.forget(operation);
    void this.reap(operation);
    return receipt;
  }

  snapshot(identity: TerminalIdentity) {
    const operation = this.operations.get(operationKey(identity));
    return {
      status: operation?.status === "started" && !operation.fenced ? "running" as const : "unknown" as const,
      ...(operation?.rootPid !== undefined && operation.processGroupId !== undefined
        ? { process: { processId: operation.rootPid, processGroupId: operation.processGroupId } }
        : {}),
    };
  }
}
