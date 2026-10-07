import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PiSessionChannel } from "../main/pi-session.js";
import { ExperimentalServiceExecution, type ManagedServiceBinding, type ServiceOwnerIdentity, type ServiceOwnerLaunch, type ServiceOwnerLease, type ServiceOwnerReceipt, type ServiceOwnerSession } from "./service-execution-experiment.js";
import { launchSupervisorExperiment, type SupervisorResult, type SupervisorSession } from "./service-supervisor-experiment.js";
import { TaskWriteCoordinator } from "./write-coordination.js";

const taskId = "task-execution", taskDir = "/test/task-execution", serviceId = "service-a";
function channel(permission: "read" | "default" | "auto" = "default", sessionId = "main", ownTaskId = taskId) {
  return new PiSessionChannel({ taskId: ownTaskId, taskDir: `/test/${ownTaskId}`, sessionId, permission, providerId: "local", model: "test" });
}
function driver() {
  let finish: (result: SupervisorResult) => void = () => {};
  const completion = new Promise<SupervisorResult>((resolve) => { finish = resolve; });
  const session: SupervisorSession = { pid: 1, supervisorPid: 2, completion,
    stop: vi.fn(async () => { finish({ event: "stopped" }); return { event: "stopped" }; }),
    disconnect: async () => ({ event: "unconfirmed" }) };
  return { session, finish };
}
function setup(permission: "read" | "default" | "auto" = "default", available = true, ownTaskId = taskId) {
  const d = driver(), c = channel(permission, "main", ownTaskId), start = vi.fn(async () => d.session), persist = vi.fn();
  let revision = "config-1";
  const write: TaskWriteCoordinator = new TaskWriteCoordinator(() => execution.resources());
  const execution: ExperimentalServiceExecution = new ExperimentalServiceExecution({ taskId: ownTaskId, taskDir: `/test/${ownTaskId}`, serviceId, revision: () => revision, write, ...(available ? { start } : {}) });
  const control = (action: "start" | "stop" = "start", approvalId?: string) => execution.control({ channel: c, sessionId: "main", action, approvalId, persist });
  return { ...d, c, start, persist, write, execution, control, revise: () => { revision = "config-2"; } };
}
async function approve(f: ReturnType<typeof setup>, action: "start" | "stop" = "start") {
  const result = await f.control(action);
  if (result.ok || !result.error.startsWith("approval-required:")) throw Error("expected approval");
  const id = result.error.split(":")[1]; f.c.approve(id); return id;
}

it("refuses sealed auto channel before experimental claims or dispatch", async () => {
  const f = setup("auto"), before = f.write.snapshot(); f.c.sealExecution();
  expect(await f.control()).toEqual({ ok: false, error: "task-host-closing" });
  expect(f.write.snapshot()).toEqual(before); expect(f.start).not.toHaveBeenCalled(); expect(f.execution.snapshot().state).toBe("stopped");
});
it("does not dispatch after the channel seals during approved persistence", async () => {
  const f = setup(), id = await approve(f); let release!: () => void;
  f.persist.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
  const pending = f.control("start", id); await vi.waitFor(() => expect(release).toBeDefined()); f.c.sealExecution(); release();
  expect(await pending).toEqual({ ok: false, error: "task-host-closing" });
  expect(f.start).not.toHaveBeenCalled(); expect(f.write.owner).toBeNull(); expect(f.execution.snapshot().state).toBe("stopped");
});
it("refuses absent executor before minting approvals or changing state", async () => {
  const f = setup("default", false);
  expect(await f.control()).toEqual({ ok: false, error: "service-execution-unavailable" });
  expect(f.c.snapshot().approvals).toEqual([]); expect(f.write.owner).toBeNull();
  expect(f.execution.snapshot()).toMatchObject({ state: "stopped", busy: false });
});
it("denies read-only, wrong session and foreign task without execution", async () => {
  const f = setup("read");
  expect((await f.control()).ok).toBe(false);
  const wrong = channel("auto", "other");
  expect(await f.execution.control({ channel: wrong, sessionId: "main", action: "start", persist: f.persist })).toMatchObject({ error: "service-caller-mismatch" });
  const foreign = new PiSessionChannel({ taskId: "foreign", taskDir, sessionId: "main", providerId: "local", model: "test", permission: "auto" });
  expect(await f.execution.control({ channel: foreign, sessionId: "main", action: "start", persist: f.persist })).toMatchObject({ error: "service-caller-mismatch" });
  expect(f.start).not.toHaveBeenCalled(); expect(f.c.snapshot().approvals).toEqual([]);
});
it("requires approved action/config-bound confirmation, persists spend before execution, and refuses replay", async () => {
  const f = setup();
  const id = await approve(f);
  const approval = f.c.snapshot().approvals.find((row) => row.id === id);
  expect(approval).toMatchObject({ target: `${taskDir}/services/${serviceId}/start`, contentVersion: "start:config-1", scope: "service-control" });
  const order: string[] = [];
  f.persist.mockImplementation(() => { order.push("persist"); });
  f.start.mockImplementation(async () => { expect(f.c.snapshot().approvals[0].consumedAt).toBeDefined(); order.push("execute"); return f.session; });
  expect(await f.control("start", id)).toEqual({ ok: true, state: "running" });
  expect(order).toEqual(["persist", "execute"]); expect(f.write.owner).toBeNull();
  expect((await f.control("stop", id)).ok).toBe(false); expect(f.session.stop).not.toHaveBeenCalled();
  const stopId = await approve(f, "stop");
  expect(await f.control("stop", stopId)).toMatchObject({ ok: true, state: "stopped" });
  expect((await f.control("start", id)).ok).toBe(false); expect(f.start).toHaveBeenCalledTimes(1);
});
it("does not execute pending/rejected confirmations or stale configuration", async () => {
  for (const mode of ["pending", "rejected", "stale"] as const) {
    const f = setup(); const first = await f.control();
    if (first.ok) throw Error(); const id = first.error.split(":")[1];
    if (mode === "rejected") f.c.reject(id);
    if (mode === "stale") { f.c.approve(id); f.revise(); }
    expect((await f.control("start", id)).ok).toBe(false); expect(f.start).not.toHaveBeenCalled();
    expect(f.execution.snapshot().state).toBe("stopped");
  }
});
it("does not mint or spend while another session holds the write right", async () => {
  const f = setup(); const held = f.write.claimWrite("other", "auto", { kind: "turn", label: "other" });
  expect(held.ok).toBe(true); expect((await f.control()).ok).toBe(false); expect(f.c.snapshot().approvals).toEqual([]);
  if (!held.ok) throw Error(); f.write.releaseWrite(held.claimId);
  const id = await approve(f);
  const again = f.write.claimWrite("other", "auto", { kind: "turn", label: "other" });
  expect(again.ok).toBe(true); expect((await f.control("start", id)).ok).toBe(false);
  expect(f.c.snapshot().approvals[0].consumedAt).toBeUndefined(); expect(f.start).not.toHaveBeenCalled();
});
it("keeps the claim during awaited start and rejects concurrent same-session control", async () => {
  const f = setup("auto"); let release: (session: SupervisorSession) => void = () => {};
  f.start.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  const pending = f.control();
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1));
  expect(f.execution.snapshot()).toMatchObject({ state: "starting", busy: true }); expect(f.write.owner).toBe("main");
  expect(await f.control()).toMatchObject({ error: "service-operation-in-flight" });
  release(f.session); expect(await pending).toMatchObject({ ok: true }); expect(f.write.owner).toBeNull();
  expect(f.start).toHaveBeenCalledTimes(1);
});
it("retains the claim while stop is pending and releases only after its result", async () => {
  const f = setup("auto"); await f.control();
  let finishStop: (result: SupervisorResult) => void = () => {};
  vi.mocked(f.session.stop).mockImplementation(() => new Promise((resolve) => { finishStop = resolve; }));
  const pending = f.control("stop");
  await vi.waitFor(() => expect(f.session.stop).toHaveBeenCalledTimes(1));
  expect(f.execution.snapshot()).toMatchObject({ state: "stopping", busy: true }); expect(f.write.owner).toBe("main");
  expect(await f.control("stop")).toMatchObject({ error: "service-operation-in-flight" });
  finishStop({ event: "stopped" }); expect(await pending).toMatchObject({ ok: true, state: "stopped" });
  expect(f.write.owner).toBeNull(); expect(f.execution.resources()).toEqual([]);
});
it("fails closed on persistence failure and on permission/config changes while persistence yields", async () => {
  for (const mode of ["write-failure", "permission", "config"] as const) {
    const f = setup(); const id = await approve(f);
    f.persist.mockImplementation(() => {
      if (mode === "write-failure") throw Error("sensitive-error");
      if (mode === "permission") f.c.setPermission("read"); else f.revise();
    });
    const result = await f.control("start", id);
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain("sensitive-error");
    expect(f.start).not.toHaveBeenCalled(); expect(f.write.owner).toBeNull();
    expect(f.c.snapshot().approvals[0].consumedAt).toBeDefined(); expect(f.execution.snapshot().state).toBe("stopped");
  }
});
it("does not let a mutable caller request swap actions during approval persistence", async () => {
  const f = setup(); const id = await approve(f);
  let release: () => void = () => {};
  f.persist.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
  const request = { channel: f.c, sessionId: "main", action: "start" as "start" | "stop", approvalId: id, persist: f.persist };
  const pending = f.execution.control(request);
  request.action = "stop"; release();
  expect(await pending).toEqual({ ok: true, state: "running" });
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.session.stop).not.toHaveBeenCalled();
});
it("keeps uncertain start owned, rejects retry and blocks other sessions' writes", async () => {
  const f = setup(); const id = await approve(f);
  f.start.mockRejectedValue(Error("sensitive-start-error"));
  expect(await f.control("start", id)).toEqual({ ok: false, error: "service-start-unconfirmed" });
  expect(f.execution.snapshot()).toMatchObject({ state: "unconfirmed", ownerSessionId: "main", busy: false });
  expect(f.write.owner).toBeNull(); expect(f.execution.resources()).toHaveLength(1);
  expect((await f.control()).ok).toBe(false); expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.write.claimWrite("other", "auto", { kind: "turn", label: "other" }).ok).toBe(false);
});
it("does not turn an unknown stop into success or drop resource ownership", async () => {
  const f = setup("auto"); await f.control();
  vi.mocked(f.session.stop).mockResolvedValue({ event: "unconfirmed" });
  expect(await f.control("stop")).toEqual({ ok: false, error: "service-termination-unconfirmed" });
  expect(f.execution.snapshot().state).toBe("unconfirmed"); expect(f.execution.resources()).toHaveLength(1);
  expect((await f.control()).ok).toBe(false);
});
it("updates from natural termination and permits independent tasks to control concurrently", async () => {
  const a = setup("auto"), b = setup("auto", true, "task-other");
  expect((await Promise.all([a.control(), b.control()])).every((row) => row.ok)).toBe(true);
  a.finish({ event: "exit", code: 3 }); await vi.waitFor(() => expect(a.execution.snapshot().state).toBe("exited"));
  expect(a.execution.snapshot()).toMatchObject({ state: "exited", ownerSessionId: null });
  expect(a.execution.resources()).toEqual([]); expect(b.execution.snapshot().state).toBe("running");
});

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it.skipIf(process.platform !== "darwin")("gates a real supervisor start/stop with separate approvals", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pidock-gated-supervisor-"))); dirs.push(root);
  const cwd = join(root, "app"); mkdirSync(cwd);
  const binary = join(root, "supervisor");
  execFileSync("go", ["build", "-o", binary, "."], { cwd: resolve("native/service-supervisor"), timeout: 30000 });
  const identity = (path: string) => { const stat = statSync(path, { bigint: true }); return { device: stat.dev.toString(), inode: stat.ino.toString() }; };
  let session: SupervisorSession | undefined;
  const c = channel(); const write = new TaskWriteCoordinator();
  const execution = new ExperimentalServiceExecution({ taskId, taskDir, serviceId, revision: () => "real-config-1", write,
    start: async () => { session = await launchSupervisorExperiment(binary, { taskRoot: root, cwd, program: "/bin/sleep", args: ["30"], env: {},
      graceMs: 100, rootIdentity: identity(root), cwdIdentity: identity(cwd) }, { redact: (line) => line, onLine: () => {} }); return session; } });
  const control = (action: "start" | "stop", approvalId?: string) => execution.control({ channel: c, sessionId: "main", action, approvalId, persist: () => {} });
  try {
    const ask = await control("start"); if (ask.ok) throw Error(); const id = ask.error.split(":")[1];
    expect(session).toBeUndefined(); c.approve(id);
    expect((await control("start", id)).ok).toBe(true); expect(session?.pid).toBeGreaterThan(0);
    expect((await control("stop", id)).ok).toBe(false);
    const stop = await control("stop"); if (stop.ok) throw Error(); const stopId = stop.error.split(":")[1]; c.approve(stopId);
    expect(await control("stop", stopId)).toMatchObject({ ok: true });
    expect(execution.snapshot().state).toBe("stopped"); expect(write.owner).toBeNull();
    expect(() => process.kill(session!.pid, 0)).toThrow();
  } finally { await session?.stop(); }
}, 30000);

it("managed class adapter preserves private-field receivers through approval, dispatch and completion", async () => {
  let complete!: (receipt: ServiceOwnerReceipt) => void;
  let identity!: ServiceOwnerIdentity;
  const launch: ServiceOwnerLaunch = { capability: "reviewed-no-child-fixture", program: "/fixed/node", args: ["/fixed/leaf.mjs"], cwd: taskDir,
    env: {}, envRevision: "fixed-env-v1", programSha256: "a".repeat(64), sourceSha256: "b".repeat(64) };
  const lease = { revalidate: vi.fn(), release: vi.fn() };
  class TrustedAdapter implements ManagedServiceBinding {
    workspaceId = "class-fixture";
    #launch = launch;
    #lease: ServiceOwnerLease = lease;
    #session: ServiceOwnerSession = { completion: new Promise((resolve) => { complete = resolve; }), stop: async () => { throw Error("unexpected-stop"); } };
    resolveLaunch() { return this.#launch; }
    acquireLease() { return this.#lease; }
    async start(owner: ServiceOwnerIdentity) { identity = owner; return this.#session; }
  }
  const managed = new TrustedAdapter(), c = channel();
  const write: TaskWriteCoordinator = new TaskWriteCoordinator(() => execution.resources());
  const execution: ExperimentalServiceExecution = new ExperimentalServiceExecution({ taskId, taskDir, serviceId, revision: () => "fixed-v1", write,
    recovery: { read: () => undefined, write: () => undefined }, managed });
  managed.workspaceId = "changed-after-capture";
  managed.resolveLaunch = () => { throw Error("replaced-resolve"); };
  managed.acquireLease = () => { throw Error("replaced-acquire"); };
  managed.start = async () => { throw Error("replaced-start"); };
  const request = (approvalId?: string) => execution.control({ channel: c, sessionId: "main", action: "start", persist: () => {}, approvalId });
  const ask = await request();
  expect(ask).toMatchObject({ ok: false, error: expect.stringMatching(/^approval-required:/), review: { workspaceId: "class-fixture" } });
  if (ask.ok) throw Error("expected-approval");
  const id = ask.error.split(":")[1]; c.approve(id);
  expect(await request(id)).toEqual({ ok: true, state: "running" });
  expect(write.owner).toBe("main");
  complete({ ...identity, capability: launch.capability, programSha256: launch.programSha256, sourceSha256: launch.sourceSha256,
    envRevision: launch.envRevision, event: "exit", code: 0 });
  await vi.waitFor(() => expect(execution.snapshot().state).toBe("exited"));
  expect(write.owner).toBeNull(); expect(lease.release).toHaveBeenCalledTimes(1);
});

it("managed binding refuses throwing or non-callable captured methods before dispatch", () => {
  const start = vi.fn();
  for (const property of ["workspaceId", "resolveLaunch", "acquireLease", "start"]) {
    const managed = { workspaceId: "fixture", resolveLaunch: vi.fn(), acquireLease: vi.fn(), start };
    Object.defineProperty(managed, property, { get: () => { throw Error("unavailable-binding"); } });
    expect(() => new ExperimentalServiceExecution({ taskId, taskDir, serviceId, revision: () => "fixed-v1", write: new TaskWriteCoordinator(),
      recovery: { read: () => undefined, write: () => undefined }, managed })).toThrow("incomplete-service-owner-binding");
  }
  expect(() => new ExperimentalServiceExecution({ taskId, taskDir, serviceId, revision: () => "fixed-v1", write: new TaskWriteCoordinator(),
    recovery: { read: () => undefined, write: () => undefined },
    managed: { workspaceId: "fixture", resolveLaunch: undefined as unknown as ManagedServiceBinding["resolveLaunch"], acquireLease: vi.fn(), start } })).toThrow("incomplete-service-owner-binding");
  expect(start).not.toHaveBeenCalled();
});

it("managed owner keeps task and shared rights until exact native completion and durable ownership fence ack", async () => {
  let complete!: (receipt: import("./service-execution-experiment.js").ServiceOwnerReceipt) => void;
  let acknowledge!: () => void;
  const lease = { revalidate: vi.fn(), release: vi.fn() };
  const c = channel();
  const write = new TaskWriteCoordinator();
  const launch = { capability: "reviewed-no-child-fixture" as const, program: "/fixed/node", args: ["/fixed/leaf.mjs"], cwd: taskDir,
    env: { FIXTURE_VALUE: "synthetic-service-value" }, envRevision: "fixed-env-v1", programSha256: "a".repeat(64), sourceSha256: "b".repeat(64) };
  let identity!: import("./service-execution-experiment.js").ServiceOwnerIdentity;
  const execution = new ExperimentalServiceExecution({ taskId, taskDir, serviceId, revision: () => "fixed-v1", write,
    recovery: { read: () => undefined, write: (record) => record.state === "unconfirmed" ? new Promise<undefined>((resolve) => { acknowledge = () => resolve(undefined); }) : undefined },
    managed: { workspaceId: "service-owner-fixture", resolveLaunch: () => launch, acquireLease: () => lease,
      start: async (owner) => { identity = owner; return { completion: new Promise((resolve) => { complete = resolve; }), stop: async () => ({ ...owner, ...launch, event: "unconfirmed" }) }; } } });
  const request = (approvalId?: string) => execution.control({ channel: c, sessionId: "main", action: "start", persist: () => {}, approvalId });
  const ask = await request(); if (ask.ok) throw Error(); const id = ask.error.split(":")[1];
  expect(ask).toMatchObject({ error: expect.stringMatching(/^approval-required:/) });
  c.approve(id); expect(await request(id)).toEqual({ ok: true, state: "running" });
  expect(write.owner).toBe("main"); expect(lease.release).not.toHaveBeenCalled();
  complete({ ...identity, capability: launch.capability, programSha256: launch.programSha256, sourceSha256: launch.sourceSha256, envRevision: launch.envRevision, event: "exit", code: 0 });
  await vi.waitFor(() => expect(acknowledge).toBeDefined());
  expect(write.owner).toBe("main"); expect(lease.release).not.toHaveBeenCalled();
  acknowledge(); await vi.waitFor(() => expect(execution.snapshot().state).toBe("exited"));
  expect(write.owner).toBeNull(); expect(lease.release).toHaveBeenCalledTimes(1); expect(execution.resources()).toEqual([]);
});
