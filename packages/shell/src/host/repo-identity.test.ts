/**
 * Tests for the [PiDock 14] (#17) repository identity probe. Pure shape logic
 * is tested directly; the observation path is driven with an injected probe, so
 * no repository, no `git` binary and no filesystem are needed. The real
 * `createNodeRepoProbe` wrapper is covered separately against a real temp
 * repository (its `--is-ancestor` exit status is the answer, not stdout).
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  baseCommitReachable,
  createNodeRepoProbe,
  observeBranchRef,
  observeRecordedRepo,
  observeRepoIdentity,
  parseGitDirMarker,
  parseRefHead,
  type RepoProbe,
} from "./repo-identity.js";

const TASK_DIR = "/Users/dev/pidock/tasks/task-aaaaaaaa";
const WORKTREE = `${TASK_DIR}/invoice-service`;

function probe(input: {
  files?: Record<string, string>;
  filePaths?: readonly string[];
  git?: Record<string, string>;
  branchRefs?: Record<string, { state: "present"; commit: string } | { state: "absent" } | { state: "unknown" }>;
}): RepoProbe {
  return {
    readFile: (path) => input.files?.[path] ?? null,
    isFile: (path) => (input.filePaths ?? Object.keys(input.files ?? {})).includes(path),
    runGit: (args) => input.git?.[args.join(" ")] ?? null,
    probeBranchRef: (dir, branch) => input.branchRefs?.[`${dir} ${branch}`] ?? { state: "unknown" },
  };
}

describe("parseGitDirMarker / parseRefHead", () => {
  it("reads the gitdir marker and a branch ref HEAD", () => {
    expect(parseGitDirMarker("gitdir: /Users/dev/work/apiserver/.git/worktrees/invoice-service\n")).toBe(
      "/Users/dev/work/apiserver/.git/worktrees/invoice-service",
    );
    expect(parseRefHead("ref: refs/heads/task-aaaaaaaa\n")).toBe("task-aaaaaaaa");
    expect(parseRefHead("deadbeef\n")).toBeNull();
    expect(parseGitDirMarker("not a marker")).toBeNull();
  });
});

describe("observeRepoIdentity", () => {
  it("accepts a linked worktree on the recorded branch", () => {
    const observed = observeRepoIdentity(
      WORKTREE,
      probe({
        files: { [`${WORKTREE}/.git`]: "gitdir: /Users/dev/work/apiserver/.git/worktrees/invoice-service\n" },
        git: {
          [`-C ${WORKTREE} rev-parse HEAD`]: "deadbeef",
          [`-C ${WORKTREE} rev-parse --abbrev-ref HEAD`]: "task-aaaaaaaa",
        },
      }),
    );
    expect(observed).toMatchObject({ repoDir: WORKTREE, head: "deadbeef", branch: "task-aaaaaaaa", isWorktree: true });
  });

  it("reports the original checkout (a `.git` directory) as not-a-worktree with no base reachability", () => {
    const observed = observeRepoIdentity(
      "/Users/dev/work/apiserver",
      probe({
        files: {},
        filePaths: [],
        git: {
          ["-C /Users/dev/work/apiserver rev-parse HEAD"]: "deadbeef",
          ["-C /Users/dev/work/apiserver rev-parse --abbrev-ref HEAD"]: "main",
        },
      }),
    );
    expect(observed).toMatchObject({ isWorktree: false, branch: "main", baseCommitReachable: null });
  });

  it("returns undefined for a missing folder, an unreadable marker and a detached HEAD", () => {
    expect(observeRepoIdentity(WORKTREE, probe({ filePaths: [], files: {} }))).toBeUndefined();
    expect(observeRepoIdentity(WORKTREE, probe({ files: { [`${WORKTREE}/.git`]: "junk" } }))).toBeUndefined();
    const detached = observeRepoIdentity(
      WORKTREE,
      probe({
        files: { [`${WORKTREE}/.git`]: "gitdir: /tmp/gitdir\n" },
        git: { [`-C ${WORKTREE} rev-parse HEAD`]: "deadbeef", [`-C ${WORKTREE} rev-parse --abbrev-ref HEAD`]: "HEAD" },
      }),
    );
    expect(detached).toMatchObject({ branch: null, isWorktree: true });
  });
});

describe("baseCommitReachable", () => {
  it("maps exit 0/1 to true/false and anything else to unknown", () => {
    const repo = WORKTREE;
    const args = `-C ${repo} merge-base --is-ancestor 9acb5b6f HEAD`;
    expect(baseCommitReachable(repo, "9acb5b6f", probe({ git: { [args]: "0" } }))).toBe(true);
    expect(baseCommitReachable(repo, "9acb5b6f", probe({ git: { [args]: "1" } }))).toBe(false);
    expect(baseCommitReachable(repo, "9acb5b6f", probe({ git: {} }))).toBeNull();
    expect(baseCommitReachable(repo, "  ", probe({ git: { [args]: "0" } }))).toBeNull();
  });

  it("combines both probes in observeRecordedRepo so a rewritten history fails closed", () => {
    const args = `-C ${WORKTREE} merge-base --is-ancestor 9acb5b6f HEAD`;
    const observed = observeRecordedRepo(
      { repoDir: WORKTREE, baseCommit: "9acb5b6f" },
      probe({
        files: { [`${WORKTREE}/.git`]: "gitdir: /tmp/gitdir\n" },
        git: {
          [`-C ${WORKTREE} rev-parse HEAD`]: "deadbeef",
          [`-C ${WORKTREE} rev-parse --abbrev-ref HEAD`]: "task-aaaaaaaa",
          [args]: "1",
        },
      }),
    );
    expect(observed).toMatchObject({ baseCommitReachable: false });
  });
});

describe("createNodeRepoProbe against a real repository", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  it("reads the silent merge-base --is-ancestor exit status as true/false, never unknown", () => {
    const home = mkdtempSync(join(tmpdir(), "pidock-probe-"));
    homes.push(home);
    const repo = join(home, "repo");
    mkdirSync(repo);
    const git = (...args: string[]): string =>
      execFileSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
      }).trim();
    git("init", "-b", "main");
    git("config", "user.email", "test@localhost");
    git("config", "user.name", "Test");
    writeFileSync(join(repo, "base.txt"), "base\n");
    git("add", "base.txt");
    git("commit", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("checkout", "-b", "other");
    writeFileSync(join(repo, "other.txt"), "other\n");
    git("add", "other.txt");
    git("commit", "-m", "other");
    const other = git("rev-parse", "HEAD");
    git("checkout", "main");

    const realProbe = createNodeRepoProbe();
    // `--is-ancestor` prints nothing: exit 0 must not collapse to "unknown".
    expect(realProbe.runGit(["-C", repo, "merge-base", "--is-ancestor", base, "HEAD"])).toBe("0");
    expect(realProbe.runGit(["-C", repo, "merge-base", "--is-ancestor", other, "HEAD"])).toBe("1");
    // A real git failure (unknown object) stays unknown, never a "no".
    expect(realProbe.runGit(["-C", repo, "merge-base", "--is-ancestor", "0".repeat(40), "HEAD"])).toBeNull();

    expect(baseCommitReachable(repo, base, realProbe)).toBe(true);
    expect(baseCommitReachable(repo, other, realProbe)).toBe(false);
    expect(baseCommitReachable(repo, "0".repeat(40), realProbe)).toBeNull();
  });

  it("reads a present branch ref, a missing one and an unreadable repo as present/absent/unknown", () => {
    const home = mkdtempSync(join(tmpdir(), "pidock-probe-ref-"));
    homes.push(home);
    const repo = join(home, "repo");
    mkdirSync(repo);
    const notARepo = join(home, "not-a-repo");
    mkdirSync(notARepo);
    const git = (...args: string[]): string =>
      execFileSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
      }).trim();
    git("init", "-b", "main");
    git("config", "user.email", "test@localhost");
    git("config", "user.name", "Test");
    writeFileSync(join(repo, "base.txt"), "base\n");
    git("add", "base.txt");
    git("commit", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("branch", "task-abcdef12", base);

    const realProbe = createNodeRepoProbe();
    expect(observeBranchRef(repo, "task-abcdef12", realProbe)).toEqual({ state: "present", commit: base });
    expect(observeBranchRef(repo, "task-missing", realProbe)).toEqual({ state: "absent" });
    // No repository (or no git): unknown, never a false "absent" that plans a create.
    expect(observeBranchRef(notARepo, "task-abcdef12", realProbe)).toEqual({ state: "unknown" });
    expect(observeBranchRef(repo, "", realProbe)).toEqual({ state: "unknown" });
  });
});
