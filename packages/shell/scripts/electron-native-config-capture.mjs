// #164 production Electron evidence: existing native models/MCP/Skills, safe edits, refresh and actual SDK turns.
// No renderer bridge replacements; local endpoint and test safeStorage are named substitutions.
import { app, utilityProcess } from "electron";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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
const output = resolve(repo, arg("--output", "/tmp/pidock-manual-validation/native-electron"));
const root = mkdtempSync(join(tmpdir(), "pidock-native-config-"));
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
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "packages/renderer/src", "packages/shell/src", "packages/shell/scripts/electron-native-config-capture.mjs", "packages/renderer/package.json", "packages/shell/package.json", "pnpm-lock.yaml", "docs/design/PiDock.pen"], { cwd: repo, encoding: "utf8" }).trim().split("\n");
  const under = path => readdirSync(join(repo, path), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? under(`${path}/${entry.name}`) : [`${path}/${entry.name}`]);
  const manifest = paths => Object.fromEntries([...new Set(paths)].sort().map(path => [path, hash(join(repo, path))]));
  return { source: manifest(paths), build: manifest(under("packages/shell/dist")) };
};
let exiting = false;
const finish = (code, error) => {
  if (exiting) return; exiting = true;
  writeFileSync(join(output, `${width}x${height}-${scenario}-identity.json`), JSON.stringify(identity(), null, 2));
  writeFileSync(join(output, `${width}x${height}-${scenario}-log.json`), JSON.stringify({ size: [width, height], root, scenario, source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), sourceDiffSha256: createHash("sha256").update(execFileSync("git", ["diff", "HEAD", "--", "packages/renderer/src", "packages/shell/src", "packages/shell/scripts/electron-native-config-capture.mjs"], { cwd: repo })).digest("hex"), designSha256: hash(join(repo, "docs/design/PiDock.pen")), buildSha256: hash(join(repo, "packages/shell/dist/renderer/index.html")), node: process.versions.node, electron: process.versions.electron, assertions, shots, calls, requests, consoleErrors, error: error ?? null }, null, 2));
  console.log(`NATIVE_CONFIG_CAPTURE ${width}x${height} ${code} ${error ?? "PASS"}`);
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
  const { McpWiring } = await import("../dist/main/mcp-ipc.js");
  const { SkillSourceStore } = await import("../dist/main/skill-source-store.js");
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
      requests.push({ model: input.model, path: request.url, nativeAuthMatched: request.headers.authorization === "Bearer native-electron-fixture-key", userMessages: input.messages?.filter(message => message.role === "user").length });
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: "u05-response", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50 } } : {}) })}\n\n`;
      response.write(frame({ role: "assistant", content: "U05 已通过所选 Provider 的真实 SDK 会话返回。" }));
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
  const workspace = await projects.create({ name: "原生配置验收工作空间", description: "Production management evidence", directories: [{ name: "shared", path: directory }], repositories: [], environment: [], branchTemplate: "feature/{taskId}" });
  views = await createTrustedWindow("manual-native-config", "production");
  views.window.setContentSize(width, height);
  registry = new PerTaskHostRegistry("manual-native-config", async (workspaceId, task, variables) => {
    const child = utilityProcess.fork(join(import.meta.dirname, "../dist/host/host-entry.js"), [], { serviceName: "manual-native-config-host", env: { ...buildHostEnv(process.env, workspaceId, task, profile, undefined, process.platform, variables), PIDOCK_MCP_CONFIG: join(agentDir, "mcp.json") }, stdio: "pipe" });
    children.push(child);
    child.stderr?.on("data", data => process.stderr.write(data));
    return { child, client: new HostClient(child) };
  }, id => index.resolve(id), undefined, index);
  const route = registry.routeTaskOp.bind(registry);
  registry.routeTaskOp = async request => { calls.push({ op: request.op, taskId: request.taskId }); return await route(request); };
  const profiles = new ProviderProfileStore(profile);
  const providers = new ProviderWiring(profiles, async (taskId, provider, senderWebContentsId) => {
    await registry.routeTaskOp({ taskId, op: "task/sdkProvider", payload: provider === null ? { provider: null } : { provider: { config: profiles.config(provider.profileId, provider.modelId), credential: provider.credential, thinkingLevel: provider.thinkingLevel } }, origin: { kind: "shell-ui", senderWebContentsId } });
  }, process.env, { secrets: new ProviderSecretStore(profile, createTestSafeStorage()), native: new NativeModelsFile(agentDir) });
  const nativeMcp = new NativeMcpFile(agentDir);
  const mcp = new McpWiring(nativeMcp, process.env);
  const creation = new ProjectTaskCreation(new CreationIntentStore(profile), projects, index, registry, taskRoot, undefined, new WorktreeMetadataLock(profile, { notify: () => {} }));
  registerIpc(createUnavailableHostClient(), views.registry, registry, projects, index, undefined, creation, providers, new ServiceCatalog(profile, serviceCatalogAuthority(index, projects)), undefined, undefined, undefined, undefined, mcp);
  const origin = { kind: /** @type {const} */ ("shell-ui"), senderWebContentsId: views.shellView.webContents.id };
  creation.saveDeliverySettings({ branchTemplate: "feature/{taskId}", remote: "origin" });
  const intent = await creation.prepare({ projectId: workspace.id, name: "原生 Provider 真实会话", repositories: [], directoryIds: [workspace.directories[0].id], sharedWriteConfirmed: true, override: false, workspaceMode: "plain-dirs" });
  const task = await creation.commit(intent.id);
  const taskId = task.taskId;
  await registry.routeTaskOp({taskId,op:"task/sessionRename",payload:{sessionId:"main",name:"主会话"},origin});
  process.env.NATIVE_FIXTURE_KEY = "native-electron-fixture-key";
  const nativeModelsPath = join(agentDir, "models.json");
  writeFileSync(nativeModelsPath, JSON.stringify({ keep: { unknown: 17 }, providers: { existing_native: {
    name: "原生已存在 Provider", api: "openai-completions", baseUrl: `${base}/v1`, apiKey: "$NATIVE_FIXTURE_KEY",
    custom: { keep: true }, models: [{ id: MODEL, contextWindow: 32768, maxTokens: 2048, customRow: 42 }],
  } } }));
  const skillPath = join(root, "native-skills");
  mkdirSync(join(skillPath, "native-review"), { recursive: true });
  writeFileSync(join(skillPath, "native-review", "SKILL.md"), "---\nname: native-review\ndescription: Inspect native fixture changes.\n---\nRead the fixture changes.\n");
  const originalSettings = JSON.stringify({ skills: [skillPath], unknownSettings: true });
  writeFileSync(join(agentDir, "settings.json"), originalSettings);
  writeFileSync(join(agentDir, "keybindings.json"), '{"app.interrupt":"escape","unknown":17}');
  const skillStore = new SkillSourceStore(profile, undefined, agentDir);
  const nativeMcpOriginal = { command: process.execPath, args: [join(import.meta.dirname, "fixtures/mcp-stdio-fixture.mjs")], exposure: "direct", custom: { keep: 17 } };
  writeFileSync(nativeMcp.path, JSON.stringify({ mcpServers: { native_fixture: nativeMcpOriginal }, customRoot: true }));
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
  };
  const openTask = async () => {
    await sidebarClick("原生 Provider 真实会话");
    await until("document.querySelector('[data-testid=desktop-task-facts]')", "task facts");
    await click("进入对话 · 主会话");
    await until("document.querySelector('textarea[aria-label=消息]')", "conversation");
  };
  check("built production file renderer", /^file:.*\/renderer\/index.html$/.test(await evaluate("location.href")));
  check("immutable design provenance", hash(join(repo, "docs/design/PiDock.pen")) === "149ef57c1394e0e6b4af3e40663b8dd1c8c93d766eb370c7d05029afa2480707");
  for (const theme of ["light", "dark"]) {
    await evaluate(`window.pidock.preferencesOp({op:'appearance/save',appearance:'${theme}'})`);
    wc.reload();
    await until(`document.documentElement?.dataset.theme === '${theme}' && document.querySelector('[data-testid=desktop-sidebar]')`, "theme boot");
    await openTask();
    await sidebarClick("能力管理");
    await until("document.querySelector('.provider-row')?.innerText.includes('原生')", "existing native visible");
    check(`${theme}: user-owned provider visible`, await evaluate("document.body.innerText.includes('原生已存在 Provider')"));
    await capture(`${theme}-native-provider-list`);
    await click("编辑");
    check(`${theme}: native auth never exposed as input`, await evaluate("!document.querySelector('[aria-label=\"API Key\"]') && document.querySelector('[aria-label=\"模型 ID 1\"]').readOnly"));
    await fill("名称", "原生已存在 Provider");
    await fill("Base URL", `${base}/edited/v1`);
    await capture(`${theme}-native-provider-edit`);
    await click("保存并写入 models.json");
    await until("document.querySelector('.provider-row')", "native save");
    const document = JSON.parse(readFileSync(nativeModelsPath, "utf8"));
    check(`${theme}: native identity/auth/unknown preservation`, Object.keys(document.providers).join() === "existing_native" && document.providers.existing_native.apiKey === "$NATIVE_FIXTURE_KEY" && document.providers.existing_native.custom.keep && document.providers.existing_native.models[0].customRow === 42 && document.keep.unknown === 17);
    await evaluate("document.querySelector('.provider-details').open=true;true");
    await click("选用");
    await until("document.querySelector('[data-testid^=provider-current-]')", "native selection");
    for (let attempt = 0; attempt < 100 && providers.status(taskId).state !== "configured"; attempt++) await wait(50);
    check(`${theme}: native selected in real Host`, providers.status(taskId).state === "configured", providers.status(taskId).state);
    await capture(`${theme}-native-provider-selected`);
    await pane("MCP");
    await until("document.querySelector('[data-testid=mcp-row]')", "native MCP");
    await capture(`${theme}-native-mcp`);
    await click("测试");
    await until("document.querySelector('[data-testid=mcp-test-result][data-state=connected]')", "native MCP handshake");
    await click("停用");
    check(`${theme}: native MCP disable preserves all other fields`, JSON.stringify(nativeMcp.entry("native_fixture")) === JSON.stringify({ ...nativeMcpOriginal, enabled: false }));
    await click("启用");
    await pane("Skills");
    await until("document.body.innerText.includes('native-review')", "native Skills");
    await capture(`${theme}-native-skills`);
    const source = skillStore.view().sources.find(row => row.path === skillPath);
    check(`${theme}: native skill original ownership`, source.ownership === "native");
    await evaluate(`document.querySelector('[data-testid="skill-toggle-${source.id}"]').click();true`);
    await until(`document.querySelector('[data-testid="skill-toggle-${source.id}"]').innerText==='启用'`, "native skill disabled");
    check(`${theme}: native skill disable keeps settings bytes`, readFileSync(join(agentDir,"settings.json"),"utf8") === originalSettings && skillStore.sessionPaths().length === 0);
    await evaluate(`document.querySelector('[data-testid="skill-toggle-${source.id}"]').click();true`);
    await click("返回任务工作区");
    await until("document.querySelector('textarea[aria-label=消息]')", "restored task");
    await fill("消息", `native ${theme} turn`);
    await until("!document.querySelector('button[aria-label=发送]')?.disabled", "native send ready");
    await click("发送");
    await until("document.body.innerText.includes('U05 已通过所选 Provider')", "real SDK response");
    check(`${theme}: native endpoint/model/auth actually consumed`, requests.at(-1)?.model === MODEL && requests.at(-1)?.path === "/edited/v1/chat/completions" && requests.at(-1)?.nativeAuthMatched);
    await wait(350);
    await sidebarClick("能力管理");
    await until("document.querySelector('.provider-row')", "external edit provider list");
    const external = JSON.parse(readFileSync(nativeModelsPath,"utf8"));
    external.providers.existing_native.name = "原生外部修改可见";
    writeFileSync(nativeModelsPath, JSON.stringify(external));
    await click("刷新原生配置");
    await until("document.body.innerText.includes('原生外部修改可见')", "fresh external edit observed");
    check(`${theme}: external edit fences existing session`, providers.status(taskId).state === "binding-stale");
    await capture(`${theme}-native-external-refresh`);
    external.providers.existing_native.name = "原生已存在 Provider";
    writeFileSync(nativeModelsPath, JSON.stringify(external));
    await click("刷新原生配置");
  }
  check("no renderer console errors", consoleErrors.length === 0, consoleErrors);
  const shutdown = await shutdownTestRegistry(registry, { origin, label: "Native config capture" });
  check("owned Host shutdown completed", shutdown.length === 0, shutdown);
  endpoint.close();
  rmSync(root, { recursive: true, force: true });
  finish(0);
}
void run();
