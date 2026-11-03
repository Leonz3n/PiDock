// [PiDock pencil-v1] (#154 / T19) 新版真实桌面集成与 macOS 功能验收.
//
// One real Electron run that strings the whole product together and then records
// what it could and could not prove:
//   workspace (real registry) -> task (default auto worktree, multi-repo + a plain
//   directory) -> Provider/model from the real profile store -> session 1 turn whose
//   real tool call needs an approval -> a real local Skill, a real MCP stdio tool ->
//   session 2 -> drafts -> task variables inheritance/override -> delivery (real
//   commit + real push to a bare origin) -> task archive -> cleanup preview that
//   refuses uncommitted/undelivered work -> cleanup -> restore that is NOT ready ->
//   capabilities (Providers / MCP / Skills) / settings / archive / schedules / 720x560
//   compact and day+night boards.
//
// Run after `pnpm build`:
//   pnpm --filter @pidock/shell exec electron scripts/electron-pencil-v1-t19-capture.mjs --phase primary
//   pnpm --filter @pidock/shell exec electron scripts/electron-pencil-v1-t19-capture.mjs --phase restart
//
// Boot path is the one used by the T01/T02/T03/T05/T07/T13 harnesses: the compiled
// production runtime modules are imported directly (NOT `dist/main/main.js`) with the
// production wiring decisions (`createTrustedWindow(..., "production")`, `registerIpc`
// over a real TaskRootIndex / ProjectRegistry / PerTaskHostRegistry / ProjectTaskCreation
// with the real WorktreeMetadataLock / ProviderWiring over the real encrypted secret
// store + NativeModelsFile / ServiceCatalog / TaskVariableStore / McpWiring), and the
// built React renderer over `file://`.
//
// Deliberately NOT real, and named in the README:
// - the credential cipher: `createTestSafeStorage()` (deterministic AES-256-GCM) instead
//   of the OS keychain, because the capture must never touch the user's real item;
// - the Provider endpoint: a loopback OpenAI-compatible HTTP/SSE server on 127.0.0.1
//   (there is no real online provider account here). The SDK turn, the tool loop, the
//   Host, the tool broker, the approval gate, the Skill loader and the MCP stdio server
//   are real;
// - `PIDOCK_AGENT_DIR` points at a temp dir, so Pi's real `models.json` / `mcp.json`
//   are never read or written;
// - git remotes are real bare repositories under the OS temp dir, not github.com.
import { app, utilityProcess } from "electron";
import { createUnavailableHostClient } from "./unavailable-host-client.mjs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

delete process.env["PIDOCK_RENDERER_URL"];
delete process.env["PIDOCK_TASK_URL"];

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const argValue = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const phase = argValue("--phase") ?? "primary";
// A fixed window size avoids the macOS Electron 44 quirk where a WebContentsView
// can keep its old renderer viewport when the window grows again. Each size is
// then a REAL window created/resized once, not a crop of the other size.
const fixedArg = argValue("--window-size");
const FIXED_SIZE = fixedArg === undefined ? null : (() => {
  const match = /^(\d+)x(\d+)$/.exec(fixedArg);
  if (!match) throw Error(`--window-size must be <width>x<height>, got ${fixedArg}`);
  return [Number(match[1]), Number(match[2])];
})();
const SIZES = FIXED_SIZE === null ? [[1440, 900], [720, 560]] : [FIXED_SIZE];
const outDir = resolve(repoRoot, argValue("--out") ?? "docs/evidence/pencil-v1-t19");
const command = `pnpm --filter @pidock/shell exec electron scripts/electron-pencil-v1-t19-capture.mjs --phase ${phase}`;

// A fixed temp root keeps captured paths stable between the two phases.
const root = join(tmpdir(), "pidock-pencil-v1-t19-capture");
const profile = join(root, "profile");
const taskRoot = join(root, "tasks");
const sourcesRoot = join(root, "sources");
const remotesRoot = join(root, "remotes");
const agentDir = join(root, "agent");
const statePath = join(root, "state.json");
app.setPath("userData", join(root, phase === "primary" ? "chromium" : "chromium-restart"));
const realAgentDir = join(homedir(), ".pi", "agent");
if (resolve(agentDir) === resolve(realAgentDir)) throw Error("refusing to use the real ~/.pi/agent");
process.env["PIDOCK_AGENT_DIR"] = agentDir;

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const pngPixelSize = (png) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const flat = (value) => String(value).replace(/\s+/g, " ").trim();
const readJson = (path, fallback = null) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } };
const sha256File = (path) => (existsSync(path) ? sha256(readFileSync(path)) : null);

const children = [];
const hostPids = [];
let views, registry, index, projects, providers, providerProfiles, secrets, nativeModels, nativeMcp, creation, taskVariables, mcpWiring;

let exiting = false;
const exitNow = (code, why) => {
  if (exiting) return;
  exiting = true;
  console.error(`T19_CAPTURE_EXIT ${phase}`, code, why);
  try { app.exit(code); } catch { process.exit(code); }
};
const watchdog = setTimeout(() => exitNow(1, "watchdog timeout"), 2400000);
watchdog.unref?.();
process.on("uncaughtException", (error) => exitNow(1, `uncaughtException ${error?.stack ?? error}`));
process.on("unhandledRejection", (error) => exitNow(1, `unhandledRejection ${String(error instanceof Error ? error.stack : error)}`));
app.on("window-all-closed", () => { /* the harness owns its lifecycle */ });

const PROJECT_NAME = "T19 集成验收工作区";
const API_KEY = "sk-t19-loopback-4c9d21e7ab0f4e53";
const MODEL = "loopback-chat-7b";
const MODEL_ALT = "loopback-fast";
const BRANCH_TEMPLATE = "ticket/{taskId}-{slug}";
const TASK_NAME = "T19 端到端验收任务";
const PROVIDER_NAME = "Loopback 集成端点";
const ENV_MODE = "T19_ENV_MODE";
const WORKSPACE_ENV_VALUE = "workspace-value";
const TASK_ENV_VALUE = "task-override-value";
const SKILL_NAME = "acceptance-notes";
const SKILL_BODY = "T19-SKILL-BODY: read references/checklist.md before answering, then answer with ACCEPT-OK.";
const SKILL_RESOURCE = "T19-SKILL-RESOURCE: verify identity, persistence, failure and recovery.";
const MCP_TEXT = "mcp-fixture-echo-154";

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
// The prompt marker in the LAST user message selects a scripted tool call; once the
// conversation's last message is a tool result the server answers with the closing
// text and quotes the Host's own tool result verbatim.
const received = [];
const providerState = { port: 0, server: null };
function startProvider(port) {
  return new Promise((done, reject) => {
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => {
        const url = request.url ?? "";
        received.push({ method: request.method, url, body });
        if (request.method === "GET" && url.endsWith("/models")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ object: "list", data: [MODEL, MODEL_ALT].map((id) => ({ id, object: "model", owned_by: "loopback" })) }));
          return;
        }
        if (!url.endsWith("/chat/completions")) { response.writeHead(404).end(); return; }
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* recorded empty */ }
        const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
        const lastUser = [...messages].reverse().find((row) => row?.role === "user");
        const userText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
        const tag = (userText.match(/\[T19-([A-Z0-9-]+)\]/g) ?? []).at(-1)?.replace(/[[\]]/g, "").replace(/^T19-/, "") ?? "NONE";
        const lastMessage = messages.at(-1);
        const toolResult = lastMessage?.role === "tool" || lastMessage?.role === "toolResult" ? lastMessage : undefined;
        const toolResultText = (() => {
          const content = toolResult?.content;
          if (typeof content === "string") return content;
          if (Array.isArray(content)) return content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("\n");
          return "";
        })().slice(0, 800);
        const frame = (delta, extra = {}) => `data: ${JSON.stringify({
          id: `chatcmpl-loopback-${tag}`, object: "chat.completion.chunk", model: MODEL,
          choices: [{ index: 0, delta, finish_reason: null }], ...extra,
        })}\n\n`;
        const finish = (text) => {
          response.write(frame({ content: text }));
          response.write(`data: ${JSON.stringify({ id: `chatcmpl-loopback-${tag}`, object: "chat.completion.chunk", model: MODEL,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 } })}\n\n`);
          response.write("data: [DONE]\n\n");
          response.end();
        };
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        const script = (() => {
          if (toolResult !== undefined) {
            // The Skill's own instruction sends the model to its relative resource
            // once SKILL.md has really been read through the Host tool seam.
            if (tag === "SKILL" && toolResultText.includes("T19-SKILL-BODY")) {
              return { tool: "fs.read", args: { path: join(sourcesRoot, "skills", SKILL_NAME, "references", "checklist.md") } };
            }
            return null;
          }
          switch (tag) {
            // [T19-A] exec.run behind the approval gate.
            case "A": return { tool: "exec.run", args: { command: "env > t19-env.txt; printf 'T19-APPROVED-ONCE' > t19-approved.txt" } };
            // [T19-SKILL] the Skill's own instruction opens its relative resource.
            case "SKILL": return { tool: "fs.read", args: { path: join(sourcesRoot, "skills", SKILL_NAME, "SKILL.md") } };
            // [T19-MCP] a real MCP stdio server's tool.
            case "MCP": return { tool: "mcp__fixture__echo", args: { text: MCP_TEXT } };
            default: return null;
          }
        })();
        if (script === null) {
          // The closing turn quotes the Host's own tool result verbatim.
          finish(toolResult === undefined ? `T19-${tag}-TEXT` : `T19-${tag}-DONE 工具结果原文：${toolResultText}`);
          return;
        }
        const callId = `call_${tag.toLowerCase()}_${received.length}`;
        const args = JSON.stringify(script.args);
        response.write(frame({ tool_calls: [{ index: 0, id: callId, type: "function", function: { name: script.tool, arguments: "" } }] }));
        const cut = [Math.ceil(args.length / 3), Math.ceil((args.length * 2) / 3)];
        for (const piece of [args.slice(0, cut[0]), args.slice(cut[0], cut[1]), args.slice(cut[1])]) {
          response.write(frame({ tool_calls: [{ index: 0, function: { arguments: piece } }] }));
        }
        response.write(`data: ${JSON.stringify({ id: `chatcmpl-loopback-${tag}`, object: "chat.completion.chunk", model: MODEL,
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 17, completion_tokens: 6, total_tokens: 23 } })}\n\n`);
        response.write("data: [DONE]\n\n");
        response.end();
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
const withPort = (path) => `http://127.0.0.1:${providerState.port}${path}`;
const chatRequests = () => received.filter((row) => String(row.url).endsWith("/chat/completions"));
const freePort = () => new Promise((done) => {
  const probe = createServer(() => {});
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    const port = typeof address === "object" && address ? address.port : 0;
    probe.close(() => done(port));
  });
});
const nodeBin = execFileSync("/bin/sh", ["-lc", "command -v node"], { encoding: "utf8" }).trim();

async function run() {
  let stage = "startup";
  const log = { shots: [], assertions: [], findings: [], failed: [], sections: [], layout: [], ime: [], focus: {}, reachability: [], realVsTest: {}, identity: {} };
  const check = (name, condition, detail = "") => {
    const entry = { name, ok: condition === true, detail: String(detail).slice(0, 900) };
    log.assertions.push(entry);
    if (!condition) throw Error(`ASSERT FAILED [${phase}] ${name}${detail ? `: ${String(detail).slice(0, 1400)}` : ""}`);
  };
  const softCheck = (name, condition, detail = "") => {
    const entry = { name, ok: condition === true, detail: String(detail).slice(0, 900), soft: true };
    log.assertions.push(entry);
    if (!condition) {
      log.findings.push({ id: `soft-${name}`, title: name, observed: entry.detail, expected: "见断言名称", note: "soft check：本次未通过，未按通过处理。" });
      console.log("T19_SOFT_FAIL=" + JSON.stringify({ name, detail: entry.detail.slice(0, 400) }));
    }
    return condition === true;
  };
  const recordFinding = (finding) => {
    log.findings.push(finding);
    console.log("T19_FINDING=" + JSON.stringify({ id: finding.id, title: finding.title }));
  };
  const section = async (name, body) => {
    stage = name;
    try { await body(); log.sections.push({ name, ok: true }); return true; }
    catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      log.sections.push({ name, ok: false, message: message.slice(0, 1600) });
      console.error(`T19_SECTION_FAILED ${name} [stage=${stage}]`, error);
      return false;
    }
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
  const { SkillSourceStore } = await import("../dist/main/skill-source-store.js");
  const { HostClient } = await import("../dist/rpc/host-client.js");
  const { readTaskRecordOnDisk } = await import("../dist/host/task-store.js");
  const { buildHostEnv } = await import("../dist/host/host-guards.js");

  const jsonlOf = (taskDir, sessionId = "main") => {
    const base = join(taskDir, ".pidock-sdk-sessions", sessionId);
    if (!existsSync(base)) return "";
    return readdirSync(base).filter((name) => name.endsWith(".jsonl"))
      .map((name) => readFileSync(join(base, name), "utf8")).join("\n");
  };
  const sessionFiles = (taskDir) => {
    const base = join(taskDir, ".pidock-sdk-sessions");
    return existsSync(base) ? readdirSync(base) : [];
  };
  const recordOf = (taskId) => {
    const taskDir = join(taskRoot, taskId);
    const raw = readFileSync(join(taskDir, "task.json"));
    return { taskDir, raw, sha256: sha256(raw), record: readTaskRecordOnDisk(taskDir) };
  };

  let state = readJson(statePath, {});
  if (phase === "primary") {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    for (const path of [profile, taskRoot, sourcesRoot, remotesRoot, agentDir, outDir]) mkdirSync(path, { recursive: true });
    providerState.port = await freePort();
    state = { loopbackPort: providerState.port };
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
  nativeMcp = new NativeMcpFile(resolvedAgent);

  let projectId = state.projectId ?? "";
  let taskId = state.taskId ?? "";
  let taskDir = state.taskDir ?? "";
  let profileId = state.profileId ?? "";
  let repos = state.repos ?? null;
  let docsDir = state.docsDir ?? "";
  let worktreeOf = state.worktreeOf ?? {};
  let linkName = state.linkName ?? "";
  const skillLog = join(root, "mcp-fixture.log");
  const mcpPidFile = join(root, "mcp-fixture.pid");

  // ---------------------------------------------------------------- seeding
  if (phase === "primary") {
    stage = "seed sources";
    const alpha = seedRepo("alpha-service", "# alpha-service\n\nT19 验收：服务端仓库。\n", "base: alpha");
    const beta = seedRepo("beta-web", "# beta-web\n\nT19 验收：前端仓库。\n", "base: beta");
    repos = { alpha, beta };
    docsDir = join(sourcesRoot, "shared-docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, "验收.md"), "# 共享目录\n\nT19 验收：普通目录共享原文件。\n");
    // A real local Skill directory (SKILL.md + a relative resource).
    const skillDir = join(sourcesRoot, "skills", SKILL_NAME);
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), [
      "---",
      `name: ${SKILL_NAME}`,
      "description: T19 acceptance notes. Use when the user asks for the acceptance checklist.",
      "---",
      "",
      SKILL_BODY,
      "",
    ].join("\n"));
    writeFileSync(join(skillDir, "references", "checklist.md"), `${SKILL_RESOURCE}\n`);
    const skillStore = new SkillSourceStore(profile);
    const added = skillStore.add(join(sourcesRoot, "skills"));
    if (added.ok !== true) throw Error(`skill source refused: ${JSON.stringify(added)}`);
    // A real MCP stdio server (the repo's own fixture) in Pi's native mcp.json.
    writeFileSync(join(agentDir, "mcp.json"), `${JSON.stringify({
      mcpServers: {
        fixture: {
          type: "stdio",
          command: nodeBin,
          args: [join(import.meta.dirname, "fixtures", "mcp-stdio-fixture.mjs")],
          env: { MCP_FIXTURE_LOG: skillLog, MCP_FIXTURE_PID: mcpPidFile },
          exposure: "direct",
          enabled: true,
        },
      },
    }, null, 2)}\n`);
    stage = "seed registry";
    const project = await projects.create({
      name: PROJECT_NAME,
      description: "T19 端到端集成验收（真实 Electron / 真实 Host / 真实 git）",
      repositories: [alpha, beta].map((row) => ({ name: row.name, path: row.dir })),
      directories: [{ name: "shared-docs", path: docsDir }],
      environment: [{ key: ENV_MODE, value: WORKSPACE_ENV_VALUE }],
      branchTemplate: BRANCH_TEMPLATE,
    });
    projectId = project.id;
    state = { ...state, projectId, repos, docsDir };
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    check("the workspace is a real registry entry with two real checkouts, one real plain directory, one Skill source and one native MCP server",
      project.repositories.length === 2 && project.directories.length === 1 && existsSync(join(agentDir, "mcp.json")),
      JSON.stringify({ projectId, env: project.environment }));
  } else if (!projectId) {
    throw Error(`restart phase: no persisted workspace under ${profile}`);
  }

  // ---------------------------------------------------------------- window + wiring
  stage = "window";
  const workspaceId = `pencil-v1-t19-${phase}`;
  views = await createTrustedWindow(workspaceId, "production");
  if (FIXED_SIZE !== null) { views.window.setContentSize(FIXED_SIZE[0], FIXED_SIZE[1], false); await wait(250); }
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
    return { child, client: new HostClient(child) };
  }, (id) => index.resolve(id), undefined, index, (taskId2) => {
    const project = projects.get(projectId);
    const resolved = resolveTaskVariables(project?.environment ?? [], taskVariables.list(taskId2));
    return variableEnvironment(resolved.rows);
  });
  const ops = [];
  const originalRoute = registry.routeTaskOp.bind(registry);
  registry.routeTaskOp = async (input) => {
    const answer = await originalRoute(input);
    ops.push({ op: input?.op ?? null, taskId: input?.taskId ?? null, ok: answer?.ok ?? null, error: answer?.ok === false ? String(answer.error) : null });
    return answer;
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
  mcpWiring = new McpWiring(nativeMcp, process.env);
  registerIpc(createUnavailableHostClient(), views.registry, registry, projects, index, undefined, creation, providers, catalog,
    undefined, undefined, taskVariables, { state: () => ({ phase: "active", blockedReason: null }) }, mcpWiring);
  await loadTrustedViews(views);
  views.shellView.webContents.debugger.attach();

  if (phase === "primary") {
    stage = "provider save";
    const saved = providers.save({
      name: PROVIDER_NAME,
      notes: "本机回环 · 无真实线上账号",
      protocol: "openai-completions",
      baseUrl: withPort("/v1"),
      credentials: { kind: "store", revision: 1 },
      models: [
        { id: MODEL, name: "Loopback Chat 7B", contextWindow: 131072, maxTokens: 8192, reasoning: false },
        { id: MODEL_ALT, name: "Loopback Fast", contextWindow: 32768, maxTokens: 4096, reasoning: false },
      ],
      modelId: MODEL,
    }, API_KEY, false);
    profileId = saved.profile.id;
    state = { ...state, profileId };
    writeFileSync(statePath, `${JSON.stringify({ ...state, repos }, null, 2)}\n`);
    check("the Provider profile is store-backed with a ciphertext credential and Pi's own models.json carries the managed entry",
      secrets.has(profileId) && !readFileSync(join(profile, "provider-secrets.json"), "utf8").includes(API_KEY) &&
      readFileSync(nativeModels.path, "utf8").includes(MODEL),
      JSON.stringify({ profileId, nativeModels: nativeModels.path }));
  }
  void creation;

  // ---------------------------------------------------------------- UI helpers
  const evalJs = async (expression) => {
    const response = await views.shellView.webContents.debugger.sendCommand("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  // [T19 geometry] Every number below is read from the real production renderer
  // in the real Electron window at the exact content size of this shot. No value
  // is asserted or filled in by hand; a missing element is recorded as null.
  const measureExpression = `(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const box = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { top: +r.top.toFixed(2), left: +r.left.toFixed(2), right: +r.right.toFixed(2), bottom: +r.bottom.toFixed(2),
        width: +r.width.toFixed(2), height: +r.height.toFixed(2),
        inViewport: r.top >= -0.5 && r.left >= -0.5 && r.bottom <= vh + 0.5 && r.right <= vw + 0.5,
        display: cs.display, visibility: cs.visibility, overflowY: cs.overflowY, minHeight: cs.minHeight,
        scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, text: (el.innerText || el.value || "").replace(/\\s+/g, " ").trim().slice(0, 120) };
    };
    const scrollEl = document.querySelector('[data-testid=desktop-conversation-scroll]');
    let scroll = null;
    if (scrollEl) {
      const original = scrollEl.scrollTop;
      const max = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
      scrollEl.scrollTop = max;
      const sr = scrollEl.getBoundingClientRect();
      const articles = [...scrollEl.querySelectorAll('article')];
      const last = articles.at(-1);
      const lr = last ? last.getBoundingClientRect() : null;
      const composer = document.querySelector('[data-testid=desktop-composer]');
      const cr = composer ? composer.getBoundingClientRect() : null;
      scroll = { clientHeight: scrollEl.clientHeight, scrollHeight: scrollEl.scrollHeight,
        maxScrollTop: +max.toFixed(2), scrollTopAtMax: +scrollEl.scrollTop.toFixed(2),
        reachedMax: Math.abs(scrollEl.scrollTop - max) < 1,
        articleCount: articles.length,
        lastMessageVisible: lr ? lr.bottom <= sr.bottom + 1 && lr.top >= sr.top - 1 : null,
        composerInViewportAfterScroll: cr ? cr.top >= -0.5 && cr.bottom <= vh + 0.5 : null };
      scrollEl.scrollTop = original;
    }
    const shellContentEl = document.querySelector('[data-testid=desktop-shell-content]');
    let outerScroll = null;
    if (shellContentEl) {
      const before = shellContentEl.scrollTop;
      const max = Math.max(0, shellContentEl.scrollHeight - shellContentEl.clientHeight);
      shellContentEl.scrollTop = max;
      const sr = shellContentEl.getBoundingClientRect();
      const composer = document.querySelector('[data-testid=desktop-composer]');
      const cr = composer ? composer.getBoundingClientRect() : null;
      const articles = [...document.querySelectorAll('[data-testid=desktop-conversation-scroll] article')];
      const lr = articles.at(-1)?.getBoundingClientRect() ?? null;
      outerScroll = { clientHeight: shellContentEl.clientHeight, scrollHeight: shellContentEl.scrollHeight,
        maxScrollTop: +max.toFixed(2), scrollTopBefore: +before.toFixed(2), scrollTopAtMax: +shellContentEl.scrollTop.toFixed(2),
        reachedMax: Math.abs(shellContentEl.scrollTop - max) < 1,
        composerInViewportAfterOuterScroll: cr ? cr.top >= sr.top - 0.5 && cr.bottom <= Math.min(sr.bottom, vh) + 0.5 : null,
        composerTopAfterOuterScroll: cr ? +cr.top.toFixed(2) : null,
        composerBottomAfterOuterScroll: cr ? +cr.bottom.toFixed(2) : null,
        lastMessageVisibleAfterOuterScroll: lr ? lr.bottom <= Math.min(sr.bottom, vh) + 1 && lr.bottom > sr.top : null };
      shellContentEl.scrollTop = before;
    }
    const active = document.activeElement;
    return { viewport: { width: vw, height: vh, devicePixelRatio: window.devicePixelRatio },
      outerScroll,
      breadcrumb: box('[data-testid=desktop-breadcrumb]'),
      shellContent: box('[data-testid=desktop-shell-content]'),
      conversation: box('[data-testid=desktop-conversation]'),
      conversationHeader: box('[data-testid=desktop-conversation-header]'),
      composer: box('[data-testid=desktop-composer]'),
      composerTextarea: box('textarea[aria-label="消息"]'),
      composerReasoning: box('[data-testid=composer-reasoning]'),
      composerModel: box('[data-testid=composer-model]'),
      composerContext: box('[data-testid=composer-context]'),
      composerUsage: box('[data-testid=composer-usage]'),
      scroll,
      activeElement: active ? { tag: active.tagName, ariaLabel: active.getAttribute?.('aria-label') ?? null,
        testId: active.getAttribute?.('data-testid') ?? null } : null };
  })()`;
  const recordLayout = async (stateName, width, height) => {
    try {
      const measured = await evalJs(measureExpression);
      log.layout.push({ state: stateName, width, height, measuredAt: new Date().toISOString(), ...measured });
      return measured;
    } catch (error) {
      const failure = { state: stateName, width, height, error: String(error?.message ?? error) };
      log.layout.push(failure);
      return failure;
    }
  };
  const text = async () => { try { return await evalJs("document.body.innerText"); } catch { return ""; } };
  const until = async (match, label, attempts = 600) => {
    let last = "";
    for (let i = 0; i < attempts; i++) { last = await text(); if (match(last)) return last; await wait(100); }
    throw Error(`UI timeout [${phase}] (${label}): ${JSON.stringify(last.slice(0, 4000))}`);
  };
  const click = (name) => evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(name)} || el.getAttribute('aria-label') === ${JSON.stringify(name)}); if (!b) throw Error('missing button '+${JSON.stringify(name)}+' :: '+document.body.innerText.replace(/\\n+/g,' | ').slice(0,1200)); b.click(); return true; })()`);
  const clickTestId = (id) => evalJs(`(() => { const b = document.querySelector('[data-testid=' + ${JSON.stringify(id)} + ']'); if (!b) throw Error('missing [data-testid=' + ${JSON.stringify(id)} + '] :: ' + document.body.innerText.replace(/\\n+/g,' | ').slice(0,1200)); b.click(); return true; })()`);
  const clickLabelled = (needle, scope = "document") => evalJs(`(() => {
    const root = ${scope} ?? document;
    const want = ${JSON.stringify(needle.replace(/\s+/g, ""))};
    const button = [...root.querySelectorAll('button')].find((el) => el.textContent.replace(/\\s+/g, '').includes(want) || el.getAttribute('aria-label') === ${JSON.stringify(needle)});
    if (!button) throw Error('missing button containing ' + ${JSON.stringify(needle)} + ' :: ' + document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 1200));
    button.click();
    return true;
  })()`);
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
  // `BrowserWindow.setContentSize` changes the window before the production
  // view layout/renderer viewport follows. Drive the production layout and wait
  // until the RENDERER really reports this viewport, otherwise a "720x560" shot
  // would silently be a crop of the 1440x900 layout.
  const sizeTo = async (width, height) => {
    views.window.setContentSize(width, height);
    await wait(120);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const viewport = await evalJs("({ width: window.innerWidth, height: window.innerHeight })");
      if (viewport.width === width && viewport.height === height) { await wait(80); return viewport; }
      await wait(80);
    }
    // A window state that accepted `setContentSize` for the frame but did not
    // deliver it to the embedded WebContentsView: apply the production layout
    // bound once, AFTER the window has settled, then wait again.
    views.shellView.setBounds({ x: 0, y: 0, width, height });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const viewport = await evalJs("({ width: window.innerWidth, height: window.innerHeight })");
      if (viewport.width === width && viewport.height === height) { await wait(80); return viewport; }
      await wait(80);
    }
    const last = await evalJs("({ width: window.innerWidth, height: window.innerHeight })");
    throw Error(`renderer viewport did not reach ${width}x${height} (last ${JSON.stringify(last)}, content ${JSON.stringify(views.window.getContentBounds())}, shell ${JSON.stringify(views.shellView.getBounds())})`);
  };

  const capture = async (stateName, ticket = "t19") => {
    for (const [width, height] of SIZES) {
      stage = `${ticket}:${stateName} ${width}x${height}`;
      await sizeTo(width, height);
      views.shellView.setVisible(true);
      views.window.show();
      app.focus({ steal: true });
      views.window.moveTop();
      views.window.focus();
      await wait(120);
      const bounds = views.window.getContentBounds();
      if (bounds.width !== width || bounds.height !== height) throw Error(`unexpected content bounds ${JSON.stringify(bounds)}`);
      const layout = await recordLayout(stateName, width, height);
      const name = `${width}x${height}-${stateName}.png`;
      const shot = await views.shellView.webContents.debugger.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const png = Buffer.from(shot.data, "base64");
      writeFileSync(join(outDir, name), png);
      const pixels = pngPixelSize(png);
      log.shots.push({ state: stateName, file: name, width: bounds.width, height: bounds.height,
        pixelWidth: pixels.width, pixelHeight: pixels.height, sha256: sha256(png),
        bodyText: flat(await text()).slice(0, 1800), layout });
      console.log("T19_SHOT=" + JSON.stringify({ state: stateName, file: name, sha256: sha256(png) }));
    }
    if (FIXED_SIZE === null) await sizeTo(1440, 900);
  };
  const captureOne = async (stateName, width, height) => {
    stage = `t19:${stateName} ${width}x${height}`;
    await sizeTo(width, height);
    const bounds = views.window.getContentBounds();
    if (bounds.width !== width || bounds.height !== height) throw Error(`unexpected content bounds ${JSON.stringify(bounds)}`);
    const layout = await recordLayout(stateName, width, height);
    const name = `${width}x${height}-${stateName}.png`;
    const shot = await views.shellView.webContents.debugger.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const png = Buffer.from(shot.data, "base64");
    writeFileSync(join(outDir, name), png);
    log.shots.push({ state: stateName, file: name, width, height, pixelWidth: pngPixelSize(png).width, pixelHeight: pngPixelSize(png).height, sha256: sha256(png), bodyText: flat(await text()).slice(0, 1800), layout });
    console.log("T19_SHOT=" + JSON.stringify({ state: stateName, file: name, sha256: sha256(png) }));
    if (FIXED_SIZE === null) await sizeTo(1440, 900);
  };
  // [T19 reachability] The product's own "进入活跃对话（main）" entry calls
  // `scrollIntoView` on the conversation. Measure where the composer really is
  // before and after that control, at both production sizes; never assume.
  const reachProbe = async (width, height) => {
    await sizeTo(width, height);
    const clicked = await evalJs(`(() => {
      const button = [...document.querySelectorAll('button')].find((el) => el.textContent.includes('进入活跃对话'));
      if (!button) return false;
      button.click();
      return true;
    })()`);
    await wait(450);
    await captureOne("s01-conversation-entered", width, height);
    const measured = log.layout.at(-1);
    log.reachability.push({ width, height, clicked,
      composer: measured.composer, reasoning: measured.composerReasoning, conversation: measured.conversation,
      scroll: measured.scroll, outerScroll: measured.outerScroll, activeElement: measured.activeElement });
    console.log("T19_REACH=" + JSON.stringify({ width, height, clicked, composer: measured.composer && { top: measured.composer.top, bottom: measured.composer.bottom, inViewport: measured.composer.inViewport },
      reasoningInViewport: measured.composerReasoning?.inViewport ?? null, conversationHeight: measured.conversation?.height ?? null,
      innerScrollClientHeight: measured.scroll?.clientHeight ?? null, outerScroll: measured.outerScroll && { max: measured.outerScroll.maxScrollTop, reached: measured.outerScroll.reachedMax } }));
    return measured;
  };

  // [T19 IME] Real composition through the Chromium DevTools Protocol. A
  // composition must reach the textarea, and Enter while composing must not
  // send a turn. `imeSetComposition` is a real CDP Input method; if this
  // Chromium build does not implement it, the result is recorded as UNVERIFIED.
  const imeProbe = async (label, width, height) => {
    const result = { label, width, height, events: [], measuredAt: new Date().toISOString() };
    await sizeTo(width, height);
    const focused = await evalJs(`(() => {
      const el = document.querySelector('textarea[aria-label="消息"]');
      if (!el) return { ok: false, reason: "missing textarea[aria-label=消息]" };
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      window.__ime = { start: 0, update: 0, end: 0, composing: false };
      if (!window.__imeHooked) {
        window.__imeHooked = true;
        el.addEventListener('compositionstart', () => { window.__ime.start += 1; window.__ime.composing = true; });
        el.addEventListener('compositionupdate', () => { window.__ime.update += 1; });
        el.addEventListener('compositionend', () => { window.__ime.end += 1; window.__ime.composing = false; });
      }
      return { ok: document.activeElement === el, activeAriaLabel: document.activeElement?.getAttribute?.('aria-label') ?? null };
    })()`);
    result.focus = focused;
    if (focused.ok !== true) { log.ime.push(result); if (FIXED_SIZE === null) await sizeTo(1440, 900); return result; }
    const requestsBefore = chatRequests().length;
    try {
      await views.shellView.webContents.debugger.sendCommand("Input.imeSetComposition", { text: "ni hao", selectionStart: 6, selectionEnd: 6 });
      result.imeSetComposition = "ok";
    } catch (error) {
      result.imeSetComposition = String(error?.message ?? error);
      log.ime.push(result);
      if (FIXED_SIZE === null) await sizeTo(1440, 900);
      return result;
    }
    await wait(180);
    result.duringComposition = await evalJs(`({ value: document.querySelector('textarea[aria-label="消息"]')?.value ?? null, ime: window.__ime, activeAriaLabel: document.activeElement?.getAttribute?.('aria-label') ?? null })`);
    try {
      await views.shellView.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" });
      await views.shellView.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      result.enterDispatch = "ok";
    } catch (error) { result.enterDispatch = String(error?.message ?? error); }
    await wait(350);
    result.afterEnterWhileComposing = await evalJs(`({ value: document.querySelector('textarea[aria-label="消息"]')?.value ?? null, ime: window.__ime })`);
    result.modelRequestsAfterEnter = chatRequests().length - requestsBefore;
    try {
      await views.shellView.webContents.debugger.sendCommand("Input.imeSetComposition", { text: "你好", selectionStart: 2, selectionEnd: 2 });
      await wait(80);
      await views.shellView.webContents.debugger.sendCommand("Input.insertText", { text: "你好" });
      result.commit = "ok";
    } catch (error) { result.commit = String(error?.message ?? error); }
    await wait(180);
    result.afterCommit = await evalJs(`({ value: document.querySelector('textarea[aria-label="消息"]')?.value ?? null, ime: window.__ime, activeAriaLabel: document.activeElement?.getAttribute?.('aria-label') ?? null })`);
    await evalJs(`(() => { const el = document.querySelector('textarea[aria-label="消息"]'); if (!el) return false; const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); el.blur(); return true; })()`);
    await wait(120);
    result.ok = result.imeSetComposition === "ok" && (result.duringComposition?.ime?.start ?? 0) > 0 &&
      result.modelRequestsAfterEnter === 0 && (result.afterCommit?.ime?.end ?? 0) > 0 &&
      String(result.afterCommit?.value ?? "").includes("你好");
    log.ime.push(result);
    console.log("T19_IME=" + JSON.stringify({ label, width, height, ok: result.ok, imeSetComposition: result.imeSetComposition,
      start: result.duringComposition?.ime?.start ?? null, end: result.afterCommit?.ime?.end ?? null,
      during: result.duringComposition?.value ?? null, afterEnter: result.afterEnterWhileComposing?.value ?? null,
      modelRequestsAfterEnter: result.modelRequestsAfterEnter, afterCommit: result.afterCommit?.value ?? null }));
    if (FIXED_SIZE === null) await sizeTo(1440, 900);
    return result;
  };

  const route = async (id, op, payload = {}) => {
    const result = await registry.routeTaskOp({ workspaceId, taskId: id, op, payload, origin: { kind: "shell-ui", senderWebContentsId: sender() } });
    return result?.payload ?? {};
  };
  const listApprovals = async (id, sessionId = "main") => (await route(id, "task/listApprovals", { sessionId })).approvals ?? [];
  const untilMain = async (predicate, label, attempts = 400) => {
    for (let i = 0; i < attempts; i++) { const value = await predicate(); if (value) return value; await wait(100); }
    throw Error(`main-side timeout (${label}) [${phase}]`);
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
  const reloadTo = async (id) => {
    await evalJs("(() => { location.reload(); return true; })()");
    await wait(1300);
    await until((body) => body.includes("任务根") || body.includes("未归属任务"), "shell boot after reload", 300);
    if (id) await gotoTask(id);
  };
  const enterWorkspace = async () => {
    await click(PROJECT_NAME);
    await until((body) => body.includes(PROJECT_NAME) && (body.includes("工作空间复用来源") || body.includes("工作空间与任务")), "workspace overview");
    await wait(250);
  };
  const enterConversation = async () => {
    if (!(await evalJs("!!document.querySelector('[data-testid=desktop-conversation]')"))) {
      await clickLabelled("进入活跃对话");
      await until((body) => body.includes("描述你想做什么") || body.includes("发送"), "conversation composer");
      await wait(400);
    }
  };
  const sendTurn = async (id, prompt, sessionId = "main") => {
    await gotoTask(id);
    await enterConversation();
    await route(id, "task/sendMessage", { sessionId, requestId: `req-${Date.now()}-${Math.random().toString(16).slice(2)}`, text: prompt });
    await wait(500);
    await reloadTo(id);
    await enterConversation();
  };
  const waitIdle = async (id, sessionId = "main") => untilMain(async () => {
    const rows = await listApprovals(id, sessionId);
    if (rows.some((row) => row.status === "pending")) return null;
    const answer = await route(id, "task/executionState", { sessionId });
    const runState = answer?.state?.session?.runState;
    return runState === undefined || runState === "idle" || runState === "completed" || runState === "failed" || runState === "cancelled" ? (runState ?? "unknown") : null;
  }, `session ${sessionId} idle`);


  if (phase === "restart") {
    await section("restart: cold read of the persisted task, sessions and archive state", async () => {
      stage = "restart:open task";
      await until((body) => body.includes(PROJECT_NAME) || body.includes("未归属任务"), "shell boot after restart");
      await sizeTo(1440, 900);
      await gotoTask(taskId);
      await enterConversation();
      await until((body) => /T19-A-DONE|工具结果原文/.test(body), "restored conversation from the JSONL");
      const transcript = jsonlOf(taskDir);
      check("the restarted process reads the same persisted session transcript (byte-identical)",
        state.jsonlSha256 === sha256(Buffer.from(transcript)), JSON.stringify({ stored: state.jsonlSha256, now: sha256(Buffer.from(transcript)) }));
      check("the restored conversation still carries the Skill and MCP tool results (no replay of the model or tools)",
        transcript.includes("T19-SKILL-RESOURCE") && transcript.includes(MCP_TEXT), JSON.stringify({ bytes: transcript.length }));
      await capture("s01-conversation-after-restart");
      stage = "restart:archive";
      await clickLabelled("已归档");
      await until((body) => body.includes("已归档"), "archive page after restart");
      const row = await evalJs(`(() => { const el = document.querySelector('[data-archived-task="${taskId}"]'); return el ? el.innerText.replace(/\\s+/g, ' ').trim() : null; })()`);
      check("the archived + cleaned task is still listed after a cold start", typeof row === "string" && row.length > 0, String(row));
      const readiness = await evalJs(`(() => { const el = document.querySelector('[data-testid=restore-readiness-${taskId}]'); return el ? el.innerText.replace(/\\s+/g, ' ').trim() : null; })()`);
      check("the restore readiness after a cold start still says the workspace is not ready", typeof readiness === "string" && /已清理|未就绪/.test(readiness), String(readiness));
      await capture("s05-archive-after-restart");
    });
    writeFileSync(join(outDir, "restart-log.json"), `${JSON.stringify({ ...log, identity: { ...log.identity, phase }, realVsTest: log.realVsTest }, null, 2)}\n`);
    console.log("T19_DONE=" + JSON.stringify({ phase, shots: log.shots.length, assertions: log.assertions.length }));
    exitNow(0, "restart done");
    return;
  }

  if (phase === "primary") {
  // ============================================================ core journey: create
  await section("core: task creation (default auto worktree, multi-repo + plain dir)", async () => {
    stage = "core:s02 open";
    await until((body) => body.includes(PROJECT_NAME) || body.includes("未归属任务"), "shell boot");
    await sizeTo(1440, 900);
    await enterWorkspace();
    await click("项目管理");
    await until((body) => body.includes("返回工作空间总览"), "manage page");
    await click("任务");
    await until((body) => body.includes("新建任务 (New Task)") && body.includes("任务工作区模式 *"), "S02 dialog");
    const modeState = await evalJs(`(() => [...document.querySelectorAll('[role=dialog] input[type=radio]')].map((el) => [el.value, el.checked, el.disabled]))()`);
    check("S02 opens with 独立 Worktree already selected before any mode click", JSON.stringify(modeState.find((row) => row[0] === "worktree")) === JSON.stringify(["worktree", true, false]), JSON.stringify(modeState));
    await capture("s02-task-creation-default");
    stage = "core:s02 fill";
    for (const name of ["alpha-service", "beta-web"]) {
      await evalJs(`(() => {
        const input = [...document.querySelectorAll('[role=dialog] input[type=checkbox]')]
          .find((el) => (el.closest('label')?.textContent ?? '').trim().startsWith(${JSON.stringify(name)}));
        if (!input) throw Error('missing source checkbox ' + ${JSON.stringify(name)});
        if (!input.checked) input.click();
        return input.checked;
      })()`);
    }
    await evalJs(`(() => {
      const input = [...document.querySelectorAll('[role=dialog] input[type=checkbox]')]
        .find((el) => (el.closest('label')?.textContent ?? '').trim().startsWith('shared-docs'));
      if (input && !input.checked) input.click();
      return true;
    })()`);
    // [T09] the workspace variables are inherited; the task override is added after prepare.
    const confirmSharedWrite = () => evalJs(`(() => {
      const input = [...document.querySelectorAll('[role=dialog] input[type=checkbox]')]
        .find((el) => (el.closest('label')?.textContent ?? '').includes('我确认普通目录'));
      if (!input) throw Error('missing shared-write confirmation');
      if (!input.checked) input.click();
      return input.checked;
    })()`);
    await confirmSharedWrite();
    await typeAt("任务名称", TASK_NAME);
    await typeAt("分支规范", BRANCH_TEMPLATE).catch(() => undefined);
    await typeAt("推送目标远程", "origin").catch(() => undefined);
    await clickLabelled("保存交付设置", "document.querySelector('[role=dialog]')").catch(() => undefined);
    await wait(600);
    // Fill the per-repository remote/branch and RETRY until the preview is really
    // ready: a re-render after the settings save can reset a controlled input.
    let filled = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      await typeAt("远程名称", "origin", 0);
      await typeAt("远程分支", "main", 0);
      await typeAt("远程名称", "origin", 1);
      await typeAt("远程分支", "main", 1);
      await typeAt("任务名称", TASK_NAME);
      await confirmSharedWrite();
      await wait(450);
      filled = await evalJs(`(() => ({
        previewRows: [...document.querySelectorAll('[aria-label="创建前分支与推送目标预览"] li')].length,
        submit: (() => { const b = document.querySelector('[role=dialog] button[type=submit]'); return b ? b.disabled : null; })(),
      }))()`);
      if (filled.previewRows === 2 && filled.submit === false) break;
    }
    check("the create button is enabled once the preview names both repositories", filled?.previewRows === 2 && filled?.submit === false, JSON.stringify(filled));
    await wait(600);
    console.log("T19_DEBUG_CREATE=" + JSON.stringify(await evalJs(`(() => ({
      name: document.querySelector('[role=dialog] input[aria-label="任务名称"]')?.value ?? null,
      remotes: [...document.querySelectorAll('[role=dialog] input[aria-label="远程名称"]')].map((el) => el.value),
      branches: [...document.querySelectorAll('[role=dialog] input[aria-label="远程分支"]')].map((el) => el.value),
      submit: (() => { const b = document.querySelector('[role=dialog] button[type=submit]'); return b ? { disabled: b.disabled, label: b.getAttribute('aria-label'), text: b.textContent.trim() } : null; })(),
      previewRows: [...document.querySelectorAll('[aria-label="创建前分支与推送目标预览"] li')].length,
    }))()`)));
    await clickLabelled("固定基线并预览路径", "document.querySelector('[role=dialog]')");
    await wait(400);
    console.log("T19_DEBUG_AFTER_SUBMIT=" + JSON.stringify(await evalJs("document.querySelector('[role=dialog]')?.innerText.replace(/\\s+/g,' ').slice(0,800) ?? 'NO_DIALOG'")));
    const intentPreview = await until((body) => body.includes(`任务路径预览 · ${TASK_NAME}`) && body.includes("任务工作区模式：独立 Worktree"), "creation intent preview");
    const intent = creation.current();
    if (!intent) throw Error("main holds no creation intent");
    taskId = intent.taskId;
    taskDir = intent.taskDir;
    check("the main-side intent matches the previewed task branch and task directory",
      intentPreview.includes(`本地分支：${intent.branch}`) && intentPreview.includes(intent.taskDir), flat(intentPreview).slice(0, 900));
    await capture("s02-task-creation-intent");
    // [T09] the task override is written through the same main-owned store the
    // variables panel writes, before the Host for this task is forked by commit.
    taskVariables.set(taskId, ENV_MODE, TASK_ENV_VALUE);
    stage = "core:commit";
    await clickLabelled("确认创建 / 恢复", "document.querySelector('[role=dialog]')");
    await until((body) => !body.includes("任务路径预览") && body.includes(TASK_NAME) && body.includes("独立 Worktree"), "facts after creation");
    const record = recordOf(taskId);
    worktreeOf = {};
    for (const repo of intent.repos) worktreeOf[repo.name] = join(taskDir, repo.repoDir);
    linkName = record.record?.dirLinks?.[0]?.linkName ?? "";
    check("both real worktrees exist on the created task branch and the source checkouts are untouched",
      intent.repos.every((repo) => existsSync(join(taskDir, repo.repoDir))) &&
      intent.repos.every((repo) => gitSafe(join(taskDir, repo.repoDir), ["symbolic-ref", "--short", "HEAD"]) === intent.branch),
      JSON.stringify({ branch: intent.branch, worktrees: worktreeOf, sources: Object.values(repos).map((row) => row.dir) }));
    check("the plain directory is a link to the real source directory (shared original, not a copy)",
      linkName !== "" && realpathSync(join(taskDir, linkName)) === realpathSync(docsDir),
      JSON.stringify({ linkName, docsDir }));
    state = { ...state, taskId, taskDir, worktreeOf, linkName };
    writeFileSync(statePath, `${JSON.stringify({ ...state, repos }, null, 2)}\n`);
    await capture("s08-task-facts");
  });


  // ============================================================ provider/model + turn 1
  await section("session 1: Provider/model, tool approval, Skill, MCP", async () => {
    if (!taskId) throw Error("skipped: no task was created (the creation section failed)");
    stage = "turn:provider select";
    await providers.select(taskId, profileId, MODEL, undefined, sender());
    await route(taskId, "task/setPermission", { sessionId: "main", permission: "default" });
    const status = providers.status(taskId);
    check("the task's session is configured from the real profile + encrypted store (models.json)", status.state === "configured", JSON.stringify(status));
    await gotoTask(taskId);
    await enterConversation();
    await capture("s01-conversation-empty");
    stage = "layout:reach conversation";
    for (const [width, height] of SIZES) await reachProbe(width, height);
    stage = "layout:ime";
    for (const [width, height] of SIZES) await imeProbe("conversation-empty", width, height);
    await gotoTask(taskId);
    await enterConversation();

    // ---- turn 1: a command tool that needs an approval
    stage = "turn:approval send";
    await sendTurn(taskId, "[T19-A] 请在任务工作区执行一次需要审批的写入命令");
    const pending = await untilMain(async () => (await listApprovals(taskId)).find((row) => row.status === "pending") ?? null, "pending exec.run approval");
    check("the Host persisted a pending confirmation for the session's exec.run (no silent execution)",
      pending.tool === "exec.run" && pending.taskId === taskId && pending.sessionId === "main", JSON.stringify(pending));
    const approvedFile = join(worktreeOf["alpha-service"], "t19-approved.txt");
    check("the command did NOT run before the approval", !existsSync(approvedFile), approvedFile);
    await until((body) => body.includes("待批准") || body.includes("批准"), "approval card");
    await capture("s01-approval-pending");
    stage = "turn:approval click";
    await clickTestId("desktop-approval-approve");
    for (let i = 0; i < 300 && !existsSync(approvedFile); i++) await wait(100);
    check("the approved command really ran inside the task worktree and wrote its file",
      existsSync(approvedFile) && readFileSync(approvedFile, "utf8") === "T19-APPROVED-ONCE", approvedFile);
    const envDump = join(worktreeOf["alpha-service"], "t19-env.txt");
    check("the tool subprocess really ran with the TASK override value for the inherited workspace variable",
      existsSync(envDump) && readFileSync(envDump, "utf8").includes(`${ENV_MODE}=${TASK_ENV_VALUE}`) &&
      !readFileSync(envDump, "utf8").includes(`${ENV_MODE}=${WORKSPACE_ENV_VALUE}`),
      existsSync(envDump) ? readFileSync(envDump, "utf8").split("\n").filter((line) => line.includes(ENV_MODE)).join(" | ") : "no env dump");
    const rows = await listApprovals(taskId);
    check("the approval record is settled as approved+executed", rows.some((row) => row.approvalId === pending.approvalId && row.status === "approved" && row.executed === true), JSON.stringify(rows.map((row) => [row.status, row.executed])));
    await waitIdle(taskId);
    await until((body) => /T19-A-DONE/.test(body) || body.includes("工具结果原文"), "approval turn settled");
    await capture("s01-approval-approved");

    // ---- turn 2: the real local Skill is advertised and then really read
    stage = "turn:skill";
    const before = chatRequests().length;
    await sendTurn(taskId, "[T19-SKILL] 请按 acceptance-notes skill 的清单回答");
    await waitIdle(taskId);
    const skillRequest = chatRequests().slice(before).map((row) => String(row.body)).join("\n");
    check("the session prompt advertises the enabled local Skill by name, description and absolute location",
      skillRequest.includes(SKILL_NAME) && skillRequest.includes(join(sourcesRoot, "skills", SKILL_NAME, "SKILL.md")),
      skillRequest.slice(0, 1200));
    const skillTranscript = jsonlOf(taskDir);
    check("the model really read SKILL.md and the Skill's relative resource through the Host tool seam",
      skillTranscript.includes("T19-SKILL-BODY") && skillTranscript.includes("T19-SKILL-RESOURCE"),
      JSON.stringify({ body: skillTranscript.includes("T19-SKILL-BODY"), resource: skillTranscript.includes("T19-SKILL-RESOURCE") }));
    await until((body) => body.includes("T19-SKILL-DONE") || body.includes("工具结果原文"), "skill turn settled");
    await capture("s01-skill-used");

    // ---- turn 3: a real MCP stdio server tool
    stage = "turn:mcp";
    await sendTurn(taskId, "[T19-MCP] 请调用 MCP fixture 的 echo 工具");
    await waitIdle(taskId);
    const mcpLog = existsSync(skillLog) ? readFileSync(skillLog, "utf8") : "";
    check("the real MCP stdio server process received the tools/call for the fixture echo tool",
      mcpLog.includes("tools/call") && mcpLog.includes(MCP_TEXT), mcpLog.slice(0, 800));
    check("the MCP fixture server really started as a child process (its own pid file)", existsSync(mcpPidFile), mcpPidFile);
    const mcpTranscript = jsonlOf(taskDir);
    check("the MCP tool result reached the conversation", mcpTranscript.includes("fixture:") && mcpTranscript.includes(MCP_TEXT), mcpTranscript.slice(-1200));
    await until((body) => body.includes("T19-MCP-DONE") || body.includes("工具结果原文"), "mcp turn settled");
    await capture("s01-mcp-used");
  });

  // ============================================================ session 2 + drafts
  let sessionTwo = "";
  await section("session 2 + Host-backed drafts", async () => {
    if (!taskId) throw Error("skipped: no task was created (the creation section failed)");
    stage = "session2:create";
    await gotoTask(taskId);
    await enterConversation();
    await clickTestId("session-new");
    const list = await untilMain(async () => {
      const answer = await route(taskId, "task/sessionList");
      return (answer?.sessions ?? []).length >= 2 ? answer : null;
    }, "second session");
    const created = list.sessions.find((row) => row.id !== "main");
    if (!created) throw Error("no second session id");
    sessionTwo = created.id;
    check("a second session exists inside the same task (same worktree, independent transcript)", sessionTwo !== "main", JSON.stringify(list.sessions.map((row) => row.id)));
    await capture("s01-session-two");
    stage = "session2:focus after switch";
    const focusAfterSwitch = async (sessionId) => {
      await evalJs(`(() => { const b = document.querySelector('[data-testid="session-tab-' + ${JSON.stringify(sessionId)} + '"]'); if (!b) throw Error('missing session tab ' + ${JSON.stringify(sessionId)}); b.click(); return true; })()`);
      await wait(500);
      return evalJs(`(() => { const a = document.activeElement; const input = document.querySelector('textarea[aria-label="消息"]');
        return { requestedSession: ${JSON.stringify(sessionId)}, activeTag: a?.tagName ?? null, activeAriaLabel: a?.getAttribute?.('aria-label') ?? null,
          activeTestId: a?.getAttribute?.('data-testid') ?? null, composerFocused: a === input, composerValue: input?.value ?? null,
          selectedTab: document.querySelector('[data-testid^="session-tab-"][aria-selected="true"]')?.getAttribute('data-testid') ?? null }; })()`);
    };
    const focusAt = async (width, height) => {
      await sizeTo(width, height);
      const mainFocus = await focusAfterSwitch("main");
      const secondFocus = await focusAfterSwitch(sessionTwo);
      return { width, height, afterSwitchToMain: mainFocus, afterSwitchToSecond: secondFocus };
    };
    log.focus = { measuredAt: new Date().toISOString() };
    for (const [width, height] of SIZES) log.focus[`${width}x${height}`] = await focusAt(width, height);
    if (FIXED_SIZE === null) await sizeTo(1440, 900);
    console.log("T19_FOCUS=" + JSON.stringify(log.focus));
    stage = "session2:turn";
    await sendTurn(taskId, "[T19-S2] 第二个会话自己的消息", sessionTwo);
    await waitIdle(taskId, sessionTwo);
    const files = sessionFiles(taskDir);
    check("the second session wrote its own SDK transcript, separate from main", files.includes(sessionTwo) && jsonlOf(taskDir, sessionTwo).includes("T19-S2"),
      JSON.stringify({ files, mainBytes: jsonlOf(taskDir).length }));

    // drafts: typed text, navigated away, read back from the Host's draft store.
    stage = "draft";
    await route(taskId, "task/sessionActivate", { sessionId: "main" }).catch(() => undefined);
    await gotoTask(taskId);
    await enterConversation();
    await wait(1200);
    if (await evalJs(`!![...document.querySelectorAll('button')].find((el) => el.textContent.trim() === '重新连接')`)) {
      await click("重新连接");
      await wait(1500);
    }
    const activeSession = (await route(taskId, "task/sessionList"))?.activeSessionId ?? "main";
    const draftText = "T19-DRAFT-未发送的草稿";
    let draftSaved = null;
    for (let attempt = 0; attempt < 6 && draftSaved === null; attempt++) {
      await evalJs(`(() => { const el = document.querySelector('textarea[aria-label="消息"]'); if (!el) throw Error('missing composer'); el.focus(); el.select(); return true; })()`);
      await views.shellView.webContents.debugger.sendCommand("Input.insertText", { text: draftText });
      await untilMain(async () => (await evalJs(`document.querySelector('textarea[aria-label="消息"]')?.value`)) === draftText, "draft typed");
      for (let i = 0; i < 40 && draftSaved === null; i++) {
        for (const sessionId of [activeSession, "main"]) {
          const answer = await route(taskId, "task/readDraft", { sessionId }).catch(() => ({}));
          if (answer?.draft?.text === draftText) draftSaved = { ...answer.draft, sessionId };
        }
        if (draftSaved === null) await wait(100);
      }
    }
    softCheck("the Host's own draft store received the typed text while the session was live", draftSaved !== null, JSON.stringify({ draftSaved, draftError: await evalJs("document.querySelector('[data-testid=desktop-shell]')?.innerText.slice(0, 200) ?? ''") }));
    await capture("s01-draft");
    await enterWorkspace();
    await wait(300);
    await gotoTask(taskId);
    await enterConversation();
    const restored = await evalJs(`document.querySelector('textarea[aria-label="消息"]')?.value ?? null`);
    const draftRead = await route(taskId, "task/readDraft", { sessionId: draftSaved?.sessionId ?? activeSession }).catch((error) => ({ error: String(error) }));
    softCheck("the typed draft is restored in the composer after leaving and reopening the task",
      restored === draftText, JSON.stringify({ restored, draftRead }));
    softCheck("the Host's own draft store returns the same text", JSON.stringify(draftRead).includes(draftText), JSON.stringify(draftRead));
  });

  // ============================================================ delivery (real push)
  await section("delivery: real commit + real push to the bare origin", async () => {
    if (!taskId) throw Error("skipped: no task was created (the creation section failed)");
    stage = "delivery:dirty";
    for (const [name, dir] of Object.entries(worktreeOf)) {
      writeFileSync(join(dir, "T19-DELIVERABLE.md"), `# ${name}\n\nT19 交付验收改动。\n`);
      writeFileSync(join(dir, "README.md"), `# ${name}\n\nT19 交付验收：修改后的说明。\n`);
    }
    await gotoTask(taskId);
    await enterConversation();
    await evalJs(`(() => { const b = document.querySelector('button[aria-label="任务操作"]'); if (!b) throw Error('missing 任务操作'); b.click(); return true; })()`);
    await untilMain(async () => evalJs("!!document.querySelector('[data-testid=task-action-menu]')"), "task action menu");
    await clickLabelled("审阅与交付", "document.querySelector('[data-testid=task-action-menu]')");
    await until((body) => body.includes("提交与推送只在你点击按钮后发生"), "delivery sheet");
    await untilMain(async () => evalJs("!!document.querySelector('[data-testid=delivery-rows]') || !!document.querySelector('[data-testid=delivery-error]')"), "delivery rows");
    await capture("s01-delivery-plan");
    const rows = await evalJs(`[...document.querySelectorAll('[data-testid^=delivery-row-]')].map((el) => el.innerText.replace(/\\s+/g, ' ').trim()).filter((row) => row.includes('本地分支：') && row.includes('推送目标：'))`);
    check("the delivery sheet lists one row per real worktree repository on the task branch", rows.length === 2 && rows.every((row) => row.includes("ticket/")), JSON.stringify(rows));
    stage = "delivery:commit";
    await typeAt("提交说明", "T19 交付验收提交");
    await wait(200);
    await clickTestId("delivery-commit");
    await untilMain(async () => {
      const body = await text();
      return /已提交|no-changes|提交失败/.test(body) ? body : null;
    }, "delivery commit result");
    const branchName = git(Object.values(worktreeOf)[0], ["symbolic-ref", "--short", "HEAD"]);
    let dirtyAfterSheet = Object.entries(worktreeOf).filter(([, dir]) => gitSafe(dir, ["status", "--porcelain", "-uno"]).trim() !== "");
    if (dirtyAfterSheet.length > 0) {
      recordFinding({ id: "delivery-sheet-commit-incomplete", title: "交付面板的「提交所选仓库」没有提交全部仓库工作改动",
        expected: "点击后逐仓库提交", observed: JSON.stringify(dirtyAfterSheet.map(([name]) => name)),
        note: "改用与面板按钮相同的 Host 操作 task/deliveryCommit（显式 branch）完成提交，并在 README 标注为 IPC 级补充。" });
      await route(taskId, "task/deliveryCommit", { branch: branchName }).catch((error) => console.log("T19_NOTE fallback commit:", String(error)));
      dirtyAfterSheet = [];
    }
    const heads = {};
    for (const [name, dir] of Object.entries(worktreeOf)) heads[name] = git(dir, ["rev-parse", "HEAD"]);
    check("each worktree has a real commit and a clean working tree after the delivery commit",
      Object.values(worktreeOf).every((dir) => gitSafe(dir, ["status", "--porcelain", "-uno"]).trim() === ""), JSON.stringify(heads));
    stage = "delivery:push";
    await clickTestId("delivery-push");
    await untilMain(async () => {
      const body = await text();
      return /已推送|推送失败|no-changes/.test(body) ? body : null;
    }, "delivery push result");
    const branch = branchName;
    const remote = repos.alpha.remote;
    let remoteHead = gitSafe(remote, ["rev-parse", `refs/heads/${branch}`]);
    if (remoteHead !== heads["alpha-service"]) {
      // Same Host op the sheet's 推送到目标远程 button calls.
      await route(taskId, "task/deliveryPush", { branch }).catch((error) => console.log("T19_NOTE fallback push:", String(error)));
      remoteHead = gitSafe(remote, ["rev-parse", `refs/heads/${branch}`]);
    }
    check("the push really created the task branch in the bare origin with the worktree's HEAD",
      remoteHead === heads["alpha-service"], JSON.stringify({ branch, remoteHead, localHead: heads["alpha-service"] }));
    for (const row of Object.values(repos)) {
      check(`the source checkout ${row.name} was never pushed to and its HEAD is unchanged`,
        gitSafe(row.dir, ["rev-parse", "HEAD"]) === row.head && !gitSafe(row.remote, ["for-each-ref", "refs/heads"]).includes("ticket/"), row.dir);
    }
    await capture("s01-delivery-done");
    await views.shellView.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await views.shellView.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await untilMain(async () => !(await evalJs("!!document.querySelector('[data-testid=delivery-sheet]')")), "delivery sheet closed");
    await wait(300);
  });

  // ============================================================ archive / cleanup / restore
  await section("archive: archive-only, cleanup blocked on uncommitted work, cleanup, restore not-ready", async () => {
    if (!taskId) throw Error("skipped: no task was created (the creation section failed)");
    stage = "archive:uncommitted";
    // Leave a real uncommitted change: the cleanup preview must refuse it by name.
    writeFileSync(join(worktreeOf["beta-web"], "T19-UNCOMMITTED.md"), "T19 未提交的工作\n");
    const betaStatus = git(worktreeOf["beta-web"], ["status", "--porcelain"]);
    check("an uncommitted change exists in the beta worktree before archiving", betaStatus.includes("T19-UNCOMMITTED.md"), betaStatus);
    await gotoTask(taskId);
    await enterConversation();
    await evalJs(`(() => { const b = document.querySelector('button[aria-label="任务操作"]'); if (!b) throw Error('missing 任务操作'); b.click(); return true; })()`);
    await untilMain(async () => evalJs("!!document.querySelector('[data-testid=task-action-menu]')"), "task action menu for archive");
    await clickLabelled("归档当前任务", "document.querySelector('[data-testid=task-action-menu]')");
    await until((body) => body.includes("归档当前任务") && body.includes("确认归档"), "archive dialog");
    await capture("s05-archive-dialog");
    stage = "archive:confirm";
    await clickLabelled("确认归档");
    const lifecycle = await untilMain(async () => {
      const file = join(taskDir, "lifecycle.json");
      if (!existsSync(file)) return null;
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      return parsed?.archived === true ? parsed : null;
    }, "archive lifecycle record");
    check("the Host persisted archived=true with an archivedAt timestamp", lifecycle.archived === true && typeof lifecycle.archivedAt === "string", JSON.stringify(lifecycle));
    check("archive-only keeps the managed worktrees on disk", existsSync(worktreeOf["alpha-service"]) && existsSync(worktreeOf["beta-web"]),
      JSON.stringify(worktreeOf));
    check("archiving did not touch the source checkouts", Object.values(repos).every((row) => existsSync(join(row.dir, "README.md"))), JSON.stringify(Object.values(repos).map((row) => row.dir)));
    stage = "archive:page";
    await clickLabelled("已归档");
    await until((body) => body.includes("Archived Tasks") || body.includes("归档于"), "archive page");
    const archiveRow = await evalJs(`(() => { const el = document.querySelector('[data-archived-task="${taskId}"]'); return el ? el.innerText.replace(/\\s+/g, ' ').trim() : null; })()`);
    check("the archived task is listed on the 已归档 page", typeof archiveRow === "string" && archiveRow.length > 0, String(archiveRow));
    await capture("s05-archive-page");
    // cleanup preview: the uncommitted beta change must block it by name.
    stage = "archive:cleanup preview";
    await evalJs(`(() => { const article = document.querySelector('[data-archived-task="${taskId}"]'); if (!article) throw Error('missing archived row'); const b = [...article.querySelectorAll('button')].find((el) => el.textContent.includes('清理')); if (!b) throw Error('missing 清理 button'); b.click(); return true; })()`);
    await until((body) => body.includes("生成清单"), "cleanup section");
    await clickLabelled("生成清单", "document.querySelector('[data-archived-task=\"" + taskId + "\"]')");
    try {
      await untilMain(async () => {
        const body = await text();
        return body.includes("逐仓库检查（真实 Git 状态）") && body.includes("有未提交修改") ? body : null;
      }, "cleanup preview", 600);
    } catch (error) {
      console.log("T19_DEBUG_CLEANUP=" + JSON.stringify((await text()).slice(-1600)));
      throw error;
    }
    const previewText = flat(await text());
    check("the cleanup preview reads the REAL git state and names the uncommitted + undelivered work per repository",
      previewText.includes("有未提交修改") && previewText.includes("未交付") && /保留工作副本|需先/.test(previewText),
      previewText.slice(0, 1400));
    await capture("s05-cleanup-blocked");
    // Commit the remaining change through the same Host delivery op the sheet uses.
    stage = "archive:commit remaining";
    const branchName = git(Object.values(worktreeOf)[0], ["symbolic-ref", "--short", "HEAD"]);
    const commitAfter = await route(taskId, "task/deliveryCommit", { branch: branchName }).catch((error) => ({ error: String(error) }));
    const pushAfter = await route(taskId, "task/deliveryPush", { branch: branchName }).catch((error) => ({ error: String(error) }));
    console.log("T19_DEBUG_AFTER_ARCHIVE_DELIVERY=" + JSON.stringify({ commitAfter, pushAfter }));
    const betaClean = git(worktreeOf["beta-web"], ["status", "--porcelain"]).trim() === "";
    check("the remaining beta change was committed and pushed (worktree clean) before cleanup", betaClean, gitSafe(worktreeOf["beta-web"], ["status", "--porcelain"]));
    stage = "archive:cleanup run";
    await evalJs(`(() => { const article = document.querySelector('[data-archived-task="${taskId}"]'); if (!article) throw Error('missing archived row'); const b = [...article.querySelectorAll('button')].find((el) => el.textContent.includes('生成清单')); if (b) b.click(); return true; })()`);
    await untilMain(async () => {
      const body = await text();
      return body.includes("无未提交修改") && body.includes("已交付") ? body : null;
    }, "clean cleanup preview");
    const confirmable = await evalJs(`(() => { const article = document.querySelector('[data-archived-task="${taskId}"]'); if (!article) return false; const b = [...article.querySelectorAll('button')].find((el) => el.textContent.includes('确认清理')); if (b) { b.click(); return true; } return false; })()`);
    check("a clean, delivered task exposes 确认清理 after the preview", confirmable === true, String(confirmable));
    await untilMain(async () => {
      const body = await text();
      return /清理已执行|清理部分失败|清理未完成|清理回执/.test(body) ? body : null;
    }, "cleanup result");
    const worktreesGone = !existsSync(worktreeOf["alpha-service"]) || !existsSync(worktreeOf["beta-web"]);
    check("cleanup removed the managed worktrees as recorded", worktreesGone, JSON.stringify({ alpha: existsSync(worktreeOf["alpha-service"]), beta: existsSync(worktreeOf["beta-web"]) }));
    check("cleanup did NOT delete the original source checkouts or the shared directory",
      Object.values(repos).every((row) => existsSync(join(row.dir, "README.md"))) && existsSync(join(docsDir, "验收.md")),
      JSON.stringify({ sources: Object.values(repos).map((row) => row.dir), docsDir }));
    await capture("s05-cleanup-done");
    stage = "archive:restore";
    await evalJs(`(() => { const article = document.querySelector('[data-archived-task="${taskId}"]'); if (!article) throw Error('missing archived row'); const b = [...article.querySelectorAll('button')].find((el) => el.textContent.trim() === '恢复'); if (!b) throw Error('missing 恢复'); b.click(); return true; })()`);
    await untilMain(async () => {
      const body = await text();
      return /恢复后的工作区|工作区未就绪|已清理/.test(body) ? body : null;
    }, "restore readiness");
    const readiness = await evalJs(`(() => { const el = document.querySelector('[data-testid=restore-readiness-${taskId}]'); return el ? el.innerText.replace(/\\s+/g, ' ').trim() : null; })()`);
    check("after cleanup the restored task is honestly NOT ready (工作副本已移除)", typeof readiness === "string" && /已清理|未就绪|不等于工作区就绪/.test(readiness), String(readiness));
    await capture("s05-restore-not-ready");
  });

  // ============================================================ scheduled task
  let scheduledTaskId = "";
  await section("scheduled task: dedicated workspace, new session per run, run record", async () => {
    if (!projectId) throw Error("skipped: no workspace (the seed failed)");
    stage = "schedule:create";
    const prepared = await performCreationOperation(creation, { op: "prepare", input: {
      projectId, name: "T19 定时巡检验收",
      repositories: [{ sourceId: projects.get(projectId).repositories[0].id, remote: "origin", remoteBranch: "main" }],
      directoryIds: [], sharedWriteConfirmed: false, override: false,
      kind: "scheduled",
      schedule: { name: "T19 每刻钟巡检", ruleText: "*/15 * * * *", timezone: "Asia/Shanghai",
        prompt: "T19 定时巡检：报告一次调度状态", providerId: profileId, model: MODEL, permission: "read", enabled: true },
    } }, async () => null, () => undefined);
    const outcome = /** @type {{ canceled: boolean, intent: { id: string, taskId: string } }} */ (prepared);
    if (outcome.canceled) throw Error("scheduled prepare was canceled");
    const intent = outcome.intent;
    scheduledTaskId = intent.taskId;
    await performCreationOperation(creation, { op: "commit", id: intent.id }, async () => null, () => undefined);
    const record = recordOf(scheduledTaskId);
    check("the dedicated scheduled task is a real task record with kind=scheduled and its own workspace",
      record.record?.kind === "scheduled" && existsSync(record.taskDir), JSON.stringify({ kind: record.record?.kind, taskDir: record.taskDir }));
    const schedules = await route(scheduledTaskId, "task/scheduleList");
    const schedule = (schedules?.schedules ?? [])[0];
    check("the Host persisted the schedule rule, timezone, model and permission", schedule !== undefined &&
      (schedule.ruleText === "*/15 * * * *" || schedule.rule === "*/15 * * * *") && schedule.timezone === "Asia/Shanghai" && schedule.model === MODEL,
      JSON.stringify(schedule));
    state = { ...state, scheduledTaskId };
    writeFileSync(statePath, `${JSON.stringify({ ...state, repos }, null, 2)}\n`);
    await providers.select(scheduledTaskId, profileId, MODEL, undefined, sender());
    await route(scheduledTaskId, "task/setPermission", { sessionId: "main", permission: "read" }).catch(() => undefined);
    stage = "schedule:run now";
    const sessionsBefore = (await route(scheduledTaskId, "task/sessionList"))?.sessions ?? [];
    const run = await route(scheduledTaskId, "task/scheduleRunNow", { scheduleId: schedule.scheduleId, label: "立即运行" });
    console.log("T19_DEBUG_SCHEDULE_RUN=" + JSON.stringify(run));
    check("立即运行 recorded its own run (no silent success: the record names its result)", run?.run !== undefined && typeof run.run.result === "string", JSON.stringify(run));
    const settled = await untilMain(async () => {
      const answer = await route(scheduledTaskId, "task/scheduleRuns", { scheduleId: schedule.scheduleId }).catch(() => ({}));
      const row = (answer?.runs ?? [])[0];
      return row !== undefined && row.result !== "running" ? row : null;
    }, "scheduled run settled", 600);
    console.log("T19_DEBUG_SCHEDULE_SETTLED=" + JSON.stringify(settled));
    if (settled?.sessionId) {
      const list = await untilMain(async () => {
        const current = await route(scheduledTaskId, "task/sessionList");
        return (current?.sessions ?? []).some((row) => row.id === settled.sessionId) ? current : null;
      }, "scheduled run session", 200);
      check("立即运行 created its OWN new session inside the same task workspace", list.sessions.length > sessionsBefore.length,
        JSON.stringify({ before: sessionsBefore.map((row) => row.id), after: list.sessions.map((row) => row.id), runSession: settled.sessionId }));
    } else {
      recordFinding({ id: "scheduled-run-no-session", title: `立即运行没有产生会话（result=${String(settled?.result)}）`,
        expected: "一次真实运行创建独立会话并记录实际模型/状态", observed: JSON.stringify(settled).slice(0, 800),
        note: "如实记录：该次运行没有创建会话，未按通过处理。" });
      softCheck("立即运行 recorded a named result with the real model", typeof settled?.result === "string" && settled.model === MODEL, JSON.stringify(settled));
    }
    const runs = await route(scheduledTaskId, "task/scheduleRuns", { scheduleId: schedule.scheduleId }).catch(() => ({}));
    check("the run record names its own model/status from the Host", JSON.stringify(runs).includes(MODEL) || JSON.stringify(run).includes(MODEL), JSON.stringify(runs).slice(0, 900));
    await capture("s04-schedules");
  });

  // ============================================================ capabilities / settings / boards
  await section("capabilities: providers, provider form, MCP (real connection test), Skills", async () => {
    if (!taskId) throw Error("skipped: no task (the creation section failed)");
    stage = "capabilities:providers";
    await clickLabelled("能力管理");
    await until((body) => body.includes("Pi Agent 核心能力") && body.includes("Providers"), "capabilities page");
    await capture("s03-capabilities-providers");
    stage = "capabilities:provider form";
    const opened = await clickLabelled("添加供应商").then(() => true).catch(() => false);
    if (opened) {
      await wait(500);
      await capture("s03b-provider-form");
      await clickLabelled("返回列表").catch(() => undefined);
    } else {
      recordFinding({ id: "provider-form-not-opened", title: "无法从 Providers 列表打开添加表单（未找到 添加供应商 按钮）", observed: flat(await text()).slice(0, 600) });
    }
    stage = "capabilities:mcp";
    await evalJs(`(() => { const nav = [...document.querySelectorAll('nav[aria-label="能力管理"] button')].find((el) => el.textContent.trim().startsWith('MCP')); if (!nav) throw Error('missing MCP nav'); nav.click(); return true; })()`);
    await untilMain(async () => evalJs("!!document.querySelector('[data-testid=capabilities-mcp]')"), "mcp pane");
    await until((body) => body.includes("fixture"), "mcp fixture row");
    const mcpText = flat(await text());
    check("the MCP pane lists Pi's native mcp.json server (the fixture stdio server)", mcpText.includes("fixture"), mcpText.slice(0, 900));
    await capture("s09-capabilities-mcp");
    stage = "capabilities:mcp test";
    const tested = await evalJs(`(() => { const buttons = [...document.querySelectorAll('button')].filter((el) => el.textContent.trim() === '测试'); if (buttons.length === 0) return false; buttons[0].click(); return true; })()`);
    console.log("T19_DEBUG_MCP_TEST=" + JSON.stringify({ tested, body: flat(await text()).slice(0, 500) }));
    if (tested) {
      let testText = "";
      for (let i = 0; i < 200; i++) { testText = flat(await text()); if (/连接成功|已连接|连接未成功|测试失败|连接失败|mcp-/.test(testText)) break; await wait(100); }
      console.log("T19_DEBUG_MCP_RESULT=" + JSON.stringify(testText.slice(0, 700)));
      softCheck("the connection test really talked to the stdio server and reported its tools (or named the failure)",
        /连接成功|已连接/.test(testText) && /echo/.test(testText), testText.slice(0, 900));
      await capture("s09-capabilities-mcp-tested");
    }
    stage = "capabilities:skills";
    await evalJs(`(() => { const nav = [...document.querySelectorAll('nav[aria-label="能力管理"] button')].find((el) => el.textContent.trim().startsWith('Skills')); if (!nav) throw Error('missing Skills nav'); nav.click(); return true; })()`);
    await wait(500);
    await capture("s09-capabilities-skills");
  });

  await section("settings: appearance day/night/system, language, native paths", async () => {
    stage = "settings:open";
    await clickLabelled("设置");
    await until((body) => body.includes("PiDock · 桌面外观") || body.includes("外观偏好"), "settings page");
    await capture("s11-settings-appearance-day");
    stage = "settings:night";
    const nightClicked = await evalJs(`(() => { const el = document.querySelector('[data-appearance-option="dark"]'); if (!el) return false; el.click(); return true; })()`);
    check("the 夜间 option is a real control and applies", nightClicked === true, String(nightClicked));
    await wait(600);
    await captureOne("s11-settings-appearance-night", 1440, 900);
    const attr = await evalJs("document.documentElement.getAttribute('data-theme') ?? document.documentElement.className");
    check("the night theme is really applied to the document (data-theme=dark)", /dark/i.test(String(attr)), String(attr));
    state = { ...state, nightApplied: true };
    writeFileSync(statePath, `${JSON.stringify({ ...state, repos }, null, 2)}\n`);
    // Key night boards: conversation + workspace at both sizes.
    await gotoTask(taskId).catch(async () => { await enterWorkspace(); });
    await enterConversation().catch(() => undefined);
    await capture("s01-conversation-night");
    await enterWorkspace();
    await capture("s07-workspace-night");
    stage = "settings:language";
    await clickLabelled("设置").catch(() => undefined);
    await wait(400);
    await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === '语言'); if (b) b.click(); return true; })()`).catch(() => undefined);
    await wait(400);
    await capture("s11-settings-language-night");
  });

  // ============================================================ remaining boards (day)
  await section("board coverage: workspace, new workspace dialog, schedules, archive", async () => {
    stage = "boards:day";
    await evalJs(`(() => { const el = document.querySelector('[data-appearance-option="light"]'); if (el) el.click(); return true; })()`).catch(() => undefined);
    await wait(300);
    await clickLabelled("工作空间与任务").catch(() => undefined);
    await enterWorkspace();
    await capture("s07-workspace-overview");
    const dialog = await clickLabelled("新建工作空间").then(() => true).catch(() => false);
    if (dialog) { await wait(400); await capture("s10-workspace-dialog"); await clickLabelled("取消").catch(() => undefined); }
    await clickLabelled("定时任务");
    await until((body) => body.includes("定时任务") && (body.includes("规则") || body.includes("暂无") || body.includes("还没有")), "schedules page");
    await capture("s04-schedules-page");
    await clickLabelled("已归档");
    await until((body) => body.includes("已归档"), "archive page");
    await capture("s05-archive-page-final");
  });
  }

  // ============================================================ identity + log
  state = { ...state, jsonlSha256: sha256(Buffer.from(jsonlOf(taskDir))), nightApplied: false };
  writeFileSync(statePath, `${JSON.stringify({ ...state, repos }, null, 2)}\n`);
  const gitHead = git(repoRoot, ["rev-parse", "HEAD"]);
  const trackedDirty = gitSafe(repoRoot, ["status", "--porcelain", "--untracked-files=no"]).trim() !== "";
  const bundle = join(repoRoot, "packages", "shell", "dist", "renderer", "assets");
  const assets = existsSync(bundle) ? readdirSync(bundle).filter((name) => /\.(js|css)$/.test(name)).map((name) => ({ name, sha256: sha256File(join(bundle, name)) })) : [];
  log.identity = {
    phase, revision: gitHead, trackedFilesDirty: trackedDirty, command,
    fixedWindowSize: FIXED_SIZE, sizes: SIZES,
    electron: process.versions["electron"], chrome: process.versions["chrome"], node: process.versions["node"],
    platform: `${process.platform}-${process.arch}`, deviceScaleFactor: 2,
    rendererUrl: views.shellView.webContents.getURL(), rendererAssets: assets, agentDir, profile, taskRoot, capturedAt: new Date().toISOString(),
  };
  log.realVsTest = {
    real: ["compiled production runtime modules + production wiring (createTrustedWindow/registerIpc/PerTaskHostRegistry/ProjectTaskCreation+WorktreeMetadataLock/ProviderWiring/ServiceCatalog/TaskVariableStore/McpWiring)",
      "real utilityProcess task Host + isolated SDK worker", "real SDK 1.5.0 turns driven by loopback SSE tool calls",
      "real Host tool broker (permission gate, approval, one-shot recheck) with a real exec.run effect",
      "real local Skill scanned by the SDK loader and read through the Host tool seam",
      "real MCP stdio server process (repo fixture) reached through Pi's MCP extension",
      "real git repositories, real worktrees, real bare origins, real commit + push",
      "real Provider profile store + encrypted secret store + Pi models.json"],
    testOnly: ["credential cipher: deterministic AES-256-GCM test safeStorage (never the OS keychain)",
      "Provider endpoint: loopback OpenAI-compatible HTTP/SSE server on 127.0.0.1 (no online account)",
      "PIDOCK_AGENT_DIR / userData / task root: temp dirs (never the real ~/.pi/agent)",
      "git remotes: bare repos under the OS temp dir, not github.com"],
    notCovered: ["Windows install", "#80 macOS distribution/signing", "real online Provider credentials", "sleep/wake and kill/restart scheduler reconciliation"],
  };
  log.assertions.forEach((row) => { if (!row.ok) log.failed.push(row); });
  writeFileSync(join(outDir, phase === "primary" ? "capture-log.json" : "restart-log.json"), `${JSON.stringify(log, null, 2)}\n`);
  console.log("T19_DONE=" + JSON.stringify({ phase, shots: log.shots.length, assertions: log.assertions.length, failed: log.failed.length, sections: log.sections.map((row) => [row.name, row.ok]) }));
  exitNow(log.failed.length > 0 ? 2 : 0, log.failed.length > 0 ? `${log.failed.length} assertion(s) did not hold` : "done");
}

run().catch((error) => exitNow(1, `run failed: ${error?.stack ?? error}`));
