/**
 * Disk-backed task-id -> task-dir resolver for [PiDock 02] (#5).
 *
 * Production `PerTaskHostRegistry` (see `runtime.ts`) must resolve a
 * provisioned task's folder from its on-disk record — the renderer only
 * selects the task id, never a path. This module is the only production
 * resolver: `main.ts` injects `createDiskTaskDirResolver(defaultTasksRoot())`
 * so first-use of a provisioned task forks its bound Host instead of always
 * throwing `unknown task`. Unprovisioned ids still fail closed (`null`).
 *
 * Task ids are globally unique: at most one task folder per id under the
 * single tasks root. The resolver returns the first sorted match; the
 * registry revalidates every op and rejects a `task-moved` rebinding
 * instead of silently reusing a stale entry.
 *
 * Pure seams (`readdir`/`readTask` injectable) keep unit tests
 * Electron-free; only the defaults touch the filesystem.
 */

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readTaskRecordOnDisk, type TaskDiskRecord } from "../host/task-store.js";
import { isAbsoluteTaskRoot, normalizeTaskPath } from "./task-provision.js";

/** Expand a leading `~/` against the home directory for filesystem use. */
export function expandTaskRoot(root: string, home: string = homedir()): string {
  if (root.startsWith("~/")) return join(home, root.slice(2));
  return root;
}

/**
 * Machine-local tasks root. `PIDOCK_DEFAULT_ROOT` wins when it names an
 * absolute task root (same rule as provisioning); otherwise the renderer
 * default `~/PiDockTasks` expanded against the home directory applies.
 * The value only selects where task records are scanned — it never
 * migrates already-provisioned tasks.
 */
export function defaultTasksRoot(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const candidate = env["PIDOCK_DEFAULT_ROOT"];
  if (
    typeof candidate === "string" &&
    candidate.trim().length > 0 &&
    isAbsoluteTaskRoot(candidate.trim())
  ) {
    return expandTaskRoot(candidate.trim(), home);
  }
  return join(home, "PiDockTasks");
}

export interface DiskTaskDirResolverDeps {
  readdir: (dir: string) => string[];
  readTask: (taskDir: string) => TaskDiskRecord | null;
}

/**
 * Build the production resolver over one tasks root: scan its immediate
 * children for a `task.json` whose `taskId` matches and whose recorded
 * `taskDir` equals the scanned folder. Anything else (missing root,
 * unreadable/corrupt records, `taskDir` mismatch, non-absolute `taskDir`)
 * resolves to `null` so the caller fails closed with `unknown task`.
 *
 * Path equality uses `normalizeTaskPath` so POSIX/Windows spellings of the
 * same folder (`/`, `\`, drive-letter case, trailing separators) match.
 * The scan is a synchronous per-op directory read on the main thread
 * (O(children) reads); acceptable for S2 task counts, revisit with an
 * index/cache if task or session volume grows.
 */
export function createDiskTaskDirResolver(
  rootDir: string,
  deps?: Partial<DiskTaskDirResolverDeps>,
): (taskId: string) => string | null {
  const readdir = deps?.readdir ?? ((dir: string) => readdirSync(dir));
  const readTask = deps?.readTask ?? ((dir: string) => readTaskRecordOnDisk(dir));
  return (taskId: string) => {
    if (typeof taskId !== "string" || taskId.length === 0) return null;
    let entries: string[];
    try {
      entries = readdir(rootDir);
    } catch {
      return null;
    }
    for (const entry of [...entries].sort()) {
      if (entry.length === 0 || entry.startsWith(".")) continue;
      const candidate = join(rootDir, entry);
      let record: TaskDiskRecord | null;
      try {
        record = readTask(candidate);
      } catch {
        continue;
      }
      if (!record || record.taskId !== taskId) continue;
      if (!isAbsoluteTaskRoot(record.taskDir)) continue;
      if (normalizeTaskPath(record.taskDir) !== normalizeTaskPath(candidate)) continue;
      return candidate;
    }
    return null;
  };
}
