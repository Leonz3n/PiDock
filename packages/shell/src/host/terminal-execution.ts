import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import { TERMINAL_CONTROL_SCOPE, type PiPermission } from "../main/pi-session.js";
import { validateServiceDescriptor } from "../main/service-config.js";
import { MAX_TERMINAL_LINE, MAX_TERMINAL_INSTANCES, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS } from "../main/terminal-config.js";
import type { TerminalControlChannel } from "./terminal-control.js";
import { writeClaimError, type WriteCoordinatorPort } from "./write-coordination.js";

export interface TerminalIdentity {
  taskId: string;
  sessionId: string;
  instanceId: string;
  generation: number;
}
export interface TerminalLaunch {
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Trusted resolver revision; private env is also compared before dispatch. */
  envRevision: string;
  cols: number;
  rows: number;
}
export type TerminalDriverReceipt = TerminalIdentity & (
  | { status: "tree-drained"; exitCode: number }
  | { status: "not-started" }
  | { status: "unknown" }
);
/** OS boundary. PTY exit alone must never produce a tree-drained receipt.
 * Unknown spawn (including rejection) remains addressable by the supplied identity.
 * The adapter must bound every async operation and report unknown on timeout;
 * snapshot observations never prove that descendants have drained.
 */
export interface TerminalDriver {
  spawn(identity: TerminalIdentity, launch: TerminalLaunch, observe: (receipt: TerminalDriverReceipt) => void): Promise<{ status: "started" | "not-started" | "unknown" }>;
  /** Rejection means delivery is uncertain; the controller fences further input until termination. */
  input(identity: TerminalIdentity, data: string): Promise<void>;
  resize(identity: TerminalIdentity, cols: number, rows: number): Promise<void>;
  stop(identity: TerminalIdentity): Promise<TerminalDriverReceipt>;
  snapshot(identity: TerminalIdentity): { status: "running" | "unknown" };
}
export interface TerminalLease {
  /** Rechecks trusted path identity, shared-target authorization and retained rights. */
  revalidate(): void;
  /** Infallible local release of this lease alone, preserving other retained leases. */
  release(): void;
}
interface BoundChannel extends TerminalControlChannel {
  snapshot(): ReturnType<TerminalControlChannel["snapshot"]> & { taskId: string; sessionId: string };
}
export type TerminalRequest = { action: "start" } | { action: "stop" } | { action: "input"; data: string } | { action: "resize"; cols: number; rows: number };
export type TerminalReview = TerminalIdentity & Omit<TerminalLaunch, "env"> & TerminalRequest;
interface Dependencies {
  taskId: string;
  taskDir: string;
  instanceId: string;
  driver: TerminalDriver;
  write: WriteCoordinatorPort;
  resolveLaunch(): TerminalLaunch;
  /** No implicit auto execution: the trusted caller must validate automation scope. */
  authorizeAutomation?: (review: TerminalReview) => boolean;
  acquireLease(review: TerminalReview): TerminalLease;
  /** Resolves only after durable acknowledgement; never writes private env. */
  persistReceipt(receipt: TerminalDriverReceipt): Promise<void>;
}
type Result = { ok: true } | { ok: false; error: string; approvalId?: string; review?: TerminalReview };
type State = "idle" | "starting" | "running" | "stopping" | "unconfirmed" | "exited" | "not-started";
interface Active {
  identity: TerminalIdentity;
  launch: TerminalLaunch;
  permission: PiPermission;
  started: boolean;
  claimId: string;
  lease: TerminalLease;
  receipt?: TerminalDriverReceipt;
  saving?: Promise<void>;
}
function dimensions(cols: number, rows: number): boolean {
  return Number.isInteger(cols) && cols >= MIN_TERMINAL_COLS && cols <= MAX_TERMINAL_COLS &&
    Number.isInteger(rows) && rows >= MIN_TERMINAL_ROWS && rows <= MAX_TERMINAL_ROWS;
}
function launchCopy(launch: TerminalLaunch): TerminalLaunch {
  if (!isAbsolute(launch.cwd) || normalize(launch.cwd) !== launch.cwd || !launch.envRevision.trim() ||
      !dimensions(launch.cols, launch.rows) || launch.program !== launch.program.trim() ||
      !Array.isArray(launch.args) || !launch.args.every((arg) => typeof arg === "string" && !arg.includes("\0")) ||
      Buffer.byteLength(JSON.stringify([launch.program, launch.args])) > MAX_TERMINAL_LINE ||
      launch.program.includes("\0") || Object.entries(launch.env).some(([key, value]) => !key || key.includes("=") || key.includes("\0") || typeof value !== "string" || value.includes("\0")) ||
      validateServiceDescriptor({ name: "终端", program: launch.program, args: launch.args, ports: [], runType: "long-lived" })) {
    throw Error("invalid-terminal-launch");
  }
  return structuredClone(launch);
}
function reviewFor(identity: TerminalIdentity, launch: TerminalLaunch, request: TerminalRequest): TerminalReview {
  // Explicit field order is the canonical approval encoding. Environment values stay private.
  return { taskId: identity.taskId, sessionId: identity.sessionId, instanceId: identity.instanceId, generation: identity.generation,
    program: launch.program, args: [...launch.args], cwd: launch.cwd, envRevision: launch.envRevision,
    cols: request.action === "resize" ? request.cols : launch.cols, rows: request.action === "resize" ? request.rows : launch.rows,
    ...(request.action === "input" ? { action: request.action, data: request.data } : { action: request.action }) };
}
function version(review: TerminalReview): string { return createHash("sha256").update(JSON.stringify(review)).digest("hex"); }
function sameLaunch(left: TerminalLaunch, right: TerminalLaunch): boolean {
  const metadata = (launch: TerminalLaunch) => JSON.stringify(reviewFor({ taskId: "", sessionId: "", instanceId: "", generation: 0 }, launch, { action: "start" }));
  return metadata(left) === metadata(right) && JSON.stringify(Object.entries(left.env).sort(([a], [b]) => a.localeCompare(b))) === JSON.stringify(Object.entries(right.env).sort(([a], [b]) => a.localeCompare(b)));
}

/** Phase A controller only. Production must wire review payloads into real approval UI before enabling it. */
export class TerminalExecution {
  private state: State = "idle";
  private generation = 0;
  private active: Active | undefined;
  private closing = false;
  private busy = false;
  private error: string | undefined;
  private idle: Promise<void> | undefined;
  private draining: Promise<Result> | undefined;
  private readonly approvals = new Map<string, { launch: TerminalLaunch; version: string }>();
  constructor(private readonly dependencies: Dependencies) { this.dependencies = { ...dependencies }; }

  snapshot() {
    if (this.active && this.state === "running" && !this.active.receipt) {
      try { if (this.dependencies.driver.snapshot({ ...this.active.identity }).status !== "running") throw Error(); }
      catch { this.state = "unconfirmed"; this.error = "terminal-termination-unconfirmed"; }
    }
    return { state: this.state, closing: this.closing, busy: this.busy,
      identity: this.active ? { ...this.active.identity } : null, permissionAtStart: this.active?.permission ?? null, error: this.error };
  }
  async settled(): Promise<void> { await this.idle; await this.active?.saving; }

  /** Trusted Host shutdown: seals admission and stops only this retained operation identity. */
  close(): Promise<Result> {
    this.closing = true;
    return this.draining ??= this.drain().finally(() => { this.draining = undefined; });
  }
  private async drain(): Promise<Result> {
    await this.settled();
    return this.active ? this.stop(this.active) : { ok: true };
  }
  private async stop(active: Active): Promise<Result> {
    if (active.receipt) {
      await this.saveReceipt(active);
      return this.active ? { ok: false, error: this.error ?? "terminal-receipt-persistence-failed" } : { ok: true };
    }
    this.state = "stopping";
    try { this.observe(active, await this.dependencies.driver.stop({ ...active.identity }), !active.started); }
    catch {
      if (this.active === active && !active.receipt) {
        this.state = "unconfirmed"; this.error = "terminal-termination-unconfirmed";
      }
    }
    await active.saving;
    return this.active ? { ok: false, error: this.error ?? "terminal-termination-unconfirmed" } : { ok: true };
  }
  private observe(active: Active, receipt: TerminalDriverReceipt, notStartedProven = false): void {
    if (this.active !== active || active.receipt || active.saving) return;
    if (receipt.taskId !== active.identity.taskId || receipt.sessionId !== active.identity.sessionId ||
        receipt.instanceId !== active.identity.instanceId || receipt.generation !== active.identity.generation ||
        !["tree-drained", "not-started"].includes(receipt.status) || (receipt.status === "not-started" && !notStartedProven) ||
        (receipt.status === "tree-drained" && !Number.isInteger(receipt.exitCode))) {
      this.state = "unconfirmed"; this.error = "terminal-termination-unconfirmed"; return;
    }
    active.receipt = receipt.status === "tree-drained" ? { ...active.identity, status: "tree-drained", exitCode: receipt.exitCode } : { ...active.identity, status: "not-started" };
    void this.saveReceipt(active);
  }
  private saveReceipt(active: Active): Promise<void> {
    return active.saving ??= (async () => {
      try {
        await this.dependencies.persistReceipt({ ...active.receipt! });
        active.lease.release();
        this.dependencies.write.releaseWrite(active.claimId);
        this.state = active.receipt!.status === "not-started" ? "not-started" : "exited";
        this.error = undefined; this.active = undefined;
      } catch { this.state = "unconfirmed"; this.error = "terminal-receipt-persistence-failed"; }
    })().finally(() => { active.saving = undefined; });
  }

  async control(input: { channel: BoundChannel; sessionId: string; request: TerminalRequest; approvalId?: string; persistApproval(): Promise<void> }): Promise<Result> {
    input = { ...input, request: { ...input.request } };
    if (input.request.action === "input" && (typeof input.request.data !== "string" || !input.request.data || Buffer.byteLength(input.request.data) > MAX_TERMINAL_LINE)) return { ok: false, error: "invalid-terminal-input" };
    if (input.request.action === "resize" && !dimensions(input.request.cols, input.request.rows)) return { ok: false, error: "invalid-terminal-resize" };
    if (!["start", "stop", "input", "resize"].includes(input.request.action)) return { ok: false, error: "invalid-terminal-action" };
    if (this.closing) return { ok: false, error: "terminal-host-closing" };
    if (this.busy || (input.request.action === "start" && this.active)) return { ok: false, error: "terminal-owned" };
    const caller = input.channel.snapshot(), tier = input.channel.currentPermission;
    if (caller.taskId !== this.dependencies.taskId || caller.sessionId !== input.sessionId ||
        (this.active && this.active.identity.sessionId !== input.sessionId)) return { ok: false, error: "terminal-caller-mismatch" };
    if (input.request.action !== "start" && !this.active) return { ok: false, error: "terminal-not-running" };
    this.snapshot();
    if (["input", "resize"].includes(input.request.action) && this.state !== "running") return { ok: false, error: "terminal-termination-unconfirmed" };
    const identity = this.active?.identity ?? { taskId: caller.taskId, sessionId: caller.sessionId, instanceId: this.dependencies.instanceId, generation: this.generation + 1 };
    let launch: TerminalLaunch;
    try {
      launch = launchCopy(this.dependencies.resolveLaunch());
      if (this.active && input.request.action !== "stop" && !sameLaunch(this.active.launch, launch)) throw Error("terminal-authorization-changed");
    }
    catch { return { ok: false, error: "terminal-authorization-changed" }; }
    const review = reviewFor(identity, launch, input.request), contentVersion = version(review);
    const target = `${this.dependencies.taskDir}/terminals/${encodeURIComponent(identity.instanceId)}/generations/${identity.generation}/${input.request.action}`;
    const preview = input.channel.previewGate("exec.run", target);
    if (preview.verdict === "deny") return { ok: false, error: preview.reason };
    const approval = input.approvalId === undefined ? undefined : caller.approvals.find((row) => row.id === input.approvalId);
    if (input.approvalId !== undefined) {
      const captured = this.approvals.get(input.approvalId);
      if (tier !== "default" || !approval || !captured || approval.taskId !== identity.taskId || approval.sessionId !== identity.sessionId ||
          approval.status !== "approved" || approval.consumedAt !== undefined || approval.permissionAtRequest !== "default" ||
          approval.scope !== TERMINAL_CONTROL_SCOPE || approval.tool !== "exec.run" || approval.target !== target ||
          approval.contentVersion !== contentVersion || captured.version !== contentVersion || !sameLaunch(captured.launch, launch)) {
        return { ok: false, error: "invalid-terminal-approval" };
      }
    } else if (tier === "auto") {
      try { if (!this.dependencies.authorizeAutomation?.(structuredClone(review))) return { ok: false, error: "terminal-authorization-required" }; }
      catch { return { ok: false, error: "terminal-authorization-changed" }; }
    }
    this.busy = true;
    let settled: () => void = () => {};
    this.idle = new Promise<void>((resolve) => { settled = resolve; });
    let lease: TerminalLease | undefined, claimId: string | undefined;
    const guard = () => {
      const current = input.channel.snapshot();
      if (this.closing || input.channel.previewGate("exec.run", target).verdict === "deny" || current.taskId !== identity.taskId || current.sessionId !== identity.sessionId || input.channel.currentPermission !== tier ||
          !sameLaunch(launch, launchCopy(this.dependencies.resolveLaunch()))) throw Error("terminal-authorization-changed");
      if (tier === "auto" && !this.dependencies.authorizeAutomation?.(structuredClone(review))) throw Error("terminal-authorization-changed");
    };
    try {
      if (tier === "default" && !approval) {
        for (const id of this.approvals.keys()) if (!caller.approvals.some((row) => row.id === id && ["pending", "approved"].includes(row.status) && row.consumedAt === undefined)) this.approvals.delete(id);
        if (this.approvals.size >= MAX_TERMINAL_INSTANCES) return { ok: false, error: "terminal-approval-limit" };
        const gate = input.channel.gate("exec.run", target, contentVersion, undefined, TERMINAL_CONTROL_SCOPE);
        if (gate.verdict !== "ask") return { ok: false, error: "terminal-authorization-required" };
        this.approvals.set(gate.approvalId, { launch, version: contentVersion });
        await input.persistApproval(); guard();
        return { ok: false, error: "approval-required", approvalId: gate.approvalId, review };
      }
      if (approval) {
        if (!input.channel.consumeApproval(approval.id)) return { ok: false, error: "invalid-terminal-approval" };
        this.approvals.delete(approval.id);
        await input.persistApproval();
      }
      guard();
      if (input.request.action !== "start") {
        const active = this.active!;
        active.lease.revalidate();
        if (input.request.action === "stop") return await this.stop(active);
        try {
          if (input.request.action === "input") await this.dependencies.driver.input({ ...identity }, input.request.data);
          else await this.dependencies.driver.resize({ ...identity }, input.request.cols, input.request.rows);
        } catch {
          if (input.request.action === "input" && this.active === active && !active.receipt) {
            // A rejected acknowledgement cannot prove that input was never delivered.
            this.state = "unconfirmed"; this.error = "terminal-input-unconfirmed";
          }
          return { ok: false, error: input.request.action === "input" ? "terminal-input-failed" : "terminal-resize-failed" };
        }
        return { ok: true };
      }
      lease = this.dependencies.acquireLease(structuredClone(review)); lease.revalidate(); guard();
      const claim = this.dependencies.write.claimWrite(input.sessionId, tier, { kind: "terminal-control", label: "Agent terminal lifetime" });
      if (!claim.ok) return { ok: false, error: writeClaimError(claim) };
      claimId = claim.claimId; lease.revalidate(); guard();
      const active: Active = { identity: { ...identity }, launch, lease, claimId, permission: tier, started: false };
      this.active = active; this.generation++; this.state = "starting"; this.error = undefined;
      lease = undefined; claimId = undefined;
      try {
        const spawned = await this.dependencies.driver.spawn({ ...identity }, structuredClone(launch), (receipt) => this.observe(active, receipt));
        active.started = spawned.status === "started";
        if (spawned.status === "not-started") this.observe(active, { ...identity, status: "not-started" }, true);
        else if (!active.receipt && this.snapshot().state !== "unconfirmed") this.state = spawned.status === "started" ? "running" : "unconfirmed";
        await active.saving;
        return this.state === "unconfirmed" ? { ok: false, error: this.error ?? "terminal-start-unconfirmed" } : { ok: true };
      } catch {
        if (active.receipt) {
          await active.saving;
          return this.active ? { ok: false, error: this.error ?? "terminal-receipt-persistence-failed" } : { ok: true };
        }
        this.state = "unconfirmed"; this.error = "terminal-start-unconfirmed";
        return { ok: false, error: this.error };
      }
    } catch { return { ok: false, error: "terminal-authorization-changed" }; }
    finally {
      lease?.release();
      if (claimId) this.dependencies.write.releaseWrite(claimId);
      this.busy = false; this.idle = undefined; settled();
    }
  }
}
