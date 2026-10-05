import { experimentalShutdownReport, type ExperimentalShutdownReport } from "../rpc/host-shutdown-report.js";
import { shutdownDeadline } from "../host/shutdown-deadline.js";
import type { CheckpointHostInstance } from "./service-recovery-store-experiment.js";

interface HostEntry {
  taskId: string;
  epoch: string;
  host: CheckpointHostInstance;
  /** Bound trusted main transport; resolves only on this actual Host's completion. */
  requestClose(): Promise<unknown>;
  /** The current lease's post-ack confirmation, not a publication-only check. */
  confirm(sender: object, report: ExperimentalShutdownReport): void;
  /** Requests cooperative exit of the confirmed Host. Sending is not native exit. */
  requestExit(): void;
}
interface Dependencies {
  hosts: readonly HostEntry[];
  /** Synchronously prevent new Host/resource admission before shutdown starts. */
  seal(): void;
  /** Trusted main inventory/identity check, including after native exits. */
  verify(): void;
  /** Metadata writer disposal only; never a process-kill or recovery operation. */
  dispose(): void;
  timeoutMs?: number;
}
type Result = { ok: true; status: "released" } | { ok: false; error: "host-release-unconfirmed" };
interface Watched { entry: HostEntry; exit: Promise<void>; exitObserved: boolean; releaseRequested: boolean; unexpectedExit: boolean; detach(): void }

/** Main-only ordering experiment. Not imported by installed runtime or renderer. */
export class ExperimentalHostRelease {
  private readonly dependencies: Dependencies;
  private pending: Promise<Result> | undefined;
  constructor(dependencies: Dependencies) {
    const timeoutMs = dependencies.timeoutMs ?? 5_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60_000 || !dependencies.hosts.length || dependencies.hosts.length > 128) throw Error("invalid-host-release-scope");
    const hosts = dependencies.hosts.map((entry) => ({ ...entry, host: { sender: entry.host.sender,
      hasExited: entry.host.hasExited.bind(entry.host), subscribeExit: entry.host.subscribeExit.bind(entry.host) },
      requestClose: entry.requestClose.bind(entry), confirm: entry.confirm.bind(entry), requestExit: entry.requestExit.bind(entry) }));
    if (new Set(hosts.map((entry) => entry.taskId)).size !== hosts.length || new Set(hosts.map((entry) => entry.host.sender)).size !== hosts.length || hosts.some((entry) =>
      !/^[A-Za-z0-9_-]{1,128}$/.test(entry.taskId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(entry.epoch) || !entry.host.sender || typeof entry.host.sender !== "object")) throw Error("invalid-host-release-scope");
    this.dependencies = { ...dependencies, hosts, timeoutMs };
  }
  close(): Promise<Result> {
    if (this.pending) return this.pending;
    let finish!: (result: Result) => void;
    this.pending = new Promise((resolve) => { finish = resolve; });
    let sealed = true;
    try { this.dependencies.seal(); } catch { sealed = false; }
    void this.drain(sealed).then(finish);
    return this.pending;
  }
  private watch(entry: HostEntry): Watched {
    let ended!: () => void;
    const watched: Watched = { entry, exit: new Promise((resolve) => { ended = resolve; }), exitObserved: false, releaseRequested: false, unexpectedExit: false, detach() {} };
    if (entry.host.hasExited()) throw Error();
    watched.detach = entry.host.subscribeExit(() => {
      try {
        watched.exitObserved = entry.host.hasExited();
        if (!watched.releaseRequested || !watched.exitObserved) watched.unexpectedExit = true;
      } catch { watched.unexpectedExit = true; }
      ended();
    });
    return watched;
  }
  private async drain(sealed: boolean): Promise<Result> {
    const d = this.dependencies, watched: Watched[] = [];
    let acceptingClose = true;
    try {
      if (!sealed) throw Error();
      d.verify();
      for (const entry of d.hosts) watched.push(this.watch(entry));
      // Drain all captured Hosts within one budget; late receipts cannot confirm leases.
      const confirmed = await shutdownDeadline(Promise.all(watched.map(async (h) => {
        try {
          if (!acceptingClose) return false;
          d.verify();
          if (h.unexpectedExit || h.entry.host.hasExited()) throw Error();
          const result = await h.entry.requestClose();
          if (!acceptingClose) return false;
          d.verify();
          if (h.unexpectedExit || h.entry.host.hasExited() || !result || typeof result !== "object" || Array.isArray(result)) throw Error();
          const row = result as Record<string, unknown>;
          if (Object.keys(row).sort().join(",") !== "ok,report" || row.ok !== true) throw Error();
          const report = experimentalShutdownReport(row.report, h.entry.taskId, h.entry.epoch);
          h.entry.confirm(h.entry.host.sender, report);
          return true;
        } catch { return false; }
      })), d.timeoutMs!, "host-release-unconfirmed");
      acceptingClose = false;
      if (confirmed.some((value) => !value)) throw Error();
      d.verify();
      if (watched.some((h) => h.unexpectedExit || h.entry.host.hasExited())) throw Error();
      for (const h of watched) {
        d.verify();
        if (h.unexpectedExit || h.entry.host.hasExited()) throw Error();
        h.releaseRequested = true;
        h.entry.requestExit();
      }
      await shutdownDeadline(Promise.all(watched.map((h) => h.exit)), d.timeoutMs!, "host-release-unconfirmed");
      d.verify();
      if (watched.some((h) => !h.exitObserved || h.unexpectedExit || !h.entry.host.hasExited())) throw Error();
      d.dispose();
      return { ok: true, status: "released" };
    } catch { return { ok: false, error: "host-release-unconfirmed" }; }
    finally {
      acceptingClose = false;
      for (const h of watched) { try { h.detach(); } catch { /* Detached listeners cannot authorize release. */ } }
    }
  }
}
