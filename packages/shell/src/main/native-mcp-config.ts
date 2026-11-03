/**
 * Pi's native `mcp.json` as the MCP management object — [Pencil T15] #150.
 *
 * Pi 1.5.0 reads MCP servers from `<agent-dir>/mcp.json` (`~/.pi/agent` unless
 * `PIDOCK_AGENT_DIR` overrides it) and, in trusted projects, from
 * `<project>/.pi/mcp.json` (`docs/mcp.md`). PiDock owns the *managed slice* of
 * the user-level file:
 *
 * - Ownership namespace: every server PiDock writes is named
 *   `pidock-mcp-<uuid>`. Nothing outside that namespace is ever written,
 *   rewritten or deleted, so a hand-written server (with credentials, OAuth
 *   state or fields this app does not model) survives every UI action.
 * - Unknown top-level fields (`autoEnableCodemode`, comments already stripped
 *   by the caller's JSON parser) and unknown fields of unmanaged servers are
 *   preserved value-for-value through read → mutate → write.
 * - Writes are atomic (temp file + fsync + rename, mode 0600) and leave one
 *   `.bak` of the previous file, so a crash cannot truncate a file Pi reads.
 * - Credentials stay references: `env` / `headers` values must be `$NAME` /
 *   `${NAME}` interpolations (or a whole-value `!command`); a literal secret is
 *   rejected by name instead of being written into shared configuration.
 * - Transport rules follow the SDK exactly: `command` selects stdio, `url`
 *   selects streamable HTTP, `type` is optional and limited to `stdio`,
 *   `http`, `streamable-http`; legacy `sse` is rejected, never downgraded.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/** Exposure values the 1.5.0 MCP extension accepts; `codemode-deferred` is an alias. */
export const MCP_EXPOSURES = ["codemode", "deferred", "direct", "hidden", "codemode-deferred"] as const;
export type McpExposureValue = (typeof MCP_EXPOSURES)[number];
/** Transports Pi 1.5.0 supports. `sse` is deliberately absent. */
export const MCP_TRANSPORTS = ["stdio", "http", "streamable-http"] as const;
export type McpTransportKind = (typeof MCP_TRANSPORTS)[number];

export interface McpStdioEntry {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpEntry {
  type?: "http" | "streamable-http";
  url: string;
  headers?: Record<string, string>;
  oauth?: Record<string, unknown>;
}

export type McpServerEntry = (McpStdioEntry | McpHttpEntry) & {
  enabled?: boolean;
  timeout?: number;
  exposure?: McpExposureValue;
  toolExposure?: Record<string, McpExposureValue>;
  description?: string;
  auth?: { provider: string };
};

/** The shape the manager page submits; transport is decided by `transport`. */
export interface McpServerInput {
  transport: McpTransportKind;
  /** stdio only: one executable, args separate (never a shell string). */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** http / streamable-http only. */
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
  exposure?: McpExposureValue;
  toolExposure?: Record<string, McpExposureValue>;
  description?: string;
  enabled?: boolean;
}

export type McpFailureCode =
  | "mcp-agent-dir-invalid"
  | "mcp-unreadable"
  | "mcp-name-invalid"
  | "mcp-transport-unsupported"
  | "mcp-command-missing"
  | "mcp-command-invalid"
  | "mcp-url-invalid"
  | "mcp-timeout-invalid"
  | "mcp-exposure-invalid"
  | "mcp-credential-literal"
  | "mcp-not-managed"
  | "mcp-servers-invalid";

export class McpFailure extends Error {
  constructor(readonly code: McpFailureCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "McpFailure";
  }
}

const FILE = "mcp.json";
const BACKUP = "mcp.json.bak";
const MAX_BYTES = 2 * 1024 * 1024;
const MANAGED_NAME = /^pidock-mcp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Server names Pi accepts: letters, digits, `_`, `-` (`docs/mcp.md`). */
const PI_NAME = /^[A-Za-z0-9_-]+$/;
/** A value made only of references and punctuation, e.g. `$NAME` or `Bearer ${NAME}`. */
const CREDENTIAL_REFERENCE = /\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/;
const CREDENTIAL_COMMAND = /^!.+/;
const SECRET_KEY = /(authorization|token|secret|api[-_]?key|password|cookie)/i;

/** `pidock-mcp-<uuid>`; the only names this module can create or delete. */
export function managedMcpName(serverId?: string): string {
  const id = serverId ?? randomUUID();
  const name = `pidock-mcp-${id}`;
  if (!MANAGED_NAME.test(name)) throw new McpFailure("mcp-name-invalid", "pidock-mcp-<uuid>");
  return name;
}

export function isManagedMcpName(value: unknown): value is string {
  return typeof value === "string" && MANAGED_NAME.test(value);
}

/** Validate a caller-supplied name before using it as a file key. */
export function assertMcpName(value: unknown): string {
  if (typeof value !== "string" || !PI_NAME.test(value)) throw new McpFailure("mcp-name-invalid", String(value));
  return value;
}

/** The resolved Pi agent directory; `PIDOCK_AGENT_DIR` must be absolute. */
export function resolveMcpAgentDir(env: Record<string, string | undefined>, home: string): string {
  const override = env["PIDOCK_AGENT_DIR"];
  if (typeof override === "string" && override.trim().length > 0) {
    if (!isAbsolute(override.trim())) throw new McpFailure("mcp-agent-dir-invalid", override);
    return override.trim();
  }
  return join(home, ".pi", "agent");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringMap(value: unknown, code: McpFailureCode, key: "env" | "headers"): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) throw new McpFailure(code, key);
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (typeof raw !== "string") throw new McpFailure(code, `${key}.${name}`);
    out[name] = raw;
  }
  return out;
}

/**
 * A credential may be referenced, never inlined. Values that look like a
 * literal secret under a secret-looking key are refused so the file, a log and
 * the UI readback can never hold the value itself.
 */
function assertCredentialReferences(map: Record<string, string> | undefined, prefix: "env" | "headers"): void {
  if (!map) return;
  for (const [name, value] of Object.entries(map)) {
    if (CREDENTIAL_REFERENCE.test(value) || CREDENTIAL_COMMAND.test(value)) continue;
    if (prefix === "headers" && SECRET_KEY.test(name)) throw new McpFailure("mcp-credential-literal", `${prefix}.${name}`);
  }
}

function exposure(value: unknown): McpExposureValue | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(MCP_EXPOSURES as readonly string[]).includes(value)) throw new McpFailure("mcp-exposure-invalid", String(value));
  return value as McpExposureValue;
}

function toolExposure(value: unknown): Record<string, McpExposureValue> | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) throw new McpFailure("mcp-exposure-invalid", "toolExposure");
  const out: Record<string, McpExposureValue> = {};
  for (const [pattern, raw] of Object.entries(value)) out[pattern] = exposure(raw) as McpExposureValue;
  return out;
}

function timeout(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new McpFailure("mcp-timeout-invalid", String(value));
  return value;
}

/** Normalize one manager-page submission into a Pi `mcpServers` entry. */
export function buildMcpEntry(input: McpServerInput): McpServerEntry {
  const transport = input.transport;
  if (!(MCP_TRANSPORTS as readonly string[]).includes(transport)) throw new McpFailure("mcp-transport-unsupported", String(transport));
  const shared: Record<string, unknown> = {};
  const enabled = input.enabled;
  if (enabled !== undefined) shared["enabled"] = enabled === true;
  const timeoutValue = timeout(input.timeout);
  if (timeoutValue !== undefined) shared["timeout"] = timeoutValue;
  const exposureValue = exposure(input.exposure);
  if (exposureValue !== undefined) shared["exposure"] = exposureValue;
  const toolExposureValue = toolExposure(input.toolExposure);
  if (toolExposureValue !== undefined) shared["toolExposure"] = toolExposureValue;
  if (input.description !== undefined) {
    if (typeof input.description !== "string") throw new McpFailure("mcp-servers-invalid", "description");
    shared["description"] = input.description;
  }
  if (transport === "stdio") {
    const command = input.command;
    if (typeof command !== "string" || command.trim().length === 0) throw new McpFailure("mcp-command-missing");
    if (/\s/.test(command.trim())) throw new McpFailure("mcp-command-invalid", "one executable, args separate");
    const args = input.args;
    if (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))) throw new McpFailure("mcp-command-invalid", "args");
    const env = stringMap(input.env, "mcp-servers-invalid", "env");
    assertCredentialReferences(env, "env");
    if (input.cwd !== undefined && typeof input.cwd !== "string") throw new McpFailure("mcp-servers-invalid", "cwd");
    return {
      type: "stdio",
      command: command.trim(),
      ...(args ? { args: [...args] as string[] } : {}),
      ...(env ? { env } : {}),
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(shared as object),
    } as McpServerEntry;
  }
  const url = input.url;
  if (typeof url !== "string" || url.trim().length === 0) throw new McpFailure("mcp-url-invalid", "missing");
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new McpFailure("mcp-url-invalid", url);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new McpFailure("mcp-url-invalid", parsed.protocol);
  const headers = stringMap(input.headers, "mcp-servers-invalid", "headers");
  assertCredentialReferences(headers, "headers");
  return {
    type: transport,
    url: parsed.toString(),
    ...(headers ? { headers } : {}),
    ...(shared as object),
  } as McpServerEntry;
}

/** What an existing entry says about its transport, for list/readback. */
export function entryTransport(entry: unknown): McpTransportKind | "invalid" {
  if (!record(entry)) return "invalid";
  const type = entry["type"];
  if (type === "sse") return "invalid";
  if (typeof entry["command"] === "string") return "stdio";
  if (typeof entry["url"] === "string") return "http";
  if (type === "stdio" || type === "http" || type === "streamable-http") return type;
  // Override-only entry (enabled/exposure for a server defined elsewhere).
  if (type === undefined) return "http";
  return "invalid";
}

export interface McpListRow {
  name: string;
  managed: boolean;
  entry: Record<string, unknown>;
  /** Never the header/env value: only whether a credential reference exists. */
  credentialRefs: { env: string[]; headers: string[] };
}

export interface NativeMcpRead {
  ok: true;
  root: Record<string, unknown>;
  servers: Record<string, unknown>;
  created: boolean;
}

export type NativeMcpReadResult = NativeMcpRead | { ok: false; error: "mcp-unreadable" };

function emptyRoot(): Record<string, unknown> {
  return { mcpServers: {} };
}

/**
 * The managed file. Every method re-reads the file, so an external edit between
 * two UI actions is observed instead of overwritten from a stale copy.
 */
export class NativeMcpFile {
  private readonly file: string;
  private readonly backup: string;

  constructor(readonly agentDir: string) {
    this.file = join(agentDir, FILE);
    this.backup = join(agentDir, BACKUP);
  }

  get path(): string { return this.file; }

  read(): NativeMcpReadResult {
    if (!existsSync(this.file)) {
      const root = emptyRoot();
      return { ok: true, root, servers: root["mcpServers"] as Record<string, unknown>, created: true };
    }
    try {
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.size > MAX_BYTES) return { ok: false, error: "mcp-unreadable" };
      const value: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (!record(value)) return { ok: false, error: "mcp-unreadable" };
      const servers = value["mcpServers"];
      if (servers === undefined) {
        const root = { ...value, mcpServers: {} };
        return { ok: true, root, servers: root["mcpServers"] as Record<string, unknown>, created: false };
      }
      if (!record(servers)) return { ok: false, error: "mcp-unreadable" };
      return { ok: true, root: value, servers, created: false };
    } catch {
      return { ok: false, error: "mcp-unreadable" };
    }
  }

  /** Managed and unmanaged rows, with credentials reduced to their reference names. */
  list(): McpListRow[] {
    const read = this.read();
    if (!read.ok) throw new McpFailure("mcp-unreadable");
    return Object.entries(read.servers)
      .map(([name, entry]) => {
        const raw = record(entry) ? entry : {};
        return {
          name,
          managed: isManagedMcpName(name),
          entry: raw,
          credentialRefs: {
            env: record(raw["env"]) ? Object.keys(raw["env"] as Record<string, unknown>) : [],
            headers: record(raw["headers"]) ? Object.keys(raw["headers"] as Record<string, unknown>) : [],
          },
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  entry(name: string): Record<string, unknown> | undefined {
    const read = this.read();
    if (!read.ok) throw new McpFailure("mcp-unreadable");
    const value = read.servers[assertMcpName(name)];
    return record(value) ? value : undefined;
  }

  /** Add one managed server; returns the generated Pi name and the file path. */
  add(input: McpServerInput): { name: string; path: string } {
    const entry = buildMcpEntry(input);
    const name = managedMcpName();
    this.write(name, entry);
    return { name, path: this.file };
  }

  /** Replace one managed server; refuses a name outside the ownership namespace. */
  update(name: string, input: McpServerInput): { name: string; path: string } {
    this.requireManaged(name);
    this.write(name, buildMcpEntry(input));
    return { name, path: this.file };
  }

  /** Enable/disable one managed server without touching the rest of the entry. */
  setEnabled(name: string, enabled: boolean): void {
    this.requireManaged(name);
    const entry = this.entry(name);
    if (!entry) throw new McpFailure("mcp-not-managed", name);
    // Enable/disable changes only the `enabled` flag: every other field —
    // including a credential reference this app never models — is kept.
    this.write(name, { ...entry, enabled });
  }

  /** Delete one managed server; returns true when it existed. Unmanaged names throw. */
  remove(name: string): boolean {
    this.requireManaged(name);
    const read = this.read();
    if (!read.ok) throw new McpFailure("mcp-unreadable");
    if (read.servers[name] === undefined) return false;
    const servers = { ...read.servers };
    delete servers[name];
    this.commit({ ...read.root, mcpServers: servers });
    return true;
  }

  private requireManaged(name: string): void {
    assertMcpName(name);
    if (!isManagedMcpName(name)) throw new McpFailure("mcp-not-managed", name);
  }

  private write(name: string, entry: unknown): void {
    const read = this.read();
    if (!read.ok) throw new McpFailure("mcp-unreadable");
    this.commit({ ...read.root, mcpServers: { ...read.servers, [name]: entry } });
  }

  private commit(root: Record<string, unknown>): void {
    mkdirSync(this.agentDir, { recursive: true, mode: 0o700 });
    if (existsSync(this.file)) {
      copyFileSync(this.file, this.backup);
      try { chmodSync(this.backup, 0o600); } catch { /* a read-only parent keeps the copy as-is */ }
    }
    const temporary = join(dirname(this.file), `.${FILE}.${randomUUID()}.tmp`);
    try {
      const descriptor = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(descriptor, `${JSON.stringify(root, null, 2)}\n`);
        fsyncSync(descriptor);
      } finally { closeSync(descriptor); }
      renameSync(temporary, this.file);
    } finally { rmSync(temporary, { force: true }); }
  }
}

/** The `mcp.json` path for a resolved agent directory (for UI disclosure). */
export function mcpJsonPath(agentDir: string): string {
  return join(agentDir, FILE);
}
