import type { UtilityProcess } from "electron";
import {
  isRpcResponse,
  type HostPingResult,
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
      resolve: (value: HostPingResult | HostVersionsResult) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly onMessage = (message: unknown): void => {
    this.handleMessage(message);
  };

  constructor(private readonly transport: HostTransport | UtilityProcess) {
    this.transport.on("message", this.onMessage);
  }

  private handleMessage(data: unknown): void {
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

  private call<M extends RequestMethod>(
    method: M,
    params: RequestParams,
    options?: HostClientOptions,
  ): Promise<HostPingResult | HostVersionsResult> {
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
