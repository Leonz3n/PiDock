/**
 * [PiDock 04] (#7) production service-execution wiring, driven through the
 * real Host RPC path with REAL child processes.
 *
 * Evidence split (stated, not implied):
 * - REAL subprocess: the service fixtures are Node scripts started by
 *   `TaskServiceProcesses` through the Host's `task/controlService` path
 *   after main's trusted catalog resolved the launch. Status, bounded
 *   redacted logs, OS process liveness and per-child env are observed on the
 *   real children.
 * - REAL production objects: `ServiceCatalog` on a temp profile, the Host
 *   itself (`./host.js` with a fake `process.parentPort` pair, the same seam
 *   `host-service-binding.test.ts` uses), the real `PerTaskHostRegistry` and
 *   the real `InstalledServiceHostAuthority`.
 * - FIXTURE: the catalog authority is an in-test stub (the real
 *   `TaskRootIndex`/`ProjectRegistry` wiring has its own suites) and the
 *   "program picker" result is `process.execPath`, not a native dialog. No
 *   Electron UI, no packaged build, no Windows run.
 */
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "../rpc/host-client.js";
import { InstalledServiceHostAuthority } from "../main/service-host-binding.js";
import { PerTaskHostRegistry, runTaskService } from "../main/runtime.js";
import { ServiceCatalog, type ServiceCatalogAuthority } from "../main/service-catalog.js";
import type { ServiceDescriptor } from "../main/service-config.js";
import { diskTaskStore } from "./task-host.js";
import { buildTaskDiskRecord, readServiceOwnershipOnDisk } from "./task-store.js";
import { SERVICE_STOP_CONFIRM_MS, SERVICE_STOP_GRACE_MS, TaskServiceProcesses } from "./service-processes.js";
import { diskServiceOwnershipLog, verifyServiceOwnershipIdentity } from "./service-ownership.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

const SERVICE_SCRIPT = `const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(process.cwd(), "started-" + process.env.SERVICE_TAG + ".txt"), String(process.pid));
console.log("ready:" + process.env.SERVICE_GREETING + ":" + process.env.SERVICE_TAG);
console.log("pid:" + process.pid);
console.log("token:" + (process.env.SERVICE_TOKEN ?? "none"));
console.log("ambient:" + (process.env.PIDOCK_TEST_AMBIENT ?? "absent"));
process.stdout.write("x".repeat(2500) + "\\n");
setInterval(() => {}, 1000);
`;

/**
 * A real HTTP health listener on 127.0.0.1 for the declared 健康检查 of one
 * test. It answers 200, counts the connections it really accepted (so "nothing
 * was dialled" and "exactly one attempt" are observable facts), and is closed
 * by every exit path - internally when the test wants a refused target, and by
 * the suite's own cleanup otherwise.
 */
interface HealthListener {
  readonly port: number;
  readonly connections: number;
  close(): Promise<void>;
}

async function httpHealthListener(): Promise<HealthListener> {
  const server = createHttpServer((_request, response) => { response.writeHead(200, { "content-type": "text/plain" }); response.end("health"); });
  const sockets = new Set<Socket>();
  let connections = 0;
  server.on("connection", (socket) => { connections += 1; sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("clientError", () => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw Error("no-bound-port");
  const listener: HealthListener = {
    port: address.port,
    get connections() { return connections; },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  cleanups.push(() => listener.close());
  return listener;
}

/**
 * `TaskServiceProcesses.stop` sends SIGTERM, waits `stopGraceMs` (3000ms),
 * then SIGKILL and waits `stopConfirmMs` (1000ms) before it reports a failure
 * (`./service-processes.ts`). A stop wait must comfortably EXCEED that
 * 4000ms budget: a tighter budget can expire while the driver is still inside
 * its own stop window under parallel test load, turning "still stopping" into
 * a false "never stopped". This is a generous multiple of the real budget and
 * still fails on a genuinely stuck child.
 */
const STOP_WAIT_MS = 30_000;
/** Poll interval for the stop/log waits; the budget is polled at this cadence. */
const POLL_INTERVAL_MS = 25;

async function until(check: () => boolean, label: string) {
  for (let elapsed = 0; elapsed < STOP_WAIT_MS; elapsed += POLL_INTERVAL_MS) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw Error(`timed out waiting for ${label}`);
}

/** Wait until a running service's bounded log satisfies a predicate. */
async function untilLog(read: () => Promise<string[]>, serviceId: string, check: (lines: string[]) => boolean) {
  let seen: string[] = [];
  for (let elapsed = 0; elapsed < STOP_WAIT_MS; elapsed += POLL_INTERVAL_MS) {
    seen = await read();
    if (check(seen)) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw Error(`timed out waiting for the log of ${serviceId}: ${seen.join(" | ")}`);
}

interface FixtureOptions {
  /**
   * Bind the Host to a spelling of the same task folder that resolves through
   * a symlinked *ancestor* - the way `/tmp`/`/var` on macOS or a symlinked
   * home spells a real task path. The folder, the task root's realpath and
   * the task record all stay the same, so only the Host's own
   * `PIDOCK_TASK_DIR` text is non-canonical.
   */
  nonCanonicalTaskDir?: boolean;
  /** Main cannot produce a trusted owner snapshot, so it never bootstraps the Host. */
  ownerAuthorityUnavailable?: boolean;
  /**
   * Make the task folder a REAL git worktree (one commit) instead of a plain
   * directory, so main's own worktree read ([PiDock 05] #10 box 6) has something
   * real to observe. The two `git` calls are test fixtures on a TEMP repository.
   */
  gitWorktree?: boolean;
}

async function installed(options: FixtureOptions = {}) {
  vi.resetModules();
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-service-wiring-")));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const profile = join(home, "profile");
  const root = join(home, "tasks");
  const taskId = "task-7f3a91bc";
  const taskDir = join(root, taskId);
  const hostRoot = options.nonCanonicalTaskDir ? join(linkedHome(home), "tasks") : root;
  const hostTaskDir = join(hostRoot, taskId);
  const workspaceId = "workspace-a";
  const projectId = randomUUID();
  mkdirSync(profile, { mode: 0o700 });
  for (const dir of ["repo-a/svc-a", "repo-a/svc-b"]) {
    mkdirSync(join(taskDir, dir), { recursive: true });
    writeFileSync(join(taskDir, dir, "service.cjs"), SERVICE_SCRIPT);
  }
  diskTaskStore.writeTask(taskDir, buildTaskDiskRecord({ taskId, name: "Wiring", dirId: taskId, branch: "task/main", root: hostRoot, taskDir: hostTaskDir,
    remoteBranch: "main", baseCommit: "source-fixture", repos: ["repo-a"], now: "2026-01-01T00:00:00.000Z" }));
  if (options.gitWorktree) {
    // A real worktree for the task folder, committed AFTER the task record is
    // written so the folder really starts out clean: `repo-a/svc-a` (the launch
    // cwd) is a subdirectory of it, exactly like a provisioned task.
    fixtureGit(taskDir, ["init", "-q", "-b", "main", "."]);
    fixtureGit(taskDir, ["add", "-A"]);
    fixtureGit(taskDir, ["commit", "-q", "-m", "fixture"]);
  }
  const taskStat = statSync(taskDir, { bigint: true });
  const identity = { taskId, createdAt: "2026-01-01T00:00:00.000Z", root, realRoot: root, dirId: taskId,
    directoryDevice: taskStat.dev.toString(), directoryInode: taskStat.ino.toString() };
  const owner = (id: string) => id === taskId ? { identity, projectId, rootIds: ["repo-a"] } : null;
  const authority: ServiceCatalogAuthority = {
    projectExists: (id) => id === projectId,
    task: (id) => owner(id),
    // Without a verified task snapshot main's `ownerSnapshot` fails, so it
    // fences the binding and never posts the durable owner bootstrap.
    ...(options.ownerAuthorityUnavailable ? {} : { verifiedTask: (id: string) => owner(id) }),
  };
  const catalog = new ServiceCatalog(profile, authority);
  const environmentId = catalog.createEnvironment({ projectId, name: "开发环境" }).environmentId;

  // Fake utilityProcess pair: `child` is main's handle, `parent` the Host's parentPort.
  const child = new EventEmitter() as EventEmitter & { postMessage(value: unknown): void; kill(): void };
  child.kill = vi.fn(() => { child.emit("exit", 0); });
  const parent = new EventEmitter() as EventEmitter & { postMessage(value: unknown): void };
  child.postMessage = (value) => { parent.emit("message", { data: value }); };
  parent.postMessage = (value) => { child.emit("message", value); };
  const oldPort = Object.getOwnPropertyDescriptor(process, "parentPort");
  Object.defineProperty(process, "parentPort", { configurable: true, value: parent });
  cleanups.push(() => { if (oldPort) Object.defineProperty(process, "parentPort", oldPort); else Reflect.deleteProperty(process, "parentPort"); });
  for (const [name, value] of Object.entries({ PIDOCK_WORKSPACE_ID: workspaceId, PIDOCK_TASK_ID: taskId, PIDOCK_TASK_DIR: hostTaskDir,
    PIDOCK_PROTECTED_PROFILE: profile, PIDOCK_SERVICE_OWNER_REQUIRED: "1" })) vi.stubEnv(name, value);
  vi.stubEnv("LOCAL_TEST_TOKEN", "synthetic-private-value");
  const { startHost } = await import("./host.js");
  startHost();
  const client = new HostClient(child as never);
  const main = new InstalledServiceHostAuthority(profile, catalog, authority, workspaceId, { LOCAL_TEST_TOKEN: "synthetic-private-value" });
  const registry = new PerTaskHostRegistry(workspaceId, async () => ({ client, child: child as never }), () => taskDir, undefined, undefined);
  registry.configureServices(() => main);
  // Cleanups run in reverse: quit the Host (which stops real service children
  // and needs the live parent authority) before the authority is disposed.
  cleanups.push(async () => { client.dispose(); child.emit("exit", 0); await main.disposeWhenExited().catch(() => {}); });
  cleanups.push(async () => { await registry.quitAll({ origin: { kind: "shell-ui", senderWebContentsId: 7 } }).catch(() => {}); });

  const task = (op: Parameters<HostClient["task"]>[0]["op"], payload: Record<string, unknown> = {}) => client.task({ workspaceId, taskId, op, payload,
    origin: { kind: "shell-ui", senderWebContentsId: 7 } });
  /** A failed Host op answers with an error response, which the RPC client rejects. */
  const request = async (op: Parameters<HostClient["task"]>[0]["op"], payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    try { return (await task(op, payload)).payload; } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  };
  /**
   * Register exactly like main's trusted catalog step does, without
   * controlling: the launch is resolved by main and the op carries main's own
   * `service-catalog` origin, never a renderer-supplied descriptor.
   */
  const register = async (serviceId: string) => {
    const launch = catalog.launchFor(taskId, projectId, serviceId, process.env);
    const result = await registry.routeTaskOp({ taskId, op: "task/registerService",
      payload: { serviceId: launch.serviceId, descriptor: launch.descriptor, layers: launch.layers, templateVersion: String(launch.templateVersion) },
      origin: { kind: "service-catalog", senderWebContentsId: 7 } });
    return result.payload;
  };
  const bind = (subdir: string, tag: string, healthCheck?: ServiceDescriptor["healthCheck"]) => {
    const template = catalog.saveTemplate({ projectId, environmentId, descriptor: { name: `API ${tag}`, program: "node", args: ["service.cjs"], ports: [], runType: "long-lived",
      ...(healthCheck === undefined ? {} : { healthCheck }) },
      shared: [{ key: "SERVICE_GREETING", value: `hello-${tag}`, secret: false }, { key: "SERVICE_TAG", value: tag, secret: false }] });
    catalog.bindTask({ taskId, serviceId: template.serviceId, environmentId, templateVersion: 1, rootId: "repo-a", subdir,
      programPath: realpathSync(process.execPath), privateRefs: [{ key: "SERVICE_TOKEN", envRef: "LOCAL_TEST_TOKEN" }] });
    return template.serviceId;
  };
  const run = (serviceId: string, action: "start" | "stop") =>
    runTaskService(registry, catalog, { taskId, projectId, serviceId, action }, 7);
  const status = async (serviceId: string) => {
    const payload = await request("task/serviceStatus", { serviceId });
    return (payload["service"] ?? payload) as Record<string, unknown>;
  };
  const log = async (serviceId: string) => {
    const payload = await request("task/serviceLog", { serviceId, limit: 200 });
    return Array.isArray(payload["log"]) ? (payload["log"] as { line: string }[]).map((entry) => entry.line) : [];
  };
  return { profile, taskId, taskDir, hostTaskDir, projectId, environmentId, catalog, authority, child, parent, client, main, registry,
    task, request, bind, register, run, status, log };
}

/** A symlinked ancestor of the tasks root: same folders, different path text. */
function linkedHome(home: string): string {
  const link = join(home, "linked-home");
  symlinkSync(home, link);
  return link;
}

/**
 * The fixture's OWN git calls, on a TEMP repository only: hermetic (no system or
 * global config, no prompts, no inherited identity) and never run in the PiDock
 * checkout. Main's own reads are the code under test, not these.
 */
function fixtureGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "pidock-test", GIT_AUTHOR_EMAIL: "pidock@test.invalid",
      GIT_COMMITTER_NAME: "pidock-test", GIT_COMMITTER_EMAIL: "pidock@test.invalid" },
  }).trim();
}

/** A child pid the fixture script reported; used to observe the real OS process. */
function reportedPid(lines: string[]): number {
  const line = lines.find((entry) => entry.startsWith("pid:"));
  if (!line) throw Error("no pid line in the service log");
  return Number(line.slice(4));
}
/**
 * A pid that is not a usable positive integer cannot be probed with
 * `process.kill`: `kill(0, 0)` signals this process's whole process group and
 * always succeeds, so a `0` read would look like a permanently live process
 * and hang the test to its timeout. Failing loudly with the raw marker text
 * keeps any future recurrence self-diagnosing instead of surfacing as a
 * timeout.
 */
class InvalidPidError extends Error {
  constructor(readonly raw: string, readonly source: string) {
    super(`invalid-pid: ${source} yielded ${JSON.stringify(raw)}`);
    this.name = "InvalidPidError";
  }
}
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) throw new InvalidPidError(String(pid), "alive(pid)");
  try { process.kill(pid, 0); return true; } catch { return false; }
}
/** Raw text the fixture child wrote to its marker file, or undefined before it exists. */
function rawMarkerPid(taskDir: string, tag: string): string | undefined {
  try { return readFileSync(join(taskDir, `repo-a/svc-${tag}`, `started-${tag}.txt`), "utf8"); }
  catch { return undefined; }
}
/**
 * The fixture child writes its own pid with a single `writeFileSync`, which
 * creates the file before its bytes land. Wait until the file holds a complete
 * positive integer (a different one from `exclude`, when given) rather than
 * reading the brief empty/partial window that parses to `0`. Fails loudly with
 * the raw content if it never yields a usable pid within the budget - never
 * silently passes or skips.
 */
async function untilMarkerPid(taskDir: string, tag: string, exclude?: number): Promise<number> {
  for (let elapsed = 0; elapsed < STOP_WAIT_MS; elapsed += POLL_INTERVAL_MS) {
    const raw = rawMarkerPid(taskDir, tag);
    const pid = raw === undefined ? NaN : Number(raw);
    if (Number.isInteger(pid) && pid > 0 && pid !== exclude) return pid;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new InvalidPidError(rawMarkerPid(taskDir, tag) ?? "<missing>", `started-${tag}.txt`);
}

describe.skipIf(process.platform === "win32")("#7 catalog-driven service execution with real child processes", () => {
  it("starts one service, reports its real state, returns its bounded redacted log, and stops only its own tree", async () => {
    const f = await installed();
    const first = f.bind("svc-a", "a");
    const second = f.bind("svc-b", "b");
    vi.stubEnv("PIDOCK_TEST_AMBIENT", "must-not-reach-a-service");

    expect(await f.run(first, "start")).toMatchObject({ serviceId: first, action: "start", actor: "human" });
    expect(await f.run(second, "start")).toMatchObject({ serviceId: second, action: "start", actor: "human" });

    // (a) real process state, reported by the Host from the real children.
    // The bound template declares no 健康检查, so the health half of the row is
    // `未声明` by name - never a pass, and never a probe of an invented target.
    expect(await f.status(first)).toMatchObject({ serviceId: first, lifecycle: "running", launchSource: "catalog", health: "undeclared" });
    expect(await f.status(second)).toMatchObject({ lifecycle: "running" });

    // (b) real, bounded, redacted output of the running children.
    await until(() => existsSync(join(f.taskDir, "repo-a/svc-a", "started-a.txt")), "first service to start");
    await until(() => existsSync(join(f.taskDir, "repo-a/svc-b", "started-b.txt")), "second service to start");
    // Wait for the evidence this block actually asserts, not a proxy for it: a
    // bare `entries.length >= 6` can be satisfied while the lines asserted below
    // have not arrived in the captured log yet (load-dependent, and the added
    // real-process suites in this repo make that likely).
    await untilLog(() => f.log(first), first, (entries) => entries.length >= 6
      && entries.includes("ambient:absent")
      && entries.includes("ready:hello-a:a")
      && entries.includes("token:••••••••")
      && entries.includes("[output line exceeded 2000 characters]"));
    const firstLines = await f.log(first);
    expect(firstLines).toContain("ready:hello-a:a");
    expect(firstLines).toContain("token:••••••••");
    expect(firstLines.join("\n")).not.toContain("synthetic-private-value");
    expect(firstLines).toContain("[output line exceeded 2000 characters]");
    expect(firstLines.every((line) => line.length <= 2000)).toBe(true);
    // Each child got only its own planned env: an ambient Host variable stays out.
    expect(firstLines).toContain("ambient:absent");
    const firstPid = reportedPid(firstLines);
    expect(alive(firstPid)).toBe(true);
    // The two services resolved their own layers into independent env objects.
    await untilLog(() => f.log(second), second, (entries) => entries.some((line) => line.startsWith("pid:"))
      && entries.includes("ambient:absent")
      && entries.includes("ready:hello-b:b"));
    const secondLines = await f.log(second);
    expect(secondLines).toContain("ready:hello-b:b");
    expect(secondLines).toContain("ambient:absent");
    const secondPid = reportedPid(secondLines);
    expect(secondPid).not.toBe(firstPid);

    // (c) stop terminates only the asked-for service's registered child.
    expect(await f.run(first, "stop")).toMatchObject({ serviceId: first, action: "stop", actor: "human" });
    await until(() => !alive(firstPid), "first service to exit");
    expect(alive(secondPid)).toBe(true);
    expect((await f.status(first)).lifecycle).toBe("stopped");
    expect((await f.status(second)).lifecycle).toBe("running");
    expect((await f.log(first)).some((line) => line.startsWith("process exited: signal:"))).toBe(true);

    // Quitting the Host stops the remaining real child before reporting success.
    const quit = await f.task("task/quit");
    expect(quit.payload["serviceProcesses"]).toEqual([{ serviceId: second, state: "stopped" }]);
    await until(() => !alive(secondPid), "second service to exit on quit");
    const report = await f.registry.quitAll({ origin: { kind: "shell-ui", senderWebContentsId: 7 } });
    expect(report).toMatchObject({ ok: true, tasks: [{ taskId: f.taskId, failures: [], retainedTasks: [] }] });
  }, 30_000);

  it("probes the pinned revision's declared 健康检查 for real, and a failed probe never reads as a dead process", async () => {
    const f = await installed();
    const listener = await httpHealthListener();
    const target = `http://127.0.0.1:${String(listener.port)}/health`;
    const serviceId = f.bind("svc-a", "a", { kind: "http", target });

    // (1) 未探测 for a STOPPED service: the declared target is a live socket, and
    // it is never dialled because the process is not running.
    await f.register(serviceId);
    const stopped = await f.status(serviceId);
    expect(stopped).toMatchObject({ lifecycle: "stopped", health: "not-probed", healthDetail: { kind: "http", target } });
    expect((stopped["healthDetail"] as { reason: string }).reason).toContain("服务未运行");
    expect(listener.connections).toBe(0);

    // (2) A REAL pass: a real HTTP listener declared by the pinned revision, a
    // real child, and the listener's real status code in the read.
    expect(await f.run(serviceId, "start")).toMatchObject({ serviceId, action: "start", actor: "human" });
    const pid = await untilMarkerPid(f.taskDir, "a");
    expect(alive(pid)).toBe(true);
    const healthy = await f.status(serviceId);
    expect(healthy).toMatchObject({ lifecycle: "running", health: "healthy", healthDetail: { kind: "http", target, statusCode: 200 } });
    const runningStartedAt = healthy["startedAt"];
    expect(listener.connections).toBeGreaterThanOrEqual(1);

    // (3) The declared target closes while the REAL child keeps running: the
    // probe fails by name and `lifecycle`/`startedAt`/`exitReason` do not move.
    await listener.close();
    const unhealthy = await f.status(serviceId);
    expect(unhealthy).toMatchObject({ lifecycle: "running", health: "unhealthy", healthDetail: { kind: "http", reason: "连接被拒" } });
    expect(unhealthy["startedAt"]).toBe(runningStartedAt);
    expect(unhealthy["exitReason"]).toBeUndefined();
    expect(alive(pid)).toBe(true);
    // (4) Nothing was started, stopped or restarted by the probe: the same real
    // child is still the one of this service.
    expect(await untilMarkerPid(f.taskDir, "a")).toBe(pid);
    expect((await f.status(serviceId)).lifecycle).toBe("running");

    // (5) A stopped service goes back to a named 未探测 without dialling.
    expect(await f.run(serviceId, "stop")).toMatchObject({ serviceId, action: "stop", actor: "human" });
    await until(() => !alive(pid), "the service child to exit");
    expect(await f.status(serviceId)).toMatchObject({ lifecycle: "stopped", health: "not-probed", healthDetail: { reason: "服务未运行，不发起探测" } });
  }, 30_000);

  it("records the durable launch identity of a real Host start and refuses a duplicate start beside that survivor", async () => {
    const f = await installed();
    const serviceId = f.bind("svc-a", "a");
    const ownershipFile = join(f.taskDir, "service-ownership.json");
    expect(existsSync(ownershipFile)).toBe(false);

    expect(await f.run(serviceId, "start")).toMatchObject({ serviceId, action: "start", actor: "human" });
    const pid = await untilMarkerPid(f.taskDir, "a");
    expect(alive(pid)).toBe(true);

    // The production Host driver persisted this launch's identity before the
    // start resolved, and the recorded nonce really is the child's own marker
    // (read back from the OS), not a pid guess.
    const [entry] = readServiceOwnershipOnDisk(f.taskDir).entries;
    expect(entry).toMatchObject({ taskId: f.taskId, serviceId, pid });
    expect(entry!.ownershipNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(verifyServiceOwnershipIdentity(entry!)).toBe("verified");

    // A second Host reconciling the same task folder holds no child handle for
    // this launch, so the durable record is its only evidence - and the same
    // production factory the Host uses (`diskServiceOwnershipLog`) refuses to
    // spawn a second instance beside the survivor instead of adopting or
    // overwriting it. (The Host-independent driver contract this exercises is
    // covered in `service-ownership.test.ts`; what this leg adds is that the
    // record it reconciles was written through the real Host path above.)
    const follower = new TaskServiceProcesses(f.taskDir, () => {}, () => {}, (line) => line,
      SERVICE_STOP_GRACE_MS, SERVICE_STOP_CONFIRM_MS, diskServiceOwnershipLog({ taskId: f.taskId, taskDir: f.taskDir }));
    expect(follower.ids()).toEqual([]);
    await expect(follower.start({ serviceId, cwd: join(f.taskDir, "repo-a/svc-a"), program: realpathSync(process.execPath),
      args: ["service.cjs"], env: {}, runType: "long-lived" })).rejects.toThrow("service-ownership-own-verified");
    expect(alive(pid)).toBe(true);

    // A verified record may be reclaimed: the survivor really dies and only
    // then does the record go.
    await follower.stop(serviceId);
    await until(() => !alive(pid), "the recorded launch to stop");
    expect(readServiceOwnershipOnDisk(f.taskDir).entries).toEqual([]);
  }, 30_000);

  it("refuses a read-only session, asks first on the default tier, and starts nothing on refusal or rejection", async () => {
    const f = await installed();
    const serviceId = f.bind("svc-a", "a");
    const startedMarker = join(f.taskDir, "repo-a/svc-a", "started-a.txt");
    // A refused or unanswered control must leave no durable launch identity
    // behind either. These absences are meaningful - they can fail: the
    // sibling test above proves a start that really ran does write the record
    // through this same production path.
    const ownershipRecord = join(f.taskDir, "service-ownership.json");
    // Main registers the trusted launch for the task-bound service; the page
    // never supplies the descriptor (it only names project/task/service).
    expect(await f.register(serviceId)).toMatchObject({ service: { launchSource: "catalog" } });
    const control = (payload: Record<string, unknown>) => f.request("task/controlService", { serviceId, ...payload });
    await f.task("task/setPermission", { sessionId: "main", permission: "read" });

    // Read-only tier: refused, and no child ever ran.
    expect(await control({ sessionId: "main", action: "start" })).toMatchObject({ error: expect.stringContaining("只读") });
    expect(existsSync(startedMarker)).toBe(false);
    expect(existsSync(ownershipRecord)).toBe(false);
    expect((await f.status(serviceId)).lifecycle).toBe("stopped");

    // Default tier: the first call only asks.
    await f.task("task/setPermission", { sessionId: "main", permission: "default" });
    const asked = await control({ sessionId: "main", action: "start" });
    const approvalId = String(asked["error"]).replace("approval-required: ", "");
    expect(approvalId).toMatch(/^approval-\d+$/);
    expect(existsSync(startedMarker)).toBe(false);
    expect((await f.status(serviceId)).lifecycle).toBe("stopped");

    // A pending (unanswered/cancelled) confirmation starts nothing either: the
    // approval exists but was never approved, so the Host refuses before the
    // driver is reached.
    expect((await control({ sessionId: "main", action: "start", approvalId }))["error"]).toBeDefined();
    expect(existsSync(startedMarker)).toBe(false);
    expect(existsSync(ownershipRecord)).toBe(false);
    expect((await f.status(serviceId)).lifecycle).toBe("stopped");

    // A rejected confirmation does not start the process either.
    await f.task("task/reject", { sessionId: "main", approvalId });
    expect((await control({ sessionId: "main", action: "start", approvalId }))["error"]).toBeDefined();
    expect(existsSync(startedMarker)).toBe(false);
    expect(existsSync(ownershipRecord)).toBe(false);
    expect((await f.status(serviceId)).lifecycle).toBe("stopped");

    // A fresh confirmation, approved, really starts the child.
    const askedAgain = await control({ sessionId: "main", action: "start" });
    const secondId = String(askedAgain["error"]).replace("approval-required: ", "");
    await f.task("task/approve", { sessionId: "main", approvalId: secondId });
    const acted = await control({ sessionId: "main", action: "start", approvalId: secondId });
    expect(acted).toMatchObject({ serviceId, action: "start", actor: "agent", tier: "default" });
    await until(() => existsSync(startedMarker), "the approved start to run the child");
    expect((await f.status(serviceId)).lifecycle).toBe("running");
    // The approval is spent: the same id cannot start or stop again.
    expect((await control({ sessionId: "main", action: "stop", approvalId: secondId }))["error"]).toBeDefined();
    expect((await f.status(serviceId)).lifecycle).toBe("running");
  }, 30_000);

  it("keeps the trusted catalog launch when the page re-registers the same id, and never executes a page descriptor", async () => {
    const f = await installed();
    const serviceId = f.bind("svc-a", "a");
    await f.run(serviceId, "start");
    await until(() => existsSync(join(f.taskDir, "repo-a/svc-a", "started-a.txt")), "the service to start");

    // Same id, hostile descriptor, attested shell-UI origin: the trusted
    // catalog registration wins and keeps executing.
    const conflict = await f.request("task/registerService", {
      serviceId,
      descriptor: { name: "hostile", program: "/bin/sh", args: ["-c", "echo pwned"], cwd: join(f.taskDir, "repo-a/svc-a"), ports: [], runType: "one-shot" },
      layers: { repoDefaults: [], shared: [], privateEntries: [], task: [] },
      templateVersion: "v99",
    });
    expect(conflict["error"]).toContain("service-registration-conflict");
    expect(await f.status(serviceId)).toMatchObject({ lifecycle: "running", launchSource: "catalog" });

    // A page-only registration of a fresh id is accepted as display data, and
    // its control stays fail-closed: no page-supplied program is started.
    const pageOnly = await f.request("task/registerService", {
      serviceId: "s-page-only",
      descriptor: { name: "page", program: realpathSync(process.execPath), args: ["-e", "require('node:fs').writeFileSync('pwned.txt','x')"],
        cwd: join(f.taskDir, "repo-a/svc-a"), ports: [], runType: "one-shot" },
      layers: { repoDefaults: [], shared: [], privateEntries: [], task: [] },
      templateVersion: "v1",
    });
    expect(pageOnly).toMatchObject({ service: { serviceId: "s-page-only", launchSource: "ui" } });
    const refusal = (await f.request("task/controlService", { serviceId: "s-page-only", action: "start" }))["error"];
    expect(refusal).toContain("service-execution-unavailable");
    expect(refusal).toBe("service-execution-unavailable: 仅可信服务目录登记的服务可执行；该服务由界面登记。请改用可信服务目录登记的服务");
    expect(existsSync(join(f.taskDir, "repo-a/svc-a", "pwned.txt"))).toBe(false);
  }, 30_000);

  it("stops, restarts and quits a child when the Host task path is not canonical", async () => {
    // `TaskServiceProcesses` stores the task root's realpath while the Host is
    // bound to a raw `PIDOCK_TASK_DIR`; comparing the two would rebuild the
    // driver on every control and drop the running-child map (a stop would
    // answer `not-running`, a second start would spawn a duplicate, and quit
    // would report a clean stop behind live children).
    const f = await installed({ nonCanonicalTaskDir: true });
    const serviceId = f.bind("svc-a", "a");
    expect(f.hostTaskDir).not.toBe(f.taskDir);

    expect(await f.run(serviceId, "start")).toMatchObject({ serviceId, action: "start", actor: "human" });
    const firstPid = await untilMarkerPid(f.taskDir, "a");
    expect(alive(firstPid)).toBe(true);

    // The stop must reach the child the *same* driver registered.
    expect(await f.run(serviceId, "stop")).toMatchObject({ serviceId, action: "stop", actor: "human" });
    await until(() => !alive(firstPid), "the child to exit on stop");
    expect((await f.status(serviceId)).lifecycle).toBe("stopped");

    // A restart runs a new child: the first one is gone and a different pid
    // is now live (the driver kept its map, so it did not spawn alongside it).
    expect(await f.run(serviceId, "start")).toMatchObject({ serviceId, action: "start" });
    const secondPid = await untilMarkerPid(f.taskDir, "a", firstPid);
    expect(alive(secondPid)).toBe(true);

    // Quit stops the remaining real child before reporting success.
    const quit = await f.task("task/quit");
    expect(quit.payload["serviceProcesses"]).toEqual([{ serviceId, state: "stopped" }]);
    await until(() => !alive(secondPid), "the child to exit on quit");
  }, 30_000);

  it("[#117 第 4 项] archiving stops the Agent turn only; a running service child keeps running", async () => {
    const f = await installed();
    const serviceId = f.bind("svc-a", "a");
    expect(await f.run(serviceId, "start")).toMatchObject({ action: "start" });
    const pid = await untilMarkerPid(f.taskDir, "a");

    const archived = await f.task("task/archive", {});
    expect(archived.payload["lifecycle"]).toMatchObject({ archived: true });
    // The archive plan only knows Agent and save phases: no phase stops a child.
    const plan = archived.payload["plan"] as { steps: { phase: string; detail: string }[] };
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.steps.every((step) => ["abort-agent", "save-state"].includes(step.phase))).toBe(true);
    expect(plan.steps.map((step) => step.phase)).toContain("save-state");
    // ...and its own text promises the code/session state is kept.
    expect(plan.steps.some((step) => step.detail.includes("保留代码"))).toBe(true);

    // Give a "stop the services anyway" regression the time to show up.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alive(pid)).toBe(true);
    expect((await f.status(serviceId)).lifecycle).toBe("running");
    // Quit (test cleanup) is the op that stops the child, not the archive.
    await f.task("task/quit");
    await until(() => !alive(pid), "the service child to be stopped by quit, not by archive");
  }, 30_000);

  it("[#117 第 3 项] aborts the Agent BEFORE stopping service children, and stops them before the SDK host", async () => {
    const f = await installed();
    const serviceId = f.bind("svc-a", "a");
    expect(await f.run(serviceId, "start")).toMatchObject({ action: "start" });
    const pid = await untilMarkerPid(f.taskDir, "a");
    expect(alive(pid)).toBe(true);
    // An SDK read is what constructs the turn transport this quit has to abort.
    await f.task("task/sdkProjection", { sessionId: "main" });

    const { SdkTurnTransport } = await import("./sdk-turn-transport.js");
    const { TaskWorkspaceHost } = await import("./task-host.js");
    const order: string[] = [];
    vi.spyOn(SdkTurnTransport.prototype, "abortAll").mockImplementation(async () => {
      // Agent first: the service child is still alive when the turn is aborted.
      order.push(`abort:child-alive=${String(alive(pid))}`);
      return ["turn-aborted-1"];
    });
    vi.spyOn(TaskWorkspaceHost.prototype, "shutdownSdk").mockImplementation(async () => {
      // SDK last: the child is gone by the time the SDK host is shut down.
      order.push(`sdk:child-alive=${String(alive(pid))}`);
    });

    const quit = await f.task("task/quit");
    expect(order).toEqual(["abort:child-alive=true", "sdk:child-alive=false"]);
    // The aborted turn is reported as a fact, not swallowed.
    expect(quit.payload["abortedTurns"]).toEqual(["turn-aborted-1"]);
    await until(() => !alive(pid), "the service child to be stopped by quit");
  }, 30_000);

  it("[#117 第 3 项] still stops every child when the Agent abort itself fails, and reports it", async () => {
    const f = await installed();
    const serviceId = f.bind("svc-a", "a");
    expect(await f.run(serviceId, "start")).toMatchObject({ action: "start" });
    const pid = await untilMarkerPid(f.taskDir, "a");
    await f.task("task/sdkProjection", { sessionId: "main" });

    const { SdkTurnTransport } = await import("./sdk-turn-transport.js");
    vi.spyOn(SdkTurnTransport.prototype, "abortAll").mockRejectedValue(new Error("sdk-turns-abort-unconfirmed"));
    const quit = await f.request("task/quit");
    // The failed abort still fails the quit...
    expect(quit["error"]).toContain("sdk-turns-abort-unconfirmed");
    // ...but never leaves a detached child unstoppable behind it.
    await until(() => !alive(pid), "the service child to be stopped despite the failed abort");
  }, 30_000);

  it("stops real child processes even when the Agent/SDK shutdown stage fails", async () => {
    const f = await installed();
    const serviceId = f.bind("svc-a", "a");
    expect(await f.run(serviceId, "start")).toMatchObject({ action: "start" });
    const pid = await untilMarkerPid(f.taskDir, "a");
    expect(alive(pid)).toBe(true);

    // A real SDK shutdown failure must not leave a detached child unstoppable:
    // service termination cannot sit behind the Agent stages of the quit chain.
    const { TaskWorkspaceHost } = await import("./task-host.js");
    vi.spyOn(TaskWorkspaceHost.prototype, "shutdownSdk").mockRejectedValue(new Error("sdk-host-shutdown-unconfirmed"));
    const quit = await f.request("task/quit");
    expect(quit["error"]).toContain("sdk-host-shutdown-unconfirmed");
    await until(() => !alive(pid), "the service child to be stopped despite the SDK failure");
  }, 30_000);
});

/**
 * Refusal legs that must hold on every platform: none of them spawns a child,
 * so only the legs with a real service process are `win32`-skipped above.
 */
describe("#7 catalog-driven service execution refusals", () => {
  it("keeps service control fail-closed when the catalog launch cannot be resolved", async () => {
    const f = await installed();
    const serviceId = f.bind("svc-a", "a");
    // Remove the bound program: the trusted launch no longer resolves, so main
    // refuses before any registration or control reaches the Host.
    const machine = join(f.profile, "service-machine.json");
    const document = JSON.parse(readFileSync(machine, "utf8")) as { bindings: { programPath: string }[] };
    document.bindings[0]!.programPath = join(f.taskDir, "repo-a", "missing-program");
    writeFileSync(machine, JSON.stringify(document));
    await expect(f.run(serviceId, "start")).rejects.toThrow("service-launch-unavailable");
    expect((await f.status(serviceId)).error).toBeDefined();
    expect(existsSync(join(f.taskDir, "repo-a/svc-a", "started-a.txt"))).toBe(false);
  }, 30_000);

  it("refuses a catalog start when main never confirmed the durable owner inventory", async () => {
    // Main fences the Host on any catalog/store/lease failure and swallows it
    // while still routing `runTaskService`; a missing durable inventory is an
    // unconfirmed owner state, never permission to spawn.
    const f = await installed({ ownerAuthorityUnavailable: true });
    const serviceId = f.bind("svc-a", "a");
    expect(await f.register(serviceId)).toMatchObject({ service: { launchSource: "catalog" } });
    expect((await f.request("task/controlService", { serviceId, action: "start" }))["error"])
      .toContain("service-execution-uncertain");
    expect(existsSync(join(f.taskDir, "repo-a/svc-a", "started-a.txt"))).toBe(false);
  }, 30_000);

  it("refuses a catalog start after the durable owner inventory is fenced", async () => {
    const f = await installed();
    const serviceId = f.bind("svc-a", "a");
    expect(await f.register(serviceId)).toMatchObject({ service: { launchSource: "catalog" } });
    // Main's fence message is the same one a failed owner lease sends.
    f.child.postMessage({ kind: "service-owner-fenced", workspaceId: "workspace-a", taskId: f.taskId });
    expect((await f.request("task/controlService", { serviceId, action: "start" }))["error"])
      .toContain("service-execution-uncertain");
    expect((await f.status(serviceId))["error"]).toContain("service-execution-uncertain");
    expect(existsSync(join(f.taskDir, "repo-a/svc-a", "started-a.txt"))).toBe(false);
  }, 30_000);
});

/**
 * [PiDock 05] (#10 box 6) main's REAL worktree read, end to end on the shipped
 * `runTaskService` route: `shell/serviceCatalogOp {op:"runTaskService"}` → main
 * resolves the launch and reads the worktree its verified cwd lives in → the
 * registration carries that read to the Host → the Host writes it on the run
 * record a real start produced.
 *
 * The child processes are REAL (the same driver as the suite above); the task
 * folder is either a REAL temporary git worktree (one commit) or a plain
 * directory, which is exactly the difference the box is about.
 */
describe.skipIf(process.platform === "win32")("#10 box 6 the run record carries the code state main really read", () => {
  type WiringFixture = Awaited<ReturnType<typeof installed>>;

  /** The newest run record this task's Host wrote for one service. */
  async function latestRun(f: WiringFixture, serviceId: string): Promise<Record<string, unknown>> {
    const payload = await f.request("task/serviceRunRecords", {});
    const records = (payload["records"] ?? []) as Record<string, unknown>[];
    const mine = records.filter((record) => record["serviceId"] === serviceId);
    expect(mine.length).toBeGreaterThan(0);
    return mine[mine.length - 1] as Record<string, unknown>;
  }

  it("records the launch worktree's REAL clean commit, then the real uncommitted state of a later start", { timeout: 60_000 }, async () => {
    const f = await installed({ gitWorktree: true });
    const serviceId = f.bind("svc-a", "a");
    const head = fixtureGit(f.taskDir, ["rev-parse", "HEAD"]);

    expect(await f.run(serviceId, "start")).toMatchObject({ serviceId, action: "start", actor: "human" });
    const firstPid = await untilMarkerPid(f.taskDir, "a");
    expect(alive(firstPid)).toBe(true);

    // THE assertion the box needs: a real run record names the real commit,
    // read by main from the worktree the launch's own cwd lives in.
    const clean = await latestRun(f, serviceId);
    expect(clean["codeState"]).toMatchObject({ kind: "committed-clean", commit: head });
    expect((clean["codeState"] as { note?: string }).note).toBe("工作副本与记录提交一致");
    // Nobody observed a build commit (nothing in the model names a build
    // artifact), so this stays 无法判断构建状态 instead of claiming `fresh`.
    expect(clean["buildFreshness"]).toBe("unknown");
    expect(clean["buildFreshness"]).not.toBe("fresh");
    // The read succeeded, so no observation-failure line was logged.
    expect((await f.log(serviceId)).some((line) => line.startsWith("代码状态未观测"))).toBe(false);

    // Stop, edit the worktree, start again: uncommitted code is DISTINGUISHABLE
    // from a clean commit, and never reads as `fresh`.
    expect(await f.run(serviceId, "stop")).toMatchObject({ serviceId, action: "stop" });
    await until(() => !alive(firstPid), "the first child to exit");
    writeFileSync(join(f.taskDir, "repo-a/svc-a", "service.cjs"), `${SERVICE_SCRIPT}\n// edited by the box-6 test\n`);
    expect(await f.run(serviceId, "start")).toMatchObject({ serviceId, action: "start" });
    const secondPid = await untilMarkerPid(f.taskDir, "a", firstPid);
    expect(alive(secondPid)).toBe(true);

    const dirty = await latestRun(f, serviceId);
    expect(dirty["codeState"]).toMatchObject({ kind: "uncommitted", commit: head });
    expect(dirty["buildFreshness"]).toBe("uncommitted-code");
    expect(dirty["runId"]).not.toBe(clean["runId"]);

    expect(await f.run(serviceId, "stop")).toMatchObject({ serviceId, action: "stop" });
    await until(() => !alive(secondPid), "the second child to exit");
  });

  it("leaves the code state unknown BY NAME with the reason in the bounded log when nothing could be read", { timeout: 30_000 }, async () => {
    // A task folder that is not a worktree: the read fails, so the run record
    // must not name a code state and must not read as a clean tree.
    const f = await installed();
    const serviceId = f.bind("svc-a", "a");

    expect(await f.run(serviceId, "start")).toMatchObject({ serviceId, action: "start", actor: "human" });
    const pid = await untilMarkerPid(f.taskDir, "a");
    expect(alive(pid)).toBe(true);

    const run = await latestRun(f, serviceId);
    expect(run["codeState"]).toMatchObject({ kind: "unknown" });
    expect(run["codeState"]).not.toMatchObject({ kind: "committed-clean" });
    expect((run["codeState"] as { commit?: string }).commit).toBeUndefined();
    expect(run["buildFreshness"]).toBe("unknown");

    // The reason is visible where the user reads the run: the service's own
    // bounded log, carrying no machine path and no raw tool output.
    const lines = await f.log(serviceId);
    expect(lines).toContain(`代码状态未观测：该目录不是 Git 工作树；本次运行记录按 unknown 记录`);
    expect(lines.every((line) => line.length <= 2000)).toBe(true);
    expect(lines.join("\n")).not.toContain(f.taskDir);

    expect(await f.run(serviceId, "stop")).toMatchObject({ serviceId, action: "stop" });
    await until(() => !alive(pid), "the child to exit");
  });
});
