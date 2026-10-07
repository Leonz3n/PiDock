import { ExperimentalServiceExecution, type ManagedServiceBinding } from "./service-execution-experiment.js";
import { experimentalCheckpointClient, type ExperimentalCheckpointTransport } from "./service-checkpoint-client-experiment.js";
import { experimentalShutdownClient } from "./host-shutdown-client-experiment.js";
import type { AgentOwnedResource, WriteCoordinatorPort } from "./write-coordination.js";
import { serviceOwnerBootstrap, type ServiceOwnerBootstrap, type ServiceOwnerCompletion } from "../rpc/service-host-binding.js";

/** Installed inventory delegates state/terminal durability to the delivered owner.
 * No production descendant driver has been admitted. A future driver must satisfy ManagedServiceBinding. */
export class ServiceOwnerInventory {
  private scope?: ServiceOwnerBootstrap;
  private readonly owners = new Map<string, ExperimentalServiceExecution>();
  private readonly clients = new Map<string, ReturnType<typeof experimentalCheckpointClient>>();
  private shutdown?: ReturnType<typeof experimentalShutdownClient>;
  private failed = false;
  private initialized = false;
  private closing = false;
  private pending?: Promise<void>;
  private completion?: Promise<ServiceOwnerCompletion>;
  constructor(private readonly workspaceId: string, private readonly taskId: string, private readonly taskDir: string,
    private readonly write: WriteCoordinatorPort, private readonly transportFor: (scope: ServiceOwnerBootstrap, serviceId: string | null) => ExperimentalCheckpointTransport) {}
  fence(): void { this.failed = true; }
  resources(): AgentOwnedResource[] {
    if (this.scope) { try { this.verify(); } catch { this.fence(); } }
    const owners = [...this.owners.values()].flatMap((owner) => owner.resources());
    return this.failed || !this.initialized ? [...owners, { resourceId: "service-owner-inventory", kind: "service", ownerSessionId: null, verificationRequired: true }] : owners;
  }
  bootstrap(value: unknown): Promise<void> {
    if (this.pending || this.closing || this.failed) { this.fence(); return Promise.reject(Error("service-owner-inventory-unconfirmed")); }
    return this.pending = this.initialize(value);
  }
  private async initialize(value: unknown): Promise<void> {
    try {
      const scope = serviceOwnerBootstrap(value, this.workspaceId, this.taskId);
      this.scope = scope;
      const closedBinding: ManagedServiceBinding = { workspaceId: scope.workspaceId,
        resolveLaunch: () => { throw Error("service-execution-unavailable"); },
        acquireLease: () => { throw Error("service-execution-unavailable"); },
        start: async () => { throw Error("service-execution-unavailable"); } };
      for (const entry of scope.entries) {
        const client = experimentalCheckpointClient(this.transportFor(scope, entry.serviceId), { taskId: this.taskId, serviceId: entry.serviceId, epoch: scope.epoch });
        this.clients.set(entry.serviceId, client);
        const owner = await ExperimentalServiceExecution.create({ taskId: this.taskId, taskDir: this.taskDir, serviceId: entry.serviceId,
          revision: () => { this.verify(); return entry.configRevision; }, recovery: client.recovery, write: this.write, managed: closedBinding });
        this.owners.set(entry.serviceId, owner);
      }
      this.shutdown = experimentalShutdownClient(this.transportFor(scope, null), { taskId: this.taskId, epoch: scope.epoch });
      this.verify(); this.initialized = true;
    } catch { this.fence(); throw Error("service-owner-inventory-unconfirmed"); }
  }
  verify(): void {
    if (this.failed || !this.scope) throw Error("service-owner-inventory-unconfirmed");
    for (const client of this.clients.values()) client.verify();
    this.shutdown?.verify();
  }
  status(serviceId: string) {
    if (this.scope) { try { this.verify(); } catch { this.fence(); } }
    if (!this.initialized || this.failed) return { ok: false as const, error: "service-owner-inventory-unconfirmed" };
    const owner = this.owners.get(serviceId);
    return owner ? { ok: true as const, service: { serviceId, ...owner.snapshot(), executionAvailable: false } }
      : { ok: false as const, error: "unknown-service" };
  }
  control(): { ok: false; error: string } {
    if (this.scope) { try { this.verify(); } catch { this.fence(); } }
    return { ok: false, error: this.closing ? "service-host-closing" : !this.initialized || this.failed ? "service-owner-inventory-unconfirmed" : "service-execution-unavailable" };
  }
  seal(): void { this.closing = true; for (const owner of this.owners.values()) owner.seal(); }
  close(): Promise<ServiceOwnerCompletion> { this.seal(); return this.completion ??= this.drain(); }
  private async drain(): Promise<ServiceOwnerCompletion> {
    try {
      await this.pending;
      this.verify();
      if (!this.initialized || !this.shutdown || !this.scope) throw Error();
      const entries = [];
      for (const [serviceId, owner] of this.owners) {
        const closed = await owner.close();
        if (!closed.ok || closed.state !== "stopped" && closed.state !== "exited") throw Error();
        const checkpoint = { schemaVersion: 1 as const, taskId: this.taskId, serviceId, state: closed.state, ownerSessionId: null };
        // Even previously stopped/absent owners must acknowledge the current epoch's terminal checkpoint.
        await this.clients.get(serviceId)!.recovery.write(checkpoint); entries.push(checkpoint);
      }
      const report = { schemaVersion: 1 as const, taskId: this.taskId, hostEpoch: this.scope.epoch, status: "closed" as const };
      this.verify(); await this.shutdown.persist(report); this.verify();
      return { workspaceId: this.workspaceId, taskId: this.taskId, instanceId: this.scope.instanceId, epoch: this.scope.epoch,
        catalogRevision: this.scope.catalogRevision, entries, report };
    } catch { this.fence(); throw Error("service-owner-shutdown-unconfirmed"); }
  }
}
