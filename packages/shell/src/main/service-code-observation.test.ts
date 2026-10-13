/**
 * [PiDock 05] (#10 box 6) main's worktree observation: a REAL temporary git
 * repository, read with the production two-command read.
 *
 * What this pins:
 * - a clean committed worktree really reads as `committed-clean`;
 * - uncommitted edits (tracked OR untracked) really read as `dirty: true`,
 *   including an edit in a SIBLING directory when the launch's cwd is a
 *   subdirectory (an under-reported dirty tree would be a clean-reading one);
 * - EVERY way the read can fail (not a repository, no HEAD, no git binary, no
 *   cwd) is `ok: false` with a named reason - never a clean read;
 * - the named reason carries no machine path: it lands in the service's
 *   renderer-readable bounded log (`host.ts recordServiceRun`).
 *
 * Process hygiene: every `git` child here is `execFileSync` (bounded, exit
 * guaranteed) and every temp directory is removed in `afterEach`.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codeObservationFields, observeWorktreeCode } from "./service-code-observation.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Hermetic git: no system/global config, no prompts, no inherited identity. */
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * A real worktree shaped like a task folder: `repo-a/svc-a` and `repo-a/svc-b`,
 * one commit, and the commit id git itself reports.
 */
function worktree(): { root: string; cwd: string; sibling: string; commit: string } {
  const root = mkdtempSync(join(tmpdir(), "pidock-code-observation-"));
  roots.push(root);
  const cwd = join(root, "repo-a", "svc-a");
  const sibling = join(root, "repo-a", "svc-b");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(cwd, "service.cjs"), "console.log('a');\n");
  writeFileSync(join(sibling, "service.cjs"), "console.log('b');\n");
  git(root, ["init", "-q", "-b", "main", "."]);
  git(root, ["-c", "user.name=pidock-test", "-c", "user.email=pidock@test.invalid", "add", "-A"]);
  git(root, ["-c", "user.name=pidock-test", "-c", "user.email=pidock@test.invalid", "commit", "-q", "-m", "fixture"]);
  return { root, cwd, sibling, commit: git(cwd, ["rev-parse", "HEAD"]) };
}

/** A directory that is a real directory but not inside any worktree. */
function nonRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "pidock-code-observation-plain-"));
  roots.push(root);
  return root;
}

describe("[PiDock 05] #10 main really reads the worktree a launch runs from", () => {
  it("reads a clean committed worktree as its own HEAD commit, not dirty", () => {
    const { cwd, commit } = worktree();
    const observed = observeWorktreeCode(cwd);
    expect(observed).toEqual({ ok: true, code: { commit, dirty: false } });
    // The value is git's own answer, not a value this module derived: a second
    // read of the same unchanged worktree returns the same commit.
    expect(git(cwd, ["rev-parse", "HEAD"])).toBe(commit);
  });

  it("reads a modified tracked file as dirty and keeps the same HEAD", () => {
    const { cwd, commit } = worktree();
    writeFileSync(join(cwd, "service.cjs"), "console.log('a modified');\n");
    expect(observeWorktreeCode(cwd)).toEqual({ ok: true, code: { commit, dirty: true } });
  });

  it("reads an untracked file as dirty", () => {
    const { cwd, commit } = worktree();
    writeFileSync(join(cwd, "new-service.cjs"), "console.log('new');\n");
    expect(observeWorktreeCode(cwd)).toEqual({ ok: true, code: { commit, dirty: true } });
  });

  it("reads an edit in a SIBLING directory of the launch cwd as dirty", () => {
    // The launch cwd is one service subdirectory of the worktree. A dirty tree
    // that only shows from the repository root must not read as clean.
    const { cwd, sibling, commit } = worktree();
    writeFileSync(join(sibling, "service.cjs"), "console.log('b modified');\n");
    expect(observeWorktreeCode(cwd)).toEqual({ ok: true, code: { commit, dirty: true } });
  });

  it("reads the newest commit after HEAD advances (so an older recorded commit is distinguishable)", () => {
    const { root, cwd } = worktree();
    const first = observeWorktreeCode(cwd);
    writeFileSync(join(cwd, "service.cjs"), "console.log('second');\n");
    git(root, ["-c", "user.name=pidock-test", "-c", "user.email=pidock@test.invalid", "add", "-A"]);
    git(root, ["-c", "user.name=pidock-test", "-c", "user.email=pidock@test.invalid", "commit", "-q", "-m", "second"]);
    const second = observeWorktreeCode(cwd);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw Error("unreachable");
    expect(second.code.commit).toBe(git(cwd, ["rev-parse", "HEAD"]));
    expect(second.code.commit).not.toBe(first.code.commit);
    expect(second.code.dirty).toBe(false);
  });
});

describe("[PiDock 05] #10 a failed worktree read never reads as clean", () => {
  it("refuses by name outside a worktree instead of reporting a clean tree", () => {
    const dir = nonRepo();
    const observed = observeWorktreeCode(dir);
    expect(observed.ok).toBe(false);
    if (observed.ok) throw Error("unreachable");
    expect(observed.reason).toBe("该目录不是 Git 工作树");
    // The whole point of the box: nobody read a commit, so this is NOT clean.
    expect(observed).not.toEqual({ ok: true, code: { commit: "", dirty: false } });
  });

  it("refuses a worktree whose HEAD has no commit yet", () => {
    const root = mkdtempSync(join(tmpdir(), "pidock-code-observation-unborn-"));
    roots.push(root);
    git(root, ["init", "-q", "-b", "main", "."]);
    const observed = observeWorktreeCode(root);
    expect(observed.ok).toBe(false);
    if (observed.ok) throw Error("unreachable");
    expect(observed.reason).toBe("工作树没有可读取的 HEAD 提交");
  });

  it("names a missing git binary instead of reporting a clean tree", () => {
    const { cwd } = worktree();
    const savedPath = process.env["PATH"];
    // An empty executable search path: the spawn itself fails, which is the
    // "git is unavailable" case - not an empty (clean) status.
    process.env["PATH"] = nonRepo();
    try {
      const observed = observeWorktreeCode(cwd);
      expect(observed.ok).toBe(false);
      if (observed.ok) throw Error("unreachable");
      expect(observed.reason).toBe("本机没有可用的 Git 命令");
    } finally {
      if (savedPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = savedPath;
    }
  });

  it("refuses a launch with no working directory", () => {
    expect(observeWorktreeCode(undefined)).toEqual({ ok: false, reason: "启动描述符没有工作目录" });
    expect(observeWorktreeCode("  ")).toEqual({ ok: false, reason: "启动描述符没有工作目录" });
  });

  it("names an unreadable working directory as such, not as a missing git binary", () => {
    // A spawn with a missing cwd fails with the same ENOENT a missing binary
    // produces, so the reason must come from checking the directory itself.
    expect(observeWorktreeCode(join(nonRepo(), "missing-subdir"))).toEqual({ ok: false, reason: "启动描述符的工作目录不可读" });
  });

  it("keeps machine paths out of the named reason (the reason reaches the renderer-readable log)", () => {
    const dir = nonRepo();
    const observed = observeWorktreeCode(dir);
    if (observed.ok) throw Error("unreachable");
    expect(observed.reason).not.toContain(dir);
    expect(observed.reason).not.toContain("fatal:");
    expect(observed.reason).not.toContain("/");
  });
});

describe("[PiDock 05] #10 the observation is READ-ONLY and can only answer about cwd", () => {
  it("does not write the worktree index (status --porcelain is index-neutral here)", () => {
    const { root, cwd } = worktree();
    const index = join(root, ".git", "index");
    // `git status` refreshes and REWRITES the index exactly when a tracked
    // file's recorded stat no longer matches its real stat: touch the file (same
    // content, new mtime) to create that condition. Pin the index file's own
    // mtime to a fixed past moment so a rewrite would move it to now - making
    // any write unmistakable rather than a same-millisecond coin flip.
    const past = new Date(1_000_000);
    utimesSync(join(cwd, "service.cjs"), past, past);
    utimesSync(index, past, past);
    const beforeMtime = statSync(index).mtimeMs;
    const beforeBytes = readFileSync(index);

    expect(observeWorktreeCode(cwd)).toEqual({ ok: true, code: { commit: git(cwd, ["rev-parse", "HEAD"]), dirty: false } });

    // The supposedly read-only observation left the user's index byte-identical
    // and untouched: without `GIT_OPTIONAL_LOCKS=0` git refreshes it here.
    expect(statSync(index).mtimeMs).toBe(beforeMtime);
    expect(readFileSync(index)).toEqual(beforeBytes);
  });

  it("answers about cwd when an inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE name another repo", () => {
    const { cwd, commit } = worktree();
    // The launch worktree is DIRTY: this is the exact way a redirected read
    // could (wrongly) read `committed-clean` about the wrong repository.
    writeFileSync(join(cwd, "service.cjs"), "console.log('dirty');\n");
    // A second, CLEAN repository with a different HEAD - what a git hook or an
    // exporting shell pointed the three variables at.
    const decoy = mkdtempSync(join(tmpdir(), "pidock-code-observation-decoy-"));
    roots.push(decoy);
    writeFileSync(join(decoy, "decoy.cjs"), "console.log('decoy');\n");
    git(decoy, ["init", "-q", "-b", "main", "."]);
    git(decoy, ["-c", "user.name=pidock-test", "-c", "user.email=pidock@test.invalid", "add", "-A"]);
    git(decoy, ["-c", "user.name=pidock-test", "-c", "user.email=pidock@test.invalid", "commit", "-q", "-m", "decoy"]);
    expect(git(decoy, ["rev-parse", "HEAD"])).not.toBe(commit);

    const saved = { GIT_DIR: process.env["GIT_DIR"], GIT_WORK_TREE: process.env["GIT_WORK_TREE"], GIT_INDEX_FILE: process.env["GIT_INDEX_FILE"] };
    process.env["GIT_DIR"] = join(decoy, ".git");
    process.env["GIT_WORK_TREE"] = decoy;
    process.env["GIT_INDEX_FILE"] = join(decoy, ".git", "index");
    try {
      // Without clearing the three, this would answer with the decoy's clean HEAD.
      expect(observeWorktreeCode(cwd)).toEqual({ ok: true, code: { commit, dirty: true } });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("answers about cwd's own index when GIT_INDEX_FILE names a different index", () => {
    const { root, cwd, commit } = worktree();
    const index = join(root, ".git", "index");
    // A poisoned alternate index whose blob for the tracked file differs from
    // HEAD. Keep it OUTSIDE the worktree (an in-tree file would itself read as
    // untracked), then reset the worktree clean. If the read honoured
    // GIT_INDEX_FILE, a CLEAN cwd would read dirty (index vs HEAD); clearing it
    // keeps the answer about cwd's own index.
    const poisonDir = mkdtempSync(join(tmpdir(), "pidock-code-observation-poison-"));
    roots.push(poisonDir);
    const poisoned = join(poisonDir, "index");
    writeFileSync(join(cwd, "service.cjs"), "console.log('poison');\n");
    git(root, ["add", "-A"]);
    copyFileSync(index, poisoned);
    git(root, ["reset", "-q", "--hard", "HEAD"]);

    const saved = process.env["GIT_INDEX_FILE"];
    process.env["GIT_INDEX_FILE"] = poisoned;
    try {
      expect(observeWorktreeCode(cwd)).toEqual({ ok: true, code: { commit, dirty: false } });
    } finally {
      if (saved === undefined) delete process.env["GIT_INDEX_FILE"];
      else process.env["GIT_INDEX_FILE"] = saved;
    }
  });
});

describe("[PiDock 05] #10 the registration payload carries one of the two facts, never both", () => {
  it("carries the observation when the read succeeded", () => {
    const { cwd, commit } = worktree();
    expect(codeObservationFields(cwd)).toEqual({ code: { commit, dirty: false } });
  });

  it("carries the named failure instead of an observation when the read failed", () => {
    const fields = codeObservationFields(nonRepo());
    expect(fields).toEqual({ codeObservationFailure: "该目录不是 Git 工作树" });
    expect("code" in fields).toBe(false);
  });
});
