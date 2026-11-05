// #156: built production Electron, real preload/IPC/Host/registry/disk; isolated fixtures only.
// Run after pnpm --filter @pidock/shell build. Each viewport is a fresh real window.
import { app, utilityProcess } from "electron";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, symlinkSync, statSync, existsSync, readdirSync } from "node:fs";
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
const output = join(repo, "docs/evidence/manual-sidebar", ...(scenario === "red" ? ["red"] : []));
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
  writeFileSync(join(output, `${width}x${height}-${scenario}-log.json`), JSON.stringify({ scenario, size: [width, height], root, sourceDiffSha256: createHash("sha256").update(execFileSync("git", ["diff", "HEAD", "--", "packages", "pnpm-lock.yaml"], { cwd: repo })).digest("hex"), source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), designSha256: hash(join(repo, "docs/design/PiDock.pen")), buildSha256: hash(join(repo, "packages/shell/dist/renderer/index.html")), node: process.versions.node, electron: process.versions.electron, sourceFiles:sourceManifest(), buildFiles:manifest(join(repo,"packages/shell/dist")), assertions, shots, calls, consoleErrors, error: error ?? null }, null, 2));
  console.log(`U01_CAPTURE ${width}x${height} ${scenario} ${code} ${error ?? "PASS"}`);
  for (const child of children) { try { child.kill(); } catch { /* already exited */ } }
  app.exit(code);
};
const manifest = (rootPath) => {
  const result = {};
  const walk = (folder) => { for (const entry of readdirSync(folder, {withFileTypes:true})) { const path=join(folder,entry.name); if(entry.isDirectory()) walk(path); else if(entry.isFile()) result[path.slice(repo.length+1)]=hash(path); } };
  walk(rootPath); return result;
};
const sourceManifest = () => Object.fromEntries([...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "packages", "package.json", "pnpm-lock.yaml", "docs/design"], {cwd:repo,encoding:"utf8"}).trim().split("\n"))].filter(path=>existsSync(join(repo,path)) && !path.includes("/dist/")).map(path=>[path,hash(join(repo,path))]));
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
  const originalDirectory = join(root, "original-directory");
  mkdirSync(originalDirectory); writeFileSync(join(originalDirectory, "keep.txt"), "original source preserved");
  const sourceStat = statSync(originalDirectory);
  const workspace = await projects.create({ name: "PiDock 核心开发 · 长名称工作空间用于核对截断与树形层级", description: "U01 真实生产导航验收", repositories: [], directories: [] });
  await projects.create({ name: "文档与脚手架", description: "空任务列表", repositories: [], directories: [] });
  {
    /** @type {Array<[string, string, boolean]>} */
    const fixtures = [["task-aaaa1111", "修复结算对账分页边界 · 超长任务名称核对截断不会挤出导航", true], ["task-bbbb2222", "升级 Electron 运行时", true], ["task-cccc3333", "临时排查本地端口占用", false]];
    for (const [taskId, name, assigned] of fixtures) {
      const taskDir = join(taskRoot, taskId);
      mkdirSync(taskDir, { recursive: true });
      execFileSync("git", ["init", "-q", taskDir]);
      symlinkSync(originalDirectory, join(taskDir, "dir-12345678"), "dir");
      writeFileSync(join(taskDir, "task.json"), serializeTaskRecord(buildTaskDiskRecord({ taskId, name, dirId: taskId, branch: "feat/reconcile-fix", root: taskRoot, taskDir, remoteBranch: "main", baseCommit: "evidence", repos: [], dirLinks: [{ linkName:"dir-12345678", directoryId:"source-dir", sourcePath:originalDirectory, snapshotAt:"2026-11-04T09:00:00.000Z", sourceDevice:String(sourceStat.dev), sourceInode:String(sourceStat.ino) }], now: "2026-11-04T09:00:00.000Z" })));
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
  {
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
    await until("document.querySelectorAll('[data-task-nav]').length === 3", "real task tree");
    await expand();
    await capture(`${theme}-tree-expanded`);
    const geometry = await evaluate(`(() => {
      const box = el => { const r=el.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height }; };
      const workspace=document.querySelector('[data-workspace-tree] .sidebar-workspace-row') ?? document.querySelector('[data-workspace-tree] > div');
      const task=document.querySelector('[data-task-nav]').parentElement;
      return { workspace:box(workspace), workspaceArrow:box(workspace.querySelector('button')), task:box(task), taskArrow:box(task.querySelector('button')), session:box(document.querySelector('[data-session-nav]')) };
    })()`);
    check("Pencil workspace row 26px", geometry.workspace.height === 26, geometry);
    check("Pencil workspace arrow x16 and 12px", geometry.workspaceArrow.x === (width < 960 ? 12 : 16) && geometry.workspaceArrow.width === 12, geometry);
    check("Pencil task arrow x32 and 10px", geometry.taskArrow.x === (width < 960 ? 28 : 32) && geometry.taskArrow.width === 10, geometry);
    check("Pencil session indent x42", geometry.session.x === (width < 960 ? 38 : 42), geometry);
    const taskId = "task-aaaa1111";
    const getList = async () => (await registry.routeTaskOp({ taskId, op: "task/sessionList", payload: {}, origin })).payload;
    const listBefore = await getList();
    const selectedId = listBefore.sessions.find(row => row.id !== "main").id;
    const menu = async (selector, keyboard = false) => {
      await expandIfNeeded();
      await until(`document.querySelector(${JSON.stringify(selector)})`, "menu row");
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
      if (keyboard) { wc.sendInputEvent({type:"keyDown",keyCode:"F10",modifiers:["shift"]}); wc.sendInputEvent({type:"keyUp",keyCode:"F10",modifiers:["shift"]}); }
      else {
        const point = await evaluate(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.x+12),y:Math.round(r.y+12)}; })()`);
        wc.sendInputEvent({type:"mouseDown",button:"right",clickCount:1,...point}); wc.sendInputEvent({type:"mouseUp",button:"right",clickCount:1,...point});
      }
      await until("document.querySelector('[role=menu]')", "context menu");
      if (keyboard) await until("document.activeElement?.getAttribute('role') === 'menuitem'", "keyboard menu entry focus");
    };
    const expandIfNeeded = async () => { if (width < 960 && !(await evaluate("document.querySelector('[data-testid=desktop-sidebar]')?.dataset.expanded === 'true'"))) await expand(); };
    const choose = async (text) => {
      await evaluate(`(() => { const el=[...document.querySelectorAll('[role=menuitem]')].find(el => el.textContent === ${JSON.stringify(text)}); if(!el) throw Error('menu action absent'); el.click(); })()`);
      await wait(120);
    };
    const row = `[data-session-nav="${selectedId}"]`;
    const startCalls = calls.length;
    await menu(row, true);
    check(`${theme}: keyboard menu does not select or mutate`, !(await evaluate("document.querySelector('[aria-label=消息]')")) && calls.slice(startCalls).every(call => /sessionList/.test(call.op)), calls.slice(startCalls));
    await capture(`${theme}-session-menu-expanded`);
    wc.sendInputEvent({ type: "keyDown", keyCode: "Escape" }); wc.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await until("!document.querySelector('[role=menu]')", "Escape menu dismissal");
    check(`${theme}: menu returns row focus`, await evaluate(`document.activeElement?.getAttribute('data-session-nav') === '${selectedId}'`));
    await menu(row, true);
    wc.sendInputEvent({type:"keyDown",keyCode:"Down"}); wc.sendInputEvent({type:"keyUp",keyCode:"Down"});
    await until("document.activeElement?.textContent === '重命名'", "native ArrowDown selects rename");
    wc.sendInputEvent({type:"keyDown",keyCode:"Return"}); wc.sendInputEvent({type:"keyUp",keyCode:"Return"});
    await until("document.querySelector('[aria-label=会话名称]')", "rename opens existing lifecycle surface");
    const renamed = `侧栏重命名 ${theme}`;
    await evaluate(`(() => { const el=document.querySelector('[aria-label=会话名称]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(renamed)}); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await click("保存");
    await until(`document.querySelector(${JSON.stringify(row)})?.textContent.includes(${JSON.stringify(renamed)})`, "rename persisted tree refresh");
    check(`${theme}: stable identity exact rename`, (await getList()).sessions.find(row=>row.id===selectedId)?.name === renamed);
    await click("关闭会话列表");
    await capture(`${theme}-selected-expanded`);
    const selectedGeometry = await evaluate(`(() => {const task=document.querySelector('[data-tree-task-row][data-selected=true]');const session=document.querySelector('[data-session-nav][data-selected=true]');return { taskHeight:task?.getBoundingClientRect().height, sessionHeight:session?.getBoundingClientRect().height, taskColor:getComputedStyle(task).backgroundColor, taskFont:getComputedStyle(task.querySelector('[data-task-nav]')).fontSize, sessionFont:getComputedStyle(session).fontSize };})()`);
    check(`${theme}: selected Pencil row density and typography`, selectedGeometry.taskHeight === 26 && selectedGeometry.sessionHeight === 24 && selectedGeometry.taskFont === '11px' && selectedGeometry.sessionFont === '11px', selectedGeometry);
    await click("收起任务 修复结算对账分页边界 · 超长任务名称核对截断不会挤出导航");
    check(`${theme}: collapse only hides sessions`, !(await evaluate(`document.querySelector(${JSON.stringify(row)})`)));
    await capture(`${theme}-task-collapsed-expanded`);
    await click("展开任务 修复结算对账分页边界 · 超长任务名称核对截断不会挤出导航");
    await until("document.querySelector('[aria-label=消息]')", "real composer before lifecycle");
    await evaluate(`(() => { const el=document.querySelector('[aria-label=消息]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'sidebar lifecycle draft'); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await wait(700);
    const draft = await registry.routeTaskOp({taskId,op:"task/readDraft",payload:{sessionId:selectedId},origin});
    check(`${theme}: draft is persisted for exact selected session`, /** @type {{draft?:{text?:string}}} */(draft.payload)?.draft?.text === "sidebar lifecycle draft", draft);
    await menu(row);
    await choose("归档");
    await until(`!document.querySelector(${JSON.stringify(row)})`, "archive hides active row");
    check(`${theme}: archive persisted once`, (await getList()).sessions.find(row=>row.id===selectedId)?.archived && calls.slice(startCalls).filter(call=>call.op==='task/sessionArchive').length===1);
    await click("显示已归档会话");
    await menu(row, true);
    await capture(`${theme}-archived-menu-expanded`);
    await choose("恢复");
    await until(`!document.querySelector(${JSON.stringify(row)})?.textContent.includes('已归档')`, "restored tree row");
    check(`${theme}: restore same identity no replay`, !(await getList()).sessions.find(row=>row.id===selectedId)?.archived);
    await menu(row);
    await choose("永久删除…");
    await until("document.querySelector('[data-testid=session-delete-confirm]')", "permanent delete confirmation");
    check(`${theme}: deletion impact describes drafts and original directories`, await evaluate("document.querySelector('[data-testid=session-delete-confirm]').textContent.includes('未发送草稿') && document.querySelector('[data-testid=session-delete-confirm]').textContent.includes('用户原始目录')"));
    check(`${theme}: cancel receives focus`, await evaluate("document.activeElement?.textContent === '取消'"), await evaluate("({ tag:document.activeElement?.tagName, label:document.activeElement?.getAttribute('aria-label'), text:document.activeElement?.textContent?.slice(0,80) })"));
    await capture(`${theme}-delete-confirm-expanded`);
    await click("取消");
    check(`${theme}: cancel preserves actual Host session`, (await getList()).sessions.some(row=>row.id===selectedId) && !calls.slice(startCalls).some(call=>call.op==='task/sessionDelete'));
    await menu(row);
    await choose("永久删除…");
    await until("document.querySelector('[data-testid=session-delete-confirm-button]')", "confirmed delete reachable");
    await click("确认删除");
    await until(`!document.querySelector(${JSON.stringify(row)})`, "deleted row removed");
    check(`${theme}: delete persisted exactly once`, !(await getList()).sessions.some(row=>row.id===selectedId) && calls.slice(startCalls).filter(call=>call.op==='task/sessionDelete').length===1);
    check(`${theme}: no model/tool requests by sidebar lifecycle`, !calls.slice(startCalls).some(call=>/sdkStart|sendMessage|toolReplay|execute/.test(call.op)));
    check(`${theme}: task directory and Git survive session deletion`, readFileSync(join(taskRoot, taskId, 'task.json'), 'utf8').includes(taskId) && Boolean(execFileSync('git',['-C',join(taskRoot,taskId),'rev-parse','--git-dir'],{encoding:'utf8'}).trim()));
    await wc.reload();
    await until("document.querySelector('[data-testid=desktop-project-overview]')", "cold renderer reload");
    await expandIfNeeded();
    check(`${theme}: reload sees authoritative deletion`, !(await getList()).sessions.some(row=>row.id===selectedId) && !(await evaluate(`document.querySelector(${JSON.stringify(row)})`)));
    check(`${theme}: original shared source and task link survive`, readFileSync(join(originalDirectory,"keep.txt"),"utf8")==="original source preserved" && existsSync(join(taskRoot,taskId,"dir-12345678","keep.txt")));
    // Exercise workspace actions through the real guarded surfaces.
    const workspaceRow = `[data-workspace-tree="${workspace.id}"] [data-row-select]`;
    for (const action of ["编辑工作空间…", "在此新建任务…"]) {
      await menu(workspaceRow, true); await choose(action);
      await until("document.querySelector('[role=dialog]')", `workspace action ${action}`);
      await capture(`${theme}-${action.startsWith("编辑") ? "workspace-edit" : "workspace-new-task"}-expanded`);
      await click("取消");
    }
    await menu(workspaceRow); await choose("移除工作空间…");
    await until("document.querySelector('[role=dialog]')", "workspace membership safeguards");
    check(`${theme}: workspace removal names bound tasks`, await evaluate("document.querySelector('[role=dialog]').textContent.includes('修复结算对账')"));
    await click("取消");
    await menu('[data-task-nav="task-aaaa1111"]', true);
    check(`${theme}: unsupported task rename has explicit reason`, await evaluate("[...document.querySelectorAll('[role=menuitem]')].some(el=>el.textContent.includes('当前任务接口不支持重命名') && el.getAttribute('aria-disabled')==='true')"));
    await choose("收尾清理…");
    await until("document.querySelector('[role=dialog]')", "guarded cleanup prompt");
    check(`${theme}: task cleanup keeps separate guarded flow`, await evaluate("document.querySelector('[role=dialog]').textContent.includes('先核验安全范围')"));
    await capture(`${theme}-task-cleanup-expanded`);
    await click("取消");
    await menu('[data-task-nav="task-aaaa1111"]');
    wc.sendInputEvent({type:"mouseDown",button:"left",clickCount:1,x:width-20,y:24}); wc.sendInputEvent({type:"mouseUp",button:"left",clickCount:1,x:width-20,y:24});
    await until("!document.querySelector('[role=menu]')", "outside pointer dismissal");
    check(`${theme}: outside click closes context menu`, !(await evaluate("document.querySelector('[role=menu]')")));
    // Seed only the next theme's isolated session; never a model request.
    if (theme === "light") await registry.routeTaskOp({ taskId, op:"task/sessionCreate", payload:{name:"边界复查 · 会话长名称验证"}, origin });
    check(`${theme}: zero renderer console errors`, consoleErrors.length===0, consoleErrors);

  }
  if (scenario === "failed") {
    check("real corrupted registry has recovery", await evaluate("[...document.querySelectorAll('button')].some(el=>el.textContent.includes('从备份恢复'))"));
    // The explicit confirmation/recovery write is covered by public renderer and Host tests.
  }
  const shutdown = await shutdownTestRegistry(registry, { origin, label: "U01 capture complete" });
  check("Host shutdown confirmed", shutdown.length === 0, shutdown);
  const { TaskWorkspaceHost, diskTaskStore } = await import("../dist/host/task-host.js");
  const reopened = new TaskWorkspaceHost("task-aaaa1111", join(taskRoot,"task-aaaa1111"), diskTaskStore);
  const coldList = reopened.sessionIndex();
  check("cold Host reads persisted deletion, no session resurrection", coldList.sessions.length === 1 && coldList.sessions[0].id === "main", coldList);
  check("cold Host preserves original linked source", readFileSync(join(originalDirectory,"keep.txt"),"utf8")==="original source preserved");
  finish(0);
}
run().catch((error) => finish(1, error.stack));
