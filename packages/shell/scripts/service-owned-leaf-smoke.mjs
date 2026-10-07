import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExperimentalServiceExecution } from "../dist/host/service-execution-experiment.js";
import { ReviewedServiceLeafDriver, SERVICE_LEAF_SOURCE_SHA256 } from "../dist/host/service-owned-driver.js";
import { PiSessionChannel } from "../dist/main/pi-session.js";
import { TaskWriteCoordinator } from "../dist/host/write-coordination.js";

// Manual single-spawn fixture. Retain evidence and unknown resources; no teardown, restart or retry.
const evidence = realpathSync(process.argv[2]);
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const source = realpathSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/service-owned-leaf.mjs"));
const program = realpathSync(process.execPath);
assert.equal(process.platform, "darwin"); assert.equal(process.versions.node, "24.21.0");
assert.equal(hash(program), "e4b5a3af0e05c75de2eae013904145f40fe7fc2a6e6f17510128bf45cca4e79b"); assert.equal(hash(source), SERVICE_LEAF_SOURCE_SHA256);
const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-service-owner-")));
const taskId = "task-service-owner", serviceId = "s-11111111-1111-4111-8111-111111111111", taskDir = join(home, taskId), cwd = join(taskDir, "worktree");
mkdirSync(cwd, { recursive: true, mode: 0o700 });
const launch = { capability: "reviewed-no-child-fixture", program, args: [source], cwd, env: { FIXTURE_VALUE: "synthetic-service-value" }, envRevision: "fixed-env-v1", programSha256: hash(program), sourceSha256: hash(source) };
const driver = new ReviewedServiceLeafDriver(launch), write = new TaskWriteCoordinator();
let released = false, saved, acknowledge;
const order = [], checkpoints = [], file = join(home, "checkpoint.json");
const directoryIdentity = (path) => { const stat = statSync(path, { bigint: true }); return { device: String(stat.dev), inode: String(stat.ino) }; };
const taskIdentity = directoryIdentity(taskDir), cwdIdentity = directoryIdentity(cwd);
const lease = { revalidate() { assert.deepEqual(directoryIdentity(taskDir), taskIdentity); assert.deepEqual(directoryIdentity(cwd), cwdIdentity); assert.equal(released, false); }, release() { released = true; order.push("shared-lease-released"); } };
const channel = new PiSessionChannel({ taskId, taskDir, sessionId: "main", permission: "default", providerId: "local", model: "fixture" });
const execution = new ExperimentalServiceExecution({ taskId, taskDir, serviceId, revision: () => "fixed-v1", write,
  recovery: { read: () => saved, write(record) {
    const pending = `${file}.pending`; writeFileSync(pending, JSON.stringify(record), { mode: 0o600, flush: true }); renameSync(pending, file);
    const fd = openSync(home, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    saved = JSON.parse(readFileSync(file, "utf8")); assert.deepEqual(saved, record); checkpoints.push(saved); order.push(`durable-${record.state}`);
    if (record.state === "unconfirmed") return new Promise((resolve) => { acknowledge = () => { order.push("ownership-fence-ack-delivered"); resolve(undefined); }; });
    return undefined;
  } },
  managed: { workspaceId: "service-owner-fixture", resolveLaunch: () => launch, acquireLease: () => lease,
    start: async (identity, request) => { order.push("dispatch"); return driver.start(identity, request); } } });
const control = (approvalId) => execution.control({ channel, sessionId: "main", action: "start", approvalId, persist: () => { order.push("approval-persisted"); } });
const plan = { count: 1, platform: process.platform, node: process.versions.node, workspaceId: "service-owner-fixture", taskId, sessionId: "main", serviceId, configRevision: "fixed-v1", launch: { ...launch, env: { FIXTURE_VALUE: "synthetic-service-value" } }, taskIdentity, cwdIdentity, home };
// Persist exact count and inputs before any leaf spawn.
writeFileSync(join(evidence, "native-prelaunch.json"), JSON.stringify(plan, null, 2), { mode: 0o600, flush: true });
try {
  const ask = await control(); assert.equal(ask.ok, false); assert.match(ask.error, /^approval-required:/); assert.equal(driver.observation().pid, null);
  const approvalId = ask.error.split(":")[1]; channel.approve(approvalId);
  assert.deepEqual(await control(approvalId), { ok: true, state: "running" }); order.push("control-accepted");
  assert.equal(write.owner, "main"); assert.equal(released, false);
  // Driver bounds the OS wait to 10s. A failed run never launches a second fixture.
  const until = Date.now() + 10_500;
  while (!acknowledge && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(typeof acknowledge, "function"); assert.deepEqual(driver.observation().close, { code: 0, signal: null });
  assert.equal(driver.observation().fixtureMatched, true); assert.equal(write.owner, "main"); assert.equal(released, false); order.push("native-close-ack-held-rights-retained");
  acknowledge();
  await execution.close(); assert.equal(execution.snapshot().state, "exited"); assert.equal(write.owner, null); assert.equal(released, true); assert.deepEqual(execution.resources(), []);
  const result = { ok: true, plan, observation: driver.observation(), order, checkpoints, final: execution.snapshot(), write: write.snapshot(), evidenceKind: "Darwin Node fixed no-child fixture with filesystem checkpoint; no utilityProcess/installed/catalog epoch/report evidence" };
  writeFileSync(join(evidence, "native-result.json"), JSON.stringify(result, null, 2), { mode: 0o600, flush: true }); console.log("SERVICE_OWNED_LEAF_OK");
} catch (error) {
  writeFileSync(join(evidence, "native-result.json"), JSON.stringify({ ok: false, observation: driver.observation(), order, checkpoints, final: execution.snapshot(), write: write.snapshot(), home, failure: error instanceof Error ? error.message : "unknown" }, null, 2), { mode: 0o600, flush: true });
  throw error;
}
