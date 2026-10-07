import { shutdownDeadline } from "../host/shutdown-deadline.js";
import { randomUUID } from "node:crypto";
import type { UtilityProcess } from "electron";
import { ServiceCatalog, type ServiceCatalogAuthority } from "./service-catalog.js";
import { ExperimentalServiceRecoveryStore, type ExperimentalCheckpointLease } from "./service-recovery-store-experiment.js";
import { serviceOwnerBootstrap, serviceOwnerCompletion, type ServiceOwnerBootstrap } from "../rpc/service-host-binding.js";

interface Binding {
  child: UtilityProcess; taskId: string; scope?: ServiceOwnerBootstrap; lease?: ExperimentalCheckpointLease;
  exited: boolean; exit: Promise<void>; resolveExit(): void; fenced: boolean; ready: Promise<void>; resolve(): void; reject(error: Error): void;
  sequence: Map<string, number>; timer?: ReturnType<typeof setTimeout>;
}
/** Main-only installed transport: listeners close over the authoritative UtilityProcess, not a claimed PID/sender. */
export class InstalledServiceHostAuthority {
  private store?: ExperimentalServiceRecoveryStore;
  private storeFailed = false;
  private readonly bindings = new Map<object, Binding>();
  private disposing = false;
  private disposalReceipt?: Promise<void>;
  constructor(private readonly profile: string, private readonly catalog: ServiceCatalog, private readonly authority: ServiceCatalogAuthority,
    private readonly workspaceId: string, private readonly env: Record<string, string | undefined>) {}
  private recoveryStore(): ExperimentalServiceRecoveryStore {
    if (this.storeFailed) throw Error("service-owner-inventory-unconfirmed");
    try {
      return this.store ??= new ExperimentalServiceRecoveryStore(this.profile,
        { projectExists: (id) => this.authority.projectExists(id), task: (id) => this.authority.verifiedTask?.(id) ?? null },
        (taskId) => this.catalog.ownerSnapshot(taskId, this.workspaceId, this.env).entries.map((entry) => entry.serviceId));
    } catch { this.storeFailed = true; throw Error("service-owner-inventory-unconfirmed"); }
  }
  prepare(child: UtilityProcess, taskId: string): Promise<void> {
    const prior = this.bindings.get(child);
    if (prior) return prior.taskId === taskId ? prior.ready : Promise.reject(Error("service-owner-inventory-unconfirmed"));
    let resolve!: () => void, reject!: (error: Error) => void;
    const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    let resolveExit!: () => void;
    const exit = new Promise<void>((done) => { resolveExit = done; });
    const binding: Binding = { child, taskId, exited: false, exit, resolveExit, fenced: false, ready, resolve, reject, sequence: new Map() };
    this.bindings.set(child, binding);
    const receive = (message: unknown) => this.receive(binding, message);
    child.on("message", receive);
    child.once("exit", () => {
      binding.exited = true; this.fence(binding);
      child.removeListener("message", receive);
      // Promise continuations run after recovery's exit listener revokes its lease in this emission.
      binding.resolveExit();
    });
    try {
      if (this.disposing) throw Error();
      const snapshot = this.catalog.ownerSnapshot(taskId, this.workspaceId, this.env);
      const lease = this.recoveryStore().acquire(taskId, { sender: child, hasExited: () => binding.exited,
        subscribeExit: (listener) => { child.on("exit", listener); return () => { child.removeListener("exit", listener); }; } });
      binding.lease = lease;
      lease.inventory(child); // Complete strict durable inventory must resolve before empty admission.
      binding.scope = serviceOwnerBootstrap({ ...snapshot, kind: "service-owner-bootstrap", instanceId: randomUUID(), epoch: lease.epoch }, this.workspaceId, taskId);
      for (const entry of binding.scope.entries) { Object.freeze(entry.args); Object.freeze(entry); }
      Object.freeze(binding.scope.entries); Object.freeze(binding.scope);
      binding.timer = setTimeout(() => this.fence(binding), 5000);
      child.postMessage(binding.scope);
    } catch { this.fence(binding); }
    return ready;
  }
  verify(child: UtilityProcess): void {
    const binding = this.bindings.get(child);
    if (!binding || binding.fenced || binding.exited || !binding.scope || !binding.lease) throw Error("service-owner-inventory-unconfirmed");
    try {
      if (this.catalog.ownerSnapshot(binding.taskId, this.workspaceId, this.env).catalogRevision !== binding.scope.catalogRevision) throw Error();
      binding.lease.inventory(child);
    } catch { this.fence(binding); throw Error("service-owner-inventory-unconfirmed"); }
  }
  private fence(binding: Binding): void {
    binding.fenced = true; clearTimeout(binding.timer); binding.timer = undefined;
    binding.reject(Error("service-owner-inventory-unconfirmed"));
    if (!binding.exited) { try { binding.child.postMessage({ kind: "service-owner-fenced", workspaceId: this.workspaceId, taskId: binding.taskId }); } catch { /* Child remains owned. */ } }
  }
  private receive(binding: Binding, value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const row = value as Record<string, unknown>;
    if (row.kind !== "service-owner-ready" && row.kind !== "service-owner-request") return;
    try {
      this.verify(binding.child);
      const scope = binding.scope!;
      if (Buffer.byteLength(JSON.stringify(value)) > 8192 || row.workspaceId !== scope.workspaceId || row.taskId !== scope.taskId || row.instanceId !== scope.instanceId ||
          row.epoch !== scope.epoch || row.catalogRevision !== scope.catalogRevision) throw Error();
      if (row.kind === "service-owner-ready") {
        if (Object.keys(row).sort().join(",") !== "catalogRevision,epoch,instanceId,kind,taskId,workspaceId" || !binding.timer) throw Error();
        clearTimeout(binding.timer); binding.timer = undefined; binding.resolve(); return;
      }
      if (Object.keys(row).sort().join(",") !== "catalogRevision,epoch,instanceId,kind,request,serviceId,taskId,workspaceId" || !row.request || typeof row.request !== "object" || Array.isArray(row.request)) throw Error();
      const request = row.request as Record<string, unknown>, packet = request.packet as Record<string, unknown>;
      if (!packet || typeof packet !== "object" || Array.isArray(packet) || packet.epoch !== scope.epoch || !Number.isSafeInteger(request.id) ||
          Object.keys(request).sort().join(",") !== "id,kind,packet") throw Error();
      const serviceId = row.serviceId;
      const checkpoint = request.kind === "checkpoint-request";
      if (checkpoint ? typeof serviceId !== "string" || !scope.entries.some((entry) => entry.serviceId === serviceId) || packet.serviceId !== serviceId || packet.op !== "read" && packet.op !== "write"
        : request.kind !== "shutdown-report-request" || serviceId !== null || request.id !== 1 || packet.op !== "shutdown") throw Error();
      const key = checkpoint ? serviceId as string : "shutdown";
      if (request.id !== (binding.sequence.get(key) ?? 0) + 1) throw Error();
      binding.sequence.set(key, request.id as number);
      const saved = binding.lease!.request(binding.child, packet);
      const reply = checkpoint ? { kind: "checkpoint-ack", epoch: scope.epoch, id: request.id, ok: true, ...(packet.op === "read" ? { checkpoint: saved ?? null } : {}) }
        : { kind: "shutdown-report-ack", epoch: scope.epoch, id: request.id, ok: true };
      this.verify(binding.child);
      binding.child.postMessage({ kind: "service-owner-ack", workspaceId: scope.workspaceId, taskId: scope.taskId, instanceId: scope.instanceId,
        epoch: scope.epoch, catalogRevision: scope.catalogRevision, serviceId, reply });
    } catch { this.fence(binding); }
  }
  /** Main confirms the post-durable-ack Host completion only after its existing lifecycle report is safe. */
  confirm(child: UtilityProcess, value: unknown): void {
    this.verify(child);
    const binding = this.bindings.get(child)!;
    const completion = serviceOwnerCompletion(value, binding.scope!);
    const durable = binding.lease!.inventory(child).filter((entry) => binding.scope!.entries.some((contract) => contract.serviceId === entry.serviceId));
    if (JSON.stringify(durable) !== JSON.stringify(completion.entries)) throw Error("service-owner-shutdown-unconfirmed");
    binding.lease!.verifyShutdown(child, completion.report);
    binding.lease!.confirmShutdown(child, completion.report);
  }
  /** Cached receipt: exit and lease revocation precede writer disposal; expiry never grants a retry. */
  disposeWhenExited(): Promise<void> {
    if (this.disposalReceipt) return this.disposalReceipt;
    this.disposing = true;
    let expired = false;
    const work = Promise.all([...this.bindings.values()].map((binding) => binding.exit)).then(() => {
      if (expired) throw Error("service-owner-disposal-unconfirmed");
      this.store?.dispose();
    });
    this.disposalReceipt = shutdownDeadline(work, 15_000, "service-owner-disposal-unconfirmed").catch((error: unknown) => {
      expired = true;
      throw error;
    });
    return this.disposalReceipt;
  }
}
