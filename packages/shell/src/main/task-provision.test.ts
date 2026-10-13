import { describe, expect, it } from "vitest";
import {
  assertProvisionPlanSafe,
  buildTaskBranch,
  checkDirIdConflict,
  generateTaskDirId,
  isAbsoluteTaskRoot,
  isSafeTaskBranchRef,
  isSafeTaskChildName,
  isTaskDirId,
  pinBaseline,
  planResumeBranch,
  planWorktreeCreation,
  previewTaskPaths,
  resolveTaskRoot,
  validateTaskName,
} from "./task-provision.js";

// Seam: task provisioning rules (display name / dir id / branch / root /
// baseline pin / main-checkout guard). Pure rules so the form, main and Host
// cannot drift apart.

describe("task provisioning rules", () => {
  it("generates a stable ASCII-only directory id", () => {
    expect(generateTaskDirId("abcdef12zzzz")).toBe("task-abcdef12");
    expect(isTaskDirId(generateTaskDirId())).toBe(true);
    expect(isTaskDirId("发布前检查")).toBe(false);
  });

  it("accepts a Chinese display name but rejects a blank one", () => {
    expect(validateTaskName("发布前检查")).toEqual({ ok: true, name: "发布前检查" });
    expect(validateTaskName("   ")).toMatchObject({ ok: false });
    expect(validateTaskName("   ") && (validateTaskName("   ") as { ok: false; error: { code: string } }).error.code).toBe("empty-name");
  });

  it("resolves the task root with a per-creation override that never migrates old tasks", () => {
    expect(resolveTaskRoot("~/PiDockTasks")).toEqual({
      ok: true,
      root: "~/PiDockTasks",
      overridden: false,
    });
    expect(resolveTaskRoot("~/PiDockTasks", "/Volumes/Data/Tasks")).toEqual({
      ok: true,
      root: "/Volumes/Data/Tasks",
      overridden: true,
    });
    expect(resolveTaskRoot("relative/tasks")).toMatchObject({ ok: false });
    expect(resolveTaskRoot("~/PiDockTasks", "relative/tasks")).toMatchObject({
      ok: false,
    });
  });

  it("flags an identifier conflict explicitly", () => {
    expect(checkDirIdConflict("task-abcdef12", ["task-00000001"])).toBeNull();
    expect(checkDirIdConflict("task-abcdef12", ["task-abcdef12"])).toMatchObject({
      code: "identifier-conflict",
    });
  });

  it("previews the exact paths the task will store", () => {
    expect(previewTaskPaths("~/PiDockTasks", "task-abcdef12", ["front-monorepo"], ["dir-abc"])).toEqual({
      taskDir: "~/PiDockTasks/task-abcdef12",
      worktrees: { "front-monorepo": "~/PiDockTasks/task-abcdef12/front-monorepo" },
      links: { "dir-abc": "~/PiDockTasks/task-abcdef12/dir-abc" },
    });
  });

  it("stores the task branch separately with a safe default", () => {
    expect(buildTaskBranch("task-abcdef12")).toEqual({ ok: true, branch: "task/task-abcdef12" });
    expect(buildTaskBranch("task-abcdef12", "feature/checkout-fix")).toEqual({
      ok: true,
      branch: "feature/checkout-fix",
    });
    expect(buildTaskBranch("task-abcdef12", "bad branch")).toMatchObject({ ok: false });
  });

  it("pins the freshly fetched commit and keeps the form on fetch failure", () => {
    expect(pinBaseline("main", "a5a4a0d1234")).toEqual({
      ok: true,
      remoteBranch: "main",
      commit: "a5a4a0d1234",
    });
    expect(pinBaseline("main", "")).toMatchObject({ ok: false });
    const failed = pinBaseline("main", "");
    if (!failed.ok) expect(failed.error.code).toBe("fetch-failed");
  });

  it("rejects unsafe repo/link child names that would escape the task dir", () => {
    for (const bad of ["", ".", "..", "a/b", "a\\b", "../evil", "..\\evil", " spaced ", "a\0b"]) {
      expect(isSafeTaskChildName(bad), bad).toBe(false);
    }
    expect(isSafeTaskChildName("front-monorepo")).toBe(true);
    expect(() => previewTaskPaths("~/PiDockTasks", "task-abcdef12", ["../../evil"], [])).toThrow("invalid-path");
    expect(() =>
      planWorktreeCreation({
        taskDir: "~/PiDockTasks/task-abcdef12",
        mainCheckoutDir: "/Users/name/Workspace/repo",
        repoDir: "../evil",
        remoteBranch: "main",
        commit: "a5a4a0d1234",
        branch: "task/task-abcdef12",
      }),
    ).toThrow("invalid-path");
  });

  it("rejects branch fragments with traversal, control chars, or lock suffix", () => {
    expect(buildTaskBranch("task-abcdef12", "feature/../evil")).toMatchObject({ ok: false });
    expect(buildTaskBranch("task-abcdef12", "feature@{1}")).toMatchObject({ ok: false });
    expect(buildTaskBranch("task-abcdef12", "feature.lock")).toMatchObject({ ok: false });
    expect(buildTaskBranch("task-abcdef12", "bad\u0001branch")).toMatchObject({ ok: false });
  });

  it("normalizes the main-checkout comparison before enforcing the guard", () => {
    expect(() =>
      assertProvisionPlanSafe({
        mainCheckoutDir: "/Users/name/Workspace/repo",
        ops: [{ kind: "pull", cwd: "/Users/name/Workspace/repo/./", args: ["pull"] }],
      }),
    ).toThrow("forbidden-main-op");
    expect(() =>
      assertProvisionPlanSafe({
        mainCheckoutDir: "D:\\Tasks\\repo",
        ops: [{ kind: "reset", cwd: "d:/Tasks/repo/", args: ["reset"] }],
      }),
    ).toThrow("forbidden-main-op");
  });

  it("fetches the named remote (never hardcoded origin)", () => {
    const plan = planWorktreeCreation({
      taskDir: "/tasks/task-abcdef12",
      mainCheckoutDir: "/src/invoice",
      repoDir: "invoice",
      remote: "upstream",
      remoteBranch: "release/v2",
      commit: "beef001234",
      branch: "task/task-abcdef12",
    });
    expect(plan.ops[0]).toMatchObject({ kind: "fetch", cwd: "/src/invoice", args: ["fetch", "upstream", "release/v2"] });
    const legacy = planWorktreeCreation({
      taskDir: "~/PiDockTasks/task-abcdef12",
      mainCheckoutDir: "/Users/name/Workspace/repo",
      repoDir: "front-monorepo",
      remoteBranch: "main",
      commit: "a5a4a0d1234",
      branch: "task/task-abcdef12",
    });
    expect(legacy.ops[0].args).toEqual(["fetch", "origin", "main"]);
  });

  it("forbids pull/merge/reset against the main checkout directory", () => {
    const plan = planWorktreeCreation({
      taskDir: "~/PiDockTasks/task-abcdef12",
      mainCheckoutDir: "/Users/name/Workspace/repo",
      repoDir: "front-monorepo",
      remoteBranch: "main",
      commit: "a5a4a0d1234",
      branch: "task/task-abcdef12",
    });
    expect(plan.ops.map((op) => op.kind)).toEqual(["fetch", "branch", "worktree"]);
    expect(() =>
      assertProvisionPlanSafe({
        mainCheckoutDir: "/Users/name/Workspace/repo",
        ops: [{ kind: "pull", cwd: "/Users/name/Workspace/repo", args: ["pull"] }],
      }),
    ).toThrow("forbidden-main-op");
  });

  it("reuses an existing task branch by omitting the redundant `git branch` op", () => {
    const plan = planWorktreeCreation({
      taskDir: "/tasks/task-abcdef12",
      mainCheckoutDir: "/src/invoice",
      repoDir: "invoice",
      remoteBranch: "main",
      commit: "beef001234",
      branch: "task/task-abcdef12",
      reuseExistingBranch: true,
    });
    expect(plan.ops.map((op) => op.kind)).toEqual(["fetch", "worktree"]);
    expect(plan.ops[1]!.args).toEqual(["worktree", "add", "/tasks/task-abcdef12/invoice", "task/task-abcdef12"]);
  });

  it("rejects an unsafe branch before it can enter git argv", () => {
    expect(isSafeTaskBranchRef("task/task-abcdef12")).toBe(true);
    expect(isSafeTaskBranchRef("feature/checkout-fix")).toBe(true);
    for (const bad of ["-m", "--force", "", "bad branch", "feature/../evil", "feature@{1}", "feature.lock", "a\u0001b"]) {
      expect(isSafeTaskBranchRef(bad), bad).toBe(false);
    }
    expect(isSafeTaskBranchRef(undefined)).toBe(false);
    expect(() =>
      planWorktreeCreation({
        taskDir: "/tasks/task-abcdef12",
        mainCheckoutDir: "/src/invoice",
        repoDir: "invoice",
        remoteBranch: "main",
        commit: "beef001234",
        branch: "-m",
      }),
    ).toThrow("invalid-payload");
  });

  it("plans the resume branch op from the target ref's real state", () => {
    // An absent ref keeps the normal create op.
    expect(planResumeBranch({ observed: { state: "absent" }, recordedCommit: "beef001234" })).toEqual({
      ok: true,
      reuseExistingBranch: false,
    });
    // A ref already at the recorded baseline is reused (case-insensitive).
    expect(
      planResumeBranch({ observed: { state: "present", commit: "BEEF001234" }, recordedCommit: "beef001234" }),
    ).toEqual({ ok: true, reuseExistingBranch: true });
    // A ref at a different commit, or an uncontrollable probe, refuses.
    expect(
      planResumeBranch({ observed: { state: "present", commit: "deadbeef" }, recordedCommit: "beef001234" }),
    ).toEqual({ ok: false, reason: "任务分支已存在但工作树不在原位置，请人工恢复" });
    expect(planResumeBranch({ observed: { state: "unknown" }, recordedCommit: "beef001234" }).ok).toBe(false);
  });

  it("accepts absolute roots in the documented shapes", () => {
    expect(isAbsoluteTaskRoot("/Users/name/Tasks")).toBe(true);
    expect(isAbsoluteTaskRoot("~/PiDockTasks")).toBe(true);
    expect(isAbsoluteTaskRoot("D:\\Tasks")).toBe(true);
    expect(isAbsoluteTaskRoot("relative/tasks")).toBe(false);
    expect(isAbsoluteTaskRoot("")).toBe(false);
  });
});
