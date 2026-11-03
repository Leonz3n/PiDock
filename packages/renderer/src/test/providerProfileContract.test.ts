import { describe, expect, it } from "vitest";
import {
  EMPTY_PROVIDER_DRAFT,
  draftFromView,
  draftIssues,
  draftRequest,
  parseDiscovery,
  parseProbe,
  parseProviderStatus,
  type ProviderDraft,
  type ProviderView,
} from "../data/providerProfile";

/**
 * The renderer's half of the Provider contract — [PiDock T03] #138.
 *
 * main is authoritative (it validates again), but the form has to refuse the
 * same shapes before a request leaves, and the status parser must never turn an
 * unexpected reply into a configured-looking page. These tests pin the rules a
 * screenshot cannot show: unknown cost is not zero, an undeclared reasoning
 * level is not offered, and a key is only in the payload the user just typed.
 */

const row = (patch: Partial<ProviderDraft["models"][number]> = {}) =>
  ({ id: "m-1", name: "", contextWindow: "128000", maxTokens: "8192", reasoning: false, levels: [], cost: "", ...patch });

const draft = (patch: Partial<ProviderDraft> = {}): ProviderDraft => ({
  ...EMPTY_PROVIDER_DRAFT,
  name: "Gateway", baseUrl: "https://models.example.test/v1", apiKey: "sk-0123456789", models: [row()], modelId: "m-1", ...patch,
});

const view: ProviderView = {
  id: "p-11111111-2222-3333-4444-555555555555", name: "Gateway", notes: null, protocol: "openai-completions",
  baseUrl: "https://models.example.test/v1",
  models: [{ id: "m-1", name: "m-1", contextWindow: 128000, maxTokens: 8192, reasoning: true, reasoningLevels: ["off", "low", "high"], cost: null }],
  modelId: "m-1", contextWindow: 128000, maxTokens: 8192, credentialSource: "store", credentialAvailable: true,
  authRef: "p-11111111-2222-3333-4444-555555555555", generation: 1,
  native: { providerId: "pidock-p-11111111-2222-3333-4444-555555555555", state: "synced" },
};

const fields = (issues: { field: string }[]) => issues.map((issue) => issue.field);

describe("provider draft validation", () => {
  it("accepts a complete draft and sends only the fields main accepts", () => {
    expect(draftIssues(draft(), [], null)).toEqual([]);
    expect(draftRequest(draft({ notes: "  " }))).toEqual({
      profile: { name: "Gateway", notes: null, protocol: "openai-completions", baseUrl: "https://models.example.test/v1",
        credential: { kind: "store" }, models: [{ id: "m-1", name: "m-1", contextWindow: 128000, maxTokens: 8192, reasoning: false }], modelId: "m-1" },
      apiKey: "sk-0123456789",
    });
  });

  it("requires a name, a real http(s) base, and a credential", () => {
    const issues = draftIssues(draft({ name: " ", baseUrl: "ftp://host", apiKey: "" }));
    expect(fields(issues)).toEqual(["name", "baseUrl", "apiKey"]);
    expect(draftIssues(draft({ baseUrl: "https://user:pass@host/v1" })).map((issue) => issue.message))
      .toEqual(["Base URL 不能包含用户名或密码"]);
    // A stored key is a valid credential: leaving the field empty keeps it.
    expect(draftIssues(draft({ apiKey: "", hasStoredKey: true }))).toEqual([]);
    // An env reference is only a reference; no key field is required.
    expect(draftIssues(draft({ credentialKind: "env", apiKey: "", authRef: "PIDOCK_PROVIDER_X" }))).toEqual([]);
    expect(fields(draftIssues(draft({ credentialKind: "env", apiKey: "", authRef: "lowercase" })))).toEqual(["authRef"]);
  });

  it("bounds each model row and refuses output larger than the window", () => {
    // A zero window also makes the output too large for it: both are named.
    expect(fields(draftIssues(draft({ models: [row({ contextWindow: "0" })], modelId: "m-1" })))).toEqual(["models.0.contextWindow", "models.0.maxTokens"]);
    expect(fields(draftIssues(draft({ models: [row({ maxTokens: "999999" })], modelId: "m-1" })))).toEqual(["models.0.maxTokens"]);
    expect(fields(draftIssues(draft({ models: [row({ id: "" })], modelId: "" })))).toEqual(["models.0.id", "modelId"]);
    expect(fields(draftIssues(draft({ models: [row(), row({ id: "m-1" })] })))).toEqual(["models.1.id"]);
    // A reasoning map without the capability would offer levels Pi cannot honour.
    expect(fields(draftIssues(draft({ models: [row({ levels: ["high"] })] })))).toEqual(["models.0.reasoning"]);
    expect(draftIssues(draft({ models: [row({ reasoning: true, levels: ["high"] })] }))).toEqual([]);
    expect(fields(draftIssues(draft({ models: [row({ reasoning: true, levels: [] })] })))).toEqual(["models.0.reasoning"]);
    expect(fields(draftIssues(draft({ models: [row({ cost: "-1" })] })))).toEqual(["models.0.cost"]);
  });

  it("reports a duplicate name against the existing profiles by id", () => {
    expect(draftIssues(draft({ name: "Gateway" }), [view]).map((issue) => issue.message)).toEqual(["已存在同名供应商：Gateway"]);
    expect(draftIssues(draft({ id: view.id, name: "Gateway" }), [view])).toEqual([]);
  });

  it("keeps an unknown cost out of the payload instead of sending 0", () => {
    const payload = draftRequest(draft());
    expect(payload.profile["models"]).toEqual([{ id: "m-1", name: "m-1", contextWindow: 128000, maxTokens: 8192, reasoning: false }]);
    const priced = draftRequest(draft({ models: [row({ cost: "1.5" })] }));
    expect(priced.profile["models"]).toEqual([{ id: "m-1", name: "m-1", contextWindow: 128000, maxTokens: 8192, reasoning: false,
      cost: { input: 1.5, output: 0, cacheRead: 0, cacheWrite: 0 } }]);
  });

  it("sends the declared reasoning set verbatim, including whether 关闭 is supported", () => {
    const payload = draftRequest(draft({ models: [row({ reasoning: true, levels: ["high", "low", "off"] })], modelId: "m-1" }));
    expect(payload.profile["models"]).toEqual([{ id: "m-1", name: "m-1", contextWindow: 128000, maxTokens: 8192, reasoning: true,
      reasoningLevels: ["off", "low", "high"] }]);
    // A model that declares levels but not 关闭 never gets one added.
    expect(draftRequest(draft({ models: [row({ reasoning: true, levels: ["high"] })], modelId: "m-1" })).profile["models"])
      .toEqual([{ id: "m-1", name: "m-1", contextWindow: 128000, maxTokens: 8192, reasoning: true, reasoningLevels: ["high"] }]);
  });

  it("round-trips a view into a draft without the stored key", () => {
    const restored = draftFromView(view);
    expect(restored).toMatchObject({ id: view.id, name: "Gateway", credentialKind: "store", apiKey: "", hasStoredKey: true, modelId: "m-1" });
    expect(restored.models[0]).toEqual({ id: "m-1", name: "m-1", contextWindow: "128000", maxTokens: "8192", reasoning: true, levels: ["off", "low", "high"], cost: "" });
  });
});

describe("provider status parsing", () => {
  it("reads a full status and keeps unknown cost as null", () => {
    const status = parseProviderStatus({ state: "configured", profileId: view.id, modelId: "m-1", thinkingLevel: "high", generation: 3,
      profiles: [view], nativePath: "/home/u/.pi/agent/models.json", secretsAvailable: true });
    expect(status).toMatchObject({ state: "configured", modelId: "m-1", thinkingLevel: "high", nativePath: "/home/u/.pi/agent/models.json" });
    expect(status.profiles[0]?.models[0]?.cost).toBeNull();
  });

  it("refuses a shape a page must not render as configured", () => {
    expect(() => parseProviderStatus({ state: "ready", profileId: null, generation: null, profiles: [] })).toThrow("Provider 状态返回异常");
    expect(() => parseProviderStatus({ state: "configured", profileId: null, generation: null, profiles: [{ ...view, generation: 0 }] })).toThrow();
    expect(() => parseProviderStatus({ state: "configured", profileId: null, generation: null,
      profiles: [{ ...view, models: [{ ...view.models[0]!, reasoningLevels: ["ultra"] }] }] })).toThrow("Provider 模型返回异常");
    expect(() => parseProviderStatus({ state: "configured", profileId: null, generation: null,
      profiles: [{ ...view, models: [{ ...view.models[0]!, cost: { input: 1 } }] }] })).toThrow("Provider 模型价格返回异常");
    expect(() => parseProviderStatus({ state: "configured", profileId: null, generation: null,
      profiles: [{ ...view, native: { providerId: "pidock-x", state: "whatever" } }] })).toThrow("Provider 原生配置状态返回异常");
  });

  it("reads a legacy single-model profile as declared-unknown, not as a guess", () => {
    const status = parseProviderStatus({ state: "not-configured", profileId: null, generation: null, profiles: [{
      id: view.id, name: "Old", baseUrl: "https://old.test/v1", modelId: "old-model", contextWindow: 32000, maxTokens: 4096,
      authRef: "PIDOCK_PROVIDER_OLD", generation: 1, credentialAvailable: false,
    }] });
    expect(status.profiles[0]).toMatchObject({ protocol: "openai-completions", credentialSource: "env", credentialAvailable: false,
      models: [{ id: "old-model", reasoning: false, reasoningLevels: ["off"], cost: null }], native: { state: "never-written" } });
  });

  it("parses discovery and probe outcomes strictly", () => {
    expect(parseDiscovery({ status: "ok", candidates: ["a"], message: "1" })).toEqual({ status: "ok", candidates: ["a"], message: "1" });
    expect(() => parseDiscovery({ status: "ok", candidates: [1], message: "" })).toThrow("模型列表返回异常");
    expect(parseProbe({ ok: false, code: "timeout", message: "超时", status: null, latencyMs: null }))
      .toEqual({ ok: false, code: "timeout", message: "超时", status: null, latencyMs: null });
    expect(() => parseProbe({ ok: true, code: "ok", message: "", status: -1, latencyMs: 1 })).toThrow("连通性测试返回异常");
  });
});
