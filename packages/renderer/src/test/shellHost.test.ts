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

  it("maps the real Host vocab (done->completed, cancelled->stopped) and forwards refs", async () => {
    const seen: Array<{ taskId: string; op: string; payload?: Record<string, unknown> }> = [];
    stubBridge(async (taskId, op, payload) => {
      seen.push({ taskId, op, payload });
      return { ok: true, payload: { state: "done", callId: "call-1", userMessageId: "msg-1", agentMessageId: "msg-2" } };
    });
    const fallback = createMemoryHost();
    const adapter = resolveHostAdapter(fallback);
    expect(adapter).not.toBe(fallback);
    const result = await adapter.sendMessage("task-a", "main", "检查构建", [
      { id: "ref-1", kind: "file", label: "a.ts", detail: "task" },
      { id: "skill-review", kind: "skill", label: "review", detail: "skill" },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ taskId: "task-a", op: "task/sendMessage" });
    expect((seen[0].payload as Record<string, unknown>)["text"]).toBe("检查构建");
    expect((seen[0].payload as Record<string, unknown>)["skillSource"]).toBe("skill-review");
    expect(((seen[0].payload as Record<string, unknown>)["references"] as unknown[])).toHaveLength(2);
    expect(result.state).toBe("completed");
    expect(result.run.taskId).toBe("task-a");
    vi.unstubAllGlobals();

    stubBridge(async () => ({ ok: true, payload: { state: "cancelled", callId: "call-9" } }));
    const stopped = await resolveHostAdapter(createMemoryHost()).sendMessage("task-a", "main", "停", []);
    expect(stopped.state).toBe("stopped");
    vi.unstubAllGlobals();
  });

  it("surfaces a shell approval turn and resolves it by (taskId,sessionId,approvalId)", async () => {
    const seen: Array<{ taskId: string; op: string; payload?: Record<string, unknown> }> = [];
    stubBridge(async (taskId, op, payload) => {
      seen.push({ taskId, op, payload });
      if (op === "task/sendMessage") {
        return {
          ok: true,
          payload: {
            state: "approval",
            callId: "call-2",
            approvalId: "approval-7",
            tool: "exec.run",
            target: "/tmp/task-abcdef12/run.sh",
            userMessageId: "msg-1",
            agentMessageId: "msg-2",
          },
        };
      }
      // Host listing read (empty here — the synthetic pending approval
      // merges underneath); resolve still rides `task/approve` by id.
      if (op === "task/listApprovals") {
        return { ok: true, payload: { approvals: [] } };
      }
      return { ok: true, payload: {} };
    });
    const fallback = createMemoryHost();
    const adapter: HostAdapter = createShellHostAdapter(fallback);
    const turned = await adapter.sendMessage("task-a", "main", "跑命令", []);
    expect(turned.state).toBe("approval");
    expect(turned.approvalId).toBe("approval-7");
    // The synthetic approval shows what awaits approval (`tool target`),
    // threaded from the Host turn payload rather than a generic label.
    expect(await adapter.getApproval("approval-7")).toMatchObject({
      id: "approval-7",
      taskId: "task-a",
      sessionId: "main",
      title: "exec.run /tmp/task-abcdef12/run.sh",
    });
    expect(await adapter.listApprovals("task-a")).toHaveLength(1);
    const resolved = await adapter.resolveApproval("approval-7", "approved");
    expect(resolved.status).toBe("approved");
    // `listApprovals` rides the Host (`task/listApprovals`) before resolve,
    // so the stub sees it ahead of `task/approve`; the resolve payload
    // itself stays (taskId,sessionId,approvalId).
    expect(seen.map((entry) => entry.op)).toEqual(["task/sendMessage", "task/listApprovals", "task/approve"]);
    expect((seen[2].payload as Record<string, unknown>)).toMatchObject({ sessionId: "main", approvalId: "approval-7" });
    vi.unstubAllGlobals();
  });

  it("uses a partial bridge (no taskOp) as memory, not shell", async () => {
    vi.stubGlobal("window", { pidock: { getVersions: async () => ({}) } });
    const fallback = createMemoryHost();
    expect(resolveHostAdapter(fallback)).toBe(fallback);
    vi.unstubAllGlobals();
  });

  it("resolves a Host-only approval listed without a prior sendMessage", async () => {
    const seen: Array<{ taskId: string; op: string; payload?: Record<string, unknown> }> = [];
    stubBridge(async (taskId, op, payload) => {
      seen.push({ taskId, op, payload });
      if (op === "task/listApprovals") {
        return {
          ok: true,
          payload: {
            approvals: [
              { id: "approval-9", sessionId: "other", tool: "exec.run", target: "/tmp/task-abcdef12/other.sh", status: "pending", executed: false },
            ],
          },
        };
      }
      if (op === "task/getApproval") {
        return {
          ok: true,
          payload: {
            approval: { id: "approval-9", sessionId: "other", tool: "exec.run", target: "/tmp/task-abcdef12/other.sh", status: "pending", executed: false },
          },
        };
      }
      return { ok: true, payload: {} };
    });
    const adapter = resolveHostAdapter(createMemoryHost());
    // No sendMessage in this tab: the approval is Host-only (other tab).
    const listed = await adapter.listApprovals("task-a");
    expect(listed.some((approval) => approval.id === "approval-9")).toBe(true);
    const resolved = await adapter.resolveApproval("approval-9", "approved");
    expect(resolved).toMatchObject({ id: "approval-9", taskId: "task-a", sessionId: "other", status: "approved", executed: true });
    // P1: listed resolve must return a full `Approval`, not a 3-field stub.
    expect(resolved.title).toBe("exec.run /tmp/task-abcdef12/other.sh");
    expect(resolved.command).toBe("exec.run /tmp/task-abcdef12/other.sh");
    expect(resolved.payloadVersion).toBe("v1");
    expect(typeof resolved.requestedAt).toBe("string");
    expect(typeof resolved.expiresAt).toBe("string");
    expect(Date.parse(resolved.expiresAt)).toBeGreaterThan(Date.parse(resolved.requestedAt));
    expect(seen.map((entry) => entry.op)).toContain("task/approve");
    expect(seen.find((entry) => entry.op === "task/approve")?.payload).toMatchObject({ sessionId: "other", approvalId: "approval-9" });
    vi.unstubAllGlobals();
  });

  it("falls through to memory when the bridge rejects (never-throw reads)", async () => {
    stubBridge(async (_taskId, op) => {
      if (op === "task/listApprovals" || op === "task/getApproval") throw new Error("transport down");
      return { ok: true, payload: {} };
    });
    const adapter = resolveHostAdapter(createMemoryHost());
    await expect(adapter.listApprovals("task-a")).resolves.toBeDefined();
    await expect(adapter.getApproval("missing-id")).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("lists bridged approvals through task/listApprovals (Host round-trip)", async () => {
    const seen: Array<{ taskId: string; op: string; payload?: Record<string, unknown> }> = [];
    stubBridge(async (taskId, op, payload) => {
      seen.push({ taskId, op, payload });
      if (op === "task/listApprovals") {
        return {
          ok: true,
          payload: {
            approvals: [
              { id: "approval-7", sessionId: "main", tool: "exec.run", target: "/tmp/task-abcdef12/run.sh", status: "pending", executed: false },
            ],
          },
        };
      }
      if (op === "task/getApproval") {
        return {
          ok: true,
          payload: {
            approval: { id: "approval-7", sessionId: "main", tool: "exec.run", target: "/tmp/task-abcdef12/run.sh", status: "pending", executed: false },
          },
        };
      }
      return { ok: true, payload: {} };
    });
    const adapter = resolveHostAdapter(createMemoryHost());
    const listed = await adapter.listApprovals("task-a");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: "approval-7", taskId: "task-a", sessionId: "main", title: "exec.run /tmp/task-abcdef12/run.sh" });
    expect(await adapter.getApproval("approval-7")).toMatchObject({ id: "approval-7", taskId: "task-a" });
    expect(seen.map((entry) => entry.op)).toEqual(["task/listApprovals", "task/getApproval"]);
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
