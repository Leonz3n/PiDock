/**
 * Tests for the [PiDock 14] (#17) S2 Host lifecycle state. Everything the state
 * machine touches (process/worktree observation, link lstat, code copy, exports,
 * session/usage deletion) is injected, so these tests need no fs, no git and no
 * live process tree.
 */
import { describe, expect, it } from "vitest";
import { memoryTaskStore } from "./task-host.js";
import { parseLifecycleRecord, serializeLifecycleRecord } from "./task-store.js";
import { TaskLifecycleHost, type LifecycleSession, type TaskLifecycleResources } from "./task-lifecycle.js";
import type { CleanupSelection, GitResourceObservation, LiveProcessObservation } from "../main/task-lifecycle.js";

const TASK_DIR = "/Users/dev/pidock/tasks/task-aaaaaaaa";
const KEEP_ROOT = "/Users/dev/pidock/kept/task-aaaaaaaa";
const NO_EXPORT: CleanupSelection = { exportSessions: false, exportDrafts: false, exportUsage: false };

const session = (overrides: Partial<LifecycleSession> = {}): LifecycleSession => ({
  sessionId: "main",
  permission: "default",
  actualPermission: "default",
  runState: "idle",
  approvals: [],
  ...overrides,
});

interface FakeState {
  calls: string[];
  sessions: LifecycleSession[];
  worktrees: { repoDir: string; branch: string; baseCommit: string }[];
  repos: Record<string, GitResourceObservation>;
  processes: LiveProcessObservation[];
  services: { serviceId: string; running: boolean; process?: { pid?: unknown; startedAt?: unknown; command?: unknown; cwd?: unknown; port?: unknown } }[];
  terminals: { instanceId: string; live: boolean; process?: { pid?: unknown; startedAt?: unknown; command?: unknown; cwd?: unknown } }[];
  paths: Record<string, { isSymlink: boolean; isDirectory: boolean; currentTarget: string | null } | undefined>;
  keepOk: { codeCopyOk: boolean; exportsOk: boolean; retainedPosition: string | null };
  delegated: Record<string, { ok: boolean; reason: string }>;
  browserPages: { pageId: string; url: string }[];
}

function fakeState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    calls: [],
    sessions: [session()],
    worktrees: [{ repoDir: `${TASK_DIR}/invoice-service`, branch: "task-aaaaaaaa", baseCommit: "9acb5b6f" }],
    repos: {
      [`${TASK_DIR}/invoice-service`]: { repoDir: `${TASK_DIR}/invoice-service`, head: "deadbeef", branch: "task-aaaaaaaa", isWorktree: true, baseCommitReachable: true },
    },
    processes: [],
    services: [],
    terminals: [],
    paths: {},
    keepOk: { codeCopyOk: true, exportsOk: true, retainedPosition: KEEP_ROOT },
    delegated: { terminals: { ok: true, reason: "终端记录仅在内存中，已随 Host 生命周期结束" } },
    browserPages: [],
    ...overrides,
  };
}

function build(state: FakeState, store = memoryTaskStore()) {
  const resources: TaskLifecycleResources = {
    platform: () => "darwin",
    sessions: () => state.sessions,
    cancelSession: (sessionId) => {
      state.calls.push(`cancel:${sessionId}`);
      state.sessions = state.sessions.map((entry) =>
        entry.sessionId === sessionId
          ? { ...entry, runState: "cancelled", approvals: entry.approvals.map((approval) => (approval.status === "pending" ? { ...approval, status: "expired" } : approval)) }
          : entry,
      );
    },
    worktrees: () => state.worktrees,
    observeRepo: (repoDir) => state.repos[repoDir],
    usageCount: () => store.readUsage(TASK_DIR).details.length,
    services: () => state.services,
    terminals: () => state.terminals,
    processTrees: () => [],
    links: () => [{ linkName: "dir-51cd20bb", sourcePath: "/Users/dev/work/invoice-docs" }],
    observeInTaskPath: (path) => state.paths[path],
    removeInTaskPath: (path) => state.calls.push(`remove:${path}`),
    originalCheckoutPaths: () => ["/Users/dev/work/apiserver"],
    otherTaskDirs: () => ["/Users/dev/pidock/tasks/task-bbbbbbbb"],
    delivery: () => ({ uncommitted: false, undelivered: false }),
    browserPages: () => state.browserPages,
    availableFiles: () => ["src/api.ts"],
    availableSkills: () => ["skills/code-review/SKILL.md"],
    liveProcesses: () => state.processes,
    keepAndExport: () => {
      state.calls.push("keep");
      return { ...state.keepOk, detail: "保留独立代码副本与所选导出并核验" };
    },
    deleteSession: (sessionId) => {
      state.calls.push(`delete-session:${sessionId}`);
      store.deleteSession(TASK_DIR, sessionId);
    },
    clearUsage: () => {
      state.calls.push("clear-usage");
      store.writeUsage(TASK_DIR, [], []);
    },
    delegateCleanup: (itemId) => state.delegated[itemId] ?? { ok: false, reason: `未接线：${itemId}` },
  };
  const lifecycle = new TaskLifecycleHost("task-aaaaaaaa", TASK_DIR, store, resources, () => "2026-09-22T12:00:00+08:00", KEEP_ROOT);
  return { lifecycle, store, state, resources };
}

function seedUsage(store: ReturnType<typeof memoryTaskStore>, count: number): void {
  store.writeUsage(
    TASK_DIR,
    Array.from({ length: count }, (_, index) => ({
      id: `call-${index + 1}`,
      taskId: "task-aaaaaaaa",
      sessionId: "main",
      providerId: "anthropic",
      providerVersion: "v1",
      requestModel: "claude",
      at: "2026-09-22T10:00:00+08:00",
      kind: "turn" as const,
      endState: "completed" as const,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, source: "actual" as const, completeness: "reported" as const },
    })),
    [],
  );
}

describe("archive / restore", () => {
  it("stops runs, expires pending confirmations, pauses scheduling and keeps usage untouched", () => {
    const store = memoryTaskStore();
    seedUsage(store, 3);
    const state = fakeState({
      sessions: [
        session({ sessionId: "main", runState: "approval", approvals: [{ id: "approval-1", status: "pending", executed: false }] }),
        session({ sessionId: "review", runState: "done" }),
      ],
    });
    const { lifecycle } = build(state, store);

    const { plan, record } = lifecycle.archive();

    expect(state.calls).toEqual(["cancel:main"]);
    expect(plan.stoppedSessions).toEqual(["main"]);
    expect(plan.expiredApprovals).toEqual(["approval-1"]);
    expect(plan.usage).toEqual({ detailsBefore: 3, detailsAfter: 3, preserved: true });
    expect(plan.scheduleResumedOnRestore).toBe(false);
    expect(record).toMatchObject({ archived: true, archivedAt: "2026-09-22T12:00:00+08:00", schedulePaused: true });
    // Archiving keeps the records: no session snapshot and no usage entry is deleted.
    expect(state.calls).not.toContain("delete-session:main");
    expect(store.readUsage(TASK_DIR).details).toHaveLength(3);
    expect(lifecycle.lifecycle().archived).toBe(true);
  });

  it("restores the task without resuming scheduling or starting services", () => {
    const { lifecycle, store } = build(fakeState());
    lifecycle.archive();
    const restored = lifecycle.restore();
    expect(restored).toMatchObject({ scheduleResumed: false, servicesStarted: false });
    expect(restored.record).toMatchObject({ archived: false, schedulePaused: true, restoredAt: "2026-09-22T12:00:00+08:00" });
    expect(store.readLifecycle(TASK_DIR)?.archived).toBe(false);
  });
});

describe("cleanup preview", () => {
  it("refuses a task that is not archived", () => {
    const { lifecycle } = build(fakeState());
    expect(() => lifecycle.cleanupPreview({ selection: NO_EXPORT })).toThrowError(/只有已归档任务可清理/);
  });

  it("lists the treated scope with the retain root and the unselected-removal warning", () => {
    const store = memoryTaskStore();
    seedUsage(store, 2);
    const { lifecycle } = build(
      fakeState({ sessions: [session({ draft: { text: "草稿" } })] }),
      store,
    );
    lifecycle.archive();
    const preview = lifecycle.cleanupPreview({ selection: NO_EXPORT });
    expect(preview.keepRoot).toBe(KEEP_ROOT);
    expect(preview.items.map((item) => item.id)).toEqual(["code", "sessions", "drafts", "usage", "link:dir-51cd20bb"]);
    expect(preview.items.find((item) => item.id === "usage")?.detail).toContain("2 条用量记录");
    expect(preview.recordsWillBeRemoved).toBe(true);
    expect(preview.warnings.join(" ")).toContain("清理不是可一键撤销的归档恢复");
  });
});

describe("cleanup run", () => {
  it("keeps first, then removes identity-confirmed managed resources and records the receipt", () => {
    const store = memoryTaskStore();
    seedUsage(store, 2);
    store.writeSession(TASK_DIR, { sessionId: "main" } as never);
    const state = fakeState({
      sessions: [session()],
      paths: { [`${TASK_DIR}/dir-51cd20bb`]: { isSymlink: true, isDirectory: false, currentTarget: "/Users/dev/work/invoice-docs" } },
    });
    const { lifecycle } = build(state, store);
    lifecycle.archive();

    const result = lifecycle.runCleanup({ selection: { exportSessions: true, exportDrafts: true, exportUsage: true } });

    // Keep/verify happens before any removal.
    expect(state.calls[0]).toBe("keep");
    expect(state.calls).toContain("delete-session:main");
    expect(state.calls).toContain("clear-usage");
    expect(state.calls).toContain(`remove:${TASK_DIR}/dir-51cd20bb`);
    expect(store.sessions.size).toBe(0);
    expect(store.readUsage(TASK_DIR).details).toHaveLength(0);
    expect(result.receipt).toMatchObject({ keptPosition: KEEP_ROOT, partialFailure: false });
    expect(result.record).toMatchObject({ projectReleased: true });
    expect(result.record.cleanup).toMatchObject({ keptPosition: KEEP_ROOT, exports: ["导出会话", "导出草稿", "导出用量"] });
    expect(result.recovery).toEqual([]);
  });

  it("removes nothing when the kept copy or exports fail verification", () => {
    const store = memoryTaskStore();
    store.writeSession(TASK_DIR, { sessionId: "main" } as never);
    const state = fakeState({ keepOk: { codeCopyOk: false, exportsOk: true, retainedPosition: null } });
    const { lifecycle } = build(state, store);
    lifecycle.archive();

    const result = lifecycle.runCleanup({ selection: NO_EXPORT });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("cleanup-keep-failed");
    expect(state.calls).toEqual(["keep"]);
    expect(store.sessions.size).toBe(1);
    expect(result.record.projectReleased).toBe(false);
    expect(result.record.cleanup).toBeNull();
    expect(result.recovery.length).toBe(result.items.length);
  });

  it("keeps the registration, receipt position and per-item recovery on partial failure", () => {
    const store = memoryTaskStore();
    const state = fakeState({ paths: {} });
    // A link that was replaced by a real directory fails closed.
    state.paths[`${TASK_DIR}/dir-51cd20bb`] = { isSymlink: false, isDirectory: true, currentTarget: null };
    const { lifecycle } = build(state, store);
    lifecycle.archive();

    const result = lifecycle.runCleanup({ selection: NO_EXPORT });

    expect(result.receipt).toMatchObject({ partialFailure: true });
    expect(result.recovery.map((entry) => entry.item)).toEqual(["link:dir-51cd20bb"]);
    expect(state.calls).not.toContain(`remove:${TASK_DIR}/dir-51cd20bb`);
    expect(result.record.projectReleased).toBe(false);
    expect(result.record.cleanup?.partialFailure).toBe(true);
    expect(result.steps.find((step) => step.phase === "deregister-project")).toMatchObject({ status: "blocked" });
  });

  it("only ever removes the in-task link, never the original target", () => {
    const state = fakeState({
      paths: { [`${TASK_DIR}/dir-51cd20bb`]: { isSymlink: true, isDirectory: false, currentTarget: "/Users/dev/work/other-docs" } },
    });
    const { lifecycle } = build(state);
    lifecycle.archive();
    const result = lifecycle.runCleanup({ selection: NO_EXPORT });

    const removals = state.calls.filter((call) => call.startsWith("remove:"));
    expect(removals).toEqual([`remove:${TASK_DIR}/dir-51cd20bb`]);
    expect(removals.some((call) => call.includes("/Users/dev/work/"))).toBe(false);
    // The retargeted link is still only the link: the current target is reported, not followed.
    expect(result.items.some((item) => item.id === "link:dir-51cd20bb")).toBe(true);
    expect(result.receipt?.partialFailure).toBe(false);
  });

  it("fails closed for a link that already disappeared", () => {
    const state = fakeState({ paths: {} });
    const { lifecycle } = build(state);
    lifecycle.archive();
    const result = lifecycle.runCleanup({ selection: NO_EXPORT });
    expect(result.recovery).toEqual([{ item: "link:dir-51cd20bb", reason: expect.stringContaining("已不存在") }]);
    expect(state.calls.some((call) => call.startsWith("remove:"))).toBe(false);
  });

  it("fails closed for a delegated effect the Host does not own", () => {
    const state = fakeState({
      browserPages: [{ pageId: "page-1", url: "http://127.0.0.1:5173" }],
      paths: { [`${TASK_DIR}/dir-51cd20bb`]: { isSymlink: true, isDirectory: false, currentTarget: "/Users/dev/work/invoice-docs" } },
    });
    const { lifecycle } = build(state);
    lifecycle.archive();
    const result = lifecycle.runCleanup({ selection: NO_EXPORT });
    expect(result.recovery.map((entry) => entry.item)).toEqual(["browser"]);
    expect(result.recovery[0]!.reason).toContain("未接线");
    expect(result.record.projectReleased).toBe(false);
  });
});

describe("state", () => {
  it("reports identity verdicts for worktrees and live processes (never by port)", () => {
    const state = fakeState({
      repos: {
        [`${TASK_DIR}/invoice-service`]: { repoDir: `${TASK_DIR}/invoice-service`, head: "deadbeef", branch: "main", isWorktree: true, baseCommitReachable: true },
      },
      services: [{ serviceId: "invoice-service", running: true, process: { port: 9001 } }],
      processes: [],
    });
    const store = memoryTaskStore();
    seedUsage(store, 1);
    const { lifecycle } = build(state, store);

    const view = lifecycle.state();

    expect(view.resources.worktrees[0]!.verdict).toMatchObject({ ok: false, code: "branch-mismatch" });
    expect(view.resources.processes).toEqual([{ kind: "service", id: "invoice-service", running: true, verdict: expect.objectContaining({ ok: false, code: "port-only" }) }]);
    expect(view.usageDetails).toBe(1);
    expect(view.background).toMatchObject({ windowClosedContinues: true, reEntry: "reopen-window" });
    // The quit plan is part of the state and keeps the task when identity fails.
    expect(view.quit.failures.map((failure) => failure.code)).toEqual(["port-only"]);
    expect(view.quit.retainedTasks).toEqual(["task-aaaaaaaa"]);
    expect(view.relaunch.autoConnectServices).toBe(false);
  });

  it("verifies a registered process by full identity", () => {
    const state = fakeState({
      services: [{ serviceId: "invoice-service", running: true, process: { pid: 42, startedAt: "t1", command: "node server.js", cwd: TASK_DIR } }],
      processes: [{ pid: 42, startedAt: "t1", command: "node server.js", cwd: TASK_DIR }],
    });
    const view = build(state).lifecycle.state();
    expect(view.resources.processes[0]!.verdict).toMatchObject({ ok: true, matchedBy: "identity" });
    expect(view.quit.steps.find((step) => step.subject === "invoice-service")).toMatchObject({ status: "needed" });
    expect(view.quit.retainedTasks).toEqual([]);
  });

  it("restores a session's recorded permission and never auto-connects a service on relaunch", () => {
    const state = fakeState({
      sessions: [session({ permission: "auto", actualPermission: "default", runState: "running", draft: { text: "继续" } })],
      services: [{ serviceId: "invoice-service", running: true }],
    });
    const view = build(state).lifecycle.state();
    const restored = view.relaunch.tasks[0]!;
    expect(restored.sessions[0]).toMatchObject({ permission: "auto", actualPermission: "default", permissionEscalated: false, runState: "idle", linkedTo: "crashed", autoSent: false });
    expect(restored.services[0]).toMatchObject({ autoConnect: false, action: "start-on-demand" });
  });
});

describe("persisted lifecycle state", () => {
  it("survives a Host restart: archive flag, receipt and recovery entries come from the store", () => {
    const store = memoryTaskStore();
    const state = fakeState({ paths: {} });
    const first = build(state, store).lifecycle;
    first.archive();
    first.runCleanup({ selection: NO_EXPORT });

    const restarted = build(state, store).lifecycle;
    const record = restarted.lifecycle();
    expect(record.archived).toBe(true);
    expect(record.cleanup).toMatchObject({ keptPosition: KEEP_ROOT, partialFailure: true });
    expect(record.recovery.map((entry) => entry.item)).toEqual(["link:dir-51cd20bb"]);
    expect(record.projectReleased).toBe(false);
  });

  it("fails closed on a corrupt lifecycle record", () => {
    const record = {
      taskId: "task-aaaaaaaa",
      archived: true,
      archivedAt: "2026-09-22T12:00:00+08:00",
      restoredAt: null,
      schedulePaused: true,
      cleanup: null,
      recovery: [],
      projectReleased: false,
      updatedAt: "2026-09-22T12:00:00+08:00",
    };
    expect(parseLifecycleRecord(serializeLifecycleRecord(record)).archived).toBe(true);
    expect(() => parseLifecycleRecord(JSON.stringify({ ...record, archived: "yes" }))).toThrowError(/archived must be a boolean/);
    expect(() => parseLifecycleRecord(JSON.stringify({ ...record, recovery: [{ item: "x" }] }))).toThrowError(/recovery.reason/);
  });
});
