/**
 * [PiDock 05] (#10 box 4) group start + linkage verification, WITHOUT real
 * children: the state machine, the honest negative states and the ordering.
 *
 * The real-process evidence (start order really happened, real connect reached
 * the intended unit, gate integrity, process hygiene) lives in
 * `service-group-linkage.test.ts`. This suite pins the rules that a real child
 * cannot conveniently produce — a refusing gate, a parked approval, a probe that
 * never answers — and asserts that none of them can be smoothed into a green
 * group.
 *
 * Only the pure plan (`planStartGroups`) and the injected ports are exercised;
 * `startUnit` here is a recording stub, never the gated dispatch. The wiring
 * that makes `startUnit` the ONE gated dispatch is exercised by the real-process
 * suite through the Host.
 */
import { describe, expect, it } from "vitest";
import { planStartGroups, type RunUnit, type ServiceDependency } from "../main/service-topology.js";
import type { ProcessIdentity, RunRecord, RunVerification } from "../main/service-runs.js";
import {
  runServiceGroupStart,
  type GroupUnitStartResult,
  type ServiceGroupPlanPort,
} from "./service-group-run.js";
import type { ListeningAddress, ListeningObservation, ServiceObservationPort } from "./service-linkage.js";

function unit(unitId: string, serviceId: string, name: string): RunUnit {
  return { unitId, serviceId, name, repoDir: "repo", location: "local", runType: "long-lived" };
}

interface Harness {
  topology: ServiceGroupPlanPort;
  addresses: Map<string, ListeningAddress | undefined>;
  /** serviceId → the pid the fake start "observed". */
  pids: Map<string, number>;
  verifications: { runId: string; input: { kind: RunVerification["kind"]; detail: string; ok: boolean } }[];
  startedOrder: string[];
  observes: string[];
}

function harness(input: {
  units: RunUnit[];
  dependencies?: ServiceDependency[];
  reallocated?: { unitId: string; before: number; after: number }[];
  running?: string[];
  addresses: Record<string, ListeningAddress | undefined>;
}): Harness {
  const dependencies = input.dependencies ?? [];
  const groups = planStartGroups({ units: input.units, dependencies }).groups;
  const runs: RunRecord[] = [];
  const addresses = new Map(Object.entries(input.addresses));
  const pids = new Map<string, number>();
  const verifications: Harness["verifications"] = [];
  const observes: string[] = [];
  const identities: ProcessIdentity[] = (input.running ?? []).map((serviceId) => ({
    instanceId: `task-1/${serviceId}`,
    taskId: "task-1",
    serviceId,
    pid: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    owner: "human" as const,
  }));
  const topology: ServiceGroupPlanPort = {
    plan: () => ({
      groups,
      units: input.units,
      assignments: input.units.map((u, index) => ({ unitId: u.unitId, serviceId: u.serviceId, port: 4000 + index, instanceId: `task-1/${u.serviceId}` })),
      reallocated: input.reallocated ?? [],
      // No HOST-side planning diagnostics in this stub harness. The real
      // `TaskServiceTopology` carries them (the read-point audit among them), and
      // `service-binding-readpoints.test.ts` asserts they reach the group answer.
      diagnostics: [],
    }),
    plannedDependencies: () => dependencies,
    runs: () => runs,
    registeredIdentities: () => identities,
    verifyRun: (runId, entry) => {
      verifications.push({ runId, input: entry });
      return runs.find((r) => r.runId === runId) as RunRecord;
    },
  };
  void observes;
  return { topology, addresses, pids, verifications, startedOrder: [], observes };
}

function recordingStart(f: Harness, results: Record<string, GroupUnitStartResult>) {
  return async ({ serviceId }: { unitId: string; serviceId: string }): Promise<GroupUnitStartResult> => {
    const result = results[serviceId] ?? { ok: true };
    if (result.ok) {
      f.startedOrder.push(serviceId);
      const pid = 1000 + f.startedOrder.length;
      f.pids.set(serviceId, pid);
      // The real driver writes the run record before a start resolves; the fake
      // start does the same, so `latestOpenRun` finds the observed pid.
      f.topology.runs().push(openRun(serviceId, `run-${serviceId}`, pid));
      // The driver's own return value is the real pid the start produced.
      return { ok: true, pid };
    }
    return result;
  };
}

/** A prior open run record for a service, as an earlier run (or session) left it. */
function openRun(serviceId: string, runId: string, pid: number): RunRecord {
  return {
    runId,
    taskId: "task-1",
    serviceId,
    instanceId: `task-1/${serviceId}`,
    templateVersion: "v0",
    codeState: { kind: "unknown", note: "" },
    buildFreshness: "unknown",
    ports: [],
    portsSource: "declared",
    processIdentity: { owner: "human", pid, startedAt: "2026-01-01T00:00:00.000Z" },
    logRef: "",
    startedAt: "2026-01-01T00:00:00.000Z",
    verifications: [],
  };
}

function observation(byService: Record<string, ListeningObservation>): ServiceObservationPort {
  return {
    probeListening: async (address) => byService[`${address.host}:${address.port}`] ?? "not-listening",
  };
}

const A = unit("repo:a", "a", "调用方");
const B = unit("repo:b", "b", "被调用方");
const ADDRESSES = { a: { host: "127.0.0.1", port: 4101 }, b: { host: "127.0.0.1", port: 4102 } };

describe("#10 group start and linkage verification state machine", () => {
  it("starts the callee group first, observes listening, and verifies the linkage from a real connect", async () => {
    const f = harness({ units: [A, B], dependencies: [{ from: "repo:a", to: "repo:b", kind: "call" }], addresses: ADDRESSES });
    const result = await runServiceGroupStart({
      topology: f.topology,
      startUnit: recordingStart(f, {}),
      observation: observation({ "127.0.0.1:4101": "listening", "127.0.0.1:4102": "listening" }),
      registeredAddress: (serviceId) => f.addresses.get(serviceId),
    });
    // The plan's own order (callee before caller) is the order the units really started in.
    expect(f.startedOrder).toEqual(["b", "a"]);
    expect(result.state).toBe("verified");
    const unitA = result.units.find((u) => u.serviceId === "a");
    const unitB = result.units.find((u) => u.serviceId === "b");
    expect(unitA).toMatchObject({ start: "started", order: 2, listening: "listening", linked: true, pid: f.pids.get("a") });
    expect(unitB).toMatchObject({ start: "started", order: 1, listening: "listening" });
    expect(unitA?.steps).toHaveLength(1);
    expect(unitA?.steps[0]).toMatchObject({ kind: "linkage", outcome: "passed", address: ADDRESSES.b });
    // Observations ride the EXISTING verification shape on the unit's own run.
    expect(f.verifications.filter((v) => v.runId === "run-b" && v.input.kind === "readiness" && v.input.ok)).toHaveLength(1);
    expect(f.verifications.find((v) => v.runId === "run-a" && v.input.kind === "linkage")).toMatchObject({ input: { ok: true } });
  });

  it("refuses the whole group when a unit's gate refuses, and never credits a linkage from the plan", async () => {
    const f = harness({ units: [A, B], dependencies: [{ from: "repo:a", to: "repo:b", kind: "call" }], addresses: ADDRESSES });
    const result = await runServiceGroupStart({
      topology: f.topology,
      startUnit: recordingStart(f, { b: { ok: false, kind: "refused", error: "只读会话禁止服务启停，请先调整会话权限" } }),
      observation: observation({ "127.0.0.1:4101": "listening", "127.0.0.1:4102": "listening" }),
      registeredAddress: (serviceId) => f.addresses.get(serviceId),
    });
    expect(result.state).toBe("refused");
    // The refused unit's caller was never started: a prerequisite that never
    // came up must not be started into a green group.
    expect(f.startedOrder).toEqual([]);
    expect(result.units.find((u) => u.serviceId === "a")).toMatchObject({ start: "not-started" });
    // A gate refusal keeps its OWN diagnostic code - it is not a start failure.
    expect(result.units.find((u) => u.serviceId === "b")?.diagnostics[0]?.code).toBe("control-refused");
    expect(result.diagnostics.some((d) => d.code === "control-refused" && d.scope.unitId === "repo:b")).toBe(true);
    expect(result.diagnostics.some((d) => d.code === "start-failed")).toBe(false);
    // THE assertion that fails if linkage is credited from the plan instead of a
    // real observation: no linkage verification exists at all here.
    expect(f.verifications.filter((v) => v.input.kind === "linkage")).toEqual([]);
    expect(result.state).not.toBe("verified");
  });

  it("parks on a default-tier approval with nothing started", async () => {
    const f = harness({ units: [A, B], dependencies: [{ from: "repo:a", to: "repo:b", kind: "call" }], addresses: ADDRESSES });
    const result = await runServiceGroupStart({
      topology: f.topology,
      startUnit: recordingStart(f, { b: { ok: false, kind: "approval-required", error: "approval-required: approval-1" } }),
      observation: observation({ "127.0.0.1:4101": "listening", "127.0.0.1:4102": "listening" }),
      registeredAddress: (serviceId) => f.addresses.get(serviceId),
    });
    expect(result.state).toBe("approval-required");
    expect(f.startedOrder).toEqual([]);
    expect(f.verifications).toEqual([]);
    // A parked approval is named as such, never folded into 启动失败.
    expect(result.units.find((u) => u.serviceId === "b")?.diagnostics[0]?.code).toBe("approval-required");
    expect(result.diagnostics.some((d) => d.code === "start-failed")).toBe(false);
  });

  it("names the unit that failed to start and keeps its start failure locatable", async () => {
    const f = harness({ units: [A, B], dependencies: [{ from: "repo:a", to: "repo:b", kind: "call" }], addresses: ADDRESSES });
    const result = await runServiceGroupStart({
      topology: f.topology,
      startUnit: recordingStart(f, { b: { ok: false, kind: "start-failed", error: "spawn ENOENT" } }),
      observation: observation({ "127.0.0.1:4101": "listening", "127.0.0.1:4102": "listening" }),
      registeredAddress: (serviceId) => f.addresses.get(serviceId),
    });
    expect(result.state).toBe("start-failed");
    const failure = result.units.find((u) => u.serviceId === "b")?.diagnostics[0];
    // The existing diagnoser is wired, not re-worded: port-aware start-failed.
    expect(failure).toMatchObject({ code: "start-failed", scope: { unitId: "repo:b" } });
    expect(result.diagnostics.some((d) => d.code === "start-failed" && d.scope.unitId === "repo:b")).toBe(true);
  });

  it("reports an unreachable dependency distinctly when the dependency started but does not answer", async () => {
    const f = harness({ units: [A, B], dependencies: [{ from: "repo:a", to: "repo:b", kind: "call" }], addresses: ADDRESSES });
    const result = await runServiceGroupStart({
      topology: f.topology,
      startUnit: recordingStart(f, {}),
      observation: observation({ "127.0.0.1:4101": "listening", "127.0.0.1:4102": "not-listening" }),
      registeredAddress: (serviceId) => f.addresses.get(serviceId),
    });
    expect(result.state).toBe("dependency-unreachable");
    expect(result.state).not.toBe("start-failed");
    const unitA = result.units.find((u) => u.serviceId === "a");
    expect(unitA).toMatchObject({ start: "started", linked: false });
    expect(unitA?.steps[0]).toMatchObject({ kind: "linkage", outcome: "dependency-unreachable" });
    // A real failed connect is recorded as a failed linkage verification - never a pass.
    expect(f.verifications.find((v) => v.runId === "run-a" && v.input.kind === "linkage")?.input.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "dependency-unreachable" && d.scope.unitId === "repo:a")).toBe(true);
  });

  it("keeps 未探测 a named state and attaches no verification when there is no address to probe", async () => {
    const f = harness({ units: [A, B], dependencies: [{ from: "repo:a", to: "repo:b", kind: "call" }], addresses: { a: ADDRESSES.a, b: undefined } });
    const result = await runServiceGroupStart({
      topology: f.topology,
      startUnit: recordingStart(f, {}),
      observation: observation({ "127.0.0.1:4101": "listening" }),
      registeredAddress: (serviceId) => f.addresses.get(serviceId),
    });
    expect(result.state).toBe("not-probed");
    const unitA = result.units.find((u) => u.serviceId === "a");
    expect(unitA?.steps[0]).toMatchObject({ kind: "linkage", outcome: "not-probed" });
    expect(f.verifications.filter((v) => v.input.kind === "linkage")).toEqual([]);
  });

  it("reports a readiness (prestart) step that failed as verify-failed, distinct from an unreachable call dependency", async () => {
    const prepare: RunUnit = { unitId: "repo:prep", serviceId: "prep", name: "准备步骤", repoDir: "repo", location: "local", runType: "prepare" };
    const f = harness({ units: [prepare], addresses: { prep: { host: "127.0.0.1", port: 4301 } } });
    const result = await runServiceGroupStart({
      topology: f.topology,
      startUnit: recordingStart(f, {}),
      observation: observation({ "127.0.0.1:4301": "not-listening" }),
      registeredAddress: (serviceId) => f.addresses.get(serviceId),
    });
    expect(result.state).toBe("verify-failed");
    const failure = result.diagnostics.find((d) => d.code === "verify-failed");
    expect(failure).toMatchObject({ code: "verify-failed", scope: { unitId: "repo:prep" } });
    // The readiness step is NOT an unreachable call dependency.
    expect(result.diagnostics.some((d) => d.code === "dependency-unreachable")).toBe(false);
    // The unit's own listening observation is recorded exactly ONCE (the
    // prestart step reuses it instead of probing and recording it twice).
    expect(f.verifications.filter((v) => v.input.kind === "readiness")).toHaveLength(1);
  });

  it("locates a real bind failure on the unit's declared port", async () => {
    const f = harness({ units: [B], addresses: { b: { host: "127.0.0.1", port: 4302 } } });
    const result = await runServiceGroupStart({
      topology: f.topology,
      startUnit: recordingStart(f, { b: { ok: false, kind: "start-failed", error: "listen EADDRINUSE: address already in use 127.0.0.1:4302" } }),
      observation: observation({}),
      registeredAddress: (serviceId) => f.addresses.get(serviceId),
    });
    expect(result.state).toBe("start-failed");
    expect(result.diagnostics.find((d) => d.scope.unitId === "repo:b")).toMatchObject({ code: "port-taken", scope: { unitId: "repo:b", port: 4302 } });
  });

  it("credits a start only to the run record its own pid produced, never an older open record", async () => {
    const f = harness({ units: [B], addresses: { b: ADDRESSES.b } });
    // An earlier run (another session) is still open for this service.
    f.topology.runs().push(openRun("b", "run-b-old", 777));
    const result = await runServiceGroupStart({
      topology: f.topology,
      // The dispatch really started pid 5555, but its bookkeeping wrote no record.
      startUnit: async () => ({ ok: true, pid: 5555 }),
      observation: observation({ "127.0.0.1:4102": "listening" }),
      registeredAddress: (serviceId) => f.addresses.get(serviceId),
    });
    const unitB = result.units.find((u) => u.serviceId === "b");
    // The stale 777 pid must NOT be credited to this start.
    expect(unitB).toMatchObject({ start: "started", observedRun: false });
    expect(unitB?.pid).toBeUndefined();
  });

  it("names the consumers a reallocated plan port still owes, and claims no update", async () => {
    const f = harness({
      units: [A, B],
      dependencies: [{ from: "repo:a", to: "repo:b", kind: "call" }],
      reallocated: [{ unitId: "repo:b", before: 4102, after: 4212 }],
      running: ["b"],
      addresses: { a: ADDRESSES.a, b: ADDRESSES.b },
    });
    const result = await runServiceGroupStart({
      topology: f.topology,
      startUnit: recordingStart(f, {}),
      observation: observation({ "127.0.0.1:4101": "listening", "127.0.0.1:4102": "listening" }),
      registeredAddress: (serviceId) => f.addresses.get(serviceId),
    });
    // The existing restart-scope rule names the unit that must be restarted /
    // re-pointed; nothing here claims it was already updated.
    expect(result.restartScope).toEqual([{ unitId: "repo:b", reason: "port-reallocated" }]);
    expect(result.reallocated).toEqual([{ unitId: "repo:b", before: 4102, after: 4212 }]);
  });

  it("has no planned group to start and says so by name instead of claiming success", async () => {
    const f = harness({ units: [], dependencies: [], addresses: {} });
    const result = await runServiceGroupStart({
      topology: f.topology,
      startUnit: recordingStart(f, {}),
      observation: observation({}),
      registeredAddress: () => undefined,
    });
    expect(result.state).toBe("not-planned");
    expect(result.diagnostics[0]?.code).toBe("empty-selection");
  });
});
