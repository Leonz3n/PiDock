// [PiDock 02d] (#37) real-Electron evidence for the Desktop task-page navigation
// and view-geometry contract. Run after `pnpm --filter @pidock/shell build`:
//   pnpm --filter @pidock/shell exec electron scripts/electron-issue37-task-page-layout-capture.mjs \
//     --out docs/evidence/desktop-task-page
//
// It boots the compiled production-main wiring (`createTrustedWindow(..., "production")` +
// `loadTrustedViews` + the real `createTaskBrowserCapability`/`PerTaskHostRegistry`, exactly the
// decisions `main.ts:130-180` makes) over a real isolated task root/profile and the built React
// renderer (`dist/renderer/index.html`, no fixture entry, no Vite/dev override), then captures the
// four #37 GUI states from a real window:
//   (1) no task page selected — the real Desktop task list spans the full window
//   (2) a real, allowlisted task page opened via the production Desktop 浏览器 panel
//   (3) the multi-task selection rule (a second task's page becomes the visible one, closing it
//       falls back to the other task's still-open page) and the last-close returning the shell to
//       full width
//   (4) a real 1440x900 -> 720x560 -> 1440x900 resize with a page open
//
// Opening a task page in production is fail-closed unless the task's own front-end origins are
// configured. The documented operator configuration is the environment variable
// `PIDOCK_TASK_BROWSER_ORIGINS` (JSON `taskId -> origins`, see docs/task-graph.md); this harness
// sets it to a loopback page it serves itself and reads it back through the production parser
// `taskBrowserOriginsFromEnv`. That is a supported operator configuration, not a test backdoor:
// without it the gateway refuses every `page/open` and no page could be captured. See README §1/§3.
//
// Hang discipline: the deadline timer and the uncaught-error handlers are armed before the
// compiled `dist` graph is imported (dynamically, inside the guarded region), so a stuck import
// cannot outlive the watchdog and no failure ever leaves Electron running.
import { app, desktopCapturer, utilityProcess } from "electron";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { shutdownTestRegistry } from "./shutdown-test-registry.mjs";

// The dev-server / fixture task overrides are inadmissible evidence: clear them before boot so
// this capture can only ever load the packaged `file://` renderer.
delete process.env["PIDOCK_RENDERER_URL"];
delete process.env["PIDOCK_TASK_URL"];
if (process.env["PIDOCK_RENDERER_URL"]) throw Error("PIDOCK_RENDERER_URL survived the clear");

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const outArg = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "docs/evidence/desktop-task-page";
const output = isAbsolute(outArg) ? outArg : resolve(repoRoot, outArg);
// The package's own electron binary is invoked directly (equivalent to
// `pnpm --filter @pidock/shell exec electron scripts/...`): pnpm's pre-run dependency check
// rewrites pnpm-workspace.yaml in this environment, and the capture must not dirty a tracked file.
const command = "packages/shell/node_modules/.bin/electron packages/shell/scripts/electron-issue37-task-page-layout-capture.mjs --out docs/evidence/desktop-task-page";
// A fixed (not random) temp root keeps the captured source paths stable, so a re-run at the same
// revision renders byte-identical PNGs. It is still an isolated path under the OS temp dir.
const root = join(tmpdir(), "pidock-issue37-task-page-capture");
const profile = join(root, "profile");
const taskRoot = join(root, "tasks");
// A fixed loopback port: the page URL is rendered inside the shell (the 浏览器 panel notice and
// breadcrumb), so an ephemeral port would change the captured pixels between runs.
const PORT = 45137;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TASK_A = "task-aaaa1111";
const TASK_B = "task-bbbb2222";
const TASK_C = "task-cccc3333";
app.setPath("userData", profile);
const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const pngPixelSize = (png) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
const children = [];
let views, registry, index, projects, server;

// Arm the deadline and the failure handlers BEFORE any heavyweight work. `app.exit` is the only
// reliable terminator once the window exists; `process.exit` covers the pre-window case.
let exiting = false;
const exitNow = (code, why) => {
  if (exiting) return;
  exiting = true;
  console.error("ISSUE37_CAPTURE_EXIT", code, why);
  try { app.exit(code); } catch { process.exit(code); }
};
const watchdog = setTimeout(() => exitNow(1, "watchdog timeout"), 240000);
process.on("uncaughtException", (error) => exitNow(1, `uncaughtException ${error?.stack ?? error}`));
process.on("unhandledRejection", (error) => exitNow(1, `unhandledRejection ${error?.stack ?? error}`));
// Test-only guard: a noop listener suppresses Electron's default quit on window-all-closed, which
// would race the explicit app.exit(process.exitCode) with a false-pass exit 0.
app.on("window-all-closed", () => {});

const PAGE_A = "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>任务 A 页面</title>" +
  "<style>html,body{margin:0;height:100%}body{background:#0f2a43;color:#e8f1fb;font:600 42px -apple-system,Segoe UI,sans-serif;" +
  "display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:14px;padding:48px}" +
  ".row{font-size:20px;font-weight:400;color:#9fc3e6}</style></head>" +
  "<body><div>真实任务页 · A</div><div class=\"row\">对账单详情 · 127.0.0.1 loopback</div>" +
  "<div class=\"row\" data-page=\"task-a\">task-browser-page task-a</div></body></html>";
const PAGE_B = "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>任务 B 页面</title>" +
  "<style>html,body{margin:0;height:100%}body{background:#3a2410;color:#ffe9cf;font:600 42px -apple-system,Segoe UI,sans-serif;" +
  "display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:14px;padding:48px}" +
  ".row{font-size:20px;font-weight:400;color:#e2b98a}</style></head>" +
  "<body><div>真实任务页 · B</div><div class=\"row\">运单查询 · 127.0.0.1 loopback</div>" +
  "<div class=\"row\" data-page=\"task-b\">task-browser-page task-b</div></body></html>";

function startPageServer() {
  return new Promise((resolvePromise, reject) => {
    server = createServer((request, response) => {
      const path = (request.url ?? "/").split("?")[0];
      const body = path === "/a" ? PAGE_A : path === "/b" ? PAGE_B : null;
      if (body === null) { response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); response.end("not found"); return; }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(body);
    });
    server.on("error", reject);
    server.listen(PORT, "127.0.0.1", () => resolvePromise(server.address().port));
  });
}

async function run() {
  let stage = "startup";
  const shots = [];
  // Dynamic imports: the compiled dist graph is pulled in only after the watchdog is armed.
  const { buildTaskDiskRecord, serializeTaskRecord } = await import("../dist/host/task-store.js");
  const { buildHostEnv } = await import("../dist/host/host-guards.js");
  const { TaskRootIndex } = await import("../dist/main/task-root-index.js");
  const { ProjectRegistry } = await import("../dist/main/project-registry.js");
  const { createTaskBrowserCapability, createTrustedWindow, loadTrustedViews, PerTaskHostRegistry, registerIpc, taskBrowserOriginsFromEnv } = await import("../dist/main/runtime.js");
  const { CreationIntentStore, ProjectTaskCreation } = await import("../dist/main/project-task-creation.js");
  const { ProviderProfileStore } = await import("../dist/main/provider-profile-store.js");
  const { ProviderWiring } = await import("../dist/main/provider-ipc.js");
  const { HostClient } = await import("../dist/rpc/host-client.js");

  const writeTask = (taskId, name) => {
    const taskDir = join(taskRoot, taskId);
    mkdirSync(taskDir, { recursive: true });
    execFileSync("git", ["init", "-q", taskDir]);
    writeFileSync(join(taskDir, "task.json"), serializeTaskRecord(buildTaskDiskRecord({
      taskId, name, dirId: taskId, branch: "main", root: taskRoot, taskDir,
      remoteBranch: "main", baseCommit: "test", repos: [], now: "2026-09-22T10:00:00.000Z",
    })));
    return taskDir;
  };
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    mkdirSync(profile, { recursive: true });
    mkdirSync(taskRoot, { recursive: true });
    mkdirSync(output, { recursive: true });
    stage = "loopback page server";
    await startPageServer();
    // The documented operator configuration for this isolated run: each task's own front-end origin.
    const origins = { [TASK_A]: [ORIGIN], [TASK_B]: [ORIGIN] };
    process.env["PIDOCK_TASK_BROWSER_ORIGINS"] = JSON.stringify(origins);
    // Read it back through the production parser the production entry uses.
    const taskOrigins = taskBrowserOriginsFromEnv(process.env["PIDOCK_TASK_BROWSER_ORIGINS"]);
    if (JSON.stringify(taskOrigins[TASK_A]) !== JSON.stringify([ORIGIN])) throw Error("origins configuration did not parse");

    stage = "whenReady";
    await app.whenReady();
    // Real persisted task records under the isolated default root.
    stage = "seed tasks";
    writeTask(TASK_A, "对账单详情·任务A");
    writeTask(TASK_B, "运单查询·任务B");
    writeTask(TASK_C, "库存核对·未归属");
    index = new TaskRootIndex(profile, taskRoot);
    projects = new ProjectRegistry(profile);
    const sourceRepo = join(root, "sources", "invoice-service");
    mkdirSync(sourceRepo, { recursive: true });
    writeFileSync(join(sourceRepo, "README.md"), "# invoice-service\n\n对账单详情服务的源仓库。\n");
    stage = "seed registry";
    const project = await projects.create({ name: "Adder", description: "微服务开发工作台", repositories: [{ name: "invoice-service", path: sourceRepo }], directories: [] });
    await projects.claim(TASK_A, project.id, index);
    await projects.claim(TASK_B, project.id, index);
    if (projects.association(TASK_C, index).state !== "unassigned") throw Error("third task not unassigned");

    stage = "window";
    views = await createTrustedWindow("issue37", "production");
    const browsers = createTaskBrowserCapability({
      window: views.window,
      trust: views.registry,
      workspaceId: "issue37",
      originsFor: (taskId) => taskOrigins[taskId] ?? [],
      ...(views.layout ? { layout: views.layout } : {}),
    });
    registry = new PerTaskHostRegistry("issue37", async (workspace, task) => {
      const entry = join(import.meta.dirname, "..", "dist", "host", "host-entry.js");
      const child = utilityProcess.fork(entry, [], { serviceName: "issue37-host", env: buildHostEnv(process.env, workspace, task, app.getPath("userData")), stdio: "pipe" });
      children.push(child);
      child.stderr?.on("data", (data) => process.stderr.write(`[issue37-host] ${data}`));
      return { child, client: new HostClient(child) };
    }, (id) => index.resolve(id), browsers.registry, index);
    const providerProfiles = new ProviderProfileStore(profile);
    const creation = new ProjectTaskCreation(new CreationIntentStore(profile), projects, index, registry, taskRoot);
    const providers = new ProviderWiring(providerProfiles, async (taskId, provider, senderWebContentsId) => {
      const payload = provider === null
        ? { provider: null }
        : { provider: { config: providerProfiles.config(provider.profileId), credential: provider.credential } };
      await registry.routeTaskOp({ workspaceId: "issue37", taskId, op: "task/sdkProvider", payload, origin: { kind: "shell-ui", senderWebContentsId } });
    });
    // Production wiring decisions (`main.ts:157-180`); the service catalog is the one production
    // dependency left out (see README §2) — nothing visible in these states depends on it.
    registerIpc({}, views.registry, registry, projects, index, undefined, creation, providers);
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
    const click = (name) => evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(name)} || el.getAttribute('aria-label') === ${JSON.stringify(name)}); if (!b) throw Error('missing button '+${JSON.stringify(name)}+' :: '+document.body.innerText.replace(/\\n+/g,' | ').slice(0,500)); b.click(); return true; })()`);
    const clickSelector = (selector) => evalJs(`(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b) throw Error('missing '+${JSON.stringify(selector)}+' :: '+document.body.innerText.replace(/\\n+/g,' | ').slice(0,500)); b.click(); return true; })()`);
    const fill = (label, value) => evalJs(`(() => { const el = document.querySelector('input[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']'); if (!el) throw Error('missing input '+${JSON.stringify(label)}); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value; })()`);

    // Fail closed: the loaded entry must be the packaged React renderer over file://.
    const url = await evalJs("location.href");
    if (typeof url !== "string" || !/^file:\/\/.*\/renderer\/index\.html$/.test(url)) throw Error(`not the production file:// renderer: ${url}`);

    const geometry = () => {
      const content = views.window.getContentBounds();
      const active = views.layout?.activeBrowser;
      const tab = active?.activeTab;
      return {
        contentWidth: content.width, contentHeight: content.height,
        shellBounds: views.shellView.getBounds(),
        shellVisible: views.shellView.getVisible(),
        pageTaskId: active?.taskId ?? null,
        pageUrl: tab ? tab.view.webContents.getURL() : null,
        pageBounds: tab ? tab.view.getBounds() : null,
        pageVisible: tab ? tab.view.getVisible() : null,
      };
    };

    const captureWindow = async (state, width, height) => {
      stage = `${state} ${width}x${height}`;
      views.window.setContentSize(width, height);
      views.shellView.setVisible(true);
      views.window.show();
      // Test-only activation: bring this window frontmost before the capture.
      app.focus({ steal: true });
      views.window.moveTop();
      views.window.focus();
      await wait(400);
      const content = views.window.getContentBounds();
      if (content.width !== width || content.height !== height) throw Error(`unexpected content bounds ${JSON.stringify(content)}`);
      const bounds = views.window.getBounds();
      // Real window-level screenshot: `BrowserWindow.capturePage` only captures the (empty) base
      // webContents, and CDP `Page.captureScreenshot` captures one WebContentsView at a time, so
      // only the OS window source shows the shell and the task page composited as the user sees it.
      const sources = await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: Math.round(bounds.width * 2), height: Math.round(bounds.height * 2) },
      });
      const sourceId = views.window.getMediaSourceId();
      const source = sources.find((candidate) => candidate.id === sourceId) ?? sources.find((candidate) => candidate.name.includes("PiDock"));
      if (!source) throw Error(`no desktopCapturer window source for ${sourceId}: ${JSON.stringify(sources.map((candidate) => candidate.name))}`);
      const png = source.thumbnail.toPNG();
      const name = `${width}x${height}-${state}.png`;
      writeFileSync(join(output, name), png);
      const pixels = pngPixelSize(png);
      // Recorded (not asserted): the renderer's own horizontal overflow inside the shell view.
      // At the 720x560 minimum the shell column is 280px, narrower than the renderer's own
      // narrowest tier; the production view geometry is what this harness asserts.
      let shellHorizontalOverflow = null;
      try { shellHorizontalOverflow = await evalJs("document.documentElement.scrollWidth - document.documentElement.clientWidth"); } catch { /* recorded as unknown */ }
      shots.push({
        state, file: name, windowBounds: { width: bounds.width, height: bounds.height },
        width, height,
        pixelWidth: pixels.width, pixelHeight: pixels.height,
        deviceScaleFactor: Number((pixels.width / bounds.width).toFixed(3)),
        sha256: createHash("sha256").update(png).digest("hex"),
        shellHorizontalOverflow,
        geometry: geometry(),
        bodyText: (await text()).replace(/\n+/g, " | ").slice(0, 900),
      });
    };

    const openPageViaGateway = async (taskId, urlPath) => {
      const pageUrl = `${ORIGIN}${urlPath}`;
      stage = `gateway page/open ${taskId}`;
      const result = await browsers.registry.handleRequest({
        workspaceId: "issue37", taskId, action: "page/open", params: { url: pageUrl },
        actor: { kind: "human", label: "issue37 capture" },
      });
      if (!result.ok) throw Error(`gateway page/open refused: ${JSON.stringify(result)}`);
      return result.payload;
    };
    const closePageViaGateway = async (taskId) => {
      stage = `gateway page/close ${taskId}`;
      const surface = browsers.surfaces.get(taskId);
      const page = surface?.pages()[0];
      if (!page) throw Error(`no live page to close for ${taskId}`);
      const result = await browsers.registry.handleRequest({
        workspaceId: "issue37", taskId, action: "page/close", page: { taskId, pageId: page.pageId }, params: {},
        actor: { kind: "human", label: "issue37 capture" },
      });
      if (!result.ok) throw Error(`gateway page/close refused: ${JSON.stringify(result)}`);
      return result.payload;
    };

    // (1) No task page selected: the real task list spans the full window, no demo Project/Task.
    await until((body) => body.includes("库存核对·未归属") && body.includes("Adder"), "desktop task list");
    const baselineBody = await text();
    if (/Atlas Web|演示任务|演示统计/.test(baselineBody)) throw Error("demo fixture leaked into the Desktop baseline");
    const baselineGeometry = geometry();
    if (baselineGeometry.shellBounds.width !== 1440) throw Error(`baseline shell is not full width: ${JSON.stringify(baselineGeometry)}`);
    if (baselineGeometry.pageTaskId !== null) throw Error("baseline unexpectedly has an active task page");
    await captureWindow("no-page-selected", 1440, 900);
    await captureWindow("no-page-selected", 720, 560);
    await captureWindow("no-page-selected", 1440, 900);

    // (2) A real, allowlisted task page opened through the production Desktop 浏览器 panel
    // (fill + click drive the real renderer -> preload -> shell/taskOp -> Host -> main gateway path).
    stage = "open task A workspace";
    await clickSelector(`[data-task-nav="${TASK_A}"]`);
    await until((body) => /task workspace/i.test(body) && body.includes("对账单详情·任务A"), "task A workspace");
    stage = "open 浏览器 panel";
    await click("浏览器");
    await until((body) => body.includes("任务页面 · 主进程窗口") && body.includes("打开任务页面"), "browser panel");
    await fill("任务页面地址", `${ORIGIN}/a`);
    await click("打开任务页面");
    stage = "wait page A open";
    await until((body) => body.includes(`主进程窗口已打开 ${ORIGIN}/a`), "page A opened");
    const openGeometry = geometry();
    if (openGeometry.pageTaskId !== TASK_A) throw Error(`page A not active: ${JSON.stringify(openGeometry)}`);
    if (!openGeometry.pageUrl?.endsWith("/a")) throw Error(`page A url unexpected: ${JSON.stringify(openGeometry)}`);
    if (openGeometry.shellBounds.width >= 1440) throw Error(`shell did not yield width to the page: ${JSON.stringify(openGeometry)}`);
    await captureWindow("browser-tool-open", 1440, 900);
    // Close the dock so the shell shows the task workspace next to the page at its real width.
    await click("关闭面板");
    await until((body) => !body.includes("任务页面 · 主进程窗口"), "browser panel closed");
    await captureWindow("task-page-open", 1440, 900);

    // (4) Real resize with a page open: 1440x900 -> 720x560 -> 1440x900; every visible view must
    // follow the window and no view may end up zero-width or overlapping.
    await captureWindow("task-page-open", 720, 560);
    const minGeometry = shots[shots.length - 1].geometry;
    const minShell = minGeometry.shellBounds;
    const minPage = minGeometry.pageBounds;
    if (minShell.width <= 0 || minPage.width <= 0) throw Error(`zero-width view at minimum size: ${JSON.stringify(minGeometry)}`);
    if (minShell.x + minShell.width > minPage.x) throw Error(`shell/page overlap at minimum size: ${JSON.stringify(minGeometry)}`);
    if (minShell.x !== 0 || minPage.x !== minShell.width || minPage.width !== 720 - minShell.width) throw Error(`views do not tile the minimum window: ${JSON.stringify(minGeometry)}`);
    await captureWindow("task-page-open-resized", 1440, 900);
    const restored = shots[shots.length - 1].geometry;
    if (restored.shellBounds.width >= 1440 || restored.pageBounds.width !== 1440 - restored.shellBounds.width) throw Error(`views did not resize back: ${JSON.stringify(restored)}`);

    // (3) Multi-task selection rule: opening a second task's page makes it the visible one while
    // the first task's page stays open.
    await openPageViaGateway(TASK_B, "/b");
    await wait(300);
    const selected = geometry();
    if (selected.pageTaskId !== TASK_B || !selected.pageUrl?.endsWith("/b")) throw Error(`task B page not selected: ${JSON.stringify(selected)}`);
    await captureWindow("multi-task-page-b-selected", 1440, 900);
    await captureWindow("multi-task-page-b-selected", 720, 560);
    await captureWindow("multi-task-page-b-selected", 1440, 900);
    // Closing B's page returns the layout to A's still-open page (not to full width).
    await closePageViaGateway(TASK_B);
    await wait(300);
    const fallback = geometry();
    if (fallback.pageTaskId !== TASK_A || !fallback.pageUrl?.endsWith("/a")) throw Error(`closing B did not fall back to A: ${JSON.stringify(fallback)}`);
    if (fallback.shellBounds.width >= 1440) throw Error(`shell returned to full width before the last page closed: ${JSON.stringify(fallback)}`);
    await captureWindow("multi-task-page-a-restored", 1440, 900);
    await captureWindow("multi-task-page-a-restored", 720, 560);
    await captureWindow("multi-task-page-a-restored", 1440, 900);

    // (3) Closing the last page returns the shell to full width.
    await closePageViaGateway(TASK_A);
    await wait(300);
    const closed = geometry();
    if (closed.pageTaskId !== null) throw Error(`a page is still active after the last close: ${JSON.stringify(closed)}`);
    if (closed.shellBounds.width !== 1440 || !closed.shellVisible) throw Error(`shell not full width after last close: ${JSON.stringify(closed)}`);
    await captureWindow("last-page-closed", 1440, 900);
    await captureWindow("last-page-closed", 720, 560);
    await captureWindow("last-page-closed", 1440, 900);

    let revision = "unknown"; let trackedFilesDirty = "unknown";
    try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: repoRoot }).trim(); } catch { /* recorded as unknown */ }
    try {
      // Report whether the SOURCE tree was clean. This run rewrites the evidence directory named
      // by `--out`, whose tracked bytes legitimately differ until the result is committed, so that
      // directory is excluded; every other tracked path must be clean.
      const excluded = output.startsWith(repoRoot) ? output.slice(repoRoot.length + 1) : undefined;
      const args = ["status", "--porcelain", "--untracked-files=no", "--", "."];
      if (excluded) args.push(`:(exclude)${excluded}`);
      trackedFilesDirty = execFileSync("git", args, { encoding: "utf8", cwd: repoRoot }).trim() ? "true" : "false";
    } catch { /* recorded as unknown */ }
    const log = {
      ticket: "#37 box 6 — real-Electron empty/task-page navigation, multi-task selection and view geometry",
      command, repoRoot, revision, trackedFilesDirty,
      generatedBy: "scripts/electron-issue37-task-page-layout-capture.mjs",
      configuration: {
        envVariable: "PIDOCK_TASK_BROWSER_ORIGINS",
        value: origins,
        disclosure: "Set by the harness as the documented operator configuration; without it production refuses every page/open (fail-closed).",
      },
      seeded: {
        taskRoot: "isolated temp dir; real task.json written by the production task-store serializer",
        tasks: { [TASK_A]: "claimed to Project Adder", [TASK_B]: "claimed to Project Adder", [TASK_C]: "unassigned" },
        loopbackPages: { "/a": "real page served by this harness on 127.0.0.1", "/b": "real page served by this harness on 127.0.0.1" },
      },
      driven: {
        pageOpenTaskA: "real Desktop 浏览器 panel: fill 任务页面地址 + click 打开任务页面 (renderer -> shell/taskOp -> Host -> main gateway)",
        pageOpenTaskB: "main browser gateway page/open (human actor) — no Desktop control switches task while a page covers the window",
        pageClose: "main browser gateway page/close (human actor) — the Desktop exposes no close control",
      },
      shots,
    };
    writeFileSync(join(output, "capture-log.json"), `${JSON.stringify(log, null, 2)}\n`);
    for (const shot of shots) console.log("ISSUE37_CAPTURE=" + JSON.stringify({ state: shot.state, file: shot.file, sha256: shot.sha256, geometry: shot.geometry }));
    console.log("ISSUE37_CAPTURE_LOG=" + JSON.stringify({ revision, trackedFilesDirty, shots: shots.map((shot) => shot.file) }));
  } catch (error) {
    console.error("ISSUE37_CAPTURE_FAILED", stage, error);
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    server?.close();
    const cleanupFailures = await shutdownTestRegistry(registry, {
      origin: views ? { kind: "shell-ui", senderWebContentsId: views.shellView.webContents.id } : undefined,
      label: "Issue37 capture cleanup",
    });
    delete process.env["PIDOCK_TASK_BROWSER_ORIGINS"];
    for (const child of children) child.kill();
    if (views?.shellView.webContents.debugger.isAttached()) views.shellView.webContents.debugger.detach();
    views?.window.destroy();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    if (cleanupFailures.length) { console.error("ISSUE37_CAPTURE_CLEANUP_FAILED " + JSON.stringify(cleanupFailures)); process.exitCode = process.exitCode ?? 1; }
    exitNow(process.exitCode ?? 0, "done");
  }
}
void run();
