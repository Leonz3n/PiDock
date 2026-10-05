// Active real SDK + native service drain + durable report + actual Host release.
// Explicit macOS development experiment, never installed service-control RPC.
import { app, utilityProcess } from "electron";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskRootIndex } from "../dist/main/task-root-index.js";
import { ProjectRegistry } from "../dist/main/project-registry.js";
import { ServiceCatalog, serviceCatalogAuthority } from "../dist/main/service-catalog.js";
import { ExperimentalServiceRecoveryStore } from "../dist/main/service-recovery-store-experiment.js";
import { ExperimentalHostRelease } from "../dist/main/host-release-experiment.js";
import { inspectDevelopmentSupervisor } from "../dist/main/service-supervisor-artifact.js";
import { prepareServiceSupervisorExperiment } from "../dist/main/service-supervisor-preparation.js";
if (process.platform !== "darwin" || process.arch !== "arm64") throw Error("macOS arm64 only; not Windows acceptance");
const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-active-report-"))), profile = join(home, "profile"), root = join(home, "tasks");
mkdirSync(profile, { mode: 0o700 }); mkdirSync(root); app.setPath("userData", profile);
const credential = "synthetic-shutdown-credential", secret = "synthetic-active-report-private", children = [], pids = new Set(), reports = [], journalDirs = [];
let store, server, stage = "startup";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const watchdog = setTimeout(() => { console.error("ACTIVE_REPORT_TIMEOUT", stage); for (const h of children) if (!h.exited) h.child.kill(); app.exit(1); }, 90000);
async function wait(check, label) { for (let i = 0; i < 750; i++) { const value = check(); if (value) return value; await delay(20); } throw Error(`timeout:${label}`); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } }
async function run() {
  try {
    await app.whenReady(); const roots = new TaskRootIndex(profile, root), projects = new ProjectRegistry(profile), authority = serviceCatalogAuthority(roots, projects);
    const project = await projects.create({ name: "Active report", description: "", repositories: [], directories: [] }), catalog = new ServiceCatalog(profile, authority);
    const artifact = inspectDevelopmentSupervisor(join(import.meta.dirname, "..", "build", "service-supervisor", "darwin-arm64")); assert.equal(artifact.state, "available-for-experiment");
    const binary = join(home, "fixture"); execFileSync("go", ["build", "-trimpath", "-o", binary, "./testdata/fixture"], { cwd: join(import.meta.dirname, "..", "native", "service-supervisor"), timeout: 30000, stdio: "pipe" });
    const hits = [];
    server = createServer((request, response) => {
      let body = "", bytes = 0;
      request.on("data", (data) => { bytes += data.length; if (bytes > 65536) request.destroy(); else body += String(data); });
      request.on("end", () => {
        let payload;
        try { payload = JSON.parse(body); } catch { response.writeHead(400).end(); return; }
        const hit = { closed: false, authorized: request.headers.authorization === `Bearer ${credential}`, tools: payload.tools === undefined ? 0 : Array.isArray(payload.tools) ? payload.tools.length : -1, modelMatched: payload.model === "fixture" }; hits.push(hit);
        response.on("close", () => { hit.closed = true; });
        if (!hit.authorized || request.url !== "/v1/chat/completions") { response.writeHead(400).end(); return; }
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: { content: "partial answer" }, finish_reason: null }] })}\n\n`);
        // Keep the real SDK model stream open until graceful abort or worker death.
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    let index = 0;
    for (const mode of ["active-close", "worker-death", "protocol-fault", "missing-termination-receipt", "terminal-write-denied", "lost-report-ack"]) {
      stage = mode; const taskId = `task-0000000${++index}`, taskDir = join(root, taskId); mkdirSync(join(taskDir, "repo-a"), { recursive: true }); execFileSync("git", ["init", "-q", taskDir]);
      writeFileSync(join(taskDir, "task.json"), JSON.stringify({ taskId, name: mode, dirId: taskId, root, taskDir, branch: "task/main", remoteBranch: "main", baseCommit: "fixture", repos: ["repo-a"], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }));
      await projects.claim(taskId, project.id, roots);
      const template = catalog.saveTemplate({ projectId: project.id, descriptor: { name: mode, program: "fixture", args: ["host-parent"], ports: [], runType: "long-lived" }, shared: [] }), serviceId = template.serviceId;
      catalog.bindTask({ taskId, serviceId, templateVersion: 1, rootId: "repo-a", subdir: "", programPath: binary, privateRefs: [{ key: "FIXTURE_VALUE", envRef: "LOCAL_FIXTURE_VALUE" }] });
      const identity = JSON.stringify(authority.task(taskId)), inventory = JSON.stringify(catalog.listTask(taskId));
      store = new ExperimentalServiceRecoveryStore(profile, authority, (id) => catalog.listTask(id).map((row) => row.binding.serviceId));
      const child = utilityProcess.fork(join(import.meta.dirname, "service-supervisor-utility-fixture.mjs"), [], { env: {}, stdio: "pipe", serviceName: "active-report-experiment" });
      const h = { child, exited: false, messages: [], output: "", sequence: 0, confirmed: false, exitRequested: false, published: null, ack: null }; children.push(h);
      child.once("exit", () => { h.exited = true; }); child.stdout?.on("data", (data) => { h.output += data; }); child.stderr?.on("data", (data) => { h.output += data; });
      const owner = { sender: child, hasExited: () => h.exited, subscribeExit: (listener) => { child.once("exit", listener); return () => child.removeListener("exit", listener); } }, lease = store.acquire(taskId, owner);
      let complete; const completion = new Promise((resolve) => { complete = resolve; });
      const file = join(profile, "service-execution-recovery", `${createHash("sha256").update(taskId).digest("hex")}.json`);
      child.on("message", (message) => {
        try {
          h.messages.push(message);
          if (message.event === "started") { pids.add(message.pid); pids.add(message.supervisorPid); }
          if (message.event === "log" && /^descendant:[0-9]+$/.test(message.line)) pids.add(Number(message.line.split(":")[1]));
          if (message.kind === "checkpoint-request") {
            assert.equal(message.id, ++h.sequence); const checkpoint = lease.request(child, message.packet);
            child.postMessage({ kind: "checkpoint-ack", id: message.id, epoch: lease.epoch, ok: true, ...(message.packet.op === "read" ? { checkpoint: checkpoint ?? null } : {}) });
          } else if (message.kind === "shutdown-report-request") {
            lease.request(child, message.packet); h.published = readFileSync(file, "utf8");
            h.ack = () => { lease.verifyShutdown(child, message.packet.report); child.postMessage({ kind: "shutdown-report-ack", id: message.id, epoch: lease.epoch, ok: true }); };
          } else if (message.event === "close-result") complete(message.result);
        } catch { complete({ ok: false }); }
      });
      const boot = await wait(() => h.messages.find((m) => m.event === "boot"), "boot");
      const prepared = prepareServiceSupervisorExperiment(catalog, { taskId, projectId: project.id, serviceId }, { LOCAL_FIXTURE_VALUE: secret }, artifact.artifact);
      prepared.use((program, request) => child.postMessage({ op: "launch", binary: program, request, lifecycle: { taskId, taskDir, serviceId, epoch: lease.epoch, closeReport: true, activeSdk: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, mode } } }));
      const running = await wait(() => h.messages.find((m) => m.event === "control-result"), "service-running"); assert.equal(running.result.ok, true); await wait(() => pids.size === 3, "native-fixture-tree");
      child.postMessage({ op: "sdk-start" }); const accepted = await wait(() => h.messages.find((m) => m.event === "sdk-accepted"), "sdk-accepted");
      await wait(() => h.messages.find((m) => m.event === "sdk-event" && m.type === "delta"), "active-delta");
      const hit = hits[index - 1]; assert.equal(hit.authorized, true); assert.equal(hit.modelMatched, true); assert.equal(hit.tools, 0); assert.equal(hit.closed, false);
      const journalDir = join(taskDir, ".pidock-sdk-turns", "main"), turnFile = join(journalDir, "active-model.json"); journalDirs.push(journalDir);
      if (mode === "worker-death") { child.postMessage({ op: "sdk-kill" }); await wait(() => h.messages.find((m) => m.event === "sdk-killed"), "worker-killed"); }
      if (mode === "protocol-fault") { child.postMessage({ op: "sdk-poison" }); await wait(() => h.messages.find((m) => m.event === "sdk-native-exit"), "poison-native-exit"); }
      if (mode === "terminal-write-denied") chmodSync(journalDir, 0o500);
      const witnessFile = join(profile, "service-execution-recovery.witness.json"), witness = readFileSync(witnessFile, "utf8");
      let sealed = false, disposed = false, settled = false;
      const release = new ExperimentalHostRelease({ timeoutMs: 10000, seal: () => { sealed = true; }, verify: () => {
        assert.equal(sealed, true); assert.equal(JSON.stringify(authority.task(taskId)), identity); assert.equal(JSON.stringify(catalog.listTask(taskId)), inventory);
        assert.equal(readFileSync(witnessFile, "utf8"), witness); if (h.published !== null) assert.equal(readFileSync(file, "utf8"), h.published);
      }, hosts: [{ taskId, epoch: lease.epoch, host: owner, requestClose: () => { child.postMessage({ op: "close" }); return completion; },
        confirm: (sender, report) => { lease.confirmShutdown(sender, report); h.confirmed = true; }, requestExit: () => { h.exitRequested = true; child.postMessage({ op: "release" }); } }],
      dispose: () => { assert.equal(h.exited, true); store.dispose(); disposed = true; } });
      const closing = release.close(); void closing.then(() => { settled = true; });
      const mayPublish = mode === "active-close" || mode === "lost-report-ack";
      if (mayPublish) {
        await wait(() => h.ack, "held-report"); await delay(50);
        assert.equal(settled, false); assert.equal(h.confirmed, false); assert.equal(h.exitRequested, false); assert.equal(disposed, false);
        assert.throws(() => store.dispose(), /service-recovery-hosts-active/);
        if (mode === "active-close") h.ack();
      }
      const result = await closing; assert.equal(result.ok, mode === "active-close"); assert.equal(disposed, mode === "active-close"); assert.equal(h.confirmed, mode === "active-close");
      await wait(() => hit.closed, "provider-stream-closed"); await wait(() => h.messages.some((m) => m.event === "sdk-native-exit"), "actual-sdk-exit");
      await wait(() => [...pids].every((pid) => !alive(pid)), "native-fixture-tree-gone"); pids.clear();
      const document = JSON.parse(readFileSync(file, "utf8")), turn = JSON.parse(readFileSync(turnFile, "utf8"));
      assert.equal(document.entries[0].state, "stopped"); assert.equal(document.entries[0].ownerSessionId, null); assert.equal(Boolean(document.shutdown), mayPublish);
      assert.equal(h.messages.filter((m) => m.kind === "shutdown-report-request").length, mayPublish ? 1 : 0);
      assert.equal(turn.turnId, accepted.turnId); assert.equal(turn.state, mode === "worker-death" || mode === "protocol-fault" ? "failed" : mode === "terminal-write-denied" ? "accepted" : "cancelled");
      if (mode !== "active-close") {
        assert.equal(h.exitRequested, false); assert.equal(h.exited, false); assert.equal(existsSync(join(profile, "service-execution-recovery", "writer.lock")), true);
        if (mode === "terminal-write-denied") chmodSync(journalDir, 0o700); if (mode === "lost-report-ack") h.ack();
        const before = h.messages.filter((m) => m.event === "close-result").length; child.postMessage({ op: "close" });
        await wait(() => h.messages.filter((m) => m.event === "close-result").length > before, "cached-host-failure");
        assert.equal(h.messages.filter((m) => m.event === "close-result").at(-1).result.ok, false); assert.equal(release.close(), closing); assert.equal((await release.close()).ok, false);
        child.kill(); await wait(() => h.exited, "explicit-test-cleanup"); store.dispose(); // Test cleanup, not coordinator release authorization.
      }
      const sessionDir = join(taskDir, ".pidock-sdk-sessions", "main"), jsonl = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl")).map((name) => readFileSync(join(sessionDir, name), "utf8")).join("\n");
      for (const value of [credential, secret]) for (const text of [JSON.stringify(document), JSON.stringify(turn), witness, jsonl, JSON.stringify(h.messages), h.output]) assert.ok(!text.includes(value));
      assert.equal(hits.length, index); if (h.published !== null) assert.equal(readFileSync(file, "utf8"), h.published);
      reports.push({ mode, versions: boot.versions, sdkNativeExitObserved: true, tools: 0, nativeFixtureGone: true, reportPublished: mayPublish, mainConfirmed: h.confirmed, authorizedWriterDisposal: disposed, turnState: turn.state, repeatedReceiptStable: true });
    }
    console.log("ACTIVE_MODEL_REPORT_OK", JSON.stringify(reports));
  } catch (error) { console.error("ACTIVE_MODEL_REPORT_FAILED", stage, String(error).replaceAll(credential, "[redacted]").replaceAll(secret, "[redacted]").replaceAll(home, "[test-home]").slice(0, 300)); process.exitCode = 1; }
  finally {
    clearTimeout(watchdog); for (const dir of journalDirs) try { chmodSync(dir, 0o700); } catch { /* Private test path only. */ }
    for (const h of children) if (!h.exited) h.child.kill(); for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch { /* Exact test fixture PID only. */ }
    server?.closeAllConnections(); await new Promise((resolve) => server ? server.close(resolve) : resolve());
    await Promise.all(children.map((h) => h.exited ? undefined : wait(() => h.exited, "cleanup-exit").catch(() => undefined)));
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); app.exit(process.exitCode ?? 0);
  }
}
void run();
