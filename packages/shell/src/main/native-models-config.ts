/**
 * Pi's native `models.json` as the Provider management object — [PiDock T03] #138.
 *
 * Pi 1.5.0 reads compatible endpoints from `<agent-dir>/models.json`, where
 * `<agent-dir>` is `~/.pi/agent` unless `PI_CODING_AGENT_DIR` (or the SDK's
 * `agentDir` option) says otherwise (`docs/configuration.md#agent-directory`).
 * This module owns the *managed slice* of that file:
 *
 * - New entries and removals use only `pidock-<profileId>`. Explicit edits of
 *   existing user-owned entries require the exact observed fingerprint and keep
 *   their provider/model identities and credentials. Every unknown
 *   field is preserved byte-for-value through a read → mutate → write cycle.
 * - Writes are atomic (temp file + fsync + rename) and leave one `.bak` copy of
 *   the previous file, so a crash cannot truncate a file Pi also reads.
 * - PiDock records the fingerprint of what it wrote. On reopen the caller
 *   compares the recorded fingerprint with the file: a managed entry that was
 *   edited or deleted elsewhere is reported by name (`modified` / `removed`)
 *   instead of being silently overwritten.
 *
 * This module never touches credentials: a credential stays in
 * `provider-secret-store.ts` and is injected into the SDK request at runtime.
 * Only env-backed profiles write Pi's `"$NAME"` interpolation form, which is a
 * reference, not a value.
 */

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/** The SDK API ids PiDock supports explicitly (never guessed from a vendor or URL). */
export const NATIVE_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export type NativeApi = (typeof NATIVE_APIS)[number];

export interface NativeCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface NativeModelRow {
  id: string;
  name?: string;
  reasoning?: boolean;
  /** Pi thinking level → provider value; `null` marks a level unsupported. */
  thinkingLevelMap?: Record<string, string | null>;
  contextWindow?: number;
  maxTokens?: number;
  /** Absent when the user did not declare a price: unknown must not look like zero. */
  cost?: NativeCost;
}

export interface NativeProviderEntry {
  name: string;
  baseUrl: string;
  api: NativeApi;
  /** `"$ENV_NAME"` for env-backed profiles; absent for safeStorage-backed ones. */
  apiKey?: string;
  models: NativeModelRow[];
}

export type NativeManagedState = "synced" | "modified" | "removed" | "never-written" | "unreadable";

const FILE = "models.json";
const BACKUP = "models.json.bak";
const MAX_BYTES = 2 * 1024 * 1024;
const PROVIDER_ID = /^pidock-p-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The namespaced provider id; only ids in this shape are ever touched. */
export function managedProviderId(profileId: string): string {
  const id = `pidock-${profileId}`;
  if (!PROVIDER_ID.test(id)) throw new Error("provider-profile-invalid");
  return id;
}

export function isManagedProviderId(value: unknown): value is string {
  return typeof value === "string" && PROVIDER_ID.test(value);
}

/**
 * The default Pi agent directory; `PIDOCK_AGENT_DIR` overrides Pi's
 * `PI_CODING_AGENT_DIR`, which overrides the home default (tests,
 * alternate homes). The override decides which file PiDock writes, so it must
 * be an absolute path: a relative one would silently resolve against whatever
 * working directory the app was started in.
 */
export function resolveAgentDir(env: Record<string, string | undefined>, home: string): string {
  const override = env["PIDOCK_AGENT_DIR"]?.trim() || env["PI_CODING_AGENT_DIR"];
  if (typeof override === "string" && override.trim().length > 0) {
    if (!isAbsolute(override.trim())) throw new Error("provider-agent-dir-invalid");
    return override.trim();
  }
  return join(home, ".pi", "agent");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deterministic JSON (sorted keys) so a fingerprint never depends on key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function fingerprintOf(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export interface NativeDocument {
  ok: true;
  raw: Record<string, unknown>;
  providers: Record<string, unknown>;
  /** True when the file exists but its `providers` block had to be created. */
  created: boolean;
}

export type NativeRead = NativeDocument | { ok: false; error: "models-unreadable" };

function emptyRoot(): Record<string, unknown> {
  return { $schema: "https://pi.dev/schemas/models.schema.json", providers: {} };
}

/**
 * The managed file. Every method re-reads the file, so an external edit that
 * happened between two UI actions is observed rather than overwritten from a
 * stale in-memory copy.
 */
export class NativeModelsFile {
  private readonly file: string;
  private readonly backup: string;

  constructor(readonly agentDir: string) {
    this.file = join(agentDir, FILE);
    this.backup = join(agentDir, BACKUP);
  }

  get path(): string { return this.file; }

  read(): NativeRead {
    if (!existsSync(this.file)) {
      const raw = emptyRoot();
      return { ok: true, raw, providers: raw["providers"] as Record<string, unknown>, created: true };
    }
    try {
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.size > MAX_BYTES) return { ok: false, error: "models-unreadable" };
      const value: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (!record(value)) return { ok: false, error: "models-unreadable" };
      const providers = value["providers"];
      if (providers === undefined) {
        const raw = { ...value, providers: {} };
        return { ok: true, raw, providers: raw["providers"] as Record<string, unknown>, created: false };
      }
      if (!record(providers)) return { ok: false, error: "models-unreadable" };
      return { ok: true, raw: value, providers, created: false };
    } catch {
      return { ok: false, error: "models-unreadable" };
    }
  }

  /** The raw managed entry as it currently sits in the file, or `undefined`. */
  entry(profileId: string): unknown {
    const providerId = managedProviderId(profileId);
    const read = this.read();
    return read.ok ? read.providers[providerId] : undefined;
  }

  /** Fingerprint of the managed entry currently in the file, or `null` when absent. */
  fingerprint(profileId: string): string | null {
    const entry = this.entry(profileId);
    return entry === undefined ? null : fingerprintOf(entry);
  }

  /**
   * Read-back state against the fingerprint PiDock recorded when it last wrote.
   * A managed entry changed or deleted outside PiDock is named, never assumed
   * to still mean what PiDock wrote.
   */
  state(profileId: string, recorded: string | null): NativeManagedState {
    if (recorded === null) return "never-written";
    const read = this.read();
    if (!read.ok) return "unreadable";
    const entry = read.providers[managedProviderId(profileId)];
    if (entry === undefined) return "removed";
    return fingerprintOf(entry) === recorded ? "synced" : "modified";
  }

  /**
   * Write (or replace) exactly one managed provider entry. Returns the new
   * fingerprint and whether a `.bak` of the previous file was left behind.
   *
   * The caller passes the entry PiDock intends the file to hold; unmanaged
   * providers and unknown root/ provider fields survive untouched.
   */
  write(profileId: string, entry: NativeProviderEntry): { fingerprint: string; backup: boolean; created: boolean } {
    const providerId = managedProviderId(profileId);
    const read = this.read();
    if (!read.ok) throw new Error("provider-models-unreadable");
    const existedBefore = existsSync(this.file);
    const nextProviders = { ...read.providers, [providerId]: entry as unknown as Record<string, unknown> };
    const nextRoot = { ...read.raw, providers: nextProviders };
    this.commit(nextRoot, existedBefore);
    return { fingerprint: fingerprintOf(entry), backup: existedBefore, created: read.providers[providerId] === undefined };
  }

  /** Remove only the managed entry; returns true when something was removed. */
  remove(profileId: string): boolean {
    const providerId = managedProviderId(profileId);
    const read = this.read();
    if (!read.ok) throw new Error("provider-models-unreadable");
    if (read.providers[providerId] === undefined) return false;
    const nextProviders = { ...read.providers };
    delete nextProviders[providerId];
    this.commit({ ...read.raw, providers: nextProviders }, existsSync(this.file));
    return true;
  }

  /**
   * Put back an entry read earlier from this file, verbatim. Used to undo a
   * managed write whose metadata half failed, so the file never keeps a
   * `pidock-*` provider that PiDock has no profile for.
   */
  restore(profileId: string, entry: unknown): void {
    const providerId = managedProviderId(profileId);
    const read = this.read();
    if (!read.ok) throw new Error("provider-models-unreadable");
    this.commit({ ...read.raw, providers: { ...read.providers, [providerId]: entry as Record<string, unknown> } }, existsSync(this.file));
  }

  /** Explicit field edit of a user-owned entry; no rename, adoption or deletion. */
  editExisting(providerId: string, expected: string, patch: NativeProviderEntry): void {
    const read = this.read();
    if (!read.ok) throw new Error("provider-models-unreadable");
    const previous = read.providers[providerId];
    if (!record(previous) || fingerprintOf(previous) !== expected) throw new Error("provider-native-conflict");
    if (!Array.isArray(previous["models"]) || patch.models.length !== previous["models"].length ||
        patch.models.some((row, index) => !record((previous["models"] as unknown[])[index]) ||
          ((previous["models"] as Record<string, unknown>[])[index])?.["id"] !== row.id)) {
      throw new Error("provider-native-model-identity");
    }
    const models = patch.models.map((row, index) => {
      const original = { ...(previous["models"] as Record<string, unknown>[])[index] };
      delete original["cost"];
      delete original["thinkingLevelMap"];
      return { ...original, ...row };
    });
    const next = { ...previous, name: patch.name, baseUrl: patch.baseUrl, api: patch.api, models };
    this.commit({ ...read.raw, providers: { ...read.providers, [providerId]: next } }, true);
  }

  private commit(root: Record<string, unknown>, backup: boolean): void {
    mkdirSync(this.agentDir, { recursive: true, mode: 0o700 });
    if (backup) {
      copyFileSync(this.file, this.backup);
      // `copyFileSync` does not carry the source mode, so the backup would be
      // created with the umask defaults. It holds no secret (only `$ENV`
      // references), but it is still Pi configuration and stays private.
      try { chmodSync(this.backup, 0o600); } catch { /* a read-only parent keeps the copy as-is */ }
    }
    const temporary = join(dirname(this.file), `.${FILE}.${randomUUID()}.tmp`);
    try {
      const descriptor = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(descriptor, `${JSON.stringify(root, null, 2)}\n`);
        fsyncSync(descriptor);
      } finally { closeSync(descriptor); }
      renameSync(temporary, this.file);
    } finally { rmSync(temporary, { force: true }); }
  }
}

/** The `models.json` path for a resolved agent directory (for UI disclosure). */
export function modelsJsonPath(agentDir: string): string {
  return join(agentDir, FILE);
}
