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

import { BROWSER_TOOL_ACTIONS } from "./browser-rules.js";
import {
  evaluateModelSwitch,
  evaluateThinkingSelection,
  resolveModelDisplayName,
  resolveProviderAvailability,
  resolveSessionThinking,
  type ProviderAvailability,
  type ProviderProfileRow,
  type SwitchRefusal,
  type ThinkingCatalog,
} from "./provider-config.js";

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
  /** Human-explicit input vs agent-autonomous output (spec: 分别标识). */
  origin: "human" | "agent";
  /**
   * Structured input refs (`@` file/context picks) ride here. Kept as
   * unknown fields so future ref shapes round-trip without a migration;
   * the channel never interprets them (S6 batch 2 persists, #16 refines).
   */
  references?: unknown[];
  /** Skill source (`$` invocation) that produced this message, if any. */
  skillSource?: string;
}

/** Unsent composer draft persisted with the session (never auto-sent). */
export interface PiSessionDraft {
  text: string;
  updatedAt: string;
  references?: unknown[];
  skillSource?: string;
}

/**
 * How current the session's context occupancy is ([PiDock 11] #9). `actual` is
 * a measured value, `estimated` an estimate, `pending` the window where the
 * occupancy is being recomputed (a compaction or a running turn) and
 * `unknown` no usable value. Only `actual`/`estimated` may be compared against
 * a model limit; `pending`/`unknown` are never treated as a zero pass.
 */
export type PiContextSource = "actual" | "estimated" | "pending" | "unknown";

/** Persisted context-usage state of one session. */
export interface PiSessionContext {
  /** Window of the currently selected model in k Tokens; `0` = unknown. */
  window: number;
  /** Occupancy in k Tokens as last reported. */
  used: number;
  source: PiContextSource;
}

/**
 * One recorded model switch. History keeps its own per-call attribution; this
 * event records that the *following* turns use another provider/model, plus any
 * reasoning preference the switch dropped.
 */
export interface PiModelSwitchEvent {
  at: string;
  from: { providerId: string; model: string } | null;
  to: { providerId: string; model: string };
  /** `human-switch` = the user picked; `agent-switch` = an agent tool request. */
  reason: "human-switch" | "agent-switch";
  /** Stale reasoning preference dropped by this switch, when any. */
  droppedThinking?: string;
}

/** Identity + context state readout for the conversation header / popover. */
export interface PiSessionContextView {
  providerId: string;
  providerName: string | null;
  model: string;
  modelName: string | null;
  availability: ProviderAvailability;
  window: number;
  used: number;
  source: PiContextSource;
  /** Cumulative tokens consumed by this session's calls (never reset by a switch/compaction). */
  tokens: number;
  /** Occupancy ratio; `null` while the window is unknown. */
  percent: number | null;
  thinking: string;
  thinkingCatalog: ThinkingCatalog;
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
  /** Unsent draft; absent when the composer is empty. Never auto-sent. */
  draft?: PiSessionDraft;
  /** Context occupancy/window of the selected model ([PiDock 11] #9). */
  context?: PiSessionContext;
  /** Session reasoning-level preference; invalidated when the model does not declare it. */
  thinking?: string;
  /** Recorded model switches (the switch event log). */
  switches?: PiModelSwitchEvent[];
}

/**
 * Gated browser tools ([PiDock 06] #8). Each name is the approval binding
 * for exactly one action (`browser-rules.ts` maps name -> action), so the
 * permission gate and the Host sequence never re-derive which browser
 * operation a confirmation was minted for. `browser.act` is the legacy
 * composite name the turn plans already use.
 */
const BROWSER_TOOL_DEFINITIONS: readonly PiToolDefinition[] = Object.keys(BROWSER_TOOL_ACTIONS)
  .sort()
  .map((name) => ({ name, kind: "browser" satisfies PiToolKind }));

/** Gated tools: the only tools the Agent may call. Everything else is closed. */
export const PI_GATED_TOOLS: readonly PiToolDefinition[] = [
  { name: "fs.read", kind: "read" },
  { name: "fs.write", kind: "write" },
  { name: "exec.run", kind: "command" },
  ...BROWSER_TOOL_DEFINITIONS,
] as const;

export type PiGateDecision =
  | { verdict: "allow" }
  | { verdict: "deny"; reason: string }
  | { verdict: "ask"; approvalId: string };

/**
 * Mint purpose tag on an approval. Absent = the turn flow's own
 * `exec.run`/`browser.*` request (the default). `service-control` and
 * `browser-control` are stamped only by the Host when it mints a service
 * start/stop ([PiDock 04] #7) or a task-browser action ([PiDock 06] #8)
 * approval, so an identically shaped turn approval for the same tool +
 * target can never be spent on either Host-driven path (and vice versa).
 */
export type PiApprovalScope = "service-control" | "browser-control";

/** The only scope a Host service-control approval is minted with. */
export const SERVICE_CONTROL_SCOPE: PiApprovalScope = "service-control";

/** The only scope a Host-minted task-browser approval carries. */
export const BROWSER_CONTROL_SCOPE: PiApprovalScope = "browser-control";

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
  /**
   * One-shot spend stamp, written on the Host side (never by the
   * renderer). An approved request is spent exactly once — either by the
   * Host-driven execution it authorized (service control / task browser,
   * [PiDock 04] #7 and [PiDock 06] #8) or by `restore` (an authorization
   * never survives a reopen). A spent request can never authorize another
   * action; `executed` alone cannot carry this because the turn flow sets
   * it in `approve()` before the gated command runs.
   */
  consumedAt?: string;
  /**
   * Mint purpose: absent means the turn flow's own request;
   * `service-control` marks a Host-minted service start/stop approval and
   * `browser-control` a Host-minted task-browser approval, each accepted
   * only by its own verifier.
   */
  scope?: PiApprovalScope;
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
  /**
   * Redacted provider catalog ([PiDock 11] #9): ids/names/protocols/model
   * declarations only, never an auth reference. When present, the selection is
   * resolved against it (existence, enabled state, window) instead of the
   * legacy `KNOWN_PI_PROVIDERS` fallback, so a restored session whose
   * configuration is gone reports unavailable instead of rerouting.
   */
  catalog?: readonly ProviderProfileRow[];
  /** Persisted context state (restore path); defaults to unknown/zero. */
  context?: PiSessionContext;
  /** Persisted session reasoning level (restore path). */
  thinking?: string;
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
  catalog?: readonly ProviderProfileRow[],
): { providerId: string; model: string } {
  // [PiDock 11] #9: with a catalog the selection is strict — an id the catalog
  // does not know is refused instead of silently rerouting to the legacy local
  // provider (a deleted/renamed configuration must be reported, not replaced).
  if (catalog !== undefined && catalog.length > 0) {
    const profile = catalog.find((item) => item.id === providerId);
    if (!profile) throw new Error(`unknown-provider: ${providerId}`);
    if (!profile.models.some((item) => item.id === model)) {
      throw new Error(`unknown model: ${model} for provider ${providerId}`);
    }
    return { providerId, model };
  }
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
  /** Structured input refs (`@` picks); persisted verbatim, never interpreted. */
  references?: unknown[];
  /** Skill source (`$` invocation) for this turn, persisted verbatim. */
  skillSource?: string;
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
  /** Send-record association: the user input message minted by this turn. */
  userMessageId: string;
  /** Send-record association: the agent reply (or awaiting-approval stub). */
  agentMessageId: string;
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

/** Gated tool names, shared by the Host planner selector (`host.ts`). */
export const PI_GATED_TOOL_NAMES: readonly string[] = PI_GATED_TOOLS.map((tool) => tool.name);

function isGatedTool(name: string): PiToolDefinition | undefined {
  return PI_GATED_TOOLS.find((tool) => tool.name === name);
}

/** Lexical path normalization (no fs access): unify `\`, drop `.`, resolve `..`. */
function normalizeToolTarget(target: string): string {
  const unified = target.replace(/\\/g, "/");
  const absolute = unified.startsWith("/");
  const parts: string[] = [];
  for (const segment of unified.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

function targetInTask(taskDir: string, target: string): boolean {
  // Compare normalized forms so `taskDir/../sibling` cannot pass the
  // prefix check and silently fall back to the original checkout dir.
  const dir = normalizeToolTarget(taskDir);
  const normalized = normalizeToolTarget(target);
  return normalized === dir || normalized.startsWith(`${dir}/`);
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
  private draft?: PiSessionDraft;
  /** Redacted provider catalog; empty = legacy fallback behaviour. */
  private catalog: readonly ProviderProfileRow[];
  private context: PiSessionContext;
  private thinkingLevel?: string;
  private switches: PiModelSwitchEvent[] = [];

  constructor(options: PiSessionOptions) {
    if (options.taskId.trim().length === 0) throw new Error("taskId must be non-empty");
    if (options.sessionId.trim().length === 0) throw new Error("sessionId must be non-empty");
    if (options.taskDir.trim().length === 0) throw new Error("taskDir must be non-empty");
    this.taskId = options.taskId;
    this.sessionId = options.sessionId;
    this.taskDir = options.taskDir;
    if (options.providerId.trim().length === 0) throw new Error("providerId must be non-empty");
    if (options.model.trim().length === 0) throw new Error("model must be non-empty");
    const hasCatalog = options.catalog !== undefined;
    const selected = hasCatalog ? { providerId: options.providerId, model: options.model } : resolveProviderSelection(options.providerId, options.model);
    const credentialRef = options.credentialRef?.trim();
    if (options.credentialRef !== undefined && (credentialRef?.length ?? 0) === 0) {
      throw new Error("credentialRef must be a non-empty reference when provided");
    }
    this.providerId = selected.providerId;
    this.model = selected.model;
    this.catalog = options.catalog ?? [];
    // A brand-new conversation has a known-empty context (measured zero); a
    // restored snapshot without a persisted reading is `pending` (待更新), which
    // the switch gate refuses rather than treating as a zero pass.
    this.context = options.context ?? { window: this.declaredWindow(), used: 0, source: "actual" };
    this.thinkingLevel = options.thinking;
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

  /** Model row the current selection names in the catalog, when the catalog knows it. */
  private currentModelRow(): ProviderProfileRow["models"][number] | undefined {
    const profile = this.catalog.find((item) => item.id === this.providerId);
    return profile?.models.find((item) => item.id === this.model);
  }

  /** Declared window (k Tokens) of the current model; `0` = unknown/fail-closed. */
  private declaredWindow(): number {
    return this.currentModelRow()?.contextWindow ?? 0;
  }

  private availabilityOf(): ProviderAvailability {
    if (this.catalog.length === 0) return resolveProviderAvailability({ exists: true, enabled: true });
    const profile = this.catalog.find((item) => item.id === this.providerId);
    if (!profile) return resolveProviderAvailability({ exists: false });
    return resolveProviderAvailability({
      exists: true,
      enabled: profile.enabled,
      model: this.model,
      models: profile.models.map((item) => item.id),
    });
  }

  /** Replace the redacted provider catalog this session resolves against. */
  setProviderCatalog(catalog: readonly ProviderProfileRow[]): void {
    this.catalog = catalog;
    // Follow the newly declared window while no turn reported a real one yet.
    const declared = this.declaredWindow();
    if (declared > 0 && this.context.window !== declared) {
      this.context = { ...this.context, window: declared };
    }
  }

  get providerCatalog(): readonly ProviderProfileRow[] {
    return this.catalog;
  }

  /** Occupancy state used by the switch gate (never coerced to a zero pass). */
  contextOccupancy(): PiSessionContext {
    return { ...this.context };
  }

  /** Record a context reading for the selected model. */
  recordContextUsage(input: { used: number; source: PiContextSource }): PiSessionContext {
    if (!Number.isFinite(input.used) || input.used < 0) throw new Error("invalid-payload: context usage must be non-negative");
    this.context = { window: this.context.window, used: input.used, source: input.source };
    return { ...this.context };
  }

  /** Cumulative tokens of this session's calls; never reset by a switch/compaction. */
  consumedTokens(): number {
    return this.calls.reduce((sum, call) => sum + (call.usage ? call.usage.input + call.usage.output : 0), 0);
  }

  /** True while a switch must wait: a turn/tool round or a pending confirmation. */
  private busyLabel(): string | null {
    if (this.state === "running") return "回合或工具执行中";
    if (this.state === "approval") return "等待确认中";
    return null;
  }

  /**
   * Readout for the conversation header / context popover: identity, declared
   * window, occupancy + source, cumulative tokens and the effective reasoning
   * level (with the catalog it came from).
   */
  contextView(): PiSessionContextView {
    const model = this.currentModelRow();
    const resolved = resolveSessionThinking({ thinking: model?.thinking }, this.thinkingLevel);
    const window = this.context.window;
    return {
      providerId: this.providerId,
      providerName: this.catalog.find((item) => item.id === this.providerId)?.name ?? null,
      model: this.model,
      modelName: model ? resolveModelDisplayName(model) : null,
      availability: this.availabilityOf(),
      window,
      used: this.context.used,
      source: this.context.source,
      tokens: this.consumedTokens(),
      percent: window > 0 ? (this.context.used * 100) / window : null,
      thinking: resolved.level,
      thinkingCatalog: resolved.catalog,
    };
  }

  get modelSwitchEvents(): PiModelSwitchEvent[] {
    return this.switches.map((event) => ({ ...event, from: event.from ? { ...event.from } : null, to: { ...event.to } }));
  }

  /**
   * Gate a model switch before any state changes. Busy rounds/tools/compactions
   * refuse first, then availability, then the strict context bound: an over-limit
   * or unknown/pending occupancy refuses, and a refusal leaves the original
   * model, history and draft untouched (no auto-compaction, no truncation).
   */
  canSwitchModel(target: { providerId: string; model: string }): { ok: true } | { ok: false; refusal: SwitchRefusal } {
    const profile = this.catalog.find((item) => item.id === target.providerId);
    const model = profile?.models.find((item) => item.id === target.model);
    const decision = evaluateModelSwitch({
      running: this.busyLabel() !== null,
      ...(this.busyLabel() !== null ? { busyLabel: this.busyLabel() as string } : {}),
      target:
        profile === undefined || model === undefined
          ? null
          : {
              providerId: profile.id,
              modelId: model.id,
              contextWindow: model.contextWindow,
              enabled: profile.enabled,
              exists: true,
            },
      occupancy: this.context,
    });
    return decision.ok ? { ok: true } : { ok: false, refusal: decision.error };
  }

  /**
   * Apply a switch that `canSwitchModel` (or the caller's re-check) allowed.
   * History attribution stays on the calls; this records the switch event and
   * drops a reasoning preference the target model does not declare.
   */
  applyModelSwitch(input: { providerId: string; model: string; reason: PiModelSwitchEvent["reason"] }): PiModelSwitchEvent {
    const profile = this.catalog.find((item) => item.id === input.providerId);
    const target = profile?.models.find((item) => item.id === input.model);
    if (target === undefined) throw new Error(`unknown model: ${input.model} for provider ${input.providerId}`);
    const from = { providerId: this.providerId, model: this.model };
    const resolvedThinking = resolveSessionThinking({ thinking: target.thinking }, this.thinkingLevel);
    this.providerId = input.providerId;
    this.model = input.model;
    this.context = { window: target.contextWindow, used: this.context.used, source: this.context.source };
    this.thinkingLevel = resolvedThinking.source === "session" ? resolvedThinking.level : undefined;
    const event: PiModelSwitchEvent = {
      at: this.now(),
      from,
      to: { providerId: input.providerId, model: input.model },
      reason: input.reason,
      ...(resolvedThinking.stale !== undefined ? { droppedThinking: resolvedThinking.stale } : {}),
    };
    this.switches.push(event);
    return { ...event, from: { ...from }, to: { ...event.to } };
  }

  /**
   * Session reasoning level. Fail-closed: an undeclared tier, a cleared picker
   * for a model that cannot turn reasoning off, an unknown catalog and an
   * unsupported model are all refused.
   */
  setThinkingLevel(level: string): { level: string; catalog: ThinkingCatalog } {
    const decision = evaluateThinkingSelection({ thinking: this.currentModelRow()?.thinking, level });
    if (!decision.ok) throw new Error(`${decision.error.code}: ${decision.error.message}`);
    this.thinkingLevel = decision.level;
    const resolved = resolveSessionThinking({ thinking: this.currentModelRow()?.thinking }, decision.level);
    return { level: decision.level, catalog: resolved.catalog };
  }

  get currentThinkingLevel(): string | undefined {
    return this.thinkingLevel;
  }

  /**
   * Context compaction: the current occupancy is replaced by a smaller estimate
   * and marked `pending`, cumulative tokens stay untouched, and no history is
   * dropped. The value is an estimate until the next real reading.
   */
  compactContext(): PiSessionContext {
    this.context = { window: this.context.window, used: Math.min(this.context.used, 9.2), source: "pending" };
    return { ...this.context };
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
  gate(toolName: string, target: string, contentVersion: string, currentCallId?: string, scope?: PiApprovalScope): PiGateDecision {
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
      ...(scope !== undefined ? { scope } : {}),
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
    // Pre-mint fail-closed validation: a rejected turn mints no call id
    // and mutates no session state (no call-id gap, no provider drift).
    const pendingCredentialRef = input.credentialRef?.trim();
    if (input.credentialRef !== undefined && (pendingCredentialRef?.length ?? 0) === 0) {
      throw new Error("credentialRef must be a non-empty reference when provided");
    }
    const pendingUsage = normalizeCallUsage(input.usageSource, input.usage);
    const pendingSelection =
      input.providerId !== undefined || input.model !== undefined
        ? {
            requested: input.providerId ?? this.providerId,
            selected: resolveProviderSelection(input.providerId ?? this.providerId, input.model ?? this.model),
          }
        : null;
    piCallSequence += 1;
    const callId = `call-${piCallSequence}`;
    const events: string[] = [`turn:start:${callId}`];
    // Provider fallback (unknown per-turn/full-turn provider id) is
    // intentional: the session always keeps a routable selection. Emit a
    // `turn:provider-fallback` event so consumers can distinguish fallback
    // from an explicit selection instead of silently rerouting.
    if (pendingSelection) {
      if (pendingSelection.requested !== pendingSelection.selected.providerId) {
        events.push(`turn:provider-fallback:${pendingSelection.requested}->${pendingSelection.selected.providerId}`);
      }
      this.providerId = pendingSelection.selected.providerId;
      this.model = pendingSelection.selected.model;
    }
    if (input.credentialRef !== undefined) {
      this.credentialRef = pendingCredentialRef;
      events.push("turn:credential-rotated");
    }
    const usage = pendingUsage;
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
    const userMessageId = `msg-${this.messageSequence}`;
    this.messages.push({
      id: userMessageId,
      role: "user",
      text: input.text,
      callId,
      // Human-explicit input (typed/sent by the user); agent output is
      // labelled below. Persisted so reopen shows who said what.
      origin: "human",
      ...(input.references !== undefined ? { references: input.references } : {}),
      ...(input.skillSource !== undefined ? { skillSource: input.skillSource } : {}),
    });
    this.state = "running";
    this.writeLock = { ownerCallId: callId, held: true };
    events.push("write-lock:acquired");

    try {
      const plannedTool = input.tool ?? "fs.write";
      // The tool's gated definition is the single source for its kind: a
      // browser tool plans as `browser`, an unknown name keeps the
      // historical write fallback (and is closed by the gate anyway).
      const plannedKind: PiToolKind =
        isGatedTool(plannedTool)?.kind ??
        (plannedTool === "exec.run" ? "command" : plannedTool === "fs.read" ? "read" : "write");
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
          return this.finishTurn(call, "failed", `已拒绝${gatedTool === "fs.write" ? "写入" : "调用"} ${toolCall.target}，已有消息与代码保留。`, input.stream, userMessageId);
        }
        if (decision.verdict === "ask") {
          this.state = "approval";
          const approval = this.requestApproval(gatedTool, toolCall.target, toolCall.contentVersion, callId);
          events.push("turn:awaiting-approval");
          // Awaiting-approval turns mint the agent stub now so the
          // user-input -> turn/call linkage exists before approval.
          this.messageSequence += 1;
          const agentMessageId = `msg-${this.messageSequence}`;
          this.messages.push({ id: agentMessageId, role: "agent", text: `等待确认：${gatedTool} ${toolCall.target}。`, callId, origin: "agent" });
          return { state: "approval", call, approval, userMessageId, agentMessageId };
        }
        events.push(`tool:${gatedTool}:${toolCall.target}`);
      }
      return this.finishTurn(call, "done", `已按「${input.text}」完成检查。`, input.stream, userMessageId);
    } catch {
      return this.finishTurn(call, "failed", "执行失败，已保留已有消息与代码。", input.stream, userMessageId);
    }
  }

  /** Approve exactly one pending request; the approval never replays. */
  approve(approvalId: string): PiCallRecord {
    const approval = this.approvals.find((item) => item.id === approvalId);
    if (!approval) throw new Error("确认请求不存在");
    if (approval.status !== "pending") throw new Error("确认请求已处理，不可重放");
    // One-shot: consume exactly this pending request. Re-approving the
    // same id fails above; approving a different pending id consumes that
    // one instead, so one approval can never execute twice or spill over.
    approval.status = "approved";
    approval.executed = true;
    const call = this.calls.find((item) => item.callId === approval.callId);
    call?.events.push(`approval:${approvalId}:approved:executed-once`);
    this.messageSequence += 1;
    this.messages.push({ id: `msg-${this.messageSequence}`, role: "agent", text: `已批准并执行 ${approval.tool} ${approval.target}。`, callId: approval.callId, origin: "agent" });
    this.releaseWriteLock(call?.callId ?? approval.callId);
    this.state = "done";
    return call ?? { callId: approval.callId, providerId: this.providerId, model: this.model, usageSource: "approval", events: [] };
  }

  /**
   * Spend one approved request for a Host-driven execution ([PiDock 04]
   * #7, service control): the request becomes single-use and can never
   * authorize a second start/stop. Fail-closed: unknown, non-approved and
   * already-spent ids all return `false` so the caller must re-confirm.
   */
  consumeApproval(approvalId: string): boolean {
    const approval = this.approvals.find((item) => item.id === approvalId);
    if (!approval || approval.status !== "approved" || approval.consumedAt !== undefined) return false;
    approval.consumedAt = this.now();
    return true;
  }

  /**
   * Append a conversation message without running a turn ([PiDock 06] #8).
   *
   * The task browser produces two kinds of session entries that are not
   * model calls: a user marker (task/page/URL/selection/annotation and the
   * obtainable locator, persisted in `references`) and the Agent's own
   * browser action log. Both must be visible in the conversation the user
   * reads, and neither may trigger a model request or change the run
   * state, so this is the narrow seam for them. `origin` keeps the
   * human/agent distinction the rest of the session uses.
   */
  appendMessage(input: {
    role: "user" | "agent";
    text: string;
    origin: "human" | "agent";
    references?: unknown[];
  }): PiMessage {
    if (input.text.trim().length === 0 && (input.references?.length ?? 0) === 0) {
      throw new Error("invalid-payload: 消息需要文本或结构化内容");
    }
    this.messageSequence += 1;
    const message: PiMessage = {
      id: `msg-${this.messageSequence}`,
      role: input.role,
      text: input.text,
      origin: input.origin,
      ...(input.references !== undefined ? { references: input.references } : {}),
    };
    this.messages.push(message);
    return message;
  }

  /** Save/refresh the unsent composer draft. Never auto-sends; survives restore. */
  saveDraft(draft: { text: string; references?: unknown[]; skillSource?: string }): void {
    this.draft = { text: draft.text, updatedAt: this.now(), ...(draft.references !== undefined ? { references: draft.references } : {}), ...(draft.skillSource !== undefined ? { skillSource: draft.skillSource } : {}) };
  }

  get currentDraft(): { text: string; updatedAt: string; references?: unknown[]; skillSource?: string } | undefined {
    return this.draft ? { ...this.draft } : undefined;
  }

  clearDraft(): void {
    this.draft = undefined;
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
      // Draft-tolerant persistence: the unsent composer text (+ structured
      // refs/skill source) round-trips with the session and is never
      // auto-sent on restore.
      ...(this.draft !== undefined ? { draft: { ...this.draft } } : {}),
      // [PiDock 11] #9: context state, reasoning preference and the switch
      // event log persist with the session so a reopen reports the same
      // identity/occupancy instead of deriving one.
      context: { ...this.context },
      ...(this.thinkingLevel !== undefined ? { thinking: this.thinkingLevel } : {}),
      switches: this.switches.map((event) => ({ ...event, from: event.from ? { ...event.from } : null, to: { ...event.to } })),
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
  static restore(snapshot: PiSessionSnapshot, taskDir: string, catalog?: readonly ProviderProfileRow[]): PiSessionChannel {
    const channel = new PiSessionChannel({
      taskId: snapshot.taskId,
      sessionId: snapshot.sessionId,
      taskDir,
      providerId: snapshot.providerId,
      model: snapshot.model,
      permission: snapshot.permission,
      credentialRef: snapshot.credentialRef,
      catalog,
      // Older snapshots have no context/thinking: restore as `pending`
      // occupancy (never as a zero pass) and keep the persisted preference.
      context: snapshot.context ?? { window: 0, used: 0, source: "pending" },
      ...(snapshot.thinking !== undefined ? { thinking: snapshot.thinking } : {}),
    });
    // S6 batch 2 adds `origin`/structured refs to messages and a `draft`:
    // older snapshots without them restore with a derived origin (user =
    // human, agent = agent) so the human/agent split never reads undefined.
    channel.messages = snapshot.messages.map((message) => ({
      ...message,
      origin: message.origin ?? (message.role === "user" ? ("human" as const) : ("agent" as const)),
    }));
    channel.draft = snapshot.draft ? { ...snapshot.draft } : undefined;
    channel.switches = (snapshot.switches ?? []).map((event) => ({
      ...event,
      from: event.from ? { ...event.from } : null,
      to: { ...event.to },
    }));
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
      // One-shot spend: an approved authorization that was never consumed
      // is spent at restore, so a reopened session must confirm again
      // before a Host-driven execution (service control) can run.
      ...(approval.status === "approved"
        ? { consumedAt: approval.consumedAt ?? channel.now() }
        : {}),
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
    stream: ((chunk: { callId: string; text: string; done: boolean }) => void) | undefined,
    userMessageId: string,
  ): PiTurnResult {
    this.messageSequence += 1;
    const agentMessageId = `msg-${this.messageSequence}`;
    this.messages.push({ id: agentMessageId, role: "agent", text: reply, callId: call.callId, origin: "agent" });
    call.events.push(`turn:${state}`);
    this.releaseWriteLock(call.callId);
    this.state = state;
    // Settled-only streaming: chunk the final persisted reply (never a
    // live token flow in S6 batch 1) and always end with a done frame so
    // the renderer stop button cannot leave a half-open stream.
    streamText(stream, call.callId, reply);
    return { state, call, userMessageId, agentMessageId };
  }

  private releaseWriteLock(ownerCallId: string): void {
    if (this.writeLock?.ownerCallId === ownerCallId) {
      this.writeLock.held = false;
      const current = this.calls[this.calls.length - 1];
      current?.events.push("write-lock:released");
    }
  }
}
