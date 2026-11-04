// #161: built production Electron, real preload/IPC/Host/registry/disk; isolated fixtures only.
// Run after pnpm --filter @pidock/shell build. Each viewport is a fresh real window.
import { assertPencilLayout } from "./pencil-layout-gate.mjs";
import { app, nativeTheme, utilityProcess } from "electron";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createUnavailableHostClient } from "./unavailable-host-client.mjs";
import { shutdownTestRegistry } from "./shutdown-test-registry.mjs";

delete process.env.PIDOCK_RENDERER_URL;
delete process.env.PIDOCK_TASK_URL;
const arg = (key, fallback) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
const [width, height] = arg("--size", "1440x900").split("x").map(Number);
const scenario = "full";
const restart = process.argv.includes("--restart");
const repo = resolve(import.meta.dirname, "../../..");
const output = join(repo, "docs/evidence/pencil-ui-u06", arg("--output", "electron"));
const root = arg("--root", mkdtempSync(join(tmpdir(), "pidock-ui-u06-")));
const profile = join(root, "profile");
const taskRoot = join(root, "tasks");
const agentDir = join(root, "agent", "long-native-configuration-path-for-readable-settings");
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
  const sourcePaths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "packages/renderer/src", "packages/shell/src", "packages/shell/scripts/electron-pencil-ui-u06-capture.mjs", "pnpm-lock.yaml"], { cwd: repo, encoding: "utf8" }).trim().split("\n");
  const under = dir => readdirSync(join(repo, dir), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? under(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]);
  const manifest = paths => Object.fromEntries([...new Set(paths)].sort().map(path => [path, hash(join(repo,path))]));
  writeFileSync(join(output, `${width}x${height}-${restart ? "restart" : "full"}-identity.json`), JSON.stringify({ source: manifest(sourcePaths), build: manifest(under("packages/shell/dist")) }, null, 2));
  writeFileSync(join(output, `${width}x${height}-${restart ? "restart" : "full"}-log.json`), JSON.stringify({ scenario, size: [width, height], root, sourceDiffSha256: createHash("sha256").update(execFileSync("git", ["diff", "HEAD", "--", "packages/renderer/src", "packages/shell/scripts/electron-pencil-ui-u06-capture.mjs"], { cwd: repo })).digest("hex"), source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), designSha256: hash(join(repo, "docs/design/PiDock.pen")), buildSha256: hash(join(repo, "packages/shell/dist/renderer/index.html")), node: process.versions.node, electron: process.versions.electron, assertions, shots, calls, consoleErrors, error: error ?? null }, null, 2));
  console.log(`U06_CAPTURE ${width}x${height} ${scenario} ${code} ${error ?? "PASS"}`);
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
  nativeTheme.themeSource = 'light';
  const index = new TaskRootIndex(profile, taskRoot);
  const projects = new ProjectRegistry(profile);
  const workspace = restart ? { id: "unused" } : await projects.create({ name: "PiDock 核心开发 · 长名称工作空间用于核对截断与树形层级", description: "U06 真实生产导航验收", repositories: [], directories: [] });
  if (!restart) await projects.create({ name: "文档与脚手架", description: "空任务列表", repositories: [], directories: [] });
  if (!restart) {
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
  views = await createTrustedWindow("pencil-ui-u06", "production");
  views.window.setContentSize(width, height);
  registry = new PerTaskHostRegistry("pencil-ui-u06", async (workspaceId, task) => {
    const child = utilityProcess.fork(join(import.meta.dirname, "../dist/host/host-entry.js"), [], { serviceName: "pencil-ui-u06-host", env: buildHostEnv(process.env, workspaceId, task, profile), stdio: "pipe" });
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
  if (!restart) {
    const created = await registry.routeTaskOp({ taskId: "task-aaaa1111", op: "task/sessionCreate", payload: { name: "边界复查 · 会话长名称验证", permission: "default" }, origin });
    check("real Host creates the seeded second session", Boolean(created.payload?.session), created);
  }
  if (!restart) {
    writeFileSync(join(agentDir,"keybindings.json"), '{\n  "app.interrupt": "escape",\n  "x-preserve": { "literal": [1, 2, 3] }\n}\n');
    writeFileSync(join(agentDir,"settings.json"), '{ "x-preserve": "untouched" }\n');
  }
  await loadTrustedViews(views);
  const wc = views.shellView.webContents;
  // Test-only scheduling: this macOS automation session occludes the native
  // window. Keep Chromium's rendering lifecycle running so matchMedia events
  // can be observed; no theme value/event is injected into the renderer.
  wc.setBackgroundThrottling(false);
  wc.on("console-message", (_event, level, message) => { if (level >= 3) consoleErrors.push(message); });
  wc.debugger.attach();
  const evaluate = async (expression) => {
    const result = await wc.debugger.sendCommand("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async (expression, label) => {
    for (let attempt = 0; attempt < 200; attempt++) { if (await evaluate(`Boolean(${expression})`)) return; await wait(50); }
    throw Error(`timeout ${label}: ${JSON.stringify({nativeSource:nativeTheme.themeSource,nativeDark:nativeTheme.shouldUseDarkColors,renderer:await evaluate("({media:matchMedia('(prefers-color-scheme: dark)').matches,theme:document.documentElement.dataset.theme,events:window.u06MediaEvents,visibility:document.visibilityState,focus:document.hasFocus(),active:document.activeElement?.outerHTML.slice(0,300),composer:document.querySelector('[aria-label=消息]')?.outerHTML.slice(0,200)})")})}: ${await evaluate("document.body.innerText")}`);
  };
  const click = async (label) => {
    check(`control reachable: ${label}`, await evaluate(`(() => { const el = [...document.querySelectorAll('button')].find(el => (el.getAttribute('aria-label') ?? el.textContent.trim()) === ${JSON.stringify(label)} && el.getBoundingClientRect().width > 0 && !el.closest('[hidden]')); if (!el) return false; el.click(); return true; })()`));
    await wait(100);
  };
  const escape = () => evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  const expand = async () => { if (width < 960) await click("展开导航"); };
  const capture = async (state, appearance = false) => {
    if (!appearance) await evaluate(state.includes('error')
      ? "document.querySelector('[role=alert]')?.scrollIntoView({block:'center'})"
      : "document.querySelector('.settings-content').scrollTop=0");
    views.window.show(); app.focus({ steal: true }); views.window.moveTop(); views.window.focus(); await wait(180);
    const metrics = await evaluate(`(() => {
      const box = el => { if (!el) return null; const r=el.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height }; };
      const page=document.querySelector('[data-testid=desktop-settings-page]');
      const colors=selector=>{const el=document.querySelector(selector); if(!el)return null;const s=getComputedStyle(el);return {ink:s.color,bg:s.backgroundColor,border:s.borderColor,font:s.fontSize,outline:s.outlineStyle};};
      return {viewport:[innerWidth,innerHeight], theme:document.documentElement.dataset.theme, nav:box(page.querySelector('nav')),header:box(page.querySelector('header')),headers:page.querySelectorAll('header').length,workspace:!!document.querySelector('[data-testid=desktop-sidebar]'),body:box(page.querySelector('.settings-body')),cards:[...page.querySelectorAll('[data-appearance-option]')].map(box),previews:[...page.querySelectorAll('.appearance-preview')].map(box),overflow:page.scrollWidth>innerWidth,colors:{title:colors('.appearance-title'),selected:colors('[aria-checked=true]'),badge:colors('.appearance-status [data-slot=badge]'),input:colors('input'),error:colors('[role=alert]')}};
    })()`);
    check(`${state}: exact viewport`, JSON.stringify(metrics.viewport)===JSON.stringify([width,height]),metrics);
    check(`${state}: dedicated 240px nav at top`,metrics.nav.x===0 && metrics.nav.y===0 && metrics.nav.width===240 && metrics.nav.height===height,metrics.nav);
    check(`${state}: one 52px header, no workspace navigation`,metrics.headers===1 && metrics.header.y===0 && metrics.header.height===52 && !metrics.workspace,metrics);
    check(`${state}: no horizontal overflow`,!metrics.overflow,metrics);
    if(appearance){
      check(`${state}: all three real preference cards`,metrics.cards.length===3,metrics.cards);
      check(`${state}: 164px conversation previews`,metrics.previews.every(r=>r.height===164),metrics.previews);
      if(width===1440){
        check(`${state}: S11 body origin and width`,metrics.body.x===240 && metrics.cards[0].x===288 && metrics.cards[0].y>=168 && metrics.cards[0].y<=172 && metrics.cards[2].x+metrics.cards[2].width===1392,metrics);
        check(`${state}: S11 244px cards`,metrics.cards.every(r=>Math.abs(r.height-244)<=1),metrics.cards);
      } else check(`${state}: compact cards stack and remain scrollable`,metrics.cards[1].y>metrics.cards[0].y+metrics.cards[0].height && metrics.cards[2].width>400,metrics.cards);
    }
    const name=`${width}x${height}-${state}.png`;
    const shot=await wc.debugger.sendCommand('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    writeFileSync(join(output,name),Buffer.from(shot.data,'base64'));shots.push({file:name,sha256:hash(join(output,name)),metrics});
  };
  const type = (selector, value) => evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const choose = async mode => {
    await evaluate(`document.querySelector('[data-appearance-option=${mode}]').click()`);
    await until(`document.querySelector('[data-appearance-option=${mode}]').getAttribute('aria-checked')==='true'`,mode);
    for(let i=0;i<100;i++){if(JSON.parse(readFileSync(join(profile,'appearance.json'),'utf8')).appearance===mode)break;await wait(20);}
    check(`${mode}: main disk preference`,JSON.parse(readFileSync(join(profile,'appearance.json'),'utf8')).appearance===mode);
  };
  check('built production file renderer',/^file:.*\/renderer\/index.html$/.test(await evaluate('location.href')));
  await until("document.querySelector('[data-testid=desktop-project-overview]')",'initial registry');
  if(restart){
    const expected=arg('--expect-mode','dark');
    await until(`document.documentElement.dataset.theme==='${expected==='system'?'light':expected}'`,'cold restored theme');
    await expand(); await click('设置');
    await until(`document.querySelector('[data-appearance-option=${expected}]')?.getAttribute('aria-checked')==='true'`,'cold restored preference');
    check(`new Electron process restores saved ${expected} preference`,JSON.parse(readFileSync(join(profile,'appearance.json'),'utf8')).appearance===expected);
    await capture(`restart-${expected}-appearance`,true);
    await click('快捷键');
    await until("document.querySelector('[id=\"keybinding-app.interrupt\"]')?.value==='ctrl+q'",'cold native keybinding');
    await capture('restart-keybindings');
    await click('通用');
    await until("document.querySelector('#external-editor-program')?.value==='/bin/echo'",'cold editor preference');
    await capture('restart-general');
    if(arg('--next-mode','')){await click('外观');await choose(arg('--next-mode',''));}
  } else {
    await expand();
    await until("[...document.querySelectorAll('[data-session-nav]')].some(el=>el.textContent.includes('边界复查'))", 'Host session tree loaded');
    await click('边界复查 · 会话长名称验证');
    await until("document.querySelector('[aria-label=消息]')",'real Host conversation');
    wc.focus();
    await until('document.hasFocus()', 'initial BrowserView keyboard focus');
    await type('[aria-label=消息]','U06 未发送草稿 · 返回保持');
    await evaluate("document.querySelector('[aria-label=消息]').dataset.u06identity='preserved';document.querySelector('[aria-label=消息]').focus()");
    check('initial composer focus',await evaluate("document.activeElement===document.querySelector('[aria-label=消息]')"));
    const before=await registry.routeTaskOp({taskId:'task-aaaa1111',op:'task/sessionList',payload:{},origin});
    const mutationStart=calls.length;
    for(const theme of ['light','dark']){
      await click('设置'); await until("document.querySelector('[data-appearance-option=light]')",'settings');
      await choose(theme);
      await evaluate("document.querySelector('.settings-content').scrollTop=0");
      await assertPencilLayout(wc, "management", assertions);
      await capture(`${theme}-appearance`,true);
      nativeTheme.themeSource=theme==='light'?'dark':'light'; await wait(250);
      check(`${theme}: explicit preference ignores OS changes`,await evaluate(`document.documentElement.dataset.theme==='${theme}'`));
      // Real keyboard input selects adjacent preference and moves focus.
      wc.focus();
      wc.sendInputEvent({type:'keyDown',keyCode:'Tab'});wc.sendInputEvent({type:'keyUp',keyCode:'Tab'});
      await wait(80);
      await evaluate(`document.querySelector('[data-appearance-option=${theme}]').focus()`);
      wc.sendInputEvent({type:'keyDown',keyCode:'Right'});wc.sendInputEvent({type:'keyUp',keyCode:'Right'});
      const next=theme==='light'?'dark':'system';
      await until(`document.activeElement?.getAttribute('data-appearance-option')==='${next}' && document.activeElement.getAttribute('aria-checked')==='true'`,'arrow selects and focuses');
      const keyboardStyle = await evaluate("({outline:getComputedStyle(document.activeElement).outlineStyle,shadow:getComputedStyle(document.activeElement).boxShadow,visible:document.activeElement.matches(':focus-visible')})");
      check(`${theme}: keyboard focus visible`,keyboardStyle.visible && (keyboardStyle.outline!=='none' || keyboardStyle.shadow!=='none'),keyboardStyle);
      await capture(`${theme}-keyboard-focus`,true);
      await choose(theme);
      await click('快捷键');await until("document.querySelector('[id=\"keybinding-app.interrupt\"]')",'native actions');
      check(`${theme}: actual native path`,await evaluate(`document.querySelector('[data-testid=native-keybindings-path]').textContent===${JSON.stringify(join(agentDir,'keybindings.json'))}`));
      const keyBefore=readFileSync(join(agentDir,'keybindings.json'),'utf8');
      await type('[id="keybinding-app.interrupt"]','ctrl+q');
      await evaluate("[...document.querySelector('[id=\"keybinding-app.interrupt\"]').closest('li').querySelectorAll('button')].find(el=>el.textContent.trim()==='保存').click()");
      await until("document.body.innerText.includes('已写入文件')",'native saved');
      const keyAfter=readFileSync(join(agentDir,'keybindings.json'),'utf8');
      check(`${theme}: native file preserves other bytes`,theme==='dark'? keyBefore===keyAfter : keyAfter.replace('["ctrl+q"]','"escape"')===keyBefore,{before:keyBefore,after:keyAfter});
      await capture(`${theme}-keybindings`);
      await click('语言');await until("document.body.innerText.includes('language / locale')",'native unsupported language');
      check(`${theme}: only shipped Chinese language`,await evaluate("document.querySelector('[aria-label=界面语言]').querySelectorAll('[role=radio]').length===1 && document.body.innerText.includes('不支持')"));
      await capture(`${theme}-language`);
      await click('通用');await until("document.querySelector('#external-editor-program')",'editor');
      await type('#external-editor-program','/bin/echo');await type('#external-editor-args','--u06-private');await click('保存外部编辑器');
      await until("[...document.querySelectorAll('dd')].some(el=>el.textContent==='/bin/echo')",'native editor disk echo');
      check(`${theme}: Pi native settings unchanged`,readFileSync(join(agentDir,'settings.json'),'utf8')==='{ "x-preserve": "untouched" }\n');
      await capture(`${theme}-general`);
      await type('#external-editor-program','/pidock-u06-does-not-exist');await click('保存外部编辑器');
      await until("document.querySelector('[role=alert]')",'real invalid program');
      check(`${theme}: named failure and draft retained`,await evaluate("document.querySelector('[role=alert]').textContent.length>10 && document.querySelector('#external-editor-program').value==='/pidock-u06-does-not-exist'"));
      await capture(`${theme}-general-error`);
      await click('外观');await choose('system');
      views.window.show(); app.show(); wc.focus();
      await evaluate("window.u06MediaEvents=[];matchMedia('(prefers-color-scheme: dark)').addEventListener('change',e=>window.u06MediaEvents.push({matches:e.matches,now:matchMedia('(prefers-color-scheme: dark)').matches}))");
      nativeTheme.themeSource='dark';
      await until("document.documentElement.dataset.theme==='dark' && matchMedia('(prefers-color-scheme: dark)').matches",'system dark');
      await wait(400);
      await capture(`${theme}-system-dark`,true);
      nativeTheme.themeSource='light';
      await until("document.documentElement.dataset.theme==='light'",'system light');
      await capture(`${theme}-system-light`,true);
      check(`${theme}: system remains persisted literally`,JSON.parse(readFileSync(join(profile,'appearance.json'),'utf8')).appearance==='system');
      await choose(theme);
      await click('返回任务工作区');await until("document.querySelector('[aria-label=消息]')",'same composer');
      await until("document.activeElement===document.querySelector('[aria-label=消息]')",'composer focus restoration');
      check(`${theme}: same composer node, draft and focus restored`,await evaluate("document.querySelector('[aria-label=消息]').dataset.u06identity==='preserved' && document.querySelector('[aria-label=消息]').value==='U06 未发送草稿 · 返回保持' && document.activeElement===document.querySelector('[aria-label=消息]')"));
      await expand();
      await click('设置');await until("document.querySelector('[data-appearance-option=light]')",'settings escape');
      await escape();await until("document.querySelector('[aria-label=消息]')",'escape return');await expand();
    }
    const after=await registry.routeTaskOp({taskId:'task-aaaa1111',op:'task/sessionList',payload:{},origin});
    const sessionIdentity = payload => ({active:payload.activeSessionId,sessions:payload.sessions.map(({id,name,binding,archived,permission})=>({id,name,binding,archived,permission}))});
    check('settings round trips retain Host session identities/count and bindings',JSON.stringify(sessionIdentity(before.payload))===JSON.stringify(sessionIdentity(after.payload)),{before:sessionIdentity(before.payload),after:sessionIdentity(after.payload)});
    check('no model/tool/session mutations from settings',!calls.slice(mutationStart).some(call=>/sendMessage|sessionCreate|execute|toolReplay/.test(call.op)),calls.slice(mutationStart).map(call=>call.op));
    // Real filesystem failures through production IPC, no bridge substitute.
    await click('设置');await until("document.querySelector('[data-appearance-option=dark]')",'failure settings');
    await choose('light');
    rmSync(join(profile,'appearance.json'));mkdirSync(join(profile,'appearance.json'));
    await evaluate("document.querySelector('[data-appearance-option=dark]').click()");
    await until("document.querySelector('[role=alert]')?.textContent.includes('appearance-unwritable')",'honest persist failure');
    await capture('dark-appearance-save-failure',true);
    rmSync(join(profile,'appearance.json'),{recursive:true});await choose('light');await choose('dark');
    rmSync(join(profile,'appearance.json'));mkdirSync(join(profile,'appearance.json'));
    await evaluate("document.querySelector('[data-appearance-option=light]').click()");
    await until("document.querySelector('[role=alert]')?.textContent.includes('appearance-unwritable')",'light persist failure');
    await capture('light-appearance-save-failure',true);
    rmSync(join(profile,'appearance.json'),{recursive:true});await choose('dark');
    writeFileSync(join(output,`${width}x${height}-restart-root.txt`),root+'\n');
  }
  check('no renderer console errors',consoleErrors.length===0,consoleErrors);
  const shutdown=await shutdownTestRegistry(registry,{origin,label:'U06 capture complete'});check('Host shutdown confirmed',shutdown.length===0,shutdown);
  finish(0);
}
run().catch(error=>finish(1,error.stack));
