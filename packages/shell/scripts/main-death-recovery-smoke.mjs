// Node harness survives SIGKILL of a separate actual Electron main.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const electron = createRequire(import.meta.url)("electron");
if (process.platform !== "darwin" || process.arch !== "arm64") throw Error("macOS arm64 experiment only; not Windows acceptance");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), reports = [];
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
function launch(mode, home) {
  const child = spawn(electron, [join(import.meta.dirname, "electron-main-death-fixture.mjs"), mode, home], { env, stdio: ["ignore", "pipe", "pipe"] });
  const h = { child, events: [], output: "", exited: false, code: null, signal: null };
  let pending = "";
  child.stdout.on("data", (data) => {
    h.output += data; pending += data;
    if (h.output.length > 100000) { child.kill("SIGKILL"); return; }
    const lines = pending.split("\n"); pending = lines.pop();
    for (const line of lines) if (line.startsWith("MAIN_DEATH_FIXTURE=")) h.events.push(JSON.parse(line.slice("MAIN_DEATH_FIXTURE=".length)));
  });
  child.stderr.on("data", (data) => { h.output += data; });
  child.once("exit", (code, signal) => { h.exited = true; h.code = code; h.signal = signal; });
  child.once("error", (error) => { h.error = error; });
  return h;
}
async function wait(predicate, label, timeout = 40000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await delay(20); }
  throw Error(`main-death-timeout:${label}`);
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } }
function snapshot(file) { const stat = statSync(file, { bigint: true }); return { body: readFileSync(file, "utf8"), device: stat.dev.toString(), inode: stat.ino.toString(), mode: (stat.mode & 0o777n).toString(), size: stat.size.toString(), mtime: stat.mtimeNs.toString(), ctime: stat.ctimeNs.toString() }; }
for (const mode of ["running", "held-report"]) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-main-death-"))), tracked = [], runs = [];
  mkdirSync(join(home, "profile"), { mode: 0o700 }); mkdirSync(join(home, "tasks"));
  try {
    const first = launch(mode, home); runs.push(first);
    const barrier = await wait(() => { if (first.error || first.exited || first.events.some((row) => row.event === "failed")) throw Error(`fixture-before-barrier:${first.output.slice(-1000)}`); return first.events.find((row) => row.event === "kill-barrier"); }, "barrier");
    assert.equal(barrier.mainPid, first.child.pid); assert.equal(barrier.mode, mode); assert.equal(barrier.releaseConfirmed, false);
    tracked.push(barrier.hostPid, ...barrier.resourcePids); assert.equal(new Set(tracked).size, 4); assert.ok(tracked.every((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid));
    const directory = join(home, "profile", "service-execution-recovery"), primary = join(directory, `${createHash("sha256").update("task-abcdef12").digest("hex")}.json`), lock = join(directory, "writer.lock");
    const files = [lock, primary, `${primary}.bak`], before = files.map(snapshot), document = JSON.parse(before[1].body);
    assert.equal(document.entries.length, 1); assert.equal(document.entries[0].state, mode === "running" ? "running" : "stopped");
    if (mode === "held-report") assert.equal(document.shutdown.hostEpoch, barrier.epoch); else assert.equal(document.shutdown, undefined);
    // A live competing Electron main must not steal the writer either.
    const contender = launch("restart", home); runs.push(contender);
    await wait(() => contender.exited, "live-contender"); assert.equal(contender.code, 0); assert.ok(contender.events.some((row) => row.event === "restart-denied")); assert.ok(!first.exited);
    assert.deepEqual(files.map(snapshot), before);
    first.child.kill("SIGKILL"); await wait(() => first.exited, "actual-main-SIGKILL"); assert.equal(first.signal, "SIGKILL");
    const restart = launch("restart", home); runs.push(restart);
    await wait(() => restart.exited, "restart-denied"); assert.equal(restart.code, 0);
    const denied = restart.events.find((row) => row.event === "restart-denied"); assert.ok(denied); assert.equal(denied.writerAcquired, false); assert.equal(denied.utilitySpawned, false);
    assert.deepEqual(files.map(snapshot), before);
    // Process observation is evidence only. Do not authorize recovery from these PIDs.
    await delay(500); const survivors = tracked.filter(alive);
    for (const value of ["synthetic-main-death-private", "synthetic-shutdown-credential"]) { assert.ok(!runs.some((h) => h.output.includes(value))); assert.ok(!before.some((row) => row.body.includes(value))); }
    assert.ok(!before.some((row) => row.body.includes(home)));
    reports.push({ mode, versions: barrier.versions, mainSignal: first.signal, liveContenderDenied: true, restartDenied: true, writerAndJournalUnchanged: true, oldReportAdopted: false, nativeObservationAfterRestart: { hostAlive: survivors.includes(barrier.hostPid), resourceSurvivors: barrier.resourcePids.filter((pid) => survivors.includes(pid)).length, survivorCount: survivors.length, total: tracked.length }, privateValuesExcluded: true });
  } catch (error) {
    console.error("MAIN_DEATH_DEBUG", JSON.stringify(runs.map((h) => ({ exited: h.exited, code: h.code, signal: h.signal, output: h.output.slice(-2000) }))));
    throw error;
  } finally {
    for (const h of runs) if (!h.exited) h.child.kill("SIGKILL");
    const observed = new Set([...tracked, ...runs.flatMap((h) => h.events.filter((event) => event.event === "observed-test-pids").flatMap((event) => event.pids))]);
    for (const pid of observed) {
      assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
      try { process.kill(pid, "SIGKILL"); } catch { /* Exact fixture PID cleanup only, not recovery authorization. */ }
    }
    await Promise.all(runs.map((h) => wait(() => h.exited, "test-main-cleanup", 5000)));
    await wait(() => [...observed].every((pid) => !alive(pid)), "test-descendant-cleanup", 5000);
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}
console.log("MAIN_DEATH_RECOVERY_OK", JSON.stringify(reports));
