/**
 * Tests for the [PiDock 14] (#17) repository identity probe. Pure shape logic
 * is tested directly; the observation path is driven with an injected probe, so
 * no repository, no `git` binary and no filesystem are needed.
 */
import { describe, expect, it } from "vitest";
import {
  baseCommitReachable,
  observeRecordedRepo,
  observeRepoIdentity,
  parseGitDirMarker,
  parseRefHead,
  type RepoProbe,
} from "./repo-identity.js";

const TASK_DIR = "/Users/dev/pidock/tasks/task-aaaaaaaa";
const WORKTREE = `${TASK_DIR}/invoice-service`;

function probe(input: { files?: Record<string, string>; filePaths?: readonly string[]; git?: Record<string, string> }): RepoProbe {
  return {
    readFile: (path) => input.files?.[path] ?? null,
    isFile: (path) => (input.filePaths ?? Object.keys(input.files ?? {})).includes(path),
    runGit: (args) => input.git?.[args.join(" ")] ?? null,
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
