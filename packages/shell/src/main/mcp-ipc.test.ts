/**
 * Exact-key MCP operations for the capability pane — [Pencil T15] #150.
 *
 * Every assertion is against the real `NativeMcpFile` and, for `test`, the real
 * stdio fixture child process. The renderer-facing view is checked for the one
 * property that matters most: a credential reference can be *named* but its
 * value never crosses the boundary.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { McpWiring, MCP_SESSION_BOUNDARY } from "./mcp-ipc.js";
import { NativeMcpFile } from "./native-mcp-config.js";
import { TrustDomainViolation } from "./trust-domain.js";

const roots: string[] = [];
afterEach(() => { roots.splice(0); });

const FIXTURE = join(import.meta.dirname, "..", "..", "scripts", "fixtures", "mcp-stdio-fixture.mjs");

function wiring(existing?: Record<string, unknown>, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pidock-mcp-ipc-"));
  roots.push(dir);
  const file = new NativeMcpFile(dir);
  if (existing !== undefined) writeFileSync(file.path, JSON.stringify(existing, null, 2));
  return { dir, file, mcp: new McpWiring(file, env) };
}

it("lists every server with a real state and names the session boundary", async () => {
  const { dir, mcp } = wiring({
    mcpServers: {
      handwritten: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } },
      broken: { type: "sse", url: "https://example.com/sse" },
    },
    autoEnableCodemode: false,
  }, { MCP_TOKEN: "present-value" });
  const added = await mcp.perform({ op: "save", input: { transport: "stdio", command: "node", args: ["server.mjs"], env: { TOKEN: "$MCP_TOKEN" } } }) as { name: string };
  const disabled = await mcp.perform({ op: "save", input: { transport: "stdio", command: "node", enabled: false } }) as { name: string };
  const status = await mcp.perform({ op: "list" }) as ReturnType<McpWiring["list"]>;
  expect(status.path).toBe(join(dir, "mcp.json"));
  expect(status.sessionBoundary).toEqual(MCP_SESSION_BOUNDARY);
  const rows = Object.fromEntries(status.servers.map((server) => [server.name, server]));
  // A referenced variable that is not in main's environment is a real state:
  // Pi would fail to connect, so the row says so by name.
  expect(rows["handwritten"]).toMatchObject({ managed: false, transport: "http", state: "error", error: { code: "mcp-config-invalid" } });
  // Only the reference NAME is reported; the header value is nowhere in the view.
  expect(rows["handwritten"]!.credentialRefs).toEqual({ env: [], headers: ["Authorization"] });
  expect(JSON.stringify(status)).not.toContain("Bearer");
  expect(JSON.stringify(status)).not.toContain("present-value");
  expect(rows["broken"]).toMatchObject({ state: "error", error: { code: "mcp-transport-unsupported" } });
  expect(rows[added.name]).toMatchObject({ managed: true, transport: "stdio", state: "enabled", command: "node", args: ["server.mjs"], exposure: "codemode" });
  expect(rows[added.name]!.credentialRefs).toEqual({ env: ["TOKEN"], headers: [] });
  expect(rows[disabled.name]).toMatchObject({ managed: true, state: "disabled", enabled: false });
});

it("refuses a submission Pi would reject and writes nothing", async () => {
  const { file, mcp } = wiring();
  await expect(mcp.perform({ op: "save", input: { transport: "stdio", command: "node --inspect server.mjs" } })).rejects.toMatchObject({ code: "mcp-command-invalid" });
  await expect(mcp.perform({ op: "save", input: { transport: "http", url: "ftp://example.com" } })).rejects.toMatchObject({ code: "mcp-url-invalid" });
  await expect(mcp.perform({ op: "save", input: { transport: "stdio", command: "node", headers: { Authorization: "sk-literal-secret" } } })).rejects.toMatchObject({ code: "mcp-servers-invalid" });
  await expect(mcp.perform({ op: "save", input: { transport: "stdio", command: "node", timeout: 0 } })).rejects.toMatchObject({ code: "mcp-timeout-invalid" });
  // A literal secret under a secret header is refused by name.
  await expect(mcp.perform({ op: "save", input: { transport: "http", url: "https://example.com/mcp", headers: { Authorization: "sk-literal-secret" } } })).rejects.toMatchObject({ code: "mcp-credential-literal" });
  expect(existsSync(file.path)).toBe(false);
});

it("accepts only the exact-key operation payloads", async () => {
  const { mcp } = wiring();
  // A path, a file or an unknown op is a payload violation, not a hint main honours.
  await expect(mcp.perform({ op: "list", path: "/tmp/mcp.json" })).rejects.toBeInstanceOf(TrustDomainViolation);
  await expect(mcp.perform({ op: "save", input: { transport: "stdio", command: "node" }, path: "/tmp/mcp.json" })).rejects.toBeInstanceOf(TrustDomainViolation);
  await expect(mcp.perform({ op: "remove", name: "handwritten", confirmed: true })).rejects.toBeInstanceOf(TrustDomainViolation);
  await expect(mcp.perform({ op: "shell" })).rejects.toBeInstanceOf(TrustDomainViolation);
  await expect(mcp.perform({ op: "test" })).rejects.toBeInstanceOf(TrustDomainViolation);
});

it("removes only a managed server and leaves every hand-written entry value-for-value", async () => {
  const { file, mcp } = wiring({
    mcpServers: { handwritten: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } } },
    autoEnableCodemode: false,
  });
  const added = await mcp.perform({ op: "save", input: { transport: "stdio", command: "node", args: ["server.mjs"] } }) as { name: string };
  await expect(mcp.perform({ op: "remove", name: "handwritten" })).rejects.toMatchObject({ code: "mcp-not-managed" });
  await mcp.perform({ op: "remove", name: added.name });
  const written = JSON.parse(readFileSync(file.path, "utf8"));
  expect(written.mcpServers.handwritten).toEqual({ url: "https://example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } });
  expect(written.autoEnableCodemode).toBe(false);
  expect(written.mcpServers[added.name]).toBeUndefined();
});

it("removes only a managed server (second removal is a named miss)", async () => {
  const { mcp } = wiring();
  const added = await mcp.perform({ op: "save", input: { transport: "stdio", command: "node" } }) as { name: string };
  await mcp.perform({ op: "remove", name: added.name });
  await expect(mcp.perform({ op: "remove", name: added.name })).rejects.toMatchObject({ code: "mcp-not-found" });
});

it("enable and disable change only the flag and keep references and unknown fields", async () => {
  const { file, mcp } = wiring();
  (mcp as unknown as { env: Record<string, string> }).env = { MCP_TOKEN: "present-value" };
  const added = await mcp.perform({ op: "save", input: { transport: "stdio", command: "node", env: { TOKEN: "$MCP_TOKEN" }, exposure: "direct", description: "本地工具" } }) as { name: string };
  // Simulate a field this app does not model: it must survive a toggle.
  const written = JSON.parse(readFileSync(file.path, "utf8"));
  written.mcpServers[added.name].futureField = { nested: true };
  writeFileSync(file.path, JSON.stringify(written, null, 2));

  const disabled = await mcp.perform({ op: "disable", name: added.name }) as { server: { enabled: boolean; state: string } };
  expect(disabled.server).toMatchObject({ enabled: false, state: "disabled" });
  const enabled = await mcp.perform({ op: "enable", name: added.name }) as { server: { enabled: boolean; state: string } };
  expect(enabled.server).toMatchObject({ enabled: true, state: "enabled" });
  expect(JSON.stringify(enabled)).not.toContain("present-value");
  const after = JSON.parse(readFileSync(file.path, "utf8")).mcpServers[added.name];
  expect(after.env).toEqual({ TOKEN: "$MCP_TOKEN" });
  expect(after.exposure).toBe("direct");
  expect(after.description).toBe("本地工具");
  expect(after.futureField).toEqual({ nested: true });
});

it("keeps an existing credential reference when an edit submits a blank value", async () => {
  const { file, mcp } = wiring(undefined, { MCP_TOKEN: "present-value" });
  const added = await mcp.perform({ op: "save", input: { transport: "stdio", command: "node", env: { TOKEN: "$MCP_TOKEN" } } }) as { name: string };
  // The edit form never received the value (it only knows the name), so it
  // submits the name with an empty value: main preserves the stored reference.
  const saved = await mcp.perform({ op: "save", name: added.name, input: { transport: "stdio", command: "node", args: ["server.mjs"], env: { TOKEN: "" } } }) as { server: { credentialRefs: { env: string[] } } };
  expect(saved.server.credentialRefs.env).toEqual(["TOKEN"]);
  const written = JSON.parse(readFileSync(file.path, "utf8")).mcpServers[added.name];
  expect(written.env).toEqual({ TOKEN: "$MCP_TOKEN" });
  expect(written.args).toEqual(["server.mjs"]);
  // A blank value with nothing to keep is refused, never written as "".
  await expect(mcp.perform({ op: "save", name: added.name, input: { transport: "stdio", command: "node", env: { OTHER: "" } } })).rejects.toMatchObject({ code: "mcp-servers-invalid" });
});

it("tests a saved managed server against the real stdio fixture and reports its tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pidock-mcp-ipc-test-"));
  roots.push(dir);
  const log = join(dir, "fixture.log");
  const pidFile = join(dir, "fixture.pid");
  const file = new NativeMcpFile(join(dir, "agent"));
  const mcp = new McpWiring(file, {});
  const added = await mcp.perform({
    op: "save",
    input: { transport: "stdio", command: process.execPath, args: [FIXTURE], env: { MCP_FIXTURE_LOG: log, MCP_FIXTURE_PID: pidFile }, exposure: "direct", timeout: 30 },
  }) as { name: string };

  const result = await mcp.perform({ op: "test", name: added.name }) as { state: string; tools: { name: string }[]; server?: { name: string }; credentialRefs: string[] };
  expect(result.state).toBe("connected");
  expect(result.server).toMatchObject({ name: "pidock-mcp-fixture" });
  expect(result.tools.map((tool) => tool.name)).toEqual(["echo", "mutate"]);
  // Literal values are not references, and none of them is echoed by the test.
  expect(result.credentialRefs).toEqual([]);
  expect(JSON.stringify(result)).not.toContain(log);
  // The fixture process really ran the handshake and served the list.
  const seen = readFileSync(log, "utf8");
  expect(seen).toContain("initialize");
  expect(seen).toContain("tools/list");
  // The test disposed its child; a real pid proves there is no orphan.
  const pid = Number(readFileSync(pidFile, "utf8"));
  expect(Number.isSafeInteger(pid)).toBe(true);
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 10_000 });
});

it("tests an unsaved draft and reports a real failure without leaking a value", async () => {
  const { mcp } = wiring({ mcpServers: { handwritten: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${MISSING_TOKEN}" } } } });
  const result = await mcp.perform({ op: "test", input: { transport: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${MISSING_TOKEN}" } } }) as { state: string; error: { code: string; message: string } };
  expect(result.state).toBe("failed");
  expect(result.error.code).toBe("mcp-config-invalid");
  expect(result.error.message).toContain("MISSING_TOKEN");
  expect(JSON.stringify(result)).not.toContain("Bearer Bearer");
});

it("reports a disabled saved server as disabled without connecting", async () => {
  const { mcp } = wiring();
  const added = await mcp.perform({ op: "save", input: { transport: "stdio", command: process.execPath, args: [FIXTURE], enabled: false } }) as { name: string };
  expect(await mcp.perform({ op: "test", name: added.name })).toMatchObject({ state: "disabled", tools: [], credentialRefs: [] });
});

it("names a missing server and an invalid name instead of inventing a row", async () => {
  const { mcp } = wiring();
  await expect(mcp.perform({ op: "test", name: "pidock-mcp-00000000-0000-4000-8000-000000000000" })).rejects.toMatchObject({ code: "mcp-not-found" });
  await expect(mcp.perform({ op: "enable", name: "not a valid name" })).rejects.toBeInstanceOf(TrustDomainViolation);
});

it("projects only OAuth registration metadata and preserves native credentials through managed changes", async () => {
  const oauth = { clientRegistration: "cimd", clientSecret: "private-secret-never-return", callbackUrl: "http://127.0.0.1/callback", nestedUnknown: { keep: true } };
  const { mcp, file } = wiring({ mcpServers: { native: { url: "https://example.com/mcp", oauth } } });
  const before = mcp.list().servers[0]!;
  expect(before).toMatchObject({ oauth: { configured: true, clientRegistration: "cimd", explicitClientId: false } });
  expect(JSON.stringify(before)).not.toContain("private-secret-never-return");
  const added = await mcp.perform({ op: "save", input: { transport: "stdio", command: "node" } }) as { name: string };
  await mcp.perform({ op: "disable", name: added.name });
  expect(JSON.parse(readFileSync(file.path, "utf8")).mcpServers.native.oauth).toEqual(oauth);
});

it("edits only enabled on a user-owned MCP entry and refuses a stale native edit", async () => {
  const original = { command: process.execPath, args: [FIXTURE], env: { TOKEN: "$MCP_TOKEN" }, unknown: { kept: true }, enabled: true };
  const { dir, mcp } = wiring({ mcpServers: { native: original }, unknownRoot: 42 });
  const row = mcp.list().servers.find((server) => server.name === "native")!;
  expect(row.managed).toBe(false);
  await mcp.perform({ op: "native-disable", name: "native", fingerprint: row.fingerprint });
  const saved = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
  expect(saved).toEqual({ mcpServers: { native: { ...original, enabled: false } }, unknownRoot: 42 });
  await expect(mcp.perform({ op: "native-enable", name: "native", fingerprint: row.fingerprint })).rejects.toMatchObject({ code: "mcp-servers-invalid" });
  expect(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"))).toEqual(saved);
});
