import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { MAX_TERMINAL_INSTANCES } from "../main/terminal-config.js";
import { readProcessPgid, readProcessTable, type ProcessTableRow } from "./service-ownership.js";
import { nodePtyPlatformAdmitted } from "./node-pty-preflight.js";
import { MAX_PTY_ENVELOPE_BYTES, operationKey, parsePtyEvent, parsePtyRequest, sameEnvelope, type PtyEnvelope, type PtyEvent, type PtyRequest } from "./node-pty-protocol.js";
import type { NodePtyWorker } from "./node-pty-driver.js";
import { readWin32ProcessTable, win32ProcessAlive, type Win32ProcessRow } from "./win32-process-probe.js";
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
 * the binding is not tied to one Node version). That Electron path is UNTESTED
 * in this slice - the real-process tests cover the plain Node path. Outside
 * Electron the resolved Node binary is used with an empty helper environment.
 * The helper environment is deliberately empty - the PTY child gets its own
 * explicit `launch.env`.
 */
export function resolvePtyRuntime(): PtyRuntime {
  return process.versions.electron
    ? { executable: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } }
    : { executable: realpathSync(process.execPath), env: {} };
}

/**
 * Whether this Host can really fork the PTY helper. The worker admits only the
 * platforms the pin record admits (`nodePtyPlatformAdmitted`), so a Host that can
 * never spawn reports `spawnImplemented: false` and the renderer keeps its
 * residual warning instead of only failing every start with a per-attempt
 * `terminal-not-started` error. Whether the prebuild itself is prepared is
 * checked per spawn by the worker's preflight, not here.
 *
 * This is a claim about STARTING a terminal and nothing more: win32-x64 is
 * admitted because a real ConPTY terminal really starts there (#55), which is
 * why the flag is true on a platform whose ownership is expressed through the
 * helper handle rather than a process group (`ptyProcessGroupOwnershipAvailable`,
 * `ptyHelperHandleStopAvailable`). The flag never promised a process group and
 * is not stretched into one.
 */
export function ptySpawnerAvailable(): boolean {
  return nodePtyPlatformAdmitted();
}

/**
 * Whether this platform exposes the POSIX process-group ownership every
 * containment path here is expressed in: a readable per-pid `pgid`
 * (`readProcessPgid`) plus a group signal (`kill(-pgid)`).
 *
 * - What win32 CAN do (measured under #55): start a real ConPTY terminal - the
 *   win32-x64 prebuild is pinned by the preflight, the worker spawns a real
 *   process with a real window size, and `ptySpawnerAvailable()` is true there.
 * - What win32 CANNOT do: name, re-verify or signal a process group. There is no
 *   group to read (`readProcessPgid` returns null there by design) and no
 *   `kill(-pgid)`, and a bare pid may name a recycled process by the time a
 *   signal could be sent - the group re-read is the only identity check the
 *   POSIX path has before signalling. So on win32: `spawn` records the pid alone
 *   and no group (`processGroupId` stays absent - never the pid, never 0), every
 *   group path is skipped here BY NAME through this one predicate, and ownership
 *   is expressed through the helper handle instead (see
 *   `ptyHelperHandleStopAvailable`). A group is never invented to make a
 *   group-shaped path look applicable.
 */
export function ptyProcessGroupOwnershipAvailable(): boolean {
  return process.platform !== "win32";
}

/**
 * Whether this platform stops a terminal by terminating the Host-owned PTY
 * helper handle instead of signalling a process group (win32).
 *
 * The helper is the `ChildProcess` this Host itself forked, so its identity is
 * a live handle the Host already holds - it cannot be recycled between two reads
 * the way a pid can. Terminating it closes the pseudo console the terminal runs
 * on, which takes the real tree with it (measured under #61: helper killed ->
 * root and its child gone). That is why the handle, and never a bare pid, is the
 * win32 containment primitive - and why `taskkill /T` by pid is deliberately NOT
 * used: it trusts a number that may name a recycled process by the time it runs,
 * which is exactly the guarantee the POSIX path buys by re-reading the group
 * before every signal.
 *
 * Not exported, and derived from `ptyProcessGroupOwnershipAvailable` instead of
 * a second platform test: the two are exact negations of one bit (#66), so a
 * second spelling could only drift and leave a platform where both or neither
 * hold with no defined meaning.
 */
function ptyHelperHandleStopAvailable(): boolean {
  return !ptyProcessGroupOwnershipAvailable();
}

/** Poll cadence while proving a PTY group and its observed descendants drained. */
const STOP_POLL_MS = 25;
export const TERMINAL_STOP_GRACE_MS = 3000;
export const TERMINAL_STOP_CONFIRM_MS = 1000;
/**
 * Cadence of the descendant observer while a terminal is live. One unref'd
 * sampler serves the whole driver and takes ONE process-table snapshot per
 * cadence, shared by every live operation, so the cost is one blocking `ps` per
 * tick no matter how many terminals are open; it is cleared as soon as none has
 * a live root.
 */
export const TERMINAL_OBSERVE_MS = 500;
/** Bounded observation set: past it containment is no longer provable (unknown). */
const MAX_OBSERVED_DESCENDANTS = 1024;
/**
 * Deliberate lifetime bound on queued input per terminal (`MAX_PTY_ENVELOPE_BYTES`).
 * The driver fences the operation and throws this exact reason so the caller can
 * name the budget it hit instead of reporting a generic delivery failure.
 */
export const PTY_INPUT_BUDGET_ERROR = "terminal-pty-input-budget-exceeded";

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
  /** OS snapshot reader; injected so a test can prove the no-snapshot fail-closed path. */
  processTable?: () => ProcessTableRow[] | null;
  /** win32 process-tree source; injected so a win32 test never spawns PowerShell. */
  win32ProcessTable?: () => Win32ProcessRow[] | null;
  /** win32 pid-liveness probe; injected with `win32ProcessTable`. */
  win32ProcessAlive?: (pid: number) => boolean;
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
  /**
   * Lower bound on the creation time of anything this terminal started: the
   * instant taken immediately BEFORE the helper `fork`, so it is provably
   * earlier than the helper and therefore than the pty child that helper forks
   * and every descendant of it (a bound taken AFTER the fork could already be
   * later than a real child, and would refuse it). Used only to refuse
   * (`descendantPids`), so it can only shrink the attributed tree.
   */
  createdAtFloor?: number;
  processGroupId?: number;
  /**
   * The controlling terminal recorded from the first snapshot that showed it
   * (the only session handle this platform exposes). Every process that shares
   * it while the root lives belongs to this terminal's session.
   */
  tty?: string;
  ptyExit?: { exitCode: number; signal: number };
  workerExit?: { code: number | null; signal: string | null };
  /**
   * The Host itself terminated this helper (the win32 stop/reap path), so its
   * exit is expected and must not be read as an uncontrollable helper loss.
   */
  helperKilled?: boolean;
  /**
   * Descendants observed alive under this operation's root while it ran, with
   * the process group each was in at that moment. This is the only handle the
   * driver can ever have on a job-control descendant: it leaves the recorded
   * group, and once the root exits this platform revokes the terminal's session
   * and reparents it to init, leaving no post-mortem link to this terminal. It
   * is taken from both the parent chain and the shared controlling terminal.
   */
  descendants: Map<number, number>;
  /** The observation cap was hit, so containment can no longer be proven. */
  descendantOverflow: boolean;
  /** Completed observations (a process-table snapshot was really read). */
  observations: number;
  /** `observations` when the last control request was dispatched. */
  requestFloor: number;
  /** A completed observation saw this root alive: the recorded set is evidence about this tree. */
  liveObservation: boolean;
  observed: boolean;
  observe(receipt: TerminalDriverReceipt): void;
  pending?: { action: PtyRequest["action"]; resolve(event: PtyEvent & { kind: "reply" }): void };
}

/**
 * Every pid whose parent chain reaches `rootPid` in one process-table snapshot.
 * Takes only the fields the walk needs, so the same walk serves both the POSIX
 * table and the independent win32 parent-chain source.
 *
 * `createdAt` (Unix epoch ms where the platform reports one) is creation-time
 * evidence, and it is used only to REFUSE an edge - never to add one. On win32
 * `ParentProcessId` is a snapshot taken at creation and never rewritten, so when
 * our fresh root is handed a recycled pid the dead owner's still-living family
 * reads as our own descendant chain (measured for #68: eight live processes of
 * another application, created ~18 h earlier, adopted by a terminal root that
 * had just started). A candidate whose creation time is strictly before the
 * process its `ppid` names - the parent of a first-level candidate being the
 * root itself - was therefore not created by that parent: the ppid is a recycled
 * number and the candidate is foreign. A real descendant is created after its
 * parent, so it is still named and a genuine leaked descendant is still caught;
 * a tie is not evidence and is kept; a missing creation time (every POSIX row,
 * and any win32 row the OS would not date) refuses nothing, so the darwin/linux
 * walk and every undated table behave exactly as before. This rule can only ever
 * shrink the attributed tree.
 *
 * That evidence needs the root's own row, so it is gone the moment the root has
 * already exited while its recycled pid still hangs a foreign family off the
 * table (#69). `createdAtFloor` is a second, independent bound that needs no row
 * at all: the caller records the instant just before it forks the helper, and
 * every real descendant of that terminal is created after the helper, hence
 * after that instant - so ANY process dated strictly before the floor cannot be
 * a descendant. It is refuse-only in the same way and for the same reason (a
 * missing creation time or a missing floor refuses nothing), and it too can only
 * shrink the tree: a real descendant is dated after the floor and is still
 * named. On darwin/linux no row carries `createdAt`, so the floor changes
 * nothing there.
 */
export function descendantPids(table: readonly { pid: number; ppid: number; createdAt?: number }[], rootPid: number, createdAtFloor?: number): number[] {
  const createdAt = new Map<number, number | undefined>();
  const children = new Map<number, number[]>();
  for (const row of table) {
    createdAt.set(row.pid, row.createdAt);
    if (row.pid <= 1 || row.pid === rootPid) continue;
    const list = children.get(row.ppid);
    if (list) list.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }
  const found: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    const parentCreatedAt = createdAt.get(pid);
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue;
      const childCreatedAt = createdAt.get(child);
      // Evidence 1 (#68): the child predates the process its `ppid` names.
      if (parentCreatedAt !== undefined && childCreatedAt !== undefined && childCreatedAt < parentCreatedAt) continue;
      // Evidence 2 (#69): the child was created before this terminal started.
      if (createdAtFloor !== undefined && childCreatedAt !== undefined && childCreatedAt < createdAtFloor) continue;
      seen.add(child);
      found.push(child);
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
 * - The recorded identity is the pty child's pid plus, where the platform
 *   exposes one, its process-group id. A forkpty child is a session/group leader,
 *   so this driver reads the OS pgid and refuses to treat the group as its own
 *   unless `pgid === pid`. That check is re-read before every group signal, so a
 *   recycled pid cannot make this driver signal a foreign group through the group
 *   path. Where there is no group to read (win32) the pid alone is recorded, no
 *   group is invented and the group paths are skipped by name. Individual members
 *   are signalled with the group they were captured in as their identity: a pid
 *   that is no longer in that group (recycled, or moved) is left alone, and the
 *   unproven drain is reported as `unknown` instead.
 * - `stop` signals only the recorded group (`-pgid`), then reclaims the
 *   descendant tree that was observed *before* the signal (an interactive shell
 *   puts each job in its own group, so the group alone does not contain it). A
 *   `tree-drained` receipt requires positive evidence from the OS process table:
 *   no member of the recorded group and none of the captured descendants is
 *   alive. Anything else - an unreadable table, a missing/mismatching identity,
 *   or survivors after the kill deadline - is reported as `unknown`, never as a
 *   stop that was not verified.
 * - While a root is alive the driver records what that terminal holds from one
 *   process-table snapshot per observation: the parent-chain descendants AND
 *   every process sharing the root's controlling terminal, i.e. the rest of its
 *   session (the session sweep). Both are needed: a job-control descendant
 *   leaves the recorded group, and it can be re-parented to init while it still
 *   shares the terminal. The sweep is only possible while the root lives,
 *   because this platform revokes the terminal when the session leader exits
 *   (measured: `tty`/`tdev` become `??`), so after the exit no survivor can be
 *   attributed to the terminal any more.
 * - The receipt vocabulary of an exit the terminal reached on its own is
 *   deliberately narrower than "the whole tree is gone", because that is not
 *   provable here (no OS process accounting: no cgroups/job objects, and this
 *   macOS `ps` exposes no session id):
 *   - `tree-drained` requires (i) an observation completed while this root was
 *     alive AND after the last dispatched control request (so no unobserved
 *     request window is left in the evidence) and (ii) the recorded group and
 *     the recorded descendants verified gone from the process table;
 *   - `root-exited` means the same verified drain, but the exit was NOT covered
 *     that way (the last control request was dispatched after the last
 *     observation, or a request was followed immediately by the exit): the root
 *     is really gone with the exit code it reported, the identities this driver
 *     recorded are gone, and a descendant created inside that last unobserved
 *     window is explicitly not covered - no whole-tree containment is claimed;
 *   - `unknown` means no observation ever saw this root alive, or survivors
 *     remain, or the process-table probe is unavailable. A self-daemonizing
 *     start plan (`/bin/sh -c 'setsid sleep 300 &'`) creates its descendant and
 *     exits inside one cadence, so it is reported `unknown` - never
 *     `tree-drained`;
 *   - a descendant that `setsid()`s into a brand-new session is out of this
 *     evidence model entirely and cannot be proven absent without OS process
 *     accounting. The process group, the observed parent chain and the recorded
 *     session are the boundary, not an OS sandbox.
 * - The exit code of a receipt is the code the pty really reported. A child the
 *   OS reports as signalled (`signal !== 0`, for which node-pty prints
 *   `exitCode: 0`) and a stop that completed before any exit event arrived carry
 *   no code at all instead of a fabricated successful `0`.
 * - There is no `kill`/`destroy` request to the helper: on POSIX termination is
 *   a Host signal to the group it recorded, and on win32 it is the Host
 *   terminating its own helper handle. Either way the helper is reaped after the
 *   terminal drained, so a stopped terminal leaves no helper behind.
 * - win32 is admitted for STARTING a terminal (ConPTY, #55) and owns one through
 *   the forked helper handle rather than a process group: no group exists to read
 *   or signal, so no group identity is recorded (`ptyProcessGroupOwnershipAvailable`)
 *   and a stop terminates the helper this Host forked
 *   (`ptyHelperHandleStopAvailable`) - a live handle whose identity cannot be
 *   recycled, unlike the bare pid `taskkill /T` would trust. The tree the OS's
 *   fixed parent chain names is read from an independent bounded source
 *   (`readWin32ProcessTable`) and verified gone before the real `tree-drained` is
 *   reported, with each descendant attributed only where the table's creation
 *   times do not contradict the chain (a recycled pid cannot adopt a family that
 *   already existed when the root started); where that cannot be established (probe unavailable, a survivor, a
 *   helper with no killable handle) the receipt stays the named `unknown`. The
 *   helper is reaped on both paths - a stop and an end the terminal reached on
 *   its own - because on win32 it does not follow its pty child, which would
 *   otherwise leak one child handle and one of the eight slots per terminal.
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
   * stay alive (`unref`), and stops itself as soon as none is left. Each tick
   * reads ONE process-table snapshot and hands it to every live operation.
   */
  private syncObserver(): void {
    const wanted = [...this.operations.values()].some((operation) =>
      operation.rootPid !== undefined && operation.status === "started" && !operation.fenced && !operation.observed);
    if (wanted && !this.observer) {
      this.observer = setInterval(() => {
        const table = this.readTable();
        for (const operation of this.operations.values()) this.observeDescendants(operation, table);
        this.syncObserver();
      }, this.observeCadence);
      this.observer.unref();
    } else if (!wanted && this.observer) {
      clearInterval(this.observer);
      this.observer = undefined;
    }
  }

  /** The OS snapshot every decision is taken from (injected in tests). */
  private readTable(): ProcessTableRow[] | null {
    return this.options.processTable ? this.options.processTable() : readProcessTable();
  }

  /**
   * Record what one operation's terminal holds, from one snapshot. Called while
   * that root is still alive (before each control request and on the observer
   * cadence): a job-control descendant leaves the recorded group, and once the
   * root exits this platform revokes the terminal and reparents it to init, so a
   * pid recorded here is the only handle this driver can ever have on it. A
   * descendant recorded gone is forgotten, which also keeps a recycled pid from
   * being later treated as ours.
   */
  private observeDescendants(operation: Operation, table: ProcessTableRow[] | null): void {
    const rootPid = operation.rootPid;
    if (rootPid === undefined || rootPid <= 1 || operation.fenced || operation.observed) return;
    // A probe that could not run is not an observation: it exists neither as
    // descendant evidence nor as coverage of a later exit.
    if (table === null) return;
    operation.observations += 1;
    const rows = new Map(table.map((row) => [row.pid, row]));
    const root = rows.get(rootPid);
    // A zombie still names the pid but no longer holds the terminal's session,
    // so only a live root row makes the snapshot evidence about this tree.
    const live = root !== undefined && !root.state.startsWith("Z");
    if (live) operation.liveObservation = true;
    if (live && operation.tty === undefined && root.tty !== "??" && root.tty !== "?") operation.tty = root.tty;
    for (const pid of [...operation.descendants.keys()]) if (!rows.has(pid)) operation.descendants.delete(pid);
    const observed = new Set<number>(descendantPids(table, rootPid));
    for (const pid of this.sessionMembers(operation, table, root)) observed.add(pid);
    for (const pid of [...observed].sort((left, right) => left - right)) {
      if (operation.descendants.has(pid)) continue;
      if (operation.descendants.size >= MAX_OBSERVED_DESCENDANTS) { operation.descendantOverflow = true; return; }
      const row = rows.get(pid);
      if (row) operation.descendants.set(pid, row.pgid);
    }
  }

  /**
   * The rest of this terminal's session from one snapshot: every process that
   * shares the root's controlling terminal. It is the session sweep - only
   * meaningful while the session leader is alive, because this platform revokes
   * the terminal when it exits (measured: `tty`/`tdev` become `??`) - and it is
   * what makes a job-control descendant visible after it left the recorded group
   * *and* was re-parented to init. It never widens the signalling rule: a swept
   * pid is only ever signalled while its current group still equals the group it
   * was captured in.
   */
  private sessionMembers(operation: Operation, table: readonly ProcessTableRow[], root: ProcessTableRow | undefined): number[] {
    if (root === undefined || root.state.startsWith("Z")) return [];
    const tty = operation.tty ?? (root.tty !== "??" && root.tty !== "?" ? root.tty : undefined);
    if (tty === undefined) return [];
    return table.filter((row) => row.pid > 1 && row.pid !== operation.rootPid && row.tty === tty).map((row) => row.pid);
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
      ...(operation.rootPid !== undefined
        ? { process: { processId: operation.rootPid, ...(operation.processGroupId !== undefined ? { processGroupId: operation.processGroupId } : {}) } }
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
    // A fenced operation that never recorded a root identity has no pid to
    // contain and nothing a later control request could act on: retaining it
    // would only wedge this identity (`terminal-owned` on a retry, `unknown`
    // stop) and hold one of the eight instance slots forever. The helper is
    // reaped with it, so an ambiguous spawn leaves no forked process behind.
    if (operation.rootPid === undefined) {
      this.forget(operation);
      void this.reap(operation);
    } else {
      this.syncObserver();
    }
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
      descendants: new Map(), descendantOverflow: false, observations: 0, requestFloor: 0,
      liveObservation: false, observed: false, observe,
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
      // Taken here, before the fork: a true lower bound on the creation time of
      // every process of this terminal, and independent of the snapshot (the
      // root's own row may already be gone - #69).
      operation.createdAtFloor = Date.now();
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
    // natural-exit receipt (the group may still need reclaiming) - and a helper
    // the Host itself terminated (the win32 stop/reap path) is expected to go
    // away here, because its exit is exactly what that path waits for.
    const workerGone = () => { if (operation.ptyExit === undefined && !operation.helperKilled) this.unknown(operation); };
    operation.worker.on("error", workerGone);
    operation.worker.on("disconnect", workerGone);
    operation.worker.on("exit", (code, signal) => { operation.workerExit = { code, signal }; workerGone(); });
    const reply = await this.dispatch(operation, request).catch(() => undefined);
    if (!reply || operation.fenced) return this.result(operation);
    if (reply.status === "started" && reply.rootPid !== undefined) {
      operation.rootPid = reply.rootPid;
      // A forkpty child leads its own group. If the OS disagrees the group is
      // not ours to signal, so the spawn stays unknown and the single child we
      // did create is terminated directly instead of through a guessed group.
      // Where the platform has no group at all (win32) the check is not skipped
      // but inapplicable: the pid is recorded, a group is not.
      if (ptyProcessGroupOwnershipAvailable()) {
        operation.processGroupId = reply.rootPid;
        if (readProcessPgid(reply.rootPid) !== reply.rootPid) {
          this.unknown(operation);
          try { process.kill(reply.rootPid, "SIGKILL"); } catch { /* already gone */ }
          return this.result(operation);
        }
      }
      operation.status = "started";
      this.syncObserver();
      return this.result(operation);
    }
    if (reply.status === "not-started") {
      // Nothing was started, so the identity is free again: a retained
      // `not-started` operation would answer every later start for this
      // identity with the same stale error (even after the cause is fixed) and
      // would count against the instance cap.
      operation.status = "not-started";
      this.forget(operation);
      void this.reap(operation);
    } else this.unknown(operation);
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
   * The exit code the pty really reported. `undefined` means none was observed:
   * the terminal was stopped before its exit event arrived, or the OS reported
   * the child as signalled - node-pty prints `exitCode: 0` for a signalled child,
   * so forwarding that would fabricate a clean exit.
   */
  private observedExitCode(operation: Operation): number | undefined {
    const exit = operation.ptyExit;
    return exit === undefined || exit.signal !== 0 ? undefined : exit.exitCode;
  }

  /**
   * A PTY root exit alone never proves the tree ended. The receipt is
   * `tree-drained` only when an observation covered the exit (see {@link settle});
   * an exit whose last control request was never observed is reported as
   * `root-exited` - the same verified drain, without a whole-tree claim - and a
   * terminal whose root was never observed alive is reported as `unknown`.
   */
  private async settle(operation: Operation): Promise<void> {
    if (operation.fenced || operation.observed) return;
    if (ptyHelperHandleStopAvailable()) { await this.settleByHelper(operation); return; }
    // Decided once, from the state as the exit event arrives: a cadence tick
    // that lands while this exit is being verified must not turn an unobserved
    // window into observed evidence.
    const covered = operation.liveObservation && operation.observations > operation.requestFloor;
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
    if (!operation.liveObservation) {
      // No snapshot ever saw this root alive, so the recorded set is not
      // evidence about this tree at all: a start plan that creates a descendant
      // and exits inside one cadence (`/bin/sh -c 'setsid sleep 300 &'`) leaves
      // nothing this driver can name or deny. Fail closed and keep the retained
      // identity, so a later stop can still try to contain what is recorded.
      this.report(operation, { ...operation.envelope.identity, status: "unknown" });
      this.syncObserver();
      return;
    }
    this.forget(operation);
    const exitCode = this.observedExitCode(operation);
    this.report(operation, {
      ...operation.envelope.identity,
      status: covered ? "tree-drained" : "root-exited",
      ...(exitCode !== undefined ? { exitCode } : {}),
    });
    await this.reap(operation);
  }

  /**
   * win32 end the terminal reached on its own. The pty child exited, but the
   * forked helper does NOT follow it on this platform (measured: it outlives its
   * root and only dies with its own parent), so it must be terminated and reaped
   * here - otherwise every ended win32 terminal leaks the helper process, its
   * child handle and one of the eight slots. The helper handle is the containment
   * primitive (see `ptyHelperHandleStopAvailable`), so terminating it also
   * contains any descendant the exiting root left behind; the tree the OS's fixed
   * parent chain still names is verified gone before the real `tree-drained` is
   * reported, and an end whose drain cannot be established stays the named
   * `unknown` with the identity retained.
   */
  private async settleByHelper(operation: Operation): Promise<void> {
    const worker = this.killableHelper(operation);
    if (worker === undefined) {
      // A helper with no Host-owned handle to kill cannot be reaped and nothing
      // here can contain what it holds: the named `unknown`, never a stop.
      this.report(operation, { ...operation.envelope.identity, status: "unknown" });
      return;
    }
    // Name the tree before the handle is terminated: the parent chain is the
    // only handle on these descendants, and it is read while they are alive.
    const tree = this.win32Tree(operation);
    this.terminateHelper(operation, worker);
    // An unconfirmed helper exit means the reap did not happen; the identity is
    // retained so a later stop can still try, and no end is claimed.
    if (!(await this.awaitHelperExit(operation, this.confirm)) || operation.fenced || operation.observed) {
      this.fence(operation);
      this.report(operation, { ...operation.envelope.identity, status: "unknown" });
      this.syncObserver();
      return;
    }
    if (tree === null || !(await this.win32TreeGone(tree, this.confirm))) {
      this.fence(operation);
      this.report(operation, { ...operation.envelope.identity, status: "unknown" });
      this.syncObserver();
      return;
    }
    this.forget(operation);
    const exitCode = this.observedExitCode(operation);
    this.report(operation, {
      ...operation.envelope.identity,
      status: "tree-drained",
      ...(exitCode !== undefined ? { exitCode } : {}),
    });
    await this.reap(operation);
  }

  /** The Host-owned helper handle of one operation, when it can be terminated. */
  private killableHelper(operation: Operation): PtyHelper | undefined {
    const worker = operation.worker;
    return worker !== undefined && typeof worker.kill === "function" ? worker : undefined;
  }

  /**
   * Terminate the helper through the handle this Host holds. `helperKilled`
   * records that the exit is the expected result of this call, so it is not read
   * as an uncontrollable helper loss by the exit listener.
   */
  private terminateHelper(operation: Operation, worker: PtyHelper): void {
    operation.helperKilled = true;
    try { worker.kill!(); } catch { /* helper already gone */ }
  }

  /** The win32 tree under one root: the root plus every descendant the OS's
   * fixed parent chain links to it, or null when the probe is unavailable. The
   * chain alone over-attributes on this platform - a recycled pid hands us the
   * dead owner's family - so a candidate is refused when the table proves it was
   * created before the process its `ppid` names, or when it was created before
   * this terminal started (`descendantPids`). Either piece of evidence suffices,
   * both can only ever remove a foreign pid, and neither can hide a real
   * descendant; the second also holds when the root's own row is already gone.
   */
  private win32Tree(operation: Operation): number[] | null {
    const rootPid = operation.rootPid;
    if (rootPid === undefined || rootPid <= 1) return null;
    const table = this.options.win32ProcessTable ? this.options.win32ProcessTable() : readWin32ProcessTable();
    return table === null ? null : [rootPid, ...descendantPids(table, rootPid, operation.createdAtFloor)];
  }

  private win32Alive(pid: number): boolean {
    return this.options.win32ProcessAlive ? this.options.win32ProcessAlive(pid) : win32ProcessAlive(pid);
  }

  /**
   * Bounded wait for the helper handle to report its exit. Reaching the deadline
   * is NOT by itself evidence that the helper is still running: a starved event
   * loop delivers the handle's own `exit` event long after the process is really
   * gone (measured under #74: a 4 s bound on `stopByHelper` returned `false`
   * 9.2-10.2 s late, with the helper already dead and its tree verified gone), so
   * the handle's real state is asked of the OS before "unconfirmed" is concluded.
   * A helper that really survives the bound is still unconfirmed, and a pid the OS
   * recycled reads alive, which keeps that answer on the fail-closed side.
   */
  private async awaitHelperExit(operation: Operation, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (operation.workerExit === undefined && Date.now() < deadline) await delay(STOP_POLL_MS);
    if (operation.workerExit !== undefined) return true;
    const pid = operation.worker?.pid;
    return pid !== undefined && !this.win32Alive(pid);
  }

  /** Positive evidence: every named piece of the win32 tree is gone. A pid the
   * OS recycled reads as alive, which keeps the drain unproven rather than
   * turning into a stopped-tree claim. */
  private async win32TreeGone(pids: readonly number[], timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (pids.every((pid) => !this.win32Alive(pid))) return true;
      if (Date.now() >= deadline) return false;
      await delay(STOP_POLL_MS);
    }
  }

  /** Pids still in the recorded group (excluding the root), keyed by that group. */
  private groupMemberIdentities(operation: Operation): Map<number, number> {
    const members = new Map<number, number>();
    const pgid = operation.processGroupId;
    if (pgid === undefined || pgid <= 1) return members;
    const table = this.readTable();
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
    // A dispatched request can create descendants that no observation can see
    // if the root dies first, so the evidence stops covering here until the next
    // completed observation.
    operation.requestFloor = operation.observations;
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
    this.observeDescendants(operation, this.readTable());
    const request = parsePtyRequest({ ...operation.envelope, requestId: operation.requestId + 1, ...payload });
    if (payload.action === "input") {
      // node-pty has no write-drained acknowledgement; a lifetime byte budget
      // bounds its internal queue conservatively without inventing delivery. The
      // fence is named so the caller can report which budget was hit.
      operation.inputBytes += Buffer.byteLength(payload.data);
      if (operation.inputBytes > MAX_PTY_ENVELOPE_BYTES) { this.unknown(operation); throw Error(PTY_INPUT_BUDGET_ERROR); }
    }
    const reply = await this.dispatch(operation, request);
    if (reply.status !== "accepted" || operation.fenced) { this.unknown(operation); throw Error("terminal-pty-unconfirmed"); }
  }

  /** Success means node-pty accepted input into its write queue, not application delivery. */
  input(identity: TerminalIdentity, data: string): Promise<void> { return this.control(identity, { action: "input", data }); }

  resize(identity: TerminalIdentity, cols: number, rows: number): Promise<void> { return this.control(identity, { action: "resize", cols, rows }); }

  private signalGroup(operation: Operation, kind: NodeJS.Signals): void {
    const rootPid = operation.rootPid, pgid = operation.processGroupId;
    // A group signal is `kill(-pgid)`, which does not exist on win32: named as
    // one path so no caller can reach it with a group this platform cannot have.
    if (!ptyProcessGroupOwnershipAvailable()) return;
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
    const table = this.readTable();
    if (table === null) return;
    const groups = new Map(table.map((row) => [row.pid, row.pgid]));
    for (const [pid, pgid] of captured) {
      if (pid <= 1 || groups.get(pid) !== pgid) continue;
      try { process.kill(pid, kind); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  }

  /** Positive evidence: the recorded group and the captured subtree are gone.
   * This is the POSIX group half of the claim - a group this platform recorded;
   * win32 never reaches it, because it has no group and its own helper-handle
   * path (`stopByHelper` / `settleByHelper`) carries its own verified tree. */
  private drained(operation: Operation, captured: readonly number[]): boolean | null {
    if (!ptyProcessGroupOwnershipAvailable()) return null;
    const rootPid = operation.rootPid;
    if (rootPid === undefined || operation.processGroupId === undefined) return null;
    // A saturated observation set cannot prove the tree ended: fail closed.
    if (operation.descendantOverflow) return false;
    const table = this.readTable();
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
   * Kill exactly the terminal this driver spawned: on POSIX the recorded group
   * plus the descendant set observed before the signal, and on win32 the
   * Host-owned helper handle (which takes the real tree with it). A missing or
   * mismatching recorded identity refuses (no signal), and a confirmed stop
   * removes the retained operation so a later generation starts cleanly.
   */
  async stop(identity: TerminalIdentity): Promise<TerminalDriverReceipt> {
    const key = operationKey(identity), operation = this.operations.get(key);
    if (!operation || operation.status === "not-started") return { ...identity, status: operation ? "not-started" : "unknown" };
    if (ptyHelperHandleStopAvailable()) return this.stopByHelper(operation, identity);
    const rootPid = operation.rootPid, pgid = operation.processGroupId;
    if (rootPid === undefined || pgid === undefined || rootPid <= 1 || pgid <= 1) return { ...identity, status: "unknown" };
    const identityAlive = readProcessPgid(rootPid) === pgid;
    const table = this.readTable();
    if (table === null) {
      // The OS probe is the only drain evidence; without it nothing may be
      // reported as a verified stop, though the recorded group is still signalled.
      if (identityAlive) this.signalGroup(operation, "SIGTERM");
      return { ...identity, status: "unknown" };
    }
    // What the root holds now (its parent chain and the rest of its session),
    // plus what this driver recorded while it was alive (a descendant whose
    // parent chain broke earlier is only in the latter).
    const rows = new Map(table.map((row) => [row.pid, row]));
    const root = rows.get(rootPid);
    const captured = new Map<number, number>();
    const live = identityAlive || root !== undefined;
    if (live) {
      for (const pid of [...descendantPids(table, rootPid), ...this.sessionMembers(operation, table, root)]) {
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

  /**
   * win32 stop. There is no process group here to signal or re-read, so the
   * containment primitive is the Host-owned helper handle - the `ChildProcess`
   * this Host itself forked. Its identity is a live handle, not a number the OS
   * can recycle, so terminating it can never hit a foreign process; that is the
   * guarantee `taskkill /T` by bare pid cannot give, which is why it is not used.
   * The tree the OS's fixed parent chain names is read before the handle is
   * terminated and verified gone after, and only then is a real `tree-drained`
   * reported. A tree that cannot be named or verified stays the named `unknown`,
   * so a stop is never claimed on evidence this platform does not have. The tree
   * is narrower than the bare chain: a pid the chain links to us only through a
   * recycled number - a process created before the parent its `ppid` names, or
   * one created before this terminal started, which is the only evidence left
   * once the root's own row is gone - is not this terminal's and is not adopted
   * (`descendantPids`), so a foreign family cannot keep the drain unverified
   * forever.
   */
  private async stopByHelper(operation: Operation, identity: TerminalIdentity): Promise<TerminalDriverReceipt> {
    const worker = this.killableHelper(operation);
    if (worker === undefined) return { ...identity, status: "unknown" };
    const tree = this.win32Tree(operation);
    this.terminateHelper(operation, worker);
    // Without a completed helper exit the handle's termination is unconfirmed,
    // so nothing may be claimed even before the tree is checked.
    if (!(await this.awaitHelperExit(operation, this.grace + this.confirm))) return { ...identity, status: "unknown" };
    // A tree read that failed under load must not end this stop as `unknown`
    // while the handle it was meant to contain is already terminated (#74: 16 of
    // 54 stops under two suites plus load). win32 never rewrites
    // `ParentProcessId`, so the chain outlives its root and the same walk still
    // names the same tree with the root row already gone - which is what #69's
    // `createdAtFloor` is for - so ONE more bounded read is taken before the stop
    // is refused. It costs one whole-table read (bounded by the probe's own
    // bound, 30 s) and only on this failure path; a re-read that fails too, and a
    // tree still named alive after the window, stay the named `unknown`.
    const named = tree ?? this.win32Tree(operation);
    // A stop is still real when the tree could not be named (the helper is gone
    // and so is the pseudo console it owned), but that is not verifiable here
    // and is therefore reported as the named `unknown`, never as drained.
    if (named === null || !(await this.win32TreeGone(named, this.confirm))) return { ...identity, status: "unknown" };
    return this.finish(operation, identity);
  }

  private finish(operation: Operation, identity: TerminalIdentity): TerminalDriverReceipt {
    this.fence(operation);
    const exitCode = this.observedExitCode(operation);
    const receipt: TerminalDriverReceipt = { ...identity, status: "tree-drained", ...(exitCode !== undefined ? { exitCode } : {}) };
    operation.observed = true;
    this.forget(operation);
    void this.reap(operation);
    return receipt;
  }

  snapshot(identity: TerminalIdentity) {
    const operation = this.operations.get(operationKey(identity));
    return {
      status: operation?.status === "started" && !operation.fenced ? "running" as const : "unknown" as const,
      ...(operation?.rootPid !== undefined
        ? { process: { processId: operation.rootPid, ...(operation.processGroupId !== undefined ? { processGroupId: operation.processGroupId } : {}) } }
        : {}),
    };
  }
}
