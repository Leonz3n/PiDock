import { describe, expect, it } from "vitest";
import {
  assertProvisionPlanSafe,
  buildTaskBranch,
  checkDirIdConflict,
  generateTaskDirId,
  isAbsoluteTaskRoot,
  isTaskDirId,
  pinBaseline,
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

  it("accepts absolute roots in the documented shapes", () => {
    expect(isAbsoluteTaskRoot("/Users/name/Tasks")).toBe(true);
    expect(isAbsoluteTaskRoot("~/PiDockTasks")).toBe(true);
    expect(isAbsoluteTaskRoot("D:\\Tasks")).toBe(true);
    expect(isAbsoluteTaskRoot("relative/tasks")).toBe(false);
    expect(isAbsoluteTaskRoot("")).toBe(false);
  });
});
