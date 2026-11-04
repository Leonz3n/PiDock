import type { McpPrivateBinding } from "../mcp-oauth-native.js";
/**
 * [Pencil T15] #150: the task session's MCP binding.
 *
 * Two jobs, both scoped to ONE session that is starting:
 *
 * 1. `readManagedMcpConfig` turns the exact `mcp.json` main manages into the
 *    `LoadedMcpConfig` Pi's own MCP extension expects. Only `mcpServers` is
 *    read — never `<project>/.pi/mcp.json`, because a repository must not be
 *    able to add a server (or a credential reference) to a task session. An
 *    entry Pi cannot use is reported by server name and skipped; its value is
 *    never copied into a log or an error message.
 *
 * 2. `mcpExtension` wraps `createMcpExtension()` with the one permission hook
 *    the rest of PiDock requires: before a `mcp__<server>__<tool>` executes, the
 *    hook asks the Host's existing tool broker (same gate, approval, scope and
 *    one-shot recheck as `fs.*`/`exec.run`). The extension still owns the
 *    server connection and performs the call, because the connection lives in
 *    this worker; only the decision travels to the Host. A refusal is returned
 *    as a blocked tool call, never as a local fallback.
 *
 * The config is read when the session starts (and never again), which is what
 * makes a save/enable/disable in the manager apply to the next session while an
 * already-open session keeps exactly the servers it loaded.
 */

import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  createMcpExtension,
  type ExtensionAPI,
  type ExtensionFactory,
  type McpExtensionOptions,
  type ToolCallEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { MCP_TOOL_GATE, type SdkAgentToolCaller } from "./sdk-agent-tool-contract.js";

const MAX_CONFIG_BYTES = 2_000_000;
const MAX_NAME = 128;

/** The exact shape Pi's MCP extension consumes; typed from its own option. */
type LoadConfig = NonNullable<McpExtensionOptions["loadConfig"]>;
type LoadedMcpConfig = ReturnType<LoadConfig>;

export interface ManagedMcpConfig {
  loadConfig: LoadConfig;
  /** Enabled server names in file order, for a bounded session readout. */
  names(): string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nameOf(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) && value.length <= MAX_NAME ? value : null;
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 64 && value.every((item) => typeof item === "string" && item.length <= 4096);
}

function stringMap(value: unknown): value is Record<string, string> {
  return record(value) && Object.keys(value).length <= 100 && Object.values(value).every((item) => typeof item === "string" && item.length <= 8192);
}

/** Validate one stored entry structurally; Pi resolves the reference values. */
function entryError(name: string, entry: unknown): string | null {
  if (!record(entry)) return `server "${name}": entry is not an object`;
  const type = entry["type"];
  if (type === "sse") return `server "${name}": legacy SSE is not supported; use streamable HTTP`;
  if (type !== undefined && type !== "stdio" && type !== "http" && type !== "streamable-http") return `server "${name}": unsupported type`;
  if (type === "stdio" || (entry["command"] !== undefined && entry["url"] === undefined)) {
    if (typeof entry["command"] !== "string" || entry["command"].trim().length === 0) return `server "${name}": command is missing`;
    if (entry["args"] !== undefined && !stringList(entry["args"])) return `server "${name}": args must be a string list`;
    if (entry["env"] !== undefined && !stringMap(entry["env"])) return `server "${name}": env must be string values`;
    if (entry["cwd"] !== undefined && typeof entry["cwd"] !== "string") return `server "${name}": cwd must be a string`;
    return null;
  }
  if (typeof entry["url"] !== "string" || entry["url"].length === 0) return `server "${name}": url is missing`;
  try {
    const url = new URL(entry["url"]);
    if (url.protocol !== "http:" && url.protocol !== "https:") return `server "${name}": url must be http(s)`;
  } catch { return `server "${name}": url is not a URL`; }
  if (entry["headers"] !== undefined && !stringMap(entry["headers"])) return `server "${name}": headers must be string values`;
  return null;
}

/**
 * Read the one file main edits. `agentDir` is not consulted: a session loads
 * the path the Host was given, so it cannot drift to a second copy.
 */
export function readManagedMcpConfig(path: string, binding?: McpPrivateBinding): ManagedMcpConfig {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("mcp-config-path-invalid");
  const errors: string[] = [];
  let parsed: unknown = {};
  try {
    const file = lstatSync(path);
    if (!file.isFile()) errors.push("mcp.json is not a regular file");
    else if (file.size > MAX_CONFIG_BYTES) errors.push("mcp.json is too large");
    else parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    // Missing is not an error (a task may have no MCP config); anything else is
    // reported by name, never with the file's text.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push("mcp.json is not readable JSON");
  }
  const servers: Array<{ name: string; config: Record<string, unknown>; source: string; scope: "global" }> = [];
  const root = record(parsed) ? parsed : {};
  if (!record(root["mcpServers"])) {
    if (root["mcpServers"] !== undefined) errors.push("mcpServers must be an object");
  } else {
    for (const [rawName, entry] of Object.entries(root["mcpServers"] as Record<string, unknown>)) {
      const name = nameOf(rawName);
      if (name === null) { errors.push("a server name is not a safe identifier"); continue; }
      const invalid = entryError(name, entry);
      if (invalid !== null) { errors.push(invalid); continue; }
      const config = { ...(entry as Record<string, unknown>) };
      const oauth = config["oauth"];
      if (record(oauth) && typeof oauth["clientSecret"] === "string") {
        const secret = oauth["clientSecret"];
        if (secret.startsWith("!") || secret.includes("$")) {
          const resolved = binding?.secrets?.find(row => row.name === name && row.url === String(new URL(String(config["url"]))));
          if (!resolved || secret.startsWith("!")) { errors.push(`server "${name}": OAuth secret reference unavailable`); continue; }
          config["oauth"] = { ...oauth, clientSecret: resolved.value };
        }
      }
      servers.push({ name, config, source: path, scope: "global" });
    }
  }
  return {
    loadConfig: () => ({ servers, autoEnableCodemode: false, errors }) as unknown as LoadedMcpConfig,
    names: () => servers.filter((server) => server.config["enabled"] !== false).map((server) => server.name),
  };
}

/**
 * Wrap Pi's MCP extension with the Host permission hook. `call` is the same
 * `SdkAgentToolCaller` the task tools use, so the decision is made by the one
 * broker; the held `readOnly` map comes from the tool definitions Pi registers
 * (`annotations.readOnlyHint`), never from the model's arguments.
 */
export interface McpBinding {
  factory: ExtensionFactory;
  /**
   * Run the MCP extension's own `session_shutdown` handler. `AgentSession.
   * dispose()` invalidates the runner but does NOT emit that event, so without
   * this the real stdio child would outlive a stop/cancel. Idempotent.
   */
  close(): Promise<void>;
}

export function mcpExtension(sessionId: string, call: SdkAgentToolCaller, loadConfig: LoadConfig, logPath?: string, credentials?: McpExtensionOptions["credentials"]): McpBinding {
  const readOnly = new Map<string, boolean>();
  const shutdown: Array<() => Promise<void> | void> = [];
  const factory: ExtensionFactory = (pi: ExtensionAPI) => {
    // Capture the MCP extension's shutdown handler: the only public hook into
    // its connection lifetime (it registers it on `pi`). The handler ignores
    // the event context, so a named synthetic event is enough.
    const on = pi.on.bind(pi);
    pi.on = ((event: string, handler: (...args: never[]) => unknown) => {
      if (event === "session_shutdown") {
        shutdown.push(async () => { await handler({ type: "session_shutdown", reason: "quit" } as never, undefined as never); });
      }
      return on(event as never, handler as never);
    }) as typeof pi.on;
    // `loadConfig` is pinned to the exact file main manages. Without it Pi would
    // read the process-wide agent directory, which is a different file (and
    // would ignore `PIDOCK_AGENT_DIR` / a test's task-local agent dir).
    const mcp = createMcpExtension({ loadConfig, ...(credentials ? { credentials } : {}), ...(logPath === undefined ? {} : { logPath }) });
    const register = pi.registerTool.bind(pi);
    pi.registerTool = ((tool: ToolDefinition) => {
      if (typeof tool.name === "string" && tool.name.startsWith("mcp__")) {
        const annotations = (tool as { annotations?: { readOnlyHint?: boolean } }).annotations;
        readOnly.set(tool.name, annotations?.readOnlyHint === true);
      }
      register(tool);
    }) as typeof pi.registerTool;
    mcp(pi);
    pi.on("tool_call", async (event: ToolCallEvent) => {
      if (!event.toolName.startsWith("mcp__")) return undefined;
      const args = record(event.input) ? event.input : {};
      const outcome = await call(sessionId, { tool: MCP_TOOL_GATE, args: { name: event.toolName, readOnly: readOnly.get(event.toolName) === true, args } });
      if (outcome.outcome === "ok") return undefined;
      return { block: true, reason: outcome.text };
    });
  };
  return {
    factory,
    async close() {
      for (const handler of shutdown.splice(0)) await handler();
    },
  };
}
