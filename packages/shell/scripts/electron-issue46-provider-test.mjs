// [PiDock 02m] (#46) isolated end-to-end Desktop check against a loopback
// Provider. Run after `pnpm --filter @pidock/shell build`.
//
// It starts a real local OpenAI-compatible SSE endpoint, sets the explicit
// credential reference in this process' environment, and drives the real
// production main/renderer/Host/isolated-context chain:
//   renderer panel -> main (resolves the reference) -> task Host
//   -> isolated worker context -> SDK -> loopback HTTP
//
// The endpoint deliberately echoes the credential in `id`, `model`, and stream
// content, so the run proves the redaction at the point the SDK JSONL, the UI,
// and the local receipt are written. `--resume <root>` re-opens the same
// profile/task to prove the selection restores and the history survives.
import { app, utilityProcess } from "electron";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { shutdownTestRegistry } from "./shutdown-test-registry.mjs";

const CREDENTIAL = "sk-issue46-synthetic-0123456789abcdef";
const AUTH_REF = "PIDOCK_PROVIDER_ISSUE46";
const ANSWER = "loopback answer";
const resumeAt = process.argv.indexOf("--resume");
const resumeRoot = resumeAt === -1 ? null : process.argv[resumeAt + 1];
const root = resumeRoot ?? mkdtempSync(join(tmpdir(), "pidock-issue46-e2e-"));
const profile = join(root, "profile"), taskRoot = join(root, "tasks"), taskDir = join(taskRoot, "task-abcdef12");
if (!resumeRoot) { mkdirSync(profile); mkdirSync(taskRoot); mkdirSync(taskDir); }
app.setPath("userData", profile);
const taskId = "task-abcdef12";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = [];
const received = [];
const watchdog = setTimeout(() => { console.error("ISSUE46_E2E_TIMEOUT", root); process.exit(1); }, 120000);
// Test-only guard: a noop listener suppresses Electron's default quit on
// window-all-closed, which would race the explicit app.exit(process.exitCode)
// with a false-pass exit 0.
app.on("window-all-closed", () => {});
let views, registry, server;

/** Loopback OpenAI-compatible endpoint whose answer carries the credential. */
function startProvider() {
  return new Promise((resolve) => {
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => {
        received.push({ url: request.url, authorization: request.headers.authorization ?? "", body });
        if (!request.url?.endsWith("/chat/completions")) { response.writeHead(404).end(); return; }
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        const chunk = (delta, extra = {}) => `data: ${JSON.stringify({ id: `chatcmpl-${CREDENTIAL}`, object: "chat.completion.chunk", model: CREDENTIAL, choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
        response.write(chunk({ content: `echo ${CREDENTIAL.slice(0, 14)}` }));
        // The credential is split across two frames: a per-frame filter alone
        // would let the tail through the live stream.
        response.write(chunk({ content: `${CREDENTIAL.slice(14)}${body.includes("hold-open-cancel") ? " delta-holding " : ` ${ANSWER} `}` }));
        // The cancel leg streams and then holds the connection open until the
        // user stops the turn; a normal turn completes with usage.
        if (body.includes("hold-open-cancel")) return;
        response.write(chunk({ content: CREDENTIAL }));
        response.write(`data: ${JSON.stringify({ id: `chatcmpl-${CREDENTIAL}`, object: "chat.completion.chunk", model: CREDENTIAL, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })}\n\n`);
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
    if (!resumeRoot) {
      execFileSync("git", ["init", "-q", taskDir]);
      writeFileSync(join(taskDir, "task.json"), serializeTaskRecord(buildTaskDiskRecord({ taskId, name: "Provider task", dirId: taskId, branch: "main", root: taskRoot, taskDir, remoteBranch: "main", baseCommit: "test", repos: [], now: new Date().toISOString() })));
    }
    const index = new TaskRootIndex(profile, taskRoot);
    const projects = new ProjectRegistry(profile);
    registry = new PerTaskHostRegistry("issue46", async (workspace, task) => {
      const entry = join(import.meta.dirname, "..", "dist", "host", "host-entry.js");
      const child = utilityProcess.fork(entry, [], { serviceName: "issue46-host", env: buildHostEnv(process.env, workspace, task, app.getPath("userData")), stdio: "pipe" });
      children.push(child);
      child.stderr?.on("data", (data) => process.stderr.write(`[issue46-host] ${data}`));
      return { child, client: new HostClient(child) };
    }, (id) => index.resolve(id), undefined, index);
    const profiles = new ProviderProfileStore(profile);
    const providers = new ProviderWiring(profiles, async (id, provider, senderWebContentsId) => {
      const payload = provider === null ? { provider: null } : { provider: { config: profiles.config(provider.profileId), credential: provider.credential } };
      await registry.routeTaskOp({ workspaceId: "issue46", taskId: id, op: "task/sdkProvider", payload, origin: { kind: "shell-ui", senderWebContentsId } });
    });
    views = await createTrustedWindow("issue46", "production");
    registerIpc({}, views.registry, registry, projects, index, undefined, undefined, providers);
    await loadTrustedViews(views);
    views.shellView.webContents.debugger.attach();
    const evalJs = async (expression) => {
      const response = await views.shellView.webContents.debugger.sendCommand("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails));
      return response.result.value;
    };
    const text = () => evalJs("document.body.innerText");
    const until = async (match, label) => { for (let i = 0; i < 150; i++) { const body = await text(); if (match(body)) return body; await wait(100); } throw Error(`UI timeout (${label}): ${await text()}`); };
    const click = (name) => evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(name)} || el.getAttribute('aria-label') === ${JSON.stringify(name)}); if (!b) throw Error('missing '+${JSON.stringify(name)}); b.click(); return true; })()`);
    const fill = (label, value) => evalJs(`(() => { const el = [...document.querySelectorAll('input')].find(i => i.closest('label')?.textContent.startsWith(${JSON.stringify(label)})); if (!el) throw Error('missing '+${JSON.stringify(label)}); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value; })()`);
    const type = (value) => evalJs(`(() => { const el = document.querySelector('textarea[aria-label="消息"]'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value; })()`);
    const jsonl = () => {
      const dir = join(taskDir, ".pidock-sdk-sessions", "main");
      if (!existsSync(dir)) return "";
      return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).map((name) => readFileSync(join(dir, name), "utf8")).join("\n");
    };

    views.window.setContentSize(1440, 900);
    await until((body) => body.includes("Provider task"), "list");
    const openTask = () => evalJs(`(() => { const button = document.querySelector('[data-task-nav="${taskId}"]'); if (!button) throw Error('missing task navigation'); button.click(); return true; })()`);
    await openTask();
    // A fresh task has no SDK history; a resumed one must show the history that
    // the previous run persisted, so the marker differs.
    await until((body) => body.includes("SDK JSONL 已确认历史") && body.includes("已连接"), "conversation view");

    if (resumeRoot) {
      // A cold reopen must restore the persisted selection by itself.
      await until((body) => body.includes("Loopback"), "restored selection");
      const restored = await text();
      if (!restored.includes(ANSWER)) throw Error(`history lost on reopen: ${restored}`);
      if (!restored.includes("please hold-open-cancel")) throw Error(`cancelled turn prompt lost on reopen: ${restored}`);
      if (restored.includes(CREDENTIAL)) throw Error("credential visible after reopen");
      console.log("ISSUE46_E2E_RESUME=" + JSON.stringify({ root, restored: true, historyKept: true, credentialVisible: false, credentialInJsonl: jsonl().includes(CREDENTIAL) }));
    } else {
      await until((body) => body.includes("未配置"), "unconfigured state");
      await evalJs("document.querySelector('[data-testid=composer-model]').click()");
      await until((body) => body.includes("添加 Provider"), "provider page");
      await click("添加 Provider");
      await fill("名称", "Loopback");
      await fill("接口地址", `http://127.0.0.1:${port}/v1`);
      await fill("模型", "issue46-model");
      await fill("凭据引用名", AUTH_REF);
      await click("保存并选用");
      await until((body) => body.includes("已配置"), "configured state");
      const beforeSend = await text();
      if (beforeSend.includes(CREDENTIAL)) throw Error("credential shown before any request");
      const persisted = readFileSync(join(profile, "provider-profiles.json"), "utf8");
      // "task-abcdef12" contains "sk-", so the check is for the value and for
      // credential-bearing keys, not for a substring of the key name.
      if (persisted.includes(CREDENTIAL)) throw Error(`credential persisted: ${persisted}`);
      if (/"(credential|apiKey|api_key|token|secret|password)"\s*:/i.test(persisted)) throw Error(`credential-bearing field persisted: ${persisted}`);

      await openTask();
      await until((body) => body.includes("SDK JSONL 已确认历史"), "configured conversation");
      await wait(300);
      if ((await text()).includes("sdk-sender-navigated")) await click("重新连接");
      await until((body) => body.includes("已连接"), "configured subscription");
      await type("hello provider");
      await click("发送");
      const answered = await until((body) => body.includes(ANSWER), "answer");
      await wait(300);
      const after = await text();
      const log = jsonl();
      if (!answered.includes("[redacted]")) throw Error("no redaction marker in the live stream");
      if (after.includes(CREDENTIAL)) throw Error("credential visible in the UI");
      if (log.includes(CREDENTIAL)) throw Error("credential persisted in SDK JSONL");
      if (!log.includes("hello provider")) throw Error("prompt missing from SDK JSONL");
      if (!/"input":11[,}]/.test(log) || !/"output":7[,}]/.test(log)) throw Error(`usage missing from SDK JSONL: ${log.slice(0, 600)}`);
      if (received.length !== 1 || received[0].authorization !== `Bearer ${CREDENTIAL}`) throw Error(`loopback did not receive the explicit credential: ${JSON.stringify(received)}`);
      if (!received[0].body.includes("issue46-model") || !received[0].url.endsWith("/v1/chat/completions")) throw Error(`unexpected request: ${JSON.stringify(received[0])}`);
      const hostEnv = readFileSync(join(profile, "provider-profiles.json"), "utf8");
      if (hostEnv.length === 0) throw Error("empty profile store");
      // Test-only display stabilization: an unfocused window can report
      // "display surface not available" to capturePage.
      views.window.show();
      views.window.focus();
      await wait(250);
      const screenshot = join(tmpdir(), "pidock-issue46-configured.png");
      writeFileSync(screenshot, (await views.shellView.webContents.capturePage()).toPNG());
      console.log("ISSUE46_E2E=" + JSON.stringify({
        root, port, configured: true, answerDelivered: answered.includes(ANSWER), redactedInUi: !after.includes(CREDENTIAL),
        credentialInJsonl: log.includes(CREDENTIAL), credentialInProfileStore: persisted.includes(CREDENTIAL),
        providerHits: received.length, authorizationMatched: true, jsonlBytes: log.length, screenshot,
        overflow: (await evalJs("({scrollWidth:document.documentElement.scrollWidth,innerWidth:window.innerWidth})")),
      }));
      console.log("ISSUE46_E2E_JSONL=" + JSON.stringify(log.slice(0, 1200)));
      // Box #46 loop: the user cancels an in-flight turn before the cold restart.
      await type("please hold-open-cancel this turn");
      await click("发送");
      let stopShown = false;
      for (let i = 0; i < 150 && !stopShown; i++) {
        stopShown = await evalJs(`[...document.querySelectorAll('button')].some(el => el.textContent.trim() === '停止')`);
        if (!stopShown) await wait(100);
      }
      if (!stopShown) throw Error("no stop button for the in-flight turn");
      await until((body) => body.includes("delta-holding"), "delta before cancel");
      await click("停止");
      await until((body) => body.includes("执行已取消"), "cancelled terminal");
      await wait(300);
      const afterCancel = await text();
      const cancelLog = jsonl();
      if (afterCancel.includes(CREDENTIAL)) throw Error("credential visible after cancel");
      if (cancelLog.includes(CREDENTIAL)) throw Error("credential persisted after cancel");
      // The active turn's terminal state is persisted before shutdown; error
      // frames keep only the bounded code, so the aborted entry records the
      // terminal (not the staged partial text, which stays 暂存 only).
      if (!/"stopReason":"aborted"/.test(cancelLog)) throw Error("cancelled terminal missing from SDK JSONL");
      if (!cancelLog.includes("please hold-open-cancel")) throw Error("cancelled turn prompt missing from SDK JSONL");
      if (received.length !== 2 || received[1].authorization !== `Bearer ${CREDENTIAL}`) throw Error(`cancel leg did not reach the loopback: ${JSON.stringify(received.map((row) => row.url))}`);
      console.log("ISSUE46_E2E_CANCEL=" + JSON.stringify({ cancelled: true, terminalPersisted: true, credentialVisible: false, credentialInJsonl: false, providerHits: received.length }));
    }
    const quitRequest = `window.pidock.taskOp(${JSON.stringify(taskId)}, "task/quit", {label:"Provider shutdown check"})`;
    const quit = await evalJs(quitRequest), repeated = await evalJs(quitRequest);
    const receipt = quit.payload?.payload?.quit;
    if (!quit.ok || receipt?.plan?.failures?.length !== 0 || receipt?.plan?.retainedTasks?.length !== 0) throw Error(`provider-shutdown-unconfirmed: ${JSON.stringify(quit)}`);
    if (!repeated.ok || JSON.stringify(repeated.payload?.payload?.quit) !== JSON.stringify(receipt)) throw Error("provider-shutdown-receipt-changed");
    let refusal;
    try { await registry.routeTaskOp({ taskId, op: "task/sdkProvider", payload: { provider: null }, origin: { kind: "shell-ui", senderWebContentsId: views.shellView.webContents.id } }); }
    catch (error) { refusal = String(error); }
    if (!refusal?.includes("sdk-host-closing")) throw Error("provider-reopened-after-shutdown");
    console.log("ISSUE46_SDK_SHUTDOWN=" + JSON.stringify({ receiptStable: true, providerReinstallRefused: true, jsonlKept: jsonl().includes("hello provider"), credentialInJsonl: jsonl().includes(CREDENTIAL) }));
  } catch (error) { console.error("ISSUE46_E2E_FAILED", error); process.exitCode = 1; }
  finally {
    clearTimeout(watchdog);
    server?.close();
    const cleanupFailures = await shutdownTestRegistry(registry, {
      origin: views ? { kind: "shell-ui", senderWebContentsId: views.shellView.webContents.id } : undefined,
      label: "Provider test cleanup",
    });
    for (const child of children) child.kill();
    if (views?.shellView.webContents.debugger.isAttached()) views.shellView.webContents.debugger.detach();
    views?.window.destroy();
    if (!resumeRoot) { /* keep the root for the --resume pass */ }
    if (cleanupFailures.length) { console.error("ISSUE46_E2E_CLEANUP_FAILED " + JSON.stringify(cleanupFailures)); process.exitCode = process.exitCode ?? 1; }
    app.exit(process.exitCode ?? 0);
  }
}
void run();
