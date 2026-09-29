import { createHash } from "node:crypto";
import { createAssistantMessageEventStream, type Api, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface ExplicitTextProvider {
  profileId: string;
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
  authRef: string;
  generation: number;
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

export function validateExplicitTextProvider(value: unknown): ExplicitTextProvider {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("provider-configuration-invalid");
  const config = value as Record<string, unknown>;
  if (Object.keys(config).sort().join(",") !== "authRef,baseUrl,contextWindow,generation,maxTokens,modelId,profileId" ||
      typeof config.profileId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(config.profileId) ||
      typeof config.modelId !== "string" || !/^[a-zA-Z0-9._:-]{1,100}$/.test(config.modelId) ||
      typeof config.authRef !== "string" || !/^PIDOCK_PROVIDER_[A-Z0-9_]{1,64}$/.test(config.authRef) ||
      !Number.isSafeInteger(config.contextWindow) || Number(config.contextWindow) < 1 ||
      !Number.isSafeInteger(config.maxTokens) || Number(config.maxTokens) < 1 || Number(config.maxTokens) > Number(config.contextWindow) ||
      !Number.isSafeInteger(config.generation) || Number(config.generation) < 1 ||
      typeof config.baseUrl !== "string") throw new Error("provider-configuration-invalid");
  endpoint(config.baseUrl);
  return config as unknown as ExplicitTextProvider;
}

export function explicitBindingIdentity(input: ExplicitTextProvider): string {
  const config = validateExplicitTextProvider(input);
  const url = endpoint(config.baseUrl);
  if (!Number.isSafeInteger(config.generation) || config.generation < 1) throw new Error("provider-configuration-invalid");
  return createHash("sha256").update(JSON.stringify([
    1, config.profileId, "openai-completions", url.href, config.modelId,
    config.contextWindow, config.maxTokens, config.authRef, config.generation,
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
  runtime.registerProvider(`pidock-${config.profileId}`, {
    baseUrl: url.href, api: "openai-completions", apiKey: key,
    models: [{ id: config.modelId, name: config.modelId, api: "openai-completions", reasoning: false,
      input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: config.contextWindow, maxTokens: config.maxTokens }],
  });
  const model = runtime.getModel(`pidock-${config.profileId}`, config.modelId);
  if (!model || model.api !== "openai-completions") throw new Error("provider-configuration-invalid");
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
