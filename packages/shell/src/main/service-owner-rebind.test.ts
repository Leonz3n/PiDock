/**
 * [PiDock 04] (#7 slice) main's way back from a fenced task: the explicit
 * service-owner re-bind and the restart consequence attached to a shared
 * template write.
 *
 * Evidence split (stated, not implied):
 * - REAL main functions: `rebindTaskServiceOwner` and
 *   `serviceRestartConsequence` are the exported production sequences the
 *   `shell/serviceCatalogOp` handler calls.
 * - FIXTURE: the task registry and the catalog are stubs here, so this suite
 *   pins the orchestration contract (two steps, named refusals, named changes,
 *   idempotence). The real registry + real authority + real durable store are
 *   covered in `service-host-binding.test.ts`, and the real Host with real
 *   service child processes in `service-execution-production.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/synthetic-profile" },
  BrowserWindow: class {}, WebContentsView: class {}, dialog: {}, ipcMain: { handle: vi.fn(), eventNames: () => [] },
  session: {}, utilityProcess: { fork: vi.fn() },
}));

import { rebindTaskServiceOwner, serviceRestartConsequence } from "./runtime.js";

const projectId = "b36323d3-ff33-4e34-a873-536a9775788a";
const taskId = "task-1";
const serviceId = "s-b36323d3-ff33-4e34-a873-536a9775788a";
const contract = (templateVersion: number) => ({ templateVersion, configRevision: "a".repeat(64) });

function registry(state: "absent" | "current" | "fenced", options: { owners?: { serviceId: string; state: string; ownerSessionId: string | null }[] } = {}) {
  return {
    serviceOwnerState: vi.fn(() => state),
    serviceOwnerChanges: vi.fn(() => [{ serviceId, was: contract(1), now: { ...contract(2), configRevision: "b".repeat(64) } }]),
    serviceOwnerOwners: vi.fn(() => options.owners ?? []),
    rebindServiceOwner: vi.fn(async () => "rebound" as const),
  };
}
const catalog = { taskBindings: vi.fn(() => [{ binding: { serviceId, templateVersion: 2 }, template: { descriptor: { name: "API" } } }]) };

describe("#7 explicit service-owner re-bind", () => {
  it("is an idempotent no-op when no Host is forked or the binding is already current, and never confirms itself", async () => {
    for (const state of ["absent", "current"] as const) {
      const tasks = registry(state);
      expect(await rebindTaskServiceOwner(tasks, catalog, { projectId, taskId, confirm: false }))
        .toEqual({ taskId, projectId, state, confirmed: false, rebound: false, changes: [], stopsProcesses: false, restartsProcesses: false });
      expect(await rebindTaskServiceOwner(tasks, catalog, { projectId, taskId, confirm: true }))
        .toMatchObject({ state, confirmed: false, rebound: false, changes: [] });
      expect(tasks.rebindServiceOwner).not.toHaveBeenCalled();
      expect(tasks.serviceOwnerOwners).not.toHaveBeenCalled();
    }
  });

  it("reports the named contract change of a fenced owner without writing, and only replaces it once confirmed", async () => {
    const tasks = registry("fenced");
    const review = await rebindTaskServiceOwner(tasks, catalog, { projectId, taskId, confirm: false });
    expect(review).toEqual({ taskId, projectId, state: "fenced", confirmed: false, rebound: false,
      changes: [{ serviceId, name: "API", was: 1, now: 2 }], stopsProcesses: false, restartsProcesses: false });
    expect(tasks.rebindServiceOwner).not.toHaveBeenCalled();
    // The receipt re-observes the state after the replacement, so a task whose
    // control came back is never reported as still fenced.
    let observed: "fenced" | "current" = "fenced";
    tasks.serviceOwnerState.mockImplementation(() => observed);
    tasks.rebindServiceOwner.mockImplementation(async () => { observed = "current"; return "rebound"; });
    expect(await rebindTaskServiceOwner(tasks, catalog, { projectId, taskId, confirm: true }))
      .toEqual({ ...review, state: "current", confirmed: true, rebound: true });
    expect(tasks.rebindServiceOwner).toHaveBeenCalledWith(taskId);
  });

  it("refuses by name while a durable owner record is unsettled, so a possibly live process is never silently dropped", async () => {
    for (const owner of [{ serviceId, state: "running", ownerSessionId: "previous-owner" }, { serviceId, state: "stopped", ownerSessionId: "previous-owner" }, { serviceId, state: "unconfirmed", ownerSessionId: null }]) {
      const tasks = registry("fenced", { owners: [owner] });
      await expect(rebindTaskServiceOwner(tasks, catalog, { projectId, taskId, confirm: true }))
        .rejects.toThrow(`service-owner-rebind-blocked: ${serviceId}`);
      expect(tasks.rebindServiceOwner).not.toHaveBeenCalled();
    }
    // A settled record is not a block: the explicit re-bind proceeds.
    const settled = registry("fenced", { owners: [{ serviceId, state: "exited", ownerSessionId: null }] });
    expect(await rebindTaskServiceOwner(settled, catalog, { projectId, taskId, confirm: true }))
      .toMatchObject({ confirmed: true, rebound: true });
  });

  it("fails closed with a named refusal when the owner contracts cannot be resolved", async () => {
    const tasks = registry("fenced");
    tasks.serviceOwnerChanges.mockReturnValue(null);
    await expect(rebindTaskServiceOwner(tasks, catalog, { projectId, taskId, confirm: true }))
      .rejects.toThrow("service-owner-catalog-unavailable");
    expect(tasks.rebindServiceOwner).not.toHaveBeenCalled();
  });

  it("reports a requested re-bind that replaced nothing as not rebound instead of claiming control came back", async () => {
    const tasks = registry("fenced");
    tasks.rebindServiceOwner.mockResolvedValue("current");
    expect(await rebindTaskServiceOwner(tasks, catalog, { projectId, taskId, confirm: true }))
      .toMatchObject({ confirmed: true, rebound: false, state: "fenced" });
  });

  it("never reads the catalog for the idempotent answers a panel may repeat", async () => {
    const tasks = registry("absent");
    catalog.taskBindings.mockClear();
    expect(await rebindTaskServiceOwner(tasks, catalog, { projectId, taskId, confirm: true })).toMatchObject({ state: "absent", rebound: false });
    expect(catalog.taskBindings).not.toHaveBeenCalled();
  });
});

describe("#7 restart consequence on a shared template write", () => {
  it("carries the write's real content change and never claims a process restart", () => {
    const tasks = { serviceOwnerState: vi.fn(() => "current" as const) };
    expect(serviceRestartConsequence("update", { contentChanged: true }, tasks as never))
      .toEqual({ changed: true, processRestarted: false, fencedTaskIds: [] });
    expect(serviceRestartConsequence("update", { contentChanged: false }, tasks as never))
      .toEqual({ changed: false, processRestarted: false, fencedTaskIds: [] });
    // Saving a shared revision moves no binding's pin, so no task's control is revoked by it.
    expect(tasks.serviceOwnerState).not.toHaveBeenCalled();
  });

  it("names exactly the forked tasks whose control a confirmed adoption revoked", () => {
    const fenced = {
      serviceOwnerState: vi.fn((id: string) => id === taskId ? "fenced" as const : "current" as const),
    };
    expect(serviceRestartConsequence("adoptBinding", { taskId, from: 1, to: 2 }, fenced as never))
      .toEqual({ changed: true, processRestarted: false, fencedTaskIds: [taskId] });
    expect(fenced.serviceOwnerState).toHaveBeenCalledWith(taskId);
    // A review of the same adoption observed nothing yet (nothing was written), so it reports no revoked task.
    const untouched = { serviceOwnerState: vi.fn(() => "current" as const) };
    expect(serviceRestartConsequence("adoptBinding", { taskId, from: 1, to: 2 }, untouched as never))
      .toEqual({ changed: true, processRestarted: false, fencedTaskIds: [] });
    // Without a task registry (catalog-only wiring) the answer stays honest: no observed revocation.
    expect(serviceRestartConsequence("adoptBinding", { taskId, from: 1, to: 2 })).toEqual({ changed: true, processRestarted: false, fencedTaskIds: [] });
  });
});
