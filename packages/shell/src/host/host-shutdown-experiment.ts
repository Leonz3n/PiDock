import { shutdownDeadline } from "./shutdown-deadline.js";

export interface ExperimentalShutdownReport { schemaVersion: 1; taskId: string; hostEpoch: string; status: "closed" }
interface Dependencies {
  taskId: string; hostEpoch: string;
  /** Trusted producer callbacks, never request payloads. */
  sealSdk(): void;
  shutdownSdk(): Promise<void>;
  settleTurns(): Promise<void>;
  services: readonly { seal(): void; close(): Promise<{ ok: boolean; state?: string }> }[];
  verify(): void;
  /** Resolves only after durable report acknowledgement; sending is not enough. */
  persist(report: ExperimentalShutdownReport): Promise<undefined>;
  timeoutMs?: number;
}
type Result = { ok: true; report: ExperimentalShutdownReport } | { ok: false; error: "host-shutdown-unconfirmed" };

/** Internal ordering experiment only. No installed Host/RPC or metadata-writer adapter. */
export class ExperimentalHostShutdown {
  private readonly dependencies: Dependencies;
  private pending: Promise<Result> | undefined;
  constructor(dependencies: Dependencies) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(dependencies.taskId) || !/^[A-Za-z0-9_-]{1,128}$/.test(dependencies.hostEpoch)) throw Error("invalid-host-shutdown-scope");
    const timeout = dependencies.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeout) || timeout < 10 || timeout > 60_000) throw Error("invalid-shutdown-deadline");
    this.dependencies = { ...dependencies, timeoutMs: timeout, services: [...dependencies.services] };
  }
  close(): Promise<Result> {
    if (this.pending) return this.pending;
    let sealed = true;
    try { this.dependencies.sealSdk(); } catch { sealed = false; }
    for (const service of this.dependencies.services) { try { service.seal(); } catch { sealed = false; } }
    return this.pending = this.drain(sealed);
  }
  private async drain(sealed: boolean): Promise<Result> {
    const d = this.dependencies;
    let safe = sealed;
    try { await shutdownDeadline(d.shutdownSdk(), d.timeoutMs!, "sdk-shutdown-unconfirmed"); }
    catch { safe = false; }
    try { await shutdownDeadline(d.settleTurns(), d.timeoutMs!, "sdk-turns-unconfirmed"); }
    catch { safe = false; }
    // Still attempt owned cleanup after SDK failure, but never issue a closed receipt.
    for (const service of d.services) {
      try {
        const result = await shutdownDeadline(service.close(), d.timeoutMs!, "service-drain-unconfirmed");
        if (result.ok !== true || (result.state !== "stopped" && result.state !== "exited")) safe = false;
      } catch { safe = false; }
    }
    if (!safe) return { ok: false, error: "host-shutdown-unconfirmed" };
    const report = Object.freeze({ schemaVersion: 1 as const, taskId: d.taskId, hostEpoch: d.hostEpoch, status: "closed" as const });
    try {
      d.verify();
      if (await shutdownDeadline(d.persist(report), d.timeoutMs!, "shutdown-report-unconfirmed") !== undefined) throw Error();
      d.verify();
      return { ok: true, report };
    } catch { return { ok: false, error: "host-shutdown-unconfirmed" }; }
  }
}
