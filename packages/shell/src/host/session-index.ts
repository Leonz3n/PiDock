/**
 * Task-wide session index ([Pencil T04] #139).
 *
 * One task owns **one working directory** but may hold several real sessions.
 * Before this file the task folder had no session identity at all: the SDK
 * kernel already keys every session directory/JSONL by `sessionId`
 * (`sdk-text-kernel.ts`), but nothing on disk said which sessions exist, what
 * they are called, which one is active, or which model each one is bound to.
 *
 * The Host owns that identity in one sidecar next to `task.json`:
 *
 *   <taskDir>/.pidock-sessions.json
 *
 * It is written atomically (temp file + fsync + rename + directory fsync), read
 * with an exact-shape validator, and it never guesses: an unknown key, a
 * duplicate id, a dangling `activeSessionId` or a corrupt file fails BY NAME
 * instead of silently starting over (which would lose the user's session list).
 * The first read of a task that has no sidecar migrates the historical `main`
 * session (plus any other legacy `sessions/*.json` snapshot) into it, so an
 * existing task keeps its conversation reachable.
 *
 * The sidecar carries only user-visible identity and the model binding; every
 * transcript, turn journal and binding file stays where its owner already
 * keeps it (`sessions/<id>.json`, `.pidock-sdk-sessions/<id>/`,
 * `.pidock-sdk-turns/<id>/`).
 */

import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { listSessionIdsOnDisk } from "./task-store.js";

export const SESSION_INDEX_FILE = ".pidock-sessions.json";
/** Historical id of the one session shipped before this ticket. */
export const LEGACY_SESSION_ID = "main";
export const SESSION_INDEX_VERSION = 1;
export const MAX_SESSION_INDEX_BYTES = 64 * 1024;
export const MAX_SESSIONS = 50;
export const MAX_SESSION_NAME = 40;

export const SESSION_PERMISSIONS = ["read", "default", "auto"] as const;
export type SessionPermission = (typeof SESSION_PERMISSIONS)[number];
export const SESSION_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type SessionThinkingLevel = (typeof SESSION_THINKING_LEVELS)[number];

/** The model a session is bound to. Its identity, not a task-wide default. */
export interface SessionBinding {
  profileId: string;
  modelId: string;
  /** `null` = the model declares no reasoning levels (never a fabricated `off`). */
  thinkingLevel: SessionThinkingLevel | null;
  /** Provider configuration generation the binding was made against. */
  generation: number;
}

export interface TaskSessionRecord {
  /** `main` for the migrated session, otherwise `s-<8 hex>`. */
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  permission: SessionPermission;
  /** `null` until a Provider model is bound to this session. */
  binding: SessionBinding | null;
}

export interface SessionIndex {
  version: 1;
  /** `null` when every session is archived (or none exists): never invented. */
  activeSessionId: string | null;
  sessions: TaskSessionRecord[];
}

const SESSION_ID = /^(?:main|s-[0-9a-f]{8})$/;
const PROFILE_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const MODEL_ID = /^[a-zA-Z0-9._:/-]{1,100}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const INDEX_KEYS = ["activeSessionId", "sessions", "version"] as const;
const SESSION_KEYS = ["archived", "binding", "createdAt", "id", "name", "permission", "updatedAt"] as const;
const BINDING_KEYS = ["generation", "modelId", "profileId", "thinkingLevel"] as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], error: string): void {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new Error(error);
}

function iso(value: unknown, error: string): string {
  if (typeof value !== "string" || !ISO.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(error);
  return value;
}

/** A session name is user text: trimmed, single-line, bounded, never empty. */
export function normalizeSessionName(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid-session-name");
  const name = value.trim();
  if (name.length === 0) throw new Error("invalid-session-name");
  if (name.length > MAX_SESSION_NAME) throw new Error("invalid-session-name");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error("invalid-session-name");
  return name;
}

function bindingOf(value: unknown): SessionBinding | null {
  if (value === null) return null;
  if (!record(value)) throw new Error("invalid-session-binding");
  exactKeys(value, BINDING_KEYS, "invalid-session-binding");
  const profileId = value["profileId"];
  const modelId = value["modelId"];
  const generation = value["generation"];
  const thinkingLevel = value["thinkingLevel"];
  if (typeof profileId !== "string" || !PROFILE_ID.test(profileId)) throw new Error("invalid-session-binding");
  if (typeof modelId !== "string" || !MODEL_ID.test(modelId)) throw new Error("invalid-session-binding");
  if (!Number.isSafeInteger(generation) || (generation as number) < 0) throw new Error("invalid-session-binding");
  if (thinkingLevel !== null && (typeof thinkingLevel !== "string" || !(SESSION_THINKING_LEVELS as readonly string[]).includes(thinkingLevel))) {
    throw new Error("invalid-session-binding");
  }
  return { profileId, modelId, thinkingLevel: thinkingLevel as SessionThinkingLevel | null, generation: generation as number };
}

export function validateSessionIndex(value: unknown): SessionIndex {
  if (!record(value)) throw new Error("invalid-session-index");
  exactKeys(value, INDEX_KEYS, "invalid-session-index");
  if (value["version"] !== SESSION_INDEX_VERSION) throw new Error("invalid-session-index: unsupported version");
  const rawSessions = value["sessions"];
  if (!Array.isArray(rawSessions) || rawSessions.length > MAX_SESSIONS) throw new Error("invalid-session-index: sessions");
  const sessions: TaskSessionRecord[] = [];
  const seen = new Set<string>();
  for (const entry of rawSessions) {
    if (!record(entry)) throw new Error("invalid-session-index: session is not an object");
    exactKeys(entry, SESSION_KEYS, "invalid-session-index: session keys");
    const id = entry["id"];
    if (typeof id !== "string" || !SESSION_ID.test(id)) throw new Error("invalid-session-index: session id");
    if (seen.has(id)) throw new Error("invalid-session-index: duplicate session id");
    seen.add(id);
    const ability = entry["permission"];
    if (typeof ability !== "string" || !(SESSION_PERMISSIONS as readonly string[]).includes(ability)) {
      throw new Error("invalid-session-index: session permission");
    }
    if (typeof entry["archived"] !== "boolean") throw new Error("invalid-session-index: session archived");
    sessions.push({
      id,
      name: normalizeSessionName(entry["name"]),
      createdAt: iso(entry["createdAt"], "invalid-session-index: session createdAt"),
      updatedAt: iso(entry["updatedAt"], "invalid-session-index: session updatedAt"),
      archived: entry["archived"],
      permission: ability as SessionPermission,
      binding: bindingOf(entry["binding"]),
    });
  }
  const active = value["activeSessionId"];
  if (active !== null && typeof active !== "string") throw new Error("invalid-session-index: activeSessionId");
  if (typeof active === "string") {
    const target = sessions.find((session) => session.id === active);
    // A pointer to a session that does not exist (or is archived) is a corrupt
    // index, not a hint: reopening must never land in a session the user
    // archived.
    if (!target) throw new Error("invalid-session-index: activeSessionId names no session");
    if (target.archived) throw new Error("invalid-session-index: activeSessionId names an archived session");
  }
  return { version: SESSION_INDEX_VERSION, activeSessionId: active as string | null, sessions };
}

/** `main` first (it is the session that existed before this index), then the rest in creation order. */
function ordered(sessions: TaskSessionRecord[]): TaskSessionRecord[] {
  const main = sessions.filter((session) => session.id === LEGACY_SESSION_ID);
  const rest = sessions
    .filter((session) => session.id !== LEGACY_SESSION_ID)
    .sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt)));
  return [...main, ...rest];
}

/**
 * The index a task starts with: the historical `main` session (and any other
 * legacy snapshot the task folder already held) becomes the first session, so
 * migration never strands an existing conversation. No session is invented when
 * the folder has none: `sessions: []` / `activeSessionId: null` is the honest
 * "this task has no session yet" state and the user creates one explicitly.
 */
export function migrateSessionIndex(taskDir: string, now: string): SessionIndex {
  const legacy = listSessionIdsOnDisk(taskDir).filter((id) => SESSION_ID.test(id)).sort();
  // `main` is the session every task had before this index existed, so it is
  // always the first record; any other legacy snapshot the folder still holds
  // follows it instead of being stranded.
  const ids = [LEGACY_SESSION_ID, ...legacy.filter((id) => id !== LEGACY_SESSION_ID)];
  const sessions: TaskSessionRecord[] = ids.map((id) => ({
    id,
    name: id,
    createdAt: now,
    updatedAt: now,
    archived: false,
    permission: "default",
    binding: null,
  }));
  return { version: SESSION_INDEX_VERSION, activeSessionId: sessions[0]?.id ?? null, sessions };
}

/** Reads the sidecar, migrating a task that has none. Never guesses on corruption. */
export function readSessionIndex(taskDir: string, now = new Date().toISOString()): SessionIndex {
  const file = join(taskDir, SESSION_INDEX_FILE);
  let raw: string;
  try {
    if (!lstatSync(file).isFile()) throw new Error("invalid-session-index: not a file");
    if (lstatSync(file).size > MAX_SESSION_INDEX_BYTES) throw new Error("invalid-session-index: too large");
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return migrateSessionIndex(taskDir, now);
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("invalid-session-index: unreadable JSON"); }
  return validateSessionIndex(value);
}

/** Atomic, fsynced replacement: a crash leaves the previous index, never half a file. */
export function writeSessionIndex(taskDir: string, index: SessionIndex): SessionIndex {
  const validated = validateSessionIndex(index);
  if (!lstatSync(taskDir).isDirectory()) throw new Error("invalid-session-index: task directory");
  const file = join(taskDir, SESSION_INDEX_FILE);
  if (Buffer.byteLength(JSON.stringify(validated), "utf8") > MAX_SESSION_INDEX_BYTES) throw new Error("invalid-session-index: too large");
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(validated, null, 2), "utf8"); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(tmp, file);
    // One of the same-shaped win32 skips as `task-store.ts` (see the comment
    // there): Windows has no reachable directory fsync from Node.
    if (process.platform !== "win32") {
      const dir = openSync(taskDir, "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
    }
  } finally { rmSync(tmp, { force: true }); }
  return validated;
}

function touch(session: TaskSessionRecord, now: string): TaskSessionRecord {
  return { ...session, updatedAt: now };
}

/** The next real session after `id`: newest non-archived first, never a new one. */
function nextReal(sessions: TaskSessionRecord[], id: string): string | null {
  const candidates = sessions
    .filter((session) => session.id !== id && !session.archived)
    .sort((a, b) => (a.updatedAt === b.updatedAt ? a.id.localeCompare(b.id) : b.updatedAt.localeCompare(a.updatedAt)));
  return candidates[0]?.id ?? null;
}

/** A deterministic, collision-free new session id (`s-<8 hex>`). */
export function newSessionId(taken: readonly string[], random = randomUUID): string {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const id = `s-${random().replaceAll("-", "").slice(0, 8).toLowerCase()}`;
    if (SESSION_ID.test(id) && !taken.includes(id)) return id;
  }
  throw new Error("session-id-unavailable");
}

/** `新会话`, `新会话 2`, … so two new sessions in a row are distinguishable. */
export function newSessionName(taken: readonly string[]): string {
  for (let index = 1; index <= MAX_SESSIONS; index += 1) {
    const name = index === 1 ? "新会话" : `新会话 ${index}`;
    if (!taken.includes(name)) return name;
  }
  throw new Error("invalid-session-name");
}

export interface CreateSessionInput {
  name?: string;
  permission?: SessionPermission;
  /** The Provider/profile the task is configured with, when any. */
  binding?: SessionBinding | null;
  now: string;
}

/**
 * Create one session with its own identity and a fresh SDK context. It becomes
 * the active session (S08's "在当前独立工作区开启新会话" enters the new one),
 * and it never inherits another session's transcript.
 */
export function createSessionInIndex(index: SessionIndex, input: CreateSessionInput, random = randomUUID): { index: SessionIndex; session: TaskSessionRecord } {
  const sessions = ordered(index.sessions);
  if (sessions.length >= MAX_SESSIONS) throw new Error("session-limit-reached");
  const id = newSessionId(sessions.map((session) => session.id), random);
  const session: TaskSessionRecord = {
    id,
    name: normalizeSessionName(input.name ?? newSessionName(sessions.map((entry) => entry.name))),
    createdAt: input.now,
    updatedAt: input.now,
    archived: false,
    permission: input.permission ?? "default",
    binding: input.binding ?? null,
  };
  return {
    index: { version: SESSION_INDEX_VERSION, activeSessionId: id, sessions: [...sessions, session] },
    session,
  };
}

export function renameSessionInIndex(index: SessionIndex, id: string, name: string, now: string): SessionIndex {
  const target = index.sessions.find((session) => session.id === id);
  if (!target) throw new Error("session-unknown");
  const normalized = normalizeSessionName(name);
  return {
    version: SESSION_INDEX_VERSION,
    activeSessionId: index.activeSessionId,
    sessions: index.sessions.map((session) => session.id === id ? touch({ ...session, name: normalized }, now) : session),
  };
}

/** Archiving the active session moves the pointer to the next real one. */
export function archiveSessionInIndex(index: SessionIndex, id: string, now: string): SessionIndex {
  const target = index.sessions.find((session) => session.id === id);
  if (!target) throw new Error("session-unknown");
  const sessions = index.sessions.map((session) => session.id === id ? touch({ ...session, archived: true }, now) : session);
  return {
    version: SESSION_INDEX_VERSION,
    activeSessionId: index.activeSessionId === id ? nextReal(sessions, id) : index.activeSessionId,
    sessions,
  };
}

export function restoreSessionInIndex(index: SessionIndex, id: string, now: string): SessionIndex {
  const target = index.sessions.find((session) => session.id === id);
  if (!target) throw new Error("session-unknown");
  return {
    version: SESSION_INDEX_VERSION,
    // A restored session becomes active only when the task had none; restoring
    // must not yank the user out of the session they are working in.
    activeSessionId: index.activeSessionId ?? id,
    sessions: index.sessions.map((session) => session.id === id ? touch({ ...session, archived: false }, now) : session),
  };
}

/**
 * Delete one session record. Deleting the active session selects the next real
 * one; it never creates an empty replacement, so the user always knows whether
 * the task still has a session.
 */
export function deleteSessionInIndex(index: SessionIndex, id: string): SessionIndex {
  if (!index.sessions.some((session) => session.id === id)) throw new Error("session-unknown");
  const sessions = index.sessions.filter((session) => session.id !== id);
  return {
    version: SESSION_INDEX_VERSION,
    activeSessionId: index.activeSessionId === id ? nextReal(sessions, id) : index.activeSessionId,
    sessions,
  };
}

export function activateSessionInIndex(index: SessionIndex, id: string, now: string): SessionIndex {
  const target = index.sessions.find((session) => session.id === id);
  if (!target) throw new Error("session-unknown");
  if (target.archived) throw new Error("session-archived");
  return {
    version: SESSION_INDEX_VERSION,
    activeSessionId: id,
    sessions: index.sessions.map((session) => session.id === id ? touch(session, now) : session),
  };
}

/** Set or clear one session's model binding; the binding is that session's identity. */
export function bindSessionInIndex(index: SessionIndex, id: string, binding: SessionBinding | null, now: string): SessionIndex {
  const target = index.sessions.find((session) => session.id === id);
  if (!target) throw new Error("session-unknown");
  if (target.archived) throw new Error("session-archived");
  return {
    version: SESSION_INDEX_VERSION,
    activeSessionId: index.activeSessionId,
    sessions: index.sessions.map((session) => session.id === id ? touch({ ...session, binding: bindingOf(binding) }, now) : session),
  };
}

/**
 * Remove the SDK-owned artifacts of one deleted session: its binding directory
 * (the `binding.json` + JSONL transcript) and its turn journal directory. Both
 * live under task-owned, real-path-checked folders; anything else is left alone
 * and refused by name, so a deleted id cannot be made to reach outside the task.
 */
export function deleteSdkSessionArtifacts(taskDir: string, sessionId: string): void {
  if (!SESSION_ID.test(sessionId) && !/^[a-zA-Z0-9_-]{1,80}$/.test(sessionId)) throw new Error("invalid-session-id");
  const realTask = realpathSync(taskDir);
  for (const [parent, child] of [["sessions", "session"], [".pidock-sdk-sessions", "binding"], [".pidock-sdk-turns", "journal"]] as const) {
    const root = join(taskDir, parent);
    if (!existsSync(root)) continue;
    if (!lstatSync(root).isDirectory() || realpathSync(root) !== join(realTask, parent)) throw new Error(`sdk-${child}-invalid`);
    const target = join(root, sessionId);
    if (!existsSync(target)) continue;
    if (!lstatSync(target).isDirectory() || realpathSync(target) !== join(realTask, parent, sessionId)) throw new Error(`sdk-${child}-invalid`);
    rmSync(target, { recursive: true, force: true });
  }
}

export function sessionOf(index: SessionIndex, id: string): TaskSessionRecord {
  const target = index.sessions.find((session) => session.id === id);
  if (!target) throw new Error("session-unknown");
  return target;
}
