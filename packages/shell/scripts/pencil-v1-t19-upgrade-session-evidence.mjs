// [PiDock pencil-v1] (#154 / T19) Upgrade evidence: open reconstructed Pi
// 0.87.1 / 1.4.0 session backups through the production Host/SDK 1.5.0 session
// path in a temp task dir, prove the backup is not written, append a real new
// turn, and cold-read the result in a second process.
//
// Run after `pnpm build` (Node 24.21.0):
//   node packages/shell/scripts/pencil-v1-t19-upgrade-session-evidence.mjs
//
// The real path used here is the compiled production `SdkContextClient` +
// `sdk-context-worker.js` (node:worker_threads) + `PiSdkTextKernel` + the pinned
// `@earendil-works/pi-coding-agent@1.5.0` SessionManager. The only test double is
// the model endpoint: a loopback OpenAI-compatible SSE server on 127.0.0.1 (there
// is no real account in this environment), and the temp task dir.
//
// It never reads or writes ~/.pi/agent, never touches a real user session, and
// every fixture under docs/evidence/.../fixtures is hashed before and after.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const outDir = join(repoRoot, "docs/evidence/pencil-v1-t19-upgrade");
const fixturesDir = join(outDir, "fixtures");
const writeDir = join(outDir, "written");

// The production context is credential-isolated; the evidence process prepares
// the same precondition the Host does (no ambient credential can be consulted).
process.env["PIDOCK_SDK_ISOLATED"] = "1";
const {
  SdkContextClient,
} = await import("../dist/host/sdk-context-client.js");
const { PiSdkTextKernel } = await import("../dist/host/sdk-text-kernel.js");
const { explicitBindingIdentity, isCredentialEnvName } = await import("../dist/host/explicit-text-provider.js");
const { buildTaskDiskRecord, serializeTaskRecord } = await import("../dist/host/task-store.js");
for (const name of Object.keys(process.env)) if (isCredentialEnvName(name)) delete process.env[name];

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const sha256File = (path) => sha256(readFileSync(path));
const nowIso = () => new Date().toISOString();
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

const PROFILE_ID = "upgrade";
const MODEL_ID = "upgrade-chat";
const CREDENTIAL = "sk-upgrade-154-evidence-only";
const FIXTURES = [
  { label: "0.87.1", file: "pi-0.87.1-session.jsonl", thinkingLevel: "off",
    unknownFields: ["replace", "futureVendorField", "future_extension_state"] },
  { label: "1.4.0", file: "pi-1.4.0-session.jsonl", thinkingLevel: "high",
    unknownFields: ["futureVendorField", "futureMessageField", "pi.virtual-model-state"] },
];

// ------------------------------------------------------------------ loopback model
// The only non-real component: an OpenAI-compatible SSE endpoint on 127.0.0.1.
// It records every request so "no model request on open/reopen" is measured, not
// assumed. It never sees a real credential beyond the synthetic one.
function startLoopback() {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, body });
      if (request.method === "GET" && String(request.url).endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model", owned_by: PROFILE_ID }] }));
        return;
      }
      if (!String(request.url).endsWith("/chat/completions")) { response.writeHead(404).end(); return; }
      const parsed = (() => { try { return JSON.parse(body); } catch { return null; } })();
      const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
      const lastUser = [...messages].reverse().find((row) => row?.role === "user");
      const text = typeof lastUser?.content === "string" ? lastUser.content
        : Array.isArray(lastUser?.content) ? lastUser.content.map((block) => block?.text ?? "").join("") : "";
      const frame = (delta, extra = {}) => `data: ${JSON.stringify({
        id: "chatcmpl-upgrade-154", object: "chat.completion.chunk", model: MODEL_ID,
        choices: [{ index: 0, delta, finish_reason: null }], ...extra,
      })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      response.write(frame({ role: "assistant", content: "" }));
      const answer = text.includes("升级后继续") ? "T19-UPGRADE-TURN-DONE 历史仍在。" : "T19-UPGRADE-UNEXPECTED";
      response.write(frame({ content: answer }));
      response.write(`data: ${JSON.stringify({ id: "chatcmpl-upgrade-154", object: "chat.completion.chunk", model: MODEL_ID,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 37, completion_tokens: 11, total_tokens: 48 } })}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  return new Promise((resolvePromise, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolvePromise({ server, requests, port });
    });
  });
}

function providerConfig(port) {
  return {
    profileId: PROFILE_ID,
    protocol: "openai-completions",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    modelId: MODEL_ID,
    models: [{ id: MODEL_ID, name: "Upgrade Chat", contextWindow: 65536, maxTokens: 4096, reasoning: true }],
    contextWindow: 65536,
    maxTokens: 4096,
    credentialSource: "store",
    authRef: PROFILE_ID,
    generation: 1,
  };
}

function taskRecord(taskId, taskDir) {
  return buildTaskDiskRecord({
    taskId, name: taskId, dirId: taskId, branch: "main", root: dirname(taskDir), taskDir,
    remoteBranch: "main", baseCommit: "synthetic-upgrade-fixture", repos: [], now: nowIso(),
  });
}

/** Copy the fixture into the temp task as the same task dir it was written in, then bind it. */
function installBackup({ fixturePath, taskId, taskDir, label, thinkingLevel, bindingIdentity }) {
  const sourceRaw = readFileSync(fixturePath);
  const text = sourceRaw.toString("utf8");
  const substituted = text.replaceAll("__PIDOCK_TASK_DIR__", taskDir.replaceAll("\\", "\\\\"));
  if (!substituted.includes(taskDir)) throw new Error(`fixture ${label} did not carry the task-dir placeholder`);
  const lines = substituted.trimEnd().split("\n");
  const header = JSON.parse(lines[0]);
  if (header.type !== "session" || header.version !== 3) throw new Error(`fixture ${label} is not a v3 session header`);
  const sessionDir = join(taskDir, ".pidock-sdk-sessions", "main");
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(taskDir, ".pidock-sdk-agent"), { recursive: true, mode: 0o700 });
  mkdirSync(join(taskDir, ".pidock-sdk-context-home"), { recursive: true, mode: 0o700 });
  const file = `sdk-${header.id}.jsonl`;
  const workingFile = join(sessionDir, file);
  writeFileSync(workingFile, substituted, { flag: "wx", mode: 0o600 });
  writeFileSync(join(sessionDir, "binding.json"), JSON.stringify({
    taskId, sessionId: "main", sdkId: header.id, file, bindingIdentity, modelId: MODEL_ID, thinkingLevel,
  }), { flag: "wx", mode: 0o600 });
  return { sourceRaw, sourceSha256: sha256(sourceRaw), sourceBytes: sourceRaw.length, workingFile, header, entryLines: lines.length };
}

const parseJsonl = (text) => text.trimEnd().split("\n").map((line) => JSON.parse(line));
const entryBaseOk = (entry) => typeof entry.type === "string" &&
  (entry.type === "session" || (typeof entry.id === "string" && (entry.parentId === null || typeof entry.parentId === "string") &&
    typeof entry.timestamp === "string" && !Number.isNaN(Date.parse(entry.timestamp))));

async function oneFixture(fixture, shared) {
  const taskId = `t19-upgrade-${fixture.label.replaceAll(".", "-")}`;
  const root = mkdtempSync(join(tmpdir(), `pidock-upgrade-${fixture.label.replaceAll(".", "-")}-`));
  const taskDir = join(root, taskId);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "task.json"), serializeTaskRecord(taskRecord(taskId, taskDir)));
  const config = providerConfig(shared.port);
  const bindingIdentity = explicitBindingIdentity(/** @type {any} */ (config));
  const installed = installBackup({
    fixturePath: join(fixturesDir, fixture.file), taskId, taskDir, label: fixture.label,
    thinkingLevel: fixture.thinkingLevel, bindingIdentity,
  });

  const beforeOpen = sha256File(installed.workingFile);
  const requestBase = shared.requests.length;
  let toolCalls = 0;
  const toolHost = {
    call: async () => {
      toolCalls += 1;
      return { outcome: "refused", code: "tool-refused:upgrade-evidence", text: "no tool may run while opening a backup" };
    },
  };
  const client = new SdkContextClient({
    task: { taskId, taskDir }, config: /** @type {any} */ (config), credential: CREDENTIAL,
    ...(fixture.thinkingLevel === undefined ? {} : { thinkingLevel: fixture.thinkingLevel }),
    toolHost: /** @type {any} */ (toolHost),
  });
  const opened = await client.open("main");
  const afterOpen = sha256File(installed.workingFile);
  const requestsAfterOpen = shared.requests.length - requestBase;

  // The read-only production projection/digest path (no model, no auth).
  const reader = new PiSdkTextKernel(taskId, taskDir);
  const projectionBefore = reader.projection("main");
  const digestBefore = reader.digest("main");

  const promptText = "升级后继续：用一句话确认历史还在。";
  const turn = await client.prompt("main", promptText);
  const afterPrompt = sha256File(installed.workingFile);
  const requestsAfterPrompt = shared.requests.length - requestBase;
  const fileText = readFileSync(installed.workingFile, "utf8");
  const entries = parseJsonl(fileText);
  const appended = entries.slice(installed.entryLines);
  const appendedOk = appended.length > 0 && appended.every(entryBaseOk);
  const appendedMessages = appended.filter((entry) => entry.type === "message").map((entry) => entry.message.role);
  const appendedAssistant = appended.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
  const currentFormat = appendedOk &&
    appended.every((entry) => entry.type === "session" ? false : true) &&
    appendedMessages.includes("user") && appendedMessages.includes("assistant") &&
    appendedAssistant.every((entry) => typeof entry.message.model === "string" && typeof entry.message.provider === "string" &&
      typeof entry.message.stopReason === "string" && entry.message.usage && typeof entry.message.usage === "object");

  // Cold re-open of the SAME file in a fresh production context: no model call,
  // no tool call, history includes the new turn.
  await client.dispose();
  const requestsBeforeReopen = shared.requests.length;
  const toolCallsBeforeReopen = toolCalls;
  const reopenedClient = new SdkContextClient({
    task: { taskId, taskDir }, config: /** @type {any} */ (config), credential: CREDENTIAL,
    ...(fixture.thinkingLevel === undefined ? {} : { thinkingLevel: fixture.thinkingLevel }),
    toolHost: /** @type {any} */ (toolHost),
  });
  await reopenedClient.open("main");
  const requestsDuringReopen = shared.requests.length - requestsBeforeReopen;
  const toolCallsDuringReopen = toolCalls - toolCallsBeforeReopen;
  const projectionAfter = new PiSdkTextKernel(taskId, taskDir).projection("main");
  await reopenedClient.dispose();

  // Second PROCESS cold read of the appended JSONL.
  const cold = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--cold-read", installed.workingFile, taskDir], {
    encoding: "utf8", timeout: 120000,
  });
  let coldRead = null;
  try { coldRead = JSON.parse(cold.stdout.trim().split("\n").at(-1)); } catch { coldRead = null; }

  // Keep evidence of the exact file 1.5 wrote (synthetic content only).
  const writtenName = `${fixture.label.replaceAll(".", "-")}-after-1.5.jsonl`;
  copyFileSync(installed.workingFile, join(writeDir, writtenName));

  const record = {
    label: fixture.label,
    fixture: `fixtures/${fixture.file}`,
    sourceSha256: installed.sourceSha256,
    sourceBytes: installed.sourceBytes,
    workingFile: installed.workingFile,
    workingSha256BeforeOpen: beforeOpen,
    workingSha256AfterOpen: afterOpen,
    workingSha256AfterTurn: afterPrompt,
    openWroteBytes: beforeOpen !== afterOpen,
    taskDir,
    header: installed.header,
    binding: JSON.parse(readFileSync(join(taskDir, ".pidock-sdk-sessions", "main", "binding.json"), "utf8")),
    cwdSubstitution: { placeholder: "__PIDOCK_TASK_DIR__", replacement: taskDir, note: "only on the working copy; the fixture itself is never modified" },
    opened,
    history: {
      projectionBefore,
      digestBefore,
      turns: digestBefore.turns,
      roles: projectionBefore.messages.map((message) => message.role),
      texts: projectionBefore.messages.map((message) => message.text),
    },
    noReplay: {
      modelRequestsAfterOpen: requestsAfterOpen,
      toolCallsAfterOpen: toolCalls,
      modelRequestsDuringReopen: requestsDuringReopen,
      toolCallsDuringReopen: toolCallsDuringReopen,
      projectionAfter,
    },
    turn: {
      state: turn.state,
      text: turn.text,
      error: turn.error ?? null,
      modelRequestsAfterPrompt: requestsAfterPrompt,
      toolCallsAfterPrompt: toolCalls,
      appendedLineCount: appended.length,
      appendedTypes: appended.map((entry) => entry.type),
      appendedMessageRoles: appendedMessages,
      appended: appended.map((entry) => entry.type === "message"
        ? { type: entry.type, id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp,
            role: entry.message.role, model: entry.message.model ?? null, provider: entry.message.provider ?? null,
            stopReason: entry.message.stopReason ?? null, thinkingLevel: entry.message.thinkingLevel ?? null }
        : { type: entry.type, id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp }),
    },
    checks: {
      fixtureSourceUnchanged: sha256File(join(fixturesDir, fixture.file)) === installed.sourceSha256,
      workingCopyUnchangedByOpen: beforeOpen === afterOpen,
      noModelRequestOnOpenOrRead: requestsAfterOpen === 0,
      noToolExecutionOnOpen: toolCalls === 0,
      newTurnAppendedInCurrentV3Format: currentFormat,
      noModelRequestOnColdReopen: requestsDuringReopen === 0,
      noToolExecutionOnColdReopen: toolCallsDuringReopen === 0,
      historyReadBeforeTurn: projectionBefore.messages.length > 0 && projectionBefore.source === "sdk-jsonl",
      coldProcessReadsNewTurn: coldRead?.ok === true && coldRead.messages.includes(promptText) &&
        coldRead.messages.includes("T19-UPGRADE-TURN-DONE 历史仍在。"),
      unknownFieldsPreservedOnDisk: fixture.unknownFields.every((needle) => fileText.includes(needle)),
    },
    coldProcess: coldRead,
    coldProcessExit: cold.status,
    coldProcessStderr: cold.stderr.trim(),
  };
  record.checks.allChecksPass = Object.values(record.checks).every(Boolean);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  return record;
}

async function coldRead(file, taskDir) {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const before = sha256File(file);
  const manager = SessionManager.open(file, dirname(file), taskDir);
  const branch = manager.getBranch();
  const context = manager.buildSessionContext();
  const after = sha256File(file);
  const messages = /** @type {any[]} */ (context.messages).map((message) => typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content) ? message.content.map((block) => block.text ?? "").join("") : "");
  process.stdout.write(`${JSON.stringify({
    ok: true, pid: process.pid, file, header: manager.getHeader(),
    entryCount: manager.getEntries().length,
    unchanged: before === after,
    branch: branch.map((entry) => [entry.type, /** @type {any} */ (entry).message?.role ?? null]),
    messages,
    model: context.model, thinkingLevel: context.thinkingLevel,
  })}\n`);
}

if (process.argv[2] === "--cold-read") {
  await coldRead(process.argv[3], process.argv[4]);
  process.exit(0);
}

mkdirSync(writeDir, { recursive: true });
const loopback = await startLoopback();
const record = {
  schema: 1,
  ticket: "#154",
  generatedAt: nowIso(),
  node: process.versions.node,
  platform: `${process.platform}-${process.arch}`,
  productionPath: [
    "compiled dist/host/sdk-context-client.js",
    "compiled dist/host/sdk-context-worker.js (node:worker_threads)",
    "compiled dist/host/sdk-text-kernel.js",
    "@earendil-works/pi-coding-agent@1.5.0 SessionManager / createAgentSession",
  ],
  testDoubles: [
    "model endpoint: loopback OpenAI-compatible SSE server on 127.0.0.1 (no online account)",
    "temp task dir / temp HOME for the isolated context (never the real ~/.pi/agent)",
    "credential: synthetic value, never a real secret",
  ],
  fixtures: FIXTURES.map((fixture) => `fixtures/${fixture.file}`),
  fixtureNotes: "Reconstructed from the exact published packages; see fixtures/README.md. Never real user data.",
  loopbackPort: loopback.port,
  sessions: [],
};
try {
  for (const fixture of FIXTURES) {
    record.sessions.push(await oneFixture(fixture, loopback));
  }
} finally {
  loopback.server.close();
}
record.summary = {
  allPass: record.sessions.every((session) => session.checks.allChecksPass),
  perFixture: record.sessions.map((session) => ({ label: session.label, ...session.checks })),
};
writeFileSync(join(outDir, "session-evidence.json"), json(record));
console.log("T19_UPGRADE_EVIDENCE=" + JSON.stringify(record.summary));
