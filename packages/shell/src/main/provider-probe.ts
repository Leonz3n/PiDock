/**
 * Real connectivity check for [PiDock T03] #138.
 *
 * 「测试连通性」 must be an actual model request, not a successful model-list
 * fetch relabelled: a provider can list models while the model itself rejects
 * the credential, the protocol or the payload. So this module sends one
 * minimally-sized request shaped by the profile's own protocol and reports a
 * named outcome.
 *
 * Every failure is mapped to a bounded code and a fixed sentence. Response
 * bodies are never read (they can echo the credential) and the credential is
 * never included in any message, so nothing from here can reach a log or a
 * renderer with a secret in it.
 */

import { buildProtocolRequest, protocolDescriptor } from "./provider-protocol.js";

export type ProbeFailureCode =
  | "auth-rejected"
  | "endpoint-not-found"
  | "rate-limited"
  | "provider-error"
  | "network-unreachable"
  | "timeout";

export interface ProbeOutcome {
  ok: boolean;
  protocol: string;
  /** HTTP status when the endpoint answered; `null` when no response arrived. */
  status: number | null;
  code: ProbeFailureCode | null;
  /** Bounded, user-facing sentence. Never contains the credential or body text. */
  message: string;
  latencyMs: number;
}

const TIMEOUT_MS = 20_000;

export interface ProbeInput {
  protocol: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Declared max output; the probe asks for a single token when unset. */
  maxOutput?: number;
}

export interface ProbeDeps {
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
  now?: () => number;
}

function failure(code: ProbeFailureCode, message: string, protocol: string, latencyMs: number, status: number | null = null): ProbeOutcome {
  return { ok: false, protocol, status, code, message, latencyMs };
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Headers for one real request; the value of the key only ever appears here. */
export function probeHeaders(protocol: string, key: string): Record<string, string> {
  const descriptor = protocolDescriptor(protocol);
  if (descriptor.modelListAuth === "x-api-key") {
    return { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" };
  }
  return { "content-type": "application/json", authorization: `Bearer ${key}` };
}

/**
 * One real request against the configured protocol. `latencyMs` is measured
 * around the request, so a long round trip is visible as itself rather than as
 * a generic failure.
 */
export async function probeConnection(input: ProbeInput, deps: ProbeDeps = {}): Promise<ProbeOutcome> {
  const descriptor = protocolDescriptor(input.protocol);
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  const now = deps.now ?? (() => Date.now());
  const controller = new AbortController();
  const started = now();
  const elapsed = () => Math.max(0, now() - started);
  // A single token keeps the probe cheap while still proving the credential and
  // the protocol are accepted by a real model request.
  const maxOutput = Math.min(input.maxOutput ?? 1, 16) || 1;
  const body = JSON.stringify(buildProtocolRequest(input.protocol, {
    model: input.model,
    turns: [{ role: "user", text: "ping" }],
    maxOutput,
    stream: false,
  }));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(joinUrl(input.baseUrl, descriptor.requestPath), {
      method: "POST",
      headers: probeHeaders(input.protocol, input.apiKey),
      body,
      redirect: "manual",
      signal: controller.signal,
    });
    const status = response.status;
    const latencyMs = elapsed();
    // Never read the body: it may echo the credential, and connectivity is
    // answered by the status alone.
    try { await response.body?.cancel(); } catch { /* already closed */ }
    if (status >= 200 && status < 300) {
      return { ok: true, protocol: input.protocol, status, code: null, message: `连通正常（HTTP ${status}，${latencyMs}ms）`, latencyMs };
    }
    if (status === 401 || status === 403) return failure("auth-rejected", `凭据被端点拒绝（HTTP ${status}）`, input.protocol, latencyMs, status);
    if (status === 404) return failure("endpoint-not-found", "端点不存在（HTTP 404），请检查 Base URL 与协议", input.protocol, latencyMs, status);
    if (status === 429) return failure("rate-limited", "端点限流（HTTP 429），请稍后重试", input.protocol, latencyMs, status);
    if (status >= 400 && status < 500) return failure("provider-error", `请求被端点拒绝（HTTP ${status}），请检查模型 ID 与协议`, input.protocol, latencyMs, status);
    return failure("provider-error", `端点返回服务端错误（HTTP ${status}）`, input.protocol, latencyMs, status);
  } catch (error) {
    const latencyMs = elapsed();
    const aborted = error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"));
    if (aborted) return failure("timeout", `连接超时（${Math.round(timeoutMs / 1000)}s）`, input.protocol, latencyMs);
    return failure("network-unreachable", "无法连接端点（网络或 DNS 失败）", input.protocol, latencyMs);
  } finally {
    clearTimeout(timer);
  }
}
