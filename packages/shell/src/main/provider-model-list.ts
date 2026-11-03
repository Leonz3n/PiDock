/**
 * Real model-list transport for [PiDock T03] #138.
 *
 * `syncModelCandidates` (provider-discovery.ts) is the pure state machine; this
 * module is the one production transport it was designed to be injected with:
 * a bounded HTTP GET to the protocol's own model-list endpoint, carrying the
 * stored credential in that protocol's own auth convention.
 *
 * Trust rules:
 * - The credential is used for this request only. It is never logged, never put
 *   in an error message, and never echoed into an outcome.
 * - Any answer that is not a JSON object with a model array is a *failure* with
 *   a named reason, not a silent empty list.
 * - 404/405 means "this endpoint does not expose model discovery", which is the
 *   `unsupported` outcome — not a failure and not an empty provider.
 */

import type { ModelListTransport } from "./provider-discovery.js";
import { protocolDescriptor } from "./provider-protocol.js";

/** Marker the transport uses to report a non-`ok` attempt without leaking body text. */
export interface ModelListHttpFailure {
  status: number | null;
  kind: "auth-rejected" | "not-found" | "rate-limited" | "provider-error" | "network-unreachable" | "timeout" | "invalid-response";
}

const TIMEOUT_MS = 15_000;

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Protocol-correct headers; the key value only ever appears here. */
export function discoveryHeaders(protocol: string, key: string): Record<string, string> {
  const descriptor = protocolDescriptor(protocol);
  const headers: Record<string, string> = { accept: "application/json" };
  if (descriptor.modelListAuth === "x-api-key") {
    headers["x-api-key"] = key;
    // Anthropic requires an explicit API version on every request.
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["authorization"] = `Bearer ${key}`;
  }
  return headers;
}

/**
 * Reads the model ids out of a discovery payload. OpenAI-compatible servers
 * answer `{ data: [{ id }] }`; a couple of gateways answer `{ models: [...] }`
 * or a bare array. Only `id`/`name` strings are read — nothing about the id is
 * interpreted as capability.
 */
export function readModelIds(payload: unknown): { ids: unknown[]; shape: "data" | "models" | "array" | "unknown" } {
  if (Array.isArray(payload)) return { ids: payload.map(idOf), shape: "array" };
  if (typeof payload === "object" && payload !== null) {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record["data"])) return { ids: record["data"].map(idOf), shape: "data" };
    if (Array.isArray(record["models"])) return { ids: record["models"].map(idOf), shape: "models" };
  }
  return { ids: [], shape: "unknown" };
}

function idOf(entry: unknown): unknown {
  if (typeof entry === "string") return entry;
  if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
    const record = entry as Record<string, unknown>;
    if (typeof record["id"] === "string") return record["id"];
    if (typeof record["name"] === "string") return record["name"];
  }
  return undefined;
}

export interface HttpModelListOptions {
  /** The credential resolved in main for this one attempt. */
  apiKey: string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/**
 * Builds the production transport. `unsupported` is signalled by throwing the
 * same fixed wording `syncModelCandidates` uses for a connection that declares
 * no endpoint, so the UI state is identical whichever reason applied.
 */
export function createHttpModelListTransport(options: HttpModelListOptions): ModelListTransport {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  return async ({ baseUrl, protocol, path }) => {
    const descriptor = protocolDescriptor(protocol);
    if (descriptor.modelListPath === null) {
      return { ok: false, unsupported: true, message: "当前连接未声明模型发现端点" };
    }
    const target = joinUrl(baseUrl, path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(target, {
        method: "GET",
        headers: discoveryHeaders(protocol, options.apiKey),
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status === 404 || response.status === 405) {
        // Not a failure: this endpoint simply does not expose discovery.
        return { ok: false, unsupported: true, message: "该端点未提供模型列表（HTTP 404/405）" };
      }
      if (response.status === 401 || response.status === 403) return { ok: false, message: "凭据被端点拒绝（HTTP 401/403）" };
      if (response.status === 429) return { ok: false, message: "端点返回限流（HTTP 429）" };
      if (!response.ok) return { ok: false, message: `端点返回 HTTP ${response.status}` };
      let payload: unknown;
      try { payload = await response.json(); }
      catch { return { ok: false, message: "端点返回的不是 JSON" }; }
      const { ids, shape } = readModelIds(payload);
      if (shape === "unknown") return { ok: false, message: "端点返回的结构不是模型列表" };
      return { ok: true, ids };
    } catch (error) {
      // AbortError = our own deadline; anything else is a transport failure.
      const aborted = error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"));
      return { ok: false, message: aborted ? `模型发现请求超时（${Math.round(timeoutMs / 1000)}s）` : "无法连接端点" };
    } finally {
      clearTimeout(timer);
    }
  };
}
