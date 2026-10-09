// [PiDock 02d] (#37) real-Electron evidence for the Desktop task-page navigation
// and view-geometry contract. Run after `pnpm --filter @pidock/shell build`:
//   packages/shell/node_modules/.bin/electron \
//     packages/shell/scripts/electron-issue37-task-page-layout-capture.mjs \
//     --out docs/evidence/desktop-task-page
//
// It boots the compiled production-main wiring (`createTrustedWindow(..., "production")` +
// `loadTrustedViews` + the real `createTaskBrowserCapability`/`PerTaskHostRegistry`, exactly the
// decisions `main.ts:130-180` makes) over a real isolated task root/profile and the built React
// renderer (`dist/renderer/index.html`, no fixture entry, no Vite/dev override), then captures the
// #37 GUI states from a real window:
//   (1) no task page selected — the real Desktop task list spans the full window
//   (2) a real, allowlisted task page opened via the production Desktop 浏览器 panel
//   (3) the multi-task selection rule (a second task's page becomes the visible one, closing it
//       restores the other task's still-open page) and the last-close returning the shell to
//       full width
//   (4) a real 1440x900 -> 1000x700 -> 720x560 -> 1440x900 resize with a page open
//
// #49 shell-column guard: every capture with a task workspace open must pass `shellColumn` (see
// `assertShellColumnReadable`): the shell column's own `scrollWidth`/`clientWidth`, the toolbar
// bounding box vs the `Task workspace` eyebrow text box (no intersection), and the toolbar inside
// the column. The earlier `documentElement.scrollWidth - clientWidth` was 0 for every shot because
// the overflow lives inside a nested scroll container, so it could never fail.
//
// Capture contract (why `capture-log.json` is a 1:1, self-consistent inventory):
// - every (scenario, size) pair is captured exactly once. A state that a scenario returns to is
//   asserted through its view geometry and recorded in `checks[]` instead of being committed as a
//   byte-identical look-alike image; every committed PNG therefore shows a state no other
//   committed PNG shows, and the script refuses to write a bundle whose shots are not pairwise
//   distinct (sha256) and 1:1 with the PNGs in `--out`.
// - the committed PNG is the real window capture CROPPED to the window content box
//   (`getContentBounds()`): the OS title bar is not app content. So
//   `pixelWidth === width * deviceScaleFactor`, `pixelHeight === height * deviceScaleFactor` and
//   the `<width>x<height>` in the file name is the logical box of the bitmap itself
//   (= the CSS content box that `setContentSize` asserted).
// - the capture happens at the display's own scale factor, so `deviceScaleFactor` is the real
//   device scale and the bitmap is not an upscale of a smaller capture.
// - each scenario has to change app state: the resize is captured at a third, strictly interior
//   width (1000 -> shell 360, not the 280/380 clamps), and the restore-to-A capture shows the page
//   A navigated to *while it was hidden behind B* (`/a2`) — a state only the restore can produce,
//   which also proves main restored A's live page instead of loading a fresh one.
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
import { app, desktopCapturer, screen, utilityProcess } from "electron";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { shutdownTestRegistry } from "./shutdown-test-registry.mjs";

// The dev-server / fixture task overrides are inadmissible evidence: clear them before boot so
// this capture can only ever load the packaged `file://` renderer.
for (const name of ["PIDOCK_RENDERER_URL", "PIDOCK_TASK_URL"]) delete process.env[name];
if (process.env["PIDOCK_RENDERER_URL"] || process.env["PIDOCK_TASK_URL"]) throw Error("renderer/task URL overrides survived the clear");

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const harnessFile = resolve(import.meta.dirname, "electron-issue37-task-page-layout-capture.mjs");
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

// The loopback pages this harness serves. Each one is a real HTTP document loaded through the
// production browser path; `/a2` is the address task A's page navigates to while it is hidden
// behind task B's page (see scenario 3). The background colours are the anchors the capture uses
// to prove the crop starts exactly at the window's content box (no OS title bar in the PNG).
const PAGE_BACKGROUND = { "/a": [15, 42, 67], "/a2": [31, 92, 70], "/b": [58, 36, 16] };
const pageShell = (foreground, muted) => "<style>html,body{margin:0;height:100%}body{color:" + foreground + ";font:600 42px -apple-system,Segoe UI,sans-serif;" +
  "display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:14px;padding:48px}" +
  ".row{font-size:20px;font-weight:400;color:" + muted + "}</style>";
const PAGE_A = "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>任务 A 页面</title>" +
  pageShell("#e8f1fb", "#9fc3e6") + "</head>" +
  "<body style=\"background:#0f2a43\"><div>真实任务页 · A</div><div class=\"row\">对账单详情 · 127.0.0.1 loopback</div>" +
  "<div class=\"row\" data-page=\"task-a\">task-browser-page task-a</div></body></html>";
const PAGE_A2 = "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>任务 A 页面 · 已导航</title>" +
  pageShell("#eafff4", "#c9ecd9") + "</head>" +
  "<body style=\"background:#1f5c46\"><div>真实任务页 · A · 已导航</div><div class=\"row\">对账单详情 · 127.0.0.1 loopback · /a2</div>" +
  "<div class=\"row\" data-page=\"task-a2\">task-browser-page task-a · 后台导航后恢复</div></body></html>";
const PAGE_B = "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>任务 B 页面</title>" +
  pageShell("#ffe9cf", "#e2b98a") + "</head>" +
  "<body style=\"background:#3a2410\"><div>真实任务页 · B</div><div class=\"row\">运单查询 · 127.0.0.1 loopback</div>" +
  "<div class=\"row\" data-page=\"task-b\">task-browser-page task-b</div></body></html>";

function startPageServer() {
  return new Promise((resolvePromise, reject) => {
    server = createServer((request, response) => {
      const path = (request.url ?? "/").split("?")[0];
      const body = path === "/a" ? PAGE_A : path === "/a2" ? PAGE_A2 : path === "/b" ? PAGE_B : null;
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
  const checks = [];
  let captureSourceName = null;
  let captureDisplayScale = null;
  const check = (name, detail) => { checks.push({ name, detail }); };
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
    const shellEntryUrl = await evalJs("location.href");
    if (typeof shellEntryUrl !== "string" || !/^file:\/\/.*\/renderer\/index\.html$/.test(shellEntryUrl)) throw Error(`not the production file:// renderer: ${shellEntryUrl}`);

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

    // #49: the defect metric. `documentElement.scrollWidth - clientWidth` is 0 in every shot
    // because the shell column's overflow is *inside* a nested scroll container, so the old
    // `shellHorizontalOverflow` could never fail. This measures the column itself (the
    // `overflow-y-auto` shell main, whose computed `overflow-x` is `auto`) plus the real control
    // boxes: the toolbar must not intersect the `Task workspace` eyebrow and must stay inside the
    // column. The range box is what makes the overlap visible even though the shrunk title div is
    // 0px wide and its eyebrow text only overflows visually.
    const measureShellColumn = () => evalJs(`(() => {
      const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
      const rangeBox = (range) => { const r = range.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
      const intersects = (a, b) => a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
      const content = document.querySelector('[data-testid="desktop-shell-content"]');
      const breadcrumb = document.querySelector('[data-testid="desktop-breadcrumb"]');
      const header = document.querySelector('[data-testid="desktop-conversation-header"]');
      const metric = {
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        content: content ? { scrollWidth: content.scrollWidth, clientWidth: content.clientWidth, box: box(content) } : null,
        breadcrumb: breadcrumb ? { scrollWidth: breadcrumb.scrollWidth, clientWidth: breadcrumb.clientWidth, box: box(breadcrumb) } : null,
        toolbar: null, eyebrow: null, toolbarOverlapsEyebrow: null, toolbarInsideColumn: null,
      };
      if (header && content) {
        const toolbar = header.querySelector('[data-testid="desktop-conversation-toolbar"]');
        const eyebrow = header.querySelector('[data-testid="desktop-conversation-eyebrow"]');
        if (toolbar && eyebrow) {
          const toolbarBox = box(toolbar);
          const range = document.createRange();
          range.selectNodeContents(eyebrow);
          const eyebrowBox = rangeBox(range);
          metric.toolbar = toolbarBox;
          metric.eyebrow = eyebrowBox;
          metric.toolbarOverlapsEyebrow = intersects(toolbarBox, eyebrowBox);
          metric.toolbarInsideColumn = toolbarBox.x >= metric.content.box.x - 0.5 && toolbarBox.right <= metric.content.box.right + 0.5;
        }
      }
      return metric;
    })()`);
    const assertShellColumnReadable = (state, width, height, metric) => {
      if (!metric.content) return;
      const overflow = metric.content.scrollWidth - metric.content.clientWidth;
      if (overflow > 0) throw Error(`shell column has ${overflow}px of inner horizontal overflow at ${width}x${height} (${state})`);
      const breadcrumbOverflow = metric.breadcrumb ? metric.breadcrumb.scrollWidth - metric.breadcrumb.clientWidth : 0;
      if (breadcrumbOverflow > 0) throw Error(`shell column breadcrumb has ${breadcrumbOverflow}px of horizontal overflow at ${width}x${height} (${state})`);
      if (metric.toolbarOverlapsEyebrow === true) throw Error(`task toolbar intersects the Task workspace heading at ${width}x${height} (${state})`);
      if (metric.toolbarInsideColumn === false) throw Error(`task toolbar extends past the shell column at ${width}x${height} (${state})`);
    };

    const colorClose = (rgb, expected) => Math.abs(rgb[0] - expected[0]) <= 12 && Math.abs(rgb[1] - expected[1]) <= 12 && Math.abs(rgb[2] - expected[2]) <= 12;

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
      // The thumbnail is requested at this display's own scale factor, so the bitmap has the
      // device's pixels and `deviceScaleFactor` below is a real device scale, not an upscale.
      const displayScale = screen.getDisplayMatching(bounds).scaleFactor;
      if (captureDisplayScale === null) captureDisplayScale = displayScale;
      else if (captureDisplayScale !== displayScale) throw Error(`display scale changed mid-run: ${captureDisplayScale} -> ${displayScale}`);
      const sources = await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: Math.round(bounds.width * displayScale), height: Math.round(bounds.height * displayScale) },
      });
      const sourceId = views.window.getMediaSourceId();
      // Exact `mediaSourceId` match only: the name-based fallback could silently capture another
      // window, which would still produce a PNG.
      const source = sources.find((candidate) => candidate.id === sourceId);
      if (!source) throw Error(`no desktopCapturer window source for ${sourceId}: ${JSON.stringify(sources.map((candidate) => candidate.name))}`);
      if (captureSourceName === null) captureSourceName = source.name;
      else if (captureSourceName !== source.name) throw Error(`window source name changed mid-run: ${captureSourceName} -> ${source.name}`);
      const image = source.thumbnail;
      const imageSize = image.getSize();
      const sourcePixels = pngPixelSize(image.toPNG());
      const bitmap = image.toBitmap();
      if (bitmap.length !== sourcePixels.width * sourcePixels.height * 4) {
        throw Error(`unexpected thumbnail bitmap length ${bitmap.length} for a ${sourcePixels.width}x${sourcePixels.height} image`);
      }
      const pixelsPerLogical = sourcePixels.width / bounds.width;
      const cropUnitsPerLogical = imageSize.width / bounds.width;
      const frame = { x: content.x - bounds.x, y: content.y - bounds.y };
      if (frame.x < 0 || frame.y < 0 || frame.x * cropUnitsPerLogical !== Math.round(frame.x * cropUnitsPerLogical) || frame.y * cropUnitsPerLogical !== Math.round(frame.y * cropUnitsPerLogical)) {
        throw Error(`window frame offset is not a whole number of bitmap pixels: ${JSON.stringify({ frame, cropUnitsPerLogical })}`);
      }
      const before = geometry();
      // The crop has to start exactly where the app content starts. When a task page is visible the
      // page's own top edge is the proof: the first row whose page-area pixel carries the page's
      // background colour must be the row the crop starts at (the rows above are OS title bar).
      let boundaryRow = null;
      if (before.pageTaskId !== null && before.pageUrl !== null && before.pageBounds !== null) {
        const expected = PAGE_BACKGROUND[new URL(before.pageUrl).pathname];
        if (expected === undefined) throw Error(`unknown page background for ${before.pageUrl}`);
        const column = Math.round((before.pageBounds.x + Math.min(200, Math.floor(before.pageBounds.width / 2))) * pixelsPerLogical);
        for (let y = 0; y < Math.round(frame.y * pixelsPerLogical) + 8; y++) {
          const i = (y * sourcePixels.width + column) * 4;
          if (colorClose([bitmap[i + 2], bitmap[i + 1], bitmap[i]], expected)) { boundaryRow = y; break; }
        }
        const cropRow = Math.round(frame.y * pixelsPerLogical);
        if (boundaryRow === null || Math.abs(boundaryRow - cropRow) > 2) {
          throw Error(`crop offset ${cropRow} does not match the page top edge ${boundaryRow} (column ${column})`);
        }
      }
      const pixel = image.crop({
        x: Math.round(frame.x * cropUnitsPerLogical), y: Math.round(frame.y * cropUnitsPerLogical),
        width: Math.round(content.width * cropUnitsPerLogical), height: Math.round(content.height * cropUnitsPerLogical),
      }).toPNG();
      const pixels = pngPixelSize(pixel);
      const expectedPixels = { width: Math.round(content.width * pixelsPerLogical), height: Math.round(content.height * pixelsPerLogical) };
      if (pixels.width !== expectedPixels.width || pixels.height !== expectedPixels.height) {
        throw Error(`cropped bitmap ${pixels.width}x${pixels.height} is not the content box at this scale ${expectedPixels.width}x${expectedPixels.height}`);
      }
      // #49: the non-hollow guard. Measure (and assert) BEFORE writing the PNG so a broken shell
      // column cannot leave a captured image behind. The metric is chosen so the pre-#49 layout
      // fails it: the old `documentElement.scrollWidth - clientWidth` was 0 for every shot.
      const shellColumn = await measureShellColumn();
      assertShellColumnReadable(state, width, height, shellColumn);
      const name = `${width}x${height}-${state}.png`;
      writeFileSync(join(output, name), pixel);
      shots.push({
        state, file: name,
        width, height,
        pixelWidth: pixels.width, pixelHeight: pixels.height,
        deviceScaleFactor: Number((pixels.width / width).toFixed(3)),
        windowBounds: { width: bounds.width, height: bounds.height },
        frameOffset: frame,
        cropOffsetPixels: { x: Math.round(frame.x * pixelsPerLogical), y: Math.round(frame.y * pixelsPerLogical) },
        pageTopEdgePixels: boundaryRow,
        sha256: createHash("sha256").update(pixel).digest("hex"),
        shellColumn,
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
    const livePage = (taskId, label) => {
      const page = browsers.surfaces.get(taskId)?.pages()[0];
      if (!page) throw Error(`no live page for ${label ?? taskId}`);
      return page;
    };
    const navigatePageViaGateway = async (taskId, urlPath) => {
      const page = livePage(taskId);
      stage = `gateway page/navigate ${taskId} ${urlPath}`;
      const result = await browsers.registry.handleRequest({
        workspaceId: "issue37", taskId, action: "page/navigate",
        page: { taskId, pageId: page.pageId }, params: { url: `${ORIGIN}${urlPath}` },
        actor: { kind: "human", label: "issue37 capture" },
      });
      if (!result.ok) throw Error(`gateway page/navigate refused: ${JSON.stringify(result)}`);
      return result.payload;
    };
    const closePageViaGateway = async (taskId) => {
      const page = livePage(taskId);
      stage = `gateway page/close ${taskId}`;
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
    if (baselineGeometry.shellBounds.width !== baselineGeometry.contentWidth) throw Error(`baseline shell is not full width: ${JSON.stringify(baselineGeometry)}`);
    if (baselineGeometry.pageTaskId !== null) throw Error("baseline unexpectedly has an active task page");
    await captureWindow("no-page-selected", 1440, 900);
    await captureWindow("no-page-selected", 720, 560);
    // Resizing back to the open size restores the same geometry; asserted, not captured again.
    views.window.setContentSize(1440, 900);
    await wait(300);
    const baselineRestored = geometry();
    if (baselineRestored.shellBounds.width !== 1440 || baselineRestored.pageTaskId !== null) throw Error(`baseline did not come back to full width: ${JSON.stringify(baselineRestored)}`);
    check("no-page-selected resize return 720x560 -> 1440x900", baselineRestored);

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
    if (openGeometry.shellBounds.width >= openGeometry.contentWidth) throw Error(`shell did not yield width to the page: ${JSON.stringify(openGeometry)}`);
    await captureWindow("browser-tool-open", 1440, 900);
    // Close the dock so the shell shows the task workspace next to the page at its real width.
    await click("关闭面板");
    await until((body) => !body.includes("任务页面 · 主进程窗口"), "browser panel closed");
    await captureWindow("task-page-open", 1440, 900);
    const openAtWide = JSON.parse(JSON.stringify(shots[shots.length - 1].geometry));

    // (4) Real resize with a page open: 1440x900 -> 1000x700 -> 720x560. 1000 is a strictly
    // interior width (shell 360 = floor(1000*0.36), not the 280/380 clamps), so the shot shows a
    // geometry no other shot has; 720x560 is the production minimum (runtime.ts minWidth/minHeight).
    await captureWindow("task-page-open-resized", 1000, 700);
    const interior = shots[shots.length - 1].geometry;
    if (interior.shellBounds.width !== 360 || interior.pageBounds.x !== 360 || interior.pageBounds.width !== 640) {
      throw Error(`views did not take the interior split at 1000x700: ${JSON.stringify(interior)}`);
    }
    await captureWindow("task-page-open", 720, 560);
    const minGeometry = shots[shots.length - 1].geometry;
    const minShell = minGeometry.shellBounds;
    const minPage = minGeometry.pageBounds;
    if (minShell.width <= 0 || minPage.width <= 0) throw Error(`zero-width view at minimum size: ${JSON.stringify(minGeometry)}`);
    if (minShell.x + minShell.width > minPage.x) throw Error(`shell/page overlap at minimum size: ${JSON.stringify(minGeometry)}`);
    if (minShell.x !== 0 || minPage.x !== minShell.width || minPage.width !== 720 - minShell.width) throw Error(`views do not tile the minimum window: ${JSON.stringify(minGeometry)}`);
    // Back to the open size: the round trip has to return the pre-resize geometry. Asserted (the
    // pixels would be a byte-identical copy of the 1440x900 capture above, so nothing is committed).
    views.window.setContentSize(1440, 900);
    await wait(300);
    const restoredGeometry = geometry();
    if (JSON.stringify(restoredGeometry) !== JSON.stringify(openAtWide)) throw Error(`resize round trip did not restore the wide geometry: ${JSON.stringify(restoredGeometry)} vs ${JSON.stringify(openAtWide)}`);
    check("task-page-open resize round trip 1440x900 -> 1000x700 -> 720x560 -> 1440x900", restoredGeometry);

    // (3) Multi-task selection rule: opening a second task's page makes it the visible one while
    // the first task's page stays open.
    await openPageViaGateway(TASK_B, "/b");
    await wait(300);
    const selected = geometry();
    if (selected.pageTaskId !== TASK_B || !selected.pageUrl?.endsWith("/b")) throw Error(`task B page not selected: ${JSON.stringify(selected)}`);
    await captureWindow("multi-task-page-b-selected", 1440, 900);
    await captureWindow("multi-task-page-b-selected", 720, 560);
    // A's page (still open, hidden behind B) navigates through the same gateway the Host uses. The
    // restore below must show this live page at /a2 — not a freshly loaded /a: that is what makes
    // the restore capture a state no other capture has.
    await navigatePageViaGateway(TASK_A, "/a2");
    await wait(300);
    const hidden = geometry();
    if (hidden.pageTaskId !== TASK_B) throw Error(`navigating A's hidden page changed the selected page: ${JSON.stringify(hidden)}`);
    const hiddenA = livePage(TASK_A);
    if (!hiddenA.url.endsWith("/a2")) throw Error(`A's hidden page did not navigate: ${JSON.stringify(hiddenA)}`);
    // Closing B's page restores A's still-open page (not full width).
    await closePageViaGateway(TASK_B);
    await wait(300);
    const fallback = geometry();
    if (fallback.pageTaskId !== TASK_A || !fallback.pageUrl?.endsWith("/a2")) throw Error(`closing B did not fall back to A's live page: ${JSON.stringify(fallback)}`);
    if (fallback.shellBounds.width >= fallback.contentWidth) throw Error(`shell returned to full width before the last page closed: ${JSON.stringify(fallback)}`);
    check("task A stayed open and kept its /a2 navigation while task B was selected", fallback);
    await captureWindow("multi-task-page-a-restored", 1440, 900);
    await captureWindow("multi-task-page-a-restored", 720, 560);

    // (3) Closing the last page returns the shell to full width (it keeps the selected task's
    // workspace; the *page* is gone, which is what this state asserts).
    await closePageViaGateway(TASK_A);
    await wait(300);
    const closed = geometry();
    if (closed.pageTaskId !== null) throw Error(`a page is still active after the last close: ${JSON.stringify(closed)}`);
    if (closed.shellBounds.width !== closed.contentWidth || !closed.shellVisible) throw Error(`shell not full width after last close: ${JSON.stringify(closed)}`);
    await captureWindow("last-page-closed", 1440, 900);
    await captureWindow("last-page-closed", 720, 560);

    // The bundle has to be a 1:1 inventory that discriminates every scenario: one PNG per shot,
    // pairwise distinct content, and nothing stale left in the output directory.
    const duplicates = shots.map((shot) => shot.file).filter((file, position, all) => all.indexOf(file) !== position);
    if (duplicates.length > 0) throw Error(`duplicate shot files: ${JSON.stringify(duplicates)}`);
    const byHash = new Map();
    for (const shot of shots) {
      const seen = byHash.get(shot.sha256);
      if (seen) throw Error(`shots ${seen} and ${shot.file} are byte-identical; a scenario did not change app state`);
      byHash.set(shot.sha256, shot.file);
    }
    const written = readdirSync(output).filter((entry) => entry.endsWith(".png")).sort();
    const expected = shots.map((shot) => shot.file).sort();
    if (written.length !== expected.length || written.some((entry, position) => entry !== expected[position])) {
      throw Error(`output directory does not match this run: expected ${JSON.stringify(expected)}, found ${JSON.stringify(written)}`);
    }

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
      generatedBySha256: createHash("sha256").update(readFileSync(harnessFile)).digest("hex"),
      capture: {
        method: "desktopCapturer.getSources({types:['window']}) matched by window.getMediaSourceId()",
        sourceName: captureSourceName,
        displayScaleFactor: captureDisplayScale,
        bitmap: "the window source, cropped to the window content box (getContentBounds()); the macOS title bar is not app content",
        fileBox: "file name <width>x<height> = the CSS content box asserted by setContentSize (px / pixelWidth columns below are the bitmap)",
        configuration: {
          envVariable: "PIDOCK_TASK_BROWSER_ORIGINS",
          value: origins,
          disclosure: "Set by the harness as the documented operator configuration; without it production refuses every page/open (fail-closed).",
        },
        clearedOverrides: ["PIDOCK_RENDERER_URL", "PIDOCK_TASK_URL"],
        shellEntryUrl,
      },
      seeded: {
        taskRoot: "isolated temp dir; real task.json written by the production task-store serializer",
        tasks: { [TASK_A]: "claimed to Project Adder", [TASK_B]: "claimed to Project Adder", [TASK_C]: "unassigned" },
        loopbackPages: { "/a": "task A page served by this harness on 127.0.0.1", "/a2": "the address task A navigates to while hidden behind B's page", "/b": "task B page served by this harness on 127.0.0.1" },
      },
      driven: {
        pageOpenTaskA: "real Desktop 浏览器 panel: fill 任务页面地址 + click 打开任务页面 (renderer -> shell/taskOp -> Host -> main gateway)",
        pageOpenTaskB: "main browser gateway page/open (human actor) — the Desktop exposes no control that switches task while a page covers the window",
        pageNavigateTaskA: "main browser gateway page/navigate (human actor) on A's own live page while B is the visible page (the Host's task/browserAction reaches this same gateway)",
        pageClose: "main browser gateway page/close (human actor) — the Desktop exposes no close control",
      },
      checks,
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
