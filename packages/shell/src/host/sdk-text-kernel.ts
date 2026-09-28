import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { readTaskRecordOnDisk } from "./task-store.js";

type SdkTextEventData =
  | { type: "delta"; text: string }
  | { type: "message_end"; text: string; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null; error?: string }
  | { type: "agent_settled" };

export type SdkTextEvent = SdkTextEventData & {
  taskId: string;
  sessionId: string;
  turnId: string;
  sequence: number;
};

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

function safeId(id: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("invalid-session-id");
}

/** The opt-in model/runtime are test-only until #44 supplies an authorized profile resolver. */
export class PiSdkTextKernel {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly opening = new Map<string, Promise<AgentSession>>();
  private readonly active = new Map<string, Promise<void>>();
  private starting = false;
  private closing = false;
  private readonly root: string;
  private readonly agentDir: string;

  constructor(
    readonly taskId: string,
    readonly taskDir: string,
    private readonly selection?: { model: Model<Api>; modelRuntime: ModelRuntime },
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
    if (existsSync(mapping)) {
      if (!lstatSync(mapping).isFile()) throw new Error("sdk-binding-invalid");
      const binding: unknown = JSON.parse(readFileSync(mapping, "utf8"));
      if (typeof binding !== "object" || binding === null || Array.isArray(binding)) throw new Error("sdk-binding-invalid");
      const data = binding as Record<string, unknown>;
      if (data["taskId"] !== this.taskId || data["sessionId"] !== sessionId ||
          typeof data["file"] !== "string" || !/^[\w-]+\.jsonl$/.test(data["file"])) throw new Error("sdk-binding-invalid");
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
      writeFileSync(mapping, JSON.stringify({ taskId: this.taskId, sessionId, sdkId: manager.getSessionId(), file: basename(file) }), { flag: "wx", mode: 0o600 });
    }
    const storedModel = manager.buildSessionContext().model;
    if (storedModel && (storedModel.provider !== this.selection.model.provider || storedModel.modelId !== this.selection.model.id)) {
      throw new Error("sdk-configuration-mismatch");
    }
    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: this.taskDir,
      agentDir: this.agentDir,
      model: this.selection.model,
      modelRuntime: this.selection.modelRuntime,
      sessionManager: manager,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoader: emptyResources,
      noTools: "all",
      tools: [],
      thinkingLevel: "off",
    });
    if (modelFallbackMessage || session.model?.provider !== this.selection.model.provider ||
        session.model?.id !== this.selection.model.id || session.getActiveToolNames().length !== 0) {
      session.dispose();
      throw new Error("sdk-configuration-mismatch");
    }
    this.sessions.set(sessionId, session);
    return session;
  }

  /** Read only the explicitly bound SDK JSONL; no model or global auth is required. */
  projection(sessionId: string): { source: "sdk-jsonl"; sessionId: string; messages: { role: "user" | "assistant"; text: string; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null }[]; interrupted: boolean } {
    safeId(sessionId);
    this.verifyTask();
    const dir = join(this.root, sessionId);
    const mapping = join(dir, "binding.json");
    if (!existsSync(mapping)) return { source: "sdk-jsonl", sessionId, messages: [], interrupted: false };
    if (!lstatSync(dir).isDirectory() || realpathSync(dir) !== join(realpathSync(this.taskDir), ".pidock-sdk-sessions", sessionId) || !lstatSync(mapping).isFile()) throw new Error("sdk-binding-invalid");
    const binding: unknown = JSON.parse(readFileSync(mapping, "utf8"));
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) throw new Error("sdk-binding-invalid");
    const data = binding as Record<string, unknown>;
    if (data["taskId"] !== this.taskId || data["sessionId"] !== sessionId || typeof data["file"] !== "string" || !/^[\w-]+\.jsonl$/.test(data["file"])) throw new Error("sdk-binding-invalid");
    const file = join(dir, data["file"]);
    if (!lstatSync(file).isFile() || lstatSync(file).size > 2_000_000) throw new Error("sdk-projection-too-large");
    const manager = SessionManager.open(file, dir, this.taskDir);
    if (manager.getHeader()?.cwd !== this.taskDir || manager.getSessionId() !== data["sdkId"]) throw new Error("sdk-binding-invalid");
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

  async open(sessionId: string): Promise<{ sdkId: string; file: string; tools: string[] }> {
    const session = await this.sessionFor(sessionId);
    return { sdkId: session.sessionId, file: session.sessionFile!, tools: session.getActiveToolNames() };
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
      if (events.length >= 256 || Buffer.byteLength(JSON.stringify(data), "utf8") > 16_384) { deliveryError = true; return; }
      const event: SdkTextEvent = { ...data, taskId: this.taskId, sessionId, turnId, sequence: events.length + 1 };
      events.push(event);
      try { deliver?.(event); } catch { deliveryError = true; }
    };
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        emit({ type: "delta", text: event.assistantMessageEvent.delta });
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        textResult = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
        responseError = event.message.errorMessage;
        const { input, output, cacheRead, cacheWrite } = event.message.usage;
        emit({ type: "message_end", text: textResult, usage: { input, output, cacheRead, cacheWrite }, ...(responseError ? { error: responseError } : {}) });
      } else if (event.type === "agent_settled") {
        settled = true;
        emit({ type: "agent_settled" });
      }
    });
    const run = (async () => {
      try { await session.prompt(text); }
      finally { await session.waitForIdle(); unsubscribe(); }
    })();
    this.active.set(sessionId, run);
    try {
      await run;
      cancelled = session.messages.some((message) => message.role === "assistant" && message.stopReason === "aborted" && message === session.messages.at(-1));
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
  }

  async dispose(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.opening.values());
    for (const sessionId of [...this.active.keys()]) await this.cancel(sessionId);
    for (const session of this.sessions.values()) {
      await session.waitForIdle();
      session.dispose();
    }
    this.sessions.clear();
  }
}
