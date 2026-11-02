/**
 * Main's observation of a task's persistent browser partition ([PiDock 14]
 * #17 box 6, [#117 第 5 项]).
 *
 * The partition is created and owned by main (`session.fromPartition`), so the
 * Host cannot read it: the honest split is that main reports what it sees and
 * the Host only writes down that report. There is exactly one fact main can
 * establish — whether a persistent partition directory exists for this task —
 * because page identity is not stored anywhere main can enumerate after a
 * restart. This module therefore never invents a page list.
 *
 * Tri-state on purpose: `true`/`false` are observations, `null` means main
 * could not read the partition path at all (an Electron without
 * `getStoragePath`, a thrown call), which is NOT the same as "nothing
 * retained" and must not be reported as one.
 */

import { existsSync } from "node:fs";
import { session } from "electron";
import { taskPartitionName } from "./task-partition.js";
import type { TaskBrowserObservation } from "./task-lifecycle.js";

export interface TaskBrowserObservationDeps {
  /** Storage path for an Electron partition name, or `null` when unreadable. */
  readonly storagePathFor: (partition: string) => string | null;
  readonly exists: (path: string) => boolean;
}

const ELECTRON_DEPS: TaskBrowserObservationDeps = {
  storagePathFor: (partition) => {
    const target = session.fromPartition(partition) as unknown as {
      getStoragePath?: () => string | null;
    };
    if (typeof target.getStoragePath !== "function") return null;
    const path = target.getStoragePath();
    return typeof path === "string" && path.length > 0 ? path : null;
  },
  exists: (path) => existsSync(path),
};

/**
 * Observe this task's persistent partition. Never throws on a read failure:
 * an unreadable partition path is reported as `null`, so the cleanup preview
 * says "not observed" instead of showing zero pages.
 */
export function observeTaskBrowserState(
  input: { workspaceId: string; taskId: string },
  deps: TaskBrowserObservationDeps = ELECTRON_DEPS,
): TaskBrowserObservation {
  if (input.taskId.trim().length === 0) {
    throw new Error("invalid-browser-observation: taskId must be a non-empty string");
  }
  let path: string | null;
  try {
    path = deps.storagePathFor(taskPartitionName(input.taskId, input.workspaceId));
  } catch {
    return { retained: null };
  }
  if (path === null) return { retained: null };
  try {
    return { retained: deps.exists(path) };
  } catch {
    return { retained: null };
  }
}

/** Ops whose answer depends on browser retention; main stamps them itself. */
export const BROWSER_OBSERVATION_OPS: readonly string[] = [
  "task/archive",
  "task/cleanupPreview",
  "task/runCleanup",
];
