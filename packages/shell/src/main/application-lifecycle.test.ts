import { EventEmitter } from "node:events";
import type { App, BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
import { registerApplicationLifecycle } from "./application-lifecycle.js";
import { createHostDisposer, createHostStopper, PerTaskHostRegistry } from "./runtime.js";
import { HostClient } from "../rpc/host-client.js";
import type { RpcRequest } from "../rpc/protocol.js";

// Public seam: Electron's app/window events and observable window/quit effects.
// These boundary doubles do not establish native browser or SDK continuity.
function fixture(platform = "darwin", stopHosts = vi.fn(async () => true), destroyed = false) {
  const appEvents = new EventEmitter(), windowEvents = new EventEmitter();
  const state = { visible: true, minimized: false, destroyed, focused: false, quits: 0 };
  const window = Object.assign(windowEvents, {
    isDestroyed: () => state.destroyed,
    isMinimized: () => state.minimized,
    hide: () => { state.visible = false; },
    show: () => { state.visible = true; },
    focus: () => { state.focused = true; },
    restore: () => { state.minimized = false; },
  });
  function close() {
    const event = { preventDefault: vi.fn() };
    windowEvents.emit("close", event);
    if (!event.preventDefault.mock.calls.length) {
      state.destroyed = true; state.visible = false;
      windowEvents.emit("closed"); appEvents.emit("window-all-closed");
    }
    return event;
  }
  function quit() {
    const event = { preventDefault: vi.fn() };
    appEvents.emit("before-quit", event);
    if (!event.preventDefault.mock.calls.length) { state.quits++; close(); }
    return event;
  }
  const app = Object.assign(appEvents, { quit });
  registerApplicationLifecycle({ app: app as unknown as App, window: window as unknown as BrowserWindow, platform, stopHosts });
  return { appEvents, windowEvents, state, stopHosts, close, quit };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settled() {
  // Event listeners intentionally do not return the shutdown Promise.
  for (let index = 0; index < 10; index++) await Promise.resolve();
}

describe("application window lifecycle", () => {
  it("refuses installation after the initial window was destroyed instead of silently claiming startup recovery", () => {
    const stop = vi.fn(async () => true);
    expect(() => fixture("darwin", stop, true)).toThrow("application-window-unavailable");
    expect(stop).not.toHaveBeenCalled();
  });

  it("keeps the macOS window and execution alive on close, then reopens that window from the Dock", async () => {
    const f = fixture();
    f.close(); await settled();
    expect(f.state).toMatchObject({ visible: false, destroyed: false, quits: 0 });
    expect(f.stopHosts).not.toHaveBeenCalled();
    f.state.minimized = true;
    f.appEvents.emit("activate");
    expect(f.state).toMatchObject({ visible: true, minimized: false, focused: true, destroyed: false, quits: 0 });
    expect(f.stopHosts).not.toHaveBeenCalled();
  });

  it("reveals the macOS window after refused shutdown while preserving retained Hosts and sealed admission", async () => {
    const messages = new EventEmitter(), kill = vi.fn();
    let quitRequests = 0;
    const client = new HostClient({
      on: (event, listener) => { messages.on(event, listener); },
      removeListener: (event, listener) => { messages.removeListener(event, listener); },
      postMessage: (raw) => {
        const request = raw as RpcRequest;
        const params = request.params as { taskId: string; op: string };
        if (params.op === "task/quit") {
          quitRequests++;
          messages.emit("message", { kind: "response", id: request.id, ok: false, error: "synthetic-shutdown-unconfirmed" });
        } else {
          messages.emit("message", { kind: "response", id: request.id, ok: true,
            payload: { workspaceId: "workspace-a", taskId: params.taskId, op: params.op, payload: {} } });
        }
      },
    });
    const registry = new PerTaskHostRegistry("workspace-a", async () => ({ client, child: Object.assign(new EventEmitter(), { kill }) as never }), () => "/tasks/a");
    await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} });
    const stop = createHostStopper(registry, { kind: "shell-ui", senderWebContentsId: 7 }, () => registry.disposeAll());
    const stopped = deferred<void>();
    const f = fixture("darwin", vi.fn(async () => {
      const result = await stop();
      stopped.resolve();
      return result;
    }));
    f.close(); f.state.minimized = true; f.quit();
    await stopped.promise; await settled();
    expect(f.state).toMatchObject({ visible: true, minimized: false, focused: true, destroyed: false, quits: 0 });
    expect(registry.activeTaskIds()).toEqual(["task-a"]);
    expect(kill).not.toHaveBeenCalled();
    expect(messages.listenerCount("message")).toBe(1);
    f.appEvents.emit("activate");
    await expect(registry.routeTaskOp({ taskId: "task-a", op: "task/cancel", payload: {} })).rejects.toThrow("task-host-closing");
    expect(await stop()).toBe(false);
    expect(quitRequests).toBe(1);
    expect(kill).not.toHaveBeenCalled();
    client.dispose();
  });

  it("keeps application quit pending through every delayed registry child exit", async () => {
    const children = [new EventEmitter(), new EventEmitter()].map((events) => Object.assign(events, { kill: vi.fn() }));
    const registry = new PerTaskHostRegistry("workspace-a", async (_ws, task) => ({
      child: children[task.taskId === "task-a" ? 0 : 1] as never,
      client: { onBrowserRequest: vi.fn(), dispose: vi.fn(), task: vi.fn(async () => ({
        workspaceId: "workspace-a", taskId: task.taskId, op: "task/quit",
        payload: { quit: { applied: [], plan: { failures: [], retainedTasks: [] } } },
      })) } as never,
    }), (id) => `/tasks/${id}`);
    await registry.routeTaskOp({ taskId: "task-a", op: "task/cancel" });
    await registry.routeTaskOp({ taskId: "task-b", op: "task/cancel" });
    const stop = createHostStopper(registry, { kind: "shell-ui", senderWebContentsId: 7 }, () => registry.disposeAll());
    const f = fixture("darwin", vi.fn(stop));
    f.quit(); f.quit(); await new Promise<void>((done) => setImmediate(done));
    expect(f.state.quits).toBe(0); expect(registry.size).toBe(2);
    children[0].emit("exit", 0); await settled();
    expect(f.state.quits).toBe(0); expect(registry.size).toBe(2);
    children[1].emit("exit", 0); await stop(); await settled();
    expect(f.state.quits).toBe(1); expect(registry.size).toBe(0);
    for (const child of children) expect(child.kill).toHaveBeenCalledTimes(1);
  });
  it("awaits delayed workspace exit through the production disposal callback before application quit", async () => {
    const workspace = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const disposal = createHostDisposer(workspace as never);
    const registry = new PerTaskHostRegistry("workspace-a");
    const client = { dispose: vi.fn() }, stopSchedules = vi.fn();
    const stop = createHostStopper(registry, { kind: "shell-ui", senderWebContentsId: 7 },
      () => disposal.disposeAfterTasks(registry, client, stopSchedules));
    const f = fixture("darwin", vi.fn(stop));
    f.quit(); f.quit(); await new Promise<void>((done) => setImmediate(done));
    const receipt = stop();
    expect(f.state.quits).toBe(0); expect(workspace.kill).toHaveBeenCalledTimes(1);
    const disposed = disposal.disposeAfterTasks(registry, client, stopSchedules);
    expect(disposal.disposeAfterTasks(registry, client, stopSchedules)).toBe(disposed);
    expect(stop()).toBe(receipt);
    workspace.emit("exit", 0); await disposed; expect(await receipt).toBe(true); await settled();
    expect(f.state.quits).toBe(1);
    expect(workspace.kill).toHaveBeenCalledTimes(1); expect(client.dispose).toHaveBeenCalledTimes(1);
    expect(stopSchedules).toHaveBeenCalledTimes(1); expect(await stop()).toBe(true);
  });
  it.each(["timeout", "signal failure"])("retains workspace %s without another termination request or late-exit success", async (fault) => {
    const workspace = Object.assign(new EventEmitter(), { kill: vi.fn(() => {
      if (fault === "signal failure") throw Error("synthetic-signal-failure");
    }) });
    const disposal = createHostDisposer(workspace as never);
    const registry = new PerTaskHostRegistry("workspace-a");
    const client = { dispose: vi.fn() }, stopSchedules = vi.fn();
    const stop = createHostStopper(registry, { kind: "shell-ui", senderWebContentsId: 7 },
      () => disposal.disposeAfterTasks(registry, client, stopSchedules));
    const f = fixture("darwin", vi.fn(stop));
    vi.useFakeTimers();
    try {
      f.quit();
      const receipt = stop();
      await vi.advanceTimersByTimeAsync(14_999);
      expect(f.state.quits).toBe(0); expect(workspace.kill).toHaveBeenCalledTimes(1);
      expect(stop()).toBe(receipt);
      const disposed = disposal.disposeAfterTasks(registry, client, stopSchedules);
      const rejected = expect(disposed).rejects.toThrow(fault === "timeout" ? "main-workspace-disposal-unconfirmed" : "synthetic-signal-failure");
      await vi.advanceTimersByTimeAsync(1); await rejected;
      expect(await receipt).toBe(false); expect(f.state.quits).toBe(0);
      workspace.emit("exit", 0); await settled();
      expect(await stop()).toBe(false); expect(stop()).toBe(receipt);
      expect(disposal.disposeAfterTasks(registry, client, stopSchedules)).toBe(disposed);
      f.quit(); await settled(); expect(f.state.quits).toBe(0);
      expect(workspace.kill).toHaveBeenCalledTimes(1); expect(client.dispose).toHaveBeenCalledTimes(1);
      expect(stopSchedules).toHaveBeenCalledTimes(1);
    } finally { workspace.emit("exit", 0); vi.useRealTimers(); }
  });
  it("retains and reveals the existing window when shutdown throws, with no automatic retry", async () => {
    const stop = vi.fn(async () => { throw Error("synthetic-stop-failure"); });
    const f = fixture("darwin", stop);
    f.close(); f.state.minimized = true; f.quit();
    await settled();
    expect(f.state).toMatchObject({ visible: true, focused: true, minimized: false, destroyed: false, quits: 0 });
    f.appEvents.emit("activate"); await settled();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it.each(["win32", "linux"])("keeps %s last-window shutdown ordered without claiming Dock background reentry", async (platform) => {
    const receipt = deferred<boolean>(), stop = vi.fn(() => receipt.promise), f = fixture(platform, stop);
    f.appEvents.emit("activate");
    expect(f.state.focused).toBe(false);
    f.close(); await settled();
    expect(f.state).toMatchObject({ destroyed: true, quits: 0 });
    expect(stop).toHaveBeenCalledTimes(1);
    receipt.resolve(true); await settled();
    expect(f.state.quits).toBe(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does not revive an unexpectedly destroyed macOS window on activation or failed quit", async () => {
    const f = fixture("darwin", vi.fn(async () => false));
    f.state.destroyed = true; f.state.visible = false; f.state.minimized = true;
    f.appEvents.emit("activate"); f.quit(); await settled();
    expect(f.state).toMatchObject({ destroyed: true, visible: false, minimized: true, focused: false, quits: 0 });
    expect(f.stopHosts).toHaveBeenCalledTimes(1);
  });

  it("waits for one owned shutdown before final quit and prevents close or Dock reentry while pending", async () => {
    const receipt = deferred<boolean>();
    const stop = vi.fn(() => receipt.promise), f = fixture("darwin", stop);
    f.close();
    f.quit(); f.quit();
    f.close(); f.appEvents.emit("activate");
    await settled();
    expect(f.state).toMatchObject({ visible: false, destroyed: false, quits: 0 });
    expect(stop).toHaveBeenCalledTimes(1);
    receipt.resolve(true); await settled();
    expect(f.state).toMatchObject({ destroyed: true, quits: 1 });
    expect(stop).toHaveBeenCalledTimes(1);
    f.appEvents.emit("activate");
    expect(f.state.visible).toBe(false);
  });
});
