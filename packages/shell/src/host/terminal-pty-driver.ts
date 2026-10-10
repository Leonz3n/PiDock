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

interface Options {
  workspaceId: string;
  /** Trusted runtime resolver; injected so a test never forks a real binary. */
  runtime: () => PtyRuntime;
  onOutput(identity: TerminalIdentity, sequence: number, data: string): void;
  operationTimeoutMs?: number;
  spawnWorker?: () => PtyHelper;
  stopGraceMs?: number;
  stopConfirmMs?: number;
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
 *   is re-read before every group signal, so a recycled pid can never make this
 *   driver signal a foreign group.
 * - `stop` signals only the recorded group (`-pgid`), then reclaims the
 *   descendant tree that was observed *before* the signal (an interactive shell
 *   puts each job in its own group, so the group alone does not contain it). A
 *   `tree-drained` receipt requires positive evidence from the OS process table:
 *   no member of the recorded group and none of the captured descendants is
 *   alive. Anything else - an unreadable table, a missing/mismatching identity,
 *   or survivors after the kill deadline - is reported as `unknown`, never as a
 *   stop that was not verified. When the PTY root exits on its own, the members
 *   still in its own group are reclaimed before the exit receipt is issued, so
 *   a `set +m` background child never outlives a reported natural exit. A
 *   descendant that left the group *and* is not observed before the signal (its
 *   own `setsid`, or a job started after the capture) cannot be named by this
 *   evidence model - its parent link died with the root - so it is reported as
 *   `unknown`; the process group and the observed subtree are the boundary, not
 *   an OS sandbox.
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
  private readonly options: Options;

  constructor(options: Options) {
    this.options = { ...options };
    this.timeout = options.operationTimeoutMs ?? 5000;
    this.grace = options.stopGraceMs ?? TERMINAL_STOP_GRACE_MS;
    this.confirm = options.stopConfirmMs ?? TERMINAL_STOP_CONFIRM_MS;
    if (!Number.isInteger(this.timeout) || this.timeout < 10 || this.timeout > 30_000) throw Error("invalid-pty-deadline");
    if (!Number.isInteger(this.grace) || this.grace < 10 || this.grace > 30_000) throw Error("invalid-pty-deadline");
    if (!Number.isInteger(this.confirm) || this.confirm < 10 || this.confirm > 30_000) throw Error("invalid-pty-deadline");
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
      status: "unknown", fenced: false, sequence: 0, requestId: 0, inputBytes: 0, observed: false, observe,
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
   * recorded group left; an unreadable table or a surviving group member is
   * reported as `unknown`.
   */
  private async settle(operation: Operation): Promise<void> {
    if (operation.fenced || operation.observed) return;
    const drained = await this.groupDrained(operation, this.grace);
    if (operation.fenced || operation.observed) return;
    if (drained !== true) {
      // The root ended but members of its own group outlived it (a `set +m`
      // background child). The group number was live under this operation's own
      // recorded root moments ago, so reclaim the remaining members before
      // deciding. A descendant that started its OWN group is not nameable here
      // (its parent link died with the root) and is reported as `unknown`.
      this.signalMembers(this.groupMemberPids(operation), "SIGKILL");
      if (await this.groupDrained(operation, this.confirm) !== true) {
        if (operation.fenced || operation.observed) return;
        this.fence(operation);
        this.report(operation, { ...operation.envelope.identity, status: "unknown" });
        return;
      }
    }
    this.fence(operation);
    this.report(operation, { ...operation.envelope.identity, status: "tree-drained", exitCode: operation.ptyExit?.exitCode ?? 0 });
    await this.reap(operation);
  }

  /** Pids still in the recorded group, excluding this operation's own root. */
  private groupMemberPids(operation: Operation): number[] {
    const pgid = operation.processGroupId;
    if (pgid === undefined || pgid <= 1) return [];
    const table = readProcessTable();
    if (table === null) return [];
    return table.filter((row) => row.pgid === pgid && row.pid !== operation.rootPid).map((row) => row.pid).sort((a, b) => a - b);
  }

  private fence(operation: Operation): void {
    operation.fenced = true;
    operation.status = "unknown";
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

  private signalMembers(members: readonly number[], kind: NodeJS.Signals): void {
    if (members.length === 0) return;
    const table = readProcessTable();
    if (table === null) return;
    const alive = new Set(table.map((row) => row.pid));
    for (const pid of members) {
      if (pid <= 1 || !alive.has(pid)) continue;
      try { process.kill(pid, kind); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  }

  /** Positive evidence: the recorded group and the captured subtree are gone. */
  private drained(operation: Operation, captured: readonly number[]): boolean | null {
    const rootPid = operation.rootPid;
    if (rootPid === undefined || operation.processGroupId === undefined) return null;
    const table = readProcessTable();
    if (table === null) return null;
    const pids = new Set(table.map((row) => row.pid));
    if (pids.has(rootPid)) return false;
    if (table.some((row) => row.pgid === operation.processGroupId)) return false;
    return !captured.some((pid) => pids.has(pid));
  }

  private async groupDrained(operation: Operation, timeoutMs: number): Promise<boolean | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const drained = this.drained(operation, []);
      if (drained !== false) return drained;
      if (Date.now() >= deadline) return false;
      await delay(STOP_POLL_MS);
    }
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
    const worker = operation.worker;
    if (!worker || operation.workerExit !== undefined) return;
    const deadline = Date.now() + this.confirm;
    while (operation.workerExit === undefined && Date.now() < deadline) await delay(STOP_POLL_MS);
    if (operation.workerExit === undefined) {
      try { worker.kill?.(); } catch { /* helper already gone */ }
    }
    this.operations.delete(operationKey(operation.envelope.identity));
  }

  /**
   * Kill exactly the terminal this driver spawned: the recorded group, plus the
   * descendant tree observed before the signal. A missing or mismatching
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
    const captured = identityAlive || table.some((row) => row.pid === rootPid) ? descendantPids(table, rootPid) : [];
    // SIGHUP, not SIGTERM: the pty's own hangup is what an interactive shell
    // honours (it ignores SIGTERM while a job is in the foreground), and it is
    // what closing a real terminal sends. The confirm phase still SIGKILLs.
    if (identityAlive) this.signalGroup(operation, "SIGHUP");
    this.signalMembers(this.groupMemberPids(operation), "SIGHUP");
    this.signalMembers(captured, "SIGHUP");
    if (await this.drainWithin(operation, captured, this.grace) === true) return this.finish(operation, identity);
    // Once the leader is gone `-pgid` can no longer be re-verified, so the
    // remaining members are signalled individually (each pid re-checked against
    // the recorded group) instead of trusting a recyclable group number.
    if (readProcessPgid(rootPid) === pgid) this.signalGroup(operation, "SIGKILL");
    else this.signalMembers(this.groupMemberPids(operation), "SIGKILL");
    this.signalMembers(captured, "SIGKILL");
    if (await this.drainWithin(operation, captured, this.confirm) === true) return this.finish(operation, identity);
    return { ...identity, status: "unknown" };
  }

  private finish(operation: Operation, identity: TerminalIdentity): TerminalDriverReceipt {
    this.fence(operation);
    const receipt: TerminalDriverReceipt = { ...identity, status: "tree-drained", exitCode: operation.ptyExit?.exitCode ?? 0 };
    operation.observed = true;
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
