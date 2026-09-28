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

export type SdkTextEvent =
  | { type: "delta"; text: string }
  | { type: "message_end"; text: string; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null; error?: string }
  | { type: "agent_settled" };

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
    } else {
      // An existing folder without a binding is never adopted as context.
      if (readdirSync(dir).length > 0) throw new Error("sdk-binding-missing");
      manager = SessionManager.create(this.taskDir, dir);
      const file = manager.getSessionFile();
      if (!file || resolve(file) !== join(dir, basename(file))) throw new Error("sdk-binding-invalid");
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

  async open(sessionId: string): Promise<{ sdkId: string; file: string; tools: string[] }> {
    const session = await this.sessionFor(sessionId);
    return { sdkId: session.sessionId, file: session.sessionFile!, tools: session.getActiveToolNames() };
  }

  async prompt(sessionId: string, text: string, deliver?: (event: SdkTextEvent) => void): Promise<SdkTextResult> {
    if (!text.trim()) throw new Error("invalid-prompt");
    if (this.starting || this.active.size) throw new Error("task-locked");
    this.starting = true;
    let session: AgentSession;
    try { session = await this.sessionFor(sessionId); }
    finally { this.starting = false; }
    if (this.closing) throw new Error("sdk-closing");
    if (this.active.size) throw new Error("task-locked");
    const events: SdkTextEvent[] = [];
    let textResult = "";
    let responseError: string | undefined;
    let settled = false;
    let deliveryError = false;
    let cancelled = false;
    const emit = (event: SdkTextEvent) => {
      if (events.length >= 256) { deliveryError = true; return; }
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
      const error = deliveryError ? "sdk-event-delivery-failed" : responseError ?? (!settled ? "sdk-not-settled" : !textResult.trim() && !cancelled ? "sdk-empty-response" : undefined);
      return { state: cancelled ? "cancelled" : error ? "failed" : "done", text: textResult, events, ...(error ? { error } : {}) };
    } catch (error) {
      return { state: "failed", text: textResult, events, error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.active.delete(sessionId);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const run = this.active.get(sessionId);
    if (!run) return;
    const session = this.sessions.get(sessionId);
    if (session) await session.abort();
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
