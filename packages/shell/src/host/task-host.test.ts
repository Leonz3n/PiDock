import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskWorkspaceHost, isPathInsideTask, memoryTaskStore } from "./task-host.js";
import {
  listSessionIdsOnDisk,
  parseSessionSnapshot,
  parseTaskRecord,
  readSessionSnapshotOnDisk,
  readTaskRecordOnDisk,
  sessionFilePath,
  taskFilePath,
  writeSessionSnapshotOnDisk,
  writeTaskRecordOnDisk,
  buildTaskDiskRecord,
} from "./task-store.js";
import { PiSessionChannel, resetPiSequencesForTests } from "../main/pi-session.js";
import { assertProvisionPlanSafe, planWorktreeCreation } from "../main/task-provision.js";

const TASK_ID = "task-a";
const TASK_DIR = join(mkdtempSync(join(tmpdir(), "pidock-s2-")), "task-abcdef12");

function host() {
  return new TaskWorkspaceHost(TASK_ID, TASK_DIR, memoryTaskStore(), () => "2026-09-22T10:00:00+08:00");
}

function provisionInput() {
  return {
    name: "发布前检查",
    dirId: "task-abcdef12",
    remoteBranch: "main",
    fetchedCommit: "a5a4a0d1234",
    repos: ["front-monorepo"],
  };
}

beforeEach(() => {
  resetPiSequencesForTests();
});

describe("S6 final wiring: Host approval listing", () => {
  it("lists persisted approvals across sessions and resolves one by id", () => {
    const taskHost = host();
    taskHost.provision(provisionInput());
    // Session "main" mints a pending approval via an in-task exec target.
    const turn = taskHost.sendMessage("main", "运行命令", {
      tool: "exec.run",
      target: `${TASK_DIR}/run.sh`,
      execute: (call) => ({
        tool: call.tool,
        kind: call.kind,
        target: call.target,
        contentVersion: call.contentVersion,
        output: "pending",
      }),
    });
    expect(turn.state).toBe("approval");
    const listed = taskHost.listApprovals();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ tool: "exec.run", target: `${TASK_DIR}/run.sh`, status: "pending", sessionId: "main" });
    expect(taskHost.listApprovals("main")).toHaveLength(1);
    expect(taskHost.listApprovals("other")).toHaveLength(0);
    const found = taskHost.getApproval(turn.approvalId ?? "");
    expect(found?.id).toBe(turn.approvalId);
    expect(taskHost.getApproval("approval-404")).toBeUndefined();
    expect(() => taskHost.getApproval(" ")).toThrow("invalid-payload");
  });
});

// Seam: S2 Host wiring (provision persistence, Host-owned cross-session
// lock, exact-session restore) + disk store shape.

describe("task-store record shape", () => {
  it("round-trips a task record through disk", () => {
    const record = buildTaskDiskRecord({
      taskId: TASK_ID,
      name: "发布前检查",
      dirId: "task-abcdef12",
      branch: "task/task-abcdef12",
      root: "/tmp/pidock-s2",
      taskDir: TASK_DIR,
      remoteBranch: "main",
      baseCommit: "a5a4a0d1234",
      repos: ["front-monorepo"],
      now: "2026-09-22T10:00:00+08:00",
    });
    const dir = mkdtempSync(join(tmpdir(), "pidock-store-"));
    writeTaskRecordOnDisk(dir, record);
    expect(taskFilePath(dir)).toBe(join(dir, "task.json"));
    expect(readTaskRecordOnDisk(dir)).toEqual(record);
    expect(readTaskRecordOnDisk(join(tmpdir(), "pidock-missing-dir-xyz"))).toBeNull();
  });

  it("rejects malformed task records and session snapshots", () => {
    expect(() => parseTaskRecord(JSON.stringify({ taskId: "" }))).toThrow("invalid-payload");
    const record = buildTaskDiskRecord({
      taskId: TASK_ID,
      name: "发布前检查",
      dirId: "task-abcdef12",
      branch: "task/task-abcdef12",
      root: "/tmp/pidock-s2",
      taskDir: TASK_DIR,
      remoteBranch: "main",
      baseCommit: "a5a4a0d1234",
      repos: ["front-monorepo"],
      now: "2026-09-22T10:00:00+08:00",
    });
    const { createdAt: _droppedTaskTs, ...noTaskTs } = record;
    expect(() => parseTaskRecord(JSON.stringify(noTaskTs))).toThrow("createdAt");
    expect(() => parseSessionSnapshot(JSON.stringify({ taskId: TASK_ID }))).toThrow("invalid-payload");
    const channel = new PiSessionChannel({
      taskId: TASK_ID,
      sessionId: "main",
      taskDir: TASK_DIR,
      providerId: "provider-local",
      model: "test-model",
      now: () => "2026-09-22T10:00:00+08:00",
    });
    const { createdAt: _droppedSessionTs, ...noSessionTs } = JSON.parse(
      JSON.stringify(channel.snapshot()),
    ) as Record<string, unknown>;
    expect(() => parseSessionSnapshot(JSON.stringify(noSessionTs))).toThrow("createdAt");
    expect(() =>
      parseSessionSnapshot(JSON.stringify({ ...channel.snapshot(), permission: "owner" })),
    ).toThrow("permission");
    expect(() =>
      parseSessionSnapshot(JSON.stringify({ ...channel.snapshot(), runState: "flying" })),
    ).toThrow("runState");
    // credentialRef is optional on disk but non-empty when present.
    const withRef = { ...channel.snapshot(), credentialRef: "PIDOCK_PI_TOKEN" };
    expect(parseSessionSnapshot(JSON.stringify(withRef)).credentialRef).toBe("PIDOCK_PI_TOKEN");
    expect(() =>
      parseSessionSnapshot(JSON.stringify({ ...channel.snapshot(), credentialRef: "  " })),
    ).toThrow("credentialRef");
    void _droppedTaskTs;
    void _droppedSessionTs;
  });

  it("round-trips a session snapshot and lists persisted session ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "pidock-sess-"));
    const channel = new PiSessionChannel({
      taskId: TASK_ID,
      sessionId: "main",
      taskDir: dir,
      providerId: "provider-local",
      model: "test-model",
      now: () => "2026-09-22T10:00:00+08:00",
    });
    channel.runTurn({ text: "hi" });
    writeSessionSnapshotOnDisk(dir, channel.snapshot());
    expect(sessionFilePath(dir, "main")).toBe(join(dir, "sessions", "main.json"));
    expect(readSessionSnapshotOnDisk(dir, "main")?.sessionId).toBe("main");
    expect(readSessionSnapshotOnDisk(dir, "other")).toBeNull();
    expect(listSessionIdsOnDisk(dir)).toEqual(["main"]);
    expect(listSessionIdsOnDisk(join(tmpdir(), "pidock-missing-dir-xyz"))).toEqual([]);
    expect(() => parseSessionSnapshot(JSON.stringify({ taskId: TASK_ID }))).toThrow("invalid-payload");
    expect(() => sessionFilePath(dir, "../evil")).toThrow("invalid-path");
  });

  it("writes real JSON files to disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "pidock-disk-"));
    const record = buildTaskDiskRecord({
      taskId: TASK_ID,
      name: "发布前检查",
      dirId: "task-abcdef12",
      branch: "task/task-abcdef12",
      root: dir,
      taskDir: join(dir, "task-abcdef12"),
      remoteBranch: "main",
      baseCommit: "a5a4a0d1234",
      repos: [],
      now: "2026-09-22T10:00:00+08:00",
    });
    writeTaskRecordOnDisk(record.taskDir, record);
    const raw = readFileSync(join(record.taskDir, "task.json"), "utf8");
    expect(JSON.parse(raw).baseCommit).toBe("a5a4a0d1234");
  });
});

describe("TaskWorkspaceHost provision", () => {
  it("persists the task record with branch, baseline and pinned commit", () => {
    const taskHost = host();
    const { record } = taskHost.provision(provisionInput());
    expect(record.name).toBe("发布前检查");
    expect(record.dirId).toBe("task-abcdef12");
    expect(record.branch).toBe("task/task-abcdef12");
    expect(record.remoteBranch).toBe("main");
    expect(record.baseCommit).toBe("a5a4a0d1234");
    expect(record.taskDir).toBe(TASK_DIR);
    expect(taskHost.taskRecord()).toEqual(record);
  });

  it("returns an executable plan with real cwds (never empty) via planWorktreeCreation", () => {
    const { plan, record } = host().provision({
      ...provisionInput(),
      mainCheckouts: { "front-monorepo": "/Users/name/Workspace/repo" },
    });
    expect(plan.ops).toHaveLength(3);
    expect(plan.ops.map((op) => op.kind)).toEqual(["fetch", "branch", "worktree"]);
    for (const op of plan.ops) {
      expect(op.cwd, op.kind).toBe("/Users/name/Workspace/repo");
    }
    // `mainCheckoutDir` is the validated task root (never ""); per-repo
    // cwds carry the real main checkout dirs.
    expect(plan.mainCheckoutDir).toBe(record.root);
    const worktree = plan.ops.find((op) => op.kind === "worktree");
    expect(worktree?.args).toContain(`${TASK_DIR}/front-monorepo`);
    expect(() => assertProvisionPlanSafe(plan)).not.toThrow();
  });

  it("keeps the validated task root on an empty-repos plan (never an empty checkout dir)", () => {
    const { plan, record } = host().provision({ ...provisionInput(), repos: [] });
    expect(plan.ops).toHaveLength(0);
    expect(plan.mainCheckoutDir).toBe(record.root);
    expect(plan.mainCheckoutDir.length).toBeGreaterThan(0);
  });

  it("rejects relative/empty mainCheckouts values before they enter an executable plan", () => {
    for (const bad of ["relative/dir", "", "  "]) {
      expect(
        () => host().provision({ ...provisionInput(), mainCheckouts: { "front-monorepo": bad } }),
        bad,
      ).toThrow(/invalid-payload|invalid-root|invalid-path/);
    }
    // "~/tasks" and "." are accepted roots/plans only when they pass
    // `isAbsoluteTaskRoot` + `previewTaskPaths` matching; covered by the
    // `planWorktreeCreation` unit tests below, not the Host path-match.
  });

  it("rejects a mainCheckoutDir that is not an absolute task root", () => {
    expect(() =>
      planWorktreeCreation({
        taskDir: "~/PiDockTasks/task-abcdef12",
        mainCheckoutDir: "relative/dir",
        repoDir: "front-monorepo",
        remoteBranch: "main",
        commit: "a5a4a0d1234",
        branch: "task/task-abcdef12",
      }),
    ).toThrow("mainCheckoutDir");
    expect(() =>
      planWorktreeCreation({
        taskDir: "~/PiDockTasks/task-abcdef12",
        mainCheckoutDir: "",
        repoDir: "front-monorepo",
        remoteBranch: "main",
        commit: "a5a4a0d1234",
        branch: "task/task-abcdef12",
      }),
    ).toThrow("mainCheckoutDir");
  });

  it("preserves createdAt on re-provision and bumps only updatedAt", () => {
    const store = memoryTaskStore();
    const first = new TaskWorkspaceHost(TASK_ID, TASK_DIR, store, () => "2026-09-22T10:00:00+08:00");
    const before = first.provision(provisionInput()).record;
    const second = new TaskWorkspaceHost(TASK_ID, TASK_DIR, store, () => "2026-09-22T11:00:00+08:00");
    const after = second.provision({ ...provisionInput(), now: "2026-09-22T11:00:00+08:00" }).record;
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.updatedAt).toBe("2026-09-22T11:00:00+08:00");
  });

  it("keeps the form on fetch failure instead of creating from a stale ref", () => {
    expect(() => host().provision({ ...provisionInput(), fetchedCommit: "" })).toThrow("fetch-failed");
    expect(host().taskRecord()).toBeNull();
  });

  it("rejects a blank name, a bad dir id and a bad branch", () => {
    expect(() => host().provision({ ...provisionInput(), name: "  " })).toThrow("empty-name");
    expect(() => host().provision({ ...provisionInput(), dirId: "nope" })).toThrow("invalid-path");
    expect(() => host().provision({ ...provisionInput(), branch: "bad branch" })).toThrow("invalid-branch");
  });

  it("rejects provision paths that do not match this Host's task dir", () => {
    expect(() =>
      host().provision({ ...provisionInput(), rootOverride: "/elsewhere/root" }),
    ).toThrow("do not match this Host's task dir");
  });
});

describe("TaskWorkspaceHost sessions and Host-owned lock", () => {
  it("holds the write right across an approval turn, refuses a second session's write, and allows its read", () => {
    const taskHost = host();
    const first = taskHost.sendMessage("main", "运行命令", {
      tool: "exec.run",
      target: `${TASK_DIR}/run.sh`,
      execute: (call) => ({
        tool: call.tool,
        kind: call.kind,
        target: call.target,
        contentVersion: call.contentVersion,
        output: "pending",
      }),
    });
    expect(first.state).toBe("approval");
    expect(taskHost.writeLockOwner).toBe("main");
    // [PiDock 09] (#11) box 3: the second session may keep reading/analyzing
    // (a turn without a side-effecting plan claims no write right)…
    expect(taskHost.sendMessage("second", "先读一下现状").state).toBe("done");
    expect(taskHost.writeLockOwner).toBe("main");
    // …but its write is refused with the holder named, and it is queued.
    expect(() =>
      taskHost.sendMessage("second", "改文件", {
        tool: "fs.write",
        target: `${TASK_DIR}/notes.md`,
        execute: (call) => ({
          tool: call.tool,
          kind: call.kind,
          target: call.target,
          contentVersion: call.contentVersion,
          output: "pending",
        }),
      }),
    ).toThrow(/task-locked: 同一任务写操作权由会话 main 持有/);
    expect(taskHost.writeState().write.sessions.find((item) => item.sessionId === "second")).toMatchObject({
      role: "waiting",
      queuePosition: 1,
    });
    taskHost.reject("main", first.approvalId ?? "");
    expect(taskHost.writeLockOwner).toBeNull();
    const second = taskHost.sendMessage("second", "后来者");
    expect(second.state).toBe("done");
  });

  it("refuses a read-only session's execution round and keeps its tool gate as the second line", () => {
    const taskHost = host();
    taskHost.setPermission("readonly-session", "read");
    expect(() => taskHost.sendMessage("readonly-session", "改一下文件")).toThrow("只读会话仅允许阅读分析");
    expect(taskHost.writeLockOwner).toBeNull();
    expect(taskHost.writeState().write.readonly).toEqual(["readonly-session"]);
  });

  it("keeps the right while a derived execution outlives its turn, and releases it on stop", () => {
    const taskHost = host();
    const turn = taskHost.sendMessage("main", "构建", {
      tool: "exec.run",
      target: `${TASK_DIR}/build.sh`,
      execute: (call) => ({
        tool: call.tool,
        kind: call.kind,
        target: call.target,
        contentVersion: call.contentVersion,
        output: "pending",
      }),
    });
    expect(turn.state).toBe("approval");
    taskHost.approve("main", turn.approvalId ?? "");
    // A finished turn still owns the right while a derived child runs (box 4).
    expect(taskHost.claimDerivedExecution({ resourceId: "child-1", sessionId: "main", label: "构建子进程" })).toBe(true);
    expect(taskHost.writeLockOwner).toBe("main");
    expect(() =>
      taskHost.sendMessage("second", "改文件", {
        tool: "fs.write",
        target: `${TASK_DIR}/notes.md`,
        execute: (call) => ({
          tool: call.tool,
          kind: call.kind,
          target: call.target,
          contentVersion: call.contentVersion,
          output: "pending",
        }),
      }),
    ).toThrow("task-locked");
    // Stop verifies the derived execution and releases the right (box 5).
    const stopped = taskHost.cancel("main");
    expect(stopped.write.owner).toBeNull();
    expect(stopped.derived).toEqual([]);
    // The settled turn's history is kept: stopping only drops the right.
    expect(stopped.sessions.find((item) => item.sessionId === "main")?.runState).toBe("done");
  });

  it("refuses a new session while another session's leftover service is unverified", () => {
    const resources: { resourceId: string; kind: "service"; ownerSessionId: string | null; label: string }[] = [
      { resourceId: "saas-web", kind: "service", ownerSessionId: "gone", label: "saas-web" },
    ];
    const taskHost = new TaskWorkspaceHost(TASK_ID, TASK_DIR, memoryTaskStore(), () => "2026-09-22T10:00:00+08:00", () => resources);
    expect(() => taskHost.sendMessage("second", "改文件", { tool: "fs.write", target: `${TASK_DIR}/notes.md` })).toThrow(
      /遗留执行资源仍在运行（saas-web）/,
    );
    const state = taskHost.writeState();
    expect(state.orphans).toEqual([{ resourceId: "saas-web", kind: "service", ownerSessionId: "gone", label: "saas-web" }]);
    // Once the leftover is stopped (probe empty) the same session may write.
    resources.length = 0;
    expect(taskHost.sendMessage("second", "阅读").state).toBe("done");
  });

  it("restores the designated session from disk, never another task's latest", () => {
    const store = memoryTaskStore();
    const first = new TaskWorkspaceHost(TASK_ID, TASK_DIR, store, () => "2026-09-22T10:00:00+08:00");
    first.sendMessage("main", "第一轮");
    const ids = first.sessionIds();
    expect(ids).toEqual(["main"]);
    first.dispose();

    const second = new TaskWorkspaceHost(TASK_ID, TASK_DIR, store, () => "2026-09-22T10:00:00+08:00");
    const reopened = second.openSession("main");
    expect(reopened.snapshot().sessionId).toBe("main");
    expect(reopened.snapshot().messages).toHaveLength(2);
    expect(reopened.snapshot().calls[0].callId).toBe("call-1");

    const foreign = new PiSessionChannel({
      taskId: "task-other",
      sessionId: "main",
      taskDir: TASK_DIR,
      providerId: "provider-local",
      model: "test-model",
      now: () => "2026-09-22T10:00:00+08:00",
    });
    store.writeSession(TASK_DIR, { ...foreign.snapshot(), taskId: "task-other" });
    const third = new TaskWorkspaceHost(TASK_ID, TASK_DIR, store, () => "2026-09-22T10:00:00+08:00");
    expect(() => third.openSession("main")).toThrow("task-unknown");
  });

  it("expires pending approvals on reopen and preserves createdAt", () => {
    const store = memoryTaskStore();
    const first = new TaskWorkspaceHost(TASK_ID, TASK_DIR, store, () => "2026-09-22T10:00:00+08:00");
    const turn = first.sendMessage("main", "运行命令", {
      tool: "exec.run",
      target: `${TASK_DIR}/run.sh`,
      execute: (call) => ({
        tool: call.tool,
        kind: call.kind,
        target: call.target,
        contentVersion: call.contentVersion,
        output: "pending",
      }),
    });
    expect(turn.state).toBe("approval");
    const before = first.openSession("main").snapshot();
    first.dispose();

    const second = new TaskWorkspaceHost(TASK_ID, TASK_DIR, store, () => "2026-09-22T10:01:00+08:00");
    const reopened = second.openSession("main");
    expect(reopened.runState).toBe("cancelled");
    expect(reopened.pendingApproval()).toBeUndefined();
    expect(reopened.snapshot().approvals[0].status).toBe("expired");
    expect(reopened.snapshot().createdAt).toBe(before.createdAt);
  });

  it("keeps the credentialRef across dispose/reopen (per-turn rotation)", () => {
    const store = memoryTaskStore();
    const first = new TaskWorkspaceHost(TASK_ID, TASK_DIR, store, () => "2026-09-22T10:00:00+08:00");
    const turn = first.sendMessage("main", "检查构建", { credentialRef: "PIDOCK_PI_TOKEN_V2" });
    expect(turn.state).toBe("done");
    expect(first.openSession("main").snapshot().credentialRef).toBe("PIDOCK_PI_TOKEN_V2");
    first.dispose();
    const second = new TaskWorkspaceHost(TASK_ID, TASK_DIR, store, () => "2026-09-22T10:01:00+08:00");
    const reopened = second.openSession("main");
    expect(reopened.configuredCredentialRef).toBe("PIDOCK_PI_TOKEN_V2");
    expect(reopened.snapshot().credentialRef).toBe("PIDOCK_PI_TOKEN_V2");
  });

  it("denies out-of-task tool targets at the Host layer", () => {
    const taskHost = host();
    const result = taskHost.sendMessage("main", "越界", {
      tool: "fs.write",
      target: "/Users/name/Workspace/repo/notes.md",
      execute: (call) => ({
        tool: call.tool,
        kind: call.kind,
        target: call.target,
        contentVersion: call.contentVersion,
        output: "x",
      }),
    });
    expect(result.state).toBe("failed");
  });

  it("approve settles the Host lock and persists the result", () => {
    const taskHost = host();
    const turn = taskHost.sendMessage("main", "运行命令", {
      tool: "exec.run",
      target: `${TASK_DIR}/run.sh`,
      execute: (call) => ({
        tool: call.tool,
        kind: call.kind,
        target: call.target,
        contentVersion: call.contentVersion,
        output: "pending",
      }),
    });
    const callId = taskHost.approve("main", turn.approvalId ?? "");
    expect(callId).toBe(turn.callId);
    expect(taskHost.writeLockOwner).toBeNull();
    expect(taskHost.openSession("main").runState).toBe("done");
  });

  it("persists per-turn provider selection and structured usage with the call", () => {
    const store = memoryTaskStore();
    const taskHost = new TaskWorkspaceHost(TASK_ID, TASK_DIR, store, () => "2026-09-22T10:00:00+08:00");
    const turn = taskHost.sendMessage("main", "检查构建", {
      providerId: "provider-local",
      model: "pidock-default",
      usageSource: "actual",
      usage: { input: 120, output: 45, cacheRead: 10 },
    });
    expect(turn.state).toBe("done");
    expect(turn.callId).toBe("call-1");
    const snapshot = taskHost.openSession("main").snapshot();
    expect(snapshot.providerId).toBe("provider-local");
    expect(snapshot.calls[0]).toMatchObject({
      callId: "call-1",
      providerId: "provider-local",
      model: "pidock-default",
      usageSource: "actual",
      usage: { input: 120, output: 45, cacheRead: 10, source: "actual" },
    });
    // Reopen restores the same usage record (never another task's latest).
    taskHost.dispose();
    const reopened = new TaskWorkspaceHost(TASK_ID, TASK_DIR, store, () => "2026-09-22T10:01:00+08:00");
    expect(reopened.openSession("main").snapshot().calls[0].usage).toEqual({
      input: 120,
      output: 45,
      cacheRead: 10,
      source: "actual",
    });
  });

  it("cancels a pending turn without losing prior messages", () => {
    const taskHost = host();
    taskHost.sendMessage("main", "第一轮");
    const turn = taskHost.sendMessage("main", "运行命令", {
      tool: "exec.run",
      target: `${TASK_DIR}/run.sh`,
      execute: (call) => ({
        tool: call.tool,
        kind: call.kind,
        target: call.target,
        contentVersion: call.contentVersion,
        output: "pending",
      }),
    });
    expect(turn.state).toBe("approval");
    const before = taskHost.openSession("main").snapshot().messages.length;
    taskHost.cancel("main");
    const after = taskHost.openSession("main").snapshot();
    expect(after.runState).toBe("cancelled");
    expect(after.messages.length).toBe(before);
    expect(taskHost.writeLockOwner).toBeNull();
  });
});

describe("S6 batch 2: Host send-record, draft persistence, approval one-shot", () => {
  it("returns send-record ids and persists refs/skill source with origin labels", () => {
    const taskHost = host();
    const turn = taskHost.sendMessage("main", "检查构建", {
      execute: () => ({ target: `${TASK_DIR}/notes.md`, contentVersion: "v1", output: "x" }),
    });
    expect(turn.state).toBe("done");
    expect(turn.userMessageId).toBe("msg-1");
    expect(turn.agentMessageId).toBe("msg-2");
    const snapshot = taskHost.openSession("main").snapshot();
    expect(snapshot.messages.find((message) => message.id === turn.userMessageId)?.origin).toBe("human");
    expect(snapshot.messages.find((message) => message.id === turn.userMessageId)?.callId).toBe(turn.callId);
    expect(snapshot.messages.find((message) => message.id === turn.agentMessageId)?.origin).toBe("agent");
  });

  it("persists an unsent draft through the store without auto-sending", () => {
    const store = memoryTaskStore();
    const taskHost = new TaskWorkspaceHost(TASK_ID, TASK_DIR, store, () => "2026-09-22T10:00:00+08:00");
    taskHost.saveDraft("main", { text: "未发送草稿", references: [{ kind: "file", path: "a.ts" }] });
    const snapshot = taskHost.openSession("main").snapshot();
    expect(snapshot.draft?.text).toBe("未发送草稿");
    expect(snapshot.messages).toHaveLength(0);
    taskHost.dispose();
    const reopened = new TaskWorkspaceHost(TASK_ID, TASK_DIR, store, () => "2026-09-22T10:01:00+08:00");
    expect(reopened.openSession("main").snapshot().draft?.text).toBe("未发送草稿");
    expect(reopened.openSession("main").snapshot().messages).toHaveLength(0);
    reopened.clearDraft("main");
    expect(reopened.openSession("main").snapshot().draft).toBeUndefined();
  });

  it("routes draft/permission ops through setPermission + saveDraft/clearDraft (Host-reachable)", () => {
    const store = memoryTaskStore();
    const taskHost = new TaskWorkspaceHost(TASK_ID, TASK_DIR, store, () => "2026-09-22T10:00:00+08:00");
    taskHost.setPermission("main", "read");
    expect(taskHost.openSession("main").currentPermission).toBe("read");
    taskHost.setPermission("main", "auto");
    expect(taskHost.openSession("main").currentPermission).toBe("auto");
    taskHost.saveDraft("main", { text: "rpc 草稿" });
    expect(taskHost.openSession("main").snapshot().draft?.text).toBe("rpc 草稿");
    taskHost.clearDraft("main");
    expect(taskHost.openSession("main").snapshot().draft).toBeUndefined();
  });

  it("approve consumes exactly one pending and never replays; reopen expires pending", () => {
    const store = memoryTaskStore();
    const taskHost = new TaskWorkspaceHost(TASK_ID, TASK_DIR, store, () => "2026-09-22T10:00:00+08:00");
    taskHost.openSession("main", { permission: "default" });
    const turn = taskHost.sendMessage("main", "跑命令", {
      tool: "exec.run",
      target: `${TASK_DIR}/run.sh`,
      execute: (call) => ({ tool: call.tool, kind: call.kind, target: call.target, contentVersion: call.contentVersion, output: "x" }),
    });
    expect(turn.state).toBe("approval");
    expect(taskHost.approve("main", turn.approvalId ?? "")).toBe(turn.callId);
    expect(() => taskHost.approve("main", turn.approvalId ?? "")).toThrow("不可重放");
    // Pending never replays on reopen: a second host sees expired, not pending.
    const pending = new TaskWorkspaceHost(TASK_ID, TASK_DIR, memoryTaskStore(), () => "2026-09-22T10:00:00+08:00");
    pending.openSession("other", { permission: "default" });
    const awaiting = pending.sendMessage("other", "跑命令", {
      tool: "exec.run",
      target: `${TASK_DIR}/run.sh`,
      execute: (call) => ({ tool: call.tool, kind: call.kind, target: call.target, contentVersion: call.contentVersion, output: "x" }),
    });
    expect(awaiting.state).toBe("approval");
    pending.dispose();
    const reopened = new TaskWorkspaceHost(TASK_ID, pending.taskDir, pending["store"] as never, () => "2026-09-22T10:01:00+08:00");
    expect(reopened.openSession("other").pendingApproval()).toBeUndefined();
  });
});

describe("S6 batch 3: exec.run approval end-to-end through Host sendMessage", () => {
  it("reaches approval then executes once on approve (default permission)", () => {
    const taskHost = host();
    taskHost.openSession("main", { permission: "default" });
    const turn = taskHost.sendMessage("main", "跑命令", {
      tool: "exec.run",
      target: `${TASK_DIR}/run.sh`,
      contentVersion: "v3",
      // Scripted in-Host planner (mirrors the `toolPlan: "echo"` selector
      // `host.ts` applies to RPC payloads): replays the planned gated tool
      // so the real approval path is exercised, not `gate()` directly.
      execute: (call) => ({ tool: call.tool, kind: call.kind, target: call.target, contentVersion: call.contentVersion, output: "planned" }),
    });
    expect(turn.state).toBe("approval");
    expect(turn.approvalId).toBeDefined();
    // The approval payload threads `tool`/`target` so the renderer can
    // show what awaits approval (not just a generic waiting label).
    expect(turn.tool).toBe("exec.run");
    expect(turn.target).toBe(`${TASK_DIR}/run.sh`);
    const approval = taskHost.openSession("main").pendingApproval();
    expect(approval?.tool).toBe("exec.run");
    expect(approval?.target).toBe(`${TASK_DIR}/run.sh`);
    expect(taskHost.approve("main", turn.approvalId ?? "")).toBe(turn.callId);
    expect(() => taskHost.approve("main", turn.approvalId ?? "")).toThrow("不可重放");
  });

  it("denies an out-of-task exec target at the Host layer without executing", () => {
    const taskHost = host();
    taskHost.openSession("main", { permission: "auto" });
    const turn = taskHost.sendMessage("main", "越界命令", {
      tool: "exec.run",
      target: "/etc/passwd",
      execute: (call) => ({ tool: call.tool, kind: call.kind, target: call.target, contentVersion: call.contentVersion, output: "x" }),
    });
    expect(turn.state).toBe("failed");
    expect(taskHost.openSession("main").pendingApproval()).toBeUndefined();
  });
});

describe("#6 multi-repo provision + append (S2)", () => {
  const selections = [
    { repoDir: "frontend", remote: "origin", remoteBranch: "main", mainCheckoutDir: "/src/frontend" },
    { repoDir: "invoice", remote: "upstream", remoteBranch: "release/v2", mainCheckoutDir: "/src/invoice" },
  ];

  function multiProvisionInput() {
    return {
      name: "多仓任务",
      dirId: "task-abcdef12",
      remoteBranch: "main",
      fetchedCommit: "a5a4a0d1234",
      repoSelections: selections,
      fetchedCommits: { frontend: "a5a4a0d1234", invoice: "beef001234" },
      mainCheckouts: { frontend: "/src/frontend", invoice: "/src/invoice" },
      plainDirs: [{ directoryId: "notes-1", sourcePath: "/data/notes" }],
    };
  }

  it("persists per-repo sources with pinned commits and link snapshots", () => {
    const taskHost = host();
    const { record, plan } = taskHost.provision(multiProvisionInput());
    expect(record.repoSources).toEqual([
      { repoDir: "frontend", remote: "origin", remoteBranch: "main", baseCommit: "a5a4a0d1234" },
      { repoDir: "invoice", remote: "upstream", remoteBranch: "release/v2", baseCommit: "beef001234" },
    ]);
    expect(record.repos).toEqual(["frontend", "invoice"]);
    expect(record.dirLinks).toHaveLength(1);
    expect(record.dirLinks?.[0]).toMatchObject({
      directoryId: "notes-1",
      sourcePath: "/data/notes",
      linkName: "dir-notes1",
    });
    // Per-repo commits ride per-repo plans (no cross-use of one commit):
    // assert on the pinned branch ops (branch <name> <commit>) since the
    // worktree add itself names the worktree dir + branch, not the commit.
    expect(plan.ops).toHaveLength(6);
    const branchArgs = plan.ops.filter((op) => op.kind === "branch").map((op) => op.args.join(" "));
    expect(branchArgs[0]).toContain("a5a4a0d1234");
    expect(branchArgs[0]).not.toContain("beef001234");
    expect(branchArgs[1]).toContain("beef001234");
    // Round-trip through the typed parser (pre-#6 records stay valid:
    // no new required keys).
    expect(parseTaskRecord(JSON.stringify(record)).repoSources).toHaveLength(2);
  });

  it("fails the whole batch on one fetch failure with the form kept", () => {
    const taskHost = host();
    expect(() =>
      taskHost.provision({ ...multiProvisionInput(), fetchedCommits: { frontend: "a5a4a0d1234" } }),
    ).toThrow("fetch-failed");
    expect(taskHost.taskRecord()).toBeNull();
  });

  it("appends only new repos, keeping baselines, root and lock state", () => {
    const taskHost = host();
    taskHost.provision(multiProvisionInput());
    taskHost.openSession("busy");
    const appended = taskHost.appendRepos({
      repoSelections: [
        ...selections,
        { repoDir: "shipment", remote: "origin", remoteBranch: "main", mainCheckoutDir: "/src/shipment" },
      ],
      fetchedCommits: { shipment: "c0ffee1234" },
      takenPaths: [],
      branchesInUse: [],
    });
    // #6 P0: the append fetch rides the selection remote (never origin).
    const appendFetch = appended.plan.ops.find((op) => op.kind === "fetch");
    expect(appendFetch?.args).toEqual(["fetch", "origin", "main"]);
    expect(appended.appended).toEqual(["shipment"]);
    expect(appended.skipped).toEqual(["frontend", "invoice"]);
    expect(appended.record.repos).toEqual(["frontend", "invoice", "shipment"]);
    expect(appended.record.repoSources?.find((source) => source.repoDir === "frontend")?.baseCommit).toBe("a5a4a0d1234");
    expect(appended.record.taskDir).toBe(TASK_DIR);
    expect(appended.plan.ops).toHaveLength(3);
    // Busy sessions are not rebound: their channels survive the append.
    expect(taskHost.openSession("busy").taskId).toBe(TASK_ID);
  });

  it("fails closed when the caller omits the conflict scan", () => {
    const taskHost = host();
    taskHost.provision(multiProvisionInput());
    expect(() =>
      taskHost.appendRepos({
        repoSelections: [
          { repoDir: "shipment", remote: "origin", remoteBranch: "main", mainCheckoutDir: "/src/shipment" },
        ],
        fetchedCommits: { shipment: "c0ffee1234" },
      }),
    ).toThrow("invalid-payload");
    expect(taskHost.taskRecord()?.repos).toEqual(["frontend", "invoice"]);
  });

  it("reports append conflicts without touching stored baselines", () => {
    const taskHost = host();
    taskHost.provision(multiProvisionInput());
    expect(() =>
      taskHost.appendRepos({
        repoSelections: [
          { repoDir: "shipment", remote: "origin", remoteBranch: "main", mainCheckoutDir: "/src/shipment" },
        ],
        fetchedCommits: { shipment: "c0ffee1234" },
        takenPaths: [`${TASK_DIR}/shipment`],
        branchesInUse: [],
      }),
    ).toThrow("path-taken");
    expect(taskHost.taskRecord()?.repos).toEqual(["frontend", "invoice"]);
  });

  it("fetches per-repo remotes in provision plans (never hardcoded origin)", () => {
    const taskHost = host();
    const { plan } = taskHost.provision(multiProvisionInput());
    const fetches = plan.ops.filter((op) => op.kind === "fetch");
    expect(fetches).toHaveLength(2);
    expect(fetches[0].args).toEqual(["fetch", "origin", "main"]);
    expect(fetches[1].args).toEqual(["fetch", "upstream", "release/v2"]);
    // cwds ride the per-repo source checkouts passed via `mainCheckouts`
    // (relative/empty cwds are rejected before entering a plan).
    expect(fetches[0].cwd).toBe("/src/frontend");
    expect(fetches[1].cwd).toBe("/src/invoice");
  });

  it("rejects colliding link names instead of sharing one link", () => {
    const taskHost = host();
    expect(() =>
      taskHost.provision({
        ...multiProvisionInput(),
        plainDirs: [
          { directoryId: "notes-1", sourcePath: "/data/a" },
          { directoryId: "notes--1", sourcePath: "/data/b" },
        ],
      }),
    ).toThrow("duplicate-repo");
    expect(taskHost.taskRecord()).toBeNull();
  });

  it("probes link targets Host-side (dead vs ok, lexical + one-hop link)", () => {
    const taskHost = host();
    const dead = taskHost.probeLinkTarget("/definitely/missing/pidock-notes");
    expect(dead.shape).toBe("dead");
    expect(dead.lexical).toBe("ok");
    expect(dead.linkTarget).toBeNull();
    expect(dead.linkTargetInTask).toBe(false);
    const ok = taskHost.probeLinkTarget("/tmp");
    expect(ok.shape).toBe("ok");
    expect(ok.lexical).toBe("ok");
    expect(ok.linkTargetInTask).toBe(false);
  });

  it("flags a one-hop readlink target inside the task as loop-risk", () => {
    // Pure helper (no fs): callers MUST treat `linkTargetInTask === true`
    // as loop-risk before creating the link (report-only, never followed).
    expect(isPathInsideTask(`${TASK_DIR}/evil`, TASK_DIR)).toBe(true);
    expect(isPathInsideTask(TASK_DIR, TASK_DIR)).toBe(true);
    expect(isPathInsideTask("task-abcdef12/evil", TASK_DIR)).toBe(true);
    expect(isPathInsideTask("/data/notes", TASK_DIR)).toBe(false);
    expect(isPathInsideTask(null, TASK_DIR)).toBe(false);
    expect(isPathInsideTask("", TASK_DIR)).toBe(false);
  });
});
