/**
 * [PiDock 05] (#10 boxes 3 and 8) two tasks, one service name, real children.
 *
 * What this suite is for, stated first because the whole suite is about that
 * distinction: the [PiDock 05] boxes ask for two tasks running the SAME service
 * on DIFFERENT local ports with separate logs and separate effective variables,
 * where a real request only reaches its own task's instance, and for a stop that
 * touches only the registered process tree of the task it was asked about.
 * Those guarantees are structural here (one Host per task, one
 * `TaskServiceProcesses` per task, one durable ownership document per task
 * folder), and this suite is the evidence, not a re-implementation.
 *
 * Evidence split (stated, not implied):
 * - REAL processes: two Node children of the same `serviceId` in two different
 *   task workspaces, started by the Host's own `TaskServiceProcesses` driver and
 *   catalog-resolution path. Each child really binds a TCP socket; liveness and
 *   instance identity are read from the OS (`kill(pid, 0)`) and from a real HTTP
 *   request to each port, never from a returned flag.
 * - REAL Hosts: two independent module instances of `./host.js`, each bound to
 *   its own `PIDOCK_TASK_ID`/`PIDOCK_TASK_DIR` and its own fake parent port (the
 *   same seam `service-execution-wiring.test.ts` uses for one Host). Every
 *   start/stop goes through that Host's gated `task/controlService`, and the run
 *   record / stop scope are read back from the Host's own payloads.
 * - ONE shared main process: a single real `ServiceCatalog` holds the shared
 *   template and one binding per task, so the same service name is bound to two
 *   workspaces. The per-task differences (port, tag) ride the binding's own
 *   local private references - the ONLY existing per-task env seam.
 * - FIXTURE: the catalog authority is an in-test stub (its own suites cover the
 *   real `TaskRootIndex`); no Electron GUI, no packaged build, no Provider turn,
 *   no Windows run. The optional durable owner inventory
 *   (`InstalledServiceHostAuthority`) is deliberately absent here because both
 *   tasks share one vitest process; its uncertainty path is covered by
 *   `service-execution-wiring.test.ts`.
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "../rpc/host-client.js";
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

/**
 * The fixture child: a real HTTP service on the port its own effective
 * environment declares. It answers every request with the identity only IT can
 * know (its port, its pid, the workspace directory it was started in), writes a
 * marker file into that directory, and keeps running.
 */
const SERVICE_SCRIPT = `const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const cwd = process.cwd();
const port = Number(process.env.PORT);
const server = http.createServer((_request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ dir: path.basename(cwd), pid: process.pid, port, greeting: process.env.SERVICE_GREETING }));
});
server.listen(port, "127.0.0.1", () => {
  fs.writeFileSync(path.join(cwd, "listening.txt"), String(process.pid));
  console.log("listening:" + path.basename(cwd) + ":pid" + process.pid);
});
setInterval(() => {}, 1000);
`;

/** A child that really starts and then really ends on its own. */
const ONE_SHOT_SCRIPT = `const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(process.cwd(), "one-shot.txt"), String(process.pid));
console.log("one-shot done");
`;

const WAIT_MS = 30_000;
const POLL_MS = 25;
/** Budget for the read-back polls: short enough that the ASSERTION fails, not the test timeout. */
const READBACK_MS = 10_000;

/** One TCP port nobody holds right now, taken from the OS itself. */
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

/**
 * OS liveness of a pid this suite really started. `kill(pid, 0)` alone still
 * succeeds for a corpse the OS has not reaped yet, so the process state is read
 * too: a `Z` row is NOT a live child, and calling a zombie "still alive" would
 * be exactly the unsupported claim this ticket forbids. Fixed argv, no shell; an
 * unreadable row reads as not alive.
 */
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

interface Answer { dir: string; pid: number; port: number; greeting: string }

/** One real HTTP request to one port; `null` while nothing answers there yet. */
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

interface TaskHarness {
  taskId: string;
  taskDir: string;
  client: HostClient;
  /** One real Host op for this task, with this task's env binding in place. */
  request(op: string, payload?: Record<string, unknown>, origin?: { kind: "shell-ui" | "service-catalog"; senderWebContentsId: number }): Promise<Record<string, unknown>>;
}

function stubTaskEnv(taskId: string, taskDir: string, profile: string): void {
  for (const [name, value] of Object.entries({ PIDOCK_WORKSPACE_ID: "workspace-a", PIDOCK_TASK_ID: taskId, PIDOCK_TASK_DIR: taskDir, PIDOCK_PROTECTED_PROFILE: profile })) {
    vi.stubEnv(name, value);
  }
}

/**
 * A real Host for one task workspace. `./host.js` reads its task binding and its
 * parent port at module load, so a second task needs a second module instance -
 * the same thing a second forked utilityProcess gives production.
 */
async function startTaskHost(taskId: string, taskDir: string, profile: string): Promise<{ client: HostClient; child: EventEmitter & { postMessage(value: unknown): void; kill(): void } }> {
  const pair = portPair();
  pair.child.kill = vi.fn(() => { pair.child.emit("exit", 0); });
  const previous = Object.getOwnPropertyDescriptor(process, "parentPort");
  Object.defineProperty(process, "parentPort", { configurable: true, value: pair.parent });
  cleanups.push(() => {
    if (previous) Object.defineProperty(process, "parentPort", previous);
    else Reflect.deleteProperty(process, "parentPort");
  });
  stubTaskEnv(taskId, taskDir, profile);
  vi.resetModules();
  const { startHost } = await import("./host.js");
  startHost();
  const client = new HostClient(pair.child as never);
  cleanups.push(() => { client.dispose(); });
  return { client, child: pair.child };
}

interface CatalogFixture {
  catalog: ServiceCatalog;
  projectId: string;
  /** The environment task A's binding selects (the project's first, `开发环境`). */
  environmentId: string;
  /** The second named environment and its own greeting, present only with `perEnvironment`. */
  stagingEnvironmentId: string | null;
  serviceId: string;
  oneShotId: string;
  taskA: TaskHarness;
  taskB: TaskHarness;
  portA: number;
  portB: number;
}

/**
 * Two provisioned task workspaces, one shared template, one binding each, and a
 * real Host per task. The only per-task launch difference is the local private
 * reference layer of that task's own binding.
 *
 * With `perEnvironment` the two bindings select two DIFFERENT named environments
 * that hold the same service name with a different shared greeting, so the
 * effective environment each real child prints is the one its own environment
 * carries - the per-environment half of [PiDock 04] #7 box 1.
 */
async function twoTasks(options: { perEnvironment?: boolean } = {}): Promise<CatalogFixture> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-two-tasks-")));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const profile = join(home, "profile");
  const root = join(home, "tasks");
  const projectId = randomUUID();
  mkdirSync(profile, { mode: 0o700 });
  const [portA, portB] = [await freePort(), await freePort()];
  if (portA === portB) throw Error("the OS handed out the same port twice");

  interface Provisioned { taskId: string; taskDir: string; subdir: string; port: number; tag: string; envRef: string }
  const provisioned: Provisioned[] = [
    { taskId: "task-aaa11111", taskDir: join(root, "task-aaa11111"), subdir: "svc-a", port: portA, tag: "alpha", envRef: "PIDOCK_TWO_TASK_PORT_A" },
    { taskId: "task-bbb22222", taskDir: join(root, "task-bbb22222"), subdir: "svc-b", port: portB, tag: "beta", envRef: "PIDOCK_TWO_TASK_PORT_B" },
  ];
  for (const task of provisioned) {
    mkdirSync(join(task.taskDir, "repo-a", task.subdir), { recursive: true });
    writeFileSync(join(task.taskDir, "repo-a", task.subdir, "service.cjs"), SERVICE_SCRIPT);
    diskTaskStore.writeTask(task.taskDir, buildTaskDiskRecord({
      taskId: task.taskId, name: `Task ${task.tag}`, dirId: task.taskId, branch: "task/main", root, taskDir: task.taskDir,
      remoteBranch: "main", baseCommit: "source-fixture", repos: ["repo-a"], now: "2026-01-01T00:00:00.000Z",
    }));
  }

  const identityOf = (task: Provisioned) => {
    const stats = statSync(task.taskDir, { bigint: true });
    return { taskId: task.taskId, createdAt: "2026-01-01T00:00:00.000Z", root, realRoot: root, dirId: task.taskId,
      directoryDevice: stats.dev.toString(), directoryInode: stats.ino.toString() };
  };
  const owner = (id: string) => {
    const task = provisioned.find((candidate) => candidate.taskId === id);
    return task ? { identity: identityOf(task), projectId, rootIds: ["repo-a"] } : null;
  };
  const authority: ServiceCatalogAuthority = { projectExists: (id) => id === projectId, task: (id) => owner(id), verifiedTask: (id) => owner(id) };
  const catalog = new ServiceCatalog(profile, authority);
  const environmentId = catalog.createEnvironment({ projectId, name: "开发环境" }).environmentId;
  const stagingEnvironmentId = options.perEnvironment ? catalog.createEnvironment({ projectId, name: "预发环境" }).environmentId : null;

  // ONE shared template: one service name, one program, one argv, one declared
  // port list (empty - the port is the task's own binding below).
  const descriptor = { name: "Invoice API", program: "node", args: ["service.cjs"], ports: [], runType: "long-lived" as const };
  const template = catalog.saveTemplate({
    projectId,
    environmentId,
    descriptor,
    shared: [{ key: "SERVICE_GREETING", value: "hello-shared", secret: false }],
  });
  // The SAME service id inside the second environment: its own version line, its
  // own shared material. Nothing here is a fixture value the launch could skip -
  // main resolves the revision from the environment the binding selected.
  if (stagingEnvironmentId !== null) {
    catalog.saveTemplate({
      projectId, environmentId: stagingEnvironmentId, serviceId: template.serviceId, expectedVersion: 0, descriptor,
      shared: [{ key: "SERVICE_GREETING", value: "hello-staging", secret: false }],
    });
  }
  for (const task of provisioned) {
    vi.stubEnv(task.envRef, String(task.port));
    catalog.bindTask({
      taskId: task.taskId, serviceId: template.serviceId,
      environmentId: stagingEnvironmentId !== null && task.tag === "beta" ? stagingEnvironmentId : environmentId,
      templateVersion: 1, rootId: "repo-a", subdir: task.subdir,
      programPath: realpathSync(process.execPath), privateRefs: [{ key: "PORT", envRef: task.envRef }],
    });
  }

  // A second, one-shot service bound to task A only: it really starts and then
  // really ends by itself, so the registered tree can be checked for the dead pid.
  const oneShot = catalog.saveTemplate({
    projectId,
    environmentId,
    descriptor: { name: "Migrate once", program: "node", args: ["one-shot.cjs"], ports: [], runType: "one-shot" },
    shared: [],
  });
  writeFileSync(join(provisioned[0]!.taskDir, "repo-a", provisioned[0]!.subdir, "one-shot.cjs"), ONE_SHOT_SCRIPT);
  catalog.bindTask({
    taskId: provisioned[0]!.taskId, serviceId: oneShot.serviceId, environmentId, templateVersion: 1, rootId: "repo-a", subdir: provisioned[0]!.subdir,
    programPath: realpathSync(process.execPath), privateRefs: [],
  });

  const harnesses = new Map<string, TaskHarness>();
  for (const task of provisioned) {
    // Each Host is imported while ITS env binding is in place, exactly like a
    // forked utilityProcess receiving the task env at fork time.
    const { client } = await startTaskHost(task.taskId, task.taskDir, profile);
    harnesses.set(task.taskId, {
      taskId: task.taskId,
      taskDir: task.taskDir,
      client,
      async request(op, payload = {}, origin) {
        stubTaskEnv(task.taskId, task.taskDir, profile);
        try {
          const result = await client.task({ workspaceId: "workspace-a", taskId: task.taskId, op: op as never, payload, ...(origin ? { origin } : {}) });
          return result.payload;
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      },
    });
  }

  const taskA = harnesses.get("task-aaa11111") as TaskHarness;
  const taskB = harnesses.get("task-bbb22222") as TaskHarness;
  // Cleanups run in reverse, so the children are stopped first - through the
  // same gated stop the suite asserts, and never by a broad kill.
  cleanups.push(async () => {
    for (const task of [taskA, taskB]) {
      for (const id of [template.serviceId, oneShot.serviceId]) {
        await task.request("task/controlService", { serviceId: id, action: "stop", label: "suite cleanup" }, { kind: "shell-ui", senderWebContentsId: 7 });
      }
    }
  });
  return { catalog, projectId, environmentId, stagingEnvironmentId, serviceId: template.serviceId, oneShotId: oneShot.serviceId, taskA, taskB, portA, portB };
}

/** Register the catalog-resolved launch on one task's Host, like main does. */
async function register(task: TaskHarness, fixture: CatalogFixture, serviceId: string): Promise<Record<string, unknown>> {
  const launch = fixture.catalog.launchFor(task.taskId, fixture.projectId, serviceId, process.env);
  return task.request("task/registerService", {
    serviceId: launch.serviceId, descriptor: launch.descriptor, layers: launch.layers, templateVersion: String(launch.templateVersion),
  }, { kind: "service-catalog", senderWebContentsId: 7 });
}

const control = (task: TaskHarness, serviceId: string, action: "start" | "stop") =>
  task.request("task/controlService", { serviceId, action, label: "主进程服务目录入口" }, { kind: "shell-ui", senderWebContentsId: 7 });

function markerPid(taskDir: string, subdir: string): number | undefined {
  try {
    const pid = Number(readFileSync(join(taskDir, "repo-a", subdir, "listening.txt"), "utf8"));
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

describe.skipIf(process.platform === "win32")("#10 two tasks running the same service name", () => {
  it("runs two real children of one service name in two workspaces, routes each request to its own instance, and stops only the addressed task's child", { timeout: 60_000 }, async () => {
    const fixture = await twoTasks();
    const { serviceId, taskA, taskB } = fixture;

    for (const task of [taskA, taskB]) {
      expect(await register(task, fixture, serviceId)).toMatchObject({ service: { serviceId, launchSource: "catalog" } });
    }
    // Both starts are real: each control call resolves only after its own
    // child exists, and the two Hosts are separate process owners.
    expect(await control(taskA, serviceId, "start")).toMatchObject({ serviceId, action: "start", actor: "human" });
    expect(await control(taskB, serviceId, "start")).toMatchObject({ serviceId, action: "start", actor: "human" });

    await until(() => markerPid(taskA.taskDir, "svc-a") !== undefined, "task A's child to report itself");
    await until(() => markerPid(taskB.taskDir, "svc-b") !== undefined, "task B's child to report itself");
    const pidA = markerPid(taskA.taskDir, "svc-a") as number;
    const pidB = markerPid(taskB.taskDir, "svc-b") as number;
    expect(pidA).not.toBe(pidB);
    expect(alive(pidA)).toBe(true);
    expect(alive(pidB)).toBe(true);

    // (1) Both children really LISTEN, and the port each one holds is the port
    // its own task's binding declared - not a plan, not a fixture.
    await until(() => ask(fixture.portA) !== null, "task A's service to answer on its own port");
    await until(() => ask(fixture.portB) !== null, "task B's service to answer on its own port");
    const answerA = (await ask(fixture.portA)) as Answer;
    const answerB = (await ask(fixture.portB)) as Answer;
    expect(fixture.portA).not.toBe(fixture.portB);
    // (3) HONESTY: the identity that answers is the identity the OS reports for
    // the pid each workspace's marker named - so the request reached THIS task's
    // instance, and a reply from a planned-but-not-started instance cannot pass.
    expect(answerA).toEqual({ dir: "svc-a", pid: pidA, port: fixture.portA, greeting: "hello-shared" });
    expect(answerB).toEqual({ dir: "svc-b", pid: pidB, port: fixture.portB, greeting: "hello-shared" });
    // The shared layer is shared; the task's own binding is what differs.
    expect(answerA.greeting).toBe(answerB.greeting);

    // Separate log streams: each Host holds only its own child's output, and the
    // line names the workspace that child was started in.
    const logA = await taskA.request("task/serviceLog", { serviceId, limit: 50 });
    const logB = await taskB.request("task/serviceLog", { serviceId, limit: 50 });
    const linesA = (logA["log"] as { line: string }[]).map((entry) => entry.line);
    const linesB = (logB["log"] as { line: string }[]).map((entry) => entry.line);
    expect(linesA.some((line) => line.includes(`listening:svc-a:pid${pidA}`))).toBe(true);
    expect(linesA.some((line) => line.includes("svc-b"))).toBe(false);
    expect(linesB.some((line) => line.includes(`listening:svc-b:pid${pidB}`))).toBe(true);
    expect(linesB.some((line) => line.includes("svc-a"))).toBe(false);

    // The registered tree each task's own read answers from holds ITS child, and
    // the recorded identity is the OBSERVED pid, not the declared port.
    const recordsA = await taskA.request("task/serviceRunRecords", {});
    const registeredA = recordsA["registered"] as { instanceId: string; pid: number; serviceId: string }[];
    expect(registeredA).toHaveLength(1);
    expect(registeredA[0]).toMatchObject({ instanceId: `${taskA.taskId}/${serviceId}`, pid: pidA, serviceId });
    const runA = (recordsA["records"] as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(runA["processIdentity"]).toMatchObject({ pid: pidA, owner: "human" });
    expect(runA["ports"]).toEqual([fixture.portA]);
    // DECLARED, never observed: this Host owns no port probe.
    expect(runA["portsSource"]).toBe("declared");
    expect(runA["endedAt"]).toBeUndefined();
    // This registration carried no worktree observation, so the code/build state
    // stays `unknown` BY NAME on the REAL seam: a start whose worktree nobody
    // read must never read as a clean tree or a fresh build. (Box 6's own read is
    // exercised end to end in `service-execution-wiring.test.ts` and
    // `main/service-code-observation.test.ts`.)
    expect(runA["codeState"]).toMatchObject({ kind: "unknown" });
    expect(runA["buildFreshness"]).toBe("unknown");

    const scopeA = (await taskA.request("task/serviceStopScope", {})).scope as { stop: { pid: number }[]; skipped: unknown[] };
    const scopeBeforeStopB = (await taskB.request("task/serviceStopScope", {})).scope as { stop: { pid: number }[] };
    expect(scopeA.stop.map((entry) => entry.pid)).toEqual([pidA]);
    expect(scopeBeforeStopB.stop.map((entry) => entry.pid)).toEqual([pidB]);

    // (2) BOX 8: stopping task A's service must touch only A's registered tree.
    expect(await control(taskA, serviceId, "stop")).toMatchObject({ serviceId, action: "stop" });
    await until(() => !alive(pidA), "task A's child to really exit");
    // These two assertions are the ones that fail if the stop path degenerates
    // into a broad kill (pkill by program name, a signal to the shared process
    // group, or a machine-wide port sweep): task B's child is still alive and
    // task B's port still answers with task B's own instance.
    expect(alive(pidB)).toBe(true);
    expect(await ask(fixture.portB)).toEqual({ dir: "svc-b", pid: pidB, port: fixture.portB, greeting: "hello-shared" });

    // Task B's own read is unchanged, and task A's record is closed with a reason.
    const recordsAAfter = await taskA.request("task/serviceRunRecords", {});
    expect(recordsAAfter["registered"]).toEqual([]);
    expect((recordsAAfter["records"] as Record<string, unknown>[])[0]?.["endedAt"]).toBeTypeOf("string");
    expect((await taskB.request("task/serviceRunRecords", {}))["registered"]).toMatchObject([{ pid: pidB }]);

    // ...and task B's own stop still reaches its own child.
    expect(await control(taskB, serviceId, "stop")).toMatchObject({ serviceId, action: "stop" });
    await until(() => !alive(pidB), "task B's child to really exit");
    expect(alive(pidA)).toBe(false);
  });

  // [PiDock 04] (#7 box 1) the environment is a launch input, not a label: two
  // tasks bound to the SAME service name in two DIFFERENT named environments
  // each run a real child whose effective variables are its own environment's.
  it("runs each task's service out of its own named environment, so the effective value each real child prints differs per environment", { timeout: 60_000 }, async () => {
    const fixture = await twoTasks({ perEnvironment: true });
    const { serviceId, taskA, taskB } = fixture;
    expect(fixture.stagingEnvironmentId).not.toBeNull();
    expect(fixture.stagingEnvironmentId).not.toBe(fixture.environmentId);

    // Main's own resolution names the environment it read, per binding.
    expect(fixture.catalog.launchFor(taskA.taskId, fixture.projectId, serviceId, process.env))
      .toMatchObject({ environmentId: fixture.environmentId, environmentName: "开发环境", templateVersion: 1 });
    expect(fixture.catalog.launchFor(taskB.taskId, fixture.projectId, serviceId, process.env))
      .toMatchObject({ environmentId: fixture.stagingEnvironmentId, environmentName: "预发环境", templateVersion: 1 });

    for (const task of [taskA, taskB]) {
      expect(await register(task, fixture, serviceId)).toMatchObject({ service: { serviceId, launchSource: "catalog" } });
    }
    expect(await control(taskA, serviceId, "start")).toMatchObject({ serviceId, action: "start" });
    expect(await control(taskB, serviceId, "start")).toMatchObject({ serviceId, action: "start" });

    await until(() => markerPid(taskA.taskDir, "svc-a") !== undefined, "task A's child to report itself");
    await until(() => markerPid(taskB.taskDir, "svc-b") !== undefined, "task B's child to report itself");
    await until(() => ask(fixture.portA) !== null, "task A's service to answer");
    await until(() => ask(fixture.portB) !== null, "task B's service to answer");
    const pidA = markerPid(taskA.taskDir, "svc-a") as number;
    const pidB = markerPid(taskB.taskDir, "svc-b") as number;
    const answerA = (await ask(fixture.portA)) as Answer;
    const answerB = (await ask(fixture.portB)) as Answer;
    expect(answerA).toEqual({ dir: "svc-a", pid: pidA, port: fixture.portA, greeting: "hello-shared" });
    expect(answerB).toEqual({ dir: "svc-b", pid: pidB, port: fixture.portB, greeting: "hello-staging" });
    // The two children really observed different values, and neither is a plan:
    // each answer carries its own OS pid and its own environment's greeting.
    expect(answerA.greeting).not.toBe(answerB.greeting);
    expect(alive(pidA)).toBe(true);
    expect(alive(pidB)).toBe(true);
    // Same service name, and each task still runs its own instance.
    expect(pidA).not.toBe(pidB);

    // Stopping the 开发环境 instance leaves the 预发环境 one really running.
    expect(await control(taskA, serviceId, "stop")).toMatchObject({ serviceId, action: "stop" });
    await until(() => !alive(pidA), "task A's child to really exit");
    expect(alive(pidB)).toBe(true);
    expect(await ask(fixture.portB)).toEqual({ dir: "svc-b", pid: pidB, port: fixture.portB, greeting: "hello-staging" });
    expect(await control(taskB, serviceId, "stop")).toMatchObject({ serviceId, action: "stop" });
    await until(() => !alive(pidB), "task B's child to really exit");
  });

  it("drops a child that ended on its own out of the registered tree, keeping the real exit reason", { timeout: 30_000 }, async () => {
    const fixture = await twoTasks();
    const { oneShotId, taskA } = fixture;

    expect(await register(taskA, fixture, oneShotId)).toMatchObject({ service: { serviceId: oneShotId, launchSource: "catalog" } });
    expect(await control(taskA, oneShotId, "start")).toMatchObject({ serviceId: oneShotId, action: "start" });

    // The child really ran (it reported its own pid into its own cwd) and then
    // really ended by itself: the Host observed the close, not a guess. The
    // reading below is what a short-lived child does in production, and it is
    // also the race the driver's exit reason exists for - the record may be
    // written after the child is already gone.
    await until(() => {
      try { return readFileSync(join(taskA.taskDir, "repo-a", "svc-a", "one-shot.txt"), "utf8").trim().length > 0; }
      catch { return false; }
    }, "the one-shot child to report itself");
    const pid = Number(readFileSync(join(taskA.taskDir, "repo-a", "svc-a", "one-shot.txt"), "utf8"));
    expect(pid).toBeGreaterThan(0);
    await until(() => !alive(pid), "the one-shot child to end on its own");

    // A dead pid must not stay in the registered tree: the box-8 stop scope
    // would otherwise offer a process that no longer exists.
    let records = await taskA.request("task/serviceRunRecords", {});
    for (let elapsed = 0; elapsed < READBACK_MS; elapsed += POLL_MS) {
      if ((records["registered"] as unknown[]).length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      records = await taskA.request("task/serviceRunRecords", {});
    }
    expect(records["registered"]).toEqual([]);
    const closed = (records["records"] as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(closed["processIdentity"]).toMatchObject({ pid, owner: "human" });
    expect(closed["endedAt"]).toBeTypeOf("string");
    expect((closed["exit"] as { reason: string }).reason).toBe("exit:0");
  });

  it("refuses a shell-UI registration that tries to SELF-ATTEST the code state, and stores nothing", { timeout: 30_000 }, async () => {
    const fixture = await twoTasks();
    const { taskA } = fixture;
    const launch = fixture.catalog.launchFor(taskA.taskId, fixture.projectId, fixture.serviceId, process.env);
    const claimed = { commit: "0".repeat(40), dirty: false };

    // The renderer's own route is `shell/taskOp` with main's `shell-ui`
    // attestation: it can send this payload, and it must be refused by name
    // rather than have its claim become a code state.
    const refused = await taskA.request("task/registerService", {
      serviceId: launch.serviceId, descriptor: launch.descriptor, layers: launch.layers,
      templateVersion: String(launch.templateVersion), code: claimed,
    }, { kind: "shell-ui", senderWebContentsId: 7 });
    expect(refused["error"]).toBe("permission-denied: 代码状态只能来自主进程对真实工作树的观测，界面登记不能自证");
    // Nothing was stored: the refusal precedes the registration, so no run can
    // ever report the page's claim.
    expect(await taskA.request("task/serviceStatus", { serviceId: fixture.serviceId }))
      .toMatchObject({ error: `unknown-service: ${fixture.serviceId} is not registered on this task` });
    const records = await taskA.request("task/serviceRunRecords", {});
    expect(records["records"]).toEqual([]);
    expect(records["registered"]).toEqual([]);

    // The discriminating half: the SAME payload from main's own trusted-catalog
    // registration is accepted, so the refusal is about the caller, not about
    // the field being silently dropped.
    expect(await register(taskA, fixture, fixture.serviceId)).toMatchObject({ service: { launchSource: "catalog" } });
    expect(await control(taskA, fixture.serviceId, "start")).toMatchObject({ serviceId: fixture.serviceId, action: "start" });
    const [run] = (await taskA.request("task/serviceRunRecords", {}))["records"] as Record<string, unknown>[];
    // No observation was carried by this hand-built registration, so the code
    // state stays `unknown` BY NAME - the field is never filled in from a guess.
    expect(run?.["codeState"]).toMatchObject({ kind: "unknown" });
    expect(run?.["buildFreshness"]).toBe("unknown");
  });

  it("records the observation main's catalog registration carried, for the run the start really produced", { timeout: 30_000 }, async () => {
    const fixture = await twoTasks();
    const { taskA } = fixture;
    const launch = fixture.catalog.launchFor(taskA.taskId, fixture.projectId, fixture.serviceId, process.env);
    // Exactly what main sends after reading the launch's verified cwd
    // (`runtime.ts` + `main/service-code-observation.ts`), with main's own
    // `service-catalog` attestation.
    const observed = { commit: "a".repeat(40), dirty: true };
    expect(await taskA.request("task/registerService", {
      serviceId: launch.serviceId, descriptor: launch.descriptor, layers: launch.layers,
      templateVersion: String(launch.templateVersion), code: observed,
    }, { kind: "service-catalog", senderWebContentsId: 7 })).toMatchObject({ service: { launchSource: "catalog" } });

    expect(await control(taskA, fixture.serviceId, "start")).toMatchObject({ serviceId: fixture.serviceId, action: "start" });
    const [run] = (await taskA.request("task/serviceRunRecords", {}))["records"] as Record<string, unknown>[];
    expect(run?.["codeState"]).toMatchObject({ kind: "uncommitted", commit: observed.commit });
    // A dirty tree is `uncommitted-code`, never `fresh`: the build cannot
    // contain the edits nobody committed.
    expect(run?.["buildFreshness"]).toBe("uncommitted-code");
    expect((run?.["processIdentity"] as { pid: number }).pid).toBeGreaterThan(0);
  });
});
