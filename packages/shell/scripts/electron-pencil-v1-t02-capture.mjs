// [PiDock pencil-v1 / T02] (#137) real-Electron evidence for 从已有目录创建任务并展示工作区事实:
// the S02 create-task modal (all three workspace modes), two real UI-driven task
// creations (已有 Git 目录 / 独立 Worktree), the S08 task facts surface, per-source
// reopen states (healthy · 来源缺失 · 身份不符) and a second-OS-process restart proof.
//
// Run after `pnpm --filter @pidock/shell build`:
//   pnpm --filter @pidock/shell exec electron scripts/electron-pencil-v1-t02-capture.mjs \
//     --out docs/evidence/pencil-v1-t02
//
// It reuses the #136 harness (`electron-pencil-v1-t01-capture.mjs`) unchanged in its
// boot path: the compiled production runtime modules are imported directly (not
// `dist/main/main.js`) with the production wiring decisions — `createTrustedWindow(...,
// "production")`, `registerIpc` over a real `TaskRootIndex`/`ProjectRegistry`/
// `PerTaskHostRegistry`/`ProjectTaskCreation`/`ProviderWiring`/`ServiceCatalog` — and the
// built React renderer (`dist/renderer/index.html`, no fixture entry, no dev-server
// override). Every task on screen is created by the product's own renderer → main →
// Host path; NOTHING in the UI path is a seeded task record.
//
// Seeded through real APIs only: `ProjectRegistry.create` writes projects.json under the
// isolated userData, and the sources are real temp Git repositories (each with its own
// bare `origin` under the OS temp dir) plus one real plain directory. The 已有 Git 目录
// checkout deliberately carries an uncommitted dirty file and a known HEAD before the
// task is created.
//
// Ticketed states captured at 1440x900 and 720x560:
//   (a) S02 独立 Worktree（默认）preview: per-repo task branch, worktree target path,
//       pinned base commit and the shared plain-directory row — after a REAL prepare
//   (b) S02 已有 Git 目录 form + preview: the repo row drops the baseline-branch input,
//       the preview claims no worktree and no task branch
//   (c) S02 仅普通目录: repository rows disabled/unselectable, plain dirs only
//   (d) task facts after the REAL 独立 Worktree creation (2 repos + 1 plain dir)
//   (e) task facts after the REAL 已有 Git 目录 creation (1 dirty shared checkout)
//   (f) healthy reopen, then the same task reopened after its source checkout was
//       deleted (`来源缺失`) and after its plain directory was replaced (`身份不符`),
//       with task.json read before/after to prove the record is never rewritten
//   (g) the pre-restart reference for the worktree facts view
//
// Restart proof: after the primary phase the script spawns a SECOND Electron OS process
// (`--phase restart`) that boots the same production wiring over the SAME on-disk
// registry/task-root files with fresh instances, re-reads both `task.json` files byte for
// byte and re-renders both tasks' facts (mode badge + per-source rows + verification
// pills), then the primary phase compares the before/after screenshots per pixel.
//
// Hang discipline: the deadline timer and the uncaught-error handlers are armed before the
// compiled `dist` graph is imported (dynamically, inside the guarded region).
import { app, utilityProcess } from "electron";
import { createUnavailableHostClient } from "./unavailable-host-client.mjs";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { shutdownTestRegistry } from "./shutdown-test-registry.mjs";

// The dev-server override is inadmissible evidence: clear it before boot so this
// capture can only ever load the packaged `file://` renderer.
delete process.env["PIDOCK_RENDERER_URL"];
delete process.env["PIDOCK_TASK_URL"];
if (process.env["PIDOCK_RENDERER_URL"]) throw Error("PIDOCK_RENDERER_URL survived the clear");

const scriptPath = resolve(import.meta.dirname, "electron-pencil-v1-t02-capture.mjs");
const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const argValue = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const phase = argValue("--phase") ?? "primary";
const outArg = argValue("--out") ?? "docs/evidence/pencil-v1-t02";
const output = isAbsolute(outArg) ? outArg : resolve(repoRoot, outArg);
const command = "pnpm --filter @pidock/shell exec electron scripts/electron-pencil-v1-t02-capture.mjs --out docs/evidence/pencil-v1-t02";
// A fixed (not random) temp root keeps the captured source paths stable, so a re-run at
// the same revision renders byte-identical PNGs. Isolated under the OS temp dir.
const root = join(tmpdir(), "pidock-pencil-v1-t02-capture");
// The registry/task-root files every phase reads. The restart phase points Chromium at
// its own userData (`profile-restart`) so the OS-level Chromium profile singleton does
// not collide, while the main-owned stores are re-instantiated over THIS directory.
const profile = join(root, "profile");
const taskRoot = join(root, "tasks");
const sourcesRoot = join(root, "sources");
const remotesRoot = join(root, "remotes");
const chromiumProfile = phase === "restart" ? join(root, "profile-restart") : profile;
app.setPath("userData", chromiumProfile);
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
  let differingPixels = 0; let maxChannelDelta = 0; const differingRows = [];
  for (let y = 0; y < a.height; y++) {
    const start = y * stride; const end = start + stride;
    if (a.data.compare(b.data, start, end, start, end) === 0) continue;
    differingRows.push(y);
    for (let x = 0; x < a.width; x++) {
      let delta = 0;
      for (let channel = 0; channel < a.channels; channel++) {
        delta = Math.max(delta, Math.abs(a.data[start + x * a.channels + channel] - b.data[start + x * a.channels + channel]));
      }
      if (delta > 0) { differingPixels += 1; maxChannelDelta = Math.max(maxChannelDelta, delta); }
    }
  }
  return { width: a.width, height: a.height, totalPixels: a.width * a.height, differingPixels, maxChannelDelta,
    differingRows: differingRows.slice(0, 8), differingRowCount: differingRows.length };
};
const children = [];
let views, registry, index, projects, catalog;

// Arm the deadline and the failure handlers BEFORE any heavyweight work.
let exiting = false;
const exitNow = (code, why) => {
  if (exiting) return;
  exiting = true;
  console.error(`T02_CAPTURE_EXIT ${phase}`, code, why);
  try { app.exit(code); } catch { process.exit(code); }
};
const watchdog = setTimeout(() => exitNow(1, "watchdog timeout"), 520000);
process.on("uncaughtException", (error) => exitNow(1, `uncaughtException ${error?.stack ?? error}`));
process.on("unhandledRejection", (error) => {
  const stack = /** @type {{ stack?: string } | null | undefined} */ (error)?.stack;
  exitNow(1, `unhandledRejection ${stack ?? error}`);
});
// Test-only guard: a noop listener suppresses Electron's default quit on
// window-all-closed, which would race the explicit app.exit(process.exitCode).
app.on("window-all-closed", () => {});

const PROJECT_NAME = "T02 验收工作区";
const PROJECT_DESCRIPTION = "从已有目录创建任务并展示工作区事实（#137 验收）";
const WORKTREE_TASK = "独立工作树验收任务";
const SHARED_TASK = "共享检出验收任务";
const BRANCH_TEMPLATE = "feature/{task-name}";
const DEMO_LEAK = /Atlas Web|演示任务|演示统计|演示数据|项目映射未建立|真实任务创建尚未接入|示例工作空间/;
const shotFile = (width, height, state) => `${width}x${height}-${state}.png`;
const flat = (value) => String(value).replace(/\s+/g, " ").trim();
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const git = (cwd, args) => execFileSync("git", args, {
  cwd, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
  stdio: ["ignore", "pipe", "pipe"],
}).trim();
/** Every Git fact this capture compares across a mutation, without writing anything. */
const repoFacts = (dir) => ({
  head: git(dir, ["rev-parse", "HEAD"]),
  branch: git(dir, ["symbolic-ref", "--short", "HEAD"]),
  commitCount: Number(git(dir, ["rev-list", "--count", "HEAD"])),
  status: git(dir, ["status", "--porcelain"]),
  localRefs: git(dir, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]),
  remoteRefs: git(dir, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes"]),
  worktreeList: git(dir, ["worktree", "list", "--porcelain"]),
});

const SEED_COMMIT_DATE = "2026-11-03T10:00:00+0000";
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
  // Fixed author/committer dates keep the seeded commit ids stable across re-runs, so
  // the only run-to-run difference left is the product's own random task id.
  execFileSync("git", ["commit", "-m", message], { cwd: dir, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: SEED_COMMIT_DATE, GIT_COMMITTER_DATE: SEED_COMMIT_DATE },
    stdio: ["ignore", "pipe", "pipe"] });
  git(dir, ["push", "-u", "origin", "main"]);
  return { dir, remote, head: git(dir, ["rev-parse", "HEAD"]) };
}
/** Local branches/refs of the bare remote, so a pinned commit can be checked against it. */
const remoteHead = (remote) => git(remote, ["rev-parse", "main"]);

async function run() {
  const restart = phase === "restart";
  let stage = "startup";
  const shots = [];
  const assertions = [];
  const check = (name, condition, detail = "") => {
    if (!condition) throw Error(`ASSERT FAILED [${phase}] ${name}${detail ? `: ${detail}` : ""}`);
    assertions.push({ name, detail: String(detail).slice(0, 500) });
  };
  // Dynamic imports: the compiled dist graph is pulled in only after the watchdog is armed.
  const { readTaskRecordOnDisk } = await import("../dist/host/task-store.js");
  const { buildHostEnv } = await import("../dist/host/host-guards.js");
  const { TaskRootIndex } = await import("../dist/main/task-root-index.js");
  const { ProjectRegistry } = await import("../dist/main/project-registry.js");
  const { ServiceCatalog, serviceCatalogAuthority } = await import("../dist/main/service-catalog.js");
  const { createTrustedWindow, loadTrustedViews, PerTaskHostRegistry, registerIpc } = await import("../dist/main/runtime.js");
  const { CreationIntentStore, ProjectTaskCreation } = await import("../dist/main/project-task-creation.js");
  const { ProviderProfileStore } = await import("../dist/main/provider-profile-store.js");
  const { ProviderWiring } = await import("../dist/main/provider-ipc.js");
  const { HostClient } = await import("../dist/rpc/host-client.js");

  /** The persisted task record of one task, read straight off the disk the Host wrote. */
  const recordOf = (taskId) => {
    const taskDir = join(taskRoot, taskId);
    const raw = readFileSync(join(taskDir, "task.json"));
    return { taskDir, raw, sha256: sha256(raw), record: readTaskRecordOnDisk(taskDir) };
  };
  /** Task ids in creation order, read from the real task-root inventory. */
  const inventoryTaskIds = () => index.inventory().tasks.map((row) => row.taskId);

  let projectId = "";
  let project = null;
  let frontend, gateway, shared, docsDir;
  let sharedHeadBefore = "";
  let sharedFactsBefore = null;
  let sharedRepoBefore = null;
  let frontendFactsBefore = null;
  let gatewayFactsBefore = null;
  let expectA = null;
  let expectB = null;
  try {
    if (!restart) {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      mkdirSync(profile, { recursive: true });
      mkdirSync(taskRoot, { recursive: true });
      mkdirSync(sourcesRoot, { recursive: true });
      mkdirSync(remotesRoot, { recursive: true });
      mkdirSync(output, { recursive: true });
    } else {
      if (!existsSync(join(profile, "projects.json"))) throw Error(`restart phase: no persisted registry under ${profile}`);
      mkdirSync(chromiumProfile, { recursive: true });
    }
    stage = "whenReady";
    await app.whenReady();

    index = new TaskRootIndex(profile, taskRoot);
    projects = new ProjectRegistry(profile);

    if (!restart) {
      // ---------------------------------------------------------------- seeded sources
      // Real Git repositories with real bare remotes: the worktree mode fetches from them
      // and the existing-Git mode pins the checkout's own HEAD. No fixture, no stub.
      stage = "seed sources";
      frontend = seedRepo("frontend-app", "# frontend-app\n\nT02 验收：前端客户端仓库。\n", "base: frontend");
      gateway = seedRepo("gateway-api", "# gateway-api\n\nT02 验收：后端网关仓库。\n", "base: gateway");
      shared = seedRepo("legacy-service", "# legacy-service\n\nT02 验收：已有 Git 目录（共享原检出）仓库。\n", "base: legacy");
      docsDir = join(sourcesRoot, "docs");
      mkdirSync(docsDir, { recursive: true });
      writeFileSync(join(docsDir, "规范.md"), "# 规范\n\nT02 普通目录验收。\n");
      // The shared checkout carries uncommitted work BEFORE the task is created: a
      // modified tracked file plus an untracked file. The capture proves the task
      // creation neither commits, stashes, resets nor fetches them away.
      writeFileSync(join(shared.dir, "README.md"), "# legacy-service\n\nT02 验收：已有 Git 目录（共享原检出）仓库。\n\n本地未提交修改。\n");
      writeFileSync(join(shared.dir, "WIP-note.md"), "未提交的本地工作\n");
      sharedHeadBefore = git(shared.dir, ["rev-parse", "HEAD"]);
      sharedFactsBefore = repoFacts(shared.dir);
      sharedRepoBefore = { head: shared.head, remoteHead: remoteHead(shared.remote) };
      frontendFactsBefore = repoFacts(frontend.dir);
      gatewayFactsBefore = repoFacts(gateway.dir);
      check("the seeded frontend checkout is clean at its base commit", frontendFactsBefore.status === "", frontendFactsBefore.status);
      check("the seeded gateway checkout is clean at its base commit", gatewayFactsBefore.status === "", gatewayFactsBefore.status);
      check("the seeded shared checkout really has uncommitted work",
        sharedFactsBefore.status.includes("README.md") && sharedFactsBefore.status.includes("WIP-note.md"), sharedFactsBefore.status);
      check("the seeded shared checkout's HEAD is the commit its bare origin advertises",
        sharedRepoBefore.head === sharedRepoBefore.remoteHead && sharedHeadBefore === sharedRepoBefore.head,
        JSON.stringify(sharedRepoBefore));
      check("the seeded shared checkout really has a single checkout and no task branch",
        sharedFactsBefore.worktreeList.split("\n").filter((line) => line.startsWith("worktree ")).length === 1 &&
        sharedFactsBefore.localRefs === "refs/heads/main " + sharedHeadBefore, sharedFactsBefore.localRefs);

      stage = "seed registry";
      project = await projects.create({
        name: PROJECT_NAME,
        description: PROJECT_DESCRIPTION,
        repositories: [
          { name: "frontend-app", path: frontend.dir },
          { name: "gateway-api", path: gateway.dir },
          { name: "legacy-service", path: shared.dir },
        ],
        directories: [{ name: "docs", path: docsDir }],
        environment: [
          { key: "NODE_ENV", value: "development" },
          { key: "T02_EVIDENCE", value: "1" },
        ],
        branchTemplate: BRANCH_TEMPLATE,
      });
      projectId = project.id;
      check("the registry really stores the three repository sources and one directory",
        project.repositories.length === 3 && project.directories.length === 1,
        JSON.stringify({ repositories: project.repositories.map((row) => row.name), directories: project.directories.map((row) => row.name) }));
      check("no task exists before the UI creates one", inventoryTaskIds().length === 0, JSON.stringify(inventoryTaskIds()));
    } else {
      projectId = process.env["PIDOCK_T02_PROJECT_ID"] ?? "";
      if (!projectId) throw Error("restart phase: PIDOCK_T02_PROJECT_ID missing");
      expectA = JSON.parse(process.env["PIDOCK_T02_EXPECT_A"] ?? "null");
      expectB = JSON.parse(process.env["PIDOCK_T02_EXPECT_B"] ?? "null");
      if (!expectA || !expectB) throw Error("restart phase: expected task identities missing");
      stage = "restart identity";
      check("the restart process reads the same workspace id from projects.json", projects.get(projectId)?.id === projectId, projectId);
      check("the restart process reads the same workspace sources",
        JSON.stringify((projects.get(projectId)?.repositories ?? []).map((row) => row.name)) === JSON.stringify(expectA.projectRepositories),
        JSON.stringify((projects.get(projectId)?.repositories ?? []).map((row) => row.name)));
    }

    stage = "window";
    views = await createTrustedWindow(restart ? "pencil-v1-t02-restart" : "pencil-v1-t02", "production");
    const workspaceId = restart ? "pencil-v1-t02-restart" : "pencil-v1-t02";
    registry = new PerTaskHostRegistry(workspaceId, async (workspace, task) => {
      const entry = join(import.meta.dirname, "..", "dist", "host", "host-entry.js");
      const child = utilityProcess.fork(entry, [], { serviceName: `${workspaceId}-host`, env: buildHostEnv(process.env, workspace, task, app.getPath("userData")), stdio: "pipe" });
      children.push(child);
      child.stderr?.on("data", (data) => process.stderr.write(`[${workspaceId}-host] ${data}`));
      return { child, client: new HostClient(child) };
    }, (id) => index.resolve(id), undefined, index);
    // Same wiring decisions as the production entry: main owns the real creation-intent
    // store, Provider wiring and service catalog, and hands them to `registerIpc`.
    const providerProfiles = new ProviderProfileStore(profile);
    const creation = new ProjectTaskCreation(new CreationIntentStore(profile), projects, index, registry, taskRoot);
    const providers = new ProviderWiring(providerProfiles, async (taskId, provider, senderWebContentsId) => {
      const payload = provider === null
        ? { provider: null }
        : { provider: { config: providerProfiles.config(provider.profileId), credential: provider.credential } };
      await registry.routeTaskOp({ workspaceId, taskId, op: "task/sdkProvider", payload, origin: { kind: "shell-ui", senderWebContentsId } });
    });
    catalog = new ServiceCatalog(profile, serviceCatalogAuthority(index, projects));
    registerIpc(createUnavailableHostClient(), views.registry, registry, projects, index, undefined, creation, providers, catalog);
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
      for (let i = 0; i < 400; i++) { last = await text(); if (match(last)) return last; await wait(100); }
      throw Error(`UI timeout [${phase}] (${label}): ${JSON.stringify(last.slice(0, 4000))}`);
    };
    const click = (name) => evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(name)} || el.getAttribute('aria-label') === ${JSON.stringify(name)}); if (!b) throw Error('missing button '+${JSON.stringify(name)}+' :: '+document.body.innerText.replace(/\\n+/g,' | ').slice(0,600)); b.click(); return true; })()`);
    // A dialog button label carries a trailing `⌘↵` hint, so an exact-text click misses.
    // Whitespace is stripped on both sides; the search can be scoped to the open dialog so
    // a same-labelled button on the page behind cannot be hit by accident.
    const clickLabelled = (needle, inDialog = false) => evalJs(`(() => {
      const root = ${inDialog ? "document.querySelector('[role=dialog]')" : "document"} ?? document;
      const want = ${JSON.stringify(needle.replace(/\s+/g, ""))};
      const button = [...root.querySelectorAll('button')].find((el) => el.textContent.replace(/\\s+/g, '').includes(want));
      if (!button) throw Error('missing button containing ' + ${JSON.stringify(needle)} + ' :: ' + document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 600));
      button.click();
      return true;
    })()`);
    const dialogOpen = () => evalJs("!!document.querySelector('[role=dialog]')");
    const dialogText = () => evalJs("document.querySelector('[role=dialog]')?.innerText ?? ''");
    const dialogTitle = () => evalJs("document.querySelector('[role=dialog] h2')?.textContent.trim() ?? null");
    // Typing: React keeps its own value tracker, so assigning `el.value` alone would be
    // ignored by the controlled input. The prototype setter + a bubbling `input` event is
    // what a real keystroke produces; the returned `el.value` is compared by the caller so
    // a silently dropped keystroke fails the capture instead of writing something else.
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
    const inputCount = (label) => evalJs(`document.querySelectorAll('input[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']').length`);
    /** Tick the source checkbox of one repository or plain directory, by its visible name. */
    const checkSource = async (name) => {
      const checked = await evalJs(`(() => {
        const input = [...document.querySelectorAll('[role=dialog] input[type=checkbox]')]
          .find((el) => (el.closest('label')?.textContent ?? '').trim().startsWith(${JSON.stringify(name)}));
        if (!input) throw Error('missing source checkbox ' + ${JSON.stringify(name)} + ' :: ' + document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 600));
        input.click();
        return { checked: input.checked, disabled: input.disabled };
      })()`);
      if (!checked.checked) throw Error(`source checkbox for "${name}" did not check (disabled=${checked.disabled})`);
      return checked;
    };
    /** Read one source row's checkbox state without clicking it. */
    const sourceCheckbox = (name) => evalJs(`(() => {
      const input = [...document.querySelectorAll('[role=dialog] input[type=checkbox]')]
        .find((el) => (el.closest('label')?.textContent ?? '').trim().startsWith(${JSON.stringify(name)}));
      if (!input) throw Error('missing source checkbox ' + ${JSON.stringify(name)});
      const before = input.checked;
      input.click();
      return { before, after: input.checked, disabled: input.disabled };
    })()`);
    const sharedWriteConfirmed = () => evalJs(`(() => {
      const input = [...document.querySelectorAll('[role=dialog] input[type=checkbox]')]
        .find((el) => (el.closest('label')?.textContent ?? '').includes('我确认普通目录'));
      if (!input) throw Error('missing shared-write confirmation');
      input.click();
      return input.checked;
    })()`);
    /** Click one of the three real workspace-mode radios and report the resulting state. */
    const setMode = async (value) => {
      const state = await evalJs(`(() => {
        const radio = document.querySelector('[role=dialog] input[type=radio][value=' + JSON.stringify(${JSON.stringify(value)}) + ']');
        if (!radio) throw Error('missing mode radio ' + ${JSON.stringify(value)});
        radio.click();
        return { checked: radio.checked, disabled: radio.disabled };
      })()`);
      await wait(120);
      if (!state.checked) throw Error(`mode radio ${value} did not select (disabled=${state.disabled})`);
      return state;
    };
    const modeState = () => evalJs("[...document.querySelectorAll('[role=dialog] input[type=radio]')].map((el) => ({ value: el.value, checked: el.checked, disabled: el.disabled }))");
    const previewPrimaryLabel = () => evalJs(`(() => {
      const root = document.querySelector('[role=dialog]');
      const button = root ? [...root.querySelectorAll('button[type=submit],button[aria-label]')].find((el) => el.textContent.includes('⌘↵')) : null;
      return button ? button.textContent.replace(/\\s*⌘↵\\s*$/, '').trim() : null;
    })()`);
    const sourceCards = () => evalJs("[...document.querySelectorAll('[data-source-id]')].map((el) => el.textContent.replace(/\\s+/g, ' ').trim())");
    // The source list is a 220px scroll box; scroll it to the end so the selected row's own
    // fields (remote name, observed-branch hint) are inside the captured viewport.
    const scrollSourceList = async () => {
      const state = await evalJs(`(() => {
        const list = document.querySelector('[role=dialog] .overflow-y-auto');
        if (!list) return null;
        list.scrollTop = list.scrollHeight;
        return { scrollTop: list.scrollTop, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight };
      })()`);
      await wait(120);
      return state;
    };
    const navLabels = () => evalJs("[...document.querySelectorAll('[data-nav-group=workspaces] button[aria-label]')].map((el) => el.getAttribute('aria-label')).filter((label) => label !== '新建工作空间' && label !== '已归档')");
    const sizeTo = async (width, height) => { views.window.setContentSize(width, height); await wait(120); };
    // Focus is restored to the dialog opener on close, and a lingering `:focus` border would
    // differ between the pre- and post-restart runs of the SAME view. Blur before the two
    // captures that are compared byte-for-byte, on both sides.
    const settleFocus = () => evalJs("(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); return document.activeElement === document.body; })()");
    const factsBody = () => evalJs("document.querySelector('[data-testid=desktop-task-facts]')?.innerText ?? ''");
    const factsMode = () => evalJs("document.querySelector('[data-testid=task-facts-mode]')?.textContent.trim() ?? null");
    /** Poll until the facts surface has really read the Host (the badge only exists then). */
    const untilFactsLoaded = async () => {
      for (let i = 0; i < 300; i++) { if ((await factsMode()) !== null) return; await wait(100); }
      throw Error(`facts surface never loaded [${phase}]: ${flat(await factsBody()).slice(0, 600)}`);
    };
    const factPills = () => evalJs(`[...document.querySelectorAll('li[data-testid^=task-fact-]')].map((el) => {
      const spans = [...el.querySelectorAll('span')];
      const pill = spans[spans.length - 1];
      return { id: el.getAttribute('data-testid'), pill: pill ? pill.textContent.trim() : null, title: pill ? pill.getAttribute('title') : null };
    })`);

    // Fail closed: the loaded entry must be the packaged React renderer over file://.
    const url = await evalJs("location.href");
    if (typeof url !== "string" || !/^file:\/\/.*\/renderer\/index\.html$/.test(url)) throw Error(`not the production file:// renderer: ${url}`);

    const metrics = async () => evalJs(`(() => {
      const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; };
      const line = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim().slice(0, 120) : null);
      const main = document.querySelector('[data-testid=desktop-shell-content]');
      const dialog = document.querySelector('[role=dialog]');
      const facts = document.querySelector('[data-testid=desktop-task-facts]');
      const factsList = document.querySelector('[aria-label=任务来源事实]');
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        sidebar: box(document.querySelector('[data-testid=desktop-sidebar]')),
        header: box(document.querySelector('[data-testid=desktop-breadcrumb]')),
        content: box(main),
        contentScroll: main ? { scrollWidth: main.scrollWidth, clientWidth: main.clientWidth, scrollHeight: main.scrollHeight, clientHeight: main.clientHeight } : null,
        documentOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        modal: dialog ? { ...box(dialog), padding: getComputedStyle(dialog).padding, radius: getComputedStyle(dialog).borderRadius,
          title: line(dialog.querySelector('h2')), labels: [...dialog.querySelectorAll('label')].map(line).slice(0, 12),
          buttons: [...dialog.querySelectorAll('button')].map(line), primary: box(dialog.querySelector('button[type=submit]')) } : null,
        modeRadios: [...document.querySelectorAll('[role=dialog] input[type=radio]')].map((el) => ({ value: el.value, checked: el.checked, disabled: el.disabled, box: box(el.closest('label')) })),
        repoRowBoxes: [...document.querySelectorAll('[role=dialog] input[type=checkbox]')].map((el) => ({ label: (el.closest('label')?.textContent ?? '').trim().slice(0, 40), disabled: el.disabled, checked: el.checked, box: box(el.closest('label')) })),
        facts: facts ? { ...box(facts), padding: getComputedStyle(facts).padding,
          modeBadge: box(document.querySelector('[data-testid=task-facts-mode]')),
          modeText: line(document.querySelector('[data-testid=task-facts-mode]')),
          list: box(factsList),
          rows: [...document.querySelectorAll('li[data-testid^=task-fact-]')].map((el) => ({ id: el.getAttribute('data-testid'), ...box(el),
            badge: line(el.querySelector('span.rounded-\\\\[3px\\\\]')), pill: line([...el.querySelectorAll('span')].slice(-1)[0]) })) } : null,
        conversation: box(document.querySelector('[data-testid=desktop-conversation]')),
      };
    })()`);

    const capture = async (state, width, height) => {
      stage = `${state} ${width}x${height}`;
      views.window.setContentSize(width, height);
      views.shellView.setVisible(true);
      views.window.show();
      // Test-only activation: an occluded/backgrounded window can reject capturePage with
      // UnknownVizError, so bring this window frontmost before the stabilization wait.
      app.focus({ steal: true });
      views.window.moveTop();
      views.window.focus();
      await wait(250);
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
        bodyText: (await text()).replace(/\n+/g, " | ").slice(0, 1800) };
      shots.push(record);
      return record;
    };

    // Shared navigation: the workspace overview is the entry to every task row.
    const enterWorkspace = async () => {
      await sizeTo(1440, 900);
      await click(PROJECT_NAME);
      await until((body) => body.includes("工作空间复用来源") && body.includes(PROJECT_NAME), "workspace overview");
    };
    const enterTask = async (name) => {
      await enterWorkspace();
      // The ledger row only exists once main's per-task lifecycle read completed, so the
      // row is polled for instead of clicking into a still-未核验 ledger.
      for (let attempt = 0; attempt < 200; attempt++) {
        const present = await evalJs(`!!([...document.querySelectorAll('[data-testid=desktop-project-overview] li')]
          .find((li) => li.textContent.includes(${JSON.stringify(name)})))`);
        if (present) break;
        if (attempt === 199) throw Error(`no task ledger row for ${name} [${phase}] :: ` + (await text()).replace(/\n+/g, " | ").slice(-1600));
        await wait(150);
      }
      await evalJs(`(() => {
        const row = [...document.querySelectorAll('[data-testid=desktop-project-overview] li')].find((li) => li.textContent.includes(${JSON.stringify(name)}));
        if (!row) throw Error('missing task row ' + ${JSON.stringify(name)} + ' :: ' + document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 900));
        const button = [...row.querySelectorAll('button')].find((el) => el.textContent.trim() === '进入任务');
        if (!button) throw Error('missing 进入任务 for ' + ${JSON.stringify(name)});
        button.click();
        return true;
      })()`);
      await until((body) => body.includes("任务工作区访问来源") && body.includes(name), `task facts of ${name}`);
      await untilFactsLoaded();
    };

    // ------------------------------------------- restart phase: post-restart evidence
    // This branch runs in a NEW Electron OS process over the same on-disk registry/task-root
    // files (fresh ProjectRegistry/TaskRootIndex instances). It re-reads both task records
    // byte for byte and re-renders both tasks' facts — mode badge, per-source rows, observed
    // branch/HEAD and the per-source verification pills — with no fixture and no rewrite.
    if (restart) {
      const records = { worktree: recordOf(expectA.taskId), shared: recordOf(expectB.taskId) };
      const workspace = projects.get(projectId);
      check("the restart process reads the same workspace id", workspace?.id === projectId, projectId);
      check("the restart process reads the same workspace sources",
        JSON.stringify((workspace?.repositories ?? []).map((row) => row.name)) === JSON.stringify(expectA.projectRepositories),
        JSON.stringify((workspace?.repositories ?? []).map((row) => row.name)));
      check("the restart process reads the worktree task record byte for byte", records.worktree.sha256 === expectA.recordSha256,
        `${expectA.recordSha256} -> ${records.worktree.sha256}`);
      check("the restart process reads the existing-git task record byte for byte", records.shared.sha256 === expectB.recordSha256,
        `${expectB.recordSha256} -> ${records.shared.sha256}`);
      check("the worktree record still declares worktree mode with two repos and one shared directory",
        records.worktree.record?.workspaceMode === "worktree" && records.worktree.record?.repos.length === 2 &&
        (records.worktree.record?.repoSources ?? []).length === 2 && (records.worktree.record?.dirLinks ?? []).length === 1 &&
        (records.worktree.record?.sharedRepos ?? []).length === 0,
        JSON.stringify({ mode: records.worktree.record?.workspaceMode, repos: records.worktree.record?.repos }));
      check("the existing-git record still declares existing-git mode with the same shared checkout",
        records.shared.record?.workspaceMode === "existing-git" && (records.shared.record?.repos ?? []).length === 0 &&
        (records.shared.record?.sharedRepos ?? []).length === 1 &&
        records.shared.record?.sharedRepos?.[0]?.sourcePath === expectB.sourcePath &&
        records.shared.record?.sharedRepos?.[0]?.headCommit === expectB.headCommit &&
        records.shared.record?.sharedRepos?.[0]?.remoteBranch === expectB.remoteBranch,
        JSON.stringify(records.shared.record?.sharedRepos));

      await until((body) => body.includes(PROJECT_NAME) || body.includes("未归属任务"), "shell boot in the restart process");
      await enterTask(expectA.name);
      await settleFocus();
      await capture("task-facts-worktree-after-restart", 1440, 900);
      await capture("task-facts-worktree-after-restart", 720, 560);
      const worktreeText = flat(await factsBody());
      const worktreePills = await factPills();
      check("post-restart facts keep the 独立 Worktree mode badge", (await factsMode()) === "独立 Worktree", String(await factsMode()));
      check("post-restart facts keep the same three sources", worktreePills.length === 3, JSON.stringify(worktreePills));
      check("post-restart facts keep the two worktrees 已核验 and the replaced directory 身份不符",
        worktreePills.filter((row) => String(row.pill).startsWith("已核验")).length === 2 &&
        worktreePills.filter((row) => String(row.pill).startsWith("身份不符")).length === 1, JSON.stringify(worktreePills));
      for (const repo of expectA.repos) {
        check(`post-restart facts name the worktree target path of ${repo.name}`,
          worktreeText.includes(`目标检出路径: ${expectA.taskDir}/${repo.repoDir}`), worktreeText.slice(0, 900));
        check(`post-restart facts name the branch and pinned baseline of ${repo.name}`,
          worktreeText.includes(`分支 ${expectA.branch}（实测）`) && worktreeText.includes(`基线 main @ ${repo.baseCommit}`));
      }
      check("post-restart facts name the shared plain directory and its real path",
        worktreeText.includes("普通目录 · 共享原文件") && worktreeText.includes(`本地真实路径: ${expectA.plainDir.sourcePath}`),
        worktreeText.slice(0, 900));
      if (DEMO_LEAK.test(worktreeText)) throw Error(`demo/fixture string leaked into the restarted worktree facts: ${worktreeText.match(DEMO_LEAK)?.[0]}`);

      await enterTask(expectB.name);
      await settleFocus();
      await capture("task-facts-existing-git-missing-after-restart", 1440, 900);
      await capture("task-facts-existing-git-missing-after-restart", 720, 560);
      const sharedText = flat(await factsBody());
      const sharedPills = await factPills();
      check("post-restart facts keep the 已有 Git 目录 · 共享原检出 mode badge",
        (await factsMode()) === "已有 Git 目录 · 共享原检出", String(await factsMode()));
      check("post-restart facts keep the deleted source named 来源缺失",
        sharedPills.length === 1 && String(sharedPills[0].pill).startsWith("来源缺失") &&
        String(sharedPills[0].title).includes(expectB.sourcePath), JSON.stringify(sharedPills));
      check("post-restart facts keep the named repair path for the missing source",
        sharedText.includes("修复路径：在「项目管理」中修复该来源后重新打开任务；记录未被改写，不认领其他目录"), sharedText.slice(0, 900));
      check("post-restart facts still name the recorded (now missing) source path",
        sharedText.includes(expectB.sourcePath), sharedText.slice(0, 900));
      if (DEMO_LEAK.test(sharedText)) throw Error(`demo/fixture string leaked into the restarted shared facts: ${sharedText.match(DEMO_LEAK)?.[0]}`);
      let revision = "unknown";
      try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: repoRoot }).trim(); } catch { /* recorded as unknown */ }
      const log = {
        phase: "restart",
        pid: process.pid,
        command: `${command} --phase restart`,
        revision,
        workspace: { id: workspace?.id, name: workspace?.name, repositories: (workspace?.repositories ?? []).map((row) => row.name),
          directories: (workspace?.directories ?? []).map((row) => row.name) },
        records: { worktree: { taskId: records.worktree.record?.taskId, sha256: records.worktree.sha256, workspaceMode: records.worktree.record?.workspaceMode },
          shared: { taskId: records.shared.record?.taskId, sha256: records.shared.sha256, workspaceMode: records.shared.record?.workspaceMode } },
        pageText: { worktree: worktreeText.slice(0, 4000), shared: sharedText.slice(0, 4000) },
        assertions,
        shots,
      };
      writeFileSync(join(output, "restart-log.json"), `${JSON.stringify(log, null, 2)}\n`);
      console.log("T02_RESTART_CAPTURE=" + JSON.stringify({ pid: process.pid, shots: shots.map((shot) => shot.file),
        records: log.records, assertions: assertions.length }));
      return;
    }

    // ------------------------------------------------------- workspace overview (read)
    stage = "workspace overview";
    await until((body) => body.includes(PROJECT_NAME) || body.includes("未归属任务"), "shell boot");
    await sizeTo(1440, 900);
    await click(PROJECT_NAME);
    const overviewBody = await until((body) => body.includes(PROJECT_NAME) && body.includes("工作空间复用来源（Git 仓库与普通目录）") &&
      body.includes("frontend-app（Git 仓库）"), "workspace overview");
    if (DEMO_LEAK.test(overviewBody)) throw Error(`demo/fixture string leaked into the overview: ${overviewBody.match(DEMO_LEAK)?.[0]}`);
    check("the overview names the seeded workspace", overviewBody.includes(PROJECT_NAME));
    check("the sidebar lists the seeded workspace", (await navLabels()).includes(PROJECT_NAME), JSON.stringify(await navLabels()));
    check("the overview lists the three real Git sources and the plain directory",
      overviewBody.includes("frontend-app（Git 仓库）") && overviewBody.includes("gateway-api（Git 仓库）") &&
      overviewBody.includes("legacy-service（Git 仓库）") && overviewBody.includes("docs（普通目录）"));
    check("the overview draws every seeded source as readable", (await sourceCards()).length === 4 &&
      (await sourceCards()).every((card) => card.includes("路径可用")), JSON.stringify(await sourceCards()));

    // ------------------------------------------------------------- S02: 独立 Worktree
    stage = "S02 worktree form";
    await click("项目管理");
    await until((body) => body.includes("工作空间与任务") && body.includes("返回工作空间总览"), "manage page");
    await click("任务");
    const worktreeForm = await until((body) => body.includes("新建任务 (New Task)") && body.includes("任务工作区模式 *") &&
      body.includes("关联工作区仓库与目录 *"), "S02 create-task dialog");
    for (const expected of ["新建任务 (New Task)", "所属工作区 *", "任务目标 / 名称 *", "任务工作区模式 *",
      "关联工作区仓库与目录 *", "运行环境变量（继承自工作区）", "推送到远程仓库时自动创建分支", "取消"]) {
      check(`S02 dialog shows "${expected}"`, worktreeForm.includes(expected));
    }
    check("S02 is a named modal", (await evalJs("document.querySelector('[role=dialog]')?.getAttribute('aria-label') ?? null")) === "新建任务");
    const defaultModes = await modeState();
    check("S02 opens on 独立 Worktree（默认）", JSON.stringify(defaultModes.map((row) => [row.value, row.checked])) ===
      JSON.stringify([["worktree", true], ["existing-git", false], ["plain-dirs", false]]), JSON.stringify(defaultModes));
    check("S02 shows all three workspace modes as the real control",
      defaultModes.every((row) => row.disabled === false), JSON.stringify(defaultModes));
    check("S02 names the worktree hint under the mode control",
      worktreeForm.includes("为每个选中仓库创建独立 Worktree 与任务分支；原仓库保持不动，不覆盖未提交修改。"));
    // Drive the real controls: two repos and the plain directory.
    await checkSource("frontend-app");
    await checkSource("gateway-api");
    await typeAt("远程名称", "origin", 0);
    await typeAt("远程分支", "main", 0);
    await typeAt("远程名称", "origin", 1);
    await typeAt("远程分支", "main", 1);
    await checkSource("docs");
    check("the shared-write confirmation appears once a plain directory is selected", (await sharedWriteConfirmed()) === true);
    await typeAt("任务名称", WORKTREE_TASK);
    const worktreeDraft = await dialogText();
    check("the worktree draft counts 2 repositories and 1 directory",
      flat(worktreeDraft).includes("已选 2 个仓库 · 1 个目录"), flat(worktreeDraft).slice(0, 600));
    check("the worktree draft states the automatic isolated worktree for 2 repos",
      worktreeDraft.includes("⚡ 自动创建隔离 Worktree：2 个仓库，原仓库保持安全隔离"));
    check("the worktree draft primary button really prepares a baseline preview", (await previewPrimaryLabel()) === "固定基线并预览路径", String(await previewPrimaryLabel()));
    stage = "S02 worktree prepare";
    await clickLabelled("固定基线并预览路径", true);
    const worktreePreview = await until((body) => body.includes("任务路径预览 · " + WORKTREE_TASK) &&
      body.includes("任务工作区模式：独立 Worktree（默认）"), "worktree intent preview");
    check("the worktree preview replaces the form header with the prepared task name",
      (await dialogTitle()) === `任务路径预览 · ${WORKTREE_TASK}`, String(await dialogTitle()));
    check("the worktree preview is the real resumable intent state, not the form",
      flat(worktreePreview).includes("创建中断后会保留固定任务身份与提交") && flat(worktreePreview).includes("放弃并重新创建"),
      flat(worktreePreview).slice(0, 600));
    const intentA = creation.current();
    if (!intentA || intentA.workspaceMode !== "worktree") throw Error(`main holds no worktree intent: ${JSON.stringify(intentA)}`);
    const previewA = flat(await dialogText());
    check("the worktree preview states the real prepared task folder", previewA.includes(intentA.taskDir), intentA.taskDir);
    check("the worktree preview names the task branch main prepared", previewA.includes(`任务分支：${intentA.branch}`), intentA.branch);
    for (const repo of intentA.repos) {
      check(`the worktree preview names ${repo.name} with remote/branch/pinned commit and target path`,
        previewA.includes(`${repo.name} · ${repo.remote}/${repo.remoteBranch} · ${repo.commit} → ${intentA.taskDir}/${repo.repoDir}`),
        previewA.slice(0, 900));
      check(`the worktree preview claims an isolated worktree for ${repo.name}`,
        previewA.includes(`${intentA.taskDir}/${repo.repoDir}`) && previewA.includes("⚡ 自动创建隔离 Worktree"));
    }
    for (const dir of intentA.directories) {
      check(`the worktree preview names the plain directory ${dir.name} as shared and writable`,
        previewA.includes(`${dir.name} · ${dir.path} → ${intentA.taskDir}/${dir.linkName}（共享可写）`), previewA.slice(0, 900));
    }
    check("the pinned commits are the real heads advertised by the bare remotes",
      intentA.repos.every((repo) => repo.commit === remoteHead(repo.path === frontend.dir ? frontend.remote : gateway.remote)),
      JSON.stringify(intentA.repos.map((repo) => repo.commit)));
    check("the preview is read-only: no worktree or task branch exists before 确认创建",
      git(frontend.dir, ["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree ")).length === 1 &&
      git(frontend.dir, ["branch", "--list", "task/*"]) === "" &&
      git(gateway.dir, ["branch", "--list", "task/*"]) === "");
    await capture("s02-worktree-preview", 1440, 900);
    await capture("s02-worktree-preview", 720, 560);
    await sizeTo(1440, 900);

    stage = "worktree commit";
    await clickLabelled("确认创建 / 恢复", true);
    const worktreeFactsBody = await until((body) => !body.includes("任务路径预览") && body.includes("任务工作区访问来源") &&
      body.includes(WORKTREE_TASK) && body.includes("独立 Worktree"), "facts after the worktree creation");
    check("the S02 dialog closed after the real creation", (await dialogOpen()) === false);
    check("the app landed on the task facts surface", (await evalJs("!!document.querySelector('[data-testid=desktop-task-facts]')")) === true);
    check("the app landed with the conversation entry below the facts", (await evalJs("!!document.querySelector('[data-testid=desktop-conversation]')")) === true);
    const worktreeTaskId = intentA.taskId;
    check("the created task is really in the task-root inventory", inventoryTaskIds().includes(worktreeTaskId), JSON.stringify(inventoryTaskIds()));
    check("the facts surface shows the 独立 Worktree mode badge", (await factsMode()) === "独立 Worktree", String(await factsMode()));
    check("the facts surface names the task", worktreeFactsBody.includes(WORKTREE_TASK));
    if (DEMO_LEAK.test(worktreeFactsBody)) throw Error(`demo/fixture string leaked into the worktree facts: ${worktreeFactsBody.match(DEMO_LEAK)?.[0]}`);

    const recordA = recordOf(worktreeTaskId);
    check("the real creation wrote a worktree-mode task record",
      recordA.record?.workspaceMode === "worktree" && recordA.record?.repos.length === 2 && recordA.record?.sharedRepos === undefined,
      JSON.stringify({ mode: recordA.record?.workspaceMode, repos: recordA.record?.repos, shared: recordA.record?.sharedRepos }));
    check("the record pins one real baseline per repository",
      (recordA.record?.repoSources ?? []).length === 2 &&
      intentA.repos.every((repo) => (recordA.record?.repoSources ?? []).some((entry) =>
        entry.repoDir === repo.repoDir && entry.remote === "origin" && entry.remoteBranch === "main" && entry.baseCommit === repo.commit)),
      JSON.stringify(recordA.record?.repoSources));
    check("the record stores the source checkout identity of each worktree",
      (recordA.record?.repoSources ?? []).every((entry) => entry.sourcePath !== undefined && entry.sourceRealPath !== undefined &&
        entry.commonDir !== undefined && entry.remoteDigest !== undefined && entry.targetDevice !== undefined && entry.targetInode !== undefined),
      JSON.stringify(recordA.record?.repoSources));
    const plainLink = join(recordA.record.taskDir, intentA.directories[0].linkName);
    check("the plain directory is linked into the task as a real symlink to the registered path",
      lstatSync(plainLink).isSymbolicLink() && realpathSync(plainLink) === realpathSync(docsDir),
      `${plainLink} -> ${readlinkSync(plainLink)}`);
    check("the record holds the plain-directory link at its real target",
      (recordA.record?.dirLinks ?? []).length === 1 && recordA.record?.dirLinks?.[0]?.sourcePath === docsDir,
      JSON.stringify(recordA.record?.dirLinks));
    for (const repo of intentA.repos) {
      const target = join(recordA.record.taskDir, repo.repoDir);
      check(`the worktree for ${repo.name} exists on disk`, existsSync(target), target);
      check(`the worktree for ${repo.name} is really on the task branch`,
        git(target, ["symbolic-ref", "--short", "HEAD"]) === intentA.branch, git(target, ["symbolic-ref", "--short", "HEAD"]));
      check(`the worktree for ${repo.name} is registered in the source repository`,
        git(repo.path, ["worktree", "list", "--porcelain"]).includes(target), git(repo.path, ["worktree", "list", "--porcelain"]));
      check(`the facts name the worktree target path of ${repo.name}`,
        worktreeFactsBody.includes(`目标检出路径: ${target}`), flat(worktreeFactsBody).slice(0, 900));
      check(`the facts name the observed working branch and pinned baseline of ${repo.name}`,
        worktreeFactsBody.includes(`分支 ${intentA.branch}（实测）`) && worktreeFactsBody.includes(`基线 main @ ${repo.commit}`));
    }
    const factsFlatA = flat(worktreeFactsBody);
    check("the facts surface draws one row per selected Git repository with the worktree badge",
      factsFlatA.split("独立 Git worktree (隔离副本)").length - 1 === 2, factsFlatA.slice(0, 900));
    check("the facts surface draws the plain directory as a shared original, not a copy",
      factsFlatA.includes("普通目录 · 共享原文件") && factsFlatA.includes(`本地真实路径: ${docsDir}`) &&
      factsFlatA.includes("非隔离副本，共享原文件"), factsFlatA.slice(0, 900));
    const pillsA = await factPills();
    check("every source of the worktree task verifies as 已核验", pillsA.length === 3 &&
      pillsA.every((row) => String(row.pill).startsWith("已核验")), JSON.stringify(pillsA));
    check("the source repositories gained no commit during the worktree creation",
      JSON.stringify(repoFacts(frontend.dir).head) === JSON.stringify(frontendFactsBefore.head) &&
      repoFacts(frontend.dir).commitCount === frontendFactsBefore.commitCount &&
      repoFacts(frontend.dir).branch === frontendFactsBefore.branch &&
      repoFacts(gateway.dir).head === gatewayFactsBefore.head &&
      repoFacts(gateway.dir).commitCount === gatewayFactsBefore.commitCount &&
      repoFacts(gateway.dir).branch === gatewayFactsBefore.branch);
    check("the worktree creation left both source working trees untouched",
      repoFacts(frontend.dir).status === "" && repoFacts(gateway.dir).status === "");
    await capture("task-facts-worktree-after-create", 1440, 900);
    await capture("task-facts-worktree-after-create", 720, 560);
    await sizeTo(1440, 900);

    // ------------------------------------------------------------ S02: 已有 Git 目录
    stage = "S02 existing-git form";
    await click(PROJECT_NAME);
    await until((body) => body.includes("工作空间复用来源") && body.includes(PROJECT_NAME), "back to the overview");
    await click("项目管理");
    await until((body) => body.includes("返回工作空间总览"), "manage page again");
    await click("任务");
    await until((body) => body.includes("新建任务 (New Task)") && body.includes("任务工作区模式 *"), "S02 dialog for 已有 Git 目录");
    check("the reopened S02 dialog starts empty again", (await inputValueAt("任务名称")) === "", String(await inputValueAt("任务名称")));
    check("the reopened S02 dialog starts on 独立 Worktree（默认）",
      JSON.stringify((await modeState()).map((row) => [row.value, row.checked])) === JSON.stringify([["worktree", true], ["existing-git", false], ["plain-dirs", false]]));
    await setMode("existing-git");
    await checkSource("legacy-service");
    const existingDraft = await dialogText();
    check("选择 已有 Git 目录 really swaps the repo row to the observed-branch form",
      existingDraft.includes("使用该目录当前检出的分支（由 Host 读取）") && (await inputCount("远程分支")) === 0,
      JSON.stringify({ branchInputs: await inputCount("远程分支"), body: flat(existingDraft).slice(0, 600) }));
    check("the existing-git row keeps only the remote name as an input", (await inputCount("远程名称")) === 1);
    check("the existing-git draft claims no worktree and no task branch",
      existingDraft.includes("直接使用已登记的原检出（共享原文件）；不创建 Worktree、不创建任务分支") &&
      !existingDraft.includes("⚡ 自动创建隔离 Worktree"), flat(existingDraft).slice(0, 800));
    check("the existing-git draft does not ask for a baseline commit", !existingDraft.includes("基线"));
    await typeAt("远程名称", "origin", 0);
    await typeAt("任务名称", SHARED_TASK);
    check("the existing-git primary button really reads the original checkout",
      (await previewPrimaryLabel()) === "读取原检出并预览", String(await previewPrimaryLabel()));
    const scrolled = await scrollSourceList();
    check("the source list really scrolled to show the selected row's own fields",
      scrolled !== null && scrolled.scrollTop > 0, JSON.stringify(scrolled));
    check("the selected 已有 Git 目录 row keeps the observed-branch hint visible",
      (await dialogText()).includes("使用该目录当前检出的分支（由 Host 读取）"));
    await capture("s02-existing-git-form", 1440, 900);
    await capture("s02-existing-git-form", 720, 560);
    await sizeTo(1440, 900);

    stage = "S02 existing-git prepare";
    await clickLabelled("读取原检出并预览", true);
    await until((body) => body.includes("任务路径预览 · " + SHARED_TASK) && body.includes("任务工作区模式：已有 Git 目录"), "existing-git preview");
    const intentB = creation.current();
    if (!intentB || intentB.workspaceMode !== "existing-git") throw Error(`main holds no existing-git intent: ${JSON.stringify(intentB)}`);
    const sharedRealPath = realpathSync(shared.dir);
    const previewB = flat(await dialogText());
    check("the existing-git preview states the mode without a worktree claim",
      previewB.includes("任务工作区模式：已有 Git 目录") && !previewB.includes("自动创建隔离 Worktree"), previewB.slice(0, 900));
    check("the existing-git preview names no task branch at all",
      previewB.includes("任务分支：不创建（直接使用原检出的当前分支）"), previewB.slice(0, 900));
    check("the existing-git preview carries the registered source checkout path, branch and HEAD",
      previewB.includes(`legacy-service · 原检出 ${shared.dir} · 当前分支 main · HEAD ${sharedHeadBefore}`) &&
      previewB.includes("（共享原文件，不创建 Worktree 或任务分支）"), previewB.slice(0, 900));
    check("main recorded the checkout's own branch and HEAD, not a remote baseline",
      intentB.repos.length === 1 && intentB.repos[0].remoteBranch === "main" && intentB.repos[0].commit === sharedHeadBefore &&
      intentB.repos[0].realPath === sharedRealPath, JSON.stringify(intentB.repos));
    check("the prepare was read-only: no FETCH_HEAD, no task branch, no worktree",
      !existsSync(join(shared.dir, ".git", "FETCH_HEAD")) &&
      git(shared.dir, ["branch", "--list", "task/*"]) === "" &&
      git(shared.dir, ["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree ")).length === 1 &&
      JSON.stringify(repoFacts(shared.dir)) === JSON.stringify(sharedFactsBefore));
    await capture("s02-existing-git-preview", 1440, 900);
    await capture("s02-existing-git-preview", 720, 560);
    await sizeTo(1440, 900);

    stage = "existing-git commit";
    await clickLabelled("确认创建 / 恢复", true);
    const sharedFactsBody = await until((body) => !body.includes("任务路径预览") && body.includes("任务工作区访问来源") &&
      body.includes(SHARED_TASK) && body.includes("已有 Git 目录 · 共享原检出"), "facts after the existing-git creation");
    check("the S02 dialog closed after the existing-git creation", (await dialogOpen()) === false);
    check("the app landed on the shared-checkout task facts", (await evalJs("!!document.querySelector('[data-testid=desktop-task-facts]')")) === true &&
      (await evalJs("!!document.querySelector('[data-testid=desktop-conversation]')")) === true);
    const sharedTaskId = intentB.taskId;
    check("the created shared-checkout task is really in the task-root inventory", inventoryTaskIds().includes(sharedTaskId), JSON.stringify(inventoryTaskIds()));
    check("the facts surface shows 已有 Git 目录 · 共享原检出 as the task mode", (await factsMode()) === "已有 Git 目录 · 共享原检出", String(await factsMode()));
    const sharedFlat = flat(sharedFactsBody);
    if (DEMO_LEAK.test(sharedFactsBody)) throw Error(`demo/fixture string leaked into the shared facts: ${sharedFactsBody.match(DEMO_LEAK)?.[0]}`);
    check("the facts surface badges the row as a shared original checkout",
      sharedFlat.includes("legacy-service") && sharedFlat.includes("已有 Git 目录 · 共享原检出"), sharedFlat.slice(0, 900));
    check("the facts surface names the real source path of the shared checkout",
      sharedFlat.includes(`原检出真实路径: ${sharedRealPath}`), sharedFlat.slice(0, 900));
    check("the facts surface names the observed branch and HEAD of the shared checkout",
      sharedFlat.includes("当前分支 main（实测）") && sharedFlat.includes(`HEAD ${sharedHeadBefore}（实测）`) &&
      sharedFlat.includes("共享原文件，非隔离副本"), sharedFlat.slice(0, 900));
    check("the facts surface does not describe the shared checkout as an isolated worktree",
      !sharedFlat.includes("独立 Git worktree"), sharedFlat.slice(0, 900));
    const pillsB = await factPills();
    check("the shared checkout row verifies as 已核验", pillsB.length === 1 && String(pillsB[0].pill).startsWith("已核验"), JSON.stringify(pillsB));

    const recordB = recordOf(sharedTaskId);
    check("the real creation wrote an existing-git task record with no worktree repos",
      recordB.record?.workspaceMode === "existing-git" && recordB.record?.repos.length === 0 &&
      (recordB.record?.repoSources ?? []).length === 0, JSON.stringify({ mode: recordB.record?.workspaceMode, repos: recordB.record?.repos }));
    const sharedRecord = (recordB.record?.sharedRepos ?? [])[0];
    check("the record binds the shared checkout's real path, branch, HEAD, common dir and remote digest",
      sharedRecord !== undefined && sharedRecord.sourcePath === sharedRealPath && sharedRecord.sourceRealPath === sharedRealPath &&
      sharedRecord.remote === "origin" && sharedRecord.remoteBranch === "main" && sharedRecord.headCommit === sharedHeadBefore &&
      sharedRecord.commonDir === realpathSync(join(shared.dir, ".git")) && /^[a-f0-9]{64}$/.test(sharedRecord.remoteDigest) &&
      sharedRecord.sourceDevice !== undefined && sharedRecord.sourceInode !== undefined,
      JSON.stringify(sharedRecord));
    const sharedFactsAfter = repoFacts(shared.dir);
    check("the shared checkout gained no commit", sharedFactsAfter.head === sharedHeadBefore &&
      sharedFactsAfter.commitCount === sharedFactsBefore.commitCount && sharedFactsAfter.branch === "main",
      JSON.stringify({ head: sharedFactsAfter.head, count: sharedFactsAfter.commitCount }));
    check("the shared checkout's uncommitted work is exactly where the user left it",
      readFileSync(join(shared.dir, "WIP-note.md"), "utf8") === "未提交的本地工作\n" &&
      sharedFactsAfter.status === sharedFactsBefore.status && sharedFactsAfter.status.includes("WIP-note.md"),
      sharedFactsAfter.status);
    check("the shared checkout has no task branch and no extra worktree",
      sharedFactsAfter.localRefs === sharedFactsBefore.localRefs &&
      sharedFactsAfter.worktreeList === sharedFactsBefore.worktreeList &&
      git(shared.dir, ["branch", "--list", "task/*"]) === "");
    check("the creation wrote no FETCH_HEAD into the shared checkout",
      !existsSync(join(shared.dir, ".git", "FETCH_HEAD")));
    check("the shared checkout's remote tracking refs were not fetched",
      sharedFactsAfter.remoteRefs === sharedFactsBefore.remoteRefs, sharedFactsAfter.remoteRefs);
    const existingGitDiskAfter = {
      fetchHeadWritten: existsSync(join(shared.dir, ".git", "FETCH_HEAD")),
      taskBranchCreated: git(shared.dir, ["branch", "--list", "task/*"]),
      worktreesInCheckout: sharedFactsAfter.worktreeList.split("\n").filter((line) => line.startsWith("worktree ")).length,
      localRefs: sharedFactsAfter.localRefs,
      remoteRefs: sharedFactsAfter.remoteRefs,
    };
    check("no .worktrees/ directory exists in the shared checkout or in the task folder",
      !existsSync(join(shared.dir, ".worktrees")) && !existsSync(join(recordB.record.taskDir, ".worktrees")) &&
      !readdirSync(recordB.record.taskDir).some((entry) => entry.startsWith("repo-")),
      JSON.stringify(readdirSync(recordB.record.taskDir)));
    await capture("task-facts-existing-git-after-create", 1440, 900);
    await capture("task-facts-existing-git-after-create", 720, 560);
    await sizeTo(1440, 900);

    // ------------------------------------------------------------- S02: 仅普通目录
    stage = "S02 plain-dirs form";
    await click(PROJECT_NAME);
    await until((body) => body.includes("工作空间复用来源") && body.includes(PROJECT_NAME), "overview before 仅普通目录");
    await click("项目管理");
    await until((body) => body.includes("返回工作空间总览"), "manage page for 仅普通目录");
    await click("任务");
    await until((body) => body.includes("新建任务 (New Task)") && body.includes("任务工作区模式 *"), "S02 dialog for 仅普通目录");
    await setMode("plain-dirs");
    const plainDraft = flat(await dialogText());
    check("仅普通目录 is really selected", JSON.stringify((await modeState()).map((row) => [row.value, row.checked])) ===
      JSON.stringify([["worktree", false], ["existing-git", false], ["plain-dirs", true]]));
    check("仅普通目录 states that Git repositories do not participate",
      plainDraft.includes("仅普通目录：共享原文件，不涉及 Git 仓库；写入影响原文件。"), plainDraft.slice(0, 800));
    const repoRowsInPlain = await evalJs(`[...document.querySelectorAll('[role=dialog] input[type=checkbox]')]
      .filter((el) => !(el.closest('label')?.textContent ?? '').includes('我确认普通目录'))
      .map((el) => ({ label: (el.closest('label')?.textContent ?? '').trim().slice(0, 40), disabled: el.disabled, checked: el.checked }))`);
    check("every repository row is disabled in 仅普通目录", repoRowsInPlain.filter((row) => row.label.startsWith("frontend-app") ||
      row.label.startsWith("gateway-api") || row.label.startsWith("legacy-service")).every((row) => row.disabled === true && row.checked === false),
      JSON.stringify(repoRowsInPlain));
    const attempted = await sourceCheckbox("frontend-app");
    check("a repository row cannot be selected by clicking it in 仅普通目录",
      attempted.disabled === true && attempted.before === false && attempted.after === false, JSON.stringify(attempted));
    check("仅普通目录 offers no per-repo remote/branch inputs", (await inputCount("远程名称")) === 0 && (await inputCount("远程分支")) === 0);
    await checkSource("docs");
    check("the plain directory stays selectable and needs the shared-write confirmation", (await sharedWriteConfirmed()) === true);
    check("仅普通目录 primary button really previews only plain paths", (await previewPrimaryLabel()) === "预览路径", String(await previewPrimaryLabel()));
    const plainSelected = flat(await dialogText());
    check("仅普通目录 counts zero repositories and one directory",
      plainSelected.includes("已选 0 个仓库 · 1 个目录") && plainSelected.includes("仅普通目录：共享原文件，不涉及 Git"));
    await capture("s02-plain-dirs-form", 1440, 900);
    await capture("s02-plain-dirs-form", 720, 560);
    await sizeTo(1440, 900);
    await clickLabelled("取消", true);
    await until((body) => !body.includes("新建任务 (New Task)"), "plain-dirs dialog closed");
    check("closing the plain-dirs form prepared nothing (no pending creation intent)",
      creation.current()?.state !== "pending", JSON.stringify(creation.current()?.state));

    // ----------------------------------------------- (f) healthy reopen of the facts
    stage = "healthy reopen";
    await enterTask(WORKTREE_TASK);
    const healthyBody = await factsBody();
    check("the healthy reopen re-reads the same mode badge", (await factsMode()) === "独立 Worktree", String(await factsMode()));
    check("the healthy reopen re-reads the same three sources", (await factPills()).length === 3 &&
      (await factPills()).every((row) => String(row.pill).startsWith("已核验")), JSON.stringify(await factPills()));
    check("the healthy reopen still names both worktree paths and the shared directory",
      healthyBody.includes(intentA.repos[0].repoDir) && healthyBody.includes(intentA.repos[1].repoDir) &&
      healthyBody.includes("普通目录 · 共享原文件"), flat(healthyBody).slice(0, 900));
    check("the healthy reopen did not rewrite the task record", recordOf(worktreeTaskId).sha256 === recordA.sha256,
      `${recordA.sha256} -> ${recordOf(worktreeTaskId).sha256}`);
    await settleFocus();
    await capture("task-facts-worktree-reopen", 1440, 900);
    await capture("task-facts-worktree-reopen", 720, 560);

    // -------------------------------------- (f) broken sources: delete + replace identity
    stage = "mutate sources";
    // One source checkout disappears entirely (来源缺失) …
    rmSync(shared.dir, { recursive: true, force: true });
    // … and one shared plain directory is replaced by a new directory at the same path,
    // which keeps the path valid but changes the recorded device/inode (身份不符).
    renameSync(docsDir, `${docsDir}-displaced`);
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, "另一个目录.md"), "同一路径下的另一个目录\n");
    check("the shared checkout is really gone", !existsSync(shared.dir));
    check("the replaced plain directory really has a different identity",
      String(statSync(docsDir).ino) !== String(recordA.record.dirLinks?.[0]?.sourceInode) || String(statSync(docsDir).dev) !== String(recordA.record.dirLinks?.[0]?.sourceDevice),
      JSON.stringify({ ino: String(statSync(docsDir).ino), recorded: recordA.record.dirLinks?.[0]?.sourceInode }));

    stage = "reopen with a missing source";
    await enterTask(SHARED_TASK);
    const missingBody = flat(await factsBody());
    const missingPills = await factPills();
    check("the facts still show the existing-git mode after its source was deleted",
      (await factsMode()) === "已有 Git 目录 · 共享原检出", String(await factsMode()));
    check("the deleted source is named 来源缺失 with the real path", missingPills.length === 1 &&
      String(missingPills[0].pill).startsWith("来源缺失") && String(missingPills[0].title).includes(sharedRealPath),
      JSON.stringify(missingPills));
    check("the missing source row offers the named repair path instead of another directory",
      missingBody.includes("修复路径：在「项目管理」中修复该来源后重新打开任务；记录未被改写，不认领其他目录"), missingBody.slice(0, 900));
    check("the missing source row does not silently name another directory",
      !missingBody.includes("WIP-未提交") && missingBody.includes(SHARED_TASK), missingBody.slice(0, 900));
    check("the reopen did not rewrite the existing-git task record", recordOf(sharedTaskId).sha256 === recordB.sha256,
      `${recordB.sha256} -> ${recordOf(sharedTaskId).sha256}`);
    await settleFocus();
    await capture("task-facts-existing-git-source-missing", 1440, 900);
    await capture("task-facts-existing-git-source-missing", 720, 560);

    stage = "reopen with a replaced source";
    await enterTask(WORKTREE_TASK);
    const mismatchBody = flat(await factsBody());
    const mismatchPills = await factPills();
    check("the replaced plain directory is named 身份不符", mismatchPills.length === 3 &&
      mismatchPills.filter((row) => String(row.pill).startsWith("身份不符")).length === 1 &&
      mismatchPills.filter((row) => String(row.pill).startsWith("已核验")).length === 2, JSON.stringify(mismatchPills));
    check("the 身份不符 reason names the recorded-vs-actual identity rule",
      String(mismatchPills.find((row) => String(row.pill).startsWith("身份不符"))?.title).includes("来源目录已被替换"), JSON.stringify(mismatchPills));
    check("the replaced plain directory still offers the repair path",
      mismatchBody.includes("修复路径：在「项目管理」中修复该来源后重新打开任务；记录未被改写，不认领其他目录"), mismatchBody.slice(0, 900));
    check("the two worktrees stay 已核验 while the shared directory is 身份不符",
      mismatchBody.includes(intentA.repos[0].repoDir) && mismatchBody.includes(intentA.repos[1].repoDir), mismatchBody.slice(0, 900));
    check("the reopen did not rewrite the worktree task record", recordOf(worktreeTaskId).sha256 === recordA.sha256,
      `${recordA.sha256} -> ${recordOf(worktreeTaskId).sha256}`);
    await enterWorkspace();
    await until((body) => body.includes("路径可用") && body.includes("来源缺失"), "workspace source verification after the mutations");
    const cardsAfterMutation = await sourceCards();
    check("the registry checks the replaced path as present while the task record names 身份不符",
      cardsAfterMutation.some((card) => card.includes("docs（普通目录）") && card.includes("路径可用")) &&
      cardsAfterMutation.some((card) => card.includes("legacy-service（Git 仓库）")), JSON.stringify(cardsAfterMutation));
    stage = "back to the worktree facts";
    await enterTask(WORKTREE_TASK);
    await settleFocus();
    await capture("task-facts-worktree-plain-dir-mismatch", 1440, 900);
    await capture("task-facts-worktree-plain-dir-mismatch", 720, 560);
    await settleFocus();
    await capture("task-facts-worktree-before-restart", 1440, 900);
    await capture("task-facts-worktree-before-restart", 720, 560);
    await sizeTo(1440, 900);

    let revision = "unknown"; let trackedFilesDirty = "unknown";
    try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: repoRoot }).trim(); } catch { /* recorded as unknown */ }
    try {
      const excluded = relative(repoRoot, output);
      const args = ["status", "--porcelain", "--untracked-files=no", "--", "."];
      if (excluded && !excluded.startsWith("..") && !isAbsolute(excluded)) args.push(`:(exclude)${excluded}`);
      trackedFilesDirty = execFileSync("git", args, { encoding: "utf8", cwd: repoRoot }).trim() ? "true" : "false";
    } catch { /* recorded as unknown */ }

    expectA = {
      taskId: worktreeTaskId, name: WORKTREE_TASK, mode: "worktree", recordSha256: recordA.sha256,
      taskDir: recordA.record.taskDir, branch: intentA.branch,
      projectRepositories: ["frontend-app", "gateway-api", "legacy-service"],
      repos: intentA.repos.map((repo) => ({ repoDir: repo.repoDir, name: repo.name, baseCommit: repo.commit, path: repo.path, realPath: repo.realPath })),
      plainDir: { linkName: intentA.directories[0].linkName, sourcePath: docsDir },
      verification: { worktrees: "ready", plainDir: "mismatch" },
    };
    expectB = {
      taskId: sharedTaskId, name: SHARED_TASK, mode: "existing-git", recordSha256: recordB.sha256,
      taskDir: recordB.record.taskDir, sourcePath: sharedRealPath, headCommit: sharedHeadBefore,
      remoteBranch: "main", verification: "missing",
    };

    // ---------------------------------------- real process restart (second OS process)
    stage = "restart process";
    const restartOut = await new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [scriptPath, "--phase", "restart", "--out", output], {
        env: { ...process.env, PIDOCK_T02_PROJECT_ID: projectId,
          PIDOCK_T02_EXPECT_A: JSON.stringify(expectA), PIDOCK_T02_EXPECT_B: JSON.stringify(expectB) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (data) => { stdout += data; process.stdout.write(`[t02-restart] ${data}`); });
      child.stderr.on("data", (data) => { stderr += data; process.stderr.write(`[t02-restart] ${data}`); });
      child.on("error", reject);
      child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    });
    check("the restart phase exited 0", restartOut.code === 0, JSON.stringify({ code: restartOut.code, stderr: restartOut.stderr.slice(-1200) }));
    const restartLog = JSON.parse(readFileSync(join(output, "restart-log.json"), "utf8"));
    check("restart process reported a different pid", restartLog.pid !== process.pid, `${process.pid} -> ${restartLog.pid}`);
    check("the restart process re-read both task records byte for byte",
      restartLog.records?.worktree?.sha256 === recordA.sha256 && restartLog.records?.shared?.sha256 === recordB.sha256,
      JSON.stringify(restartLog.records));
    check("the restart process re-read the same workspace sources",
      JSON.stringify(restartLog.workspace?.repositories) === JSON.stringify(["frontend-app", "gateway-api", "legacy-service"]),
      JSON.stringify(restartLog.workspace?.repositories));
    const restartStates = restartLog.shots.map((shot) => shot.state);
    check("the restart process rendered the worktree facts with the same mode and sources",
      restartStates.includes("task-facts-worktree-after-restart") &&
      restartLog.pageText.worktree.includes("独立 Worktree") &&
      restartLog.pageText.worktree.includes("身份不符") && restartLog.pageText.worktree.includes("来源目录已被替换"),
      JSON.stringify(Object.keys(restartLog.pageText ?? {})));
    check("the restart process rendered the existing-git facts with the same mode and the missing source",
      restartStates.includes("task-facts-existing-git-missing-after-restart") &&
      restartLog.pageText.shared.includes("已有 Git 目录 · 共享原检出") && restartLog.pageText.shared.includes("来源缺失"),
      JSON.stringify(restartLog.pageText?.shared ?? "").slice(0, 600));
    // Cross-process rendering identity: the SAME view, captured by the same code with focus
    // settled, from two different OS processes over the same on-disk data. The comparison is
    // per pixel, because Chromium's LCD text antialiasing can move a channel by one even when
    // the layout and the strings are identical; the measured delta is recorded, not hidden.
    const restartPixelDiffs = [];
    for (const [width, height, beforeState, afterState] of [
      [1440, 900, "task-facts-worktree-before-restart", "task-facts-worktree-after-restart"],
      [720, 560, "task-facts-worktree-before-restart", "task-facts-worktree-after-restart"],
      [1440, 900, "task-facts-existing-git-source-missing", "task-facts-existing-git-missing-after-restart"],
      [720, 560, "task-facts-existing-git-source-missing", "task-facts-existing-git-missing-after-restart"],
    ]) {
      const label = beforeState;
      const beforeName = shotFile(width, height, beforeState);
      const afterName = shotFile(width, height, afterState);
      const beforeShot = shots.find((shot) => shot.file === beforeName);
      const afterShot = restartLog.shots.find((shot) => shot.file === afterName);
      if (!beforeShot || !afterShot) throw Error(`missing restart comparison shot ${beforeName} / ${afterName}`);
      const diff = screenshotDiff(readFileSync(join(output, beforeName)), readFileSync(join(output, afterName)));
      restartPixelDiffs.push({ view: label, size: `${width}x${height}`, byteIdentical: beforeShot.sha256 === afterShot.sha256,
        beforeSha256: beforeShot.sha256, afterSha256: afterShot.sha256, ...diff });
      check(`post-restart ${label} ${width}x${height} screenshot matches the pre-restart one except for sub-pixel text antialiasing`,
        diff.differingPixels / diff.totalPixels <= 0.00005 && diff.maxChannelDelta <= 2, JSON.stringify(diff));
    }
    check("the restart process did not rewrite either task record",
      recordOf(worktreeTaskId).sha256 === recordA.sha256 && recordOf(sharedTaskId).sha256 === recordB.sha256);

    // Build identity: the runtime the capture really ran in and the exact renderer
    // bundle whose pixels are in the PNGs.
    const assetsDir = join(import.meta.dirname, "..", "dist", "renderer", "assets");
    const bundles = readdirSync(assetsDir).filter((name) => /^index-.*\.(js|css)$/.test(name))
      .map((name) => ({ file: `packages/shell/dist/renderer/assets/${name}`, sha256: sha256(readFileSync(join(assetsDir, name))) }));
    const runtime = { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome,
      v8: process.versions.v8, platform: process.platform, arch: process.arch, toolingNode: process.env["T02_TOOLING_NODE"] ?? null };
    const log = {
      ticket: "#137 从已有目录创建任务并展示工作区事实 — real Electron evidence (T02)",
      command, repoRoot, revision, trackedFilesDirty, runtime, bundles,
      generatedBy: "scripts/electron-pencil-v1-t02-capture.mjs",
      phase: "primary",
      pid: process.pid,
      seeded: {
        registry: "ProjectRegistry.create (real projects.json under isolated userData)",
        project: { id: projectId, name: PROJECT_NAME, repositories: ["frontend-app", "gateway-api", "legacy-service"], directories: ["docs"] },
        sources: {
          frontend: { path: frontend.dir, remote: frontend.remote, head: frontend.head },
          gateway: { path: gateway.dir, remote: gateway.remote, head: gateway.head },
          shared: { path: shared.dir, remote: shared.remote, head: sharedHeadBefore,
            uncommitted: sharedFactsBefore.status.split("\n") },
          docs: docsDir,
        },
        tasks: "both tasks were created through the product UI (S02 dialog → shell/createTask → main commit → Host provision); no task record was seeded",
      },
      createFlows: {
        worktree: {
          driven: "S02 dialog, mode 独立 Worktree（默认）, two repos + one plain directory, submit through 固定基线并预览路径 → 确认创建 / 恢复",
          intent: { taskId: intentA.taskId, taskDir: intentA.taskDir, branch: intentA.branch, mode: intentA.workspaceMode,
            repos: intentA.repos.map((repo) => ({ name: repo.name, path: repo.path, realPath: repo.realPath, remoteBranch: repo.remoteBranch, commit: repo.commit, repoDir: repo.repoDir })),
            directories: intentA.directories.map((dir) => ({ name: dir.name, path: dir.path, linkName: dir.linkName })) },
          record: { taskId: recordA.record.taskId, workspaceMode: recordA.record.workspaceMode, branch: recordA.record.branch,
            repos: recordA.record.repos, repoSources: recordA.record.repoSources, dirLinks: recordA.record.dirLinks, sha256: recordA.sha256 },
          sourceRepositoriesAfter: { frontend: repoFacts(frontend.dir), gateway: repoFacts(gateway.dir) },
          worktreesAfter: intentA.repos.map((repo) => ({ repoDir: repo.repoDir, target: join(recordA.record.taskDir, repo.repoDir),
            branch: git(join(recordA.record.taskDir, repo.repoDir), ["symbolic-ref", "--short", "HEAD"]) })),
        },
        existingGit: {
          driven: "S02 dialog, mode 已有 Git 目录, one dirty shared checkout, submit through 读取原检出并预览 → 确认创建 / 恢复",
          intent: { taskId: intentB.taskId, taskDir: intentB.taskDir, mode: intentB.workspaceMode,
            repos: intentB.repos.map((repo) => ({ name: repo.name, path: repo.path, realPath: repo.realPath, remoteBranch: repo.remoteBranch, commit: repo.commit })) },
          record: { taskId: recordB.record.taskId, workspaceMode: recordB.record.workspaceMode, repos: recordB.record.repos,
            sharedRepos: recordB.record.sharedRepos, sha256: recordB.sha256 },
          sharedCheckoutBefore: sharedFactsBefore,
          sharedCheckoutAfter: sharedFactsAfter,
          // Captured right after the creation; the checkout is deleted later for the
          // per-source reopen evidence, so these are recorded before the mutation.
          fetchHeadWritten: existingGitDiskAfter.fetchHeadWritten,
          taskBranchCreated: existingGitDiskAfter.taskBranchCreated,
          worktreesCreatedInCheckout: existingGitDiskAfter.worktreesInCheckout,
          remoteRefsUnchanged: existingGitDiskAfter.remoteRefs === sharedFactsBefore.remoteRefs,
          localRefsUnchanged: existingGitDiskAfter.localRefs === sharedFactsBefore.localRefs,
        },
        plainDirs: { driven: "S02 dialog, mode 仅普通目录: repository rows asserted disabled and unclickable; no intent prepared" },
      },
      reopen: {
        healthy: { taskId: worktreeTaskId, mode: "独立 Worktree", pills: ["已核验", "已核验", "已核验"], recordUnchanged: true },
        broken: {
          mutation: { deletedCheckout: shared.dir, replacedPlainDirectory: docsDir, displacedTo: `${docsDir}-displaced` },
          missing: { taskId: sharedTaskId, pills: missingPills, recordSha256Before: recordB.sha256, recordSha256After: recordOf(sharedTaskId).sha256 },
          mismatch: { taskId: worktreeTaskId, pills: mismatchPills, recordSha256Before: recordA.sha256, recordSha256After: recordOf(worktreeTaskId).sha256 },
        },
      },
      restart: {
        kind: "real OS process restart of the capture harness wiring (still not dist/main/main.js lifecycle)",
        pidBefore: process.pid,
        pidAfter: restartLog.pid,
        records: restartLog.records,
        workspace: restartLog.workspace,
        views: restartLog.pageText,
        screenshotComparison: restartPixelDiffs,
        shots: restartLog.shots,
        assertions: restartLog.assertions,
      },
      assertions,
      shots,
    };
    writeFileSync(join(output, "capture-log.json"), `${JSON.stringify(log, null, 2)}\n`);
    for (const shot of shots) console.log("T02_CAPTURE=" + JSON.stringify({ state: shot.state, file: shot.file, sha256: shot.sha256 }));
    console.log("T02_CAPTURE_LOG=" + JSON.stringify({ revision, trackedFilesDirty, shots: shots.map((shot) => shot.file),
      restartShots: restartLog.shots.map((shot) => shot.file), worktreeTaskId, sharedTaskId, assertions: assertions.length }));
  } catch (error) {
    console.error(`T02_CAPTURE_FAILED [${phase}]`, stage, error);
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    const cleanupFailures = await shutdownTestRegistry(registry, {
      origin: views ? { kind: "shell-ui", senderWebContentsId: views.shellView.webContents.id } : undefined,
      label: `PencilV1 T02 capture cleanup (${phase})`,
    });
    for (const child of children) child.kill();
    if (views?.shellView.webContents.debugger.isAttached()) views.shellView.webContents.debugger.detach();
    views?.window.destroy();
    if (phase !== "restart") rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    if (cleanupFailures.length) { console.error(`T02_CAPTURE_CLEANUP_FAILED [${phase}] ` + JSON.stringify(cleanupFailures)); process.exitCode = process.exitCode ?? 1; }
    exitNow(process.exitCode ?? 0, "done");
  }
}
void run();
