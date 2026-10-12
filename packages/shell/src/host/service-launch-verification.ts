/**
 * Durable per-platform launch verification for [PiDock 04] (#7 box 7).
 *
 * The box asks for the desktop launch to use an explicit program + argv (no
 * Unix-only inline env assignment) AND for each platform's actual verification
 * to be RECORDED. The launch half is audited done (`TaskServiceProcesses`
 * spawns `program, argv` with `shell: false`; `validateServiceDescriptor`
 * refuses `NAME=-shaped programs` and shell metacharacters). The recording half
 * had no production writer and no reader: `TaskServiceRuntime` could hold
 * `launchVerifications` and `recordPlatformLaunch` could build one, but only
 * tests ever called them, so no runtime path and no user could reach the fact.
 *
 * This module is the persistence seam for that fact. It deliberately records
 * OBSERVATIONS, not intentions: an entry exists only because the Host's own
 * process driver confirmed a real child started (`startedAt`) or really stopped
 * (`stopped`). Consequence, stated because it is the point of the slice: a
 * platform with no entry, an entry with no observation, or an unreadable
 * document all read as NOT verified — never as a pass.
 *
 * Scope: one document per task workspace
 * (`<taskDir>/service-launch-verification.json`), shaped and written like its
 * sibling `service-ownership.json` (strict parse, exclusive temp file + fsync +
 * rename). Each entry carries the machine's own platform label, so the record
 * is per task + service + platform and never claims a platform it did not run.
 */

import {
  emptyLaunchVerificationDiskRecord,
  readLaunchVerificationOnDisk,
  writeLaunchVerificationOnDisk,
  type LaunchVerificationEntry,
} from "./task-store.js";

/**
 * Where one task's launch verifications live. Injectable so the runtime is
 * unit-testable without the filesystem and so a failing store can be exercised;
 * `undefined` keeps the record in memory only (no durability, stated).
 */
export interface LaunchVerificationLog {
  /**
   * Every recorded verification of this task. An absent or unreadable document
   * reads as NONE (never as verified): a broken file must fail closed, because
   * the surface would otherwise show a pass nobody can evidence.
   */
  read(): LaunchVerificationEntry[];
  /**
   * Atomically upsert one verification, keeping every other entry (the caller
   * may hold only the services it has registered). Throws when the document
   * cannot be written, so the caller can refuse to show a verification that was
   * not persisted.
   */
  record(entry: LaunchVerificationEntry): void;
}

/** In-memory log: the pre-existing behaviour, and the default when nothing is injected. */
export function memoryLaunchVerificationLog(initial: readonly LaunchVerificationEntry[] = []): LaunchVerificationLog {
  const entries = initial.map((entry) => ({ ...entry, args: [...entry.args] }));
  return {
    read: () => entries.map((entry) => ({ ...entry, args: [...entry.args] })),
    record: (entry) => {
      const at = entries.findIndex((row) => row.serviceId === entry.serviceId && row.platform === entry.platform);
      const copy = { ...entry, args: [...entry.args] };
      if (at < 0) entries.push(copy);
      else entries[at] = copy;
    },
  };
}

/**
 * The task workspace's own document, written atomically. A write against an
 * unreadable document is refused (the previous file may hold the only evidence
 * of an earlier launch), which leaves the new launch unverified in the surface
 * instead of erasing what was there.
 */
export function diskLaunchVerificationLog(taskDir: string): LaunchVerificationLog {
  return {
    read: () => {
      try {
        return readLaunchVerificationOnDisk(taskDir).entries;
      } catch {
        return [];
      }
    },
    record: (entry) => {
      const current = readLaunchVerificationOnDisk(taskDir);
      const entries = current.entries.filter((row) => !(row.serviceId === entry.serviceId && row.platform === entry.platform));
      entries.push({ ...entry, args: [...entry.args] });
      writeLaunchVerificationOnDisk(taskDir, { ...emptyLaunchVerificationDiskRecord(), entries });
    },
  };
}
