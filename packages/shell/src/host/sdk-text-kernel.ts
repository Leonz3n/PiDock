import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { clampThinkingLevel, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  DefaultResourceLoader,
  formatSkillsForPrompt,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { readTaskRecordOnDisk } from "./task-store.js";
import { readSkillConfig, sessionSkills, type SkillConfigRead } from "./skill-sources.js";
import {
  buildSdkAgentToolDefinitions,
  sdkAgentSystemPrompt,
  SDK_AGENT_TOOL_NAMES,
  type SdkAgentToolCaller,
} from "./sdk-agent-tool-contract.js";
import { mcpExtension, readManagedMcpConfig, type McpBinding } from "./sdk-mcp.js";

/** `mcp__<server>__<tool>`: the only extension tools this kernel admits. */
function isMcpToolName(name: string): boolean {
  return /^mcp__[A-Za-z0-9][A-Za-z0-9_-]{0,127}__[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(name);
}

type SdkTextEventData =
  | { type: "delta"; text: string }
  | { type: "message_end"; text: string; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null; error?: string }
  | { type: "agent_settled"; aborted?: boolean };

export type SdkTextEvent = SdkTextEventData & {
  taskId: string;
  sessionId: string;
  turnId: string;
  sequence: number;
};

/**
 * [#139] One session's own transcript readout. Every number here comes from the
 * session's JSONL or is `null` (unknown); nothing is estimated or defaulted.
 */
export interface SdkSessionDigest {
  sessionId: string;
  turns: number;
  contextUsed: number | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  model: { provider: string; modelId: string } | null;
  /** The last committed entry is a user message: the turn it belongs to never settled. */
  interrupted: boolean;
}

export interface SdkTextResult {
  state: "done" | "cancelled" | "failed";
  text: string;
  events: SdkTextEvent[];
  error?: string;
}

const emptyResources: ResourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => "You are a text-only assistant. No tools are available.",
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
};

/**
 * The same loader with the task-scoped Agent prompt: it replaces the pi default
 * prompt (the SDK drops its own tools/rules sections when a custom prompt is
 * supplied), so it has to name the tool set and the confinement rule the Host
 * broker enforces. Resource discovery stays empty: the Agent gets the four
 * declared task tools and nothing else.
 */
function taskResources(taskDir: string, skillPrompt = ""): ResourceLoader {
  return {
    ...emptyResources,
    getSystemPrompt: () => sdkAgentSystemPrompt({ taskDir, worktrees: taskWorktreePaths(taskDir) }) + skillPrompt,
  };
}

/**
 * [#151] What a NEW session advertises from the PiDock-managed Skills source
 * list. The real disk is read at session creation only (`skill-sources.ts` uses
 * the SDK loader), so a toggle or a removed directory reaches the NEXT session
 * and never rewrites the prompt of one that is already running. An absent,
 * invalid or unreadable document contributes nothing: the turn still runs with
 * the task prompt, and the named scan problem stays in the pane.
 *
 * The advertised location is outside the task for the usual (user-added)
 * source, so the Host broker grants a read-only capability for exactly those
 * files: `fs.read` of a skill resource of an ENABLED source is served through
 * `skill-resource-access.ts`, while writes, commands and listings stay inside
 * the task. The prompt itself is still the only injection point - a restored
 * session re-opens its transcript and loads nothing again.
 */
export function sessionSkillPrompt(file: string | undefined): string {
  if (!file) return "";
  const read: SkillConfigRead = readSkillConfig(file);
  if (read.state !== "ok") return "";
  const { skills } = sessionSkills(read.config);
  // `indirect`: this Host's tool is `fs.read`, so the SDK formatter must not
  // advertise a tool that does not exist. The listing still names each skill's
  // absolute location, which is what the model resolves relative paths against.
  return formatSkillsForPrompt(skills, "indirect");
}

/** `repos` of the task record, each as `<taskDir>/<repoDir>` (never the original checkout). */
function taskWorktreePaths(taskDir: string): string[] {
  const record = readTaskRecordOnDisk(taskDir);
  return (record?.repos ?? []).map((repoDir) => `${taskDir.replace(/[\\/]+$/, "")}/${repoDir}`);
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function safeId(id: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("invalid-session-id");
}

/** The opt-in model/runtime are test-only until #44 supplies an authorized profile resolver. */
export class PiSdkTextKernel {
  private readonly sessions = new Map<string, AgentSession>();
  /**
   * [Pencil T15] #150: sessions whose MCP extension is bound. A stop/cancel
   * disposes one of these so Pi's `session_shutdown` closes the real MCP child
   * (no orphan); the transcript survives, and the next turn reopens it and
   * re-reads mcp.json.
   */
  private readonly mcpSessions = new Map<string, McpBinding>();
  private readonly opening = new Map<string, Promise<AgentSession>>();
  private readonly active = new Map<string, Promise<void>>();
  private starting = false;
  private closing = false;
  private readonly root: string;
  private readonly agentDir: string;
  /**
   * [Pencil T04] #139: per-session model/reasoning bindings applied by
   * `bindSession`. A binding is that session's identity: it is persisted into
   * the session's own `binding.json` and survives a kernel restart.
   */
  private readonly bindings = new Map<string, { modelId: string; thinkingLevel?: ModelThinkingLevel }>();

  constructor(
    readonly taskId: string,
    readonly taskDir: string,
    private readonly selection?: {
      model: Model<Api>;
      modelRuntime: ModelRuntime;
      bindingIdentity?: string;
      /**
       * The level the user selected for this model, already validated against
       * the model's declared capability by main. Defaults to `off`; the SDK
       * clamps anything the model does not support.
       */
      thinkingLevel?: ModelThinkingLevel;
      /**
       * [Pencil T04] #139: resolve another model of the *same* registered
       * profile by id, so one session can be bound to a different model of the
       * profile the context was installed for without a second credential or
       * endpoint identity. Absent (in-process tests) keeps the single model.
       */
      modelById?: (modelId: string) => Model<Api> | undefined;
      /**
       * The Host-side tool execution seam ([PiDock 02m] #5). Supplied only by
       * the isolated context worker (which forwards the call to the Host) or by
       * an in-process test; without it this kernel offers NO tools, which is
       * what the fail-closed `provider-not-configured`/no-tools paths rely on.
       */
      callTool?: SdkAgentToolCaller;
      /**
       * [Pencil T15] issue 150: the exact native `mcp.json` a session loads when
       * it starts. Absent means this context offers no MCP surface at all (the
       * fail-closed default for a Host that was not given one).
       */
      mcpConfigPath?: string;
      /**
       * [#151] The app-private Skills source document
       * (`skill-sources.json` under `userData`). Read once per session creation:
       * enabled, valid skills are advertised in that session's prompt with their
       * real locations. Absent = a task Host main did not wire.
       */
      skillSourcesFile?: string;
    },
  ) {
    if (!isAbsolute(taskDir) || !taskId) throw new Error("task-unknown");
    this.root = join(taskDir, ".pidock-sdk-sessions");
    this.agentDir = join(taskDir, ".pidock-sdk-agent");
  }

  private verifyTask(): void {
    const record = readTaskRecordOnDisk(this.taskDir);
    if (record?.taskId !== this.taskId || resolve(record.taskDir) !== resolve(this.taskDir)) throw new Error("task-unknown");
    if (!lstatSync(this.taskDir).isDirectory()) throw new Error("task-unknown: linked task directory");
  }

  private async sessionFor(sessionId: string): Promise<AgentSession> {
    safeId(sessionId);
    const existing = this.opening.get(sessionId);
    if (existing) return existing;
    const opening = this.createSession(sessionId);
    this.opening.set(sessionId, opening);
    try { return await opening; }
    finally { this.opening.delete(sessionId); }
  }

  /** The model a binding names; a binding never silently falls back to another model. */
  private modelFor(modelId: string): Model<Api> {
    const selection = this.selection!;
    if (selection.model.id === modelId) return selection.model;
    const resolved = selection.modelById?.(modelId);
    if (!resolved) throw new Error("sdk-model-unknown");
    return resolved;
  }

  /** A per-session binding override first, then the session's own persisted binding. */
  private bindingFor(sessionId: string, persisted: { modelId?: unknown; thinkingLevel?: unknown } | null): { modelId: string; thinkingLevel?: ModelThinkingLevel } | null {
    const override = this.bindings.get(sessionId);
    if (override) return override;
    if (persisted && typeof persisted.modelId === "string" && persisted.modelId.length > 0) {
      const level = persisted.thinkingLevel;
      return {
        modelId: persisted.modelId,
        ...(typeof level === "string" && (THINKING_LEVELS as readonly string[]).includes(level) ? { thinkingLevel: level as ModelThinkingLevel } : {}),
      };
    }
    return null;
  }

  /**
   * [#139] Change one session's model/reasoning, keeping its history.
   *
   * The JSONL is the session's context: a live `AgentSession` is disposed (after
   * it went idle) and the next `open`/`prompt` re-opens the SAME transcript with
   * the new model, so every earlier message stays and the following turns use the
   * model the user chose. The binding is written into `binding.json` atomically,
   * so a restart continues on the same model. Anything the SDK does not support
   * is reported as the SDK's own clamped level, never the requested one.
   */
  async bindSession(sessionId: string, binding: { modelId: string; thinkingLevel?: ModelThinkingLevel }): Promise<{ modelId: string; thinkingLevel: ModelThinkingLevel }> {
    safeId(sessionId);
    this.verifyTask();
    if (!this.selection) throw new Error("provider-not-configured");
    if (this.closing) throw new Error("sdk-closing");
    if (this.starting || this.active.has(sessionId)) throw new Error("sdk-session-busy");
    const model = this.modelFor(binding.modelId);
    const live = this.sessions.get(sessionId);
    if (live) {
      await live.waitForIdle();
      live.dispose();
      this.sessions.delete(sessionId);
      await this.closeMcp(sessionId);
    }
    const requested = binding.thinkingLevel ?? this.selection.thinkingLevel ?? "off";
    this.bindings.set(sessionId, { modelId: model.id, thinkingLevel: requested });
    this.persistBinding(sessionId, { modelId: model.id, thinkingLevel: requested });
    return { modelId: model.id, thinkingLevel: clampThinkingLevel(model, requested) };
  }

  /** Rewrite the model fields of an existing `binding.json` without touching its identity. */
  private persistBinding(sessionId: string, binding: { modelId: string; thinkingLevel?: ModelThinkingLevel }): void {
    const dir = join(this.root, sessionId);
    const mapping = join(dir, "binding.json");
    if (!existsSync(mapping)) return;
    if (!lstatSync(mapping).isFile()) throw new Error("sdk-binding-invalid");
    const current: unknown = JSON.parse(readFileSync(mapping, "utf8"));
    if (typeof current !== "object" || current === null || Array.isArray(current)) throw new Error("sdk-binding-invalid");
    const data = current as Record<string, unknown>;
    if (data["taskId"] !== this.taskId || data["sessionId"] !== sessionId) throw new Error("sdk-binding-invalid");
    const next = {
      ...data,
      modelId: binding.modelId,
      ...(binding.thinkingLevel === undefined ? {} : { thinkingLevel: binding.thinkingLevel }),
    };
    const temporary = `${mapping}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(next), { flag: "wx", mode: 0o600 });
      renameSync(temporary, mapping);
    } finally { try { rmSync(temporary, { force: true }); } catch { /* best effort */ } }
  }

  private async createSession(sessionId: string): Promise<AgentSession> {
    safeId(sessionId);
    this.verifyTask();
    if (this.closing) throw new Error("sdk-closing");
    if (!this.selection) throw new Error("provider-not-configured");
    const cached = this.sessions.get(sessionId);
    if (cached) return cached;
    const dir = join(this.root, sessionId);
    const mapping = join(dir, "binding.json");
    if (existsSync(this.root) && !lstatSync(this.root).isDirectory()) throw new Error("sdk-binding-invalid");
    if (existsSync(dir) && !lstatSync(dir).isDirectory()) throw new Error("sdk-binding-invalid");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(this.agentDir, { recursive: true, mode: 0o700 });
    if (realpathSync(dir) !== join(realpathSync(this.taskDir), ".pidock-sdk-sessions", sessionId) ||
        realpathSync(this.agentDir) !== join(realpathSync(this.taskDir), ".pidock-sdk-agent")) throw new Error("sdk-binding-invalid");
    let manager: SessionManager;
    let persisted: { modelId?: unknown; thinkingLevel?: unknown } | null = null;
    if (existsSync(mapping)) {
      if (!lstatSync(mapping).isFile()) throw new Error("sdk-binding-invalid");
      const binding: unknown = JSON.parse(readFileSync(mapping, "utf8"));
      if (typeof binding !== "object" || binding === null || Array.isArray(binding)) throw new Error("sdk-binding-invalid");
      const data = binding as Record<string, unknown>;
      if (data["taskId"] !== this.taskId || data["sessionId"] !== sessionId ||
          data["bindingIdentity"] !== this.selection.bindingIdentity ||
          typeof data["file"] !== "string" || !/^[\w-]+\.jsonl$/.test(data["file"])) throw new Error("sdk-binding-invalid");
      // [#139] The session's own model/reasoning binding lives in this file, so
      // a restart continues on the model this session was switched to. Metadata
      // fields are optional: a #138 binding carries none and keeps the strict
      // "stored model must equal the selected model" rule below.
      persisted = { modelId: data["modelId"], thinkingLevel: data["thinkingLevel"] };
      if (data["modelId"] !== undefined && typeof data["modelId"] !== "string") throw new Error("sdk-binding-invalid");
      const file = join(dir, data["file"]);
      if (!existsSync(file) || !lstatSync(file).isFile()) throw new Error("sdk-session-missing");
      const header: unknown = JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]!);
      if (typeof header !== "object" || header === null || (header as Record<string, unknown>)["cwd"] !== this.taskDir ||
          (header as Record<string, unknown>)["id"] !== data["sdkId"]) throw new Error("sdk-binding-invalid");
      manager = SessionManager.open(file, dir, this.taskDir);
      if (manager.getSessionId() !== data["sdkId"]) throw new Error("sdk-binding-invalid");
      // A terminated run can leave a user entry before its assistant reply.
      // Keep the JSONL evidence but exclude that unfinished leaf from model context.
      const branch = manager.getBranch();
      const latestMessage = branch.filter((entry) => entry.type === "message").at(-1);
      if (latestMessage?.type === "message" && latestMessage.message.role === "user") {
        const previousReply = [...branch].reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant");
        if (previousReply) manager.branch(previousReply.id);
        else manager.resetLeaf();
      }
    } else {
      // An existing folder without a binding is never adopted as context.
      if (readdirSync(dir).length > 0) throw new Error("sdk-binding-missing");
      const file = join(dir, `sdk-${randomUUID()}.jsonl`);
      // SDK open() writes a header to an exclusive empty file before its binding.
      writeFileSync(file, "", { flag: "wx", mode: 0o600 });
      manager = SessionManager.open(file, dir, this.taskDir);
      if (manager.getSessionFile() !== file || manager.getHeader()?.id !== manager.getSessionId() ||
          manager.getHeader()?.cwd !== this.taskDir) throw new Error("sdk-binding-invalid");
      const bound = this.bindings.get(sessionId);
      writeFileSync(mapping, JSON.stringify({ taskId: this.taskId, sessionId, sdkId: manager.getSessionId(), file: basename(file),
        ...(this.selection.bindingIdentity ? { bindingIdentity: this.selection.bindingIdentity } : {}),
        modelId: bound?.modelId ?? this.selection.model.id,
        thinkingLevel: bound?.thinkingLevel ?? this.selection.thinkingLevel ?? "off" }), { flag: "wx", mode: 0o600 });
    }
    const binding = this.bindingFor(sessionId, persisted);
    const model = binding ? this.modelFor(binding.modelId) : this.selection.model;
    const storedModel = manager.buildSessionContext().model;
    if (storedModel && (storedModel.provider !== model.provider || storedModel.modelId !== model.id)) {
      // [#139] A session bound to its own model keeps its whole history and
      // continues on the model the user chose; the change is recorded in the
      // transcript itself. Without a binding (#138) the old strict rule stays:
      // a task-wide model change never silently reinterprets an existing session.
      if (!binding) throw new Error("sdk-configuration-mismatch");
      manager.appendModelChange(model.provider, model.id);
    }
    // The Agent's tool set is exactly the declared task tools ([PiDock 02m] #5)
    // plus, when this Host supplied an MCP config path, the MCP extension's own
    // `mcp__…` tools. The allowlist is what keeps a tool the SDK adds later out:
    // `createAgentSession` exposes only the names listed here, so an unlisted
    // built-in or extension tool can never reach the model, and the mismatch
    // check below fails closed if the session ever reports anything else.
    const callTool = this.selection.callTool;
    const mcpPath = callTool === undefined ? undefined : this.selection.mcpConfigPath;
    const mcpBound = mcpPath !== undefined;
    const baseTools: string[] = callTool ? [...SDK_AGENT_TOOL_NAMES] : [];
    const skillPrompt = sessionSkillPrompt(this.selection.skillSourcesFile);
    let resourceLoader: ResourceLoader = callTool ? taskResources(this.taskDir, skillPrompt) : emptyResources;
    let mcpBinding: McpBinding | undefined;
    if (callTool && mcpPath !== undefined) {
      // The file is read HERE, once per session start. That is the session
      // boundary: a manager save applies to the next session, never this one.
      const managed = readManagedMcpConfig(mcpPath);
      mcpBinding = mcpExtension(sessionId, callTool, managed.loadConfig, join(this.agentDir, "mcp.log"));
      const loader = new DefaultResourceLoader({
        cwd: this.taskDir,
        agentDir: this.agentDir,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: sdkAgentSystemPrompt({ taskDir: this.taskDir, worktrees: taskWorktreePaths(this.taskDir) }) + skillPrompt,
        extensionFactories: [mcpBinding.factory],
      });
      await loader.reload();
      resourceLoader = loader;
    }
    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: this.taskDir,
      agentDir: this.agentDir,
      model,
      modelRuntime: this.selection.modelRuntime,
      sessionManager: manager,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoader,
      noTools: "all",
      // `mcp__*` keeps extension-registered MCP tools enabled/registered. Only
      // this kernel loads the MCP extension, so the wildcard admits no other
      // extension's tool.
      tools: [...baseTools, ...(mcpBound ? ["mcp__*"] : [])],
      ...(callTool ? { customTools: buildSdkAgentToolDefinitions(sessionId, callTool) } : {}),
      thinkingLevel: binding?.thinkingLevel ?? this.selection.thinkingLevel ?? "off",
    });
    if (mcpBound && mcpBinding !== undefined) {
      // Connects the configured servers in the background; direct tools are
      // awaited by the first prompt. `print` mode gives the extension no UI.
      await session.bindExtensions({ mode: "print" });
      this.mcpSessions.set(sessionId, mcpBinding);
    }
    const offered = [...session.getActiveToolNames()].sort();
    const registered = session.getAllTools().map((tool) => tool.name).sort();
    const admitted = (name: string) => baseTools.includes(name) || (mcpBound && isMcpToolName(name));
    if (modelFallbackMessage || session.model?.provider !== model.provider ||
        session.model?.id !== model.id ||
        !baseTools.every((name) => offered.includes(name)) ||
        offered.some((name) => !admitted(name)) ||
        registered.some((name) => !admitted(name))) {
      session.dispose();
      await this.closeMcp(sessionId);
      throw new Error("sdk-configuration-mismatch");
    }
    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * The explicitly bound JSONL of one session, opened for reading only: no model
   * and no global auth is required. `null` = this session has no SDK binding yet.
   */
  private boundManager(sessionId: string): SessionManager | null {
    safeId(sessionId);
    this.verifyTask();
    const dir = join(this.root, sessionId);
    const mapping = join(dir, "binding.json");
    if (!existsSync(mapping)) return null;
    if (!lstatSync(dir).isDirectory() || realpathSync(dir) !== join(realpathSync(this.taskDir), ".pidock-sdk-sessions", sessionId) || !lstatSync(mapping).isFile()) throw new Error("sdk-binding-invalid");
    const binding: unknown = JSON.parse(readFileSync(mapping, "utf8"));
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) throw new Error("sdk-binding-invalid");
    const data = binding as Record<string, unknown>;
    if (data["taskId"] !== this.taskId || data["sessionId"] !== sessionId || typeof data["file"] !== "string" || !/^[\w-]+\.jsonl$/.test(data["file"])) throw new Error("sdk-binding-invalid");
    const file = join(dir, data["file"]);
    if (!lstatSync(file).isFile() || lstatSync(file).size > 2_000_000) throw new Error("sdk-projection-too-large");
    const manager = SessionManager.open(file, dir, this.taskDir);
    if (manager.getHeader()?.cwd !== this.taskDir || manager.getSessionId() !== data["sdkId"]) throw new Error("sdk-binding-invalid");
    return manager;
  }

  /**
   * [#139] What this session's OWN transcript says, for the header readout:
   *
   * - `contextUsed` is the prompt size of the most recent request
   *   (`input + cacheRead + cacheWrite` of the last assistant report), which is
   *   the context that request actually carried. Nothing reported → `null`
   *   (unknown), never `0`.
   * - `usage` sums every assistant report in this session's branch: each JSONL
   *   entry counts exactly once, so re-reading after a restart or a replay adds
   *   nothing.
   * - `model` is the model the transcript last ran on (its own binding identity).
   */
  digest(sessionId: string): SdkSessionDigest {
    const manager = this.boundManager(sessionId);
    if (!manager) return { sessionId, turns: 0, contextUsed: null, usage: null, model: null, interrupted: false };
    const branch = manager.getBranch();
    const assistants = branch.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
    let usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null = null;
    let contextUsed: number | null = null;
    for (const entry of assistants) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const reported = entry.message.usage;
      usage ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      usage.input += reported.input;
      usage.output += reported.output;
      usage.cacheRead += reported.cacheRead;
      usage.cacheWrite += reported.cacheWrite;
      contextUsed = reported.input + reported.cacheRead + reported.cacheWrite;
    }
    const last = assistants.at(-1);
    const model = last?.type === "message" && last.message.role === "assistant"
      ? { provider: last.message.provider, modelId: last.message.model }
      : null;
    const messages = branch.filter((entry) => entry.type === "message");
    const interrupted = messages.at(-1)?.type === "message" && messages.at(-1)!.message.role === "user";
    return { sessionId, turns: assistants.length, contextUsed, usage, model, interrupted };
  }

  /** Read only the explicitly bound SDK JSONL; no model or global auth is required. */
  projection(sessionId: string): { source: "sdk-jsonl"; sessionId: string; messages: { role: "user" | "assistant"; text: string; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null }[]; interrupted: boolean } {
    const manager = this.boundManager(sessionId);
    if (!manager) return { source: "sdk-jsonl", sessionId, messages: [], interrupted: false };
    const entries = manager.getBranch().filter((entry) => entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")).slice(-80);
    const messages = entries.map((entry) => {
      if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) throw new Error("sdk-projection-invalid");
      const message = entry.message;
      const text = (typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("")).slice(0, 16_384);
      const usage = message.role === "assistant" ? { input: message.usage.input, output: message.usage.output, cacheRead: message.usage.cacheRead, cacheWrite: message.usage.cacheWrite } : null;
      return { role: message.role, text, usage };
    });
    return { source: "sdk-jsonl", sessionId, messages, interrupted: messages.at(-1)?.role === "user" };
  }

  async open(sessionId: string): Promise<{ sdkId: string; file: string; tools: string[]; modelId: string; thinkingLevel: string }> {
    const session = await this.sessionFor(sessionId);
    // [#139] The opened session reports the model and the CLAMPED reasoning level
    // the SDK actually runs with, so a caller never has to assume its request was
    // honoured verbatim.
    return { sdkId: session.sessionId, file: session.sessionFile!, tools: session.getActiveToolNames(),
      modelId: session.model?.id ?? "", thinkingLevel: session.thinkingLevel };
  }

  async prompt(sessionId: string, text: string, deliver?: (event: SdkTextEvent) => void, issuedTurnId?: string): Promise<SdkTextResult> {
    if (!text.trim()) throw new Error("invalid-prompt");
    if (this.starting || this.active.size) throw new Error("task-locked");
    this.starting = true;
    let session: AgentSession;
    try { session = await this.sessionFor(sessionId); }
    finally { this.starting = false; }
    if (this.closing) throw new Error("sdk-closing");
    if (this.active.size) throw new Error("task-locked");
    const events: SdkTextEvent[] = [];
    const turnId = issuedTurnId ?? randomUUID();
    let textResult = "";
    let responseError: string | undefined;
    let settled = false;
    let deliveryError = false;
    let cancelled = false;
    const emit = (data: SdkTextEventData) => {
      const event: SdkTextEvent = { ...data, taskId: this.taskId, sessionId, turnId, sequence: events.length + 1 };
      if (events.length >= 256 || Buffer.byteLength(JSON.stringify(event), "utf8") > 16_384) { deliveryError = true; return; }
      events.push(event);
      try { deliver?.(event); } catch { deliveryError = true; }
    };
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        emit({ type: "delta", text: event.assistantMessageEvent.delta });
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        textResult = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
        responseError = event.message.errorMessage ?? (event.message.stopReason === "length" ? "sdk-output-truncated" : undefined);
        const { input, output, cacheRead, cacheWrite } = event.message.usage;
        emit({ type: "message_end", text: textResult, usage: { input, output, cacheRead, cacheWrite }, ...(responseError ? { error: responseError } : {}) });
      } else if (event.type === "agent_settled") {
        settled = true;
        cancelled = event.aborted;
        emit({ type: "agent_settled", aborted: event.aborted });
      }
    });
    const run = (async () => {
      try { await session.prompt(text); }
      finally { await session.waitForIdle(); unsubscribe(); }
    })();
    this.active.set(sessionId, run);
    try {
      await run;
      // Pi 1.1+ reports cancellation at the run boundary, including aborts
      // during preflight that never produced an assistant message.
      const error = deliveryError ? "sdk-event-delivery-failed" : cancelled ? undefined : responseError ?? (!settled ? "sdk-not-settled" : !textResult.trim() ? "sdk-empty-response" : undefined);
      return { state: error ? "failed" : cancelled ? "cancelled" : "done", text: textResult, events, ...(error ? { error } : {}) };
    } catch (error) {
      return { state: "failed", text: textResult, events, error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.active.delete(sessionId);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    while (this.starting) await new Promise((resolve) => setTimeout(resolve, 10));
    const run = this.active.get(sessionId);
    if (!run) return;
    const session = this.sessions.get(sessionId);
    // SDK abort() is a no-op before prompt preflight starts its agent run.
    // Wait for the run to become abortable (or finish) before issuing it.
    while (session?.isIdle && this.active.has(sessionId)) await new Promise((resolve) => setTimeout(resolve, 10));
    if (session && !session.isIdle) await session.abort();
    await run.catch(() => {});
    if (session && this.mcpSessions.has(sessionId)) {
      // [Pencil T15] #150: stop really recycles the MCP child. The extension's
      // own shutdown handler closes the real connection; the JSONL stays, so
      // the next prompt reopens this session and re-reads mcp.json.
      await session.waitForIdle();
      await this.closeMcp(sessionId);
      session.dispose();
      this.sessions.delete(sessionId);
    }
  }

  async dispose(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.opening.values());
    for (const sessionId of [...this.active.keys()]) await this.cancel(sessionId);
    for (const sessionId of [...this.sessions.keys()]) await this.closeMcp(sessionId);
    for (const session of this.sessions.values()) {
      await session.waitForIdle();
      session.dispose();
    }
    this.sessions.clear();
  }

  /** One idempotent close of a session's MCP connections (no orphan child). */
  private async closeMcp(sessionId: string): Promise<void> {
    const binding = this.mcpSessions.get(sessionId);
    if (!binding) return;
    this.mcpSessions.delete(sessionId);
    await binding.close();
  }
}
