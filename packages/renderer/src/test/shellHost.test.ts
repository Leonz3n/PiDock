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
            contentVersion: "v12+task-abcdef12",
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
      // [PiDock 17] (#19 box 3) the card shows the payload version the Host
      // minted the confirmation for, not a hardcoded one.
      payloadVersion: "v12+task-abcdef12",
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

  it("[PiDock 17] (#19 box 3) shows the Host's real payload version and impact on a listed approval", async () => {
    stubBridge(async (_taskId, op) => {
      if (op === "task/listApprovals") {
        return {
          ok: true,
          payload: {
            approvals: [
              {
                id: "approval-9",
                sessionId: "deploy",
                tool: "exec.run",
                target: "/tmp/task-a/run.sh",
                status: "pending",
                executed: false,
                contentVersion: "v12+task-a",
                permissionAtRequest: "default",
              },
            ],
          },
        };
      }
      return { ok: true, payload: {} };
    });
    const adapter = resolveHostAdapter(createMemoryHost());
    const approval = (await adapter.listApprovals("task-a")).find((item) => item.id === "approval-9");
    expect(approval?.payloadVersion).toBe("v12+task-a");
    expect(approval?.impact).toBe("以「默认权限」执行 exec.run，命中 /tmp/task-a/run.sh");
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

  it("[PiDock 08] prefers the Host protocol state and keeps the memory projection when it cannot answer", async () => {
    const ops: string[] = [];
    stubBridge(async (_taskId, op) => {
      ops.push(op as string);
      if (op === "task/protocolState") {
        return {
          ok: true,
          payload: {
            state: {
              taskId: "release",
              mode: "local",
              protocol: { repoDir: "/tasks/task-a/apis", goGenDir: "/tasks/task-a/apis/gen/go", tsGenDir: "/tasks/task-a/apis/gen/ts" },
              generatedVersion: "gen-7",
              generation: { runsGeneration: true, reason: "本地联调", steps: [{ kind: "generate", program: "make", args: ["generate"], cwd: "/tasks/task-a/apis" }] },
              consumers: [
                {
                  consumerId: "invoice",
                  name: "invoice-service",
                  language: "go",
                  repoDir: "/tasks/task-a/invoice-service",
                  releaseDependency: "github.com/shipber/apis v0.0.69",
                  binding: { kind: "go-workspace", path: "/tasks/task-a/protocol/go-work/invoice/go.work", useDirectories: [], excludedConsumers: [], releaseManifestsUntouched: [] },
                  staleness: { state: "ready", detail: "已使用本任务产物 gen-7" },
                },
              ],
              prepare: [{ state: "generated", label: "生成物已更新", ok: true, detail: "实际生成版本：gen-7" }],
              toolchain: { platform: "darwin-arm64", ok: true, note: "生成工具就绪", desktopLaunchImpliesGeneration: false, entries: [] },
              diagnostics: [],
              switchAssessment: { ok: true, blockers: [], notes: [] },
            },
          },
        };
      }
      return { ok: true, payload: {} };
    });
    try {
      const view = await resolveHostAdapter(createMemoryHost()).protocolBinding("release");
      expect(ops).toEqual(["task/protocolState"]);
      expect(view.simulated).toBe(false);
      expect(view.mode).toBe("local");
      expect(view.generatedVersion).toBe("gen-7");
      expect(view.consumers[0]).toMatchObject({ consumerId: "invoice", binding: { kind: "go-workspace" } });
      // A Host without a plan yet keeps the memory projection (fail-open read).
      stubBridge(async () => ({ ok: false, error: "invalid-protocol-repo: 尚未设置协议仓库与消费者" }));
      const fallback = await resolveHostAdapter(createMemoryHost()).protocolBinding("release");
      expect(fallback.simulated).toBe(true);
      expect(fallback.generatedVersion).toBeNull();
      expect(fallback.consumers.length).toBeGreaterThan(0);
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

  it("[PiDock 14] routes archive/restore/cleanup to the Host and reads the lifecycle readout", async () => {
    const seen: Array<{ taskId: string; op: string; payload?: Record<string, unknown> }> = [];
    stubBridge(async (taskId, op, payload) => {
      seen.push({ taskId, op, payload });
      if (op === "task/lifecycleState") {
        return {
          ok: true,
          payload: {
            lifecycle: {
              taskId,
              archived: true,
              archivedAt: "2026-09-22T12:00:00+08:00",
              restoredAt: null,
              schedulePaused: true,
              projectReleased: false,
              usageDetails: 4,
              cleanup: null,
              recovery: [],
              resources: {
                worktrees: [{ repoDir: "/tasks/task-a/repo", verdict: { ok: false, code: "identity-mismatch", reason: "上游已重写历史" } }],
                processes: [{ kind: "service", id: "web", running: true, verdict: null }],
              },
            },
          },
        };
      }
      if (op === "task/cleanupPreview") {
        return {
          ok: true,
          payload: {
            preview: {
              taskId,
              archived: true,
              items: [
                { id: "code", resource: "代码", disposition: "keep-copy", detail: "保留独立副本后解除登记" },
                { id: "usage", resource: "用量", disposition: "remove", detail: "4 条明细", exportable: "usage" },
              ],
              warnings: [],
              recordsWillBeRemoved: true,
              selectionLabels: ["导出用量"],
              keepRoot: "/tasks/.pidock-kept",
            },
          },
        };
      }
      if (op === "task/runCleanup") {
        // The real Host payload: the removal plan at the top level (with the
        // persisted receipt the caller keeps: `ranAt` + export labels) plus the
        // persisted record. The plan's own narrower receipt would lose `ranAt`,
        // which is why the Host returns the persisted one.
        return {
          ok: true,
          payload: {
            cleanup: {
              ok: true,
              steps: [{ phase: "deregister-project", subject: "项目关联", action: "解除项目关联", status: "ready", detail: "清理成功" }],
              items: [{ id: "code", resource: "代码", disposition: "keep-copy", detail: "保留独立副本后解除登记" }],
              recovery: [],
              receipt: { ranAt: "2026-09-22T12:01:00+08:00", keptPosition: "/tasks/.pidock-kept/task-a", exports: ["导出用量"], removed: ["usage"], partialFailure: false },
              record: {
                taskId,
                archived: true,
                archivedAt: "2026-09-22T12:00:00+08:00",
                restoredAt: null,
                schedulePaused: true,
                projectReleased: true,
                recovery: [],
                updatedAt: "2026-09-22T12:01:00+08:00",
                cleanup: {
                  ranAt: "2026-09-22T12:01:00+08:00",
                  keptPosition: "/tasks/.pidock-kept/task-a",
                  exports: ["导出用量"],
                  removed: ["usage"],
                  partialFailure: false,
                },
              },
            },
          },
        };
      }
      return { ok: true, payload: {} };
    });
    try {
      const adapter = resolveHostAdapter(createMemoryHost());

      const readout = await adapter.lifecycleState("task-a");
      expect(readout).toMatchObject({ archived: true, schedulePaused: true, usageDetails: 4, cleanup: null });
      // A worktree whose identity no longer matches reads as unverified, and a
      // running process without a recorded identity is never assumed verified.
      expect(readout.worktrees).toEqual([{ repoDir: "/tasks/task-a/repo", ok: false, code: "identity-mismatch", reason: "上游已重写历史" }]);
      expect(readout.processes).toEqual([{ kind: "service", id: "web", running: true, ok: null, reason: "" }]);

      const preview = await adapter.previewCleanup("task-a", { exportSessions: false, exportDrafts: false, exportUsage: true });
      expect(seen.find((entry) => entry.op === "task/cleanupPreview")?.payload).toEqual({
        selection: { exportSessions: false, exportDrafts: false, exportUsage: true },
      });
      expect(preview.map((item) => [item.id, item.disposition])).toEqual([
        ["code", "keep-copy"],
        ["usage", "remove"],
      ]);
      expect(preview.every((item) => item.action === "")).toBe(true);

      const run = await adapter.runCleanup("task-a", { exportSessions: false, exportDrafts: false, exportUsage: true });
      const archiveCall = seen.find((entry) => entry.op === "task/runCleanup");
      expect(archiveCall?.taskId).toBe("task-a");
      expect((archiveCall?.payload as Record<string, unknown>)["selection"]).toEqual({ exportSessions: false, exportDrafts: false, exportUsage: true });
      // No sessionId ever rides an archive/cleanup op: the Host refuses an
      // agent-originated call and attests the human-UI origin itself.
      expect((archiveCall?.payload as Record<string, unknown>)["sessionId"]).toBeUndefined();
      expect(run.receipt).toMatchObject({ keptPosition: "/tasks/.pidock-kept/task-a", exports: ["导出用量"], partialFailure: false });
      expect(run.receipt?.ranAt).toBe("2026-09-22T12:01:00+08:00");
      expect(run.recovery).toEqual([]);

      await adapter.archiveTask("task-a");
      await adapter.restoreTask("task-a");
      expect(seen.filter((entry) => entry.op === "task/archive" || entry.op === "task/restore").map((entry) => entry.op)).toEqual([
        "task/archive",
        "task/restore",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("[PiDock 14] reports a partial cleanup failure from the persisted receipt instead of a success", async () => {
    stubBridge(async () => ({
      ok: true,
      payload: {
        cleanup: {
          ok: true,
          steps: [{ phase: "deregister-project", subject: "项目关联", action: "解除项目关联", status: "blocked", detail: "局部清理失败" }],
          items: [{ id: "link:dir-51cd20bb", resource: "普通目录链接", disposition: "remove", detail: "任务内链接" }],
          recovery: [{ item: "link:dir-51cd20bb", reason: "目标已被外部替换，保留登记" }],
          receipt: { ranAt: "2026-09-22T12:02:00+08:00", keptPosition: "/tasks/.pidock-kept/task-a", exports: [], removed: [], partialFailure: true },
          record: {
            taskId: "task-a",
            archived: true,
            archivedAt: "2026-09-22T12:00:00+08:00",
            restoredAt: null,
            schedulePaused: true,
            projectReleased: false,
            recovery: [],
            updatedAt: "2026-09-22T12:02:00+08:00",
            cleanup: {
              ranAt: "2026-09-22T12:02:00+08:00",
              keptPosition: "/tasks/.pidock-kept/task-a",
              exports: [],
              removed: [],
              partialFailure: true,
            },
          },
        },
      },
    }));
    try {
      const run = await resolveHostAdapter(createMemoryHost()).runCleanup("task-a", { exportSessions: false, exportDrafts: false, exportUsage: false });
      // `partialFailure` must reach the modal's toast/rows: a receipt built from
      // the removal plan alone loses it (no `ranAt` -> receipt `null`).
      expect(run.receipt?.partialFailure).toBe(true);
      expect(run.receipt?.ranAt).toBe("2026-09-22T12:02:00+08:00");
      expect(run.recovery).toEqual([{ item: "link:dir-51cd20bb", reason: "目标已被外部替换，保留登记" }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("[PiDock 14] falls back to the memory projection when the Host refuses an archive/cleanup call", async () => {
    stubBridge(async () => ({ ok: false, error: "permission-denied: 清理只允许界面显式操作，不能由 Agent 会话发起" }));
    try {
      const adapter = resolveHostAdapter(createMemoryHost());
      // A fixture task the Host does not own stays operable locally.
      await adapter.archiveTask("release");
      expect((await adapter.lifecycleState("release")).archived).toBe(true);
      // When both sides refuse, the Host error surfaces (it names the real
      // reason for a Host-owned task) instead of a silent no-op or a
      // misleading "任务不存在".
      // `release` references one ordinary directory: 7 base rows + its link row.
      expect(await adapter.previewCleanup("release")).toHaveLength(8);
      await expect(adapter.previewCleanup("checkout")).rejects.toThrow("permission-denied");
      await expect(adapter.runCleanup("missing-task", { exportSessions: false, exportDrafts: false, exportUsage: false })).rejects.toThrow(
        "permission-denied",
      );
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

/**
 * [PiDock 17] (#19 box 5) the attention list is a read of each task Host's
 * execution ledger: the Host items replace the memory rows of the tasks that
 * answered, the label adds the project name, and a read goes back to the task
 * Host that produced the id.
 */
describe("attention bridging", () => {
  const hostItem = {
    id: "attention-approval-release-approval-1",
    kind: "approval",
    executionId: "exec-1",
    taskId: "release",
    sessionId: "main",
    taskName: "发布前检查",
    detail: "待确认：回合工具 exec.run",
    at: "2026-09-22T10:00:00.000Z",
    read: false,
  };

  it("replaces the Host-owned task items with the Host's own and labels them with the project", async () => {
    const fallback = createMemoryHost();
    // A completed turn leaves a real 完成未读 item in the memory projection.
    await fallback.sendMessage("latency", "main", "检查延迟", []);
    const seen: string[] = [];
    stubBridge(async (taskId, op) => {
      if (op !== "task/attention") return { ok: true, payload: {} };
      seen.push(taskId);
      // Only `release` has a Host here; the others keep their memory rows.
      return taskId === "release" ? { ok: true, payload: { taskName: "发布前检查", items: [hostItem] } } : { ok: false, error: "task-unbound" };
    });
    const adapter = resolveHostAdapter(fallback);
    const attention = await adapter.getAttention();
    expect(seen).toContain("release");
    // The Host's row replaces this task's memory rows (2 approvals + 1 failed).
    expect(attention.filter((item) => item.taskId === "release")).toEqual([
      {
        id: hostItem.id,
        kind: "approval",
        projectId: "atlas",
        taskId: "release",
        sessionId: "main",
        label: "Atlas Web · 发布前检查",
        detail: "待确认：回合工具 exec.run",
        read: false,
      },
    ]);
    // A task no Host answered for keeps its memory item.
    expect(attention.some((item) => item.taskId === "latency" && item.kind === "completed-unread")).toBe(true);
    vi.unstubAllGlobals();
  });

  it("routes a read to the task Host that produced the id and clears the memory row locally", async () => {
    const fallback = createMemoryHost();
    await fallback.sendMessage("latency", "main", "检查延迟", []);
    const reads: Array<{ taskId: string; payload?: Record<string, unknown> }> = [];
    stubBridge(async (taskId, op, payload) => {
      if (op === "task/attention") {
        return taskId === "release"
          ? { ok: true, payload: { taskName: "发布前检查", items: [hostItem] } }
          : { ok: false, error: "task-unbound" };
      }
      if (op === "task/markAttentionRead") {
        reads.push({ taskId, payload });
        return { ok: true, payload: { cleared: [], kept: (payload?.["itemIds"] as string[]) ?? [] } };
      }
      return { ok: true, payload: {} };
    });
    const adapter = resolveHostAdapter(fallback);
    await adapter.getAttention();
    const memoryItem = (await fallback.getAttention()).find((item) => item.taskId === "latency" && item.kind === "completed-unread");
    expect(memoryItem).toBeDefined();

    // The Host-owned id goes over RPC; a Host that keeps it (待处理) reports it kept.
    const hostRead = await adapter.markAttentionRead("release", [hostItem.id]);
    expect(reads).toEqual([{ taskId: "release", payload: { itemIds: [hostItem.id] } }]);
    expect(hostRead.kept).toEqual([hostItem.id]);

    // A memory-owned id never crosses the boundary and clears the unread row.
    const memoryRead = await adapter.markAttentionRead("latency", [memoryItem?.id as string]);
    expect(reads).toHaveLength(1);
    expect(memoryRead.cleared).toEqual([memoryItem?.id]);
    expect((await fallback.getAttention()).some((item) => item.id === memoryItem?.id)).toBe(false);
    vi.unstubAllGlobals();
  });

  it("falls back to the memory list when no Host answers", async () => {
    stubBridge(async () => ({ ok: false, error: "task-unbound" }));
    const fallback = createMemoryHost();
    const adapter = resolveHostAdapter(fallback);
    expect(await adapter.getAttention()).toEqual(await fallback.getAttention());
    vi.unstubAllGlobals();
  });
});
