import { describe, expect, it } from "vitest";
import {
  buildTaskFormBranch,
  checkTaskFormDirIdConflict,
  isTaskDirId,
  pinTaskFormBaseline,
  previewTaskFormPaths,
  resolveTaskFormRoot,
  validateTaskFormName,
} from "../data/directories";

/**
 * [PiDock 02] renderer/shell provision-rule parity.
 *
 * The renderer form (`directories.ts`) mirrors the shell-side
 * `task-provision.ts` rules without importing it (importing the shell module
 * would hand the sandbox Node access). This locks the shared contract:
 * Chinese display names, auto `task-oooooooo` ids, separate editable branch,
 * absolute root + per-creation override + live preview, conflict handling,
 * and fetch-fail keeps the form with a retry entry.
 */
describe("renderer/shell provision-rule parity", () => {
  it("accepts a Chinese display name and trims it", () => {
    expect(validateTaskFormName("  发布前检查  ")).toEqual({ ok: true, name: "发布前检查" });
    expect(validateTaskFormName("   ").ok).toBe(false);
  });

  it("validates task-oooooooo directory ids", () => {
    expect(isTaskDirId("task-a1f92c3d")).toBe(true);
    expect(isTaskDirId("task-ABCDEF12")).toBe(false);
    expect(isTaskDirId("task-xyz")).toBe(false);
  });

  it("flags identifier conflicts against already-used ids", () => {
    expect(checkTaskFormDirIdConflict("task-a1f92c3d", ["task-a1f92c3d"])?.code).toBe("identifier-conflict");
    expect(checkTaskFormDirIdConflict("task-b77e10aa", ["task-a1f92c3d"])).toBeNull();
  });

  it("resolves the default root and a per-creation override without migrating", () => {
    const resolved = resolveTaskFormRoot("~/PiDockTasks", undefined);
    expect(resolved).toEqual({ ok: true, root: "~/PiDockTasks", overridden: false });
    const overridden = resolveTaskFormRoot("~/PiDockTasks", "/tmp/once");
    expect(overridden).toEqual({ ok: true, root: "/tmp/once", overridden: true });
    const bad = resolveTaskFormRoot("~/PiDockTasks", "relative/path");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("invalid-root");
  });

  it("previews real task/worktree/link paths", () => {
    const preview = previewTaskFormPaths("~/PiDockTasks", "task-a1f92c3d", ["front-monorepo"], ["dir-atlasdoc"]);
    expect(preview.taskDir).toBe("~/PiDockTasks/task-a1f92c3d");
    expect(preview.worktrees["front-monorepo"]).toBe("~/PiDockTasks/task-a1f92c3d/front-monorepo");
    expect(preview.links["dir-atlasdoc"]).toBe("~/PiDockTasks/task-a1f92c3d/dir-atlasdoc");
    expect(() => previewTaskFormPaths("~/PiDockTasks", "task-a1f92c3d", ["../evil"], [])).toThrow("invalid-path");
  });

  it("stores the editable branch separately from the name and dir id", () => {
    expect(buildTaskFormBranch("task-a1f92c3d")).toEqual({ ok: true, branch: "task/task-a1f92c3d" });
    expect(buildTaskFormBranch("task-a1f92c3d", "release/check").ok).toBe(true);
    const bad = buildTaskFormBranch("task-a1f92c3d", "bad branch");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("invalid-branch");
  });

  it("pins the fetched baseline and fails closed on fetch failure", () => {
    expect(pinTaskFormBaseline("origin/main", "9acb5b6")).toEqual({
      ok: true,
      remoteBranch: "origin/main",
      commit: "9acb5b6",
    });
    const failed = pinTaskFormBaseline("origin/main", "");
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe("fetch-failed");
  });
});
