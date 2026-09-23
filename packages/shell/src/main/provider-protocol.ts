/**
 * Per-protocol request/response seams for the three model-provider protocols
 * ([PiDock 11] #9).
 *
 * A Provider profile names its protocol explicitly ([`resolveProtocol`]); the
 * vendor name and the service address never select one. The descriptor is the
 * single source for where each protocol puts the conversation, the tool
 * declarations, the streaming text/tool frames and the usage counters, so
 * "the message shape / stream frames / tool calls / usage fields were
 * verified for this protocol" is one table per protocol instead of a guess
 * per vendor.
 *
 * Pure module: no transport, no credentials, no `fetch`. Tests drive it with
 * recorded frames (real provider connectivity stays a recorded residual).
 */

export const PROVIDER_PROTOCOLS = ["anthropic-messages", "openai-responses", "openai-chat-completions"] as const;

export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number];

/** Where a normalized turn piece lands in the request body. */
export interface ProtocolDescriptor {
  id: ProviderProtocol;
  label: string;
  /** Body field carrying the conversation turns. */
  messageField: string;
  /** Body field carrying the system prompt (`null` = it rides `messageField`). */
  systemField: string | null;
  /** Body field carrying tool declarations. */
  toolField: string;
  /** Frame name carrying a text delta in the stream. */
  textFrame: string;
  /** Frame name carrying incremental tool-call arguments in the stream. */
  toolFrame: string;
  /** Frame name that settles the stream. */
  doneFrame: string;
  /** Path to the usage object, relative to the frame/payload root. */
  usagePath: readonly string[];
  /**
   * Standard model-discovery endpoint this protocol exposes, or `null` when
   * it declares none (the UI must then not offer 同步模型列表). A connection
   * can additionally report `unsupported` at runtime.
   */
  modelListPath: string | null;
  /**
   * Where a selected reasoning tier lands in this protocol's body. `null`
   * means the protocol has no reasoning parameter: a tier is then never
   * silently folded into another field.
   */
  reasoning: ProtocolReasoningMapping | null;
}

/**
 * Reasoning tier -> protocol parameter. The mapping is declared per protocol
 * (not guessed from the vendor), and `buildProtocolRequest` refuses to invent
 * a level the mapping does not name.
 */
export type ProtocolReasoningMapping =
  | {
      kind: "budget";
      /** Body field carrying the block, e.g. `thinking`. */
      field: string;
      /** Field inside the block carrying the token budget. */
      budgetField: string;
      /** Body field carrying the block type, when the API needs one. */
      typeField?: string;
      typeValue?: string;
      /** Token budget per tier. */
      budgets: Partial<Record<ReasoningTier, number>>;
    }
  | {
      kind: "effort";
      /** Body field carrying the effort (flat) or the object holding it (nested). */
      field: string;
      /** Field inside the object when `nested`. */
      effortField?: string;
      nested: boolean;
      /** Effort value per tier; an unnamed tier is not sent. */
      efforts: Partial<Record<ReasoningTier, string>>;
    };

/** Canonical tier order; mirrors the renderer/shell `REASONING_LEVELS`. */
export const REASONING_TIERS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ReasoningTier = (typeof REASONING_TIERS)[number];

export function isReasoningTier(value: unknown): value is ReasoningTier {
  return typeof value === "string" && (REASONING_TIERS as readonly string[]).includes(value);
}

const DESCRIPTORS: Record<ProviderProtocol, ProtocolDescriptor> = {
  "anthropic-messages": {
    id: "anthropic-messages",
    label: "Anthropic Messages",
    messageField: "messages",
    systemField: "system",
    toolField: "tools",
    textFrame: "content_block_delta",
    toolFrame: "input_json_delta",
    doneFrame: "message_stop",
    usagePath: ["usage"],
    modelListPath: "/v1/models",
    // Anthropic takes an explicit thinking block; `off` sends no block at all
    // (the API has no "disabled" budget value).
    reasoning: {
      kind: "budget",
      field: "thinking",
      budgetField: "budget_tokens",
      typeField: "type",
      typeValue: "enabled",
      budgets: { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32768, max: 65536 },
    },
  },
  "openai-responses": {
    id: "openai-responses",
    label: "OpenAI Responses",
    messageField: "input",
    systemField: "instructions",
    toolField: "tools",
    textFrame: "response.output_text.delta",
    toolFrame: "response.function_call_arguments.delta",
    doneFrame: "response.completed",
    usagePath: ["response", "usage"],
    modelListPath: "/v1/models",
    // Responses API nests the effort under `reasoning`; `minimal` is its own
    // value, `off` is expressed by omitting the block.
    reasoning: {
      kind: "effort",
      field: "reasoning",
      effortField: "effort",
      nested: true,
      efforts: { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" },
    },
  },
  "openai-chat-completions": {
    id: "openai-chat-completions",
    label: "OpenAI Chat Completions",
    messageField: "messages",
    // Chat Completions carries the system prompt as the first message.
    systemField: null,
    toolField: "tools",
    textFrame: "choices.0.delta.content",
    toolFrame: "choices.0.delta.tool_calls",
    doneFrame: "choices.0.finish_reason",
    usagePath: ["usage"],
    modelListPath: "/v1/models",
    // Chat Completions takes the flat `reasoning_effort` string.
    reasoning: {
      kind: "effort",
      field: "reasoning_effort",
      nested: false,
      efforts: { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" },
    },
  },
};

export function isProviderProtocol(value: unknown): value is ProviderProtocol {
  return typeof value === "string" && (PROVIDER_PROTOCOLS as readonly string[]).includes(value);
}

/** Descriptor lookup by explicit protocol id. Unknown ids fail closed. */
export function protocolDescriptor(protocol: string): ProtocolDescriptor {
  if (!isProviderProtocol(protocol)) throw new Error(`protocol-unsupported: ${protocol}`);
  return DESCRIPTORS[protocol];
}

export function listProtocolDescriptors(): ProtocolDescriptor[] {
  return PROVIDER_PROTOCOLS.map((id) => ({ ...DESCRIPTORS[id] }));
}

export type ProtocolResolution =
  | { ok: true; protocol: ProviderProtocol }
  | { ok: false; error: { code: "protocol-required" | "protocol-unsupported"; message: string } };

/**
 * Resolve the protocol a profile uses. The protocol must be named explicitly:
 * a vendor name or a service address is never enough (and never overrides an
 * explicit value), so "OpenAI 兼容网关" pointing at an Anthropic-shaped
 * endpoint cannot silently pick the wrong request shape.
 */
export function resolveProtocol(input: { protocol?: unknown; vendorName?: unknown; baseUrl?: unknown }): ProtocolResolution {
  if (input.protocol === undefined || input.protocol === null || input.protocol === "") {
    const vendor = typeof input.vendorName === "string" && input.vendorName.trim().length > 0 ? `（供应商 ${input.vendorName.trim()}）` : "";
    return {
      ok: false,
      error: { code: "protocol-required", message: `请显式选择协议${vendor}；不按供应商名或地址猜测协议` },
    };
  }
  if (!isProviderProtocol(input.protocol)) {
    return { ok: false, error: { code: "protocol-unsupported", message: `不支持的协议：${String(input.protocol)}` } };
  }
  return { ok: true, protocol: input.protocol };
}

export interface ProtocolTurn {
  role: "user" | "agent";
  text: string;
}

export interface ProtocolToolDeclaration {
  name: string;
  description: string;
  /** JSON schema of the tool input. */
  inputSchema: Record<string, unknown>;
}

export interface ProtocolRequestInput {
  model: string;
  /** System prompt; placed by `systemField` (or the leading message). */
  system?: string;
  turns: ProtocolTurn[];
  tools?: ProtocolToolDeclaration[];
  /** Max output tokens ([PiDock 11] #9 per-model setting). */
  maxOutput?: number;
  /**
   * Session reasoning tier ([PiDock 11] #9). Mapped through the protocol's
   * declared `reasoning` mapping; an unmapped tier is left out instead of
   * being guessed into another field.
   */
  reasoning?: { tier: string; budgetTokens?: number };
  stream?: boolean;
}

/**
 * Protocol-shaped request body. Field names come from the descriptor, so the
 * three protocols are built by one function and verified per protocol in
 * `provider-protocol.test.ts`.
 */
export function buildProtocolRequest(protocol: string, input: ProtocolRequestInput): Record<string, unknown> {
  const descriptor = protocolDescriptor(protocol);
  const body: Record<string, unknown> = { model: input.model };
  if (input.maxOutput !== undefined) {
    body[protocol === "anthropic-messages" ? "max_tokens" : protocol === "openai-responses" ? "max_output_tokens" : "max_tokens"] = input.maxOutput;
  }
  if (input.stream !== false) body["stream"] = true;
  const messages =
    protocol === "anthropic-messages"
      ? input.turns.map((turn) => ({ role: turn.role === "agent" ? "assistant" : "user", content: [{ type: "text", text: turn.text }] }))
      : protocol === "openai-responses"
        ? input.turns.map((turn) => ({
            // The internal `agent` role is a PiDock name and must not reach the
            // wire: Responses expects `assistant`. The assistant part type
            // `output_text` still needs a live confirmation once this module
            // gets its runtime caller ([PiDock 11] #9 residual).
            role: turn.role === "agent" ? "assistant" : "user",
            content: [{ type: turn.role === "agent" ? "output_text" : "input_text", text: turn.text }],
          }))
        : input.turns.map((turn) => ({ role: turn.role === "agent" ? "assistant" : "user", content: turn.text }));
  if (descriptor.systemField === null) {
    body[descriptor.messageField] = input.system ? [{ role: "system", content: input.system }, ...messages] : messages;
  } else {
    body[descriptor.messageField] = messages;
    if (input.system !== undefined) body[descriptor.systemField] = input.system;
  }
  if (input.reasoning !== undefined && descriptor.reasoning !== null) {
    const mapping = descriptor.reasoning;
    const tier = input.reasoning.tier;
    if (mapping.kind === "budget") {
      // `off` is the absence of the block, and Anthropic requires
      // `max_tokens` to stay above the budget: an impossible pair is not sent.
      const budget = input.reasoning.budgetTokens ?? (isReasoningTier(tier) ? mapping.budgets[tier] : undefined);
      // Anthropic needs `max_tokens > budget_tokens`: without a known max
      // output the pair cannot be formed, so the block is left out (never a
      // half-written request).
      const fits = input.maxOutput !== undefined && budget !== undefined && input.maxOutput > budget;
      if (tier !== "off" && fits) {
        body[mapping.field] = {
          ...(mapping.typeField !== undefined ? { [mapping.typeField]: mapping.typeValue } : {}),
          [mapping.budgetField]: budget,
        };
      }
    } else {
      const effort = isReasoningTier(tier) ? mapping.efforts[tier] : undefined;
      if (effort !== undefined) {
        body[mapping.field] = mapping.nested ? { [mapping.effortField ?? "effort"]: effort } : effort;
      }
    }
  }
  if (input.tools !== undefined && input.tools.length > 0) {
    body[descriptor.toolField] =
      protocol === "openai-chat-completions"
        ? input.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }))
        : protocol === "openai-responses"
          ? input.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema }))
          : input.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }));
  }
  return body;
}

export interface ProtocolUsage {
  input: number;
  output: number;
  cacheRead: number;
}

export interface ProtocolFrame {
  /** Text delta carried by this frame, when it carries one. */
  text?: string;
  /** Incremental tool-call fragment, when the frame carries one. */
  toolCall?: { id?: string; name?: string; arguments: string };
  /** Usage counters, when the frame reports them. */
  usage?: ProtocolUsage;
  /** True when the frame settles the stream. */
  done?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function readPath(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Usage counters for one protocol. Each protocol names its own fields; a
 * protocol whose frame omits them reports zero counters rather than being
 * relabelled (unknown usage is never shown as a real zero — callers carry the
 * `unreported` source alongside).
 */
export function readProtocolUsage(protocol: string, payload: unknown): ProtocolUsage | null {
  const descriptor = protocolDescriptor(protocol);
  const usage = readPath(payload, descriptor.usagePath);
  if (usage === undefined) return null;
  const record = asRecord(usage);
  if (protocol === "anthropic-messages") {
    return { input: nonNegative(record["input_tokens"]), output: nonNegative(record["output_tokens"]), cacheRead: nonNegative(record["cache_read_input_tokens"]) };
  }
  if (protocol === "openai-responses") {
    const details = asRecord(record["input_tokens_details"]);
    return { input: nonNegative(record["input_tokens"]), output: nonNegative(record["output_tokens"]), cacheRead: nonNegative(details["cached_tokens"]) };
  }
  const details = asRecord(record["prompt_tokens_details"]);
  return { input: nonNegative(record["prompt_tokens"]), output: nonNegative(record["completion_tokens"]), cacheRead: nonNegative(details["cached_tokens"]) };
}

/** Text delta carried by a stream frame for this protocol (undefined when none). */
export function readProtocolTextFrame(protocol: string, frame: unknown): string | undefined {
  const descriptor = protocolDescriptor(protocol);
  const record = asRecord(frame);
  const type = record["type"];
  if (protocol === "anthropic-messages") {
    if (type !== descriptor.textFrame) return undefined;
    const delta = asRecord(record["delta"]);
    return typeof delta["text"] === "string" ? delta["text"] : undefined;
  }
  if (protocol === "openai-responses") {
    if (type !== descriptor.textFrame) return undefined;
    return typeof record["delta"] === "string" ? record["delta"] : undefined;
  }
  const choices = record["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const delta = asRecord(asRecord(choices[0])["delta"]);
  return typeof delta["content"] === "string" ? delta["content"] : undefined;
}

/** Tool-call fragment carried by a stream frame for this protocol. */
export function readProtocolToolFrame(protocol: string, frame: unknown): { id?: string; name?: string; arguments: string } | undefined {
  const descriptor = protocolDescriptor(protocol);
  const record = asRecord(frame);
  if (protocol === "anthropic-messages") {
    if (record["type"] !== descriptor.toolFrame) return undefined;
    return { arguments: typeof record["partial_json"] === "string" ? record["partial_json"] : "" };
  }
  if (protocol === "openai-responses") {
    if (record["type"] !== descriptor.toolFrame) return undefined;
    return {
      ...(typeof record["item_id"] === "string" ? { id: record["item_id"] } : {}),
      arguments: typeof record["delta"] === "string" ? record["delta"] : "",
    };
  }
  const choices = record["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const calls = asRecord(asRecord(choices[0])["delta"])["tool_calls"];
  if (!Array.isArray(calls) || calls.length === 0) return undefined;
  const call = asRecord(calls[0]);
  const fn = asRecord(call["function"]);
  return {
    ...(typeof call["id"] === "string" ? { id: call["id"] } : {}),
    ...(typeof fn["name"] === "string" ? { name: fn["name"] } : {}),
    arguments: typeof fn["arguments"] === "string" ? fn["arguments"] : "",
  };
}

/** True when this frame settles the stream for the protocol. */
export function isProtocolDoneFrame(protocol: string, frame: unknown): boolean {
  const descriptor = protocolDescriptor(protocol);
  const record = asRecord(frame);
  if (protocol === "anthropic-messages") return record["type"] === descriptor.doneFrame;
  if (protocol === "openai-responses") return record["type"] === descriptor.doneFrame;
  const choices = record["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return false;
  return typeof asRecord(choices[0])["finish_reason"] === "string";
}

/** Normalize one recorded stream frame into the shared frame vocabulary. */
export function normalizeProtocolFrame(protocol: string, frame: unknown): ProtocolFrame {
  const text = readProtocolTextFrame(protocol, frame);
  const toolCall = readProtocolToolFrame(protocol, frame);
  const usage = readProtocolUsage(protocol, frame);
  const done = isProtocolDoneFrame(protocol, frame);
  return {
    ...(text !== undefined ? { text } : {}),
    ...(toolCall !== undefined ? { toolCall } : {}),
    ...(usage !== null ? { usage } : {}),
    ...(done ? { done } : {}),
  };
}
