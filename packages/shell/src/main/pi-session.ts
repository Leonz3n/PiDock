/**
 * Pi session channel for [PiDock 02] (#5), S1 slice.
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

export type PiUsageSource = "actual" | "estimated" | "unreported" | "test-double" | "approval";

export interface PiCallUsage {
  input: number;
  output: number;
  cacheRead: number;
  source: PiUsageSource;
}

export interface PiCallRecord {
  callId: string;
  providerId: string;
  model: string;
  usageSource: PiUsageSource;
  usage?: PiCallUsage;
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
  credentialRef?: string;
  permission: PiPermission;
  messages: PiMessage[];
  calls: PiCallRecord[];
  approvals: PiApproval[];
  runState: PiRunState;
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
  /**
   * Local credential reference for [PiDock 02] (#5), S6 batch 1.
   *
   * The Host stores only a reference (env key / keychain label), never the
   * secret itself. Real-model wiring is out of scope: no live calls here.
   */
  credentialRef?: string;
}

export interface PiProviderProfile {
  id: string;
  name: string;
  endpoint: string;
  models: string[];
}

const KNOWN_PI_PROVIDERS: readonly PiProviderProfile[] = [
  // `test-model` is the historical unit-test double; it stays listed so
  // existing channel/task-host tests keep constructing sessions with it.
  // Real-model wiring is out of scope for S6 batch 1 (test doubles only).
  { id: "provider-local", name: "本地", endpoint: "local", models: ["pidock-default", "test-model"] },
];

/**
 * Validate a provider/model selection for one session. Provider and model
 * ids are non-empty; unknown providers fall back to the local default so
 * a session always has a routable selection. Unknown models on a known
 * provider are rejected (fail-closed) instead of silently coerced.
 */
export function resolveProviderSelection(
  providerId: string,
  model: string,
): { providerId: string; model: string } {
  const provider = KNOWN_PI_PROVIDERS.find((item) => item.id === providerId);
  if (!provider) return { providerId: "provider-local", model: "pidock-default" };
  if (!provider.models.includes(model)) {
    throw new Error(`unknown model: ${model} for provider ${providerId}`);
  }
  return { providerId, model };
}

export function listKnownPiProviders(): PiProviderProfile[] {
  return KNOWN_PI_PROVIDERS.map((item) => ({ ...item, models: [...item.models] }));
}

export interface PiTurnInput {
  text: string;
  usageSource?: PiUsageSource;
  usage?: Partial<PiCallUsage>;
  providerId?: string;
  model?: string;
  credentialRef?: string;
  stream?: (chunk: { callId: string; text: string; done: boolean }) => void;
  tool?: string;
  target?: string;
  contentVersion?: string;
  execute?: (call: PiToolCall) => { tool?: string; kind?: PiToolKind; target: string; contentVersion: string; output: string } | null;
}

export interface PiTurnResult {
  state: PiRunState;
  call: PiCallRecord;
  approval?: PiApproval;
}

/**
 * Normalize a usage source. `undefined` (no caller claim) stays the
 * historical test-double default; an explicit but unknown value is
 * rejected fail-closed so direct channel callers cannot silently relabel
 * usage the RPC layer would refuse.
 */
function normalizeCallUsage(source: PiUsageSource | undefined, usage: Partial<PiCallUsage> | undefined): PiCallUsage {
  if (source !== undefined && source !== "actual" && source !== "estimated" && source !== "unreported" && source !== "approval" && source !== "test-double") {
    throw new Error(`invalid-payload: usageSource must be actual/estimated/unreported/test-double/approval, got ${source}`);
  }
  const normalized: PiUsageSource = source ?? "test-double";
  const nonNegative = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  return {
    input: nonNegative(usage?.input),
    output: nonNegative(usage?.output),
    cacheRead: nonNegative(usage?.cacheRead),
    source: normalized,
  };
}

/** Bounded settled-reply chunking (64 chars); terminal frame always sent. */
function streamText(
  stream: ((chunk: { callId: string; text: string; done: boolean }) => void) | undefined,
  callId: string,
  reply: string,
): void {
  if (!stream) return;
  const CHUNK = 64;
  for (let index = 0; index < reply.length; index += CHUNK) {
    stream({ callId, text: reply.slice(index, index + CHUNK), done: false });
  }
  stream({ callId, text: "", done: true });
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
  private credentialRef?: string;
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
    if (options.providerId.trim().length === 0) throw new Error("providerId must be non-empty");
    if (options.model.trim().length === 0) throw new Error("model must be non-empty");
    const selected = resolveProviderSelection(options.providerId, options.model);
    const credentialRef = options.credentialRef?.trim();
    if (options.credentialRef !== undefined && (credentialRef?.length ?? 0) === 0) {
      throw new Error("credentialRef must be a non-empty reference when provided");
    }
    this.providerId = selected.providerId;
    this.model = selected.model;
    this.credentialRef = credentialRef === undefined || credentialRef.length === 0 ? undefined : credentialRef;
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

  configureProvider(providerId: string, model: string, credentialRef?: string): void {
    const selected = resolveProviderSelection(providerId, model);
    const ref = credentialRef?.trim();
    if (credentialRef !== undefined && (ref?.length ?? 0) === 0) {
      throw new Error("credentialRef must be a non-empty reference when provided");
    }
    this.providerId = selected.providerId;
    this.model = selected.model;
    if (credentialRef !== undefined) {
      this.credentialRef = (ref as string).length === 0 ? undefined : (ref as string);
    }
  }

  get configuredCredentialRef(): string | undefined {
    return this.credentialRef;
  }

  /** Shared task write lock: held by at most one call until its tools settle. */
  get writeLockOwner(): string | null {
    return this.writeLock?.held === true ? (this.writeLock.ownerCallId ?? null) : null;
  }

  pendingApproval(): PiApproval | undefined {
    return this.approvals.find((approval) => approval.status === "pending");
  }

  /**
   * Permission gate, side-effect free. Previews whether a tool call would be
   * allowed/denied/asked; the `ask` case never creates the approval — the
   * turn owns approval creation via `requestApproval` so previews cannot
   * collide on anticipated call ids.
   */
  previewGate(toolName: string, target: string): PiGateDecision {
    const tool = isGatedTool(toolName);
    if (!tool) return { verdict: "deny", reason: `工具未接入门禁：${toolName}` };
    if (!targetInTask(this.taskDir, target)) {
      return { verdict: "deny", reason: `越界目标：${target} 不在任务目录内` };
    }
    if (this.permission === "read" && tool.kind !== "read") {
      return { verdict: "deny", reason: `只读会话禁止${tool.kind === "write" ? "写入" : tool.kind === "command" ? "命令" : "浏览器操作"}` };
    }
    if (this.permission === "default" && (tool.kind === "command" || tool.kind === "browser")) {
      return { verdict: "ask", approvalId: "preview" };
    }
    return { verdict: "allow" };
  }

  /**
   * Permission gate with approval creation. Read-only denies
   * writes/commands/browser; default asks for commands/browser; auto still
   * refuses out-of-task targets. Unknown tools are never offered (deny).
   * Permission changes apply to later calls only: the approval stores the
   * requesting tier.
   */
  gate(toolName: string, target: string, contentVersion: string, currentCallId?: string): PiGateDecision {
    const preview = this.previewGate(toolName, target);
    if (preview.verdict !== "ask") return preview;
    const tool = isGatedTool(toolName);
    if (!tool) return { verdict: "deny", reason: `\u5de5\u5177\u672a\u63a5\u5165\u95e8\u7981\uff1a${toolName}` };
    piApprovalSequence += 1;
    const approval: PiApproval = {
      id: `approval-${piApprovalSequence}`,
      // Inside a turn the caller passes the minted call id; standalone
      // gate checks (form preview) anticipate the next turn's id.
      callId: currentCallId ?? `call-${piCallSequence + 1}`,
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

  private requestApproval(toolName: string, target: string, contentVersion: string, callId: string): PiApproval {
    piApprovalSequence += 1;
    const approval: PiApproval = {
      id: `approval-${piApprovalSequence}`,
      callId,
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
    return approval;
  }

  /**
   * Run one user turn with a scripted tool plan. The first model call mints
   * the stable call identity; every turn records provider/model/usage source
   * and its event trail. Cancellation and tool failure keep prior messages.
   *
   * Per-turn provider/model overrides apply before the call is minted, so
   * the recorded call identity always names the model that actually ran.
   * `usage` rides the call record as structured counters plus a source
   * (`actual` vs `estimated` vs `unreported`; doubles use `test-double`),
   * persisted with the session for later Provider/usage summaries.
   * `stream`, when provided, receives the final agent reply in bounded
   * chunks (plus a terminal `{ done: true }` frame) once the turn settles.
   */
  runTurn(input: PiTurnInput): PiTurnResult {
    if (this.state === "running" || this.state === "approval") {
      throw new Error("当前执行尚未结束，请先停止或确认");
    }
    piCallSequence += 1;
    const callId = `call-${piCallSequence}`;
    const events: string[] = [`turn:start:${callId}`];
    // Provider fallback (unknown per-turn/full-turn provider id) is
    // intentional: the session always keeps a routable selection. Emit a
    // `turn:provider-fallback` event so consumers can distinguish fallback
    // from an explicit selection instead of silently rerouting.
    if (input.providerId !== undefined || input.model !== undefined) {
      const requestedProviderId = input.providerId ?? this.providerId;
      const selected = resolveProviderSelection(
        requestedProviderId,
        input.model ?? this.model,
      );
      if (requestedProviderId !== selected.providerId) {
        events.push(`turn:provider-fallback:${requestedProviderId}->${selected.providerId}`);
      }
      this.providerId = selected.providerId;
      this.model = selected.model;
    }
    const credentialRef = input.credentialRef?.trim();
    if (input.credentialRef !== undefined) {
      if ((credentialRef?.length ?? 0) === 0) {
        throw new Error("credentialRef must be a non-empty reference when provided");
      }
      this.credentialRef = credentialRef;
      events.push("turn:credential-rotated");
    }
    const usage = normalizeCallUsage(input.usageSource, input.usage);
    const call: PiCallRecord = {
      callId,
      providerId: this.providerId,
      model: this.model,
      usageSource: usage.source,
      usage,
      events,
    };
    this.calls.push(call);
    this.messageSequence += 1;
    this.messages.push({ id: `msg-${this.messageSequence}`, role: "user", text: input.text, callId });
    this.state = "running";
    this.writeLock = { ownerCallId: callId, held: true };
    events.push("write-lock:acquired");

    try {
      const plannedTool = input.tool ?? "fs.write";
      const plannedKind: PiToolKind =
        plannedTool === "exec.run" ? "command" : plannedTool === "browser.act" ? "browser" : plannedTool === "fs.read" ? "read" : "write";
      const plannedTarget = input.target ?? `${this.taskDir}/notes.md`;
      const plannedVersion = input.contentVersion ?? "v1";
      const toolCall =
        input.execute?.({ callId, tool: plannedTool, kind: plannedKind, target: plannedTarget, contentVersion: plannedVersion }) ?? null;
      if (toolCall) {
        // The tool under gate is the executed tool: the script's return
        // wins when it names one, otherwise the planned input tool.
        const gatedTool = typeof (toolCall as { tool?: unknown }).tool === "string" ? (toolCall as { tool: string }).tool : plannedTool;
        const decision = this.previewGate(gatedTool, toolCall.target);
        events.push(`gate:${gatedTool}:${decision.verdict}`);
        if (decision.verdict === "deny") {
          return this.finishTurn(call, "failed", `已拒绝${gatedTool === "fs.write" ? "写入" : "调用"} ${toolCall.target}，已有消息与代码保留。`, input.stream);
        }
        if (decision.verdict === "ask") {
          this.state = "approval";
          const approval = this.requestApproval(gatedTool, toolCall.target, toolCall.contentVersion, callId);
          events.push("turn:awaiting-approval");
          return { state: "approval", call, approval };
        }
        events.push(`tool:${gatedTool}:${toolCall.target}`);
      }
      return this.finishTurn(call, "done", `已按「${input.text}」完成检查。`, input.stream);
    } catch {
      return this.finishTurn(call, "failed", "执行失败，已保留已有消息与代码。", input.stream);
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
    const snapshot: PiSessionSnapshot = {
      taskId: this.taskId,
      sessionId: this.sessionId,
      providerId: this.providerId,
      model: this.model,
      permission: this.permission,
      messages: this.messages.map((message) => ({ ...message })),
      calls: this.calls.map((call) => ({ ...call, usage: call.usage ? { ...call.usage } : undefined, events: [...call.events] })),
      approvals: this.approvals.map((approval) => ({ ...approval })),
      runState: this.state,
      createdAt: this.createdAt,
      updatedAt: this.now(),
    };
    if (this.credentialRef !== undefined) {
      snapshot.credentialRef = this.credentialRef;
    }
    return snapshot;
  }

  /**
   * Tasks and sessions persist separately; resume restores the exact session.
   * Pending approvals never auto-replay: reopening expires them so the user
   * must confirm again. `createdAt` is preserved from the saved snapshot.
   */
  static restore(snapshot: PiSessionSnapshot, taskDir: string): PiSessionChannel {
    const channel = new PiSessionChannel({
      taskId: snapshot.taskId,
      sessionId: snapshot.sessionId,
      taskDir,
      providerId: snapshot.providerId,
      model: snapshot.model,
      permission: snapshot.permission,
      credentialRef: snapshot.credentialRef,
    });
    channel.messages = snapshot.messages.map((message) => ({ ...message }));
    channel.calls = snapshot.calls.map((call) => {
      // S6 batch 1 adds structured `usage`; older snapshots without it
      // restore as `unreported` so usage summaries never read garbage.
      // Backfill the legacy `usageSource` twin alongside `usage.source`
      // so the two never diverge after a restore.
      const usage = call.usage ?? { input: 0, output: 0, cacheRead: 0, source: "unreported" as const };
      return { ...call, usage, usageSource: usage.source, events: [...call.events] };
    });
    channel.approvals = (snapshot.approvals ?? []).map((approval) => ({
      ...approval,
      status: approval.status === "pending" ? "expired" : approval.status,
      executed: approval.status === "approved" ? approval.executed : false,
    }));
    // A restored session never resumes mid-turn: approval turns settle to
    // cancelled so history is kept but nothing replays.
    channel.state = snapshot.runState === "approval" || snapshot.runState === "running" ? "cancelled" : snapshot.runState;
    (channel as unknown as { createdAt: string }).createdAt = snapshot.createdAt;
    channel.messageSequence = snapshot.messages.length;
    return channel;
  }

  private finishTurn(
    call: PiCallRecord,
    state: "done" | "failed",
    reply: string,
    stream?: (chunk: { callId: string; text: string; done: boolean }) => void,
  ): PiTurnResult {
    this.messageSequence += 1;
    this.messages.push({ id: `msg-${this.messageSequence}`, role: "agent", text: reply, callId: call.callId });
    call.events.push(`turn:${state}`);
    this.releaseWriteLock(call.callId);
    this.state = state;
    // Settled-only streaming: chunk the final persisted reply (never a
    // live token flow in S6 batch 1) and always end with a done frame so
    // the renderer stop button cannot leave a half-open stream.
    streamText(stream, call.callId, reply);
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
