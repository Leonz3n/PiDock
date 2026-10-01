export interface ExperimentalShutdownReport { schemaVersion: 1; taskId: string; hostEpoch: string; status: "closed" }
export function experimentalShutdownReport(value: unknown, taskId: string, epoch: string): ExperimentalShutdownReport {
  if (!value || typeof value !== "object" || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 512) throw Error("invalid-shutdown-report");
  const row = value as Record<string, unknown>;
  if (typeof row.taskId !== "string" || typeof row.hostEpoch !== "string" || Object.keys(row).sort().join(",") !== "hostEpoch,schemaVersion,status,taskId" || row.schemaVersion !== 1 || row.taskId !== taskId || row.hostEpoch !== epoch || row.status !== "closed") throw Error("invalid-shutdown-report");
  return { schemaVersion: 1, taskId, hostEpoch: epoch, status: "closed" };
}
