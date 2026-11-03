import { describe, expect, it } from "vitest";
import {
  EMPTY_MCP_DRAFT,
  draftFromView,
  draftRequest,
  mcpCall,
  parseMcpStatus,
  parseMcpTest,
  parsePairs,
} from "../data/mcpServers";

/**
 * [Pencil T15] #150 renderer contract. The page must not be able to widen what
 * main accepts: strict parsing rejects an unknown state, and the draft builder
 * emits only the exact keys of one transport.
 */

const status = {
  servers: [{
    name: "pidock-mcp-11111111-2222-3333-4444-555555555555", managed: true, label: "本地", transport: "stdio", enabled: true,
    state: "enabled", error: null, command: "node", args: ["a.mjs"], url: null, timeout: 30, exposure: "direct",
    credentialRefs: { env: ["TOKEN"], headers: [] },
  }],
  path: "/tmp/mcp.json",
  sessionBoundary: { appliesTo: "new-session", openSessionsMutated: false, note: "只影响新会话" },
};

describe("MCP renderer contract", () => {
  it("parses the bounded list and ignores no required field", () => {
    const parsed = parseMcpStatus(status);
    expect(parsed.servers[0]).toMatchObject({ name: status.servers[0]!.name, state: "enabled", credentialRefs: { env: ["TOKEN"] } });
    expect(() => parseMcpStatus({ ...status, servers: [{ ...status.servers[0], state: "running" }] })).toThrow("MCP Server 返回异常");
    expect(() => parseMcpStatus({ ...status, sessionBoundary: undefined })).toThrow("MCP 清单返回异常");
  });

  it("sends only the exact keys of one transport and never a name/path/file", () => {
    const stdio = draftRequest({ ...EMPTY_MCP_DRAFT, command: "node", argsText: "server.mjs\n--flag", envText: "TOKEN=$MCP_TOKEN", description: "本地" });
    expect(stdio).toEqual({ input: { transport: "stdio", exposure: "direct", timeout: 60, description: "本地", command: "node", args: ["server.mjs", "--flag"], env: { TOKEN: "$MCP_TOKEN" } } });
    const http = draftRequest({ ...EMPTY_MCP_DRAFT, transport: "http", url: "https://example.com/mcp", headersText: "Authorization: Bearer ${DOCS_TOKEN}" });
    expect(http).toEqual({ input: { transport: "http", exposure: "direct", timeout: 60, url: "https://example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } } });
    expect(JSON.stringify([stdio, http])).not.toMatch(/path|mcp\.json|agentDir|secretValue/);
  });

  it("refuses malformed form input instead of sending it", () => {
    expect(() => draftRequest({ ...EMPTY_MCP_DRAFT, command: "" })).toThrow("stdio Server 需要 command");
    expect(() => draftRequest({ ...EMPTY_MCP_DRAFT, transport: "http", url: "" })).toThrow("HTTP Server 需要 URL");
    expect(() => draftRequest({ ...EMPTY_MCP_DRAFT, command: "node", timeout: "0" })).toThrow("超时");
    expect(() => draftRequest({ ...EMPTY_MCP_DRAFT, command: "node", envText: "TOKEN" })).toThrow("NAME=value");
    expect(() => parsePairs("A: b", "=")).toThrow("NAME=value");
  });

  it("edits from a view with reference NAMES only", () => {
    const view = parseMcpStatus(status).servers[0]!;
    const draft = draftFromView(view);
    expect(draft.envText).toBe("TOKEN=");
    expect(JSON.stringify(draft)).not.toContain("Bearer");
    // A blank value means "keep the existing reference" in main; the form says so.
    expect(draftRequest(draft).input).toMatchObject({ env: { TOKEN: "" } });
  });

  it("parses a real test result and a real failure, and names a missing bridge", async () => {
    expect(parseMcpTest({ state: "connected", tools: [{ name: "echo", description: "Echo", readOnly: true }], credentialRefs: [], error: null })).toMatchObject({ state: "connected", tools: [{ name: "echo", readOnly: true }] });
    expect(parseMcpTest({ state: "failed", tools: [], credentialRefs: ["TOKEN"], error: { code: "mcp-timeout", message: "timeout" } })).toMatchObject({ state: "failed", credentialRefs: ["TOKEN"], error: { code: "mcp-timeout" } });
    // [#154] the Host's OWN connected result: no `error` key, tools as Pi lists
    // them (no description/readOnly annotation). The pane must render it.
    expect(parseMcpTest({ state: "connected", tools: [{ name: "echo" }], credentialRefs: [], durationMs: 12 })).toMatchObject({
      state: "connected", tools: [{ name: "echo", description: "", readOnly: false }], error: null,
    });
    await expect(mcpCall(undefined, { op: "list" })).rejects.toThrow("桌面壳 MCP 接口不可用");
    await expect(mcpCall({ mcpOp: async () => ({ ok: false, error: "MCP 配置尚未接入" }) }, { op: "list" })).rejects.toThrow("MCP 配置尚未接入");
  });
});
