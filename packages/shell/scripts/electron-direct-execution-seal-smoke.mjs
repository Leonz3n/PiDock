// Direct compiled TaskWorkspaceHost + real SDK Worker/loopback model, no task RPC.
// The derived registration below is metadata only, not a native child claim.
import { app } from "electron";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { TaskWorkspaceHost } from "../dist/host/task-host.js";
import { runAgentBrowserAction } from "../dist/host/browser-control.js";
import { TaskWriteCoordinator } from "../dist/host/write-coordination.js";
import { SdkContextClient } from "../dist/host/sdk-context-client.js";
import { buildTaskDiskRecord, serializeTaskRecord } from "../dist/host/task-store.js";
const home = mkdtempSync(join(tmpdir(), "pidock-direct-seal-")), taskId = "task-abcdef12", taskDir = join(home, taskId), credential = "synthetic-direct-seal-private";
mkdirSync(taskDir); app.setPath("userData", home);
let host, server, worker, sdkExited = false;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(check) { for (let i = 0; i < 500; i++) { if (check()) return; await delay(20); } throw Error("direct-seal-timeout"); }
const watchdog = setTimeout(() => { console.error("DIRECT_SEAL_TIMEOUT"); void worker?.terminate(); app.exit(1); }, 30000);
async function run() {
try {
  await app.whenReady(); execFileSync("git", ["init", "-q", taskDir]);
  writeFileSync(join(taskDir, "task.json"), serializeTaskRecord(buildTaskDiskRecord({ taskId, name: "Direct seal", dirId: taskId, root: home, taskDir, branch: "main", remoteBranch: "main", baseCommit: "fixture", repos: [], now: new Date().toISOString() })));
  let hits = 0, closed = false, authorized = false;
  server = createServer((request, response) => {
    request.resume(); request.on("end", () => {
      hits++; authorized = request.headers.authorization === `Bearer ${credential}`;
      response.on("close", () => { closed = true; }); response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: { content: "partial answer" }, finish_reason: null }] })}\n\n`);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  host = new TaskWorkspaceHost(taskId, taskDir, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    (options) => new SdkContextClient({ ...options, spawn: (env, workerData) => {
      worker = new Worker(new URL("../dist/host/sdk-context-worker.js", import.meta.url), { env, workerData }); worker.once("exit", () => { sdkExited = true; }); return worker;
    } }));
  host.openSession("main", { permission: "auto" });
  const legacy = host.openSession("legacy", { permission: "auto" }), lateMarker = join(taskDir, "late-legacy-marker.txt");
  await host.configureSdkProvider({ config: { profileId: "fixture", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, modelId: "fixture", contextWindow: 2048, maxTokens: 128, authRef: "PIDOCK_PROVIDER_FIXTURE", generation: 1 }, credential });
  const kernel = host.sdkTextKernel(); assert.equal((await kernel.open("main")).tools.length, 0);
  let delta = false; const prompt = kernel.prompt("main", "direct seal fixture", (event) => { if (event.type === "delta") delta = true; });
  void prompt.catch(() => {});
  await wait(() => delta); assert.equal(hits, 1); assert.equal(authorized, true); assert.equal(closed, false);
  assert.equal(host.claimDerivedExecution({ sessionId: "main", resourceId: "metadata-child", label: "metadata-only witness" }), true);
  host.sealExecution(); await assert.rejects(kernel.prompt("main", "late model"), /sdk-context-closing/);
  let lateActions = 0;
  assert.throws(() => legacy.runTurn({ text: "late legacy", execute: () => { lateActions++; writeFileSync(lateMarker, "late turn"); return null; } }), /task-host-closing/);
  const browser = await runAgentBrowserAction({ gateway: { taskId, perform: async () => { lateActions++; writeFileSync(lateMarker, "late browser"); return { ok: true, payload: {} }; } }, channel: legacy, sessionId: "legacy", taskId, taskDir, action: "page/navigate", write: new TaskWriteCoordinator(), persist: () => {} });
  assert.deepEqual(browser, { ok: false, error: "task-host-closing" }); assert.equal(lateActions, 0); assert.equal(existsSync(lateMarker), false);
  assert.throws(() => host.claimWrite("main", "auto", { kind: "browser-action", label: "late" }), /task-host-closing/);
  assert.throws(() => host.cancel("main"), /task-derived-executions-unconfirmed/);
  const disposal = host.dispose(); await assert.rejects(disposal, /task-derived-executions-unconfirmed/);
  assert.equal((await prompt).state, "cancelled"); await wait(() => closed && sdkExited);
  assert.equal(host.writeState().derived.length, 1); assert.equal(host.writeLockOwner, "main"); assert.equal(hits, 1);
  host.endDerivedExecution("metadata-child"); assert.equal(host.dispose(), disposal); await assert.rejects(host.dispose(), /task-derived-executions-unconfirmed/);
  const dir = join(taskDir, ".pidock-sdk-sessions", "main"), jsonl = readdirSync(dir).filter((file) => file.endsWith(".jsonl")).map((file) => readFileSync(join(dir, file), "utf8")).join("\n");
  assert.ok(jsonl.includes("direct seal fixture")); assert.ok(!jsonl.includes(credential));
  console.log("DIRECT_EXECUTION_SEAL_OK", JSON.stringify({ electron: process.versions.electron, node: process.versions.node, providerRequests: hits, tools: 0, retainedKernelRefused: true, retainedLegacyRefused: true, lateActionCallbacks: lateActions, sdkNativeExit: sdkExited, derivedMetadataRetained: true, lateSettlementRepairsDisposal: false, credentialExcluded: true }));
} catch (error) { console.error("DIRECT_EXECUTION_SEAL_FAILED", String(error).replaceAll(credential, "[redacted]").replaceAll(home, "[test-home]").slice(0, 300)); process.exitCode = 1; }
finally {
  clearTimeout(watchdog); await worker?.terminate(); server?.closeAllConnections(); await new Promise((resolve) => server ? server.close(resolve) : resolve());
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); app.exit(process.exitCode ?? 0);
}
}
void run();
