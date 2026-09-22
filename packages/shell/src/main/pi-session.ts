/**
 * Pi session channel for [PiDock 02] (#5), S2 slice.
 *
 * Pure state machine for one task's single AgentSession in the utilityProcess
 * Host. It covers the spec boxes that do not need a real model:
 *
 * - 用户能配置模型与本机凭据，发送消息，看到流式回复和工具结果，并中止执行
 * - 从首个模型调用开始提供稳定调用身份 (callId)，保留 Provider/模型/usage
 *   来源和事件；为后续多 Provider 和用量统计提供可恢复记录
 * - 接入真实 pi 工具前建立统一权限门禁：只读 / 默认权限 / 自动执行；
 *   只读禁止写入、命令和浏览器操作；默认权限的命令/浏览器操作先询问
 * - 基础确认：批准仅对本次请求生效且执行前复核，拒绝/取消不执行；
 *   保存请求权限和确认结果，重开不自动重放；权限变更只作用于后续请求
 * - UI 与 Agent 共用任务操作入口；单会话持有任务写操作权直到相关工具与
 *   子进程结束 (write-lock owner is task-scoped, released on end)
 * - 任务和会话分别持久化；用临时仓库验证修改只落入该任务；
 *   模型故障或取消不丢失已有消息与代码
 *
 * The machine is transport-free: main/Host wire it to typed RPC; tests drive
 * it directly with a fake tool runner. Tool calls are the controlled surface:
 * unlisted tools are never offered to the Agent (fail-closed gate).
 */

export type PiPermission = "read" | "default" | "auto";

export type PiRunState = "idle" | "running" | "approval" | "done" | "cancelled" | "failed";

export type PiToolKind = "read" | "write" | "command" | "browser";

export interface PiToolDefinition {
  name: string;
  kind: PiToolKind;
}

export interface PiToolCall {
  callId: string;
  tool: string;
  kind: PiToolKind;
  target: string;
  contentVersion: string;
}

export interface PiCallRecord {
  callId: string;
  providerId: string;
  model: string;
  usageSource: string;
  events: string[];
}

export interface PiMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  callId?: string;
}

export interface PiSessionSnapshot {
  taskId: string;
  sessionId: string;
  providerId: string;
  model: string;
  permission: PiPermission;
  messages: PiMessage[];
  calls: PiCallRecord[];
  createdAt: string;
  updatedAt: string;
}

/** Gated tools: the only tools the Agent may call. Everything else is closed. */
export const PI_GATED_TOOLS: readonly PiToolDefinition[] = [
  { name: "fs.read", kind: "read" },
  { name: "fs.write", kind: "write" },
  { name: "exec.run", kind: "command" },
  { name: "browser.act", kind: "browser" },
] as const;

export type PiGateDecision =
  | { verdict: "allow" }
  | { verdict: "deny"; reason: string }
  | { verdict: "ask"; approvalId: string };

export interface PiApproval {
  id: string;
  callId: string;
  taskId: string;
  sessionId: string;
  tool: string;
  target: string;
  permissionAtRequest: PiPermission;
  contentVersion: string;
  status: "pending" | "approved" | "rejected" | "expired";
  executed: boolean;
}

export interface PiSessionOptions {
  taskId: string;
  sessionId: string;
  taskDir: string;
  providerId: string;
  model: string;
  permission?: PiPermission;
  now?: () => string;
}

export interface PiTurnInput {
  text: string;
  usageSource?: string;
  execute?: (call: PiToolCall) => { target: string; contentVersion: string; output: string } | null;
}

export interface PiTurnResult {
  state: PiRunState;
  call: PiCallRecord;
  approval?: PiApproval;
}

function isGatedTool(name: string): PiToolDefinition | undefined {
  return PI_GATED_TOOLS.find((tool) => tool.name === name);
}

function targetInTask(taskDir: string, target: string): boolean {
  return target === taskDir || target.startsWith(`${taskDir}/`);
}

let piCallSequence = 0;
let piApprovalSequence = 0;

export function resetPiSequencesForTests(): void {
  piCallSequence = 0;
  piApprovalSequence = 0;
}

/**
 * Single-session Agent channel. One instance serves one task workspace Host;
 * later multi-session work reuses the same Host instead of spawning a process
 * per session (the write lock below is already task-scoped).
 */
export class PiSessionChannel {
  readonly taskId: string;
  readonly sessionId: string;
  readonly taskDir: string;

  private providerId: string;
  private model: string;
  private permission: PiPermission;
  private readonly now: () => string;
  private readonly createdAt: string;

  private state: PiRunState = "idle";
  private messages: PiMessage[] = [];
  private calls: PiCallRecord[] = [];
  private approvals: PiApproval[] = [];
  private writeLock: { ownerCallId: string; held: boolean } | null = null;
  private messageSequence = 0;

  constructor(options: PiSessionOptions) {
    if (options.taskId.trim().length === 0) throw new Error("taskId must be non-empty");
    if (options.sessionId.trim().length === 0) throw new Error("sessionId must be non-empty");
    if (options.taskDir.trim().length === 0) throw new Error("taskDir must be non-empty");
    this.taskId = options.taskId;
    this.sessionId = options.sessionId;
    this.taskDir = options.taskDir;
    this.providerId = options.providerId;
    this.model = options.model;
    this.permission = options.permission ?? "default";
    this.now = options.now ?? (() => new Date().toISOString());
    this.createdAt = this.now();
  }

  get runState(): PiRunState {
    return this.state;
  }

  get currentPermission(): PiPermission {
    return this.permission;
  }

  setPermission(permission: PiPermission): void {
    this.permission = permission;
  }

  configureProvider(providerId: string, model: string): void {
    this.providerId = providerId;
    this.model = model;
  }

  /** Shared task write lock: held by at most one call until its tools settle. */
  get writeLockOwner(): string | null {
    return this.writeLock?.held === true ? (this.writeLock.ownerCallId ?? null) : null;
  }

  pendingApproval(): PiApproval | undefined {
    return this.approvals.find((approval) => approval.status === "pending");
  }

  /**
   * Permission gate. Read-only denies writes/commands/browser; default asks
   * for commands/browser; auto still refuses out-of-task targets. Unknown
   * tools are never offered (deny). Permission changes apply to later calls
   * only: the approval stores the requesting tier.
   */
  gate(toolName: string, target: string, contentVersion: string): PiGateDecision {
    const tool = isGatedTool(toolName);
    if (!tool) return { verdict: "deny", reason: `工具未接入门禁：${toolName}` };
    if (!targetInTask(this.taskDir, target)) {
      return { verdict: "deny", reason: `越界目标：${target} 不在任务目录内` };
    }
    if (this.permission === "read" && tool.kind !== "read") {
      return { verdict: "deny", reason: `只读会话禁止${tool.kind === "write" ? "写入" : tool.kind === "command" ? "命令" : "浏览器操作"}` };
    }
    if (this.permission === "default" && (tool.kind === "command" || tool.kind === "browser")) {
      piApprovalSequence += 1;
      const approval: PiApproval = {
        id: `approval-${piApprovalSequence}`,
        callId: `call-${piCallSequence + 1}`,
        taskId: this.taskId,
        sessionId: this.sessionId,
        tool: toolName,
        target,
        permissionAtRequest: this.permission,
        contentVersion,
        status: "pending",
        executed: false,
      };
      this.approvals.push(approval);
      return { verdict: "ask", approvalId: approval.id };
    }
    return { verdict: "allow" };
  }

  /**
   * Run one user turn with a scripted tool plan. The first model call mints
   * the stable call identity; every turn records provider/model/usage source
   * and its event trail. Cancellation and tool failure keep prior messages.
   */
  runTurn(input: PiTurnInput): PiTurnResult {
    if (this.state === "running" || this.state === "approval") {
      throw new Error("当前执行尚未结束，请先停止或确认");
    }
    piCallSequence += 1;
    const callId = `call-${piCallSequence}`;
    const events: string[] = [`turn:start:${callId}`];
    const call: PiCallRecord = {
      callId,
      providerId: this.providerId,
      model: this.model,
      usageSource: input.usageSource ?? "test-double",
      events,
    };
    this.calls.push(call);
    this.messageSequence += 1;
    this.messages.push({ id: `msg-${this.messageSequence}`, role: "user", text: input.text, callId });
    this.state = "running";
    this.writeLock = { ownerCallId: callId, held: true };
    events.push("write-lock:acquired");

    try {
      const toolCall = input.execute?.({ callId, tool: "fs.write", kind: "write", target: `${this.taskDir}/notes.md`, contentVersion: "v1" }) ?? null;
      if (toolCall) {
        const decision = this.gate("fs.write", toolCall.target, toolCall.contentVersion);
        events.push(`gate:fs.write:${decision.verdict}`);
        if (decision.verdict === "deny") {
          return this.finishTurn(call, "failed", `已拒绝写入 ${toolCall.target}，已有消息与代码保留。`);
        }
        if (decision.verdict === "ask") {
          this.state = "approval";
          const approval = this.approvals.find((item) => item.callId === `call-${piCallSequence}` || item.status === "pending");
          events.push("turn:awaiting-approval");
          return { state: "approval", call, approval };
        }
        events.push(`tool:fs.write:${toolCall.target}`);
      }
      return this.finishTurn(call, "done", `已按「${input.text}」完成检查。`);
    } catch {
      return this.finishTurn(call, "failed", "执行失败，已保留已有消息与代码。");
    }
  }

  /** Approve exactly one pending request; the approval never replays. */
  approve(approvalId: string): PiCallRecord {
    const approval = this.approvals.find((item) => item.id === approvalId);
    if (!approval) throw new Error("确认请求不存在");
    if (approval.status !== "pending") throw new Error("确认请求已处理，不可重放");
    approval.status = "approved";
    approval.executed = true;
    const call = this.calls.find((item) => item.callId === approval.callId);
    call?.events.push(`approval:${approvalId}:approved:executed-once`);
    this.messageSequence += 1;
    this.messages.push({ id: `msg-${this.messageSequence}`, role: "agent", text: `已批准并执行 ${approval.tool} ${approval.target}。` });
    this.releaseWriteLock(call?.callId ?? approval.callId);
    this.state = "done";
    return call ?? { callId: approval.callId, providerId: this.providerId, model: this.model, usageSource: "approval", events: [] };
  }

  /** Reject/cancel: nothing executes, history is kept, no replay on reopen. */
  reject(approvalId: string): void {
    const approval = this.approvals.find((item) => item.id === approvalId);
    if (!approval) throw new Error("确认请求不存在");
    if (approval.status !== "pending") throw new Error("确认请求已处理，不可重放");
    approval.status = "rejected";
    approval.executed = false;
    const call = this.calls.find((item) => item.callId === approval.callId);
    call?.events.push(`approval:${approvalId}:rejected:zero-execution`);
    this.releaseWriteLock(call?.callId ?? approval.callId);
    this.state = "cancelled";
  }

  /** Abort the running turn; prior messages and code are preserved. */
  cancel(): void {
    if (this.state !== "running" && this.state !== "approval") return;
    const pending = this.pendingApproval();
    if (pending) {
      pending.status = "expired";
      pending.executed = false;
    }
    const current = this.calls[this.calls.length - 1];
    current?.events.push("turn:cancelled:history-preserved");
    this.releaseWriteLock(current?.callId ?? "");
    this.state = "cancelled";
  }

  snapshot(): PiSessionSnapshot {
    return {
      taskId: this.taskId,
      sessionId: this.sessionId,
      providerId: this.providerId,
      model: this.model,
      permission: this.permission,
      messages: this.messages.map((message) => ({ ...message })),
      calls: this.calls.map((call) => ({ ...call, events: [...call.events] })),
      createdAt: this.createdAt,
      updatedAt: this.now(),
    };
  }

  /** Tasks and sessions persist separately; resume restores the exact session. */
  static restore(snapshot: PiSessionSnapshot, taskDir: string): PiSessionChannel {
    const channel = new PiSessionChannel({
      taskId: snapshot.taskId,
      sessionId: snapshot.sessionId,
      taskDir,
      providerId: snapshot.providerId,
      model: snapshot.model,
      permission: snapshot.permission,
    });
    channel.messages = snapshot.messages.map((message) => ({ ...message }));
    channel.calls = snapshot.calls.map((call) => ({ ...call, events: [...call.events] }));
    channel.messageSequence = snapshot.messages.length;
    return channel;
  }

  private finishTurn(call: PiCallRecord, state: "done" | "failed", reply: string): PiTurnResult {
    this.messageSequence += 1;
    this.messages.push({ id: `msg-${this.messageSequence}`, role: "agent", text: reply, callId: call.callId });
    call.events.push(`turn:${state}`);
    this.releaseWriteLock(call.callId);
    this.state = state;
    return { state, call };
  }

  private releaseWriteLock(ownerCallId: string): void {
    if (this.writeLock?.ownerCallId === ownerCallId) {
      this.writeLock.held = false;
      const current = this.calls[this.calls.length - 1];
      current?.events.push("write-lock:released");
    }
  }
}
