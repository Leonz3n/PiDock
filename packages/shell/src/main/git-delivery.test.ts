/**
 * [Pencil T13] #148 real-git tests for the delivery rules.
 *
 * The push cases use a REAL local bare remote (no mocks): success, no-change,
 * remote rejection (non-fast-forward), and partial failure across two
 * repositories. The auth case pins the classification sentence plus the
 * bounded/redacted summary; force-push and destructive commands are asserted
 * absent at the argv level.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSafeGitArguments,
  classifyGitFailure,
  commitRepos,
  exportRepoPatch,
  PATCH_EXPORT_BOUNDARY,
  parseRemoteUrl,
  planDelivery,
  previewBranchName,
  pullRequestGuidance,
  pushRepos,
  readChangeSet,
  slugifyTaskTitle,
  summarizeGitError,
  validateBranchTemplate,
  validateRemoteName,
  withDeliveryLock,
  runGit,
  type GitRunner,
} from "./git-delivery.js";
import { WorktreeMetadataLock } from "./worktree-metadata-lock.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args], { cwd, encoding: "utf8" });
}

/** Production argv, plus the identity flags a test machine may not have. */
const run: GitRunner = (args, cwd) => runGit(["-c", "user.email=t@example.com", "-c", "user.name=T", ...args], cwd);

function initRepo(path: string, file = "a.txt", content = "a"): void {
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-q", "-b", "main"]);
  writeFileSync(join(path, file), content);
  git(path, ["add", "."]);
  git(path, ["commit", "-q", "-m", "init"]);
}

function initBare(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-q", "--bare"]);
}

function clone(bare: string, path: string): void {
  execFileSync("git", ["clone", "-q", bare, path], { encoding: "utf8" });
  git(path, ["config", "user.email", "t@example.com"]);
  git(path, ["config", "user.name", "T"]);
}

describe("branch convention preview", () => {
  it("expands {taskId} and a bounded slug of the title", () => {
    expect(slugifyTaskTitle("Pencil T13 分支规范、推送目标与明确 Git 交付")).toBe("pencil-t13-git");
    expect(previewBranchName("ticket/{taskId}-{slug}", { taskId: "148", title: "Git 交付" })).toEqual({
      ok: true,
      value: "ticket/148-git",
    });
    expect(previewBranchName("feature/{taskId}", { taskId: "148", title: "x" })).toEqual({ ok: true, value: "feature/148" });
  });

  it("refuses an unset template instead of inventing one", () => {
    const plan = planDelivery({
      taskId: "148",
      taskTitle: "Git",
      settings: { branchTemplate: undefined, remote: "origin" },
      repos: [{ repoId: "r1", repoPath: "/tmp/r1" }],
    });
    expect(plan.ready).toBe(false);
    expect(plan.problem?.code).toBe("branch-template-unset");
    expect(plan.rows[0]?.problem?.code).toBe("branch-template-unset");
    expect(plan.rows[0]?.branch).toBe("");
    expect(plan.rows[0]?.pushTarget).toBe("");
  });

  it("names an invalid template and an invalid remote", () => {
    expect(validateBranchTemplate("ticket/{slug}")).toMatchObject({ ok: false, code: "branch-template-invalid" });
    expect(validateBranchTemplate("ticket/{taskId}/{owner}")).toMatchObject({ ok: false, code: "branch-template-invalid" });
    expect(validateBranchTemplate("ticket/{taskId}..x")).toMatchObject({ ok: false, code: "branch-template-invalid" });
    expect(validateBranchTemplate(" ticket/{taskId}")).toMatchObject({ ok: false, code: "branch-template-invalid" });
    expect(validateRemoteName("-origin")).toMatchObject({ ok: false, code: "remote-invalid" });
    expect(validateRemoteName("or igin")).toMatchObject({ ok: false, code: "remote-invalid" });
    expect(validateRemoteName("")).toMatchObject({ ok: false, code: "remote-unset" });

    const plan = planDelivery({
      taskId: "148",
      taskTitle: "Git",
      settings: { branchTemplate: "ticket/{taskId}", remote: "bad remote" },
      repos: [{ repoId: "r1", repoPath: "/tmp/r1" }, { repoId: "r2", repoPath: "/tmp/r2" }],
    });
    expect(plan.problem?.code).toBe("remote-invalid");
    expect(plan.rows.every((row) => row.problem?.code === "remote-invalid")).toBe(true);
    expect(plan.rows.every((row) => row.pushTarget === "")).toBe(true);
  });

  it("previews the exact per-repo branch and push target before creation", () => {
    const plan = planDelivery({
      taskId: "148",
      taskTitle: "Git 交付",
      settings: { branchTemplate: "ticket/{taskId}-{slug}", remote: "upstream" },
      repos: [
        { repoId: "r1", name: "frontend", repoPath: "/tmp/r1" },
        { repoId: "r2", repoPath: "/tmp/r2", currentBranch: "ticket/148-hotfix" },
      ],
    });
    expect(plan.ready).toBe(true);
    expect(plan.slug).toBe("git");
    expect(plan.rows[0]).toMatchObject({ branch: "ticket/148-git", remote: "upstream", pushTarget: "upstream ticket/148-git" });
    // An existing checkout branch is the honest branch, not the template guess.
    expect(plan.rows[1]).toMatchObject({ branch: "ticket/148-hotfix", pushTarget: "upstream ticket/148-hotfix" });
  });
});

describe("explicit commit", () => {
  it("commits only the real change set and refuses when nothing changed", () => {
    const root = tempDir("pidock-git-commit-");
    initRepo(join(root, "repo"));
    const repoPath = join(root, "repo");
    const empty = commitRepos({ run, message: "noop", repos: [{ repoId: "r1", repoPath, branch: "main", remote: "origin" }] });
    expect(empty.outcomes[0]).toMatchObject({ status: "no-changes", files: [] });
    expect(git(repoPath, ["rev-list", "--count", "HEAD"]).trim()).toBe("1");

    writeFileSync(join(repoPath, "a.txt"), "changed");
    const committed = commitRepos({ run, message: "feat: 1 (ref #148)", repos: [{ repoId: "r1", repoPath, branch: "main", remote: "origin" }] });
    expect(committed.outcomes[0]?.status).toBe("success");
    expect(committed.outcomes[0]?.files).toEqual(["a.txt"]);
    expect(committed.outcomes[0]?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(git(repoPath, ["log", "-1", "--pretty=%s"]).trim()).toBe("feat: 1 (ref #148)");
  });

  it("keeps the working tree when the commit fails", () => {
    const root = tempDir("pidock-git-fail-");
    const repoPath = join(root, "repo");
    initRepo(repoPath);
    writeFileSync(join(repoPath, "hook.sh"), "#!/bin/sh\nexit 1\n");
    writeFileSync(join(repoPath, ".git/hooks/pre-commit"), "#!/bin/sh\necho 'hook says no' >&2\nexit 1\n");
    execFileSync("chmod", ["+x", join(repoPath, ".git/hooks/pre-commit")]);
    writeFileSync(join(repoPath, "a.txt"), "uncommitted work");
    const result = commitRepos({ run, message: "will fail", repos: [{ repoId: "r1", repoPath, branch: "main", remote: "origin" }] });
    expect(result.outcomes[0]?.status).toBe("failed");
    expect(result.outcomes[0]?.summary).toContain("hook says no");
    // Nothing was discarded: the tracked edit is still there.
    expect(readFileSync(join(repoPath, "a.txt"), "utf8")).toBe("uncommitted work");
    expect(readChangeSet(run, repoPath)).toMatchObject({ ok: true, files: ["a.txt", "hook.sh"] });
  });

  it("refuses to commit on a branch the checkout is not on", () => {
    const repoPath = join(tempDir("pidock-git-mismatch-"), "repo");
    initRepo(repoPath);
    writeFileSync(join(repoPath, "a.txt"), "x");
    const result = commitRepos({ run, message: "m", repos: [{ repoId: "r1", repoPath, branch: "ticket/148", remote: "origin" }] });
    expect(result.outcomes[0]?.status).toBe("failed");
    expect(result.outcomes[0]?.summary).toContain("branch-mismatch");
    expect(git(repoPath, ["status", "--porcelain"]).trim()).toBe("M a.txt");
  });
});

describe("push against a real local bare remote", () => {
  it("pushes the target branch and reports success per repo", () => {
    const root = tempDir("pidock-git-push-");
    const bare = join(root, "remote.git");
    initBare(bare);
    const repoPath = join(root, "work");
    clone(bare, repoPath);
    writeFileSync(join(repoPath, "a.txt"), "one");
    git(repoPath, ["add", "."]);
    git(repoPath, ["commit", "-q", "-m", "one"]);
    const result = pushRepos({ run, repos: [{ repoId: "r1", repoPath, branch: "main", remote: "origin" }] });
    expect(result.outcomes[0]).toMatchObject({ status: "success", pushedTo: "origin/main" });
    expect(result.partial).toBe(false);
    expect(git(bare, ["rev-parse", "main"]).trim()).toBe(git(repoPath, ["rev-parse", "HEAD"]).trim());
  });

  it("reports no-change when the remote already has the commit", () => {
    const root = tempDir("pidock-git-nochange-");
    const bare = join(root, "remote.git");
    initBare(bare);
    const repoPath = join(root, "work");
    clone(bare, repoPath);
    writeFileSync(join(repoPath, "a.txt"), "one");
    git(repoPath, ["add", "."]);
    git(repoPath, ["commit", "-q", "-m", "one"]);
    git(repoPath, ["push", "-q", "origin", "main"]);
    const result = pushRepos({ run, repos: [{ repoId: "r1", repoPath, branch: "main", remote: "origin" }] });
    expect(result.outcomes[0]?.status).toBe("no-changes");
  });

  it("names a real remote rejection (non-fast-forward), never forcing", () => {
    const root = tempDir("pidock-git-reject-");
    const bare = join(root, "remote.git");
    initBare(bare);
    const a = join(root, "a");
    clone(bare, a);
    writeFileSync(join(a, "a.txt"), "a");
    git(a, ["add", "."]);
    git(a, ["commit", "-q", "-m", "a"]);
    git(a, ["push", "-q", "origin", "main"]);
    const b = join(root, "b");
    clone(bare, b);
    writeFileSync(join(b, "b.txt"), "b");
    git(b, ["add", "."]);
    git(b, ["commit", "-q", "-m", "b"]);
    git(b, ["push", "-q", "origin", "main"]);
    // `a` now diverges from the bare remote: its next push is rejected.
    writeFileSync(join(a, "a.txt"), "a2");
    git(a, ["add", "."]);
    git(a, ["commit", "-q", "-m", "a2"]);
    const result = pushRepos({ run, repos: [{ repoId: "r1", repoPath: a, branch: "main", remote: "origin" }] });
    expect(result.outcomes[0]?.status).toBe("remote-reject");
    expect(git(bare, ["rev-parse", "main"]).trim()).toBe(git(b, ["rev-parse", "HEAD"]).trim());
  });

  it("records a partial multi-repo failure per repository", () => {
    const root = tempDir("pidock-git-partial-");
    const bare = join(root, "remote.git");
    initBare(bare);
    const good = join(root, "good");
    clone(bare, good);
    writeFileSync(join(good, "g.txt"), "g");
    git(good, ["add", "."]);
    git(good, ["commit", "-q", "-m", "g"]);
    const other = join(root, "other");
    initRepo(other);
    // `other` has no `origin`: a real failure while `good` succeeds.
    const result = pushRepos({
      run,
      repos: [
        { repoId: "r1", repoPath: good, branch: "main", remote: "origin" },
        { repoId: "r2", repoPath: other, branch: "main", remote: "origin" },
      ],
    });
    expect(result.outcomes.map((row) => row.status)).toEqual(["success", "failed"]);
    expect(result.partial).toBe(true);
    expect(result.overall).toBe("partial-failure");
  });

  it("classifies auth failure and keeps the summary bounded and secret-free", () => {
    const authRunner: GitRunner = (args, cwd) => {
      if (args[0] === "rev-list") return { code: 128, stdout: "", stderr: "fatal: ambiguous argument" };
      if (args[0] === "push") {
        return {
          code: 128,
          stdout: "",
          stderr: "fatal: Authentication failed for 'https://bob:sup3rsecret@github.com/acme/repo.git/'\nmore\n",
        };
      }
      return run(args, cwd);
    };
    const result = pushRepos({ run: authRunner, repos: [{ repoId: "r1", repoPath: "/tmp/nowhere", branch: "main", remote: "origin" }] });
    expect(result.outcomes[0]?.status).toBe("auth-failure");
    expect(result.outcomes[0]?.summary).toContain("Authentication failed");
    expect(result.outcomes[0]?.summary).not.toContain("sup3rsecret");
    expect(classifyGitFailure("Permission denied (publickey).")).toBe("auth-failure");
    expect(classifyGitFailure("! [rejected] main -> main (non-fast-forward)")).toBe("remote-reject");
  });

  it("never builds a force flag", () => {
    expect(() => assertSafeGitArguments(["push", "--force", "origin", "main:main"])).toThrow(/git-argument-forbidden/);
    expect(() => assertSafeGitArguments(["push", "-f", "origin", "main:main"])).toThrow(/git-argument-forbidden/);
    for (const command of [
      ["reset", "--hard"],
      ["clean", "-fd"],
    ]) {
      expect(() => assertSafeGitArguments(command)).not.toThrow();
    }
    const seen: string[][] = [];
    const spy: GitRunner = (args, cwd) => {
      seen.push([...args]);
      return run(args, cwd);
    };
    const root = tempDir("pidock-git-argv-");
    const bare = join(root, "remote.git");
    initBare(bare);
    const repoPath = join(root, "work");
    clone(bare, repoPath);
    pushRepos({ run: spy, repos: [{ repoId: "r1", repoPath, branch: "main", remote: "origin" }] });
    const argv = seen.flat();
    expect(argv.some((arg) => arg.startsWith("--force") || arg === "-f")).toBe(false);
    expect(argv.includes("push")).toBe(true);
  });
});

describe("cross-task lock (#141) on managed writes", () => {
  it("refuses a write while another owner holds the real repo path", () => {
    const root = tempDir("pidock-git-lock-");
    const repoPath = join(root, "repo");
    initRepo(repoPath);
    const userData = join(root, "userData");
    const holder = new WorktreeMetadataLock(userData);
    const held = holder.acquireFor([repoPath], { taskId: "other-task", label: "追加仓库" });
    expect(held.ok).toBe(true);
    writeFileSync(join(repoPath, "a.txt"), "changed");
    const result = commitRepos({
      run,
      message: "blocked",
      repos: [{ repoId: "r1", repoPath, branch: "main", remote: "origin" }],
      lock: { userData, taskId: "148", label: "任务交付提交" },
    });
    expect(result.outcomes[0]?.status).toBe("locked");
    expect(result.outcomes[0]?.summary).toMatch(/worktree-locked/);
    // The refused write changed nothing.
    expect(git(repoPath, ["rev-list", "--count", "HEAD"]).trim()).toBe("1");
    expect(readChangeSet(run, repoPath)).toMatchObject({ ok: true, files: ["a.txt"] });
    if (held.ok) held.release();
    const after = withDeliveryLock({ userData, taskId: "148", label: "任务交付提交" }, [repoPath], () => "ran");
    expect(after).toEqual({ ok: true, value: "ran" });
  });
});

describe("PR guidance per actual push target", () => {
  it("parses ssh and https remotes", () => {
    expect(parseRemoteUrl("git@github.com:acme/repo.git")).toMatchObject({ host: "github.com", path: "acme/repo" });
    expect(parseRemoteUrl("https://gitlab.com/acme/svc.git")).toMatchObject({ host: "gitlab.com", path: "acme/svc" });
  });

  it("builds host-specific compare links and never claims a PR exists", () => {
    const github = pullRequestGuidance({ remoteUrl: "git@github.com:acme/repo.git", branch: "ticket/148-git", baseBranch: "main" });
    expect(github.url).toBe("https://github.com/acme/repo/compare/main...ticket%2F148-git?expand=1");
    const gitlab = pullRequestGuidance({ remoteUrl: "https://gitlab.com/acme/svc.git", branch: "ticket/148-git" });
    expect(gitlab.url).toBe("https://gitlab.com/acme/svc/-/compare/main...ticket%2F148-git");
    const bitbucket = pullRequestGuidance({ remoteUrl: "https://bitbucket.org/acme/repo.git", branch: "b1" });
    expect(bitbucket.url).toBe("https://bitbucket.org/acme/repo/branches/compare/b1%0Dmain");
    for (const guidance of [github, gitlab, bitbucket]) {
      expect(guidance.text).toContain("打开创建 PR");
      expect(guidance.text).not.toContain("已创建");
    }
    const unknown = pullRequestGuidance({ remoteUrl: "ssh://git@git.example.internal/acme/repo.git", branch: "b1" });
    expect(unknown.supported).toBe(false);
    expect(unknown.url).toBeNull();
    expect(unknown.text).toContain("手动打开创建 PR");
    expect(unknown.text).not.toContain("已创建");
  });
});

describe("patch export boundary", () => {
  it("exports tracked diff only and names the boundary", () => {
    const repoPath = join(tempDir("pidock-git-patch-"), "repo");
    initRepo(repoPath);
    writeFileSync(join(repoPath, "a.txt"), "tracked change");
    writeFileSync(join(repoPath, "untracked.txt"), "untracked");
    const exported = exportRepoPatch(run, { repoId: "r1", repoPath });
    expect(exported.error).toBeNull();
    expect(exported.files).toEqual(["a.txt"]);
    expect(exported.patch).toContain("tracked change");
    expect(exported.patch).not.toContain("untracked.txt");
    expect(exported.boundary).toBe(PATCH_EXPORT_BOUNDARY);
    expect(exported.boundary).toContain("不代表已提交");
  });

  it("redacts credentials out of git's own error text", () => {
    const summary = summarizeGitError(
      "fatal: unable to access 'https://user:tok3n@github.com/acme/repo.git/': The requested URL returned error: 403\n",
    );
    expect(summary).not.toContain("tok3n");
    expect(summary).toContain("403");
    expect(summary.length).toBeLessThanOrEqual(301);
  });
});
