/**
 * [Pencil T13] #148b the S02 create form's pre-creation preview.
 *
 * These cases pin the PLAN the create form renders, without spawning git: the
 * exact local branch per repository, the exact push target, and the NAMED
 * refusals for an unset/invalid convention or remote (never a `task/<id>` /
 * `origin` default). `creation-branch-preview-148b.test.ts` proves the same
 * plan against a real repository.
 */

import { describe, expect, it } from "vitest";
import { NO_GIT_DELIVERY, planCreationDelivery } from "./git-delivery.js";

const repoSettings = { branchTemplate: "ticket/{taskId}-{slug}", remote: "origin" };
const oneRepo = [{ repoId: "repo-web", name: "Web", repoPath: "/work/web", remoteUrl: "git@github.com:acme/web.git" }];
const twoRepos = [
  ...oneRepo,
  { repoId: "repo-api", name: "API", repoPath: "/work/api", remoteUrl: "git@github.com:acme/api.git" },
];

describe("creation preview: worktree mode", () => {
  it("shows the exact local branch and push target for one repository", () => {
    const plan = planCreationDelivery({ taskId: "task-1a2b3c4d", taskTitle: "Fix the Login Flow", workspaceMode: "worktree", settings: repoSettings, repos: oneRepo });
    expect(plan.gitDelivery).toBe("branch");
    expect(plan.ready).toBe(true);
    expect(plan.problem).toBeNull();
    expect(plan.slug).toBe("fix-the-login-flow");
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]).toMatchObject({
      repoId: "repo-web",
      localBranch: "ticket/task-1a2b3c4d-fix-the-login-flow",
      remote: "origin",
      pushTarget: "origin ticket/task-1a2b3c4d-fix-the-login-flow",
      problem: null,
    });
    expect(plan.message).toContain("ticket/task-1a2b3c4d-fix-the-login-flow");
    expect(plan.message).toContain("origin ticket/task-1a2b3c4d-fix-the-login-flow");
  });

  it("shows one ready row per repository for two repositories, each with its own push target", () => {
    const plan = planCreationDelivery({ taskId: "task-1a2b3c4d", taskTitle: "Two Repos", workspaceMode: "worktree", settings: repoSettings, repos: twoRepos });
    expect(plan.ready).toBe(true);
    expect(plan.rows.map((row) => [row.name, row.localBranch, row.pushTarget])).toEqual([
      ["Web", "ticket/task-1a2b3c4d-two-repos", "origin ticket/task-1a2b3c4d-two-repos"],
      ["API", "ticket/task-1a2b3c4d-two-repos", "origin ticket/task-1a2b3c4d-two-repos"],
    ]);
    expect(plan.rows.every((row) => row.problem === null)).toBe(true);
  });

  it("refuses an unset branch convention by name instead of guessing task/<id>", () => {
    const plan = planCreationDelivery({ taskId: "task-1a2b3c4d", taskTitle: "Unset", workspaceMode: "worktree", settings: { remote: "origin" }, repos: oneRepo });
    expect(plan.ready).toBe(false);
    expect(plan.problem?.code).toBe("branch-template-unset");
    expect(plan.problem?.message).toContain("分支规范");
    expect(plan.rows[0]?.problem?.code).toBe("branch-template-unset");
    expect(plan.rows[0]?.localBranch).toBe("");
    expect(plan.rows[0]?.pushTarget).toBe("");
    expect(plan.message).toContain("无法预览");
  });

  it("refuses an invalid branch convention by name", () => {
    const missingId = planCreationDelivery({ taskId: "task-1a2b3c4d", taskTitle: "Invalid", workspaceMode: "worktree", settings: { branchTemplate: "feature/{slug}", remote: "origin" }, repos: oneRepo });
    expect(missingId.ready).toBe(false);
    expect(missingId.problem?.code).toBe("branch-template-invalid");
    expect(missingId.problem?.message).toContain("{taskId}");

    const unknownToken = planCreationDelivery({ taskId: "task-1a2b3c4d", taskTitle: "Invalid", workspaceMode: "worktree", settings: { branchTemplate: "feature/{taskId}/{ticket}", remote: "origin" }, repos: oneRepo });
    expect(unknownToken.ready).toBe(false);
    expect(unknownToken.problem?.code).toBe("branch-template-invalid");
    expect(unknownToken.problem?.message).toContain("{ticket}");
  });

  it("refuses an unset push remote by name", () => {
    const plan = planCreationDelivery({ taskId: "task-1a2b3c4d", taskTitle: "No Remote", workspaceMode: "worktree", settings: { branchTemplate: "ticket/{taskId}" }, repos: oneRepo });
    expect(plan.ready).toBe(false);
    expect(plan.problem?.code).toBe("remote-unset");
    expect(plan.remote).toBe("");
    expect(plan.rows[0]?.pushTarget).toBe("");
    expect(plan.rows[0]?.problem?.code).toBe("remote-unset");
  });

  it("refuses an invalid remote name by name and never previews a half target", () => {
    const plan = planCreationDelivery({ taskId: "task-1a2b3c4d", taskTitle: "Bad Remote", workspaceMode: "worktree", settings: { branchTemplate: "ticket/{taskId}", remote: "ori gin" }, repos: oneRepo });
    expect(plan.ready).toBe(false);
    expect(plan.problem?.code).toBe("remote-invalid");
    expect(plan.rows[0]).toMatchObject({ localBranch: "", remote: "", pushTarget: "" });
  });

  it("refuses when the checkout does not really have that remote (named per repository)", () => {
    const plan = planCreationDelivery({
      taskId: "task-1a2b3c4d", taskTitle: "Missing Remote", workspaceMode: "worktree",
      settings: repoSettings,
      repos: [{ repoId: "repo-web", name: "Web", repoPath: "/work/web", remoteUrl: null }],
    });
    expect(plan.ready).toBe(false);
    expect(plan.problem).toBeNull();
    expect(plan.rows[0]?.problem?.code).toBe("remote-invalid");
    expect(plan.rows[0]?.problem?.message).toContain("origin");
    expect(plan.rows[0]?.localBranch).toBe("");
    expect(plan.rows[0]?.pushTarget).toBe("");
  });

  it("refuses an empty repository selection instead of a ready plan", () => {
    const plan = planCreationDelivery({ taskId: "task-1a2b3c4d", taskTitle: "Nothing", workspaceMode: "worktree", settings: repoSettings, repos: [] });
    expect(plan.ready).toBe(false);
    expect(plan.problem?.code).toBe("repo-unavailable");
    expect(plan.rows).toEqual([]);
  });
});

describe("creation preview: modes without a task branch", () => {
  it("plain-dirs shows 无 Git 交付 and no branch row at all", () => {
    const plan = planCreationDelivery({ taskId: "task-1a2b3c4d", taskTitle: "Plain", workspaceMode: "plain-dirs", settings: repoSettings, repos: [] });
    expect(plan.gitDelivery).toBe("none");
    expect(plan.ready).toBe(true);
    expect(plan.problem).toBeNull();
    expect(plan.rows).toEqual([]);
    expect(plan.message).toContain(NO_GIT_DELIVERY);
    expect(plan.message).not.toContain("ticket/");
  });

  it("plain-dirs refuses repositories it would silently ignore", () => {
    const plan = planCreationDelivery({ taskId: "task-1a2b3c4d", taskTitle: "Plain", workspaceMode: "plain-dirs", settings: repoSettings, repos: oneRepo });
    expect(plan.gitDelivery).toBe("none");
    expect(plan.ready).toBe(false);
    expect(plan.problem?.code).toBe("repo-unavailable");
    expect(plan.rows).toEqual([]);
  });

  it("plain-dirs stays ready even with the convention and remote unset (no Git delivery to configure)", () => {
    const plan = planCreationDelivery({ taskId: "task-1a2b3c4d", taskTitle: "Plain", workspaceMode: "plain-dirs", settings: {}, repos: [] });
    expect(plan.ready).toBe(true);
    expect(plan.gitDelivery).toBe("none");
  });

  it("existing-git previews the checkout's own branch and creates no task branch", () => {
    const plan = planCreationDelivery({
      taskId: "task-1a2b3c4d", taskTitle: "Existing", workspaceMode: "existing-git", settings: repoSettings,
      repos: [{ repoId: "repo-web", name: "Web", repoPath: "/work/web", currentBranch: "release/1.x" }],
    });
    expect(plan.gitDelivery).toBe("existing");
    expect(plan.ready).toBe(true);
    expect(plan.rows[0]).toMatchObject({ localBranch: "release/1.x", pushTarget: "", problem: null });
    expect(plan.message).toContain("不创建任务分支");
    // The convention is irrelevant here: it is not what names anything.
    expect(plan.rows[0]?.localBranch).not.toContain("task-");
  });

  it("existing-git refuses a detached checkout by name", () => {
    const plan = planCreationDelivery({
      taskId: "task-1a2b3c4d", taskTitle: "Detached", workspaceMode: "existing-git", settings: repoSettings,
      repos: [{ repoId: "repo-web", name: "Web", repoPath: "/work/web", currentBranch: "" }],
    });
    expect(plan.ready).toBe(false);
    expect(plan.rows[0]?.problem?.code).toBe("branch-name-unsafe");
    expect(plan.rows[0]?.localBranch).toBe("");
  });
});
