import { createMemoryHost, defaultWorkspaceRoot } from "../data/memoryHost";

describe("memory Host adapter", () => {
  it("does not execute rejected or expired approvals", async () => {
    const host = createMemoryHost();
    const rejected = await host.resolveApproval("approval-deploy", "rejected");
    expect(rejected.status).toBe("rejected");
    expect(rejected.executed).toBe(false);
    const expired = await host.resolveApproval("approval-migrate", "expired");
    expect(expired.status).toBe("expired");
    expect(expired.executed).toBe(false);
  });

  it("only executes an explicitly approved request", async () => {
    const host = createMemoryHost();
    const approved = await host.resolveApproval("approval-deploy", "approved");
    expect(approved.status).toBe("approved");
    expect(approved.executed).toBe(true);
    const session = await host.getSession("release", "deploy");
    expect(session?.runState).toBe("running");
  });

  it("only previews cleanup for archived tasks and retains code conservatively", async () => {
    const host = createMemoryHost();
    await expect(host.previewCleanup("release")).rejects.toThrow("只有已归档任务可清理");
    const preview = await host.previewCleanup("legacy-auth");
    expect(preview.find((item) => item.resource === "代码")?.action).toContain("保留");
    expect(preview).toHaveLength(7);
  });

  it("expires pending approvals and stops services when a task is archived", async () => {
    const host = createMemoryHost();
    await host.archiveTask("release");
    const task = await host.getTask("release");
    expect(task?.archived).toBe(true);
    expect(task?.services.every((service) => !service.running)).toBe(true);
    const approvals = await host.listApprovals("release");
    expect(approvals.every((approval) => approval.status !== "pending")).toBe(true);
    const schedules = await host.getSchedules();
    expect(schedules.find((schedule) => schedule.taskId === "release")?.enabled).toBe(false);
  });

  it("blocks scheduling and immediate runs for archived tasks until restored", async () => {
    const host = createMemoryHost();
    const before = (await host.getTask("release"))?.sessions.length ?? 0;
    await host.archiveTask("release");
    await expect(host.runScheduleNow("schedule-1")).rejects.toThrow("已归档任务不能通过「立即运行」绕过恢复");
    await host.restoreTask("release");
    const run = await host.runScheduleNow("schedule-1");
    expect(run.result).toBe("completed");
    const task = await host.getTask("release");
    expect(task?.sessions.length).toBe(before + 1);
  });

  it("keeps cross-project attention items pointing at their task and session", async () => {
    const host = createMemoryHost();
    const attention = await host.getAttention();
    expect(attention.some((item) => item.kind === "approval" && item.taskId === "release")).toBe(true);
    expect(attention.some((item) => item.kind === "failed" && item.sessionId === "failed")).toBe(true);
  });

  it("streams agent output as ordered deltas before the run settles", async () => {
    const host = createMemoryHost();
    const deltas: string[] = [];
    host.subscribe((event) => {
      if (event.type === "message-delta") deltas.push(event.delta);
    });
    const result = await host.sendMessage("release", "main", "检查构建", []);
    expect(result.state).toBe("completed");
    expect(deltas.join("")).toContain("正在准备环境");
    const session = await host.getSession("release", "main");
    expect(session?.runState).toBe("completed");
    expect(session?.messages.at(-1)?.text).toContain("检查构建");
  });

  it("reports the failed scope and keeps the session able to continue", async () => {
    const host = createMemoryHost();
    const result = await host.sendMessage("release", "failed", "修复构建并重试", []);
    expect(result.state).toBe("failed");
    expect(result.run.failedScope).toContain("front-monorepo");
    const session = await host.getSession("release", "failed");
    expect(session?.runState).toBe("failed");
  });

  it("keeps scheduled runs isolated per trigger session", async () => {
    const host = createMemoryHost();
    const first = await host.runScheduleNow("schedule-1");
    const second = await host.runScheduleNow("schedule-1");
    expect(first.sessionId).not.toBe(second.sessionId);
    const task = await host.getTask("release");
    expect(task?.sessions.filter((session) => session.id === first.sessionId)).toHaveLength(1);
  });

  it("seeds a dense session history and execution log for the virtualized scenarios", async () => {
    const host = createMemoryHost();
    const task = await host.getTask("release");
    expect(task?.sessions.length).toBeGreaterThan(40);
    const workspace = await host.getWorkspace();
    expect(workspace.scheduledRuns.length).toBeGreaterThan(30);
    expect(workspace.scheduledRuns.some((run) => run.result === "failed")).toBe(true);
  });

  it("stores the local workspace root as a machine setting", async () => {
    const host = createMemoryHost();
    const initial = await host.getLocalSettings();
    expect(initial.configFile).toBe("~/.pi/dock/config.json");
    const updated = await host.setWorkspaceRoot("  /tmp/pidock-tasks  ");
    expect(updated.workspaceRoot).toBe("/tmp/pidock-tasks");
    expect((await host.getLocalSettings()).workspaceRoot).toBe("/tmp/pidock-tasks");
    await expect(host.setWorkspaceRoot("   ")).rejects.toThrow("请填写完整的任务根目录");
  });

  it("rejects a non-absolute task root and accepts posix, drive, UNC and home paths", async () => {
    const host = createMemoryHost();
    // The prototype's `validWorkspaceRoot` check: a root that is not absolute
    // would create task folders relative to the process working directory.
    for (const invalid of ["Tasks", "../Tasks", "./Tasks", "C:Tasks"]) {
      await expect(host.setWorkspaceRoot(invalid)).rejects.toThrow("完整的任务根目录");
    }
    // Nothing invalid was written.
    expect((await host.getLocalSettings()).workspaceRoot).toBe(defaultWorkspaceRoot);

    for (const root of ["/Users/name/Tasks", "/tmp/pidock-tasks", "D:/Tasks", "D:\\Tasks", "\\\\host\\share", "~/PiDockTasks"]) {
      expect((await host.setWorkspaceRoot(root)).workspaceRoot).toBe(root);
    }
  });

  it("exposes task files and simulated terminal execution behind the adapter", async () => {
    const host = createMemoryHost();
    const task = await host.getTask("release");
    expect(task?.files.length).toBeGreaterThan(0);
    expect(task?.browserPages.length).toBeGreaterThan(0);
    const reference = await host.createFileReference("release");
    expect(reference.label).toBe(task?.files[0]?.path);
    const output = await host.runTerminalCommand("release", "pnpm test");
    expect(output.join("\n")).toContain("pnpm test");
  });

  it("saves config layers, versioning only the shared template", async () => {
    const host = createMemoryHost();
    await host.saveEnvironmentConfig({
      environmentId: "testing",
      scope: "private",
      rows: [{ key: "EXTRA_FLAG", value: "", secret: false }],
    });
    let workspace = await host.getWorkspace();
    expect(workspace.environments.find((item) => item.id === "testing")?.templateVersion).toBe("v12");
    expect(workspace.environments.find((item) => item.id === "testing")?.privateVariables).toEqual([
      { key: "EXTRA_FLAG", value: "", secret: false },
    ]);

    await host.saveEnvironmentConfig({
      environmentId: "testing",
      scope: "shared",
      rows: [{ key: "LOG_LEVEL", value: "trace", secret: false }],
    });
    workspace = await host.getWorkspace();
    expect(workspace.environments.find((item) => item.id === "testing")?.templateVersion).toBe("v13");
    // Existing tasks keep the version they adopted until they opt in.
    expect(workspace.tasks.find((item) => item.id === "release")?.templateVersion).toBe("v12");

    await host.adoptLatestTemplate("release");
    expect((await host.getTask("release"))?.templateVersion).toBe("v13");
  });

  it("stores task-scope overrides per task", async () => {
    const host = createMemoryHost();
    await host.saveEnvironmentConfig({
      environmentId: "testing",
      scope: "task",
      taskId: "release",
      rows: [{ key: "LOCAL_PORT", value: "6000", secret: false }],
    });
    expect((await host.getTask("release"))?.configOverrides).toEqual([{ key: "LOCAL_PORT", value: "6000", secret: false }]);
    expect((await host.getTask("checkout"))?.configOverrides).toEqual([]);
    expect((await host.getTask("release"))?.services[0]?.resolved.find((row) => row.key === "LOCAL_PORT")?.value).toBe("6000");
  });
});
