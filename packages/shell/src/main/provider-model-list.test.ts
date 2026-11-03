/**
 * The real model-discovery transport — [PiDock T03] #138.
 *
 * `provider-native-flow.test.ts` covers the state machine with an injected
 * transport; this file answers the other question: does the production
 * transport really speak each protocol's own convention? A loopback server
 * records the method, path and headers, and the outcome must distinguish
 * success / empty / auth-rejected / unsupported / broken JSON — without ever
 * putting the key into a message.
 */

import { createServer, type IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpModelListTransport } from "./provider-model-list.js";

const KEY = "sk-discovery-0123456789-abcdefghij";
const servers: ReturnType<typeof createServer>[] = [];

async function loopback(handle: (request: IncomingMessage, body: string) => { status: number; json?: unknown; text?: string }) {
  const seen: { method: string; url: string; headers: IncomingMessage["headers"] }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers });
      const reply = handle(request, Buffer.concat(chunks).toString("utf8"));
      if (reply.json !== undefined) {
        response.writeHead(reply.status, { "content-type": "application/json" });
        response.end(JSON.stringify(reply.json));
      } else {
        response.writeHead(reply.status, { "content-type": "text/plain" });
        response.end(reply.text ?? "");
      }
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
  return { seen, baseUrl: `http://127.0.0.1:${port}/v1` };
}

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

const run = (baseUrl: string, protocol: string, path = "/models") => {
  const transport = createHttpModelListTransport({ apiKey: KEY });
  return transport({ baseUrl, protocol, path });
};

describe("HTTP model discovery", () => {
  it("reads the OpenAI-compatible list with a bearer credential and the right path", async () => {
    const { seen, baseUrl } = await loopback(() => ({ status: 200, json: { object: "list", data: [{ id: "gpt-5" }, { id: "gpt-5-mini" }] } }));
    const outcome = await run(baseUrl, "openai-completions");
    expect(outcome).toEqual({ ok: true, ids: ["gpt-5", "gpt-5-mini"] });
    expect(seen[0]).toMatchObject({ method: "GET", url: "/v1/models" });
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0]?.headers["x-api-key"]).toBeUndefined();
  });

  it("uses x-api-key and the API version for anthropic-messages", async () => {
    const { seen, baseUrl } = await loopback(() => ({ status: 200, json: { data: [{ id: "claude-sonnet-4-5" }] } }));
    const outcome = await run(baseUrl, "anthropic-messages");
    expect(outcome).toEqual({ ok: true, ids: ["claude-sonnet-4-5"] });
    expect(seen[0]?.headers["x-api-key"]).toBe(KEY);
    expect(seen[0]?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(seen[0]?.headers.authorization).toBeUndefined();
  });

  it("reads both OpenAI protocols from the same /models endpoint", async () => {
    const { seen, baseUrl } = await loopback(() => ({ status: 200, json: { models: ["m-1"] } }));
    expect(await run(baseUrl, "openai-responses")).toEqual({ ok: true, ids: ["m-1"] });
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0]?.url).toBe("/v1/models");
  });

  it("treats an empty array as success with no candidates, never as a failure", async () => {
    const { baseUrl } = await loopback(() => ({ status: 200, json: { data: [] } }));
    expect(await run(baseUrl, "openai-completions")).toEqual({ ok: true, ids: [] });
  });

  it("names 404/405 as unsupported, not as an empty provider", async () => {
    const { baseUrl } = await loopback(() => ({ status: 404, json: { error: "not found" } }));
    const outcome = await run(baseUrl, "openai-completions");
    expect(outcome).toMatchObject({ ok: false, unsupported: true });
    expect(JSON.stringify(outcome)).not.toContain(KEY);
  });

  it("names auth rejection, rate limiting and provider errors without echoing the key", async () => {
    for (const [status, message] of [[401, "凭据被端点拒绝（HTTP 401/403）"], [403, "凭据被端点拒绝（HTTP 401/403）"],
      [429, "端点返回限流（HTTP 429）"], [500, "端点返回 HTTP 500"]] as [number, string][]) {
      const { baseUrl } = await loopback(() => ({ status, text: `upstream says ${KEY}` }));
      const outcome = await run(baseUrl, "openai-completions");
      expect(outcome).toEqual({ ok: false, message });
      expect(JSON.stringify(outcome)).not.toContain(KEY);
    }
  });

  it("refuses a body that is not a model list instead of reporting zero models", async () => {
    const { baseUrl } = await loopback(() => ({ status: 200, text: `<html>${KEY}</html>` }));
    const outcome = await run(baseUrl, "openai-completions");
    expect(outcome).toEqual({ ok: false, message: "端点返回的不是 JSON" });
    expect(JSON.stringify(outcome)).not.toContain(KEY);
  });

  it("reports an unreachable endpoint and a deadline as bounded failures", async () => {
    const unreachable = await run("http://127.0.0.1:1/v1", "openai-completions");
    expect(unreachable).toEqual({ ok: false, message: "无法连接端点" });
    // A server that never answers hits the transport's own deadline.
    const stalled = createServer(() => { /* never responds */ });
    servers.push(stalled);
    const port = await new Promise<number>((resolve) => stalled.listen(0, "127.0.0.1", () => resolve((stalled.address() as { port: number }).port)));
    const transport = createHttpModelListTransport({ apiKey: KEY, timeoutMs: 150 });
    const timeout = await transport({ baseUrl: `http://127.0.0.1:${port}/v1`, protocol: "openai-completions", path: "/models" });
    expect(timeout).toEqual({ ok: false, message: "模型发现请求超时（0s）" });
  });
});
