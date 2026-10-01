import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildTaskDiskRecord, serializeTaskRecord } from "./task-store.js";
import { SdkContextClient, type SdkContextWorkerLike } from "./sdk-context-client.js";
import { isCredentialEnvName } from "./explicit-text-provider.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });

function task(id: string) {
  const root = mkdtempSync(join(tmpdir(), "pidock-sdk-context-"));
  roots.push(root);
  const dir = join(root, id);
  mkdirSync(dir);
  execFileSync("git", ["init", "-q", dir], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TEMPLATE_DIR: "" } });
  writeFileSync(join(dir, "task.json"), serializeTaskRecord(buildTaskDiskRecord({
    taskId: id, name: id, dirId: id, branch: "main", root, taskDir: dir,
    remoteBranch: "main", baseCommit: "test", repos: [], now: new Date().toISOString(),
  })));
  return dir;
}

const config = {
  profileId: "explicit", baseUrl: "https://api.example.com/v1", modelId: "fixture", contextWindow: 2048, maxTokens: 128,
  authRef: "PIDOCK_PROVIDER_TEST", generation: 1,
};

/** Scripted worker: records what it was spawned with and answers by op. */
function scripted(options: { failBootstrap?: string; malformedOpen?: boolean; onPrompt?: (send: (message: unknown) => void, id: string) => void; replyKind?: string; silentBootstrap?: boolean } = {}) {
  const spawned: { env: Record<string, string>; workerData: unknown }[] = [];
  const listeners = { message: [] as ((message: unknown) => void)[], error: [] as ((error: unknown) => void)[], exit: [] as ((code: number) => void)[] };
  let booted = false;
  const send = (out: unknown) => { for (const listener of listeners.message) listener(out); };
  // A real worker announces itself at startup, before the first request.
  const boot = () => {
    if (booted) return;
    booted = true;
    if (options.silentBootstrap) return;
    queueMicrotask(() => options.failBootstrap
      ? send({ id: "ready", kind: "reply", ok: false, error: options.failBootstrap })
      : send({ id: "ready", kind: "reply", ok: true, payload: { ready: true, bindingIdentity: "b".repeat(64) } }));
  };
  const worker: SdkContextWorkerLike = {
    postMessage(message: unknown) {
      const request = message as { id: string; op: string };
      if (options.replyKind) { send({ id: request.id, kind: options.replyKind, payload: { secret: "unexpected" } }); return; }
      if (request.op === "open") send(options.malformedOpen ? { id: request.id, kind: "reply", ok: true, payload: { sdkId: 1 } } : { id: request.id, kind: "reply", ok: true, payload: { sdkId: "sdk-1", file: "/tmp/sdk-1.jsonl", tools: [] } });
      if (request.op === "prompt") {
        if (options.onPrompt) options.onPrompt(send, request.id);
        else { send({ id: request.id, kind: "event", event: { type: "delta", text: "hi", taskId: "t", sessionId: "main", turnId: "a".repeat(36), sequence: 1 } }); send({ id: request.id, kind: "reply", ok: true, payload: { state: "done", text: "hi" } }); }
      }
      if (request.op === "cancel") send({ id: request.id, kind: "reply", ok: true, payload: { cancelled: true } });
      if (request.op === "dispose") send({ id: request.id, kind: "reply", ok: true, payload: { disposed: true } });
    },
    on(event: "message" | "error" | "exit", listener: never) { (listeners[event] as unknown[]).push(listener); if (event === "message") boot(); return worker; },
    terminate() { return Promise.resolve(0); },
  };
  return { worker, spawned, send };
}

it("dispatches a credential-free environment and passes the credential only as worker input", async () => {
  const dir = task("task-context-env");
  const explicitKey = "SYNTHETIC_EXPLICIT_KEY_46";
  // Simulate a developer/host process full of ambient credentials.
  vi.stubEnv("OPENAI_API_KEY", "SYNTHETIC_AMBIENT_KEY_46");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "SYNTHETIC_AMBIENT_KEY_47");
  vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:9");
  vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
  const probe = scripted();
  const client = new SdkContextClient({
    task: { taskId: "task-context-env", taskDir: dir }, config, credential: explicitKey, workspaceId: "workspace-a",
    spawn: (env, workerData) => { probe.spawned.push({ env, workerData }); return probe.worker; },
  });
  try {
    await client.open("main");
    expect(probe.spawned).toHaveLength(1);
    const { env, workerData } = probe.spawned[0]!;
    expect(env).toMatchObject({ PIDOCK_SDK_ISOLATED: "1", PIDOCK_TASK_ID: "task-context-env", PIDOCK_TASK_DIR: dir, PIDOCK_WORKSPACE_ID: "workspace-a" });
    expect(env["HOME"]).toBe(join(dir, ".pidock-sdk-context-home"));
    for (const name of Object.keys(env)) {
      expect(isCredentialEnvName(name)).toBe(false);
      expect(["OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "HTTP_PROXY", "ELECTRON_RUN_AS_NODE"]).not.toContain(name);
    }
    expect(Object.values(env)).not.toContain(explicitKey);
    expect(JSON.stringify(workerData)).toContain(explicitKey);
    expect(workerData).toMatchObject({ task: { taskId: "task-context-env", taskDir: dir }, config });
  } finally {
    await client.dispose();
    vi.unstubAllEnvs();
  }
});

it("forwards streamed events in order and returns only bounded turn results", async () => {
  const dir = task("task-context-stream");
  const probe = scripted();
  const client = new SdkContextClient({
    task: { taskId: "task-context-stream", taskDir: dir }, config, credential: "synthetic-key",
    spawn: (env, workerData) => { probe.spawned.push({ env, workerData }); return probe.worker; },
  });
  const seen: string[] = [];
  const result = await client.prompt("main", "hello", (event) => seen.push(`${event.sequence}:${event.type}`));
  expect(seen).toEqual(["1:delta"]);
  expect(result).toEqual({ state: "done", text: "hi", events: [] });
  // A throwing event receiver must not fail the model turn or the protocol.
  const tolerant = await client.prompt("main", "hello", () => { throw new Error("receiver"); });
  expect(tolerant.state).toBe("done");
  await client.dispose();
});

it("poisons the context on bootstrap failure, worker error, exit and malformed replies", async () => {
  const dir = task("task-context-failure");
  const bootstrap = scripted({ failBootstrap: "provider-configuration-invalid" });
  const failed = new SdkContextClient({
    task: { taskId: "task-context-failure", taskDir: dir }, config, credential: "synthetic-key",
    spawn: (env, workerData) => { bootstrap.spawned.push({ env, workerData }); return bootstrap.worker; },
  });
  await expect(failed.open("main")).rejects.toThrow("provider-configuration-invalid");
  await expect(failed.prompt("main", "hello")).rejects.toThrow("provider-configuration-invalid");
  await failed.dispose();

  const malformed = scripted({ malformedOpen: true });
  const guessing = new SdkContextClient({
    task: { taskId: "task-context-failure", taskDir: dir }, config, credential: "synthetic-key",
    spawn: (env, workerData) => { malformed.spawned.push({ env, workerData }); return malformed.worker; },
  });
  await expect(guessing.open("main")).rejects.toThrow("sdk-context-reply-invalid");
  await guessing.dispose();

  const poisoned = scripted();
  const client = new SdkContextClient({
    task: { taskId: "task-context-failure", taskDir: dir }, config, credential: "synthetic-key",
    spawn: (env, workerData) => { poisoned.spawned.push({ env, workerData }); return poisoned.worker; },
  });
  await client.open("main");
  await client.dispose();
  await expect(client.prompt("main", "hello")).rejects.toThrow(/sdk-context-(disposed|exit)/);
});

it("poisons an unusable protocol instead of hanging the caller", async () => {
  const dir = task("task-context-protocol");
  const hostile = scripted({ replyKind: "sdk-secret-dump" });
  const client = new SdkContextClient({
    task: { taskId: "task-context-protocol", taskDir: dir }, config, credential: "synthetic-key",
    spawn: (env, workerData) => { hostile.spawned.push({ env, workerData }); return hostile.worker; },
  });
  await expect(client.open("main")).rejects.toThrow("sdk-context-protocol-invalid");
  await expect(client.prompt("main", "hello")).rejects.toThrow("sdk-context-protocol-invalid");
  await client.dispose();

  // A worker that never announces itself must not hold a turn open forever.
  const silent = scripted({ silentBootstrap: true });
  const waiting = new SdkContextClient({
    task: { taskId: "task-context-protocol", taskDir: dir }, config, credential: "synthetic-key", readyTimeoutMs: 30,
    spawn: (env, workerData) => { silent.spawned.push({ env, workerData }); return silent.worker; },
  });
  await expect(waiting.open("main")).rejects.toThrow("sdk-context-bootstrap-timeout");
  await expect(waiting.cancel("main")).rejects.toThrow("sdk-context-bootstrap-timeout");
  await waiting.dispose();
  // Dispose is idempotent.
  await expect(client.dispose()).resolves.toBeUndefined();
});

it("shares a sticky dispose receipt and seals prompt/cancel immediately", async () => {
  const probe = scripted(), terminate = vi.fn(async () => 0); probe.worker.terminate = terminate;
  const client = new SdkContextClient({ task: { taskId: "task-close", taskDir: task("task-close") }, config, credential: "synthetic-key", spawn: () => probe.worker });
  await client.open("main"); const first = client.dispose(); expect(client.dispose()).toBe(first);
  await expect(client.prompt("main", "late")).rejects.toThrow(/sdk-context-(closing|disposed)/);
  await expect(client.cancel("main")).rejects.toThrow(/sdk-context-(closing|disposed)/);
  await first; expect(client.dispose()).toBe(first); expect(terminate).toHaveBeenCalledTimes(1);
});
it("retains a silent graceful shutdown failure even after confirmed termination and late reply", async () => {
  const probe = scripted(), original = probe.worker.postMessage.bind(probe.worker); let late: unknown;
  probe.worker.postMessage = (message) => { if ((message as { op: string }).op === "dispose") { late = message; return; } original(message); };
  const terminate = vi.fn(async () => 0); probe.worker.terminate = terminate;
  const client = new SdkContextClient({ task: { taskId: "task-close", taskDir: task("task-close") }, config, credential: "synthetic-key", spawn: () => probe.worker, shutdownTimeoutMs: 10 });
  await client.open("main"); const first = client.dispose(); await expect(first).rejects.toThrow("sdk-context-shutdown-unconfirmed");
  expect(late).toBeDefined(); probe.send({ id: (late as { id: string }).id, kind: "reply", ok: true, payload: { disposed: true } });
  await expect(client.dispose()).rejects.toThrow("sdk-context-shutdown-unconfirmed"); expect(client.dispose()).toBe(first); expect(terminate).toHaveBeenCalledTimes(1);
});
it.each(["throw", "pending", "invalid"])("refuses %s termination and never retries it as success", async (mode) => {
  const probe = scripted(), terminate = vi.fn(() => mode === "throw" ? Promise.reject(Error("synthetic-private-error")) : mode === "pending" ? new Promise<number>(() => {}) : Promise.resolve(NaN)); probe.worker.terminate = terminate;
  const client = new SdkContextClient({ task: { taskId: "task-close", taskDir: task("task-close") }, config, credential: "synthetic-key", spawn: () => probe.worker, shutdownTimeoutMs: 10 });
  await client.open("main"); const first = client.dispose(); await expect(first).rejects.toThrow("sdk-context-shutdown-unconfirmed");
  await expect(client.dispose()).rejects.toThrow("sdk-context-shutdown-unconfirmed"); expect(client.dispose()).toBe(first); expect(terminate).toHaveBeenCalledTimes(1);
});
it("rejects malformed or extra graceful-dispose fields without leaking peer detail", async () => {
  for (const payload of [{ disposed: false }, { disposed: true, extra: "synthetic-private-detail" }]) {
    const probe = scripted(), original = probe.worker.postMessage.bind(probe.worker);
    probe.worker.postMessage = (message) => {
      const request = message as { id: string; op: string };
      if (request.op === "dispose") probe.send({ id: request.id, kind: "reply", ok: true, payload }); else original(message);
    };
    const client = new SdkContextClient({ task: { taskId: "task-close", taskDir: task("task-close") }, config, credential: "synthetic-key", spawn: () => probe.worker });
    await client.open("main"); await expect(client.dispose()).rejects.toThrow(/^sdk-context-shutdown-unconfirmed$/);
    await expect(client.dispose()).rejects.toThrow(/^sdk-context-shutdown-unconfirmed$/);
  }
});
it("rejects unusable shutdown deadlines before spawn", () => {
  for (const shutdownTimeoutMs of [0, 9, 60_001, NaN, 1.5]) expect(() => new SdkContextClient({ task: { taskId: "task-close", taskDir: "/not-used" }, config, credential: "synthetic-key", shutdownTimeoutMs })).toThrow("invalid-shutdown-deadline");
});
it("refuses an unusable selection before any context exists", () => {
  const dir = task("task-context-guard");
  expect(() => new SdkContextClient({ task: { taskId: "task-context-guard", taskDir: dir }, config, credential: "" })).toThrow("provider-not-configured");
  expect(() => new SdkContextClient({ task: { taskId: "task-context-guard", taskDir: dir }, config, credential: "short" })).toThrow("provider-not-configured");
  expect(() => new SdkContextClient({ task: { taskId: "task-context-guard", taskDir: dir }, config, credential: "x".repeat(4097) })).toThrow("provider-not-configured");
  expect(() => new SdkContextClient({ task: { taskId: "task-context-guard", taskDir: dir }, config: { ...config, modelId: "" }, credential: "synthetic-key" })).toThrow("provider-configuration-invalid");
  expect(() => new SdkContextClient({ task: { taskId: "task-context-guard", taskDir: dir }, config: { ...config, baseUrl: "http://example.com/v1" }, credential: "synthetic-key" })).toThrow("provider-endpoint-invalid");
  expect(() => new SdkContextClient({ task: { taskId: "task-context-guard", taskDir: dir }, config: { ...config, authRef: "OPENAI_API_KEY" }, credential: "synthetic-key" })).toThrow("provider-configuration-invalid");
});
