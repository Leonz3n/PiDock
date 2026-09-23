import { describe, expect, it } from "vitest";
import { TaskServiceTopology } from "./service-topology.js";
import type { BindingLayers, RunUnit } from "../main/service-topology.js";

// Seam: #10 Host-side topology registry. Transport-free, so `host.ts` keeps
// only the envelope/dispatch and this class is driven directly here.

const units: RunUnit[] = [
  { unitId: "front:saas-web", serviceId: "saas-web", name: "saas-web", repoDir: "front", location: "local" },
  { unitId: "front:saas-bff", serviceId: "saas-bff", name: "saas-bff", repoDir: "front", location: "local" },
  { unitId: "invoice:invoice-service", serviceId: "invoice-service", name: "invoice-service", repoDir: "invoice", location: "local" },
  { unitId: "shared:account-service", serviceId: "account-service", name: "account-service", location: "remote" },
];

const layers: BindingLayers = {
  repoDefaults: [{ key: "INVOICE_SERVICE_ENDPOINT", value: "https://invoice.test.example", secret: false }],
  shared: [{ key: "SAAS_BFF_URL", value: "https://bff.test.example", secret: false }],
  privateEntries: [],
  task: [],
};

function topology(): TaskServiceTopology {
  return new TaskServiceTopology("task-aaaaaaaa", "/tasks/task-aaaaaaaa", () => "2026-09-22T10:00:00.000Z");
}

function planInput() {
  return {
    units,
    selectedRepoDirs: ["front", "invoice"],
    dependencies: [
      { from: "front:saas-web", to: "front:saas-bff", kind: "call" as const },
      { from: "front:saas-bff", to: "invoice:invoice-service", kind: "prestart" as const },
    ],
    requests: [
      { unitId: "front:saas-web", port: 5173 },
      { unitId: "front:saas-bff", port: 3001 },
      { unitId: "invoice:invoice-service", port: 9001 },
    ],
    rules: [
      { key: "INVOICE_SERVICE_ENDPOINT", unitId: "invoice:invoice-service", kind: "url" as const },
      { key: "SAAS_BFF_URL", unitId: "front:saas-bff", kind: "url" as const },
    ],
    layers,
    environment: "testing",
  };
}

describe("TaskServiceTopology planning", () => {
  it("keeps several units per repo, assigns ports and derives groups + routing", () => {
    const plan = topology().setPlan(planInput());
    expect(plan.repoGroups.map((group) => [group.repoDir, group.units.length])).toEqual([
      ["front", 2],
      ["invoice", 1],
      ["", 1],
    ]);
    expect(plan.assignments.map((assignment) => [assignment.serviceId, assignment.port])).toEqual([
      ["saas-web", 5173],
      ["saas-bff", 3001],
      ["invoice-service", 9001],
    ]);
    // Prestart target first, then the callee group, then its caller.
    expect(plan.groups.map((group) => group.members)).toEqual([
      ["invoice:invoice-service"],
      ["front:saas-bff"],
      ["front:saas-web"],
    ]);
    expect(plan.routing.find((entry) => entry.unitId === "invoice:invoice-service")?.keys).toEqual([
      { key: "INVOICE_SERVICE_ENDPOINT", value: "http://127.0.0.1:9001", readPoints: ["仓库默认配置"] },
    ]);
    expect(plan.diagnostics).toEqual([]);
  });

  it("plans a portless prepare step instead of failing the whole plan (seeded db-migrate)", () => {
    // Regression lock for the #10 review P1: `db-migrate` is local/`prepare`
    // with no preferred port, so the Host plan used to throw `missing-port`
    // and the renderer silently kept the memory projection.
    const plan = topology().setPlan({
      ...planInput(),
      units: [
        ...units,
        { unitId: "invoice:db-migrate", serviceId: "db-migrate", name: "db-migrate", repoDir: "invoice", location: "local", runType: "prepare" },
      ],
      dependencies: [
        { from: "front:saas-web", to: "front:saas-bff", kind: "call" as const },
        { from: "front:saas-bff", to: "invoice:db-migrate", kind: "prestart" as const },
      ],
    });
    expect(plan.diagnostics).toEqual([]);
    // The step owns no socket, so it is neither assigned nor routed.
    expect(plan.assignments.map((assignment) => assignment.unitId)).not.toContain("invoice:db-migrate");
    expect(plan.routing.find((entry) => entry.unitId === "invoice:db-migrate")?.target).toEqual({
      kind: "local-instance",
      instanceId: "task-aaaaaaaa/db-migrate",
      serviceId: "db-migrate",
      address: "task-aaaaaaaa/db-migrate",
    });
    // It runs first, and the listener that needs it comes after.
    expect(plan.groups[0]).toMatchObject({ groupId: "prestart", members: ["invoice:db-migrate"] });
    expect(plan.groups.map((group) => group.members).flat().indexOf("invoice:db-migrate")).toBe(0);
  });

  it("allocates a different port for the second task's same-name instance", () => {
    const first = topology().setPlan(planInput());
    const second = new TaskServiceTopology("task-bbbbbbbb", "/tasks/task-bbbbbbbb", () => "2026-09-22T10:00:00.000Z").setPlan({
      ...planInput(),
      reservations: first.assignments.map((assignment) => ({
        port: assignment.port,
        owner: "task" as const,
        taskId: "task-aaaaaaaa",
        unitId: assignment.unitId,
        serviceId: assignment.serviceId,
      })),
    });
    const portOf = (plan: typeof first, serviceId: string) => plan.assignments.find((entry) => entry.serviceId === serviceId)?.port;
    expect(portOf(second, "invoice-service")).toBe(9002);
    expect(second.reallocated).toHaveLength(3);
    expect(second.reallocated).toContainEqual({ unitId: "invoice:invoice-service", before: 9001, after: 9002 });
    expect(second.bindings.find((binding) => binding.key === "INVOICE_SERVICE_ENDPOINT")?.value).toBe("http://127.0.0.1:9002");
    expect(second.diagnostics).toEqual([]);
  });

  it("merges a bidirectional pair into one listener group and keeps remote deps as checks", () => {
    const plan = topology().setPlan({
      ...planInput(),
      dependencies: [
        { from: "front:saas-web", to: "front:saas-bff", kind: "call" },
        { from: "front:saas-bff", to: "front:saas-web", kind: "call" },
        { from: "front:saas-web", to: "shared:account-service", kind: "call" },
      ],
    });
    const merged = plan.groups.find((group) => group.members.includes("front:saas-web") && group.members.includes("front:saas-bff"));
    expect(merged).toMatchObject({ reason: "listener-group", bidirectional: true });
    expect(merged?.verify).toContain("远程依赖可达性检查 account-service（共享环境，不标记为任务内隔离）");
    expect(plan.groups.flatMap((group) => group.members)).not.toContain("shared:account-service");
  });

  it("fails closed on an invalid unit set, an unusable port and a binding conflict", () => {
    const host = topology();
    expect(() => host.setPlan({ ...planInput(), units: [] })).toThrow(/empty-selection/);
    expect(() => host.setPlan({ ...planInput(), units: [units[2]], selectedRepoDirs: ["front"] })).toThrow(/unit-repo-not-selected/);
    expect(() =>
      host.setPlan({
        ...planInput(),
        requests: [
          { unitId: "front:saas-web", port: 5173 },
          { unitId: "front:saas-bff", port: 5173 },
        ],
      }),
    ).toThrow(/port-conflict/);
    expect(() =>
      host.setPlan({
        ...planInput(),
        rules: [
          { key: "SAME", unitId: "front:saas-bff", kind: "url" },
          { key: "SAME", unitId: "invoice:invoice-service", kind: "url" },
        ],
      }),
    ).toThrow(/binding-conflict/);
    // A failed plan leaves the previous one intact rather than half-applied.
    const good = host.setPlan(planInput());
    expect(() => host.setPlan({ ...planInput(), units: [] })).toThrow();
    expect(host.plan().assignments).toEqual(good.assignments);
  });

  it("classifies shared external resources and never claims isolation without proof", () => {
    const plan = topology().setPlan({
      ...planInput(),
      externalResources: [
        { resourceId: "res-queue", name: "invoice-events", kind: "queue" },
        { resourceId: "res-dtm", name: "dtm-callback", kind: "dtm-callback" },
      ],
    });
    expect(plan.externalResources.map((resource) => resource.isolation)).toEqual(["not-isolated", "not-isolated"]);
    expect(plan.knownLimits).toHaveLength(2);
    expect(plan.diagnostics.filter((entry) => entry.code === "shared-not-isolated")).toHaveLength(2);
  });

  it("re-derives bindings when a unit switches to remote", () => {
    const host = topology();
    host.setPlan(planInput());
    const plan = host.setLocation("invoice:invoice-service", "remote");
    expect(plan.assignments.map((entry) => entry.serviceId)).toEqual(["saas-web", "saas-bff"]);
    expect(plan.bindings.map((binding) => binding.key)).toEqual(["SAAS_BFF_URL"]);
    const remote = plan.routing.find((entry) => entry.unitId === "invoice:invoice-service");
    expect(remote?.target).toEqual({ kind: "remote", environment: "testing" });
  });

  it("a rule pointing at a remote unit writes no task row", () => {
    const plan = topology().setPlan({
      ...planInput(),
      rules: [{ key: "ACCOUNT_SERVICE_URL", unitId: "shared:account-service", kind: "url" }],
    });
    expect(plan.bindings).toEqual([]);
    expect(plan.taskRows).toEqual([]);
  });
});

describe("TaskServiceTopology run records and stop scope", () => {
  it("records a run with code state, build freshness, ports, identity and log path", () => {
    const host = topology();
    host.setPlan(planInput());
    const record = host.recordRun({
      serviceId: "invoice-service",
      templateVersion: "v13",
      ports: [],
      code: { commit: "abc1234", dirty: true },
      pid: 4321,
      owner: "human",
      startedAt: "2026-09-22T10:00:00.000Z",
    });
    expect(record).toMatchObject({
      runId: "run-1",
      serviceId: "invoice-service",
      templateVersion: "v13",
      ports: [9001],
      buildFreshness: "uncommitted-code",
      processIdentity: { owner: "human", pid: 4321 },
      logRef: "/tasks/task-aaaaaaaa/services/invoice-service/run-run-1.log",
    });
    expect(host.registeredIdentities()).toEqual([
      {
        instanceId: "task-aaaaaaaa/invoice-service",
        taskId: "task-aaaaaaaa",
        serviceId: "invoice-service",
        pid: 4321,
        startedAt: "2026-09-22T10:00:00.000Z",
        owner: "human",
      },
    ]);
    const latest = host.latestRun("invoice-service", { headCommit: "abc1234", dirty: true });
    expect(latest?.current).toBe(false);
  });

  it("refuses a fabricated process identity", () => {
    const host = topology();
    host.setPlan(planInput());
    expect(() =>
      host.recordRun({ serviceId: "invoice-service", templateVersion: "v13", ports: [], code: { dirty: false }, pid: 0, owner: "human" }),
    ).toThrow(/pid must be a positive integer/);
    expect(host.runs()).toEqual([]);
  });

  it("attaches linkage verification and closes the run with an exit reason", () => {
    const host = topology();
    host.setPlan(planInput());
    host.recordRun({ serviceId: "saas-bff", templateVersion: "v13", ports: [3001], code: { commit: "abc1234", dirty: false }, pid: 77, owner: "agent" });
    const verified = host.verifyRun("run-1", { kind: "readiness", detail: "前置条件就绪检查 invoice-service", ok: true });
    expect(verified.verifications).toEqual([{ kind: "readiness", detail: "前置条件就绪检查 invoice-service", ok: true, at: "2026-09-22T10:00:00.000Z" }]);
    const closed = host.exitRun("run-1", "user-request");
    expect(closed.exit).toEqual({ reason: "user-request" });
    expect(host.registeredIdentities()).toEqual([]);
    expect(() => host.exitRun("run-9", "x")).toThrow(/unknown-run/);
    expect(() => host.verifyRun("run-9", { kind: "linkage", detail: "x", ok: false })).toThrow(/unknown-run/);
  });

  it("computes the stop scope from registered identities only", () => {
    const host = topology();
    host.setPlan(planInput());
    host.recordRun({ serviceId: "saas-bff", templateVersion: "v13", ports: [3001], code: { dirty: false }, pid: 11, owner: "human" });
    host.recordRun({ serviceId: "invoice-service", templateVersion: "v13", ports: [9001], code: { dirty: false }, pid: 22, owner: "human" });
    expect(host.stopScope().stop.map((entry) => entry.pid).sort()).toEqual([11, 22]);
    expect(host.stopScope("task-aaaaaaaa/invoice-service").stop.map((entry) => entry.pid)).toEqual([22]);
    expect(() => host.stopScope("task-aaaaaaaa/ghost")).toThrow(/unknown-instance/);
  });
});
