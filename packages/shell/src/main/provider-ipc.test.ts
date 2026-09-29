import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ProviderWiring, type ProviderInstaller } from "./provider-ipc.js";
import { ProviderProfileStore } from "./provider-profile-store.js";

const SECRET = "sk-live-0123456789-abcdefghijklmnop";
const ENV = { PIDOCK_PROVIDER_EXAMPLE: SECRET };

const input = {
  name: "Local gateway",
  baseUrl: "https://models.example.test/v1",
  modelId: "gpt-5-mini",
  contextWindow: 128000,
  maxTokens: 8192,
  authRef: "PIDOCK_PROVIDER_EXAMPLE",
};

function wiring(install?: ProviderInstaller, env: Record<string, string | undefined> = ENV) {
  const dir = mkdtempSync(join(tmpdir(), "pidock-provider-ipc-"));
  const store = new ProviderProfileStore(dir, () => "2026-09-29T00:00:00.000Z");
  const calls: { taskId: string; provider: { profileId: string; credential: string } | null; sender: number }[] = [];
  const installer: ProviderInstaller = install ?? (async (taskId, provider, sender) => { calls.push({ taskId, provider, sender }); });
  return { store, calls, wiring: new ProviderWiring(store, installer, env) };
}

it("never returns a credential or credential source to the renderer", async () => {
  const { store, wiring: providers } = wiring();
  const profile = (await providers.perform({ op: "save", taskId: "task-1", profile: input }, 7)) as { profile: { id: string } };
  expect(store.list().profiles).toHaveLength(1);
  const status = await providers.perform({ op: "list", taskId: "task-1" }, 7);
  const serialized = JSON.stringify([profile, status]);
  expect(serialized).not.toContain(SECRET);
  expect(serialized).not.toContain("credential\"");
  // The reference name and a boolean availability flag are all the renderer sees.
  expect(serialized).toContain("PIDOCK_PROVIDER_EXAMPLE");
  expect(serialized).toContain("\"credentialAvailable\":true");
  expect((status as { profiles: unknown[] }).profiles).toHaveLength(1);
  expect(profile.profile.id).toMatch(/^p-/);
});

it("installs the resolved credential in the isolated context and only then persists the selection", async () => {
  const order: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "pidock-provider-ipc-"));
  const store = new ProviderProfileStore(dir, () => "2026-09-29T00:00:00.000Z");
  const created = store.save(input);
  const providers = new ProviderWiring(store, async (taskId, provider, sender) => {
    order.push(`install:${taskId}:${provider?.profileId ?? "none"}:${provider === null ? "" : provider.credential === SECRET ? "secret" : "leaked"}:${sender}`);
  }, ENV);
  const status = await providers.select("task-1", created.id, 42);
  expect(order).toEqual([`install:task-1:${created.id}:secret:42`]);
  expect(status.state).toBe("configured");
  expect(store.selection("task-1")).toMatchObject({ profileId: created.id, generation: 1 });
});

it("fails closed without persisting a selection when the credential is missing or the context refuses", async () => {
  const missing = wiring(undefined, {});
  const profile = missing.store.save(input);
  const status = await missing.wiring.select("task-1", profile.id, 1);
  expect(status.state).toBe("credential-missing");
  expect(missing.store.selection("task-1")).toBeNull();
  expect(missing.calls).toHaveLength(0);
  expect((status.profiles[0] ?? { credentialAvailable: true }).credentialAvailable).toBe(false);

  const refusing = wiring(async () => { throw new Error("provider-environment-unisolated"); });
  const profile2 = refusing.store.save(input);
  const status2 = await refusing.wiring.select("task-1", profile2.id, 1);
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
});

it("drops the live context before dropping the record when clearing or removing", async () => {
  const { store, calls, wiring: providers } = wiring();
  const profile = store.save(input);
  await providers.select("task-1", profile.id, 3);
  await providers.perform({ op: "clear", taskId: "task-1" }, 3);
  expect(calls.at(-1)?.provider).toBeNull();
  expect(store.selection("task-1")).toBeNull();

  await providers.select("task-1", profile.id, 3);
  const removed = (await providers.perform({ op: "remove", taskId: "task-1", profileId: profile.id }, 3)) as { state: string };
  expect(calls.at(-1)?.provider).toBeNull();
  expect(removed.state).toBe("not-configured");
  expect(store.list().profiles).toHaveLength(0);
});

it("a bumped generation drops the selection and forces an explicit re-install", async () => {
  const { store, calls, wiring: providers } = wiring();
  const profile = store.save(input);
  await providers.select("task-1", profile.id, 1);
  expect(calls).toHaveLength(1);
  const after = (await providers.perform({ op: "save", taskId: "task-1", profile: { ...input, id: profile.id, modelId: "gpt-5" } }, 1)) as { status: { state: string } };
  expect(after.status.state).toBe("not-configured");
  expect(store.selection("task-1")).toBeNull();
  await providers.perform({ op: "select", taskId: "task-1", profileId: profile.id }, 1);
  expect(calls).toHaveLength(2);
});

it("rejects renderer payloads that try to reach past the profile shape", async () => {
  const { wiring: providers } = wiring();
  const hostile = [
    { op: "list" },
    { op: "list", taskId: "task-1", env: { OPENAI_API_KEY: "x" } },
    { op: "save", taskId: "task-1", profile: { ...input, credential: SECRET } },
    { op: "save", taskId: "task-1", profile: { ...input, authRef: "OPENAI_API_KEY" } },
    { op: "select", taskId: "task-1", profileId: "PIDOCK_PROVIDER_EXAMPLE" },
    { op: "select", taskId: "../escape", profileId: "p-00000000-0000-0000-0000-000000000000" },
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
  const profile = stale.store.save(input);
  const status = await stale.wiring.select("task-1", profile.id, 1);
  // A generation/endpoint change invalidates the recorded binding; re-selecting
  // the same profile cannot fix it, so the state must say so rather than claim
  // a recovery path that does not exist yet.
  expect(status.state).toBe("binding-stale");
  expect(await stale.wiring.select("task-1", profile.id, 1)).toMatchObject({ state: "binding-stale" });
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
  await providers.select("task-1", profile.id, 1);
  const status = (await providers.perform({ op: "list", taskId: "task-1" }, 1)) as { state: string };
  expect(status.state).toBe("configured");
  expect(install).toHaveBeenCalledTimes(1);
});
