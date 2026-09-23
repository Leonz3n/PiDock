/**
 * Host-side agent terminal-control sequence for [PiDock 10] (#15).
 *
 * Mirrors the #7 service-control order (`host/service-control.ts`) so the
 * permission seam stays one rule: resolve the session's live tier → decide →
 * mint only when the tier asks → spend one-shot → persist → act. `host.ts`
 * keeps transport and caller classification.
 *
 * [PiDock 09] (#11) write coordination applies too: starting or stopping a
 * terminal is side-effecting, so it claims the task write right around the
 * one-shot operation, and a `read` tier is refused before anything is claimed.
 *
 * Never trust caller claims: the tier is read from the channel, the approval
 * comes from the channel's live snapshot, and the spend goes through
 * `consumeApproval` (the same channel that persist-writes the snapshot back).
 * `default` mints with `TERMINAL_CONTROL_SCOPE`, the only scope
 * `verifyTerminalControlApproval` accepts, so a turn approval for the same
 * `exec.run` target can never be spent on a Host-driven terminal.
 */

import type { PiApproval, PiApprovalScope, PiGateDecision, PiPermission } from "../main/pi-session.js";
import { TERMINAL_CONTROL_SCOPE } from "../main/pi-session.js";
import { writeClaimError, type WriteCoordinatorPort } from "./write-coordination.js";
import type { TaskTerminalRegistry, TerminalInstanceRecord } from "../main/terminal-config.js";

/**
 * The slice of `PiSessionChannel` this sequence uses. Structural, so the real
 * channel satisfies it and tests can drive either the channel or a stub.
 */
export interface TerminalControlChannel {
  readonly currentPermission: PiPermission;
  previewGate(toolName: string, target: string): PiGateDecision;
  gate(toolName: string, target: string, contentVersion: string, currentCallId?: string, scope?: PiApprovalScope): PiGateDecision;
  snapshot(): { approvals: PiApproval[] };
  consumeApproval(approvalId: string): boolean;
}

/** The tool name a Host-driven terminal start is gated as. */
export const TERMINAL_CONTROL_TOOL = "exec.run";

/** Identity-bound approval target: this task's terminal instance, never a port. */
export function terminalApprovalTarget(taskDir: string, instanceId: string): string {
  return `${taskDir.replace(/[\\/]+$/, "")}/terminals/${instanceId}`;
}

interface TerminalApprovalLike {
  status: string;
  tool: string;
  target: string;
  permissionAtRequest: string;
  scope?: PiApprovalScope;
  consumedAt?: string;
}

/**
 * Server-side verification of a terminal approval against the live session
 * record: it must exist, be `approved`, unspent, requested under `default`,
 * carry the `terminal-control` scope, and name exactly this tool and this
 * task-scoped instance. A turn approval for the same tool + target carries no
 * scope and is refused.
 */
export function verifyTerminalControlApproval(input: {
  approval: TerminalApprovalLike | undefined;
  taskDir: string;
  instanceId: string;
}): { ok: true } | { ok: false; reason: string } {
  const approval = input.approval;
  if (!approval) return { ok: false, reason: "终端操作需先确认（批准后重试；拒绝/取消不启动终端）" };
  if (approval.status !== "approved" || approval.consumedAt !== undefined) {
    return { ok: false, reason: "确认请求已处理或未批准，不可重放" };
  }
  if (approval.permissionAtRequest !== "default") {
    return { ok: false, reason: "终端操作需先确认（批准后重试；拒绝/取消不启动终端）" };
  }
  if (approval.scope !== TERMINAL_CONTROL_SCOPE) {
    return { ok: false, reason: "确认请求与终端操作不匹配（用途未绑定）" };
  }
  if (approval.tool !== TERMINAL_CONTROL_TOOL) {
    return { ok: false, reason: "确认请求与终端操作不匹配（动作未绑定）" };
  }
  if (approval.target !== terminalApprovalTarget(input.taskDir, input.instanceId)) {
    return { ok: false, reason: "确认请求与终端操作不匹配（终端未绑定）" };
  }
  return { ok: true };
}

/**
 * Tier mapping shared by the sequence and its tests: `read` denies terminal
 * control entirely (the Agent may not open a command surface), `default`
 * needs a live verified approval, `auto` allows without asking — never
 * bypassing task ownership or the write right.
 */
export function decideAgentTerminalControl(input: {
  tier: PiPermission;
  approval: TerminalApprovalLike | undefined;
  taskDir: string;
  instanceId: string;
}): { ok: true } | { ok: false; reason: string } {
  if (input.tier === "read") {
    return { ok: false, reason: "read 权限不提供终端与命令执行入口；请在会话中提升权限或改用人工操作" };
  }
  if (input.tier === "auto") return { ok: true };
  const verified = verifyTerminalControlApproval({ approval: input.approval, taskDir: input.taskDir, instanceId: input.instanceId });
  return verified.ok ? { ok: true } : { ok: false, reason: verified.reason };
}

export type AgentTerminalControlResult =
  | { ok: true; payload: { instanceId: string; action: "start" | "stop"; actor: "agent"; tier: PiPermission; instance: TerminalInstanceRecord } }
  | { ok: false; error: string };

export function runAgentTerminalControl(input: {
  registry: TaskTerminalRegistry;
  channel: TerminalControlChannel;
  /** This Host's task folder: the approval target is bound to it. */
  taskDir: string;
  sessionId: string;
  instanceId: string;
  action: "start" | "stop";
  approvalId?: unknown;
  /** Task write right ([PiDock 09] #11): claimed around the one-shot operation. */
  write: WriteCoordinatorPort;
  /** Persists the channel snapshot after minting or spending. */
  persist: () => void;
  /** Starts/registers the planned instance; returns the recorded instance. */
  act: () => TerminalInstanceRecord;
}): AgentTerminalControlResult {
  const tier = input.channel.currentPermission;
  const approvalId = input.approvalId;
  const liveApproval =
    typeof approvalId === "string" && approvalId.length > 0
      ? input.channel.snapshot().approvals.find((item) => item.id === approvalId)
      : undefined;
  const target = terminalApprovalTarget(input.taskDir, input.instanceId);
  const intent = {
    kind: "terminal-control" as const,
    label: `终端${input.action === "start" ? "启动" : "停止"} ${input.instanceId}`,
  };
  const decision = decideAgentTerminalControl({ tier, approval: liveApproval, taskDir: input.taskDir, instanceId: input.instanceId });
  if (!decision.ok) {
    if (tier === "default" && liveApproval === undefined) {
      const claim = input.write.claimWrite(input.sessionId, tier, intent);
      if (!claim.ok) return { ok: false, error: writeClaimError(claim) };
      try {
        const preview = input.channel.previewGate(TERMINAL_CONTROL_TOOL, target);
        if (preview.verdict === "ask") {
          const gate = input.channel.gate(TERMINAL_CONTROL_TOOL, target, "v1", undefined, TERMINAL_CONTROL_SCOPE);
          if (gate.verdict === "ask") {
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
    if (liveApproval !== undefined) {
      if (!input.channel.consumeApproval(liveApproval.id)) {
        return { ok: false, error: "approval-required: 确认请求已被消费，请重新确认" };
      }
      input.persist();
    }
    const instance = input.act();
    return { ok: true, payload: { instanceId: input.instanceId, action: input.action, actor: "agent", tier, instance } };
  } finally {
    input.write.releaseWrite(claim.claimId);
  }
}
