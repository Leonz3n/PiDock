/**
 * [PiDock 05] (#10 box 1) the task's 本地/远程位置 and its REAL 实际依赖去向, derived
 * on the TRUSTED side and read back by the shipped dock.
 *
 * Why this module exists: the dock's three readouts (本地/远程, 远程依赖, 请求去向)
 * were explicitly `未接线` because main had no read that derives them, and the only
 * place the distinction was rendered was the demo mirror in `ToolPanels.tsx`
 * (which the packaged app never mounts). The facts themselves were never
 * missing - they are decided by the same trusted read the group start uses.
 *
 * ONE derivation, two callers (stated so a second one cannot appear):
 * `deriveBoundServiceGroupPlan` is the plan's trusted inputs - one run unit per
 * bound service, the 服务依赖声明 of the PINNED revisions mapped onto those units,
 * `planBindingLayers` + `deriveBindingRules`. The start path
 * (`runtime.ts runTaskServiceGroup`) sends that result to the Host. The read here
 * resolves the SAME inputs with the SAME pure functions the Host's
 * `TaskServiceTopology.setPlan` composes (`reallocatePortAssignments` →
 * `resolveTaskBindings` → `describeDependencyRouting`), because a read must not
 * write a plan, must not fork a Host and must not create a child.
 *
 * Honesty rules implemented here:
 * - a variable whose key no 服务依赖声明 binds keeps the SHARED environment
 *   address - it is reported as `remote` together with the layers that really
 *   read it, so the dock can never present a shared environment value as this
 *   task's instance address;
 * - no address and no port is synthesised: a destination is `local-instance` only
 *   where the plan really assigned a port (`resolveTaskBindings` fails closed with
 *   `missing-port` instead), and a unit without an assignment reports no port;
 * - a pin is a revision: the descriptor, the config layers and the declaration all
 *   come from the binding's own `templateVersion`, so a newer revision saved in
 *   the same environment changes nothing this module reads;
 * - a declared target this task has not bound is refused BY NAME (the start
 *   path's own refusal text, one formatter), never dropped;
 * - nothing here starts, stops or registers anything: the read takes the catalog
 *   only, with no Host registry, no sender and no spawn-capable collaborator, so a
 *   read cannot decide a start even by accident.
 */
import {
  auditBindingReadPoints,
  deriveBindingRules,
  describeDependencyRouting,
  planBindingLayers,
  reallocatePortAssignments,
  resolveTaskBindings,
  unitsByRepo,
  type BindingLayers,
  type BindingRule,
  type DependencyKind,
  type PortRequest,
  type RunDiagnostic,
  type RunUnit,
  type ServiceDependency,
  type ServiceLocation,
} from "./service-topology.js";
import {
  declaredServicePorts,
  isServiceSecretKey,
  resolveServiceEnv,
  type ServiceConfigEntry,
  type ServiceConfigSource,
  type ServiceRunType,
} from "./service-config.js";
import type { ServiceCatalog, ServiceCatalogBinding, ServiceLaunch, ServiceTaskBinding, ServiceTemplate } from "./service-catalog.js";

/** One task-bound service as main's own store resolves it: the PINNED revision and its launch material. */
export interface BoundServiceEntry {
  binding: ServiceTaskBinding;
  template: ServiceTemplate;
  launch: ServiceLaunch;
}

/** One bound service's run unit plus the trusted facts the plan is derived from. */
export interface PlannedBoundService {
  unitId: string;
  serviceId: string;
  name: string;
  repoDir: string;
  runType: ServiceRunType;
  /** The ports this launch DECLARES (descriptor + resolved `*PORT` rows), never a probe. */
  declared: number[];
}

/**
 * The trusted plan inputs of one task's bound services: what a group start sends
 * to the Host, and what this file's read resolves without a Host.
 */
export interface BoundServiceGroupPlan {
  planned: PlannedBoundService[];
  units: RunUnit[];
  /** The 服务依赖声明 of the pinned revisions, mapped onto the plan's own unit ids. */
  dependencies: ServiceDependency[];
  rules: BindingRule[];
  layers: BindingLayers;
  requests: PortRequest[];
  runTypes: Record<string, ServiceRunType>;
  selectedRepoDirs: string[];
}

/** A declared dependency whose target this task has not bound: the plan has no unit for it. */
export interface UnsatisfiedDeclaration {
  from: string;
  fromName: string;
  serviceId: string;
  to: string;
}

export type BoundServiceGroupDerivation =
  | { ok: true; plan: BoundServiceGroupPlan }
  | { ok: false; unsatisfied: UnsatisfiedDeclaration };

/** The plan's own unit id for one task-bound service (the id the Host's plan units carry). */
export function boundServiceUnitId(rootId: string, serviceId: string): string {
  return `${rootId}:${serviceId}`;
}

/**
 * The task's group plan as main derives it from the trusted catalog.
 *
 * The per-service reasoning (why every binding is exactly one LOCAL unit, why the
 * requests are the descriptor's DECLARED ports, why `rules`/`layers` exist only
 * when the trusted side really derived rows) belongs to the plan and is stated at
 * the start path this was lifted from; this function owns the sequencing both
 * callers share.
 *
 * Returns the unsatisfied declaration instead of throwing, so each caller can
 * spell that one fact for its own context through `unsatisfiedDeclarationMessage`,
 * never with two different sentences.
 */
export function deriveBoundServiceGroupPlan(bound: readonly BoundServiceEntry[]): BoundServiceGroupDerivation {
  const planned = bound.map(({ binding, launch }): PlannedBoundService => {
    // The ports this service's launch DECLARES (never a probe): the descriptor's
    // own list plus its `*PORT` RESOLVED rows - the SAME two inputs the Host's
    // declared-address rule reads, so main cannot drift from what the
    // registration declares. A long-lived unit with none fails the port-first plan
    // closed by name - it is never dropped from the group.
    const resolved = resolveServiceEnv(launch.layers);
    if (!resolved.ok) {
      // Defence in depth: the registration of this same launch already resolved
      // these layers, so this refuses by the same name rather than planning
      // against rows main could not read.
      throw new Error(`服务登记失败，未发起整组启动：${launch.serviceId} 的启动材料无法从可信服务目录解析（${resolved.error.code}: ${resolved.error.message}）`);
    }
    return {
      unitId: boundServiceUnitId(binding.rootId, launch.serviceId),
      serviceId: launch.serviceId,
      name: launch.descriptor.name,
      repoDir: binding.rootId,
      runType: launch.descriptor.runType,
      declared: declaredServicePorts(launch.descriptor.ports, resolved.rows),
    };
  });
  const unitIdOf = new Map(planned.map((entry) => [entry.serviceId, entry.unitId]));
  const declaredTargets: string[] = [];
  for (const { binding, launch, template } of bound) {
    for (const dependency of template.dependencies ?? []) {
      if (unitIdOf.get(dependency.to) === undefined) {
        // The declaration names a service of this environment that this task has
        // not bound, so the plan has no unit for it. Dropping the edge silently
        // would report a group as complete while the declared prerequisite is
        // missing - refused by name instead.
        return {
          ok: false,
          unsatisfied: {
            from: boundServiceUnitId(binding.rootId, launch.serviceId),
            fromName: launch.descriptor.name,
            serviceId: launch.serviceId,
            to: dependency.to,
          },
        };
      }
      declaredTargets.push(dependency.to);
    }
  }
  const dependencies: ServiceDependency[] = bound.flatMap(({ binding, launch, template }) =>
    (template.dependencies ?? []).map((dependency) => ({
      from: boundServiceUnitId(binding.rootId, launch.serviceId),
      to: unitIdOf.get(dependency.to) as string,
      kind: dependency.kind,
    })),
  );
  const units: RunUnit[] = planned.map((entry) => ({
    unitId: entry.unitId, serviceId: entry.serviceId, name: entry.name,
    repoDir: entry.repoDir, location: "local", runType: entry.runType,
  }));
  const layers = planBindingLayers(bound.map(({ launch }) => launch.layers));
  const rules = deriveBindingRules({ units, layers, declaredTargets });
  return {
    ok: true,
    plan: {
      planned,
      units,
      dependencies,
      rules,
      layers,
      requests: planned.flatMap((entry) => {
        const [port] = entry.declared;
        return port === undefined ? [] : [{ unitId: entry.unitId, port }];
      }),
      runTypes: Object.fromEntries(planned.map((entry) => [entry.unitId, entry.runType])),
      selectedRepoDirs: [...new Set(planned.map((entry) => entry.repoDir))],
    },
  };
}

/** The ONE spelling of "a declared dependency target is not bound to this task" (the start path's own text). */
export function unsatisfiedDeclarationMessage(failure: UnsatisfiedDeclaration): string {
  return `服务依赖声明无法满足，未生成整组计划：「${failure.fromName}」（${failure.serviceId}）声明的依赖目标 ${failure.to} 未在本任务的服务绑定中，请先绑定该服务或从共享模板移除该声明`;
}

/** One bound service's 位置 and identity, as the task view shows it. */
export interface TaskDependencyUnitView {
  unitId: string;
  serviceId: string;
  name: string;
  repoDir: string;
  subdir: string;
  templateVersion: number;
  /** The environment the pinned revision belongs to: a trusted display label, never a value. */
  environment: string;
  /**
   * 本地/远程位置. Binding a service to a task is exactly the act of running it on
   * this machine, and today's shipped app has NO path that moves a bound unit to
   * `remote` (`setUnitLocation` has no production caller), so every bound unit
   * reads `local`. The type keeps both values so a future selection path cannot
   * silently render a remote unit as a local instance.
   */
  location: ServiceLocation;
  /** The ports the pinned revision declares; empty means "declares no port", never "no port". */
  declaredPorts: number[];
}

/** Where one variable's value really goes. */
export type TaskDependencyTargetView =
  | { kind: "local-instance"; instanceId: string; address: string; port?: number }
  | { kind: "remote"; environment: string };

/** One config layer that really reads one key, and the value it holds there. */
export interface TaskDependencyReadPointView {
  source: ServiceConfigSource;
  /** Present only for a NON-secret row: a private value never travels through this read. */
  value?: string;
  masked: boolean;
}

/** One variable and its 实际依赖去向. */
export interface TaskDependencyDestinationView {
  /** The run unit whose own address variable this key is. */
  unitId: string;
  serviceId: string;
  key: string;
  target: TaskDependencyTargetView;
  /**
   * The address value the task's OWN instance serves for this key, when a
   * declaration bound it. Absent for a shared-environment destination, whose
   * value is the layer's own and is reported per read point instead.
   */
  value?: string;
  readPoints: TaskDependencyReadPointView[];
  /**
   * The trusted diagnostic that explains this destination, verbatim: the SAME
   * message the plan's own `diagnostics` list carries, repeated here because it is
   * what the row itself has to say (`missing-binding` = the consumer keeps the
   * shared environment address).
   */
  reason?: string;
}

/**
 * What the pinned revisions DECLARE. This is a declaration, never a verification:
 * the read starts nothing, so no edge can be `已互验` here, and a task whose pinned
 * revisions declare nothing keeps the named `no-declaration` state instead of an
 * invented edge.
 */
export interface TaskDependencyLinkageView {
  state: "no-declaration" | "declared";
  edges: { from: string; to: string; fromName: string; toName: string; kind: DependencyKind }[];
}

/** The whole trusted read the dock renders. */
export interface TaskDependencyRoutingView {
  taskId: string;
  units: TaskDependencyUnitView[];
  /** Which run units one repository contributes (一个仓库的多个运行单元). */
  repoGroups: { repoDir: string; unitIds: string[] }[];
  destinations: TaskDependencyDestinationView[];
  linkage: TaskDependencyLinkageView;
  /** The plan's own diagnostics, verbatim: a destination it could not derive is named here. */
  diagnostics: { code: string; message: string; hint?: string }[];
}

/**
 * A named refusal of this read: the trusted data it needs is not there (a launch
 * main cannot resolve, or a declaration whose target is not bound). It is never
 * a partial view.
 */
export class DependencyRoutingRefused extends Error {}

/**
 * The read's accepted shape: exactly `{op,projectId,taskId}`. Nothing about the
 * plan is accepted from the page - the units, the declaration-derived edges, the
 * variable binding rules and the config layers are all derived by main from its
 * own catalog, and a page that names any of them is refused BY NAME (mirroring
 * `runtime.ts`'s `task/planServiceGroup` refusal and the sibling
 * `parseServiceRunGroupRequest`).
 */
export interface TaskDependencyRoutingRequest {
  taskId: string;
  projectId: string;
}

/**
 * The task's 位置 + REAL 实际依赖去向 as the SHIPPED dock reads it.
 *
 * Reads only trusted main state: `catalog.taskBindings` (the task's bindings, each
 * with the PINNED revision) and `catalog.launchFor` (the same launch material a
 * start resolves, from the same pin). It writes nothing, registers nothing, forks
 * nothing and has no Host access - which is why it cannot start, stop or create a
 * child.
 */
export function readTaskDependencyRouting(
  catalog: Pick<ServiceCatalog, "taskBindings" | "launchFor">,
  request: TaskDependencyRoutingRequest,
): TaskDependencyRoutingView {
  const bindings = catalog.taskBindings(request.projectId, request.taskId);
  const bound: BoundServiceEntry[] = bindings.map((row: ServiceCatalogBinding) => {
    let launch: ServiceLaunch;
    try {
      launch = catalog.launchFor(request.taskId, request.projectId, row.binding.serviceId, process.env);
    } catch (error) {
      // The catalog's own fixed code carries no path and no value, so it is safe
      // to name beside the offending service. Without the trusted launch there is
      // no descriptor, no layer and no port to show, and a partial read would be
      // an invented one.
      throw new DependencyRoutingRefused(
        `依赖去向读取失败：${row.binding.serviceId} 的启动材料无法从可信服务目录解析（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
    return { binding: row.binding, template: row.template, launch };
  });
  if (bound.length === 0) {
    return {
      taskId: request.taskId, units: [], repoGroups: [], destinations: [],
      linkage: { state: "no-declaration", edges: [] }, diagnostics: [],
    };
  }
  const derivation = deriveBoundServiceGroupPlan(bound);
  if (!derivation.ok) throw new DependencyRoutingRefused(unsatisfiedDeclarationMessage(derivation.unsatisfied));
  const { planned, units, dependencies, rules, layers, requests, runTypes } = derivation.plan;
  const environments = new Map(bound.map(({ launch }) => [launch.serviceId, launch.environmentName] as const));
  // The same two calls the Host's `setPlan` composes, with the same inputs and no
  // reservations on either path, so the read and the plan a start writes cannot
  // disagree about a port.
  const ports = reallocatePortAssignments({ taskId: request.taskId, units, requests, reservations: [], runTypes });
  const resolved = resolveTaskBindings({ rules, assignments: ports.assignments, units, layers });
  // The Host's own routing projection, called with the same bindings/assignments/
  // units. It fabricates nothing: a unit without an assignment reports no port and
  // a portless instance id.
  const routed = describeDependencyRouting({
    taskId: request.taskId,
    bindings: resolved.ok ? resolved.bindings : [],
    assignments: ports.assignments,
    units,
    environment: "",
  });
  const diagnostics: RunDiagnostic[] = [...ports.diagnostics, ...resolved.diagnostics];
  const reasonOf = (unitId: string, key: string): string | undefined =>
    diagnostics.find((entry) => entry.scope.key === key && (entry.scope.unitId === undefined || entry.scope.unitId === unitId))?.message;
  const destinations: TaskDependencyDestinationView[] = routed.flatMap((entry) =>
    entry.keys.map((boundKey) => {
      const reason = reasonOf(entry.unitId, boundKey.key);
      return {
        unitId: entry.unitId,
        serviceId: entry.serviceId,
        key: boundKey.key,
        // Every bound unit is local (see `TaskDependencyUnitView.location`), so the
        // plan's own assignment is what a routing target carries here: a resolved
        // address + port, never a synthesised one.
        target: entry.target.kind === "local-instance"
          ? {
              kind: "local-instance" as const,
              instanceId: entry.target.instanceId,
              address: entry.target.address,
              ...(entry.target.port === undefined ? {} : { port: entry.target.port }),
            }
          : { kind: "remote" as const, environment: environments.get(entry.serviceId) ?? "" },
        value: boundKey.value,
        readPoints: boundKey.readPoints.map((source) => ({ source, masked: false })),
        ...(reason === undefined ? {} : { reason }),
      };
    }),
  );
  // The variables NO declaration binds: their value stays where the config really
  // reads it (a repo/shared/private layer), so the consumer keeps the shared
  // environment address. This is the read-point audit `resolveTaskBindings` already
  // runs, read back here rather than re-derived, so the two cannot drift. With no
  // resolved binding at all the plan itself failed closed, and the named
  // diagnostics below are the honest answer instead of a destination per key.
  if (resolved.ok) {
    const boundKeys = new Set(destinations.map((entry) => `${entry.unitId}/${entry.key}`));
    // Also mask a shared/repo literal that happens to contain a private value
    // (the same rule the saved-config preview uses), so a private value cannot
    // ride out inside a row nobody tagged as secret.
    const privateValues = layers.privateEntries.map((entry) => entry.value).filter((value) => value.length > 0);
    const audit = auditBindingReadPoints({ bindings: resolved.bindings, units, layers });
    for (const unbound of audit.unboundKeys) {
      const id = `${unbound.unitId}/${unbound.key}`;
      const unit = units.find((entry) => entry.unitId === unbound.unitId);
      // The audit walks the plan's own units, so this cannot miss - but a key is
      // not attributed to a unit this read did not derive.
      if (boundKeys.has(id) || unit === undefined) continue;
      boundKeys.add(id);
      const row = layerRow(layers, unbound.source, unbound.key);
      // A private layer's row is MASKED even when its author did not tag it: the
      // page never receives a private value through this read.
      const masked = row === undefined || row.secret || isServiceSecretKey(unbound.key) || unbound.source === "本机私有配置"
        || privateValues.some((value) => row.value.includes(value));
      destinations.push({
        unitId: unbound.unitId,
        serviceId: unit.serviceId,
        key: unbound.key,
        target: { kind: "remote", environment: environments.get(unit.serviceId) ?? "" },
        readPoints: [{ source: unbound.source, masked, ...(masked || row === undefined ? {} : { value: row.value }) }],
        reason: `没有服务依赖声明把「${unbound.key}」绑定到本任务的本地实例「${unit.name}」，消费者会继续使用共享环境地址`,
      });
    }
  }
  const nameOf = new Map(units.map((unit) => [unit.unitId, unit.name] as const));
  // One stable order for the whole list: the plan's own unit order first, then the
  // key, so a bound destination and an unbound read point of the same plan never
  // swap places between two reads.
  const unitOrder = new Map(units.map((unit, index) => [unit.unitId, index] as const));
  destinations.sort((a, b) =>
    (unitOrder.get(a.unitId) ?? 0) - (unitOrder.get(b.unitId) ?? 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return {
    taskId: request.taskId,
    units: planned.map((entry) => {
      const source = bound.find((row) => row.launch.serviceId === entry.serviceId) as BoundServiceEntry;
      return {
        unitId: entry.unitId,
        serviceId: entry.serviceId,
        name: entry.name,
        repoDir: entry.repoDir,
        subdir: source.binding.subdir,
        templateVersion: source.launch.templateVersion,
        environment: source.launch.environmentName,
        location: "local",
        declaredPorts: entry.declared,
      };
    }),
    repoGroups: unitsByRepo(units).map((group) => ({ repoDir: group.repoDir, unitIds: group.units.map((unit) => unit.unitId) })),
    destinations,
    linkage: dependencies.length === 0
      ? { state: "no-declaration", edges: [] }
      : {
          state: "declared",
          edges: dependencies.map((edge) => ({
            from: edge.from,
            to: edge.to,
            fromName: nameOf.get(edge.from) ?? edge.from,
            toName: nameOf.get(edge.to) ?? edge.to,
            kind: edge.kind,
          })),
        },
    diagnostics: diagnostics.map((entry) => ({
      code: entry.code,
      message: entry.message,
      ...(entry.hint === undefined ? {} : { hint: entry.hint }),
    })),
  };
}

/** The row one layer holds for one key, if that layer names it at all. */
function layerRow(layers: BindingLayers, source: ServiceConfigSource, key: string): ServiceConfigEntry | undefined {
  const rows: Record<string, ServiceConfigEntry[]> = {
    "仓库默认配置": layers.repoDefaults,
    "共享模板": layers.shared,
    "本机私有配置": layers.privateEntries,
    "任务覆盖": layers.task,
    "运行时绑定": [],
  };
  return (rows[source] ?? []).find((entry) => entry.key.trim() === key);
}
