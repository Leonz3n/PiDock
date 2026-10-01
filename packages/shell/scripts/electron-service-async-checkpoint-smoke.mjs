// Actual main journal -> parent port ack -> utility controller -> native supervisor.
// Isolated macOS experiment only, never production Host/RPC or installed discovery.
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
if (process.platform !== "darwin" || process.arch !== "arm64") throw Error("macOS arm64 only; no Windows acceptance");
const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-async-recovery-")));
const profile = join(home, "profile"), root = join(home, "tasks"), taskId = "task-abcdef12", taskDir = join(root, taskId);
mkdirSync(profile, { mode: 0o700 }); mkdirSync(join(taskDir, "repo-a"), { recursive: true }); app.setPath("userData", profile);
const secret = "synthetic-async-checkpoint-private-0123456789", children = [], tracked = new Set(), reports = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let store, stage = "startup";
const watchdog = setTimeout(() => { for (const h of children) h.child.kill(); for (const pid of tracked) { try { process.kill(pid, "SIGKILL"); } catch { /* Observed test PID may already have exited. */ } } console.error("ASYNC_CHECKPOINT_TIMEOUT", stage); app.exit(1); }, 60000);
async function wait(predicate, label) {
  for (let i = 0; i < 400; i++) { const value = predicate(); if (value) return value; await delay(20); }
  throw Error(`test-wait-timeout:${label}`);
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } }
function fork(serviceId, heldState) {
  const child = utilityProcess.fork(join(import.meta.dirname, "service-supervisor-utility-fixture.mjs"), [], { serviceName: "pidock-async-recovery-probe", env: {}, stdio: "pipe" });
  const h = { child, messages: [], output: "", exited: false, lease: null, release: null, sequence: 0, acknowledgements: [] };
  child.once("exit", () => { h.exited = true; });
  child.stdout?.on("data", (data) => { h.output += data; }); child.stderr?.on("data", (data) => { h.output += data; });
  h.lease = store.acquire(taskId, { sender: child, hasExited: () => h.exited, subscribeExit: (listener) => { child.once("exit", listener); return () => child.removeListener("exit", listener); } });
  child.on("message", (message) => {
    h.messages.push(message);
    if (message?.event === "started") { tracked.add(message.pid); tracked.add(message.supervisorPid); }
    if (message?.event === "log" && /^descendant:[0-9]+$/.test(message.line)) tracked.add(Number(message.line.split(":")[1]));
    if (message?.kind !== "checkpoint-request") return;
    let response;
    try {
      assert.deepEqual(Object.keys(message).sort(), ["id", "kind", "packet"]);
      assert.equal(message.id, ++h.sequence);
      const checkpoint = h.lease.request(child, message.packet);
      response = { kind: "checkpoint-ack", id: message.id, epoch: h.lease.epoch, ok: true,
        ...(message.packet.op === "read" ? { checkpoint: checkpoint ?? null } : {}) };
    } catch { response = { kind: "checkpoint-ack", id: message.id, epoch: h.lease.epoch, ok: false }; }
    const deliver = () => { h.acknowledgements.push(response); if (!h.exited) child.postMessage(response); };
    if (heldState !== undefined && message.packet.checkpoint?.state === heldState && !h.release) h.release = deliver;
    else deliver();
  });
  h.receipt = (event) => wait(() => {
    const result = h.messages.find((message) => message.event === event);
    if (result) return result;
    if (h.exited || h.messages.some((message) => message.event === "failed")) throw Error(`fixture-failed:${event}`);
  }, event);
  h.lifecycle = { taskId, taskDir, serviceId, epoch: h.lease.epoch };
  children.push(h); return h;
}
async function exit(h) { if (!h.exited) h.child.kill(); await wait(() => h.exited, "utility-exit"); }
async function run() {
  try {
    await app.whenReady(); stage = "catalog";
    writeFileSync(join(taskDir, "task.json"), JSON.stringify({ taskId, name: "Async recovery", dirId: taskId, root, taskDir, branch: "task/main", remoteBranch: "main", baseCommit: "test", repos: ["repo-a"], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }));
    const roots = new TaskRootIndex(profile, root), projects = new ProjectRegistry(profile);
    const project = await projects.create({ name: "Async recovery", description: "", repositories: [], directories: [] }); await projects.claim(taskId, project.id, roots);
    const authority = serviceCatalogAuthority(roots, projects), catalog = new ServiceCatalog(profile, authority);
    const artifact = inspectDevelopmentSupervisor(join(import.meta.dirname, "..", "build", "service-supervisor", "darwin-arm64")); assert.equal(artifact.state, "available-for-experiment");
    const fixture = join(home, "fixture"); execFileSync("go", ["build", "-trimpath", "-o", fixture, "./testdata/fixture"], { cwd: join(import.meta.dirname, "..", "native", "service-supervisor"), timeout: 30000, stdio: "pipe" });
    store = new ExperimentalServiceRecoveryStore(profile, authority, (id) => catalog.listTask(id).map((row) => row.binding.serviceId));
    const journal = join(profile, "service-execution-recovery", `${createHash("sha256").update(taskId).digest("hex")}.json`);
    const read = (serviceId) => JSON.parse(readFileSync(journal, "utf8")).entries.find((entry) => entry.serviceId === serviceId);
    for (const mode of ["close", "cancel", "recovery", "lost-start-ack"]) {
      stage = `${mode}:prepare`;
      const template = catalog.saveTemplate({ projectId: project.id, descriptor: { name: mode, program: "fixture", args: ["host-parent"], ports: [], runType: "long-lived" }, shared: [] });
      const serviceId = template.serviceId;
      catalog.bindTask({ taskId, serviceId, templateVersion: 1, rootId: "repo-a", subdir: "", programPath: fixture, privateRefs: [{ key: "FIXTURE_VALUE", envRef: "LOCAL_FIXTURE_VALUE" }] });
      const prepared = prepareServiceSupervisorExperiment(catalog, { projectId: project.id, taskId, serviceId }, { LOCAL_FIXTURE_VALUE: secret }, artifact.artifact);
      const h = fork(serviceId, mode === "close" ? "stopped" : mode === "lost-start-ack" ? "starting" : undefined);
      const boot = await h.receipt("boot");
      prepared.use((binary, request) => h.child.postMessage({ op: "launch", binary, request, lifecycle: { ...h.lifecycle, holdReady: mode === "cancel" } }));
      if (mode === "lost-start-ack") {
        stage = `${mode}:lost-ack`; await wait(() => h.release, "held-starting-ack");
        assert.equal(read(serviceId).state, "starting"); assert.equal(h.messages.some((row) => row.event === "started"), false);
        const control = await h.receipt("control-result"); assert.deepEqual(control.result, { ok: false, error: "service-recovery-persistence-failed" });
        assert.equal(h.messages.some((row) => row.event === "started"), false); assert.equal(control.snapshot.state, "unconfirmed");
        h.release(); h.child.postMessage({ op: "close" }); assert.equal((await h.receipt("close-result")).result.ok, false);
        assert.equal(read(serviceId).state, "starting"); await exit(h);
      } else {
        stage = `${mode}:started`; const started = await h.receipt("started"); const line = await h.receipt("log"); assert.ok(line);
        const descendant = await wait(() => h.messages.find((row) => row.event === "log" && /^descendant:[0-9]+$/.test(row.line)), "descendant");
        const pids = [started.pid, started.supervisorPid, Number(descendant.line.split(":")[1])];
        if (mode === "cancel") {
          assert.equal(read(serviceId).state, "starting"); h.child.postMessage({ op: "cancel-start" });
          assert.deepEqual((await h.receipt("control-result")).result, { ok: false, error: "service-operation-cancelled" });
          assert.equal(read(serviceId).state, "stopped"); h.child.postMessage({ op: "close" }); assert.equal((await h.receipt("close-result")).result.ok, true);
        } else {
          assert.deepEqual((await h.receipt("control-result")).result, { ok: true, state: "running" }); assert.equal(read(serviceId).state, "running");
          if (mode === "close") {
            h.child.postMessage({ op: "close" }); await wait(() => h.release, "held-terminal-ack");
            assert.equal(read(serviceId).state, "stopped"); assert.equal(h.messages.some((row) => row.event === "close-result"), false);
            h.release(); assert.deepEqual((await h.receipt("close-result")).result, { ok: true, state: "stopped" });
          } else { process.kill(h.child.pid, "SIGKILL"); await wait(() => h.exited, "host-kill"); }
        }
        await wait(() => pids.every((pid) => !alive(pid)), "owned-resources-gone"); for (const pid of pids) tracked.delete(pid); await exit(h);
      }
      if (mode === "recovery" || mode === "lost-start-ack") {
        const before = read(serviceId), fresh = fork(serviceId); await fresh.receipt("boot"); fresh.child.postMessage({ op: "reopen", lifecycle: fresh.lifecycle });
        const recovered = await fresh.receipt("recovered"); assert.equal(recovered.launchAttempted, false); assert.equal(recovered.control.ok, false); assert.equal(recovered.close.ok, false);
        assert.equal(recovered.snapshot.state, "unconfirmed"); assert.equal(recovered.resources[0].verificationRequired, true); assert.deepEqual(read(serviceId), before);
        assert.throws(() => h.lease.request(h.child, { epoch: h.lease.epoch, op: "write", serviceId, checkpoint: { ...before, state: "stopped", ownerSessionId: null } }), /service-recovery-lease-stale/);
        await exit(fresh);
      }
      assert.ok(!readFileSync(journal, "utf8").includes(secret)); assert.ok(!JSON.stringify(children.flatMap((row) => row.acknowledgements)).includes(secret));
      assert.ok(children.every((row) => !row.output.includes(secret) && !JSON.stringify(row.messages).includes(secret)));
      reports.push({ mode, versions: boot.versions, durableAckChecked: true, privateValueExcluded: true });
    }
    store.dispose(); console.log("ASYNC_CHECKPOINT_UTILITY_OK", JSON.stringify(reports));
  } catch (error) { console.error("ASYNC_CHECKPOINT_UTILITY_FAILED", stage, String(error).replaceAll(secret, "[redacted]").slice(0, 300)); process.exitCode = 1; }
  finally {
    clearTimeout(watchdog); for (const h of children) if (!h.exited) h.child.kill();
    for (const pid of tracked) { try { process.kill(pid, "SIGKILL"); } catch { /* Observed test PID may already have exited. */ } }
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); app.exit(process.exitCode ?? 0);
  }
}
void run();
