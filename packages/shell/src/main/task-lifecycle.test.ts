/**
 * Tests for the [PiDock 14] (#17) S1 lifecycle rules. Pure: no fs, no process
 * control, no Electron. Every case is written from the issue boxes it locks.
 */
import { describe, expect, it } from "vitest";
import {
  backgroundPolicyFor,
  cleanupSelectionLabels,
  evaluateCleanupGate,
  planArchive,
  planCleanupRemoval,
  planExplicitQuit,
  planRelaunch,
  previewCleanup,
  verifyCleanupTarget,
  verifyGitResourceIdentity,
  verifyLinkRemoval,
  verifyProcessIdentity,
  type CleanupIdentityInput,
  type LiveProcessObservation,
} from "./task-lifecycle.js";

const TASK_DIR = "/Users/dev/pidock/tasks/task-aaaaaaaa";

const live = (pid: number, overrides: Partial<LiveProcessObservation> = {}): LiveProcessObservation => ({
  pid,
  startedAt: "2026-09-22T10:00:00+08:00",
  command: "node server.js",
  cwd: TASK_DIR,
  ...overrides,
});

describe("verifyProcessIdentity", () => {
  it("claims a process whose full recorded identity (pid + start time + command + cwd) still matches", () => {
    const verdict = verifyProcessIdentity({ pid: 4321, startedAt: "2026-09-22T10:00:00+08:00", command: "node server.js", cwd: TASK_DIR }, [live(4321)]);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.matchedBy).toBe("identity");
  });

  it("never claims by port alone", () => {
    const verdict = verifyProcessIdentity({ port: 5173 }, [live(4321, { port: 5173 })]);
    expect(verdict).toMatchObject({ ok: false, code: "port-only" });
  });

  it("refuses a recycled pid whose start time differs", () => {
    const verdict = verifyProcessIdentity(
      { pid: 4321, startedAt: "2026-09-22T09:00:00+08:00", command: "node server.js", cwd: TASK_DIR },
      [live(4321)],
    );
    expect(verdict).toMatchObject({ ok: false, code: "stale-pid" });
  });

  it("refuses a pid that is gone and an incomplete claim", () => {
    expect(verifyProcessIdentity({ pid: 9999, startedAt: "2026-09-22T10:00:00+08:00", command: "node", cwd: TASK_DIR }, [live(4321)])).toMatchObject({
      ok: false,
      code: "unknown-process",
    });
    expect(verifyProcessIdentity({ pid: 4321 }, [live(4321)])).toMatchObject({ ok: false, code: "incomplete-claim" });
    expect(verifyProcessIdentity({ startedAt: "2026-09-22T10:00:00+08:00" }, [live(4321)])).toMatchObject({ ok: false, code: "incomplete-claim" });
  });

  it("accepts the recorded service/terminal identity (pid + start time) and strengthens with command/cwd when known", () => {
    // A registered service/terminal identity records pid + startedAt only.
    expect(verifyProcessIdentity({ pid: 11, startedAt: "t1" }, [live(11, { startedAt: "t1", command: "node server.js", cwd: TASK_DIR })])).toMatchObject({ ok: true });
    // With a recorded command, a mismatch is refused even though the pid and start time match.
    expect(verifyProcessIdentity({ pid: 11, startedAt: "t1", command: "node server.js" }, [live(11, { startedAt: "t1", command: "node other.js" })])).toMatchObject({
      ok: false,
      code: "identity-mismatch",
    });
  });

  it("refuses a pid now running a different command or cwd", () => {
    const verdict = verifyProcessIdentity(
      { pid: 4321, startedAt: "2026-09-22T10:00:00+08:00", command: "node server.js", cwd: TASK_DIR },
      [live(4321, { cwd: "/Users/dev/other-task" })],
    );
    expect(verdict).toMatchObject({ ok: false, code: "identity-mismatch" });
  });
});

describe("verifyGitResourceIdentity", () => {
  const record = { repoDir: `${TASK_DIR}/invoice-service`, branch: "task-aaaaaaaa", baseCommit: "9acb5b6f" };

  it("accepts the recorded task worktree", () => {
    const verdict = verifyGitResourceIdentity({
      record,
      observed: { repoDir: record.repoDir, head: "deadbeef", branch: "task-aaaaaaaa", isWorktree: true, baseCommitReachable: true },
    });
    expect(verdict).toMatchObject({ ok: true, head: "deadbeef" });
  });

  it("refuses the original checkout and a replaced folder", () => {
    expect(
      verifyGitResourceIdentity({
        record,
        observed: { repoDir: record.repoDir, head: "deadbeef", branch: "task-aaaaaaaa", isWorktree: false, baseCommitReachable: true },
      }),
    ).toMatchObject({ ok: false, code: "not-a-worktree" });
    expect(verifyGitResourceIdentity({ record, observed: undefined })).toMatchObject({ ok: false, code: "missing" });
  });

  it("refuses a branch switch, an unreachable base commit and an unknown base", () => {
    const base = { repoDir: record.repoDir, head: "deadbeef", isWorktree: true as const };
    expect(verifyGitResourceIdentity({ record, observed: { ...base, branch: "main", baseCommitReachable: true } })).toMatchObject({
      ok: false,
      code: "branch-mismatch",
    });
    expect(verifyGitResourceIdentity({ record, observed: { ...base, branch: "task-aaaaaaaa", baseCommitReachable: false } })).toMatchObject({
      ok: false,
      code: "history-rewritten",
    });
    expect(verifyGitResourceIdentity({ record, observed: { ...base, branch: "task-aaaaaaaa", baseCommitReachable: null } })).toMatchObject({
      ok: false,
      code: "base-unverified",
    });
  });
});

describe("planExplicitQuit", () => {
  const task = {
    taskId: "task-aaaaaaaa",
    sessions: [
      { sessionId: "main", runState: "running" },
      { sessionId: "review", runState: "idle" },
    ],
    services: [
      { serviceId: "invoice-service", running: true, process: { pid: 11, startedAt: "t1", command: "node", cwd: TASK_DIR } },
      { serviceId: "bff", running: false },
    ],
    terminals: [{ instanceId: "term-1", live: true, process: { pid: 22, startedAt: "t2", command: "zsh", cwd: TASK_DIR } }],
    processTrees: [{ resourceId: "tree-1", live: true, process: { pid: 33, startedAt: "t3", command: "pnpm", cwd: TASK_DIR } }],
  };

  it("aborts the agent before stopping services, terminals and process trees, then saves state", () => {
    const plan = planExplicitQuit({
      tasks: [task],
      live: [
        live(11, { startedAt: "t1", command: "node" }),
        live(22, { startedAt: "t2", command: "zsh" }),
        live(33, { startedAt: "t3", command: "pnpm" }),
      ],
    });
    expect(plan.failures).toEqual([]);
    expect(plan.retainedTasks).toEqual([]);
    expect(plan.steps.filter((step) => step.status === "needed").map((step) => step.phase)).toEqual([
      "abort-agent",
      "stop-services",
      "stop-terminals",
      "stop-process-tree",
      "save-state",
    ]);
    expect(plan.steps.find((step) => step.subject === "bff")).toMatchObject({ status: "already-stopped" });
  });

  it("blocks on an unverifiable resource, keeps the task and reports a locatable failure", () => {
    const plan = planExplicitQuit({
      tasks: [
        {
          ...task,
          services: [{ serviceId: "invoice-service", running: true, process: { port: 5173 } }],
          terminals: [],
          processTrees: [],
        },
      ],
      live: [],
    });
    expect(plan.failures).toEqual([
      { taskId: "task-aaaaaaaa", subject: "invoice-service", code: "port-only", reason: expect.stringContaining("端口不是进程身份") },
    ]);
    expect(plan.retainedTasks).toEqual(["task-aaaaaaaa"]);
    expect(plan.steps.find((step) => step.subject === "invoice-service")).toMatchObject({ status: "blocked" });
    // The task is still saved: a blocked stop never silently drops it.
    expect(plan.steps.at(-1)).toMatchObject({ phase: "save-state", status: "needed" });
  });

  it("treats a service with no reported process as already stopped instead of guessing", () => {
    const plan = planExplicitQuit({ tasks: [{ ...task, terminals: [], processTrees: [], services: [{ serviceId: "invoice-service", running: true }] }], live: [] });
    expect(plan.failures).toEqual([]);
    expect(plan.steps.find((step) => step.subject === "invoice-service")).toMatchObject({ status: "already-stopped" });
  });
});

describe("backgroundPolicyFor", () => {
  it("keeps execution alive on window close for macOS and never claims it without a tray entry", () => {
    expect(backgroundPolicyFor({ platform: "darwin" })).toMatchObject({ windowClosedContinues: true, reEntry: "reopen-window" });
    expect(backgroundPolicyFor({ platform: "win32" })).toMatchObject({ windowClosedContinues: false, reEntry: "unavailable" });
    expect(backgroundPolicyFor({ platform: "win32" }).detail).toContain("未实现");
  });
});

describe("planArchive", () => {
  it("stops runs, expires un-executed confirmations, pauses schedules and keeps every record", () => {
    const plan = planArchive({
      taskId: "task-aaaaaaaa",
      sessions: [
        { sessionId: "main", runState: "approval" },
        { sessionId: "review", runState: "done" },
      ],
      pendingApprovals: ["approval-1"],
      schedules: [
        { scheduleId: "daily", enabled: true },
        { scheduleId: "weekly", enabled: false },
      ],
      kept: { worktrees: 2, protocolBindings: 3, browserPages: 4, templateVersion: "v12" },
      usageDetails: 7,
    });
    expect(plan.stoppedSessions).toEqual(["main"]);
    expect(plan.expiredApprovals).toEqual(["approval-1"]);
    expect(plan.pausedSchedules).toEqual(["daily"]);
    expect(plan.usage).toEqual({ detailsBefore: 7, detailsAfter: 7, preserved: true });
    expect(plan.scheduleResumedOnRestore).toBe(false);
    expect(plan.kept.map((entry) => entry.label)).toEqual(["代码工作副本", "会话与草稿", "模板版本", "生成绑定记录", "浏览器状态"]);
    expect(plan.kept.find((entry) => entry.label === "模板版本")?.detail).toContain("v12");
  });
});

describe("cleanup", () => {
  const selection = { exportSessions: false, exportDrafts: false, exportUsage: false };
  const base = {
    archived: true,
    code: { uncommitted: true, undelivered: false },
    counts: { sessions: 2, drafts: 1, usageRecords: 5, browserPages: 1, terminals: 1 },
    worktree: true,
    links: [{ linkName: "dir-51cd20bb", sourcePath: "/Users/dev/work/invoice-docs" }],
  };

  it("requires an archived task", () => {
    expect(evaluateCleanupGate({ archived: false })).toMatchObject({ ok: false });
    expect(previewCleanup({ ...base, archived: false, selection }).warnings).toEqual(["只有已归档任务可清理；归档与清理相互独立"]);
  });

  it("lists the scope: code kept as an independent copy, plain-dir link only, usage scope shown", () => {
    const preview = previewCleanup({ ...base, selection });
    expect(preview.items.find((item) => item.id === "code")).toMatchObject({ disposition: "keep-copy" });
    expect(preview.items.find((item) => item.id === "code")?.detail).toContain("独立代码副本");
    expect(preview.items.find((item) => item.id === "link:dir-51cd20bb")?.detail).toContain("永不沿链接删除原目录 /Users/dev/work/invoice-docs");
    expect(preview.items.find((item) => item.id === "usage")?.detail).toContain("5 条用量记录");
    expect(preview.recordsWillBeRemoved).toBe(true);
    expect(preview.warnings.join(" ")).toContain("将被移除");
  });

  it("does not warn about removal once every record is exported", () => {
    const preview = previewCleanup({ ...base, selection: { exportSessions: true, exportDrafts: true, exportUsage: true } });
    expect(preview.recordsWillBeRemoved).toBe(false);
    expect(cleanupSelectionLabels({ exportSessions: true, exportDrafts: false, exportUsage: true })).toEqual(["导出会话", "导出用量"]);
  });

  it("refuses removal when the kept copy or exports were not verified", () => {
    const items = previewCleanup({ ...base, selection }).items;
    const plan = planCleanupRemoval({ items, verification: { codeCopyOk: false, exportsOk: true, retainedPosition: null } });
    expect(plan.ok).toBe(false);
    expect(plan.error).toContain("cleanup-keep-failed");
    expect(plan.receipt).toBeNull();
    expect(plan.steps.map((step) => step.phase)).toEqual(["verify-keep"]);
    expect(plan.recovery.length).toBe(items.length);
  });

  it("keeps the project registration and per-item recovery entries on partial failure", () => {
    const items = previewCleanup({ ...base, selection }).items;
    const plan = planCleanupRemoval({
      items,
      verification: { codeCopyOk: true, exportsOk: true, retainedPosition: "/Users/dev/kept/task-aaaaaaaa" },
      outcomes: [{ id: "link:dir-51cd20bb", ok: false, reason: "链接已被外部替换" }],
    });
    expect(plan.ok).toBe(true);
    expect(plan.receipt).toMatchObject({ keptPosition: "/Users/dev/kept/task-aaaaaaaa", partialFailure: true });
    expect(plan.receipt?.removed).not.toContain("link:dir-51cd20bb");
    expect(plan.recovery).toEqual([{ item: "link:dir-51cd20bb", reason: "链接已被外部替换" }]);
    expect(plan.steps.find((step) => step.phase === "deregister-project")).toMatchObject({ status: "blocked" });
  });

  it("leaves a receipt and allows deregistration when everything succeeded", () => {
    const items = previewCleanup({ ...base, selection }).items;
    const plan = planCleanupRemoval({
      items,
      verification: { codeCopyOk: true, exportsOk: true, retainedPosition: "/Users/dev/kept/task-aaaaaaaa" },
    });
    expect(plan.receipt).toMatchObject({ partialFailure: false });
    expect(plan.steps.find((step) => step.phase === "deregister-project")).toMatchObject({ status: "ready" });
    expect(plan.recovery).toEqual([]);
  });
});

describe("verifyCleanupTarget", () => {
  const identity: CleanupIdentityInput = {
    taskId: "task-aaaaaaaa",
    taskDir: TASK_DIR,
    knownLinkNames: { "dir-51cd20bb": "/Users/dev/work/invoice-docs" },
    originalCheckoutPaths: ["/Users/dev/work/apiserver"],
    otherTaskDirs: ["/Users/dev/pidock/tasks/task-bbbbbbbb"],
  };

  it("accepts the task folder and a recorded in-task link", () => {
    expect(verifyCleanupTarget(TASK_DIR, identity)).toMatchObject({ ok: true, kind: "task-dir" });
    expect(verifyCleanupTarget(`${TASK_DIR}/dir-51cd20bb`, identity)).toMatchObject({ ok: true, kind: "in-task-link" });
  });

  it("refuses the original checkout, another task's folder and anything outside the task", () => {
    expect(verifyCleanupTarget("/Users/dev/work/apiserver", identity)).toMatchObject({ ok: false, code: "original-checkout" });
    expect(verifyCleanupTarget("/Users/dev/pidock/tasks/task-bbbbbbbb/session.json", identity)).toMatchObject({ ok: false, code: "other-task" });
    expect(verifyCleanupTarget("/Users/dev/work/invoice-docs", identity)).toMatchObject({ ok: false, code: "outside-task" });
    // An in-task path that is not a recorded link is not a cleanable link.
    expect(verifyCleanupTarget(`${TASK_DIR}/dir-unknown/spec.md`, identity)).toMatchObject({ ok: false, code: "outside-task" });
  });

  it("does not let a `..` segment escape the task folder", () => {
    expect(verifyCleanupTarget(`${TASK_DIR}/../task-bbbbbbbb`, identity)).toMatchObject({ ok: false, code: "other-task" });
  });
});

describe("verifyLinkRemoval", () => {
  it("removes only the link and reports an externally retargeted target", () => {
    expect(
      verifyLinkRemoval({
        expectedLinkName: "dir-51cd20bb",
        recordedSourcePath: "/Users/dev/work/invoice-docs",
        observation: { isSymlink: true, isDirectory: false, currentTarget: "/Users/dev/work/invoice-docs" },
      }),
    ).toMatchObject({ ok: true, retargeted: false });
    const retargeted = verifyLinkRemoval({
      expectedLinkName: "dir-51cd20bb",
      recordedSourcePath: "/Users/dev/work/invoice-docs",
      observation: { isSymlink: true, isDirectory: false, currentTarget: "/Users/dev/work/other-docs" },
    });
    expect(retargeted).toMatchObject({ ok: true, retargeted: true });
    expect(retargeted.ok && retargeted.detail).toContain("保留当前目标目录");
  });

  it("refuses a replaced real directory, a loop-resolved path and a missing link", () => {
    expect(
      verifyLinkRemoval({
        expectedLinkName: "dir-51cd20bb",
        recordedSourcePath: "/Users/dev/work/invoice-docs",
        observation: { isSymlink: false, isDirectory: true, currentTarget: null },
      }),
    ).toMatchObject({ ok: false, code: "not-a-link" });
    expect(
      verifyLinkRemoval({ expectedLinkName: "dir-51cd20bb", recordedSourcePath: "/x", observation: undefined }),
    ).toMatchObject({ ok: false, code: "already-removed" });
  });
});

describe("planRelaunch", () => {
  const input = {
    availableFiles: ["src/api.ts"],
    availableSkills: ["skills/code-review/SKILL.md"],
    tasks: [
      {
        taskId: "task-aaaaaaaa",
        archived: false,
        browserPages: [{ pageId: "page-1", url: "http://127.0.0.1:5173/invoices" }],
        services: [{ serviceId: "invoice-service", running: true }],
        sessions: [
          {
            sessionId: "main",
            permission: "default",
            actualPermission: "default",
            runState: "running",
            draft: {
              text: "继续对账单核对",
              references: [
                { id: "ref-1", kind: "file", label: "src/api.ts" },
                { id: "ref-2", kind: "file", label: "src/gone.ts" },
                { id: "ref-3", kind: "skill", label: "$code-review", sourceId: "cap-1", resourcePath: "skills/code-review/SKILL.md" },
                { id: "ref-4", kind: "skill", label: "$other", sourceId: "cap-2", resourcePath: "skills/other/SKILL.md" },
              ],
            },
            approvals: [
              { id: "approval-pending", status: "pending" },
              { id: "approval-done", status: "approved", executed: true },
              { id: "approval-consumed", status: "approved", consumedAt: "2026-09-22T10:05:00+08:00" },
            ],
          },
          { sessionId: "review", permission: "bogus", runState: "approval", approvals: [] },
        ],
      },
    ],
  };

  it("restores tasks/sessions/browser, never auto-connects services and never sends drafts", () => {
    const plan = planRelaunch(input);
    expect(plan.autoConnectServices).toBe(false);
    const task = plan.tasks[0]!;
    expect(task.browser).toEqual([{ pageId: "page-1", url: "http://127.0.0.1:5173/invoices", restored: true }]);
    expect(task.services).toEqual([
      { serviceId: "invoice-service", action: "start-on-demand", autoConnect: false, detail: expect.stringContaining("不自动连接业务环境") },
    ]);
    const main = task.sessions[0]!;
    expect(main).toMatchObject({ draftKept: true, autoSent: false, expandedHistory: false, commandsRerun: false, permission: "default", permissionRestored: true });
    expect(main.draftText).toBe("继续对账单核对");
  });

  it("relinks an in-flight/crashed run instead of replaying it", () => {
    const plan = planRelaunch(input);
    expect(plan.tasks[0]!.sessions[0]).toMatchObject({ runState: "idle", linkedTo: "crashed" });
    expect(plan.tasks[0]!.sessions[1]).toMatchObject({ runState: "idle", linkedTo: "in-flight" });
  });

  it("expires pending confirmations, keeps handled ones and replays nothing", () => {
    const approvals = planRelaunch(input).tasks[0]!.sessions[0]!.approvals;
    expect(approvals.replayed).toEqual([]);
    expect(approvals.expiredOnRestore).toEqual(["approval-pending"]);
    expect(approvals.alreadyHandled).toEqual(["approval-consumed", "approval-done"]);
  });

  it("revalidates draft references against available files and skills", () => {
    const references = planRelaunch(input).tasks[0]!.sessions[0]!.references;
    expect(references.map((reference) => [reference.id, reference.state])).toEqual([
      ["ref-1", "ok"],
      ["ref-2", "missing"],
      ["ref-3", "ok"],
      ["ref-4", "skill-unavailable"],
    ]);
  });

  it("falls back to read for an unrecorded permission and warns instead of escalating", () => {
    const plan = planRelaunch(input);
    const review = plan.tasks[0]!.sessions[1]!;
    expect(review.permission).toBe("read");
    expect(review.permissionRestored).toBe(false);
    expect(review.permissionEscalated).toBe(false);
    expect(plan.warnings.join(" ")).toContain("按只读恢复");
  });

  it("keeps the recorded archive flag and does not resume schedules on restore", () => {
    const plan = planRelaunch({ ...input, tasks: [{ ...input.tasks[0]!, archived: true }] });
    expect(plan.tasks[0]!.archived).toBe(true);
    expect(plan.tasks[0]!.sessions.map((session) => session.autoSent)).toEqual([false, false]);
  });
});
