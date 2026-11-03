// [PiDock pencil-v1 / T03] (#138) real-Electron evidence for Provider 原生配置与首个真实对话:
// the S03 list before any Provider, the S03B add form driven through the preset banner,
// protocol, masked key + eye, two model rows and 获取模型列表, the native `models.json`
// write, the card's declared context/cost states, a task `选用`, the first REAL SDK turn
// against a local loopback OpenAI-compatible endpoint (streaming deltas, real usage,
// mid-stream cancel, follow-up in the same conversation), the named 401/500 turn failures,
// the 404/network discovery states, an external edit of the managed entry with the explicit
// reconcile path, and a SECOND Electron OS process that re-reads the same temp agent dir /
// userData (provider card, selected binding, conversation history).
//
// Run after `pnpm --filter @pidock/shell build`:
//   pnpm --filter @pidock/shell exec electron scripts/electron-pencil-v1-t03-capture.mjs \
//     --out docs/evidence/pencil-v1-t03
//
// Boot path is identical to the #136/#137/#142 harness (`electron-pencil-v1-t01/t02/t07-capture.mjs`):
// the compiled production runtime modules are imported directly (NOT `dist/main/main.js`) with
// the production wiring decisions — `createTrustedWindow(..., "production")`, `registerIpc` over a
// real `TaskRootIndex`/`ProjectRegistry`/`PerTaskHostRegistry`/`ProjectTaskCreation` (wired with the
// REAL `WorktreeMetadataLock`, exactly like `main.ts`) / `ProviderWiring` (with the REAL
// `ProviderSecretStore` + `NativeModelsFile`, same two arguments `main.ts` passes) — and the built
// React renderer (`dist/renderer/index.html`, no fixture entry, no dev-server override). The Host is
// a real `utilityProcess`; the SDK turn runs in the Host's isolated worker context.
//
// What is deliberately NOT real, and is named in the README:
// - the credential cipher: `createTestSafeStorage()` (deterministic AES-256-GCM) instead of the OS
//   keychain, because the capture must never touch the user's real Keychain item;
// - the endpoint: a loopback HTTP server (there is no real provider account here), while the
//   Provider protocol, the SDK turn, the Host, the projection and the UI are the real ones;
// - `PIDOCK_AGENT_DIR` points at a temp dir, so Pi's `<agent-dir>/models.json` is never the real
//   `~/.pi/agent/models.json`.
//
// Seeded through real APIs only: `ProjectRegistry.create` writes projects.json under the isolated
// userData, and the one task is created through `performCreationOperation` (the exact function
// behind `shell/createTask`) over a real plain directory — no task record is hand-written.
//
// Hang discipline: the deadline timer and the uncaught-error handlers are armed before the
// compiled `dist` graph is imported (dynamically, inside the guarded region).
import { app, utilityProcess } from "electron";
import { createUnavailableHostClient } from "./unavailable-host-client.mjs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { shutdownTestRegistry } from "./shutdown-test-registry.mjs";

// The dev-server override is inadmissible evidence: clear it before boot so this
// capture can only ever load the packaged `file://` renderer.
delete process.env["PIDOCK_RENDERER_URL"];
delete process.env["PIDOCK_TASK_URL"];
if (process.env["PIDOCK_RENDERER_URL"]) throw Error("PIDOCK_RENDERER_URL survived the clear");

const scriptPath = resolve(import.meta.dirname, "electron-pencil-v1-t03-capture.mjs");
const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const argValue = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const phase = argValue("--phase") ?? "primary";
const outArg = argValue("--out") ?? "docs/evidence/pencil-v1-t03";
const output = isAbsolute(outArg) ? outArg : resolve(repoRoot, outArg);
const command = "pnpm --filter @pidock/shell exec electron scripts/electron-pencil-v1-t03-capture.mjs --out docs/evidence/pencil-v1-t03";
// A fixed (not random) temp root keeps the captured paths stable, so a re-run at the
// same revision renders byte-identical PNGs. Isolated under the OS temp dir.
const root = join(tmpdir(), "pidock-pencil-v1-t03-capture");
// The main-owned stores (projects.json, provider-profiles.json, provider-secrets.json,
// task root) and the temp Pi agent dir the managed models.json lives in. The restart
// phase points Chromium at its own userData (`chromium-restart`) so the OS-level Chromium
// profile singleton does not collide, while the main-owned stores are re-instantiated
// over THIS directory.
const profile = join(root, "profile");
const taskRoot = join(root, "tasks");
const sourcesRoot = join(root, "sources");
const agentDir = join(root, "agent");
const chromiumProfile = join(root, phase === "restart" ? "chromium-restart" : "chromium");
app.setPath("userData", chromiumProfile);
// The temp agent dir is what Pi's `models.json` is written into. The real
// `~/.pi/agent` must never be the target of this capture.
const realAgentDir = join(homedir(), ".pi", "agent");
if (resolve(agentDir) === resolve(realAgentDir)) throw Error("refusing to use the real ~/.pi/agent");
process.env["PIDOCK_AGENT_DIR"] = agentDir;

const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const pngPixelSize = (png) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
// A dependency-free PNG reader: IHDR + concatenated IDAT + the five scanline filters.
// Only what `Page.captureScreenshot` writes here (8-bit RGB/RGBA, non-interlaced) is
// supported, so an unexpected format fails loudly instead of comparing garbage.
const pngPixels = (png) => {
  let offset = 8; let width = 0; let height = 0; let channels = 0;
  const idat = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      const depth = data[8]; const colorType = data[9];
      if (depth !== 8 || (colorType !== 2 && colorType !== 6) || data[12] !== 0) throw Error(`unsupported PNG: depth ${depth} colorType ${colorType} interlace ${data[12]}`);
      channels = colorType === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += length + 12;
  }
  if (!width || !height || !channels) throw Error("PNG without IHDR");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const at = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[at + i - channels] : 0;
      const b = y > 0 ? out[at - stride + i] : 0;
      const c = y > 0 && i >= channels ? out[at - stride + i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw Error(`unsupported PNG filter ${filter} on row ${y}`);
      out[at + i] = value & 0xff;
    }
  }
  return { width, height, channels, data: out };
};
/** Per-pixel comparison of two screenshots of the same view and size. */
const screenshotDiff = (left, right) => {
  const a = pngPixels(left); const b = pngPixels(right);
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) {
    throw Error(`screenshot size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  const stride = a.width * a.channels;
  let differingPixels = 0; let maxChannelDelta = 0;
  for (let y = 0; y < a.height; y++) {
    const start = y * stride; const end = start + stride;
    if (a.data.compare(b.data, start, end, start, end) === 0) continue;
    for (let x = 0; x < a.width; x++) {
      let delta = 0;
      for (let channel = 0; channel < a.channels; channel++) {
        delta = Math.max(delta, Math.abs(a.data[start + x * a.channels + channel] - b.data[start + x * a.channels + channel]));
      }
      if (delta > 0) { differingPixels += 1; maxChannelDelta = Math.max(maxChannelDelta, delta); }
    }
  }
  return { width: a.width, height: a.height, totalPixels: a.width * a.height, differingPixels, maxChannelDelta };
};

const children = [];
let views, registry, index, projects, catalog, providers, providerProfiles, nativeModels, secrets;

// Arm the deadline and the failure handlers BEFORE any heavyweight work.
let exiting = false;
const exitNow = (code, why) => {
  if (exiting) return;
  exiting = true;
  console.error(`T03_CAPTURE_EXIT ${phase}`, code, why);
  try { app.exit(code); } catch { process.exit(code); }
};
const watchdog = setTimeout(() => exitNow(1, "watchdog timeout"), 1200000);
process.on("uncaughtException", (error) => exitNow(1, `uncaughtException ${error?.stack ?? error}`));
process.on("unhandledRejection", (error) => {
  const stack = /** @type {{ stack?: string } | undefined} */ (error)?.stack;
  exitNow(1, `unhandledRejection ${stack ?? error}`);
});
// Test-only guard: a noop listener suppresses Electron's default quit on
// window-all-closed, which would race the explicit app.exit(process.exitCode).
app.on("window-all-closed", () => {});

const PROJECT_NAME = "T03 验收工作区";
const PROJECT_DESCRIPTION = "Provider 原生配置与首个真实对话（#138 / T03 验收）";
const TASK_NAME = "Provider 首个真实对话验收";
const PROVIDER_NAME = "Loopback 验收端点";
// A synthetic key: no real provider account exists, and the loopback echoes it in the
// upstream error bodies so a leak would be visible in the UI.
const API_KEY = "sk-t03-loopback-4f1c9d7a2b804e51a6c3";
const UPSTREAM_MARKER = "UPSTREAM-RAW-BODY-138";
const MODEL_REASONING = "loopback-chat-7b";
const MODEL_FAST = "loopback-fast";
const DISCOVERED = ["loopback-chat-7b", "loopback-reasoner-32b", "loopback-vision-16k"];
const PROMPTS = {
  stream: "第一条消息：请报告当前的验收步骤 138-A",
  hold: "第二条消息：这次我会中途停止 138-B",
  follow: "第三条消息：取消之后继续对话 138-C",
  fail401: "第四条消息：端点返回 401 时的具名错误 138-D",
  fail500: "第五条消息：端点返回 500 时的具名错误 138-E",
};
const shotFile = (width, height, state) => `${width}x${height}-${state}.png`;
const flat = (value) => String(value).replace(/\s+/g, " ").trim();
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

// ---------------------------------------------------------------- loopback endpoint
// A real HTTP server on 127.0.0.1 serving the two endpoints an OpenAI-compatible
// Provider exposes: `GET /v1/models` (discovery) and `POST /v1/chat/completions`
// (the SSE stream the SDK consumes). `state.mode` is set by the harness between
// turns, so the failure/cancel legs are the server's real behaviour, not a mock.
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
        if (request.method === "GET" && url.endsWith("/models")) {
          if (url.includes("/no-models/")) { response.writeHead(404, { "content-type": "application/json" }).end('{"error":{"message":"no model list"}}'); return; }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ object: "list", data: DISCOVERED.map((id) => ({ id, object: "model", owned_by: "loopback" })) }));
          return;
        }
        if (!url.endsWith("/chat/completions")) { response.writeHead(404).end(); return; }
        const mode = providerState.mode;
        if (mode === "fail401" || mode === "fail500") {
          response.writeHead(mode === "fail401" ? 401 : 500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: `${UPSTREAM_MARKER} auth=${API_KEY}`, type: "loopback_failure" } }));
          return;
        }
        // The SDK sends the whole conversation, so the turn's own marker is the LAST one.
        const tag = [...body.matchAll(/138-([A-E])/g)].at(-1)?.[1] ?? "X";
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        const frame = (delta, extra = {}) => `data: ${JSON.stringify({
          id: `chatcmpl-loopback-${tag}`, object: "chat.completion.chunk", model: MODEL_REASONING,
          choices: [{ index: 0, delta, finish_reason: null }], ...extra,
        })}\n\n`;
        response.write(frame({ content: `STREAM-${tag}-1 ` }));
        response.write(frame({ content: `STREAM-${tag}-2 ` }));
        if (mode === "hold") {
          // A held stream: a real provider that keeps sending. The connection never ends
          // on its own, so the only way out is the user's 停止.
          let index = 3;
          const timer = setInterval(() => {
            try {
              response.write(frame({ content: `STREAM-${tag}-${index} 保持中的增量文本片段 ${"·".repeat(4)} ` }));
              index += 1;
            } catch { clearInterval(timer); }
            if (index > 80) clearInterval(timer);
          }, 150);
          response.on("close", () => clearInterval(timer));
          held.push({ response, timer });
          return;
        }
        const finish = () => {
          try {
            response.write(frame({ content: `STREAM-${tag}-3 ` }));
            response.write(`data: ${JSON.stringify({ id: `chatcmpl-loopback-${tag}`, object: "chat.completion.chunk", model: MODEL_REASONING, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })}\n\n`);
            response.write("data: [DONE]\n\n");
            response.end();
          } catch { /* the client closed the held stream */ }
        };
        if (mode === "slow") setTimeout(finish, 4500); else finish();
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
const withPort = (path, port = providerState.port) => `http://127.0.0.1:${port}${path}`;

async function run() {
  const restart = phase === "restart";
  let stage = "startup";
  const shots = [];
  const assertions = [];
  // Observed product defects: recorded, never worked around. A finding is a FAIL item
  // in the README; the capture continues so the rest of the ticket stays measurable.
  const findings = [];
  const recordFinding = (finding) => {
    findings.push(finding);
    console.log("T03_FINDING=" + JSON.stringify({ id: finding.id, title: finding.title }));
  };
  const check = (name, condition, detail = "") => {
    if (!condition) throw Error(`ASSERT FAILED [${phase}] ${name}${detail ? `: ${String(detail).slice(0, 900)}` : ""}`);
    assertions.push({ name, ok: true, detail: String(detail).slice(0, 500) });
  };
  // Dynamic imports: the compiled dist graph is pulled in only after the watchdog is armed.
  const { readTaskRecordOnDisk } = await import("../dist/host/task-store.js");
  const { buildHostEnv } = await import("../dist/host/host-guards.js");
  const { TaskRootIndex } = await import("../dist/main/task-root-index.js");
  const { ProjectRegistry } = await import("../dist/main/project-registry.js");
  const { ServiceCatalog, serviceCatalogAuthority } = await import("../dist/main/service-catalog.js");
  const { createTrustedWindow, loadTrustedViews, PerTaskHostRegistry, registerIpc } = await import("../dist/main/runtime.js");
  const { CreationIntentStore, ProjectTaskCreation } = await import("../dist/main/project-task-creation.js");
  const { performCreationOperation } = await import("../dist/main/project-task-ipc.js");
  const { WorktreeMetadataLock } = await import("../dist/main/worktree-metadata-lock.js");
  const { ProviderProfileStore } = await import("../dist/main/provider-profile-store.js");
  const { ProviderSecretStore, createTestSafeStorage } = await import("../dist/main/provider-secret-store.js");
  const { NativeModelsFile, resolveAgentDir, managedProviderId } = await import("../dist/main/native-models-config.js");
  const { ProviderWiring } = await import("../dist/main/provider-ipc.js");
  const { HostClient } = await import("../dist/rpc/host-client.js");

  /** The task's SDK JSONL, read off the disk the Host wrote. */
  const jsonlText = (dir) => {
    const base = join(dir, ".pidock-sdk-sessions", "main");
    if (!existsSync(base)) return "";
    return readdirSync(base).filter((name) => name.endsWith(".jsonl")).map((name) => readFileSync(join(base, name), "utf8")).join("\n");
  };
  const nativeText = () => readFileSync(nativeModels.path, "utf8");
  const nativeDoc = () => JSON.parse(nativeText());
  const managedEntry = () => {
    const doc = nativeDoc();
    const key = Object.keys(doc.providers ?? {}).find((name) => name.startsWith("pidock-"));
    return key === undefined ? null : { key, entry: doc.providers[key] };
  };
  const envCredentials = () => Object.keys(process.env).filter((name) => /^PIDOCK_PROVIDER_[A-Z0-9_]+$/.test(name));
  let profileId = "";
  let projectId = "";
  let directoryId = "";
  let taskId = "";
  let taskDir = "";
  let managedKey = "";
  const ops = [];
  const savedEnvAgent = process.env["PIDOCK_AGENT_DIR"];
  try {
    if (!restart) {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      mkdirSync(profile, { recursive: true });
      mkdirSync(taskRoot, { recursive: true });
      mkdirSync(sourcesRoot, { recursive: true });
      mkdirSync(agentDir, { recursive: true, mode: 0o700 });
      mkdirSync(output, { recursive: true });
    } else {
      if (!existsSync(join(profile, "provider-profiles.json"))) throw Error(`restart phase: no persisted provider store under ${profile}`);
      mkdirSync(chromiumProfile, { recursive: true });
    }
    providerState.server = await startProvider();
    stage = "whenReady";
    await app.whenReady();

    index = new TaskRootIndex(profile, taskRoot);
    projects = new ProjectRegistry(profile);
    providerProfiles = new ProviderProfileStore(profile);
    // The real store + test cipher: the ciphertext pipeline, the 0600 file, the
    // revision bump and the never-echo rules are the product's; only the platform
    // cipher is replaced (a deterministic AES-256-GCM key) because the capture must
    // not touch the user's real Keychain item.
    secrets = new ProviderSecretStore(profile, createTestSafeStorage());
    // Pi's native management object, in the TEMP agent dir resolved the same way
    // `main.ts` resolves it (`resolveAgentDir(process.env, homedir())`).
    const resolvedAgent = resolveAgentDir(process.env, homedir());
    if (resolvedAgent !== agentDir) throw Error(`PIDOCK_AGENT_DIR did not resolve to the temp agent dir: ${resolvedAgent}`);
    nativeModels = new NativeModelsFile(resolvedAgent);
    check("Pi's models.json resolves to the TEMP agent dir, not the real ~/.pi/agent",
      nativeModels.path === join(agentDir, "models.json") && resolve(agentDir) !== resolve(realAgentDir) &&
      !nativeModels.path.startsWith(join(homedir(), ".pi") + "/"),
      JSON.stringify({ path: nativeModels.path, realAgentDir }));
    check("no PIDOCK_PROVIDER_* credential exists in the capture process environment",
      envCredentials().length === 0, JSON.stringify(envCredentials()));

    stage = "seed workspace";
    if (!restart) {
      const docsDir = join(sourcesRoot, "provider-notes");
      mkdirSync(docsDir, { recursive: true });
      writeFileSync(join(docsDir, "验收说明.md"), "# 验收说明\n\nT03 Provider 首个真实对话：普通目录来源。\n");
      const project = await projects.create({
        name: PROJECT_NAME,
        description: PROJECT_DESCRIPTION,
        repositories: [],
        directories: [{ name: "provider-notes", path: docsDir }],
        environment: [],
        branchTemplate: "feature/{task-name}",
      });
      projectId = project.id;
      directoryId = project.directories[0].id;
      check("the registry really stores the one plain-directory source",
        project.directories.length === 1 && project.repositories.length === 0,
        JSON.stringify({ directories: project.directories.map((row) => row.name), repositories: project.repositories.length }));
      check("no task exists before the creation path runs", index.inventory().tasks.length === 0);
    } else {
      taskId = process.env["PIDOCK_T03_TASK_ID"] ?? "";
      taskDir = process.env["PIDOCK_T03_TASK_DIR"] ?? "";
      profileId = process.env["PIDOCK_T03_PROFILE_ID"] ?? "";
      if (!taskId || !taskDir || !profileId) throw Error("restart phase: task/profile identity missing");
      managedKey = managedProviderId(profileId);
    }

    stage = "window";
    const workspaceId = restart ? "pencil-v1-t03-restart" : "pencil-v1-t03";
    views = await createTrustedWindow(workspaceId, "production");
    registry = new PerTaskHostRegistry(workspaceId, async (workspace, task) => {
      const entry = join(import.meta.dirname, "..", "dist", "host", "host-entry.js");
      const child = utilityProcess.fork(entry, [], { serviceName: `${workspaceId}-host`, env: buildHostEnv(process.env, workspace, task, app.getPath("userData")), stdio: "pipe" });
      children.push(child);
      child.stderr?.on("data", (data) => process.stderr.write(`[${workspaceId}-host] ${data}`));
      return { child, client: new HostClient(child) };
    }, (id) => index.resolve(id), undefined, index);
    // Instrument the main boundary BEFORE any handler exists: every Host op the app
    // routes is logged here, so the credential path (`task/sdkProvider`) and every
    // turn op are execution facts.
    const originalRoute = registry.routeTaskOp.bind(registry);
    registry.routeTaskOp = async (input) => {
      ops.push({ op: input?.op ?? null, taskId: input?.taskId ?? null,
        keys: input?.payload?.provider === undefined ? null : Object.keys(input.payload.provider ?? {}) });
      return originalRoute(input);
    };
    // Same wiring decisions as `main.ts`: main owns the encrypted store and Pi's
    // native models.json, and hands the credential only to the task Host.
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
    catalog = new ServiceCatalog(profile, serviceCatalogAuthority(index, projects));
    registerIpc(createUnavailableHostClient(), views.registry, registry, projects, index, undefined, creation, providers, catalog);

    if (!restart) {
      // The REAL main-side creation path — the exact function behind `shell/createTask`.
      // Plain-directory mode keeps this capture about the Provider, not about worktrees.
      stage = "seed task";
      const prepared = /** @type {{ canceled: boolean; intent: { id: string; taskId: string; taskDir: string } }} */ (
        await performCreationOperation(creation, {
          op: "prepare",
          input: { projectId, name: TASK_NAME, repositories: [], directoryIds: [directoryId],
            sharedWriteConfirmed: true, override: false, workspaceMode: "plain-dirs" },
        }, async () => null, () => undefined));
      if (prepared.canceled) throw Error("task prepare was canceled");
      taskId = prepared.intent.taskId;
      taskDir = prepared.intent.taskDir;
      const committed = await performCreationOperation(creation, { op: "commit", id: prepared.intent.id }, async () => null, () => undefined);
      check("the task was committed into the real task root", index.inventory().tasks.some((row) => row.taskId === taskId),
        JSON.stringify({ taskId, inventory: index.inventory().tasks.map((row) => row.taskId) }));
      const record = readTaskRecordOnDisk(taskDir);
      check("the committed task record is plain-directory mode with the one source directory",
        record?.workspaceMode === "plain-dirs" && (record?.dirLinks ?? []).length === 1,
        JSON.stringify({ mode: record?.workspaceMode, dirLinks: record?.dirLinks, committed }));
    }
    await loadTrustedViews(views);
    views.shellView.webContents.debugger.attach();

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
    const click = (name) => evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(name)} || el.getAttribute('aria-label') === ${JSON.stringify(name)}); if (!b) throw Error('missing button '+${JSON.stringify(name)}+' :: '+document.body.innerText.replace(/\\n+/g,' | ').slice(0,600)); b.click(); return true; })()`);
    // A button label may carry a trailing shortcut hint; whitespace is stripped on
    // both sides and the search can be scoped to one container.
    const clickLabelled = (needle, scope = "document") => evalJs(`(() => {
      const root = ${scope} ?? document;
      const want = ${JSON.stringify(needle.replace(/\s+/g, ""))};
      const button = [...root.querySelectorAll('button')].find((el) => el.textContent.replace(/\\s+/g, '').includes(want) || el.getAttribute('aria-label') === ${JSON.stringify(needle)});
      if (!button) throw Error('missing button containing ' + ${JSON.stringify(needle)} + ' :: ' + document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 800));
      button.click();
      return true;
    })()`);
    // Typing: React keeps its own value tracker, so assigning `el.value` alone would
    // be ignored by the controlled input. The prototype setter + a bubbling `input`
    // event is what a real keystroke produces; the returned `el.value` is compared by
    // the caller so a silently dropped keystroke fails the capture.
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
    const inputValueAt = (label, index = 0) => evalJs(`(() => { const el = [...document.querySelectorAll('input[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']')][${index}]; return el ? el.value : null; })()`);
    const inputTypeAt = (label, index = 0) => evalJs(`(() => { const el = [...document.querySelectorAll('input[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']')][${index}]; return el ? el.type : null; })()`);
    const chooseAt = async (label, value) => {
      const chosen = await evalJs(`(() => {
        const el = document.querySelector('select[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']');
        if (!el) throw Error('missing select ' + ${JSON.stringify(label)} + ' :: ' + document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 600));
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return el.value;
      })()`);
      if (chosen !== value) throw Error(`select "${label}" did not take ${value}: ${chosen}`);
      return chosen;
    };
    const toggleCheckbox = async (label) => {
      const state = await evalJs(`(() => {
        const el = document.querySelector('input[type=checkbox][aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']');
        if (!el) throw Error('missing checkbox ' + ${JSON.stringify(label)} + ' :: ' + document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 800));
        el.click();
        return el.checked;
      })()`);
      return state;
    };
    // Real keystrokes through CDP: the textarea is a controlled React input whose draft
    // drives both the send button and the persisted draft, so the evidence types the way a
    // user does instead of assigning `value`.
    const composerState = () => evalJs(`(() => {
      const b = document.querySelector('button[aria-label="发送"]');
      const t = document.querySelector('textarea[aria-label="消息"]');
      const key = t ? Object.keys(t).find((name) => name.startsWith('__reactProps')) : undefined;
      return { disabled: b ? b.disabled : null, value: t ? t.value : null, reactValue: key ? t[key].value : null };
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
    /** Wait until the Provider list holds exactly `count` rendered cards and no form. */
    const waitProviderCards = async (count) => {
      for (let i = 0; i < 300; i++) {
        const state = await evalJs("({ cards: document.querySelectorAll('[data-testid^=provider-card-]').length, form: !!document.querySelector('[data-testid=provider-form]') })");
        if (state.cards === count && !state.form) return state;
        await wait(100);
      }
      throw Error(`provider list never reached ${count} cards :: ${flat(await text()).slice(0, 1200)}`);
    };
    const sizeTo = async (width, height) => { views.window.setContentSize(width, height); await wait(120); };
    // Focus is restored to the opener on close, and a lingering `:focus` border would
    // differ between the pre- and post-restart runs of the SAME view. Blur before the
    // two captures that are compared byte-for-byte, on both sides.
    const settleFocus = () => evalJs("(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); return document.activeElement === document.body; })()");
    const scrollToTop = (selector) => evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.scrollTop = 0; const root = document.querySelector('[data-testid=desktop-shell-content]'); if (root) root.scrollTop = 0; document.documentElement.scrollTop = 0; return true; })()`);
    const providerPanelText = () => evalJs("document.querySelector('[data-testid=providers-panel]')?.innerText ?? ''");
    const providerFormText = () => evalJs("document.querySelector('[data-testid=provider-form]')?.innerText ?? ''");
    const historyText = () => evalJs("document.querySelector('[aria-label=\"SDK 对话历史\"]')?.innerText ?? ''");
    const composerModel = () => evalJs("document.querySelector('[data-testid=composer-model]')?.textContent.replace(/\\s+/g, ' ').trim() ?? null");
    const composerUsage = () => evalJs("document.querySelector('[data-testid=composer-usage]')?.textContent.replace(/\\s+/g, ' ').trim() ?? null");
    const providerRequirement = () => evalJs("document.querySelector('[data-testid=provider-requirement]')?.innerText ?? null");
    const stopButton = () => evalJs("[...document.querySelectorAll('button')].some((el) => el.textContent.trim() === '停止')");
    // Fail closed: the loaded entry must be the packaged React renderer over file://.
    const url = await evalJs("location.href");
    if (typeof url !== "string" || !/^file:\/\/.*\/renderer\/index\.html$/.test(url)) throw Error(`not the production file:// renderer: ${url}`);

    const metrics = async () => evalJs(`(() => {
      const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; };
      const line = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160) : null);
      const style = (el) => { if (!el) return null; const s = getComputedStyle(el); return { padding: s.padding, gap: s.gap, radius: s.borderRadius, fontSize: s.fontSize }; };
      const panel = document.querySelector('[data-testid=providers-panel]');
      const form = document.querySelector('[data-testid=provider-form]');
      const nav = document.querySelector('nav[aria-label="能力管理"]');
      const card = document.querySelector('[data-testid^=provider-card-]');
      const content = document.querySelector('[data-testid=desktop-shell-content]');
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        nav: nav ? { ...box(nav), ...style(nav) } : null,
        content: box(content),
        panel: panel ? { ...box(panel), ...style(panel), title: line(panel.querySelector('h1')), header: box(panel.querySelector('header')) } : null,
        form: form ? { ...box(form), ...style(form), title: line(form.querySelector('h1')), header: box(form.querySelector('header')) } : null,
        modelTable: form ? box(form.querySelector('table')) : null,
        firstModelRow: form ? box(form.querySelector('tbody tr')) : null,
        providerCard: card ? { ...box(card), text: line(card) } : null,
        discovery: box(document.querySelector('[aria-label="可选模型"]')),
        conversation: box(document.querySelector('[data-testid=desktop-conversation]')),
        history: box(document.querySelector('[aria-label="SDK 对话历史"]')),
        messages: [...document.querySelectorAll('[aria-label="SDK 对话历史"] article')].map((el) => ({ ...box(el), text: line(el) })),
        composerModel: line(document.querySelector('[data-testid=composer-model]')),
        composerUsage: line(document.querySelector('[data-testid=composer-usage]')),
        documentOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })()`);

    const capture = async (state, width, height) => {
      stage = `${state} ${width}x${height}`;
      views.window.setContentSize(width, height);
      // At 720×560 the 能力管理 nav takes the full width and the pane stacks below the
      // fold, so the pane is scrolled into view; at 1440 every scroll container is reset
      // to the top so consecutive captures are comparable.
      const applyViewport = () => evalJs(`(() => {
        const target = document.querySelector('[data-testid=provider-form]') ?? document.querySelector('[data-testid=providers-panel]')
          ?? document.querySelector('[data-testid=desktop-conversation]');
        if (${width} <= 1000) {
          // Narrow layout stacks the panes, so the pane under test is scrolled to the top
          // of its scroller; the scroller itself is walked up and reset first so the
          // measurement is not relative to wherever the previous capture left it.
          for (let node = target; node; node = node.parentElement) { node.scrollTop = 0; }
          if (target) target.scrollIntoView({ block: 'start' });
          return { scrolled: Boolean(target), top: target ? Math.round(target.getBoundingClientRect().top) : null };
        }
        for (let node = target; node; node = node.parentElement) { node.scrollTop = 0; }
        const root = document.querySelector('[data-testid=desktop-shell-content]');
        if (root) root.scrollTop = 0;
        document.documentElement.scrollTop = 0;
        window.scrollTo(0, 0);
        return { scrolled: Boolean(target), top: target ? Math.round(target.getBoundingClientRect().top) : null };
      })()`);
      await applyViewport();
      views.shellView.setVisible(true);
      views.window.show();
      // Test-only activation: an occluded/backgrounded window can reject capturePage
      // with UnknownVizError, so bring this window frontmost before the stabilization wait.
      app.focus({ steal: true });
      views.window.moveTop();
      views.window.focus();
      await wait(250);
      // Focusing/resizing re-lays out the window; for the narrow layout the scroll offset
      // is applied again here so the pane is really inside the captured viewport.
      const placement = await applyViewport();
      await wait(200);
      if (width <= 1000) {
        console.log(`T03_PLACEMENT ${state} ${width}x${height} ` + JSON.stringify(placement));
        if (state.startsWith("conversation")) {
          console.log("T03_SCROLL_DEBUG " + state + " " + JSON.stringify(await evalJs(`(() => {
            const target = document.querySelector('[data-testid=desktop-conversation]');
            const chain = [];
            for (let node = target; node && node !== document.documentElement; node = node.parentElement) {
              const style = getComputedStyle(node);
              chain.push({ tag: node.tagName.toLowerCase(), testid: node.getAttribute('data-testid'), overflowY: style.overflowY,
                scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, scrollTop: node.scrollTop });
            }
            return { chain: chain.slice(0, 8), doc: { scrollHeight: document.documentElement.scrollHeight, clientHeight: document.documentElement.clientHeight, scrollTop: document.documentElement.scrollTop }, window: { innerHeight: window.innerHeight } };
          })()`)));
        }
      }
      const size = views.window.getContentBounds();
      if (size.width !== width || size.height !== height) throw Error(`unexpected content bounds ${JSON.stringify(size)}`);
      const name = shotFile(size.width, size.height, state);
      // CDP screenshot of the exactly-sized shell view (same composited pixels as
      // webContents.capturePage), so an occlusion state that makes capturePage reject
      // with UnknownVizError cannot silently drop the evidence.
      const shot = await views.shellView.webContents.debugger.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const png = Buffer.from(shot.data, "base64");
      writeFileSync(join(output, name), png);
      const pixels = pngPixelSize(png);
      const record = { state, file: name, width: size.width, height: size.height,
        pixelWidth: pixels.width, pixelHeight: pixels.height,
        deviceScaleFactor: pixels.width / size.width,
        sha256: sha256(png),
        layout: await metrics(),
        bodyText: (await text()).replace(/\n+/g, " | ").slice(0, 2200) };
      shots.push(record);
      console.log("T03_CAPTURE=" + JSON.stringify({ state: record.state, file: record.file, sha256: record.sha256 }));
      return record;
    };

    // ---------------------------------------------------------------- navigation
    const gotoCapabilities = async () => {
      // The one 能力管理 entry keeps the task the user came from as its 选用 context.
      await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((el) => el.getAttribute('aria-label') === '能力管理'); if (!b) throw Error('missing 能力管理 nav'); b.click(); return true; })()`);
      await until((body) => body.includes("模型供应商") && body.includes("底层配置文件映射"), "capabilities providers page");
      await until((body) => body.includes("已添加") || body.includes("正在读取本机 Provider 配置"), "provider list read");
    };
    const gotoTask = async () => {
      for (let attempt = 0; attempt < 300; attempt++) {
        if (await evalJs(`!!document.querySelector('[data-task-nav="${taskId}"]')`)) break;
        if (attempt === 299) throw Error(`no task navigation for ${taskId} [${phase}] :: ${flat(await text()).slice(0, 1200)}`);
        await wait(100);
      }
      await evalJs(`(() => { const b = document.querySelector('[data-task-nav="${taskId}"]'); if (!b) throw Error('missing task nav'); b.click(); return true; })()`);
      await until((body) => body.includes("SDK JSONL 已确认历史"), "task conversation view");
    };
    /** Poll a main-side predicate over the real stores. */
    const untilMain = async (predicate, label, attempts = 200) => {
      for (let i = 0; i < attempts; i++) { const value = await predicate(); if (value) return value; await wait(100); }
      throw Error(`main-side timeout (${label}) [${phase}]`);
    };

    // ------------------------------------------- restart phase: post-restart evidence
    // This branch runs in a NEW Electron OS process over the same on-disk provider store,
    // temp agent dir, userData and task root. It re-reads the managed models.json entry,
    // the persisted selection and the SDK JSONL, then re-renders the Provider list and the
    // conversation.
    if (restart) {
      const expect = JSON.parse(process.env["PIDOCK_T03_EXPECT"] ?? "null");
      if (!expect) throw Error("restart phase: expectations missing");
      stage = "restart reads";
      const stored = providerProfiles.list();
      const selection = providerProfiles.selection(taskId);
      const native = managedEntry();
      check("the restart process reads the same persisted provider profile", stored.profiles.length === 1 && stored.profiles[0].id === profileId,
        JSON.stringify(stored.profiles.map((row) => row.id)));
      check("the restart process reads the same persisted selection for the task",
        selection?.profileId === profileId && selection?.modelId === MODEL_REASONING && selection?.thinkingLevel === "high",
        JSON.stringify(selection));
      check("the restart process finds the managed native entry in the same temp models.json",
        native?.key === managedKey && nativeModels.path === expect.nativePath, JSON.stringify({ key: native?.key, path: nativeModels.path }));
      check("models.json was not rewritten by the restart read", sha256(readFileSync(nativeModels.path)) === expect.nativeSha256,
        `${expect.nativeSha256} -> ${sha256(readFileSync(nativeModels.path))}`);
      const jsonl = jsonlText(taskDir);
      check("the restart process reads the SDK JSONL the previous process wrote",
        [expect.prompts.stream, expect.prompts.follow, expect.prompts.fail401, expect.prompts.fail500].every((prompt) => jsonl.includes(prompt)),
        JSON.stringify({ bytes: jsonl.length }));
      check("the cancelled turn's prompt and its aborted terminal are in the same JSONL",
        jsonl.includes(expect.prompts.hold) && /"stopReason":"aborted"/.test(jsonl), JSON.stringify({ aborted: /"stopReason":"aborted"/.test(jsonl) }));

      stage = "restart provider list";
      await until((body) => body.includes(PROJECT_NAME) || body.includes("未归属任务"), "shell boot in the restart process");
      await sizeTo(1440, 900);
      // The Provider page keeps the task the user came FROM as its 选用 context, so the
      // restart opens the task first (exactly like the primary process did) — otherwise
      // 能力管理 would legitimately render its global, task-less state.
      await gotoTask();
      // The list call is what makes main re-install the persisted selection into the
      // fresh Host, so `configured` is only observable after the page read it.
      await gotoCapabilities();
      await untilMain(() => providers.status(taskId).state === "configured", "provider re-install in the restart process");
      const installed = providers.status(taskId);
      const view = installed;
      check("the restart process re-installed the selection from the temp models.json + encrypted store",
        installed.state === "configured" && view.nativePath === expect.nativePath, JSON.stringify({ state: installed.state, nativePath: view.nativePath }));
      check("the native entry still reports `synced` after the reconcile (no external edit was recorded later)",
        view.profiles[0]?.native.state === "synced", String(view.profiles[0]?.native.state));
      // The card and the 当前任务已选用 line only render once main reported `configured`.
      await until((body) => body.includes("当前任务已选用"), "provider card with the selected binding");
      await scrollToTop("[data-testid=desktop-shell-content]");
      await settleFocus();
      await capture("s03-providers-after-restart", 1440, 900);
      await capture("s03-providers-after-restart", 720, 560);
      await sizeTo(1440, 900);
      const restartPanel = flat(await providerPanelText());

      stage = "restart conversation";
      await gotoTask();
      await until((body) => body.includes(expect.historyMarker) && body.includes("SDK 用量 · 输入 11 / 输出 7"), "restored conversation history");
      for (let i = 0; i < 200; i++) { if ((await composerModel())?.includes(MODEL_REASONING)) break; await wait(100); }
      await scrollToTop('[aria-label="SDK 对话历史"]');
      await settleFocus();
      await capture("conversation-after-restart", 1440, 900);
      await capture("conversation-after-restart", 720, 560);
      const restartHistory = flat(await historyText());
      check("the restarted conversation shows every earlier turn from the SDK history",
        [expect.prompts.stream, expect.prompts.hold, expect.prompts.follow, expect.prompts.fail401, expect.prompts.fail500].every((prompt) => restartHistory.includes(prompt)),
        restartHistory.slice(0, 1200));
      check("the restarted conversation still renders the real SDK usage block",
        restartHistory.includes("SDK 用量 · 输入 11 / 输出 7"), restartHistory.slice(0, 800));
      check("the restarted conversation keeps the selected model in the composer",
        (await composerModel()) === `${PROVIDER_NAME} · Loopback Chat 7B`, String(await composerModel()));
      check("the re-rendered history equals the pre-restart history text",
        restartHistory === expect.historyText, JSON.stringify({ before: expect.historyText.slice(0, 600), after: restartHistory.slice(0, 600) }));
      check("the re-rendered Provider panel equals the pre-restart panel text",
        restartPanel === expect.panelText, JSON.stringify({ before: expect.panelText.slice(0, 600), after: restartPanel.slice(0, 600) }));

      let revision = "unknown";
      try { revision = (await import("node:child_process")).execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: repoRoot }).trim(); } catch { /* recorded as unknown */ }
      const restartLog = {
        phase: "restart",
        pid: process.pid,
        command: `${command} --phase restart`,
        revision,
        agentDir,
        nativePath: nativeModels.path,
        nativeSha256: sha256(readFileSync(nativeModels.path)),
        selection,
        status: { state: installed.state, profileId: installed.profileId, modelId: installed.modelId, thinkingLevel: installed.thinkingLevel },
        turnOps: ops,
        historyText: restartHistory,
        panelText: restartPanel,
        assertions,
        shots,
      };
      writeFileSync(join(output, "restart-log.json"), `${JSON.stringify(restartLog, null, 2)}\n`);
      console.log("T03_RESTART_CAPTURE=" + JSON.stringify({ pid: process.pid, shots: shots.map((shot) => shot.file), assertions: assertions.length }));
      return;
    }

    // -------------------------------------------------------- shell boot + the task
    stage = "shell boot";
    await until((body) => body.includes(PROJECT_NAME) || body.includes("未归属任务"), "shell boot");
    // A passive second listener on the preload event channel: it records every Host
    // event (kind/type/turnId/sequence) exactly as the renderer receives it, without
    // touching the product's own subscription.
    await evalJs("(() => { window.__t03Events = []; window.pidock.onSdkTurnEvent((payload) => { try { window.__t03Events.push(payload); } catch {} }); return true; })()");
    await sizeTo(1440, 900);
    await gotoTask();
    stage = "provider requirement";
    const requirement = await until((body) => body.includes("尚未配置可用的 Provider / 模型"), "provider requirement banner");
    check("the task conversation starts with no Provider configured and says so by name",
      flat(requirement).includes("尚未配置可用的 Provider / 模型") && flat(requirement).includes("不会自动选择或调用模型"),
      flat(requirement).slice(0, 600));
    check("the composer names 未配置模型 before any Provider exists", (await composerModel()) === "未配置模型", String(await composerModel()));
    const emptyStore = providerProfiles.list();
    check("main holds no Provider profile and no selection before the form is used",
      emptyStore.profiles.length === 0 && emptyStore.selections.length === 0, JSON.stringify(emptyStore));
    check("no SDK turn or provider install was routed before the first save",
      ops.every((entry) => entry.op !== "task/sdkStart" && entry.op !== "task/sendMessage"), JSON.stringify(ops.map((entry) => entry.op)));
    await scrollToTop('[aria-label="SDK 对话历史"]');
    await settleFocus();
    await capture("conversation-provider-required", 1440, 900);
    await capture("conversation-provider-required", 720, 560);
    await sizeTo(1440, 900);

    // ------------------------------------------------------------------- S03 list
    stage = "S03 providers list";
    await gotoCapabilities();
    const nativePathLine = await evalJs("document.querySelector('[data-testid=native-path]')?.textContent.trim() ?? null");
    check("S03 names the REAL models.json path main provided (the temp agent dir)",
      nativePathLine === join(agentDir, "models.json"), String(nativePathLine));
    check("S03 says the credential store is the platform-encrypted one",
      flat(await text()).includes("密钥存储：本机加密（safeStorage）"), flat(await text()).slice(0, 600));
    check("S03 with no Provider lists 已添加 · 0 and the empty explanation",
      flat(await providerPanelText()).includes("已添加 · 0") && flat(await providerPanelText()).includes("还没有 Provider"),
      flat(await providerPanelText()).slice(0, 600));
    check("S03 does not invent a Provider row", (await evalJs("document.querySelectorAll('[data-testid^=provider-card-]').length")) === 0);
    await scrollToTop("[data-testid=desktop-shell-content]");
    await settleFocus();
    await capture("s03-providers-empty", 1440, 900);
    await capture("s03-providers-empty", 720, 560);
    await sizeTo(1440, 900);

    // ------------------------------------------------- S03B: the real add form
    stage = "S03B open form";
    await clickLabelled("添加供应商");
    await until((body) => body.includes("保存并写入 models.json") && body.includes("添加供应商"), "provider form");
    check("S03B opens on the manual-fill banner, not a pre-loaded preset",
      flat(await providerFormText()).includes("手动填写：接口格式、Base URL 与模型都由你决定"),
      flat(await providerFormText()).slice(0, 500));
    // A preset only fills the form: the protocol is still the one shown in the select.
    // It is activated from the list's 可添加 section, which opens S03B with its banner.
    const applyPreset = (name) => evalJs(`(() => {
      const row = [...document.querySelectorAll('section[aria-label="可添加"] li')].find((li) => li.textContent.includes(${JSON.stringify(name)}));
      if (!row) throw Error('missing preset ' + ${JSON.stringify(name)});
      const button = [...row.querySelectorAll('button')].find((el) => el.textContent.trim() === '激活');
      if (!button) throw Error('missing 激活 for ' + ${JSON.stringify(name)});
      button.click();
      return true;
    })()`);
    await clickLabelled("返回供应商列表");
    await waitProviderCards(0);
    await applyPreset("本机兼容端点");
    await until((body) => body.includes("已载入预设"), "preset banner");
    check("the preset banner names the loaded preset and says the values are still editable",
      flat(await providerFormText()).includes("已载入预设 本机兼容端点") && flat(await providerFormText()).includes("协议与地址已填入，仍可修改"),
      flat(await providerFormText()).slice(0, 500));
    check("the preset filled the openai-completions protocol",
      (await evalJs("document.querySelector('select[aria-label=\"接口格式\"]')?.value ?? null")) === "openai-completions");

    stage = "S03B fill";
    await typeAt("名称", PROVIDER_NAME);
    await typeAt("备注", "本机回环验收端点 · 无真实线上账号");
    await typeAt("模型 ID 1", MODEL_REASONING);
    await typeAt("显示名称 1", "Loopback Chat 7B");
    await typeAt("上下文窗口 1", "131072");
    await typeAt("最大输出 1", "8192");
    // A declared reasoning model starts on 关闭 only; the levels the endpoint documents
    // are ticked by the user here and travel to main as the declared subset.
    check("the reasoning checkbox starts the row on 关闭 only", (await toggleCheckbox("思维链推理 1")) === true);
    await toggleCheckbox("关闭档位 1");
    await toggleCheckbox("中档位 1");
    await toggleCheckbox("高档位 1");
    // The second row is a manual id that the endpoint will NOT list: discovery must keep it.
    await clickLabelled("手动添加");
    await typeAt("模型 ID 2", MODEL_FAST);
    await typeAt("显示名称 2", "Loopback Fast");
    await typeAt("上下文窗口 2", "32768");
    await typeAt("最大输出 2", "4096");
    for (const [label, value] of [["输入价格 2", "0.5"], ["输出价格 2", "1.5"], ["缓存读价格 2", "0.05"], ["缓存写价格 2", "0.1"]]) await typeAt(label, value);
    await chooseAt("默认模型", MODEL_REASONING);
    // The key is typed once, and the eye is the only read path the UI has.
    await typeAt("API Key", API_KEY);
    check("the API Key field is a password field while the eye is off", (await inputTypeAt("API Key")) === "password", String(await inputTypeAt("API Key")));
    await clickLabelled("显示密钥");
    check("the eye really reveals the typed key (masked by default, readable on demand)", (await inputTypeAt("API Key")) === "text");
    check("the revealed value is the typed key and nothing else", (await inputValueAt("API Key")) === API_KEY);
    await clickLabelled("隐藏密钥");
    check("the eye masks the key again", (await inputTypeAt("API Key")) === "password");
    check("two model rows are held in the form", (await evalJs("document.querySelectorAll('[data-testid=provider-form] tbody tr').length")) === 2);

    // ------------------------------------------- discovery: 404 / network / success
    stage = "S03B filled";
    // The clean form state first: preset banner, protocol, masked key, two rows, the
    // loopback base URL and the chosen default model.
    await typeAt("Base URL", withPort("/v1"));
    check("the form holds the loopback base URL, the masked key and both rows before discovery",
      (await inputValueAt("Base URL")) === withPort("/v1") && (await inputTypeAt("API Key")) === "password" &&
      (await inputValueAt("显示名称 1")) === "Loopback Chat 7B" && (await inputValueAt("上下文窗口 1")) === "131072");
    await settleFocus();
    await capture("s03b-form-filled", 1440, 900);
    await capture("s03b-form-filled", 720, 560);
    await sizeTo(1440, 900);

    // ------------------------------------------- discovery: 404 / network / success
    // The transport is the real one (`createHttpModelListTransport` → global fetch → this
    // loopback server). Main's own answer is read directly as well, so a UI contract
    // failure can never be mistaken for a network failure.
    stage = "discovery unsupported";
    await typeAt("Base URL", withPort("/no-models/v1"));
    await clickLabelled("获取模型列表");
    const unsupported = await until((body) => body.includes("模型发现失败") && body.includes("HTTP 404/405"), "unsupported discovery");
    check("a 404 model-list endpoint is the named 未提供模型列表 state, not a failure and not an empty provider",
      flat(unsupported).includes("该端点未提供模型列表（HTTP 404/405）"), flat(unsupported).slice(0, 900));
    check("the 404 state keeps the typed base URL and both model rows",
      (await inputValueAt("Base URL")) === withPort("/no-models/v1") && (await inputValueAt("模型 ID 1")) === MODEL_REASONING &&
      (await inputValueAt("模型 ID 2")) === MODEL_FAST);
    await settleFocus();
    await capture("s03b-discovery-unsupported", 1440, 900);
    await capture("s03b-discovery-unsupported", 720, 560);
    await sizeTo(1440, 900);

    stage = "discovery network failure";
    // A port that is really closed: the OS refuses the connection, so the transport's
    // own `无法连接端点` branch runs (no fixture, no injected transport).
    const closedPort = await new Promise((resolvePromise) => {
      const probe = createServer(() => {});
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        const port = typeof address === "object" && address ? address.port : 0;
        probe.close(() => resolvePromise(port));
      });
    });
    await typeAt("Base URL", withPort("/v1", closedPort));
    const directFailure = await providers.discover({ protocol: "openai-completions", baseUrl: withPort("/v1", closedPort), apiKey: API_KEY });
    check("main's own discovery answer for a closed port is the transport's 无法连接端点 failure",
      directFailure.status === "failure" && directFailure.message.includes("无法连接端点") && directFailure.candidates.length === 0,
      JSON.stringify(directFailure));
    await clickLabelled("获取模型列表");
    const networkUi = await until((body) => /模型发现失败|模型列表返回异常/.test(body), "network discovery attempt");
    check("the network-failure attempt keeps the typed base URL and both model rows",
      (await inputValueAt("Base URL")) === withPort("/v1", closedPort) && (await inputValueAt("模型 ID 1")) === MODEL_REASONING &&
      (await inputValueAt("模型 ID 2")) === MODEL_FAST);
    if (!flat(networkUi).includes("无法连接端点")) {
      // Real defect observed in the built app: main answers status "failure", the
      // renderer's parseDiscovery only accepts "failed", so the named network state
      // is replaced by a parse complaint. Recorded, not worked around.
      recordFinding({
        id: "discovery-ui-contract",
        title: "获取模型列表 的失败态在界面上变成「模型列表返回异常」",
        expected: "界面显示 main 的有界原因「无法连接端点」并保留表单",
        observed: "界面显示「模型列表返回异常」（parseDiscovery 拒绝了 main 的 status=\"failure\"）",
        mainAnswer: directFailure,
        contract: "main `DiscoveryStatus` = success|empty|failure|unsupported；renderer `parseDiscovery` 只接受 ok|empty|failed|unsupported|refused",
      });
    }
    check("the network-failure attempt keeps an explainable state in the form (never a silent empty list)",
      /模型发现失败|模型列表返回异常/.test(flat(networkUi)), flat(networkUi).slice(0, 600));
    await settleFocus();
    await capture("s03b-discovery-network", 1440, 900);
    await capture("s03b-discovery-network", 720, 560);
    await sizeTo(1440, 900);

    stage = "discovery success";
    await typeAt("Base URL", withPort("/v1"));
    const directDiscovery = await providers.discover({ protocol: "openai-completions", baseUrl: withPort("/v1"), apiKey: API_KEY });
    check("main's own discovery against the loopback endpoint really returns the served model ids",
      directDiscovery.status === "success" && JSON.stringify(directDiscovery.candidates) === JSON.stringify(DISCOVERED),
      JSON.stringify(directDiscovery));
    const discoveryRequestsBefore = received.filter((row) => String(row.url).endsWith("/models")).length;
    await clickLabelled("获取模型列表");
    const discoveryUi = await until((body) => /已同步 \d+ 个候选|模型列表返回异常/.test(body), "successful discovery attempt");
    const candidates = await evalJs("[...document.querySelectorAll('[aria-label=\"可选模型\"] li')].map((el) => el.textContent.replace(/^＋\\s*/, '').trim())");
    const discoveryRequests = received.filter((row) => String(row.url).endsWith("/models")).slice(discoveryRequestsBefore);
    check("the discovery request really went to GET <baseUrl>/models with the typed key",
      discoveryRequests.length === 1 && discoveryRequests[0].method === "GET" && discoveryRequests[0].url === "/v1/models" &&
      discoveryRequests[0].authorization === `Bearer ${API_KEY}`,
      JSON.stringify(discoveryRequests.map((row) => ({ method: row.method, url: row.url }))));
    const misses = await evalJs("document.querySelector('[data-testid=discovery-misses]')?.innerText ?? null");
    if (candidates.length !== DISCOVERED.length) {
      recordFinding({
        id: "discovery-ui-candidates",
        title: "获取模型列表 成功后不显示任何候选模型（「已同步」被「模型列表返回异常」取代）",
        expected: `界面列出 ${DISCOVERED.join(" / ")}，并把手动填写的 ${MODEL_FAST} 标为不在本次列表`,
        observed: "界面显示「模型列表返回异常」，可选模型列表为空；手动行仍在表单里",
        mainAnswer: directDiscovery,
        contract: "main `DiscoveryStatus` = success|empty|failure|unsupported；renderer `parseDiscovery` 只接受 ok|empty|failed|unsupported|refused",
      });
    }
    check("the successful discovery leaves an explainable state (candidates or a named refusal), never silence",
      candidates.length === DISCOVERED.length ? flat(discoveryUi).includes("已同步") : flat(discoveryUi).includes("模型列表返回异常"),
      flat(discoveryUi).slice(0, 700));
    check("the manual id survives the discovery attempt and stays saveable",
      (await inputValueAt("模型 ID 2")) === MODEL_FAST && (candidates.length !== DISCOVERED.length || String(misses).includes(MODEL_FAST)),
      JSON.stringify({ candidates, misses }));
    await settleFocus();
    await capture("s03b-discovered", 1440, 900);
    await capture("s03b-discovered", 720, 560);
    await sizeTo(1440, 900);
    // -------------------------------------------------- save: native models.json
    stage = "save provider";
    await clickLabelled("保存并写入 models.json");
    // The form closes on a successful write, so the evidence is the card itself.
    await waitProviderCards(1);
    const store = providerProfiles.list();
    profileId = store.profiles[0]?.id ?? "";
    managedKey = managedProviderId(profileId);
    check("main persisted exactly one profile with the temp-agent-dir native path",
      store.profiles.length === 1 && providers.nativePath === join(agentDir, "models.json"), JSON.stringify({ profiles: store.profiles.map((row) => row.id), nativePath: providers.nativePath }));
    check("the persisted profile is store-backed (no environment reference)",
      store.profiles[0]?.credentials.kind === "store" && store.profiles[0]?.protocol === "openai-completions",
      JSON.stringify(store.profiles[0]?.credentials));
    check("the profile's models keep the declared window/output/reasoning rows",
      JSON.stringify((store.profiles[0]?.models ?? []).map((row) => [row.id, row.contextWindow, row.maxTokens, row.reasoning])) ===
      JSON.stringify([[MODEL_REASONING, 131072, 8192, true], [MODEL_FAST, 32768, 4096, false]]),
      JSON.stringify(store.profiles[0]?.models));

    const nativeRaw = nativeText();
    const native = managedEntry();
    check("models.json holds exactly one managed `pidock-p-…` provider entry", native !== null && native.key === managedKey,
      JSON.stringify(native === null ? null : native.key));
    const entry = native.entry;
    check("the managed entry carries the protocol, the loopback base URL and both model rows",
      entry.api === "openai-completions" && entry.baseUrl === withPort("/v1") && (entry.models ?? []).length === 2,
      JSON.stringify({ api: entry.api, baseUrl: entry.baseUrl, models: entry.models?.length }));
    const reasoningRow = entry.models[0];
    check("the declared context window / output limit / reasoning levels are Pi's own row fields",
      JSON.stringify(Object.keys(reasoningRow).sort()) === JSON.stringify(["contextWindow", "id", "maxTokens", "name", "reasoning", "thinkingLevelMap"]) &&
      reasoningRow.id === MODEL_REASONING && reasoningRow.name === "Loopback Chat 7B" && reasoningRow.contextWindow === 131072 &&
      reasoningRow.maxTokens === 8192 && reasoningRow.reasoning === true &&
      reasoningRow.thinkingLevelMap?.high === "high" && reasoningRow.thinkingLevelMap?.medium === "medium" &&
      reasoningRow.thinkingLevelMap?.off === null && reasoningRow.thinkingLevelMap?.max === null,
      JSON.stringify(reasoningRow));
    check("the model with an unknown price has NO cost block in models.json (unknown is not 0)",
      entry.models[0].cost === undefined && !JSON.stringify(entry.models[0]).includes("cost"), JSON.stringify(entry.models[0]));
    check("the model with a declared price has the exact four numbers",
      JSON.stringify(entry.models[1]) === JSON.stringify({ id: MODEL_FAST, name: "Loopback Fast", reasoning: false, contextWindow: 32768, maxTokens: 4096,
        cost: { input: 0.5, output: 1.5, cacheRead: 0.05, cacheWrite: 0.1 } }), JSON.stringify(entry.models[1]));
    check("models.json is written inside the TEMP agent dir with 0600",
      nativeModels.path === join(agentDir, "models.json") && (statSync(nativeModels.path).mode & 0o777) === 0o600,
      JSON.stringify({ path: nativeModels.path, mode: (statSync(nativeModels.path).mode & 0o777).toString(8) }));
    check("no credential VALUE reaches models.json", !nativeRaw.includes(API_KEY), `bytes=${nativeRaw.length}`);
    check("models.json holds no `apiKey` field for a store-backed profile",
      !Object.hasOwn(entry, "apiKey") && !/"apiKey"\s*:/.test(nativeRaw), JSON.stringify(Object.keys(entry)));
    check("the real ~/.pi/agent was never written by this capture", !existsSync(join(realAgentDir, "models.json")) ||
      JSON.parse(readFileSync(join(realAgentDir, "models.json"), "utf8"))?.providers?.[managedKey] === undefined);
    const profileRaw = readFileSync(join(profile, "provider-profiles.json"), "utf8");
    check("the profile document holds metadata only: no key value and no credential-bearing field",
      !profileRaw.includes(API_KEY) && !/"(credential|apiKey|api_key|token|secret|password)"\s*:/i.test(profileRaw), `bytes=${profileRaw.length}`);
    const secretRaw = readFileSync(join(profile, "provider-secrets.json"), "utf8");
    check("the key exists only as ciphertext in the encrypted store",
      !secretRaw.includes(API_KEY) && /"ciphertext"\s*:/.test(secretRaw) && (statSync(join(profile, "provider-secrets.json")).mode & 0o777) === 0o600,
      `bytes=${secretRaw.length}`);

    const statusView = providers.status(taskId);
    check("main reports the unknown price as `null` and the declared price as its four numbers",
      statusView.profiles[0]?.models[0]?.cost === null &&
      JSON.stringify(statusView.profiles[0]?.models[1]?.cost) === JSON.stringify({ input: 0.5, output: 1.5, cacheRead: 0.05, cacheWrite: 0.1 }),
      JSON.stringify(statusView.profiles[0]?.models.map((row) => row.cost)));
    check("main reports the native entry as `synced` right after the save", statusView.profiles[0]?.native.state === "synced",
      String(statusView.profiles[0]?.native.state));

    stage = "provider card";
    const cardText = await evalJs(`document.querySelector('[data-testid=provider-card-${profileId}]')?.innerText ?? null`);
    check("the saved card names the provider, the protocol, the encrypted store and the key availability",
      flat(cardText).includes(PROVIDER_NAME) && flat(cardText).includes("OpenAI Chat Completions") &&
      flat(cardText).includes("本机加密存储") && flat(cardText).includes("密钥可用"), flat(cardText).slice(0, 700));
    check("the card names the native write state by name", flat(cardText).includes("已写入 models.json"), flat(cardText).slice(0, 700));
    check("the card shows the declared context/output of the default model",
      flat(cardText).includes("默认模型：loopback-chat-7b · 上下文 131,072 tokens · 最大输出 8,192"), flat(cardText).slice(0, 700));
    check("the card marks the reasoning model as 推理 and the priced row as 已声明价格, and leaves the unknown price unnamed",
      flat(cardText).includes(`${MODEL_REASONING} · 推理`) && flat(cardText).includes(`${MODEL_FAST} · 已声明价格`) &&
      !flat(cardText).includes(`${MODEL_REASONING} · 已声明价格`), flat(cardText).slice(0, 700));
    await scrollToTop("[data-testid=desktop-shell-content]");
    await settleFocus();
    await capture("s03-provider-card", 1440, 900);
    await capture("s03-provider-card", 720, 560);
    await sizeTo(1440, 900);

    // ------------------------------------------------ 选用: profile + model + level
    stage = "select for task";
    await chooseAt(`选用模型（${PROVIDER_NAME}）`, MODEL_REASONING);
    await chooseAt(`推理档位（${PROVIDER_NAME}）`, "high");
    await clickLabelled("选用");
    await untilMain(() => providers.status(taskId).state === "configured", "selection installed in the isolated context");
    await until((body) => body.includes("当前任务已选用"), "current-task badge");
    const selection = providerProfiles.selection(taskId);
    check("选用 persisted the profile, the model and the level on THIS task",
      selection?.profileId === profileId && selection?.modelId === MODEL_REASONING && selection?.thinkingLevel === "high",
      JSON.stringify(selection));
    check("the install really went through main → Host as `task/sdkProvider`",
      ops.filter((entry) => entry.op === "task/sdkProvider").length > 0 &&
      ops.filter((entry) => entry.op === "task/sdkProvider").every((entry) => JSON.stringify(entry.keys) === JSON.stringify(["config", "credential", "thinkingLevel"])),
      JSON.stringify(ops.filter((entry) => entry.op === "task/sdkProvider")));
    check("the isolated context accepted the configuration (state=configured)",
      providers.status(taskId).state === "configured", providers.status(taskId).state);
    const currentBadge = await evalJs(`document.querySelector('[data-testid=provider-current-${profileId}]')?.innerText ?? null`);
    check("the card points at the live selection of this task", flat(currentBadge).includes(`${MODEL_REASONING}`) && flat(currentBadge).includes("推理 高"),
      String(currentBadge));
    await scrollToTop("[data-testid=desktop-shell-content]");
    await settleFocus();
    await capture("s03-provider-selected", 1440, 900);
    await capture("s03-provider-selected", 720, 560);
    await sizeTo(1440, 900);
    const panelBefore = flat(await providerPanelText());

    // ------------------------------------------------------- the first REAL SDK turn
    stage = "back to conversation";
    await clickLabelled("返回任务工作区");
    await until((body) => body.includes("SDK JSONL 已确认历史"), "task conversation after the provider page");
    await untilMain(() => providers.status(taskId).state === "configured", "configured before the first turn");
    for (let i = 0; i < 200; i++) { if ((await composerModel()) === `${PROVIDER_NAME} · Loopback Chat 7B`) break; await wait(100); }
    check("the composer names the selected Provider and the model's display name",
      (await composerModel()) === `${PROVIDER_NAME} · Loopback Chat 7B`, String(await composerModel()));
    check("the provider requirement banner is gone once a model is selected",
      (await providerRequirement()) === null);
    check("no PIDOCK_PROVIDER_* credential exists in the process environment at send time",
      envCredentials().length === 0, JSON.stringify(envCredentials()));

    const send = async (prompt) => {
      await typeMessage(prompt);
      const pre = await evalJs(`(() => {
        const b = document.querySelector('button[aria-label="发送"]');
        const t = document.querySelector('textarea[aria-label="消息"]');
        const key = Object.keys(t).find((name) => name.startsWith('__reactProps'));
        return { disabled: b?.disabled ?? null, value: t?.value ?? null, type: b?.type ?? null,
          reactValue: key ? t[key].value : null, reactKeys: key ? Object.keys(t[key]).slice(0, 12) : null };
      })()`);
      await click("发送");
      await wait(400);
      const post = await evalJs(`(() => { const t = document.querySelector('textarea[aria-label="消息"]'); return { value: t?.value ?? null, notices: [...document.querySelectorAll('[role=status]')].map((el) => el.innerText.trim()).filter(Boolean) }; })()`);
      console.log("T03_SEND_DEBUG=" + JSON.stringify({ prompt, pre, post }));
    };
    // The staged reply block is the ONLY place a live delta can appear; sampling it every
    // 100ms turns "streaming" into a measurement instead of an assumption.
    const stagedText = () => evalJs(`(() => {
      const article = [...document.querySelectorAll('[aria-label="SDK 对话历史"] article')].find((el) => el.textContent.includes('暂存回复'));
      return article ? article.innerText.split(/\\s+/).filter(Boolean).join(' ') : null;
    })()`);
    const sampleStaged = async (label, steps = 60) => {
      const samples = [];
      for (let i = 0; i < steps; i++) {
        const value = await stagedText();
        // 停止 exists only while THIS turn is in flight, so it is the turn-scoped
        // "still open" signal (the usage block from earlier turns stays on screen).
        const inFlight = await stopButton();
        samples.push({ atMs: i * 100, staged: value, inFlight });
        if (value !== null || !inFlight) break;
        await wait(100);
      }
      console.log(`T03_STREAM_SAMPLES ${label}=` + JSON.stringify(samples.slice(0, 12)));
      return samples;
    };
    stage = "turn 1 streaming";
    providerState.mode = "slow";
    const receivedBefore = chatRequests().length;
    await send(PROMPTS.stream);
    const samples = await sampleStaged("slow");
    const firstStaged = samples.find((sample) => sample.staged !== null);
    check("the live stream renders a staged reply while the turn is still open",
      firstStaged !== undefined && firstStaged.staged.includes("STREAM-A-1"), JSON.stringify(samples.slice(0, 6)));
    const streamSamples = { samples: samples.slice(0, 12), firstStagedAtMs: firstStaged?.atMs ?? null,
      firstStagedText: firstStaged?.staged ?? null, turnInFlightAtFirstStaged: firstStaged?.inFlight ?? null,
      fullTextAfterFinish: "STREAM-A-1 STREAM-A-2 STREAM-A-3" };
    await settleFocus();
    await capture("conversation-streaming", 1440, 900);
    await capture("conversation-streaming", 720, 560);
    await sizeTo(1440, 900);
    await until((body) => body.includes("SDK 用量 · 输入 11 / 输出 7") && !body.includes("暂存回复"), "usage from the SDK after turn 1");
    const usageTurn = flat(await text());
    check("the SDK's own usage numbers are rendered under the assistant message",
      usageTurn.includes("SDK 用量 · 输入 11 / 输出 7"), usageTurn.slice(-600));
    check("the composer readout counts the reported tokens", String(await composerUsage()).includes("近期已报告输入+输出 18 tokens"),
      String(await composerUsage()));
    const jsonl1 = jsonlText(taskDir);
    check("the SDK JSONL holds the prompt, the streamed answer and the usage",
      jsonl1.includes(PROMPTS.stream) && jsonl1.includes("STREAM-A-3") && /"input":11[,}]/.test(jsonl1) && /"output":7[,}]/.test(jsonl1),
      JSON.stringify({ bytes: jsonl1.length }));
    const firstRequest = chatRequests()[receivedBefore];
    check("the turn is a real POST <baseUrl>/chat/completions carrying the stored key and the chosen model",
      firstRequest?.url === "/v1/chat/completions" && firstRequest?.authorization === `Bearer ${API_KEY}` &&
      firstRequest?.body.includes(MODEL_REASONING) && firstRequest?.body.includes(PROMPTS.stream),
      JSON.stringify({ url: firstRequest?.url, model: MODEL_REASONING }));
    await scrollToTop('[aria-label="SDK 对话历史"]');
    await settleFocus();
    await capture("conversation-usage", 1440, 900);
    await capture("conversation-usage", 720, 560);
    await sizeTo(1440, 900);

    // ------------------------------------------------------ cancel mid-stream
    stage = "turn 2 cancel";
    providerState.mode = "hold";
    const eventsBeforeHold = Number(await evalJs("(window.__t03Events ?? []).length"));
    await send(PROMPTS.hold);
    const holdSamples = await sampleStaged("hold", 40);
    const holdStaged = holdSamples.find((sample) => sample.staged !== null);
    check("the stop entry appears while the held turn is in flight", (await stopButton()) === true);
    if (holdStaged !== undefined) {
      await settleFocus();
      await capture("conversation-streaming-held", 1440, 900);
      await capture("conversation-streaming-held", 720, 560);
      await sizeTo(1440, 900);
    }
    await click("停止");
    const cancelled = await until((body) => body.includes("执行已取消"), "cancelled terminal");
    check("stopping mid-stream lands on the named 执行已取消 state", flat(cancelled).includes("执行已取消"), flat(cancelled).slice(-600));
    check("the stop entry is gone after the terminal", (await stopButton()) === false);
    const observedEvents = await evalJs("(window.__t03Events ?? []).map((row) => ({ kind: row?.kind ?? null, type: row?.event?.type ?? row?.turn?.state ?? null, turnId: row?.event?.turnId ?? row?.turn?.turnId ?? null, len: typeof row?.event?.text === 'string' ? row.event.text.length : null, sequence: row?.event?.sequence ?? null }))");
    const holdEvents = observedEvents.slice(eventsBeforeHold);
    const holdDeltas = holdEvents.filter((row) => row.type === "delta");
    console.log("T03_HOLD_EVENTS=" + JSON.stringify({ count: holdEvents.length, deltas: holdDeltas.length, first: holdEvents.slice(0, 4), sequences: holdDeltas.map((row) => row.sequence) }));
    check("the Host really delivered the held turn's deltas to the renderer (event channel, not the DOM)",
      holdDeltas.length >= 3, JSON.stringify(holdDeltas.map((row) => row.sequence)));
    if (holdStaged === undefined) {
      recordFinding({
        id: "streaming-deltas-after-first-turn",
        title: "会话的第一个回合之外，SSE 增量事件到达后再也不会渲染成「暂存回复」",
        expected: "服务器每 150ms 推送一段真实 SSE 增量；Host 已把 delta 事件送进渲染进程（本次 8 条），界面应在回合结束前显示「暂存回复 · 尚未核验」",
        observed: `40 次 100ms 采样里暂存区始终为空（${JSON.stringify(holdSamples.slice(0, 4))}）；渲染进程同一时刻收到了 ${holdDeltas.length} 条 delta 事件，sequence 为 ${holdDeltas[0]?.sequence}..${holdDeltas.at(-1)?.sequence}（无缺口）；同一会话的第一个回合同样采样，0ms 就拿到了「STREAM-A-1 STREAM-A-2」`,
        note: "回合本身正常：停止后为 执行已取消，JSONL 记录 aborted。DesktopConversation.tsx:378-382 的闸门解释了现象：start ACK 写入 turnId 之前到达的 delta 被静默丢弃（不计入 sequence），随后第一条被接受的 delta 的 sequence 已经 >1，于是每条 delta 都触发 reconcile 并清空 sequence 表，该回合的暂存文本永远为空。本次只记录，未修改产品代码。",
      });
    }
    const jsonl2 = jsonlText(taskDir);
    check("the cancelled turn's prompt and its aborted terminal are in the SDK JSONL",
      jsonl2.includes(PROMPTS.hold) && /"stopReason":"aborted"/.test(jsonl2), JSON.stringify({ aborted: /"stopReason":"aborted"/.test(jsonl2) }));
    check("the cancel happened while the endpoint's response was still open (nothing ended it)",
      providerState.mode === "hold" && held.filter((entry) => !entry.response.writableEnded).length === 1,
      JSON.stringify({ mode: providerState.mode, openHeld: held.filter((entry) => !entry.response.writableEnded).length }));
    check("the staged partial text of the cancelled turn never reaches the SDK JSONL",
      !jsonl2.includes("STREAM-B-"), "no STREAM-B fragment in the JSONL");
    await settleFocus();
    await capture("conversation-cancelled", 1440, 900);
    await capture("conversation-cancelled", 720, 560);
    await sizeTo(1440, 900);

    // ------------------------------------------- follow-up in the same conversation
    stage = "turn 3 follow-up";
    providerState.mode = "ok";
    await send(PROMPTS.follow);
    await until((body) => body.includes("STREAM-C-3") && body.includes("STREAM-A-1"), "follow-up answer with the earlier history");
    const history = flat(await historyText());
    check("the follow-up turn keeps the whole conversation: both prompts and both answers",
      history.includes(PROMPTS.stream) && history.includes("STREAM-A-1") && history.includes(PROMPTS.follow) && history.includes("STREAM-C-1"),
      history.slice(0, 1200));
    check("the cancelled turn's prompt stays in the history as a real turn",
      history.includes(PROMPTS.hold), history.slice(0, 1200));
    check("the conversation now holds more than one reported usage block",
      (history.match(/SDK 用量 · 输入 11 \/ 输出 7/g) ?? []).length >= 2, history.slice(0, 1200));
    const jsonl3 = jsonlText(taskDir);
    check("the same SDK JSONL carries all three prompts (one conversation, no second session)",
      [PROMPTS.stream, PROMPTS.hold, PROMPTS.follow].every((prompt) => jsonl3.includes(prompt)),
      JSON.stringify({ sessions: readdirSync(join(taskDir, ".pidock-sdk-sessions", "main")).filter((name) => name.endsWith(".jsonl")) }));
    await scrollToTop('[aria-label="SDK 对话历史"]');
    await settleFocus();
    await capture("conversation-followup", 1440, 900);
    await capture("conversation-followup", 720, 560);
    await sizeTo(1440, 900);

    // ------------------------------------------------- named upstream failures
    for (const [mode, prompt, state] of [["fail401", PROMPTS.fail401, "conversation-failed-401"], ["fail500", PROMPTS.fail500, "conversation-failed-500"]]) {
      stage = `turn ${mode}`;
      providerState.mode = mode;
      const before = chatRequests().length;
      await send(prompt);
      const failed = await until((body) => body.includes("执行未完成") && body.includes("sdk-turn-failed"), `${mode} named failure`);
      // `sdk-kernel-router` bounds EVERY failed turn to `sdk-turn-failed`, so the UI never
      // shows the endpoint's status line, its body or the key — only the Host's own code.
      check(`the ${mode} upstream failure is reported by NAME (sdk-turn-failed), never as raw upstream text`,
        flat(failed).includes("执行未完成：sdk-turn-failed") && flat(failed).includes("执行状态 · 失败"), flat(failed).slice(-600));
      check(`the ${mode} upstream body text never reaches the UI`,
        !failed.includes(UPSTREAM_MARKER) && !failed.includes(API_KEY), "no raw upstream text, no key");
      check(`the ${mode} turn really reached the loopback endpoint with the stored key`,
        chatRequests().length === before + 1 && chatRequests().at(-1)?.authorization === `Bearer ${API_KEY}`,
        JSON.stringify({ requests: chatRequests().length }));
      check(`no raw upstream text or key was persisted by the ${mode} turn`,
        !readFileSync(join(profile, "provider-profiles.json"), "utf8").includes(API_KEY) &&
        !jsonlText(taskDir).includes(UPSTREAM_MARKER), "profile store and JSONL clean");
      await settleFocus();
      await capture(state, 1440, 900);
      await capture(state, 720, 560);
      await sizeTo(1440, 900);
    }

    // -------------------------------------- external edit of the managed entry
    stage = "external edit";
    const externalDoc = nativeDoc();
    externalDoc.providers[managedKey] = {
      ...externalDoc.providers[managedKey],
      baseUrl: withPort("/v1", closedPort),
      "x-evidence-external-edit": "T03 外部修改",
    };
    writeFileSync(nativeModels.path, `${JSON.stringify(externalDoc, null, 2)}\n`);
    const externalSha = sha256(readFileSync(nativeModels.path));
    await gotoCapabilities();
    const modified = await until((body) => body.includes("外部修改"), "modified native state in the list");
    check("an entry edited outside PiDock is named `外部修改` in the list",
      flat(modified).includes("外部修改"), flat(modified).slice(0, 700));
    check("main reports the managed state as `modified`",
      providers.status(taskId).profiles[0]?.native.state === "modified", String(providers.status(taskId).profiles[0]?.native.state));
    check("reading the list did NOT overwrite the external value", sha256(readFileSync(nativeModels.path)) === externalSha,
      `${externalSha} -> ${sha256(readFileSync(nativeModels.path))}`);
    await scrollToTop("[data-testid=desktop-shell-content]");
    await settleFocus();
    await capture("s03-native-modified", 1440, 900);
    await capture("s03-native-modified", 720, 560);
    await sizeTo(1440, 900);

    stage = "conflict refusal";
    await clickLabelled("编辑");
    await until((body) => body.includes("编辑供应商："), "edit form");
    await clickLabelled("保存并写入 models.json");
    const conflict = await until((body) => body.includes("已被外部改动") && body.includes("PiDock 没有覆盖它"), "named conflict panel");
    check("saving over an externally edited entry is refused BY NAME and nothing is written",
      flat(conflict).includes("PiDock 没有覆盖它") && sha256(readFileSync(nativeModels.path)) === externalSha,
      flat(conflict).slice(0, 700));
    await settleFocus();
    await capture("s03-native-conflict", 1440, 900);
    await capture("s03-native-conflict", 720, 560);
    await sizeTo(1440, 900);

    stage = "explicit reconcile";
    await clickLabelled("用这份表单覆盖外部修改");
    await waitProviderCards(1);
    const reconciled = managedEntry();
    check("the explicit reconcile replaced the external value with PiDock's own entry",
      reconciled?.key === managedKey && Object.hasOwn(reconciled.entry, "x-evidence-external-edit") === false &&
      reconciled.entry.baseUrl === withPort("/v1"), JSON.stringify(reconciled?.entry?.baseUrl));
    check("the managed entry is `synced` again after the reconcile",
      providers.status(taskId).profiles[0]?.native.state === "synced", String(providers.status(taskId).profiles[0]?.native.state));
    const backupPath = join(agentDir, "models.json.bak");
    check("the overwritten external version is kept in the .bak file, not silently destroyed",
      existsSync(backupPath) && readFileSync(backupPath, "utf8").includes("x-evidence-external-edit"),
      existsSync(backupPath) ? `bak bytes=${readFileSync(backupPath, "utf8").length}` : "no .bak");
    check("the reconcile did not change the task's selection (same profile/model/level)",
      providerProfiles.selection(taskId)?.modelId === MODEL_REASONING && providerProfiles.selection(taskId)?.thinkingLevel === "high",
      JSON.stringify(providerProfiles.selection(taskId)));
    await scrollToTop("[data-testid=desktop-shell-content]");
    await settleFocus();
    await capture("s03-native-reconciled", 1440, 900);
    await capture("s03-native-reconciled", 720, 560);
    await sizeTo(1440, 900);

    // ------------------------------------------------------ pre-restart reference
    stage = "before restart";
    await scrollToTop("[data-testid=desktop-shell-content]");
    await settleFocus();
    await capture("s03-providers-before-restart", 1440, 900);
    await capture("s03-providers-before-restart", 720, 560);
    await sizeTo(1440, 900);
    // A cold read of the SAME renderer state the restart process will show: reload first,
    // so the comparison is between two equally cold mounts.
    await clickLabelled("返回任务工作区");
    await evalJs("(() => { location.reload(); return true; })()");
    await wait(900);
    await until((body) => body.includes(PROJECT_NAME) || body.includes("未归属任务"), "shell boot after reload");
    await gotoTask();
    await until((body) => body.includes("SDK 用量 · 输入 11 / 输出 7") && body.includes("STREAM-A-1"), "history after the reload");
    for (let i = 0; i < 200; i++) { if ((await composerModel())?.includes(MODEL_REASONING)) break; await wait(100); }
    await scrollToTop('[aria-label="SDK 对话历史"]');
    await settleFocus();
    await capture("conversation-before-restart", 1440, 900);
    await capture("conversation-before-restart", 720, 560);
    const historyBefore = flat(await historyText());
    check("the reloaded conversation still shows the provider chip and the real usage",
      (await composerModel()) === `${PROVIDER_NAME} · Loopback Chat 7B` && historyBefore.includes("SDK 用量 · 输入 11 / 输出 7"),
      String(await composerModel()));

    // ---------------------------------------- real process restart (second OS process)
    stage = "restart process";
    const expect = {
      taskId, taskDir, profileId, managedKey,
      nativePath: nativeModels.path,
      nativeSha256: sha256(readFileSync(nativeModels.path)),
      prompts: PROMPTS,
      historyMarker: "STREAM-A-1",
      historyText: historyBefore,
      panelText: panelBefore,
    };
    const restartOut = await new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [scriptPath, "--phase", "restart", "--out", output], {
        env: { ...process.env,
          PIDOCK_T03_TASK_ID: taskId, PIDOCK_T03_TASK_DIR: taskDir, PIDOCK_T03_PROFILE_ID: profileId,
          PIDOCK_T03_EXPECT: JSON.stringify(expect) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (data) => { stdout += data; process.stdout.write(`[t03-restart] ${data}`); });
      child.stderr.on("data", (data) => { stderr += data; process.stderr.write(`[t03-restart] ${data}`); });
      child.on("error", reject);
      child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    });
    check("the restart phase exited 0", restartOut.code === 0, JSON.stringify({ code: restartOut.code, stderr: restartOut.stderr.slice(-2000) }));
    const restartLog = JSON.parse(readFileSync(join(output, "restart-log.json"), "utf8"));
    check("restart process reported a different pid", restartLog.pid !== process.pid, `${process.pid} -> ${restartLog.pid}`);
    check("the restart process read the same temp agent dir", restartLog.agentDir === agentDir, String(restartLog.agentDir));
    check("the restart process did not rewrite models.json", restartLog.nativeSha256 === expect.nativeSha256,
      `${expect.nativeSha256} -> ${restartLog.nativeSha256}`);
    check("the restart process re-read the same persisted selection",
      restartLog.selection?.profileId === profileId && restartLog.selection?.modelId === MODEL_REASONING &&
      restartLog.selection?.thinkingLevel === "high", JSON.stringify(restartLog.selection));
    check("the restart process re-installed the Provider as `configured` from the temp files",
      restartLog.status?.state === "configured", JSON.stringify(restartLog.status));
    check("the restart process re-rendered the Provider list and the conversation",
      restartLog.shots.map((shot) => shot.state).includes("s03-providers-after-restart") &&
      restartLog.shots.map((shot) => shot.state).includes("conversation-after-restart"),
      JSON.stringify(restartLog.shots.map((shot) => shot.state)));
    const restartPixelDiffs = [];
    for (const [width, height, beforeState, afterState, label] of [
      [1440, 900, "s03-providers-before-restart", "s03-providers-after-restart", "Provider list"],
      [720, 560, "s03-providers-before-restart", "s03-providers-after-restart", "Provider list"],
      [1440, 900, "conversation-before-restart", "conversation-after-restart", "conversation"],
      [720, 560, "conversation-before-restart", "conversation-after-restart", "conversation"],
    ]) {
      const beforeName = shotFile(width, height, beforeState);
      const afterName = shotFile(width, height, afterState);
      const beforeShot = shots.find((shot) => shot.file === beforeName);
      const afterShot = restartLog.shots.find((shot) => shot.file === afterName);
      if (!beforeShot || !afterShot) throw Error(`missing restart comparison shot ${beforeName} / ${afterName}`);
      const diff = screenshotDiff(readFileSync(join(output, beforeName)), readFileSync(join(output, afterName)));
      restartPixelDiffs.push({ view: `${label} ${width}x${height}`, byteIdentical: beforeShot.sha256 === afterShot.sha256,
        beforeSha256: beforeShot.sha256, afterSha256: afterShot.sha256, ...diff });
      check(`post-restart ${label} ${width}x${height} screenshot matches the pre-restart one except for sub-pixel text antialiasing`,
        diff.differingPixels / diff.totalPixels <= 0.00005 && diff.maxChannelDelta <= 2, JSON.stringify(diff));
    }

    // Build identity: the runtime the capture really ran in and the exact renderer
    // bundle whose pixels are in the PNGs.
    const assetsDir = join(import.meta.dirname, "..", "dist", "renderer", "assets");
    const bundles = readdirSync(assetsDir).filter((name) => /^index-.*\.(js|css)$/.test(name))
      .map((name) => ({ file: `packages/shell/dist/renderer/assets/${name}`, sha256: sha256(readFileSync(join(assetsDir, name))) }));
    let revision = "unknown"; let trackedFilesDirty = "unknown";
    try { revision = (await import("node:child_process")).execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: repoRoot }).trim(); } catch { /* recorded as unknown */ }
    try {
      const { relative } = await import("node:path");
      const excluded = relative(repoRoot, output);
      const args = ["status", "--porcelain", "--untracked-files=no", "--", "."];
      if (excluded && !excluded.startsWith("..") && !isAbsolute(excluded)) args.push(`:(exclude)${excluded}`);
      trackedFilesDirty = (await import("node:child_process")).execFileSync("git", args, { encoding: "utf8", cwd: repoRoot }).trim() ? "true" : "false";
    } catch { /* recorded as unknown */ }
    const runtime = { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome,
      v8: process.versions.v8, platform: process.platform, arch: process.arch, toolingNode: process.versions.node };
    const log = {
      ticket: "#138 Provider 原生配置与首个真实对话 — real Electron evidence (T03)",
      command, repoRoot, revision, trackedFilesDirty, runtime, bundles,
      generatedBy: "scripts/electron-pencil-v1-t03-capture.mjs",
      phase: "primary",
      pid: process.pid,
      // Everything the README must label: what is the product's, and what was replaced.
      realVsTest: {
        real: ["built React renderer over file://", "production main wiring (createTrustedWindow/registerIpc/ProviderWiring)",
          "real utilityProcess task Host + isolated SDK worker context", "real Provider protocol + SDK turn + usage projection",
          "real NativeModelsFile (managed `pidock-*` slice of models.json)", "real ProviderSecretStore (ciphertext, 0600, revision)",
          "real HTTP discovery + real streaming/cancel/failure paths", "second Electron OS process for the restart"],
        replaced: ["OS keychain cipher → deterministic AES-256-GCM test cipher (createTestSafeStorage)",
          "real online provider → loopback OpenAI-compatible HTTP server on 127.0.0.1",
          "real ~/.pi/agent → temp PIDOCK_AGENT_DIR"],
        notExercised: ["real online provider account", "Windows", "real OS Keychain encryption"],
      },
      agentDir: { resolved: agentDir, modelsJson: nativeModels.path, realAgentDir, isTemp: true },
      seed: {
        registry: "ProjectRegistry.create (real projects.json under the isolated userData)",
        project: { id: projectId, name: PROJECT_NAME, sources: ["provider-notes (plain directory)"], repositories: [] },
        task: { taskId, taskDir, createdBy: "performCreationOperation (the function behind shell/createTask), plain-dirs mode" },
      },
      provider: {
        profileId, managedKey, nativePath: nativeModels.path,
        protocol: "openai-completions", baseUrl: withPort("/v1"),
        models: providerProfiles.list().profiles[0]?.models,
        costs: providers.status(taskId).profiles[0]?.models.map((row) => row.cost),
        selection, state: providers.status(taskId).state,
        envCredentials: envCredentials(),
        discovery: { request: received.filter((row) => String(row.url).endsWith("/models")).map((row) => ({ method: row.method, url: row.url })),
          candidates: DISCOVERED },
        storedKey: { plaintextInModelsJson: nativeText().includes(API_KEY),
          plaintextInProfileStore: readFileSync(join(profile, "provider-profiles.json"), "utf8").includes(API_KEY),
          plaintextInSecretStore: readFileSync(join(profile, "provider-secrets.json"), "utf8").includes(API_KEY) },
        nativeEntry: managedEntry()?.entry ?? null,
        externalEdit: { sha256BeforeReconcile: externalSha, backup: existsSync(join(agentDir, "models.json.bak")) },
      },
      loopback: {
        port: providerState.port,
        requests: received.map((row) => ({ method: row.method, url: row.url, mode: row.mode,
          authorization: row.authorization === `Bearer ${API_KEY}` ? "Bearer <stored key>" : row.authorization,
          bodyBytes: row.body.length, bodyCarriesModel: row.body.includes(MODEL_REASONING) })),
      },
      turns: { streaming: streamSamples, streamFailures: findings.filter((finding) => finding.id === "streaming-deltas-after-first-turn").length, usage: { input: 11, output: 7 }, cancelled: "held stream + 停止",
        failures: ["HTTP 401", "HTTP 500"], followUpInSameConversation: true },
      restart: {
        kind: "real OS process restart of the capture harness wiring (still not dist/main/main.js lifecycle)",
        pidBefore: process.pid, pidAfter: restartLog.pid,
        records: { nativeSha256: restartLog.nativeSha256, selection: restartLog.selection, status: restartLog.status },
        historyTextEqual: restartLog.historyText === historyBefore,
        panelTextEqual: restartLog.panelText === panelBefore,
        screenshotComparison: restartPixelDiffs, shots: restartLog.shots, assertions: restartLog.assertions,
      },
      assertions,
      findings,
      shots,
    };
    writeFileSync(join(output, "capture-log.json"), `${JSON.stringify(log, null, 2)}\n`);
    console.log("T03_CAPTURE_LOG=" + JSON.stringify({ revision, trackedFilesDirty, shots: shots.map((shot) => shot.file),
      restartShots: restartLog.shots.map((shot) => shot.file), profileId, taskId, assertions: assertions.length,
      restartAssertions: restartLog.assertions.length }));
  } catch (error) {
    console.error(`T03_CAPTURE_FAILED [${phase}]`, stage, error);
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
      label: `PencilV1 T03 capture cleanup (${phase})`,
    });
    for (const child of children) child.kill();
    if (views?.shellView.webContents.debugger.isAttached()) views.shellView.webContents.debugger.detach();
    views?.window.destroy();
    providerState.server?.close();
    if (phase !== "restart") rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    if (cleanupFailures.length) { console.error(`T03_CAPTURE_CLEANUP_FAILED [${phase}] ` + JSON.stringify(cleanupFailures)); process.exitCode = process.exitCode ?? 1; }
    exitNow(process.exitCode ?? 0, "done");
  }
}
void run();
