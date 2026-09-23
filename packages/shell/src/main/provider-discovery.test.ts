import { describe, expect, it, vi } from "vitest";
import { syncModelCandidates, type ModelListTransport } from "./provider-discovery.js";

const connection = { protocol: "openai-responses", baseUrl: "https://gateway.example.com/v1", modelListPath: "/v1/models" };

describe("syncModelCandidates", () => {
  it("returns candidates for a successful discovery without touching configured rows", async () => {
    const transport: ModelListTransport = vi.fn(async () => ({ ok: true as const, ids: ["gpt-5", " gpt-5-mini ", "gpt-5", 42, ""] }));
    const outcome = await syncModelCandidates({ connection, transport });
    expect(transport).toHaveBeenCalledWith({ baseUrl: connection.baseUrl, protocol: connection.protocol, path: "/v1/models" });
    expect(outcome.status).toBe("success");
    expect(outcome.candidates).toEqual(["gpt-5", "gpt-5-mini"]);
    expect(outcome.ignored).toBe(2);
    expect(outcome.message).toContain("忽略 2 个不可解析候选");
    expect(outcome.fingerprint).toBe("openai-responses::https://gateway.example.com/v1");
  });

  it("reports an unsupported connection without calling the transport", async () => {
    const transport = vi.fn(async () => ({ ok: true as const, ids: ["should-not-be-used"] }));
    const outcome = await syncModelCandidates({ connection: { ...connection, modelListPath: null }, transport });
    expect(transport).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      status: "unsupported",
      candidates: [],
      fingerprint: outcome.fingerprint,
      message: expect.stringContaining("未声明模型发现端点"),
      ignored: 0,
    });
  });

  it("reports an empty list as its own outcome", async () => {
    const outcome = await syncModelCandidates({ connection, transport: async () => ({ ok: true, ids: [] }) });
    expect(outcome.status).toBe("empty");
    expect(outcome.candidates).toEqual([]);
    expect(outcome.message).toContain("空模型列表");
  });

  it("reports a transport failure and a rejection without dropping configuration", async () => {
    const refused = await syncModelCandidates({ connection, transport: async () => ({ ok: false, message: "401 未授权" }) });
    expect(refused.status).toBe("failure");
    expect(refused.candidates).toEqual([]);
    expect(refused.message).toContain("401 未授权");
    expect(refused.message).toContain("已保留表单与已配置模型");

    const rejected = await syncModelCandidates({
      connection,
      transport: async () => {
        throw new Error("连接超时");
      },
    });
    expect(rejected.status).toBe("failure");
    expect(rejected.message).toContain("连接超时");
  });
});
