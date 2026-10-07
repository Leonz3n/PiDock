import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TaskWorkspaceHost, diskTaskStore } from "./task-host.js";
import { buildTaskDiskRecord, serializeTaskRecord } from "./task-store.js";
import { SdkTurnTransport } from "./sdk-turn-transport.js";
import type { SdkContextClient } from "./sdk-context-client.js";
import type { SdkTextResult } from "./sdk-text-kernel.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const config = { profileId: "p-11111111-2222-3333-4444-555555555555", baseUrl: "https://models.example.test/v1", modelId: "gpt-5-mini", contextWindow: 128000, maxTokens: 8192, authRef: "PIDOCK_PROVIDER_EXAMPLE", generation: 1 };
const at = "2026-09-22T10:00:00.000Z";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function fixture(taskId = "task-a", now: () => string = () => at) {
  const home = mkdtempSync(join(tmpdir(), "pidock-sdk-ledger-")); homes.push(home);
  const taskDir = join(home, taskId); mkdirSync(taskDir);
  const task = buildTaskDiskRecord({ taskId, name: "任务 A", dirId: taskId, branch: "main", root: home, taskDir, remoteBranch: "main", baseCommit: "fixture", repos: [], now: at });
  writeFileSync(join(taskDir, "task.json"), serializeTaskRecord(task));
  // A private task and real execution.json persistence; only the model context
  // is a fixture. Copy the store so fault injection never changes global state.
  const store = { ...diskTaskStore };
  const response = deferred<SdkTextResult>();
  const client = { open: vi.fn(async () => ({ sdkId: "fixture", file: "fixture.jsonl", tools: [] })), prompt: vi.fn(() => response.promise), cancel: vi.fn(async () => {}), seal: vi.fn(), dispose: vi.fn(async () => {}) };
  const createHost = () => new TaskWorkspaceHost(taskId, taskDir, store, now, () => [], undefined, undefined, undefined, undefined, () => client as unknown as SdkContextClient);
  const host = createHost(); await host.configureSdkProvider({ config, credential: "synthetic-provider-key" });
  const transport = new SdkTurnTransport(taskId, taskDir, host.sdkTextKernel());
  return { host, transport, store, taskDir, response, client, createHost };
}

it("projects an admitted SDK main turn into versioned execution state and completed attention without duplicating a request", async () => {
  const f = await fixture();
  const turn = await f.transport.start("main", "request-a", "user content stays in SDK", () => {});
  expect(f.host.executionState("main").executions).toMatchObject([{ taskId: "task-a", sessionId: "main", callId: turn.turnId, kind: "turn", state: "executing", steps: [{ stepId: turn.turnId, state: "pending" }] }]);
  f.response.resolve({ state: "done", text: "answer", events: [] }); await f.transport.waitForTerminal();
  const state = f.host.executionState("main");
  expect(state.session).toBe("done");
  expect(state.executions[0]).toMatchObject({ callId: turn.turnId, steps: [{ stepId: turn.turnId, state: "done" }], attempts: [{ attemptId: turn.turnId, endState: "completed" }] });
  expect(state.executions[0]!.version).toBeGreaterThan(1);
  expect(f.host.attention().items).toMatchObject([{ taskId: "task-a", sessionId: "main", kind: "completed-unread" }]);
  const duplicate = await f.transport.start("main", "request-a", "user content stays in SDK", () => {});
  expect(duplicate.turnId).toBe(turn.turnId); expect(f.host.executionState("main").executions).toEqual(state.executions);
  expect(f.client.prompt).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(f.store.readExecutions(f.taskDir))).not.toMatch(/user content stays in SDK|answer|synthetic-provider-key|models.example/);
});

it("keeps SDK delivery failure resync while persisting only a safe failure code", async () => {
  const f = await fixture();
  await f.transport.start("main", "request-a", "hello", () => {});
  f.response.resolve({ state: "failed", text: "", events: [], error: "sdk-event-delivery-failed" }); await f.transport.waitForTerminal();
  expect(f.transport.status("main", "request-a")).toMatchObject({ state: "failed", error: "sdk-event-delivery-failed", needsResync: true });
  expect(f.host.executionState("main").executions).toMatchObject([{ state: "failed", failureReason: "sdk-turn-failed", draftKept: true, attempts: [{ endState: "failed" }] }]);
  expect(f.host.attention().items).toMatchObject([{ kind: "failed", sessionId: "main" }]);
});

it("waits for the SDK terminal authority when cancel is pending and records one stopped attempt", async () => {
  const f = await fixture(); const turn = await f.transport.start("main", "request-a", "hello", () => {});
  const cancelling = f.transport.cancel("main", turn.turnId);
  await Promise.resolve();
  expect(f.host.executionState("main").session).toBe("executing");
  f.response.resolve({ state: "cancelled", text: "", events: [] }); await cancelling;
  expect(f.host.executionState("main").executions).toMatchObject([{ state: "stopped", steps: [{ stepId: turn.turnId, state: "skipped" }], attempts: [{ attemptId: turn.turnId, endState: "cancelled" }] }]);
  expect(f.host.attention().items).toEqual([]);
});

it("keeps a completed SDK outcome when cancellation loses the race", async () => {
  const f = await fixture(); const turn = await f.transport.start("main", "request-a", "hello", () => {});
  const cancelling = f.transport.cancel("main", turn.turnId);
  f.response.resolve({ state: "done", text: "completed before cancel", events: [] }); await cancelling;
  expect(f.transport.status("main", "request-a")?.state).toBe("done");
  expect(f.host.executionState("main").executions).toMatchObject([{ state: "done", attempts: [{ endState: "completed" }] }]);
});

it("fails closed before model dispatch when execution admission cannot persist, retaining the request reservation", async () => {
  const f = await fixture();
  f.store.writeExecutions = () => { throw Error("synthetic-private-storage-error"); };
  const turn = await f.transport.start("main", "request-a", "hello", () => {}); await f.transport.waitForTerminal();
  expect(f.transport.status("main", "request-a")).toMatchObject({ turnId: turn.turnId, state: "failed", error: "sdk-execution-ledger-uncommitted" });
  expect(f.host.executionState("main").executions).toEqual([]);
  expect(f.client.prompt).not.toHaveBeenCalled();
  expect(await f.transport.start("main", "request-a", "hello", () => {})).toMatchObject({ turnId: turn.turnId, state: "failed" });
  await expect(f.transport.start("main", "request-a", "changed", () => {})).rejects.toThrow("idempotency-mismatch");
  expect(f.client.prompt).not.toHaveBeenCalled();
});

it("retains the exact terminal projection on persistence failure while SDK status remains done and recovery only writes the ledger", async () => {
  const f = await fixture(); const turn = await f.transport.start("main", "request-a", "hello", () => {});
  const write = f.store.writeExecutions;
  const pending: string[] = [];
  f.store.writeExecutions = (_, ledger) => { pending.push(JSON.stringify(ledger)); throw Error("synthetic-private-storage-error"); };
  f.response.resolve({ state: "done", text: "SDK success", events: [] }); await f.transport.waitForTerminal();
  expect(f.transport.status("main", "request-a")).toMatchObject({ state: "done" });
  for (const read of [() => f.host.executionState("main"), () => f.host.attention(), () => f.host.markAttentionRead(["unread:exec-1"])]) expect(read).toThrow("sdk-execution-ledger-uncommitted");
  await expect(f.transport.start("main", "request-b", "next", () => {})).rejects.toThrow("sdk-execution-ledger-uncommitted");
  expect(f.transport.status("main", "request-b")).toBeNull();
  expect(await f.transport.start("main", "request-a", "hello", () => {})).toMatchObject({ state: "done" });
  expect(f.host.sdkTextKernel().projection("main").source).toBe("sdk-jsonl");
  f.store.writeExecutions = write;
  const restored = f.host.executionState("main").executions;
  expect(restored).toMatchObject([{ state: "done", attempts: [{ attemptId: turn.turnId, endState: "completed" }] }]);
  expect(restored[0]!.attempts).toHaveLength(1);
  expect(pending.length).toBeGreaterThan(1);
  expect(new Set(pending).size).toBe(1);
  expect(JSON.stringify(f.store.readExecutions(f.taskDir))).toBe(pending[0]);
  expect(f.client.prompt).toHaveBeenCalledTimes(1);
});

it("does not report a successful SDK shutdown while a terminal execution projection is uncommitted", async () => {
  const f = await fixture(); await f.transport.start("main", "request-a", "hello", () => {});
  f.store.writeExecutions = () => { throw Error("synthetic-private-storage-error"); };
  f.response.resolve({ state: "done", text: "SDK success", events: [] }); await f.transport.waitForTerminal();
  await expect(f.host.shutdownSdk()).rejects.toThrow("sdk-host-shutdown-unconfirmed");
  expect(f.transport.status("main", "request-a")?.state).toBe("done");
  expect(() => f.host.executionState("main")).toThrow("sdk-execution-ledger-uncommitted");
});

it.each(["returned", "thrown"])("keeps %s private SDK error text out of execution state and transport status", async (mode) => {
  const f = await fixture();
  if (mode === "thrown") f.client.prompt.mockImplementation(async () => { throw Error("synthetic-private-provider-error"); });
  await f.transport.start("main", "request-a", "hello", () => {});
  f.response.resolve({ state: "failed", text: "", events: [], error: "synthetic-private-provider-error" }); await f.transport.waitForTerminal();
  expect(f.transport.status("main", "request-a")).toMatchObject({ state: "failed", error: "sdk-turn-failed" });
  const executions = f.host.executionState("main").executions;
  expect(executions).toMatchObject([{ state: "failed", failureReason: "sdk-turn-failed", draftKept: true }]);
  expect(JSON.stringify(executions)).not.toContain("synthetic-private-provider-error");
});

it("rejects invalid sessions, missing/invalid turn identities and reused turn identities before dispatch", async () => {
  const f = await fixture(); const router = f.host.sdkTextKernel();
  const uuid = "11111111-2222-4333-8444-555555555555";
  for (const [session, identity] of [["legacy", uuid], ["main", undefined], ["main", "bad-id"]] as const) await expect(router.prompt(session, "hello", undefined, identity)).rejects.toThrow("invalid-sdk-turn-identity");
  expect(f.host.executionState("main").executions).toEqual([]); expect(f.client.prompt).not.toHaveBeenCalled();
  const prompting = router.prompt("main", "hello", undefined, uuid);
  await expect(router.prompt("main", "hello", undefined, uuid)).rejects.toThrow("sdk-turn-already-recorded");
  f.response.resolve({ state: "done", text: "answer", events: [] }); await prompting;
  await expect(router.prompt("main", "hello", undefined, uuid)).rejects.toThrow("sdk-turn-already-recorded");
  expect(f.client.prompt).toHaveBeenCalledTimes(1);
  expect(f.host.executionState("legacy").executions).toEqual([]);
});

it("creates no execution for pre-admission prompt/busy/provider refusals or status reads", async () => {
  const f = await fixture();
  expect(f.transport.status("main", "unknown")).toBeNull();
  await expect(f.transport.start("main", "empty", " ", () => {})).rejects.toThrow("invalid-prompt");
  expect(f.host.executionState("main").executions).toEqual([]);
  await f.transport.start("main", "request-a", "hello", () => {});
  await expect(f.transport.start("main", "request-b", "busy", () => {})).rejects.toThrow("task-locked");
  expect(f.host.executionState("main").executions).toHaveLength(1);
  f.response.resolve({ state: "done", text: "answer", events: [] }); await f.transport.waitForTerminal();
  await f.host.configureSdkProvider(null);
  const noProvider = new SdkTurnTransport("task-a", f.taskDir, f.host.sdkTextKernel());
  await expect(noProvider.start("main", "request-c", "hello", () => {})).rejects.toThrow("provider-not-configured");
  await expect(f.host.sdkTextKernel().prompt("main", "hello")).rejects.toThrow("provider-not-configured");
  expect(f.host.executionState("main").executions).toHaveLength(1);
});

it("restores in-flight execution as stopped with no model replay and preserves another session's history", async () => {
  const f = await fixture(); const turn = await f.transport.start("main", "request-a", "hello", () => {});
  const restored = f.createHost();
  const cold = new SdkTurnTransport("task-a", f.taskDir, restored.sdkTextKernel());
  expect(cold.status("main", "request-a")).toMatchObject({ turnId: turn.turnId, state: "interrupted" });
  expect(await cold.start("main", "request-a", "hello", () => {})).toMatchObject({ state: "interrupted" });
  expect(restored.executionState("main").executions).toMatchObject([{ callId: turn.turnId, state: "stopped" }]);
  expect(restored.executionState("legacy").executions).toEqual([]);
  expect(f.client.prompt).toHaveBeenCalledTimes(1);
});

it("keeps a committed SDK execution and its read acknowledgement across cold Host restore", async () => {
  const f = await fixture(); await f.transport.start("main", "request-a", "hello", () => {});
  f.response.resolve({ state: "done", text: "answer", events: [] }); await f.transport.waitForTerminal();
  const item = f.host.attention().items[0]!;
  expect(f.host.markAttentionRead([item.id])).toEqual({ cleared: [item.id], kept: [] });
  const restored = f.createHost(); const cold = new SdkTurnTransport("task-a", f.taskDir, restored.sdkTextKernel());
  expect(restored.executionState("main").executions).toEqual(f.host.executionState("main").executions);
  expect(restored.attention().items[0]?.read).toBe(true);
  expect(await cold.start("main", "request-a", "hello", () => {})).toMatchObject({ state: "done" });
  expect(f.client.prompt).toHaveBeenCalledTimes(1);
});

it("preserves an uncertain admitted disk record and fences a new request after persistence writes then throws", async () => {
  const f = await fixture(); const write = f.store.writeExecutions;
  f.store.writeExecutions = (dir, ledger) => { write(dir, ledger); throw Error("synthetic-after-write-failure"); };
  const turn = await f.transport.start("main", "request-a", "hello", () => {}); await f.transport.waitForTerminal();
  const diskProjection = JSON.stringify(f.store.readExecutions(f.taskDir));
  f.store.writeExecutions = write;
  await expect(f.transport.start("main", "request-b", "next", () => {})).rejects.toThrow("sdk-execution-ledger-uncommitted");
  expect(JSON.stringify(f.store.readExecutions(f.taskDir))).toBe(diskProjection);
  expect(f.client.prompt).not.toHaveBeenCalled();
  expect(f.transport.status("main", "request-a")).toMatchObject({ turnId: turn.turnId, state: "failed" });
  await f.host.configureSdkProvider({ config, credential: "synthetic-provider-key" });
  await expect(f.host.sdkTextKernel().open("main")).rejects.toThrow("sdk-execution-ledger-uncommitted");
  expect(f.host.sdkTextKernel().projection("main").source).toBe("sdk-jsonl");
  await expect(f.host.shutdownSdk()).rejects.toThrow("sdk-host-shutdown-unconfirmed");
  const coldHost = f.createHost(); const cold = new SdkTurnTransport("task-a", f.taskDir, coldHost.sdkTextKernel());
  expect(coldHost.executionState("main").executions).toMatchObject([{ callId: turn.turnId, state: "stopped", attempts: [] }]);
  expect(await cold.start("main", "request-a", "hello", () => {})).toMatchObject({ state: "failed" });
  expect(f.client.prompt).not.toHaveBeenCalled();
});

it("refuses an older unread acknowledgement without overwriting a write-then-throw SDK admission", async () => {
  const f = await fixture();
  await f.transport.start("main", "completed", "first", () => {});
  f.response.resolve({ state: "done", text: "answer", events: [] }); await f.transport.waitForTerminal();
  const committed = f.host.executionState("main");
  const attention = f.host.attention();
  const item = attention.items[0]!;
  const write = f.store.writeExecutions;
  f.store.writeExecutions = (dir, ledger) => { write(dir, ledger); throw Error("synthetic-after-write-failure"); };
  const turn = await f.transport.start("main", "uncertain", "second", () => {}); await f.transport.waitForTerminal();
  const disk = readFileSync(join(f.taskDir, "execution.json"));
  expect(f.store.readExecutions(f.taskDir).executions).toHaveLength(2);
  f.store.writeExecutions = write;
  expect(() => f.host.markAttentionRead([item.id])).toThrow("sdk-execution-ledger-uncommitted");
  expect(f.host.executionState("main")).toEqual(committed);
  expect(f.host.attention()).toEqual(attention);
  expect(readFileSync(join(f.taskDir, "execution.json"))).toEqual(disk);
  expect(f.transport.status("main", "uncertain")).toMatchObject({ turnId: turn.turnId, state: "failed", error: "sdk-execution-ledger-uncommitted" });
  expect(f.host.sdkTextKernel().projection("main").source).toBe("sdk-jsonl");
  expect(f.client.prompt).toHaveBeenCalledTimes(1);
  await expect(f.host.shutdownSdk()).rejects.toThrow("sdk-host-shutdown-unconfirmed");
});

it("refuses a legacy turn before opening a ledger record after uncertain SDK admission", async () => {
  const f = await fixture();
  const write = f.store.writeExecutions;
  f.store.writeExecutions = (dir, ledger) => { write(dir, ledger); throw Error("synthetic-after-write-failure"); };
  await f.transport.start("main", "uncertain", "hello", () => {}); await f.transport.waitForTerminal();
  const disk = readFileSync(join(f.taskDir, "execution.json"));
  f.store.writeExecutions = write;
  expect(() => f.host.sendMessage("legacy", "fixture analysis")).toThrow("sdk-execution-ledger-uncommitted");
  expect(f.host.executionState("legacy").executions).toEqual([]);
  expect(readFileSync(join(f.taskDir, "execution.json"))).toEqual(disk);
  expect(f.client.prompt).not.toHaveBeenCalled();
});

it.each(["cancel", "approve", "reject"] as const)("refuses legacy %s ledger transitions after uncertain SDK admission", async (operation) => {
  const f = await fixture();
  const target = join(f.taskDir, "fixture.txt");
  const waiting = f.host.sendMessage("legacy", "fixture command", { tool: "exec.run", target, execute: () => ({ tool: "exec.run", target, contentVersion: "v1", output: "fixture proposal" }) });
  expect(waiting.state).toBe("approval");
  const committed = f.host.executionState("legacy");
  const write = f.store.writeExecutions;
  f.store.writeExecutions = (dir, ledger) => { write(dir, ledger); throw Error("synthetic-after-write-failure"); };
  await f.transport.start("main", "uncertain", "hello", () => {}); await f.transport.waitForTerminal();
  const disk = readFileSync(join(f.taskDir, "execution.json"));
  f.store.writeExecutions = write;
  const mutate = () => operation === "cancel" ? f.host.cancel("legacy") : operation === "approve" ? f.host.approve("legacy", waiting.approvalId!) : f.host.reject("legacy", waiting.approvalId!);
  expect(mutate).toThrow("sdk-execution-ledger-uncommitted");
  expect(f.host.executionState("legacy")).toEqual(committed);
  expect(readFileSync(join(f.taskDir, "execution.json"))).toEqual(disk);
  expect(f.client.prompt).not.toHaveBeenCalled();
});

it.each(["state", "attention", "schedule-expiry"] as const)("refuses %s implicit expiry writes after uncertain SDK admission", async (operation) => {
  let clock = at;
  const f = await fixture("task-a", () => clock);
  const target = join(f.taskDir, "fixture.txt");
  const waiting = f.host.sendMessage("legacy", "fixture command", { tool: "exec.run", target, execute: () => ({ tool: "exec.run", target, contentVersion: "v1", output: "fixture proposal" }) });
  expect(waiting.state).toBe("approval");
  const committed = f.host.executionState("legacy");
  const write = f.store.writeExecutions;
  f.store.writeExecutions = (dir, ledger) => { write(dir, ledger); throw Error("synthetic-after-write-failure"); };
  await f.transport.start("main", "uncertain", "hello", () => {}); await f.transport.waitForTerminal();
  const disk = readFileSync(join(f.taskDir, "execution.json"));
  f.store.writeExecutions = write;
  clock = "2026-09-23T11:00:00.000Z";
  const read = () => operation === "state" ? f.host.executionState("legacy") : operation === "attention" ? f.host.attention() : f.host.evaluateSchedules();
  expect(read).toThrow("sdk-execution-ledger-uncommitted");
  expect(readFileSync(join(f.taskDir, "execution.json"))).toEqual(disk);
  clock = at;
  expect(f.host.executionState("legacy")).toEqual(committed);
  expect(f.client.prompt).not.toHaveBeenCalled();
});

it("does not overwrite uncertain admission when an earlier SDK prompt settles", async () => {
  const f = await fixture();
  const router = f.host.sdkTextKernel();
  const firstId = "11111111-2222-4333-8444-555555555555";
  const secondId = "22222222-2222-4333-8444-555555555555";
  const earlier = router.prompt("main", "first", undefined, firstId);
  const committed = f.host.executionState("main");
  const write = f.store.writeExecutions;
  f.store.writeExecutions = (dir, ledger) => { write(dir, ledger); throw Error("synthetic-after-write-failure"); };
  await expect(router.prompt("main", "second", undefined, secondId)).rejects.toThrow("sdk-execution-ledger-uncommitted");
  const disk = readFileSync(join(f.taskDir, "execution.json"));
  expect(f.store.readExecutions(f.taskDir).executions).toHaveLength(2);
  f.store.writeExecutions = write;
  f.response.resolve({ state: "done", text: "SDK success", events: [] });
  expect(await earlier).toMatchObject({ state: "done" });
  expect(readFileSync(join(f.taskDir, "execution.json"))).toEqual(disk);
  expect(f.host.executionState("main")).toEqual(committed);
  expect(f.client.prompt).toHaveBeenCalledTimes(1);
  await expect(f.host.shutdownSdk()).rejects.toThrow("sdk-host-shutdown-unconfirmed");
});

it("retains SDK success and permanently fences an execution whose terminal transition is no longer valid", async () => {
  const f = await fixture(); await f.transport.start("main", "request-a", "hello", () => {});
  // A competing legacy session stop changes only execution projection; it is
  // not the SDK cancel authority and must not convert the SDK's final outcome.
  f.host.cancel("main");
  f.response.resolve({ state: "done", text: "SDK success", events: [] }); await f.transport.waitForTerminal();
  expect(f.transport.status("main", "request-a")?.state).toBe("done");
  expect(() => f.host.executionState("main")).toThrow("sdk-execution-ledger-uncommitted");
  expect(() => f.host.attention()).toThrow("sdk-execution-ledger-uncommitted");
  expect(() => f.host.markAttentionRead(["unread:exec-1"])).toThrow("sdk-execution-ledger-uncommitted");
  await expect(f.transport.start("main", "request-b", "next", () => {})).rejects.toThrow("sdk-execution-ledger-uncommitted");
  expect(f.host.sdkTextKernel().projection("main").source).toBe("sdk-jsonl");
  await expect(f.host.shutdownSdk()).rejects.toThrow("sdk-host-shutdown-unconfirmed");
  expect(f.client.prompt).toHaveBeenCalledTimes(1);
});

it("keeps another task's SDK execution independent of a main terminal callback", async () => {
  const a = await fixture("task-a"), b = await fixture("task-b");
  await b.transport.start("main", "request-b", "other task", () => {});
  const foreign = JSON.stringify(b.host.executionState("main"));
  const turn = await a.transport.start("main", "request-a", "hello", () => {});
  a.response.resolve({ state: "done", text: "answer", events: [] }); await a.transport.waitForTerminal();
  expect(JSON.stringify(b.host.executionState("main"))).toBe(foreign);
  expect(a.host.executionState("main").executions).toMatchObject([{ taskId: "task-a", sessionId: "main", callId: turn.turnId, state: "done" }]);
  b.response.resolve({ state: "done", text: "other answer", events: [] }); await b.transport.waitForTerminal();
  expect(b.host.attention().items).toMatchObject([{ taskId: "task-b", sessionId: "main" }]);
});

it.each(["done", "cancelled"] as const)("keeps %s SDK terminal authority without persisting an unexpected private error", async (state) => {
  const f = await fixture(); await f.transport.start("main", "request-a", "hello", () => {});
  f.response.resolve({ state, text: "", events: [], error: "synthetic-private-provider-error" }); await f.transport.waitForTerminal();
  expect(f.transport.status("main", "request-a")).toMatchObject({ state });
  expect(f.transport.status("main", "request-a")?.error).toBeUndefined();
  expect(f.host.executionState("main").session).toBe(state === "done" ? "done" : "stopped");
});
