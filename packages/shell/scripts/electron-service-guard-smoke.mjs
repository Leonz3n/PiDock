// #7 safety gate: real Electron utilityProcess + Host RPC, no renderer or mock lifecycle.
// Run after shell build: pnpm --filter @pidock/shell exec electron scripts/electron-service-guard-smoke.mjs
import { app, utilityProcess } from "electron";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTaskDiskRecord, serializeTaskRecord } from "../dist/host/task-store.js";
import { buildHostEnv } from "../dist/host/host-guards.js";
import { TaskRootIndex } from "../dist/main/task-root-index.js";
import { PerTaskHostRegistry } from "../dist/main/runtime.js";
import { HostClient } from "../dist/rpc/host-client.js";
import { shutdownTestRegistry } from "./shutdown-test-registry.mjs";

const root = mkdtempSync(join(tmpdir(), "pidock-service-guard-"));
const profile = join(root, "profile"), taskRoot = join(root, "tasks"), taskId = "task-abcdef12";
const taskDir = join(taskRoot, taskId);
mkdirSync(profile); mkdirSync(taskDir, { recursive: true });
app.setPath("userData", profile);
const watchdog = setTimeout(() => { console.error("SERVICE_GUARD_TIMEOUT"); process.exit(1); }, 30000);
let registry;
const children = [];
async function run() {
try {
  await app.whenReady();
  const repoDir = join(taskDir, "invoice");
  mkdirSync(join(repoDir, ".vscode"), { recursive: true });
  writeFileSync(join(repoDir, ".vscode", "launch.json"), JSON.stringify({ configurations: [
    { name: "invoice-dev", program: "node", args: ["secret-command"], env: { API_TOKEN: "synthetic-private-token-guard" } },
  ] }));
  writeFileSync(join(taskDir, "task.json"), serializeTaskRecord(buildTaskDiskRecord({
    taskId, name: "guard", dirId: taskId, branch: "main", root: taskRoot, taskDir,
    remoteBranch: "main", baseCommit: "test", repos: ["invoice"], now: new Date().toISOString(),
  })));
  const index = new TaskRootIndex(profile, taskRoot);
  registry = new PerTaskHostRegistry("service-guard", async (workspace, task) => {
    const child = utilityProcess.fork(join(import.meta.dirname, "..", "dist", "host", "host-entry.js"), [], {
      serviceName: "service-guard-host", env: buildHostEnv(process.env, workspace, task, app.getPath("userData")), stdio: "pipe",
    });
    children.push(child);
    child.stderr?.on("data", (data) => process.stderr.write(`[service-guard-host] ${data}`));
    return { child, client: new HostClient(child) };
  }, (id) => index.resolve(id), undefined, index);
  const call = async (op, payload, origin) => {
    try {
      const result = await registry.routeTaskOp({ taskId, op, payload, origin });
      return { ok: true, payload: result.payload };
    } catch (error) { return { ok: false, error: String(error) }; }
  };
  const secret = "synthetic-private-token-guard";
  const registration = {
    serviceId: "invoice", templateVersion: "v1",
    descriptor: { name: "invoice", program: process.execPath, args: ["-e", "console.log('command-secret')"], ports: [], runType: "long-lived" },
    layers: { repoDefaults: [], shared: [], privateEntries: [{ key: "PRIVATE_KEY", value: secret, secret: true }], task: [] },
  };
  const origin = { kind: "shell-ui", senderWebContentsId: 42 };
  const scan = await call("task/serviceImportHints", { rootId: "invoice" }, origin);
  assert.equal(scan.ok, true);
  assert.equal(scan.payload.scan.hints.length, 1);
  assert.equal(JSON.stringify(scan).includes(secret), false);
  assert.equal(JSON.stringify(scan).includes("secret-command"), false);
  assert.equal((await call("task/serviceImportHints", { rootId: "invoice", path: "/tmp/other" }, origin)).ok, false);
  assert.equal((await call("task/serviceImportHints", { rootId: "missing" }, origin)).ok, false);
  assert.equal((await call("task/registerService", registration)).ok, false);
  assert.equal((await call("task/registerService", { ...registration, sessionId: "main" }, origin)).ok, false);
  const registered = await call("task/registerService", registration, origin);
  assert.equal(registered.ok, true);
  assert.equal(JSON.stringify(registered).includes(secret), false);
  const planned = await call("task/planServiceStart", { serviceId: "invoice", cwd: taskDir }, origin);
  assert.equal(planned.ok, true);
  assert.equal(JSON.stringify(planned).includes(secret), false);
  assert.equal(JSON.stringify(planned).includes("command-secret"), false);
  const before = await call("task/serviceStatus", { serviceId: "invoice" }, origin);
  assert.equal(before.ok, true);
  assert.equal(before.payload.service.lifecycle, "stopped");
  assert.equal(JSON.stringify(before).includes(secret), false);
  const denied = await call("task/controlService", { serviceId: "invoice", action: "start" }, origin);
  assert.equal(denied.ok, false);
  assert.match(denied.error, /service-execution-unavailable/);
  assert.equal((await call("task/controlService", { serviceId: "invoice", action: "start" })).ok, false);
  const agentDenied = await call("task/controlService", { serviceId: "invoice", action: "start", sessionId: "main" }, origin);
  assert.equal(agentDenied.ok, false);
  assert.match(agentDenied.error, /service-execution-unavailable/);
  const approvals = await call("task/listApprovals", { sessionId: "main" }, origin);
  assert.equal(approvals.ok, true);
  assert.deepEqual(approvals.payload.approvals, []);
  const after = await call("task/serviceStatus", { serviceId: "invoice" }, origin);
  assert.equal(after.payload.service.lifecycle, "stopped");
  const privateFile = join(profile, "profile-private.json"); writeFileSync(privateFile, "synthetic-protected-profile-body");
  symlinkSync(profile, join(repoDir, "profile-link"), "dir");
  const protectedRead = await call("task/filePreview", { rootId: "invoice", relative: "profile-link/profile-private.json" }, origin);
  assert.equal(protectedRead.ok, false); assert.equal(JSON.stringify(protectedRead).includes(profile), false);
  assert.equal(JSON.stringify(protectedRead).includes("synthetic-protected-profile-body"), false);
  const safeRead = await call("task/filePreview", { rootId: "invoice", relative: ".vscode/launch.json" }, origin);
  assert.equal(safeRead.ok, true);
  const taskFile = join(taskDir, "task.json"), record = JSON.parse(readFileSync(taskFile, "utf8"));
  writeFileSync(taskFile, JSON.stringify({ ...record, dirLinks: [{ directoryId: "abcd1234", linkName: "dir-abcd1234", sourcePath: profile, snapshotAt: record.createdAt }] }));
  assert.equal((await call("task/fileRoots", {}, origin)).ok, false);
  assert.equal((await call("task/serviceImportHints", { rootId: "invoice" }, origin)).ok, false);
  assert.equal(readFileSync(privateFile, "utf8"), "synthetic-protected-profile-body");
  writeFileSync(taskFile, JSON.stringify(record));
  assert.equal((await call("task/fileRoots", {}, origin)).ok, true);
  const unprotectedChild = utilityProcess.fork(join(import.meta.dirname, "..", "dist", "host", "host-entry.js"), [], {
    serviceName: "missing-profile-context", env: buildHostEnv({ PIDOCK_PROTECTED_PROFILE: profile }, "unprotected-test", { taskId, taskDir }), stdio: "pipe",
  });
  children.push(unprotectedChild); const unprotectedClient = new HostClient(unprotectedChild);
  const unprotectedExit = new Promise((resolve) => unprotectedChild.once("exit", resolve));
  await unprotectedClient.ping();
  await assert.rejects(unprotectedClient.task({ workspaceId: "unprotected-test", taskId, op: "task/fileRoots", payload: {}, origin }), /protected-application-path/);
  unprotectedClient.dispose(); unprotectedChild.kill(); await unprotectedExit;
  console.log("SERVICE_GUARD_SMOKE_OK", JSON.stringify({ missingTrustedContextDenied: true, protectedProfileReadDenied: true, oldProtectedSourceDenied: true, registered: registered.payload, plan: planned.payload, status: after.payload.service.lifecycle, denied: denied.error }));
} catch (error) {
  console.error("SERVICE_GUARD_SMOKE_FAILED", error);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  const cleanupFailures = await shutdownTestRegistry(registry, {
    // Windowless smoke: synthetic test origin for the attested seam.
    origin: { kind: "shell-ui", senderWebContentsId: 42 },
    label: "Service guard cleanup",
  });
  for (const child of children) child.kill();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  if (cleanupFailures.length) { console.error("SERVICE_GUARD_CLEANUP_FAILED " + JSON.stringify(cleanupFailures)); process.exitCode = process.exitCode ?? 1; }
  app.exit(process.exitCode ?? 0);
}
}
void run();
