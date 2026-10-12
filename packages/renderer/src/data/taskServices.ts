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
 *  - `shell/serviceCatalogOp {op:"list", environmentId}` carries the templates
 *    the bindings refer to (display name, program, declared ports) — one read
 *    per environment a binding really selected, because the shared template is
 *    edited per environment;
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

/**
 * The named states of one service's declared 健康检查 ([PiDock 04] #7 box 5),
 * exactly as the Host reports them. `healthy` is the only state that reads as a
 * pass: `not-probed` means nothing was dialled (and says why), `undeclared`
 * means the pinned revision declares no check at all. A probe failure is a
 * statement about the declared TARGET, never about the process - the row keeps
 * `lifecycle` for that.
 */
export const SERVICE_HEALTH_STATES = ["healthy", "unhealthy", "not-probed", "undeclared"] as const;
export type ServiceHealthStateView = (typeof SERVICE_HEALTH_STATES)[number];

/** The check kinds the Host may declare (`service-config.ts`'s `ServiceHealthKind`). */
export const SERVICE_HEALTH_KINDS = ["http", "tcp", "grpc"] as const;

/**
 * One health observation as the panel reads it: the named state plus the facts
 * the probe really observed. `elapsedMs`/`boundMs` are present IF AND ONLY IF a
 * connection was really attempted, so an unprobed row can never carry a
 * duration that would imply a probe ran.
 */
export interface ServiceHealthView {
  state: ServiceHealthStateView;
  kind?: (typeof SERVICE_HEALTH_KINDS)[number];
  target?: string;
  statusCode?: number;
  elapsedMs?: number;
  boundMs?: number;
  /** Why this is not a pass; the Host names it on every `unhealthy`/`not-probed` row. */
  reason?: string;
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
  /**
   * The observed 健康检查 of this service ([PiDock 04] #7 box 5); `lifecycle`
   * stays process liveness. Absent means this Host predates the field, not that
   * the service was healthy.
   */
  health?: ServiceHealthView;
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
  const allowed = ["exitReason", "health", "healthDetail", "lastControl", "launchSource", "launchVerification", "lifecycle", "resolved", "serviceId", "startedAt", "stoppedAt", "templateVersion"];
  const required = ["lifecycle", "resolved", "serviceId", "templateVersion"];
  if (!Object.keys(row).every((key) => allowed.includes(key)) || !required.every((key) => key in row)) return null;
  if (row["lifecycle"] !== "stopped" && row["lifecycle"] !== "running") return null;
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
  const health = healthFact(row["health"], row["healthDetail"]);
  if (health === null) return null;
  const lastControl = lastControlFact(row["lastControl"]);
  if (lastControl === null) return null;
  const launchVerification = launchVerificationFact(row["launchVerification"]);
  if (launchVerification === null) return null;
  return { kind: "registry", serviceId, lifecycle: row["lifecycle"], templateVersion: row["templateVersion"],
    resolvedKeys, ...(startedAt !== undefined ? { startedAt } : {}), ...(stoppedAt !== undefined ? { stoppedAt } : {}),
    ...(exitReason !== undefined ? { exitReason } : {}),
    ...(row["launchSource"] !== undefined ? { launchSource: row["launchSource"] as "catalog" | "ui" } : {}),
    ...(health !== undefined ? { health } : {}),
    ...(lastControl !== undefined ? { lastControl } : {}),
    ...(launchVerification !== undefined ? { launchVerification } : {}) };
}

/** The keys the Host's health DETAIL may carry; anything else makes the read unreadable. */
const HEALTH_DETAIL_KEYS = ["kind", "target", "statusCode", "elapsedMs", "boundMs", "reason"];
/** A real millisecond count: a bounded whole number of ms, never negative. */
const durationFact = (value: unknown): number | undefined | null =>
  value === undefined ? undefined : typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 60_000 ? value : null;

/**
 * The Host's health observation ([PiDock 04] #7 box 5), read strictly because
 * the whole point is that a pass is NOT assumed:
 *
 * - the state must be one of the four the Host can produce; an unknown state
 *   (`green`) makes the row unreadable instead of being shown as a pass;
 * - `healthy`/`unhealthy` must carry the real attempt's duration and bound (a
 *   pass with no observed attempt is not a pass), and a `healthy` http row must
 *   carry a 2xx of the declared kind;
 * - `not-probed`/`undeclared` must NOT carry a duration or a status code: those
 *   rows say nothing was dialled, and a duration on one would imply it was;
 * - `unhealthy`/`not-probed` must name their reason, and `undeclared` must not
 *   claim a kind or a target it never had;
 * - the detail is only readable together with its state (a detail with no state
 *   is a fact nobody can attribute).
 */
function healthFact(value: unknown, detail: unknown): ServiceHealthView | undefined | null {
  if (value === undefined) return detail === undefined ? undefined : null;
  if (!(SERVICE_HEALTH_STATES as readonly string[]).includes(String(value))) return null;
  const state = value as ServiceHealthStateView;
  if (detail === undefined) return state === "healthy" || state === "unhealthy" ? null : { state };
  if (!isRecord(detail) || Object.keys(detail).some((key) => !HEALTH_DETAIL_KEYS.includes(key))) return null;
  const kind = detail["kind"];
  if (kind !== undefined && !(SERVICE_HEALTH_KINDS as readonly string[]).includes(String(kind))) return null;
  const target = optionalText(detail["target"]);
  const reason = optionalText(detail["reason"]);
  const statusCode = detail["statusCode"];
  const elapsedMs = durationFact(detail["elapsedMs"]);
  const boundMs = durationFact(detail["boundMs"]);
  if (target === null || reason === null || elapsedMs === null || boundMs === null) return null;
  if (statusCode !== undefined && (typeof statusCode !== "number" || !Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599)) return null;
  if (statusCode !== undefined && kind !== "http") return null;
  const attempted = elapsedMs !== undefined && boundMs !== undefined;
  if ((state === "healthy" || state === "unhealthy") && !attempted) return null;
  if ((state === "not-probed" || state === "undeclared") && (elapsedMs !== undefined || boundMs !== undefined || statusCode !== undefined)) return null;
  if (state === "healthy" && statusCode !== undefined && (statusCode < 200 || statusCode >= 300)) return null;
  if ((state === "unhealthy" || state === "not-probed") && reason === undefined) return null;
  if (state === "undeclared" && (kind !== undefined || target !== undefined)) return null;
  return { state, ...(kind === undefined ? {} : { kind: kind as ServiceHealthView["kind"] }), ...(target === undefined ? {} : { target }),
    ...(statusCode === undefined ? {} : { statusCode }), ...(elapsedMs === undefined ? {} : { elapsedMs }),
    ...(boundMs === undefined ? {} : { boundMs }), ...(reason === undefined ? {} : { reason }) };
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
  /**
   * Real per-run observations ([PiDock 05] #10 box 4): each entry is a real
   * connect the Host made (listening / linkage / remote reachability). An empty
   * list means nobody observed anything, which the panel names 未探测 instead of
   * leaving the field blank.
   */
  verifications: { kind: string; detail: string; ok: boolean }[];
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
function runRecordFromHost(value: unknown, taskId: string): { serviceId: string; record: ServiceRunRecordView } | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => !(RUN_RECORD_KEYS as readonly string[]).includes(key))) return null;
  const runId = value["runId"];
  const serviceId = value["serviceId"];
  const templateVersion = value["templateVersion"];
  if (typeof runId !== "string" || runId.length === 0 || runId.length > 200) return null;
  if (typeof serviceId !== "string" || serviceId.length === 0) return null;
  if (value["taskId"] !== taskId) return null;
  if (typeof templateVersion !== "string" || templateVersion.length > 200) return null;
  const code = value["codeState"];
  if (!isRecord(code) || Object.keys(code).some((key) => !RUN_CODE_KEYS.includes(key))) return null;
  const codeState = RUN_CODE_STATES.find((candidate) => candidate === code["kind"]);
  if (codeState === undefined) return null;
  if (boundedText(code["note"], 2000) == null) return null;
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
  if (value["instanceId"] !== `${taskId}/${serviceId}${ports[0] === undefined ? "" : `@${ports[0]}`}`) return null;
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
  const verifications: ServiceRunRecordView["verifications"] = [];
  for (const entry of rawVerifications) {
    if (!isRecord(entry) || Object.keys(entry).some((key) => !RUN_VERIFICATION_KEYS.includes(key))) return null;
    if (entry["kind"] !== "linkage" && entry["kind"] !== "readiness" && entry["kind"] !== "remote-reachability" && entry["kind"] !== "selection-note") return null;
    if (typeof entry["detail"] !== "string" || typeof entry["ok"] !== "boolean" || boundedText(entry["at"], 200) == null) return null;
    verifications.push({ kind: entry["kind"], detail: entry["detail"], ok: entry["ok"] });
  }
  const protocolArtifact = value["protocolArtifact"];
  if (protocolArtifact !== undefined && (!isRecord(protocolArtifact) || Object.keys(protocolArtifact).sort().join(",") !== "version" || boundedText(protocolArtifact["version"], 200) == null)) return null;
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
      verifications,
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
export function runRecordsFromHost(payload: unknown, taskId: string): Map<string, ServiceRunRecordView> | null {
  if (!isRecord(payload) || !Array.isArray(payload["records"])) return null;
  const rows = payload["records"];
  if (rows.length > 1000) return null;
  const byService = new Map<string, ServiceRunRecordView>();
  for (const row of rows) {
    const parsed = runRecordFromHost(row, taskId);
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
  const [bindingsResult, runRecordsResult] = await Promise.all([
    serviceCatalogThroughShell({ op: "taskBindings", projectId, taskId }),
    serviceRunRecordsThroughShell(taskId),
  ]);
  if (!bindingsResult.ok) return { ok: false, error: shellFailure(bindingsResult, "读取任务服务绑定失败") };
  const bindings = serviceBindingsFromMain(bindingsResult.payload, taskId);
  if (!bindings) return { ok: false, error: "Host 任务服务绑定响应无法解析" };
  // One template read per environment this task's bindings selected. The pinned
  // revision lives in one environment, so a single project-wide list could only
  // show another environment's service as if it were this binding's.
  const selectedEnvironments = [...new Set(bindings.map((row) => row.environmentId))];
  const listed = await Promise.all(selectedEnvironments.map((environmentId) =>
    serviceCatalogThroughShell({ op: "list", projectId, environmentId })));
  const templates = new Map<string, ServiceTemplateView>();
  let templatesError: string | undefined;
  listed.forEach((result, index) => {
    const environmentId = selectedEnvironments[index] as string;
    const parsed = result.ok ? serviceTemplatesFromMain(result.payload, projectId, environmentId) : null;
    if (!parsed) { templatesError ??= shellFailure(result, "读取环境服务配方失败"); return; }
    for (const row of parsed) templates.set(`${environmentId}/${row.serviceId}`, row);
  });
  // A refused read and an unreadable payload are kept apart: one is the Host's
  // own refusal text, the other a named parse refusal. Both mean "the run record
  // could not be shown", never "there is no run".
  const runRecords = runRecordsResult.ok ? runRecordsFromHost(runRecordsResult.payload, taskId) : null;
  const runRecordsError = runRecordsResult.ok === false
    ? shellFailure(runRecordsResult, "读取运行记录失败")
    : runRecords === null
      ? "Host 运行记录响应无法解析"
      : undefined;
  const rows = await Promise.all(bindings.map(async (binding): Promise<BoundServiceRow> => {
    const template = templates.get(`${binding.environmentId}/${binding.serviceId}`);
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
 * The group run states the Host's `runServiceGroupStart` can answer with
 * (`host/service-group-run.ts`), mirrored here because the sandboxed renderer
 * cannot import a shell module. Every value is a named state, so 未探测 and each
 * negative stay distinguishable.
 */
export type ServiceGroupStateView =
  | "verified" | "listening" | "not-probed" | "not-listening" | "dependency-unreachable"
  | "verify-failed" | "start-failed" | "refused" | "approval-required" | "not-planned";

export type ServiceGroupUnitStartView = "started" | "start-failed" | "refused" | "approval-required" | "not-started";
export type ServiceGroupUnitListeningView = "listening" | "not-listening" | "not-probed";
export type ServiceGroupStepOutcomeView = "passed" | "dependency-unreachable" | "verify-failed" | "not-probed";

export interface ServiceGroupStepView {
  label: string;
  kind: string;
  targetUnitId: string;
  targetServiceId: string;
  outcome: ServiceGroupStepOutcomeView;
  detail: string;
  address?: { host: string; port: number };
}

export interface ServiceGroupDiagnosticView {
  code: string;
  scope: { unitId?: string; key?: string; port?: number };
  message: string;
  hint?: string;
}

/** One unit's REAL observations in a group run ([PiDock 05] #10 box 4). */
export interface ServiceGroupUnitView {
  unitId: string;
  serviceId: string;
  order?: number;
  start: ServiceGroupUnitStartView;
  /** The real pid read back from the run record this start wrote; absent means nobody read one. */
  pid?: number;
  observedRun: boolean;
  listening: ServiceGroupUnitListeningView;
  /** Carried whenever a real connect was attempted; required by the 已监听 reading. */
  address?: { host: string; port: number };
  /** The Host's own answer to "every linkage step of this unit really passed". */
  linked: boolean;
  steps: ServiceGroupStepView[];
  diagnostics: ServiceGroupDiagnosticView[];
}

/** The Host's whole group run as `task/controlService {group:true}` returns it. */
export interface ServiceGroupRunView {
  state: ServiceGroupStateView;
  groups: string[];
  units: ServiceGroupUnitView[];
  restartScope: { unitId: string; reason: string }[];
  reallocated: { unitId: string; before: number; after: number }[];
  diagnostics: ServiceGroupDiagnosticView[];
}

/**
 * Key allowlists, exported so the seam test can pin the REAL Host result against
 * them (mirroring `RUN_RECORD_KEYS` / `VERIFICATION_ROW_KEYS`): a field the Host
 * adds must be added here, or a real group run would be refused as unreadable
 * instead of silently losing an observation.
 */
export const GROUP_RUN_KEYS = ["state", "groups", "units", "restartScope", "reallocated", "diagnostics"] as const;
export const GROUP_UNIT_KEYS = ["unitId", "serviceId", "order", "start", "pid", "observedRun", "listening", "address", "linked", "steps", "diagnostics"] as const;
export const GROUP_STEP_KEYS = ["label", "kind", "targetUnitId", "targetServiceId", "outcome", "detail", "address"] as const;
export const GROUP_DIAGNOSTIC_KEYS = ["code", "scope", "message", "hint"] as const;

const GROUP_STATES = ["verified", "listening", "not-probed", "not-listening", "dependency-unreachable",
  "verify-failed", "start-failed", "refused", "approval-required", "not-planned"] as const;
const GROUP_UNIT_STARTS = ["started", "start-failed", "refused", "approval-required", "not-started"] as const;
const GROUP_UNIT_LISTENING = ["listening", "not-listening", "not-probed"] as const;
const GROUP_STEP_OUTCOMES = ["passed", "dependency-unreachable", "verify-failed", "not-probed"] as const;
/** The states that read as a pass; `not-probed`/`not-listening` are deliberately NOT among them. */
const GROUP_GREEN_STATES = ["verified", "listening"] as const;

function groupAddress(value: unknown): { host: string; port: number } | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "host,port") return null;
  const host = value["host"];
  const port = value["port"];
  if (typeof host !== "string" || host.length === 0 || host.length > 255) return null;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/** Required bounded text: `null` when absent or unusable, so a `null` check narrows it to `string`. */
function groupText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function groupDiagnostic(value: unknown): ServiceGroupDiagnosticView | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => !(GROUP_DIAGNOSTIC_KEYS as readonly string[]).includes(key))) return null;
  const code = value["code"];
  const message = value["message"];
  if (typeof code !== "string" || code.length === 0 || code.length > 100) return null;
  if (typeof message !== "string" || message.length === 0 || message.length > 2000) return null;
  const hint = boundedText(value["hint"], 2000);
  if (hint === null) return null;
  const scope = value["scope"];
  if (!isRecord(scope) || Object.keys(scope).some((key) => !["unitId", "key", "port"].includes(key))) return null;
  const unitId = boundedText(scope["unitId"], 300);
  const key = boundedText(scope["key"], 300);
  const port = scope["port"];
  if (unitId === null || key === null) return null;
  if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535)) return null;
  return { code, message,
    scope: { ...(unitId !== undefined ? { unitId } : {}), ...(key !== undefined ? { key } : {}), ...(port !== undefined ? { port } : {}) },
    ...(hint !== undefined ? { hint } : {}) };
}

function groupStep(value: unknown): ServiceGroupStepView | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => !(GROUP_STEP_KEYS as readonly string[]).includes(key))) return null;
  const label = groupText(value["label"], 500);
  const kind = groupText(value["kind"], 100);
  const targetUnitId = groupText(value["targetUnitId"], 300);
  const targetServiceId = groupText(value["targetServiceId"], 300);
  const detail = groupText(value["detail"], 2000);
  const outcome = GROUP_STEP_OUTCOMES.find((candidate) => candidate === value["outcome"]);
  if (label === null || kind === null || targetUnitId === null || targetServiceId === null || detail === null || outcome === undefined) return null;
  const address = groupAddress(value["address"]);
  if (address === null) return null;
  return { label, kind, targetUnitId, targetServiceId, outcome, detail, ...(address !== undefined ? { address } : {}) };
}

/**
 * One unit, read strictly: an unknown field, a wrong token or a listening claim
 * without the address it was observed at makes the whole group run unreadable.
 * `已监听` is an OBSERVATION, so a payload that reports it without the address it
 * connected to is contradictory rather than a partial row.
 */
function groupUnit(value: unknown): ServiceGroupUnitView | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => !(GROUP_UNIT_KEYS as readonly string[]).includes(key))) return null;
  const unitId = groupText(value["unitId"], 300);
  const serviceId = groupText(value["serviceId"], 300);
  if (unitId === null || serviceId === null) return null;
  const start = GROUP_UNIT_STARTS.find((candidate) => candidate === value["start"]);
  if (start === undefined) return null;
  const listening = GROUP_UNIT_LISTENING.find((candidate) => candidate === value["listening"]);
  if (listening === undefined) return null;
  if (value["observedRun"] !== true && value["observedRun"] !== false) return null;
  if (value["linked"] !== true && value["linked"] !== false) return null;
  const order = value["order"];
  if (order !== undefined && (typeof order !== "number" || !Number.isInteger(order) || order < 1 || order > 10_000)) return null;
  const pid = value["pid"];
  if (pid !== undefined && (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1)) return null;
  const address = groupAddress(value["address"]);
  if (address === null) return null;
  if (listening === "listening" && address === undefined) return null;
  const rawSteps = value["steps"];
  if (!Array.isArray(rawSteps) || rawSteps.length > 200) return null;
  const steps: ServiceGroupStepView[] = [];
  for (const entry of rawSteps) {
    const step = groupStep(entry);
    if (step === null) return null;
    steps.push(step);
  }
  const rawDiagnostics = value["diagnostics"];
  if (!Array.isArray(rawDiagnostics) || rawDiagnostics.length > 200) return null;
  const diagnostics: ServiceGroupDiagnosticView[] = [];
  for (const entry of rawDiagnostics) {
    const diagnostic = groupDiagnostic(entry);
    if (diagnostic === null) return null;
    diagnostics.push(diagnostic);
  }
  // `linked` is the Host's "every linkage step of this unit really passed": a
  // payload claiming it with no passed observation (or beside a failed one) is
  // contradictory, so the whole run is refused instead of rendered as 已互验.
  const linkage = steps.filter((step) => step.kind === "linkage");
  if (value["linked"] === true && (linkage.length === 0 || linkage.some((step) => step.outcome !== "passed"))) return null;
  return { unitId, serviceId, start, observedRun: value["observedRun"], listening, linked: value["linked"], steps, diagnostics,
    ...(order !== undefined ? { order } : {}), ...(pid !== undefined ? { pid } : {}), ...(address !== undefined ? { address } : {}) };
}

/**
 * The Host's real group run ([PiDock 05] #10 box 4), read STRICTLY - the whole
 * point of this payload is that 已启动 / 已监听 / 已互验 come only from a real
 * observation, so nothing here may be smoothed over:
 *
 * - a passing state (「已监听」/「已互验」) requires that NO unit was refused, parked,
 *   failed to start, stopped listening or stayed unobserved (`not-probed`) and
 *   that NO step failed or stayed unobserved: a refusal, a failure or an
 *   unprobed thing therefore cannot leave a passing group in the payload or in
 *   the UI;
 * - 「已互验」 additionally requires a real `linkage` step whose outcome passed, so
 *   the group can never claim a mutual verification nobody observed;
 * - a plan/declared fact has no way in: `listening`/`outcome` are the Host's own
 *   probe results, and no field of this payload is derived from the plan.
 */
export function serviceGroupRunFromHost(payload: unknown): ServiceGroupRunView | null {
  const envelope = isRecord(payload) ? payload["group"] : undefined;
  if (!isRecord(envelope)) return null;
  if (Object.keys(envelope).some((key) => !(GROUP_RUN_KEYS as readonly string[]).includes(key))) return null;
  const state = GROUP_STATES.find((candidate) => candidate === envelope["state"]);
  if (state === undefined) return null;
  if (!Array.isArray(envelope["groups"]) || !envelope["groups"].every((entry) => typeof entry === "string" && entry.length <= 300)) return null;
  const rawUnits = envelope["units"];
  if (!Array.isArray(rawUnits) || rawUnits.length > 500) return null;
  const units: ServiceGroupUnitView[] = [];
  for (const entry of rawUnits) {
    const unit = groupUnit(entry);
    if (unit === null) return null;
    units.push(unit);
  }
  if (new Set(units.map((unit) => unit.unitId)).size !== units.length) return null;
  const rawScope = envelope["restartScope"];
  if (!Array.isArray(rawScope) || rawScope.length > 500) return null;
  const restartScope: { unitId: string; reason: string }[] = [];
  for (const entry of rawScope) {
    if (!isRecord(entry) || Object.keys(entry).sort().join(",") !== "reason,unitId") return null;
    const unitId = groupText(entry["unitId"], 300);
    const reason = groupText(entry["reason"], 100);
    if (unitId === null || reason === null) return null;
    restartScope.push({ unitId, reason });
  }
  const rawReallocated = envelope["reallocated"];
  if (!Array.isArray(rawReallocated) || rawReallocated.length > 500) return null;
  const reallocated: { unitId: string; before: number; after: number }[] = [];
  for (const entry of rawReallocated) {
    if (!isRecord(entry) || Object.keys(entry).sort().join(",") !== "after,before,unitId") return null;
    const unitId = groupText(entry["unitId"], 300);
    const before = entry["before"];
    const after = entry["after"];
    if (unitId === null || typeof before !== "number" || typeof after !== "number") return null;
    reallocated.push({ unitId, before, after });
  }
  if (!Array.isArray(envelope["diagnostics"]) || envelope["diagnostics"].length > 500) return null;
  const diagnostics: ServiceGroupDiagnosticView[] = [];
  for (const entry of envelope["diagnostics"]) {
    const diagnostic = groupDiagnostic(entry);
    if (diagnostic === null) return null;
    diagnostics.push(diagnostic);
  }
  if ((GROUP_GREEN_STATES as readonly string[]).includes(state)) {
    // A passing group must not contain a unit that was refused, parked, failed,
    // stopped listening or stayed unobserved, nor a failed or unobserved step:
    // without this, one refused unit could still leave a passing group on screen
    // (and one never-probed unit/step could ride a 已互验 group). `not-probed` is
    // a named state, so an unobserved thing never passes for an observed one.
    if (units.some((unit) => unit.start !== "started" || unit.listening === "not-listening" || unit.listening === "not-probed")) return null;
    if (units.every((unit) => unit.start !== "started")) return null;
    if (units.some((unit) => unit.steps.some((step) => step.outcome === "dependency-unreachable" || step.outcome === "verify-failed" || step.outcome === "not-probed"))) return null;
    if (state === "verified") {
      const linkage = units.flatMap((unit) => unit.steps).filter((step) => step.kind === "linkage");
      if (!linkage.some((step) => step.outcome === "passed")) return null;
    }
  }
  return { state, groups: [...envelope["groups"]], units, restartScope, reallocated, diagnostics };
}

/** Result of one group start of a task's run units through the production path. */
export type BoundServiceGroupRunResult = { ok: true; group: ServiceGroupRunView } | { ok: false; error: string };

/**
 * Start the task's run unit group through the production path ([PiDock 05] #10
 * box 4): `shell/serviceCatalogOp {op:"runTaskServiceGroup"}`. Main resolves the
 * task's bound services from the trusted persisted catalog, registers each
 * trusted launch on the task Host and forwards ONE `task/controlService
 * {group:true}`, which starts every unit through the same gate and observes each
 * one for real. The renderer names only the project and the task - it cannot
 * supply a unit list, a program, a port or a value.
 *
 * Three exclusive outcomes, each named: the Host's own group observation, its
 * named refusal (verbatim), or the explicit "the Host returned no group result"
 * state - never a fixture fallback and never an implied success.
 */
export async function runBoundTaskServiceGroupThroughShell(input: {
  projectId: string;
  taskId: string;
}): Promise<BoundServiceGroupRunResult> {
  const result = await serviceCatalogThroughShell({ op: "runTaskServiceGroup", projectId: input.projectId, taskId: input.taskId });
  if (!result.ok) return { ok: false, error: shellFailure(result, "整组启动失败，请重试") };
  const envelope = isRecord(result.payload) ? result.payload["group"] : undefined;
  if (envelope === undefined) return { ok: false, error: "Host 未返回整组启动结果（未执行任何单元）" };
  const group = serviceGroupRunFromHost(result.payload);
  if (group === null) return { ok: false, error: "Host 整组启动回执无法解析（不展示任何状态）" };
  return { ok: true, group };
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
