// #164 narrowly authorized live-account validation. Reads original native config;
// all application/task/session writes stay in a temporary profile. No tool use.
import { app, utilityProcess } from "electron";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { createUnavailableHostClient } from "./unavailable-host-client.mjs";
import { shutdownTestRegistry } from "./shutdown-test-registry.mjs";

const repo = resolve(import.meta.dirname, "../../..");
const preflight = process.argv.includes("--preflight");
const outputFlag = process.argv.indexOf("--output");
const output = outputFlag >= 0 ? resolve(process.argv[outputFlag + 1]) : preflight ? "/tmp/pidock-manual-validation/native-live-preflight" : "/tmp/pidock-manual-validation/native-live";
const root = mkdtempSync(join(tmpdir(), "pidock-native-live-"));
const profile = join(root, "profile"), taskRoot = join(root, "tasks"), directory = join(root, "empty-task");
const agentDir = join(homedir(), ".pi", "agent");
for (const path of [profile, taskRoot, directory, output]) mkdirSync(path, { recursive: true });
app.setPath("userData", profile);
process.env.PIDOCK_AGENT_DIR = agentDir;
delete process.env.PIDOCK_RENDERER_URL;
delete process.env.PIDOCK_TASK_URL;
const chosen = { provider: "cc-switch-deep-seek", model: "deepseek-flash" };
const prompt = "Reply with exactly PIDOCK_NATIVE_LIVE_OK. Do not call tools.";
const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const originals = () => Object.fromEntries(["models.json", "auth.json", "settings.json", "keybindings.json", "mcp.json"].map(name => [name, existsSync(join(agentDir, name)) ? hash(join(agentDir, name)) : null]));
const originalHashes = originals();
const report = { chosen, started: new Date().toISOString(), productionPath: "App→main→Host→SDK", temporaryTask: true, toolsExecuted: 0, assertions: [], outcome: "not-started", phase: "startup", originalHashes, node: process.versions.node, electron: process.versions.electron };
const children = [];
let registry, origin, finished = false;
const check = (name, condition) => { report.assertions.push({ name, passed: Boolean(condition) }); if (!condition) throw Error(name); };
const wait = ms => new Promise(done => setTimeout(done, ms));
const finish = code => {
  if (finished) return; finished = true;
  report.ended = new Date().toISOString();
  report.originalsUnchanged = JSON.stringify(originals()) === JSON.stringify(originalHashes);
  report.source = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const under = path => readdirSync(join(repo, path), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? under(`${path}/${entry.name}`) : [`${path}/${entry.name}`]);
  const sourcePaths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "packages/renderer/src", "packages/shell/src", "packages/shell/scripts/electron-native-config-live.mjs", "pnpm-lock.yaml"], { cwd: repo, encoding: "utf8" }).trim().split("\n");
  writeFileSync(join(output, "identity.json"), JSON.stringify({ source: Object.fromEntries(sourcePaths.map(path => [path, hash(join(repo, path))])), build: Object.fromEntries(under("packages/shell/dist").map(path => [path, hash(join(repo, path))])) }, null, 2));
  writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ outcome: report.outcome, phase: report.phase, chosen, originalsUnchanged: report.originalsUnchanged }));
  for (const child of children) { try { child.kill(); } catch { /* already exited */ } }
  app.exit(code);
};
setTimeout(() => { report.outcome = "watchdog-timeout"; finish(1); }, 180000).unref();
process.on("uncaughtException", () => { report.outcome = "uncaught-runtime-failure"; finish(1); });
process.on("unhandledRejection", () => { report.outcome = "runtime-or-model-failure"; finish(1); });
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
  const { HostClient } = await import("../dist/rpc/host-client.js");
  await app.whenReady();
  const index = new TaskRootIndex(profile, taskRoot), projects = new ProjectRegistry(profile);
  const workspace = await projects.create({ name: "Isolated native live validation", description: "Empty temporary directory; harmless acknowledgement only", directories: [{ name: "empty", path: directory }], repositories: [], environment: [], branchTemplate: "feature/{taskId}" });
  const views = await createTrustedWindow("manual-native-live", "production");
  views.window.setContentSize(1440, 900);
  registry = new PerTaskHostRegistry("manual-native-live", async (workspaceId, task, variables) => {
    const child = utilityProcess.fork(join(import.meta.dirname, "../dist/host/host-entry.js"), [], { serviceName: "manual-native-live-host", env: { ...buildHostEnv(process.env, workspaceId, task, profile, undefined, process.platform, variables), PIDOCK_MCP_CONFIG: join(root, "no-mcp.json") }, stdio: "pipe" });
    children.push(child);
    // Do not relay arbitrary network errors or SDK logs to public output.
    child.stderr?.on("data", () => {});
    return { child, client: new HostClient(child) };
  }, id => index.resolve(id), undefined, index);
  const profiles = new ProviderProfileStore(profile);
  let installedModel = null;
  const providers = new ProviderWiring(profiles, async (taskId, provider, senderWebContentsId) => {
    const config = provider === null ? null : profiles.config(provider.profileId, provider.modelId);
    await registry.routeTaskOp({ taskId, op: "task/sdkProvider", payload: provider === null ? { provider: null } : { provider: { config, credential: provider.credential, thinkingLevel: provider.thinkingLevel } }, origin: { kind: "shell-ui", senderWebContentsId } });
    installedModel = config?.modelId ?? null;
  }, process.env, { secrets: new ProviderSecretStore(profile, createTestSafeStorage()), native: new NativeModelsFile(agentDir) });
  const creation = new ProjectTaskCreation(new CreationIntentStore(profile), projects, index, registry, taskRoot, undefined, new WorktreeMetadataLock(profile, { notify: () => {} }));
  registerIpc(createUnavailableHostClient(), views.registry, registry, projects, index, undefined, creation, providers, new ServiceCatalog(profile, serviceCatalogAuthority(index, projects)));
  origin = { kind: /** @type {const} */ ("shell-ui"), senderWebContentsId: views.shellView.webContents.id };
  creation.saveDeliverySettings({ branchTemplate: "feature/{taskId}", remote: "origin" });
  const intent = await creation.prepare({ projectId: workspace.id, name: "Native live acknowledgement", repositories: [], directoryIds: [workspace.directories[0].id], sharedWriteConfirmed: true, override: false, workspaceMode: "plain-dirs" });
  const task = await creation.commit(intent.id);
  await registry.routeTaskOp({ taskId: task.taskId, op: "task/sessionRename", payload: { sessionId: "main", name: "主会话" }, origin });
  await loadTrustedViews(views);
  const wc = views.shellView.webContents;
  wc.debugger.attach();
  const evaluate = async expression => {
    const result = await wc.debugger.sendCommand("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error("renderer-evaluation-failed");
    return result.result.value;
  };
  const until = async (expression, attempts = 200) => {
    report.waitingFor = expression;
    for (let i = 0; i < attempts; i++) { if (await evaluate(`Boolean(${expression})`)) return; await wait(100); }
    throw Error("renderer-condition-timeout");
  };
  const click = async label => { await until(`[...document.querySelectorAll('button')].some(el => (el.getAttribute('aria-label') ?? el.textContent.trim()) === ${JSON.stringify(label)} && el.getBoundingClientRect().width > 0)`); await evaluate(`(() => { const el = [...document.querySelectorAll('button')].find(el => (el.getAttribute('aria-label') ?? el.textContent.trim()) === ${JSON.stringify(label)} && el.getBoundingClientRect().width > 0); if (!el || el.disabled) throw Error('disabled'); el.scrollIntoView(); el.click(); })()`); await wait(150); };
  report.phase = "select-native";
  await click("Native live acknowledgement");
  await until("document.querySelector('[data-testid=desktop-task-facts]')");
  await click("进入对话 · 主会话");
  await until("document.querySelector('textarea[aria-label=消息]')");
  await click("能力管理");
  await until("document.querySelector('.provider-row')");
  const available = /** @type {{ profiles: import("../dist/main/provider-ipc.js").ProviderView[] }} */ (await providers.perform({ op: "list" }, wc.id));
  const native = available.profiles.find(row => row.native?.providerId === chosen.provider);
  check("existing configured model is publicly visible", native?.models.some(row => row.id === chosen.model));
  await evaluate(`document.querySelector('[data-testid="provider-card-${native.id}"] select').value = ${JSON.stringify(chosen.model)}`);
  await evaluate(`document.querySelector('[data-testid="provider-card-${native.id}"] select').dispatchEvent(new Event('change', { bubbles: true }))`);
  await evaluate(`(() => { const row = document.querySelector('[data-testid="provider-card-${native.id}"]'); row.querySelector('details').open = true; [...row.querySelectorAll('button')].find(button => button.textContent.trim() === '选用').click(); })()`);
  for (let i = 0; i < 120 && installedModel !== chosen.model; i++) await wait(100);
  check("native selected model is installed into actual Host", installedModel === chosen.model);
  const selected = providers.status(task.taskId);
  check("task binding pins the original native model", selected.state === "configured" && selected.modelId === chosen.model);
  if (preflight) {
    check("all original native files are byte-identical", JSON.stringify(originals()) === JSON.stringify(originalHashes));
    const cleanup = await shutdownTestRegistry(registry, { origin, label: "Native live preflight shutdown" });
    check("actual Host stopped gracefully", cleanup.length === 0);
    rmSync(root, { recursive: true, force: true });
    report.outcome = "preflight-passed-no-request";
    report.phase = "complete";
    finish(0);
    return;
  }
  await click("返回任务工作区");
  await until("document.querySelector('textarea[aria-label=消息]')");
  report.phase = "one-live-turn";
  await evaluate(`(() => { const input = document.querySelector('textarea[aria-label=消息]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input, ${JSON.stringify(prompt)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await click("发送");
  const privateMessages = () => readdirSync(taskRoot, { recursive: true }).filter(path => String(path).endsWith(".jsonl")).flatMap(path => readFileSync(join(taskRoot, String(path)), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(record => record.type === "message").map(record => record.message));
  let assistant;
  for (let attempt = 0; attempt < 1200; attempt++) {
    const messages = privateMessages();
    const failed = messages.find(message => message.role === "assistant" && message.stopReason === "error");
    if (failed) {
      report.sdkFailureCode = failed.errorMessage === "provider-request-failed" ? "provider-request-failed" : "sdk-error";
      report.outcome = "live-provider-rejected";
      const cleanup = await shutdownTestRegistry(registry, { origin, label: "Native live failed-turn shutdown" });
      report.hostCleanupConfirmed = cleanup.length === 0;
      finish(1);
      return;
    }
    assistant = messages.find(message => message.role === "assistant" && message.content?.some(block => block.type === "text" && block.text.includes("PIDOCK_NATIVE_LIVE_OK")));
    if (assistant) break;
    await wait(100);
  }
  check("actual remote assistant acknowledged the unique harmless prompt", Boolean(assistant));
  check("one request used the configured model", assistant.model === chosen.model);
  report.actualAssistantModel = assistant.model;
  report.reportedUsage = assistant.usage ? { input: assistant.usage.input, output: assistant.usage.output } : null;
  check("one harmless user message was sent", privateMessages().filter(message => message.role === "user").length === 1);
  await until("document.querySelector('[data-testid=desktop-message-column]')?.textContent.includes('PIDOCK_NATIVE_LIVE_OK')");
  report.assistantAcknowledgement = "PIDOCK_NATIVE_LIVE_OK";
  report.phase = "preservation-and-shutdown";
  check("no filesystem content was introduced", readdirSync(directory).filter(name => name !== ".pi").length === 0);
  const sessionLogPaths = readdirSync(taskRoot, { recursive: true }).filter(path => String(path).endsWith(".jsonl"));
  let toolCalls = 0;
  for (const path of sessionLogPaths) {
    for (const line of readFileSync(join(taskRoot, String(path)), "utf8").split("\n").filter(Boolean)) {
      const record = JSON.parse(line);
      if (record.message?.role === "toolResult") toolCalls++;
      if (Array.isArray(record.message?.content)) toolCalls += record.message.content.filter(block => block.type === "toolCall").length;
    }
  }
  report.toolsExecuted = toolCalls;
  check("no tools executed", toolCalls === 0);
  check("all original native files are byte-identical", JSON.stringify(originals()) === JSON.stringify(originalHashes));
  const cleanup = await shutdownTestRegistry(registry, { origin, label: "Native live validation shutdown" });
  check("actual Host stopped gracefully", cleanup.length === 0);
  rmSync(root, { recursive: true, force: true });
  report.outcome = "passed";
  report.phase = "complete";
  finish(0);
}
void run();
