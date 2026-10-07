import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { NodePtyDriver } from "../../dist/host/node-pty-driver.js";
import { TerminalExecution } from "../../dist/host/terminal-execution.js";
import { PiSessionChannel } from "../../dist/main/pi-session.js";
import { TaskWriteCoordinator } from "../../dist/host/write-coordination.js";
import { SharedPathCoordinator } from "../../dist/host/path-coordination.js";
import { fixtureDisposition, observeFixtureDisposition } from "./node-pty-disposition.mjs";

// Run explicitly after compiling shell source. This is Node/native synthetic
// evidence, never Electron utilityProcess/installed/Windows acceptance.
const evidencePath = process.argv[2];
assert(evidencePath && isAbsolute(evidencePath), "explicit external evidence path required");
assert.equal(process.platform, "darwin"); assert.equal(process.arch, "arm64");
assert.equal(process.versions.node, "24.21.0"); assert.equal(process.versions.electron, undefined);
assert.equal(typeof process.getuid, "function", "explicit Darwin metadata requires existing Node getuid");
const controlledCfMetadata = `0x${process.getuid().toString(16)}:0:0`;
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pidock-node-pty-")));
const marker = join(cwd, "descendant.json");
const launch = { program: realpathSync(process.execPath), args: [fileURLToPath(new URL("./node-pty-fixture.mjs", import.meta.url)), marker],
  cwd, env: { FIXTURE_VALUE: "native-adapter", __CF_USER_TEXT_ENCODING: controlledCfMetadata }, envRevision: "native-fixture-explicit-metadata-2", cols: 80, rows: 24 };
const receipts = [], output = [], checks = [];
const report = { startedAt: new Date().toISOString(), runtime: process.versions, cwd,
  launch: { ...launch, env: { FIXTURE_VALUE: "synthetic-fixture-only", __CF_USER_TEXT_ENCODING: "explicit-controlled-metadata-redacted" } },
  controlledCfMetadataProvided: true, checks,
  harness: { pid: process.pid, program: process.execPath, cwd: process.cwd(), startedAt: new Date().toISOString() },
  evidenceClass: "Darwin arm64 Node24 real node-pty1.1.0 synthetic OS programs", treeDrained: false, ok: false };
const write = new TaskWriteCoordinator(), shared = new SharedPathCoordinator();
let released = false;
let identity = { taskId: "task-aaaaaaaa", sessionId: "main", instanceId: "term-1", generation: 1 };
const driver = new NodePtyDriver({ workspaceId: "fixture-workspace", nodeExecutable: launch.program, onOutput: (owner, sequence, data) => {
  assert(owner.taskId === "task-aaaaaaaa" && owner.sessionId === "main" && owner.instanceId === "term-1" && owner.generation === 1);
  assert.equal(sequence, output.length + 1); assert(Buffer.byteLength(data) <= 4096);
  assert(output.reduce((sum, row) => sum + Buffer.byteLength(row.data), 0) + Buffer.byteLength(data) < 32_768);
  output.push({ owner, sequence, data });
} });
const channel = new PiSessionChannel({ taskId: "task-aaaaaaaa", taskDir: cwd, sessionId: "main", providerId: "local", model: "fixture", permission: "auto" });
const execution = new TerminalExecution({ taskId: "task-aaaaaaaa", taskDir: cwd, instanceId: "term-1", driver, write,
  resolveLaunch: () => launch, authorizeAutomation: () => true,
  acquireLease: (review) => {
    const claim = shared.claim({ taskId: review.taskId, sessionId: review.sessionId, paths: [cwd], label: "native PTY fixture lifetime" });
    assert.equal(claim.ok, true);
    return { revalidate: () => assert.equal(shared.holderOf(cwd)?.taskId, review.taskId),
      release: () => { released = true; shared.release({ taskId: review.taskId, sessionId: review.sessionId }); } };
  },
  persistReceipt: async (receipt) => { receipts.push(receipt); },
});
const control = (request) => execution.control({ channel, sessionId: "main", request, persistApproval: async () => {} });
const text = () => output.map((row) => row.data).join("");
async function until(predicate, timeout, name) {
  const end = Math.min(performance.now() + timeout, deadlineAt);
  while (!predicate()) { if (deadlineExceeded || performance.now() >= end) throw Error(`fixture-deadline:${name}`); await delay(20); }
}
function descendant() { try { return JSON.parse(readFileSync(marker, "utf8")); } catch { return undefined; } }
console.log(JSON.stringify({ stage: "harness-start", harness: report.harness, fixtureCwd: cwd }));
const deadlineAt = performance.now() + 30_000;
let deadlineExceeded = false, primaryFailure;
const observation = { snapshot: () => driver.snapshot(identity), descendant,
  descendantPid: () => { const value = text().match(/DESCENDANT:([1-9][0-9]*)[\r\n]/)?.[1]; return value ? Number(value) : undefined; }, deadlineAt };
function snapshotReport(stage) {
  report.finishedAt = new Date().toISOString(); report.output = output;
  report.driver = driver.snapshot(identity); report.controller = execution.snapshot();
  report.persistedReceipts = receipts; report.leaseReleased = released; report.taskWriteOwner = write.owner;
  report.descendantLatest = descendant();
  report.finalDisposition = { ...fixtureDisposition(observation), deadlineExceeded: deadlineExceeded || performance.now() >= deadlineAt,
    stage, controller: execution.snapshot(), taskWriteOwner: write.owner, leaseReleased: released };
  report.ok = report.ok && !primaryFailure && !report.finalDisposition.deadlineExceeded;
}
function recordFailure(error) {
  process.exitCode = 1;
  if (primaryFailure) return;
  primaryFailure = { message: error instanceof Error ? error.message : String(error), at: new Date().toISOString() };
  report.error = primaryFailure.message; report.primaryFailure = primaryFailure; report.ok = false;
  snapshotReport("initial-failure");
  writeFileSync(`${evidencePath}.initial-failure.json`, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
}
function saveDisposition(stage) {
  snapshotReport(stage);
  writeFileSync(`${evidencePath}.final-disposition.json`, `${JSON.stringify(report.finalDisposition, null, 2)}\n`);
  writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
}
const deadline = setTimeout(() => {
  deadlineExceeded = true; recordFailure("fixture-overall-deadline"); saveDisposition("deadline-unknown");
  console.error(JSON.stringify({ stage: "deadline-unknown", resources: report.driver, harness: report.harness }));
  // The unknown live IPC owner stays addressable; late facts cannot clear timeout.
}, 30_000);
// Sync reporting here creates no new handles. Late real exits may add facts to
// the final disposition while the immutable failure and timeout remain failed.
process.once("beforeExit", () => saveDisposition("before-natural-exit"));
try {
  assert.deepEqual(await control({ action: "start" }), { ok: true });
  assert.equal(execution.snapshot().state, "running");
  identity = execution.snapshot().identity;
  report.spawn = driver.snapshot(identity);
  console.log(JSON.stringify({ stage: "spawn-ack", resources: report.spawn, identity }));
  await until(() => text().includes("READY:"), 3000, "ready");
  const ready = JSON.parse(text().match(/READY:([^\r\n]+)/)[1]);
  assert.equal(ready.cwd, cwd); assert.equal(ready.value, "native-adapter"); assert.equal(ready.cols, 80); assert.equal(ready.rows, 24);
  assert.deepEqual(ready.envKeys, ["FIXTURE_VALUE", "PWD", "TERM", "__CF_USER_TEXT_ENCODING"]);
  assert.equal(ready.cfMetadataMatches, true, "controlled metadata changed");
  assert.equal(ready.pwd, cwd); assert.equal(ready.term, "xterm-256color");
  report.root = ready; checks.push("real PTY/cwd/exact explicit environment/80x24/root identity");
  assert.deepEqual(await control({ action: "input", data: "ping\r" }), { ok: true });
  await until(() => text().includes("PONG:real-pty-input"), 3000, "input"); checks.push("real application-observed input/output");
  assert.deepEqual(await control({ action: "resize", cols: 100, rows: 40 }), { ok: true });
  await until(() => text().includes("SIZE:100x40"), 3000, "resize"); checks.push("real TTY observed resize100x40");
  assert.equal(write.owner, "main");
  assert.equal(shared.claim({ taskId: "task-bbbbbbbb", sessionId: "other", paths: [cwd], label: "competing edit" }).ok, false);
  assert.deepEqual(await control({ action: "input", data: "descendant\r" }), { ok: true });
  await until(() => driver.snapshot(identity).ptyExit !== undefined, 3000, "root-exit");
  assert.equal(driver.snapshot(identity).ptyExit.exitCode, 7);
  const before = descendant(); assert(before && !before.exited);
  await until(() => descendant()?.heartbeat > before.heartbeat, 3000, "descendant-outlives-root");
  report.descendantAfterRootExit = descendant(); checks.push("finite detached descendant heartbeat advances after known root exit7");
  await until(() => driver.snapshot(identity).workerExit !== undefined, 3000, "helper-exit");
  assert.equal(driver.snapshot(identity).workerExit.code, 0);
  assert.deepEqual(await execution.close(), { ok: false, error: "terminal-termination-unconfirmed" });
  assert.equal(execution.snapshot().state, "unconfirmed"); assert.equal(write.owner, "main"); assert.equal(released, false); assert.deepEqual(receipts, []);
  checks.push("PTY/root/helper exit retain controller task/shared rights and persist no tree receipt");
  await until(() => descendant()?.exited, 17_000, "finite-descendant-completion");
  report.descendantCompletion = descendant();
  assert.equal(write.owner, "main"); assert.equal(released, false);
  assert.equal(shared.holderOf(cwd)?.taskId, "task-aaaaaaaa");
  assert.deepEqual(await driver.stop(identity), { ...identity, status: "unknown" });
  checks.push("fixture descendant self-completes; adapter still unknown and rights retained");
  report.ok = true;
} catch (error) {
  recordFailure(error);
} finally {
  const disposition = await observeFixtureDisposition(observation);
  if (disposition.deadlineExceeded) {
    deadlineExceeded = true; recordFailure("fixture-disposition-deadline");
  }
  // Clear only after all known finite observations complete or the bound expires.
  clearTimeout(deadline);
  saveDisposition("finite-observation-finished");
  console.log(JSON.stringify({ ok: report.ok, checks, cwd, rootPid: report.driver?.rootPid, workerPid: report.driver?.workerPid,
    descendantPid: report.descendantLatest?.pid, ptyExit: report.driver?.ptyExit, workerExit: report.driver?.workerExit,
    descendantFixtureCompleted: report.descendantLatest?.exited, retainedTaskWriteOwner: write.owner,
    missingReceipts: report.finalDisposition.missingReceipts, deadlineExceeded: report.finalDisposition.deadlineExceeded, evidencePath }));
}
