import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { MAX_TERMINAL_INSTANCES } from "../main/terminal-config.js";
import { MAX_PTY_ENVELOPE_BYTES, operationKey, parsePtyEvent, parsePtyRequest, sameEnvelope, type PtyEnvelope, type PtyEvent, type PtyRequest, type PtyPhase, type PtyReason } from "./node-pty-protocol.js";
import type { TerminalDriver, TerminalDriverReceipt, TerminalIdentity, TerminalLaunch } from "./terminal-execution.js";

/** OS process boundary, injectable for protocol/deadline tests only. */
export interface NodePtyWorker {
  readonly pid?: number;
  send(message: PtyRequest, callback: (error: Error | null) => void): boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: "disconnect", listener: () => void): unknown;
}
interface Options {
  workspaceId: string;
  /** Must be the canonical path of this explicit Node 24.21.0 runtime. No PATH lookup. */
  nodeExecutable: string;
  onOutput(identity: TerminalIdentity, sequence: number, data: string): void;
  operationTimeoutMs?: number;
  spawnWorker?: () => NodePtyWorker;
}
interface Operation {
  envelope: PtyEnvelope;
  worker?: NodePtyWorker;
  status: "started" | "not-started" | "unknown";
  fenced: boolean;
  sequence: number;
  requestId: number;
  inputBytes: number;
  observe(receipt: TerminalDriverReceipt): void;
  pending?: { action: PtyRequest["action"]; resolve(event: PtyEvent & { kind: "reply" }): void };
  phase?: PtyPhase;
  reason?: PtyReason;
  rootPid?: number;
  ptyExit?: { exitCode: number; signal: number };
  workerExit?: { code: number | null; signal: string | null };
}

/** Phase B experiment only: Darwin arm64, explicit Node runtime, no Host/RPC/UI caller.
 * Native synchronous calls run in a separate process so parent deadlines can fire.
 * node-pty does not prove descendant containment. Exit and stop always retain unknown
 * ownership; no numeric PID signal or process-list scan is used by this adapter.
 */
export class NodePtyDriver implements TerminalDriver {
  private readonly operations = new Map<string, Operation>();
  private readonly timeout: number;
  private readonly options: Options;
  constructor(options: Options) {
    this.options = { ...options };
    this.timeout = options.operationTimeoutMs ?? 5000;
    if (!Number.isInteger(this.timeout) || this.timeout < 10 || this.timeout > 30_000) throw Error("invalid-pty-deadline");
  }
  private available(): boolean {
    try {
      return process.platform === "darwin" && process.arch === "arm64" && !process.versions.electron && process.versions.node === "24.21.0" &&
        isAbsolute(this.options.nodeExecutable) && realpathSync(this.options.nodeExecutable) === this.options.nodeExecutable &&
        this.options.nodeExecutable === realpathSync(process.execPath);
    } catch { return false; }
  }
  async spawn(identity: TerminalIdentity, launch: TerminalLaunch, observe: (receipt: TerminalDriverReceipt) => void) {
    const key = operationKey(identity), retained = this.operations.get(key);
    if (retained) return { status: retained.status };
    if (this.operations.size >= MAX_TERMINAL_INSTANCES) return { status: "not-started" as const };
    const operation: Operation = { envelope: { workspaceId: this.options.workspaceId, identity: { ...identity }, operationId: randomUUID() },
      status: "unknown", fenced: false, sequence: 0, requestId: 0, inputBytes: 0, observe };
    this.operations.set(key, operation);
    let request: PtyRequest & { action: "spawn" };
    try {
      const parsed = parsePtyRequest({ ...operation.envelope, requestId: 1, action: "spawn", launch: structuredClone(launch) });
      if (parsed.action !== "spawn" || !this.available()) throw Error();
      request = parsed;
    } catch { operation.status = "not-started"; return { status: operation.status }; }
    try {
      // Private launch values travel only over the private IPC channel. The helper
      // environment is empty, not a copy of Host/Provider/user configuration.
      operation.worker = this.options.spawnWorker?.() ?? fork(new URL("./node-pty-worker.js", import.meta.url), [], {
        execPath: this.options.nodeExecutable, execArgv: [], env: {}, cwd: request.launch.cwd,
        stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json",
      });
      operation.worker.on("message", (raw) => this.receive(operation, raw));
      operation.worker.on("error", () => this.unknown(operation));
      operation.worker.on("disconnect", () => this.unknown(operation));
      operation.worker.on("exit", (code, signal) => { operation.workerExit = { code, signal }; this.unknown(operation); });
      const reply = await this.dispatch(operation, request);
      if (!operation.fenced) operation.status = reply.status === "started" ? "started" : reply.status === "not-started" ? "not-started" : "unknown";
    } catch { this.unknown(operation); }
    return { status: operation.status };
  }
  private unknown(operation: Operation): void {
    if (operation.status === "not-started") return;
    const newlyFenced = !operation.fenced;
    operation.fenced = true; operation.status = "unknown";
    operation.pending?.resolve({ ...operation.envelope, kind: "reply", requestId: operation.requestId, status: "unknown" });
    if (newlyFenced) { try { operation.observe({ ...operation.envelope.identity, status: "unknown" }); } catch { /* caller cannot change retained identity */ } }
  }
  private receive(operation: Operation, raw: unknown): void {
    let event: PtyEvent;
    try { event = parsePtyEvent(raw); if (!sameEnvelope(operation.envelope, event)) throw Error(); }
    catch { this.unknown(operation); return; }
    if (event.kind === "phase") { operation.phase = event.phase; return; }
    if (event.kind === "exit") {
      if (operation.ptyExit) { this.unknown(operation); return; }
      operation.ptyExit = { exitCode: event.exitCode, signal: event.signal }; this.unknown(operation); return;
    }
    if (event.kind === "output") {
      if (event.sequence !== operation.sequence + 1 || operation.ptyExit) { this.unknown(operation); return; }
      operation.sequence = event.sequence;
      try { this.options.onOutput({ ...operation.envelope.identity }, event.sequence, event.data); } catch { this.unknown(operation); }
      return;
    }
    if (event.requestId > operation.requestId) { this.unknown(operation); return; }
    if (event.reason) operation.reason = event.reason;
    if (event.status === "unknown") { this.unknown(operation); return; }
    if (event.rootPid !== undefined) operation.rootPid ??= event.rootPid;
    // Late acknowledgements may add bounded resource diagnostics, never revive
    // a timed-out operation or settle a newer input/resize request.
    if (!operation.pending || event.requestId !== operation.requestId) return;
    if ((operation.pending.action === "spawn" && !["started", "not-started", "unknown"].includes(event.status)) ||
        (operation.pending.action !== "spawn" && !["accepted", "unknown"].includes(event.status))) { this.unknown(operation); return; }
    operation.pending.resolve(event);
  }
  private dispatch(operation: Operation, request: PtyRequest): Promise<PtyEvent & { kind: "reply" }> {
    if (operation.pending) return Promise.reject(Error("terminal-pty-busy"));
    operation.requestId = request.requestId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.unknown(operation), this.timeout);
      operation.pending = { action: request.action, resolve: (event) => { clearTimeout(timer); operation.pending = undefined; resolve(event); } };
      try { operation.worker!.send(request, (error) => { if (error) this.unknown(operation); }); }
      catch { this.unknown(operation); }
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
  async stop(identity: TerminalIdentity): Promise<TerminalDriverReceipt> {
    const operation = this.operations.get(operationKey(identity));
    if (operation) this.unknown(operation);
    return { ...identity, status: operation?.status === "not-started" ? "not-started" : "unknown" };
  }
  snapshot(identity: TerminalIdentity) {
    const operation = this.operations.get(operationKey(identity));
    return { status: operation?.status === "started" && !operation.fenced ? "running" as const : "unknown" as const,
      operationId: operation?.envelope.operationId, workerPid: operation?.worker?.pid, rootPid: operation?.rootPid,
      phase: operation?.phase, reason: operation?.reason,
      ptyExit: operation?.ptyExit && { ...operation.ptyExit }, workerExit: operation?.workerExit && { ...operation.workerExit } };
  }
}
