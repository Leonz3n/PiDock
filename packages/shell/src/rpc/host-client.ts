import type { UtilityProcess } from "electron";
import {
  isBrowserRequest,
  isRpcResponse,
  type BrowserPerformResult,
  type BrowserRequest,
  type BrowserRequestParams,
  type BrowserResponse,
  type HostPingResult,
  type HostTaskParams,
  type HostTaskResult,
  type HostVersionsResult,
  type RequestMethod,
  type RequestParams,
  type RpcRequest,
} from "./protocol.js";

export type { RpcRequest };

/** Minimal post surface shared by UtilityProcess (main side). */
export interface HostTransport {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): void;
  removeListener?(event: "message", listener: (message: unknown) => void): void;
}

export interface HostClientOptions {
  /** Per-call timeout in ms. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

let nextId = 1;

/**
 * Typed RPC client to the utilityProcess Node Host. Fails closed on
 * malformed responses; concurrent calls are multiplexed by request id.
 */
export class HostClient {
  private readonly pending = new Map<
    string,
    {
      resolve: (value: HostPingResult | HostVersionsResult | HostTaskResult) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly onMessage = (message: unknown): void => {
    this.handleMessage(message);
  };
  private browserHandler:
    | ((params: BrowserRequestParams) => Promise<BrowserPerformResult>)
    | undefined;

  constructor(private readonly transport: HostTransport | UtilityProcess) {
    this.transport.on("message", this.onMessage);
  }

  /**
   * Handles Host -> main browser requests ([PiDock 06] #8). main owns the
   * visible page, so the Host asks for one already-gated action and main
   * validates the page handle, allowlist and takeover state before acting.
   * Without a handler every request fails closed.
   */
  onBrowserRequest(
    handler: (params: BrowserRequestParams) => Promise<BrowserPerformResult>,
  ): void {
    this.browserHandler = handler;
  }

  private handleMessage(data: unknown): void {
    if (isBrowserRequest(data)) {
      void this.handleBrowserRequest(data);
      return;
    }
    if (!isRpcResponse(data)) return;
    const entry = this.pending.get(data.id);
    if (!entry) return;
    this.pending.delete(data.id);
    clearTimeout(entry.timer);
    if (data.ok) {
      entry.resolve(data.payload);
    } else {
      entry.reject(new Error(data.error));
    }
  }

  private async handleBrowserRequest(request: BrowserRequest): Promise<void> {
    const handler = this.browserHandler;
    const result: BrowserPerformResult = handler
      ? await handler(request.params)
      : { ok: false, error: "browser-unavailable: 主进程未挂载任务浏览器能力" };
    const response: BrowserResponse = result.ok
      ? { kind: "browser-response", id: request.id, ok: true, payload: result.payload }
      : { kind: "browser-response", id: request.id, ok: false, error: result.error };
    try {
      this.transport.postMessage(response);
    } catch {
      // The Host process is gone; nothing left to answer.
    }
  }

  private call<M extends RequestMethod>(
    method: M,
    params: RequestParams,
    options?: HostClientOptions,
  ): Promise<HostPingResult | HostVersionsResult | HostTaskResult> {
    const id = `rpc-${nextId++}`;
    const request: RpcRequest = { kind: "request", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`host RPC timeout: ${method}`));
      }, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.postMessage(request);
    });
  }

  ping(
    params: { workspaceId?: string } = {},
    options?: HostClientOptions,
  ): Promise<HostPingResult> {
    return this.call("host/ping", params, options) as Promise<HostPingResult>;
  }

  getVersions(
    params: { workspaceId?: string } = {},
    options?: HostClientOptions,
  ): Promise<HostVersionsResult> {
    return this.call("host/getVersions", params, options) as Promise<HostVersionsResult>;
  }

  /**
   * Task-routed call into one task workspace Host. Main binds workspaceId
   * and taskId from the trusted sender; the renderer never chooses them.
   */
  task(
    params: HostTaskParams,
    options?: HostClientOptions,
  ): Promise<HostTaskResult> {
    return this.call("host/task", params, options) as Promise<HostTaskResult>;
  }

  dispose(): void {
    if (typeof this.transport.removeListener === "function") {
      this.transport.removeListener("message", this.onMessage);
    }
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("host client disposed"));
      this.pending.delete(id);
    }
  }
}
