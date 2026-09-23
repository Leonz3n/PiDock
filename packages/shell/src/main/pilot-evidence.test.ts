import { describe, expect, it } from "vitest";
import {
  LEGACY_LIST_ROUTE,
  PILOT_OPERATION,
  assessPilotBundle,
  assessPilotRequest,
  checkGraphqlBody,
  isLegacyListRoute,
  resolveInstanceForUrl,
  type PilotEvidenceBundle,
  type PilotNetworkObservation,
} from "./pilot-evidence.js";

// Seam: [PiDock 07] (#13) pilot evidence correlation. The ticket's boxes 5/6
// require the network target, the local instance and the local RPC log to be
// correlated, GraphQL errors to be checked instead of the HTTP status alone,
// and missing evidence to be reported as unproven rather than inferred from a
// successful response. These cases pin those rules without any real business
// service, credential or repository.

const INSTANCE = { serviceId: "saas-bff", port: 3100, pid: 4021, codeVersion: "c2a02032+dirty" };
const RPC = { serviceId: "saas-bff", operation: PILOT_OPERATION, at: "2026-09-22T10:00:01+08:00" };

function bundle(overrides: Partial<PilotEvidenceBundle> = {}): PilotEvidenceBundle {
  return {
    taskId: "task-a1f92c3d",
    instances: [INSTANCE],
    network: [
      {
        sessionId: "main",
        operation: PILOT_OPERATION,
        url: "http://localhost:3100/graphql",
        status: 200,
        body: JSON.stringify({ data: { reconciliationInvoices: { nodes: [{ billNo: "B-1" }] } } }),
      },
    ],
    rpcLog: [RPC],
    ...overrides,
  };
}

function request(overrides: Partial<PilotNetworkObservation> = {}): PilotNetworkObservation {
  return {
    sessionId: "main",
    operation: PILOT_OPERATION,
    url: "http://localhost:3100/graphql",
    status: 200,
    body: JSON.stringify({ data: { reconciliationInvoices: { nodes: [{ billNo: "B-1" }] } } }),
    ...overrides,
  };
}

describe("[PiDock 07] pilot evidence correlation", () => {
  it("proves a request only when the instance, the RPC log and a clean body all line up", () => {
    const verdict = assessPilotRequest(request(), bundle());
    expect(verdict).toMatchObject({
      verdict: "proven",
      instance: { serviceId: "saas-bff", port: 3100 },
      rpc: RPC,
    });
    expect(resolveInstanceForUrl("http://127.0.0.1:3100/graphql", [INSTANCE])).toMatchObject({
      serviceId: "saas-bff",
    });
    expect(resolveInstanceForUrl("https://saas.example.com/graphql", [INSTANCE])).toBeUndefined();
  });

  it("marks the request unproven when the local RPC log entry is missing", () => {
    const verdict = assessPilotRequest(request(), bundle({ rpcLog: [] }));
    expect(verdict.verdict).toBe("unproven");
    expect(verdict.verdict === "unproven" && verdict.reasons).toContain(
      `缺少 saas-bff 的 ${PILOT_OPERATION} RPC 日志`,
    );
  });

  it("fails the request on a GraphQL error even though HTTP reports 200", () => {
    const verdict = assessPilotRequest(
      request({ body: JSON.stringify({ errors: [{ message: "CANNOT_QUERY_FIELD" }] }) }),
      bundle(),
    );
    expect(verdict.verdict).toBe("unproven");
    expect(verdict.verdict === "unproven" && verdict.reasons.join()).toContain(
      "GraphQL 错误：CANNOT_QUERY_FIELD",
    );
  });

  it("cannot judge a body it never captured or cannot parse", () => {
    const uncaptured = assessPilotRequest(request({ status: undefined, body: undefined }), bundle());
    expect(uncaptured.verdict === "unproven" && uncaptured.reasons).toContain(
      "未捕获响应体，无法判断 GraphQL 错误",
    );
    const unparsable = assessPilotRequest(request({ body: "<html>ok</html>" }), bundle());
    expect(unparsable.verdict === "unproven" && unparsable.reasons).toContain(
      "响应体不是 JSON 对象，不能判断 GraphQL 错误",
    );
    expect(checkGraphqlBody("<html>ok</html>")).toEqual({ parsed: false });
    expect(checkGraphqlBody(JSON.stringify({ data: {} }))).toEqual({ parsed: true, errors: [] });
  });

  it("never accepts the legacy REST list route as proof of the local chain", () => {
    const legacy = `${LEGACY_LIST_ROUTE}?page=1`;
    expect(isLegacyListRoute(`http://localhost:3100${legacy}`)).toBe(true);
    const verdict = assessPilotRequest(
      request({ operation: "axiosInvoiceList", url: `http://localhost:3100${legacy}` }),
      bundle({ rpcLog: [{ serviceId: "saas-bff", operation: "axiosInvoiceList", at: RPC.at }] }),
    );
    expect(verdict.verdict).toBe("unproven");
    expect(verdict.verdict === "unproven" && verdict.reasons).toContain(
      "旧 REST 列表成功不能替代本地 RPC 链路",
    );
  });

  it("reports a remote target, an unassigned port and a non-2xx status as missing links", () => {
    const remote = assessPilotRequest(
      request({ url: "https://saas.example.com/graphql" }),
      bundle(),
    );
    expect(remote.verdict === "unproven" && remote.reasons).toContain(
      "网络目标 saas.example.com 不是本任务实例地址",
    );
    const unassigned = assessPilotRequest(request({ url: "http://localhost:9999/graphql" }), bundle());
    expect(unassigned.verdict === "unproven" && unassigned.reasons).toContain(
      "端口 9999 没有本任务的运行实例",
    );
    const failing = assessPilotRequest(request({ status: 500 }), bundle());
    expect(failing.verdict === "unproven" && failing.reasons).toContain("HTTP 状态 500");
  });

  it("summarizes a bundle fail-closed, keeping every reason and the detail-driven calls", () => {
    const report = assessPilotBundle(
      bundle({
        network: [
          request(),
          request({ operation: "batchGetAccounts", status: 200, body: JSON.stringify({ data: {} }) }),
        ],
        rpcLog: [RPC],
      }),
    );
    expect(report).toMatchObject({ taskId: "task-a1f92c3d", proven: 1, unproven: 1 });
    expect(report.missing).toContain("缺少 saas-bff 的 batchGetAccounts RPC 日志");

    const empty = assessPilotBundle(bundle({ network: [], rpcLog: [] }));
    expect(empty).toMatchObject({ proven: 0, unproven: 0 });
    expect(empty.missing).toEqual([`未记录 ${PILOT_OPERATION} 请求`]);
  });
});
