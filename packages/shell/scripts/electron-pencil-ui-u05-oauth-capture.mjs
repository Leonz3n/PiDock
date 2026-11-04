// #160 production Electron evidence. Temporary disk/API fixtures drive production wiring.
// No renderer bridge replacements; local endpoint and test safeStorage are named substitutions.
import { app, utilityProcess } from "electron";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createUnavailableHostClient } from "./unavailable-host-client.mjs";
import { shutdownTestRegistry } from "./shutdown-test-registry.mjs";

delete process.env.PIDOCK_RENDERER_URL;
delete process.env.PIDOCK_TASK_URL;
const arg = (key, fallback) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
const [width, height] = arg("--size", "1440x900").split("x").map(Number);
const scenario = arg("--scenario", "oauth");
const repo = resolve(import.meta.dirname, "../../..");
const output = resolve(repo, arg("--output", "docs/evidence/pencil-ui-u05-oauth1/electron"));
const root = mkdtempSync(join(tmpdir(), "pidock-ui-u05-"));
const profile = join(root, "profile");
const taskRoot = join(root, "tasks");
const agentDir = join(root, "agent", "native-configuration-directory-with-a-long-name-for-path-wrapping");
for (const path of [profile, taskRoot, agentDir, output]) mkdirSync(path, { recursive: true });
app.setPath("userData", profile);
process.env.PIDOCK_AGENT_DIR = agentDir;
const wait = ms => new Promise(done => setTimeout(done, ms));
const assertions = [], shots = [], calls = [], consoleErrors = [], requests = [];
const MODEL = "loopback-chat-model-with-a-very-long-name-to-exercise-selection-and-wrapping-160";
let views, registry, endpoint, discoveryMode = "success";
const children = [];
/** @param {string} name @param {unknown} condition @param {unknown} detail */
const check = (name, condition, detail = "") => { assertions.push({ name, passed: Boolean(condition), detail }); console.log("CHECK", name, Boolean(condition)); if (!condition) throw Error(`ASSERT FAILED: ${name}: ${JSON.stringify(detail)}`); };
const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const identity = () => {
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "packages/renderer/src", "packages/shell/src", "packages/shell/scripts/electron-pencil-ui-u05-oauth-capture.mjs", "packages/shell/scripts/fixtures/mcp-oauth-server.mjs", "packages/renderer/package.json", "packages/shell/package.json", "pnpm-lock.yaml", "docs/design/PiDock.pen"], { cwd: repo, encoding: "utf8" }).trim().split("\n");
  const under = path => readdirSync(join(repo, path), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? under(`${path}/${entry.name}`) : [`${path}/${entry.name}`]);
  const manifest = paths => Object.fromEntries([...new Set(paths)].sort().map(path => [path, hash(join(repo, path))]));
  return { source: manifest(paths), build: manifest(under("packages/shell/dist")) };
};
let exiting = false;
const finish = (code, error) => {
  if (exiting) return; exiting = true;
  writeFileSync(join(output, `${width}x${height}-${scenario}-identity.json`), JSON.stringify(identity(), null, 2));
  writeFileSync(join(output, `${width}x${height}-${scenario}-log.json`), JSON.stringify({ size: [width, height], root, scenario, source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), sourceDiffSha256: createHash("sha256").update(execFileSync("git", ["diff", "HEAD", "--", "packages/renderer/src", "packages/shell/src", "packages/shell/scripts/electron-pencil-ui-u05-oauth-capture.mjs"], { cwd: repo })).digest("hex"), designSha256: hash(join(repo, "docs/design/PiDock.pen")), buildSha256: hash(join(repo, "packages/shell/dist/renderer/index.html")), node: process.versions.node, electron: process.versions.electron, assertions, shots, calls, requests, consoleErrors, error: error ?? null }, null, 2));
  console.log(`U05_CAPTURE ${width}x${height} ${code} ${error ?? "PASS"}`);
  for (const child of children) { try { child.kill(); } catch { /* already exited */ } }
  app.exit(code);
};
setTimeout(() => finish(1, "watchdog timeout"), 180000).unref();
process.on("uncaughtException", error => finish(1, error.stack));
process.on("unhandledRejection", error => finish(1, String(error instanceof Error ? error.stack : error)));
app.on("window-all-closed", () => {});

async function run() {
  const { buildHostEnv } = await import("../dist/host/host-guards.js");
  const { TaskRootIndex } = await import("../dist/main/task-root-index.js");
  const { ProjectRegistry } = await import("../dist/main/project-registry.js");
  const { ServiceCatalog, serviceCatalogAuthority } = await import("../dist/main/service-catalog.js");
  const { createTrustedWindow, loadTrustedViews, PerTaskHostRegistry, registerIpc } = await import("../dist/main/runtime.js");
  const { CreationIntentStore, ProjectTaskCreation } = await import("../dist/main/project-task-creation.js");
  const { WorktreeMetadataLock } = await import("../dist/main/worktree-metadata-lock.js");
  const { ProviderProfileStore } = await import("../dist/main/provider-profile-store.js");
  const { ProviderWiring } = await import("../dist/main/provider-ipc.js");
  const { ProviderSecretStore, createTestSafeStorage } = await import("../dist/main/provider-secret-store.js");
  const { NativeModelsFile } = await import("../dist/main/native-models-config.js");
  const { NativeMcpFile } = await import("../dist/main/native-mcp-config.js");
  const { McpOAuth } = await import("../dist/main/mcp-oauth.js");
  const { oauthFixture } = await import("./fixtures/mcp-oauth-server.mjs");
  const authorizationServer = await oauthFixture();
  let browserMode = "hold", browserUrl, browserOpens = 0;
  const nativeMcp = new NativeMcpFile(agentDir);
  const oauth = await McpOAuth.create(nativeMcp, profile, createTestSafeStorage(), async url => {
    browserUrl = url; browserOpens++;
    if (browserMode === "complete") await fetch(url);
  });
  const { McpWiring } = await import("../dist/main/mcp-ipc.js");
  const { HostClient } = await import("../dist/rpc/host-client.js");
  endpoint = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += String(chunk); });
    request.on("end", () => {
      if (request.url === "/http-mcp") {
        const rpc = body ? JSON.parse(body) : {};
        if (!rpc.id) { response.writeHead(202).end(); return; }
        const result = rpc.method === "initialize" ? { protocolVersion:"2025-06-18", capabilities:{tools:{}}, serverInfo:{name:"u05-http",version:"1.0"} }
          : rpc.method === "tools/list" ? {tools:[{name:"http_echo",description:"Real loopback HTTP MCP tool",inputSchema:{type:"object",properties:{}}}]} : {};
        response.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id:rpc.id,result})); return;
      }
      if (request.url === "/auth-mcp") { response.writeHead(401, { "www-authenticate": "Bearer" }).end("authentication required"); return; }
      if (request.url?.endsWith("/models")) {
        if (discoveryMode === "failure") { response.writeHead(503).end(); return; }
        const done = () => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: MODEL }, { id: "discovered-second" }] }));
        if (discoveryMode === "loading") setTimeout(done, 1400); else done();
        return;
      }
      if (!request.url?.endsWith("/chat/completions")) { response.writeHead(404).end(); return; }
      const input = JSON.parse(body);
      requests.push({ model: input.model, userMessages: input.messages?.filter(message => message.role === "user").length });
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: "u05-response", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50 } } : {}) })}\n\n`;
      const requested = input.tools?.find(tool=>tool.function?.name.startsWith("mcp__native_oauth_"));
      if (input.messages.at(-1)?.role !== "tool" && requested) {
        response.write(frame({role:"assistant",tool_calls:[{index:0,id:"oauth-call-"+requests.length,type:"function",function:{name:requested.function.name,arguments:JSON.stringify({message:"production-approved-oauth"})}}]}));
        response.write(frame({},"tool_calls"));response.end("data: [DONE]\n\n");return;
      }
      response.write(frame({ role: "assistant", content: input.messages.at(-1)?.role === "tool" ? "OAuth result delivered: " + input.messages.at(-1).content : "U05 已通过所选 Provider 的真实 SDK 会话返回。" }));
      setTimeout(() => { response.write(frame({}, "stop")); response.end("data: [DONE]\n\n"); }, 100);
    });
  });
  await new Promise(done => endpoint.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(/** @type {import("node:net").AddressInfo} */ (endpoint.address())).port}`;
  await app.whenReady();
  const index = new TaskRootIndex(profile, taskRoot);
  const projects = new ProjectRegistry(profile);
  const directory = join(root, "sources", "plain-directory");
  mkdirSync(directory, { recursive: true });
  const workspace = await projects.create({ name: "U05 管理验收工作空间", description: "Production management evidence", directories: [{ name: "shared", path: directory }], repositories: [], environment: [], branchTemplate: "feature/{taskId}" });
  views = await createTrustedWindow("pencil-ui-u05", "production");
  views.window.setContentSize(width, height);
  registry = new PerTaskHostRegistry("pencil-ui-u05", async (workspaceId, task, variables) => {
    const child = utilityProcess.fork(join(import.meta.dirname, "../dist/host/host-entry.js"), [], { serviceName: "pencil-ui-u05-host", env: { ...buildHostEnv(process.env, workspaceId, task, profile, undefined, process.platform, variables), PIDOCK_MCP_CONFIG: nativeMcp.path }, stdio: "pipe" });
    children.push(child);
    child.stderr?.on("data", data => process.stderr.write(data));
    return { child, client: new HostClient(child) };
  }, id => index.resolve(id), undefined, index);
  const route = registry.routeTaskOp.bind(registry);
  registry.routeTaskOp = async request => { calls.push({ op: request.op, taskId: request.taskId }); return await route(request); };
  const profiles = new ProviderProfileStore(profile);
  const providers = new ProviderWiring(profiles, async (taskId, provider, senderWebContentsId) => {
    await registry.routeTaskOp({ taskId, op: "task/sdkProvider", payload: provider === null ? { provider: null } : { provider: { config: profiles.config(provider.profileId), credential: provider.credential, mcpPrivate: await oauth.hostBinding() } }, origin: { kind: "shell-ui", senderWebContentsId } });
  }, process.env, { secrets: new ProviderSecretStore(profile, createTestSafeStorage()), native: new NativeModelsFile(agentDir) });
  const mcp = new McpWiring(nativeMcp, process.env, undefined, oauth);
  const creation = new ProjectTaskCreation(new CreationIntentStore(profile), projects, index, registry, taskRoot, undefined, new WorktreeMetadataLock(profile, { notify: () => {} }));
  registerIpc(createUnavailableHostClient(), views.registry, registry, projects, index, undefined, creation, providers, new ServiceCatalog(profile, serviceCatalogAuthority(index, projects)), undefined, undefined, undefined, undefined, mcp);
  const origin = { kind: /** @type {const} */ ("shell-ui"), senderWebContentsId: views.shellView.webContents.id };
  creation.saveDeliverySettings({ branchTemplate: "feature/{taskId}", remote: "origin" });
  const intent = await creation.prepare({ projectId: workspace.id, name: "U05 Provider 真实会话", repositories: [], directoryIds: [workspace.directories[0].id], sharedWriteConfirmed: true, override: false, workspaceMode: "plain-dirs" });
  const task = await creation.commit(intent.id);
  const taskId = task.taskId;
  await registry.routeTaskOp({taskId,op:"task/sessionRename",payload:{sessionId:"main",name:"主会话"},origin});
  await loadTrustedViews(views);
  const wc = views.shellView.webContents;
  wc.on("console-message", (_event, level, message) => { if (level >= 3) consoleErrors.push(message); });
  wc.debugger.attach();
  const evaluate = async expression => {
    const result = await wc.debugger.sendCommand("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async (expression, label) => {
    for (let attempt = 0; attempt < 160; attempt++) { if (await evaluate(`Boolean(${expression})`)) return; await wait(50); }
    throw Error(`timeout ${label}`);
  };
  const click = async label => {
    await until(`[...document.querySelectorAll('button')].some(el => (el.getAttribute('aria-label') ?? el.textContent.trim()) === ${JSON.stringify(label)} && el.getBoundingClientRect().width > 0)`, `control ${label}`);
    check(`reachable control: ${label}`, await evaluate(`(() => { const el = [...document.querySelectorAll('button')].find(el => (el.getAttribute('aria-label') ?? el.textContent.trim()) === ${JSON.stringify(label)} && el.getBoundingClientRect().width > 0); if (!el || el.disabled) return false; el.scrollIntoView({block:'nearest'}); el.click(); return true; })()`));
    await wait(120);
  };
  const sidebarClick = async label => {
    if (width < 960 && !(await evaluate("document.querySelector('[data-testid=desktop-sidebar]')?.dataset.expanded === 'true'"))) await click("展开导航");
    await click(label);
    if (width < 960 && await evaluate("document.querySelector('[data-testid=desktop-sidebar]')?.dataset.expanded === 'true'")) await click("收起导航");
  };
  const pane = async name => {
    await evaluate(`document.querySelector('nav[aria-label="能力管理"] button[aria-current=page]'); [...document.querySelectorAll('nav[aria-label="能力管理"] button')].find(el => el.textContent.startsWith(${JSON.stringify(name)})).click();true`);
    await wait(160);
  };
  const fill = async (label, value) => {
    await evaluate(`(() => { const el = document.querySelector('[aria-label=${JSON.stringify(label)}]') ?? document.getElementById(${JSON.stringify(label)}); if (!el) throw Error('missing input'); el.scrollIntoView({block:'center'}); el.focus(); el.select(); })()`);
    await wc.debugger.sendCommand("Input.insertText", { text: value });
    await wait(50);
  };
  const capture = async state => {
    if (state.endsWith("providers-list") || state.endsWith("mcp-list") || state.endsWith("skills-scan-long-path")) await evaluate("document.querySelector('[data-testid=management-content]').scrollTop=0;true");
    views.window.show(); app.focus({ steal: true }); views.window.moveTop(); views.window.focus(); await wait(160);
    const metrics = await evaluate(`(() => { const box = el => { if (!el) return null; const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,scrollWidth:el.scrollWidth,scrollHeight:el.scrollHeight}; }; return {viewport:[innerWidth,innerHeight],theme:document.documentElement.dataset.theme,header:box(document.querySelector('[data-testid=management-header]')),nav:box(document.querySelector('nav[aria-label="能力管理"]')),content:box(document.querySelector('[data-testid=management-content]')),rows:[...document.querySelectorAll('.provider-row, .mcp-row')].map(box),form:box(document.querySelector('[data-testid=provider-form]')),horizontalOverflow:document.documentElement.scrollWidth>innerWidth,contentOverflow:document.querySelector('[data-testid=management-content]')?.scrollWidth>document.querySelector('[data-testid=management-content]')?.clientWidth,workSidebar:!!document.querySelector('[data-testid=desktop-sidebar]'),activeNav:document.querySelector('nav[aria-label="能力管理"] [aria-current=page]')?.textContent,unmaskedKey:!!document.querySelector('input[aria-label="API Key"][type=text]')}; })()`);
    const name = `${width}x${height}-${state}.png`;
    const shot = await wc.debugger.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(join(output, name), Buffer.from(shot.data, "base64"));
    shots.push({ file: name, sha256: hash(join(output, name)), metrics });
    check(`${state}: exact viewport`, metrics.viewport[0] === width && metrics.viewport[1] === height, metrics.viewport);
    check(`${state}: no document or content horizontal overflow`, !metrics.horizontalOverflow && !metrics.contentOverflow, metrics);
    check(`${state}: one 52px header and dedicated 240px navigation`, !metrics.workSidebar && metrics.header.height === 52 && metrics.nav.width === 240, metrics);
    check(`${state}: keys remain masked`, !metrics.unmaskedKey);
    if (state.endsWith("providers-list") && width === 1440) {
      check(`${state}: S03 first row y147±4px`, Math.abs(metrics.rows[0].y - 147) <= 4, metrics.rows);
      check(`${state}: S03 row density 60±4px`, metrics.rows.every(row => row.height >= 56 && row.height <= 64), metrics.rows);
    }
  };
  const openTask = async () => {
    await sidebarClick("U05 Provider 真实会话");
    await until("document.querySelector('[data-testid=desktop-task-facts]')", "task facts");
    await click("进入对话 · 主会话");
    await until("document.querySelector('textarea[aria-label=消息]')", "conversation");
  };
  check("built production file renderer", /^file:.*\/renderer\/index.html$/.test(await evaluate("location.href")));
  writeFileSync(nativeMcp.path, JSON.stringify({mcpServers:{native_oauth:{url:`${authorizationServer.base}/mcp`,oauth:{clientRegistration:"dcr"},exposure:"direct",description:"Native OAuth · 私有回环服务"}}}));
  for (const theme of ["light", "dark"]) {
    // Separate exact-name stores prevent prior theme state affecting the next.
    const config = JSON.parse(readFileSync(nativeMcp.path,"utf8"));
    const name = `native_oauth_${theme}`;
    config.mcpServers = {[name]:{...Object.values(config.mcpServers)[0]}};
    writeFileSync(nativeMcp.path,JSON.stringify(config));
    await evaluate(`window.pidock.preferencesOp({op:'appearance/save',appearance:'${theme}'})`);
    wc.reload();
    await until(`document.documentElement?.dataset.theme === '${theme}' && document.querySelector('[data-testid=desktop-sidebar]')`, "theme boot");
    await openTask();
    const draftText = `OAuth ${theme} 原任务草稿`;
    await fill("消息",draftText);
    const before = await registry.routeTaskOp({taskId,op:"task/sessionList",payload:{},origin});
    await sidebarClick("能力管理");
    await pane("MCP");
    await until("document.querySelector('[data-testid=mcp-oauth][data-state=signed-out]')", "signed-out state");
    await capture(`${theme}-oauth-signed-out`);
    await click("测试");
    await until("document.querySelector('[data-testid=mcp-test-result]')?.innerText.includes('需要认证')", "real challenge");
    await capture(`${theme}-oauth-auth-required`);
    browserMode="hold"; browserUrl=undefined;
    await click("登录");
    await until("document.querySelector('[data-testid=mcp-oauth][data-state=signing-in]')", "waiting browser");
    await capture(`${theme}-oauth-signing-in`);
    check(`${theme}: native browser opener invoked with HTTP URL`,String(browserUrl).startsWith(authorizationServer.base));
    const staleBrowser=String(browserUrl);
    await click("取消登录");
    await until("document.querySelector('[data-testid=mcp-oauth][data-state=cancelled]')", "cancelled state");
    await capture(`${theme}-oauth-cancelled`);
    await fetch(staleBrowser).catch(()=>undefined);
    check(`${theme}: late callback cannot log in`,(await oauth.status(name)).state === "cancelled");
    authorizationServer.mode("failure");browserMode="complete";
    await click("登录");
    await until("document.querySelector('[data-testid=mcp-oauth][data-state=failed]')", "denied state");
    await capture(`${theme}-oauth-failed`);
    authorizationServer.mode("success");
    await click("登录");
    await until("document.querySelector('[data-testid=mcp-oauth][data-state=signed-in]')", "signed-in state");
    await capture(`${theme}-oauth-signed-in`);
    await click("测试");
    await until("document.querySelector('[data-testid=mcp-test-result][data-state=connected]')", "authenticated connection");
    await capture(`${theme}-oauth-connected`);
    check(`${theme}: authenticated tool list`,await evaluate("document.querySelector('[data-testid=mcp-test-result]').innerText.includes('echo')"));
    const refreshesBefore=authorizationServer.requests.filter(request=>request.kind === "token" && request.grant === "refresh_token").length;
    authorizationServer.revoke();authorizationServer.expires(0);
    await click("测试");
    await until("document.querySelector('[data-testid=mcp-test-result][data-state=connected]')", "rotated refresh connection");
    check(`${theme}: actual upstream refresh`,authorizationServer.requests.filter(request=>request.kind === "token" && request.grant === "refresh_token").length > refreshesBefore);
    await until("document.querySelector('[data-testid=mcp-oauth][data-state=expired]')", "expired token status");
    await capture(`${theme}-oauth-expired`);
    authorizationServer.expires(3600);
    await click("重新登录");
    await until("document.querySelector('[data-testid=mcp-oauth][data-state=signed-in]')", "relogin state");
    await capture(`${theme}-oauth-relogin`);
    const privateText = JSON.stringify(await evaluate("window.pidock.mcpOp({op:'oauth-status',name:"+JSON.stringify(name)+"})"));
    check(`${theme}: renderer status contains no private credential`, !/private-access|private-refresh|private-code|codeVerifier|oauthState/.test(privateText));
    await click("返回任务工作区");
    await until("document.querySelector('textarea[aria-label=消息]')", "return conversation");
    check(`${theme}: draft preserved`,await evaluate("document.querySelector('textarea[aria-label=消息]').value") === draftText);
    const after=await registry.routeTaskOp({taskId,op:"task/sessionList",payload:{},origin});
    check(`${theme}: session list unchanged`,JSON.stringify(before.payload.sessions) === JSON.stringify(after.payload.sessions));
    // Select only after sign-in: the existing session is never reloaded by login.
    await sidebarClick("能力管理");
    await until("document.querySelector('[data-testid=providers-panel]')", "provider pane");
    if (theme === "light") {
      await click("＋添加供应商");
      await fill("名称","OAuth Production Provider");await fill("Base URL",`${base}/v1`);
      await fill("API Key","private-local-model-credential");await fill("模型 ID 1",MODEL);await fill("显示名称 1","OAuth Loopback");
      await evaluate(`(() => {const el=document.querySelector('select[aria-label="默认模型"]');el.value=${JSON.stringify(MODEL)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await click("保存并写入 models.json");
      await until("document.querySelector('.provider-row')","saved profile");
    }
    await evaluate("document.querySelector('.provider-details').open=true;true");await click("选用");
    await until("document.querySelector('[data-testid^=provider-current-]')", "provider installed");
    await click("返回任务工作区");
    await fill("消息",`OAuth invoke ${theme}`);
    await until("!document.querySelector('button[aria-label=发送]')?.disabled", "send ready");await click("发送");
    await until("document.querySelector('[data-testid=desktop-approval-approve]')", "authenticated tool approval");
    const beforeCalls=authorizationServer.requests.filter(request=>request.method === "tools/call").length;
    check(`${theme}: OAuth execution waits for Host approval`,beforeCalls === (theme === "light" ? 0 : 1));
    await click("批准");
    await until("document.body.innerText.includes('OAuth result delivered:')", "OAuth tool result in original conversation");
    await wait(500);
    check(`${theme}: authenticated production tool executed once`,authorizationServer.requests.filter(request=>request.method === "tools/call").length === beforeCalls+1);
    check(`${theme}: selected Provider model used`,requests.at(-1)?.model === MODEL);

  }
  check("real browser-open boundary used",browserOpens>=6,browserOpens);
  await oauth.close();await authorizationServer.close();
  check("no renderer console errors", consoleErrors.length === 0, consoleErrors);
  const shutdown = await shutdownTestRegistry(registry, { origin, label: "U05 capture" });
  check("owned Host shutdown completed", shutdown.length === 0, shutdown);
  endpoint.close();
  finish(0);
}
void run();
