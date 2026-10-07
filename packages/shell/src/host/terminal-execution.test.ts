import { expect, it } from "vitest";
import { PiSessionChannel } from "../main/pi-session.js";
import { TaskWriteCoordinator } from "./write-coordination.js";
import { SharedPathCoordinator } from "./path-coordination.js";
import { TerminalExecution, type TerminalDriver, type TerminalDriverReceipt, type TerminalLaunch, type TerminalRequest } from "./terminal-execution.js";

const taskId = "task-aaaaaaaa", taskDir = "/tasks/task-aaaaaaaa";
function fixture(options: Partial<ConstructorParameters<typeof TerminalExecution>[0]> = {}) {
  const fixtureTask = options.taskId ?? taskId, fixtureDir = `/tasks/${fixtureTask}`;
  const write = new TaskWriteCoordinator();
  const channel = new PiSessionChannel({ taskId: fixtureTask, taskDir: fixtureDir, sessionId: "main", providerId: "local", model: "fixture", permission: "auto" });
  const launch: TerminalLaunch = { program: "fixture", args: [], cwd: `${fixtureDir}/repo`, env: { FIXTURE: "one" }, envRevision: "env-1", cols: 80, rows: 24 };
  let completion: ((receipt: TerminalDriverReceipt) => void) | undefined;
  const delivered: string[] = [];
  const driver: TerminalDriver = {
    spawn: async (_identity, _launch, observe) => { completion = observe; return { status: "started" }; },
    input: async (_identity, data) => { delivered.push(data); }, resize: async (_identity, cols, rows) => { delivered.push(`${cols}x${rows}`); },
    stop: async (identity) => ({ ...identity, status: "tree-drained", exitCode: 0 }),
    snapshot: () => ({ status: "running" }),
  };
  const receipts: TerminalDriverReceipt[] = [];
  const execution = new TerminalExecution({ taskId: fixtureTask, taskDir: fixtureDir, instanceId: "term-1", write, driver,
    resolveLaunch: () => launch, authorizeAutomation: () => true,
    acquireLease: () => ({ revalidate: () => {}, release: () => {} }),
    persistReceipt: async (receipt) => { receipts.push(receipt); }, ...options,
  });
  const request = (request: TerminalRequest, approvalId?: string) => execution.control({ channel, sessionId: "main", request, approvalId, persistApproval: async () => {} });
  const control = (action: "start" | "stop" = "start", approvalId?: string) => request({ action }, approvalId);
  return { execution, control, request, delivered, write, receipts, driver, launch, channel, complete: () => completion!({ ...execution.snapshot().identity!, status: "tree-drained", exitCode: 0 }),
    observer: () => completion! };
}

it("keeps competing writes locked until the entire terminal tree ends and its receipt is durable", async () => {
  const f = fixture();
  expect(await f.control()).toEqual({ ok: true });
  expect(f.write.claimWrite("review", "auto", { kind: "turn", label: "competing edit" })).toMatchObject({ ok: false, verdict: "locked" });
  f.complete();
  await f.execution.settled();
  expect(f.receipts).toEqual([expect.objectContaining({ status: "tree-drained", generation: 1, sessionId: "main" })]);
  expect(f.write.claimWrite("review", "auto", { kind: "turn", label: "next edit" })).toMatchObject({ ok: true });
});

it("retains ownership and refuses quit when stop cannot prove the whole tree ended", async () => {
  const f = fixture();
  f.driver.stop = async (identity) => ({ ...identity, status: "unknown" });
  await f.control();
  expect(await f.control("stop")).toEqual({ ok: false, error: "terminal-termination-unconfirmed" });
  expect(await f.execution.close()).toEqual({ ok: false, error: "terminal-termination-unconfirmed" });
  expect(f.execution.snapshot()).toMatchObject({ state: "unconfirmed", closing: true, identity: { sessionId: "main", generation: 1 } });
  expect(f.write.owner).toBe("main");
  expect(await f.control()).toEqual({ ok: false, error: "terminal-host-closing" });
  f.driver.stop = async (identity) => ({ ...identity, status: "tree-drained", exitCode: 0 });
  expect(await f.execution.close()).toEqual({ ok: true });
  expect(f.write.owner).toBeNull();
});

it("ignores an old generation's delayed receipt after a new terminal starts", async () => {
  const f = fixture();
  await f.control();
  const oldIdentity = f.execution.snapshot().identity!, oldObserver = f.observer();
  expect(await f.control("stop")).toEqual({ ok: true });
  expect(await f.control()).toEqual({ ok: true });
  oldObserver({ ...oldIdentity, status: "tree-drained", exitCode: 0 });
  await f.execution.settled();
  expect(f.execution.snapshot()).toMatchObject({ state: "running", identity: { generation: 2 } });
  expect(f.write.owner).toBe("main");
});

it("asks for the exact command before default execution and never spends it on changed arguments", async () => {
  const f = fixture(); f.channel.setPermission("default");
  const asked = await f.control();
  expect(asked).toMatchObject({ ok: false, error: "approval-required", review: { action: "start", program: "fixture", args: [], cwd: `${taskDir}/repo`, envRevision: "env-1", generation: 1 } });
  const approvalId = f.channel.snapshot().approvals[0]!.id;
  expect(f.write.owner).toBeNull();
  expect(await f.control("start", approvalId)).toMatchObject({ ok: false });
  f.channel.approve(approvalId);
  f.launch.args = ["changed"];
  expect(await f.control("start", approvalId)).toEqual({ ok: false, error: "invalid-terminal-approval" });
  expect(f.channel.snapshot().approvals[0]!.consumedAt).toBeUndefined();
  f.launch.args = [];
  expect(await f.control("start", approvalId)).toEqual({ ok: true });
  expect(f.channel.snapshot().approvals[0]!.consumedAt).toBeDefined();
  expect(await f.control("stop", approvalId)).toEqual({ ok: false, error: "invalid-terminal-approval" });
  expect(f.write.owner).toBe("main");
});

it("requires a separate exact input approval and keeps lifetime rights after the driver accepts input", async () => {
  const f = fixture(); await f.control(); f.channel.setPermission("default");
  const asked = await f.request({ action: "input", data: "echo hello\r" });
  expect(asked).toMatchObject({ ok: false, error: "approval-required", review: { action: "input", data: "echo hello\r", generation: 1 } });
  const id = f.channel.snapshot().approvals.at(-1)!.id; f.channel.approve(id);
  expect(await f.request({ action: "input", data: "echo changed\r" }, id)).toEqual({ ok: false, error: "invalid-terminal-approval" });
  expect(f.delivered).toEqual([]);
  expect(await f.request({ action: "input", data: "echo hello\r" }, id)).toEqual({ ok: true });
  expect(f.delivered).toEqual(["echo hello\r"]);
  expect(f.execution.snapshot()).toMatchObject({ state: "running", identity: { generation: 1 } });
  expect(f.write.owner).toBe("main");
});

it("binds resize approval to finite dimensions and preserves ownership on driver resize failure", async () => {
  const f = fixture(); await f.control(); f.channel.setPermission("default");
  expect(await f.request({ action: "resize", cols: 120, rows: 30 })).toMatchObject({ error: "approval-required", review: { action: "resize", cols: 120, rows: 30 } });
  const id = f.channel.snapshot().approvals.at(-1)!.id; f.channel.approve(id);
  expect(await f.request({ action: "resize", cols: 100, rows: 30 }, id)).toMatchObject({ error: "invalid-terminal-approval" });
  expect(await f.request({ action: "resize", cols: 120, rows: 30 }, id)).toEqual({ ok: true });
  expect(f.delivered).toEqual(["120x30"]);
  f.channel.setPermission("auto"); f.driver.resize = async () => { throw Error("private fixture env value"); };
  expect(await f.request({ action: "resize", cols: 120, rows: 40 })).toEqual({ ok: false, error: "terminal-resize-failed" });
  expect(f.write.owner).toBe("main");
  expect(await f.request({ action: "resize", cols: NaN, rows: 30 })).toEqual({ ok: false, error: "invalid-terminal-resize" });
});

it("retains rights after a durable receipt failure and retries only that receipt during shutdown", async () => {
  let fail = true;
  const f = fixture({ persistReceipt: async () => { if (fail) throw Error("private-env-value"); } });
  await f.control();
  expect(await f.control("stop")).toEqual({ ok: false, error: "terminal-receipt-persistence-failed" });
  expect(f.write.owner).toBe("main");
  expect(await f.execution.close()).toEqual({ ok: false, error: "terminal-receipt-persistence-failed" });
  fail = false;
  f.driver.stop = async () => { throw Error("must not re-stop an already drained tree"); };
  expect(await f.execution.close()).toEqual({ ok: true });
  expect(f.execution.snapshot()).toMatchObject({ state: "exited", identity: null });
  expect(f.write.owner).toBeNull();
});

it("fences input when the resolver changes the private environment after launch even at the same revision", async () => {
  const f = fixture(); await f.control();
  f.launch.env["FIXTURE"] = "changed-private-value";
  expect(await f.request({ action: "input", data: "hello" })).toEqual({ ok: false, error: "terminal-authorization-changed" });
  expect(f.delivered).toEqual([]);
  expect(f.write.owner).toBe("main");
  expect(JSON.stringify(f.execution.snapshot())).not.toContain("changed-private-value");
  expect(await f.execution.close()).toEqual({ ok: true });
});

it("keeps an early uncertain completion fenced when the later spawn acknowledgement says started", async () => {
  const f = fixture();
  f.driver.spawn = async (identity, _launch, observe) => { observe({ ...identity, status: "unknown" }); return { status: "started" }; };
  expect(await f.control()).toEqual({ ok: false, error: "terminal-termination-unconfirmed" });
  expect(f.execution.snapshot()).toMatchObject({ state: "unconfirmed" });
  expect(await f.request({ action: "input", data: "hello" })).toMatchObject({ ok: false });
  expect(f.write.owner).toBe("main");
});

it("refuses a not-started completion for an already running terminal rather than releasing rights", async () => {
  const f = fixture(); await f.control();
  f.observer()({ ...f.execution.snapshot().identity!, status: "not-started" });
  await f.execution.settled();
  expect(f.execution.snapshot()).toMatchObject({ state: "unconfirmed", identity: { generation: 1 } });
  expect(f.write.owner).toBe("main");
  expect(f.receipts).toEqual([]);
});

it("reads driver state without stopping the hidden terminal and fences unconfirmed observations", async () => {
  const f = fixture(); await f.control();
  const identity = f.execution.snapshot().identity;
  expect(f.execution.snapshot().identity).toEqual(identity);
  expect(f.execution.snapshot().state).toBe("running");
  expect(f.receipts).toEqual([]); expect(f.write.owner).toBe("main");
  f.driver.snapshot = () => ({ status: "unknown" });
  expect(f.execution.snapshot()).toMatchObject({ state: "unconfirmed", identity });
  expect(await f.request({ action: "input", data: "hello" })).toMatchObject({ ok: false });
  expect(f.write.owner).toBe("main");
  expect(await f.execution.close()).toEqual({ ok: true });
});

it("holds both task and shared-target rights until the durable tree receipt is acknowledged", async () => {
  const shared = new SharedPathCoordinator();
  let acknowledge: () => void = () => {};
  const saved = new Promise<void>((resolve) => { acknowledge = resolve; });
  const acquireLease: ConstructorParameters<typeof TerminalExecution>[0]["acquireLease"] = (review) => {
    const claim = shared.claim({ ...review, paths: ["/shared/work"], label: "terminal lifetime" });
    if (!claim.ok) throw Error(claim.reason);
    return { revalidate: () => { if (shared.holderOf("/shared/work")?.taskId !== review.taskId) throw Error("lease revoked"); },
      release: () => { shared.release({ taskId: review.taskId, sessionId: review.sessionId }); } };
  };
  const a = fixture({ acquireLease, persistReceipt: () => saved });
  const b = fixture({ taskId: "task-bbbbbbbb", acquireLease });
  const independent = fixture({ taskId: "task-cccccccc" });
  expect(await a.control()).toEqual({ ok: true });
  expect(await b.control()).toMatchObject({ ok: false });
  expect(await independent.control()).toEqual({ ok: true });
  a.complete();
  expect(a.write.owner).toBe("main");
  expect(await b.control()).toMatchObject({ ok: false });
  acknowledge(); await a.execution.settled();
  expect(await b.control()).toEqual({ ok: true });
  expect(independent.execution.snapshot().identity?.taskId).toBe("task-cccccccc");
  await b.execution.close(); await independent.execution.close();
});

it("distinguishes provably not-started from unknown spawn without leaking private driver errors", async () => {
  const stopped = fixture(); stopped.driver.spawn = async () => ({ status: "not-started" });
  expect(await stopped.control()).toEqual({ ok: true });
  expect(stopped.execution.snapshot()).toMatchObject({ state: "not-started", identity: null });
  expect(stopped.write.owner).toBeNull();
  const unknown = fixture(); unknown.driver.spawn = async () => { throw Error("PRIVATE FIXTURE VALUE"); };
  expect(await unknown.control()).toEqual({ ok: false, error: "terminal-start-unconfirmed" });
  expect(unknown.execution.snapshot()).toMatchObject({ state: "unconfirmed", identity: { generation: 1, sessionId: "main" } });
  expect(unknown.write.owner).toBe("main");
  expect(await unknown.execution.close()).toEqual({ ok: true });
});

it("refuses read-only commands and auto commands without a trusted automation scope", async () => {
  const f = fixture({ authorizeAutomation: undefined });
  expect(await f.control()).toEqual({ ok: false, error: "terminal-authorization-required" });
  f.channel.setPermission("read");
  expect(await f.control()).toMatchObject({ ok: false });
  expect(f.channel.snapshot().approvals).toEqual([]);
  expect(f.write.owner).toBeNull();
  expect(f.execution.snapshot().identity).toBeNull();
});

it("refuses changed cwd, changed private env at the same revision, rejected and expired confirmations", async () => {
  const f = fixture(); f.channel.setPermission("default"); await f.control();
  const id = f.channel.snapshot().approvals.at(-1)!.id; f.channel.approve(id);
  f.launch.cwd = `${taskDir}/other`;
  expect(await f.control("start", id)).toMatchObject({ error: "invalid-terminal-approval" });
  f.launch.cwd = `${taskDir}/repo`; f.launch.env["FIXTURE"] = "new-private-value";
  expect(await f.control("start", id)).toMatchObject({ error: "invalid-terminal-approval" });
  f.launch.env["FIXTURE"] = "one"; f.channel.setPermission("auto");
  expect(await f.control("start", id)).toMatchObject({ error: "invalid-terminal-approval" });
  f.channel.setPermission("default"); await f.control();
  const rejected = f.channel.snapshot().approvals.at(-1)!.id; f.channel.reject(rejected);
  expect(await f.control("start", rejected)).toMatchObject({ error: "invalid-terminal-approval" });
  await f.control(); const expired = f.channel.snapshot().approvals.at(-1)!.id;
  const restored = PiSessionChannel.restore(f.channel.snapshot(), taskDir);
  expect(restored.snapshot().approvals.at(-1)?.status).toBe("expired");
  expect(await f.execution.control({ channel: restored, sessionId: "main", request: { action: "start" }, approvalId: expired, persistApproval: async () => {} })).toMatchObject({ error: "invalid-terminal-approval" });
  expect(f.write.owner).toBeNull(); expect(f.execution.snapshot().identity).toBeNull();
});

it("does not dispatch if approval persistence fails or changes the private environment before dispatch", async () => {
  const f = fixture(); f.channel.setPermission("default"); await f.control();
  const id = f.channel.snapshot().approvals.at(-1)!.id; f.channel.approve(id);
  expect(await f.execution.control({ channel: f.channel, sessionId: "main", request: { action: "start" }, approvalId: id,
    persistApproval: async () => { f.launch.env["FIXTURE"] = "changed-during-ack"; } })).toMatchObject({ ok: false });
  expect(f.execution.snapshot().identity).toBeNull(); expect(f.write.owner).toBeNull();
  f.launch.env["FIXTURE"] = "one"; await f.control(); const nextId = f.channel.snapshot().approvals.at(-1)!.id; f.channel.approve(nextId);
  expect(await f.execution.control({ channel: f.channel, sessionId: "main", request: { action: "start" }, approvalId: nextId,
    persistApproval: async () => { throw Error("PRIVATE FIXTURE VALUE"); } })).toMatchObject({ ok: false });
  expect(f.execution.snapshot().identity).toBeNull(); expect(f.write.owner).toBeNull();
  expect(f.channel.snapshot().approvals.at(-1)?.consumedAt).toBeDefined();
});

it("rejects a different task/session and a revoked lease before spawn", async () => {
  const f = fixture({ acquireLease: () => ({ revalidate: () => { throw Error("revoked"); }, release: () => {} }) });
  expect(await f.control()).toMatchObject({ ok: false });
  expect(f.execution.snapshot().identity).toBeNull(); expect(f.write.owner).toBeNull();
  const foreign = new PiSessionChannel({ taskId: "task-bbbbbbbb", taskDir: "/tasks/task-bbbbbbbb", sessionId: "other", providerId: "local", model: "fixture", permission: "auto" });
  expect(await f.execution.control({ channel: foreign, sessionId: "main", request: { action: "start" }, persistApproval: async () => {} })).toEqual({ ok: false, error: "terminal-caller-mismatch" });
});

it("keeps a proven durable tree exit terminal when a delayed spawn acknowledgement rejects", async () => {
  const f = fixture();
  f.driver.spawn = async (identity, _launch, observe) => { observe({ ...identity, status: "tree-drained", exitCode: 7 }); throw Error("late spawn transport failure"); };
  expect(await f.control()).toEqual({ ok: true });
  expect(f.execution.snapshot()).toMatchObject({ state: "exited", identity: null });
  expect(f.receipts).toEqual([expect.objectContaining({ status: "tree-drained", exitCode: 7 })]);
  expect(f.write.owner).toBeNull();
});

it("records the launch permission while later permission changes gate subsequent actions", async () => {
  const f = fixture(); await f.control(); f.channel.setPermission("read");
  expect(f.execution.snapshot()).toMatchObject({ state: "running", permissionAtStart: "auto" });
  expect(await f.request({ action: "input", data: "hello" })).toMatchObject({ ok: false });
  expect(await f.control("stop")).toMatchObject({ ok: false });
  expect(f.write.owner).toBe("main");
  expect(await f.execution.close()).toEqual({ ok: true });
});

it("returns a bounded refusal when trusted automation scope revalidation throws", async () => {
  const f = fixture({ authorizeAutomation: () => { throw Error("SYNTHETIC_PRIVATE_TERMINAL_ENV"); } });
  expect(await f.control()).toEqual({ ok: false, error: "terminal-authorization-changed" });
  expect(f.write.owner).toBeNull(); expect(f.execution.snapshot().identity).toBeNull();
});

it("seals new actions while an accepted spawn drains through shutdown", async () => {
  const f = fixture(); let accept: (status: { status: "started" }) => void = () => {};
  f.driver.spawn = () => new Promise((resolve) => { accept = resolve; });
  const spawning = f.control();
  const quit = f.execution.close();
  expect(f.execution.snapshot()).toMatchObject({ state: "starting", closing: true, identity: { generation: 1 } });
  expect(await f.request({ action: "input", data: "hello" })).toMatchObject({ error: "terminal-host-closing" });
  expect(f.write.owner).toBe("main");
  accept({ status: "started" }); await spawning;
  expect(await quit).toEqual({ ok: true });
  expect(f.execution.snapshot()).toMatchObject({ state: "exited", identity: null });
  expect(f.write.owner).toBeNull();
});

it("keeps foreign receipts fenced and persists only the bounded owner and terminal result", async () => {
  const f = fixture(); f.launch.env["FIXTURE"] = "SYNTHETIC_PRIVATE_TERMINAL_ENV";
  f.channel.setPermission("default"); const review = await f.control();
  expect(JSON.stringify(review)).not.toContain("SYNTHETIC_PRIVATE_TERMINAL_ENV");
  const id = f.channel.snapshot().approvals.at(-1)!.id; f.channel.approve(id); await f.control("start", id);
  const identity = f.execution.snapshot().identity!;
  f.observer()({ ...identity, taskId: "task-foreign", status: "tree-drained", exitCode: 0 });
  expect(f.execution.snapshot()).toMatchObject({ state: "unconfirmed", identity });
  expect(f.write.owner).toBe("main"); expect(f.receipts).toEqual([]);
  const receipt = { ...identity, status: "tree-drained" as const, exitCode: 0, diagnostic: "SYNTHETIC_PRIVATE_TERMINAL_ENV" };
  f.observer()(receipt); await f.execution.settled();
  expect(f.receipts).toEqual([{ ...identity, status: "tree-drained", exitCode: 0 }]);
});

it("fences replay after uncertain input delivery until the whole tree has a durable termination receipt", async () => {
  let acknowledge: () => void = () => {};
  const saved = new Promise<void>((resolve) => { acknowledge = resolve; });
  const f = fixture({ persistReceipt: () => saved });
  await f.control();
  const identity = f.execution.snapshot().identity!;
  f.driver.input = async (_identity, data) => { f.delivered.push(data); throw Error("SYNTHETIC_PRIVATE_TERMINAL_ENV"); };
  expect(await f.request({ action: "input", data: "echo hello\r" })).toEqual({ ok: false, error: "terminal-input-failed" });
  expect(f.execution.snapshot()).toMatchObject({ state: "unconfirmed", identity, error: "terminal-input-unconfirmed" });
  expect(await f.request({ action: "input", data: "echo hello\r" })).toEqual({ ok: false, error: "terminal-termination-unconfirmed" });
  expect(await f.request({ action: "resize", cols: 120, rows: 30 })).toEqual({ ok: false, error: "terminal-termination-unconfirmed" });
  expect(f.delivered).toEqual(["echo hello\r"]);
  expect(f.write.claimWrite("review", "auto", { kind: "turn", label: "competing edit" })).toMatchObject({ ok: false, verdict: "locked" });
  f.observer()({ ...identity, generation: identity.generation + 1, status: "tree-drained", exitCode: 0 });
  expect(f.execution.snapshot()).toMatchObject({ state: "unconfirmed", identity });
  expect(f.write.owner).toBe("main");
  f.driver.stop = async (owner) => ({ ...owner, status: "unknown" });
  expect(await f.control("stop")).toEqual({ ok: false, error: "terminal-termination-unconfirmed" });
  expect(await f.execution.close()).toEqual({ ok: false, error: "terminal-termination-unconfirmed" });
  f.driver.stop = async (owner) => ({ ...owner, status: "tree-drained", exitCode: 0 });
  const closing = f.execution.close();
  expect(f.write.owner).toBe("main");
  acknowledge();
  expect(await closing).toEqual({ ok: true });
  expect(f.execution.snapshot()).toMatchObject({ state: "exited", identity: null });
  expect(f.write.claimWrite("review", "auto", { kind: "turn", label: "next edit" })).toMatchObject({ ok: true });
});

it("does not revive a durably exited operation when its pending input later rejects", async () => {
  const f = fixture(); await f.control();
  const oldIdentity = f.execution.snapshot().identity!, oldObserver = f.observer();
  let reject: (error: Error) => void = () => {};
  f.driver.input = () => new Promise((_resolve, fail) => { reject = fail; });
  const input = f.request({ action: "input", data: "hello" });
  oldObserver({ ...oldIdentity, status: "tree-drained", exitCode: 0 });
  // The durable receipt has released ownership even while the input acknowledgement is pending.
  await Promise.resolve();
  expect(f.execution.snapshot()).toMatchObject({ state: "exited", identity: null });
  expect(f.write.owner).toBeNull();
  reject(Error("SYNTHETIC_PRIVATE_TERMINAL_ENV"));
  expect(await input).toEqual({ ok: false, error: "terminal-input-failed" });
  expect(f.execution.snapshot()).toMatchObject({ state: "exited", identity: null, error: undefined });
  expect(await f.control()).toEqual({ ok: true });
  oldObserver({ ...oldIdentity, status: "unknown" });
  expect(f.execution.snapshot()).toMatchObject({ state: "running", identity: { generation: 2 }, error: undefined });
  expect(f.write.owner).toBe("main");
  expect(await f.execution.close()).toEqual({ ok: true });
});

it.each(["control", "close"] as const)("preserves durable exit when pending %s stop acknowledgement rejects late", async (mode) => {
  let acknowledge: () => void = () => {};
  const saved = new Promise<void>((resolve) => { acknowledge = resolve; });
  let released = false;
  const f = fixture({ persistReceipt: () => saved,
    acquireLease: () => ({ revalidate: () => {}, release: () => { released = true; } }),
  }); await f.control();
  const oldIdentity = f.execution.snapshot().identity!, oldObserver = f.observer();
  let reject: (error: Error) => void = () => {}, entered: () => void = () => {};
  const dispatched = new Promise<void>((resolve) => { entered = resolve; });
  f.driver.stop = () => new Promise((_resolve, fail) => { reject = fail; entered(); });
  const stopping = mode === "control" ? f.control("stop") : f.execution.close();
  await dispatched;
  oldObserver({ ...oldIdentity, status: "tree-drained", exitCode: 7 });
  expect(f.execution.snapshot()).toMatchObject({ state: "stopping", identity: oldIdentity });
  expect(f.write.owner).toBe("main"); expect(released).toBe(false);
  expect(f.write.claimWrite("review", "auto", { kind: "turn", label: "competing edit" })).toMatchObject({ ok: false, verdict: "locked" });
  acknowledge(); await Promise.resolve();
  expect(f.execution.snapshot()).toMatchObject({ state: "exited", identity: null, error: undefined });
  expect(f.write.owner).toBeNull(); expect(released).toBe(true);
  reject(Error("SYNTHETIC_PRIVATE_TERMINAL_ENV"));
  expect(await stopping).toEqual({ ok: true });
  expect(f.execution.snapshot()).toMatchObject({ state: "exited", identity: null, error: undefined });
  if (mode === "control") {
    expect(await f.control()).toEqual({ ok: true });
    oldObserver({ ...oldIdentity, status: "unknown" });
    expect(f.execution.snapshot()).toMatchObject({ state: "running", identity: { generation: 2 }, error: undefined });
    expect(f.write.owner).toBe("main");
    f.driver.stop = async (identity) => ({ ...identity, status: "tree-drained", exitCode: 0 });
  }
  expect(await f.execution.close()).toEqual({ ok: true });
  expect(f.write.owner).toBeNull();
});

it.each(["control", "close"] as const)("preserves receipt persistence failure after pending %s stop rejects late", async (mode) => {
  let fail = true, released = false;
  const persisted: TerminalDriverReceipt[] = [];
  const f = fixture({
    acquireLease: () => ({ revalidate: () => {}, release: () => { released = true; } }),
    persistReceipt: async (receipt) => { persisted.push(receipt); if (fail) throw Error("SYNTHETIC_PRIVATE_TERMINAL_ENV"); },
  });
  await f.control();
  const identity = f.execution.snapshot().identity!;
  let reject: (error: Error) => void = () => {}, entered: () => void = () => {};
  const dispatched = new Promise<void>((resolve) => { entered = resolve; });
  f.driver.stop = () => new Promise((_resolve, failure) => { reject = failure; entered(); });
  const stopping = mode === "control" ? f.control("stop") : f.execution.close();
  await dispatched;
  f.observer()({ ...identity, status: "tree-drained", exitCode: 7 });
  await Promise.resolve();
  expect(f.execution.snapshot()).toMatchObject({ state: "unconfirmed", identity, error: "terminal-receipt-persistence-failed" });
  expect(released).toBe(false); expect(f.write.owner).toBe("main");
  reject(Error("SYNTHETIC_PRIVATE_TERMINAL_ENV"));
  expect(await stopping).toEqual({ ok: false, error: "terminal-receipt-persistence-failed" });
  expect(f.execution.snapshot()).toMatchObject({ state: "unconfirmed", identity, error: "terminal-receipt-persistence-failed" });
  expect(released).toBe(false);
  expect(f.write.claimWrite("review", "auto", { kind: "turn", label: "competing edit" })).toMatchObject({ ok: false, verdict: "locked" });
  // Recovery persists the proven receipt; dispatching another OS stop would be unsafe.
  f.driver.stop = async () => { throw Error("must not re-stop the drained tree"); };
  fail = false;
  expect(await f.execution.close()).toEqual({ ok: true });
  expect(persisted).toEqual([
    { ...identity, status: "tree-drained", exitCode: 7 },
    { ...identity, status: "tree-drained", exitCode: 7 },
  ]);
  expect(f.execution.snapshot()).toMatchObject({ state: "exited", identity: null, error: undefined });
  expect(released).toBe(true); expect(f.write.owner).toBeNull();
});

it("bounds input and dimensions before emitting any terminal data", async () => {
  const f = fixture(); await f.control();
  expect(await f.request({ action: "input", data: "界".repeat(667) })).toMatchObject({ error: "invalid-terminal-input" });
  expect(await f.request({ action: "resize", cols: 501, rows: 24 })).toMatchObject({ error: "invalid-terminal-resize" });
  f.driver.input = async () => { throw Error("SYNTHETIC_PRIVATE_TERMINAL_ENV"); };
  expect(await f.request({ action: "input", data: "hello" })).toEqual({ ok: false, error: "terminal-input-failed" });
  expect(f.delivered).toEqual([]); expect(f.write.owner).toBe("main");
});
