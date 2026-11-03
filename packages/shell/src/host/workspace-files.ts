/**
 * Host-side task file access for [PiDock 10] (#15), S3 slice.
 *
 * The Host owns the real reads (directory listing, file body, git diff) for
 * one task folder; the rules that decide *what may be read and how much may
 * cross the boundary* live in `main/workspace-files.ts`, and this module wires
 * them to injectable readers so node tests never touch a real repository.
 *
 * Design notes:
 * - Roots come from the task record: one worktree per repo (with its pinned
 *   baseline commit) and one entry per plain-directory link (a shared view of
 *   its original target). An unknown root id is refused, never guessed.
 * - A preview/listing is bounded before it is returned; a body larger than the
 *   bound is truncated with a flag instead of being read into the session.
 * - Every read first checks that the path's *real* location (symlinks
 *   resolved) stays under the root's own real path, so a link inside a
 *   worktree cannot point the reader at another task or an out-of-task file.
 * - Every body is masked with the task's private values (`secrets`) using the
 *   shared scrubber, so a credential in a diff cannot leak through this path.
 * - Git runs with a fixed argv (`git diff --no-color [<base>] -- <path>`, plus
 *   the two observation reads below) in the root's cwd and never through a
 *   shell; the real terminal *spawn* stays a recorded residual, this is a
 *   bounded read-only read.
 * - `observedRoots()` is the one readout that reads the worktree itself: it
 *   reports each worktree's OWN working branch and uncommitted state, observed
 *   in a bounded, non-interactive, index-neutral child (the #10 box 6
 *   discipline in `main/service-code-observation.ts`), and leaves a NAMED
 *   unknown when a read fails: the record's pinned baseline branch is never
 *   filled in for an unread branch, and "no uncommitted change" is never
 *   assumed from an unread `git status`.
 */

import type { TaskPathProtection } from "./protected-application-path.js";
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { remoteDigest } from "../main/remote-identity.js";
import { describeReadFailure } from "../main/service-code-observation.js";
import {
  MAX_PREVIEW_CHARS,
  boundDiff,
  boundPreview,
  boundTreeEntries,
  deliveryTarget,
  findWorkspaceRoot,
  resolveWorkspacePath,
  verifyWorkspaceSource,
  workspaceAttribution,
  workspaceRoots,
  type ObservedSourceIdentity,
  type WorkspaceAttribution,
  type WorkspaceDeliveryResult,
  type WorkspaceDiffResult,
  type WorkspaceMode,
  type WorkspaceObservation,
  type WorkspacePreview,
  type WorkspaceRoot,
  type WorkspaceTree,
  type WorkspaceVerification,
} from "../main/workspace-files.js";
import type { TaskDiskRecord } from "./task-store.js";
import type { TaskStore } from "./task-host.js";

/** Directory listing reader: plain name/kind/size, never a path. */
export interface WorkspaceFileReaders {
  listDirectory(path: string): { name: string; kind: "file" | "dir"; size?: number }[];
  readTextFile(path: string): { ok: true; text: string; bytes: number } | { ok: false; error: string };
  runGit(args: readonly string[], cwd: string): { ok: true; stdout: string } | { ok: false; error: string };
  /**
   * Resolve symlinks in one existing path; an absent path returns the input.
   * Containment is checked against these real paths so a link inside a root
   * cannot point the reader at another task's folder or an out-of-task file.
   */
  realPath(path: string): string;
  /**
   * Read one path's current identity ([Pencil T02] #137): device/inode of a
   * real directory, or the named `missing`/`other` answer. A path that is gone
   * is an observation, never an exception the facts surface would turn into a
   * blank row.
   */
  identity(path: string): { kind: "dir" | "other" | "missing"; realPath?: string; device?: string; inode?: string };
  /**
   * Current existence/kind of one path ([Pencil T19] #145): the send-time
   * re-check asks the Host whether a referenced file is still at its recorded
   * source path. Missing is an answer, never an exception; an unreadable path
   * throws so the caller can name the failure instead of guessing.
   */
  statFile(path: string): { kind: "file" | "dir" | "other" | "missing"; size?: number; mtimeMs?: number };
}

/** Read cap: a file bigger than this is refused rather than loaded. */
export const MAX_PREVIEW_BYTES = 1_000_000;

/**
 * Bound on one read-only git read in a root. A `rev-parse`/`status --porcelain`
 * on a task worktree completes in tens of milliseconds, so 5 s is already ~100x
 * the observed cost; a diff needs the larger cap below. Mirrors
 * `main/service-code-observation.ts` `GIT_READ_TIMEOUT_MS`/`GIT_READ_MAX_BUFFER`.
 */
const GIT_READ_TIMEOUT_MS = 5_000;
const GIT_READ_MAX_BUFFER = 1024 * 1024;
/** A whole-worktree diff against the pinned baseline needs the larger cap. */
const GIT_DIFF_TIMEOUT_MS = 10_000;
const GIT_DIFF_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * Fixed, named reason for a root whose directory is not there. A spawn with a
 * missing cwd fails with the same `ENOENT` a missing git binary produces, so
 * reading the failure code alone would report a machine-wide "this machine has
 * no git" for a path-local fact — the reason `main/service-code-observation.ts`
 * checks `readableDirectory` before spawning (its lines 108-116, mirrored here).
 */
const ROOT_DIR_UNREADABLE = "工作副本目录不可读：该工作副本可能已被移除";

/**
 * True when `path` is a real directory, checked BEFORE spawning git (see
 * `ROOT_DIR_UNREADABLE`).
 */
function readableDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The branch the worktree is really on, or the NAMED reason it was not read.
 * A detached worktree answers the literal `HEAD`, which is not a branch name:
 * that is a named unknown, never the record's declared task branch.
 */
function observeBranch(read: ReturnType<WorkspaceFileReaders["runGit"]>): WorkspaceObservation<string> {
  if (!read.ok) return { state: "unknown", reason: read.error };
  const name = read.stdout.trim();
  if (name.length === 0 || name === "HEAD") return { state: "unknown", reason: "工作副本不在任何分支上（分离头指针）" };
  return { state: "observed", value: name };
}

/**
 * Whether `git status --porcelain` reported anything in the worktree: any line
 * is uncommitted work, including UNTRACKED files, which a diff against the
 * baseline cannot show. A failed read is a named unknown — `false` here means
 * "read, and there was nothing", never "could not tell".
 */
function observeDirty(read: ReturnType<WorkspaceFileReaders["runGit"]>): WorkspaceObservation<boolean> {
  if (!read.ok) return { state: "unknown", reason: read.error };
  return { state: "observed", value: read.stdout.trim().length > 0 };
}

/** Windows separators/case apply only to a Windows task, never a POSIX target. */
function comparisonKey(path: string, windowsPaths: boolean): string {
  if (!windowsPaths) return path.replace(/\/+$/, "") || "/";
  return (path.replace(/[\\/]+$/, "") || "/").replace(/\\/g, "/").toLowerCase();
}

export const realWorkspaceFileReaders: WorkspaceFileReaders = {
  listDirectory(path) {
    return readdirSync(path, { withFileTypes: true }).map((entry) => {
      const kind: "file" | "dir" = entry.isDirectory() ? "dir" : "file";
      if (kind === "file") {
        try {
          return { name: entry.name, kind, size: statSync(`${path}/${entry.name}`).size };
        } catch {
          return { name: entry.name, kind };
        }
      }
      return { name: entry.name, kind };
    });
  },
  readTextFile(path) {
    try {
      const info = statSync(path);
      if (!info.isFile()) return { ok: false, error: `not-a-file: ${path} 不是普通文件` };
      if (info.size > MAX_PREVIEW_BYTES) {
        return { ok: false, error: `file-too-large: ${path} 超过 ${MAX_PREVIEW_BYTES} 字节，未读取` };
      }
      const buffer = readFileSync(path);
      if (buffer.includes(0)) return { ok: false, error: `binary-file: ${path} 是二进制文件，不提供文本预览` };
      return { ok: true, text: buffer.toString("utf8"), bytes: info.size };
    } catch (error) {
      return { ok: false, error: `read-failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  },
  runGit(args, cwd) {
    // Mirrors `main/service-code-observation.ts` `readGit` (its lines 66-85): the
    // read is INDEX-NEUTRAL and pinned to `cwd`, so it can never refresh, lock or
    // write a repository it only reads. Without `GIT_OPTIONAL_LOCKS=0` a
    // `status --porcelain` refreshes and may rewrite the user's worktree index
    // (and can collide with the user's own git on `index.lock`); an inherited
    // `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` (PiDock started from a git hook
    // or an exporting shell) would make every read answer about a DIFFERENT
    // repository, so a dirty worktree could read "clean" about the wrong repo.
    if (!readableDirectory(cwd)) return { ok: false, error: ROOT_DIR_UNREADABLE };
    // A diff needs the larger bound; every other read here (branch, status) is
    // tiny and gets the tighter one. Both stay bounded, non-interactive and
    // index-neutral.
    const diff = args[0] === "diff";
    try {
      const stdout = execFileSync("git", [...args], {
        cwd,
        encoding: "utf8",
        timeout: diff ? GIT_DIFF_TIMEOUT_MS : GIT_READ_TIMEOUT_MS,
        maxBuffer: diff ? GIT_DIFF_MAX_BUFFER : GIT_READ_MAX_BUFFER,
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
      return { ok: true, stdout };
    } catch (error) {
      // A fixed, named classification (the same taxonomy #10's launch-time code
      // observation uses) instead of raw git stderr, which can name machine paths.
      return { ok: false, error: describeReadFailure(error) };
    }
  },
  realPath(path) {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  },
  identity(path) {
    let stat;
    try {
      stat = lstatSync(path, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
      return { kind: "other" };
    }
    if (!stat.isDirectory() || stat.dev <= 0n || stat.ino <= 0n) return { kind: "other" };
    let realPath: string | undefined;
    try {
      realPath = realpathSync(path);
    } catch {
      realPath = undefined;
    }
    return { kind: "dir", ...(realPath !== undefined ? { realPath } : {}), device: String(stat.dev), inode: String(stat.ino) };
  },
  statFile(path) {
    try {
      const info = statSync(path);
      const common = { size: info.size, mtimeMs: info.mtimeMs };
      if (info.isFile()) return { kind: "file", ...common };
      if (info.isDirectory()) return { kind: "dir" };
      return { kind: "other", ...common };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
      // A path that exists but cannot be inspected is NOT reported as missing:
      // the caller must be able to tell "moved away" from "could not read".
      throw error;
    }
  },
};

export class TaskWorkspaceFiles {
  constructor(
    readonly taskId: string,
    readonly taskDir: string,
    private readonly store: TaskStore,
    private readonly readers: WorkspaceFileReaders = realWorkspaceFileReaders,
    /**
     * Task/private values that must never appear in a preview or diff. The
     * Host passes the private env layer; an empty list still masks every
     * credential-shaped pattern.
     */
    private readonly secrets: () => readonly string[] = () => [],
    private readonly protection?: TaskPathProtection,
  ) {}

  /** Browsable roots of this task, derived from its record. */
  /**
   * The task's declared workspace mode ([Pencil T02] #137). A record written
   * before the mode existed is derived from its sources (shared checkouts =>
   * existing-git, worktree repos => worktree, otherwise plain directories),
   * never from the UI.
   */
  workspaceMode(): WorkspaceMode {
    const record = this.requireRecord();
    if (record.workspaceMode !== undefined) return record.workspaceMode;
    if ((record.sharedRepos?.length ?? 0) > 0) return "existing-git";
    return record.repos.length > 0 ? "worktree" : "plain-dirs";
  }

  roots(): WorkspaceRoot[] {
    const record = this.requireRecord();
    this.protection?.assert(this.taskDir);
    for (const link of record.dirLinks ?? []) this.protection?.assert(link.sourcePath);
    for (const shared of record.sharedRepos ?? []) this.protection?.assert(shared.sourcePath);
    const roots = workspaceRoots({
      taskId: this.taskId,
      taskDir: this.taskDir,
      repos: record.repos,
      ...(record.repoSources ? { repoSources: record.repoSources } : {}),
      ...(record.dirLinks ? { dirLinks: record.dirLinks } : {}),
      ...(record.sharedRepos ? { sharedRepos: record.sharedRepos } : {}),
      ...(record.workspaceMode !== undefined ? { workspaceMode: record.workspaceMode } : {}),
      baselineBranch: record.remoteBranch,
      // The record's own task branch (`task/<dirId>`) is the DECLARED
      // expectation, kept apart from `record.remoteBranch` (the pinned
      // baseline) and from whatever the worktree is really on.
      taskBranch: record.branch,
      baseCommit: record.baseCommit,
    });
    for (const root of roots) this.protection?.assert(root.path);
    return roots;
  }

  /**
   * The roots as `task/fileRoots` reports them: every worktree root carries the
   * branch it is really on and whether it really has uncommitted changes,
   * observed in that worktree. Kept separate from `roots()` so the tree /
   * preview / diff reads — which never ask about the branch — do not spawn a
   * git child per root, and so one root that cannot be read cannot make any of
   * them fail.
   */
  observedRoots(): WorkspaceRoot[] {
    return this.roots().map((root) =>
      root.kind === "worktree" ? { ...root, ...this.observeWorktree(root) } : root,
    );
  }

  /**
   * The full facts readout the task facts surface renders ([Pencil T02] #137):
   * every root, its observed branch/HEAD (where the root has Git), and the
   * per-source result of re-verifying the identity the record holds. Reads the
   * record and the filesystem; never writes the record back, so a moved source
   * is reported as `missing`/`mismatch` instead of being silently rewritten.
   */
  facts(): WorkspaceRoot[] {
    const record = this.requireRecord();
    return this.observedRoots().map((root) => {
      if (root.kind === "existing-git") {
        return { ...root, ...this.observeSharedGit(root), ...this.verifyRoot(root, record) };
      }
      return { ...root, ...this.verifyRoot(root, record) };
    });
  }

  /** Observed branch/HEAD/uncommitted state of one existing checkout in place. */
  private observeSharedGit(root: WorkspaceRoot): {
    workingBranch: WorkspaceObservation<string>;
    headCommit: WorkspaceObservation<string>;
    dirty: WorkspaceObservation<boolean>;
  } {
    const branch = observeBranch(this.readers.runGit(["rev-parse", "--abbrev-ref", "HEAD"], root.path));
    const head = this.readers.runGit(["rev-parse", "--verify", "HEAD"], root.path);
    const headCommit: WorkspaceObservation<string> = head.ok && /^[a-f0-9]{40}$/.test(head.stdout.trim())
      ? { state: "observed", value: head.stdout.trim() }
      : { state: "unknown", reason: head.ok ? "来源 HEAD 不是完整提交" : head.error };
    const status = this.readers.runGit(["status", "--porcelain"], root.path);
    return { workingBranch: branch, headCommit, dirty: observeDirty(status) };
  }

  /**
   * Re-verify one root's recorded identity. Recorded fields come from the
   * record (`repoSources` target identity, `sharedRepos`, `dirLinks`); a record
   * with no identity is `repair-required`, never assumed ready.
   */
  private verifyRoot(root: WorkspaceRoot, record: TaskDiskRecord): { verification: WorkspaceVerification } {
    if (root.kind === "worktree") {
      const source = record.repoSources?.find((entry) => entry.repoDir === root.id);
      const recorded = {
        path: root.path,
        ...(source?.targetDevice !== undefined && source.targetInode !== undefined
          ? { device: source.targetDevice, inode: source.targetInode } : {}),
        ...(source?.commonDir !== undefined ? { commonDir: source.commonDir } : {}),
        ...(source?.remoteDigest !== undefined ? { remoteDigest: source.remoteDigest } : {}),
      };
      const identity = this.readers.identity(root.path);
      if (identity.kind !== "dir") return { verification: verifyWorkspaceSource(recorded, identity) };
      const readGit = source?.commonDir !== undefined || source?.remoteDigest !== undefined;
      const verification = verifyWorkspaceSource(recorded, {
        ...identity,
        ...(readGit ? this.observeGitIdentity(root.path, source?.remote) : {}),
      });
      // [Pencil T08] #143: the bound path existing is not enough. A worktree
      // record written by a creation (`targetBranch` present) also binds the
      // task branch and the pinned baseline, so a checkout moved onto another
      // branch, or one whose lineage no longer contains the pinned commit, is a
      // named repair state — the task is never silently re-created from it.
      if (verification.state !== "ready" || source?.targetBranch === undefined) return { verification };
      const bound = this.verifyWorktreeBinding(root);
      return { verification: bound ?? verification };
    }
    if (root.kind === "existing-git") {
      const source = record.sharedRepos?.find((entry) => entry.rootId === root.id);
      if (!source) return { verification: { state: "repair-required", reason: "待修复：任务记录缺少该已有 Git 目录的来源身份，无法核验" } };
      const recorded = {
        path: source.sourcePath,
        ...(source.sourceRealPath !== undefined ? { realPath: source.sourceRealPath } : {}),
        ...(source.sourceDevice !== undefined && source.sourceInode !== undefined
          ? { device: source.sourceDevice, inode: source.sourceInode } : {}),
        commonDir: source.commonDir,
        remoteDigest: source.remoteDigest,
      };
      const identity = this.readers.identity(source.sourcePath);
      if (identity.kind !== "dir") return { verification: verifyWorkspaceSource(recorded, identity) };
      return { verification: verifyWorkspaceSource(recorded, { ...identity, ...this.observeGitIdentity(source.sourcePath, source.remote) }) };
    }
    const link = record.dirLinks?.find((entry) => entry.linkName === root.id);
    if (!link) return { verification: { state: "repair-required", reason: "待修复：任务记录缺少该普通目录的来源身份，无法核验" } };
    const recorded = {
      path: link.sourcePath,
      ...(link.sourceDevice !== undefined && link.sourceInode !== undefined
        ? { device: link.sourceDevice, inode: link.sourceInode } : {}),
    };
    return { verification: verifyWorkspaceSource(recorded, this.readers.identity(link.sourcePath)) };
  }

  /**
   * [Pencil T08] #143: re-prove the worktree's branch and pinned baseline. Uses
   * the observation already taken for the facts row (and a real `merge-base`
   * probe for the lineage), and names which binding changed.
   */
  private verifyWorktreeBinding(root: WorkspaceRoot): WorkspaceVerification | null {
    const observedBranch = root.workingBranch;
    if (root.expectedBranch !== undefined && observedBranch?.state === "observed" && observedBranch.value !== root.expectedBranch) {
      return { state: "branch-mismatch",
        reason: `分支不符：工作副本当前在 ${observedBranch.value}，任务绑定分支为 ${root.expectedBranch}；重开需要明确修复，不会自动重建` };
    }
    if (root.expectedBranch !== undefined && observedBranch?.state === "unknown") {
      return { state: "repair-required", reason: `待修复：无法读取工作副本的当前分支（${observedBranch.reason}）` };
    }
    if (root.baseCommit !== undefined && root.baseCommit.length > 0) {
      const ancestor = this.readers.runGit(["merge-base", "--is-ancestor", root.baseCommit, "HEAD"], root.path);
      if (!ancestor.ok) {
        return { state: "base-mismatch",
          reason: `基线不符：固定基线提交 ${root.baseCommit} 已不在工作副本历史中；重开需要明确修复，不会自动重建` };
      }
    }
    return null;
  }

  /** Current Git common dir + remote digest of one real checkout, or named nulls. */
  private observeGitIdentity(path: string, remote?: string): Pick<ObservedSourceIdentity, "commonDir" | "remoteDigest"> {
    let commonDir: string | null = null;
    const common = this.readers.runGit(["rev-parse", "--git-common-dir"], path);
    if (common.ok && common.stdout.trim().length > 0) commonDir = this.readers.realPath(resolve(path, common.stdout.trim()));
    let digest: string | null = null;
    if (remote !== undefined && remote.length > 0) {
      const url = this.readers.runGit(["remote", "get-url", remote], path);
      if (url.ok) {
        try {
          digest = remoteDigest(url.stdout.trim());
        } catch {
          digest = null;
        }
      }
    }
    return { commonDir, remoteDigest: digest };
  }

  /**
   * The two observation reads for one worktree, each with its own outcome.
   * `rev-parse --abbrev-ref HEAD` names the branch (or literally `HEAD` on a
   * detached worktree, which is NOT a branch name), and `status --porcelain`
   * reports uncommitted work including UNTRACKED files — which a diff against
   * the baseline cannot see, so a new file would otherwise read as no change.
   * A failed read keeps its own named reason; the two never borrow each other's
   * answer.
   */
  private observeWorktree(root: WorkspaceRoot): { workingBranch: WorkspaceObservation<string>; dirty: WorkspaceObservation<boolean> } {
    const head = this.readers.runGit(["rev-parse", "--abbrev-ref", "HEAD"], root.path);
    const status = this.readers.runGit(["status", "--porcelain"], root.path);
    return { workingBranch: observeBranch(head), dirty: observeDirty(status) };
  }

  /** Attribution of one root (`null` when the id is not one of this task's roots). */
  attribution(rootId: string): WorkspaceAttribution | null {
    const root = findWorkspaceRoot(this.roots(), rootId);
    return root ? workspaceAttribution(root, this.taskId, this.taskDir) : null;
  }

  /** Bounded directory listing of one root (or a directory inside it). */
  tree(input: { rootId: unknown; relative?: unknown }): { ok: true; tree: WorkspaceTree } | { ok: false; error: string } {
    const target = this.resolve(input);
    if (!target.ok) return { ok: false, error: target.error };
    const escape = this.rootEscapeError(target.root, target.absolute);
    if (escape !== undefined) return { ok: false, error: escape };
    let entries: { name: string; kind: "file" | "dir"; size?: number }[];
    try {
      entries = this.readers.listDirectory(target.absolute);
    } catch (error) {
      return { ok: false, error: `read-failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    const bounded = boundTreeEntries(entries, target.relative);
    // A listed entry that is a link out of the root is not shown at all: the
    // panel must not offer a file this task may not read. Checked on the
    // bounded list so one huge directory cannot turn into unbounded syscalls.
    const inside = bounded.entries.filter(
      (entry) => this.rootEscapeError(target.root, `${target.root.path}/${entry.path}`) === undefined,
    );
    return { ok: true, tree: { attribution: target.attribution, path: target.relative, entries: inside, truncated: bounded.truncated } };
  }

  /**
   * Existence/kind of one path inside one root ([Pencil T19] #145). The send
   * re-check reads this, so a referenced file that was moved or deleted on disk
   * is reported as `missing` instead of being accepted because the chip and
   * the root still look valid.
   */
  stat(input: { rootId: unknown; relative?: unknown }): {
    ok: true;
    stat: { path: string; kind: "file" | "dir" | "other" | "missing"; exists: boolean; size?: number; mtimeMs?: number };
  } | { ok: false; error: string } {
    const target = this.resolve(input, false);
    if (!target.ok) return { ok: false, error: target.error };
    const escape = this.rootEscapeError(target.root, target.absolute);
    if (escape !== undefined) return { ok: false, error: escape };
    let observed: { kind: "file" | "dir" | "other" | "missing"; size?: number; mtimeMs?: number };
    try {
      observed = this.readers.statFile(target.absolute);
    } catch (error) {
      return { ok: false, error: `read-failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    return { ok: true, stat: { path: target.relative, exists: observed.kind !== "missing", ...observed } };
  }

  /** Bounded, masked preview of one text file inside one root. */
  preview(input: { rootId: unknown; relative?: unknown }): { ok: true; preview: WorkspacePreview } | { ok: false; error: string } {
    const target = this.resolve(input, false);
    if (!target.ok) return { ok: false, error: target.error };
    const escape = this.rootEscapeError(target.root, target.absolute);
    if (escape !== undefined) return { ok: false, error: escape };
    const read = this.readers.readTextFile(target.absolute);
    if (!read.ok) return { ok: false, error: read.error };
    return {
      ok: true,
      preview: boundPreview({
        root: target.root,
        taskId: this.taskId,
        taskDir: this.taskDir,
        path: target.relative,
        source: read.text.slice(0, MAX_PREVIEW_CHARS + 1),
        secrets: this.secrets(),
        lineCount: read.text.split("\n").length,
      }),
    };
  }

  /**
   * Bounded, masked Git diff for one path (or the whole worktree) against the
   * root's pinned baseline commit. A plain-directory link has no Git view and
   * is refused by the rule layer with `plain-dir-no-diff`.
   */
  diff(input: { rootId: unknown; relative?: unknown }): WorkspaceDiffResult {
    const target = resolveWorkspacePath({
      roots: this.roots(),
      taskId: this.taskId,
      taskDir: this.taskDir,
      rootId: input.rootId,
      relative: input.relative,
      allowRoot: true,
    });
    if (!target.ok) return { ok: false, error: target.error };
    const escape = this.rootEscapeError(target.root, target.absolute);
    if (escape !== undefined) return { ok: false, error: escape };
    if (target.root.kind !== "worktree") {
      // Refuse before running git: the rule layer owns the reason text.
      return boundDiff({ root: target.root, taskId: this.taskId, taskDir: this.taskDir, path: target.relative, diff: "" });
    }
    const args = ["diff", "--no-color"];
    if (target.root.baseCommit) args.push(target.root.baseCommit);
    args.push("--");
    if (target.relative.length > 0) args.push(target.relative);
    const result = this.readers.runGit(args, target.root.path);
    if (!result.ok) return { ok: false, error: result.error };
    return boundDiff({
      root: target.root,
      taskId: this.taskId,
      taskDir: this.taskDir,
      path: target.relative,
      diff: result.stdout,
      secrets: this.secrets(),
    });
  }

  /** Git delivery target (repo + branch, nothing automatic) for one root. */
  delivery(input: { rootId: unknown }): WorkspaceDeliveryResult {
    const root = findWorkspaceRoot(this.roots(), typeof input.rootId === "string" ? input.rootId.trim() : "");
    if (!root) return { ok: false, error: `unknown-root: ${String(input.rootId)} 不是本任务的文件根（仓库或普通目录链接）` };
    return deliveryTarget({ root, taskId: this.taskId, taskDir: this.taskDir });
  }

  /**
   * `path-out-of-scope` when one path's real location is outside its root.
   * A root may itself be a link (a plain-directory link is one), so the check
   * is "under the root's own real path", not "under the task folder": a
   * symlink inside a worktree that resolves to another task or to `/etc` is
   * refused instead of read.
   */
  private rootEscapeError(root: WorkspaceRoot, absolute: string): string | undefined {
    try { this.protection?.assert(absolute); this.protection?.assert(root.path); }
    catch { return "protected-application-path: 应用私有目录或其身份不可用于任务工具"; }
    // Drive/UNC task paths also support the existing injected Windows reader
    // contract. Slash-rooted POSIX tasks keep literal backslashes and case.
    const windowsPaths = process.platform === "win32" || /^[A-Za-z]:[\\/]/.test(this.taskDir) || this.taskDir.startsWith("\\\\");
    const rootReal = comparisonKey(this.readers.realPath(root.path), windowsPaths);
    const resolved = this.readers.realPath(absolute);
    const targetReal = comparisonKey(resolved, windowsPaths);
    if (targetReal === rootReal || targetReal.startsWith(`${rootReal}/`)) return undefined;
    // A path that does not exist cannot be realpath'ed (the reader returns the
    // input), so a merely-moved/deleted file would look "outside" a root whose
    // own real path differs only through a system symlink (e.g. /var on macOS).
    // Resolve the existing parent ONLY for a missing target: an existing link
    // that resolves outside was already refused above, and a missing final
    // component under the root is exactly what the send-time stat must report.
    let missing = false;
    try { missing = this.readers.statFile(absolute).kind === "missing"; } catch { missing = false; }
    const parent = dirname(absolute);
    if (missing && parent !== absolute) {
      const parentReal = comparisonKey(this.readers.realPath(parent), windowsPaths);
      if (parentReal === rootReal || parentReal.startsWith(`${rootReal}/`)) return undefined;
    }
    return `path-out-of-scope: ${root.label} 内的链接指向根之外（${resolved}），已拒绝读取`;
  }

  private resolve(input: { rootId: unknown; relative?: unknown }, allowRoot = true) {
    return resolveWorkspacePath({
      roots: this.roots(),
      taskId: this.taskId,
      taskDir: this.taskDir,
      rootId: input.rootId,
      relative: input.relative,
      allowRoot,
    });
  }

  private requireRecord(): TaskDiskRecord {
    this.protection?.assert(this.taskDir);
    const record = this.store.readTask(this.taskDir);
    if (!record) throw new Error(`task-unknown: 无法读取任务记录（${this.taskDir}）`);
    return record;
  }
}
