/**
 * Host-side agent service-control sequence for [PiDock 04] (#7).
 *
 * `host.ts` keeps the transport concerns (utilityProcess parent port,
 * envelope validation, caller classification) and calls this function for
 * the agent branch, so the order that makes the gate correct is testable
 * without a utilityProcess: resolve the session's live permission → find
 * the live approval → decide → mint (only for a registered service, only
 * when the tier asks) → spend one-shot → persist → act.
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

/** Input of one agent service control ([PiDock 04] #7). */
export interface AgentServiceControlInput {
  services: TaskServiceRuntime;
  channel: AgentControlChannel;
  sessionId: string;
  serviceId: string;
  action: "start" | "stop";
  approvalId?: unknown;
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
 * confirmation is bound here.
 */
export function runAgentServiceControl(input: AgentServiceControlInput): AgentServiceControlResult {
  const record = input.executions?.record({
    sessionId: input.sessionId,
    kind: "service-control",
    label: `服务${input.action === "start" ? "启动" : "停止"} ${input.serviceId}`,
    step: `服务${input.action === "start" ? "启动" : "停止"}`,
    approvalId: input.approvalId,
  });
  const result = performAgentServiceControl(input, record);
  record?.settle(result.ok ? { ok: true } : { ok: false, reason: result.error });
  return result;
}

function performAgentServiceControl(
  input: AgentServiceControlInput,
  record: ControlExecutionHandle | undefined,
): AgentServiceControlResult {
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
    if (input.action === "start") {
      input.services.markStarted(input.serviceId, { kind: "agent", sessionId: input.sessionId, permissionAtRequest: tier });
    } else {
      input.services.markStopped(input.serviceId, { kind: "agent", sessionId: input.sessionId, permissionAtRequest: tier }, "agent-request");
    }
    return { ok: true, payload: { serviceId: input.serviceId, action: input.action, actor: "agent", tier } };
  } finally {
    input.write.releaseWrite(claim.claimId);
  }
}
