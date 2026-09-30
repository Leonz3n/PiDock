import { SERVICE_CONTROL_SCOPE, type PiApproval } from "../main/pi-session.js";
import type { AgentControlChannel } from "./service-control.js";
import { verifyServiceControlApproval } from "./service-runtime.js";
import type { SupervisorSession, SupervisorResult } from "./service-supervisor-experiment.js";
import { writeClaimError, type WriteCoordinatorPort } from "./write-coordination.js";

export type ExperimentalServiceState = "stopped" | "starting" | "running" | "stopping" | "exited" | "unconfirmed";
type Result = { ok: true; state: ExperimentalServiceState } | { ok: false; error: string };

interface BoundControlChannel extends AgentControlChannel {
  snapshot(): { approvals: PiApproval[]; taskId: string; sessionId: string };
}

/** Single-service experiment only. No production Host/RPC imports or enable flag. */
export class ExperimentalServiceExecution {
  private state: ExperimentalServiceState = "stopped";
  private session: SupervisorSession | null = null;
  private owner: string | null = null;
  private busy = false;
  private generation = 0;
  constructor(private readonly dependencies: {
    taskId: string; taskDir: string; serviceId: string;
    /** Trusted configuration fingerprint; never secret values or page-supplied versions. */
    revision: () => string;
    write: WriteCoordinatorPort;
    /** Undefined means unavailable: refuse before approvals, claims or lifecycle changes. */
    start?: () => Promise<SupervisorSession>;
  }) { this.dependencies = { ...dependencies }; }

  snapshot() { return { state: this.state, ownerSessionId: this.owner, busy: this.busy }; }
  resources() {
    return this.owner !== null && ["starting", "running", "stopping", "unconfirmed"].includes(this.state)
      ? [{ resourceId: this.dependencies.serviceId, kind: "service" as const, ownerSessionId: this.owner }] : [];
  }
  private observed(result: SupervisorResult, generation: number) {
    if (generation !== this.generation) return;
    if (result.event === "unconfirmed") { this.state = "unconfirmed"; return; }
    this.state = result.event === "exit" ? "exited" : "stopped";
    this.session = null; this.owner = null;
  }

  async control(input: {
    channel: BoundControlChannel; sessionId: string; action: "start" | "stop";
    approvalId?: string; persist: () => void | Promise<void>;
  }): Promise<Result> {
    input = { ...input };
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
    try {
      if (tier === "default" && !approval) {
        if (input.channel.previewGate("exec.run", target).verdict !== "ask") return { ok: false, error: "service-approval-unavailable" };
        const gate = input.channel.gate("exec.run", target, contentVersion, undefined, SERVICE_CONTROL_SCOPE);
        if (gate.verdict !== "ask") return { ok: false, error: "service-approval-unavailable" };
        await input.persist();
        return { ok: false, error: `approval-required:${gate.approvalId}` };
      }
      if (approval) {
        // An auto-tier request must not repurpose a default-tier approval.
        if (tier !== "default" || !input.channel.consumeApproval(approval.id)) return { ok: false, error: "invalid-service-approval" };
        await input.persist();
      }
      // Persistence may yield: re-read live permission/config before side effects.
      if (input.channel.currentPermission !== tier || this.dependencies.revision() !== revision) return { ok: false, error: "service-authorization-changed" };
      if (input.action === "start") {
        const generation = ++this.generation;
        this.state = "starting"; this.owner = input.sessionId;
        let session: SupervisorSession;
        try { session = await executor(); }
        catch {
          // A rejected launch may have spawned descendants before readiness failed.
          // Until the driver can prove zero resources, keep uncertainty owned.
          this.state = "unconfirmed";
          return { ok: false, error: "service-start-unconfirmed" };
        }
        this.session = session; this.state = "running";
        void session.completion.then((result) => this.observed(result, generation), () => this.observed({ event: "unconfirmed" }, generation));
        return { ok: true, state: this.state };
      }
      this.state = "stopping";
      let result: SupervisorResult;
      try { result = await this.session!.stop(); }
      catch { result = { event: "unconfirmed" }; }
      this.observed(result, this.generation);
      return result.event === "unconfirmed" ? { ok: false, error: "service-termination-unconfirmed" } : { ok: true, state: this.state };
    } catch {
      return { ok: false, error: "service-control-persistence-failed" };
    } finally {
      this.busy = false;
      this.dependencies.write.releaseWrite(claim.claimId);
    }
  }
}
