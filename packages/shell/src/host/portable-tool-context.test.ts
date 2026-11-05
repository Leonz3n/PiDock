import { expect, it } from "vitest";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { portableToolContext } from "./portable-tool-context.js";

const assistant = (name: string): AssistantMessage => ({ role: "assistant", api: "openai-responses", provider: "fixture", model: "fixture",
  content: [{ type: "toolCall", id: "call-1", name, arguments: { name: "fs.read", type: "toolCall" } }],
  stopReason: "toolUse", timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

it("maps declaration deltas, history and streamed calls without changing user content, arguments or domain identities", () => {
  const tool = { name: "fs.read", description: "Read", parameters: { type: "object", properties: { name: { const: "fs.read" } } } };
  const input: Context = { tools: [tool], messages: [
    { role: "system", content: "fs.read is an internal label", toolsAdded: [tool], toolsRemoved: [{ name: "old.tool" }], timestamp: 0 },
    { role: "user", content: "fs.read", timestamp: 0 }, assistant("fs.read"),
    { role: "toolResult", toolCallId: "call-1", toolName: "fs.read", content: [{ type: "text", text: "fs.read" }], isError: false, timestamp: 0 },
  ] };
  const before = JSON.stringify(input);
  const portable = portableToolContext(input);
  const alias = portable.context.tools![0]!.name;
  expect(alias).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  expect(portable.context.messages[0]).toMatchObject({ toolsAdded: [{ name: alias }], toolsRemoved: [{ name: expect.stringMatching(/^[a-zA-Z0-9_-]{1,64}$/) }] });
  expect(portable.context.messages[1]).toEqual(input.messages[1]);
  expect(portable.context.messages[2]).toMatchObject({ content: [{ name: alias, arguments: { name: "fs.read", type: "toolCall" } }] });
  expect(portable.context.messages[3]).toMatchObject({ toolName: alias, content: [{ text: "fs.read" }] });
  expect(portable.context.tools![0]!.parameters).toEqual(tool.parameters);
  const partial = assistant(alias);
  for (const event of [
    { type: "toolcall_start" as const, contentIndex: 0, partial },
    { type: "toolcall_delta" as const, contentIndex: 0, delta: '{"name":"fs.read"}', partial },
    { type: "toolcall_end" as const, contentIndex: 0, toolCall: partial.content[0] as Extract<AssistantMessage["content"][number], { type: "toolCall" }>, partial },
    { type: "done" as const, reason: "toolUse" as const, message: partial },
  ]) {
    const restored = portable.restore(event);
    expect(JSON.stringify(restored)).not.toContain(alias);
    expect(JSON.stringify(restored)).toContain('"name":"fs.read"');
  }
  expect(JSON.stringify(input)).toBe(before);
  expect(portableToolContext(input).context.tools![0]!.name).toBe(alias);
});

it("refuses collisions with existing portable names instead of routing to the wrong tool", () => {
  const tool = { name: "fs.read", description: "read", parameters: {} };
  const alias = portableToolContext({ tools: [tool], messages: [] }).context.tools![0]!.name;
  expect(() => portableToolContext({ tools: [tool, { ...tool, name: alias }], messages: [] })).toThrow("provider-tool-name-conflict");
});
