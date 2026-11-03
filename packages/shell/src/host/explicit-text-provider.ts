import { createHash } from "node:crypto";
import { createAssistantMessageEventStream, type Api, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * One declared model row. Windows, max output and reasoning are **declared by
 * the operator** (and, for a profile created from discovery, from the endpoint's
 * own model list); the product never presents them as provider-probed truth.
 */
export interface ExplicitProviderModel {
  id: string;
  /** Display name shown in the composer; falls back to the id when equal. */
  name: string;
  contextWindow: number;
  maxTokens: number;
  /** Whether the model declares thinking support. */
  reasoning: boolean;
  /** Pi thinking level → provider value; `null` marks a level unsupported. */
  thinkingLevelMap?: Record<string, string | null>;
  /** Declared price per million tokens; absent means "unknown", never zero. */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
}

/**
 * The exact configuration handed to a task's isolated SDK context ([PiDock T03]
 * #138). It pins the *protocol* explicitly — the SDK api id is never derived
 * from a vendor name or a URL — and carries every declared model row so the
 * context can register the profile's whole model list while the session binds
 * exactly one of them (`modelId`).
 */
export interface ExplicitTextProvider {
  profileId: string;
  protocol: ExplicitProtocol;
  baseUrl: string;
  modelId: string;
  models: ExplicitProviderModel[];
  contextWindow: number;
  maxTokens: number;
  /**
   * `env` = the credential lives in the named environment variable (compat);
   * `store` = it lives in PiDock's encrypted store keyed by the profile id.
   */
  credentialSource: ExplicitCredentialSource;
  authRef: string;
  generation: number;
}

export const EXPLICIT_PROTOCOLS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export type ExplicitProtocol = (typeof EXPLICIT_PROTOCOLS)[number];
export type ExplicitCredentialSource = "env" | "store";

export const EXPLICIT_KEYS = [
  "authRef", "baseUrl", "contextWindow", "credentialSource", "generation", "maxTokens",
  "modelId", "models", "profileId", "protocol",
] as const;
const MODEL_KEYS = ["contextWindow", "id", "maxTokens", "name", "reasoning"] as const;
const TIERS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const MODEL_ID = /^[a-zA-Z0-9._:/-]{1,100}$/;
const ENV_REF = /^PIDOCK_PROVIDER_[A-Z0-9_]{1,64}$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function endpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("provider-endpoint-invalid"); }
  if (url.username || url.password || url.search || url.hash || !url.hostname ||
      !["https:", "http:"].includes(url.protocol) ||
      (url.protocol === "http:" && !["127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("provider-endpoint-invalid");
  }
  return url;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("provider-configuration-invalid");
  return value as number;
}

function text(value: unknown, max: number, pattern: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || !pattern.test(value)) {
    throw new Error("provider-configuration-invalid");
  }
  return value;
}

function modelRowOf(value: unknown): ExplicitProviderModel {
  if (!record(value)) throw new Error("provider-configuration-invalid");
  const allowed = [...MODEL_KEYS, "thinkingLevelMap", "cost"];
  if (Object.keys(value).some((key) => !allowed.includes(key)) || MODEL_KEYS.some((key) => !Object.hasOwn(value, key))) {
    throw new Error("provider-configuration-invalid");
  }
  const id = text(value["id"], 100, MODEL_ID);
  const name = text(value["name"], 128, /^[^\0]+$/);
  const reasoning = value["reasoning"];
  if (typeof reasoning !== "boolean") throw new Error("provider-configuration-invalid");
  const contextWindow = positiveInteger(value["contextWindow"]);
  const maxTokens = positiveInteger(value["maxTokens"]);
  if (maxTokens > contextWindow) throw new Error("provider-configuration-invalid");
  const row: ExplicitProviderModel = { id, name, contextWindow, maxTokens, reasoning };
  const map = value["thinkingLevelMap"];
  if (map !== undefined) {
    // A declared map only makes sense for a model that declares reasoning; a
    // non-reasoning model carrying one would let the UI offer levels the SDK
    // cannot honour.
    if (!reasoning || !record(map) || Object.keys(map).length === 0) throw new Error("provider-configuration-invalid");
    const levels: Record<string, string | null> = {};
    for (const [level, mapped] of Object.entries(map)) {
      if (!(TIERS as readonly string[]).includes(level)) throw new Error("provider-configuration-invalid");
      if (mapped === null) levels[level] = null;
      else if (typeof mapped === "string" && mapped.length > 0 && mapped.length <= 32 && !mapped.includes("\0")) levels[level] = mapped;
      else throw new Error("provider-configuration-invalid");
    }
    row.thinkingLevelMap = levels;
  }
  const cost = value["cost"];
  if (cost !== undefined && cost !== null) {
    if (!record(cost) || Object.keys(cost).sort().join(",") !== "cacheRead,cacheWrite,input,output") throw new Error("provider-configuration-invalid");
    const parts: Record<string, number> = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
      const number = cost[key];
      if (typeof number !== "number" || !Number.isFinite(number) || number < 0) throw new Error("provider-configuration-invalid");
      parts[key] = number;
    }
    row.cost = { input: parts["input"]!, output: parts["output"]!, cacheRead: parts["cacheRead"]!, cacheWrite: parts["cacheWrite"]! };
  }
  return row;
}

export function validateExplicitTextProvider(value: unknown): ExplicitTextProvider {
  if (!record(value)) throw new Error("provider-configuration-invalid");
  if (Object.keys(value).sort().join(",") !== [...EXPLICIT_KEYS].sort().join(",")) throw new Error("provider-configuration-invalid");
  const profileId = text(value["profileId"], 80, /^[a-zA-Z0-9_-]{1,80}$/);
  const modelId = text(value["modelId"], 100, MODEL_ID);
  const authRef = text(value["authRef"], 100, /^[a-zA-Z0-9._:-]{1,100}$/);
  const protocol = value["protocol"];
  if (typeof protocol !== "string" || !(EXPLICIT_PROTOCOLS as readonly string[]).includes(protocol)) throw new Error("provider-configuration-invalid");
  const credentialSource = value["credentialSource"];
  if (credentialSource !== "env" && credentialSource !== "store") throw new Error("provider-configuration-invalid");
  if (credentialSource === "env" && !ENV_REF.test(authRef)) throw new Error("provider-configuration-invalid");
  // The store is keyed by the profile itself, so the reference cannot name any
  // other profile (or any environment variable).
  if (credentialSource === "store" && authRef !== profileId) throw new Error("provider-configuration-invalid");
  const generation = positiveInteger(value["generation"]);
  const contextWindow = positiveInteger(value["contextWindow"]);
  const maxTokens = positiveInteger(value["maxTokens"]);
  const rawModels = value["models"];
  if (!Array.isArray(rawModels) || rawModels.length === 0 || rawModels.length > 20) throw new Error("provider-configuration-invalid");
  const models = rawModels.map(modelRowOf);
  if (new Set(models.map((row) => row.id)).size !== models.length) throw new Error("provider-configuration-invalid");
  const selected = models.find((row) => row.id === modelId);
  if (!selected) throw new Error("provider-configuration-invalid");
  // The selected row is the single source for the session's window and output;
  // a mismatch would let the UI claim one limit while the SDK uses another.
  if (selected.contextWindow !== contextWindow || selected.maxTokens !== maxTokens || maxTokens > contextWindow) {
    throw new Error("provider-configuration-invalid");
  }
  if (typeof value["baseUrl"] !== "string") throw new Error("provider-configuration-invalid");
  endpoint(value["baseUrl"]);
  return { profileId, protocol: protocol as ExplicitProtocol, baseUrl: value["baseUrl"], modelId, models, contextWindow, maxTokens, credentialSource, authRef, generation };
}

/** Deterministic JSON so the binding digest never depends on key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

/**
 * The session binding identity: profile, protocol, endpoint, the *whole*
 * declared model list, the selected model, the credential reference and the
 * configuration generation. Any change the user made invalidates an existing
 * SDK session rather than silently continuing under a different meaning.
 */
export function explicitBindingIdentity(input: ExplicitTextProvider): string {
  const config = validateExplicitTextProvider(input);
  const url = endpoint(config.baseUrl);
  return createHash("sha256").update(JSON.stringify([
    2, config.profileId, config.protocol, url.href, config.modelId,
    config.contextWindow, config.maxTokens, config.credentialSource, config.authRef, config.generation,
    canonical(config.models.map((row) => ({
      id: row.id, name: row.name, contextWindow: row.contextWindow, maxTokens: row.maxTokens,
      reasoning: row.reasoning, ...(row.thinkingLevelMap ? { thinkingLevelMap: row.thinkingLevelMap } : {}),
      ...(row.cost ? { cost: row.cost } : {}),
    }))),
  ])).digest("hex");
}

/** Credential-shaped variable names the SDK could resolve implicitly. */
const CREDENTIAL_ENV = /(?:^|_)(?:API_?KEY|ACCESS_KEY(?:_ID)?|TOKEN|SECRET(?:_ACCESS_KEY|_KEY)?|PASSWORD|PASSWD|CREDENTIALS?)(?:$|_)/i;

/** Exported so callers/tests can prove their environment is credential-free. */
export function isCredentialEnvName(name: string): boolean {
  return CREDENTIAL_ENV.test(name);
}

/**
 * The SDK runtime probes every built-in provider for ambient credentials, so it
 * may only be created in an environment the trusted caller prepared: the explicit
 * opt-in is required (the production Host never sets it) and any credential-shaped
 * variable is refused outright. Fails closed before any runtime or request exists.
 */
function assertIsolatedSdkEnvironment(): void {
  if (process.env["PIDOCK_SDK_ISOLATED"] !== "1") throw new Error("provider-environment-unisolated");
  for (const name of Object.keys(process.env)) {
    if (isCredentialEnvName(name)) throw new Error("provider-environment-unisolated");
  }
}

function withoutCredential<T>(value: T, key: string): T {
  return JSON.parse(JSON.stringify(value, (_name, field: unknown) =>
    typeof field === "string" ? field.replaceAll(key, "[redacted]") : field)) as T;
}

export async function createExplicitTextRuntime(config: ExplicitTextProvider, key: string): Promise<{ runtime: ModelRuntime; model: Model<Api>; bindingIdentity: string }> {
  const validated = validateExplicitTextProvider(config);
  if (typeof key !== "string" || key.length < 8 || key.length > 4096) throw new Error("provider-not-configured");
  assertIsolatedSdkEnvironment();
  const url = endpoint(validated.baseUrl);
  const bindingIdentity = explicitBindingIdentity(config);
  const runtime = await ModelRuntime.create({
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async () => { throw new Error("provider-credential-write-disabled"); },
      delete: async () => { throw new Error("provider-credential-write-disabled"); },
    },
    modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
  });
  const providerId = `pidock-${config.profileId}`;
  runtime.registerProvider(providerId, {
    name: `PiDock ${config.profileId}`,
    baseUrl: url.href,
    // The protocol is the one the operator selected; it is never re-derived
    // from the vendor, the host name or the path.
    api: validated.protocol,
    apiKey: key,
    models: validated.models.map((row) => ({
      id: row.id,
      name: row.name,
      api: validated.protocol,
      reasoning: row.reasoning,
      ...(row.thinkingLevelMap ? { thinkingLevelMap: row.thinkingLevelMap } : {}),
      input: ["text"] as ("text" | "image")[],
      // `ProviderModelConfig.cost` is required by the SDK contract. A declared
      // price is passed through; an undeclared one stays a zero placeholder
      // that PiDock never presents as a real price (the UI reports `cost: null`).
      cost: row.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: row.contextWindow,
      maxTokens: row.maxTokens,
    })),
  });
  const model = runtime.getModel(providerId, config.modelId);
  if (!model || model.api !== validated.protocol) throw new Error("provider-configuration-invalid");
  const streamSimple = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (selected, context, options) => {
    const safe = createAssistantMessageEventStream();
    let pendingText = "";
    queueMicrotask(async () => {
      try {
        const source = streamSimple(selected, context, {
          ...options, maxRetries: 0,
          fetch: (input, init) => globalThis.fetch(input, { ...init, redirect: "manual" }),
        });
        for await (const event of source) {
          if (event.type === "text_start") pendingText = "";
          if (event.type === "text_delta") {
            pendingText += event.delta;
            let released = "";
            while (pendingText) {
              if (pendingText.startsWith(key)) {
                released += "[redacted]";
                pendingText = pendingText.slice(key.length);
              } else if (key.startsWith(pendingText)) {
                break;
              } else {
                released += pendingText[0];
                pendingText = pendingText.slice(1);
              }
            }
            if (released) safe.push(withoutCredential({ ...event, delta: released }, key));
            continue;
          }
          if (event.type === "text_end" && pendingText) {
            safe.push(withoutCredential({ type: "text_delta", contentIndex: event.contentIndex,
              delta: pendingText, partial: event.partial }, key));
            pendingText = "";
          }
          if (event.type === "error") {
            safe.push(withoutCredential({ ...event, error: { ...event.error, content: [], errorMessage: event.reason === "aborted" ? "provider-request-aborted" : "provider-request-failed" } }, key));
          } else {
            safe.push(withoutCredential(event, key));
          }
        }
      } catch {
        safe.push({ type: "error", reason: "error", error: {
          role: "assistant", api: selected.api, provider: selected.provider, model: selected.id,
          content: [], stopReason: "error", errorMessage: "provider-request-failed", timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        } });
      }
    });
    return safe;
  };
  return { runtime, model, bindingIdentity };
}
