import { afterEach, expect, it, vi } from "vitest";
import { ExperimentalHostShutdown } from "./host-shutdown-experiment.js";
import { ExperimentalServiceExecution } from "./service-execution-experiment.js";
import type { SupervisorSession } from "./service-supervisor-experiment.js";
import { TaskWriteCoordinator } from "./write-coordination.js";
import { PiSessionChannel } from "../main/pi-session.js";
afterEach(() => vi.useRealTimers());
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function fixture(overrides: Partial<ConstructorParameters<typeof ExperimentalHostShutdown>[0]> = {}) {
  const events: string[] = [];
  const service = { seal: vi.fn(() => { events.push("service-seal"); }), close: vi.fn(async () => { events.push("service-drain"); return { ok: true, state: "stopped" }; }) };
  const persist = vi.fn(async () => { events.push("persist"); return undefined; });
  const coordinator = new ExperimentalHostShutdown({ taskId: "task-a", hostEpoch: "epoch-a", timeoutMs: 10,
    sealSdk: () => { events.push("sdk-seal"); }, shutdownSdk: async () => { events.push("sdk-close"); }, settleTurns: async () => { events.push("turn-settled"); },
    services: [service], verify: () => { events.push("verify"); }, persist, ...overrides });
  return { events, service, persist, coordinator };
}
it("seals synchronously and orders SDK, turns, service and durable acknowledgement", async () => {
  const sdk = deferred<void>(), ack = deferred<undefined>();
  const f = fixture({ timeoutMs: 1000, shutdownSdk: () => sdk.promise, persist: () => ack.promise });
  const first = f.coordinator.close(); expect(f.coordinator.close()).toBe(first); expect(f.events).toEqual(["sdk-seal", "service-seal"]);
  sdk.resolve(); await vi.waitFor(() => expect(f.service.close).toHaveBeenCalledTimes(1), { interval: 1 });
  let settled = false; void first.then(() => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false);
  ack.resolve(undefined); expect(await first).toEqual({ ok: true, report: { schemaVersion: 1, taskId: "task-a", hostEpoch: "epoch-a", status: "closed" } });
  expect(f.events).toEqual(["sdk-seal", "service-seal", "turn-settled", "service-drain", "verify", "verify"]);
});
it("uses the real service controller and holds ownership until terminal and report acks", async () => {
  const terminal = deferred<undefined>(), reportAck = deferred<undefined>(), sdk = deferred<void>();
  const stop = vi.fn(async () => ({ event: "stopped" as const }));
  const session: SupervisorSession = { pid: 1, supervisorPid: 2, stop, disconnect: async () => ({ event: "unconfirmed" }), completion: new Promise(() => {}) };
  const channel = new PiSessionChannel({ taskId: "task-a", taskDir: "/test/task-a", sessionId: "main", permission: "auto", providerId: "local", model: "test" });
  const write: TaskWriteCoordinator = new TaskWriteCoordinator(() => execution.resources());
  const execution: ExperimentalServiceExecution = new ExperimentalServiceExecution({ taskId: "task-a", taskDir: "/test/task-a", serviceId: "service-a", revision: () => "config-1", write, start: async () => session,
    recovery: { read: () => undefined, write: (record) => record.state === "stopped" ? terminal.promise : undefined } });
  expect((await execution.control({ channel, sessionId: "main", action: "start", persist() {} })).ok).toBe(true);
  const persist = vi.fn(() => reportAck.promise), coordinator = new ExperimentalHostShutdown({ taskId: "task-a", hostEpoch: "epoch-a", timeoutMs: 1000, sealSdk() {}, shutdownSdk: () => sdk.promise, settleTurns: async () => {}, services: [execution], verify() {}, persist });
  const closing = coordinator.close(); expect(execution.snapshot().closing).toBe(true); expect(stop).not.toHaveBeenCalled();
  expect((await execution.control({ channel, sessionId: "main", action: "start", persist() {} })).ok).toBe(false);
  sdk.resolve(); await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1)); expect(write.owner).toBe("main"); expect(persist).not.toHaveBeenCalled();
  terminal.resolve(undefined); await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1)); expect(execution.snapshot().ownerSessionId).toBeNull(); expect(write.owner).toBeNull();
  let settled = false; void closing.then(() => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false);
  reportAck.resolve(undefined); expect((await closing).ok).toBe(true);
});
it("attempts service cleanup after SDK failure but never persists a closed report", async () => {
  const f = fixture({ shutdownSdk: async () => { throw Error("synthetic-private-value"); } });
  expect(await f.coordinator.close()).toEqual({ ok: false, error: "host-shutdown-unconfirmed" }); expect(f.service.close).toHaveBeenCalledTimes(1); expect(f.persist).not.toHaveBeenCalled();
});
it.each(["unconfirmed", "running", "starting", "stopping", undefined])("rejects an unsafe service receipt %s", async (state) => {
  const f = fixture({ services: [{ seal() {}, close: async () => ({ ok: true, state }) }] });
  expect((await f.coordinator.close()).ok).toBe(false); expect(f.persist).not.toHaveBeenCalled();
});
it.each(["sdk", "turns", "service", "persist"])("bounds pending %s without late success or retries", async (stage) => {
  vi.useFakeTimers(); const pending = deferred<undefined>(); const work = () => pending.promise;
  const overrides = stage === "sdk" ? { shutdownSdk: work } : stage === "turns" ? { settleTurns: work } : stage === "persist" ? { persist: work } : { services: [{ seal() {}, close: () => pending.promise.then(() => ({ ok: true, state: "stopped" })) }] };
  const f = fixture(overrides), first = f.coordinator.close(); await vi.advanceTimersByTimeAsync(20);
  expect(await first).toEqual({ ok: false, error: "host-shutdown-unconfirmed" }); pending.resolve(undefined); await Promise.resolve();
  expect(f.coordinator.close()).toBe(first); expect((await f.coordinator.close()).ok).toBe(false);
});
it("rechecks lease after ack and retains revoked reports", async () => {
  let checks = 0;
  const f = fixture({ verify: () => { if (++checks === 2) throw Error("lease-revoked"); } });
  expect((await f.coordinator.close()).ok).toBe(false); expect(f.persist).toHaveBeenCalledTimes(1);
});
it("refuses unavailable/invalid persistence and producer seal failures", async () => {
  for (const overrides of [{ persist: async () => true as never }, { sealSdk: () => { throw Error("closed"); } }, { settleTurns: async () => { throw Error("usage-save-failed"); } }]) {
    expect((await fixture(overrides).coordinator.close()).ok).toBe(false);
  }
});
