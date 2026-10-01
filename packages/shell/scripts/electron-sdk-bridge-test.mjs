// Real Electron utilityProcess -> main IPC -> sandbox preload integration.
// Invoked as `electron scripts/electron-sdk-bridge-test.mjs` after shell build.
import { app, utilityProcess } from "electron";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTaskDiskRecord, serializeTaskRecord } from "../dist/host/task-store.js";
import { buildHostEnv } from "../dist/host/host-guards.js";
import { TaskRootIndex } from "../dist/main/task-root-index.js";
import { createTrustedWindow, loadTrustedViews, PerTaskHostRegistry, registerIpc } from "../dist/main/runtime.js";
import { HostClient } from "../dist/rpc/host-client.js";

const root = mkdtempSync(join(tmpdir(), "pidock-electron-sdk-"));
const profile = join(root, "profile"), taskRoot = join(root, "tasks"), taskDir = join(taskRoot, "task-abcdef12");
mkdirSync(profile); mkdirSync(taskRoot); mkdirSync(taskDir);
app.setPath("userData", profile);
const taskId = "task-abcdef12", sessionId = "main", workspaceId = "sdk-integration";
const identity = { taskId, sessionId };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const entry = join(import.meta.dirname, "host-sdk-test-entry.mjs");
let views, current, spawned = [];
const watchdog = setTimeout(() => { console.error("ELECTRON_SDK_BRIDGE_TIMEOUT"); process.exit(1); }, 30_000);
async function run() {
try {
  await app.whenReady();
  execFileSync("git", ["init", "-q", taskDir]);
  writeFileSync(join(taskDir, "task.json"), serializeTaskRecord(buildTaskDiskRecord({ taskId, name: "SDK integration", dirId: taskId, branch: "main", root: taskRoot, taskDir, remoteBranch: "main", baseCommit: "test", repos: [], now: new Date().toISOString() })));
  writeFileSync(join(taskDir, "source.txt"), "untouched");
  const index = new TaskRootIndex(profile, taskRoot);
  await index.register(taskDir);
  const makeRegistry = () => new PerTaskHostRegistry(workspaceId, async (ws, task) => {
    const child = utilityProcess.fork(entry, [], { serviceName: "pidock-sdk-test-host", env: buildHostEnv(process.env, ws, task, app.getPath("userData")), stdio: "pipe" });
    spawned.push(child);
    child.stderr?.on("data", (data) => process.stderr.write(`[sdk-test-host] ${data}`));
    return { child, client: new HostClient(child) };
  }, (id) => index.resolve(id), undefined, index);
  current = makeRegistry();
  views = await createTrustedWindow(workspaceId, "production");
  registerIpc({} , views.registry, {
    routeTaskOp: (...args) => current.routeTaskOp(...args),
    entryForTaskId: (...args) => current.entryForTaskId(...args),
  });
  await loadTrustedViews(views);
  views.shellView.webContents.debugger.attach();
  const evaluate = async (expression) => {
    const response = await views.shellView.webContents.debugger.sendCommand("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  const request = (action, rest = {}) => evaluate(`window.pidock.sdkTurn(${JSON.stringify({ action, ...identity, ...rest })}).then(JSON.stringify)`).then(JSON.parse);
  const assert = (condition, label, value) => { if (!condition) throw Error(`${label}: ${JSON.stringify(value)}`); };
  await evaluate("window.__sdkEvents = []; window.__unsubscribeSdk = window.pidock.onSdkTurnEvent(event => window.__sdkEvents.push(event))");
  const subscribed = await request("subscribe");
  assert(subscribed.ok && subscribed.payload.snapshot.source === "sdk-jsonl", "subscribe", subscribed);
  const start = await request("start", { requestId: "first", text: "hello" });
  assert(start.ok && start.payload.turn.state === "accepted", "start", start);
  let status;
  for (let i = 0; i < 100; i++) {
    status = await request("status", { requestId: "first" });
    if (status.payload?.turn?.state === "done") break;
    await wait(30);
  }
  assert(status.payload?.turn?.state === "done", "done", status);
  const events = await evaluate("window.__sdkEvents");
  const types = events.filter((event) => event.kind === "sdk-turn-event").map((event) => event.event.type);
  assert(types.join(",") === "delta,message_end,agent_settled", "ordered events", events);
  assert(events.find((event) => event.event?.type === "message_end")?.event.usage.input === 4, "usage", events);
  const snapshot = await request("projection");
  assert(snapshot.payload?.messages?.at(-1)?.text === "local reply" && snapshot.payload?.messages?.at(-1)?.usage?.output === 2, "SDK JSONL", snapshot);
  const pending = await request("start", { requestId: "second", text: "wait" });
  assert(pending.ok && pending.payload.turn.state === "accepted", "pending", pending);
  const active = await request("projection");
  assert(active.payload?.pending === true && active.payload?.interrupted === false, "live projection", active);
  const cancelled = await request("cancel", { turnId: pending.payload.turn.turnId });
  assert(cancelled.payload?.turn?.state === "cancelled", "cancel", cancelled);
  await request("unsubscribe");
  current.disposeAll();
  current = makeRegistry();
  const resumed = await request("subscribe");
  assert(resumed.ok && resumed.payload.snapshot.messages.some((message) => message.text === "local reply"), "cold reopen", resumed);
  const restored = await request("status", { requestId: "first" });
  assert(restored.payload?.turn?.state === "done" && restored.payload.turn.turnId === start.payload.turn.turnId, "durable status", restored);
  const cancelledAfterRestart = await request("status", { requestId: "second" });
  assert(cancelledAfterRestart.payload?.turn?.state === "cancelled", "durable cancel", cancelledAfterRestart);
  const quit = JSON.parse(await evaluate(`window.pidock.taskOp(${JSON.stringify(taskId)}, "task/quit", {label:"SDK test quit"}).then(JSON.stringify)`));
  assert(quit.ok, "quit", quit);
  const afterQuit = await request("start", { requestId: "afterquit", text: "must refuse" });
  assert(!afterQuit.ok && afterQuit.error.includes("sdk-host-closing"), "post-quit start", afterQuit);
  assert(readFileSync(join(taskDir, "source.txt"), "utf8") === "untouched", "source untouched");
  console.log("ELECTRON_SDK_BRIDGE_RESULT=" + JSON.stringify({ subscribed: true, types, usage: snapshot.payload.messages.at(-1).usage, cancel: cancelled.payload.turn.state, cold: restored.payload.turn.state, postQuit: afterQuit.error, sandbox: await evaluate("window.pidock.getSecurityState()") }));
} catch (error) {
  console.error("ELECTRON_SDK_BRIDGE_FAILED", error);
  process.exitCode = 1;
} finally {
  current?.disposeAll();
  clearTimeout(watchdog);
  for (const child of spawned) child.kill();
  views?.shellView.webContents.debugger.detach();
  views?.window.destroy();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  app.exit(process.exitCode ?? 0);
}
}
void run();
