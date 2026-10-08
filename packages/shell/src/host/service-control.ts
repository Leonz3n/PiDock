/**
 * Host-side agent service-control sequence for [PiDock 04] (#7).
 *
 * `host.ts` keeps the transport concerns (utilityProcess parent port,
 * envelope validation, caller classification) and calls these sequences for
 * the agent and human branches, so the order that makes the gate correct is
 * testable without a utilityProcess: resolve the session's live permission →
 * find the live approval → decide → mint (only for a registered service, only
 * when the tier asks) → spend one-shot → persist → execute through the Host's
 * registered process identity → record the lifecycle that really exists.
 *
 * Execution rule ([PiDock 04] #7): the driver call happens after the gate has
 * settled and after the one-shot approval was spent, and it happens *only*
 * there. A read-tier denial, a missing/rejected approval, a cancel or any
 * other refusal returns before `ServiceExecutionDriver` is reached, so a
 * refusal starts and stops nothing.
 *
 * [PiDock 09] (#11) adds the task write right: even the `auto` tier is
 * constrained by it (盒子 3), so a start/stop claims the right before minting
 * or acting and releases it when the one-shot operation ends. A session that
 * already owns the right (an in-flight turn) claims again instead of
 * deadlocking against itself.
 *
 * Never trust caller claims: the tier is read from the channel, the
 * approval comes from the channel's live snapshot, and the spend goes
 * through `consumeApproval` (the same channel that persist-writes the
 * snapshot back). The `default` tier mints with `SERVICE_CONTROL_SCOPE`,
 * the only scope `verifyServiceControlApproval` accepts.
 */

import type { PiApproval, PiApprovalScope, PiGateDecision, PiPermission } from "../main/pi-session.js";
import { SERVICE_CONTROL_SCOPE } from "../main/pi-session.js";
import { writeClaimError, type WriteCoordinatorPort } from "./write-coordination.js";
import type { ControlExecutionHandle, ControlExecutionPort } from "./execution-ledger.js";
import type { TaskServiceRuntime } from "./service-runtime.js";

/**
 * The slice of `PiSessionChannel` this sequence uses. Structural, so the
 * real channel satisfies it and tests can drive either the channel or a
 * recording stub.
 */
export interface AgentControlChannel {
  readonly currentPermission: PiPermission;
  previewGate(toolName: string, target: string): PiGateDecision;
  gate(toolName: string, target: string, contentVersion: string, currentCallId?: string, scope?: PiApprovalScope): PiGateDecision;
  snapshot(): { approvals: PiApproval[] };
  consumeApproval(approvalId: string): boolean;
}

/** Read the admission seal while keeping each control's existing permission policy. */
export function channelExecutionClosing(channel: Pick<AgentControlChannel, "previewGate">, tool: string, target: string): boolean {
  const gate = channel.previewGate(tool, target);
  return gate.verdict === "deny" && gate.reason === "task-host-closing";
}

export type AgentServiceControlResult =
  | { ok: true; payload: { serviceId: string; action: "start" | "stop"; actor: "agent"; tier: PiPermission } }
  | { ok: false; error: string };

export type ServiceControlResult =
  | { ok: true; payload: { serviceId: string; action: "start" | "stop"; actor: "agent"; tier: PiPermission } }
  | { ok: true; payload: { serviceId: string; action: "start" | "stop"; actor: "human"; label: string } }
  | { ok: false; error: string };

/**
 * Real Host-side execution of one service control ([PiDock 04] #7). The
 * driver is the Host's own `TaskServiceProcesses` (registered process
 * identity only); `start` must resolve only after a real child exists and
 * `stop` only after the registered child was really stopped. Without it
 * every control stays fail-closed. A gate refusal, a missing approval or a
 * cancel never calls the driver, so no process is started or stopped.
 */
export interface ServiceExecutionDriver {
  start(serviceId: string): Promise<{ pid: number }>;
  stop(serviceId: string): Promise<void>;
}

/** Input of one agent service control ([PiDock 04] #7). */
export interface AgentServiceControlInput {
  services: TaskServiceRuntime;
  channel: AgentControlChannel;
  sessionId: string;
  serviceId: string;
  action: "start" | "stop";
  approvalId?: unknown;
  /** Real Host process driver; absent keeps every control fail-closed. */
  driver?: ServiceExecutionDriver;
  /** Task write right ([PiDock 09] #11): claimed around the one-shot operation. */
  write: WriteCoordinatorPort;
  /** Persists the channel snapshot after minting or spending (Host writes the session file). */
  persist: () => void;
  /**
   * [PiDock 14] (#17) the task's execution ledger. Every agent control records
   * one `service-control` execution carrying the gate's own outcome.
   */
  executions?: ControlExecutionPort;
}

/**
 * Agent service control through the task's session gate. The execution record
 * wraps the whole sequence, so every exit settles it; only the minted
 * confirmation is bound here. The real start/stop happens inside the same
 * sequence, after the gate and after the one-shot approval was spent.
 */
export async function runAgentServiceControl(input: AgentServiceControlInput): Promise<AgentServiceControlResult> {
  const record = input.executions?.record({
    sessionId: input.sessionId,
    kind: "service-control",
    label: `服务${input.action === "start" ? "启动" : "停止"} ${input.serviceId}`,
    step: `服务${input.action === "start" ? "启动" : "停止"}`,
    approvalId: input.approvalId,
  });
  const result = await performAgentServiceControl(input, record);
  record?.settle(result.ok ? { ok: true } : { ok: false, reason: result.error });
  return result;
}

/**
 * Human-explicit service control from the trusted shell view. It carries no
 * session and takes no tier gate — it *is* the UI path, reached only through
 * main's sender-bound attestation (`classifyControlCaller`) — and it is
 * labelled `human` so the event trail separates it from Agent control. The
 * real start/stop still goes through the Host's registered process identity.
 */
export async function runHumanServiceControl(input: {
  services: TaskServiceRuntime;
  driver?: ServiceExecutionDriver;
  serviceId: string;
  action: "start" | "stop";
  label: string;
}): Promise<ServiceControlResult> {
  if (input.services.get(input.serviceId) === undefined) {
    return { ok: false, error: `unknown-service: ${input.serviceId} is not registered on this task` };
  }
  const actor = { kind: "human" as const, label: input.label };
  const acted = await runServiceAction(input.services, input.driver, input.serviceId, input.action, actor);
  return acted.ok ? { ok: true, payload: { serviceId: input.serviceId, action: input.action, actor: "human", label: input.label } }
    : { ok: false, error: acted.error };
}

/**
 * The one place a service start/stop is dispatched: resolve the real driver,
 * act, and only then record the lifecycle the process really has. Every
 * refusal and every driver failure returns before any state change, so a
 * failed spawn never looks like a running service and a failed stop never
 * looks stopped.
 */
async function runServiceAction(
  services: TaskServiceRuntime,
  driver: ServiceExecutionDriver | undefined,
  serviceId: string,
  action: "start" | "stop",
  actor: Parameters<TaskServiceRuntime["markStarted"]>[1],
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!driver) return { ok: false, error: "service-execution-unavailable: 真实服务进程执行器未接线" };
  if (action === "start") {
    let pid: number;
    try {
      pid = (await driver.start(serviceId)).pid;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    services.markStarted(serviceId, actor, `process alive (pid ${pid}); dependencies not probed`);
    return { ok: true };
  }
  try {
    await driver.stop(serviceId);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  services.markStopped(serviceId, actor, actor.kind === "human" ? "human-request" : "agent-request");
  return { ok: true };
}

async function performAgentServiceControl(
  input: AgentServiceControlInput,
  record: ControlExecutionHandle | undefined,
): Promise<AgentServiceControlResult> {
  const tier = input.channel.currentPermission;
  const approvalId = input.approvalId;
  const liveApproval =
    typeof approvalId === "string" && approvalId.length > 0
      ? input.channel.snapshot().approvals.find((item) => item.id === approvalId)
      : undefined;
  const target = `${input.services.taskDir}/services/${input.serviceId}`;
  if (channelExecutionClosing(input.channel, "exec.run", target)) return { ok: false, error: "task-host-closing" };
  const intent = { kind: "service-control" as const, label: `服务${input.action === "start" ? "启动" : "停止"} ${input.serviceId}` };
  const decision = input.services.decideAgentControl({
    serviceId: input.serviceId,
    action: input.action,
    tier,
    approval: liveApproval,
  });
  if (!decision.ok) {
    // `default` without any live approval needs one: mint it through the
    // channel gate so it carries tool/target/permissionAtRequest/scope.
    // Only registered services are minted — an unknown id would ask the
    // user to confirm a start that can never run. The write right is checked
    // first so a queued session does not spend the user's attention on a
    // confirmation it cannot use.
    if (tier === "default" && liveApproval === undefined && input.services.get(input.serviceId) !== undefined) {
      const claim = input.write.claimWrite(input.sessionId, tier, intent);
      if (!claim.ok) return { ok: false, error: writeClaimError(claim) };
      try {
        const preview = input.channel.previewGate("exec.run", target);
        if (preview.verdict === "ask") {
          const contentVersion = input.services.get(input.serviceId)?.templateVersion ?? "v1";
          const gate = input.channel.gate("exec.run", target, contentVersion, undefined, SERVICE_CONTROL_SCOPE);
          if (gate.verdict === "ask") {
            record?.awaitApproval({ approvalId: gate.approvalId, payloadVersion: contentVersion, scope: SERVICE_CONTROL_SCOPE });
            input.persist();
            return { ok: false, error: `approval-required: ${gate.approvalId}` };
          }
        }
      } finally {
        input.write.releaseWrite(claim.claimId);
      }
    }
    return { ok: false, error: decision.reason };
  }
  const claim = input.write.claimWrite(input.sessionId, tier, intent);
  if (!claim.ok) return { ok: false, error: writeClaimError(claim) };
  try {
    if (channelExecutionClosing(input.channel, "exec.run", target)) return { ok: false, error: "task-host-closing" };
    // One-shot spend: the verified approval authorizes exactly this
    // start/stop. Spending (and persisting) before acting means a replay
    // fails closed even if the same id is sent again.
    if (liveApproval !== undefined) {
      if (!input.channel.consumeApproval(liveApproval.id)) {
        return { ok: false, error: "approval-required: 确认请求已被消费，请重新确认" };
      }
      input.persist();
    }
    if (channelExecutionClosing(input.channel, "exec.run", target)) return { ok: false, error: "task-host-closing" };
    // The gate is settled and the one-shot approval (when there was one) is
    // spent: now - and only now - a real process may start or stop. A driver
    // failure keeps the previous lifecycle and returns the real error.
    const acted = await runServiceAction(input.services, input.driver, input.serviceId, input.action,
      { kind: "agent", sessionId: input.sessionId, permissionAtRequest: tier });
    return acted.ok ? { ok: true, payload: { serviceId: input.serviceId, action: input.action, actor: "agent", tier } }
      : { ok: false, error: acted.error };
  } finally {
    input.write.releaseWrite(claim.claimId);
  }
}
