#!/usr/bin/env node
/**
 * A tiny real MCP server over stdio for [#150] tests and smoke checks.
 *
 * It speaks newline-delimited JSON-RPC exactly like an MCP stdio server: the
 * same `initialize` handshake, `tools/list` and `tools/call` the SDK's
 * `StdioTransport` drives. Nothing here is mocked in-process — the SDK starts
 * this Node process, talks to it over pipes and must dispose it.
 *
 * `MCP_FIXTURE_LOG` (optional) appends one line per request so a test can prove
 * the process really ran and which tool input arrived.
 *
 * `MCP_FIXTURE_PID` (optional) writes this process's pid at startup. A test can
 * then assert the real child is gone after a session stop/cancel (no orphan),
 * instead of inferring it from the absence of further log lines.
 */

import { appendFileSync, writeFileSync } from "node:fs";

const pidPath = process.env["MCP_FIXTURE_PID"];
if (pidPath) {
  try { writeFileSync(pidPath, String(process.pid)); } catch { /* best effort */ }
}

const PROTOCOL = "2025-06-18";
const tools = [
  {
    name: "echo",
    description: "Echo the given text back, prefixed with `fixture:`.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to echo" } },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    // No `readOnlyHint`: the permission gate must treat it as a command tool,
    // so `default` asks first and a read-only session refuses it.
    name: "mutate",
    description: "Pretend to change state; used to prove a non-read MCP call is gated.",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string", description: "Value to record" } },
      required: ["value"],
      additionalProperties: false,
    },
  },
];

function log(line) {
  const path = process.env["MCP_FIXTURE_LOG"];
  if (!path) return;
  try { appendFileSync(path, `${line}\n`); } catch { /* best effort */ }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(request) {
  log(`${request.method} ${JSON.stringify(request.params ?? null)}`);
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "pidock-mcp-fixture", version: "1.0.0" },
        instructions: "A fixture MCP server used by PiDock tests.",
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools };
    case "tools/call": {
      const params = request.params ?? {};
      if (params.name === "mutate") {
        const value = params.arguments?.value;
        if (typeof value !== "string") return { content: [{ type: "text", text: "missing value" }], isError: true };
        return { content: [{ type: "text", text: `mutated: ${value}` }], isError: false };
      }
      if (params.name !== "echo") {
        return { __error: { code: -32602, message: `unknown tool ${String(params.name)}` } };
      }
      const text = params.arguments?.text;
      if (typeof text !== "string") return { content: [{ type: "text", text: "missing text" }], isError: true };
      return { content: [{ type: "text", text: `fixture: ${text}` }], isError: false };
    }
    default:
      return { __error: { code: -32601, message: `method not found: ${String(request.method)}` } };
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    if (message.id === undefined || message.id === null) continue; // notification
    const result = handle(message);
    if (result && result.__error) send({ jsonrpc: "2.0", id: message.id, error: result.__error });
    else send({ jsonrpc: "2.0", id: message.id, result });
  }
});
process.stdin.on("end", () => process.exit(0));
