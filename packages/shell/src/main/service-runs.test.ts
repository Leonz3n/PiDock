import { describe, expect, it } from "vitest";
import {
  attachVerification,
  buildRunRecord,
  classifyBuildFreshness,
  classifyCodeState,
  classifyExternalResource,
  diagnoseDependencyUnreachable,
  diagnoseSharedResources,
  diagnoseStartFailure,
  isRunRecordCurrent,
  knownConfigLimits,
  planStopScope,
  recordRunExit,
  verifyRegisteredIdentity,
  type ProcessIdentity,
} from "./service-runs.js";

// Seam: #10 run records, stop scope and shared external resources. Pure so
// the Host and the task view share one vocabulary.

const identity = (instanceId: string, pid: number): ProcessIdentity => ({
  instanceId,
  taskId: instanceId.split("/")[0] ?? "",
  serviceId: instanceId.split("/")[1] ?? "",
  pid,
  startedAt: "2026-09-22T10:00:00.000Z",
  owner: "human",
});

describe("code state and build freshness", () => {
  it("distinguishes committed, uncommitted and unknown code", () => {
    expect(classifyCodeState({ commit: "abc1234", dirty: false })).toBe("committed-clean");
    expect(classifyCodeState({ commit: "abc1234", dirty: true })).toBe("uncommitted");
    expect(classifyCodeState({ dirty: false })).toBe("unknown");
  });

  it("separates an old build from uncommitted code", () => {
    expect(classifyBuildFreshness({ buildCommit: "abc1234", headCommit: "abc1234", dirty: false })).toBe("fresh");
    expect(classifyBuildFreshness({ buildCommit: "abc1234", headCommit: "def5678", dirty: false })).toBe("stale-build");
    expect(classifyBuildFreshness({ buildCommit: "abc1234", headCommit: "abc1234", dirty: true })).toBe("uncommitted-code");
    expect(classifyBuildFreshness({ dirty: false })).toBe("unknown");
  });

  it("records config version, ports, process identity and log path on one run", () => {
    const record = buildRunRecord({
      runId: "run-1",
      taskId: "task-aaaaaaaa",
      serviceId: "invoice-service",
      templateVersion: "v13",
      ports: [9001],
      code: { commit: "abc1234", dirty: true },
      build: { commit: "abc1234" },
      processIdentity: { owner: "human", pid: 4321, startedAt: "2026-09-22T10:00:00.000Z" },
      taskDir: "/tasks/task-aaaaaaaa/",
      startedAt: "2026-09-22T10:00:00.000Z",
    });
    expect(record).toMatchObject({
      instanceId: "task-aaaaaaaa/invoice-service@9001",
      templateVersion: "v13",
      ports: [9001],
      processIdentity: { owner: "human", pid: 4321 },
      logRef: "/tasks/task-aaaaaaaa/services/invoice-service/run-run-1.log",
      buildFreshness: "uncommitted-code",
    });
    expect(record.codeState.kind).toBe("uncommitted");
    expect(record.codeState.note).toContain("未提交修改");
    expect(isRunRecordCurrent(record, { headCommit: "abc1234", dirty: true })).toBe(false);

    const clean = buildRunRecord({
      runId: "run-2",
      taskId: "task-aaaaaaaa",
      serviceId: "invoice-service",
      templateVersion: "v13",
      ports: [9001],
      code: { commit: "abc1234", dirty: false },
      build: { commit: "abc1234" },
      processIdentity: { owner: "agent", pid: 4322, startedAt: "2026-09-22T10:05:00.000Z" },
      taskDir: "/tasks/task-aaaaaaaa",
      startedAt: "2026-09-22T10:05:00.000Z",
    });
    expect(isRunRecordCurrent(clean, { headCommit: "abc1234", dirty: false })).toBe(true);
    expect(isRunRecordCurrent(clean, { headCommit: "def5678", dirty: false })).toBe(false);
  });

  it("closes a run with the exit reason and keeps verification results separate from liveness", () => {
    const record = buildRunRecord({
      runId: "run-3",
      taskId: "task-aaaaaaaa",
      serviceId: "saas-bff",
      templateVersion: "v13",
      ports: [3001],
      code: { commit: "abc1234", dirty: false },
      build: { commit: "abc1234" },
      processIdentity: { owner: "human", pid: 99, startedAt: "2026-09-22T10:00:00.000Z" },
      taskDir: "/tasks/task-aaaaaaaa",
      startedAt: "2026-09-22T10:00:00.000Z",
    });
    const verified = attachVerification(record, {
      kind: "linkage",
      detail: "联通检查 invoice-service",
      ok: false,
      at: "2026-09-22T10:01:00.000Z",
    });
    expect(verified.verifications).toEqual([
      { kind: "linkage", detail: "联通检查 invoice-service", ok: false, at: "2026-09-22T10:01:00.000Z" },
    ]);
    const ended = recordRunExit(verified, { reason: "user-request", at: "2026-09-22T10:02:00.000Z" });
    expect(ended.exit).toEqual({ reason: "user-request" });
    expect(ended.endedAt).toBe("2026-09-22T10:02:00.000Z");
    expect(ended.verifications).toHaveLength(1);
  });
});

describe("locatable failures", () => {
  it("reports a busy port with the reallocation hint", () => {
    const busy = diagnoseStartFailure({
      unitId: "invoice:invoice-service",
      serviceId: "invoice-service",
      port: 9001,
      error: "listen EADDRINUSE: address already in use 127.0.0.1:9001",
    });
    expect(busy.code).toBe("port-taken");
    expect(busy.scope).toEqual({ unitId: "invoice:invoice-service", port: 9001 });
    expect(busy.hint).toContain("重新分配端口");
    const other = diagnoseStartFailure({ unitId: "invoice:invoice-service", serviceId: "invoice-service", error: "exit code 1" });
    expect(other.code).toBe("start-failed");
    expect(other.scope.port).toBeUndefined();
    expect(other.message).toContain("exit code 1");
  });

  it("names the consumer variable and the unreachable target", () => {
    const unreachable = diagnoseDependencyUnreachable({
      unitId: "front:saas-bff",
      key: "INVOICE_SERVICE_ENDPOINT",
      target: "task-aaaaaaaa/invoice-service@9002",
      detail: "连接超时",
    });
    expect(unreachable.code).toBe("dependency-unreachable");
    expect(unreachable.scope).toEqual({ unitId: "front:saas-bff", key: "INVOICE_SERVICE_ENDPOINT" });
    expect(unreachable.message).toContain("task-aaaaaaaa/invoice-service@9002");
    expect(unreachable.hint).toContain("不等于功能验证成功");
  });
});

describe("stop scope", () => {
  const registry = [
    identity("task-aaaaaaaa/invoice-service", 111),
    identity("task-aaaaaaaa/saas-bff", 222),
    identity("task-bbbbbbbb/invoice-service", 333),
  ];

  it("stops only registered identities of the owning task", () => {
    const wholeTask = planStopScope({ taskId: "task-aaaaaaaa", registry });
    expect(wholeTask.ok).toBe(true);
    if (!wholeTask.ok) return;
    expect(wholeTask.scope.stop.map((entry) => entry.instanceId).sort()).toEqual([
      "task-aaaaaaaa/invoice-service",
      "task-aaaaaaaa/saas-bff",
    ]);
    expect(wholeTask.scope.skipped).toEqual([]);
  });

  it("leaves the same-name instance of another task untouched and says so", () => {
    const one = planStopScope({ taskId: "task-aaaaaaaa", registry, instanceId: "task-aaaaaaaa/invoice-service" });
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    expect(one.scope.stop.map((entry) => entry.pid)).toEqual([111]);
    expect(one.scope.skipped).toEqual([
      { instanceId: "task-bbbbbbbb/invoice-service", reason: "属于其他任务 task-bbbbbbbb，不受本次停止影响" },
    ]);
  });

  it("fails closed for unregistered or foreign instances and verifies identity exactly", () => {
    expect(planStopScope({ taskId: "task-aaaaaaaa", registry, instanceId: "task-aaaaaaaa/ghost" })).toMatchObject({ ok: false });
    const foreign = planStopScope({ taskId: "task-aaaaaaaa", registry, instanceId: "task-bbbbbbbb/invoice-service" });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.message).toContain("不属于当前任务");
    expect(verifyRegisteredIdentity({ instanceId: "task-aaaaaaaa/invoice-service", pid: 111, startedAt: "2026-09-22T10:00:00.000Z" }, registry)).toBe(true);
    expect(verifyRegisteredIdentity({ instanceId: "task-aaaaaaaa/invoice-service", pid: 999, startedAt: "2026-09-22T10:00:00.000Z" }, registry)).toBe(false);
    expect(verifyRegisteredIdentity({ instanceId: "task-aaaaaaaa/invoice-service", pid: 111, startedAt: "2026-09-22T09:00:00.000Z" }, registry)).toBe(false);
  });
});

describe("shared external resources", () => {
  it("never marks a fixed queue or DTM callback as isolated by default", () => {
    const queue = classifyExternalResource({ resourceId: "res-queue", name: "invoice-events", kind: "queue" });
    expect(queue).toMatchObject({ shared: true, isolation: "not-isolated" });
    expect(queue.note).toContain("不标记为任务隔离成功");
    const dtm = classifyExternalResource({ resourceId: "res-dtm", name: "dtm-callback", kind: "dtm-callback" });
    expect(dtm.isolation).toBe("not-isolated");
    const db = classifyExternalResource({ resourceId: "res-db", name: "shared-pg", kind: "database" });
    expect(db).toMatchObject({ shared: true, isolation: "unknown" });
    const isolated = classifyExternalResource({
      resourceId: "res-db2",
      name: "task-pg",
      kind: "database",
      isolatedByTask: true,
    });
    expect(isolated).toMatchObject({ shared: false, isolation: "isolated" });
  });

  it("projects shared resources into known limits and locatable diagnostics", () => {
    const resources = [
      classifyExternalResource({ resourceId: "res-queue", name: "invoice-events", kind: "queue" }),
      classifyExternalResource({ resourceId: "res-db2", name: "task-pg", kind: "database", isolatedByTask: true }),
    ];
    expect(knownConfigLimits(resources)).toEqual([resources[0]?.note]);
    const diagnostics = diagnoseSharedResources(resources);
    expect(diagnostics.map((entry) => entry.code)).toEqual(["shared-not-isolated"]);
    expect(diagnostics[0]?.scope.key).toBe("res-queue");
  });
});
