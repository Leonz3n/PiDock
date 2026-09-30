// Isolated checkpoint transport probe. No service execution or production RPC.
// After shell build: pnpm --filter @pidock/shell smoke:recovery
import { app, utilityProcess } from "electron";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExperimentalServiceRecoveryStore } from "../dist/main/service-recovery-store-experiment.js";
import { TaskRootIndex } from "../dist/main/task-root-index.js";
import { ProjectRegistry } from "../dist/main/project-registry.js";
import { ServiceCatalog, serviceCatalogAuthority } from "../dist/main/service-catalog.js";

if (process.platform !== "darwin") throw Error("macOS checkpoint probe only; no Windows acceptance");
const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-recovery-utility-")));
const profile = join(home, "profile"), root = join(home, "tasks"), taskId = "task-abcdef12", taskDir = join(root, taskId);
mkdirSync(profile, { mode: 0o700 }); mkdirSync(join(taskDir, "repo-a"), { recursive: true });
app.setPath("userData", profile);
const secret = "synthetic-recovery-value-not-for-storage-0123456789";
const children = [], replies = [];
let store, stage = "startup", commandId = 0;
const deadline = setTimeout(() => { for (const h of children) h.child.kill(); console.error("RECOVERY_LEASE_TIMEOUT", stage); app.exit(1); }, 30000);

function fork() {
  const child = utilityProcess.fork(join(import.meta.dirname, "service-recovery-utility-fixture.mjs"), [],
    { serviceName: "pidock-recovery-checkpoint-probe", env: {}, stdio: "pipe" });
  let resolveReady, resolveExit;
  const h = { child, exited: false, lease: null, output: "", pending: new Map(),
    ready: new Promise((resolve) => { resolveReady = resolve; }), exit: new Promise((resolve) => { resolveExit = resolve; }) };
  child.stdout?.on("data", (data) => { h.output += data; });
  child.stderr?.on("data", (data) => { h.output += data; });
  child.once("exit", () => { h.exited = true; resolveExit(); });
  h.owner = { sender: child, hasExited: () => h.exited, subscribeExit: (listener) => {
    child.once("exit", listener); return () => { child.removeListener("exit", listener); };
  } };
  h.route = (packet) => {
    let response;
    try { response = { ok: true, checkpoint: h.lease.request(child, packet) }; }
    catch (error) { response = { ok: false, error: error.message }; }
    replies.push(response); return response;
  };
  child.on("message", (message) => {
    if (message?.kind === "ready") resolveReady(message.versions);
    else if (message?.kind === "checkpoint-request" && h.pending.has(message.id)) {
      const response = h.route(message.packet);
      if (!h.exited) child.postMessage({ kind: "checkpoint-result", id: message.id, response });
    } else if (message?.kind === "command-complete") {
      const resolve = h.pending.get(message.id); h.pending.delete(message.id); resolve?.(message.response);
    }
  });
  h.command = (packet) => {
    assert.equal(h.exited, false);
    const id = ++commandId;
    const reply = new Promise((resolve) => { h.pending.set(id, resolve); });
    child.postMessage({ kind: "command", id, packet }); return reply;
  };
  children.push(h); return h;
}
async function run() {
  try {
    await app.whenReady();
    stage = "catalog-bootstrap";
    writeFileSync(join(taskDir, "task.json"), JSON.stringify({ taskId, name: "Recovery probe", dirId: taskId, root, taskDir,
      branch: "task/main", remoteBranch: "main", baseCommit: "test", repos: ["repo-a"],
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }));
    const roots = new TaskRootIndex(profile, root), projects = new ProjectRegistry(profile);
    const project = await projects.create({ name: "Recovery probe", description: "", repositories: [], directories: [] });
    await projects.claim(taskId, project.id, roots);
    const authority = serviceCatalogAuthority(roots, projects), catalog = new ServiceCatalog(profile, authority);
    const template = catalog.saveTemplate({ projectId: project.id, descriptor: { name: "Metadata only", program: "node", args: [], ports: [], runType: "long-lived" }, shared: [] });
    const serviceId = template.serviceId;
    catalog.bindTask({ taskId, serviceId, templateVersion: 1, rootId: "repo-a", subdir: "", programPath: process.execPath, privateRefs: [] });
    store = new ExperimentalServiceRecoveryStore(profile, authority, (id) => catalog.listTask(id).map((row) => row.binding.serviceId));
    const first = fork(), second = fork();
    stage = "utility-bootstrap";
    const versions = await Promise.all([first.ready, second.ready]);
    first.lease = store.acquire(taskId, first.owner);
    const packet = (lease, op, extra = {}) => ({ epoch: lease.epoch, op, serviceId, ...extra });
    const checkpoint = { schemaVersion: 1, taskId, serviceId, state: "unconfirmed", ownerSessionId: "probe" };
    stage = "main-write-ack";
    assert.deepEqual(await first.command(packet(first.lease, "read")), { ok: true, checkpoint: undefined });
    assert.equal((await first.command(packet(first.lease, "write", { checkpoint }))).ok, true);
    assert.deepEqual((await first.command(packet(first.lease, "read"))).checkpoint, checkpoint);
    const file = join(profile, "service-execution-recovery", `${createHash("sha256").update(taskId).digest("hex")}.json`);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).entries, [checkpoint]);
    stage = "sender-epoch-scope-denial";
    assert.throws(() => first.lease.request(second.child, packet(first.lease, "read")), /service-recovery-lease-stale/);
    assert.throws(() => store.acquire(taskId, second.owner), /service-recovery-lease-busy/);
    for (const invalid of [packet({ epoch: "old" }, "read"), packet(first.lease, "read", { taskDir: "../escape" }),
      packet(first.lease, "read", { exited: true }), packet(first.lease, "write", { checkpoint: { ...checkpoint, env: { TOKEN: secret } } })]) {
      assert.equal((await first.command(invalid)).ok, false);
    }
    assert.throws(() => store.acquire(taskId, second.owner), /service-recovery-lease-busy/);
    const before = readFileSync(file, "utf8"), oldPacket = packet(first.lease, "write", { checkpoint: { ...checkpoint, state: "stopped", ownerSessionId: null } });
    stage = "native-exit-revocation";
    assert.equal(first.child.kill(), true); await first.exit;
    assert.deepEqual(first.route(oldPacket), { ok: false, error: "service-recovery-lease-stale" });
    assert.equal(readFileSync(file, "utf8"), before);
    second.lease = store.acquire(taskId, second.owner); assert.notEqual(first.lease.epoch, second.lease.epoch);
    assert.deepEqual((await second.command(packet(second.lease, "read"))).checkpoint, checkpoint);
    assert.equal((await second.command(oldPacket)).ok, false);
    assert.deepEqual(first.route(oldPacket), { ok: false, error: "service-recovery-lease-stale" });
    assert.equal((await second.command(packet(second.lease, "write", { checkpoint }))).ok, true);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).hostEpoch, second.lease.epoch);
    assert.ok(!JSON.stringify(replies).includes(secret)); assert.ok(children.every((h) => !h.output.includes(secret)));
    const body = readFileSync(file, "utf8"); assert.ok(!body.includes(secret)); assert.ok(!body.includes(profile)); assert.ok(!body.includes(process.execPath));
    stage = "writer-close";
    assert.throws(() => store.dispose(), /service-recovery-hosts-active/);
    assert.equal(second.child.kill(), true); await second.exit; store.dispose();
    console.log("RECOVERY_LEASE_UTILITY_OK", JSON.stringify({ versions, mainOnlyStorage: true, nativeExitRevoked: true,
      lateWriteDenied: true, privateValueExcluded: true, serviceExecution: "not-connected" }));
    clearTimeout(deadline); rmSync(home, { recursive: true, force: true }); app.exit(0);
  } catch {
    console.error("RECOVERY_LEASE_UTILITY_FAILED", stage);
    for (const h of children) if (!h.exited) h.child.kill();
    await Promise.all(children.map((h) => h.exit));
    try { store?.dispose(); } catch { /* Never force an unknown writer lock open. */ }
    clearTimeout(deadline); app.exit(1);
  }
}
void run();
