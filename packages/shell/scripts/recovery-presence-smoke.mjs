// Node parent survives independent Electron main exits; no service execution.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const electron = createRequire(import.meta.url)("electron");
if (process.platform !== "darwin" || process.arch !== "arm64") throw Error("macOS arm64 presence experiment only; not Windows acceptance");
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
function launch(mode, home) {
  return new Promise((resolve, reject) => {
    const child = spawn(electron, [join(import.meta.dirname, "electron-recovery-presence-fixture.mjs"), mode, home], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", failure;
    const deadline = setTimeout(() => { failure = Error(`presence-main-timeout:${mode}`); child.kill("SIGKILL"); }, 20000);
    const capture = (data) => { output += data; if (output.length > 64000) { failure = Error("presence-main-output-limit"); child.kill("SIGKILL"); } };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    child.once("error", (error) => { clearTimeout(deadline); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      try {
        if (failure) throw failure;
        assert.equal(code, 0, output.slice(-2000)); assert.equal(signal, null);
        const markers = output.split("\n").filter((line) => line.startsWith("PRESENCE_FIXTURE_OK="));
        assert.equal(markers.length, 1, output.slice(-2000));
        const report = JSON.parse(markers[0].slice("PRESENCE_FIXTURE_OK=".length)); assert.equal(report.mode, mode);
        assert.equal(report.serviceLaunchAttempts, 0); resolve(report);
      } catch (error) { reject(error); }
    });
  });
}
function snapshot(file) {
  const stat = statSync(file, { bigint: true });
  return { body: readFileSync(file, "utf8"), device: stat.dev.toString(), inode: stat.ino.toString(), mode: (stat.mode & 0o777n).toString(), size: stat.size.toString(), mtime: stat.mtimeNs.toString(), ctime: stat.ctimeNs.toString() };
}
const reports = [];
for (const scenario of ["healthy-reopen", "both-journals-deleted", "recovery-directory-deleted", "recovery-directory-replaced", "witness-deleted", "witness-corrupt"]) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-presence-main-"))), profile = join(home, "profile");
  mkdirSync(profile, { mode: 0o700 }); mkdirSync(join(home, "tasks"));
  try {
    const seed = await launch("seed", home); assert.equal(seed.writerAcquired, true); assert.equal(seed.leaseAcquired, true);
    const directory = join(profile, "service-execution-recovery"), witness = join(profile, "service-execution-recovery.witness.json");
    const file = join(directory, `${createHash("sha256").update("task-abcdef12").digest("hex")}.json`);
    const original = snapshot(witness); assert.equal(original.mode, String(0o600));
    assert.ok(!original.body.includes(home)); assert.ok(!original.body.includes("task-abcdef12"));
    assert.equal(Object.keys(JSON.parse(original.body).tasks).length, 1);
    assert.equal(existsSync(join(directory, "writer.lock")), false);
    let mode = "store-denied", retained = [witness];
    if (scenario === "healthy-reopen") { mode = "read"; retained = [witness, file, `${file}.bak`]; }
    if (scenario === "both-journals-deleted") { unlinkSync(file); unlinkSync(`${file}.bak`); mode = "lease-denied"; }
    if (scenario === "recovery-directory-deleted") rmSync(directory, { recursive: true });
    if (scenario === "recovery-directory-replaced") { renameSync(directory, join(profile, "old-recovery")); mkdirSync(directory, { mode: 0o700 }); }
    if (scenario === "witness-deleted") { unlinkSync(witness); retained = [file, `${file}.bak`]; }
    if (scenario === "witness-corrupt") writeFileSync(witness, "{");
    const before = retained.map(snapshot), result = await launch(mode, home);
    assert.deepEqual(retained.map(snapshot), before);
    assert.equal(result.writerAcquired, mode !== "store-denied"); assert.equal(result.leaseAcquired, mode === "read");
    assert.equal(result.utilitySpawned, mode !== "store-denied");
    if (scenario === "both-journals-deleted") { assert.equal(existsSync(file), false); assert.equal(existsSync(`${file}.bak`), false); }
    if (scenario === "recovery-directory-deleted") assert.equal(existsSync(directory), false);
    if (scenario === "witness-deleted") assert.equal(existsSync(witness), false);
    assert.equal(existsSync(join(directory, "writer.lock")), false);
    reports.push({ scenario, ...result, retainedEvidenceUnchanged: true, serviceExecution: "not-connected" });
  } finally { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
}
console.log("RECOVERY_PRESENCE_OK", JSON.stringify(reports));
