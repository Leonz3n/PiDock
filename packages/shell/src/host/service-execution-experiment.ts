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
  /** Synchronous durable acknowledgement; never paths, PIDs, approvals or env. */
  write(record: ServiceExecutionCheckpoint): undefined;
}

interface BoundControlChannel extends AgentControlChannel {
  snapshot(): { approvals: PiApproval[]; taskId: string; sessionId: string };
  reject(approvalId: string): void;
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
  constructor(private readonly dependencies: {
    taskId: string; taskDir: string; serviceId: string;
    /** Trusted configuration fingerprint; never secret values or page-supplied versions. */
    revision: () => string;
    write: WriteCoordinatorPort;
    /** Undefined means unavailable: refuse before approvals, claims or lifecycle changes. */
    start?: (signal?: AbortSignal) => Promise<SupervisorSession>;
    recovery?: ServiceExecutionRecoveryPort;
  }) {
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
      ? [{ resourceId: this.dependencies.serviceId, kind: "service" as const, ownerSessionId: this.owner, ...(this.state === "unconfirmed" ? { verificationRequired: true } : {}) }] : [];
  }
  private checkpoint(state: ExperimentalServiceState, owner: string | null): boolean {
    try {
      const record: ServiceExecutionCheckpoint = { schemaVersion: 1, taskId: this.dependencies.taskId, serviceId: this.dependencies.serviceId, state, ownerSessionId: owner };
      if (this.dependencies.recovery) {
        checkpointFromStore(record, this.dependencies.taskId, this.dependencies.serviceId);
        if (this.dependencies.recovery.write(record) !== undefined) throw Error();
      }
      return true;
    } catch { this.state = "unconfirmed"; this.owner = owner ?? this.owner; return false; }
  }
  private observed(result: SupervisorResult, generation: number): boolean {
    if (generation !== this.generation || this.owner === null) return this.state !== "unconfirmed";
    const state = result.event === "unconfirmed" ? "unconfirmed" : result.event === "exit" ? "exited" : "stopped";
    const owner = result.event === "unconfirmed" ? this.owner : null;
    if (!this.checkpoint(state, owner)) return false;
    this.state = state; this.owner = owner;
    if (result.event !== "unconfirmed") this.session = null;
    return true;
  }

  private beginStopping() {
    if (this.checkpoint("stopping", this.owner)) this.state = "stopping";
  }

  /** Trusted Host lifecycle only, not an Agent/human approval bypass RPC. */
  close(): Promise<Result> {
    this.closing = true;
    return this.closingPromise ??= this.drain();
  }
  private async drain(): Promise<Result> {
    await this.idle;
    if (this.state === "unconfirmed") return { ok: false, error: "service-termination-unconfirmed" };
    if (!this.session) return this.dependencies.recovery ? { ok: true, state: this.state } : { ok: false, error: "service-recovery-unavailable" };
    const claim = this.dependencies.write.claimWrite(this.owner!, "auto", { kind: "service-control", label: "Experimental Host shutdown" });
    if (!claim.ok) return { ok: false, error: writeClaimError(claim) };
    this.busy = true;
    try {
      this.beginStopping();
      let result: SupervisorResult;
      try { result = await this.session.stop(); } catch { result = { event: "unconfirmed" }; }
      if (!this.observed(result, this.generation)) return { ok: false, error: "service-recovery-persistence-failed" };
      if (!this.dependencies.recovery) return { ok: false, error: "service-recovery-unavailable" };
      return result.event === "unconfirmed" ? { ok: false, error: "service-termination-unconfirmed" } : { ok: true, state: this.state };
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
    if (this.busy) return { ok: false, error: "service-operation-in-flight" };
    if (this.state === "unconfirmed") return { ok: false, error: "service-termination-unconfirmed" };
    if (input.action === "start" && this.session) return { ok: false, error: "service-already-running" };
    if (input.action === "stop" && !this.session) return { ok: false, error: "service-not-running" };
    const tier = input.channel.currentPermission;
    if (tier === "read") return { ok: false, error: "readonly-service-control" };
    const revision = this.dependencies.revision();
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
        // An auto-tier request must not repurpose a default-tier approval.
        if (tier !== "default" || !input.channel.consumeApproval(approval.id)) return { ok: false, error: "invalid-service-approval" };
        await input.persist();
      }
      // Persistence may yield: re-read cancellation and live authorization.
      if (this.closing || input.signal?.aborted) return { ok: false, error: this.closing ? "service-host-closing" : "service-operation-cancelled" };
      if (input.channel.currentPermission !== tier || this.dependencies.revision() !== revision) return { ok: false, error: "service-authorization-changed" };
      if (this.snapshot().state === "unconfirmed") return { ok: false, error: "service-termination-unconfirmed" };
      if (input.action === "stop" && !this.session) return { ok: true, state: this.state };
      if (input.action === "start") {
        const generation = ++this.generation;
        this.state = "starting"; this.owner = input.sessionId;
        if (!this.checkpoint("starting", this.owner)) return { ok: false, error: "service-recovery-persistence-failed" };
        if (this.closing || input.signal?.aborted) {
          if (!this.checkpoint("stopped", null)) return { ok: false, error: "service-recovery-persistence-failed" };
          this.state = "stopped"; this.owner = null;
          return { ok: false, error: this.closing ? "service-host-closing" : "service-operation-cancelled" };
        }
        let session: SupervisorSession;
        try { session = await executor(input.signal); }
        catch {
          // A rejected launch may have spawned descendants before readiness failed.
          // Until the driver can prove zero resources, keep uncertainty owned.
          this.state = "unconfirmed";
          this.checkpoint("unconfirmed", this.owner);
          return { ok: false, error: "service-start-unconfirmed" };
        }
        this.session = session;
        void session.completion.then((result) => this.observed(result, generation), () => this.observed({ event: "unconfirmed" }, generation));
        if (!this.checkpoint("running", this.owner)) {
          // A live owned handle still permits cleanup, even if saving failed.
          let result: SupervisorResult;
          try { result = await session.stop(); } catch { result = { event: "unconfirmed" }; }
          this.observed(result, generation);
          return { ok: false, error: "service-recovery-persistence-failed" };
        }
        this.state = "running";
        if (input.signal?.aborted) {
          this.beginStopping();
          let result: SupervisorResult;
          try { result = await session.stop(); } catch { result = { event: "unconfirmed" }; }
          const saved = this.observed(result, generation);
          return { ok: false, error: !saved ? "service-recovery-persistence-failed" : result.event === "unconfirmed" ? "service-cancelled-unconfirmed" : "service-operation-cancelled" };
        }
        // close() awaits the claim's settlement and drains this owned session.
        if (this.closing) return { ok: false, error: "service-host-closing" };
        return { ok: true, state: this.state };
      }
      this.beginStopping();
      let result: SupervisorResult;
      try { result = await this.session!.stop(); }
      catch { result = { event: "unconfirmed" }; }
      if (!this.observed(result, this.generation)) return { ok: false, error: "service-recovery-persistence-failed" };
      return result.event === "unconfirmed" ? { ok: false, error: "service-termination-unconfirmed" } : { ok: true, state: this.state };
    } catch {
      return { ok: false, error: "service-control-persistence-failed" };
    } finally {
      this.busy = false;
      try { this.dependencies.write.releaseWrite(claim.claimId); }
      finally { this.idle = undefined; settled(); }
    }
  }
}
