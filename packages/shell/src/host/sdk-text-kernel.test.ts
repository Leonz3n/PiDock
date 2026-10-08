import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, afterAll, expect, it, vi } from "vitest";
import type { AssistantMessage, Model, Provider } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { buildTaskDiskRecord, serializeTaskRecord } from "./task-store.js";
import { PiSdkTextKernel, type SdkTextEvent } from "./sdk-text-kernel.js";
import { createExplicitTextRuntime, isCredentialEnvName } from "./explicit-text-provider.js";
import { SdkTurnTransport } from "./sdk-turn-transport.js";
import { TaskWorkspaceHost } from "./task-host.js";

const roots: string[] = [];
// The explicit Provider runtime only exists in an isolated environment (see
// `assertIsolatedSdkEnvironment`). This file constructs that precondition for
// itself — flag on, ambient credentials removed — and restores the real
// environment afterwards, so the suite never depends on the developer's shell.
const savedIsolation = process.env["PIDOCK_SDK_ISOLATED"];
const savedCredentials = Object.entries(process.env).filter(([name]) => isCredentialEnvName(name)) as [string, string][];
beforeAll(() => {
  process.env["PIDOCK_SDK_ISOLATED"] = "1";
  for (const [name] of savedCredentials) delete process.env[name];
});
afterAll(() => {
  if (savedIsolation === undefined) delete process.env["PIDOCK_SDK_ISOLATED"];
  else process.env["PIDOCK_SDK_ISOLATED"] = savedIsolation;
  for (const [name, value] of savedCredentials) process.env[name] = value;
});
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });

function task(id: string) {
  const root = mkdtempSync(join(tmpdir(), "pidock-sdk-"));
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

const model: Model<"pidock-local-test"> = {
  id: "fixture", name: "Fixture", api: "pidock-local-test", provider: "local-test",
  baseUrl: "http://127.0.0.1/unused", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 2048, maxTokens: 128,
};
const usage = { input: 4, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 7,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function kernel(dir: string, onPrompt?: (texts: string[]) => string, selectedModel: Model<"pidock-local-test"> = model) {
  const runtime = await ModelRuntime.create({ authPath: join(dir, ".private-auth.json"), modelsPath: join(dir, ".private-models.json"), refreshOnCreate: false });
  const seen: string[][] = [];
  const provider: Provider<"pidock-local-test"> = {
    id: model.provider, name: "Isolated local test", auth: { apiKey: { name: "Local", resolve: async () => ({ auth: {} }) } },
    getModels: () => [model],
    stream: (_model, context, options) => provider.streamSimple(_model, context, options),
    streamSimple: (_model, context, options) => {
      const messages = context.messages.map((message) => message.role === "user" ?
        (typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("")) : "assistant");
      seen.push(messages);
      const stream = createAssistantMessageEventStream();
      const response = onPrompt?.(messages) ?? "hello";
      const partial: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [], usage, stopReason: "pending", timestamp: Date.now() };
      queueMicrotask(() => {
        stream.push({ type: "start", partial });
        if (response === "wait") {
          options?.signal?.addEventListener("abort", () => stream.push({ type: "error", reason: "aborted", error: { ...partial, stopReason: "aborted", errorMessage: "aborted" } }), { once: true });
          return;
        }
        if (response === "error") {
          stream.push({ type: "error", reason: "error", error: { ...partial, stopReason: "error", errorMessage: "fake failure" } });
          return;
        }
        if (response === "attempt-tool") {
          const toolCall = { type: "toolCall" as const, id: "fake-call", name: "write", arguments: { path: "source.txt", content: "modified" } };
          stream.push({ type: "toolcall_start", contentIndex: 0, partial });
          partial.content.push(toolCall);
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
          stream.push({ type: "done", reason: "toolUse", message: { ...partial, stopReason: "toolUse" } });
          return;
        }
        stream.push({ type: "text_start", contentIndex: 0, partial });
        const text = { type: "text" as const, text: response };
        partial.content.push(text);
        if (response) stream.push({ type: "text_delta", contentIndex: 0, delta: response, partial });
        stream.push({ type: "text_end", contentIndex: 0, content: response, partial });
        stream.push({ type: "done", reason: "stop", message: { ...partial, stopReason: "stop" } });
      });
      return stream;
    },
  };
  runtime.registerNativeProvider(provider);
  return { instance: new PiSdkTextKernel(JSON.parse(readFileSync(join(dir, "task.json"), "utf8")).taskId, dir, { model: selectedModel, modelRuntime: runtime }), seen };
}

it("distinguishes a live pending SDK user entry from a cold interrupted entry", async () => {
  const dir = task("task-projection-state");
  const fake = await kernel(dir, () => "wait");
  const transport = new SdkTurnTransport("task-projection-state", dir, fake.instance);
  const ack = await transport.start("main", "req1", "waiting", () => {});
  await vi.waitFor(() => expect(transport.projection("main")).toMatchObject({ pending: true, interrupted: false, messages: [{ role: "user", text: "waiting" }] }));
  await transport.cancel("main", ack.turnId);
  await fake.instance.dispose();
  const reopened = await kernel(dir);
  const opened = await reopened.instance.open("main");
  await reopened.instance.dispose();
  SessionManager.open(opened.file, join(dir, ".pidock-sdk-sessions", "main"), dir)
    .appendMessage({ role: "user", content: "crashed", timestamp: Date.now() });
  const cold = new SdkTurnTransport("task-projection-state", dir, new PiSdkTextKernel("task-projection-state", dir));
  expect(cold.projection("main")).toMatchObject({ pending: false, interrupted: true, messages: expect.arrayContaining([{ role: "user", text: "crashed", usage: null }]) });
});

it("journals ACK before prompt, deduplicates lost ACK and reads exact SDK JSONL", async () => {
  const dir = task("task-transport");
  const fake = await kernel(dir);
  const transport = new SdkTurnTransport("task-transport", dir, fake.instance);
  const events: SdkTextEvent[] = [];
  const ack = await transport.start("main", "req1", "only once", (event) => events.push(event));
  expect(ack).toMatchObject({ state: "accepted", requestId: "req1", taskId: "task-transport", sessionId: "main" });
  expect(await transport.start("main", "req1", "only once", (event) => events.push(event))).toMatchObject({ turnId: ack.turnId });
  await vi.waitFor(() => expect(transport.status("main", "req1")).toMatchObject({ state: "done", turnId: ack.turnId, lastSequence: 3 }));
  expect(fake.seen).toHaveLength(1);
  expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
  expect(events.every((event) => event.turnId === ack.turnId)).toBe(true);
  expect(transport.projection("main")).toMatchObject({ source: "sdk-jsonl", messages: [
    { role: "user", text: "only once" }, { role: "assistant", text: "hello", usage: { input: 4, output: 2 } },
  ] });
  await fake.instance.dispose();
  const reopened = await kernel(dir);
  const cold = new SdkTurnTransport("task-transport", dir, reopened.instance);
  expect(cold.status("main", "req1")).toMatchObject({ state: "done", turnId: ack.turnId });
  await expect(cold.start("main", "req1", "changed text", () => {})).rejects.toThrow("idempotency-mismatch");
  expect(reopened.seen).toHaveLength(0);
  await reopened.instance.dispose();
});

it("never replays a cold accepted turn, rejects hostile payload and turn-matches abort", async () => {
  const dir = task("task-transport");
  const pending = await kernel(dir, () => "wait");
  const transport = new SdkTurnTransport("task-transport", dir, pending.instance);
  const ack = await transport.start("main", "req1", "wait", () => {});
  await expect(transport.cancel("other", ack.turnId)).rejects.toThrow("sdk-turn-not-active");
  await expect(transport.cancel("main", "unrelated")).rejects.toThrow("sdk-turn-not-active");
  expect(await transport.cancel("main", ack.turnId)).toMatchObject({ state: "cancelled", turnId: ack.turnId });
  await pending.instance.dispose();
  const journal = join(dir, ".pidock-sdk-turns", "main", "req1.json");
  const recorded = JSON.parse(readFileSync(journal, "utf8"));
  writeFileSync(journal, JSON.stringify({ ...recorded, state: "accepted" }));
  const reopened = await kernel(dir);
  const cold = new SdkTurnTransport("task-transport", dir, reopened.instance);
  expect(cold.status("main", "req1")).toMatchObject({ state: "interrupted", needsResync: true });
  expect(await cold.start("main", "req1", "wait", () => {})).toMatchObject({ state: "interrupted", turnId: ack.turnId });
  expect(reopened.seen).toHaveLength(0);
  await reopened.instance.dispose();
});

it("releases start lock after journal failure and keeps terminal callback failures queryable", async () => {
  const dir = task("task-transport");
  const fake = await kernel(dir);
  const transport = new SdkTurnTransport("task-transport", dir, fake.instance);
  const journal = join(dir, ".pidock-sdk-turns");
  writeFileSync(journal, "invalid");
  await expect(transport.start("main", "bad", "hello", () => {})).rejects.toThrow("sdk-journal-invalid");
  rmSync(journal);
  const ack = await transport.start("main", "good", "hello", () => {}, () => { throw new Error("port-closed"); });
  await vi.waitFor(() => expect(transport.status("main", "good")).toMatchObject({ state: "done", needsResync: true, turnId: ack.turnId }));
  expect(fake.seen).toHaveLength(1);
  await fake.instance.dispose();
});

it("flags an oversized full event envelope and preserves a queryable failed status", async () => {
  const dir = task("task-transport");
  const fake = await kernel(dir, () => "x".repeat(16_350));
  const transport = new SdkTurnTransport("task-transport", dir, fake.instance);
  await transport.start("main", "oversized", "hello", () => {});
  await vi.waitFor(() => expect(transport.status("main", "oversized")).toMatchObject({ state: "failed", needsResync: true, error: "sdk-event-delivery-failed" }));
  await fake.instance.dispose();
});

it("blocks the next model turn until an uncommitted terminal journal is repaired", async () => {
  const dir = task("task-terminal-recovery");
  const fake = await kernel(dir);
  let failTerminalSync = true;
  let syncs = 0;
  const transport = new SdkTurnTransport("task-terminal-recovery", dir, fake.instance, () => {
    if (++syncs > 1 && failTerminalSync) throw new Error("fsync-failed");
  });
  const first = await transport.start("main", "first", "hello", () => {});
  await vi.waitFor(() => expect(transport.status("main", "first")).toMatchObject({ turnId: first.turnId, state: "interrupted", error: "sdk-turn-journal-uncommitted", needsResync: true }));
  expect(() => transport.assertTerminalCommitted()).toThrow("sdk-turn-journal-uncommitted");
  expect(await transport.start("main", "first", "hello", () => {})).toMatchObject({ state: "interrupted", turnId: first.turnId });
  await expect(transport.start("main", "second", "again", () => {})).rejects.toThrow("sdk-turn-journal-uncommitted");
  expect(fake.seen).toHaveLength(1);
  failTerminalSync = false;
  expect(transport.reconcileTerminal()).toMatchObject({ turnId: first.turnId, state: "done" });
  expect(transport.status("main", "first")).toMatchObject({ turnId: first.turnId, state: "done" });
  await transport.start("main", "second", "again", () => {});
  await vi.waitFor(() => expect(transport.status("main", "second")).toMatchObject({ state: "done" }));
  expect(fake.seen).toHaveLength(2);
  await fake.instance.dispose();
});

it("blocks turns when terminal publication and its resync journal rewrite both fail", async () => {
  const dir = task("task-publish-recovery");
  const fake = await kernel(dir);
  let failRewrite = true;
  let syncs = 0;
  const transport = new SdkTurnTransport("task-publish-recovery", dir, fake.instance, () => {
    if (++syncs >= 3 && failRewrite) throw new Error("fsync-failed");
  });
  const first = await transport.start("main", "first", "hello", () => {}, () => { throw new Error("port-closed"); });
  await vi.waitFor(() => expect(transport.status("main", "first")).toMatchObject({
    turnId: first.turnId, state: "interrupted", error: "sdk-turn-journal-uncommitted", needsResync: true,
  }));
  await expect(transport.start("main", "second", "again", () => {})).rejects.toThrow("sdk-turn-journal-uncommitted");
  expect(fake.seen).toHaveLength(1);
  failRewrite = false;
  expect(transport.reconcileTerminal()).toMatchObject({ state: "done", needsResync: true });
  expect(transport.status("main", "first")).toMatchObject({ state: "done", needsResync: true });
  await transport.start("main", "second", "again", () => {});
  await vi.waitFor(() => expect(transport.status("main", "second")).toMatchObject({ state: "done" }));
  expect(fake.seen).toHaveLength(2);
  await fake.instance.dispose();
});

it("reports a journal directory sync failure without ACK or replaying the reserved request", async () => {
  const dir = task("task-transport");
  const fake = await kernel(dir);
  const failing = new SdkTurnTransport("task-transport", dir, fake.instance, () => { throw new Error("fsync-failed"); });
  await expect(failing.start("main", "req1", "hello", () => {})).rejects.toThrow("sdk-journal-sync-failed");
  expect(failing.status("main", "req1")).toMatchObject({ state: "interrupted", needsResync: true });
  const retry = new SdkTurnTransport("task-transport", dir, fake.instance);
  expect(await retry.start("main", "req1", "hello", () => {})).toMatchObject({ state: "interrupted", needsResync: true });
  expect(fake.seen).toHaveLength(0);
  await fake.instance.dispose();
});

it("keeps provider-not-configured readable but refuses acceptance and source writes", async () => {
  const dir = task("task-transport");
  const source = join(dir, "source.txt");
  writeFileSync(source, "original");
  const transport = new SdkTurnTransport("task-transport", dir, new PiSdkTextKernel("task-transport", dir));
  expect(transport.projection("main")).toMatchObject({ messages: [] });
  await expect(transport.start("main", "req1", "hello", () => {})).rejects.toThrow("provider-not-configured");
  expect(transport.status("main", "req1")).toBeNull();
  expect(readFileSync(source, "utf8")).toBe("original");
});

it("refuses unconfigured production selection without touching global auth", async () => {
  const dir = task("task-a");
  const instance = new PiSdkTextKernel("task-a", dir);
  await expect(instance.prompt("main", "hi")).rejects.toThrow("provider-not-configured");
  await expect(instance.open("main")).rejects.toThrow("provider-not-configured");
});

it("reopens the exact empty SDK session after dispose or a pre-reply crash", async () => {
  const dir = task("task-a");
  const initial = await kernel(dir);
  const opened = await initial.instance.open("main");
  const binding = JSON.parse(readFileSync(join(dir, ".pidock-sdk-sessions", "main", "binding.json"), "utf8"));
  expect(binding).toMatchObject({ taskId: "task-a", sessionId: "main", sdkId: opened.sdkId });
  expect(JSON.parse(readFileSync(opened.file, "utf8").split("\n")[0]!)).toMatchObject({ type: "session", id: opened.sdkId, cwd: dir });
  await initial.instance.dispose();
  const afterQuit = await kernel(dir);
  expect(await afterQuit.instance.open("main")).toEqual(opened);
  // Another Host starting before a first reply has the same disk view as a crash.
  const afterCrash = await kernel(dir);
  expect(await afterCrash.instance.open("main")).toEqual(opened);
  expect((await afterCrash.instance.prompt("main", "only prompt")).state).toBe("done");
  expect(afterCrash.seen.at(-1)?.filter((message) => message !== "assistant")).toEqual(["only prompt"]);
  await afterCrash.instance.dispose();
  await afterQuit.instance.dispose();
});

it("does not replay an interrupted user entry on cold reopen", async () => {
  for (const completedFirst of [false, true]) {
    const dir = task(completedFirst ? "task-after-reply" : "task-before-reply");
    const initial = await kernel(dir);
    const opened = await initial.instance.open("main");
    if (completedFirst) await initial.instance.prompt("main", "prior completed");
    await initial.instance.dispose();
    // SDK already flushed the header; this is the journal state after a crash
    // between writing the user message and receiving an assistant response.
    SessionManager.open(opened.file, join(dir, ".pidock-sdk-sessions", "main"), dir)
      .appendMessage({ role: "user", content: "interrupted", timestamp: Date.now() });
    const resumed = await kernel(dir);
    expect((await resumed.instance.open("main")).sdkId).toBe(opened.sdkId);
    expect((await resumed.instance.prompt("main", "fresh prompt")).state).toBe("done");
    expect(resumed.seen.at(-1)).not.toContain("interrupted");
    expect(resumed.seen.at(-1)).toContain("fresh prompt");
    expect(resumed.seen.at(-1)?.includes("prior completed")).toBe(completedFirst);
    await resumed.instance.dispose();
    const secondRestart = await kernel(dir);
    await secondRestart.instance.prompt("main", "next prompt");
    expect(secondRestart.seen.at(-1)).not.toContain("interrupted");
    await secondRestart.instance.dispose();
  }
});

it("binds every callback event to an ordered unique turn and exact task session", async () => {
  const dir = task("task-a");
  const fake = await kernel(dir);
  const callbackEvents: SdkTextEvent[] = [];
  const turns = [
    await fake.instance.prompt("main", "first", (event) => callbackEvents.push(event)),
    await fake.instance.prompt("main", "second", (event) => callbackEvents.push(event)),
    await fake.instance.prompt("other", "separate", (event) => callbackEvents.push(event)),
  ];
  const ids = turns.map((turn) => turn.events[0]?.turnId);
  expect(new Set(ids).size).toBe(3);
  expect(callbackEvents).toEqual(turns.flatMap((turn) => turn.events));
  for (const [index, turn] of turns.entries()) {
    expect(turn.state).toBe("done");
    expect(turn.events.map((event) => event.type)).toEqual(["delta", "message_end", "agent_settled"]);
    expect(turn.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    for (const event of turn.events) expect(event).toMatchObject({ taskId: "task-a", sessionId: index === 2 ? "other" : "main", turnId: ids[index] });
  }
  expect(fake.seen.at(-1)).not.toContain("first");
  await fake.instance.dispose();
});

it("streams real SDK events, persists exact context and never enables tools", async () => {
  const dir = task("task-a");
  const one = await kernel(dir, (texts) => `reply-${texts.filter((x) => x !== "assistant").length}`);
  const opened = await one.instance.open("main");
  expect(opened.tools).toEqual([]);
  const events: string[] = [];
  const first = await one.instance.prompt("main", "first", (event) => events.push(event.type));
  expect(first).toMatchObject({ state: "done", text: "reply-1" });
  expect(events).toContain("delta");
  expect(events).toContain("message_end");
  expect(events).toContain("agent_settled");
  expect(first.events.find((event) => event.type === "message_end")).toMatchObject({ usage: { input: 4, output: 2 } });
  await one.instance.dispose();
  const two = await kernel(dir, () => "reply-again");
  expect(await two.instance.open("main")).toMatchObject({ sdkId: opened.sdkId, file: opened.file, tools: [] });
  expect((await two.instance.prompt("main", "second")).state).toBe("done");
  expect(two.seen.at(-1)).toContain("first");
  expect(two.seen.at(-1)).toContain("second");
  expect((await two.instance.open("other")).tools).toEqual([]);
  await two.instance.prompt("other", "isolated");
  expect(two.seen.at(-1)).not.toContain("first");
  await two.instance.dispose();
});

it("fails closed on copied session bindings, missing JSONL, empty and provider errors", async () => {
  const a = task("task-a");
  const b = task("task-b");
  const first = await kernel(a, () => "hello");
  await first.instance.prompt("main", "seed");
  const firstFile = (await first.instance.open("main")).file;
  await first.instance.dispose();
  const changed = await kernel(a, undefined, { ...model, id: "other-model" });
  await expect(changed.instance.open("main")).rejects.toThrow("sdk-configuration-mismatch");
  await changed.instance.dispose();
  const bKernel = await kernel(b);
  mkdirSync(join(b, ".pidock-sdk-sessions", "main"), { recursive: true });
  writeFileSync(join(b, ".pidock-sdk-sessions", "main", "binding.json"), readFileSync(join(a, ".pidock-sdk-sessions", "main", "binding.json")));
  await expect(bKernel.instance.open("main")).rejects.toThrow("sdk-binding-invalid");
  await bKernel.instance.dispose();
  const corruptDir = task("task-corrupt");
  const corrupt = await kernel(corruptDir);
  await corrupt.instance.open("main");
  await corrupt.instance.dispose();
  writeFileSync(join(corruptDir, ".pidock-sdk-sessions", "main", "binding.json"), "{broken");
  const corruptRestart = await kernel(corruptDir);
  await expect(corruptRestart.instance.open("main")).rejects.toThrow();
  await corruptRestart.instance.dispose();
  const orphanDir = task("task-orphan");
  mkdirSync(join(orphanDir, ".pidock-sdk-sessions", "main"), { recursive: true });
  writeFileSync(join(orphanDir, ".pidock-sdk-sessions", "main", "other.jsonl"), readFileSync(firstFile, "utf8"));
  const orphan = await kernel(orphanDir);
  await expect(orphan.instance.open("main")).rejects.toThrow("sdk-binding-missing");
  await orphan.instance.dispose();
  const missingDir = task("task-missing");
  const missing = await kernel(missingDir);
  const missingSession = await missing.instance.open("main");
  await missing.instance.dispose();
  rmSync(missingSession.file);
  const restarted = await kernel(missingDir);
  await expect(restarted.instance.open("main")).rejects.toThrow("sdk-session-missing");
  await restarted.instance.dispose();
  const foreignDir = task("task-foreign");
  const foreign = await kernel(foreignDir);
  const foreignSession = await foreign.instance.open("main");
  await foreign.instance.dispose();
  const fileContent = readFileSync(foreignSession.file, "utf8");
  writeFileSync(foreignSession.file, fileContent.replace(`"cwd":"${foreignDir}"`, '"cwd":"/foreign-task"'));
  const foreignRestart = await kernel(foreignDir);
  await expect(foreignRestart.instance.open("main")).rejects.toThrow("sdk-binding-invalid");
  await foreignRestart.instance.dispose();
  const empty = await kernel(task("task-empty"), () => "");
  expect((await empty.instance.prompt("main", "empty")).error).toBe("sdk-empty-response");
  await empty.instance.dispose();
  const failed = await kernel(task("task-error"), () => "error");
  expect((await failed.instance.prompt("main", "failure")).state).toBe("failed");
  await failed.instance.dispose();
});

it("refuses disk-backed scripted sends while keeping legacy snapshots readable", async () => {
  const dir = task("task-a");
  const host = new TaskWorkspaceHost("task-a", dir);
  host.openSession("legacy");
  expect(() => host.sendMessage("legacy", "hello")).toThrow("sdk-route-unwired");
  expect(host.openSession("legacy").snapshot().messages).toEqual([]);
  expect(readFileSync(join(dir, "sessions", "legacy.json"), "utf8")).toContain("legacy");
  await host.dispose();
});

it("records production scheduled triggers as failed without a synthetic session", async () => {
  const dir = task("task-a");
  const host = new TaskWorkspaceHost("task-a", dir);
  host.setProviderCatalog([{ id: "local-test", name: "Local test", protocol: "anthropic-messages", baseUrl: "http://127.0.0.1", enabled: true,
    models: [{ id: "fixture", name: "Fixture", contextWindow: 2048 }] }]);
  const saved = host.saveSchedule({ name: "Check", ruleText: "每日 09:15", timezone: "Asia/Shanghai", prompt: "hello",
    providerId: "local-test", model: "fixture", permission: "default", enabled: true });
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.message);
  const run = host.runScheduleNow(saved.schedule.scheduleId);
  expect(run).toMatchObject({ result: "failed" });
  expect(host.sessionIds()).toEqual([]);
  await host.dispose();
});

it("offers no tools even when a local provider emits a write tool call", async () => {
  const dir = task("task-a");
  const source = join(dir, "source.txt");
  writeFileSync(source, "original");
  const fake = await kernel(dir, (texts) => texts.includes("assistant") ? "write unavailable" : "attempt-tool");
  expect((await fake.instance.open("main")).tools).toEqual([]);
  const result = await fake.instance.prompt("main", "write source.txt");
  expect(result.events.some((event) => event.type === "agent_settled")).toBe(true);
  expect(readFileSync(source, "utf8")).toBe("original");
  await fake.instance.dispose();
});

it("aborts a pending SDK stream, guards concurrent task prompts and surfaces callback failure", async () => {
  const dir = task("task-a");
  const pending = await kernel(dir, () => "wait");
  const observed: SdkTextEvent[] = [];
  const run = pending.instance.prompt("main", "wait", (event) => observed.push(event));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await expect(pending.instance.prompt("other", "no")).rejects.toThrow("task-locked");
  await pending.instance.cancel("main");
  const aborted = await run;
  expect(aborted.state).toBe("cancelled");
  expect(observed).toEqual(aborted.events);
  expect(new Set(aborted.events.map((event) => event.turnId)).size).toBe(1);
  for (const event of aborted.events) expect(event).toMatchObject({ taskId: "task-a", sessionId: "main", turnId: aborted.events[0]?.turnId });
  await pending.instance.dispose();
  const callback = await kernel(dir, () => "ok");
  expect((await callback.instance.prompt("different", "hello", () => { throw new Error("receiver"); })).error).toBe("sdk-event-delivery-failed");
  await callback.instance.dispose();
  const abortedCallback = await kernel(dir, () => "wait");
  const failedRun = abortedCallback.instance.prompt("main", "wait", () => { throw new Error("receiver"); });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await abortedCallback.instance.cancel("main");
  expect(await failedRun).toMatchObject({ state: "failed", error: "sdk-event-delivery-failed" });
  await abortedCallback.instance.dispose();
});

it("refuses invalid explicit endpoints and missing keys despite ambient Provider credentials", async () => {
  const base = { profileId: "explicit", baseUrl: "https://api.example.com/v1", modelId: "fixture", contextWindow: 2048, maxTokens: 128, authRef: "PIDOCK_PROVIDER_TEST", generation: 1 };
  vi.stubEnv("OPENAI_API_KEY", "SYNTHETIC_AMBIENT_KEY");
  try {
    await expect(createExplicitTextRuntime(base, "")).rejects.toThrow("provider-not-configured");
    await expect(createExplicitTextRuntime(base, "synthetic-key")).rejects.toThrow("provider-environment-unisolated");
    for (const baseUrl of [
      "http://example.com/v1", "https://user:pass@example.com/v1", "https://example.com/v1?token=x",
      "https://example.com/v1#x", "file:///tmp/model", "not a URL",
    ]) {
      await expect(createExplicitTextRuntime({ ...base, baseUrl }, "synthetic")).rejects.toThrow("provider-endpoint-invalid");
    }
  } finally { vi.unstubAllEnvs(); }
});

it("refuses an explicit SDK runtime without the trusted isolation opt-in", async () => {
  const base = { profileId: "explicit", baseUrl: "https://api.example.com/v1", modelId: "fixture", contextWindow: 2048, maxTokens: 128, authRef: "PIDOCK_PROVIDER_TEST", generation: 1 };
  const saved = process.env["PIDOCK_SDK_ISOLATED"];
  delete process.env["PIDOCK_SDK_ISOLATED"];
  try {
    await expect(createExplicitTextRuntime(base, "synthetic-key")).rejects.toThrow("provider-environment-unisolated");
  } finally {
    if (saved === undefined) delete process.env["PIDOCK_SDK_ISOLATED"];
    else process.env["PIDOCK_SDK_ISOLATED"] = saved;
  }
});

it("rejects a same-name endpoint or credential reference change in a bound SDK session", async () => {
  const dir = task("task-explicit-identity");
  const base = { profileId: "explicit", baseUrl: "http://127.0.0.1:8888/v1", modelId: "fixture", contextWindow: 2048, maxTokens: 128, authRef: "PIDOCK_PROVIDER_TEST", generation: 1 };
  const first = await createExplicitTextRuntime(base, "synthetic");
  const original = new PiSdkTextKernel("task-explicit-identity", dir, { model: first.model, modelRuntime: first.runtime, bindingIdentity: first.bindingIdentity });
  const file = (await original.open("main")).file;
  await original.dispose();
  for (const changed of [{ ...base, baseUrl: "http://127.0.0.1:8889/v1" }, { ...base, authRef: "PIDOCK_PROVIDER_OTHER" }, { ...base, generation: 2 }]) {
    const next = await createExplicitTextRuntime(changed, "synthetic");
    const reopened = new PiSdkTextKernel("task-explicit-identity", dir, { model: next.model, modelRuntime: next.runtime, bindingIdentity: next.bindingIdentity });
    await expect(reopened.open("main")).rejects.toThrow("sdk-binding-invalid");
    expect(reopened.projection("main").source).toBe("sdk-jsonl");
    await reopened.dispose();
  }
  const unbound = await kernel(dir);
  await expect(unbound.instance.open("main")).rejects.toThrow("sdk-binding-invalid");
  expect(readFileSync(file, "utf8")).not.toContain("synthetic");
  await unbound.instance.dispose();
});

it("normalizes explicit Provider errors before the SDK writes JSONL", async () => {
  const dir = task("task-explicit-error");
  const secret = "SYNTHETIC_CREDENTIAL_46_DO_NOT_USE";
  const config = { profileId: "explicit", baseUrl: "http://127.0.0.1:8888/v1", modelId: "fixture", contextWindow: 2048, maxTokens: 128, authRef: "PIDOCK_PROVIDER_TEST", generation: 1 };
  const { runtime, model: selected, bindingIdentity } = await createExplicitTextRuntime(config, secret);
  const provider: Provider = {
    id: selected.provider, name: "Synthetic error", auth: { apiKey: { name: "Synthetic", resolve: async () => ({ auth: {} }) } },
    getModels: () => [selected],
    stream: (_model, context, options) => provider.streamSimple(_model, context, options),
    streamSimple: () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.push({ type: "error", reason: "error", error: {
        role: "assistant", api: selected.api, provider: selected.provider, model: selected.id,
        content: [{ type: "text", text: secret }], responseId: secret, usage, stopReason: "error", errorMessage: `upstream echoed ${secret}`, timestamp: Date.now(),
      } }));
      return stream;
    },
  };
  runtime.registerNativeProvider(provider);
  const instance = new PiSdkTextKernel("task-explicit-error", dir, { model: selected, modelRuntime: runtime, bindingIdentity });
  const file = (await instance.open("main")).file;
  const events: SdkTextEvent[] = [];
  const result = await instance.prompt("main", "hello", (event) => events.push(event));
  const jsonl = readFileSync(file, "utf8");
  expect(result).toMatchObject({ state: "failed", error: "provider-request-failed" });
  expect(JSON.stringify({ result, events, jsonl })).not.toContain(secret);
  await instance.dispose();
});

it("keeps real OpenAI-compatible SDK text and usage with the guarded runtime", async () => {
  const dir = task("task-explicit-success");
  const secret = "SYNTHETIC_CREDENTIAL_46_SUCCESS";
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(String(request.headers.authorization));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`data: {"id":"${secret}","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"hello${secret.slice(0, 12)}"},"finish_reason":null}]}\n\n`);
    response.write(`data: {"id":"chat-2","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{"content":"${secret.slice(12)}"},"finish_reason":null}]}\n\n`);
    response.write('data: {"id":"chat-1","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
    response.write('data: {"id":"chat-1","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n');
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { runtime, model: selected, bindingIdentity } = await createExplicitTextRuntime({
      profileId: "explicit", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      modelId: "fixture", contextWindow: 2048, maxTokens: 128, authRef: "PIDOCK_PROVIDER_TEST", generation: 1,
    }, secret);
    const instance = new PiSdkTextKernel("task-explicit-success", dir, { model: selected, modelRuntime: runtime, bindingIdentity });
    const file = (await instance.open("main")).file;
    const result = await instance.prompt("main", "hello");
    expect(requests).toEqual([`Bearer ${secret}`]);
    expect(result).toMatchObject({ state: "done", text: "hello[redacted]" });
    expect(result.events.map((event) => event.type)).toEqual(["delta", "delta", "message_end", "agent_settled"]);
    expect(result.events.find((event) => event.type === "message_end")).toMatchObject({ usage: { input: 3, output: 1 } });
    expect(JSON.stringify(result) + readFileSync(file, "utf8")).not.toContain(secret);
    await instance.dispose();
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it("keeps explicit OpenAI-compatible auth on the original origin across redirects", async () => {
  const dir = task("task-explicit-redirect");
  let redirected = 0;
  const secondary = createServer((_request, response) => { redirected++; response.end("unexpected"); });
  const listen = (server: typeof secondary) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = (server: typeof secondary) => new Promise<void>((resolve) => server.close(() => resolve()));
  await listen(secondary);
  const destination = `http://127.0.0.1:${(secondary.address() as { port: number }).port}/catch`;
  const primary = createServer((_request, response) => { response.writeHead(307, { Location: destination }); response.end(); });
  try {
    await listen(primary);
    const secret = "SYNTHETIC_CREDENTIAL_46_REDIRECT";
    const { runtime, model: selected, bindingIdentity } = await createExplicitTextRuntime({
      profileId: "explicit", baseUrl: `http://127.0.0.1:${(primary.address() as { port: number }).port}/v1`,
      modelId: "fixture", contextWindow: 2048, maxTokens: 128, authRef: "PIDOCK_PROVIDER_TEST", generation: 1,
    }, secret);
    const instance = new PiSdkTextKernel("task-explicit-redirect", dir, { model: selected, modelRuntime: runtime, bindingIdentity });
    const file = (await instance.open("main")).file;
    const result = await instance.prompt("main", "hello");
    expect(result).toMatchObject({ state: "failed", error: "provider-request-failed" });
    expect(redirected).toBe(0);
    expect(JSON.stringify(result) + readFileSync(file, "utf8")).not.toContain(secret);
    await instance.dispose();
  } finally {
    if (primary.listening) await close(primary);
    await close(secondary);
  }
});

const BOUNDED_ERROR_CODES = new Set(["provider-request-failed", "provider-request-aborted"]);

/** Every `error`/`errorMessage` string recorded in a result, events or projection. */
function recordedErrorTexts(value: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== "object" || node === null) return;
    for (const [key, field] of Object.entries(node)) {
      if ((key === "error" || key === "errorMessage") && typeof field === "string") found.push(field);
      else walk(field);
    }
  };
  walk(value);
  return found;
}

it("normalizes loopback non-2xx and mid-stream failures before JSONL, projection and cold start", async () => {
  const dir = task("task-explicit-error-paths");
  const secret = "SYNTHETIC_CREDENTIAL_46_ERROR_PATHS";
  const raw = "RAW_UPSTREAM_ERROR_TEXT_46";
  let hits = 0;
  const server = createServer((request, response) => {
    hits += 1;
    request.resume();
    request.on("end", () => {
      if (hits === 1) {
        // Non-2xx: the error payload echoes the credential and raw upstream text.
        response.writeHead(500, { "content-type": "text/plain" });
        response.end(`${raw} ${secret} ${secret.slice(0, 14)}`);
        return;
      }
      // Mid-stream failure: the credential is split across two frames first.
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: {"id":"chatcmpl-${secret}","object":"chat.completion.chunk","created":1,"model":"${secret}","choices":[{"index":0,"delta":{"role":"assistant","content":"${secret.slice(0, 14)}"},"finish_reason":null}]}\n\n`);
      response.write(`data: {"id":"chatcmpl-${secret}","object":"chat.completion.chunk","created":1,"model":"${secret}","choices":[{"index":0,"delta":{"content":"${secret.slice(14)} tail"},"finish_reason":null}]}\n\n`);
      response.socket?.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const config = { profileId: "explicit", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, modelId: "fixture", contextWindow: 2048, maxTokens: 128, authRef: "PIDOCK_PROVIDER_TEST", generation: 1 };
    const { runtime, model: selected, bindingIdentity } = await createExplicitTextRuntime(config, secret);
    const instance = new PiSdkTextKernel("task-explicit-error-paths", dir, { model: selected, modelRuntime: runtime, bindingIdentity });
    const file = (await instance.open("main")).file;
    const events: SdkTextEvent[] = [];
    const first = await instance.prompt("main", "non-2xx turn", (event) => events.push(event));
    const second = await instance.prompt("main", "broken stream turn", (event) => events.push(event));
    expect(hits).toBe(2);
    expect(first).toMatchObject({ state: "failed", error: "provider-request-failed" });
    expect(second).toMatchObject({ state: "failed", error: "provider-request-failed" });
    const surfaces = JSON.stringify({ first, second, events, projection: instance.projection("main") }) + readFileSync(file, "utf8");
    // Error payloads never reach results, events, JSONL or projection — not
    // even redacted: only bounded explicit codes cross the trusted boundary.
    expect(surfaces).not.toContain(raw);
    expect(surfaces).not.toContain(secret);
    for (const text of recordedErrorTexts({ first, second, events })) expect(BOUNDED_ERROR_CODES.has(text)).toBe(true);
    await instance.dispose();
    // Cold start: a fresh runtime revalidates the binding identity and keeps
    // the read-only projection free of raw error text and the credential.
    const cold = await createExplicitTextRuntime(config, secret);
    const reopened = new PiSdkTextKernel("task-explicit-error-paths", dir, { model: cold.model, modelRuntime: cold.runtime, bindingIdentity: cold.bindingIdentity });
    await reopened.open("main");
    const projection = JSON.stringify(reopened.projection("main"));
    expect(projection).not.toContain(secret);
    expect(projection).not.toContain(raw);
    await reopened.dispose();
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it("keeps a cancelled loopback stream free of the credential and raw error text", async () => {
  const dir = task("task-explicit-cancel");
  const secret = "SYNTHETIC_CREDENTIAL_46_CANCEL";
  let hits = 0;
  const server = createServer((request, response) => {
    hits += 1;
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: {"id":"chatcmpl-${secret}","object":"chat.completion.chunk","created":1,"model":"${secret}","choices":[{"index":0,"delta":{"role":"assistant","content":"${secret.slice(0, 14)}"},"finish_reason":null}]}\n\n`);
      response.write(`data: {"id":"chatcmpl-${secret}","object":"chat.completion.chunk","created":1,"model":"${secret}","choices":[{"index":0,"delta":{"content":"${secret.slice(14)} hold"},"finish_reason":null}]}\n\n`);
      // The stream stays open until the turn is cancelled.
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const config = { profileId: "explicit", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, modelId: "fixture", contextWindow: 2048, maxTokens: 128, authRef: "PIDOCK_PROVIDER_TEST", generation: 1 };
    const { runtime, model: selected, bindingIdentity } = await createExplicitTextRuntime(config, secret);
    const instance = new PiSdkTextKernel("task-explicit-cancel", dir, { model: selected, modelRuntime: runtime, bindingIdentity });
    const file = (await instance.open("main")).file;
    const events: SdkTextEvent[] = [];
    const run = instance.prompt("main", "cancel me", (event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 400));
    await instance.cancel("main");
    const result = await run;
    expect(result.state).toBe("cancelled");
    expect(hits).toBe(1);
    const surfaces = JSON.stringify({ result, events, projection: instance.projection("main") }) + readFileSync(file, "utf8");
    expect(surfaces).not.toContain(secret);
    for (const text of recordedErrorTexts({ result, events })) expect(BOUNDED_ERROR_CODES.has(text)).toBe(true);
    await instance.dispose();
    // Cold start after a cancelled turn keeps the projection readable and clean.
    const cold = await createExplicitTextRuntime(config, secret);
    const reopened = new PiSdkTextKernel("task-explicit-cancel", dir, { model: cold.model, modelRuntime: cold.runtime, bindingIdentity: cold.bindingIdentity });
    await reopened.open("main");
    expect(JSON.stringify(reopened.projection("main"))).not.toContain(secret);
    await reopened.dispose();
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
