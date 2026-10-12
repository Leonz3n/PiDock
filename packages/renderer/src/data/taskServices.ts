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
import { serviceBindingsFromMain, serviceOwnerRebindFromMain, serviceTemplatesFromMain, type ServiceBindingView, type ServiceOwnerRebindView, type ServiceTemplateView } from "./serviceCatalog";
import { serviceCatalogThroughShell, serviceRunRecordsThroughShell, serviceStatusThroughShell, shellBridge } from "./shellBridge";
import type { ServiceBuildFreshness, ServiceCodeState } from "./types";

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

/** One platform row of the Host's launch-verification read ([PiDock 04] #7 box 7). */
export interface PlatformVerificationRowView {
  platform: string;
  /** True only for a real launch observation made on the platform the Host is answering from. */
  verified: boolean;
  nodeVersion?: string;
  program?: string;
  startedAt?: string;
  stopped?: boolean;
  stoppedAt?: string;
  /** Why this platform is not verified; present on every not-verified row. */
  reason?: string;
}

/**
 * The Host's per-platform verification read: the platform the Host itself runs
 * on plus one row per release target. A platform with no real verification is
 * listed with `verified: false` and its reason, so the UI never has to infer a
 * pass from an absent row.
 */
export interface LaunchVerificationView {
  platform: string;
  rows: PlatformVerificationRowView[];
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
  /** `catalog` only executes; a `ui` registration is display data. */
  launchSource?: "catalog" | "ui";
  /** Process liveness is `lifecycle`; no reachability probe is ever reported here. */
  health?: "not-probed";
  /**
   * Who last started or stopped this service ([PiDock 04] #7 box 5): `human`
   * is the explicit UI action (with main's own label), `agent` is the gated
   * Agent path (with the session it was decided for). Absent means the Host
   * recorded no control (an older Host, or a service never started through
   * either path); the row then says so instead of guessing an author.
   */
  lastControl?: { action: "start" | "stop"; actor: "human" | "agent"; label: string };
  /**
   * The platform this Host really runs on and one row per platform
   * ([PiDock 04] #7 box 7). Absent means this Host predates the record; the row
   * then states that no platform was verified instead of assuming one was.
   */
  launchVerification?: LaunchVerificationView;
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
  // The Host's public projection (`service-public.ts`) is an allowlist:
  // `lifecycle` is process liveness only, `health` stays `not-probed` (no
  // reachability probe is reported as health) and `launchSource` says whether
  // the launch came from main's trusted catalog or is display-only.
  const allowed = ["exitReason", "health", "lastControl", "launchSource", "launchVerification", "lifecycle", "resolved", "serviceId", "startedAt", "stoppedAt", "templateVersion"];
  const required = ["lifecycle", "resolved", "serviceId", "templateVersion"];
  if (!Object.keys(row).every((key) => allowed.includes(key)) || !required.every((key) => key in row)) return null;
  if (row["lifecycle"] !== "stopped" && row["lifecycle"] !== "running") return null;
  if (row["health"] !== undefined && row["health"] !== "not-probed") return null;
  if (row["launchSource"] !== undefined && row["launchSource"] !== "catalog" && row["launchSource"] !== "ui") return null;
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
  const lastControl = lastControlFact(row["lastControl"]);
  if (lastControl === null) return null;
  const launchVerification = launchVerificationFact(row["launchVerification"]);
  if (launchVerification === null) return null;
  return { kind: "registry", serviceId, lifecycle: row["lifecycle"], templateVersion: row["templateVersion"],
    resolvedKeys, ...(startedAt !== undefined ? { startedAt } : {}), ...(stoppedAt !== undefined ? { stoppedAt } : {}),
    ...(exitReason !== undefined ? { exitReason } : {}),
    ...(row["launchSource"] !== undefined ? { launchSource: row["launchSource"] as "catalog" | "ui" } : {}),
    ...(row["health"] !== undefined ? { health: "not-probed" as const } : {}),
    ...(lastControl !== undefined ? { lastControl } : {}),
    ...(launchVerification !== undefined ? { launchVerification } : {}) };
}

/** `<platform>-<arch>`: the only shape the Host may label a platform with. */
const PLATFORM_LABEL = /^[a-z0-9]+-[a-z0-9]+$/;
/**
 * The row keys the Host's projection may carry; anything else makes the read
 * unreadable. Exported so the seam test (`taskLaunchVerificationSeam.test.ts`)
 * can pin the REAL `publicServiceStatus` rows against this list: a key the Host
 * adds must be added here too, or every status row would silently go blank.
 */
export const VERIFICATION_ROW_KEYS = ["platform", "verified", "reason", "nodeVersion", "program", "startedAt", "stopped", "stoppedAt"];
/** `undefined` for an absent field, `null` for a present-but-unusable one. */
const optionalText = (value: unknown): string | undefined | null =>
  value === undefined ? undefined : typeof value === "string" && value.length > 0 && value.length <= 2000 ? value : null;

/**
 * The Host's per-platform launch-verification read ([PiDock 04] #7 box 7), read
 * strictly because the whole point is that "verified" is NOT assumed:
 *
 * - a `verified` row is accepted only when its platform is the platform the
 *   Host itself declares it is answering from. A payload claiming a pass on
 *   any other platform is contradictory, so the row is unreadable (`null`) -
 *   the panel then reports the response as unreadable rather than showing a
 *   pass the Host cannot have observed;
 * - a `verified` row must carry the launch facts that justify it;
 * - a not-verified row must name its reason, so the UI can never render an
 *   unverified platform as verified and never has to invent wording for it;
 * - duplicate platform rows are corrupt, not last-wins (a second row could only
 *   be there to replace a `false` with a `true`).
 */
function launchVerificationFact(value: unknown): LaunchVerificationView | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "platform,rows") return null;
  const platform = value["platform"];
  if (typeof platform !== "string" || !PLATFORM_LABEL.test(platform)) return null;
  const rows = value["rows"];
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 12) return null;
  const parsed: PlatformVerificationRowView[] = [];
  for (const entry of rows) {
    if (!isRecord(entry)) return null;
    if (Object.keys(entry).some((name) => !VERIFICATION_ROW_KEYS.includes(name))) return null;
    const name = entry["platform"];
    const verified = entry["verified"];
    if (typeof name !== "string" || !PLATFORM_LABEL.test(name) || typeof verified !== "boolean") return null;
    if (parsed.some((rowView) => rowView.platform === name)) return null;
    const nodeVersion = optionalText(entry["nodeVersion"]);
    const program = optionalText(entry["program"]);
    const rowStartedAt = optionalText(entry["startedAt"]);
    const rowStoppedAt = optionalText(entry["stoppedAt"]);
    const reason = optionalText(entry["reason"]);
    if (nodeVersion === null || program === null || rowStartedAt === null || rowStoppedAt === null || reason === null) return null;
    const stopped = entry["stopped"];
    if (stopped !== undefined && typeof stopped !== "boolean") return null;
    if (verified) {
      // A pass is only readable for the platform the Host says it runs on, and
      // only with the observed launch facts attached.
      if (name !== platform) return null;
      if (rowStartedAt === undefined || program === undefined || nodeVersion === undefined || stopped === undefined) return null;
    } else if (reason === undefined) {
      return null;
    }
    parsed.push({ platform: name, verified,
      ...(nodeVersion !== undefined ? { nodeVersion } : {}), ...(program !== undefined ? { program } : {}),
      ...(rowStartedAt !== undefined ? { startedAt: rowStartedAt } : {}), ...(stopped !== undefined ? { stopped } : {}),
      ...(rowStoppedAt !== undefined ? { stoppedAt: rowStoppedAt } : {}), ...(reason !== undefined ? { reason } : {}) });
  }
  return { platform, rows: parsed };
}

/**
 * The control author of one status row, read strictly: an unknown actor, an
 * unknown action or a missing label makes the row unreadable (`null`) instead
 * of being shown as if the user had clicked it. `undefined`/`null` (the Host's
 * "no control recorded") is the one accepted answer without an author.
 */
function lastControlFact(value: unknown): ServiceRegistryStatusView["lastControl"] | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "action,actor,label") return null;
  if (value["action"] !== "start" && value["action"] !== "stop") return null;
  if (value["actor"] !== "human" && value["actor"] !== "agent") return null;
  if (typeof value["label"] !== "string" || value["label"].length === 0 || value["label"].length > 200) return null;
  return { action: value["action"], actor: value["actor"], label: value["label"] };
}

/** One `task/serviceStatus` payload, or `null` when it is not the asked-for service. */
export function serviceStatusFromHost(payload: unknown, serviceId: string): ServiceStatusView | null {
  if (!isRecord(payload) || !isRecord(payload["service"])) return null;
  const row = payload["service"];
  if (row["serviceId"] !== serviceId) return null;
  return typeof row["state"] === "string" ? ownerStatus(row, serviceId) : registryStatus(row, serviceId);
}

const RUN_CODE_STATES = ["committed-clean", "uncommitted", "unknown"] as const;
const RUN_BUILD_FRESHNESS = ["fresh", "stale-build", "uncommitted-code", "unknown"] as const;
/** The keys a verification entry may carry; the entry itself is validated (so a
 * Host shape change fails the read) but not displayed here: this slice shows the
 * run's own facts, and linkage/readiness results are box 4's surface. */
const RUN_VERIFICATION_KEYS = ["kind", "detail", "ok", "at"];
const RUN_CODE_KEYS = ["kind", "commit", "note"];

/**
 * The top-level keys a `task/serviceRunRecords` row may carry. Exported so the
 * seam test can pin the REAL Host `RunRecord` against this list (mirroring
 * `VERIFICATION_ROW_KEYS`): a Host key this parser does not accept must fail
 * there, not silently blank every run record in the panel.
 */
export const RUN_RECORD_KEYS = [
  "runId", "taskId", "serviceId", "instanceId", "templateVersion", "codeState",
  "buildFreshness", "ports", "portsSource", "processIdentity", "logRef",
  "protocolArtifact", "startedAt", "endedAt", "exit", "verifications",
] as const;

/**
 * One real run record for a service ([PiDock 05] #10 box 6), as the Host's
 * `task/serviceRunRecords` reports it: code/build state, the port list with its
 * `declared` vs `observed` origin, the real process identity, the per-run log
 * entry and the exit reason once the run ended.
 */
export interface ServiceRunRecordView {
  runId: string;
  templateVersion: string;
  codeState: ServiceCodeState;
  codeCommit?: string;
  buildFreshness: ServiceBuildFreshness;
  ports: number[];
  /** Absent means the Host did not say, so the panel must not claim either. */
  portsSource?: "declared" | "observed";
  processIdentity: { owner: "agent" | "human"; pid: number; startedAt: string };
  logRef: string;
  startedAt: string;
  endedAt?: string;
  exitReason?: string;
}

/** Length-bounded text: `undefined` when absent, `null` when present-but-unusable. */
function boundedText(value: unknown, max: number): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

/**
 * One run record, read strictly: an unknown field, a missing process identity, a
 * wrong code/build token or a malformed port makes the WHOLE row unreadable
 * (`null`) instead of a half-row. Nothing here can invent a pid, a port label or
 * a code state — a real run whose pid/start time nobody observed must not read
 * as one that was.
 */
function runRecordFromHost(value: unknown): { serviceId: string; record: ServiceRunRecordView } | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => !(RUN_RECORD_KEYS as readonly string[]).includes(key))) return null;
  const runId = value["runId"];
  const serviceId = value["serviceId"];
  const templateVersion = value["templateVersion"];
  if (typeof runId !== "string" || runId.length === 0 || runId.length > 200) return null;
  if (typeof serviceId !== "string" || serviceId.length === 0) return null;
  if (typeof templateVersion !== "string" || templateVersion.length > 200) return null;
  const code = value["codeState"];
  if (!isRecord(code) || Object.keys(code).some((key) => !RUN_CODE_KEYS.includes(key))) return null;
  const codeState = RUN_CODE_STATES.find((candidate) => candidate === code["kind"]);
  if (codeState === undefined) return null;
  const codeCommit = boundedText(code["commit"], 200);
  if (codeCommit === null) return null;
  const buildFreshness = RUN_BUILD_FRESHNESS.find((candidate) => candidate === value["buildFreshness"]);
  if (buildFreshness === undefined) return null;
  const rawPorts = value["ports"];
  if (!Array.isArray(rawPorts) || rawPorts.length > 64) return null;
  const ports: number[] = [];
  for (const port of rawPorts) {
    if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) return null;
    ports.push(port);
  }
  const source = value["portsSource"];
  if (source !== undefined && source !== "declared" && source !== "observed") return null;
  const process = value["processIdentity"];
  if (!isRecord(process) || Object.keys(process).sort().join(",") !== "owner,pid,startedAt") return null;
  const owner = process["owner"];
  const pid = process["pid"];
  const pidStartedAt = process["startedAt"];
  if (owner !== "agent" && owner !== "human") return null;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof pidStartedAt !== "string" || pidStartedAt.length === 0 || pidStartedAt.length > 200) return null;
  const logRef = value["logRef"];
  const startedAt = value["startedAt"];
  if (typeof logRef !== "string" || logRef.length === 0 || logRef.length > 4000) return null;
  if (typeof startedAt !== "string" || startedAt.length === 0 || startedAt.length > 200) return null;
  const endedAt = boundedText(value["endedAt"], 200);
  if (endedAt === null) return null;
  const exit = value["exit"];
  let exitReason: string | undefined;
  if (exit !== undefined) {
    if (!isRecord(exit) || Object.keys(exit).sort().join(",") !== "reason") return null;
    const reason = exit["reason"];
    if (typeof reason !== "string" || reason.length === 0 || reason.length > 2000) return null;
    exitReason = reason;
  }
  const rawVerifications = value["verifications"];
  if (!Array.isArray(rawVerifications) || rawVerifications.length > 64) return null;
  for (const entry of rawVerifications) {
    if (!isRecord(entry) || Object.keys(entry).some((key) => !RUN_VERIFICATION_KEYS.includes(key))) return null;
    if (typeof entry["kind"] !== "string" || typeof entry["detail"] !== "string" || typeof entry["ok"] !== "boolean") return null;
  }
  const protocolArtifact = value["protocolArtifact"];
  if (protocolArtifact !== undefined && (!isRecord(protocolArtifact) || Object.keys(protocolArtifact).sort().join(",") !== "version")) return null;
  return {
    serviceId,
    record: {
      runId, templateVersion, codeState,
      ...(codeCommit !== undefined ? { codeCommit } : {}),
      buildFreshness, ports,
      ...(source !== undefined ? { portsSource: source } : {}),
      processIdentity: { owner, pid, startedAt: pidStartedAt },
      logRef, startedAt,
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(exitReason !== undefined ? { exitReason } : {}),
    },
  };
}

/**
 * Every run record in one `task/serviceRunRecords` payload, latest per service
 * (`TaskServiceTopology.runs()` is push order). `null` when the payload is not a
 * real Host answer: one malformed row fails the WHOLE read rather than being
 * skipped, so a bad record can never hide the row that would have named it. An
 * empty map means the Host answered and has no record for that service — the
 * panel must say so by name, never imply a run.
 */
export function runRecordsFromHost(payload: unknown): Map<string, ServiceRunRecordView> | null {
  if (!isRecord(payload) || !Array.isArray(payload["records"])) return null;
  const rows = payload["records"];
  if (rows.length > 1000) return null;
  const byService = new Map<string, ServiceRunRecordView>();
  for (const row of rows) {
    const parsed = runRecordFromHost(row);
    if (parsed === null) return null;
    byService.set(parsed.serviceId, parsed.record);
  }
  return byService;
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
 * service list to read — the panel says so instead of listing nothing. The
 * association state is returned alongside so `unavailable` (the Host could not
 * read a project) stays distinct from `unassigned` (no confirmed project).
 */
export async function taskProjectIdThroughShell(
  taskId: string,
): Promise<{ ok: true; projectId: string | null; state: string } | { ok: false; error: string }> {
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
  return { ok: true, projectId: association.projectId, state: association.state };
}

export interface BoundServiceRow {
  binding: ServiceBindingView;
  /** Project template the binding refers to (display name, program, declared ports). */
  template: ServiceTemplateView | undefined;
  status: ServiceStatusView | undefined;
  /** Real Host refusal / unreadable-response text for this row's status read. */
  statusError: string | undefined;
  /**
   * The Host's latest real run record for this service ([PiDock 05] #10 box 6),
   * when `task/serviceRunRecords` answered one. `undefined` alone means the Host
   * answered and has no record; the panel then names that state rather than
   * implying a run.
   */
  runRecord: ServiceRunRecordView | undefined;
  /** Names why the run-record read could not be shown (refusal / unreadable). */
  runRecordError: string | undefined;
}

export type TaskServicesLoad =
  | { ok: true; projectId: string | null; associationState: string; rows: BoundServiceRow[]; templatesError: string | undefined }
  | { ok: false; error: string };

/**
 * The task's real bound services plus the Host's own runtime answer for each.
 * `projectId === null` means the Host stores no binding under the task — either
 * because the user has not confirmed one (`unassigned`) or because the Host
 * could not read the association (`unavailable`); `associationState` keeps the
 * two apart. `projectId === null` never means the task has no services. A
 * missing project template leaves the row identity-only instead of inventing a
 * name or a port.
 *
 * Each row also carries the Host's real run record read once through
 * `task/serviceRunRecords`; a failed or unreadable read is named per row instead
 * of degrading to "no record".
 */
export async function loadTaskServices(taskId: string): Promise<TaskServicesLoad> {
  const association = await taskProjectIdThroughShell(taskId);
  if (!association.ok) return { ok: false, error: association.error };
  if (association.projectId === null) return { ok: true, projectId: null, associationState: association.state, rows: [], templatesError: undefined };
  const projectId = association.projectId;
  const [bindingsResult, templatesResult, runRecordsResult] = await Promise.all([
    serviceCatalogThroughShell({ op: "taskBindings", projectId, taskId }),
    serviceCatalogThroughShell({ op: "list", projectId }),
    serviceRunRecordsThroughShell(taskId),
  ]);
  const templates = templatesResult.ok ? serviceTemplatesFromMain(templatesResult.payload, projectId) : null;
  const templatesError = templates === null ? shellFailure(templatesResult, "读取项目服务配方失败") : undefined;
  if (!bindingsResult.ok) return { ok: false, error: shellFailure(bindingsResult, "读取任务服务绑定失败") };
  const bindings = serviceBindingsFromMain(bindingsResult.payload, taskId);
  if (!bindings) return { ok: false, error: "Host 任务服务绑定响应无法解析" };
  // A refused read and an unreadable payload are kept apart: one is the Host's
  // own refusal text, the other a named parse refusal. Both mean "the run record
  // could not be shown", never "there is no run".
  const runRecords = runRecordsResult.ok ? runRecordsFromHost(runRecordsResult.payload) : null;
  const runRecordsError = runRecordsResult.ok === false
    ? shellFailure(runRecordsResult, "读取运行记录失败")
    : runRecords === null
      ? "Host 运行记录响应无法解析"
      : undefined;
  const rows = await Promise.all(bindings.map(async (binding): Promise<BoundServiceRow> => {
    const template = templates?.find((row) => row.serviceId === binding.serviceId);
    const result = await serviceStatusThroughShell({ taskId, serviceId: binding.serviceId });
    const status = result.ok ? (serviceStatusFromHost(result.payload, binding.serviceId) ?? undefined) : undefined;
    return {
      binding, template,
      status,
      statusError: result.ok ? (status ? undefined : "Host 服务状态响应无法解析") : shellFailure(result, "读取服务状态失败"),
      runRecord: runRecords?.get(binding.serviceId),
      runRecordError: runRecordsError,
    };
  }));
  return { ok: true, projectId, associationState: association.state, rows, templatesError };
}

/** Result of one start/stop of a task-bound service through the production path. */
export type BoundServiceRunResult = { ok: true } | { ok: false; error: string };

/**
 * Start/stop one task-bound service through the production path ([PiDock 04]
 * #7): `shell/serviceCatalogOp {op:"runTaskService"}`. Main resolves the
 * trusted persisted catalog launch (program, pinned argv, cwd, private
 * values) itself, registers the descriptor on the task Host and controls it
 * through the Host's gated `task/controlService`. The renderer names only the
 * project, task, service and action - it can never supply a program, a cwd or
 * an env value. The main-built `service-catalog` origin keeps this the
 * attested human-UI path; Agent control keeps going through the session
 * gate/tier path Host-side.
 */
export async function runBoundTaskServiceThroughShell(input: {
  projectId: string;
  taskId: string;
  serviceId: string;
  action: "start" | "stop";
}): Promise<BoundServiceRunResult> {
  const result = await serviceCatalogThroughShell({
    op: "runTaskService", projectId: input.projectId, taskId: input.taskId, serviceId: input.serviceId, action: input.action,
  });
  if (!result.ok) return { ok: false, error: shellFailure(result, "服务启停失败，请重试") };
  return { ok: true };
}

/**
 * Restore one task's service start/stop channel after a shared-template write
 * revoked it ([PiDock 04] #7 slice): `shell/serviceCatalogOp
 * {op:"rebindServiceOwner"}`. Two-step exactly like the catalog writes - the
 * first call (`confirm:false`) only reports main's real state and the named
 * services whose owner contract this re-bind changes; only the confirmed call
 * replaces the fenced owner binding. Nothing is started, stopped or restarted
 * by either step, and the page names only the project, the task and whether it
 * confirms.
 */
export async function rebindTaskServiceOwnerThroughShell(input: {
  projectId: string;
  taskId: string;
  confirm: boolean;
}): Promise<{ ok: true; view: ServiceOwnerRebindView } | { ok: false; error: string }> {
  const result = await serviceCatalogThroughShell({
    op: "rebindServiceOwner", projectId: input.projectId, taskId: input.taskId, confirm: input.confirm,
  });
  if (!result.ok) return { ok: false, error: shellFailure(result, "重新绑定服务所有者失败，请重试") };
  const view = serviceOwnerRebindFromMain(result.payload, { taskId: input.taskId, projectId: input.projectId });
  return view ? { ok: true, view } : { ok: false, error: "重新绑定回执无法核对，请刷新核对" };
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
