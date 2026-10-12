/**
 * [PiDock 05] (#10 box 4) 整组启动 from the SHIPPED dock, and the honesty rules
 * of the group result it renders.
 *
 * "Real payload": the group result below is projected by the Host's OWN group
 * runner (`host/service-group-run.ts runServiceGroupStart`, the exact object
 * `host.ts:runGroupServiceStart` returns), driven over a real `TaskServiceTopology`
 * plan with the deterministic observation port the runner's own suite uses. So a
 * rename or an added field in the real projectors fails HERE instead of silently
 * degrading to the 未探测 / unreadable state.
 *
 * Pinned here:
 *  - THE production-reachability assertion: the shipped 运行 panel really owns
 *    the affordance, and it reaches it ONLY through the catalog envelope
 *    (`{op:"runTaskServiceGroup", projectId, taskId}`) - it never sends a unit
 *    list and never calls `task/controlService` itself;
 *  - 已启动 / 已监听 / 已互验 come only from the Host's own observations;
 *  - a refused/failed unit can never leave a green group in payload or UI;
 *  - a plan with no dependency edge says so instead of implying a verification;
 *  - an absent or malformed group result is a named refusal, never a fixture.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopToolDock } from "../components/DesktopToolDock";
import {
  GROUP_DIAGNOSTIC_KEYS,
  GROUP_RUN_KEYS,
  GROUP_STEP_KEYS,
  GROUP_UNIT_KEYS,
  serviceGroupRunFromHost,
} from "../data/taskServices";
import { runServiceGroupStart } from "../../../shell/src/host/service-group-run.js";
import { TaskServiceTopology } from "../../../shell/src/host/service-topology.js";

const CALLEE_ID = "s-11111111-1111-1111-1111-111111111111";
const CALLER_ID = "s-22222222-2222-2222-2222-222222222222";
const CALLEE_UNIT = "invoice-service:api";
const CALLER_UNIT = "invoice-service:web";
const STARTED_AT = "2026-10-08T00:00:00.000Z";

function plannedTopology() {
  const topology = new TaskServiceTopology("task-1", "/tmp/task-1", () => STARTED_AT);
  topology.setPlan({
    units: [
      { unitId: CALLEE_UNIT, serviceId: CALLEE_ID, name: "invoice-api", repoDir: "invoice-service", location: "local", runType: "long-lived" },
      { unitId: CALLER_UNIT, serviceId: CALLER_ID, name: "invoice-web", repoDir: "invoice-service", location: "local", runType: "long-lived" },
    ],
    selectedRepoDirs: ["invoice-service"],
    dependencies: [{ from: CALLER_UNIT, to: CALLEE_UNIT, kind: "call" }],
    requests: [{ unitId: CALLEE_UNIT, port: 4100 }, { unitId: CALLER_UNIT, port: 4101 }],
  });
  return topology;
}

/**
 * The REAL Host emit for a group start: every unit start goes through the driver
 * seam (a real `recordRun` for every unit that really started, the pid the group
 * runner reads back), the observation port decides what was really accepted, and
 * a unit the runner was told to refuse is refused before any run is recorded.
 */
async function realGroupRun(options: {
  start?: Record<string, "ok" | "refused" | "start-failed">;
  listening?: Record<string, "listening" | "not-listening" | "not-probed">;
} = {}) {
  const topology = plannedTopology();
  let pid = 4200;
  const result = await runServiceGroupStart({
    topology,
    startUnit: async ({ serviceId }) => {
      const outcome = options.start?.[serviceId] ?? "ok";
      if (outcome === "refused") return { ok: false, kind: "refused", error: "read 权限不提供启停入口" };
      if (outcome === "start-failed") return { ok: false, kind: "start-failed", error: "spawn EACCES" };
      pid += 1;
      topology.recordRun({ serviceId, templateVersion: "2", ports: [serviceId === CALLEE_ID ? 4100 : 4101],
        portsSource: "declared", pid, owner: "human", startedAt: STARTED_AT });
      return { ok: true, pid };
    },
    observation: { probeListening: async (address) => options.listening?.[`port:${address.port}`] ?? "listening" },
    registeredAddress: (serviceId) => ({ host: "127.0.0.1", port: serviceId === CALLEE_ID ? 4100 : 4101 }),
  });
  return result;
}

/** A REAL payload projected with a plan whose units have no dependency edge (no call edge exists to verify). */
async function realNoEdgeRun() {
  const topology = new TaskServiceTopology("task-1", "/tmp/task-1", () => STARTED_AT);
  topology.setPlan({
    units: [
      { unitId: CALLEE_UNIT, serviceId: CALLEE_ID, name: "invoice-api", repoDir: "invoice-service", location: "local", runType: "long-lived" },
      { unitId: CALLER_UNIT, serviceId: CALLER_ID, name: "invoice-web", repoDir: "invoice-service", location: "local", runType: "long-lived" },
    ],
    selectedRepoDirs: ["invoice-service"],
    requests: [{ unitId: CALLEE_UNIT, port: 4100 }, { unitId: CALLER_UNIT, port: 4101 }],
  });
  let pid = 4300;
  return await runServiceGroupStart({
    topology,
    startUnit: async ({ serviceId }) => {
      pid += 1;
      topology.recordRun({ serviceId, templateVersion: "2", ports: [], portsSource: "declared", pid, owner: "human", startedAt: STARTED_AT });
      return { ok: true, pid };
    },
    observation: { probeListening: async () => "listening" },
    registeredAddress: (serviceId) => ({ host: "127.0.0.1", port: serviceId === CALLEE_ID ? 4100 : 4101 }),
  });
}

/** The REAL emit for a plan whose call edge could not be observed at all (the target declares no probeable address). */
async function realNonObservableRun() {
  const topology = plannedTopology();
  let pid = 4400;
  return await runServiceGroupStart({
    topology,
    startUnit: async ({ serviceId }) => {
      pid += 1;
      topology.recordRun({ serviceId, templateVersion: "2", ports: [], portsSource: "declared", pid, owner: "human", startedAt: STARTED_AT });
      return { ok: true, pid };
    },
    observation: { probeListening: async () => "listening" },
    // The caller declares an address (so it is observed listening); the callee
    // declares none, so nothing about the link could be probed.
    registeredAddress: (serviceId) => (serviceId === CALLER_ID ? { host: "127.0.0.1", port: 4101 } : undefined),
  });
}

/** One binding + one template, so the dock loads a real bound service before its group affordance appears. */
function groupBridge(options: { answer: () => unknown }) {
  const taskOp = vi.fn(async (_taskId: string, op: string) => {
    if (op === "task/serviceRunRecords") return { ok: true, payload: { records: [], registered: [] } };
    if (op === "task/serviceStatus") {
      return { ok: true, payload: { service: { serviceId: CALLEE_ID, lifecycle: "stopped", templateVersion: "2", health: "not-probed", launchSource: "catalog", resolved: [] } } };
    }
    return { ok: false, error: `unexpected ${op}` };
  });
  const serviceCatalogOp = vi.fn(async (request: Record<string, unknown>) => {
    if (request["op"] === "runTaskServiceGroup") return options.answer();
    if (request["op"] === "taskBindings") {
      return { ok: true, payload: [{ taskId: "task-1", serviceId: CALLEE_ID, templateVersion: 2, rootId: "invoice-service", subdir: "", privateKeys: [] }] };
    }
    if (request["op"] === "list") {
      return { ok: true, payload: [{ projectId: "project-1", serviceId: CALLEE_ID, version: 2, shared: [],
        descriptor: { name: "invoice-api", program: "node", args: ["server.js"], ports: [4100], runType: "long-lived" } }] };
    }
    return { ok: false, error: `unexpected ${request["op"]}` };
  });
  const projectOp = vi.fn(async () => ({ ok: true, payload: { roots: [], tasks: [{ taskId: "task-1", projectId: "project-1", state: "assigned" }] } }));
  window.pidock = { taskOp, serviceCatalogOp, projectOp } as unknown as typeof window.pidock;
  return { taskOp, serviceCatalogOp, projectOp };
}

/** Clicks the shipped affordance and returns the panel section that owns it. */
async function clickGroupStart() {
  render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
  const control = await screen.findByTestId("dock-group-control");
  fireEvent.click(within(control).getByRole("button", { name: "整组启动" }));
  return control;
}

afterEach(() => {
  cleanup();
  delete (window as { pidock?: unknown }).pidock;
});

describe("[PiDock 05] #10 group start from the shipped 运行 panel", () => {
  it("starts the task's group through the catalog envelope and renders the Host's real observations", async () => {
    const group = await realGroupRun();
    // The REAL projector's payload is accepted by the REAL parser, and every key
    // it emits is in the parser's allowlists.
    expect(Object.keys(group).every((key) => (GROUP_RUN_KEYS as readonly string[]).includes(key))).toBe(true);
    for (const unit of group.units) {
      expect(Object.keys(unit).every((key) => (GROUP_UNIT_KEYS as readonly string[]).includes(key))).toBe(true);
      for (const step of unit.steps) expect(Object.keys(step).every((key) => (GROUP_STEP_KEYS as readonly string[]).includes(key))).toBe(true);
      for (const diagnostic of unit.diagnostics) expect(Object.keys(diagnostic).every((key) => (GROUP_DIAGNOSTIC_KEYS as readonly string[]).includes(key))).toBe(true);
    }
    expect(serviceGroupRunFromHost({ group })).toMatchObject({ state: "verified" });

    const fixture = groupBridge({ answer: () => ({ ok: true, payload: { group } }) });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    // THE assertion that fails when the shipped dock loses the affordance: the
    // 运行 panel owns the control and its own testid.
    const control = await screen.findByTestId("dock-group-control");
    fireEvent.click(within(control).getByRole("button", { name: "整组启动" }));

    // ...and it reaches the Host ONLY through the catalog envelope: the request
    // names the project and the task, never a unit, a port or a program.
    await waitFor(() => expect(fixture.serviceCatalogOp).toHaveBeenCalledWith({ op: "runTaskServiceGroup", projectId: "project-1", taskId: "task-1" }));
    const request = fixture.serviceCatalogOp.mock.calls.find(([entry]) => entry["op"] === "runTaskServiceGroup")?.[0] as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual(["op", "projectId", "taskId"]);
    expect(request["units"]).toBeUndefined();
    expect(fixture.taskOp.mock.calls.map(([, op]) => op)).not.toContain("task/controlService");

    // The Host's real observations, per unit and per step.
    const receipt = await screen.findByTestId("dock-group-run");
    expect(screen.getByTestId("dock-group-state")).toHaveTextContent("整组状态：已互验");
    const callee = receipt.querySelector(`[data-group-unit="${CALLEE_UNIT}"]`) as HTMLElement;
    const caller = receipt.querySelector(`[data-group-unit="${CALLER_UNIT}"]`) as HTMLElement;
    expect(callee).toHaveTextContent("启动：已启动");
    expect(callee).toHaveTextContent("监听：已监听");
    expect(callee).toHaveTextContent("127.0.0.1:4100");
    expect(callee).toHaveTextContent("联通：无依赖边（未做互验）");
    expect(caller).toHaveTextContent("联通：已互验");
    expect(caller).toHaveTextContent("联通检查 invoice-api");
    // A real pid is shown when the Host read one; 已启动 never invents one.
    expect(callee.getAttribute("data-start")).toBe("started");
    expect(caller.getAttribute("data-linkage")).toBe("已互验");
  });

  it("names the plan's missing dependency edge instead of implying a verification", async () => {
    const group = await realNoEdgeRun();
    expect(group.state).toBe("listening");
    groupBridge({ answer: () => ({ ok: true, payload: { group } }) });
    await clickGroupStart();
    const receipt = await screen.findByTestId("dock-group-run");
    // The plan has no call edge, so nothing was verified - and the panel says so
    // by name instead of showing 已互验.
    expect(receipt).toHaveTextContent("无依赖边（未做互验）");
    expect(receipt).not.toHaveTextContent("联通：已互验");
    expect(screen.getByTestId("dock-group-state")).toHaveTextContent("已监听");
  });

  it("never reads a started unit as listening: 未探测 stays 未探测", async () => {
    const group = await realGroupRun({ listening: { "port:4100": "not-probed" } });
    groupBridge({ answer: () => ({ ok: true, payload: { group } }) });
    await clickGroupStart();
    const receipt = await screen.findByTestId("dock-group-run");
    const callee = receipt.querySelector(`[data-group-unit="${CALLEE_UNIT}"]`) as HTMLElement;
    // 已启动 yes; 已监听 no - the launch declared no observable address.
    expect(callee).toHaveTextContent("启动：已启动");
    expect(callee).toHaveTextContent("监听：未探测");
    expect(callee.getAttribute("data-listening")).toBe("not-probed");
    expect(callee).not.toHaveTextContent("监听：已监听");
  });

  it("never leaves a green group when a unit is refused, and names the refusal", async () => {
    const group = await realGroupRun({ start: { [CALLEE_ID]: "refused" } });
    expect(group.state).toBe("refused");
    expect(group.units.find((unit) => unit.serviceId === CALLER_ID)).toMatchObject({ start: "not-started" });
    groupBridge({ answer: () => ({ ok: true, payload: { group } }) });
    await clickGroupStart();
    const state = await screen.findByTestId("dock-group-state");
    expect(state).toHaveTextContent("门禁拒绝");
    expect(state.getAttribute("data-state")).toBe("refused");
    expect(state).not.toHaveTextContent("已互验");
    expect(await screen.findByTestId("dock-group-diagnostics")).toHaveTextContent("门禁拒绝");
    // The unit whose prerequisite never came up is named 未启动, never 已启动.
    const receipt = await screen.findByTestId("dock-group-run");
    expect(receipt.querySelector(`[data-group-unit="${CALLER_UNIT}"]`)).toHaveTextContent("启动：未启动");
  });

  it("refuses a green state declared beside a refused unit instead of rendering it", async () => {
    const group = await realGroupRun({ start: { [CALLEE_ID]: "refused" } });
    // A contradictory payload: the Host's own rules can never produce it, and a
    // parser that accepted it would print a green group over a refused unit.
    const contradictory = { ...group, state: "listening" };
    const fixture = groupBridge({ answer: () => ({ ok: true, payload: { group: contradictory } }) });
    await clickGroupStart();
    expect(await screen.findByTestId("dock-group-refusal")).toHaveTextContent("Host 整组启动回执无法解析（不展示任何状态）");
    expect(screen.queryByTestId("dock-group-run")).not.toBeInTheDocument();
    expect(fixture.serviceCatalogOp.mock.calls.filter(([entry]) => entry["op"] === "runTaskServiceGroup")).toHaveLength(1);
  });

  it("refuses 已互验 declared without a single passed linkage observation", async () => {
    const group = await realNonObservableRun();
    // The real run probed nothing: its own state is 未探测, and no linkage step
    // passed. Claiming 已互验 for it is the exact over-report to refuse.
    expect(group.state).toBe("not-probed");
    expect(group.units.flatMap((unit) => unit.steps).filter((step) => step.outcome === "passed")).toEqual([]);
    groupBridge({ answer: () => ({ ok: true, payload: { group: { ...group, state: "verified" } } }) });
    await clickGroupStart();
    expect(await screen.findByTestId("dock-group-refusal")).toHaveTextContent("无法解析");
    expect(screen.queryByTestId("dock-group-run")).not.toBeInTheDocument();
  });

  it("names the absence of a group result instead of implying a run", async () => {
    groupBridge({ answer: () => ({ ok: true, payload: {} }) });
    await clickGroupStart();
    expect(await screen.findByTestId("dock-group-refusal")).toHaveTextContent("Host 未返回整组启动结果（未执行任何单元）");
    expect(screen.queryByTestId("dock-group-run")).not.toBeInTheDocument();
  });

  it("shows the Host's own refusal verbatim - never fixture data, never a started unit", async () => {
    const fixture = groupBridge({ answer: () => ({ ok: false, error: "missing-port: 本地服务「invoice-api」没有可用端口" }) });
    await clickGroupStart();
    expect(await screen.findByTestId("dock-group-refusal")).toHaveTextContent("missing-port: 本地服务「invoice-api」没有可用端口");
    expect(screen.queryByTestId("dock-group-run")).not.toBeInTheDocument();
    expect(screen.queryByText(/启动：已启动/)).not.toBeInTheDocument();
    await waitFor(() => expect(fixture.serviceCatalogOp.mock.calls.filter(([entry]) => entry["op"] === "runTaskServiceGroup")).toHaveLength(1));
  });

  it("refuses 已监听 for a unit whose observation carries no address", async () => {
    const group = await realNoEdgeRun();
    expect(group.state).toBe("listening");
    // The real payload names the address it connected to; a payload that reports
    // the observation without it is contradictory (nobody could have observed it).
    const withoutAddress = group.units.map(({ address: _address, ...rest }) => rest);
    expect(Object.keys(group.units[0] ?? {})).toContain("address");
    groupBridge({ answer: () => ({ ok: true, payload: { group: { ...group, units: withoutAddress } } }) });
    await clickGroupStart();
    expect(await screen.findByTestId("dock-group-refusal")).toHaveTextContent("无法解析");
    expect(screen.queryByTestId("dock-group-run")).not.toBeInTheDocument();
  });
});
