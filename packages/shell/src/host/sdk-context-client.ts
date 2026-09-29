/**
 * Host-side handle for the isolated SDK model context ([PiDock 02m] #46).
 *
 * Spawns the `node:worker_threads` context that owns the task's
 * `PiSdkTextKernel` and forwards model-bearing operations to it. The spawn
 * environment is built by `sdk-context-env.ts` (allowlisted minimum, no
 * credential) while the resolved credential travels as `workerData`.
 *
 * Fail-closed semantics: a spawn failure, worker error, unexpected exit, or
 * malformed reply rejects every in-flight operation and poisons the client, so
 * a broken context can never silently degrade into an implicit-credential
 * request. A task whose provider is not configured does not create a client at
 * all (see the kernel resolver in the Host).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { buildSdkContextEnv, type SdkContextTaskBinding } from "./sdk-context-env.js";
import { validateExplicitTextProvider, type ExplicitTextProvider } from "./explicit-text-provider.js";
import type { SdkTextEvent, SdkTextResult } from "./sdk-text-kernel.js";
import type { SdkContextMessage, SdkContextRequestPayload } from "./sdk-context-worker.js";

export interface SdkTextKernelPort {
  open(sessionId: string): Promise<{ sdkId: string; file: string; tools: string[] }>;
  prompt(sessionId: string, text: string, deliver?: (event: SdkTextEvent) => void, issuedTurnId?: string): Promise<SdkTextResult>;
  cancel(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * The subset of `node:worker_threads`' `Worker` this client uses. Injected in
 * unit tests (a real thread can only load the built worker, which is covered by
 * the post-build harness), so the protocol and the dispatch environment are
 * testable without a build step.
 */
export interface SdkContextWorkerLike {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): void;
  on(event: "error", listener: (error: unknown) => void): void;
  on(event: "exit", listener: (code: number) => void): void;
  terminate(): Promise<number> | number;
}

export interface SdkContextOptions {
  task: SdkContextTaskBinding;
  config: ExplicitTextProvider;
  credential: string;
  /** Workspace id for log correlation only. */
  workspaceId?: string;
  /** Injected for tests; defaults to the compiled worker next to this file. */
  spawn?: (env: Record<string, string>, workerData: unknown) => SdkContextWorkerLike;
}

interface Pending {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  onEvent?: (event: SdkTextEvent) => void;
}

const READY_ID = "ready";

export class SdkContextClient implements SdkTextKernelPort {
  private worker: SdkContextWorkerLike | undefined;
  private ready: Promise<void> | undefined;
  private readonly pending = new Map<string, Pending>();
  private sequence = 0;
  private dead: string | undefined;
  private disposed = false;

  constructor(private readonly options: SdkContextOptions) {
    validateExplicitTextProvider(options.config);
    if (typeof options.credential !== "string" || options.credential.length < 8 || options.credential.length > 4096) {
      throw new Error("provider-not-configured");
    }
    if (typeof options.task.taskDir !== "string" || options.task.taskDir.length === 0) throw new Error("task-unknown");
  }

  private home(): string {
    const home = join(this.options.task.taskDir, ".pidock-sdk-context-home");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    return home;
  }

  private environment(): Record<string, string> {
    return buildSdkContextEnv(process.env, this.options.task, {
      home: this.home(),
      ...(this.options.workspaceId === undefined ? {} : { workspaceId: this.options.workspaceId }),
    });
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      if (this.disposed) throw new Error("sdk-context-disposed");
      // A credential must never appear in the spawn environment: the builder
      // asserts this, and the check keeps a future edit from silently breaking it.
      const env = this.environment();
      const workerData = { task: this.options.task, config: this.options.config, credential: this.options.credential };
      const worker = this.options.spawn?.(env, workerData) ?? new Worker(new URL("./sdk-context-worker.js", import.meta.url), { env, workerData });
      this.worker = worker;
      await new Promise<void>((resolve, reject) => {
        this.pending.set(READY_ID, { resolve: () => resolve(), reject });
        const failed = (error: Error) => {
          this.failAll(error);
          reject(error);
        };
        worker.on("error", (error) => failed(error instanceof Error ? error : new Error(String(error))));
        worker.on("exit", (code) => failed(new Error(`sdk-context-exit: ${code}`)));
        worker.on("message", (message: unknown) => this.receive(message));
      });
    })().catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.dead = failure.message;
      this.pending.clear();
      this.ready = undefined;
      throw failure;
    });
    return this.ready;
  }

  private receive(message: unknown): void {
    if (typeof message !== "object" || message === null || Array.isArray(message)) return;
    const record = message as Record<string, unknown>;
    const id = record["id"];
    if (typeof id !== "string") return;
    const entry = this.pending.get(id);
    if (!entry) return;
    if (record["kind"] === "event") {
      const event = record["event"];
      if (event && typeof event === "object") {
        try { entry.onEvent?.(event as SdkTextEvent); } catch { /* a dead receiver cannot stop the model turn */ }
      }
      return;
    }
    if (record["kind"] !== "reply") return;
    this.pending.delete(id);
    if (record["ok"] === true) {
      const payload = record["payload"];
      entry.resolve(payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {});
      return;
    }
    entry.reject(new Error(typeof record["error"] === "string" ? record["error"] : "sdk-context-failed"));
  }

  private failAll(error: Error): void {
    this.dead ??= error.message;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  private async call(message: SdkContextRequestPayload, onEvent?: (event: SdkTextEvent) => void): Promise<Record<string, unknown>> {
    if (this.dead) throw new Error(this.dead);
    if (this.disposed) throw new Error("sdk-context-disposed");
    await this.start();
    if (this.dead) throw new Error(this.dead);
    const id = `c${++this.sequence}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, ...(onEvent ? { onEvent } : {}) });
      try { this.worker!.postMessage({ ...message, id }); }
      catch (error) { this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  async open(sessionId: string): Promise<{ sdkId: string; file: string; tools: string[] }> {
    const payload = await this.call({ op: "open", sessionId });
    const tools = payload["tools"];
    if (typeof payload["sdkId"] !== "string" || typeof payload["file"] !== "string" || !Array.isArray(tools) ||
        tools.some((tool) => typeof tool !== "string")) throw new Error("sdk-context-reply-invalid");
    return { sdkId: payload["sdkId"], file: payload["file"], tools: tools as string[] };
  }

  async prompt(sessionId: string, text: string, deliver?: (event: SdkTextEvent) => void, issuedTurnId?: string): Promise<SdkTextResult> {
    const payload = await this.call({ op: "prompt", sessionId, text, ...(issuedTurnId === undefined ? {} : { issuedTurnId }) }, deliver);
    const state = payload["state"];
    if (state !== "done" && state !== "cancelled" && state !== "failed") throw new Error("sdk-context-reply-invalid");
    return {
      state, text: typeof payload["text"] === "string" ? payload["text"] : "", events: [],
      ...(typeof payload["error"] === "string" ? { error: payload["error"] } : {}),
    };
  }

  async cancel(sessionId: string): Promise<void> {
    await this.call({ op: "cancel", sessionId });
  }

  /** Idempotent: a second call after a failure or an explicit dispose is a no-op. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    const worker = this.worker;
    try { if (worker && !this.dead) await this.call({ op: "dispose" }); }
    catch { /* the context is already gone */ }
    this.disposed = true;
    this.failAll(new Error("sdk-context-disposed"));
    try { await worker?.terminate(); } catch { /* already exited */ }
  }
}

export type { SdkContextMessage };
