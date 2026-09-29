// Isolated real-window Desktop UI check. Run after `pnpm --filter @pidock/shell build`.
// --test-provider substitutes only the Host entry in this harness, never production main.
import { app, utilityProcess } from "electron";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTaskDiskRecord, serializeTaskRecord } from "../dist/host/task-store.js";
import { buildHostEnv } from "../dist/host/host-guards.js";
import { TaskRootIndex } from "../dist/main/task-root-index.js";
import { ProjectRegistry } from "../dist/main/project-registry.js";
import { createTrustedWindow, loadTrustedViews, PerTaskHostRegistry, registerIpc } from "../dist/main/runtime.js";
import { HostClient } from "../dist/rpc/host-client.js";

const fixture = process.argv.includes("--test-provider");
const root = mkdtempSync(join(tmpdir(), "pidock-issue45-gui-"));
const profile = join(root, "profile"), taskRoot = join(root, "tasks"), taskDir = join(taskRoot, "task-abcdef12");
mkdirSync(profile); mkdirSync(taskRoot); mkdirSync(taskDir);
app.setPath("userData", profile);
const taskId = "task-abcdef12";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = [];
const watchdog = setTimeout(() => { console.error("ISSUE45_GUI_TIMEOUT", root); process.exit(1); }, 45000);
let views, registry;
async function run() {
  try {
    await app.whenReady();
    execFileSync("git", ["init", "-q", taskDir]);
    writeFileSync(join(taskDir, "task.json"), serializeTaskRecord(buildTaskDiskRecord({ taskId, name: "SDK Desktop task", dirId: taskId, branch: "main", root: taskRoot, taskDir, remoteBranch: "main", baseCommit: "test", repos: [], now: new Date().toISOString() })));
    const index = new TaskRootIndex(profile, taskRoot);
    const projects = new ProjectRegistry(profile);
    registry = new PerTaskHostRegistry("issue45", async (workspace, task) => {
      const entry = fixture ? join(import.meta.dirname, "host-sdk-test-entry.mjs") : join(import.meta.dirname, "..", "dist", "host", "host-entry.js");
      const child = utilityProcess.fork(entry, [], { serviceName: "issue45-gui-host", env: buildHostEnv(process.env, workspace, task), stdio: "pipe" });
      children.push(child);
      child.stderr?.on("data", (data) => process.stderr.write(`[issue45-host] ${data}`));
      return { child, client: new HostClient(child) };
    }, (id) => index.resolve(id), undefined, index);
    views = await createTrustedWindow("issue45", "production");
    registerIpc({}, views.registry, registry, projects, index);
    await loadTrustedViews(views);
    views.shellView.webContents.debugger.attach();
    const evalJs = async (expression) => {
      const response = await views.shellView.webContents.debugger.sendCommand("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails));
      return response.result.value;
    };
    const read = () => evalJs("({text:document.body.innerText,scrollWidth:document.documentElement.scrollWidth,innerWidth:window.innerWidth})");
    const capture = async (label) => {
      const screenshot = join(tmpdir(), `pidock-issue45-${fixture ? "test" : "production"}-${label}.png`);
      writeFileSync(screenshot, (await views.shellView.webContents.capturePage()).toPNG());
      return screenshot;
    };
    const until = async (match) => { for (let i = 0; i < 100; i++) { const state = await read(); if (match(state)) return state; await wait(100); } throw Error(`UI timeout: ${JSON.stringify(await read())}`); };
    const click = (name) => evalJs(`(() => { const button = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(name)} || el.getAttribute('aria-label') === ${JSON.stringify(name)}); if (!button) throw Error('missing '+${JSON.stringify(name)}); button.click(); return true; })()`);
    const input = (text) => evalJs(`(() => { const el = document.querySelector('textarea[aria-label="消息"]'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; setter.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value; })()`);
    const dimensions = [[1440,900],[720,560]];
    for (const [width, height] of dimensions) {
      views.window.setContentSize(width, height);
      await wait(150);
      const bounds = views.shellView.getBounds(), content = views.window.getContentBounds();
      if (content.width !== width || content.height !== height || bounds.width !== width) throw Error(`window bounds ${JSON.stringify({content,bounds})}`);
      await until((state) => state.text.includes("SDK Desktop task"));
      const list = await read();
      if (list.scrollWidth > list.innerWidth) throw Error(`list overflow ${JSON.stringify(list)}`);
      const listScreenshot = await capture(`list-${width}x${height}`);
      await click("进入工作区");
      await until((state) => state.text.includes("尚未开始"));
      const conversation = await read();
      if (conversation.scrollWidth > conversation.innerWidth) throw Error(`conversation overflow ${JSON.stringify(conversation)}`);
      const screenshot = await capture(`conversation-${width}x${height}`);
      console.log("ISSUE45_GUI_VIEW=" + JSON.stringify({ fixture, content, shell: bounds, listOverflow: list.scrollWidth - list.innerWidth, conversationOverflow: conversation.scrollWidth - conversation.innerWidth, listScreenshot, screenshot }));
      await click("返回任务列表");
      await until((state) => state.text.includes("进入工作区"));
    }
    await click("进入工作区");
    await until((state) => state.text.includes("尚未开始"));
    views.layout.addBrowser(views.taskBrowser);
    views.layout.browserChanged(views.taskBrowser);
    await wait(150);
    const split = views.shellView.getBounds(), narrow = await read();
    if (split.width !== 280 || narrow.innerWidth !== 280 || narrow.scrollWidth > narrow.innerWidth) throw Error(`native split overflow ${JSON.stringify({split,narrow})}`);
    const splitScreenshot = await capture("split-280");
    await input("long ".repeat(120));
    await click("发送");
    const outcome = await until((state) => state.text.includes(fixture ? "local reply" : "provider-not-configured"));
    if (!fixture && (outcome.text.includes("Agent\n") || await evalJs("document.querySelector('textarea').value") !== "long ".repeat(120))) throw Error("production fabricated answer or lost draft");
    if (fixture) {
      await input("wait"); await click("发送");
      await until((state) => state.text.includes("停止"));
      const waitingScreenshot = await capture("waiting-280");
      await click("停止");
      await until((state) => state.text.includes("已取消"));
      console.log("ISSUE45_GUI_WAITING=" + JSON.stringify({ waitingScreenshot, cancelledScreenshot: await capture("cancelled-280") }));
    }
    const state = await read();
    if (state.scrollWidth > state.innerWidth) throw Error(`long text overflow ${JSON.stringify(state)}`);
    console.log("ISSUE45_GUI_RESULT=" + JSON.stringify({ fixture, state: fixture ? "model-done-and-cancelled" : "provider-not-configured", width: state.innerWidth, overflow: state.scrollWidth - state.innerWidth, shellUrl: views.shellView.webContents.getURL(), splitScreenshot, outcomeScreenshot: await capture(fixture ? "model-280" : "refusal-280") }));
  } catch (error) { console.error("ISSUE45_GUI_FAILED", error); process.exitCode = 1; }
  finally {
    clearTimeout(watchdog);
    registry?.disposeAll();
    for (const child of children) child.kill();
    if (views?.shellView.webContents.debugger.isAttached()) views.shellView.webContents.debugger.detach();
    views?.window.destroy();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    app.exit(process.exitCode ?? 0);
  }
}
void run();
