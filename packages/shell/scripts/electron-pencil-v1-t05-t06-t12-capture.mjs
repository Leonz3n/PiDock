// [PiDock pencil-v1] (#140 / T05, #141 / T06, #147 / T12) real-Electron evidence for
// 会话工具与审批、跨任务共享真实路径的写互斥、任务归档／清理。
//
// Run after `pnpm --filter @pidock/shell build`:
//   pnpm --filter @pidock/shell exec electron scripts/electron-pencil-v1-t05-t06-t12-capture.mjs \
//     --out docs/evidence/pencil-v1-t05
//
// Boot path is identical to the #136/#137/#138 harnesses (`electron-pencil-v1-t01/02/03/07-capture.mjs`):
// the compiled production runtime modules are imported directly (NOT `dist/main/main.js`) with the
// production wiring decisions — `createTrustedWindow(..., "production")`, `registerIpc` over a real
// `TaskRootIndex` / `ProjectRegistry` / `PerTaskHostRegistry` / `ProjectTaskCreation` (wired with the
// REAL `WorktreeMetadataLock`, exactly like `main.ts`) / `ProviderWiring` (REAL `ProviderSecretStore`
// + `NativeModelsFile`) — and the built React renderer (`dist/renderer/index.html`, no fixture entry,
// no dev-server override). Every task is created through `performCreationOperation`, the exact
// function behind `shell/createTask`; nothing is a hand-written task record.
//
// What is deliberately NOT real, and is named in each README:
// - the credential cipher: `createTestSafeStorage()` (deterministic AES-256-GCM) instead of the OS
//   keychain, because the capture must never touch the user's real Keychain item;
// - the endpoint: a loopback HTTP/SSE server on 127.0.0.1 speaking the OpenAI Chat Completions
//   protocol (there is no real online provider account here), while the Provider protocol, the SDK
//   turn, the tool loop, the Host, the tool broker and the UI are the real ones;
// - `PIDOCK_AGENT_DIR` points at a temp dir, so Pi's `models.json` is never the real `~/.pi/agent`.
//
// The tool calls are REAL: the loopback model emits `tool_calls` SSE frames, the SDK executes them
// through the Host's `SdkAgentToolBroker`, and every assertion about an effect is read from the
// disk, the process table, the Git repository or the Host's own records — never from UI text alone.
//
// Hang discipline: the deadline timer and the uncaught-error handlers are armed before the compiled
// `dist` graph is imported (dynamically, inside the guarded region).
import { app, utilityProcess } from "electron";
import { createUnavailableHostClient } from "./unavailable-host-client.mjs";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { inflateSync } from "node:zlib";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { shutdownTestRegistry } from "./shutdown-test-registry.mjs";

// The dev-server override is inadmissible evidence: clear it before boot so this
// capture can only ever load the packaged `file://` renderer.
delete process.env["PIDOCK_RENDERER_URL"];
delete process.env["PIDOCK_TASK_URL"];
if (process.env["PIDOCK_RENDERER_URL"]) throw Error("PIDOCK_RENDERER_URL survived the clear");

const scriptPath = resolve(import.meta.dirname, "electron-pencil-v1-t05-t06-t12-capture.mjs");
const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const argValue = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const phase = argValue("--phase") ?? "primary";
// `--only t06,t12` limits this run to those tickets' sections: a failure earlier in the
// run cannot then hide the later tickets' evidence.
const onlyList = (argValue("--only") ?? "").split(",").map((row) => row.trim()).filter(Boolean);
// The three evidence directories this one run writes: T05, T06 and T12 are separate tickets,
// so their screenshots/logs must not be mixed in one folder.
const outBase = argValue("--out-base") ?? "docs/evidence";
const outRoot = isAbsolute(outBase) ? outBase : resolve(repoRoot, outBase);
const outputFor = { t05: join(outRoot, "pencil-v1-t05"), t06: join(outRoot, "pencil-v1-t06"), t12: join(outRoot, "pencil-v1-t12") };
const command = "pnpm --filter @pidock/shell exec electron scripts/electron-pencil-v1-t05-t06-t12-capture.mjs --out-base docs/evidence";
// A fixed (not random) temp root keeps the captured paths stable, so a re-run at the
// same revision renders byte-identical PNGs. Isolated under the OS temp dir.
const root = join(tmpdir(), "pidock-pencil-v1-t05-capture");
const profile = join(root, "profile");
const taskRoot = join(root, "tasks");
const sourcesRoot = join(root, "sources");
const remotesRoot = join(root, "remotes");
const agentDir = join(root, "agent");
const chromiumProfile = join(root, phase === "restart" ? "chromium-restart" : "chromium");
app.setPath("userData", chromiumProfile);
const lockRoot = join(chromiumProfile, "shared-path-locks");
// The temp agent dir is what Pi's `models.json` is written into. The real
// `~/.pi/agent` must never be the target of this capture.
const realAgentDir = join(homedir(), ".pi", "agent");
if (resolve(agentDir) === resolve(realAgentDir)) throw Error("refusing to use the real ~/.pi/agent");
process.env["PIDOCK_AGENT_DIR"] = agentDir;

const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const flat = (value) => String(value).replace(/\s+/g, " ").trim();
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const shotFile = (width, height, state) => `${width}x${height}-${state}.png`;
const pngPixelSize = (png) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

/** A dependency-free PNG reader for the exactly-sized screenshots this harness writes. */
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

void pngPixels;
const git = (cwd, args) => execFileSync("git", args, {
  cwd, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
  stdio: ["ignore", "pipe", "pipe"],
}).trim();
const SEED_COMMIT_DATE = "2026-11-09T09:00:00+0000";
/** One real temp Git repository with its own bare `origin` in the temp dir. */
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
    env: { ...process.env, GIT_AUTHOR_DATE: SEED_COMMIT_DATE, GIT_COMMITTER_DATE: SEED_COMMIT_DATE },
    stdio: ["ignore", "pipe", "pipe"] });
  git(dir, ["push", "-u", "origin", "main"]);
  return { dir, remote, head: git(dir, ["rev-parse", "HEAD"]) };
}
const worktreePaths = (repo) => git(repo, ["worktree", "list", "--porcelain"]).split("\n")
  .filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));
const worktreeRealPaths = (repo) => worktreePaths(repo).map((path) => realpathSync(path));

const children = [];
const childByTask = new Map();
let views, registry, index, projects, providers, providerProfiles, nativeModels, secrets;

// Arm the deadline and the failure handlers BEFORE any heavyweight work.
let exiting = false;
const exitNow = (code, why) => {
  if (exiting) return;
  exiting = true;
  console.error(`T05_T06_T12_CAPTURE_EXIT ${phase}`, code, why);
  try { app.exit(code); } catch { process.exit(code); }
};
const watchdog = setTimeout(() => exitNow(1, "watchdog timeout"), 1500000);
process.on("uncaughtException", (error) => exitNow(1, `uncaughtException ${error?.stack ?? error}`));
process.on("unhandledRejection", (error) => {
  const stack = /** @type {{ stack?: string } | undefined} */ (error)?.stack;
  exitNow(1, `unhandledRejection ${stack ?? error}`);
});
// Test-only guard: a noop listener suppresses Electron's default quit on
// window-all-closed, which would race the explicit app.exit(process.exitCode).
app.on("window-all-closed", () => {});

const PROJECT_NAME = "T05/T06/T12 验收工作区";
const PROJECT_DESCRIPTION = "会话工具与审批 · 共享目录写互斥 · 归档与清理（#140 / #141 / #147）";
const TASK_A = "T05 工具与审批验收";
const TASK_B = "T06 共享目录验收";
const TASK_C = "T12 归档清理验收";
const PROVIDER_NAME = "Loopback 工具端点";
const API_KEY = "sk-t05t06t12-loopback-9d31c4f0ab6e";
const MODEL = "loopback-tools-7b";
// #148 requires the task id in the convention, otherwise two tasks would land on one branch.
const BRANCH_TEMPLATE = "evidence/{taskId}";

// ---------------------------------------------------------------- loopback endpoint
// A real HTTP server on 127.0.0.1 speaking the OpenAI Chat Completions protocol. It is
// the ONLY test double in the tool path: the SSE frames it writes are what a real
// provider would write, and the SDK/Host/broker/UI consuming them are the product's.
// Every prompt carries a marker; the marker selects the scripted reply, so several
// tasks can run concurrently without a shared mutable mode.
const received = [];
const providerState = { port: 0 };
/** Filled in after the tasks exist: the real in-task link names. */
const links = { a: "", b: "", c: "" };
const linkReal = { a: "", b: "", c: "" };
const worktreeOf = { a: "", b: "", c: "" };
/** In-task repository folder name: a write must land inside a worktree, not at the task root. */
const repoDirOf = { a: "", b: "", c: "" };
const PROMPTS = {
  approve: "[T05-APPROVE] 请执行一次写文件的命令，我需要看到审批卡。",
  deny: "[T05-DENY] 请再执行一次写文件的命令。",
  cancel: "[T05-CANCEL] 请执行一个会持续一会儿的命令。",
  readonly: "[T05-READONLY] 请写入一个文件。",
  escape: "[T05-ESCAPE] 请读取任务外的文件。",
  pending: "[T05-PENDING] 请执行一次会留下文件的命令。",
  holdA: "[T06-HOLD] 请在共享目录里执行一个会持续一会儿的命令。",
  writeB: "[T06-WRITE] 请在共享目录里写入一个文件。",
  writeB2: "[T06-WRITE2] 请再次在共享目录里写入同一个文件。",
  writeA2: "[T06-WRITE-A] 请在共享目录里写入文件。",
  privateC: "[T06-PRIVATE] 请在本任务的工作副本里写入一个文件。",
  t12uncommitted: "[T12-DIRTY] 请在任务工作副本里留下一个未提交的修改。",
  t12clean: "[T12-CLEAN] 请报告任务状态。",
};
const MARKERS = Object.keys(PROMPTS).map((key) => [PROMPTS[key], key]);
const markerOf = (text) => MARKERS.find(([prompt]) => String(text).includes(prompt))?.[1] ?? null;
/** One tool call per marker; `args` is built from the real link names at request time. */
const scriptFor = (marker) => {
  switch (marker) {
    case "approve": return { tool: "exec.run", args: { command: "printf 'T05-APPROVED-ONCE' > t05-approved.txt" } };
    case "deny": return { tool: "exec.run", args: { command: "printf 'T05-DENIED-ONCE' > t05-denied.txt" } };
    case "cancel": return { tool: "exec.run", args: { command: "sleep 8; printf 'T05-CANCELLED' > t05-cancelled.txt" } };
    case "readonly": return { tool: "fs.write", args: { path: "t05-readonly-write.txt", content: "只读档不应写入" } };
    case "escape": return { tool: "fs.read", args: { path: "../../../../../../etc/passwd" } };
    case "pending": return { tool: "exec.run", args: { command: "printf 'T05-PENDING-NEVER-RAN' > t05-pending.txt" } };
    case "holdA": return { tool: "exec.run", args: { command: "sleep 9", cwd: links.a } };
    case "writeB": return { tool: "fs.write", args: { path: `${links.b}/t06-b.txt`, content: "task B 共享目录写入" } };
    case "writeB2": return { tool: "fs.write", args: { path: `${links.b}/t06-b.txt`, content: "task B 共享目录写入（释放后重试）" } };
    case "writeA2": return { tool: "fs.write", args: { path: `${links.a}/t06-a2.txt`, content: "task A 重新指向后的写入" } };
    case "privateC": return { tool: "fs.write", args: { path: `${repoDirOf.c}/t06-private-c.txt`, content: "task C 私有工作副本写入" } };
    case "t12uncommitted": return { tool: "fs.write", args: { path: `${repoDirOf.c}/t12-uncommitted.txt`, content: "T12 未提交的工作\n" } };
    default: return null;
  }
};

function startProvider() {
  return new Promise((resolvePromise) => {
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => {
        const url = request.url ?? "";
        received.push({ method: request.method, url, authorization: request.headers.authorization ?? "", body });
        if (request.method === "GET" && url.endsWith("/models")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model", owned_by: "loopback" }] }));
          return;
        }
        if (!url.endsWith("/chat/completions")) { response.writeHead(404).end(); return; }
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* recorded as null */ }
        const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
        const lastUser = [...messages].reverse().find((row) => row?.role === "user");
        const marker = markerOf(typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? ""));
        // The SDK sends the whole conversation: a tool result in it means the tool call
        // already ran (or was refused), so the second request gets the closing text.
        // ONLY the last message counts: an earlier turn's tool result stays in the
        // history, and treating it as the current continuation would turn every later
        // prompt into a plain text answer instead of the scripted tool call.
        const lastMessage = messages.at(-1);
        const toolResult = lastMessage?.role === "tool" || lastMessage?.role === "toolResult" ? lastMessage : undefined;
        const toolResultText = (() => {
          const content = toolResult?.content;
          if (typeof content === "string") return content;
          if (Array.isArray(content)) return content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("\n");
          return "";
        })().slice(0, 600);
        const tag = marker ?? "X";
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        const frame = (delta, extra = {}) => `data: ${JSON.stringify({
          id: `chatcmpl-loopback-${tag}`, object: "chat.completion.chunk", model: MODEL,
          choices: [{ index: 0, delta, finish_reason: null }], ...extra,
        })}\n\n`;
        response.write(frame({ role: "assistant", content: `TOOL-LOOP-${tag}-1 ` }));
        if (toolResult !== undefined) {
          // The closing turn quotes the Host's own tool result verbatim, so the screenshot
          // shows the refusal/effect text the broker produced (not a harness claim).
          response.write(frame({ content: `工具结果原文：${toolResultText} ` }));
          response.write(frame({ content: `TOOL-LOOP-${tag}-DONE` }));
          response.write(`data: ${JSON.stringify({ id: `chatcmpl-loopback-${tag}`, object: "chat.completion.chunk", model: MODEL,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 } })}\n\n`);
          response.write("data: [DONE]\n\n");
          response.end();
          return;
        }
        const script = scriptFor(marker);
        if (script === null) {
          response.write(frame({ content: `TOOL-LOOP-${tag}-TEXT` }));
          response.write(`data: ${JSON.stringify({ id: `chatcmpl-loopback-${tag}`, object: "chat.completion.chunk", model: MODEL,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 13, completion_tokens: 5, total_tokens: 18 } })}\n\n`);
          response.write("data: [DONE]\n\n");
          response.end();
          return;
        }
        // A real streaming tool call: id/name first, then the JSON arguments in fragments.
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
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      providerState.port = typeof address === "object" && address ? address.port : 0;
      resolvePromise(server);
    });
    providerState.server = server;
  });
}
const withPort = (path) => `http://127.0.0.1:${providerState.port}${path}`;
const chatRequests = () => received.filter((row) => String(row.url).endsWith("/chat/completions"));

async function run() {
  const restart = phase === "restart";
  let stage = "startup";
  // One log per ticket: separate directories, separate capture-log.json files.
  const logs = {
    t05: { shots: [], assertions: [], findings: [], failed: [] },
    t06: { shots: [], assertions: [], findings: [], failed: [] },
    t12: { shots: [], assertions: [], findings: [], failed: [] },
  };
  const current = { ticket: "t05" };
  const recordFinding = (finding) => {
    logs[current.ticket].findings.push(finding);
    console.log(`T05_T06_T12_FINDING ${current.ticket}=` + JSON.stringify({ id: finding.id, title: finding.title }));
  };
  const check = (name, condition, detail = "") => {
    const entry = { name, detail: String(detail).slice(0, 700) };
    if (!condition) {
      entry.ok = false;
      logs[current.ticket].assertions.push(entry);
      throw Error(`ASSERT FAILED [${phase}/${current.ticket}] ${name}${detail ? `: ${String(detail).slice(0, 900)}` : ""}`);
    }
    entry.ok = true;
    logs[current.ticket].assertions.push(entry);
  };
  /** A ticket section: a failure is recorded and the remaining tickets still run. */
  let settle = async () => undefined;
  const section = async (ticket, label, body) => {
    if (onlyList.length > 0 && !onlyList.includes(ticket)) return false;
    current.ticket = ticket;
    stage = `${ticket}:${label}`;
    try { await settle(); await body(); return true; }
    catch (error) {
      const message = error instanceof Error ? `${error.message}` : String(error);
      logs[ticket].failed.push({ label, message: message.slice(0, 1200) });
      console.error(`T05_T06_T12_SECTION_FAILED ${ticket}:${label}`, error);
      return false;
    }
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
  const { NativeModelsFile, resolveAgentDir } = await import("../dist/main/native-models-config.js");
  const { ProviderWiring } = await import("../dist/main/provider-ipc.js");
  const { HostClient } = await import("../dist/rpc/host-client.js");

  const recordOf = (taskId) => {
    const taskDir = join(taskRoot, taskId);
    const raw = readFileSync(join(taskDir, "task.json"));
    return { taskDir, raw, sha256: sha256(raw), record: readTaskRecordOnDisk(taskDir) };
  };
  const jsonlText = (taskDir) => {
    const base = join(taskDir, ".pidock-sdk-sessions", "main");
    if (!existsSync(base)) return "";
    return readdirSync(base).filter((name) => name.endsWith(".jsonl")).map((name) => readFileSync(join(base, name), "utf8")).join("\n");
  };
  const lockRecords = () => {
    if (!existsSync(lockRoot)) return [];
    return readdirSync(lockRoot).filter((name) => name.endsWith(".lock")).map((name) => {
      const raw = readFileSync(join(lockRoot, name), "utf8");
      let record = null;
      try { record = JSON.parse(raw); } catch { /* named below */ }
      return { file: name, stale: name.includes(".stale-"), bytes: raw.length, record };
    });
  };
  const lockKeys = () => lockRecords().filter((row) => row.stale === false).map((row) => row.record?.key ?? null);
  void lockKeys;
  const envCredentials = () => Object.keys(process.env).filter((name) => /^PIDOCK_PROVIDER_[A-Z0-9_]+$/.test(name));
  const hostStderr = [];
  const ids = { project: "", a: "", b: "", c: "" };
  let source = null;
  let sharedA = "";
  /** Reserved for a second shared directory (T06 retarget leg); kept named, not used yet. */
  const sharedB = ""; void sharedB;
  const ops = [];
  const savedEnvAgent = process.env["PIDOCK_AGENT_DIR"];
  try {
    if (!restart) {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      mkdirSync(profile, { recursive: true });
      mkdirSync(taskRoot, { recursive: true });
      mkdirSync(sourcesRoot, { recursive: true });
      mkdirSync(remotesRoot, { recursive: true });
      mkdirSync(agentDir, { recursive: true, mode: 0o700 });
      for (const dir of Object.values(outputFor)) mkdirSync(dir, { recursive: true });
    } else {
      if (!existsSync(join(profile, "projects.json"))) throw Error(`restart phase: no persisted registry under ${profile}`);
      mkdirSync(chromiumProfile, { recursive: true });
      for (const dir of Object.values(outputFor)) mkdirSync(dir, { recursive: true });
    }
    providerState.server = await startProvider();
    stage = "whenReady";
    await app.whenReady();

    index = new TaskRootIndex(profile, taskRoot);
    projects = new ProjectRegistry(profile);
    providerProfiles = new ProviderProfileStore(profile);
    // The real store + a deterministic test cipher: the ciphertext pipeline, the 0600
    // file and the revision bump are the product's; only the platform cipher is replaced
    // because the capture must never touch the user's real Keychain item.
    secrets = new ProviderSecretStore(profile, createTestSafeStorage());
    const resolvedAgent = resolveAgentDir(process.env, homedir());
    if (resolvedAgent !== agentDir) throw Error(`PIDOCK_AGENT_DIR did not resolve to the temp agent dir: ${resolvedAgent}`);
    nativeModels = new NativeModelsFile(resolvedAgent);

    if (!restart) {
      // ---------------------------------------------------------------- seeded source
      stage = "seed source";
      source = seedRepo("task-repo", "# task-repo\n\nT05/T06/T12 验收：真实 worktree 与真实 origin。\n", "base: task-repo");
      sharedA = join(sourcesRoot, "shared-notes");
      mkdirSync(sharedA, { recursive: true });
      writeFileSync(join(sharedA, "说明.md"), "# 共享目录\n\nT06 验收：两个任务链接同一个真实目录。\n");
      stage = "seed registry";
      const project = await projects.create({
        name: PROJECT_NAME,
        description: PROJECT_DESCRIPTION,
        repositories: [{ name: "task-repo", path: source.dir }],
        directories: [{ name: "shared-notes", path: sharedA }],
        environment: [],
        branchTemplate: BRANCH_TEMPLATE,
      });
      ids.project = project.id;
    } else {
      ids.project = process.env["PIDOCK_T05_PROJECT_ID"] ?? "";
      source = { dir: process.env["PIDOCK_T05_SOURCE_DIR"] ?? "", remote: process.env["PIDOCK_T05_SOURCE_REMOTE"] ?? "", head: "" };
      sharedA = process.env["PIDOCK_T05_SHARED_DIR"] ?? "";
      for (const key of ["a", "b", "c"]) ids[key] = process.env[`PIDOCK_T05_TASK_${key.toUpperCase()}`] ?? "";
      if (!ids.project || !source.dir) throw Error("restart phase: project identity missing");
    }

    stage = "window";
    const workspaceId = restart ? "pencil-v1-t05-t06-t12-restart" : "pencil-v1-t05-t06-t12";
    views = await createTrustedWindow(workspaceId, "production");
    registry = new PerTaskHostRegistry(workspaceId, async (workspace, task) => {
      const entry = join(import.meta.dirname, "..", "dist", "host", "host-entry.js");
      const child = utilityProcess.fork(entry, [], { serviceName: `${workspaceId}-host`, env: buildHostEnv(process.env, workspace, task, app.getPath("userData")), stdio: "pipe" });
      children.push(child);
      childByTask.set(task.taskId, child);
      child.stderr?.on("data", (data) => {
        hostStderr.push(String(data));
        process.stderr.write(`[${workspaceId}-host ${task.taskId}] ${data}`);
      });
      return { child, client: new HostClient(child) };
    }, (id) => index.resolve(id), undefined, index);
    const originalRoute = registry.routeTaskOp.bind(registry);
    registry.routeTaskOp = async (input) => {
      ops.push({ op: input?.op ?? null, taskId: input?.taskId ?? null });
      return originalRoute(input);
    };
    const project = projects.get(ids.project);
    const sourceId = project?.repositories[0]?.id ?? "";
    const directoryId = project?.directories[0]?.id ?? "";
    providers = new ProviderWiring(providerProfiles, async (id, provider, senderWebContentsId) => {
      const payload = provider === null
        ? { provider: null }
        : { provider: { config: providerProfiles.config(provider.profileId, provider.modelId), credential: provider.credential } };
      await registry.routeTaskOp({ workspaceId, taskId: id, op: "task/sdkProvider", payload, origin: { kind: "shell-ui", senderWebContentsId } });
    }, process.env, { secrets, native: nativeModels });
    const creation = new ProjectTaskCreation(new CreationIntentStore(profile), projects, index, registry, taskRoot,
      undefined, new WorktreeMetadataLock(profile, { notify: () => {} }));
    const catalog = new ServiceCatalog(profile, serviceCatalogAuthority(index, projects));
    registerIpc(createUnavailableHostClient(), views.registry, registry, projects, index, undefined, creation, providers, catalog);

    if (!restart) {
      // The REAL main-side creation path — the exact function behind `shell/createTask`.
      // #148 made the branch convention + push remote app-private SETTINGS, so the same real
      // setter the delivery sheet uses is called first (a worktree creation refuses without it).
      stage = "delivery settings";
      creation.saveDeliverySettings({ branchTemplate: BRANCH_TEMPLATE, remote: "origin" });
      stage = "create tasks";
      /** @returns {Promise<{ id: string; taskId: string; taskDir: string }>} */
      const createTask = async (name) => {
        const prepared = /** @type {{ canceled: boolean; intent: { id: string; taskId: string; taskDir: string } }} */ (
          await performCreationOperation(creation, { op: "prepare", input: {
            projectId: ids.project, name,
            repositories: [{ sourceId, remote: "origin", remoteBranch: "main" }],
            directoryIds: [directoryId], sharedWriteConfirmed: true, override: false,
          } }, async () => null, () => undefined));
        if (prepared.canceled) throw Error(`task prepare was canceled (${name})`);
        const intent = /** @type {{ id: string; taskId: string; taskDir: string }} */ (prepared.intent);
        await performCreationOperation(creation, { op: "commit", id: intent.id }, async () => null, () => undefined);
        return intent;
      };
      const a = await createTask(TASK_A);
      const b = await createTask(TASK_B);
      const c = await createTask(TASK_C);
      ids.a = a.taskId; ids.b = b.taskId; ids.c = c.taskId;
      /** @type {[string, { id: string; taskId: string; taskDir: string }][]} */
      const created = [["a", a], ["b", b], ["c", c]];
      for (const [key, intent] of created) {
        const record = recordOf(intent.taskId);
        const worktree = join(intent.taskDir, (record.record?.repoSources ?? [])[0].repoDir);
        worktreeOf[key] = worktree;
        repoDirOf[key] = (record.record?.repoSources ?? [])[0].repoDir;
        const link = (record.record?.dirLinks ?? [])[0];
        if (!link) throw Error(`task ${key} has no plain-directory link`);
        links[key] = link.linkName;
        linkReal[key] = realpathSync(join(intent.taskDir, link.linkName));
      }
      logs.t05.assertions.push({ name: "three tasks were created by performCreationOperation in real worktrees with a real shared-directory link",
        ok: true, detail: JSON.stringify({ tasks: [ids.a, ids.b, ids.c], worktrees: [worktreeOf.a, worktreeOf.b, worktreeOf.c], links: [links.a, links.b, links.c] }) });
    } else {
      for (const key of ["a", "b", "c"]) {
        const record = recordOf(ids[key]);
        const intent = process.env[`PIDOCK_T05_TASKDIR_${key.toUpperCase()}`];
        const taskDir = intent ?? join(taskRoot, ids[key]);
        repoDirOf[key] = (record.record?.repoSources ?? [])[0]?.repoDir ?? "";
        worktreeOf[key] = join(taskDir, repoDirOf[key]);
        const link = (record.record?.dirLinks ?? [])[0];
        links[key] = link?.linkName ?? "";
        linkReal[key] = link ? realpathSync(join(taskDir, link.linkName)) : "";
      }
    }
    await loadTrustedViews(views);
    views.shellView.webContents.debugger.attach();

    const evalJs = async (expression) => {
      const response = await views.shellView.webContents.debugger.sendCommand("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails));
      return response.result.value;
    };
    const text = async () => { try { return await evalJs("document.body.innerText"); } catch { return ""; } };
    const until = async (match, label, attempts = 600) => {
      let last = "";
      for (let i = 0; i < attempts; i++) { last = await text(); if (match(last)) return last; await wait(100); }
      throw Error(`UI timeout [${phase}] (${label}): ${JSON.stringify(last.slice(0, 4000))}`);
    };
    const click = (name) => evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(name)} || el.getAttribute('aria-label') === ${JSON.stringify(name)}); if (!b) throw Error('missing button '+${JSON.stringify(name)}+' :: '+document.body.innerText.replace(/\\n+/g,' | ').slice(0,900)); b.click(); return true; })()`);
    const clickTestId = (id) => evalJs(`(() => { const b = document.querySelector('[data-testid=' + ${JSON.stringify(id)} + ']'); if (!b) throw Error('missing [data-testid=' + ${JSON.stringify(id)} + '] :: ' + document.body.innerText.replace(/\\n+/g,' | ').slice(0,900)); b.click(); return true; })()`);
    const clickLabelled = (needle, scope = "document") => evalJs(`(() => {
      const root = ${scope} ?? document;
      const want = ${JSON.stringify(needle.replace(/\s+/g, ""))};
      const button = [...root.querySelectorAll('button')].find((el) => el.textContent.replace(/\\s+/g, '').includes(want) || el.getAttribute('aria-label') === ${JSON.stringify(needle)});
      if (!button) throw Error('missing button containing ' + ${JSON.stringify(needle)} + ' :: ' + document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 900));
      button.click();
      return true;
    })()`);
    void click;
    const sizeTo = async (width, height) => { views.window.setContentSize(width, height); await wait(120); };
    const settleFocus = () => evalJs("(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); return document.activeElement === document.body; })()");
    const scrollToTop = (selector) => evalJs(`(() => { for (const el of document.querySelectorAll(${JSON.stringify(selector)})) el.scrollTop = 0; const root = document.querySelector('[data-testid=desktop-shell-content]'); if (root) root.scrollTop = 0; document.documentElement.scrollTop = 0; return true; })()`);
    const approvalCardText = () => evalJs("document.querySelector('[data-testid=desktop-approval-card]')?.innerText ?? null");
    const executionCardText = () => evalJs("document.querySelector('[data-testid=desktop-execution-card]')?.innerText ?? null");
    const historyText = () => evalJs("document.querySelector('[aria-label=\"SDK 对话历史\"]')?.innerText ?? ''");
    void historyText;
    const url = await evalJs("location.href");
    if (typeof url !== "string" || !/^file:\/\/.*\/renderer\/index.html$/.test(url)) throw Error(`not the production file:// renderer: ${url}`);

    const capture = async (state, ticket = current.ticket) => {
      const outDir = outputFor[ticket];
      const sizes = [[1440, 900]];
      for (const [width, height] of sizes) {
        stage = `${ticket}:${state} ${width}x${height}`;
        views.window.setContentSize(width, height);
        await evalJs(`(() => {
          const target = document.querySelector('[data-testid=desktop-approval-card]') ?? document.querySelector('[data-testid=desktop-conversation]')
            ?? document.querySelector('[data-testid=desktop-archive-page]');
          for (let node = target; node; node = node.parentElement) node.scrollTop = 0;
          if (${width} <= 1000 && target) target.scrollIntoView({ block: 'start' });
          return true;
        })()`);
        views.shellView.setVisible(true);
        views.window.show();
        app.focus({ steal: true });
        views.window.moveTop();
        views.window.focus();
        await wait(200);
        const bounds = views.window.getContentBounds();
        if (bounds.width !== width || bounds.height !== height) throw Error(`unexpected content bounds ${JSON.stringify(bounds)}`);
        const name = shotFile(bounds.width, bounds.height, state);
        const shot = await views.shellView.webContents.debugger.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        const png = Buffer.from(shot.data, "base64");
        writeFileSync(join(outDir, name), png);
        const pixels = pngPixelSize(png);
        logs[ticket].shots.push({ state, file: name, width: bounds.width, height: bounds.height,
          pixelWidth: pixels.width, pixelHeight: pixels.height, sha256: sha256(png),
          bodyText: flat(await text()).slice(0, 1600) });
        console.log(`T05_T06_T12_CAPTURE ${ticket}=` + JSON.stringify({ state, file: name, sha256: sha256(png) }));
      }
      await sizeTo(1440, 900);
    };

    // ------------------------------------------------------------ main-side Host reads
    const sender = () => views.shellView.webContents.id;
    const route = async (taskId, op, payload = {}) => {
      const result = await registry.routeTaskOp({ workspaceId, taskId, op, payload, origin: { kind: "shell-ui", senderWebContentsId: sender() } });
      return result?.payload ?? {};
    };
    const opError = async (taskId, op, payload = {}) => {
      void op;
      try { await route(taskId, op, payload); return null; } catch (error) { return error instanceof Error ? error.message : String(error); }
    };
    void opError;
    const listApprovals = async (taskId) => (await route(taskId, "task/listApprovals", { sessionId: "main" })).approvals ?? [];
    const executionState = async (taskId) => (await route(taskId, "task/executionState", { sessionId: "main" })).state ?? null;
    const setPermission = async (taskId, permission) => route(taskId, "task/setPermission", { sessionId: "main", permission });
    /**
     * A turn is started from the REAL composer: the renderer owns the request id it
     * sends, which is what makes its conversation adopt the turn and re-read the
     * approval list. A `task/sendMessage` routed from main starts the same Host turn
     * but the page never adopts it — so the UI path is the one used here.
     */
    const typeMessage = async (value) => {
      await evalJs(`(() => { const el = document.querySelector('textarea[aria-label="消息"]'); if (!el) throw Error('missing composer'); el.focus(); el.select(); return true; })()`);
      await views.shellView.webContents.debugger.sendCommand("Input.insertText", { text: value });
      for (let i = 0; i < 60; i++) {
        const state = await evalJs(`(() => { const b = document.querySelector('button[aria-label="发送"]'); const t = document.querySelector('textarea[aria-label="消息"]'); return { disabled: b ? b.disabled : null, value: t ? t.value : null }; })()`);
        if (state.disabled === false && state.value === value) return state;
        await wait(100);
      }
      throw Error(`the composer never became sendable for ${JSON.stringify(value.slice(0, 40))}`);
    };
    /**
     * The turn is started over the SAME main→Host op the renderer's composer sends
     * (`task/sendMessage`, attested as a shell-UI caller), and the renderer is then
     * reloaded so its conversation re-reads the Host projection and the approval list
     * from disk. The reload is what the UI does on a fresh mount; it is not a fixture.
     */
    const sendTurn = async (taskId, prompt) => {
      await gotoTask(taskId);
      await route(taskId, "task/sendMessage", { sessionId: "main", requestId: `req-${randomUUID()}`, text: prompt });
      await wait(400);
      await evalJs("(() => { location.reload(); return true; })()");
      // A reload always lands on the workspace overview (the route is not persisted),
      // so the task page is re-opened exactly like a user would.
      await wait(1200);
      await until((body) => body.includes("任务根") || body.includes("未归属任务"), "shell boot after reload", 300);
      await gotoTask(taskId);
    };
    void typeMessage;
    const untilMain = async (predicate, label, attempts = 400) => {
      for (let i = 0; i < attempts; i++) { const value = await predicate(); if (value) return value; await wait(100); }
      throw Error(`main-side timeout (${label}) [${phase}]`);
    };
    const gotoTask = async (taskId) => {
      for (let attempt = 0; attempt < 400; attempt++) {
        if (await evalJs(`!!document.querySelector('[data-task-nav="${taskId}"]')`)) break;
        if (attempt === 399) throw Error(`no task navigation for ${taskId} [${phase}] :: ${flat(await text()).slice(0, 1200)}`);
        await wait(100);
      }
      await evalJs(`(() => { const b = document.querySelector('[data-task-nav="${taskId}"]'); if (!b) throw Error('missing task nav'); b.click(); return true; })()`);
      await until((body) => /task workspace/i.test(body), "task conversation view");
      await wait(300);
    };
    const gotoArchive = async () => {
      await clickLabelled("已归档");
      await until((body) => body.includes("已归档") && (body.includes("归档于") || body.includes("还没有归档任务")), "archive page");
    };
    // The Host refuses a `task/sendMessage` from anyone but the shell UI; the origin
    // above is main's own attestation for this window, exactly like an IPC call.
    /** Wait until an approval of THIS session is pending, and return it. */
    /**
     * Best-effort settle between ticket sections: a pending confirmation is rejected
     * and a still-open turn is cancelled, so the next state starts from idle. A
     * refusal here is recorded, never hidden.
     */
    settle = async () => {
      for (const taskId of [ids.a, ids.b, ids.c]) {
        if (!taskId || !existsSync(join(taskRoot, taskId))) continue;
        try {
          const rows = await listApprovals(taskId);
          for (const row of rows.filter((entry) => entry.status === "pending")) {
            await route(taskId, "task/reject", { sessionId: "main", approvalId: row.approvalId });
          }
        } catch { /* the Host may be gone (T06 kills one on purpose) */ }
        for (let i = 0; i < 60; i++) {
          try {
            const state = await executionState(taskId);
            if (state?.session?.runState !== "running" && state?.session?.runState !== "approval") break;
            if (i === 30) {
              // Still live after the rejections: cancel the turn explicitly so the next
              // state starts from idle (the same entry the composer's 停止 uses).
              try {
                const projection = await route(taskId, "task/sdkProjection", { sessionId: "main" });
                const turnId = projection?.turn?.turnId ?? projection?.turns?.at(-1)?.turnId;
                if (typeof turnId === "string") await route(taskId, "task/sdkCancel", { sessionId: "main", turnId });
              } catch { /* the Host may be gone */ }
            }
          } catch { break; }
          await wait(100);
        }
      }
    };
    const untilPendingApproval = async (taskId, label) => untilMain(async () => {
      const rows = await listApprovals(taskId);
      return rows.find((row) => row.status === "pending") ?? null;
    }, label);

    // ------------------------------------------------------------- provider install
    // Saved through the production main-side API (the same one `shell/providerSave`
    // calls), so the profile store, the encrypted credential store and Pi's
    // `models.json` really carry it; the UI form is not part of these three tickets.
    let profileId = "";
    if (!restart) {
      stage = "provider save";
      const saved = providers.save({
        name: PROVIDER_NAME,
        notes: "本机回环工具端点 · 无真实线上账号",
        protocol: "openai-completions",
        baseUrl: withPort("/v1"),
        credentials: { kind: "store", revision: 1 },
        models: [{ id: MODEL, name: "Loopback Tools 7B", contextWindow: 131072, maxTokens: 8192, reasoning: false }],
        modelId: MODEL,
      }, API_KEY, false);
      profileId = saved.profile.id;
      for (const taskId of [ids.a, ids.b, ids.c]) await providers.select(taskId, profileId, MODEL, undefined, sender());
      await setPermission(ids.a, "default");
      await setPermission(ids.b, "default");
      await setPermission(ids.c, "default");
      const statusA = providers.status(ids.a);
      logs.t05.assertions.push({ name: "the Provider is installed into each task's isolated context from the temp models.json + encrypted store",
        ok: statusA.state === "configured", detail: JSON.stringify({ state: statusA.state, nativePath: providers.nativePath, agentDir }) });
      logs.t05.assertions.push({ name: "no PIDOCK_PROVIDER_* credential exists in the capture process environment",
        ok: envCredentials().length === 0, detail: JSON.stringify(envCredentials()) });
      if (providers.status(ids.a).state !== "configured") throw Error(`provider not configured: ${JSON.stringify(providers.status(ids.a))}`);
    } else {
      profileId = providerProfiles.list().profiles[0]?.id ?? "";
    }

    stage = "shell boot";
    await until((body) => body.includes(PROJECT_NAME) || body.includes("未归属任务"), "shell boot");
    await sizeTo(1440, 900);

    if (restart) {
      // ------------------------------------------------ restart phase (T05 box 6)
      await section("t05", "restart", async () => {
        const expect = JSON.parse(process.env["PIDOCK_T05_EXPECT"] ?? "null");
        if (!expect) throw Error("restart phase: expectations missing");
        const jsonlBefore = sha256(Buffer.from(jsonlText(join(taskRoot, ids.a))));
        await gotoTask(ids.a);
        await until((body) => body.includes("TOOL-LOOP-approve-DONE") || body.includes("T05-APPROVED-ONCE") || body.includes("工具结果原文"), "restored conversation");
        const approvals = await listApprovals(ids.a);
        check("the restart process reads the same persisted approval records from the task folder",
          JSON.stringify(approvals.map((row) => [row.status, row.tool])) === JSON.stringify(expect.approvals),
          JSON.stringify({ before: expect.approvals, after: approvals.map((row) => [row.status, row.tool]) }));
        check("a pending approval from the dead process is NOT replayed and did not run",
          !existsSync(join(worktreeOf.a, "t05-pending.txt")), JSON.stringify({ pendingFile: join(worktreeOf.a, "t05-pending.txt") }));
        check("no finished tool was re-executed by the restart (the SDK JSONL is byte-identical)",
          sha256(Buffer.from(jsonlText(join(taskRoot, ids.a)))) === expect.jsonlSha256,
          `${expect.jsonlSha256} -> ${sha256(Buffer.from(jsonlText(join(taskRoot, ids.a))))}`);
        void jsonlBefore;
        await scrollToTop('[aria-label="SDK 对话历史"]');
        await settleFocus();
        await capture("t05-conversation-after-restart");
      });
      return;
    }

    // ================================================================= T05: tools + approval
    await section("t05", "approve", async () => {
      await gotoTask(ids.a);
      stage = "t05 send approve";
      await sendTurn(ids.a, PROMPTS.approve);
      const pending = await untilPendingApproval(ids.a, "pending exec.run approval");
      check("the Host really persisted a pending confirmation for the session's exec.run",
        pending.tool === "exec.run" && pending.status === "pending" && pending.taskId === ids.a && pending.sessionId === "main",
        JSON.stringify({ tool: pending.tool, status: pending.status, sessionId: pending.sessionId }));
      check("the confirmation carries the real command as its operation and the real target path",
        String(pending.operation).includes("t05-approved.txt") && typeof pending.target === "string" && pending.target.length > 0,
        JSON.stringify({ operation: pending.operation, target: pending.target, realTarget: pending.realTarget }));
      check("the command did NOT run before the approval", !existsSync(join(worktreeOf.a, "t05-approved.txt")),
        join(worktreeOf.a, "t05-approved.txt"));
      const card = await until((body) => body.includes("待批准：运行命令"), "approval card");
      await scrollToTop('[aria-label="SDK 对话历史"]');
      await settleFocus();
      await capture("t05-approval-pending");
      const cardText = flat(String(await approvalCardText()));
      check("the approval card names the tool, the target, the real command, the session and the one-shot impact",
        cardText.includes("待批准：运行命令") && cardText.includes("目标：") && cardText.includes("操作：") &&
        cardText.includes(`会话 · main`) && cardText.includes("载荷版本 ·") &&
        cardText.includes("批准仅授权这一次操作") && cardText.includes("有效期由 Host 判定"),
        cardText.slice(0, 900));
      check("the card shows the Host-resolved real path of the target",
        cardText.includes("真实路径（解析后）："), cardText.slice(0, 900));
      const execCard = flat(String(await executionCardText()));
      // The host-derived turn execution stays `executing` while the tool call is parked on
      // the confirmation, so the card names 执行中 rather than 等待确认. Recorded, not hidden.
      if (execCard.includes("等待确认")) {
        check("the execution card reports the pending-approval state by name", true, execCard.slice(0, 300));
      } else {
        recordFinding({
          id: "execution-card-does-not-say-waiting",
          title: "工具调用停在确认上时，执行卡仍显示「执行中」而不是「等待确认」",
          expected: "审批卡显示待批准的同时，执行状态卡按 Host 执行账本显示等待确认",
          observed: execCard.slice(0, 400),
          note: "Host 的确认记录（task/listApprovals）确实是 pending；执行账本的回合记录仍是 executing，因为等待确认的派生执行在账本里没有独立状态。只记录，未改产品代码。",
        });
      }
      void card; void pending;
      // ---- approve through the real UI button
      stage = "t05 approve click";
      await clickTestId("desktop-approval-approve");
      const effect = await untilMain(() => existsSync(join(worktreeOf.a, "t05-approved.txt")), "approved command effect on disk");
      void effect;
      check("approving really executed the command ONCE inside the task worktree",
        readFileSync(join(worktreeOf.a, "t05-approved.txt"), "utf8") === "T05-APPROVED-ONCE",
        JSON.stringify({ path: join(worktreeOf.a, "t05-approved.txt"), body: readFileSync(join(worktreeOf.a, "t05-approved.txt"), "utf8") }));
      await until((body) => body.includes("TOOL-LOOP-approve-DONE"), "closing turn after the approved tool");
      const approvedRows = await listApprovals(ids.a);
      check("the confirmation is spent and settled with `executed` after the real execution",
        approvedRows.some((row) => row.status === "approved" && row.executed === true),
        JSON.stringify(approvedRows.map((row) => [row.status, row.executed])));
      check("the SDK JSONL records the tool result the Host returned",
        jsonlText(join(taskRoot, ids.a)).includes("T05-APPROVED-ONCE"),
        JSON.stringify({ bytes: jsonlText(join(taskRoot, ids.a)).length }));
      await scrollToTop('[aria-label="SDK 对话历史"]');
      await settleFocus();
      await capture("t05-approval-approved-effect");
    });

    await section("t05", "deny", async () => {
      stage = "t05 deny";
      await gotoTask(ids.a);
      await sendTurn(ids.a, PROMPTS.deny);
      const pending = await untilPendingApproval(ids.a, "pending deny approval");
      await until((body) => body.includes("待批准：运行命令"), "deny approval card");
      await capture("t05-approval-pending-deny");
      await clickTestId("desktop-approval-deny");
      await until((body) => body.includes("已拒绝"), "deny outcome");
      const rows = await listApprovals(ids.a);
      check("the denied confirmation is a terminal `rejected` record and nothing executed",
        rows.some((row) => row.approvalId === pending.approvalId && row.status === "rejected" && row.executed === false),
        JSON.stringify(rows.map((row) => [row.status, row.executed])));
      await wait(600);
      check("the denied command left no file on disk", !existsSync(join(worktreeOf.a, "t05-denied.txt")),
        join(worktreeOf.a, "t05-denied.txt"));
      await until((body) => body.includes("approval-rejected") || body.includes("未获批准"), "named rejection reaching the model");
      await scrollToTop('[aria-label="SDK 对话历史"]');
      await settleFocus();
      await capture("t05-approval-denied");
    });

    await section("t05", "cancel", async () => {
      stage = "t05 cancel";
      await gotoTask(ids.a);
      await sendTurn(ids.a, PROMPTS.cancel);
      await untilPendingApproval(ids.a, "pending cancel approval");
      await until((body) => body.includes("待批准：运行命令"), "cancel approval card");
      await clickTestId("desktop-approval-approve");
      await until((body) => body.includes("执行中") || body.includes("执行状态 · 执行"), "running command");
      await scrollToTop('[aria-label="SDK 对话历史"]');
      await settleFocus();
      await capture("t05-command-running");
      await clickLabelled("停止");
      await until((body) => body.includes("执行已取消"), "cancelled turn");
      await wait(9000);
      check("stopping the running command really killed it: the file it would have written never appears",
        !existsSync(join(worktreeOf.a, "t05-cancelled.txt")), join(worktreeOf.a, "t05-cancelled.txt"));
      await scrollToTop('[aria-label="SDK 对话历史"]');
      await settleFocus();
      await capture("t05-command-cancelled");
    });

    await section("t05", "read-only refusal", async () => {
      stage = "t05 read-only";
      await gotoTask(ids.a);
      await setPermission(ids.a, "read");
      await sendTurn(ids.a, PROMPTS.readonly);
      await until((body) => body.includes("TOOL-LOOP-readonly-DONE"), "closing turn after the read-only refusal");
      const jsonl = jsonlText(join(taskRoot, ids.a));
      check("a read-tier session is refused the write by the Host, by name",
        jsonl.includes("tool-refused:gate-denied") || jsonl.includes("tool-refused:write-lock"),
        JSON.stringify({ matched: ["tool-refused:gate-denied", "tool-refused:write-lock"].filter((needle) => jsonl.includes(needle)) }));
      check("the refused write left no file on disk", !existsSync(join(worktreeOf.a, "t05-readonly-write.txt")),
        join(worktreeOf.a, "t05-readonly-write.txt"));
      await scrollToTop('[aria-label="SDK 对话历史"]');
      await settleFocus();
      await capture("t05-readonly-refused");
      await setPermission(ids.a, "default");
    });

    await section("t05", "path escape refusal", async () => {
      stage = "t05 escape";
      await gotoTask(ids.a);
      await sendTurn(ids.a, PROMPTS.escape);
      await until((body) => body.includes("TOOL-LOOP-escape-DONE"), "closing turn after the escape refusal");
      const jsonl = jsonlText(join(taskRoot, ids.a));
      check("a path outside the task is refused by name before any read happens",
        jsonl.includes("tool-refused:out-of-scope"), JSON.stringify({ outOfScope: jsonl.includes("tool-refused:out-of-scope") }));
      await scrollToTop('[aria-label="SDK 对话历史"]');
      await settleFocus();
      await capture("t05-path-escape-refused");
    });

    await section("t05", "pending before restart", async () => {
      stage = "t05 pending";
      await gotoTask(ids.a);
      await sendTurn(ids.a, PROMPTS.pending);
      const pending = await untilPendingApproval(ids.a, "pending approval kept for the restart");
      check("a second pending confirmation is left in the task folder for the restart read",
        pending.status === "pending", JSON.stringify({ approvalId: pending.approvalId, tool: pending.tool }));
      await until((body) => body.includes("待批准：运行命令"), "pending card before restart");
      await scrollToTop('[aria-label="SDK 对话历史"]');
      await settleFocus();
      await capture("t05-pending-before-restart");
    });

    // ================================================================= T06: shared directory
    await section("t06", "holder and refusal", async () => {
      await gotoTask(ids.a);
      stage = "t06 hold";
      await sendTurn(ids.a, PROMPTS.holdA);
      const holder = await untilPendingApproval(ids.a, "holder approval on the shared directory");
      const held = await untilMain(() => lockRecords().find((row) => row.record?.key === linkReal.a && row.stale === false), "cross-process lock record for the shared real path");
      check("the pending shared-directory command really holds the app-private lock on the RESOLVED path",
        held.record.taskId === ids.a && held.record.sessionId === "main" && String(held.record.key) === linkReal.a,
        JSON.stringify({ file: held.file, key: held.record.key, taskId: held.record.taskId, pid: held.record.pid }));
      check("the lock record names the holder (task/session/label/pid/host instance), not just a process id",
        typeof held.record.label === "string" && typeof held.record.pid === "number" && typeof held.record.hostInstance === "string",
        JSON.stringify({ label: held.record.label, pid: held.record.pid, hostInstance: held.record.hostInstance }));
      const cardText = await until(async (body) => body.includes("位于共享原目录") ? body : null, "approval card naming the linked original");
      const approvalText = flat(String(await approvalCardText()));
      check("the approval impact states the REAL path and that it is a linked shared original (not a copy)",
        approvalText.includes(linkReal.a) && approvalText.includes("位于共享原目录") &&
        approvalText.includes("不是副本，写入直接改动原文件"), approvalText.slice(0, 900));
      check("the approval card names the shared-real-path exclusion for external editors",
        approvalText.includes("共享真实路径") && approvalText.includes("外部编辑器的写入不受此约束"), approvalText.slice(0, 900));
      void cardText;
      await scrollToTop('[aria-label="SDK 对话历史"]');
      await settleFocus();
      await capture("t06-approval-shared-original");

      stage = "t06 second task refused";
      await gotoTask(ids.b);
      await sendTurn(ids.b, PROMPTS.writeB);
      await until((body) => body.includes("TOOL-LOOP-writeB-DONE"), "second task closing turn");
      const jsonlB = jsonlText(join(taskRoot, ids.b));
      check("the second task's write to the SAME resolved directory is refused by name",
        jsonlB.includes("shared-path-locked") || jsonlB.includes("shared-path-lock"),
        JSON.stringify({ locked: jsonlB.includes("shared-path-locked") }));
      check("the refusal names the ACTUAL holder (the other task), not a generic lock message",
        jsonlB.includes(ids.a), JSON.stringify({ namesHolderTask: jsonlB.includes(ids.a) }));
      check("the refused write did not touch the shared directory on disk",
        !existsSync(join(sharedA, "t06-b.txt")), join(sharedA, "t06-b.txt"));
      await scrollToTop('[aria-label="SDK 对话历史"]');
      await settleFocus();
      await capture("t06-second-task-refused");

      stage = "t06 disjoint";
      await gotoTask(ids.c);
      await sendTurn(ids.c, PROMPTS.privateC);
      await until((body) => body.includes("TOOL-LOOP-privateC-DONE"), "disjoint private write closing turn");
      check("a disjoint (task-private) write proceeds while the shared path is held",
        existsSync(join(worktreeOf.c, "t06-private-c.txt")),
        JSON.stringify({ file: join(worktreeOf.c, "t06-private-c.txt") }));
      await capture("t06-disjoint-private-write");

      stage = "t06 release and retry";
      await route(ids.a, "task/reject", { sessionId: "main", approvalId: holder.approvalId });
      await untilMain(() => lockRecords().filter((row) => row.stale === false).length === 0, "lock release by the holder");
      await gotoTask(ids.b);
      await sendTurn(ids.b, PROMPTS.writeB2);
      await until((body) => body.includes("TOOL-LOOP-writeB2-DONE"), "retry closing turn");
      check("after the holder releases, the retry really writes the original directory on disk",
        existsSync(join(sharedA, "t06-b.txt")) && readFileSync(join(sharedA, "t06-b.txt"), "utf8").includes("释放后重试"),
        JSON.stringify({ exists: existsSync(join(sharedA, "t06-b.txt")) }));
      await scrollToTop('[aria-label="SDK 对话历史"]');
      await settleFocus();
      await capture("t06-second-task-after-release");
    });

    await section("t06", "symlink retarget", async () => {
      stage = "t06 retarget";
      const shared2 = join(sourcesRoot, "shared-notes-2");
      mkdirSync(shared2, { recursive: true });
      writeFileSync(join(shared2, "说明.md"), "# 第二个共享目录\n\nT06 验收：链接改指后按新的真实路径取键。\n");
      const linkPath = join(taskRoot, ids.a, links.a);
      const beforeReal = realpathSync(linkPath);
      unlinkSync(linkPath);
      symlinkSync(shared2, linkPath, "dir");
      check("the in-task link was really re-pointed to a different directory",
        realpathSync(linkPath) === realpathSync(shared2) && beforeReal !== realpathSync(shared2),
        JSON.stringify({ before: beforeReal, after: realpathSync(linkPath) }));
      await gotoTask(ids.a);
      await sendTurn(ids.a, PROMPTS.holdA);
      const holder = await untilPendingApproval(ids.a, "post-retarget holder approval");
      const record = await untilMain(() => lockRecords().find((row) => row.record?.key === realpathSync(shared2)), "lock record on the NEW real path");
      check("every claim re-resolves the link: the new lock key is the NEW real path",
        record.record.key === realpathSync(shared2) && record.record.key !== beforeReal,
        JSON.stringify({ key: record.record.key, newReal: realpathSync(shared2), oldReal: beforeReal }));
      check("the old real path is no longer claimed (the retarget does not widen the old authorisation)",
        lockRecords().every((row) => row.record?.key !== beforeReal), JSON.stringify(lockRecords().map((row) => row.record?.key)));
      await route(ids.a, "task/reject", { sessionId: "main", approvalId: holder.approvalId });
      await sendTurn(ids.a, PROMPTS.writeA2);
      await until((body) => body.includes("TOOL-LOOP-writeA2-DONE"), "post-retarget write closing turn");
      check("the write after the retarget really lands in the NEW directory and not the old one",
        existsSync(join(shared2, "t06-a2.txt")) && !existsSync(join(sharedA, "t06-a2.txt")),
        JSON.stringify({ newDir: existsSync(join(shared2, "t06-a2.txt")), oldDir: existsSync(join(sharedA, "t06-a2.txt")) }));
      await scrollToTop('[aria-label="SDK 对话历史"]');
      await settleFocus();
      await capture("t06-symlink-retarget");
    });

    await section("t06", "stale owner recovery", async () => {
      stage = "t06 stale";
      const shared2 = join(sourcesRoot, "shared-notes-2");
      await gotoTask(ids.a);
      await sendTurn(ids.a, PROMPTS.holdA);
      await untilPendingApproval(ids.a, "stale-owner holder approval");
      const held = await untilMain(() => lockRecords().find((row) => row.stale === false && row.record?.key === realpathSync(shared2)), "held record before the kill");
      const deadPid = held.record.pid;
      // Kill the REAL owner process of that record: the task's utilityProcess Host.
      const child = childByTask.get(ids.a);
      if (!child) throw Error("no Host child for task A");
      check("the recorded owner pid is the real Host process of task A", child.pid === deadPid, JSON.stringify({ childPid: child.pid, recorded: deadPid }));
      process.kill(deadPid, "SIGKILL");
      for (let i = 0; i < 100; i++) { try { process.kill(deadPid, 0); await wait(50); } catch { break; } }
      check("the owner process is really gone (SIGKILL, no cleanup ran)", (() => { try { process.kill(deadPid, 0); return false; } catch { return true; } })(), String(deadPid));
      check("its lock record survives on disk (no silent takeover, no cleanup)", lockRecords().some((row) => row.record?.pid === deadPid),
        JSON.stringify(lockRecords().map((row) => [row.file, row.record?.pid])));
      await gotoTask(ids.b);
      await sendTurn(ids.b, PROMPTS.writeB);
      await until((body) => body.includes("TOOL-LOOP-writeB-DONE"), "takeover write closing turn");
      check("the next write on the dead owner's path really succeeds and lands on disk",
        existsSync(join(sharedA, "t06-b.txt")), join(sharedA, "t06-b.txt"));
      const staleReceipts = lockRecords().filter((row) => row.stale && row.record?.pid === deadPid);
      check("the takeover is announced by name (`lock-owner-dead`) and keeps a durable receipt",
        hostStderr.join("").includes("lock-owner-dead") && staleReceipts.length >= 1,
        JSON.stringify({ announced: hostStderr.join("").includes("lock-owner-dead"), receipts: staleReceipts.map((row) => row.file) }));
      check("the announcement names the evicted task, session, label, host instance, pid and start time",
        new RegExp(`lock-owner-dead: .*任务 ${ids.a} .*会话 main .*进程 ${deadPid} .*开始于`).test(hostStderr.join("")),
        hostStderr.join("").split("\n").filter((line) => line.includes("lock-owner-dead")).join(" ").slice(0, 900));
      await scrollToTop('[aria-label="SDK 对话历史"]');
      await settleFocus();
      await capture("t06-stale-owner-recovered");
    });

    // ================================================================= T12: archive + cleanup
    await section("t12", "archive only keeps the worktree", async () => {
      stage = "t12 dirty";
      await gotoTask(ids.c);
      await sendTurn(ids.c, PROMPTS.t12uncommitted);
      await until((body) => body.includes("TOOL-LOOP-t12uncommitted-DONE"), "dirty write closing turn");
      check("the task worktree really carries an uncommitted change",
        git(worktreeOf.c, ["status", "--porcelain"]).includes("t12-uncommitted.txt"),
        git(worktreeOf.c, ["status", "--porcelain"]));
      stage = "t12 archive only";
      await clickLabelled("任务操作");
      await clickLabelled("归档当前任务");
      await until((body) => body.includes("归档当前任务") && body.includes("确认归档"), "archive dialog");
      await capture("t12-archive-dialog");
      await clickLabelled("确认归档");
      await until((body) => /已归档|归档状态/.test(body), "archive result");
      check("archive-only keeps the managed worktree on disk", existsSync(worktreeOf.c), worktreeOf.c);
      check("the source repository still lists the task worktree after archive-only",
        worktreeRealPaths(source.dir).includes(realpathSync(worktreeOf.c)), JSON.stringify(worktreeRealPaths(source.dir)));
      await gotoArchive();
      await until((body) => body.includes("归档于"), "archive page row");
      await capture("t12-archived-archive-only");
    });

    await section("t12", "cleanup blocked on uncommitted and unknown delivery", async () => {
      stage = "t12 cleanup preview";
      await gotoArchive();
      await evalJs(`(() => { const article = document.querySelector('[data-archived-task="${ids.c}"]'); if (!article) throw Error('missing archived row'); const b = [...article.querySelectorAll('button')].find((el) => el.textContent.includes('清理')); if (!b) throw Error('missing 清理 button'); b.click(); return true; })()`);
      await until((body) => body.includes("先预览 Host 清理清单"), "cleanup preview panel");
      await clickLabelled("生成清单");
      const preview = await until((body) => body.includes("逐仓库检查（真实 Git 状态）"), "cleanup preview rows");
      await settleFocus();
      await capture("t12-cleanup-blocked-uncommitted");
      check("the per-repo row names the real uncommitted change and the unknown delivery",
        flat(preview).includes("有未提交修改") && flat(preview).includes("交付状态未知：不当作已交付"),
        flat(preview).slice(0, 1200));
      check("cleanup refuses to claim the default row is cleanable",
        flat(preview).includes("需先选择保留或导出") || flat(preview).includes("保留工作副本"),
        flat(preview).slice(0, 1200));
      await evalJs("(() => { window.confirm = () => true; return true; })()");
      await clickLabelled("确认清理");
      await until((body) => /清理未完成|清理部分失败|清理已执行|Host 未上报清理回执|未提交/.test(body), "cleanup run result");
      await capture("t12-cleanup-refused");
      check("a blocked cleanup did NOT remove the worktree", existsSync(worktreeOf.c), worktreeOf.c);
      check("the uncommitted file is still on disk", existsSync(join(worktreeOf.c, "t12-uncommitted.txt")), worktreeOf.c);
    });

    await section("t12", "explicit clean removes only the managed worktree", async () => {
      stage = "t12 commit and push";
      const branch = git(worktreeOf.c, ["rev-parse", "--abbrev-ref", "HEAD"]);
      git(worktreeOf.c, ["add", "-A"]);
      execFileSync("git", ["commit", "-m", "T12 验收：提交工作副本修改"], { cwd: worktreeOf.c, encoding: "utf8",
        env: { ...process.env, GIT_AUTHOR_DATE: SEED_COMMIT_DATE, GIT_COMMITTER_DATE: SEED_COMMIT_DATE }, stdio: ["ignore", "pipe", "pipe"] });
      git(worktreeOf.c, ["push", "origin", `HEAD:refs/heads/${branch}`]);
      check("the worktree is now really clean and provably delivered (its HEAD is on the remote)",
        git(worktreeOf.c, ["status", "--porcelain"]) === "" &&
        git(worktreeOf.c, ["rev-list", "--count", "HEAD", "--not", "--remotes"]) === "0",
        JSON.stringify({ status: git(worktreeOf.c, ["status", "--porcelain"]), ahead: git(worktreeOf.c, ["rev-list", "--count", "HEAD", "--not", "--remotes"]) }));
      const sourceHeadBefore = git(source.dir, ["rev-parse", "HEAD"]);
      const remoteRefsBefore = git(source.remote, ["for-each-ref", "--format=%(refname) %(objectname)"]);
      stage = "t12 clean";
      await gotoArchive();
      await clickLabelled("刷新");
      await until((body) => body.includes("归档于"), "archive page after refresh");
      await evalJs(`(() => { const article = document.querySelector('[data-archived-task="${ids.c}"]'); if (!article) throw Error('missing archived row'); const b = [...article.querySelectorAll('button')].find((el) => el.textContent.includes('清理')); if (!b) throw Error('missing 清理 button'); b.click(); return true; })()`);
      await until((body) => body.includes("先预览 Host 清理清单"), "cleanup panel after commit");
      await clickLabelled("生成清单");
      const deliverable = await until((body) => body.includes("逐仓库检查（真实 Git 状态）"), "cleanup preview after commit");
      check("after the commit+push the row is provably clean and delivered",
        flat(deliverable).includes("无未提交修改") && flat(deliverable).includes("已交付"), flat(deliverable).slice(0, 1200));
      await settleFocus();
      await capture("t12-cleanup-cleanable");
      await evalJs("(() => { window.confirm = () => true; return true; })()");
      await clickLabelled("确认清理");
      await until((body) => /清理已执行|清理部分失败|清理未完成|实际移除/.test(body), "cleanup receipt");
      const after = flat(await text());
      await capture("t12-cleanup-receipt");
      check("the managed worktree of the task is really gone from disk", !existsSync(worktreeOf.c), worktreeOf.c);
      check("the source checkout is intact (same HEAD, its own files still there)",
        git(source.dir, ["rev-parse", "HEAD"]) === sourceHeadBefore && existsSync(join(source.dir, "README.md")),
        JSON.stringify({ head: sourceHeadBefore, after: git(source.dir, ["rev-parse", "HEAD"]) }));
      check("the bare origin was not rewritten by the cleanup",
        git(source.remote, ["for-each-ref", "--format=%(refname) %(objectname)"]) === remoteRefsBefore,
        git(source.remote, ["for-each-ref", "--format=%(refname)"]));
      check("the receipt names what was actually removed (or a named keep)",
        /实际移除/.test(after), after.slice(0, 1200));
      stage = "t12 restore after cleanup";
      await clickLabelled("恢复");
      await until((body) => /该任务已清理|工作区未就绪|工作区/.test(body), "restore after cleanup");
      await settleFocus();
      await capture("t12-restore-after-cleanup");
      const restored = flat(await text());
      recordFindingIf(restored, current.ticket);
    });
    function recordFindingIf(body, ticket) {
      void ticket;
      if (!body.includes("该任务已清理")) {
        recordFinding({
          id: "restore-after-cleanup-not-named",
          title: "清理后恢复页没有说出「该任务已清理：工作副本已按记录移除」",
          expected: "恢复后的工作区显示「该任务已清理」并把每个仓库标为 missing",
          observed: body.slice(0, 600),
        });
      }
    }

    // ================================================================= finalize + restart
    stage = "restart process";
    const approvalsBefore = (await listApprovals(ids.a)).map((row) => [row.status, row.tool]);
    const expect = {
      taskId: ids.a,
      approvals: approvalsBefore,
      jsonlSha256: sha256(Buffer.from(jsonlText(join(taskRoot, ids.a)))),
      worktree: worktreeOf.a,
    };
    await section("t05", "restart launch", async () => {
      const restartOut = await new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, [scriptPath, "--phase", "restart", "--out-base", isAbsolute(outBase) ? outBase : outBase], {
          env: { ...process.env,
            PIDOCK_T05_PROJECT_ID: ids.project,
            PIDOCK_T05_SOURCE_DIR: source.dir,
            PIDOCK_T05_SOURCE_REMOTE: source.remote,
            PIDOCK_T05_SHARED_DIR: sharedA,
            PIDOCK_T05_TASK_A: ids.a, PIDOCK_T05_TASK_B: ids.b, PIDOCK_T05_TASK_C: ids.c,
            PIDOCK_T05_TASKDIR_A: join(taskRoot, ids.a), PIDOCK_T05_TASKDIR_B: join(taskRoot, ids.b), PIDOCK_T05_TASKDIR_C: join(taskRoot, ids.c),
            PIDOCK_T05_EXPECT: JSON.stringify(expect) },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = ""; let stderr = "";
        child.stdout.on("data", (data) => { stdout += data; process.stdout.write(`[restart] ${data}`); });
        child.stderr.on("data", (data) => { stderr += data; process.stderr.write(`[restart] ${data}`); });
        child.on("error", reject);
        child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
      });
      check("the restart phase (a second Electron OS process) exited 0", restartOut.code === 0,
        JSON.stringify({ code: restartOut.code, stderr: restartOut.stderr.slice(-2000) }));
    });
  } catch (error) {
    console.error(`T05_T06_T12_CAPTURE_FAILED [${phase}]`, stage, error);
    logs[current.ticket].failed.push({ label: stage, message: String(error?.stack ?? error).slice(0, 2000) });
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    try { if (savedEnvAgent === undefined) delete process.env["PIDOCK_AGENT_DIR"]; else process.env["PIDOCK_AGENT_DIR"] = savedEnvAgent; } catch { /* best effort */ }
    const cleanupFailures = await shutdownTestRegistry(registry, {
      origin: views ? { kind: "shell-ui", senderWebContentsId: views.shellView.webContents.id } : undefined,
      label: `PencilV1 T05/T06/T12 capture cleanup (${phase})`,
    });
    for (const child of children) { try { child.kill(); } catch { /* already dead */ } }
    if (views?.shellView.webContents.debugger.isAttached()) views.shellView.webContents.debugger.detach();
    views?.window.destroy();
    providerState.server?.close();
    // The logs are written even after a failure, so partial evidence is still auditable.
    if (phase === "primary") {
      for (const ticket of ["t05", "t06", "t12"]) {
        // A limited run must not clobber a fuller log: an existing document with more
        // evidence is kept, and a ticket this run did not exercise is left untouched.
        const existing = existsSync(join(outputFor[ticket], "capture-log.json"))
          ? JSON.parse(readFileSync(join(outputFor[ticket], "capture-log.json"), "utf8")) : null;
        if (onlyList.length > 0 && !onlyList.includes(ticket)) continue;
        if ((logs[ticket].shots.length === 0 && logs[ticket].assertions.length <= 1) && existing && (existing.shots ?? []).length > 0) continue;
        const log = {
          ticket: { t05: "#140 会话工具与审批（T05）", t06: "#141 跨任务共享真实路径写互斥（T06）", t12: "#147 任务归档与清理（T12）" }[ticket],
          command, repoRoot, phase, pid: process.pid,
          runtime: { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome, platform: process.platform, arch: process.arch },
          realVsTest: {
            real: ["built React renderer over file://", "production main wiring (createTrustedWindow/registerIpc/PerTaskHostRegistry/ProviderWiring)",
              "real utilityProcess task Host + isolated SDK worker context", "real SDK tool loop driven by loopback `tool_calls` SSE frames",
              "real SdkAgentToolBroker (permission gate, write right, shared-path lock, approval re-check)",
              "real filesystem / processes / Git repositories / bare origin", "second Electron OS process for the restart"],
            replaced: ["OS keychain cipher → deterministic AES-256-GCM test cipher (createTestSafeStorage)",
              "real online provider → loopback OpenAI-compatible HTTP/SSE server on 127.0.0.1",
              "real ~/.pi/agent → temp PIDOCK_AGENT_DIR"],
            notExercised: ["real online provider account", "Windows", "real OS Keychain encryption"],
          },
          seed: {
            project: { id: ids.project, name: PROJECT_NAME, repository: "task-repo (real git, real bare origin)", directory: "shared-notes (real shared directory)" },
            tasks: { a: ids.a, b: ids.b, c: ids.c },
            worktrees: { a: worktreeOf.a, b: worktreeOf.b, c: worktreeOf.c },
            links: { a: links.a, b: links.b, c: links.c },
            createdBy: "performCreationOperation (the function behind shell/createTask)",
          },
          loopback: { port: providerState.port, chatRequests: chatRequests().length,
            prompts: chatRequests().map((row) => ({ marker: markerOf(row.body) })) },
          lockDirectory: { path: lockRoot, records: lockRecords().map((row) => ({ file: row.file, key: row.record?.key ?? null, taskId: row.record?.taskId ?? null, pid: row.record?.pid ?? null })) },
          assertions: logs[ticket].assertions,
          findings: logs[ticket].findings,
          failedSections: logs[ticket].failed,
          shots: logs[ticket].shots,
        };
        mkdirSync(outputFor[ticket], { recursive: true });
        writeFileSync(join(outputFor[ticket], "capture-log.json"), `${JSON.stringify(log, null, 2)}\n`);
        console.log(`T05_T06_T12_LOG ${ticket}=` + JSON.stringify({ shots: logs[ticket].shots.length, assertions: logs[ticket].assertions.length, failed: logs[ticket].failed.length }));
      }
    }
    if (cleanupFailures.length) { console.error(`T05_T06_T12_CAPTURE_CLEANUP_FAILED [${phase}] ` + JSON.stringify(cleanupFailures)); process.exitCode = process.exitCode ?? 1; }
    exitNow(process.exitCode ?? 0, "done");
  }
}
void run();
