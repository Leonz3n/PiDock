/**
 * Model-list discovery for [PiDock 11] #9.
 *
 * 「同步模型列表」 uses the profile's own connection to fetch *candidates*:
 * the discovered ids only ever refresh the suggestion list — configured model
 * rows are never overwritten, auto-added or removed, and no capability is
 * inferred from an id (a `*-vision` id is still not an image-capable model
 * unless its row says so).
 *
 * The network call is injected (`ModelListTransport`), so the sync flow and
 * every outcome — success / empty list / failure / unsupported discovery — are
 * unit-testable without a real provider, and the real connectivity check stays
 * a recorded residual. Discovered ids are opaque strings; nothing about their
 * shape is interpreted.
 */

export type DiscoveryStatus = "success" | "empty" | "failure" | "unsupported";

export interface DiscoveryOutcome {
  status: DiscoveryStatus;
  /** Candidate ids (deduped, trimmed) on `success`; empty otherwise. */
  candidates: string[];
  /** Connection this attempt ran against; see `candidateSetIsStale`. */
  fingerprint: string;
  message: string;
  /** Ids dropped because they were not usable strings (reported, never guessed). */
  ignored: number;
}

export interface DiscoveryConnection {
  protocol: string;
  baseUrl: string;
  /** Model-list endpoint the protocol exposes, or `null` when it declares none. */
  modelListPath: string | null;
}

export type ModelListTransport = (
  request: { baseUrl: string; protocol: string; path: string },
) => Promise<{ ok: true; ids: unknown[] } | { ok: false; message: string }>;

/**
 * One sync attempt. Fail-closed on an unknown endpoint and on a transport
 * failure; a successful but empty answer is its own outcome so the UI can say
 * "连接返回空列表" instead of pretending the provider has no models.
 */
export async function syncModelCandidates(input: {
  connection: DiscoveryConnection;
  transport: ModelListTransport;
}): Promise<DiscoveryOutcome> {
  const path = typeof input.connection.modelListPath === "string" ? input.connection.modelListPath.trim() : "";
  const fingerprint = `${input.connection.protocol}::${input.connection.baseUrl.trim()}`;
  if (path.length === 0) {
    return {
      status: "unsupported",
      candidates: [],
      fingerprint,
      message: "当前连接未声明模型发现端点；请直接填写模型 ID，已配置模型不受影响",
      ignored: 0,
    };
  }
  let response: { ok: true; ids: unknown[] } | { ok: false; message: string };
  try {
    response = await input.transport({ baseUrl: input.connection.baseUrl, protocol: input.connection.protocol, path });
  } catch (error) {
    return {
      status: "failure",
      candidates: [],
      fingerprint,
      message: `模型发现失败：${error instanceof Error ? error.message : String(error)}；已保留表单与已配置模型`,
      ignored: 0,
    };
  }
  if (!response.ok) {
    return {
      status: "failure",
      candidates: [],
      fingerprint,
      message: `模型发现失败：${response.message}；已保留表单与已配置模型`,
      ignored: 0,
    };
  }
  const candidates: string[] = [];
  const seen = new Set<string>();
  let ignored = 0;
  for (const id of response.ids) {
    if (typeof id !== "string" || id.trim().length === 0) {
      ignored += 1;
      continue;
    }
    const trimmed = id.trim();
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    candidates.push(trimmed);
  }
  if (candidates.length === 0) {
    return {
      status: "empty",
      candidates: [],
      fingerprint,
      message: ignored > 0 ? `连接未返回可用模型（忽略 ${ignored} 个不可解析候选）` : "连接返回空模型列表，已配置模型保持不变",
      ignored,
    };
  }
  return {
    status: "success",
    candidates,
    fingerprint,
    message: ignored > 0 ? `已同步 ${candidates.length} 个候选，忽略 ${ignored} 个不可解析候选` : `已同步 ${candidates.length} 个候选`,
    ignored,
  };
}
