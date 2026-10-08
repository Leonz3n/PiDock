/**
 * Renderer view of a task's bound services and the runtime state the Host
 * reports for them ([PiDock 04] #7, [PiDock 05] #10) — the data behind the
 * production 运行 / 日志 tool panels.
 *
 * Every row comes from a real read; nothing here fabricates a service list or
 * a "已停止" state:
 *  - `shell/projectOp {op:"associations"}` names the project that owns the
 *    task, because Host service bindings are stored per project;
 *  - `shell/serviceCatalogOp {op:"taskBindings"}` is the task's real bound
 *    service list (identity, template version, working copy, private keys);
 *  - `shell/serviceCatalogOp {op:"list"}` carries the project templates the
 *    bindings refer to (display name, program, declared ports);
 *  - `shell/taskOp task/serviceStatus` is the Host's own runtime answer. It is
 *    either the installed service-owner inventory state or the task runtime
 *    registry lifecycle; a service the Host does not own answers with its
 *    refusal (e.g. `unknown-service`) which the panel shows verbatim.
 *
 * Parsing is strict: an unexpected shape returns `null` so the panel reports
 * the response as unreadable instead of rendering a partial or invented row.
 */
import { serviceBindingsFromMain, serviceTemplatesFromMain, type ServiceBindingView, type ServiceTemplateView } from "./serviceCatalog";
import { serviceCatalogThroughShell, serviceStatusThroughShell, shellBridge } from "./shellBridge";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const OWNER_STATES = ["stopped", "starting", "running", "stopping", "exited", "unconfirmed"] as const;
const RETAINED_RIGHTS = ["held", "release-uncertain", "released", "unverified"] as const;

export type ServiceOwnerState = (typeof OWNER_STATES)[number];

/** `ServiceOwnerInventory.status()` — the installed service-owner inventory. */
export interface ServiceOwnerStatusView {
  kind: "owner";
  serviceId: string;
  state: ServiceOwnerState;
  ownerSessionId: string | null;
  busy: boolean;
  closing: boolean;
  retainedRights: (typeof RETAINED_RIGHTS)[number] | null;
  /** False means the Host reports state but owns no admitted process driver. */
  executionAvailable: boolean;
}

/** `TaskServiceRuntime` registry status (a service the Host registered itself). */
export interface ServiceRegistryStatusView {
  kind: "registry";
  serviceId: string;
  lifecycle: "stopped" | "running";
  templateVersion: string;
  startedAt?: string;
  stoppedAt?: string;
  exitReason?: string;
  resolvedKeys: string[];
}

export type ServiceStatusView = ServiceOwnerStatusView | ServiceRegistryStatusView;

function ownerStatus(row: Record<string, unknown>, serviceId: string): ServiceOwnerStatusView | null {
  if (Object.keys(row).sort().join(",") !== "busy,closing,executionAvailable,ownerSessionId,retainedRights,serviceId,state") return null;
  if (typeof row["busy"] !== "boolean" || typeof row["closing"] !== "boolean" || typeof row["executionAvailable"] !== "boolean") return null;
  if (!(OWNER_STATES as readonly string[]).includes(String(row["state"]))) return null;
  const ownerSessionId = row["ownerSessionId"];
  if (ownerSessionId !== null && typeof ownerSessionId !== "string") return null;
  const retained = row["retainedRights"];
  if (retained !== null && !(RETAINED_RIGHTS as readonly string[]).includes(String(retained))) return null;
  return { kind: "owner", serviceId, state: row["state"] as ServiceOwnerState,
    ownerSessionId: ownerSessionId as string | null, busy: row["busy"], closing: row["closing"],
    retainedRights: retained as ServiceOwnerStatusView["retainedRights"], executionAvailable: row["executionAvailable"] };
}

function registryStatus(row: Record<string, unknown>, serviceId: string): ServiceRegistryStatusView | null {
  const allowed = ["exitReason", "lifecycle", "resolved", "serviceId", "startedAt", "stoppedAt", "templateVersion"];
  const required = ["lifecycle", "resolved", "serviceId", "templateVersion"];
  if (!Object.keys(row).every((key) => allowed.includes(key)) || !required.every((key) => key in row)) return null;
  if (row["lifecycle"] !== "stopped" && row["lifecycle"] !== "running") return null;
  if (typeof row["templateVersion"] !== "string" || !Array.isArray(row["resolved"])) return null;
  const resolvedKeys: string[] = [];
  for (const entry of row["resolved"]) {
    if (!isRecord(entry) || typeof entry["key"] !== "string") return null;
    resolvedKeys.push(entry["key"]);
  }
  const text = (value: unknown) => (value === undefined ? undefined : typeof value === "string" ? value : null);
  const startedAt = text(row["startedAt"]);
  const stoppedAt = text(row["stoppedAt"]);
  const exitReason = text(row["exitReason"]);
  if (startedAt === null || stoppedAt === null || exitReason === null) return null;
  return { kind: "registry", serviceId, lifecycle: row["lifecycle"], templateVersion: row["templateVersion"],
    resolvedKeys, ...(startedAt !== undefined ? { startedAt } : {}), ...(stoppedAt !== undefined ? { stoppedAt } : {}),
    ...(exitReason !== undefined ? { exitReason } : {}) };
}

/** One `task/serviceStatus` payload, or `null` when it is not the asked-for service. */
export function serviceStatusFromHost(payload: unknown, serviceId: string): ServiceStatusView | null {
  if (!isRecord(payload) || !isRecord(payload["service"])) return null;
  const row = payload["service"];
  if (row["serviceId"] !== serviceId) return null;
  return typeof row["state"] === "string" ? ownerStatus(row, serviceId) : registryStatus(row, serviceId);
}

export interface ServiceLogLine { at: string; line: string }

/** One `task/serviceLog` payload; `null` when the lines are not a real Host answer. */
export function serviceLogFromHost(payload: unknown): ServiceLogLine[] | null {
  if (!isRecord(payload) || !Array.isArray(payload["log"]) || payload["log"].length > 2000) return null;
  const lines: ServiceLogLine[] = [];
  for (const entry of payload["log"]) {
    if (!isRecord(entry) || Object.keys(entry).sort().join(",") !== "at,line" ||
        typeof entry["at"] !== "string" || typeof entry["line"] !== "string") return null;
    lines.push({ at: entry["at"], line: entry["line"] });
  }
  return lines;
}

export interface TaskAssociationView { taskId: string; projectId: string | null; state: string }

/** The task's row in `shell/projectOp {op:"associations"}`; `null` when it is absent or malformed. */
export function taskAssociationFromMain(payload: unknown, taskId: string): TaskAssociationView | null {
  if (!isRecord(payload) || !Array.isArray(payload["tasks"])) return null;
  const row = payload["tasks"].find((entry) => isRecord(entry) && entry["taskId"] === taskId);
  if (row === undefined || !isRecord(row)) return null;
  const { projectId, state } = row;
  if (!["assigned", "unassigned", "needs-repair", "unavailable"].includes(String(state))) return null;
  if (projectId !== null && typeof projectId !== "string") return null;
  if (((state === "assigned" || state === "needs-repair") !== (typeof projectId === "string"))) return null;
  return { taskId, projectId, state: String(state) };
}

/**
 * Resolve the project that owns a task. Service bindings live in the project
 * catalog, so a task the user has not confirmed into a project has no bound
 * service list to read — the panel says so instead of listing nothing.
 */
export async function taskProjectIdThroughShell(
  taskId: string,
): Promise<{ ok: true; projectId: string | null } | { ok: false; error: string }> {
  const bridge = shellBridge();
  if (typeof bridge?.projectOp !== "function") return { ok: false, error: "桌面壳项目接口不可用，请重启应用" };
  let result: { ok: boolean; payload?: unknown; error?: string };
  try {
    result = await bridge.projectOp({ op: "associations" });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "任务归属读取失败" };
  }
  if (!result || result.ok !== true) return { ok: false, error: result?.error ?? "任务归属读取失败" };
  const association = taskAssociationFromMain(result.payload, taskId);
  if (!association) return { ok: false, error: "任务归属响应无法解析" };
  return { ok: true, projectId: association.projectId };
}

export interface BoundServiceRow {
  binding: ServiceBindingView;
  /** Project template the binding refers to (display name, program, declared ports). */
  template: ServiceTemplateView | undefined;
  status: ServiceStatusView | undefined;
  /** Real Host refusal / unreadable-response text for this row's status read. */
  statusError: string | undefined;
}

export type TaskServicesLoad =
  | { ok: true; projectId: string | null; rows: BoundServiceRow[]; templatesError: string | undefined }
  | { ok: false; error: string };

/**
 * The task's real bound services plus the Host's own runtime answer for each.
 * `projectId === null` means the user has not confirmed the task into a
 * project, so the Host stores no binding under it — not that the task has no
 * services. A missing project template leaves the row identity-only instead of
 * inventing a name or a port.
 */
export async function loadTaskServices(taskId: string): Promise<TaskServicesLoad> {
  const association = await taskProjectIdThroughShell(taskId);
  if (!association.ok) return { ok: false, error: association.error };
  if (association.projectId === null) return { ok: true, projectId: null, rows: [], templatesError: undefined };
  const projectId = association.projectId;
  const [bindingsResult, templatesResult] = await Promise.all([
    serviceCatalogThroughShell({ op: "taskBindings", projectId, taskId }),
    serviceCatalogThroughShell({ op: "list", projectId }),
  ]);
  const templates = templatesResult.ok ? serviceTemplatesFromMain(templatesResult.payload, projectId) : null;
  const templatesError = templates === null ? shellFailure(templatesResult, "读取项目服务配方失败") : undefined;
  if (!bindingsResult.ok) return { ok: false, error: shellFailure(bindingsResult, "读取任务服务绑定失败") };
  const bindings = serviceBindingsFromMain(bindingsResult.payload, taskId);
  if (!bindings) return { ok: false, error: "Host 任务服务绑定响应无法解析" };
  const rows = await Promise.all(bindings.map(async (binding): Promise<BoundServiceRow> => {
    const template = templates?.find((row) => row.serviceId === binding.serviceId);
    const result = await serviceStatusThroughShell({ taskId, serviceId: binding.serviceId });
    if (!result.ok) return { binding, template, status: undefined, statusError: shellFailure(result, "读取服务状态失败") };
    const status = serviceStatusFromHost(result.payload, binding.serviceId);
    return status
      ? { binding, template, status, statusError: undefined }
      : { binding, template, status: undefined, statusError: "Host 服务状态响应无法解析" };
  }));
  return { ok: true, projectId, rows, templatesError };
}

/**
 * `Host` refusal text for a panel row, never a fabricated state. A rejected
 * `ipcRenderer.invoke` arrives wrapped in Electron's own plumbing prefix; that
 * wrapper is stripped so the panel shows the Host's reason, not the channel.
 */
const INVOKE_WRAPPER = /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/;

export function shellFailure(result: { error?: string }, fallback: string): string {
  const text = typeof result.error === "string" ? result.error.replace(INVOKE_WRAPPER, "").trim() : "";
  return text.length > 0 ? text : fallback;
}
