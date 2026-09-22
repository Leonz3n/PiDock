import { describe, expect, it } from "vitest";
import {
  buildLinkName,
  checkRepoConflicts,
  classifyLinkTarget,
  filterAppendRepos,
  pinRepoBaselines,
  planMultiRepoWorktrees,
  previewMixedTaskPaths,
  segmentPrepareOutcomes,
  snapshotPlainDirLink,
  validateRepoSelections,
} from "./multi-repo-provision.js";

// Seam: #6 multi-repo + plain-dir rules. Pure so the form, main and Host
// cannot drift apart. Time-boxed S1: rules only, no git execution.

describe("multi-repo selections", () => {
  it("accepts per-repo remote + baseline branches", () => {
    const result = validateRepoSelections([
      { repoDir: "frontend", remote: "origin", remoteBranch: "main", mainCheckoutDir: "/src/frontend" },
      { repoDir: "invoice", remote: "upstream", remoteBranch: "release/v2", mainCheckoutDir: "/src/invoice" },
    ]);
    expect(result.ok).toBe(true);
  });

  it("rejects duplicates, unsafe names, blank remotes and unusable checkouts", () => {
    expect(
      validateRepoSelections([
        { repoDir: "a", remote: "origin", remoteBranch: "main", mainCheckoutDir: "/src/a" },
        { repoDir: "a", remote: "origin", remoteBranch: "main", mainCheckoutDir: "/src/a" },
      ]),
    ).toMatchObject({ ok: false });
    const dup = validateRepoSelections([
      { repoDir: "a", remote: "origin", remoteBranch: "main", mainCheckoutDir: "/src/a" },
      { repoDir: "a", remote: "origin", remoteBranch: "main", mainCheckoutDir: "/src/a" },
    ]);
    if (!dup.ok) expect(dup.error.code).toBe("duplicate-repo");
    expect(
      validateRepoSelections([
        { repoDir: "../evil", remote: "origin", remoteBranch: "main", mainCheckoutDir: "/src/a" },
      ]),
    ).toMatchObject({ ok: false });
    expect(
      validateRepoSelections([{ repoDir: "a", remote: "", remoteBranch: "main", mainCheckoutDir: "/src/a" }]),
    ).toMatchObject({ ok: false });
    const unusable = validateRepoSelections([
      { repoDir: "a", remote: "origin", remoteBranch: "main", mainCheckoutDir: "relative/a" },
    ]);
    if (!unusable.ok) expect(unusable.error.code).toBe("repo-unusable");
  });
});

describe("fetch-then-pin gating", () => {
  const selections = [
    { repoDir: "frontend", remote: "origin", remoteBranch: "main", mainCheckoutDir: "/src/frontend" },
    { repoDir: "invoice", remote: "upstream", remoteBranch: "release/v2", mainCheckoutDir: "/src/invoice" },
  ];

  it("pins every repo and never cross-uses commits", () => {
    const result = pinRepoBaselines(selections, { frontend: "a5a4a0d1234", invoice: "beef001234" });
    expect(result).toMatchObject({
      ok: true,
      pinned: [
        { repoDir: "frontend", remote: "origin", commit: "a5a4a0d1234" },
        { repoDir: "invoice", remote: "upstream", commit: "beef001234" },
      ],
    });
  });

  it("fails the whole batch on one fetch failure (no partial plan)", () => {
    const missing = pinRepoBaselines(selections, { frontend: "a5a4a0d1234" });
    expect(missing).toMatchObject({ ok: false });
    if (!missing.ok) {
      expect(missing.error.code).toBe("fetch-failed");
      expect(missing.error.repoDir).toBe("invoice");
    }
    const stale = pinRepoBaselines(selections, { frontend: "a5a4a0d1234", invoice: "not-a-commit!!" });
    if (!stale.ok) expect(stale.error.code).toBe("fetch-failed");
  });

  it("plans one guarded triple per pinned repo", () => {
    const pinned = pinRepoBaselines(selections, { frontend: "a5a4a0d1234", invoice: "beef001234" });
    if (!pinned.ok) throw new Error("must pin");
    const plans = planMultiRepoWorktrees({
      taskDir: "/tasks/task-abcdef12",
      branch: "task/task-abcdef12",
      pinned: pinned.pinned,
      mainCheckouts: { frontend: "/src/frontend", invoice: "/src/invoice" },
    });
    expect(plans).toHaveLength(2);
    expect(plans[0].ops.map((op) => op.kind)).toEqual(["fetch", "branch", "worktree"]);
    expect(plans[0].ops[0].cwd).toBe("/src/frontend");
    expect(plans[1].ops[0].cwd).toBe("/src/invoice");
    expect(plans[0].ops[2].args).toContain("/tasks/task-abcdef12/frontend");
  });
});

describe("conflicts and append", () => {
  it("reports path-taken and branch-in-use without taking over", () => {
    expect(
      checkRepoConflicts({
        wantedWorktreeDirs: ["/tasks/t1/frontend"],
        takenPaths: ["/tasks/t1/frontend"],
        branchesInUse: [],
        wantedBranch: "task/task-abcdef12",
      }),
    ).toMatchObject({ ok: false });
    const taken = checkRepoConflicts({
      wantedWorktreeDirs: ["/tasks/t1/frontend"],
      takenPaths: ["/tasks/t1/frontend"],
      branchesInUse: [],
      wantedBranch: "task/task-abcdef12",
    });
    if (!taken.ok) expect(taken.error.code).toBe("path-taken");
    const inUse = checkRepoConflicts({
      wantedWorktreeDirs: ["/tasks/t1/frontend"],
      takenPaths: [],
      branchesInUse: ["task/task-abcdef12"],
      wantedBranch: "task/task-abcdef12",
    });
    if (!inUse.ok) expect(inUse.error.code).toBe("branch-in-use");
  });

  it("appends only new repos, keeping existing baselines", () => {
    expect(filterAppendRepos(["frontend"], ["frontend", "invoice"])).toEqual({
      appended: ["invoice"],
      skipped: ["frontend"],
    });
  });

  it("segments created vs pending vs failed for recovery", () => {
    expect(
      segmentPrepareOutcomes([
        { repoDir: "frontend", status: "created" },
        { repoDir: "invoice", status: "pending" },
        {
          repoDir: "shipment",
          status: "failed",
          error: { code: "fetch-failed", repoDir: "shipment", message: "no" },
        },
      ]),
    ).toMatchObject({ created: ["frontend"], pending: ["invoice"] });
  });
});

describe("plain-dir links", () => {
  it("uses stable ASCII link names and snapshots the source", () => {
    expect(buildLinkName("目录-01_abc")).toBe("dir-01abc");
    const snap = snapshotPlainDirLink({
      directoryId: "dir-1",
      sourcePath: "/data/notes",
      now: "2026-09-23T00:00:00+08:00",
    });
    expect(snap).toMatchObject({
      ok: true,
      snapshot: { linkName: "dir-dir1", directoryId: "dir-1", sourcePath: "/data/notes" },
    });
    expect(snapshotPlainDirLink({ directoryId: "dir-1", sourcePath: "relative/notes", now: "x" })).toMatchObject({
      ok: false,
    });
  });

  it("previews mixed worktree/link paths and classifies nested/loop targets", () => {
    const preview = previewMixedTaskPaths("/tasks/task-abcdef12", ["frontend"], ["dir-abc"]);
    expect(preview.worktrees["frontend"]).toBe("/tasks/task-abcdef12/frontend");
    expect(preview.links["dir-abc"]).toBe("/tasks/task-abcdef12/dir-abc");
    expect(classifyLinkTarget("/data/a", "/tasks/t1", ["/data/b"])).toBe("ok");
    expect(classifyLinkTarget("/data/shared/sub", "/tasks/t1", ["/data/shared"])).toBe("nested");
    expect(classifyLinkTarget("/tasks/t1/docs", "/tasks/t1", [])).toBe("loop-risk");
  });
});
