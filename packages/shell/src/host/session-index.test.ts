import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateSessionInIndex,
  archiveSessionInIndex,
  bindSessionInIndex,
  createSessionInIndex,
  deleteSessionInIndex,
  LEGACY_SESSION_ID,
  MAX_SESSIONS,
  migrateSessionIndex,
  newSessionName,
  readSessionIndex,
  renameSessionInIndex,
  restoreSessionInIndex,
  SESSION_INDEX_FILE,
  validateSessionIndex,
  writeSessionIndex,
  type SessionIndex,
} from "./session-index.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });

function taskDir(): string {
  const root = mkdtempSync(join(tmpdir(), "pidock-sessions-"));
  roots.push(root);
  mkdirSync(join(root, "sessions"));
  return root;
}

const NOW = "2026-05-01T10:00:00.000Z";
const LATER = "2026-05-01T11:00:00.000Z";

function fresh(): SessionIndex {
  return { version: 1, activeSessionId: LEGACY_SESSION_ID, sessions: [{ id: LEGACY_SESSION_ID, name: "main", createdAt: NOW, updatedAt: NOW, archived: false, permission: "default", binding: null }] };
}

describe("[#139] session index sidecar", () => {
  it("migrates the legacy `main` session (and any other legacy snapshot) on first read", () => {
    const dir = taskDir();
    writeFileSync(join(dir, "sessions", "main.json"), "{}");
    writeFileSync(join(dir, "sessions", "s-0badc0de.json"), "{}");
    writeFileSync(join(dir, "sessions", "not-a-session.json"), "{}");
    expect(existsSync(join(dir, SESSION_INDEX_FILE))).toBe(false);

    const index = readSessionIndex(dir, NOW);
    expect(index.sessions.map((session) => session.id)).toEqual(["main", "s-0badc0de"]);
    expect(index.activeSessionId).toBe("main");
    expect(index.sessions.every((session) => session.permission === "default" && !session.archived && session.binding === null)).toBe(true);
    // A read never writes: migration is persisted by the first mutation, so a
    // read-only caller (projection, permission probe) stays a read.
    expect(existsSync(join(dir, SESSION_INDEX_FILE))).toBe(false);
  });

  it("always gives a brand-new task exactly one session, `main`", () => {
    const index = migrateSessionIndex(taskDir(), NOW);
    expect(index.sessions).toHaveLength(1);
    expect(index.activeSessionId).toBe("main");
  });

  it("round-trips an index through an atomic, fsynced write and leaves no temp file", () => {
    const dir = taskDir();
    const created = createSessionInIndex(fresh(), { now: NOW, name: "边界复现" });
    writeSessionIndex(dir, created.index);
    expect(readSessionIndex(dir)).toEqual(created.index);
    expect(readFileSync(join(dir, SESSION_INDEX_FILE), "utf8")).toContain("边界复现");
    expect(statSync(join(dir, SESSION_INDEX_FILE)).mode & 0o777).toBe(0o600);
    const leftovers = readdirOf(dir);
    expect(leftovers.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("fails by name on a corrupt or unknown-shape sidecar instead of starting over", () => {
    const dir = taskDir();
    writeFileSync(join(dir, SESSION_INDEX_FILE), "{not json");
    expect(() => readSessionIndex(dir)).toThrow("invalid-session-index: unreadable JSON");
    writeFileSync(join(dir, SESSION_INDEX_FILE), JSON.stringify({ ...fresh(), extra: true }));
    expect(() => readSessionIndex(dir)).toThrow("invalid-session-index");
    writeFileSync(join(dir, SESSION_INDEX_FILE), JSON.stringify({ ...fresh(), version: 2 }));
    expect(() => readSessionIndex(dir)).toThrow("unsupported version");
  });

  it("rejects a pointer to a missing or archived session, duplicate ids and bad names", () => {
    const base = fresh();
    expect(() => validateSessionIndex({ ...base, activeSessionId: "s-deadbeef" })).toThrow("activeSessionId names no session");
    const archived = archiveSessionInIndex(base, "main", LATER);
    expect(archived.activeSessionId).toBeNull();
    expect(() => validateSessionIndex({ ...archived, activeSessionId: "main" })).toThrow("archived session");
    expect(() => validateSessionIndex({ ...base, sessions: [base.sessions[0], base.sessions[0]] })).toThrow("duplicate session id");
    expect(() => validateSessionIndex({ ...base, sessions: [{ ...base.sessions[0], name: "   " }] })).toThrow("invalid-session-name");
    expect(() => validateSessionIndex({ ...base, sessions: [{ ...base.sessions[0], id: "../escape" }] })).toThrow("session id");
    expect(() => renameSessionInIndex(base, "main", "x".repeat(41), LATER)).toThrow("invalid-session-name");
  });

  it("creates a session with its own id, fresh context and the new session active", () => {
    const dir = taskDir();
    const first = createSessionInIndex(fresh(), { now: NOW });
    expect(first.session.id).toMatch(/^s-[0-9a-f]{8}$/);
    expect(first.session.name).toBe("新会话");
    expect(first.index.activeSessionId).toBe(first.session.id);
    expect(first.session.binding).toBeNull();
    const second = createSessionInIndex(first.index, { now: NOW });
    expect(second.session.id).not.toBe(first.session.id);
    expect(second.session.name).toBe("新会话 2");
    // `main` stays first in the stored order; new sessions append.
    expect(second.index.sessions.map((session) => session.id)).toEqual(["main", first.session.id, second.session.id]);
    writeSessionIndex(dir, second.index);
    expect(readSessionIndex(dir).sessions).toHaveLength(3);
  });

  it("refuses a new session past the task's own ceiling", () => {
    let index = fresh();
    for (let count = 1; count < MAX_SESSIONS; count += 1) index = createSessionInIndex(index, { now: NOW }).index;
    expect(index.sessions).toHaveLength(MAX_SESSIONS);
    expect(() => createSessionInIndex(index, { now: NOW })).toThrow("session-limit-reached");
    expect(newSessionName([])).toBe("新会话");
  });

  it("renames, archives, restores, deletes and activates without inventing an empty session", () => {
    const created = createSessionInIndex(fresh(), { now: NOW, name: "第二个" });
    const renamed = renameSessionInIndex(created.index, created.session.id, "  补丁审查  ", LATER);
    expect(renamed.sessions.find((session) => session.id === created.session.id)?.name).toBe("补丁审查");
    expect(renamed.sessions.find((session) => session.id === created.session.id)?.updatedAt).toBe(LATER);

    // Archiving the active session hands over to the next REAL session.
    const archived = archiveSessionInIndex(renamed, created.session.id, LATER);
    expect(archived.activeSessionId).toBe("main");
    expect(archived.sessions.find((session) => session.id === created.session.id)?.archived).toBe(true);
    expect(() => activateSessionInIndex(archived, created.session.id, LATER)).toThrow("session-archived");
    expect(() => bindSessionInIndex(archived, created.session.id, { profileId: "p", modelId: "m", thinkingLevel: null, generation: 1 }, LATER)).toThrow("session-archived");

    const restored = restoreSessionInIndex(archived, created.session.id, LATER);
    expect(restored.sessions.find((session) => session.id === created.session.id)?.archived).toBe(false);
    // Restoring does not yank the pointer away from the session being used.
    expect(restored.activeSessionId).toBe("main");
    expect(activateSessionInIndex(restored, created.session.id, LATER).activeSessionId).toBe(created.session.id);

    // Deleting the active session picks the next real one; deleting the last
    // session leaves `null` rather than a fresh empty session.
    const activeOther = activateSessionInIndex(restored, created.session.id, LATER);
    const afterDelete = deleteSessionInIndex(activeOther, created.session.id);
    expect(afterDelete.activeSessionId).toBe("main");
    const empty = deleteSessionInIndex(afterDelete, "main");
    expect(empty.activeSessionId).toBeNull();
    expect(empty.sessions).toHaveLength(0);
    expect(() => deleteSessionInIndex(empty, created.session.id)).toThrow("session-unknown");
    expect(() => activateSessionInIndex(empty, "main", LATER)).toThrow("session-unknown");
  });

  it("keeps each session's model/reasoning binding as its own identity", () => {
    const created = createSessionInIndex(fresh(), { now: NOW });
    const bound = bindSessionInIndex(created.index, "main", { profileId: "p1", modelId: "model-a", thinkingLevel: "high", generation: 3 }, NOW);
    const other = bindSessionInIndex(bound, created.session.id, { profileId: "p1", modelId: "model-b", thinkingLevel: null, generation: 3 }, NOW);
    expect(other.sessions.find((session) => session.id === "main")?.binding).toMatchObject({ modelId: "model-a", thinkingLevel: "high" });
    expect(other.sessions.find((session) => session.id === created.session.id)?.binding).toMatchObject({ modelId: "model-b", thinkingLevel: null });
    expect(() => validateSessionIndex({ ...other, sessions: [{ ...other.sessions[0], binding: { ...other.sessions[0]!.binding, thinkingLevel: "ultra" } }] })).toThrow("invalid-session-binding");
    expect(() => validateSessionIndex({ ...other, sessions: [{ ...other.sessions[0], binding: { profileId: "p1", modelId: "m", generation: 1 } }] })).toThrow("invalid-session-binding");
  });

  it("survives a restart: the written index is what the next Host process reads", () => {
    const dir = taskDir();
    writeSessionIndex(dir, fresh());
    const created = createSessionInIndex(readSessionIndex(dir), { now: NOW, name: "重启后继续" });
    writeSessionIndex(dir, created.index);
    const reopened = readSessionIndex(dir);
    expect(reopened.activeSessionId).toBe(created.session.id);
    expect(reopened.sessions.find((session) => session.id === created.session.id)?.name).toBe("重启后继续");
  });

  it("refuses a read-only task folder instead of leaving a half-written index", () => {
    const dir = taskDir();
    writeFileSync(join(dir, SESSION_INDEX_FILE), "{}");
    chmodSync(dir, 0o500);
    try {
      expect(() => writeSessionIndex(dir, fresh())).toThrow();
    } finally { chmodSync(dir, 0o700); }
  });
});

function readdirOf(dir: string): string[] {
  return execFileSync("ls", ["-1", dir], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
}
