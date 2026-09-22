/**
 * Disk persistence for [PiDock 02] (#5), S2 slice.
 *
 * Tasks and sessions persist as JSON under the task folder so reopening a
 * task restores the designated session (never another task's latest):
 *
 *   <taskDir>/task.json
 *   <taskDir>/sessions/<sessionId>.json   (PiSessionSnapshot)
 *
 * The store is transport-free: paths are validated with the same
 * single-component rule as provisioning, and expired/settled states are
 * applied on read (pending approvals never auto-replay, `createdAt` is
 * preserved by the snapshot itself). fs access lives only in the small
 * `*OnDisk` wrappers so the record-shape logic stays unit-testable without
 * touching the filesystem.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PiSessionSnapshot } from "../main/pi-session.js";

export interface RepoSourceRecord {
  /** In-task folder name (single safe component). */
  repoDir: string;
  /** Remote fetched for this repo (e.g. `origin`, `upstream`). */
  remote: string;
  /** Baseline branch on that remote (e.g. `main`, `release/v2`). */
  remoteBranch: string;
  /** Pinned full commit fixed at fetch time (never a stale ref). */
  baseCommit: string;
}

export interface PlainDirLinkRecord {
  /** Stable in-task link name (`dir-` + 8 chars, ASCII only). */
  linkName: string;
  /** Identity of the linked entry (project directory id). */
  directoryId: string;
  /** Absolute original target captured at link time. */
  sourcePath: string;
  /** ISO time the snapshot was taken. */
  snapshotAt: string;
}

export interface TaskDiskRecord {
  taskId: string;
  name: string;
  dirId: string;
  branch: string;
  root: string;
  taskDir: string;
  remoteBranch: string;
  baseCommit: string;
  repos: string[];
  /**
   * Per-repo sources for [PiDock 03] (#6). Absent on pre-#6 records
   * (single-repo shape); present once a #6 provision/append writes them.
   * The single-repo `remoteBranch`/`baseCommit` above stay as the task's
   * primary baseline for backward compatibility.
   */
  repoSources?: RepoSourceRecord[];
  /**
   * Plain-directory link snapshots for [PiDock 03] (#6). Each entry is a
   * shared view of its original target, NOT an independent copy: writes
   * through the link modify the original. Absent on pre-#6 records.
   */
  dirLinks?: PlainDirLinkRecord[];
  createdAt: string;
  updatedAt: string;
}

const SESSIONS_DIR = "sessions";

function assertSafeFileName(name: string, label: string): void {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.trim() !== name
  ) {
    throw new Error(`invalid-path: ${label} must be a single safe component: ${name}`);
  }
}

export function taskFilePath(taskDir: string): string {
  return join(taskDir, "task.json");
}

export function sessionFilePath(taskDir: string, sessionId: string): string {
  assertSafeFileName(sessionId, "sessionId");
  return join(taskDir, SESSIONS_DIR, `${sessionId}.json`);
}

export function buildTaskDiskRecord(input: {
  taskId: string;
  name: string;
  dirId: string;
  branch: string;
  root: string;
  taskDir: string;
  remoteBranch: string;
  baseCommit: string;
  repos: readonly string[];
  repoSources?: RepoSourceRecord[];
  dirLinks?: PlainDirLinkRecord[];
  now: string;
}): TaskDiskRecord {
  const record: TaskDiskRecord = {
    taskId: input.taskId,
    name: input.name,
    dirId: input.dirId,
    branch: input.branch,
    root: input.root,
    taskDir: input.taskDir,
    remoteBranch: input.remoteBranch,
    baseCommit: input.baseCommit,
    repos: [...input.repos],
    createdAt: input.now,
    updatedAt: input.now,
  };
  if (input.repoSources !== undefined) record.repoSources = input.repoSources.map((source) => ({ ...source }));
  if (input.dirLinks !== undefined) record.dirLinks = input.dirLinks.map((link) => ({ ...link }));
  return record;
}

export function serializeTaskRecord(record: TaskDiskRecord): string {
  return JSON.stringify(record, null, 2);
}

export function parseTaskRecord(raw: string): TaskDiskRecord {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid-payload: task record must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of ["taskId", "name", "dirId", "branch", "root", "taskDir", "remoteBranch", "baseCommit"] as const) {
    if (typeof record[key] !== "string" || (record[key] as string).length === 0) {
      throw new Error(`invalid-payload: task record.${key} must be a non-empty string`);
    }
  }
  if (!Array.isArray(record["repos"]) || !(record["repos"] as unknown[]).every((item) => typeof item === "string")) {
    throw new Error("invalid-payload: task record.repos must be a string array");
  }
  // #6 per-repo sources: optional for pre-#6 records, fully validated
  // when present (each source names its own remote + pinned commit).
  if (record["repoSources"] !== undefined) {
    if (!Array.isArray(record["repoSources"])) {
      throw new Error("invalid-payload: task record.repoSources must be an array");
    }
    for (const source of record["repoSources"] as unknown[]) {
      if (typeof source !== "object" || source === null || Array.isArray(source)) {
        throw new Error("invalid-payload: task record.repoSources entries must be objects");
      }
      const entry = source as Record<string, unknown>;
      for (const key of ["repoDir", "remote", "remoteBranch", "baseCommit"] as const) {
        if (typeof entry[key] !== "string" || (entry[key] as string).length === 0) {
          throw new Error(`invalid-payload: task record.repoSources.${key} must be a non-empty string`);
        }
      }
    }
  }
  // #6 plain-dir link snapshots: optional for pre-#6 records, shape-checked
  // when present. Link targets are shared originals (not copies).
  if (record["dirLinks"] !== undefined) {
    if (!Array.isArray(record["dirLinks"])) {
      throw new Error("invalid-payload: task record.dirLinks must be an array");
    }
    for (const link of record["dirLinks"] as unknown[]) {
      if (typeof link !== "object" || link === null || Array.isArray(link)) {
        throw new Error("invalid-payload: task record.dirLinks entries must be objects");
      }
      const entry = link as Record<string, unknown>;
      for (const key of ["linkName", "directoryId", "sourcePath", "snapshotAt"] as const) {
        if (typeof entry[key] !== "string" || (entry[key] as string).length === 0) {
          throw new Error(`invalid-payload: task record.dirLinks.${key} must be a non-empty string`);
        }
      }
    }
  }
  // Timestamps are required: a corrupt/partial record must not restore
  // with `createdAt/updatedAt` silently `undefined`.
  for (const key of ["createdAt", "updatedAt"] as const) {
    if (typeof record[key] !== "string" || (record[key] as string).length === 0) {
      throw new Error(`invalid-payload: task record.${key} must be a non-empty string`);
    }
  }
  return value as TaskDiskRecord;
}

export function serializeSessionSnapshot(snapshot: PiSessionSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

const SESSION_PERMISSIONS = ["read", "default", "auto"] as const;
const SESSION_RUN_STATES = ["idle", "running", "approval", "done", "cancelled", "failed"] as const;

export function parseSessionSnapshot(raw: string): PiSessionSnapshot {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid-payload: session snapshot must be an object");
  }
  const snapshot = value as Record<string, unknown>;
  for (const key of ["taskId", "sessionId"] as const) {
    if (typeof snapshot[key] !== "string" || (snapshot[key] as string).length === 0) {
      throw new Error(`invalid-payload: session snapshot.${key} must be a non-empty string`);
    }
  }
  if (!Array.isArray(snapshot["messages"]) || !Array.isArray(snapshot["calls"])) {
    throw new Error("invalid-payload: session snapshot.messages/calls must be arrays");
  }
  // Required session envelope: without these a corrupt snapshot would
  // restore with `createdAt: undefined` or an unknown permission/state.
  if (!Array.isArray(snapshot["approvals"])) {
    throw new Error("invalid-payload: session snapshot.approvals must be an array");
  }
  if (
    typeof snapshot["permission"] !== "string" ||
    !(SESSION_PERMISSIONS as readonly string[]).includes(snapshot["permission"] as string)
  ) {
    throw new Error("invalid-payload: session snapshot.permission must be read/default/auto");
  }
  if (
    typeof snapshot["runState"] !== "string" ||
    !(SESSION_RUN_STATES as readonly string[]).includes(snapshot["runState"] as string)
  ) {
    throw new Error("invalid-payload: session snapshot.runState must be a known state");
  }
  for (const key of ["providerId", "model", "createdAt", "updatedAt"] as const) {
    if (typeof snapshot[key] !== "string" || (snapshot[key] as string).length === 0) {
      throw new Error(`invalid-payload: session snapshot.${key} must be a non-empty string`);
    }
  }
  // credentialRef is reference-only (never a secret): optional on disk,
  // non-empty when present so a corrupt snapshot cannot restore a blank ref.
  if (snapshot["credentialRef"] !== undefined) {
    if (typeof snapshot["credentialRef"] !== "string" || (snapshot["credentialRef"] as string).trim().length === 0) {
      throw new Error("invalid-payload: session snapshot.credentialRef must be a non-empty reference");
    }
  }
  // Draft-tolerant persistence: an absent draft is fine (empty composer);
  // a present draft must be an object with string text so a corrupt
  // snapshot cannot restore a half-shaped draft. Structured refs/skill
  // sources ride as unknown fields and are never interpreted here.
  if (snapshot["draft"] !== undefined) {
    const draft = snapshot["draft"];
    if (typeof draft !== "object" || draft === null || Array.isArray(draft)) {
      throw new Error("invalid-payload: session snapshot.draft must be an object");
    }
    if (typeof (draft as Record<string, unknown>)["text"] !== "string") {
      throw new Error("invalid-payload: session snapshot.draft.text must be a string");
    }
  }
  return value as PiSessionSnapshot;
}

export function writeTaskRecordOnDisk(taskDir: string, record: TaskDiskRecord): void {
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(taskFilePath(taskDir), serializeTaskRecord({ ...record }), "utf8");
}

export function readTaskRecordOnDisk(taskDir: string): TaskDiskRecord | null {
  try {
    return parseTaskRecord(readFileSync(taskFilePath(taskDir), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

export function writeSessionSnapshotOnDisk(taskDir: string, snapshot: PiSessionSnapshot): void {
  assertSafeFileName(snapshot.sessionId, "sessionId");
  mkdirSync(join(taskDir, SESSIONS_DIR), { recursive: true });
  writeFileSync(sessionFilePath(taskDir, snapshot.sessionId), serializeSessionSnapshot(snapshot), "utf8");
}

export function readSessionSnapshotOnDisk(taskDir: string, sessionId: string): PiSessionSnapshot | null {
  try {
    return parseSessionSnapshot(readFileSync(sessionFilePath(taskDir, sessionId), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

/** Session ids persisted under the task folder (safe file stems only). */
export function listSessionIdsOnDisk(taskDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(taskDir, SESSIONS_DIR));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.slice(0, -".json".length))
    .filter((stem) => {
      try {
        assertSafeFileName(stem, "sessionId");
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}
