// Internal experiment schema, not an enabled RPC or a process ownership proof.
export type ExperimentalServiceState = "stopped" | "starting" | "running" | "stopping" | "exited" | "unconfirmed";
export interface ServiceExecutionCheckpoint {
  schemaVersion: 1; taskId: string; serviceId: string;
  state: ExperimentalServiceState; ownerSessionId: string | null;
}
const states: ExperimentalServiceState[] = ["stopped", "starting", "running", "stopping", "exited", "unconfirmed"];
export function serviceExecutionCheckpoint(value: unknown, taskId: string, serviceId: string): ServiceExecutionCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid-service-recovery");
  const row = value as Record<string, unknown>;
  const terminal = row.state === "stopped" || row.state === "exited";
  if (Object.keys(row).sort().join(",") !== "ownerSessionId,schemaVersion,serviceId,state,taskId" ||
      row.schemaVersion !== 1 || row.taskId !== taskId || row.serviceId !== serviceId ||
      !states.includes(row.state as ExperimentalServiceState) ||
      (terminal ? row.ownerSessionId !== null : typeof row.ownerSessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(row.ownerSessionId)) ||
      Buffer.byteLength(JSON.stringify(value)) > 2048) throw Error("invalid-service-recovery");
  return { schemaVersion: 1, taskId, serviceId, state: row.state as ExperimentalServiceState, ownerSessionId: row.ownerSessionId as string | null };
}
