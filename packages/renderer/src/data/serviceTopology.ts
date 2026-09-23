/**
 * Renderer view of the [PiDock 05] (#10) multi-service topology.
 *
 * The sandboxed renderer cannot import the shell's `service-topology.ts` /
 * `service-runs.ts` (importing shell modules would hand the page Node
 * access), so the display rules live here as an independent mirror, the
 * same way `directories.ts` mirrors `task-provision.ts`. `shellHost` prefers
 * the Host's own plan when the shell answers (`task/planServiceGroup` +
 * `task/serviceRunRecords`) and falls back to this projection in memory
 * mode, so both paths show the same vocabulary.
 *
 * Covered here: unit identity + local/remote location and the actual
 * dependency destination (box 1), start groups with bidirectional listener
 * groups (box 4), locatable failure labels (box 5), run-record freshness
 * labels (box 6) and shared-external-resource limits (box 7).
 */

import type {
  ExternalResourceView,
  Service,
  ServiceBuildFreshness,
  ServiceCodeState,
  ServiceFailureView,
  ServiceRunView,
  Task,
} from "./types";

/** `<taskId>/<serviceId>@<port>`; the port is omitted for remote targets. */
export function instanceAddress(taskId: string, serviceId: string, port?: number): string {
  const base = `${taskId}/${serviceId}`;
  return port === undefined ? base : `${base}@${port}`;
}

export type ServiceLocationView = "local" | "remote";

export interface ServiceUnitView {
  unitId: string;
  serviceId: string;
  name: string;
  repoDir?: string;
  location: ServiceLocationView;
  runType: "long-lived" | "prepare" | "one-shot";
  dependencies: { to: string; kind: "call" | "prestart" }[];
}

export interface ServiceRoutingView {
  unitId: string;
  key: string;
  value: string;
  target: { kind: "local-instance"; address: string; port?: number } | { kind: "remote"; environment: string };
}

export interface ServiceStartGroupView {
  groupId: string;
  members: string[];
  reason: "prestart" | "listener-group" | "single";
  bidirectional: boolean;
  verify: string[];
}

export interface ServiceTopologyView {
  taskId: string;
  units: ServiceUnitView[];
  repoGroups: { repoDir: string; units: ServiceUnitView[] }[];
  routing: ServiceRoutingView[];
  groups: ServiceStartGroupView[];
  diagnostics: ServiceFailureView[];
  knownLimits: string[];
  resources: { resourceId: string; name: string; kind: ExternalResourceView["kind"]; isolation: "isolated" | "not-isolated" | "unknown"; shared: boolean; note: string }[];
  records: { serviceId: string; name: string; run?: ServiceRunView }[];
}

/** One row per selected service, with its stable unit id and run type. */
export function serviceUnits(task: Task): ServiceUnitView[] {
  return task.services.map((service, index) => ({
    unitId: service.unitId ?? `${service.repo ?? ""}:${service.id || index}`,
    serviceId: service.id,
    name: service.name,
    ...(service.repo !== undefined ? { repoDir: service.repo } : {}),
    location: service.mode === "local" ? "local" : "remote",
    runType: service.runType ?? "long-lived",
    dependencies: service.dependencies ?? [],
  }));
}

export function unitsByRepoView(units: readonly ServiceUnitView[]): ServiceTopologyView["repoGroups"] {
  const map = new Map<string, ServiceUnitView[]>();
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

/**
 * Mirror of the shell's `planStartGroups`: prepare/one-shot steps first,
 * call cycles merged into one bidirectional listener group (listen first,
 * verify as a group, never wait for each other), remaining listeners in
 * dependency order with a readiness check for `prestart` edges and a
 * reachability check for remote targets.
 */
export function serviceStartGroups(
  units: readonly ServiceUnitView[],
  environment: string,
): ServiceStartGroupView[] {
  const byId = new Map(units.map((unit) => [unit.unitId, unit]));
  const deps = units.flatMap((unit) => unit.dependencies.map((dep) => ({ from: unit.unitId, to: dep.to, kind: dep.kind })));
  const locals = units.filter((unit) => unit.location === "local");
  const prestart = locals.filter((unit) => unit.runType !== "long-lived").map((unit) => unit.unitId);
  const listeners = locals.filter((unit) => unit.runType === "long-lived").map((unit) => unit.unitId);
  const listenerSet = new Set(listeners);
  const edges = new Map<string, string[]>();
  for (const id of listeners) edges.set(id, []);
  for (const dep of deps) {
    if (dep.kind !== "call" || !listenerSet.has(dep.from) || !listenerSet.has(dep.to)) continue;
    edges.get(dep.from)?.push(dep.to);
  }
  const components: string[][] = [];
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
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
  for (const node of listeners) if (!index.has(node)) visit(node);
  const componentOf = new Map<string, number>();
  components.forEach((members, position) => members.forEach((member) => componentOf.set(member, position)));
  const cyclic = new Set<number>();
  for (const dep of deps) {
    if (dep.kind !== "call" || !listenerSet.has(dep.from) || !listenerSet.has(dep.to)) continue;
    const from = componentOf.get(dep.from);
    if (from !== undefined && from === componentOf.get(dep.to)) cyclic.add(from);
  }
  const order = componentOrder(components, deps, componentOf, listenerSet);
  const groups: ServiceStartGroupView[] = [];
  if (prestart.length > 0) {
    groups.push({
      groupId: "prestart",
      members: prestart,
      reason: "prestart",
      bidirectional: false,
      verify: prestart.map((unitId) => `准备步骤完成检查 ${byId.get(unitId)?.name ?? unitId}`),
    });
  }
  order.forEach((component) => {
    const members = components[component] ?? [];
    const isCyclic = cyclic.has(component);
    const verify: string[] = [];
    for (const dep of deps) {
      if (!members.includes(dep.from)) continue;
      const target = byId.get(dep.to);
      if (!target || target.location !== "local") {
        if (target) verify.push(`远程依赖可达性检查 ${target.name}（共享环境 ${environment}，不标记为任务内隔离）`);
        continue;
      }
      verify.push(dep.kind === "prestart" ? `前置条件就绪检查 ${target.name}` : `联通检查 ${target.name}（${dep.to}）`);
    }
    if (isCyclic) verify.push("双向调用组联通检查（先监听再互验，不等待对方就绪）");
    groups.push({
      groupId: `listen-${component}`,
      members,
      reason: isCyclic || members.length > 1 ? "listener-group" : "single",
      bidirectional: isCyclic,
      verify: [...new Set(verify)],
    });
  });
  return groups;
}

function componentOrder(
  components: readonly string[][],
  deps: readonly { from: string; to: string; kind: "call" | "prestart" }[],
  componentOf: ReadonlyMap<string, number>,
  listenerSet: ReadonlySet<string>,
): number[] {
  const edges = new Map<number, Set<number>>();
  const indegree = new Map<number, number>();
  components.forEach((_members, position) => {
    edges.set(position, new Set());
    indegree.set(position, 0);
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
  const ready = [...indegree.entries()].filter(([, count]) => count === 0).map(([position]) => position).sort((a, b) => a - b);
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
  for (const position of components.map((_members, i) => i)) if (!order.includes(position)) order.push(position);
  return order;
}

/**
 * Where each consumer variable actually goes (box 1). A local service with a
 * port resolves to its own instance address; a remote service resolves to
 * the shared environment and never to a local address.
 */
export function serviceRouting(task: Task, environment: string): ServiceRoutingView[] {
  const units = serviceUnits(task);
  const routing: ServiceRoutingView[] = [];
  for (const unit of units) {
    const service = task.services.find((candidate) => candidate.id === unit.serviceId);
    const keys = serviceDependencyKeys(service);
    for (const key of keys) {
      routing.push({
        unitId: unit.unitId,
        key,
        value: unit.location === "local" ? endpointAddress(task.id, unit, service) : environment,
        target: unit.location === "local" ? { kind: "local-instance", address: instanceAddress(task.id, unit.serviceId, service?.port), ...(service?.port !== undefined ? { port: service.port } : {}) } : { kind: "remote", environment },
      });
    }
  }
  return routing;
}

function endpointAddress(taskId: string, unit: ServiceUnitView, service: Service | undefined): string {
  if (service?.port === undefined) return instanceAddress(taskId, unit.serviceId);
  return `http://127.0.0.1:${service.port}`;
}

/** Variables the effective config reads for this service, e.g. `INVOICE_SERVICE_ENDPOINT`. */
function serviceDependencyKeys(service: Service | undefined): string[] {
  if (!service) return [];
  return service.resolved.filter((row) => /(_ENDPOINT|_URL|_BASE_URL|_HOST)$/.test(row.key)).map((row) => row.key);
}

/** Locatable failure entries for the task view (box 5), one per failing unit. */
export function serviceDiagnostics(task: Task): ServiceFailureView[] {
  const failing = task.services.filter((service) => service.failure !== undefined);
  return failing.map((service) => service.failure as ServiceFailureView);
}

/** Display label + hint for a diagnostic code (mirror of the shell vocabulary). */
export function failureLabel(code: string): { label: string; hint: string } {
  switch (code) {
    case "port-taken":
      return { label: "端口被占用", hint: "重新分配端口后会更新受影响的消费者" };
    case "port-conflict":
      return { label: "任务内端口冲突", hint: "请给每个本地服务分配不同端口" };
    case "port-unavailable":
      return { label: "没有可用端口", hint: "请释放端口或手动指定本任务端口" };
    case "start-failed":
      return { label: "启动失败", hint: "查看该实例的运行日志后重试" };
    case "dependency-unreachable":
      return { label: "依赖不可达", hint: "本地启动成功不等于功能验证成功" };
    case "missing-binding":
      return { label: "缺少变量绑定", hint: "消费者仍在用共享环境地址" };
    case "unused-binding":
      return { label: "绑定没有读取点", hint: "请确认变量名与业务配置一致" };
    case "binding-conflict":
      return { label: "变量去向冲突", hint: "请只保留一个去向" };
    case "shared-not-isolated":
      return { label: "共享外部资源", hint: "不标记为任务隔离成功" };
    default:
      return { label: "运行问题", hint: "请核对运行配置后重试" };
  }
}

/** Build-rfreshness label: an old build and uncommitted code read differently (box 6). */
export function buildFreshnessLabel(freshness: ServiceBuildFreshness): string {
  switch (freshness) {
    case "fresh":
      return "构建与当前提交一致";
    case "stale-build":
      return "构建来自旧提交";
    case "uncommitted-code":
      return "工作副本有未提交修改，构建不含这些改动";
    default:
      return "无法判断构建状态";
  }
}

export function codeStateLabel(state: ServiceCodeState): string {
  switch (state) {
    case "committed-clean":
      return "已提交且干净";
    case "uncommitted":
      return "有未提交修改";
    default:
      return "缺少提交信息";
  }
}

/** Mirror of the shell's `classifyExternalResource`: never isolated without proof. */
export function classifySharedResource(resource: ExternalResourceView): {
  resourceId: string;
  name: string;
  kind: ExternalResourceView["kind"];
  shared: boolean;
  isolation: "isolated" | "not-isolated" | "unknown";
  note: string;
} {
  const label =
    resource.kind === "queue"
      ? "固定异步队列"
      : resource.kind === "dtm-callback"
        ? "DTM 回调地址"
        : resource.kind === "database"
          ? "外部数据库"
          : resource.kind === "cache"
            ? "外部缓存"
            : resource.kind === "object-storage"
              ? "外部对象存储"
              : "外部资源";
  if (resource.isolatedByTask === true) {
    return { ...resource, shared: false, isolation: "isolated", note: `${label}「${resource.name}」已按任务隔离（有独立实例证据）` };
  }
  const pinned = resource.kind === "queue" || resource.kind === "dtm-callback";
  return {
    ...resource,
    shared: true,
    isolation: pinned ? "not-isolated" : "unknown",
    note: pinned
      ? `${label}「${resource.name}」是共享外部资源：消费端与回调端仍指向同一实例，不标记为任务隔离成功`
      : `${label}「${resource.name}」未验证任务隔离，按共享资源对待`,
  };
}

/** The full task-view projection used by the runtime panel (memory mode). */
export function projectServiceTopology(task: Task, environment: string): ServiceTopologyView {
  const units = serviceUnits(task);
  const resources = (task.externalResources ?? []).map(classifySharedResource);
  return {
    taskId: task.id,
    units,
    repoGroups: unitsByRepoView(units),
    routing: serviceRouting(task, environment),
    groups: serviceStartGroups(units, environment),
    diagnostics: serviceDiagnostics(task),
    knownLimits: resources.filter((resource) => resource.shared).map((resource) => resource.note),
    resources,
    records: task.services.map((service) => ({
      serviceId: service.id,
      name: service.name,
      ...(service.runRecord !== undefined ? { run: service.runRecord } : {}),
    })),
  };
}
