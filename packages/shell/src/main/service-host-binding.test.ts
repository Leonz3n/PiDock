import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, fsyncSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceCatalog, type ServiceCatalogAuthority } from "./service-catalog.js";
import { InstalledServiceHostAuthority } from "./service-host-binding.js";
import { ServiceOwnerInventory } from "../host/service-owner-inventory.js";
import { TaskWriteCoordinator } from "../host/write-coordination.js";
import { ExperimentalServiceRecoveryStore } from "./service-recovery-store-experiment.js";
import { serviceOwnerBootstrap, type ServiceOwnerBootstrap } from "../rpc/service-host-binding.js";

// Inject filesystem I/O faults at the external storage boundary, retaining real store/lease behavior.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, unlinkSync: vi.fn(fs.unlinkSync), fsyncSync: vi.fn(fs.fsyncSync) };
});

const homes: string[] = [], exits: (() => void)[] = [], dispose: (() => Promise<void>)[] = [];
afterEach(async () => { for (const exit of exits.splice(0)) exit(); await Promise.allSettled(dispose.splice(0).map((close) => close())); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture(unassigned = false) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-installed-service-"))); homes.push(home);
  const profile = join(home, "profile"), root = join(home, "tasks"), taskId = "task-12345678", taskDir = join(root, taskId), workspaceId = "workspace-a";
  mkdirSync(profile, { mode: 0o700 }); mkdirSync(join(taskDir, "repo-a"), { recursive: true });
  const stat = statSync(taskDir, { bigint: true }), projectId = randomUUID();
  const identity = { taskId, createdAt: "2026-01-01T00:00:00.000Z", root, realRoot: root, dirId: taskId, directoryDevice: stat.dev.toString(), directoryInode: stat.ino.toString() };
  let assigned = !unassigned;
  const authority: ServiceCatalogAuthority = { projectExists: (id) => id === projectId,
    task: (id) => id === taskId && assigned ? { identity, projectId, rootIds: ["repo-a"] } : null,
    verifiedTask: (id) => id === taskId ? { identity, projectId: assigned ? projectId : null, rootIds: ["repo-a"] } : null };
  const catalog = new ServiceCatalog(profile, authority);
  const add = () => {
    const template = catalog.saveTemplate({ projectId, descriptor: { name: "API", program: "node", args: ["server.js"], ports: [], runType: "long-lived" }, shared: [] });
    catalog.bindTask({ taskId, serviceId: template.serviceId, templateVersion: 1, rootId: "repo-a", subdir: "", programPath: process.execPath, privateRefs: [] });
    return template;
  };
  return { profile, taskId, taskDir, workspaceId, authority, catalog, add, unlink: () => { assigned = false; } };
}
function connect(f: ReturnType<typeof fixture>) {
  const child = new EventEmitter() as EventEmitter & { postMessage(value: unknown): void };
  let scope!: ServiceOwnerBootstrap;
  let holdReports = false;
  const held: unknown[] = [];
  const subscribers = new Map<string | null, { receive(value: unknown): void; disconnected(): void }>();
  const write: TaskWriteCoordinator = new TaskWriteCoordinator(() => inventory.resources());
  const inventory = new ServiceOwnerInventory(f.workspaceId, f.taskId, f.taskDir, write, (s, serviceId) => ({
    send: (request) => child.emit("message", { kind: "service-owner-request", workspaceId: s.workspaceId, taskId: s.taskId,
      instanceId: s.instanceId, epoch: s.epoch, catalogRevision: s.catalogRevision, serviceId, request }),
    subscribe: (receive, disconnected) => { subscribers.set(serviceId, { receive, disconnected }); return () => { subscribers.delete(serviceId); }; },
  }));
  child.postMessage = (value) => {
    const row = value as Record<string, unknown>;
    if (row.kind === "service-owner-bootstrap") {
      scope = serviceOwnerBootstrap(value, f.workspaceId, f.taskId);
      void inventory.bootstrap(scope).then(() => child.emit("message", { kind: "service-owner-ready", workspaceId: scope.workspaceId, taskId: scope.taskId,
        instanceId: scope.instanceId, epoch: scope.epoch, catalogRevision: scope.catalogRevision }), () => inventory.fence());
    } else if (row.kind === "service-owner-fenced") {
      inventory.fence(); for (const subscriber of [...subscribers.values()]) subscriber.disconnected();
    } else if (row.kind === "service-owner-ack") {
      if (holdReports && row.serviceId === null) held.push(value);
      else subscribers.get(row.serviceId as string | null)!.receive(row.reply);
    }
  };
  const main = new InstalledServiceHostAuthority(f.profile, f.catalog, f.authority, f.workspaceId, {});
  exits.push(() => child.emit("exit", 0)); dispose.push(() => main.disposeWhenExited());
  return { child, main, inventory, write, scope: () => scope,
    prepare: () => main.prepare(child as never, f.taskId),
    holdReportAck: () => { holdReports = true; },
    releaseReportAck: () => { for (const value of held.splice(0)) subscribers.get(null)!.receive((value as { reply: unknown }).reply); },
    requests: (extra: Record<string, unknown>) => child.emit("message", { kind: "service-owner-request", workspaceId: scope.workspaceId, taskId: scope.taskId,
      instanceId: scope.instanceId, epoch: scope.epoch, catalogRevision: scope.catalogRevision, serviceId: null,
      request: { kind: "shutdown-report-request", id: 1, packet: { op: "shutdown", epoch: scope.epoch, report: {} } }, ...extra }),
  };
}
describe.skipIf(process.platform === "win32")("installed actual-child catalog / owner / checkpoint / report connection", () => {
  it("requires strict durable inventory for an unassigned known empty task and closes only after report acknowledgement", async () => {
    const f = fixture(true), c = connect(f);
    expect(c.write.claimWrite("main", "auto", { kind: "turn", label: "before bootstrap" }).ok).toBe(false);
    await c.prepare(); expect(c.inventory.resources()).toEqual([]); expect(c.inventory.control().error).toBe("service-execution-unavailable");
    c.holdReportAck(); let done = false;
    const closing = c.inventory.close().then((result) => { done = true; return result; });
    await new Promise<void>((resolve) => setImmediate(resolve)); expect(done).toBe(false);
    expect(() => c.main.confirm(c.child as never, {})).toThrow();
    c.releaseReportAck(); const result = await closing; c.main.confirm(c.child as never, result);
    expect(result.entries).toEqual([]); expect(result.report.status).toBe("closed");
  });
  it("releases the strict writer only after every actual child exit revokes its durable lease", async () => {
    const f = fixture(true), c = connect(f); await c.prepare(); const completion = await c.inventory.close(); c.main.confirm(c.child as never, completion);
    const receipt = c.main.disposeWhenExited();
    expect(receipt).toBeInstanceOf(Promise);
    expect(c.main.disposeWhenExited()).toBe(receipt);
    let disposed = false;
    const observed = receipt.then(() => { disposed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(disposed).toBe(false);
    expect(() => c.child.emit("exit", 0)).not.toThrow();
    await observed;
    expect(disposed).toBe(true);
    const next = connect(f); await next.prepare();
  });
  it.each(["witness", "lock", "unlink", "fsync"])("captures %s disposal failure in the cached receipt without an uncaught exit error", async (fault) => {
    const f = fixture(true), c = connect(f); await c.prepare();
    c.main.confirm(c.child as never, await c.inventory.close());
    const receipt = c.main.disposeWhenExited();
    const rejected = expect(receipt).rejects.toThrow("service-recovery-unavailable");
    const lock = join(f.profile, "service-execution-recovery", "writer.lock");
    if (fault === "witness") writeFileSync(join(f.profile, "service-execution-recovery.witness.json"), "{}", { mode: 0o600 });
    if (fault === "lock") renameSync(lock, `${lock}.replaced`);
    if (fault === "unlink") vi.mocked(unlinkSync).mockImplementationOnce(() => { throw Error("synthetic-unlink-io"); });
    if (fault === "fsync") vi.mocked(fsyncSync).mockImplementationOnce(() => { throw Error("synthetic-fsync-io"); });
    expect(() => c.child.emit("exit", 0)).not.toThrow();
    await rejected;
    expect(c.main.disposeWhenExited()).toBe(receipt);
    c.child.emit("exit", 0);
    await expect(c.main.disposeWhenExited()).rejects.toThrow("service-recovery-unavailable");
    if (fault === "witness" || fault === "unlink") expect(existsSync(lock)).toBe(true);
    // Only the disposable fixture is removed by teardown; no authority retry repairs this failure.
  });
  it("bounds the authority receipt and keeps late lease revocation from granting disposal success", async () => {
    const f = fixture(true), c = connect(f); await c.prepare();
    c.main.confirm(c.child as never, await c.inventory.close());
    vi.useFakeTimers();
    try {
      const receipt = c.main.disposeWhenExited();
      const rejected = expect(receipt).rejects.toThrow("service-owner-disposal-unconfirmed");
      await vi.advanceTimersByTimeAsync(15_000); await rejected;
      expect(c.main.disposeWhenExited()).toBe(receipt);
      c.child.emit("exit", 0); await Promise.resolve();
      await expect(receipt).rejects.toThrow("service-owner-disposal-unconfirmed");
      expect(existsSync(join(f.profile, "service-execution-recovery", "writer.lock"))).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("uses saved catalog inventory, acknowledges terminal checkpoints in the current epoch and admits zero execution", async () => {
    const f = fixture(), template = f.add(), c = connect(f); await c.prepare();
    expect(c.inventory.status(template.serviceId)).toMatchObject({ ok: true, service: { state: "stopped", executionAvailable: false } });
    expect(c.inventory.control()).toEqual({ ok: false, error: "service-execution-unavailable" });
    const completion = await c.inventory.close(); expect(completion.entries).toHaveLength(1); c.main.confirm(c.child as never, completion);
    expect(() => c.main.confirm({} as never, completion)).toThrow("service-owner-inventory-unconfirmed");
  });
  it("keeps recovered active owners in the real write gate and refuses closed reports", async () => {
    const f = fixture(), template = f.add();
    const store = new ExperimentalServiceRecoveryStore(f.profile, f.authority, () => [template.serviceId]);
    let exit!: () => void, exited = false; const sender = {};
    store.acquire(f.taskId, { sender, hasExited: () => exited, subscribeExit: (listener) => { exit = listener; return () => {}; } }).port(sender, template.serviceId)
      .write({ schemaVersion: 1, taskId: f.taskId, serviceId: template.serviceId, state: "running", ownerSessionId: "previous-owner" });
    exited = true; exit(); store.dispose();
    const c = connect(f); await c.prepare();
    expect(c.inventory.resources()).toContainEqual({ resourceId: template.serviceId, kind: "service", ownerSessionId: "previous-owner", verificationRequired: true });
    expect(c.write.claimWrite("previous-owner", "auto", { kind: "turn", label: "retry" }).ok).toBe(false);
    await expect(c.inventory.close()).rejects.toThrow("service-owner-shutdown-unconfirmed");
  });
  it("treats zero catalog services plus a historical unbound owner as unknown, blocking writes and quit", async () => {
    const f = fixture(true), sender = {}; let exited = false, exit!: () => void;
    const store = new ExperimentalServiceRecoveryStore(f.profile, { projectExists: () => true, task: (id) => f.authority.verifiedTask!(id) }, () => ["orphan-service"]);
    store.acquire(f.taskId, { sender, hasExited: () => exited, subscribeExit: (listener) => { exit = listener; return () => {}; } }).port(sender, "orphan-service")
      .write({ schemaVersion: 1, taskId: f.taskId, serviceId: "orphan-service", state: "starting", ownerSessionId: "old-owner" });
    exited = true; exit(); store.dispose();
    expect(f.catalog.ownerSnapshot(f.taskId, f.workspaceId, {}).entries).toEqual([]);
    const c = connect(f); await expect(c.prepare()).rejects.toThrow("service-owner-inventory-unconfirmed");
    expect(c.write.claimWrite("old-owner", "auto", { kind: "turn", label: "new" }).ok).toBe(false);
    await expect(c.inventory.close()).rejects.toThrow("service-owner-shutdown-unconfirmed");
  });
  it("does not rewrite a prior assigned empty durable scope after trusted project unlink", async () => {
    const f = fixture(), c = connect(f); await c.prepare(); const result = await c.inventory.close(); c.main.confirm(c.child as never, result);
    c.child.emit("exit", 0); c.main.disposeWhenExited(); f.unlink();
    expect(f.catalog.ownerSnapshot(f.taskId, f.workspaceId, {}).entries).toEqual([]);
    const next = connect(f); await expect(next.prepare()).rejects.toThrow("service-owner-inventory-unconfirmed");
    expect(next.inventory.resources()[0].verificationRequired).toBe(true);
  });
  it("does not clear old assigned checkpoints after project unlink or treat a failed snapshot as empty", async () => {
    const f = fixture(), template = f.add(), c = connect(f); await c.prepare(); const result = await c.inventory.close(); c.main.confirm(c.child as never, result);
    c.child.emit("exit", 0); c.main.disposeWhenExited(); f.unlink();
    const next = connect(f); await expect(next.prepare()).rejects.toThrow("service-owner-inventory-unconfirmed");
    expect(next.write.claimWrite("main", "auto", { kind: "turn", label: template.serviceId }).ok).toBe(false);
  });
  it.each(["instanceId", "epoch", "catalogRevision", "taskId", "workspaceId"])("fences forged %s on the actual child channel without accepting a report", async (key) => {
    const f = fixture(true), c = connect(f); await c.prepare(); c.requests({ [key]: "foreign" });
    expect(() => c.main.verify(c.child as never)).toThrow(); expect(c.inventory.resources()[0].verificationRequired).toBe(true);
    await expect(c.inventory.close()).rejects.toThrow();
  });
  it("invalidates the inventory when saved UI metadata changes and never confers execution authority", async () => {
    const f = fixture(), first = f.add(), c = connect(f); await c.prepare();
    f.catalog.saveTemplate({ projectId: first.projectId, serviceId: first.serviceId, expectedVersion: 1, descriptor: first.descriptor, shared: [] });
    // Pinning is deliberate: changing the task binding, rather than an unrelated new version, revokes this snapshot.
    f.catalog.bindTask({ taskId: f.taskId, serviceId: first.serviceId, templateVersion: 2, rootId: "repo-a", subdir: "", programPath: process.execPath, privateRefs: [] });
    expect(() => c.main.verify(c.child as never)).toThrow("service-owner-inventory-unconfirmed");
    expect(c.inventory.control().error).toBe("service-owner-inventory-unconfirmed");
    expect(c.write.claimWrite("main", "auto", { kind: "turn", label: "changed" }).ok).toBe(false);
  });
});
