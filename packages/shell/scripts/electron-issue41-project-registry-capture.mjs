// [PiDock 02e/02f/02g/02h] (#38/#39/#40/#41) real-Electron evidence for the Desktop
// main-owned Project registry. Run after `pnpm --filter @pidock/shell build`:
//   pnpm --filter @pidock/shell exec electron scripts/electron-issue41-project-registry-capture.mjs \
//     --out docs/evidence/desktop-project-registry
//
// It boots the production main wiring (`createTrustedWindow("...", "production")` +
// `registerIpc` over a real `TaskRootIndex`/`ProjectRegistry`/`PerTaskHostRegistry`) and
// the built React renderer (`dist/renderer/index.html`, no fixture entry, no Vite/dev
// override), then captures the #41 Desktop 项目总览 / 项目管理 views at 1440x900 and
// 720x560 from a real on-disk registry.
//
// Seeded through the real API: `ProjectRegistry.create` writes projects.json under the
// isolated userData; `ProjectRegistry.claim` writes the v2 membership; the task records
// themselves are written with the production `task-store` serializer (there is no
// renderer-free "create task" API before #42, and the native picker is manual acceptance).
// Nothing in the UI is faked: the captured text is what the production renderer drew.
//
// The needs-repair row is produced honestly: `task-cccc3333` is claimed, then its task
// directory is destroyed and recreated so the stored directory device/inode no longer
// match — `ProjectRegistry.association` then reports `needs-repair` for the real record.
//
// Hang discipline: the deadline timer and the uncaught-error handlers are armed before the
// compiled `dist` graph is imported (dynamically, inside the guarded region), so a stuck
// import cannot outlive the watchdog, and no failure ever leaves Electron running.
import { app, utilityProcess } from "electron";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { shutdownTestRegistry } from "./shutdown-test-registry.mjs";

// The dev-server override is inadmissible evidence for #38 box 5 / #41 box 4: clear it
// before boot so this capture can only ever load the packaged `file://` renderer.
delete process.env["PIDOCK_RENDERER_URL"];
delete process.env["PIDOCK_TASK_URL"];
if (process.env["PIDOCK_RENDERER_URL"]) throw Error("PIDOCK_RENDERER_URL survived the clear");

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const outArg = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "docs/evidence/desktop-project-registry";
const output = isAbsolute(outArg) ? outArg : resolve(repoRoot, outArg);
const command = "pnpm --filter @pidock/shell exec electron scripts/electron-issue41-project-registry-capture.mjs --out docs/evidence/desktop-project-registry";
// A fixed (not random) temp root keeps the captured source paths stable, so a re-run at
// the same revision renders byte-identical PNGs. It is still an isolated path under the
// OS temp dir, never the user's real data.
const root = join(tmpdir(), "pidock-issue41-registry-capture");
const profile = join(root, "profile");
const taskRoot = join(root, "tasks");
app.setPath("userData", profile);
const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const pngPixelSize = (png) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
const children = [];
let views, registry, index, projects;

// Arm the deadline and the failure handlers BEFORE any heavyweight work. `app.exit` is the
// only reliable terminator once the window exists; `process.exit` covers the pre-window case.
let exiting = false;
const exitNow = (code, why) => {
  if (exiting) return;
  exiting = true;
  console.error("ISSUE41_CAPTURE_EXIT", code, why);
  try { app.exit(code); } catch { process.exit(code); }
};
const watchdog = setTimeout(() => exitNow(1, "watchdog timeout"), 180000);
process.on("uncaughtException", (error) => exitNow(1, `uncaughtException ${error?.stack ?? error}`));
process.on("unhandledRejection", (error) => exitNow(1, `unhandledRejection ${error?.stack ?? error}`));
// Test-only guard: a noop listener suppresses Electron's default quit on
// window-all-closed, which would race the explicit app.exit(process.exitCode).
app.on("window-all-closed", () => {});

const now = "2026-09-22T10:00:00.000Z";

async function run() {
  let stage = "startup";
  const shots = [];
  // Dynamic imports: the compiled dist graph is pulled in only after the watchdog is armed.
  const { buildTaskDiskRecord, serializeTaskRecord } = await import("../dist/host/task-store.js");
  const { buildHostEnv } = await import("../dist/host/host-guards.js");
  const { TaskRootIndex } = await import("../dist/main/task-root-index.js");
  const { ProjectRegistry } = await import("../dist/main/project-registry.js");
  const { createTrustedWindow, loadTrustedViews, PerTaskHostRegistry, registerIpc } = await import("../dist/main/runtime.js");
  const { HostClient } = await import("../dist/rpc/host-client.js");
  const writeTask = (taskId, name) => {
    const taskDir = join(taskRoot, taskId);
    mkdirSync(taskDir, { recursive: true });
    execFileSync("git", ["init", "-q", taskDir]);
    writeFileSync(join(taskDir, "task.json"), serializeTaskRecord(buildTaskDiskRecord({
      taskId, name, dirId: taskId, branch: "main", root: taskRoot, taskDir,
      remoteBranch: "main", baseCommit: "test", repos: [], now,
    })));
    return taskDir;
  };
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    mkdirSync(profile, { recursive: true });
    mkdirSync(taskRoot, { recursive: true });
    mkdirSync(output, { recursive: true });
    stage = "whenReady";
    await app.whenReady();
    // Real persisted task records under the isolated default root.
    stage = "seed tasks";
    writeTask("task-aaaa1111", "对账单详情·已归属");
    writeTask("task-bbbb2222", "运单查询·未归属");
    const degradedDir = writeTask("task-cccc3333", "接口联调·待修复");
    index = new TaskRootIndex(profile, taskRoot);
    projects = new ProjectRegistry(profile);
    // Real source directories (metadata only; #39 stores validated paths, no existence check).
    const sourceRepo = join(root, "sources", "invoice-service");
    const sourceDir = join(root, "sources", "设计资料");
    mkdirSync(sourceRepo, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceRepo, "README.md"), "# invoice-service\n\n对账单详情服务的源仓库。\n");
    stage = "seed registry";
    const project = await projects.create({
      name: "Adder", description: "微服务开发工作台",
      repositories: [{ name: "invoice-service", path: sourceRepo }],
      directories: [{ name: "设计资料", path: sourceDir }],
    });
    await projects.claim("task-aaaa1111", project.id, index);
    await projects.claim("task-cccc3333", project.id, index);
    // Honest needs-repair: replace the claimed task directory so its device/inode no
    // longer match the persisted membership. The record identity is unchanged.
    rmSync(degradedDir, { recursive: true, force: true });
    writeTask("task-cccc3333", "接口联调·待修复");
    const association = projects.association("task-cccc3333", index);
    if (association.state !== "needs-repair") throw Error(`degraded row not produced: ${JSON.stringify(association)}`);
    if (projects.association("task-bbbb2222", index).state !== "unassigned") throw Error("second task not unassigned");

    stage = "window";
    views = await createTrustedWindow("issue41", "production");
    registry = new PerTaskHostRegistry("issue41", async (workspace, task) => {
      const entry = join(import.meta.dirname, "..", "dist", "host", "host-entry.js");
      const child = utilityProcess.fork(entry, [], { serviceName: "issue41-host", env: buildHostEnv(process.env, workspace, task, app.getPath("userData")), stdio: "pipe" });
      children.push(child);
      child.stderr?.on("data", (data) => process.stderr.write(`[issue41-host] ${data}`));
      return { child, client: new HostClient(child) };
    }, (id) => index.resolve(id), undefined, index);
    registerIpc({}, views.registry, registry, projects, index);
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
      for (let i = 0; i < 300; i++) { last = await text(); if (match(last)) return last; await wait(100); }
      throw Error(`UI timeout (${label}): ${JSON.stringify(last.slice(0, 500))}`);
    };
    const click = (name) => evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(name)}); if (!b) throw Error('missing button '+${JSON.stringify(name)}+' :: '+document.body.innerText.replace(/\\n+/g,' | ').slice(0,500)); b.click(); return true; })()`);
    const clickText = (needle) => evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(el => el.textContent.includes(${JSON.stringify(needle)})); if (!b) throw Error('missing text '+${JSON.stringify(needle)}+' :: '+document.body.innerText.replace(/\\n+/g,' | ').slice(0,500)); b.click(); return true; })()`);

    // Fail closed: the loaded entry must be the packaged React renderer over file://.
    const url = await evalJs("location.href");
    if (typeof url !== "string" || !/^file:\/\/.*\/renderer\/index\.html$/.test(url)) throw Error(`not the production file:// renderer: ${url}`);

    const capture = async (state, width, height) => {
      stage = `${state} ${width}x${height}`;
      views.window.setContentSize(width, height);
      views.shellView.setVisible(true);
      views.window.show();
      // Test-only activation: an occluded/backgrounded window can reject capturePage with
      // UnknownVizError, so bring this window frontmost before the stabilization wait.
      app.focus({ steal: true });
      views.window.moveTop();
      views.window.focus();
      await wait(250);
      const size = views.window.getContentBounds();
      if (size.width !== width || size.height !== height) throw Error(`unexpected content bounds ${JSON.stringify(size)}`);
      const name = `${size.width}x${size.height}-${state}.png`;
      // CDP screenshot of the exactly-sized shell view (same composited pixels as
      // webContents.capturePage), so a display/occlusion state that makes capturePage
      // reject with UnknownVizError cannot silently drop the evidence.
      const shot = await views.shellView.webContents.debugger.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const png = Buffer.from(shot.data, "base64");
      writeFileSync(join(output, name), png);
      const pixels = pngPixelSize(png);
      shots.push({ state, file: name, width: size.width, height: size.height,
        pixelWidth: pixels.width, pixelHeight: pixels.height,
        deviceScaleFactor: pixels.width / size.width,
        sha256: createHash("sha256").update(png).digest("hex"),
        bodyText: (await text()).replace(/\n+/g, " | ").slice(0, 900) });
    };

    // 项目总览 (default view) on the real Project: name, repository/directory counts, the
    // two associated tasks and the honest unassigned summary.
    await until((body) => body.includes("Adder") && body.includes("另有 1 个任务尚未归属任何项目") &&
      body.includes("对账单详情·已归属") && body.includes("接口联调·待修复"), "project overview");
    const overviewBody = await text();
    if (/Atlas Web|演示任务|演示统计|项目映射未建立/.test(overviewBody)) throw Error("demo/empty fixture leaked into the registry overview");
    if (!overviewBody.includes("invoice-service") || !overviewBody.includes("设计资料")) throw Error("registered repository/directory rows missing");
    await capture("project-overview", 1440, 900);
    await capture("project-overview", 720, 560);

    // 项目管理: project list + selected detail (repository/directory rows) + task rows,
    // including the honest needs-repair row for task-cccc3333.
    await click("项目管理");
    await until((body) => body.includes("项目与任务") && body.includes("接口联调·待修复") && body.includes("关联待修复"), "projects management");
    await capture("projects-management", 1440, 900);
    await capture("projects-management", 720, 560);

    // The unassigned entry inside 项目管理: the second task is claimable, and only it.
    await clickText("未归属任务");
    await until((body) => body.includes("运单查询·未归属") && body.includes("认领"), "unassigned management entry");
    await capture("projects-unassigned", 1440, 900);
    await capture("projects-unassigned", 720, 560);

    let revision = "unknown"; let trackedFilesDirty = "unknown";
    try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: repoRoot }).trim(); } catch { /* recorded as unknown */ }
    try { trackedFilesDirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8", cwd: repoRoot }).trim() ? "true" : "false"; } catch { /* recorded as unknown */ }
    const projectRecord = projects.list().projects.find((row) => row.id === project.id);
    const log = {
      ticket: "#38 box 5 / #39 box 4 / #40 box 4 / #41 boxes 1,4 — Desktop 项目与未归属任务接入持久 Host",
      command, repoRoot, revision, trackedFilesDirty,
      generatedBy: "scripts/electron-issue41-project-registry-capture.mjs",
      seeded: {
        registry: "ProjectRegistry.create/claim (real projects.json under isolated userData)",
        project: projectRecord ?? null,
        memberships: ["task-aaaa1111 -> assigned", "task-cccc3333 -> needs-repair (directory replaced after claim)"],
        unassigned: ["task-bbbb2222"],
        taskRecords: "production task-store serializer (no pre-#42 create API); records not hand-faked",
      },
      shots,
    };
    writeFileSync(join(output, "capture-log.json"), `${JSON.stringify(log, null, 2)}\n`);
    for (const shot of shots) console.log("ISSUE41_CAPTURE=" + JSON.stringify({ state: shot.state, file: shot.file, sha256: shot.sha256 }));
    console.log("ISSUE41_CAPTURE_LOG=" + JSON.stringify({ revision, trackedFilesDirty, shots: shots.map((shot) => shot.file) }));
  } catch (error) {
    console.error("ISSUE41_CAPTURE_FAILED", stage, error);
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    const cleanupFailures = await shutdownTestRegistry(registry, {
      origin: views ? { kind: "shell-ui", senderWebContentsId: views.shellView.webContents.id } : undefined,
      label: "Issue41 capture cleanup",
    });
    for (const child of children) child.kill();
    if (views?.shellView.webContents.debugger.isAttached()) views.shellView.webContents.debugger.detach();
    views?.window.destroy();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    if (cleanupFailures.length) { console.error("ISSUE41_CAPTURE_CLEANUP_FAILED " + JSON.stringify(cleanupFailures)); process.exitCode = process.exitCode ?? 1; }
    exitNow(process.exitCode ?? 0, "done");
  }
}
void run();
