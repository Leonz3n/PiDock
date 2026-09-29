import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ProviderProfileStore, resolveProviderCredential } from "./provider-profile-store.js";

const SECRET = "sk-live-should-never-be-stored-0123456789";

function store() {
  const dir = mkdtempSync(join(tmpdir(), "pidock-provider-store-"));
  return { dir, store: new ProviderProfileStore(dir, () => "2026-09-29T00:00:00.000Z") };
}

const input = {
  name: "Local gateway",
  baseUrl: "https://models.example.test/v1",
  modelId: "gpt-5-mini",
  contextWindow: 128000,
  maxTokens: 8192,
  authRef: "PIDOCK_PROVIDER_EXAMPLE",
};

it("persists metadata and the credential reference only, with private file modes", () => {
  const { dir, store: profiles } = store();
  const profile = profiles.save(input);
  expect(profile).toMatchObject({ ...input, generation: 1 });
  const raw = readFileSync(join(dir, "provider-profiles.json"), "utf8");
  expect(raw).toContain("PIDOCK_PROVIDER_EXAMPLE");
  expect(raw).not.toContain(SECRET);
  expect(raw).not.toContain("sk-");
  expect(statSync(join(dir, "provider-profiles.json")).mode & 0o777).toBe(0o600);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
});

it("keeps the generation stable for cosmetic edits and bumps it for defining changes", () => {
  const { store: profiles } = store();
  const created = profiles.save(input);
  expect(profiles.save({ ...input, id: created.id, name: "Renamed" }).generation).toBe(1);
  expect(profiles.list().profiles[0]?.name).toBe("Renamed");
  expect(profiles.save({ ...input, id: created.id, modelId: "gpt-5" }).generation).toBe(2);
  expect(profiles.save({ ...input, id: created.id, authRef: "PIDOCK_PROVIDER_OTHER" }).generation).toBe(3);
});

it("drops a task selection when the selected profile changes meaning", () => {
  const { store: profiles } = store();
  const created = profiles.save(input);
  expect(profiles.select("task-1", created.id)).toMatchObject({ taskId: "task-1", profileId: created.id, generation: 1 });
  expect(profiles.selection("task-1")).toMatchObject({ generation: 1 });
  profiles.save({ ...input, id: created.id, maxTokens: 4096 });
  // The user must re-select explicitly: a silent swap would continue a session
  // under an identity it was never bound to.
  expect(profiles.selection("task-1")).toBeNull();
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
  expect(() => profiles.save({ ...input, baseUrl: "http://models.example.test/v1" })).toThrow();
  expect(() => profiles.save({ ...input, baseUrl: "https://user:pw@models.example.test/v1" })).toThrow();
  expect(() => profiles.save({ ...input, authRef: "OPENAI_API_KEY" })).toThrow();
  expect(() => profiles.save({ ...input, modelId: "" })).toThrow();
  expect(() => profiles.save({ ...input, contextWindow: 1 })).toThrow();
  expect(() => profiles.save({ ...input, maxTokens: 10 ** 9 })).toThrow();
  expect(profiles.list().profiles).toHaveLength(0);
});

it("fails closed on an unreadable or foreign document instead of guessing", () => {
  const { dir, store: profiles } = store();
  profiles.save(input);
  const file = join(dir, "provider-profiles.json");
  const good = readFileSync(file, "utf8");
  writeFileSync(file, "{\"version\":2,\"profiles\":[],\"selections\":[]}");
  expect(() => profiles.list()).toThrow(/version/);
  writeFileSync(file, "{ not json");
  expect(() => profiles.list()).toThrow();
  writeFileSync(file, JSON.parse(good).profiles[0] && JSON.stringify({ version: 1, profiles: [{ ...JSON.parse(good).profiles[0], credential: SECRET }], selections: [] }));
  expect(() => profiles.list()).toThrow(/fields/);
  writeFileSync(file, good);
  expect(profiles.list().profiles).toHaveLength(1);
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
  expect(() => profiles.save({ ...input, authRef: "PIDOCK_PROVIDER_EXAMPLE;rm -rf /" })).toThrow();
  expect(() => profiles.save({ ...input, authRef: "PIDOCK_PROVIDER_EXAMPLE\nOPENAI_API_KEY" })).toThrow();
});
