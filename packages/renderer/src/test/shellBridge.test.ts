import { describe, expect, it, vi } from "vitest";
import { provisionTaskThroughShell, shellBridge, shellTaskOp } from "../data/shellBridge";

describe("shell bridge boundary", () => {
  it("returns null outside the shell and rejects task ops explicitly", async () => {
    vi.stubGlobal("window", {});
    expect(shellBridge()).toBeNull();
    await expect(shellTaskOp("task-a", "task/cancel")).rejects.toThrow("不在桌面壳内");
    vi.unstubAllGlobals();
  });

  it("routes a task op through window.pidock without Node access", async () => {
    const taskOp = vi.fn(async () => ({ ok: true, payload: { op: "task/cancel" } }));
    vi.stubGlobal("window", { pidock: { taskOp } });
    // The renderer page must not see Node/Electron globals even when bridged.
    expect(typeof (globalThis as Record<string, unknown>)["require"]).toBe("undefined");
    const result = await shellTaskOp("task-a", "task/cancel", {});
    expect(taskOp).toHaveBeenCalledWith("task-a", "task/cancel", {});
    expect(result).toEqual({ ok: true, payload: { op: "task/cancel" } });
    vi.unstubAllGlobals();
  });

  it("keeps malformed bridge results and rejected invokes as {ok:false} envelopes", async () => {
    const malformed = vi.fn(async () => null);
    vi.stubGlobal("window", { pidock: { taskOp: malformed } });
    const guarded = await shellTaskOp("task-a", "task/cancel", {});
    expect(guarded.ok).toBe(false);
    vi.unstubAllGlobals();

    const rejecting = vi.fn(async () => {
      throw new Error("invoke failed");
    });
    vi.stubGlobal("window", { pidock: { taskOp: rejecting } });
    const provisioned = await provisionTaskThroughShell({
      taskId: "task-a",
      name: "表单任务",
      dirId: "task-a1f92c3d",
      remoteBranch: "origin/main",
      fetchedCommit: "9acb5b6",
    });
    expect(provisioned.ok).toBe(false);
    expect(provisioned.error).toContain("invoke failed");
    expect(rejecting).toHaveBeenCalledWith(
      "task-a",
      "task/provision",
      expect.objectContaining({ name: "表单任务", dirId: "task-a1f92c3d" }),
    );
    vi.unstubAllGlobals();
  });
});

describe("#10 service group bridge (S3)", () => {
  it("forwards the topology plan, run records and stop scope as data", async () => {
    const { planServiceGroupThroughShell, serviceRunRecordsThroughShell, serviceStopScopeThroughShell } = await import(
      "../data/shellBridge"
    );
    const seen: { op: string; payload: Record<string, unknown> | undefined }[] = [];
    const taskOp = vi.fn(async (_taskId: string, op: string, payload?: Record<string, unknown>) => {
      seen.push({ op, payload });
      return { ok: true, payload: {} };
    });
    vi.stubGlobal("window", { pidock: { taskOp } });
    try {
      const units = [{ unitId: "front:saas-web", serviceId: "saas-web", name: "saas-web", location: "local" }];
      expect(
        (
          await planServiceGroupThroughShell({
            taskId: "task-a",
            units,
            selectedRepoDirs: ["front"],
            dependencies: [{ from: "front:saas-web", to: "front:saas-bff", kind: "prestart" }],
            requests: [{ unitId: "front:saas-web", port: 5173 }],
            reservations: [{ port: 5173, owner: "task", taskId: "task-b" }],
            rules: [{ key: "SAAS_WEB_URL", unitId: "front:saas-web", kind: "url" }],
            environment: "testing",
            externalResources: [{ resourceId: "res-q", name: "events", kind: "queue" }],
          })
        ).ok,
      ).toBe(true);
      await serviceRunRecordsThroughShell("task-a");
      await serviceStopScopeThroughShell({ taskId: "task-a", instanceId: "task-a/saas-web" });
      expect(seen.map((entry) => entry.op)).toEqual([
        "task/planServiceGroup",
        "task/serviceRunRecords",
        "task/serviceStopScope",
      ]);
      expect(seen[0].payload).toMatchObject({
        units,
        selectedRepoDirs: ["front"],
        requests: [{ unitId: "front:saas-web", port: 5173 }],
        environment: "testing",
      });
      // Human-UI path: no sessionId is ever sent by the panel plan.
      expect(seen[0].payload?.["sessionId"]).toBeUndefined();
      expect(seen[2].payload).toEqual({ instanceId: "task-a/saas-web" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("#14 protocol bridge (S3)", () => {
  it("forwards the protocol plan, the state read and a recorded run as data", async () => {
    const { planProtocolThroughShell, protocolStateThroughShell, recordProtocolRunThroughShell } = await import(
      "../data/shellBridge"
    );
    const seen: { op: string; payload: Record<string, unknown> | undefined }[] = [];
    const taskOp = vi.fn(async (_taskId: string, op: string, payload?: Record<string, unknown>) => {
      seen.push({ op, payload });
      return { ok: true, payload: {} };
    });
    vi.stubGlobal("window", { pidock: { taskOp } });
    try {
      const protocol = {
        repoDir: "/data/tasks/task-a/apis",
        goGenDir: "/data/tasks/task-a/apis/gen/go",
        tsGenDir: "/data/tasks/task-a/apis/gen/ts",
      };
      const consumers = [
        {
          consumerId: "invoice",
          name: "invoice-service",
          repoDir: "/data/tasks/task-a/invoice-service",
          language: "go" as const,
          serviceId: "invoice-service",
          releaseDependency: "github.com/shipber/apis v0.0.69",
        },
      ];
      expect(
        (
          await planProtocolThroughShell({
            taskId: "task-a",
            protocol,
            mode: "local",
            steps: [{ kind: "generate", program: "make", args: ["generate"], cwd: protocol.repoDir }],
            consumers,
            acknowledged: ["invoice"],
          })
        ).ok,
      ).toBe(true);
      await protocolStateThroughShell("task-a");
      await recordProtocolRunThroughShell({
        taskId: "task-a",
        generatedVersion: "gen-4",
        ok: true,
        note: "make generate + 后处理",
        toolchain: { platform: "darwin-arm64", probe: { buf: { ok: true, version: "1.2.3" } } },
        depsInstalled: [{ consumerId: "invoice", installed: true }],
        resolutions: [{ consumerId: "invoice", path: `${protocol.goGenDir}/pkg`, version: "gen-4" }],
        runtimeReachable: { ok: false, detail: "未检查远程依赖" },
      });
      expect(seen.map((entry) => entry.op)).toEqual([
        "task/planProtocol",
        "task/protocolState",
        "task/recordProtocolRun",
      ]);
      expect(seen[0].payload).toMatchObject({ mode: "local", consumers, acknowledged: ["invoice"] });
      // Human-UI path: the panel plan never sends a sessionId, so the Host
      // classifies it as the attested human request.
      expect(seen[0].payload?.["sessionId"]).toBeUndefined();
      expect(seen[1].payload).toEqual({});
      expect(seen[2].payload).toMatchObject({
        generatedVersion: "gen-4",
        ok: true,
        depsInstalled: [{ consumerId: "invoice", installed: true }],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("#6 append + probe bridge (S3)", () => {
  it("forwards appendRepos and probeLink payloads without Node access", async () => {
    const { appendReposThroughShell, probeLinkThroughShell } = await import("../data/shellBridge");
    const taskOp = vi.fn(async () => ({ ok: true, payload: {} }));
    vi.stubGlobal("window", { pidock: { taskOp } });
    try {
      const appended = await appendReposThroughShell({
        taskId: "task-abcdef12",
        repoSelections: [
          { repoDir: "shipment", remote: "origin", remoteBranch: "main", mainCheckoutDir: "/src/shipment" },
        ],
        fetchedCommits: { shipment: "c0ffee1234" },
        takenPaths: [],
        branchesInUse: [],
      });
      expect(appended.ok).toBe(true);
      expect(taskOp).toHaveBeenCalledWith(
        "task-abcdef12",
        "task/appendRepos",
        expect.objectContaining({ fetchedCommits: { shipment: "c0ffee1234" } }),
      );
      const probed = await probeLinkThroughShell({ taskId: "task-abcdef12", sourcePath: "/data/notes" });
      expect(probed.ok).toBe(true);
      expect(taskOp).toHaveBeenCalledWith("task-abcdef12", "task/probeLink", { sourcePath: "/data/notes" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("#7 service bridge (S4)", () => {
  it("forwards register/control/status/log payloads without Node access", async () => {
    const { registerServiceThroughShell, controlServiceThroughShell, serviceStatusThroughShell, serviceLogThroughShell } =
      await import("../data/shellBridge");
    const { vi: vitestVi } = await import("vitest");
    const taskOp = vitestVi.fn(async () => ({ ok: true, payload: {} }));
    vitestVi.stubGlobal("window", { pidock: { taskOp } });
    try {
      const registered = await registerServiceThroughShell({
        taskId: "task-abcdef12",
        serviceId: "saas-web",
        descriptor: { name: "saas-web", program: "pnpm" },
        layers: { shared: [] },
        templateVersion: "v12",
      });
      expect(registered.ok).toBe(true);
      expect(taskOp).toHaveBeenCalledWith(
        "task-abcdef12",
        "task/registerService",
        expect.objectContaining({ serviceId: "saas-web", templateVersion: "v12" }),
      );
      const started = await controlServiceThroughShell({ taskId: "task-abcdef12", serviceId: "saas-web", action: "start", label: "用户点击启动" });
      expect(started.ok).toBe(true);
      expect(taskOp).toHaveBeenCalledWith(
        "task-abcdef12",
        "task/controlService",
        // Human-explicit control carries no sessionId and no actor claim:
        // the Host treats session-less calls as UI-initiated.
        { serviceId: "saas-web", action: "start", label: "用户点击启动" },
      );
      const agentDenied = await controlServiceThroughShell({ taskId: "task-abcdef12", serviceId: "saas-web", action: "start", sessionId: "main", approvalId: undefined });
      expect(agentDenied.ok).toBe(true);
      expect(taskOp).toHaveBeenCalledWith(
        "task-abcdef12",
        "task/controlService",
        { serviceId: "saas-web", action: "start", sessionId: "main" },
      );
      const status = await serviceStatusThroughShell({ taskId: "task-abcdef12", serviceId: "saas-web" });
      expect(status.ok).toBe(true);
      const log = await serviceLogThroughShell({ taskId: "task-abcdef12", serviceId: "saas-web", limit: 10 });
      expect(log.ok).toBe(true);
      expect(taskOp).toHaveBeenCalledWith("task-abcdef12", "task/serviceLog", { serviceId: "saas-web", limit: 10 });
    } finally {
      vitestVi.unstubAllGlobals();
    }
  });
});
