// Real main release coordinator: durable report completion, then actual native exit.
// Explicit development probe only; not installed runtime, recovery or renderer RPC.
import { app, utilityProcess } from "electron";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-host-release-"))), profile = join(home, "profile"), root = join(home, "tasks");
mkdirSync(profile, { mode: 0o700 }); mkdirSync(root); app.setPath("userData", profile);
const secret = "synthetic-release-private-value", children = [], pids = new Set(), reports = [];
let store, stage = "startup";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const watchdog = setTimeout(() => { console.error("HOST_RELEASE_TIMEOUT", stage); for (const h of children) if (!h.exited) h.child.kill(); app.exit(1); }, 60000);
async function wait(predicate, label) { for (let i = 0; i < 500; i++) { const value = predicate(); if (value) return value; await delay(20); } throw Error(`timeout:${label}`); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } }
async function run() {
  try {
    await app.whenReady(); const roots = new TaskRootIndex(profile, root), projects = new ProjectRegistry(profile), authority = serviceCatalogAuthority(roots, projects);
    const project = await projects.create({ name: "Host release", description: "", repositories: [], directories: [] }), catalog = new ServiceCatalog(profile, authority);
    const artifact = inspectDevelopmentSupervisor(join(import.meta.dirname, "..", "build", "service-supervisor", "darwin-arm64")); assert.equal(artifact.state, "available-for-experiment");
    const binary = join(home, "fixture"); execFileSync("go", ["build", "-trimpath", "-o", binary, "./testdata/fixture"], { cwd: join(import.meta.dirname, "..", "native", "service-supervisor"), timeout: 30000, stdio: "pipe" });
    let index = 0;
    for (const mode of ["held-native-exit", "exit-timeout", "death-before-report-ack"]) {
      stage = mode; const taskId = `task-0000000${++index}`, taskDir = join(root, taskId); mkdirSync(join(taskDir, "repo-a"), { recursive: true }); execFileSync("git", ["init", "-q", taskDir]);
      writeFileSync(join(taskDir, "task.json"), JSON.stringify({ taskId, name: mode, dirId: taskId, root, taskDir, branch: "task/main", remoteBranch: "main", baseCommit: "test", repos: ["repo-a"], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }));
      await projects.claim(taskId, project.id, roots);
      const template = catalog.saveTemplate({ projectId: project.id, descriptor: { name: mode, program: "fixture", args: ["host-parent"], ports: [], runType: "long-lived" }, shared: [] }), serviceId = template.serviceId;
      catalog.bindTask({ taskId, serviceId, templateVersion: 1, rootId: "repo-a", subdir: "", programPath: binary, privateRefs: [{ key: "FIXTURE_VALUE", envRef: "LOCAL_FIXTURE_VALUE" }] });
      const scope = JSON.stringify(authority.task(taskId)), bindings = JSON.stringify(catalog.listTask(taskId));
      store = new ExperimentalServiceRecoveryStore(profile, authority, (id) => catalog.listTask(id).map((row) => row.binding.serviceId));
      const prepared = prepareServiceSupervisorExperiment(catalog, { taskId, projectId: project.id, serviceId }, { LOCAL_FIXTURE_VALUE: secret }, artifact.artifact);
      const child = utilityProcess.fork(join(import.meta.dirname, "service-supervisor-utility-fixture.mjs"), [], { env: {}, stdio: "pipe", serviceName: "host-release-experiment" });
      const h = { child, exited: false, exitCode: null, messages: [], output: "", sequence: 0, reportBody: null, exitRequested: false, confirmed: false }; children.push(h);
      child.once("exit", (code) => { h.exited = true; h.exitCode = code; }); child.stdout?.on("data", (data) => { h.output += data; }); child.stderr?.on("data", (data) => { h.output += data; });
      const owner = { sender: child, hasExited: () => h.exited, subscribeExit: (listener) => { child.once("exit", listener); return () => child.removeListener("exit", listener); } }, lease = store.acquire(taskId, owner);
      let complete;
      const completion = new Promise((resolve) => { complete = resolve; });
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
            lease.request(child, message.packet); h.reportBody = readFileSync(file, "utf8");
            if (mode === "death-before-report-ack") { process.kill(child.pid, "SIGKILL"); }
            else { lease.verifyShutdown(child, message.packet.report); child.postMessage({ kind: "shutdown-report-ack", id: message.id, epoch: lease.epoch, ok: true }); }
          } else if (message.event === "close-result") complete(message.result);
        } catch { complete({ ok: false }); }
      });
      const boot = await wait(() => h.messages.find((message) => message.event === "boot"), "boot");
      prepared.use((program, request) => child.postMessage({ op: "launch", binary: program, request, lifecycle: { taskId, taskDir, serviceId, epoch: lease.epoch, closeReport: true } }));
      await wait(() => h.messages.find((message) => message.event === "control-result"), "running");
      assert.equal(h.messages.find((message) => message.event === "control-result").result.ok, true);
      await wait(() => pids.size === 3, "descendant-observation");
      const witness = readFileSync(join(profile, "service-execution-recovery.witness.json"), "utf8");
      let sealed = false, disposed = false;
      const coordinator = new ExperimentalHostRelease({ timeoutMs: 5000, seal: () => { sealed = true; }, verify: () => {
        assert.equal(sealed, true); assert.equal(JSON.stringify(authority.task(taskId)), scope); assert.equal(JSON.stringify(catalog.listTask(taskId)), bindings);
        assert.equal(readFileSync(join(profile, "service-execution-recovery.witness.json"), "utf8"), witness);
        if (h.reportBody !== null) assert.equal(readFileSync(file, "utf8"), h.reportBody);
      }, hosts: [{ taskId, epoch: lease.epoch, host: owner, requestClose: () => { child.postMessage({ op: "close" }); return completion; },
        confirm: (sender, report) => { lease.confirmShutdown(sender, report); h.confirmed = true; }, requestExit: () => { h.exitRequested = true; } }],
      dispose: () => { assert.equal(h.exited, true); store.dispose(); disposed = true; } });
      let settled = false; const closing = coordinator.close(); void closing.then(() => { settled = true; }); assert.equal(sealed, true);
      if (mode === "held-native-exit") {
        await wait(() => h.exitRequested, "exit-request"); assert.equal(h.confirmed, true); assert.equal(h.exited, false);
        await delay(50); assert.equal(settled, false); assert.equal(disposed, false); assert.equal(existsSync(join(profile, "service-execution-recovery", "writer.lock")), true);
        child.postMessage({ op: "release" });
      }
      const result = await closing; assert.equal(result.ok, mode === "held-native-exit"); assert.equal(disposed, mode === "held-native-exit"); assert.equal(coordinator.close(), closing);
      if (mode === "held-native-exit") assert.equal(h.exitCode, 0);
      else {
        assert.equal(existsSync(join(profile, "service-execution-recovery", "writer.lock")), true);
        assert.equal(h.exitRequested, mode === "exit-timeout");
        if (!h.exited) { child.postMessage({ op: "release" }); await wait(() => h.exited, "late-native-exit"); }
        assert.equal((await coordinator.close()).ok, false); assert.equal(disposed, false);
        store.dispose(); // Explicit test cleanup after native exit, not coordinator authorization.
      }
      await wait(() => [...pids].every((pid) => !alive(pid)), "owned-test-processes-gone"); pids.clear();
      assert.ok(h.reportBody); assert.equal(readFileSync(file, "utf8"), h.reportBody);
      for (const value of [secret, "synthetic-shutdown-credential"]) assert.ok(!h.output.includes(value) && !JSON.stringify(h.messages).includes(value) && !h.reportBody.includes(value) && !witness.includes(value));
      reports.push({ mode, versions: boot.versions, mainConfirmed: h.confirmed, nativeExitObserved: h.exited, coordinatorDisposed: disposed, safeRelease: result.ok, lateExitRepairsFailure: false });
    }
    console.log("HOST_RELEASE_UTILITY_OK", JSON.stringify(reports));
  } catch (error) { console.error("HOST_RELEASE_UTILITY_FAILED", stage, String(error).replaceAll(secret, "[redacted]").replaceAll(home, "[test-home]").slice(0, 300)); process.exitCode = 1; }
  finally {
    clearTimeout(watchdog); for (const h of children) if (!h.exited) h.child.kill();
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* Exact test PID emergency cleanup, never recovery authorization. */ } }
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); app.exit(process.exitCode ?? 0);
  }
}
void run();
