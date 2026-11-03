import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TaskWorkspaceHost, diskTaskStore } from "./task-host.js";
import { buildTaskDiskRecord, serializeTaskRecord } from "./task-store.js";
import type { SdkContextClient } from "./sdk-context-client.js";

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
  const home = mkdtempSync(join(tmpdir(), "pidock-sessions-host-"));
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

it("[#139] a fresh task starts with the migrated `main` session and lists it with its declared model levels", async () => {
  const f = fixture();
  const host = f.create();
  const index = host.sessionIndex();
  expect(index.activeSessionId).toBe("main");
  expect(index.sessions).toMatchObject([{ id: "main", name: "main", archived: false, permission: "default", binding: null }]);
  await host.configureSdkProvider({ config, credential: "synthetic-provider-key" });
  expect(host.sdkProviderConfig()).toMatchObject({ generation: 1 });
  expect(host.reasoningLevels("gpt-5-mini")).toEqual([]);
  expect(host.reasoningLevels("deepseek-r1")).toEqual(["off", "minimal", "low", "medium", "high"]);
});

it("[#139] creates a session with its own id and a fresh context, and the task's model binding", async () => {
  const f = fixture();
  const host = f.create();
  await host.configureSdkProvider({ config, credential: "synthetic-provider-key" });
  const created = host.createTaskSession({ name: "边界复现" });
  expect(created.session.id).toMatch(/^s-[0-9a-f]{8}$/);
  expect(created.session.name).toBe("边界复现");
  expect(created.session.binding).toMatchObject({ profileId: config.profileId, modelId: "gpt-5-mini", thinkingLevel: null, generation: 1 });
  expect(created.index.activeSessionId).toBe(created.session.id);
  // Two sessions = two ids, and the new one is NOT a copy of `main`.
  expect(host.sessionIndex().sessions.map((session) => session.id)).toEqual(["main", created.session.id]);
  // The id it hands out is what a model turn is allowed to use.
  expect(host.sessionForTurn(created.session.id)).toMatchObject({ id: created.session.id });
});

it("[#139] renames, archives (pointer moves), restores and deletes without inventing a session", async () => {
  const f = fixture();
  const host = f.create();
  const created = host.createTaskSession({ name: "第二个" });
  expect(host.renameTaskSession(created.session.id, "  补丁审查  ").sessions.find((session) => session.id === created.session.id)?.name).toBe("补丁审查");
  const archived = host.archiveTaskSession(created.session.id);
  expect(archived.activeSessionId).toBe("main");
  // An archived session cannot take a turn and cannot be activated.
  expect(() => host.sessionForTurn(created.session.id)).toThrow("session-archived");
  expect(() => host.activateTaskSession(created.session.id)).toThrow("session-archived");
  host.restoreTaskSession(created.session.id);
  expect(host.activateTaskSession(created.session.id).activeSessionId).toBe(created.session.id);
  const afterDelete = host.deleteTaskSession(created.session.id);
  expect(afterDelete.activeSessionId).toBe("main");
  expect(afterDelete.sessions).toHaveLength(1);
  expect(() => host.sessionForTurn(created.session.id)).toThrow("session-unknown");
  const empty = host.deleteTaskSession("main");
  expect(empty.activeSessionId).toBeNull();
  expect(empty.sessions).toEqual([]);
});

it("[#139] session identity survives a Host restart, including names, archive flags and bindings", async () => {
  const f = fixture();
  const first = f.create();
  const created = first.createTaskSession({ name: "重启后继续" });
  first.bindTaskSession(created.session.id, { profileId: config.profileId, modelId: "deepseek-r1", thinkingLevel: "high", generation: 1 });
  const restarted = f.create();
  const index = restarted.sessionIndex();
  expect(index.activeSessionId).toBe(created.session.id);
  expect(index.sessions.find((session) => session.id === created.session.id)).toMatchObject({
    name: "重启后继续", archived: false, binding: { modelId: "deepseek-r1", thinkingLevel: "high" },
  });
});

it("[#139] deleting a session removes its SDK binding/transcript/journal from the task folder", async () => {
  const f = fixture();
  const created = f.create().createTaskSession({ name: "要删除的" });
  const sessionId = created.session.id;
  for (const folder of [".pidock-sdk-sessions", ".pidock-sdk-turns"]) {
    mkdirSync(join(f.taskDir, folder, sessionId), { recursive: true });
    writeFileSync(join(f.taskDir, folder, sessionId, "keep.json"), "{}");
  }
  mkdirSync(join(f.taskDir, "sessions"), { recursive: true });
  writeFileSync(join(f.taskDir, "sessions", `${sessionId}.json`), "{}");
  const host = f.create();
  host.deleteTaskSession(sessionId);
  // Every artifact of the deleted id is gone; nothing else in the task is touched.
  const { existsSync } = await import("node:fs");
  for (const folder of [".pidock-sdk-sessions", ".pidock-sdk-turns"]) {
    expect(existsSync(join(f.taskDir, folder, sessionId))).toBe(false);
    expect(existsSync(join(f.taskDir, folder))).toBe(true);
  }
  expect(existsSync(join(f.taskDir, "sessions", `${sessionId}.json`))).toBe(false);
});

it("[#139] binding a session to another declared model keeps the session's own identity only", async () => {
  const f = fixture();
  const host = f.create();
  await host.configureSdkProvider({ config, credential: "synthetic-provider-key" });
  const created = host.createTaskSession({ name: "会话二" });
  const bound = host.bindTaskSession(created.session.id, { profileId: config.profileId, modelId: "deepseek-r1", thinkingLevel: "medium", generation: 1 });
  // `main` existed before the Provider was configured, so it has no explicit
  // binding: it follows the task's installed model (`sessionReadoutOf` reports
  // that), and switching a different session never changes it.
  expect(bound.sessions.find((session) => session.id === "main")?.binding).toBeNull();
  expect(bound.sessions.find((session) => session.id === created.session.id)?.binding).toMatchObject({ modelId: "deepseek-r1", thinkingLevel: "medium" });
  // An archived session's binding is frozen.
  host.archiveTaskSession(created.session.id);
  expect(() => host.bindTaskSession(created.session.id, { profileId: config.profileId, modelId: "gpt-5-mini", thinkingLevel: null, generation: 1 })).toThrow("session-archived");
});
