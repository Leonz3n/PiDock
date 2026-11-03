/**
 * [Pencil T15] issue 150 — the renderer's contract for 能力管理 · MCP.
 *
 * The page names a server or a form draft; it never names a file, a path, an
 * agent directory or a credential value. Every row here comes from main's
 * `shell/mcpOp` reply (Pi's own `mcp.json` reduced to a bounded view), and every
 * write is one exact-key request. There is deliberately no default/example row:
 * an unavailable list is an error state, not zero servers and not sample data.
 */

export const MCP_TRANSPORTS = ["stdio", "http"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export const MCP_TRANSPORT_TEXT: Record<McpTransport, string> = {
  stdio: "stdio · 本机子进程",
  http: "Streamable HTTP",
};

export const MCP_EXPOSURES = ["codemode", "deferred", "direct", "hidden", "codemode-deferred"] as const;
export type McpExposure = (typeof MCP_EXPOSURES)[number];

export const MCP_EXPOSURE_TEXT: Record<McpExposure, string> = {
  codemode: "codemode · 脚本内调用",
  deferred: "deferred · tool_search 后声明",
  direct: "direct · 直接声明给模型",
  hidden: "hidden · 注册但不可达",
  "codemode-deferred": "codemode-deferred · 同 codemode",
};

export type McpState = "enabled" | "disabled" | "error";
export const MCP_STATE_TEXT: Record<McpState, string> = {
  enabled: "已启用",
  disabled: "已停用",
  error: "配置错误",
};

export interface McpServerView {
  name: string;
  managed: boolean;
  label: string | null;
  transport: McpTransport | "invalid";
  enabled: boolean;
  state: McpState;
  error: { code: string; message: string } | null;
  command: string | null;
  args: string[];
  url: string | null;
  timeout: number | null;
  exposure: string;
  credentialRefs: { env: string[]; headers: string[] };
}

export interface McpStatus {
  servers: McpServerView[];
  path: string;
  sessionBoundary: { appliesTo: string; openSessionsMutated: boolean; note: string };
}

export interface McpDraft {
  name: string | null;
  transport: McpTransport;
  command: string;
  argsText: string;
  envText: string;
  cwd: string;
  url: string;
  headersText: string;
  timeout: string;
  exposure: McpExposure;
  description: string;
}

export const EMPTY_MCP_DRAFT: McpDraft = {
  name: null,
  transport: "stdio",
  command: "",
  argsText: "",
  envText: "",
  cwd: "",
  url: "",
  headersText: "",
  timeout: "60",
  // The session declares `direct` tools to the model; the other modes are Pi
  // CLI features whose codemode/tool_search tool this app does not load.
  exposure: "direct",
  description: "",
};

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function strings(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string" || item.length > 4096)) throw new Error("MCP 参考名返回异常");
  return value as string[];
}

function server(value: unknown): McpServerView {
  if (!object(value) || typeof value.name !== "string" || !SAFE_NAME.test(value.name) || typeof value.managed !== "boolean" ||
      !(value.label === null || typeof value.label === "string") ||
      !["stdio", "http", "invalid"].includes(String(value.transport)) || typeof value.enabled !== "boolean" ||
      !["enabled", "disabled", "error"].includes(String(value.state)) ||
      !(value.error === null || (object(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string")) ||
      !(value.command === null || typeof value.command === "string") || !strings(value.args, 64) ||
      !(value.url === null || typeof value.url === "string") ||
      !(value.timeout === null || (Number.isSafeInteger(value.timeout) && Number(value.timeout) > 0)) ||
      typeof value.exposure !== "string" || !object(value.credentialRefs)) {
    throw new Error("MCP Server 返回异常");
  }
  return {
    name: value.name,
    managed: value.managed,
    label: value.label,
    transport: value.transport as McpServerView["transport"],
    enabled: value.enabled,
    state: value.state as McpState,
    error: value.error as McpServerView["error"],
    command: value.command as string | null,
    args: value.args as string[],
    url: value.url as string | null,
    timeout: value.timeout as number | null,
    exposure: value.exposure as string,
    credentialRefs: {
      env: strings((value.credentialRefs as Record<string, unknown>).env, 100),
      headers: strings((value.credentialRefs as Record<string, unknown>).headers, 100),
    },
  };
}

export function parseMcpStatus(value: unknown): McpStatus {
  if (!object(value) || !Array.isArray(value.servers) || value.servers.length > 200 || typeof value.path !== "string" || !object(value.sessionBoundary) ||
      typeof value.sessionBoundary.appliesTo !== "string" || typeof value.sessionBoundary.openSessionsMutated !== "boolean" || typeof value.sessionBoundary.note !== "string") {
    throw new Error("MCP 清单返回异常");
  }
  return {
    servers: value.servers.map(server),
    path: value.path,
    sessionBoundary: { appliesTo: value.sessionBoundary.appliesTo, openSessionsMutated: value.sessionBoundary.openSessionsMutated, note: value.sessionBoundary.note },
  };
}

export function parseMcpSaved(value: unknown): McpServerView {
  if (!object(value) || typeof value.name !== "string" || typeof value.path !== "string") throw new Error("MCP 保存返回异常");
  return server(value.server);
}

export function parseMcpRemoved(value: unknown): { removed: string; path: string } {
  if (!object(value) || typeof value.removed !== "string" || typeof value.path !== "string") throw new Error("MCP 删除返回异常");
  return { removed: value.removed, path: value.path };
}

export interface McpTool { name: string; description: string; readOnly: boolean }
export interface McpTestResult {
  state: "connected" | "failed" | "disabled";
  tools: McpTool[];
  credentialRefs: { env: string[]; headers: string[] } | string[];
  error: { code: string; message: string } | null;
  durationMs?: number;
  name?: string;
}

export function parseMcpTest(value: unknown): McpTestResult {
  // [T19 / 154] main reports a connected test WITHOUT an `error` key and lists the
  // tools Pi returned (`name`, optional `description`); the read-only hint is a
  // tool annotation the connection test does not carry. Accepting the documented
  // Host shape is what makes the real 测试 result render instead of failing to parse.
  if (!object(value) || !["connected", "failed", "disabled"].includes(String(value.state)) || !Array.isArray(value.tools) ||
      !(value.error === undefined || value.error === null || (object(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string"))) {
    throw new Error("MCP 连接测试返回异常");
  }
  const tools = value.tools.map((tool) => {
    if (!object(tool) || typeof tool.name !== "string" || (tool.description !== undefined && typeof tool.description !== "string")) throw new Error("MCP 工具清单返回异常");
    return { name: tool.name, description: typeof tool.description === "string" ? tool.description : "", readOnly: tool.readOnly === true };
  });
  const refs = Array.isArray(value.credentialRefs) ? strings(value.credentialRefs, 200)
    : object(value.credentialRefs) ? { env: strings(value.credentialRefs.env, 100), headers: strings(value.credentialRefs.headers, 100) } : [];
  return { state: value.state as McpTestResult["state"], tools, credentialRefs: refs, error: (value.error ?? null) as McpTestResult["error"], ...(typeof value.durationMs === "number" ? { durationMs: value.durationMs } : {}), ...(typeof value.name === "string" ? { name: value.name } : {}) };
}

export async function mcpCall(
  bridge: { mcpOp?: (request: Record<string, unknown>) => Promise<{ ok: boolean; payload?: unknown; error?: string }> } | undefined,
  request: Record<string, unknown>,
): Promise<unknown> {
  if (typeof bridge?.mcpOp !== "function") throw new Error("桌面壳 MCP 接口不可用");
  const result = await bridge.mcpOp(request);
  if (!result || result.ok !== true) throw new Error(result?.error || "MCP 配置操作失败");
  return result.payload;
}

/**
 * `KEY=value` / `Header: value` per line; a blank line is ignored. A blank
 * VALUE is kept: on edit it means "keep the reference already stored", and main
 * refuses it when there is nothing to keep.
 */
export function parsePairs(text: string, separator: "=" | ":" = "="): Record<string, string> {
  const rows: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf(separator);
    if (index <= 0) throw new Error(separator === "=" ? `环境变量行需要 NAME=value：${trimmed}` : `Header 行需要 Name: value：${trimmed}`);
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    // A blank value is meaningful on edit: main keeps the stored reference.
    if (!key) throw new Error(separator === "=" ? `环境变量行需要 NAME=value：${trimmed}` : `Header 行需要 Name: value：${trimmed}`);
    rows[key] = value;
  }
  return rows;
}

export function pairsText(rows: Record<string, string>): string {
  return Object.entries(rows).map(([key, value]) => `${key}=${value}`).join("\n");
}

export function headersText(rows: Record<string, string>): string {
  return Object.entries(rows).map(([key, value]) => `${key}: ${value}`).join("\n");
}

/** The exact `input` main validates; no name/path/file field can be smuggled in. */
export function draftRequest(draft: McpDraft): { name?: string; input: Record<string, unknown> } {
  const input: Record<string, unknown> = { transport: draft.transport, exposure: draft.exposure };
  if (draft.description.trim()) input.description = draft.description.trim();
  if (draft.timeout.trim()) {
    const timeout = Number(draft.timeout);
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600) throw new Error("超时必须是 1–600 的整数秒");
    input.timeout = timeout;
  }
  if (draft.transport === "stdio") {
    if (!draft.command.trim()) throw new Error("stdio Server 需要 command");
    input.command = draft.command.trim();
    const args = draft.argsText.split("\n").map((line) => line.trim()).filter(Boolean);
    if (args.length > 0) input.args = args;
    const env = parsePairs(draft.envText);
    if (Object.keys(env).length > 0) input.env = env;
    if (draft.cwd.trim()) input.cwd = draft.cwd.trim();
  } else {
    if (!draft.url.trim()) throw new Error("HTTP Server 需要 URL");
    input.url = draft.url.trim();
    const headers = parsePairs(draft.headersText, ":");
    if (Object.keys(headers).length > 0) input.headers = headers;
  }
  return { ...(draft.name === null ? {} : { name: draft.name }), input };
}

export function draftFromView(view: McpServerView): McpDraft {
  return {
    name: view.name,
    transport: view.transport === "http" ? "http" : "stdio",
    command: view.command ?? "",
    argsText: view.args.join("\n"),
    envText: view.credentialRefs.env.map((key) => `${key}=`).join("\n"),
    cwd: "",
    url: view.url ?? "",
    headersText: view.credentialRefs.headers.map((key) => `${key}: `).join("\n"),
    timeout: view.timeout === null ? "60" : String(view.timeout),
    exposure: (MCP_EXPOSURES as readonly string[]).includes(view.exposure) ? view.exposure as McpExposure : "codemode",
    description: view.label ?? "",
  };
}
