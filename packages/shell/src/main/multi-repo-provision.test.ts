import { describe, expect, it } from "vitest";
import {
  buildLinkName,
  buildRepoChildName,
  checkLinkNameCollisions,
  checkRepoConflicts,
  classifyLinkTarget,
  classifyRepoPrepareState,
  filterAppendRepos,
  isMultiRepoErrorCode,
  LINK_MODEL_VERIFICATION_BOUNDARY,
  linkCapabilityRows,
  pinRepoBaselines,
  planMultiRepoWorktrees,
  previewMixedTaskPaths,
  resumeRepoSet,
  segmentPrepareOutcomes,
  snapshotPlainDirLink,
  validateRepoSelections,
} from "./multi-repo-provision.js";

// Seam: #6 multi-repo + plain-dir rules. Pure so the form, main and Host
// cannot drift apart. Time-boxed S1: rules only, no git execution.

describe("multi-repo selections", () => {
  it("spells an in-task repo folder as repo- plus the first 8 id hex characters", () => {
    expect(buildRepoChildName("11111111-2222-3333-4444-555555555555")).toBe("repo-11111111");
    expect(buildRepoChildName("abcdef12-3456-7890-abcd-ef1234567890")).toBe("repo-abcdef12");
  });

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
    // #6 P0: per-repo remotes ride the fetch op (never hardcoded origin).
    expect(plans[0].ops[0].args).toEqual(["fetch", "origin", "main"]);
    expect(plans[1].ops[0].args).toEqual(["fetch", "upstream", "release/v2"]);
  });

  it("rejects link-name collisions instead of silently sharing one link", () => {
    expect(checkLinkNameCollisions(["notes-1", "notes-2"])).toMatchObject({ ok: true });
    const collided = checkLinkNameCollisions(["notes-1", "notes--1"]);
    expect(collided).toMatchObject({ ok: false });
    if (!collided.ok) expect(collided.error.code).toBe("duplicate-repo");
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

  it("classifies created only from a verified worktree and keeps failed reasons", () => {
    // created: the real worktree was present AND matched the pinned commit.
    expect(
      classifyRepoPrepareState({ repoDir: "frontend", worktreePresent: true, worktreeMatchesPinnedCommit: true }),
    ).toEqual({ repoDir: "frontend", status: "created" });
    // A present path that is NOT this task's pinned worktree is failed, never
    // silently pending or created: the real reason is kept for the form.
    const mismatch = classifyRepoPrepareState({
      repoDir: "invoice",
      worktreePresent: true,
      worktreeMatchesPinnedCommit: false,
      mismatchReason: "工作副本未包含固定提交 abc",
    });
    expect(mismatch.status).toBe("failed");
    expect(mismatch.error?.message).toBe("工作副本未包含固定提交 abc");
    // An unverified present path (no probe answer) is also not `created`.
    expect(
      classifyRepoPrepareState({ repoDir: "x", worktreePresent: true, worktreeMatchesPinnedCommit: null }).status,
    ).toBe("failed");
    // Absent with a previously reported error: failed, reason kept.
    const reported = classifyRepoPrepareState({
      repoDir: "shipment",
      worktreePresent: false,
      previousError: { code: "fetch-failed", repoDir: "shipment", message: "远程不可用" },
    });
    expect(reported).toEqual({
      repoDir: "shipment",
      status: "failed",
      error: { code: "fetch-failed", repoDir: "shipment", message: "远程不可用" },
    });
    // Absent, never attempted: pending.
    expect(classifyRepoPrepareState({ repoDir: "later", worktreePresent: false })).toEqual({
      repoDir: "later",
      status: "pending",
    });
    // Absent but the record names no remote baseline for the repo: failed,
    // never a resumable `pending` (the resume would refuse to plan it).
    const orphan = classifyRepoPrepareState({
      repoDir: "orphan",
      worktreePresent: false,
      recordedBaselineMissing: true,
    });
    expect(orphan.status).toBe("failed");
    expect(orphan.error?.message).toContain("缺少记录的远程基线");
  });

  it("accepts only the known per-repo error codes across the record/RPC boundary", () => {
    for (const code of ["empty-selection", "duplicate-repo", "invalid-repo", "fetch-failed", "path-taken", "branch-in-use", "repo-unusable"]) {
      expect(isMultiRepoErrorCode(code), code).toBe(true);
    }
    for (const bad of ["", "not-a-real-code", "FETCH-FAILED", undefined, 1, null, {}]) {
      expect(isMultiRepoErrorCode(bad), String(bad)).toBe(false);
    }
  });

  it("resumes only absent unfinished repos and holds present unknown paths", () => {
    const outcomes = [
      { repoDir: "frontend", status: "created" as const },
      { repoDir: "invoice", status: "pending" as const },
      {
        repoDir: "shipment",
        status: "failed" as const,
        error: { code: "repo-unusable" as const, repoDir: "shipment", message: "占用" },
      },
    ];
    expect(resumeRepoSet(outcomes, new Set(["frontend", "shipment"]))).toEqual({
      retry: ["invoice"],
      hold: ["shipment"],
    });
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

// Seam: #6 box 12's platform half. The link capability is recorded PER
// PLATFORM and by NAME: a row may only read as exercised for the platform the
// probe really ran on, and win32 exists to name the gap, never to claim it.
describe("#6 link capability record (box 12 platforms)", () => {
  it("marks the platform a probe really ran on and leaves the other targets named-unverified", () => {
    const rows = linkCapabilityRows("darwin-arm64");
    expect(rows.map((row) => row.platform)).toEqual(["darwin-arm64", "win32-x64"]);
    expect(rows[0]).toMatchObject({ platform: "darwin-arm64", exercised: true });
    expect(rows[0]!.note).toContain("真的在本平台执行了链接目标探测");
    expect(rows[1]).toMatchObject({ platform: "win32-x64", exercised: false });
    expect(rows[1]!.note).toContain("win32 链接方式未验证");
    // No row claims Windows behaviour: the win32 row only names what is missing.
    expect(rows[1]!.note).not.toMatch(/Windows 上(创建|探测)过链接$/);
  });

  it("never marks any platform exercised without a real probe on it, and always keeps the win32 row", () => {
    for (const row of linkCapabilityRows(null)) expect(row.exercised).toBe(false);
    const linux = linkCapabilityRows("linux-x64");
    expect(linux.map((row) => row.platform)).toEqual(["darwin-arm64", "win32-x64", "linux-x64"]);
    expect(linux.filter((row) => row.exercised).map((row) => row.platform)).toEqual(["linux-x64"]);
    expect(linux.find((row) => row.platform === "darwin-arm64")!.note).toContain("本机未运行该平台");
    expect(linux.find((row) => row.platform === "win32-x64")!.note).toContain("win32 链接方式未验证");
    // The 真实 pi clause is a NAMED boundary, never a pass.
    expect(LINK_MODEL_VERIFICATION_BOUNDARY).toContain("不是真实 pi/模型运行");
    expect(LINK_MODEL_VERIFICATION_BOUNDARY).toContain("仍未完成");
  });
});
