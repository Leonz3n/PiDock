// #157: built production Electron, real preload/IPC/Host/registry/disk; isolated fixtures only.
// Run after pnpm --filter @pidock/shell build. Each viewport is a fresh real window.
import { app, utilityProcess } from "electron";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, renameSync } from "node:fs";
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
const output = join(repo, "docs/evidence/pencil-ui-u02", ...(reusedRoot ? ["restart"] : []), ...(scenario === "workspace" ? ["workspace"] : []));
const root = reusedRoot || mkdtempSync(join(tmpdir(), "pidock-ui-u02-"));
const profile = join(root, "profile");
const taskRoot = join(root, "tasks");
const agentDir = join(root, "agent");
for (const path of [profile, taskRoot, agentDir, output]) mkdirSync(path, { recursive: true });
app.setPath("userData", reusedRoot ? join(root, "chromium-restart") : profile);
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
  writeFileSync(join(output, `${width}x${height}-${scenario}-log.json`), JSON.stringify({ scenario, size: [width, height], root, sourceDiffSha256: createHash("sha256").update(execFileSync("git", ["diff", "HEAD", "--", "packages/renderer/src", "packages/shell/scripts/electron-pencil-ui-u02-capture.mjs"], { cwd: repo })).digest("hex"), source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), designSha256: hash(join(repo, "docs/design/PiDock.pen")), buildSha256: hash(join(repo, "packages/shell/dist/renderer/index.html")), node: process.versions.node, electron: process.versions.electron, assertions, shots, calls, consoleErrors, error: error ?? null }, null, 2));
  console.log(`U02_CAPTURE ${width}x${height} ${scenario} ${code} ${error ?? "PASS"}`);
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
  const directory = join(root, "sources", "shared-directory-with-a-long-name-for-path-wrapping");
  const fixture = reusedRoot ? JSON.parse(readFileSync(join(root, "fixture.json"), "utf8")) : null;
  let workspace;
  if (fixture) workspace = projects.get(fixture.workspaceId);
  else {
  mkdirSync(source, { recursive: true }); mkdirSync(directory, { recursive: true });
  const git = (args) => execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();
  git(["init", "-q", "-b", "main"]);
  writeFileSync(join(source, "README.md"), "U02 real Git source\n");
  git(["add", "."]); git(["-c", "user.name=Evidence", "-c", "user.email=evidence@example.invalid", "commit", "-qm", "base"]);
  const remote = join(root, "remote.git");
  execFileSync("git", ["clone", "-q", "--bare", source, remote]);
  git(["remote", "add", "origin", remote]);
    workspace = await projects.create({ name: "PiDock 核心开发", description: "U02 真实生产工作空间分层验收", repositories: [{ name: "pidock", path: source }], directories: [{ name: "common-configs", path: directory }], environment: [{ key: "NODE_ENV", value: "development" }], branchTemplate: "feature/{taskId}" });
  }
  if (!workspace) throw Error("persisted workspace missing on restart");
  const taskVariables = new TaskVariableStore(profile);
  const taskEnvironment = (id) => {
    const association = projects.association(id, index);
    const project = association.projectId === null ? undefined : projects.get(association.projectId);
    return variableEnvironment(resolveTaskVariables(project?.environment ?? [], taskVariables.list(id)).rows);
  };
  views = await createTrustedWindow("pencil-ui-u02", "production");
  views.window.setContentSize(width, height);
  registry = new PerTaskHostRegistry("pencil-ui-u02", async (workspaceId, task, variables) => {
    const child = utilityProcess.fork(join(import.meta.dirname, "../dist/host/host-entry.js"), [], { serviceName: "pencil-ui-u02-host", env: buildHostEnv(process.env, workspaceId, task, profile, undefined, process.platform, variables), stdio: "pipe" });
    children.push(child);
    child.stderr?.on("data", (data) => process.stderr.write(data));
    return { child, client: new HostClient(child) };
  }, (id) => index.resolve(id), undefined, index, taskEnvironment);
  const route = registry.routeTaskOp.bind(registry);
  registry.routeTaskOp = (request) => { calls.push({ op: request.op, taskId: request.taskId, payload: request.payload }); return route(request); };
  const providerProfiles = new ProviderProfileStore(profile);
  const providers = new ProviderWiring(providerProfiles, async (taskId, provider, senderWebContentsId) => {
    await registry.routeTaskOp({ taskId, op: "task/sdkProvider", payload: provider === null ? { provider: null } : { provider: { config: providerProfiles.config(provider.profileId), credential: provider.credential } }, origin: { kind: "shell-ui", senderWebContentsId } });
  });
  const creation = new ProjectTaskCreation(new CreationIntentStore(profile), projects, index, registry, taskRoot);
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
  if (fixture) check("fresh process restores original task records", tasks.every((task, index) => hash(join(taskRoot, task.taskId, "task.json")) === fixture.recordHashes[index]));
  const recordsBefore = tasks.map(task => readFileSync(join(taskRoot, task.taskId, "task.json"), "utf8"));
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
    check(`control reachable: ${label}`, await evaluate(`(() => { const el = [...document.querySelectorAll('button')].find(el => (el.getAttribute('aria-label') ?? el.textContent.trim()) === ${JSON.stringify(label)} && el.getBoundingClientRect().width > 0 && !el.closest('[hidden]')); if (!el) return false; el.click(); return true; })()`));
    await wait(100);
  };
  const sidebarClick = async (label) => {
    if (width < 960 && !(await evaluate("document.querySelector('[data-testid=desktop-sidebar]')?.dataset.expanded === 'true'"))) await click("展开导航");
    await until(`[...document.querySelectorAll("button")].some(el => el.getAttribute("aria-label") === ${JSON.stringify(label)} || el.textContent.trim() === ${JSON.stringify(label)})`, `sidebar ${label}`);
    await click(label);
    if (width < 960 && await evaluate("document.querySelector('[data-testid=desktop-sidebar]')?.dataset.expanded === 'true'")) await click("收起导航");
  };
  const capture = async (state) => {
    views.window.show(); app.focus({ steal: true }); views.window.moveTop(); views.window.focus(); await wait(180);
    const metrics = await evaluate(`(() => {
      const box = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, scrollWidth:el.scrollWidth }; };
      return { viewport:[innerWidth,innerHeight], theme:document.documentElement?.dataset.theme,
        facts:box(document.querySelector('[data-testid=desktop-task-facts]')), conversation:box(document.querySelector('[data-testid=desktop-conversation]')),
        compactFacts:box(document.querySelector('[data-testid=desktop-session-facts]')), overview:box(document.querySelector('[data-testid=desktop-project-overview]')),
        composer:Boolean(document.querySelector('textarea[aria-label=消息]')), horizontalOverflow:document.documentElement.scrollWidth > innerWidth,
        sections:[...document.querySelectorAll('[data-testid=desktop-project-overview] section, [data-testid=desktop-task-facts] section')].map(el=>({label:el.getAttribute('aria-label'), ...box(el)})),
        text:document.querySelector('[data-testid=desktop-shell-content]')?.innerText };
    })()`);
    check(`${state}: exact renderer viewport`, metrics.viewport[0] === width && metrics.viewport[1] === height, metrics.viewport);
    check(`${state}: no horizontal document overflow`, !metrics.horizontalOverflow, metrics);
    check(`${state}: task facts and conversation never stacked`, !(metrics.facts && metrics.conversation), metrics);
    if (metrics.facts) check(`${state}: facts contain no composer`, !metrics.composer);
    for (const section of metrics.sections) check(`${state}: ${section.label} fits available width`, section.scrollWidth <= section.width + 2, section);
    const name = `${width}x${height}-${state}.png`;
    const shot = await wc.debugger.sendCommand("Page.captureScreenshot", { format:"png", captureBeyondViewport:false });
    writeFileSync(join(output,name),Buffer.from(shot.data,"base64"));
    shots.push({file:name,sha256:hash(join(output,name)),metrics});
  };
  check("production built renderer", /^file:.*\/renderer\/index.html$/.test(await evaluate("location.href")));
  for (const theme of ["light", "dark"]) {
    await evaluate(`window.pidock.preferencesOp({op:'appearance/save', appearance:'${theme}'})`);
    wc.reload();
    await until(`document.documentElement?.dataset.theme === '${theme}' && document.querySelector('[data-testid=desktop-project-overview]')`, "workspace theme");
    await until("document.body.innerText.includes('路径可用') && document.querySelectorAll('[data-task-nav]').length === 4 && document.querySelector('[data-testid=overview-task-count-inline]')?.textContent === '4'", "workspace sources and lifecycle verified");
    await capture(`${theme}-workspace`);
    if (scenario === "workspace") continue;
    for (const task of tasks) {
      await sidebarClick(task.name);
      await until("document.querySelector('[data-testid=task-facts-mode]') && document.querySelector('[data-testid=task-facts-sessions]')?.textContent.includes('个')", "task facts");
      await until(`document.querySelector('[data-testid=desktop-breadcrumb]')?.innerText.includes(${JSON.stringify(task.name)}) && document.querySelector('[data-testid=desktop-task-facts]')?.innerText.includes('已核验')`, "Host verifies the selected task sources");
      check(`${theme}: ${task.mode} uses Host verified sources`, true);
      if (task.mode === "empty") await until("document.querySelector('[data-testid=desktop-task-facts]')?.innerText.includes('此任务尚无会话')", "empty list resolved");
      if (task.mode === "empty") check(`${theme}: empty session history is honest`, await evaluate("document.querySelector('[data-testid=desktop-task-facts]').innerText.includes('此任务尚无会话')"));
      await capture(`${theme}-${task.mode}-facts`);
      if (task.mode === "empty") {
        await click("在当前任务工作区中新建会话（全新上下文）");
        await until("document.querySelector('textarea[aria-label=消息]')", "explicit new session conversation");
        const created = await registry.routeTaskOp({ taskId: task.taskId, op: "task/sessionList", payload: {}, origin });
        check(`${theme}: explicit creation owns one real session`, Array.isArray(created.payload?.sessions) && created.payload.sessions.length === 1 && Boolean(created.payload?.activeSessionId), created);
        await capture(`${theme}-new-session`);
        await sidebarClick(workspace.name);
        await registry.routeTaskOp({ taskId: task.taskId, op: "task/sessionDelete", payload: { sessionId: created.payload.activeSessionId }, origin });
      }
    }
    await sidebarClick(first.name);
    await until("[...document.querySelectorAll('button')].some(el=>el.getAttribute('aria-label')==='进入对话 · 边界复核会话')", "named session entry");
    await evaluate(`document.querySelector('[data-testid=desktop-task-facts] > details > summary').click()`);
    await until("document.querySelector('[data-testid=variable-NODE_ENV]')", "inherited variable");
    await click("覆盖此键");
    await evaluate(`(() => { const el=document.querySelector('input[aria-label=任务变量值]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'test'); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await click("保存任务覆盖");
    await until("document.querySelector('[data-testid=variable-NODE_ENV]')?.innerText.includes('任务覆盖')", "saved task override");
    await capture(`${theme}-variables-override`);
    await click("删除覆盖");
    await until("document.querySelector('[data-testid=variable-NODE_ENV]')?.innerText.includes('工作区继承')", "restored inheritance");
    await click("进入对话 · 边界复核会话");
    await until("document.querySelector('textarea[aria-label=消息]')", "conversation");
    await capture(`${theme}-session`);
    await evaluate(`(() => { const el=document.querySelector('textarea[aria-label=消息]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'U02 未发送草稿'); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await wait(500);
    await click("返回任务事实");
    await until("document.querySelector('[data-testid=desktop-task-facts]')", "return facts");
    await capture(`${theme}-returned-facts`);
    await sidebarClick("边界复核会话");
    await until("document.querySelector('textarea[aria-label=消息]')?.value === 'U02 未发送草稿'", "persisted draft on direct session reopen");
    check(`${theme}: direct sidebar restores named session draft`, true);
    await capture(`${theme}-direct-session`);
    await click("返回任务事实");
    await click("返回工作空间总览");
    await until("document.querySelector('[data-testid=desktop-project-overview]')", "back workspace");
    await wc.reload();
    await until("document.querySelector('[data-testid=desktop-project-overview]')", "reload");
    check(`${theme}: reload retains disk workspace identity`, await evaluate(`document.body.innerText.includes(${JSON.stringify(workspace.name)})`));
  }
  if (scenario === "workspace") {
    const shutdown = await shutdownTestRegistry(registry, { origin, label: "U02 workspace refinement complete" });
    check("Host shutdown confirmed", shutdown.length === 0, shutdown);
    finish(0); return;
  }
  // Real absent/replaced source identities, never simulated renderer status.
  renameSync(directory, `${directory}-original`);
  await sidebarClick(tasks[2].name);
  await until("document.querySelector('[data-testid=desktop-task-facts] [role=alert]') || document.querySelector('[data-testid=desktop-task-facts]')?.innerText.includes('来源缺失')", "missing source named refusal");
  await capture("dark-missing-source");
  mkdirSync(directory);
  await sidebarClick(workspace.name);
  await sidebarClick(tasks[2].name);
  await until("document.querySelector('[data-testid=desktop-task-facts]')?.innerText.includes('身份不符')", "replaced source identity");
  await capture("dark-mismatch-source");
  await click("修复来源路径");
  await until("document.querySelector('[role=dialog] input')", "source repair workspace editor");
  await capture("dark-source-repair");
  await click("取消");
  renameSync(directory, `${directory}-replacement`);
  renameSync(`${directory}-original`, directory);
  await sidebarClick(workspace.name);
  await sidebarClick(tasks[2].name);
  await until("document.querySelector('[data-testid=desktop-task-facts]')?.innerText.includes('已核验')", "restored source identity recovery");
  await capture("dark-source-recovered");
  check("task records never migrated by navigation", tasks.every((task,index) => readFileSync(join(taskRoot, task.taskId, "task.json"),"utf8") === recordsBefore[index]));
  check("navigation sends no model request or tool execution", !calls.some(call=> /sdkSend|sendMessage|execute|toolReplay/.test(call.op)), calls.map(call=>call.op));
  check("no renderer console errors", consoleErrors.length === 0, consoleErrors);
  const shutdown = await shutdownTestRegistry(registry, { origin, label: "U02 capture complete" });
  check("Host shutdown confirmed", shutdown.length === 0, shutdown);
  finish(0);
}
void run().catch(error=>finish(1,error.stack ?? String(error)));
