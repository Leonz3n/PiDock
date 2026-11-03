/**
 * [Pencil T11] #146 会话停止 / 归档 / 恢复 / 删除.
 *
 * Two things are pinned here, and they are the whole point of the ticket:
 *
 *  1. the ORDER of a lifecycle write on a running session — abort the Agent,
 *     await settlement, release the session's tool/resource claims and pending
 *     approvals, and only then touch history — with a state-specific named
 *     refusal for every action that does not apply;
 *  2. the delete race: a session deleted while its turn streams accepts NO late
 *     JSONL line and NO new turn (`session-deleted` by identity), and a restart
 *     never resurrects it from a stale index or a leftover snapshot.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TaskWorkspaceHost, diskTaskStore } from "./task-host.js";
import { buildTaskDiskRecord, serializeTaskRecord } from "./task-store.js";
import type { SdkContextClient } from "./sdk-context-client.js";
import { SdkTurnTransport } from "./sdk-turn-transport.js";
import type { SdkTurnKernelPort } from "./sdk-kernel-router.js";
import {
  hostSessionLifecyclePorts, runSessionLifecycle, sessionLifecycleRefusal,
  type SessionLifecyclePorts, type SessionLifecycleState,
} from "./session-lifecycle.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });

const at = "2026-09-22T10:00:00.000Z";
const live: SessionLifecycleState = { id: "s-1a2b3c4d", archived: false, busy: true, pendingApprovals: 0 };
const idle: SessionLifecycleState = { ...live, busy: false };
const archived: SessionLifecycleState = { ...idle, archived: true };
const waiting: SessionLifecycleState = { ...live, busy: false, pendingApprovals: 1 };

it("[#146] per-state refusals name the real reason, and a refusal happens before any abort", () => {
  expect(sessionLifecycleRefusal("stop", idle)).toContain("session-not-running");
  expect(sessionLifecycleRefusal("stop", archived)).toContain("session-archived");
  expect(sessionLifecycleRefusal("stop", live)).toBeNull();
  expect(sessionLifecycleRefusal("stop", waiting)).toBeNull();
  expect(sessionLifecycleRefusal("archive", archived)).toContain("session-archived");
  expect(sessionLifecycleRefusal("archive", live)).toBeNull();
  expect(sessionLifecycleRefusal("restore", live)).toContain("session-not-archived");
  expect(sessionLifecycleRefusal("restore", archived)).toBeNull();
  // Delete applies to every existing state; the index decides existence.
  expect(sessionLifecycleRefusal("delete", live)).toBeNull();
  expect(sessionLifecycleRefusal("delete", archived)).toBeNull();
});

function ports(state: SessionLifecycleState, options: { stillLiveAfterRelease?: boolean; calls?: string[] } = {}) {
  const calls = options.calls ?? [];
  let current = state;
  const api: SessionLifecyclePorts & { calls: string[] } = {
    calls,
    state: () => current,
    abortTurn: async () => { calls.push("abort"); current = { ...current, busy: options.stillLiveAfterRelease === true }; return ["turn-1"]; },
    releaseSession: () => { calls.push("release"); if (options.stillLiveAfterRelease !== true) current = { ...current, busy: false, pendingApprovals: 0 }; },
    index: () => ({ version: 1, activeSessionId: state.id, sessions: [] }),
    archive: () => { calls.push("archive"); return { version: 1, activeSessionId: null, sessions: [] }; },
    restore: () => { calls.push("restore"); return { version: 1, activeSessionId: state.id, sessions: [] }; },
    remove: () => { calls.push("remove"); return { version: 1, activeSessionId: null, sessions: [] }; },
    retire: () => { calls.push("retire"); },
  };
  return api;
}

it("[#146] stop aborts and settles a live turn; an idle session is refused by name and nothing is aborted", async () => {
  const livePorts = ports(live);
  const outcome = await runSessionLifecycle("stop", live.id, livePorts);
  expect(outcome).toMatchObject({ action: "stop", stopped: true, abortedTurnIds: ["turn-1"] });
  expect(livePorts.calls).toEqual(["abort", "release"]);

  const idlePorts = ports(idle);
  await expect(runSessionLifecycle("stop", idle.id, idlePorts)).rejects.toThrow("session-not-running");
  expect(idlePorts.calls).toEqual([]);
});

it("[#146] archive of a running session aborts and releases BEFORE the archive write", async () => {
  const hostPorts = ports(live);
  const outcome = await runSessionLifecycle("archive", live.id, hostPorts);
  expect(outcome).toMatchObject({ action: "archive", stopped: true, abortedTurnIds: ["turn-1"] });
  expect(hostPorts.calls).toEqual(["abort", "release", "archive"]);
});

it("[#146] a session waiting on an approval counts as live: releasing expires it before the write", async () => {
  const hostPorts = ports(waiting);
  const outcome = await runSessionLifecycle("archive", waiting.id, hostPorts);
  expect(outcome.stopped).toBe(true);
  expect(hostPorts.calls).toEqual(["abort", "release", "archive"]);
});

it("[#146] restore only clears the archive flag: no abort, no release, no replay", async () => {
  const hostPorts = ports(archived);
  const outcome = await runSessionLifecycle("restore", archived.id, hostPorts);
  expect(outcome).toMatchObject({ action: "restore", stopped: false, abortedTurnIds: [] });
  expect(hostPorts.calls).toEqual(["restore"]);
});

it("[#146] delete retires the id before removing the record, so the late-write window is closed first", async () => {
  const hostPorts = ports(live);
  const outcome = await runSessionLifecycle("delete", live.id, hostPorts);
  expect(outcome).toMatchObject({ action: "delete", stopped: true, abortedTurnIds: ["turn-1"] });
  expect(hostPorts.calls).toEqual(["abort", "release", "retire", "remove"]);

  const idlePorts = ports(idle);
  const idleOutcome = await runSessionLifecycle("delete", idle.id, idlePorts);
  expect(idleOutcome.stopped).toBe(false);
  expect(idlePorts.calls).toEqual(["retire", "remove"]);
});

it("[#146] a turn that is still live after the abort settles refuses the history write", async () => {
  const hostPorts = ports(live, { stillLiveAfterRelease: true });
  await expect(runSessionLifecycle("delete", live.id, hostPorts)).rejects.toThrow("sdk-turn-unsettled");
  expect(hostPorts.calls).toEqual(["abort", "release"]);
  expect(hostPorts.calls).not.toContain("remove");
});

// ---- Host wiring: the delete-during-stream race, a real transport, real files ----

const config = {
  profileId: "p-11111111-2222-3333-4444-555555555555",
  baseUrl: "https://models.example.test/v1",
  modelId: "gpt-5-mini",
  contextWindow: 128000,
  maxTokens: 8192,
  authRef: "PIDOCK_PROVIDER_EXAMPLE",
  generation: 1,
  protocol: "openai-completions" as const,
  credentialSource: "env" as const,
  models: [{ id: "gpt-5-mini", name: "GPT-5 mini", contextWindow: 128000, maxTokens: 8192, reasoning: false }],
};

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pidock-session-lifecycle-"));
  homes.push(home);
  const taskDir = join(home, "task-a");
  mkdirSync(taskDir);
  writeFileSync(join(taskDir, "task.json"), serializeTaskRecord(buildTaskDiskRecord({
    taskId: "task-a", name: "任务 A", dirId: "task-a", branch: "main", root: home, taskDir,
    remoteBranch: "main", baseCommit: "fixture", repos: [], now: at,
  })));
  const client = {
    open: vi.fn(async () => ({ sdkId: "fixture", file: "fixture.jsonl", tools: [] })),
    prompt: vi.fn(async () => ({ state: "done" as const, text: "answer", events: [] })),
    cancel: vi.fn(async () => {}),
    bind: vi.fn(async (_sessionId: string, binding: { modelId: string; thinkingLevel?: string }) => ({ modelId: binding.modelId, thinkingLevel: binding.thinkingLevel ?? "off" })),
    seal: vi.fn(),
    dispose: vi.fn(async () => {}),
  };
  const create = () => new TaskWorkspaceHost("task-a", taskDir, diskTaskStore, () => at, () => [], undefined, undefined, undefined, undefined,
    () => client as unknown as SdkContextClient);
  return { taskDir, client, create };
}

/** A kernel whose single turn streams into the session's own JSONL until cancelled. */
function streamingKernel(taskDir: string) {
  const cancelled = new Set<string>();
  const lines: string[] = [];
  const transcript = (sessionId: string) => join(taskDir, ".pidock-sdk-sessions", sessionId, "transcript.jsonl");
  const lineCount = (sessionId: string) => (existsSync(transcript(sessionId)) ? readFileSync(transcript(sessionId), "utf8").trim().split("\n").filter(Boolean).length : 0);
  const kernel: SdkTurnKernelPort = {
    open: async (sessionId: string) => { mkdirSync(join(taskDir, ".pidock-sdk-sessions", sessionId), { recursive: true }); return { sdkId: "fixture", file: transcript(sessionId), tools: [] }; },
    prompt: async (sessionId: string, prompt: string) => {
      appendFileSync(transcript(sessionId), `${JSON.stringify({ role: "user", text: prompt })}\n`);
      lines.push("user");
      while (!cancelled.has(sessionId)) await new Promise((resolve) => setTimeout(resolve, 2));
      // A cancelled turn writes NOTHING more: the SDK settles before the Host
      // removes the session it was streaming into.
      return { state: "cancelled" as const, text: "", events: [] };
    },
    cancel: async (sessionId: string) => { cancelled.add(sessionId); },
    dispose: async () => {},
    projection: () => { throw new Error("unused"); },
    digest: (sessionId: string) => ({ sessionId, turns: 0, contextUsed: null, usage: null, model: null, interrupted: false }),
  };
  return { kernel, lineCount, lines };
}

it("[#146] deleting a session during streaming stops it, writes no late JSONL line, and refuses its next turn by identity", async () => {
  const f = fixture();
  const host = f.create();
  const created = host.createTaskSession({ name: "流式删除" });
  const id = created.session.id;
  host.saveDraft(id, { text: "还没发送的草稿" });
  const { kernel, lineCount, lines } = streamingKernel(f.taskDir);
  const turns = new SdkTurnTransport("task-a", f.taskDir, kernel);
  await turns.start(id, "req-1", "开始", () => {});
  expect(turns.busy(id)).toBe(true);
  const linesWhileStreaming = lineCount(id);
  expect(linesWhileStreaming).toBe(1);

  const outcome = await runSessionLifecycle("delete", id, hostSessionLifecyclePorts(host, turns));
  // Named outcome: what was stopped and that the delete happened after it settled.
  expect(outcome).toMatchObject({ action: "delete", stopped: true });
  expect(outcome.abortedTurnIds).toHaveLength(1);
  // The session is gone from the index, its transcript/binding/journal and its
  // legacy snapshot AND its draft with it.
  expect(host.sessionIndex().sessions.map((session) => session.id)).toEqual(["main"]);
  expect(existsSync(join(f.taskDir, ".pidock-sdk-sessions", id))).toBe(false);
  expect(existsSync(join(f.taskDir, "sessions", `${id}.json`))).toBe(false);
  expect(host.readDraft(id)).toBeNull();
  // No late JSONL line: nothing arrived after the abort settled (the kernel had
  // no chance to write one more line into the removed directory).
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(lines.filter((line) => line === "user")).toHaveLength(1);
  // A late turn is refused by identity, not accepted into a deleted session.
  await expect(turns.start(id, "req-2", "继续", () => {})).rejects.toThrow("session-deleted");
  expect(turns.isRetired(id)).toBe(true);
  // The task still has its other session; delete never invents a replacement.
  expect(host.sessionIndex().activeSessionId).toBe("main");
});

it("[#146] a deleted session stays deleted after a Host restart (no resurrection from a stale snapshot)", async () => {
  const f = fixture();
  const first = f.create();
  await first.configureSdkProvider({ config, credential: "synthetic-provider-key" });
  const created = first.createTaskSession({ name: "重启后应消失" });
  const id = created.session.id;
  await runSessionLifecycle("delete", id, hostSessionLifecyclePorts(first, null));
  expect(first.sessionIndex().sessions.some((session) => session.id === id)).toBe(false);
  // A fresh Host (restart) reads the same task folder.
  const restarted = f.create();
  const index = restarted.sessionIndex();
  expect(index.sessions.some((session) => session.id === id)).toBe(false);
  expect(index.sessions.some((session) => session.id === "main")).toBe(true);
  // The deleted id is not addressable by any lifecycle action either.
  await expect(runSessionLifecycle("delete", id, hostSessionLifecyclePorts(restarted, null))).rejects.toThrow("session-unknown");
});

it("[#146] archive blocks sending (read-only) and restore keeps the history without replaying anything", async () => {
  const f = fixture();
  const host = f.create();
  const created = host.createTaskSession({ name: "归档再恢复" });
  const id = created.session.id;
  await runSessionLifecycle("archive", id, hostSessionLifecyclePorts(host, null));
  expect(host.sessionIndex().sessions.find((session) => session.id === id)?.archived).toBe(true);
  // An archived session takes no turn: the Host's turn gate refuses by name.
  expect(() => host.sessionForTurn(id)).toThrow("session-archived");
  const outcome = await runSessionLifecycle("restore", id, hostSessionLifecyclePorts(host, null));
  expect(outcome.stopped).toBe(false);
  expect(host.sessionIndex().sessions.find((session) => session.id === id)?.archived).toBe(false);
  // Restore wrote the flag only: the session is still not the "active" one it
  // was not before, and nothing was sent (no prompt call happened at all).
  expect(f.client.prompt).not.toHaveBeenCalled();
  expect(() => host.sessionForTurn(id)).not.toThrow();
});

it("[#146] a new conversation always has a new identity: a deleted id is never reused", async () => {
  const f = fixture();
  const host = f.create();
  const first = host.createTaskSession({ name: "第一个" });
  await runSessionLifecycle("delete", first.session.id, hostSessionLifecyclePorts(host, null));
  const second = host.createTaskSession({ name: "第二个" });
  expect(second.session.id).not.toBe(first.session.id);
  expect(second.index.sessions.map((session) => session.id)).toEqual(["main", second.session.id]);
});
