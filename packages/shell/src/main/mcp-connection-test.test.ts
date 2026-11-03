import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { testMcpConnection, transportFor } from "./mcp-connection-test.js";

const FIXTURE = join(import.meta.dirname, "..", "..", "scripts", "fixtures", "mcp-stdio-fixture.mjs");

function stdioEntry(log: string) {
  return { type: "stdio", command: process.execPath, args: [FIXTURE], env: { MCP_FIXTURE_LOG: log } };
}

it("connects to a real stdio MCP server, lists its tools and disposes the child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pidock-mcp-test-"));
  const log = join(dir, "fixture.log");
  const result = await testMcpConnection(stdioEntry(log), { env: { ...process.env }, timeoutMs: 15_000 });
  expect(result.state).toBe("connected");
  expect(result.server).toMatchObject({ name: "pidock-mcp-fixture", version: "1.0.0" });
  expect(result.tools).toEqual([
    { name: "echo", description: "Echo the given text back, prefixed with `fixture:`." },
    { name: "mutate", description: "Pretend to change state; used to prove a non-read MCP call is gated." },
  ]);
  // The fixture really ran and served the handshake + tool list.
  const seen = readFileSync(log, "utf8");
  expect(seen).toContain("initialize");
  expect(seen).toContain("tools/list");
  // The dispose path closed the child's stdin, so the process exited on EOF.
  await vi.waitFor(() => {
    expect(() => readFileSync(log, "utf8")).not.toThrow();
  });
});

it("reports a disabled server without pretending it connected", async () => {
  const result = await testMcpConnection({ enabled: false, command: process.execPath, args: [FIXTURE] });
  expect(result).toEqual({ state: "disabled", tools: [], credentialRefs: [], durationMs: expect.any(Number) });
});

it("names a legacy SSE transport instead of probing it", async () => {
  const result = await testMcpConnection({ type: "sse", url: "https://example.com/sse" });
  expect(result.state).toBe("failed");
  expect(result.error?.code).toBe("mcp-transport-unsupported");
  expect(result.error?.message).toContain("SSE");
});

it("names a missing credential variable without leaking a value", async () => {
  const result = await testMcpConnection(
    { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${PIDOCK_MISSING_MCP_TOKEN}" } },
    { env: {} },
  );
  expect(result.error).toEqual({ code: "mcp-config-invalid", message: "headers.Authorization: environment variable PIDOCK_MISSING_MCP_TOKEN is not set" });
});

it("names a timeout from a server that never answers the handshake", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pidock-mcp-silent-"));
  const silent = join(dir, "silent.mjs");
  // A real process that starts, reads stdin, and never answers: the timeout is
  // produced by the client, and the child must still be gone afterwards.
  writeFileSync(silent, "process.stdin.resume(); setInterval(() => {}, 1000);\n");
  const result = await testMcpConnection({ command: process.execPath, args: [silent] }, { timeoutMs: 800 });
  expect(result.state).toBe("failed");
  expect(result.error?.code).toBe("mcp-timeout");
});

it("names an HTTP failure and an auth challenge", async () => {
  const server = createServer((request, response) => {
    if (request.headers["authorization"] === "Bearer good") {
      response.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="http://127.0.0.1/meta"' });
    } else {
      response.writeHead(401, { "www-authenticate": "Bearer" });
    }
    response.end("unauthorized");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const result = await testMcpConnection({ url: `http://127.0.0.1:${port}/mcp` }, { timeoutMs: 5000 });
    expect(result.state).toBe("failed");
    expect(result.error?.code).toBe("mcp-auth-required");
    expect(result.error?.message).toContain("401");
  } finally {
    server.close();
  }
});

it("builds no transport for an entry Pi would reject", () => {
  expect(() => transportFor({ type: "stdio", url: "https://example.com/mcp" })).toThrow(/mcp-transport-unsupported/);
  expect(() => transportFor({ type: "http", command: "node" })).toThrow(/mcp-transport-unsupported/);
  expect(() => transportFor({ enabled: false })).toThrow(/mcp-transport-unsupported/);
  expect(() => transportFor({ command: "node", args: "not-a-list" })).toThrow(/mcp-config-invalid/);
  expect(() => transportFor({ command: "node", env: { TOKEN: "!echo secret" } })).toThrow(/mcp-config-invalid/);
  expect(existsSync(FIXTURE)).toBe(true);
});
