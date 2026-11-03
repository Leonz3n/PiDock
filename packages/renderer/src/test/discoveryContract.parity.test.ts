import { describe, expect, it } from "vitest";
import {
  syncModelCandidates as shellSyncModelCandidates,
  type DiscoveryConnection,
  type ModelListTransport,
} from "../../../shell/src/main/provider-discovery.js";
import { parseDiscovery } from "../data/providerProfile";

/**
 * [#138] Renderer/main discovery-contract parity.
 *
 * The defect this file locks out: main answers `success|empty|failure|unsupported`
 * while the renderer used to accept `ok|empty|failed|unsupported|refused`, so
 * EVERY real answer (a successful one included) was read as `模型列表返回异常`
 * — successes rendered no candidate and network failures lost main's own
 * `无法连接端点` sentence.
 *
 * Main stays the authority: this test runs main's real `syncModelCandidates`
 * over its four outcomes and feeds each answer to the renderer's
 * `parseDiscovery`, then checks the renderer reads the status, the candidates
 * and the message verbatim. The fifth state is the one main never sends — an
 * unknown payload — which must be refused by name, never renamed into `failure`.
 * The renderer cannot import this module at runtime (no Node capability), so the
 * mirror is checked here, exactly like `composerAttachmentRules.parity.test.ts`.
 */
const connection: DiscoveryConnection = {
  protocol: "openai-completions",
  baseUrl: "https://models.example.test/v1",
  modelListPath: "/v1/models",
};
const answer = (transport: ModelListTransport) => shellSyncModelCandidates({ connection, transport });

describe("discovery contract parity with main", () => {
  it("reads a successful discovery into the same candidates and wording", async () => {
    const outcome = await answer(async () => ({ ok: true, ids: ["loopback-chat-7b", " loopback-fast ", "loopback-chat-7b", 42] }));
    const parsed = parseDiscovery(outcome);
    expect(parsed.status).toBe("success");
    expect(parsed.candidates).toEqual(["loopback-chat-7b", "loopback-fast"]);
    expect(parsed.message).toBe(outcome.message);
    expect(parsed).not.toHaveProperty("ignored");
    expect(parsed).not.toHaveProperty("fingerprint");
  });

  it("reads an empty list as its own state, not as a success and not as an error", async () => {
    const outcome = await answer(async () => ({ ok: true, ids: [] }));
    const parsed = parseDiscovery(outcome);
    expect(parsed.status).toBe("empty");
    expect(parsed.candidates).toEqual([]);
    expect(parsed.message).toBe(outcome.message);
  });

  it("reads a network failure with main's own 无法连接端点 sentence", async () => {
    const outcome = await answer(async () => ({ ok: false, message: "无法连接端点" }));
    const parsed = parseDiscovery(outcome);
    expect(parsed.status).toBe("failure");
    expect(parsed.candidates).toEqual([]);
    expect(parsed.message).toContain("无法连接端点");
    expect(parsed.message).toBe(outcome.message);
  });

  it("reads a declared-unsupported endpoint as unsupported, not as a failure", async () => {
    const declared = await answer(async () => ({ ok: false, message: "404 Not Found", unsupported: true }));
    const noPath = await shellSyncModelCandidates({ connection: { ...connection, modelListPath: null }, transport: async () => ({ ok: true, ids: [] }) });
    expect(parseDiscovery(declared).status).toBe("unsupported");
    expect(parseDiscovery(noPath).status).toBe("unsupported");
    expect(parseDiscovery(declared).message).toBe(declared.message);
  });

  it("refuses an answer main never sends instead of renaming it", () => {
    // The old renderer dialect — the exact strings that made every answer look
    // like a contract error — is now refused by name.
    for (const status of ["ok", "failed", "refused", "success ", ""]) {
      expect(() => parseDiscovery({ status, candidates: [], message: "1" })).toThrow("模型列表返回异常");
    }
    // `refused` is the page's own state for an unanswered attempt; it never
    // arrives through `parseDiscovery`.
    expect(() => parseDiscovery({ status: "refused", candidates: [], message: "桌面壳 Provider 接口不可用" })).toThrow("模型列表返回异常");
  });
});
