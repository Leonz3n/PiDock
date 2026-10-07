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

function managedSetup() {
  const completion = deferred<import("./service-execution-experiment.js").ServiceOwnerReceipt>();
  const launch = { capability: "reviewed-no-child-fixture" as const, program: "/fixed/node", args: ["/fixed/leaf.mjs"], cwd: "/test/task-async",
    env: { FIXTURE_VALUE: "synthetic-service-value" }, envRevision: "fixed-env-v1", programSha256: "a".repeat(64), sourceSha256: "b".repeat(64) };
  let identity!: import("./service-execution-experiment.js").ServiceOwnerIdentity;
  const lease = { revalidate: vi.fn(), release: vi.fn() };
  const write: TaskWriteCoordinator = new TaskWriteCoordinator(() => execution.resources());
  let saved: unknown;
  const durableWrite = (record: ServiceExecutionCheckpoint) => { saved = structuredClone(record); return undefined; };
  const recovery = { read: () => saved, write: vi.fn((record: ServiceExecutionCheckpoint): undefined | Promise<undefined> => durableWrite(record)) };
  const start = vi.fn(async (owner: import("./service-execution-experiment.js").ServiceOwnerIdentity) => { identity = owner; return { completion: completion.promise, stop: () => completion.promise }; });
  const channel = new PiSessionChannel({ taskId, taskDir: launch.cwd, sessionId: "main", permission: "default", providerId: "local", model: "test" });
  const execution: ExperimentalServiceExecution = new ExperimentalServiceExecution({ taskId, serviceId, taskDir: launch.cwd, revision: () => "fixed-v1", write, recovery,
    managed: { workspaceId: "service-owner-fixture", resolveLaunch: () => launch, acquireLease: () => lease, start } });
  const control = (approvalId?: string, persist: () => void | Promise<void> = () => {}) => execution.control({ channel, sessionId: "main", action: "start", approvalId, persist });
  const approve = async () => { const asked = await control(); if (asked.ok) throw Error(); expect(asked.error).toMatch(/^approval-required:/); const id = asked.error.split(":")[1]; channel.approve(id); return { id, review: asked.review }; };
  const receipt = (): import("./service-execution-experiment.js").ServiceOwnerReceipt => ({ ...identity, capability: launch.capability,
    sourceSha256: launch.sourceSha256, programSha256: launch.programSha256, envRevision: launch.envRevision, event: "exit", code: 0 });
  const reopen = () => new ExperimentalServiceExecution({ taskId, serviceId, taskDir: launch.cwd, revision: () => "fixed-v1", write: new TaskWriteCoordinator(), recovery,
    managed: { workspaceId: "service-owner-fixture", resolveLaunch: () => launch, acquireLease: () => lease, start } });
  return { completion, launch, lease, write, recovery, durableWrite, reopen, start, channel, execution, control, approve, receipt };
}
it.each(["service", "tool"] as const)("managed service and later tool retain separate rights when %s settles first", async (first) => {
  const f = managedSetup();
  const parent = f.write.claimWrite("main", "default", { kind: "turn", label: "parent" });
  if (!parent.ok) throw Error("expected-parent-claim");
  const { id } = await f.approve();
  expect(await f.control(id)).toEqual({ ok: true, state: "running" });
  f.write.releaseWrite(parent.claimId);
  const tool = f.write.claimWrite("main", "default", { kind: "derived-execution", label: "later tool" });
  if (!tool.ok) throw Error("expected-tool-claim");
  expect(f.write.snapshot().claims).toHaveLength(2);
  const completeService = async () => {
    f.completion.resolve(f.receipt());
    await vi.waitFor(() => expect(f.execution.snapshot().state).toBe("exited"));
  };
  if (first === "service") await completeService();
  else f.write.releaseWrite(tool.claimId);
  expect(f.write.owner).toBe("main");
  expect(f.write.snapshot().claims).toHaveLength(1);
  expect(f.write.claimWrite("other", "auto", { kind: "turn", label: "blocked" })).toMatchObject({ ok: false, verdict: "locked" });
  if (first === "service") f.write.releaseWrite(tool.claimId);
  else await completeService();
  expect(f.write.owner).toBeNull(); expect(f.write.snapshot().claims).toEqual([]);
  expect(f.write.claimWrite("other", "auto", { kind: "turn", label: "next" }).ok).toBe(true);
});

it("managed owner rejects foreign, stale, legacy and extra-field completion proofs while retaining both rights", async () => {
  for (const mode of ["foreign", "stale", "legacy", "extra"] as const) {
    const f = managedSetup(), { id } = await f.approve(); expect((await f.control(id)).ok).toBe(true);
    const value = mode === "foreign" ? { ...f.receipt(), sessionId: "other" } : mode === "stale" ? { ...f.receipt(), generation: 0 }
      : mode === "legacy" ? { event: "exit", code: 0 } : { ...f.receipt(), secret: "private-value" };
    f.completion.resolve(value as import("./service-execution-experiment.js").ServiceOwnerReceipt);
    await vi.waitFor(() => expect(f.execution.snapshot().state).toBe("unconfirmed"));
    expect(f.write.owner).toBe("main"); expect(f.lease.release).not.toHaveBeenCalled(); expect((await f.execution.close()).ok).toBe(false);
  }
});
it("managed owner freezes the review and refuses changed private env, argv or revisions before dispatch", async () => {
  for (const mode of ["env", "argv", "revision"] as const) {
    const f = managedSetup(), { id, review } = await f.approve();
    expect(review).toMatchObject({ workspaceId: "service-owner-fixture", taskId, sessionId: "main", serviceId, configRevision: "fixed-v1", envRevision: "fixed-env-v1", args: ["/fixed/leaf.mjs"] });
    expect(JSON.stringify(review)).not.toContain("synthetic-service-value");
    if (mode === "env") f.launch.env.FIXTURE_VALUE = "changed-private-value";
    if (mode === "argv") f.launch.args[0] = "/fixed/other.mjs";
    if (mode === "revision") f.launch.envRevision = "fixed-env-v2";
    expect((await f.control(id)).ok).toBe(false); expect(f.start).not.toHaveBeenCalled(); expect(f.write.owner).toBeNull();
  }
});
it("managed owner retains uncertain dispatch, negative terminal ack and failed lease release with cached quit refusal", async () => {
  for (const mode of ["dispatch", "ack", "release"] as const) {
    const f = managedSetup(), { id } = await f.approve();
    if (mode === "dispatch") f.start.mockRejectedValue(Error("private-driver-error"));
    const result = await f.control(id);
    if (mode !== "dispatch") {
      expect(result.ok).toBe(true);
      if (mode === "ack") f.recovery.write.mockImplementation((record) => record.state === "unconfirmed" ? Promise.reject(Error("private-ack-error")) : f.durableWrite(record));
      if (mode === "release") f.lease.release.mockImplementation(() => { throw Error("private-lease-error"); });
      f.completion.resolve(f.receipt());
    }
    await vi.waitFor(() => expect(f.execution.snapshot().state).toBe("unconfirmed"));
    expect(f.write.owner).toBe("main"); expect(f.execution.resources()).toHaveLength(1);
    const closing = f.execution.close(); expect((await closing).ok).toBe(false); expect(f.execution.close()).toBe(closing);
    expect(f.start).toHaveBeenCalledTimes(1);
  }
});
it("managed owner revalidates a held path lease after terminal acknowledgement before releasing", async () => {
  const f = managedSetup(), { id } = await f.approve(); await f.control(id);
  f.lease.revalidate.mockImplementation(() => { throw Error("path-revoked"); }); f.completion.resolve(f.receipt());
  await vi.waitFor(() => expect(f.execution.snapshot().state).toBe("unconfirmed"));
  expect(f.write.owner).toBe("main"); expect(f.lease.release).not.toHaveBeenCalled();
  expect((await f.execution.close()).ok).toBe(false);
  const reopened = f.reopen(); expect(reopened.snapshot()).toMatchObject({ state: "unconfirmed", ownerSessionId: "main" });
  expect((await reopened.close()).ok).toBe(false);
});
it("managed owner releases a proven pre-dispatch refusal only after its durable ownership fence acknowledgement", async () => {
  const f = managedSetup(), { id } = await f.approve(), ack = deferred<undefined>();
  f.start.mockImplementation(async (owner) => ({ completion: Promise.resolve({ ...owner, capability: f.launch.capability, programSha256: f.launch.programSha256,
    sourceSha256: f.launch.sourceSha256, envRevision: f.launch.envRevision, event: "not-started" as const }), stop: () => f.completion.promise }));
  f.recovery.write.mockImplementation((record) => {
    f.durableWrite(record); return record.state === "unconfirmed" ? ack.promise : undefined;
  });
  const starting = f.control(id); await vi.waitFor(() => expect(f.recovery.write.mock.calls.some(([record]) => record.state === "unconfirmed")).toBe(true));
  expect(f.write.owner).toBe("main"); expect(f.lease.release).not.toHaveBeenCalled();
  const reopened = f.reopen(); expect(reopened.snapshot()).toMatchObject({ state: "unconfirmed", ownerSessionId: "main" });
  expect((await reopened.close()).ok).toBe(false); ack.resolve(undefined);
  expect(await starting).toEqual({ ok: false, error: "service-not-started" }); expect(f.write.owner).toBeNull(); expect(f.lease.release).toHaveBeenCalledTimes(1);
});
it("managed owner reconstruction refuses quit after failed shared release instead of accepting a clean terminal", async () => {
  const f = managedSetup(), { id } = await f.approve(); await f.control(id);
  let sharedReleased = false;
  f.lease.release.mockImplementation(() => { sharedReleased = true; throw Error("partial-private-release"); });
  f.completion.resolve(f.receipt());
  await vi.waitFor(() => expect(f.lease.release).toHaveBeenCalledTimes(1));
  expect(sharedReleased).toBe(true); expect(f.write.owner).toBe("main");
  const reopened = f.reopen();
  expect(reopened.snapshot()).toMatchObject({ state: "unconfirmed", ownerSessionId: "main" });
  expect(await reopened.control({ channel: f.channel, sessionId: "main", action: "start", persist: () => {} })).toEqual({ ok: false, error: "service-termination-unconfirmed" });
  expect((await reopened.close()).ok).toBe(false);
  expect((await f.execution.close()).ok).toBe(false); expect(f.lease.release).toHaveBeenCalledTimes(1);
  expect(f.execution.snapshot()).toMatchObject({ retainedRights: "release-uncertain" });
});
it("managed owner holds rights through the fence ack and blocks reconstruction and quit through the clean ack", async () => {
  const f = managedSetup(), { id } = await f.approve(); await f.control(id);
  const fence = deferred<undefined>(), clean = deferred<undefined>();
  f.recovery.write.mockImplementation((record) => {
    if (record.state === "unconfirmed") { f.durableWrite(record); return fence.promise; }
    if (record.state === "exited") return clean.promise.then(() => f.durableWrite(record));
    return f.durableWrite(record);
  });
  f.completion.resolve(f.receipt());
  await vi.waitFor(() => expect(f.recovery.write.mock.calls.some(([r]) => r.state === "unconfirmed")).toBe(true));
  expect(f.execution.snapshot()).toMatchObject({ ownerSessionId: "main", retainedRights: "held" });
  expect(f.write.owner).toBe("main"); expect(f.lease.release).not.toHaveBeenCalled();
  const duringFence = f.reopen(); expect(duringFence.snapshot()).toMatchObject({ state: "unconfirmed", ownerSessionId: "main" });
  expect((await duringFence.close()).ok).toBe(false);
  const closing = f.execution.close(); let closed = false; void closing.then(() => { closed = true; });
  fence.resolve(undefined);
  await vi.waitFor(() => expect(f.lease.release).toHaveBeenCalledTimes(1));
  expect(f.write.owner).toBeNull(); expect(f.execution.snapshot()).toMatchObject({ state: "unconfirmed", retainedRights: "released" });
  expect(f.write.claimWrite("main", "auto", { kind: "turn", label: "blocked" }).ok).toBe(false);
  const duringClean = f.reopen(); expect((await duringClean.close()).ok).toBe(false); expect(closed).toBe(false);
  clean.resolve(undefined); expect(await closing).toEqual({ ok: true, state: "exited" });
  expect(f.execution.resources()).toEqual([]); expect((await f.reopen().close()).ok).toBe(true);
});
it("managed owner retains both rights when a durable fence write has a negative acknowledgement", async () => {
  const f = managedSetup(), { id } = await f.approve(); await f.control(id);
  f.recovery.write.mockImplementation((record) => { f.durableWrite(record); return Promise.reject(Error("fence-ack-unknown")); });
  f.completion.resolve(f.receipt());
  expect((await f.execution.close()).ok).toBe(false); expect(f.write.owner).toBe("main"); expect(f.lease.release).not.toHaveBeenCalled();
  expect(f.execution.snapshot()).toMatchObject({ state: "unconfirmed", ownerSessionId: "main", retainedRights: "held" });
  expect((await f.reopen().close()).ok).toBe(false); expect((await f.control(id)).ok).toBe(false);
});
it("managed owner reports released rights but retains durable uncertainty after a failed clean write", async () => {
  const f = managedSetup(), { id } = await f.approve(); await f.control(id);
  f.recovery.write.mockImplementation((record) => record.state === "exited" ? Promise.reject(Error("clean-write-failed")) : f.durableWrite(record));
  f.completion.resolve(f.receipt());
  const closing = f.execution.close(); expect((await closing).ok).toBe(false); expect(f.execution.close()).toBe(closing);
  expect(f.execution.snapshot()).toMatchObject({ state: "unconfirmed", ownerSessionId: "main", retainedRights: "released" });
  expect(f.write.owner).toBeNull(); expect(f.lease.release).toHaveBeenCalledTimes(1);
  expect(f.write.claimWrite("main", "auto", { kind: "turn", label: "blocked" }).ok).toBe(false);
  const reopened = f.reopen();
  expect(await reopened.control({ channel: f.channel, sessionId: "main", action: "start", persist: () => {} })).toEqual({ ok: false, error: "service-termination-unconfirmed" });
  expect((await reopened.close()).ok).toBe(false); expect((await f.control(id)).ok).toBe(false);
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.lease.release).toHaveBeenCalledTimes(1);
});
it("managed owner fences a cancelled reservation before dispatch and preserves uncertainty if release fails", async () => {
  const f = managedSetup(), { id } = await f.approve(), startingAck = deferred<undefined>(), abort = new AbortController();
  f.recovery.write.mockImplementation((record) => {
    f.durableWrite(record); return record.state === "starting" ? startingAck.promise : undefined;
  });
  const operation = f.execution.control({ channel: f.channel, sessionId: "main", action: "start", approvalId: id, signal: abort.signal, persist: () => {} });
  await vi.waitFor(() => expect(f.recovery.write.mock.calls.some(([r]) => r.state === "starting")).toBe(true));
  abort.abort(); f.lease.release.mockImplementation(() => { throw Error("reservation-release-failed"); }); startingAck.resolve(undefined);
  expect((await operation).ok).toBe(false); expect(f.start).not.toHaveBeenCalled(); expect(f.write.owner).toBe("main");
  expect(f.execution.snapshot()).toMatchObject({ state: "unconfirmed", ownerSessionId: "main", retainedRights: "release-uncertain" });
  expect((await f.reopen().close()).ok).toBe(false); expect((await f.execution.close()).ok).toBe(false);
});
it("managed owner never sends stop after a proven no-launch release even when the final clean acknowledgement fails", async () => {
  const f = managedSetup(), { id } = await f.approve(), stop = vi.fn(() => f.completion.promise);
  f.start.mockImplementation(async (owner) => ({ completion: Promise.resolve({ ...owner, capability: f.launch.capability, programSha256: f.launch.programSha256,
    sourceSha256: f.launch.sourceSha256, envRevision: f.launch.envRevision, event: "not-started" as const }), stop }));
  f.recovery.write.mockImplementation((record) => record.state === "stopped" ? Promise.reject(Error("clean-ack-failed")) : f.durableWrite(record));
  const starting = f.control(id); let settled = false; void starting.then(() => { settled = true; });
  await vi.waitFor(() => expect(f.lease.release).toHaveBeenCalledTimes(1));
  expect(stop).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(settled).toBe(true)); expect((await starting).ok).toBe(false);
  expect(f.execution.snapshot()).toMatchObject({ state: "unconfirmed", retainedRights: "released" });
  expect((await f.execution.close()).ok).toBe(false); expect((await f.reopen().close()).ok).toBe(false);
});
