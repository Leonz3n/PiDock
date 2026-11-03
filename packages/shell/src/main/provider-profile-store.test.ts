import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  ProviderProfileStore,
  SELECTION_STORED_CREDENTIAL_NOTE,
  SELECTION_VALUE_ROTATION_LIMITATION,
  resolveProviderCredential,
  type ProviderProfileInput,
} from "./provider-profile-store.js";

const SECRET = "sk-live-should-never-be-stored-0123456789";

function store() {
  const dir = mkdtempSync(join(tmpdir(), "pidock-provider-store-"));
  return { dir, store: new ProviderProfileStore(dir, () => "2026-09-29T00:00:00.000Z") };
}

const input: ProviderProfileInput = {
  name: "Local gateway",
  notes: "公司专用账号",
  protocol: "openai-completions",
  baseUrl: "https://models.example.test/v1",
  credentials: { kind: "env", ref: "PIDOCK_PROVIDER_EXAMPLE" },
  models: [
    { id: "gpt-5-mini", name: "GPT-5 mini", contextWindow: 128000, maxTokens: 8192, reasoning: false },
    { id: "gpt-5", name: "GPT-5", contextWindow: 200000, maxTokens: 16384, reasoning: true, thinkingLevelMap: { minimal: "minimal", low: "low", medium: "medium", high: "high" } },
  ],
  modelId: "gpt-5-mini",
};

it("persists metadata, every declared model row and the credential reference only", () => {
  const { dir, store: profiles } = store();
  const profile = profiles.save(input);
  expect(profile).toMatchObject({ name: input.name, protocol: "openai-completions", modelId: "gpt-5-mini", generation: 1, notes: "公司专用账号" });
  expect(profile.models.map((row) => row.id)).toEqual(["gpt-5-mini", "gpt-5"]);
  expect(profile.credentials).toEqual({ kind: "env", ref: "PIDOCK_PROVIDER_EXAMPLE" });
  const raw = readFileSync(join(dir, "provider-profiles.json"), "utf8");
  expect(raw).toContain("PIDOCK_PROVIDER_EXAMPLE");
  expect(raw).toContain("\"version\":2");
  expect(raw).not.toContain(SECRET);
  expect(raw).not.toContain("sk-");
});

// win32 (#57): POSIX mode bits are the only place "owner-only" is observable at all, and on win32
// `statSync().mode & 0o777` reads a synthesized 0o666 for files AND directories whatever the store
// asked for (`mkdirSync(..., {mode: 0o700})` / `openSync(temporary, "wx", 0o600)`) or `chmodSync`
// set (measured on this host). The store writes no ACL there, so "machine-private" is unenforced on
// win32 - mitigated in practice only by the per-user profile directory, which nothing here verifies.
// Named skip: this dimension is unobservable on win32, never a pass.
it.skipIf(process.platform === "win32")("keeps the profile document and its directory owner-only (POSIX mode bits)", () => {
  const { dir, store: profiles } = store();
  profiles.save(input);
  expect(statSync(join(dir, "provider-profiles.json")).mode & 0o777).toBe(0o600);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
});

it("keeps the generation stable for cosmetic edits and bumps it for defining changes", () => {
  const { store: profiles } = store();
  const created = profiles.save(input);
  expect(profiles.save({ ...input, id: created.id, name: "Renamed", notes: "新备注" }).generation).toBe(1);
  expect(profiles.list().profiles[0]?.name).toBe("Renamed");
  // Every defining dimension invalidates an existing session binding.
  const bumps = [
    { ...input, id: created.id, baseUrl: "https://other.example.test/v1" },
    { ...input, id: created.id, protocol: "anthropic-messages" as const },
    { ...input, id: created.id, modelId: "gpt-5" },
    { ...input, id: created.id, credentials: { kind: "env" as const, ref: "PIDOCK_PROVIDER_OTHER" } },
    { ...input, id: created.id, models: [input.models[0]!, { ...input.models[1]!, maxTokens: 4096 }] },
  ];
  let generation = 1;
  for (const next of bumps) {
    generation += 1;
    expect(profiles.save(next).generation).toBe(generation);
  }
});

it("drops a task selection when the selected profile changes meaning", () => {
  const { store: profiles } = store();
  const created = profiles.save(input);
  expect(profiles.select("task-1", created.id)).toMatchObject({ taskId: "task-1", profileId: created.id, generation: 1, modelId: "gpt-5-mini", thinkingLevel: "off" });
  profiles.save({ ...input, id: created.id, modelId: "gpt-5" });
  // The user must re-select explicitly: a silent swap would continue a session
  // under an identity it was never bound to.
  expect(profiles.selection("task-1")).toBeNull();
});

it("selects a model and a reasoning level per task, defaulting from the model's declaration", () => {
  const { store: profiles } = store();
  const created = profiles.save(input);
  expect(profiles.select("task-1", created.id, "gpt-5", "medium")).toMatchObject({ modelId: "gpt-5", thinkingLevel: "medium" });
  // A reasoning-capable model defaults to a thinking level; a non-reasoning one to `off`.
  expect(profiles.select("task-2", created.id).thinkingLevel).toBe("off");
  expect(profiles.select("task-3", created.id, "gpt-5").thinkingLevel).toBe("high");
  expect(() => profiles.select("task-4", created.id, "not-a-model")).toThrow("provider-model-unknown");
  expect(() => profiles.select("task-4", created.id, "gpt-5", "ultra" as never)).toThrow();
});

it("hands the isolated context an explicit protocol, every model row and the selected window", () => {
  const { store: profiles } = store();
  const created = profiles.save(input);
  const config = profiles.config(created.id, "gpt-5");
  expect(config).toMatchObject({
    profileId: created.id, protocol: "openai-completions", baseUrl: input.baseUrl, modelId: "gpt-5",
    contextWindow: 200000, maxTokens: 16384, credentialSource: "env", authRef: "PIDOCK_PROVIDER_EXAMPLE", generation: 1,
  });
  expect(config.models.map((row) => row.id)).toEqual(["gpt-5-mini", "gpt-5"]);
  expect(() => profiles.config(created.id, "unknown")).toThrow("provider-model-unknown");
});

it("scopes selections per task and removes both on profile deletion", () => {
  const { store: profiles } = store();
  const first = profiles.save(input);
  const second = profiles.save({ ...input, name: "Backup" });
  profiles.select("task-1", first.id);
  profiles.select("task-2", second.id);
  expect(profiles.selection("task-1")?.profileId).toBe(first.id);
  expect(profiles.selection("task-2")?.profileId).toBe(second.id);
  expect(profiles.selection("task-3")).toBeNull();
  profiles.deselect("task-1");
  expect(profiles.selection("task-1")).toBeNull();
  profiles.remove(second.id);
  expect(profiles.selection("task-2")).toBeNull();
  expect(profiles.list().profiles.map((row) => row.id)).toEqual([first.id]);
});

it("refuses configurations the runtime would reject anyway", () => {
  const { store: profiles } = store();
  const model = input.models[0]!;
  const bad: Partial<ProviderProfileInput>[] = [
    { baseUrl: "http://models.example.test/v1" },
    { baseUrl: "https://user:pw@models.example.test/v1" },
    { credentials: { kind: "env", ref: "OPENAI_API_KEY" } },
    { models: [{ ...model, id: "" }] },
    { models: [{ ...model, contextWindow: 1 }] },
    { models: [{ ...model, maxTokens: 10 ** 9 }] },
    { models: [model, model] },
    { modelId: "missing" },
    // A non-reasoning model may not carry a thinking map: that would let the UI
    // offer levels the SDK cannot honour.
    { models: [{ ...model, thinkingLevelMap: { low: "low" } }] },
  ];
  for (const patch of bad) expect(() => profiles.save({ ...input, ...patch })).toThrow();
  expect(profiles.list().profiles).toHaveLength(0);
});

it("fails closed on an unreadable or foreign document instead of guessing", () => {
  const { dir, store: profiles } = store();
  profiles.save(input);
  const file = join(dir, "provider-profiles.json");
  const good = readFileSync(file, "utf8");
  writeFileSync(file, "{\"version\":3,\"profiles\":[],\"selections\":[]}");
  expect(() => profiles.list()).toThrow(/version/);
  writeFileSync(file, "{ not json");
  expect(() => profiles.list()).toThrow();
  const profile = JSON.parse(good).profiles[0];
  writeFileSync(file, JSON.stringify({ version: 2, profiles: [{ ...profile, credential: SECRET }], selections: [] }));
  expect(() => profiles.list()).toThrow(/fields/);
  writeFileSync(file, JSON.stringify({ version: 2, profiles: [{ ...profile, native: { providerId: "other", fingerprint: null, writtenAt: null } }], selections: [] }));
  expect(() => profiles.list()).toThrow(/native/);
  writeFileSync(file, good);
  expect(profiles.list().profiles).toHaveLength(1);
});

it("migrates a v1 document to the explicit protocol it was actually built with", () => {
  const { dir, store: profiles } = store();
  const legacy = {
    version: 1,
    profiles: [{
      id: "p-11111111-2222-3333-4444-555555555555", name: "Legacy", baseUrl: "https://models.example.test/v1",
      modelId: "gpt-5-mini", contextWindow: 128000, maxTokens: 8192, authRef: "PIDOCK_PROVIDER_EXAMPLE",
      generation: 2, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    }],
    selections: [{ taskId: "task-1", profileId: "p-11111111-2222-3333-4444-555555555555", generation: 2, at: "2026-01-01T00:00:00.000Z" }],
  };
  writeFileSync(join(dir, "provider-profiles.json"), JSON.stringify(legacy));
  const profile = profiles.list().profiles[0]!;
  // v1 registered every profile through the `openai-completions` runtime; the
  // migration records that fact rather than guessing from the vendor or URL.
  expect(profile).toMatchObject({ protocol: "openai-completions", modelId: "gpt-5-mini", generation: 2 });
  expect(profile.credentials).toEqual({ kind: "env", ref: "PIDOCK_PROVIDER_EXAMPLE" });
  expect(profile.models).toEqual([{ id: "gpt-5-mini", name: "gpt-5-mini", contextWindow: 128000, maxTokens: 8192, reasoning: false }]);
  expect(profile.native).toEqual({ providerId: `pidock-${profile.id}`, fingerprint: null, writtenAt: null });
  expect(profiles.selection("task-1")).toMatchObject({ modelId: "gpt-5-mini", thinkingLevel: "off", generation: 2 });
  // Writing again persists the v2 shape.
  profiles.save({ ...input, id: profile.id });
  expect(JSON.parse(readFileSync(join(dir, "provider-profiles.json"), "utf8")).version).toBe(2);
});

it("resolves the credential from its reference and never from ambient fallback", () => {
  expect(resolveProviderCredential({ authRef: "PIDOCK_PROVIDER_EXAMPLE" }, { PIDOCK_PROVIDER_EXAMPLE: SECRET })).toBe(SECRET);
  expect(() => resolveProviderCredential({ authRef: "PIDOCK_PROVIDER_EXAMPLE" }, {})).toThrow("provider-not-configured");
  expect(() => resolveProviderCredential({ authRef: "PIDOCK_PROVIDER_EXAMPLE" }, { PIDOCK_PROVIDER_EXAMPLE: "" })).toThrow("provider-not-configured");
  expect(() => resolveProviderCredential({ authRef: "PIDOCK_PROVIDER_EXAMPLE" }, { PIDOCK_PROVIDER_EXAMPLE: "x".repeat(4097) })).toThrow("provider-not-configured");
  // A different ambient provider key must not satisfy the reference.
  expect(() => resolveProviderCredential({ authRef: "PIDOCK_PROVIDER_EXAMPLE" }, { OPENAI_API_KEY: SECRET })).toThrow("provider-not-configured");
});

it("never lets a name-like credential reference resolve an unrelated variable", () => {
  const { store: profiles } = store();
  expect(() => profiles.save({ ...input, credentials: { kind: "env", ref: "PIDOCK_PROVIDER_EXAMPLE;rm -rf /" } })).toThrow();
  expect(() => profiles.save({ ...input, credentials: { kind: "env", ref: "PIDOCK_PROVIDER_EXAMPLE\nOPENAI_API_KEY" } })).toThrow();
});

it("states the credential-rotation limitation that matches each credential source", () => {
  const { dir, store: profiles } = store();
  const created = profiles.save(input);
  profiles.select("task-1", created.id);
  // #46: for an env reference the digest pins the *name*, so a rotated value
  // behind that name is undetectable. The persisted record must say so itself.
  expect(profiles.list().selections[0]?.note).toBe(SELECTION_VALUE_ROTATION_LIMITATION);
  const raw = readFileSync(join(dir, "provider-profiles.json"), "utf8");
  expect(raw).toMatch(/rotation/i);
  expect(raw).toMatch(/"note":"[^"]*generation/i);

  // A stored credential pins the ciphertext revision, so replacing the key is
  // observed (it bumps the generation) and the note says that instead.
  const stored = profiles.save({
    ...input, name: "Stored", credentials: { kind: "store", revision: 3 },
  });
  profiles.select("task-2", stored.id);
  expect(profiles.list().selections.find((row) => row.taskId === "task-2")?.note).toBe(SELECTION_STORED_CREDENTIAL_NOTE);
});

it("refuses a selection note that contradicts the recorded disclosure", () => {
  const { dir, store: profiles } = store();
  const created = profiles.save(input);
  profiles.select("task-1", created.id);
  const file = join(dir, "provider-profiles.json");
  const good = readFileSync(file, "utf8");
  const stripped = JSON.parse(good);
  delete stripped.selections[0].note;
  // A pre-note record stays readable.
  writeFileSync(file, JSON.stringify(stripped));
  expect(profiles.list().selections[0]?.note).toBeUndefined();
  stripped.selections[0].note = "nothing to disclose";
  writeFileSync(file, JSON.stringify(stripped));
  expect(() => profiles.list()).toThrow();
  writeFileSync(file, good);
  expect(profiles.list().selections[0]?.note).toBe(SELECTION_VALUE_ROTATION_LIMITATION);
});

it("records what PiDock last wrote to the native file without changing the generation", () => {
  const { store: profiles } = store();
  const created = profiles.save(input);
  const recorded = profiles.recordNative(created.id, { providerId: `pidock-${created.id}`, fingerprint: "a".repeat(64), writtenAt: "2026-09-29T00:00:00.000Z" });
  expect(recorded.native.fingerprint).toBe("a".repeat(64));
  expect(recorded.generation).toBe(1);
  expect(() => profiles.recordNative(created.id, { providerId: "other", fingerprint: null, writtenAt: null })).toThrow();
});
