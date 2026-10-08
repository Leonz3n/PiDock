// Installed Host/RPC -> real SDK worker -> loopback SSE: active-turn quit proof.
// Test-only main caller; no renderer, tools, service execution or recovery authority.
import { app, utilityProcess } from "electron";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTaskDiskRecord, serializeTaskRecord } from "../dist/host/task-store.js";
import { buildHostEnv } from "../dist/host/host-guards.js";
import { TaskRootIndex } from "../dist/main/task-root-index.js";
import { PerTaskHostRegistry } from "../dist/main/runtime.js";
import { HostClient } from "../dist/rpc/host-client.js";
import { shutdownTestRegistry } from "./shutdown-test-registry.mjs";
const home = mkdtempSync(join(tmpdir(), "pidock-active-turn-quit-")), profile = join(home, "profile"), root = join(home, "tasks");
mkdirSync(profile); mkdirSync(root); app.setPath("userData", profile);
const credential = "synthetic-active-turn-private-value", children = [], reports = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let registry, server, stage = "startup";
const watchdog = setTimeout(() => { console.error("ACTIVE_TURN_QUIT_TIMEOUT", stage); for (const h of children) if (!h.exited) h.child.kill(); app.exit(1); }, 60000);
async function wait(check, label) { for (let i = 0; i < 500; i++) { const value = check(); if (value) return value; await delay(20); } throw Error(`timeout:${label}`); }
async function run() {
  try {
    await app.whenReady(); const roots = new TaskRootIndex(profile, root), requests = [], events = [];
    let mode;
    server = createServer((request, response) => {
      let bytes = 0, body = "";
      request.on("data", (data) => { bytes += data.length; if (bytes > 65536) request.destroy(); else body += String(data); });
      request.on("end", () => {
        let payload;
        try { payload = JSON.parse(body); } catch { response.writeHead(400).end(); return; }
        const hit = { mode, closed: false, authorized: request.headers.authorization === `Bearer ${credential}`, expectedPath: request.url === "/v1/chat/completions",
          modelMatched: payload.model === "fixture", tools: payload.tools === undefined ? 0 : Array.isArray(payload.tools) ? payload.tools.length : -1 }; requests.push(hit);
        response.on("close", () => { hit.closed = true; });
        if (!hit.authorized || !hit.expectedPath) { response.writeHead(400).end(); return; }
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" }); response.flushHeaders();
        if (mode !== "before-first-delta") response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: { content: "partial answer" }, finish_reason: null }] })}\n\n`);
        if (mode === "provider-disconnect") setTimeout(() => response.destroy(), 50);
        // Other modes deliberately keep the actual model stream active until abort.
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const makeRegistry = () => new PerTaskHostRegistry("active-turn-quit", async (workspace, task) => {
      const child = utilityProcess.fork(join(import.meta.dirname, "..", "dist", "host", "host-entry.js"), [], { serviceName: "active-turn-quit", env: buildHostEnv(process.env, workspace, task, profile), stdio: "pipe" });
      const h = { child, exited: false, output: "" }; children.push(h); child.once("exit", () => { h.exited = true; });
      child.stdout?.on("data", (data) => { h.output += data; }); child.stderr?.on("data", (data) => { h.output += data; });
      const client = new HostClient(child); client.onTurnEvent((event) => events.push(event)); return { child, client };
    }, (id) => roots.resolve(id), undefined, roots);
    let index = 0;
    for (mode of ["active-stream", "before-first-delta", "provider-disconnect"]) {
      stage = mode; registry = makeRegistry(); const taskId = `task-0000000${++index}`, taskDir = join(root, taskId); mkdirSync(taskDir); execFileSync("git", ["init", "-q", taskDir]);
      writeFileSync(join(taskDir, "task.json"), serializeTaskRecord(buildTaskDiskRecord({ taskId, name: mode, dirId: taskId, branch: "main", root, taskDir, remoteBranch: "main", baseCommit: "fixture", repos: [], now: new Date().toISOString() })));
      const op = (name, payload) => registry.routeTaskOp({ workspaceId: "active-turn-quit", taskId, op: name, payload, origin: { kind: "shell-ui", senderWebContentsId: 1 } });
      await op("task/sdkProvider", { provider: { config: { profileId: "fixture", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, modelId: "fixture", contextWindow: 2048, maxTokens: 128, authRef: "PIDOCK_PROVIDER_FIXTURE", generation: 1 }, credential } });
      const started = await op("task/sdkStart", { sessionId: "main", requestId: "request-a", text: "active shutdown fixture" }); assert.equal(started.payload.turn.state, "accepted");
      const hit = await wait(() => requests.find((r) => r.mode === mode), "model-request"); assert.equal(hit.authorized, true); assert.equal(hit.expectedPath, true); assert.equal(hit.modelMatched, true); assert.equal(hit.tools, 0);
      if (mode === "active-stream") await wait(() => events.find((e) => e.event?.taskId === taskId && e.event.type === "delta"), "first-delta");
      if (mode === "provider-disconnect") await wait(() => events.find((e) => e.turn?.taskId === taskId && e.turn.state === "failed"), "failed-turn");
      else assert.equal(hit.closed, false);
      const closing = op("task/quit", { label: "Active SDK shutdown probe" });
      await assert.rejects(op("task/sdkStart", { sessionId: "main", requestId: "request-b", text: "late prompt" }), /sdk-host-closing/);
      const quit = await closing, repeated = await op("task/quit", { label: "Active SDK shutdown probe" });
      assert.equal(quit.payload.quit.plan.failures.length, 0); assert.equal(quit.payload.quit.plan.retainedTasks.length, 0); assert.deepEqual(repeated.payload.quit, quit.payload.quit);
      await wait(() => hit.closed, "provider-disconnected");
      const journal = JSON.parse(readFileSync(join(taskDir, ".pidock-sdk-turns", "main", "request-a.json"), "utf8"));
      assert.equal(journal.turnId, started.payload.turn.turnId); assert.equal(journal.state, mode === "provider-disconnect" ? "failed" : "cancelled");
      assert.equal(existsSync(join(taskDir, ".pidock-sdk-turns", "main", "request-b.json")), false);
      await assert.rejects(op("task/sdkProvider", { provider: null }), /sdk-host-closing/);
      const sessionDir = join(taskDir, ".pidock-sdk-sessions", "main"), jsonl = readdirSync(sessionDir).filter((file) => file.endsWith(".jsonl")).map((file) => readFileSync(join(sessionDir, file), "utf8")).join("\n");
      assert.ok(jsonl.includes("active shutdown fixture"));
      for (const value of [JSON.stringify(journal), jsonl, JSON.stringify(events), children.map((h) => h.output).join("\n")]) assert.ok(!value.includes(credential));
      assert.equal(requests.filter((r) => r.mode === mode).length, 1);
      // Strict per-mode shutdown seam: the synthetic test origin exercises
      // the attested quitAll path; this mode's Host is already quit above and
      // its receipt cached, so disposeAll observes the exit the fixture
      // kill/wait below then records.
      const modeCleanup = await shutdownTestRegistry(registry, { origin: { kind: "shell-ui", senderWebContentsId: 1 }, label: "Active SDK test cleanup" });
      if (modeCleanup.length) { console.error("ACTIVE_TURN_QUIT_CLEANUP_FAILED " + JSON.stringify(modeCleanup)); process.exitCode = process.exitCode ?? 1; }
      const h = children.at(-1); h.child.kill(); await wait(() => h.exited, "test-host-cleanup");
      reports.push({ mode, electron: process.versions.electron, node: process.versions.node, providerRequests: 1, tools: hit.tools, streamClosed: true, journalState: journal.state, quitReceiptStable: true, lateAdmissionRefused: true, credentialExcluded: true });
    }
    console.log("ACTIVE_TURN_QUIT_OK", JSON.stringify(reports));
  } catch (error) { console.error("ACTIVE_TURN_QUIT_FAILED", stage, String(error).replaceAll(credential, "[redacted]").replaceAll(home, "[test-home]").slice(0, 300)); process.exitCode = 1; }
  finally {
    clearTimeout(watchdog);
    const cleanupFailures = await shutdownTestRegistry(registry, {
      origin: { kind: "shell-ui", senderWebContentsId: 1 },
      label: "Active SDK test cleanup",
    });
    if (cleanupFailures.length) { console.error("ACTIVE_TURN_QUIT_CLEANUP_FAILED " + JSON.stringify(cleanupFailures)); process.exitCode = process.exitCode ?? 1; }
    for (const h of children) if (!h.exited) h.child.kill();
    server?.closeAllConnections(); await new Promise((resolve) => server ? server.close(resolve) : resolve());
    await Promise.all(children.map((h) => h.exited ? undefined : wait(() => h.exited, "cleanup-exit").catch(() => undefined)));
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); app.exit(process.exitCode ?? 0);
  }
}
void run();
