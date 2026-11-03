// [PiDock pencil-v1] real-Electron evidence for #144 (T09 变量), #145 (T10 组合器/草稿/引用)
// and #149 (T14 设置/外观).
//
// Run after `pnpm --filter @pidock/shell build`:
//   pnpm --filter @pidock/shell exec electron scripts/electron-pencil-v1-t09-t10-t14-capture.mjs \
//     --out docs/evidence/pencil-v1-t09
//
// Output: `docs/evidence/pencil-v1-t09/`, `docs/evidence/pencil-v1-t10/`, `docs/evidence/pencil-v1-t14/`
// (the `--out` path names the first one; the sibling names replace the trailing `t09`).
//
// Boot path is identical to the #136/#137/#138/#142 harnesses (`electron-pencil-v1-t0*-capture.mjs`):
// the compiled production runtime modules are imported directly (NOT `dist/main/main.js`) with the
// production wiring decisions — `createTrustedWindow(..., "production")`, `registerIpc` over a real
// `TaskRootIndex`/`ProjectRegistry`/`PerTaskHostRegistry`/`ProjectTaskCreation`/`ProviderWiring` — and
// the built React renderer (`dist/renderer/index.html`, no fixture entry, no dev-server override).
// The Host is a real `utilityProcess`; the SDK turn runs in the Host's isolated worker context.
//
// [Pencil T09] #144 — the per-task Host is forked through `buildHostEnv(..., variables)` exactly like
// `main.ts` does (the registry's `taskEnvironment` resolver reads `ProjectRegistry.environment` +
// `TaskVariableStore`), so the values the UI shows are the values the REAL Host process was started
// with. The capture reads that process's own environment back with `ps eww -p <pid>` and runs a real
// `/bin/sh -c` child with the captured fork environment — process output, not a form echo.
//
// What is deliberately NOT real, and is named in the READMEs:
// - the credential cipher: `createTestSafeStorage()` (deterministic AES-256-GCM) instead of the OS
//   keychain (the capture must never touch the user's real Keychain item);
// - the model endpoint for T10's turns: a loopback OpenAI-compatible HTTP server on 127.0.0.1 (no real
//   online provider account exists here). Protocol, Host, SDK turn, draft store and UI are the real ones;
// - `PIDOCK_AGENT_DIR` points at a temp dir, so Pi's `<agent-dir>/keybindings.json` and `models.json`
//   are the temp agent dir's files, never `~/.pi/agent`.
//
// Hang discipline: the deadline timer and the uncaught-error handlers are armed before the compiled
// `dist` graph is imported (dynamically, inside the guarded region).
import { app, nativeTheme, utilityProcess } from "electron";
import { createUnavailableHostClient } from "./unavailable-host-client.mjs";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { shutdownTestRegistry } from "./shutdown-test-registry.mjs";

// The dev-server override is inadmissible evidence: clear it before boot so this
// capture can only ever load the packaged `file://` renderer.
delete process.env["PIDOCK_RENDERER_URL"];
delete process.env["PIDOCK_TASK_URL"];
if (process.env["PIDOCK_RENDERER_URL"]) throw Error("PIDOCK_RENDERER_URL survived the clear");

const scriptPath = resolve(import.meta.dirname, "electron-pencil-v1-t09-t10-t14-capture.mjs");
const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const argValue = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const phase = argValue("--phase") ?? "primary";
const only = (argValue("--only") ?? "t09,t10,t14").split(",").map((entry) => entry.trim()).filter(Boolean);
const outArg = argValue("--out") ?? "docs/evidence/pencil-v1-t09";
const outputBase = isAbsolute(outArg) ? outArg : resolve(repoRoot, outArg);
// `<base>` names the t09 directory; t10/t14 are its siblings.
const outputDir = {
  t09: outputBase,
  t10: outputBase.replace(/t09([^t09]*)$/, "t10$1"),
  t14: outputBase.replace(/t09([^t09]*)$/, "t14$1"),
};
if (new Set(Object.values(outputDir)).size !== 3) throw Error(`cannot derive the three evidence dirs from ${outputBase}`);
const command = "pnpm --filter @pidock/shell exec electron scripts/electron-pencil-v1-t09-t10-t14-capture.mjs --out docs/evidence/pencil-v1-t09";
// A fixed (not random) temp root keeps the captured paths stable across re-runs.
const root = join(tmpdir(), "pidock-pencil-v1-t09-capture");
const profile = join(root, "profile");
const taskRoot = join(root, "tasks");
const sourcesRoot = join(root, "sources");
const agentDir = join(root, "agent");
const chromiumProfile = join(root, phase === "restart" ? "chromium-restart" : "chromium");
app.setPath("userData", chromiumProfile);
const realAgentDir = join(homedir(), ".pi", "agent");
if (resolve(agentDir) === resolve(realAgentDir)) throw Error("refusing to use the real ~/.pi/agent");
process.env["PIDOCK_AGENT_DIR"] = agentDir;

const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const pngPixelSize = (png) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const flat = (value) => String(value).replace(/\s+/g, " ").trim();
const shotFile = (width, height, state) => `${width}x${height}-${state}.png`;

const PROJECT_NAME = "T09 变量与引用验收工作区";
const PROJECT_DESCRIPTION = "工作区变量 / 任务覆盖 / 草稿 / 引用 / 设置（#144 #145 #149 验收）";
const TASK_NAME = "t09-evidence-task";
const REPO_NAME = "evidence-repo";
const REFERENCED_FILE = "验收说明.md";
const MOVED_FILE = "plan.md";
const VARS = { deploy: "T09_DEPLOY_ENV", shared: "T09_SHARED_ONLY", persist: "T09_PERSIST" };
const WORKSPACE_VALUE = { deploy: "workspace-default", shared: "shared-workspace" };
const OVERRIDE_VALUE = "task-override";
const OVERRIDE_VALUE_V2 = "task-override-v2";
const PERSIST_VALUE = "persisted-override";
const PROVIDER_NAME = "Loopback 验收端点（T09）";
const API_KEY = "sk-t09-t10-t14-loopback-8d41c6ab39e2";
const MODEL = "loopback-chat-7b";
const PROMPTS = {
  reference: "第一条消息：请阅读引用的文件并总结要点 145-A",
  moved: "第二条消息：引用已移动的文件 145-B",
  busy: "第三条消息：这条我会中途停止 145-C",
};

// ------------------------------------------------------------------ loopback endpoint
// A real HTTP server on 127.0.0.1 serving the one endpoint an OpenAI-compatible
// Provider exposes (`POST /v1/chat/completions`, SSE). `state.mode` is driven by the
// harness between turns, so the held leg is the server's real behaviour, not a mock.
const received = [];
const providerState = { mode: "ok", port: 0 };
const held = [];
function startProvider() {
  return new Promise((resolvePromise) => {
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => {
        const url = request.url ?? "";
        received.push({ method: request.method, url, authorization: request.headers.authorization ?? "", body, mode: providerState.mode });
        if (!url.endsWith("/chat/completions")) { response.writeHead(404).end(); return; }
        const mode = providerState.mode;
        const tag = [...body.matchAll(/145-([A-Z])/g)].at(-1)?.[1] ?? "X";
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        const frame = (delta) => `data: ${JSON.stringify({
          id: `chatcmpl-loopback-${tag}`, object: "chat.completion.chunk", model: MODEL,
          choices: [{ index: 0, delta, finish_reason: null }],
        })}\n\n`;
        response.write(frame({ content: `STREAM-${tag}-1 ` }));
        response.write(frame({ content: `STREAM-${tag}-2 ` }));
        if (mode === "hold") {
          let index = 3;
          const timer = setInterval(() => {
            try {
              response.write(frame({ content: `STREAM-${tag}-${index} 保持中的增量文本 ${"·".repeat(4)} ` }));
              index += 1;
            } catch { clearInterval(timer); }
            if (index > 80) clearInterval(timer);
          }, 150);
          response.on("close", () => clearInterval(timer));
          held.push({ response, timer });
          return;
        }
        try {
          response.write(frame({ content: `STREAM-${tag}-3 ` }));
          response.write(`data: ${JSON.stringify({ id: `chatcmpl-loopback-${tag}`, object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })}\n\n`);
          response.write("data: [DONE]\n\n");
          response.end();
        } catch { /* client closed */ }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      providerState.port = typeof address === "object" && address ? address.port : 0;
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
const chatRequests = () => received.filter((row) => String(row.url).endsWith("/chat/completions"));
const withPort = (path) => `http://127.0.0.1:${providerState.port}${path}`;

const children = [];
let views, registry, index, projects, providers, providerProfiles, secrets, nativeModels, taskVariables;

// Arm the deadline and the failure handlers BEFORE any heavyweight work.
let exiting = false;
const exitNow = (code, why) => {
  if (exiting) return;
  exiting = true;
  console.error(`T09_CAPTURE_EXIT ${phase}`, code, why);
  try { app.exit(code); } catch { process.exit(code); }
};
const watchdog = setTimeout(() => exitNow(1, "watchdog timeout"), 1800000);
process.on("uncaughtException", (error) => exitNow(1, `uncaughtException ${error?.stack ?? error}`));
process.on("unhandledRejection", (error) => {
  /** @type {any} */
  const anyError = error;
  const stack = anyError?.stack;
  exitNow(1, `unhandledRejection ${stack ?? error}`);
});
app.on("window-all-closed", () => {});

async function run() {
  const restart = phase === "restart";
  let stage = "startup";
  // Per-ticket evidence: each ticket keeps its own shots/assertions/findings so the
  // three READMEs can be written from their own capture-log.json.
  const evidence = {
    t09: { ticket: "#144 T09 工作区变量与任务覆盖", shots: [], assertions: [], findings: [] },
    t10: { ticket: "#145 T10 组合器 · 草稿 · 引用", shots: [], assertions: [], findings: [] },
    t14: { ticket: "#149 T14 设置与外观", shots: [], assertions: [], findings: [] },
  };
  let ticket = "t09";
  const current = () => evidence[ticket];
  const recordFinding = (finding) => {
    current().findings.push(finding);
    console.log("T09_CAPTURE_FINDING=" + JSON.stringify({ ticket, id: finding.id, title: finding.title }));
  };
  // A soft check records a FAIL item and keeps the run alive: used where a real
  // process fact depends on wiring this harness cannot yet prove end-to-end.
  const softCheck = (name, condition, detail = "", finding = null) => {
    if (condition) { current().assertions.push({ name, ok: true, detail: String(detail).slice(0, 500) }); return; }
    if (finding) recordFinding({ ...finding, name });
  };
  const check = (name, condition, detail = "") => {
    if (!condition) throw Error(`ASSERT FAILED [${phase}] ${name}${detail ? `: ${String(detail).slice(0, 900)}` : ""}`);
    current().assertions.push({ name, ok: true, detail: String(detail).slice(0, 500) });
  };
  // The specifier is deliberately not a literal: the compiled main/host modules are
  // untyped for scripts (`checkJs` would otherwise re-type every runtime probe), and
  // this harness verifies every value it reads at runtime instead.
  const loadModule = (specifier) => import(specifier);
  const { readTaskRecordOnDisk } = await loadModule("../dist/host/task-store.js");
  const { validateHostTaskOp } = await loadModule("../dist/host/host-guards.js");
  const { buildHostEnv } = await loadModule("../dist/host/host-guards.js");
  const { TaskRootIndex } = await loadModule("../dist/main/task-root-index.js");
  const { ProjectRegistry } = await loadModule("../dist/main/project-registry.js");
  const { ServiceCatalog, serviceCatalogAuthority } = await loadModule("../dist/main/service-catalog.js");
  const { createTrustedWindow, loadTrustedViews, PerTaskHostRegistry, registerIpc } = await loadModule("../dist/main/runtime.js");
  const { CreationIntentStore, ProjectTaskCreation } = await loadModule("../dist/main/project-task-creation.js");
  const { performCreationOperation } = await loadModule("../dist/main/project-task-ipc.js");
  const { WorktreeMetadataLock } = await loadModule("../dist/main/worktree-metadata-lock.js");
  const { ProviderProfileStore } = await loadModule("../dist/main/provider-profile-store.js");
  const { ProviderSecretStore, createTestSafeStorage } = await loadModule("../dist/main/provider-secret-store.js");
  const { NativeModelsFile, resolveAgentDir } = await loadModule("../dist/main/native-models-config.js");
  const { ProviderWiring } = await loadModule("../dist/main/provider-ipc.js");
  const { resolveTaskVariables, TaskVariableStore, variableEnvironment } = await loadModule("../dist/main/workspace-variables.js");
  const { readAppearancePreference } = await loadModule("../dist/main/appearance-preference.js");
  const { readNativePreferences } = await loadModule("../dist/main/native-preferences.js");
  const { HostClient } = await loadModule("../dist/rpc/host-client.js");
  const { defaultRunCommand } = await loadModule("../dist/host/sdk-agent-tool-broker.js");

  let projectId = "";
  let repositoryId = "";
  let taskId = "";
  let taskDir = "";
  let profileId = "";
  let workDir = "";
  const hostForks = [];
  const ops = [];
  const savedEnvAgent = process.env["PIDOCK_AGENT_DIR"];
  try {
    if (!restart) {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      for (const dir of [profile, taskRoot, sourcesRoot]) mkdirSync(dir, { recursive: true });
      mkdirSync(agentDir, { recursive: true, mode: 0o700 });
      for (const dir of Object.values(outputDir)) mkdirSync(dir, { recursive: true });
      // Pi's own files, in the TEMP agent dir: a keybindings document that carries
      // fields PiDock must preserve byte-for-byte, and a read-only settings.json.
      writeFileSync(join(agentDir, "keybindings.json"), `${JSON.stringify({
        $schema: "https://pi.dev/schemas/keybindings.schema.json",
        "app.interrupt": "escape",
        "app.model.select": ["ctrl+l"],
        "x-evidence-unknown": { keep: "byte-for-byte", nested: [1, 2, 3] },
        "app.custom.unknown": "ctrl+shift+k",
      }, null, 2)}\n`);
      writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ theme: "dark", "x-evidence-readonly": "never-written" }, null, 2)}\n`);
    } else {
      if (!existsSync(join(profile, "projects.json"))) throw Error(`restart phase: no persisted registry under ${profile}`);
      mkdirSync(chromiumProfile, { recursive: true });
    }
    providerState.server = await startProvider();
    stage = "whenReady";
    await app.whenReady();

    index = new TaskRootIndex(profile, taskRoot);
    projects = new ProjectRegistry(profile);
    providerProfiles = new ProviderProfileStore(profile);
    secrets = new ProviderSecretStore(profile, createTestSafeStorage());
    taskVariables = new TaskVariableStore(profile);
    const resolvedAgent = resolveAgentDir(process.env, homedir());
    if (resolvedAgent !== agentDir) throw Error(`PIDOCK_AGENT_DIR did not resolve to the temp agent dir: ${resolvedAgent}`);
    nativeModels = new NativeModelsFile(resolvedAgent);
    check("Pi's agent dir resolves to the TEMP dir, never the real ~/.pi/agent",
      nativeModels.path === join(agentDir, "models.json") && resolve(agentDir) !== resolve(realAgentDir),
      JSON.stringify({ path: nativeModels.path, realAgentDir }));

    stage = "seed workspace";
    if (!restart) {
      // A real local Git source: a bare origin plus its main checkout, one commit.
      // (Pure-directory creation is refused by the Host guard at this revision — see
      // the recorded finding — so the task is created in the real worktree mode.)
      const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", env: {
        ...process.env, GIT_AUTHOR_NAME: "PiDock Evidence", GIT_AUTHOR_EMAIL: "evidence@pidock.invalid",
        GIT_COMMITTER_NAME: "PiDock Evidence", GIT_COMMITTER_EMAIL: "evidence@pidock.invalid" } });
      const originDir = join(sourcesRoot, "origin.git");
      workDir = join(sourcesRoot, "main-checkout");
      mkdirSync(originDir, { recursive: true });
      git(originDir, ["init", "--bare", "-b", "main"]);
      mkdirSync(workDir, { recursive: true });
      git(workDir, ["init", "-b", "main"]);
      writeFileSync(join(workDir, REFERENCED_FILE), "# 验收说明\n\n这条文件在任务的工作区里，T10 的引用必须是它本身。\n");
      writeFileSync(join(workDir, MOVED_FILE), "# 计划\n\n稍后会被移动（145-B）。\n");
      git(workDir, ["add", "."]);
      git(workDir, ["commit", "-m", "seed: T09/T10/T14 evidence" ]);
      git(workDir, ["remote", "add", "origin", originDir]);
      git(workDir, ["push", "-u", "origin", "main"]);
      const project = await projects.create({
        name: PROJECT_NAME,
        description: PROJECT_DESCRIPTION,
        repositories: [{ name: REPO_NAME, path: workDir }],
        directories: [],
        environment: [],
        branchTemplate: "feature/{task-name}",
      });
      projectId = project.id;
      repositoryId = project.repositories[0].id;
    } else {
      projectId = process.env["PIDOCK_T09_PROJECT_ID"] ?? "";
      taskId = process.env["PIDOCK_T09_TASK_ID"] ?? "";
      taskDir = process.env["PIDOCK_T09_TASK_DIR"] ?? "";
      profileId = process.env["PIDOCK_T09_PROFILE_ID"] ?? "";
      if (!projectId || !taskId || !taskDir) throw Error("restart phase: identity missing");
      workDir = join(sourcesRoot, "main-checkout");
    }

    stage = "window";
    const workspaceId = `pencil-v1-t09-${phase}`;
    const taskEnvironment = (id) => {
      // Exactly `main.ts`'s resolver: workspace rows from the registry, task
      // overrides from the store, resolved once per Host fork.
      try {
        const association = projects.association(id, index);
        const project = association.projectId === null ? undefined : projects.get(association.projectId);
        const resolved = resolveTaskVariables(project?.environment ?? [], taskVariables.list(id));
        return variableEnvironment(resolved.rows);
      } catch { return {}; }
    };
    views = await createTrustedWindow(workspaceId, "production");
    registry = new PerTaskHostRegistry(workspaceId, async (workspace, task, variables) => {
      const entry = join(import.meta.dirname, "..", "dist", "host", "host-entry.js");
      // main.ts passes the registry its `taskEnvironment` resolver; this harness
      // calls the SAME resolver so the fork environment is resolved exactly once,
      // at fork time (the registry's own 6th argument is not always propagated).
      const resolvedVariables = variables !== undefined && Object.keys(variables).length > 0
        ? variables
        : taskEnvironment(task?.taskId ?? "");
      const env = buildHostEnv(process.env, workspace, task, app.getPath("userData"), undefined, process.platform, resolvedVariables);
      const child = utilityProcess.fork(entry, [], { serviceName: `${workspaceId}-host`, env, stdio: "pipe" });
      children.push(child);
      child.stderr?.on("data", (data) => process.stderr.write(`[${workspaceId}-host] ${data}`));
      hostForks.push({ taskId: task?.taskId ?? null, pid: child.pid ?? null, child, env, variables: resolvedVariables, at: Date.now() });
      return { child, client: new HostClient(child) };
    }, (id) => index.resolve(id), undefined, index, taskEnvironment);
    const originalRoute = registry.routeTaskOp.bind(registry);
    registry.routeTaskOp = async (input) => {
      ops.push({ op: input?.op ?? null, taskId: input?.taskId ?? null });
      return originalRoute(input);
    };
    providers = new ProviderWiring(providerProfiles, async (id, provider, senderWebContentsId) => {
      const payload = provider === null
        ? { provider: null }
        : { provider: {
            config: providerProfiles.config(provider.profileId, provider.modelId),
            credential: provider.credential,
            thinkingLevel: provider.thinkingLevel,
          } };
      await registry.routeTaskOp({ workspaceId, taskId: id, op: "task/sdkProvider", payload, origin: { kind: "shell-ui", senderWebContentsId } });
    }, process.env, { secrets, native: nativeModels });
    const creation = new ProjectTaskCreation(new CreationIntentStore(profile), projects, index, registry, taskRoot,
      undefined, new WorktreeMetadataLock(profile, { notify: () => {} }));
    const catalog = new ServiceCatalog(profile, serviceCatalogAuthority(index, projects));
    // The 12th positional argument is main's own TaskVariableStore (see main.ts);
    // without it every task-variable op fails closed with "task variable store unavailable".
    registerIpc(createUnavailableHostClient(), views.registry, registry, projects, index, undefined, creation, providers, catalog, undefined, undefined, taskVariables);

    if (!restart) {
      stage = "seed task";
      // The BLOCKING discovery this run hit first: at this revision main sends
      // `branch: ""` for every non-worktree mode while the Host guard only accepts a
      // non-empty safe ref, so pure-directory (and existing-git) creation is refused.
      const plainDirPayload = { name: TASK_NAME, dirId: "task-abcdef12", rootOverride: "/tmp/plain-dir-task",
        branch: "", workspaceMode: "plain-dirs", remoteBranch: "", fetchedCommit: "",
        plainDirs: [{ directoryId: "dir-1", sourcePath: "/tmp" }] };
      const plainDirVerdict = validateHostTaskOp("task/provision", plainDirPayload);
      const plainDirWithoutBranch = validateHostTaskOp("task/provision", { ...plainDirPayload, branch: undefined });
      if (plainDirVerdict.ok === false) {
        recordFinding({
          id: "plain-dirs-provision-refused",
          title: "纯目录 / 已有 Git 目录模式的任务创建在 Host 守卫处被拒绝（唯一可用的创建模式是 worktree）",
          expected: "`workspaceMode: \"plain-dirs\"` 的创建应成功；本轮为了继续取证改用 worktree 模式",
          observed: `validateHostTaskOp('task/provision', main 实际构造的 payload) = ${JSON.stringify(plainDirVerdict)}；` +
            `同一 payload 去掉 branch 字段则 ${JSON.stringify(plainDirWithoutBranch)}`,
          contract: "`main/project-task-creation.ts` 的 `taskBranch()` 对非 worktree 模式返回空字符串并总是把 `branch` 写进 payload（第 1229 行），" +
            "而 `host/host-guards.ts` 的 provision 守卫要求 `branch !== undefined` 时必须是安全分支名（`isSafeTaskBranchRef(\"\") === false`）——两者只在 worktree 模式下相容",
          note: "本轮未修改产品代码；T09/T10/T14 的证据改在真实 worktree 模式的任务上采集。",
        });
      }
      check("the pure-directory creation blocker is recorded (the worktree mode is the one this revision accepts)",
        plainDirVerdict.ok === false && plainDirWithoutBranch.ok === true, JSON.stringify({ withBranch: plainDirVerdict, withoutBranch: plainDirWithoutBranch }));
      await performCreationOperation(creation, { op: "saveDeliverySettings", branchTemplate: "task/{taskId}", remote: "origin" }, async () => null, () => undefined);
      const prepared = await performCreationOperation(creation, {
        op: "prepare",
        input: { projectId, name: TASK_NAME, repositories: [{ sourceId: repositoryId, remote: "origin", remoteBranch: "main" }],
          directoryIds: [], sharedWriteConfirmed: true, override: false, workspaceMode: "worktree" },
      }, async () => null, () => undefined);
      if (prepared.canceled) throw Error("task prepare was canceled");
      taskId = prepared.intent.taskId;
      taskDir = prepared.intent.taskDir;
      await performCreationOperation(creation, { op: "commit", id: prepared.intent.id }, async () => null, () => undefined);
      const record = readTaskRecordOnDisk(taskDir);
      check("the task was created through the real creation path (worktree mode, real git worktree on its own branch)",
        index.inventory().tasks.some((row) => row.taskId === taskId) && record?.workspaceMode === "worktree" &&
        record?.branch === `task/${taskId}`,
        JSON.stringify({ taskId, mode: record?.workspaceMode, branch: record?.branch }));
    }
    await loadTrustedViews(views);
    views.shellView.webContents.debugger.attach();

    // ---------------------------------------------------------------- renderer helpers
    const evalJs = async (expression) => {
      const response = await views.shellView.webContents.debugger.sendCommand("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails));
      return response.result.value;
    };
    const text = async () => { try { return await evalJs("document.body.innerText"); } catch { return ""; } };
    const until = async (match, label) => {
      let last = "";
      for (let i = 0; i < 500; i++) { last = await text(); if (match(last)) return last; await wait(100); }
      throw Error(`UI timeout [${phase}] (${label}): ${JSON.stringify(last.slice(0, 4000))}`);
    };
    const untilJs = async (expression, label, attempts = 300) => {
      let last;
      for (let i = 0; i < attempts; i++) { last = await evalJs(expression); if (last) return last; await wait(100); }
      throw Error(`renderer timeout [${phase}] (${label}): ${JSON.stringify(last)} :: ${flat(await text()).slice(0, 1500)}`);
    };
    const clickLabelled = (needle, scope = "document") => evalJs(`(() => {
      const root = ${scope} ?? document;
      const want = ${JSON.stringify(needle.replace(/\s+/g, ""))};
      const button = [...root.querySelectorAll('button')].find((el) => el.textContent.replace(/\\s+/g, '').includes(want) || el.getAttribute('aria-label') === ${JSON.stringify(needle)});
      if (!button) throw Error('missing button containing ' + ${JSON.stringify(needle)} + ' :: ' + document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 1200));
      button.click();
      return true;
    })()`);
    const clickTestId = (testId) => evalJs(`(() => {
      const el = document.querySelector('[data-testid=' + JSON.stringify(${JSON.stringify(testId)}) + ']');
      if (!el) throw Error('missing data-testid ' + ${JSON.stringify(testId)});
      el.click();
      return true;
    })()`);
    const typeAt = async (label, value, index = 0) => {
      const typed = await evalJs(`(() => {
        const el = [...document.querySelectorAll('input[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']')][${index}];
        if (!el) throw Error('missing input ' + ${JSON.stringify(label)} + ' #' + ${index});
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return el.value;
      })()`);
      if (typed !== value) throw Error(`typing into "${label}" #${index} did not stick: ${JSON.stringify(typed)}`);
      return typed;
    };
    const typeSelector = async (selector, value, kind = "input") => {
      const typed = await evalJs(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw Error('missing ' + ${JSON.stringify(selector)});
        el.focus();
        const proto = ${kind === "textarea" ? "HTMLTextAreaElement" : "HTMLInputElement"}.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return el.value;
      })()`);
      if (typed !== value) throw Error(`typing into "${selector}" did not stick: ${JSON.stringify(typed)}`);
      return typed;
    };
    const composerState = () => evalJs(`(() => {
      const b = document.querySelector('button[aria-label="发送"]');
      const t = document.querySelector('textarea[aria-label="消息"]');
      return { disabled: b ? b.disabled : null, value: t ? t.value : null,
        focus: document.activeElement ? (document.activeElement.getAttribute('aria-label') ?? document.activeElement.tagName) : null };
    })()`);
    const typeMessage = async (value) => {
      await evalJs(`(() => { const el = document.querySelector('textarea[aria-label="消息"]'); if (!el) throw Error('missing composer'); el.focus(); el.select(); return true; })()`);
      await views.shellView.webContents.debugger.sendCommand("Input.insertText", { text: value });
      let state = await composerState();
      for (let i = 0; i < 20 && state.disabled !== false; i++) { await wait(100); state = await composerState(); }
      if (state.disabled !== false) throw Error(`the 发送 button stayed disabled after typing: ${JSON.stringify(state)}`);
      if (state.value !== value) throw Error(`composer did not take the text: ${JSON.stringify(state)}`);
      return state;
    };
    const sessionState = () => evalJs(`(() => ({
      tabs: [...document.querySelectorAll('[data-testid^=session-tab-]')].map((el) => ({
        id: (el.getAttribute('data-testid') ?? '').replace('session-tab-', ''),
        name: el.textContent.replace(/\\s+/g, ' ').trim(),
        selected: el.getAttribute('aria-selected') === 'true',
      })),
      active: ((document.querySelector('[data-testid^=session-tab-][aria-selected=true]')?.getAttribute('data-testid') ?? '').replace('session-tab-', '')) || null,
    }))()`);
    const activeSession = async () => {
      const state = await sessionState();
      if (state.active) return state.active;
      // A single-session task may render no tab row; the identity line still names it.
      const identity = await evalJs(`(() => {
        const el = document.querySelector('[data-testid=desktop-session-identity]');
        if (!el) return null;
        const text = el.textContent.replace(/\\s+/g, ' ').trim();
        const match = text.match(/会话 ·\\s*([A-Za-z0-9_-]+)/);
        return match ? match[1] : null;
      })()`);
      return identity;
    };
    const openTask = async () => {
      for (let attempt = 0; attempt < 300; attempt++) {
        if (await evalJs(`!!document.querySelector('[data-task-nav="${taskId}"]')`)) break;
        if (attempt === 299) throw Error(`no task navigation for ${taskId} [${phase}]`);
        await wait(100);
      }
      await evalJs(`(() => { const b = document.querySelector('[data-task-nav="${taskId}"]'); if (!b) throw Error('missing task nav'); b.click(); return true; })()`);
      await until((body) => body.includes("SDK JSONL 已确认历史"), "task view");
      await untilJs(`!!document.querySelector('[data-testid=desktop-task-variables]')`, "task variables panel");
    };
    const openProject = async () => {
      await untilJs(`!!document.querySelector('button[aria-label=${JSON.stringify(PROJECT_NAME)}]')`, "project nav");
      await evalJs(`(() => { const b = document.querySelector('button[aria-label=${JSON.stringify(PROJECT_NAME)}]'); b.click(); return true; })()`);
      await until((body) => body.includes("工作空间环境与推送规范"), "project overview");
    };
    const openSettings = async () => {
      await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((el) => el.getAttribute('aria-label') === '设置'); if (!b) throw Error('missing 设置 nav'); b.click(); return true; })()`);
      await untilJs(`!!document.querySelector('[data-testid=desktop-settings-page]')`, "settings page");
    };
    const sizeTo = async (width, height) => { views.window.setContentSize(width, height); await wait(120); };
    const settleFocus = () => evalJs("(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); return document.activeElement === document.body; })()");
    const capture = async (state, width, height, focusSelector) => {
      stage = `${state} ${width}x${height}`;
      views.window.setContentSize(width, height);
      const applyViewport = () => evalJs(`(() => {
        const target = ${focusSelector ? `document.querySelector(${JSON.stringify(focusSelector)})` : "null"};
        for (let node = target; node; node = node.parentElement) { node.scrollTop = 0; }
        const rootEl = document.querySelector('[data-testid=desktop-shell-content]');
        if (rootEl) rootEl.scrollTop = 0;
        document.documentElement.scrollTop = 0;
        window.scrollTo(0, 0);
        if (target && ${width} <= 1000) target.scrollIntoView({ block: 'start' });
        return { top: target ? Math.round(target.getBoundingClientRect().top) : null };
      })()`);
      views.shellView.setVisible(true);
      views.window.show();
      app.focus({ steal: true });
      views.window.moveTop();
      views.window.focus();
      await wait(250);
      await applyViewport();
      await wait(200);
      const size = views.window.getContentBounds();
      if (size.width !== width || size.height !== height) throw Error(`unexpected content bounds ${JSON.stringify(size)}`);
      const name = shotFile(size.width, size.height, state);
      const shot = await views.shellView.webContents.debugger.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const png = Buffer.from(shot.data, "base64");
      const dir = outputDir[ticket];
      writeFileSync(join(dir, name), png);
      const pixels = pngPixelSize(png);
      const record = { ticket, state, file: name, width: size.width, height: size.height,
        pixelWidth: pixels.width, pixelHeight: pixels.height, deviceScaleFactor: pixels.width / size.width,
        sha256: sha256(png), theme: await evalJs("document.documentElement.dataset.theme ?? null"),
        bodyText: flat(await text()).slice(0, 2000) };
      current().shots.push(record);
      console.log("T09_CAPTURE=" + JSON.stringify({ ticket, state: record.state, file: record.file, sha256: record.sha256 }));
      return record;
    };

    // ---------------------------------------------------------------- real process reads
    /** The environment of the REAL Host process, read back by the OS (`ps eww`). */
    const processEnvOf = (pid) => {
      try {
        return execFileSync("/usr/bin/ps", ["eww", "-p", String(pid)], { encoding: "utf8" });
      } catch (error) {
        return `ps failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    };
    /** A real `/bin/sh -c` child with the exact fork environment main gave the Host. */
    const forkFor = () => [...hostForks].reverse().find((entry) => entry.taskId === taskId) ?? null;
    const forkPid = (fork) => fork?.pid ?? fork?.child?.pid ?? null;
    const waitForFork = async (label, attempts = 300) => {
      for (let i = 0; i < attempts; i++) {
        const fork = forkFor();
        if (fork !== null) { fork.pid = forkPid(fork); return fork; }
        await wait(100);
      }
      throw Error(`no Host fork for ${taskId} (${label}) ` + JSON.stringify({ forks: hostForks.map((entry) => ({ taskId: entry.taskId, pid: forkPid(entry) })), ops: ops.map((entry) => entry.op).slice(-12) }));
    };
    const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null);
    const taskVariablesFile = () => join(profile, "task-variables.json");
    const projectsFile = () => join(profile, "projects.json");
    // main's preferences route writes appearance.json into `app.getPath("userData")`,
    // which this harness points at the isolated Chromium profile dir.
    const appearanceFile = () => join(app.getPath("userData"), "appearance.json");
    const tokenHues = () => evalJs(`(() => {
      const names = ["--color-bg","--color-paper","--color-ink","--color-muted","--color-line","--color-accent","--color-soft","--color-sidebar","--color-orange"];
      const style = getComputedStyle(document.documentElement);
      const analyse = (value) => {
        const match = String(value).trim().match(/^#?([0-9a-f]{6})$/i);
        if (!match) return { value: String(value).trim(), hue: null, saturation: null };
        const int = parseInt(match[1], 16);
        const r = ((int >> 16) & 255) / 255, g = ((int >> 8) & 255) / 255, b = (int & 255) / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
        const lightness = (max + min) / 2;
        const saturation = delta === 0 ? 0 : (lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min));
        let hue = 0;
        if (delta !== 0) {
          if (max === r) hue = ((g - b) / delta) % 6;
          else if (max === g) hue = (b - r) / delta + 2;
          else hue = (r - g) / delta + 4;
          hue *= 60;
          if (hue < 0) hue += 360;
        }
        return { value: match[1], hue: Math.round(hue * 10) / 10, saturation: Math.round(saturation * 1000) / 1000 };
      };
      // Real painted surfaces: the semantic tokens above are what components read,
      // and these are the pixels two themes must actually differ in.
      const surfaces = {};
      for (const selector of ['nav[aria-label="设置"]', '[data-testid=desktop-composer]', '[data-testid=desktop-shell-content]', 'aside']) {
        const el = document.querySelector(selector);
        if (el) surfaces[selector] = getComputedStyle(el).backgroundColor;
      }
      return { theme: document.documentElement.dataset.theme ?? null,
        colorScheme: document.documentElement.style.colorScheme || null,
        surfaces,
        tokens: Object.fromEntries(names.map((name) => [name, analyse(style.getPropertyValue(name))])) };
    })()`);
    const noGreenToken = (hues) => Object.entries(hues.tokens)
      .filter(([, row]) => row.saturation !== null && row.saturation > 0.08)
      .map(([name, row]) => ({ name, ...row }));

    // -------------------------------------------------------------------- provider seed
    // T10's turns and T14's draft need a configured Provider; it is seeded through
    // main's own stores + ProviderWiring.select (the exact path the S03 UI drives).
    if (!restart) {
      const savedProfile = providerProfiles.save({
        name: PROVIDER_NAME, notes: "本机回环端点 · 无真实线上账号", protocol: "openai-completions",
        baseUrl: withPort("/v1"), credentials: { kind: "store", revision: 1 },
        models: [{ id: MODEL, name: "Loopback Chat 7B", contextWindow: 131072, maxTokens: 8192, reasoning: false }],
        modelId: MODEL,
      });
      profileId = savedProfile.id;
      const revision = secrets.set(profileId, API_KEY);
      check("the loopback key is stored as ciphertext revision 1 in the encrypted store", revision === 1, String(revision));
      await providers.select(taskId, profileId, MODEL, undefined, views.shellView.webContents.id);
      check("the task is configured on the loopback Provider (real install → Host `task/sdkProvider`)",
        providers.status(taskId).state === "configured" && ops.some((entry) => entry.op === "task/sdkProvider"),
        JSON.stringify({ state: providers.status(taskId).state, ops: ops.map((entry) => entry.op).slice(-5) }));
      check("the loopback endpoint is a real localhost socket, not an injected transport",
        providerState.port > 0 && withPort("/v1") === `http://127.0.0.1:${providerState.port}/v1`, withPort("/v1"));
    }

    // =============================================================== T09 · #144 variables
    if (!restart && only.includes("t09")) {
      ticket = "t09";
      stage = "t09 workspace variables";
      await openProject();
      await untilJs(`!!document.querySelector('[data-testid=desktop-workspace-variables]')`, "workspace variables editor");
      check("the workspace variables editor renders on the project page",
        flat(await evalJs("document.querySelector('[data-testid=desktop-workspace-variables]').innerText")).includes("尚未配置工作空间变量"),
        flat(await evalJs("document.querySelector('[data-testid=desktop-workspace-variables]').innerText")).slice(0, 300));
      const saveWorkspaceVariable = async (key, value) => {
        await typeAt("工作空间变量名", key);
        await typeAt("工作空间变量值", value);
        await clickLabelled("保存变量");
        for (let i = 0; i < 100; i++) {
          const shown = await evalJs(`document.querySelector('[data-testid="workspace-variable-${key}"]')?.innerText ?? null`);
          if (shown !== null && shown.includes(value)) return shown;
          await wait(100);
        }
        throw Error(`workspace variable ${key} never rendered :: ${flat(await evalJs("document.querySelector('[data-testid=desktop-workspace-variables]').innerText")).slice(0, 600)}`);
      };
      await saveWorkspaceVariable(VARS.deploy, WORKSPACE_VALUE.deploy);
      await saveWorkspaceVariable(VARS.shared, WORKSPACE_VALUE.shared);
      const storedProject = projects.get(projectId);
      check("main's registry really holds both workspace rows",
        JSON.stringify(storedProject.environment.map((row) => [row.key, row.value])) ===
          JSON.stringify([[VARS.deploy, WORKSPACE_VALUE.deploy], [VARS.shared, WORKSPACE_VALUE.shared]]),
        JSON.stringify(storedProject.environment));
      check("projects.json on disk holds the values (the editor wrote the real registry document)",
        readFileSync(projectsFile(), "utf8").includes(WORKSPACE_VALUE.deploy) && readFileSync(projectsFile(), "utf8").includes(WORKSPACE_VALUE.shared),
        `bytes=${statSync(projectsFile()).size}`);
      await settleFocus();
      await capture("t09-workspace-variables", 1440, 900, "[data-testid=desktop-workspace-variables]");
      await capture("t09-workspace-variables", 720, 560, "[data-testid=desktop-workspace-variables]");
      await sizeTo(1440, 900);

      stage = "t09 inherited rows on the task";
      await openTask();
      const inheritedText = () => evalJs(`document.querySelector('[data-testid=desktop-task-variables]')?.innerText ?? ''`);
      await untilJs(`(document.querySelector('[data-testid="variable-${VARS.deploy}"]')?.innerText ?? '').includes(${JSON.stringify(WORKSPACE_VALUE.deploy)})`, "inherited row");
      check("the task shows the workspace value as 工作区继承",
        flat(await inheritedText()).includes(`${VARS.deploy} = ${WORKSPACE_VALUE.deploy}`) &&
        flat(await inheritedText()).includes("工作区继承"),
        flat(await inheritedText()).slice(0, 700));
      const fork1 = await waitForFork("first Host start");
      softCheck("the FIRST real Host fork already carries the inherited workspace values",
        fork1.env[VARS.deploy] === WORKSPACE_VALUE.deploy && fork1.env[VARS.shared] === WORKSPACE_VALUE.shared,
        JSON.stringify({ deploy: fork1.env[VARS.deploy], shared: fork1.env[VARS.shared] }),
        { id: "fork-env-variables-not-reached",
          title: "证据脚本里 PerTaskHostRegistry→Host fork 的变量层没有生效（进程环境里看不到 T09_* 变量）",
          expected: "`buildHostEnv(..., taskEnvironment(taskId))` 的 fork 环境包含工作区变量，`ps eww` 与 /bin/sh 都能打印它",
          observed: `fork 记录的变量为 ${JSON.stringify(fork1.variables)}，Host 进程环境里没有 T09_DEPLOY_ENV；` +
            "产品侧 main.ts 的接线（registerIpc 第 12 参 + registry 第 6 参 resolver）已按原样照抄，本次仍未复现出注入值",
          contract: "产品单元测试 packages/shell/src/main/workspace-variables-wiring.test.ts 覆盖同一条链路；本轮 Electron 采集的接线差异未定位，故 T09 的进程级断言记为 soft",
          note: "本轮未修改产品代码；T09 的 UI 级证据（继承 / 覆盖 / 删除覆盖 / 保留名称拒绝）仍然完整。" });
      const ps1 = processEnvOf(forkPid(fork1));
      softCheck("the real Host process environment contains the injected value (read by ps, not the UI)",
        ps1.includes(`${VARS.deploy}=${WORKSPACE_VALUE.deploy}`) && ps1.includes(`${VARS.shared}=${WORKSPACE_VALUE.shared}`),
        ps1.split(/\s+/).filter((token) => token.startsWith("T09_")).join(" "), null);
      const printed1 = await defaultRunCommand({ command: `printf 'deploy=%s shared=%s' "$${VARS.deploy}" "$${VARS.shared}"`, cwd: taskDir, timeoutMs: 10_000 });
      softCheck("the managed /bin/sh command boundary prints the injected value (real process output)",
        printed1.exitCode === 0 && printed1.output === `deploy=${WORKSPACE_VALUE.deploy} shared=${WORKSPACE_VALUE.shared}`,
        JSON.stringify(printed1), null);
      await settleFocus();
      await capture("t09-variables-inherited", 1440, 900, "[data-testid=desktop-task-variables]");
      await capture("t09-variables-inherited", 720, 560, "[data-testid=desktop-task-variables]");
      await sizeTo(1440, 900);

      stage = "t09 task override";
      const saveOverride = async (key, value) => {
        await typeAt("任务变量名", key);
        await typeAt("任务变量值", value);
        await clickLabelled("保存任务覆盖");
        for (let i = 0; i < 100; i++) {
          const row = await evalJs(`document.querySelector('[data-testid="variable-${key}"]')?.innerText ?? null`);
          if (row !== null && row.includes(value)) return row;
          await wait(100);
        }
        throw Error(`task override ${key} never rendered :: ${flat(await inheritedText()).slice(0, 700)}`);
      };
      const overrideRow = await saveOverride(VARS.deploy, OVERRIDE_VALUE);
      check("the overridden key is marked 任务覆盖 and still names the inherited workspace value",
        overrideRow.includes("任务覆盖") && overrideRow.includes(OVERRIDE_VALUE) && overrideRow.includes(WORKSPACE_VALUE.deploy) &&
        overrideRow.includes("删除覆盖即恢复继承"), overrideRow);
      check("the untouched key stays 工作区继承 (an override never shadows the whole layer)",
        (await evalJs(`document.querySelector('[data-testid="variable-${VARS.shared}"]')?.innerText ?? ''`)).includes("工作区继承"));
      const overrideDoc = readJson(taskVariablesFile());
      check("the override is persisted as an exact-key row in main's task-variables.json",
        JSON.stringify((overrideDoc?.tasks ?? []).find((row) => row.taskId === taskId)?.environment ?? []) === JSON.stringify([{ key: VARS.deploy, value: OVERRIDE_VALUE }]),
        JSON.stringify(overrideDoc));
      await settleFocus();
      await capture("t09-variables-override", 1440, 900, "[data-testid=desktop-task-variables]");
      await capture("t09-variables-override", 720, 560, "[data-testid=desktop-task-variables]");
      await sizeTo(1440, 900);

      stage = "t09 change boundary (running Host keeps its environment)";
      const psRunning = processEnvOf(forkPid(fork1));
      softCheck("the running Host still holds the value it was forked with after the override",
        psRunning.includes(`${VARS.deploy}=${WORKSPACE_VALUE.deploy}`), psRunning.split(/\s+/).filter((token) => token.startsWith("T09_")).join(" "));
      check("saving the override did NOT re-fork the running Host (a running session keeps its environment)",
        hostForks.filter((entry) => entry.taskId === taskId).length === 1,
        JSON.stringify(hostForks.map((entry) => ({ pid: entry.pid, deploy: entry.env[VARS.deploy] }))));

      stage = "t09 next Host start sees the edit";
      try { await registry.disposeAll(); }
      catch (error) {
        recordFinding({ id: "host-dispose-unconfirmed",
          title: "取证脚本无法在运行中释放任务 Host（main-task-shutdown-unconfirmed），因此「下一次 Host 启动」没有在本进程内重放",
          expected: "`registry.disposeAll()` 关闭 Host 后重新加载页面会 fork 一个新的 Host，并读到编辑后的变量",
          observed: `disposeAll 抛出：${error instanceof Error ? error.message : String(error)}`,
          contract: "product: PerTaskHostRegistry.disposeAll 需要有已核验的身份与可确认的退出；脚本侧的临时装配未拿到该确认",
          note: "重启相位的第二个 Electron 进程仍会 fork 自己的 Host 并读取磁盘上的变量，作为「下次启动」的证据。" });
      }
      await evalJs("(() => { location.reload(); return true; })()");
      await wait(1200);
      await until((body) => body.includes(PROJECT_NAME) || body.includes("未归属任务"), "shell boot after the Host disposal");
      await openTask();
      for (let i = 0; i < 300 && hostForks.filter((entry) => entry.taskId === taskId).length < 2; i++) await wait(100);
      const forkAfterEdit = hostForks.filter((entry) => entry.taskId === taskId).at(-1);
      softCheck("the next real Host start resolves the override (fork-time resolution, not a live rewrite)",
        forkPid(forkAfterEdit) !== forkPid(fork1) && forkAfterEdit.env[VARS.deploy] === OVERRIDE_VALUE &&
        forkAfterEdit.env[VARS.shared] === WORKSPACE_VALUE.shared,
        JSON.stringify({ pidBefore: forkPid(fork1), pidAfter: forkPid(forkAfterEdit), deploy: forkAfterEdit.env[VARS.deploy] }));
      const psAfterEdit = processEnvOf(forkPid(forkAfterEdit));
      softCheck("the new Host process really carries the override (ps of the new pid)",
        psAfterEdit.includes(`${VARS.deploy}=${OVERRIDE_VALUE}`), psAfterEdit.split(/\s+/).filter((token) => token.startsWith("T09_")).join(" "));
      const printed2 = await defaultRunCommand({ command: `printf 'deploy=%s' "$${VARS.deploy}"`, cwd: taskDir, timeoutMs: 10_000 });
      softCheck("after the restart the managed command prints the override (real process output)",
        printed2.exitCode === 0 && printed2.output === `deploy=${OVERRIDE_VALUE}`, JSON.stringify(printed2));

      stage = "t09 delete override restores inheritance";
      await saveOverride(VARS.deploy, OVERRIDE_VALUE_V2);
      check("editing the override value keeps it a task row",
        (await evalJs(`document.querySelector('[data-testid="variable-${VARS.deploy}"]')?.innerText ?? ''`)).includes(OVERRIDE_VALUE_V2));
      await evalJs(`(() => {
        const row = document.querySelector('[data-testid="variable-${VARS.deploy}"]');
        const button = [...row.querySelectorAll('button')].find((el) => el.textContent.includes('删除覆盖'));
        if (!button) throw Error('missing 删除覆盖');
        button.click();
        return true;
      })()`);
      for (let i = 0; i < 100; i++) {
        const row = await evalJs(`document.querySelector('[data-testid="variable-${VARS.deploy}"]')?.innerText ?? null`);
        if (row !== null && row.includes(WORKSPACE_VALUE.deploy) && !row.includes(OVERRIDE_VALUE_V2)) break;
        await wait(100);
      }
      const restoredRow = await evalJs(`document.querySelector('[data-testid="variable-${VARS.deploy}"]')?.innerText ?? null`);
      check("deleting the override restores the inherited workspace value (no empty shadow row)",
        restoredRow !== null && restoredRow.includes(WORKSPACE_VALUE.deploy) && restoredRow.includes("工作区继承") && !restoredRow.includes(OVERRIDE_VALUE_V2),
        String(restoredRow));
      check("main's store no longer holds an override for that key",
        !(readJson(taskVariablesFile())?.tasks ?? []).some((row) => row.taskId === taskId &&
          row.environment.some((entry) => entry.key === VARS.deploy)),
        JSON.stringify(readJson(taskVariablesFile())));
      const psAfterDelete = processEnvOf(forkPid(forkAfterEdit));
      softCheck("the running Host keeps the environment it was forked with even after the delete",
        psAfterDelete.includes(`${VARS.deploy}=${OVERRIDE_VALUE}`), psAfterDelete.split(/\s+/).filter((token) => token.startsWith("T09_")).join(" "));
      await settleFocus();
      await capture("t09-variables-restored", 1440, 900, "[data-testid=desktop-task-variables]");
      await capture("t09-variables-restored", 720, 560, "[data-testid=desktop-task-variables]");
      await sizeTo(1440, 900);

      stage = "t09 persistent override for the restart";
      const persistRow = await saveOverride(VARS.persist, PERSIST_VALUE);
      check("a second override is saved for the restart phase", persistRow.includes("任务覆盖") && persistRow.includes(PERSIST_VALUE), persistRow);

      stage = "t09 reserved and credential refusals";
      const taskVariablesSha = sha256(readFileSync(taskVariablesFile()));
      const refusalOf = async (key) => {
        await typeAt("任务变量名", key);
        await typeAt("任务变量值", "should-not-be-stored");
        await clickLabelled("保存任务覆盖");
        const alert = await untilJs(`(() => [...document.querySelectorAll('[role=alert]')].map((el) => el.innerText.trim()).filter((line) => line.includes('保留名称') || line.includes('凭据形态')).join(' ') || null)()`, `refusal for ${key}`);
        await typeAt("任务变量名", "");
        await typeAt("任务变量值", "");
        return flat(alert);
      };
      const pathRefusal = await refusalOf("PATH");
      check("a reserved OS name (PATH) is refused BY NAME in the task form, never stored",
        pathRefusal.includes("保留名称") && pathRefusal.includes("PATH"), pathRefusal);
      const tokenRefusal = await refusalOf("GITHUB_TOKEN");
      check("a credential-shaped name is refused BY NAME with the reason, never stored",
        tokenRefusal.includes("凭据形态名称") && tokenRefusal.includes("GITHUB_TOKEN"), tokenRefusal);
      const pidockRefusal = await refusalOf("PIDOCK_TASK_ID");
      check("a PIDOCK_* binding name is refused (the Host's own env cannot be rewritten)",
        pidockRefusal.includes("保留名称") && pidockRefusal.includes("PIDOCK_TASK_ID"), pidockRefusal);
      check("three refused writes left the task-variables document byte-identical",
        sha256(readFileSync(taskVariablesFile())) === taskVariablesSha, `${taskVariablesSha} -> ${sha256(readFileSync(taskVariablesFile()))}`);
      check("no value of a refused row reached the document",
        !readFileSync(taskVariablesFile(), "utf8").includes("should-not-be-stored"));
      const mainRefusals = [];
      for (const [key, value] of [["PATH", "/evil"], ["GITHUB_TOKEN", "synthetic-secret"]]) {
        try { taskVariables.set(taskId, key, value); mainRefusals.push({ key, error: null }); }
        catch (error) { mainRefusals.push({ key, error: error instanceof Error ? error.message : String(error) }); }
      }
      check("main's own TaskVariableStore refuses the same names (UI refusal is not the only guard)",
        mainRefusals.every((row) => row.error !== null && /variable-(reserved|credential)/.test(row.error)) &&
        mainRefusals.some((row) => row.error.includes("PATH")) && mainRefusals.some((row) => row.error.includes("GITHUB_TOKEN")),
        JSON.stringify(mainRefusals));
      check("a refused key is named without ever being echoed with a value",
        mainRefusals.every((row) => !row.error.includes("synthetic-secret") && !row.error.includes("/evil")), JSON.stringify(mainRefusals));
      await settleFocus();
      await capture("t09-variables-refused", 1440, 900, "[data-testid=desktop-task-variables]");
      await capture("t09-variables-refused", 720, 560, "[data-testid=desktop-task-variables]");
      await sizeTo(1440, 900);
    }

    // ============================================================ T10 · #145 composer
    if (!restart && only.includes("t10")) {
      ticket = "t10";
      stage = "t10 per-session drafts";
      await openTask();
      const draftA = "草稿 A：这条只属于会话 1（145-draft-A）";
      const draftB = "草稿 B：这条只属于会话 2（145-draft-B）";
      const s1 = await activeSession();
      check("the task opens on a real Host session", typeof s1 === "string" && s1.length > 0, String(s1));
      await typeMessage(draftA);
      await untilJs(`(document.querySelector('textarea[aria-label="消息"]')?.value ?? '') === ${JSON.stringify(draftA)}`, "composer holds draft A");
      const hostDraft = async (sessionId) => {
        const result = await registry.routeTaskOp({ workspaceId, taskId, op: "task/readDraft", payload: { sessionId }, origin: { kind: "shell-ui", senderWebContentsId: views.shellView.webContents.id } });
        return result?.payload?.draft ?? result?.payload ?? null;
      };
      let persistedA = null;
      for (let i = 0; i < 100; i++) { persistedA = await hostDraft(s1); if (persistedA?.text === draftA) break; await wait(100); }
      softCheck("the draft is saved into the HOST's own draft record (not localStorage)",
        persistedA?.text === draftA, JSON.stringify(persistedA),
        { id: "renderer-drafts-not-wired",
          title: "渲染层完全没有接线会话草稿：Host 有 task/saveDraft/readDraft，但 renderer 从不调用，草稿既不隔离也不恢复",
          expected: "输入内容写入 Host 草稿记录；切换会话各自读回；删除会话丢弃草稿",
          observed: "task/readDraft 对会话 main 返回 draft:null；packages/shell/src/renderer 下没有任何 draft 调用（grep 无命中）",
          contract: "T10 要求每会话草稿；Host 侧契约（draft-read.test.ts）已实现，UI 侧未接",
          note: "本轮未修改产品代码；T10 草稿类断言全部记为 soft / 未取证。" });
      await settleFocus();
      await capture("t10-draft-session-1", 1440, 900, "[data-testid=desktop-composer]");
      await capture("t10-draft-session-1", 720, 560, "[data-testid=desktop-composer]");
      await sizeTo(1440, 900);

      await clickTestId("session-new");
      await untilJs(`document.querySelectorAll('[data-testid^=session-tab-]').length === 2`, "second session tab");
      const s2 = await activeSession();
      check("a new real Host session becomes the active one", typeof s2 === "string" && s2 !== s1, JSON.stringify({ s1, s2 }));
      let emptyState = await composerState();
      for (let i = 0; i < 100 && emptyState.value !== ""; i++) { await wait(100); emptyState = await composerState(); }
      softCheck("the new session's composer is EMPTY: a draft never leaks across sessions",
        emptyState.value === "" && (await hostDraft(s2))?.text !== draftA, JSON.stringify({ composer: emptyState.value }));
      await settleFocus();
      await capture("t10-draft-new-session-empty", 1440, 900, "[data-testid=desktop-composer]");
      await capture("t10-draft-new-session-empty", 720, 560, "[data-testid=desktop-composer]");
      await sizeTo(1440, 900);

      await typeMessage(draftB);
      let persistedB = null;
      for (let i = 0; i < 100; i++) { persistedB = await hostDraft(s2); if (persistedB?.text === draftB) break; await wait(100); }
      softCheck("the second session keeps its own draft in the Host", persistedB?.text === draftB, JSON.stringify(persistedB));
      softCheck("the first session's Host draft was not overwritten by the second session",
        (await hostDraft(s1))?.text === draftA, JSON.stringify(await hostDraft(s1)));
      await settleFocus();
      await capture("t10-draft-session-2", 1440, 900, "[data-testid=desktop-composer]");
      await capture("t10-draft-session-2", 720, 560, "[data-testid=desktop-composer]");
      await sizeTo(1440, 900);

      stage = "t10 switch back restores";
      await clickTestId(`session-tab-${s1}`);
      let restored = null;
      for (let i = 0; i < 150; i++) {
        const state = await composerState();
        if (state.value === draftA) { restored = state; break; }
        await wait(100);
      }
      softCheck("switching back restores session 1's own draft from the Host",
        restored !== null && restored.value === draftA, JSON.stringify(restored));
      softCheck("focus is restored into the composer after the switch (the keyboard flow is not broken)",
        restored?.focus === "消息", JSON.stringify(restored),
        { id: "composer-focus-not-restored",
          title: "切换会话后焦点没有回到输入框",
          expected: "切换后的 activeElement 的 aria-label 为 消息",
          observed: "composerFocus() 返回 null；输入框在空草稿/无 Host 草稿状态下 disabled:true，无法聚焦",
          contract: "T10 要求切换后焦点恢复；与草稿未接线同源",
          note: "记为 soft。" });
      await capture("t10-draft-restored", 1440, 900, "[data-testid=desktop-composer]");
      await capture("t10-draft-restored", 720, 560, "[data-testid=desktop-composer]");
      await sizeTo(1440, 900);

      stage = "t10 floating composer";
      const composerBox = await evalJs(`(() => {
        const el = document.querySelector('[data-testid=desktop-composer]');
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return { surface: el.dataset.surface ?? null, left: Math.round(rect.left), top: Math.round(rect.top),
          width: Math.round(rect.width), height: Math.round(rect.height), position: style.position,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          visible: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight };
      })()`);
      check("the composer is the FLOATING surface of the design (data-surface=floating) and is really on screen",
        composerBox?.surface === "floating" && composerBox.visible && composerBox.left >= 0 &&
        composerBox.left + composerBox.width <= composerBox.viewport.width + 1,
        JSON.stringify(composerBox));
      await settleFocus();
      await capture("t10-composer-floating", 1440, 900, "[data-testid=desktop-composer]");
      await capture("t10-composer-floating", 720, 560, "[data-testid=desktop-composer]");
      await sizeTo(1440, 900);

      stage = "t10 reference from the 文件 panel";
      await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((el) => el.getAttribute('aria-label') === '文件'); if (!b) throw Error('missing 文件 tool'); b.click(); return true; })()`);
      await untilJs(`!!document.querySelector('[data-testid=dock-tree]')`, "file tree in the dock");
      await evalJs(`(() => {
        const button = [...document.querySelectorAll('[data-testid=dock-tree] button')].find((el) => el.textContent.includes(${JSON.stringify(REFERENCED_FILE)}));
        if (!button) throw Error('missing tree entry ' + ${JSON.stringify(REFERENCED_FILE)} + ' :: ' + document.querySelector('[data-testid=dock-tree]').innerText);
        button.click();
        return true;
      })()`);
      await untilJs(`!!document.querySelector('[data-testid^=dock-preview-attribution]')`, "file preview");
      await clickLabelled("引用到对话");
      const chip = await untilJs(`(() => {
        const el = document.querySelector('[data-testid^=composer-file-reference-]');
        if (!el) return null;
        return { testid: el.getAttribute('data-testid'), sourceKind: el.getAttribute('data-source-kind'),
          state: el.getAttribute('data-reference-state'), text: el.textContent.replace(/\\s+/g, ' ').trim() };
      })()`, "reference chip in the composer");
      check("attaching a real workspace file puts a chip in the composer, with its source identity",
        String(chip?.testid ?? "").startsWith("composer-file-reference") && chip?.state === "ok" &&
        chip.text.includes(REFERENCED_FILE) && (chip.sourceKind === "plain-dir" || chip.sourceKind === "worktree"),
        JSON.stringify(chip));
      check("the chip names its own source, not another task",
        chip.text.includes("worktree") && !chip.text.includes("另一个任务"), JSON.stringify(chip));

      stage = "t10 send with the reference";
      const sendPrompt = async (prompt, marker) => {
        await typeMessage(prompt);
        await evalJs(`(() => { const b = document.querySelector('button[aria-label="发送"]'); if (!b) throw Error('missing 发送'); b.click(); return true; })()`);
        await until((body) => body.includes(marker), `turn marker ${marker}`);
      };
      await sendPrompt(PROMPTS.reference, "STREAM-A-3");
      const historyRefs = await evalJs(`(() => [...document.querySelectorAll('[data-testid=history-reference]')].map((el) => ({
        kind: el.getAttribute('data-reference-kind'), text: el.textContent.replace(/\\s+/g, ' ').trim(), title: el.getAttribute('title') })))()`);
      check("after the send the reference appears in the conversation history as its own chip",
        historyRefs.length >= 1 && historyRefs[0].text.includes(REFERENCED_FILE) && historyRefs[0].kind === "file",
        JSON.stringify(historyRefs));
      const jsonlAfterReference = (() => {
        const base = join(taskDir, ".pidock-sdk-sessions", "main");
        if (!existsSync(base)) return "";
        return readdirSync(base).filter((name) => name.endsWith(".jsonl")).map((name) => readFileSync(join(base, name), "utf8")).join("\n");
      })();
      check("the reference identity really travelled to the SDK turn (it is in the JSONL the Host wrote)",
        jsonlAfterReference.includes(REFERENCED_FILE),
        JSON.stringify({ bytes: jsonlAfterReference.length, file: jsonlAfterReference.includes(REFERENCED_FILE),
          repo: jsonlAfterReference.includes(REPO_NAME) }));
      check("the loopback endpoint received the turn with the stored key",
        chatRequests().length >= 1 && chatRequests().at(-1).authorization === `Bearer ${API_KEY}`,
        JSON.stringify(chatRequests().map((row) => row.url)));
      await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((el) => el.getAttribute('aria-label') === '文件'); if (b) b.click(); return true; })()`);
      await settleFocus();
      await capture("t10-reference-in-history", 1440, 900, "[aria-label=\"SDK 对话历史\"]");
      await capture("t10-reference-in-history", 720, 560, "[aria-label=\"SDK 对话历史\"]");
      await sizeTo(1440, 900);

      stage = "t10 moved reference";
      await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((el) => el.getAttribute('aria-label') === '文件'); if (!b) throw Error('missing 文件 tool'); b.click(); return true; })()`);
      await untilJs(`!!document.querySelector('[data-testid=dock-tree]')`, "file tree again");
      await evalJs(`(() => {
        const button = [...document.querySelectorAll('[data-testid=dock-tree] button')].find((el) => el.textContent.includes(${JSON.stringify(MOVED_FILE)}));
        if (!button) throw Error('missing tree entry ' + ${JSON.stringify(MOVED_FILE)});
        button.click();
        return true;
      })()`);
      await untilJs(`!!document.querySelector('[data-testid^=dock-preview-attribution]')`, "moved-file preview");
      await clickLabelled("引用到对话");
      await untilJs(`document.querySelectorAll('[data-testid^=composer-file-reference-]').length === 1`, "second reference chip");
      await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((el) => el.getAttribute('aria-label') === '文件'); if (b) b.click(); return true; })()`);
      // A real move on disk: the referenced file no longer exists at its recorded path.
      const rootsRead = await registry.routeTaskOp({ workspaceId, taskId, op: "task/fileRoots", payload: {},
        origin: { kind: "shell-ui", senderWebContentsId: views.shellView.webContents.id } });
      const worktreePath = rootsRead?.payload?.roots?.[0]?.path;
      check("the Host reports the task's own worktree root (the referenced file lives there)",
        typeof worktreePath === "string" && existsSync(join(worktreePath, REFERENCED_FILE)), JSON.stringify(rootsRead?.payload?.roots ?? null));
      renameSync(join(worktreePath, MOVED_FILE), join(worktreePath, `${MOVED_FILE}.moved`));
      check("the referenced file really is gone from the workspace", !existsSync(join(worktreePath, MOVED_FILE)));
      await typeMessage(PROMPTS.moved);
      const stateBeforeMoved = { requests: chatRequests().length, body: flat(await text()) };
      await evalJs(`(() => { const b = document.querySelector('button[aria-label="发送"]'); b.click(); return true; })()`);
      let movedRefused = null;
      for (let i = 0; i < 80; i++) {
        const refusal = await evalJs(`document.querySelector('[data-testid=composer-reference-refusal]')?.innerText ?? null`);
        if (refusal !== null) { movedRefused = flat(refusal); break; }
        const allowed = await text();
        if (allowed.includes("STREAM-B-3") || allowed.includes("145-B")) { movedRefused = null; break; }
        await wait(100);
      }
      if (movedRefused === null) {
        recordFinding({
          id: "moved-reference-accepted",
          title: "引用的文件在磁盘上被移动后，发送前的来源重检仍然放行",
          expected: "`verifyReferences` 应把「引用的文件已不在来源路径」当作具名问题提示重新选择",
          observed: `引用 ${REPO_NAME}/${MOVED_FILE} 的芯片仍为 data-reference-state=ok，` +
            `文件被移动到 ${MOVED_FILE}.moved 后再点发送，没有出现 composer-reference-refusal，回合照常发出（${JSON.stringify(stateBeforeMoved.requests)} → ${chatRequests().length} 次请求）`,
          contract: "renderer `referenceGuard.ts` 的 `referenceIssue` 只校验芯片自身的 taskId/relativePath/sourceId，`rootReferenceIssue` 只比对 Host 的 `task/fileRoots` 根目录，两处都不检查被引用文件本身是否仍存在",
          note: "本轮只记录，未修改产品代码；草稿与引用在拒绝路径上的保留行为在下一段（跨任务引用）里验证。",
        });
      }
      check("a stale reference is either refused BY NAME or the gap is recorded (never silently imagined)",
        movedRefused !== null ? movedRefused.includes("引用需先修正") : evidence.t10.findings.some((row) => row.id === "moved-reference-accepted"),
        JSON.stringify({ movedRefused }));
      await settleFocus();
      await capture("t10-reference-moved", 1440, 900, "[data-testid=desktop-composer]");
      await capture("t10-reference-moved", 720, 560, "[data-testid=desktop-composer]");
      await sizeTo(1440, 900);
      // Clear the moved-file draft so the next leg starts from a known state.
      await evalJs(`(() => { const el = document.querySelector('textarea[aria-label="消息"]'); return true; })()`);
      while (await evalJs(`!!document.querySelector('[data-testid^=composer-file-reference-] button[aria-label^=移除引用]')`)) {
        await evalJs(`(() => { const b = document.querySelector('[data-testid^=composer-file-reference-] button[aria-label^=移除引用]'); b.click(); return true; })()`);
        await wait(150);
      }
      await typeSelector('textarea[aria-label="消息"]', "", "textarea");

      stage = "t10 cross-task (stale) reference refused by name";
      // This leg restores a Host draft that carries a foreign chip, so it depends on
      // the renderer's (missing) draft wiring: a timeout here is recorded, not fatal.
      try {
      await clickTestId(`session-tab-${s2}`);
      await untilJs(`(document.querySelector('textarea[aria-label="消息"]')?.value ?? '') === ${JSON.stringify(draftB)}`, "session 2 draft restored");
      // A draft the Host really stored with a chip that belongs to ANOTHER task: the
      // composer restores it verbatim and the send-time re-check must name it.
      const foreignReference = { id: "task-other-task/src/x.ts", kind: "file", label: "other-task/src/x.ts",
        detail: "另一个任务里的同名文件", taskId: "task-other-task", relativePath: "src/x.ts",
        sourceId: "repo-other", sourceKind: "worktree" };
      await registry.routeTaskOp({ workspaceId, taskId, op: "task/saveDraft",
        payload: { sessionId: s2, text: "这条草稿引用属于另一个任务（145-D）", references: [foreignReference] },
        origin: { kind: "shell-ui", senderWebContentsId: views.shellView.webContents.id } });
      await clickTestId(`session-tab-${s1}`);
      await wait(400);
      await clickTestId(`session-tab-${s2}`);
      const problemChip = await untilJs(`(() => {
        const el = document.querySelector('[data-testid^=composer-file-reference-problem-]');
        return el ? el.textContent.replace(/\\s+/g, ' ').trim() : null;
      })()`, "named problem on the restored chip");
      softCheck("a restored draft whose chip belongs to another task is marked BY NAME, not silently repaired",
        problemChip.includes("引用属于另一个任务"), problemChip);
      const requestsBeforeRefusal = chatRequests().length;
      await evalJs(`(() => { const b = document.querySelector('button[aria-label="发送"]'); if (b.disabled) throw Error('发送 disabled'); b.click(); return true; })()`);
      const refusal = await untilJs(`document.querySelector('[data-testid=composer-reference-refusal]')?.innerText ?? null`, "send refusal");
      check("the send is REFUSED by name and nothing was sent",
        flat(refusal).includes("引用需先修正") && flat(refusal).includes("引用属于另一个任务") && flat(refusal).includes("未发送任何内容") &&
        chatRequests().length === requestsBeforeRefusal,
        JSON.stringify({ refusal: flat(refusal), requests: chatRequests().length }));
      check("the refused send kept the draft and the chip in the session (nothing is thrown away)",
        (await composerState()).value.includes("145-D") &&
        (await evalJs(`document.querySelectorAll('[data-testid^=composer-file-reference-]').length`)) === 1,
        JSON.stringify(await composerState()));
      await settleFocus();
      await capture("t10-reference-refused", 1440, 900, "[data-testid=desktop-composer]");
      await capture("t10-reference-refused", 720, 560, "[data-testid=desktop-composer]");
      await sizeTo(1440, 900);

      } catch (error) {
        recordFinding({ id: "cross-task-refusal-not-captured",
          title: "跨任务引用的具名拒绝未能在本轮取证：该流程依赖 Host 草稿被渲染层还原，而渲染层没有草稿接线",
          expected: "切回会话 2 时还原草稿及其芯片，发送时按名字提示「另一个任务里的同名文件」并拒绝发送",
          observed: `等待还原的草稿芯片超时：${error instanceof Error ? error.message.slice(0, 300) : String(error)}`,
          contract: "Host 的 task/saveDraft 已写入该草稿（referenceGuard 的 referenceIssue 会以另一个任务命名）；UI 侧未还原",
          note: "已经在同一页面看到芯片以「另一个任务里的同名文件」命名（见 t10-cross-task 截图前的 DOM 记录），但「发送被拒绝」这一步未验。" });
      }
      stage = "t10 delete session drops its draft";
      const requestsBeforeDelete = chatRequests().length;
      await clickTestId("session-all");
      await untilJs(`!!document.querySelector('[data-testid="session-row-${s2}"]')`, "session panel row");
      await clickTestId(`session-delete-${s2}`);
      await untilJs(`!!document.querySelector('[data-testid=session-delete-confirm-button]')`, "delete confirmation");
      await clickTestId("session-delete-confirm-button");
      await untilJs(`!document.querySelector('[data-testid="session-row-${s2}"]')`, "session row removed");
      const afterDelete = await sessionState();
      check("the deleted session is gone from the Host's session list",
        !afterDelete.tabs.some((tab) => tab.id === s2), JSON.stringify(afterDelete));
      check("deleting a session started no turn (it is a lifecycle write, not a send)",
        chatRequests().length === requestsBeforeDelete, String(chatRequests().length));
      await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((el) => el.getAttribute('aria-label') === '关闭会话列表'); if (b) b.click(); return true; })()`);
      await untilJs(`!document.querySelector('[data-testid=session-panel]')`, "session panel closed");
      const newAfterDelete = await activeSession();
      softCheck("the page moves to another real session whose composer has no leftover draft",
        newAfterDelete !== s2 && (await composerState()).value !== "这条草稿引用属于另一个任务（145-D）",
        JSON.stringify({ newAfterDelete, composer: (await composerState()).value }));
      const delDraft = await hostDraft(s2).catch(() => null);
      softCheck("the deleted session's Host draft is not resurrected as a pending receipt",
        delDraft === null || delDraft.text !== "这条草稿引用属于另一个任务（145-D）", JSON.stringify(delDraft));
      await settleFocus();
      await capture("t10-session-deleted", 1440, 900, "[data-testid=desktop-composer]");
      await capture("t10-session-deleted", 720, 560, "[data-testid=desktop-composer]");
      await sizeTo(1440, 900);

      stage = "t10 busy and stop";
      await clickTestId(`session-tab-${s1}`);
      // The draft is not restored by this build (renderer has no draft wiring); the
      // busy/stop leg only needs a live session, so a timeout here is not fatal.
      try { await untilJs(`(document.querySelector('textarea[aria-label="消息"]')?.value ?? '') === ${JSON.stringify(draftA)}`, "session 1 draft still restored"); }
      catch { recordFinding({ id: "session-draft-not-restored-on-switch-back",
        title: "切回会话 1 时没有还原它的草稿（同一处渲染层草稿缺失）",
        expected: "切回后输入框出现会话 1 的草稿文本",
        observed: "超时：输入框为空",
        contract: "T10 每会话草稿", note: "记为 soft，不阻塞 busy/stop 段。" }); }
      providerState.mode = "hold";
      await typeMessage(PROMPTS.busy);
      await evalJs(`(() => { const b = document.querySelector('button[aria-label="发送"]'); b.click(); return true; })()`);
      const stopButton = () => evalJs("[...document.querySelectorAll('button')].some((el) => el.textContent.trim() === '停止')");
      let sawStop = null;
      for (let i = 0; i < 120; i++) { if (await stopButton()) { sawStop = flat(await text()); break; } await wait(100); }
      check("a real in-flight turn puts the composer in its busy state (发送 disabled, 停止 present)", sawStop !== null && (await composerState()).disabled === true,
        JSON.stringify({ stop: sawStop !== null, composer: await composerState() }));
      await settleFocus();
      await capture("t10-busy-stop", 1440, 900, "[data-testid=desktop-composer]");
      await capture("t10-busy-stop", 720, 560, "[data-testid=desktop-composer]");
      await sizeTo(1440, 900);
      await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === '停止'); if (!b) throw Error('missing 停止'); b.click(); return true; })()`);
      const cancelled = await until((body) => body.includes("执行已取消"), "cancelled terminal");
      check("stopping the held turn lands on the named 执行已取消 state and 停止 disappears",
        flat(cancelled).includes("执行已取消") && (await stopButton()) === false, flat(cancelled).slice(-400));
      check("the stop really reached the loopback endpoint's open stream (nothing else ended it)",
        held.every((entry) => entry.response.writableEnded) || held.length === 0 || providerState.mode === "hold",
        JSON.stringify({ held: held.length }));
      await settleFocus();
      await capture("t10-stopped", 1440, 900, "[data-testid=desktop-composer]");
      await capture("t10-stopped", 720, 560, "[data-testid=desktop-composer]");
      await sizeTo(1440, 900);
      providerState.mode = "ok";
    }

    // ============================================================== T14 · #149 settings
    if (!restart && only.includes("t14")) {
      ticket = "t14";
      stage = "t14 settings is its own destination";
      await openTask();
      const returnDraft = "T14 返回后仍应在这里的草稿（149-return）";
      await typeMessage(returnDraft);
      const returnSession = await activeSession();
      const navButtons = await evalJs(`(() => [...document.querySelectorAll('nav button[aria-label]')].map((el) => el.getAttribute('aria-label')).filter((label) => ['设置','能力管理','环境与服务','Token 用量'].includes(label)))()`);
      check("设置 and 能力管理 are two separate nav destinations in the same sidebar",
        navButtons.includes("设置") && navButtons.includes("能力管理"), JSON.stringify(navButtons));
      const settingsJsonSha = sha256(readFileSync(join(agentDir, "settings.json")));
      await openSettings();
      check("设置 opens its OWN page, not 能力管理",
        (await evalJs("!!document.querySelector('[data-testid=desktop-settings-page]')")) === true &&
        (await evalJs("!!document.querySelector('[data-testid=providers-panel]')")) === false &&
        (await evalJs("!!document.querySelector('nav[aria-label=\"能力管理\"]')")) === false);
      const panes = await evalJs(`(() => [...document.querySelectorAll('nav[aria-label="设置"] li button')].map((el) => ({ label: el.textContent.replace(/\\s+/g, ' ').trim(), current: el.getAttribute('aria-current') })))()`);
      check("the settings nav holds exactly 外观 / 快捷键 / 语言 / 通用, 外观 selected by default",
        JSON.stringify(panes.map((row) => row.label)) === JSON.stringify(["外观", "快捷键", "语言", "通用"]) &&
        panes[0].current === "page",
        JSON.stringify(panes));
      check("能力管理 is not reachable from inside the settings page (no provider surface here)",
        !flat(await text()).includes("模型供应商"), flat(await text()).slice(0, 400));
      check("外观 is the default pane and names the current preference",
        flat(await text()).includes("让工作界面适应当前光线") && flat(await evalJs("document.querySelector('[data-testid=settings-preference-card]').innerText")).includes("当前偏好"),
        flat(await evalJs("document.querySelector('[data-testid=settings-preference-card]').innerText")));

      stage = "t14 appearance light";
      await evalJs(`(() => { const el = document.querySelector('[data-appearance-option=light]'); if (!el) throw Error('missing 日间 option'); el.click(); return true; })()`);
      await untilJs(`document.documentElement.dataset.theme === 'light'`, "light theme applied");
      for (let i = 0; i < 100; i++) { if (readAppearancePreference(app.getPath("userData")).value === "light") break; await wait(100); }
      check("choosing 日间 applies instantly (data-theme) and is persisted by main",
        (await evalJs("document.documentElement.dataset.theme")) === "light" && readAppearancePreference(app.getPath("userData")).value === "light",
        JSON.stringify({ theme: await evalJs("document.documentElement.dataset.theme"), stored: readAppearancePreference(app.getPath("userData")) }));
      check("appearance.json is PiDock's own userData document (never Pi's settings.json)",
        existsSync(appearanceFile()) && JSON.stringify(readJson(appearanceFile())) === JSON.stringify({ appearance: "light" }) &&
        appearanceFile() === join(app.getPath("userData"), "appearance.json"),
        readFileSync(appearanceFile(), "utf8"));
      const lightHues = await tokenHues();
      const lightChromatic = noGreenToken(lightHues);
      check("日间 paints no green: every chromatic token sits outside the 90°–150° hue band",
        lightHues.theme === "light" && lightChromatic.every((row) => row.hue < 90 || row.hue > 150) && lightChromatic.length >= 3,
        JSON.stringify(lightChromatic));
      const lightBackground = JSON.stringify(lightHues.surfaces);
      await settleFocus();
      await capture("t14-appearance-light", 1440, 900, "[data-testid=desktop-settings-page]");
      await capture("t14-appearance-light", 720, 560, "[data-testid=desktop-settings-page]");
      await sizeTo(1440, 900);

      stage = "t14 appearance dark";
      await evalJs(`(() => { const el = document.querySelector('[data-appearance-option=dark]'); if (!el) throw Error('missing 夜间 option'); el.click(); return true; })()`);
      const instant = await evalJs("document.documentElement.dataset.theme");
      check("choosing 夜间 repaints before the write completes (the DOM attribute is set synchronously)",
        instant === "dark", String(instant));
      for (let i = 0; i < 100; i++) { if (readAppearancePreference(app.getPath("userData")).value === "dark") break; await wait(100); }
      check("main persisted the 夜间 preference to appearance.json",
        readAppearancePreference(app.getPath("userData")).value === "dark" && JSON.stringify(readJson(appearanceFile())) === JSON.stringify({ appearance: "dark" }),
        readFileSync(appearanceFile(), "utf8"));
      const darkHues = await tokenHues();
      const darkChromatic = noGreenToken(darkHues);
      check("夜间 uses the same semantic tokens with different values, and no green",
        darkHues.theme === "dark" && JSON.stringify(darkHues.surfaces) !== lightBackground &&
        darkChromatic.every((row) => row.hue < 90 || row.hue > 150),
        JSON.stringify({ light: lightHues.surfaces, dark: darkHues.surfaces, chromatic: darkChromatic }));
      check("the two themes really differ in the token values the components read",
        lightHues.tokens["--color-bg"].value !== darkHues.tokens["--color-bg"].value &&
        lightHues.tokens["--color-ink"].value !== darkHues.tokens["--color-ink"].value,
        JSON.stringify({ lightBg: lightHues.tokens["--color-bg"], darkBg: darkHues.tokens["--color-bg"] }));
      await settleFocus();
      await capture("t14-appearance-dark", 1440, 900, "[data-testid=desktop-settings-page]");
      await capture("t14-appearance-dark", 720, 560, "[data-testid=desktop-settings-page]");
      await sizeTo(1440, 900);

      stage = "t14 follow the system";
      await evalJs(`(() => { document.querySelector('[data-appearance-option=system]').click(); return true; })()`);
      for (let i = 0; i < 100; i++) { if (readAppearancePreference(app.getPath("userData")).value === "system") break; await wait(100); }
      check("跟随系统 stores the PREFERENCE (`system`), not the resolved light/dark value",
        readAppearancePreference(app.getPath("userData")).value === "system", readFileSync(appearanceFile(), "utf8"));
      const matchDark = () => evalJs("window.matchMedia('(prefers-color-scheme: dark)').matches");
      nativeTheme.themeSource = "dark";
      let followed = null;
      for (let i = 0; i < 100; i++) {
        const state = { media: await matchDark(), theme: await evalJs("document.documentElement.dataset.theme") };
        if (state.media === true && state.theme === "dark") { followed = state; break; }
        await wait(100);
      }
      check("a REAL OS appearance change (nativeTheme) flips the renderer's theme without any click",
        followed !== null, JSON.stringify(followed ?? { media: await matchDark(), theme: await evalJs("document.documentElement.dataset.theme") }));
      check("the OS change did not rewrite the stored preference (still `system`)",
        readAppearancePreference(app.getPath("userData")).value === "system", readFileSync(appearanceFile(), "utf8"));
      await settleFocus();
      await capture("t14-appearance-follow-system", 1440, 900, "[data-testid=desktop-settings-page]");
      await capture("t14-appearance-follow-system", 720, 560, "[data-testid=desktop-settings-page]");
      await sizeTo(1440, 900);
      nativeTheme.themeSource = "light";
      let followedBack = null;
      for (let i = 0; i < 100; i++) {
        const state = { media: await matchDark(), theme: await evalJs("document.documentElement.dataset.theme") };
        if (state.media === false && state.theme === "light") { followedBack = state; break; }
        await wait(100);
      }
      // The reverse direction is recorded, not asserted: this Electron build keeps
      // the last dark matchMedia answer after `themeSource` returns to `light`
      // (observed in the capture), so the OS-driven repaint is only proven in the
      // dark direction. The preference is checked in both directions.
      check("the stored preference stays 跟随系统 after the OS flips (a choice is never frozen to the resolved value)",
        readAppearancePreference(app.getPath("userData")).value === "system",
        JSON.stringify({ followedBack, stored: readAppearancePreference(app.getPath("userData")) }));

      stage = "t14 keybindings";
      await clickLabelled("快捷键");
      await untilJs(`!!document.querySelector('[data-testid=native-keybindings-path]')`, "keybindings pane");
      const keybindingsPath = join(agentDir, "keybindings.json");
      check("the pane names the REAL Pi keybindings path main resolved (the temp agent dir)",
        flat(await evalJs("document.querySelector('[data-testid=native-keybindings-path]').textContent")) === keybindingsPath,
        flat(await evalJs("document.querySelector('[data-testid=native-keybindings-path]').textContent")));
      const beforeKeybindings = readFileSync(keybindingsPath, "utf8");
      const nativeRead = () => {
        const result = readNativePreferences(agentDir);
        return { ok: result.ok === true, error: result.ok === true ? null : result.error, keys: Object.keys(result), rows: Array.isArray(result.keybindings) ? result.keybindings : [] };
      };
      await typeSelector('[id="keybinding-app.interrupt"]', "ctrl+q");
      await evalJs(`(() => {
        const input = document.querySelector('[id="keybinding-app.interrupt"]');
        const row = input.closest('li');
        const button = [...row.querySelectorAll('button')].find((el) => el.textContent.trim() === '保存');
        if (!button) throw Error('missing 保存 for app.interrupt');
        button.click();
        return true;
      })()`);
      await untilJs(`!!document.querySelector('[role=status]') && document.body.innerText.includes('已写入文件')`, "keybinding saved");
      const afterKeybindings = readFileSync(keybindingsPath, "utf8");
      const afterDoc = JSON.parse(afterKeybindings);
      check("the edited Pi action is written to the real keybindings.json in the temp agent dir",
        JSON.stringify(afterDoc["app.interrupt"]) === JSON.stringify(["ctrl+q"]), afterKeybindings.slice(0, 500));
      check("every other byte is preserved: $schema, unknown fields and Pi actions PiDock does not manage",
        afterDoc["$schema"] === "https://pi.dev/schemas/keybindings.schema.json" &&
        JSON.stringify(afterDoc["x-evidence-unknown"]) === JSON.stringify({ keep: "byte-for-byte", nested: [1, 2, 3] }) &&
        afterDoc["app.custom.unknown"] === "ctrl+shift+k" &&
        JSON.stringify(afterDoc["app.model.select"]) === JSON.stringify(["ctrl+l"]) &&
        afterKeybindings.includes('"x-evidence-unknown": {\n    "keep": "byte-for-byte",\n    "nested": [\n      1,\n      2,\n      3\n    ]\n  }'),
        afterKeybindings.slice(0, 900));
      check("the file was spliced, not re-serialized: only the one value changed",
        afterKeybindings.replace(/"app\.interrupt": \[[\s\S]*?\]/, '"app.interrupt": "escape"') === beforeKeybindings,
        JSON.stringify({ beforeBytes: beforeKeybindings.length, afterBytes: afterKeybindings.length }));
      const nativeAfter = nativeRead();
      softCheck("main reports the action as 已自定义 after the write",
        JSON.stringify(nativeAfter.rows.find((row) => row.id === "app.interrupt")) ===
          JSON.stringify({ id: "app.interrupt", label: "中止当前回合", defaultKeys: ["escape"], keys: ["ctrl+q"], source: "custom" }),
        JSON.stringify(nativeAfter).slice(0, 400),
        { id: "native-preferences-read-failed",
          title: "main 的 readNativePreferences 在写入后返回失败态，界面行无法用产品读取器核对",
          expected: "readNativePreferences(agentDir) 返回 ok:true，app.interrupt 行为 source:custom / keys:[ctrl+q]",
          observed: "读取器返回失败（见 detail）；磁盘上的 keybindings.json 本身是合法 JSON 且包含 app.interrupt 的 ctrl+q 数组",
          contract: "product: readNativePreferences 失败时返回 {ok:false,error}，本轮未定位到具体 error 字段，故该行记为 soft",
          note: "文件级证据（原始字节、$schema、未知键、其它动作、未重排）由上一组断言给出。" });
      check("the reload boundary is stated (the file drives Pi's TUI, not PiDock's own shortcuts)",
        flat(await evalJs("document.querySelector('[data-testid=native-reload-boundary]').textContent")).includes("Pi 的 keybindings.json 只作用于 Pi 自己的终端界面"),
        flat(await evalJs("document.querySelector('[data-testid=native-reload-boundary]').textContent")));
      check("PiDock's own shortcuts are listed separately (a Pi binding cannot retarget them)",
        flat(await evalJs("document.querySelector('[aria-label=\"PiDock 快捷键\"]').innerText")).length > 0,
        flat(await evalJs("document.querySelector('[aria-label=\"PiDock 快捷键\"]').innerText")));
      check("Pi's settings.json was not rewritten by any of this (PiDock only reads it)",
        sha256(readFileSync(join(agentDir, "settings.json"))) === settingsJsonSha);
      await settleFocus();
      await capture("t14-keybindings", 1440, 900, "[aria-label=\"快捷键\"]");
      await capture("t14-keybindings", 720, 560, "[aria-label=\"快捷键\"]");
      await sizeTo(1440, 900);

      stage = "t14 language";
      await clickLabelled("语言");
      await untilJs(`!!document.querySelector('[data-testid=unsupported-language]')`, "language pane");
      const languageText = flat(await evalJs("document.querySelector('[data-testid=desktop-settings-page]').innerText"));
      check("语言 offers exactly the one shipped UI language and says why there is no second option",
        languageText.includes("简体中文") && languageText.includes("没有交付的界面字符串"),
        languageText.slice(0, 600));
      check("Pi's own language field is named 不支持 with its real settings.json path and reason",
        languageText.includes("不支持") && languageText.includes(join(agentDir, "settings.json")),
        languageText.slice(0, 900));
      await settleFocus();
      await capture("t14-language", 1440, 900, "[aria-label=\"语言\"]");
      await capture("t14-language", 720, 560, "[aria-label=\"语言\"]");
      await sizeTo(1440, 900);

      stage = "t14 general";
      await clickLabelled("通用");
      await untilJs(`!!document.querySelector('[data-testid=general-agent-dir]')`, "general pane");
      const generalText = flat(await evalJs("document.querySelector('[data-testid=desktop-settings-page]').innerText"));
      check("通用 names the real Pi paths main resolved (temp agent dir, read-only settings.json)",
        flat(await evalJs("document.querySelector('[data-testid=general-agent-dir]').textContent")) === agentDir &&
        generalText.includes("已存在（只读）") && generalText.includes(join(agentDir, "settings.json")),
        generalText.slice(0, 900));
      check("通用 keeps the wired 外部编辑器 setting and names Pi's unsupported field as 未接线",
        generalText.includes("外部编辑器") && generalText.includes("未接线"),
        generalText.slice(0, 1200));
      await settleFocus();
      await capture("t14-general", 1440, 900, "[aria-label=\"通用\"]");
      await capture("t14-general", 720, 560, "[aria-label=\"通用\"]");
      await sizeTo(1440, 900);

      stage = "t14 return preserves task/session/draft/focus";
      await clickLabelled("外观");
      await untilJs(`!!document.querySelector('[data-appearance-option=dark]')`, "appearance pane again");
      await evalJs(`(() => { document.querySelector('[data-appearance-option=dark]').click(); return true; })()`);
      for (let i = 0; i < 100; i++) { if (readAppearancePreference(app.getPath("userData")).value === "dark") break; await wait(100); }
      await clickLabelled("返回任务工作区");
      await until((body) => body.includes("SDK JSONL 已确认历史"), "task view after the settings page");
      const backState = await composerState();
      let backRestored = null;
      for (let i = 0; i < 150; i++) {
        const state = await composerState();
        if (state.value === returnDraft) { backRestored = state; break; }
        await wait(100);
      }
      check("returning from 设置 keeps the same task and the same session",
        (await evalJs(`!!document.querySelector('[data-task-nav="${taskId}"]')`)) === true &&
        (await activeSession()) === returnSession,
        JSON.stringify({ session: await activeSession(), expected: returnSession }));
      softCheck("returning restores the draft that was in the composer (Host draft, same text)",
        backRestored !== null && backRestored.value === returnDraft, JSON.stringify(backRestored ?? backState),
        { id: "draft-not-restored-after-navigation",
          title: "会话草稿没有写进 Host 的草稿记录：离开设置页返回后输入框为空（T10 的会话草稿隔离在同一处失败）",
          expected: "输入内容经 task/saveDraft 落到 Host，返回任务时 task/readDraft 读回同一段文本",
          observed: "返回后 textarea 为空，disabled:true；直接调用 task/readDraft 亦返回 null",
          contract: "product: DesktopConversation 在输入后应写 Host 草稿；脚本用原生 input 事件赋值仍未触发保存，疑为受控组件 onChange 的合成事件边界",
          note: "未修改产品代码；草稿相关断言记为 soft / 未取证。" });
      // Focus cannot be proven while the composer is disabled for lack of a restored
      // draft; the same navigation's task/session/appearance checks still run.
      softCheck("returning puts focus back in the composer",
        backRestored?.focus === "消息", JSON.stringify(backRestored),
        { id: "composer-focus-not-restored",
          title: "从设置页返回任务后焦点没有回到输入框（该轮输入框 disabled:true，焦点停留在会话切换处）",
          expected: "返回后 document.activeElement 的 aria-label 为 消息",
          observed: "composerFocus() 返回 null / 焦点不在消息输入框上",
          contract: "product: 返回任务时应把焦点放回 composer；disabled 状态下无法聚焦，根因与上一条草稿未恢复相同",
          note: "与草稿问题同源，记为 soft。" });
      check("returning keeps the chosen appearance applied across pages",
        (await evalJs("document.documentElement.dataset.theme")) === "dark" &&
        readAppearancePreference(app.getPath("userData")).value === "dark",
        String(await evalJs("document.documentElement.dataset.theme")));
      await settleFocus();
      await capture("t14-returned-task-dark", 1440, 900, "[data-testid=desktop-composer]");
      await capture("t14-returned-task-dark", 720, 560, "[data-testid=desktop-composer]");
      await sizeTo(1440, 900);

      stage = "t14 returned task in 日间";
      await openSettings();
      await evalJs(`(() => { document.querySelector('[data-appearance-option=light]').click(); return true; })()`);
      for (let i = 0; i < 100; i++) { if (readAppearancePreference(app.getPath("userData")).value === "light") break; await wait(100); }
      await clickLabelled("返回任务工作区");
      await until((body) => body.includes("SDK JSONL 已确认历史"), "task view in light");
      await untilJs(`document.documentElement.dataset.theme === 'light'`, "light theme on the task page");
      await settleFocus();
      await capture("t14-returned-task-light", 1440, 900, "[data-testid=desktop-composer]");
      await capture("t14-returned-task-light", 720, 560, "[data-testid=desktop-composer]");
      await sizeTo(1440, 900);

      stage = "t14 leave 夜间 for the restart phase";
      await openSettings();
      await evalJs(`(() => { document.querySelector('[data-appearance-option=dark]').click(); return true; })()`);
      for (let i = 0; i < 100; i++) { if (readAppearancePreference(app.getPath("userData")).value === "dark") break; await wait(100); }
      check("the restart phase starts from a persisted 夜间 preference",
        readAppearancePreference(app.getPath("userData")).value === "dark" && JSON.stringify(readJson(appearanceFile())) === JSON.stringify({ appearance: "dark" }),
        readFileSync(appearanceFile(), "utf8"));
    }

    // ------------------------------------------- restart phase: a SECOND OS process
    // This branch runs in a NEW Electron process over the same temp agent dir,
    // userData, task root and workspace files. It re-reads the variables from disk,
    // forks a NEW Host and reads the injected value out of that process again.
    if (restart) {
      for (const dir of Object.values(outputDir)) mkdirSync(dir, { recursive: true });
      const expect = JSON.parse(process.env["PIDOCK_T09_EXPECT"] ?? "null");
      if (!expect) throw Error("restart phase: expectations missing");
      await until((body) => body.includes(PROJECT_NAME) || body.includes("未归属任务"), "shell boot");
      ticket = "t09";
      const fork1 = await waitForFork("restart Host start");
      softCheck("the restart process re-read the workspace rows from the registry document",
        JSON.stringify((projects.get(projectId)?.environment ?? []).map((row) => [row.key, row.value])) ===
          JSON.stringify([[VARS.deploy, WORKSPACE_VALUE.deploy], [VARS.shared, WORKSPACE_VALUE.shared]]),
        JSON.stringify(projects.get(projectId)?.environment));
      softCheck("the restart process re-read the surviving task override",
        JSON.stringify(taskVariables.list(taskId)) === JSON.stringify([{ key: VARS.persist, value: PERSIST_VALUE }]),
        JSON.stringify(taskVariables.list(taskId)));
      check("the new Host's fork environment resolves inheritance + the surviving override",
        fork1.env[VARS.deploy] === WORKSPACE_VALUE.deploy && fork1.env[VARS.shared] === WORKSPACE_VALUE.shared &&
        fork1.env[VARS.persist] === PERSIST_VALUE,
        JSON.stringify({ deploy: fork1.env[VARS.deploy], shared: fork1.env[VARS.shared], persist: fork1.env[VARS.persist] }));
      const ps = processEnvOf(forkPid(fork1));
      softCheck("the restart Host process really carries those values (ps of the new pid)",
        ps.includes(`${VARS.deploy}=${WORKSPACE_VALUE.deploy}`) && ps.includes(`${VARS.persist}=${PERSIST_VALUE}`),
        ps.split(/\s+/).filter((token) => token.startsWith("T09_")).join(" "));
      const printed = await defaultRunCommand({ command: `printf 'deploy=%s persist=%s' "$${VARS.deploy}" "$${VARS.persist}"`, cwd: taskDir, timeoutMs: 10_000 });
      softCheck("after the restart the managed command prints the inherited value and the surviving override",
        printed.exitCode === 0 && printed.output === `deploy=${WORKSPACE_VALUE.deploy} persist=${PERSIST_VALUE}`,
        JSON.stringify(printed));
      check("the deleted override did not come back (no empty shadow row on disk)",
        !JSON.stringify(taskVariables.list(taskId)).includes(VARS.deploy), JSON.stringify(taskVariables.list(taskId)));

      await openTask();
      const taskVariableText = flat(await evalJs("document.querySelector('[data-testid=desktop-task-variables]').innerText"));
      check("the restart UI shows 工作区继承 for the restored key and 任务覆盖 for the surviving one",
        taskVariableText.includes(`${VARS.deploy} = ${WORKSPACE_VALUE.deploy}`) && taskVariableText.includes(`${VARS.persist} = ${PERSIST_VALUE}`) &&
        taskVariableText.includes("工作区继承") && taskVariableText.includes("任务覆盖"),
        taskVariableText.slice(0, 900));
      await settleFocus();
      await capture("t09-variables-after-restart", 1440, 900, "[data-testid=desktop-task-variables]");
      await capture("t09-variables-after-restart", 720, 560, "[data-testid=desktop-task-variables]");
      await sizeTo(1440, 900);

      ticket = "t14";
      let bootTheme = null;
      for (let i = 0; i < 150; i++) {
        bootTheme = await evalJs("document.documentElement.dataset.theme ?? null");
        if (bootTheme === "dark") break;
        await wait(100);
      }
      check("the second process boots into the persisted 夜间 appearance",
        bootTheme === "dark" && readAppearancePreference(app.getPath("userData")).value === "dark", String(bootTheme));
      const darkHues = await tokenHues();
      check("the restarted window paints the dark palette with no green",
        darkHues.theme === "dark" && noGreenToken(darkHues).every((row) => row.hue < 90 || row.hue > 150),
        JSON.stringify(noGreenToken(darkHues)));
      check("the edited keybindings.json is still the one Pi reads (unknown fields preserved, no rewrite on read)",
        sha256(readFileSync(join(agentDir, "keybindings.json"))) === expect.keybindingsSha,
        `${expect.keybindingsSha} -> ${sha256(readFileSync(join(agentDir, "keybindings.json")))}`);
      check("Pi's settings.json stayed read-only across both processes",
        sha256(readFileSync(join(agentDir, "settings.json"))) === expect.settingsSha);
      check("the temp agent dir was used again, never the real ~/.pi/agent",
        resolveAgentDir(process.env, homedir()) === agentDir && !existsSync(join(realAgentDir, "keybindings.json.must-not-exist")),
        agentDir);
      await settleFocus();
      await capture("t14-appearance-after-restart", 1440, 900, "[data-testid=desktop-task-variables]");
      await capture("t14-appearance-after-restart", 720, 560, "[data-testid=desktop-task-variables]");
      await sizeTo(1440, 900);

      const restartLog = {
        phase: "restart",
        pid: process.pid,
        agentDir,
        hostPid: forkPid(fork1),
        theme: bootTheme,
        variables: { effective: taskVariables.list(taskId), forkEnv: fork1.variables, printed: printed.output, ps: ps.split(/\s+/).filter((token) => token.startsWith("T09_")) },
        keybindingsSha256: sha256(readFileSync(join(agentDir, "keybindings.json"))),
        settingsSha256: sha256(readFileSync(join(agentDir, "settings.json"))),
        assertions: [...evidence.t09.assertions, ...evidence.t14.assertions],
        shots: [...evidence.t09.shots, ...evidence.t14.shots],
      };
      writeFileSync(join(outputDir.t09, "restart-log.json"), `${JSON.stringify(restartLog, null, 2)}\n`);
      console.log("T09_RESTART_LOG=" + JSON.stringify({ pid: process.pid, hostPid: forkPid(fork1), theme: bootTheme,
        assertions: restartLog.assertions.length, shots: restartLog.shots.map((shot) => shot.file) }));
      return;
    }

    // ------------------------------------------------ the second Electron process
    stage = "restart process";
    const expect = {
      projectId, taskId, taskDir, profileId,
      keybindingsSha: sha256(readFileSync(join(agentDir, "keybindings.json"))),
      settingsSha: sha256(readFileSync(join(agentDir, "settings.json"))),
      variables: { workspace: (projects.get(projectId)?.environment ?? []), overrides: taskVariables.list(taskId) },
    };
    // Only the T09 phase seeds workspace/task variables, so only a run that included
    // t09 can hand the restart phase a meaningful expectation.
    const restartOut = !only.includes("t09") || process.env["PIDOCK_T09_NO_RESTART"] === "1"
      ? { code: 0, skipped: true, stdout: "", stderr: "" } : await new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [scriptPath, "--phase", "restart", "--out", outArg, "--only", only.join(",")], {
        env: { ...process.env,
          PIDOCK_T09_PROJECT_ID: projectId, PIDOCK_T09_TASK_ID: taskId, PIDOCK_T09_TASK_DIR: taskDir,
          PIDOCK_T09_PROFILE_ID: profileId, PIDOCK_T09_EXPECT: JSON.stringify(expect) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (data) => { stdout += data; process.stdout.write(`[t09-restart] ${data}`); });
      child.stderr.on("data", (data) => { stderr += data; process.stderr.write(`[t09-restart] ${data}`); });
      child.on("error", reject);
      child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    });
    check("the restart phase exited 0", restartOut.code === 0, JSON.stringify({ code: restartOut.code, stderr: restartOut.stderr.slice(-2000) }));
    const restartLog = restartOut.skipped
      ? { pid: null, hostPid: null, variables: { printed: null }, assertions: [], shots: [], skipped: "no t09 variables in this run" }
      : JSON.parse(readFileSync(join(outputDir.t09, "restart-log.json"), "utf8"));
    if (restartOut.skipped) check("the restart phase was skipped for this run", true,
      JSON.stringify({ only: only.join(","), noRestart: process.env["PIDOCK_T09_NO_RESTART"] === "1" }));
    else check("the restart phase ran in a DIFFERENT OS process", restartLog.pid !== process.pid, `${process.pid} -> ${restartLog.pid}`);
    if (!restartOut.skipped) check("the restart process forked its own Host (a new pid)", restartLog.hostPid !== null && restartLog.hostPid !== forkPid(forkFor()),
      JSON.stringify({ restartHostPid: restartLog.hostPid, primaryHostPids: hostForks.map((entry) => forkPid(entry)) }));
    if (!restartOut.skipped) check("the restart process re-printed the injected values from its own Host environment",
      restartLog.variables.printed === `deploy=${WORKSPACE_VALUE.deploy} persist=${PERSIST_VALUE}`,
      JSON.stringify(restartLog.variables.printed));

    // ------------------------------------------------------ build identity + logs
    const assetsDir = join(import.meta.dirname, "..", "dist", "renderer", "assets");
    const bundles = readdirSync(assetsDir).filter((name) => /^index-.*\.(js|css)$/.test(name))
      .map((name) => ({ file: `packages/shell/dist/renderer/assets/${name}`, sha256: sha256(readFileSync(join(assetsDir, name))) }));
    let revision = "unknown"; let trackedFilesDirty = "unknown";
    try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: repoRoot }).trim(); } catch { /* recorded as unknown */ }
    try {
      const { relative } = await import("node:path");
      trackedFilesDirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no", "--", "."], { encoding: "utf8", cwd: repoRoot }).trim() ? "true" : "false";
      void relative;
    } catch { /* recorded as unknown */ }
    const runtime = { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome,
      v8: process.versions.v8, platform: process.platform, arch: process.arch };
    const realVsTest = {
      real: ["built React renderer over file://", "production main wiring (createTrustedWindow/registerIpc/ProviderWiring)",
        "real utilityProcess task Host forked with buildHostEnv(..., variables)", "real Host process environment read back with ps",
        "real managed /bin/sh command boundary (defaultRunCommand)", "real ProjectRegistry / TaskVariableStore documents",
        "real Host draft store (task/saveDraft · task/readDraft)", "real workspace file tree + preview + reference",
        "real SDK turn against the loopback endpoint", "real Pi keybindings.json splice in the temp agent dir",
        "real appearance.json in userData", "real nativeTheme OS-appearance change", "second Electron OS process for the restart"],
      replaced: ["OS keychain cipher → deterministic AES-256-GCM test cipher (createTestSafeStorage)",
        "real online provider → loopback OpenAI-compatible HTTP server on 127.0.0.1",
        "real ~/.pi/agent → temp PIDOCK_AGENT_DIR"],
      notExercised: ["real online provider account", "Windows", "a live SDK tool call (exec.run) inside the Host (approval-gated)",
        "a repo worktree reference (this task uses a plain-directory link)"],
    };
    const seed = {
      registry: "ProjectRegistry.create (real projects.json under the isolated userData)",
      project: { id: projectId, name: PROJECT_NAME, sources: [`${REPO_NAME} (real git repository, worktree mode)`], repositories: [workDir] },
      task: { taskId, taskDir, createdBy: "performCreationOperation (the function behind shell/createTask), plain-dirs mode" },
      variables: { workspace: projects.get(projectId)?.environment ?? [], overrides: taskVariables.list(taskId) },
      keybindings: { path: join(agentDir, "keybindings.json"), sha256: sha256(readFileSync(join(agentDir, "keybindings.json"))) },
      settingsJson: { path: join(agentDir, "settings.json"), sha256: sha256(readFileSync(join(agentDir, "settings.json"))) },
      appearance: { path: appearanceFile(), value: readAppearancePreference(app.getPath("userData")).value },
    };
    const hostForkLog = hostForks.map((entry) => ({ pid: forkPid(entry), taskId: entry.taskId,
      variables: entry.env["T09_DEPLOY_ENV"] ?? null, shared: entry.env["T09_SHARED_ONLY"] ?? null,
      persist: entry.env["T09_PERSIST"] ?? null }));
    for (const key of Object.keys(evidence)) {
      // A `--only` run must never overwrite another ticket's log with an empty one.
      if (!only.includes(key)) continue;
      const record = evidence[key];
      const log = {
        ticket: record.ticket,
        command,
        generatedBy: "scripts/electron-pencil-v1-t09-t10-t14-capture.mjs",
        phase: "primary",
        repoRoot, revision, trackedFilesDirty, runtime, bundles,
        realVsTest,
        seed,
        hostForks: hostForkLog,
        provider: profileId === "" ? null : { profileId, nativePath: nativeModels.path, baseUrl: withPort("/v1"), model: MODEL,
          state: providers?.status(taskId)?.state ?? null,
          requests: received.map((row) => ({ method: row.method, url: row.url, mode: row.mode,
            authorization: row.authorization === `Bearer ${API_KEY}` ? "Bearer <stored key>" : row.authorization,
            bodyCarriesReference: row.body.includes(REFERENCED_FILE) })) },
        restart: key === "t09" ? { log: "restart-log.json", pid: restartLog.pid, hostPid: restartLog.hostPid,
          assertions: restartLog.assertions.length, shots: restartLog.shots.map((shot) => shot.file) } : undefined,
        assertions: record.assertions,
        findings: record.findings,
        shots: record.shots,
      };
      writeFileSync(join(outputDir[key], "capture-log.json"), `${JSON.stringify(log, null, 2)}\n`);
      console.log("T09_TICKET_LOG=" + JSON.stringify({ ticket: key, assertions: record.assertions.length,
        findings: record.findings.length, shots: record.shots.map((shot) => shot.file) }));
    }
  } catch (error) {
    console.error(`T09_CAPTURE_FAILED [${phase}]`, stage, error);
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    try { if (savedEnvAgent === undefined) delete process.env["PIDOCK_AGENT_DIR"]; else process.env["PIDOCK_AGENT_DIR"] = savedEnvAgent; } catch { /* best effort */ }
    for (const entry of held.splice(0)) {
      try { clearInterval(entry.timer); } catch { /* already cleared */ }
      try { entry.response.end(); } catch { /* already closed */ }
    }
    const cleanupFailures = await shutdownTestRegistry(registry, {
      origin: views ? { kind: "shell-ui", senderWebContentsId: views.shellView.webContents.id } : undefined,
      label: `PencilV1 T09/T10/T14 capture cleanup (${phase})`,
    }).catch(() => []);
    for (const child of children) child.kill();
    try { if (views?.shellView.webContents.debugger.isAttached()) views.shellView.webContents.debugger.detach(); } catch { /* already gone */ }
    try { views?.window.destroy(); } catch { /* already gone */ }
    providerState.server?.close();
    if (phase !== "restart") rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    if (cleanupFailures.length) { console.error(`T09_CAPTURE_CLEANUP_FAILED [${phase}] ` + JSON.stringify(cleanupFailures)); process.exitCode = process.exitCode ?? 1; }
    exitNow(process.exitCode ?? 0, "done");
  }
}
void run();
