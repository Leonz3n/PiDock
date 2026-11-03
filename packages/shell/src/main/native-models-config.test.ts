import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  NativeModelsFile,
  fingerprintOf,
  isManagedProviderId,
  managedProviderId,
  modelsJsonPath,
  resolveAgentDir,
  type NativeProviderEntry,
} from "./native-models-config.js";

const PROFILE = "p-11111111-2222-3333-4444-555555555555";
const OTHER = "p-99999999-8888-7777-6666-555555555555";
const PROVIDER_ID = `pidock-${PROFILE}`;

const entry: NativeProviderEntry = {
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com/v1",
  api: "openai-completions",
  apiKey: "$PIDOCK_PROVIDER_DEEPSEEK",
  models: [
    { id: "deepseek-chat", name: "DeepSeek V3", reasoning: false, contextWindow: 128000, maxTokens: 8192 },
    {
      id: "deepseek-reasoner",
      name: "DeepSeek R1",
      reasoning: true,
      thinkingLevelMap: { minimal: null, low: "low", medium: "medium", high: "high" },
      contextWindow: 64000,
      maxTokens: 8192,
    },
  ],
};

function file(existing?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "pidock-models-json-"));
  const models = new NativeModelsFile(dir);
  if (existing !== undefined) writeFileSync(models.path, typeof existing === "string" ? existing : JSON.stringify(existing, null, 2));
  return { dir, models, path: models.path };
}

function read(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

it("writes one namespaced provider into models.json and reads it back", () => {
  const { models, path } = file();
  const written = models.write(PROFILE, entry);
  expect(written.fingerprint).toBe(fingerprintOf(entry));
  expect(written.created).toBe(true);
  const raw = read(path);
  expect((raw["providers"] as Record<string, unknown>)[PROVIDER_ID]).toEqual(entry);
  // Pi's own schema hint is kept so an editor can validate the file.
  expect(raw["$schema"]).toBe("https://pi.dev/schemas/models.schema.json");
  expect(models.fingerprint(PROFILE)).toBe(written.fingerprint);
  expect(models.state(PROFILE, written.fingerprint)).toBe("synced");
});

it("preserves unmanaged providers, unmanaged models and unknown fields", () => {
  const existing = {
    $schema: "https://pi.dev/schemas/models.schema.json",
    // Fields PiDock does not own must survive a write cycle.
    experimental: { note: "kept" },
    providers: {
      ollama: { baseUrl: "http://localhost:11434/v1", api: "openai-completions", models: [{ id: "qwen2.5-coder:7b" }] },
      anthropic: { baseUrl: "https://proxy.example.test/v1" },
      [PROVIDER_ID]: { name: "stale", baseUrl: "https://old.example.test/v1", api: "openai-responses", models: [{ id: "old" }] },
      [`pidock-${OTHER}`]: { name: "Other", baseUrl: "https://other.example.test/v1", api: "anthropic-messages", models: [{ id: "m" }] },
    },
  };
  const { models, path } = file(existing);
  models.write(PROFILE, entry);
  const raw = read(path);
  expect(raw["experimental"]).toEqual({ note: "kept" });
  const providers = raw["providers"] as Record<string, unknown>;
  expect(providers["ollama"]).toEqual(existing.providers.ollama);
  expect(providers["anthropic"]).toEqual(existing.providers.anthropic);
  // Another managed profile is not ours to touch.
  expect(providers[`pidock-${OTHER}`]).toEqual(existing.providers[`pidock-${OTHER}`]);
  expect(providers[PROVIDER_ID]).toEqual(entry);
  expect(Object.keys(providers).sort()).toEqual(["anthropic", "ollama", PROVIDER_ID, `pidock-${OTHER}`].sort());
});

it("writes atomically with a private mode and keeps one backup of the previous file", () => {
  const { dir, models, path } = file({ providers: { ollama: { baseUrl: "http://localhost:11434/v1", api: "openai-completions" } } });
  const before = readFileSync(path, "utf8");
  models.write(PROFILE, entry);
  expect(readFileSync(join(dir, "models.json.bak"), "utf8")).toBe(before);
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  // No temp files left behind.
  expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
});

it("removes only the managed entry and leaves the rest of the document", () => {
  const { models, path } = file({ providers: { ollama: { baseUrl: "http://localhost:11434/v1" } } });
  models.write(PROFILE, entry);
  expect(models.remove(PROFILE)).toBe(true);
  expect(models.remove(PROFILE)).toBe(false);
  const providers = read(path)["providers"] as Record<string, unknown>;
  expect(providers[PROVIDER_ID]).toBeUndefined();
  expect(providers["ollama"]).toEqual({ baseUrl: "http://localhost:11434/v1" });
});

it("names an external edit instead of silently overwriting it", () => {
  const { models, path } = file();
  const written = models.write(PROFILE, entry);

  // Someone edits the managed entry outside PiDock.
  const edited = read(path);
  (edited["providers"] as Record<string, unknown>)[PROVIDER_ID] = { ...entry, baseUrl: "https://hand-edited.example.test/v1" };
  writeFileSync(path, JSON.stringify(edited));
  expect(models.state(PROFILE, written.fingerprint)).toBe("modified");
  // The external value is still what the file says — a read never rewrites it.
  expect(models.fingerprint(PROFILE)).not.toBe(written.fingerprint);

  // Someone removes the managed entry.
  const removed = read(path);
  delete (removed["providers"] as Record<string, unknown>)[PROVIDER_ID];
  writeFileSync(path, JSON.stringify(removed));
  expect(models.state(PROFILE, written.fingerprint)).toBe("removed");

  // A manual file edit that leaves the entry byte-identical is still "synced".
  writeFileSync(path, JSON.stringify({ providers: { [PROVIDER_ID]: entry } }, null, 0));
  expect(models.state(PROFILE, written.fingerprint)).toBe("synced");
});

it("reports a never-written profile and an unreadable file by name", () => {
  const { models, path } = file();
  expect(models.state(PROFILE, null)).toBe("never-written");
  writeFileSync(path, "{ not json");
  expect(models.read()).toEqual({ ok: false, error: "models-unreadable" });
  expect(models.state(PROFILE, "abc")).toBe("unreadable");
  expect(() => models.write(PROFILE, entry)).toThrow("provider-models-unreadable");
  writeFileSync(path, JSON.stringify({ providers: [] }));
  expect(models.state(PROFILE, "abc")).toBe("unreadable");
});

it("round-trips a reconnect: a fresh instance reads what the previous one wrote", () => {
  const { dir, models } = file();
  const written = models.write(PROFILE, entry);
  const reopened = new NativeModelsFile(dir);
  expect(reopened.fingerprint(PROFILE)).toBe(written.fingerprint);
  expect(reopened.state(PROFILE, written.fingerprint)).toBe("synced");
  expect(reopened.entry(PROFILE)).toEqual(entry);
});

it("rejects profile ids that would escape the namespaced key", () => {
  expect(() => managedProviderId("p-1")).toThrow("provider-profile-invalid");
  expect(() => managedProviderId("../escape")).toThrow("provider-profile-invalid");
  expect(managedProviderId(PROFILE)).toBe(PROVIDER_ID);
  expect(isManagedProviderId(PROVIDER_ID)).toBe(true);
  expect(isManagedProviderId("openai")).toBe(false);
});

it("resolves the agent directory with the testable override", () => {
  expect(resolveAgentDir({}, "/home/user")).toBe(join("/home/user", ".pi", "agent"));
  expect(resolveAgentDir({ PIDOCK_AGENT_DIR: "/tmp/agent" }, "/home/user")).toBe("/tmp/agent");
  // S10: the override picks the file PiDock writes, so a relative path (which
  // would resolve against whatever cwd Electron started in) is refused.
  expect(() => resolveAgentDir({ PIDOCK_AGENT_DIR: "relative/agent" }, "/home/user")).toThrow("provider-agent-dir-invalid");
  expect(() => resolveAgentDir({ PIDOCK_AGENT_DIR: "./agent" }, "/home/user")).toThrow("provider-agent-dir-invalid");
  // A blank override is not an override.
  expect(resolveAgentDir({ PIDOCK_AGENT_DIR: "   " }, "/home/user")).toBe(join("/home/user", ".pi", "agent"));
  expect(modelsJsonPath("/tmp/agent")).toBe(join("/tmp/agent", "models.json"));
});

// S11: the `.bak` copy holds no secret but is still Pi configuration, so it
// must be as private as the file it copies.
it("keeps the .bak copy private (0600) instead of the umask default", () => {
  const { models, dir } = file();
  models.write(PROFILE, entry);
  models.write(PROFILE, { ...entry, name: "Renamed" });
  const mode = statSync(join(dir, "models.json.bak")).mode & 0o777;
  expect(mode).toBe(0o600);
});
