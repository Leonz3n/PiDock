/**
 * Group start + linkage verification for [PiDock 05] (#10 box 4), on top of the
 * ONE existing gated dispatch.
 *
 * The pure plan (`main/service-topology.ts planStartGroups`) already orders the
 * selected units into groups — prestart steps first, a bidirectional call pair
 * merged so its members listen together, then callees before callers — and
 * names each group's verify steps. Until this module existed, nothing started
 * the group and nothing ran a step: 「先监听再互验」 was rendered text.
 *
 * What this module does NOT own, and must not duplicate:
 * - the permission gate. Every unit start goes through the injected
 *   `startUnit`, which the Host wires to `host/service-control.ts` — the same
 *   `runHumanServiceControl` / `runAgentServiceControl` sequence the single
 *   `task/controlService` path uses. This module never spawns, never signals and
 *   never reads a child handle.
 * - the run record / verification shape. Observations are attached through
 *   `TaskServiceTopology.verifyRun` (→ `attachVerification`), the existing
 *   shape; nothing new is invented for them.
 *
 * Honesty rules implemented here:
 * - 已启动 (`start`) is recorded only after the dispatch resolved `ok`, i.e.
 *   after the driver produced a real child pid (the pid itself is read back from
 *   the run record the driver wrote; absent means "started, identity not read",
 *   never an invented number).
 * - 已监听 (`listening`) comes only from a real successful connect to the
 *   address the unit's REGISTRATION declares — never from the plan's port, never
 *   from "the process started". The fact it records is "the registration's
 *   declared address accepted a connection"; it does not prove the listener IS
 *   this unit's own child (a foreign process on the same declared port would
 *   also answer). That boundary is named, not hidden — box 5's 端口被外部占用 is
 *   its own diagnostic.
 * - 已互验 (`linked`) comes only from a real successful connect to the
 *   dependency's registered address during a `linkage` step.
 * - 未探测 is a named state (`not-probed`), not a missing field, whenever no
 *   observation was possible (no declared address, a remote target, a
 *   prepare/one-shot step whose completion nobody observed).
 * - 启动失败 / 核验失败 / 依赖不可达 are distinct: a driver error is
 *   `start-failed`, a readiness step that failed is `verify-failed`, a linkage
 *   step whose connection did not reach the dependency is
 *   `dependency-unreachable`.
 * - Once a unit is refused, parked on approval or fails to start, no further
 *   unit is started: a unit whose prerequisite never came up must not be started
 *   into a green group. The rest are reported `not-started` by name.
 */

import {
  diagnostic,
  groupVerifySteps,
  planRestartScope,
  type GroupVerifyPlanStep,
  type PortAssignment,
  type RunDiagnostic,
  type RunUnit,
  type ServiceDependency,
  type StartGroup,
} from "../main/service-topology.js";
import {
  diagnoseDependencyUnreachable,
  diagnoseStartFailure,
  type ProcessIdentity,
  type RunRecord,
  type RunVerification,
} from "../main/service-runs.js";
import type { ListeningAddress, ServiceObservationPort } from "./service-linkage.js";

/** How far one unit's start got; every value is a fact, not a plan. */
export type GroupUnitStartState = "started" | "start-failed" | "refused" | "approval-required" | "not-started";

/** How far one unit's listening observation got. `not-probed` is a named state. */
export type GroupUnitListeningState = "listening" | "not-listening" | "not-probed";

export interface GroupVerifyStepOutcome {
  label: string;
  kind: GroupVerifyPlanStep["kind"];
  targetUnitId: string;
  targetServiceId: string;
  outcome: "passed" | "dependency-unreachable" | "verify-failed" | "not-probed";
  detail: string;
  address?: ListeningAddress;
}

export interface GroupUnitOutcome {
  unitId: string;
  serviceId: string;
  /** 1-based real start position, only for a unit that really started. */
  order?: number;
  start: GroupUnitStartState;
  /** Real pid read back from the run record the driver wrote; absent when none was read. */
  pid?: number;
  /** True only when the run record this observation belongs to was found and updated. */
  observedRun: boolean;
  listening: GroupUnitListeningState;
  address?: ListeningAddress;
  /** True when every linkage step of this unit really reached its dependency. */
  linked: boolean;
  steps: GroupVerifyStepOutcome[];
  diagnostics: RunDiagnostic[];
}

/**
 * Named terminal state of one group run. The negative states are distinct on
 * purpose: 启动失败 (a driver refused/errored), 依赖不可达 (a real connection to
 * the dependency did not reach it), 核验失败 (a readiness step that failed),
 * 未监听 (the unit started but nothing accepted a connection on its address) and
 * 未探测 (nothing could be observed) must never collapse into one another, and
 * none of them may read as 已互验.
 */
export type ServiceGroupState =
  | "verified"
  | "listening"
  | "not-probed"
  | "not-listening"
  | "dependency-unreachable"
  | "verify-failed"
  | "start-failed"
  | "refused"
  | "approval-required"
  | "not-planned";

export interface ServiceGroupRunResult {
  state: ServiceGroupState;
  /** Group ids in the order they were processed. */
  groups: string[];
  units: GroupUnitOutcome[];
  /**
   * Units the plan's own reallocation rule says must be restarted / re-pointed
   * (`planRestartScope`), computed from the identities registered after this run.
   * They are NAMED as work still to do: this run did not restart or re-point
   * anything, and none of these rows claims it did.
   */
  restartScope: { unitId: string; reason: "port-reallocated" | "binding-changed" | "template-version" }[];
  /** The plan's port reallocations, so a consumer update can be located. */
  reallocated: { unitId: string; before: number; after: number }[];
  diagnostics: RunDiagnostic[];
}

/** The Host topology slice this runner reads and writes; `TaskServiceTopology` satisfies it. */
export interface ServiceGroupPlanPort {
  plan(): {
    groups: StartGroup[];
    units: RunUnit[];
    assignments: PortAssignment[];
    reallocated: { unitId: string; before: number; after: number }[];
  };
  /** The declared call/prestart edges the plan's verify steps are derived from. */
  plannedDependencies(): ServiceDependency[];
  runs(): RunRecord[];
  registeredIdentities(): ProcessIdentity[];
  verifyRun(runId: string, input: { kind: RunVerification["kind"]; detail: string; ok: boolean }): RunRecord;
}

/**
 * Outcome of one unit's dispatch. `kind` is decided by the caller that owns the
 * gate knowledge (it alone knows whether the driver was reached and whether the
 * tier parked on an approval), so this runner never guesses a state from an
 * error string.
 */
export type GroupUnitStartResult =
  | { ok: true; pid?: number }
  | { ok: false; kind: "refused" | "approval-required" | "start-failed"; error: string };

export interface ServiceGroupRunInput {
  topology: ServiceGroupPlanPort;
  /**
   * The ONE gated dispatch for one unit; the only way this runner starts a
   * unit. Called in plan order and never in parallel.
   */
  startUnit(unit: { unitId: string; serviceId: string }): Promise<GroupUnitStartResult>;
  observation: ServiceObservationPort;
  /**
   * The address the unit's REGISTRATION declares — what the launch is set up to
   * bind — never the plan's port. Absent means the unit declares no socket, so
   * its listening state is honestly `not-probed`.
   */
  registeredAddress(serviceId: string): ListeningAddress | undefined;
  /**
   * Bounded budget for the listening observation of a unit that was just
   * started. It must cover the spawn → bind latency of a real child.
   */
  listeningBudgetMs?: number;
  /**
   * Bounded budget for a linkage/readiness connect. Shorter on purpose: by the
   * time a group's steps run, its members have already had their listening
   * phase, so a target that listens answers at once and one that does not must
   * not stretch the whole run.
   */
  linkageBudgetMs?: number;
}

const DEFAULT_LISTENING_BUDGET_MS = 3000;
const DEFAULT_LINKAGE_BUDGET_MS = 1200;

function latestOpenRun(topology: ServiceGroupPlanPort, serviceId: string, pid?: number): RunRecord | undefined {
  const open = [...topology.runs()].reverse().find((record) => record.serviceId === serviceId && record.endedAt === undefined);
  if (pid === undefined) return open;
  // The pid the dispatch just produced is the only run this start may be
  // credited to: an older open record for the same service must not supply it.
  return open?.processIdentity.pid === pid ? open : undefined;
}

function describeAddress(address: ListeningAddress): string {
  return `${address.host}:${address.port}`;
}

/** Group ids in processed order plus a `not-started` row for a unit we never reached. */
function notStartedOutcome(unit: RunUnit): GroupUnitOutcome {
  return {
    unitId: unit.unitId,
    serviceId: unit.serviceId,
    start: "not-started",
    observedRun: false,
    listening: "not-probed",
    linked: false,
    steps: [],
    diagnostics: [],
  };
}

/**
 * Process the current plan's groups in order: start every member of a group
 * through the gated dispatch, observe listening from a real connect, then run
 * the group's verify steps for real — attaching each observation to the unit's
 * own run record through the existing verification shape.
 */
export async function runServiceGroupStart(input: ServiceGroupRunInput): Promise<ServiceGroupRunResult> {
  const plan = input.topology.plan();
  const dependencies = input.topology.plannedDependencies();
  const unitsById = new Map(plan.units.map((unit) => [unit.unitId, unit]));
  const remoteIds = new Set(plan.units.filter((unit) => unit.location === "remote").map((unit) => unit.unitId));
  const listeningBudget = input.listeningBudgetMs ?? DEFAULT_LISTENING_BUDGET_MS;
  const linkageBudget = input.linkageBudgetMs ?? DEFAULT_LINKAGE_BUDGET_MS;
  const outcomes = new Map<string, GroupUnitOutcome>();
  const diagnostics: RunDiagnostic[] = [];
  for (const unit of plan.units) outcomes.set(unit.unitId, notStartedOutcome(unit));

  if (plan.groups.length === 0) {
    diagnostics.push(
      diagnostic("empty-selection", {}, "没有可启动的运行单元分组：请先选择运行单元并生成启动顺序", "在运行面板选择服务后重试"),
    );
    return {
      state: "not-planned",
      groups: [],
      units: [...outcomes.values()],
      restartScope: [],
      reallocated: [...plan.reallocated],
      diagnostics,
    };
  }

  /** A unit whose prerequisite never came up must not be started into a green group. */
  let blocked: { unitId: string; state: "refused" | "approval-required" | "start-failed" } | undefined;
  let startedIndex = 0;

  const observe = async (unit: RunUnit, run: RunRecord | undefined): Promise<GroupUnitOutcome> => {
    const outcome = outcomes.get(unit.unitId) as GroupUnitOutcome;
    const address = input.registeredAddress(unit.serviceId);
    if (address === undefined) {
      outcome.listening = "not-probed";
      return outcome;
    }
    outcome.address = address;
    const observed = await input.observation.probeListening(address, listeningBudget);
    outcome.listening = observed;
    if (run !== undefined) {
      // The listening fact rides the EXISTING verification shape; `ok` is the
      // probe's own result, never the process liveness.
      const detail = observed === "listening"
        ? `已监听 ${describeAddress(address)}（真实连接成功）`
        : `未监听 ${describeAddress(address)}（真实连接未成功）`;
      input.topology.verifyRun(run.runId, { kind: "readiness", detail, ok: observed === "listening" });
    }
    return outcome;
  };

  for (const group of plan.groups) {
    const groupSteps = stepsForGroup(group, dependencies, plan.units, remoteIds, unitsById);
    const startedRuns = new Map<string, RunRecord | undefined>();
    for (const unitId of group.members) {
      const unit = unitsById.get(unitId);
      if (unit === undefined) continue;
      const outcome = outcomes.get(unitId) as GroupUnitOutcome;
      if (blocked !== undefined) continue;
      const started = await input.startUnit({ unitId, serviceId: unit.serviceId });
      if (started.ok) {
        startedIndex += 1;
        outcome.start = "started";
        outcome.order = startedIndex;
        const run = latestOpenRun(input.topology, unit.serviceId, started.pid);
        startedRuns.set(unitId, run);
        outcome.observedRun = run !== undefined;
        outcome.pid = run?.processIdentity.pid;
        continue;
      }
      outcome.start = started.kind;
      blocked = { unitId, state: started.kind };
      if (started.kind === "start-failed") {
        // The registration's own declared port makes a real EADDRINUSE
        // locatable (`端口 <declared> 已被占用`) instead of a bare `端口 ?`.
        const declared = input.registeredAddress(unit.serviceId);
        const failure = diagnoseStartFailure({
          unitId,
          serviceId: unit.serviceId,
          error: started.error,
          ...(declared !== undefined ? { port: declared.port } : {}),
        });
        outcome.diagnostics.push(failure);
        diagnostics.push(failure);
      } else {
        const approval = started.kind === "approval-required";
        // A gate refusal and a parked approval are NOT start failures: each
        // keeps its own diagnostic code so a consumer can tell them apart.
        const refusal = diagnostic(
          approval ? "approval-required" : "control-refused",
          { unitId },
          `运行单元「${unit.name}」未启动：${started.error}`,
          approval ? "请先确认该服务的启动请求后再重试整组启动" : "请调整会话权限或运行单元选择后重试",
        );
        outcome.diagnostics.push(refusal);
        diagnostics.push(refusal);
      }
    }
    // 先监听: observe every unit of this group that really started, in
    // parallel (each observation is independent and bounded). A group that was
    // cut short still observes what did start, so its state is never invented.
    await Promise.all(group.members.flatMap((unitId) => {
      const unit = unitsById.get(unitId);
      const outcome = outcomes.get(unitId);
      if (unit === undefined || outcome === undefined || outcome.start !== "started") return [];
      return [observe(unit, startedRuns.get(unitId))];
    }));
    // 再互验: run the group's verify steps for real, now that its members had
    // their chance to listen. Steps are independent observations, so they run
    // together; the phase order (listen, then verify) is what matters.
    await Promise.all(groupSteps.flatMap(async (step) => {
      const consumer = unitsById.get(step.dependency.from);
      if (consumer === undefined) return;
      const target = unitsById.get(step.dependency.to);
      if (target === undefined) return;
      const consumerOutcome = outcomes.get(consumer.unitId) as GroupUnitOutcome;
      const targetOutcome = outcomes.get(target.unitId) as GroupUnitOutcome;
      // A step only exists for a unit that really started: verifying a link for
      // a consumer that never came up would invent an observation.
      if (consumerOutcome.start !== "started") return;
      const resolved = await runVerifyStep(input, step, target, targetOutcome, linkageBudget);
      consumerOutcome.steps.push(resolved);
      if (resolved.outcome !== "passed" && resolved.outcome !== "not-probed") {
        diagnostics.push(
          resolved.outcome === "dependency-unreachable"
            ? diagnoseDependencyUnreachable({ unitId: consumer.unitId, key: step.dependency.to, target: target.name, detail: resolved.detail })
            : diagnostic("verify-failed", { unitId: consumer.unitId }, `运行单元「${consumer.name}」的${step.kind === "readiness" ? "前置条件" : "依赖"}核验失败：${resolved.detail}`, "请检查依赖单元的真实监听状态后重试"),
        );
      }
      // Only a real observation is attached through the existing verification
      // shape: `not-probed` is a named state on this payload, NOT a failed
      // verification, and must not read as one in the run record. A prestart
      // group's own 「准备步骤完成检查」 was ALREADY attached as the listening
      // observation (`selfObserved`), so it is never recorded twice.
      const run = resolved.outcome === "not-probed" || step.selfObserved === true ? undefined : startedRuns.get(consumer.unitId);
      if (run !== undefined) {
        input.topology.verifyRun(run.runId, {
          kind: step.kind,
          detail: `${step.label}: ${resolved.detail}`,
          ok: resolved.outcome === "passed",
        });
      }
    }));
    for (const unitId of group.members) {
      const outcome = outcomes.get(unitId) as GroupUnitOutcome;
      const linkage = outcome.steps.filter((step) => step.kind === "linkage");
      outcome.linked = linkage.length > 0 && linkage.every((step) => step.outcome === "passed");
    }
  }

  const registered = new Set(input.topology.registeredIdentities().map((identity) => identity.serviceId));
  const runningUnitIds = plan.units.filter((unit) => registered.has(unit.serviceId)).map((unit) => unit.unitId);
  const restartScope = planRestartScope({ running: runningUnitIds, reallocated: plan.reallocated });

  return {
    state: resolveGroupState(plan.groups, [...outcomes.values()]),
    groups: plan.groups.map((group) => group.groupId),
    units: [...outcomes.values()],
    restartScope,
    reallocated: [...plan.reallocated],
    diagnostics,
  };
}

/**
 * The plan's verify steps for one group, with the target kept. The prestart
 * group's 「准备步骤完成检查」 steps are not dependency-backed, so they are
 * synthesised here from the group's own members.
 */
function stepsForGroup(
  group: StartGroup,
  dependencies: readonly ServiceDependency[],
  units: readonly RunUnit[],
  remoteIds: ReadonlySet<string>,
  unitsById: ReadonlyMap<string, RunUnit>,
): GroupVerifyPlanStep[] {
  if (group.reason !== "prestart") return groupVerifySteps({ members: group.members, dependencies, units, remoteIds });
  return group.members.map((unitId) => ({
    dependency: { from: unitId, to: unitId, kind: "prestart" as const },
    kind: "readiness" as const,
    label: `准备步骤完成检查 ${unitsById.get(unitId)?.name ?? unitId}`,
    // The check is the unit's own address, already observed in the listening
    // phase; it is not probed a second time and not recorded twice.
    selfObserved: true,
  }));
}

async function runVerifyStep(
  input: ServiceGroupRunInput,
  step: GroupVerifyPlanStep,
  target: RunUnit,
  targetOutcome: GroupUnitOutcome,
  budget: number,
): Promise<GroupVerifyStepOutcome> {
  const base = { label: step.label, kind: step.kind, targetUnitId: target.unitId, targetServiceId: target.serviceId };
  if (step.kind === "remote-reachability") {
    return { ...base, outcome: "not-probed", detail: "远程依赖未探测（本切片不发起远程请求）" };
  }
  // A dependency that never started was never probed: reporting it as
  // unreachable would claim an observation nobody made.
  if (targetOutcome.start !== "started") {
    return { ...base, outcome: "not-probed", detail: `依赖「${target.name}」未启动，未探测` };
  }
  // A prestart group's 「准备步骤完成检查」 is the unit's OWN address, already
  // observed in the listening phase. Reuse that one observation (a second probe
  // at a different budget could disagree with it) and record it exactly once.
  if (step.selfObserved === true) {
    const own = targetOutcome.address;
    if (own === undefined) {
      return { ...base, outcome: "not-probed", detail: `准备步骤「${target.name}」未声明可探测地址，未探测` };
    }
    if (targetOutcome.listening === "listening") {
      return { ...base, address: own, outcome: "passed", detail: `${describeAddress(own)} 已就绪（真实连接成功）` };
    }
    if (targetOutcome.listening === "not-listening") {
      return { ...base, address: own, outcome: "verify-failed", detail: `${describeAddress(own)} 未就绪（真实连接未成功）` };
    }
    return { ...base, outcome: "not-probed", detail: `准备步骤「${target.name}」未探测` };
  }
  const address = input.registeredAddress(target.serviceId);
  if (address === undefined) {
    return { ...base, outcome: "not-probed", detail: `依赖「${target.name}」未声明可探测地址` };
  }
  const observed = await input.observation.probeListening(address, budget);
  if (observed === "listening") {
    return {
      ...base,
      address,
      outcome: "passed",
      detail: step.kind === "linkage"
        ? `已互验：真实连接到达 ${describeAddress(address)}`
        : `${describeAddress(address)} 已就绪（真实连接成功）`,
    };
  }
  if (step.kind === "linkage") {
    return {
      ...base,
      address,
      outcome: "dependency-unreachable",
      detail: `连接 ${describeAddress(address)} 未到达依赖（运行单元 ${targetOutcome.unitId} 状态：${targetOutcome.listening}）`,
    };
  }
  return { ...base, address, outcome: "verify-failed", detail: `${describeAddress(address)} 未就绪（真实连接未成功）` };
}

/**
 * 已互验 wins only when every linkage observation really passed; otherwise the
 * worst named negative state wins, so a refusal or a failure can never be
 * smoothed into a green group.
 */
function resolveGroupState(groups: readonly StartGroup[], units: readonly GroupUnitOutcome[]): ServiceGroupState {
  if (groups.length === 0) return "not-planned";
  const states = units.map((unit) => unit.start);
  if (states.includes("refused")) return "refused";
  if (states.includes("approval-required")) return "approval-required";
  if (states.includes("start-failed")) return "start-failed";
  const steps = units.flatMap((unit) => unit.steps);
  if (steps.some((step) => step.outcome === "dependency-unreachable")) return "dependency-unreachable";
  if (steps.some((step) => step.outcome === "verify-failed")) return "verify-failed";
  if (units.some((unit) => unit.listening === "not-listening")) return "not-listening";
  if (units.some((unit) => unit.start === "started" && unit.listening === "not-probed")) return "not-probed";
  if (steps.some((step) => step.outcome === "not-probed")) return "not-probed";
  // `verified` requires a real successful linkage observation. A group that was
  // merely observed listening (or that has no linkage step at all) stays
  // `listening`: nothing has been mutually verified.
  if (steps.some((step) => step.kind === "linkage")) return "verified";
  return "listening";
}
