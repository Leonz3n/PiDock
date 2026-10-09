/**
 * #47 S8d: the strict parsers behind the production 运行/日志 tool panels.
 *
 * They decide what the panel may show as real Host data, so a wrong shape must
 * return `null` (unreadable) rather than a partial or invented row.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runBoundTaskServiceThroughShell,
  serviceLogFromHost,
  serviceStatusFromHost,
  shellFailure,
  taskAssociationFromMain,
} from "../data/taskServices";

const SERVICE_ID = "s-11111111-1111-1111-1111-111111111111";

afterEach(() => { vi.unstubAllGlobals(); });

describe("[UI 对齐] S8d task service parsers", () => {
  it("accepts both real Host status shapes and rejects a status for another service", () => {
    expect(serviceStatusFromHost({ service: { serviceId: SERVICE_ID, state: "running", ownerSessionId: "main", busy: false, closing: false, retainedRights: "held", executionAvailable: false } }, SERVICE_ID))
      .toEqual({ kind: "owner", serviceId: SERVICE_ID, state: "running", ownerSessionId: "main", busy: false, closing: false, retainedRights: "held", executionAvailable: false });
    expect(serviceStatusFromHost({ service: { serviceId: SERVICE_ID, lifecycle: "stopped", templateVersion: "1", resolved: [{ key: "PORT", value: "4100", source: "shared", secret: false }] } }, SERVICE_ID))
      .toEqual({ kind: "registry", serviceId: SERVICE_ID, lifecycle: "stopped", templateVersion: "1", resolvedKeys: ["PORT"] });
    // The Host's own allowlisted projection (`service-public.ts`) carries the
    // trusted launch source and an explicit "health was not probed" note; a
    // reachability probe is never reported as health.
    expect(serviceStatusFromHost({ service: { serviceId: SERVICE_ID, lifecycle: "running", templateVersion: "2", launchSource: "catalog", health: "not-probed", startedAt: "2026-10-08T00:00:00.000Z", stoppedAt: undefined, exitReason: undefined, resolved: [] } }, SERVICE_ID))
      .toMatchObject({ kind: "registry", serviceId: SERVICE_ID, lifecycle: "running", launchSource: "catalog", health: "not-probed", resolvedKeys: [] });
    expect(serviceStatusFromHost({ service: { serviceId: SERVICE_ID, lifecycle: "running", templateVersion: "2", health: "green", resolved: [] } }, SERVICE_ID)).toBeNull();
    expect(serviceStatusFromHost({ service: { serviceId: SERVICE_ID, lifecycle: "running", templateVersion: "2", launchSource: "agent", resolved: [] } }, SERVICE_ID)).toBeNull();
    expect(serviceStatusFromHost({ service: { serviceId: "s-99999999-9999-9999-9999-999999999999", state: "running", ownerSessionId: null, busy: false, closing: false, retainedRights: null, executionAvailable: false } }, SERVICE_ID)).toBeNull();
  });

  it("rejects an unknown lifecycle/state or a malformed resolved row instead of reporting a stopped service", () => {
    expect(serviceStatusFromHost({ service: { serviceId: SERVICE_ID, state: "teleporting", ownerSessionId: null, busy: false, closing: false, retainedRights: null, executionAvailable: false } }, SERVICE_ID)).toBeNull();
    expect(serviceStatusFromHost({ service: { serviceId: SERVICE_ID, state: "running", ownerSessionId: null, busy: false, closing: false, retainedRights: "maybe", executionAvailable: false } }, SERVICE_ID)).toBeNull();
    expect(serviceStatusFromHost({ service: { serviceId: SERVICE_ID, lifecycle: "running", templateVersion: "1", resolved: [{ key: 1 }] } }, SERVICE_ID)).toBeNull();
    expect(serviceStatusFromHost({ service: null }, SERVICE_ID)).toBeNull();
  });

  it("accepts only a complete log line list", () => {
    expect(serviceLogFromHost({ log: [{ at: "2026-10-08T00:00:00.000Z", line: "listening at :4100" }] }))
      .toEqual([{ at: "2026-10-08T00:00:00.000Z", line: "listening at :4100" }]);
    expect(serviceLogFromHost({ log: [] })).toEqual([]);
    expect(serviceLogFromHost({ log: [{ at: "now" }] })).toBeNull();
    expect(serviceLogFromHost({ log: "listening" })).toBeNull();
    expect(serviceLogFromHost({})).toBeNull();
  });

  it("reads the task's own association row and refuses an inconsistent project link", () => {
    const rows = { roots: [], tasks: [{ taskId: "task-1", projectId: "project-1", state: "assigned" }, { taskId: "task-2", projectId: null, state: "unassigned" }] };
    expect(taskAssociationFromMain(rows, "task-1")).toEqual({ taskId: "task-1", projectId: "project-1", state: "assigned" });
    expect(taskAssociationFromMain(rows, "task-2")).toEqual({ taskId: "task-2", projectId: null, state: "unassigned" });
    expect(taskAssociationFromMain(rows, "task-3")).toBeNull();
    expect(taskAssociationFromMain({ roots: [], tasks: [{ taskId: "task-1", projectId: null, state: "assigned" }] }, "task-1")).toBeNull();
  });

  it("shows the Host's own refusal text without Electron's invoke wrapper", () => {
    expect(shellFailure({ error: "Error invoking remote method 'shell/taskOp': Error: unknown-service: s-1 is not registered on this task" }, "fallback"))
      .toBe("unknown-service: s-1 is not registered on this task");
    expect(shellFailure({ error: "browser-unavailable: 主进程未挂载任务浏览器能力" }, "fallback")).toBe("browser-unavailable: 主进程未挂载任务浏览器能力");
    expect(shellFailure({}, "读取失败")).toBe("读取失败");
    expect(shellFailure({ error: "   " }, "读取失败")).toBe("读取失败");
  });

  it("sends only project/task/service/action to the production runTaskService op", async () => {
    const seen: Record<string, unknown>[] = [];
    vi.stubGlobal("window", { pidock: { taskOp: async () => ({ ok: true, payload: {} }), serviceCatalogOp: async (request: Record<string, unknown>) => {
      seen.push(request);
      return { ok: false, error: "Error invoking remote method 'shell/serviceCatalogOp': Error: unsupported-platform: 平台不支持" };
    } } });
    const result = await runBoundTaskServiceThroughShell({ projectId: "project-1", taskId: "task-1", serviceId: SERVICE_ID, action: "start" });
    expect(seen).toEqual([{ op: "runTaskService", projectId: "project-1", taskId: "task-1", serviceId: SERVICE_ID, action: "start" }]);
    expect(Object.keys(seen[0]!).sort()).toEqual(["action", "op", "projectId", "serviceId", "taskId"]);
    // The Host's refusal reaches the panel with its reason intact (Electron's
    // plumbing wrapper stripped), never as a fabricated running state.
    expect(result).toEqual({ ok: false, error: "unsupported-platform: 平台不支持" });
    vi.unstubAllGlobals();

    vi.stubGlobal("window", { pidock: { taskOp: async () => ({ ok: true, payload: {} }), serviceCatalogOp: async () => ({ ok: true, payload: { serviceId: SERVICE_ID, action: "start", actor: "human" } }) } });
    expect(await runBoundTaskServiceThroughShell({ projectId: "project-1", taskId: "task-1", serviceId: SERVICE_ID, action: "start" })).toEqual({ ok: true });
    vi.unstubAllGlobals();

    // No shell bridge at all stays a refusal, not a silent success.
    vi.stubGlobal("window", {});
    expect(await runBoundTaskServiceThroughShell({ projectId: "project-1", taskId: "task-1", serviceId: SERVICE_ID, action: "start" })).toEqual({ ok: false, error: "服务配方目录尚未接线" });
    vi.unstubAllGlobals();
  });
});
