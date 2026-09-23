import {
  isBrowserResponse,
  type BrowserPerformResult,
  type BrowserRequest,
  type BrowserRequestActor,
  type BrowserResponse,
} from "./protocol.js";

/** Minimal post surface the utilityProcess Host has (`process.parentPort`). */
export interface BrowserTransport {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): void;
  removeListener?(event: "message", listener: (message: unknown) => void): void;
}

export interface HostBrowserClientOptions {
  /** Per-call timeout in ms (a stopped main must not hang the Host). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Host -> main browser client ([PiDock 06] #8).
 *
 * The utilityProcess Host holds no WebContents: every browser action it has
 * already gated becomes one request to main, correlated by id. Responses
 * and unrelated RPC traffic share the same parent port, so this client only
 * consumes `browser-response` envelopes it is waiting for and never touches
 * the `host/*` request/response pairs `HostClient` handles in main.
 */
export class HostBrowserClient {
  private readonly pending = new Map<
    string,
    { resolve: (value: BrowserPerformResult) => void; timer: NodeJS.Timeout }
  >();
  private sequence = 0;
  private readonly onMessage = (message: unknown): void => {
    this.handleMessage(message);
  };

  constructor(
    private readonly transport: BrowserTransport,
    private readonly workspaceId: string,
    private readonly options: HostBrowserClientOptions = {},
  ) {
    if (workspaceId.trim().length === 0) throw new Error("workspaceId must be non-empty");
    this.transport.on("message", this.onMessage);
  }

  perform(input: {
    taskId: string;
    action: string;
    page?: unknown;
    params?: Record<string, unknown>;
    actor: BrowserRequestActor;
  }): Promise<BrowserPerformResult> {
    const id = `browser-${++this.sequence}`;
    const request: BrowserRequest = {
      kind: "browser-request",
      id,
      params: {
        workspaceId: this.workspaceId,
        taskId: input.taskId,
        action: input.action,
        ...(input.page !== undefined ? { page: input.page } : {}),
        ...(input.params !== undefined ? { params: input.params } : {}),
        actor: input.actor,
      },
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `browser-timeout: 主进程未在 ${this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms 内完成浏览器操作` });
      }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      try {
        this.transport.postMessage(request);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: "browser-unavailable: 主进程连接已关闭" });
      }
    });
  }

  dispose(): void {
    if (typeof this.transport.removeListener === "function") {
      this.transport.removeListener("message", this.onMessage);
    }
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, error: "browser-unavailable: 浏览器客户端已关闭" });
      this.pending.delete(id);
    }
  }

  private handleMessage(message: unknown): void {
    if (!isBrowserResponse(message)) return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    const response: BrowserResponse = message;
    entry.resolve(response.ok ? { ok: true, payload: response.payload } : { ok: false, error: response.error });
  }
}
