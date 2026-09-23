/**
 * Run records, stop scope and shared external resources for [PiDock 05] (#10).
 *
 * Companion to `service-topology.ts`: that module decides ports, bindings
 * and start groups; this one owns what a run *is* — the code state and
 * build freshness it was started from (box 6: 未提交代码和旧构建可区分),
 * the ports / process identity / log reference it is tied to, the
 * locatable failure diagnostics (box 5) and the stop scope (box 8:
 * 只处理已登记的所属进程树，不影响另一任务或外部服务).
 *
 * Shared external resources (box 7) are classified here too: a fixed async
 * queue or a DTM callback is a shared external resource and is never
 * reported as "isolated by this task" without proof.
 *
 * No process is spawned and no port is probed here — the caller (Host)
 * supplies the real observations; every rule is pure so it is testable.
 */

import { diagnostic, instanceAddress, type RunDiagnostic } from "./service-topology.js";

/** Code state a run started from. */
export type CodeState = "committed-clean" | "uncommitted" | "unknown";

/**
 * How far the build behind a run is from the current HEAD:
 * `fresh` (built from the current clean commit), `stale-build` (built from
 * an older commit), `uncommitted-code` (working tree has edits the build
 * cannot contain) or `unknown` (no commit information).
 */
export type BuildFreshness = "fresh" | "stale-build" | "uncommitted-code" | "unknown";

export function classifyCodeState(input: { commit?: string; dirty: boolean }): CodeState {
  if (!input.commit) return "unknown";
  return input.dirty ? "uncommitted" : "committed-clean";
}

export function classifyBuildFreshness(input: {
  buildCommit?: string;
  headCommit?: string;
  dirty: boolean;
}): BuildFreshness {
  if (input.dirty) return "uncommitted-code";
  if (!input.buildCommit || !input.headCommit) return "unknown";
  return input.buildCommit === input.headCommit ? "fresh" : "stale-build";
}

export interface RunVerification {
  kind: "linkage" | "readiness" | "remote-reachability";
  detail: string;
  ok: boolean;
  at: string;
}

/** One recorded run of one service instance; logs and verifications hang off it. */
export interface RunRecord {
  runId: string;
  taskId: string;
  serviceId: string;
  instanceId: string;
  templateVersion: string;
  codeState: { kind: CodeState; commit?: string; note: string };
  buildFreshness: BuildFreshness;
  ports: number[];
  processIdentity: { owner: "agent" | "human"; pid: number; startedAt: string };
  /** Log file for this run: `<taskDir>/services/<serviceId>/run-<runId>.log`. */
  logRef: string;
  startedAt: string;
  endedAt?: string;
  exit?: { reason: string };
  verifications: RunVerification[];
}

const CODE_STATE_NOTE: Record<CodeState, string> = {
  "committed-clean": "工作副本与记录提交一致",
  uncommitted: "工作副本有未提交修改，构建产物不包含这些改动",
  unknown: "缺少提交信息，无法判断代码状态",
};

/**
 * Build the run record for one start: config (template) version, code
 * state and build freshness, ports, process identity and the log file all
 * belong to the same record, so a stale/old build is distinguishable from
 * the running code.
 */
export function buildRunRecord(input: {
  runId: string;
  taskId: string;
  serviceId: string;
  templateVersion: string;
  ports: readonly number[];
  code: { commit?: string; dirty: boolean };
  build: { commit?: string };
  processIdentity: { owner: "agent" | "human"; pid: number; startedAt: string };
  taskDir: string;
  startedAt: string;
}): RunRecord {
  const kind = classifyCodeState(input.code);
  const primaryPort = input.ports[0];
  return {
    runId: input.runId,
    taskId: input.taskId,
    serviceId: input.serviceId,
    instanceId: instanceAddress(input.taskId, input.serviceId, primaryPort),
    templateVersion: input.templateVersion,
    codeState: {
      kind,
      ...(input.code.commit !== undefined ? { commit: input.code.commit } : {}),
      note: CODE_STATE_NOTE[kind],
    },
    buildFreshness: classifyBuildFreshness({
      buildCommit: input.build.commit,
      headCommit: input.code.commit,
      dirty: input.code.dirty,
    }),
    ports: [...input.ports],
    processIdentity: { ...input.processIdentity },
    logRef: `${input.taskDir.replace(/[\\/]+$/, "")}/services/${input.serviceId}/run-${input.runId}.log`,
    startedAt: input.startedAt,
    verifications: [],
  };
}

/** Close a run: keeps code/config/ports/process identity and the exit reason. */
export function recordRunExit(record: RunRecord, input: { reason: string; at: string }): RunRecord {
  return { ...record, endedAt: input.at, exit: { reason: input.reason } };
}

/**
 * Attach a verification result (linkage / readiness / remote reachability)
 * to the run so a successful process start is never confused with a
 * successful functional check (spec: 不将本地启动成功等同于功能验证成功).
 */
export function attachVerification(
  record: RunRecord,
  input: { kind: RunVerification["kind"]; detail: string; ok: boolean; at: string },
): RunRecord {
  return { ...record, verifications: [...record.verifications, { ...input }] };
}

/** True when the record still describes the current clean commit. */
export function isRunRecordCurrent(record: RunRecord, input: { headCommit?: string; dirty: boolean }): boolean {
  return (
    record.codeState.kind === "committed-clean" &&
    record.buildFreshness === "fresh" &&
    record.codeState.commit !== undefined &&
    record.codeState.commit === input.headCommit &&
    !input.dirty
  );
}

/**
 * Locatable start failure (box 5). A bind/port failure is reported as
 * `port-taken` with the reallocation hint; anything else keeps the raw
 * reason so the log and the offending instance are both identifiable.
 */
export function diagnoseStartFailure(input: {
  unitId: string;
  serviceId: string;
  port?: number;
  error: string;
}): RunDiagnostic {
  const busy = /EADDRINUSE|address already in use|端口.*占用|port.*in use/i.test(input.error);
  const scope = input.port === undefined ? { unitId: input.unitId } : { unitId: input.unitId, port: input.port };
  return busy
    ? diagnostic(
        "port-taken",
        scope,
        `本地服务「${input.serviceId}」启动失败：端口 ${input.port ?? "?"} 已被占用`,
        "运行管理会重新分配端口并更新受影响的消费者；也可手动指定端口后重试",
      )
    : diagnostic("start-failed", scope, `本地服务「${input.serviceId}」启动失败：${input.error}`, "查看该实例的运行日志后重试");
}

/**
 * A started service whose dependency does not answer: reported per consumer
 * variable with the target named, never as a generic failure.
 */
export function diagnoseDependencyUnreachable(input: {
  unitId: string;
  key: string;
  target: string;
  detail?: string;
}): RunDiagnostic {
  return diagnostic(
    "dependency-unreachable",
    { unitId: input.unitId, key: input.key },
    `服务「${input.unitId}」的依赖 ${input.target} 不可达${input.detail ? `：${input.detail}` : ""}`,
    "本地进程启动成功不等于功能验证成功；请检查依赖服务或该环境地址",
  );
}

/** Registered process identity: the only thing a stop may act on. */
export interface ProcessIdentity {
  instanceId: string;
  taskId: string;
  serviceId: string;
  pid: number;
  startedAt: string;
  owner: "agent" | "human";
}

export interface StopScope {
  taskId: string;
  stop: ProcessIdentity[];
  /** Registered identities explicitly left alone (other tasks / other instances). */
  skipped: { instanceId: string; reason: string }[];
}

function serviceIdOf(instanceId: string): string {
  const slash = instanceId.indexOf("/");
  return slash === -1 ? instanceId : instanceId.slice(slash + 1);
}

/**
 * Exact-match identity check: a stop decision must match a registered
 * identity on instance + pid + start time, so a guessed PID (or a recycled
 * one) can never be signalled. Ports are not part of the identity at all —
 * stop scope is never derived from a port or a stale PID.
 */
export function verifyRegisteredIdentity(
  identity: { instanceId: string; pid: number; startedAt: string },
  registry: readonly ProcessIdentity[],
): boolean {
  return registry.some(
    (entry) =>
      entry.instanceId === identity.instanceId && entry.pid === identity.pid && entry.startedAt === identity.startedAt,
  );
}

/**
 * Stop scope for one service instance or for a whole task (box 8). Only
 * registry entries of the owning task are stopped; a same-name instance in
 * another task is listed under `skipped` so the UI can show it is
 * untouched. An unregistered target fails closed instead of guessing.
 */
export function planStopScope(input: {
  taskId: string;
  registry: readonly ProcessIdentity[];
  instanceId?: string;
}): { ok: true; scope: StopScope } | { ok: false; error: RunDiagnostic } {
  if (input.instanceId !== undefined) {
    const target = input.registry.find((entry) => entry.instanceId === input.instanceId);
    if (!target) {
      return {
        ok: false,
        error: diagnostic(
          "unknown-instance",
          {},
          `没有已登记的进程实例「${input.instanceId}」`,
          "只按已登记的身份停止进程；不会按端口或过期 PID 猜测归属",
        ),
      };
    }
    if (target.taskId !== input.taskId) {
      return {
        ok: false,
        error: diagnostic("unknown-instance", {}, `进程实例「${input.instanceId}」不属于当前任务，已拒绝停止`),
      };
    }
  }
  const owned = input.registry.filter(
    (entry) => entry.taskId === input.taskId && (input.instanceId === undefined || entry.instanceId === input.instanceId),
  );
  const wanted = input.instanceId !== undefined ? serviceIdOf(input.instanceId) : undefined;
  const skipped = input.registry
    .filter((entry) => entry.taskId !== input.taskId && wanted !== undefined && entry.serviceId === wanted)
    .map((entry) => ({ instanceId: entry.instanceId, reason: `属于其他任务 ${entry.taskId}，不受本次停止影响` }));
  return { ok: true, scope: { taskId: input.taskId, stop: owned, skipped } };
}

export type ExternalResourceKind = "queue" | "dtm-callback" | "database" | "cache" | "object-storage" | "other";

export function isExternalResourceKind(value: unknown): value is ExternalResourceKind {
  return (
    value === "queue" ||
    value === "dtm-callback" ||
    value === "database" ||
    value === "cache" ||
    value === "object-storage" ||
    value === "other"
  );
}

/**
 * A resource used by the task that the app does not own: shared by default,
 * and never labelled "isolated" without proof (`isolatedByTask`). A fixed
 * async queue or a DTM callback stays shared even when the task has local
 * services, because the remote side still funnels through one instance.
 */
export interface ExternalResource {
  resourceId: string;
  name: string;
  kind: ExternalResourceKind;
  shared: boolean;
  isolation: "isolated" | "not-isolated" | "unknown";
  note: string;
}

const EXTERNAL_KIND_LABEL: Record<ExternalResourceKind, string> = {
  queue: "固定异步队列",
  "dtm-callback": "DTM 回调地址",
  database: "外部数据库",
  cache: "外部缓存",
  "object-storage": "外部对象存储",
  other: "外部资源",
};

export function classifyExternalResource(input: {
  resourceId: string;
  name: string;
  kind: ExternalResourceKind;
  /** Set only when per-task isolation is actually proven. */
  isolatedByTask?: boolean;
}): ExternalResource {
  const label = EXTERNAL_KIND_LABEL[input.kind];
  if (input.isolatedByTask === true) {
    return {
      resourceId: input.resourceId,
      name: input.name,
      kind: input.kind,
      shared: false,
      isolation: "isolated",
      note: `${label}「${input.name}」已按任务隔离（有独立实例证据）`,
    };
  }
  const pinned = input.kind === "queue" || input.kind === "dtm-callback";
  return {
    resourceId: input.resourceId,
    name: input.name,
    kind: input.kind,
    shared: true,
    isolation: pinned ? "not-isolated" : "unknown",
    note: pinned
      ? `${label}「${input.name}」是共享外部资源：消费端与回调端仍指向同一实例，不标记为任务隔离成功`
      : `${label}「${input.name}」未验证任务隔离，按共享资源对待`,
  };
}

/** UI lines for the known configuration limits implied by shared resources. */
export function knownConfigLimits(resources: readonly ExternalResource[]): string[] {
  return resources.filter((resource) => resource.shared).map((resource) => resource.note);
}

/** One locatable diagnostic per shared resource (box 7: 不会自动标记为隔离成功). */
export function diagnoseSharedResources(resources: readonly ExternalResource[]): RunDiagnostic[] {
  return resources
    .filter((resource) => resource.shared)
    .map((resource) =>
      diagnostic("shared-not-isolated", { key: resource.resourceId }, resource.note, "如需真正隔离，请为该任务部署独立实例并提供证据"),
    );
}
