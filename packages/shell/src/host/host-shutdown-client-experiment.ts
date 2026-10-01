import { experimentalShutdownReport, type ExperimentalShutdownReport } from "../rpc/host-shutdown-report.js";
import type { ExperimentalCheckpointTransport } from "./service-checkpoint-client-experiment.js";

/** Dedicated current-Host parent transport. No renderer or installed RPC wiring. */
export function experimentalShutdownClient(transport: ExperimentalCheckpointTransport, scope: { taskId: string; epoch: string; timeoutMs?: number }) {
  scope = { ...scope };
  const timeout = scope.timeoutMs ?? 5000;
  if (typeof scope.taskId !== "string" || typeof scope.epoch !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(scope.taskId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(scope.epoch) || !Number.isInteger(timeout) || timeout < 10 || timeout > 30_000) throw Error("invalid-shutdown-client");
  let fenced = false, detach = () => {}, receipt: Promise<undefined> | undefined;
  let pending: { resolve(value: undefined): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined;
  const fence = () => { fenced = true; if (pending) { clearTimeout(pending.timer); pending.reject(Error("shutdown-report-unconfirmed")); pending = undefined; } detach(); };
  const verify = () => { if (fenced) throw Error("shutdown-report-unconfirmed"); };
  try {
    detach = transport.subscribe((value) => {
      if (fenced) return;
      try {
        if (!pending || !value || typeof value !== "object" || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 512) throw Error();
        const row = value as Record<string, unknown>;
        if (Object.keys(row).sort().join(",") !== "epoch,id,kind,ok" || row.kind !== "shutdown-report-ack" || row.id !== 1 || row.epoch !== scope.epoch || row.ok !== true) throw Error();
        const current = pending; pending = undefined; clearTimeout(current.timer); current.resolve(undefined);
      } catch { fence(); }
    }, fence);
    if (fenced) detach();
  } catch { fence(); }
  const persist = (value: ExperimentalShutdownReport): Promise<undefined> => {
    try {
      verify(); const report = experimentalShutdownReport(value, scope.taskId, scope.epoch);
      if (receipt) return receipt;
      receipt = new Promise((resolve, reject) => {
        pending = { resolve, reject, timer: setTimeout(fence, timeout) };
        try { transport.send({ kind: "shutdown-report-request", id: 1, packet: { op: "shutdown", epoch: scope.epoch, report } }); }
        catch { fence(); }
      });
      return receipt;
    } catch (error) { return Promise.reject(error); }
  };
  return { persist, verify, dispose: fence };
}
