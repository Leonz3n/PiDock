import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PiSessionChannel } from "../main/pi-session.js";
import { ExperimentalServiceExecution, type ServiceExecutionCheckpoint, type ServiceExecutionRecoveryPort } from "./service-execution-experiment.js";
import type { SupervisorResult, SupervisorSession } from "./service-supervisor-experiment.js";
import { TaskWriteCoordinator } from "./write-coordination.js";

const taskId = "task-lifecycle", serviceId = "service-a";
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function driver() {
  const end = deferred<SupervisorResult>();
  const session: SupervisorSession = { pid: 11, supervisorPid: 12, completion: end.promise,
    stop: vi.fn(async () => { const result = { event: "stopped" } as const; end.resolve(result); return result; }),
    disconnect: async () => ({ event: "unconfirmed" }) };
  return { session, end };
}
function memoryRecovery(initial?: unknown) {
  let saved = initial;
  const records: ServiceExecutionCheckpoint[] = [];
  const port: ServiceExecutionRecoveryPort = { read: () => saved, write: vi.fn((record) => { saved = structuredClone(record); records.push(structuredClone(record)); return undefined; }) };
  return { port, records, read: () => saved };
}
function setup(permission: "default" | "auto" = "auto", recovery = memoryRecovery()) {
  const d = driver(), start = vi.fn(async (_signal?: AbortSignal) => d.session), persist = vi.fn();
  const channel = new PiSessionChannel({ taskId, taskDir: `/test/${taskId}`, sessionId: "main", permission, providerId: "local", model: "test" });
  const write: TaskWriteCoordinator = new TaskWriteCoordinator(() => execution.resources());
  const execution: ExperimentalServiceExecution = new ExperimentalServiceExecution({ taskId, serviceId, taskDir: `/test/${taskId}`, revision: () => "config-1", write, start, recovery: recovery.port });
  const control = (signal?: AbortSignal, approvalId?: string) => execution.control({ channel, sessionId: "main", action: "start", persist, signal, approvalId });
  return { ...d, start, persist, channel, write, execution, recovery, control };
}
async function approve(f: ReturnType<typeof setup>) {
  const asked = await f.control();
  if (asked.ok) throw Error("expected approval");
  const id = asked.error.split(":")[1]; f.channel.approve(id); return id;
}
const saved = (state: ServiceExecutionCheckpoint["state"], ownerSessionId: string | null = "main"): ServiceExecutionCheckpoint => ({ schemaVersion: 1, taskId, serviceId, state, ownerSessionId });

it("cancels before approval/claim and seals control immediately when closing", async () => {
  const f = setup("default"), abort = new AbortController(); abort.abort();
  expect(await f.control(abort.signal)).toEqual({ ok: false, error: "service-operation-cancelled" });
  const closing = f.execution.close();
  expect(await f.control()).toEqual({ ok: false, error: "service-host-closing" });
  expect(await closing).toEqual({ ok: true, state: "stopped" });
  expect(f.channel.snapshot().approvals).toEqual([]); expect(f.start).not.toHaveBeenCalled();
  expect(f.recovery.records).toEqual([]); expect(f.write.owner).toBeNull();
});
it("invalidates newly minted confirmations when cancelled during saving, even if approved meanwhile", async () => {
  for (const approved of [false, true]) {
    const f = setup("default"), abort = new AbortController(), persisted = deferred<void>();
    f.persist.mockImplementation(() => persisted.promise);
    const operation = f.control(abort.signal), id = f.channel.snapshot().approvals[0].id;
    if (approved) f.channel.approve(id);
    abort.abort(); persisted.resolve();
    expect(await operation).toEqual({ ok: false, error: "service-operation-cancelled" });
    const row = f.channel.snapshot().approvals[0];
    if (approved) expect(row.consumedAt).toBeDefined(); else expect(row.status).toBe("rejected");
    expect(f.persist).toHaveBeenCalledTimes(2);
    expect((await f.control(undefined, id)).ok).toBe(false); expect(f.start).not.toHaveBeenCalled();
  }
});
it("rechecks cancellation and shutdown after persisted approval spend without executing", async () => {
  for (const mode of ["cancel", "close"] as const) {
    const f = setup("default"), id = await approve(f), abort = new AbortController(), persisted = deferred<void>();
    f.persist.mockImplementation(() => persisted.promise);
    const operation = f.control(abort.signal, id);
    expect(f.channel.snapshot().approvals[0].consumedAt).toBeDefined(); expect(f.write.owner).toBe("main");
    let closing: Promise<unknown> | undefined;
    if (mode === "cancel") abort.abort(); else closing = f.execution.close();
    persisted.resolve();
    expect(await operation).toMatchObject({ ok: false, error: mode === "cancel" ? "service-operation-cancelled" : "service-host-closing" });
    if (closing) expect(await closing).toEqual({ ok: true, state: "stopped" });
    expect(f.start).not.toHaveBeenCalled(); expect(f.recovery.records).toEqual([]); expect(f.write.owner).toBeNull();
  }
});
it("cleans a late ready session after cancellation while retaining the write claim", async () => {
  const f = setup(), ready = deferred<SupervisorSession>(), stopped = deferred<SupervisorResult>(), abort = new AbortController();
  f.start.mockImplementation(() => ready.promise); vi.mocked(f.session.stop).mockImplementation(() => stopped.promise);
  const operation = f.control(abort.signal); abort.abort();
  expect(f.execution.snapshot().state).toBe("starting"); ready.resolve(f.session);
  await Promise.resolve(); await Promise.resolve();
  expect(f.execution.snapshot()).toMatchObject({ state: "stopping", busy: true }); expect(f.write.owner).toBe("main");
  expect(f.session.stop).toHaveBeenCalledTimes(1); expect(f.execution.resources()).toHaveLength(1);
  stopped.resolve({ event: "stopped" });
  expect(await operation).toEqual({ ok: false, error: "service-operation-cancelled" });
  expect(f.execution.snapshot()).toMatchObject({ state: "stopped", ownerSessionId: null });
  expect(f.write.owner).toBeNull(); expect(f.recovery.read()).toEqual(saved("stopped", null));
});
it("retains uncertain cancelled launches and never reports safe shutdown or restarts", async () => {
  const f = setup(), ready = deferred<SupervisorSession>(), abort = new AbortController();
  f.start.mockImplementation(() => ready.promise); vi.mocked(f.session.stop).mockResolvedValue({ event: "unconfirmed" });
  const operation = f.control(abort.signal); abort.abort(); ready.resolve(f.session);
  expect(await operation).toEqual({ ok: false, error: "service-cancelled-unconfirmed" });
  expect(f.recovery.read()).toEqual(saved("unconfirmed")); expect(f.execution.resources()).toHaveLength(1);
  expect(await f.execution.close()).toEqual({ ok: false, error: "service-termination-unconfirmed" });
  expect((await f.control()).ok).toBe(false); expect(f.start).toHaveBeenCalledTimes(1); expect(f.session.stop).toHaveBeenCalledTimes(1);
});
it("waits for in-flight start then drains exactly once before a safe close report", async () => {
  const f = setup(), ready = deferred<SupervisorSession>(), stopped = deferred<SupervisorResult>();
  f.start.mockImplementation(() => ready.promise); vi.mocked(f.session.stop).mockImplementation(() => stopped.promise);
  const operation = f.control(), closing = f.execution.close();
  expect(f.execution.close()).toBe(closing); expect(f.session.stop).not.toHaveBeenCalled();
  expect(f.execution.snapshot()).toMatchObject({ closing: true, busy: true }); ready.resolve(f.session);
  expect(await operation).toEqual({ ok: false, error: "service-host-closing" });
  await Promise.resolve();
  expect(f.session.stop).toHaveBeenCalledTimes(1); expect(f.write.owner).toBe("main");
  let completed = false; void closing.then(() => { completed = true; }); await Promise.resolve(); expect(completed).toBe(false);
  stopped.resolve({ event: "stopped" });
  expect(await closing).toEqual({ ok: true, state: "stopped" });
  expect(f.write.owner).toBeNull(); expect(f.execution.resources()).toEqual([]);
});
it("does not duplicate an already pending authorized stop during close", async () => {
  const f = setup(); await f.control(); const stop = deferred<SupervisorResult>();
  vi.mocked(f.session.stop).mockImplementation(() => stop.promise);
  const operation = f.execution.control({ channel: f.channel, sessionId: "main", action: "stop", persist: f.persist });
  const closing = f.execution.close(); stop.resolve({ event: "stopped" });
  expect((await operation).ok).toBe(true); expect(await closing).toEqual({ ok: true, state: "stopped" });
  expect(f.session.stop).toHaveBeenCalledTimes(1);
});
it("unknown or rejected shutdown keeps ownership and caches failure without blind retry", async () => {
  for (const reject of [false, true]) {
    const f = setup(); await f.control();
    if (reject) vi.mocked(f.session.stop).mockRejectedValue(Error("synthetic-private-error"));
    else vi.mocked(f.session.stop).mockResolvedValue({ event: "unconfirmed" });
    const closing = f.execution.close();
    expect(await closing).toEqual({ ok: false, error: "service-termination-unconfirmed" });
    expect(f.execution.close()).toBe(closing); expect(f.execution.resources()).toHaveLength(1);
    expect(f.recovery.read()).toEqual(saved("unconfirmed")); expect(f.session.stop).toHaveBeenCalledTimes(1);
    expect(f.write.owner).toBeNull();
  }
});
it("writes starting ahead of spawn and checkpoints real completion without process/config data", async () => {
  const f = setup(); f.start.mockImplementation(async () => {
    expect(f.recovery.read()).toEqual(saved("starting")); return f.session;
  });
  await f.control(); expect(f.recovery.records.map((row) => row.state)).toEqual(["starting", "running"]);
  f.end.resolve({ event: "exit", code: 3 }); await Promise.resolve();
  expect(f.recovery.read()).toEqual(saved("exited", null)); expect(f.execution.resources()).toEqual([]);
  expect(Object.keys(f.recovery.records[0]).sort()).toEqual(["ownerSessionId", "schemaVersion", "serviceId", "state", "taskId"]);
});
it("refuses spawn after a possibly written checkpoint failure and quarantines reopen", async () => {
  const recovery = memoryRecovery(); const write = recovery.port.write;
  recovery.port.write = (record) => { write(record); throw Error("synthetic-sensitive-disk-error"); };
  const f = setup("auto", recovery);
  expect(await f.control()).toEqual({ ok: false, error: "service-recovery-persistence-failed" });
  expect(f.start).not.toHaveBeenCalled(); expect(f.execution.snapshot().state).toBe("unconfirmed");
  const reopened = setup("auto", recovery);
  expect(reopened.execution.snapshot().state).toBe("unconfirmed"); expect((await reopened.control()).ok).toBe(false);
  expect(reopened.start).not.toHaveBeenCalled();
});
it("cleans owned sessions when running checkpoint fails but never reports start success", async () => {
  for (const terminalFailure of [false, true]) {
    const recovery = memoryRecovery(); const write = recovery.port.write;
    recovery.port.write = (record) => {
      if (record.state === "running" || terminalFailure && record.state === "stopped") throw Error("synthetic-private-error");
      return write(record);
    };
    const f = setup("auto", recovery);
    expect(await f.control()).toEqual({ ok: false, error: "service-recovery-persistence-failed" });
    expect(f.session.stop).toHaveBeenCalledTimes(1);
    expect(f.execution.snapshot().state).toBe(terminalFailure ? "unconfirmed" : "stopped");
    expect((await f.execution.close()).ok).toBe(!terminalFailure);
  }
});
it("does not report safe shutdown if terminal checkpoint cannot be acknowledged", async () => {
  const f = setup(); await f.control();
  f.recovery.port.write = () => { throw Error("synthetic-sensitive-store-error"); };
  expect((await f.execution.close()).ok).toBe(false);
  expect(f.execution.snapshot()).toMatchObject({ state: "unconfirmed", ownerSessionId: "main" });
  expect(f.execution.resources()).toHaveLength(1); expect(f.recovery.read()).toEqual(saved("running"));
});
it("reopens every interrupted state as unconfirmed, without replay/adoption or PID-based stopping", async () => {
  for (const state of ["starting", "running", "stopping", "unconfirmed"] as const) {
    const f = setup("default", memoryRecovery(saved(state)));
    expect(f.execution.snapshot()).toMatchObject({ state: "unconfirmed", ownerSessionId: "main" });
    expect(await f.control()).toEqual({ ok: false, error: "service-termination-unconfirmed" });
    expect((await f.execution.close()).ok).toBe(false);
    expect(f.start).not.toHaveBeenCalled(); expect(f.session.stop).not.toHaveBeenCalled(); expect(f.channel.snapshot().approvals).toEqual([]);
    expect(f.write.claimWrite("main", "auto", { kind: "turn", label: "original owner" }).ok).toBe(false);
    expect(f.write.claimWrite("other", "auto", { kind: "turn", label: "other" }).ok).toBe(false);
  }
});
it("reopens clean states without automatic start and requires a fresh explicit confirmation", async () => {
  for (const state of ["stopped", "exited"] as const) {
    const f = setup("default", memoryRecovery(saved(state, null)));
    expect(f.execution.snapshot().state).toBe(state); expect(f.start).not.toHaveBeenCalled();
    const id = await approve(f); expect(f.start).not.toHaveBeenCalled();
    expect((await f.control(undefined, id)).ok).toBe(true);
  }
});
it("rejects malformed, foreign and PID/path/config-bearing recovery records", () => {
  for (const record of [null, {}, { ...saved("running"), taskId: "other" }, { ...saved("running"), serviceId: "other" },
    saved("running", null), saved("stopped"), { ...saved("running"), pid: 99 }, { ...saved("running"), env: { KEY: "synthetic-private-value" } },
    { ...saved("running"), state: "healthy" }, { ...saved("running"), ownerSessionId: "x".repeat(2049) }]) {
    expect(() => setup("auto", memoryRecovery(record))).toThrow("invalid-service-recovery");
  }
  const recovery = memoryRecovery(); recovery.port.read = () => { throw Error("synthetic-private-path"); };
  expect(() => setup("auto", recovery)).toThrow("invalid-service-recovery");
});
it("does not stop or write an ownerless in-flight record after natural exit during approval saving", async () => {
  for (const terminal of [{ event: "exit", code: 3 }, { event: "unconfirmed" }] as const) {
    const f = setup("default"), startId = await approve(f); await f.control(undefined, startId);
    const call = (approvalId?: string) => f.execution.control({ channel: f.channel, sessionId: "main", action: "stop", approvalId, persist: f.persist });
    const asked = await call(); if (asked.ok) throw Error(); const stopId = asked.error.split(":")[1]; f.channel.approve(stopId);
    const persisted = deferred<void>(); f.persist.mockImplementation(() => persisted.promise);
    const stop = call(stopId); f.end.resolve(terminal); await Promise.resolve(); persisted.resolve();
    expect(await stop).toEqual(terminal.event === "exit" ? { ok: true, state: "exited" } : { ok: false, error: "service-termination-unconfirmed" });
    expect(f.session.stop).not.toHaveBeenCalled();
    expect(f.recovery.read()).toEqual(terminal.event === "exit" ? saved("exited", null) : saved("unconfirmed"));
  }
});
it("checks cancellation again after write-ahead saving and records the never-spawned attempt safely", async () => {
  const recovery = memoryRecovery(), write = recovery.port.write, abort = new AbortController();
  recovery.port.write = (record) => { const ack = write(record); if (record.state === "starting") abort.abort(); return ack; };
  const f = setup("auto", recovery);
  expect(await f.control(abort.signal)).toEqual({ ok: false, error: "service-operation-cancelled" });
  expect(f.start).not.toHaveBeenCalled(); expect(f.session.stop).not.toHaveBeenCalled();
  expect(f.recovery.records.map((row) => row.state)).toEqual(["starting", "stopped"]);
  expect(f.execution.resources()).toEqual([]); expect((await f.execution.close()).ok).toBe(true);
});
it("ignores a former run's late completion after a new generation owns the service", async () => {
  const f = setup(); await f.control(); vi.mocked(f.session.stop).mockResolvedValue({ event: "stopped" });
  await f.execution.control({ channel: f.channel, sessionId: "main", action: "stop", persist: f.persist });
  const next = driver(); f.start.mockResolvedValue(next.session); await f.control();
  f.end.resolve({ event: "unconfirmed" }); await Promise.resolve();
  expect(f.execution.snapshot().state).toBe("running"); expect(f.recovery.read()).toEqual(saved("running"));
  next.end.resolve({ event: "exit", code: 0 }); await Promise.resolve();
  expect(f.execution.snapshot().state).toBe("exited");
});

it("never reports a durable close acknowledgement without a recovery store", async () => {
  const d = driver();
  const execution = new ExperimentalServiceExecution({ taskId, serviceId, taskDir: `/test/${taskId}`, revision: () => "config-1", write: new TaskWriteCoordinator(), start: async () => d.session });
  expect(await execution.close()).toEqual({ ok: false, error: "service-recovery-unavailable" });
  expect(d.session.stop).not.toHaveBeenCalled();
});

const dirs: string[] = [];
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });
it("uses a real disk checkpoint across a fresh controller without storing launch data", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pidock-service-recovery-")); dirs.push(directory);
  const file = join(directory, "checkpoint.json"); let exists = false;
  const recovery = memoryRecovery(); recovery.port = {
    read: () => exists ? JSON.parse(readFileSync(file, "utf8")) : undefined,
    write: (record) => { writeFileSync(file, JSON.stringify(record), { mode: 0o600, flush: true }); exists = true; return undefined; },
  };
  const live = setup("auto", recovery); await live.control();
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(saved("running"));
  const reopened = setup("auto", recovery); expect(reopened.execution.snapshot().state).toBe("unconfirmed");
  expect((await reopened.control()).ok).toBe(false); expect(reopened.start).not.toHaveBeenCalled();
  expect(await live.execution.close()).toEqual({ ok: true, state: "stopped" });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(saved("stopped", null));
  expect(setup("default", recovery).execution.snapshot().state).toBe("stopped");
});
