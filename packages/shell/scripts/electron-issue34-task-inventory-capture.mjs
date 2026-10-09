// [PiDock 02a/02c] (#34/#36) real-Electron evidence for the Desktop task data
// source. Run after `pnpm --filter @pidock/shell build`:
//   pnpm --filter @pidock/shell exec electron scripts/electron-issue34-task-inventory-capture.mjs --out docs/evidence/desktop-task-inventory
//
// It boots the production main wiring (`createTrustedWindow` + `registerIpc` over a real
// `TaskRootIndex`/`ProjectRegistry`/`PerTaskHostRegistry`) and the built React renderer
// (`dist/renderer/index.html`, no fixture entry, no Vite/dev override), then captures the
// four #34 Desktop states from the real filesystem:
//   (a) empty-root      — the configured default task root holds no task
//   (b) real-task       — a real persisted `task.json` is listed from that root
//   (c) corrupt-record  — a corrupt record is refused; the root fails closed and no row is shown
//   (d) read-failure    — `shell/listTasks` fails: the renderer shows the actionable error,
//                         never a demo fixture
// All four states are the same running renderer; only the filesystem/answer changes between
// them and the window reloads once per state. Nothing else is substituted.
import { app, utilityProcess } from "electron";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { buildTaskDiskRecord, serializeTaskRecord } from "../dist/host/task-store.js";
import { buildHostEnv } from "../dist/host/host-guards.js";
import { TaskRootIndex } from "../dist/main/task-root-index.js";
import { ProjectRegistry } from "../dist/main/project-registry.js";
import { createTrustedWindow, loadTrustedViews, PerTaskHostRegistry, registerIpc } from "../dist/main/runtime.js";
import { HostClient } from "../dist/rpc/host-client.js";
import { shutdownTestRegistry } from "./shutdown-test-registry.mjs";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const outArg = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "docs/evidence/desktop-task-inventory";
const output = isAbsolute(outArg) ? outArg : resolve(repoRoot, outArg);
const command = "pnpm --filter @pidock/shell exec electron scripts/electron-issue34-task-inventory-capture.mjs --out docs/evidence/desktop-task-inventory";
const root = mkdtempSync(join(tmpdir(), "pidock-issue34-capture-"));
const profile = join(root, "profile");
const taskRoot = join(root, "tasks");
mkdirSync(profile);
mkdirSync(taskRoot);
mkdirSync(output, { recursive: true });
app.setPath("userData", profile);
const taskId = "task-abcdef12";
const taskDir = join(taskRoot, taskId);
const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const children = [];
const watchdog = setTimeout(() => { console.error("ISSUE34_CAPTURE_TIMEOUT", root); process.exit(1); }, 90000);
// Test-only guard: a noop listener suppresses Electron's default quit on
// window-all-closed, which would race the explicit app.exit(process.exitCode)
// with a false-pass exit 0.
app.on("window-all-closed", () => {});
let views, registry, index;

function writeRealTask() {
  mkdirSync(taskDir, { recursive: true });
  execFileSync("git", ["init", "-q", taskDir]);
  writeFileSync(join(taskDir, "task.json"), serializeTaskRecord(buildTaskDiskRecord({
    taskId, name: "对账单详情·本地联调", dirId: taskId, branch: "main", root: taskRoot, taskDir,
    remoteBranch: "main", baseCommit: "test", repos: [], now: "2026-09-22T10:00:00.000Z",
  })));
}

async function run() {
  let stage = "startup";
  const shots = [];
  try {
    await app.whenReady();
    index = new TaskRootIndex(profile, taskRoot);
    const projects = new ProjectRegistry(profile);
    // (d) needs a real list-read failure. `TaskRootIndex.inventory()` catches its own
    // scan errors, so the harness wraps the real instance and overrides only that one
    // method; every other call (resolve/importRoot/verifiedIdentity) stays production.
    let listFailure = null;
    const guardedRoots = new Proxy(index, {
      get(target, property, receiver) {
        if (property === "inventory") {
          return () => { if (listFailure) throw new Error(listFailure); return target.inventory(); };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    views = await createTrustedWindow("issue34", "production");
    registry = new PerTaskHostRegistry("issue34", async (workspace, task) => {
      const entry = join(import.meta.dirname, "..", "dist", "host", "host-entry.js");
      const child = utilityProcess.fork(entry, [], { serviceName: "issue34-host", env: buildHostEnv(process.env, workspace, task, app.getPath("userData")), stdio: "pipe" });
      children.push(child);
      child.stderr?.on("data", (data) => process.stderr.write(`[issue34-host] ${data}`));
      return { child, client: new HostClient(child) };
    }, (id) => index.resolve(id), undefined, index);
    registerIpc({}, views.registry, registry, projects, guardedRoots);
    await loadTrustedViews(views);
    views.shellView.webContents.debugger.attach();

    const evalJs = async (expression) => {
      const response = await views.shellView.webContents.debugger.sendCommand("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails));
      return response.result.value;
    };
    const text = async () => { try { return await evalJs("document.body.innerText"); } catch { return ""; } };
    const until = async (match, label) => {
      let last = "";
      for (let i = 0; i < 250; i++) { last = await text(); if (match(last)) return last; await wait(100); }
      throw Error(`UI timeout (${label}): ${JSON.stringify(last.slice(0, 400))}`);
    };
    // (d) drives a genuine failure path, so it is the only state without a stable
    // positive marker; it waits for the read refusals instead of an empty body.
    const reload = async (match, label) => {
      views.shellView.webContents.reload();
      await until(match, label);
    };
    const capture = async (state) => {
      stage = state;
      // A fixed content size keeps the PNG name honest (`<contentW>x<contentH>-<state>`).
      views.window.setContentSize(1440, 900);
      views.window.show();
      views.window.focus();
      await wait(250);
      const size = views.window.getContentBounds();
      if (size.width !== 1440 || size.height !== 900) throw Error(`unexpected content bounds ${JSON.stringify(size)}`);
      const name = `${size.width}x${size.height}-${state}.png`;
      const file = join(output, name);
      const png = (await views.shellView.webContents.capturePage()).toPNG();
      writeFileSync(file, png);
      shots.push({ state, file: name, width: size.width, height: size.height,
        sha256: createHash("sha256").update(png).digest("hex"),
        bodyText: (await text()).replace(/\n+/g, " | ").slice(0, 600) });
    };

    const url = await evalJs("location.href");
    if (!/\/renderer\/index\.html$/.test(url)) throw Error(`not the production renderer: ${url}`);

    // (a) Empty configured root: a real, range-limited empty state, no demo task.
    // Captured first so no Host is forked before the states that mutate the root.
    await until((body) => body.includes("这个项目还没有进行中任务。") && body.includes("项目映射未建立"), "empty root");
    const emptyBody = await text();
    if (/Atlas Web|演示任务|演示统计/.test(emptyBody)) throw Error("demo fixture leaked into the empty Desktop");
    await capture("empty-root");

    // (c) A corrupt record in the configured root is refused: the root fails closed
    // (it does not list its valid neighbour either) and the corrupt identity is never
    // shown in place of a real task.
    writeRealTask();
    mkdirSync(join(taskRoot, "task-99999999"));
    writeFileSync(join(taskRoot, "task-99999999", "task.json"), "{ not json");
    await reload((body) => body.includes("默认任务根：任务根目录不可读取或任务身份冲突，请检查后重试"), "corrupt record");
    const corruptBody = await text();
    if (corruptBody.includes("对账单详情·本地联调") || corruptBody.includes("task-99999999")) throw Error("corrupt record was still listed");
    await capture("corrupt-record");

    // (b) Removing the corrupt record leaves the real persisted task listed by name
    // from the configured root.
    rmSync(join(taskRoot, "task-99999999"), { recursive: true, force: true });
    await reload((body) => body.includes("对账单详情·本地联调") && body.includes("任务根 1/1 就绪"), "real task");
    await capture("real-task");

    // (d) The list read itself fails: the renderer shows the actionable error and a
    // retry, and never falls back to the demo fixture.
    listFailure = "synthetic list read failure for #34 evidence";
    await reload((body) => body.includes("任务记录不可读取，请检查本机任务目录后重试"), "read failure");
    const failureBody = await text();
    if (/Atlas Web|演示任务/.test(failureBody)) throw Error("demo fixture leaked into the read-failure state");
    await capture("read-failure");

    let revision = "unknown"; let trackedFilesDirty = "unknown";
    try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: repoRoot }).trim(); } catch { /* recorded as unknown */ }
    // The capture's own evidence files are untracked, so only tracked-file changes count.
    try { trackedFilesDirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8", cwd: repoRoot }).trim() ? "true" : "false"; } catch { /* recorded as unknown */ }
    const log = { ticket: "#34 [PiDock 02a] Desktop 真实任务列表与空态", command, repoRoot, revision, trackedFilesDirty, generatedBy: "scripts/electron-issue34-task-inventory-capture.mjs", shots };
    writeFileSync(join(output, "capture-log.json"), `${JSON.stringify(log, null, 2)}\n`);
    for (const shot of shots) console.log("ISSUE34_CAPTURE=" + JSON.stringify({ state: shot.state, file: shot.file, sha256: shot.sha256 }));
    console.log("ISSUE34_CAPTURE_LOG=" + JSON.stringify({ revision, trackedFilesDirty, shots: shots.map((shot) => shot.file) }));
  } catch (error) {
    console.error("ISSUE34_CAPTURE_FAILED", stage, error);
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    const cleanupFailures = await shutdownTestRegistry(registry, {
      origin: views ? { kind: "shell-ui", senderWebContentsId: views.shellView.webContents.id } : undefined,
      label: "Issue34 capture cleanup",
    });
    for (const child of children) child.kill();
    if (views?.shellView.webContents.debugger.isAttached()) views.shellView.webContents.debugger.detach();
    views?.window.destroy();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    if (cleanupFailures.length) { console.error("ISSUE34_CAPTURE_CLEANUP_FAILED " + JSON.stringify(cleanupFailures)); process.exitCode = process.exitCode ?? 1; }
    app.exit(process.exitCode ?? 0);
  }
}
void run();
