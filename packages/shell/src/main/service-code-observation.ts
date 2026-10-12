/**
 * [PiDock 05] (#10 box 6) main's read-only observation of the code a launch
 * will run from: the worktree HEAD commit and whether the working tree is
 * dirty (未提交代码和旧构建可区分).
 *
 * Main owns fs/child_process, so main is the process that reads the worktree.
 * The directory it reads is the launch's own verified `cwd`
 * (`service-catalog.ts` `verifiedLaunchPaths`: every component is a real
 * directory, the program is an executable regular file) — never a path the
 * page or the Host supplied.
 *
 * Honesty rules (the reason this is not a one-line helper):
 * - a git failure is a FAILURE, never a clean tree: the caller keeps `unknown`
 *   by name instead of letting an unread worktree read as `committed-clean`;
 * - the failure reason is a fixed, named classification. Raw git stderr can
 *   name machine paths, and the reason travels to a bounded log the sandboxed
 *   page reads (`task/serviceLog`), so no raw tool output crosses this seam;
 * - every child is bounded (timeout + output cap), non-interactive and
 *   INDEX-NEUTRAL, so a hung or credential-prompting git can neither stall a
 *   start nor write (`GIT_OPTIONAL_LOCKS=0`: without it `status --porcelain`
 *   refreshes and may rewrite the user's worktree index, and can collide with
 *   the user's own concurrent git on `index.lock`);
 * - the child's environment is pinned to `cwd` by clearing `GIT_DIR`,
 *   `GIT_WORK_TREE` and `GIT_INDEX_FILE`: an inherited one of these (PiDock
 *   launched from a git hook, or an exporting shell) would make every read
 *   answer about a DIFFERENT repository - possibly PiDock's own checkout -
 *   so a dirty task worktree could read `committed-clean` about the wrong repo.
 */
import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";

/** The code a run started from, as the worktree really read it. */
export interface CodeObservation {
  /** Worktree HEAD, as git reported it (40 hex on a sha1 repository). */
  commit: string;
  /** True when `git status --porcelain` reported anything uncommitted. */
  dirty: boolean;
}

/**
 * Bound on each git read. A local `rev-parse HEAD` / `status --porcelain` on a
 * task worktree completes in tens of milliseconds, so 5 s is already ~100x the
 * observed cost: generous enough not to false-timeout a loaded machine, while
 * halving the per-read window a hung git can block main's event loop (the group
 * path issues 2 such reads per bound unit, sequentially).
 */
const GIT_READ_TIMEOUT_MS = 5_000;
const GIT_READ_MAX_BUFFER = 1024 * 1024;
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/i;

/**
 * Read-only git in a bounded, non-interactive, INDEX-NEUTRAL child.
 * `GIT_TERMINAL_PROMPT`/`GCM_INTERACTIVE` are the same pair `task-append.ts`
 * uses for its own child git calls: a read here must never wait on a prompt.
 * `GIT_OPTIONAL_LOCKS=0` keeps `status --porcelain` from refreshing/writing the
 * worktree index (a write here would mutate the user's repository and can fail
 * on `index.lock` contention with the user's own git). `GIT_DIR`,
 * `GIT_WORK_TREE` and `GIT_INDEX_FILE` are cleared (`undefined` drops the key
 * from the child env) so the reads can only ever answer about `cwd`. No
 * mutating subcommand is ever passed by this module.
 */
function readGit(cwd: string, args: readonly string[]): { ok: true; stdout: string } | { ok: false; reason: string } {
  try {
    const stdout = execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      timeout: GIT_READ_TIMEOUT_MS,
      maxBuffer: GIT_READ_MAX_BUFFER,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        GIT_INDEX_FILE: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: stdout.trim() };
  } catch (error) {
    return { ok: false, reason: describeReadFailure(error) };
  }
}

/**
 * Name a git failure without echoing paths or tool output. Anything this
 * module cannot classify stays a generic named failure: guessing a cause from
 * text it cannot read is exactly what the boxes forbid.
 */
export function describeReadFailure(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  if (code === "ENOENT") return "本机没有可用的 Git 命令";
  if (code === "ETIMEDOUT" || (error as { killed?: unknown }).killed === true || (error as { signal?: unknown }).signal === "SIGTERM") {
    return "读取 Git 状态超时";
  }
  const stderr = (error as { stderr?: unknown }).stderr;
  const text = typeof stderr === "string" ? stderr.toLowerCase() : "";
  if (text.includes("not a git repository")) return "该目录不是 Git 工作树";
  if (/unknown revision|bad revision|ambiguous argument|needs a single revision|does not have any commits/.test(text)) {
    return "工作树没有可读取的 HEAD 提交";
  }
  if (text.includes("timed out")) return "读取 Git 状态超时";
  return "Git 状态读取失败";
}

/**
 * True when `cwd` is a real directory. Checked BEFORE spawning: a spawn with a
 * missing working directory fails with the same `ENOENT` a missing git binary
 * produces, so reading the failure code alone would report the wrong fact (and
 * a machine-wide claim instead of a path-specific one).
 */
function readableDirectory(cwd: string): boolean {
  try {
    return lstatSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read the worktree the launch's verified `cwd` lives in. `rev-parse HEAD` and
 * `status --porcelain` are the two reads; both run in that directory, so the
 * observation follows the launch's own working directory instead of a path this
 * module derives. `--porcelain` reports the whole repository relative to its
 * root, so a launch in a subdirectory still sees a sibling directory's edits -
 * an under-reported dirty tree would be a clean-reading one.
 *
 * A launch whose `cwd` is unknown, unreadable or not in a worktree yields
 * `ok: false` with a named reason: the caller must not record a code state.
 */
export function observeWorktreeCode(cwd: string | undefined): { ok: true; code: CodeObservation } | { ok: false; reason: string } {
  if (cwd === undefined || cwd.trim().length === 0) return { ok: false, reason: "启动描述符没有工作目录" };
  if (!readableDirectory(cwd)) return { ok: false, reason: "启动描述符的工作目录不可读" };
  const head = readGit(cwd, ["rev-parse", "HEAD"]);
  if (!head.ok) return { ok: false, reason: head.reason };
  if (!COMMIT_PATTERN.test(head.stdout)) return { ok: false, reason: "读取到的提交标识不可用" };
  const status = readGit(cwd, ["status", "--porcelain"]);
  // A failed status read is NOT an empty (clean) working tree.
  if (!status.ok) return { ok: false, reason: status.reason };
  return { ok: true, code: { commit: head.stdout.toLowerCase(), dirty: status.stdout.length > 0 } };
}

/**
 * The `task/registerService` payload fields that carry this observation to the
 * Host. Exactly one is produced: the observation itself, or the named reason it
 * could not be made. The reason travels with the registration so the start path
 * can put it in the service's bounded log without main inventing a code state.
 */
export function codeObservationFields(cwd: string | undefined): { code: CodeObservation } | { codeObservationFailure: string } {
  const observed = observeWorktreeCode(cwd);
  return observed.ok ? { code: observed.code } : { codeObservationFailure: observed.reason };
}
