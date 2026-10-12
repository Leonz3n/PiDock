/**
 * [PiDock 05] (#10 box 4) REAL group start + REAL linkage verification.
 *
 * Evidence split (stated, not implied):
 * - REAL child processes: the caller and callee units are Node HTTP servers
 *   started by the Host's own `TaskServiceProcesses` driver through the gated
 *   `task/controlService` path. The start ORDER is read back from what the
 *   children themselves wrote to a shared order file, not from the plan; the
 *   listening facts are read back from a real HTTP request to each port.
 * - REAL Host: one module instance of `./host.js` bound to a temp task folder
 *   with a fake parent port (the same seam `service-execution-wiring.test.ts`
 *   uses). Every start goes through that Host's `task/controlService`.
 * - FIXTURE: the catalog authority is an in-test stub (its own suites cover the
 *   real `TaskRootIndex`), and for the "cannot start" case a descriptor is
 *   registered directly with main's `service-catalog` origin so a real launch
 *   failure can be produced without an Electron dialog. No Windows run, no
 *   Electron GUI, no Provider turn, no packaged build.
 *
 * Process hygiene: every pid this suite starts is stopped through the Host's
 * own registered-child stop in `afterEach`, and the user's own dev servers are
 * never signalled (only pids this suite's children reported are ever touched).
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
import { ServiceCatalog, type ServiceCatalogAuthority } from "../main/service-catalog.js";
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

/** A real child that appends its start to the order file and then never listens. */
const DEAD_SCRIPT = `const fs = require("node:fs");
fs.appendFileSync(process.env.ORDER_FILE, process.env.SERVICE_TAG + ":" + process.pid + "\\n");
console.log("never-listens");
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

type CalleeMode = "listening" | "declared-mismatch" | "cannot-start" | "no-declared-port";

/** One op the new catalog caller forwarded to the real Host, with its own attestation. */
interface RoutedOp {
  op: string;
  payload: Record<string, unknown>;
  origin?: { kind: "shell-ui" | "service-catalog"; senderWebContentsId: number };
}

interface Fixture {
  taskId: string;
  taskDir: string;
  callerId: string;
  calleeId: string;
  portA: number;
  portB: number;
  orderPath: string;
  request(op: string, payload?: Record<string, unknown>, origin?: { kind: "shell-ui" | "service-catalog"; senderWebContentsId: number }): Promise<Record<string, unknown>>;
  startGroup(payload?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** The production caller: `shell/serviceCatalogOp {op:"runTaskServiceGroup"}` → main's `runTaskServiceGroup`. */
  startGroupThroughMain(): Promise<Record<string, unknown>>;
  /** Every op the production caller forwarded to this Host, in order. */
  routed(): RoutedOp[];
  /** Bind the callee's trusted launch in the catalog (no plan, no registration on the Host). */
  bindServices(): Promise<void>;
  /** The plan as the caller's own fixtures wrote it; NOT the same as registering the launches. */
  planOnly(): Promise<void>;
  planAndRegister(): Promise<void>;
}

const CALLER_UNIT = "repo-a:caller";
const CALLEE_UNIT = "repo-a:callee";

/**
 * One provisioned task with a caller/callee pair, a real Host for it and a real
 * catalog, exactly like main's own trusted registration path. `mode` decides how
 * the callee can fail.
 */
async function fixture(mode: CalleeMode): Promise<Fixture> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-group-linkage-")));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const profile = join(home, "profile");
  const root = join(home, "tasks");
  const taskId = "task-1a2b3c4d";
  const taskDir = join(root, taskId);
  const projectId = randomUUID();
  mkdirSync(profile, { mode: 0o700 });
  for (const subdir of ["svc-a", "svc-b"]) mkdirSync(join(taskDir, "repo-a", subdir), { recursive: true });
  writeFileSync(join(taskDir, "repo-a", "svc-a", "service.cjs"), LISTENING_SCRIPT);
  writeFileSync(join(taskDir, "repo-a", "svc-b", "service.cjs"), mode === "cannot-start" ? DEAD_SCRIPT : LISTENING_SCRIPT);
  const orderPath = join(taskDir, "order.txt");
  diskTaskStore.writeTask(taskDir, buildTaskDiskRecord({
    taskId, name: "Group", dirId: taskId, branch: "task/main", root, taskDir,
    remoteBranch: "main", baseCommit: "source-fixture", repos: ["repo-a"], now: "2026-01-01T00:00:00.000Z",
  }));
  const [portA, portB, wrongPort] = [await freePort(), await freePort(), await freePort()];

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
  vi.stubEnv("PIDOCK_GROUP_WRONG_PORT", String(wrongPort));
  vi.resetModules();
  const { startHost } = await import("./host.js");
  startHost();
  const client = new HostClient(pair.child as never);
  cleanups.push(() => { client.dispose(); pair.child.emit("exit", 0); });

  const request = async (op: string, payload: Record<string, unknown> = {}, origin?: { kind: "shell-ui" | "service-catalog"; senderWebContentsId: number }): Promise<Record<string, unknown>> => {
    try {
      const result = await client.task({ workspaceId: "workspace-a", taskId, op: op as never, payload, ...(origin ? { origin } : {}) });
      return result.payload as Record<string, unknown>;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };

  const callerTemplate = catalog.saveTemplate({
    projectId,
    environmentId,
    descriptor: { name: "Caller API", program: "node", args: ["service.cjs"], ports: [], runType: "long-lived" },
    shared: [{ key: "SERVICE_TAG", value: "caller", secret: false }],
  });
  catalog.bindTask({
    taskId, serviceId: callerTemplate.serviceId, environmentId, templateVersion: 1, rootId: "repo-a", subdir: "svc-a",
    programPath: realpathSync(process.execPath), privateRefs: [{ key: "PORT", envRef: "PIDOCK_GROUP_PORT_A" }, { key: "ORDER_FILE", envRef: "PIDOCK_GROUP_ORDER_FILE" }],
  });

  /**
   * The main-side seam the new catalog caller drives: exactly what
   * `PerTaskHostRegistry.routeTaskOp` does (mint the task op for this Host and
   * forward the main-built origin), with the ops recorded so a test can assert
   * what the caller really sent.
   */
  const routedOps: RoutedOp[] = [];
  const mainRoute = {
    routeTaskOp: async (params: { taskId: string; op: string; payload?: Record<string, unknown>; origin?: RoutedOp["origin"] }) => {
      routedOps.push({ op: params.op, payload: params.payload ?? {}, ...(params.origin !== undefined ? { origin: params.origin } : {}) });
      return await client.task({
        workspaceId: "workspace-a", taskId: params.taskId, op: params.op as never, payload: params.payload ?? {},
        ...(params.origin !== undefined ? { origin: params.origin } : {}),
      });
    },
  };

  const fixtureValue: Fixture = {
    taskId, taskDir, callerId: callerTemplate.serviceId, calleeId: "callee-api", portA, portB, orderPath, request,
    startGroup: (payload = {}) => request("task/controlService", { group: true, action: "start", label: "运行面板整组启动", ...payload }, { kind: "shell-ui", senderWebContentsId: 7 }),
    startGroupThroughMain: async () => {
      try {
        return await runTaskServiceGroup(mainRoute as never, catalog, { taskId, projectId }, 7);
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
    routed: () => routedOps.map((entry) => ({ ...entry })),
    async bindServices() {
      const options = mode;
      // The callee's service id has to exist BEFORE the plan, because the plan's
      // units name it and the group start maps unit → registration by it.
      if (options === "cannot-start") {
        // A real launch failure: the registered launch's absolute cwd does not
        // exist, so `TaskServiceProcesses.start` refuses before any child exists.
        const broken = await request("task/registerService", {
          serviceId: "callee-api",
          descriptor: { id: "callee-api", name: "Callee API", program: realpathSync(process.execPath), args: ["service.cjs"], cwd: join(taskDir, "repo-a", "missing-dir"), ports: [portB], runType: "long-lived" },
          layers: { repoDefaults: [], shared: [{ key: "SERVICE_TAG", value: "callee", secret: false }], privateEntries: [], task: [] },
          templateVersion: "1",
        }, { kind: "service-catalog", senderWebContentsId: 7 });
        if (broken["error"] !== undefined) throw Error(`broken registration failed: ${String(broken["error"])}`);
        return;
      }
      const calleeTemplate = catalog.saveTemplate({
        projectId,
        environmentId,
        descriptor: {
          name: "Callee API", program: "node", args: ["service.cjs"],
          // `declared-mismatch`: the registration declares a port nothing binds,
          // while the child really listens on its own (non-`PORT`) variable.
          ports: options === "declared-mismatch" ? [wrongPort] : [],
          runType: "long-lived",
        },
        shared: [{ key: "SERVICE_TAG", value: "callee", secret: false }],
      });
      catalog.bindTask({
        taskId, serviceId: calleeTemplate.serviceId, environmentId, templateVersion: 1, rootId: "repo-a", subdir: "svc-b",
        programPath: realpathSync(process.execPath),
        privateRefs: options === "declared-mismatch"
          ? [{ key: "LISTEN_ON", envRef: "PIDOCK_GROUP_PORT_B" }, { key: "ORDER_FILE", envRef: "PIDOCK_GROUP_ORDER_FILE" }]
          // `no-declared-port`: a long-lived service whose recipe and private
          // refs declare NO socket at all, so the port-first plan has nothing
          // to allocate for it.
          : options === "no-declared-port"
            ? [{ key: "ORDER_FILE", envRef: "PIDOCK_GROUP_ORDER_FILE" }]
            : [{ key: "PORT", envRef: "PIDOCK_GROUP_PORT_B" }, { key: "ORDER_FILE", envRef: "PIDOCK_GROUP_ORDER_FILE" }],
      });
      fixtureValue.calleeId = calleeTemplate.serviceId;
    },
    async planOnly() {
      await fixtureValue.bindServices();
      const units = [
        { unitId: CALLEE_UNIT, serviceId: fixtureValue.calleeId, name: "Callee API", repoDir: "repo-a", location: "local" as const, runType: "long-lived" as const },
        { unitId: CALLER_UNIT, serviceId: fixtureValue.callerId, name: "Caller API", repoDir: "repo-a", location: "local" as const, runType: "long-lived" as const },
      ];
      const planned = await request("task/planServiceGroup", {
        units,
        selectedRepoDirs: ["repo-a"],
        dependencies: [{ from: CALLER_UNIT, to: CALLEE_UNIT, kind: "call" }],
        requests: [{ unitId: CALLER_UNIT, port: portA }, { unitId: CALLEE_UNIT, port: portB }],
      }, { kind: "shell-ui", senderWebContentsId: 7 });
      if (planned["error"] !== undefined) throw Error(`plan failed: ${String(planned["error"])}`);
    },
    async planAndRegister() {
      await fixtureValue.planOnly();
      const options = mode;
      const callerLaunch = catalog.launchFor(taskId, projectId, fixtureValue.callerId, process.env);
      const registered = await request("task/registerService", {
        serviceId: callerLaunch.serviceId, descriptor: callerLaunch.descriptor, layers: callerLaunch.layers, templateVersion: String(callerLaunch.templateVersion),
      }, { kind: "service-catalog", senderWebContentsId: 7 });
      if (registered["error"] !== undefined) throw Error(`caller registration failed: ${String(registered["error"])}`);
      if (options === "cannot-start") return;
      const calleeLaunch = catalog.launchFor(taskId, projectId, fixtureValue.calleeId, process.env);
      const calleeRegistered = await request("task/registerService", {
        serviceId: calleeLaunch.serviceId, descriptor: calleeLaunch.descriptor, layers: calleeLaunch.layers, templateVersion: String(calleeLaunch.templateVersion),
      }, { kind: "service-catalog", senderWebContentsId: 7 });
      if (calleeRegistered["error"] !== undefined) throw Error(`callee registration failed: ${String(calleeRegistered["error"])}`);
    },
  };

  // Stop every real child this fixture started, through the Host's own
  // registered-child stop; then verify nothing of ours survives.
  cleanups.push(async () => {
    for (const serviceId of [fixtureValue.callerId, fixtureValue.calleeId]) {
      await request("task/controlService", { serviceId, action: "stop", label: "suite cleanup" }, { kind: "shell-ui", senderWebContentsId: 7 });
    }
    const order = orderOf(orderPath);
    for (const [, pidText] of order) {
      const pid = Number(pidText);
      if (!Number.isInteger(pid) || pid <= 1) continue;
      if (alive(pid)) {
        try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  });
  return fixtureValue;
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

const CONTROL_ORIGIN = { kind: "shell-ui", senderWebContentsId: 7 } as const;

describe.skipIf(process.platform === "win32")("#10 real group start and linkage verification", () => {
  it("starts the callee before the caller, observes listening, and verifies the linkage from a real request", { timeout: 60_000 }, async () => {
    const f = await fixture("listening");
    await f.planAndRegister();
    expect(existsSync(f.orderPath)).toBe(false);

    const result = await f.startGroup();
    const group = (result["group"] ?? {}) as Record<string, unknown>;
    // (1) The group REALLY verified: callee first, caller second, both listening,
    // and the caller's linkage step connected to the callee's own address.
    expect(group["state"]).toBe("verified");
    const units = group["units"] as Record<string, unknown>[];
    const callee = units.find((entry) => entry["serviceId"] === f.calleeId) as Record<string, unknown>;
    const caller = units.find((entry) => entry["serviceId"] === f.callerId) as Record<string, unknown>;
    expect(callee).toMatchObject({ start: "started", order: 1, listening: "listening" });
    expect(caller).toMatchObject({ start: "started", order: 2, listening: "listening", linked: true });
    expect((caller["steps"] as Record<string, unknown>[])[0]).toMatchObject({
      kind: "linkage", outcome: "passed", address: { host: "127.0.0.1", port: f.portB }, targetServiceId: f.calleeId,
    });

    // The start order is what the CHILDREN wrote, not what the plan said.
    await until(() => orderOf(f.orderPath).length === 2, "both children to report their start");
    const order = orderOf(f.orderPath);
    expect(order.map(([tag]) => tag)).toEqual(["callee", "caller"]);
    const calleePid = Number(order[0]?.[1]);
    const callerPid = Number(order[1]?.[1]);
    expect(calleePid).toBeGreaterThan(0);
    expect(callerPid).toBeGreaterThan(0);
    expect(alive(calleePid)).toBe(true);
    expect(alive(callerPid)).toBe(true);

    // ...and the request really reached the intended units: each port answers
    // with the identity only ITS child knows.
    await until(() => ask(f.portA) !== null && ask(f.portB) !== null, "both services to answer");
    expect(await ask(f.portB)).toEqual({ tag: "callee", pid: calleePid, port: f.portB, dir: "svc-b" });
    expect(await ask(f.portA)).toEqual({ tag: "caller", pid: callerPid, port: f.portA, dir: "svc-a" });

    // The observations ride the EXISTING verification shape on the run records.
    const records = (await f.request("task/serviceRunRecords", {}))["records"] as Record<string, unknown>[];
    const callerRun = records.find((record) => record["serviceId"] === f.callerId) as Record<string, unknown>;
    const calleeRun = records.find((record) => record["serviceId"] === f.calleeId) as Record<string, unknown>;
    const verifications = (run: Record<string, unknown>) => run["verifications"] as { kind: string; detail: string; ok: boolean }[];
    expect(verifications(calleeRun).some((entry) => entry.kind === "readiness" && entry.ok && entry.detail.includes(`127.0.0.1:${f.portB}`))).toBe(true);
    expect(verifications(callerRun).some((entry) => entry.kind === "linkage" && entry.ok)).toBe(true);
    expect(verifications(callerRun).some((entry) => entry.kind === "readiness" && entry.ok)).toBe(true);
    expect((callerRun["processIdentity"] as { pid: number }).pid).toBe(callerPid);
  });

  it("ends in a NAMED start failure for the unit that cannot start, and never credits a linkage from the plan", { timeout: 60_000 }, async () => {
    const f = await fixture("cannot-start");
    await f.planAndRegister();

    const result = await f.startGroup();
    const group = (result["group"] ?? {}) as Record<string, unknown>;
    expect(group["state"]).toBe("start-failed");
    const units = group["units"] as Record<string, unknown>[];
    const callee = units.find((entry) => entry["serviceId"] === f.calleeId) as Record<string, unknown>;
    const caller = units.find((entry) => entry["serviceId"] === f.callerId) as Record<string, unknown>;
    // The failure names the offending unit and keeps the raw driver reason.
    expect(callee["start"]).toBe("start-failed");
    expect((callee["diagnostics"] as { code: string; scope: { unitId?: string } }[])[0]).toMatchObject({ code: "start-failed", scope: { unitId: CALLEE_UNIT } });
    // ...and no unit whose prerequisite never came up was started.
    expect(caller["start"]).toBe("not-started");
    expect(orderOf(f.orderPath)).toEqual([]);
    // THE assertion that fails if linkage were credited from the plan: the run
    // records carry no linkage verification at all, because no real observation
    // was made.
    const records = (await f.request("task/serviceRunRecords", {}))["records"] as Record<string, unknown>[];
    const linkage = records.flatMap((record) => (record["verifications"] as { kind: string }[]) ?? []).filter((entry) => entry.kind === "linkage");
    expect(linkage).toEqual([]);
    expect(group["state"]).not.toBe("verified");
  });

  it("reports a REAL dependency-unreachable when the dependency listens but the declared address does not answer", { timeout: 60_000 }, async () => {
    const f = await fixture("declared-mismatch");
    await f.planAndRegister();

    const result = await f.startGroup();
    const group = (result["group"] ?? {}) as Record<string, unknown>;
    expect(group["state"]).toBe("dependency-unreachable");
    expect(group["state"]).not.toBe("start-failed");
    const units = group["units"] as Record<string, unknown>[];
    const callee = units.find((entry) => entry["serviceId"] === f.calleeId) as Record<string, unknown>;
    const caller = units.find((entry) => entry["serviceId"] === f.callerId) as Record<string, unknown>;
    // The callee's declared port is NOT where it listens, so its own listening
    // observation is a real failed connect - a different fact from "it did not
    // start" - while the caller's own port really answers.
    expect(callee).toMatchObject({ start: "started", listening: "not-listening" });
    expect(caller["listening"]).toBe("listening");
    expect(caller["linked"]).toBe(false);
    expect((caller["steps"] as Record<string, unknown>[])[0]).toMatchObject({ kind: "linkage", outcome: "dependency-unreachable" });
    // The dependency really IS listening - on its own port - so the failure is
    // the declared address, not a dead process.
    await until(() => orderOf(f.orderPath).length === 2, "both children to report their start");
    const calleePid = Number(orderOf(f.orderPath)[0]?.[1]);
    expect(alive(calleePid)).toBe(true);
    await until(() => ask(f.portB) !== null, "the callee to answer on its own port");
    expect(await ask(f.portB)).toEqual({ tag: "callee", pid: calleePid, port: f.portB, dir: "svc-b" });
    // A real failed connect is recorded as a failed linkage verification, never a pass.
    const records = (await f.request("task/serviceRunRecords", {}))["records"] as Record<string, unknown>[];
    const callerRun = records.find((record) => record["serviceId"] === f.callerId) as Record<string, unknown>;
    const verifications = (callerRun["verifications"] as { kind: string; ok: boolean }[]).filter((entry) => entry.kind === "linkage");
    expect(verifications).toHaveLength(1);
    expect(verifications[0]?.ok).toBe(false);
  });

  it("refuses a read-only group start and parks a default-tier one with no child started", { timeout: 60_000 }, async () => {
    const f = await fixture("listening");
    await f.planAndRegister();

    // Read-only session: refused before any gate leg reaches the driver.
    expect(await f.request("task/setPermission", { sessionId: "read-1", permission: "read" })).toMatchObject({ permission: "read" });
    const refused = await f.request("task/controlService", { group: true, action: "start", sessionId: "read-1" }, CONTROL_ORIGIN);
    expect((refused["group"] as Record<string, unknown>)["state"]).toBe("refused");
    expect(orderOf(f.orderPath)).toEqual([]);

    // Default-tier agent: the whole group parks on a one-shot approval.
    expect(await f.request("task/setPermission", { sessionId: "ask-1", permission: "default" })).toMatchObject({ permission: "default" });
    const parked = await f.request("task/controlService", { group: true, action: "start", sessionId: "ask-1" }, CONTROL_ORIGIN);
    expect((parked["group"] as Record<string, unknown>)["state"]).toBe("approval-required");
    expect(orderOf(f.orderPath)).toEqual([]);

    // NOTHING started and NOTHING was registered as a running instance.
    const records = await f.request("task/serviceRunRecords", {});
    expect(records["records"]).toEqual([]);
    expect(records["registered"]).toEqual([]);
    // The assertion that fails if a second bypass appears: the group start must
    // have started no child at all, so no marker and no pid exists.
    expect(existsSync(join(f.taskDir, "repo-a", "svc-a", "listening.txt"))).toBe(false);
    expect(existsSync(join(f.taskDir, "repo-a", "svc-b", "listening.txt"))).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(orderOf(f.orderPath)).toEqual([]);
  });

  it("starts exactly the one unit a default-tier confirmation was minted for", { timeout: 60_000 }, async () => {
    const f = await fixture("listening");
    await f.planAndRegister();
    expect(await f.request("task/setPermission", { sessionId: "ask-2", permission: "default" })).toMatchObject({ permission: "default" });
    const parked = await f.request("task/controlService", { group: true, action: "start", sessionId: "ask-2" }, CONTROL_ORIGIN);
    expect((parked["group"] as Record<string, unknown>)["state"]).toBe("approval-required");
    const approvals = (await f.request("task/listApprovals", { sessionId: "ask-2" }))["approvals"] as { id: string; status: string }[];
    const approvalId = approvals[0]?.id as string;
    expect(approvalId).toBeTypeOf("string");
    expect(await f.request("task/approve", { sessionId: "ask-2", approvalId })).toMatchObject({ sessionId: "ask-2", approvalId });

    // The verified confirmation reaches the driver for the FIRST planned unit
    // (the callee). One existing one-shot confirmation authorizes one start of
    // one service folder, so the second unit is refused in the same run - the
    // slice deliberately added no second approval path.
    const acted = await f.request("task/controlService", { group: true, action: "start", sessionId: "ask-2", approvalId }, CONTROL_ORIGIN);
    const group = (acted["group"] ?? {}) as Record<string, unknown>;
    const units = group["units"] as Record<string, unknown>[];
    expect(units.find((entry) => entry["serviceId"] === f.calleeId)).toMatchObject({ start: "started" });
    await until(() => orderOf(f.orderPath).length >= 1, "the approved unit to really start");
    const calleePid = Number(orderOf(f.orderPath)[0]?.[1]);
    expect(alive(calleePid)).toBe(true);
    expect(group["state"]).not.toBe("verified");
  });

  it("starts the task's PLANNED group through the new catalog caller and really verifies the linkage", { timeout: 60_000 }, async () => {
    const f = await fixture("listening");
    // A plan with a real call edge exists, but NOBODY registered the launches:
    // the new caller must do that itself, from the trusted catalog.
    await f.planOnly();
    expect(existsSync(f.orderPath)).toBe(false);

    const result = await f.startGroupThroughMain();
    const group = (result["group"] ?? {}) as Record<string, unknown>;
    // The group really verified through the production caller: callee first,
    // caller second, both observed listening, and the caller's linkage step
    // connected to the callee's own declared address.
    expect(group["state"]).toBe("verified");
    const units = group["units"] as Record<string, unknown>[];
    const callee = units.find((entry) => entry["serviceId"] === f.calleeId) as Record<string, unknown>;
    const caller = units.find((entry) => entry["serviceId"] === f.callerId) as Record<string, unknown>;
    expect(callee).toMatchObject({ start: "started", order: 1, listening: "listening" });
    expect(caller).toMatchObject({ start: "started", order: 2, listening: "listening", linked: true });
    expect((caller["steps"] as Record<string, unknown>[])[0]).toMatchObject({ kind: "linkage", outcome: "passed", targetServiceId: f.calleeId });

    // REAL children: the order file is what the children themselves wrote, and
    // each port answers with the identity only its own child knows.
    await until(() => orderOf(f.orderPath).length === 2, "both children to report their start");
    expect(orderOf(f.orderPath).map(([tag]) => tag)).toEqual(["callee", "caller"]);
    await until(() => ask(f.portA) !== null && ask(f.portB) !== null, "both services to answer");
    expect(await ask(f.portB)).toMatchObject({ tag: "callee" });
    expect(await ask(f.portA)).toMatchObject({ tag: "caller" });

    // What the production caller really sent: the task's group started ONCE
    // through the same gated op, its two launches registered from the trusted
    // catalog, and NO second plan - an existing plan is never clobbered.
    const control = f.routed().filter((entry) => entry.op === "task/controlService");
    expect(control).toHaveLength(1);
    expect(control[0]?.payload).toEqual({ group: true, action: "start", label: "主进程服务目录入口" });
    expect(control[0]?.origin).toEqual({ kind: "service-catalog", senderWebContentsId: 7 });
    expect(f.routed().filter((entry) => entry.op === "task/planServiceGroup")).toEqual([]);
    expect(f.routed().filter((entry) => entry.op === "task/registerService")).toHaveLength(2);
  });

  it("plans the task's bound services from the trusted catalog when the Host holds no plan, and never claims 已互验", { timeout: 60_000 }, async () => {
    const f = await fixture("listening");
    // The task's services are bound in the trusted catalog, but no
    // `task/planServiceGroup` was ever sent: this is the shipped route's state.
    await f.bindServices();
    const result = await f.startGroupThroughMain();
    const group = (result["group"] ?? {}) as Record<string, unknown>;
    // The units really started and really listened - but the plan carries no call
    // edge, so there is nothing to 互验 and the state says so.
    expect(group["state"]).toBe("listening");
    expect(group["state"]).not.toBe("verified");
    const units = group["units"] as Record<string, unknown>[];
    expect(units.map((entry) => entry["start"])).toEqual(["started", "started"]);
    expect(units.every((entry) => entry["listening"] === "listening")).toBe(true);
    expect(units.flatMap((entry) => entry["steps"] as Record<string, unknown>[]).filter((step) => step["kind"] === "linkage")).toEqual([]);
    expect(units.every((entry) => entry["linked"] === false)).toBe(true);

    // REAL children on the ports their own registrations declare.
    await until(() => orderOf(f.orderPath).length === 2, "both children to report their start");
    await until(() => ask(f.portA) !== null && ask(f.portB) !== null, "both services to answer");

    // Main planned once (the Host answered `not-planned`), then started once.
    expect(f.routed().filter((entry) => entry.op === "task/planServiceGroup")).toHaveLength(1);
    expect(f.routed().filter((entry) => entry.op === "task/controlService")).toHaveLength(2);
    const planned = f.routed().find((entry) => entry.op === "task/planServiceGroup");
    const plannedUnits = planned?.payload["units"] as Record<string, unknown>[];
    expect(plannedUnits.map((entry) => entry["location"])).toEqual(["local", "local"]);
    expect(planned?.payload["dependencies"]).toBeUndefined();
  });

  it("fails a portless bound service CLOSED by name, starting nothing", { timeout: 60_000 }, async () => {
    const f = await fixture("no-declared-port");
    await f.bindServices();
    const result = await f.startGroupThroughMain();
    // The port-first plan refuses in its own vocabulary, naming the unit: a
    // member is never dropped from the group to make the plan succeed.
    expect(String(result["error"])).toContain("missing-port");
    expect(String(result["error"])).toContain("没有可用端口");
    expect(result["group"]).toBeUndefined();
    // ...and NOTHING started: no child wrote the order file and the Host
    // registered no running instance.
    expect(orderOf(f.orderPath)).toEqual([]);
    const records = await f.request("task/serviceRunRecords", {});
    expect(records["records"]).toEqual([]);
    expect(records["registered"]).toEqual([]);
    expect(existsSync(join(f.taskDir, "repo-a", "svc-a", "listening.txt"))).toBe(false);
    expect(existsSync(join(f.taskDir, "repo-a", "svc-b", "listening.txt"))).toBe(false);
  });

  it("carries no session and no approval through the new caller, so it cannot reach the agent tier", { timeout: 60_000 }, async () => {
    const f = await fixture("listening");
    await f.planOnly();
    expect((await f.startGroupThroughMain())["group"]).toBeDefined();
    const control = f.routed().find((entry) => entry.op === "task/controlService");
    // The one forwarded control is the attested human path: a page cannot smuggle
    // a session, a pre-granted approval or a unit selection through this entry.
    expect(control?.payload["sessionId"]).toBeUndefined();
    expect(control?.payload["approvalId"]).toBeUndefined();
    expect(Object.keys(control?.payload ?? {}).sort()).toEqual(["action", "group", "label"]);
    expect(control?.origin?.kind).toBe("service-catalog");
    // Every unit start still went through the ONE gated dispatch, in plan order.
    expect(orderOf(f.orderPath).map(([tag]) => tag)).toEqual(["callee", "caller"]);
  });

  it("keeps the group gate intact after the production caller ran: read-only refuses, default parks, no child added", { timeout: 60_000 }, async () => {
    const f = await fixture("listening");
    await f.planOnly();
    expect(((await f.startGroupThroughMain())["group"] as Record<string, unknown>)["state"]).toBe("verified");
    await until(() => orderOf(f.orderPath).length === 2, "both children to report their start");
    const before = orderOf(f.orderPath).length;
    const beforeRecords = (await f.request("task/serviceRunRecords", {}))["records"] as unknown[];
    expect(beforeRecords).toHaveLength(2);

    // A read-only session's group start is refused, with NOTHING started.
    expect(await f.request("task/setPermission", { sessionId: "read-1", permission: "read" })).toMatchObject({ permission: "read" });
    const refused = await f.request("task/controlService", { group: true, action: "start", sessionId: "read-1" }, CONTROL_ORIGIN);
    expect((refused["group"] as Record<string, unknown>)["state"]).toBe("refused");

    // A default-tier agent's group start parks on a one-shot approval.
    expect(await f.request("task/setPermission", { sessionId: "ask-1", permission: "default" })).toMatchObject({ permission: "default" });
    const parked = await f.request("task/controlService", { group: true, action: "start", sessionId: "ask-1" }, CONTROL_ORIGIN);
    expect((parked["group"] as Record<string, unknown>)["state"]).toBe("approval-required");

    // Neither attempt started a child: the file the CHILDREN write did not grow,
    // no new run record exists, and no instance was registered as running.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(orderOf(f.orderPath)).toHaveLength(before);
    expect((await f.request("task/serviceRunRecords", {}))["records"]).toHaveLength(beforeRecords.length);
    expect(f.routed().filter((entry) => entry.op === "task/controlService")).toHaveLength(1);
  });

  it("leaves no child of its own behind after a full group run is stopped", { timeout: 60_000 }, async () => {
    const f = await fixture("listening");
    await f.planAndRegister();
    const started = await f.startGroup();
    expect((started["group"] as Record<string, unknown>)["state"]).toBe("verified");
    await until(() => orderOf(f.orderPath).length === 2, "both children to report their start");
    const pids = orderOf(f.orderPath).map(([, pid]) => Number(pid));
    expect(pids.every((pid) => alive(pid))).toBe(true);

    for (const serviceId of [f.callerId, f.calleeId]) {
      expect(await f.request("task/controlService", { serviceId, action: "stop", label: "显式停止" }, CONTROL_ORIGIN)).toMatchObject({ action: "stop" });
    }
    await until(() => pids.every((pid) => !alive(pid)), "both group children to exit");
    expect(pids.some((pid) => alive(pid))).toBe(false);
  });
});
