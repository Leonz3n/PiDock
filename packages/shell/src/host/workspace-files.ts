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
 * - Git runs with a fixed argv (`git diff --no-color [<base>] -- <path>`) in
 *   the root's cwd and never through a shell; the real terminal *spawn* stays
 *   a recorded residual, this is a bounded read-only diff read.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import {
  MAX_PREVIEW_CHARS,
  boundDiff,
  boundPreview,
  boundTreeEntries,
  deliveryTarget,
  findWorkspaceRoot,
  resolveWorkspacePath,
  workspaceAttribution,
  workspaceRoots,
  type WorkspaceAttribution,
  type WorkspaceDeliveryResult,
  type WorkspaceDiffResult,
  type WorkspacePreview,
  type WorkspaceRoot,
  type WorkspaceTree,
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
}

/** Read cap: a file bigger than this is refused rather than loaded. */
export const MAX_PREVIEW_BYTES = 1_000_000;

function stripTrailingSeparator(path: string): string {
  return path.replace(/[\\/]+$/, "") || "/";
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
    try {
      const stdout = execFileSync("git", [...args], { cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
      return { ok: true, stdout };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `git-failed: ${message}` };
    }
  },
  realPath(path) {
    try {
      return realpathSync(path);
    } catch {
      return path;
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
  ) {}

  /** Browsable roots of this task, derived from its record. */
  roots(): WorkspaceRoot[] {
    const record = this.requireRecord();
    return workspaceRoots({
      taskId: this.taskId,
      taskDir: this.taskDir,
      repos: record.repos,
      ...(record.repoSources ? { repoSources: record.repoSources } : {}),
      ...(record.dirLinks ? { dirLinks: record.dirLinks } : {}),
      branch: record.remoteBranch,
      baseCommit: record.baseCommit,
    });
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
    const rootReal = stripTrailingSeparator(this.readers.realPath(root.path));
    const targetReal = stripTrailingSeparator(this.readers.realPath(absolute));
    if (targetReal === rootReal || targetReal.startsWith(`${rootReal}/`)) return undefined;
    return `path-out-of-scope: ${root.label} 内的链接指向根之外（${targetReal}），已拒绝读取`;
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
    const record = this.store.readTask(this.taskDir);
    if (!record) throw new Error(`task-unknown: 无法读取任务记录（${this.taskDir}）`);
    return record;
  }
}
