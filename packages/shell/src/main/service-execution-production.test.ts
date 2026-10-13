/**
 * [PiDock 04] (#7) the PRODUCTION entry for catalog-driven service execution:
 * the real `shell/serviceCatalogOp {op:"runTaskService"}` handler that
 * `registerIpc` installs, driven with a real task Host and REAL child
 * processes.
 *
 * Why this file exists next to `../host/service-execution-wiring.test.ts`:
 * that suite drives the main-function seam (`runTaskService`) directly. This
 * one goes through the actual IPC handler, so the sender attestation, the
 * live-sender guard, `parseServiceRunRequest`'s shape validation and the
 * `serviceExecutionRefusal` platform gate are all on the path under test.
 *
 * Evidence split (stated, not implied):
 * - REAL subprocess: the services are Node scripts started by
 *   `TaskServiceProcesses` inside the Host, after main resolved the trusted
 *   catalog launch; pid liveness, bounded redacted log lines and the stop
 *   scope are observed on the real children.
 * - REAL production objects: the registered IPC handler itself, the real
 *   `PerTaskHostRegistry`, the real Host (`../host/host.js` with a fake
 *   `process.parentPort` pair), the real `InstalledServiceHostAuthority` and a
 *   real `ServiceCatalog` on a temp profile.
 * - FIXTURE: `electron` is mocked (no Electron runtime in vitest), the
 *   catalog authority is an in-test stub (the real `TaskRootIndex`/
 *   `ProjectRegistry` wiring has its own suites), the trusted sender is a
 *   plain object registered in a real `TrustDomainRegistry`, and the "program
 *   picker" result is `process.execPath`, not a native dialog. No Electron UI,
 *   no packaged build, no Windows run.
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "" },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn(), eventNames: () => [] },
  utilityProcess: { fork: vi.fn() },
  session: { fromPartition: (partition: string) => ({ partition }) },
  WebContentsView: class {},
  BrowserWindow: class {},
}));

import { ipcMain } from "electron";
import { HostClient } from "../rpc/host-client.js";
import { TrustDomainRegistry } from "./trust-domain.js";
import { InstalledServiceHostAuthority } from "./service-host-binding.js";
import { ExperimentalServiceRecoveryStore } from "./service-recovery-store-experiment.js";
import { PerTaskHostRegistry, registerIpc } from "./runtime.js";
import { ServiceCatalog, type ServiceCatalogAuthority } from "./service-catalog.js";
import { diskTaskStore } from "../host/task-host.js";
import { buildTaskDiskRecord } from "../host/task-store.js";

const STOP_WAIT_MS = 30_000;
const POLL_INTERVAL_MS = 25;

async function until(check: () => boolean, label: string) {
  for (let elapsed = 0; elapsed < STOP_WAIT_MS; elapsed += POLL_INTERVAL_MS) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw Error(`timed out waiting for ${label}`);
}

/** A positive pid, or a loud failure - `kill(0, 0)` would always succeed. */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) throw Error(`invalid-pid: ${String(pid)}`);
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Wait until the fixture child wrote a complete positive pid. */
async function untilMarkerPid(taskDir: string, tag: string): Promise<number> {
  for (let elapsed = 0; elapsed < STOP_WAIT_MS; elapsed += POLL_INTERVAL_MS) {
    const raw = (() => { try { return readFileSync(join(taskDir, `repo-a/svc-${tag}`, `started-${tag}.txt`), "utf8"); } catch { return undefined; } })();
    const pid = raw === undefined ? NaN : Number(raw);
    if (Number.isInteger(pid) && pid > 0) return pid;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw Error(`no complete pid marker for svc-${tag}`);
}

/**
 * The two owner messages that carry a scope (and therefore an instance id):
 * the first `service-owner-bootstrap` and, after an in-place replacement,
 * `service-owner-rebind`. Acks and fences carry no scope.
 */
const ownerBindings = (scopes: Record<string, unknown>[]) =>
  scopes.filter((scope) => scope["kind"] === "service-owner-bootstrap" || scope["kind"] === "service-owner-rebind");

const SERVICE_SCRIPT = `const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(process.cwd(), "started-" + process.env.SERVICE_TAG + ".txt"), String(process.pid));
fs.writeFileSync(path.join(process.cwd(), "args-" + process.env.SERVICE_TAG + ".txt"), process.argv.slice(2).join(" "));
console.log("ready:" + process.env.SERVICE_TAG);
console.log("pid:" + process.pid);
console.log("token:" + (process.env.SERVICE_TOKEN ?? "none"));
setInterval(() => {}, 1000);
`;

/**
 * A real child that binds the port its OWN environment declares and writes the
 * pid it really got. The group branch observes 已监听 through a real TCP connect
 * to that registration-declared address, so the fixture has to really listen.
 */
const GROUP_LISTENING_SCRIPT = `const http = require("node:http");
const fs = require("node:fs");
const port = Number(process.env.PORT);
const tag = process.env.SERVICE_TAG;
fs.writeFileSync("started-" + tag + ".txt", String(process.pid));
const server = http.createServer((_request, response) => { response.end(tag); });
server.listen(port, "127.0.0.1", () => {
  fs.writeFileSync("listening.txt", String(process.pid));
  console.log("listening:" + tag);
});
setInterval(() => {}, 1000);
`;

/** One free loopback port for a bound service to declare; closed again at once. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw Error("no ephemeral port");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const cleanups: (() => void | Promise<void>)[] = [];
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(async () => {
  Object.defineProperty(process, "platform", platformDescriptor);
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/**
 * Everything the production handler touches: a temp profile + task, a real
 * catalog, the real Host over a fake utilityProcess pair, the real per-task
 * registry with a real service-owner authority, and the handler that
 * `registerIpc` installs on `shell/serviceCatalogOp`.
 */
async function production(options: { serviceOwnerRequired?: boolean } = {}) {
  vi.resetModules();
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-service-prod-")));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const profile = join(home, "profile");
  const root = join(home, "tasks");
  const taskId = "task-7f3a91bc";
  const taskDir = join(root, taskId);
  const workspaceId = "workspace-a";
  const projectId = randomUUID();
  mkdirSync(profile, { mode: 0o700 });
  for (const dir of ["repo-a/svc-a", "repo-a/svc-b"]) {
    mkdirSync(join(taskDir, dir), { recursive: true });
    writeFileSync(join(taskDir, dir, "service.cjs"), SERVICE_SCRIPT);
  }
  diskTaskStore.writeTask(taskDir, buildTaskDiskRecord({ taskId, name: "Production", dirId: taskId, branch: "task/main", root, taskDir,
    remoteBranch: "main", baseCommit: "source-fixture", repos: ["repo-a"], now: "2026-01-01T00:00:00.000Z" }));
  const taskStat = statSync(taskDir, { bigint: true });
  const identity = { taskId, createdAt: "2026-01-01T00:00:00.000Z", root, realRoot: root, dirId: taskId,
    directoryDevice: taskStat.dev.toString(), directoryInode: taskStat.ino.toString() };
  const owner = (id: string) => id === taskId ? { identity, projectId, rootIds: ["repo-a"] } : null;
  const authority: ServiceCatalogAuthority = {
    projectExists: (id) => id === projectId,
    task: (id) => owner(id),
    verifiedTask: (id) => owner(id),
  };
  const catalog = new ServiceCatalog(profile, authority);
  const environmentId = catalog.createEnvironment({ projectId, name: "开发环境" }).environmentId;

  const child = new EventEmitter() as EventEmitter & { postMessage(value: unknown): void; kill(): void };
  child.kill = vi.fn(() => { child.emit("exit", 0); });
  const parent = new EventEmitter() as EventEmitter & { postMessage(value: unknown): void };
  /** Every main-to-Host owner scope, in order: real evidence that a re-bind is in place. */
  const ownerScopes: Record<string, unknown>[] = [];
  child.postMessage = (value) => { const row = value as Record<string, unknown>;
    if (typeof row.kind === "string" && row.kind.startsWith("service-owner-")) ownerScopes.push(row);
    parent.emit("message", { data: value }); };
  parent.postMessage = (value) => { child.emit("message", value); };
  const oldPort = Object.getOwnPropertyDescriptor(process, "parentPort");
  Object.defineProperty(process, "parentPort", { configurable: true, value: parent });
  cleanups.push(() => { if (oldPort) Object.defineProperty(process, "parentPort", oldPort); else Reflect.deleteProperty(process, "parentPort"); });
  for (const [name, value] of Object.entries({ PIDOCK_WORKSPACE_ID: workspaceId, PIDOCK_TASK_ID: taskId, PIDOCK_TASK_DIR: taskDir,
    PIDOCK_PROTECTED_PROFILE: profile, ...(options.serviceOwnerRequired === false ? {} : { PIDOCK_SERVICE_OWNER_REQUIRED: "1" }) })) vi.stubEnv(name, value);
  vi.stubEnv("LOCAL_TEST_TOKEN", "synthetic-private-value");
  const { startHost } = await import("../host/host.js");
  startHost();
  const client = new HostClient(child as never);
  const main = new InstalledServiceHostAuthority(profile, catalog, authority, workspaceId, { LOCAL_TEST_TOKEN: "synthetic-private-value" });
  const tasks = new PerTaskHostRegistry(workspaceId, async () => ({ client, child: child as never }), () => taskDir, undefined, undefined);
  tasks.configureServices(() => main);
  cleanups.push(async () => { client.dispose(); child.emit("exit", 0); await main.disposeWhenExited().catch(() => {}); });
  cleanups.push(async () => { await tasks.quitAll({ origin: { kind: "shell-ui", senderWebContentsId: 7 } }).catch(() => {}); });

  // Production sender attestation: main registers the actual WebContents id,
  // and the handler resolves the caller through it.
  const senderWebContentsId = 7;
  const trust = new TrustDomainRegistry();
  trust.registerShell({ webContentsId: senderWebContentsId, viewId: "shell-view", workspaceId });
  vi.mocked(ipcMain.handle).mockClear();
  registerIpc({} as never, trust, tasks, undefined, undefined, undefined, undefined, undefined, catalog);
  const handler = vi.mocked(ipcMain.handle).mock.calls.findLast(([channel]) => channel === "shell/serviceCatalogOp")?.[1];
  expect(handler).toBeDefined();
  const shell = {
    sender: {
      id: senderWebContentsId,
      mainFrame: { processId: 1, routingId: 1 },
      getURL: () => "file:///shell/index.html",
      isDestroyed: () => false,
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    senderFrame: { processId: 1, routingId: 1 },
  };

  const bind = (subdir: string, tag: string) => {
    const template = catalog.saveTemplate({ projectId, environmentId, descriptor: { name: `API ${tag}`, program: "node", args: ["service.cjs"], ports: [], runType: "long-lived" },
      shared: [{ key: "SERVICE_TAG", value: tag, secret: false }] });
    catalog.bindTask({ taskId, serviceId: template.serviceId, environmentId, templateVersion: 1, rootId: "repo-a", subdir,
      programPath: realpathSync(process.execPath), privateRefs: [{ key: "SERVICE_TOKEN", envRef: "LOCAL_TEST_TOKEN" }] });
    return template.serviceId;
  };
  /**
   * A new shared revision of one bound template: same program and shared
   * material, one extra pinned argument. This is the write that moves the
   * catalog revision a task's Host booted with.
   */
  const saveRevision = (serviceId: string) => {
    const current = catalog.template(projectId, environmentId, serviceId, 1)!;
    return catalog.saveTemplate({ projectId, environmentId, serviceId, expectedVersion: 1,
      descriptor: { ...current.descriptor, args: ["service.cjs", "v2"] }, shared: current.shared });
  };
  /**
   * One durable owner record written before the task's Host is forked: the
   * store holds an exclusive writer lock once the authority owns it, so this
   * fixture writes the document with a throwaway store and disposes it.
   */
  const seedOwner = (serviceId: string, state: string) => {
    const store = new ExperimentalServiceRecoveryStore(profile, authority, () => [serviceId]);
    let exited = false, exit!: () => void;
    const sender = {};
    store.acquire(taskId, { sender, hasExited: () => exited, subscribeExit: (listener) => { exit = listener; return () => {}; } })
      .port(sender, serviceId).write({ schemaVersion: 1, taskId, serviceId, state, ownerSessionId: "previous-owner" });
    exited = true; exit(); store.dispose();
  };
  const op = (payload: Record<string, unknown>, sender: unknown = shell) => handler!(sender as never, payload);
  /** The production renderer request: only project/task/service/action. */
  const run = (serviceId: string, action: "start" | "stop", sender: unknown = shell) =>
    handler!(sender as never, { op: "runTaskService", projectId, taskId, serviceId, action });
  const read = async (op: "task/serviceStatus" | "task/serviceLog", payload: Record<string, unknown>) => {
    try {
      return (await tasks.routeTaskOp({ taskId, op, payload, origin: { kind: "shell-ui", senderWebContentsId } })).payload as Record<string, unknown>;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
  const status = async (serviceId: string) => {
    const payload = await read("task/serviceStatus", { serviceId });
    return (payload["service"] ?? payload) as Record<string, unknown>;
  };
  const log = async (serviceId: string) => {
    const payload = await read("task/serviceLog", { serviceId, limit: 200 });
    return Array.isArray(payload["log"]) ? (payload["log"] as { line: string }[]).map((entry) => entry.line) : [];
  };
  return { taskId, taskDir, projectId, environmentId, catalog, tasks, client, main, handler: handler!, shell, trust, run, read, status, log, bind, saveRevision, seedOwner, op, ownerScopes,
    adopt: (serviceId: string, templateVersion: number, confirm: boolean) => op({ op: "adoptBinding", projectId, taskId, serviceId, templateVersion, confirm }),
    rebind: (confirm: boolean) => op({ op: "rebindServiceOwner", projectId, taskId, confirm }),
    marker: (tag: string) => join(taskDir, `repo-a/svc-${tag}`, `started-${tag}.txt`),
    markerArgs: (tag: string) => join(taskDir, `repo-a/svc-${tag}`, `args-${tag}.txt`) };
}

describe.skipIf(process.platform === "win32")("#7 production shell/serviceCatalogOp service run", () => {
  it("starts, reports, logs and stops a real bound service through the registered IPC handler", async () => {
    const f = await production();
    const first = f.bind("svc-a", "a");
    const second = f.bind("svc-b", "b");

    // The renderer names only project/task/service: main resolves the trusted
    // launch, registers it on the Host and controls it.
    expect(await f.run(first, "start")).toMatchObject({ ok: true, payload: { serviceId: first, action: "start", actor: "human" } });
    expect(await f.run(second, "start")).toMatchObject({ ok: true, payload: { serviceId: second, action: "start", actor: "human" } });

    const firstPid = await untilMarkerPid(f.taskDir, "a");
    const secondPid = await untilMarkerPid(f.taskDir, "b");
    expect(alive(firstPid)).toBe(true);
    expect(alive(secondPid)).toBe(true);
    expect(firstPid).not.toBe(secondPid);

    // Real process liveness, not a dependency-reachability probe: the bound
    // template declares no 健康检查, so the row says `未声明` by name while
    // `lifecycle` follows the real child.
    expect(await f.status(first)).toMatchObject({ serviceId: first, lifecycle: "running", launchSource: "catalog", health: "undeclared" });
    expect(await f.status(second)).toMatchObject({ lifecycle: "running" });

    // Real, bounded, redacted output captured from the running child.
    let lines: string[] = [];
    for (let elapsed = 0; elapsed < STOP_WAIT_MS && !lines.some((line) => line.startsWith("pid:")); elapsed += POLL_INTERVAL_MS) {
      lines = await f.log(first);
      if (!lines.some((line) => line.startsWith("pid:"))) await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    lines = await f.log(first);
    expect(lines).toContain("ready:a");
    expect(lines).toContain("token:••••••••");
    expect(lines.join("\n")).not.toContain("synthetic-private-value");

    // The stop reaches exactly the asked-for service's registered tree.
    expect(await f.run(first, "stop")).toMatchObject({ ok: true, payload: { serviceId: first, action: "stop" } });
    await until(() => !alive(firstPid), "the first service child to exit");
    expect(alive(secondPid)).toBe(true);
    expect((await f.status(first)).lifecycle).toBe("stopped");
    expect((await f.status(second)).lifecycle).toBe("running");
  }, 30_000);

  it("keeps the sender attestation and payload shape guards on the authorized path", async () => {
    const f = await production();
    const serviceId = f.bind("svc-a", "a");

    // An unknown WebContents id never reaches the launch: the trust registry
    // is what main registers, not something a caller can claim.
    const unknown = await f.run(serviceId, "start", { ...f.shell, sender: { ...f.shell.sender, id: 99 } });
    expect(unknown).toMatchObject({ ok: false, error: expect.stringContaining("unknown-sender") });
    // A page-supplied program/cwd/env value, or a session/approval id that
    // would masquerade as the Agent gate path, is a payload violation: the
    // page names only project/task/service/action.
    for (const extra of [{ program: "/bin/sh" }, { cwd: f.taskDir }, { env: { TOKEN: "x" } }, { sessionId: "main" }, { approvalId: "approval-1" }, { label: "用户点击" }]) {
      const rejected = await f.handler(f.shell, { op: "runTaskService", projectId: f.projectId, taskId: f.taskId, serviceId, action: "start", ...extra });
      expect(rejected).toMatchObject({ ok: false, error: expect.stringContaining("invalid-payload") });
    }
    // A sender that is registered but calling from another frame than the shell
    // main frame never reaches a launch or a re-bind: the frame check is the real
    // sending frame, not one main synthesized for the inner guard.
    const subFrame = { ...f.shell, senderFrame: { processId: 2, routingId: 2 } };
    expect(await f.run(serviceId, "start", subFrame)).toMatchObject({ ok: false, error: expect.stringContaining("non-main-frame") });
    expect(await f.handler(subFrame, { op: "rebindServiceOwner", projectId: f.projectId, taskId: f.taskId, confirm: true }))
      .toMatchObject({ ok: false, error: expect.stringContaining("non-main-frame") });
    expect(existsSync(f.marker("a"))).toBe(false);
    expect(f.tasks.size).toBe(0);
  }, 30_000);

  it("re-binds a fenced task in place, then runs the real child of the new revision through the same Host", async () => {
    const f = await production();
    const serviceId = f.bind("svc-a", "a");
    expect(await f.run(serviceId, "start")).toMatchObject({ ok: true, payload: { serviceId, action: "start" } });
    const before = await untilMarkerPid(f.taskDir, "a");
    expect(alive(before)).toBe(true);
    // The hosted child's real argv, so the next start can prove the revision it runs.
    // The fixture writes `started-*.txt` first and `args-*.txt` second, so the pid
    // marker alone does not imply the argv marker landed: wait on the argv value the
    // assertion is about (revision 1 is launched with no extra args).
    await until(() => { try { return readFileSync(f.markerArgs("a"), "utf8") === ""; } catch { return false; } }, "the revision-1 argv marker");
    expect(readFileSync(f.markerArgs("a"), "utf8")).toBe("");
    expect(ownerBindings(f.ownerScopes)).toHaveLength(1);

    // The write this slice is about: a new shared revision plus the confirmed
    // adoption that re-pins the task to it. Saving config is not starting or
    // restarting a process, and the answer names the task it revoked.
    expect(f.saveRevision(serviceId).version).toBe(2);
    expect(await f.adopt(serviceId, 2, true)).toMatchObject({ ok: true, payload: { taskId: f.taskId, from: 1, to: 2,
      restart: { changed: true, processRestarted: false, fencedTaskIds: [f.taskId] } } });

    // The dead end, observed through the production handler: the task's Host
    // refuses start/stop with the named owner fence, while the already running
    // child keeps running.
    expect(await f.run(serviceId, "stop")).toMatchObject({ ok: false, error: expect.stringContaining("service-owner-inventory-unconfirmed") });
    expect(alive(before)).toBe(true);

    // The way back is two-step, and the unconfirmed request replaced nothing.
    expect(await f.rebind(false)).toMatchObject({ ok: true, payload: { taskId: f.taskId, state: "fenced", confirmed: false, rebound: false,
      changes: [{ serviceId, name: "API a", was: 1, now: 2 }], stopsProcesses: false, restartsProcesses: false } });
    expect(ownerBindings(f.ownerScopes)).toHaveLength(1);
    expect(await f.rebind(true)).toMatchObject({ ok: true, payload: { state: "current", confirmed: true, rebound: true } });

    // In place, in the same Host process: exactly one bootstrap ever, and the
    // replacement scope named the instance the Host actually held.
    const [bootstrapped, replaced] = ownerBindings(f.ownerScopes);
    expect(ownerBindings(f.ownerScopes).map((scope) => scope["kind"])).toEqual(["service-owner-bootstrap", "service-owner-rebind"]);
    expect(replaced!["previousInstanceId"]).toBe(bootstrapped!["instanceId"]);
    expect(replaced!["instanceId"]).not.toBe(bootstrapped!["instanceId"]);
    expect(replaced!["catalogRevision"]).not.toBe(bootstrapped!["catalogRevision"]);
    expect(replaced!["entries"]).toMatchObject([{ serviceId, templateVersion: 2 }]);
    // The re-bind killed nothing: the child started at revision 1 is alive.
    expect(alive(before)).toBe(true);

    // Control is genuinely back at the new revision, and the child that runs is
    // the new revision's launch: real pid, real argv, real liveness.
    expect(await f.run(serviceId, "stop")).toMatchObject({ ok: true, payload: { serviceId, action: "stop" } });
    await until(() => !alive(before), "the revision-1 child to exit");
    rmSync(f.marker("a"), { force: true });
    rmSync(f.markerArgs("a"), { force: true });
    expect(await f.run(serviceId, "start")).toMatchObject({ ok: true, payload: { serviceId, action: "start" } });
    const after = await untilMarkerPid(f.taskDir, "a");
    expect(after).not.toBe(before);
    expect(alive(after)).toBe(true);
    // Same proxy/real race as above: the argv marker is written after the pid
    // marker, so wait for the exact argv value instead of racing the child.
    await until(() => { try { return readFileSync(f.markerArgs("a"), "utf8") === "v2"; } catch { return false; } }, "the revision-2 argv marker");
    expect(await f.status(serviceId)).toMatchObject({ lifecycle: "running", templateVersion: "2" });

    // Idempotent: a repeat re-bind replaces nothing and spawns nothing.
    expect(await f.rebind(true)).toMatchObject({ ok: true, payload: { state: "current", confirmed: false, rebound: false, changes: [] } });
    expect(ownerBindings(f.ownerScopes)).toHaveLength(2);
    expect(readFileSync(f.marker("a"), "utf8")).toBe(String(after));
    expect(await f.run(serviceId, "stop")).toMatchObject({ ok: true, payload: { action: "stop" } });
    await until(() => !alive(after), "the revision-2 child to exit");
  }, 60_000);

  it("re-binds a task fenced by a moved owner contract with the same pinned version, so a config-only revoke is not a dead end", async () => {
    const f = await production();
    const serviceId = f.bind("svc-a", "a");
    expect(await f.run(serviceId, "start")).toMatchObject({ ok: true, payload: { serviceId, action: "start" } });
    const before = await untilMarkerPid(f.taskDir, "a");
    expect(alive(before)).toBe(true);
    // The fence this case is about: the task binding moved to another work
    // subdirectory, so the resolved owner contract main pins changed while the
    // template version it pins did not. `ownerSnapshot` digests the binding, so
    // control is revoked exactly like an adoption would revoke it.
    f.catalog.bindTask({ taskId: f.taskId, serviceId, environmentId: f.environmentId, templateVersion: 1, rootId: "repo-a", subdir: "svc-b",
      programPath: realpathSync(process.execPath), privateRefs: [{ key: "SERVICE_TOKEN", envRef: "LOCAL_TEST_TOKEN" }] });
    expect(await f.run(serviceId, "stop")).toMatchObject({ ok: false, error: expect.stringContaining("service-owner-inventory-unconfirmed") });
    expect(alive(before)).toBe(true);
    // The review is renderable: the row names the service and reports that the
    // difference is the owner contract, not a version bump. Without that fact the
    // page cannot verify the receipt, so the confirm step would be unreachable.
    expect(await f.rebind(false)).toMatchObject({ ok: true, payload: { taskId: f.taskId, state: "fenced", confirmed: false, rebound: false,
      changes: [{ serviceId, name: "API a", was: 1, now: 1, configChanged: true }], stopsProcesses: false, restartsProcesses: false } });
    expect(ownerBindings(f.ownerScopes)).toHaveLength(1);
    expect(await f.rebind(true)).toMatchObject({ ok: true, payload: { state: "current", confirmed: true, rebound: true,
      changes: [{ serviceId, was: 1, now: 1, configChanged: true }] } });
    // The replacement named the instance this Host held, and it killed nothing.
    expect(ownerBindings(f.ownerScopes).map((scope) => scope["kind"])).toEqual(["service-owner-bootstrap", "service-owner-rebind"]);
    expect(alive(before)).toBe(true);
    // Control is back: the running child is still the one that was started, and
    // the explicit stop now reaches it.
    expect(await f.run(serviceId, "stop")).toMatchObject({ ok: true, payload: { serviceId, action: "stop" } });
    await until(() => !alive(before), "the same-version re-bound service child to exit");
  }, 60_000);

  it("refuses a confirmed re-bind by name while a durable owner record is unsettled, and drops nothing", async () => {
    const f = await production();
    const serviceId = f.bind("svc-a", "a");
    // A durable `running` owner written before this task's Host is forked: the
    // record may still stand for a live process, so it is never replaced
    // silently. (The same guard with the real store is covered in
    // `service-host-binding.test.ts`.)
    f.seedOwner(serviceId, "running");
    expect(await f.run(serviceId, "start")).toMatchObject({ ok: false, error: expect.stringContaining("service-execution-uncertain") });
    expect(f.tasks.size).toBe(1);
    expect(existsSync(f.marker("a"))).toBe(false);
    f.saveRevision(serviceId);
    expect(await f.adopt(serviceId, 2, true)).toMatchObject({ ok: true, payload: { restart: { fencedTaskIds: [f.taskId] } } });

    // Fail closed with the named refusal, and leave the fence, the Host and the
    // durable record exactly as they were.
    expect(await f.rebind(true)).toMatchObject({ ok: false, error: expect.stringContaining(`service-owner-rebind-blocked: ${serviceId}`) });
    expect(ownerBindings(f.ownerScopes).map((scope) => scope["kind"])).toEqual(["service-owner-bootstrap"]);
    expect(await f.rebind(false)).toMatchObject({ ok: true, payload: { state: "fenced", confirmed: false, rebound: false, changes: [{ serviceId, was: 1, now: 2 }] } });
    expect(await f.run(serviceId, "stop")).toMatchObject({ ok: false, error: expect.stringContaining("service-owner-inventory-unconfirmed") });
    expect(f.tasks.size).toBe(1);
  }, 60_000);

  it("refuses the production trigger with the named unsupported-platform refusal on win32", async () => {
    const f = await production();
    const serviceId = f.bind("svc-a", "a");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const refused = await f.run(serviceId, "start");
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("unsupported-platform") });
    // The refusal precedes the launch: no Host entry was created (the registry
    // has no task, so `routeTaskOp` was never asked to register/control), no
    // launch was resolved and therefore no child exists - exactly like the
    // driver's own win32 refusal. (This harness drives a fake utilityProcess
    // pair, so "forked" is not observable here; the observable fact is the
    // absent Host entry plus the absent marker.)
    expect(f.tasks.size).toBe(0);
    expect(existsSync(f.marker("a"))).toBe(false);
  }, 30_000);
});

/**
 * [PiDock 05] (#10 box 4) the SAME installed handler, the group branch: the
 * `{op:"runTaskServiceGroup"}` case of `shell/serviceCatalogOp`. The sibling
 * suite above drives the single-service branch; `../host/service-group-linkage.test.ts`
 * drives `runTaskServiceGroup` through a fake registry. This one is the hop the
 * two leave unpinned: the real handler → `runTaskServiceGroup` → the real
 * registry → the real Host → REAL children.
 */
describe.skipIf(process.platform === "win32")("#10 production shell/serviceCatalogOp group start", () => {
  it("starts the task's whole bound group through the registered handler and observes the real children", async () => {
    const f = await production();
    const portA = await freePort();
    const portB = await freePort();
    // The renderer names only project/task, so main owns the membership: every
    // service bound in the trusted catalog is a member of the group.
    const bindListening = (subdir: string, tag: string, port: number) => {
      writeFileSync(join(f.taskDir, "repo-a", subdir, "service.cjs"), GROUP_LISTENING_SCRIPT);
      // The port comes from the template's own SHARED row: it is both the value
      // the child binds and the port the registration declares, so no synthetic
      // private reference is needed to drive the real group path.
      const template = f.catalog.saveTemplate({ projectId: f.projectId, environmentId: f.environmentId,
        descriptor: { name: `API ${tag}`, program: "node", args: ["service.cjs"], ports: [], runType: "long-lived" },
        shared: [{ key: "SERVICE_TAG", value: tag, secret: false }, { key: "PORT", value: String(port), secret: false }] });
      f.catalog.bindTask({ taskId: f.taskId, serviceId: template.serviceId, environmentId: f.environmentId, templateVersion: 1, rootId: "repo-a", subdir,
        programPath: realpathSync(process.execPath), privateRefs: [] });
      return template.serviceId;
    };
    const first = bindListening("svc-a", "a", portA);
    const second = bindListening("svc-b", "b", portB);

    const answered = await f.op({ op: "runTaskServiceGroup", projectId: f.projectId, taskId: f.taskId }) as
      { ok: boolean; payload?: { group: Record<string, unknown> } };
    expect(answered.ok).toBe(true);
    const group = answered.payload?.group as Record<string, unknown>;
    // The Host's own group observation, over the plan main derived from the
    // catalog: both units really started and really accepted a connection on the
    // address their own registration declares. No dependency edge exists on this
    // route, so 已互验 is not claimed.
    expect(group["state"]).toBe("listening");
    const units = group["units"] as Record<string, unknown>[];
    expect(units).toHaveLength(2);
    expect(units.map((unit) => unit["serviceId"]).sort()).toEqual([first, second].sort());
    expect(units.map((unit) => unit["start"])).toEqual(["started", "started"]);
    expect(units.map((unit) => unit["listening"])).toEqual(["listening", "listening"]);
    expect(units.map((unit) => unit["linked"])).toEqual([false, false]);
    expect(units.flatMap((unit) => (unit["steps"] as Record<string, unknown>[])).filter((step) => step["kind"] === "linkage")).toEqual([]);
    expect(units.find((unit) => unit["serviceId"] === first)).toMatchObject({ order: 1, address: { host: "127.0.0.1", port: portA }, observedRun: true });
    expect(units.find((unit) => unit["serviceId"] === second)).toMatchObject({ order: 2, address: { host: "127.0.0.1", port: portB }, observedRun: true });

    // REAL children: each unit's own pid is alive and is the pid that wrote the
    // marker in ITS OWN working directory - and the Host registered the same
    // launch the single-service path executes.
    const children: number[] = [];
    for (const [subdir, tag, serviceId] of [["svc-a", "a", first], ["svc-b", "b", second]] as const) {
      const marker = join(f.taskDir, "repo-a", subdir, "listening.txt");
      const pid = await untilMarkerPid(f.taskDir, tag);
      children.push(pid);
      expect(alive(pid)).toBe(true);
      // The binding the Host observed is the child's OWN socket: it wrote this
      // pid only from its `listen` callback, on the declared port.
      await until(() => { try { return readFileSync(marker, "utf8") === String(pid); } catch { return false; } }, `the listening marker of svc-${tag}`);
      expect(units.find((unit) => unit["serviceId"] === serviceId)?.["pid"]).toBe(pid);
      expect(await f.status(serviceId)).toMatchObject({ lifecycle: "running", launchSource: "catalog", health: "undeclared" });
    }
    expect(new Set(children).size).toBe(2);

    // Stopped through the SAME registered tree: the group path left no child of
    // its own behind.
    for (const serviceId of [first, second]) {
      expect(await f.run(serviceId, "stop")).toMatchObject({ ok: true, payload: { serviceId, action: "stop" } });
    }
    await until(() => children.every((pid) => !alive(pid)), "both group children to exit");
  }, 60_000);

  it("refuses a group start with no bound service by name through the same handler, starting nothing", async () => {
    const f = await production();
    // The task exists but the trusted catalog binds nothing to it: main refuses
    // by name before resolving a launch, forking a Host or planning a group.
    expect(await f.op({ op: "runTaskServiceGroup", projectId: f.projectId, taskId: f.taskId }))
      .toEqual({ ok: false, error: "service-group-empty: 该任务在可信服务目录中没有已绑定的服务，未发起整组启动" });
    expect(f.tasks.size).toBe(0);
  }, 30_000);
});
