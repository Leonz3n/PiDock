/**
 * A real first turn through the T03 Provider path — [PiDock T03] #138.
 *
 * The unit tests around the secret store, the native `models.json` manager and
 * the request shaping use fakes. This file proves the same path with the real
 * Pi 1.5 SDK: a profile is saved through the exact-key `save` RPC (safeStorage
 * backing, no env variable), its config is read back from the profile store,
 * the credential is decrypted by main, and a real loopback `openai-completions`
 * server answers the streamed turn. Nothing here hand-builds a provider config:
 * every value the SDK sees came out of the management object.
 *
 * Covered: streamed deltas + usage, request shape, cancel of a held stream,
 * a bounded provider failure, continuing the same session, and continuing after
 * a restart (cold start) with the same stored credential. The key must never
 * appear in the native file, the JSONL projection or a returned result.
 */

import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { PiSdkTextKernel, type SdkTextEvent } from "../host/sdk-text-kernel.js";
import { createExplicitTextRuntime, isCredentialEnvName } from "../host/explicit-text-provider.js";
import { buildTaskDiskRecord, serializeTaskRecord } from "../host/task-store.js";
import { NativeModelsFile, modelsJsonPath } from "./native-models-config.js";
import { ProviderProfileStore } from "./provider-profile-store.js";
import { ProviderSecretStore, createTestSafeStorage } from "./provider-secret-store.js";
import { ProviderWiring } from "./provider-ipc.js";

const SECRET = "sk-loopback-0123456789-abcdefghijklmnop";
const roots: string[] = [];

// `createExplicitTextRuntime` refuses to run inside a developer's ambient
// credential environment; this suite builds that precondition and restores it.
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
  const root = mkdtempSync(join(tmpdir(), "pidock-provider-turn-"));
  roots.push(root);
  const dir = join(root, id);
  mkdirSync(dir);
  execFileSync("git", ["init", "-q", dir], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TEMPLATE_DIR: "" } });
  writeFileSync(join(dir, "task.json"), serializeTaskRecord(buildTaskDiskRecord({
    taskId: id, name: id, dirId: id, branch: "main", root, taskDir: dir,
    remoteBranch: "main", baseCommit: "test", repos: [], now: new Date().toISOString(),
  })));
  return { root, dir };
}

/** The management surface exactly as `main.ts` assembles it, with a fake safeStorage. */
function management(root: string) {
  const userData = join(root, "userData");
  const agentDir = join(root, "agent");
  mkdirSync(userData, { recursive: true });
  const secrets = new ProviderSecretStore(userData, createTestSafeStorage());
  const native = new NativeModelsFile(agentDir);
  const profiles = new ProviderProfileStore(userData);
  // The production installer turns this selection into the SDK config; the test
  // reads the same store instead of hand-building one.
  const installed: { config: ReturnType<ProviderProfileStore["config"]>; credential: string; thinkingLevel: string }[] = [];
  const providers = new ProviderWiring(profiles, async (_taskId, provider) => {
    if (provider !== null) installed.push({ config: profiles.config(provider.profileId, provider.modelId), credential: provider.credential, thinkingLevel: provider.thinkingLevel });
  }, {}, { secrets, native });
  return { userData, agentDir, secrets, native, profiles, providers, installed };
}

const SAVE = {
  // The renderer picks the credential kind; the key itself travels beside it.
  credential: { kind: "store" as const },
  name: "Loopback gateway",
  notes: "本机回环端点",
  protocol: "openai-completions" as const,
  baseUrl: "",
  modelId: "fixture-model",
  models: [
    { id: "fixture-model", name: "Fixture Model", contextWindow: 32768, maxTokens: 2048, reasoning: true, reasoningLevels: ["off", "low", "high"] },
    { id: "fixture-large", name: "Fixture Large", contextWindow: 131072, maxTokens: 8192, reasoning: false },
  ],
};

/** OpenAI-compatible content is either a string or a text-part array. */
function messageText(message: { content: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  return (content as { type: string; text?: string }[]).filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

/** A minimal OpenAI-compatible SSE answer; `texts` are streamed as deltas. */
function openaiSse(response: ServerResponse, texts: string[], usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const text of texts) {
    response.write(`data: ${JSON.stringify({ id: "chat-1", object: "chat.completion.chunk", created: 1, model: "fixture-model",
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
  }
  response.write(`data: ${JSON.stringify({ id: "chat-1", object: "chat.completion.chunk", created: 1, model: "fixture-model",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: "chat-1", object: "chat.completion.chunk", created: 1, model: "fixture-model",
    choices: [], usage })}\n\n`);
  response.end("data: [DONE]\n\n");
}

it("streams a real first turn from the native management object and keeps the key out of every file", async () => {
  const { root, dir } = task("task-real-turn");
  const { agentDir, secrets, native, profiles, providers, installed } = management(root);
  const requests: { authorization: string | undefined; body: Record<string, unknown> }[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      requests.push({ authorization: request.headers.authorization, body: await body(request) });
      openaiSse(response, ["hello", " world"]);
    })();
  });
  const port = await listen(server);
  try {
    const saved = await providers.perform({ op: "save", profile: { ...SAVE, baseUrl: `http://127.0.0.1:${port}/v1` }, apiKey: SECRET }, 1) as {
      profile: { id: string; credentialSource: string; credentialAvailable: boolean }; written: boolean; conflict: unknown;
    };
    // The management object is written to Pi's own file, and only there is the
    // entry discoverable: the UI metadata never carries the key.
    expect(saved).toMatchObject({ written: true, conflict: null,
      profile: { credentialSource: "store", credentialAvailable: true } });
    const file = readFileSync(modelsJsonPath(agentDir), "utf8");
    const managed = (JSON.parse(file) as { providers: Record<string, { api: string; baseUrl: string; apiKey?: string; models: { id: string }[] }> }).providers;
    expect(managed[`pidock-${saved.profile.id}`]).toMatchObject({
      api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ id: "fixture-model" }, { id: "fixture-large" }],
    });
    // A store-backed profile writes no `apiKey` reference at all: Pi never sees
    // a value, and neither does the file.
    expect(managed[`pidock-${saved.profile.id}`]?.apiKey).toBeUndefined();
    expect(file).not.toContain(SECRET);
    expect(secrets.resolve(saved.profile.id)).toBe(SECRET);
    expect(native.state(saved.profile.id, profiles.profile(saved.profile.id)!.native.fingerprint)).toBe("synced");

    // Selecting the profile installs the config the store hands to Pi.
    expect(await providers.perform({ op: "select", taskId: "task-real-turn", profileId: saved.profile.id, thinkingLevel: "high" }, 1))
      .toMatchObject({ state: "configured", modelId: "fixture-model", thinkingLevel: "high" });
    expect(installed).toHaveLength(1);
    expect(installed[0]?.config).toMatchObject({ protocol: "openai-completions", credentialSource: "store", modelId: "fixture-model" });
    expect(installed[0]?.thinkingLevel).toBe("high");
    expect(installed[0]?.credential).toBe(SECRET);

    const config = profiles.config(saved.profile.id, "fixture-model");
    const { runtime, model, bindingIdentity } = await createExplicitTextRuntime(config, secrets.resolve(saved.profile.id));
    const kernel = new PiSdkTextKernel("task-real-turn", dir, { model, modelRuntime: runtime, bindingIdentity });
    const opening = await kernel.open("main");
    expect(opening.tools).toEqual([]);
    const deltas: string[] = [];
    const result = await kernel.prompt("main", "say hello", (event: SdkTextEvent) => {
      if (event.type === "delta") deltas.push(event.text);
    });
    expect(result).toMatchObject({ state: "done", text: "hello world" });
    expect(deltas).toEqual(["hello", " world"]);
    expect(result.events.map((event) => event.type)).toEqual(["delta", "delta", "message_end", "agent_settled"]);
    expect(result.events.find((event) => event.type === "message_end")).toMatchObject({ usage: { input: 5, output: 3 } });
    // The request the real SDK sent: bearer credential, declared model, streamed.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.authorization).toBe(`Bearer ${SECRET}`);
    const firstBody = requests[0]?.body as { messages: { role: string; content: unknown }[] };
    expect(requests[0]?.body).toMatchObject({ model: "fixture-model", stream: true });
    expect(firstBody.messages.map((message) => [message.role, messageText(message)]))
      .toEqual([["developer", expect.stringContaining("text-only assistant")], ["user", "say hello"]]);
    // Neither the result nor the JSONL projection may echo the credential.
    expect(JSON.stringify(result) + readFileSync(opening.file, "utf8")).not.toContain(SECRET);
    await kernel.dispose();
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it("names a provider failure, cancels a held stream, then continues the same session", async () => {
  const { root, dir } = task("task-real-continue");
  const { secrets, profiles, providers } = management(root);
  let mode: "fail" | "hold" | "ok" = "fail";
  const requests: Record<string, unknown>[] = [];
  let held: ServerResponse | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      requests.push(await body(request));
      if (mode === "fail") {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: `upstream exploded ${SECRET}` } }));
        return;
      }
      if (mode === "hold") {
        held = response;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ id: "chat-1", object: "chat.completion.chunk", created: 1, model: "fixture-model",
          choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] })}\n\n`);
        return;
      }
      openaiSse(response, ["continued"]);
    })();
  });
  const port = await listen(server);
  try {
    const saved = await providers.perform({ op: "save", profile: { ...SAVE, baseUrl: `http://127.0.0.1:${port}/v1` }, apiKey: SECRET }, 1) as { profile: { id: string } };
    const config = profiles.config(saved.profile.id, "fixture-model");
    const { runtime, model, bindingIdentity } = await createExplicitTextRuntime(config, secrets.resolve(saved.profile.id));
    const kernel = new PiSdkTextKernel("task-real-continue", dir, { model, modelRuntime: runtime, bindingIdentity });
    const opening = await kernel.open("main");

    // A real non-2xx answer becomes a bounded code; the upstream text (and the
    // key the upstream echoed) never reaches the result or the transcript.
    const failed = await kernel.prompt("main", "first");
    expect(failed.state).toBe("failed");
    expect(failed.error).toBe("provider-request-failed");
    expect(JSON.stringify(failed)).not.toContain(SECRET);

    mode = "hold";
    const started = kernel.prompt("main", "second");
    for (let i = 0; i < 200 && !held; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(held).toBeDefined();
    await kernel.cancel("main");
    const cancelled = await started;
    expect(cancelled.state).toBe("cancelled");
    held?.end();
    expect(JSON.stringify(cancelled)).not.toContain(SECRET);

    mode = "ok";
    const continued = await kernel.prompt("main", "third");
    expect(continued).toMatchObject({ state: "done", text: "continued" });
    // The session continued: the failing and cancelled turns are not silently
    // dropped from the transcript the next request is built from.
    const last = requests.at(-1);
    const messages = last?.["messages"] as { role: string; content: unknown }[];
    expect(messages.filter((message) => message.role === "user").map(messageText)).toEqual(["first", "second", "third"]);
    const projection = kernel.projection("main");
    expect(projection.messages.filter((message) => message.role === "user")).toHaveLength(3);
    expect(readFileSync(opening.file, "utf8")).not.toContain(SECRET);
    await kernel.dispose();
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it("continues after a restart with the credential still coming from safeStorage", async () => {
  const { root, dir } = task("task-real-restart");
  const { agentDir, secrets, profiles, providers } = management(root);
  const requests: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      requests.push(await body(request));
      openaiSse(response, [`reply-${requests.length}`]);
    })();
  });
  const port = await listen(server);
  try {
    const saved = await providers.perform({ op: "save", profile: { ...SAVE, baseUrl: `http://127.0.0.1:${port}/v1` }, apiKey: SECRET }, 1) as { profile: { id: string } };
    const config = profiles.config(saved.profile.id, "fixture-model");
    const first = await createExplicitTextRuntime(config, secrets.resolve(saved.profile.id));
    const before = new PiSdkTextKernel("task-real-restart", dir, { model: first.model, modelRuntime: first.runtime, bindingIdentity: first.bindingIdentity });
    await before.open("main");
    expect(await before.prompt("main", "before restart")).toMatchObject({ state: "done", text: "reply-1" });
    await before.dispose();

    // Restart: a brand-new store instance reads both the management object and
    // the encrypted secret from disk; no env variable carries the credential.
    const reopenedNative = new NativeModelsFile(agentDir);
    const reopenedSecrets = new ProviderSecretStore(join(root, "userData"), createTestSafeStorage());
    const reopenedProfiles = new ProviderProfileStore(join(root, "userData"));
    expect(reopenedNative.state(saved.profile.id, reopenedProfiles.profile(saved.profile.id)!.native.fingerprint)).toBe("synced");
    expect(reopenedSecrets.resolve(saved.profile.id)).toBe(SECRET);
    const reopened = reopenedProfiles.config(saved.profile.id, "fixture-model");
    expect(reopened).toMatchObject(profiles.config(saved.profile.id, "fixture-model"));

    const second = await createExplicitTextRuntime(reopened, reopenedSecrets.resolve(saved.profile.id));
    const after = new PiSdkTextKernel("task-real-restart", dir, { model: second.model, modelRuntime: second.runtime, bindingIdentity: second.bindingIdentity });
    const opening = await after.open("main");
    expect(await after.prompt("main", "after restart")).toMatchObject({ state: "done", text: "reply-2" });
    // The restart reopened the same session file and rebuilt the model context
    // from it, so the earlier turn is part of this request.
    const messages = (requests.at(-1)?.["messages"] ?? []) as { role: string; content: unknown }[];
    expect(messages.filter((message) => message.role === "user" || message.role === "assistant").map((message) => [message.role, messageText(message)])).toEqual([
      ["user", "before restart"], ["assistant", "reply-1"], ["user", "after restart"],
    ]);
    expect(after.projection("main").messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(JSON.stringify(requests) + readFileSync(opening.file, "utf8") + readFileSync(modelsJsonPath(agentDir), "utf8")).not.toContain(SECRET);
    await after.dispose();
    // The installed config used the same profile id and protocol on both sides
    // of the restart, so Pi's binding identity still matches.
    expect(second.bindingIdentity).toBe(first.bindingIdentity);
    expect(secrets.revision(saved.profile.id)).toBe(reopenedSecrets.revision(saved.profile.id));
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
