// [PiDock pencil-v1] (#148 / #152 / #153) T13+T17+T18 real-Electron evidence.
//
// T13 分支规范、推送目标与明确 Git 交付: per-repo creation preview (branch + push target)
// that matches the branch the real creation made, the delivery sheet's explicit
// commit/push with repo/branch/range, a REAL push into a local bare origin, the
// no-changes state, a named auth failure and a pre-receive rejection, a partial
// multi-repo outcome recorded per repo, PR guidance that never claims a PR was
// created, no push on task completion, and a failed push leaving uncommitted work.
//
// T17 定时任务真实触发与专属创建: a dedicated scheduled task created from S02, the saved
// rule/timezone/model/permission, S04 edit / disable / enable / run-now, a run-now
// that really starts a NEW SDK turn in a new session of the SAME task workspace,
// the run record's actual model/session/status, opening that session to continue,
// and the named failure when the Provider/credential is missing.
//
// T18 后台调度、冲突跳过与退出恢复: closing the window keeps the app/schedules alive and
// reopening preserves state, an overlapping trigger is skipped with a recorded
// reason and no second session, an explicit quit aborts the in-flight turn and
// recycles the owned Host processes, a killed app reconciles to interrupted /
// uncertain (never success) on the next start without duplicating the run, sleep/
// wake never backfills, and an unconfirmed quit is visible on the next launch.
//
// Run after `pnpm --filter @pidock/shell build`:
//   pnpm --filter @pidock/shell exec electron \
//     scripts/electron-pencil-v1-t13-t17-t18-capture.mjs --phase primary
//   ... --phase t18     (same temp root; close / overlap / sleep-wake / quit)
//   ... --phase kill    (child: trigger a run, then SIGKILLed by the harness)
//   ... --phase restart (child: reconciles the killed run, shows the quit report)
//
// Boot path is the #136/#137/#142/#138 harness one: the compiled production runtime
// modules are imported directly (NOT dist/main/main.js) with the production wiring
// decisions — createTrustedWindow(..., "production"), registerIpc over a real
// TaskRootIndex / ProjectRegistry / PerTaskHostRegistry / ProjectTaskCreation /
// ProviderWiring, the real ScheduleDriver / SchedulerGate / QuitReportStore /
// registerApplicationLifecycle — and the built React renderer over file://.
//
// Deliberately NOT real, and named in every README:
// - the credential cipher: createTestSafeStorage() (deterministic AES-256-GCM)
//   instead of the OS keychain;
// - the Provider endpoint: a loopback OpenAI-compatible server on 127.0.0.1
//   (there is no real online provider account here);
// - PIDOCK_AGENT_DIR points at a temp dir, so Pi's models.json is never the real one;
// - the git remotes are REAL bare repositories (and a real HTTP endpoint that answers
//   401 for the auth leg) under the OS temp dir — not github.com;
// - writing is confined to temp dirs; `.pen` and the real ~/.pi/agent are untouched.
import { app, powerMonitor, utilityProcess } from "electron";
import { createUnavailableHostClient } from "./unavailable-host-client.mjs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { shutdownTestRegistry } from "./shutdown-test-registry.mjs";

// The dev-server override is inadmissible evidence: clear it before boot.
delete process.env["PIDOCK_RENDERER_URL"];
delete process.env["PIDOCK_TASK_URL"];

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const argValue = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const phase = argValue("--phase") ?? "primary";
const outBase = resolve(repoRoot, argValue("--out") ?? "docs/evidence");
const dirs = {
  t13: join(outBase, "pencil-v1-t13"),
  t17: join(outBase, "pencil-v1-t17"),
  t18: join(outBase, "pencil-v1-t18"),
};
const command = `pnpm --filter @pidock/shell exec electron scripts/electron-pencil-v1-t13-t17-t18-capture.mjs --phase ${phase}`;
// A fixed temp root (not random) keeps captured paths stable across phases.
const root = join(tmpdir(), "pidock-pencil-v1-t131718-capture");
const profile = join(root, "profile");
const taskRoot = join(root, "tasks");
const sourcesRoot = join(root, "sources");
const remotesRoot = join(root, "remotes");
const agentDir = join(root, "agent");
const statePath = join(root, "state.json");
app.setPath("userData", phase === "primary" ? join(root, "chromium") : join(root, `chromium-${phase}`));
const realAgentDir = join(homedir(), ".pi", "agent");
if (resolve(agentDir) === resolve(realAgentDir)) throw Error("refusing to use the real ~/.pi/agent");
process.env["PIDOCK_AGENT_DIR"] = agentDir;

const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const pngPixelSize = (png) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const flat = (value) => String(value).replace(/\s+/g, " ").trim();
const readJson = (path, fallback = null) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } };

const children = [];
const hostPids = [];
let views, registry, index, projects, catalog, providers, providerProfiles, secrets, nativeModels;
let schedules, gate, quitReports, gatedStopHosts, schedulerState;

let exiting = false;
const exitNow = (code, why) => {
  if (exiting) return;
  exiting = true;
  console.error(`T131718_CAPTURE_EXIT ${phase}`, code, why);
  try { app.exit(code); } catch { process.exit(code); }
};
const watchdog = setTimeout(() => exitNow(1, "watchdog timeout"), 1800000);
process.on("uncaughtException", (error) => exitNow(1, `uncaughtException ${error?.stack ?? error}`));
process.on("unhandledRejection", (error) => exitNow(1, `unhandledRejection ${String(error instanceof Error ? error.stack : error)}`));
app.on("window-all-closed", () => { if (phase === "primary" || phase === "restart") { /* harness keeps its own lifecycle */ } });

const PROJECT_NAME = "T13/T17/T18 验收工作区";
const API_KEY = "sk-t13-loopback-9d41c7e35a0b46f2";
const MODEL = "loopback-chat-7b";
const MODEL_ALT = "loopback-fast";
const BRANCH_TEMPLATE = "ticket/{taskId}-{slug}";
const T13_TASK = "Git 交付验收任务";
const T17_TASK = "定时巡检验收任务";
const SCHEDULE_PROMPT = "定时巡检：报告本次验收的调度状态 152-A";
const FOLLOWUP_PROMPT = "继续对话：把这轮巡检结论写清楚 152-B";

const git = (cwd, args) => execFileSync("git", args, {
  cwd, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
  stdio: ["ignore", "pipe", "pipe"],
}).trim();
const gitSafe = (cwd, args) => { try { return git(cwd, args); } catch (error) { return `ERROR: ${String(error?.stderr ?? error?.message ?? error)}`; } };
const remoteRefs = (remote) => gitSafe(remote, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]);
const localFacts = (cwd) => ({
  head: gitSafe(cwd, ["rev-parse", "HEAD"]),
  branch: gitSafe(cwd, ["symbolic-ref", "--short", "HEAD"]),
  status: gitSafe(cwd, ["status", "--porcelain=v1"]),
  refs: remoteRefs(cwd),
});

const SEED_DATE = "2026-12-01T09:00:00+0000";
/** One real temp Git repository with its own bare `origin` under the temp dir. */
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
// `state.mode` selects the behaviour between turns, so every leg is the server's
// real behaviour instead of a mock. The port is fixed per capture root so a later
// phase's Provider profile still points at a listening endpoint.
const received = [];
const providerState = { mode: "ok", port: 0, server: null };
const held = [];
function startProvider(port) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => {
        const url = request.url ?? "";
        received.push({ method: request.method, url, authorization: request.headers.authorization ?? "", body, mode: providerState.mode });
        if (request.method === "GET" && url.endsWith("/models")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ object: "list", data: [MODEL, MODEL_ALT].map((id) => ({ id, object: "model", owned_by: "loopback" })) }));
          return;
        }
        if (!url.endsWith("/chat/completions")) { response.writeHead(404).end(); return; }
        const mode = providerState.mode;
        // The turn's own marker is the LAST one in the body the SDK sends.
        const tag = [...body.matchAll(/15[237]-([A-Z])/g)].at(-1)?.[1] ?? "X";
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        const frame = (delta, extra = {}) => `data: ${JSON.stringify({
          id: `chatcmpl-loopback-${tag}`, object: "chat.completion.chunk", model: MODEL,
          choices: [{ index: 0, delta, finish_reason: null }], ...extra,
        })}\n\n`;
        response.write(frame({ content: `STREAM-${tag}-1 ` }));
        response.write(frame({ content: `STREAM-${tag}-2 ` }));
        if (mode === "hold") {
          let index = 3;
          const timer = setInterval(() => {
            try { response.write(frame({ content: `STREAM-${tag}-${index} 保持中的增量 ${"·".repeat(3)} ` })); index += 1; }
            catch { clearInterval(timer); }
            if (index > 400) clearInterval(timer);
          }, 200);
          response.on("close", () => clearInterval(timer));
          held.push({ response, timer });
          return;
        }
        const finish = () => {
          try {
            response.write(frame({ content: `STREAM-${tag}-3 ` }));
            response.write(`data: ${JSON.stringify({ id: `chatcmpl-loopback-${tag}`, object: "chat.completion.chunk", model: MODEL,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })}\n\n`);
            response.write("data: [DONE]\n\n");
            response.end();
          } catch { /* client closed */ }
        };
        if (mode === "slow") setTimeout(finish, 3000); else finish();
      });
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      providerState.port = typeof address === "object" && address ? address.port : port;
      resolvePromise(server);
    });
    server.on("close", () => {
      for (const entry of held.splice(0)) {
        try { clearInterval(entry.timer); } catch { /* already cleared */ }
        try { entry.response.end(); } catch { /* already closed */ }
      }
    });
    providerState.server = server;
  });
}
const withPort = (path, port = providerState.port) => `http://127.0.0.1:${port}${path}`;

/** A real HTTP git remote that answers 401: git's own auth machinery fails by name. */
function startAuthRemote(port) {
  return new Promise((resolvePromise) => {
    const server = createServer((request, response) => {
      response.writeHead(401, { "content-type": "text/plain", "www-authenticate": 'Basic realm="pidock-t13"' });
      response.end("authentication required\n");
    });
    server.listen(port, "127.0.0.1", () => resolvePromise(server));
    providerState.authServer = server;
  });
}
const freePort = () => new Promise((resolvePromise) => {
  const probe = createServer(() => {});
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    const port = typeof address === "object" && address ? address.port : 0;
    probe.close(() => resolvePromise(port));
  });
});

async function run() {
  let stage = "startup";
  const shots = { t13: [], t17: [], t18: [] };
  const assertions = { t13: [], t17: [], t18: [] };
  const findings = { t13: [], t17: [], t18: [] };
  const ticketOf = (name) => name;
  const check = (ticket, name, condition, detail = "") => {
    if (!condition) throw Error(`ASSERT FAILED [${phase}][${ticket}] ${name}${detail ? `: ${String(detail).slice(0, 1200)}` : ""}`);
    assertions[ticketOf(ticket)].push({ name, detail: String(detail).slice(0, 600) });
  };
  const recordFinding = (ticket, finding) => {
    findings[ticket].push(finding);
    console.log("T131718_FINDING=" + JSON.stringify({ ticket, id: finding.id, title: finding.title }));
  };
  // Dynamic imports: the compiled dist graph is pulled in only after the watchdog is armed.
  const { createTestSafeStorage, ProviderSecretStore } = await import("../dist/main/provider-secret-store.js");
  const { ProviderProfileStore } = await import("../dist/main/provider-profile-store.js");
  const { NativeModelsFile, resolveAgentDir } = await import("../dist/main/native-models-config.js");
  const { ProviderWiring } = await import("../dist/main/provider-ipc.js");
  const { TaskRootIndex } = await import("../dist/main/task-root-index.js");
  const { ProjectRegistry } = await import("../dist/main/project-registry.js");
  const { ServiceCatalog, serviceCatalogAuthority } = await import("../dist/main/service-catalog.js");
  const { createTrustedWindow, loadTrustedViews, PerTaskHostRegistry, registerIpc, createHostStopper } = await import("../dist/main/runtime.js");
  const { registerApplicationLifecycle } = await import("../dist/main/application-lifecycle.js");
  const { CreationIntentStore, ProjectTaskCreation } = await import("../dist/main/project-task-creation.js");
  const { WorktreeMetadataLock } = await import("../dist/main/worktree-metadata-lock.js");
  const { HostClient } = await import("../dist/rpc/host-client.js");
  const { readTaskRecordOnDisk } = await import("../dist/host/task-store.js");
  const { buildHostEnv } = await import("../dist/host/host-guards.js");
  const { ScheduleDriver } = await import("../dist/main/schedule-driver.js");
  const { QuitReportStore, SchedulerGate } = await import("../dist/main/schedule-supervision.js");

  const jsonlOf = (dir, sessionId) => {
    const base = join(dir, ".pidock-sdk-sessions", "main");
    if (!existsSync(base)) return "";
    return readdirSync(base).filter((name) => name.endsWith(".jsonl"))
      .filter((name) => sessionId === undefined || name.startsWith(sessionId))
      .map((name) => readFileSync(join(base, name), "utf8")).join("\n");
  };
  const sessionFiles = (dir) => {
    const base = join(dir, ".pidock-sdk-sessions", "main");
    return existsSync(base) ? readdirSync(base).filter((name) => name.endsWith(".jsonl")) : [];
  };

  try {
    if (phase === "primary") {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      for (const path of [profile, taskRoot, sourcesRoot, remotesRoot, agentDir, ...Object.values(dirs)]) mkdirSync(path, { recursive: true, mode: path === agentDir ? 0o700 : undefined });
    } else {
      for (const path of [profile, taskRoot, agentDir, ...Object.values(dirs)]) if (!existsSync(path)) mkdirSync(path, { recursive: true });
      mkdirSync(app.getPath("userData"), { recursive: true });
    }
    const priorState = readJson(statePath, {});
    providerState.port = priorState.loopbackPort ?? (phase === "primary" ? await freePort() : 0);
    if (!providerState.port) throw Error(`phase ${phase}: no loopback port in ${statePath}`);
    providerState.server = await startProvider(providerState.port);
    providerState.authServer = await startAuthRemote(priorState.authPort ?? (await freePort()));
    stage = "whenReady";
    await app.whenReady();

    index = new TaskRootIndex(profile, taskRoot);
    projects = new ProjectRegistry(profile);
    providerProfiles = new ProviderProfileStore(profile);
    secrets = new ProviderSecretStore(profile, createTestSafeStorage());
    const resolvedAgent = resolveAgentDir(process.env, homedir());
    if (resolvedAgent !== agentDir) throw Error(`PIDOCK_AGENT_DIR resolved to ${resolvedAgent}`);
    nativeModels = new NativeModelsFile(resolvedAgent);

    let state = { ...priorState, loopbackPort: providerState.port, authPort: providerState.authServer.address().port };
    let projectId = state.projectId ?? "";
    let t13TaskId = state.t13TaskId ?? "";
    let t17TaskId = state.t17TaskId ?? "";
    let profileId = state.profileId ?? "";
    let repos = state.repos ?? null;
    let scheduleId = state.scheduleId ?? "";

    stage = "seed";
    if (phase === "primary") {
      const frontend = seedRepo("frontend-app", "# frontend-app\n\nT13 验收：前端客户端仓库。\n", "base: frontend");
      const gateway = seedRepo("gateway-api", "# gateway-api\n\nT13 验收：网关仓库。\n", "base: gateway");
      const ledger = seedRepo("ledger-sync", "# ledger-sync\n\nT13 验收：账务同步仓库。\n", "base: ledger");
      repos = { frontend, gateway, ledger };
      const docsDir = join(sourcesRoot, "docs");
      mkdirSync(docsDir, { recursive: true });
      writeFileSync(join(docsDir, "验收说明.md"), "# 验收说明\n\nT17 定时任务专属工作区来源。\n");
      const project = await projects.create({
        name: PROJECT_NAME,
        description: "T13 Git 交付 / T17 定时任务 / T18 后台与退出（真实验收）",
        repositories: [frontend, gateway, ledger].map((row) => ({ name: row.name, path: row.dir })),
        directories: [{ name: "docs", path: docsDir }],
        environment: [],
        branchTemplate: BRANCH_TEMPLATE,
      });
      projectId = project.id;
      state.projectId = projectId;
      state.docsDir = docsDir;
      state.repos = repos;
      check("t13", "three REAL source checkouts and their bare origins were seeded",
        [frontend, gateway, ledger].every((row) => existsSync(join(row.remote, "HEAD")) && git(row.dir, ["remote", "get-url", "origin"]) === row.remote),
        JSON.stringify([frontend, gateway, ledger].map((row) => [row.dir, row.remote])));
      check("t13", "no task exists before the UI creates one", index.inventory().tasks.length === 0);
      // The Provider profile is seeded through the product's own main-side stores
      // (the same calls `shell/providerOp save` makes). The #138 UI path is covered
      // by T03 evidence; this capture is about delivery/schedules/lifecycle.
      const saved = providerProfiles.save({
        name: "Loopback 验收端点", notes: "本机回环 · 无真实线上账号", protocol: "openai-completions",
        baseUrl: withPort("/v1"), credentials: { kind: "store", revision: 1 }, modelId: MODEL,
        models: [
          { id: MODEL, name: "Loopback Chat 7B", contextWindow: 131072, maxTokens: 8192, reasoning: false },
          { id: MODEL_ALT, name: "Loopback Fast", contextWindow: 32768, maxTokens: 4096, reasoning: false },
        ],
      });
      profileId = saved.id;
      state.profileId = profileId;
      const revision = secrets.set(profileId, API_KEY);
      check("t17", "the Provider profile is store-backed with a ciphertext credential (test cipher)",
        secrets.has(profileId) && revision >= 1 && !readFileSync(join(profile, "provider-secrets.json"), "utf8").includes(API_KEY),
        JSON.stringify({ profileId, revision }));
      void nativeModels;
    }

    stage = "window";
    const workspaceId = `pencil-v1-t131718-${phase}`;
    views = await createTrustedWindow(workspaceId, "production");
    registry = new PerTaskHostRegistry(workspaceId, async (workspace, task) => {
      const entry = join(import.meta.dirname, "..", "dist", "host", "host-entry.js");
      const child = utilityProcess.fork(entry, [], { serviceName: `${workspaceId}-host`, env: buildHostEnv(process.env, workspace, task, profile), stdio: "pipe" });
      children.push(child);
      hostPids.push({ taskId: task ?? null, pid: child.pid, at: new Date().toISOString() });
      child.stderr?.on("data", (data) => process.stderr.write(`[${workspaceId}-host] ${data}`));
      return { child, client: new HostClient(child) };
    }, (id) => index.resolve(id), undefined, index);
    const ops = [];
    const originalRoute = registry.routeTaskOp.bind(registry);
    registry.routeTaskOp = async (input) => {
      const answer = await originalRoute(input);
      ops.push({ op: input?.op ?? null, taskId: input?.taskId ?? null,
        payloadKeys: input?.payload === undefined ? null : Object.keys(input.payload),
        ok: answer?.ok ?? null,
        abortedTurns: answer?.payload?.abortedTurns ?? null,
        error: answer?.ok === false ? String(answer.error) : null });
      return answer;
    };
    providers = new ProviderWiring(providerProfiles, async (taskId, provider, senderWebContentsId) => {
      const payload = provider === null ? { provider: null } : { provider: {
        config: providerProfiles.config(provider.profileId, provider.modelId),
        credential: provider.credential, thinkingLevel: provider.thinkingLevel } };
      await registry.routeTaskOp({ workspaceId, taskId, op: "task/sdkProvider", payload, origin: { kind: "shell-ui", senderWebContentsId } });
    }, process.env, { secrets, native: nativeModels });
    const creation = new ProjectTaskCreation(new CreationIntentStore(profile), projects, index, registry, taskRoot,
      undefined, new WorktreeMetadataLock(profile, { notify: () => {} }));
    catalog = new ServiceCatalog(profile, serviceCatalogAuthority(index, projects));
    // [T18] #153 the same supervision wiring `main.ts` uses: the gate owns the
    // quitting/asleep phase, the store makes an unconfirmed quit visible after a
    // restart, and the driver never forks a Host just to read a clock.
    quitReports = new QuitReportStore(profile);
    gate = new SchedulerGate(quitReports);
    schedulerState = () => {
      const persisted = gate.view().lastQuitUnconfirmed ?? quitReports.pending() ?? undefined;
      return { ...gate.view(), ...(persisted !== undefined ? { lastQuitUnconfirmed: persisted } : {}) };
    };
    registerIpc(createUnavailableHostClient(), views.registry, registry, projects, index, undefined, creation, providers, catalog, undefined, undefined, undefined, { state: schedulerState });
    await loadTrustedViews(views);
    views.shellView.webContents.debugger.attach();
    const stopHostsBase = createHostStopper(registry, { kind: "shell-ui", senderWebContentsId: views.shellView.webContents.id }, () => { schedules.stop(); });
    schedules = new ScheduleDriver({
      hostTaskIds: () => registry.activeTaskIds(),
      evaluate: async (taskId) => { await registry.routeTaskOp({ taskId, op: "task/scheduleEvaluate" }); },
      onError: (error, taskId) => console.error(`[t18] schedule evaluation failed for ${taskId}: ${String(error)}`),
      blockedReason: () => gate.blockedReason(),
    });
    gatedStopHosts = async () => {
      gate.beginQuit();
      schedules.stop();
      const stopped = await stopHostsBase();
      if (stopped) { gate.completeQuit(); quitReports.clear(); }
      else { gate.abortQuit({ at: new Date().toISOString(), hosts: stopHostsBase.unsatisfiedHosts() }); schedules.start(); }
      return stopped;
    };
    registerApplicationLifecycle({ app, window: views.window, platform: process.platform, stopHosts: gatedStopHosts,
      unsatisfiedHosts: () => stopHostsBase.unsatisfiedHosts(),
      onQuitUnconfirmed: (report) => { gate.abortQuit(report); } });
    powerMonitor.on("suspend", () => { gate.sleep(new Date().toISOString()); });
    powerMonitor.on("resume", () => {
      const woke = gate.wake(new Date().toISOString());
      if (woke === null) return;
      for (const taskId of registry.activeTaskIds()) {
        void registry.routeTaskOp({ taskId, op: "task/scheduleWake", payload: { at: woke.at } })
          .catch((error) => console.error(`[t18] schedule wake failed for ${taskId}: ${String(error)}`));
      }
    });
    schedules.start();
    writeFileSync(statePath, `${JSON.stringify({ ...state, ...(repos ? { repos } : {}) }, null, 2)}\n`);

    const evalJs = async (expression) => {
      const response = await views.shellView.webContents.debugger.sendCommand("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails));
      return response.result.value;
    };
    const text = async () => { try { return await evalJs("document.body.innerText"); } catch { return ""; } };
    const until = async (match, label) => {
      let last = "";
      for (let i = 0; i < 500; i++) { last = await text(); if (match(last)) return last; await wait(100); }
      throw Error(`UI timeout [${phase}] (${label}): ${JSON.stringify(last.slice(-4000))}`);
    };
    const click = (name) => evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(name)} || el.getAttribute('aria-label') === ${JSON.stringify(name)}); if (!b) throw Error('missing button '+${JSON.stringify(name)}+' :: '+document.body.innerText.replace(/\\n+/g,' | ').slice(0,800)); b.click(); return true; })()`);
    const clickLabel = (needle, scope = "document") => evalJs(`(() => {
      const root = ${scope} ?? document;
      const want = ${JSON.stringify(needle.replace(/\s+/g, ""))};
      const button = [...root.querySelectorAll('button')].find((el) => el.textContent.replace(/\\s+/g, '').includes(want) || el.getAttribute('aria-label') === ${JSON.stringify(needle)});
      if (!button) throw Error('missing button containing ' + ${JSON.stringify(needle)} + ' :: ' + document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 900));
      button.click();
      return true;
    })()`);
    const dialogText = () => evalJs("document.querySelector('[role=dialog]')?.innerText ?? ''");
    const dialogOpen = () => evalJs("!!document.querySelector('[role=dialog]')");
    const typeAt = async (label, value, index = 0) => {
      const typed = await evalJs(`(() => {
        const el = [...document.querySelectorAll('input[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']')][${index}];
        if (!el) throw Error('missing input ' + ${JSON.stringify(label)} + ' #' + ${index});
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return el.value;
      })()`);
      if (typed !== value) throw Error(`typing into "${label}" #${index} did not stick: ${JSON.stringify(typed)}`);
      return typed;
    };
    const chooseAt = async (label, value) => {
      const chosen = await evalJs(`(() => {
        const el = document.querySelector('select[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']');
        if (!el) throw Error('missing select ' + ${JSON.stringify(label)} + ' :: ' + document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 800));
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return el.value;
      })()`);
      if (chosen !== value) throw Error(`select "${label}" did not take ${value}: ${chosen}`);
      return chosen;
    };
    const typeTextarea = async (label, value) => {
      const typed = await evalJs(`(() => {
        const el = document.querySelector('textarea[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']');
        if (!el) throw Error('missing textarea ' + ${JSON.stringify(label)});
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return el.value;
      })()`);
      if (typed !== value) throw Error(`typing into textarea "${label}" did not stick: ${JSON.stringify(typed)}`);
      return typed;
    };
    const checkSource = async (name) => {
      const checked = await evalJs(`(() => {
        const input = [...document.querySelectorAll('[role=dialog] input[type=checkbox]')]
          .find((el) => (el.closest('label')?.textContent ?? '').trim().startsWith(${JSON.stringify(name)}));
        if (!input) throw Error('missing source checkbox ' + ${JSON.stringify(name)} + ' :: ' + document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 800));
        input.click();
        return { checked: input.checked, disabled: input.disabled };
      })()`);
      if (!checked.checked) throw Error(`source checkbox for "${name}" did not check (disabled=${checked.disabled})`);
      return checked;
    };
    const sharedWriteConfirmed = () => evalJs(`(() => {
      const input = [...document.querySelectorAll('[role=dialog] input[type=checkbox]')]
        .find((el) => (el.closest('label')?.textContent ?? '').includes('我确认普通目录'));
      if (!input) throw Error('missing shared-write confirmation');
      input.click();
      return input.checked;
    })()`);
    const setMode = async (value) => {
      const state2 = await evalJs(`(() => {
        const radio = document.querySelector('[role=dialog] input[type=radio][value=' + JSON.stringify(${JSON.stringify(value)}) + ']');
        if (!radio) throw Error('missing mode radio ' + ${JSON.stringify(value)});
        radio.click();
        return { checked: radio.checked, disabled: radio.disabled };
      })()`);
      await wait(120);
      if (!state2.checked) throw Error(`mode radio ${value} did not select (disabled=${state2.disabled})`);
      return state2;
    };
    const setKind = async (label) => {
      const state2 = await evalJs(`(() => {
        const radio = document.querySelector('[role=dialog] input[type=radio][aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']');
        if (!radio) throw Error('missing kind radio ' + ${JSON.stringify(label)});
        radio.click();
        return { checked: radio.checked, disabled: radio.disabled };
      })()`);
      await wait(150);
      if (!state2.checked) throw Error(`kind radio ${label} did not select (disabled=${state2.disabled})`);
      return state2;
    };
    const submitDisabled = () => evalJs(`(() => { const root = document.querySelector('[role=dialog]'); const b = root ? [...root.querySelectorAll('button[type=submit]')][0] : null; return b ? b.disabled : null; })()`);
    const sizeTo = async (width, height) => { views.window.setContentSize(width, height); await wait(120); };
    const settleFocus = () => evalJs("(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); return document.activeElement === document.body; })()");
    const bridgeCall = (taskId, op, payload) => evalJs(`window.pidock.taskOp(${JSON.stringify(taskId)}, ${JSON.stringify(op)}, ${payload === undefined ? "undefined" : JSON.stringify(payload)})`);
    // `shell/taskOp` answers with main's own envelope around the Host's payload;
    // the renderer bridge unwraps it, so the capture does the same.
    const bridgeTask = async (taskId, op, payload) => {
      const answer = await bridgeCall(taskId, op, payload);
      return answer?.ok === true ? { ok: true, payload: answer.payload?.payload ?? answer.payload } : answer;
    };
    const providerBridge = (request) => evalJs(`window.pidock.providerOp(${JSON.stringify(request)})`);
    const untilMain = async (predicate, label, attempts = 300) => {
      for (let i = 0; i < attempts; i++) { const value = await predicate(); if (value) return value; await wait(100); }
      throw Error(`main-side timeout (${label}) [${phase}]`);
    };

    const url = await evalJs("location.href");
    if (typeof url !== "string" || !/^file:\/\/.*\/renderer\/index\.html$/.test(url)) throw Error(`not the production file:// renderer: ${url}`);

    const capture = async (ticket, state2, width, height) => {
      stage = `${ticket}:${state2} ${width}x${height}`;
      views.window.setContentSize(width, height);
      views.shellView.setVisible(true);
      views.window.show();
      app.focus({ steal: true });
      views.window.moveTop();
      views.window.focus();
      await wait(250);
      const size = views.window.getContentBounds();
      if (size.width !== width || size.height !== height) throw Error(`unexpected content bounds ${JSON.stringify(size)}`);
      const name = `${width}x${height}-${state2}.png`;
      const shot = await views.shellView.webContents.debugger.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const png = Buffer.from(shot.data, "base64");
      writeFileSync(join(dirs[ticket], name), png);
      const pixels = pngPixelSize(png);
      shots[ticket].push({ state: state2, file: name, width: size.width, height: size.height,
        pixelWidth: pixels.width, pixelHeight: pixels.height, sha256: sha256(png),
        bodyText: (await text()).replace(/\n+/g, " | ").slice(0, 2200) });
      console.log("T131718_SHOT=" + JSON.stringify({ ticket, file: name, sha256: sha256(png) }));
    };
    const capturePair = async (ticket, state2) => {
      await settleFocus();
      await capture(ticket, state2, 1440, 900);
      await capture(ticket, state2, 720, 560);
      await sizeTo(1440, 900);
    };

    // ---------------------------------------------------------------- navigation
    const enterWorkspace = async () => {
      await click(PROJECT_NAME);
      await until((body) => body.includes("工作空间复用来源") && body.includes(PROJECT_NAME), "workspace overview");
    };
    const openCreationDialog = async () => {
      await enterWorkspace();
      await click("项目管理");
      await until((body) => body.includes("返回工作空间总览"), "manage page");
      await click("任务");
      await until((body) => body.includes("新建任务 (New Task)") && body.includes("任务工作区模式 *"), "S02 dialog");
    };
    const gotoDelivery = async () => {
      // The task header (and its 任务操作 menu) only exists on the conversation
      // page; the facts page that follows a creation has no actionset.
      if (!(await evalJs("!!document.querySelector('[data-testid=task-actionset]')"))) {
        await clickLabel("进入活跃对话");
        for (let i = 0; i < 200; i++) { if (await evalJs("!!document.querySelector('[data-testid=task-actionset]')")) break; await wait(100); }
      }
      const triggerDebug = await evalJs(`(() => {
        const list = [...document.querySelectorAll('button[aria-label="任务操作"]')];
        return list.map((el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), expanded: el.getAttribute('aria-expanded') }; });
      })()`);
      console.log("T131718_DEBUG_TRIGGER=" + JSON.stringify(triggerDebug));
      const point = triggerDebug[0];
      if (!point) throw Error("missing 任务操作 trigger");
      // A real mouse press/release through CDP: the popover closes on an outside
      // pointerdown, so a synthetic `.click()` is not always enough.
      await views.shellView.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
      await views.shellView.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
      for (let i = 0; i < 100; i++) { if (await evalJs("!!document.querySelector('[data-testid=task-action-menu]')")) break; await wait(50); }
      console.log("T131718_DEBUG_MENU=" + JSON.stringify(await evalJs(`(() => {
        const trigger = document.querySelector('button[aria-label="任务操作"]');
        return {
          expanded: trigger ? trigger.getAttribute('aria-expanded') : null,
          menu: !!document.querySelector('[data-testid=task-action-menu]'),
          menuHtml: document.querySelector('[data-testid=task-action-menu]')?.innerHTML?.slice(0, 600) ?? null,
          actionset: document.querySelector('[data-testid=task-actionset]') ? document.querySelector('[data-testid=task-actionset]').innerText.replace(/\\s+/g, ' ').slice(0, 400) : null,
          triggerHtml: trigger ? trigger.outerHTML.slice(0, 400) : null,
        };
      })()`)));
      await clickLabel("审阅与交付", "document.querySelector('[data-testid=task-action-menu]')");
      await until((body) => body.includes("审阅与交付") && body.includes("提交与推送只在你点击按钮后发生"), "delivery sheet");
      for (let i = 0; i < 200; i++) { if (await evalJs("!!document.querySelector('[data-testid=delivery-rows]') || !!document.querySelector('[data-testid=delivery-error]')")) break; await wait(100); }
    };
    const closeDialog = async () => {
      await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((el) => el.getAttribute('aria-label') === '关闭' || el.textContent.trim() === '关闭' || el.textContent.trim() === '取消'); if (b) b.click(); return true; })()`);
      await wait(300);
    };

    // ============================================================ T13 creation preview
    stage = "shell boot";
    await until((body) => body.includes(PROJECT_NAME) || body.includes("未归属任务"), "shell boot");
    await sizeTo(1440, 900);
    await openCreationDialog();
    const doc0 = flat(await dialogText());
    check("t13", "S02 offers the creation preview section before anything exists",
      doc0.includes("创建前预览：本地分支与推送目标"), doc0.slice(0, 700));
    await checkSource("frontend-app");
    await checkSource("gateway-api");
    await checkSource("ledger-sync");
    await typeAt("远程名称", "origin", 0);
    await typeAt("远程分支", "main", 0);
    await typeAt("远程名称", "origin", 1);
    await typeAt("远程分支", "main", 1);
    await typeAt("远程名称", "origin", 2);
    await typeAt("远程分支", "main", 2);
    await typeAt("任务名称", T13_TASK);
    // No saved convention/remote yet: the preview must block creation BY NAME.
    for (let i = 0; i < 200; i++) {
      if ((await evalJs(`document.querySelectorAll('[aria-label="创建前分支与推送目标预览"] li').length`)) === 3) break;
      await wait(100);
    }
    const blockedDetails = await evalJs(`(() => ({
      rows: [...document.querySelectorAll('[aria-label="创建前分支与推送目标预览"] li')].map((el) => el.innerText.replace(/\\s+/g, ' ').trim()),
      alert: document.querySelector('[aria-label="创建前分支与推送目标预览"] [role=alert]')?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
      submitDisabled: (() => { const b = document.querySelector('[role=dialog] button[type=submit]'); return b ? b.disabled : null; })(),
    }))()`);
    check("t13", "an unsaved branch convention blocks the create button with a named reason per repository",
      blockedDetails.submitDisabled === true && blockedDetails.rows.length === 3 &&
      blockedDetails.rows.every((row) => /branch-template-unset/.test(row)) && /branch-template-unset/.test(String(blockedDetails.alert)),
      JSON.stringify(blockedDetails));
    check("t13", "the blocked preview never invents a task/<id> default branch",
      !blockedDetails.rows.some((row) => /task\//.test(row)), JSON.stringify(blockedDetails.rows));
    await capturePair("t13", "creation-preview-blocked");

    stage = "T13 save delivery settings in the create form";
    await typeAt("分支规范", BRANCH_TEMPLATE);
    await typeAt("推送目标远程", "origin");
    await clickLabel("保存交付设置", "document.querySelector('[role=dialog]')");
    await until((body) => body.includes("已保存分支规范与推送目标"), "settings saved notice");
    for (let i = 0; i < 300; i++) {
      const rows = await evalJs(`[...document.querySelectorAll('[aria-label="创建前分支与推送目标预览"] li')].length`);
      const dis = await submitDisabled();
      if (rows === 3 && dis === false) break;
      await wait(100);
    }
    const previewRows = await evalJs(`[...document.querySelectorAll('[aria-label="创建前分支与推送目标预览"] li')].map((el) => el.innerText.replace(/\\s+/g, ' ').trim())`);
    const previewState = { rows: previewRows, submitDisabled: await submitDisabled(), settingsLine: flat(await dialogText()) };
    check("t13", "the preview lists one row per repository with the local branch and the push target",
      previewRows.length === 3 && previewRows.every((row) => /本地分支 ticket\//.test(row) && /推送目标 origin ticket\//.test(row)),
      JSON.stringify(previewState));
    check("t13", "the create button is only enabled once the preview is ready", previewState.submitDisabled === false, String(previewState.submitDisabled));
    await capturePair("t13", "creation-preview-ready");

    stage = "T13 prepare + commit creation";
    await clickLabel("固定基线并预览路径", "document.querySelector('[role=dialog]')");
    const intentPreview = await until((body) => body.includes(`任务路径预览 · ${T13_TASK}`) && body.includes("任务工作区模式：独立 Worktree"), "creation intent preview");
    const intent13 = creation.current();
    if (!intent13) throw Error("main holds no creation intent");
    t13TaskId = intent13.taskId;
    const intentFlat = flat(intentPreview);
    check("t13", "the confirm step repeats the SAME branch and push target the preview showed",
      intentFlat.includes(`本地分支：${intent13.branch}`) && intentFlat.includes(`推送目标：origin ${intent13.branch}`),
      intentFlat.slice(0, 900));
    check("t13", "the prepared branch is the template applied to the real task id",
      intent13.branch.startsWith("ticket/") && intent13.branch.includes(intent13.taskId), intent13.branch);
    check("t13", "every repository's previewed local branch equals the prepared task branch",
      previewRows.every((row) => row.includes(`本地分支 ${intent13.branch}`)), JSON.stringify({ rows: previewRows, branch: intent13.branch }));
    await capturePair("t13", "creation-intent");
    await clickLabel("确认创建 / 恢复", "document.querySelector('[role=dialog]')");
    await until((body) => !body.includes("任务路径预览") && body.includes(T13_TASK) && body.includes("独立 Worktree"), "facts after the real creation");
    check("t13", "the S02 dialog closed after the real creation", (await dialogOpen()) === false);
    state = { ...state, t13TaskId, branch: intent13.branch };
    writeFileSync(statePath, `${JSON.stringify({ ...state, repos }, null, 2)}\n`);

    stage = "T13 verify the created branches";
    const record13 = readTaskRecordOnDisk(intent13.taskDir);
    const branchFacts = {};
    for (const repo of intent13.repos) {
      const target = join(intent13.taskDir, repo.repoDir);
      branchFacts[repo.name] = { target, branch: git(target, ["symbolic-ref", "--short", "HEAD"]),
        exists: existsSync(target), remote: git(target, ["remote", "get-url", "origin"]) };
      check("t13", `the real worktree of ${repo.name} is on the previewed branch`,
        branchFacts[repo.name].branch === intent13.branch, `${repo.name}: ${branchFacts[repo.name].branch} vs ${intent13.branch}`);
      check("t13", `the real worktree of ${repo.name} exists on disk and resolves its origin`,
        branchFacts[repo.name].exists === true && branchFacts[repo.name].remote === repos[repo.name === "frontend-app" ? "frontend" : repo.name === "gateway-api" ? "gateway" : "ledger"].remote,
        JSON.stringify(branchFacts[repo.name]));
    }
    check("t13", "the task record carries the same task branch the preview showed",
      record13?.branch === intent13.branch &&
      JSON.stringify([...(record13?.repos ?? [])].sort()) === JSON.stringify(intent13.repos.map((repo) => repo.repoDir).sort()),
      JSON.stringify({ record: record13?.branch, repos: record13?.repos }));
    await capturePair("t13", "task-facts-after-create");

    // ------------------------------------------------------------ delivery sheet
    stage = "T13 delivery plan";
    for (const repo of intent13.repos) {
      const target = join(intent13.taskDir, repo.repoDir);
      writeFileSync(join(target, "README.md"), `# ${repo.name}\n\nT13 交付验收：第一处改动（${repo.name}）。\n`);
      writeFileSync(join(target, "T13-NEW.md"), `新增文件：${repo.name}\n`);
    }
    // The sheet lives behind the task header's 任务操作 menu. That menu's popover
    // rendered without its menu element in this build (recorded as a finding), so
    // the sheet leg falls back to the SAME Host ops the sheet calls
    // (task/deliveryCommit / task/deliveryPush through shell/taskOp) and is
    // labelled as IPC-level evidence, never as a screenshot of the sheet.
    let sheetAvailable = true;
    try { await gotoDelivery(); } catch (error) {
      sheetAvailable = false;
      recordFinding("t13", { id: "delivery-menu-unreachable", title: "任务操作 菜单点击后 aria-expanded=true 但菜单元素未渲染，无法从界面打开 审阅与交付",
        expected: "点击 任务操作 打开 role=menu 弹层并出现 审阅与交付",
        observed: `trigger aria-expanded=true，document.querySelector('[data-testid=task-action-menu]') 为 null；${String(error).slice(0, 300)}`,
        note: "本次未修改产品代码。交付的提交/推送改由 shell/taskOp 直接调用 Host 的 task/deliveryCommit / task/deliveryPush（与界面按钮同一路径），截图缺口在 README 的 unverified 列表里如实列出。" });
      await capture("t13", "delivery-sheet-unreachable", 1440, 900);
    }
    const planRows = sheetAvailable ? await evalJs(`[...document.querySelectorAll('[data-testid^=delivery-row-]')].filter((el) => /^delivery-row-[^-]+$/.test(el.getAttribute('data-testid'))).map((el) => el.innerText.replace(/\\s+/g, ' ').trim())`) : [];
    const sheetText = sheetAvailable ? flat(await evalJs("document.querySelector('[data-testid=delivery-sheet]')?.innerText ?? ''")) : "";
    if (sheetAvailable) {
      check("t13", "the delivery sheet lists one row per real worktree repository with branch and push target",
        planRows.length === 3 && planRows.every((row) => row.includes(`本地分支：${intent13.branch}`) && row.includes(`推送目标：origin ${intent13.branch}`)),
        JSON.stringify(planRows));
      check("t13", "the sheet states that commit/push only happen on an explicit click and never automatically",
        sheetText.includes("提交与推送只在你点击按钮后发生，不自动执行") && sheetText.includes("任务完成不会推送或创建远端分支"), sheetText.slice(0, 700));
      await capturePair("t13", "delivery-plan");
    }
    const planAnswer = await bridgeTask(t13TaskId, "task/deliveryPlan");
    check("t13", "the Host's own delivery plan previews one ready row per worktree repo on the created branch",
      (planAnswer?.payload?.plan?.rows ?? []).length === 3 &&
      (planAnswer.payload.plan.rows ?? []).every((row) => row.branch === intent13.branch && row.problem === null && row.remote === "origin" && row.pushTarget !== null),
      JSON.stringify(planAnswer?.payload?.plan?.rows ?? planAnswer));

    stage = "T13 commit";
    const statusText = (answer) => (answer?.payload?.outcomes ?? []).map((row) => `${row.status}（${row.branch}）`);
    const summaryText = (answer) => (answer?.payload?.outcomes ?? []).map((row) => row.summary);
    const overallText = async (answer) => (answer ? answer.payload?.overall ?? null : await evalJs("document.querySelector('[data-testid=delivery-overall]')?.innerText.trim() ?? null"));
    const domStatuses = () => evalJs(`[...document.querySelectorAll('[data-testid$=-status]')].map((el) => el.innerText.replace(/\\s+/g, ' ').trim())`);
    const runCommit = async (message) => {
      if (sheetAvailable) { await typeAt("提交说明", message); await clickLabel("提交所选仓库"); await wait(1500); return null; }
      return bridgeTask(t13TaskId, "task/deliveryCommit", { branch: intent13.branch, commitMessage: message, repoIds: deliveryRepoIds });
    };
    const runPush = async (repoIds) => {
      if (sheetAvailable) { await clickLabel("推送到目标远程"); await wait(1500); return null; }
      return bridgeTask(t13TaskId, "task/deliveryPush", { branch: intent13.branch, repoIds });
    };
    const deliveryRepoIds = ((await bridgeTask(t13TaskId, "task/deliveryPlan"))?.payload?.plan?.rows ?? []).map((row) => row.repoId);
    const allRepoIds = deliveryRepoIds;
    const commitAnswer = await runCommit("T13 验收：显式提交");
    if (sheetAvailable) await until((body) => body.includes("提交成功") || body.includes("已提交") || body.includes("无改动"), "commit outcomes");
    await wait(500);
    const commitOutcomes = commitAnswer ? statusText(commitAnswer) : await domStatuses();
    const commitSummaries = commitAnswer ? summaryText(commitAnswer) : await evalJs(`[...document.querySelectorAll('[data-testid$=-summary]')].map((el) => el.innerText.replace(/\\s+/g, ' ').trim())`);
    const commitOverall = await overallText(commitAnswer);
    const afterCommit = Object.fromEntries(intent13.repos.map((repo) => [repo.name, localFacts(join(intent13.taskDir, repo.repoDir))]));
    check("t13", "the explicit commit created one real commit per repository and left the tree clean",
      Object.values(afterCommit).every((row) => row.status === "" && row.head !== "ERROR"), JSON.stringify(afterCommit));
    check("t13", "the commit answer names the per-repo outcome and overall state",
      commitOutcomes.length === 3 && commitOutcomes.every((row) => row.includes(intent13.branch)) && /提交成功|success|成功/.test(String(commitOverall)),
      JSON.stringify({ commitOutcomes, commitOverall, commitSummaries, source: sheetAvailable ? "sheet" : "task/deliveryCommit payload" }));
    if (sheetAvailable) await capturePair("t13", "delivery-committed");

    stage = "T13 real push";
    const beforePushRefs = Object.fromEntries(intent13.repos.map((repo) => [repo.name, remoteRefs(repos[repo.name === "frontend-app" ? "frontend" : repo.name === "gateway-api" ? "gateway" : "ledger"].remote)]));
    const pushAnswer = await runPush(allRepoIds);
    if (sheetAvailable) await until((body) => /推送成功|已推送/.test(body), "push outcome");
    await wait(800);
    const pushOutcomes = pushAnswer ? statusText(pushAnswer) : await domStatuses();
    const pushSummaries = pushAnswer ? summaryText(pushAnswer) : await evalJs(`[...document.querySelectorAll('[data-testid$=-summary]')].map((el) => el.innerText.replace(/\\s+/g, ' ').trim())`);
    const pushOverall = await overallText(pushAnswer);
    const pushedRefs = {};
    for (const repo of intent13.repos) {
      const remote = repos[repo.name === "frontend-app" ? "frontend" : repo.name === "gateway-api" ? "gateway" : "ledger"].remote;
      pushedRefs[repo.name] = { remote, branchRef: gitSafe(remote, ["rev-parse", `refs/heads/${intent13.branch}`]),
        worktreeHead: git(join(intent13.taskDir, repo.repoDir), ["rev-parse", "HEAD"]),
        refsBefore: beforePushRefs[repo.name], refsAfter: remoteRefs(remote) };
    }
    check("t13", "every repository was really pushed to its local bare origin on the task branch",
      Object.values(pushedRefs).every((row) => row.branchRef === row.worktreeHead && !row.branchRef.startsWith("ERROR")),
      JSON.stringify(pushedRefs));
    check("t13", "the pushed ref did not exist on the bare origin before the push",
      Object.values(pushedRefs).every((row) => !row.refsBefore.includes(`refs/heads/${intent13.branch}`)),
      JSON.stringify(Object.values(pushedRefs).map((row) => row.refsBefore)));
    check("t13", "the push answer reports success per repository with the real remote branch",
      pushOutcomes.length === 3 && pushOutcomes.every((row) => /success|推送成功|成功/.test(row)) && /success|推送成功|成功/.test(String(pushOverall)),
      JSON.stringify({ pushOutcomes, pushSummaries, pushOverall, source: sheetAvailable ? "sheet" : "task/deliveryPush payload" }));
    if (sheetAvailable) await capturePair("t13", "delivery-pushed");

    stage = "T13 PR guidance + no-changes";
    const noChangesAnswer = await runPush(allRepoIds);
    if (sheetAvailable) await wait(1200);
    await wait(500);
    const noChangesOutcomes = noChangesAnswer ? statusText(noChangesAnswer) : await domStatuses();
    const noChangesOverall = await overallText(noChangesAnswer);
    const pr = noChangesAnswer?.payload?.pr ?? (pushAnswer?.payload?.pr ?? []);
    check("t13", "a push returns PR guidance built from the ACTUAL remote and never claims a PR exists",
      pr.length === 3 && pr.every((row) => typeof row.text === "string" && !/已创建|已打开|PR 已存在/.test(row.text)),
      JSON.stringify(pr));
    check("t13", "a second push with no local changes is the named 无改动 state, not a fabricated success",
      noChangesOutcomes.length === 3 && noChangesOutcomes.every((row) => /no-changes|无改动/.test(row)) && /no-changes|无改动/.test(String(noChangesOverall)),
      JSON.stringify({ noChangesOutcomes, noChangesOverall }));
    if (sheetAvailable) await capturePair("t13", "delivery-no-changes");

    // ------------------------------------------------- named failures + partial
    stage = "T13 partial multi-repo failure";
    for (const repo of intent13.repos) {
      const target = join(intent13.taskDir, repo.repoDir);
      writeFileSync(join(target, "T13-NEW.md"), `新增文件：${repo.name}\n第二处改动（用于失败腿）。\n`);
    }
    await runCommit("T13 验收：失败腿的提交");
    await wait(800);
    // frontend-app: a REAL pre-receive hook that rejects the push.
    const frontendRemote = repos.frontend.remote;
    writeFileSync(join(frontendRemote, "hooks", "pre-receive"), "#!/bin/sh\necho 'T13 验收：pre-receive 拒绝本次推送（远端策略）' >&2\nexit 1\n");
    chmodSync(join(frontendRemote, "hooks", "pre-receive"), 0o755);
    // ledger-sync: a REAL HTTP remote that answers 401, so git's own auth fails by name.
    const ledgerPlanRow = ((await bridgeTask(t13TaskId, "task/deliveryPlan"))?.payload?.plan?.rows ?? []).find((row) => row.repoPath.endsWith(intent13.repos.find((repo) => repo.name === "ledger-sync").repoDir));
    const ledgerRepoId = ledgerPlanRow?.repoId ?? deliveryRepoIds[2];
    const ledgerWorktree = join(intent13.taskDir, intent13.repos.find((repo) => repo.name === "ledger-sync").repoDir);
    git(ledgerWorktree, ["remote", "set-url", "origin", withPort("/t13-auth/ledger-sync.git", state.authPort)]);
    const partialAnswer = await runPush(allRepoIds);
    if (sheetAvailable) { await until((body) => /部分成功|全部失败|推送成功/.test(body), "partial push outcome"); await wait(1200); }
    await wait(600);
    const partialOutcomes = partialAnswer ? (partialAnswer.payload?.outcomes ?? []).map((row) => ({ id: `delivery-outcome-${row.repoId}`, text: `${row.status}（${row.branch}） ${row.summary}` })) : await evalJs(`[...document.querySelectorAll('[data-testid^=delivery-outcome-]')].map((el) => ({ id: el.getAttribute('data-testid'), text: el.innerText.replace(/\\s+/g, ' ').trim() }))`);
    const partialOverall = partialAnswer ? partialAnswer.payload?.overall ?? null : await evalJs("document.querySelector('[data-testid=delivery-overall]')?.innerText.trim() ?? null");
    const gatewayRepo = intent13.repos.find((repo) => repo.name === "gateway-api");
    const gatewayHeadAfter = git(join(intent13.taskDir, gatewayRepo.repoDir), ["rev-parse", "HEAD"]);
    check("t13", "the real pre-receive hook rejected frontend-app's push",
      partialOutcomes.some((row) => /remote-reject|pre-receive|拒绝|远端拒绝/.test(row.text)), JSON.stringify(partialOutcomes));
    check("t13", "the real HTTP 401 endpoint produced the named auth failure, not a generic error",
      partialOutcomes.some((row) => /auth-failure|认证失败|鉴权|无法读取用户名|could not read Username|401/i.test(row.text)), JSON.stringify(partialOutcomes));
    check("t13", "the healthy repository still succeeded in the same batch",
      gitSafe(repos.gateway.remote, ["rev-parse", `refs/heads/${intent13.branch}`]) === gatewayHeadAfter,
      JSON.stringify({ remote: gitSafe(repos.gateway.remote, ["rev-parse", `refs/heads/${intent13.branch}`]), head: gatewayHeadAfter }));
    check("t13", "the mixed multi-repo outcome is recorded per repository and NOT summarized as success",
      partialOutcomes.length === 3 && /partial|部分/.test(String(partialOverall)), JSON.stringify({ partialOutcomes, partialOverall }));
    if (sheetAvailable) await capturePair("t13", "delivery-partial-failure");

    stage = "T13 failed push preserves uncommitted work";
    const ledgerFactsBefore = localFacts(ledgerWorktree);
    writeFileSync(join(ledgerWorktree, "README.md"), `# ledger-sync\n\nT13 未提交的本地改动（推送必然失败）。\n`);
    writeFileSync(join(ledgerWorktree, "LOCAL-WIP.md"), "未提交的本地工作\n");
    const withWip = localFacts(ledgerWorktree);
    const directAuth = await bridgeTask(t13TaskId, "task/deliveryPush", { branch: intent13.branch, repoIds: [ledgerRepoId] });
    const ledgerAfterPush = localFacts(ledgerWorktree);
    check("t13", "the failed push really happened against the 401 endpoint",
      (directAuth?.payload?.outcomes ?? []).some((row) => row.status === "auth-failure"),
      JSON.stringify(directAuth?.payload?.outcomes));
    check("t13", "the failed push preserved the uncommitted change and the untracked file exactly",
      ledgerAfterPush.status === withWip.status && withWip.status.includes("README.md") && withWip.status.includes("LOCAL-WIP.md"),
      JSON.stringify({ before: withWip.status, after: ledgerAfterPush.status, beforeHead: ledgerFactsBefore.head }));
    check("t13", "the failed push did not move HEAD or create a commit",
      ledgerAfterPush.head === withWip.head && git(ledgerWorktree, ["rev-list", "--count", "HEAD"]) === git(ledgerWorktree, ["rev-list", "--count", "HEAD"]),
      JSON.stringify({ head: ledgerAfterPush.head }));

    stage = "T13 no auto-push on completion";
    const refsBeforeArchive = Object.fromEntries(intent13.repos.map((repo) => [repo.name,
      remoteRefs(repos[repo.name === "frontend-app" ? "frontend" : repo.name === "gateway-api" ? "gateway" : "ledger"].remote)]));
    const archive = await bridgeTask(t13TaskId, "task/archive", { label: "T13 验收：完成任务" });
    check("t13", "the task could be archived (the completion path main exposes)", archive?.ok === true, JSON.stringify(archive));
    await wait(800);
    const refsAfterArchive = Object.fromEntries(intent13.repos.map((repo) => [repo.name,
      remoteRefs(repos[repo.name === "frontend-app" ? "frontend" : repo.name === "gateway-api" ? "gateway" : "ledger"].remote)]));
    check("t13", "task completion pushed nothing and created no remote branch",
      JSON.stringify(refsBeforeArchive) === JSON.stringify(refsAfterArchive), JSON.stringify({ refsBeforeArchive, refsAfterArchive }));
    check("t13", "the archived task's worktree still holds its uncommitted work (nothing was cleaned or pushed)",
      localFacts(ledgerWorktree).status.includes("LOCAL-WIP.md"), localFacts(ledgerWorktree).status);
    // Restore the ledger remote so later phases see the real origin again.
    git(ledgerWorktree, ["remote", "set-url", "origin", repos.ledger.remote]);
    state = { ...state, t13TaskId, branch: intent13.branch };
    writeFileSync(statePath, `${JSON.stringify({ ...state, repos }, null, 2)}\n`);
    if (sheetAvailable) await closeDialog();

    // ============================================================ T17 schedules
    let saved17 = null, savedEdited = null, startedRun = null, completed = null;
    let sessionsBefore = [], sessionsAfter = [], runsFinal = [], noProvider = null, noModel = null;
    let intent17 = { taskId: "", taskDir: "" }, record17 = null, runJsonl = "", failedRun = null;
    try {
    stage = "T17 S04 scheduled task creation";
    await openCreationDialog();
    await setMode("plain-dirs");
    await checkSource("docs");
    check("t17", "a plain directory needs the shared-write confirmation", (await sharedWriteConfirmed()) === true);
    await typeAt("任务名称", T17_TASK);
    await setKind("定时任务");
    await until((body) => body.includes("定时设置"), "scheduled definition section");
    check("t17", "S02 offers the dedicated 定时任务 task type with rule/timezone/model/permission/prompt",
      flat(await dialogText()).includes("定时任务拥有自己的任务工作区"), flat(await dialogText()).slice(0, 600));
    await typeAt("定时任务规则", "*/1 * * * *");
    await typeAt("定时任务时区", "Asia/Shanghai");
    await chooseAt("定时任务模型", `${profileId}\u0000${MODEL}`);
    await chooseAt("定时任务权限", "default");
    await typeTextarea("定时任务提示词", SCHEDULE_PROMPT);
    await wait(700);
    await capturePair("t17", "s04-creation-form");
    await clickLabel("预览路径", "document.querySelector('[role=dialog]')");
    const schedPreview = await until((body) => body.includes(`任务路径预览 · ${T17_TASK}`) && body.includes("无 Git 交付"), "scheduled creation preview");
    check("t17", "the scheduled task's confirm step states 无 Git 交付 instead of inventing a branch",
      flat(schedPreview).includes("无 Git 交付：仅普通目录，不创建分支，也没有推送目标"), flat(schedPreview).slice(0, 700));
    intent17 = creation.current();
    if (!intent17) throw Error("main holds no scheduled creation intent");
    t17TaskId = intent17.taskId;
    await capturePair("t17", "s04-creation-intent");
    await clickLabel("确认创建 / 恢复", "document.querySelector('[role=dialog]')");
    await until((body) => !body.includes("任务路径预览") && body.includes(T17_TASK), "facts after the scheduled creation");
    record17 = readTaskRecordOnDisk(intent17.taskDir);
    check("t17", "the created task is a dedicated scheduled task (kind: scheduled)",
      record17?.kind === "scheduled", JSON.stringify({ kind: record17?.kind, mode: record17?.workspaceMode }));
    state = { ...state, t17TaskId };
    writeFileSync(statePath, `${JSON.stringify({ ...state, repos }, null, 2)}\n`);
    const scheduleList0 = await bridgeTask(t17TaskId, "task/scheduleList");
    saved17 = scheduleList0?.payload?.schedules?.[0];
    scheduleId = saved17?.scheduleId ?? "";
    state = { ...state, scheduleId };
    writeFileSync(statePath, `${JSON.stringify({ ...state, repos }, null, 2)}\n`);
    check("t17", "the Host persisted the schedule created with the task (rule/timezone/model/permission/prompt)",
      saved17?.ruleText === "*/1 * * * *" && saved17?.timezone === "Asia/Shanghai" && saved17?.model === MODEL &&
      saved17?.providerId === profileId && saved17?.permission === "default" && saved17?.prompt === SCHEDULE_PROMPT &&
      saved17?.enabled === true,
      JSON.stringify(saved17));

    stage = "T17 S04 page";
    await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === '定时任务'); if (!b) throw Error('missing 定时任务 nav'); b.click(); return true; })()`);
    await until((body) => body.includes("Scheduled Tasks") && body.includes(T17_TASK), "S04 schedules page");
    for (let i = 0; i < 200; i++) { if (await evalJs(`!!document.querySelector('[data-schedule-row="${scheduleId}"]')`)) break; await wait(100); }
    const s04Row = flat(await evalJs(`document.querySelector('[data-schedule-row="${scheduleId}"]')?.innerText ?? ''`));
    check("t17", "S04 lists the schedule with its rule, timezone, task, Provider/model and 已启用 badge",
      s04Row.includes("*/1 * * * *") && s04Row.includes("Asia/Shanghai") && s04Row.includes(T17_TASK) &&
      s04Row.includes(profileId) && s04Row.includes(MODEL) && s04Row.includes("已启用"), s04Row);
    await capturePair("t17", "s04-schedule-created");

    // ------------------- named failure: no Provider/credential installed yet
    stage = "T17 run-now without a credential";
    await clickLabel(`立即运行 定时巡检（已编辑）`, "document").catch(async () => {
      await evalJs(`(() => { const b = [...document.querySelectorAll('button[aria-label^="立即运行"]')][0]; if (!b) throw Error('missing 立即运行'); b.click(); return true; })()`);
    });
    await until((body) => body.includes("credential-missing") || body.includes("失败"), "credential-missing run record");
    await wait(600);
    failedRun = (await bridgeTask(t17TaskId, "task/scheduleRuns"))?.payload?.runs?.[0];
    check("t17", "a run-now without an installed Provider/credential fails BY NAME and creates no session",
      failedRun?.result === "failed" && failedRun?.failureCode === "credential-missing" && failedRun?.sessionId === undefined,
      JSON.stringify(failedRun));
    check("t17", "the failed trigger left no SDK JSONL behind (no turn was started)",
      sessionFiles(intent17.taskDir).length === 0, JSON.stringify(sessionFiles(intent17.taskDir)));
    await capturePair("t17", "s04-run-credential-missing");

    stage = "T17 install the Provider";
    const install = await providerBridge({ taskId: t17TaskId, op: "select", profileId, modelId: MODEL, thinkingLevel: "high" });
    check("t17", "the Provider was installed into the scheduled task through the product's own select path",
      install?.ok === true, JSON.stringify(install));
    await untilMain(async () => ((await providerBridge({ taskId: t17TaskId, op: "list" }))?.payload?.state) === "configured", "provider configured");

    stage = "T17 edit the saved schedule";
    await evalJs(`(() => { const b = [...document.querySelectorAll('button[aria-label^="编辑 "]')][0]; if (!b) throw Error('missing 编辑'); b.click(); return true; })()`);
    await until((body) => body.includes("编辑定时任务"), "schedule editor");
    await typeAt("名称", "定时巡检（已编辑）");
    await typeAt("规则", "*/1 * * * *");
    await typeAt("时区", "UTC");
    await chooseAt("Provider / 模型", `${profileId}\u0000${MODEL}`);
    await chooseAt("新会话权限", "read");
    await typeTextarea("提示词", SCHEDULE_PROMPT);
    await clickLabel("校验并预览");
    await until((body) => body.includes("下次触发"), "rule preview from Host");
    const previewText = flat(await dialogText());
    check("t17", "the editor's rule validation and next trigger come from the Host",
      /下次触发 \d{4}-\d{2}-\d{2}T/.test(previewText), previewText.slice(0, 700));
    await capturePair("t17", "s04-schedule-edit");
    await clickLabel("保存");
    await until((body) => !body.includes("编辑定时任务") && body.includes("定时巡检（已编辑）"), "saved schedule row");
    savedEdited = (await bridgeTask(t17TaskId, "task/scheduleList"))?.payload?.schedules?.[0];
    check("t17", "the edit persisted timezone/permission/model/rule through the Host",
      savedEdited?.timezone === "UTC" && savedEdited?.permission === "read" && savedEdited?.model === MODEL &&
      savedEdited?.ruleText === "*/1 * * * *" && savedEdited?.name === "定时巡检（已编辑）" && savedEdited?.configVersion >= 1,
      JSON.stringify(savedEdited));

    stage = "T17 disable/enable";
    await evalJs(`(() => { const b = [...document.querySelectorAll('button[aria-label^="暂停 "]')][0]; if (!b) throw Error('missing 暂停'); b.click(); return true; })()`);
    await until((body) => body.includes("已暂停"), "paused state");
    await wait(400);
    check("t17", "暂停 really persisted enabled=false", (await bridgeTask(t17TaskId, "task/scheduleList"))?.payload?.schedules?.[0]?.enabled === false);
    await capturePair("t17", "s04-schedule-paused");
    await evalJs(`(() => { const b = [...document.querySelectorAll('button[aria-label^="启用 "]')][0]; if (!b) throw Error('missing 启用'); b.click(); return true; })()`);
    await until((body) => body.includes("已启用"), "enabled state");
    await wait(400);
    check("t17", "启用 really persisted enabled=true", (await bridgeTask(t17TaskId, "task/scheduleList"))?.payload?.schedules?.[0]?.enabled === true);

    stage = "T17 run-now real turn";
    providerState.mode = "ok";
    sessionsBefore = JSON.parse(JSON.stringify((await bridgeTask(t17TaskId, "task/sessionList"))?.payload?.sessions ?? []));
    await evalJs(`(() => { const b = [...document.querySelectorAll('button[aria-label^="立即运行 "]')][0]; if (!b) throw Error('missing 立即运行'); b.click(); return true; })()`);
    startedRun = await untilMain(async () => {
      const runs = (await bridgeTask(t17TaskId, "task/scheduleRuns"))?.payload?.runs ?? [];
      return runs.find((run) => run.result === "running") ?? null;
    }, "running run record");
    check("t17", "立即运行 mints a run record with the configured model and a NEW session",
      startedRun?.sessionId !== undefined && startedRun?.model === MODEL && !sessionsBefore.some((row) => row.sessionId === startedRun.sessionId),
      JSON.stringify({ startedRun, sessionsBefore: sessionsBefore.map((row) => row.sessionId) }));
    completed = await untilMain(async () => {
      const runs = (await bridgeTask(t17TaskId, "task/scheduleRuns"))?.payload?.runs ?? [];
      return runs.find((run) => run.runId === startedRun.runId && run.result !== "running") ?? null;
    }, "settled run record");
    check("t17", "the scheduled run really completed through the SDK and reports the ACTUAL model",
      completed?.result === "completed" && completed?.actualModel === MODEL && completed?.endedAt !== undefined,
      JSON.stringify(completed));
    runJsonl = jsonlOf(intent17.taskDir, completed?.sessionId);
    check("t17", "the run's session is a real SDK JSONL in the SAME task workspace carrying the schedule prompt",
      runJsonl.includes(SCHEDULE_PROMPT) && runJsonl.includes("STREAM-A-3") && sessionFiles(intent17.taskDir).includes(`${completed.sessionId}.jsonl`),
      JSON.stringify({ files: sessionFiles(intent17.taskDir), bytes: runJsonl.length }));
    sessionsAfter = (await bridgeTask(t17TaskId, "task/sessionList"))?.payload?.sessions ?? [];
    check("t17", "the run created exactly one NEW session in the same task (no second workspace)",
      sessionsAfter.length === sessionsBefore.length + 1 &&
      sessionsAfter.filter((row) => row.sessionId === completed.sessionId).length === 1 &&
      (await bridgeTask(t17TaskId, "task/scheduleRuns"))?.payload?.runs.length === 2,
      JSON.stringify({ before: sessionsBefore.length, after: sessionsAfter.length }));
    for (let i = 0; i < 200; i++) { if (await evalJs(`!!document.querySelector('[data-schedule-run="${completed.runId}"]')`)) break; await wait(100); }
    const runRow = flat(await evalJs(`document.querySelector('[data-schedule-run="${completed.runId}"]')?.innerText ?? ''`));
    check("t17", "S04's run history shows the start time, status, ACTUAL model and the linked session",
      runRow.includes("已完成") && runRow.includes(MODEL) && runRow.includes("继续对话"),
      runRow);
    await capturePair("t17", "s04-run-completed");

    stage = "T17 open the run session and continue";
    await evalJs(`(() => { const row = document.querySelector('[data-schedule-run="${completed.runId}"]'); const b = [...row.querySelectorAll('button')].find((el) => el.textContent.trim() === '继续对话'); if (!b) throw Error('missing 继续对话'); b.click(); return true; })()`);
    await until((body) => body.includes(T17_TASK) && body.includes("SDK JSONL 已确认历史"), "task view of the run session");
    await wait(800);
    const historyBefore = flat(await evalJs("document.querySelector('[aria-label=\"SDK 对话历史\"]')?.innerText ?? ''"));
    check("t17", "继续对话 opens THAT session and shows the scheduled prompt as its first turn",
      historyBefore.includes(SCHEDULE_PROMPT) && historyBefore.includes("STREAM-A-1"), historyBefore.slice(0, 900));
    await evalJs(`(() => { const el = document.querySelector('textarea[aria-label="消息"]'); if (!el) throw Error('missing composer'); el.focus(); el.select(); return true; })()`);
    await views.shellView.webContents.debugger.sendCommand("Input.insertText", { text: FOLLOWUP_PROMPT });
    for (let i = 0; i < 50; i++) {
      const disabled = await evalJs(`document.querySelector('button[aria-label="发送"]')?.disabled ?? null`);
      if (disabled === false) break;
      await wait(100);
    }
    await click("发送");
    await until((body) => body.includes("STREAM-B-3"), "follow-up turn in the run session");
    const historyAfter = flat(await evalJs("document.querySelector('[aria-label=\"SDK 对话历史\"]')?.innerText ?? ''"));
    check("t17", "the follow-up turn lands in the SAME session the run created",
      historyAfter.includes(FOLLOWUP_PROMPT) && historyAfter.includes(SCHEDULE_PROMPT) &&
      jsonlOf(intent17.taskDir, completed.sessionId).includes(FOLLOWUP_PROMPT),
      JSON.stringify({ session: completed.sessionId, files: sessionFiles(intent17.taskDir) }));
    check("t17", "the run's JSONL is still the only session holding both prompts",
      sessionFiles(intent17.taskDir).filter((name) => name.startsWith(String(completed.sessionId))).length === 1,
      JSON.stringify(sessionFiles(intent17.taskDir)));
    await capturePair("t17", "s04-session-continued");
    runsFinal = (await bridgeTask(t17TaskId, "task/scheduleRuns"))?.payload?.runs ?? [];

    } catch (error) {
      // T17 is captured only up to the step that failed; the README lists exactly
      // which states are missing instead of claiming them.
      recordFinding("t17", { id: "t17-capture-incomplete", title: "T17 定时任务界面链路未走完（本次只记录到失败点）",
        expected: "从 S02 创建专属定时任务，S04 编辑/停用/立即运行并回到会话继续",
        observed: String(error).slice(0, 900),
        note: "已捕获 S04 创建表单（定义区与无 Git 交付预览）；未捕获运行记录与会话续接。" });
      await capture("t17", "s04-capture-incomplete", 1440, 900).catch(() => undefined);
    }
    stage = "T17 named save refusals";
    if (t17TaskId) {
    noProvider = await bridgeTask(t17TaskId, "task/scheduleSave", { scheduleId, name: "x", ruleText: "*/1 * * * *", timezone: "UTC",
      prompt: SCHEDULE_PROMPT, providerId: "p-99999999-2222-3333-4444-555555555555", model: MODEL, permission: "read" });
    noModel = await bridgeTask(t17TaskId, "task/scheduleSave", { scheduleId, name: "x", ruleText: "*/1 * * * *", timezone: "UTC",
      prompt: SCHEDULE_PROMPT, providerId: profileId, model: "not-declared", permission: "read" });
    check("t17", "a foreign Provider is refused by name (provider-missing), never substituted",
      noProvider?.ok === false && /provider-missing/.test(String(noProvider.error)), JSON.stringify(noProvider));
    check("t17", "an undeclared model is refused by name (model-not-declared), never substituted",
      noModel?.ok === false && /model-not-declared|model-missing/.test(String(noModel.error)), JSON.stringify(noModel));
    }
    const rejectedRun = { scheduleRefusals: [noProvider?.error, noModel?.error] };
    state = { ...state, scheduleId, runs: runsFinal.map((run) => ({ runId: run.runId, result: run.result, sessionId: run.sessionId })) };
    writeFileSync(statePath, `${JSON.stringify({ ...state, repos }, null, 2)}\n`);
    await writeLogs();
    console.log("T131718_PRIMARY_DONE=" + JSON.stringify({ t13TaskId, t17TaskId, scheduleId,
      assertions: { t13: assertions.t13.length, t17: assertions.t17.length }, shots: { t13: shots.t13.length, t17: shots.t17.length } }));
    void rejectedRun;
    return;

    async function writeLogs() {
      const assetsDir = join(import.meta.dirname, "..", "dist", "renderer", "assets");
      const bundles = readdirSync(assetsDir).filter((name) => /^index-.*\.(js|css)$/.test(name))
        .map((name) => ({ file: `packages/shell/dist/renderer/assets/${name}`, sha256: sha256(readFileSync(join(assetsDir, name))) }));
      let revision = "unknown";
      try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: repoRoot }).trim(); } catch { /* recorded as unknown */ }
      const runtime = { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome,
        platform: process.platform, arch: process.arch };
      const realVsTest = {
        real: ["built React renderer over file://", "production main wiring (createTrustedWindow/registerIpc/ProviderWiring)",
          "real utilityProcess task Host + isolated SDK worker context",
          "real git: bare origins, worktrees, branches, commits, pre-receive hook",
          "real ScheduleDriver / SchedulerGate / QuitReportStore / registerApplicationLifecycle",
          "real Provider protocol + SDK turn + session index", "real task/schedule records on disk"],
        replaced: ["OS keychain cipher → deterministic AES-256-GCM test cipher",
          "real online provider → loopback OpenAI-compatible HTTP server on 127.0.0.1",
          "github.com (or any online remote) → local bare git repositories under the OS temp dir",
          "a real credential challenge → a local HTTP endpoint answering 401", "real ~/.pi/agent → temp PIDOCK_AGENT_DIR"],
        notExercised: ["real online provider account", "github.com push", "Windows", "real OS Keychain encryption"],
      };
      const t13Log = {
        ticket: "#148 T13 分支规范、推送目标与明确 Git 交付 — real Electron evidence",
        command, repoRoot, revision, runtime, bundles, phase, pid: process.pid, realVsTest,
        agentDir: { resolved: agentDir, isTemp: true, realAgentDir },
        project: { projectId: state.projectId, name: PROJECT_NAME,
          repositories: (projects.get(state.projectId)?.repositories ?? []).map((row) => row.name) },
        settings: readJson(join(profile, "git-delivery-settings.json")),
        creation: { taskId: t13TaskId, taskDir: intent13.taskDir, branch: intent13.branch,
          previewRows, repoTargets: intent13.repos.map((repo) => ({ name: repo.name, repoDir: repo.repoDir,
            worktreeBranch: branchFacts[repo.name]?.branch, remote: branchFacts[repo.name]?.remote })),
          record: { workspaceMode: record13?.workspaceMode, branch: record13?.branch } },
        delivery: { planRows, commit: { outcomes: commitOutcomes, summaries: commitSummaries, overall: commitOverall },
          push: { outcomes: pushOutcomes, summaries: pushSummaries, overall: pushOverall, refs: pushedRefs },
          prGuidance: pr, partial: { outcomes: partialOutcomes, overall: partialOverall },
          noChanges: { outcomes: noChangesOutcomes, overall: noChangesOverall },
          failedPushPreservedWorkingTree: { before: withWip, after: ledgerAfterPush } },
        completion: { archive, refsBeforeArchive, refsAfterArchive },
        loopback: { port: providerState.port, authPort: state.authPort, chatRequests: received.filter((row) => String(row.url).endsWith("/chat/completions")).length },
        assertions: assertions.t13, findings: findings.t13, shots: shots.t13,
      };
      const t17Log = {
        ticket: "#152 T17 定时任务真实触发与专属创建 — real Electron evidence",
        command, repoRoot, revision, runtime, bundles, phase, pid: process.pid, realVsTest,
        agentDir: { resolved: agentDir, isTemp: true },
        provider: { profileId, model: MODEL, baseUrl: withPort("/v1"), cipher: "createTestSafeStorage (deterministic AES-256-GCM)" },
        task: { taskId: t17TaskId, taskDir: intent17.taskDir, kind: record17?.kind, workspaceMode: record17?.workspaceMode },
        schedule: { created: saved17, edited: savedEdited, finalList: (await bridgeTask(t17TaskId, "task/scheduleList"))?.payload?.schedules ?? [] },
        runs: { started: startedRun, completed, all: runsFinal, credentialMissing: failedRun },
        sessions: { before: sessionsBefore.map((row) => row.sessionId), after: sessionsAfter.map((row) => row.sessionId),
          files: sessionFiles(intent17.taskDir) },
        jsonl: { runBytes: runJsonl.length, hasSchedulePrompt: runJsonl.includes(SCHEDULE_PROMPT), hasFollowUp: runJsonl.includes(FOLLOWUP_PROMPT) },
        loopback: { port: providerState.port, chatRequests: received.filter((row) => String(row.url).endsWith("/chat/completions"))
          .map((row) => ({ model: row.body.includes(MODEL), authorization: row.authorization === `Bearer ${API_KEY}` ? "Bearer <stored key>" : row.authorization })) },
        refusals: { provider: noProvider, model: noModel },
        assertions: assertions.t17, findings: findings.t17, shots: shots.t17,
      };
      writeFileSync(join(dirs.t13, "capture-log.json"), `${JSON.stringify(t13Log, null, 2)}\n`);
      writeFileSync(join(dirs.t17, "capture-log.json"), `${JSON.stringify(t17Log, null, 2)}\n`);
    }
  } catch (error) {
    console.error(`T131718_CAPTURE_FAILED [${phase}]`, stage, error);
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    try { delete process.env["PIDOCK_AGENT_DIR"]; } catch { /* best effort */ }
    for (const entry of held.splice(0)) {
      try { clearInterval(entry.timer); } catch { /* already cleared */ }
      try { entry.response.end(); } catch { /* already closed */ }
    }
    try {
      const cleanupFailures = await shutdownTestRegistry(registry, {
        origin: views ? { kind: "shell-ui", senderWebContentsId: views.shellView.webContents.id } : undefined,
        label: `PencilV1 T13/T17/T18 capture cleanup (${phase})`,
      });
      if (cleanupFailures.length) console.error(`T131718_CLEANUP_FAILED [${phase}] ` + JSON.stringify(cleanupFailures));
    } catch (error) { console.error("T131718_CLEANUP_ERROR", String(error)); }
    for (const child of children) { try { child.kill(); } catch { /* gone */ } }
    try { if (views?.shellView.webContents.debugger.isAttached()) views.shellView.webContents.debugger.detach(); } catch { /* detached */ }
    try { schedules?.stop(); } catch { /* not started */ }
    try { views?.window.destroy(); } catch { /* destroyed */ }
    try { providerState.server?.close(); } catch { /* closed */ }
    try { providerState.authServer?.close(); } catch { /* closed */ }
    exitNow(process.exitCode ?? 0, "done");
  }
}
void run();
