import { describe, expect, it } from "vitest";
import {
  auditBindingReadPoints,
  bindingsToTaskRows,
  describeDependencyRouting,
  endpointKeyCandidates,
  instanceAddress,
  planPortAssignments,
  planStartGroups,
  reallocatePortAssignments,
  renderBindingValue,
  resolveTaskBindings,
  serviceInstanceId,
  setUnitLocation,
  unitsByRepo,
  validateRunUnitSelection,
  type BindingLayers,
  type RunUnit,
} from "./service-topology.js";

// Seam: #10 multi-service topology rules. Pure so the task view, main and
// the Host cannot drift. Time-boxed S1: rules only, no process spawn.

const units: RunUnit[] = [
  { unitId: "front:saas-web", serviceId: "saas-web", name: "saas-web", repoDir: "front", location: "local" },
  { unitId: "front:saas-bff", serviceId: "saas-bff", name: "saas-bff", repoDir: "front", location: "local" },
  { unitId: "invoice:invoice-service", serviceId: "invoice-service", name: "invoice-service", repoDir: "invoice", location: "local" },
  { unitId: "shared:account-service", serviceId: "account-service", name: "account-service", location: "remote" },
];

const emptyLayers: BindingLayers = { repoDefaults: [], shared: [], privateEntries: [], task: [] };

describe("run-unit selection", () => {
  it("accepts several run units from one repository", () => {
    const result = validateRunUnitSelection({ selectedRepoDirs: ["front", "invoice"], units });
    expect(result.ok).toBe(true);
    const byRepo = unitsByRepo(result.ok ? result.units : []);
    expect(byRepo.map((entry) => [entry.repoDir, entry.units.length])).toEqual([
      ["front", 2],
      ["invoice", 1],
      ["", 1],
    ]);
  });

  it("rejects empty selections, duplicates and units from repos not in the task", () => {
    expect(validateRunUnitSelection({ selectedRepoDirs: ["front"], units: [] })).toMatchObject({ ok: false });
    const dup = validateRunUnitSelection({
      selectedRepoDirs: ["front"],
      units: [units[0], units[0]],
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.code).toBe("duplicate-unit");
    const foreign = validateRunUnitSelection({ selectedRepoDirs: ["front"], units: [units[2]] });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) {
      expect(foreign.error.code).toBe("unit-repo-not-selected");
      expect(foreign.error.scope.unitId).toBe("invoice:invoice-service");
    }
  });

  it("switches one unit between local and remote without touching the rest", () => {
    const result = setUnitLocation(units, "front:saas-web", "remote");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.units.find((unit) => unit.unitId === "front:saas-web")?.location).toBe("remote");
    expect(result.units.find((unit) => unit.unitId === "front:saas-bff")?.location).toBe("local");
    expect(setUnitLocation(units, "nope", "local")).toMatchObject({ ok: false });
  });
});

describe("port-first planning", () => {
  it("reports missing ports, intra-task duplicates, other-task and external occupancy", () => {
    const plan = planPortAssignments({
      taskId: "task-aaaaaaaa",
      units,
      requests: [
        { unitId: "front:saas-web", port: 5173 },
        { unitId: "front:saas-bff", port: 5173 },
        { unitId: "invoice:invoice-service", port: 9001 },
      ],
      reservations: [
        { port: 9001, owner: "task", taskId: "task-bbbbbbbb", unitId: "invoice:invoice-service", serviceId: "invoice-service" },
        { port: 5173, owner: "external", note: "另一个 vite" },
      ],
    });
    const codes = plan.diagnostics.map((entry) => `${entry.code}:${entry.scope.unitId ?? ""}:${entry.scope.port ?? ""}`);
    expect(codes).toContain("port-conflict:front:saas-web:5173");
    expect(codes).toContain("port-conflict:front:saas-bff:5173");
    expect(codes).toContain("port-taken:invoice:invoice-service:9001");
    expect(plan.assignments).toHaveLength(0);
    const missing = planPortAssignments({ taskId: "t", units: [units[0]], requests: [], reservations: [] });
    expect(missing.diagnostics[0]?.code).toBe("missing-port");
  });

  it("reuses this task's own reservation for the same unit", () => {
    const plan = planPortAssignments({
      taskId: "task-aaaaaaaa",
      units: [units[0]],
      requests: [{ unitId: "front:saas-web", port: 5173 }],
      reservations: [{ port: 5173, owner: "task", taskId: "task-aaaaaaaa", unitId: "front:saas-web", serviceId: "saas-web" }],
    });
    expect(plan.diagnostics).toEqual([]);
    expect(plan.assignments).toEqual([
      { unitId: "front:saas-web", serviceId: "saas-web", port: 5173, instanceId: "task-aaaaaaaa/saas-web" },
    ]);
  });

  it("gives two tasks running the same service name different local ports", () => {
    const requests = [{ unitId: "invoice:invoice-service", port: 9001 }];
    const first = reallocatePortAssignments({
      taskId: "task-aaaaaaaa",
      units: [units[2]],
      requests,
      reservations: [],
    });
    expect(first.assignments[0]?.port).toBe(9001);
    const second = reallocatePortAssignments({
      taskId: "task-bbbbbbbb",
      units: [{ ...units[2], unitId: "invoice:invoice-service" }],
      requests,
      reservations: [{ port: 9001, owner: "task", taskId: "task-aaaaaaaa", unitId: "invoice:invoice-service", serviceId: "invoice-service" }],
    });
    expect(second.diagnostics).toEqual([]);
    expect(second.assignments[0]?.port).toBe(9002);
    expect(second.reallocated).toEqual([{ unitId: "invoice:invoice-service", before: 9001, after: 9002 }]);
    expect(second.assignments[0]?.instanceId).toBe("task-bbbbbbbb/invoice-service");
  });

  it("bumps past externally occupied ports and fails closed when nothing is free", () => {
    const external = reallocatePortAssignments({
      taskId: "t",
      units: [units[0]],
      requests: [{ unitId: "front:saas-web", port: 5173 }],
      reservations: [{ port: 5173, owner: "external", note: "系统服务" }],
    });
    expect(external.assignments[0]?.port).toBe(5174);
    const capped = reallocatePortAssignments({
      taskId: "t",
      units: [units[0]],
      requests: [{ unitId: "front:saas-web", port: 5173 }],
      reservations: [
        { port: 5173, owner: "external" },
        { port: 5174, owner: "external" },
      ],
      maxSteps: 1,
    });
    expect(capped.assignments).toEqual([]);
    expect(capped.diagnostics.map((entry) => entry.code)).toEqual(["port-unavailable"]);
  });
});

describe("variable bindings", () => {
  const assignments = [
    { unitId: "front:saas-bff", serviceId: "saas-bff", port: 3001, instanceId: "task-aaaaaaaa/saas-bff" },
    { unitId: "invoice:invoice-service", serviceId: "invoice-service", port: 9001, instanceId: "task-aaaaaaaa/invoice-service" },
  ];

  it("writes a complete URL as a whole task override and records its read points", () => {
    const layers: BindingLayers = {
      ...emptyLayers,
      repoDefaults: [{ key: "INVOICE_SERVICE_ENDPOINT", value: "https://invoice.test.example", secret: false }],
      shared: [{ key: "SAAS_BFF_URL", value: "https://bff.test.example", secret: false }],
    };
    const resolved = resolveTaskBindings({
      rules: [
        { key: "INVOICE_SERVICE_ENDPOINT", unitId: "invoice:invoice-service", kind: "url", template: "http://127.0.0.1:${port}/v1" },
        { key: "SAAS_BFF_URL", unitId: "front:saas-bff", kind: "url" },
      ],
      assignments,
      units,
      layers,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.bindings.map((binding) => [binding.key, binding.value])).toEqual([
      ["INVOICE_SERVICE_ENDPOINT", "http://127.0.0.1:9001/v1"],
      ["SAAS_BFF_URL", "http://127.0.0.1:3001"],
    ]);
    expect(resolved.bindings[0]?.readPoints).toEqual(["仓库默认配置"]);
    expect(resolved.bindings[1]?.readPoints).toEqual(["共享模板"]);
    expect(resolved.diagnostics).toEqual([]);
    expect(bindingsToTaskRows(resolved.bindings)).toEqual([
      { key: "INVOICE_SERVICE_ENDPOINT", value: "http://127.0.0.1:9001/v1", secret: false },
      { key: "SAAS_BFF_URL", value: "http://127.0.0.1:3001", secret: false },
    ]);
  });

  it("audits read points in both directions: unread binding and unbound read point", () => {
    const audit = auditBindingReadPoints({
      bindings: [
        {
          key: "UNUSED_KEY",
          value: "http://127.0.0.1:9001",
          kind: "url",
          unitId: "invoice:invoice-service",
          serviceId: "invoice-service",
          instanceId: "task-aaaaaaaa/invoice-service",
          port: 9001,
          readPoints: [],
        },
      ],
      units,
      layers: { ...emptyLayers, repoDefaults: [{ key: "INVOICE_SERVICE_URL", value: "https://old.example", secret: false }] },
    });
    expect(audit.unboundKeys).toEqual([{ key: "INVOICE_SERVICE_URL", source: "仓库默认配置", unitId: "invoice:invoice-service" }]);
    expect(audit.diagnostics[0]?.code).toBe("missing-binding");
    expect(audit.diagnostics[0]?.scope.key).toBe("INVOICE_SERVICE_URL");
    const unresolved = resolveTaskBindings({
      rules: [{ key: "UNUSED_KEY", unitId: "invoice:invoice-service", kind: "url" }],
      assignments,
      units,
      layers: emptyLayers,
    });
    expect(unresolved.ok).toBe(true);
    expect(unresolved.diagnostics.map((entry) => entry.code)).toContain("unused-binding");
  });

  it("fails closed on conflicting destinations and on unassigned local units", () => {
    const conflict = resolveTaskBindings({
      rules: [
        { key: "INVOICE_SERVICE_ENDPOINT", unitId: "invoice:invoice-service", kind: "url" },
        { key: "INVOICE_SERVICE_ENDPOINT", unitId: "front:saas-bff", kind: "url" },
      ],
      assignments,
      units,
      layers: emptyLayers,
    });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.diagnostics[0]?.code).toBe("binding-conflict");
    expect(conflict.diagnostics[0]?.scope.key).toBe("INVOICE_SERVICE_ENDPOINT");
    const noPort = resolveTaskBindings({
      rules: [{ key: "SAAS_WEB_URL", unitId: "front:saas-web", kind: "url" }],
      assignments,
      units,
      layers: emptyLayers,
    });
    expect(noPort.ok).toBe(false);
    if (!noPort.ok) expect(noPort.diagnostics[0]?.code).toBe("missing-port");
  });

  it("writes no task override for a remote dependency", () => {
    const resolved = resolveTaskBindings({
      rules: [{ key: "ACCOUNT_SERVICE_URL", unitId: "shared:account-service", kind: "url" }],
      assignments,
      units,
      layers: emptyLayers,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.bindings).toEqual([]);
    expect(resolved.diagnostics).toEqual([]);
  });

  it("derives endpoint key candidates and renders template values", () => {
    expect(endpointKeyCandidates("saas-bff")).toEqual(["SAAS_BFF_ENDPOINT", "SAAS_BFF_URL", "SAAS_BFF_BASE_URL", "SAAS_BFF_HOST"]);
    expect(endpointKeyCandidates("")).toEqual([]);
    expect(renderBindingValue("url", 9001)).toBe("http://127.0.0.1:9001");
    expect(renderBindingValue("host-port", 9001)).toBe("127.0.0.1:9001");
    expect(renderBindingValue("url", 9001, "grpc://${host}:${port}")).toBe("grpc://127.0.0.1:9001");
  });
});

describe("dependency kinds and start groups", () => {
  it("runs prepare steps first, then listeners in dependency order", () => {
    const plan = planStartGroups({
      units: [
        { ...units[0], runType: "long-lived" },
        { ...units[1], runType: "long-lived" },
        { ...units[2], runType: "prepare" },
      ],
      dependencies: [
        { from: "front:saas-web", to: "front:saas-bff", kind: "call" },
        { from: "front:saas-bff", to: "invoice:invoice-service", kind: "prestart" },
      ],
    });
    expect(plan.groups.map((group) => [group.groupId, group.members, group.reason])).toEqual([
      ["prestart", ["invoice:invoice-service"], "prestart"],
      ["listen-0", ["front:saas-bff"], "single"],
      ["listen-1", ["front:saas-web"], "single"],
    ]);
    expect(plan.groups[1]?.verify).toEqual(["前置条件就绪检查 invoice-service"]);
    expect(plan.groups[2]?.verify).toEqual(["联通检查 saas-bff（front:saas-bff）"]);
    expect(plan.diagnostics).toEqual([]);
  });

  it("merges a bidirectional call pair into one listener group with a linkage check", () => {
    const plan = planStartGroups({
      units: [units[0], units[1]],
      dependencies: [
        { from: "front:saas-web", to: "front:saas-bff", kind: "call" },
        { from: "front:saas-bff", to: "front:saas-web", kind: "call" },
      ],
    });
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]).toMatchObject({ reason: "listener-group", bidirectional: true });
    expect(plan.groups[0]?.members.sort()).toEqual(["front:saas-bff", "front:saas-web"]);
    expect(plan.groups[0]?.verify).toEqual([
      "联通检查 saas-bff（front:saas-bff）",
      "联通检查 saas-web（front:saas-web）",
      "双向调用组联通检查（先监听再互验，不等待对方就绪）",
    ]);
  });

  it("turns a remote dependency into a reachability check instead of a start step", () => {
    const plan = planStartGroups({
      units,
      dependencies: [{ from: "front:saas-web", to: "shared:account-service", kind: "call" }],
    });
    const webGroup = plan.groups.find((group) => group.members.includes("front:saas-web"));
    expect(webGroup?.verify).toEqual(["远程依赖可达性检查 account-service（共享环境，不标记为任务内隔离）"]);
    expect(plan.groups.flatMap((group) => group.members)).not.toContain("shared:account-service");
  });

  it("reports unknown units and contradictory prestart-inside-a-cycle instead of waiting", () => {
    const unknown = planStartGroups({ units, dependencies: [{ from: "front:saas-web", to: "ghost", kind: "call" }] });
    expect(unknown.diagnostics.map((entry) => entry.code)).toEqual(["unknown-unit"]);
    expect(unknown.diagnostics[0]?.scope.unitId).toBe("ghost");
    const contradictory = planStartGroups({
      units: [units[0], units[1]],
      dependencies: [
        { from: "front:saas-web", to: "front:saas-bff", kind: "call" },
        { from: "front:saas-bff", to: "front:saas-web", kind: "call" },
        { from: "front:saas-bff", to: "front:saas-web", kind: "prestart" },
      ],
    });
    expect(contradictory.diagnostics.map((entry) => entry.code)).toEqual(["start-order-conflict"]);
    expect(contradictory.groups[0]?.reason).toBe("listener-group");
  });
});

describe("routing and reallocation", () => {
  it("describes where each unit is reachable and which variables route to it", () => {
    const routing = describeDependencyRouting({
      taskId: "task-aaaaaaaa",
      bindings: [
        {
          key: "INVOICE_SERVICE_ENDPOINT",
          value: "http://127.0.0.1:9001",
          kind: "url",
          unitId: "invoice:invoice-service",
          serviceId: "invoice-service",
          instanceId: "task-aaaaaaaa/invoice-service",
          port: 9001,
          readPoints: ["仓库默认配置"],
        },
      ],
      assignments: [{ unitId: "invoice:invoice-service", serviceId: "invoice-service", port: 9001, instanceId: "task-aaaaaaaa/invoice-service" }],
      units,
      environment: "testing",
    });
    const local = routing.find((entry) => entry.unitId === "invoice:invoice-service");
    expect(local?.target).toEqual({
      kind: "local-instance",
      instanceId: "task-aaaaaaaa/invoice-service",
      serviceId: "invoice-service",
      port: 9001,
      address: "task-aaaaaaaa/invoice-service@9001",
    });
    expect(local?.keys).toEqual([{ key: "INVOICE_SERVICE_ENDPOINT", value: "http://127.0.0.1:9001", readPoints: ["仓库默认配置"] }]);
    expect(local?.consumers).toContain("front:saas-bff");
    expect(local?.consumers).not.toContain("invoice:invoice-service");
    const remote = routing.find((entry) => entry.unitId === "shared:account-service");
    expect(remote?.target).toEqual({ kind: "remote", environment: "testing" });
    expect(remote?.keys).toEqual([]);
    expect(serviceInstanceId("task-aaaaaaaa", "invoice-service")).toBe("task-aaaaaaaa/invoice-service");
    expect(instanceAddress("task-aaaaaaaa", "invoice-service")).toBe("task-aaaaaaaa/invoice-service");
  });

  it("reflects a reallocated port in every consumer binding", () => {
    const reservations = [
      { port: 9001, owner: "task" as const, taskId: "task-bbbbbbbb", unitId: "invoice:invoice-service", serviceId: "invoice-service" },
    ];
    const ports = reallocatePortAssignments({
      taskId: "task-aaaaaaaa",
      units,
      requests: [{ unitId: "invoice:invoice-service", port: 9001 }],
      reservations,
    });
    expect(ports.reallocated).toEqual([{ unitId: "invoice:invoice-service", before: 9001, after: 9002 }]);
    const resolved = resolveTaskBindings({
      rules: [
        { key: "INVOICE_SERVICE_ENDPOINT", unitId: "invoice:invoice-service", kind: "url", template: "http://127.0.0.1:${port}/v1" },
        { key: "INVOICE_SERVICE_URL", unitId: "invoice:invoice-service", kind: "host-port" },
      ],
      assignments: ports.assignments,
      units,
      layers: { ...emptyLayers, repoDefaults: [{ key: "INVOICE_SERVICE_ENDPOINT", value: "https://shared.example", secret: false }] },
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // Both consumers of the same instance moved together to the new port.
    expect(resolved.bindings.map((binding) => binding.value)).toEqual(["http://127.0.0.1:9002/v1", "127.0.0.1:9002"]);
  });

});
