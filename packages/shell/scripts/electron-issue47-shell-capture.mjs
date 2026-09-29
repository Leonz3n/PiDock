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
import { createTrustedWindow, loadTrustedViews, PerTaskHostRegistry, registerIpc } from "../dist/main/runtime.js";
import { ProviderProfileStore } from "../dist/main/provider-profile-store.js";
import { ProviderWiring } from "../dist/main/provider-ipc.js";
import { HostClient } from "../dist/rpc/host-client.js";

const CREDENTIAL = "issue47-synthetic-credential-0123456789";
const AUTH_REF = "PIDOCK_PROVIDER_ISSUE47";
const output = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : tmpdir();
const root = mkdtempSync(join(tmpdir(), "pidock-issue47-capture-"));
const profile = join(root, "profile"), taskRoot = join(root, "tasks"), taskDir = join(taskRoot, "task-abcdef12");
mkdirSync(profile); mkdirSync(taskRoot); mkdirSync(taskDir); mkdirSync(output, { recursive: true });
app.setPath("userData", profile);
const taskId = "task-abcdef12";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = [];
const watchdog = setTimeout(() => { console.error("ISSUE47_CAPTURE_TIMEOUT", root); process.exit(1); }, 60000);
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
  try {
    const port = await startProvider();
    process.env[AUTH_REF] = CREDENTIAL;
    await app.whenReady();
    execFileSync("git", ["init", "-q", taskDir]);
    writeFileSync(join(taskDir, "task.json"), serializeTaskRecord(buildTaskDiskRecord({ taskId, name: "对账单详情·本地联调", dirId: taskId, branch: "main", root: taskRoot, taskDir, remoteBranch: "main", baseCommit: "test", repos: [], now: new Date().toISOString() })));
    const index = new TaskRootIndex(profile, taskRoot);
    const projects = new ProjectRegistry(profile);
    registry = new PerTaskHostRegistry("issue47", async (workspace, task) => {
      const entry = join(import.meta.dirname, "..", "dist", "host", "host-entry.js");
      const child = utilityProcess.fork(entry, [], { serviceName: "issue47-host", env: buildHostEnv(process.env, workspace, task), stdio: "pipe" });
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
    const project = projects.create({ name: "Adder", description: "微服务开发工作台", repositories: [], directories: [] });
    projects.claim(taskId, project.id, index);
    views = await createTrustedWindow("issue47", "production");
    registerIpc({}, views.registry, registry, projects, index, undefined, undefined, providers);
    await loadTrustedViews(views);
    views.shellView.webContents.debugger.attach();
    const evalJs = async (expression) => {
      const response = await views.shellView.webContents.debugger.sendCommand("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails));
      return response.result.value;
    };
    const text = () => evalJs("document.body.innerText");
    const diagnose = async () => JSON.stringify(await evalJs("({iw:window.innerWidth, text:document.body.innerText.slice(0,600), html:document.body.innerHTML.length, url:location.href, conv:Boolean(document.querySelector('[data-testid=desktop-conversation]')), shell:Boolean(document.querySelector('[data-testid=desktop-shell]'))})"));
    const until = async (match, label) => { for (let i = 0; i < 150; i++) { const body = await text(); if (match(body)) return body; await wait(100); } throw Error(`UI timeout (${label}): ${await diagnose()}`); };
    const click = (name) => evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(name)} || el.getAttribute('aria-label') === ${JSON.stringify(name)}); if (!b) throw Error('missing '+${JSON.stringify(name)}); b.click(); return true; })()`);
    const type = (value) => evalJs(`(() => { const el = document.querySelector('textarea[aria-label="消息"]'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value; })()`);
    const capture = async (label, width, height) => {
      views.window.setContentSize(width, height);
      await wait(250);
      const size = views.window.getContentBounds();
      const state = await evalJs("({scrollWidth:document.documentElement.scrollWidth,innerWidth:window.innerWidth})");
      const file = join(output, `${width}x${height}-${label}.png`);
      writeFileSync(file, (await views.shellView.webContents.capturePage()).toPNG());
      return { file, width: size.width, height: size.height, overflow: state.scrollWidth - state.innerWidth };
    };
    const shots = [];
    await until((body) => body.includes("对账单详情·本地联调"), "shell list");
    shots.push(await capture("shell-tasks", 1440, 900));
    await click("进入工作区");
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
    shots.push(await capture("workspace-turn", 720, 560));
    const body = await text();
    console.log("ISSUE47_CAPTURE=" + JSON.stringify({
      shots,
      sidebar: await evalJs("Boolean(document.querySelector('[data-testid=desktop-sidebar]'))"),
      breadcrumb: await evalJs("document.querySelector('[data-testid=desktop-breadcrumb]').innerText"),
      sessionTabs: await evalJs("document.querySelector('[role=tablist]')?.innerText"),
      credentialVisible: body.includes(CREDENTIAL),
      providerState: await evalJs("document.querySelector('[data-testid=provider-state]')?.textContent"),
      jsonlBytes: readdirSync(join(taskDir, ".pidock-sdk-sessions", "main")).filter((name) => name.endsWith(".jsonl"))
        .reduce((sum, name) => sum + readFileSync(join(taskDir, ".pidock-sdk-sessions", "main", name), "utf8").length, 0),
    }));
  } catch (error) { console.error("ISSUE47_CAPTURE_FAILED", error); process.exitCode = 1; }
  finally {
    clearTimeout(watchdog);
    server?.close();
    registry?.disposeAll();
    for (const child of children) child.kill();
    if (views?.shellView.webContents.debugger.isAttached()) views.shellView.webContents.debugger.detach();
    views?.window.destroy();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    app.exit(process.exitCode ?? 0);
  }
}
void run();
