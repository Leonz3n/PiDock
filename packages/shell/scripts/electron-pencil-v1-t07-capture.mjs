// [PiDock pencil-v1 / T07] (#142) real-Electron evidence for 默认自动创建独立 worktree:
// the S02 default (no mode click), real worktree creations from a temp repository with
// a planted stale `refs/remotes/origin/main`, the session entry with NO Provider
// configured, two sequential + two concurrent tasks, reopen and a second-OS-process
// restart.
//
// Run after `pnpm --filter @pidock/shell build`:
//   pnpm --filter @pidock/shell exec electron scripts/electron-pencil-v1-t07-capture.mjs \
//     --out docs/evidence/pencil-v1-t07
//
// Boot path is identical to the #136/#137 harness (`electron-pencil-v1-t01/t02-capture.mjs`):
// the compiled production runtime modules are imported directly (NOT `dist/main/main.js`) with
// the production wiring decisions — `createTrustedWindow(..., "production")`, `registerIpc` over
// a real `TaskRootIndex`/`ProjectRegistry`/`PerTaskHostRegistry`/`ProjectTaskCreation` (wired
// with the REAL `WorktreeMetadataLock`, exactly like `main.ts`)/`ProviderWiring`/`ServiceCatalog`
// — and the built React renderer (`dist/renderer/index.html`, no fixture entry, no dev-server
// override). Every task on screen is created through the product's own main-side creation path;
// NOTHING in the UI path is a seeded task record.
//
// Seeded through real APIs only: `ProjectRegistry.create` writes projects.json under the
// isolated userData, and the source is a real temp Git repository with its own bare `origin`,
// one commit that exists ONLY on the remote, a planted STALE `refs/remotes/origin/main`
// pointing at the older local HEAD, and uncommitted user work in the checkout — plus one real
// plain directory.
//
// Captured at 1440x900 and 720x560:
//   (a) S02 default form: 独立 Worktree（默认） preselected with a Git source — no mode click
//   (b) S02 prepared preview: task branch, worktree path, pinned base commit and the shared
//       plain-directory fact
//   (c) task facts after the REAL default-mode creation of task A (worktree + `来源检出` path
//       + shared plain-dir row), with the real remote tip as HEAD and not the stale ref
//   (d) the `main` conversation entry with no Provider configured: explicit requirement
//       banner, route to 能力管理 · Providers, no model selected and no turn started
//   (e) task facts after the REAL creation of task B from the same repository (distinct
//       worktree path and distinct `task/<idB>` branch)
//   (f) the workspace ledger with all four tasks (A, B and the concurrent pair C, D)
//   (g) reopen of both tasks, then a pre-restart reference
//   (h) the second Electron OS process re-reading and re-rendering both tasks' facts
//
// Hang discipline: the deadline timer and the uncaught-error handlers are armed before the
// compiled `dist` graph is imported (dynamically, inside the guarded region).
import { app, utilityProcess } from "electron";
import { createUnavailableHostClient } from "./unavailable-host-client.mjs";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { shutdownTestRegistry } from "./shutdown-test-registry.mjs";

// The dev-server override is inadmissible evidence: clear it before boot so this
// capture can only ever load the packaged `file://` renderer.
delete process.env["PIDOCK_RENDERER_URL"];
delete process.env["PIDOCK_TASK_URL"];
if (process.env["PIDOCK_RENDERER_URL"]) throw Error("PIDOCK_RENDERER_URL survived the clear");

const scriptPath = resolve(import.meta.dirname, "electron-pencil-v1-t07-capture.mjs");
const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const argValue = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const phase = argValue("--phase") ?? "primary";
const outArg = argValue("--out") ?? "docs/evidence/pencil-v1-t07";
const output = isAbsolute(outArg) ? outArg : resolve(repoRoot, outArg);
const command = "pnpm --filter @pidock/shell exec electron scripts/electron-pencil-v1-t07-capture.mjs --out docs/evidence/pencil-v1-t07";
// A fixed (not random) temp root keeps the captured source paths stable, so a re-run at
// the same revision renders byte-identical PNGs. Isolated under the OS temp dir.
const root = join(tmpdir(), "pidock-pencil-v1-t07-capture");
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
  console.error(`T07_CAPTURE_EXIT ${phase}`, code, why);
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

const PROJECT_NAME = "T07 验收工作区";
const PROJECT_DESCRIPTION = "默认自动创建独立 worktree（#142 / T07 验收）";
const TASK_A = "默认工作树验收 A";
const TASK_B = "默认工作树验收 B";
const TASK_C = "并发工作树验收 C";
const TASK_D = "并发工作树验收 D";
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
  remoteRefNames: git(dir, ["for-each-ref", "--format=%(refname)", "refs/remotes"]),
  remoteRefs: git(dir, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes"]),
  worktreeList: git(dir, ["worktree", "list", "--porcelain"]),
});
/** Every ref of the bare remote: a push would add one (task branch). */
const remoteRefsOf = (remote) => git(remote, ["for-each-ref", "--format=%(refname) %(objectname)"]);

const SEED_COMMIT_DATE = "2026-11-04T09:00:00+0000";
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
const remoteHead = (remote) => git(remote, ["rev-parse", "main"]);
/** `git worktree list --porcelain` paths without the source checkout itself. */
const worktreePaths = (repo) => git(repo, ["worktree", "list", "--porcelain"]).split("\n")
  .filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));
/** The same list with every path resolved, so macOS `/var` vs `/private/var` cannot fake a mismatch. */
const worktreeRealPaths = (repo) => worktreePaths(repo).map((path) => realpathSync(path));

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
  const { performCreationOperation } = await import("../dist/main/project-task-ipc.js");
  const { WorktreeMetadataLock } = await import("../dist/main/worktree-metadata-lock.js");
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
  let source, docsDir;
  let sourceSeed = null;
  let sourceFactsBefore = null;
  let remoteRefsBefore = "";
  let expectA = null;
  let expectB = null;
  // Main-side routeTaskOp log: proves no turn (`task/sendMessage`) was started and
  // no Provider was pushed by the app on its own.
  const ops = [];
  let shim = null;
  let shimLog = [];
  const savedPath = process.env["PATH"];
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
      // ---------------------------------------------------------------- seeded source
      // A real Git repository with a real bare remote. The remote advertises a
      // commit that exists ONLY on the remote (the source checkout was reset back
      // to the older base), and the source's `refs/remotes/origin/main` is planted
      // at the STALE older commit on purpose: the creation must use the commit its
      // own fetch pinned, never a cached ref or the checkout's local branch.
      stage = "seed source";
      source = seedRepo("task-repo", "# task-repo\n\nT07 验收：默认独立 worktree 来源仓库。\n", "base: task-repo");
      sourceSeed = { dir: source.dir, remote: source.remote, base: source.head };
      writeFileSync(join(source.dir, "next.txt"), "next\n");
      git(source.dir, ["add", "next.txt"]);
      execFileSync("git", ["commit", "-m", "remote tip"], { cwd: source.dir, encoding: "utf8",
        env: { ...process.env, GIT_AUTHOR_DATE: SEED_COMMIT_DATE, GIT_COMMITTER_DATE: SEED_COMMIT_DATE },
        stdio: ["ignore", "pipe", "pipe"] });
      const remoteTip = git(source.dir, ["rev-parse", "HEAD"]);
      git(source.dir, ["push", "origin", "main"]);
      git(source.dir, ["reset", "--hard", "HEAD~1"]);
      // The stale tracking ref a previous fetch would have left behind.
      git(source.dir, ["update-ref", "refs/remotes/origin/main", git(source.dir, ["rev-parse", "HEAD"])]);
      // Uncommitted work the user left in the source checkout: the creation must
      // neither move the source HEAD nor touch these bytes.
      writeFileSync(join(source.dir, "README.md"), "# task-repo\n\nT07 验收：默认独立 worktree 来源仓库。\n\n本地未提交修改。\n");
      writeFileSync(join(source.dir, "WIP-note.md"), "未提交的本地工作\n");
      const staleRef = git(source.dir, ["rev-parse", "refs/remotes/origin/main"]);
      sourceFactsBefore = repoFacts(source.dir);
      sourceSeed = { ...sourceSeed, remoteTip, staleRef, sourceHead: sourceFactsBefore.head };
      check("the seeded remote really advertises a commit the local checkout does not have",
        remoteHead(source.remote) === remoteTip && sourceFactsBefore.head !== remoteTip,
        JSON.stringify({ remoteTip, localHead: sourceFactsBefore.head }));
      check("the seeded source really carries a STALE refs/remotes/origin/main",
        staleRef === sourceFactsBefore.head && staleRef !== remoteTip, JSON.stringify({ staleRef, remoteTip }));
      check("the seeded source checkout really has uncommitted work",
        sourceFactsBefore.status.includes("README.md") && sourceFactsBefore.status.includes("WIP-note.md"),
        sourceFactsBefore.status);
      check("the seeded source checkout has exactly one checkout and one local branch",
        worktreePaths(source.dir).length === 1 && sourceFactsBefore.localRefs === `refs/heads/main ${sourceFactsBefore.head}`,
        sourceFactsBefore.localRefs);
      docsDir = join(sourcesRoot, "docs");
      mkdirSync(docsDir, { recursive: true });
      writeFileSync(join(docsDir, "规范.md"), "# 规范\n\nT07 普通目录验收。\n");

      stage = "seed registry";
      project = await projects.create({
        name: PROJECT_NAME,
        description: PROJECT_DESCRIPTION,
        repositories: [{ name: "task-repo", path: source.dir }],
        directories: [{ name: "docs", path: docsDir }],
        environment: [
          { key: "NODE_ENV", value: "development" },
          { key: "T07_EVIDENCE", value: "1" },
        ],
        branchTemplate: BRANCH_TEMPLATE,
      });
      projectId = project.id;
      remoteRefsBefore = remoteRefsOf(source.remote);
      check("the registry really stores the one repository source and one directory",
        project.repositories.length === 1 && project.directories.length === 1,
        JSON.stringify({ repositories: project.repositories.map((row) => row.name), directories: project.directories.map((row) => row.name) }));
      check("no task exists before the UI creates one", inventoryTaskIds().length === 0, JSON.stringify(inventoryTaskIds()));
    } else {
      projectId = process.env["PIDOCK_T07_PROJECT_ID"] ?? "";
      if (!projectId) throw Error("restart phase: PIDOCK_T07_PROJECT_ID missing");
      expectA = JSON.parse(process.env["PIDOCK_T07_EXPECT_A"] ?? "null");
      expectB = JSON.parse(process.env["PIDOCK_T07_EXPECT_B"] ?? "null");
      if (!expectA || !expectB) throw Error("restart phase: expected task identities missing");
      stage = "restart identity";
      check("the restart process reads the same workspace id from projects.json", projects.get(projectId)?.id === projectId, projectId);
      check("the restart process reads the same workspace source",
        JSON.stringify((projects.get(projectId)?.repositories ?? []).map((row) => row.name)) === JSON.stringify(expectA.projectRepositories),
        JSON.stringify((projects.get(projectId)?.repositories ?? []).map((row) => row.name)));
    }

    stage = "window";
    views = await createTrustedWindow(restart ? "pencil-v1-t07-restart" : "pencil-v1-t07", "production");
    const workspaceId = restart ? "pencil-v1-t07-restart" : "pencil-v1-t07";
    registry = new PerTaskHostRegistry(workspaceId, async (workspace, task) => {
      const entry = join(import.meta.dirname, "..", "dist", "host", "host-entry.js");
      const child = utilityProcess.fork(entry, [], { serviceName: `${workspaceId}-host`, env: buildHostEnv(process.env, workspace, task, app.getPath("userData")), stdio: "pipe" });
      children.push(child);
      child.stderr?.on("data", (data) => process.stderr.write(`[${workspaceId}-host] ${data}`));
      return { child, client: new HostClient(child) };
    }, (id) => index.resolve(id), undefined, index);
    // Instrument the main boundary BEFORE any handler exists: every Host op the app
    // routes is logged here (a started turn is `task/sendMessage`).
    const originalRoute = registry.routeTaskOp.bind(registry);
    registry.routeTaskOp = async (input) => {
      ops.push({ op: input?.op ?? null, action: input?.payload?.action ?? null, taskId: input?.taskId ?? null });
      return originalRoute(input);
    };
    // Same wiring decisions as the production entry: main owns the real creation-intent
    // store, the REAL repository-level lock (main.ts wires `WorktreeMetadataLock`),
    // Provider wiring and service catalog, and hands them to `registerIpc`.
    const providerProfiles = new ProviderProfileStore(profile);
    const lock = new WorktreeMetadataLock(profile, { notify: (message) => console.error(`[t07-lock] ${message}`) });
    const creation = new ProjectTaskCreation(new CreationIntentStore(profile), projects, index, registry, taskRoot, undefined, lock);
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
    const sharedWriteConfirmed = () => evalJs(`(() => {
      const input = [...document.querySelectorAll('[role=dialog] input[type=checkbox]')]
        .find((el) => (el.closest('label')?.textContent ?? '').includes('我确认普通目录'));
      if (!input) throw Error('missing shared-write confirmation');
      input.click();
      return input.checked;
    })()`);
    /** Read the three workspace-mode radios without clicking any of them. */
    const modeState = () => evalJs("[...document.querySelectorAll('[role=dialog] input[type=radio]')].map((el) => ({ value: el.value, checked: el.checked, disabled: el.disabled }))");
    const previewPrimaryLabel = () => evalJs(`(() => {
      const root = document.querySelector('[role=dialog]');
      const button = root ? [...root.querySelectorAll('button[type=submit],button[aria-label]')].find((el) => el.textContent.includes('⌘↵')) : null;
      return button ? button.textContent.replace(/\\s*⌘↵\\s*$/, '').trim() : null;
    })()`);
    const sourceCards = () => evalJs("[...document.querySelectorAll('[data-source-id]')].map((el) => el.textContent.replace(/\\s+/g, ' ').trim())");
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
    const providerRequirement = () => evalJs("document.querySelector('[data-testid=provider-requirement]')?.innerText ?? null");
    const composerModel = () => evalJs("document.querySelector('[data-testid=composer-model]')?.textContent.trim() ?? null");
    const mainTab = () => evalJs("document.querySelector('[role=tab][aria-selected=true]')?.textContent.trim() ?? null");
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
        providerRequirement: box(document.querySelector('[data-testid=provider-requirement]')),
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
    const enterS02 = async () => {
      await enterWorkspace();
      await click("项目管理");
      await until((body) => body.includes("工作空间与任务") && body.includes("返回工作空间总览"), "manage page");
      await click("任务");
      return until((body) => body.includes("新建任务 (New Task)") && body.includes("任务工作区模式 *") &&
        body.includes("关联工作区仓库与目录 *"), "S02 create-task dialog");
    };
    /** Install a PATH `git` shim that logs every invocation and then runs the real binary.
     * The real binary and the log path are baked into the script (not carried in env),
     * because the Host process receives only the OS startup environment (PATH/TMPDIR/…)
     * and would otherwise run a broken shim. */
    const installGitShim = () => {
      const dir = join(root, "bin");
      mkdirSync(dir, { recursive: true });
      const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      const logFile = join(root, "git-invocations.log");
      const quoted = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
      writeFileSync(join(dir, "git"),
        `#!/bin/sh\nprintf '%s\\t%s\\n' "$1" "$2" >> ${quoted(logFile)}\nexec ${quoted(realGit)} "$@"\n`);
      chmodSync(join(dir, "git"), 0o755);
      process.env["PATH"] = `${dir}${process.platform === "win32" ? ";" : ":"}${process.env["PATH"] ?? ""}`;
      return { dir, logFile, realGit };
    };
    const gitInvocations = () => {
      const raw = readFileSync(shim.logFile, "utf8").trim();
      return raw.length === 0 ? [] : raw.split("\n").map((line) => line.split("\t"));
    };
    const removeGitShim = () => {
      if (savedPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = savedPath;
    };
    const scrollContentTop = () => evalJs("(() => { for (const el of [document.querySelector('[data-testid=desktop-shell-content]'), document.documentElement]) { if (el) el.scrollTop = 0; } return true; })()");
    const scrollConversationIntoView = () => evalJs("(() => { document.querySelector('[data-testid=desktop-conversation]')?.scrollIntoView?.({ block: 'start' }); return true; })()");

    // ------------------------------------------- restart phase: post-restart evidence
    // This branch runs in a NEW Electron OS process over the same on-disk registry/task-root
    // files (fresh ProjectRegistry/TaskRootIndex/Host instances). It re-reads both task
    // records byte for byte and re-renders both tasks' facts — mode badge, per-source rows,
    // the worktree target path, the task branch and the pinned base commit.
    if (restart) {
      const records = { a: recordOf(expectA.taskId), b: recordOf(expectB.taskId) };
      const workspace = projects.get(projectId);
      check("the restart process reads the same workspace id", workspace?.id === projectId, projectId);
      check("the restart process reads the same workspace source",
        JSON.stringify((workspace?.repositories ?? []).map((row) => row.name)) === JSON.stringify(expectA.projectRepositories),
        JSON.stringify((workspace?.repositories ?? []).map((row) => row.name)));
      check("the restart process reads task A's record byte for byte", records.a.sha256 === expectA.recordSha256,
        `${expectA.recordSha256} -> ${records.a.sha256}`);
      check("the restart process reads task B's record byte for byte", records.b.sha256 === expectB.recordSha256,
        `${expectB.recordSha256} -> ${records.b.sha256}`);
      for (const [label, record, expect] of [["A", records.a, expectA], ["B", records.b, expectB]]) {
        check(`task ${label}'s record still declares worktree mode with one repo and one shared directory`,
          record.record?.workspaceMode === "worktree" && record.record?.repos.length === 1 &&
          (record.record?.repoSources ?? []).length === 1 && (record.record?.dirLinks ?? []).length === 1,
          JSON.stringify({ mode: record.record?.workspaceMode, repos: record.record?.repos }));
        check(`task ${label}'s record still names the task branch and the pinned base commit`,
          record.record?.branch === expect.branch && (record.record?.repoSources ?? [])[0]?.baseCommit === expect.baseCommit &&
          (record.record?.repoSources ?? [])[0]?.sourceRealPath === expect.sourcePath,
          JSON.stringify({ branch: record.record?.branch, repoSources: record.record?.repoSources }));
        check(`task ${label}'s worktree still exists on the task branch`,
          git(join(expect.taskDir, expect.repoDir), ["symbolic-ref", "--short", "HEAD"]) === expect.branch,
          git(join(expect.taskDir, expect.repoDir), ["symbolic-ref", "--short", "HEAD"]));
      }
      const listed = worktreePaths(expectA.sourcePath);
      const listedReal = worktreeRealPaths(expectA.sourcePath);
      check("the restart process sees both task worktrees registered in the shared source repository",
        listedReal.includes(expectA.worktreeRealPath) && listedReal.includes(expectB.worktreeRealPath),
        JSON.stringify({ listed, a: expectA.worktreeRealPath, b: expectB.worktreeRealPath }));

      await until((body) => body.includes(PROJECT_NAME) || body.includes("未归属任务"), "shell boot in the restart process");
      for (const [label, expect] of [["A", expectA], ["B", expectB]]) {
        await enterTask(expect.name);
        await settleFocus();
        await capture(`task-facts-worktree-${label.toLowerCase()}-after-restart`, 1440, 900);
        await capture(`task-facts-worktree-${label.toLowerCase()}-after-restart`, 720, 560);
        const taskText = flat(await factsBody());
        const pills = await factPills();
        check(`post-restart task ${label} keeps the 独立 Worktree mode badge`, (await factsMode()) === "独立 Worktree", String(await factsMode()));
        check(`post-restart task ${label} keeps two sources verified`,
          pills.length === 2 && pills.every((row) => String(row.pill).startsWith("已核验")), JSON.stringify(pills));
        check(`post-restart task ${label} keeps its worktree target path and task branch`,
          taskText.includes(`目标检出路径: ${expect.taskDir}/${expect.repoDir}`) &&
          taskText.includes(`任务分支 ${expect.branch}`) && taskText.includes(`工作分支 ${expect.branch}（实测）`), taskText.slice(0, 900));
        check(`post-restart task ${label} keeps its pinned base commit and source checkout path`,
          taskText.includes(`基线 main @ ${expect.baseCommit}`) && taskText.includes(`来源检出 ${expect.sourcePath}`), taskText.slice(0, 900));
        check(`post-restart task ${label} keeps the shared plain-directory row`,
          taskText.includes("普通目录 · 共享原文件") && taskText.includes(`本地真实路径: ${expect.plainDir.sourcePath}`), taskText.slice(0, 900));
        if (DEMO_LEAK.test(taskText)) throw Error(`demo/fixture string leaked into the restarted task ${label} facts: ${taskText.match(DEMO_LEAK)?.[0]}`);
      }
      let revision = "unknown";
      try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: repoRoot }).trim(); } catch { /* recorded as unknown */ }
      const log = {
        phase: "restart",
        pid: process.pid,
        command: `${command} --phase restart`,
        revision,
        workspace: { id: workspace?.id, name: workspace?.name, repositories: (workspace?.repositories ?? []).map((row) => row.name),
          directories: (workspace?.directories ?? []).map((row) => row.name) },
        records: {
          a: { taskId: records.a.record?.taskId, sha256: records.a.sha256, workspaceMode: records.a.record?.workspaceMode, branch: records.a.record?.branch },
          b: { taskId: records.b.record?.taskId, sha256: records.b.sha256, workspaceMode: records.b.record?.workspaceMode, branch: records.b.record?.branch },
        },
        worktrees: listed,
        assertions,
        shots,
      };
      writeFileSync(join(output, "restart-log.json"), `${JSON.stringify(log, null, 2)}\n`);
      console.log("T07_RESTART_CAPTURE=" + JSON.stringify({ pid: process.pid, shots: shots.map((shot) => shot.file),
        records: log.records, assertions: assertions.length }));
      return;
    }

    // ------------------------------------------------------- workspace overview (read)
    stage = "workspace overview";
    await until((body) => body.includes(PROJECT_NAME) || body.includes("未归属任务"), "shell boot");
    await sizeTo(1440, 900);
    await click(PROJECT_NAME);
    const overviewBody = await until((body) => body.includes(PROJECT_NAME) && body.includes("工作空间复用来源（Git 仓库与普通目录）") &&
      body.includes("task-repo（Git 仓库）"), "workspace overview");
    if (DEMO_LEAK.test(overviewBody)) throw Error(`demo/fixture string leaked into the overview: ${overviewBody.match(DEMO_LEAK)?.[0]}`);
    check("the overview names the seeded workspace", overviewBody.includes(PROJECT_NAME));
    check("the sidebar lists the seeded workspace", (await navLabels()).includes(PROJECT_NAME), JSON.stringify(await navLabels()));
    check("the overview lists the real Git source and the plain directory",
      overviewBody.includes("task-repo（Git 仓库）") && overviewBody.includes("docs（普通目录）"));
    check("the overview draws every seeded source as readable", (await sourceCards()).length === 2 &&
      (await sourceCards()).every((card) => card.includes("路径可用")), JSON.stringify(await sourceCards()));

    // -------------------------------------------------- S02: default mode, no click
    stage = "S02 default form";
    const form = await enterS02();
    check("S02 is a named modal", (await evalJs("document.querySelector('[role=dialog]')?.getAttribute('aria-label') ?? null")) === "新建任务");
    const defaultModes = await modeState();
    check("S02 opens on 独立 Worktree（默认） WITHOUT any mode click",
      JSON.stringify(defaultModes.map((row) => [row.value, row.checked])) ===
      JSON.stringify([["worktree", true], ["existing-git", false], ["plain-dirs", false]]), JSON.stringify(defaultModes));
    check("S02 shows all three workspace modes as real, enabled controls",
      defaultModes.length === 3 && defaultModes.every((row) => row.disabled === false), JSON.stringify(defaultModes));
    check("S02 names the default worktree in the mode control", form.includes("独立 Worktree（默认）"));
    check("S02 names the worktree hint under the mode control",
      form.includes("为每个选中仓库创建独立 Worktree 与任务分支；原仓库保持不动，不覆盖未提交修改。"));
    // Drive the real controls — but never the mode: the worktree mode must be the DEFAULT.
    await checkSource("task-repo");
    await typeAt("远程名称", "origin", 0);
    await typeAt("远程分支", "main", 0);
    await checkSource("docs");
    check("the shared-write confirmation appears once a plain directory is selected", (await sharedWriteConfirmed()) === true);
    await typeAt("任务名称", TASK_A);
    const modesAfterSources = await modeState();
    check("selecting a Git source keeps the default mode on 独立 Worktree（默认） (no mode click happened)",
      JSON.stringify(modesAfterSources.map((row) => [row.value, row.checked])) ===
      JSON.stringify([["worktree", true], ["existing-git", false], ["plain-dirs", false]]), JSON.stringify(modesAfterSources));
    const draft = flat(await dialogText());
    check("the default draft counts 1 repository and 1 directory", draft.includes("已选 1 个仓库 · 1 个目录"), draft.slice(0, 600));
    check("the default draft states the automatic isolated worktree for 1 repo",
      draft.includes("⚡ 自动创建隔离 Worktree：1 个仓库，原仓库保持安全隔离"));
    check("the default draft primary button prepares a baseline preview", (await previewPrimaryLabel()) === "固定基线并预览路径", String(await previewPrimaryLabel()));
    await settleFocus();
    await capture("s02-worktree-default", 1440, 900);
    await capture("s02-worktree-default", 720, 560);
    await sizeTo(1440, 900);

    stage = "S02 worktree prepare";
    await clickLabelled("固定基线并预览路径", true);
    const preview = await until((body) => body.includes("任务路径预览 · " + TASK_A) &&
      body.includes("任务工作区模式：独立 Worktree（默认）"), "worktree intent preview");
    check("the worktree preview replaces the form header with the prepared task name",
      (await dialogTitle()) === `任务路径预览 · ${TASK_A}`, String(await dialogTitle()));
    check("the worktree preview is the real resumable intent state, not the form",
      flat(preview).includes("创建中断后会保留固定任务身份与提交") && flat(preview).includes("放弃并重新创建"),
      flat(preview).slice(0, 600));
    const intentA = creation.current();
    if (!intentA || intentA.workspaceMode !== "worktree") throw Error(`main holds no worktree intent: ${JSON.stringify(intentA)}`);
    const previewA = flat(await dialogText());
    check("the preview states the real prepared task folder", previewA.includes(intentA.taskDir), intentA.taskDir);
    check("the preview names the task branch main prepared", previewA.includes(`任务分支：${intentA.branch}`), intentA.branch);
    check("the preview names the task branch as task/<taskId>", intentA.branch === `task/${intentA.taskId}`, intentA.branch);
    for (const repo of intentA.repos) {
      check(`the preview names ${repo.name} with remote/branch, the pinned base commit and the worktree path`,
        previewA.includes(`${repo.name} · 原检出 ${repo.path} · ${repo.remote}/${repo.remoteBranch} · 固定基线 ${repo.commit} → ${intentA.taskDir}/${repo.repoDir}`),
        previewA.slice(0, 900));
      check(`the preview claims an isolated worktree for ${repo.name}`,
        previewA.includes(`${intentA.taskDir}/${repo.repoDir}`) && previewA.includes("⚡ 自动创建隔离 Worktree"));
    }
    for (const dir of intentA.directories) {
      check(`the preview names the plain directory ${dir.name} as shared and writable`,
        previewA.includes(`${dir.name} · ${dir.path} → ${intentA.taskDir}/${dir.linkName}（共享可写）`), previewA.slice(0, 900));
    }
    check("the pinned commit is the REAL remote head, not the planted stale tracking ref",
      intentA.repos.every((repo) => repo.commit === remoteHead(source.remote) && repo.commit !== sourceSeed.staleRef),
      JSON.stringify({ pinned: intentA.repos.map((repo) => repo.commit), remote: remoteHead(source.remote), stale: sourceSeed.staleRef }));
    check("the preview is read-only: no worktree or task branch exists before 确认创建",
      worktreePaths(source.dir).length === 1 && git(source.dir, ["branch", "--list", "task/*"]) === "",
      JSON.stringify(worktreePaths(source.dir)));
    await settleFocus();
    await capture("s02-worktree-preview", 1440, 900);
    await capture("s02-worktree-preview", 720, 560);
    await sizeTo(1440, 900);

    // ------------------------------------------------- REAL creation of task A
    stage = "worktree commit A";
    // Every `git` invocation of the creation goes through a PATH shim that logs it
    // and then runs the real binary: the no-push assertion is about what the product
    // actually executed, not about what the source code appears to say.
    shim = installGitShim();
    await clickLabelled("确认创建 / 恢复", true);
    const factsA = await until((body) => !body.includes("任务路径预览") && body.includes("任务工作区访问来源") &&
      body.includes(TASK_A) && body.includes("独立 Worktree"), "facts after the default worktree creation");
    check("the S02 dialog closed after the real creation", (await dialogOpen()) === false);
    check("the app landed on the task facts surface", (await evalJs("!!document.querySelector('[data-testid=desktop-task-facts]')")) === true);
    check("the app landed with the conversation entry below the facts", (await evalJs("!!document.querySelector('[data-testid=desktop-conversation]')")) === true);
    const taskIdA = intentA.taskId;
    check("the created task is really in the task-root inventory", inventoryTaskIds().includes(taskIdA), JSON.stringify(inventoryTaskIds()));
    check("the facts surface shows the 独立 Worktree mode badge", (await factsMode()) === "独立 Worktree", String(await factsMode()));
    check("the facts surface names the task", factsA.includes(TASK_A));
    if (DEMO_LEAK.test(factsA)) throw Error(`demo/fixture string leaked into the task A facts: ${factsA.match(DEMO_LEAK)?.[0]}`);

    const recordA = recordOf(taskIdA);
    check("the real default-mode creation wrote a worktree-mode task record",
      recordA.record?.workspaceMode === "worktree" && recordA.record?.repos.length === 1 &&
      recordA.record?.branch === `task/${taskIdA}` && recordA.record?.branchKind === "task-worktree",
      JSON.stringify({ mode: recordA.record?.workspaceMode, branch: recordA.record?.branch, branchKind: recordA.record?.branchKind }));
    const repoSourceA = (recordA.record?.repoSources ?? [])[0];
    check("the record pins the base commit THIS creation fetched from the real remote",
      repoSourceA?.remote === "origin" && repoSourceA?.remoteBranch === "main" &&
      repoSourceA?.baseCommit === remoteHead(source.remote) && repoSourceA?.baseCommit !== sourceSeed.staleRef,
      JSON.stringify(repoSourceA));
    check("the record keeps the observed checkout identity (real path, branch, HEAD, source)",
      repoSourceA?.targetRealPath === realpathSync(join(intentA.taskDir, repoSourceA.repoDir)) &&
      repoSourceA?.targetBranch === `task/${taskIdA}` && repoSourceA?.targetHead === remoteHead(source.remote) &&
      repoSourceA?.sourceRealPath === realpathSync(source.dir),
      JSON.stringify(repoSourceA));
    const worktreeA = join(intentA.taskDir, repoSourceA.repoDir);
    check("the worktree for task A exists under the task folder", existsSync(worktreeA), worktreeA);
    check("the worktree for task A is really on task/<idA>",
      git(worktreeA, ["symbolic-ref", "--short", "HEAD"]) === `task/${taskIdA}`, git(worktreeA, ["symbolic-ref", "--short", "HEAD"]));
    check("the worktree for task A has HEAD == the real remote head (not the stale ref)",
      git(worktreeA, ["rev-parse", "HEAD"]) === remoteHead(source.remote) &&
      git(worktreeA, ["rev-parse", "HEAD"]) !== sourceSeed.staleRef,
      JSON.stringify({ head: git(worktreeA, ["rev-parse", "HEAD"]), remote: remoteHead(source.remote), stale: sourceSeed.staleRef }));
    check("the worktree for task A is registered in the source repository",
      worktreeRealPaths(source.dir).includes(realpathSync(worktreeA)), JSON.stringify(worktreePaths(source.dir)));
    const plainLink = join(intentA.taskDir, intentA.directories[0].linkName);
    check("the plain directory is linked into the task as a real symlink to the registered path",
      lstatSync(plainLink).isSymbolicLink() && realpathSync(plainLink) === realpathSync(docsDir),
      `${plainLink} -> ${readlinkSync(plainLink)}`);

    const sourceAfterA = repoFacts(source.dir);
    check("task A's creation did NOT move the source checkout HEAD or its branch",
      sourceAfterA.head === sourceFactsBefore.head && sourceAfterA.branch === "main" &&
      sourceAfterA.commitCount === sourceFactsBefore.commitCount,
      JSON.stringify({ before: sourceFactsBefore.head, after: sourceAfterA.head }));
    check("task A's creation left the source checkout's uncommitted work exactly where the user left it",
      sourceAfterA.status === sourceFactsBefore.status &&
      readFileSync(join(source.dir, "README.md"), "utf8").includes("本地未提交修改") &&
      readFileSync(join(source.dir, "WIP-note.md"), "utf8") === "未提交的本地工作\n",
      sourceAfterA.status);
    check("task A's creation added ONLY the local task branch to the source repository",
      sourceAfterA.localRefs === `${sourceFactsBefore.localRefs}\nrefs/heads/task/${taskIdA} ${remoteHead(source.remote)}` ||
      (sourceAfterA.localRefs.split("\n").length === 2 && sourceAfterA.localRefs.includes(`refs/heads/task/${taskIdA} ${remoteHead(source.remote)}`) &&
        sourceAfterA.localRefs.includes(`refs/heads/main ${sourceFactsBefore.head}`)),
      sourceAfterA.localRefs);
    check("task A's creation created no new remote-tracking ref and no remote branch",
      sourceAfterA.remoteRefNames === sourceFactsBefore.remoteRefNames &&
      remoteRefsOf(source.remote) === remoteRefsBefore,
      JSON.stringify({ tracking: sourceAfterA.remoteRefNames, remote: remoteRefsOf(source.remote) }));

    const invocationsA = gitInvocations();
    check("the PATH git shim really logged the creation's own git invocations",
      invocationsA.some((args) => args[0] === "worktree" && args[1] === "add") &&
      invocationsA.some((args) => args[0] === "fetch"), JSON.stringify(invocationsA.slice(0, 40)));
    check("the creation never invoked `git push` (PATH shim log)",
      invocationsA.every((args) => args[0] !== "push"), JSON.stringify(invocationsA.filter((args) => args[0] === "push")));

    const factsFlatA = flat(await factsBody());
    check("task A's facts badge the row as an independent Git worktree",
      factsFlatA.split("独立 Git worktree (隔离副本)").length - 1 === 1, factsFlatA.slice(0, 900));
    check("task A's facts name the worktree target path, the task branch and the pinned base commit",
      factsFlatA.includes(`目标检出路径: ${worktreeA}`) && factsFlatA.includes(`任务分支 task/${taskIdA}`) &&
      factsFlatA.includes(`工作分支 task/${taskIdA}（实测）`) && factsFlatA.includes(`基线 main @ ${remoteHead(source.remote)}`),
      factsFlatA.slice(0, 1200));
    check("task A's facts name the `来源检出` real path of the original repository",
      factsFlatA.includes(`来源检出 ${realpathSync(source.dir)}`), factsFlatA.slice(0, 1200));
    check("task A's facts draw the plain directory as a shared original, not a copy",
      factsFlatA.includes("普通目录 · 共享原文件") && factsFlatA.includes(`本地真实路径: ${docsDir}`) &&
      factsFlatA.includes("非隔离副本，共享原文件"), factsFlatA.slice(0, 1200));
    const pillsA = await factPills();
    check("every source of task A verifies as 已核验", pillsA.length === 2 &&
      pillsA.every((row) => String(row.pill).startsWith("已核验")), JSON.stringify(pillsA));
    await settleFocus();
    await capture("task-facts-worktree-a", 1440, 900);
    await capture("task-facts-worktree-a", 720, 560);
    await sizeTo(1440, 900);

    // ---------------------------------------- session entry: no Provider configured
    stage = "session entry provider requirement";
    const requirement = await (async () => {
      for (let i = 0; i < 200; i++) { const value = await providerRequirement(); if (value !== null) return value; await wait(100); }
      throw Error(`no provider requirement banner after creation :: ${(await text()).replace(/\n+/g, " | ").slice(-1200)}`);
    })();
    check("the created task's `main` conversation entry is the active tab", (await mainTab()) === "main", String(await mainTab()));
    check("the session entry names the missing Provider configuration explicitly",
      requirement.includes("尚未配置可用的 Provider / 模型") && requirement.includes("未配置"), requirement.slice(0, 800));
    check("the session entry says the app will not choose or call a model on its own",
      requirement.includes("不会自动选择或调用模型"), requirement.slice(0, 800));
    check("the session entry routes to 能力管理 → Providers",
      requirement.includes("能力管理 → Providers") && requirement.includes("前往能力管理 · Providers"), requirement.slice(0, 800));
    check("no model was selected: the composer names 未配置模型 instead of a profile",
      (await composerModel()) === "未配置模型", String(await composerModel()));
    const providerState = providerProfiles.list();
    check("main holds no Provider profile and no selection for this task",
      providerState.profiles.length === 0 && providerState.selections.length === 0 &&
      providerProfiles.selection(taskIdA) === null, JSON.stringify(providerState));
    check("no turn was started: main routed no task/sendMessage for this task",
      ops.every((entry) => entry.op !== "task/sendMessage"), JSON.stringify(ops.filter((entry) => entry.op === "task/sendMessage")));
    check("no SDK turn op was routed at all", ops.every((entry) => entry.op !== "task/sdkTurn"),
      JSON.stringify(ops.map((entry) => entry.op)));
    await scrollConversationIntoView();
    await settleFocus();
    await sizeTo(1440, 900);
    // The route really lands on 能力管理 · Providers, captured as its own state.
    stage = "provider route";
    await clickLabelled("前往能力管理");
    const routed = await until((body) => body.includes("模型与 Provider") && body.includes("能力管理"), "capabilities providers page");
    check("the requirement's button really routes to 能力管理 · Providers",
      routed.includes("模型与 Provider"), flat(routed).slice(0, 600));
    await settleFocus();
    await capture("capabilities-providers-route", 1440, 900);
    await capture("capabilities-providers-route", 720, 560);
    await sizeTo(1440, 900);

    // ------------------------------------------------- REAL creation of task B
    stage = "S02 for task B";
    const formB = await enterS02();
    check("the reopened S02 dialog starts empty again", (await inputValueAt("任务名称")) === "", String(await inputValueAt("任务名称")));
    check("the reopened S02 dialog still defaults to 独立 Worktree（默认）",
      JSON.stringify((await modeState()).map((row) => [row.value, row.checked])) ===
      JSON.stringify([["worktree", true], ["existing-git", false], ["plain-dirs", false]]), JSON.stringify(await modeState()));
    check("the S02 form really re-read the same single Git source", formB.includes("task-repo"));
    await checkSource("task-repo");
    await typeAt("远程名称", "origin", 0);
    await typeAt("远程分支", "main", 0);
    await checkSource("docs");
    check("the shared-write confirmation is required again for task B", (await sharedWriteConfirmed()) === true);
    await typeAt("任务名称", TASK_B);
    await clickLabelled("固定基线并预览路径", true);
    await until((body) => body.includes("任务路径预览 · " + TASK_B) && body.includes("任务工作区模式：独立 Worktree（默认）"), "task B preview");
    const intentB = creation.current();
    if (!intentB || intentB.workspaceMode !== "worktree") throw Error(`main holds no worktree intent for B: ${JSON.stringify(intentB)}`);
    check("task B gets a different task folder and a different task branch than task A",
      intentB.taskId !== taskIdA && intentB.taskDir !== intentA.taskDir && intentB.branch === `task/${intentB.taskId}` &&
      intentB.branch !== intentA.branch,
      JSON.stringify({ taskId: intentB.taskId, branch: intentB.branch, a: intentA.branch }));
    check("task B's pinned base is the same real remote head as task A", intentB.repos[0].commit === remoteHead(source.remote));
    stage = "worktree commit B";
    await clickLabelled("确认创建 / 恢复", true);
    await until((body) => !body.includes("任务路径预览") && body.includes("任务工作区访问来源") &&
      body.includes(TASK_B) && body.includes("独立 Worktree"), "facts after task B creation");
    const taskIdB = intentB.taskId;
    check("task B is really in the task-root inventory", inventoryTaskIds().includes(taskIdB), JSON.stringify(inventoryTaskIds()));
    const recordB = recordOf(taskIdB);
    check("task B wrote a worktree-mode record on its own task branch",
      recordB.record?.workspaceMode === "worktree" && recordB.record?.branch === `task/${taskIdB}`,
      JSON.stringify({ mode: recordB.record?.workspaceMode, branch: recordB.record?.branch }));
    const worktreeB = join(intentB.taskDir, (recordB.record?.repoSources ?? [])[0].repoDir);
    check("task B's worktree path differs from task A's", realpathSync(worktreeB) !== realpathSync(worktreeA),
      JSON.stringify({ a: worktreeA, b: worktreeB }));
    check("task B's worktree is really on task/<idB> with the same pinned base",
      git(worktreeB, ["symbolic-ref", "--short", "HEAD"]) === `task/${taskIdB}` &&
      git(worktreeB, ["rev-parse", "HEAD"]) === remoteHead(source.remote),
      JSON.stringify({ branch: git(worktreeB, ["symbolic-ref", "--short", "HEAD"]), head: git(worktreeB, ["rev-parse", "HEAD"]) }));
    const listedAB = worktreeRealPaths(source.dir);
    check("`git worktree list` shows the source checkout plus BOTH task worktrees",
      listedAB.length === 3 && listedAB.includes(realpathSync(worktreeA)) && listedAB.includes(realpathSync(worktreeB)),
      JSON.stringify(worktreePaths(source.dir)));
    const factsFlatB = flat(await factsBody());
    check("task B's facts are distinct from task A's (own target path + own task branch)",
      factsFlatB.includes(`目标检出路径: ${worktreeB}`) && factsFlatB.includes(`任务分支 task/${taskIdB}`) &&
      !factsFlatB.includes(taskIdA) && factsFlatB.includes(`来源检出 ${realpathSync(source.dir)}`), factsFlatB.slice(0, 1200));
    check("task B's creation added only its own local task branch",
      repoFacts(source.dir).localRefs.includes(`refs/heads/task/${taskIdB}`) &&
      repoFacts(source.dir).localRefs.includes(`refs/heads/task/${taskIdA}`),
      repoFacts(source.dir).localRefs);
    check("task B's creation still created no remote ref and pushed nothing",
      remoteRefsOf(source.remote) === remoteRefsBefore &&
      gitInvocations().every((args) => args[0] !== "push"),
      JSON.stringify({ remote: remoteRefsOf(source.remote), pushes: gitInvocations().filter((args) => args[0] === "push") }));
    check("the source checkout's HEAD/status are still untouched after task B",
      repoFacts(source.dir).head === sourceFactsBefore.head && repoFacts(source.dir).status === sourceFactsBefore.status);
    await settleFocus();
    await capture("task-facts-worktree-b", 1440, 900);
    await capture("task-facts-worktree-b", 720, 560);
    await sizeTo(1440, 900);

    // ---------------------------------- CONCURRENT creation of tasks C and D
    stage = "concurrent C/D";
    // One app instance's creation service is a single queue over a single intent
    // store, so two SIMULTANEOUS creations cannot be represented by it (the UI
    // serializes). The concurrency assertion is therefore driven through
    // `performCreationOperation` — the exact function behind `shell/createTask` —
    // on a second real `ProjectTaskCreation` with its own intent store but the
    // SAME production `WorktreeMetadataLock` on the same app data dir, the way two
    // app instances on one profile share the repository-level lock. Both commits
    // are issued together.
    const profileConcurrent = join(root, "profile-concurrent");
    mkdirSync(profileConcurrent, { recursive: true });
    const creationConcurrent = new ProjectTaskCreation(new CreationIntentStore(profileConcurrent), projects, index, registry, taskRoot, undefined, lock);
    const sourceId = project.repositories[0].id;
    const requestFor = (name) => ({ projectId, name,
      repositories: [{ sourceId, remote: "origin", remoteBranch: "main" }],
      directoryIds: [], sharedWriteConfirmed: false, override: false });
    const preparedOf = async (service, name) => {
      const raw = await performCreationOperation(service, { op: "prepare", input: requestFor(name) }, async () => null, () => undefined);
      const result = /** @type {{ canceled: boolean; intent: { id: string; taskId: string; taskDir: string; branch: string; workspaceMode: string; name: string; directories: { linkName: string }[]; repos: { commit: string }[] } }} */ (raw);
      if (result.canceled) throw Error("concurrent prepare was canceled");
      return result.intent;
    };
    const intentC = await preparedOf(creation, TASK_C);
    const intentD = await preparedOf(creationConcurrent, TASK_D);
    check("both concurrent intents are pending, distinct tasks with distinct branches",
      intentC.taskId !== intentD.taskId && intentC.taskDir !== intentD.taskDir && intentC.branch !== intentD.branch,
      JSON.stringify({ c: intentC.taskId, d: intentD.taskId, cBranch: intentC.branch, dBranch: intentD.branch }));
    const remoteRefsBeforeCD = remoteRefsOf(source.remote);
    const settled = await Promise.allSettled([
      performCreationOperation(creation, { op: "commit", id: intentC.id }, async () => null, () => undefined),
      performCreationOperation(creationConcurrent, { op: "commit", id: intentD.id }, async () => null, () => undefined),
    ]);
    const outcomes = [
      { label: "C", intent: intentC, result: settled[0] },
      { label: "D", intent: intentD, result: settled[1] },
    ];
    const fulfilled = outcomes.filter((entry) => entry.result.status === "fulfilled");
    const rejected = outcomes.filter((entry) => entry.result.status === "rejected");
    const concurrencyOutcome = fulfilled.length === 2 ? "both-committed" : fulfilled.length === 1 ? "named-lock-refusal" : "both-refused";
    // Whatever happened, git's own metadata must still parse and the source must be intact.
    const listedAfterConcurrent = worktreeRealPaths(source.dir); // throws if the metadata is corrupt
    check("concurrent creation never corrupted the source repository's worktree metadata",
      listedAfterConcurrent.length >= 3 && git(source.dir, ["rev-parse", "--verify", "HEAD"]).length === 40,
      JSON.stringify(listedAfterConcurrent));
    check("concurrent creation pushed nothing and added no remote ref",
      remoteRefsOf(source.remote) === remoteRefsBeforeCD, remoteRefsOf(source.remote));
    check("the source checkout's HEAD/status survived the concurrent creation",
      repoFacts(source.dir).head === sourceFactsBefore.head && repoFacts(source.dir).status === sourceFactsBefore.status);
    const concurrentRecords = {};
    for (const entry of fulfilled) {
      const record = recordOf(entry.intent.taskId);
      concurrentRecords[entry.label] = { taskId: entry.intent.taskId, taskDir: entry.intent.taskDir, branch: entry.intent.branch,
        sha256: record.sha256, baseCommit: (record.record?.repoSources ?? [])[0]?.baseCommit,
        targetRealPath: (record.record?.repoSources ?? [])[0]?.targetRealPath };
      const worktree = join(entry.intent.taskDir, (record.record?.repoSources ?? [])[0].repoDir);
      check(`concurrent task ${entry.label} really succeeded with its own worktree on task/<id>`,
        existsSync(worktree) && git(worktree, ["symbolic-ref", "--short", "HEAD"]) === `task/${entry.intent.taskId}` &&
        git(worktree, ["rev-parse", "HEAD"]) === remoteHead(source.remote) &&
        listedAfterConcurrent.includes(realpathSync(worktree)),
        JSON.stringify({ worktree, branch: git(worktree, ["symbolic-ref", "--short", "HEAD"]) }));
      check(`concurrent task ${entry.label}'s record pins the real remote head`,
        (record.record?.repoSources ?? [])[0]?.baseCommit === remoteHead(source.remote), JSON.stringify(record.record?.repoSources));
    }
    for (const entry of rejected) {
      const reason = /** @type {{ message?: string }} */ (/** @type {unknown} */ (entry.result)).message;
      const message = String(reason ?? entry.result.status);
      check(`concurrent task ${entry.label} was refused BY NAME with the repository-lock refusal`,
        /worktree-locked: /.test(message) && /本次操作未创建任何分支、工作副本或记录/.test(message), message);
      check(`the refused concurrent task ${entry.label} created no record, branch or worktree`,
        !existsSync(join(entry.intent.taskDir, "task.json")) &&
        git(source.dir, ["branch", "--list", `task/${entry.intent.taskId}`]) === "" &&
        !listedAfterConcurrent.some((path) => path.startsWith(realpathSync(entry.intent.taskDir))),
        JSON.stringify({ branch: git(source.dir, ["branch", "--list", `task/${entry.intent.taskId}`]) }));
    }
    if (fulfilled.length === 2) {
      const [left, right] = fulfilled;
      check("both concurrent tasks succeeded with DIFFERENT worktree paths and DIFFERENT task branches",
        concurrentRecords[left.label].targetRealPath !== concurrentRecords[right.label].targetRealPath &&
        concurrentRecords[left.label].branch !== concurrentRecords[right.label].branch,
        JSON.stringify(concurrentRecords));
      check("`git worktree list` now shows the source checkout plus all four task worktrees",
        listedAfterConcurrent.length === 5, JSON.stringify(listedAfterConcurrent));
      check("every task branch really points at the fetched remote head",
        git(source.dir, ["for-each-ref", "--format=%(objectname)", `refs/heads/task/${taskIdA}`, `refs/heads/task/${taskIdB}`,
          `refs/heads/task/${intentC.taskId}`, `refs/heads/task/${intentD.taskId}`]).split("\n").every((sha) => sha === remoteHead(source.remote)),
        git(source.dir, ["for-each-ref", "--format=%(objectname)", "refs/heads/task/"]));
    }
    check("the concurrent creation never invoked `git push` (PATH shim log)",
      gitInvocations().every((args) => args[0] !== "push"), JSON.stringify(gitInvocations().filter((args) => args[0] === "push")));

    console.log("T07_DEBUG_CONCURRENCY=" + JSON.stringify({ concurrencyOutcome,
      results: outcomes.map((entry) => ({ label: entry.label, status: entry.result.status,
        error: entry.result.status === "rejected"
          ? String(/** @type {{ message?: string }} */ (/** @type {unknown} */ (entry.result)).message ?? "refused") : null })),
      inventory: inventoryTaskIds(), records: Object.keys(concurrentRecords) }));
    // The renderer loaded the workspace inventory when it booted; C and D were created
    // out of band through the IPC path, so a real renderer reload re-reads the task root
    // (nothing seeded: the same product page, the same main-owned stores).
    stage = "workspace ledger";
    await evalJs("(() => { location.reload(); return true; })()");
    await wait(600);
    await until((body) => body.includes(PROJECT_NAME) || body.includes("未归属任务"), "shell boot after reload");
    await enterWorkspace();
    const createdNames = [TASK_A, TASK_B, TASK_C, TASK_D].filter((name) =>
      name === TASK_C || name === TASK_D ? fulfilled.some((entry) => entry.intent.taskId && entry.intent.name === name) : true);
    const ledgerText = await until((body) => createdNames.every((name) => body.includes(name)), `workspace ledger with ${createdNames.length} tasks`);
    if (concurrencyOutcome === "both-committed") {
      check("the workspace ledger lists all four real tasks and the task root holds them",
        [TASK_A, TASK_B, TASK_C, TASK_D].every((name) => ledgerText.includes(name)) && inventoryTaskIds().length === 4,
        JSON.stringify(inventoryTaskIds()));
    }
    await settleFocus();
    await capture("workspace-task-ledger", 1440, 900);
    await capture("workspace-task-ledger", 720, 560);
    await sizeTo(1440, 900);

    // ------------------------------------------ reopen: same bindings, no rewrite
    stage = "reopen A";
    await enterTask(TASK_A);
    await untilFactsLoaded();
    const reopenedA = flat(await factsBody());
    check("reopening task A re-reads the same 独立 Worktree badge", (await factsMode()) === "独立 Worktree", String(await factsMode()));
    check("reopening task A keeps the same worktree path, task branch and pinned base",
      reopenedA.includes(`目标检出路径: ${worktreeA}`) && reopenedA.includes(`任务分支 task/${taskIdA}`) &&
      reopenedA.includes(`基线 main @ ${remoteHead(source.remote)}`) && reopenedA.includes(`来源检出 ${realpathSync(source.dir)}`),
      reopenedA.slice(0, 1200));
    check("reopening task A keeps the same two verified sources", (await factPills()).length === 2 &&
      (await factPills()).every((row) => String(row.pill).startsWith("已核验")), JSON.stringify(await factPills()));
    check("reopening task A did not rewrite its task record", recordOf(taskIdA).sha256 === recordA.sha256,
      `${recordA.sha256} -> ${recordOf(taskIdA).sha256}`);
    await scrollContentTop();
    await settleFocus();
    await capture("task-facts-worktree-a-reopen", 1440, 900);
    await capture("task-facts-worktree-a-reopen", 720, 560);
    await sizeTo(1440, 900);

    stage = "reopen B";
    await enterTask(TASK_B);
    await untilFactsLoaded();
    const reopenedB = flat(await factsBody());
    check("reopening task B re-reads its own worktree path and its own task branch",
      reopenedB.includes(`目标检出路径: ${worktreeB}`) && reopenedB.includes(`任务分支 task/${taskIdB}`) &&
      !reopenedB.includes(taskIdA), reopenedB.slice(0, 1200));
    check("reopening task B keeps the same pinned base and source checkout",
      reopenedB.includes(`基线 main @ ${remoteHead(source.remote)}`) && reopenedB.includes(`来源检出 ${realpathSync(source.dir)}`),
      reopenedB.slice(0, 1200));
    check("reopening task B did not rewrite its task record", recordOf(taskIdB).sha256 === recordB.sha256,
      `${recordB.sha256} -> ${recordOf(taskIdB).sha256}`);
    await scrollContentTop();
    await settleFocus();
    await capture("task-facts-worktree-b-reopen", 1440, 900);
    await capture("task-facts-worktree-b-reopen", 720, 560);
    await sizeTo(1440, 900);

    stage = "pre-restart reference";
    await enterTask(TASK_A);
    await untilFactsLoaded();
    await scrollContentTop();
    await settleFocus();
    await capture("task-facts-worktree-a-before-restart", 1440, 900);
    await capture("task-facts-worktree-a-before-restart", 720, 560);
    await sizeTo(1440, 900);

    // The shim must not leak into the restart process.
    shimLog = gitInvocations();
    removeGitShim();
    shim = null;

    let revision = "unknown"; let trackedFilesDirty = "unknown";
    try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: repoRoot }).trim(); } catch { /* recorded as unknown */ }
    try {
      const excluded = relative(repoRoot, output);
      const args = ["status", "--porcelain", "--untracked-files=no", "--", "."];
      if (excluded && !excluded.startsWith("..") && !isAbsolute(excluded)) args.push(`:(exclude)${excluded}`);
      trackedFilesDirty = execFileSync("git", args, { encoding: "utf8", cwd: repoRoot }).trim() ? "true" : "false";
    } catch { /* recorded as unknown */ }

    expectA = {
      taskId: taskIdA, name: TASK_A, mode: "worktree", recordSha256: recordA.sha256,
      taskDir: recordA.record.taskDir, branch: recordA.record.branch, repoDir: repoSourceA.repoDir,
      worktreeRealPath: realpathSync(worktreeA),
      baseCommit: repoSourceA.baseCommit, sourcePath: repoSourceA.sourceRealPath,
      projectRepositories: ["task-repo"],
      plainDir: { linkName: intentA.directories[0].linkName, sourcePath: docsDir },
    };
    expectB = {
      taskId: taskIdB, name: TASK_B, mode: "worktree", recordSha256: recordB.sha256,
      taskDir: recordB.record.taskDir, branch: recordB.record.branch,
      repoDir: (recordB.record?.repoSources ?? [])[0].repoDir, worktreeRealPath: realpathSync(worktreeB),
      baseCommit: (recordB.record?.repoSources ?? [])[0].baseCommit,
      sourcePath: (recordB.record?.repoSources ?? [])[0].sourceRealPath,
      projectRepositories: ["task-repo"],
      plainDir: { linkName: intentB.directories[0].linkName, sourcePath: docsDir },
    };

    // ---------------------------------------- real process restart (second OS process)
    stage = "restart process";
    const restartOut = await new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [scriptPath, "--phase", "restart", "--out", output], {
        env: { ...process.env, PIDOCK_T07_PROJECT_ID: projectId,
          PIDOCK_T07_EXPECT_A: JSON.stringify(expectA), PIDOCK_T07_EXPECT_B: JSON.stringify(expectB) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (data) => { stdout += data; process.stdout.write(`[t07-restart] ${data}`); });
      child.stderr.on("data", (data) => { stderr += data; process.stderr.write(`[t07-restart] ${data}`); });
      child.on("error", reject);
      child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    });
    check("the restart phase exited 0", restartOut.code === 0, JSON.stringify({ code: restartOut.code, stderr: restartOut.stderr.slice(-1600) }));
    const restartLog = JSON.parse(readFileSync(join(output, "restart-log.json"), "utf8"));
    check("restart process reported a different pid", restartLog.pid !== process.pid, `${process.pid} -> ${restartLog.pid}`);
    check("the restart process re-read both task records byte for byte",
      restartLog.records?.a?.sha256 === recordA.sha256 && restartLog.records?.b?.sha256 === recordB.sha256,
      JSON.stringify(restartLog.records));
    check("the restart process re-read the same workspace source",
      JSON.stringify(restartLog.workspace?.repositories) === JSON.stringify(["task-repo"]),
      JSON.stringify(restartLog.workspace?.repositories));
    check("the restart process still sees both task worktrees in the shared source repository",
      restartLog.worktrees.map((path) => realpathSync(path)).includes(realpathSync(join(expectA.taskDir, expectA.repoDir))) &&
      restartLog.worktrees.map((path) => realpathSync(path)).includes(realpathSync(join(expectB.taskDir, expectB.repoDir))),
      JSON.stringify(restartLog.worktrees));
    const restartStates = restartLog.shots.map((shot) => shot.state);
    check("the restart process rendered both tasks' facts",
      restartStates.includes("task-facts-worktree-a-after-restart") && restartStates.includes("task-facts-worktree-b-after-restart"),
      JSON.stringify(restartStates));
    // Cross-process rendering identity: the SAME view, captured by the same code with
    // focus settled, from two different OS processes over the same on-disk data.
    const restartPixelDiffs = [];
    for (const [width, height, beforeState, afterState, label] of [
      [1440, 900, "task-facts-worktree-a-before-restart", "task-facts-worktree-a-after-restart", "task A"],
      [720, 560, "task-facts-worktree-a-before-restart", "task-facts-worktree-a-after-restart", "task A"],
      [1440, 900, "task-facts-worktree-b-reopen", "task-facts-worktree-b-after-restart", "task B"],
      [720, 560, "task-facts-worktree-b-reopen", "task-facts-worktree-b-after-restart", "task B"],
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
    check("the restart process did not rewrite either task record",
      recordOf(taskIdA).sha256 === recordA.sha256 && recordOf(taskIdB).sha256 === recordB.sha256);

    // Build identity: the runtime the capture really ran in and the exact renderer
    // bundle whose pixels are in the PNGs.
    const assetsDir = join(import.meta.dirname, "..", "dist", "renderer", "assets");
    const bundles = readdirSync(assetsDir).filter((name) => /^index-.*\.(js|css)$/.test(name))
      .map((name) => ({ file: `packages/shell/dist/renderer/assets/${name}`, sha256: sha256(readFileSync(join(assetsDir, name))) }));
    const runtime = { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome,
      v8: process.versions.v8, platform: process.platform, arch: process.arch, toolingNode: process.env["T07_TOOLING_NODE"] ?? null };
    const log = {
      ticket: "#142 默认自动创建独立 worktree — real Electron evidence (T07)",
      command, repoRoot, revision, trackedFilesDirty, runtime, bundles,
      generatedBy: "scripts/electron-pencil-v1-t07-capture.mjs",
      phase: "primary",
      pid: process.pid,
      seeded: {
        registry: "ProjectRegistry.create (real projects.json under isolated userData)",
        project: { id: projectId, name: PROJECT_NAME, repositories: ["task-repo"], directories: ["docs"] },
        source: { path: source.dir, remote: source.remote, localHead: sourceFactsBefore.head,
          remoteHead: remoteHead(source.remote), staleTrackingRef: sourceSeed.staleRef,
          uncommitted: sourceFactsBefore.status.split("\n") },
        docs: docsDir,
        tasks: "A and B were created through the product UI (S02 dialog → shell/createTask → main commit → Host provision); C and D were driven through `performCreationOperation` (the function behind `shell/createTask`) because one app instance's queue cannot represent two simultaneous creations; no task record was seeded",
      },
      defaultForm: {
        driven: "S02 dialog opened from 项目管理 → 任务; the mode radios were READ, never clicked; one Git source + one plain directory typed in",
        modes: defaultModes.map((row) => ({ value: row.value, checked: row.checked, disabled: row.disabled })),
        preview: { taskId: intentA.taskId, taskDir: intentA.taskDir, branch: intentA.branch, mode: intentA.workspaceMode,
          repos: intentA.repos.map((repo) => ({ name: repo.name, path: repo.path, remote: repo.remote, remoteBranch: repo.remoteBranch,
            pinnedCommit: repo.commit, repoDir: repo.repoDir })),
          directories: intentA.directories.map((dir) => ({ name: dir.name, path: dir.path, linkName: dir.linkName })) },
      },
      createA: {
        taskId: taskIdA, name: TASK_A, taskDir: recordA.record.taskDir, branch: recordA.record.branch,
        recordSha256: recordA.sha256, record: { workspaceMode: recordA.record.workspaceMode, branchKind: recordA.record.branchKind,
          repos: recordA.record.repos, repoSources: recordA.record.repoSources, dirLinks: recordA.record.dirLinks },
        worktree: { path: worktreeA, head: git(worktreeA, ["rev-parse", "HEAD"]), branch: git(worktreeA, ["symbolic-ref", "--short", "HEAD"]),
          realPath: realpathSync(worktreeA) },
        remoteHead: remoteHead(source.remote), staleTrackingRef: sourceSeed.staleRef,
        sourceBefore: sourceFactsBefore, sourceAfter: sourceAfterA,
        plainLink: { path: plainLink, target: readlinkSync(plainLink), realPath: realpathSync(plainLink) },
        gitInvocations: invocationsA.map((args) => args.join(" ")),
      },
      createB: {
        taskId: taskIdB, name: TASK_B, taskDir: recordB.record.taskDir, branch: recordB.record.branch,
        recordSha256: recordB.sha256, worktree: { path: worktreeB, realPath: realpathSync(worktreeB),
          head: git(worktreeB, ["rev-parse", "HEAD"]), branch: git(worktreeB, ["symbolic-ref", "--short", "HEAD"]) },
        worktreeList: worktreePaths(source.dir),
      },
      concurrency: {
        outcome: concurrencyOutcome,
        driven: "two real ProjectTaskCreation services (separate intent stores, one shared production WorktreeMetadataLock on the same app data dir); both prepare calls issued, then both commit calls together through performCreationOperation",
        intents: [{ label: "C", taskId: intentC.taskId, taskDir: intentC.taskDir, branch: intentC.branch },
          { label: "D", taskId: intentD.taskId, taskDir: intentD.taskDir, branch: intentD.branch }],
        results: outcomes.map((entry) => ({ label: entry.label, status: entry.result.status,
          error: entry.result.status === "rejected"
          ? String(/** @type {{ message?: string }} */ (/** @type {unknown} */ (entry.result)).message ?? "refused") : null })),
        records: concurrentRecords,
        worktrees: listedAfterConcurrent,
        remoteRefsUnchanged: remoteRefsOf(source.remote) === remoteRefsBeforeCD,
      },
      providerEntry: {
        taskId: taskIdA, session: "main", requirement,
        composerModel: "未配置模型",
        profiles: providerState.profiles.length, selections: providerState.selections.length,
        routedOps: ops, startedTurns: ops.filter((entry) => entry.op === "task/sendMessage").length,
        routeAsserted: "clicked 前往能力管理 · Providers and the page showed 模型与 Provider",
      },
      reopen: { a: { recordSha256: recordA.sha256, reopenedSha256: recordOf(taskIdA).sha256 },
        b: { recordSha256: recordB.sha256, reopenedSha256: recordOf(taskIdB).sha256 } },
      restart: {
        kind: "real OS process restart of the capture harness wiring (still not dist/main/main.js lifecycle)",
        pidBefore: process.pid, pidAfter: restartLog.pid,
        records: restartLog.records, workspace: restartLog.workspace, worktrees: restartLog.worktrees,
        screenshotComparison: restartPixelDiffs, shots: restartLog.shots, assertions: restartLog.assertions,
      },
      gitShimLog: shimLog.map((args) => args.join(" ")),
      assertions,
      shots,
    };
    writeFileSync(join(output, "capture-log.json"), `${JSON.stringify(log, null, 2)}\n`);
    for (const shot of shots) console.log("T07_CAPTURE=" + JSON.stringify({ state: shot.state, file: shot.file, sha256: shot.sha256 }));
    console.log("T07_CAPTURE_LOG=" + JSON.stringify({ revision, trackedFilesDirty, shots: shots.map((shot) => shot.file),
      restartShots: restartLog.shots.map((shot) => shot.file), taskIdA, taskIdB, concurrencyOutcome, assertions: assertions.length }));
  } catch (error) {
    console.error(`T07_CAPTURE_FAILED [${phase}]`, stage, error);
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    try {
      if (shim) {
        if (savedPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = savedPath;
      }
    } catch { /* PATH restore is best effort at teardown */ }
    const cleanupFailures = await shutdownTestRegistry(registry, {
      origin: views ? { kind: "shell-ui", senderWebContentsId: views.shellView.webContents.id } : undefined,
      label: `PencilV1 T07 capture cleanup (${phase})`,
    });
    for (const child of children) child.kill();
    if (views?.shellView.webContents.debugger.isAttached()) views.shellView.webContents.debugger.detach();
    views?.window.destroy();
    if (phase !== "restart") rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    if (cleanupFailures.length) { console.error(`T07_CAPTURE_CLEANUP_FAILED [${phase}] ` + JSON.stringify(cleanupFailures)); process.exitCode = process.exitCode ?? 1; }
    exitNow(process.exitCode ?? 0, "done");
  }
}
void run();
