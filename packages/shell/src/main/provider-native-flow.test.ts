import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { NativeModelsFile } from "./native-models-config.js";
import { ProviderProfileStore } from "./provider-profile-store.js";
import { ProviderRefusal, ProviderWiring, type ProviderInstall } from "./provider-ipc.js";
import { ProviderSecretStore, createTestSafeStorage, UNAVAILABLE_SAFE_STORAGE } from "./provider-secret-store.js";

const SECRET = "sk-live-native-flow-0123456789abcdef";

const wire = {
  name: "DeepSeek",
  notes: "个人主力 Key",
  protocol: "openai-completions" as const,
  baseUrl: "https://api.deepseek.example.test/v1",
  credential: { kind: "store" as const },
  models: [
    { id: "deepseek-chat", name: "DeepSeek V3", contextWindow: 128000, maxTokens: 8192, reasoning: false },
    { id: "deepseek-reasoner", name: "DeepSeek R1", contextWindow: 64000, maxTokens: 8192, reasoning: true, reasoningLevels: ["minimal", "low", "medium", "high"] },
  ],
  modelId: "deepseek-chat",
};

function fixture(storage = createTestSafeStorage()) {
  const root = mkdtempSync(join(tmpdir(), "pidock-provider-native-"));
  const userData = join(root, "userData");
  const agentDir = join(root, "agent");
  const profiles = new ProviderProfileStore(userData, () => "2026-11-02T00:00:00.000Z");
  const secrets = new ProviderSecretStore(userData, storage, () => "2026-11-02T00:00:00.000Z");
  const native = new NativeModelsFile(agentDir);
  const installs: { taskId: string; provider: ProviderInstall | null }[] = [];
  const providers = new ProviderWiring(profiles, async (taskId, provider) => { installs.push({ taskId, provider }); }, {}, {
    secrets, native, fetchImpl: vi.fn() as unknown as typeof globalThis.fetch,
  });
  return { root, userData, agentDir, profiles, secrets, native, providers, installs };
}

it("saves into Pi's models.json and into the encrypted store, with no key on disk", async () => {
  const f = fixture();
  const saved = (await f.providers.perform({ op: "save", profile: wire, apiKey: SECRET }, 1)) as {
    profile: { id: string; native: { state: string; providerId: string }; credentialSource: string; credentialAvailable: boolean };
    conflict: string | null;
    written: boolean;
  };
  expect(saved.written).toBe(true);
  expect(saved.conflict).toBeNull();
  expect(saved.profile.native.state).toBe("synced");
  expect(saved.profile.credentialSource).toBe("store");
  expect(saved.profile.credentialAvailable).toBe(true);

  const models = JSON.parse(readFileSync(join(f.agentDir, "models.json"), "utf8"));
  const entry = models.providers[`pidock-${saved.profile.id}`];
  expect(entry).toMatchObject({ name: "DeepSeek", baseUrl: wire.baseUrl, api: "openai-completions" });
  // The native entry carries no credential value and no `$ENV` placeholder for a
  // stored key: Pi cannot read a safeStorage ciphertext, so PiDock does not
  // pretend the file authenticates.
  expect(entry.apiKey).toBeUndefined();
  expect(entry.models).toEqual([
    { id: "deepseek-chat", name: "DeepSeek V3", reasoning: false, contextWindow: 128000, maxTokens: 8192 },
    {
      id: "deepseek-reasoner", name: "DeepSeek R1", reasoning: true, contextWindow: 64000, maxTokens: 8192,
      // Only the declared levels map to themselves; every other tier is
      // explicitly unsupported, so Pi cannot offer a level the row never declared.
      thinkingLevelMap: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null },
    },
  ]);

  // No plaintext key anywhere in either file.
  for (const file of ["models.json", "provider-secrets.json", "provider-profiles.json"]) {
    expect(readFileSync(join(file === "models.json" ? f.agentDir : f.userData, file), "utf8")).not.toContain(SECRET);
  }
  expect(f.secrets.resolve(saved.profile.id)).toBe(SECRET);
});

it("writes Pi's environment interpolation only for an env-backed profile", async () => {
  const f = fixture();
  const saved = (await f.providers.perform({ op: "save", profile: { ...wire, credential: { kind: "env", ref: "PIDOCK_PROVIDER_DEEPSEEK" } } }, 1)) as { profile: { id: string } };
  const models = JSON.parse(readFileSync(join(f.agentDir, "models.json"), "utf8"));
  expect(models.providers[`pidock-${saved.profile.id}`].apiKey).toBe("$PIDOCK_PROVIDER_DEEPSEEK");
});

it("refuses to store a key when the platform cannot encrypt", async () => {
  const f = fixture(UNAVAILABLE_SAFE_STORAGE);
  await expect(f.providers.perform({ op: "save", profile: wire, apiKey: SECRET }, 1)).rejects.toBeInstanceOf(ProviderRefusal);
  expect(f.profiles.list().profiles).toHaveLength(0);
  expect(() => readFileSync(join(f.agentDir, "models.json"), "utf8")).toThrow();
});

it("requires an API key the first time a stored credential is saved", async () => {
  const f = fixture();
  await expect(f.providers.perform({ op: "save", profile: wire }, 1)).rejects.toMatchObject({ code: "credential-required" });
  expect(f.profiles.list().profiles).toHaveLength(0);
});

it("a kept key is reused without resending it, and a replaced key bumps the generation", async () => {
  const f = fixture();
  const first = (await f.providers.perform({ op: "save", profile: wire, apiKey: SECRET }, 1)) as { profile: { id: string; generation: number } };
  const id = first.profile.id;
  const again = (await f.providers.perform({ op: "save", profile: { ...wire, id, name: "Renamed" } }, 1)) as { profile: { generation: number } };
  expect(again.profile.generation).toBe(1);
  expect(f.secrets.resolve(id)).toBe(SECRET);
  const rotated = (await f.providers.perform({ op: "save", profile: { ...wire, id }, apiKey: `${SECRET}-rotated` }, 1)) as { profile: { generation: number } };
  expect(rotated.profile.generation).toBe(2);
  expect(f.secrets.resolve(id)).toBe(`${SECRET}-rotated`);
  expect(f.secrets.revision(id)).toBe(2);
});

it("names an external edit and refuses to overwrite it without an explicit reconcile", async () => {
  const f = fixture();
  const saved = (await f.providers.perform({ op: "save", profile: wire, apiKey: SECRET }, 1)) as { profile: { id: string } };
  const id = saved.profile.id;
  const path = join(f.agentDir, "models.json");
  const document = JSON.parse(readFileSync(path, "utf8"));
  document.providers[`pidock-${id}`] = { ...document.providers[`pidock-${id}`], baseUrl: "https://hand-edited.example.test/v1" };
  writeFileSync(path, JSON.stringify(document));

  const listed = (await f.providers.perform({ op: "list" }, 1)) as { profiles: { id: string; native: { state: string } }[] };
  expect(listed.profiles[0]!.native.state).toBe("modified");

  const refused = (await f.providers.perform({ op: "save", profile: { ...wire, id, name: "Renamed" } }, 1)) as { conflict: string; written: boolean };
  expect(refused.written).toBe(false);
  expect(refused.conflict).toBe("modified");
  // The external value is still untouched.
  expect(JSON.parse(readFileSync(path, "utf8")).providers[`pidock-${id}`].baseUrl).toBe("https://hand-edited.example.test/v1");

  const reconciled = (await f.providers.perform({ op: "save", profile: { ...wire, id, name: "Renamed" }, reconcile: true }, 1)) as { conflict: string | null; written: boolean; profile: { native: { state: string } } };
  expect(reconciled.written).toBe(true);
  expect(reconciled.conflict).toBeNull();
  expect(reconciled.profile.native.state).toBe("synced");
  expect(JSON.parse(readFileSync(path, "utf8")).providers[`pidock-${id}`].baseUrl).toBe(wire.baseUrl);
});

it("names an external removal", async () => {
  const f = fixture();
  const saved = (await f.providers.perform({ op: "save", profile: wire, apiKey: SECRET }, 1)) as { profile: { id: string } };
  const path = join(f.agentDir, "models.json");
  const document = JSON.parse(readFileSync(path, "utf8"));
  delete document.providers[`pidock-${saved.profile.id}`];
  writeFileSync(path, JSON.stringify(document));
  const listed = (await f.providers.perform({ op: "list" }, 1)) as { profiles: { native: { state: string } }[] };
  expect(listed.profiles[0]!.native.state).toBe("removed");
  const refused = (await f.providers.perform({ op: "save", profile: { ...wire, id: saved.profile.id } }, 1)) as { conflict: string; written: boolean };
  expect(refused.conflict).toBe("removed");
  expect(refused.written).toBe(false);
});

it("preserves unmanaged providers and removes only its own entry", async () => {
  const f = fixture();
  mkdirSync(f.agentDir, { recursive: true });
  writeFileSync(join(f.agentDir, "models.json"), JSON.stringify({
    providers: {
      ollama: { baseUrl: "http://localhost:11434/v1", api: "openai-completions", models: [{ id: "qwen2.5-coder:7b" }] },
    },
  }));
  const saved = (await f.providers.perform({ op: "save", profile: wire, apiKey: SECRET }, 1)) as { profile: { id: string } };
  const afterSave = JSON.parse(readFileSync(join(f.agentDir, "models.json"), "utf8"));
  expect(afterSave.providers.ollama.models[0].id).toBe("qwen2.5-coder:7b");
  await f.providers.perform({ op: "remove", profileId: saved.profile.id }, 1);
  const afterRemove = JSON.parse(readFileSync(join(f.agentDir, "models.json"), "utf8"));
  expect(afterRemove.providers.ollama).toBeDefined();
  expect(afterRemove.providers[`pidock-${saved.profile.id}`]).toBeUndefined();
  // The stored credential goes with the profile.
  expect(f.secrets.has(saved.profile.id)).toBe(false);
  expect(f.profiles.list().profiles).toHaveLength(0);
});

/** A fetch stub that records the request and answers with a scripted response. */
function fetchStub(answer: (url: string, init: RequestInit) => { status: number; json?: unknown; throws?: boolean }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const reply = answer(url, init ?? {});
    if (reply.throws) throw new Error("socket hang up");
    return new Response(reply.json === undefined ? "" : JSON.stringify(reply.json), { status: reply.status });
  }) as unknown as typeof globalThis.fetch;
  return { calls, impl };
}

function discoveryFixture(impl: typeof globalThis.fetch) {
  const f = fixture();
  const providers = new ProviderWiring(f.profiles, async () => {}, {}, { secrets: f.secrets, native: f.native, fetchImpl: impl });
  return { f, providers };
}

it("discovers models with the stored credential and reports success as candidates", async () => {
  const { calls, impl } = fetchStub(() => ({ status: 200, json: { data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }, { id: "deepseek-chat" }, { nope: 1 }] } }));
  const { providers, f } = discoveryFixture(impl);
  const saved = (await providers.perform({ op: "save", profile: wire, apiKey: SECRET }, 1)) as { profile: { id: string } };
  const outcome = (await providers.perform({ op: "discover", protocol: "openai-completions", baseUrl: wire.baseUrl, profileId: saved.profile.id }, 1)) as { status: string; candidates: string[]; message: string };
  expect(outcome.status).toBe("success");
  expect(outcome.candidates).toEqual(["deepseek-chat", "deepseek-reasoner"]);
  // The stored credential rode the request; the response never echoes it.
  expect(calls[0]!.url).toBe(`${wire.baseUrl}/models`);
  expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`);
  expect(JSON.stringify(outcome)).not.toContain(SECRET);
  expect(f.profiles.list().profiles[0]!.models.map((row) => row.id)).toEqual(["deepseek-chat", "deepseek-reasoner"]);
});

it("distinguishes empty, failure and unsupported discovery without leaking the key", async () => {
  for (const [status, expected] of [[200, "empty"], [401, "failure"], [500, "failure"], [404, "unsupported"], [405, "unsupported"]] as const) {
    const { impl } = fetchStub(() => ({ status, json: status === 200 ? { data: [] } : {} }));
    const { providers } = discoveryFixture(impl);
    const outcome = (await providers.perform({ op: "discover", protocol: "openai-completions", baseUrl: wire.baseUrl, apiKey: SECRET }, 1)) as { status: string; candidates: string[]; message: string };
    expect(outcome.status).toBe(expected);
    expect(outcome.candidates).toEqual([]);
    expect(outcome.message).not.toContain(SECRET);
    expect(outcome.message.length).toBeGreaterThan(0);
  }
  const { impl } = fetchStub(() => ({ status: 0, throws: true }));
  const { providers } = discoveryFixture(impl);
  const outcome = (await providers.perform({ op: "discover", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.example.test/v1", apiKey: SECRET }, 1)) as { status: string; message: string };
  expect(outcome.status).toBe("failure");
  expect(outcome.message).not.toContain(SECRET);
});

it("uses each protocol's own discovery auth convention", async () => {
  const { calls, impl } = fetchStub(() => ({ status: 200, json: { data: [{ id: "claude-sonnet-5" }] } }));
  const { providers } = discoveryFixture(impl);
  await providers.perform({ op: "discover", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.example.test/v1", apiKey: SECRET }, 1);
  const headers = calls[0]!.init.headers as Record<string, string>;
  expect(headers["x-api-key"]).toBe(SECRET);
  expect(headers.authorization).toBeUndefined();
  expect(headers["anthropic-version"]).toBe("2023-06-01");
});

it("tests connectivity with a real protocol-shaped request and names failures", async () => {
  const shapes: Record<string, (body: unknown) => void> = {
    "openai-completions": (body) => {
      expect(body).toMatchObject({ model: "m", messages: [{ role: "user", content: "ping" }] });
      // A connectivity request asks for a complete answer, not a stream.
      expect((body as { stream?: boolean }).stream).toBeUndefined();
    },
    "openai-responses": (body) => {
      expect(body).toMatchObject({ model: "m", input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }] });
      expect((body as { stream?: boolean }).stream).toBeUndefined();
      expect((body as { max_output_tokens?: number }).max_output_tokens).toBe(1);
    },
    "anthropic-messages": (body) => {
      expect(body).toMatchObject({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }], max_tokens: 1 });
      expect((body as { stream?: boolean }).stream).toBeUndefined();
    },
  };
  for (const protocol of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
    const { calls, impl } = fetchStub(() => ({ status: 200, json: {} }));
    const { providers } = discoveryFixture(impl);
    const outcome = (await providers.perform({ op: "probe", protocol, baseUrl: "https://models.example.test/v1", modelId: "m", apiKey: SECRET }, 1)) as { ok: boolean; status: number; message: string };
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe(200);
    expect(outcome.message).not.toContain(SECRET);
    shapes[protocol]!(JSON.parse(String(calls[0]!.init.body)));
    expect(String(calls[0]!.url).endsWith(protocol === "anthropic-messages" ? "/messages" : protocol === "openai-responses" ? "/responses" : "/chat/completions")).toBe(true);
  }

  // A 3xx is named as the redirect it is: PiDock asks not to follow it (the
  // target could carry the credential elsewhere), so it is neither a server
  // error nor a working endpoint.
  for (const [status, code] of [[401, "auth-rejected"], [403, "auth-rejected"], [404, "endpoint-not-found"], [429, "rate-limited"], [302, "redirect-refused"], [301, "redirect-refused"], [500, "provider-error"], [400, "provider-error"]] as const) {
    const { impl } = fetchStub(() => ({ status, json: { echo: SECRET } }));
    const { providers } = discoveryFixture(impl);
    const outcome = (await providers.probe({ protocol: "openai-completions", baseUrl: wire.baseUrl, modelId: "m", apiKey: SECRET }, {} as never));
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe(code);
    // The response body echoed the key; the outcome must not.
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  }
});

// [PiDock T03] #138 C1: the metadata write is the second half of a save. When it
// fails, the native half must be undone — Pi must never keep a `pidock-*`
// provider that PiDock has no profile (or no ciphertext) for.
it("removes a freshly written native entry when the metadata write fails", async () => {
  const f = fixture();
  const path = join(f.agentDir, "models.json");
  const failure = vi.spyOn(f.profiles, "save").mockImplementation(() => { throw new Error("provider registry unreadable"); });
  await expect(f.providers.perform({ op: "save", profile: wire, apiKey: SECRET }, 1)).rejects.toThrow("provider registry unreadable");
  failure.mockRestore();

  // No orphan entry in Pi's file, and no orphan ciphertext in the store.
  const document = JSON.parse(readFileSync(path, "utf8"));
  expect(Object.keys(document.providers)).toEqual([]);
  expect(Object.keys(JSON.parse(readFileSync(join(f.userData, "provider-secrets.json"), "utf8")).secrets)).toEqual([]);
  expect(f.profiles.list().profiles).toHaveLength(0);
});

it("restores the previous native entry when an edit's metadata write fails", async () => {
  const f = fixture();
  const saved = (await f.providers.perform({ op: "save", profile: wire, apiKey: SECRET }, 1)) as { profile: { id: string } };
  const path = join(f.agentDir, "models.json");
  const original = JSON.parse(readFileSync(path, "utf8")).providers[`pidock-${saved.profile.id}`];

  const failure = vi.spyOn(f.profiles, "save").mockImplementation(() => { throw new Error("provider registry unreadable"); });
  await expect(f.providers.perform({
    op: "save",
    profile: { ...wire, id: saved.profile.id, name: "Renamed", baseUrl: "https://changed.example.test/v1" },
  }, 1)).rejects.toThrow("provider registry unreadable");
  failure.mockRestore();

  // The prior value is back, so the recorded fingerprint still matches and the
  // entry is not reported as an external edit.
  expect(JSON.parse(readFileSync(path, "utf8")).providers[`pidock-${saved.profile.id}`]).toEqual(original);
  const listed = (await f.providers.perform({ op: "list" }, 1)) as { profiles: { native: { state: string } }[] };
  expect(listed.profiles[0]!.native.state).toBe("synced");
  expect(f.profiles.list().profiles[0]!.name).toBe("DeepSeek");
});

// [PiDock T03] #138 W7: removing a managed entry destroys an external value
// exactly like overwriting it, so it needs the same explicit acknowledgement.
it("refuses to remove a managed entry that was edited outside PiDock", async () => {
  const f = fixture();
  const saved = (await f.providers.perform({ op: "save", profile: wire, apiKey: SECRET }, 1)) as { profile: { id: string } };
  const id = saved.profile.id;
  const path = join(f.agentDir, "models.json");
  const document = JSON.parse(readFileSync(path, "utf8"));
  document.providers[`pidock-${id}`] = { ...document.providers[`pidock-${id}`], baseUrl: "https://hand-edited.example.test/v1" };
  writeFileSync(path, JSON.stringify(document));

  await expect(f.providers.perform({ op: "remove", profileId: id }, 1)).rejects.toMatchObject({ code: "native-conflict" });
  // Nothing was deleted: the external value and the profile both survive.
  expect(f.profiles.list().profiles).toHaveLength(1);
  expect(JSON.parse(readFileSync(path, "utf8")).providers[`pidock-${id}`].baseUrl).toBe("https://hand-edited.example.test/v1");
  expect(f.secrets.has(id)).toBe(true);

  // The explicit acknowledgement goes through.
  await f.providers.perform({ op: "remove", profileId: id, reconcile: true }, 1);
  expect(f.profiles.list().profiles).toHaveLength(0);
  expect(JSON.parse(readFileSync(path, "utf8")).providers[`pidock-${id}`]).toBeUndefined();
  expect(f.secrets.has(id)).toBe(false);
});

it("refuses to remove a profile whose managed entry was deleted outside PiDock", async () => {
  const f = fixture();
  const saved = (await f.providers.perform({ op: "save", profile: wire, apiKey: SECRET }, 1)) as { profile: { id: string } };
  const path = join(f.agentDir, "models.json");
  const document = JSON.parse(readFileSync(path, "utf8"));
  delete document.providers[`pidock-${saved.profile.id}`];
  writeFileSync(path, JSON.stringify(document));

  await expect(f.providers.perform({ op: "remove", profileId: saved.profile.id }, 1)).rejects.toMatchObject({ code: "native-conflict" });
  expect(f.profiles.list().profiles).toHaveLength(1);
  await f.providers.perform({ op: "remove", profileId: saved.profile.id, reconcile: true }, 1);
  expect(f.profiles.list().profiles).toHaveLength(0);
});
