// [PiDock pencil-v1] (#147 / #153 / #154) T18 lifecycle, scheduler and cleanup
// verification. One real Electron app per phase, production wiring, real Host
// processes, real git repositories, and disk/process assertions instead of UI
// text alone.
//
// Phases (each is its own OS process, same temp root):
//   primary     seed a real workspace + a scheduled task + a task to clean;
//               overlap trigger skipped with a recorded reason, close-window
//               background continuation, sleep/wake gate with no backfill,
//               destructive cleanup of a managed worktree (#147).
//   kill        start a real scheduled run, then SIGKILL the whole process tree
//               (main + Host + SDK worker) mid-trigger.
//   restart     cold start: the killed run reconciles to interrupted/uncertain
//               (never completed) with no duplicate trigger; the archived task
//               row and its restore-readiness element are readable cold.
//   quitok      a real app.quit() while a turn is live: the Host aborts the
//               turn(s), the quit report proves every Host stopped.
//   failedquit  a real app.quit() that CANNOT stop a Host (its child is already
//               gone): the quit is refused, the app stays alive, the refusal is
//               persisted as an unconfirmed-quit report.
//   restart2    cold start: the persisted unconfirmed quit is visible; nothing
//               re-triggers and no model/tool call is replayed.
//
// Run after `pnpm build`:
//   pnpm --filter @pidock/shell exec electron scripts/electron-pencil-v1-t18-capture.mjs --phase primary
//   ... --phase kill / restart / quitok / failedquit / restart2
//
// Deliberately NOT real, and named in the README: the credential cipher
// (`createTestSafeStorage`), the Provider endpoint (a loopback OpenAI-compatible
// HTTP/SSE server), `PIDOCK_AGENT_DIR` (a temp agent dir), the git remotes (bare
// repositories under the OS temp dir). The Electron app, the window lifecycle,
// the Host processes, the schedule driver / gate / quit-report store, the
// lifecycle state machine, the worktrees and every git operation are real.
import { app, powerMonitor, utilityProcess } from "electron";
import { createUnavailableHostClient } from "./unavailable-host-client.mjs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

delete process.env["PIDOCK_RENDERER_URL"];
delete process.env["PIDOCK_TASK_URL"];

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const argValue = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const phase = argValue("--phase") ?? "primary";
const outDir = resolve(repoRoot, argValue("--out") ?? "docs/evidence/pencil-v1-t18");
const only = (argValue("--only") ?? "").split(",").map((name) => name.trim()).filter(Boolean);
const focused = only.length > 0;
const wanted = (name) => !focused || only.includes(name);
// A fixed temp root keeps captured paths stable across the phases.
const root = join(tmpdir(), "pidock-pencil-v1-t18-capture");
const profile = join(root, "profile");
const taskRoot = join(root, "tasks");
const sourcesRoot = join(root, "sources");
const remotesRoot = join(root, "remotes");
const agentDir = join(root, "agent");
const statePath = join(root, "state.json");
// The shell workspace id must be STABLE across phases: the archive page lists the
// tasks bound to this shell workspace, so a phase-suffixed id would make the cold
// start look like a different workspace (a harness artifact, not a product bug).
const workspaceId = "pencil-v1-t18";
app.setPath("userData", join(root, "chromium"));
const realAgentDir = join(homedir(), ".pi", "agent");
if (resolve(agentDir) === resolve(realAgentDir)) throw Error("refusing to use the real ~/.pi/agent");
process.env["PIDOCK_AGENT_DIR"] = agentDir;

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const pngPixelSize = (png) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const flat = (value) => String(value).replace(/\s+/g, " ").trim();
const readJson = (path, fallback = null) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } };

const children = [];
const hostPids = [];
// Every Host TRANSPORT call this process made, including the ones `quitAll`
// issues directly (it bypasses the registry's op seam), so the explicit-quit
// receipt (`abortedTurns`) is real evidence and not a restatement of the UI.
const hostTransportOps = [];
let views, registry, index, projects, providers, providerProfiles, secrets, nativeModels, creation, taskVariables;
let quitReports, gate, schedulesDriver, stopHostsBase;
let lastQuitReport = null;

let exiting = false;
const exitNow = (code, why) => {
  if (exiting) return;
  exiting = true;
  console.error(`T18_CAPTURE_EXIT ${phase}`, code, why);
  try { app.exit(code); } catch { process.exit(code); }
};
const watchdog = setTimeout(() => exitNow(1, "watchdog timeout"), 900000);
watchdog.unref?.();
process.on("uncaughtException", (error) => exitNow(1, `uncaughtException ${error?.stack ?? error}`));
process.on("unhandledRejection", (error) => exitNow(1, `unhandledRejection ${String(error instanceof Error ? error.stack : error)}`));
app.on("window-all-closed", () => { /* the harness owns its lifecycle */ });

const PROJECT_NAME = "T18 后台与退出验收工作区";
const API_KEY = "sk-t18-loopback-71b3c9a4";
const MODEL = "loopback-chat-7b";
const BRANCH_TEMPLATE = "ticket/{taskId}-{slug}";
const SCHEDULE_TASK_NAME = "T18 定时触发验收任务";
const CLEANUP_TASK_NAME = "T18 清理验收任务";
const SCHEDULE_NAME = "T18 每分钟触发";
// The loopback endpoint holds the response open for a prompt carrying this tag, so
// a run can be observed while it is really in flight (overlap, kill, quit-abort).
const SLOW_TAG = "T18-SLOW";
// 20s is long enough to hold a run in flight while the harness drives an
// overlap / SIGKILL / quit, and short enough to stay inside one minute bucket.
const HOLD_MS = Number(argValue("--hold-ms") ?? 20000);

const git = (cwd, args) => execFileSync("git", args, {
  cwd, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
  stdio: ["ignore", "pipe", "pipe"],
}).trim();
const gitSafe = (cwd, args) => { try { return git(cwd, args); } catch (error) { return `ERROR: ${String(error?.stderr ?? error?.message ?? error)}`; } };

const SEED_DATE = "2026-12-02T09:00:00+0000";
function seedRepo(name, readme, message) {
  const dir = join(sourcesRoot, name);
  const remote = join(remotesRoot, `${name}.git`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(remote, { recursive: true });
  git(remote, ["init", "--bare", "-b", "main"]);
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "evidence@pidock.local"]);
  git(dir, ["config", "user.name", "PiDock Evidence"]);
  git(dir, ["remote", "add", "origin", remote]);
  writeFileSync(join(dir, "README.md"), readme);
  git(dir, ["add", "README.md"]);
  execFileSync("git", ["commit", "-m", message], { cwd: dir, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: SEED_DATE, GIT_COMMITTER_DATE: SEED_DATE },
    stdio: ["ignore", "pipe", "pipe"] });
  git(dir, ["push", "-u", "origin", "main"]);
  return { name, dir, remote, head: git(dir, ["rev-parse", "HEAD"]) };
}

// ---------------------------------------------------------------- loopback endpoint
// Real HTTP server on 127.0.0.1: GET /v1/models + POST /v1/chat/completions SSE.
// A prompt carrying [T18-SLOW] streams one delta and then HOLDS the response, so
// the turn is genuinely in flight while the harness drives overlap / kill / quit.
const received = [];
const providerState = { port: 0, server: null, holds: 0 };
const withPort = (path) => `http://127.0.0.1:${providerState.port}${path}`;
const chatRequests = () => received.filter((row) => row.url.endsWith("/chat/completions"));
function startProvider(port) {
  return new Promise((done, reject) => {
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => {
        const url = request.url ?? "";
        received.push({ method: request.method, url, body, at: new Date().toISOString() });
        if (request.method === "GET" && url.endsWith("/models")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model", owned_by: "loopback" }] }));
          return;
        }
        if (!url.endsWith("/chat/completions")) { response.writeHead(404).end(); return; }
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* recorded empty */ }
        const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
        const lastUser = [...messages].reverse().find((row) => row?.role === "user");
        const userText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
        const slow = userText.includes(SLOW_TAG);
        const frame = (delta, extra = {}) => `data: ${JSON.stringify({
          id: "chatcmpl-t18-loopback", object: "chat.completion.chunk", model: MODEL,
          choices: [{ index: 0, delta, finish_reason: null }], ...extra,
        })}\n\n`;
        const finish = (text) => {
          response.write(frame({ content: text }));
          response.write(`data: ${JSON.stringify({ id: "chatcmpl-t18-loopback", object: "chat.completion.chunk", model: MODEL,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 19, completion_tokens: 7, total_tokens: 26 } })}\n\n`);
          response.write("data: [DONE]\n\n");
          response.end();
        };
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        if (!slow) { finish("T18-TEXT-DONE"); return; }
        providerState.holds += 1;
        response.write(frame({ content: `${SLOW_TAG}-START` }));
        // Held open on purpose: the run record stays `running` until this lands.
        setTimeout(() => { try { finish(`${SLOW_TAG}-DONE`); } catch { /* client already gone */ } }, HOLD_MS);
      });
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      providerState.port = typeof address === "object" && address ? address.port : port;
      done(server);
    });
    providerState.server = server;
  });
}
async function freePort() {
  return new Promise((done, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

/** Every descendant pid of this process (main -> utility Host -> SDK worker). */
function descendantPids(pid) {
  const table = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
    .trim().split("\n").map((row) => row.trim().split(/\s+/).map(Number));
  const byParent = new Map();
  for (const [child, parent] of table) {
    if (!Number.isFinite(child) || !Number.isFinite(parent)) continue;
    const list = byParent.get(parent) ?? [];
    list.push(child);
    byParent.set(parent, list);
  }
  const out = [];
  const walk = (current) => { for (const child of byParent.get(current) ?? []) { out.push(child); walk(child); } };
  walk(pid);
  return out;
}

async function run() {
  let stage = "startup";
  const log = { phase, shots: [], assertions: [], findings: [], failed: [], sections: [], ops: [], realVsTest: {}, identity: {} };
  log.realVsTest = {
    real: [
      "compiled production runtime modules (createTrustedWindow('production') + registerIpc)",
      "utilityProcess task Host + real HostClient RPC",
      "ScheduleDriver timer, SchedulerGate, QuitReportStore, registerApplicationLifecycle, powerMonitor listeners",
      "Host lifecycle state machine: archive, cleanup (git identity verification + `git worktree remove`), restore readiness",
      "real git repositories, real bare origins, real worktrees, real commits and pushes",
      "a real SIGKILL of the whole process tree and a real cold start afterwards",
    ],
    testOnly: [
      "createTestSafeStorage() instead of the OS keychain",
      "a loopback OpenAI-compatible HTTP/SSE endpoint on 127.0.0.1 (no online account)",
      "PIDOCK_AGENT_DIR / userData / task root in the OS temp dir",
      "bare git remotes in the OS temp dir instead of github.com",
      "the schedule driver tick is 1s in this harness (production default is 30s) so the real timer can be observed",
    ],
  };
  const check = (name, condition, detail = "") => {
    const entry = { name, ok: condition === true, detail: String(detail).slice(0, 900) };
    log.assertions.push(entry);
    console.log("T18_CHECK=" + JSON.stringify({ name, ok: entry.ok }));
    if (!condition) throw Error(`ASSERT FAILED [${phase}] ${name}${detail ? `: ${String(detail).slice(0, 1400)}` : ""}`);
  };
  const maybe = async (enabled, name, body) => { if (enabled) await section(name, body); };
  const section = async (name, body) => {
    stage = name;
    try { await body(); log.sections.push({ name, ok: true }); console.log("T18_SECTION_OK=" + JSON.stringify({ name })); return true; }
    catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      log.sections.push({ name, ok: false, message: message.slice(0, 1600) });
      console.error(`T18_SECTION_FAILED ${name} [stage=${stage}]`, error);
      log.failed.push({ section: name, stage, message: message.slice(0, 1600) });
      return false;
    }
  };
  const writeLog = (fileName = `${phase}-log.json`) => {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, fileName), `${JSON.stringify({ ...log, identity: { ...log.identity, phase, at: new Date().toISOString() } }, null, 2)}\n`);
    console.log("T18_LOG=" + JSON.stringify({ file: fileName, assertions: log.assertions.length, failed: log.failed.length }));
  };

  const { TaskRootIndex } = await import("../dist/main/task-root-index.js");
  const { ProjectRegistry } = await import("../dist/main/project-registry.js");
  const { ServiceCatalog, serviceCatalogAuthority } = await import("../dist/main/service-catalog.js");
  const { createTrustedWindow, loadTrustedViews, PerTaskHostRegistry, registerIpc } = await import("../dist/main/runtime.js");
  const { CreationIntentStore, ProjectTaskCreation } = await import("../dist/main/project-task-creation.js");
  const { performCreationOperation } = await import("../dist/main/project-task-ipc.js");
  const { WorktreeMetadataLock } = await import("../dist/main/worktree-metadata-lock.js");
  const { ProviderProfileStore } = await import("../dist/main/provider-profile-store.js");
  const { ProviderSecretStore, createTestSafeStorage } = await import("../dist/main/provider-secret-store.js");
  const { NativeModelsFile, resolveAgentDir } = await import("../dist/main/native-models-config.js");
  const { NativeMcpFile } = await import("../dist/main/native-mcp-config.js");
  const { McpWiring } = await import("../dist/main/mcp-ipc.js");
  const { ProviderWiring } = await import("../dist/main/provider-ipc.js");
  const { TaskVariableStore, resolveTaskVariables, variableEnvironment } = await import("../dist/main/workspace-variables.js");
  const { HostClient } = await import("../dist/rpc/host-client.js");
  const { readTaskRecordOnDisk } = await import("../dist/host/task-store.js");
  const { buildHostEnv } = await import("../dist/host/host-guards.js");
  const { registerApplicationLifecycle } = await import("../dist/main/application-lifecycle.js");
  const { ScheduleDriver } = await import("../dist/main/schedule-driver.js");
  const { QuitReportStore, SchedulerGate } = await import("../dist/main/schedule-supervision.js");

  const recordOf = (taskId) => {
    const taskDir = join(taskRoot, taskId);
    return { taskDir, record: readTaskRecordOnDisk(taskDir), scheduleFile: join(taskDir, "schedules.json"), lifecycleFile: join(taskDir, "lifecycle.json") };
  };
  const scheduleRecord = (taskId) => readJson(recordOf(taskId).scheduleFile, { runs: [], schedules: [] });
  const lifecycleRecord = (taskId) => readJson(recordOf(taskId).lifecycleFile, null);

  let state = readJson(statePath, {});
  if (phase === "primary") {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    for (const path of [profile, taskRoot, sourcesRoot, remotesRoot, agentDir, outDir, app.getPath("userData")]) mkdirSync(path, { recursive: true });
    providerState.port = await freePort();
    state = { loopbackPort: providerState.port };
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  } else {
    for (const path of [profile, taskRoot, agentDir, outDir, app.getPath("userData")]) if (!existsSync(path)) mkdirSync(path, { recursive: true });
    providerState.port = state.loopbackPort ?? (await freePort());
  }
  providerState.server = await startProvider(providerState.port);
  stage = "whenReady";
  await app.whenReady();

  index = new TaskRootIndex(profile, taskRoot);
  projects = new ProjectRegistry(profile);
  providerProfiles = new ProviderProfileStore(profile);
  secrets = new ProviderSecretStore(profile, createTestSafeStorage());
  taskVariables = new TaskVariableStore(profile);
  const resolvedAgent = resolveAgentDir(process.env, homedir());
  if (resolvedAgent !== agentDir) throw Error(`PIDOCK_AGENT_DIR resolved to ${resolvedAgent}`);
  nativeModels = new NativeModelsFile(resolvedAgent);
  const nativeMcp = new NativeMcpFile(resolvedAgent);

  let projectId = state.projectId ?? "";
  let scheduleTaskId = state.scheduleTaskId ?? "";
  let cleanupTaskId = state.cleanupTaskId ?? "";
  let profileId = state.profileId ?? "";
  let repos = state.repos ?? null;
  let docsDir = state.docsDir ?? "";
  let cleanupWorktree = state.cleanupWorktree ?? "";
  let scheduleId = state.scheduleId ?? "";

  // ---------------------------------------------------------------- seeding (primary only)
  if (phase === "primary") {
    stage = "seed sources";
    const alpha = seedRepo("alpha-service", "# alpha-service\n\nT18 验收：服务端仓库。\n", "base: alpha");
    repos = { alpha };
    docsDir = join(sourcesRoot, "shared-docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, "验收.md"), "# 共享目录\n\nT18 验收：普通目录共享原文件。\n");
    stage = "seed registry";
    const project = await projects.create({
      name: PROJECT_NAME,
      description: "T18 后台调度 / 退出恢复 / 清理（真实验收）",
      repositories: [{ name: alpha.name, path: alpha.dir }],
      directories: [{ name: "shared-docs", path: docsDir }],
      environment: [],
      branchTemplate: BRANCH_TEMPLATE,
    });
    projectId = project.id;
    state = { ...state, projectId, repos, docsDir };
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    check("the workspace is a real registry entry over a real checkout and a real plain directory",
      project.repositories.length === 1 && project.directories.length === 1 && existsSync(join(alpha.dir, "README.md")),
      JSON.stringify({ projectId, repositories: project.repositories.map((row) => row.path) }));
  } else {
    for (const [key, value] of [["projectId", projectId], ["repo", repos?.alpha?.dir]]) {
      if (!value) throw Error(`${phase} phase: missing persisted ${key} under ${statePath}`);
      if (!existsSync(value) && key !== "projectId") throw Error(`${phase} phase: persisted ${key} is gone: ${value}`);
    }
  }

  // ---------------------------------------------------------------- window + production wiring
  stage = "window";
  views = await createTrustedWindow(workspaceId, "production");
  views.window.setContentSize(1440, 900);
  await wait(200);
  registry = new PerTaskHostRegistry(workspaceId, async (workspace, task, variables) => {
    const entry = join(import.meta.dirname, "..", "dist", "host", "host-entry.js");
    const child = utilityProcess.fork(entry, [], {
      serviceName: `${workspaceId}-host`,
      env: { ...buildHostEnv(process.env, workspace, task, profile, undefined, process.platform, variables), PIDOCK_MCP_CONFIG: nativeMcp.path },
      stdio: "pipe",
    });
    children.push(child);
    hostPids.push({ taskId: task?.taskId ?? null, pid: child.pid, at: new Date().toISOString() });
    child.stderr?.on("data", (data) => process.stderr.write(`[${workspaceId}-host ${task?.taskId ?? ""}] ${data}`));
    const client = new HostClient(child);
    const originalTask = client.task.bind(client);
    client.task = async (request, options) => {
      try {
        const answer = await originalTask(request, options);
        hostTransportOps.push({
          at: new Date().toISOString(), taskId: request?.taskId ?? null, op: request?.op ?? null,
          ok: answer?.ok ?? null,
          abortedTurns: Array.isArray(answer?.payload?.abortedTurns) ? [...answer.payload.abortedTurns] : null,
          quitApplied: Array.isArray(answer?.payload?.quit?.applied) ? [...answer.payload.quit.applied] : null,
          error: answer?.ok === false ? String(answer.error) : null,
        });
        return answer;
      } catch (error) {
        hostTransportOps.push({ at: new Date().toISOString(), taskId: request?.taskId ?? null, op: request?.op ?? null, ok: false, error: String(error?.message ?? error) });
        throw error;
      }
    };
    return { child, client };
  }, (id) => index.resolve(id), undefined, index, (taskId2) => {
    const project = projects.get(projectId);
    const resolved = resolveTaskVariables(project?.environment ?? [], taskVariables.list(taskId2));
    return variableEnvironment(resolved.rows);
  });
  const originalRoute = registry.routeTaskOp.bind(registry);
  registry.routeTaskOp = async (input) => {
    try {
      // The seam answers with the Host RPC ENVELOPE (`{workspaceId, taskId, op,
      // payload}`); a refusal throws instead of returning `{ok:false}`.
      const answer = await originalRoute(input);
      log.ops.push({ at: new Date().toISOString(), op: input?.op ?? null, taskId: input?.taskId ?? null, ok: true,
        abortedTurns: answer?.payload?.abortedTurns ?? null,
        runResult: answer?.payload?.run?.result ?? null,
        error: null });
      return answer;
    } catch (error) {
      log.ops.push({ at: new Date().toISOString(), op: input?.op ?? null, taskId: input?.taskId ?? null, ok: false,
        abortedTurns: null, runResult: null, error: String(error?.message ?? error) });
      throw error;
    }
  };
  const sender = () => views.shellView.webContents.id;
  providers = new ProviderWiring(providerProfiles, async (id, provider, senderWebContentsId) => {
    const payload = provider === null ? { provider: null } : { provider: {
      config: providerProfiles.config(provider.profileId, provider.modelId),
      credential: provider.credential, thinkingLevel: provider.thinkingLevel } };
    await registry.routeTaskOp({ workspaceId, taskId: id, op: "task/sdkProvider", payload, origin: { kind: "shell-ui", senderWebContentsId } });
  }, process.env, { secrets, native: nativeModels });
  creation = new ProjectTaskCreation(new CreationIntentStore(profile), projects, index, registry, taskRoot,
    undefined, new WorktreeMetadataLock(profile, { notify: () => {} }));
  const catalog = new ServiceCatalog(profile, serviceCatalogAuthority(index, projects));
  const mcpWiring = new McpWiring(nativeMcp, process.env);
  // [T18] #153 the same supervision wiring `main.ts` uses: one gate owns the
  // quitting/asleep phase, the store makes an unconfirmed quit visible after a
  // restart, and the driver never forks a Host just to read a clock.
  quitReports = new QuitReportStore(app.getPath("userData"));
  gate = new SchedulerGate(quitReports);
  const schedulerState = () => {
    const persisted = gate.view().lastQuitUnconfirmed ?? quitReports.pending() ?? undefined;
    return { ...gate.view(), ...(persisted !== undefined ? { lastQuitUnconfirmed: persisted } : {}) };
  };
  registerIpc(createUnavailableHostClient(), views.registry, registry, projects, index, undefined, creation, providers, catalog,
    undefined, undefined, taskVariables, { state: schedulerState }, mcpWiring);
  await loadTrustedViews(views);
  views.shellView.webContents.debugger.attach();

  if (phase === "primary") {
    stage = "provider save";
    // [#148] the branch convention and push remote are app-private SETTINGS the
    // creation flow reads (never a project field): set them through the same
    // main-side call the delivery sheet uses.
    const delivery = creation.saveDeliverySettings({ branchTemplate: BRANCH_TEMPLATE, remote: "origin" });
    check("the app-private delivery settings carry the branch convention and push remote creation needs",
      delivery.branchTemplate === BRANCH_TEMPLATE && delivery.remote === "origin", JSON.stringify(delivery));
    const saved = providers.save({
      name: "Loopback T18 端点",
      notes: "本机回环 · 无真实线上账号",
      protocol: "openai-completions",
      baseUrl: withPort("/v1"),
      credentials: { kind: "store", revision: 1 },
      models: [{ id: MODEL, name: "Loopback Chat 7B", contextWindow: 131072, maxTokens: 8192, reasoning: false }],
      modelId: MODEL,
    }, API_KEY, false);
    profileId = saved.profile.id;
    state = { ...state, profileId };
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    check("the Provider profile is store-backed with a ciphertext credential and Pi's own models.json carries the managed entry",
      secrets.has(profileId) && !readFileSync(join(profile, "provider-secrets.json"), "utf8").includes(API_KEY) &&
      readFileSync(nativeModels.path, "utf8").includes(MODEL),
      JSON.stringify({ profileId }));
  }

  const ticks = [];
  schedulesDriver = new ScheduleDriver({
    hostTaskIds: () => registry.activeTaskIds(),
    evaluate: async (taskId) => {
      const record = { at: new Date().toISOString(), taskId, blocked: gate.blockedReason() };
      ticks.push(record);
      await registry.routeTaskOp({ taskId, op: "task/scheduleEvaluate" });
    },
    onError: (error, taskId) => console.error(`[t18] schedule evaluation failed for ${taskId}: ${String(error)}`),
    blockedReason: () => gate.blockedReason(),
    // Production main.ts uses DEFAULT_SCHEDULE_TICK_MS (30s). A 1s tick is a
    // harness clock choice so the REAL timer can be observed while the window is
    // closed and while the machine is "asleep"; it changes nothing else.
  }, { intervalMs: 1000 });
  stopHostsBase = async () => {
    const report = await registry.quitAll({ origin: { kind: "shell-ui", senderWebContentsId: sender() }, label: "应用退出" });
    lastQuitReport = report;
    log.identity.quitReport = report;
    console.log("T18_QUIT_REPORT=" + JSON.stringify(report).slice(0, 4000));
    return report.ok === true;
  };
  // The gate owns the quit window exactly as `main.ts` does. A refused quit puts
  // scheduling back AND records the refusal for the next start.
  const gatedStopHosts = async () => {
    gate.beginQuit();
    schedulesDriver.stop();
    const stopped = await stopHostsBase();
    if (stopped) { gate.completeQuit(); quitReports.clear(); }
    else { gate.abortQuit({ at: new Date().toISOString(), hosts: [...new Set((lastQuitReport?.tasks ?? []).filter((task) => !task.ok || task.retainedTasks.length).map((task) => task.taskId))] }); schedulesDriver.start(); }
    console.log("T18_GATED_STOP=" + JSON.stringify({ stopped, phase: gate.view().phase, blockedReason: gate.blockedReason() }));
    return stopped;
  };
  registerApplicationLifecycle({
    app, window: views.window, platform: process.platform, stopHosts: gatedStopHosts,
    unsatisfiedHosts: () => [...new Set((lastQuitReport?.tasks ?? []).filter((task) => !task.ok || task.retainedTasks.length).map((task) => task.taskId))],
    onQuitUnconfirmed: (report) => { gate.abortQuit(report); },
  });
  // The real Electron power events, not a private door: suspend/resume drive the
  // same listeners `main.ts` installs.
  powerMonitor.on("suspend", () => { gate.sleep(new Date().toISOString()); });
  powerMonitor.on("resume", () => {
    const woke = gate.wake(new Date().toISOString());
    if (woke === null) return;
    for (const taskId of registry.activeTaskIds()) {
      void registry.routeTaskOp({ taskId, op: "task/scheduleWake", payload: { at: woke.at } })
        .catch((error) => console.error(`[t18] schedule wake failed for ${taskId}: ${String(error)}`));
    }
  });
  schedulesDriver.start();
  // The production app starts the driver immediately; here the creation flow forks
  // a Host before its task record settles, so the tick is held until creation ends.
  if (phase === "primary") schedulesDriver.stop();

  // ---------------------------------------------------------------- UI helpers
  const evalJs = async (expression) => {
    const response = await Promise.race([
      views.shellView.webContents.debugger.sendCommand("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }),
      new Promise((_, reject) => setTimeout(() => reject(Error(`renderer evaluate timeout (${String(expression).slice(0, 120)})`)), 20000)),
    ]);
    if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  const text = async () => { try { return await evalJs("document.body.innerText"); } catch { return ""; } };
  const until = async (match, label, attempts = 600) => {
    let last = "";
    for (let i = 0; i < attempts; i++) { last = await text(); if (match(last)) return last; await wait(100); }
    throw Error(`UI timeout [${phase}] (${label}): ${JSON.stringify(last.slice(0, 3000))}`);
  };
  const untilMain = async (predicate, label, attempts = 400) => {
    for (let i = 0; i < attempts; i++) { const value = await predicate(); if (value) return value; await wait(100); }
    throw Error(`main-side timeout (${label}) [${phase}]`);
  };
  const click = (name) => evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(name)} || el.getAttribute('aria-label') === ${JSON.stringify(name)}); if (!b) throw Error('missing button '+${JSON.stringify(name)}+' :: '+document.body.innerText.replace(/\\n+/g,' | ').slice(0,1200)); b.click(); return true; })()`);
  const clickLabelled = (needle, scope = "document") => evalJs(`(() => {
    const root = ${scope} ?? document;
    const want = ${JSON.stringify(needle.replace(/\s+/g, ""))};
    const button = [...root.querySelectorAll('button')].find((el) => el.textContent.replace(/\\s+/g, '').includes(want) || el.getAttribute('aria-label') === ${JSON.stringify(needle)});
    if (!button) throw Error('missing button containing ' + ${JSON.stringify(needle)} + ' :: ' + document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 1200));
    button.click();
    return true;
  })()`);
  const route = async (id, op, payload = {}) => {
    const result = await registry.routeTaskOp({ workspaceId, taskId: id, op, payload, origin: { kind: "shell-ui", senderWebContentsId: sender() } });
    if (result?.ok === false) throw Error(`${op} refused: ${String(result.error)}`);
    return result?.payload ?? {};
  };
  const gotoTask = async (id) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (await evalJs(`!!document.querySelector('[data-task-nav="${id}"]')`)) break;
      if (attempt === 399) throw Error(`no task navigation for ${id} :: ${flat(await text()).slice(0, 1500)}`);
      await wait(100);
    }
    await evalJs(`(() => { const b = document.querySelector('[data-task-nav="${id}"]'); if (!b) throw Error('missing task nav'); b.click(); return true; })()`);
    await until((body) => /task workspace/i.test(body) || body.includes("进入活跃对话"), "task view");
    await wait(300);
  };
  /** The shell reads its inventory on mount: a task created through the main-side
   * flow only appears after a reload (the UI path refreshes itself). */
  const reloadShell = async () => {
    await evalJs("(() => { location.reload(); return true; })()");
    await wait(1500);
    await until((body) => body.includes("本机工作区") || body.includes("任务根"), "shell boot after reload", 300);
    await wait(400);
  };
  const enterWorkspace = async () => {
    await click(PROJECT_NAME);
    await until((body) => body.includes(PROJECT_NAME) && (body.includes("工作空间复用来源") || body.includes("工作空间与任务")), "workspace overview");
    await wait(300);
  };
  const openArchivePage = async () => {
    await clickLabelled("已归档");
    await until((body) => /archived tasks/i.test(body), "archive page");
    await wait(400);
  };
  const openSchedulesPage = async () => {
    await clickLabelled("定时任务");
    await until((body) => /scheduled tasks/i.test(body), "schedules page");
    await wait(500);
  };
  /** A preview click is asynchronous: wait until the panel button is idle again. */
  const waitPreviewSettled = async (taskId) => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const settled = await evalJs(`(() => {
        const article = document.querySelector('[data-archived-task=' + ${JSON.stringify(JSON.stringify(taskId))} + ']');
        const button = article ? [...article.querySelectorAll('button')].find((el) => el.textContent.includes('生成清单') || el.textContent.includes('正在生成清单')) : undefined;
        return button !== undefined && button.disabled === false && button.textContent.trim() === '生成清单';
      })()`).catch(() => false);
      if (settled === true) return true;
      await wait(100);
    }
    throw Error(`the cleanup preview never settled [${phase}]`);
  };
  const capture = async (stateName, width = 1440, height = 900) => {
    stage = `t18:${stateName} ${width}x${height}`;
    views.window.setContentSize(width, height);
    await wait(150);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const viewport = await evalJs("({ width: window.innerWidth, height: window.innerHeight })");
      if (viewport.width === width && viewport.height === height) break;
      await wait(80);
    }
    views.shellView.setVisible(true);
    views.window.show();
    app.focus({ steal: true });
    views.window.moveTop();
    views.window.focus();
    await wait(150);
    const bounds = views.window.getContentBounds();
    const name = `${width}x${height}-${stateName}.png`;
    const shot = await views.shellView.webContents.debugger.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const png = Buffer.from(shot.data, "base64");
    writeFileSync(join(outDir, name), png);
    log.shots.push({ state: stateName, file: name, width: bounds.width, height: bounds.height,
      pixelWidth: pngPixelSize(png).width, pixelHeight: pngPixelSize(png).height, sha256: sha256(png),
      bodyText: flat(await text()).slice(0, 1800) });
    console.log("T18_SHOT=" + JSON.stringify({ state: stateName, file: name, sha256: sha256(png) }));
    views.window.setContentSize(1440, 900);
    await wait(120);
  };
  const saveState = (extra = {}) => {
    state = { ...state, ...extra };
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  };

  // ---------------------------------------------------------------- task creation (primary only)
  const createTask = async (input) => {
    /** @type {any} */
    const prepared = await performCreationOperation(creation, { op: "prepare", input }, async () => null, () => undefined);
    if (prepared.canceled) throw Error("creation prepare was canceled");
    const intent = prepared.intent;
    await performCreationOperation(creation, { op: "commit", id: intent.id }, async () => null, () => undefined);
    const record = recordOf(intent.taskId);
    return { intent, record, worktrees: Object.fromEntries(intent.repos.map((repo) => [repo.name, join(record.taskDir, repo.repoDir)])) };
  };

  if (phase === "primary") {
    stage = "create scheduled task";
    const repositoryId = projects.get(projectId).repositories[0].id;
    const scheduled = await createTask({
      projectId, name: SCHEDULE_TASK_NAME,
      repositories: [{ sourceId: repositoryId, remote: "origin", remoteBranch: "main" }],
      directoryIds: [], sharedWriteConfirmed: false, override: false,
      kind: "scheduled",
      schedule: { name: SCHEDULE_NAME, ruleText: "* * * * *", timezone: "Asia/Shanghai",
        prompt: `${SLOW_TAG} T18 定时巡检：报告一次调度状态`, providerId: profileId, model: MODEL, permission: "read", enabled: true },
    });
    scheduleTaskId = scheduled.intent.taskId;
    const list = await route(scheduleTaskId, "task/scheduleList");
    const row = (list?.schedules ?? [])[0];
    if (!row) throw Error(`the Host persisted no schedule for ${scheduleTaskId}`);
    scheduleId = row.scheduleId;
    saveState({ scheduleTaskId, scheduleId, scheduleTaskDir: scheduled.record.taskDir });
    check("the scheduled task is a real task record (kind=scheduled) with a Host-persisted every-minute rule",
      scheduled.record.record?.kind === "scheduled" && row.ruleText === "* * * * *" && row.model === MODEL && row.enabled === true,
      JSON.stringify({ kind: scheduled.record.record?.kind, scheduleId, ruleText: row.ruleText }));
    await providers.select(scheduleTaskId, profileId, MODEL, undefined, sender());

    stage = "create cleanup task";
    const cleanup = await createTask({
      projectId, name: CLEANUP_TASK_NAME,
      repositories: [{ sourceId: repositoryId, remote: "origin", remoteBranch: "main" }],
      directoryIds: [], sharedWriteConfirmed: false, override: false,
    });
    cleanupTaskId = cleanup.intent.taskId;
    cleanupWorktree = cleanup.worktrees["alpha-service"];
    saveState({ cleanupTaskId, cleanupTaskDir: cleanup.record.taskDir, cleanupWorktree, cleanupBranch: cleanup.intent.branch });
    check("the cleanup task owns a real managed worktree on its own task branch (source checkout untouched)",
      existsSync(join(cleanupWorktree, "README.md")) &&
      gitSafe(cleanupWorktree, ["symbolic-ref", "--short", "HEAD"]) === cleanup.intent.branch &&
      gitSafe(repos.alpha.dir, ["symbolic-ref", "--short", "HEAD"]) === "main" &&
      gitSafe(repos.alpha.dir, ["rev-parse", "HEAD"]) === repos.alpha.head,
      JSON.stringify({ worktree: cleanupWorktree, branch: cleanup.intent.branch, sourceHead: gitSafe(repos.alpha.dir, ["rev-parse", "HEAD"]) }));
    writeFileSync(join(cleanupWorktree, "T18-UNCOMMITTED.md"), "T18 未提交的工作：清理必须先拒绝删除\n");
    check("the cleanup worktree carries a real uncommitted change",
      gitSafe(cleanupWorktree, ["status", "--porcelain"]).includes("T18-UNCOMMITTED.md"),
      gitSafe(cleanupWorktree, ["status", "--porcelain"]));
    await providers.select(cleanupTaskId, profileId, MODEL, undefined, sender());
    stage = "reload the shell so its inventory shows the new tasks";
    await reloadShell();
    const nav = await untilMain(async () => {
      const ids = await evalJs("[...document.querySelectorAll('[data-task-nav]')].map((el) => el.getAttribute('data-task-nav'))");
      return Array.isArray(ids) && ids.includes(scheduleTaskId) && ids.includes(cleanupTaskId) ? ids : null;
    }, "both created tasks in the shell inventory", 400);
    check("both created tasks are in the shell's real inventory (not just in main's memory)",
      nav.includes(scheduleTaskId) && nav.includes(cleanupTaskId), JSON.stringify(nav));
    schedulesDriver.start();
  }

  const runsOf = async (taskId) => (await route(taskId, "task/scheduleRuns")).runs ?? [];
  const sessionsOf = async (taskId) => (await route(taskId, "task/sessionList")).sessions ?? [];
  const msToMinuteBoundary = () => 60000 - (Date.now() % 60000);

  // ============================================================ primary: scheduler overlap
  await maybe(phase === "primary" && wanted("overlap"), "scheduler: an overlapping trigger is skipped with a recorded reason and never duplicates a session", async () => {
    if (!scheduleTaskId) throw Error("no scheduled task");
    // The driver tick is stopped for this proof so the OVERLAP (not the periodic
    // tick) is what decides; the Host's own trigger path is untouched.
    schedulesDriver.stop();
    stage = "overlap:wait for a due occurrence";
    await wait(msToMinuteBoundary() + 2000);
    const sessionsBefore = (await sessionsOf(scheduleTaskId)).map((row) => row.id);
    const runsBefore = await runsOf(scheduleTaskId);
    const manual = await route(scheduleTaskId, "task/scheduleRunNow", { scheduleId, label: "立即运行" });
    check("立即运行 started a REAL run that is still in flight (the loopback endpoint holds the response)",
      manual.run?.result === "running" && typeof manual.run?.sessionId === "string",
      JSON.stringify({ result: manual.run?.result, sessionId: manual.run?.sessionId }));
    stage = "overlap:due trigger while a run is live";
    const due = await route(scheduleTaskId, "task/scheduleEvaluate");
    const runsAfterDue = await runsOf(scheduleTaskId);
    const skip = runsAfterDue.find((row) => row.result === "skipped");
    check("the due trigger was skipped and the record names the real reason (previous execution still running)",
      skip !== undefined && String(skip.reason ?? "").includes("上一次执行仍未结束") && skip.sessionId === undefined,
      JSON.stringify(runsAfterDue.map((row) => ({ runId: row.runId, result: row.result, reason: row.reason, sessionId: row.sessionId ?? null }))));
    check("the skipped trigger created NO session (no duplicate execution)",
      (await sessionsOf(scheduleTaskId)).length === sessionsBefore.length + 1,
      JSON.stringify({ before: sessionsBefore, after: (await sessionsOf(scheduleTaskId)).map((row) => row.id) }));
    check("the Host evaluated the due occurrence exactly once (one new run record: the skip)",
      runsAfterDue.length === runsBefore.length + 2,
      JSON.stringify({ before: runsBefore.length, after: runsAfterDue.length, recorded: due.runs?.length ?? null }));
    stage = "overlap:wait for the live run to settle";
    const settled = await untilMain(async () => {
      const rows = await runsOf(scheduleTaskId);
      const row = rows.find((entry) => entry.runId === manual.run.runId);
      return row !== undefined && row.result !== "running" ? row : null;
    }, "the live scheduled run settled", Math.ceil(HOLD_MS / 100) + 300);
    check("the in-flight run settled on its own real result (started while the skip was recorded)",
      ["completed", "failed", "awaiting-approval", "interrupted", "uncertain"].includes(settled.result),
      JSON.stringify(settled).slice(0, 700));
    const countAfterSettle = (await runsOf(scheduleTaskId)).length;
    const sessionsAfterSettle = (await sessionsOf(scheduleTaskId)).length;
    stage = "overlap:the same occurrence never runs twice";
    await route(scheduleTaskId, "task/scheduleEvaluate");
    const countAfterReevaluate = (await runsOf(scheduleTaskId)).length;
    check("re-evaluating after the run settled does NOT start the recorded occurrence again (no duplicate session)",
      countAfterReevaluate === countAfterSettle && (await sessionsOf(scheduleTaskId)).length === sessionsAfterSettle,
      JSON.stringify({ runsBeforeSettle: countAfterSettle, runsAfter: countAfterReevaluate, sessions: sessionsAfterSettle }));
    const persisted = scheduleRecord(scheduleTaskId);
    check("the skip and the settled run are both persisted on disk (schedules.json)",
      persisted.runs?.length === countAfterReevaluate && persisted.runs.some((row) => row.result === "skipped"),
      JSON.stringify(persisted.runs?.map((row) => ({ result: row.result, reason: row.reason }))));
    await gotoTask(scheduleTaskId);
    await openSchedulesPage();
    await capture("t18-01-overlap-skipped");
    schedulesDriver.start();
  });

  // ============================================================ primary: close window, keep scheduling
  await maybe(phase === "primary" && wanted("close"), "lifecycle: closing the window keeps the app and the scheduler running, and reopening preserves the state", async () => {
    stage = "close:open the conversation";
    await gotoTask(scheduleTaskId);
    if (!(await evalJs("!!document.querySelector('[data-testid=desktop-conversation]')"))) {
      await clickLabelled("进入活跃对话");
      await until((body) => body.includes("描述你想做什么") || body.includes("发送"), "conversation composer");
      await wait(400);
    }
    const before = {
      visible: views.window.isVisible(),
      destroyed: views.window.isDestroyed(),
      route: await evalJs("location.href"),
      sessions: (await sessionsOf(scheduleTaskId)).map((row) => row.id),
      bodyMarker: flat(await text()).slice(0, 300),
      ticks: ticks.length,
      driverRunning: schedulesDriver.running,
    };
    check("the window is visible and the driver is running before the close", before.visible === true && before.driverRunning === true, JSON.stringify(before).slice(0, 600));
    stage = "close:window.close()";
    views.window.close();
    await wait(700);
    const closed = {
      visible: views.window.isVisible(),
      destroyed: views.window.isDestroyed(),
      driverRunning: schedulesDriver.running,
      revealable: views.window.isVisible() === false,
    };
    check("closing the window on macOS hides it and DOES NOT destroy it (the app keeps living in the background)",
      closed.destroyed === false && closed.visible === false && closed.driverRunning === true, JSON.stringify(closed));
    stage = "close:scheduler keeps ticking while the window is hidden";
    const ticksAtClose = ticks.length;
    await wait(3200);
    const ticksWhileHidden = ticks.length - ticksAtClose;
    const evaluationsWhileHidden = log.ops.filter((row) => row.op === "task/scheduleEvaluate").length;
    check("the REAL driver timer keeps evaluating while the window is hidden (schedules keep running)",
      ticksWhileHidden >= 2 && evaluationsWhileHidden > 0,
      JSON.stringify({ ticksAtClose, ticksWhileHidden, evaluations: evaluationsWhileHidden, driverRunning: schedulesDriver.running }));
    check("the app did not quit and no Host was stopped by the window close",
      views.window.isDestroyed() === false && registry.activeTaskIds().length > 0,
      JSON.stringify({ activeHosts: registry.activeTaskIds() }));
    stage = "close:reopen via the registered activate handler";
    app.emit("activate");
    await wait(900);
    const reopened = {
      visible: views.window.isVisible(),
      destroyed: views.window.isDestroyed(),
      route: await evalJs("location.href"),
      sessions: (await sessionsOf(scheduleTaskId)).map((row) => row.id),
      bodyMarker: flat(await text()).slice(0, 300),
    };
    check("the registered activate handler shows the SAME window again (no second window, nothing destroyed)",
      reopened.visible === true && reopened.destroyed === false && reopened.route === before.route,
      JSON.stringify({ before: before.route, after: reopened.route, visible: reopened.visible }));
    check("the reopened window still shows the same task state and kept every Host session it had",
      before.sessions.every((id) => reopened.sessions.includes(id)) &&
      reopened.bodyMarker.includes("T18") ,
      JSON.stringify({ sessions: reopened.sessions, body: reopened.bodyMarker }));
    await capture("t18-02-window-reopened");
  });

  // ============================================================ primary: sleep / wake gate
  await maybe(phase === "primary" && wanted("sleep"), "scheduler: suspend blocks every trigger, waking plans forward with no backfill", async () => {
    stage = "sleep:suspend";
    const runsBeforeSleep = (await runsOf(scheduleTaskId)).length;
    const sessionsBeforeSleep = (await sessionsOf(scheduleTaskId)).length;
    let powerPath = "powerMonitor.emit";
    try { powerMonitor.emit("suspend"); } catch (error) { powerPath = `emit-failed: ${String(error?.message ?? error)}`; gate.sleep(new Date().toISOString()); }
    await wait(200);
    const asleep = gate.view();
    check("the suspend event put the real gate to sleep and the refusal names the reason",
      asleep.phase === "asleep" && typeof asleep.blockedReason === "string" && asleep.blockedReason.includes("休眠"),
      JSON.stringify({ powerPath, ...asleep }));
    const tick = await schedulesDriver.tick();
    check("a driver tick while asleep evaluates NOTHING and reports the blocked reason",
      tick.blocked !== undefined && tick.evaluated.length === 0 && String(tick.blocked).includes("休眠"),
      JSON.stringify(tick));
    stage = "sleep:cross a real due occurrence while asleep";
    await wait(msToMinuteBoundary() + 2500);
    const runsWhileAsleep = (await runsOf(scheduleTaskId)).length;
    check("nothing triggered while the machine was asleep (no run row, no session)",
      runsWhileAsleep === runsBeforeSleep && (await sessionsOf(scheduleTaskId)).length === sessionsBeforeSleep,
      JSON.stringify({ before: runsBeforeSleep, after: runsWhileAsleep, sessionsBeforeSleep }));
    stage = "sleep:resume";
    const resumedAt = new Date().toISOString();
    try { powerMonitor.emit("resume"); } catch (error) { console.log("T18_DEBUG_RESUME_EMIT=" + String(error?.message ?? error)); const woke = gate.wake(new Date().toISOString()); if (woke) await route(scheduleTaskId, "task/scheduleWake", { at: woke.at }); }
    await untilMain(async () => gate.view().phase === "active", "the gate returned to active after resume", 100);
    // The wake fan-out is fire-and-forget in the product, so wait for the op to land.
    await untilMain(async () => log.ops.some((row) => row.op === "task/scheduleWake"), "the wake fan-out reached a Host", 100).catch(() => undefined);
    const wakeOps = log.ops.filter((row) => row.op === "task/scheduleWake");
    check("the resume fan-out asked the running Host to plan forward (task/scheduleWake reached the Host)",
      wakeOps.length >= 1 && wakeOps.every((row) => row.ok === true), JSON.stringify(wakeOps));
    const afterWake = (await route(scheduleTaskId, "task/scheduleList")).schedules?.[0];
    check("waking moved the plan FORWARD from the resume instant (nothing backfilled, no skipped row minted)",
      typeof afterWake?.lastEvaluatedAt === "string" && afterWake.lastEvaluatedAt >= resumedAt.slice(0, 16) &&
      (afterWake.nextRunAt === null || afterWake.nextRunAt > afterWake.lastEvaluatedAt) &&
      (await runsOf(scheduleTaskId)).length === runsBeforeSleep,
      JSON.stringify({ resumedAt, lastEvaluatedAt: afterWake?.lastEvaluatedAt, nextRunAt: afterWake?.nextRunAt, runs: (await runsOf(scheduleTaskId)).length }));
    await gotoTask(scheduleTaskId);
    await openSchedulesPage();
    await capture("t18-03-sleep-wake");
  });

  // ============================================================ primary: destructive cleanup #147
  await maybe(phase === "primary" && wanted("cleanup"), "cleanup: uncommitted work blocks a destructive cleanup, an explicit clean removes the worktree, the source survives", async () => {
    if (!cleanupTaskId) throw Error("no cleanup task");
    stage = "cleanup:archive the task";
    // Archive through the same Host operation the archive dialog calls.
    await gotoTask(cleanupTaskId);
    const archiveAnswer = await route(cleanupTaskId, "task/archive", { mode: "archive-only", label: "归档当前任务" });
    log.identity.archiveAnswer = archiveAnswer;
    const archived = await untilMain(async () => { const record = lifecycleRecord(cleanupTaskId); return record?.archived === true ? record : null; }, "archived lifecycle record");
    check("the Host persisted archived=true and archive-only kept the managed worktree on disk",
      archived.archived === true && existsSync(join(cleanupWorktree, "T18-UNCOMMITTED.md")),
      JSON.stringify({ archivedAt: archived.archivedAt, worktree: cleanupWorktree }));
    stage = "cleanup:blocked preview";
    await openArchivePage();
    const archivedRow = await evalJs(`(() => { const el = document.querySelector('[data-archived-task="${cleanupTaskId}"]'); return el ? el.innerText.replace(/\\s+/g, ' ').trim() : null; })()`);
    check("the archived task is listed on the 已归档 page after archiving", typeof archivedRow === "string" && archivedRow.length > 0, String(archivedRow));
    await evalJs(`(() => { const article = document.querySelector('[data-archived-task="${cleanupTaskId}"]'); if (!article) throw Error('missing archived row'); const b = [...article.querySelectorAll('button')].find((el) => el.textContent.includes('清理')); if (!b) throw Error('missing 清理 button'); b.click(); return true; })()`);
    await until((body) => body.includes("生成清单"), "cleanup panel");
    await clickLabelled("生成清单", "document.querySelector('[data-archived-task=\"" + cleanupTaskId + "\"]')");
    await waitPreviewSettled(cleanupTaskId);
    const preview = await untilMain(async () => {
      const body = await text();
      return body.includes("逐仓库检查（真实 Git 状态）") && body.includes("有未提交修改") ? body : null;
    }, "cleanup preview with the real git state", 600);
    check("the preview reads the REAL git state of the worktree and names the uncommitted/undelivered work",
      flat(preview).includes("有未提交修改") && flat(preview).includes("未交付"), flat(preview).slice(0, 1200));
    await capture("t18-04-cleanup-blocked");
    stage = "cleanup:the destructive confirmation is an in-app dialog";
    // Instrument the native modal: the previous round's harness froze here because
    // `window.confirm` blocks the renderer. It must never be reached again.
    await evalJs("(() => { window.__nativeConfirms = 0; const original = window.confirm; window.confirm = (...args) => { window.__nativeConfirms += 1; return original.apply(window, args); }; return true; })()");
    await clickLabelled("确认清理", "document.querySelector('[data-archived-task=\"" + cleanupTaskId + "\"]')");
    const dialogText = await untilMain(async () => {
      const value = await evalJs("document.querySelector('[data-testid=archive-cleanup-confirm]')?.innerText ?? null");
      return value !== null ? value : null;
    }, "in-app cleanup dialog", 100);
    check("确认清理 opens an IN-APP dialog that states the Host preview instead of a blocking native modal",
      flat(dialogText).includes("清理不可自动恢复") && flat(dialogText).includes("Host 预览将删除"),
      flat(dialogText).slice(0, 900));
    await capture("t18-05-cleanup-confirm-dialog", 1440, 900);
    await capture("t18-05-cleanup-confirm-dialog", 720, 560);
    stage = "cleanup:refused while the worktree is dirty";
    await clickLabelled("执行清理", "document.querySelector('[data-testid=archive-cleanup-confirm]')");
    const refusal = await untilMain(async () => {
      const body = await text();
      return /cleanup-repo-blocked|清理未完成/.test(body) ? body : null;
    }, "cleanup refusal", 400);
    const nativeConfirms = await evalJs("window.__nativeConfirms ?? -1");
    check("the renderer never reached the native modal during the whole destructive flow",
      nativeConfirms === 0, JSON.stringify({ nativeConfirms }));
    check("the destructive cleanup is REFUSED by name while the worktree has uncommitted work",
      /cleanup-repo-blocked|未提交/.test(flat(refusal)), flat(refusal).slice(0, 1200));
    const refusedState = {
      worktreeExists: existsSync(join(cleanupWorktree, "T18-UNCOMMITTED.md")),
      sourceHead: gitSafe(repos.alpha.dir, ["rev-parse", "HEAD"]),
      sourceBranch: gitSafe(repos.alpha.dir, ["symbolic-ref", "--short", "HEAD"]),
      lifecycle: lifecycleRecord(cleanupTaskId),
    };
    check("the refused cleanup removed NOTHING: the dirty worktree and the source checkout are untouched",
      refusedState.worktreeExists === true && refusedState.sourceHead === repos.alpha.head &&
      refusedState.sourceBranch === "main" && refusedState.lifecycle?.cleanup === null,
      JSON.stringify({ ...refusedState, lifecycle: { cleanup: refusedState.lifecycle?.cleanup, recovery: refusedState.lifecycle?.recovery?.length } }));
    stage = "cleanup:commit and deliver the worktree for real";
    writeFileSync(join(cleanupWorktree, "T18-DELIVERED.md"), "T18 已交付的工作\n");
    git(cleanupWorktree, ["add", "-A"]);
    execFileSync("git", ["-c", "user.email=evidence@pidock.local", "-c", "user.name=PiDock Evidence", "commit", "-m", "T18 归档前提交"], { cwd: cleanupWorktree, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const branch = git(cleanupWorktree, ["symbolic-ref", "--short", "HEAD"]);
    git(cleanupWorktree, ["push", "-u", "origin", `HEAD:refs/heads/${branch}`]);
    git(cleanupWorktree, ["fetch", "origin"]);
    const delivery = {
      dirty: gitSafe(cleanupWorktree, ["status", "--porcelain"]).trim(),
      ahead: gitSafe(cleanupWorktree, ["rev-list", "--count", "HEAD", "--not", "--remotes"]).trim(),
      remoteHead: gitSafe(repos.alpha.remote, ["rev-parse", `refs/heads/${branch}`]),
      localHead: git(cleanupWorktree, ["rev-parse", "HEAD"]),
    };
    check("the worktree is now really committed and really pushed (clean status, nothing ahead of the remotes)",
      delivery.dirty === "" && delivery.ahead === "0" && delivery.remoteHead === delivery.localHead,
      JSON.stringify(delivery));
    stage = "cleanup:explicit clean scope";
    await clickLabelled("生成清单", "document.querySelector('[data-archived-task=\"" + cleanupTaskId + "\"]')");
    await waitPreviewSettled(cleanupTaskId);
    await untilMain(async () => {
      const body = await text();
      return body.includes("无未提交修改") && body.includes("已交付") ? body : null;
    }, "clean preview after delivery", 400);
    await evalJs(`(() => { const article = document.querySelector('[data-archived-task="${cleanupTaskId}"]'); if (!article) throw Error('missing archived row'); const label = [...article.querySelectorAll('label')].find((el) => el.textContent.replace(/\\s+/g, '') === '清理'); if (!label) throw Error('missing 清理 scope label'); const input = label.querySelector('input'); if (!input) throw Error('missing 清理 scope radio'); input.click(); return true; })()`);
    await clickLabelled("生成清单", "document.querySelector('[data-archived-task=\"" + cleanupTaskId + "\"]')");
    await waitPreviewSettled(cleanupTaskId);
    await untilMain(async () => {
      const body = await text();
      return body.includes("可清理（仍需身份核验）") ? body : null;
    }, "clean scope preview", 400);
    await clickLabelled("确认清理", "document.querySelector('[data-archived-task=\"" + cleanupTaskId + "\"]')");
    console.log("T18_DEBUG_CLEAN_SCOPE=" + JSON.stringify(await evalJs(`(() => {
      const article = document.querySelector('[data-archived-task="${cleanupTaskId}"]');
      const buttons = article ? [...article.querySelectorAll('button')].map((el) => ({ text: el.textContent.trim(), disabled: el.disabled })) : [];
      return { buttons, dialog: !!document.querySelector('[data-testid=archive-cleanup-confirm]'), tail: document.body.innerText.slice(-700) };
    })()`)));
    await untilMain(async () => evalJs("!!document.querySelector('[data-testid=archive-cleanup-confirm]')"), "in-app cleanup dialog (clean scope)", 100);
    await clickLabelled("执行清理", "document.querySelector('[data-testid=archive-cleanup-confirm]')");
    const receiptText = await untilMain(async () => {
      const body = await text();
      return /清理已执行|清理部分失败|清理未完成/.test(body) ? body : null;
    }, "cleanup receipt", 600);
    const lifecycleAfter = lifecycleRecord(cleanupTaskId);
    const worktreeGone = !existsSync(cleanupWorktree);
    const sourceIntact = existsSync(join(repos.alpha.dir, "README.md")) &&
      gitSafe(repos.alpha.dir, ["rev-parse", "HEAD"]) === repos.alpha.head &&
      gitSafe(repos.alpha.dir, ["symbolic-ref", "--short", "HEAD"]) === "main" &&
      gitSafe(repos.alpha.dir, ["status", "--porcelain"]).trim() === "";
    const registeredWorktrees = gitSafe(repos.alpha.dir, ["worktree", "list", "--porcelain"]);
    const remoteIntact = gitSafe(repos.alpha.remote, ["rev-parse", "refs/heads/main"]) === repos.alpha.head &&
      gitSafe(repos.alpha.remote, ["rev-parse", `refs/heads/${branch}`]) === delivery.localHead;
    log.cleanup = {
      worktree: cleanupWorktree, worktreeGone, sourceIntact, remoteIntact,
      registeredWorktrees: registeredWorktrees.split("\n").filter((line) => line.startsWith("worktree ")),
      lifecycle: { cleanup: lifecycleAfter?.cleanup, projectReleased: lifecycleAfter?.projectReleased, recovery: lifecycleAfter?.recovery },
      receiptText: flat(receiptText).slice(0, 1200),
    };
    check("the destructive cleanup really removed the managed worktree from disk", worktreeGone === true, JSON.stringify({ worktree: cleanupWorktree }));
    check("git no longer registers that worktree in the source repository",
      !registeredWorktrees.includes(cleanupWorktree), registeredWorktrees.slice(0, 600));
    check("the SOURCE checkout and the bare origin are intact (same HEAD, still on main, clean, both branches present)",
      sourceIntact === true && remoteIntact === true,
      JSON.stringify({ sourceIntact, remoteIntact, sourceHead: gitSafe(repos.alpha.dir, ["rev-parse", "HEAD"]), remoteMain: gitSafe(repos.alpha.remote, ["rev-parse", "refs/heads/main"]) }));
    check("the lifecycle record now carries a cleanup receipt with no partial failure and releases the project",
      lifecycleAfter?.cleanup !== null && lifecycleAfter?.cleanup?.partialFailure === false &&
      lifecycleAfter?.projectReleased === true, JSON.stringify(lifecycleAfter?.cleanup));
    check("the UI receipt states the cleanup ran and names what was removed",
      /清理已执行/.test(flat(receiptText)) && flat(receiptText).includes("实际移除"),
      flat(receiptText).slice(0, 900));
    stage = "cleanup:restore is NOT ready";
    const statePayload = await route(cleanupTaskId, "task/lifecycleState");
    const restore = statePayload?.lifecycle?.restore;
    check("the Host's restore readiness says the cleaned task is NOT ready and names the missing worktree",
      restore?.ready === false && restore?.cleaned === true &&
      (restore?.rows ?? []).every((row) => row.state !== "ready") &&
      (restore?.rows ?? []).some((row) => String(row.reason).includes("已清理")),
      JSON.stringify(restore).slice(0, 900));
    // The page re-reads the lifecycle after the cleanup; poll the row's own
    // restore-readiness element (no synthetic value).
    const readinessText = await untilMain(async () => {
      const value = await evalJs(`document.querySelector('[data-testid=restore-readiness-${cleanupTaskId}]')?.innerText ?? null`).catch(() => null);
      return value !== null && /已清理/.test(value) ? value : null;
    }, "restore readiness element on the archived row", 200).catch(async (error) => {
      console.log("T18_DEBUG_READINESS=" + JSON.stringify(await evalJs(`(() => ({
        row: !!document.querySelector('[data-archived-task="${cleanupTaskId}"]'),
        readiness: document.querySelector('[data-testid=restore-readiness-${cleanupTaskId}]')?.innerText ?? null,
        tail: document.body.innerText.slice(-900),
      }))()`)));
      throw error;
    });
    check("the archived row renders the restore-readiness element saying the workspace is not ready",
      flat(readinessText).includes("该任务已清理") && flat(readinessText).includes("恢复不等于工作区就绪"),
      flat(readinessText).slice(0, 800));
    await capture("t18-06-cleanup-done");
    saveState({ cleanupRemoved: true, cleanupRunAt: lifecycleAfter?.cleanup?.ranAt ?? null });
  });

  // ============================================================ primary tail
  if (phase === "primary") {
    log.identity = { ...log.identity, store: state, providerHolds: providerState.holds, chatRequests: chatRequests().length,
      taskDirs: { schedule: recordOf(scheduleTaskId).taskDir, cleanup: recordOf(cleanupTaskId).taskDir },
      ticks: ticks.length };
    saveState({ primaryDone: true, primaryAt: new Date().toISOString() });
    writeLog("primary-log.json");
    exitNow(log.failed.length === 0 ? 0 : 1, `primary done (failed sections: ${log.failed.length})`);
    return;
  }

  // ============================================================ kill phase
  if (phase === "kill") {
    await section("kill: SIGKILL the whole process tree while a scheduled run is in flight", async () => {
      stage = "kill:start a real run";
      // The Provider binding is per-Host-process state (not persisted), so a fresh
      // process must select it before a run can really start.
      await providers.select(scheduleTaskId, profileId, MODEL, undefined, sender());
      await route(scheduleTaskId, "task/setPermission", { sessionId: "main", permission: "read" }).catch(() => undefined);
      const before = await runsOf(scheduleTaskId);
      const manual = await route(scheduleTaskId, "task/scheduleRunNow", { scheduleId, label: "立即运行" });
      const persisted = await untilMain(async () => {
        const row = scheduleRecord(scheduleTaskId).runs.find((entry) => entry.runId === manual.run?.runId);
        return row !== undefined && row.result === "running" && typeof row.sessionId === "string" ? row : null;
      }, "the run record persisted as running with its session bound", 200);
      const sessions = await sessionsOf(scheduleTaskId);
      check("a real scheduled run is `running` on disk with a bound session BEFORE the crash",
        persisted.result === "running" && sessions.some((row) => row.id === persisted.sessionId),
        JSON.stringify({ runId: persisted.runId, sessionId: persisted.sessionId, occurrenceKey: persisted.occurrenceKey }));
      saveState({
        killedRunId: persisted.runId,
        killedOccurrenceKey: persisted.occurrenceKey,
        killedSessionId: persisted.sessionId,
        killedRunCount: scheduleRecord(scheduleTaskId).runs.length,
        killedAt: new Date().toISOString(),
        beforeKillRunIds: before.map((row) => row.runId),
      });
      await capture("t18-07-run-in-flight");
      stage = "kill:SIGKILL the tree";
      const descendants = descendantPids(process.pid);
      log.identity.kill = { main: process.pid, descendants, at: new Date().toISOString() };
      check("the app tree really has child processes (Host + SDK worker) to kill mid-trigger", descendants.length >= 1, JSON.stringify(descendants));
      writeLog("kill-log.json");
      await wait(200);
      // Deepest first, then this process: nothing gets a chance to chdir/hide.
      for (const pid of [...descendants].reverse()) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
      try { process.kill(process.pid, "SIGKILL"); } catch { /* ignore */ }
      await wait(4000);
      throw Error("SIGKILL did not terminate the capture process");
    });
    exitNow(1, "kill phase did not kill itself");
    return;
  }

  // ============================================================ restart phase (cold read)
  if (phase === "restart") {
    // Stop the periodic driver for this phase so reconciliation is what is
    // measured; the product's own tick is exercised in the primary phase.
    schedulesDriver.stop();
    await section("restart: the crashed run reconciles to interrupted/uncertain (never completed) and the archive reads cold", async () => {
      const onDiskBefore = scheduleRecord(scheduleTaskId);
      const runningBefore = onDiskBefore.runs.filter((row) => row.result === "running");
      check("before any Host is forked, the disk still says the crashed run is `running`",
        runningBefore.length === 1 && runningBefore[0].runId === state.killedRunId,
        JSON.stringify(runningBefore.map((row) => ({ runId: row.runId, result: row.result }))));
      const chatBefore = chatRequests().length;
      stage = "restart:fork a fresh Host and read the run history";
      const runs = await runsOf(scheduleTaskId);
      const recovered = runs.find((row) => row.runId === state.killedRunId);
      const onDiskAfter = scheduleRecord(scheduleTaskId).runs.find((row) => row.runId === state.killedRunId);
      check("the fresh process reconciled the crashed run to interrupted/uncertain — NEVER completed",
        recovered !== undefined && ["interrupted", "uncertain"].includes(recovered.result),
        JSON.stringify({ runId: state.killedRunId, result: recovered?.result, failureCode: recovered?.failureCode, reason: recovered?.reason }));
      check("the reconciliation names a failure code and a reason (no bare state)",
        typeof recovered?.failureCode === "string" && typeof recovered?.reason === "string" && recovered.reason.length > 0,
        JSON.stringify({ failureCode: recovered?.failureCode, reason: recovered?.reason }));
      check("the reconciled record was persisted (schedules.json no longer says running)",
        onDiskAfter !== undefined && ["interrupted", "uncertain"].includes(onDiskAfter.result) && typeof onDiskAfter.endedAt === "string",
        JSON.stringify({ result: onDiskAfter?.result, endedAt: onDiskAfter?.endedAt }));
      check("no run record was created, lost or turned into a success by the restart",
        scheduleRecord(scheduleTaskId).runs.length === state.killedRunCount &&
        scheduleRecord(scheduleTaskId).runs.filter((row) => row.result === "completed").every((row) => row.runId !== state.killedRunId),
        JSON.stringify({ before: state.killedRunCount, after: scheduleRecord(scheduleTaskId).runs.length }));
      stage = "restart:the killed occurrence never runs twice";
      await route(scheduleTaskId, "task/scheduleEvaluate");
      const sameOccurrence = scheduleRecord(scheduleTaskId).runs.filter((row) => row.occurrenceKey === state.killedOccurrenceKey);
      check("the killed occurrence key is preserved exactly once — a restart cannot trigger it again",
        sameOccurrence.length === 1 && sameOccurrence[0].runId === state.killedRunId,
        JSON.stringify(sameOccurrence.map((row) => ({ runId: row.runId, result: row.result }))));
      check("the cold start replayed no model request (nothing re-ran on boot)",
        chatRequests().length === chatBefore, JSON.stringify({ before: chatBefore, after: chatRequests().length }));
      stage = "restart:archived task row (cold read)";
      await until((body) => body.includes(PROJECT_NAME) || body.includes("未归属任务"), "shell boot after restart", 400);
      await enterWorkspace().catch(() => undefined);
      await openArchivePage();
      const row = await untilMain(async () => {
        const value = await evalJs(`(() => { const el = document.querySelector('[data-archived-task="${cleanupTaskId}"]'); return el ? el.innerText.replace(/\\s+/g, ' ').trim() : null; })()`);
        return typeof value === "string" && value.length > 0 ? value : null;
      }, "the archived task row after a cold start", 400);
      check("the archived task row is readable after a COLD start (no in-memory carry-over)",
        flat(row).includes(CLEANUP_TASK_NAME) && flat(row).includes("归档于"),
        flat(row).slice(0, 500));
      const readiness = await untilMain(async () => {
        const value = await evalJs(`document.querySelector('[data-testid=restore-readiness-${cleanupTaskId}]')?.innerText ?? null`);
        return typeof value === "string" && value.length > 0 ? value : null;
      }, "the restore-readiness element after a cold start", 200);
      check("the restore-readiness element is present after the cold start and still reports the cleaned workspace as not ready",
        flat(readiness).includes("该任务已清理") && !flat(readiness).includes("身份仍然匹配"),
        flat(readiness).slice(0, 700));
      const lifecycleCold = (await route(cleanupTaskId, "task/lifecycleState"))?.lifecycle;
      check("the cold Host reads the same archived + cleaned lifecycle facts from disk",
        lifecycleCold?.archived === true && lifecycleCold?.cleaned === true && lifecycleCold?.restore?.ready === false,
        JSON.stringify({ archived: lifecycleCold?.archived, cleaned: lifecycleCold?.cleaned, ready: lifecycleCold?.restore?.ready }));
      await capture("t18-08-archive-cold-start");
      stage = "restart:run history surface";
      await gotoTask(scheduleTaskId);
      await openSchedulesPage();
      const historyBody = flat(await text());
      check("the 定时任务 page shows the interrupted run with its own label (已中断 / 状态不确定)",
        historyBody.includes("已中断") || historyBody.includes("状态不确定"), historyBody.slice(0, 1200));
      check("no unconfirmed-quit banner appears when no quit was refused",
        !historyBody.includes("上次退出未确认"), historyBody.slice(0, 600));
      await capture("t18-09-run-interrupted");
      log.identity.restart = { chatRequestsDuringColdStart: chatRequests().length - chatBefore, recordedRuns: scheduleRecord(scheduleTaskId).runs.length };
    });
    writeLog("restart-log.json");
    exitNow(log.failed.length === 0 ? 0 : 1, `restart done (failed sections: ${log.failed.length})`);
    return;
  }

  // ============================================================ quitok phase
  if (phase === "quitok") {
    schedulesDriver.stop();
    await section("quit: an explicit quit aborts the live turn and the quit report proves every Host stopped", async () => {
      await route(scheduleTaskId, "task/scheduleList");
      await providers.select(scheduleTaskId, profileId, MODEL, undefined, sender());
      await route(scheduleTaskId, "task/setPermission", { sessionId: "main", permission: "read" }).catch(() => undefined);
      stage = "quit:start a live turn";
      const requestId = `req-quitok-${Date.now()}`;
      await route(scheduleTaskId, "task/sendMessage", { sessionId: "main", requestId, text: `${SLOW_TAG} T18 退出中止验收` });
      const live = await untilMain(async () => {
        const answer = await route(scheduleTaskId, "task/executionState", { sessionId: "main" }).catch(() => null);
        return answer?.state?.session?.runState === "running" ? answer : null;
      }, "the SDK turn is live before the quit", 300);
      check("a real SDK turn is in flight before the explicit quit", live !== null, JSON.stringify(live?.state?.session?.runState));
      check("the loopback endpoint is holding that turn open (a real HTTP/SSE request is pending)",
        providerState.holds >= 1, JSON.stringify({ holds: providerState.holds }));
      saveState({ quitokLiveAt: new Date().toISOString(), quitokSessionId: "main" });
      app.on("will-quit", () => {
        try {
          const report = lastQuitReport;
          const quitOps = hostTransportOps.filter((row) => row.op === "task/quit");
          const aborted = quitOps.flatMap((row) => row.abortedTurns ?? []);
          log.identity.quitReport = report;
          log.identity.hostQuitOps = quitOps;
          check("the quit report proves every Host stopped (report.ok true, no retained task)",
            report?.ok === true && (report?.tasks ?? []).every((task) => task.ok === true && task.retainedTasks.length === 0),
            JSON.stringify(report).slice(0, 1200));
          check("the Host's own task/quit receipt aborted the live SDK turn (abortedTurns names the session)",
            aborted.length >= 1 && aborted.includes("main"), JSON.stringify(aborted));
          check("a quit that confirmed every Host leaves NO unconfirmed-quit report behind",
            quitReports.pending() === null, JSON.stringify(quitReports.pending()));
        } catch (error) {
          log.failed.push({ section: "quitok verification", message: String(error) });
          log.assertions.push({ name: "quitok verification", ok: false, detail: String(error).slice(0, 900) });
        }
        writeLog("quitok-log.json");
      });
      stage = "quit:app.quit()";
      console.log("T18_DEBUG_QUITOK=" + JSON.stringify({ holds: providerState.holds, runState: live?.state?.session?.runState }));
      app.quit();
      await wait(25000);
      exitNow(1, "app.quit() did not terminate the process");
    });
    exitNow(1, "quitok phase did not quit");
    return;
  }

  // ============================================================ failedquit phase
  if (phase === "failedquit") {
    schedulesDriver.stop();
    await section("quit: a quit that cannot stop a Host is refused, the app survives and the refusal is persisted", async () => {
      stage = "failedquit:the previous clean quit cleared the report";
      check("the previous quit that stopped every Host left no unconfirmed-quit report",
        quitReports.pending() === null, JSON.stringify(quitReports.pending()));
      await route(scheduleTaskId, "task/scheduleList");
      const abortedState = await route(scheduleTaskId, "task/executionState", { sessionId: "main" }).catch(() => ({}));
      check("the turn the previous quit aborted is NOT running in this new process",
        abortedState?.state?.session?.runState !== "running", JSON.stringify(abortedState?.state?.session?.runState));
      await gotoTask(scheduleTaskId);
      await openSchedulesPage();
      const bannerBefore = await evalJs("!!document.querySelector('[data-testid=desktop-scheduler-quit-unconfirmed]')");
      check("no unconfirmed-quit banner is shown after a quit that proved every Host stopped",
        bannerBefore === false, String(bannerBefore));
      stage = "failedquit:make the next quit impossible";
      const host = hostPids.filter((row) => row.taskId === scheduleTaskId).at(-1);
      check("the task Host process is known before it is killed", host !== undefined && typeof host.pid === "number", JSON.stringify(hostPids));
      process.kill(host.pid, "SIGKILL");
      await wait(800);
      stage = "failedquit:app.quit() must be refused";
      const exitBefore = app.isReady();
      app.quit();
      await wait(6000);
      const pending = quitReports.pending();
      const stateAfter = gate.view();
      log.identity.failedQuit = { pending, phase: stateAfter.phase, driverRunning: schedulesDriver.running, quitReport: lastQuitReport };
      check("the app is STILL RUNNING after the refused quit (no fabricated clean exit)", exitBefore === true && app.isReady() === true, JSON.stringify({ ready: app.isReady() }));
      check("the refusal was persisted for the next start (quit-unconfirmed.json names the Host that did not stop)",
        pending !== null && Array.isArray(pending.hosts) && pending.hosts.includes(scheduleTaskId) && typeof pending.at === "string",
        JSON.stringify(pending));
      check("the scheduler went back to active and restarted after the refused quit",
        stateAfter.phase === "active" && schedulesDriver.running === true && stateAfter.blockedReason === null,
        JSON.stringify({ phase: stateAfter.phase, driverRunning: schedulesDriver.running }));
      check("the quit report itself names the failure instead of claiming success",
        lastQuitReport?.ok === false && (lastQuitReport?.tasks ?? []).some((task) => task.ok === false || task.retainedTasks.length > 0),
        JSON.stringify(lastQuitReport).slice(0, 1200));
      stage = "failedquit:the banner appears on the live page";
      await clickLabelled("刷新", "document.querySelector('[data-testid=desktop-schedules-page]')").catch(() => undefined);
      const banner = await untilMain(async () => {
        const value = await evalJs("document.querySelector('[data-testid=desktop-scheduler-quit-unconfirmed]')?.innerText ?? null");
        return typeof value === "string" && value.length > 0 ? value : null;
      }, "the unconfirmed-quit banner", 200);
      check("the 定时任务 page shows 上次退出未确认 naming the Host that did not stop",
        flat(banner).includes("上次退出未确认") && flat(banner).includes(scheduleTaskId), flat(banner).slice(0, 600));
      await capture("t18-10-quit-unconfirmed");
      await capture("t18-10-quit-unconfirmed", 720, 560);
    });
    writeLog("failedquit-log.json");
    exitNow(log.failed.length === 0 ? 0 : 1, `failedquit done (failed sections: ${log.failed.length})`);
    return;
  }

  // ============================================================ restart2 phase
  if (phase === "restart2") {
    schedulesDriver.stop();
    await section("restart: the persisted unconfirmed quit is visible after a cold start", async () => {
      const pending = quitReports.pending();
      check("the unconfirmed-quit report survived the process (read from main's userData on boot)",
        pending !== null && pending.hosts.includes(scheduleTaskId),
        JSON.stringify(pending));
      await until((body) => body.includes(PROJECT_NAME) || body.includes("未归属任务"), "shell boot after the second restart", 400);
      const payload = await evalJs("window.pidock?.schedulerState ? 'bridge-present' : 'no-bridge'").catch(() => "no-bridge");
      log.identity.schedulerBridge = payload;
      await gotoTask(scheduleTaskId);
      await openSchedulesPage();
      const banner = await untilMain(async () => {
        const value = await evalJs("document.querySelector('[data-testid=desktop-scheduler-quit-unconfirmed]')?.innerText ?? null");
        return typeof value === "string" && value.length > 0 ? value : null;
      }, "the unconfirmed-quit banner after a cold start", 300);
      check("the cold start shows 上次退出未确认 with the persisted timestamp and the Host it names",
        flat(banner).includes("上次退出未确认") && flat(banner).includes(String(pending.at).slice(0, 10)) && flat(banner).includes(scheduleTaskId),
        flat(banner).slice(0, 700));
      const chatBefore = chatRequests().length;
      await wait(1500);
      check("the cold start replayed no model request for the interrupted task",
        chatRequests().length === chatBefore, JSON.stringify({ before: chatBefore, after: chatRequests().length }));
      const runs = await runsOf(scheduleTaskId);
      check("no run is left in a fabricated `running` state after the second cold start",
        runs.every((row) => row.result !== "running"), JSON.stringify(runs.map((row) => ({ runId: row.runId, result: row.result }))));
      await capture("t18-11-quit-unconfirmed-cold-start");
      stage = "restart2:archive cold read again";
      await enterWorkspace().catch(() => undefined);
      await openArchivePage();
      const row = await evalJs(`(() => { const el = document.querySelector('[data-archived-task="${cleanupTaskId}"]'); return el ? el.innerText.replace(/\\s+/g, ' ').trim() : null; })()`);
      check("the archived (cleaned) task row is still readable on a second cold start",
        typeof row === "string" && row.length > 0 && flat(row).includes(CLEANUP_TASK_NAME), String(row).slice(0, 400));
      await capture("t18-12-archive-cold-start-again");
    });
    writeLog("restart2-log.json");
    exitNow(log.failed.length === 0 ? 0 : 1, `restart2 done (failed sections: ${log.failed.length})`);
    return;
  }

  exitNow(1, `unknown phase ${phase}`);
}

void run().catch((error) => {
  console.error("T18_CAPTURE_FAILED", error);
  exitNow(1, `fatal ${String(error?.stack ?? error)}`);
});
