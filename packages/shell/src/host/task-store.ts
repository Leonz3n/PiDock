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

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PiSessionSnapshot } from "../main/pi-session.js";
import {
  EXECUTION_KINDS,
  EXECUTION_STATES,
  emptyExecutionLedger,
  type AttemptEndState,
  type ExecutionLedgerRecord,
  type ExecutionRecord,
  type StepState,
} from "../main/execution-ledger.js";
import { PI_USAGE_KINDS, type PiUsageCleanupScope, type PiUsageDetail, type PiUsageEndState, type PiUsageKind } from "../main/usage-ledger.js";
import {
  emptyScheduleRecord,
  type ScheduleDiskRecord,
  type ScheduledRunRecord,
  type StoredSchedule,
} from "../main/schedule-rules.js";

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
const LIFECYCLE_FILE = "lifecycle.json";
const EXECUTION_FILE = "execution.json";
const SCHEDULE_FILE = "schedules.json";

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

/**
 * Ledger keys a recorded cleanup removed. Absent in a ledger written before
 * #12 recorded them; such a record keeps its scope predicate (the Host does not
 * upgrade it), which is only reachable for a pre-#12 file.
 */
function parseRemovedIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new Error("invalid-payload: usage exclusion.removedIds must be an array of non-empty strings");
  }
  return [...(value as string[])];
}

function parseUsageExclusion(value: unknown): PiUsageCleanupScope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid-payload: usage exclusion must be an object");
  }
  const scope = value as Record<string, unknown>;
  const removedIds = parseRemovedIds(scope["removedIds"]);
  if (scope["kind"] === "all") return removedIds === undefined ? { kind: "all" } : { kind: "all", removedIds };
  if (scope["kind"] === "session") {
    if (typeof scope["sessionId"] !== "string" || scope["sessionId"].length === 0) {
      throw new Error("invalid-payload: usage exclusion.sessionId must be a non-empty string");
    }
    return removedIds === undefined
      ? { kind: "session", sessionId: scope["sessionId"] }
      : { kind: "session", sessionId: scope["sessionId"], removedIds };
  }
  if (scope["kind"] === "before") {
    if (typeof scope["before"] !== "string" || scope["before"].length === 0) {
      throw new Error("invalid-payload: usage exclusion.before must be a non-empty string");
    }
    return removedIds === undefined
      ? { kind: "before", before: scope["before"] }
      : { kind: "before", before: scope["before"], removedIds };
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

/**
 * Persisted lifecycle state ([PiDock 14] #17).
 *
 * `<taskDir>/lifecycle.json` keeps what must survive a restart: the archive
 * flag (archiving pauses scheduling; restoring never resumes it), who ran a
 * cleanup and what it kept/removed, and the per-item recovery entries a
 * partial cleanup leaves so the registration is not wiped to hide leftovers.
 */
export interface CleanupReceiptRecord {
  ranAt: string;
  /** Where the retained code copy / exports live; the receipt the user keeps. */
  keptPosition: string | null;
  exports: string[];
  removed: string[];
  partialFailure: boolean;
}

export interface LifecycleRecord {
  taskId: string;
  archived: boolean;
  archivedAt: string | null;
  restoredAt: string | null;
  /** Set by archiving; never cleared by restoring (scheduling stays paused). */
  schedulePaused: boolean;
  cleanup: CleanupReceiptRecord | null;
  recovery: { item: string; reason: string; at: string }[];
  /** True once a successful cleanup released the project association. */
  projectReleased: boolean;
  updatedAt: string;
}

export function buildLifecycleRecord(input: { taskId: string; now: string }): LifecycleRecord {
  return {
    taskId: input.taskId,
    archived: false,
    archivedAt: null,
    restoredAt: null,
    schedulePaused: false,
    cleanup: null,
    recovery: [],
    projectReleased: false,
    updatedAt: input.now,
  };
}

export function serializeLifecycleRecord(record: LifecycleRecord): string {
  return JSON.stringify(record, null, 2);
}

export function parseLifecycleRecord(raw: string): LifecycleRecord {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid-payload: lifecycle record must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record["taskId"] !== "string" || (record["taskId"] as string).length === 0) {
    throw new Error("invalid-payload: lifecycle record.taskId must be a non-empty string");
  }
  for (const key of ["archived", "schedulePaused", "projectReleased"] as const) {
    if (typeof record[key] !== "boolean") throw new Error(`invalid-payload: lifecycle record.${key} must be a boolean`);
  }
  for (const key of ["archivedAt", "restoredAt"] as const) {
    const value2 = record[key];
    if (value2 !== null && (typeof value2 !== "string" || value2.length === 0)) {
      throw new Error(`invalid-payload: lifecycle record.${key} must be null or a non-empty string`);
    }
  }
  if (typeof record["updatedAt"] !== "string" || (record["updatedAt"] as string).length === 0) {
    throw new Error("invalid-payload: lifecycle record.updatedAt must be a non-empty string");
  }
  const cleanup = record["cleanup"];
  if (cleanup !== null && cleanup !== undefined) {
    if (typeof cleanup !== "object" || Array.isArray(cleanup)) {
      throw new Error("invalid-payload: lifecycle record.cleanup must be an object or null");
    }
    const receipt = cleanup as Record<string, unknown>;
    if (typeof receipt["ranAt"] !== "string" || (receipt["ranAt"] as string).length === 0) {
      throw new Error("invalid-payload: lifecycle record.cleanup.ranAt must be a non-empty string");
    }
    if (receipt["keptPosition"] !== null && typeof receipt["keptPosition"] !== "string") {
      throw new Error("invalid-payload: lifecycle record.cleanup.keptPosition must be null or a string");
    }
    for (const key of ["exports", "removed"] as const) {
      if (!Array.isArray(receipt[key]) || (receipt[key] as unknown[]).some((item) => typeof item !== "string")) {
        throw new Error(`invalid-payload: lifecycle record.cleanup.${key} must be a string array`);
      }
    }
    if (typeof receipt["partialFailure"] !== "boolean") {
      throw new Error("invalid-payload: lifecycle record.cleanup.partialFailure must be a boolean");
    }
  }
  const recovery = record["recovery"];
  if (!Array.isArray(recovery)) throw new Error("invalid-payload: lifecycle record.recovery must be an array");
  for (const entry of recovery as unknown[]) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("invalid-payload: lifecycle record.recovery entries must be objects");
    }
    for (const key of ["item", "reason", "at"] as const) {
      const value2 = (entry as Record<string, unknown>)[key];
      if (typeof value2 !== "string" || value2.length === 0) {
        throw new Error(`invalid-payload: lifecycle record.recovery.${key} must be a non-empty string`);
      }
    }
  }
  return value as LifecycleRecord;
}

export function lifecycleFilePath(taskDir: string): string {
  return join(taskDir, LIFECYCLE_FILE);
}

export function writeLifecycleOnDisk(taskDir: string, record: LifecycleRecord): void {
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(lifecycleFilePath(taskDir), serializeLifecycleRecord({ ...record }), "utf8");
}

export function readLifecycleOnDisk(taskDir: string): LifecycleRecord | null {
  try {
    return parseLifecycleRecord(readFileSync(lifecycleFilePath(taskDir), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

/** Remove one session snapshot; used by cleanup (archiving never deletes). */
export function deleteSessionOnDisk(taskDir: string, sessionId: string): void {
  assertSafeFileName(sessionId, "sessionId");
  rmSync(sessionFilePath(taskDir, sessionId), { force: true });
}

/**
 * Persisted execution ledger ([PiDock 17] #19).
 *
 * `<taskDir>/execution.json` holds the execution/step/attempt/approval records
 * plus the attention read marks, so a reopen reports the same executions and
 * the same unread state instead of re-deriving them (and so a late approval
 * arrives spent, never as a fresh authorization). Every field is validated on
 * read: a corrupt ledger is refused rather than restored half-shaped.
 */
export function executionFilePath(taskDir: string): string {
  return join(taskDir, EXECUTION_FILE);
}

function parseExecutionStep(value: unknown): ExecutionRecord["steps"][number] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid-payload: execution step must be an object");
  }
  const step = value as Record<string, unknown>;
  for (const key of ["stepId", "label"] as const) {
    if (typeof step[key] !== "string" || (step[key] as string).length === 0) {
      throw new Error(`invalid-payload: execution step.${key} must be a non-empty string`);
    }
  }
  const state = step["state"];
  if (state !== "pending" && state !== "done" && state !== "failed" && state !== "skipped") {
    throw new Error("invalid-payload: execution step.state must be pending/done/failed/skipped");
  }
  if (step["at"] !== undefined && (typeof step["at"] !== "string" || (step["at"] as string).length === 0)) {
    throw new Error("invalid-payload: execution step.at must be a non-empty string");
  }
  return value as ExecutionRecord["steps"][number];
}

const ATTEMPT_END_STATES: readonly AttemptEndState[] = ["completed", "failed", "cancelled", "awaiting-approval", "unknown-external"];

function parseExecutionAttempt(value: unknown): ExecutionRecord["attempts"][number] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid-payload: execution attempt must be an object");
  }
  const attempt = value as Record<string, unknown>;
  if (typeof attempt["attemptId"] !== "string" || (attempt["attemptId"] as string).length === 0) {
    throw new Error("invalid-payload: execution attempt.attemptId must be a non-empty string");
  }
  if (typeof attempt["at"] !== "string" || (attempt["at"] as string).length === 0) {
    throw new Error("invalid-payload: execution attempt.at must be a non-empty string");
  }
  if (typeof attempt["endState"] !== "string" || !ATTEMPT_END_STATES.includes(attempt["endState"] as AttemptEndState)) {
    throw new Error(`invalid-payload: execution attempt.endState must be ${ATTEMPT_END_STATES.join("/")}`);
  }
  if (typeof attempt["replayable"] !== "boolean") {
    throw new Error("invalid-payload: execution attempt.replayable must be a boolean");
  }
  for (const key of ["usageId", "verifiedAt"] as const) {
    if (attempt[key] !== undefined && (typeof attempt[key] !== "string" || (attempt[key] as string).length === 0)) {
      throw new Error(`invalid-payload: execution attempt.${key} must be a non-empty string`);
    }
  }
  return value as ExecutionRecord["attempts"][number];
}

function parseExecutionApproval(value: unknown): NonNullable<ExecutionRecord["approval"]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid-payload: execution approval must be an object");
  }
  const approval = value as Record<string, unknown>;
  for (const key of ["approvalId", "payloadVersion", "requestedAt"] as const) {
    if (typeof approval[key] !== "string" || (approval[key] as string).length === 0) {
      throw new Error(`invalid-payload: execution approval.${key} must be a non-empty string`);
    }
  }
  const status = approval["status"];
  if (status !== "pending" && status !== "approved" && status !== "rejected" && status !== "expired") {
    throw new Error("invalid-payload: execution approval.status must be pending/approved/rejected/expired");
  }
  for (const key of ["expiresAt", "consumedAt"] as const) {
    if (approval[key] !== undefined && (typeof approval[key] !== "string" || (approval[key] as string).length === 0)) {
      throw new Error(`invalid-payload: execution approval.${key} must be a non-empty string`);
    }
  }
  return value as NonNullable<ExecutionRecord["approval"]>;
}

function parseExecutionRecord(value: unknown): ExecutionRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid-payload: execution record must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of ["executionId", "taskId", "sessionId", "label", "startedAt", "updatedAt"] as const) {
    if (typeof record[key] !== "string" || (record[key] as string).length === 0) {
      throw new Error(`invalid-payload: execution record.${key} must be a non-empty string`);
    }
  }
  if (record["projectId"] !== undefined && typeof record["projectId"] !== "string") {
    throw new Error("invalid-payload: execution record.projectId must be a string");
  }
  for (const key of ["kind", "state"] as const) {
    const known = key === "kind" ? (EXECUTION_KINDS as readonly string[]) : (EXECUTION_STATES as readonly string[]);
    if (typeof record[key] !== "string" || !known.includes(record[key] as string)) {
      throw new Error(`invalid-payload: execution record.${key} must be ${known.join("/")}`);
    }
  }
  if (typeof record["version"] !== "number" || !Number.isInteger(record["version"]) || (record["version"] as number) < 1) {
    throw new Error("invalid-payload: execution record.version must be a positive integer");
  }
  if (typeof record["draftKept"] !== "boolean") {
    throw new Error("invalid-payload: execution record.draftKept must be a boolean");
  }
  if (!Array.isArray(record["steps"])) throw new Error("invalid-payload: execution record.steps must be an array");
  for (const step of record["steps"] as unknown[]) parseExecutionStep(step);
  if (!Array.isArray(record["attempts"])) throw new Error("invalid-payload: execution record.attempts must be an array");
  for (const attempt of record["attempts"] as unknown[]) parseExecutionAttempt(attempt);
  if (record["approval"] !== undefined) parseExecutionApproval(record["approval"]);
  for (const key of ["failureReason", "callId"] as const) {
    if (record[key] !== undefined && (typeof record[key] !== "string" || (record[key] as string).length === 0)) {
      throw new Error(`invalid-payload: execution record.${key} must be a non-empty string`);
    }
  }
  // [PiDock 18] #20: a scheduled execution names its schedule + config version.
  if (record["scheduleId"] !== undefined && (typeof record["scheduleId"] !== "string" || (record["scheduleId"] as string).length === 0)) {
    throw new Error("invalid-payload: execution record.scheduleId must be a non-empty string");
  }
  if (
    record["scheduleConfigVersion"] !== undefined &&
    (typeof record["scheduleConfigVersion"] !== "number" ||
      !Number.isInteger(record["scheduleConfigVersion"]) ||
      (record["scheduleConfigVersion"] as number) < 1)
  ) {
    throw new Error("invalid-payload: execution record.scheduleConfigVersion must be a positive integer");
  }
  if (record["stoppedDerived"] !== undefined) {
    if (!Array.isArray(record["stoppedDerived"]) || (record["stoppedDerived"] as unknown[]).some((item) => typeof item !== "string")) {
      throw new Error("invalid-payload: execution record.stoppedDerived must be a string array");
    }
  }
  return value as ExecutionRecord;
}

export function serializeExecutionLedger(ledger: ExecutionLedgerRecord): string {
  return JSON.stringify(ledger, null, 2);
}

export function parseExecutionLedger(raw: string): ExecutionLedgerRecord {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid-payload: execution ledger must be an object");
  }
  const ledger = value as Record<string, unknown>;
  if (typeof ledger["version"] !== "number" || !Number.isInteger(ledger["version"]) || (ledger["version"] as number) < 1) {
    throw new Error("invalid-payload: execution ledger.version must be a positive integer");
  }
  const executions = ledger["executions"];
  if (!Array.isArray(executions)) throw new Error("invalid-payload: execution ledger.executions must be an array");
  const readItems = ledger["readItems"];
  if (!Array.isArray(readItems)) throw new Error("invalid-payload: execution ledger.readItems must be an array");
  for (const entry of readItems as unknown[]) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("invalid-payload: execution ledger.readItems entries must be objects");
    }
    for (const key of ["itemId", "readAt"] as const) {
      const item = (entry as Record<string, unknown>)[key];
      if (typeof item !== "string" || item.length === 0) {
        throw new Error(`invalid-payload: execution ledger.readItems.${key} must be a non-empty string`);
      }
    }
  }
  return {
    version: ledger["version"] as number,
    executions: (executions as unknown[]).map((record) => parseExecutionRecord(record)),
    readItems: readItems as ExecutionLedgerRecord["readItems"],
  };
}

export function writeExecutionLedgerOnDisk(taskDir: string, ledger: ExecutionLedgerRecord): void {
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(executionFilePath(taskDir), serializeExecutionLedger(ledger), "utf8");
}

/** Absent file = a task that never ran anything (empty ledger, not an error). */
export function readExecutionLedgerOnDisk(taskDir: string): ExecutionLedgerRecord {
  try {
    return parseExecutionLedger(readFileSync(executionFilePath(taskDir), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return emptyExecutionLedger();
    throw error;
  }
}

/** Step vocabulary, re-exported so the Host never re-spells it. */
export type { StepState };

export function scheduleFilePath(taskDir: string): string {
  return join(taskDir, SCHEDULE_FILE);
}

const SCHEDULE_PERMISSIONS = ["read", "default", "auto"] as const;
const RUN_TRIGGERS = ["due", "manual"] as const;
const RUN_RESULTS = ["completed", "skipped", "failed"] as const;

function requireString(record: Record<string, unknown>, key: string, label: string): void {
  if (typeof record[key] !== "string" || (record[key] as string).length === 0) {
    throw new Error(`invalid-payload: ${label}.${key} must be a non-empty string`);
  }
}

function parseStoredSchedule(value: unknown): StoredSchedule {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid-payload: schedule must be an object");
  }
  const schedule = value as Record<string, unknown>;
  for (const key of ["scheduleId", "taskId", "name", "ruleText", "timezone", "prompt", "providerId", "model", "lastEvaluatedAt", "createdAt", "updatedAt"] as const) {
    requireString(schedule, key, "schedule");
  }
  if (schedule["projectId"] !== undefined) requireString(schedule, "projectId", "schedule");
  if (
    typeof schedule["permission"] !== "string" ||
    !(SCHEDULE_PERMISSIONS as readonly string[]).includes(schedule["permission"] as string)
  ) {
    throw new Error("invalid-payload: schedule.permission must be read/default/auto");
  }
  if (typeof schedule["enabled"] !== "boolean") throw new Error("invalid-payload: schedule.enabled must be a boolean");
  if (typeof schedule["configVersion"] !== "number" || !Number.isInteger(schedule["configVersion"]) || (schedule["configVersion"] as number) < 1) {
    throw new Error("invalid-payload: schedule.configVersion must be a positive integer");
  }
  if (schedule["repairIssue"] !== undefined) requireString(schedule, "repairIssue", "schedule");
  return value as StoredSchedule;
}

function parseScheduledRun(value: unknown): ScheduledRunRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid-payload: scheduled run must be an object");
  }
  const run = value as Record<string, unknown>;
  for (const key of ["runId", "scheduleId", "taskId", "occurrenceKey", "scheduledAt", "startedAt", "providerId", "model", "ruleText"] as const) {
    requireString(run, key, "scheduled run");
  }
  for (const key of ["endedAt", "sessionId", "reason"] as const) {
    if (run[key] !== undefined) requireString(run, key, "scheduled run");
  }
  if (typeof run["configVersion"] !== "number" || !Number.isInteger(run["configVersion"]) || (run["configVersion"] as number) < 1) {
    throw new Error("invalid-payload: scheduled run.configVersion must be a positive integer");
  }
  if (typeof run["trigger"] !== "string" || !(RUN_TRIGGERS as readonly string[]).includes(run["trigger"] as string)) {
    throw new Error("invalid-payload: scheduled run.trigger must be due/manual");
  }
  if (typeof run["result"] !== "string" || !(RUN_RESULTS as readonly string[]).includes(run["result"] as string)) {
    throw new Error("invalid-payload: scheduled run.result must be completed/skipped/failed");
  }
  if (typeof run["permission"] !== "string" || !(SCHEDULE_PERMISSIONS as readonly string[]).includes(run["permission"] as string)) {
    throw new Error("invalid-payload: scheduled run.permission must be read/default/auto");
  }
  return value as ScheduledRunRecord;
}

export function serializeScheduleRecord(record: ScheduleDiskRecord): string {
  return JSON.stringify(record, null, 2);
}

/** Full shape validation on read: a corrupt schedule file must not half-restore. */
export function parseScheduleRecord(raw: string): ScheduleDiskRecord {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid-payload: schedule record must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record["version"] !== "number" || !Number.isInteger(record["version"]) || (record["version"] as number) < 1) {
    throw new Error("invalid-payload: schedule record.version must be a positive integer");
  }
  if (!Array.isArray(record["schedules"])) throw new Error("invalid-payload: schedule record.schedules must be an array");
  if (!Array.isArray(record["runs"])) throw new Error("invalid-payload: schedule record.runs must be an array");
  return {
    version: record["version"] as number,
    schedules: (record["schedules"] as unknown[]).map((schedule) => parseStoredSchedule(schedule)),
    runs: (record["runs"] as unknown[]).map((run) => parseScheduledRun(run)),
  };
}

export function writeScheduleRecordOnDisk(taskDir: string, record: ScheduleDiskRecord): void {
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(scheduleFilePath(taskDir), serializeScheduleRecord(record), "utf8");
}

/** Absent file = a task with no schedules yet (empty record, not an error). */
export function readScheduleRecordOnDisk(taskDir: string): ScheduleDiskRecord {
  try {
    return parseScheduleRecord(readFileSync(scheduleFilePath(taskDir), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return emptyScheduleRecord();
    throw error;
  }
}
