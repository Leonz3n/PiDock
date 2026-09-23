import { createMemoryHost, defaultWorkspaceRoot } from "../data/memoryHost";
import { describeHistoryAttribution } from "../data/providerState";

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

  it("prints the in-task symlink path alongside the retained original in a directory cleanup preview", async () => {
    const host = createMemoryHost();
    await host.archiveTask("release");
    const preview = await host.previewCleanup("release");
    const symlink = preview.find((item) => item.action === "移除任务内软链接");
    expect(symlink?.detail).toContain("~/PiDockTasks/task-a1f92c3d/dir-atlasdoc");
    expect(symlink?.detail).toContain("保留原目录 /Users/leonz3n/Workspace/atlas-docs");
  });

  it("[PiDock 14] (#17) cleanup keeps the code, removes the chosen records and writes a receipt", async () => {
    const host = createMemoryHost();
    await host.archiveTask("release");
    const preview = await host.previewCleanup("release", { exportSessions: false, exportDrafts: false, exportUsage: false });
    expect(preview.find((item) => item.id === "code")?.disposition).toBe("keep-copy");
    expect(preview.find((item) => item.id === "usage")?.detail).toContain("未选择导出");

    const result = await host.runCleanup("release", { exportSessions: false, exportDrafts: false, exportUsage: false });

    expect(result.receipt).toMatchObject({ exports: [], partialFailure: true });
    expect(result.receipt?.keptPosition).toContain(".pidock-kept");
    // The code worktree is never removed by a cleanup: only the "code" and
    // "worktree" rows are dispositions other than `remove`.
    expect(result.receipt?.removed).not.toContain("code");
    expect(result.recovery.map((entry) => entry.item)).toEqual(["browser"]);
    const task = await host.getTask("release");
    expect(task?.sessions).toHaveLength(0);
    expect((await host.lifecycleState("release")).usageDetails).toBe(0);
  });

  it("[PiDock 14] (#17) reports the lifecycle readout: archive state, receipts and recovery entries", async () => {
    const host = createMemoryHost();
    expect((await host.lifecycleState("release")).archived).toBe(false);
    await host.archiveTask("release");
    const archived = await host.lifecycleState("release");
    expect(archived.archived).toBe(true);
    expect(archived.schedulePaused).toBe(true);
    await host.restoreTask("release");
    const restored = await host.lifecycleState("release");
    expect(restored.archived).toBe(false);
    // Restoring never resumes scheduling on its own.
    expect(restored.schedulePaused).toBe(true);
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

  it("[PiDock 17] (#19 box 5) clears the unread completion it read and keeps a pending item", async () => {
    const host = createMemoryHost();
    // A settled turn leaves the session completed with its unread count, which
    // is exactly the 完成未读 item the attention list shows.
    await host.sendMessage("latency", "main", "检查延迟", []);
    const before = await host.getAttention();
    const unread = before.find((item) => item.taskId === "latency" && item.kind === "completed-unread");
    const approval = before.find((item) => item.kind === "approval");
    expect(unread).toBeDefined();
    expect(approval).toBeDefined();

    const read = await host.markAttentionRead("latency", [unread?.id as string, approval?.id as string]);
    // Reading clears only the unread kind; the pending confirmation still needs
    // handling (待确认须处理后移除).
    expect(read.cleared).toEqual([unread?.id]);
    expect(read.kept).toEqual([approval?.id]);
    const after = await host.getAttention();
    expect(after.some((item) => item.id === unread?.id)).toBe(false);
    expect(after.some((item) => item.id === approval?.id)).toBe(true);
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

  it("[PiDock 02] records a stable per-call provider/model/usage entry from the first call", async () => {
    const host = createMemoryHost();
    const before = (await host.getUsage({ taskId: "release", sessionId: "main" })).length;
    const session = await host.getSession("release", "main");
    const result = await host.sendMessage("release", "main", "检查构建", []);
    expect(result.state).toBe("completed");
    const after = await host.getUsage({ taskId: "release", sessionId: "main" });
    expect(after.length).toBe(before + 1);
    const latest = after[after.length - 1];
    expect(latest).toMatchObject({
      id: result.run.id,
      taskId: "release",
      projectId: "atlas",
      sessionId: "main",
      providerId: session?.providerId,
      model: session?.model,
    });
    expect(latest.at).toBe(result.run.startedAt);
  });

  it("[PiDock 02] refuses a side-effecting turn in a read-only session at the tool layer", async () => {
    const host = createMemoryHost();
    const usageBefore = (await host.getUsage({ taskId: "release", sessionId: "main" })).length;
    const messagesBefore = (await host.getSession("release", "main"))?.messages.length ?? 0;
    await host.setSessionPermission("release", "main", "read");
    await expect(host.sendMessage("release", "main", "删除文件", [])).rejects.toThrow("只读会话");
    // Nothing executes: no new message, no usage record, no run started.
    expect((await host.getSession("release", "main"))?.runState).toBe("idle");
    expect((await host.getSession("release", "main"))?.messages).toHaveLength(messagesBefore);
    expect(await host.getUsage({ taskId: "release", sessionId: "main" })).toHaveLength(usageBefore);
  });

  it("[PiDock 02] holds the task write right in one session until it settles", async () => {
    const host = createMemoryHost();
    const extra = await host.createSession("release");
    // Seed a lingering approval run on the seeded deploy session (its
    // scripted outcome is "approval" and keeps the task write right).
    const waiting = await host.sendMessage("release", "deploy", "部署到 staging", []);
    expect(waiting.state).toBe("approval");
    // [PiDock 09] (#11): the refusal names the holder, and the queued session
    // is visible in the coordination view with its queue position.
    await expect(host.sendMessage("release", extra.id, "并行改动", [])).rejects.toThrow(
      "同一任务写操作权由会话 deploy 持有",
    );
    const queued = await host.sessionWriteStates("release");
    expect(queued.writeLock.owner).toBe("deploy");
    expect(queued.writeLock.waiting).toEqual([extra.id]);
    expect(queued.sessions.find((state) => state.sessionId === extra.id)).toMatchObject({ role: "waiting", queuePosition: 1 });
    // Releasing via stop lets the other session run (completes + frees) and
    // clears the queue with the right.
    await host.stopRun("release", "deploy");
    const released = await host.sessionWriteStates("release");
    expect(released.writeLock).toMatchObject({ owner: null, waiting: [] });
    const ok = await host.sendMessage("release", extra.id, "并行改动", []);
    expect(ok.state).toBe("completed");
  });

  it("[PiDock 09] (#11) archives the last session without creating a replacement", async () => {
    const host = createMemoryHost();
    const task = await host.getTask("release");
    const sessions = task?.sessions ?? [];
    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) {
      // A running/waiting session must be stopped before it can be archived.
      if (session.runState === "running" || session.runState === "approval") await host.stopRun("release", session.id);
      await host.setSessionArchived("release", session.id, true);
    }
    const after = await host.getTask("release");
    // 收口规则：最后一个会话归档后仍可带归档标记查看，不自动新建空会话。
    expect(after?.sessions).toHaveLength(sessions.length);
    expect(after?.sessions.every((session) => session.archived)).toBe(true);
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

  it("rejects a shared-template save carrying a secret key (fail-closed, Host parity)", async () => {
    const host = createMemoryHost();
    await expect(
      host.saveEnvironmentConfig({
        environmentId: "testing",
        scope: "shared",
        rows: [{ key: "MY_PRIVATE_KEY", value: "s3cr3t", secret: false }],
      }),
    ).rejects.toThrow("secret-in-shared");
    // Version untouched by the rejected save.
    const workspace = await host.getWorkspace();
    expect(workspace.environments.find((item) => item.id === "testing")?.templateVersion).toBe("v12");
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

  it("upserts in-memory service startup recipes and rejects an empty name", async () => {
    const host = createMemoryHost();
    const before = (await host.getWorkspace()).environments.find((item) => item.id === "testing")?.recipes.length ?? 0;
    const created = await host.saveServiceRecipe({
      environmentId: "testing",
      recipe: { name: "  saas-web-worker  ", repo: "front-monorepo", runtime: "Node.js", startNote: "使用项目脚本启动", runType: "常驻服务", healthCheck: "HTTP", dependencyBinding: "" },
    });
    expect(created.name).toBe("saas-web-worker");
    let environment = (await host.getWorkspace()).environments.find((item) => item.id === "testing");
    expect(environment?.recipes).toHaveLength(before + 1);

    await host.saveServiceRecipe({
      environmentId: "testing",
      recipe: { id: created.id, name: "saas-web-worker-2", runtime: "Go", startNote: "读取仓库默认 config.yaml", runType: "准备步骤", healthCheck: "gRPC health", dependencyBinding: "INVOICE → invoice-service" },
    });
    environment = (await host.getWorkspace()).environments.find((item) => item.id === "testing");
    expect(environment?.recipes.find((recipe) => recipe.id === created.id)?.name).toBe("saas-web-worker-2");
    expect(environment?.recipes).toHaveLength(before + 1);

    await expect(
      host.saveServiceRecipe({ environmentId: "testing", recipe: { name: "   ", runtime: "Go", startNote: "x", runType: "常驻服务", healthCheck: "HTTP", dependencyBinding: "" } }),
    ).rejects.toThrow("请填写服务名称");
  });

  it("simulates a .vscode import from registered repos without scanning them", async () => {
    const host = createMemoryHost();
    const added = await host.importVscodeConfig("staging-preview");
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((recipe) => recipe.startNote.includes(".vscode"))).toBe(true);
    const environment = (await host.getWorkspace()).environments.find((item) => item.id === "staging-preview");
    expect(environment?.recipes.map((recipe) => recipe.name)).toEqual(added.map((recipe) => recipe.name));
    // A second import adds nothing new (names already present).
    expect(await host.importVscodeConfig("staging-preview")).toHaveLength(0);
  });

  it("creates, edits and deletes a project, blocking deletion while tasks remain", async () => {
    const host = createMemoryHost();
    const created = await host.saveProject({
      name: "新项目",
      description: "说明",
      repositoryIds: ["apis"],
      directories: [{ name: "资料", path: "/Users/leonz3n/Workspace/资料" }],
    });
    expect(created.name).toBe("新项目");
    expect(created.repositories.map((item) => item.id)).toEqual(["apis"]);
    expect(created.directories).toHaveLength(1);

    await expect(host.saveProject({ name: "Atlas Web", description: "", repositoryIds: [], directories: [] })).rejects.toThrow(
      "已有同名项目",
    );

    const edited = await host.saveProject({ id: created.id, name: "新项目 2", description: "改后", repositoryIds: [], directories: [] });
    expect(edited.name).toBe("新项目 2");
    expect(edited.repositories).toHaveLength(0);

    // The seeded atlas project still has tasks, so it cannot be removed.
    await expect(host.deleteProject("atlas")).rejects.toThrow("个关联任务");
    await host.deleteProject(created.id);
    expect((await host.getWorkspace()).projects.some((item) => item.id === created.id)).toBe(false);
  });

  it("keeps a repository used by a task linked when editing a project", async () => {
    const host = createMemoryHost();
    await expect(
      host.saveProject({
        id: "atlas",
        name: "Atlas Web",
        description: "微服务开发工作台",
        repositoryIds: ["front-monorepo", "invoice-service", "shipment-service"],
        directories: [{ id: "atlas-docs", name: "Atlas 设计资料", path: "/Users/leonz3n/Workspace/atlas-docs" }],
      }),
    ).rejects.toThrow("任务使用中的仓库不能解除关联");
  });

  it("creates and edits an environment while keeping task template versions", async () => {
    const host = createMemoryHost();
    const created = await host.saveEnvironment({ projectId: "atlas", name: "集成环境", description: "集成" });
    expect(created.templateVersion).toBe("v1");
    await expect(host.saveEnvironment({ projectId: "atlas", name: "集成环境", description: "dup" })).rejects.toThrow("同名环境");
    const before = await host.getTask("release");
    const edited = await host.saveEnvironment({ id: "testing", projectId: "atlas", name: "测试环境 2", description: "说明" });
    expect(edited.name).toBe("测试环境 2");
    expect((await host.getTask("release"))?.templateVersion).toBe(before?.templateVersion);

    // A referenced environment cannot be deleted; the unreferenced one can.
    await expect(host.deleteEnvironment("testing")).rejects.toThrow("个任务正在引用此环境");
    await host.deleteEnvironment("staging-preview");
    expect((await host.getWorkspace()).environments.some((item) => item.id === "staging-preview")).toBe(false);
  });

  it("adds a capability as pending review, never auto-loaded", async () => {
    const host = createMemoryHost();
    const added = await host.addCapability({
      kind: "mcp",
      name: "Linear",
      source: "npx @linear/mcp",
      scope: "仅当前项目",
      sourceKind: "project",
      bridge: { extensionId: "cap-2", command: "npx @linear/mcp" },
    });
    expect(added.status).toBe("pending-review");
    expect(added.kind).toBe("mcp");
    await expect(host.addCapability({ kind: "skill", name: "  ", source: "x", scope: "所有项目" })).rejects.toThrow("名称和来源");
    const workspace = await host.getWorkspace();
    expect(workspace.capabilities.find((item) => item.id === added.id)?.status).toBe("pending-review");
  });

  it("[PiDock 16] (#18) refuses an MCP server without a bridge and a literal credential", async () => {
    const host = createMemoryHost();
    await expect(host.addCapability({ kind: "mcp", name: "direct", source: "npx x", scope: "仅当前项目" })).rejects.toThrow("bridge Extension");
    // An empty bridge id is the shape the picker produces when no Extension is
    // enabled, so it must be refused here too instead of stored.
    await expect(
      host.addCapability({ kind: "mcp", name: "blank", source: "npx x", scope: "仅当前项目", bridge: { extensionId: "", command: "npx x" } }),
    ).rejects.toThrow("bridge Extension");
    await expect(
      host.addCapability({ kind: "mcp", name: "leaky", source: "npx x", scope: "仅当前项目", bridge: { extensionId: "cap-2", command: "npx x" }, authRef: "https://user:pass@example.com" }),
    ).rejects.toThrow("不保存密钥明文");
    const ok = await host.addCapability({ kind: "mcp", name: "linear", source: "npx x", scope: "仅当前项目", bridge: { extensionId: "cap-2", command: "npx x" }, authRef: "linear-token" });
    expect(ok.authRef).toBe("linear-token");
  });

  it("[PiDock 16] (#18) defers a capability change until no turn is running, then applies it", async () => {
    const host = createMemoryHost();
    // release/deploy is seeded waiting for an approval, so the boundary is busy.
    await host.setCapabilityEnabled("cap-1", false);
    const busy = (await host.getCapabilities()).find((item) => item.id === "cap-1")!;
    expect(busy.status).toBe("enabled");
    expect(busy.pendingChange).toEqual({ kind: "disable", applyAt: "idle" });

    await host.stopRun("release", "deploy");
    const settled = (await host.getCapabilities()).find((item) => item.id === "cap-1")!;
    expect(settled.status).toBe("disabled");
    expect(settled.pendingChange).toBeUndefined();
  });

  it("[PiDock 16] (#18) installs only a package version and retries MCP through its bridge", async () => {
    const host = createMemoryHost();
    await host.stopRun("release", "deploy");
    await expect(host.installCapability("cap-1")).rejects.toThrow("只有 Package 管理安装版本");
    const installed = await host.installCapability("cap-6");
    expect(installed.installedVersion).toBe("2.4.1");
    // A declared package keeps its review state; only an update turns it enabled.
    expect(installed.status).toBe("pending-review");
    const updated = await host.installCapability("cap-3");
    expect(updated.installedVersion).toBe("1.9.0");
    expect(updated.status).toBe("enabled");

    const connected = await host.retryMcpConnection("cap-4");
    expect(connected.connection).toMatchObject({ state: "connected", attempts: 3 });
    await expect(host.retryMcpConnection("cap-1")).rejects.toThrow("只有 MCP Server");
  });

  it("[PiDock 16] (#18) re-checks sources, repairs recovered rows and keeps same names apart", async () => {
    const host = createMemoryHost();
    await host.addCapability({ kind: "skill", name: "code-review", source: "额外来源 ~/.team/skills", scope: "所有项目", sourceKind: "extra" });
    const before = await host.getCapabilities();
    expect(before.filter((item) => item.name === "code-review").length).toBe(2);
    expect(before.find((item) => item.id === "cap-5")?.present).toBe(false);

    await host.recheckCapabilities();
    const after = await host.getCapabilities();
    expect(after.find((item) => item.id === "cap-5")).toMatchObject({ present: true, verified: true });
    expect(after.find((item) => item.id === "cap-4")?.connection?.state).toBe("connected");
    // Repairing one source never merges a same-named row from another source.
    expect(after.filter((item) => item.name === "code-review").length).toBe(2);
  });

  it("creates, edits and removes a provider", async () => {
    const host = createMemoryHost();
    const created = await host.saveProvider({
      name: "团队网关",
      protocol: "openai-responses",
      baseUrl: "https://gateway.example.com/v1",
      enabled: true,
      models: [{ id: "团队模型", contextWindow: 128 }],
    });
    expect(created.enabled).toBe(true);
    expect(created.models[0].id).toBe("团队模型");

    const edited = await host.saveProvider({
      id: created.id,
      name: "团队网关 2",
      protocol: "openai-responses",
      baseUrl: "https://gateway.example.com/v2",
      enabled: false,
      models: [{ id: "团队模型", contextWindow: 64 }],
    });
    expect(edited.enabled).toBe(false);
    expect(edited.models[0].contextWindow).toBe(64);

    await expect(
      host.saveProvider({
        name: "x",
        protocol: "openai-responses",
        baseUrl: "https://gateway.example.com/v1",
        enabled: true,
        models: [{ id: "a", contextWindow: 0 }],
      }),
    ).rejects.toThrow("上下文窗口必须为正整数");
    // Missing address is reported with its own locatable message, and a literal
    // credential is rejected instead of being stored as an auth reference.
    await expect(host.saveProvider({ name: "x", protocol: "openai-responses", baseUrl: "", enabled: true, models: [{ id: "a", contextWindow: 8 }] })).rejects.toThrow(
      "请填写服务地址",
    );
    await expect(
      host.saveProvider({
        name: "x",
        protocol: "openai-responses",
        baseUrl: "https://gateway.example.com/v1",
        authRef: "sk-live-abcdefghijklmnop",
        enabled: true,
        models: [{ id: "a", contextWindow: 8 }],
      }),
    ).rejects.toThrow("认证引用不能是凭据明文");

    await host.removeProvider(created.id);
    expect((await host.getWorkspace()).providers.some((item) => item.id === created.id)).toBe(false);
  });

  it("keeps the session's provider id when its configuration is removed (never reroutes)", async () => {
    const host = createMemoryHost();
    await host.removeProvider("provider-anthropic");
    const session = await host.getSession("release", "main");
    // [PiDock 11] #9: a removed configuration is reported unavailable through
    // the attribution helper instead of silently switching the session to
    // another account.
    expect(session?.providerId).toBe("provider-anthropic");
    expect((await host.getWorkspace()).providers.some((item) => item.id === "provider-anthropic")).toBe(false);
    const attribution = describeHistoryAttribution((await host.getWorkspace()).providers, {
      providerId: "provider-anthropic",
      model: "Claude Sonnet",
    });
    expect(attribution).toMatchObject({ providerId: "provider-anthropic", providerName: null, availability: "missing" });
  });

  it("sets session permission, model and thinking in memory", async () => {
    const host = createMemoryHost();
    await host.setSessionPermission("release", "main", "read");
    expect((await host.getSession("release", "main"))?.permission).toBe("read");
    await host.setSessionPermission("release", "main", "auto");
    expect((await host.getSession("release", "main"))?.permission).toBe("auto");

    // [PiDock 11] #9: the seeded session already occupies 24.8k, so the 16k
    // target is over-limit and the switch is refused without changing anything.
    await expect(host.setSessionModel("release", "main", "provider-openai", "团队轻量模型")).rejects.toThrow("超过目标模型上限");
    expect((await host.getSession("release", "main"))?.model).toBe("Claude Sonnet");

    await host.setSessionModel("release", "main", "provider-anthropic", "Claude Haiku");
    const session = await host.getSession("release", "main");
    expect(session?.model).toBe("Claude Haiku");
    expect(session?.switchEvents).toHaveLength(1);
    expect(session?.switchEvents?.[0]).toMatchObject({
      from: { providerId: "provider-anthropic", model: "Claude Sonnet" },
      to: { providerId: "provider-anthropic", model: "Claude Haiku" },
    });

    // Anthropic models declare no tiers (catalog unknown), so an explicit
    // level follows the catalog while clearing it is refused.
    await host.setSessionThinking("release", "main", "high");
    expect((await host.getSession("release", "main"))?.thinking).toBe("high");
    await expect(host.setSessionThinking("release", "main", "")).rejects.toThrow("不能声明已关闭推理");
    // The local model declares off/low/medium/high, so an undeclared tier is
    // refused and a declared one is accepted.
    await host.setSessionModel("release", "main", "provider-local", "本地 Qwen");
    await expect(host.setSessionThinking("release", "main", "max")).rejects.toThrow("模型未声明该推理档位");
    await host.setSessionThinking("release", "main", "medium");
    expect((await host.getSession("release", "main"))?.thinking).toBe("medium");
    await expect(host.setSessionModel("release", "main", "provider-openai", "不存在")).rejects.toThrow("模型不可用");
  });

  it("creates a new session at the default permission tier", async () => {
    const host = createMemoryHost();
    await host.setSessionPermission("release", "main", "auto");
    const created = await host.createSession("release");
    expect(created.permission).toBe("default");
  });

  it("edits a scheduled task in memory and syncs the task name", async () => {
    const host = createMemoryHost();
    const saved = await host.saveSchedule({
      id: "schedule-1",
      name: "发布前检查 2",
      rule: "每周五 16:00",
      timezone: "UTC",
      prompt: "新的提示词",
      providerId: "provider-openai",
      model: "团队轻量模型",
      permission: "read",
    });
    expect(saved.rule).toBe("每周五 16:00");
    expect(saved.timezone).toBe("UTC");
    expect(saved.permission).toBe("read");
    expect((await host.getTask("release"))?.name).toBe("发布前检查 2");
    await expect(host.saveSchedule({ id: "schedule-1", rule: "", timezone: "UTC", prompt: "p", providerId: "provider-openai", model: "团队轻量模型", permission: "read" })).rejects.toThrow(
      "执行周期",
    );
  });

  it("creates a scheduled task from the new-task input", async () => {
    const host = createMemoryHost();
    const task = await host.createTask({
      projectId: "atlas",
      name: "每日巡检",
      repoIds: [],
      directoryIds: [],
      environmentId: "testing",
      schedule: {
        rule: "每日 08:00",
        timezone: "Asia/Shanghai",
        prompt: "检查昨日错误",
        providerId: "provider-anthropic",
        model: "Claude Sonnet",
        permission: "read",
      },
    });
    expect(task.type).toBe("scheduled");
    expect(task.permission).toBe("read");
    // The prototype's scheduled task starts with one placeholder session.
    expect(task.sessions.map((session) => session.name)).toEqual(["等待首次执行"]);
    const schedule = (await host.getWorkspace()).schedules.find((item) => item.taskId === task.id);
    expect(schedule).toMatchObject({ rule: "每日 08:00", prompt: "检查昨日错误", permission: "read", enabled: true });
    await expect(
      host.createTask({
        projectId: "atlas",
        name: "缺周期",
        repoIds: [],
        directoryIds: [],
        environmentId: "testing",
        schedule: { rule: "", timezone: "Asia/Shanghai", prompt: "p", providerId: "provider-anthropic", model: "Claude Sonnet", permission: "default" },
      }),
    ).rejects.toThrow("执行周期");
  });

  it("adds repositories and directories to an existing task", async () => {
    const host = createMemoryHost();
    const task = await host.createTask({ projectId: "atlas", name: "仅目录", repoIds: [], directoryIds: ["atlas-docs"], environmentId: "testing" });
    expect(task.services).toHaveLength(0);
    await host.addTaskSources(task.id, { repoIds: ["apis"], directoryIds: ["atlas-docs"] });
    const updated = await host.getTask(task.id);
    expect(updated?.repos).toEqual(["apis"]);
    expect(updated?.services.length).toBeGreaterThan(0);
  });
});
