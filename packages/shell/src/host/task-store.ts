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
import { PI_USAGE_KINDS, type PiUsageCleanupScope, type PiUsageDetail, type PiUsageEndState, type PiUsageKind } from "../main/usage-ledger.js";

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
const USAGE_FILE = "usage.json";

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

/**
 * Persisted usage ledger ([PiDock 12] #12).
 *
 * `<taskDir>/usage.json` holds the per-call details as their own artifact
 * (not a projection of the live sessions), so replaying a session, archiving
 * a conversation or restoring after a restart never inflates nor drops a call
 * and a cleanup scope can remove usage without touching the conversation.
 */
export function usageFilePath(taskDir: string): string {
  return join(taskDir, USAGE_FILE);
}

const USAGE_SOURCES = ["actual", "estimated", "unreported", "test-double", "approval"] as const;
const USAGE_END_STATES: readonly PiUsageEndState[] = ["completed", "failed", "cancelled", "awaiting-approval"];
const USAGE_COMPLETENESS = ["reported", "partial", "missing"] as const;

function parseUsageDetail(value: unknown): PiUsageDetail {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid-payload: usage detail must be an object");
  }
  const detail = value as Record<string, unknown>;
  for (const key of ["id", "taskId", "sessionId", "providerId", "providerVersion", "requestModel", "at"] as const) {
    if (typeof detail[key] !== "string" || (detail[key] as string).length === 0) {
      throw new Error(`invalid-payload: usage detail.${key} must be a non-empty string`);
    }
  }
  if (detail["projectId"] !== undefined && typeof detail["projectId"] !== "string") {
    throw new Error("invalid-payload: usage detail.projectId must be a string");
  }
  if (detail["responseModel"] !== undefined && typeof detail["responseModel"] !== "string") {
    throw new Error("invalid-payload: usage detail.responseModel must be a string");
  }
  if (typeof detail["kind"] !== "string" || !(PI_USAGE_KINDS as readonly string[]).includes(detail["kind"] as string)) {
    throw new Error(`invalid-payload: usage detail.kind must be ${PI_USAGE_KINDS.join("/")}`);
  }
  if (typeof detail["endState"] !== "string" || !(USAGE_END_STATES as readonly string[]).includes(detail["endState"] as string)) {
    throw new Error("invalid-payload: usage detail.endState must be completed/failed/cancelled/awaiting-approval");
  }
  const usage = detail["usage"];
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
    throw new Error("invalid-payload: usage detail.usage must be an object");
  }
  const counters = usage as Record<string, unknown>;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    if (typeof counters[key] !== "number" || !Number.isFinite(counters[key] as number) || (counters[key] as number) < 0) {
      throw new Error(`invalid-payload: usage detail.usage.${key} must be a non-negative number`);
    }
  }
  if (typeof counters["source"] !== "string" || !(USAGE_SOURCES as readonly string[]).includes(counters["source"] as string)) {
    throw new Error("invalid-payload: usage detail.usage.source must be a known source");
  }
  if (typeof counters["completeness"] !== "string" || !(USAGE_COMPLETENESS as readonly string[]).includes(counters["completeness"] as string)) {
    throw new Error("invalid-payload: usage detail.usage.completeness must be reported/partial/missing");
  }
  if (detail["origin"] !== undefined) {
    const origin = detail["origin"];
    if (typeof origin !== "object" || origin === null || Array.isArray(origin)) {
      throw new Error("invalid-payload: usage detail.origin must be an object");
    }
    for (const key of ["taskId", "sessionId", "callId"] as const) {
      const value2 = (origin as Record<string, unknown>)[key];
      if (typeof value2 !== "string" || value2.length === 0) {
        throw new Error(`invalid-payload: usage detail.origin.${key} must be a non-empty string`);
      }
    }
  }
  return value as PiUsageDetail;
}

export function serializeUsageLedger(details: readonly PiUsageDetail[], exclusions: readonly PiUsageCleanupScope[] = []): string {
  return JSON.stringify({ details, exclusions }, null, 2);
}

function parseUsageExclusion(value: unknown): PiUsageCleanupScope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid-payload: usage exclusion must be an object");
  }
  const scope = value as Record<string, unknown>;
  if (scope["kind"] === "all") return { kind: "all" };
  if (scope["kind"] === "session") {
    if (typeof scope["sessionId"] !== "string" || scope["sessionId"].length === 0) {
      throw new Error("invalid-payload: usage exclusion.sessionId must be a non-empty string");
    }
    return { kind: "session", sessionId: scope["sessionId"] };
  }
  if (scope["kind"] === "before") {
    if (typeof scope["before"] !== "string" || scope["before"].length === 0) {
      throw new Error("invalid-payload: usage exclusion.before must be a non-empty string");
    }
    return { kind: "before", before: scope["before"] };
  }
  throw new Error("invalid-payload: usage exclusion.kind must be all/session/before");
}

export function parseUsageLedger(raw: string): { details: PiUsageDetail[]; exclusions: PiUsageCleanupScope[] } {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid-payload: usage ledger must be an object");
  }
  const details = (value as Record<string, unknown>)["details"];
  if (!Array.isArray(details)) throw new Error("invalid-payload: usage ledger.details must be an array");
  const exclusions = (value as Record<string, unknown>)["exclusions"];
  if (exclusions !== undefined && !Array.isArray(exclusions)) {
    throw new Error("invalid-payload: usage ledger.exclusions must be an array");
  }
  return {
    details: details.map((detail) => parseUsageDetail(detail)),
    exclusions: (exclusions ?? []).map((scope) => parseUsageExclusion(scope)),
  };
}

export function writeUsageOnDisk(taskDir: string, details: readonly PiUsageDetail[], exclusions: readonly PiUsageCleanupScope[] = []): void {
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(usageFilePath(taskDir), serializeUsageLedger(details, exclusions), "utf8");
}

export function readUsageOnDisk(taskDir: string): { details: PiUsageDetail[]; exclusions: PiUsageCleanupScope[] } {
  try {
    return parseUsageLedger(readFileSync(usageFilePath(taskDir), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { details: [], exclusions: [] };
    throw error;
  }
}

/** Kind guard shared by the Host's usage ops. */
export function isUsageKindName(value: unknown): value is PiUsageKind {
  return typeof value === "string" && (PI_USAGE_KINDS as readonly string[]).includes(value);
}
