import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  buildMcpEntry,
  entryTransport,
  isManagedMcpName,
  managedMcpName,
  McpFailure,
  mcpJsonPath,
  NativeMcpFile,
  resolveMcpAgentDir,
} from "./native-mcp-config.js";

function file(existing?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "pidock-mcp-json-"));
  const managed = new NativeMcpFile(dir);
  if (existing !== undefined) writeFileSync(managed.path, typeof existing === "string" ? existing : JSON.stringify(existing, null, 2));
  return { dir, managed };
}

const stdio = { transport: "stdio" as const, command: "node", args: ["server.mjs"], env: { TOKEN: "$MCP_TOKEN" } };

it("writes the native mcp.json atomically, keeps a .bak and a private mode", () => {
  const { dir, managed } = file({ mcpServers: { docs: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } } }, autoEnableCodemode: false });
  const added = managed.add(stdio);
  expect(added.path).toBe(join(dir, "mcp.json"));
  expect(isManagedMcpName(added.name)).toBe(true);
  const written = JSON.parse(readFileSync(managed.path, "utf8"));
  // The user's own server, its credential reference and unknown root fields survive.
  expect(written.autoEnableCodemode).toBe(false);
  expect(written.mcpServers.docs).toEqual({ url: "https://example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } });
  expect(written.mcpServers[added.name]).toEqual({ type: "stdio", command: "node", args: ["server.mjs"], env: { TOKEN: "$MCP_TOKEN" } });
  // Atomic write leaves a backup of the previous file, not a temp file.
  expect(JSON.parse(readFileSync(join(dir, "mcp.json.bak"), "utf8")).mcpServers.docs).toBeDefined();
  expect(statSync(managed.path).mode & 0o777).toBe(0o600);
});

it("never touches an entry outside the ownership namespace", () => {
  const { managed } = file({ mcpServers: { filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] } } });
  expect(managed.list().map((row) => [row.name, row.managed])).toEqual([["filesystem", false]]);
  for (const action of [
    () => managed.update("filesystem", stdio),
    () => managed.setEnabled("filesystem", false),
    () => managed.remove("filesystem"),
  ]) {
    expect(action).toThrow(McpFailure);
    try { action(); } catch (error) { expect((error as McpFailure).code).toBe("mcp-not-managed"); }
  }
  expect(managed.entry("filesystem")).toEqual({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] });
});

it("enable/disable keeps the rest of the managed entry and the file readable by Pi", () => {
  const { managed } = file();
  const { name } = managed.add({ ...stdio, description: "Fixture", exposure: "direct", enabled: true });
  managed.setEnabled(name, false);
  const entry = managed.entry(name);
  expect(entry).toMatchObject({ command: "node", enabled: false, description: "Fixture", exposure: "direct", env: { TOKEN: "$MCP_TOKEN" } });
  expect(managed.list()[0]?.credentialRefs).toEqual({ env: ["TOKEN"], headers: [] });
});

it("removes only the managed server and reports whether it existed", () => {
  const { managed } = file({ mcpServers: { user: { command: "uvx", args: ["tools"] } } });
  const { name } = managed.add(stdio);
  expect(managed.remove(name)).toBe(true);
  expect(managed.remove(name)).toBe(false);
  expect(Object.keys(JSON.parse(readFileSync(managed.path, "utf8")).mcpServers)).toEqual(["user"]);
});

it("rejects legacy SSE and transport/type contradictions by name", () => {
  expect((() => { try { buildMcpEntry({ transport: "sse" as never }); } catch (error) { return (error as McpFailure).code; } })()).toBe("mcp-transport-unsupported");
  const { managed } = file();
  const { name } = managed.add({ transport: "http", url: "https://example.com/mcp" });
  managed.update(name, { transport: "http", url: "https://example.com/mcp" });
  expect(entryTransport(managed.entry(name))).toBe("http");
  expect(() => buildMcpEntry({ transport: "stdio" })).toThrow(/mcp-command-missing/);
  expect(() => buildMcpEntry({ transport: "stdio", command: "node server.mjs" })).toThrow(/mcp-command-invalid/);
  expect(() => buildMcpEntry({ transport: "http", url: "ftp://example.com/mcp" })).toThrow(/mcp-url-invalid/);
  expect(entryTransport({ type: "sse", url: "https://example.com/sse" })).toBe("invalid");
  expect(entryTransport({ enabled: false })).toBe("http");
});

it("refuses a literal credential instead of writing it to shared configuration", () => {
  expect(() => buildMcpEntry({ transport: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer sk-live-1234" } })).toThrow(/mcp-credential-literal/);
  const entry = buildMcpEntry({ transport: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } });
  expect(entry).toMatchObject({ headers: { Authorization: "Bearer ${DOCS_TOKEN}" } });
});

it("reports an unreadable file instead of overwriting it", () => {
  const { managed } = file("{ not json");
  expect(managed.read()).toEqual({ ok: false, error: "mcp-unreadable" });
  expect(() => managed.add(stdio)).toThrow(/mcp-unreadable/);
  expect(readFileSync(managed.path, "utf8")).toBe("{ not json");
});

it("resolves the agent directory from PIDOCK_AGENT_DIR and refuses a relative one", () => {
  expect(resolveMcpAgentDir({}, "/home/me")).toBe("/home/me/.pi/agent");
  expect(resolveMcpAgentDir({ PIDOCK_AGENT_DIR: "/tmp/agent" }, "/home/me")).toBe("/tmp/agent");
  expect(() => resolveMcpAgentDir({ PIDOCK_AGENT_DIR: "relative/dir" }, "/home/me")).toThrow(/mcp-agent-dir-invalid/);
  expect(mcpJsonPath("/tmp/agent")).toBe("/tmp/agent/mcp.json");
  expect(managedMcpName("11111111-2222-3333-4444-555555555555")).toBe("pidock-mcp-11111111-2222-3333-4444-555555555555");
});
