/**
 * [#139] The renderer's session-list contract, pinned at the data layer.
 *
 * Real-Electron evidence for #139 exposed one functional defect and one display
 * defect here:
 *
 *  - the six session writes answered without `provider`, and the page replaced
 *    its whole list with that reply, so `parseSessionList` produced
 *    `provider: null` and the model menu went unusable until a remount. The
 *    Host now carries the same provider row in every reply AND this layer
 *    merges a partial reply instead of nulling what it already had;
 *  - a declared 8-token window rendered as `0k` (`Math.round(window / 1000)`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateSession, archiveSession, createSession, deleteSession, formatWindow, mergeSessionList,
  parseSessionList, renameSession, restoreSession, subscribeSessionWrites,
} from "../data/taskSessions";

const session = (id: string, name: string) => ({
  id, name, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
  archived: false, permission: "default", binding: null,
});
const MODELS = [
  { id: "model-large", name: "Large", contextWindow: 131072, maxTokens: 8192, reasoning: true, reasoningLevels: ["low", "high"] },
  { id: "model-tiny", name: "Tiny", contextWindow: 8, maxTokens: 8, reasoning: false, reasoningLevels: [] },
];
const provider = { profileId: "p-1", modelId: "model-large", generation: 1, models: MODELS };
const list = (sessions = [session("main", "主会话")], activeSessionId: string | null = "main") => ({ activeSessionId, sessions, provider });

const envelope = (taskId: string, op: string, payload: unknown) => ({ ok: true as const, payload: { workspaceId: "w", taskId, op, payload } });

/** A Host that answers each session op in the shape `host.ts` answers it. */
function hostThatAnswers(answer: (op: string, payload: Record<string, unknown>) => unknown) {
  const taskOp = vi.fn(async (taskId: string, op: string, payload: Record<string, unknown> = {}) => envelope(taskId, op, answer(op, payload)));
  window.pidock = { taskOp } as never;
  return taskOp;
}

afterEach(() => { delete (window as { pidock?: unknown }).pidock; });

describe("[#139] every session write reply keeps the provider row", () => {
  const ops: Array<{ op: string; run: (taskId: string, sessionId: string) => Promise<{ ok: boolean; list?: ReturnType<typeof parseSessionList>; error?: string }> }> = [
    { op: "task/sessionCreate", run: async (taskId) => createSession(taskId, { name: "新会话" }) },
    { op: "task/sessionActivate", run: async (taskId, sessionId) => activateSession(taskId, sessionId) },
    { op: "task/sessionRename", run: async (taskId, sessionId) => renameSession(taskId, sessionId, "改名") },
    { op: "task/sessionArchive", run: async (taskId, sessionId) => archiveSession(taskId, sessionId) },
    { op: "task/sessionRestore", run: async (taskId, sessionId) => restoreSession(taskId, sessionId) },
    { op: "task/sessionDelete", run: async (taskId, sessionId) => deleteSession(taskId, sessionId) },
  ];
  for (const { op, run } of ops) {
    it(`${op} parses with the provider still installed`, async () => {
      const taskOp = hostThatAnswers((answered) => {
        expect(answered).toBe(op);
        return op === "task/sessionCreate" ? { session: session("s-1a2b3c4d", "新会话"), ...list() } : list();
      });
      const result = await run("task-a", "main");
      expect(result.ok).toBe(true);
      expect(taskOp).toHaveBeenCalledTimes(1);
      // The parsed row carries the model list: the composer can still switch.
      expect(result.list?.provider).toEqual(provider);
    });
  }

  it("a partial write reply merges the provider the page already had instead of nulling it", async () => {
    // The Host no longer sends this shape; a stale/partial reply must not brick
    // the model menu either (defence in depth, as the evidence asked).
    hostThatAnswers(() => ({ activeSessionId: "main", sessions: [session("main", "主会话")] }));
    const previous = parseSessionList(list());
    const result = await renameSession("task-a", "main", "改名");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const merged = mergeSessionList(previous, result.list);
    expect(merged.provider).toEqual(provider);
    expect(merged.sessions.map((row) => row.name)).toEqual(["主会话"]);
    // And with no previous provider there is still an explicit null, not undefined.
    expect(mergeSessionList(null, result.list)).toMatchObject({ provider: null });
  });
});

describe("[#139] declared windows are shown honestly", () => {
  it("keeps sub-1k windows as their real token count and never rounds down to 0k", () => {
    expect(formatWindow(8)).toBe("8");
    expect(formatWindow(999)).toBe("999");
  });
  it("rounds whole-kilo windows to k", () => {
    expect(formatWindow(1024)).toBe("1k");
    expect(formatWindow(131072)).toBe("131k");
  });
});

describe("[#139] session writes are observable to every list reader", () => {
  it("notifies subscribers after a successful write, and not on a refusal", async () => {
    const seen: string[] = [];
    const stop = subscribeSessionWrites((taskId: string) => seen.push(taskId));
    try {
      hostThatAnswers(() => list());
      await activateSession("task-a", "main");
      expect(seen).toEqual(["task-a"]);
      // A refused write is not a change: no re-read is asked for.
      window.pidock = { taskOp: vi.fn(async () => ({ ok: false, error: "task-locked" })) } as never;
      await archiveSession("task-a", "main");
      expect(seen).toEqual(["task-a"]);
    } finally { stop(); }
  });
});
