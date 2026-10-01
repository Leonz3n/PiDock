// Real main journal/report ack -> utility SDK shutdown -> native service drain.
// Isolated development experiment, never installed RPC or renderer service control.
import { app, utilityProcess } from "electron";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskRootIndex } from "../dist/main/task-root-index.js";
import { ProjectRegistry } from "../dist/main/project-registry.js";
import { ServiceCatalog, serviceCatalogAuthority } from "../dist/main/service-catalog.js";
import { ExperimentalServiceRecoveryStore } from "../dist/main/service-recovery-store-experiment.js";
import { inspectDevelopmentSupervisor } from "../dist/main/service-supervisor-artifact.js";
import { prepareServiceSupervisorExperiment } from "../dist/main/service-supervisor-preparation.js";
if (process.platform !== "darwin" || process.arch !== "arm64") throw Error("macOS arm64 only; not Windows acceptance");
const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-shutdown-report-"))), profile = join(home, "profile"), root = join(home, "tasks");
mkdirSync(profile, { mode: 0o700 }); mkdirSync(root); app.setPath("userData", profile);
const secret = "synthetic-report-private-value", children = [], pids = new Set(), reports = [];
let store, stage = "startup";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const watchdog = setTimeout(() => { console.error("SHUTDOWN_REPORT_TIMEOUT", stage); app.exit(1); }, 60000);
async function wait(predicate, label) { for (let i = 0; i < 400; i++) { const value = predicate(); if (value) return value; await delay(20); } throw Error(`timeout:${label}`); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } }
async function exit(h) { if (!h.exited) h.child.kill(); await wait(() => h.exited, "native-host-exit"); }
function fork(taskId) {
  const child = utilityProcess.fork(join(import.meta.dirname, "service-supervisor-utility-fixture.mjs"), [], { env: {}, stdio: "pipe", serviceName: "shutdown-report-experiment" });
  const h = { child, exited: false, messages: [], output: "", release: null, confirmed: false, sequence: 0 };
  child.once("exit", () => { h.exited = true; }); child.stdout?.on("data", (data) => { h.output += data; }); child.stderr?.on("data", (data) => { h.output += data; });
  h.lease = store.acquire(taskId, { sender: child, hasExited: () => h.exited, subscribeExit: (listener) => { child.once("exit", listener); return () => child.removeListener("exit", listener); } });
  child.on("message", (message) => {
    h.messages.push(message);
    if (message.event === "started") { pids.add(message.pid); pids.add(message.supervisorPid); }
    if (message.event === "log" && /^descendant:[0-9]+$/.test(message.line)) pids.add(Number(message.line.split(":")[1]));
    if (message.kind === "checkpoint-request") {
      let reply;
      try { assert.equal(message.id, ++h.sequence); const checkpoint = h.lease.request(child, message.packet); reply = { kind: "checkpoint-ack", id: message.id, epoch: h.lease.epoch, ok: true, ...(message.packet.op === "read" ? { checkpoint: checkpoint ?? null } : {}) }; }
      catch { reply = { kind: "checkpoint-ack", id: message.id, epoch: h.lease.epoch, ok: false }; }
      if (!h.exited) child.postMessage(reply);
    } else if (message.kind === "shutdown-report-request") {
      assert.deepEqual(Object.keys(message).sort(), ["id", "kind", "packet"]); assert.equal(message.id, 1);
      let saved = false;
      try { h.lease.request(child, message.packet); saved = true; } catch { /* Failed publication never gets a positive receipt. */ }
      h.release = () => {
        let ok = saved;
        try { h.lease.verifyShutdown(child, message.packet.report); } catch { ok = false; }
        if (!h.exited) child.postMessage({ kind: "shutdown-report-ack", id: 1, epoch: h.lease.epoch, ok });
      };
    } else if (message.event === "close-result" && message.result.ok) {
      try { h.lease.confirmShutdown(child, message.result.report); h.confirmed = true; } catch { /* No main release for stale/invalid completion. */ }
    }
  });
  h.receipt = (event) => wait(() => { const value = h.messages.find((message) => message.event === event); if (value) return value; if (h.exited || h.messages.some((message) => message.event === "failed")) throw Error(`fixture-failed:${event}`); }, event);
  children.push(h); return h;
}
async function run() {
  try {
    await app.whenReady(); const roots = new TaskRootIndex(profile, root), projects = new ProjectRegistry(profile), project = await projects.create({ name: "Shutdown report", description: "", repositories: [], directories: [] });
    const catalog = new ServiceCatalog(profile, serviceCatalogAuthority(roots, projects));
    store = new ExperimentalServiceRecoveryStore(profile, serviceCatalogAuthority(roots, projects), (id) => catalog.listTask(id).map((row) => row.binding.serviceId));
    const artifact = inspectDevelopmentSupervisor(join(import.meta.dirname, "..", "build", "service-supervisor", "darwin-arm64")); assert.equal(artifact.state, "available-for-experiment");
    const binary = join(home, "fixture"); execFileSync("go", ["build", "-trimpath", "-o", binary, "./testdata/fixture"], { cwd: join(import.meta.dirname, "..", "native", "service-supervisor"), timeout: 30000, stdio: "pipe" });
    let index = 0;
    for (const mode of ["close", "lost-ack", "catalog-revoked", "host-death"]) {
      stage = mode; const taskId = `task-0000000${++index}`, taskDir = join(root, taskId); mkdirSync(join(taskDir, "repo-a"), { recursive: true }); execFileSync("git", ["init", "-q", taskDir]);
      writeFileSync(join(taskDir, "task.json"), JSON.stringify({ taskId, name: mode, dirId: taskId, root, taskDir, branch: "task/main", remoteBranch: "main", baseCommit: "test", repos: ["repo-a"], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }));
      await projects.claim(taskId, project.id, roots);
      const template = catalog.saveTemplate({ projectId: project.id, descriptor: { name: mode, program: "fixture", args: ["host-parent"], ports: [], runType: "long-lived" }, shared: [] }), serviceId = template.serviceId;
      catalog.bindTask({ taskId, serviceId, templateVersion: 1, rootId: "repo-a", subdir: "", programPath: binary, privateRefs: [{ key: "FIXTURE_VALUE", envRef: "LOCAL_FIXTURE_VALUE" }] });
      const prepared = prepareServiceSupervisorExperiment(catalog, { taskId, projectId: project.id, serviceId }, { LOCAL_FIXTURE_VALUE: secret }, artifact.artifact), h = fork(taskId);
      const boot = await h.receipt("boot"); prepared.use((program, request) => h.child.postMessage({ op: "launch", binary: program, request, lifecycle: { taskId, taskDir, serviceId, epoch: h.lease.epoch, closeReport: true } }));
      assert.equal((await h.receipt("control-result")).result.ok, true); h.child.postMessage({ op: "close" }); await wait(() => h.release, "held-report-ack");
      const file = join(profile, "service-execution-recovery", `${createHash("sha256").update(taskId).digest("hex")}.json`), document = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(document.shutdown.hostEpoch, h.lease.epoch); assert.equal(document.entries[0].state, "stopped"); assert.equal(document.entries[0].ownerSessionId, null);
      assert.equal(h.confirmed, false); assert.equal(h.messages.some((row) => row.event === "close-result"), false); assert.throws(() => store.dispose(), /service-recovery-hosts-active/);
      await wait(() => [...pids].every((pid) => !alive(pid)), "owned-test-processes-gone"); pids.clear();
      if (mode === "host-death") {
        process.kill(h.child.pid, "SIGKILL"); await wait(() => h.exited, "Host-SIGKILL"); h.release();
        const fresh = fork(taskId); await fresh.receipt("boot"); assert.notEqual(fresh.lease.epoch, h.lease.epoch); assert.throws(() => fresh.lease.confirmShutdown(fresh.child, document.shutdown)); assert.throws(() => h.lease.confirmShutdown(h.child, document.shutdown)); await exit(fresh);
      } else {
        if (mode === "lost-ack") { assert.equal((await h.receipt("close-result")).result.ok, false); h.release(); }
        else {
          if (mode === "catalog-revoked") {
            const added = catalog.saveTemplate({ projectId: project.id, descriptor: { name: "added", program: "fixture", args: [], ports: [], runType: "long-lived" }, shared: [] });
            catalog.bindTask({ taskId, serviceId: added.serviceId, templateVersion: 1, rootId: "repo-a", subdir: "", programPath: binary, privateRefs: [] });
          }
          h.release(); assert.equal((await h.receipt("close-result")).result.ok, mode === "close");
        }
        assert.equal(h.confirmed, mode === "close"); h.child.postMessage({ op: "close" }); await delay(50); assert.equal(h.confirmed, mode === "close"); await exit(h);
      }
      assert.equal(readFileSync(file, "utf8"), JSON.stringify(document));
      for (const value of [secret, "synthetic-shutdown-credential"]) {
        assert.ok(!JSON.stringify(document).includes(value)); assert.ok(children.every((child) => !child.output.includes(value) && !JSON.stringify(child.messages).includes(value)));
      }
      assert.ok(!JSON.stringify(document).includes(profile));
      reports.push({ mode, versions: boot.versions, durableReportChecked: true, releaseConfirmed: mode === "close", privateValueExcluded: true });
    }
    store.dispose(); console.log("SHUTDOWN_REPORT_UTILITY_OK", JSON.stringify(reports));
  } catch (error) { console.error("SHUTDOWN_REPORT_UTILITY_FAILED", stage, String(error).replaceAll(secret, "[redacted]").replaceAll(home, "[test-home]").slice(0, 300)); process.exitCode = 1; }
  finally {
    clearTimeout(watchdog); for (const h of children) if (!h.exited) h.child.kill();
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* Test emergency cleanup, not production ownership. */ } }
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); app.exit(process.exitCode ?? 0);
  }
}
void run();
