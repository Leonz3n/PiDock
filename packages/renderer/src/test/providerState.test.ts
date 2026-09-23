import { describe, expect, it } from "vitest";
import {
  buildModelPickerGroups,
  describeContextDisplay,
  describeHistoryAttribution,
  describeProviderAvailability,
  describeProviderStatus,
  evaluateSessionModelSwitch,
  evaluateThinkingSelection,
  firstSelectablePickerIndex,
  flattenPickerGroups,
  followModelName,
  followModelNameOnIdChange,
  formatTokens,
  isAuthReference,
  isSecretLike,
  modelDisplayName,
  movePickerCursor,
  resolveSessionThinking,
  syncModelCandidates,
  validateProviderDraft,
  type DiscoveryTransport,
} from "../data/providerState";
import type { ProviderProfile } from "../data/types";

const ANTHROPIC: ProviderProfile = {
  id: "provider-anthropic",
  name: "Anthropic 官方",
  protocol: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  authRef: "anthropic-key",
  enabled: true,
  models: [
    { id: "claude-sonnet-4-5", name: "Claude Sonnet", contextWindow: 200, maxOutput: 8, supportsImages: true },
    { id: "claude-haiku-4-5", contextWindow: 200 },
  ],
};

const LOCAL: ProviderProfile = {
  id: "provider-local",
  name: "本地推理",
  protocol: "openai-chat-completions",
  baseUrl: "http://127.0.0.1:11434/v1",
  enabled: true,
  models: [{ id: "本地 Qwen", contextWindow: 32, thinking: { mode: "custom", levels: ["off", "low", "medium"], default: "low" } }],
};

const DISABLED: ProviderProfile = { ...LOCAL, id: "provider-off", name: "已停用网关", enabled: false };

describe("provider draft validation", () => {
  it("reports every locatable issue with its field", () => {
    const issues = validateProviderDraft({
      name: "  ",
      protocol: "",
      baseUrl: "https://user:pass@gateway.example.com/v1",
      authRef: "sk-live-abcdefghijklmnop",
      models: [
        { id: "gpt-5", contextWindow: 8, maxOutput: 9 },
        { id: " gpt-5 ", contextWindow: 0 },
        { id: "", contextWindow: 8 },
      ],
    });
    expect(issues.map((issue) => issue.code)).toEqual([
      "provider-name-required",
      "protocol-required",
      "credentials-in-url",
      "auth-ref-looks-like-secret",
      "max-output-exceeds-window",
      "model-id-duplicate",
      "context-window-invalid",
      "model-id-required",
    ]);
    expect(issues.find((issue) => issue.code === "max-output-exceeds-window")?.field).toBe("models.gpt-5.maxOutput");
  });

  it("accepts a valid draft and keeps an auth reference distinct from a secret", () => {
    expect(validateProviderDraft({ name: "网关", protocol: "openai-responses", baseUrl: "https://gw/v1", authRef: "gw-key", models: [{ id: "gpt-5", contextWindow: 8 }] })).toEqual(
      [],
    );
    expect(isSecretLike("sk-live-abcdefghijklmnop")).toBe(true);
    expect(isSecretLike("A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6")).toBe(true);
    expect(isAuthReference("has space")).toBe(false);
    expect(isAuthReference("gw-key")).toBe(true);
  });

  it("marks thinking problems on the model row", () => {
    const issues = validateProviderDraft({
      name: "网关",
      protocol: "openai-responses",
      baseUrl: "https://gw/v1",
      models: [{ id: "gpt-5", contextWindow: 8, thinking: { mode: "custom", levels: ["off", "off"], default: "high" } }],
    });
    expect(issues.map((issue) => issue.code)).toEqual(["thinking-level-duplicate", "thinking-default-not-in-levels"]);
  });
});

describe("display name follow", () => {
  it("follows, stops on edit, restores when cleared and re-mirrors on id change", () => {
    expect(followModelName("gpt-5", "")).toEqual({ name: undefined, followsId: true });
    expect(followModelName("gpt-5", "主力模型")).toEqual({ name: "主力模型", followsId: false });
    expect(followModelName("gpt-5", "gpt-5")).toEqual({ name: undefined, followsId: true });
    expect(followModelNameOnIdChange({ name: undefined, followsId: true })).toEqual({ name: undefined, followsId: true });
    expect(followModelNameOnIdChange({ name: "主力模型", followsId: false })).toEqual({ name: "主力模型", followsId: false });
    expect(modelDisplayName({ id: "gpt-5" })).toBe("gpt-5");
    expect(modelDisplayName({ id: "gpt-5", name: "主力模型" })).toBe("主力模型");
  });
});

describe("model list sync", () => {
  const transport: DiscoveryTransport = async ({ protocol }) => ({
    ok: true,
    ids: protocol === "openai-chat-completions" ? ["qwen3-coder", "qwen3-coder", " x "] : ["gpt-5", "gpt-5-mini"],
  });

  it("returns candidates only, deduped, from the provider's own connection", async () => {
    const view = await syncModelCandidates({ connection: { protocol: "openai-responses", baseUrl: "https://gw/v1" }, transport });
    expect(view).toMatchObject({ status: "success", candidates: ["gpt-5", "gpt-5-mini"] });
    expect(view.fingerprint).toBe("openai-responses::https://gw/v1");
  });

  it("covers empty, failure, rejection and unsupported discovery", async () => {
    expect((await syncModelCandidates({ connection: { protocol: "openai-responses", baseUrl: "https://gw/v1" }, transport: async () => ({ ok: true, ids: [] }) })).status).toBe("empty");
    const failed = await syncModelCandidates({ connection: { protocol: "openai-responses", baseUrl: "https://gw/v1" }, transport: async () => ({ ok: false, message: "401 未授权" }) });
    expect(failed.status).toBe("failure");
    expect(failed.message).toContain("401 未授权");
    expect(failed.message).toContain("已保留表单与已配置模型");
    const rejected = await syncModelCandidates({
      connection: { protocol: "openai-responses", baseUrl: "https://gw/v1" },
      transport: async () => {
        throw new Error("连接超时");
      },
    });
    expect(rejected.status).toBe("failure");
    expect(rejected.message).toContain("连接超时");
    // A protocol without a discovery endpoint reports unsupported without a request.
    const unsupported = await syncModelCandidates({
      connection: { protocol: "custom-proto", baseUrl: "https://gw/v1" },
      transport: async () => {
        throw new Error("should not run");
      },
    });
    expect(unsupported.status).toBe("unsupported");
    expect(unsupported.candidates).toEqual([]);
  });
});

describe("reasoning tier selection", () => {
  it("invalidates a stale preference instead of coercing it", () => {
    expect(resolveSessionThinking(LOCAL.models[0], "medium")).toEqual({ catalog: "declared", level: "medium", source: "session" });
    expect(resolveSessionThinking(LOCAL.models[0], "max")).toEqual({ catalog: "declared", level: "low", source: "model-default", stale: "max" });
    expect(resolveSessionThinking(ANTHROPIC.models[1], "high")).toEqual({ catalog: "catalog-unknown", level: "high", source: "session" });
    expect(resolveSessionThinking(undefined, undefined)).toEqual({ catalog: "catalog-unknown", level: "", source: "none" });
  });

  it("refuses an undeclared tier and a clear the model cannot express", () => {
    expect(evaluateThinkingSelection({ thinking: LOCAL.models[0].thinking, level: "max" })).toEqual({
      ok: false,
      error: { code: "thinking-level-not-declared", message: "模型未声明该推理档位：max" },
    });
    expect(evaluateThinkingSelection({ thinking: { mode: "custom", levels: ["low", "medium"], default: "low" }, level: "" })).toEqual({
      ok: false,
      error: { code: "thinking-required", message: "该模型不支持关闭推理，请选择已声明档位" },
    });
    expect(evaluateThinkingSelection({ thinking: LOCAL.models[0].thinking, level: "" })).toEqual({ ok: true, level: "off" });
    expect(evaluateThinkingSelection({ thinking: { mode: "none", levels: [], default: "" }, level: "low" })).toEqual({
      ok: false,
      error: { code: "thinking-unsupported", message: "当前模型不支持推理档位" },
    });
  });
});

describe("session model switch gate", () => {
  const target = { provider: ANTHROPIC, model: ANTHROPIC.models[1] };

  it("refuses a switch while the round/tool/confirmation is running", () => {
    const decision = evaluateSessionModelSwitch({ running: true, busyLabel: "等待确认中", ...target, contextUsed: 10, contextSource: "actual" });
    expect(decision).toEqual({ ok: false, refusal: { code: "busy-round", message: expect.stringContaining("等待确认中") } });
  });

  it("refuses a disabled provider and an unknown model", () => {
    expect(evaluateSessionModelSwitch({ running: false, provider: DISABLED, model: LOCAL.models[0], contextUsed: 1, contextSource: "actual" })).toMatchObject({
      ok: false,
      refusal: { code: "provider-disabled" },
    });
    expect(evaluateSessionModelSwitch({ running: false, contextUsed: 1, contextSource: "actual" })).toMatchObject({
      ok: false,
      refusal: { code: "model-unavailable" },
    });
  });

  it("never treats an unknown window or a pending occupancy as a zero pass", () => {
    expect(
      evaluateSessionModelSwitch({ running: false, provider: ANTHROPIC, model: { id: "x", contextWindow: 0 }, contextUsed: 0, contextSource: "actual" }),
    ).toMatchObject({ ok: false, refusal: { code: "context-window-unknown" } });
    for (const source of ["pending", "unknown"] as const) {
      expect(evaluateSessionModelSwitch({ running: false, ...target, contextUsed: 1, contextSource: source })).toMatchObject({
        ok: false,
        refusal: { code: "context-occupancy-unknown" },
      });
    }
  });

  it("applies strict bounds with unformatted token numbers in the refusal", () => {
    const over = evaluateSessionModelSwitch({ running: false, provider: ANTHROPIC, model: { id: "small", contextWindow: 200 }, contextUsed: 201, contextSource: "actual" });
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.refusal.code).toBe("context-over-limit");
      expect(over.refusal.message).toContain("201000 Tokens");
      expect(over.refusal.message).toContain("200000 Tokens");
      expect(over.refusal.occupancy).toBe(201);
      expect(over.refusal.limit).toBe(200);
    }
    expect(evaluateSessionModelSwitch({ running: false, ...target, contextUsed: 200, contextSource: "actual" })).toEqual({ ok: true });
    expect(evaluateSessionModelSwitch({ running: false, ...target, contextUsed: 199, contextSource: "estimated" })).toEqual({ ok: true });
  });
});

describe("availability and history attribution", () => {
  it("keeps the original provider/model and reports the reason", () => {
    expect(describeProviderAvailability({ provider: ANTHROPIC, modelId: "claude-haiku-4-5" })).toEqual({ availability: "available" });
    expect(describeProviderAvailability({ provider: DISABLED })).toMatchObject({ availability: "disabled" });
    expect(describeProviderAvailability({ provider: ANTHROPIC, modelId: "gone" })).toMatchObject({ availability: "model-unavailable" });
    expect(describeProviderAvailability({})).toMatchObject({ availability: "missing" });

    expect(describeHistoryAttribution([ANTHROPIC], { providerId: "provider-anthropic", model: "claude-haiku-4-5" })).toMatchObject({
      providerId: "provider-anthropic",
      providerName: "Anthropic 官方",
      model: "claude-haiku-4-5",
      modelName: "claude-haiku-4-5",
      availability: "available",
    });
    const missing = describeHistoryAttribution([ANTHROPIC], { providerId: "provider-deleted", model: "x" });
    expect(missing).toMatchObject({ providerId: "provider-deleted", providerName: null, modelName: null, availability: "missing" });
  });

  it("reports status with auth presence and locatable issues, never the reference value", () => {
    const status = describeProviderStatus(ANTHROPIC);
    expect(status).toMatchObject({ availability: "available", auth: "reference", issues: [] });
    const broken = describeProviderStatus({ ...ANTHROPIC, baseUrl: "" });
    expect(broken.issues).toEqual([{ code: "base-url-required", field: "baseUrl", message: "请填写服务地址" }]);
    expect(JSON.stringify(status)).not.toContain("anthropic-key");
  });
});

describe("context display", () => {
  it("shows unformatted tokens, an estimate marker and a remaining estimate", () => {
    const display = describeContextDisplay({ used: 214, window: 200, source: "estimated" });
    expect(display).toMatchObject({ window: 200, used: 214, source: "estimated", marker: "估算", percent: 107, remainingTokens: 0 });
    expect(display.occupancyLabel).toBe("占用 214000 Tokens · 上限 200000 Tokens · 107.0% · 估算");
  });

  it("marks a pending reading and refuses to invent a percentage for an unknown window", () => {
    const pending = describeContextDisplay({ used: 9.2, window: 200, source: "pending" });
    expect(pending.marker).toBe("待更新");
    const unknownWindow = describeContextDisplay({ used: 9.2, window: 0, source: "actual" });
    expect(unknownWindow).toMatchObject({ percent: null, remainingTokens: null });
    expect(unknownWindow.occupancyLabel).toContain("上限未知");
    expect(formatTokens(214000)).toBe("214000");
  });
});

describe("model picker", () => {
  const groups = buildModelPickerGroups({
    providers: [ANTHROPIC, LOCAL, DISABLED],
    currentProviderId: "provider-anthropic",
    currentModelId: "claude-sonnet-4-5",
    contextUsed: 24.8,
    contextSource: "actual",
  });

  it("groups by provider, marks the current selection and shows capacity + image capability per model", () => {
    expect(groups.map((group) => group.providerId)).toEqual(["provider-anthropic", "provider-local", "provider-off"]);
    const sonnet = groups[0].models.find((model) => model.id === "claude-sonnet-4-5");
    expect(sonnet).toMatchObject({ label: "Claude Sonnet", contextWindow: 200, maxOutput: 8, supportsImages: true, selected: true });
    expect(sonnet?.disabledReason).toBeUndefined();
    // Anthropic models declare no tiers, and capabilities come from the row only.
    expect(groups[0].models.find((model) => model.id === "claude-haiku-4-5")).toMatchObject({ supportsImages: false, selected: false });
  });

  it("greys an over-limit target with its numbers and a disabled provider with its reason", () => {
    const tight = buildModelPickerGroups({ providers: [LOCAL], contextUsed: 40, contextSource: "actual" });
    expect(tight[0].models[0].disabledReason).toContain("40000 Tokens");
    expect(tight[0].models[0].disabledReason).toContain("32000 Tokens");
    expect(groups[2].models[0].disabledReason).toBe("Provider 已停用");
  });

  it("filters by provider name/id and by model id/display name", () => {
    const byName = buildModelPickerGroups({ providers: [ANTHROPIC, LOCAL], query: "本地", contextUsed: 1, contextSource: "actual" });
    expect(byName).toHaveLength(1);
    expect(byName[0].models.map((model) => model.id)).toEqual(["本地 Qwen"]);
    const byModelName = buildModelPickerGroups({ providers: [ANTHROPIC], query: "sonnet", contextUsed: 1, contextSource: "actual" });
    expect(byModelName[0].models.map((model) => model.id)).toEqual(["claude-sonnet-4-5"]);
    const byProviderId = buildModelPickerGroups({ providers: [ANTHROPIC, LOCAL], query: "provider-local", contextUsed: 1, contextSource: "actual" });
    expect(byProviderId.map((group) => group.providerId)).toEqual(["provider-local"]);
  });

  it("moves the cursor with wrap-around and skips greyed rows for the first pick", () => {
    expect(movePickerCursor(3, 0, 1)).toBe(1);
    expect(movePickerCursor(3, 2, 1)).toBe(0);
    expect(movePickerCursor(3, 0, -1)).toBe(2);
    expect(movePickerCursor(0, 0, 1)).toBe(-1);
    const rows = flattenPickerGroups(groups);
    expect(rows.length).toBeGreaterThan(3);
    expect(firstSelectablePickerIndex(rows)).toBe(0);
    const blockedRows = flattenPickerGroups(buildModelPickerGroups({ providers: [DISABLED, LOCAL], contextUsed: 1, contextSource: "actual" }));
    expect(blockedRows[0].model.disabledReason).toBe("Provider 已停用");
    expect(firstSelectablePickerIndex(blockedRows)).toBe(1);
  });
});
