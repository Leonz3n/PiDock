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

  it("routes Host-known service start/stop through task/controlService (human path)", async () => {
    const seen: Array<{ taskId: string; op: string; payload?: Record<string, unknown> }> = [];
    stubBridge(async (taskId, op, payload) => {
      seen.push({ taskId, op, payload });
      if (op === "task/serviceStatus") return { ok: true, payload: { service: { serviceId: "saas-web" } } };
      return { ok: true, payload: {} };
    });
    const adapter = resolveHostAdapter(createMemoryHost());
    await adapter.setServiceRunning("task-a", "saas-web", true);
    await adapter.setServiceRunning("task-a", "saas-web", false);
    expect(seen.map((entry) => entry.op)).toEqual([
      "task/serviceStatus",
      "task/controlService",
      "task/serviceStatus",
      "task/controlService",
    ]);
    // No sessionId: the Host classifies this as the attested human-UI path.
    expect(seen[1].payload).toMatchObject({ serviceId: "saas-web", action: "start" });
    expect(seen[1].payload?.["sessionId"]).toBeUndefined();
    expect(seen[3].payload).toMatchObject({ serviceId: "saas-web", action: "stop" });
    vi.unstubAllGlobals();

    // A failed Host control surfaces instead of silently succeeding.
    stubBridge(async (_taskId, op) => {
      if (op === "task/serviceStatus") return { ok: true, payload: { service: { serviceId: "saas-web" } } };
      return { ok: false, error: "permission-denied: 无会话的界面操作需要受信任来源，已拒绝" };
    });
    await expect(resolveHostAdapter(createMemoryHost()).setServiceRunning("task-a", "saas-web", true)).rejects.toThrow("permission-denied");
    vi.unstubAllGlobals();
  });

  it("keeps unregistered services on the memory fallback", async () => {
    const ops: string[] = [];
    stubBridge(async (_taskId, op) => {
      ops.push(op as string);
      return { ok: false, error: "unknown-service: saas-web is not registered on this task" };
    });
    const memoryCalls: string[] = [];
    const fallback = {
      setServiceRunning: async (taskId: string, serviceId: string, running: boolean) => {
        memoryCalls.push(`${taskId}:${serviceId}:${running}`);
      },
    } as unknown as HostAdapter;
    await createShellHostAdapter(fallback).setServiceRunning("task-a", "saas-web", true);
    // Only the probe ran; the renderer has no service-registration path yet,
    // so the memory mirror keeps the dev/demo service toggles working.
    expect(ops).toEqual(["task/serviceStatus"]);
    expect(memoryCalls).toEqual(["task-a:saas-web:true"]);
    vi.unstubAllGlobals();
  });

  it("prefers the Host plan and run records for the topology view", async () => {
    const ops: string[] = [];
    stubBridge(async (_taskId, op) => {
      ops.push(op as string);
      if (op === "task/planServiceGroup") {
        return {
          ok: true,
          payload: {
            plan: {
              assignments: [{ unitId: "front-monorepo:saas-web", serviceId: "saas-web", port: 6100, instanceId: "task-a/saas-web" }],
              reallocated: [{ unitId: "front-monorepo:saas-web", before: 5173, after: 6100 }],
              groups: [{ groupId: "prestart", members: ["task:db-migrate"], reason: "prestart", bidirectional: false, verify: [] }],
              diagnostics: [{ code: "port-taken", message: "端口 5173 已被占用", hint: "会重分配" }],
              knownLimits: ["共享队列"],
            },
          },
        };
      }
      if (op === "task/serviceRunRecords") {
        return {
          ok: true,
          payload: {
            records: [
              {
                runId: "run-9",
                // The Host records the id the renderer registered.
                serviceId: "release-service-1",
                templateVersion: "v13",
                codeState: { kind: "uncommitted" },
                buildFreshness: "uncommitted-code",
                ports: [6100],
                processIdentity: { owner: "human", pid: 777, startedAt: "2026-09-22T10:00:00.000Z" },
                logRef: "/tasks/task-a/services/saas-web/run-run-9.log",
                startedAt: "2026-09-22T10:00:00.000Z",
              },
            ],
          },
        };
      }
      return { ok: true, payload: {} };
    });
    try {
      const adapter = resolveHostAdapter(createMemoryHost());
      const view = await adapter.serviceTopology("release");
      expect(ops).toEqual(["task/planServiceGroup", "task/serviceRunRecords"]);
      // Host ports and plan structures win over the memory projection.
      expect(
        view.routing.find((entry) => entry.unitId === "front-monorepo:saas-web" && entry.key === "PORT")?.target,
      ).toMatchObject({
        kind: "local-instance",
        port: 6100,
        address: "release/release-service-1@6100",
      });
      expect(view.groups[0]).toMatchObject({ groupId: "prestart", members: ["task:db-migrate"] });
      expect(view.diagnostics[0]).toMatchObject({ code: "port-taken" });
      expect(view.knownLimits).toEqual(["共享队列"]);
      expect(view.records.find((entry) => entry.serviceId === "release-service-1")?.run).toMatchObject({
        runId: "run-9",
        buildFreshness: "uncommitted-code",
        processIdentity: { owner: "human", pid: 777 },
        logRef: "/tasks/task-a/services/saas-web/run-run-9.log",
      });
      // A Host refusal keeps the memory view (fail-open read, never throw).
      stubBridge(async (_taskId, op) => (op === "task/planServiceGroup" ? { ok: false, error: "task-unbound" } : { ok: false, error: "task-unbound" }));
      const fallbackView = await resolveHostAdapter(createMemoryHost()).serviceTopology("release");
      expect(fallbackView.groups.length).toBeGreaterThan(0);
      expect(fallbackView.records.some((entry) => entry.run?.simulated === true)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("asks for no port for a prepare step and labels the plan with the environment name", async () => {
    const seen: Array<{ op: string; payload: Record<string, unknown> }> = [];
    stubBridge(async (_taskId, op, payload) => {
      seen.push({ op: op as string, payload: (payload ?? {}) as Record<string, unknown> });
      if (op === "task/planServiceGroup") {
        return {
          ok: true,
          payload: { plan: { assignments: [], reallocated: [], groups: [{ groupId: "prestart", members: ["task:db-migrate"], reason: "prestart", bidirectional: false, verify: [] }], diagnostics: [], knownLimits: [] } },
        };
      }
      return { ok: true, payload: {} };
    });
    try {
      const view = await resolveHostAdapter(createMemoryHost()).serviceTopology("release");
      const request = seen.find((entry) => entry.op === "task/planServiceGroup")?.payload;
      const units = request?.["units"] as Array<Record<string, unknown>>;
      // The seeded `db-migrate` row is local/prepare without a preferred port;
      // sending a port for it would make the Host plan fail `missing-port`.
      expect(units.find((unit) => unit["unitId"] === "invoice-service:db-migrate")).toMatchObject({ location: "local", runType: "prepare" });
      const requests = request?.["requests"] as Array<{ unitId: string; port: number }>;
      expect(requests.some((entry) => entry.unitId === "invoice-service:db-migrate")).toBe(false);
      // The environment label is the display name ("测试环境"), not the task id.
      expect(request?.["environment"]).toBe("测试环境");
      // With a successful plan the Host's groups win over the memory projection.
      expect(view.groups[0]).toMatchObject({ groupId: "prestart", members: ["task:db-migrate"] });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("[PiDock 12] reads usage from the Host ledger and falls back per task when it cannot answer", async () => {
    const seen: Array<{ taskId: string; op: string; payload?: Record<string, unknown> }> = [];
    stubBridge(async (taskId, op, payload) => {
      seen.push({ taskId, op, payload });
      if (op === "task/usageRecords" && taskId === "release") {
        return {
          ok: true,
          payload: {
            report: {
              details: [
                {
                  id: "call-1",
                  taskId: "release",
                  sessionId: "main",
                  providerId: "provider-local",
                  providerVersion: "openai-responses::https://a.example.com::gpt-5",
                  requestModel: "gpt-5",
                  responseModel: "gpt-5-2026-08",
                  kind: "turn",
                  endState: "completed",
                  at: "2026-09-22T10:00:00+08:00",
                  usage: { input: 100, output: 40, cacheRead: 10, cacheWrite: 5, source: "actual", completeness: "reported", reasoning: 12 },
                },
                // A half-shaped detail must be dropped, never shown as zeros.
                { id: "call-broken", taskId: "release", sessionId: "main" },
              ],
            },
          },
        };
      }
      return { ok: true, payload: {} };
    });
    try {
      const adapter = resolveHostAdapter(createMemoryHost());
      const rows = await adapter.getUsage({ taskId: "release", sessionId: "main" });
      expect(rows.map((row) => row.id)).toEqual(["call-1"]);
      expect(rows[0]).toMatchObject({
        projectId: "atlas",
        providerVersion: "openai-responses::https://a.example.com::gpt-5",
        model: "gpt-5",
        responseModel: "gpt-5-2026-08",
        kind: "turn",
        endState: "completed",
        completeness: "reported",
        input: 100,
        cacheWrite: 5,
        reasoning: 12,
      });
      const request = seen.find((entry) => entry.op === "task/usageRecords")?.payload;
      expect(request).toMatchObject({ sessionId: "main" });
      // A filter that names no task fans out over the workspace tasks.
      seen.length = 0;
      await adapter.getUsage({});
      expect(seen.filter((entry) => entry.op === "task/usageRecords").length).toBeGreaterThan(1);
    } finally {
      vi.unstubAllGlobals();
    }

    // Every task refusing to answer keeps the memory rows instead of an empty page.
    stubBridge(async () => ({ ok: false, error: "unknown-op: task/usageRecords" }));
    try {
      const adapter = resolveHostAdapter(createMemoryHost());
      expect((await adapter.getUsage({ taskId: "release" })).length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("[PiDock 12] clears usage through the Host per task and reports the scope", async () => {
    const seen: Array<{ op: string; payload?: Record<string, unknown> }> = [];
    stubBridge(async (_taskId, op, payload) => {
      seen.push({ op, payload });
      if (op === "task/clearUsage") return { ok: true, payload: { removed: 1, remaining: 2, description: "仅清理会话 main 的用量明细（不影响其他会话）" } };
      return { ok: true, payload: {} };
    });
    try {
      const result = await resolveHostAdapter(createMemoryHost()).clearUsage({ kind: "session", sessionId: "main" });
      const calls = seen.filter((entry) => entry.op === "task/clearUsage");
      expect(calls.length).toBeGreaterThan(1);
      expect(calls[0].payload).toEqual({ scope: { kind: "session", sessionId: "main" } });
      expect(result.description).toContain("main");
      expect(result.remaining).toBe(2 * calls.length);
    } finally {
      vi.unstubAllGlobals();
    }
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
