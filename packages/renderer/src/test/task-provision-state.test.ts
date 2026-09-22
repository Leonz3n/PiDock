import { describe, expect, it } from "vitest";
import { createMemoryHost } from "../data/memoryHost";
import { previewTaskFormPaths } from "../data/directories";

/**
 * [PiDock 02] provision-state seam: the task form keeps its input on
 * fetch/provision failure with a retry entry, the stored task keeps the
 * actual root it was created under (a later default change never migrates
 * it), and the header reads name/repo/branch/ready/code-change from the
 * same record with errors bound to the task id.
 */
describe("memory Host provision state", () => {
  it("provisions through the form fields and stores the resolved root", async () => {
    const host = createMemoryHost();
    const created = await host.createTask({
      projectId: "atlas",
      name: "表单任务",
      repoIds: [],
      directoryIds: [],
      environmentId: "testing",
    });
    const provisioned = await host.provisionTaskThroughForm({
      taskId: created.id,
      name: "表单任务",
      dirId: created.workspaceKey,
      remoteBranch: "origin/main",
      fetchedCommit: "9acb5b6",
    });
    expect(provisioned.ok).toBe(true);
    if (!provisioned.ok) return;
    expect(provisioned.provision.branch).toBe(`task/${created.workspaceKey}`);
    expect(provisioned.provision.root).toBe("~/PiDockTasks");
    expect(provisioned.provision.ready).toBe(true);
  });

  it("keeps fetch failure on the form entry without provisioning", async () => {
    const host = createMemoryHost();
    const created = await host.createTask({
      projectId: "atlas",
      name: "获取失败任务",
      repoIds: [],
      directoryIds: [],
      environmentId: "testing",
    });
    const failed = await host.provisionTaskThroughForm({
      taskId: created.id,
      name: "获取失败任务",
      dirId: created.workspaceKey,
      remoteBranch: "origin/main",
      fetchedCommit: "",
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error.code).toBe("fetch-failed");
    // The form entry keeps the failure for retry; the header binds it to
    // this task id and the task itself is untouched.
    const provision = await host.getTaskProvision(created.id);
    expect(provision?.ready).toBe(false);
    expect(provision?.lastError?.code).toBe("fetch-failed");
    const header = await host.getTaskHeader(created.id);
    expect(header.taskId).toBe(created.id);
    expect(header.error).toContain("fetch-failed");
  });

  it("rejects identifier conflicts without touching the task", async () => {
    const host = createMemoryHost();
    const first = await host.createTask({
      projectId: "atlas",
      name: "首个任务",
      repoIds: [],
      directoryIds: [],
      environmentId: "testing",
      workspaceKey: "task-a1f92c3d",
    });
    const second = await host.createTask({
      projectId: "atlas",
      name: "冲突任务",
      repoIds: [],
      directoryIds: [],
      environmentId: "testing",
    });
    const conflicted = await host.provisionTaskThroughForm({
      taskId: second.id,
      name: "冲突任务",
      dirId: first.workspaceKey,
      remoteBranch: "origin/main",
      fetchedCommit: "9acb5b6",
    });
    expect(conflicted.ok).toBe(false);
    if (conflicted.ok) return;
    expect(conflicted.error.code).toBe("identifier-conflict");
  });

  it("stores the per-creation override root and never migrates it", async () => {
    const host = createMemoryHost();
    const created = await host.createTask({
      projectId: "atlas",
      name: "覆盖根任务",
      repoIds: [],
      directoryIds: [],
      environmentId: "testing",
    });
    const provisioned = await host.provisionTaskThroughForm({
      taskId: created.id,
      name: "覆盖根任务",
      dirId: created.workspaceKey,
      rootOverride: "/tmp/once",
      remoteBranch: "origin/main",
      fetchedCommit: "9acb5b6",
    });
    expect(provisioned.ok).toBe(true);
    // A later default change affects new tasks only; this task keeps /tmp/once.
    await host.setWorkspaceRoot("/tmp/later-default");
    const stored = await host.getTask(created.id);
    expect(stored?.workspaceRoot).toBe("/tmp/once");
    const provision = await host.getTaskProvision(created.id);
    expect(provision?.root).toBe("/tmp/once");
  });

  it("reads the header from the record: name/repo/branch/ready/code-change", async () => {
    const host = createMemoryHost();
    const header = await host.getTaskHeader("release");
    expect(header.taskId).toBe("release");
    expect(header.name).toBe("发布前检查");
    expect(header.repos).toContain("front-monorepo");
    expect(header.branch).toBe("task/task-a1f92c3d");
    expect(header.ready).toBe(true);
    expect(header.changedFiles.length).toBeGreaterThan(0);
    await expect(host.getTaskHeader("missing-task")).rejects.toThrow("missing-task");
  });

  it("keeps the no-Node boundary: the provision rules stay dependency-free", () => {
    // Static assertion lives in `no-node-in-renderer.test.ts`; this keeps the
    // seam discoverable from the provision tests without a `?raw` import.
    expect(typeof previewTaskFormPaths).toBe("function");
  });
});
