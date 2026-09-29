/**
 * Machine-private Provider metadata for [PiDock 02m] #46.
 *
 * What lives here: profile metadata (name, endpoint, model parameters) and the
 * *reference* to the environment variable that holds the credential. What never
 * lives here: the credential value, any literal secret, and any user text.
 *
 * The file is metadata only. Main owns it because main owns the trusted
 * Provider choice; the value is resolved from the reference at the moment a
 * selection is installed and is handed to the isolated SDK context, never back
 * to a renderer.
 *
 * `generation` invalidates continuity: it is bumped whenever a change to the
 * endpoint, model parameters, or credential reference would make an existing
 * SDK session's pinned binding identity mean something different. A task whose
 * session was bound to an older generation keeps its readable history and is
 * refused new sends until the user re-selects explicitly.
 */

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateExplicitTextProvider, type ExplicitTextProvider } from "../host/explicit-text-provider.js";

export interface ProviderProfile {
  /** The stored id is also the profile identity the SDK binding digest pins. */
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
  authRef: string;
  generation: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderSelection {
  taskId: string;
  profileId: string;
  generation: number;
  at: string;
}

interface Document {
  version: 1;
  profiles: ProviderProfile[];
  selections: ProviderSelection[];
}

export interface ProviderProfileInput {
  id?: string;
  name: string;
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
  authRef: string;
}

const FILE = "provider-profiles.json";
const MAX_BYTES = 256 * 1024;
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

/** The defining fields whose change must invalidate an existing SDK binding. */
const DEFINING = ["baseUrl", "modelId", "contextWindow", "maxTokens", "authRef"] as const;

function profileOf(value: unknown): ProviderProfile {
  if (!record(value)) throw new Error("invalid provider profile");
  keys(value, ["id", "name", "baseUrl", "modelId", "contextWindow", "maxTokens", "authRef", "generation", "createdAt", "updatedAt"]);
  const id = value["id"];
  if (typeof id !== "string" || !ID.test(id)) throw new Error("invalid provider profile id");
  const config = validateExplicitTextProvider({
    profileId: id,
    baseUrl: value["baseUrl"],
    modelId: value["modelId"],
    contextWindow: value["contextWindow"],
    maxTokens: value["maxTokens"],
    authRef: value["authRef"],
    generation: value["generation"],
  });
  return {
    id,
    name: text(value["name"], "provider name", 128),
    baseUrl: config.baseUrl,
    modelId: config.modelId,
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    authRef: config.authRef,
    generation: config.generation,
    createdAt: text(value["createdAt"], "createdAt", 64),
    updatedAt: text(value["updatedAt"], "updatedAt", 64),
  };
}

function selectionOf(value: unknown): ProviderSelection {
  if (!record(value)) throw new Error("invalid provider selection");
  keys(value, ["taskId", "profileId", "generation", "at"]);
  const taskId = text(value["taskId"], "selection task id", 128);
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(taskId)) throw new Error("invalid selection task id");
  const profileId = value["profileId"];
  if (typeof profileId !== "string" || !ID.test(profileId)) throw new Error("invalid selection profile id");
  const generation = value["generation"];
  if (!Number.isSafeInteger(generation) || (generation as number) < 1) throw new Error("invalid selection generation");
  return { taskId, profileId, generation: generation as number, at: text(value["at"], "selection time", 64) };
}

function emptyDocument(): Document {
  return { version: 1, profiles: [], selections: [] };
}

export class ProviderProfileStore {
  private readonly file: string;

  constructor(private readonly directory: string, private readonly now: () => string = () => new Date().toISOString()) {
    this.file = join(directory, FILE);
  }

  private read(): Document {
    if (!existsSync(this.file)) return emptyDocument();
    if (!lstatSync(this.file).isFile() || lstatSync(this.file).size > MAX_BYTES) throw new Error("provider registry unreadable");
    const value: unknown = JSON.parse(readFileSync(this.file, "utf8"));
    if (!record(value)) throw new Error("provider registry unreadable");
    keys(value, ["version", "profiles", "selections"]);
    if (value["version"] !== 1) throw new Error("unsupported provider registry version");
    const rawProfiles = value["profiles"];
    const rawSelections = value["selections"];
    if (!Array.isArray(rawProfiles) || rawProfiles.length > 50) throw new Error("provider registry unreadable");
    if (!Array.isArray(rawSelections) || rawSelections.length > 500) throw new Error("provider registry unreadable");
    const profiles = rawProfiles.map(profileOf);
    const selections = rawSelections.map(selectionOf);
    if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) throw new Error("duplicate provider profile");
    if (new Set(selections.map((row) => row.taskId)).size !== selections.length) throw new Error("duplicate task selection");
    return { version: 1, profiles, selections };
  }

  private write(document: Document): void {
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

  /** The configuration handed to a task's isolated SDK context. */
  config(profileId: string): ExplicitTextProvider {
    const profile = this.read().profiles.find((row) => row.id === profileId);
    if (!profile) throw new Error("provider-profile-unknown");
    const { baseUrl, modelId, contextWindow, maxTokens, authRef, generation } = profile;
    return { profileId: profile.id, baseUrl, modelId, contextWindow, maxTokens, authRef, generation };
  }

  selection(taskId: string): ProviderSelection | null {
    return this.read().selections.find((row) => row.taskId === taskId) ?? null;
  }

  /**
   * Creates or updates a profile. A change to a defining field (endpoint, model
   * parameters, credential reference) bumps `generation`, so sessions bound to
   * the previous settings cannot continue as if nothing changed.
   */
  save(input: ProviderProfileInput): ProviderProfile {
    const document = this.read();
    const name = text(input.name, "provider name", 128);
    const baseUrl = text(input.baseUrl, "provider address", 2048);
    const modelId = text(input.modelId, "model id", 100);
    const authRef = text(input.authRef, "credential reference", 100);
    const id = input.id ?? `p-${randomUUID()}`;
    if (!ID.test(id)) throw new Error("invalid provider profile id");
    // Reuse the runtime validator so the stored document can never describe a
    // configuration the isolated context would refuse.
    const validated = validateExplicitTextProvider({ profileId: id, baseUrl, modelId, contextWindow: input.contextWindow, maxTokens: input.maxTokens, authRef, generation: 1 });
    const existing = document.profiles.find((row) => row.id === id);
    const changed = existing !== undefined && DEFINING.some((field) => existing[field] !== validated[field]);
    const generation = existing === undefined ? 1 : changed ? existing.generation + 1 : existing.generation;
    const profile: ProviderProfile = {
      id,
      name,
      baseUrl: validated.baseUrl,
      modelId: validated.modelId,
      contextWindow: validated.contextWindow,
      maxTokens: validated.maxTokens,
      authRef: validated.authRef,
      generation,
      createdAt: existing?.createdAt ?? this.now(),
      updatedAt: this.now(),
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

  remove(profileId: string): void {
    const document = this.read();
    document.profiles = document.profiles.filter((row) => row.id !== profileId);
    document.selections = document.selections.filter((row) => row.profileId !== profileId);
    this.write(document);
  }

  select(taskId: string, profileId: string): ProviderSelection {
    const document = this.read();
    const profile = document.profiles.find((row) => row.id === profileId);
    if (!profile) throw new Error("provider-profile-unknown");
    const selection: ProviderSelection = { taskId: text(taskId, "selection task id", 128), profileId, generation: profile.generation, at: this.now() };
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
export function resolveProviderCredential(profile: Pick<ExplicitTextProvider, "authRef">, env: Record<string, string | undefined> = process.env): string {
  const value = env[profile.authRef];
  if (typeof value !== "string" || value.length === 0) throw new Error("provider-not-configured");
  if (value.length > 4096 || value.includes("\0")) throw new Error("provider-not-configured");
  return value;
}
