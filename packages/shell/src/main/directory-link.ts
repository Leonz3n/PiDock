import { symlinkSync } from "node:fs";
import { normalizeTaskPath } from "./task-provision.js";

export type DirectoryLinkKind = "symlink" | "junction";

/**
 * The platform and the raw symlink call are values rather than `process.platform`
 * and a direct `symlinkSync`, so the fallback decision is unit-testable on any
 * host — including an elevated Windows session where a real directory symlink
 * would otherwise always succeed and the fallback would never be exercised.
 */
export interface DirectoryLinkOps {
  platform: string;
  symlink(target: string, path: string, type: "dir" | "junction"): void;
}

export function nodeDirectoryLinkOps(): DirectoryLinkOps {
  return { platform: process.platform, symlink: (target, path, type) => symlinkSync(target, path, type) };
}

/**
 * Create the in-task link to a plain-directory source.
 *
 * Windows refuses a directory *symlink* without `SeCreateSymbolicLinkPrivilege`
 * (`EPERM`, measured on a de-privileged token) unless the machine has Developer
 * Mode on. A directory *junction* needs no privilege there and is a shared view
 * of the same directory, so it is the fallback. Every other error propagates
 * unchanged: `EACCES` is a parent-write denial where a junction retry fails too,
 * so falling back would only bury the real error behind a second failure, and
 * `EEXIST`/`ENOTDIR`/`ENOSPC` must surface verbatim as they do today.
 *
 * POSIX keeps the single `"dir"` attempt: the `type` argument is ignored there,
 * so the Windows-gated fallback is never reached off win32.
 */
export function createDirectoryLink(target: string, path: string, ops: DirectoryLinkOps = nodeDirectoryLinkOps()): DirectoryLinkKind {
  if (ops.platform !== "win32") {
    ops.symlink(target, path, "dir");
    return "symlink";
  }
  try {
    ops.symlink(target, path, "dir");
    return "symlink";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    ops.symlink(target, path, "junction");
    return "junction";
  }
}

/** The only extended-length spellings Windows can put in front of a drive path. */
const EXTENDED_PATH_PREFIXES = ["\\\\?\\", "\\??\\"] as const;

/**
 * Drop an extended-path prefix, but ONLY when a drive-absolute path follows.
 * `\\?\UNC\server\share` and a bare `\\?\` are left alone, so a UNC target can
 * never be folded into (or out of) a drive path by this function.
 */
function stripExtendedPathPrefix(value: string): string {
  for (const prefix of EXTENDED_PATH_PREFIXES) {
    if (!value.startsWith(prefix)) continue;
    const rest = value.slice(prefix.length);
    return /^[A-Za-z]:[\\/]/.test(rest) ? rest : value;
  }
  return value;
}

/**
 * The compare-side canonical form of a link target.
 *
 * Only Windows-shaped values (drive-absolute or UNC) go through
 * `normalizeTaskPath` (separator unification, drive-letter fold). A POSIX value
 * keeps its exact bytes apart from a stripped trailing separator, so a backslash
 * in a POSIX filename is never folded into a separator: this compare is the sole
 * guard that a recorded link is not retargeted, and it must not be loosened on
 * darwin/linux by a Windows-shaped normalisation.
 *
 * Deliberately NOT applied: path case below the drive letter, `realpath`, `..`
 * collapsing and 8.3 shortening. Windows per-directory case sensitivity is real,
 * and the compare is an identity check against the recorded source, not a "same
 * place" check.
 */
export function normalizeLinkTarget(value: string): string {
  const stripped = stripExtendedPathPrefix(value.trim()).replace(/[\\/]+$/, "");
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(stripped) ? normalizeTaskPath(stripped) : stripped;
}

/** True when `raw` is the recorded source path. Never "a path inside the task". */
export function linkTargetMatches(raw: string, expectedSourcePath: string): boolean {
  return normalizeLinkTarget(raw) === normalizeLinkTarget(expectedSourcePath);
}
