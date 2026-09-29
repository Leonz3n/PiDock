/**
 * Main-side Provider operations for [PiDock 02m] #46.
 *
 * Trust rules enforced here:
 *
 * - The renderer may name a task, a profile, and profile metadata. It can never
 *   name a credential, a credential *source* other than the profile's own
 *   reference, an environment variable, or a Host op.
 * - The credential value is resolved in main from the profile's `PIDOCK_PROVIDER_*`
 *   reference and is handed only to the task Host on the internal
 *   `task/sdkProvider` op. It never appears in any renderer-facing payload.
 * - A selection is persisted only after the isolated context accepted the
 *   configuration, so a restart can never resume a selection that cannot work.
 * - Failures are reported as bounded states/codes, never as raw SDK or HTTP text.
 */

import type { ProviderProfileStore, ProviderProfileInput } from "./provider-profile-store.js";
import { resolveProviderCredential } from "./provider-profile-store.js";
import { TrustDomainViolation } from "./trust-domain.js";

export type ProviderInstallState =
  /** The isolated context accepted this configuration and is live. */
  | "configured"
  /** No selection, or one that was never installed in this process yet. */
  | "not-configured"
  /** A selection is saved but could not be installed right now (a turn is open). */
  | "pending"
  /** The referenced environment variable has no value. */
  | "credential-missing"
  /**
   * The SDK session recorded for this task was bound to a different Provider
   * identity (endpoint, model parameters, credential reference, or generation),
   * so it refuses to continue. Re-selecting the same profile cannot fix this:
   * the bound identity is what changed. Retirement/rebinding of an existing SDK
   * session is not implemented yet.
   */
  | "binding-stale"
  /** Anything else the isolated context refused, with no raw text forwarded. */
  | "install-failed";

/**
 * Installs (or clears) a task's explicit Provider selection in its isolated
 * context. `sender` is the trusted shell webContents main attests to the task
 * Host; it comes from the IPC sender, never from a payload.
 */
export type ProviderInstaller = (taskId: string, provider: { profileId: string; credential: string } | null, sender: number) => Promise<void>;

interface ProviderView {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
  authRef: string;
  generation: number;
  credentialAvailable: boolean;
}

export interface ProviderStatus {
  state: ProviderInstallState;
  profileId: string | null;
  generation: number | null;
  profiles: ProviderView[];
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

function shape(value: unknown, op: string, fields: string[]): Record<string, unknown> {
  if (!object(value) || value["op"] !== op || Object.keys(value).sort().join(",") !== ["op", ...fields].sort().join(",")) {
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

function profileInput(value: unknown): ProviderProfileInput {
  if (!object(value)) throw new TrustDomainViolation("invalid-payload", "invalid provider profile");
  const allowed = ["id", "name", "baseUrl", "modelId", "contextWindow", "maxTokens", "authRef"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new TrustDomainViolation("invalid-payload", "invalid provider profile fields");
  for (const field of ["name", "baseUrl", "modelId", "authRef"]) {
    const raw = value[field];
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) throw new TrustDomainViolation("invalid-payload", `invalid provider ${field}`);
  }
  for (const field of ["contextWindow", "maxTokens"]) {
    const raw = value[field];
    if (!Number.isSafeInteger(raw) || (raw as number) < 1) throw new TrustDomainViolation("invalid-payload", `invalid provider ${field}`);
  }
  return {
    ...(value["id"] === undefined ? {} : { id: profileId(value["id"]) }),
    name: value["name"] as string,
    baseUrl: value["baseUrl"] as string,
    modelId: value["modelId"] as string,
    contextWindow: value["contextWindow"] as number,
    maxTokens: value["maxTokens"] as number,
    authRef: value["authRef"] as string,
  };
}

/**
 * Owns the task↔profile↔context wiring. `ensure` re-installs a persisted
 * selection when a task is first touched after a restart; installs are
 * remembered per task so ordinary ops do not repeat the work.
 */
export class ProviderWiring {
  private readonly installed = new Map<string, string>();
  private readonly failed = new Map<string, { key: string; state: ProviderInstallState }>();

  constructor(
    private readonly store: ProviderProfileStore,
    private readonly install: ProviderInstaller,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  private views(): ProviderView[] {
    return this.store.list().profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      modelId: profile.modelId,
      contextWindow: profile.contextWindow,
      maxTokens: profile.maxTokens,
      authRef: profile.authRef,
      generation: profile.generation,
      credentialAvailable: typeof this.env[profile.authRef] === "string" && (this.env[profile.authRef] as string).length > 0,
    }));
  }

  /**
   * A failure that belongs to the current selection is reported as-is, so the
   * user learns *why* a configured-looking task cannot send (missing credential
   * or a refused context) instead of seeing a silent "not configured".
   */
  private state(taskId: string): ProviderInstallState {
    const selection = this.store.selection(taskId);
    const key = selection === null ? null : `${selection.profileId}:${selection.generation}`;
    if (key !== null && this.installed.get(taskId) === key) return "configured";
    const failure = this.failed.get(taskId);
    if (failure && (key === null || failure.key === key)) return failure.state;
    // A saved selection that this process has not installed yet is pending, not
    // missing: the panel reports the difference instead of claiming "unconfigured".
    return key === null ? "not-configured" : "pending";
  }

  /** Installs the persisted selection for a task once per process. */
  async ensure(taskId: string, sender: number): Promise<ProviderInstallState> {
    const selection = this.store.selection(taskId);
    if (!selection) return "not-configured";
    const key = `${selection.profileId}:${selection.generation}`;
    if (this.installed.get(taskId) === key) return "configured";
    return await this.installSelection(taskId, selection.profileId, key, sender);
  }

  /** Installs and persists an explicit user selection. */
  async select(taskId: string, id: string, sender: number): Promise<ProviderStatus> {
    const config = this.store.config(id);
    const key = `${id}:${config.generation}`;
    const state = await this.installSelection(taskId, id, key, sender);
    if (state !== "configured") return this.status(taskId);
    this.store.select(taskId, id);
    return this.status(taskId);
  }

  /** Clears the selection; the context is dropped before the record disappears. */
  async clear(taskId: string, sender: number): Promise<ProviderStatus> {
    try { await this.install(taskId, null, sender); } finally {
      this.installed.delete(taskId);
      this.failed.delete(taskId);
      this.store.deselect(taskId);
    }
    return this.status(taskId);
  }

  private async installSelection(taskId: string, id: string, key: string, sender: number): Promise<ProviderInstallState> {
    let credential: string;
    try { credential = resolveProviderCredential({ authRef: this.store.config(id).authRef }, this.env); }
    catch { this.failed.set(taskId, { key, state: "credential-missing" }); return "credential-missing"; }
    try { await this.install(taskId, { profileId: id, credential }, sender); }
    catch (error) {
      const state = classifyInstallFailure(error);
      // "pending" is a retryable timing condition (a turn is still open) and is
      // deliberately not remembered as a failure.
      if (state === "pending") this.failed.delete(taskId);
      else this.failed.set(taskId, { key, state });
      return state;
    }
    this.failed.delete(taskId);
    this.installed.set(taskId, key);
    return "configured";
  }

  /** Renderer-facing status: metadata and availability only, never a secret. */
  status(taskId: string): ProviderStatus {
    const selection = this.store.selection(taskId);
    return {
      state: this.state(taskId),
      profileId: selection?.profileId ?? null,
      generation: selection?.generation ?? null,
      profiles: this.views(),
    };
  }

  /** Re-renders the status after a profile edit so a bumped generation is visible. */
  private statusAfterProfileChange(taskId: string): ProviderStatus {
    const installed = this.installed.get(taskId);
    if (installed && this.store.selection(taskId) === null) this.installed.delete(taskId);
    return this.status(taskId);
  }

  async perform(request: unknown, sender: number): Promise<unknown> {
    if (!object(request) || typeof request["op"] !== "string") throw new TrustDomainViolation("invalid-payload", "invalid provider operation");
    switch (request["op"]) {
      case "list": {
        const id = taskId(shape(request, "list", ["taskId"])["taskId"]);
        // Opening the panel is what restores a persisted selection after a
        // restart, so the reported state describes the live context.
        await this.ensure(id, sender);
        return this.status(id);
      }
      case "save": {
        const args = shape(request, "save", ["taskId", "profile"]);
        const saved = this.store.save(profileInput(args["profile"]));
        return { profile: saved, status: this.statusAfterProfileChange(taskId(args["taskId"])) };
      }
      case "remove": {
        const args = shape(request, "remove", ["taskId", "profileId"]);
        const id = profileId(args["profileId"]);
        const status = this.status(taskId(args["taskId"]));
        // A removed profile must not leave a live context pointing at it.
        if (status.profileId === id) await this.clear(taskId(args["taskId"]), sender);
        this.store.remove(id);
        return this.status(taskId(args["taskId"]));
      }
      case "select": {
        const args = shape(request, "select", ["taskId", "profileId"]);
        return this.select(taskId(args["taskId"]), profileId(args["profileId"]), sender);
      }
      case "clear": return this.clear(taskId(shape(request, "clear", ["taskId"])["taskId"]), sender);
      case "ensure": { const id = taskId(shape(request, "ensure", ["taskId"])["taskId"]); await this.ensure(id, sender); return this.status(id); }
      default: throw new TrustDomainViolation("invalid-payload", "unknown provider operation");
    }
  }
}
