import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { SERVICE_CONTROL_SCOPE, type PiApproval } from "../main/pi-session.js";
import { channelExecutionClosing, type AgentControlChannel } from "./service-control.js";
import { verifyServiceControlApproval } from "./service-runtime.js";
import type { SupervisorSession, SupervisorResult } from "./service-supervisor-experiment.js";
import { writeClaimError, type WriteCoordinatorPort } from "./write-coordination.js";
import { serviceExecutionCheckpoint as checkpointFromStore, type ExperimentalServiceState, type ServiceExecutionCheckpoint } from "../rpc/service-execution-checkpoint.js";
export type { ExperimentalServiceState, ServiceExecutionCheckpoint } from "../rpc/service-execution-checkpoint.js";
type Result = { ok: true; state: ExperimentalServiceState } | { ok: false; error: string; review?: ServiceOwnerReview };
export interface ServiceOwnerLaunch {
  capability: "reviewed-no-child-fixture";
  program: string; args: string[]; cwd: string; env: Record<string, string>; envRevision: string;
  programSha256: string; sourceSha256: string;
}
export interface ServiceOwnerIdentity {
  workspaceId: string; taskId: string; sessionId: string; serviceId: string; generation: number; configRevision: string;
}
export type ServiceOwnerReview = ServiceOwnerIdentity & Omit<ServiceOwnerLaunch, "env"> & { action: "start" | "stop"; envCommitment: string };
export type ServiceOwnerReceipt = ServiceOwnerIdentity & Pick<ServiceOwnerLaunch, "capability" | "programSha256" | "sourceSha256" | "envRevision"> & (SupervisorResult | { event: "not-started" });
export interface ServiceOwnerSession {
  completion: Promise<ServiceOwnerReceipt>;
  stop(): Promise<ServiceOwnerReceipt>;
}
export interface ServiceOwnerLease {
  /** Rechecks trusted task/path/shared-target identity and retained rights. */
  revalidate(): void;
  /** Releases only this lease. Must be atomic and infallible; a thrown error fences ownership. */
  release(): void;
}
export interface ManagedServiceBinding {
  workspaceId: string;
  resolveLaunch(): ServiceOwnerLaunch;
  acquireLease(review: ServiceOwnerReview): ServiceOwnerLease;
  /** Trusted adapter only; root exit is insufficient outside the reviewed fixed no-child capability. */
  start(identity: ServiceOwnerIdentity, launch: ServiceOwnerLaunch, signal?: AbortSignal): Promise<ServiceOwnerSession>;
}
function freezeLaunch(input: ServiceOwnerLaunch): ServiceOwnerLaunch {
  if (input.capability !== "reviewed-no-child-fixture" || !isAbsolute(input.program) || !isAbsolute(input.cwd) ||
      !Array.isArray(input.args) || input.args.length !== 1 || !isAbsolute(input.args[0]) ||
      !/^[a-f0-9]{64}$/.test(input.programSha256) || !/^[a-f0-9]{64}$/.test(input.sourceSha256) || !input.envRevision ||
      Object.entries(input.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0"))) throw Error("invalid-service-owner-launch");
  return { capability: input.capability, program: input.program, args: [...input.args], cwd: input.cwd, env: { ...input.env },
    envRevision: input.envRevision, programSha256: input.programSha256, sourceSha256: input.sourceSha256 };
}
function reviewFor(identity: ServiceOwnerIdentity, launch: ServiceOwnerLaunch, action: "start" | "stop"): ServiceOwnerReview {
  const { env, ...publicLaunch } = launch;
  return { ...identity, ...publicLaunch, args: [...launch.args], action,
    envCommitment: createHash("sha256").update(JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)))).digest("hex") };
}
function sameLaunch(a: ServiceOwnerLaunch, b: ServiceOwnerLaunch): boolean {
  return JSON.stringify(reviewFor({ workspaceId: "", taskId: "", sessionId: "", serviceId: "", generation: 0, configRevision: "" }, a, "start")) ===
    JSON.stringify(reviewFor({ workspaceId: "", taskId: "", sessionId: "", serviceId: "", generation: 0, configRevision: "" }, b, "start"));
}
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
  managed?: ManagedServiceBinding;
}

/** Shared single-service control owner. Managed mode requires scoped native proof and durable storage.
 * Legacy supervisor injection remains experimental; production Host/RPC is not enabled. */
export class ExperimentalServiceExecution {
  private state: ExperimentalServiceState = "stopped";
  private session: SupervisorSession | ServiceOwnerSession | null = null;
  private retained: { identity: ServiceOwnerIdentity; launch: ServiceOwnerLaunch; claimId: string; lease: ServiceOwnerLease } | undefined;
  private retainedRights: "held" | "release-uncertain" | "released" | "unverified" | null = null;
  private readonly managedApprovals = new Map<string, ServiceOwnerLaunch>();
  private owner: string | null = null;
  private busy = false;
  private generation = 0;
  private closing = false;
  private closingPromise: Promise<Result> | undefined;
  private idle: Promise<void> | undefined;
  private saving: Promise<boolean> | undefined;
  private pendingSaves = 0;
  private saveFailed = false;
  private terminal: { generation: number; promise: Promise<boolean>; notStarted: boolean } | undefined;

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
    let managed: ManagedServiceBinding | undefined;
    try {
      const receiver = dependencies.managed;
      if (receiver) {
        const { workspaceId, resolveLaunch, acquireLease, start } = receiver;
        if (!dependencies.recovery || !workspaceId || typeof start !== "function" ||
            typeof resolveLaunch !== "function" || typeof acquireLease !== "function") throw Error();
        managed = { workspaceId, resolveLaunch: resolveLaunch.bind(receiver), acquireLease: acquireLease.bind(receiver), start: start.bind(receiver) };
      }
    } catch { throw Error("incomplete-service-owner-binding"); }
    this.dependencies = dependencies = { ...dependencies, managed };
    try {
      const saved = dependencies.recovery?.read();
      if (saved !== undefined) {
        const record = checkpointFromStore(saved, dependencies.taskId, dependencies.serviceId);
        this.state = record.state === "stopped" || record.state === "exited" ? record.state : "unconfirmed";
        this.owner = record.ownerSessionId;
        if (dependencies.managed && this.owner !== null) this.retainedRights = "unverified";
      }
    } catch { throw Error("invalid-service-recovery"); }
  }
  snapshot() { return { state: this.state, ownerSessionId: this.owner, busy: this.busy, closing: this.closing, retainedRights: this.retainedRights }; }
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
    await this.terminal?.promise;
  }
  private observed(result: SupervisorResult | ServiceOwnerReceipt, generation: number): Promise<boolean> {
    const retained = this.retained;
    if (this.dependencies.managed && retained && generation === retained.identity.generation) {
      const row = (result && typeof result === "object" && !Array.isArray(result) ? result : {}) as Partial<ServiceOwnerReceipt>;
      if (Object.keys(row).sort().join(",") !== (row.event === "exit" ? "capability,code,configRevision,envRevision,event,generation,programSha256,serviceId,sessionId,sourceSha256,taskId,workspaceId" : "capability,configRevision,envRevision,event,generation,programSha256,serviceId,sessionId,sourceSha256,taskId,workspaceId") ||
          Object.entries(retained.identity).some(([key, value]) => row[key as keyof ServiceOwnerIdentity] !== value) ||
          row.capability !== retained.launch.capability || row.programSha256 !== retained.launch.programSha256 ||
          row.sourceSha256 !== retained.launch.sourceSha256 || row.envRevision !== retained.launch.envRevision ||
          !(row.event === "unconfirmed" || row.event === "not-started" || row.event === "exit" && Number.isInteger(row.code))) result = { event: "unconfirmed" };
    }
    if (generation !== this.generation || this.owner === null) return Promise.resolve(!this.saveFailed && this.state !== "unconfirmed");
    if (this.terminal?.generation === generation) return this.terminal.promise;
    const state = result.event === "unconfirmed" ? "unconfirmed" : result.event === "exit" ? "exited" : "stopped";
    const owner = result.event === "unconfirmed" ? this.owner : null;
    const promise = this.dependencies.managed && result.event !== "unconfirmed"
      ? this.completeRetained(state as "exited" | "stopped", generation)
      : this.checkpoint(state, owner, generation).then((ok) => {
        if (ok && generation === this.generation && result.event !== "unconfirmed") this.session = null;
        return ok;
      });
    this.terminal = { generation, promise, notStarted: result.event === "not-started" };
    return promise;
  }
  private wasNotStarted(generation: number): boolean { return this.terminal?.generation === generation && this.terminal.notStarted; }
  /** The existing unconfirmed record fences reconstruction until rights release and a clean ack. */
  private async completeRetained(state: "exited" | "stopped", generation: number): Promise<boolean> {
    const held = this.retained;
    if (!held || generation !== held.identity.generation) return false;
    if (!await this.checkpoint("unconfirmed", held.identity.sessionId, generation)) return false;
    if (!this.releaseRetained()) return false;
    this.session = null;
    return this.checkpoint(state, null, generation);
  }
  private releaseRetained(): boolean {
    const held = this.retained;
    if (!held) return true;
    try {
      held.lease.revalidate();
      // A throwing adapter may have partially released rights; never retry this lease.
      this.retainedRights = "release-uncertain";
      held.lease.release();
      this.dependencies.write.releaseWrite(held.claimId);
      this.retainedRights = "released";
      this.retained = undefined;
      return true;
    } catch {
      this.saveFailed = true; this.state = "unconfirmed"; this.owner = held.identity.sessionId;
      return false;
    }
  }
  private async stopOwned(session: SupervisorSession | ServiceOwnerSession, generation: number): Promise<SupervisorResult | ServiceOwnerReceipt> {
    let result: SupervisorResult | ServiceOwnerReceipt;
    try { result = await session.stop(); } catch { result = { event: "unconfirmed" }; }
    await this.observed(result, generation);
    await this.saved();
    return result;
  }
  /** Seal dispatch synchronously before the Host starts SDK shutdown. */
  seal(): void { this.closing = true; }
  /** Trusted Host lifecycle only, not an Agent/human approval bypass RPC. */
  close(): Promise<Result> { this.seal(); return this.closingPromise ??= this.drain(); }
  private async drain(): Promise<Result> {
    await this.idle; await this.saved();
    if (this.state === "unconfirmed") return { ok: false, error: "service-termination-unconfirmed" };
    if (!this.session) return this.dependencies.recovery ? { ok: true, state: this.state } : { ok: false, error: "service-recovery-unavailable" };
    const claim = this.retained ? { ok: true as const, claimId: this.retained.claimId }
      : this.dependencies.write.claimWrite(this.owner!, "auto", { kind: "service-control", label: "Experimental Host shutdown" });
    if (!claim.ok) return { ok: false, error: writeClaimError(claim) };
    this.busy = true;
    try {
      const session = this.session, generation = this.generation;
      await this.checkpoint("stopping", this.owner);
      const result = await this.stopOwned(session, generation);
      if (this.saveFailed) return { ok: false, error: "service-recovery-persistence-failed" };
      if (!this.dependencies.recovery) return { ok: false, error: "service-recovery-unavailable" };
      return result.event === "unconfirmed" || this.snapshot().state === "unconfirmed" ? { ok: false, error: "service-termination-unconfirmed" } : { ok: true, state: this.state };
    } finally { this.busy = false; if (!this.dependencies.managed) this.dependencies.write.releaseWrite(claim.claimId); }
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
    const executor = this.dependencies.managed?.start ?? this.dependencies.start;
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
    if (channelExecutionClosing(input.channel, "exec.run", target)) return { ok: false, error: "task-host-closing" };
    let launch: ServiceOwnerLaunch | undefined, review: ServiceOwnerReview | undefined;
    const managed = this.dependencies.managed;
    try {
      if (managed) {
        launch = freezeLaunch(managed.resolveLaunch());
        if (this.retained && (!sameLaunch(this.retained.launch, launch) || this.retained.identity.sessionId !== input.sessionId)) throw Error();
        review = reviewFor({ workspaceId: managed.workspaceId, taskId: this.dependencies.taskId, serviceId: this.dependencies.serviceId,
          sessionId: input.sessionId, generation: this.retained?.identity.generation ?? this.generation + 1, configRevision: revision }, launch, input.action);
      }
    } catch { return { ok: false, error: "service-authorization-changed" }; }
    const contentVersion = review ? createHash("sha256").update(JSON.stringify(review)).digest("hex") : `${input.action}:${revision}`;
    const approval = input.approvalId === undefined ? undefined : input.channel.snapshot().approvals.find((row) => row.id === input.approvalId);
    if (input.approvalId !== undefined && !approval) return { ok: false, error: "invalid-service-approval" };
    if (tier === "default" && approval) {
      const verified = verifyServiceControlApproval({ approval, taskDir: this.dependencies.taskDir, serviceId: `${this.dependencies.serviceId}/${input.action}` });
      if (!verified.ok || approval.contentVersion !== contentVersion || managed && (approval.taskId !== caller.taskId || approval.sessionId !== caller.sessionId || !this.managedApprovals.has(approval.id) || !sameLaunch(this.managedApprovals.get(approval.id)!, launch!))) return { ok: false, error: "invalid-service-approval" };
    }
    if (managed && tier === "auto") return { ok: false, error: "service-owner-explicit-approval-required" };
    const claim = this.dependencies.write.claimWrite(input.sessionId, tier, { kind: "service-control", label: `Experimental service ${input.action}` });
    if (!claim.ok) return { ok: false, error: writeClaimError(claim) };
    this.busy = true;
    let claimTransferred = false;
    let settled: () => void = () => {};
    this.idle = new Promise<void>((resolve) => { settled = resolve; });
    const guard = () => {
      if (this.closing || input.signal?.aborted) return this.closing ? "service-host-closing" : "service-operation-cancelled";
      if (channelExecutionClosing(input.channel, "exec.run", target)) return "task-host-closing";
      const caller = input.channel.snapshot();
      try {
        if (caller.taskId !== this.dependencies.taskId || caller.sessionId !== input.sessionId || input.channel.currentPermission !== tier || this.dependencies.revision() !== revision || managed && !sameLaunch(launch!, freezeLaunch(managed.resolveLaunch()))) return "service-authorization-changed";
        this.retained?.lease.revalidate();
      } catch { return "service-authorization-changed"; }
      return undefined;
    };
    try {
      if (tier === "default" && !approval) {
        if (input.channel.previewGate("exec.run", target).verdict !== "ask") return { ok: false, error: "service-approval-unavailable" };
        const gate = input.channel.gate("exec.run", target, contentVersion, undefined, SERVICE_CONTROL_SCOPE);
        if (gate.verdict !== "ask") return { ok: false, error: "service-approval-unavailable" };
        if (managed) this.managedApprovals.set(gate.approvalId, launch!);
        await input.persist();
        const channelClosed = channelExecutionClosing(input.channel, "exec.run", target);
        if (this.closing || input.signal?.aborted || channelClosed) {
          const current = input.channel.snapshot().approvals.find((row) => row.id === gate.approvalId);
          if (current?.status === "pending") input.channel.reject(current.id);
          else if (current?.status === "approved") input.channel.consumeApproval(current.id);
          await input.persist();
          return { ok: false, error: this.closing ? "service-host-closing" : channelClosed ? "task-host-closing" : "service-operation-cancelled" };
        }
        return { ok: false, error: `approval-required:${gate.approvalId}`, ...(review ? { review: structuredClone(review) } : {}) };
      }
      if (approval) {
        if (tier !== "default" || !input.channel.consumeApproval(approval.id)) return { ok: false, error: "invalid-service-approval" };
        this.managedApprovals.delete(approval.id);
        await input.persist();
      }
      await this.saved();
      const denied = guard(); if (denied) return { ok: false, error: denied };
      if (this.snapshot().state === "unconfirmed") return { ok: false, error: "service-termination-unconfirmed" };
      if (input.action === "stop" && !this.session) return { ok: true, state: this.state };
      if (input.action === "start") {
        const generation = ++this.generation; this.terminal = undefined;
        if (managed) {
          const identity: ServiceOwnerIdentity = { workspaceId: review!.workspaceId, taskId: review!.taskId, sessionId: input.sessionId,
            serviceId: review!.serviceId, configRevision: revision, generation };
          const lease = managed.acquireLease(structuredClone(review!));
          this.retained = { identity, launch: launch!, lease, claimId: claim.claimId };
          claimTransferred = true;
          this.retainedRights = "held";
          const denied = guard();
          if (denied) {
            if (!await this.completeRetained("stopped", generation)) return { ok: false, error: "service-termination-unconfirmed" };
            return { ok: false, error: denied };
          }
        }
        this.state = "starting"; this.owner = input.sessionId;
        if (!await this.checkpoint("starting", this.owner)) return { ok: false, error: "service-recovery-persistence-failed" };
        const denied = guard();
        if (denied) {
          const clean = managed ? await this.completeRetained("stopped", generation) : await this.checkpoint("stopped", null);
          if (!clean) return { ok: false, error: managed ? "service-termination-unconfirmed" : "service-recovery-persistence-failed" };
          return { ok: false, error: denied };
        }
        let session: SupervisorSession | ServiceOwnerSession;
        try {
          if (managed) session = await managed.start({ ...this.retained!.identity }, structuredClone(launch!), input.signal);
          else session = await this.dependencies.start!(input.signal);
        }
        catch {
          this.state = "unconfirmed"; await this.checkpoint("unconfirmed", this.owner);
          return { ok: false, error: "service-start-unconfirmed" };
        }
        this.session = session;
        void session.completion.then((result) => this.observed(result, generation), () => this.observed({ event: "unconfirmed" }, generation));
        const running = await this.checkpoint("running", this.owner);
        await this.saved();
        if (!running || this.saveFailed) {
          if (this.session) await this.stopOwned(this.session, generation);
          return { ok: false, error: "service-recovery-persistence-failed" };
        }
        if (this.wasNotStarted(generation)) return { ok: false, error: "service-not-started" };
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
      try { if (!claimTransferred) this.dependencies.write.releaseWrite(claim.claimId); }
      finally { this.idle = undefined; settled(); }
    }
  }
}
