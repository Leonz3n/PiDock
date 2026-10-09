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

const SERVICE_SCRIPT = `const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(process.cwd(), "started-" + process.env.SERVICE_TAG + ".txt"), String(process.pid));
console.log("ready:" + process.env.SERVICE_TAG);
console.log("pid:" + process.pid);
console.log("token:" + (process.env.SERVICE_TOKEN ?? "none"));
setInterval(() => {}, 1000);
`;

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

  const child = new EventEmitter() as EventEmitter & { postMessage(value: unknown): void; kill(): void };
  child.kill = vi.fn(() => { child.emit("exit", 0); });
  const parent = new EventEmitter() as EventEmitter & { postMessage(value: unknown): void };
  child.postMessage = (value) => { parent.emit("message", { data: value }); };
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
    const template = catalog.saveTemplate({ projectId, descriptor: { name: `API ${tag}`, program: "node", args: ["service.cjs"], ports: [], runType: "long-lived" },
      shared: [{ key: "SERVICE_TAG", value: tag, secret: false }] });
    catalog.bindTask({ taskId, serviceId: template.serviceId, templateVersion: 1, rootId: "repo-a", subdir,
      programPath: realpathSync(process.execPath), privateRefs: [{ key: "SERVICE_TOKEN", envRef: "LOCAL_TEST_TOKEN" }] });
    return template.serviceId;
  };
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
  return { taskId, taskDir, projectId, catalog, tasks, client, main, handler: handler!, shell, trust, run, read, status, log, bind, marker: (tag: string) => join(taskDir, `repo-a/svc-${tag}`, `started-${tag}.txt`) };
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

    // Real process liveness, not a dependency-reachability probe: `health`
    // stays `not-probed` while `lifecycle` follows the real child.
    expect(await f.status(first)).toMatchObject({ serviceId: first, lifecycle: "running", launchSource: "catalog", health: "not-probed" });
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
    expect(existsSync(f.marker("a"))).toBe(false);
    expect(f.tasks.size).toBe(0);
  }, 30_000);

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
