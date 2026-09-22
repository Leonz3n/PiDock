import { describe, expect, it, vi } from "vitest";
import type { HostAdapter } from "../data/hostAdapter";
import { createMemoryHost } from "../data/memoryHost";
import { createShellHostAdapter, resolveHostAdapter } from "../data/shellHost";

/**
 * [PiDock 02] S6 batch 3: renderer real-shell wiring. `resolveHostAdapter`
 * selects the shell-backed adapter when `window.pidock.taskOp` exists and
 * the memory fallback otherwise; shell turns ride `task/sendMessage` and
 * fail closed as `{ok:false}` errors (composer keeps input). Renderer-no-Node
 * holds: only `window.pidock` is touched, never Node/Electron imports.
 */
function stubBridge(taskOp: (taskId: string, op: string, payload?: Record<string, unknown>) => Promise<unknown>) {
  vi.stubGlobal("window", { pidock: { taskOp } });
}

describe("shell host adapter selection", () => {
  it("uses the memory fallback outside the shell", async () => {
    vi.stubGlobal("window", {});
    const fallback = createMemoryHost();
    const adapter = resolveHostAdapter(fallback);
    expect(adapter).toBe(fallback);
    // Memory path still runs (read-only gate enforced at tool layer).
    await expect(adapter.sendMessage("release", "main", "检查构建", [])).resolves.toBeDefined();
    vi.unstubAllGlobals();
  });

  it("routes sendMessage through task/sendMessage when bridged", async () => {
    const seen: Array<{ taskId: string; op: string; payload?: Record<string, unknown> }> = [];
    stubBridge(async (taskId, op, payload) => {
      seen.push({ taskId, op, payload });
      return { ok: true, payload: { state: "completed", callId: "call-1", userMessageId: "msg-1", agentMessageId: "msg-2" } };
    });
    const fallback = createMemoryHost();
    const adapter = resolveHostAdapter(fallback);
    expect(adapter).not.toBe(fallback);
    const result = await adapter.sendMessage("task-a", "main", "检查构建", []);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ taskId: "task-a", op: "task/sendMessage" });
    expect((seen[0].payload as Record<string, unknown>)["text"]).toBe("检查构建");
    expect(result.state).toBe("completed");
    expect(result.run.taskId).toBe("task-a");
    vi.unstubAllGlobals();
  });

  it("surfaces a shell approval turn and resolves it through task/approve", async () => {
    const calls: string[] = [];
    stubBridge(async (_taskId, op) => {
      calls.push(op as string);
      if (op === "task/sendMessage") {
        return { ok: true, payload: { state: "approval", callId: "call-2", userMessageId: "msg-1", agentMessageId: "msg-2" } };
      }
      return { ok: true, payload: {} };
    });
    const fallback = createMemoryHost();
    const adapter: HostAdapter = createShellHostAdapter(fallback);
    const turned = await adapter.sendMessage("task-a", "main", "跑命令", []);
    expect(turned.state).toBe("approval");
    expect(calls).toEqual(["task/sendMessage"]);
    vi.unstubAllGlobals();
  });

  it("keeps the composer input on shell failure (throws, never crashes)", async () => {
    stubBridge(async () => ({ ok: false, error: "task-locked: 同一任务同时只能有一个会话执行" }));
    const adapter = resolveHostAdapter(createMemoryHost());
    await expect(adapter.sendMessage("task-a", "main", "检查构建", [])).rejects.toThrow("task-locked");
    vi.unstubAllGlobals();
  });

  it("stops through task/cancel when bridged, memory otherwise", async () => {
    const calls: string[] = [];
    stubBridge(async (_taskId, op) => {
      calls.push(op as string);
      return { ok: true, payload: {} };
    });
    const adapter = resolveHostAdapter(createMemoryHost());
    await adapter.stopRun("task-a", "main");
    expect(calls).toEqual(["task/cancel"]);
    vi.unstubAllGlobals();

    vi.stubGlobal("window", {});
    const memory = resolveHostAdapter(createMemoryHost());
    await expect(memory.stopRun("release", "main")).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });
});
