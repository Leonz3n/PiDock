import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "../rpc/host-client.js";
import { InstalledServiceHostAuthority } from "../main/service-host-binding.js";
import { createHostDisposer, createHostStopper, PerTaskHostRegistry } from "../main/runtime.js";
import { ServiceCatalog, serviceCatalogAuthority } from "../main/service-catalog.js";
import { TaskRootIndex } from "../main/task-root-index.js";
import { ProjectRegistry } from "../main/project-registry.js";
import { registerApplicationLifecycle } from "../main/application-lifecycle.js";
import { diskTaskStore } from "./task-host.js";
import { buildTaskDiskRecord } from "./task-store.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); vi.resetModules(); });
async function installed() {
  vi.resetModules();
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-installed-parent-"))); cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const profile = join(home, "profile"), root = join(home, "tasks"), taskId = "task-12345678", taskDir = join(root, taskId), workspaceId = "workspace-a";
  mkdirSync(profile, { mode: 0o700 }); mkdirSync(taskDir, { recursive: true });
  diskTaskStore.writeTask(taskDir, buildTaskDiskRecord({ taskId, name: "Installed", dirId: taskId, branch: "task/main", root, taskDir,
    remoteBranch: "main", baseCommit: "source-fixture", repos: [], now: "2026-01-01T00:00:00.000Z" }));
  const roots = new TaskRootIndex(profile, root); await roots.register(taskDir);
  const projects = new ProjectRegistry(profile), authority = serviceCatalogAuthority(roots, projects), catalog = new ServiceCatalog(profile, authority);
  const child = new EventEmitter() as EventEmitter & { postMessage(value: unknown): void; kill(): void };
  child.kill = vi.fn(() => { child.emit("exit", 0); });
  const parent = new EventEmitter() as EventEmitter & { postMessage(value: unknown): void };
  child.postMessage = (value) => { parent.emit("message", { data: value }); };
  parent.postMessage = (value) => { child.emit("message", value); };
  const oldPort = Object.getOwnPropertyDescriptor(process, "parentPort");
  Object.defineProperty(process, "parentPort", { configurable: true, value: parent });
  cleanups.push(() => { if (oldPort) Object.defineProperty(process, "parentPort", oldPort); else Reflect.deleteProperty(process, "parentPort"); });
  for (const [name, value] of Object.entries({ PIDOCK_WORKSPACE_ID: workspaceId, PIDOCK_TASK_ID: taskId, PIDOCK_TASK_DIR: taskDir,
    PIDOCK_PROTECTED_PROFILE: profile, PIDOCK_DEFAULT_TASKS_ROOT: root, PIDOCK_SERVICE_OWNER_REQUIRED: "1" })) vi.stubEnv(name, value);
  const { startHost } = await import("./host.js"); startHost();
  const client = new HostClient(child as never), main = new InstalledServiceHostAuthority(profile, catalog, authority, workspaceId, {});
  cleanups.push(async () => { client.dispose(); child.emit("exit", 0); await main.disposeWhenExited().catch(() => {}); });
  const task = (op: Parameters<HostClient["task"]>[0]["op"], payload: Record<string, unknown> = {}) => client.task({ workspaceId, taskId, op, payload,
    origin: { kind: "shell-ui", senderWebContentsId: 7 } });
  return { profile, taskId, taskDir, child, main, client, task, catalog, projects, roots };
}

describe.skipIf(process.platform === "win32")("installed Host parent RPC service authority", () => {
  it("keeps service execution closed on ordinary RPC and requires actual parent bootstrap plus durable quit completion", async () => {
    const f = await installed();
    expect((await f.task("task/sessionStates")).payload).toMatchObject({ orphans: [{ resourceId: "service-owner-inventory", verificationRequired: true }] });
    await expect(f.task("task/controlService", { serviceId: "service-a", action: "start" })).rejects.toThrow("service-execution-unavailable");
    // A generic renderer-style task payload cannot bootstrap or clear the owner inventory.
    await expect(f.task("task/serviceStatus", { serviceId: "service-a", bootstrap: { entries: [] } })).rejects.toThrow();
    await f.main.prepare(f.child as never, f.taskId);
    await expect(f.task("task/serviceStatus", { serviceId: "service-a" })).rejects.toThrow("unknown-service");
    const result = await f.task("task/quit");
    expect(result.payload).toMatchObject({ serviceOwner: { taskId: f.taskId, entries: [], report: { status: "closed" } } });
    f.main.confirm(f.child as never, (result.payload as { serviceOwner: unknown }).serviceOwner);
    await expect(f.task("task/controlService", { serviceId: "service-a", action: "start" })).rejects.toThrow("task-host-closing");
  });
  it("bootstraps ordinary registry routes and confirms the durable report before authorizing Host disposal", async () => {
    const f = await installed();
    const registry = new PerTaskHostRegistry("workspace-a", async () => ({ client: f.client, child: f.child as never }), () => f.taskDir, undefined, f.roots);
    registry.configureServices(() => f.main);
    const read = await registry.routeTaskOp({ taskId: f.taskId, op: "task/sdkProjection", payload: { sessionId: "main" }, origin: { kind: "shell-ui", senderWebContentsId: 7 } });
    expect(read.payload).toMatchObject({ sessionId: "main", messages: [] });
    const report = await registry.quitAll({ origin: { kind: "shell-ui", senderWebContentsId: 7 } }); expect(report.ok).toBe(true);
    await registry.disposeAll(); expect(f.child.kill).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])("awaits installed Host exit and writer disposal before application quit (storage failure=%s)", async (failStorage) => {
    const f = await installed(); vi.mocked(f.child.kill).mockImplementation(() => {});
    const registry = new PerTaskHostRegistry("workspace-a", async () => ({ client: f.client, child: f.child as never }), () => f.taskDir, undefined, f.roots);
    registry.configureServices(() => f.main);
    await registry.routeTaskOp({ taskId: f.taskId, op: "task/sdkProjection", payload: { sessionId: "main" }, origin: { kind: "shell-ui", senderWebContentsId: 7 } });
    const stop = createHostStopper(registry, { kind: "shell-ui", senderWebContentsId: 7 }, () => registry.disposeAll());
    const app = Object.assign(new EventEmitter(), { quit: vi.fn() });
    const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, isMinimized: () => false, hide: vi.fn(), show: vi.fn(), focus: vi.fn(), restore: vi.fn() });
    registerApplicationLifecycle({ app: app as never, window: window as never, platform: "darwin", stopHosts: stop });
    app.emit("before-quit", { preventDefault: vi.fn() });
    const pending = stop();
    await new Promise<void>((done) => setImmediate(done));
    expect(f.child.kill).toHaveBeenCalledTimes(1); expect(app.quit).not.toHaveBeenCalled(); expect(registry.size).toBe(1);
    const lock = join(f.profile, "service-execution-recovery", "writer.lock");
    expect(existsSync(lock)).toBe(true);
    if (failStorage) writeFileSync(join(f.profile, "service-execution-recovery.witness.json"), "{}", { mode: 0o600 });
    expect(() => f.child.emit("exit", 0)).not.toThrow();
    expect(await pending).toBe(!failStorage);
    await new Promise<void>((done) => setImmediate(done));
    expect(app.quit).toHaveBeenCalledTimes(failStorage ? 0 : 1);
    expect(registry.size).toBe(failStorage ? 1 : 0);
    expect(existsSync(lock)).toBe(failStorage);
    expect(await stop()).toBe(!failStorage); expect(f.child.kill).toHaveBeenCalledTimes(1);
    if (failStorage) expect(window.show).toHaveBeenCalledTimes(1);
  });
  it.each(["before quit", "during task disposal"])("accepts workspace exit observed %s through the production disposal callback", async (timing) => {
    const f = await installed(); vi.mocked(f.child.kill).mockImplementation(() => {});
    const workspace = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const workspaceClient = { dispose: vi.fn() }, stopSchedules = vi.fn();
    const disposal = createHostDisposer(workspace as never);
    const registry = new PerTaskHostRegistry("workspace-a", async () => ({ client: f.client, child: f.child as never }), () => f.taskDir, undefined, f.roots);
    registry.configureServices(() => f.main);
    await registry.routeTaskOp({ taskId: f.taskId, op: "task/sdkProjection", payload: { sessionId: "main" }, origin: { kind: "shell-ui", senderWebContentsId: 7 } });
    const stop = createHostStopper(registry, { kind: "shell-ui", senderWebContentsId: 7 },
      () => disposal.disposeAfterTasks(registry, workspaceClient, stopSchedules));
    const app = Object.assign(new EventEmitter(), { quit: vi.fn() });
    const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, isMinimized: () => false, hide: vi.fn(), show: vi.fn(), focus: vi.fn(), restore: vi.fn() });
    registerApplicationLifecycle({ app: app as never, window: window as never, platform: "darwin", stopHosts: stop });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      if (timing === "before quit") workspace.emit("exit", 0);
      app.emit("before-quit", { preventDefault: vi.fn() });
      const pending = stop();
      await new Promise<void>((done) => setImmediate(done));
      if (timing === "during task disposal") workspace.emit("exit", 0);
      const lock = join(f.profile, "service-execution-recovery", "writer.lock");
      expect(f.child.kill).toHaveBeenCalledTimes(1);
      expect(registry.size).toBe(1); expect(existsSync(lock)).toBe(true);
      expect(app.quit).not.toHaveBeenCalled(); expect(workspace.kill).not.toHaveBeenCalled();
      expect(workspaceClient.dispose).not.toHaveBeenCalled();
      f.child.emit("exit", 0);
      await new Promise<void>((done) => setImmediate(done));
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await pending).toBe(true);
      expect(registry.size).toBe(0); expect(existsSync(lock)).toBe(false);
      expect(app.quit).toHaveBeenCalledTimes(1); expect(workspace.kill).not.toHaveBeenCalled();
      expect(workspaceClient.dispose).toHaveBeenCalledTimes(1); expect(stopSchedules).toHaveBeenCalledTimes(1);
      expect(stop()).toBe(pending); expect(await stop()).toBe(true);
    } finally { workspace.emit("exit", 0); vi.useRealTimers(); }
  });
  it("fences failed catalog authority, preserves read RPC, and refuses a fabricated successful quit", async () => {
    const f = await installed();
    f.child.postMessage({ kind: "service-owner-fenced", workspaceId: "workspace-a", taskId: f.taskId });
    const ping = await f.client.ping({ workspaceId: "workspace-a" }); expect(ping.pong).toBe(true);
    expect((await f.task("task/sdkProjection", { sessionId: "main" })).payload).toMatchObject({ sessionId: "main", messages: [] });
    expect((await f.task("task/sessionStates")).payload).toMatchObject({ orphans: [{ resourceId: "service-owner-inventory", verificationRequired: true }] });
    await expect(f.task("task/serviceStatus", { serviceId: "service-a" })).rejects.toThrow("service-owner-inventory-unconfirmed");
    await expect(f.task("task/quit")).rejects.toThrow("service-owner-shutdown-unconfirmed");
  });
});
