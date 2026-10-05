// Actual production Host entry/RPC admission with a deliberately held main browser reply.
// No renderer, real browser action, service execution or recovery authority.
import { app, utilityProcess } from "electron";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTaskDiskRecord, serializeTaskRecord } from "../dist/host/task-store.js";
import { buildHostEnv } from "../dist/host/host-guards.js";
import { HostClient } from "../dist/rpc/host-client.js";
const home = mkdtempSync(join(tmpdir(), "pidock-task-admission-")), profile = join(home, "profile"), root = join(home, "tasks"), taskId = "task-abcdef12", taskDir = join(root, taskId);
mkdirSync(profile); mkdirSync(taskDir, { recursive: true }); app.setPath("userData", profile);
let child, client, exited = false, stage = "startup";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(check, name) { for (let i = 0; i < 300; i++) { if (check()) return; await delay(20); } throw Error(`timeout:${name}`); }
const watchdog = setTimeout(() => { console.error("TASK_ADMISSION_TIMEOUT", stage); child?.kill(); app.exit(1); }, 30000);
async function run() {
try {
  await app.whenReady(); execFileSync("git", ["init", "-q", taskDir]);
  writeFileSync(join(taskDir, "task.json"), serializeTaskRecord(buildTaskDiskRecord({ taskId, name: "Admission", dirId: taskId, branch: "main", root, taskDir, remoteBranch: "main", baseCommit: "fixture", repos: [], now: new Date().toISOString() })));
  child = utilityProcess.fork(join(import.meta.dirname, "..", "dist", "host", "host-entry.js"), [], { env: buildHostEnv(process.env, "task-admission", { taskId, taskDir }, profile), stdio: "pipe", serviceName: "task-admission" });
  child.once("exit", () => { exited = true; }); client = new HostClient(child);
  const op = (name, payload) => client.task({ workspaceId: "task-admission", taskId, op: name, payload, origin: { kind: "shell-ui", senderWebContentsId: 1 } });
  await new Promise((resolve) => child.once("spawn", resolve));
  stage = "ping"; await client.ping();
  stage = "invalid-quit";
  await assert.rejects(op("task/quit", { sessionId: "main", label: "invalid agent quit" }), /permission-denied/);
  await op("task/saveDraft", { sessionId: "main", text: "kept draft" });
  await op("task/sessionStates", {});
  let releaseReply, browserReceived = false, browserCalls = 0;
  client.onBrowserRequest(() => { browserReceived = true; browserCalls++; return new Promise((resolve) => { releaseReply = resolve; }); });
  stage = "held-browser";
  const browser = op("task/browserAction", { action: "page/open", label: "Held main reply", params: { url: "https://example.test" } });
  const browserResult = browser.then(() => ({ ok: true }), (error) => ({ ok: false, error: String(error) })); await wait(() => browserReceived, "browser-request");
  stage = "late-admission";
  let quitSettled = false; const closing = op("task/quit", { label: "Admission probe quit" }); void closing.then(() => { quitSettled = true; }, () => { quitSettled = true; });
  const refused = [
    ["task/saveDraft", { sessionId: "main", text: "late draft" }],
    ["task/setPermission", { sessionId: "main", permission: "auto" }],
    ["task/approve", { sessionId: "main", approvalId: "late-approval" }],
    ["task/browserAction", { action: "page/open", label: "Late browser", params: { url: "https://example.test" } }],
    ["task/scheduleEvaluate", {}], ["task/fileRoots", {}], ["task/sessionStates", {}],
  ];
  for (const [name, payload] of refused) await assert.rejects(op(name, payload), /^Error: task-host-closing$/);
  await assert.rejects(op("task/sdkProjection", { sessionId: "main" }), /sdk-host-closing/);
  await delay(50); assert.equal(quitSettled, false); assert.equal(browserCalls, 1);
  stage = "release-reply";
  releaseReply({ ok: false, error: "browser-unavailable: deliberate main probe refusal" }); const browserRefusal = await browserResult; assert.equal(browserRefusal.ok, false); assert.match(browserRefusal.error, /browser-unavailable/);
  const quit = await closing, repeated = await op("task/quit", { label: "Admission probe quit" });
  assert.equal(quit.payload.quit.plan.failures.length, 0); assert.equal(quit.payload.quit.plan.retainedTasks.length, 0); assert.deepEqual(repeated.payload.quit, quit.payload.quit);
  // Read only fixture persistence after sealing; no task RPC is re-admitted.
  const sessions = JSON.parse(readFileSync(join(taskDir, "sessions", "main.json"), "utf8"));
  assert.ok(JSON.stringify(sessions).includes("kept draft")); assert.ok(!JSON.stringify(sessions).includes("late draft"));
  console.log("TASK_ADMISSION_OK", JSON.stringify({ electron: process.versions.electron, node: process.versions.node, invalidQuitDidNotSeal: true, heldMainReplyDelayedQuit: true, refusedOperations: refused.map(([name]) => name), browserCalls, receiptStable: true, lateDraftExcluded: true }));
} catch (error) { console.error("TASK_ADMISSION_FAILED", stage, String(error).replaceAll(home, "[test-home]").slice(0, 300)); process.exitCode = 1; }
finally {
  clearTimeout(watchdog); client?.dispose(); if (child && !exited) child.kill(); if (child) await wait(() => exited, "cleanup-native-exit").catch(() => undefined);
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); app.exit(process.exitCode ?? 0);
}
}
void run();