/** On-demand, non-owning projection of the supported native models surface. */
import { readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { NativeModelsFile, fingerprintOf, managedProviderId, NATIVE_APIS } from "./native-models-config.js";
import type { ProviderProfile } from "./provider-profile-store.js";
import { validateExplicitTextProvider } from "../host/explicit-text-provider.js";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function nativeProfileId(providerId: string): string {
  const hash = fingerprintOf(providerId).slice(0, 32);
  return `p-${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
}

export class NativeProviderSource {
  constructor(readonly file: NativeModelsFile, private readonly env: Record<string, string | undefined>) {}

  snapshot(ownedIds: string[]): { profiles: ProviderProfile[]; unsupported: string[]; unreadable: boolean } {
    const read = this.file.read();
    if (!read.ok) return { profiles: [], unsupported: [], unreadable: true };
    const owned = new Set(ownedIds.map(managedProviderId));
    const profiles: ProviderProfile[] = [];
    const unsupported: string[] = [];
    for (const [providerId, entry] of Object.entries(read.providers)) {
      if (owned.has(providerId)) continue;
      try {
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(providerId) || !object(entry) || !Array.isArray(entry["models"]) ||
            !(NATIVE_APIS as readonly unknown[]).includes(entry["api"])) throw new Error();
        // These fields require a richer request adapter. Never silently drop them.
        if (["headers", "authHeader", "modelOverrides", "oauth", "compat"].some((key) => entry[key] !== undefined)) throw new Error();
        const models = entry["models"].map((raw) => {
          if (!object(raw) || ["api", "baseUrl", "headers", "compat", "samplingParams", "samplingParamsByThinkingLevel", "inputLimits", "promptCache", "type"].some((key) => raw[key] !== undefined)) throw new Error();
          return {
            ...(raw["input"] === undefined ? {} : { input: raw["input"] }),
            id: raw["id"], name: raw["name"] ?? raw["id"], contextWindow: raw["contextWindow"] ?? 128000,
            maxTokens: raw["maxTokens"] ?? 16384, reasoning: raw["reasoning"] ?? false,
            ...(raw["thinkingLevelMap"] === undefined || (object(raw["thinkingLevelMap"]) && Object.keys(raw["thinkingLevelMap"]).length === 0) ? {} : { thinkingLevelMap: raw["thinkingLevelMap"] }),
            ...(raw["cost"] === undefined ? {} : { cost: raw["cost"] }),
          };
        });
        const fingerprint = fingerprintOf(entry);
        const id = nativeProfileId(providerId);
        const first = models[0];
        if (!first) throw new Error();
        const config = validateExplicitTextProvider({ profileId: id, protocol: entry["api"], baseUrl: entry["baseUrl"],
          models, modelId: first.id, contextWindow: first.contextWindow, maxTokens: first.maxTokens,
          credentialSource: "store", authRef: id, generation: Math.max(1, parseInt(fingerprint.slice(0, 13), 16)) });
        profiles.push({ id, name: typeof entry["name"] === "string" ? entry["name"].slice(0, 128) : providerId,
          notes: "原生用户配置 · 保留原有认证与所有权；缺省窗口/输出遵循 Pi 1.5 默认值 128000/16384；修改后请新建会话并重新选用。", protocol: config.protocol,
          baseUrl: config.baseUrl, credentials: { kind: "store", revision: 1 }, models: config.models,
          modelId: config.modelId, generation: config.generation, createdAt: "native", updatedAt: "native",
          native: { providerId, fingerprint, writtenAt: null } });
      } catch { unsupported.push(/^[A-Za-z0-9_-]{1,100}$/.test(providerId) ? providerId : "(unsupported provider name)"); }
    }
    return { profiles, unsupported, unreadable: false };
  }

  /** Resolve only the selected native reference, never enumerate or export auth values. */
  credential(profile: ProviderProfile): string {
    const read = this.file.read();
    if (!read.ok) throw new Error("provider-not-configured");
    const entry = read.providers[profile.native.providerId];
    if (!object(entry) || fingerprintOf(entry) !== profile.native.fingerprint) throw new Error("provider-not-configured");
    let configured: unknown = entry["apiKey"];
    try {
      const path = join(this.file.agentDir, "auth.json");
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error();
      const auth: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!object(auth)) throw new Error();
      const stored = auth[profile.native.providerId];
      if (stored !== undefined) {
        if (!object(stored) || stored["type"] !== "api_key" || stored["env"] !== undefined) throw new Error();
        configured = stored["key"];
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("provider-not-configured");
    }
    // Command references require explicit execution authorization and OAuth needs
    // SDK token lifecycle support; preserve both rather than treating them as keys.
    if (typeof configured !== "string" || configured.startsWith("!")) throw new Error("provider-not-configured");
    let missing = false;
    const key = configured.replace(/\$\$|\$!|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (match, braced: string | undefined, plain: string | undefined) => {
        if (match === "$$") return "$";
        if (match === "$!") return "!";
        const value = this.env[braced ?? plain ?? ""];
        if (typeof value !== "string" || value.length === 0) { missing = true; return ""; }
        return value;
      });
    if (missing || key.length < 8 || key.length > 4096 || /[\0\r\n]/.test(key)) throw new Error("provider-not-configured");
    return key;
  }
}
