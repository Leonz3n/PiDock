import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskWorkspaceHost, diskTaskStore, isPathInsideTask, memoryTaskStore, MAX_LINK_HOPS, observeLinkChain } from "./task-host.js";
import {
  listSessionIdsOnDisk,
  parseSessionSnapshot,
  parseTaskRecord,
  parseUsageLedger,
  readSessionSnapshotOnDisk,
  readTaskRecordOnDisk,
  readUsageOnDisk,
  serializeUsageLedger,
  sessionFilePath,
  taskFilePath,
  usageFilePath,
  writeSessionSnapshotOnDisk,
  writeTaskRecordOnDisk,
  writeUsageOnDisk,
  buildTaskDiskRecord,
  buildLifecycleRecord,
  lifecycleFilePath,
} from "./task-store.js";
import { normalizeReportedUsage, toUsageDetail } from "../main/usage-ledger.js";
import { hostPlatformLabel } from "../main/service-config.js";
import { PiSessionChannel, resetPiSequencesForTests } from "../main/pi-session.js";
import { assertProvisionPlanSafe, planWorktreeCreation } from "../main/task-provision.js";
import { SharedPathCoordinator } from "./path-coordination.js";
import { TaskLifecycleHost } from "./task-lifecycle.js";
import { createLifecycleResources } from "./lifecycle-resources.js";

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

// Public disk TaskStore boundary: lifecycle persistence must not reclaim a stale path.
function withLifecycleTask(check: (task: { home: string; root: string; taskDir: string; record: ReturnType<typeof buildTaskDiskRecord>; lifecycle: ReturnType<typeof buildLifecycleRecord> }) => void): void {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-lifecycle-")));
  const root = join(home, "tasks"), taskDir = join(root, "task-abcdef12");
  const record = buildTaskDiskRecord({ taskId: TASK_ID, name: "Lifecycle", dirId: "task-abcdef12", branch: "task/abcdef12", root, taskDir, remoteBranch: "main", baseCommit: "a5a4a0d1234", repos: [], now: "2026-09-22T10:00:00Z" });
  const lifecycle = buildLifecycleRecord({ taskId: TASK_ID, now: "2026-09-22T12:00:00Z" });
  try {
    diskTaskStore.writeTask(taskDir, record);
    check({ home, root, taskDir, record, lifecycle });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

describe("disk lifecycle ownership", () => {
  it.each(["mixed", "forward"] as const)("quits a reopened task with %s separators without changing task.json", (spelling) => {
    withLifecycleTask(({ root, taskDir, record }) => {
      const recordedRoot = spelling === "forward" ? root.replace(/\\/g, "/") : root;
      diskTaskStore.writeTask(taskDir, { ...record, root: recordedRoot, taskDir: `${recordedRoot}/${record.dirId}` });
      const before = readFileSync(taskFilePath(taskDir), "utf8");
      const host = new TaskWorkspaceHost(TASK_ID, taskDir, diskTaskStore);
      const owner = new TaskLifecycleHost(TASK_ID, taskDir, diskTaskStore,
        createLifecycleResources({ host, services: () => null, terminals: () => null, sessionIds: () => [], liveProcesses: () => [] }),
        () => "2026-10-15T12:00:00Z");
      const quit = owner.quit();
      expect(quit.plan.failures).toEqual([]);
      expect(quit.plan.retainedTasks).toEqual([]);
      expect(diskTaskStore.readLifecycle(taskDir)).toMatchObject({ taskId: TASK_ID, updatedAt: "2026-10-15T12:00:00Z" });
      expect(readFileSync(taskFilePath(taskDir), "utf8")).toBe(before);
      expect(readdirSync(taskDir)).toEqual(["lifecycle.json", "task.json"]);
      expect(owner.quit().record).toEqual(quit.record);
    });
  });
  it("persists healthy first and replacement writes for the same task without changing task.json", () => {
    withLifecycleTask(({ taskDir, lifecycle }) => {
      const before = readFileSync(taskFilePath(taskDir), "utf8");
      diskTaskStore.writeLifecycle(taskDir, lifecycle);
      const updated = { ...lifecycle, archived: true, archivedAt: "2026-09-22T12:00:00Z" };
      diskTaskStore.writeLifecycle(taskDir, updated);
      expect(diskTaskStore.readLifecycle(taskDir)).toEqual(updated);
      expect(readFileSync(taskFilePath(taskDir), "utf8")).toBe(before);
      expect(readdirSync(taskDir)).toEqual(["lifecycle.json", "task.json"]);
    });
  });

  it("refuses a missing task directory without recreating it", () => {
    withLifecycleTask(({ home, root, taskDir, lifecycle }) => {
      const moved = join(home, "moved-task");
      renameSync(taskDir, moved);
      const before = readFileSync(taskFilePath(moved), "utf8");
      expect(() => diskTaskStore.writeLifecycle(taskDir, lifecycle)).toThrow();
      expect(readdirSync(root)).toEqual([]);
      expect(readdirSync(moved)).toEqual(["task.json"]);
      expect(readFileSync(taskFilePath(moved), "utf8")).toBe(before);
    });
  });

  it("refuses a non-regular lifecycle destination or malformed input before writing anything", () => {
    withLifecycleTask(({ taskDir, lifecycle }) => {
      mkdirSync(lifecycleFilePath(taskDir));
      expect(() => diskTaskStore.writeLifecycle(taskDir, lifecycle)).toThrow("invalid lifecycle record file");
      expect(readdirSync(lifecycleFilePath(taskDir))).toEqual([]);
      rmSync(lifecycleFilePath(taskDir), { recursive: true });
      diskTaskStore.writeLifecycle(taskDir, lifecycle);
      const before = readFileSync(lifecycleFilePath(taskDir), "utf8");
      expect(() => diskTaskStore.writeLifecycle(taskDir, { ...lifecycle, archived: "invalid" as never })).toThrow("archived");
      expect(readFileSync(lifecycleFilePath(taskDir), "utf8")).toBe(before);
      expect(readdirSync(taskDir)).toEqual(["lifecycle.json", "task.json"]);
    });
  });

  it("refuses a moved root without recreating the old path or changing the moved lifecycle", () => {
    withLifecycleTask(({ home, root, taskDir, lifecycle }) => {
      diskTaskStore.writeLifecycle(taskDir, lifecycle);
      expect(diskTaskStore.readLifecycle(taskDir)).toEqual(lifecycle);
      const before = readFileSync(lifecycleFilePath(taskDir), "utf8");
      const movedRoot = join(home, "moved-tasks");
      renameSync(root, movedRoot);
      expect(() => diskTaskStore.writeLifecycle(taskDir, { ...lifecycle, archived: true })).toThrow();
      expect(existsSync(root)).toBe(false);
      expect(readFileSync(lifecycleFilePath(join(movedRoot, "task-abcdef12")), "utf8")).toBe(before);
    });
  });
  it.each(["taskId", "root", "taskDir", "dirId", "missing-record", "corrupt-record", "lifecycle-owner"] as const)("refuses %s without changing existing lifecycle bytes", (change) => {
    withLifecycleTask(({ taskDir, record, lifecycle }) => {
      diskTaskStore.writeLifecycle(taskDir, lifecycle);
      const before = readFileSync(lifecycleFilePath(taskDir), "utf8");
      if (change === "missing-record") rmSync(taskFilePath(taskDir));
      else if (change === "corrupt-record") writeFileSync(taskFilePath(taskDir), "{}", "utf8");
      else if (change !== "lifecycle-owner") diskTaskStore.writeTask(taskDir, { ...record, [change]: "other-owner" });
      const taskBefore = existsSync(taskFilePath(taskDir)) ? readFileSync(taskFilePath(taskDir), "utf8") : null;
      expect(() => diskTaskStore.writeLifecycle(taskDir, { ...lifecycle, taskId: change === "lifecycle-owner" ? "other-task" : lifecycle.taskId, archived: true })).toThrow();
      expect(readFileSync(lifecycleFilePath(taskDir), "utf8")).toBe(before);
      expect(existsSync(taskFilePath(taskDir)) ? readFileSync(taskFilePath(taskDir), "utf8") : null).toBe(taskBefore);
    });
  });
  // win32: the `record` and `lifecycle` kinds plant a link to a FILE, which needs
  // SeCreateSymbolicLinkPrivilege (measured: EPERM under `runas /trustlevel:0x20000`) and a
  // junction cannot stand in for a file (it is a directory reparse point) and a plain directory
  // symlink needs the same privilege; a junction is the directory link win32 can create without
  // it. Only the directory kinds are created here, using that junction; POSIX still runs all four.
  const linkedKinds: ("root" | "task" | "record" | "lifecycle")[] = ["root", "task", "record", "lifecycle"];
  const creatableLinkedKinds = process.platform === "win32" ? linkedKinds.filter((kind) => kind === "root" || kind === "task") : linkedKinds;
  it.each(creatableLinkedKinds)("refuses a linked %s without modifying the link or original target bytes", (kind) => {
    withLifecycleTask(({ home, root, taskDir, lifecycle }) => {
      diskTaskStore.writeLifecycle(taskDir, lifecycle);
      const taskBefore = readFileSync(taskFilePath(taskDir), "utf8"), before = readFileSync(lifecycleFilePath(taskDir), "utf8");
      const path = kind === "root" ? root : kind === "task" ? taskDir : kind === "record" ? taskFilePath(taskDir) : lifecycleFilePath(taskDir);
      const target = join(home, `external-${kind}`);
      renameSync(path, target);
      symlinkSync(target, path, kind === "root" || kind === "task" ? (process.platform === "win32" ? "junction" : "dir") : "file");
      const entries = readdirSync(taskDir);
      expect(() => diskTaskStore.writeLifecycle(taskDir, { ...lifecycle, archived: true })).toThrow();
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      expect(readFileSync(lifecycleFilePath(taskDir), "utf8")).toBe(before);
      expect(readFileSync(taskFilePath(taskDir), "utf8")).toBe(taskBefore);
      expect(readdirSync(taskDir)).toEqual(entries);
    });
  });
  it.each([true, false])("refuses an old Host's quit after foreign path reuse (foreign lifecycle present: %s)", (hasLifecycle) => {
    withLifecycleTask(({ taskDir, record, lifecycle }) => {
      const host = new TaskWorkspaceHost(TASK_ID, taskDir, diskTaskStore);
      const owner = new TaskLifecycleHost(TASK_ID, taskDir, diskTaskStore, createLifecycleResources({ host, services: () => null, terminals: () => null, sessionIds: () => [], liveProcesses: () => [] }));
      owner.archive();
      diskTaskStore.writeTask(taskDir, { ...record, taskId: "foreign-task" });
      if (hasLifecycle) diskTaskStore.writeLifecycle(taskDir, { ...lifecycle, taskId: "foreign-task" });
      else rmSync(lifecycleFilePath(taskDir));
      const taskBefore = readFileSync(taskFilePath(taskDir), "utf8");
      const lifecycleBefore = hasLifecycle ? readFileSync(lifecycleFilePath(taskDir), "utf8") : null;
      expect(() => owner.quit()).toThrow("ownership mismatch");
      if (hasLifecycle) {
        expect(() => owner.lifecycle()).toThrow("ownership mismatch");
        expect(() => owner.restore()).toThrow("ownership mismatch");
      }
      expect(readFileSync(taskFilePath(taskDir), "utf8")).toBe(taskBefore);
      expect(hasLifecycle ? readFileSync(lifecycleFilePath(taskDir), "utf8") : existsSync(lifecycleFilePath(taskDir)) ? "created" : null).toBe(lifecycleBefore);
    });
  });
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

  it("[PiDock 12] round-trips the usage ledger with its cleanup exclusions and rejects malformed entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "pidock-usage-"));
    const detail = toUsageDetail({
      callId: "call-1",
      taskId: TASK_ID,
      sessionId: "main",
      providerId: "provider-local",
      providerVersion: "unversioned",
      requestModel: "pidock-default",
      kind: "turn",
      endState: "completed",
      at: "2026-09-22T10:00:00+08:00",
      usage: normalizeReportedUsage({ input: 10, output: 4, cacheRead: 0, cacheWrite: 0 }, "actual"),
    });
    writeUsageOnDisk(dir, [detail], [{ kind: "session", sessionId: "review" }]);
    expect(usageFilePath(dir)).toBe(join(dir, "usage.json"));
    expect(readUsageOnDisk(dir)).toEqual({ details: [detail], exclusions: [{ kind: "session", sessionId: "review" }] });
    // A recorded cleanup also round-trips the ledger keys it removed.
    writeUsageOnDisk(dir, [detail], [{ kind: "session", sessionId: "review", removedIds: ["call-0"] }]);
    expect(readUsageOnDisk(dir)).toEqual({ details: [detail], exclusions: [{ kind: "session", sessionId: "review", removedIds: ["call-0"] }] });
    expect(readUsageOnDisk(join(tmpdir(), "pidock-missing-usage-xyz"))).toEqual({ details: [], exclusions: [] });
    // A corrupt ledger is refused instead of restoring a half-shaped record.
    expect(() => parseUsageLedger(serializeUsageLedger([{ ...detail, kind: "live" as never }]))).toThrow("kind");
    expect(() => parseUsageLedger(JSON.stringify({ details: [{ ...detail, usage: { ...detail.usage, input: -1 } }] }))).toThrow("input");
    expect(() => parseUsageLedger(JSON.stringify({ details: "nope" }))).toThrow("details");
    expect(() => parseUsageLedger(serializeUsageLedger([detail], [{ kind: "session" } as never]))).toThrow("sessionId");
    expect(() => parseUsageLedger(JSON.stringify({ details: [], exclusions: [{ kind: "all", removedIds: ["", 7] }] }))).toThrow("removedIds");
    expect(parseUsageLedger(serializeUsageLedger([detail]))).toEqual({ details: [detail], exclusions: [] });
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
      usage: { input: 120, output: 45, cacheRead: 10, cacheWrite: 0, source: "actual", completeness: "partial" },
    });
    // Reopen restores the same usage record (never another task's latest).
    taskHost.dispose();
    const reopened = new TaskWorkspaceHost(TASK_ID, TASK_DIR, store, () => "2026-09-22T10:01:00+08:00");
    expect(reopened.openSession("main").snapshot().calls[0].usage).toEqual({
      input: 120,
      output: 45,
      cacheRead: 10,
      cacheWrite: 0,
      source: "actual",
      completeness: "partial",
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

  it("refuses an unsafe branch override on append (a leading `-` would be a git option)", () => {
    const taskHost = host();
    taskHost.provision(multiProvisionInput());
    expect(() =>
      taskHost.appendRepos({
        repoSelections: [
          { repoDir: "shipment", remote: "origin", remoteBranch: "main", mainCheckoutDir: "/src/shipment" },
        ],
        fetchedCommits: { shipment: "c0ffee1234" },
        branch: "-m",
        takenPaths: [],
        branchesInUse: [],
      }),
    ).toThrow("invalid-payload");
    expect(taskHost.taskRecord()?.repos).toEqual(["frontend", "invoice"]);
  });

  it("fails the whole append batch when one new repo's fetch is missing (all-success gate)", () => {
    const taskHost = host();
    taskHost.provision(multiProvisionInput());
    expect(() =>
      taskHost.appendRepos({
        repoSelections: [
          { repoDir: "shipment", remote: "origin", remoteBranch: "main", mainCheckoutDir: "/src/shipment" },
          { repoDir: "billing", remote: "origin", remoteBranch: "main", mainCheckoutDir: "/src/billing" },
        ],
        // `billing` has no freshly fetched commit: no plan for `shipment`
        // either, so the caller cannot create the first worktree.
        fetchedCommits: { shipment: "c0ffee1234" },
        takenPaths: [],
        branchesInUse: [],
      }),
    ).toThrow("fetch-failed");
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

  it("takes the other separator spelling of one taken folder as the same path (#72)", () => {
    const taskHost = host();
    taskHost.provision(multiProvisionInput());
    // The Host spells the wanted dir `<taskDir>/shipment` from its own bound
    // task dir, while main's scan reports the task folder as the resolver
    // found it on disk; the two can differ only by separator spelling (they
    // coincide on POSIX, so this case bites on win32). Both name one folder.
    const otherSpelling = TASK_DIR.replace(/\\/g, "/");
    expect(() =>
      taskHost.appendRepos({
        repoSelections: [
          { repoDir: "shipment", remote: "origin", remoteBranch: "main", mainCheckoutDir: "/src/shipment" },
        ],
        fetchedCommits: { shipment: "c0ffee1234" },
        takenPaths: [`${otherSpelling}/shipment`],
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

  it("probes link targets Host-side (dangling vs a real directory, lexical + one-hop link)", () => {
    const taskHost = host();
    const missing = taskHost.probeLinkTarget("/definitely/missing/pidock-notes");
    expect(missing.shape).toBe("dangling");
    expect(missing.lexical).toBe("ok");
    expect(missing.linkTarget).toBeNull();
    expect(missing.linkTargetInTask).toBe(false);
    const realDirectory = realpathSync(mkdtempSync(join(tmpdir(), "pidock-link-ok-")));
    try {
      const ok = taskHost.probeLinkTarget(realDirectory);
      expect(ok.shape).toBe("directory");
      expect(ok.detail).toContain("真实目录");
      expect(ok.lexical).toBe("ok");
      expect(ok.linkTargetInTask).toBe(false);
    } finally {
      rmSync(realDirectory, { recursive: true, force: true });
    }
  });

  it("names every link target shape separately, with a created link never fixed into a healthy one", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-link-shape-")));
    try {
      const taskHost = host();
      const real = join(home, "real-notes");
      mkdirSync(real);
      // 失效: a link whose target does not exist.
      const dangling = join(home, "gone-notes");
      // win32: a plain directory symlink needs SeCreateSymbolicLinkPrivilege; a junction is the directory link this platform can create without it (#57).
      symlinkSync(join(home, "never-created"), dangling, process.platform === "win32" ? "junction" : "dir");
      // 嵌套: the source is itself a link (here a link to a link).
      const firstHop = join(home, "first-hop");
      symlinkSync(real, firstHop, process.platform === "win32" ? "junction" : "dir");
      const nested = join(home, "nested-notes");
      symlinkSync(firstHop, nested, process.platform === "win32" ? "junction" : "dir");
      // 循环: two links pointing at each other.
      const cycleA = join(home, "cycle-a");
      const cycleB = join(home, "cycle-b");
      symlinkSync(cycleB, cycleA, process.platform === "win32" ? "junction" : "dir");
      symlinkSync(cycleA, cycleB, process.platform === "win32" ? "junction" : "dir");
      // 形状未确定: the chain ends at something that is not a directory.
      const file = join(home, "notes.txt");
      writeFileSync(file, "not a directory\n");

      const shapes = {
        real: taskHost.probeLinkTarget(real),
        dangling: taskHost.probeLinkTarget(dangling),
        nested: taskHost.probeLinkTarget(nested),
        cycle: taskHost.probeLinkTarget(cycleA),
        file: taskHost.probeLinkTarget(file),
      };
      expect(Object.fromEntries(Object.entries(shapes).map(([key, report]) => [key, report.shape]))).toEqual({
        real: "directory",
        dangling: "dangling",
        nested: "nested-link",
        cycle: "cyclic-link",
        file: "unknown",
      });
      // The words the surface shows, pinned: 失效/嵌套/循环 are never collapsed
      // into "a directory", and each detail names what was really seen.
      expect(shapes.dangling.detail).toContain("不存在");
      expect(shapes.nested.detail).toContain("软链接");
      expect(shapes.cycle.detail).toContain("回到");
      expect(shapes.file.detail).toContain("不是目录");
      // A link→directory source (one hop) is a link, not the original directory.
      expect(taskHost.probeLinkTarget(firstHop)).toMatchObject({ shape: "nested-link" });
      // Probing really followed the entries: nothing was created or repaired.
      expect(existsSync(join(home, "never-created"))).toBe(false);
      expect(readlinkSync(dangling)).toBe(join(home, "never-created"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("names an unreadable target as unknown instead of a healthy directory", () => {
    const unreadable = Object.assign(new Error("EACCES: permission denied, lstat '/root/notes'"), { code: "EACCES" });
    const report = observeLinkChain("/root/notes", {
      lstat: () => { throw unreadable; },
      readlink: () => { throw unreadable; },
      resolveTarget: (current) => current,
    });
    expect(report.shape).toBe("unknown");
    expect(report.detail).toContain("无法读取");
    expect(report.detail).toContain("EACCES");
    // The hop budget is named too: a pathologically long chain is not a shape.
    let hop = 0;
    const long = observeLinkChain("/hop-0", {
      lstat: () => ({ isSymbolicLink: () => true, isDirectory: () => false }),
      readlink: (path) => path,
      resolveTarget: () => `/hop-${(hop += 1)}`,
    });
    expect(long.shape).toBe("unknown");
    expect(long.detail).toContain(`超过 ${MAX_LINK_HOPS} 跳`);
    expect(hop).toBe(MAX_LINK_HOPS + 1);
  });

  it("probes only this task's own recorded plain-directory sources", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-link-scope-")));
    try {
      const taskDir = join(home, "task-abcdef12");
      mkdirSync(taskDir);
      const original = join(home, "original-notes");
      mkdirSync(original);
      const taskHost = new TaskWorkspaceHost("task-a", taskDir, memoryTaskStore(), () => "2026-09-22T10:00:00+08:00");
      taskHost.provision({
        name: "普通目录任务",
        dirId: "task-abcdef12",
        remoteBranch: "main",
        fetchedCommit: "a5a4a0d1234",
        plainDirs: [{ directoryId: "notes", sourcePath: original }],
      });
      const allowed = taskHost.probeDeclaredLinkSource(original);
      expect(allowed.ok && allowed.report.shape).toBe("directory");
      // A path this task never recorded is refused by name, with no probe at all.
      const foreign = taskHost.probeDeclaredLinkSource("/etc");
      expect(foreign.ok).toBe(false);
      expect(foreign.ok === false && foreign.error).toContain("path-out-of-scope");
      // A task with no recorded link sources has nothing probeable.
      expect(host().probeDeclaredLinkSource(original)).toMatchObject({ ok: false });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports the platform record: this Host's own platform exercised, win32 unverified by name", () => {
    const report = host().probeLinkTarget("/definitely/missing/pidock-notes");
    const exercised = report.platforms.filter((row) => row.exercised);
    expect(exercised.map((row) => row.platform)).toEqual([hostPlatformLabel()]);
    // What the exercised row claims is NARROW: a link-TARGET probe ran on this
    // platform. It does not claim a real link was in the chain, nor that link
    // creation was exercised here.
    expect(exercised[0]!.note).toContain("在本平台执行了链接目标探测");
    expect(exercised[0]!.note).toContain("链中可能没有真实链接");
    expect(exercised[0]!.note).not.toContain("真的在本平台");
    // The matrix row this Host did NOT run. It is selected by DIFFERENCE from
    // this Host's own label: on win32 the host platform IS `win32-x64`, so a
    // hardcoded name would select the exercised row instead.
    const otherName = hostPlatformLabel() === "win32-x64" ? "darwin-arm64" : "win32-x64";
    const other = report.platforms.find((row) => row.platform === otherName);
    expect(other).toMatchObject({ platform: otherName, exercised: false });
    // 「win32 链接方式未验证」 is a property of every win32 ROW - linkCapabilityRows
    // appends it to the exercised row too. On win32 the only win32 row IS the
    // exercised one, so this reads the win32 row; on darwin/linux that is the
    // same row the assertion above reads.
    expect(report.platforms.find((row) => row.platform === "win32-x64")!.note).toContain("win32 链接方式未验证");
    // The 真实 pi clause is a NAMED boundary of this record, not a claim.
    expect(report.modelBoundary).toContain("不是真实 pi/模型运行");
  });

  it("past a probe the in-task link, its original target and the task folder are unchanged", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-link-readonly-")));
    try {
      const taskDir = join(home, "task-abcdef12");
      mkdirSync(taskDir);
      const original = join(home, "original-notes");
      mkdirSync(original);
      writeFileSync(join(original, "spec.md"), "原目录内容\n");
      const linkPath = join(taskDir, "dir-notesa");
      symlinkSync(original, linkPath, process.platform === "win32" ? "junction" : "dir");
      const danglingSource = join(home, "gone-notes");
      symlinkSync(join(home, "never-created"), danglingSource, process.platform === "win32" ? "junction" : "dir");
      const taskHost = new TaskWorkspaceHost("task-a", taskDir, memoryTaskStore(), () => "2026-09-22T10:00:00+08:00");
      taskHost.provision({
        name: "普通目录任务",
        dirId: "task-abcdef12",
        remoteBranch: "main",
        fetchedCommit: "a5a4a0d1234",
        plainDirs: [
          { directoryId: "notes-a", sourcePath: original },
          { directoryId: "notes-b", sourcePath: danglingSource },
        ],
      });
      const before = ledger();
      expect(taskHost.probeDeclaredLinkSource(original).ok).toBe(true);
      expect(taskHost.probeDeclaredLinkSource(danglingSource)).toMatchObject({ ok: true, report: { shape: "dangling" } });
      expect(ledger()).toEqual(before);

      function ledger() {
        const entry = (path: string) => {
          const stat = lstatSync(path);
          return { mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs, link: stat.isSymbolicLink() ? readlinkSync(path) : null };
        };
        return {
          link: entry(linkPath),
          dangling: entry(danglingSource),
          original: entry(original),
          targetFile: entry(join(original, "spec.md")),
          targetBytes: readFileSync(join(original, "spec.md"), "utf8"),
          taskDirEntries: readdirSync(taskDir).sort(),
          parentEntries: readdirSync(home).sort(),
          repaired: existsSync(join(home, "never-created")),
        };
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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

// Seam: [PiDock 09] (#11 S3) real-path coordination across tasks. Plain
// directories are shared views of the original files (#6), so two tasks
// writing the same resolved path must serialize while distinct paths under the
// same shared directory stay parallel. The fs probe is injected: these tests
// never touch the filesystem, and "link retargeted" is just a probe answer.
describe("[PiDock 09] real-path write coordination across tasks", () => {
  const NOW = () => "2026-09-22T10:00:00+08:00";

  function taskHostWithLink(input: {
    taskId: string;
    taskDir: string;
    store: ReturnType<typeof memoryTaskStore>;
    shared: SharedPathCoordinator;
    resolveRealPath: (path: string) => string;
    dirId: string;
    linkSource: string;
  }) {
    const taskHost = new TaskWorkspaceHost(input.taskId, input.taskDir, input.store, NOW, () => [], input.shared, input.resolveRealPath);
    const provisioned = taskHost.provision({
      name: `任务 ${input.taskId}`,
      dirId: input.dirId,
      remoteBranch: "main",
      fetchedCommit: "a5a4a0d1234",
      plainDirs: [{ directoryId: "invoice-docs", sourcePath: input.linkSource }],
    });
    const link = provisioned.record.dirLinks?.[0];
    if (!link) throw new Error("test setup: no dirLink persisted");
    return { taskHost, linkName: link.linkName, linkPath: `${input.taskDir}/${link.linkName}` };
  }

  /** A symlink-shaped probe: in-task link paths resolve into the shared root. */
  function linkResolver(links: Record<string, string>) {
    return (path: string): string => {
      for (const [linkPath, realRoot] of Object.entries(links)) {
        if (path === linkPath) return realRoot;
        if (path.startsWith(`${linkPath}/`)) return `${realRoot}${path.slice(linkPath.length)}`;
      }
      return path;
    };
  }

  function writeTurn(target: string, output = "written") {
    return {
      tool: "fs.write",
      target,
      execute: (call: { tool?: string; kind?: string; target: string; contentVersion: string }) => ({
        tool: call.tool,
        kind: call.kind,
        target: call.target,
        contentVersion: call.contentVersion,
        output,
      }),
    };
  }

  it("serializes two tasks writing the same shared real path and runs distinct paths in parallel", () => {
    const shared = new SharedPathCoordinator();
    const dirA = "/work/tasks/task-aaaa1111";
    const dirB = "/work/tasks/task-bbbb2222";
    const sharedRoot = "/shared/invoice-docs";
    // The link map is filled once provisioning named the in-task link.
    const linksA: Record<string, string> = {};
    const a = taskHostWithLink({
      taskId: "task-a",
      taskDir: dirA,
      store: memoryTaskStore(),
      shared,
      resolveRealPath: (path) => linkResolver(linksA)(path),
      dirId: "task-aaaa1111",
      linkSource: sharedRoot,
    });
    linksA[a.linkPath] = sharedRoot;
    expect(a.taskHost.sharedRoots()).toEqual([{ directoryId: "invoice-docs", sourcePath: sharedRoot, realPath: sharedRoot }]);
    const b = taskHostWithLink({
      taskId: "task-b",
      taskDir: dirB,
      store: memoryTaskStore(),
      shared,
      resolveRealPath: (path) => (path === b.linkPath ? sharedRoot : path.startsWith(`${b.linkPath}/`) ? `${sharedRoot}${path.slice(b.linkPath.length)}` : path),
      dirId: "task-bbbb2222",
      linkSource: sharedRoot,
    });

    // A shared-directory write in flight (its confirmation still open) holds
    // the real-path key (盒子 4).
    const turn = a.taskHost.sendMessage("main", "改 spec", { ...writeTurn(`${a.linkPath}/spec.md`), tool: "exec.run" });
    expect(turn.state).toBe("approval");
    // The other task on the same original: the same file is refused with the
    // holder named, a different file under the same shared root is allowed.
    expect(() => b.taskHost.sendMessage("main", "改 spec", writeTurn(`${b.linkPath}/spec.md`))).toThrow("shared-path-locked");
    expect(b.taskHost.sendMessage("main", "改 notes", writeTurn(`${b.linkPath}/notes/rfc.md`)).state).toBe("done");
    // Settling the confirmation releases the task's real-path key.
    a.taskHost.approve("main", turn.approvalId ?? "");
    expect(shared.snapshot()).toEqual([]);
    // With the key free the other task writes the same shared file.
    expect(b.taskHost.sendMessage("main", "改 spec", writeTurn(`${b.linkPath}/spec.md`)).state).toBe("done");
  });

  it("keeps an open confirmation's shared real-path key when a later turn of the same session fails", () => {
    const shared = new SharedPathCoordinator();
    const dirA = "/work/tasks/task-aaaa1111";
    const dirB = "/work/tasks/task-bbbb2222";
    const sharedRoot = "/shared/invoice-docs";
    const linksA: Record<string, string> = {};
    const a = taskHostWithLink({
      taskId: "task-a",
      taskDir: dirA,
      store: memoryTaskStore(),
      shared,
      resolveRealPath: (path) => linkResolver(linksA)(path),
      dirId: "task-aaaa1111",
      linkSource: sharedRoot,
    });
    linksA[a.linkPath] = sharedRoot;
    const b = taskHostWithLink({
      taskId: "task-b",
      taskDir: dirB,
      store: memoryTaskStore(),
      shared,
      resolveRealPath: (path) => (path === b.linkPath ? sharedRoot : path.startsWith(`${b.linkPath}/`) ? `${sharedRoot}${path.slice(b.linkPath.length)}` : path),
      dirId: "task-bbbb2222",
      linkSource: sharedRoot,
    });

    // The confirmation stays open and holds the shared real-path key (盒子 4).
    const turn = a.taskHost.sendMessage("main", "改 spec", { ...writeTurn(`${a.linkPath}/spec.md`), tool: "exec.run" });
    expect(turn.state).toBe("approval");
    const specKey = `${sharedRoot}/spec.md`;
    expect(shared.snapshot().map((holder) => holder.keys)).toEqual([[specKey]]);

    // A second planned turn of the same session fails (the round is not
    // settled) and must release only the key it added itself.
    expect(() => a.taskHost.sendMessage("main", "改 notes", { ...writeTurn(`${a.linkPath}/notes/rfc.md`), tool: "exec.run" })).toThrow(
      "当前执行尚未结束",
    );
    expect(shared.snapshot().map((holder) => holder.keys)).toEqual([[specKey]]);
    // The other task still cannot write the same original while the
    // confirmation is open (盒子 6: shared real path stays serialized).
    expect(() => b.taskHost.sendMessage("main", "改 spec", writeTurn(`${b.linkPath}/spec.md`))).toThrow("shared-path-locked");

    // Settling the confirmation releases everything.
    a.taskHost.approve("main", turn.approvalId ?? "");
    expect(shared.snapshot()).toEqual([]);
  });

  it("keeps the open confirmation's finer real-path key when a later turn targets an ancestor", () => {
    const shared = new SharedPathCoordinator();
    const dirA = "/work/tasks/task-aaaa1111";
    const dirB = "/work/tasks/task-bbbb2222";
    const sharedRoot = "/shared/invoice-docs";
    const linksA: Record<string, string> = {};
    const a = taskHostWithLink({
      taskId: "task-a",
      taskDir: dirA,
      store: memoryTaskStore(),
      shared,
      resolveRealPath: (path) => linkResolver(linksA)(path),
      dirId: "task-aaaa1111",
      linkSource: sharedRoot,
    });
    linksA[a.linkPath] = sharedRoot;
    const b = taskHostWithLink({
      taskId: "task-b",
      taskDir: dirB,
      store: memoryTaskStore(),
      shared,
      resolveRealPath: (path) => (path === b.linkPath ? sharedRoot : path.startsWith(`${b.linkPath}/`) ? `${sharedRoot}${path.slice(b.linkPath.length)}` : path),
      dirId: "task-bbbb2222",
      linkSource: sharedRoot,
    });

    // The confirmation holds the file's key; the second failing turn claims the
    // shared root, which `claim` reduces to the outermost key, so releasing a
    // post-claim read would drop the holder and free the open confirmation.
    const turn = a.taskHost.sendMessage("main", "改 spec", { ...writeTurn(`${a.linkPath}/spec.md`), tool: "exec.run" });
    expect(turn.state).toBe("approval");
    const specKey = `${sharedRoot}/spec.md`;
    expect(() => a.taskHost.sendMessage("main", "改目录", { ...writeTurn(a.linkPath), tool: "exec.run" })).toThrow("当前执行尚未结束");
    expect(shared.snapshot().map((holder) => holder.keys)).toEqual([[specKey]]);
    expect(() => b.taskHost.sendMessage("main", "改 spec", writeTurn(`${b.linkPath}/spec.md`))).toThrow("shared-path-locked");

    a.taskHost.approve("main", turn.approvalId ?? "");
    expect(shared.snapshot()).toEqual([]);
  });

  it("keeps task-private worktree paths parallel across tasks", () => {
    const shared = new SharedPathCoordinator();
    const dirA = "/work/tasks/task-aaaa1111";
    const dirB = "/work/tasks/task-bbbb2222";
    const a = new TaskWorkspaceHost("task-a", dirA, memoryTaskStore(), NOW, () => [], shared);
    const b = new TaskWorkspaceHost("task-b", dirB, memoryTaskStore(), NOW, () => [], shared);
    expect(a.sendMessage("main", "改 A", writeTurn(`${dirA}/src/a.ts`)).state).toBe("done");
    expect(b.sendMessage("main", "改 B", writeTurn(`${dirB}/src/b.ts`)).state).toBe("done");
    // No shared plain directory involved: the cross-task table stays empty.
    expect(shared.snapshot()).toEqual([]);
  });

  it("resolves a real symlink with the filesystem probe (no injected resolver)", () => {
    // The default probe is the production `realpath` path: a real folder, a real
    // in-task symlink and a real task folder, so link following and the macOS
    // `/var` → `/private/var` canonicalization are exercised for real.
    const root = mkdtempSync(join(tmpdir(), "pidock-realpath-"));
    const sharedDir = join(root, "shared-original");
    const otherDir = join(root, "elsewhere");
    mkdirSync(sharedDir);
    mkdirSync(otherDir);
    const taskDir = join(root, "task-abcdef12");
    mkdirSync(taskDir);
    const linkPath = join(taskDir, "dir-invoiced");
    // The link first points at the recorded shared directory.
    symlinkSync(sharedDir, linkPath, process.platform === "win32" ? "junction" : "dir");
    const store = memoryTaskStore();
    store.writeTask(
      taskDir,
      linkedRecord({
        taskId: "task-a",
        dirId: "task-abcdef12",
        taskDir,
        linkName: "dir-invoiced",
        directoryId: "invoice-docs",
        sourcePath: sharedDir,
      }),
    );
    const shared = new SharedPathCoordinator();
    const host = new TaskWorkspaceHost("task-a", taskDir, store, NOW, () => [], shared);
    // The shared root is reported canonical (symlinked tmpdirs included).
    expect(host.sharedRoots()[0]?.realPath).toBe(realpathSync(sharedDir));
    expect(host.pathScopeOf(`${linkPath}/spec.md`)).toMatchObject({ kind: "shared", directoryId: "invoice-docs" });
    expect(host.pathScopeOf(`${taskDir}/src/local.ts`)).toMatchObject({ kind: "task" });
    // A turn targeting the link runs (the scripted `execute` double stands in
    // for the real tool, so this asserts the scope decision, not file bytes).
    expect(host.sendMessage("main", "改 spec", writeTurn(`${linkPath}/spec.md`)).state).toBe("done");
    // Retarget the link outside the recorded root: the lexical path is still
    // inside the task folder, the real path is not, so the write is refused.
    symlinkSync(otherDir, `${linkPath}-next`, process.platform === "win32" ? "junction" : "dir");
    expect(host.pathScopeOf(`${taskDir}/dir-invoiced-next/spec.md`).kind).toBe("outside");
    expect(() => host.sendMessage("main", "越界", writeTurn(`${taskDir}/dir-invoiced-next/spec.md`))).toThrow("path-out-of-scope");
  });

  it("refuses a retargeted link that looks in-task but resolves outside", () => {
    const shared = new SharedPathCoordinator();
    const dir = "/work/tasks/task-aaaa1111";
    const store = memoryTaskStore();
    const setup = taskHostWithLink({
      taskId: "task-a",
      taskDir: dir,
      store,
      shared,
      resolveRealPath: linkResolver({}),
      dirId: "task-aaaa1111",
      linkSource: "/shared/invoice-docs",
    });
    // The recorded link target now resolves to a private directory: the lexical
    // path is still inside the task folder, the real path is not.
    const taskHost = new TaskWorkspaceHost("task-a", dir, store, NOW, () => [], shared, linkResolver({ [setup.linkPath]: "/private/other" }));
    expect(() => taskHost.sendMessage("main", "越界写入", writeTurn(`${setup.linkPath}/spec.md`))).toThrow("path-out-of-scope");
    expect(taskHost.writeLockOwner).toBeNull();
    expect(shared.snapshot()).toEqual([]);
  });

  /** A task record whose only directory source is one plain-directory link. */
  function linkedRecord(input: { taskId: string; dirId: string; taskDir: string; linkName: string; directoryId: string; sourcePath: string }) {
    return buildTaskDiskRecord({
      taskId: input.taskId,
      name: input.taskId,
      dirId: input.dirId,
      branch: `task/${input.dirId}`,
      root: "/work/tasks",
      taskDir: input.taskDir,
      remoteBranch: "main",
      baseCommit: "a5a4a0d1234",
      repos: [],
      dirLinks: [{ linkName: input.linkName, directoryId: input.directoryId, sourcePath: input.sourcePath, snapshotAt: NOW() }],
      now: NOW(),
    });
  }

  it("treats a nested link target as overlapping its outer shared root", () => {
    const shared = new SharedPathCoordinator();
    const dirA = "/work/tasks/task-aaaa1111";
    const dirB = "/work/tasks/task-bbbb2222";
    const root = "/shared/invoice-docs";
    const storeA = memoryTaskStore();
    const storeB = memoryTaskStore();
    const a = new TaskWorkspaceHost("task-a", dirA, storeA, NOW, () => [], shared, () => root);
    const b = new TaskWorkspaceHost("task-b", dirB, storeB, NOW, () => [], shared, (path) => (path.startsWith(dirB) ? `${root}/vendor/manual` : path));
    storeA.writeTask(
      dirA,
      linkedRecord({ taskId: "task-a", dirId: "task-aaaa1111", taskDir: dirA, linkName: "dir-shared", directoryId: "invoice-docs", sourcePath: root }),
    );
    storeB.writeTask(
      dirB,
      linkedRecord({
        taskId: "task-b",
        dirId: "task-bbbb2222",
        taskDir: dirB,
        linkName: "dir-nested",
        directoryId: "vendor-manual",
        sourcePath: `${root}/vendor/manual`,
      }),
    );
    // task-a holds the outer shared directory while its confirmation is open.
    const turn = a.sendMessage("main", "写共享目录", { ...writeTurn(`${dirA}/dir-shared`), tool: "exec.run" });
    expect(turn.state).toBe("approval");
    // task-b's nested link lives below it: overlap through the ancestor.
    expect(() => b.sendMessage("main", "写嵌套", writeTurn(`${dirB}/dir-nested/spec.md`))).toThrow("shared-path-locked");
    // Cancelling the holder releases the ancestor key again.
    a.cancel("main");
    expect(shared.snapshot()).toEqual([]);
  });

  it("keeps a derived execution's shared path and releases it with the cancel/approve paths", () => {
    const shared = new SharedPathCoordinator();
    const dirA = "/work/tasks/task-aaaa1111";
    const dirB = "/work/tasks/task-bbbb2222";
    const root = "/shared/invoice-docs";
    const linksA: Record<string, string> = {};
    const linksB: Record<string, string> = {};
    const a = taskHostWithLink({
      taskId: "task-a",
      taskDir: dirA,
      store: memoryTaskStore(),
      shared,
      resolveRealPath: (path) => linkResolver(linksA)(path),
      dirId: "task-aaaa1111",
      linkSource: root,
    });
    linksA[a.linkPath] = root;
    const b = taskHostWithLink({
      taskId: "task-b",
      taskDir: dirB,
      store: memoryTaskStore(),
      shared,
      resolveRealPath: (path) => linkResolver(linksB)(path),
      dirId: "task-bbbb2222",
      linkSource: root,
    });
    linksB[b.linkPath] = root;
    const blocked = () =>
      expect(() => b.taskHost.sendMessage("main", "改 spec", writeTurn(`${b.linkPath}/spec.md`))).toThrow("shared-path-locked");

    // A turn that stops at a confirmation keeps both the task right and the
    // shared real-path key (盒子 4).
    const turn = a.taskHost.sendMessage("main", "部署共享目录", { ...writeTurn(`${a.linkPath}/spec.md`), tool: "exec.run" });
    expect(turn.state).toBe("approval");
    blocked();
    // A live derived execution keeps the key even after the approval settles.
    expect(a.taskHost.claimDerivedExecution({ resourceId: "child-1", sessionId: "main", label: "构建子进程" })).toBe(true);
    a.taskHost.approve("main", turn.approvalId ?? "");
    blocked();
    // Ending the derived execution releases the shared key.
    a.taskHost.endDerivedExecution("child-1");
    expect(shared.snapshot()).toEqual([]);
    expect(b.taskHost.sendMessage("main", "改 spec", writeTurn(`${b.linkPath}/spec.md`)).state).toBe("done");

    // Cancel releases the key as well (盒子 5: nothing left behind).
    const second = a.taskHost.sendMessage("main", "部署共享目录", { ...writeTurn(`${a.linkPath}/spec.md`), tool: "exec.run" });
    expect(second.state).toBe("approval");
    blocked();
    a.taskHost.cancel("main");
    expect(shared.snapshot()).toEqual([]);
  });
});

// Seam: [PiDock 12] #12 usage ledger (persist, aggregate, dedupe, cleanup).
describe("[PiDock 12] Host usage ledger", () => {
  it("persists a detail per call with attribution, type, end state and completeness", () => {
    const taskHost = host();
    taskHost.provision(provisionInput());
    taskHost.sendMessage("main", "检查构建", {
      usageSource: "actual",
      usage: { input: 120, output: 45, cacheRead: 10, cacheWrite: 5, reasoning: 8, totalTokens: 180 },
    });
    const report = taskHost.usageReport();
    expect(report.details).toHaveLength(1);
    expect(report.details[0]).toMatchObject({
      id: "call-1",
      taskId: TASK_ID,
      sessionId: "main",
      providerId: "provider-local",
      providerVersion: "unversioned",
      requestModel: "pidock-default",
      kind: "turn",
      endState: "completed",
      at: "2026-09-22T10:00:00+08:00",
      usage: { input: 120, output: 45, cacheRead: 10, cacheWrite: 5, source: "actual", completeness: "reported", reasoning: 8, reportedTotal: 180 },
    });
    // reasoning stays inside output and the provider total is never re-added.
    expect(report.totals).toMatchObject({ calls: 1, reported: 1, input: 120, output: 45, cacheRead: 10, cacheWrite: 5, reasoning: 8 });
    expect(report.window.label).toContain("UTC+08:00");
    expect(report.definitions.length).toBeGreaterThan(0);
  });

  it("reads the persisted ledger after a restart instead of re-adding consumption", () => {
    const store = memoryTaskStore();
    const first = new TaskWorkspaceHost(TASK_ID, TASK_DIR, store, () => "2026-09-22T10:00:00+08:00");
    first.provision(provisionInput());
    first.sendMessage("main", "检查构建", { usageSource: "actual", usage: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0 } });
    // Reopening the same task (fresh Host over the same store) must report the
    // same single call, not a second one.
    const reopened = new TaskWorkspaceHost(TASK_ID, TASK_DIR, store, () => "2026-09-22T10:05:00+08:00");
    const report = reopened.usageReport();
    expect(report.details).toHaveLength(1);
    expect(report.totals).toMatchObject({ calls: 1, input: 100, output: 40 });
    reopened.usageReport();
    expect(reopened.usageReport().details).toHaveLength(1);
  });

  it("groups by the requested dimension and filters by range, provider, session and type", () => {
    const taskHost = host();
    taskHost.provision(provisionInput());
    taskHost.sendMessage("main", "检查构建", { usageSource: "actual", usage: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0 } });
    taskHost.compactSession({ sessionId: "main", usageSource: "actual", usage: { input: 80, output: 20, cacheRead: 0, cacheWrite: 0 } });
    const byKind = taskHost.usageReport({ groupBy: "kind" });
    expect(byKind.groups.map((group) => group.key).sort()).toEqual(["compaction", "turn"]);
    expect(byKind.totals.calls).toBe(2);
    expect(taskHost.usageReport({ kind: "compaction" }).details).toHaveLength(1);
    expect(taskHost.usageReport({ providerId: "provider-local" }).details).toHaveLength(2);
    expect(taskHost.usageReport({ providerId: "provider-anthropic" }).details).toHaveLength(0);
    expect(taskHost.usageReport({ sessionId: "main" }).details).toHaveLength(2);
    expect(taskHost.usageReport({ from: "2026-09-22", to: "2026-09-22" }).details).toHaveLength(2);
    expect(taskHost.usageReport({ from: "2026-09-23" }).details).toHaveLength(0);
    expect(taskHost.usageDimensions().map((dimension) => dimension.id)).toContain("provider");
  });

  it("counts a failed attempt and a cancelled attempt as their own attempts", () => {
    const taskHost = host();
    taskHost.provision(provisionInput());
    // A denied tool call settles the turn as failed (the scripted plan is how
    // the RPC surface reaches the gate: `toolPlan` carries data, not code).
    taskHost.sendMessage("main", "越界写入", {
      usageSource: "actual",
      usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0 },
      tool: "fs.write",
      target: "/etc/passwd",
      execute: (call) => ({ tool: call.tool, kind: call.kind, target: "/etc/passwd", contentVersion: call.contentVersion, output: "denied" }),
    });
    const waiting = taskHost.sendMessage("main", "等待确认", {
      usageSource: "actual",
      usage: { input: 60, output: 6, cacheRead: 0, cacheWrite: 0 },
      tool: "exec.run",
      target: `${TASK_DIR}/run.sh`,
      execute: (call) => ({ tool: call.tool, kind: call.kind, target: call.target, contentVersion: call.contentVersion, output: "pending" }),
    });
    expect(waiting.state).toBe("approval");
    expect(taskHost.usageReport().details.map((detail) => detail.endState)).toEqual(["failed", "awaiting-approval"]);
    taskHost.cancel("main");
    const report = taskHost.usageReport();
    expect(report.details.map((detail) => detail.endState)).toEqual(["failed", "cancelled"]);
    expect(report.totals).toMatchObject({ calls: 2, input: 110 });
  });

  it("clears only the named scope and never restores it on the next sync", () => {
    const taskHost = host();
    taskHost.provision(provisionInput());
    taskHost.sendMessage("main", "检查构建", { usageSource: "actual", usage: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0 } });
    taskHost.sendMessage("review", "复核构建", { usageSource: "actual", usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 } });
    expect(taskHost.usageReport().details).toHaveLength(2);
    // Archiving/reading a conversation keeps usage: only clearUsage removes it.
    expect(taskHost.usageReport({ sessionId: "main" }).details).toHaveLength(1);
    const cleared = taskHost.clearUsage({ kind: "session", sessionId: "review" });
    expect(cleared).toMatchObject({ removed: 1, remaining: 1 });
    expect(cleared.description).toContain("review");
    expect(taskHost.usageReport().details.map((detail) => detail.sessionId)).toEqual(["main"]);
    // A later turn re-syncs from the sessions; the cleaned scope stays clean.
    taskHost.sendMessage("main", "再检查", { usageSource: "actual", usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 } });
    expect(taskHost.usageReport().details.map((detail) => detail.sessionId)).toEqual(["main", "main"]);
    const all = taskHost.clearUsage({ kind: "all" });
    expect(all.remaining).toBe(0);
    expect(taskHost.usageReport().details).toHaveLength(0);
  });

  it("records a call made after a cleanup instead of treating the scope as a permanent filter", () => {
    const taskHost = host();
    taskHost.provision(provisionInput());
    taskHost.sendMessage("main", "检查构建", { usageSource: "actual", usage: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0 } });
    expect(taskHost.clearUsage({ kind: "session", sessionId: "main" })).toMatchObject({ removed: 1, remaining: 0 });
    // The session still holds `call-1`; the cleanup removed that key, not the
    // session's right to record new consumption.
    taskHost.sendMessage("main", "再检查", { usageSource: "actual", usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 } });
    const afterSession = taskHost.usageReport();
    expect(afterSession.details.map((detail) => detail.id)).toEqual(["call-2"]);
    expect(afterSession.totals).toMatchObject({ calls: 1, input: 5, output: 1 });
    // "清理全部用量" is one-shot as well.
    expect(taskHost.clearUsage({ kind: "all" }).remaining).toBe(0);
    taskHost.sendMessage("main", "第三次", { usageSource: "actual", usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0 } });
    expect(taskHost.usageReport().details.map((detail) => detail.id)).toEqual(["call-3"]);
  });

  it("keeps a restarted task's new call distinct from the restored one", () => {
    const store = memoryTaskStore();
    const first = new TaskWorkspaceHost(TASK_ID, TASK_DIR, store, () => "2026-09-22T10:00:00+08:00");
    first.provision(provisionInput());
    first.sendMessage("main", "检查构建", { usageSource: "actual", usage: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0 } });
    // The app restarts: the process-local id counters reset while the restored
    // session still holds `call-1`. A re-minted `call-1` would merge the two
    // calls into one ledger row (one call's consumption disappears).
    resetPiSequencesForTests();
    const reopened = new TaskWorkspaceHost(TASK_ID, TASK_DIR, store, () => "2026-09-22T10:05:00+08:00");
    reopened.sendMessage("main", "再检查", { usageSource: "actual", usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 } });
    const report = reopened.usageReport();
    expect(report.details.map((detail) => detail.id).sort()).toEqual(["call-1", "call-2"]);
    expect(report.totals).toMatchObject({ calls: 2, input: 105, output: 41 });
  });

  it("keeps usage when the conversation is archived or removed from the store", () => {
    const store = memoryTaskStore();
    const taskHost = new TaskWorkspaceHost(TASK_ID, TASK_DIR, store, () => "2026-09-22T10:00:00+08:00");
    taskHost.provision(provisionInput());
    taskHost.sendMessage("main", "检查构建", { usageSource: "actual", usage: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0 } });
    // Archiving/dropping the conversation is not a usage cleanup: the ledger
    // keeps its own rows (box 8).
    store.sessions.delete(`${TASK_DIR}::main`);
    const report = taskHost.usageReport();
    expect(report.details).toHaveLength(1);
    expect(report.totals).toMatchObject({ calls: 1, input: 100, output: 40 });
  });

  it("keeps a before-date cleanup on the declared timezone boundary", () => {
    const taskHost = host();
    taskHost.provision(provisionInput());
    taskHost.sendMessage("main", "检查构建", { usageSource: "actual", usage: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0 } });
    // The call sits at 2026-09-22T10:00:00+08:00: a cutoff on an earlier day
    // removes nothing, a cutoff at the end of that day removes it.
    expect(taskHost.clearUsage({ kind: "before", before: "2026-09-01" })).toMatchObject({ removed: 0, remaining: 1 });
    expect(taskHost.clearUsage({ kind: "before", before: "2026-09-22" })).toMatchObject({ removed: 1, remaining: 0 });
    expect(taskHost.usageReport().details).toHaveLength(0);
  });
});

describe("[PiDock 14] (#17) cleanup usage goes through the recorded clearUsage scope", () => {
  it("keeps the removed usage details gone when the session step failed and a later sync runs", () => {
    const store = memoryTaskStore();
    // The session step fails on purpose: the session (and its `call-1` record)
    // stays in the store while the cleanup still removes the usage details.
    const storeWithFailingDelete = {
      ...store,
      deleteSession: (): void => {
        throw new Error("delete-failed: 会话快照被占用");
      },
    };
    const keepRoot = mkdtempSync(join(tmpdir(), "pidock-cleanup-keep-"));
    try {
      const taskHost = new TaskWorkspaceHost(TASK_ID, TASK_DIR, storeWithFailingDelete, () => "2026-09-22T10:00:00+08:00");
      taskHost.provision(provisionInput());
      taskHost.sendMessage("main", "检查构建", { usageSource: "actual", usage: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0 } });
      expect(taskHost.usageReport().details.map((detail) => detail.id)).toEqual(["call-1"]);

      const owner = new TaskLifecycleHost(
        TASK_ID,
        TASK_DIR,
        storeWithFailingDelete,
        createLifecycleResources({ host: taskHost, services: () => null, terminals: () => null, sessionIds: () => taskHost.sessionIds(), liveProcesses: () => [] }),
        () => "2026-09-22T12:00:00+08:00",
        keepRoot,
      );
      owner.archive();
      const result = owner.runCleanup({ selection: { exportSessions: false, exportDrafts: false, exportUsage: false }, keepRoot });

      // The failed step is named with its own reason, and a partial cleanup
      // never claims the project was released.
      expect(result.recovery).toEqual([{ item: "sessions", reason: "delete-failed: 会话快照被占用" }]);
      expect(result.receipt).toMatchObject({ partialFailure: true });
      expect(result.record.projectReleased).toBe(false);
      // The failed session step does not skip the usage removal.
      expect(result.receipt?.removed).toEqual(["usage"]);

      // The session still holds `call-1`, so a sync re-derives it; the recorded
      // cleanup keys are what keep the removed detail gone instead of reviving.
      expect(taskHost.usageReport().details).toEqual([]);
      expect(taskHost.usageReport().details).toEqual([]);

      // A call made after the cleanup has a new key and is recorded normally:
      // the cleanup is a one-shot removal, not a permanent filter.
      taskHost.sendMessage("main", "再检查", { usageSource: "actual", usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 } });
      expect(taskHost.usageReport().details.map((detail) => detail.id)).toEqual(["call-2"]);
    } finally {
      rmSync(keepRoot, { recursive: true, force: true });
    }
  });
});
