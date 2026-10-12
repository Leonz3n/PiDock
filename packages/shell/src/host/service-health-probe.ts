/**
 * [PiDock 04] (#7 box 5) the REAL health half of one task-bound service: a
 * single, bounded probe of the 健康检查 the PINNED revision declares.
 *
 * Until this module, the declared check was validated, persisted, carried into
 * the launch record and shown as a template label - and then never executed:
 * `service-public.ts` hard-coded `health: "not-probed"`, so no result could
 * exist and none could be displayed. This module produces the observation; the
 * two readers (`host/service-public.ts` for the UI row, the Agent's
 * `service.status` text) render it. A probe whose result nothing can read is
 * not a delivered capability, so both readers are wired in the same slice.
 *
 * The rules this probe obeys, because each one is a way a health read could
 * lie:
 * - DECLARED, never invented: the target is exactly the pinned revision's own
 *   `descriptor.healthCheck.target`. This module never derives a target from
 *   the descriptor's ports (a port list is a declaration, not a probe target),
 *   never takes one from a caller, and NEVER follows a redirect (see
 *   `probeHttp`), so no answer can be steered to a host the revision did not
 *   declare.
 * - RUNNING FIRST: a service whose process is not alive is never dialled - the
 *   read says 未探测 and names why. Nothing here starts, stops or restarts
 *   anything; the probe is a read with a socket, and `lifecycle` (process
 *   liveness) is a fact this module neither reads nor can change.
 * - ONE BOUNDED ATTEMPT: `SERVICE_HEALTH_PROBE_BOUND_MS` is the whole budget -
 *   one connection, one request, no retry, no re-resolution loop. A target that
 *   accepts the connection and then answers nothing cannot hold the read: the
 *   attempt is destroyed at the bound and the outcome names 超时.
 * - THE STATUS LINE IS THE OBSERVATION: an http probe reads the status line and
 *   nothing else (the response is destroyed on headers, so the body is never
 *   consumed and a slow declared body cannot delay an answer that is already
 *   in). A 2xx is the pass; a 3xx is reported as itself by name instead of
 *   being followed; anything else is a named failure with the real code.
 * - UNIMPLEMENTED IS NAMED, NEVER GREEN: this repository has no gRPC client and
 *   no new dependency is allowed, so a declared `grpc` check is reported as an
 *   explicitly named unimplemented state (`not-probed` + the gRPC reason) -
 *   never as healthy and never as a silent "no result".
 * - A PASS IS ONLY A PASS: no default, no fallback and no error path of this
 *   module answers `healthy`. Only a real 2xx (http) or a real completed
 *   connect (tcp) does.
 *
 * The declared kinds and the target validation live in
 * `main/service-config.ts` (`ServiceHealthKind`,
 * `validateSharedServiceHealthTarget`): a target is single-line, bounded, and
 * never a machine file path or a credential.
 */

import { request as httpRequest } from "node:http";
import { connect as tcpConnect, type Socket } from "node:net";
import type { ServiceHealthKind } from "../main/service-config.js";

/**
 * The whole budget of ONE probe attempt, in milliseconds: connect + request +
 * response headers for the one connection this module opens. Chosen (rather
 * than left unbounded) so a status read cannot hang the UI: it is far above a
 * healthy loopback round trip and far below a person's patience. There is no
 * second attempt - giving up at the bound IS the outcome, and it is named.
 */
export const SERVICE_HEALTH_PROBE_BOUND_MS = 1500;

/**
 * The named state of one health observation. `healthy` is the ONLY state that
 * reads as a pass: `not-probed` (nothing was dialled, by name) and `undeclared`
 * (the pinned revision declares no check at all) are the states this slice
 * exists to keep apart from a result.
 */
export type ServiceHealthState = "healthy" | "unhealthy" | "not-probed" | "undeclared";

/**
 * One health observation, carrying only what really happened. `elapsedMs` and
 * `boundMs` are present IF AND ONLY IF a connection was really attempted, so a
 * `not-probed`/`undeclared` row can never carry a duration that would imply a
 * probe ran. `reason` names the outcome whenever it is not `healthy`; it is
 * absent only for a real pass, whose facts (kind/target/statusCode) are the
 * whole statement.
 */
export interface ServiceHealthObservation {
  state: ServiceHealthState;
  /** The declared kind that was (or was not) probed. */
  kind?: ServiceHealthKind;
  /** The declared target, echoed verbatim - never a target derived from anything else. */
  target?: string;
  /** The real status code of the declared http target (present only for http). */
  statusCode?: number;
  /** Real wall time of the single attempt; present only when one was made. */
  elapsedMs?: number;
  /** The bound that attempt was given; present only when one was made. */
  boundMs?: number;
  /** Why this is not a pass, in the reader's own language. Absent only for `healthy`. */
  reason?: string;
}

/**
 * A declared check, as the pinned revision carries it (`ServiceDescriptor`'s
 * own shape). Passed in rather than a whole record, so the probe has no
 * dependency on the runtime record and cannot read liveness from it.
 */
export interface DeclaredHealthCheck {
  kind: ServiceHealthKind;
  target?: string;
}

/**
 * The honest state of a read that produced no observation (no probe ran), e.g.
 * a projection built by a caller that is not the Host's status read. It is
 * NEVER `healthy`: an unprobed thing says so, by name, and says WHO did not
 * probe it, so a missing wire shows up in the UI instead of reading as a pass.
 */
export function unprobedServiceHealth(healthCheck: DeclaredHealthCheck | undefined): ServiceHealthObservation {
  if (healthCheck === undefined) return { state: "undeclared" };
  return {
    state: "not-probed",
    kind: healthCheck.kind,
    ...(healthCheck.target === undefined ? {} : { target: healthCheck.target }),
    reason: "本次读取未执行探测（读取方未提供探测结果）",
  };
}

/**
 * One bounded probe attempt of the declared check. The caller states the two
 * facts the probe may not assume: the PINNED revision's declaration and whether
 * this service's process is really alive right now. The answer is always one of
 * the four named states - this function never throws (a refused status read
 * would be worse than a named failure) and never returns `healthy` without a
 * real 2xx / completed connect.
 */
export async function probeServiceHealth(input: {
  /** `record.descriptor.healthCheck` of the pinned revision; absent = 未声明. */
  healthCheck?: DeclaredHealthCheck;
  /** `record.lifecycle === "running"` - process liveness, not a request. */
  running: boolean;
  /** Overrides `SERVICE_HEALTH_PROBE_BOUND_MS` (tests lower it; production does not). */
  boundMs?: number;
}): Promise<ServiceHealthObservation> {
  const check = input.healthCheck;
  if (check === undefined) return { state: "undeclared" };
  if (!input.running) {
    return {
      state: "not-probed",
      kind: check.kind,
      ...(check.target === undefined ? {} : { target: check.target }),
      reason: "服务未运行，不发起探测",
    };
  }
  if (check.kind === "grpc") {
    return {
      state: "not-probed",
      kind: "grpc",
      ...(check.target === undefined ? {} : { target: check.target }),
      reason: "gRPC 健康探测尚未接入（本仓库无 gRPC 客户端且不新增依赖）",
    };
  }
  const target = check.target?.trim() ?? "";
  if (target.length === 0) {
    return { state: "not-probed", kind: check.kind, reason: "健康检查未声明目标地址，不发起探测" };
  }
  const boundMs = input.boundMs ?? SERVICE_HEALTH_PROBE_BOUND_MS;
  return check.kind === "http" ? await probeHttp(target, boundMs) : await probeTcp(target, boundMs);
}

/**
 * One bounded HTTP attempt against the declared target. The status line is the
 * whole observation: the response body is destroyed on headers, so nothing a
 * declared target streams is consumed (a `Content-Length` of gigabytes cannot
 * make this read read), and a target that answers 200 and then stalls still
 * answers 200. Redirects are NOT followed - a 3xx is reported as itself, by
 * name, because following one would probe a host the revision never declared.
 */
async function probeHttp(target: string, boundMs: number): Promise<ServiceHealthObservation> {
  const base = { kind: "http" as const, target };
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { ...base, state: "not-probed", reason: "健康检查目标不是可解析的地址，不发起探测" };
  }
  if (url.protocol !== "http:" || url.hostname.length === 0) {
    return { ...base, state: "not-probed", reason: `健康检查目标协议 ${url.protocol} 尚未接入探测（本机只探测 http/tcp）` };
  }
  const startedAt = Date.now();
  return await new Promise<ServiceHealthObservation>((resolve) => {
    let settled = false;
    const elapsed = () => Date.now() - startedAt;
    const finish = (observation: ServiceHealthObservation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      resolve(observation);
    };
    const timer = setTimeout(() => finish({
      ...base, state: "unhealthy", reason: `探测超时：${String(boundMs)}ms 内未取得响应`, elapsedMs: elapsed(), boundMs,
    }), boundMs);
    const request = httpRequest({
      protocol: "http:",
      hostname: url.hostname,
      port: url.port === "" ? 80 : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: "GET",
      // A fresh connection per attempt: no pooled socket may answer a later
      // read, and nothing of this probe survives it.
      agent: false,
      headers: { accept: "*/*", "user-agent": "pidock-service-health-probe" },
    }, (response) => {
      const statusCode = response.statusCode ?? 0;
      // The body is not read at all: the observation is complete here, and a
      // body nobody asked for must not be able to delay or bloat this read.
      response.destroy();
      if (statusCode >= 200 && statusCode < 300) {
        finish({ ...base, state: "healthy", statusCode, elapsedMs: elapsed(), boundMs });
        return;
      }
      if (statusCode >= 300 && statusCode < 400) {
        finish({ ...base, state: "unhealthy", statusCode, reason: `重定向未跟随（HTTP ${String(statusCode)}）`, elapsedMs: elapsed(), boundMs });
        return;
      }
      finish({ ...base, state: "unhealthy", statusCode, reason: `状态码 ${String(statusCode)}（不是 2xx，健康检查未通过）`, elapsedMs: elapsed(), boundMs });
    });
    request.on("error", (error: NodeJS.ErrnoException) => {
      finish({ ...base, state: "unhealthy", reason: connectFailureReason(error), elapsedMs: elapsed(), boundMs });
    });
    request.end();
  });
}

/**
 * One bounded TCP connect against the declared `host:port` socket (a `tcp://`
 * prefix is accepted). A completed connect is what such a check declares: the
 * answer is about the DECLARED socket accepting a connection, never a claim
 * about the process that holds it (process liveness stays `lifecycle`).
 */
async function probeTcp(target: string, boundMs: number): Promise<ServiceHealthObservation> {
  const base = { kind: "tcp" as const, target };
  const socketTarget = parseTcpTarget(target);
  if (socketTarget === undefined) {
    return { ...base, state: "not-probed", reason: "健康检查目标不是 host:port 形式，不发起探测" };
  }
  const startedAt = Date.now();
  return await new Promise<ServiceHealthObservation>((resolve) => {
    let settled = false;
    const elapsed = () => Date.now() - startedAt;
    const finish = (observation: ServiceHealthObservation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(observation);
    };
    const timer = setTimeout(() => finish({
      ...base, state: "unhealthy", reason: `探测超时：${String(boundMs)}ms 内未建立连接`, elapsedMs: elapsed(), boundMs,
    }), boundMs);
    const socket: Socket = tcpConnect({ host: socketTarget.host, port: socketTarget.port });
    socket.once("connect", () => finish({ ...base, state: "healthy", elapsedMs: elapsed(), boundMs }));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish({ ...base, state: "unhealthy", reason: connectFailureReason(error), elapsedMs: elapsed(), boundMs });
    });
  });
}

/** `host:port`, or `undefined` for anything that is not one port on one host. */
function parseTcpTarget(target: string): { host: string; port: number } | undefined {
  const value = target.startsWith("tcp://") ? target.slice("tcp://".length) : target;
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return undefined;
  const host = value.slice(0, separator);
  const port = Number(value.slice(separator + 1));
  if (host.length === 0 || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host, port };
}

/**
 * The named reason of a failed connect/request. A refused connection is the
 * ordinary "nothing is listening on the declared target" case and is named
 * exactly that; every other failure names its own code instead of being folded
 * into one wording. Nothing here can be read as the process having died: this
 * function only ever feeds a health observation, and `lifecycle` is decided by
 * the real child.
 */
function connectFailureReason(error: NodeJS.ErrnoException): string {
  if (error.code === "ECONNREFUSED") return "连接被拒";
  if (error.code === "ENOTFOUND" || error.code === "EAI_AGAIN") return `目标地址无法解析（${String(error.code)}）`;
  if (error.code === "ECONNRESET") return "连接被重置";
  if (error.code === "ETIMEDOUT") return "连接超时";
  return `连接失败：${error.code ?? error.message}`;
}
