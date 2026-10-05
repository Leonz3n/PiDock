// Actual separate Electron main; metadata-only probe, never installed.
import { app, utilityProcess } from "electron";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TaskRootIndex } from "../dist/main/task-root-index.js";
import { ProjectRegistry } from "../dist/main/project-registry.js";
import { ServiceCatalog, serviceCatalogAuthority } from "../dist/main/service-catalog.js";
import { ExperimentalServiceRecoveryStore } from "../dist/main/service-recovery-store-experiment.js";

const [mode, home] = process.argv.slice(2);
if (!["seed", "read", "store-denied", "lease-denied"].includes(mode) || !home) throw Error("invalid-presence-fixture");
const profile = join(home, "profile"), root = join(home, "tasks"), taskId = "task-abcdef12", taskDir = join(root, taskId);
app.setPath("userData", profile);
let child, store, exited = false, utilitySpawned = false;
const watchdog = setTimeout(() => { child?.kill(); console.error("PRESENCE_FIXTURE_TIMEOUT"); app.exit(1); }, 15000);
async function run() {
  await app.whenReady();
  const roots = new TaskRootIndex(profile, root), projects = new ProjectRegistry(profile), authority = serviceCatalogAuthority(roots, projects), catalog = new ServiceCatalog(profile, authority);
  if (mode === "seed") {
    mkdirSync(join(taskDir, "repo-a"), { recursive: true });
    writeFileSync(join(taskDir, "task.json"), JSON.stringify({ taskId, name: "Presence", dirId: taskId, root, taskDir,
      branch: "task/main", remoteBranch: "main", baseCommit: "test", repos: ["repo-a"],
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }));
    const project = await projects.create({ name: "Presence", description: "", repositories: [], directories: [] });
    await projects.claim(taskId, project.id, roots);
    const template = catalog.saveTemplate({ projectId: project.id, descriptor: { name: "Metadata only", program: "node", args: [], ports: [], runType: "long-lived" }, shared: [] });
    catalog.bindTask({ taskId, serviceId: template.serviceId, templateVersion: 1, rootId: "repo-a", subdir: "", programPath: process.execPath, privateRefs: [] });
  }
  const bindings = catalog.listTask(taskId); assert.equal(bindings.length, 1);
  const serviceId = bindings[0].binding.serviceId;
  const report = { mode, writerAcquired: false, leaseAcquired: false, utilitySpawned: false, serviceLaunchAttempts: 0,
    versions: { electron: process.versions.electron, node: process.versions.node } };
  const open = () => new ExperimentalServiceRecoveryStore(profile, authority, (id) => catalog.listTask(id).map((row) => row.binding.serviceId));
  if (mode === "store-denied") {
    assert.throws(open, /^Error: service-recovery-unavailable$/);
  } else {
    store = open(); report.writerAcquired = true;
    child = utilityProcess.fork(join(import.meta.dirname, "service-recovery-utility-fixture.mjs"), [], { env: {}, stdio: "pipe", serviceName: "presence-metadata-probe" });
    utilitySpawned = report.utilitySpawned = true;
    let exitResolve, readyResolve;
    const exit = new Promise((resolve) => { exitResolve = resolve; }), ready = new Promise((resolve) => { readyResolve = resolve; });
    child.once("exit", () => { exited = true; exitResolve(); });
    let output = "", lease, replyResolve;
    child.stdout?.on("data", (data) => { output += data; }); child.stderr?.on("data", (data) => { output += data; });
    child.on("message", (message) => {
      if (message?.kind === "ready") readyResolve();
      else if (message?.kind === "checkpoint-request") {
        try { child.postMessage({ kind: "checkpoint-result", id: message.id, response: { ok: true, checkpoint: lease.request(child, message.packet) } }); }
        catch { child.postMessage({ kind: "checkpoint-result", id: message.id, response: { ok: false, error: "probe-checkpoint-rejected" } }); }
      } else if (message?.kind === "command-complete") replyResolve?.(message.response);
    });
    await ready;
    const owner = { sender: child, hasExited: () => exited, subscribeExit: (listener) => { child.once("exit", listener); return () => child.removeListener("exit", listener); } };
    if (mode === "lease-denied") assert.throws(() => store.acquire(taskId, owner), /^Error: service-recovery-primary-missing$/);
    else {
      lease = store.acquire(taskId, owner); report.leaseAcquired = true;
      const checkpoint = { schemaVersion: 1, taskId, serviceId, state: "unconfirmed", ownerSessionId: "probe" };
      const response = new Promise((resolve) => { replyResolve = resolve; });
      child.postMessage({ kind: "command", id: 1, packet: { epoch: lease.epoch, op: mode === "seed" ? "write" : "read", serviceId, ...(mode === "seed" ? { checkpoint } : {}) } });
      const result = await response; assert.equal(result.ok, true);
      if (mode === "read") assert.deepEqual(result.checkpoint, checkpoint);
    }
    assert.equal(child.kill(), true); await exit; store.dispose();
    assert.ok(!output.includes(home));
  }
  clearTimeout(watchdog);
  console.log("PRESENCE_FIXTURE_OK=" + JSON.stringify(report)); app.exit(0);
}
void run().catch(() => { clearTimeout(watchdog); if (utilitySpawned && !exited) child.kill(); console.error("PRESENCE_FIXTURE_FAILED", mode); app.exit(1); });
