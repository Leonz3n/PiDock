/**
 * Real MCP connection test for the capability pane — [Pencil T15] #150.
 *
 * The test uses the same MCP client the SDK's built-in MCP extension uses
 * (`@earendil-works/pi-mcp@1.5.0`: `McpClient` + `StdioTransport` /
 * `StreamableHttpTransport`), not a hand-rolled HTTP probe. It therefore
 * observes the real handshake, the real tool list and the real named failures:
 *
 * - `mcp-transport-unsupported` — `type: "sse"` or an entry with no transport.
 * - `mcp-config-invalid` — malformed entry / missing credential variable.
 * - `mcp-auth-required` — the HTTP server answered 401/403.
 * - `mcp-timeout` — the handshake or `tools/list` passed its timeout.
 * - `mcp-connect-failed` — handshake/initialize failed (named error surfaced).
 * - `mcp-tools-list-failed` — connected, but the tool list did not arrive.
 *
 * The connection is disposed in `finally` in every path (`McpClient.close()` →
 * transport close → stdio child gets EOF, SIGTERM, then SIGKILL), so a failed
 * or successful test never leaks a child process.
 *
 * Credentials are interpolated into the transport only; the result reports the
 * variable *names* that were needed and never a value, and error text is
 * scrubbed of every resolved value before it is returned.
 */

import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { McpAuthRequiredError, McpClient, McpHttpError, McpTimeoutError, StdioTransport, StreamableHttpTransport, type McpTransport, type AuthProvider } from "@earendil-works/pi-mcp";

export const MCP_TEST_FAILURES = [
  "mcp-transport-unsupported",
  "mcp-config-invalid",
  "mcp-auth-required",
  "mcp-timeout",
  "mcp-connect-failed",
  "mcp-tools-list-failed",
] as const;
export type McpTestFailureCode = (typeof MCP_TEST_FAILURES)[number];

export interface McpToolSummary {
  name: string;
  description?: string;
}

export interface McpTestResult {
  state: "connected" | "disabled" | "failed";
  /** Connected: the tools the server actually lists. */
  tools: McpToolSummary[];
  server?: { name: string; version?: string };
  protocolVersion?: string;
  /** Environment variable names used by `env` / `headers`; never their values. */
  credentialRefs: string[];
  error?: { code: McpTestFailureCode; message: string };
  durationMs: number;
}

export interface McpTestOptions {
  authProvider?: AuthProvider;
  /** Session/project directory `cwd` resolves against (same rule as Pi). */
  cwd?: string;
  /** Environment used for `$NAME` / `${NAME}`; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Per-test ceiling; also becomes the client's request timeout. */
  timeoutMs?: number;
  home?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const REFERENCE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

class TestFailure extends Error {
  constructor(readonly code: McpTestFailureCode, readonly detail: string) {
    super(`${code}: ${detail}`);
    this.name = "TestFailure";
  }
}

function expandHome(value: string, home: string): string {
  return value === "~" ? home : value.startsWith("~/") ? resolve(home, value.slice(2)) : value;
}

/**
 * Resolve one `env`/`headers` value exactly like Pi: `$NAME` / `${NAME}` are
 * environment references and a whole-value `!command` is delegated (refused
 * here: a connection test must not run a shell command from shared config).
 * Missing variables are named, never guessed.
 */
function resolveReference(value: string, env: Record<string, string | undefined>, where: string, refs: Set<string>): string {
  if (/^\$[A-Za-z_]/.test(value) && !/^\$\{[^}]+\}$/.test(value)) {
    const name = value.slice(1);
    refs.add(name);
    const resolved = env[name];
    if (resolved === undefined) throw new TestFailure("mcp-config-invalid", `${where}: environment variable ${name} is not set`);
    return resolved;
  }
  return value.replace(REFERENCE, (_match, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare ?? "";
    refs.add(name);
    const resolved = env[name];
    if (resolved === undefined) throw new TestFailure("mcp-config-invalid", `${where}: environment variable ${name} is not set`);
    return resolved;
  });
}

function interpolate(map: Record<string, unknown> | undefined, env: Record<string, string | undefined>, where: string, refs: Set<string>): Record<string, string> | undefined {
  if (!map) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(map)) {
    if (typeof raw !== "string") throw new TestFailure("mcp-config-invalid", `${where}.${key} is not a string`);
    if (/^!/.test(raw)) throw new TestFailure("mcp-config-invalid", `${where}.${key}: a shell substitution cannot run during a connection test`);
    out[key] = resolveReference(raw, env, `${where}.${key}`, refs);
  }
  return out;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Build the transport from an `mcpServers` entry, rejecting what Pi rejects. */
export function transportFor(entry: unknown, options: McpTestOptions = {}): { transport: McpTransport; credentialRefs: string[]; child: boolean } {
  if (!record(entry)) throw new TestFailure("mcp-config-invalid", "entry is not an object");
  const type = entry["type"];
  if (type === "sse") throw new TestFailure("mcp-transport-unsupported", "legacy SSE is not supported; use a streamable HTTP endpoint");
  if (type !== undefined && type !== "stdio" && type !== "http" && type !== "streamable-http") {
    throw new TestFailure("mcp-transport-unsupported", `type ${String(type)}`);
  }
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const refs = new Set<string>();
  if (typeof entry["url"] === "string") {
    let url: URL;
    try { url = new URL(entry["url"]); } catch { throw new TestFailure("mcp-config-invalid", "url is not a URL"); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new TestFailure("mcp-config-invalid", "url must be http(s)");
    if (type === "stdio") throw new TestFailure("mcp-transport-unsupported", "type stdio with a url");
    const headers = interpolate(record(entry["headers"]) ? entry["headers"] : undefined, env, "headers", refs);
    return { transport: new StreamableHttpTransport({ url, ...(options.authProvider ? { authProvider: options.authProvider } : {}), ...(headers ? { headers } : {}) }), credentialRefs: [...refs], child: false };
  }
  const command = entry["command"];
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new TestFailure("mcp-transport-unsupported", "entry has neither command nor url");
  }
  if (type === "http" || type === "streamable-http") throw new TestFailure("mcp-transport-unsupported", `type ${type} with a command`);
  const args = entry["args"];
  if (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))) {
    throw new TestFailure("mcp-config-invalid", "args is not a list of strings");
  }
  const stdioEnv = interpolate(record(entry["env"]) ? entry["env"] : undefined, env, "env", refs);
  const cwd = typeof entry["cwd"] === "string" ? resolve(options.cwd ?? process.cwd(), expandHome(entry["cwd"], home)) : (options.cwd ?? process.cwd());
  return {
    transport: new StdioTransport({
      command: expandHome(command, home),
      ...(args ? { args: (args as string[]).map((arg) => expandHome(arg, home)) } : {}),
      cwd,
      ...(stdioEnv ? { env: stdioEnv } : {}),
      stderr: "pipe",
      // The SDK's own transport: the child inherits PATH; a configured `env` is
      // additive for the MCP server, exactly like Pi's built-in extension.
      inheritEnv: true,
    }),
    credentialRefs: [...refs],
    child: true,
  };
}

function classify(error: unknown, phase: "connect" | "tools"): { code: McpTestFailureCode; message: string } {
  if (error instanceof TestFailure) return { code: error.code, message: error.detail };
  if (error instanceof McpOAuthAuthorizationRequiredError) return { code: "mcp-auth-required", message: "server requires sign-in" };
  if (error instanceof McpAuthRequiredError) return { code: "mcp-auth-required", message: `server requires sign-in (HTTP ${error.status})` };
  if (error instanceof McpTimeoutError) return { code: "mcp-timeout", message: "the server did not answer within the timeout" };
  if (error instanceof McpHttpError) {
    if (error.status === 401 || error.status === 403) return { code: "mcp-auth-required", message: `server rejected the credentials (HTTP ${error.status})` };
    return { code: phase === "tools" ? "mcp-tools-list-failed" : "mcp-connect-failed", message: `HTTP ${error.status}` };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: phase === "tools" ? "mcp-tools-list-failed" : "mcp-connect-failed", message };
}

function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join("***");
  }
  return out.length > 400 ? `${out.slice(0, 400)}…` : out;
}

/**
 * Connect, list the tools, then dispose. `enabled: false` reports `disabled`
 * without opening a connection: a saved-but-off server is not a success.
 */
export async function testMcpConnection(entry: unknown, options: McpTestOptions = {}): Promise<McpTestResult> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  if (record(entry) && entry["enabled"] === false) {
    return { state: "disabled", tools: [], credentialRefs: [], durationMs: elapsed() };
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = options.env ?? process.env;
  const refs = new Set<string>();
  const secrets: string[] = [];
  let client: McpClient | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const built = transportFor(entry, { ...options, env });
    for (const name of built.credentialRefs) refs.add(name);
    // Values are only ever known as resolved strings; remember them so any
    // error text that echoes one is scrubbed before it reaches the UI.
    for (const map of [record(entry) ? entry["env"] : undefined, record(entry) ? entry["headers"] : undefined]) {
      if (!record(map)) continue;
      for (const raw of Object.values(map)) {
        if (typeof raw !== "string" || raw.startsWith("!")) continue;
        for (const match of raw.matchAll(REFERENCE)) {
          const resolved = env[match[1] ?? match[2] ?? ""];
          if (resolved) secrets.push(resolved);
        }
      }
    }
    client = new McpClient({ name: "pidock", version: "0.1.6", requestTimeoutMs: timeoutMs });
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new TestFailure("mcp-timeout", `no handshake within ${timeoutMs} ms`)), timeoutMs);
    });
    await Promise.race([client.connect(built.transport), timeout]);
    let tools: McpToolSummary[];
    try {
      const listed = await Promise.race([client.listTools({ timeoutMs }), timeout]);
      tools = listed.map((tool) => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}) }));
    } catch (error) {
      const failure = classify(error, "tools");
      return { state: "failed", tools: [], credentialRefs: [...refs], error: { code: failure.code, message: scrub(failure.message, secrets) }, durationMs: elapsed() };
    }
    const info = client.serverInfo;
    return {
      state: "connected",
      tools,
      ...(info ? { server: { name: info.name, ...(info.version ? { version: info.version } : {}) } } : {}),
      ...(client.protocolVersion ? { protocolVersion: client.protocolVersion } : {}),
      credentialRefs: [...refs],
      durationMs: elapsed(),
    };
  } catch (error) {
    const failure = classify(error, "connect");
    return { state: "failed", tools: [], credentialRefs: [...refs], error: { code: failure.code, message: scrub(failure.message, secrets) }, durationMs: elapsed() };
  } finally {
    if (timer) clearTimeout(timer);
    // Always dispose: closing the client closes the transport, and a stdio
    // child receives EOF, then SIGTERM, then SIGKILL (never left running).
    if (client) await client.close().catch(() => undefined);
  }
}
