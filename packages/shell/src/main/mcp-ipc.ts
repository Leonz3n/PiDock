/**
 * Exact-key MCP operations for the 能力管理 · MCP pane — [Pencil T15] #150.
 *
 * The renderer names an operation and the managed server it concerns, never a
 * file, a path, an agent directory or a credential value:
 *
 * - `list` reads Pi's own `mcp.json` (the management object) and reduces every
 *   entry to a bounded view. `env` / `headers` **values** never cross this
 *   boundary — only the reference names are reported, so a key can be seen in
 *   the file and in Pi, but never echoed into a renderer payload.
 * - `save` / `remove` / `enable` / `disable` write only the `pidock-mcp-<uuid>`
 *   ownership namespace. A hand-written server (with credentials, OAuth state
 *   or fields this app does not model) is preserved value-for-value and cannot
 *   be removed or rewritten from here.
 * - `test` uses the same MCP client Pi uses (`mcp-connection-test.ts`) and
 *   reports the real handshake, tool list and named failure. A disabled server
 *   reports `disabled` without opening a connection.
 *
 * Saving is a file write and nothing else: it never reaches into a running SDK
 * session. Each session reads `mcp.json` when it starts, so a change applies to
 * the next session; an already-open session keeps the servers and tools it
 * loaded. That named boundary is returned with the list so the UI states it
 * instead of implying a live reload.
 */

import {
  McpFailure,
  MCP_EXPOSURES,
  MCP_TRANSPORTS,
  NativeMcpFile,
  assertMcpName,
  buildMcpEntry,
  entryTransport,
  isManagedMcpName,
  type McpExposureValue,
  type McpServerInput,
  type McpTransportKind,
} from "./native-mcp-config.js";
import { testMcpConnection, transportFor, type McpTestResult, type McpToolSummary } from "./mcp-connection-test.js";
import { TrustDomainViolation } from "./trust-domain.js";

/** The one surface the renderer may name; no path, file or credential field exists. */
export type McpOp =
  | { op: "list" }
  | { op: "save"; name?: string; input: McpServerInput }
  | { op: "remove"; name: string }
  | { op: "enable"; name: string }
  | { op: "disable"; name: string }
  | { op: "test"; name?: string; input?: McpServerInput };

export interface McpServerView {
  /** Pi's server name (the key in `mcpServers`). */
  name: string;
  /** True only inside the `pidock-mcp-<uuid>` namespace this app owns. */
  managed: boolean;
  label: string | null;
  transport: McpTransportKind | "invalid";
  enabled: boolean;
  /** `error` means the stored entry cannot be used at all; the reason is named. */
  state: "enabled" | "disabled" | "error";
  error: { code: string; message: string } | null;
  command: string | null;
  args: string[];
  url: string | null;
  timeout: number | null;
  exposure: McpExposureValue | string;
  /** Names only; a value was never read out of the file into this shape. */
  credentialRefs: { env: string[]; headers: string[] };
}

/**
 * The named session boundary every save/enable/disable obeys. A session that is
 * already open keeps its loaded servers and tools; only a new session reads the
 * changed file. The list response carries it so the UI can say it.
 */
export const MCP_SESSION_BOUNDARY = {
  appliesTo: "new-session",
  openSessionsMutated: false,
  note: "保存、启用或停用只修改 mcp.json；已打开的会话保留启动时加载的 Server 与工具，新会话才读取新配置。",
} as const;

export interface McpStatus {
  servers: McpServerView[];
  path: string;
  sessionBoundary: typeof MCP_SESSION_BOUNDARY;
}

export const MCP_FAILURE_TEXT: Record<string, string> = {
  "mcp-agent-dir-invalid": "Pi 的 Agent 目录配置无效：PIDOCK_AGENT_DIR 必须是绝对路径",
  "mcp-unreadable": "Pi 的 mcp.json 无法解析，已停止写入以免破坏现有配置",
  "mcp-name-invalid": "Server 名称不合法：只允许字母、数字、下划线和连字符",
  "mcp-not-managed": "该 Server 不由 PiDock 管理：只能查看，不能编辑、停用或删除",
  "mcp-not-found": "该 Server 已不在 mcp.json 中，请刷新后重试",
  "mcp-transport-unsupported": "传输协议不受支持：Pi 使用 stdio 或 Streamable HTTP，不支持 legacy SSE",
  "mcp-command-missing": "stdio Server 需要一个可执行程序作为 command",
  "mcp-command-invalid": "command 只能是单个可执行程序；参数请填在 args，不要拼成一条 shell 命令",
  "mcp-url-invalid": "HTTP Server 需要一个 http(s) 地址",
  "mcp-timeout-invalid": "超时必须是大于 0 的秒数",
  "mcp-exposure-invalid": "工具暴露模式无效",
  "mcp-credential-literal": "凭据只能引用环境变量：请写 $NAME 或 ${NAME}，不要把明文密钥写入 mcp.json",
  "mcp-servers-invalid": "参数形状无效：env/headers 必须是非空字符串值，args 必须是字符串数组",
};

/** A bounded refusal the renderer may name; raw file text never crosses. */
export type McpRefusalCode = "mcp-not-found" | "mcp-invalid-payload";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exact-key check: every required key present, no key outside the allowed set. */
function shape(value: unknown, op: string, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!object(value) || value["op"] !== op) throw new TrustDomainViolation("invalid-payload", `invalid mcp ${op} payload`);
  const allowed = ["op", ...required, ...optional];
  if (Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    throw new TrustDomainViolation("invalid-payload", `invalid mcp ${op} payload`);
  }
  return value;
}

function nameOf(value: unknown): string {
  try {
    return assertMcpName(value);
  } catch {
    throw new TrustDomainViolation("invalid-payload", "invalid mcp server name");
  }
}

function stringOf(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0")) {
    throw new McpFailure("mcp-servers-invalid", field);
  }
  return value;
}

function stringMap(value: unknown, field: "env" | "headers"): Record<string, string> {
  if (!object(value)) throw new McpFailure("mcp-servers-invalid", field);
  const entries = Object.entries(value);
  if (entries.length > 100) throw new McpFailure("mcp-servers-invalid", field);
  const out: Record<string, string> = {};
  for (const [key, raw] of entries) {
    const namePattern = field === "env" ? /^[A-Za-z_][A-Za-z0-9_]*$/ : /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
    if (!namePattern.test(key)) throw new McpFailure("mcp-servers-invalid", `${field}.${key}`);
    if (typeof raw !== "string" || raw.length > 4096 || raw.includes("\0") || /[\r\n]/.test(raw)) {
      throw new McpFailure("mcp-servers-invalid", `${field}.${key}`);
    }
    out[key] = raw;
  }
  return out;
}

/** Validate one manager form submission against the exact shape Pi accepts. */
function inputOf(value: unknown): McpServerInput {
  if (!object(value)) throw new McpFailure("mcp-servers-invalid", "input");
  const allowed = ["transport", "command", "args", "env", "cwd", "url", "headers", "timeout", "exposure", "description", "enabled"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new McpFailure("mcp-servers-invalid", "unknown field");
  const transport = value["transport"];
  if (typeof transport !== "string" || !(MCP_TRANSPORTS as readonly string[]).includes(transport)) {
    throw new McpFailure("mcp-transport-unsupported", String(transport));
  }
  const input: McpServerInput = { transport: transport as McpTransportKind };
  // Fields of the other transport are refused by name instead of being silently
  // dropped: a header typed into a stdio form must not look saved.
  const forbidden = transport === "stdio" ? ["url", "headers"] : ["command", "args", "env", "cwd"];
  for (const key of forbidden) {
    if (value[key] !== undefined) throw new McpFailure("mcp-servers-invalid", `${key} 不属于 ${transport}`);
  }
  if (value["command"] !== undefined) input.command = stringOf(value["command"], "command", 4096);
  if (value["args"] !== undefined) {
    const args = value["args"];
    if (!Array.isArray(args) || args.length > 64) throw new McpFailure("mcp-command-invalid", "args");
    input.args = args.map((arg) => stringOf(arg, "args", 2048));
  }
  if (value["env"] !== undefined) input.env = stringMap(value["env"], "env");
  if (value["cwd"] !== undefined) input.cwd = stringOf(value["cwd"], "cwd", 4096);
  if (value["url"] !== undefined) input.url = stringOf(value["url"], "url", 4096);
  if (value["headers"] !== undefined) input.headers = stringMap(value["headers"], "headers");
  if (value["timeout"] !== undefined) {
    const timeout = value["timeout"];
    if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600) {
      throw new McpFailure("mcp-timeout-invalid", String(timeout));
    }
    input.timeout = timeout;
  }
  if (value["exposure"] !== undefined) {
    const exposure = value["exposure"];
    if (typeof exposure !== "string" || !(MCP_EXPOSURES as readonly string[]).includes(exposure)) {
      throw new McpFailure("mcp-exposure-invalid", String(exposure));
    }
    input.exposure = exposure as McpExposureValue;
  }
  if (value["description"] !== undefined) {
    if (typeof value["description"] !== "string" || value["description"].length > 500) throw new McpFailure("mcp-servers-invalid", "description");
    input.description = value["description"];
  }
  if (value["enabled"] !== undefined) {
    if (typeof value["enabled"] !== "boolean") throw new McpFailure("mcp-servers-invalid", "enabled");
    input.enabled = value["enabled"];
  }
  return input;
}

/** A bounded state reason for one stored entry; no raw value is copied. */
function entryError(entry: Record<string, unknown>, env: Record<string, string | undefined>): { code: string; message: string } | null {
  try {
    // Nothing is started: the transport only describes how Pi would connect.
    transportFor(entry, { env });
    return null;
  } catch (error) {
    const code = object(error) && typeof error["code"] === "string" ? error["code"] : "mcp-servers-invalid";
    const detail = error instanceof Error ? error.message : String(error);
    return { code, message: detail.length > 300 ? `${detail.slice(0, 300)}…` : detail };
  }
}

function view(name: string, entry: Record<string, unknown>, env: Record<string, string | undefined>): McpServerView {
  const enabled = entry["enabled"] !== false;
  // A disabled entry is not in use, so a missing variable is not reported as a
  // failure yet: it becomes one only if the server is enabled.
  const error = enabled ? entryError(entry, env) : null;
  const rawArgs = entry["args"];
  const timeout = entry["timeout"];
  const exposure = entry["exposure"];
  const description = entry["description"];
  return {
    name,
    managed: isManagedMcpName(name),
    label: typeof description === "string" && description.length > 0 ? description : null,
    transport: entryTransport(entry),
    enabled,
    state: error !== null ? "error" : enabled ? "enabled" : "disabled",
    error,
    command: typeof entry["command"] === "string" ? entry["command"] : null,
    args: Array.isArray(rawArgs) ? rawArgs.filter((arg): arg is string => typeof arg === "string") : [],
    url: typeof entry["url"] === "string" ? entry["url"] : null,
    timeout: typeof timeout === "number" && Number.isFinite(timeout) ? timeout : null,
    exposure: typeof exposure === "string" ? exposure : "codemode",
    credentialRefs: {
      env: object(entry["env"]) ? Object.keys(entry["env"] as Record<string, unknown>) : [],
      headers: object(entry["headers"]) ? Object.keys(entry["headers"] as Record<string, unknown>) : [],
    },
  };
}

export class McpWiring {
  constructor(
    private readonly file: NativeMcpFile,
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly tester: (entry: unknown, options: { env: Record<string, string | undefined> }) => Promise<McpTestResult> = testMcpConnection,
  ) {}

  /** The managed file Pi reads; named for the UI's config footer. */
  get path(): string {
    return this.file.path;
  }

  list(): McpStatus {
    const rows = this.file.list();
    return {
      servers: rows.map((row) => view(row.name, row.entry, this.env)),
      path: this.file.path,
      sessionBoundary: MCP_SESSION_BOUNDARY,
    };
  }

  private row(name: string): McpServerView {
    const entry = this.file.entry(name);
    if (!entry) throw new McpFailure("mcp-not-found", name);
    return view(name, entry, this.env);
  }

  private async test(entry: unknown): Promise<McpTestResult> {
    return await this.tester(entry, { env: this.env });
  }

  async perform(request: unknown): Promise<unknown> {
    if (!object(request) || typeof request["op"] !== "string") throw new TrustDomainViolation("invalid-payload", "invalid mcp operation");
    switch (request["op"]) {
      case "list":
        shape(request, "list", []);
        return this.list();
      case "save": {
        const args = shape(request, "save", ["input"], ["name"]);
        const input = inputOf(args["input"]);
        if (args["name"] === undefined) {
          // `buildMcpEntry` is the same validator the file write uses: a rejected
          // submission writes nothing at all.
          buildMcpEntry(input);
          const added = this.file.add(input);
          return { name: added.name, path: added.path, server: this.row(added.name) };
        }
        const name = nameOf(args["name"]);
        // Editing never reads a credential value back into the form. An empty
        // value therefore means "keep the reference this entry already has";
        // an empty value with nothing to keep is a named refusal, not a blank
        // credential silently written over the old one.
        const existing = this.file.entry(name);
        if (!existing) throw new McpFailure("mcp-not-found", name);
        for (const field of ["env", "headers"] as const) {
          const submitted = input[field];
          if (!submitted) continue;
          const prior = object(existing[field]) ? existing[field] as Record<string, unknown> : {};
          for (const [key, value] of Object.entries(submitted)) {
            if (value !== "") continue;
            const kept = prior[key];
            if (typeof kept === "string" && kept.length > 0) submitted[key] = kept;
            else throw new McpFailure("mcp-servers-invalid", `${field}.${key} 需要一个引用值`);
          }
        }
        const updated = this.file.update(name, input);
        return { name: updated.name, path: updated.path, server: this.row(updated.name) };
      }
      case "remove": {
        const args = shape(request, "remove", ["name"]);
        const name = nameOf(args["name"]);
        if (!this.file.remove(name)) throw new McpFailure("mcp-not-found", name);
        return { removed: name, path: this.file.path };
      }
      case "enable":
      case "disable": {
        const args = shape(request, request["op"], ["name"]);
        const name = nameOf(args["name"]);
        this.file.setEnabled(name, request["op"] === "enable");
        return { server: this.row(name) };
      }
      case "test": {
        const args = shape(request, "test", [], ["name", "input"]);
        const byName = args["name"] !== undefined;
        const byInput = args["input"] !== undefined;
        if (byName === byInput) throw new TrustDomainViolation("invalid-payload", "mcp test names exactly one server or one draft");
        if (byName) {
          const name = nameOf(args["name"]);
          const entry = this.file.entry(name);
          if (!entry) throw new McpFailure("mcp-not-found", name);
          const result = await this.test(entry);
          return { ...result, tools: result.tools as McpToolSummary[], name };
        }
        const input = inputOf(args["input"]);
        const entry = buildMcpEntry(input);
        const result = await this.test(entry);
        return { ...result, tools: result.tools as McpToolSummary[], draft: true };
      }
      default:
        throw new TrustDomainViolation("invalid-payload", "unknown mcp operation");
    }
  }
}
