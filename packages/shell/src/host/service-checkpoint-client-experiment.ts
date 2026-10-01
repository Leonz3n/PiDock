import { serviceExecutionCheckpoint, type ServiceExecutionCheckpoint } from "../rpc/service-execution-checkpoint.js";
import type { AsyncServiceExecutionRecoveryPort } from "./service-execution-experiment.js";

export interface ExperimentalCheckpointTransport {
  send(message: unknown): void;
  subscribe(receive: (message: unknown) => void, disconnected: () => void): () => void;
}
/** Dedicated trusted parent transport only. Never accepts renderer-provided lease identity. */
export function experimentalCheckpointClient(
  transport: ExperimentalCheckpointTransport,
  scope: { taskId: string; serviceId: string; epoch: string; timeoutMs?: number },
): { recovery: AsyncServiceExecutionRecoveryPort; dispose(): void; verify(): void } {
  scope = { ...scope };
  const timeoutMs = scope.timeoutMs ?? 5000;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(scope.taskId) || !/^[A-Za-z0-9_-]{1,128}$/.test(scope.serviceId) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(scope.epoch) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000) throw Error("invalid-service-recovery-client");
  let closed = false, sequence = 0, detach = () => {};
  let pending: { id: number; op: "read" | "write"; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined;
  const fence = () => {
    closed = true;
    if (pending) { clearTimeout(pending.timer); pending.reject(Error("service-recovery-transport-unconfirmed")); pending = undefined; }
    detach();
  };
  const receive = (message: unknown) => {
    if (closed) return;
    try {
      if (!pending || !message || typeof message !== "object" || Array.isArray(message) || Buffer.byteLength(JSON.stringify(message)) > 4096) throw Error();
      const row = message as Record<string, unknown>;
      if (row.kind !== "checkpoint-ack" || row.id !== pending.id || row.epoch !== scope.epoch || row.ok !== true ||
          Object.keys(row).sort().join(",") !== (pending.op === "read" ? "checkpoint,epoch,id,kind,ok" : "epoch,id,kind,ok")) throw Error();
      const value = pending.op === "read" && row.checkpoint !== null ? serviceExecutionCheckpoint(row.checkpoint, scope.taskId, scope.serviceId) : undefined;
      const current = pending; pending = undefined; clearTimeout(current.timer); current.resolve(value);
    } catch { fence(); }
  };
  try { detach = transport.subscribe(receive, fence); if (closed) detach(); }
  catch { fence(); }
  const verify = () => { if (closed) throw Error("service-recovery-transport-unconfirmed"); };
  const request = (op: "read" | "write", checkpoint?: ServiceExecutionCheckpoint): Promise<unknown> => {
    try {
      verify();
      if (pending) throw Error("service-recovery-request-in-flight");
      const record = op === "write" ? serviceExecutionCheckpoint(checkpoint, scope.taskId, scope.serviceId) : undefined;
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(fence, timeoutMs);
        pending = { id, op, resolve, reject, timer };
        try { transport.send({ kind: "checkpoint-request", id, packet: { epoch: scope.epoch, op, serviceId: scope.serviceId, ...(record ? { checkpoint: record } : {}) } }); }
        catch { fence(); }
      });
    } catch (error) { return Promise.reject(error); }
  };
  return { recovery: { read: () => request("read"), write: async (record) => { await request("write", record); return undefined; } }, dispose: fence, verify };
}
