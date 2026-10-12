/**
 * [PiDock 04] #7 box 1 (final half, ADR 0002) + [PiDock 05] #10 box 4:
 * the 服务依赖声明 of the per-environment shared template is what makes the
 * Host's REAL linkage verification run in the shipped app.
 *
 * Evidence split (stated, not implied):
 * - REAL child processes: both units are Node HTTP servers started by the Host's
 *   own `TaskServiceProcesses` driver through the gated `task/controlService`
 *   path. The start order is read back from what the children themselves wrote
 *   to a shared order file, and the listening facts from a real HTTP request.
 * - REAL Host: one module instance of `./host.js` bound to a temp task folder
 *   with a fake parent port (the same seam `service-group-linkage.test.ts` uses).
 * - REAL catalog: the trusted `ServiceCatalog` on a temp profile, with the
 *   declaration written into the environment's shared template exactly as the
 *   environment page writes it.
 * - PRODUCTION caller: `../main/runtime.ts runTaskServiceGroup` (the shipped
 *   `shell/serviceCatalogOp {op:"runTaskServiceGroup"}` route) plans the group
 *   from the catalog and forwards ONE `task/controlService {group:true}`.
 *
 * `desktopServiceGroupStart.test.tsx` renders the payload shape these cases
 * assert as 已互验 in the shipped dock; this file proves the DECLARATION is what
 * makes that payload verified - and that nothing else does.
 *
 * Process hygiene: every pid this suite starts is stopped through the Host's own
 * registered-child stop in `afterEach`, and the user's own dev servers are never
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

/** A real HTTP service on the port its own environment declares. */
const LISTENING_SCRIPT = `const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const tag = process.env.SERVICE_TAG;
const port = Number(process.env.PORT ?? process.env.LISTEN_ON);
fs.appendFileSync(process.env.ORDER_FILE, tag + ":" + process.pid + "\\n");
const server = http.createServer((_request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ tag, pid: process.pid, port, dir: path.basename(process.cwd()) }));
});
server.listen(port, "127.0.0.1", () => {
  fs.writeFileSync(path.join(process.cwd(), "listening.txt"), String(process.pid));
  console.log("listening:" + tag);
});
setInterval(() => {}, 1000);
`;

const WAIT_MS = 30_000;
const POLL_MS = 25;

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

interface Answer { tag: string; pid: number; port: number; dir: string }

/** One real HTTP request; the reply names the instance that really answered. */
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

/** The order file: `tag:pid` lines, in the order the children appended them. */
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

type Dependency = { from: "caller" | "callee"; to: "caller" | "callee"; kind: ServiceTemplateDependency["kind"] };

interface Fixture {
  taskId: string;
  taskDir: string;
  callerId: string;
  calleeId: string;
  portA: number;
  portB: number;
  orderPath: string;
  /** The versions the task's bindings pin (a declaration must live on those). */
  pinned: { caller: number; callee: number };
  /** The production caller: `shell/serviceCatalogOp {op:"runTaskServiceGroup"}` → main's `runTaskServiceGroup`. */
  startGroupThroughMain(): Promise<Record<string, unknown>>;
  routed(): { op: string; payload: Record<string, unknown> }[];
  request(op: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/**
 * One provisioned task with a caller/callee pair, a real Host for it and a real
 * catalog whose shared templates carry `declaration` - written as the environment
 * page writes it, on the revision the task then pins. The TARGET service is
 * created first, because a declaration may only name a service of the same
 * environment that already exists.
 *
 * `bindTarget: false` leaves the declared target in the CATALOG but out of the
 * task's bindings: the declaration is real, the plan simply has no unit for it.
 */
async function fixture(declaration: Dependency[], options: { bindTarget?: boolean } = {}): Promise<Fixture> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-group-declaration-")));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const profile = join(home, "profile");
  const root = join(home, "tasks");
  const taskId = "task-1a2b3c4d";
  const taskDir = join(root, taskId);
  const projectId = randomUUID();
  mkdirSync(profile, { mode: 0o700 });
  for (const subdir of ["svc-a", "svc-b"]) mkdirSync(join(taskDir, "repo-a", subdir), { recursive: true });
  writeFileSync(join(taskDir, "repo-a", "svc-a", "service.cjs"), LISTENING_SCRIPT);
  writeFileSync(join(taskDir, "repo-a", "svc-b", "service.cjs"), LISTENING_SCRIPT);
  const orderPath = join(taskDir, "order.txt");
  diskTaskStore.writeTask(taskDir, buildTaskDiskRecord({
    taskId, name: "Group", dirId: taskId, branch: "task/main", root, taskDir,
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
  for (const [name, value] of Object.entries({ PIDOCK_WORKSPACE_ID: "workspace-a", PIDOCK_TASK_ID: taskId, PIDOCK_TASK_DIR: taskDir, PIDOCK_PROTECTED_PROFILE: profile })) {
    vi.stubEnv(name, value);
  }
  vi.stubEnv("PIDOCK_GROUP_ORDER_FILE", orderPath);
  vi.stubEnv("PIDOCK_GROUP_PORT_A", String(portA));
  vi.stubEnv("PIDOCK_GROUP_PORT_B", String(portB));
  vi.resetModules();
  const { startHost } = await import("./host.js");
  startHost();
  const client = new HostClient(pair.child as never);
  cleanups.push(() => { client.dispose(); pair.child.emit("exit", 0); });

  const request = async (op: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    try {
      const result = await client.task({ workspaceId: "workspace-a", taskId, op: op as never, payload });
      return result.payload as Record<string, unknown>;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };

  // The TARGET first: a declaration may only name an existing service of this environment.
  const calleeTemplate = catalog.saveTemplate({
    projectId, environmentId,
    descriptor: { name: "Callee API", program: "node", args: ["service.cjs"], ports: [], runType: "long-lived" },
    shared: [{ key: "SERVICE_TAG", value: "callee", secret: false }],
  });
  const callerDeclared = declaration.filter((edge) => edge.from === "caller");
  // The caller's declaration is written on its FIRST revision (the one the task
  // then pins), so nothing here has to adopt a newer version to see it.
  const callerTemplate = catalog.saveTemplate({
    projectId, environmentId,
    descriptor: { name: "Caller API", program: "node", args: ["service.cjs"], ports: [], runType: "long-lived" },
    shared: [{ key: "SERVICE_TAG", value: "caller", secret: false }],
    ...(callerDeclared.length === 0 ? {} : { dependencies: callerDeclared.map((edge) => ({ to: calleeTemplate.serviceId, kind: edge.kind })) }),
  });
  // A BACKWARD declaration (the bidirectional pair) can only be written once the
  // caller exists, so it mints the target's second revision - and the task pins
  // THAT one, which is the revision whose declaration the plan reads.
  const calleeDeclared = declaration.filter((edge) => edge.from === "callee");
  const calleeRevision = calleeDeclared.length === 0 ? calleeTemplate : catalog.saveTemplate({
    projectId, environmentId, serviceId: calleeTemplate.serviceId, expectedVersion: 1,
    descriptor: calleeTemplate.descriptor, shared: calleeTemplate.shared,
    dependencies: calleeDeclared.map((edge) => ({ to: callerTemplate.serviceId, kind: edge.kind })),
  });
  catalog.bindTask({ taskId, serviceId: callerTemplate.serviceId, environmentId, templateVersion: 1, rootId: "repo-a", subdir: "svc-a",
    programPath: realpathSync(process.execPath), privateRefs: [{ key: "PORT", envRef: "PIDOCK_GROUP_PORT_A" }, { key: "ORDER_FILE", envRef: "PIDOCK_GROUP_ORDER_FILE" }] });
  if (options.bindTarget !== false) {
    catalog.bindTask({ taskId, serviceId: calleeTemplate.serviceId, environmentId, templateVersion: calleeRevision.version, rootId: "repo-a", subdir: "svc-b",
      programPath: realpathSync(process.execPath), privateRefs: [{ key: "PORT", envRef: "PIDOCK_GROUP_PORT_B" }, { key: "ORDER_FILE", envRef: "PIDOCK_GROUP_ORDER_FILE" }] });
  }

  const routedOps: { op: string; payload: Record<string, unknown> }[] = [];
  const mainRoute = {
    routeTaskOp: async (params: { taskId: string; op: string; payload?: Record<string, unknown>; origin?: unknown }) => {
      routedOps.push({ op: params.op, payload: params.payload ?? {} });
      return await client.task({
        workspaceId: "workspace-a", taskId: params.taskId, op: params.op as never, payload: params.payload ?? {},
        ...(params.origin !== undefined ? { origin: params.origin } : {}),
      } as never);
    },
  };
  const value: Fixture = {
    taskId, taskDir, callerId: callerTemplate.serviceId, calleeId: calleeTemplate.serviceId, portA, portB, orderPath,
    pinned: { caller: 1, callee: calleeRevision.version },
    startGroupThroughMain: async () => {
      try {
        return await runTaskServiceGroup(mainRoute as never, catalog, { taskId, projectId }, 7);
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
    routed: () => routedOps.map((entry) => ({ ...entry })),
    request,
  };

  // Stop every real child this fixture started, through the Host's own
  // registered-child stop; then verify nothing of ours survives.
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
}

/** The group result of one production group start, or the named refusal it answered with. */
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

describe.skipIf(process.platform === "win32")("#7/#10 the declared 服务依赖声明 drives the REAL linkage verification", () => {
  it("runs the real linkage step because of the declaration and reaches 已互验 with two real children", { timeout: 60_000 }, async () => {
    const f = await fixture([{ from: "caller", to: "callee", kind: "call" }]);

    const group = await groupOf(f);
    // (1) THE payoff: the group really verified - the caller's linkage step
    // connected to the callee's own declared address - and it did so because the
    // declaration reached the plan. Without the edge the same fixture answers
    // `listening` (the case below), so this assertion is exactly the one that
    // fails when the declaration is not fed.
    expect(group.state).toBe("verified");
    const callee = unitOf(group, f.calleeId);
    const caller = unitOf(group, f.callerId);
    expect(callee).toMatchObject({ start: "started", order: 1, listening: "listening" });
    expect(caller).toMatchObject({ start: "started", order: 2, listening: "listening", linked: true });
    expect((caller["steps"] as Record<string, unknown>[])[0]).toMatchObject({
      kind: "linkage", outcome: "passed", targetServiceId: f.calleeId, address: { host: "127.0.0.1", port: f.portB },
    });

    // The plan main sent carries the DECLARATION, by the plan's own unit ids and
    // nothing else. MUTATION GUARD: a synthesised reverse edge - or any second
    // edge nobody declared - makes this equality fail, which is the honesty rule
    // of this slice (an unprobed 已互验 must be impossible to light up).
    const planned = f.routed().find((entry) => entry.op === "task/planServiceGroup");
    const declaredEdges = [{ from: `repo-a:${f.callerId}`, to: `repo-a:${f.calleeId}`, kind: "call" }];
    expect(planned?.payload["dependencies"]).toEqual(declaredEdges);
    expect(planned?.payload["dependencies"]).not.toEqual([...declaredEdges, { from: `repo-a:${f.calleeId}`, to: `repo-a:${f.callerId}`, kind: "call" }]);

    // REAL children: the order file is what the children themselves wrote, each
    // port answers with the identity only its own child knows, and both are alive.
    await until(() => orderOf(f.orderPath).length === 2, "both children to report their start");
    const order = orderOf(f.orderPath);
    expect(order.map(([tag]) => tag)).toEqual(["callee", "caller"]);
    expect(await ask(f.portB)).toMatchObject({ tag: "callee" });
    expect(await ask(f.portA)).toMatchObject({ tag: "caller" });
    for (const [, pid] of order) expect(alive(Number(pid))).toBe(true);

    // The observation rides the EXISTING verification shape, which is what the
    // dock (desktopServiceGroupStart.test.tsx) renders as 已互验.
    const records = (await f.request("task/serviceRunRecords", {}))["records"] as Record<string, unknown>[];
    const callerRun = records.find((record) => record["serviceId"] === f.callerId) as Record<string, unknown>;
    const linkage = (callerRun["verifications"] as { kind: string; ok: boolean; detail: string }[]).filter((entry) => entry.kind === "linkage");
    expect(linkage).toHaveLength(1);
    expect(linkage[0]).toMatchObject({ ok: true });
    expect(linkage[0]?.detail).toContain(`127.0.0.1:${f.portB}`);
  });

  it("starts a declared bidirectional pair in ONE listener group without deadlocking", { timeout: 60_000 }, async () => {
    // A↔B, both declared `call` (the pilot's invoice/shipment shape). A task that
    // waited for the other to become ready first would never start either child.
    const f = await fixture([{ from: "caller", to: "callee", kind: "call" }, { from: "callee", to: "caller", kind: "call" }]);
    expect(f.pinned).toEqual({ caller: 1, callee: 2 });

    const startedAt = Date.now();
    const group = await groupOf(f);
    const elapsed = Date.now() - startedAt;
    // One listener group holding both units: the call cycle folded, so neither
    // unit waits for the other (spec 「双向依赖不会造成永远等待启动」).
    expect(group.groups).toEqual(["listen-0"]);
    // Both real children started, both linkages really passed, bounded time.
    expect(group.state).toBe("verified");
    expect(group.units.every((unit) => unit["linked"] === true)).toBe(true);
    expect(elapsed).toBeLessThan(30_000);

    const planned = f.routed().find((entry) => entry.op === "task/planServiceGroup");
    expect(planned?.payload["dependencies"]).toEqual([
      { from: `repo-a:${f.callerId}`, to: `repo-a:${f.calleeId}`, kind: "call" },
      { from: `repo-a:${f.calleeId}`, to: `repo-a:${f.callerId}`, kind: "call" },
    ]);

    await until(() => orderOf(f.orderPath).length === 2, "both children to report their start");
    expect(orderOf(f.orderPath).map(([tag]) => tag).sort()).toEqual(["callee", "caller"]);
    expect(await ask(f.portA)).toMatchObject({ tag: "caller" });
    expect(await ask(f.portB)).toMatchObject({ tag: "callee" });
  });

  it("keeps today's honest behaviour when nothing is declared: no edge, no 已互验", { timeout: 60_000 }, async () => {
    const f = await fixture([]);

    const group = await groupOf(f);
    // The children really start and really listen - and NOTHING was verified,
    // because no edge was declared. This is the honest state the panel names as
    // 无依赖边（未做互验）, and the mutation guard against synthesising one to
    // light up 已互验.
    expect(group.state).toBe("listening");
    expect(group.state).not.toBe("verified");
    expect(group.units.map((unit) => unit["start"])).toEqual(["started", "started"]);
    expect(group.units.every((unit) => unit["listening"] === "listening")).toBe(true);
    expect(group.units.every((unit) => unit["linked"] === false)).toBe(true);
    expect(group.units.flatMap((unit) => unit["steps"] as Record<string, unknown>[]).filter((step) => step["kind"] === "linkage")).toEqual([]);

    // ...and the plan really carried no edge: the key is not sent at all, so no
    // reader can mistake an empty plan for a declared graph.
    const planned = f.routed().find((entry) => entry.op === "task/planServiceGroup");
    expect(planned?.payload).not.toHaveProperty("dependencies");
    // No unit claims a passed linkage observation in its run record either.
    const records = (await f.request("task/serviceRunRecords", {}))["records"] as Record<string, unknown>[];
    expect(records.flatMap((record) => (record["verifications"] as { kind: string }[]) ?? []).filter((entry) => entry.kind === "linkage")).toEqual([]);

    await until(() => orderOf(f.orderPath).length === 2, "both children to report their start");
    expect(await ask(f.portA)).toMatchObject({ tag: "caller" });
    expect(await ask(f.portB)).toMatchObject({ tag: "callee" });
    expect(existsSync(join(f.taskDir, "repo-a", "svc-a", "listening.txt"))).toBe(true);
  });

  it("refuses the group by name when a declared target is not bound to the task", { timeout: 60_000 }, async () => {
    // The declaration names a service of this environment; this task never bound
    // it, so the plan has no unit for it. Dropping the edge would report a
    // complete group while the declared dependency is missing.
    const f = await fixture([{ from: "caller", to: "callee", kind: "call" }], { bindTarget: false });
    const result = await f.startGroupThroughMain();
    expect(String(result["error"])).toBe(
      `服务依赖声明无法满足，未生成整组计划：「Caller API」（${f.callerId}）声明的依赖目标 ${f.calleeId} 未在本任务的服务绑定中，请先绑定该服务或从共享模板移除该声明`,
    );
    // No plan was sent and NO child started: a unit whose declared prerequisite
    // is missing must not be started into a green group.
    expect(f.routed().filter((entry) => entry.op === "task/planServiceGroup")).toEqual([]);
    expect(orderOf(f.orderPath)).toEqual([]);
    expect((await f.request("task/serviceRunRecords", {}))["records"]).toEqual([]);
    expect(existsSync(join(f.taskDir, "repo-a", "svc-a", "listening.txt"))).toBe(false);
  });
});
