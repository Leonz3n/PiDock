// Seam: [PiDock 07] (#13) pilot evidence correlation.
//
// The reconciliation-detail pilot only counts as proven when the page request's
// network target, the local service instance it reached and that instance's RPC
// log entry all line up, and when the response carries no GraphQL error. A
// successful HTTP status is not evidence on its own, and the legacy REST list
// route never stands in for the local RPC chain. The judgement lives here as
// pure rules so the real run (user repository, non-production environment, real
// login) can feed the captured evidence and always get a fail-closed verdict:
// an absent link is reported as unproven together with its reason.

export const PILOT_OPERATION = "GetReconciliationInvoices";

/** Legacy REST list route (`axiosInvoiceList`); its success never proves the local chain. */
export const LEGACY_LIST_ROUTE = "/reconciliation-invoice/list";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

export interface PilotTaskInstance {
  serviceId: string;
  port: number;
  pid?: number;
  startedAt?: string;
  /** Recorded code state of the started instance, e.g. "c2a02032+dirty". */
  codeVersion?: string;
}

export interface PilotNetworkObservation {
  sessionId: string;
  /** Requested operation, e.g. `GetReconciliationInvoices`. */
  operation: string;
  url: string;
  /** HTTP status; absent when no response was observed. */
  status?: number;
  /** Captured response body; absent when the body was not captured. */
  body?: string;
}

export interface PilotRpcLogEntry {
  serviceId: string;
  operation: string;
  at: string;
}

export interface PilotEvidenceBundle {
  taskId: string;
  instances: readonly PilotTaskInstance[];
  network: readonly PilotNetworkObservation[];
  rpcLog: readonly PilotRpcLogEntry[];
}

export type PilotRequestVerdict =
  | {
      operation: string;
      url: string;
      verdict: "proven";
      instance: PilotTaskInstance;
      rpc: PilotRpcLogEntry;
    }
  | { operation: string; url: string; verdict: "unproven"; reasons: string[] };

export interface PilotEvidenceReport {
  taskId: string;
  requests: PilotRequestVerdict[];
  proven: number;
  unproven: number;
  /** Deduplicated reasons across unproven requests, plus bundle-level gaps. */
  missing: string[];
}

/**
 * GraphQL error messages carried by a response body, independent of HTTP status.
 * A body that is not a JSON object cannot be judged and is reported as such.
 */
export type GraphqlBodyCheck = { parsed: true; errors: string[] } | { parsed: false };

export function checkGraphqlBody(body: string): GraphqlBodyCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { parsed: false };
  }
  if (!isRecord(parsed)) return { parsed: false };
  const errors = parsed["errors"];
  if (!Array.isArray(errors)) return { parsed: true, errors: [] };
  return {
    parsed: true,
    errors: errors.map((entry) =>
      isRecord(entry) ? asString(entry["message"]) ?? JSON.stringify(entry) : String(entry),
    ),
  };
}

export function isLegacyListRoute(url: string): boolean {
  return url.includes(LEGACY_LIST_ROUTE);
}

/** The local instance the request address reaches, when it is a task instance. */
export function resolveInstanceForUrl(
  url: string,
  instances: readonly PilotTaskInstance[],
): PilotTaskInstance | undefined {
  const address = parseAddress(url);
  if (address === undefined || !address.local) return undefined;
  return instances.find((instance) => instance.port === address.port);
}

export function assessPilotRequest(
  observation: PilotNetworkObservation,
  bundle: PilotEvidenceBundle,
): PilotRequestVerdict {
  const reasons: string[] = [];
  if (isLegacyListRoute(observation.url)) {
    reasons.push("旧 REST 列表成功不能替代本地 RPC 链路");
  }
  const address = parseAddress(observation.url);
  if (address === undefined) {
    reasons.push("请求地址无法解析，不能关联本任务实例");
  } else if (!address.local) {
    reasons.push(`网络目标 ${address.host} 不是本任务实例地址`);
  }
  const instance = address?.local
    ? bundle.instances.find((item) => item.port === address.port)
    : undefined;
  if (address?.local === true && instance === undefined) {
    reasons.push(`端口 ${address.port} 没有本任务的运行实例`);
  }
  if (observation.status !== undefined && (observation.status < 200 || observation.status >= 300)) {
    reasons.push(`HTTP 状态 ${observation.status}`);
  }
  if (observation.status === undefined || observation.body === undefined) {
    reasons.push("未捕获响应体，无法判断 GraphQL 错误");
  } else {
    const check = checkGraphqlBody(observation.body);
    if (!check.parsed) reasons.push("响应体不是 JSON 对象，不能判断 GraphQL 错误");
    else if (check.errors.length > 0) reasons.push(`GraphQL 错误：${check.errors.join("；")}`);
  }
  const rpc =
    instance === undefined
      ? undefined
      : bundle.rpcLog.find(
          (entry) =>
            entry.serviceId === instance.serviceId && entry.operation === observation.operation,
        );
  if (instance !== undefined && rpc === undefined) {
    reasons.push(`缺少 ${instance.serviceId} 的 ${observation.operation} RPC 日志`);
  }
  if (instance === undefined || rpc === undefined || reasons.length > 0) {
    return { operation: observation.operation, url: observation.url, verdict: "unproven", reasons };
  }
  return {
    operation: observation.operation,
    url: observation.url,
    verdict: "proven",
    instance,
    rpc,
  };
}

export function assessPilotBundle(bundle: PilotEvidenceBundle): PilotEvidenceReport {
  const requests = bundle.network.map((observation) => assessPilotRequest(observation, bundle));
  const missing = new Set<string>();
  if (!bundle.network.some((observation) => observation.operation === PILOT_OPERATION)) {
    missing.add(`未记录 ${PILOT_OPERATION} 请求`);
  }
  for (const request of requests) {
    if (request.verdict === "unproven") {
      for (const reason of request.reasons) missing.add(reason);
    }
  }
  const proven = requests.filter((request) => request.verdict === "proven").length;
  return {
    taskId: bundle.taskId,
    requests,
    proven,
    unproven: requests.length - proven,
    missing: [...missing],
  };
}

function parseAddress(
  url: string,
): { host: string; port: number; local: boolean } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = parsed.port.length > 0 ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  if (!Number.isInteger(port) || port <= 0) return undefined;
  return { host, port, local: LOCAL_HOSTS.has(host) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
