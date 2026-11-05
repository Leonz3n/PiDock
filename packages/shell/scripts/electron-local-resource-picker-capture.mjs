// #165: actual built App / trusted preload / main / registry and native-config stores.
// Dialog results are deterministic fixtures except --physical (a real OS cancel).
import { app, dialog, utilityProcess } from "electron";
import { execFileSync, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, readdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { shutdownTestRegistry } from "./shutdown-test-registry.mjs";
import { createUnavailableHostClient } from "./unavailable-host-client.mjs";
const repo = resolve(import.meta.dirname, "../../..");
const arg = (key, fallback) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
const [width, height] = arg("--size", "1440x900").split("x").map(Number);
const output = resolve(arg("--output", "/tmp/pidock-manual-validation/picker-electron"));
const physical = process.argv.includes("--physical");
const root = realpathSync(mkdtempSync(join(tmpdir(), "pidock-picker-electron-")));
const profile = join(root, "profile"), agentDir = join(root, "agent"), taskRoot = join(root, "tasks");
for (const dir of [profile, agentDir, taskRoot, output]) mkdirSync(dir, { recursive: true });
app.setPath("userData", profile);
process.env.PIDOCK_AGENT_DIR = agentDir;
delete process.env.PIDOCK_RENDERER_URL; delete process.env.PIDOCK_TASK_URL;
const assertions = [], shots = [], dialogs = [], consoleErrors = [];
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const wait = ms => new Promise(done => setTimeout(done, ms));
/** @param {string} name @param {unknown} passed @param {unknown} detail */
const check = (name, passed, detail = "") => { assertions.push({ name, passed: !!passed, detail }); console.log(name, !!passed); if (!passed) throw Error(name); };
const children = [];
let finishing = false;
const finish = (code, error = null) => {
  if (finishing) return; finishing = true;
  const under = path => readdirSync(join(repo, path), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? under(`${path}/${entry.name}`) : [`${path}/${entry.name}`]);
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "packages/renderer/src", "packages/shell/src", "packages/shell/scripts/electron-local-resource-picker-capture.mjs", "pnpm-lock.yaml", "docs/design/PiDock.pen"], { cwd: repo, encoding: "utf8" }).trim().split("\n");
  const manifest = paths => Object.fromEntries([...new Set(paths)].sort().map(path => [path, hash(join(repo, path))]));
  const prefix = `${width}x${height}${physical ? "-physical" : ""}`;
  writeFileSync(join(output, `${prefix}-identity.json`), JSON.stringify({ source: manifest(paths), build: manifest(under("packages/shell/dist")) }, null, 2));
  writeFileSync(join(output, `${prefix}-result.json`), JSON.stringify({ code, error, source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), root, size: [width, height], physical, versions: process.versions, assertions, shots, dialogs, consoleErrors }, null, 2));
  for (const child of children) { try { child.kill(); } catch { /* already released */ } }
  app.exit(code);
};
setTimeout(() => finish(1, "watchdog timeout"), 120000).unref();
process.on("uncaughtException", error => finish(1, String(error.stack)));
process.on("unhandledRejection", error => finish(1, String(error instanceof Error ? error.stack : error)));
app.on("window-all-closed", () => {});
async function run() {
  await app.whenReady();
  const { TaskRootIndex } = await import("../dist/main/task-root-index.js");
  const { ProjectRegistry } = await import("../dist/main/project-registry.js");
  const { createTrustedWindow, loadTrustedViews, registerIpc, PerTaskHostRegistry } = await import("../dist/main/runtime.js");
  const { buildHostEnv } = await import("../dist/host/host-guards.js");
  const { HostClient } = await import("../dist/rpc/host-client.js");
  const { CreationIntentStore, ProjectTaskCreation } = await import("../dist/main/project-task-creation.js");
  const { ServiceCatalog, serviceCatalogAuthority } = await import("../dist/main/service-catalog.js");
  const { NativeMcpFile } = await import("../dist/main/native-mcp-config.js");
  const { McpWiring } = await import("../dist/main/mcp-ipc.js");
  const index = new TaskRootIndex(profile, taskRoot), projects = new ProjectRegistry(profile);
  const directory = join(root, "资料 space"), source = join(root, "Git source");
  mkdirSync(directory); mkdirSync(source);
  writeFileSync(join(directory, "original.txt"), "original source survives all selection and cancellation\n");
  const originalHash = hash(join(directory, "original.txt"));
  execFileSync("git", ["init", "-q", "-b", "main", source]);
  writeFileSync(join(source, "README.md"), "fixture Git source\n");
  execFileSync("git", ["add", "."], {cwd:source});
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], {cwd:source});
  const remote = join(root,"remote.git");
  execFileSync("git", ["clone","-q","--bare",source,remote]);
  execFileSync("git", ["remote","add","origin",remote], {cwd:source});
  const skills = join(root, "技能 space"); mkdirSync(join(skills, "fixture"), { recursive: true });
  writeFileSync(join(skills, "fixture", "SKILL.md"), "---\nname: picker-fixture\ndescription: A selectable fixture.\n---\nNo execution.\n");
  const workspace = await projects.create({ name: "选择器验证", description: "", repositories: [{name:"fixture-git",path:source}], directories: [{ name: "original-name", path: directory }], environment: [], branchTemplate: "feature/{task-name}" });
  const views = await createTrustedWindow("manual-pickers", "production");
  views.window.setContentSize(width, height);
  const registry = new PerTaskHostRegistry("manual-pickers", async (workspaceId, task, variables) => {
    const child=utilityProcess.fork(join(import.meta.dirname,"../dist/host/host-entry.js"),[], {serviceName:"picker-host",env:buildHostEnv(process.env,workspaceId,task,profile,undefined,process.platform,variables),stdio:"pipe"});
    children.push(child); return {child,client:new HostClient(child)};
  }, id=>index.resolve(id),undefined,index);
  const catalog = new ServiceCatalog(profile,serviceCatalogAuthority(index,projects));
  const creation = new ProjectTaskCreation(new CreationIntentStore(profile),projects,index,registry,taskRoot);
  registerIpc(createUnavailableHostClient(), views.registry, registry, projects, index, undefined, creation, undefined, catalog, undefined, undefined, undefined, undefined, new McpWiring(new NativeMcpFile(agentDir), process.env));
  creation.saveDeliverySettings({branchTemplate:"task/{taskId}",remote:"origin"});
  const intent=await creation.prepare({projectId:workspace.id,name:"选择器绑定任务",repositories:[{sourceId:workspace.repositories[0].id,remote:"origin",remoteBranch:"main"}],directoryIds:[],sharedWriteConfirmed:false,override:false});
  await creation.commit(intent.id);
  const environment=catalog.createEnvironment({projectId:workspace.id,name:"Fixture environment"});
  catalog.saveTemplate({projectId:workspace.id,environmentId:environment.environmentId,descriptor:{name:"Fixture service",program:"node",args:[],ports:[],runType:"long-lived"},shared:[]});
  const worktree=join(intent.taskDir,intent.repos[0].repoDir);
  const childDirectory=join(worktree,"资料 space"); mkdirSync(childDirectory);
  const origin={kind:/** @type {const} */("shell-ui"),senderWebContentsId:views.shellView.webContents.id};
  let next = { canceled: true, filePaths: [] }, throwNext = false;
  const nativeDialog = dialog.showOpenDialog.bind(dialog);
  dialog.showOpenDialog = async (...args) => {
    const options = args[args.length - 1];
    dialogs.push({ parented: args.length === 2, options, physical });
    if (physical) {
      setTimeout(() => execFile("osascript", ["-e", 'tell application "System Events" to key code 53'], error => { if (error) finish(1, "physical cancel automation unavailable"); }), 700);
      return nativeDialog(...args);
    }
    if (throwNext) { throwNext = false; throw Error("fixture dialog failure"); }
    return next;
  };
  await loadTrustedViews(views);
  const wc = views.shellView.webContents;
  wc.on("console-message", (_event, level, message) => { if (level >= 3) consoleErrors.push(message); });
  wc.setBackgroundThrottling(false);
  wc.debugger.attach();
  const evaluate = async expression => {
    const result = await wc.debugger.sendCommand("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async (expression, label) => { for (let i = 0; i < 160; i++) { if (await evaluate(`Boolean(${expression})`)) return; await wait(50); } throw Error(`timeout: ${label}: ${await evaluate("JSON.stringify({visibility:document.visibilityState,focus:document.hasFocus(),active:document.activeElement?.getAttribute('aria-label')??document.activeElement?.tagName,buttons:[...document.querySelectorAll('button[aria-busy]')].map(b=>({label:b.getAttribute('aria-label'),busy:b.getAttribute('aria-busy'),disabled:b.disabled}))})")}`); };
  const click = async label => {
    views.window.show(); app.focus({ steal: true }); views.window.focus(); wc.focus();
    const expression = `([...document.querySelectorAll('button')].find(el => (el.getAttribute('aria-label') ?? el.textContent.trim()).startsWith(${JSON.stringify(label)}) && el.getBoundingClientRect().width > 0))`;
    await until(expression, label);
    await evaluate(`${expression}.scrollIntoView({block:'center',behavior:'instant'}); true`);
    await wait(60);
    const point = await evaluate(`(() => {const el=${expression}; const r=el.getBoundingClientRect(); return !el.disabled && el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)) ? {x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`);
    check(`native pointer reaches ${label}`, point);
    await wc.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    await wc.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    await wait(130);
  };
  const sidebar = async label => {
    if (width < 960 && !await evaluate("document.querySelector('[data-testid=desktop-sidebar]')?.dataset.expanded==='true'")) await click("展开导航");
    await click(label);
    if (width < 960 && await evaluate("!document.querySelector('[role=dialog]') && document.querySelector('[data-testid=desktop-sidebar]')?.dataset.expanded==='true'")) await click("收起导航");
  };
  const fill = async (label, value) => {
    await evaluate(`(() => {const el=document.querySelector('[aria-label=${JSON.stringify(label)}]')??document.getElementById(${JSON.stringify(label)});el.scrollIntoView({block:'center'});el.focus();el.select()})()`);
    await wc.debugger.sendCommand("Input.insertText", { text: value }); await wait(30);
  };
  const capture = async state => {
    const metrics = await evaluate(`(() => { const d=document.querySelector('[role=dialog]'); const box=el=>{const r=el?.getBoundingClientRect();return r?{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom}:null};return {viewport:[innerWidth,innerHeight],theme:document.documentElement?.dataset.theme,dialog:box(d),overflow:document.documentElement.scrollWidth>innerWidth,active:document.activeElement?.getAttribute('aria-label')??document.activeElement?.id};})()`);
    const name = `${width}x${height}-${state}.png`;
    writeFileSync(join(output, name), Buffer.from((await wc.debugger.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data, "base64"));
    shots.push({ file: name, sha256: hash(join(output, name)), metrics });
    check(`${state}: no document horizontal overflow`, !metrics.overflow);
    if (metrics.dialog) check(`${state}: bounded Pencil dialog width`, Math.abs(metrics.dialog.width - Math.min(720, width - (width < 960 ? 48 : 260) - 32)) <= 2 && metrics.dialog.bottom <= height - 15, metrics.dialog);
  };
  check("production file renderer", /^file:.*\/renderer\/index.html$/.test(await evaluate("location.href")));
  check("immutable design", hash(join(repo, "docs/design/PiDock.pen")) === "149ef57c1394e0e6b4af3e40663b8dd1c8c93d766eb370c7d05029afa2480707");
  for (const theme of physical ? ["light"] : ["light", "dark"]) {
    await evaluate(`window.pidock.preferencesOp({op:'appearance/save',appearance:'${theme}'})`); wc.reload();
    await until(`document.documentElement?.dataset.theme==='${theme}' && document.querySelector('[data-testid=desktop-sidebar]')`, "boot");
    await sidebar("选择器验证"); await click("编辑工作空间");
    const before = readFileSync(join(profile, "projects.json"), "utf8");
    next = { canceled: true, filePaths: [] };
    await click("选择目录文件夹 1");
    await until("!document.querySelector('button[aria-busy=true]')", "cancel");
    check(`${theme}: cancel leaves form and registry unchanged`, await evaluate(`document.querySelector('[aria-label="目录路径 1"]').value===${JSON.stringify(directory)}`) && readFileSync(join(profile, "projects.json"), "utf8") === before);
    await until("document.activeElement?.getAttribute('aria-label')==='选择目录文件夹 1'", "picker focus returned");
    if (physical) { check("physical OS dialog canceled through production UI", dialogs.length === 1); await click("取消"); break; }
    throwNext = true; await click("选择目录文件夹 1");
    check(`${theme}: dialog error preserves path`, await evaluate(`document.querySelector('[role=alert]')?.innerText.includes('resource-selection-failed') && document.querySelector('[aria-label="目录路径 1"]').value===${JSON.stringify(directory)}`));
    next = { canceled: false, filePaths: [skills] }; await click("选择目录文件夹 1");
    check(`${theme}: selection preserves source name`, await evaluate(`document.querySelector('[aria-label="目录路径 1"]').value===${JSON.stringify(skills)} && document.querySelector('[aria-label="目录名称 1"]').value==='original-name'`));
    await capture(`${theme}-workspace-edit`); await click("取消");
    check(`${theme}: canceled edit never writes`, readFileSync(join(profile, "projects.json"), "utf8") === before);
    await sidebar("新建工作空间"); await fill("工作空间名称 *", `Picker ${theme}`);
    await click("添加 Git 仓库"); await fill("仓库名称 1", "selected-git");
    next = { canceled: false, filePaths: [source] }; await click("选择仓库文件夹 1");
    await click("添加普通目录"); await fill("目录名称 1", "selected-plain");
    next = { canceled: false, filePaths: [directory] }; await click("选择目录文件夹 1");
    await capture(`${theme}-workspace-create`); await click("创建工作区并保存配置");
    await until("!document.querySelector('[role=dialog]')", "workspace saved");
    const created = projects.list().projects.find(row => row.name === `Picker ${theme}`);
    check(`${theme}: selected Git/plain paths saved through actual IPC`, created?.repositories[0]?.path === source && created?.directories[0]?.path === directory);
    renameSync(directory, `${directory}-moved`);
    await sidebar("选择器验证");
    await until("document.body.innerText.includes('来源缺失') || document.body.innerText.includes('路径已缺失')", "missing source");
    await click("修复路径"); next = { canceled: false, filePaths: [`${directory}-moved`] }; await click("选择目录文件夹 1");
    await capture(`${theme}-workspace-repair`); await click("保存更改");
    await until("!document.querySelector('[role=dialog]')", "repair saved");
    check(`${theme}: repair preserves workspace and source identity`, projects.get(workspace.id).directories[0].id === workspace.directories[0].id && projects.get(workspace.id).directories[0].path === `${directory}-moved`);
    renameSync(`${directory}-moved`, directory);
    // Restore fixture metadata through the same main store for the next theme.
    await projects.update(workspace.id, { name: workspace.name, description: "", repositories: workspace.repositories, directories: [{ ...workspace.directories[0], path: directory }], environment: [], branchTemplate: "feature/{task-name}" });
    await sidebar("能力管理");
    await evaluate("[...document.querySelectorAll('nav[aria-label=能力管理] button')].find(el=>el.textContent.startsWith('Skills')).click();true"); await wait(150);
    next = { canceled: false, filePaths: [skills] }; await click("选择技能来源文件夹"); await capture(`${theme}-skills-select`); await click("添加来源");
    await until("document.body.innerText.includes('picker-fixture')", "actual skill scan");
    check(`${theme}: selected Skills scanned from real disk`, await evaluate("document.body.innerText.includes('picker-fixture')"));
    await click("移除");
    await evaluate("[...document.querySelectorAll('nav[aria-label=能力管理] button')].find(el=>el.textContent.startsWith('MCP')).click();true"); await wait(150);
    await click("新增 Server");
    next = { canceled: false, filePaths: [process.execPath] }; await click("选择 MCP 可执行文件");
    next = { canceled: false, filePaths: [directory] }; await click("选择 MCP 工作文件夹");
    check(`${theme}: MCP picks update command and cwd only`, await evaluate(`document.getElementById('mcp-command').value===${JSON.stringify(process.execPath)} && document.getElementById('mcp-cwd').value===${JSON.stringify(directory)}`));
    await capture(`${theme}-mcp-select`); await click("返回列表");
    await click("返回任务工作区"); await sidebar("设置"); await click("通用");
    next = { canceled: false, filePaths: [process.execPath] }; await click("选择编辑器可执行文件");
    await capture(`${theme}-editor-select`); await click("保存外部编辑器");
    await until(`document.querySelector('section[aria-label=外部编辑器]')?.innerText.includes(${JSON.stringify(process.execPath)})`, "editor saved");
    check(`${theme}: editor selected file saved without execution`, JSON.parse(readFileSync(join(profile, "external-editor.json"), "utf8")).program === process.execPath);
    await click("返回任务工作区");
    await sidebar("选择器验证");
    await sidebar("更多"); await sidebar("环境与服务");
    await until("document.querySelector('#desktop-env-list')?.options.length>1", "environment list");
    await evaluate(`(() => {const el=document.getElementById('desktop-env-list');const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;set.call(el,${JSON.stringify(environment.environmentId)});el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await click("任务绑定");
    await until("document.querySelector('[aria-label=绑定工作副本]')?.options.length>1", "task binding roots");
    next = { canceled: false, filePaths: [childDirectory] }; await click("选择绑定工作文件夹");
    check(`${theme}: existing concrete binding directory selected without saving or executing`,await evaluate("document.querySelector('[aria-label=绑定工作子目录]').value==='资料 space'"));
    await capture(`${theme}-binding-directory`);
    next = { canceled: false, filePaths: [directory] }; await click("选择绑定工作文件夹");
    check(`${theme}: binding refuses outside root without changing draft`,await evaluate("document.querySelector('[aria-label=绑定工作子目录]').value==='资料 space' && document.body.innerText.includes('请选择当前工作副本内的文件夹')"));
  }
  check("all dialogs parented and exact native selection kind", dialogs.every(row => row.parented && (row.options.properties.join() === "openDirectory" || row.options.properties.join() === "openFile,treatPackageAsDirectory")));
  check("original file bytes preserved", hash(join(directory, "original.txt")) === originalHash);
  check("zero renderer console errors", consoleErrors.length === 0, consoleErrors);
  check("real Hosts gracefully released", (await shutdownTestRegistry(registry,{origin,label:"picker evidence complete"})).length===0);
  finish(0);
}
void run();
