/**
 * [#139] One reply shape for every session-list read AND every session write.
 *
 * The real-Electron evidence for #139 caught a functional defect: the write ops
 * (`create|activate|rename|archive|restore|delete`) answered with only
 * `{activeSessionId, sessions}` while the renderer replaced its whole list with
 * that reply, so `parseSessionList` read `provider: null` and the model menu
 * became unusable until a remount. These tests pin the builder both read paths
 * use, including the provider row (`models` + the levels each row declares).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { TaskWorkspaceHost, diskTaskStore } from "./task-host.js";
import { buildTaskDiskRecord, serializeTaskRecord } from "./task-store.js";
import type { SdkContextClient } from "./sdk-context-client.js";
import { sessionCreatedPayload, sessionListPayload } from "./session-list-payload.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });

const at = "2026-09-22T10:00:00.000Z";
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
  models: [
    { id: "gpt-5-mini", name: "GPT-5 mini", contextWindow: 128000, maxTokens: 8192, reasoning: false },
    { id: "deepseek-r1", name: "DeepSeek R1", contextWindow: 64000, maxTokens: 8192, reasoning: true },
  ],
};

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pidock-session-payload-"));
  homes.push(home);
  const taskDir = join(home, "task-a");
  mkdirSync(taskDir);
  writeFileSync(join(taskDir, "task.json"), serializeTaskRecord(buildTaskDiskRecord({
    taskId: "task-a", name: "任务 A", dirId: "task-a", branch: "main", root: home, taskDir,
    remoteBranch: "main", baseCommit: "fixture", repos: [], now: at,
  })));
  // A synthetic SDK context: the payload builder reads the Host's own config
  // record only, so no worker process is involved.
  const client = {
    open: async () => ({ sdkId: "fixture", file: "fixture.jsonl", tools: [] }),
    prompt: async () => ({ state: "done" as const, text: "answer", events: [] }),
    cancel: async () => {},
    bind: async (_sessionId: string, binding: { modelId: string; thinkingLevel?: string }) => ({ modelId: binding.modelId, thinkingLevel: binding.thinkingLevel ?? "off" }),
    seal: () => {},
    dispose: async () => {},
  };
  return {
    host: new TaskWorkspaceHost("task-a", taskDir, diskTaskStore, () => at, () => [], undefined, undefined, undefined, undefined,
      () => client as unknown as SdkContextClient),
  };
}

/** The provider row every reply must carry, byte for byte. */
const providerRow = {
  profileId: config.profileId,
  modelId: "gpt-5-mini",
  generation: 1,
  models: [
    { id: "gpt-5-mini", name: "GPT-5 mini", contextWindow: 128000, maxTokens: 8192, reasoning: false, reasoningLevels: [] },
    { id: "deepseek-r1", name: "DeepSeek R1", contextWindow: 64000, maxTokens: 8192, reasoning: true, reasoningLevels: ["off", "minimal", "low", "medium", "high"] },
  ],
};

it("[#139] the read reply carries the exact provider row the renderer parses", async () => {
  const f = fixture();
  await f.host.configureSdkProvider({ config, credential: "synthetic-provider-key" });
  const reply = sessionListPayload(f.host.sessionIndex(), f.host.sdkProviderConfig());
  expect(Object.keys(reply).sort()).toEqual(["activeSessionId", "provider", "sessions"]);
  expect(reply.provider).toEqual(providerRow);
  // Same JSON a real IPC hop delivers: nothing is lost or added in transit.
  expect(JSON.parse(JSON.stringify(reply))).toEqual(reply);
});

it("[#139] all six session writes answer with the same provider payload as task/sessionList", async () => {
  const f = fixture();
  await f.host.configureSdkProvider({ config, credential: "synthetic-provider-key" });
  const installed = f.host.sdkProviderConfig();
  expect(installed).not.toBeNull();

  const created = f.host.createTaskSession({ name: "边界复现" });
  const replies: Array<{ op: string; reply: Record<string, unknown>; keys: string[]; index: ReturnType<TaskWorkspaceHost["sessionIndex"]> }> = [
    { op: "task/sessionCreate", reply: sessionCreatedPayload(created, installed), keys: ["activeSessionId", "provider", "session", "sessions"], index: created.index },
    { op: "task/sessionRename", reply: sessionListPayload(f.host.renameTaskSession(created.session.id, "重命名"), installed), keys: ["activeSessionId", "provider", "sessions"], index: f.host.sessionIndex() },
    { op: "task/sessionActivate", reply: sessionListPayload(f.host.activateTaskSession("main"), installed), keys: ["activeSessionId", "provider", "sessions"], index: f.host.sessionIndex() },
    { op: "task/sessionArchive", reply: sessionListPayload(f.host.archiveTaskSession(created.session.id), installed), keys: ["activeSessionId", "provider", "sessions"], index: f.host.sessionIndex() },
    { op: "task/sessionRestore", reply: sessionListPayload(f.host.restoreTaskSession(created.session.id), installed), keys: ["activeSessionId", "provider", "sessions"], index: f.host.sessionIndex() },
  ];
  // Delete last: it drops the session these replies were about.
  replies.push({ op: "task/sessionDelete", reply: sessionListPayload(f.host.deleteTaskSession(created.session.id), installed), keys: ["activeSessionId", "provider", "sessions"], index: f.host.sessionIndex() });

  for (const { op, reply, keys, index } of replies) {
    expect({ op, keys: Object.keys(reply).sort() }).toEqual({ op, keys });
    expect({ op, provider: reply["provider"] }).toEqual({ op, provider: providerRow });
    expect({ op, active: reply["activeSessionId"], sessions: reply["sessions"] }).toEqual({ op, active: index.activeSessionId, sessions: index.sessions });
  }
  // Create names the created session in the same reply, with the provider row.
  expect(replies[0]!.reply["session"]).toMatchObject({ id: created.session.id, name: "边界复现" });
});

it("[#139] an uninstalled provider is an explicit null, never an omitted key", () => {
  const f = fixture();
  const reply = sessionListPayload(f.host.sessionIndex(), f.host.sdkProviderConfig());
  expect(Object.keys(reply).sort()).toEqual(["activeSessionId", "provider", "sessions"]);
  expect(reply.provider).toBeNull();
  const created = f.host.createTaskSession({ name: "无 Provider" });
  const writeReply = sessionCreatedPayload(created, f.host.sdkProviderConfig());
  expect(Object.keys(writeReply).sort()).toEqual(["activeSessionId", "provider", "session", "sessions"]);
  expect(writeReply.provider).toBeNull();
});
