import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ProviderWiring, type ProviderInstall, type ProviderInstaller } from "./provider-ipc.js";
import { ProviderProfileStore, type ProviderProfileInput } from "./provider-profile-store.js";
import { ProviderSecretStore, createTestSafeStorage } from "./provider-secret-store.js";

const SECRET = "sk-live-0123456789-abcdefghijklmnop";
const ENV = { PIDOCK_PROVIDER_EXAMPLE: SECRET };

const input: ProviderProfileInput = {
  name: "Local gateway",
  protocol: "openai-completions",
  baseUrl: "https://models.example.test/v1",
  credentials: { kind: "env", ref: "PIDOCK_PROVIDER_EXAMPLE" },
  models: [
    { id: "gpt-5-mini", name: "GPT-5 mini", contextWindow: 128000, maxTokens: 8192, reasoning: false },
    { id: "gpt-5", name: "GPT-5", contextWindow: 200000, maxTokens: 16384, reasoning: true },
  ],
  modelId: "gpt-5-mini",
};

/** The exact wire shape the renderer sends (no `native`, no credential value). */
const wire = {
  name: input.name,
  notes: null,
  protocol: input.protocol,
  baseUrl: input.baseUrl,
  credential: { kind: "env", ref: "PIDOCK_PROVIDER_EXAMPLE" },
  models: input.models.map((row) => ({ ...row })),
  modelId: input.modelId,
};

function wiring(install?: ProviderInstaller, env: Record<string, string | undefined> = ENV) {
  const dir = mkdtempSync(join(tmpdir(), "pidock-provider-ipc-"));
  const store = new ProviderProfileStore(dir, () => "2026-09-29T00:00:00.000Z");
  const calls: { taskId: string; provider: ProviderInstall | null; sender: number }[] = [];
  const installer: ProviderInstaller = install ?? (async (taskId, provider, sender) => { calls.push({ taskId, provider, sender }); });
  return { dir, store, calls, wiring: new ProviderWiring(store, installer, env) };
}

it("never returns a credential or credential source to the renderer", async () => {
  const { store, wiring: providers } = wiring();
  const saved = (await providers.perform({ op: "save", profile: wire }, 7)) as { profile: { id: string }; status: { profiles: unknown[] } };
  expect(store.list().profiles).toHaveLength(1);
  const status = await providers.perform({ op: "list", taskId: "task-1" }, 7);
  const serialized = JSON.stringify([saved, status]);
  expect(serialized).not.toContain(SECRET);
  expect(serialized).not.toContain("credential\"");
  // The reference name and a boolean availability flag are all the renderer sees.
  expect(serialized).toContain("PIDOCK_PROVIDER_EXAMPLE");
  expect(serialized).toContain("\"credentialAvailable\":true");
  expect((status as { profiles: unknown[] }).profiles).toHaveLength(1);
  expect(saved.profile.id).toMatch(/^p-/);
  // Both declared model rows and their SDK-derived level sets are visible.
  const view = (status as { profiles: { models: { id: string; reasoningLevels: string[] }[]; native: { state: string } }[] }).profiles[0]!;
  expect(view.models.map((row) => row.id)).toEqual(["gpt-5-mini", "gpt-5"]);
  expect(view.models[0]!.reasoningLevels).toEqual(["off"]);
  expect(view.models[1]!.reasoningLevels).toContain("high");
  // Without a native file wired nothing is claimed to be synced.
  expect(view.native.state).toBe("never-written");
});

it("accepts a configuration list without a task (the S03 list has no task context)", async () => {
  const { wiring: providers } = wiring();
  await providers.perform({ op: "save", profile: wire }, 1);
  const status = (await providers.perform({ op: "list" }, 1)) as { state: string; profiles: unknown[]; modelId: null };
  expect(status.state).toBe("not-configured");
  expect(status.profiles).toHaveLength(1);
  expect(status.modelId).toBeNull();
});

it("installs the resolved credential, the chosen model and the chosen level, then persists the selection", async () => {
  const order: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "pidock-provider-ipc-"));
  const store = new ProviderProfileStore(dir, () => "2026-09-29T00:00:00.000Z");
  const created = store.save(input);
  const providers = new ProviderWiring(store, async (taskId, provider, sender) => {
    order.push(`install:${taskId}:${provider?.profileId ?? "none"}:${provider === null ? "" : provider.credential === SECRET ? "secret" : "leaked"}:${provider?.modelId ?? ""}:${provider?.thinkingLevel ?? ""}:${sender}`);
  }, ENV);
  const status = await providers.select("task-1", created.id, "gpt-5", "medium", 42);
  expect(order).toEqual([`install:task-1:${created.id}:secret:gpt-5:medium:42`]);
  expect(status.state).toBe("configured");
  expect(status.modelId).toBe("gpt-5");
  expect(status.thinkingLevel).toBe("medium");
  expect(store.selection("task-1")).toMatchObject({ profileId: created.id, modelId: "gpt-5", thinkingLevel: "medium", generation: 1 });
});

it("fails closed without persisting a selection when the credential is missing or the context refuses", async () => {
  const missing = wiring(undefined, {});
  const profile = (await missing.wiring.perform({ op: "save", profile: wire }, 1)) as { profile: { id: string } };
  const status = await missing.wiring.select("task-1", profile.profile.id, undefined, undefined, 1);
  expect(status.state).toBe("credential-missing");
  expect(missing.store.selection("task-1")).toBeNull();
  expect(missing.calls).toHaveLength(0);
  expect((status.profiles[0] ?? { credentialAvailable: true }).credentialAvailable).toBe(false);

  const refusing = wiring(async () => { throw new Error("provider-environment-unisolated"); });
  const profile2 = (await refusing.wiring.perform({ op: "save", profile: wire }, 1)) as { profile: { id: string } };
  const status2 = await refusing.wiring.select("task-1", profile2.profile.id, undefined, undefined, 1);
  expect(status2.state).toBe("install-failed");
  expect(refusing.store.selection("task-1")).toBeNull();
  // No raw runtime error text may leak into the renderer view.
  expect(JSON.stringify(status2)).not.toContain("unisolated");
});

it("restores a persisted selection on first contact and remembers it", async () => {
  const { store, calls, wiring: providers } = wiring();
  const profile = store.save(input);
  store.select("task-1", profile.id);
  expect(await providers.perform({ op: "list", taskId: "task-1" }, 9)).toMatchObject({ state: "configured" });
  expect(await providers.perform({ op: "ensure", taskId: "task-1" }, 9)).toMatchObject({ state: "configured" });
  expect(calls.map((call) => call.taskId)).toEqual(["task-1"]);
  expect(calls[0]?.sender).toBe(9);
  expect(calls[0]?.provider?.modelId).toBe("gpt-5-mini");
});

it("drops the live context before dropping the record when clearing or removing", async () => {
  const { store, calls, wiring: providers } = wiring();
  const saved = (await providers.perform({ op: "save", profile: wire }, 3)) as { profile: { id: string } };
  const id = saved.profile.id;
  await providers.select("task-1", id, undefined, undefined, 3);
  await providers.perform({ op: "clear", taskId: "task-1" }, 3);
  expect(calls.at(-1)?.provider).toBeNull();
  expect(store.selection("task-1")).toBeNull();

  await providers.select("task-1", id, undefined, undefined, 3);
  const removed = (await providers.perform({ op: "remove", taskId: "task-1", profileId: id }, 3)) as { state: string };
  expect(calls.at(-1)?.provider).toBeNull();
  expect(removed.state).toBe("not-configured");
  expect(store.list().profiles).toHaveLength(0);
});

it("a bumped generation drops the selection and forces an explicit re-install", async () => {
  const { store, calls, wiring: providers } = wiring();
  const saved = (await providers.perform({ op: "save", profile: wire }, 1)) as { profile: { id: string } };
  const id = saved.profile.id;
  await providers.select("task-1", id, undefined, undefined, 1);
  expect(calls).toHaveLength(1);
  const after = (await providers.perform({ op: "save", profile: { ...wire, id, modelId: "gpt-5" } }, 1)) as { status: { state: string } };
  expect(after.status.state).toBe("not-configured");
  expect(store.selection("task-1")).toBeNull();
  await providers.perform({ op: "select", taskId: "task-1", profileId: id }, 1);
  expect(calls).toHaveLength(2);
});

it("rejects renderer payloads that try to reach past the profile shape", async () => {
  const { wiring: providers } = wiring();
  const hostile = [
    { op: "list", taskId: "task-1", env: { OPENAI_API_KEY: "x" } },
    { op: "save", profile: { ...wire, credential: SECRET } },
    { op: "save", profile: { ...wire, credential: { kind: "env", ref: "OPENAI_API_KEY" } } },
    { op: "save", profile: { ...wire, credential: { kind: "file", path: "/tmp/key" } } },
    { op: "save", profile: { ...wire, native: { providerId: "openai" } } },
    { op: "save", profile: wire, apiKey: "short" },
    { op: "select", taskId: "task-1", profileId: "PIDOCK_PROVIDER_EXAMPLE" },
    { op: "select", taskId: "../escape", profileId: "p-00000000-0000-0000-0000-000000000000" },
    { op: "discover", protocol: "openai-completions", baseUrl: "https://models.example.test/v1" },
    { op: "probe", protocol: "not-a-protocol", baseUrl: "https://models.example.test/v1", modelId: "m" },
    { op: "task/sdkProvider", taskId: "task-1" },
  ];
  for (const request of hostile) {
    await expect(providers.perform(request, 1)).rejects.toThrow();
  }
  await expect(providers.perform({ op: "select", taskId: "task-1", profileId: "p-00000000-0000-0000-0000-000000000000" }, 1)).rejects.toThrow();
});

it("treats an unknown selection as not configured rather than guessing", async () => {
  const { store, wiring: providers } = wiring();
  const profile = store.save(input);
  store.select("task-1", profile.id);
  store.remove(profile.id);
  const status = (await providers.perform({ op: "list", taskId: "task-1" }, 1)) as { state: string };
  expect(status.state).toBe("not-configured");
});

it("distinguishes a stale session binding from a retryable timing failure", async () => {
  const stale = wiring(async () => { throw new Error("sdk-binding-invalid"); });
  const profile = (await stale.wiring.perform({ op: "save", profile: wire }, 1)) as { profile: { id: string } };
  const status = await stale.wiring.select("task-1", profile.profile.id, undefined, undefined, 1);
  expect(status.state).toBe("binding-stale");
  expect(await stale.wiring.select("task-1", profile.profile.id, undefined, undefined, 1)).toMatchObject({ state: "binding-stale" });
  expect(stale.store.selection("task-1")).toBeNull();

  const attempts: string[] = [];
  const busy = wiring(async () => { attempts.push("attempt"); throw new Error("sdk-turn-journal-uncommitted"); });
  const other = busy.store.save(input);
  busy.store.select("task-1", other.id);
  expect(await busy.wiring.ensure("task-1", 1)).toBe("pending");
  // A timing failure is not remembered: the next attempt must try again.
  expect(attempts).toHaveLength(1);
  expect(await busy.wiring.perform({ op: "list", taskId: "task-1" }, 1)).toMatchObject({ state: "pending" });
  expect(attempts).toHaveLength(2);
});

it("retries an installation that failed before it is remembered as configured", async () => {
  const attempts: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "pidock-provider-ipc-"));
  const store = new ProviderProfileStore(dir, () => "2026-09-29T00:00:00.000Z");
  const profile = store.save(input);
  store.select("task-1", profile.id);
  const providers = new ProviderWiring(store, async (_taskId, _provider, _sender) => {
    attempts.push("attempt");
    if (attempts.length === 1) throw new Error("provider-request-failed");
  }, ENV);
  expect((await providers.ensure("task-1", 1))).toBe("install-failed");
  expect((await providers.ensure("task-1", 1))).toBe("configured");
  expect(attempts).toHaveLength(2);
});

it("does not let a stale failure mask a later success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pidock-provider-ipc-"));
  const store = new ProviderProfileStore(dir, () => "2026-09-29T00:00:00.000Z");
  const profile = store.save(input);
  const install = vi.fn(async () => {});
  const providers = new ProviderWiring(store, install, ENV);
  await providers.select("task-1", profile.id, undefined, undefined, 1);
  const status = (await providers.perform({ op: "list", taskId: "task-1" }, 1)) as { state: string };
  expect(status.state).toBe("configured");
  expect(install).toHaveBeenCalledTimes(1);
});

// [PiDock T03] #138 W9: the level a turn runs at must be the chosen one, not
// silently the weakest declared tier.
it("carries the default level (high) through select into the install and the view", async () => {
  const { store, calls, wiring: providers } = wiring();
  const profile = store.save(input);
  // The profile's active model does not declare reasoning: its default is off.
  const status = await providers.select("task-1", profile.id, "gpt-5-mini", undefined, 1);
  expect(status.thinkingLevel).toBe("off");
  expect(status.profiles[0]!.thinkingLevel).toBe("off");
  // The reasoning model defaults to `high`, and that is what the Host receives.
  const reasoning = await providers.perform({ op: "select", taskId: "task-2", profileId: profile.id, modelId: "gpt-5" }, 1) as {
    thinkingLevel: string; profiles: { thinkingLevel: string | null }[];
  };
  expect(reasoning.thinkingLevel).toBe("high");
  expect(store.selection("task-2")).toMatchObject({ modelId: "gpt-5", thinkingLevel: "high" });
  expect(calls.at(-1)?.provider?.thinkingLevel).toBe("high");
  // The view exposes the default for the active model so the UI can show it.
  const reasoningProfile = store.save({ ...input, modelId: "gpt-5" });
  const listed = await providers.perform({ op: "list" }, 1) as { profiles: { id: string; thinkingLevel: string | null }[] };
  expect(listed.profiles.find((view) => view.id === reasoningProfile.id)?.thinkingLevel).toBe("high");
});

// [PiDock T03] #138 W6: one honestly-declared "no usable tier" row must not make
// the whole list unreadable.
it("accepts a reasoning model that declares no usable tier and reports it as such", async () => {
  const { wiring: providers } = wiring();
  const saved = (await providers.perform({ op: "save", profile: {
    ...wire,
    models: [{ id: "gpt-5", name: "GPT-5", contextWindow: 200000, maxTokens: 16384, reasoning: true, reasoningLevels: [] }],
    modelId: "gpt-5",
  } }, 1)) as { profile: { id: string; models: { reasoningLevels: string[] }[]; thinkingLevel: string | null } };
  expect(saved.profile.models[0]!.reasoningLevels).toEqual([]);
  expect(saved.profile.thinkingLevel).toBeNull();
  // The list still reads, and does not invent `off` for the row.
  const listed = (await providers.perform({ op: "list" }, 1)) as { profiles: { models: { reasoningLevels: string[] }[] }[] };
  expect(listed.profiles[0]!.models[0]!.reasoningLevels).toEqual([]);
  // Selecting it fails by name instead of pretending a level exists.
  await expect(providers.select("task-1", saved.profile.id, "gpt-5", undefined, 1)).rejects.toThrow(/thinking level/);
});

// [PiDock T03] #138 W8: only the two platform-encryption failures mean "no
// secure storage"; a rejected key is a different, named problem.
it("names a rejected key and an unreadable store separately from unavailable encryption", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pidock-provider-ipc-"));
  const store = new ProviderProfileStore(dir);
  const failing = (message: string) => {
    class Rejecting extends ProviderSecretStore {
      override set(): number { throw new Error(message); }
    }
    return new Rejecting(dir, createTestSafeStorage());
  };
  const codes: (string | undefined)[] = [];
  for (const message of [
    "provider-secret-invalid",
    "provider-secret-unreadable",
    "provider-secret-store-unavailable",
    "provider-secret-encrypt-failed",
  ]) {
    const providers = new ProviderWiring(store, async () => {}, ENV, { secrets: failing(message) });
    try {
      await providers.perform({ op: "save", profile: { ...wire, name: `Reject ${message}` }, apiKey: SECRET }, 1);
      codes.push(undefined);
    } catch (error) {
      codes.push((error as { code?: string }).code);
    }
  }
  // Only the two encryption failures are "安全存储不可用"; the others keep
  // their own cause (a rejected key, a damaged store file).
  expect(codes).toEqual(["credential-invalid", "secret-store-unreadable", "secret-store-unavailable", "secret-store-unavailable"]);
});
