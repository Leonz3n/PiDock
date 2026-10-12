/**
 * [PiDock 05] (#10 box 4) main's group caller (`runtime.ts runTaskServiceGroup`):
 * its NAMED refusals and the declared-port rows it feeds the Host's plan.
 *
 * The neighbouring suites cover the other half of each fact:
 * `../host/service-group-linkage.test.ts` drives the caller against a REAL Host
 * and REAL children (the shipped route's observable behaviour), and
 * `service-execution-production.test.ts` drives the INSTALLED
 * `shell/serviceCatalogOp` handler.
 *
 * Here the task registry and the catalog are STUBS on purpose: a stub is the
 * only way to make the Host refuse a registration, and what these cases pin is
 * the exact named message and the exact plan payload main sends - not a child's
 * behaviour. This file starts no child process.
 */
import { describe, expect, it } from "vitest";
import type { HostTaskResult } from "../rpc/protocol.js";
import { runTaskServiceGroup, type PerTaskHostRegistry } from "./runtime.js";
import type { ServiceCatalog, ServiceLaunch, ServiceTaskBinding, ServiceTemplate } from "./service-catalog.js";

const PROJECT = "b36323d3-ff33-4e34-a873-536a9775788a";
const TASK = "task-1";
const REQUEST = { taskId: TASK, projectId: PROJECT };

type RouteTaskOp = PerTaskHostRegistry["routeTaskOp"];
type RouteTaskOpParams = Parameters<RouteTaskOp>[0];
type RouteTaskOpCall = { op: string; payload: Record<string, unknown> };

/**
 * The main-side seam with its answers under test control. `answer` decides what
 * the Host would have replied with; throwing is the Host's own refusal.
 */
function registry(answer: (params: RouteTaskOpCall) => Record<string, unknown>): { tasks: Pick<PerTaskHostRegistry, "routeTaskOp">; calls: RouteTaskOpCall[] } {
  const calls: RouteTaskOpCall[] = [];
  const routeTaskOp: RouteTaskOp = async (params: RouteTaskOpParams): Promise<HostTaskResult> => {
    const call = { op: params.op, payload: params.payload ?? {} };
    calls.push(call);
    return { workspaceId: "workspace-a", taskId: params.taskId, op: params.op, payload: answer(call) };
  };
  return { tasks: { routeTaskOp }, calls };
}

/** The named refusal message one call produced, or a sentinel when none was thrown. */
async function refusalOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "<no refusal thrown>";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function boundService(serviceId: string): { binding: ServiceTaskBinding; template: ServiceTemplate } {
  const identity = { taskId: TASK, createdAt: "2026-01-01T00:00:00.000Z", root: "/tasks", realRoot: "/tasks", dirId: TASK,
    directoryDevice: "1", directoryInode: "2" };
  return {
    binding: { taskId: TASK, projectId: PROJECT, identity, serviceId, templateVersion: 1, rootId: "repo-a",
      subdir: `svc-${serviceId}`, programPath: "/usr/bin/node", privateRefs: [] },
    template: { projectId: PROJECT, serviceId, version: 1,
      descriptor: { name: "API", program: "node", args: ["server.js"], ports: [], runType: "long-lived" }, shared: [] },
  };
}

function launchOf(serviceId: string, layers: ServiceLaunch["layers"]): ServiceLaunch {
  return {
    serviceId,
    templateVersion: 1,
    descriptor: { id: serviceId, name: "API", program: "/usr/bin/node", args: ["server.js"], cwd: `/tasks/${TASK}/repo-a/svc-${serviceId}`,
      ports: [], runType: "long-lived" },
    layers,
  };
}

const EMPTY_LAYERS: ServiceLaunch["layers"] = { repoDefaults: [], shared: [], privateEntries: [], task: [] };

describe("[PiDock 05] #10 main's group caller refuses by name", () => {
  it("names service-group-empty when the task has no bound service, before any Host call", async () => {
    const { tasks, calls } = registry(() => ({}));
    const catalog = {
      taskBindings: () => [],
      launchFor: () => { throw new Error("unreachable: no binding is resolved"); },
    } satisfies Pick<ServiceCatalog, "launchFor" | "taskBindings">;

    expect(await refusalOf(() => runTaskServiceGroup(tasks, catalog, REQUEST, 7)))
      .toBe("service-group-empty: 该任务在可信服务目录中没有已绑定的服务，未发起整组启动");
    // Nothing was registered, planned or started: the refusal precedes every op.
    expect(calls).toEqual([]);
  });

  it("names the unresolvable launch's service when the catalog cannot describe it", async () => {
    const { tasks, calls } = registry(() => ({}));
    const catalog = {
      taskBindings: () => [boundService("svc-a")],
      launchFor: () => { throw new Error("service-launch-unavailable"); },
    } satisfies Pick<ServiceCatalog, "launchFor" | "taskBindings">;

    expect(await refusalOf(() => runTaskServiceGroup(tasks, catalog, REQUEST, 7)))
      .toBe("服务登记失败，未发起整组启动：svc-a 的启动材料无法从可信服务目录解析（service-launch-unavailable）");
    expect(calls).toEqual([]);
  });

  it("names the Host's registration refusal and never turns it into a control request", async () => {
    const refusal = "service-registration-conflict: 该服务已由可信服务目录登记，界面配方不能覆盖其可执行描述符";
    const { tasks, calls } = registry(() => { throw new Error(refusal); });
    const catalog = {
      taskBindings: () => [boundService("svc-a")],
      launchFor: () => launchOf("svc-a", EMPTY_LAYERS),
    } satisfies Pick<ServiceCatalog, "launchFor" | "taskBindings">;

    expect(await refusalOf(() => runTaskServiceGroup(tasks, catalog, REQUEST, 7)))
      .toBe(`服务登记失败，未发起整组启动：${refusal}`);
    // A failed registration never becomes a control request: no group start and
    // no plan was sent after it.
    expect(calls.map((call) => call.op)).toEqual(["task/registerService"]);
  });

  it("refuses by name when the launch's own layers cannot be resolved before planning", async () => {
    // The defence-in-depth twin of the registration refusal above: this Host
    // answered the registration and holds no plan yet (`not-planned`), so main
    // derives the plan from the catalog - and the SAME layers it just registered
    // cannot be resolved. Refusing here keeps main from planning against rows it
    // could not read instead of sending a plan with the port rows dropped.
    const serviceId = "s-33333333-3333-3333-3333-333333333333";
    const { tasks, calls } = registry((call) => call.op === "task/controlService" ? { group: { state: "not-planned" } } : { ok: true });
    const unresolved: ServiceLaunch["layers"] = {
      repoDefaults: [], shared: [], privateEntries: [],
      task: [{ key: "API_URL", value: "${NOT_DEFINED}", secret: false }],
    };
    const catalog = {
      taskBindings: () => [boundService(serviceId)],
      launchFor: () => launchOf(serviceId, unresolved),
    } satisfies Pick<ServiceCatalog, "launchFor" | "taskBindings">;

    expect(await refusalOf(() => runTaskServiceGroup(tasks, catalog, REQUEST, 7))).toBe(
      `服务登记失败，未发起整组启动：${serviceId} 的启动材料无法从可信服务目录解析（missing-ref: 变量「API_URL」引用的 「NOT_DEFINED」 未定义）`,
    );
    // It refuses BEFORE planning: no plan op was sent, so no half-resolved group
    // reached the Host's port allocator.
    expect(calls.map((call) => call.op)).toEqual(["task/registerService", "task/controlService"]);
  });
});

describe("[PiDock 05] #10 main's group caller reads the worktree of every unit it registers", () => {
  it("carries main's own worktree read into the unit's registration, never a page claim", async () => {
    const serviceId = "s-44444444-4444-4444-4444-444444444444";
    const { tasks, calls } = registry((call) => call.op === "task/controlService" ? { group: { state: "not-planned" } } : { ok: true });
    const catalog = {
      taskBindings: () => [boundService(serviceId)],
      launchFor: () => launchOf(serviceId, EMPTY_LAYERS),
    } satisfies Pick<ServiceCatalog, "launchFor" | "taskBindings">;

    await runTaskServiceGroup(tasks, catalog, REQUEST, 7);

    // The registration main sends for a unit carries the observation or the named
    // reason it could not be made - here the fixture's launch cwd does not exist,
    // so it is the reason. Either way the field is main's own read: a page-attested
    // registration carrying it is refused by the Host (`host.ts`).
    const registration = calls.find((call) => call.op === "task/registerService");
    expect(registration?.payload["codeObservationFailure"]).toBe("启动描述符的工作目录不可读");
    expect("code" in (registration?.payload ?? {})).toBe(false);
  });
});

describe("[PiDock 05] #10 main's group plan reads the SAME declared-port rule as the registration", () => {
  it("feeds every resolved env layer, so a non-empty repoDefaults/task layer still produces its port row", async () => {
    const serviceId = "s-11111111-1111-1111-1111-111111111111";
    const layers: ServiceLaunch["layers"] = {
      repoDefaults: [{ key: "PORT", value: "53100", secret: false }],
      shared: [],
      privateEntries: [],
      task: [{ key: "HEALTH_PORT", value: "53101", secret: false }],
    };
    // `answer` is the Host: no plan yet (`not-planned`), so main plans from the
    // catalog and retries the start once - the shipped route's own sequence.
    const { tasks, calls } = registry((call) => call.op === "task/controlService" ? { group: { state: "not-planned" } } : { ok: true });
    const catalog = {
      taskBindings: () => [boundService(serviceId)],
      launchFor: () => launchOf(serviceId, layers),
    } satisfies Pick<ServiceCatalog, "launchFor" | "taskBindings">;

    await runTaskServiceGroup(tasks, catalog, REQUEST, 7);

    const planned = calls.find((call) => call.op === "task/planServiceGroup");
    // The port row is what the plan's port-first rule needs. Re-deriving a
    // SUBSET of the layers here (e.g. shared + privateEntries only) would send
    // `requests: []` and the plan would fail closed with a FALSE `missing-port`
    // for a service that really declares the port through its own layer.
    expect(planned?.payload["requests"]).toEqual([{ unitId: `repo-a:${serviceId}`, port: 53100 }]);
    expect(calls.filter((call) => call.op === "task/controlService")).toHaveLength(2);
    expect(calls.filter((call) => call.op === "task/registerService")).toHaveLength(1);
  });

  it("keeps a portless long-lived unit in the plan as a named refusal source instead of dropping it", async () => {
    // The counterpart of the case above, so this rule is never "fixed" by
    // omitting a unit: with no declared port the requests row is absent, which
    // is exactly what makes the Host's plan fail closed by name.
    const serviceId = "s-22222222-2222-2222-2222-222222222222";
    const { tasks, calls } = registry((call) => call.op === "task/controlService" ? { group: { state: "not-planned" } } : { ok: true });
    const catalog = {
      taskBindings: () => [boundService(serviceId)],
      launchFor: () => launchOf(serviceId, EMPTY_LAYERS),
    } satisfies Pick<ServiceCatalog, "launchFor" | "taskBindings">;

    await runTaskServiceGroup(tasks, catalog, REQUEST, 7);

    const planned = calls.find((call) => call.op === "task/planServiceGroup");
    expect(planned?.payload["requests"]).toEqual([]);
    expect(planned?.payload["units"]).toHaveLength(1);
  });
});
