/**
 * [PiDock 04] #7 box 2 (读取点核对 over the 完整地址覆盖规则) + [PiDock 05] #10:
 * the read-point audit and the resolved address, proven over a REAL production
 * group start instead of an empty plan.
 *
 * Evidence split (stated, not implied):
 * - REAL catalog: the trusted `ServiceCatalog` on a temp profile; the caller's
 *   shared template reads the callee's address under a real business name, and
 *   the caller's declaration is written on the pinned revision.
 * - REAL Host: one module instance of `./host.js` on a temp task folder with a
 *   fake parent port (the seam `service-group-declaration.test.ts` uses).
 * - REAL children: Node HTTP servers started by the Host's own
 *   `TaskServiceProcesses` driver through the gated `task/controlService`. Each
 *   child reports the `CALLEE_API_URL` value ITS OWN env really carried, so the
 *   winning layer is read back from the running process - and the address the
 *   child printed is compared with the address the Host's linkage step really
 *   reached.
 * - PRODUCTION caller: `../main/runtime.ts runTaskServiceGroup`, the shipped
 *   `shell/serviceCatalogOp {op:"runTaskServiceGroup"}` route.
 *
 * What the audit really is here: main derives the plan's `rules` (which
 * variable binds to which local instance) and `layers` (the config rows the
 * bound services really read) from its own catalog and sends them with the
 * plan, so `TaskServiceTopology.setPlan` resolves bindings and runs
 * `auditBindingReadPoints` over NON-EMPTY inputs. The three states pinned here
 * are the real ones:
 *  - a declared target whose address row the config reads  → silent audit;
 *  - a read address row with NO declaration                → `missing-binding`
 *    (and the child keeps the shared environment address);
 *  - a declaration that follows no convention name         → `unused-binding`
 *    (a bound address variable no row reads).
 * A fourth case is the fail-closed one: a trusted layer that cannot resolve
 * refuses the whole group by name and starts nothing.
 *
 * Process hygiene: every pid this suite starts is stopped through the Host's own
 * registered-child stop in `afterEach`; the user's own dev servers are never
 * signalled (only pids this suite's children reported are ever touched).
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "../rpc/host-client.js";
import { runTaskServiceGroup } from "../main/runtime.js";
import { ServiceCatalog, type ServiceCatalogAuthority, type ServiceTemplateDependency } from "../main/service-catalog.js";
import { diskTaskStore } from "./task-host.js";
import { buildTaskDiskRecord } from "./task-store.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

/**
 * A real HTTP service that reports the address variable ITS OWN env carried. The
 * value is what the running child really ran with, so it is the evidence for
 * which layer won - and it is compared against the address the Host's linkage
 * step really reached.
 */
const REPORTING_SCRIPT = `const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const tag = process.env.SERVICE_TAG;
const port = Number(process.env.PORT ?? process.env.LISTEN_ON);
fs.appendFileSync(process.env.ORDER_FILE, tag + ":" + process.pid + "\\n");
const server = http.createServer((_request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({
    tag, pid: process.pid, port, dir: path.basename(process.cwd()),
    address: process.env.CALLEE_API_URL ?? null,
  }));
});
server.listen(port, "127.0.0.1", () => {
  fs.writeFileSync(path.join(process.cwd(), "listening.txt"), String(process.pid));
  console.log("listening:" + tag);
});
setInterval(() => {}, 1000);
`;

const WAIT_MS = 30_000;
const POLL_MS = 25;
const SHARED_ADDRESS = "https://callee.shared.example";
/** The machine-private address this machine really has for the callee, i.e. the layer the task override must beat. */
const STALE_ADDRESS = "http://127.0.0.1:1";
const CALLEE_KEY = "CALLEE_API_URL";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw Error("no ephemeral port");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let elapsed = 0; elapsed < WAIT_MS; elapsed += POLL_MS) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw Error(`timed out waiting for ${label}`);
}

/** OS liveness of a pid this suite really started; a zombie is not alive. */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) throw Error(`invalid-pid: ${pid}`);
  try { process.kill(pid, 0); } catch { return false; }
  const { execFileSync } = process.getBuiltinModule("node:child_process") as typeof import("node:child_process");
  try {
    const state = execFileSync("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return state.length > 0 && !state.startsWith("Z");
  } catch {
    return false;
  }
}

interface Answer { tag: string; pid: number; port: number; dir: string; address: string | null }

/** One real HTTP request; the reply names the instance and the address variable it ran with. */
async function ask(port: number): Promise<Answer | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/whoami`);
    if (!response.ok) return null;
    return (await response.json()) as Answer;
  } catch {
    return null;
  }
}

function portPair() {
  const child = new EventEmitter() as EventEmitter & { postMessage(value: unknown): void; kill(): void };
  const parent = new EventEmitter() as EventEmitter & { postMessage(value: unknown): void };
  child.postMessage = (value) => { parent.emit("message", { data: value }); };
  parent.postMessage = (value) => { child.emit("message", value); };
  return { child, parent };
}

function orderOf(orderPath: string): [string, string][] {
  try {
    return readFileSync(orderPath, "utf8").trim().split("\n").filter((line) => line.length > 0).map((line) => {
      const [tag, pid] = line.split(":");
      return [tag ?? "", pid ?? ""] as [string, string];
    });
  } catch {
    return [];
  }
}

interface SharedRow { key: string; value: string; secret: false }
interface PrivateRef { key: string; envRef: string }

interface Fixture {
  taskId: string;
  taskDir: string;
  callerId: string;
  calleeId: string;
  portA: number;
  portB: number;
  orderPath: string;
  startGroupThroughMain(): Promise<Record<string, unknown>>;
  /** Every op main routed to the Host, in order. */
  routed(): { op: string; payload: Record<string, unknown> }[];
  /** The Host's own plan answers, in order (what the audit really returned). */
  planAnswers(): Record<string, unknown>[];
  request(op: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/**
 * One provisioned task with a caller/callee pair, a real Host and a real catalog.
 *
 * `declaration` is written into the caller's FIRST revision (the one the task
 * pins), exactly as the environment page writes it. `callerShared` are the rows
 * the caller's shared template carries besides its `SERVICE_TAG` - the read
 * points the audit examines. `callerPrivateRefs` add machine-private rows to the
 * caller's binding, which is how one key can be set in three layers at once.
 */
async function fixture(options: {
  declaration?: { to: "caller" | "callee"; kind: ServiceTemplateDependency["kind"] }[];
  callerShared?: SharedRow[];
  callerPrivateRefs?: PrivateRef[];
} = {}): Promise<Fixture> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-binding-readpoints-")));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const profile = join(home, "profile");
  const root = join(home, "tasks");
  const taskId = "task-1a2b3c4d";
  const taskDir = join(root, taskId);
  const projectId = randomUUID();
  mkdirSync(profile, { mode: 0o700 });
  for (const subdir of ["svc-a", "svc-b"]) mkdirSync(join(taskDir, "repo-a", subdir), { recursive: true });
  writeFileSync(join(taskDir, "repo-a", "svc-a", "service.cjs"), REPORTING_SCRIPT);
  writeFileSync(join(taskDir, "repo-a", "svc-b", "service.cjs"), REPORTING_SCRIPT);
  const orderPath = join(taskDir, "order.txt");
  diskTaskStore.writeTask(taskDir, buildTaskDiskRecord({
    taskId, name: "Bindings", dirId: taskId, branch: "task/main", root, taskDir,
    remoteBranch: "main", baseCommit: "source-fixture", repos: ["repo-a"], now: "2026-01-01T00:00:00.000Z",
  }));
  const [portA, portB] = [await freePort(), await freePort()];

  const taskStat = statSync(taskDir, { bigint: true });
  const identity = { taskId, createdAt: "2026-01-01T00:00:00.000Z", root, realRoot: root, dirId: taskId,
    directoryDevice: taskStat.dev.toString(), directoryInode: taskStat.ino.toString() };
  const owner = (id: string) => id === taskId ? { identity, projectId, rootIds: ["repo-a"] } : null;
  const authority: ServiceCatalogAuthority = { projectExists: (id) => id === projectId, task: (id) => owner(id), verifiedTask: (id) => owner(id) };
  const catalog = new ServiceCatalog(profile, authority);
  const environmentId = catalog.createEnvironment({ projectId, name: "开发环境" }).environmentId;

  const pair = portPair();
  pair.child.kill = vi.fn(() => { pair.child.emit("exit", 0); });
  const previous = Object.getOwnPropertyDescriptor(process, "parentPort");
  Object.defineProperty(process, "parentPort", { configurable: true, value: pair.parent });
  cleanups.push(() => {
    if (previous) Object.defineProperty(process, "parentPort", previous);
    else Reflect.deleteProperty(process, "parentPort");
  });
  for (const [name, value] of Object.entries({ PIDOCK_WORKSPACE_ID: "workspace-a", PIDOCK_TASK_ID: taskId, PIDOCK_TASK_DIR: taskDir,
    PIDOCK_PROTECTED_PROFILE: profile, PIDOCK_GROUP_PORT_A: String(portA), PIDOCK_GROUP_PORT_B: String(portB),
    PIDOCK_GROUP_ORDER_FILE: orderPath, PIDOCK_GROUP_STALE_ADDRESS: STALE_ADDRESS })) {
    vi.stubEnv(name, value);
  }
  vi.resetModules();
  const { startHost } = await import("./host.js");
  startHost();
  const client = new HostClient(pair.child as never);
  cleanups.push(() => { client.dispose(); pair.child.emit("exit", 0); });

  const routedOps: { op: string; payload: Record<string, unknown> }[] = [];
  const hostPlans: Record<string, unknown>[] = [];
  const mainRoute = {
    routeTaskOp: async (params: { taskId: string; op: string; payload?: Record<string, unknown>; origin?: unknown }) => {
      routedOps.push({ op: params.op, payload: params.payload ?? {} });
      const result = await client.task({
        workspaceId: "workspace-a", taskId: params.taskId, op: params.op as never, payload: params.payload ?? {},
        ...(params.origin !== undefined ? { origin: params.origin } : {}),
      } as never);
      // The Host answers a plan with `{plan}`, so unwrap it: the assertions below
      // read the audit's OWN output (bindings + read points), not a copy.
      if (params.op === "task/planServiceGroup") {
        const payload = result.payload as { plan?: Record<string, unknown> };
        hostPlans.push(payload.plan ?? (payload as Record<string, unknown>));
      }
      return result;
    },
  };

  const request = async (op: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    try {
      const result = await client.task({ workspaceId: "workspace-a", taskId, op: op as never, payload });
      return result.payload as Record<string, unknown>;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };

  const calleeTemplate = catalog.saveTemplate({
    projectId, environmentId,
    descriptor: { name: "Callee API", program: "node", args: ["service.cjs"], ports: [], runType: "long-lived" },
    shared: [{ key: "SERVICE_TAG", value: "callee", secret: false }],
  });
  const callerDeclared = (options.declaration ?? []).filter((edge) => edge.to === "callee");
  const callerTemplate = catalog.saveTemplate({
    projectId, environmentId,
    descriptor: { name: "Caller API", program: "node", args: ["service.cjs"], ports: [], runType: "long-lived" },
    shared: [{ key: "SERVICE_TAG", value: "caller", secret: false }, ...(options.callerShared ?? [])],
    ...(callerDeclared.length === 0 ? {} : { dependencies: callerDeclared.map((edge) => ({ to: calleeTemplate.serviceId, kind: edge.kind })) }),
  });
  const calleeDeclared = (options.declaration ?? []).filter((edge) => edge.to === "caller");
  const calleeRevision = calleeDeclared.length === 0 ? calleeTemplate : catalog.saveTemplate({
    projectId, environmentId, serviceId: calleeTemplate.serviceId, expectedVersion: 1,
    descriptor: calleeTemplate.descriptor, shared: calleeTemplate.shared,
    dependencies: calleeDeclared.map((edge) => ({ to: callerTemplate.serviceId, kind: edge.kind })),
  });
  catalog.bindTask({ taskId, serviceId: callerTemplate.serviceId, environmentId, templateVersion: 1, rootId: "repo-a", subdir: "svc-a",
    programPath: realpathSync(process.execPath),
    privateRefs: [{ key: "PORT", envRef: "PIDOCK_GROUP_PORT_A" }, { key: "ORDER_FILE", envRef: "PIDOCK_GROUP_ORDER_FILE" },
      ...(options.callerPrivateRefs ?? [])] });
  catalog.bindTask({ taskId, serviceId: calleeTemplate.serviceId, environmentId, templateVersion: calleeRevision.version, rootId: "repo-a", subdir: "svc-b",
    programPath: realpathSync(process.execPath),
    privateRefs: [{ key: "PORT", envRef: "PIDOCK_GROUP_PORT_B" }, { key: "ORDER_FILE", envRef: "PIDOCK_GROUP_ORDER_FILE" }] });

  const value: Fixture = {
    taskId, taskDir, callerId: callerTemplate.serviceId, calleeId: calleeTemplate.serviceId, portA, portB, orderPath,
    startGroupThroughMain: async () => {
      try {
        return await runTaskServiceGroup(mainRoute as never, catalog, { taskId, projectId }, 7);
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
    routed: () => routedOps.map((entry) => ({ ...entry })),
    planAnswers: () => hostPlans.map((entry) => ({ ...entry })),
    request,
  };

  cleanups.push(async () => {
    for (const serviceId of [value.callerId, value.calleeId]) {
      await request("task/controlService", { serviceId, action: "stop", label: "suite cleanup" });
    }
    for (const [, pidText] of orderOf(orderPath)) {
      const pid = Number(pidText);
      if (!Number.isInteger(pid) || pid <= 1) continue;
      if (alive(pid)) {
        try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  });
  return value;
}

interface GroupPayload {
  state: string;
  groups: string[];
  units: Record<string, unknown>[];
  diagnostics: { code: string; scope: Record<string, unknown>; message: string; hint?: string }[];
}

async function groupOf(f: Fixture): Promise<GroupPayload> {
  const result = await f.startGroupThroughMain();
  const group = result["group"] as GroupPayload | undefined;
  if (!group) throw Error(`no group in the answer: ${JSON.stringify(result)}`);
  return group;
}

function unitOf(group: GroupPayload, serviceId: string): Record<string, unknown> {
  const unit = group.units.find((entry) => entry["serviceId"] === serviceId);
  if (!unit) throw Error(`no unit for ${serviceId}`);
  return unit;
}

/** The planning diagnostics of one code, as the group answer carries them. */
function diagnosticsOf(group: GroupPayload, code: string) {
  return group.diagnostics.filter((entry) => entry.code === code);
}

describe.skipIf(process.platform === "win32")("[PiDock 04] #7 box 2 the read-point audit and the address the children really run with", () => {
  it("is silent over a complete binding, and the real child runs with the plan's task-layer address", { timeout: 60_000 }, async () => {
    // The SAME address variable is set in THREE layers: the shared template
    // (environment address), this machine's private config (a stale address) and
    // the plan's resolved task override (the local instance the declaration
    // authorised). The child must run with the task override.
    const f = await fixture({
      declaration: [{ to: "callee", kind: "call" }],
      callerShared: [{ key: CALLEE_KEY, value: SHARED_ADDRESS, secret: false }],
      callerPrivateRefs: [{ key: CALLEE_KEY, envRef: "PIDOCK_GROUP_STALE_ADDRESS" }],
    });

    const group = await groupOf(f);
    expect(group.state).toBe("verified");

    // (1) The audit's INPUT is non-empty and trusted: main derived the binding
    // rule from the callee's own address row and sent the config layers the
    // services really read. MUTATION GUARD: empty rules (or empty layers) would
    // make the silence below vacuous, so both are asserted to carry the real row.
    const planned = f.routed().find((entry) => entry.op === "task/planServiceGroup");
    expect(planned?.payload["rules"]).toEqual([{ key: CALLEE_KEY, unitId: `repo-a:${f.calleeId}`, kind: "url" }]);
    const sentLayers = planned?.payload["layers"] as { shared: SharedRow[]; privateEntries: SharedRow[]; task: SharedRow[] };
    expect(sentLayers.shared).toContainEqual({ key: CALLEE_KEY, value: SHARED_ADDRESS, secret: false });
    // A machine-private row is marked secret by the catalog itself, unlike a
    // shared literal.
    expect(sentLayers.privateEntries).toContainEqual({ key: CALLEE_KEY, value: STALE_ADDRESS, secret: true });
    // No page named any of it: the route only ever received main's own read.
    expect(planned?.payload["dependencies"]).toEqual([{ from: `repo-a:${f.callerId}`, to: `repo-a:${f.calleeId}`, kind: "call" }]);

    // (2) The audit really ran over those inputs and found nothing: the binding
    // resolved AND every read point it covers is a real config row.
    const plan = f.planAnswers().at(-1) as { bindings: Record<string, unknown>[]; taskRows: Record<string, unknown>[] };
    expect(plan.bindings).toEqual([{
      key: CALLEE_KEY, value: `http://127.0.0.1:${f.portB}`, kind: "url", unitId: `repo-a:${f.calleeId}`,
      serviceId: f.calleeId, instanceId: `task-1a2b3c4d/${f.calleeId}`, port: f.portB, readPoints: ["共享模板", "本机私有配置"],
    }]);
    // ...and those resolved rows are the plan's 任务覆盖, which is what the
    // children are registered with.
    expect(plan.taskRows).toEqual([{ key: CALLEE_KEY, value: `http://127.0.0.1:${f.portB}`, secret: false }]);
    expect(diagnosticsOf(group, "missing-binding")).toEqual([]);
    expect(diagnosticsOf(group, "unused-binding")).toEqual([]);

    // (3) REAL children: the caller prints the value its own env carried, and the
    // Host's own linkage step reached the very same address.
    await until(() => orderOf(f.orderPath).length === 2, "both children to report their start");
    const caller = await ask(f.portA);
    expect(caller).toMatchObject({ tag: "caller", address: `http://127.0.0.1:${f.portB}` });
    expect(caller?.address).not.toBe(SHARED_ADDRESS);
    expect(caller?.address).not.toBe(STALE_ADDRESS);
    const callerUnit = unitOf(group, f.callerId);
    expect((callerUnit["steps"] as Record<string, unknown>[])[0]).toMatchObject({
      kind: "linkage", outcome: "passed", address: { host: "127.0.0.1", port: f.portB },
    });
    for (const [, pid] of orderOf(f.orderPath)) expect(alive(Number(pid))).toBe(true);
  });

  it("names a real missing binding and leaves the consumer on the shared address", { timeout: 60_000 }, async () => {
    // The caller's shared config reads `CALLEE_API_URL` but NOBODY declared the
    // callee as a dependency, so no binding is authorised: the read point stays
    // on the shared environment address and the audit must name it.
    const f = await fixture({ callerShared: [{ key: CALLEE_KEY, value: SHARED_ADDRESS, secret: false }] });

    const group = await groupOf(f);
    // No declaration, no edge - on the real path too (the group really starts and
    // really listens, nothing was verified).
    expect(group.state).toBe("listening");
    const planned = f.routed().find((entry) => entry.op === "task/planServiceGroup");
    expect(planned?.payload).not.toHaveProperty("dependencies");
    expect(planned?.payload).not.toHaveProperty("rules");
    expect((planned?.payload["layers"] as { shared: SharedRow[] }).shared).toContainEqual({ key: CALLEE_KEY, value: SHARED_ADDRESS, secret: false });

    // The audit's REAL named diagnostic, located at the unit whose address the
    // row names, with the source the row really came from.
    const missing = diagnosticsOf(group, "missing-binding");
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ scope: { key: CALLEE_KEY, unitId: `repo-a:${f.calleeId}` } });
    expect(missing[0]?.message).toContain("共享模板");
    expect((f.planAnswers().at(-1) as { bindings: unknown[] }).bindings).toEqual([]);

    // ...and the consequence is visible in the running child: it kept the shared
    // address, which is exactly what the diagnostic warns about.
    await until(() => orderOf(f.orderPath).length === 2, "both children to report their start");
    expect(await ask(f.portA)).toMatchObject({ tag: "caller", address: SHARED_ADDRESS });
    expect(group.units.every((unit) => unit["linked"] === false)).toBe(true);
    expect(group.units.flatMap((unit) => unit["steps"] as Record<string, unknown>[])).toEqual([]);
  });

  it("names a bound address variable no read point covers", { timeout: 60_000 }, async () => {
    // The declaration is real, so a binding is authorised and the group really
    // verifies - but no config row follows the convention name, so the bound
    // variable is one nobody reads. The audit says so instead of implying the
    // override took effect.
    const f = await fixture({ declaration: [{ to: "callee", kind: "call" }] });

    const group = await groupOf(f);
    expect(group.state).toBe("verified");
    const planned = f.routed().find((entry) => entry.op === "task/planServiceGroup");
    // The canonical address name is the honest fallback when no convention name is
    // followed, which is what makes this case reachable at all.
    expect(planned?.payload["rules"]).toEqual([{ key: "CALLEE_API_ENDPOINT", unitId: `repo-a:${f.calleeId}`, kind: "url" }]);
    const plan = f.planAnswers().at(-1) as { bindings: Record<string, unknown>[] };
    expect(plan.bindings[0]).toMatchObject({ key: "CALLEE_API_ENDPOINT", readPoints: [], port: f.portB });

    const unused = diagnosticsOf(group, "unused-binding");
    expect(unused).toHaveLength(1);
    expect(unused[0]).toMatchObject({ scope: { key: "CALLEE_API_ENDPOINT", unitId: `repo-a:${f.calleeId}` } });
    expect(unused[0]?.hint).toBe("请确认变量名与业务配置一致");
    expect(diagnosticsOf(group, "missing-binding")).toEqual([]);

    await until(() => orderOf(f.orderPath).length === 2, "both children to report their start");
    // Neither child's env carries `CALLEE_API_URL`: NO row of any layer reads it,
    // which is exactly what the diagnostic reports (the convention name is not
    // followed anywhere, so the bound variable is unused).
    expect(await ask(f.portA)).toMatchObject({ tag: "caller", address: null });
    expect(await ask(f.portB)).toMatchObject({ tag: "callee", address: null });
  });

  it("refuses the whole group when a trusted layer cannot resolve, and starts nothing", { timeout: 60_000 }, async () => {
    // `CALLEE_API_URL` references an undefined variable, so the caller's trusted
    // layers cannot be resolved (the config layer's own `missing-ref`). The shared
    // template accepts the row (a reference is not a secret or a path) and the
    // catalog refuses the launch material by its fixed code, which is what makes
    // this a real end-to-end fail-closed case rather than a synthetic one.
    const f = await fixture({ callerShared: [{ key: CALLEE_KEY, value: "${CALLEE_SCHEME}://callee.shared.example", secret: false }] });

    const result = await f.startGroupThroughMain();
    expect(String(result["error"])).toBe(
      `服务登记失败，未发起整组启动：${f.callerId} 的启动材料无法从可信服务目录解析（service-launch-unavailable）`,
    );
    // NOTHING started: no plan, no control request, no run record, no child.
    expect(f.routed().map((entry) => entry.op)).toEqual([]);
    expect(f.planAnswers()).toEqual([]);
    expect(orderOf(f.orderPath)).toEqual([]);
    expect(existsSync(join(f.taskDir, "repo-a", "svc-a", "listening.txt"))).toBe(false);
    expect((await f.request("task/serviceRunRecords", {}))["records"]).toEqual([]);
  });
});
