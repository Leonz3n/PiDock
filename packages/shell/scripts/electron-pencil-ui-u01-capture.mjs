// #156: built production Electron, real preload/IPC/Host/registry/disk; isolated fixtures only.
// Run after pnpm --filter @pidock/shell build. Each viewport is a fresh real window.
import { app, utilityProcess } from "electron";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createUnavailableHostClient } from "./unavailable-host-client.mjs";
import { shutdownTestRegistry } from "./shutdown-test-registry.mjs";

delete process.env.PIDOCK_RENDERER_URL;
delete process.env.PIDOCK_TASK_URL;
const arg = (key, fallback) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
const [width, height] = arg("--size", "1440x900").split("x").map(Number);
const scenario = arg("--scenario", "full");
const repo = resolve(import.meta.dirname, "../../..");
const output = join(repo, "docs/evidence/pencil-ui-u01", ...(scenario === "navigation" ? ["fix1"] : []));
const root = mkdtempSync(join(tmpdir(), "pidock-ui-u01-"));
const profile = join(root, "profile");
const taskRoot = join(root, "tasks");
const agentDir = join(root, "agent");
for (const path of [profile, taskRoot, agentDir, output]) mkdirSync(path, { recursive: true });
app.setPath("userData", profile);
process.env.PIDOCK_AGENT_DIR = agentDir;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const assertions = [], shots = [], calls = [], consoleErrors = [];
let views, registry;
const children = [];
/** @param {string} name @param {unknown} condition @param {unknown} detail */
const check = (name, condition, detail = "") => { assertions.push({ name, passed: Boolean(condition), detail }); if (!condition) throw Error(`ASSERT FAILED: ${name}: ${JSON.stringify(detail)}`); };
let exiting = false;
const finish = (code, error) => {
  if (exiting) return; exiting = true;
  writeFileSync(join(output, `${width}x${height}-${scenario}-log.json`), JSON.stringify({ scenario, size: [width, height], root, sourceDiffSha256: createHash("sha256").update(execFileSync("git", ["diff", "HEAD", "--", "packages/renderer/src", "packages/shell/scripts/electron-pencil-ui-u01-capture.mjs"], { cwd: repo })).digest("hex"), source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), designSha256: hash(join(repo, "docs/design/PiDock.pen")), buildSha256: hash(join(repo, "packages/shell/dist/renderer/index.html")), node: process.versions.node, electron: process.versions.electron, assertions, shots, calls, consoleErrors, error: error ?? null }, null, 2));
  console.log(`U01_CAPTURE ${width}x${height} ${scenario} ${code} ${error ?? "PASS"}`);
  for (const child of children) { try { child.kill(); } catch { /* already exited */ } }
  app.exit(code);
};
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
setTimeout(() => finish(1, "watchdog timeout"), 180000).unref();
process.on("uncaughtException", (error) => finish(1, error.stack));
process.on("unhandledRejection", (error) => finish(1, String(error instanceof Error ? error.stack : error)));
app.on("window-all-closed", () => {});

async function run() {
  const { buildTaskDiskRecord, serializeTaskRecord } = await import("../dist/host/task-store.js");
  const { buildHostEnv } = await import("../dist/host/host-guards.js");
  const { TaskRootIndex } = await import("../dist/main/task-root-index.js");
  const { ProjectRegistry } = await import("../dist/main/project-registry.js");
  const { ServiceCatalog, serviceCatalogAuthority } = await import("../dist/main/service-catalog.js");
  const { createTrustedWindow, loadTrustedViews, PerTaskHostRegistry, registerIpc } = await import("../dist/main/runtime.js");
  const { CreationIntentStore, ProjectTaskCreation } = await import("../dist/main/project-task-creation.js");
  const { ProviderProfileStore } = await import("../dist/main/provider-profile-store.js");
  const { ProviderWiring } = await import("../dist/main/provider-ipc.js");
  const { HostClient } = await import("../dist/rpc/host-client.js");
  await app.whenReady();
  const index = new TaskRootIndex(profile, taskRoot);
  const projects = new ProjectRegistry(profile);
  const workspace = await projects.create({ name: "PiDock 核心开发 · 长名称工作空间用于核对截断与树形层级", description: "U01 真实生产导航验收", repositories: [], directories: [] });
  await projects.create({ name: "文档与脚手架", description: "空任务列表", repositories: [], directories: [] });
  if (scenario === "full" || scenario === "navigation") {
    /** @type {Array<[string, string, boolean]>} */
    const fixtures = [["task-aaaa1111", "修复结算对账分页边界 · 超长任务名称核对截断不会挤出导航", true], ["task-bbbb2222", "升级 Electron 运行时", true], ["task-cccc3333", "临时排查本地端口占用", false]];
    for (const [taskId, name, assigned] of fixtures) {
      const taskDir = join(taskRoot, taskId);
      mkdirSync(taskDir, { recursive: true });
      execFileSync("git", ["init", "-q", taskDir]);
      writeFileSync(join(taskDir, "task.json"), serializeTaskRecord(buildTaskDiskRecord({ taskId, name, dirId: taskId, branch: "feat/reconcile-fix", root: taskRoot, taskDir, remoteBranch: "main", baseCommit: "evidence", repos: [], now: "2026-11-04T09:00:00.000Z" })));
      if (assigned) await projects.claim(taskId, workspace.id, index);
    }
  }
  views = await createTrustedWindow("pencil-ui-u01", "production");
  views.window.setContentSize(width, height);
  registry = new PerTaskHostRegistry("pencil-ui-u01", async (workspaceId, task) => {
    const child = utilityProcess.fork(join(import.meta.dirname, "../dist/host/host-entry.js"), [], { serviceName: "pencil-ui-u01-host", env: buildHostEnv(process.env, workspaceId, task, profile), stdio: "pipe" });
    children.push(child);
    child.stderr?.on("data", (data) => process.stderr.write(data));
    return { child, client: new HostClient(child) };
  }, (id) => index.resolve(id), undefined, index);
  const route = registry.routeTaskOp.bind(registry);
  registry.routeTaskOp = (request) => { calls.push({ op: request.op, taskId: request.taskId, payload: request.payload }); return route(request); };
  const providerProfiles = new ProviderProfileStore(profile);
  const providers = new ProviderWiring(providerProfiles, async (taskId, provider, senderWebContentsId) => {
    await registry.routeTaskOp({ taskId, op: "task/sdkProvider", payload: provider === null ? { provider: null } : { provider: { config: providerProfiles.config(provider.profileId), credential: provider.credential } }, origin: { kind: "shell-ui", senderWebContentsId } });
  });
  const creation = new ProjectTaskCreation(new CreationIntentStore(profile), projects, index, registry, taskRoot);
  const catalog = new ServiceCatalog(profile, serviceCatalogAuthority(index, projects));
  registerIpc(createUnavailableHostClient(), views.registry, registry, projects, index, undefined, creation, providers, catalog);
  const origin = { kind: /** @type {const} */ ("shell-ui"), senderWebContentsId: views.shellView.webContents.id };
  if (scenario === "full" || scenario === "navigation") {
    const created = await registry.routeTaskOp({ taskId: "task-aaaa1111", op: "task/sessionCreate", payload: { name: "边界复查 · 会话长名称验证", permission: "default" }, origin });
    check("real Host creates the seeded second session", Boolean(created.payload?.session), created);
  }
  if (scenario === "failed") writeFileSync(join(profile, "projects.json"), "{broken-registry");
  await loadTrustedViews(views);
  const wc = views.shellView.webContents;
  wc.on("console-message", (_event, level, message) => { if (level >= 3) consoleErrors.push(message); });
  wc.debugger.attach();
  const evaluate = async (expression) => {
    const result = await wc.debugger.sendCommand("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async (expression, label) => {
    for (let attempt = 0; attempt < 200; attempt++) { if (await evaluate(`Boolean(${expression})`)) return; await wait(50); }
    throw Error(`timeout ${label}: ${await evaluate("document.body.innerText")}`);
  };
  const click = async (label) => {
    check(`control reachable: ${label}`, await evaluate(`(() => { const el = [...document.querySelectorAll('button')].find(el => (el.getAttribute('aria-label') ?? el.textContent.trim()) === ${JSON.stringify(label)} && el.getBoundingClientRect().width > 0 && !el.closest('[hidden]')); if (!el) return false; el.click(); return true; })()`));
    await wait(100);
  };
  const escape = () => evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  const expand = async () => { if (width < 960) await click("展开导航"); };
  const capture = async (state) => {
    views.window.show(); app.focus({ steal: true }); views.window.moveTop(); views.window.focus(); await wait(180);
    const metrics = await evaluate(`(() => {
      const box = el => { if (!el || !el.getBoundingClientRect().width) return null; const r = el.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height }; };
      const management = document.querySelector('.management-window');
      return { viewport: [innerWidth, innerHeight], theme: document.documentElement.dataset.theme, sidebar:box(document.querySelector('[data-testid=desktop-sidebar]')), header:box(document.querySelector('[data-testid=desktop-breadcrumb]')), managementNav:box(management?.querySelector('nav')), managementHeader:box(management?.querySelector('[data-testid=management-header]')), managementHeaders:management?.querySelectorAll('header').length ?? 0, summary: Boolean(document.querySelector('[data-testid=desktop-summary]')), overflow:document.documentElement.scrollWidth > innerWidth, names:[...document.querySelectorAll('[data-task-nav], [data-session-nav]')].map(el => ({name:el.textContent.trim(), width:el.getBoundingClientRect().width, scroll:el.scrollWidth})), colors: { canvas:getComputedStyle(document.body).backgroundColor, ink:getComputedStyle(document.body).color } };
    })()`);
    check(`${state}: exact renderer viewport`, metrics.viewport[0] === width && metrics.viewport[1] === height, metrics.viewport);
    check(`${state}: no horizontal document overflow`, !metrics.overflow);
    check(`${state}: no old summary`, !metrics.summary);
    if (metrics.sidebar) {
      check(`${state}: Pencil navigation width`, Math.abs(metrics.sidebar.width - (width < 960 && !state.includes("expanded") ? 48 : 260)) <= 2, metrics.sidebar);
      check(`${state}: Pencil workspace header`, Math.abs(metrics.header.height - (width < 960 ? 42 : 52)) <= 2, metrics.header);
    }
    if (metrics.managementNav) {
      check(`${state}: management replaces workspace navigation`, metrics.sidebar === null && metrics.header === null);
      check(`${state}: dedicated navigation starts at window top`, metrics.managementNav.y === 0 && metrics.managementNav.height === height && metrics.managementNav.width === 240, metrics.managementNav);
      check(`${state}: one 52px management header`, metrics.managementHeaders === 1 && metrics.managementHeader.y === 0 && Math.abs(metrics.managementHeader.height - 52) <= 2, metrics);
    }
    const name = `${width}x${height}-${state}.png`;
    const shot = await wc.debugger.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(join(output, name), Buffer.from(shot.data, "base64"));
    shots.push({ file: name, sha256: hash(join(output, name)), metrics });
  };
  check("production built file renderer", /^file:.*\/renderer\/index.html$/.test(await evaluate("location.href")));
  await until(scenario === "failed" ? "document.querySelector('[role=alert]')" : "document.querySelector('[data-testid=desktop-project-overview]')", "initial data");
  for (const theme of ["light", "dark"]) {
    // Select theme through the real settings control. Failed registry still has real preferences IPC.
    await evaluate(`window.pidock.preferencesOp({ op: 'appearance/save', appearance: '${theme}' })`);
    await wc.reload();
    await until(`document.documentElement?.dataset.theme === '${theme}' && document.querySelector('${scenario === "failed" ? "[role=alert]" : "[data-testid=desktop-project-overview]"}')`, "theme hydration");
    if (scenario === "navigation") {
      await until("document.querySelectorAll('[data-task-nav]').length === 3", "real task tree");
      const before = await registry.routeTaskOp({ taskId: "task-aaaa1111", op: "task/sessionList", payload: {}, origin });
      const mutationStart = calls.length;
      for (const [label, selector] of [
        ["定时任务", "[data-testid=desktop-schedules-page]"],
        ["已归档", "[data-testid=desktop-archive-page]"],
        ["需要处理", "[data-testid=desktop-attention-page]"],
        ["环境与服务", "[data-testid=desktop-environment-page]"],
        ["Token 用量", "[data-testid=desktop-usage-page]"],
        ["PiDock 核心开发 · 长名称工作空间用于核对截断与树形层级", "[data-testid=desktop-project-overview]"],
        ["未归属任务", "[data-testid=desktop-unassigned]"],
        ["修复结算对账分页边界 · 超长任务名称核对截断不会挤出导航", "[data-testid=desktop-task-facts]"],
        ["边界复查 · 会话长名称验证", "[aria-label=消息]"],
        ["能力管理", ".management-window"],
        ["设置", ".management-window"],
      ]) {
        if (width < 960 && !(await evaluate("document.querySelector('[data-testid=desktop-sidebar]')?.dataset.expanded === 'true'"))) await expand();
        if (["需要处理", "环境与服务", "Token 用量"].includes(label) && !(await evaluate("document.querySelector('[data-nav-destination=more]')?.getAttribute('aria-expanded') === 'true'"))) await click("更多");
        await click(label);
        await until(`document.querySelector(${JSON.stringify(selector)})`, `destination ${label}`);
        if (selector === ".management-window") {
          await click("返回任务工作区");
          await until("document.querySelector('[data-testid=desktop-sidebar]')", "management return before creation");
        }
        await click("新建任务");
        await until("document.querySelector('[role=dialog][aria-label=新建任务]')", `New Task from ${label}`);
        check(`${theme}: ${label} opens the production creation dialog`, await evaluate("Boolean(document.querySelector('[data-testid=desktop-inventory]') && document.querySelector('[role=dialog] input'))"));
        if (label === "定时任务") await capture(`${theme}-new-task-schedules`);
        await click("取消");
        await until("!document.querySelector('[role=dialog]')", `cancel creation from ${label}`);
      }
      const after = await registry.routeTaskOp({ taskId: "task-aaaa1111", op: "task/sessionList", payload: {}, origin });
      check(`${theme}: navigation/creation entry preserves real Host sessions`, JSON.stringify(before.payload.sessions) === JSON.stringify(after.payload.sessions) && before.payload.activeSessionId === after.payload.activeSessionId);
      check(`${theme}: navigation/creation entry sends no model/tool/session writes`, !calls.slice(mutationStart).some(call => /sessionCreate|sendMessage|execute|toolReplay/.test(call.op)), calls.slice(mutationStart).map(call => call.op));
      check(`${theme}: no renderer console errors`, consoleErrors.length === 0, consoleErrors);
      continue;
    }
    if (scenario !== "full") { await capture(`${theme}-${scenario}`); continue; }
    await until("document.querySelectorAll('[data-task-nav]').length === 3", "real task tree");
    await capture(`${theme}-navigation`);
    await expand();
    await capture(`${theme}-navigation-expanded`);
    await click("文档与脚手架");
    await until("document.querySelector('[data-testid=desktop-project-overview]')?.textContent.includes('文档与脚手架')", "workspace selection");
    check("workspace navigation selects the actual registry workspace", await evaluate("document.querySelector('[data-testid=overview-title]')?.textContent === '文档与脚手架'"));
    await click("未归属任务");
    await until("document.querySelector('[data-testid=desktop-unassigned]')", "unassigned tasks");
    check("unassigned navigation retains the actual unassigned task", await evaluate("document.querySelector('[data-testid=desktop-unassigned]')?.textContent.includes('临时排查本地端口占用')"));
    await expand();
    await click("PiDock 核心开发 · 长名称工作空间用于核对截断与树形层级");
    await until("document.querySelector('[data-testid=desktop-project-overview]')", "return to workspace");
    // Search a real session name, then select it. Native input events drive React's public DOM seam.
    await evaluate(`(() => { const input=document.querySelector('[aria-label="过滤任务与会话"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'边界复查'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await until("document.querySelectorAll('[data-task-nav]').length === 1", "session-name filtering");
    const sessionId = await evaluate("document.querySelector('[data-session-nav]')?.getAttribute('data-session-nav')");
    check("search is a real Host session", Boolean(sessionId));
    await click("边界复查 · 会话长名称验证");
    await until("document.querySelector('[aria-label=消息]')", "selected conversation");
    await evaluate(`(() => { const input=document.querySelector('[aria-label=消息]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'U01 草稿 · 布局切换不发送'); input.dispatchEvent(new Event('input',{bubbles:true})); input.dataset.u01identity='retained'; })()`);
    await wait(700);
    check("tree selection subscribes to the selected real session", calls.some((call) => call.op === "task/sdkProjection" && call.payload?.sessionId === sessionId));
    const before = await registry.routeTaskOp({ taskId: "task-aaaa1111", op: "task/sessionList", payload: {}, origin });
    const mutationStart = calls.length;
    for (const page of ["能力管理", "设置"]) {
      await click(page);
      await until("document.querySelector('.management-window')", "management open");
      await capture(`${theme}-${page === "设置" ? "settings" : "capabilities"}`);
      if (page === "能力管理") await escape();
      else await click("返回任务工作区");
      await until("document.querySelector('[data-testid=desktop-sidebar]')", "management return");
      const draft = await evaluate("({ text:document.querySelector('[aria-label=消息]')?.value, identity:document.querySelector('[aria-label=消息]')?.dataset.u01identity })");
      check(`${page}: return retains exact composer and draft`, draft.identity === "retained" && draft.text === "U01 草稿 · 布局切换不发送", draft);
      await expand();
    }
    const after = await registry.routeTaskOp({ taskId: "task-aaaa1111", op: "task/sessionList", payload: {}, origin });
    check("layout switch retains session identity/count", JSON.stringify({ active: before.payload.activeSessionId, sessions: before.payload.sessions }) === JSON.stringify({ active: after.payload.activeSessionId, sessions: after.payload.sessions }));
    check("layout switch creates no sessions or model/tool requests", calls.slice(mutationStart).every((call) => call.op === "task/sessionList"), calls.slice(mutationStart).map((call) => call.op));
    await capture(`${theme}-returned-expanded`);
    if (width < 960) await click("收起导航");
    await click("新建任务");
    await until("document.querySelector('[role=dialog]')", "new task entry");
    check("new task uses production creation UI", await evaluate("Boolean(document.querySelector('[data-testid=desktop-inventory]'))"));
  }
  if (scenario === "failed") {
    check("real corrupted registry has recovery", await evaluate("[...document.querySelectorAll('button')].some(el=>el.textContent.includes('从备份恢复'))"));
    // The explicit confirmation/recovery write is covered by public renderer and Host tests.
  }
  const shutdown = await shutdownTestRegistry(registry, { origin, label: "U01 capture complete" });
  check("Host shutdown confirmed", shutdown.length === 0, shutdown);
  finish(0);
}
run().catch((error) => finish(1, error.stack));
