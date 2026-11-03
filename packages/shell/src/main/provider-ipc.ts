/**
 * Main-side Provider operations for [PiDock 02m] #46 and [PiDock T03] #138.
 *
 * Trust rules enforced here:
 *
 * - The renderer may name a task, a profile, profile metadata, and — once per
 *   save/discover/probe call — an API key. It can never name a credential
 *   *source* other than the profile's own reference, an environment variable,
 *   an on-disk path, or a Host op.
 * - A key the renderer sends once is encrypted into PiDock's store (or used for
 *   that one discovery/probe attempt). It is never echoed back, never persisted
 *   in plaintext, and never put in a log line or an error message here.
 * - The credential value is resolved in main and handed only to the task Host on
 *   the internal `task/sdkProvider` op. It never appears in a renderer payload.
 * - Pi's native `models.json` is the management object; PiDock writes only the
 *   `pidock-<profileId>` entry and records the fingerprint it wrote, so an
 *   external edit is reported by name instead of being silently overwritten.
 * - A selection is persisted only after the isolated context accepted the
 *   configuration, so a restart can never resume a selection that cannot work.
 * - Failures are reported as bounded states/codes, never as raw SDK or HTTP text.
 */

import { randomUUID } from "node:crypto";
import type { ProviderProfile, ProviderProfileInput, ProviderCredentialRef } from "./provider-profile-store.js";
import { validateExplicitTextProvider, type ExplicitTextProvider } from "../host/explicit-text-provider.js";
import { resolveProviderCredential, type ProviderProfileStore } from "./provider-profile-store.js";
import { availableReasoningLevels, resolveThinkingLevel } from "./provider-capability.js";
import type { ProviderSecretStore } from "./provider-secret-store.js";
import {
  NativeModelsFile,
  managedProviderId,
  type NativeManagedState,
  type NativeModelRow,
  type NativeProviderEntry,
} from "./native-models-config.js";
import { syncModelCandidates, type DiscoveryOutcome, type ModelListTransport } from "./provider-discovery.js";
import { createHttpModelListTransport } from "./provider-model-list.js";
import { probeConnection, type ProbeOutcome } from "./provider-probe.js";
import { isProviderProtocol, protocolDescriptor, type ReasoningTier } from "./provider-protocol.js";
import { TrustDomainViolation } from "./trust-domain.js";

export type ProviderInstallState =
  /** The isolated context accepted this configuration and is live. */
  | "configured"
  /** No selection, or one that was never installed in this process yet. */
  | "not-configured"
  /** A selection is saved but could not be installed right now (a turn is open). */
  | "pending"
  /** The referenced credential has no value (missing env var or unreadable store entry). */
  | "credential-missing"
  /**
   * The SDK session recorded for this task was bound to a different Provider
   * identity (endpoint, protocol, model rows, credential reference, selected
   * model, or generation), so it refuses to continue. Re-selecting the same
   * profile cannot fix this: the bound identity is what changed.
   */
  | "binding-stale"
  /** Anything else the isolated context refused, with no raw text forwarded. */
  | "install-failed";

/** What the installer needs to open the isolated context for one task selection. */
export interface ProviderInstall {
  profileId: string;
  credential: string;
  modelId: string;
  thinkingLevel: ReasoningTier;
}

/**
 * Installs (or clears) a task's explicit Provider selection in its isolated
 * context. `sender` is the trusted shell webContents main attests to the task
 * Host; it comes from the IPC sender, never from a payload.
 */
export type ProviderInstaller = (taskId: string, provider: ProviderInstall | null, sender: number) => Promise<void>;

export interface ProviderModelView {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  /** Only the levels the declared capability supports (SDK-derived). */
  reasoningLevels: ReasoningTier[];
  /** Declared price, or `null` when unknown — never a fabricated zero. */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
}

export interface ProviderView {
  id: string;
  name: string;
  notes: string | null;
  protocol: string;
  baseUrl: string;
  models: ProviderModelView[];
  /** The model a new selection defaults to. */
  modelId: string;
  /** Active model's declared window/output (kept for the composer readout). */
  contextWindow: number;
  maxTokens: number;
  authRef: string;
  credentialSource: "env" | "store";
  credentialAvailable: boolean;
  generation: number;
  native: { providerId: string; state: NativeManagedState };
}

export interface ProviderStatus {
  state: ProviderInstallState;
  profileId: string | null;
  generation: number | null;
  modelId: string | null;
  thinkingLevel: ReasoningTier | null;
  profiles: ProviderView[];
  /** Where Pi actually reads Providers from; `null` when no native file is wired. */
  nativePath: string | null;
  /** False when the platform cannot encrypt, so the UI must not offer "save key". */
  secretsAvailable: boolean;
}

export interface ProviderWiringOptions {
  secrets?: ProviderSecretStore;
  native?: NativeModelsFile;
  /** Injected for tests; production uses `globalThis.fetch`. */
  fetchImpl?: typeof globalThis.fetch;
  now?: () => string;
}

/**
 * Maps a Host-side install refusal to a bounded state. Raw SDK/HTTP/runtime text
 * never reaches the renderer; only these codes do.
 */
function classifyInstallFailure(error: unknown): ProviderInstallState {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("sdk-binding-invalid")) return "binding-stale";
  if (message.includes("sdk-turn-journal-uncommitted") || message.includes("sdk-turn-active")) return "pending";
  return "install-failed";
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exact-key set check: required keys must all be present and nothing else may be. */
function shape(value: unknown, op: string, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!object(value) || value["op"] !== op) throw new TrustDomainViolation("invalid-payload", `invalid provider ${op} payload`);
  const allowed = ["op", ...required, ...optional];
  if (Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    throw new TrustDomainViolation("invalid-payload", `invalid provider ${op} payload`);
  }
  return value;
}

function taskId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw new TrustDomainViolation("invalid-payload", "invalid task ID");
  }
  return value;
}

function profileId(value: unknown): string {
  if (typeof value !== "string" || !/^p-[0-9a-f-]{36}$/.test(value)) {
    throw new TrustDomainViolation("invalid-payload", "invalid provider profile ID");
  }
  return value;
}

/** One API key sent over the exact-key RPC: bounded, no control characters, never stored here. */
function apiKeyOf(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 4096 || value.includes("\0") || value.trim() !== value) {
    throw new TrustDomainViolation("invalid-payload", "invalid provider API key");
  }
  return value;
}

function endpointOf(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) throw new TrustDomainViolation("invalid-payload", "invalid provider address");
  return value;
}

function modelInput(value: unknown): ProviderProfileInput["models"][number] {
  if (!object(value)) throw new TrustDomainViolation("invalid-payload", "invalid provider model");
  const allowed = ["id", "name", "contextWindow", "maxTokens", "reasoning", "thinkingLevelMap", "cost", "reasoningLevels"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new TrustDomainViolation("invalid-payload", "invalid provider model fields");
  const id = value["id"];
  const name = value["name"];
  if (typeof id !== "string" || typeof name !== "string") throw new TrustDomainViolation("invalid-payload", "invalid provider model");
  const contextWindow = value["contextWindow"];
  const maxTokens = value["maxTokens"];
  const reasoning = value["reasoning"];
  if (!Number.isSafeInteger(contextWindow) || (contextWindow as number) < 1) throw new TrustDomainViolation("invalid-payload", "invalid provider model window");
  if (!Number.isSafeInteger(maxTokens) || (maxTokens as number) < 1) throw new TrustDomainViolation("invalid-payload", "invalid provider model output");
  if (typeof reasoning !== "boolean") throw new TrustDomainViolation("invalid-payload", "invalid provider model reasoning");
  const cost = value["cost"];
  const reasoningLevels = value["reasoningLevels"];
  let thinkingLevelMap: Record<string, string | null> | undefined;
  if (reasoningLevels !== undefined) {
    if (!Array.isArray(reasoningLevels) || reasoningLevels.length === 0) throw new TrustDomainViolation("invalid-payload", "invalid provider reasoning levels");
    // The UI sends the declared *subset*; the SDK map is derived here so both
    // sides agree (declared levels map to themselves, the rest to null).
    thinkingLevelMap = {};
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      thinkingLevelMap[level] = (reasoningLevels as unknown[]).includes(level) ? level : null;
    }
    if (!reasoning) throw new TrustDomainViolation("invalid-payload", "invalid provider reasoning levels");
  }
  return {
    id, name, contextWindow: contextWindow as number, maxTokens: maxTokens as number, reasoning,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...(cost === undefined || cost === null ? {} : { cost: cost as { input: number; output: number; cacheRead: number; cacheWrite: number } }),
  };
}

/** One profile input from the renderer (exact shape; the key travels separately). */
function profileInput(value: unknown): { input: ProviderProfileInput; credential: ProviderCredentialRef } {
  if (!object(value)) throw new TrustDomainViolation("invalid-payload", "invalid provider profile");
  const allowed = ["id", "name", "notes", "protocol", "baseUrl", "credential", "models", "modelId"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new TrustDomainViolation("invalid-payload", "invalid provider profile fields");
  const name = value["name"];
  const protocol = value["protocol"];
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 128) throw new TrustDomainViolation("invalid-payload", "invalid provider name");
  if (typeof protocol !== "string" || !isProviderProtocol(protocol)) throw new TrustDomainViolation("invalid-payload", "invalid provider protocol");
  const notes = value["notes"];
  if (notes !== undefined && notes !== null && (typeof notes !== "string" || notes.length > 500)) throw new TrustDomainViolation("invalid-payload", "invalid provider notes");
  const models = value["models"];
  if (!Array.isArray(models) || models.length === 0 || models.length > 20) throw new TrustDomainViolation("invalid-payload", "invalid provider models");
  const modelId = value["modelId"];
  if (typeof modelId !== "string") throw new TrustDomainViolation("invalid-payload", "invalid provider model");
  const credential = value["credential"];
  if (!object(credential) || typeof credential["kind"] !== "string") throw new TrustDomainViolation("invalid-payload", "invalid provider credential");
  let ref: ProviderCredentialRef;
  if (credential["kind"] === "env") {
    if (Object.keys(credential).sort().join(",") !== "kind,ref" || typeof credential["ref"] !== "string") {
      throw new TrustDomainViolation("invalid-payload", "invalid provider credential");
    }
    ref = { kind: "env", ref: credential["ref"] };
  } else if (credential["kind"] === "store") {
    if (Object.keys(credential).sort().join(",") !== "kind") throw new TrustDomainViolation("invalid-payload", "invalid provider credential");
    ref = { kind: "store", revision: 1 };
  } else {
    throw new TrustDomainViolation("invalid-payload", "invalid provider credential");
  }
  return {
    credential: ref,
    input: {
      ...(value["id"] === undefined ? {} : { id: profileId(value["id"]) }),
      name,
      notes: typeof notes === "string" ? notes : null,
      protocol: protocol as ProviderProfileInput["protocol"],
      baseUrl: endpointOf(value["baseUrl"]),
      credentials: ref,
      models: models.map(modelInput),
      modelId,
    },
  };
}

/**
 * Owns the task↔profile↔context wiring and the Provider management surface
 * (native config, encrypted credential, discovery, connectivity).
 */
export class ProviderWiring {
  private readonly installed = new Map<string, string>();
  private readonly failed = new Map<string, { key: string; state: ProviderInstallState }>();

  constructor(
    private readonly store: ProviderProfileStore,
    private readonly install: ProviderInstaller,
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly options: ProviderWiringOptions = {},
  ) {}

  /** Where Pi reads managed Provider entries from. */
  get nativePath(): string | null {
    return this.options.native?.path ?? null;
  }

  private secretAvailable(profile: ProviderProfile): boolean {
    if (profile.credentials.kind === "env") {
      return typeof this.env[profile.credentials.ref] === "string" && (this.env[profile.credentials.ref] as string).length > 0;
    }
    try { this.options.secrets?.resolve(profile.id); return this.options.secrets !== undefined; }
    catch { return false; }
  }

  /** The credential value for main's own use; never returned to a renderer. */
  private credential(profile: ProviderProfile): string {
    if (profile.credentials.kind === "env") {
      const credential = resolveProviderCredential({ authRef: profile.credentials.ref }, this.env);
      if (credential.length < 8) throw new Error("provider-not-configured");
      return credential;
    }
    if (!this.options.secrets) throw new Error("provider-not-configured");
    const credential = this.options.secrets.resolve(profile.id);
    if (credential.length < 8) throw new Error("provider-not-configured");
    return credential;
  }

  private view(profile: ProviderProfile): ProviderView {
    const active = profile.models.find((row) => row.id === profile.modelId) ?? profile.models[0]!;
    const nativeState = this.options.native
      ? this.options.native.state(profile.id, profile.native.fingerprint)
      : "never-written";
    return {
      id: profile.id,
      name: profile.name,
      notes: profile.notes,
      protocol: profile.protocol,
      baseUrl: profile.baseUrl,
      models: profile.models.map((row) => ({
        id: row.id,
        name: row.name,
        contextWindow: row.contextWindow,
        maxTokens: row.maxTokens,
        reasoning: row.reasoning,
        reasoningLevels: availableReasoningLevels(row),
        cost: row.cost ?? null,
      })),
      modelId: profile.modelId,
      contextWindow: active.contextWindow,
      maxTokens: active.maxTokens,
      authRef: profile.credentials.kind === "env" ? profile.credentials.ref : profile.id,
      credentialSource: profile.credentials.kind,
      credentialAvailable: this.secretAvailable(profile),
      generation: profile.generation,
      native: { providerId: managedProviderId(profile.id), state: nativeState },
    };
  }

  private views(): ProviderView[] {
    return this.store.list().profiles.map((profile) => this.view(profile));
  }

  /**
   * A failure that belongs to the current selection is reported as-is, so the
   * user learns *why* a configured-looking task cannot send (missing credential
   * or a refused context) instead of seeing a silent "not configured".
   */
  private state(taskId: string): ProviderInstallState {
    const selection = this.store.selection(taskId);
    const key = selection === null ? null : this.selectionKey(selection.profileId, selection.modelId, selection.thinkingLevel, selection.generation);
    const failure = this.failed.get(taskId);
    if (failure && (key === null || failure.key === key)) return failure.state;
    if (key !== null && this.installed.get(taskId) === key) return "configured";
    return key === null ? "not-configured" : "pending";
  }

  private selectionKey(profileId: string, modelId: string, level: ReasoningTier, generation: number): string {
    return `${profileId}:${modelId}:${level}:${generation}`;
  }

  /** Revalidates the selected credential reference before reusing a context. */
  async ensure(taskId: string, sender: number): Promise<ProviderInstallState> {
    const selection = this.store.selection(taskId);
    if (!selection) {
      const installed = this.installed.get(taskId);
      try { await this.retireInstalled(taskId, sender); }
      catch (error) {
        const state = classifyInstallFailure(error);
        this.failed.set(taskId, { key: installed ?? "unselected", state });
        return state;
      }
      this.failed.delete(taskId);
      return "not-configured";
    }
    const key = this.selectionKey(selection.profileId, selection.modelId, selection.thinkingLevel, selection.generation);
    let profile: ProviderProfile;
    try { profile = this.store.profile(selection.profileId); }
    catch {
      try { await this.retireInstalled(taskId, sender); }
      catch { /* The existing turn must commit before its context can be retired. */ }
      this.failed.set(taskId, { key, state: "binding-stale" });
      return "binding-stale";
    }
    if (profile.generation !== selection.generation || !profile.models.some((row) => row.id === selection.modelId)) {
      try { await this.retireInstalled(taskId, sender); }
      catch { /* The existing turn must commit before its context can be retired. */ }
      this.failed.set(taskId, { key, state: "binding-stale" });
      return "binding-stale";
    }
    try { this.credential(profile); } catch {
      try { await this.retireInstalled(taskId, sender); }
      catch { /* An active context remains available to finish or cancel its turn. */ }
      this.failed.set(taskId, { key, state: "credential-missing" });
      return "credential-missing";
    }
    // Loss of a credential requires an explicit selection to restore sending.
    if (this.failed.get(taskId)?.key === key && this.failed.get(taskId)?.state === "credential-missing") return "credential-missing";
    if (this.installed.get(taskId) === key) return "configured";
    const state = await this.installSelection(taskId, selection.profileId, selection.modelId, selection.thinkingLevel, selection.generation, key, sender);
    if (state !== "configured") return state;
    const current = this.store.selection(taskId);
    if (current === null || this.selectionKey(current.profileId, current.modelId, current.thinkingLevel, current.generation) !== key) {
      try { await this.retireInstalled(taskId, sender); }
      catch (error) {
        const refused = classifyInstallFailure(error);
        this.failed.set(taskId, { key, state: refused });
        return refused;
      }
      return "not-configured";
    }
    return "configured";
  }

  private async retireInstalled(taskId: string, sender: number): Promise<void> {
    if (!this.installed.has(taskId)) return;
    await this.install(taskId, null, sender);
    this.installed.delete(taskId);
  }

  /** Installs and persists an explicit user selection (profile + model + level). */
  async select(taskId: string, id: string, modelId: string | undefined, level: string | undefined, sender: number): Promise<ProviderStatus> {
    const profile = this.store.profile(id);
    const selectedId = modelId ?? profile.modelId;
    const row = profile.models.find((model) => model.id === selectedId);
    if (!row) throw new TrustDomainViolation("invalid-payload", "unknown provider model");
    const resolved = resolveThinkingLevel(row, level);
    if (!resolved.ok) throw new TrustDomainViolation("invalid-payload", "invalid provider thinking level");
    const key = this.selectionKey(id, selectedId, resolved.level, profile.generation);
    const state = await this.installSelection(taskId, id, selectedId, resolved.level, profile.generation, key, sender);
    if (state !== "configured") return this.status(taskId);
    this.store.select(taskId, id, selectedId, resolved.level);
    return this.status(taskId);
  }

  /** Clears the selection; the context is dropped before the record disappears. */
  async clear(taskId: string, sender: number): Promise<ProviderStatus> {
    await this.install(taskId, null, sender);
    this.installed.delete(taskId);
    this.failed.delete(taskId);
    this.store.deselect(taskId);
    return this.status(taskId);
  }

  private async installSelection(taskId: string, id: string, modelId: string, level: ReasoningTier, generation: number, key: string, sender: number): Promise<ProviderInstallState> {
    let credential: string;
    try { credential = this.credential(this.store.profile(id)); }
    catch { this.failed.set(taskId, { key, state: "credential-missing" }); return "credential-missing"; }
    try { await this.install(taskId, { profileId: id, credential, modelId, thinkingLevel: level }, sender); }
    catch (error) {
      const state = classifyInstallFailure(error);
      // A pending refusal does not change configuration or an existing fence.
      if (state !== "pending") this.failed.set(taskId, { key, state });
      return state;
    }
    this.installed.set(taskId, key);
    // Eager SDK open is asynchronous: profile edits or credential loss while it
    // waits must not turn its eventual reply into permission for a stale send.
    let state: ProviderInstallState = "configured";
    try {
      const current = this.store.profile(id);
      if (current.generation !== generation) state = "binding-stale";
      else {
        try { this.credential(current); }
        catch { state = "credential-missing"; }
      }
    } catch { state = "install-failed"; }
    if (state !== "configured") {
      try { await this.retireInstalled(taskId, sender); }
      catch { /* Retain the context for drain; the failed state fences new starts. */ }
      this.failed.set(taskId, { key, state });
      return state;
    }
    this.failed.delete(taskId);
    return "configured";
  }

  /** Renderer-facing status: metadata and availability only, never a secret. */
  status(taskId?: string): ProviderStatus {
    const selection = taskId === undefined ? null : this.store.selection(taskId);
    return {
      state: taskId === undefined ? "not-configured" : this.state(taskId),
      profileId: selection?.profileId ?? null,
      generation: selection?.generation ?? null,
      modelId: selection?.modelId ?? null,
      thinkingLevel: selection?.thinkingLevel ?? null,
      profiles: this.views(),
      nativePath: this.nativePath,
      secretsAvailable: this.options.secrets?.available() === true,
    };
  }

  /** The exact configuration main would hand to the isolated context. */
  private configOf(profile: ProviderProfileInput & { credentials: ProviderCredentialRef; generation: number }): ExplicitTextProvider {
    const selected = profile.models.find((row) => row.id === profile.modelId) ?? profile.models[0]!;
    return {
      profileId: profile.id ?? "",
      protocol: profile.protocol,
      baseUrl: profile.baseUrl,
      modelId: profile.modelId,
      models: profile.models,
      contextWindow: selected.contextWindow,
      maxTokens: selected.maxTokens,
      credentialSource: profile.credentials.kind,
      authRef: profile.credentials.kind === "env" ? profile.credentials.ref : (profile.id ?? ""),
      generation: profile.generation,
    };
  }

  /** The `models.json` entry Pi should see for a profile (never contains a key value). */
  nativeEntry(profile: ProviderProfileInput & { credentials: ProviderCredentialRef }): NativeProviderEntry {
    return {
      name: profile.name,
      baseUrl: profile.baseUrl,
      api: profile.protocol,
      ...(profile.credentials.kind === "env" ? { apiKey: `$${profile.credentials.ref}` } : {}),
      models: profile.models.map((row): NativeModelRow => ({
        id: row.id,
        name: row.name,
        reasoning: row.reasoning,
        ...(row.thinkingLevelMap ? { thinkingLevelMap: row.thinkingLevelMap } : {}),
        contextWindow: row.contextWindow,
        maxTokens: row.maxTokens,
        ...(row.cost ? { cost: row.cost } : {}),
      })),
    };
  }

  /**
   * Saves a profile: validate → (conflict check) → native write → credential
   * write → metadata write. `reconcile` is the user's explicit "overwrite what
   * someone changed outside PiDock" act; without it an external edit is reported
   * and nothing is written.
   */
  save(input: ProviderProfileInput, apiKey: string | undefined, reconcile: boolean): { profile: ProviderView; status: ProviderStatus; conflict: NativeManagedState | null; written: boolean } {
    const native = this.options.native;
    const existing = input.id === undefined ? undefined : this.store.list().profiles.find((row) => row.id === input.id);
    // Resolve the credential reference first: a store-backed profile cannot be
    // saved without a stored revision (a new key or a kept one).
    let credentials: ProviderCredentialRef;
    if (input.credentials.kind === "env") credentials = input.credentials;
    else {
      const secrets = this.options.secrets;
      if (!secrets) throw new ProviderRefusal("secret-store-unavailable");
      if (apiKey !== undefined) credentials = { kind: "store", revision: 1 };
      else {
        const revision = existing?.credentials.kind === "store" ? existing.credentials.revision : secrets.revision(existing?.id ?? "");
        if (!revision) throw new ProviderRefusal("credential-required");
        credentials = { kind: "store", revision };
      }
    }
    const id = input.id ?? `p-${randomUUID()}`;
    // Conflict check happens before any write: an externally edited or removed
    // managed entry is named, never silently replaced.
    const conflict: NativeManagedState | null = existing === undefined || existing.native.fingerprint === null || !native
      ? null
      : (() => {
          const state = native.state(existing.id, existing.native.fingerprint);
          return state === "synced" ? null : state;
        })();
    if (conflict !== null && !reconcile) {
      // Nothing is written: the caller shows the named conflict and the
      // user's explicit reconcile is what replaces the external value.
      const current = this.store.profile(existing!.id);
      return { profile: this.view(current), status: this.status(undefined), conflict, written: false };
    }
    const draft: ProviderProfileInput & { credentials: ProviderCredentialRef } = { ...input, id, credentials };
    // Validate the exact configuration before any write, so a rejected profile
    // cannot leave a half-written native entry or stored key behind.
    validateExplicitTextProvider(this.configOf({ ...draft, generation: existing?.generation ?? 1 }));
    const entry = this.nativeEntry(draft);
    // Credential first: a platform that cannot encrypt must refuse before any
    // file (native or metadata) starts describing a profile whose key was never
    // stored.
    let revision: number | null = credentials.kind === "store" ? credentials.revision : null;
    if (apiKey !== undefined) {
      if (!this.options.secrets) throw new ProviderRefusal("secret-store-unavailable");
      try { revision = this.options.secrets.set(id, apiKey); }
      catch (error) {
        // The platform cannot encrypt, so the save is refused rather than
        // downgraded to plaintext.
        if (error instanceof Error && error.message.startsWith("provider-secret")) throw new ProviderRefusal("secret-store-unavailable");
        throw error;
      }
    }
    let written: { fingerprint: string } | null = null;
    try { written = native?.write(id, entry) ?? null; }
    catch {
      if (apiKey !== undefined) this.options.secrets?.remove(id);
      throw new ProviderRefusal("models-unreadable");
    }
    const nativeRef = written === null
      ? (existing?.native ?? { providerId: managedProviderId(id), fingerprint: null, writtenAt: null })
      : { providerId: managedProviderId(id), fingerprint: written.fingerprint, writtenAt: this.options.now?.() ?? new Date().toISOString() };
    let saved: ProviderProfile;
    try {
      saved = this.store.save({
        ...draft,
        credentials: revision === null ? credentials : { kind: "store", revision },
        native: nativeRef,
      });
    } catch (error) {
      // A store write that never made it to metadata must not leave a stray key
      // (or a native entry for a profile that does not exist).
      if (apiKey !== undefined) this.options.secrets?.remove(id);
      throw error;
    }
    return { profile: this.view(saved), status: this.status(undefined), conflict: null, written: true };
  }

  /** Removes the profile, its native entry and its stored credential. */
  async remove(id: string, taskId: string | undefined, sender: number): Promise<ProviderStatus> {
    if (taskId !== undefined) {
      const selection = this.store.selection(taskId);
      if (selection?.profileId === id) {
        // A removed profile must not leave a live context pointing at it.
        try { await this.retireInstalled(taskId, sender); }
        catch { /* A live turn keeps its context; the record still goes away. */ }
        this.installed.delete(taskId);
        this.failed.delete(taskId);
        this.store.deselect(taskId);
      }
    }
    this.options.native?.remove(id);
    try { this.options.secrets?.remove(id); } catch { /* A store that cannot read its own file has nothing to delete. */ }
    this.store.remove(id);
    return this.status(taskId);
  }

  /** Real model discovery with the stored (or one-shot) credential. */
  async discover(input: { protocol: string; baseUrl: string; profileId?: string; apiKey?: string }): Promise<DiscoveryOutcome> {
    const descriptor = protocolDescriptor(input.protocol);
    let key: string;
    if (input.apiKey !== undefined) key = input.apiKey;
    else if (input.profileId !== undefined) key = this.credential(this.store.profile(input.profileId));
    else throw new TrustDomainViolation("invalid-payload", "discovery requires a credential");
    const transport: ModelListTransport = createHttpModelListTransport({
      apiKey: key,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    });
    return syncModelCandidates({
      connection: { protocol: input.protocol, baseUrl: input.baseUrl, modelListPath: descriptor.modelListPath },
      transport,
    });
  }

  /** Real connectivity check: one minimal model request over the profile's protocol. */
  async probe(input: { protocol: string; baseUrl: string; modelId: string; profileId?: string; apiKey?: string; maxOutput?: number }): Promise<ProbeOutcome> {
    let key: string;
    if (input.apiKey !== undefined) key = input.apiKey;
    else if (input.profileId !== undefined) key = this.credential(this.store.profile(input.profileId));
    else throw new TrustDomainViolation("invalid-payload", "connectivity test requires a credential");
    return probeConnection({
      protocol: input.protocol,
      baseUrl: input.baseUrl,
      model: input.modelId,
      apiKey: key,
      ...(input.maxOutput === undefined ? {} : { maxOutput: input.maxOutput }),
    }, {
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    });
  }

  async perform(request: unknown, sender: number): Promise<unknown> {
    if (!object(request) || typeof request["op"] !== "string") throw new TrustDomainViolation("invalid-payload", "invalid provider operation");
    switch (request["op"]) {
      case "list": {
        // With a task the panel restores and reports the live selection; without
        // one it is the global Pi configuration list (S03 has no task context).
        const args = shape(request, "list", [], ["taskId"]);
        if (args["taskId"] === undefined) return this.status(undefined);
        const id = taskId(args["taskId"]);
        await this.ensure(id, sender);
        return this.status(id);
      }
      case "save": {
        const args = shape(request, "save", ["profile"], ["apiKey", "reconcile"]);
        const { input, credential } = profileInput(args["profile"]);
        const key = args["apiKey"] === undefined ? undefined : apiKeyOf(args["apiKey"]);
        const reconcile = args["reconcile"] === true;
        const saved = this.save({ ...input, credentials: credential }, key, reconcile);
        return { profile: saved.profile, status: saved.status, conflict: saved.conflict, written: saved.written };
      }
      case "remove": {
        const args = shape(request, "remove", ["profileId"], ["taskId"]);
        return this.remove(profileId(args["profileId"]), args["taskId"] === undefined ? undefined : taskId(args["taskId"]), sender);
      }
      case "select": {
        const args = shape(request, "select", ["taskId", "profileId"], ["modelId", "thinkingLevel"]);
        const modelId = args["modelId"];
        const level = args["thinkingLevel"];
        if (modelId !== undefined && (typeof modelId !== "string" || modelId.length === 0 || modelId.length > 100)) {
          throw new TrustDomainViolation("invalid-payload", "invalid provider model ID");
        }
        if (level !== undefined && typeof level !== "string") throw new TrustDomainViolation("invalid-payload", "invalid provider thinking level");
        return this.select(taskId(args["taskId"]), profileId(args["profileId"]), modelId as string | undefined, level as string | undefined, sender);
      }
      case "clear": return this.clear(taskId(shape(request, "clear", ["taskId"])["taskId"]), sender);
      case "ensure": { const id = taskId(shape(request, "ensure", ["taskId"])["taskId"]); await this.ensure(id, sender); return this.status(id); }
      case "discover": {
        const args = shape(request, "discover", ["protocol", "baseUrl"], ["profileId", "apiKey"]);
        const protocol = args["protocol"];
        if (typeof protocol !== "string" || !isProviderProtocol(protocol)) throw new TrustDomainViolation("invalid-payload", "invalid provider protocol");
        return this.discover({
          protocol,
          baseUrl: endpointOf(args["baseUrl"]),
          ...(args["profileId"] === undefined ? {} : { profileId: profileId(args["profileId"]) }),
          ...(args["apiKey"] === undefined ? {} : { apiKey: apiKeyOf(args["apiKey"]) }),
        });
      }
      case "probe": {
        const args = shape(request, "probe", ["protocol", "baseUrl", "modelId"], ["profileId", "apiKey", "maxOutput"]);
        const protocol = args["protocol"];
        const modelId = args["modelId"];
        if (typeof protocol !== "string" || !isProviderProtocol(protocol)) throw new TrustDomainViolation("invalid-payload", "invalid provider protocol");
        if (typeof modelId !== "string" || modelId.length === 0 || modelId.length > 100) throw new TrustDomainViolation("invalid-payload", "invalid provider model ID");
        const maxOutput = args["maxOutput"];
        if (maxOutput !== undefined && (!Number.isSafeInteger(maxOutput) || (maxOutput as number) < 1 || (maxOutput as number) > 4096)) {
          throw new TrustDomainViolation("invalid-payload", "invalid provider max output");
        }
        return this.probe({
          protocol, baseUrl: endpointOf(args["baseUrl"]), modelId,
          ...(args["profileId"] === undefined ? {} : { profileId: profileId(args["profileId"]) }),
          ...(args["apiKey"] === undefined ? {} : { apiKey: apiKeyOf(args["apiKey"]) }),
          ...(maxOutput === undefined ? {} : { maxOutput: maxOutput as number }),
        });
      }
      default: throw new TrustDomainViolation("invalid-payload", "unknown provider operation");
    }
  }
}

/** Bounded refusals a renderer may name; the raw reason never crosses the IPC. */
export type ProviderRefusalCode = "credential-required" | "credential-missing" | "secret-store-unavailable" | "models-unreadable";

export class ProviderRefusal extends Error {
  constructor(readonly code: ProviderRefusalCode) { super(`provider-${code}`); }
}

/** Fixed renderer-facing sentences; no raw text and no secret can ride along. */
export const PROVIDER_REFUSAL_TEXT: Record<ProviderRefusalCode, string> = {
  "credential-required": "保存这份 Provider 需要 API Key：请填写密钥，或改用环境变量引用",
  "credential-missing": "尚未保存可用的凭据：请填写 API Key 后重试",
  "secret-store-unavailable": "本机无法加密保存密钥（系统安全存储不可用），已拒绝以明文保存",
  "models-unreadable": "Pi 的 models.json 无法解析，已停止写入以免破坏现有配置",
};
