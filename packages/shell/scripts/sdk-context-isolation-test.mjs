// [PiDock 02m] (#46) isolated SDK context: real-worker isolation gate.
// Run after `pnpm --filter @pidock/shell build`:
//   node packages/shell/scripts/sdk-context-isolation-test.mjs
//
// It exercises the real spawn path (`SdkContextClient` -> node:worker_threads ->
// `sdk-context-worker.js`) with synthetic startup/credential inputs, and asserts:
//
//   1. the outer Host environment and an actual Node descendant exclude unrelated
//      credentials/config overrides while local Git still starts;
//   2. the SDK dispatch environment independently rejects ambient poison, and the
//      real worker accepts the task-bound private HOME (no inherited credential);
//   3. an unconfigured Host refuses implicit auth/user pi configuration without
//      a request, while a real worker turn uses only the explicit credential,
//      redacts it out of events/JSONL, and has no tools;
//   4. a disposed context refuses further work.
//
// Electron fork construction is separately tested with a double. This script's
// actual Node descendant is not an Electron utilityProcess startup assertion.
// The loopback endpoint needs no external network or real credential.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { buildTaskDiskRecord, serializeTaskRecord } from "../dist/host/task-store.js";
import { buildSdkContextEnv } from "../dist/host/sdk-context-env.js";
import { buildHostEnv } from "../dist/host/host-guards.js";
import { PiSdkTextKernel } from "../dist/host/sdk-text-kernel.js";
import { SdkContextClient } from "../dist/host/sdk-context-client.js";

const CREDENTIAL = "issue46-synthetic-credential-0123456789";
const AMBIENT = {
  OPENAI_API_KEY: "sk-ambient-openai-should-never-be-used",
  ANTHROPIC_API_KEY: "sk-ant-ambient-should-never-be-used",
  AWS_SECRET_ACCESS_KEY: "ambient-aws-secret",
  GOOGLE_APPLICATION_CREDENTIALS: "/tmp/ambient-google.json",
  BUSINESS_AUTH: "synthetic-unrelated-business-auth",
  PIDOCK_PROVIDER_ISSUE46: CREDENTIAL,
  NODE_OPTIONS: "--require /untrusted",
  NODE_PATH: "/untrusted",
  PI_CODING_AGENT_DIR: "/untrusted",
  GIT_CONFIG_GLOBAL: "/untrusted",
  SSH_AUTH_SOCK: "/untrusted",
  HTTP_PROXY: "http://127.0.0.1:1",
  HTTPS_PROXY: "http://127.0.0.1:1",
};
const config = {
  profileId: "p-11111111-2222-3333-4444-555555555555",
  baseUrl: "",
  modelId: "issue46-model",
  contextWindow: 128000,
  maxTokens: 8192,
  authRef: "PIDOCK_PROVIDER_ISSUE46",
  generation: 1,
};
const cleanups = [];
const fail = (message) => { throw new Error(message); };

function task() {
  const root = mkdtempSync(join(tmpdir(), "pidock-issue46-iso-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const dir = join(root, "task-abcdef12");
  mkdirSync(dir);
  execFileSync("git", ["init", "-q", "--template=", dir], { env: { HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdio: "pipe" });
  writeFileSync(join(dir, "task.json"), serializeTaskRecord(buildTaskDiskRecord({
    taskId: "task-abcdef12", name: "isolation", dirId: "task-abcdef12", branch: "main", root,
    taskDir: dir, remoteBranch: "main", baseCommit: "test", repos: [], now: new Date().toISOString(),
  })));
  return dir;
}

/** Loopback OpenAI-compatible endpoint that echoes the credential. */
function provider() {
  const hits = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      hits.push({ url: request.url, authorization: request.headers.authorization ?? "", body });
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      const frame = (delta) => `data: ${JSON.stringify({ id: `chatcmpl-${CREDENTIAL}`, object: "chat.completion.chunk", model: CREDENTIAL, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
      response.write(frame({ content: `echo ${CREDENTIAL.slice(0, 12)}` }));
      response.write(frame({ content: `${CREDENTIAL.slice(12)} answer` }));
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    cleanups.push(() => server.close());
    resolve({ port: server.address().port, hits });
  }));
}

/**
 * The same environment the client builds, observed from inside a real worker
 * thread. `node:worker_threads` gives a worker `process.env` equal to the env
 * passed at spawn, so this is a direct observation, not an inference.
 */
function probe(env) {
  const script = `
    const { parentPort } = require("node:worker_threads");
    parentPort.postMessage({ env: process.env });
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(script, { eval: true, env });
    worker.once("message", (message) => { void worker.terminate(); resolve(message.env); });
    worker.once("error", reject);
  });
}

/** Fails closed exactly the way the client does, so the harness prints its own name. */
function assert(condition, message) {
  if (!condition) fail(message);
}

async function run() {
  const dir = task();
  const endpoint = await provider();
  config.baseUrl = `http://127.0.0.1:${endpoint.port}/v1`;
  // Entirely synthetic startup input: no real parent environment is inspected.
  const ambientHome = join(dir, ".ambient-home");
  const piDir = join(ambientHome, ".pi", "agent");
  mkdirSync(piDir, { recursive: true });
  const poisonedAuth = JSON.stringify({ openai: { type: "api_key", key: AMBIENT.OPENAI_API_KEY } });
  const poisonedModels = JSON.stringify({ providers: { openai: { baseUrl: `http://127.0.0.1:${endpoint.port}/implicit`, apiKey: AMBIENT.OPENAI_API_KEY,
    models: [{ id: config.modelId, name: "poison", contextWindow: 128000, maxTokens: 8192 }] } } });
  writeFileSync(join(piDir, "auth.json"), poisonedAuth);
  writeFileSync(join(piDir, "models.json"), poisonedModels);
  const startup = { PATH: "/usr/bin:/bin", HOME: ambientHome, TMPDIR: dir };
  const hostEnv = buildHostEnv({ ...startup, ...AMBIENT, PIDOCK_TASK_ID: "forged", PIDOCK_SDK_ISOLATED: "1" }, "issue46", { taskId: "task-abcdef12", taskDir: dir });
  const descendant = JSON.parse(execFileSync(process.execPath, ["-e", "console.log(JSON.stringify(process.env))"], { env: hostEnv, encoding: "utf8" }));
  assert(Object.keys(AMBIENT).every((name) => !(name in descendant)), "Host descendant inherited unrelated credentials or config");
  assert(!Object.values(descendant).includes(CREDENTIAL), "Host descendant inherited selected credential");
  assert(!("PIDOCK_SDK_ISOLATED" in descendant), "Host inherited SDK opt-in");
  execFileSync("git", ["status", "--porcelain"], { cwd: dir, env: hostEnv, stdio: "pipe" });
  // Simulate the Host's process environment for the real SdkContextClient.
  process.env = { ...hostEnv };
  const unconfigured = new PiSdkTextKernel("task-abcdef12", dir);
  await unconfigured.prompt("main", "must refuse implicit credentials").then(() => fail("unconfigured Host sent a request"),
    (error) => assert(error.message === "provider-not-configured", "unconfigured Host did not refuse"));
  assert(endpoint.hits.length === 0, "ambient SDK auth triggered a request before explicit selection");

  const dispatch = buildSdkContextEnv({ ...hostEnv, ...AMBIENT }, { taskId: "task-abcdef12", taskDir: dir }, { home: join(dir, ".pidock-sdk-context-home"), workspaceId: "issue46" });
  const observed = await probe(dispatch);
  const ambientNames = Object.keys(AMBIENT);
  assert(ambientNames.every((name) => !(name in observed)), `dispatch environment leaked ambient names: ${JSON.stringify(observed)}`);
  assert(!Object.values(observed).some((value) => typeof value === "string" && (value.includes(CREDENTIAL) || value.includes("ambient"))), "dispatch environment leaked an ambient credential value");
  assert(Object.keys(observed).every((name) => !/(?:^|_)(?:API_?KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:$|_)/i.test(name)), `dispatch environment has a credential-shaped name: ${JSON.stringify(observed)}`);
  assert(observed["PIDOCK_SDK_ISOLATED"] === "1", "dispatch environment is missing the isolation opt-in");
  assert(observed["HOME"] === join(dir, ".pidock-sdk-context-home"), `dispatch environment HOME is not the private home: ${observed["HOME"]}`);
  assert(observed["PIDOCK_TASK_DIR"] === dir && observed["PIDOCK_TASK_ID"] === "task-abcdef12", "dispatch environment is not task-bound");
  // No ambient credential may travel with the task binding either.
  assert(observed["PIDOCK_PROVIDER_ISSUE46"] === undefined, "dispatch environment carries the credential reference");

  const client = new SdkContextClient({ task: { taskId: "task-abcdef12", taskDir: dir }, config, credential: CREDENTIAL, workspaceId: "issue46" });
  const opened = await client.open("main");
  assert(opened.tools.length === 0, `isolated context enabled tools: ${JSON.stringify(opened.tools)}`);
  const events = [];
  const result = await client.prompt("main", "hello from the isolation gate", (event) => events.push(event));
  assert(result.state === "done", `turn did not complete: ${JSON.stringify(result)}`);
  assert(result.text.includes("answer"), `loopback answer missing: ${JSON.stringify(result.text)}`);
  assert(!result.text.includes(CREDENTIAL), "credential present in the turn result");
  assert(!events.some((event) => typeof event.text === "string" && event.text.includes(CREDENTIAL)), "credential present in the streamed events");
  assert(events.some((event) => typeof event.text === "string" && event.text.includes("[redacted]")), "no redaction marker in the streamed events");
  assert(endpoint.hits.length === 1, `endpoint hits: ${endpoint.hits.length}`);
  assert(endpoint.hits[0].authorization === `Bearer ${CREDENTIAL}`, `endpoint did not receive the explicit credential: ${endpoint.hits[0].authorization}`);
  assert(endpoint.hits[0].body.includes("issue46-model"), "endpoint did not receive the configured model");

  const sessionDir = join(dir, ".pidock-sdk-sessions", "main");
  const log = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl")).map((name) => readFileSync(join(sessionDir, name), "utf8")).join("\n");
  assert(log.includes("hello from the isolation gate"), "prompt missing from the SDK JSONL");
  assert(!log.includes(CREDENTIAL), "credential persisted in the SDK JSONL");
  assert(!log.includes("ambient"), "an ambient credential reached the SDK JSONL");

  await client.dispose();
  await client.dispose();
  await client.open("main").then(() => fail("a disposed context accepted work"), (error) => assert(/sdk-context-disposed/.test(String(error)), `unexpected disposed error: ${String(error)}`));

  assert(readFileSync(join(piDir, "auth.json"), "utf8") === poisonedAuth && readFileSync(join(piDir, "models.json"), "utf8") === poisonedModels, "synthetic user pi config was modified");
  assert(endpoint.hits.every((hit) => hit.url === "/v1/chat/completions"), "implicit user model endpoint was used");
  console.log("ISSUE46_ISOLATION=" + JSON.stringify({
    hostDescendantNames: Object.keys(descendant).sort(),
    hostAmbientObserved: Object.keys(AMBIENT).filter((name) => name in descendant),
    hostCredentialInEnvironment: Object.values(descendant).includes(CREDENTIAL),
    localGitStatus: true, unconfiguredRequests: 0, implicitEndpointHits: 0, syntheticPiConfigUnchanged: true,
    dispatchNames: Object.keys(observed).sort(),
    ambientObserved: ambientNames.filter((name) => name in observed),
    credentialInDispatchEnv: Object.values(observed).includes(CREDENTIAL),
    tools: opened.tools.length,
    redacted: true,
    credentialInJsonl: log.includes(CREDENTIAL),
    endpointHits: endpoint.hits.length,
    authorizationMatched: true,
    disposedRefusal: "sdk-context-disposed",
  }));
}

run().then(() => {
  for (const cleanup of cleanups.reverse()) { try { cleanup(); } catch { /* best effort */ } }
  process.exit(0);
}, (error) => {
  console.error("ISSUE46_ISOLATION_FAILED", error);
  for (const cleanup of cleanups.reverse()) { try { cleanup(); } catch { /* best effort */ } }
  process.exit(1);
});
