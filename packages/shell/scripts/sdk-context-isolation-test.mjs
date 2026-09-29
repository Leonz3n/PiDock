// [PiDock 02m] (#46) isolated SDK context: real-worker isolation gate.
// Run after `pnpm --filter @pidock/shell build`:
//   node packages/shell/scripts/sdk-context-isolation-test.mjs
//
// It exercises the real spawn path (`SdkContextClient` -> node:worker_threads ->
// `sdk-context-worker.js`) while the *parent* process carries credential-shaped
// environment variables, and asserts:
//
//   1. the dispatch environment is a positive allowlist that carries neither the
//      ambient credential names nor the credential value (probe worker);
//   2. the real worker's own isolation assertions accept that environment (a
//      single inherited credential-shaped name or a missing opt-in would make
//      `open` fail with `provider-environment-unisolated`);
//   3. a real model turn only happens in the worker: the loopback endpoint
//      receives the explicit credential, the credential is redacted out of the
//      live stream and the SDK JSONL, and the task runs with no tools;
//   4. a disposed context refuses further work.
//
// This is the gate the docstrings point at. It needs no Electron and no
// external network: the endpoint is a loopback HTTP server on 127.0.0.1.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { buildTaskDiskRecord, serializeTaskRecord } from "../dist/host/task-store.js";
import { buildSdkContextEnv } from "../dist/host/sdk-context-env.js";
import { SdkContextClient } from "../dist/host/sdk-context-client.js";

const CREDENTIAL = "issue46-synthetic-credential-0123456789";
const AMBIENT = {
  OPENAI_API_KEY: "sk-ambient-openai-should-never-be-used",
  ANTHROPIC_API_KEY: "sk-ant-ambient-should-never-be-used",
  AWS_SECRET_ACCESS_KEY: "ambient-aws-secret",
  GOOGLE_APPLICATION_CREDENTIALS: "/tmp/ambient-google.json",
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
  execFileSync("git", ["init", "-q", dir], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TEMPLATE_DIR: "" } });
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
  // Ambient credential-shaped variables are present for the whole run.
  for (const [name, value] of Object.entries(AMBIENT)) process.env[name] = value;
  process.env["HOME"] = join(dir, ".ambient-home");

  const dispatch = buildSdkContextEnv(process.env, { taskId: "task-abcdef12", taskDir: dir }, { home: join(dir, ".pidock-sdk-context-home"), workspaceId: "issue46" });
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

  console.log("ISSUE46_ISOLATION=" + JSON.stringify({
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
