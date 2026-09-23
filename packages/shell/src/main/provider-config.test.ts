import { describe, expect, it } from "vitest";
import {
  candidateSetIsStale,
  connectionFingerprint,
  describeHistoryAttribution,
  describeProviderStatus,
  evaluateModelSwitch,
  followModelName,
  followModelNameOnIdChange,
  isAuthReference,
  isSecretLike,
  mergeDiscoveryCandidates,
  evaluateThinkingSelection,
  redactProviderProfile,
  resolveSessionThinking,
  resolveModelDisplayName,
  resolveProviderAvailability,
  validateProviderProfile,
  type ProviderProfileRow,
} from "./provider-config.js";

const base = {
  id: "provider-openai",
  name: "团队网关",
  protocol: "openai-responses",
  baseUrl: "https://gateway.example.com/v1",
  authRef: "gateway-key",
  enabled: true,
  models: [{ id: "gpt-5", contextWindow: 200, maxOutput: 8, supportsImages: true }],
};

function errorOf(input: unknown): { code: string; field: string; message: string } {
  const result = validateProviderProfile(input);
  if (result.ok) throw new Error("expected validation to fail");
  return result.error;
}

describe("validateProviderProfile", () => {
  it("accepts a profile with an auth reference and echoes the normalized row", () => {
    const result = validateProviderProfile({ ...base, name: " 团队网关 ", models: [{ id: " gpt-5 ", contextWindow: 200, name: " 主力模型 " }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile).toEqual({
      id: "provider-openai",
      name: "团队网关",
      protocol: "openai-responses",
      baseUrl: "https://gateway.example.com/v1",
      authRef: "gateway-key",
      enabled: true,
      models: [{ id: "gpt-5", name: "主力模型", contextWindow: 200 }],
    });
  });

  it("accepts all three protocols but requires the protocol explicitly", () => {
    for (const protocol of ["anthropic-messages", "openai-responses", "openai-chat-completions"]) {
      expect(validateProviderProfile({ ...base, protocol }).ok).toBe(true);
    }
    expect(errorOf({ ...base, protocol: undefined }).code).toBe("protocol-required");
    expect(errorOf({ ...base, protocol: "gemini" }).code).toBe("protocol-unsupported");
  });

  it("rejects missing names, addresses and credentials embedded in the address", () => {
    expect(errorOf({ ...base, name: "   " }).code).toBe("provider-name-required");
    expect(errorOf({ ...base, baseUrl: "" }).code).toBe("base-url-required");
    expect(errorOf({ ...base, baseUrl: "https://user:pass@gateway.example.com/v1" }).code).toBe("credentials-in-url");
  });

  it("keeps the auth reference a reference, never a literal secret", () => {
    expect(isSecretLike("sk-live-abcdefghijklmnop")).toBe(true);
    expect(isSecretLike("Bearer abc123")).toBe(true);
    expect(isSecretLike("A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6")).toBe(true);
    expect(isSecretLike("gateway-key")).toBe(false);
    expect(isAuthReference("gateway key")).toBe(false);
    expect(errorOf({ ...base, authRef: "sk-live-abcdefghijklmnop" }).code).toBe("auth-ref-looks-like-secret");
    expect(errorOf({ ...base, authRef: "has space" }).code).toBe("auth-ref-invalid");
    // A profile without an auth reference stays valid (local, unauthenticated).
    const local = validateProviderProfile({ ...base, authRef: undefined });
    expect(local.ok).toBe(true);
    if (local.ok) expect(local.profile.authRef).toBeUndefined();
  });

  it("validates model rows: empty, duplicate, context window and max output units", () => {
    expect(errorOf({ ...base, models: [] }).code).toBe("model-required");
    expect(errorOf({ ...base, models: [{ id: " ", contextWindow: 8 }] }).code).toBe("model-id-required");
    expect(errorOf({ ...base, models: [{ id: "gpt-5", contextWindow: 8 }, { id: " gpt-5 ", contextWindow: 8 }] }).code).toBe("model-id-duplicate");
    expect(errorOf({ ...base, models: [{ id: "gpt-5", contextWindow: 0 }] }).code).toBe("context-window-invalid");
    expect(errorOf({ ...base, models: [{ id: "gpt-5", contextWindow: 1.5 }] }).code).toBe("context-window-invalid");
    expect(errorOf({ ...base, models: [{ id: "gpt-5", contextWindow: 8, maxOutput: 0 }] }).code).toBe("max-output-invalid");
    expect(errorOf({ ...base, models: [{ id: "gpt-5", contextWindow: 8, maxOutput: 9 }] }).code).toBe("max-output-exceeds-window");
    expect(validateProviderProfile({ ...base, models: [{ id: "gpt-5", contextWindow: 8, maxOutput: 8 }] }).ok).toBe(true);
  });

  it("validates reasoning tiers: declared subset, default inside, no invented or repeated level", () => {
    const custom = { mode: "custom", levels: ["off", "low", "medium"], default: "low" };
    expect(validateProviderProfile({ ...base, models: [{ id: "gpt-5", contextWindow: 8, thinking: custom }] }).ok).toBe(true);
    // A per-model subset may omit catalog levels (that is what declaring tiers means).
    expect(validateProviderProfile({ ...base, models: [{ id: "gpt-5", contextWindow: 8, thinking: { mode: "custom", levels: ["off", "high"], default: "off" } }] }).ok).toBe(
      true,
    );
    expect(errorOf({ ...base, models: [{ id: "gpt-5", contextWindow: 8, thinking: { mode: "custom", levels: ["off"], default: "high" } }] }).code).toBe(
      "thinking-default-not-in-levels",
    );
    expect(errorOf({ ...base, models: [{ id: "gpt-5", contextWindow: 8, thinking: { mode: "custom", levels: ["off", "off"], default: "off" } }] }).code).toBe(
      "thinking-level-duplicate",
    );
    expect(errorOf({ ...base, models: [{ id: "gpt-5", contextWindow: 8, thinking: { mode: "custom", levels: ["turbo"], default: "turbo" } }] }).code).toBe(
      "thinking-level-unknown",
    );
    expect(errorOf({ ...base, models: [{ id: "gpt-5", contextWindow: 8, thinking: { mode: "maybe", levels: [], default: "" } }] }).code).toBe(
      "thinking-mode-unknown",
    );
  });

  it("never infers a capability from the model id", () => {    const result = validateProviderProfile({ ...base, models: [{ id: "gpt-5-vision", contextWindow: 8 }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.models[0].supportsImages).toBeUndefined();
    expect(result.profile.models[0].thinking).toBeUndefined();
  });
});

describe("display-name follow", () => {
  it("follows the id, stops on an edit, and follows again when cleared or reset", () => {
    expect(followModelName("claude-sonnet-4-5", "")).toEqual({ name: undefined, followsId: true });
    expect(followModelName("claude-sonnet-4-5", "主力模型")).toEqual({ name: "主力模型", followsId: false });
    expect(followModelName("claude-sonnet-4-5", "claude-sonnet-4-5")).toEqual({ name: undefined, followsId: true });
    expect(resolveModelDisplayName({ id: "claude-sonnet-4-5" })).toBe("claude-sonnet-4-5");
    expect(resolveModelDisplayName({ id: "claude-sonnet-4-5", name: "主力模型" })).toBe("主力模型");
  });

  it("re-mirrors the new id while following and keeps a custom name after an id edit", () => {
    expect(followModelNameOnIdChange({ name: undefined, followsId: true })).toEqual({ name: undefined, followsId: true });
    expect(followModelNameOnIdChange({ name: "主力模型", followsId: false })).toEqual({ name: "主力模型", followsId: false });
  });
});

describe("reasoning tier selection", () => {
  const declared = { mode: "custom" as const, levels: ["off", "low", "high"], default: "low" };

  it("resolves a stored preference only while the model declares it (stale pref)", () => {
    expect(resolveSessionThinking({ thinking: declared }, "high")).toEqual({ catalog: "declared", level: "high", source: "session" });
    expect(resolveSessionThinking({ thinking: declared }, undefined)).toEqual({ catalog: "declared", level: "low", source: "model-default" });
    // 旧偏好失效: a level the model no longer declares falls back to the model
    // default and reports the stale value instead of silently coercing it.
    expect(resolveSessionThinking({ thinking: declared }, "medium")).toEqual({
      catalog: "declared",
      level: "low",
      source: "model-default",
      stale: "medium",
    });
    expect(resolveSessionThinking({ thinking: { mode: "none", levels: [], default: "" } }, "low")).toEqual({ catalog: "unsupported", level: "", source: "none" });
    // Catalog unknown (mode auto / absent): the app cannot claim a level list.
    expect(resolveSessionThinking({}, "high")).toEqual({ catalog: "catalog-unknown", level: "high", source: "session" });
  });

  it("refuses undeclared levels, unknown catalogs cleared, unsupported models and forced-off tiers", () => {
    expect(evaluateThinkingSelection({ thinking: declared, level: "medium" })).toEqual({
      ok: false,
      error: { code: "thinking-level-not-declared", message: "模型未声明该推理档位：medium" },
    });
    expect(evaluateThinkingSelection({ thinking: declared, level: "high" })).toEqual({ ok: true, level: "high" });
    // 可关闭: the model declares `off`, so clearing resolves to it.
    expect(evaluateThinkingSelection({ thinking: declared, level: "" })).toEqual({ ok: true, level: "off" });
    // 不可关闭: without `off` the picker cannot be cleared.
    expect(
      evaluateThinkingSelection({ thinking: { mode: "custom", levels: ["low", "high"], default: "low" }, level: "" }),
    ).toEqual({ ok: false, error: { code: "thinking-required", message: "该模型不支持关闭推理，请选择已声明档位" } });
    expect(evaluateThinkingSelection({ thinking: { mode: "none", levels: [], default: "" }, level: "low" })).toEqual({
      ok: false,
      error: { code: "thinking-unsupported", message: "当前模型不支持推理档位" },
    });
    expect(evaluateThinkingSelection({ level: "" })).toEqual({
      ok: false,
      error: { code: "thinking-catalog-unknown", message: "模型目录尚未提供可用档位，不能声明已关闭推理" },
    });
    expect(evaluateThinkingSelection({ level: "high" })).toEqual({ ok: true, level: "high" });
  });
});

describe("discovery candidate merging", () => {
  it("updates candidates only and reports the differences", () => {
    const merge = mergeDiscoveryCandidates({
      configured: [{ id: "gpt-5" }, { id: "团队轻量模型" }],
      candidates: ["gpt-5", "gpt-5-mini", "gpt-5", "   "],
    });
    expect(merge.candidates).toEqual(["gpt-5", "gpt-5-mini"]);
    expect(merge.matchedConfigured).toEqual(["gpt-5"]);
    expect(merge.unmatchedConfigured).toEqual(["团队轻量模型"]);
    expect(merge.unmatchedCandidates).toEqual(["gpt-5-mini"]);
  });

  it("fingerprints the connection so a changed connection invalidates the candidate set", () => {
    const set = { providerId: "provider-openai", candidates: ["gpt-5"], fingerprint: connectionFingerprint({ protocol: "openai-responses", baseUrl: "https://a.example.com" }) };
    expect(candidateSetIsStale(set, { protocol: "openai-responses", baseUrl: "https://a.example.com" })).toBe(false);
    expect(candidateSetIsStale(set, { protocol: "openai-responses", baseUrl: "https://b.example.com" })).toBe(true);
    expect(candidateSetIsStale(set, { protocol: "anthropic-messages", baseUrl: "https://a.example.com" })).toBe(true);
  });
});

describe("model switch evaluation", () => {
  const target = { providerId: "provider-openai", modelId: "gpt-5", contextWindow: 200, enabled: true, exists: true };

  it("refuses while a round/tool/compaction is running", () => {
    const result = evaluateModelSwitch({ running: true, busyLabel: "工具执行中", target, occupancy: { used: 10, source: "actual" } });
    expect(result).toEqual({ ok: false, error: { code: "busy-round", message: expect.stringContaining("工具执行中") } });
  });

  it("refuses a disabled provider or an unavailable model", () => {
    expect(evaluateModelSwitch({ running: false, target: { ...target, enabled: false }, occupancy: { used: 10, source: "actual" } })).toMatchObject({
      ok: false,
      error: { code: "provider-disabled" },
    });
    expect(evaluateModelSwitch({ running: false, target: { ...target, exists: false }, occupancy: { used: 10, source: "actual" } })).toMatchObject({
      ok: false,
      error: { code: "model-unavailable" },
    });
    expect(evaluateModelSwitch({ running: false, target: null, occupancy: { used: 10, source: "actual" } })).toMatchObject({
      ok: false,
      error: { code: "model-unavailable" },
    });
  });

  it("never treats an unknown window or pending occupancy as a zero pass", () => {
    expect(evaluateModelSwitch({ running: false, target: { ...target, contextWindow: 0 }, occupancy: { used: 0, source: "actual" } })).toMatchObject({
      ok: false,
      error: { code: "context-window-unknown" },
    });
    for (const source of ["pending", "unknown"] as const) {
      expect(evaluateModelSwitch({ running: false, target, occupancy: { used: 1, source } })).toMatchObject({
        ok: false,
        error: { code: "context-occupancy-unknown" },
      });
    }
  });

  it("applies strict bounds: greater refuses, equal and smaller pass", () => {
    const over = evaluateModelSwitch({ running: false, target, occupancy: { used: 201, source: "actual" } });
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.error.code).toBe("context-over-limit");
      expect(over.error.message).toContain("201000");
      expect(over.error.message).toContain("200000");
      expect(over.error.occupancy).toBe(201);
      expect(over.error.limit).toBe(200);
    }
    expect(evaluateModelSwitch({ running: false, target, occupancy: { used: 200, source: "actual" } })).toEqual({ ok: true });
    expect(evaluateModelSwitch({ running: false, target, occupancy: { used: 199, source: "estimated" } })).toEqual({ ok: true });
  });
});

describe("availability and history attribution", () => {
  const profiles: ProviderProfileRow[] = [
    {
      id: "provider-anthropic",
      name: "Anthropic 官方",
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      enabled: true,
      models: [{ id: "claude-sonnet-4-5", name: "Claude Sonnet", contextWindow: 200 }],
    },
  ];

  it("keeps the original provider id and reports each unavailability reason", () => {
    const available = describeHistoryAttribution({ providerId: "provider-anthropic", model: "claude-sonnet-4-5" }, profiles);
    expect(available).toMatchObject({ providerId: "provider-anthropic", providerName: "Anthropic 官方", model: "claude-sonnet-4-5", modelName: "Claude Sonnet" });
    expect(available.availability.status).toBe("available");

    const disabled = describeHistoryAttribution(
      { providerId: "provider-anthropic", model: "claude-sonnet-4-5" },
      profiles.map((profile) => ({ ...profile, enabled: false })),
    );
    expect(disabled.providerId).toBe("provider-anthropic");
    expect(disabled.availability.status).toBe("disabled");

    const removedModel = describeHistoryAttribution({ providerId: "provider-anthropic", model: "claude-opus-4-1" }, profiles);
    expect(removedModel.availability.status).toBe("model-unavailable");
    expect(removedModel.providerName).toBe("Anthropic 官方");
  });

  it("reports a missing configuration instead of substituting another provider", () => {
    const missing = describeHistoryAttribution({ providerId: "provider-deleted", model: "whatever" }, profiles);
    expect(missing.providerId).toBe("provider-deleted");
    expect(missing.providerName).toBeNull();
    expect(missing.modelName).toBeNull();
    expect(missing.availability).toEqual({ status: "missing", message: expect.stringContaining("已不存在") });
  });

  it("reports availability without a model check when no model is named", () => {
    expect(resolveProviderAvailability({ exists: true, enabled: true })).toEqual({ status: "available" });
  });
});

describe("provider status view", () => {
  it("reports availability, auth presence and locatable issues without the reference value", () => {
    const profile: ProviderProfileRow = {
      id: "provider-openai",
      name: "团队网关",
      protocol: "openai-responses",
      baseUrl: "https://gateway.example.com/v1",
      authRef: "gateway-key",
      enabled: false,
      models: [{ id: "gpt-5", contextWindow: 200, maxOutput: 8 }],
    };
    const status = describeProviderStatus(profile);
    expect(status).toMatchObject({ id: "provider-openai", enabled: false, modelCount: 1, modelIds: ["gpt-5"], auth: "reference" });
    expect(status.availability.status).toBe("disabled");
    expect(status.issues).toEqual([]);

    const broken = describeProviderStatus({ ...profile, baseUrl: "" });
    expect(broken.issues).toEqual([{ code: "base-url-required", field: "baseUrl", message: "请填写服务地址" }]);

    const redacted = redactProviderProfile(profile);
    expect(redacted.authRefPresent).toBe(true);
    expect(JSON.stringify(redacted)).not.toContain("gateway-key");
  });
});
