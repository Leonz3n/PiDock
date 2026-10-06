import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { TaskWorkspaceHost, memoryTaskStore } from "./task-host.js";
import { buildTaskDiskRecord, serializeTaskRecord } from "./task-store.js";
import type { SdkContextClient } from "./sdk-context-client.js";

const CONFIG = {
  profileId: "p-11111111-2222-3333-4444-555555555555",
  baseUrl: "https://models.example.test/v1",
  modelId: "gpt-5-mini",
  contextWindow: 128000,
  maxTokens: 8192,
  authRef: "PIDOCK_PROVIDER_EXAMPLE",
  generation: 1,
};

function task(id: string) {
  const root = mkdtempSync(join(tmpdir(), "pidock-sdk-provider-"));
  const dir = join(root, id);
  mkdirSync(dir);
  execFileSync("git", ["init", "-q", dir]);
  writeFileSync(join(dir, "task.json"), serializeTaskRecord(buildTaskDiskRecord({
    taskId: id, name: id, dirId: id, branch: "main", root, taskDir: dir,
    remoteBranch: "main", baseCommit: "test", repos: [], now: new Date().toISOString(),
  })));
  return dir;
}

function fakeContext(fail = false) {
  const calls: string[] = [];
  const client = {
    open: vi.fn(async () => { calls.push("open"); if (fail) throw new Error("sdk-binding-invalid"); return { sdkId: "sdk-1", file: "/tmp/sdk-1.jsonl", tools: [] }; }),
    prompt: vi.fn(async () => { calls.push("prompt"); return { state: "done" as const, text: "hi", events: [] }; }),
    cancel: vi.fn(async () => { calls.push("cancel"); }),
    seal: vi.fn(),
    dispose: vi.fn(async () => { calls.push("dispose"); }),
  } as unknown as SdkContextClient;
  return { client, calls };
}

/** Positional: store, now, liveResources, sharedPaths, resolveRealPath, mintSecret, kernelFactory, contextFactory. */
function host(dir: string, contexts: SdkContextClient[]) {
  let index = 0;
  return new TaskWorkspaceHost(dir === "" ? "task-a" : "task-a", dir, memoryTaskStore(), () => "2026-09-22T10:00:00+08:00",
    () => [], undefined, undefined, undefined, undefined,
    () => contexts[Math.min(contexts.length - 1, index++)]!);
}

it("keeps a successfully opened context installed and routes model turns to it", async () => {
  const dir = task("task-a");
  const first = fakeContext();
  const second = fakeContext();
  const taskHost = host(dir, [first.client, second.client]);
  expect(taskHost.sdkTextKernel().configured).toBe(false);
  expect(await taskHost.configureSdkProvider({ config: CONFIG, credential: "synthetic-key" })).toEqual({ generation: 1 });
  expect(taskHost.sdkProviderConfigured).toBe(true);
  expect(taskHost.sdkTextKernel().configured).toBe(true);
  expect(first.calls).toEqual(["open"]);
  expect(await taskHost.sdkTextKernel().prompt("main", "hello")).toMatchObject({ state: "done", text: "hi" });
  expect(first.calls).toEqual(["open", "prompt"]);
  // Reconfiguring disposes the previous context before installing the next one.
  expect(await taskHost.configureSdkProvider({ config: CONFIG, credential: "synthetic-key" })).toEqual({ generation: 2 });
  expect(first.calls.at(-1)).toBe("dispose");
  await taskHost.shutdownSdk();
  expect(taskHost.sdkProviderConfigured).toBe(false);
  expect(taskHost.sdkTextKernel().configured).toBe(false);
});

it("leaves the task unconfigured when the eager open fails", async () => {
  const dir = task("task-a");
  const refusing = fakeContext(true);
  const taskHost = host(dir, [refusing.client]);
  await expect(taskHost.configureSdkProvider({ config: CONFIG, credential: "synthetic-key" })).rejects.toThrow("sdk-binding-invalid");
  // A refused install must not leave a dead context installed, and the task
  // must fall back to the fail-closed no-provider behaviour.
  expect(taskHost.sdkProviderConfigured).toBe(false);
  expect(taskHost.sdkTextKernel().configured).toBe(false);
  expect(refusing.calls).toEqual(["open", "dispose"]);
  await expect(taskHost.sdkTextKernel().open("main")).rejects.toThrow("provider-not-configured");
  await expect(taskHost.sdkTextKernel().prompt("main", "hello")).rejects.toThrow("provider-not-configured");
  expect(refusing.calls).toEqual(["open", "dispose"]);
});

it("clearing the selection disposes the context and restores the fail-closed path", async () => {
  const dir = task("task-a");
  const installed = fakeContext();
  const taskHost = host(dir, [installed.client]);
  await taskHost.configureSdkProvider({ config: CONFIG, credential: "synthetic-key" });
  expect(await taskHost.configureSdkProvider(null)).toEqual({ generation: 2 });
  expect(installed.calls).toEqual(["open", "dispose"]);
  expect(taskHost.sdkProviderConfigured).toBe(false);
  await expect(taskHost.sdkTextKernel().open("main")).rejects.toThrow("provider-not-configured");
  // Projections stay available without a provider: the SDK JSONL stays readable.
  expect(taskHost.sdkTextKernel().projection("main").source).toBe("sdk-jsonl");
});

it("shares shutdown failure after clearing the context and refuses provider reinstall", async () => {
  const installed = fakeContext(); installed.client.dispose = vi.fn(async () => { throw Error("synthetic-private-error"); });
  const taskHost = host(task("task-a"), [installed.client]); await taskHost.configureSdkProvider({ config: CONFIG, credential: "synthetic-key" });
  const first = taskHost.shutdownSdk(); expect(taskHost.shutdownSdk()).toBe(first);
  await expect(first).rejects.toThrow("sdk-host-shutdown-unconfirmed");
  await expect(taskHost.shutdownSdk()).rejects.toThrow("sdk-host-shutdown-unconfirmed");
  await expect(taskHost.configureSdkProvider({ config: CONFIG, credential: "synthetic-key" })).rejects.toThrow("sdk-host-closing");
  expect(installed.client.dispose).toHaveBeenCalledTimes(1); expect(taskHost.sdkTextKernel().configured).toBe(false);
});
it("cleans a late provider open without attaching it after shutdown", async () => {
  const installed = fakeContext(); let release!: () => void;
  installed.client.open = vi.fn(() => new Promise<{ sdkId: string; file: string; tools: string[] }>((resolve) => { release = () => resolve({ sdkId: "late", file: "/tmp/late", tools: [] }); }));
  const taskHost = host(task("task-a"), [installed.client]); const configuring = taskHost.configureSdkProvider({ config: CONFIG, credential: "synthetic-key" });
  const rejected = expect(configuring).rejects.toThrow("sdk-host-closing");
  const first = taskHost.shutdownSdk(); let settled = false; void first.then(() => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false); expect(taskHost.sdkTextKernel().configured).toBe(false);
  await expect(taskHost.configureSdkProvider(null)).rejects.toThrow("sdk-host-closing");
  release(); await rejected; await first; expect(installed.client.dispose).toHaveBeenCalledTimes(1); expect(taskHost.sdkProviderConfigured).toBe(false);
});
it("refuses overlapping provider installation before creating another context", async () => {
  const installed = fakeContext(); let release!: () => void;
  installed.client.open = vi.fn(() => new Promise<{ sdkId: string; file: string; tools: string[] }>((resolve) => { release = () => resolve({ sdkId: "late", file: "/tmp/late", tools: [] }); }));
  const taskHost = host(task("task-a"), [installed.client]); const first = taskHost.configureSdkProvider({ config: CONFIG, credential: "synthetic-key" });
  await expect(taskHost.configureSdkProvider(null)).rejects.toThrow("sdk-provider-operation-in-flight");
  release(); await first; await taskHost.shutdownSdk(); expect(installed.client.open).toHaveBeenCalledTimes(1);
});
it("bounds a pending bootstrap and refuses late attachment without repairing the failed receipt", async () => {
  vi.useFakeTimers();
  try {
    const installed = fakeContext(); let release!: () => void;
    installed.client.open = vi.fn(() => new Promise<{ sdkId: string; file: string; tools: string[] }>((resolve) => { release = () => resolve({ sdkId: "late", file: "/tmp/late", tools: [] }); }));
    const taskHost = host(task("task-a"), [installed.client]); const configuring = taskHost.configureSdkProvider({ config: CONFIG, credential: "synthetic-key" });
    const refused = expect(configuring).rejects.toThrow("sdk-host-closing"), first = taskHost.shutdownSdk(), failed = expect(first).rejects.toThrow("sdk-host-shutdown-unconfirmed");
    await vi.advanceTimersByTimeAsync(30_001); await failed;
    release(); await refused; expect(installed.client.dispose).toHaveBeenCalledTimes(1);
    expect(taskHost.shutdownSdk()).toBe(first); await expect(taskHost.shutdownSdk()).rejects.toThrow("sdk-host-shutdown-unconfirmed"); expect(taskHost.sdkProviderConfigured).toBe(false);
  } finally { vi.useRealTimers(); }
});
it("does not erase a failed previous context disposal during provider replacement", async () => {
  const installed = fakeContext(); installed.client.dispose = vi.fn(async () => { throw Error("unknown-worker"); });
  const next = fakeContext(), taskHost = host(task("task-a"), [installed.client, next.client]);
  await taskHost.configureSdkProvider({ config: CONFIG, credential: "synthetic-key" });
  await expect(taskHost.configureSdkProvider({ config: CONFIG, credential: "synthetic-key" })).rejects.toThrow("sdk-host-shutdown-unconfirmed");
  await expect(taskHost.configureSdkProvider(null)).rejects.toThrow("sdk-host-shutdown-unconfirmed");
  await expect(taskHost.shutdownSdk()).rejects.toThrow("sdk-host-shutdown-unconfirmed"); expect(next.client.open).not.toHaveBeenCalled();
});
it("preserves channels and approval claims if disposal cannot confirm SDK shutdown", async () => {
  const installed = fakeContext(), dir = task("task-a"), taskHost = host(dir, [installed.client]);
  await taskHost.configureSdkProvider({ config: CONFIG, credential: "synthetic-key" });
  taskHost.openSession("main", { permission: "default" });
  const turn = taskHost.sendMessage("main", "pending", { tool: "exec.run", target: `${dir}/run.sh`, execute: (call) => ({ tool: call.tool, kind: call.kind, target: call.target, contentVersion: call.contentVersion, output: "fixture" }) });
  expect(turn.state).toBe("approval"); installed.client.dispose = vi.fn(async () => { throw Error("synthetic-shutdown-failure"); });
  const closing = taskHost.dispose(); await expect(closing).rejects.toThrow("sdk-host-shutdown-unconfirmed");
  expect(taskHost.dispose()).toBe(closing); expect(taskHost.writeLockOwner).toBe("main"); expect(taskHost.getApproval(turn.approvalId!)?.status).toBe("pending");
  expect(taskHost.describe().maxSeq).toBeGreaterThan(0); expect(installed.client.dispose).toHaveBeenCalledTimes(1);
});
it("seals the installed SDK handle and rejects late provider attachment without full shutdown", async () => {
  const installed = fakeContext(), taskHost = host(task("task-a"), [installed.client]);
  await taskHost.configureSdkProvider({ config: CONFIG, credential: "synthetic-key" }); taskHost.sealExecution();
  expect(installed.client.seal).toHaveBeenCalledTimes(1);
  await expect(taskHost.configureSdkProvider(null)).rejects.toThrow("task-host-closing"); await taskHost.shutdownSdk();
  const pending = fakeContext(); let release!: () => void;
  pending.client.open = vi.fn(() => new Promise<Awaited<ReturnType<SdkContextClient["open"]>>>((resolve) => { release = () => resolve({ sdkId: "late", file: "/tmp/late", tools: [] }); }));
  const lateHost = host(task("task-b"), [pending.client]), opening = lateHost.configureSdkProvider({ config: CONFIG, credential: "synthetic-key" });
  const refused = expect(opening).rejects.toThrow("task-host-closing"); lateHost.sealExecution(); release(); await refused;
  expect(lateHost.sdkProviderConfigured).toBe(false); expect(pending.client.dispose).toHaveBeenCalledTimes(1); await lateHost.shutdownSdk();
});
it("refuses an unusable credential or configuration before any context exists", async () => {
  const dir = task("task-a");
  const never = vi.fn(() => { throw new Error("must not spawn"); });
  const taskHost = new TaskWorkspaceHost("task-a", dir, memoryTaskStore(), () => "2026-09-22T10:00:00+08:00", () => [], undefined, undefined, undefined, undefined, undefined, undefined, never as never);
  for (const credential of ["", "short", "x".repeat(4097)]) {
    await expect(taskHost.configureSdkProvider({ config: CONFIG, credential })).rejects.toThrow("provider-not-configured");
  }
  // The config is re-validated by the client itself, so an http:// endpoint is refused.
  await expect(taskHost.configureSdkProvider({ config: { ...CONFIG, baseUrl: "http://models.example.test/v1" }, credential: "synthetic-key" })).rejects.toThrow("provider-endpoint-invalid");
  expect(never).not.toHaveBeenCalled();
  expect(taskHost.sdkProviderConfigured).toBe(false);
});
