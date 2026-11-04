// #159: compiled production renderer, trusted preload/IPC, real Host and disk.
// Sources, remote, dirty checkout and Git-hook failure are isolated temporary fixtures.
// No renderer bridge stubs, in-memory pages, or online credentials.
// Run after pnpm --filter @pidock/shell build. Each viewport is a fresh real window.
import { app, utilityProcess } from "electron";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, readdirSync, unlinkSync } from "node:fs";
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
const output = resolve(repo, arg("--output", "docs/evidence/pencil-ui-u04/electron"));
const root = mkdtempSync(join(tmpdir(), "pidock-ui-u04-"));
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
const identity = () => {
  const sourceFiles=execFileSync('git',['ls-files','packages/renderer/src','packages/shell/src','packages/shell/scripts/electron-pencil-ui-u04-capture.mjs','packages/renderer/package.json','packages/shell/package.json','pnpm-lock.yaml','docs/design/PiDock.pen'],{cwd:repo,encoding:'utf8'}).trim().split('\n');
  const script='packages/shell/scripts/electron-pencil-ui-u04-capture.mjs';if(!sourceFiles.includes(script))sourceFiles.push(script);
  const filesUnder = path => readdirSync(join(repo,path),{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?filesUnder(`${path}/${entry.name}`):[`${path}/${entry.name}`]);
  const manifest=paths=>Object.fromEntries(paths.sort().map(path=>[path,hash(join(repo,path))]));
  return {source:manifest(sourceFiles),build:manifest(filesUnder('packages/shell/dist'))};
};
const finish = (code, error) => {
  if (exiting) return; exiting = true;
  writeFileSync(join(output, `${width}x${height}-${scenario}-identity.json`),JSON.stringify(identity(),null,2));
  writeFileSync(join(output, `${width}x${height}-${scenario}-log.json`), JSON.stringify({ scenario, size: [width, height], root, sourceDiffSha256: createHash("sha256").update(execFileSync("git", ["diff", "HEAD", "--", "packages/renderer/src", "packages/shell/scripts/electron-pencil-ui-u04-capture.mjs"], { cwd: repo })).digest("hex"), source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), designSha256: hash(join(repo, "docs/design/PiDock.pen")), buildSha256: hash(join(repo, "packages/shell/dist/renderer/index.html")), node: process.versions.node, electron: process.versions.electron, assertions, shots, calls, consoleErrors, error: error ?? null }, null, 2));
  console.log(`U04_CAPTURE ${width}x${height} ${scenario} ${code} ${error ?? "PASS"}`);
  for (const child of children) { try { child.kill(); } catch { /* already exited */ } }
  app.exit(code);
};
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
setTimeout(() => finish(1, "watchdog timeout"), 180000).unref();
process.on("uncaughtException", (error) => finish(1, error.stack));
process.on("unhandledRejection", (error) => finish(1, String(error instanceof Error ? error.stack : error)));
app.on("window-all-closed", () => {});

async function run() {
  const { buildHostEnv } = await import("../dist/host/host-guards.js");
  const { TaskRootIndex } = await import("../dist/main/task-root-index.js");
  const { ProjectRegistry } = await import("../dist/main/project-registry.js");
  const { ServiceCatalog, serviceCatalogAuthority } = await import("../dist/main/service-catalog.js");
  const { createTrustedWindow, loadTrustedViews, PerTaskHostRegistry, registerIpc } = await import("../dist/main/runtime.js");
  const { CreationIntentStore, ProjectTaskCreation } = await import("../dist/main/project-task-creation.js");
  const { ProviderProfileStore } = await import("../dist/main/provider-profile-store.js");
  const { ProviderWiring } = await import("../dist/main/provider-ipc.js");
  const { TaskVariableStore, resolveTaskVariables, variableEnvironment } = await import("../dist/main/workspace-variables.js");
  const { HostClient } = await import("../dist/rpc/host-client.js");
  await app.whenReady();
  const index = new TaskRootIndex(profile, taskRoot);
  const projects = new ProjectRegistry(profile);
  const source = join(root, "sources", "pidock-source");
  const secondSource = join(root, "sources", "pidock-source-two");
  const directory = join(root, "sources", "shared-directory-with-a-long-name-for-path-wrapping");
  mkdirSync(source, { recursive: true }); mkdirSync(directory, { recursive: true });
  const git = (args) => execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();
  git(["init", "-q", "-b", "main"]);
  writeFileSync(join(source, "README.md"), "U04 real Git source\n");
  git(["add", "."]); git(["-c", "user.name=Evidence", "-c", "user.email=evidence@example.invalid", "commit", "-qm", "base"]);
  writeFileSync(join(source,"original-uncommitted.txt"),"original dirty checkout must remain unchanged\n");
  const remote = join(root, "remote.git");
  execFileSync("git", ["clone", "-q", "--bare", source, remote]);
  git(["remote", "add", "origin", remote]);
  execFileSync("git", ["clone", "-q", source, secondSource]);
  await projects.create({ name: "PiDock 核心开发", description: "U04 真实生产工作空间分层验收", repositories: [{ name: "pidock", path: source }], directories: [{ name: "common-configs", path: directory }], environment: [{ key: "NODE_ENV", value: "development" }], branchTemplate: "feature/{taskId}" });

  const taskVariables = new TaskVariableStore(profile);
  const taskEnvironment = (id) => {
    const association = projects.association(id, index);
    const project = association.projectId === null ? undefined : projects.get(association.projectId);
    return variableEnvironment(resolveTaskVariables(project?.environment ?? [], taskVariables.list(id)).rows);
  };
  views = await createTrustedWindow("pencil-ui-u04", "production");
  views.window.setContentSize(width, height);
  registry = new PerTaskHostRegistry("pencil-ui-u04", async (workspaceId, task, variables) => {
    const child = utilityProcess.fork(join(import.meta.dirname, "../dist/host/host-entry.js"), [], { serviceName: "pencil-ui-u04-host", env: buildHostEnv(process.env, workspaceId, task, profile, undefined, process.platform, variables), stdio: "pipe" });
    children.push(child);
    child.stderr?.on("data", (data) => process.stderr.write(data));
    return { child, client: new HostClient(child) };
  }, (id) => index.resolve(id), undefined, index, taskEnvironment);
  const route = registry.routeTaskOp.bind(registry);
  registry.routeTaskOp = async (request) => {
    calls.push({ op: request.op, taskId: request.taskId, payload: request.payload });
    return await route(request);
  };
  const providerProfiles = new ProviderProfileStore(profile);
  const providers = new ProviderWiring(providerProfiles, async (taskId, provider, senderWebContentsId) => {
    await registry.routeTaskOp({ taskId, op: "task/sdkProvider", payload: provider === null ? { provider: null } : { provider: { config: providerProfiles.config(provider.profileId), credential: provider.credential } }, origin: { kind: "shell-ui", senderWebContentsId } });
  });
  const creation = new ProjectTaskCreation(new CreationIntentStore(profile), projects, index, registry, taskRoot);
  const catalog = new ServiceCatalog(profile, serviceCatalogAuthority(index, projects));
  registerIpc(createUnavailableHostClient(), views.registry, registry, projects, index, undefined, creation, providers, catalog, undefined, undefined, taskVariables);
  const origin = { kind: /** @type {const} */ ("shell-ui"), senderWebContentsId: views.shellView.webContents.id };
  creation.saveDeliverySettings({ branchTemplate: "feature/{taskId}", remote: "origin" });
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
    const point = await evaluate(`(() => { const el = [...document.querySelectorAll('button')].find(el => (el.getAttribute('aria-label') ?? el.textContent.trim()).startsWith(${JSON.stringify(label)}) && el.getBoundingClientRect().width > 0 && !el.closest('[hidden]')); if (!el || el.disabled) return null; el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    check(`control reachable: ${label}`,point&&point.y>0&&point.y<height,point);
    await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
    await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
    await wait(120);
  };
  const sidebarClick = async (label) => {
    if (width < 960 && !(await evaluate("document.querySelector('[data-testid=desktop-sidebar]')?.dataset.expanded === 'true'"))) await click("展开导航");
    await until(`[...document.querySelectorAll("button")].some(el => el.getAttribute("aria-label") === ${JSON.stringify(label)} || el.textContent.trim() === ${JSON.stringify(label)})`, `sidebar ${label}`);
    await click(label);
    if (width < 960 && !await evaluate("Boolean(document.querySelector('[role=dialog]'))") && await evaluate("document.querySelector('[data-testid=desktop-sidebar]')?.dataset.expanded === 'true'")) await click("收起导航");
  };
  const input = async (label, value) => {
    await evaluate(`(() => {const el=[...document.querySelectorAll('input')].find(el=>(el.getAttribute('aria-label') ?? '')===${JSON.stringify(label)}); if(!el) throw Error('missing input '+${JSON.stringify(label)}); el.focus();el.select()})()`);
    await wc.debugger.sendCommand('Input.insertText', {text:value});
    await wait(40);
  };
  const keyboard = async (key, code, modifiers = 0) => {
    await wc.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key,code,modifiers});
    await wc.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key,code,modifiers});
    await wait(100);
  };
  const capture = async (state, task = false) => {
    views.window.show(); app.focus({steal:true}); views.window.focus(); await wait(180);
    const metrics=await evaluate(`(() => {
      const box=el=>{if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight}};
      const dialog=document.querySelector('[role=dialog]');
      return {viewport:[innerWidth,innerHeight],dialog:box(dialog),backdrop:box(dialog?.parentElement),theme:document.documentElement.dataset.theme,active:document.activeElement?.getAttribute('aria-label'),fields:[...dialog.querySelectorAll('input,button')].filter(el=>el.getBoundingClientRect().width).map(el=>({label:el.getAttribute('aria-label')??el.textContent.trim(),box:box(el)})),text:dialog.innerText};
    })()`);
    const name=`${width}x${height}-${state}.png`;
    const shot=await wc.debugger.sendCommand('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    writeFileSync(join(output,name),Buffer.from(shot.data,'base64'));shots.push({file:name,sha256:hash(join(output,name)),metrics});
    check(`${state}: exact viewport`,metrics.viewport[0]===width&&metrics.viewport[1]===height,metrics);
    const rail=width<960?48:260;
    check(`${state}: Pencil modal width`,Math.abs(metrics.dialog.width-Math.min(task?680:720,width-rail-32))<=2,metrics.dialog);
    check(`${state}: centered in main content`,Math.abs(metrics.dialog.x+metrics.dialog.width/2-(rail+(width-rail)/2))<=2,metrics.dialog);
    check(`${state}: bounded panel`,metrics.dialog.y>=15&&metrics.dialog.bottom<=height-15,metrics.dialog);
    check(`${state}: main backdrop range`,metrics.backdrop.x===rail&&metrics.backdrop.width===width-rail,metrics.backdrop);
    check(`${state}: no horizontal panel overflow`,metrics.fields.every(row=>row.box.x>=metrics.dialog.x&&row.box.right<=metrics.dialog.right),metrics.fields);
  };
  await until("document.querySelector('[data-testid=desktop-sidebar]')",'workspace loaded');
  check('production built renderer',/^file:.*\/renderer\/index.html$/.test(await evaluate('location.href')));
  for(const theme of ['light','dark']) {
    await evaluate(`window.pidock.preferencesOp({op:'appearance/save',appearance:'${theme}'})`);
    wc.reload();
    await until(`document.documentElement?.dataset.theme==='${theme}'`,'theme');
    await sidebarClick('新建工作空间');
    await until("document.querySelector('[role=dialog]')",'workspace dialog');
    await capture(`${theme}-workspace-empty`);
    if(scenario==='geometry-red') return finish(0);
    await keyboard('Escape','Escape');
    check('workspace Escape restores exact visible trigger',await evaluate("document.activeElement?.getAttribute('aria-label')==='新建工作空间'&&document.activeElement.getBoundingClientRect().width>0&&!document.querySelector('[role=dialog]')"));
    await sidebarClick('新建工作空间');
    await until("document.querySelector('[role=dialog]')",'workspace reopened after Escape');
    await click('取消');
    check('workspace cancel restores exact visible trigger',await evaluate("document.activeElement?.getAttribute('aria-label')==='新建工作空间'&&document.activeElement.getBoundingClientRect().width>0&&!document.querySelector('[role=dialog]')"));
    await sidebarClick('新建工作空间');
    await until("document.querySelector('[role=dialog]')",'workspace reopened after cancel');
    await evaluate("document.querySelector('button[aria-label=新建任务]').focus()");
    check('workspace constrains attempted background focus',await evaluate("document.querySelector('[role=dialog]').contains(document.activeElement)"));
    if(scenario==='focus-return') {
      await capture(`${theme}-workspace-focus-return`);
      await keyboard('Escape','Escape');
      continue;
    }


    await keyboard('Tab','Tab',8);
    check('workspace shift-tab wraps to submit',await evaluate("document.activeElement?.textContent.includes('创建工作区并保存配置')"));
    await keyboard('Tab','Tab');
    check('workspace tab wraps to name',await evaluate("document.activeElement?.getAttribute('aria-label')==='工作空间名称 *'"));
    check('initial workspace name focused',await evaluate("document.activeElement?.getAttribute('aria-label')==='工作空间名称 *'"));
    await click('创建工作区并保存配置');
    await until("document.querySelector('[role=dialog]')?.innerText.includes('请填写工作空间名称')",'validation error');
    await capture(`${theme}-workspace-validation`);
    await input('工作空间名称 *',`U04 ${theme} 新工作空间`);
    await click('添加 Git 仓库');await input('仓库名称 1','真实 Git 来源');await input('仓库路径 1',source);
    await click('添加 Git 仓库');await input('仓库名称 2','第二真实 Git 来源');await input('仓库路径 2',secondSource);
    await click('添加普通目录');await input('目录名称 1','共享文档');await input('目录路径 1',directory);
    await click('添加变量');await input('环境变量名 1','NODE_ENV');await input('环境变量值 1','development');
    await click('添加变量');await click('移除变量 2');
    await capture(`${theme}-workspace-filled`);
    await click('创建工作区并保存配置');
    await until("!document.querySelector('[role=dialog]')",'real workspace saved');
    check('workspace persisted through real registry',projects.list().projects.some(row=>row.name===`U04 ${theme} 新工作空间`));
    for(const mode of ['worktree','existing-git','plain-dirs']) {
      await sidebarClick('新建任务');
      await until("document.querySelector('input[aria-label=任务名称]')",'task dialog');
      check('task dialog owns keyboard focus',await evaluate("document.querySelector('[role=dialog]')?.contains(document.activeElement)"));
      check('new task name focused',await evaluate("document.activeElement?.getAttribute('aria-label')==='任务名称'"));
      await input('任务名称',`U04 ${theme} ${mode}`);
      await evaluate(`(()=>{const el=[...document.querySelectorAll('input[type=radio]')].find(el=>el.value===${JSON.stringify(mode)});el.click()})()`);
      if(mode!=='plain-dirs') {
        await evaluate("[...document.querySelectorAll('[role=dialog] input[type=checkbox]')][0].click()");
        await input('远程名称','origin');
        if(mode==='worktree') {
          await input('远程分支','main');
          await evaluate("[...document.querySelectorAll('[role=dialog] input[type=checkbox]')][1].click()");
          await evaluate("(()=>{const inputs=[...document.querySelectorAll('input[aria-label=远程名称]')];inputs[1].focus()})()");
          await wc.debugger.sendCommand('Input.insertText',{text:'origin'});
          await evaluate("document.querySelectorAll('input[aria-label=远程分支]')[1].focus()");
          await wc.debugger.sendCommand('Input.insertText',{text:'main'});
        }
      } else {
        await evaluate("(()=>{const el=[...document.querySelectorAll('[role=dialog] input[type=checkbox]')].find(el=>el.closest('label')?.innerText.includes('共享文档'));el.click()})()");
        await evaluate("(()=>{const el=[...document.querySelectorAll('[role=dialog] input[type=checkbox]')].find(el=>el.closest('label')?.innerText.includes('我确认'));el.click()})()");
      }
      await wait(400);
      await capture(`${theme}-${mode}-form`,true);
      await evaluate("document.querySelector('[role=dialog]').scrollTop=10000");
      await capture(`${theme}-${mode}-form-footer`,true);
      check('footer cancel and submit reachable after scroll',await evaluate(`(()=>{const d=document.querySelector('[role=dialog]');const buttons=[...d.querySelectorAll('button')].filter(el=>el.textContent==='取消'||el.type==='submit');const p=d.getBoundingClientRect();return buttons.length===2&&buttons.every(el=>{const r=el.getBoundingClientRect();return r.y>=p.y&&r.bottom<=p.bottom})})()`));
      const primary=mode==='worktree'?'固定基线并预览路径':mode==='existing-git'?'读取原检出并预览':'预览路径';
      await click(primary);
      await until("document.querySelector('[role=dialog]')?.innerText.includes('确认创建 / 恢复')",'real prepared intent');
      const pending=creation.current();
      check(`${mode}: Host persisted pending intent`,pending?.workspaceMode===mode,pending);
      await capture(`${theme}-${mode}-prepared`,true);
      await keyboard('Escape','Escape');
      check('focus restored to creation trigger',await evaluate("document.activeElement?.getAttribute('aria-label')==='新建任务'||document.activeElement?.textContent==='任务'"));
      check('Escape only hides pending intent',!await evaluate("Boolean(document.querySelector('[role=dialog]'))")&&creation.current()?.id===pending.id);
      await click('任务');
      await until("document.querySelector('[role=dialog]')?.innerText.includes('确认创建 / 恢复')",'recovered pending intent');
      if(mode==='worktree') writeFileSync(join(secondSource,'.git/hooks/post-checkout'),`#!/bin/sh\ngit -C '${secondSource}' worktree remove --force '${join(pending.taskDir,pending.repos[1].repoDir)}'\nexit 1\n`,{mode:0o755});
      await click('确认创建 / 恢复');
      if(mode==='worktree') {
        await until("document.querySelector('[aria-label=仓库准备状态]')?.innerText.includes('失败')",'real partial worktree failure');
        const status=await creation.status();
        check('first repo created and second repo failed',status.createdRepos===1&&status.canRetry,status);
        await capture(`${theme}-partial-failure`,true);
        await evaluate("document.querySelector('[role=dialog]').scrollTop=10000");
        await capture(`${theme}-partial-failure-footer`,true);
        unlinkSync(join(secondSource,'.git/hooks/post-checkout'));
        if(status.canAdoptOrphans) await evaluate("[...document.querySelectorAll('[role=dialog] input[type=checkbox]')].find(el=>el.closest('label')?.innerText.includes('接管已存在')).click()");
        await click('只重试失败仓库');
      }
      await until("!document.querySelector('[role=dialog]')",'created real task');
      const record=JSON.parse(readFileSync(join(taskRoot,pending.taskId,'task.json'),'utf8'));
      check(`${mode}: real task persisted`,record.id===pending.taskId||record.taskId===pending.taskId,record);
    }
    // Edit the persisted source through the same production workspace dialog.
    await sidebarClick(`U04 ${theme} 新工作空间`);
    await until("document.querySelector('[data-testid=desktop-project-overview]')",'workspace overview');
    await click('添加来源仓库/目录');
    await until("document.querySelector('[role=dialog]')?.getAttribute('aria-label')==='编辑工作空间'",'edit workspace');
    await input('仓库名称 1','已编辑真实 Git 来源');
    await capture(`${theme}-workspace-edit`);
    await click('保存更改');
    await until("!document.querySelector('[role=dialog]')",'real edit saved');
    check('source edit persisted',projects.list().projects.find(row=>row.name===`U04 ${theme} 新工作空间`).repositories[0].name==='已编辑真实 Git 来源');
  }
  check('source repository unchanged',readFileSync(join(source,'README.md'),'utf8')==='U04 real Git source\n');
  check('original uncommitted file preserved',readFileSync(join(source,'original-uncommitted.txt'),'utf8')==='original dirty checkout must remain unchanged\n');
  check('original checkout branch and dirty state preserved',execFileSync('git',['status','--porcelain'],{cwd:source,encoding:'utf8'}).trim()==='?? original-uncommitted.txt'&&execFileSync('git',['branch','--show-current'],{cwd:source,encoding:'utf8'}).trim()==='main');
  check('no model or tool execution',!calls.some(row=>['task/send','task/exec','task/toolApprove'].includes(row.op)),calls);
  check('no renderer console errors',consoleErrors.length===0,consoleErrors);
  const shutdown=await shutdownTestRegistry(registry,{origin,label:'U04 evidence cleanup'});
  check('confirmed Host shutdown',shutdown.length===0,shutdown);
  finish(0);
}
run().catch(error=>finish(1,error.stack));
