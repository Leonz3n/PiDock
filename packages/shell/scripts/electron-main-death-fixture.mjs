// Spawned Electron main fixture. A Node test parent SIGKILLs this actual main.
// Never packaged or imported by installed main/Host.
import { app, utilityProcess } from "electron";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TaskRootIndex } from "../dist/main/task-root-index.js";
import { ProjectRegistry } from "../dist/main/project-registry.js";
import { ServiceCatalog, serviceCatalogAuthority } from "../dist/main/service-catalog.js";
import { ExperimentalServiceRecoveryStore } from "../dist/main/service-recovery-store-experiment.js";
import { inspectDevelopmentSupervisor } from "../dist/main/service-supervisor-artifact.js";
import { prepareServiceSupervisorExperiment } from "../dist/main/service-supervisor-preparation.js";
const [mode, home] = process.argv.slice(2);
if (!["running", "held-report", "restart"].includes(mode) || !home) throw Error("invalid-main-death-fixture");
const profile = join(home, "profile"), root = join(home, "tasks"), taskId = "task-abcdef12", taskDir = join(root, taskId);
app.setPath("userData", profile);
const send = (value) => console.log("MAIN_DEATH_FIXTURE=" + JSON.stringify(value));
let child;
const watchdog = setTimeout(() => { child?.kill(); send({ event: "failed", code: "fixture-timeout" }); app.exit(1); }, 30000);
async function run() {
  send({ event: "stage", stage: "before-ready", mode });
  await app.whenReady();
  send({ event: "stage", stage: "ready" });
  const roots = new TaskRootIndex(profile, root), projects = new ProjectRegistry(profile), authority = serviceCatalogAuthority(roots, projects), catalog = new ServiceCatalog(profile, authority);
  if (mode === "restart") {
    assert.equal(catalog.listTask(taskId).length, 1);
    let failure;
    try { new ExperimentalServiceRecoveryStore(profile, authority, (id) => catalog.listTask(id).map((row) => row.binding.serviceId)); }
    catch (error) { failure = String(error); }
    assert.equal(failure, "Error: service-recovery-unavailable");
    clearTimeout(watchdog); send({ event: "restart-denied", writerAcquired: false, utilitySpawned: false, versions: { electron: process.versions.electron, node: process.versions.node } }); app.exit(0); return;
  }
  mkdirSync(join(taskDir, "repo-a"), { recursive: true }); execFileSync("git", ["init", "-q", taskDir]);
  writeFileSync(join(taskDir, "task.json"), JSON.stringify({ taskId, name: mode, dirId: taskId, root, taskDir, branch: "task/main", remoteBranch: "main", baseCommit: "test", repos: ["repo-a"], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }));
  const project = await projects.create({ name: "Main death", description: "", repositories: [], directories: [] }); await projects.claim(taskId, project.id, roots);
  const template = catalog.saveTemplate({ projectId: project.id, descriptor: { name: mode, program: "fixture", args: ["host-parent"], ports: [], runType: "long-lived" }, shared: [] }), serviceId = template.serviceId;
  send({ event: "stage", stage: "catalog-ready" });
  const binary = join(home, "fixture"); execFileSync("go", ["build", "-trimpath", "-o", binary, "./testdata/fixture"], { cwd: join(import.meta.dirname, "..", "native", "service-supervisor"), timeout: 30000, stdio: "pipe" });
  catalog.bindTask({ taskId, serviceId, templateVersion: 1, rootId: "repo-a", subdir: "", programPath: binary, privateRefs: [{ key: "FIXTURE_VALUE", envRef: "LOCAL_FIXTURE_VALUE" }] });
  const artifact = inspectDevelopmentSupervisor(join(import.meta.dirname, "..", "build", "service-supervisor", "darwin-arm64")); assert.equal(artifact.state, "available-for-experiment");
  send({ event: "stage", stage: "native-built" });
  const prepared = prepareServiceSupervisorExperiment(catalog, { taskId, projectId: project.id, serviceId }, { LOCAL_FIXTURE_VALUE: "synthetic-main-death-private" }, artifact.artifact);
  const store = new ExperimentalServiceRecoveryStore(profile, authority, (id) => catalog.listTask(id).map((row) => row.binding.serviceId));
  child = utilityProcess.fork(join(import.meta.dirname, "service-supervisor-utility-fixture.mjs"), [], { env: {}, stdio: "pipe", serviceName: "main-death-fixture" });
  let exited = false, ready = false, running = false, sequence = 0, reportPublished = false, closeRequested = false;
  const pids = new Set();
  child.once("exit", () => { exited = true; });
  child.stdout?.on("data", (data) => { if (String(data).includes("synthetic-")) throw Error("fixture-private-output"); });
  child.stderr?.on("data", (data) => { if (String(data).includes("synthetic-")) throw Error("fixture-private-output"); });
  const lease = store.acquire(taskId, { sender: child, hasExited: () => exited, subscribeExit: (listener) => { child.once("exit", listener); return () => child.removeListener("exit", listener); } });
  send({ event: "stage", stage: "leased" });
  const barrier = () => {
    if (mode === "held-report" && running && pids.size === 3 && !closeRequested) { closeRequested = true; child.postMessage({ op: "close" }); }
    if (ready || !running || pids.size !== 3 || (mode === "held-report" && !reportPublished)) return;
    ready = true; clearTimeout(watchdog);
    send({ event: "kill-barrier", mode, mainPid: process.pid, hostPid: child.pid, resourcePids: [...pids], epoch: lease.epoch, serviceId, reportPublished, releaseConfirmed: false, versions: { electron: process.versions.electron, node: process.versions.node } });
    // Keep actual main alive without disposing the writer; only the test parent kills it.
    setInterval(() => {}, 1000);
  };
  child.on("message", (message) => {
    try {
    if (message.event && message.event !== "log") send({ event: "stage", stage: message.event });
    if (message.event === "started") { pids.add(message.pid); pids.add(message.supervisorPid); send({ event: "observed-test-pids", pids: [message.pid, message.supervisorPid] }); }
    if (message.event === "log" && /^descendant:[0-9]+$/.test(message.line)) { const pid = Number(message.line.split(":")[1]); pids.add(pid); send({ event: "observed-test-pids", pids: [pid] }); }
    if (message.kind === "checkpoint-request") {
      assert.equal(message.id, ++sequence); const checkpoint = lease.request(child, message.packet);
      child.postMessage({ kind: "checkpoint-ack", id: message.id, epoch: lease.epoch, ok: true, ...(message.packet.op === "read" ? { checkpoint: checkpoint ?? null } : {}) });
    }
    if (message.event === "control-result") { assert.equal(message.result.ok, true); running = true; }
    if (message.kind === "shutdown-report-request") { send({ event: "stage", stage: "publishing-report" }); assert.equal(mode, "held-report"); lease.request(child, message.packet); reportPublished = true; /* No ack, confirm, or writer dispose. */ }
    if (message.event === "close-result" || message.event === "failed") throw Error("fixture-ended-before-main-kill");
    barrier();
    if (message.event === "boot") {
      assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0);
      send({ event: "observed-test-pids", pids: [child.pid] });
      prepared.use((program, request) => child.postMessage({ op: "launch", binary: program, request, lifecycle: { taskId, taskDir, serviceId, epoch: lease.epoch, closeReport: mode === "held-report" } }));
    }
    } catch { clearTimeout(watchdog); child.kill(); send({ event: "failed", code: "main-death-message-failed" }); app.exit(1); }
  });
  // Ensure no credentials are in the existing lock token.
  assert.match(readFileSync(join(profile, "service-execution-recovery", "writer.lock"), "utf8"), /^[a-f0-9-]{36}$/);
}
void run().catch(() => { clearTimeout(watchdog); child?.kill(); send({ event: "failed", code: "main-death-fixture-failed" }); app.exit(1); });
