import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { NodePtyDriver } from "../../dist/host/node-pty-driver.js";
import { inspectNodePtyPrebuild } from "../../dist/host/node-pty-preflight.js";

const evidencePath = process.argv[2];
assert(evidencePath && isAbsolute(evidencePath));
const preflight = inspectNodePtyPrebuild();
assert.equal(preflight.ready, false, "run this explicit negative fixture before manual preparation");
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pidock-pty-negative-")));
const identity = { taskId: "task-preflight", sessionId: "main", instanceId: "term-1", generation: 1 };
const output = [], observed = [];
const driver = new NodePtyDriver({ workspaceId: "negative-preflight", nodeExecutable: realpathSync(process.execPath),
  onOutput: (...event) => output.push(event) });
const report = { startedAt: new Date().toISOString(), preflight, identity, cwd, ok: false };
try {
  assert.deepEqual(await driver.spawn(identity, { program: realpathSync(process.execPath),
    args: [fileURLToPath(new URL("./node-pty-fixture.mjs", import.meta.url)), join(cwd, "unused-marker.json")],
    cwd, env: { FIXTURE_VALUE: "native-adapter" }, envRevision: "negative-1", cols: 80, rows: 24 }, (receipt) => observed.push(receipt)), { status: "not-started" });
  const until = performance.now() + 3000;
  while (!driver.snapshot(identity).workerExit) { assert(performance.now() < until, "negative helper exit deadline"); await delay(20); }
  report.resources = driver.snapshot(identity);
  assert.equal(report.resources.phase, "preflight"); assert.equal(report.resources.reason, "preflight-unavailable");
  assert.equal(report.resources.rootPid, undefined); assert.equal(report.resources.ptyExit, undefined);
  assert.deepEqual(report.resources.workerExit, { code: 0, signal: null });
  assert.deepEqual(await driver.stop(identity), { ...identity, status: "not-started" });
  assert.deepEqual(output, []); assert.deepEqual(observed, []);
  report.ok = true;
} catch (error) { report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  report.finishedAt = new Date().toISOString(); report.resources = driver.snapshot(identity);
  writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}
