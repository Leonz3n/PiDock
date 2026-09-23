/**
 * Host-side browser sequence for [PiDock 06] (#8).
 *
 * `host.ts` keeps the transport concerns (parent port, envelope
 * validation, caller classification) and calls these functions for the
 * agent and human branches, so the order that makes the gate correct is
 * testable without a utilityProcess: read the session's live permission →
 * find the live approval → decide → mint (only when the tier asks) →
 * spend one-shot → persist → perform through the main-process browser
 * capability → log the action into the session the user reads.
 *
 * The Host never talks to CDP and never sees a WebContents: it requests
 * one bounded action from main (`BrowserGatewayPort`), which owns the
 * visible page, the page handles, the navigation allowlist, the evidence
 * bounds and the takeover state. A caller-supplied `approvalGranted`
 * boolean or `actor` claim is never consulted.
 */

import type { PiApproval, PiPermission } from "../main/pi-session.js";
import { BROWSER_CONTROL_SCOPE } from "../main/pi-session.js";
import type { BrowserAction } from "../main/browser-rules.js";
import { browserApprovalTarget, browserToolForAction } from "../main/browser-rules.js";
import type { AgentControlChannel } from "./service-control.js";

/** The approval slice the browser verifier reads. */
export interface BrowserApprovalLike {
  status: string;
  tool: string;
  target: string;
  permissionAtRequest: string;
  consumedAt?: string;
  scope?: string;
}

/**
 * One bounded browser request the Host hands to main. Main validates the
 * page handle against its own live pages and the navigation allowlist, so
 * the Host can never address another task's page or an external target.
 */
export interface BrowserGatewayPort {
  readonly taskId: string;  perform(request: {
    action: BrowserAction;
    page: unknown;
    params: Record<string, unknown>;
    actor: { kind: "agent"; sessionId: string } | { kind: "human"; label: string };
  }): Promise<BrowserPerformResult>;
}

export type BrowserPerformResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * The slice of `PiSessionChannel` the browser sequence uses: the shared
 * agent-gate surface plus the message log, so a browser action and a user
 * marker are both visible in the session conversation.
 */
export interface BrowserControlChannel extends AgentControlChannel {
  appendMessage(input: {
    role: "user" | "agent";
    text: string;
    origin: "human" | "agent";
    references?: unknown[];
  }): unknown;
}

export type BrowserDecision = { ok: true } | { ok: false; reason: string };

/**
 * Server-side verification of a browser approval against the live session
 * record: it must exist, be `approved`, unspent, requested under `default`,
 * carry the `browser-control` scope, name exactly this action's tool and
 * the task-scoped page target. A turn approval for the same tool + target
 * has no scope and is refused, so one user confirmation can never cover
 * both a turn tool call and a Host-driven browser action.
 */
export function verifyBrowserControlApproval(input: {
  approval: BrowserApprovalLike | undefined;
  tool: string;
  taskDir: string;
  pageId?: string;
}): BrowserDecision {
  const approval = input.approval;
  if (!approval) return { ok: false, reason: "浏览器操作需先确认（批准后重试，拒绝/取消不执行页面操作）" };
  if (approval.status !== "approved" || approval.consumedAt !== undefined) {
    return { ok: false, reason: "确认请求已处理或未批准，不可重放" };
  }
  if (approval.permissionAtRequest !== "default") {
    return { ok: false, reason: "浏览器操作需先确认（批准后重试，拒绝/取消不执行页面操作）" };
  }
  if (approval.scope !== BROWSER_CONTROL_SCOPE) {
    return { ok: false, reason: "确认请求与浏览器操作不匹配（用途未绑定）" };
  }
  if (approval.tool !== input.tool) {
    return { ok: false, reason: "确认请求与浏览器操作不匹配（动作未绑定）" };
  }
  if (approval.target !== browserApprovalTarget(input.taskDir, input.pageId)) {
    return { ok: false, reason: "确认请求与浏览器操作不匹配（页面未绑定）" };
  }
  return { ok: true };
}

/**
 * Tier mapping shared by the sequence and its tests: `read` denies every
 * browser action (the Agent may not drive the page at all), `default`
 * needs a live verified approval, `auto` allows without asking. Ownership
 * is not a tier question — the gateway checks the page handle and the
 * navigation allowlist for every tier.
 */
export function decideAgentBrowserControl(input: {
  tier: PiPermission;
  tool: string;
  taskDir: string;
  pageId?: string;
  approval?: BrowserApprovalLike | undefined;
}): BrowserDecision {
  if (input.tier === "read") {
    return { ok: false, reason: "只读会话禁止浏览器操作，请先调整会话权限" };
  }
  if (input.tier === "default") {
    return verifyBrowserControlApproval({
      approval: input.approval,
      tool: input.tool,
      taskDir: input.taskDir,
      pageId: input.pageId,
    });
  }
  return { ok: true };
}

function pageIdOf(page: unknown): string | undefined {
  if (typeof page !== "object" || page === null || Array.isArray(page)) return undefined;
  const value = (page as Record<string, unknown>)["pageId"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export type AgentBrowserResult =
  | {
      ok: true;
      payload: {
        action: BrowserAction;
        actor: "agent";
        tier: PiPermission;
        pageId?: string;
        /** Present when the action needed a confirmation and got one. */
        approvalId?: string;
        [key: string]: unknown;
      };
    }
  | { ok: false; error: string };

/**
 * Agent browser action through the task's session gate.
 *
 * Order matters and is covered by `browser-control.test.ts`: the tier and
 * the approval come from the channel (never from the caller), the approval
 * is spent exactly once before the page is touched, a failed spend stops
 * the action, and every performed action is logged into the session so the
 * user can see what the Agent did to the page.
 */
export async function runAgentBrowserAction(input: {
  gateway: BrowserGatewayPort;
  channel: BrowserControlChannel;
  sessionId: string;
  taskId: string;
  action: BrowserAction;
  page?: unknown;
  params?: Record<string, unknown>;
  approvalId?: unknown;
  taskDir: string;
  contentVersion?: string;
  persist: () => void;
}): Promise<AgentBrowserResult> {
  // The gateway is wired per task; a mismatch would send this action to
  // another task's visible page, so it fails closed before any tier work.
  if (input.gateway.taskId !== input.taskId) {
    return { ok: false, error: "page-foreign-task: 浏览器能力绑定到其他任务，已拒绝" };
  }
  let tool: string;
  try {
    tool = browserToolForAction(input.action);
  } catch {
    return { ok: false, error: `permission-denied: ${input.action} 只能由用户显式操作` };
  }
  const tier = input.channel.currentPermission;
  const approvalId = input.approvalId;
  const liveApproval =
    typeof approvalId === "string" && approvalId.length > 0
      ? input.channel.snapshot().approvals.find((item: PiApproval) => item.id === approvalId)
      : undefined;
  const pageId = pageIdOf(input.page);
  const target = browserApprovalTarget(input.taskDir, pageId);
  const decision = decideAgentBrowserControl({ tier, tool, taskDir: input.taskDir, pageId, approval: liveApproval });
  if (!decision.ok) {
    // `default` without a live approval needs one: mint through the
    // channel gate so it carries tool/target/permission/scope and shows up
    // in the approval list the user acts on.
    if (tier === "default" && liveApproval === undefined) {
      const preview = input.channel.previewGate(tool, target);
      if (preview.verdict === "ask") {
        const gate = input.channel.gate(tool, target, input.contentVersion ?? "v1", undefined, BROWSER_CONTROL_SCOPE);
        if (gate.verdict === "ask") {
          input.persist();
          return { ok: false, error: `approval-required: ${gate.approvalId}` };
        }
      }
    }
    return { ok: false, error: decision.reason };
  }
  if (liveApproval !== undefined) {
    if (!input.channel.consumeApproval(liveApproval.id)) {
      return { ok: false, error: "approval-required: 确认请求已被消费，请重新确认" };
    }
    input.persist();
  }
  const performed = await input.gateway.perform({
    action: input.action,
    page: input.page,
    params: input.params ?? {},
    actor: { kind: "agent", sessionId: input.sessionId },
  });
  if (!performed.ok) return { ok: false, error: performed.error };
  input.channel.appendMessage({
    role: "agent",
    text: `浏览器操作：${input.action}${pageId ? ` @ ${pageId}` : ""}（${tier}）`,
    origin: "agent",
    references: [{ kind: "browser-action", action: input.action, pageId, approvalId: liveApproval?.id }],
  });
  input.persist();
  return {
    ok: true,
    payload: {
      ...performed.payload,
      action: input.action,
      actor: "agent",
      tier,
      ...(pageId !== undefined ? { pageId } : {}),
      ...(liveApproval !== undefined ? { approvalId: liveApproval.id } : {}),
    },
  };
}

export type HumanBrowserResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Human (UI) browser action: the attested, labelled path ([PiDock 04] #7
 * established the classification). No tier applies — the user is driving
 * the page they are looking at — but the action is still validated by the
 * gateway (page ownership, allowlist, evidence bounds).
 *
 * A user marker additionally enters the session conversation, so the Agent
 * works from the same page evidence the user marked.
 */
export async function runHumanBrowserAction(input: {
  gateway: BrowserGatewayPort;
  action: BrowserAction;
  page?: unknown;
  params?: Record<string, unknown>;
  label: string;
  taskId: string;
  channel: BrowserControlChannel;
  persist: () => void;
}): Promise<HumanBrowserResult> {
  if (input.gateway.taskId !== input.taskId) {
    return { ok: false, error: "page-foreign-task: 浏览器能力绑定到其他任务，已拒绝" };
  }
  const performed = await input.gateway.perform({
    action: input.action,
    page: input.page,
    params: input.params ?? {},
    actor: { kind: "human", label: input.label },
  });
  if (!performed.ok) return { ok: false, error: performed.error };
  if (input.action === "marker/create") {
    const marker = performed.payload["marker"];
    const annotation =
      typeof marker === "object" && marker !== null && typeof (marker as Record<string, unknown>)["annotation"] === "string"
        ? ((marker as Record<string, unknown>)["annotation"] as string)
        : "";
    input.channel.appendMessage({
      role: "user",
      text: `标记：${annotation}`,
      origin: "human",
      references: [marker],
    });
    input.persist();
  }
  return { ok: true, payload: performed.payload };
}
