/**
 * A real conversation that uses a selected local skill — [Pencil T16] #151.
 *
 * The pane tests show rows; this file proves the rows are real. It builds the
 * fixture skill on disk (`SKILL.md` + a relative resource file), stores the
 * source through the real app-private `SkillSourceStore`, and runs the REAL Pi
 * 1.5 SDK kernel against a loopback `openai-completions` endpoint. Nothing here
 * hand-builds the skill listing: it is `formatSkillsForPrompt` over
 * `loadSkillsFromDir`, which is the same code path a session uses in production.
 *
 * Covered by the exact request the SDK sent:
 *
 * 1. the skill is advertised by name, description and absolute location, and
 *    the full `SKILL.md` body is NOT in the prompt (Pi loads it lazily)
 * 2. the explicit request expands it: the tool result carries the instructions
 *    exactly once, and the relative resource (`references/format.md`) resolves
 *    against the skill directory from that location
 * 3. restoring the session re-opens the same transcript without re-injecting or
 *    re-executing anything
 * 4. switching a source off reaches only a NEW session: the running one keeps
 *    the skills it started with
 * 5. the skill cannot widen the Host tool surface: the same declared tools are
 *    active with and without it (a skill's `allowed-tools` changes nothing)
 * 6. a broken sibling source keeps an invalid state and does not take the valid
 *    source (or the turn) down with it
 */

import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { createExplicitTextRuntime, isCredentialEnvName, type ExplicitTextProvider } from "./explicit-text-provider.js";
import { buildTaskDiskRecord, serializeTaskRecord } from "./task-store.js";
import { PiSdkTextKernel } from "./sdk-text-kernel.js";
import { SDK_AGENT_TOOL_NAMES, type SdkAgentToolOutcome } from "./sdk-agent-tool-contract.js";
import { SdkAgentToolBroker, type SdkAgentToolChannel, type SdkAgentToolScope } from "./sdk-agent-tool-broker.js";

import { SkillSourceStore } from "../main/skill-source-store.js";

/** `realpath` of the deepest existing ancestor + the rest (the broker's contract). */
function realpathDeep(path: string): string {
  const { existsSync, realpathSync } = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const { basename, dirname } = process.getBuiltinModule("node:path") as typeof import("node:path");
  const suffix: string[] = [];
  let current = path.trim();
  while (current.length > 0 && !existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    suffix.unshift(basename(current));
    current = parent;
  }
  let resolved = current;
  try { resolved = realpathSync(current); } catch { resolved = current; }
  return suffix.length > 0 ? `${resolved.replace(/[\\/]+$/, "")}/${suffix.join("/")}` : resolved;
}

const CREDENTIAL = "sk-loopback-skills-0123456789abcdef";
const roots: string[] = [];

const savedIsolation = process.env["PIDOCK_SDK_ISOLATED"];
const savedCredentials = Object.entries(process.env).filter(([name]) => isCredentialEnvName(name)) as [string, string][];
beforeAll(() => {
  process.env["PIDOCK_SDK_ISOLATED"] = "1";
  for (const [name] of savedCredentials) delete process.env[name];
});
afterAll(() => {
  if (savedIsolation === undefined) delete process.env["PIDOCK_SDK_ISOLATED"];
  else process.env["PIDOCK_SDK_ISOLATED"] = savedIsolation;
  for (const [name, value] of savedCredentials) process.env[name] = value;
});
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });

const SKILL_BODY = "Read references/format.md before answering. Then answer with the word ORCHID.";
const RESOURCE_BODY = "FORMAT-MARKER-7Q: tables first, then prose.";

function fixture(): { dir: string; skillDir: string; appDir: string; sourcePath: string; store: SkillSourceStore } {
  const root = mkdtempSync(join(tmpdir(), "pidock-skill-turn-"));
  roots.push(root);
  const dir = join(root, "task");
  const appDir = join(root, "app");
  mkdirSync(dir);
  mkdirSync(appDir);
  execFileSync("git", ["init", "-q", dir], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TEMPLATE_DIR: "" } });
  writeFileSync(join(dir, "task.json"), serializeTaskRecord(buildTaskDiskRecord({
    taskId: "task-skills", name: "task-skills", dirId: "task-skills", branch: "main", root, taskDir: dir,
    remoteBranch: "main", baseCommit: "test", repos: [], now: new Date().toISOString(),
  })));
  const skillDir = join(dir, "skills", "pdf-tools");
  mkdirSync(join(skillDir, "references"), { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), [
    "---",
    "name: pdf-tools",
    "description: Extract text from PDF files. Use when reading or inspecting a PDF.",
    "allowed-tools:",
    "  - bash",
    "---",
    "",
    SKILL_BODY,
    "",
  ].join("\n"));
  writeFileSync(join(skillDir, "references", "format.md"), `${RESOURCE_BODY}\n`);
  const store = new SkillSourceStore(appDir);
  const added = store.add(join(dir, "skills"));
  if (!added.ok) throw new Error(added.error);
  return { dir, skillDir, appDir, sourcePath: join(dir, "skills"), store };
}

function configFor(port: number): ExplicitTextProvider {
  return {
    profileId: "p-151", protocol: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1`,
    modelId: "fixture-model",
    models: [{ id: "fixture-model", name: "Fixture Model", contextWindow: 32768, maxTokens: 2048, reasoning: false }],
    contextWindow: 32768, maxTokens: 2048, credentialSource: "store", authRef: "p-151", generation: 1,
  };
}

function messageText(message: { content: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as { type: string; text?: string }[]).filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sse(response: ServerResponse, delta: Record<string, unknown>, finish: string, usage = { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 }) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  response.write(`data: ${JSON.stringify({ id: "chat-1", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: "chat-1", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: "chat-1", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [], usage })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function toolCall(response: ServerResponse, name: string, args: Record<string, unknown>) {
  sse(response, { tool_calls: [{ id: `call_${name.replace(".", "_")}_${Math.random().toString(16).slice(2, 8)}`, function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
}

/** The Host tool seam, reading real files (a scripted `fs.read`). */
function readTool(): (sessionId: string, request: { tool: string; args: unknown }) => Promise<SdkAgentToolOutcome> {
  return async (_sessionId, request) => {
    const args = (request.args ?? {}) as { path?: unknown };
    if (request.tool !== "fs.read" || typeof args.path !== "string") return { outcome: "refused", code: "tool-refused:invalid-args", text: "unsupported" };
    try {
      return { outcome: "ok", text: readFileSync(args.path, "utf8") };
    } catch {
      return { outcome: "refused", code: "tool-refused:read-failed", text: "read failed" };
    }
  };
}

it("advertises the scanned skill, expends it once for the explicit request and resolves its relative resource", async () => {
  const { dir, skillDir, appDir, store } = fixture();
  // The pane's own scan is what the session sees: one valid skill, resources listed.
  const scan = store.view();
  expect(scan.state).toBe("ok");
  expect(scan.sources[0]?.skills.map((skill) => [skill.name, skill.status, skill.resources])).toEqual([
    ["pdf-tools", "ok", [{ path: "references/format.md", bytes: RESOURCE_BODY.length + 1 }]],
  ]);

  const requests: { messages: { role: string; content: unknown }[]; tools?: unknown }[] = [];
  let turn = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const parsed = await body(request);
      requests.push({ messages: (parsed["messages"] ?? []) as { role: string; content: unknown }[], tools: parsed["tools"] });
      turn += 1;
      // 1: list the skill (no reading yet) → the model opens SKILL.md, then
      // 2: the skill's own instruction sends it to the relative resource, then
      // 3: a plain answer.
      if (turn === 1) return toolCall(response, "fs.read", { path: join(skillDir, "SKILL.md") });
      if (turn === 2) return toolCall(response, "fs.read", { path: join(skillDir, "references", "format.md") });
      sse(response, { content: "loaded ORCHID" }, "stop");
    })();
  });
  const port = await listen(server);
  try {
    const { runtime, model, bindingIdentity } = await createExplicitTextRuntime(configFor(port), CREDENTIAL);
    const kernel = new PiSdkTextKernel("task-skills", dir, {
      model, modelRuntime: runtime, bindingIdentity, callTool: readTool(),
      skillSourcesFile: join(appDir, "skill-sources.json"),
    });
    const opening = await kernel.open("main");
    // 5: the skill adds context, never a tool: the declared set is unchanged.
    expect(opening.tools).toEqual([...SDK_AGENT_TOOL_NAMES]);

    const result = await kernel.prompt("main", "extract the pdf");
    expect(result).toMatchObject({ state: "done", text: "loaded ORCHID" });
    expect(requests).toHaveLength(3);

    // 1: name + description + absolute location, and NOT the instructions yet.
    const prompt = messageText(requests[0]!.messages[0]!);
    expect(prompt).toContain("The following skills provide specialized instructions");
    expect(prompt).toContain("<name>pdf-tools</name>");
    expect(prompt).toContain("<description>Extract text from PDF files.");
    expect(prompt).toContain(`<location>${join(skillDir, "SKILL.md")}</location>`);
    expect(prompt).not.toContain("Read references/format.md before answering");
    // The skill's declared `allowed-tools` never becomes a Host tool.
    expect((requests[0]!.tools as { function: { name: string } }[]).map((tool) => tool.function.name).sort())
      .toEqual([...SDK_AGENT_TOOL_NAMES].sort());

    // 2: the explicit request expanded SKILL.md once, through the real tool call.
    const afterExpand = requests[1]!.messages;
    const loadedSkill = afterExpand.filter((message) => message.role === "tool" || (message as { role: string }).role === "toolResult");
    expect(JSON.stringify(loadedSkill)).toContain(SKILL_BODY);
    expect(afterExpand.filter((message) => messageText(message).includes(SKILL_BODY))).toHaveLength(1);

    // 3: the relative resource resolved against the skill directory and reached
    // the model on the next request.
    expect(JSON.stringify(requests[2]!.messages)).toContain(RESOURCE_BODY);
    expect(JSON.stringify(requests[2]!.messages).split(SKILL_BODY)).toHaveLength(2);

    // 3: the transcript kept both tool results exactly once; the system prompt
    // is rebuilt per request, never appended to the history.
    const jsonl = readFileSync(opening.file, "utf8");
    expect(jsonl.split(RESOURCE_BODY).length).toBe(2);

    // 4: restore = open the same transcript; nothing is re-injected or re-run.
    const before = kernel.projection("main").messages.length;
    await kernel.dispose();
    const restored = new PiSdkTextKernel("task-skills", dir, {
      model, modelRuntime: runtime, bindingIdentity, callTool: readTool(),
      skillSourcesFile: join(appDir, "skill-sources.json"),
    });
    await restored.open("main");
    expect(restored.projection("main").messages.length).toBe(before);
    const restoredPrompt = await restored.prompt("main", "continue");
    expect(restoredPrompt.state).toBe("done");
    // The re-opened session re-advertises the skill once in its own prompt and
    // does not duplicate the skill body it already has in the transcript.
    const lastRequest = requests.at(-1)!;
    expect(messageText(lastRequest.messages[0]!).split("<name>pdf-tools</name>").length).toBe(2);
    expect(JSON.stringify(lastRequest.messages).split(SKILL_BODY)).toHaveLength(2);
    await restored.dispose();
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it("applies a source toggle at the next session only and keeps a broken sibling named", async () => {
  const { dir, appDir, store, sourcePath } = fixture();
  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const parsed = await body(request);
      requests.push({ messages: (parsed["messages"] ?? []) as { role: string; content: unknown }[] });
      sse(response, { content: "ok" }, "stop");
    })();
  });
  const port = await listen(server);
  try {
    // A second source whose SKILL.md has no description: Pi refuses it, the
    // pane shows it as invalid, and the valid source still loads.
    const brokenDir = join(dir, "broken-skills", "no-description");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "SKILL.md"), "---\nname: no-description\n---\n\nno description here\n");
    const added = store.add(join(dir, "broken-skills"));
    expect(added.ok).toBe(true);
    const view = store.view();
    const broken = view.sources.find((source) => source.path === join(dir, "broken-skills"));
    expect(broken?.skills.map((skill) => [skill.name, skill.status])).toEqual([["no-description", "invalid"]]);
    expect(broken?.skills[0]?.reason).toContain("description");

    const { runtime, model, bindingIdentity } = await createExplicitTextRuntime(configFor(port), CREDENTIAL);
    const selection = () => ({ model, modelRuntime: runtime, bindingIdentity, callTool: readTool(), skillSourcesFile: join(appDir, "skill-sources.json") });

    // Session A starts with the source enabled.
    const first = new PiSdkTextKernel("task-skills", dir, selection());
    await first.open("main");
    expect(await first.prompt("main", "hello")).toMatchObject({ state: "done" });
    expect(messageText(requests.at(-1)!.messages[0]!)).toContain("<name>pdf-tools</name>");
    expect(messageText(requests.at(-1)!.messages[0]!)).not.toContain("no-description");

    // Switch the source off: the app-private list changes, the started session
    // keeps the skills it started with (it is never mutated mid-run).
    expect(store.setEnabled(view.sources.find((source) => source.path === sourcePath)!.id, false).ok).toBe(true);
    expect(await first.prompt("main", "still there?")).toMatchObject({ state: "done" });
    expect(messageText(requests.at(-1)!.messages[0]!)).toContain("<name>pdf-tools</name>");

    // A NEW session sees the disabled list: no skill block, and the turn works.
    await first.dispose();
    const second = new PiSdkTextKernel("task-skills", dir, selection());
    await second.open("other");
    expect(await second.prompt("other", "hello again")).toMatchObject({ state: "done" });
    expect(messageText(requests.at(-1)!.messages[0]!)).not.toContain("<available_skills>");
    await second.dispose();
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

/**
 * The #151 acceptance gap: a source the user added lives OUTSIDE the task, so
 * the advertised `SKILL.md` used to be refused by the task-scoped `fs.read`
 * broker. This runs the real SDK kernel against the real broker: the model is
 * advertised the external location, reads it through the Host, then follows the
 * skill's own relative reference - while a write to the same source is still
 * refused and changes nothing on disk.
 */
it("loads a skill from an external source through the real broker, refusing a write to it", async () => {
  const root = mkdtempSync(join(tmpdir(), "pidock-skill-external-"));
  roots.push(root);
  const tasksRoot = join(root, "tasks");
  const dir = join(tasksRoot, "task");
  const appDir = join(root, "app");
  mkdirSync(dir, { recursive: true });
  mkdirSync(appDir, { recursive: true });
  execFileSync("git", ["init", "-q", dir], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TEMPLATE_DIR: "" } });
  writeFileSync(join(dir, "task.json"), serializeTaskRecord(buildTaskDiskRecord({
    taskId: "task-skills", name: "task-skills", dirId: "task-skills", branch: "main", root: tasksRoot, taskDir: dir,
    remoteBranch: "main", baseCommit: "test", repos: [], now: new Date().toISOString(),
  })));
  // The source is a real directory outside the task folder - the usual case for
  // a folder the user added through 能力管理 → Skills.
  const externalSource = join(root, "external-skills");
  const skillDir = join(externalSource, "pdf-tools");
  mkdirSync(join(skillDir, "references"), { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: pdf-tools\ndescription: Extract text from PDF files.\n---\n\n${SKILL_BODY}\n`);
  writeFileSync(join(skillDir, "references", "format.md"), `${RESOURCE_BODY}\n`);
  const store = new SkillSourceStore(appDir);
  expect(store.add(externalSource).ok).toBe(true);
  const configFile = join(appDir, "skill-sources.json");

  const scope: SdkAgentToolScope = {
    taskDir: dir, taskRoot: tasksRoot, worktrees: [], primaryCheckouts: [], assertProtected: () => {},
  };
  const channel: SdkAgentToolChannel = {
    currentPermission: "auto",
    previewGate: () => ({ verdict: "allow" }),
    gate: () => ({ verdict: "allow" }),
    consumeApproval: () => true,
    reject: () => {},
    snapshot: () => ({ approvals: [] }),
  };
  const broker = new SdkAgentToolBroker({
    sessionKnown: (sessionId) => sessionId === "main",
    channel: () => channel,
    persist: () => {},
    write: { claimWrite: () => ({ ok: true, claimId: "claim-1" }), releaseWrite: () => {} },
    scope: () => scope,
    resolveRealPath: realpathDeep,
    skillSourcesFile: () => configFile,
    closing: () => false,
  });

  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  let turn = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const parsed = await body(request);
      requests.push({ messages: (parsed["messages"] ?? []) as { role: string; content: unknown }[] });
      turn += 1;
      if (turn === 1) return toolCall(response, "fs.read", { path: join(skillDir, "SKILL.md") });
      if (turn === 2) return toolCall(response, "fs.read", { path: join(skillDir, "references", "format.md") });
      sse(response, { content: "external ORCHID" }, "stop");
    })();
  });
  const port = await listen(server);
  try {
    const { runtime, model, bindingIdentity } = await createExplicitTextRuntime(configFor(port), CREDENTIAL);
    const kernel = new PiSdkTextKernel("task-skills", dir, {
      model, modelRuntime: runtime, bindingIdentity,
      callTool: (sessionId, request) => broker.call(sessionId, request),
      skillSourcesFile: configFile,
    });
    await kernel.open("main");
    const result = await kernel.prompt("main", "extract the pdf");
    expect(result).toMatchObject({ state: "done", text: "external ORCHID" });
    expect(requests).toHaveLength(3);

    // The external location is advertised, and the instructions are still not
    // injected until the model asks for them.
    const prompt = messageText(requests[0]!.messages[0]!);
    expect(prompt).toContain("<name>pdf-tools</name>");
    expect(prompt).toContain(`<location>${join(skillDir, "SKILL.md")}</location>`);
    expect(prompt).not.toContain("Read references/format.md before answering");

    // The real broker served the external SKILL.md and then its relative resource.
    expect(JSON.stringify(requests[1]!.messages)).toContain(SKILL_BODY);
    expect(JSON.stringify(requests[2]!.messages)).toContain(RESOURCE_BODY);

    // The grant is read-only: the same source is still not writable, and the
    // bytes on disk did not change.
    const prior = readFileSync(join(skillDir, "SKILL.md"), "utf8");
    const written = await broker.call("main", { tool: "fs.write", args: { path: join(skillDir, "SKILL.md"), content: "replaced" } });
    expect(written).toMatchObject({ outcome: "refused", code: "tool-refused:out-of-scope" });
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toBe(prior);
    await kernel.dispose();
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
