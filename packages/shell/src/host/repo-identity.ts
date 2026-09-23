/**
 * Repository identity probe for [PiDock 14] (#17) box 5.
 *
 * After an abnormal exit the Host must verify the task's recorded Git resource
 * before claiming or stopping anything: the recorded folder has to still be
 * *this task's linked worktree*, on the recorded task branch, with the pinned
 * base commit still reachable. The original checkout (a plain `.git`
 * directory) and a folder that replaced the worktree therefore fail closed.
 *
 * All fs/git access goes through the injected `RepoProbe`, so the pure shape
 * logic (`parseGitDirMarker`, `parseRefHead`) is unit-testable without a
 * repository, and the real probe is a thin fixed-argv wrapper (`execFileSync`
 * with no shell).
 */

import type { GitResourceObservation } from "../main/task-lifecycle.js";

export interface RepoProbe {
  /** `readFileSync` of a text file, or null when unreadable. */
  readFile(path: string): string | null;
  /** `lstat`: whether the path is a regular file (the linked-worktree marker). */
  isFile(path: string): boolean;
  /** `execFileSync(git, args)` stdout trimmed, or null on any failure. */
  runGit(args: readonly string[]): string | null;
}

/** The `gitdir: <path>` payload of a linked worktree's `.git` file. */
export function parseGitDirMarker(content: string): string | null {
  const match = /^\s*gitdir:\s*(.+?)\s*$/m.exec(content);
  return match?.[1] !== undefined && match[1].length > 0 ? match[1] : null;
}

/** Branch name of a `ref: refs/heads/<name>` HEAD, or null when detached. */
export function parseRefHead(content: string): string | null {
  const match = /^\s*ref:\s*refs\/heads\/(.+?)\s*$/m.exec(content);
  return match?.[1] !== undefined && match[1].length > 0 ? match[1] : null;
}

/**
 * Observe the recorded folder. `undefined` means "nothing verifiable here"
 * (missing folder / unreadable marker), which `verifyGitResourceIdentity`
 * treats as `missing` — never as a pass.
 */
export function observeRepoIdentity(repoDir: string, probe: RepoProbe): GitResourceObservation | undefined {
  const gitPath = `${repoDir.replace(/[\\/]+$/, "")}/.git`;
  if (!probe.isFile(gitPath)) {
    // A directory `.git` is a normal checkout, not a linked worktree: report it
    // as such instead of pretending the task worktree is intact.
    const head = probe.runGit(["-C", repoDir, "rev-parse", "HEAD"]);
    if (head === null) return undefined;
    const abbrev = probe.runGit(["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"]);
    return {
      repoDir,
      head,
      branch: abbrev === null || abbrev === "HEAD" ? null : abbrev,
      isWorktree: false,
      baseCommitReachable: null,
    };
  }
  const marker = parseGitDirMarker(probe.readFile(gitPath) ?? "");
  if (marker === null) return undefined;
  const head = probe.runGit(["-C", repoDir, "rev-parse", "HEAD"]);
  if (head === null) return undefined;
  const abbrev = probe.runGit(["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"]);
  return {
    repoDir,
    head,
    branch: abbrev === null || abbrev === "HEAD" ? null : abbrev,
    isWorktree: true,
    baseCommitReachable: null, // filled by `withBaseCommitReachability`
  };
}

/** `git merge-base --is-ancestor <base> HEAD`: true/false, or null when unknown. */
export function baseCommitReachable(repoDir: string, baseCommit: string, probe: RepoProbe): boolean | null {
  if (baseCommit.trim().length === 0) return null;
  const answer = probe.runGit(["-C", repoDir, "merge-base", "--is-ancestor", baseCommit, "HEAD"]);
  // The wrapper returns null for both "not an ancestor" (exit 1) and a real
  // failure; the real probe distinguishes them by returning "1" for exit 1.
  if (answer === "0") return true;
  if (answer === "1") return false;
  return null;
}

/**
 * Real probe: fixed git argv (no shell, no user input in the command), every
 * failure collapsing to `null` so an unavailable git binary can only make the
 * identity check *stricter*.
 */
export function createNodeRepoProbe(): RepoProbe {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const { execFileSync } = process.getBuiltinModule("node:child_process") as typeof import("node:child_process");
  return {
    readFile: (path: string): string | null => {
      try {
        return fs.readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    isFile: (path: string): boolean => {
      try {
        return fs.lstatSync(path).isFile();
      } catch {
        return false;
      }
    },
    runGit: (args: readonly string[]): string | null => {
      try {
        return execFileSync("git", [...args], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch (error) {
        const status = (error as { status?: number }).status;
        // `--is-ancestor` uses exit 1 for "no"; keep that distinguishable from
        // an unavailable/failed git (which must stay unknown).
        if (args.includes("--is-ancestor") && status === 1) return "1";
        return null;
      }
    },
  };
}

/** Observed identity for one recorded worktree, including base-commit reachability. */
export function observeRecordedRepo(
  input: { repoDir: string; baseCommit: string },
  probe: RepoProbe,
): GitResourceObservation | undefined {
  const observed = observeRepoIdentity(input.repoDir, probe);
  if (!observed) return undefined;
  return { ...observed, baseCommitReachable: baseCommitReachable(input.repoDir, input.baseCommit, probe) };
}
