import { describe, expect, it, vi } from "vitest";
import { HostClient } from "./host-client.js";
import { HostBrowserClient } from "./browser-client.js";
import type { HostTransport } from "./host-client.js";

// Seam: [PiDock 06] (#8) Host <-> main browser transport. main's
// `HostClient` answers Host-initiated `browser-request` envelopes on the
// same parent port `host/*` RPC uses; the Host's `HostBrowserClient`
// correlates the response and fails closed without a handler.

function pair() {
  const mainListeners = new Set<(message: unknown) => void>();
  const hostListeners = new Set<(message: unknown) => void>();
  const main: HostTransport = {
    postMessage: (message) => hostListeners.forEach((listener) => listener(message)),
    on: (_event, listener) => {
      mainListeners.add(listener);
    },
    removeListener: (_event, listener) => {
      mainListeners.delete(listener);
    },
  };
  const host: HostTransport = {
    postMessage: (message) => mainListeners.forEach((listener) => listener(message)),
    on: (_event, listener) => {
      hostListeners.add(listener);
    },
    removeListener: (_event, listener) => {
      hostListeners.delete(listener);
    },
  };
  return { main, host };
}

describe("host browser transport", () => {
  it("round-trips a browser request through main's handler", async () => {
    const { main, host } = pair();
    const client = new HostClient(main);
    const seen: unknown[] = [];
    client.onBrowserRequest(async (params) => {
      seen.push(params);
      return { ok: true, payload: { action: params.action, taskId: params.taskId } };
    });
    const browser = new HostBrowserClient(host, "ws-a");
    const result = await browser.perform({
      taskId: "task-a1f92c3d",
      action: "page/state",
      page: { pageId: "page-1" },
      actor: { kind: "agent", sessionId: "main" },
    });
    expect(result).toEqual({ ok: true, payload: { action: "page/state", taskId: "task-a1f92c3d" } });
    expect(seen[0]).toMatchObject({ workspaceId: "ws-a", taskId: "task-a1f92c3d", action: "page/state", actor: { kind: "agent" } });
  });

  it("returns main's refusal verbatim instead of acting", async () => {
    const { main, host } = pair();
    const client = new HostClient(main);
    client.onBrowserRequest(async () => ({ ok: false, error: "takeover-paused: 用户正在接管页面" }));
    const browser = new HostBrowserClient(host, "ws-a");
    const result = await browser.perform({ taskId: "task-a1f92c3d", action: "page/reload", actor: { kind: "human", label: "用户" } });
    expect(result).toEqual({ ok: false, error: "takeover-paused: 用户正在接管页面" });
  });

  it("answers a throwing handler with a refusal envelope instead of making the Host wait", async () => {
    const { main, host } = pair();
    const client = new HostClient(main);
    client.onBrowserRequest(async () => {
      throw new Error("debugger detached");
    });
    // A short Host-side timeout would surface as `browser-timeout` if main
    // let the rejection escape without answering ([#8] review P1-2).
    const browser = new HostBrowserClient(host, "ws-a", { timeoutMs: 200 });
    const result = await browser.perform({
      taskId: "task-a1f92c3d",
      action: "page/state",
      page: { pageId: "page-1" },
      actor: { kind: "agent", sessionId: "main" },
    });
    expect(result).toEqual({ ok: false, error: "browser-failed: debugger detached" });
  });

  it("fails closed when main has no browser capability mounted", async () => {
    const { main, host } = pair();
    // HostClient listens (so the port is live) but registers no handler.
    new HostClient(main);
    const browser = new HostBrowserClient(host, "ws-a");
    const result = await browser.perform({ taskId: "task-a1f92c3d", action: "page/state", actor: { kind: "human", label: "用户" } });
    expect(result).toMatchObject({ error: expect.stringContaining("browser-unavailable") });
  });

  it("ignores malformed envelopes and unrelated rpc responses", async () => {
    const { main, host } = pair();
    const client = new HostClient(main);
    const handler = vi.fn(async () => ({ ok: true as const, payload: {} }));
    client.onBrowserRequest(handler);
    const browser = new HostBrowserClient(host, "ws-a", { timeoutMs: 30 });
    // Rejected by the envelope guard (no `params`) and by not being a
    // browser response at all: neither may reach the handler or complete
    // the real call below.
    main.postMessage({ kind: "browser-request", id: "browser-1" });
    main.postMessage({ kind: "response", id: "rpc-1", ok: true, payload: { pong: true, workspaceId: "ws-a", hostTime: 1 } });
    const result = await browser.perform({ taskId: "task-a1f92c3d", action: "page/state", actor: { kind: "human", label: "用户" } });
    expect(result).toEqual({ ok: true, payload: {} });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ workspaceId: "ws-a", action: "page/state" });
  });

  it("stops waiting when the client is disposed", async () => {
    const { main, host } = pair();
    const client = new HostClient(main);
    client.onBrowserRequest(async () => new Promise<never>(() => {}));
    const browser = new HostBrowserClient(host, "ws-a", { timeoutMs: 5000 });
    const pending = browser.perform({ taskId: "task-a1f92c3d", action: "page/state", actor: { kind: "human", label: "用户" } });
    browser.dispose();
    expect(await pending).toMatchObject({ error: expect.stringContaining("browser-unavailable") });
  });
});
