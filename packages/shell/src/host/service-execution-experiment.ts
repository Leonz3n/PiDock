import { SERVICE_CONTROL_SCOPE, type PiApproval } from "../main/pi-session.js";
import type { AgentControlChannel } from "./service-control.js";
import { verifyServiceControlApproval } from "./service-runtime.js";
import type { SupervisorSession, SupervisorResult } from "./service-supervisor-experiment.js";
import { writeClaimError, type WriteCoordinatorPort } from "./write-coordination.js";
import { serviceExecutionCheckpoint as checkpointFromStore, type ExperimentalServiceState, type ServiceExecutionCheckpoint } from "../rpc/service-execution-checkpoint.js";
export type { ExperimentalServiceState, ServiceExecutionCheckpoint } from "../rpc/service-execution-checkpoint.js";
type Result = { ok: true; state: ExperimentalServiceState } | { ok: false; error: string };
export interface ServiceExecutionRecoveryPort {
  /** Trusted bounded store; undefined alone means no previous checkpoint. */
  read(): unknown;
  /** Return only after durable acknowledgement, not after sending a message. */
  write(record: ServiceExecutionCheckpoint): undefined | Promise<undefined>;
}
export interface AsyncServiceExecutionRecoveryPort extends ServiceExecutionRecoveryPort {
  read(): Promise<unknown>;
}
interface BoundControlChannel extends AgentControlChannel {
  snapshot(): { approvals: PiApproval[]; taskId: string; sessionId: string };
  reject(approvalId: string): void;
}
interface Dependencies {
  taskId: string; taskDir: string; serviceId: string;
  /** Trusted fingerprint and lease/config revalidation; throws if revoked. */
  revision: () => string;
  write: WriteCoordinatorPort;
  start?: (signal?: AbortSignal) => Promise<SupervisorSession>;
  recovery?: ServiceExecutionRecoveryPort;
}

/** Single-service experiment only. No production Host/RPC imports or enable flag. */
export class ExperimentalServiceExecution {
  private state: ExperimentalServiceState = "stopped";
  private session: SupervisorSession | null = null;
  private owner: string | null = null;
  private busy = false;
  private generation = 0;
  private closing = false;
  private closingPromise: Promise<Result> | undefined;
  private idle: Promise<void> | undefined;
  private saving: Promise<boolean> | undefined;
  private pendingSaves = 0;
  private saveFailed = false;
  private terminal: { generation: number; promise: Promise<boolean> } | undefined;

  /** No controller or default stopped state escapes before trusted recovery resolves. */
  static async create(dependencies: Dependencies & { recovery: AsyncServiceExecutionRecoveryPort }): Promise<ExperimentalServiceExecution> {
    dependencies = { ...dependencies };
    const recovery = dependencies.recovery;
    let saved: unknown;
    try {
      saved = await recovery.read();
      if (saved !== undefined) checkpointFromStore(saved, dependencies.taskId, dependencies.serviceId);
      dependencies.revision();
    } catch { throw Error("invalid-service-recovery"); }
    return new ExperimentalServiceExecution({ ...dependencies, recovery: { read: () => saved, write: (record) => recovery.write(record) } });
  }
  constructor(private readonly dependencies: Dependencies) {
    this.dependencies = { ...dependencies };
    try {
      const saved = dependencies.recovery?.read();
      if (saved !== undefined) {
        const record = checkpointFromStore(saved, dependencies.taskId, dependencies.serviceId);
        this.state = record.state === "stopped" || record.state === "exited" ? record.state : "unconfirmed";
        this.owner = record.ownerSessionId;
      }
    } catch { throw Error("invalid-service-recovery"); }
  }
  snapshot() { return { state: this.state, ownerSessionId: this.owner, busy: this.busy, closing: this.closing }; }
  resources() {
    return this.owner !== null && ["starting", "running", "stopping", "unconfirmed"].includes(this.state)
      ? [{ resourceId: this.dependencies.serviceId, kind: "service" as const, ownerSessionId: this.owner,
        ...(this.state === "unconfirmed" || this.pendingSaves > 0 ? { verificationRequired: true } : {}) }] : [];
  }
  private checkpoint(state: ExperimentalServiceState, owner: string | null, generation = this.generation): Promise<boolean> {
    if ((state === "running" || state === "stopping") && this.terminal?.generation === generation) return this.terminal.promise;
    this.pendingSaves++;
    const save = async () => {
      if (generation !== this.generation) return true;
      if (this.saveFailed) return false;
      try {
        const record: ServiceExecutionCheckpoint = { schemaVersion: 1, taskId: this.dependencies.taskId, serviceId: this.dependencies.serviceId, state, ownerSessionId: owner };
        checkpointFromStore(record, this.dependencies.taskId, this.dependencies.serviceId);
        if (this.dependencies.recovery && await this.dependencies.recovery.write(record) !== undefined) throw Error();
        if (generation !== this.generation) return true;
        this.state = state; this.owner = owner;
        return true;
      } catch {
        this.saveFailed = true; this.state = "unconfirmed"; this.owner = owner ?? this.owner;
        return false;
      }
    };
    const promise = (this.saving ? this.saving.then(save) : save()).finally(() => { this.pendingSaves--; });
    this.saving = promise;
    return promise;
  }
  private async saved(): Promise<void> {
    // A terminal receipt can enqueue another save while an earlier ack is arriving.
    let current: Promise<boolean> | undefined;
    do { current = this.saving; await current; } while (current !== this.saving);
  }
  private observed(result: SupervisorResult, generation: number): Promise<boolean> {
    if (generation !== this.generation || this.owner === null) return Promise.resolve(!this.saveFailed && this.state !== "unconfirmed");
    if (this.terminal?.generation === generation) return this.terminal.promise;
    const state = result.event === "unconfirmed" ? "unconfirmed" : result.event === "exit" ? "exited" : "stopped";
    const owner = result.event === "unconfirmed" ? this.owner : null;
    const promise = this.checkpoint(state, owner, generation).then((ok) => {
      if (ok && generation === this.generation && result.event !== "unconfirmed") this.session = null;
      return ok;
    });
    this.terminal = { generation, promise };
    return promise;
  }
  private async stopOwned(session: SupervisorSession, generation: number): Promise<SupervisorResult> {
    let result: SupervisorResult;
    try { result = await session.stop(); } catch { result = { event: "unconfirmed" }; }
    await this.observed(result, generation);
    await this.saved();
    return result;
  }
  /** Trusted Host lifecycle only, not an Agent/human approval bypass RPC. */
  close(): Promise<Result> { this.closing = true; return this.closingPromise ??= this.drain(); }
  private async drain(): Promise<Result> {
    await this.idle; await this.saved();
    if (this.state === "unconfirmed") return { ok: false, error: "service-termination-unconfirmed" };
    if (!this.session) return this.dependencies.recovery ? { ok: true, state: this.state } : { ok: false, error: "service-recovery-unavailable" };
    const claim = this.dependencies.write.claimWrite(this.owner!, "auto", { kind: "service-control", label: "Experimental Host shutdown" });
    if (!claim.ok) return { ok: false, error: writeClaimError(claim) };
    this.busy = true;
    try {
      const session = this.session, generation = this.generation;
      await this.checkpoint("stopping", this.owner);
      const result = await this.stopOwned(session, generation);
      if (this.saveFailed) return { ok: false, error: "service-recovery-persistence-failed" };
      if (!this.dependencies.recovery) return { ok: false, error: "service-recovery-unavailable" };
      return result.event === "unconfirmed" || this.snapshot().state === "unconfirmed" ? { ok: false, error: "service-termination-unconfirmed" } : { ok: true, state: this.state };
    } finally { this.busy = false; this.dependencies.write.releaseWrite(claim.claimId); }
  }
  async control(input: {
    channel: BoundControlChannel; sessionId: string; action: "start" | "stop";
    approvalId?: string; persist: () => void | Promise<void>; signal?: AbortSignal;
  }): Promise<Result> {
    input = { ...input };
    if (this.closing) return { ok: false, error: "service-host-closing" };
    if (input.signal?.aborted) return { ok: false, error: "service-operation-cancelled" };
    const caller = input.channel.snapshot();
    if (caller.taskId !== this.dependencies.taskId || caller.sessionId !== input.sessionId) return { ok: false, error: "service-caller-mismatch" };
    const executor = this.dependencies.start;
    if (!executor) return { ok: false, error: "service-execution-unavailable" };
    if (this.busy || this.pendingSaves) return { ok: false, error: "service-operation-in-flight" };
    if (this.state === "unconfirmed") return { ok: false, error: "service-termination-unconfirmed" };
    if (input.action === "start" && this.session) return { ok: false, error: "service-already-running" };
    if (input.action === "stop" && !this.session) return { ok: false, error: "service-not-running" };
    const tier = input.channel.currentPermission;
    if (tier === "read") return { ok: false, error: "readonly-service-control" };
    let revision: string;
    try { revision = this.dependencies.revision(); } catch { return { ok: false, error: "service-authorization-changed" }; }
    const target = `${this.dependencies.taskDir}/services/${this.dependencies.serviceId}/${input.action}`;
    const contentVersion = `${input.action}:${revision}`;
    const approval = input.approvalId === undefined ? undefined : input.channel.snapshot().approvals.find((row) => row.id === input.approvalId);
    if (input.approvalId !== undefined && !approval) return { ok: false, error: "invalid-service-approval" };
    if (tier === "default" && approval) {
      const verified = verifyServiceControlApproval({ approval, taskDir: this.dependencies.taskDir, serviceId: `${this.dependencies.serviceId}/${input.action}` });
      if (!verified.ok || approval.contentVersion !== contentVersion) return { ok: false, error: "invalid-service-approval" };
    }
    const claim = this.dependencies.write.claimWrite(input.sessionId, tier, { kind: "service-control", label: `Experimental service ${input.action}` });
    if (!claim.ok) return { ok: false, error: writeClaimError(claim) };
    this.busy = true;
    let settled: () => void = () => {};
    this.idle = new Promise<void>((resolve) => { settled = resolve; });
    const guard = () => {
      if (this.closing || input.signal?.aborted) return this.closing ? "service-host-closing" : "service-operation-cancelled";
      const caller = input.channel.snapshot();
      try {
        if (caller.taskId !== this.dependencies.taskId || caller.sessionId !== input.sessionId || input.channel.currentPermission !== tier || this.dependencies.revision() !== revision) return "service-authorization-changed";
      } catch { return "service-authorization-changed"; }
      return undefined;
    };
    try {
      if (tier === "default" && !approval) {
        if (input.channel.previewGate("exec.run", target).verdict !== "ask") return { ok: false, error: "service-approval-unavailable" };
        const gate = input.channel.gate("exec.run", target, contentVersion, undefined, SERVICE_CONTROL_SCOPE);
        if (gate.verdict !== "ask") return { ok: false, error: "service-approval-unavailable" };
        await input.persist();
        if (this.closing || input.signal?.aborted) {
          const current = input.channel.snapshot().approvals.find((row) => row.id === gate.approvalId);
          if (current?.status === "pending") input.channel.reject(current.id);
          else if (current?.status === "approved") input.channel.consumeApproval(current.id);
          await input.persist();
          return { ok: false, error: this.closing ? "service-host-closing" : "service-operation-cancelled" };
        }
        return { ok: false, error: `approval-required:${gate.approvalId}` };
      }
      if (approval) {
        if (tier !== "default" || !input.channel.consumeApproval(approval.id)) return { ok: false, error: "invalid-service-approval" };
        await input.persist();
      }
      await this.saved();
      const denied = guard(); if (denied) return { ok: false, error: denied };
      if (this.snapshot().state === "unconfirmed") return { ok: false, error: "service-termination-unconfirmed" };
      if (input.action === "stop" && !this.session) return { ok: true, state: this.state };
      if (input.action === "start") {
        const generation = ++this.generation; this.terminal = undefined;
        this.state = "starting"; this.owner = input.sessionId;
        if (!await this.checkpoint("starting", this.owner)) return { ok: false, error: "service-recovery-persistence-failed" };
        const denied = guard();
        if (denied) {
          if (!await this.checkpoint("stopped", null)) return { ok: false, error: "service-recovery-persistence-failed" };
          return { ok: false, error: denied };
        }
        let session: SupervisorSession;
        try { session = await executor(input.signal); }
        catch {
          this.state = "unconfirmed"; await this.checkpoint("unconfirmed", this.owner);
          return { ok: false, error: "service-start-unconfirmed" };
        }
        this.session = session;
        void session.completion.then((result) => this.observed(result, generation), () => this.observed({ event: "unconfirmed" }, generation));
        const running = await this.checkpoint("running", this.owner);
        await this.saved();
        if (!running || this.saveFailed) {
          await this.stopOwned(session, generation);
          return { ok: false, error: "service-recovery-persistence-failed" };
        }
        const afterStart = guard();
        if (afterStart && afterStart !== "service-host-closing") {
          if (this.session) { await this.checkpoint("stopping", this.owner); await this.stopOwned(session, generation); }
          return { ok: false, error: this.saveFailed ? "service-recovery-persistence-failed" : this.snapshot().state === "unconfirmed" ? "service-cancelled-unconfirmed" : afterStart };
        }
        if (afterStart) return { ok: false, error: afterStart };
        return this.snapshot().state === "unconfirmed" ? { ok: false, error: "service-start-unconfirmed" } : { ok: true, state: this.state };
      }
      const session = this.session!, generation = this.generation;
      await this.checkpoint("stopping", this.owner); await this.saved();
      const stopDenied = guard();
      if (stopDenied && !this.saveFailed) {
        // No stop was dispatched. Preserve the still-owned running session.
        if (this.session) await this.checkpoint("running", this.owner);
        return { ok: false, error: this.saveFailed ? "service-recovery-persistence-failed" : stopDenied };
      }
      if (this.session) await this.stopOwned(session, generation);
      if (this.saveFailed) return { ok: false, error: "service-recovery-persistence-failed" };
      return this.snapshot().state === "unconfirmed" ? { ok: false, error: "service-termination-unconfirmed" } : { ok: true, state: this.state };
    } catch { return { ok: false, error: "service-control-persistence-failed" }; }
    finally {
      this.busy = false;
      try { this.dependencies.write.releaseWrite(claim.claimId); }
      finally { this.idle = undefined; settled(); }
    }
  }
}
