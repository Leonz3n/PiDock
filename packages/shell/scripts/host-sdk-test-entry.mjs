// Dedicated utilityProcess test entry. Production forks host-entry.js and never imports this file.
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { PiSdkTextKernel } from "../dist/host/sdk-text-kernel.js";
import { startHost } from "../dist/host/host.js";

const dir = process.env.PIDOCK_TASK_DIR;
if (!dir) throw new Error("test task binding missing");
const model = {
  id: "fixture", name: "Fixture", api: "pidock-local-test", provider: "local-test",
  baseUrl: "http://127.0.0.1/unused", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 2048, maxTokens: 128,
};
const usage = { input: 4, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 7,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const runtime = await ModelRuntime.create({ authPath: join(dir, ".test-auth.json"), modelsPath: join(dir, ".test-models.json"), refreshOnCreate: false });
const provider = {
  id: model.provider, name: "Isolated local test", auth: { apiKey: { name: "Local", resolve: async () => ({ auth: {} }) } },
  getModels: () => [model],
  stream: (_model, context, options) => provider.streamSimple(_model, context, options),
  streamSimple: (_model, context, options) => {
    const prompt = context.messages.at(-1)?.content;
    const text = typeof prompt === "string" ? prompt : prompt?.filter((part) => part.type === "text").map((part) => part.text).join("");
    const stream = createAssistantMessageEventStream();
    const partial = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: [], usage, stopReason: "pending", timestamp: Date.now() };
    queueMicrotask(() => {
      stream.push({ type: "start", partial });
      if (text === "wait") {
        options?.signal?.addEventListener("abort", () => stream.push({ type: "error", reason: "aborted", error: { ...partial, stopReason: "aborted", errorMessage: "aborted" } }), { once: true });
        return;
      }
      const response = "local reply";
      stream.push({ type: "text_start", contentIndex: 0, partial });
      partial.content.push({ type: "text", text: response });
      stream.push({ type: "text_delta", contentIndex: 0, delta: response, partial });
      stream.push({ type: "text_end", contentIndex: 0, content: response, partial });
      stream.push({ type: "done", reason: "stop", message: { ...partial, stopReason: "stop" } });
    });
    return stream;
  },
};
runtime.registerNativeProvider(provider);
startHost((id, taskDir) => new PiSdkTextKernel(id, taskDir, { model, modelRuntime: runtime }));
