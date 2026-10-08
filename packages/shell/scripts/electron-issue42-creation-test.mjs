// [PiDock 02i] (#42) box 3: isolated real-window creation and cold-start reopen.
//
// Both phases wire the real main-side components — `ProjectRegistry`,
// `ProjectTaskCreation`/`CreationIntentStore`, `TaskRootIndex` and a real
// per-task `utilityProcess` Host running `dist/host/host-entry.js` — behind the
// production `shell/createTask`, `shell/taskOp` and `shell/projectOp` handlers.
// Only the Electron window/entry point belongs to the harness, exactly like
// `electron-issue45-desktop-test.mjs`; no `memoryHost` fixture is involved.
//
// Run after `pnpm --filter @pidock/shell build`:
//   PIDOCK_ISSUE42_ROOT=$(mktemp -d) electron scripts/electron-issue42-creation-test.mjs --phase=create
//   PIDOCK_ISSUE42_ROOT=<same>       electron scripts/electron-issue42-creation-test.mjs --phase=reopen
// The caller owns the isolated root (default task root, profile, local bare
// Git remote and checkout) and removes it afterwards.
import { app, utilityProcess } from "electron";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHostEnv } from "../dist/host/host-guards.js";
import { readTaskRecordOnDisk } from "../dist/host/task-store.js";
import { CreationIntentStore, ProjectTaskCreation } from "../dist/main/project-task-creation.js";
import { ProjectRegistry } from "../dist/main/project-registry.js";
import { TaskRootIndex } from "../dist/main/task-root-index.js";
import { createTrustedWindow, loadTrustedViews, PerTaskHostRegistry, registerIpc } from "../dist/main/runtime.js";
import { HostClient } from "../dist/rpc/host-client.js";
import { shutdownTestRegistry } from "./shutdown-test-registry.mjs";

const phase = process.argv.find((value) => value.startsWith("--phase="))?.slice("--phase=".length) ?? "create";
if (phase !== "create" && phase !== "reopen") throw new Error(`unknown phase ${phase}`);
const root = process.env["PIDOCK_ISSUE42_ROOT"];
if (!root) throw new Error("PIDOCK_ISSUE42_ROOT is required; the caller owns cleanup");
const profile = join(root, "profile");
const taskRoot = join(root, "tasks");
const repo = join(root, "repo");
const remote = join(root, "remote.git");
const shots = process.env["PIDOCK_ISSUE42_SHOTS"] ?? tmpdir();
const shared = join(root, "shared");
const projectName = "本地验证项目";
const taskName = "真实创建任务";
const dirty = "dirty.txt";

app.setPath("userData", profile);
// Test-only guard: a noop listener suppresses Electron's default quit on
// window-all-closed, which would race the explicit app.exit(process.exitCode).
app.on("window-all-closed", () => {});
const children = [];
let views;
let registry;
let failures = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const assert = (condition, message) => { if (!condition) failures.push(message); };
const watchdog = setTimeout(() => { console.error("ISSUE42_GUI_TIMEOUT " + JSON.stringify({ phase, failures })); process.exit(1); }, 90000);

function prepareCreateRoot() {
  mkdirSync(profile, { recursive: true }); mkdirSync(taskRoot, { recursive: true }); mkdirSync(repo, { recursive: true }); mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, "notes.txt"), "shared source content\n");
  git(root, "init", "--bare", remote);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@localhost"); git(repo, "config", "user.name", "Test");
  git(repo, "remote", "add", "origin", remote);
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md"); git(repo, "commit", "-m", "base"); git(repo, "push", "-u", "origin", "main");
  // Uncommitted content the creation flow must never touch.
  writeFileSync(join(repo, dirty), "keep me\n");
}

async function main() {
  if (phase === "create") prepareCreateRoot();
  const index = new TaskRootIndex(profile, taskRoot);
  const projects = new ProjectRegistry(profile);
  const project = phase === "create"
    ? await projects.create({ name: projectName, description: "本机临时裸仓库验证", repositories: [{ name: "Web", path: repo }], directories: [{ name: "Shared", path: shared }] })
    : projects.list().projects[0];
  if (!project) throw new Error("no registered Project to reopen");
  registry = new PerTaskHostRegistry("issue42", async (workspace, task) => {
    const child = utilityProcess.fork(join(import.meta.dirname, "..", "dist", "host", "host-entry.js"), [], {
      serviceName: "issue42-gui-host", env: buildHostEnv(process.env, workspace, task, app.getPath("userData")), stdio: "pipe",
    });
    children.push(child);
    child.stderr?.on("data", (data) => process.stderr.write(`[issue42-host] ${data}`));
    return { child, client: new HostClient(child) };
  }, (taskId) => index.resolve(taskId), undefined, index);
  const creation = new ProjectTaskCreation(new CreationIntentStore(profile), projects, index, registry, taskRoot);
  views = await createTrustedWindow("issue42", "production");
  registerIpc({}, views.registry, registry, projects, index, undefined, creation);
  await loadTrustedViews(views);
  views.shellView.webContents.debugger.attach();
  const evaluate = async (expression) => {
    const response = await views.shellView.webContents.debugger.sendCommand("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  // A reload/destroy moment can leave `document.body` null; treat it as an
  // empty frame instead of failing the read.
  const read = () => evaluate("({ text: document.body?.innerText ?? \"\", html: document.body?.innerHTML ?? \"\" })");
  const capture = async (label) => {
    // Test-only display stabilization: an unfocused window can report
    // "display surface not available" to capturePage.
    views.window.show();
    views.window.focus();
    await wait(250);
    const screenshot = join(shots, `pidock-42-gui-${phase}-${label}.png`);
    writeFileSync(screenshot, (await views.shellView.webContents.capturePage()).toPNG());
    return screenshot;
  };
  const until = async (match, label) => {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const state = await read();
      if (match(state)) return state;
      await wait(100);
    }
    const state = await read();
    throw new Error(`UI timeout (${label}): ${state.text.slice(0, 2000)}`);
  };
  const click = (name) => evaluate(`(() => {
    const button = [...document.querySelectorAll("button")].find((el) => el.textContent.trim() === ${JSON.stringify(name)});
    if (!button) throw Error("missing button " + ${JSON.stringify(name)});
    if (button.disabled) throw Error("disabled button " + ${JSON.stringify(name)});
    button.click(); return true;
  })()`);
  const setLabeledField = (label, value) => evaluate(`(() => {
    const field = [...document.querySelectorAll("label")].find((el) => el.textContent.includes(${JSON.stringify(label)}));
    if (!field) throw Error("missing label " + ${JSON.stringify(label)});
    const input = field.querySelector("input, textarea");
    if (!input) throw Error("missing input for " + ${JSON.stringify(label)});
    const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return input.value;
  })()`);
  const checkRepository = () => evaluate(`(() => {
    const fieldset = [...document.querySelectorAll("fieldset")].find((el) => el.querySelector("legend")?.textContent.includes("仓库与远程基线"));
    if (!fieldset) throw Error("missing repository fieldset");
    const box = fieldset.querySelector("input[type=checkbox]");
    if (!box) throw Error("missing repository checkbox");
    box.click(); return box.checked;
  })()`);

  const checkLabeled = (text) => evaluate(`(() => {
    const label = [...document.querySelectorAll("label")].find((el) => el.textContent.includes(${JSON.stringify(text)}));
    if (!label) throw Error("missing label " + ${JSON.stringify(text)});
    const box = label.querySelector("input[type=checkbox]");
    if (!box) throw Error("missing checkbox for " + ${JSON.stringify(text)});
    if (!box.checked) box.click();
    return box.checked;
  })()`);
  const readRecord = (taskId) => readTaskRecordOnDisk(join(taskRoot, taskId));
  const taskIds = () => readdirSync(taskRoot).filter((entry) => entry.startsWith("task-"));
  const diskIdentity = (taskId) => {
    const record = readRecord(taskId);
    return { taskId, name: record?.name, root: record?.root, taskDir: record?.taskDir, branch: record?.branch,
      baseCommits: record?.repoSources?.map((source) => `${source.repoDir}:${source.remote}/${source.remoteBranch}@${source.baseCommit}`),
      dirLinks: record?.dirLinks?.map((entry) => `${entry.linkName}->${entry.sourcePath}`),
      worktreeHeads: record?.repoSources?.map((source) => git(join(taskRoot, taskId, source.repoDir), "rev-parse", "HEAD")) };
  };

  const before = { head: git(repo, "rev-parse", "HEAD"), status: git(repo, "status", "--porcelain"),
    remotes: git(repo, "for-each-ref", "--format=%(refname)", "refs/remotes") };
  let created;
  if (phase === "create") {
    await until((state) => state.text.includes("项目管理"), "project overview");
    const overviewScreenshot = await capture("overview");
    await click("项目管理");
    await until((state) => state.text.includes("返回项目总览"), "management");
    await click("任务");
    await until((state) => state.html.includes("从项目创建任务"), "creation form");
    await setLabeledField("任务名称", taskName);
    assert(await checkRepository() === true, "repository checkbox did not select");
    assert(await checkLabeled("Shared ·") === true, "shared directory checkbox did not select");
    assert(await checkLabeled("我确认普通目录") === true, "shared-write confirmation did not select");
    await setLabeledField("远程名称", "origin");
    await setLabeledField("远程分支", "main");
    const formScreenshot = await capture("form");
    await click("固定基线并预览路径");
    const preview = await until((state) => state.text.includes("任务路径预览"), "path preview");
    const intent = new CreationIntentStore(profile).read();
    if (!intent) throw new Error("no durable creation intent after preview");
    assert(preview.text.includes(intent.taskDir), "preview did not show the actual task directory");
    assert(preview.text.includes(intent.repos[0].commit), "preview did not show the pinned commit");
    assert(preview.text.includes(intent.repos[0].repoDir), "preview did not show the repository worktree path");
    assert(preview.text.includes(intent.directories[0].linkName) && preview.text.includes(shared), "preview did not show the shared directory link");
    const previewScreenshot = await capture("preview");
    await click("确认创建 / 恢复");
    await until((state) => !state.html.includes("任务路径预览") && state.text.includes(taskName), "created task in project list");
    const createdScreenshot = await capture("created");
    created = intent.taskId;
    assert(taskIds().includes(created), "task directory was not created");
    const record = readRecord(created);
    assert(record?.taskId === created && record?.dirId === created, "task.json does not hold the created identity");
    assert(record?.repoSources?.[0]?.baseCommit === intent.repos[0].commit, "task.json baseCommit is not the pinned commit");
    assert(git(join(taskRoot, created, intent.repos[0].repoDir), "rev-parse", "HEAD") === intent.repos[0].commit, "worktree HEAD is not the pinned commit");
    assert(index.resolve(created) === join(taskRoot, created), "root index does not resolve the created task");
    assert(projects.association(created, index).state === "assigned", "task was not associated to the Project");
    assert(projects.association(created, index).projectId === project.id, "task association holds another Project");
    const link = join(taskRoot, created, intent.directories[0].linkName);
    assert(lstatSync(link).isSymbolicLink() && readlinkSync(link) === shared, "shared directory link was not created at the previewed path");
    assert(readdirSync(shared).join() === "notes.txt" && readFileSync(join(shared, "notes.txt"), "utf8") === "shared source content\n",
      "creating the task modified the shared source directory");
    assert(new CreationIntentStore(profile).read()?.state === "complete", "creation intent was not completed");
    assert(git(repo, "rev-parse", "HEAD") === before.head, "main checkout HEAD changed");
    assert(git(repo, "status", "--porcelain") === before.status, "main checkout status changed");
    assert(readFileSync(join(repo, dirty), "utf8") === "keep me\n", "main checkout uncommitted content changed");
    assert(git(repo, "for-each-ref", "--format=%(refname)", "refs/remotes") === before.remotes, "remote-tracking refs changed");
    // In-process page reload: the same identity is re-read from disk.
    views.shellView.webContents.reload();
    await until((state) => state.html.includes(`data-overview-task="${created}"`), "task after reload");
    const reloadedScreenshot = await capture("reloaded");
    const reloaded = diskIdentity(created);
    console.log("ISSUE42_GUI_CREATE=" + JSON.stringify({ projectId: project.id, taskId: created, taskDir: intent.taskDir,
      baseCommit: intent.repos[0].commit, commit: intent.repos[0].commit, record: reloaded, dirtyUntouched: true,
      overviewScreenshot, formScreenshot, previewScreenshot, createdScreenshot, reloadedScreenshot }));
  } else {
    created = taskIds().find((taskId) => readRecord(taskId)?.name === taskName);
    assert(taskIds().length === 1, `expected exactly one created task, found ${JSON.stringify(taskIds())}`);
    const record = created ? readRecord(created) : null;
    assert(record?.repoSources?.[0]?.baseCommit !== undefined, "reopened task lost its pinned base commit");
    assert(record ? git(join(taskRoot, created, record.repoSources[0].repoDir), "rev-parse", "HEAD") === record.repoSources[0].baseCommit : false,
      "reopened worktree HEAD is not the pinned commit");
    assert(created !== undefined && index.resolve(created) === join(taskRoot, created), "reopened root index lost the task");
    assert(created !== undefined && projects.association(created, index).state === "assigned", "reopened task lost its Project association");
    assert(created !== undefined && projects.association(created, index).projectId === project.id, "reopened task moved to another Project");
    assert(record?.dirLinks?.length === 1 && lstatSync(join(taskRoot, created, record.dirLinks[0].linkName)).isSymbolicLink()
      && readlinkSync(join(taskRoot, created, record.dirLinks[0].linkName)) === shared, "reopened task lost its shared directory link");
    assert(git(repo, "status", "--porcelain") === before.status, "main checkout status changed across the cold start");
    assert(git(repo, "rev-parse", "HEAD") === before.head, "main checkout HEAD changed across the cold start");
    await until((state) => state.text.includes(taskName) && state.html.includes(`data-overview-task="${created}"`), "reopened task card");
    const screenshot = await capture("reopened");
    console.log("ISSUE42_GUI_REOPEN=" + JSON.stringify({ projectId: project.id, taskId: created,
      taskDir: record?.taskDir, commit: record?.repoSources?.[0]?.baseCommit, screenshot,
      profileArtifacts: readdirSync(profile).filter((entry) => entry.startsWith("projects.json") || entry.startsWith("task-") || entry.includes("demo")) }));
  }
  const demoArtifacts = readdirSync(profile).filter((entry) => /demo|fixture|memory/i.test(entry));
  assert(demoArtifacts.length === 0, `demo/fixture artifacts were written: ${JSON.stringify(demoArtifacts)}`);
}

async function run() {
  try {
    await app.whenReady();
    await main();
  } catch (error) {
    failures.push(`threw: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(watchdog);
    const cleanupFailures = await shutdownTestRegistry(registry, {
      origin: views ? { kind: "shell-ui", senderWebContentsId: views.shellView.webContents.id } : undefined,
      label: "issue42 GUI test cleanup",
    });
    for (const child of children) child.kill();
    if (views?.shellView.webContents.debugger.isAttached()) views.shellView.webContents.debugger.detach();
    views?.window.destroy();
    // The isolated root is never removed here: the caller owns it and reuses it
    // for the reopen phase.
    for (const failure of [...cleanupFailures, ...failures]) console.error(`ISSUE42_GUI_FAILURE ${phase}: ${failure}`);
    console.log(`ISSUE42_GUI_${phase.toUpperCase()}_RESULT=` + JSON.stringify({ phase, ok: failures.length === 0 && cleanupFailures.length === 0, failures, cleanupFailures }));
    app.exit(failures.length === 0 ? 0 : 1);
  }
}

void run();
