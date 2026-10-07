import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { expect, it, beforeEach, afterEach, vi } from "vitest";
import { join, resolve, sep } from "node:path";
import { NodePtyDriver, type NodePtyWorker } from "./node-pty-driver.js";
import { TerminalExecution } from "./terminal-execution.js";
import { PiSessionChannel } from "../main/pi-session.js";
import { TaskWriteCoordinator } from "./write-coordination.js";
import { observeFixtureDisposition } from "../../scripts/fixtures/node-pty-disposition.mjs";

class WorkerFixture extends EventEmitter implements NodePtyWorker {
  requests: Record<string, unknown>[] = [];
  send(message: Record<string, unknown>, callback: (error: Error | null) => void): boolean {
    this.requests.push(message); callback(null); return true;
  }
  reply(fields: Record<string, unknown>, request = this.requests.at(-1)!) {
    this.emit("message", { workspaceId: request.workspaceId, identity: request.identity, operationId: request.operationId,
      kind: "reply", requestId: request.requestId, status: "started", ...fields });
  }
}

beforeEach(() => {
  // Protocol tests admit a synthetic supported runtime; all workers are injected.
  vi.stubGlobal("process", { ...process, platform: "darwin", arch: "arm64",
    versions: { ...process.versions, node: "24.21.0", electron: undefined } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const identity = { taskId: "task-aaaaaaaa", sessionId: "main", instanceId: "term-1", generation: 1 };
const fixtureCwd = resolve(sep, "pidock-pty-synthetic");
const launch = { program: join(fixtureCwd, "program"), args: [], cwd: fixtureCwd, env: {}, envRevision: "fixture-1", cols: 80, rows: 24 };

it("refuses an unbound Node executable before dispatching any PTY", async () => {
  const driver = new NodePtyDriver({ workspaceId: "workspace-1", nodeExecutable: "/untrusted/node", onOutput: () => {} });
  expect(await driver.spawn(identity, launch, () => {})).toEqual({ status: "not-started" });
  expect(await driver.stop(identity)).toEqual({ ...identity, status: "not-started" });
  expect(driver.snapshot(identity)).toMatchObject({ status: "unknown" });
});

it("delivers output only for the exact operation and marks root exit unknown", async () => {
  const worker = new WorkerFixture(), output: unknown[] = [], receipts: unknown[] = [];
  const driver = new NodePtyDriver({ workspaceId: "workspace-1", nodeExecutable: realpathSync(process.execPath),
    spawnWorker: () => worker, onOutput: (owner, sequence, data) => output.push({ owner, sequence, data }) });
  const spawning = driver.spawn(identity, launch, (receipt) => receipts.push(receipt));
  worker.reply({});
  expect(await spawning).toEqual({ status: "started" });
  const envelope = worker.requests[0]!;
  worker.emit("message", { workspaceId: "workspace-1", identity, operationId: envelope.operationId, kind: "output", sequence: 1, data: "fixture output\r\n" });
  expect(output).toEqual([{ owner: identity, sequence: 1, data: "fixture output\r\n" }]);
  worker.emit("message", { workspaceId: "workspace-1", identity, operationId: envelope.operationId, kind: "exit", exitCode: 7, signal: 0 });
  expect(receipts).toEqual([{ ...identity, status: "unknown" }]);
  expect(driver.snapshot(identity)).toMatchObject({ status: "unknown", ptyExit: { exitCode: 7, signal: 0 } });
  expect(await driver.stop(identity)).toEqual({ ...identity, status: "unknown" });
});

it("fences an unsolicited uncertainty report after acknowledged spawn", async () => {
  const worker = new WorkerFixture();
  const driver = new NodePtyDriver({ workspaceId: "workspace-1", nodeExecutable: realpathSync(process.execPath), spawnWorker: () => worker, onOutput: () => {} });
  const spawning = driver.spawn(identity, launch, () => {}); worker.reply({}); await spawning;
  worker.reply({ status: "unknown" });
  expect(driver.snapshot(identity)).toMatchObject({ status: "unknown" });
  await expect(driver.input(identity, "echo fixture\r")).rejects.toThrow("terminal-pty-unconfirmed");
});

it("bounds queued input when the PTY cannot acknowledge application delivery", async () => {
  const worker = new WorkerFixture();
  const driver = new NodePtyDriver({ workspaceId: "workspace-1", nodeExecutable: realpathSync(process.execPath), spawnWorker: () => worker, onOutput: () => {} });
  const spawning = driver.spawn(identity, launch, () => {}); worker.reply({}); await spawning;
  for (let i = 0; i < 32; i++) {
    const input = driver.input(identity, "a".repeat(2000)); worker.reply({ status: "accepted" }); await input;
  }
  await expect(driver.input(identity, "a".repeat(2000))).rejects.toThrow("terminal-pty-unconfirmed");
  expect(worker.requests).toHaveLength(33);
  expect(driver.snapshot(identity)).toMatchObject({ status: "unknown" });
});

it("retains an uncertain spawn and ignores late acknowledgements without dispatching twice", async () => {
  vi.useFakeTimers();
  try {
    const worker = new WorkerFixture(), receipts: unknown[] = [];
    const driver = new NodePtyDriver({ workspaceId: "workspace-1", nodeExecutable: realpathSync(process.execPath),
      operationTimeoutMs: 20, spawnWorker: () => worker, onOutput: () => {} });
    const starting = driver.spawn(identity, launch, (receipt) => receipts.push(receipt));
    await vi.advanceTimersByTimeAsync(20);
    expect(await starting).toEqual({ status: "unknown" });
    expect(receipts).toEqual([{ ...identity, status: "unknown" }]);
    worker.reply({ status: "started", rootPid: 123 });
    expect(await driver.spawn(identity, launch, () => {})).toEqual({ status: "unknown" });
    expect(worker.requests).toHaveLength(1);
    expect(driver.snapshot(identity)).toMatchObject({ status: "unknown", rootPid: 123 });
    expect(await driver.stop(identity)).toEqual({ ...identity, status: "unknown" });
  } finally { vi.useRealTimers(); }
});

it.each(["input", "resize"] as const)("bounds uncertain %s acknowledgement and refuses later controls", async (action) => {
  vi.useFakeTimers();
  try {
    const worker = new WorkerFixture();
    const driver = new NodePtyDriver({ workspaceId: "workspace-1", nodeExecutable: realpathSync(process.execPath),
      operationTimeoutMs: 20, spawnWorker: () => worker, onOutput: () => {} });
    const spawning = driver.spawn(identity, launch, () => {}); worker.reply({}); await spawning;
    const control = action === "input" ? driver.input(identity, "fixture\r") : driver.resize(identity, 100, 40);
    const rejected = expect(control).rejects.toThrow("terminal-pty-unconfirmed");
    await vi.advanceTimersByTimeAsync(20); await rejected;
    worker.reply({ status: "accepted" });
    expect(driver.snapshot(identity)).toMatchObject({ status: "unknown" });
    await expect(driver.input(identity, "fixture\r")).rejects.toThrow("terminal-pty-unconfirmed");
    await expect(driver.resize(identity, 100, 40)).rejects.toThrow("terminal-pty-unconfirmed");
    expect(worker.requests).toHaveLength(2);
  } finally { vi.useRealTimers(); }
});

it.each(["workspace", "task", "generation", "operation", "oversized", "sequence"])("fences a %s protocol mismatch without delivering foreign output", async (mismatch) => {
  const worker = new WorkerFixture(), output: string[] = [];
  const driver = new NodePtyDriver({ workspaceId: "workspace-1", nodeExecutable: realpathSync(process.execPath), spawnWorker: () => worker,
    onOutput: (_identity, _sequence, data) => output.push(data) });
  const spawning = driver.spawn(identity, launch, () => {}); worker.reply({}); await spawning;
  const event = { workspaceId: "workspace-1", identity: { ...identity }, operationId: worker.requests[0]!.operationId,
    kind: "output", sequence: 1, data: "fixture" };
  if (mismatch === "workspace") event.workspaceId = "other-workspace";
  if (mismatch === "task") event.identity.taskId = "other-task";
  if (mismatch === "generation") event.identity.generation++;
  if (mismatch === "operation") event.operationId = "00000000-0000-0000-0000-000000000000";
  if (mismatch === "oversized") event.data = "界".repeat(1366);
  if (mismatch === "sequence") event.sequence = 2;
  worker.emit("message", event);
  expect(output).toEqual([]);
  expect(driver.snapshot(identity)).toMatchObject({ status: "unknown" });
  expect(await driver.stop(identity)).toEqual({ ...identity, status: "unknown" });
});

it("keeps old worker callbacks in their retained generation while another generation runs", async () => {
  const old = new WorkerFixture(), current = new WorkerFixture(), output: unknown[] = [];
  let next = old;
  const driver = new NodePtyDriver({ workspaceId: "workspace-1", nodeExecutable: realpathSync(process.execPath), spawnWorker: () => next,
    onOutput: (owner, sequence, data) => output.push({ owner, sequence, data }) });
  const first = driver.spawn(identity, launch, () => {}); old.reply({}); await first;
  await driver.stop(identity); next = current;
  const newer = { ...identity, generation: 2 };
  const second = driver.spawn(newer, launch, () => {}); current.reply({}); await second;
  old.emit("message", { workspaceId: "workspace-1", identity: newer, operationId: current.requests[0]!.operationId,
    kind: "exit", exitCode: 0, signal: 0 });
  old.emit("exit", 0, null);
  expect(driver.snapshot(identity)).toMatchObject({ status: "unknown" });
  expect(driver.snapshot(newer)).toMatchObject({ status: "running" });
  expect(output).toEqual([]);
});

it.each(["error", "disconnect", "exit"])("keeps ownership when the helper reports %s before spawn acknowledgement", async (event) => {
  const worker = new WorkerFixture();
  const driver = new NodePtyDriver({ workspaceId: "workspace-1", nodeExecutable: realpathSync(process.execPath), spawnWorker: () => worker, onOutput: () => {} });
  const spawning = driver.spawn(identity, launch, () => {});
  worker.emit(event, event === "error" ? Error("private fixture value") : 0, null);
  expect(await spawning).toEqual({ status: "unknown" });
  expect(await driver.stop(identity)).toEqual({ ...identity, status: "unknown" });
});

it.each([
  { label: "Windows", platform: "win32" },
  { label: "Linux", platform: "linux" },
  { label: "x64", arch: "x64" },
  { label: "another Node version", versions: { ...process.versions, node: "24.0.0", electron: undefined } },
  { label: "Electron", versions: { ...process.versions, node: "24.21.0", electron: "44.4.3" } },
])("refuses $label before library load or worker creation (synthetic admission)", async ({ label: _label, ...unsupported }) => {
  vi.stubGlobal("process", { ...process, ...unsupported });
  const worker = new WorkerFixture(), spawnWorker = vi.fn(() => worker);
  const driver = new NodePtyDriver({ workspaceId: "workspace-1", nodeExecutable: realpathSync(process.execPath), spawnWorker, onOutput: () => {} });
  expect(await driver.spawn(identity, launch, () => {})).toEqual({ status: "not-started" });
  expect(spawnWorker).not.toHaveBeenCalled(); expect(worker.requests).toEqual([]);
  expect(await driver.stop(identity)).toEqual({ ...identity, status: "not-started" });
});

it("dispatches a copied explicit environment without merging ambient values", async () => {
  vi.stubEnv("PIDOCK_AMBIENT_FIXTURE", "must-not-enter-launch");
  try {
    const worker = new WorkerFixture();
    const driver = new NodePtyDriver({ workspaceId: "workspace-1", nodeExecutable: realpathSync(process.execPath), spawnWorker: () => worker, onOutput: () => {} });
    const input = { ...launch, args: ["synthetic"], env: { FIXTURE_VALUE: "explicit", __CF_USER_TEXT_ENCODING: "0x123:0:0" } };
    const spawning = driver.spawn(identity, input, () => {});
    input.env.FIXTURE_VALUE = "changed"; input.args.push("changed");
    expect(worker.requests[0]!.launch).toEqual({ ...launch, args: ["synthetic"], env: { FIXTURE_VALUE: "explicit", __CF_USER_TEXT_ENCODING: "0x123:0:0" } });
    worker.reply({}); expect(await spawning).toEqual({ status: "started" });
  } finally { vi.unstubAllEnvs(); }
});

it("observes later root/helper exits after a fixture failure while controller rights remain held", async () => {
  vi.useFakeTimers();
  try {
    const worker = new WorkerFixture(), write = new TaskWriteCoordinator(), release = vi.fn(), persistReceipt = vi.fn();
    const driver = new NodePtyDriver({ workspaceId: "workspace-1", nodeExecutable: realpathSync(process.execPath), spawnWorker: () => worker, onOutput: () => {} });
    const execution = new TerminalExecution({ taskId: identity.taskId, taskDir: fixtureCwd, instanceId: identity.instanceId,
      driver, write, resolveLaunch: () => launch, authorizeAutomation: () => true,
      acquireLease: () => ({ revalidate: () => {}, release }), persistReceipt });
    const channel = new PiSessionChannel({ taskId: identity.taskId, taskDir: fixtureCwd, sessionId: "main", providerId: "local", model: "fixture", permission: "auto" });
    const starting = execution.control({ channel, sessionId: "main", request: { action: "start" }, persistApproval: async () => {} });
    worker.reply({ rootPid: 123 }); expect(await starting).toEqual({ ok: true });
    const owner = execution.snapshot().identity!;
    const initialFailure = { error: "fixture-assertion", resources: driver.snapshot(owner) };
    let settled = false;
    const observing = observeFixtureDisposition({ snapshot: () => driver.snapshot(owner), descendant: () => undefined,
      descendantPid: () => undefined, deadlineAt: performance.now() + 1000 }).then((result) => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(20); expect(settled).toBe(false);
    const request = worker.requests[0]!;
    worker.emit("message", { workspaceId: request.workspaceId, identity: owner, operationId: request.operationId, kind: "exit", exitCode: 99, signal: 0 });
    await vi.advanceTimersByTimeAsync(20); expect(settled).toBe(false);
    worker.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(20);
    expect(await observing).toMatchObject({ deadlineExceeded: false, treeDrained: false, missingReceipts: [],
      driver: { status: "unknown", ptyExit: { exitCode: 99, signal: 0 }, workerExit: { code: 0, signal: null } } });
    expect(initialFailure.resources.ptyExit).toBeUndefined(); expect(initialFailure.error).toBe("fixture-assertion");
    expect(execution.snapshot().state).toBe("unconfirmed"); expect(write.owner).toBe("main");
    expect(release).not.toHaveBeenCalled(); expect(persistReceipt).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it("reports missing finite-fixture receipts at the deadline without treating an unstarted descendant as required", async () => {
  vi.useFakeTimers();
  try {
    const observing = observeFixtureDisposition({ snapshot: () => ({ workerPid: 123, rootPid: 124 }),
      descendant: () => undefined, descendantPid: () => undefined, deadlineAt: performance.now() + 20 });
    await vi.advanceTimersByTimeAsync(20);
    expect(await observing).toMatchObject({ deadlineExceeded: true, treeDrained: false, missingReceipts: ["root-exit", "worker-exit"] });
  } finally { vi.useRealTimers(); }
});

it("waits for an actually started finite descendant marker after root/helper exit without claiming tree drain", async () => {
  vi.useFakeTimers();
  try {
    let exited = false;
    const observing = observeFixtureDisposition({ snapshot: () => ({ workerPid: 123, rootPid: 124, ptyExit: { exitCode: 7, signal: 0 }, workerExit: { code: 0, signal: null } }),
      descendant: () => ({ pid: 125, exited }), descendantPid: () => 125, deadlineAt: performance.now() + 1000 });
    await vi.advanceTimersByTimeAsync(20); exited = true; await vi.advanceTimersByTimeAsync(20);
    expect(await observing).toMatchObject({ deadlineExceeded: false, treeDrained: false, missingReceipts: [], descendant: { pid: 125, exited: true } });
  } finally { vi.useRealTimers(); }
});
