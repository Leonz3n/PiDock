/**
 * [#154] Upgrade evidence is product behaviour: a session backup written by Pi
 * 0.87.1 or 1.4.0 must open through the SAME production kernel path PiDock uses
 * (`PiSdkTextKernel` + the pinned 1.5.0 `SessionManager`), read its history
 * without a model or tool call, and only append on a NEW turn.
 *
 * The fixtures under `docs/evidence/pencil-v1-t19-upgrade/fixtures` are
 * reconstructed (see their README) and every test works on a COPY: the fixture
 * files themselves are hashed before/after and must not change.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import type { AssistantMessage, Model, Provider } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { PiSdkTextKernel } from "./sdk-text-kernel.js";
import { buildTaskDiskRecord, serializeTaskRecord } from "./task-store.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "..", "..", "..", "..", "docs", "evidence", "pencil-v1-t19-upgrade", "fixtures");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });

const sha256 = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
const fixtureShas = {
  "pi-0.87.1-session.jsonl": sha256(readFileSync(join(FIXTURES, "pi-0.87.1-session.jsonl"))),
  "pi-1.4.0-session.jsonl": sha256(readFileSync(join(FIXTURES, "pi-1.4.0-session.jsonl"))),
};

const usage = { input: 4, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 7,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model: Model<"pidock-local-test"> = {
  id: "upgrade-chat", name: "Upgrade Chat", api: "pidock-local-test", provider: "pidock-upgrade",
  baseUrl: "http://127.0.0.1/unused", reasoning: true, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65536, maxTokens: 4096,
};

function task(id: string) {
  const root = mkdtempSync(join(tmpdir(), "pidock-upgrade-test-"));
  roots.push(root);
  const dir = join(root, id);
  mkdirSync(dir);
  execFileSync("git", ["init", "-q", dir], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TEMPLATE_DIR: "" } });
  writeFileSync(join(dir, "task.json"), serializeTaskRecord(buildTaskDiskRecord({
    taskId: id, name: id, dirId: id, branch: "main", root, taskDir: dir,
    remoteBranch: "main", baseCommit: "synthetic-upgrade-fixture", repos: [], now: new Date().toISOString(),
  })));
  return dir;
}

/** Install the backup as if it had been written in THIS task dir, then bind it. */
function install(dir: string, fixture: string, thinkingLevel: string) {
  const source = readFileSync(join(FIXTURES, fixture));
  const text = source.toString("utf8").replaceAll("__PIDOCK_TASK_DIR__", dir);
  const header = JSON.parse(text.split("\n", 1)[0]!);
  const sessionDir = join(dir, ".pidock-sdk-sessions", "main");
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, ".pidock-sdk-agent"), { recursive: true, mode: 0o700 });
  const file = `sdk-${header.id}.jsonl`;
  writeFileSync(join(sessionDir, file), text, { flag: "wx", mode: 0o600 });
  writeFileSync(join(sessionDir, "binding.json"), JSON.stringify({
    taskId: JSON.parse(readFileSync(join(dir, "task.json"), "utf8")).taskId,
    sessionId: "main", sdkId: header.id, file, modelId: model.id, thinkingLevel,
  }), { flag: "wx", mode: 0o600 });
  return { sessionDir, file, path: join(sessionDir, file), header, lines: text.trimEnd().split("\n") };
}

async function kernel(dir: string, onCallTool: () => void) {
  const runtime = await ModelRuntime.create({
    authPath: join(dir, ".private-auth.json"), modelsPath: join(dir, ".private-models.json"), refreshOnCreate: false,
  });
  const seen: string[] = [];
  const provider: Provider<"pidock-local-test"> = {
    id: model.provider, name: "Isolated upgrade test", auth: { apiKey: { name: "Local", resolve: async () => ({ auth: {} }) } },
    getModels: () => [model],
    stream: (m, context, options) => provider.streamSimple(m, context, options),
    streamSimple: (_m, context) => {
      seen.push(context.messages.map((message) => message.role).join(","));
      const stream = createAssistantMessageEventStream();
      const partial: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [], usage, stopReason: "pending", timestamp: Date.now() };
      queueMicrotask(() => {
        stream.push({ type: "start", partial });
        const answer = "T19-UPGRADE-TEST-DONE";
        partial.content.push({ type: "text", text: answer });
        stream.push({ type: "text_start", contentIndex: 0, partial });
        stream.push({ type: "text_delta", contentIndex: 0, delta: answer, partial });
        stream.push({ type: "text_end", contentIndex: 0, content: answer, partial });
        stream.push({ type: "done", reason: "stop", message: { ...partial, stopReason: "stop" } });
      });
      return stream;
    },
  };
  runtime.registerNativeProvider(provider);
  const instance = new PiSdkTextKernel(JSON.parse(readFileSync(join(dir, "task.json"), "utf8")).taskId, dir, {
    model, modelRuntime: runtime,
    callTool: async () => { onCallTool(); throw new Error("no tool may run during session open"); },
  });
  return { instance, seen };
}

it.each([
  ["0.87.1", "pi-0.87.1-session.jsonl", "off"],
  ["1.4.0", "pi-1.4.0-session.jsonl", "high"],
])("opens a %s backup without writing, reading the history or replaying model/tool effects", async (label, fixture, thinkingLevel) => {
  const dir = task(`task-upgrade-${label.replaceAll(".", "-")}`);
  const backup = install(dir, fixture, thinkingLevel);
  const before = sha256(readFileSync(backup.path));
  let toolCalls = 0;
  const first = await kernel(dir, () => { toolCalls += 1; });

  const opened = await first.instance.open("main");
  expect(opened.sdkId).toBe(backup.header.id);
  expect(opened.modelId).toBe(model.id);
  expect(opened.thinkingLevel).toBe(thinkingLevel);
  // Opening reads the transcript; it does not call the model, run a historical
  // tool call, or rewrite the backup copy.
  expect(first.seen).toHaveLength(0);
  expect(toolCalls).toBe(0);
  expect(sha256(readFileSync(backup.path))).toBe(before);

  const projection = first.instance.projection("main");
  expect(projection.source).toBe("sdk-jsonl");
  expect(projection.messages.length).toBeGreaterThan(4);
  expect(projection.messages[0]?.role).toBe("user");
  expect(JSON.stringify(projection.messages)).toContain(label === "0.87.1" ? "帮我整理发布说明" : "1.4.0 升级的验证结论");
  expect(projection.messages.at(-1)?.role).toBe("assistant");
  const digest = first.instance.digest("main");
  expect(digest.turns).toBe(3);
  expect(digest.interrupted).toBe(false);
  expect(digest.model).toEqual({ provider: model.provider, modelId: model.id });
  expect(digest.usage?.input).toBe(label === "0.87.1" ? 2872 : 3624);

  // An unknown entry type / unknown fields are preserved on disk and do not
  // crash history building.
  expect(() => SessionManager.open(backup.path, backup.sessionDir, dir).buildSessionContext()).not.toThrow();
  const rawBeforeTurn = readFileSync(backup.path, "utf8");
  expect(rawBeforeTurn).toContain("futureVendorField");
  expect(rawBeforeTurn).toContain(label === "0.87.1" ? "future_extension_state" : "futureMessageField");

  // Only a NEW turn writes, and it appends current v3 entries after the fixture.
  const turn = await first.instance.prompt("main", "升级后继续：确认历史还在。");
  expect(turn.state).toBe("done");
  expect(turn.text).toBe("T19-UPGRADE-TEST-DONE");
  expect(first.seen).toHaveLength(1);
  expect(toolCalls).toBe(0);
  const after = readFileSync(backup.path, "utf8");
  expect(after.startsWith(rawBeforeTurn)).toBe(true); // append-only: not one fixture byte rewritten
  const appended = after.slice(rawBeforeTurn.length).trimEnd().split("\n").map((line) => JSON.parse(line));
  expect(appended.length).toBeGreaterThanOrEqual(2);
  for (const entry of appended) {
    expect(typeof entry.type).toBe("string");
    expect(entry.type).not.toBe("session");
    expect(typeof entry.id).toBe("string");
    expect(entry.parentId === null || typeof entry.parentId === "string").toBe(true);
    expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false);
  }
  const roles = appended.filter((entry) => entry.type === "message").map((entry) => entry.message.role);
  expect(roles).toContain("user");
  expect(roles).toContain("assistant");
  const assistant = appended.find((entry) => entry.type === "message" && entry.message.role === "assistant");
  expect(assistant.message).toMatchObject({ provider: model.provider, model: model.id, stopReason: "stop" });
  expect(assistant.message.usage).toBeTypeOf("object");

  // A cold reopen of the SAME file does not replay the model request.
  await first.instance.dispose();
  const cold = await kernel(dir, () => { toolCalls += 1; });
  await cold.instance.open("main");
  expect(cold.seen).toHaveLength(0);
  expect(toolCalls).toBe(0);
  expect(JSON.stringify(cold.instance.projection("main").messages)).toContain("升级后继续：确认历史还在。");
  await cold.instance.dispose();

  // The checked-in fixture was never touched by any of the above.
  expect(sha256(readFileSync(join(FIXTURES, fixture)))).toBe(fixtureShas[fixture]);
});

it("opens a pre-v3 (v2) backup through the same path and lets the SDK migrate it to v3", async () => {
  const dir = task("task-upgrade-v2");
  const sessionDir = join(dir, ".pidock-sdk-sessions", "main");
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const id = "0f9a2c31-v2-4f7a-8c31-000000000002";
  const v2 = [
    { type: "session", version: 2, id, timestamp: "2026-08-01T10:00:00.000Z", cwd: dir },
    { type: "message", id: "c0000001", parentId: null, timestamp: "2026-08-01T10:00:01.000Z",
      message: { role: "user", content: "v2 备份里的问题", timestamp: Date.parse("2026-08-01T10:00:01.000Z") } },
    { type: "message", id: "c0000002", parentId: "c0000001", timestamp: "2026-08-01T10:00:02.000Z",
      message: { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{ type: "text", text: "v2 备份里的回答" }], usage, stopReason: "stop",
        timestamp: Date.parse("2026-08-01T10:00:02.000Z") } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n";
  const file = join(sessionDir, `sdk-${id}.jsonl`);
  writeFileSync(file, v2, { flag: "wx", mode: 0o600 });

  // The SDK owns this migration: `SessionManager.open` rewrites the copy to the
  // current version so every later append is in the current format.
  const manager = SessionManager.open(file, sessionDir, dir);
  expect(manager.getHeader()?.version).toBe(3);
  expect(JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]!).version).toBe(3);
  expect(manager.getBranch().filter((entry) => entry.type === "message")).toHaveLength(2);
});
