/**
 * Host-side multi-service topology for [PiDock 05] (#10).
 *
 * One per task workspace (sibling to `TaskServiceRuntime` from #7, same
 * fork binding: the task folder the Host serves). It owns *task-scoped*
 * state the pure rules in `main/service-topology.ts` and
 * `main/service-runs.ts` compute over:
 *
 * - the selected run units and their local/remote choice (box 1);
 * - the final port assignment, the task variable bindings and the routing
 *   those bindings describe (boxes 2/3);
 * - the start groups (prestart → listener groups, bidirectional pairs
 *   merged) derived from the call/prestart dependency kinds (box 4);
 * - run records with code state, build freshness, ports, process identity
 *   and log reference, plus the registered process identities the stop
 *   scope is computed from (boxes 5/6/8);
 * - shared external resources and the known configuration limits that must
 *   not be presented as task isolation (box 7).
 *
 * State changes are validated here (semantic layer); `host.ts` keeps the
 * transport and per-op shape checks and converts thrown errors into
 * `{ok:false,error}` envelopes. No process is spawned in this slice: a run
 * record is written by the caller that really owns a process identity, so
 * nothing here fabricates a PID.
 */

import {
  bindingsToTaskRows,
  describeDependencyRouting,
  planStartGroups,
  reallocatePortAssignments,
  resolveTaskBindings,
  setUnitLocation,
  serviceInstanceId,
  unitsByRepo,
  validateRunUnitSelection,
  type BindingLayers,
  type BindingRule,
  type PortAssignment,
  type PortRequest,
  type PortReservation,
  type ResolvedBinding,
  type RoutingEntry,
  type RunDiagnostic,
  type RunUnit,
  type ServiceDependency,
  type ServiceLocation,
  type StartGroup,
} from "../main/service-topology.js";
import {
  attachVerification,
  buildRunRecord,
  classifyExternalResource,
  diagnoseSharedResources,
  isRunRecordCurrent,
  knownConfigLimits,
  planStopScope,
  recordRunExit,
  type ExternalResource,
  type ExternalResourceKind,
  type ProcessIdentity,
  type RunRecord,
  type RunVerification,
  type StopScope,
} from "../main/service-runs.js";
import type { ServiceConfigSource, ServiceRunType } from "../main/service-config.js";

export interface ExternalResourceInput {
  resourceId: string;
  name: string;
  kind: ExternalResourceKind;
  isolatedByTask?: boolean;
}

export interface ServiceTopologyPlanInput {
  units: RunUnit[];
  selectedRepoDirs?: string[];
  dependencies?: ServiceDependency[];
  runTypes?: Record<string, ServiceRunType>;
  requests?: PortRequest[];
  /** Machine-wide reservations (this task's own plus the other tasks' / external ones). */
  reservations?: PortReservation[];
  rules?: BindingRule[];
  layers?: BindingLayers;
  environment?: string;
  externalResources?: ExternalResourceInput[];
}

/** Response shape of `task/planServiceGroup`: no env layers, no secret values. */
export interface ServiceTopologyPlan {
  taskId: string;
  units: RunUnit[];
  repoGroups: { repoDir: string; units: RunUnit[] }[];
  assignments: PortAssignment[];
  reallocated: { unitId: string; before: number; after: number }[];
  bindings: ResolvedBinding[];
  taskRows: { key: string; value: string; secret: boolean }[];
  routing: RoutingEntry[];
  groups: StartGroup[];
  externalResources: ExternalResource[];
  knownLimits: string[];
  diagnostics: RunDiagnostic[];
}

export interface RecordRunInput {
  serviceId: string;
  /** Shared-template version this run's config snapshot came from. */
  templateVersion: string;
  ports: number[];
  code: { commit?: string; dirty: boolean };
  buildCommit?: string;
  pid: number;
  owner: "agent" | "human";
  startedAt?: string;
  /** [PiDock 08] (#14) protocol artifact version this instance loaded, when observed. */
  protocolArtifact?: { version: string };
}

const EMPTY_LAYERS: BindingLayers = { repoDefaults: [], shared: [], privateEntries: [], task: [] };

export class TaskServiceTopology {
  private units: RunUnit[] = [];
  private dependencies: ServiceDependency[] = [];
  private runTypes: Record<string, ServiceRunType> = {};
  private assignments: PortAssignment[] = [];
  private reallocated: { unitId: string; before: number; after: number }[] = [];
  private bindings: ResolvedBinding[] = [];
  private rules: BindingRule[] = [];
  private environment = "";
  private planningDiagnostics: RunDiagnostic[] = [];
  private resources: ExternalResource[] = [];
  private readonly records: RunRecord[] = [];
  private readonly registry: ProcessIdentity[] = [];

  constructor(
    readonly taskId: string,
    readonly taskDir: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    if (taskId.trim().length === 0) throw new Error("invalid-payload: taskId must be non-empty");
    if (taskDir.trim().length === 0) throw new Error("invalid-payload: taskDir must be non-empty");
  }

  /**
   * Replace the selected units, allocate ports, resolve bindings and derive
   * the start groups. Fail-closed: an invalid selection, an unusable port or
   * a conflicting binding throws, and the previous plan stays in place
   * rather than a half-updated one.
   */
  setPlan(input: ServiceTopologyPlanInput): ServiceTopologyPlan {
    const selection = validateRunUnitSelection({
      selectedRepoDirs: input.selectedRepoDirs ?? [...new Set(input.units.map((unit) => unit.repoDir).filter((dir): dir is string => dir !== undefined))],
      units: input.units,
    });
    if (!selection.ok) throw new Error(`${selection.error.code}: ${selection.error.message}`);
    const ports = reallocatePortAssignments({
      taskId: this.taskId,
      units: selection.units,
      requests: input.requests ?? [],
      reservations: input.reservations ?? [],
      // Same per-unit override the start groups use, so a unit classified
      // `prepare`/`one-shot` by override is not also required to own a port.
      runTypes: input.runTypes,
    });
    const hardPortFailure = ports.diagnostics.find((entry) => entry.code !== "port-taken");
    if (hardPortFailure) throw new Error(`${hardPortFailure.code}: ${hardPortFailure.message}`);
    const layers = input.layers ?? EMPTY_LAYERS;
    const resolved = resolveTaskBindings({
      rules: input.rules ?? [],
      assignments: ports.assignments,
      units: selection.units,
      layers,
    });
    if (!resolved.ok) throw new Error(`${resolved.diagnostics[0]?.code ?? "binding-error"}: ${resolved.diagnostics[0]?.message ?? "变量绑定失败"}`);
    const groups = planStartGroups({
      units: selection.units,
      dependencies: input.dependencies ?? [],
      runTypes: input.runTypes,
    });
    this.units = selection.units;
    this.dependencies = input.dependencies ?? [];
    this.runTypes = input.runTypes ?? {};
    this.assignments = ports.assignments;
    this.reallocated = ports.reallocated;
    this.rules = input.rules ?? [];
    this.bindings = resolved.bindings;
    this.environment = input.environment ?? "";
    this.resources = (input.externalResources ?? []).map((resource) => classifyExternalResource(resource));
    this.planningDiagnostics = [...ports.diagnostics, ...resolved.diagnostics, ...groups.diagnostics, ...diagnoseSharedResources(this.resources)];
    return this.plan();
  }

  /** Toggle one unit's location and re-derive bindings/routing for the new set. */
  setLocation(unitId: string, location: ServiceLocation, input: {
    requests?: PortRequest[];
    reservations?: PortReservation[];
    layers?: BindingLayers;
  } = {}): ServiceTopologyPlan {
    const switched = setUnitLocation(this.units, unitId, location);
    if (!switched.ok) throw new Error(`${switched.error.code}: ${switched.error.message}`);
    return this.setPlan({
      units: switched.units,
      selectedRepoDirs: [...new Set(switched.units.map((unit) => unit.repoDir).filter((dir): dir is string => dir !== undefined))],
      dependencies: this.dependencies,
      runTypes: this.runTypes,
      requests: input.requests ?? this.assignments.map((assignment) => ({ unitId: assignment.unitId, port: assignment.port })),
      reservations: input.reservations ?? [],
      rules: this.rules,
      layers: input.layers ?? EMPTY_LAYERS,
      environment: this.environment,
      externalResources: this.resources.map((resource) => ({
        resourceId: resource.resourceId,
        name: resource.name,
        kind: resource.kind,
        isolatedByTask: resource.isolation === "isolated",
      })),
    });
  }

  plan(): ServiceTopologyPlan {
    return {
      taskId: this.taskId,
      units: [...this.units],
      repoGroups: unitsByRepo(this.units),
      assignments: [...this.assignments],
      reallocated: [...this.reallocated],
      bindings: [...this.bindings],
      taskRows: bindingsToTaskRows(this.bindings),
      routing: describeDependencyRouting({
        taskId: this.taskId,
        bindings: this.bindings,
        assignments: this.assignments,
        units: this.units,
        environment: this.environment,
      }),
      groups: planStartGroups({ units: this.units, dependencies: this.dependencies, runTypes: this.runTypes }).groups,
      externalResources: [...this.resources],
      knownLimits: knownConfigLimits(this.resources),
      diagnostics: [...this.planningDiagnostics],
    };
  }

  routing(): RoutingEntry[] {
    return describeDependencyRouting({
      taskId: this.taskId,
      bindings: this.bindings,
      assignments: this.assignments,
      units: this.units,
      environment: this.environment,
    });
  }

  /** Read points of the bindings, per variable (UI 读取点核对). */
  readPoints(): { key: string; readPoints: ServiceConfigSource[] }[] {
    return this.bindings.map((binding) => ({ key: binding.key, readPoints: [...binding.readPoints] }));
  }

  /**
   * Record one run: requires a real process identity (integer pid > 0 and a
   * start time), so a run can never be recorded from a guess. The record
   * keeps the code/build state, ports and log path together with the
   * registered identity the stop scope later works from.
   */
  recordRun(input: RecordRunInput): RunRecord {
    if (!Number.isInteger(input.pid) || input.pid <= 0) {
      throw new Error("invalid-payload: recordServiceRun.pid must be a positive integer from the real process");
    }
    const unit = this.units.find((candidate) => candidate.serviceId === input.serviceId);
    const assignment = this.assignments.find((candidate) => candidate.serviceId === input.serviceId);
    const startedAt = input.startedAt ?? this.now();
    if (startedAt.trim().length === 0) throw new Error("invalid-payload: recordServiceRun.startedAt must be non-empty");
    const record = buildRunRecord({
      runId: `run-${this.records.length + 1}`,
      taskId: this.taskId,
      serviceId: input.serviceId,
      templateVersion: input.templateVersion,
      ports: input.ports.length > 0 ? input.ports : assignment ? [assignment.port] : [],
      code: input.code,
      build: { commit: input.buildCommit ?? input.code.commit },
      processIdentity: { owner: input.owner, pid: input.pid, startedAt },
      taskDir: this.taskDir,
      startedAt,
      ...(input.protocolArtifact !== undefined ? { protocolArtifact: { version: input.protocolArtifact.version } } : {}),
    });
    if (unit === undefined) {
      // Repo-less helper or an Agent-declared run: record it, but note the
      // unit is not part of the selected set so the UI does not imply it is.
      record.verifications.push({ kind: "readiness", detail: `运行单元 ${input.serviceId} 不在当前选择中`, ok: false, at: startedAt });
    }
    this.records.push(record);
    this.registry.push({
      instanceId: serviceInstanceId(this.taskId, input.serviceId),
      taskId: this.taskId,
      serviceId: input.serviceId,
      pid: input.pid,
      startedAt,
      owner: input.owner,
    });
    return { ...record };
  }

  runs(): RunRecord[] {
    return this.records.map((record) => ({ ...record, verifications: [...record.verifications] }));
  }

  /** Latest recorded run of one service, with `current` re-checked against HEAD. */
  latestRun(serviceId: string, head: { headCommit?: string; dirty: boolean }): (RunRecord & { current: boolean }) | undefined {
    const latest = [...this.records].reverse().find((record) => record.serviceId === serviceId);
    if (!latest) return undefined;
    return { ...latest, verifications: [...latest.verifications], current: isRunRecordCurrent(latest, head) };
  }

  exitRun(runId: string, reason: string): RunRecord {
    const index = this.records.findIndex((record) => record.runId === runId);
    if (index === -1) throw new Error(`unknown-run: ${runId} 不在本任务的运行记录中`);
    const closed = recordRunExit(this.records[index] as RunRecord, { reason, at: this.now() });
    this.records[index] = closed;
    const remaining = this.registry.filter(
      (identity) => !(identity.serviceId === closed.serviceId && identity.startedAt === closed.startedAt),
    );
    this.registry.length = 0;
    this.registry.push(...remaining);
    return { ...closed };
  }

  /** Attach a linkage / readiness / remote-reachability result to a run. */
  verifyRun(runId: string, input: { kind: RunVerification["kind"]; detail: string; ok: boolean }): RunRecord {
    const index = this.records.findIndex((record) => record.runId === runId);
    if (index === -1) throw new Error(`unknown-run: ${runId} 不在本任务的运行记录中`);
    const verified = attachVerification(this.records[index] as RunRecord, { ...input, at: this.now() });
    this.records[index] = verified;
    return { ...verified };
  }

  /** Stop scope for one instance or the whole task (box 8). */
  stopScope(instanceId?: string): StopScope {
    const planned = planStopScope({ taskId: this.taskId, registry: this.registry, ...(instanceId !== undefined ? { instanceId } : {}) });
    if (!planned.ok) throw new Error(`${planned.error.code}: ${planned.error.message}`);
    return planned.scope;
  }

  registeredIdentities(): ProcessIdentity[] {
    return this.registry.map((identity) => ({ ...identity }));
  }
}
