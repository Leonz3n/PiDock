/**
 * Multi-service topology rules for [PiDock 05] (#10).
 *
 * Pure, dependency-free module (same seam style as `service-config.ts` and
 * `multi-repo-provision.ts`): it runs identically in main, the
 * utilityProcess Host and unit tests. `service-config.ts` owns single
 * service rows (descriptor guard, env layering); this module adds the #10
 * boxes on top:
 *
 * - one repository can contribute several run units, and each unit is
 *   independently local or remote (box 1);
 * - ports are decided *before* any variable binding is resolved, and the
 *   task override row for a bound variable is a complete value (a full URL
 *   is replaced as a whole, never patched host/port) with its real read
 *   points audited against the config layers (box 2);
 * - two tasks running the same service name get different local ports
 *   because allocation sees the machine-wide reservations of the other
 *   tasks, so a request can only reach the owning task instance (box 3);
 * - call dependencies and prestart preconditions are separate edge kinds;
 *   a bidirectional pair (or any call cycle) becomes one listener group
 *   that listens first and is verified as a group instead of waiting for
 *   each other (box 4, spec "双向依赖不会造成永远等待启动");
 * - port competition, start failures and unreachable dependencies produce
 *   locatable diagnostics, and a reallocation updates every affected
 *   consumer binding (box 5).
 *
 * Run records, code/build freshness, process-identity stop scope and
 * shared external resources live in `service-runs.ts`.
 */

import type {
  ServiceConfigEntry,
  ServiceConfigSource,
  ServiceRunType,
} from "./service-config.js";

export type ServiceLocation = "local" | "remote";

/**
 * One selectable run unit. A repository can contribute several units
 * (`repoDir` + `serviceId`), and a unit may have no repository at all
 * (e.g. a task-local helper). `unitId` is the stable in-task key the
 * renderer, the Host and the bindings all use.
 */
export interface RunUnit {
  unitId: string;
  serviceId: string;
  name: string;
  repoDir?: string;
  location: ServiceLocation;
  /** Default run type; the runtime plan may still classify per unit. */
  runType?: ServiceRunType;
}

export type RunDiagnosticCode =
  | "empty-selection"
  | "duplicate-unit"
  | "invalid-unit"
  | "unit-repo-not-selected"
  | "unknown-unit"
  | "unknown-instance"
  | "missing-port"
  | "port-conflict"
  | "port-taken"
  | "port-unavailable"
  | "binding-conflict"
  | "missing-binding"
  | "unused-binding"
  | "start-order-conflict"
  | "start-failed"
  | "dependency-unreachable"
  | "shared-not-isolated";

/**
 * Locatable failure. `scope` names the exact unit / variable / port so the
 * UI can point at the offending row instead of a generic error, and `hint`
 * carries the actionable next step (spec 342/344: 引用缺失或存在冲突时提供
 * 可操作错误).
 */
export interface RunDiagnostic {
  code: RunDiagnosticCode;
  scope: { unitId?: string; key?: string; port?: number };
  message: string;
  hint?: string;
}

export function diagnostic(
  code: RunDiagnosticCode,
  scope: RunDiagnostic["scope"],
  message: string,
  hint?: string,
): RunDiagnostic {
  return hint === undefined ? { code, scope, message } : { code, scope, message, hint };
}

/** Stable instance identity for display and run records: `<taskId>/<serviceId>`. */
export function serviceInstanceId(taskId: string, serviceId: string): string {
  return `${taskId}/${serviceId}`;
}

/** Addressable instance handle: `<taskId>/<serviceId>@<port>` (port omitted for remote). */
export function instanceAddress(taskId: string, serviceId: string, port?: number): string {
  return port === undefined ? serviceInstanceId(taskId, serviceId) : `${serviceInstanceId(taskId, serviceId)}@${port}`;
}

/**
 * Validate the selected run units for one task. A unit whose `repoDir` is
 * set must belong to a repository the task actually selected (the #6 rule:
 * a task only contains repos it prepared); duplicate `unitId`s and blank
 * ids fail closed so the runtime never has two rows for one unit.
 */
export function validateRunUnitSelection(input: {
  selectedRepoDirs: readonly string[];
  units: readonly RunUnit[];
}): { ok: true; units: RunUnit[] } | { ok: false; error: RunDiagnostic } {
  if (input.units.length === 0) {
    return { ok: false, error: diagnostic("empty-selection", {}, "请至少选择一个要运行的单元") };
  }
  const repos = new Set(input.selectedRepoDirs);
  const seen = new Set<string>();
  for (const unit of input.units) {
    if (typeof unit.unitId !== "string" || unit.unitId.trim().length === 0 || typeof unit.serviceId !== "string" || unit.serviceId.trim().length === 0) {
      return {
        ok: false,
        error: diagnostic("invalid-unit", { unitId: unit.unitId }, "运行单元缺少稳定标识（unitId/serviceId）"),
      };
    }
    if (unit.name.trim().length === 0) {
      return { ok: false, error: diagnostic("invalid-unit", { unitId: unit.unitId }, `运行单元「${unit.unitId}」缺少名称`) };
    }
    if (seen.has(unit.unitId)) {
      return {
        ok: false,
        error: diagnostic("duplicate-unit", { unitId: unit.unitId }, `运行单元「${unit.unitId}」被选择了两次`, "请只保留一个来源"),
      };
    }
    seen.add(unit.unitId);
    if (unit.repoDir !== undefined && !repos.has(unit.repoDir)) {
      return {
        ok: false,
        error: diagnostic(
          "unit-repo-not-selected",
          { unitId: unit.unitId },
          `运行单元「${unit.name}」属于未加入任务的仓库「${unit.repoDir}」`,
          "请先把该仓库加入任务，或改选其他运行单元",
        ),
      };
    }
  }
  return { ok: true, units: [...input.units] };
}

/** Group units by owning repository; repo-less units stay last under `""`. */
export function unitsByRepo(units: readonly RunUnit[]): { repoDir: string; units: RunUnit[] }[] {
  const map = new Map<string, RunUnit[]>();
  for (const unit of units) {
    const key = unit.repoDir ?? "";
    const list = map.get(key);
    if (list) list.push(unit);
    else map.set(key, [unit]);
  }
  return [...map.entries()]
    .sort((a, b) => {
      if (a[0] === b[0]) return 0;
      if (a[0] === "") return 1;
      if (b[0] === "") return -1;
      return a[0] < b[0] ? -1 : 1;
    })
    .map(([repoDir, list]) => ({ repoDir, units: list }));
}

/** Switch one unit between local and remote (box 1: 选择哪些服务本地运行). */
export function setUnitLocation(
  units: readonly RunUnit[],
  unitId: string,
  location: ServiceLocation,
): { ok: true; units: RunUnit[] } | { ok: false; error: RunDiagnostic } {
  const target = units.find((unit) => unit.unitId === unitId);
  if (!target) {
    return { ok: false, error: diagnostic("unknown-unit", { unitId }, `运行单元「${unitId}」不存在`) };
  }
  return { ok: true, units: units.map((unit) => (unit.unitId === unitId ? { ...unit, location } : { ...unit })) };
}

export interface PortRequest {
  unitId: string;
  port: number;
}

/**
 * Machine-wide port reservation. Allocation must see the other tasks'
 * reservations, otherwise two tasks running the same service name would
 * both bind the same number and a request could reach the wrong instance
 * (box 3).
 */
export interface PortReservation {
  port: number;
  owner: "external" | "task";
  /** Owning task for `owner: "task"` (reservations of *this* task included). */
  taskId?: string;
  /** Owning unit within that task (`RunUnit.unitId`). */
  unitId?: string;
  serviceId?: string;
  note?: string;
}

export interface PortAssignment {
  unitId: string;
  serviceId: string;
  port: number;
  instanceId: string;
}

export interface PortPlan {
  assignments: PortAssignment[];
  /** Ports that moved off the requested value (all affected consumers must update). */
  reallocated: { unitId: string; before: number; after: number }[];
  diagnostics: RunDiagnostic[];
}

function reservationFor(reservations: readonly PortReservation[], port: number): PortReservation | undefined {
  return reservations.find((entry) => entry.port === port);
}

function portOwnerLabel(reservation: PortReservation): string {
  if (reservation.owner === "external") return reservation.note ? `外部占用（${reservation.note}）` : "已被外部进程占用";
  const instance = reservation.taskId && reservation.serviceId ? `${reservation.taskId}/${reservation.serviceId}` : reservation.unitId ?? "其他任务";
  return `已被任务实例 ${instance} 占用`;
}

/**
 * Strict port-first planning (box 2: 先确定端口并解析变量绑定，再启动服务).
 * Reports every conflict instead of moving anything:
 *
 * - a local *listener* (`long-lived`) without a requested port is a
 *   `missing-port` failure; a `prepare`/`one-shot` step binds no socket, so
 *   it needs no port and stays in the prestart group (`planStartGroups`);
 * - two units of *this* task asking for the same port is a `port-conflict`
 *   (never silently share one socket);
 * - a port reserved by another task or by an external process is
 *   `port-taken` with the owning instance named;
 * - a reservation this task already holds for the *same* unit is reused
 *   (restart planning), for a different unit of this task it is a
 *   `port-conflict`.
 */
export function planPortAssignments(input: {
  taskId: string;
  units: readonly RunUnit[];
  requests: readonly PortRequest[];
  reservations: readonly PortReservation[];
  /** Per-unit run type override; same precedence as `planStartGroups`. */
  runTypes?: Readonly<Record<string, ServiceRunType>>;
}): PortPlan {
  const diagnostics: RunDiagnostic[] = [];
  const assignments: PortAssignment[] = [];
  const requestedByUnit = new Map(input.requests.map((request) => [request.unitId, request.port]));
  const byPort = new Map<number, string[]>();
  for (const unit of input.units) {
    if (unit.location !== "local") continue;
    // Only a long-lived listener must own a port. A prepare/one-shot step is a
    // prestart member (see `planStartGroups`), so demanding a port for it made
    // the whole Host plan fail for any task with such a unit (the seeded
    // `db-migrate` row is local/prepare with no port).
    if ((input.runTypes?.[unit.unitId] ?? unit.runType ?? "long-lived") !== "long-lived") continue;
    const port = requestedByUnit.get(unit.unitId);
    if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
      diagnostics.push(
        diagnostic("missing-port", { unitId: unit.unitId }, `本地服务「${unit.name}」没有可用端口`, "请先分配端口，再解析变量绑定"),
      );
      continue;
    }
    byPort.set(port, [...(byPort.get(port) ?? []), unit.unitId]);
  }
  for (const [port, unitIds] of byPort) {
    if (unitIds.length < 2) continue;
    for (const unitId of unitIds) {
      diagnostics.push(
        diagnostic("port-conflict", { unitId, port }, `任务内有两个运行单元同时要求端口 ${port}`, "请给每个本地服务分配不同端口"),
      );
    }
  }
  const conflicted = new Set([...byPort.values()].filter((unitIds) => unitIds.length > 1).flat());
  for (const unit of input.units) {
    if (unit.location !== "local" || conflicted.has(unit.unitId)) continue;
    const port = requestedByUnit.get(unit.unitId);
    if (port === undefined) continue;
    const reservation = reservationFor(input.reservations, port);
    if (reservation) {
      const mine = reservation.owner === "task" && reservation.taskId === input.taskId && reservation.unitId === unit.unitId;
      if (!mine) {
        const code: RunDiagnosticCode = reservation.owner === "external" || reservation.taskId !== input.taskId ? "port-taken" : "port-conflict";
        diagnostics.push(
          diagnostic(
            code,
            { unitId: unit.unitId, port },
            `端口 ${port} ${portOwnerLabel(reservation)}`,
            code === "port-taken" ? "运行管理会重分配端口并更新受影响的消费者" : "请给每个本地服务分配不同端口",
          ),
        );
        continue;
      }
    }
    assignments.push({
      unitId: unit.unitId,
      serviceId: unit.serviceId,
      port,
      instanceId: serviceInstanceId(input.taskId, unit.serviceId),
    });
  }
  return { assignments, reallocated: [], diagnostics };
}

/**
 * Port-first planning with automatic reallocation (spec 344: 端口分配和进程
 * 启动之间可能出现竞争，运行管理在启动失败时重新解析受影响的地址或报告
 * 失败). Ports taken by another task or an external process are bumped to the
 * next free number (bounded at 100 steps) and reported per unit so every
 * affected consumer binding is rewritten; intra-task duplicates and the
 * exhaustion cap stay hard failures.
 */
export function reallocatePortAssignments(input: {
  taskId: string;
  units: readonly RunUnit[];
  requests: readonly PortRequest[];
  reservations: readonly PortReservation[];
  maxSteps?: number;
  /** Per-unit run type override; same precedence as `planStartGroups`. */
  runTypes?: Readonly<Record<string, ServiceRunType>>;
}): PortPlan {
  const strict = planPortAssignments(input);
  const hard = strict.diagnostics.filter((entry) => entry.code !== "port-taken");
  const takenPorts = strict.diagnostics.filter((entry) => entry.code === "port-taken").map((entry) => entry.scope.port)
    .filter((port): port is number => port !== undefined);
  const maxSteps = input.maxSteps ?? 100;
  const used = new Set<number>(input.reservations.map((reservation) => reservation.port));
  for (const assignment of strict.assignments) used.add(assignment.port);
  const requestedByUnit = new Map(input.requests.map((request) => [request.unitId, request.port]));
  const assignments: PortAssignment[] = [...strict.assignments];
  const reallocated: PortPlan["reallocated"] = [];
  const diagnostics: RunDiagnostic[] = [...hard];
  for (const unit of input.units) {
    if (unit.location !== "local") continue;
    const before = requestedByUnit.get(unit.unitId);
    if (before === undefined || !takenPorts.includes(before)) continue;
    let candidate = before;
    let steps = 0;
    while (used.has(candidate) && steps < maxSteps) {
      candidate += 1;
      steps += 1;
    }
    if (candidate > 65535 || used.has(candidate)) {
      diagnostics.push(
        diagnostic(
          "port-unavailable",
          { unitId: unit.unitId, port: before },
          `端口 ${before} 被占用，且在 ${maxSteps} 次尝试内找不到可用端口`,
          "请释放端口或手动指定本任务端口",
        ),
      );
      continue;
    }
    used.add(candidate);
    assignments.push({
      unitId: unit.unitId,
      serviceId: unit.serviceId,
      port: candidate,
      instanceId: serviceInstanceId(input.taskId, unit.serviceId),
    });
    reallocated.push({ unitId: unit.unitId, before, after: candidate });
  }
  return { assignments, reallocated, diagnostics: diagnostics.sort((a, b) => (a.scope.unitId ?? "").localeCompare(b.scope.unitId ?? "")) };
}

/**
 * One task-scoped variable binding: which local unit a consumer variable
 * routes to, and in which complete form. `template` may use `${port}` and
 * `${host}`; without a template the full URL / `host:port` is minted from
 * the assignment. The resolved row is a *whole* value, so a business row
 * holding a complete URL is replaced as a whole, never patched piecewise.
 */
export interface BindingRule {
  key: string;
  unitId: string;
  kind: "url" | "host-port";
  template?: string;
}

export interface ResolvedBinding {
  key: string;
  value: string;
  kind: "url" | "host-port";
  unitId: string;
  serviceId: string;
  instanceId: string;
  port: number;
  /** Config rows that actually read this key (spec 342 读取点核对). */
  readPoints: ServiceConfigSource[];
}

export interface BindingLayers {
  repoDefaults: ServiceConfigEntry[];
  shared: ServiceConfigEntry[];
  privateEntries: ServiceConfigEntry[];
  task: ServiceConfigEntry[];
}

const LOCAL_HOST = "127.0.0.1";

export function renderBindingValue(kind: "url" | "host-port", port: number, template?: string): string {
  if (template !== undefined && template.trim().length > 0) {
    return template.replace(/\$\{port\}/g, String(port)).replace(/\$\{host\}/g, LOCAL_HOST);
  }
  return kind === "url" ? `http://${LOCAL_HOST}:${port}` : `${LOCAL_HOST}:${port}`;
}

function readPointsOf(layers: BindingLayers, key: string): ServiceConfigSource[] {
  const points: [ServiceConfigSource, ServiceConfigEntry[]][] = [
    ["仓库默认配置", layers.repoDefaults],
    ["共享模板", layers.shared],
    ["本机私有配置", layers.privateEntries],
    ["任务覆盖", layers.task],
  ];
  return points.filter(([, entries]) => entries.some((entry) => entry.key.trim() === key)).map(([source]) => source);
}

/** Variable names a local unit's consumers would read (`saas-bff` → `SAAS_BFF_*`). */
export function endpointKeyCandidates(serviceId: string): string[] {
  const snake = serviceId.trim().replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
  if (snake.length === 0) return [];
  return [`${snake}_ENDPOINT`, `${snake}_URL`, `${snake}_BASE_URL`, `${snake}_HOST`];
}

/**
 * Resolve the task override rows from port assignments. Ports must already
 * be final (`planPortAssignments` / `reallocatePortAssignments`): a rule for
 * a local unit without an assignment fails closed with `missing-port`
 * instead of inventing a value. Two rules binding the same key to different
 * units is a `binding-conflict`; a binding no config row reads is recorded
 * as `unused-binding` (the read-point audit), and a repo/shared row that
 * *looks* like a read point for a local unit but has no binding is recorded
 * as `missing-binding` so the consumer cannot silently keep the shared
 * environment address.
 *
 * A rule pointing at a `remote` unit produces no task row: the shared
 * environment supplies the value (routing for remote targets is described
 * by `describeDependencyRouting`), so the task must not override it with a
 * local address.
 */
export function resolveTaskBindings(input: {
  rules: readonly BindingRule[];
  assignments: readonly PortAssignment[];
  units: readonly RunUnit[];
  layers: BindingLayers;
}): { ok: true; bindings: ResolvedBinding[]; diagnostics: RunDiagnostic[] } | { ok: false; diagnostics: RunDiagnostic[] } {
  const unitsById = new Map(input.units.map((unit) => [unit.unitId, unit]));
  const assignmentByUnit = new Map(input.assignments.map((assignment) => [assignment.unitId, assignment]));
  const diagnostics: RunDiagnostic[] = [];
  const byKey = new Map<string, ResolvedBinding>();
  const hard: RunDiagnostic[] = [];
  for (const rule of input.rules) {
    const key = rule.key.trim();
    const unit = unitsById.get(rule.unitId);
    if (!unit) {
      hard.push(diagnostic("unknown-unit", { unitId: rule.unitId, key }, `变量「${key}」绑定的运行单元「${rule.unitId}」不存在`));
      continue;
    }
    if (unit.location === "remote") continue;
    const assignment = assignmentByUnit.get(rule.unitId);
    if (!assignment) {
      hard.push(
        diagnostic("missing-port", { unitId: rule.unitId, key }, `变量「${key}」指向的本地服务「${unit.name}」还没有端口`, "请先完成端口分配"),
      );
      continue;
    }
    const existing = byKey.get(key);
    if (existing && existing.unitId !== rule.unitId) {
      hard.push(
        diagnostic(
          "binding-conflict",
          { key },
          `变量「${key}」同时绑定到「${existing.unitId}」和「${rule.unitId}」`,
          "请只保留一个去向，或改用不同变量名",
        ),
      );
      continue;
    }
    const readPoints = readPointsOf(input.layers, key);
    const binding: ResolvedBinding = {
      key,
      value: renderBindingValue(rule.kind, assignment.port, rule.template),
      kind: rule.kind,
      unitId: rule.unitId,
      serviceId: unit.serviceId,
      instanceId: assignment.instanceId,
      port: assignment.port,
      readPoints,
    };
    byKey.set(key, binding);
    if (readPoints.length === 0) {
      diagnostics.push(
        diagnostic("unused-binding", { key, unitId: rule.unitId }, `变量「${key}」绑定了任务地址，但配置里没有读取点`, "请确认变量名与业务配置一致"),
      );
    }
  }
  if (hard.length > 0) return { ok: false, diagnostics: [...hard, ...diagnostics] };
  const audit = auditBindingReadPoints({ bindings: [...byKey.values()], units: input.units, layers: input.layers });
  return { ok: true, bindings: [...byKey.values()], diagnostics: [...diagnostics, ...audit.diagnostics] };
}

/** Task override rows for the resolved bindings (never secret). */
export function bindingsToTaskRows(bindings: readonly ResolvedBinding[]): ServiceConfigEntry[] {
  return bindings.map((binding) => ({ key: binding.key, value: binding.value, secret: false }));
}

/**
 * Read-point audit (box 2: 完整 URL 覆盖规则经过实际配置读取点核对): a config
 * row that names an endpoint variable for a local unit but has no task
 * binding would keep pointing at the shared environment, so it is reported
 * as `missing-binding`. `unboundKeys` lists those rows; `directives` carry
 * the diagnostics for the UI.
 */
export function auditBindingReadPoints(input: {
  bindings: readonly ResolvedBinding[];
  units: readonly RunUnit[];
  layers: BindingLayers;
}): { unboundKeys: { key: string; source: ServiceConfigSource; unitId: string }[]; diagnostics: RunDiagnostic[] } {
  const boundKeys = new Set(input.bindings.map((binding) => binding.key.trim()));
  const points: [ServiceConfigSource, ServiceConfigEntry[]][] = [
    ["仓库默认配置", input.layers.repoDefaults],
    ["共享模板", input.layers.shared],
    ["本机私有配置", input.layers.privateEntries],
    ["任务覆盖", input.layers.task],
  ];
  const unboundKeys: { key: string; source: ServiceConfigSource; unitId: string }[] = [];
  const diagnostics: RunDiagnostic[] = [];
  for (const unit of input.units) {
    if (unit.location !== "local") continue;
    for (const candidate of endpointKeyCandidates(unit.serviceId)) {
      if (boundKeys.has(candidate)) continue;
      for (const [source, entries] of points) {
        if (!entries.some((entry) => entry.key.trim() === candidate)) continue;
        unboundKeys.push({ key: candidate, source, unitId: unit.unitId });
        diagnostics.push(
          diagnostic(
            "missing-binding",
            { key: candidate, unitId: unit.unitId },
            `${source}读取「${candidate}」，但本任务没有把该变量绑定到本地实例「${unit.name}」`,
            "请在运行面板把该变量绑定到当前任务的本地服务，否则消费者会继续使用共享环境地址",
          ),
        );
      }
    }
  }
  return { unboundKeys, diagnostics };
}

/**
 * Partial restart (box 5 / 验证方式 部分重启): only the running units whose
 * address, binding or template version actually changed restart; every other
 * instance keeps running, so restarting one service never restarts the task.
 * Pure: the caller (Host restart action) applies it once a real spawner
 * exists; until then the changed set is what the UI offers to restart.
 */
export function planRestartScope(input: {
  /** Unit ids currently running (registered process identities). */
  running: readonly string[];
  /** Units whose port moved during reallocation. */
  reallocated?: readonly { unitId: string }[];
  /** Units whose bound variables changed value. */
  changedBindings?: readonly { unitId: string }[];
  /** Units recorded against a template version other than the adopted one. */
  staleTemplate?: readonly string[];
}): { unitId: string; reason: "port-reallocated" | "binding-changed" | "template-version" }[] {
  const running = new Set(input.running);
  const out = new Map<string, "port-reallocated" | "binding-changed" | "template-version">();
  const claim = (unitId: string, reason: "port-reallocated" | "binding-changed" | "template-version") => {
    if (!running.has(unitId) || out.has(unitId)) return;
    out.set(unitId, reason);
  };
  for (const entry of input.reallocated ?? []) claim(entry.unitId, "port-reallocated");
  for (const entry of input.changedBindings ?? []) claim(entry.unitId, "binding-changed");
  for (const unitId of input.staleTemplate ?? []) claim(unitId, "template-version");
  return [...out.entries()]
    .map(([unitId, reason]) => ({ unitId, reason }))
    .sort((a, b) => (a.unitId < b.unitId ? -1 : 1));
}

export type DependencyKind = "call" | "prestart";

/**
 * `from` needs `to`: `call` is a runtime call dependency (B must listen
 * before A runs), `prestart` is a precondition (B must be *ready* — a
 * prepare step finished or a dependency verified — before A starts).
 */
export interface ServiceDependency {
  from: string;
  to: string;
  kind: DependencyKind;
}

export interface StartGroup {
  groupId: string;
  members: string[];
  reason: "prestart" | "listener-group" | "single";
  /** A call cycle (bidirectional pair) listens as one group. */
  bidirectional: boolean;
  /** Checks to run once the group reports listening (linkage + remote reachability). */
  verify: string[];
}

/**
 * Order the selected local units into start groups (box 4):
 *
 * 1. `prestart` group first — every `prepare`/`one-shot` unit runs to
 *    completion before the listeners (a precondition target that is itself
 *    a long-lived listener is ordered before its callers instead);
 * 2. call-dependency cycles (bidirectional services) collapse into one
 *    listener group: members listen together, then a mutual linkage check
 *    runs, so a bidirectional pair can never deadlock waiting for the
 *    other to become ready (spec 375);
 * 3. remaining listeners start in dependency order (callee group before
 *    caller group), each with its own readiness/linkage/remote checks; a
 *    `call` edge gets a linkage check, a `prestart` edge a readiness check
 *    (the two kinds stay distinguishable in the plan, box 4).
 *
 * Remote units are never started here; a dependency on a remote unit
 * becomes a reachability check on the consumer's group and the real gap is
 * reported before running (spec "真实仓库在运行前显示依赖缺口").
 */
export function planStartGroups(input: {
  units: readonly RunUnit[];
  dependencies: readonly ServiceDependency[];
  /** Per-unit run type override (falls back to `RunUnit.runType`, then long-lived). */
  runTypes?: Readonly<Record<string, ServiceRunType>>;
}): { groups: StartGroup[]; diagnostics: RunDiagnostic[] } {
  const diagnostics: RunDiagnostic[] = [];
  const unitsById = new Map(input.units.map((unit) => [unit.unitId, unit]));
  const deps = input.dependencies.filter((dep) => {
    if (!unitsById.has(dep.from) || !unitsById.has(dep.to)) {
      diagnostics.push(
        diagnostic(
          "unknown-unit",
          { unitId: unitsById.has(dep.from) ? dep.to : dep.from },
          `依赖声明引用了未选择的运行单元「${unitsById.has(dep.from) ? dep.to : dep.from}」`,
          "请重新选择运行单元或修正依赖声明",
        ),
      );
      return false;
    }
    return true;
  });
  const runTypeOf = (unit: RunUnit): ServiceRunType => input.runTypes?.[unit.unitId] ?? unit.runType ?? "long-lived";
  const locals = input.units.filter((unit) => unit.location === "local");
  const remoteIds = new Set(input.units.filter((unit) => unit.location === "remote").map((unit) => unit.unitId));

  // Prestart group: prepare/one-shot steps only. A long-lived service named
  // by a prestart edge is ordered before its consumers inside the listener
  // groups below, so the two dependency kinds stay distinct.
  const prestartMembers = new Set<string>();
  for (const unit of locals) {
    if (runTypeOf(unit) !== "long-lived") prestartMembers.add(unit.unitId);
  }
  const prestart = locals.filter((unit) => prestartMembers.has(unit.unitId)).map((unit) => unit.unitId);

  const listeners = locals.filter((unit) => !prestartMembers.has(unit.unitId)).map((unit) => unit.unitId);
  const listenerSet = new Set(listeners);
  const callEdges = new Map<string, string[]>();
  for (const id of listeners) callEdges.set(id, []);
  for (const dep of deps) {
    if (dep.kind !== "call" || !listenerSet.has(dep.from) || !listenerSet.has(dep.to)) continue;
    callEdges.get(dep.from)?.push(dep.to);
  }
  const components = stronglyConnectedComponents(listeners, callEdges);
  const componentOf = new Map<string, number>();
  components.forEach((members, index) => members.forEach((member) => componentOf.set(member, index)));
  const cyclic = new Set<number>();
  for (const dep of deps) {
    if (dep.kind !== "call" || !listenerSet.has(dep.from) || !listenerSet.has(dep.to)) continue;
    if (componentOf.get(dep.from) === componentOf.get(dep.to)) cyclic.add(componentOf.get(dep.from) as number);
  }
  // Precondition inside a listener group can never be satisfied: the whole
  // point of `prestart` is "B ready before A starts", which contradicts
  // "A and B listen together". Report instead of waiting forever.
  for (const dep of deps) {
    if (dep.kind !== "prestart" || remoteIds.has(dep.to) || !listenerSet.has(dep.from) || !listenerSet.has(dep.to)) continue;
    const merged = componentOf.get(dep.from) === componentOf.get(dep.to);
    if (merged) {
      diagnostics.push(
        diagnostic(
          "start-order-conflict",
          { unitId: dep.from },
          `「${dep.from}」要求「${dep.to}」先就绪，但两者属于同一个双向调用组，只能同时监听`,
          "请把前置条件改为调用依赖，或拆出独立的前置步骤",
        ),
      );
    }
  }
  const order = topologicalComponentOrder(components, deps, componentOf, listenerSet);
  const groups: StartGroup[] = [];
  if (prestart.length > 0) {
    groups.push({
      groupId: "prestart",
      members: prestart,
      reason: "prestart",
      bidirectional: false,
      verify: prestart.map((unitId) => `准备步骤完成检查 ${unitsById.get(unitId)?.name ?? unitId}`),
    });
  }
  for (const index of order) {
    const members = components[index] ?? [];
    const isCyclic = cyclic.has(index);
    groups.push({
      groupId: `listen-${index}`,
      members,
      reason: isCyclic || members.length > 1 ? "listener-group" : "single",
      bidirectional: isCyclic,
      verify: verifyStepsFor(members, deps, unitsById, remoteIds, isCyclic),
    });
  }
  return { groups, diagnostics };
}

function verifyStepsFor(
  members: readonly string[],
  deps: readonly ServiceDependency[],
  unitsById: ReadonlyMap<string, RunUnit>,
  remoteIds: ReadonlySet<string>,
  cyclic: boolean,
): string[] {
  const steps: string[] = [];
  for (const dep of deps) {
    if (!members.includes(dep.from)) continue;
    const target = unitsById.get(dep.to);
    if (!target) continue;
    if (remoteIds.has(dep.to)) {
      steps.push(`远程依赖可达性检查 ${target.name}（共享环境，不标记为任务内隔离）`);
      continue;
    }
    if (dep.kind === "prestart") {
      steps.push(`前置条件就绪检查 ${target.name}`);
      continue;
    }
    steps.push(`联通检查 ${target.name}（${dep.to}）`);
  }
  if (cyclic) steps.push("双向调用组联通检查（先监听再互验，不等待对方就绪）");
  return [...new Set(steps)];
}

/** Tarjan SCC, iterative-friendly recursive form (graphs here are small). */
function stronglyConnectedComponents(nodes: readonly string[], edges: ReadonlyMap<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;
  const visit = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of edges.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node) as number, low.get(next) as number));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) as number, index.get(next) as number));
      }
    }
    if (low.get(node) === index.get(node)) {
      const members: string[] = [];
      let popped: string | undefined;
      do {
        popped = stack.pop();
        if (popped === undefined) break;
        onStack.delete(popped);
        members.push(popped);
      } while (popped !== node);
      components.push(members.sort());
    }
  };
  for (const node of nodes) if (!index.has(node)) visit(node);
  return components;
}

/**
 * Condensed-graph order: a component that others call starts first. Ties
 * keep the input order so the plan is deterministic.
 */
function topologicalComponentOrder(
  components: readonly string[][],
  deps: readonly ServiceDependency[],
  componentOf: ReadonlyMap<string, number>,
  listenerSet: ReadonlySet<string>,
): number[] {
  // Both kinds order the target first: a call dependency needs the callee
  // listening, a prestart precondition needs the target ready. `from` calls
  // / needs `to`, so the edge in the condensed graph is `to → from`.
  const edges = new Map<number, Set<number>>();
  const indegree = new Map<number, number>();
  components.forEach((_members, index) => {
    edges.set(index, new Set());
    indegree.set(index, 0);
  });
  for (const dep of deps) {
    if (!listenerSet.has(dep.from) || !listenerSet.has(dep.to)) continue;
    const from = componentOf.get(dep.from);
    const to = componentOf.get(dep.to);
    if (from === undefined || to === undefined || from === to) continue;
    if (edges.get(to)?.has(from)) continue;
    edges.get(to)?.add(from);
    indegree.set(from, (indegree.get(from) ?? 0) + 1);
  }
  const ready = [...indegree.entries()].filter(([, count]) => count === 0).map(([index]) => index).sort((a, b) => a - b);
  const order: number[] = [];
  while (ready.length > 0) {
    const current = ready.shift() as number;
    order.push(current);
    for (const next of edges.get(current) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) {
        ready.push(next);
        ready.sort((a, b) => a - b);
      }
    }
  }
  for (const index of components.map((_members, i) => i)) if (!order.includes(index)) order.push(index);
  return order;
}

export type RoutingTarget =
  /** `port` is absent for a local step with no assignment (a `prepare`/`one-shot` unit owns no socket). */
  | { kind: "local-instance"; instanceId: string; serviceId: string; port?: number; address: string }
  | { kind: "remote"; environment: string };

/**
 * Actual dependency destination for the task view (box 1: 任务视图显示服务、
 * 本地/远程位置和实际依赖去向). One entry per selected unit: a local unit shows
 * the binding variables that route to its instance, a remote unit shows that
 * it resolves to the shared environment (never a local address).
 *
 * `consumers` lists the task's other local units. The task override layer is
 * merged into *every* service of the task, so any consumer reading that key
 * receives the task address; the exact read points are on the binding
 * (`ResolvedBinding.readPoints`) rather than guessed per unit.
 */
export interface RoutingEntry {
  unitId: string;
  serviceId: string;
  name: string;
  location: ServiceLocation;
  target: RoutingTarget;
  /** Binding variables routing to this unit (empty for remote units). */
  keys: { key: string; value: string; readPoints: ServiceConfigSource[] }[];
  consumers: string[];
}

export function describeDependencyRouting(input: {
  taskId: string;
  bindings: readonly ResolvedBinding[];
  assignments: readonly PortAssignment[];
  units: readonly RunUnit[];
  environment: string;
}): RoutingEntry[] {
  const localUnitIds = input.units.filter((unit) => unit.location === "local").map((unit) => unit.unitId);
  return input.units.map((unit) => {
    const keys = input.bindings
      .filter((binding) => binding.unitId === unit.unitId)
      .map((binding) => ({ key: binding.key, value: binding.value, readPoints: binding.readPoints }));
    const assignment = input.assignments.find((candidate) => candidate.unitId === unit.unitId);
    const target: RoutingTarget =
      unit.location === "remote"
        ? { kind: "remote", environment: input.environment }
        : {
            kind: "local-instance",
            instanceId: serviceInstanceId(input.taskId, unit.serviceId),
            serviceId: unit.serviceId,
            // Never fabricate a local address: a unit without a port
            // assignment reports no port and a portless instance id.
            ...(assignment !== undefined ? { port: assignment.port } : {}),
            address: instanceAddress(input.taskId, unit.serviceId, assignment?.port),
          };
    return {
      unitId: unit.unitId,
      serviceId: unit.serviceId,
      name: unit.name,
      location: unit.location,
      target,
      keys,
      consumers: localUnitIds.filter((candidate) => candidate !== unit.unitId),
    };
  });
}
