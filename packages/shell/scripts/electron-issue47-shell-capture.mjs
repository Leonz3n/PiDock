// [UI 对齐 S8] #47 evidence: capture the production Desktop (real Host) at the
// prototype-A tiers. Run after `pnpm --filter @pidock/shell build`:
//   pnpm --filter @pidock/shell exec electron scripts/electron-issue47-shell-capture.mjs
//
// It boots the real production main (no fixture entry), creates one real task in
// an isolated root, configures an explicit Provider against a loopback endpoint,
// runs one real turn, and writes 1440×900 / 720×560 screenshots plus the measured
// horizontal overflow. Nothing is faked: the conversation and usage come from the
// task's SDK JSONL.
import { app, utilityProcess } from "electron";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTaskDiskRecord, serializeTaskRecord } from "../dist/host/task-store.js";
import { buildHostEnv } from "../dist/host/host-guards.js";
import { TaskRootIndex } from "../dist/main/task-root-index.js";
import { ProjectRegistry } from "../dist/main/project-registry.js";
import { ServiceCatalog, serviceCatalogAuthority } from "../dist/main/service-catalog.js";
import { createTrustedWindow, loadTrustedViews, PerTaskHostRegistry, registerIpc } from "../dist/main/runtime.js";
import { ProviderProfileStore } from "../dist/main/provider-profile-store.js";
import { ProviderWiring } from "../dist/main/provider-ipc.js";
import { HostClient } from "../dist/rpc/host-client.js";
import { shutdownTestRegistry } from "./shutdown-test-registry.mjs";

const CREDENTIAL = "issue47-synthetic-credential-0123456789";
const AUTH_REF = "PIDOCK_PROVIDER_ISSUE47";
const PRIVATE_VALUE = "synthetic-config-preview-secret-87654321";
const output = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : tmpdir();
const root = mkdtempSync(join(tmpdir(), "pidock-issue47-capture-"));
const profile = join(root, "profile"), taskRoot = join(root, "tasks"), taskDir = join(taskRoot, "task-abcdef12");
mkdirSync(profile); mkdirSync(taskRoot); mkdirSync(taskDir); mkdirSync(output, { recursive: true });
app.setPath("userData", profile);
const taskId = "task-abcdef12";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = [];
const watchdog = setTimeout(() => { console.error("ISSUE47_CAPTURE_TIMEOUT", root); process.exit(1); }, 60000);
// Test-only guard: prevent Electron's default quit racing the explicit
// app.exit(process.exitCode) with a false-pass exit 0.
app.on("window-all-closed", () => {});
let views, registry, server;

function startProvider() {
  return new Promise((resolve) => {
    server = createServer((request, response) => {
      request.on("data", () => {});
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        const frame = (delta) => `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", model: "issue47-model", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
        response.write(frame({ content: "当前任务已准备独立的工作副本。" }));
        response.write(frame({ content: "前端与 BFF 使用本任务的 invoice 与 shipment，其他依赖沿用测试环境。" }));
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 24800, completion_tokens: 421, total_tokens: 25221 } })}\n\n`);
        response.write("data: [DONE]\n\n");
        response.end();
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function run() {
  let captureStage = "startup";
  try {
    const port = await startProvider();
    process.env[AUTH_REF] = CREDENTIAL;
    await app.whenReady();
    execFileSync("git", ["init", "-q", taskDir]);
    // A real workspace root, so the 文件 panel lists real files: roots come from
    // the task record's `repos`, each materialised under the task directory.
    const repoDir = join(taskDir, "invoice-service");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "README.md"), "# invoice-service\n\n对账单详情服务的本地工作副本。\n");
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ scripts: { dev: "PORT=4100 API_TOKEN=synthetic-secret-import-guard node private-command-marker" } }));
    writeFileSync(join(repoDir, "src", "billing.ts"), "export function invoiceTotal(lines: number[]) {\n  return lines.reduce((sum, value) => sum + value, 0);\n}\n");
    mkdirSync(join(repoDir, ".vscode"));
    writeFileSync(join(repoDir, ".vscode", "launch.json"), JSON.stringify({ configurations: [
      { name: "invoice-dev", program: "node", args: ["private-command-marker"], env: { API_TOKEN: "synthetic-secret-import-guard" } },
    ] }));
    writeFileSync(join(taskDir, "task.json"), serializeTaskRecord(buildTaskDiskRecord({ taskId, name: "对账单详情·本地联调", dirId: taskId, branch: "main", root: taskRoot, taskDir, remoteBranch: "main", baseCommit: "test", repos: ["invoice-service"], now: new Date().toISOString() })));
    const index = new TaskRootIndex(profile, taskRoot);
    const projects = new ProjectRegistry(profile);
    const catalog = new ServiceCatalog(profile, serviceCatalogAuthority(index, projects));
    registry = new PerTaskHostRegistry("issue47", async (workspace, task) => {
      const entry = join(import.meta.dirname, "..", "dist", "host", "host-entry.js");
      const child = utilityProcess.fork(entry, [], { serviceName: "issue47-host", env: buildHostEnv(process.env, workspace, task, app.getPath("userData")), stdio: "pipe" });
      children.push(child);
      child.stderr?.on("data", (data) => process.stderr.write(`[issue47-host] ${data}`));
      return { child, client: new HostClient(child) };
    }, (id) => index.resolve(id), undefined, index);
    const profiles = new ProviderProfileStore(profile);
    const providers = new ProviderWiring(profiles, async (id, provider, senderWebContentsId) => {
      const payload = provider === null ? { provider: null } : { provider: { config: profiles.config(provider.profileId), credential: provider.credential } };
      await registry.routeTaskOp({ workspaceId: "issue47", taskId: id, op: "task/sdkProvider", payload, origin: { kind: "shell-ui", senderWebContentsId } });
    });
    const saved = profiles.save({ name: "Loopback", baseUrl: `http://127.0.0.1:${port}/v1`, modelId: "issue47-model", contextWindow: 200000, maxTokens: 8192, authRef: AUTH_REF });
    profiles.select(taskId, saved.id);
    // A real source repository bound to the Project, so 项目总览 shows a real
    // 项目仓库 row (the task worktree above is a task-scoped copy, not a binding).
    const sourceRepo = join(root, "sources", "invoice-service");
    mkdirSync(sourceRepo, { recursive: true });
    writeFileSync(join(sourceRepo, "README.md"), "# invoice-service 源仓库\n");
    const project = await projects.create({ name: "Adder", description: "微服务开发工作台", repositories: [{ name: "invoice-service", path: sourceRepo }], directories: [] });
    await projects.claim(taskId, project.id, index);
    // Fix the service-owner catalog before the first Host bootstrap. The strict
    // owner snapshot is a single revision for the Host lifetime, so the saved
    // template/binding and its private environment reference must exist before
    // any task op forks the utilityProcess. The missing-reference preview is
    // checked from trusted main with an empty environment, then the synthetic
    // value is installed and kept unchanged through shutdown.
    const serviceTemplate = catalog.saveTemplate({ projectId: project.id, descriptor: { name: "invoice-local", program: "node", args: ["server.js"], ports: [4100], runType: "long-lived" }, shared: [{ key: "PORT", value: "4100", secret: false }] });
    catalog.bindTask({ taskId, serviceId: serviceTemplate.serviceId, templateVersion: 1, rootId: "invoice-service", subdir: "", programPath: process.execPath, privateRefs: [{ key: "API_TOKEN", envRef: "PIDOCK_SERVICE_CAPTURE_TOKEN" }] });
    const blockedPreview = catalog.previewSavedConfig(project.id, taskId, serviceTemplate.serviceId, {});
    if (blockedPreview.state !== "blocked" || blockedPreview.error !== "private-reference-unavailable") throw Error("missing private reference preview unavailable before bootstrap");
    process.env["PIDOCK_SERVICE_CAPTURE_TOKEN"] = PRIVATE_VALUE;
    views = await createTrustedWindow("issue47", "production");
    // The capture injects a trusted test picker result; native dialog interaction is manual acceptance.
    registerIpc({}, views.registry, registry, projects, index, undefined, undefined, providers, catalog, async () => process.execPath);
    await loadTrustedViews(views);
    views.shellView.webContents.debugger.attach();
    const evalJs = async (expression) => {
      const response = await views.shellView.webContents.debugger.sendCommand("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails));
      return response.result.value;
    };
    const text = () => evalJs("document.body.innerText");
    const diagnose = async () => JSON.stringify(await evalJs("({iw:window.innerWidth, text:document.body.innerText.slice(0,600), html:document.body.innerHTML.length, url:location.href, conv:Boolean(document.querySelector('[data-testid=desktop-conversation]')), shell:Boolean(document.querySelector('[data-testid=desktop-shell]'))})"));
    const until = async (match, label) => { for (let i = 0; i < 150; i++) { const body = await text(); if (await match(body)) return body; await wait(100); } throw Error(`UI timeout (${label}): ${await diagnose()}`); };
    const click = (name) => evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(name)} || el.getAttribute('aria-label') === ${JSON.stringify(name)}); if (!b) throw Error('missing '+${JSON.stringify(name)}+' :: '+document.body.innerText.replace(/\\n+/g,' | ').slice(0,500)); b.click(); return true; })()`);
    const type = (value) => evalJs(`(() => { const el = document.querySelector('textarea[aria-label="消息"]'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value; })()`);
    const clickText = (needle, scope = "document") => evalJs(`(() => { const b = [...${scope}.querySelectorAll('button')].find(el => el.textContent.includes(${JSON.stringify(needle)})); if (!b) throw Error('missing text '+${JSON.stringify(needle)}+' :: '+${scope}.innerText.replace(/\\n+/g,' | ').slice(0,400)); b.click(); return true; })()`);
    const clickSelector = (selector) => evalJs(`(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b) throw Error('missing '+${JSON.stringify(selector)}+' :: '+document.body.innerText.replace(/\\n+/g,' | ').slice(0,500)); b.click(); return true; })()`);
    const fill = (label, value) => evalJs(`(() => { const el = document.querySelector('input[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']'); if (!el) throw Error('missing input '+${JSON.stringify(label)}); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value; })()`);
    const capture = async (label, width, height, scrollSelector) => {
      captureStage = `${label} ${width}x${height}`;
      views.window.setContentSize(width, height);
      await wait(250);
      if (scrollSelector) {
        await evalJs(`document.querySelector(${JSON.stringify(scrollSelector)})?.scrollIntoView({block:'start'})`);
        await wait(100);
      }
      const size = views.window.getContentBounds();
      // Horizontal-overflow check (#47 S8): document.scrollWidth vs documentElement.clientWidth,
      // plus window.innerWidth so a scrollbar-gutter difference cannot hide an overflow. The page
      // content lives inside `main[data-testid=desktop-shell-content]`, whose `overflow-y:auto`
      // makes it its own scroll container (`overflow-x` computes to `auto` too), so an overflow
      // *inside* the page is scrolled there and never reaches documentElement; measure that
      // element's scrollWidth/clientWidth as the page-level metric.
      const state = await evalJs("(() => { const content = document.querySelector('[data-testid=desktop-shell-content]'); return {scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,innerWidth:window.innerWidth,contentScrollWidth:content?.scrollWidth ?? null,contentClientWidth:content?.clientWidth ?? null}; })()");
      const file = join(output, `${width}x${height}-${label}.png`);
      let image;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { image = await views.shellView.webContents.capturePage(); break; }
        catch (error) { if (attempt === 2) throw error; await wait(500); }
      }
      writeFileSync(file, image.toPNG());
      return { file, width: size.width, height: size.height, overflow: state.scrollWidth - state.innerWidth, overflowClient: state.scrollWidth - state.clientWidth, overflowContent: state.contentScrollWidth === null || state.contentClientWidth === null ? null : state.contentScrollWidth - state.contentClientWidth };
    };
    const shots = [];
    await until((body) => body.includes("对账单详情·本地联调"), "shell list");
    shots.push(await capture("shell-tasks", 1440, 900));
    // The task is claimed to the Project, so it is opened from its sidebar card
    // (the unassigned list's 进入工作区 button is the other path).
    await clickSelector(`[data-task-nav="${taskId}"]`);
    await until((body) => /task workspace/i.test(body), "task workspace");
    await type("帮我检查对账单详情中运单账号的信息。");
    // The workspace header renders before the SDK subscription completes; the send
    // button also needs a non-empty draft, so type first and then wait for it.
    for (let i = 0; i < 150; i++) {
      if (await evalJs("(() => { const b = document.querySelector('button[aria-label=发送]'); return Boolean(b) && !b.disabled; })()")) break;
      if (i === 149) throw Error(`send never enabled: ${JSON.stringify(await evalJs("({iw:window.innerWidth, ih:window.innerHeight, text:document.body.innerText.slice(0,400), html:document.body.innerHTML.length, conv:Boolean(document.querySelector('[data-testid=desktop-conversation]')), send:Boolean(document.querySelector('button[aria-label=发送]'))})"))}`);
      await wait(100);
    }
    // Diagnostic: does the Host that serves the turn see the installed Provider?
    const senderId = views.shellView.webContents.id;
    const diag = { providerState: await providers.perform({ op: "list", taskId }, senderId), entries: registry.activeTaskIds(), entryDir: registry.entryForTaskId(taskId)?.taskDir, expectedDir: taskDir };
    try { diag.projection = await registry.routeTaskOp({ taskId, op: "task/sdkProjection", payload: { sessionId: "main" }, origin: { kind: "shell-ui", senderWebContentsId: senderId } }); } catch (error) { diag.projectionError = String(error); }
    diag.notice = await evalJs("document.querySelector('[role=status]')?.textContent ?? ''");
    console.log("ISSUE47_DIAG=" + JSON.stringify(diag));
    await click("发送");
    await until((body) => body.includes("当前任务已准备独立的工作副本"), "answer");
    await wait(400);
    shots.push(await capture("workspace-turn", 1440, 900));
    // S8d: open the 文件 tool (real `task/fileRoots`/`fileTree`/`filePreview`) and
    // drill into a real file, so the dock evidence is real rows, not a placeholder.
    await click("文件");
    await until((body) => body.includes("invoice-service"), "file roots");
    await clickText("README.md", "document.querySelector('[data-testid=dock-tree]')");
    await until((body) => body.includes("对账单详情服务的本地工作副本"), "file preview");
    await wait(200);
    shots.push(await capture("workspace-files", 1440, 900));
    const dock = {
      roots: await evalJs("document.querySelector('[data-testid=dock-roots]')?.innerText"),
      tree: await evalJs("document.querySelector('[data-testid=dock-tree]')?.innerText"),
      preview: await evalJs("document.querySelector('[data-testid=desktop-tool-dock] pre')?.innerText"),
    };
    await click("关闭面板");
    await click("协议");
    await until((body) => body.includes("协议仓库 未配置") && body.includes("实际生成版本：尚未生成"), "protocol state");
    shots.push(await capture("workspace-protocol", 1440, 900));
    shots.push(await capture("workspace-protocol", 720, 560));
    const protocol = {
      summary: await evalJs("document.querySelector('[data-testid=protocol-summary]')?.innerText"),
      error: await evalJs("document.querySelector('[data-testid=desktop-tool-dock] [role=alert]')?.innerText"),
    };
    await click("关闭面板");
    shots.push(await capture("workspace-turn", 720, 560));
    // S8e: the real 模型与 Provider page (composer entry → page) and the real
    // 项目总览 page, both from the production shell.
    views.window.setContentSize(1440, 900);
    await wait(250);
    await clickSelector('[data-testid=composer-model]');
    await until((body) => body.includes("模型与 Provider"), "providers page");
    await wait(200);
    shots.push(await capture("providers-page", 1440, 900));
    const providersPage = {
      state: await evalJs("document.querySelector('[data-testid=providers-state]')?.innerText"),
      cards: await evalJs("[...document.querySelectorAll('[data-provider-card]')].map(el => el.innerText.replace(/\\n+/g,' | '))"),
      credentialVisible: (await text()).includes(CREDENTIAL),
    };
    // S8e: real Token 用量 page (same SDK JSONL projection the conversation shows).
    await clickSelector('[data-testid=desktop-shell] button[title="Token 用量"]');
    await until((body) => body.includes("逐条记录"), "usage page");
    await wait(200);
    shots.push(await capture("usage-page", 1440, 900));
    const usage = {
      summary: await evalJs("document.querySelector('[data-testid=usage-summary]')?.innerText"),
      totals: await evalJs("[...document.querySelectorAll('[data-usage-total]')].map(el => el.innerText.replace(/\\n+/g,' '))"),
      rows: await evalJs("document.querySelectorAll('[data-usage-row]').length"),
    };
    await clickSelector('[data-testid=desktop-shell] button[title="环境与服务"]');
    await until((body) => body.includes("环境清单未接线") && body.includes("Host 尚未提供项目环境") && body.includes("invoice-local") && body.includes("任务绑定"), "environment page");
    const serviceTemplates = catalog.listTemplates(project.id);
    if (serviceTemplates.length !== 1 || serviceTemplates[0]?.descriptor.name !== "invoice-local") throw Error("service template not persisted");
    // Exercise the real creation form and review state, then cancel it: the
    // saved binding above is the catalog revision the Host owns, so this run
    // must not add another revision after bootstrap.
    await click("添加服务");
    await fill("服务名称", "invoice-local-review");
    await fill("程序名", "node");
    await fill("参数 1", "server.js");
    await click("添加共享变量");
    await fill("共享变量 KEY 1", "PORT");
    await fill("共享变量 VALUE 1", "4100");
    await click("核对保存");
    shots.push(await capture("service-template-form", 1440, 900, '[aria-label="服务启动配方"]'));
    shots.push(await capture("service-template-form", 720, 560, '[aria-label="服务启动配方"]'));
    await click("取消");
    await until((body) => body.includes("invoice-local") && body.includes("任务绑定"), "saved service template");
    await click("任务绑定");
    await until((body) => body.includes("已绑定 · v1 · invoice-service"), "persisted task binding");
    const serviceBindings = new ServiceCatalog(profile, serviceCatalogAuthority(index, projects)).listTask(taskId);
    if (serviceBindings.length !== 1 || serviceBindings[0]?.binding.rootId !== "invoice-service" ||
        serviceBindings[0]?.binding.privateRefs[0]?.envRef !== "PIDOCK_SERVICE_CAPTURE_TOKEN") throw Error("task binding not persisted");
    const boundText = await text();
    if (!boundText.includes("私有变量：API_TOKEN") || boundText.includes("PIDOCK_SERVICE_CAPTURE_TOKEN")) throw Error("private binding projection leaked");
    shots.push(await capture("service-binding-saved", 1440, 900, '[aria-label="invoice-local任务绑定"]'));
    shots.push(await capture("service-binding-saved", 720, 560, '[aria-label="invoice-local任务绑定"]'));
    await click("读取配置预览");
    await until((body) => body.includes("••••••••") && body.includes("本机私有配置") && body.includes("4100"), "masked saved configuration preview");
    const preview = catalog.previewSavedConfig(project.id, taskId, serviceTemplates[0].serviceId, process.env);
    if (JSON.stringify(preview).includes(PRIVATE_VALUE) || (await text()).includes(PRIVATE_VALUE) ||
        readFileSync(join(profile, "service-machine.json"), "utf8").includes(PRIVATE_VALUE)) throw Error("preview secret leaked");
    shots.push(await capture("config-preview", 1440, 900, '[aria-label="保存配置预览"]'));
    shots.push(await capture("config-preview", 720, 560, '[aria-label="保存配置预览"]'));
    await click("任务绑定");
    shots.push(await capture("environment-page", 1440, 900));
    shots.push(await capture("environment-page", 720, 560));
    views.window.setContentSize(1440, 900);
    await wait(250);
    await until((body) => body.includes("invoice-service") && body.includes("尚未扫描"), "import source");
    await click("扫描仓库");
    await until((body) => body.includes("invoice-dev") && body.includes("API_TOKEN：疑似凭据") && body.includes("脚本开头使用内联环境赋值"), "service import hints");
    if ((await text()).includes("synthetic-secret-import-guard") || (await text()).includes("private-command-marker")) throw Error("service import leaked private config");
    shots.push(await capture("environment-import", 1440, 900, 'section[aria-label="仓库配置草案"]'));
    shots.push(await capture("environment-import", 720, 560, 'section[aria-label="仓库配置草案"]'));
    views.window.setContentSize(1440, 900);
    await wait(250);
    const environment = {
      project: await evalJs("document.querySelector('#desktop-env-project')?.selectedOptions[0]?.textContent"),
      environment: await evalJs("document.querySelector('select[aria-label=环境]')?.selectedOptions[0]?.textContent"),
      placeholders: await evalJs("document.querySelectorAll('[data-testid=desktop-environment-page] button:disabled').length"),
    };
    await clickSelector('[data-testid=desktop-shell] button[title="能力管理"]');
    await until((body) => body.includes("Host 尚未提供 Skills 的真实清单"), "capabilities page");
    shots.push(await capture("capabilities-page", 1440, 900));
    shots.push(await capture("capabilities-page", 720, 560));
    const capabilities = {
      unwiredSummaries: await evalJs("document.querySelectorAll('[aria-label=能力汇总] strong').length"),
      addDisabled: await evalJs("document.querySelector('[data-testid=desktop-capabilities-page] button[title]')?.disabled"),
    };
    await clickSelector('[data-testid=desktop-capabilities-page] [role=tab][aria-selected=false]');
    await until((body) => body.includes("Host 尚未提供 MCP Servers 的真实清单"), "MCP capability tab");
    await clickSelector('[data-testid=desktop-shell] button[title="本机设置"]');
    await until((body) => body.includes("默认任务根目录") && body.includes("权威配置路径"), "settings page");
    shots.push(await capture("settings-page", 1440, 900));
    shots.push(await capture("settings-page", 720, 560));
    const settings = {
      saveDisabled: await evalJs("[...document.querySelectorAll('[data-testid=desktop-settings-page] button')].find(el => el.textContent.includes('保存设置'))?.disabled"),
      rootDisabled: await evalJs("document.querySelector('[data-testid=desktop-settings-page] input')?.disabled"),
    };
    views.window.setContentSize(1440, 900);
    await wait(250);
    await clickSelector('[data-testid=desktop-shell] button[title="定时任务"]');
    await until((body) => body.includes("当前筛选下没有定时任务。"), "schedules page");
    shots.push(await capture("schedules-page", 1440, 900));
    shots.push(await capture("schedules-page", 720, 560));
    views.window.setContentSize(1440, 900);
    await wait(250);
    const schedules = {
      rows: await evalJs("document.querySelectorAll('[data-schedule-row]').length"),
      runs: await evalJs("document.querySelectorAll('[data-schedule-run]').length"),
      error: await evalJs("document.querySelector('[data-testid=desktop-schedules-page] [role=alert]')?.innerText"),
    };
    await clickSelector('[data-testid=desktop-shell] button[title="需要处理"]');
    await until((body) => body.includes("完成未读 · 1") && body.includes("查看 main 会话"), "attention page");
    shots.push(await capture("attention-page", 1440, 900));
    shots.push(await capture("attention-page", 720, 560));
    views.window.setContentSize(1440, 900);
    await wait(250);
    const attention = { rows: await evalJs("document.querySelectorAll('[data-attention-item]').length"), error: await evalJs("document.querySelector('[data-testid=desktop-attention-page] [role=alert]')?.innerText") };
    await clickSelector('[data-testid=desktop-shell] button[title="远程访问"]');
    await until((body) => body.includes("该任务尚无已登记设备。"), "remote page state");
    shots.push(await capture("remote-page", 1440, 900));
    shots.push(await capture("remote-page", 720, 560));
    views.window.setContentSize(1440, 900);
    await wait(250);
    const remote = { task: await evalJs("document.querySelector('#desktop-remote-task')?.selectedOptions[0]?.textContent"), devices: await evalJs("document.querySelectorAll('[data-remote-device]').length"), error: await evalJs("document.querySelector('[data-testid=desktop-remote-page] [role=alert]')?.innerText") };
    await clickSelector('[data-testid=desktop-shell] button[title="已归档"]');
    await until((body) => body.includes("还没有归档任务。"), "archive page");
    shots.push(await capture("archive-page", 1440, 900));
    shots.push(await capture("archive-page", 720, 560));
    views.window.setContentSize(1440, 900);
    await wait(250);
    const archive = {
      rows: await evalJs("document.querySelectorAll('[data-archived-task]').length"),
      error: await evalJs("document.querySelector('[data-testid=desktop-archive-page] [role=alert]')?.innerText"),
    };
    await clickSelector('[data-testid=desktop-shell] button[title=项目总览]');
    await until((body) => body.includes("继续工作"), "project overview");
    await wait(200);
    shots.push(await capture("project-overview", 1440, 900));
    const overview = {
      taskCount: await evalJs("document.querySelector('[data-testid=overview-task-count]')?.innerText"),
      repoCount: await evalJs("document.querySelector('[data-testid=overview-repo-count]')?.innerText"),
      env: await evalJs("document.querySelector('[data-testid=overview-env-unwired]')?.innerText"),
      cards: await evalJs("[...document.querySelectorAll('[data-overview-task]')].map(el => el.innerText.replace(/\\n+/g,' | '))"),
      unwired: await evalJs("document.querySelector('[data-testid=overview-env-unwired]')?.previousElementSibling?.innerText"),
    };
    await clickSelector(`[data-task-nav="${taskId}"]`);
    await until((body) => /task workspace/i.test(body) && body.includes("已连接") && body.includes("Agent 工具未接线"), "archive task workspace connected");
    await click("核验");
    await wait(350);
    await click("任务操作");
    await click("归档当前任务");
    await until((body) => body.includes("归档会停止所属执行"), "archive confirmation");
    await until(async () => await evalJs("document.querySelector('[role=dialog] button:last-child')?.disabled === false"), "archive confirmation ready");
    await click("确认归档");
    await until(async () => await evalJs(`Boolean(document.querySelector('[data-archived-task="${taskId}"]'))`), "archived task row");
    if (await evalJs(`Boolean(document.querySelector('[data-task-nav="${taskId}"]'))`)) throw Error("archived task remained in active navigation");
    shots.push(await capture("archive-with-task", 1440, 900));
    shots.push(await capture("archive-with-task", 720, 560));
    views.window.setContentSize(1440, 900);
    await wait(250);
    await click("恢复");
    await until(async () => await evalJs(`Boolean(document.querySelector('[data-task-nav="${taskId}"]'))`), "restored task nav");
    const archiveFlow = { archivedRow: true, restoredNav: true };
    const body = await text();
    console.log("ISSUE47_CAPTURE=" + JSON.stringify({
      shots,
      sidebar: await evalJs("Boolean(document.querySelector('[data-testid=desktop-sidebar]'))"),
      breadcrumb: await evalJs("document.querySelector('[data-testid=desktop-breadcrumb]').innerText"),
      sessionTabs: await evalJs("document.querySelector('[role=tablist]')?.innerText"),
      credentialVisible: body.includes(CREDENTIAL),
      dock,
      protocol,
      providers: providersPage,
      usage,
      environment,
      capabilities,
      settings,
      schedules,
      attention,
      remote,
      archive,
      archiveFlow,
      overview,
      providerState: await evalJs("document.querySelector('[data-testid=provider-state]')?.textContent"),
      jsonlBytes: readdirSync(join(taskDir, ".pidock-sdk-sessions", "main")).filter((name) => name.endsWith(".jsonl"))
        .reduce((sum, name) => sum + readFileSync(join(taskDir, ".pidock-sdk-sessions", "main", name), "utf8").length, 0),
    }));
    // #47 S8 box 1 requires no horizontal overflow at either tier, so a capture that
    // overflows must fail the run rather than be recorded and ignored (sibling issue45
    // harness throws on overflow too). `overflowContent` is the page-container metric;
    // `null` means `desktop-shell-content` was absent, which is also a failure.
    const overflowing = shots.filter((shot) => shot.overflow !== 0 || shot.overflowClient !== 0 || shot.overflowContent !== 0);
    if (overflowing.length) throw Error("horizontal overflow " + JSON.stringify(overflowing));
  } catch (error) { console.error("ISSUE47_CAPTURE_FAILED", captureStage, error); process.exitCode = 1; }
  finally {
    clearTimeout(watchdog);
    server?.close();
    const cleanupFailures = await shutdownTestRegistry(registry, {
      origin: views ? { kind: "shell-ui", senderWebContentsId: views.shellView.webContents.id } : undefined,
      label: "Issue47 capture cleanup",
    });
    delete process.env["PIDOCK_SERVICE_CAPTURE_TOKEN"];
    for (const child of children) child.kill();
    if (views?.shellView.webContents.debugger.isAttached()) views.shellView.webContents.debugger.detach();
    views?.window.destroy();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    if (cleanupFailures.length) { console.error("ISSUE47_CAPTURE_CLEANUP_FAILED " + JSON.stringify(cleanupFailures)); process.exitCode = process.exitCode ?? 1; }
    app.exit(process.exitCode ?? 0);
  }
}
void run();
