/**
 * Machine-private Provider metadata for [PiDock 02m] #46 and [PiDock T03] #138.
 *
 * What lives here: the UI-facing half of a Provider profile (name, notes,
 * protocol, base URL, declared model rows, the credential *reference*, the
 * active model and the fingerprint of the entry PiDock last wrote to Pi's
 * native `models.json`). What never lives here: a credential value, any literal
 * secret, and any user prompt text.
 *
 * The native file (`<agent-dir>/models.json`) is the management object; this
 * document is the part Pi has no place for: display order, the active model,
 * which credential reference is bound, and what PiDock itself last wrote so an
 * external edit can be named instead of silently overwritten.
 *
 * `generation` invalidates continuity: it is bumped whenever a change to the
 * endpoint, protocol, the declared model rows, the credential reference, or the
 * active model would make an existing SDK session's pinned binding identity
 * mean something different. A task whose session was bound to an older
 * generation keeps its readable history and is refused new sends until the user
 * re-selects explicitly.
 */

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  EXPLICIT_KEYS,
  validateExplicitTextProvider,
  type ExplicitProtocol,
  type ExplicitProviderModel,
  type ExplicitTextProvider,
} from "../host/explicit-text-provider.js";
import { REASONING_TIERS, type ReasoningTier } from "./provider-protocol.js";

export type ProviderModelRow = ExplicitProviderModel;
export type ProviderProtocol = ExplicitProtocol;

/** Where the credential for a profile comes from. A value is never stored here. */
export type ProviderCredentialRef =
  /** The value lives in the named environment variable (compatibility path). */
  | { kind: "env"; ref: string }
  /** The value lives in the encrypted store, keyed by the profile id. */
  | { kind: "store"; revision: number };

export interface ProviderNativeRef {
  /** `pidock-<profileId>`; the only key PiDock ever writes. */
  providerId: string;
  /** sha256 of the entry PiDock last wrote, or `null` when nothing was written yet. */
  fingerprint: string | null;
  writtenAt: string | null;
}

export interface ProviderProfile {
  id: string;
  name: string;
  notes: string | null;
  protocol: ProviderProtocol;
  baseUrl: string;
  credentials: ProviderCredentialRef;
  models: ProviderModelRow[];
  /** The model a new selection defaults to; it must be one of `models`. */
  modelId: string;
  generation: number;
  createdAt: string;
  updatedAt: string;
  native: ProviderNativeRef;
}

export interface ProviderSelection {
  taskId: string;
  profileId: string;
  modelId: string;
  /** Reasoning level chosen for that model, already filtered to its declared capability. */
  thinkingLevel: ReasoningTier;
  generation: number;
  at: string;
  /**
   * Disclosure recorded with every selection. For an env-backed credential the
   * binding digest pins the reference *name*, so a value rotated behind that
   * name is not detected. For a stored credential the ciphertext revision is
   * pinned, so a replaced key bumps the generation instead.
   */
  note?: string;
}

/** The exact limitation statement every env-backed selection must carry (#46). */
export const SELECTION_VALUE_ROTATION_LIMITATION =
  "same-reference credential value rotation is not detected; it changes neither the selected endpoint nor the configuration generation";

/** The disclosure for a stored credential: replacing the key is observed. */
export const SELECTION_STORED_CREDENTIAL_NOTE =
  "the stored credential revision is pinned; replacing the key bumps the configuration generation and invalidates this session binding";

const NOTES = [SELECTION_VALUE_ROTATION_LIMITATION, SELECTION_STORED_CREDENTIAL_NOTE] as const;

interface DocumentV2 {
  version: 2;
  profiles: ProviderProfile[];
  selections: ProviderSelection[];
}

interface DocumentV1 {
  version: 1;
  profiles: Record<string, unknown>[];
  selections: Record<string, unknown>[];
}

export interface ProviderProfileInput {
  id?: string;
  name: string;
  notes?: string | null;
  protocol: ProviderProtocol;
  baseUrl: string;
  credentials: ProviderCredentialRef;
  models: ProviderModelRow[];
  modelId: string;
  /** Written by the native-config layer after the file was updated. */
  native?: ProviderNativeRef;
}

const FILE = "provider-profiles.json";
const MAX_BYTES = 512 * 1024;
const ID = /^p-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new Error("invalid provider document fields");
  }
}

function text(value: unknown, label: string, maxLength = 256): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > maxLength || value.includes("\0")) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

/** Deterministic JSON (sorted keys) for change detection and fingerprints. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

/** The defining fields whose change must invalidate an existing SDK binding. */
const DEFINING = ["baseUrl", "modelId", "protocol", "models", "credentials"] as const;

function credentialsOf(value: unknown): ProviderCredentialRef {
  if (!record(value)) throw new Error("invalid provider credentials");
  keys(value, [], ["kind", "ref", "revision"]);
  if (value["kind"] === "env") {
    keys(value, ["kind", "ref"]);
    const ref = text(value["ref"], "credential reference", 100);
    if (!/^PIDOCK_PROVIDER_[A-Z0-9_]{1,64}$/.test(ref)) throw new Error("invalid credential reference");
    return { kind: "env", ref };
  }
  if (value["kind"] === "store") {
    keys(value, ["kind", "revision"]);
    const revision = value["revision"];
    if (!Number.isSafeInteger(revision) || (revision as number) < 1) throw new Error("invalid credential revision");
    return { kind: "store", revision: revision as number };
  }
  throw new Error("invalid provider credentials");
}

function nativeOf(value: unknown, profileId: string): ProviderNativeRef {
  if (!record(value)) throw new Error("invalid provider native reference");
  keys(value, ["fingerprint", "providerId", "writtenAt"]);
  const providerId = value["providerId"];
  if (providerId !== `pidock-${profileId}`) throw new Error("invalid provider native reference");
  const fingerprint = value["fingerprint"];
  if (fingerprint !== null && (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint))) throw new Error("invalid provider native fingerprint");
  const writtenAt = value["writtenAt"];
  if (writtenAt !== null && (typeof writtenAt !== "string" || writtenAt.length === 0 || writtenAt.length > 64)) throw new Error("invalid provider native timestamp");
  return { providerId, fingerprint: fingerprint as string | null, writtenAt: writtenAt as string | null };
}

/**
 * Validate the whole profile through the same runtime validator the isolated
 * context uses, so a stored document can never describe a configuration the SDK
 * path would refuse. The protocol is explicit; it is never inferred.
 */
function profileOf(value: unknown): ProviderProfile {
  if (!record(value)) throw new Error("invalid provider profile");
  keys(value, ["id", "name", "baseUrl", "credentials", "models", "modelId", "native", "notes", "protocol", "generation", "createdAt", "updatedAt"]);
  const id = value["id"];
  if (typeof id !== "string" || !ID.test(id)) throw new Error("invalid provider profile id");
  return validatedConfiguration(id, value, credentialsOf(value["credentials"]));
}

/**
 * The validator needs the selected row's window/output, and the store keeps
 * them only inside the model rows. Deriving them here keeps one source of
 * truth: a stored profile cannot claim a window the selected row does not
 * declare.
 */
function validatedConfiguration(id: string, value: Record<string, unknown>, credentials: ProviderCredentialRef): ProviderProfile {
  const models = value["models"];
  const modelId = value["modelId"];
  const selected = Array.isArray(models) ? models.find((row) => record(row) && row["id"] === modelId) : undefined;
  if (!record(selected)) throw new Error("invalid provider profile");
  const config = validateExplicitTextProvider({
    profileId: id,
    protocol: value["protocol"],
    baseUrl: value["baseUrl"],
    modelId,
    models,
    contextWindow: selected["contextWindow"],
    maxTokens: selected["maxTokens"],
    credentialSource: credentials.kind,
    authRef: credentials.kind === "env" ? credentials.ref : id,
    generation: value["generation"],
  });
  const notes = value["notes"];
  if (notes !== null && (typeof notes !== "string" || notes.length > 500 || notes.includes("\0"))) throw new Error("invalid provider notes");
  return {
    id,
    name: text(value["name"], "provider name", 128),
    notes: notes as string | null,
    protocol: config.protocol,
    baseUrl: config.baseUrl,
    credentials,
    models: config.models,
    modelId: config.modelId,
    generation: config.generation,
    createdAt: text(value["createdAt"], "createdAt", 64),
    updatedAt: text(value["updatedAt"], "updatedAt", 64),
    native: nativeOf(value["native"], id),
  };
}

function thinkingLevel(value: unknown): ReasoningTier {
  if (typeof value !== "string" || !(REASONING_TIERS as readonly string[]).includes(value)) throw new Error("invalid selection thinking level");
  return value as ReasoningTier;
}

function selectionOf(value: unknown): ProviderSelection {
  if (!record(value)) throw new Error("invalid provider selection");
  keys(value, ["taskId", "profileId", "modelId", "thinkingLevel", "generation", "at"], ["note"]);
  const taskId = text(value["taskId"], "selection task id", 128);
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(taskId)) throw new Error("invalid selection task id");
  const profileId = value["profileId"];
  if (typeof profileId !== "string" || !ID.test(profileId)) throw new Error("invalid selection profile id");
  const modelId = text(value["modelId"], "selection model id", 100);
  const generation = value["generation"];
  if (!Number.isSafeInteger(generation) || (generation as number) < 1) throw new Error("invalid selection generation");
  const note = value["note"];
  if (note !== undefined && !(NOTES as readonly string[]).includes(note as string)) throw new Error("invalid selection note");
  return {
    taskId, profileId, modelId, thinkingLevel: thinkingLevel(value["thinkingLevel"]),
    generation: generation as number, at: text(value["at"], "selection time", 64),
    ...(note === undefined ? {} : { note: note as string }),
  };
}

/** v1 documents predate protocols and multi-model rows; the only truthful value they can hold is the one they were built with. */
function migrateV1(value: DocumentV1): DocumentV2 {
  const profiles: ProviderProfile[] = value.profiles.map((row) => {
    keys(row, ["id", "name", "baseUrl", "modelId", "contextWindow", "maxTokens", "authRef", "generation", "createdAt", "updatedAt"]);
    const id = row["id"];
    if (typeof id !== "string" || !ID.test(id)) throw new Error("invalid provider profile id");
    const modelId = text(row["modelId"], "model id", 100);
    const config = validateExplicitTextProvider({
      profileId: id,
      // The v1 runtime registered every profile as `openai-completions`; the
      // migration records that fact instead of guessing from a URL.
      protocol: "openai-completions",
      baseUrl: row["baseUrl"],
      modelId,
      models: [{
        id: modelId, name: modelId, contextWindow: row["contextWindow"], maxTokens: row["maxTokens"],
        reasoning: false,
      }],
      contextWindow: row["contextWindow"],
      maxTokens: row["maxTokens"],
      credentialSource: "env",
      authRef: row["authRef"],
      generation: row["generation"],
    });
    const profile: ProviderProfile = {
      id, name: text(row["name"], "provider name", 128), notes: null,
      protocol: config.protocol, baseUrl: config.baseUrl,
      credentials: { kind: "env", ref: config.authRef },
      models: config.models, modelId,
      generation: config.generation,
      createdAt: text(row["createdAt"], "createdAt", 64), updatedAt: text(row["updatedAt"], "updatedAt", 64),
      native: { providerId: `pidock-${id}`, fingerprint: null, writtenAt: null },
    };
    return profile;
  });
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const selections: ProviderSelection[] = value.selections.map((row) => {
    // A selection whose profile disappeared cannot say which model it meant.
    const legacy = row["profileId"];
    const profile = typeof legacy === "string" ? byId.get(legacy) : undefined;
    if (!profile) return null;
    const parsed = selectionOf({
      ...row,
      modelId: profile.modelId,
      thinkingLevel: "off",
    });
    return parsed;
  }).filter((row): row is ProviderSelection => row !== null);
  return { version: 2, profiles, selections };
}

function emptyDocument(): DocumentV2 {
  return { version: 2, profiles: [], selections: [] };
}

export class ProviderProfileStore {
  private readonly file: string;

  constructor(private readonly directory: string, private readonly now: () => string = () => new Date().toISOString()) {
    this.file = join(directory, FILE);
  }

  private read(): DocumentV2 {
    if (!existsSync(this.file)) return emptyDocument();
    if (!lstatSync(this.file).isFile() || lstatSync(this.file).size > MAX_BYTES) throw new Error("provider registry unreadable");
    const value: unknown = JSON.parse(readFileSync(this.file, "utf8"));
    if (!record(value)) throw new Error("provider registry unreadable");
    const rawProfiles = value["profiles"];
    const rawSelections = value["selections"];
    if (!Array.isArray(rawProfiles) || rawProfiles.length > 50) throw new Error("provider registry unreadable");
    if (!Array.isArray(rawSelections) || rawSelections.length > 500) throw new Error("provider registry unreadable");
    if (value["version"] === 1) {
      keys(value, ["version", "profiles", "selections"]);
      return migrateV1({ version: 1, profiles: rawProfiles as Record<string, unknown>[], selections: rawSelections as Record<string, unknown>[] });
    }
    keys(value, ["version", "profiles", "selections"]);
    if (value["version"] !== 2) throw new Error("unsupported provider registry version");
    const profiles = (rawProfiles as unknown[]).map(profileOf);
    const selections = (rawSelections as unknown[]).map(selectionOf);
    if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) throw new Error("duplicate provider profile");
    if (new Set(selections.map((row) => row.taskId)).size !== selections.length) throw new Error("duplicate task selection");
    return { version: 2, profiles, selections };
  }

  private write(document: DocumentV2): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(dirname(this.file), `.${FILE}.${randomUUID()}.tmp`);
    try {
      const descriptor = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify(document));
        fsyncSync(descriptor);
      } finally { closeSync(descriptor); }
      renameSync(temporary, this.file);
    } finally { rmSync(temporary, { force: true }); }
  }

  list(): { profiles: ProviderProfile[]; selections: ProviderSelection[] } {
    const document = this.read();
    return { profiles: document.profiles, selections: document.selections };
  }

  profile(profileId: string): ProviderProfile {
    const profile = this.read().profiles.find((row) => row.id === profileId);
    if (!profile) throw new Error("provider-profile-unknown");
    return profile;
  }

  /** The configuration handed to a task's isolated SDK context. */
  config(profileId: string, modelId?: string): ExplicitTextProvider {
    const profile = this.profile(profileId);
    const selectedId = modelId ?? profile.modelId;
    const selected = profile.models.find((row) => row.id === selectedId);
    if (!selected) throw new Error("provider-model-unknown");
    const config: ExplicitTextProvider = {
      profileId: profile.id,
      protocol: profile.protocol,
      baseUrl: profile.baseUrl,
      modelId: selected.id,
      models: profile.models,
      contextWindow: selected.contextWindow,
      maxTokens: selected.maxTokens,
      credentialSource: profile.credentials.kind,
      authRef: profile.credentials.kind === "env" ? profile.credentials.ref : profile.id,
      generation: profile.generation,
    };
    // Re-validate so a hand-edited document can never reach the SDK path.
    validateExplicitTextProvider(config);
    return config;
  }

  selection(taskId: string): ProviderSelection | null {
    return this.read().selections.find((row) => row.taskId === taskId) ?? null;
  }

  /**
   * Creates or updates a profile. A change to a defining field (endpoint,
   * protocol, model rows, credential reference, active model) bumps
   * `generation`, so sessions bound to the previous settings cannot continue as
   * if nothing changed.
   */
  save(input: ProviderProfileInput): ProviderProfile {
    const document = this.read();
    const id = input.id ?? `p-${randomUUID()}`;
    if (!ID.test(id)) throw new Error("invalid provider profile id");
    const credentials = credentialsOf(input.credentials);
    const selected = input.models.find((row) => row.id === input.modelId);
    if (!selected) throw new Error("provider-model-unknown");
    const validated = validateExplicitTextProvider({
      profileId: id,
      protocol: input.protocol,
      baseUrl: input.baseUrl,
      modelId: input.modelId,
      models: input.models,
      contextWindow: selected.contextWindow,
      maxTokens: selected.maxTokens,
      credentialSource: credentials.kind,
      authRef: credentials.kind === "env" ? credentials.ref : id,
      generation: 1,
    });
    const notes = input.notes ?? null;
    if (notes !== null && (typeof notes !== "string" || notes.length > 500 || notes.includes("\0"))) throw new Error("invalid provider notes");
    const existing = document.profiles.find((row) => row.id === id);
    const comparable: Record<(typeof DEFINING)[number], unknown> = {
      baseUrl: validated.baseUrl, modelId: validated.modelId, protocol: validated.protocol,
      models: validated.models, credentials,
    };
    const changed = existing !== undefined && DEFINING.some((field) => canonical(existing[field]) !== canonical(comparable[field]));
    const generation = existing === undefined ? 1 : changed ? existing.generation + 1 : existing.generation;
    const profile: ProviderProfile = {
      id,
      name: text(input.name, "provider name", 128),
      notes,
      protocol: validated.protocol,
      baseUrl: validated.baseUrl,
      credentials,
      models: validated.models,
      modelId: validated.modelId,
      generation,
      createdAt: existing?.createdAt ?? this.now(),
      updatedAt: this.now(),
      native: input.native ?? existing?.native ?? { providerId: `pidock-${id}`, fingerprint: null, writtenAt: null },
    };
    document.profiles = existing === undefined
      ? [...document.profiles, profile]
      : document.profiles.map((row) => (row.id === id ? profile : row));
    // A bumped generation invalidates the installed selection: the user must
    // re-select so the change is an explicit act, never a silent swap.
    if (changed) document.selections = document.selections.filter((row) => row.profileId !== id);
    this.write(document);
    return profile;
  }

  /** Records what PiDock last wrote to the native file (native layer owns the write). */
  recordNative(profileId: string, native: ProviderNativeRef): ProviderProfile {
    const document = this.read();
    const existing = document.profiles.find((row) => row.id === profileId);
    if (!existing) throw new Error("provider-profile-unknown");
    const updated: ProviderProfile = { ...existing, native: nativeOf(native, profileId), updatedAt: this.now() };
    document.profiles = document.profiles.map((row) => (row.id === profileId ? updated : row));
    this.write(document);
    return updated;
  }

  remove(profileId: string): void {
    const document = this.read();
    document.profiles = document.profiles.filter((row) => row.id !== profileId);
    document.selections = document.selections.filter((row) => row.profileId !== profileId);
    this.write(document);
  }

  select(taskId: string, profileId: string, modelId?: string, level?: ReasoningTier): ProviderSelection {
    const document = this.read();
    const profile = document.profiles.find((row) => row.id === profileId);
    if (!profile) throw new Error("provider-profile-unknown");
    const selectedId = modelId ?? profile.modelId;
    const model = profile.models.find((row) => row.id === selectedId);
    if (!model) throw new Error("provider-model-unknown");
    const fallbackLevel = level ?? (model.reasoning ? "high" : "off");
    const selection: ProviderSelection = {
      taskId: text(taskId, "selection task id", 128),
      profileId,
      modelId: selectedId,
      thinkingLevel: thinkingLevel(fallbackLevel),
      generation: profile.generation,
      at: this.now(),
      note: profile.credentials.kind === "env" ? SELECTION_VALUE_ROTATION_LIMITATION : SELECTION_STORED_CREDENTIAL_NOTE,
    };
    document.selections = [...document.selections.filter((row) => row.taskId !== selection.taskId), selection];
    this.write(document);
    return selection;
  }

  deselect(taskId: string): void {
    const document = this.read();
    document.selections = document.selections.filter((row) => row.taskId !== taskId);
    this.write(document);
  }
}

/**
 * Resolves the credential for a profile from the referenced environment
 * variable. The value is returned to the trusted caller only; a missing,
 * empty, or over-long value fails closed instead of falling back to any
 * ambient provider credential.
 */
export function resolveProviderCredential(profile: { authRef: string }, env: Record<string, string | undefined> = process.env): string {
  const value = env[profile.authRef];
  if (typeof value !== "string" || value.length === 0) throw new Error("provider-not-configured");
  if (value.length > 4096 || value.includes("\0")) throw new Error("provider-not-configured");
  return value;
}

/** True when a level is one of the canonical tiers. */
export function isReasoningTierValue(value: unknown): value is ReasoningTier {
  return typeof value === "string" && (REASONING_TIERS as readonly string[]).includes(value);
}

/**
 * The stored rows are the *declared* capability. This is the only place the
 * store itself inspects them, and it never upgrades a declaration to a probe.
 */
export const PROVIDER_MODEL_KEYS = EXPLICIT_KEYS;
