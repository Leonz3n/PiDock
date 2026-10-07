import { serviceExecutionCheckpoint, type ServiceExecutionCheckpoint } from "./service-execution-checkpoint.js";
import { experimentalShutdownReport, type ExperimentalShutdownReport } from "./host-shutdown-report.js";

export interface ServiceOwnerContract {
  serviceId: string; templateVersion: number; configRevision: string;
  program: string; args: string[]; cwd: string;
  programIdentity: string; cwdIdentity: string; envRevision: string;
}
export interface ServiceOwnerCatalogSnapshot {
  workspaceId: string; taskId: string; projectId: string | null; taskIdentity: string;
  catalogRevision: string; entries: ServiceOwnerContract[];
}
export interface ServiceOwnerBootstrap extends ServiceOwnerCatalogSnapshot {
  kind: "service-owner-bootstrap"; instanceId: string; epoch: string;
}
export interface ServiceOwnerCompletion {
  workspaceId: string; taskId: string; instanceId: string; epoch: string; catalogRevision: string;
  entries: ServiceExecutionCheckpoint[]; report: ExperimentalShutdownReport;
}
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
function object(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== keys) throw Error("invalid-service-owner-binding");
  return value as Record<string, unknown>;
}
function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw Error("invalid-service-owner-binding");
  return value;
}
/** This parser is only called on the actual main-owned child/parent port, never generic task RPC. */
export function serviceOwnerBootstrap(value: unknown, workspaceId: string, taskId: string): ServiceOwnerBootstrap {
  if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) throw Error("invalid-service-owner-binding");
  const row = object(value, "catalogRevision,entries,epoch,instanceId,kind,projectId,taskId,taskIdentity,workspaceId");
  if (row.kind !== "service-owner-bootstrap" || row.workspaceId !== workspaceId || row.taskId !== taskId || !ID.test(taskId) || !ID.test(workspaceId) ||
      (row.projectId !== null && (typeof row.projectId !== "string" || !/^[a-f0-9-]{36}$/i.test(row.projectId))) || !Array.isArray(row.entries) || row.entries.length > 100) throw Error("invalid-service-owner-binding");
  const entries = row.entries.map((value): ServiceOwnerContract => {
    const entry = object(value, "args,configRevision,cwd,cwdIdentity,envRevision,program,programIdentity,serviceId,templateVersion");
    if (!Number.isSafeInteger(entry.templateVersion) || Number(entry.templateVersion) < 1 ||
        !Array.isArray(entry.args) || entry.args.length > 40 || entry.args.some((arg) => typeof arg !== "string" || arg.length > 512 || /[\0\r\n]/.test(arg)) ||
        typeof entry.program !== "string" || typeof entry.cwd !== "string" || [entry.program, entry.cwd].some((path) => !path || path.length > 4096 || path.includes("\0"))) throw Error("invalid-service-owner-binding");
    return { serviceId: text(entry.serviceId, ID), templateVersion: Number(entry.templateVersion), configRevision: text(entry.configRevision, HASH),
      program: entry.program, args: [...entry.args] as string[], cwd: entry.cwd,
      programIdentity: text(entry.programIdentity, HASH), cwdIdentity: text(entry.cwdIdentity, HASH), envRevision: text(entry.envRevision, HASH) };
  });
  if (new Set(entries.map((entry) => entry.serviceId)).size !== entries.length || row.projectId === null && entries.length) throw Error("invalid-service-owner-binding");
  return { kind: "service-owner-bootstrap", workspaceId, taskId, projectId: row.projectId as string | null,
    instanceId: text(row.instanceId, UUID), epoch: text(row.epoch, UUID), taskIdentity: text(row.taskIdentity, HASH), catalogRevision: text(row.catalogRevision, HASH), entries };
}
export function serviceOwnerCompletion(value: unknown, scope: ServiceOwnerBootstrap): ServiceOwnerCompletion {
  if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) throw Error("invalid-service-owner-binding");
  const row = object(value, "catalogRevision,entries,epoch,instanceId,report,taskId,workspaceId");
  for (const key of ["workspaceId", "taskId", "instanceId", "epoch", "catalogRevision"] as const) if (row[key] !== scope[key]) throw Error("invalid-service-owner-binding");
  if (!Array.isArray(row.entries) || row.entries.length !== scope.entries.length) throw Error("invalid-service-owner-binding");
  const entries = row.entries.map((entry, index) => serviceExecutionCheckpoint(entry, scope.taskId, scope.entries[index].serviceId));
  if (entries.some((entry) => entry.ownerSessionId !== null || entry.state !== "stopped" && entry.state !== "exited")) throw Error("invalid-service-owner-binding");
  return { workspaceId: scope.workspaceId, taskId: scope.taskId, instanceId: scope.instanceId, epoch: scope.epoch, catalogRevision: scope.catalogRevision,
    entries, report: experimentalShutdownReport(row.report, scope.taskId, scope.epoch) };
}
