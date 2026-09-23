import { describe, expect, it } from "vitest";
import {
  PROVIDER_PROTOCOLS,
  buildProtocolRequest,
  isProtocolDoneFrame,
  listProtocolDescriptors,
  normalizeProtocolFrame,
  protocolDescriptor,
  readProtocolTextFrame,
  readProtocolToolFrame,
  readProtocolUsage,
  resolveProtocol,
} from "./provider-protocol.js";

const tool = { name: "fs.read", description: "读取文件", inputSchema: { type: "object" } };

describe("provider protocol descriptors", () => {
  it("declares exactly the three supported protocols", () => {
    expect([...PROVIDER_PROTOCOLS]).toEqual(["anthropic-messages", "openai-responses", "openai-chat-completions"]);
    expect(listProtocolDescriptors().map((item) => item.id)).toEqual([...PROVIDER_PROTOCOLS]);
  });

  it("fails closed on an unknown protocol id", () => {
    expect(() => protocolDescriptor("gemini-generate")).toThrow(/protocol-unsupported/);
  });

  it("never picks a protocol from the vendor name or the address", () => {
    expect(resolveProtocol({ vendorName: "Anthropic", baseUrl: "https://api.anthropic.com" })).toEqual({
      ok: false,
      error: {
        code: "protocol-required",
        message: expect.stringContaining("不按供应商名或地址猜测协议"),
      },
    });
    expect(resolveProtocol({ protocol: "openai-chat-completions", vendorName: "Anthropic" })).toEqual({
      ok: true,
      protocol: "openai-chat-completions",
    });
    expect(resolveProtocol({ protocol: "nope" })).toEqual({
      ok: false,
      error: { code: "protocol-unsupported", message: "不支持的协议：nope" },
    });
  });
});

describe("protocol request shapes", () => {
  const turns = [
    { role: "user" as const, text: "第一个问题" },
    { role: "agent" as const, text: "第一个回答" },
  ];

  it("builds an Anthropic Messages request (system field, input_schema tools, max_tokens)", () => {
    const body = buildProtocolRequest("anthropic-messages", {
      model: "claude-sonnet-4-5",
      system: "你是助手",
      turns,
      tools: [tool],
      maxOutput: 4096,
    });
    expect(body["model"]).toBe("claude-sonnet-4-5");
    expect(body["max_tokens"]).toBe(4096);
    expect(body["system"]).toBe("你是助手");
    expect(body["stream"]).toBe(true);
    expect(body["messages"]).toEqual([
      { role: "user", content: [{ type: "text", text: "第一个问题" }] },
      { role: "assistant", content: [{ type: "text", text: "第一个回答" }] },
    ]);
    expect(body["tools"]).toEqual([{ name: "fs.read", description: "读取文件", input_schema: { type: "object" } }]);
  });

  it("builds an OpenAI Responses request (instructions + input, function tools, max_output_tokens)", () => {
    const body = buildProtocolRequest("openai-responses", {
      model: "gpt-5",
      system: "你是助手",
      turns,
      tools: [tool],
      maxOutput: 8192,
    });
    expect(body["max_output_tokens"]).toBe(8192);
    expect(body["instructions"]).toBe("你是助手");
    expect(body["input"]).toEqual([
      { role: "user", content: [{ type: "input_text", text: "第一个问题" }] },
      { role: "assistant", content: [{ type: "output_text", text: "第一个回答" }] },
    ]);
    expect(body["tools"]).toEqual([{ type: "function", name: "fs.read", description: "读取文件", parameters: { type: "object" } }]);
  });

  it("builds an OpenAI Chat Completions request (system as first message, function.parameters)", () => {
    const body = buildProtocolRequest("openai-chat-completions", {
      model: "qwen3-coder",
      system: "你是助手",
      turns,
      tools: [tool],
      maxOutput: 2048,
    });
    expect(body["max_tokens"]).toBe(2048);
    expect(body["messages"]).toEqual([
      { role: "system", content: "你是助手" },
      { role: "user", content: "第一个问题" },
      { role: "assistant", content: "第一个回答" },
    ]);
    expect(body["tools"]).toEqual([
      { type: "function", function: { name: "fs.read", description: "读取文件", parameters: { type: "object" } } },
    ]);
  });
  // [PiDock 11] #9: reasoning tiers are mapped per protocol and verified
  // separately — a tier the mapping does not name is never guessed elsewhere.
  it("maps the selected reasoning tier per protocol and refuses to invent one", () => {
    const anthropic = buildProtocolRequest("anthropic-messages", { model: "claude-sonnet-4-5", turns, maxOutput: 16384, reasoning: { tier: "medium" } });
    expect(anthropic["thinking"]).toEqual({ type: "enabled", budget_tokens: 8192 });
    // Unknown max output: `max_tokens > budget_tokens` cannot be guaranteed.
    expect(buildProtocolRequest("anthropic-messages", { model: "claude-sonnet-4-5", turns, reasoning: { tier: "medium" } })["thinking"]).toBeUndefined();
    // `off` is the absence of the block.
    expect(buildProtocolRequest("anthropic-messages", { model: "claude-sonnet-4-5", turns, maxOutput: 4096, reasoning: { tier: "off" } })["thinking"]).toBeUndefined();
    // An explicit budget wins; a budget that cannot fit under max_tokens is not sent.
    expect(buildProtocolRequest("anthropic-messages", { model: "claude-sonnet-4-5", turns, maxOutput: 4096, reasoning: { tier: "medium", budgetTokens: 2048 } })["thinking"]).toEqual({
      type: "enabled",
      budget_tokens: 2048,
    });
    expect(
      buildProtocolRequest("anthropic-messages", { model: "claude-sonnet-4-5", turns, maxOutput: 1024, reasoning: { tier: "medium", budgetTokens: 2048 } })["thinking"],
    ).toBeUndefined();

    expect(buildProtocolRequest("openai-responses", { model: "gpt-5", turns, reasoning: { tier: "low" } })["reasoning"]).toEqual({ effort: "low" });
    expect(buildProtocolRequest("openai-chat-completions", { model: "qwen3-coder", turns, reasoning: { tier: "high" } })["reasoning_effort"]).toBe("high");
    // Undeclared tier: no parameter is written for any protocol.
    expect(buildProtocolRequest("openai-responses", { model: "gpt-5", turns, reasoning: { tier: "turbo" } })["reasoning"]).toBeUndefined();
    expect(buildProtocolRequest("openai-chat-completions", { model: "qwen3-coder", turns, reasoning: { tier: "turbo" } })["reasoning_effort"]).toBeUndefined();
    // No reasoning input -> no reasoning field, for every protocol.
    for (const protocol of ["anthropic-messages", "openai-responses", "openai-chat-completions"]) {
      const body = buildProtocolRequest(protocol, { model: "m", turns });
      expect(body["thinking"]).toBeUndefined();
      expect(body["reasoning"]).toBeUndefined();
      expect(body["reasoning_effort"]).toBeUndefined();
    }
  });
});

describe("protocol stream frames", () => {
  it("reads Anthropic text, tool and done frames", () => {
    expect(readProtocolTextFrame("anthropic-messages", { type: "content_block_delta", delta: { text: "你好" } })).toBe("你好");
    expect(readProtocolTextFrame("anthropic-messages", { type: "message_start" })).toBeUndefined();
    expect(readProtocolToolFrame("anthropic-messages", { type: "input_json_delta", partial_json: '{"path"' })).toEqual({ arguments: '{"path"' });
    expect(isProtocolDoneFrame("anthropic-messages", { type: "message_stop" })).toBe(true);
    expect(readProtocolUsage("anthropic-messages", { usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 5 } })).toEqual({
      input: 12,
      output: 3,
      cacheRead: 5,
    });
  });

  it("reads OpenAI Responses text, tool and done frames", () => {
    expect(readProtocolTextFrame("openai-responses", { type: "response.output_text.delta", delta: "你好" })).toBe("你好");
    expect(readProtocolToolFrame("openai-responses", { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{}" })).toEqual({
      id: "fc_1",
      arguments: "{}",
    });
    expect(isProtocolDoneFrame("openai-responses", { type: "response.completed" })).toBe(true);
    expect(
      readProtocolUsage("openai-responses", {
        type: "response.completed",
        response: { usage: { input_tokens: 20, output_tokens: 4, input_tokens_details: { cached_tokens: 7 } } },
      }),
    ).toEqual({ input: 20, output: 4, cacheRead: 7 });
  });

  it("reads OpenAI Chat Completions text, tool and done frames", () => {
    expect(readProtocolTextFrame("openai-chat-completions", { choices: [{ delta: { content: "你好" } }] })).toBe("你好");
    expect(
      readProtocolToolFrame("openai-chat-completions", {
        choices: [{ delta: { tool_calls: [{ id: "call_1", function: { name: "fs.read", arguments: "{}" } }] } }],
      }),
    ).toEqual({ id: "call_1", name: "fs.read", arguments: "{}" });
    expect(isProtocolDoneFrame("openai-chat-completions", { choices: [{ finish_reason: "stop" }] })).toBe(true);
    expect(isProtocolDoneFrame("openai-chat-completions", { choices: [{ delta: { content: "x" } }] })).toBe(false);
    expect(
      readProtocolUsage("openai-chat-completions", { usage: { prompt_tokens: 9, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1 } } }),
    ).toEqual({ input: 9, output: 2, cacheRead: 1 });
  });

  it("reports no usage instead of a fabricated zero when the frame omits it", () => {
    expect(readProtocolUsage("anthropic-messages", { type: "message_stop" })).toBeNull();
    expect(readProtocolUsage("openai-chat-completions", { choices: [] })).toBeNull();
  });

  it("normalizes a recorded frame into the shared vocabulary", () => {
    expect(normalizeProtocolFrame("openai-chat-completions", { choices: [{ delta: { content: "片段" }, finish_reason: null }] })).toEqual({ text: "片段" });
    expect(normalizeProtocolFrame("anthropic-messages", { type: "message_stop", usage: { input_tokens: 1, output_tokens: 1 } })).toEqual({
      usage: { input: 1, output: 1, cacheRead: 0 },
      done: true,
    });
  });
});
