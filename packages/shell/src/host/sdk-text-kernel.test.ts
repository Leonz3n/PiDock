import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { AssistantMessage, Model, Provider } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { buildTaskDiskRecord, serializeTaskRecord } from "./task-store.js";
import { PiSdkTextKernel } from "./sdk-text-kernel.js";
import { TaskWorkspaceHost } from "./task-host.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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

it("refuses unconfigured production selection without touching global auth", async () => {
  const dir = task("task-a");
  const instance = new PiSdkTextKernel("task-a", dir);
  await expect(instance.prompt("main", "hi")).rejects.toThrow("provider-not-configured");
  await expect(instance.open("main")).rejects.toThrow("provider-not-configured");
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
  await first.instance.dispose();
  const changed = await kernel(a, undefined, { ...model, id: "other-model" });
  await expect(changed.instance.open("main")).rejects.toThrow("sdk-configuration-mismatch");
  await changed.instance.dispose();
  const bKernel = await kernel(b);
  mkdirSync(join(b, ".pidock-sdk-sessions", "main"), { recursive: true });
  writeFileSync(join(b, ".pidock-sdk-sessions", "main", "binding.json"), readFileSync(join(a, ".pidock-sdk-sessions", "main", "binding.json")));
  await expect(bKernel.instance.open("main")).rejects.toThrow("sdk-binding-invalid");
  await bKernel.instance.dispose();
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
  const run = pending.instance.prompt("main", "wait");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await expect(pending.instance.prompt("other", "no")).rejects.toThrow("task-locked");
  await pending.instance.cancel("main");
  expect((await run).state).toBe("cancelled");
  await pending.instance.dispose();
  const callback = await kernel(dir, () => "ok");
  expect((await callback.instance.prompt("different", "hello", () => { throw new Error("receiver"); })).error).toBe("sdk-event-delivery-failed");
  await callback.instance.dispose();
});
