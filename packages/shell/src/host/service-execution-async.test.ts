import { expect, it, vi } from "vitest";
import { PiSessionChannel } from "../main/pi-session.js";
import { ExperimentalServiceExecution, type ServiceExecutionCheckpoint, type ServiceExecutionRecoveryPort } from "./service-execution-experiment.js";
import type { SupervisorResult, SupervisorSession } from "./service-supervisor-experiment.js";
import { TaskWriteCoordinator } from "./write-coordination.js";
const taskId = "task-async", serviceId = "service-a";
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
const record = (state: ServiceExecutionCheckpoint["state"], ownerSessionId: string | null = "main"): ServiceExecutionCheckpoint => ({ schemaVersion: 1, taskId, serviceId, state, ownerSessionId });
function setup() {
  const completion = deferred<SupervisorResult>();
  const session: SupervisorSession = { pid: 11, supervisorPid: 12, completion: completion.promise, stop: vi.fn(async () => ({ event: "stopped" } as const)), disconnect: async () => ({ event: "unconfirmed" }) };
  let saved: unknown, revision = "config-1";
  const writes: { record: ServiceExecutionCheckpoint; ack: ReturnType<typeof deferred<undefined>> }[] = [];
  const recovery: ServiceExecutionRecoveryPort = { read: () => saved, write: (value) => {
    const ack = deferred<undefined>(); writes.push({ record: structuredClone(value), ack });
    return ack.promise.then(() => { saved = value; return undefined; });
  } };
  const start = vi.fn(async () => session);
  const channel = new PiSessionChannel({ taskId, taskDir: "/test/task-async", sessionId: "main", permission: "auto", providerId: "local", model: "test" });
  const write: TaskWriteCoordinator = new TaskWriteCoordinator(() => execution.resources());
  const execution: ExperimentalServiceExecution = new ExperimentalServiceExecution({ taskId, taskDir: "/test/task-async", serviceId, revision: () => revision, start, write, recovery });
  const control = (action: "start" | "stop" = "start", signal?: AbortSignal) => execution.control({ channel, sessionId: "main", action, signal, persist: () => {} });
  const ack = async (index: number, state: string) => {
    await vi.waitFor(() => expect(writes[index]?.record.state).toBe(state)); writes[index].ack.resolve(undefined);
  };
  const run = async () => { const operation = control(); await ack(0, "starting"); await ack(1, "running"); expect((await operation).ok).toBe(true); };
  return { execution, writes, ack, control, run, start, session, completion, channel, write, saved: () => saved, changeRevision: () => { revision = "config-2"; } };
}
it("awaits starting and running durable acks while holding the claim", async () => {
  const f = setup(), operation = f.control(); let settled = false; void operation.then(() => { settled = true; });
  await vi.waitFor(() => expect(f.writes).toHaveLength(1));
  expect(f.start).not.toHaveBeenCalled(); expect(f.write.owner).toBe("main"); expect(settled).toBe(false);
  expect(await f.control()).toEqual({ ok: false, error: "service-operation-in-flight" });
  await f.ack(0, "starting"); await vi.waitFor(() => expect(f.writes).toHaveLength(2));
  expect(f.start).toHaveBeenCalledTimes(1); expect(settled).toBe(false); expect(f.execution.snapshot().state).toBe("starting");
  await f.ack(1, "running"); expect(await operation).toEqual({ ok: true, state: "running" }); expect(f.write.owner).toBeNull();
});
it("rejects possibly saved starting ack failures without launching or retrying", async () => {
  const f = setup(), operation = f.control(); await vi.waitFor(() => expect(f.writes).toHaveLength(1));
  f.writes[0].ack.reject(Error("synthetic-private-store-error"));
  expect(await operation).toEqual({ ok: false, error: "service-recovery-persistence-failed" });
  expect(f.start).not.toHaveBeenCalled(); expect(f.execution.snapshot().state).toBe("unconfirmed");
  expect((await f.control()).ok).toBe(false); expect((await f.execution.close()).ok).toBe(false); expect(f.writes).toHaveLength(1);
});
it("checks cancel, close, permission and fingerprint after write-ahead ack with zero spawn", async () => {
  for (const mode of ["cancel", "close", "permission", "revision"] as const) {
    const f = setup(), abort = new AbortController(), operation = f.control("start", abort.signal);
    await vi.waitFor(() => expect(f.writes).toHaveLength(1)); let close: Promise<unknown> | undefined;
    if (mode === "cancel") abort.abort(); if (mode === "close") close = f.execution.close();
    if (mode === "permission") f.channel.setPermission("read"); if (mode === "revision") f.changeRevision();
    await f.ack(0, "starting"); await vi.waitFor(() => expect(f.writes).toHaveLength(2));
    expect(f.start).not.toHaveBeenCalled(); expect(f.write.owner).toBe("main");
    await f.ack(1, "stopped"); expect(await operation).toMatchObject({ ok: false });
    if (close) expect(await close).toEqual({ ok: true, state: "stopped" });
    expect(f.saved()).toEqual(record("stopped", null)); expect(f.write.owner).toBeNull();
  }
});
it("serializes natural terminal behind pending running ack and does not deliver stale running", async () => {
  const f = setup(), operation = f.control(); await f.ack(0, "starting");
  await vi.waitFor(() => expect(f.writes).toHaveLength(2)); f.completion.resolve({ event: "exit", code: 3 });
  await Promise.resolve(); expect(f.writes).toHaveLength(2); expect(f.execution.resources()[0].verificationRequired).toBe(true);
  await f.ack(1, "running"); await vi.waitFor(() => expect(f.writes).toHaveLength(3));
  expect(f.write.owner).toBe("main"); await f.ack(2, "exited");
  expect(await operation).toEqual({ ok: true, state: "exited" }); expect(f.saved()).toEqual(record("exited", null));
});
it("holds verification gate and waits close until a natural terminal durable ack", async () => {
  const f = setup(); await f.run(); f.completion.resolve({ event: "exit", code: 0 });
  await vi.waitFor(() => expect(f.writes).toHaveLength(3));
  expect(f.write.claimWrite("main", "auto", { kind: "turn", label: "old owner" }).ok).toBe(false);
  expect(await f.control()).toEqual({ ok: false, error: "service-operation-in-flight" });
  const closing = f.execution.close(); let closed = false; void closing.then(() => { closed = true; }); await Promise.resolve(); expect(closed).toBe(false);
  await f.ack(2, "exited"); expect(await closing).toEqual({ ok: true, state: "exited" }); expect(f.session.stop).not.toHaveBeenCalled();
});
it("retains ownership on terminal ack failure and refuses safe close or new writes", async () => {
  const f = setup(); await f.run(); f.completion.resolve({ event: "exit", code: 0 });
  await vi.waitFor(() => expect(f.writes).toHaveLength(3)); f.writes[2].ack.reject(Error("synthetic-private-error"));
  await vi.waitFor(() => expect(f.execution.snapshot().state).toBe("unconfirmed"));
  expect(f.execution.snapshot().ownerSessionId).toBe("main"); expect((await f.execution.close()).ok).toBe(false);
  expect(f.saved()).toEqual(record("running")); expect(f.writes).toHaveLength(3);
});
it("cleans an owned session after running ack failure but does not retry fenced persistence", async () => {
  const f = setup(), operation = f.control(); await f.ack(0, "starting");
  await vi.waitFor(() => expect(f.writes).toHaveLength(2)); f.writes[1].ack.reject(Error("synthetic-private-error"));
  expect(await operation).toEqual({ ok: false, error: "service-recovery-persistence-failed" });
  expect(f.session.stop).toHaveBeenCalledTimes(1); expect(f.execution.snapshot().state).toBe("unconfirmed"); expect(f.writes).toHaveLength(2);
});
it("rechecks stop authorization after stopping ack and restores the owned running record without stopping", async () => {
  for (const mode of ["cancel", "permission", "revision"] as const) {
    const f = setup(); await f.run(); const abort = new AbortController(), operation = f.control("stop", abort.signal);
    await vi.waitFor(() => expect(f.writes).toHaveLength(3));
    if (mode === "cancel") abort.abort(); if (mode === "permission") f.channel.setPermission("read"); if (mode === "revision") f.changeRevision();
    await f.ack(2, "stopping"); await f.ack(3, "running"); expect((await operation).ok).toBe(false);
    expect(f.session.stop).not.toHaveBeenCalled(); expect(f.saved()).toEqual(record("running"));
  }
});
it("does not overwrite natural completion with stopping or cancellation rollback", async () => {
  const f = setup(); await f.run(); const abort = new AbortController(), operation = f.control("stop", abort.signal);
  await vi.waitFor(() => expect(f.writes).toHaveLength(3)); f.completion.resolve({ event: "exit", code: 3 }); abort.abort();
  await f.ack(2, "stopping"); await f.ack(3, "exited"); expect((await operation).ok).toBe(false);
  expect(f.saved()).toEqual(record("exited", null)); expect(f.writes).toHaveLength(4); expect(f.session.stop).not.toHaveBeenCalled();
});
it("deduplicates completion and stop receipts and waits terminal ack during close", async () => {
  const f = setup(); await f.run(); vi.mocked(f.session.stop).mockImplementation(async () => { f.completion.resolve({ event: "stopped" }); return { event: "stopped" }; });
  const closing = f.execution.close(); expect(f.execution.close()).toBe(closing);
  await f.ack(2, "stopping"); await vi.waitFor(() => expect(f.writes).toHaveLength(4));
  expect(f.write.owner).toBe("main"); await f.ack(3, "stopped"); expect(await closing).toEqual({ ok: true, state: "stopped" });
  expect(f.writes.map((row) => row.record.state)).toEqual(["starting", "running", "stopping", "stopped"]); expect(f.session.stop).toHaveBeenCalledTimes(1);
});
it("cleans cancellation during running ack only after acknowledgement and retains claim through terminal save", async () => {
  const f = setup(), abort = new AbortController(), operation = f.control("start", abort.signal);
  await f.ack(0, "starting"); await vi.waitFor(() => expect(f.writes).toHaveLength(2)); abort.abort();
  expect(f.session.stop).not.toHaveBeenCalled(); expect(f.write.owner).toBe("main");
  await f.ack(1, "running"); await f.ack(2, "stopping"); await vi.waitFor(() => expect(f.writes).toHaveLength(4));
  expect(f.session.stop).toHaveBeenCalledTimes(1); expect(f.write.owner).toBe("main");
  await f.ack(3, "stopped"); expect(await operation).toEqual({ ok: false, error: "service-operation-cancelled" });
  expect(f.saved()).toEqual(record("stopped", null)); expect(f.write.owner).toBeNull();
});
it("ignores an old completion after terminal ack and a new generation's async start", async () => {
  const f = setup(); await f.run(); const stopping = f.control("stop"); await f.ack(2, "stopping"); await f.ack(3, "stopped"); await stopping;
  const nextCompletion = deferred<SupervisorResult>(), next = { ...f.session, completion: nextCompletion.promise }; f.start.mockResolvedValue(next);
  const start = f.control(); await f.ack(4, "starting"); await f.ack(5, "running"); expect((await start).ok).toBe(true);
  f.completion.resolve({ event: "unconfirmed" }); await Promise.resolve(); await Promise.resolve();
  expect(f.writes).toHaveLength(6); expect(f.execution.snapshot().state).toBe("running"); expect(f.saved()).toEqual(record("running"));
  nextCompletion.resolve({ event: "exit", code: 0 }); await f.ack(6, "exited");
  await vi.waitFor(() => expect(f.execution.snapshot().state).toBe("exited"));
});
it("bootstraps asynchronously without exposing a default stopped controller, rechecks lease and rejects corrupt reads", async () => {
  for (const mode of ["clean", "interrupted", "invalid", "rejected", "revoked"] as const) {
    const read = deferred<unknown>(), start = vi.fn(async () => { throw Error("no-launch"); }); let revoked = false;
    const opening = ExperimentalServiceExecution.create({ taskId, serviceId, taskDir: "/test", revision: () => { if (revoked) throw Error("private-lease-error"); return "config"; },
      write: new TaskWriteCoordinator(), start, recovery: { read: () => read.promise, write: async () => undefined } });
    let settled = false; void opening.then(() => { settled = true; }, () => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false);
    if (mode === "rejected") read.reject(Error("private-error"));
    else { if (mode === "revoked") revoked = true; read.resolve(mode === "invalid" ? { ...record("running"), pid: 1 } : mode === "interrupted" ? record("running") : undefined); }
    if (["invalid", "rejected", "revoked"].includes(mode)) await expect(opening).rejects.toThrow("invalid-service-recovery");
    else { const execution = await opening; expect(execution.snapshot().state).toBe(mode === "clean" ? "stopped" : "unconfirmed"); }
    expect(start).not.toHaveBeenCalled();
  }
});
