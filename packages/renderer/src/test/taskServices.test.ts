/**
 * #47 S8d: the strict parsers behind the production 运行/日志 tool panels.
 *
 * They decide what the panel may show as real Host data, so a wrong shape must
 * return `null` (unreadable) rather than a partial or invented row.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadTaskServices,
  runBoundTaskServiceThroughShell,
  runRecordsFromHost,
  serviceLogFromHost,
  serviceStatusFromHost,
  shellFailure,
  taskAssociationFromMain,
} from "../data/taskServices";

const SERVICE_ID = "s-11111111-1111-1111-1111-111111111111";
const OTHER_SERVICE_ID = "s-22222222-2222-2222-2222-222222222222";
const ENVIRONMENT_ID = "e-11111111-1111-1111-1111-111111111111";
const OTHER_ENVIRONMENT_ID = "e-22222222-2222-2222-2222-222222222222";

/**
 * [PiDock 04] (#7 box 1) the read point that decides which revision the 运行
 * panel shows: one template list per environment the task's bindings selected,
 * and each row read against ITS OWN environment. A single project-wide list
 * would show another environment's service as if this binding pinned it.
 */
it("reads one template list per environment a task's bindings selected and matches each row to its own environment", async () => {
  const seen: Record<string, unknown>[] = [];
  vi.stubGlobal("window", { pidock: {
    projectOp: async () => ({ ok: true, payload: { roots: [], tasks: [{ taskId: "task-1", projectId: "project-1", state: "assigned" }] } }),
    taskOp: async () => ({ ok: true, payload: { records: [], registered: [] } }),
    serviceCatalogOp: async (request: Record<string, unknown>) => {
      seen.push(request);
      if (request["op"] === "taskBindings") return { ok: true, payload: [
        { taskId: "task-1", serviceId: SERVICE_ID, environmentId: ENVIRONMENT_ID, environmentName: "开发环境", templateVersion: 1, rootId: "repo-a", subdir: "", privateKeys: [] },
        { taskId: "task-1", serviceId: OTHER_SERVICE_ID, environmentId: OTHER_ENVIRONMENT_ID, environmentName: "预发环境", templateVersion: 1, rootId: "repo-a", subdir: "", privateKeys: [] },
      ] };
      if (request["op"] === "list") return { ok: true, payload: [{ projectId: "project-1", environmentId: request["environmentId"], serviceId: request["environmentId"] === ENVIRONMENT_ID ? SERVICE_ID : OTHER_SERVICE_ID,
        version: 1, shared: [], descriptor: { name: request["environmentId"] === ENVIRONMENT_ID ? "本地服务" : "预发服务", program: "node", args: [], ports: [], runType: "long-lived" } }] };
      return { ok: false, error: `unexpected ${String(request["op"])}` };
    } } });
  const loaded = await loadTaskServices("task-1");
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) throw Error("unreachable");
  // One read per DISTINCT environment, each naming that environment.
  expect(seen.filter((request) => request["op"] === "list")).toEqual([
    { op: "list", projectId: "project-1", environmentId: ENVIRONMENT_ID },
    { op: "list", projectId: "project-1", environmentId: OTHER_ENVIRONMENT_ID },
  ]);
  expect(loaded.templatesError).toBeUndefined();
  // Each binding shows the revision of the environment IT selected.
  const names = loaded.rows.map((row) => [row.binding.environmentName, row.binding.serviceId === SERVICE_ID ? row.template?.descriptor.name : row.template?.descriptor.name]);
  expect(names).toEqual([["开发环境", "本地服务"], ["预发环境", "预发服务"]]);
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("[UI 对齐] S8d task service parsers", () => {
  it("accepts both real Host status shapes and rejects a status for another service", () => {
    expect(serviceStatusFromHost({ service: { serviceId: SERVICE_ID, state: "running", ownerSessionId: "main", busy: false, closing: false, retainedRights: "held", executionAvailable: false } }, SERVICE_ID))
      .toEqual({ kind: "owner", serviceId: SERVICE_ID, state: "running", ownerSessionId: "main", busy: false, closing: false, retainedRights: "held", executionAvailable: false });
    expect(serviceStatusFromHost({ service: { serviceId: SERVICE_ID, lifecycle: "stopped", templateVersion: "1", resolved: [{ key: "PORT", value: "4100", source: "shared", secret: false }] } }, SERVICE_ID))
      .toEqual({ kind: "registry", serviceId: SERVICE_ID, lifecycle: "stopped", templateVersion: "1", resolvedKeys: ["PORT"] });
    // The Host's own allowlisted projection (`service-public.ts`) carries the
    // trusted launch source and the named health state of the declared
    // 健康检查; a reachability probe is never reported as health.
    expect(serviceStatusFromHost({ service: { serviceId: SERVICE_ID, lifecycle: "running", templateVersion: "2", launchSource: "catalog", health: "not-probed", startedAt: "2026-10-08T00:00:00.000Z", stoppedAt: undefined, exitReason: undefined, resolved: [] } }, SERVICE_ID))
      .toMatchObject({ kind: "registry", serviceId: SERVICE_ID, lifecycle: "running", launchSource: "catalog", health: { state: "not-probed" }, resolvedKeys: [] });
    // [PiDock 04] #7 box 5: the Host labels the explicit human action and the
    // gated Agent path apart, and the row keeps both facts instead of an author.
    expect(serviceStatusFromHost({ service: { serviceId: SERVICE_ID, lifecycle: "running", templateVersion: "2", resolved: [],
      lastControl: { action: "start", actor: "human", label: "主进程服务目录入口" } } }, SERVICE_ID))
      .toMatchObject({ kind: "registry", lastControl: { action: "start", actor: "human", label: "主进程服务目录入口" } });
    expect(serviceStatusFromHost({ service: { serviceId: SERVICE_ID, lifecycle: "stopped", templateVersion: "2", resolved: [],
      lastControl: { action: "stop", actor: "agent", label: "main" } } }, SERVICE_ID))
      .toMatchObject({ kind: "registry", lastControl: { action: "stop", actor: "agent", label: "main" } });
    // A row with no recorded control is readable and says nothing about an author.
    expect(serviceStatusFromHost({ service: { serviceId: SERVICE_ID, lifecycle: "stopped", templateVersion: "2", resolved: [], lastControl: null } }, SERVICE_ID))
      .toMatchObject({ kind: "registry" });
    expect(serviceStatusFromHost({ service: { serviceId: SERVICE_ID, lifecycle: "running", templateVersion: "2", health: "green", resolved: [] } }, SERVICE_ID)).toBeNull();
    expect(serviceStatusFromHost({ service: { serviceId: SERVICE_ID, lifecycle: "running", templateVersion: "2", launchSource: "agent", resolved: [] } }, SERVICE_ID)).toBeNull();
    expect(serviceStatusFromHost({ service: { serviceId: "s-99999999-9999-9999-9999-999999999999", state: "running", ownerSessionId: null, busy: false, closing: false, retainedRights: null, executionAvailable: false } }, SERVICE_ID)).toBeNull();
  });

  it("reads the declared 健康检查's observed states strictly, and never as an implied pass", () => {
    const status = (health: unknown, healthDetail?: unknown) => ({ service: { serviceId: SERVICE_ID, lifecycle: "running", templateVersion: "2",
      resolved: [], health, ...(healthDetail === undefined ? {} : { healthDetail }) } });
    // A real pass carries the observed attempt: the real status code and the real ms.
    expect(serviceStatusFromHost(status("healthy", { kind: "http", target: "http://127.0.0.1:4100/health", statusCode: 200, elapsedMs: 12, boundMs: 1500 }), SERVICE_ID))
      .toMatchObject({ kind: "registry", health: { state: "healthy", kind: "http", statusCode: 200, elapsedMs: 12 } });
    // A failure is named, and is about the TARGET only: `lifecycle` stays liveness.
    expect(serviceStatusFromHost(status("unhealthy", { kind: "http", target: "http://127.0.0.1:4100/health", elapsedMs: 3, boundMs: 1500, reason: "连接被拒" }), SERVICE_ID))
      .toMatchObject({ kind: "registry", lifecycle: "running", health: { state: "unhealthy", reason: "连接被拒" } });
    // 未声明 and 未探测 are named states; neither is a pass and neither may carry
    // a duration that would imply a probe ran.
    expect(serviceStatusFromHost(status("undeclared"), SERVICE_ID)).toMatchObject({ kind: "registry", health: { state: "undeclared" } });
    expect(serviceStatusFromHost(status("not-probed", { kind: "grpc", reason: "gRPC 健康探测尚未接入" }), SERVICE_ID))
      .toMatchObject({ kind: "registry", health: { state: "not-probed" } });
    // A `healthy` row with no observed attempt (no duration), a `not-probed`
    // row that carries one, an unknown state, a non-2xx "healthy" code, a code on
    // a non-http kind and a detail with no state are all unreadable.
    expect(serviceStatusFromHost(status("healthy", { kind: "http", statusCode: 200 }), SERVICE_ID)).toBeNull();
    expect(serviceStatusFromHost(status("healthy"), SERVICE_ID)).toBeNull();
    expect(serviceStatusFromHost(status("not-probed", { elapsedMs: 4, boundMs: 1500, reason: "x" }), SERVICE_ID)).toBeNull();
    expect(serviceStatusFromHost(status("undeclared", { kind: "http" }), SERVICE_ID)).toBeNull();
    expect(serviceStatusFromHost(status("healthy", { kind: "http", statusCode: 500, elapsedMs: 1, boundMs: 1500 }), SERVICE_ID)).toBeNull();
    expect(serviceStatusFromHost(status("healthy", { kind: "tcp", statusCode: 200, elapsedMs: 1, boundMs: 1500 }), SERVICE_ID)).toBeNull();
    expect(serviceStatusFromHost(status("unhealthy", { kind: "http", elapsedMs: 1, boundMs: 1500 }), SERVICE_ID)).toBeNull();
    expect(serviceStatusFromHost(status(undefined, { state: "healthy" }), SERVICE_ID)).toBeNull();
    expect(serviceStatusFromHost(status("healthy", { kind: "udp", elapsedMs: 1, boundMs: 1500 }), SERVICE_ID)).toBeNull();
  });

  it("rejects an unknown lifecycle/state or a malformed resolved row instead of reporting a stopped service", () => {
    expect(serviceStatusFromHost({ service: { serviceId: SERVICE_ID, state: "teleporting", ownerSessionId: null, busy: false, closing: false, retainedRights: null, executionAvailable: false } }, SERVICE_ID)).toBeNull();
    expect(serviceStatusFromHost({ service: { serviceId: SERVICE_ID, state: "running", ownerSessionId: null, busy: false, closing: false, retainedRights: "maybe", executionAvailable: false } }, SERVICE_ID)).toBeNull();
    expect(serviceStatusFromHost({ service: { serviceId: SERVICE_ID, lifecycle: "running", templateVersion: "1", resolved: [{ key: 1 }] } }, SERVICE_ID)).toBeNull();
    expect(serviceStatusFromHost({ service: null }, SERVICE_ID)).toBeNull();
    // An unreadable control author is not shown as anybody: the row is refused
    // rather than displayed as if the user had clicked it.
    for (const lastControl of [{ action: "start", actor: "user", label: "x" }, { action: "restart", actor: "agent", label: "main" },
      { action: "start", actor: "human" }, { action: "start", actor: "agent", label: "" }, "human"]) {
      expect(serviceStatusFromHost({ service: { serviceId: SERVICE_ID, lifecycle: "running", templateVersion: "2", resolved: [], lastControl } }, SERVICE_ID)).toBeNull();
    }
  });

  it("accepts only a complete log line list", () => {
    expect(serviceLogFromHost({ log: [{ at: "2026-10-08T00:00:00.000Z", line: "listening at :4100" }] }))
      .toEqual([{ at: "2026-10-08T00:00:00.000Z", line: "listening at :4100" }]);
    expect(serviceLogFromHost({ log: [] })).toEqual([]);
    expect(serviceLogFromHost({ log: [{ at: "now" }] })).toBeNull();
    expect(serviceLogFromHost({ log: "listening" })).toBeNull();
    expect(serviceLogFromHost({})).toBeNull();
  });

  it("reads a real run record strictly and keeps the declared/observed port origin apart", () => {
    const record = {
      runId: "run-1", taskId: "task-1", serviceId: SERVICE_ID, instanceId: `task-1/${SERVICE_ID}@53101`,
      templateVersion: "v1",
      codeState: { kind: "uncommitted", commit: "abc1234", note: "工作副本有未提交修改" },
      buildFreshness: "uncommitted-code",
      ports: [53101], portsSource: "declared",
      processIdentity: { owner: "agent", pid: 4242, startedAt: "2026-10-08T00:00:00.000Z" },
      logRef: "/tmp/task-1/services/svc/run-run-1.log", startedAt: "2026-10-08T00:00:00.000Z",
      verifications: [{ kind: "linkage", detail: "联通检查 shipment-service", ok: true, at: "2026-10-08T00:00:01.000Z" }],
    };
    const parsed = runRecordsFromHost({ records: [record], registered: [] }, "task-1");
    expect(parsed?.get(SERVICE_ID)).toEqual({
      runId: "run-1", templateVersion: "v1", codeState: "uncommitted", codeCommit: "abc1234",
      buildFreshness: "uncommitted-code", ports: [53101], portsSource: "declared",
      processIdentity: { owner: "agent", pid: 4242, startedAt: "2026-10-08T00:00:00.000Z" },
      logRef: "/tmp/task-1/services/svc/run-run-1.log", startedAt: "2026-10-08T00:00:00.000Z",
      // The real observation rides the parsed view so the panel can label it
      // 已互验 instead of leaving the linkage result invisible ([PiDock 05] #10 box 4).
      verifications: [{ kind: "linkage", detail: "联通检查 shipment-service", ok: true }],
    });
    expect(runRecordsFromHost({ records: [{ ...record, protocolArtifact: { version: "v2" } }] }, "task-1")?.get(SERVICE_ID)).toMatchObject({ runId: "run-1" });
    // Nothing was verified about this record: the missing pid must not be
    // invented, and the record for another service is simply absent here.
    expect(parsed?.get("s-99999999-9999-9999-9999-999999999999")).toBeUndefined();
    // The latest row for a service wins (`runs()` is push order).
    const restarted = { ...record, runId: "run-2", ports: [53102], instanceId: `task-1/${SERVICE_ID}@53102`, portsSource: "observed" };
    expect(runRecordsFromHost({ records: [record, restarted] }, "task-1")?.get(SERVICE_ID)).toMatchObject({ runId: "run-2", ports: [53102], portsSource: "observed" });
  });

  it("refuses a malformed run-record payload as a whole instead of hiding the bad row", () => {
    const base = {
      runId: "run-1", taskId: "task-1", serviceId: SERVICE_ID, instanceId: `task-1/${SERVICE_ID}@53101`, templateVersion: "v1",
      codeState: { kind: "unknown", note: "缺少提交信息，无法判断代码状态" }, buildFreshness: "unknown",
      ports: [53101], portsSource: "declared",
      processIdentity: { owner: "human", pid: 4242, startedAt: "2026-10-08T00:00:00.000Z" },
      logRef: "/tmp/task-1/svc/run-run-1.log", startedAt: "2026-10-08T00:00:00.000Z", verifications: [],
    };
    // An empty answer is readable and simply has no record; it is NOT a refusal.
    expect(runRecordsFromHost({ records: [] }, "task-1")?.size).toBe(0);
    expect(runRecordsFromHost({ registered: [] }, "task-1")).toBeNull();
    for (const bad of [
      { ...base, ports: [53102] },
      { ...base, instanceId: `task-2/${SERVICE_ID}@53101` },
      { ...base, codeState: { kind: "unknown", note: 42 } },
      { ...base, codeState: { kind: "unknown" } },
      { ...base, verifications: [{ kind: "other", detail: "x", ok: true, at: "2026-10-08T00:00:01.000Z" }] },
      { ...base, verifications: [{ kind: "linkage", detail: "x", ok: true, at: 42 }] },
      { ...base, verifications: [{ kind: "linkage", detail: "x", ok: true }] },
      { ...base, protocolArtifact: { version: 42 } },
      { ...base, protocolArtifact: { version: "" } },
      { ...base, portsSource: "guessed" },
      { ...base, codeState: { kind: "teleporting" } },
      { ...base, buildFreshness: "maybe" },
      { ...base, processIdentity: { owner: "human", pid: 0, startedAt: "2026-10-08T00:00:00.000Z" } },
      { ...base, processIdentity: { owner: "robot", pid: 5, startedAt: "now" } },
      { ...base, ports: ["53101"] },
      { ...base, verifications: [{ kind: "linkage", detail: "x" }] },
      { ...base, unexpected: true },
      "run-1",
    ]) {
      expect(runRecordsFromHost({ records: [bad] }, "task-1")).toBeNull();
    }
    // One bad row fails the whole read rather than being skipped for a valid sibling.
    expect(runRecordsFromHost({ records: [base, { ...base, runId: 7 }] }, "task-1")).toBeNull();
  });

  it("reads the task's own association row and refuses an inconsistent project link", () => {
    const rows = { roots: [], tasks: [{ taskId: "task-1", projectId: "project-1", state: "assigned" }, { taskId: "task-2", projectId: null, state: "unassigned" }] };
    expect(taskAssociationFromMain(rows, "task-1")).toEqual({ taskId: "task-1", projectId: "project-1", state: "assigned" });
    expect(taskAssociationFromMain(rows, "task-2")).toEqual({ taskId: "task-2", projectId: null, state: "unassigned" });
    expect(taskAssociationFromMain(rows, "task-3")).toBeNull();
    expect(taskAssociationFromMain({ roots: [], tasks: [{ taskId: "task-1", projectId: null, state: "assigned" }] }, "task-1")).toBeNull();
  });

  it("shows the Host's own refusal text without Electron's invoke wrapper", () => {
    expect(shellFailure({ error: "Error invoking remote method 'shell/taskOp': Error: unknown-service: s-1 is not registered on this task" }, "fallback"))
      .toBe("unknown-service: s-1 is not registered on this task");
    expect(shellFailure({ error: "browser-unavailable: 主进程未挂载任务浏览器能力" }, "fallback")).toBe("browser-unavailable: 主进程未挂载任务浏览器能力");
    expect(shellFailure({}, "读取失败")).toBe("读取失败");
    expect(shellFailure({ error: "   " }, "读取失败")).toBe("读取失败");
  });

  it("sends only project/task/service/action to the production runTaskService op", async () => {
    const seen: Record<string, unknown>[] = [];
    vi.stubGlobal("window", { pidock: { taskOp: async () => ({ ok: true, payload: {} }), serviceCatalogOp: async (request: Record<string, unknown>) => {
      seen.push(request);
      return { ok: false, error: "Error invoking remote method 'shell/serviceCatalogOp': Error: unsupported-platform: 平台不支持" };
    } } });
    const result = await runBoundTaskServiceThroughShell({ projectId: "project-1", taskId: "task-1", serviceId: SERVICE_ID, action: "start" });
    expect(seen).toEqual([{ op: "runTaskService", projectId: "project-1", taskId: "task-1", serviceId: SERVICE_ID, action: "start" }]);
    expect(Object.keys(seen[0]!).sort()).toEqual(["action", "op", "projectId", "serviceId", "taskId"]);
    // The Host's refusal reaches the panel with its reason intact (Electron's
    // plumbing wrapper stripped), never as a fabricated running state.
    expect(result).toEqual({ ok: false, error: "unsupported-platform: 平台不支持" });
    vi.unstubAllGlobals();

    vi.stubGlobal("window", { pidock: { taskOp: async () => ({ ok: true, payload: {} }), serviceCatalogOp: async () => ({ ok: true, payload: { serviceId: SERVICE_ID, action: "start", actor: "human" } }) } });
    expect(await runBoundTaskServiceThroughShell({ projectId: "project-1", taskId: "task-1", serviceId: SERVICE_ID, action: "start" })).toEqual({ ok: true });
    vi.unstubAllGlobals();

    // No shell bridge at all stays a refusal, not a silent success.
    vi.stubGlobal("window", {});
    expect(await runBoundTaskServiceThroughShell({ projectId: "project-1", taskId: "task-1", serviceId: SERVICE_ID, action: "start" })).toEqual({ ok: false, error: "服务配方目录尚未接线" });
    vi.unstubAllGlobals();
  });
});
