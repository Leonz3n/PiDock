// #157: built production Electron, real preload/IPC/Host/registry/disk; isolated fixtures only.
// Run after pnpm --filter @pidock/shell build. Each viewport is a fresh real window.
import { assertPencilLayout } from "./pencil-layout-gate.mjs";
import { createServer } from "node:http";
import { app, utilityProcess } from "electron";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, readdirSync, existsSync } from "node:fs";
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
const reusedRoot = arg("--reuse-root", "");
const output = resolve(arg("--output", join(repo, "docs/evidence/pencil-ui-u03", reusedRoot ? "restart" : "electron")));
const root = reusedRoot || mkdtempSync(join(tmpdir(), "pidock-ui-u03-"));
const profile = join(root, "profile");
const taskRoot = join(root, "tasks");
const agentDir = join(root, "agent");
for (const path of [profile, taskRoot, agentDir, output]) mkdirSync(path, { recursive: true });
app.setPath("userData", reusedRoot ? join(root, "chromium-restart") : profile);
process.env.PIDOCK_AGENT_DIR = agentDir;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const assertions = [], shots = [], calls = [], consoleErrors = [], received = [];
const MODEL = "loopback-conversation-long-model-id";
let endpoint;
let views, registry;
const children = [];
/** @param {string} name @param {unknown} condition @param {unknown} detail */
const check = (name, condition, detail = "") => { console.log("CHECK",name,Boolean(condition)); assertions.push({ name, passed: Boolean(condition), detail }); if (!condition) throw Error(`ASSERT FAILED: ${name}: ${JSON.stringify(detail)}`); };
let exiting = false;
const finish = (code, error) => {
  if (exiting) return; exiting = true;
  writeFileSync(join(output, `${width}x${height}-${scenario}-log.json`), JSON.stringify({ scenario, size: [width, height], root, requests: received.map(row => ({ ...row, authorization: undefined })), sourceDiffSha256: createHash("sha256").update(execFileSync("git", ["diff", "HEAD", "--", "packages/renderer/src", "packages/shell/scripts/electron-pencil-ui-u03-capture.mjs"], { cwd: repo })).digest("hex"), source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), designSha256: hash(join(repo, "docs/design/PiDock.pen")), buildSha256: hash(join(repo, "packages/shell/dist/renderer/index.html")), node: process.versions.node, electron: process.versions.electron, assertions, shots, calls, consoleErrors, error: error ?? null }, null, 2));
  console.log(`U03_CAPTURE ${width}x${height} ${scenario} ${code} ${error ?? "PASS"}`);
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
  const { ProviderSecretStore, createTestSafeStorage } = await import("../dist/main/provider-secret-store.js");
  const { NativeModelsFile } = await import("../dist/main/native-models-config.js");
  const { WorktreeMetadataLock } = await import("../dist/main/worktree-metadata-lock.js");
  const { ProviderWiring } = await import("../dist/main/provider-ipc.js");
  const { TaskVariableStore, resolveTaskVariables, variableEnvironment } = await import("../dist/main/workspace-variables.js");
  const { HostClient } = await import("../dist/rpc/host-client.js");
  endpoint = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += String(chunk); });
    request.on("end", () => {
      if (!request.url?.endsWith("/chat/completions")) { response.writeHead(404).end(); return; }
      const input = JSON.parse(body); const messages = input.messages ?? [];
      const rawPrompt = [...messages].reverse().find(row => row.role === "user")?.content ?? "";
      const prompt = typeof rawPrompt === "string" ? rawPrompt : JSON.stringify(rawPrompt);
      received.push({ prompt, body: input });
      if (String(prompt).includes("[ERROR]")) { response.writeHead(503, {"content-type":"application/json"}).end(JSON.stringify({error:{message:"U03 loopback unavailable"}})); return; }
      response.writeHead(200, {"content-type":"text/event-stream", "cache-control":"no-store"});
      const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({id:"u03-response", object:"chat.completion.chunk", model:MODEL, choices:[{index:0,delta,finish_reason}], ...(finish_reason ? {usage:{prompt_tokens:1200,completion_tokens:40,total_tokens:1240}} : {})})}\n\n`;
      response.write(frame({role:"assistant"}));
      if (/\[(APPROVE|DENY)\]/.test(String(prompt)) && messages.at(-1)?.role !== "tool") {
        const denied = String(prompt).includes("[DENY]");
        const command = `printf '${denied ? "DENIED" : "APPROVED"}\n' >> ${denied ? "u03-denied.txt" : "u03-approved.txt"}`;
        response.write(frame({content:"准备执行命令，需要确认最终参数。"}));
        response.write(frame({tool_calls:[{index:0,id:`u03-${denied ? "deny" : "approve"}`,type:"function",function:{name:"exec.run",arguments:'{"command":'}}]}));
        setTimeout(() => { response.write(frame({tool_calls:[{index:0,function:{arguments:JSON.stringify(command)+'}'}}]})); response.write(frame({},"tool_calls")); response.end("data: [DONE]\n\n"); }, 350);
        return;
      }
      const content = String(prompt).includes("[LONG]") ? "## 验证结果\n\n**完成**检查。\n\n```bash\npnpm test\n```\n\n" + Array.from({length:30},(_,i)=>`- 第 ${i+1} 条：长消息验证，保留可滚动对话和输入。`).join("\n") : messages.at(-1)?.role === "tool" ? "工具已返回真实结果；记录保留。" : "## 回复\n\n**中文输入正常**，已收到本次消息。";
      const parts = content.match(/.{1,80}(?:\n|$)|.{1,80}/gs) ?? [content];
      let at = 0; const timer = setInterval(() => { if (response.destroyed) { clearInterval(timer); return; } if (at < parts.length) response.write(frame({content:parts[at++]})); else { clearInterval(timer); response.write(frame({},"stop")); response.end("data: [DONE]\n\n"); } }, 90);
    });
  });
  await new Promise(resolve => endpoint.listen(0,"127.0.0.1",resolve));
  await app.whenReady();
  const index = new TaskRootIndex(profile, taskRoot);
  const projects = new ProjectRegistry(profile);
  const source = join(root, "sources", "pidock-source");
  const directory = join(root, "sources", "shared-directory-with-a-long-name-for-path-wrapping");
  const fixture = reusedRoot ? JSON.parse(readFileSync(join(root, "fixture.json"), "utf8")) : null;
  let workspace;
  if (fixture) workspace = projects.get(fixture.workspaceId);
  else {
  mkdirSync(source, { recursive: true }); mkdirSync(directory, { recursive: true });
  const git = (args) => execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();
  git(["init", "-q", "-b", "main"]);
  writeFileSync(join(source, "README.md"), "U03 real Git source\n");
  git(["add", "."]); git(["-c", "user.name=Evidence", "-c", "user.email=evidence@example.invalid", "commit", "-qm", "base"]);
  const remote = join(root, "remote.git");
  execFileSync("git", ["clone", "-q", "--bare", source, remote]);
  git(["remote", "add", "origin", remote]);
    workspace = await projects.create({ name: "PiDock 核心开发", description: "U03 真实生产工作空间分层验收", repositories: [{ name: "pidock", path: source }], directories: [{ name: "common-configs", path: directory }], environment: [{ key: "NODE_ENV", value: "development" }], branchTemplate: "feature/{taskId}" });
  }
  if (!workspace) throw Error("persisted workspace missing on restart");
  const taskVariables = new TaskVariableStore(profile);
  const taskEnvironment = (id) => {
    const association = projects.association(id, index);
    const project = association.projectId === null ? undefined : projects.get(association.projectId);
    return variableEnvironment(resolveTaskVariables(project?.environment ?? [], taskVariables.list(id)).rows);
  };
  views = await createTrustedWindow("pencil-ui-u03", "production");
  views.window.setContentSize(width, height);
  registry = new PerTaskHostRegistry("pencil-ui-u03", async (workspaceId, task, variables) => {
    const child = utilityProcess.fork(join(import.meta.dirname, "../dist/host/host-entry.js"), [], { serviceName: "pencil-ui-u03-host", env: buildHostEnv(process.env, workspaceId, task, profile, undefined, process.platform, variables), stdio: "pipe" });
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
  }, process.env, { secrets: new ProviderSecretStore(profile, createTestSafeStorage()), native: new NativeModelsFile(agentDir) });
  const creation = new ProjectTaskCreation(new CreationIntentStore(profile), projects, index, registry, taskRoot, undefined, new WorktreeMetadataLock(profile, { notify: () => {} }));
  const catalog = new ServiceCatalog(profile, serviceCatalogAuthority(index, projects));
  registerIpc(createUnavailableHostClient(), views.registry, registry, projects, index, undefined, creation, providers, catalog, undefined, undefined, taskVariables);
  const origin = { kind: /** @type {const} */ ("shell-ui"), senderWebContentsId: views.shellView.webContents.id };
  creation.saveDeliverySettings({ branchTemplate: "feature/{taskId}", remote: "origin" });
  const tasks = fixture?.tasks ?? [];
  if (!fixture) {
  for (const [mode, name] of /** @type {Array<[import("../dist/main/project-task-creation.js").CreationRequest["workspaceMode"], string]>} */ ([["worktree", "修复结算对账分页边界"], ["existing-git", "已有 Git 目录任务"], ["plain-dirs", "普通目录任务"], ["plain-dirs", "空会话任务"]])) {
    const intent = await creation.prepare({ projectId: workspace.id, name, repositories: mode === "plain-dirs" ? [] : [{ sourceId: workspace.repositories[0].id, remote: "origin", remoteBranch: "main" }], directoryIds: [workspace.directories[0].id], sharedWriteConfirmed: true, override: false, workspaceMode: mode });
    tasks.push({ ...await creation.commit(intent.id), name, mode: name === "空会话任务" ? "empty" : mode });
  }
  await registry.routeTaskOp({ taskId: tasks[3].taskId, op: "task/sessionDelete", payload: { sessionId: "main" }, origin });
  const second = await registry.routeTaskOp({ taskId: tasks[0].taskId, op: "task/sessionCreate", payload: { name: "边界复核会话" }, origin });
  check("real Host creates another independent session", Boolean(second.payload?.session), second);
  writeFileSync(join(root, "fixture.json"), JSON.stringify({ workspaceId: workspace.id, tasks, recordHashes: tasks.map(task => hash(join(taskRoot, task.taskId, "task.json"))) }));
  }
  const first = tasks[0];
  await registry.routeTaskOp({taskId:first.taskId,op:"task/sessionRename",payload:{sessionId:"main",name:"主会话"},origin});
  if (fixture) check("fresh process restores original task records", tasks.every((task, index) => hash(join(taskRoot, task.taskId, "task.json")) === fixture.recordHashes[index]));
  const savedProvider = providers.save({ name:"U03 Loopback", notes:"Isolated protocol fixture", protocol:"openai-completions", baseUrl:`http://127.0.0.1:${(/** @type {import("node:net").AddressInfo} */ (endpoint.address())).port}/v1`, credentials:{kind:"store",revision:1}, models:[{id:MODEL,name:"PiDock Conversation Very Long Display Name · 中文模型名称与 ID 分开",contextWindow:131072,maxTokens:8192,reasoning:false}],modelId:MODEL }, "u03-loopback-secret", false);
  await providers.select(first.taskId, savedProvider.profile.id, MODEL, undefined, origin.senderWebContentsId);
  await registry.routeTaskOp({taskId:first.taskId,op:"task/setPermission",payload:{sessionId:"main",permission:"default"},origin});
  const fileRoots = await registry.routeTaskOp({taskId:first.taskId,op:"task/fileRoots",payload:{},origin});
  const executionRoot = (Array.isArray(fileRoots.payload.roots) ? fileRoots.payload.roots : []).find(item => item.kind === "worktree").path;
  const recordsBefore = tasks.map(task => readFileSync(join(taskRoot, task.taskId, "task.json"), "utf8"));
  if (scenario === "archived") {
    const list = await registry.routeTaskOp({ taskId: first.taskId, op: "task/sessionList", payload: {}, origin });
    const session = Array.isArray(list.payload?.sessions) ? list.payload.sessions.find(row => row.name === "边界复核会话") : null;
    if (!session) throw Error("seeded history session missing");
    if (!session.archived) await registry.routeTaskOp({ taskId: first.taskId, op: "task/sessionArchive", payload: { sessionId: session.id }, origin });
  }
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
    console.log("WAIT",label);
    for (let attempt = 0; attempt < 200; attempt++) { if (await evaluate(`Boolean(${expression})`)) return; await wait(50); }
    throw Error(`timeout ${label}: ${await evaluate("document.body.innerText")}`);
  };
  const click = async (label) => {
    check(`control reachable: ${label}`, await evaluate(`(() => { const el = [...document.querySelectorAll('button')].find(el => (el.getAttribute('aria-label') ?? el.textContent.trim()) === ${JSON.stringify(label)} && el.getBoundingClientRect().width > 0 && !el.closest('[hidden]')); if (!el) return false; el.click(); return true; })()`));
    await wait(100);
  };
  const sidebarClick = async (label) => {
    if (width < 960 && !(await evaluate("document.querySelector('[data-testid=desktop-sidebar]')?.dataset.expanded === 'true'"))) await click("展开导航");
    await until(`[...document.querySelectorAll("button")].some(el => el.getAttribute("aria-label") === ${JSON.stringify(label)} || el.textContent.trim() === ${JSON.stringify(label)})`, `sidebar ${label}`);
    await click(label);
    if (width < 960 && await evaluate("document.querySelector('[data-testid=desktop-sidebar]')?.dataset.expanded === 'true'")) await click("收起导航");
  };
  const capture = async (state, dock = false) => {
    console.log("CAPTURE",state);
    views.window.show(); app.focus({ steal: true }); views.window.moveTop(); views.window.focus(); await wait(180);
    const metrics = await evaluate(`(() => {
      const box = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom, scrollWidth:el.scrollWidth, scrollHeight:el.scrollHeight, scrollTop:el.scrollTop }; };
      return { viewport:[innerWidth,innerHeight], theme:document.documentElement?.dataset.theme,
        header:box(document.querySelector('[data-testid=desktop-breadcrumb]')), column:box(document.querySelector('[data-testid=desktop-message-column]')),
        composer:box(document.querySelector('[data-testid=desktop-composer]')), input:box(document.querySelector('textarea[aria-label=消息]')), send:box(document.querySelector('button[aria-label=发送]')),
        scroll:box(document.querySelector('[data-testid=desktop-conversation-scroll]')), activeElement:document.activeElement?.getAttribute('aria-label'),
        taskFacts:!!document.querySelector('[data-testid=desktop-task-facts]'), oldTitle:document.body.innerText.includes('Task workspace'), horizontalOverflow:document.documentElement.scrollWidth > innerWidth,
        text:document.querySelector('[data-testid=desktop-shell-content]')?.innerText };
    })()`);
    check(`${state}: exact renderer viewport`, metrics.viewport[0] === width && metrics.viewport[1] === height, metrics.viewport);
    check(`${state}: no horizontal document overflow`, !metrics.horizontalOverflow, metrics);
    if (metrics.composer && !dock) {
      check(`${state}: one unified design header`, Math.abs(metrics.header.height - (width < 960 ? 42 : 52)) <= 2, metrics.header);
      check(`${state}: no stacked facts or old title`, !metrics.taskFacts && !metrics.oldTitle);
      check(`${state}: design conversation measure`, Math.abs(metrics.column.width - (width < 960 ? width - 80 : 768)) <= 2, metrics.column);
      check(`${state}: floating Composer shares column`, Math.abs(metrics.composer.width - metrics.column.width) <= 2 && Math.abs(metrics.composer.x - metrics.column.x) <= 2, metrics);
      check(`${state}: Pencil Composer height`,Math.abs(metrics.composer.height-(width>960?70:54))<=1,metrics.composer);
      check(`${state}: Composer bottom clearance`, Math.abs(height - metrics.composer.bottom - (width < 960 ? 12 : 16)) <= 2, metrics.composer);
      check(`${state}: centered desktop column`, width < 960 || Math.abs((metrics.column.x + metrics.column.width/2) - (260+(width-260)/2)) <= 2, metrics.column);
      check(`${state}: reachable input/send and scrolling height`, metrics.input.bottom <= height && metrics.send.bottom <= height && metrics.scroll.height >= 180, metrics);
      check(`${state}: messages never covered by Composer`, metrics.scroll.bottom <= metrics.composer.y, metrics);
    }
    const name = `${width}x${height}-${state}.png`;
    const shot = await wc.debugger.sendCommand("Page.captureScreenshot", { format:"png", captureBeyondViewport:false });
    writeFileSync(join(output,name),Buffer.from(shot.data,"base64"));
    shots.push({file:name,sha256:hash(join(output,name)),metrics});
  };
  check("production built renderer", /^file:.*\/renderer\/index.html$/.test(await evaluate("location.href")));
  const openConversation = async () => {
    await sidebarClick(first.name);
    await until("document.querySelector('[data-testid=desktop-task-facts]')", "task facts");
    await until(`document.querySelector('button[aria-label="进入对话 · 主会话"]')`, "main session entry");
    await click("进入对话 · 主会话");
    await until("document.querySelector('[data-testid=composer-model-name]')?.textContent.includes('PiDock Conversation')", "real session model");
    await until("!document.querySelector('button[aria-label=发送]')?.disabled || document.querySelector('textarea[aria-label=消息]')?.value === ''", "connected composer");
    await wait(300);
  };
  const input = async (value) => {
    await evaluate("(() => {const el=document.querySelector('textarea[aria-label=消息]');el.focus();el.select();return true})()");
    await wc.debugger.sendCommand("Input.insertText", {text:value});
    await until(`document.querySelector('textarea[aria-label=消息]')?.value === ${JSON.stringify(value)} && !document.querySelector('button[aria-label=发送]')?.disabled`, "sendable text");
  };
  const key = async (key, modifiers = 0) => {
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", {type:key === "PageDown" ? "rawKeyDown" : "keyDown",key,code:key,windowsVirtualKeyCode:key === "Enter" ? 13 : key === "Escape" ? 27 : key === "PageDown" ? 34 : 0,modifiers});
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", {type:"keyUp",key,code:key,windowsVirtualKeyCode:key === "Enter" ? 13 : key === "Escape" ? 27 : key === "PageDown" ? 34 : 0,modifiers});
  };
  const complete = async () => {
    await until("!document.querySelector('[data-testid=desktop-composer-container]')?.innerText.includes('停止')", "settled turn");
    await wait(300);
  };
  const send = async (value) => { await input(value); await key("Enter"); await until(`document.querySelector('[aria-label="SDK 对话历史"]')?.innerText.includes(${JSON.stringify(value)})`, "confirmed user message"); };
  const taskDir = join(taskRoot,first.taskId);
  const transcript = () => {
    const dir = join(taskDir,".pidock-sdk-sessions","main");
    return existsSync(dir) ? readdirSync(dir).filter(name=>name.endsWith(".jsonl")).flatMap(name=>readFileSync(join(dir,name),"utf8").split("\n").filter(Boolean).map(line=>JSON.parse(line))) : [];
  };
  const userMessages = () => transcript().filter(row=>row.message?.role === "user");
  const hostOp = (op,payload={}) => registry.routeTaskOp({taskId:first.taskId,op,payload,origin});
  const seedDraft = reusedRoot ? "U03 cold restart draft" : null;
  for (const theme of ["light", "dark"]) {
    await evaluate(`window.pidock.preferencesOp({op:'appearance/save', appearance:'${theme}'})`);
    wc.reload();
    await until(`document.documentElement?.dataset.theme === '${theme}' && document.querySelector('[data-testid=desktop-project-overview], [data-testid=desktop-task-facts], [data-testid=desktop-conversation]')`, "theme boot");
    await openConversation();
    if (seedDraft && theme === "light") {
      check("fresh process restores exact disk draft", await evaluate(`document.querySelector('textarea[aria-label=消息]')?.value === ${JSON.stringify(seedDraft)}`));
      check("fresh process never replays draft", received.length === 0,received);
    }
    if (reusedRoot) { await capture(`${theme}-restarted`); continue; }
    await assertPencilLayout(wc, "conversation", assertions);
    await capture(`${theme}-empty`);
    await evaluate("document.querySelector('[data-testid=composer-model]').click();true");
    check(`${theme}: model display name and ID are separate`, await evaluate(`document.querySelector('[role=menu] [data-model-name]')?.textContent !== ${JSON.stringify(MODEL)} && document.querySelector('[role=menu]')?.textContent.includes(${JSON.stringify(MODEL)})`));
    await capture(`${theme}-model-picker`);
    await evaluate("document.querySelector('[data-testid=composer-model]').click();true");
    const beforeIme = userMessages().length;
    await input(`U03 ${theme} 中文`);
    await evaluate("window.u03InputEvents=[];document.querySelector('textarea[aria-label=消息]').addEventListener('keydown',e=>window.u03InputEvents.push({key:e.key,isComposing:e.isComposing,keyCode:e.keyCode}));true");
    await wc.debugger.sendCommand("Input.imeSetComposition", {text:"输入",selectionStart:2,selectionEnd:2});
    await key("Enter");
    await wait(250);
    check(`${theme}: Chromium IME Enter does not submit`,userMessages().length===beforeIme,{events:await evaluate("window.u03InputEvents"),users:userMessages().length});
    await wc.debugger.sendCommand("Input.insertText", {text:"输入"});
    await input(`[TEXT-${theme}] 中文输入提交后正常`);
    await key("Enter",8);
    check(`${theme}: Shift Enter does not send`,userMessages().length===beforeIme);
    await input(`[TEXT-${theme}] 中文输入提交后正常`);
    await key("Enter");
    await until(`document.querySelector('[aria-label="SDK 对话历史"]')?.innerText.includes('中文输入提交后正常')`,"normal IME submit");
    await complete();
    check(`${theme}: exactly one message after IME and Shift Enter`,userMessages().length===beforeIme+1,userMessages().length);
    check(`${theme}: focus returns to message input`,await evaluate("document.activeElement?.getAttribute('aria-label') === '消息'"));
    await capture(`${theme}-markdown`);
    await send(`[LONG] ${theme} 长消息与代码`);
    await until("document.body.innerText.includes('暂存回复')", "streaming text");
    await capture(`${theme}-streaming`);
    await complete();
    await until("document.querySelector('[aria-label=\"SDK 对话历史\"] h2')", "Markdown heading");
    check(`${theme}: Markdown code rendered`,await evaluate("!!document.querySelector('[aria-label=\"SDK 对话历史\"] pre code')"));
    await evaluate("document.querySelector('[aria-label=\"SDK 对话历史\"] pre').scrollIntoView({block:'center'});true");
    await capture(`${theme}-code`);
    await evaluate("document.querySelector('[data-testid=desktop-conversation-scroll]').scrollTop=0;true");
    await wait(150);
    const beforeWheel=await evaluate("document.querySelector('[data-testid=desktop-conversation-scroll]').scrollTop");
    await evaluate("document.querySelector('[data-testid=desktop-conversation-scroll]').focus();true");
    await wc.debugger.sendCommand("Page.bringToFront");
    await wc.debugger.sendCommand("Emulation.setFocusEmulationEnabled", {enabled:true});
    await key("PageDown");
    await wait(800);
    check(`${theme}: native PageDown scrolls long history`,await evaluate("document.querySelector('[data-testid=desktop-conversation-scroll]').scrollTop")>beforeWheel, {beforeWheel, after:await evaluate("document.querySelector('[data-testid=desktop-conversation-scroll]').scrollTop"), scroll:await evaluate("(()=>{const el=document.querySelector('[data-testid=desktop-conversation-scroll]');return [el.clientHeight,el.scrollHeight,getComputedStyle(el).overflowY,document.activeElement?.getAttribute('data-testid'),document.hasFocus()]})()")});
    await capture(`${theme}-long-scrolled`);
    await evaluate("document.querySelector('[data-testid=desktop-conversation-scroll]').scrollTop=1e6;true");
    await capture(`${theme}-long-bottom`);
    for (const decision of ["approve","deny"]) {
      const marker=decision === "approve" ? "APPROVE" : "DENY";
      await send(`[${marker}] ${theme} 最终命令审批`);
      await until("document.querySelector('[data-testid=desktop-approval-approve]')", "pending approval without reload");
      const approvals=await hostOp("task/listApprovals",{sessionId:"main"});
      const pending=approvals.payload.approvals.find(row=>row.status==="pending");
      check(`${theme}-${decision}: displayed execution parameters are Host final payload`, await evaluate(`document.querySelector('[data-testid=desktop-approval-operation]')?.textContent.includes(${JSON.stringify(pending.operation)})`),pending);
      await evaluate("document.querySelector('[data-testid=desktop-approval-card]').scrollIntoView({block:'end'});true");
      await capture(`${theme}-${decision}-pending`);
      if (decision === "approve") {
        const beforeDecisions = calls.filter(row=>["task/approve","task/reject"].includes(row.op)).length;
        await sidebarClick("设置");
        await until("document.querySelector('[data-testid=desktop-settings-page]')", "management while approval pending");
        await key("Enter",4);
        check(`${theme}: hidden approval ignores management shortcut`, calls.filter(row=>["task/approve","task/reject"].includes(row.op)).length===beforeDecisions);
        await key("Escape");
        await until("document.querySelector('textarea[aria-label=消息]')", "return to pending approval");
      }
      if (width < 960) {
        const beforeDockDecisions = calls.filter(row => ["task/approve", "task/reject"].includes(row.op)).length;
        for (const dock of ["文件", "日志"]) {
          await evaluate("document.querySelector('summary[aria-label=\"会话与工具操作\"]').closest('details').open=true;true");
          await click(dock);
          await evaluate("document.querySelector('summary[aria-label=\"会话与工具操作\"]').closest('details').open=false;true");
          check(`${theme}-${decision}-${dock}: selected dock is visible`, await evaluate(`document.querySelector('[data-testid=desktop-tool-dock] [role=tab][aria-selected=true]')?.textContent.trim() === ${JSON.stringify(dock)}`));
          check(`${theme}-${decision}-${dock}: approval hidden`, await evaluate("document.querySelector('[data-testid=desktop-approval-card]').getClientRects().length === 0"));
          check(`${theme}-${decision}-${dock}: composer input/send/stop remain reachable`, await evaluate("['textarea[aria-label=消息]', 'button[aria-label=发送]'].every(s=>{const r=document.querySelector(s).getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom<=innerHeight}) && [...document.querySelectorAll('button')].some(b=>b.textContent.includes('停止')&&b.getClientRects().length>0)"));
          await evaluate("document.querySelector('[data-testid=desktop-tool-dock] [role=tab][aria-selected=true]').focus();true");
          await key("Enter",4); await key("Escape"); await wait(200);
          check(`${theme}-${decision}-${dock}: hidden shortcuts make zero decisions`, calls.filter(row => ["task/approve", "task/reject"].includes(row.op)).length === beforeDockDecisions);
          await capture(`${theme}-${decision}-${dock}-hidden`, true);
          views.window.setContentSize(1440,900); await wait(300);
          check(`${theme}-${decision}-${dock}: widening reveals approval`, await evaluate("document.querySelector('[data-testid=desktop-approval-card]').getClientRects().length > 0"));
          await evaluate("document.querySelector('[data-testid=desktop-tool-dock] [role=tab][aria-selected=true]').focus();true");
          await key("Enter",4); await key("Escape"); await wait(100);
          check(`${theme}-${decision}-${dock}: focused desktop dock owns keys`, calls.filter(row => ["task/approve", "task/reject"].includes(row.op)).length === beforeDockDecisions);
          views.window.setContentSize(width,height); await wait(300);
          check(`${theme}-${decision}-${dock}: narrowing hides approval again`, await evaluate("document.querySelector('[data-testid=desktop-approval-card]').getClientRects().length === 0"));
          await evaluate("document.querySelector('textarea[aria-label=消息]').focus();true");
          await key("Enter",4); await key("Escape"); await wait(100);
          check(`${theme}-${decision}-${dock}: resized hidden approval ignores composer shortcuts`, calls.filter(row => ["task/approve", "task/reject"].includes(row.op)).length === beforeDockDecisions);
          await click("收起工具区");
          check(`${theme}-${decision}-${dock}: return reveals approval`, await evaluate("document.querySelector('[data-testid=desktop-approval-card]').getClientRects().length > 0"));
        }
      }
      await evaluate("document.querySelector('textarea[aria-label=消息]').focus();true");
      await key(decision === "approve" ? "Enter" : "Escape", decision === "approve" ? 4 : 0);
      await key(decision === "approve" ? "Enter" : "Escape", decision === "approve" ? 4 : 0);
      await complete();
      const settled=await hostOp("task/listApprovals",{sessionId:"main"});
      const record=settled.payload.approvals.find(row=>row.id===pending.id);
      check(`${theme}-${decision}: Host records real decision`,record?.status===(decision==="approve"?"approved":"rejected"),record);
      await capture(`${theme}-${decision}-settled`);
    }
    const approved=join(executionRoot,"u03-approved.txt"),denied=join(executionRoot,"u03-denied.txt");
    check(`${theme}: approved command executes exactly once`,existsSync(approved)&&readFileSync(approved,"utf8").split("APPROVED").length-1===(theme==="light"?1:2));
    check(`${theme}: rejected command has no effect`,!existsSync(denied));
    await send(`[ERROR] ${theme} provider unavailable`);
    await until("document.querySelector('[data-testid=desktop-composer-container]')?.innerText.includes('未完成')", "named provider error");
    await until("document.querySelector('[data-testid=composer-context]')?.textContent.includes('未报告')", "unreported failed-request context stays unknown");
    check(`${theme}: unknown context never becomes zero`, !await evaluate("document.querySelector('[data-testid=composer-context]')?.textContent.includes('0.0k')"));
    await capture(`${theme}-error`);
    await input(`draft-${theme} 中文`);
    await sidebarClick("设置");
    await until("document.querySelector('[data-testid=desktop-settings-page]')", "settings");
    await key("Escape");
    await until("document.querySelector('textarea[aria-label=消息]')", "return from settings");
    check(`${theme}: management preserves draft`,await evaluate(`document.querySelector('textarea[aria-label=消息]')?.value === 'draft-${theme} 中文'`));
    await sidebarClick("能力管理");
    await until("document.querySelector('[data-testid=desktop-capabilities-page]')", "capabilities");
    await key("Escape");
    await until("document.querySelector('textarea[aria-label=消息]')", "return from capabilities");
    check(`${theme}: capabilities preserves draft`,await evaluate(`document.querySelector('textarea[aria-label=消息]')?.value === 'draft-${theme} 中文'`));
    await evaluate("document.querySelector('summary[aria-label=\"会话与工具操作\"]').click();true");
    await click("边界复核会话");
    await until("document.querySelector('[data-testid=desktop-session-identity]')?.textContent.includes('边界复核会话')", "switch session");
    await input(`other-${theme}`);
    await evaluate("document.querySelector('summary[aria-label=\"会话与工具操作\"]').closest('details').open=true;true");
    await click("主会话");
    await until(`document.querySelector('textarea[aria-label=消息]')?.value === 'draft-${theme} 中文'`, "restore scoped draft");
    await evaluate("document.querySelector('summary[aria-label=\"会话与工具操作\"]').closest('details').open=false;true");
    await capture(`${theme}-draft-restored`);
  }
  if (!reusedRoot) {
    check("exactly ten message starts for ten explicit sends", calls.filter(row=>row.op==="task/sendMessage").length===10);
    check("one Host decision per approval despite repeated shortcuts", calls.filter(row=>row.op==="task/approve").length===2 && calls.filter(row=>row.op==="task/reject").length===2);
    check("navigation and drafts create no extra session", calls.filter(row=>row.op==="task/sessionCreate").length===1);
    await input("U03 cold restart draft");await wait(400);
  }
  check("task records preserved",tasks.every((task,index)=>readFileSync(join(taskRoot,task.taskId,"task.json"),"utf8")===recordsBefore[index]));
  check("no renderer console errors",consoleErrors.length===0,consoleErrors);
  const shutdown=await shutdownTestRegistry(registry,{origin,label:"U03 capture complete"});
  check("Host shutdown confirmed",shutdown.length===0,shutdown);
  endpoint.close();
  finish(0);
}
void run().catch(error=>finish(1,error.stack??String(error)));
