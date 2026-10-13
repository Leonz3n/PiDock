/**
 * Agent-visible plain-directory links ([PiDock 03] #6, box 12) through the real
 * Host broker ([PiDock 02m] #5).
 *
 * The model hop is replaced by the same loopback context stub the sibling
 * `sdk-agent-tools.test.ts` uses; everything else is real: the real
 * `TaskWorkspaceHost`, the real `PiSdkTextKernel` with a stub local runtime, the
 * real permission gate and the real filesystem of a temp task. This is NOT a
 * live Provider/AgentSession — no network and no real model are involved.
 *
 * A plain-directory link is a SHARED view of its original: it is reachable only
 * through its stable in-task link name, and a write through it must change the
 * original files, never a per-task copy.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { AssistantMessage, Model, Provider } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { TaskWorkspaceHost, memoryTaskStore } from "./task-host.js";
import { buildTaskDiskRecord, readTaskRecordOnDisk, serializeTaskRecord } from "./task-store.js";
import { PiSdkTextKernel } from "./sdk-text-kernel.js";
import { resolveSdkAgentToolPath } from "./sdk-agent-tool-broker.js";
import type { SdkContextClient, SdkContextOptions } from "./sdk-context-client.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });

const PROVIDER_CONFIG = {
  profileId: "p-11111111-2222-3333-4444-555555555555",
  baseUrl: "https://models.example.test/v1",
  modelId: "gpt-5-mini",
  contextWindow: 128000,
  maxTokens: 8192,
  authRef: "PIDOCK_PROVIDER_EXAMPLE",
  generation: 1,
};

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TEMPLATE_DIR: "",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.test",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.test",
};

const model: Model<"pidock-local-test"> = {
  id: "fixture", name: "Fixture", api: "pidock-local-test", provider: "local-test",
  baseUrl: "http://127.0.0.1/unused", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 2048, maxTokens: 128,
};
const usage = { input: 4, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 7, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

const LINK_NAME = "dir-aaaa1111";
const DIRECTORY_ID = "aaaa1111-0000-4000-8000-000000000001";

interface Fixture {
  root: string;
  taskDir: string;
  worktree: string;
  docsDir: string;
  externalDir: string;
  taskId: string;
}

/**
 * A real task with one Git worktree AND one plain-directory link. The original
 * files live OUTSIDE the tasks root, exactly as a user's documents folder does.
 */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pidock-agent-shared-"));
  roots.push(root);
  const taskId = "task-aaaaaaaa";
  const taskDir = join(root, taskId);
  mkdirSync(taskDir);

  const checkout = join(root, "primary");
  mkdirSync(checkout);
  execFileSync("git", ["init", "-q"], { cwd: checkout, env: GIT_ENV });
  writeFileSync(join(checkout, "notes.txt"), "original\n");
  execFileSync("git", ["add", "-A"], { cwd: checkout, env: GIT_ENV });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: checkout, env: GIT_ENV });
  execFileSync("git", ["worktree", "add", "-b", "task-branch", join(taskDir, "repo")], { cwd: checkout, env: GIT_ENV });

  const docsDir = mkdtempSync(join(tmpdir(), "pidock-agent-docs-"));
  roots.push(docsDir);
  writeFileSync(join(docsDir, "spec.txt"), "shared spec content\n");
  mkdirSync(join(docsDir, "nested"));
  writeFileSync(join(docsDir, "nested", "deep.txt"), "deep shared content\n");

  // An unrelated folder outside the task, reached only through a link planted
  // inside the shared original: a link that leaves its recorded original.
  const externalDir = mkdtempSync(join(tmpdir(), "pidock-agent-external-"));
  roots.push(externalDir);
  writeFileSync(join(externalDir, "outside.txt"), "outside the shared original\n");
  // win32: a plain directory symlink needs SeCreateSymbolicLinkPrivilege; a junction is the directory link this platform can create without it (#57).
  symlinkSync(externalDir, join(docsDir, "escape-out"), process.platform === "win32" ? "junction" : "dir");

  const linkPath = join(taskDir, LINK_NAME);
  symlinkSync(docsDir, linkPath, process.platform === "win32" ? "junction" : "dir");

  writeFileSync(join(taskDir, "task.json"), serializeTaskRecord(buildTaskDiskRecord({
    taskId, name: taskId, dirId: taskId, branch: "task-branch", root, taskDir,
    remoteBranch: "main", baseCommit: "test", repos: ["repo"],
    dirLinks: [{ linkName: LINK_NAME, directoryId: DIRECTORY_ID, sourcePath: docsDir, snapshotAt: new Date().toISOString() }],
    now: new Date().toISOString(),
  })));
  writeFileSync(join(taskDir, ".pidock-creation"), taskId);

  return { root, taskDir, worktree: join(taskDir, "repo"), docsDir, externalDir, taskId };
}

async function stubRuntime(cacheDir: string): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    authPath: join(cacheDir, ".pidock-sdk-auth.json"),
    modelsPath: join(cacheDir, ".pidock-sdk-models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const provider: Provider<"pidock-local-test"> = {
    id: model.provider,
    name: "Fixture",
    auth: { apiKey: { name: "Local", resolve: async () => ({ auth: {} }) } },
    getModels: () => [model],
    stream: (_model, context, options) => provider.streamSimple(_model, context, options),
    streamSimple: (_model, context) => {
      const messages = context.messages as { role: string; content: unknown }[];
      const text = (value: unknown): string => typeof value === "string" ? value
        : Array.isArray(value) ? (value as { type: string; text?: string }[]).filter((part) => part.type === "text").map((part) => part.text ?? "").join("") : "";
      const lastToolResult = messages.at(-1)?.role === "toolResult" ? messages.at(-1) : undefined;
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      const partial: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [], usage, stopReason: "pending", timestamp: Date.now() };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial });
        if (lastToolResult) {
          const reply = `tool-result:${text(lastToolResult.content)}`;          partial.content.push({ type: "text", text: reply });
          stream.push({ type: "text_start", contentIndex: 0, partial });
          stream.push({ type: "text_end", contentIndex: 0, content: reply, partial });
          stream.push({ type: "done", reason: "stop", message: { ...partial, stopReason: "stop" } });
          return;
        }
        const call = JSON.parse(text(lastUser?.content ?? "")) as { tool: string; args: Record<string, unknown> };
        const toolCall = { type: "toolCall" as const, id: "stub-call", name: call.tool, arguments: call.args };
        partial.content.push(toolCall);
        stream.push({ type: "toolcall_start", contentIndex: 0, partial });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
        stream.push({ type: "done", reason: "toolUse", message: { ...partial, stopReason: "toolUse" } });
      });
      return stream;
    },
  };
  runtime.registerNativeProvider(provider);
  return runtime;
}

interface Harness {
  host: TaskWorkspaceHost;
  fixture: Fixture;
  prompt(tool: string, args: Record<string, unknown>): Promise<{ state: string; text: string }>;
}

async function harness(): Promise<Harness> {
  const parts = fixture();
  const runtime = await stubRuntime(parts.taskDir);
  const store = memoryTaskStore();
  store.tasks.set(parts.taskDir, readTaskRecordOnDisk(parts.taskDir)!);
  const host = new TaskWorkspaceHost(
    parts.taskId, parts.taskDir, store, () => "2026-09-22T10:00:00+08:00",
    () => [], undefined, undefined, undefined, undefined,
    (contextOptions: SdkContextOptions) => {
      const caller = contextOptions.toolHost;
      if (!caller) throw new Error("tool-host-missing");
      const kernel = new PiSdkTextKernel(parts.taskId, parts.taskDir, {
        model, modelRuntime: runtime,
        callTool: (sessionId, request) => caller.call(sessionId, request),
      });
      return {
        open: (sessionId: string) => kernel.open(sessionId),
        prompt: (sessionId: string, text: string, deliver?: Parameters<SdkContextClient["prompt"]>[2], issuedTurnId?: string) =>
          kernel.prompt(sessionId, text, deliver, issuedTurnId),
        cancel: (sessionId: string) => kernel.cancel(sessionId),
        seal: () => {},
        dispose: () => kernel.dispose(),
      } as unknown as SdkContextClient;
    },
  );
  let turn = 0;
  return {
    host,
    fixture: parts,
    async prompt(tool, args) {
      turn += 1;
      const issued = `00000000-0000-4000-8000-${String(turn).padStart(12, "0")}`;
      const result = await host.sdkTextKernel().prompt("main", JSON.stringify({ tool, args }), undefined, issued);
      return { state: result.state, text: result.text };
    },
  };
}

async function ready(): Promise<Harness> {
  const h = await harness();
  await h.host.configureSdkProvider({ config: PROVIDER_CONFIG, credential: "synthetic-key" });
  await h.host.setPermission("main", "auto");
  return h;
}

it("lists, searches, reads and writes a plain-directory link through the Agent surface, changing the original", async () => {
  const h = await ready();
  const link = LINK_NAME;
  const docsDir = h.fixture.docsDir;

  // Enumerate the link (fs.search without a pattern lists the directory).
  const listed = await h.prompt("fs.search", { path: link });
  expect(listed.text).toContain("spec.txt");
  expect(listed.text).toContain("nested");

  // Search inside the link.
  const searched = await h.prompt("fs.search", { path: link, pattern: "shared spec" });
  expect(searched.text).toContain("spec.txt:1: shared spec content");

  // Read a file through the link.
  const read = await h.prompt("fs.read", { path: `${link}/spec.txt` });
  expect(read.text).toContain("shared spec content");

  // Write through the link: the ORIGINAL file changes, nothing is copied.
  const written = await h.prompt("fs.write", { path: `${link}/spec.txt`, content: "rewritten through the link\n" });
  expect(written.text).toContain("Successfully wrote");
  expect(readFileSync(join(docsDir, "spec.txt"), "utf8")).toBe("rewritten through the link\n");
  // No per-task copy was made: the link is still a symlink to the same original.
  expect(existsSync(join(h.fixture.taskDir, LINK_NAME))).toBe(true);
  expect(readFileSync(join(h.fixture.taskDir, LINK_NAME, "spec.txt"), "utf8")).toBe("rewritten through the link\n");

  await h.host.shutdownSdk();
});

it("refuses the original path named directly and a link inside it that leaves the original", async () => {
  const h = await ready();
  // The Agent reaches the shared files only through the in-task link name: the
  // raw original is outside the task and stays refused.
  const direct = await h.prompt("fs.read", { path: join(h.fixture.docsDir, "spec.txt") });
  expect(direct.text).toContain("tool-refused:");
  // A link inside the shared original that points out of it is refused.
  const escape = await h.prompt("fs.read", { path: `${LINK_NAME}/escape-out/outside.txt` });
  expect(escape.text).toContain("tool-refused:out-of-scope");
  await h.host.shutdownSdk();
});

it("reports a dangling link target honestly instead of returning empty content", async () => {
  const h = await ready();
  // Simulate the original moving away after the link was recorded.
  rmSync(h.fixture.docsDir, { recursive: true, force: true });

  const read = await h.prompt("fs.read", { path: `${LINK_NAME}/spec.txt` });
  expect(read.text).toContain("tool-refused:not-found");

  const listed = await h.prompt("fs.search", { path: LINK_NAME });
  expect(listed.text).toContain("tool-refused:not-found");
  await h.host.shutdownSdk();
});

it("resolveSdkAgentToolPath keys a shared link to its recorded original and rejects an escaping one", () => {
  const f = fixture();
  const scope = {
    taskDir: f.taskDir,
    taskRoot: f.root,
    worktrees: [{ repoDir: "repo", path: f.worktree }],
    sharedDirs: [{ linkName: LINK_NAME, path: join(f.taskDir, LINK_NAME), sourcePath: f.docsDir }],
    primaryCheckouts: [],
    assertProtected: () => undefined,
  };
  const resolveRealPath = (path: string) => {
    try { return realpathSync(path); } catch { return path; }
  };
  const inside = resolveSdkAgentToolPath({ scope, resolveRealPath, requested: `${LINK_NAME}/spec.txt`, base: f.taskDir, mode: "write" });
  expect(inside.ok).toBe(true);
  expect(inside.ok && inside.real).toBe(join(realpathSync(f.docsDir), "spec.txt"));
  const escape = resolveSdkAgentToolPath({ scope, resolveRealPath, requested: `${LINK_NAME}/escape-out/outside.txt`, base: f.taskDir, mode: "read" });
  expect(escape.ok).toBe(false);
  expect(!escape.ok && escape.code).toBe("tool-refused:out-of-scope");
  const raw = resolveSdkAgentToolPath({ scope, resolveRealPath, requested: join(f.docsDir, "spec.txt"), base: f.taskDir, mode: "read" });
  expect(raw.ok).toBe(false);
});
