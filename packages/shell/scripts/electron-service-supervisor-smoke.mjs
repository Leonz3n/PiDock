// Isolated macOS experiment, not production Host/RPC or Windows acceptance.
// After shell build and build:supervisor:mac:
// pnpm --filter @pidock/shell exec electron scripts/electron-service-supervisor-smoke.mjs
import { app, utilityProcess } from "electron";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskRootIndex } from "../dist/main/task-root-index.js";
import { ProjectRegistry } from "../dist/main/project-registry.js";
import { ServiceCatalog, serviceCatalogAuthority } from "../dist/main/service-catalog.js";
import { inspectDevelopmentSupervisor } from "../dist/main/service-supervisor-artifact.js";
import { prepareServiceSupervisorExperiment } from "../dist/main/service-supervisor-preparation.js";

if (process.platform !== "darwin" || process.arch !== "arm64") throw Error("experiment requires macOS arm64; no Windows acceptance");
const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-utility-supervisor-")));
const profile = join(home, "profile"), root = join(home, "tasks"), taskId = "task-abcdef12", taskDir = join(root, taskId);
mkdirSync(profile); mkdirSync(join(taskDir, "repo-a"), { recursive: true });
app.setPath("userData", profile);
const secret = "synthetic-utility-supervisor-value-0123456789";
const children = [];
const tracked = new Set();
const reports = [];
let stage = "startup";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
async function gone(pids) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (pids.every((pid) => !alive(pid))) return;
    await delay(20);
  }
  throw Error("experiment process termination not confirmed");
}
const watchdog = setTimeout(() => {
  for (const child of children) child.kill();
  // Emergency test-only cleanup of this run's exact, observed live resources.
  for (const pid of tracked) { try { process.kill(pid, "SIGKILL"); } catch { /* Test process may have already exited. */ } }
  console.error("SUPERVISOR_UTILITY_TIMEOUT"); app.exit(1);
}, 45000);

async function run() {
  try {
    await app.whenReady();
    const artifact = inspectDevelopmentSupervisor(join(import.meta.dirname, "..", "build", "service-supervisor", "darwin-arm64"));
    assert.equal(artifact.state, "available-for-experiment");
    writeFileSync(join(taskDir, "task.json"), JSON.stringify({ taskId, name: "Supervisor", dirId: taskId, root, taskDir,
      branch: "task/main", remoteBranch: "main", baseCommit: "test", repos: ["repo-a"],
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }));
    const roots = new TaskRootIndex(profile, root), projects = new ProjectRegistry(profile);
    const project = await projects.create({ name: "Supervisor experiment", description: "", repositories: [], directories: [] });
    await projects.claim(taskId, project.id, roots);
    const catalog = new ServiceCatalog(profile, serviceCatalogAuthority(roots, projects));
    const fixture = join(home, "service-fixture");
    execFileSync("go", ["build", "-trimpath", "-o", fixture, "./testdata/fixture"],
      { cwd: join(import.meta.dirname, "..", "native", "service-supervisor"), timeout: 30000, stdio: "pipe" });
    const modes = ["stop", "disconnect", "host-exit", "host-kill", "supervisor-kill", "parent-exit"];
    for (const mode of modes) {
      stage = `${mode}:template`;
      const args = mode === "parent-exit" ? ["host-parent", "exit"] : ["host-parent"];
      const template = catalog.saveTemplate({ projectId: project.id, descriptor: {
        name: mode, program: "service-fixture", args, ports: [], runType: "long-lived",
      }, shared: [] });
      catalog.bindTask({ taskId, serviceId: template.serviceId, templateVersion: 1, rootId: "repo-a", subdir: "",
        programPath: fixture, privateRefs: [{ key: "FIXTURE_VALUE", envRef: "LOCAL_FIXTURE_VALUE" }] });
      stage = `${mode}:prepare`;
      const prepared = prepareServiceSupervisorExperiment(catalog, { projectId: project.id, taskId, serviceId: template.serviceId },
        { LOCAL_FIXTURE_VALUE: secret }, artifact.artifact);
      const child = utilityProcess.fork(join(import.meta.dirname, "service-supervisor-utility-fixture.mjs"), [],
        { serviceName: "pidock-supervisor-experiment", env: {}, stdio: "pipe" });
      children.push(child);
      const messages = [];
      let output = "", exited = false;
      child.stdout?.on("data", (data) => { output += data; });
      child.stderr?.on("data", (data) => { output += data; });
      child.on("message", (message) => {
        messages.push(message);
        if (message.event === "started") { tracked.add(message.pid); tracked.add(message.supervisorPid); }
        if (message.event === "log" && /^descendant:[0-9]+$/.test(message.line)) tracked.add(Number(message.line.split(":")[1]));
      });
      child.once("exit", () => { exited = true; });
      const waitFor = async (predicate) => {
        for (let attempt = 0; attempt < 200; attempt++) {
          const match = messages.find(predicate);
          if (match) return match;
          if (messages.some((message) => message.event === "failed") || exited) throw Error("utility experiment failed before receipt");
          await delay(20);
        }
        throw Error("utility experiment receipt timeout");
      };
      stage = `${mode}:boot`;
      const boot = await waitFor((message) => message.event === "boot");
      assert.match(boot.versions.electron, /^44\./); assert.match(boot.versions.node, /^24\./);
      stage = `${mode}:launch`;
      prepared.use((binary, request) => child.postMessage({ op: "launch", binary, request }));
      const started = await waitFor((message) => message.event === "started");
      const descendantLine = await waitFor((message) => message.event === "log" && /^descendant:[0-9]+$/.test(message.line));
      const descendant = Number(descendantLine.line.split(":")[1]);
      const pids = [started.pid, started.supervisorPid, descendant];
      assert.equal(JSON.stringify(messages).includes(secret), false);
      assert(messages.some((message) => message.event === "log" && message.line === "[redacted]"));
      stage = `${mode}:termination`;
      if (mode === "host-kill") {
        assert(Number.isSafeInteger(child.pid) && child.pid > 0);
        process.kill(child.pid, "SIGKILL");
      }
      else if (mode === "host-exit") child.postMessage({ op: "exit" });
      else if (mode === "supervisor-kill") process.kill(started.supervisorPid, "SIGKILL");
      else if (mode !== "parent-exit") child.postMessage({ op: mode });
      let terminal = null;
      if (mode !== "host-kill" && mode !== "host-exit") {
        terminal = (await waitFor((message) => message.event === "completed")).result;
        assert.deepEqual(terminal, mode === "parent-exit" ? { event: "exit", code: 3 }
          : mode === "supervisor-kill" ? { event: "unconfirmed" } : { event: "stopped" });
      }
      stage = `${mode}:gone`;
      await gone(pids);
      for (const pid of pids) tracked.delete(pid);
      assert.equal(output.includes(secret), false);
      assert.equal(readFileSync(join(profile, "service-machine.json"), "utf8").includes(secret), false);
      if (!exited) child.kill();
      for (let attempt = 0; !exited && attempt < 100; attempt++) await delay(20);
      assert.equal(exited, true);
      reports.push({ mode, versions: boot.versions, terminal, observedResourcesGone: true, utilityExited: true, privateValueVisible: false });
    }
    console.log("SUPERVISOR_UTILITY_SMOKE_OK", JSON.stringify(reports));
  } catch (error) {
    console.error("SUPERVISOR_UTILITY_SMOKE_FAILED", stage, String(error).replaceAll(secret, "[redacted]").slice(0, 500)); process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    for (const child of children) child.kill();
    for (const pid of tracked) { try { process.kill(pid, "SIGKILL"); } catch { /* Test process may have already exited. */ } }
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    app.exit(process.exitCode ?? 0);
  }
}
void run();
