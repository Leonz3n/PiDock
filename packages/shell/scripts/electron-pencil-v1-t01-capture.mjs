// [PiDock pencil-v1 / T01] (#136) real-Electron evidence for the S07 workspace
// overview, S10 create/edit dialog, 未归属任务 view and the delete-blocker dialog.
//
// Run after `pnpm --filter @pidock/shell build`:
//   pnpm --filter @pidock/shell exec electron scripts/electron-pencil-v1-t01-capture.mjs \
//     --out docs/evidence/pencil-v1-t01
//
// Like `electron-issue41-project-registry-capture.mjs` it boots the compiled production
// runtime modules directly (not `dist/main/main.js`) with the production wiring decisions
// (`createTrustedWindow("...", "production")` + `registerIpc` over a real
// `TaskRootIndex`/`ProjectRegistry`/`PerTaskHostRegistry`, the real
// `ProjectTaskCreation`/`ProviderWiring` and the real `ServiceCatalog` that
// `main.ts` also passes) and the built React renderer (`dist/renderer/index.html`,
// no fixture entry, no Vite/dev override). It does NOT run `dist/main/main.js`, so app
// lifecycle, window-evidence asserts and the schedule driver stay out of the capture.
//
// Seeded through the real API only: `ProjectRegistry.create` writes projects.json under
// the isolated userData, `ProjectRegistry.claim` writes the membership, and the task
// records are written with the production `task-store` serializer (there is no
// renderer-free "create task" API in this checkout). One registered repository
// directory is deleted AFTER registration, so `verifyProjectSources` really reports
// `missing` and the S07 card draws its 来源缺失 badge — no injected failure.
//
// Ticketed states captured at 1440x900 and 720x560:
//   (a) S07 workspace overview, 3 sources, one deliberately missing
//   (b) S10 新建工作空间 dialog (opened over the S07 overview)
//   (c) 未归属任务 with a claimable task
//   (d) edit dialog opened from the real saved workspace (repair affordance visible)
//   (e) delete-blocker dialog naming the two blocking tasks
//   (f) a REAL create submission typed into the S10 dialog (empty-name refusal first,
//       then the full draft and the post-save S07 overview of the new workspace)
//   (g) a REAL edit submission that renames that workspace, with the registry id read
//       from `ProjectRegistry` before/after to show the rename kept the identity
//   (h) the pre-restart reference capture that the restart phase is compared against
//
// (f)/(g) are the only phases that write through the UI. (f) first clicks the primary
// button with an empty name: that attempt must be refused inline and must not touch
// the registry (the project id list is compared before/after), so no junk workspace is
// left behind. Only then is the name typed and the real submission made.
//
// Restart proof: after the primary phase the script spawns a SECOND Electron OS
// process (`--phase restart`) that boots the same production wiring over the SAME
// on-disk registry/task-root files with fresh `ProjectRegistry`/`TaskRootIndex`
// instances, asserts the same workspace id/name, source ids and associations, and
// captures `workspace-overview-after-restart`. That is a real process restart of the
// capture harness (still not `dist/main/main.js` lifecycle); the README says so.
//
// Hang discipline: the deadline timer and the uncaught-error handlers are armed before the
// compiled `dist` graph is imported (dynamically, inside the guarded region), so a stuck
// import cannot outlive the watchdog, and no failure ever leaves Electron running.
import { app, utilityProcess } from "electron";
import { createUnavailableHostClient } from "./unavailable-host-client.mjs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { shutdownTestRegistry } from "./shutdown-test-registry.mjs";

// The dev-server override is inadmissible evidence: clear it before boot so this
// capture can only ever load the packaged `file://` renderer.
delete process.env["PIDOCK_RENDERER_URL"];
delete process.env["PIDOCK_TASK_URL"];
if (process.env["PIDOCK_RENDERER_URL"]) throw Error("PIDOCK_RENDERER_URL survived the clear");

const scriptPath = resolve(import.meta.dirname, "electron-pencil-v1-t01-capture.mjs");
const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const argValue = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const phase = argValue("--phase") ?? "primary";
const outArg = argValue("--out") ?? "docs/evidence/pencil-v1-t01";
const output = isAbsolute(outArg) ? outArg : resolve(repoRoot, outArg);
const command = "pnpm --filter @pidock/shell exec electron scripts/electron-pencil-v1-t01-capture.mjs --out docs/evidence/pencil-v1-t01";
// A fixed (not random) temp root keeps the captured source paths stable, so a re-run at
// the same revision renders byte-identical PNGs. Isolated under the OS temp dir.
const root = join(tmpdir(), "pidock-pencil-v1-t01-capture");
// The registry/task-root files every phase reads. The restart phase points Chromium at
// its own userData (`profile-restart`) so the OS-level Chromium profile singleton does
// not collide, while the main-owned stores are re-instantiated over THIS directory.
const profile = join(root, "profile");
const taskRoot = join(root, "tasks");
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
  console.error(`T01_CAPTURE_EXIT ${phase}`, code, why);
  try { app.exit(code); } catch { process.exit(code); }
};
const watchdog = setTimeout(() => exitNow(1, "watchdog timeout"), 240000);
process.on("uncaughtException", (error) => exitNow(1, `uncaughtException ${error?.stack ?? error}`));
process.on("unhandledRejection", (error) => {
  const stack = /** @type {{ stack?: string } | null | undefined} */ (error)?.stack;
  exitNow(1, `unhandledRejection ${stack ?? error}`);
});
// Test-only guard: a noop listener suppresses Electron's default quit on
// window-all-closed, which would race the explicit app.exit(process.exitCode).
app.on("window-all-closed", () => {});

const FINAL = "feature/{task-name}";
const now = "2026-11-03T10:00:00.000Z";
const PROJECT_NAME = "Adder 结算工作台";
const PROJECT_DESCRIPTION = "对账与运单服务的日常开发工作台";
const MISSING_REPO_NAME = "legacy-bff";
// The workspace (f) creates through the DOM and (g) renames through the DOM.
const SAVE_NAME = "验收工作空间";
const SAVE_RENAMED = "验收工作空间·改名";
const SAVE_DESCRIPTION = "保存流程验收：真实新建与改名";
const SAVE_TEMPLATE = "evidence/{task-name}";
const SAVE_ENV = { key: "SAVE_CHECK", value: "1" };
const DEMO_LEAK = /Atlas Web|演示任务|演示统计|演示数据|项目映射未建立|真实任务创建尚未接入|示例工作空间/;

const shotFile = (width, height, state) => `${width}x${height}-${state}.png`;

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
  const { buildTaskDiskRecord, serializeTaskRecord } = await import("../dist/host/task-store.js");
  const { buildHostEnv } = await import("../dist/host/host-guards.js");
  const { TaskRootIndex } = await import("../dist/main/task-root-index.js");
  const { ProjectRegistry } = await import("../dist/main/project-registry.js");
  const { ServiceCatalog, serviceCatalogAuthority } = await import("../dist/main/service-catalog.js");
  const { createTrustedWindow, loadTrustedViews, PerTaskHostRegistry, registerIpc } = await import("../dist/main/runtime.js");
  const { CreationIntentStore, ProjectTaskCreation } = await import("../dist/main/project-task-creation.js");
  const { ProviderProfileStore } = await import("../dist/main/provider-profile-store.js");
  const { ProviderWiring } = await import("../dist/main/provider-ipc.js");
  const { HostClient } = await import("../dist/rpc/host-client.js");
  const { verifyProjectSources } = await import("../dist/main/project-sources.js");

  const writeTask = (taskId, name) => {
    const taskDir = join(taskRoot, taskId);
    mkdirSync(taskDir, { recursive: true });
    execFileSync("git", ["init", "-q", taskDir]);
    writeFileSync(join(taskDir, "task.json"), serializeTaskRecord(buildTaskDiskRecord({
      taskId, name, dirId: taskId, branch: "main", root: taskRoot, taskDir,
      remoteBranch: "main", baseCommit: "test", repos: [], now,
    })));
    return taskDir;
  };
  // The persisted identity of ONE workspace, read straight out of the real registry file.
  // Shared field order so two phases can compare it with `JSON.stringify`.
  const identityOf = (targetId) => {
    const record = projects.get(targetId);
    if (!record) throw Error(`workspace ${targetId} is missing from the registry`);
    return {
      projectId: record.id,
      projectName: record.name,
      description: record.description,
      repositories: record.repositories.map((row) => ({ id: row.id, name: row.name, path: row.path })),
      directories: record.directories.map((row) => ({ id: row.id, name: row.name, path: row.path })),
      environment: record.environment,
      branchTemplate: record.branchTemplate,
    };
  };
  const readIdentity = () => {
    const record = projects.get(projectId);
    if (!record) throw Error(`workspace ${projectId} is missing from the registry`);
    return {
      projectId: record.id,
      projectName: record.name,
      description: record.description,
      repositories: record.repositories.map((row) => ({ id: row.id, name: row.name, path: row.path })),
      directories: record.directories.map((row) => ({ id: row.id, name: row.name, path: row.path })),
      environment: record.environment,
      branchTemplate: record.branchTemplate,
      associations: Object.fromEntries(["task-aaaa1111", "task-cccc3333", "task-bbbb2222"]
        .map((taskId) => [taskId, projects.association(taskId, index).state])),
    };
  };

  let projectId = "";
  try {
    if (!restart) {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      mkdirSync(profile, { recursive: true });
      mkdirSync(taskRoot, { recursive: true });
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
      stage = "seed tasks";
      writeTask("task-aaaa1111", "结算对账分页边界");
      writeTask("task-bbbb2222", "临时排查本地端口占用");
      writeTask("task-cccc3333", "运单查询服务联调");
      // Real source directories (metadata only; #39 stores validated paths, no existence check).
      const invoiceRepo = join(root, "sources", "invoice-service");
      const legacyRepo = join(root, "sources", MISSING_REPO_NAME);
      const designDir = join(root, "sources", "设计资料");
      for (const dir of [invoiceRepo, legacyRepo, designDir]) mkdirSync(dir, { recursive: true });
      writeFileSync(join(invoiceRepo, "README.md"), "# invoice-service\n\n对账单详情服务的源仓库。\n");
      writeFileSync(join(legacyRepo, "README.md"), "# legacy-bff\n\n待迁移的旧 BFF。\n");
      stage = "seed registry";
      const project = await projects.create({
        name: PROJECT_NAME,
        description: PROJECT_DESCRIPTION,
        repositories: [{ name: "invoice-service", path: invoiceRepo }, { name: MISSING_REPO_NAME, path: legacyRepo }],
        directories: [{ name: "设计资料", path: designDir }],
        environment: [
          { key: "NODE_ENV", value: "development" },
          { key: "API_BASE_URL", value: "https://api.dev.pidock.internal" },
          { key: "DEBUG", value: "pidock:*" },
        ],
        branchTemplate: FINAL,
      });
      projectId = project.id;
      // A second real workspace, so the delete dialog has an explicit transfer target.
      await projects.create({ name: "Docs 归档", description: "文档与设计资料的归档工作空间", repositories: [], directories: [] });
      await projects.claim("task-aaaa1111", project.id, index);
      await projects.claim("task-cccc3333", project.id, index);
      // Honest missing source: the directory is gone AFTER the registry accepted the path.
      rmSync(legacyRepo, { recursive: true, force: true });
      const report = await verifyProjectSources(projects.get(project.id));
      const missing = report.sources.find((row) => row.id === project.repositories.find((repo) => repo.name === MISSING_REPO_NAME).id);
      check("verifySources reports the deleted repository as missing", missing?.status === "missing", JSON.stringify(report.sources));
      check("the two other sources are really readable", report.sources.filter((row) => row.status === "ok").length === 2, JSON.stringify(report.sources));
      check("unassigned task is claimable", projects.association("task-bbbb2222", index).state === "unassigned");
      check("claimed tasks are assigned", projects.association("task-aaaa1111", index).state === "assigned" && projects.association("task-cccc3333", index).state === "assigned");
      const blockers = projects.blockers(project.id, index);
      check("two real blocking tasks for the delete dialog", blockers.tasks.length === 2, JSON.stringify(blockers));
    } else {
      projectId = process.env["PIDOCK_T01_PROJECT_ID"] ?? "";
      if (!projectId) throw Error("restart phase: PIDOCK_T01_PROJECT_ID missing");
      const expected = JSON.parse(process.env["PIDOCK_T01_EXPECT_IDENTITY"] ?? "null");
      if (!expected) throw Error("restart phase: no expected identity supplied");
      // The workspace the primary phase created AND renamed through the DOM in (f)/(g).
      const expectedSaved = JSON.parse(process.env["PIDOCK_T01_EXPECT_SAVED"] ?? "null");
      if (!expectedSaved) throw Error("restart phase: no expected saved-workspace identity supplied");
      stage = "restart identity";
      // Fresh main-owned stores over the SAME files, in a NEW OS process.
      const identity = readIdentity();
      check("workspace id survives the process restart", identity.projectId === expected.projectId, identity.projectId);
      check("workspace name/description survive the process restart",
        identity.projectName === expected.projectName && identity.description === expected.description, identity.projectName);
      check("source ids survive the process restart",
        JSON.stringify(identity.repositories) === JSON.stringify(expected.repositories) &&
        JSON.stringify(identity.directories) === JSON.stringify(expected.directories), JSON.stringify(identity.repositories));
      check("associations survive the process restart",
        JSON.stringify(identity.associations) === JSON.stringify(expected.associations), JSON.stringify(identity.associations));
      check("environment and branch template survive the process restart",
        JSON.stringify(identity.environment) === JSON.stringify(expected.environment) && identity.branchTemplate === expected.branchTemplate);
      // (f)/(g): a workspace written by the UI must be persisted, not just held in renderer state.
      const savedAfter = identityOf(expectedSaved.projectId);
      check("the workspace created through the UI survives the process restart with the same id",
        savedAfter.projectId === expectedSaved.projectId, savedAfter.projectId);
      check("the renamed name/sources/environment/template survive the process restart",
        JSON.stringify(savedAfter) === JSON.stringify(expectedSaved), JSON.stringify(savedAfter));
      writeFileSync(join(output, "restart-identity.json"), `${JSON.stringify({ before: expected, after: identity, savedBefore: expectedSaved, savedAfter }, null, 2)}\n`);
    }

    stage = "window";
    views = await createTrustedWindow(restart ? "pencil-v1-t01-restart" : "pencil-v1-t01", "production");
    const workspaceId = restart ? "pencil-v1-t01-restart" : "pencil-v1-t01";
    registry = new PerTaskHostRegistry(workspaceId, async (workspace, task) => {
      const entry = join(import.meta.dirname, "..", "dist", "host", "host-entry.js");
      const child = utilityProcess.fork(entry, [], { serviceName: `${workspaceId}-host`, env: buildHostEnv(process.env, workspace, task, app.getPath("userData")), stdio: "pipe" });
      children.push(child);
      child.stderr?.on("data", (data) => process.stderr.write(`[${workspaceId}-host] ${data}`));
      return { child, client: new HostClient(child) };
    }, (id) => index.resolve(id), undefined, index);
    // Same wiring decisions as the production entry: main owns the real creation-intent
    // store, Provider wiring and service catalog, and hands them to `registerIpc`.
    // Omitting `creation` would leave `shell/createTask` fail-closed and draw a mount-time
    // alert production cannot produce; omitting `catalog` would leave the 环境与服务 read
    // fail-closed, which the S07 environment readout would print as an unwired state.
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
      for (let i = 0; i < 300; i++) { last = await text(); if (match(last)) return last; await wait(100); }
      throw Error(`UI timeout [${phase}] (${label}): ${JSON.stringify(last.slice(0, 4000))}`);
    };
    const click = (name) => evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(name)} || el.getAttribute('aria-label') === ${JSON.stringify(name)}); if (!b) throw Error('missing button '+${JSON.stringify(name)}+' :: '+document.body.innerText.replace(/\\n+/g,' | ').slice(0,600)); b.click(); return true; })()`);
    const inputValue = (label) => evalJs(`(() => { const el = document.querySelector('input[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']'); return el ? el.value : null; })()`);
    // Typing: React keeps its own value tracker, so assigning `el.value` alone would be
    // ignored by the controlled input. The prototype setter + a bubbling `input` event is
    // what a real keystroke produces; the returned `el.value` is compared by the caller so
    // a silently dropped keystroke fails the capture instead of writing something else.
    const type = async (label, value) => {
      const typed = await evalJs(`(() => {
        const el = document.querySelector('input[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']');
        if (!el) throw Error('missing input ' + ${JSON.stringify(label)});
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return el.value;
      })()`);
      if (typed !== value) throw Error(`typing into "${label}" did not stick: ${JSON.stringify(typed)}`);
      return typed;
    };
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
    const dialogAlerts = () => evalJs("[...document.querySelectorAll('[role=dialog] [role=alert]')].map((el) => el.textContent.trim())");
    // A refused submit must be visible before the capture asserts on it, so poll for the
    // inline error rather than assuming it renders within one frame.
    const untilDialogAlert = async () => {
      let last = [];
      for (let i = 0; i < 100; i++) { last = await dialogAlerts(); if (last.length) return last; await wait(100); }
      throw Error(`no inline dialog alert [${phase}]: ${JSON.stringify((await dialogText()).replace(/\n+/g, " | ").slice(0, 600))}`);
    };
    const dialogTitles = () => evalJs("[...document.querySelectorAll('[role=dialog] h2')].map((el) => el.textContent.trim())");
    const overviewTitle = () => evalJs("document.querySelector('[data-testid=overview-title]')?.textContent.trim() ?? null");
    // The workspace rows plus the 未归属任务 row, in rendered order. 新建工作空间 (the "+" in the
    // group heading) and 已归档 also live in this group but are not workspace rows.
    const navLabels = () => evalJs("[...document.querySelectorAll('[data-nav-group=workspaces] button[aria-label]')].map((el) => el.getAttribute('aria-label')).filter((label) => label !== '新建工作空间' && label !== '已归档')");
    const currentNav = () => evalJs("document.querySelector('[data-nav-group=workspaces] button[aria-current=page]')?.getAttribute('aria-label') ?? null");
    const sourceCards = () => evalJs("[...document.querySelectorAll('[data-source-id]')].map((el) => el.textContent.replace(/\\s+/g, ' ').trim())");
    const sizeTo = async (width, height) => { views.window.setContentSize(width, height); await wait(120); };
    // Focus is restored to the dialog opener on close, and a lingering `:focus` border would
    // differ between the pre- and post-restart runs of the SAME view. Blur before the two
    // captures that are compared byte-for-byte, on both sides.
    const settleFocus = () => evalJs("(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); return document.activeElement === document.body; })()");
    const registryIds = () => projects.list().projects.map((row) => row.id);

    // Fail closed: the loaded entry must be the packaged React renderer over file://.
    const url = await evalJs("location.href");
    if (typeof url !== "string" || !/^file:\/\/.*\/renderer\/index\.html$/.test(url)) throw Error(`not the production file:// renderer: ${url}`);

    const metrics = async () => evalJs(`(() => {
      const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; };
      const line = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80) : null);
      const main = document.querySelector('[data-testid=desktop-shell-content]');
      const dialog = document.querySelector('[role=dialog]');
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        sidebar: box(document.querySelector('[data-testid=desktop-sidebar]')),
        header: box(document.querySelector('[data-testid=desktop-breadcrumb]')),
        content: box(main),
        contentScroll: main ? { scrollWidth: main.scrollWidth, clientWidth: main.clientWidth, scrollHeight: main.scrollHeight, clientHeight: main.clientHeight } : null,
        documentOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        sectionOrder: main ? [...main.querySelectorAll('section')].map((el) => el.getAttribute('aria-label') || line(el.querySelector('h2,h3') || el)) : [],
        sectionTops: main ? [...main.querySelectorAll('section')].map((el) => ({ label: el.getAttribute('aria-label') || line(el.querySelector('h2,h3') || el), top: Math.round(el.getBoundingClientRect().top), height: Math.round(el.getBoundingClientRect().height) })) : [],
        overviewTitle: box(document.querySelector('[data-testid=overview-title]')),
        actionRow: box(document.querySelector('main [data-testid=desktop-project-overview] > div:first-child')),
        sourceCards: [...document.querySelectorAll('[data-source-id]')].map((el) => ({ id: el.getAttribute('data-source-id'), width: Math.round(el.getBoundingClientRect().width), text: line(el) })),
        modal: dialog ? { ...box(dialog), padding: getComputedStyle(dialog).padding, radius: getComputedStyle(dialog).borderRadius,
          labels: [...dialog.querySelectorAll('label')].map(line), headings: [...dialog.querySelectorAll('h2,h3')].map(line), buttons: [...dialog.querySelectorAll('button')].map(line),
          footer: box(dialog.querySelector('footer')), sourceRows: dialog.querySelectorAll('[aria-label^="仓库名称"], [aria-label^="目录名称"]').length } : null,
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
        sha256: createHash("sha256").update(png).digest("hex"),
        layout: await metrics(),
        bodyText: (await text()).replace(/\n+/g, " | ").slice(0, 1600) };
      shots.push(record);
      return record;
    };

    // ------------------------------------------- restart phase: post-restart evidence
    // This branch runs in a NEW Electron OS process over the same on-disk
    // registry/task-root files (fresh ProjectRegistry/TaskRootIndex instances).
    if (restart) {
      const body = await until((candidate) => candidate.includes(PROJECT_NAME) && candidate.includes("来源缺失") &&
        candidate.includes("结算对账分页边界") && candidate.includes("运单查询服务联调") &&
        candidate.includes("另有 1 个任务尚未归属任何工作空间"), "post-restart overview");
      if (DEMO_LEAK.test(body)) throw Error(`demo/fixture string leaked into the post-restart overview: ${body.match(DEMO_LEAK)?.[0]}`);
      const sources = await evalJs("(() => [...document.querySelectorAll('[data-source-id]')].map((el) => el.getAttribute('data-source-id')))()");
      const expected = JSON.parse(process.env["PIDOCK_T01_EXPECT_IDENTITY"] ?? "null");
      if (!expected) throw Error("restart phase: no expected identity supplied");
      check("post-restart UI renders exactly the same source ids",
        JSON.stringify(sources) === JSON.stringify([...expected.repositories, ...expected.directories].map((row) => row.id)), JSON.stringify(sources));
      check("post-restart UI still names the workspace", body.includes(PROJECT_NAME));
      check("post-restart UI still draws the named 来源缺失 badge and repair note",
        body.includes("来源缺失") && body.includes("来源路径已缺失，请在编辑工作空间中修复路径。"));
      check("post-restart UI still lists both assigned tasks", body.includes("结算对账分页边界") && body.includes("运单查询服务联调"));
      check("post-restart UI still names the unassigned task count", body.includes("另有 1 个任务尚未归属任何工作空间"));
      check("post-restart UI still shows the saved environment", body.includes("NODE_ENV = development"));
      // The workspace (f)/(g) wrote through the DOM must be readable in the new process too,
      // and navigating to it must render the values the dialog really submitted.
      const restartNav = await navLabels();
      check("post-restart sidebar lists the workspace created through the UI", restartNav.includes(SAVE_RENAMED), JSON.stringify(restartNav));
      await settleFocus();
      await capture("workspace-overview-after-restart", 1440, 900);
      await capture("workspace-overview-after-restart", 720, 560);
      await click(SAVE_RENAMED);
      const savedRestartBody = await until((candidate) => candidate.includes(SAVE_RENAMED) && candidate.includes(`SAVE_CHECK = ${SAVE_ENV.value}`) &&
        candidate.includes("save-check-repo（Git 仓库）") && candidate.includes("save-check-dir（普通目录）") && candidate.includes("路径可用"), "post-restart saved overview");
      if (DEMO_LEAK.test(savedRestartBody)) throw Error(`demo/fixture string leaked into the post-restart saved overview: ${savedRestartBody.match(DEMO_LEAK)?.[0]}`);
      const savedRestartFlat = savedRestartBody.replace(/\s+/g, " ").trim();
      check("post-restart overview of the UI-created workspace renders its real source names, path and description",
        savedRestartFlat.includes("save-check-repo（Git 仓库）") && savedRestartFlat.includes("save-check-dir（普通目录）") &&
        savedRestartFlat.includes(SAVE_DESCRIPTION), savedRestartFlat.slice(0, 400));
      check("post-restart overview of the UI-created workspace renders the saved environment and template",
        savedRestartBody.includes(`SAVE_CHECK = ${SAVE_ENV.value}`) && savedRestartBody.includes(SAVE_TEMPLATE));
      check("post-restart overview draws both UI-created sources as readable", savedRestartBody.includes("路径可用"), savedRestartBody.slice(0, 400));
      await settleFocus();
      await capture("workspace-overview-after-restart-saved", 1440, 900);
      await capture("workspace-overview-after-restart-saved", 720, 560);
      let revision = "unknown";
      try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: repoRoot }).trim(); } catch { /* recorded as unknown */ }
      const log = {
        phase: "restart",
        pid: process.pid,
        command: `${command} --phase restart`,
        revision,
        identity: readIdentity(),
        assertions,
        shots,
        pageText: body.replace(/\n+/g, " | ").slice(0, 4000),
        pageTextTail: body.replace(/\n+/g, " | ").slice(-1200),
      };
      writeFileSync(join(output, "restart-log.json"), `${JSON.stringify(log, null, 2)}\n`);
      console.log("T01_RESTART_CAPTURE=" + JSON.stringify({ pid: process.pid, shots: shots.map((shot) => shot.file), identity: log.identity }));
      return;
    }

    // ---------------------------------------------------------------- (a) S07 overview
    const overviewBody = await until((body) => body.includes(PROJECT_NAME) && body.includes("来源缺失") &&
      body.includes("工作空间复用来源（Git 仓库与普通目录）") && body.includes("结算对账分页边界") &&
      body.includes("运单查询服务联调") && body.includes("特性分支模板：") && body.includes("feature/{task-name}"), "S07 workspace overview");
    if (DEMO_LEAK.test(overviewBody)) throw Error(`demo/fixture string leaked into the overview: ${overviewBody.match(DEMO_LEAK)?.[0]}`);
    check("S07 heading names the saved workspace", overviewBody.includes(PROJECT_NAME));
    check("S07 description comes from the registry", overviewBody.includes(PROJECT_DESCRIPTION));
    check("S07 source cards name all three registered sources",
      overviewBody.includes("invoice-service（Git 仓库）") && overviewBody.includes(`${MISSING_REPO_NAME}（Git 仓库）`) && overviewBody.includes("设计资料（普通目录）"));
    check("S07 draws the named 来源缺失 badge and repair note",
      overviewBody.includes("来源缺失") && overviewBody.includes("来源路径已缺失，请在编辑工作空间中修复路径。") && overviewBody.includes("修复路径"));
    check("S07 task ledger lists both assigned tasks", overviewBody.includes("结算对账分页边界") && overviewBody.includes("运单查询服务联调"));
    check("S07 environment section shows the saved variables",
      overviewBody.includes("NODE_ENV = development") && overviewBody.includes("API_BASE_URL = https://api.dev.pidock.internal") && overviewBody.includes("DEBUG = pidock:*"));
    check("S07 names the unassigned task count", overviewBody.includes("另有 1 个任务尚未归属任何工作空间"));
    check("S07 shows the saved branch template", overviewBody.includes("特性分支模板：") && overviewBody.includes("feature/{task-name}"));
    check("S07 has no unwired environment state", !overviewBody.includes("服务配方目录尚未接入"), overviewBody.slice(0, 300));
    const sourceIds = await evalJs("(() => [...document.querySelectorAll('[data-source-id]')].map((el) => el.getAttribute('data-source-id')))()");
    check("S07 renders exactly three real source ids", sourceIds.length === 3, JSON.stringify(sourceIds));
    await capture("workspace-overview", 1440, 900);
    await capture("workspace-overview", 720, 560);

    // -------------------------------------------------- (b) S10 create dialog
    await click("新建工作空间");
    const createBody = await until((body) => body.includes("新建工作空间") && body.includes("创建工作区并保存配置") &&
      body.includes("工作空间名称 *") && body.includes("关联 Git 仓库与目录 *"), "S10 create dialog");
    for (const expected of ["工作空间名称 *", "描述与业务用途", "关联 Git 仓库与目录 *", "工作空间全局环境变量 *", "Git 远程分支模板 *", "取消", "创建工作区并保存配置", "Esc"]) {
      check(`S10 create dialog shows "${expected}"`, createBody.includes(expected));
    }
    const dialogRole = await evalJs("document.querySelector('[role=dialog]')?.getAttribute('aria-label') ?? null");
    check("S10 create dialog is a named modal", dialogRole === "新建工作空间", String(dialogRole));
    await capture("workspace-create-dialog", 1440, 900);
    await capture("workspace-create-dialog", 720, 560);
    await click("取消");
    await until((body) => !body.includes("创建工作区并保存配置"), "create dialog closed");

    // ------------------------------------------------------- (c) 未归属任务
    await click("未归属任务");
    const unassignedBody = await until((body) => body.includes("这些任务还没有被用户确认归属") &&
      body.includes("临时排查本地端口占用") && body.includes("选择工作空间") && body.includes("认领"), "未归属任务");
    check("未归属任务 lists exactly the unassigned task", unassignedBody.includes("1 个未归属任务") && unassignedBody.includes("临时排查本地端口占用"));
    check("未归属任务 offers an explicit claim control", unassignedBody.includes("选择工作空间") && unassignedBody.includes("认领"));
    if (DEMO_LEAK.test(unassignedBody)) throw Error(`demo/fixture string leaked into 未归属任务: ${unassignedBody.match(DEMO_LEAK)?.[0]}`);
    await capture("unassigned-tasks", 1440, 900);
    await capture("unassigned-tasks", 720, 560);

    // ---------------------------------------------------------- (d) edit dialog
    await click(PROJECT_NAME);
    await until((body) => body.includes(PROJECT_NAME) && body.includes("工作空间复用来源"), "back to overview");
    await click("编辑工作空间");
    const editBody = await until((body) => body.includes("编辑工作空间") && body.includes("保存更改") && body.includes("来源缺失"), "edit dialog");
    for (const expected of ["编辑工作空间", "工作空间名称 *", "描述与业务用途", "关联 Git 仓库与目录 *", "工作空间全局环境变量 *", "Git 远程分支模板 *", "来源缺失", "修复路径", "取消", "保存更改"]) {
      check(`edit dialog shows "${expected}"`, editBody.includes(expected));
    }
    check("edit dialog is prefilled with the saved workspace name", (await inputValue("工作空间名称 *")) === PROJECT_NAME, String(await inputValue("工作空间名称 *")));
    check("edit dialog is prefilled with the saved description", (await inputValue("描述与业务用途")) === PROJECT_DESCRIPTION);
    check("edit dialog is prefilled with the saved source name", (await inputValue("仓库名称 1")) === "invoice-service");
    check("edit dialog is prefilled with the missing source path", (await inputValue("仓库路径 2")) === join(root, "sources", MISSING_REPO_NAME));
    check("edit dialog keeps the saved branch template", (await inputValue("Git 远程分支模板 *")) === FINAL);
    await capture("workspace-edit-dialog", 1440, 900);
    await capture("workspace-edit-dialog", 720, 560);
    await click("取消");
    await until((body) => !body.includes("保存更改"), "edit dialog closed");

    // --------------------------------------------- (e) delete-blocker dialog
    await click("删除");
    const deleteBody = await until((body) => body.includes(`删除工作空间「${PROJECT_NAME}」`) &&
      body.includes("有 2 个任务仍关联此工作空间") && body.includes("结算对账分页边界") && body.includes("运单查询服务联调"), "delete blocker dialog");
    check("delete dialog names the workspace", deleteBody.includes(`删除工作空间「${PROJECT_NAME}」`));
    check("delete dialog states the real blocker count", deleteBody.includes("有 2 个任务仍关联此工作空间"));
    check("delete dialog lists the blocking tasks", deleteBody.includes("结算对账分页边界") && deleteBody.includes("运单查询服务联调"));
    check("delete dialog offers transfer/unlink exits", deleteBody.includes("转移至…") && deleteBody.includes("解绑") && deleteBody.includes("转移"));
    const deleteDisabled = await evalJs("(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find(el => el.textContent.trim() === '删除工作空间'); return b ? b.disabled : null; })()");
    check("delete stays disabled while tasks block it", deleteDisabled === true, String(deleteDisabled));
    if (DEMO_LEAK.test(deleteBody)) throw Error(`demo/fixture string leaked into the delete dialog: ${deleteBody.match(DEMO_LEAK)?.[0]}`);
    await capture("workspace-delete-blockers", 1440, 900);
    await capture("workspace-delete-blockers", 720, 560);
    await click("取消");
    await until((body) => !body.includes("仍关联此工作空间"), "delete dialog closed");

    // ================================================ (f) real CREATE submission
    // Everything below is typed into the real S10 dialog and submitted through the primary
    // button, so main's real `projectOps` create path runs and the registry really changes.
    // The empty-name refusal comes FIRST: it must be refused inline and must not write.
    const saveRepo = join(root, "sources", "save-check-repo");
    const saveDir = join(root, "sources", "save-check-dir");
    for (const dir of [saveRepo, saveDir]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(saveRepo, "README.md"), "# save-check-repo\n\n保存流程验收仓库。\n");
    await click("新建工作空间");
    await until((body) => body.includes("创建工作区并保存配置") && body.includes("工作空间名称 *"), "create dialog for the real submission");
    check("the create dialog opened empty for a real submission", (await inputValue("工作空间名称 *")) === "", String(await inputValue("工作空间名称 *")));
    const projectsBeforeSave = registryIds();
    await clickLabelled("添加 Git 仓库", true);
    await type("仓库名称 1", "save-check-repo");
    await type("仓库路径 1", saveRepo);
    await clickLabelled("添加普通目录", true);
    await type("目录名称 1", "save-check-dir");
    await type("目录路径 1", saveDir);
    await clickLabelled("添加变量", true);
    await type(`环境变量名 1`, SAVE_ENV.key);
    await type(`环境变量值 1`, SAVE_ENV.value);
    await type("Git 远程分支模板 *", SAVE_TEMPLATE);
    await type("描述与业务用途", SAVE_DESCRIPTION);
    stage = "create blocked by empty name";
    await clickLabelled("创建工作区并保存配置", true);
    const nameRefusal = await untilDialogAlert();
    check("an empty name blocks the save with the inline named message", nameRefusal.includes("请填写工作空间名称"), JSON.stringify(nameRefusal));
    check("the blocked save leaves the dialog open with the draft intact",
      (await dialogOpen()) === true && (await dialogTitles())[0] === "新建工作空间" && (await inputValue("工作空间名称 *")) === "" &&
      (await inputValue("仓库名称 1")) === "save-check-repo" && (await inputValue("目录名称 1")) === "save-check-dir" &&
      (await inputValue("环境变量名 1")) === SAVE_ENV.key && (await inputValue("Git 远程分支模板 *")) === SAVE_TEMPLATE,
      JSON.stringify({ open: await dialogOpen(), title: (await dialogTitles())[0], name: await inputValue("工作空间名称 *"),
        repo: await inputValue("仓库名称 1"), dir: await inputValue("目录名称 1"), env: await inputValue("环境变量名 1"),
        template: await inputValue("Git 远程分支模板 *") }));
    check("the blocked save wrote nothing to the real registry", JSON.stringify(registryIds()) === JSON.stringify(projectsBeforeSave),
      JSON.stringify({ before: projectsBeforeSave, after: registryIds() }));
    await type("工作空间名称 *", SAVE_NAME);
    stage = "create filled dialog";
    // Input VALUES are not part of `innerText`, so the draft is read field by field.
    const filledDraft = { name: await inputValue("工作空间名称 *"), description: await inputValue("描述与业务用途"),
      repository: [await inputValue("仓库名称 1"), await inputValue("仓库路径 1")],
      directory: [await inputValue("目录名称 1"), await inputValue("目录路径 1")],
      environment: [await inputValue("环境变量名 1"), await inputValue("环境变量值 1")],
      branchTemplate: await inputValue("Git 远程分支模板 *") };
    check("the filled draft really carries the typed name/description/sources/env/template",
      filledDraft.name === SAVE_NAME && filledDraft.description === SAVE_DESCRIPTION &&
      JSON.stringify(filledDraft.repository) === JSON.stringify(["save-check-repo", saveRepo]) &&
      JSON.stringify(filledDraft.directory) === JSON.stringify(["save-check-dir", saveDir]) &&
      JSON.stringify(filledDraft.environment) === JSON.stringify([SAVE_ENV.key, SAVE_ENV.value]) &&
      filledDraft.branchTemplate === SAVE_TEMPLATE, JSON.stringify(filledDraft));
    const filledDialogText = await dialogText();
    check("the filled dialog has one Git row and one directory row, so no 尚未登记来源 hint",
      !filledDialogText.includes("尚未登记来源") && !filledDialogText.includes("尚未添加变量"),
      filledDialogText.replace(/\n+/g, " | ").slice(0, 400));
    check("the inline name error is gone once the name is typed", !(await dialogAlerts()).includes("请填写工作空间名称"), JSON.stringify(await dialogAlerts()));
    await capture("workspace-create-filled", 1440, 900);
    await capture("workspace-create-filled", 720, 560);
    await sizeTo(1440, 900);
    stage = "create submit";
    await clickLabelled("创建工作区并保存配置", true);
    // `innerText` breaks lines around the count badges, so layout-agnostic text checks run on
    // a whitespace-normalised copy. Waiting for the empty-task-ledger copy also waits out the
    // lifecycle read that follows the reload, so the counts below are real, not 未核验.
    const flat = (value) => value.replace(/\s+/g, " ").trim();
    const savedBody = await until((body) => !body.includes("创建工作区并保存配置") && body.includes(SAVE_NAME) &&
      body.includes("save-check-repo（Git 仓库）") && body.includes(`SAVE_CHECK = ${SAVE_ENV.value}`) &&
      body.includes("这个工作空间还没有进行中任务。") && body.includes("路径可用"), "overview of the newly created workspace");
    const savedFlat = flat(savedBody);
    if (DEMO_LEAK.test(savedBody)) throw Error(`demo/fixture string leaked into the post-save overview: ${savedBody.match(DEMO_LEAK)?.[0]}`);
    const createdRecord = projects.list().projects.find((row) => row.name === SAVE_NAME);
    if (!createdRecord) throw Error(`the UI create did not persist a workspace named ${SAVE_NAME}`);
    const savedId = createdRecord.id;
    check("the real create wrote exactly one new workspace", registryIds().length === projectsBeforeSave.length + 1 &&
      registryIds().filter((row) => !projectsBeforeSave.includes(row)).length === 1, JSON.stringify({ before: projectsBeforeSave, after: registryIds() }));
    check("the saved workspace keeps the typed name/description", createdRecord.name === SAVE_NAME && createdRecord.description === SAVE_DESCRIPTION,
      JSON.stringify({ name: createdRecord.name, description: createdRecord.description }));
    check("the saved workspace keeps the Git source and the plain directory with their real paths",
      createdRecord.repositories.length === 1 && createdRecord.repositories[0].name === "save-check-repo" && createdRecord.repositories[0].path === saveRepo &&
      createdRecord.directories.length === 1 && createdRecord.directories[0].name === "save-check-dir" && createdRecord.directories[0].path === saveDir,
      JSON.stringify({ repositories: createdRecord.repositories, directories: createdRecord.directories }));
    check("the saved workspace keeps the environment variable and the branch template",
      JSON.stringify(createdRecord.environment) === JSON.stringify([SAVE_ENV]) && createdRecord.branchTemplate === SAVE_TEMPLATE,
      JSON.stringify({ environment: createdRecord.environment, branchTemplate: createdRecord.branchTemplate }));
    check("the saved sources verify against the real filesystem",
      (await verifyProjectSources(createdRecord)).sources.every((row) => row.status === "ok"),
      JSON.stringify((await verifyProjectSources(createdRecord)).sources));
    check("the dialog closed after the real save", (await dialogOpen()) === false);
    check("the sidebar lists the workspace the save created", (await navLabels()).includes(SAVE_NAME), JSON.stringify(await navLabels()));
    check("the new workspace is the selected nav entry", (await currentNav()) === SAVE_NAME, String(await currentNav()));
    check("the overview is now the new workspace", (await overviewTitle()) === SAVE_NAME, String(await overviewTitle()));
    check("the post-save overview names both real sources",
      savedFlat.includes("save-check-repo（Git 仓库）") && savedFlat.includes("save-check-dir（普通目录）") && savedFlat.includes(saveRepo), savedFlat.slice(0, 400));
    check("the post-save overview shows the saved environment and branch template",
      savedFlat.includes(`SAVE_CHECK = ${SAVE_ENV.value}`) && savedFlat.includes(SAVE_TEMPLATE));
    check("the post-save overview shows the saved description and source counts",
      savedFlat.includes(SAVE_DESCRIPTION) && savedFlat.includes("1 来源代码库 · 1 普通目录"), savedFlat.slice(0, 400));
    check("the post-save overview says it has no tasks yet instead of inventing any", savedFlat.includes("这个工作空间还没有进行中任务。"));
    check("the post-save overview counts zero in-progress tasks for the new workspace", savedFlat.includes("0 进行中的任务"), savedFlat.slice(0, 400));
    check("the post-save overview draws both new sources as readable", savedFlat.split("路径可用").length - 1 === 2, savedFlat.slice(0, 400));
    check("the breadcrumb follows the save", (await evalJs("document.querySelector('[data-testid=desktop-breadcrumb]').innerText")).replace(/\s+/g, " ").includes(SAVE_NAME),
      (await evalJs("document.querySelector('[data-testid=desktop-breadcrumb]').innerText")).replace(/\s+/g, " "));
    await capture("workspace-overview-after-create", 1440, 900);
    await capture("workspace-overview-after-create", 720, 560);

    // ================================================== (g) real EDIT submission
    stage = "edit rename";
    await click("编辑工作空间");
    await until((body) => body.includes("保存更改") && body.includes("工作空间名称 *"), "edit dialog for the rename");
    check("the edit dialog is prefilled from what the create just saved",
      (await inputValue("工作空间名称 *")) === SAVE_NAME && (await inputValue("描述与业务用途")) === SAVE_DESCRIPTION &&
      (await inputValue("仓库名称 1")) === "save-check-repo" && (await inputValue("Git 远程分支模板 *")) === SAVE_TEMPLATE,
      String(await inputValue("工作空间名称 *")));
    await type("工作空间名称 *", SAVE_RENAMED);
    await clickLabelled("保存更改", true);
    const renamedBody = await until((body) => !body.includes("保存更改") && body.includes(SAVE_RENAMED) &&
      body.includes("重命名不改变工作空间身份"), "overview after the rename");
    if (DEMO_LEAK.test(renamedBody)) throw Error(`demo/fixture string leaked into the renamed overview: ${renamedBody.match(DEMO_LEAK)?.[0]}`);
    const afterRename = projects.list().projects;
    const renamedRecord = afterRename.find((row) => row.id === savedId);
    if (!renamedRecord) throw Error(`the renamed workspace ${savedId} vanished from the registry`);
    // Read from the real registry AFTER the UI update: this is the identity the restart
    // phase and the rename assertions compare against.
    const savedIdentity = identityOf(savedId);
    const createdIdentity = { repositories: createdRecord.repositories.map((row) => ({ id: row.id, name: row.name, path: row.path })),
      directories: createdRecord.directories.map((row) => ({ id: row.id, name: row.name, path: row.path })),
      environment: createdRecord.environment, branchTemplate: createdRecord.branchTemplate, description: createdRecord.description };
    check("the rename kept the same registry project id", renamedRecord.id === savedId, `${savedId} -> ${renamedRecord.id}`);
    check("the rename replaced the old name in the registry", renamedRecord.name === SAVE_RENAMED &&
      afterRename.every((row) => row.name !== SAVE_NAME), JSON.stringify(afterRename.map((row) => row.name)));
    check("the rename created no duplicate workspace", afterRename.length === projectsBeforeSave.length + 1 &&
      afterRename.filter((row) => row.name === SAVE_RENAMED).length === 1, JSON.stringify(afterRename.map((row) => row.name)));
    check("the rename left the source ids, environment and branch template untouched",
      JSON.stringify(savedIdentity.repositories) === JSON.stringify(createdIdentity.repositories) &&
      JSON.stringify(savedIdentity.directories) === JSON.stringify(createdIdentity.directories) &&
      JSON.stringify(savedIdentity.environment) === JSON.stringify(createdIdentity.environment) &&
      savedIdentity.branchTemplate === createdIdentity.branchTemplate && savedIdentity.description === createdIdentity.description,
      JSON.stringify(savedIdentity));
    check("the sidebar label followed the rename", (await navLabels()).includes(SAVE_RENAMED) && !(await navLabels()).includes(SAVE_NAME), JSON.stringify(await navLabels()));
    check("the renamed workspace is still the selected nav entry", (await currentNav()) === SAVE_RENAMED, String(await currentNav()));
    check("the overview title followed the rename", (await overviewTitle()) === SAVE_RENAMED, String(await overviewTitle()));
    check("the overview title is not the old name any more", !new RegExp(`${SAVE_NAME}(?!·改名)`).test(renamedBody), renamedBody.slice(0, 300));
    await capture("workspace-overview-after-rename", 1440, 900);
    await capture("workspace-overview-after-rename", 720, 560);

    // The renamed workspace has to be a real nav destination: leave the page, come back.
    stage = "rename navigation";
    await click("未归属任务");
    await until((body) => body.includes("这些任务还没有被用户确认归属"), "navigate away from the renamed workspace");
    check("the renamed workspace survives leaving its page", (await navLabels()).includes(SAVE_RENAMED), JSON.stringify(await navLabels()));
    await click(SAVE_RENAMED);
    await until((body) => body.includes(SAVE_RENAMED) && body.includes("工作空间复用来源"), "navigate back to the renamed workspace");
    check("navigating back re-selects the renamed workspace", (await overviewTitle()) === SAVE_RENAMED && (await currentNav()) === SAVE_RENAMED,
      JSON.stringify({ title: await overviewTitle(), nav: await currentNav() }));
    check("the renamed workspace still renders its real sources after navigating back",
      (await sourceCards()).length === 2 && (await sourceCards()).every((card) => card.includes("路径可用")), JSON.stringify(await sourceCards()));

    // ------------------------------------- (h) pre-restart reference for the same view
    // Focus is settled on both sides of the restart because the byte comparison below
    // would otherwise catch a restored `:focus` border, not a rendering difference.
    stage = "pre-restart reference";
    await click(PROJECT_NAME);
    const beforeRestartBody = await until((body) => body.includes(PROJECT_NAME) && body.includes("来源缺失") &&
      body.includes("结算对账分页边界") && body.includes("另有 1 个任务尚未归属任何工作空间"), "pre-restart reference overview");
    check("the pre-restart reference is the seeded workspace, not the renamed one", (await overviewTitle()) === PROJECT_NAME, String(await overviewTitle()));
    check("the pre-restart sidebar already holds all three workspaces",
      JSON.stringify(await navLabels()) === JSON.stringify([PROJECT_NAME, "Docs 归档", SAVE_RENAMED, "未归属任务"]), JSON.stringify(await navLabels()));
    check("the pre-restart reference still shows the missing-source badge", beforeRestartBody.includes("来源缺失"));
    await settleFocus();
    await capture("workspace-overview-before-restart", 1440, 900);
    await capture("workspace-overview-before-restart", 720, 560);

    let revision = "unknown"; let trackedFilesDirty = "unknown";
    try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: repoRoot }).trim(); } catch { /* recorded as unknown */ }
    try {
      const excluded = relative(repoRoot, output);
      const args = ["status", "--porcelain", "--untracked-files=no", "--", "."];
      if (excluded && !excluded.startsWith("..") && !isAbsolute(excluded)) args.push(`:(exclude)${excluded}`);
      trackedFilesDirty = execFileSync("git", args, { encoding: "utf8", cwd: repoRoot }).trim() ? "true" : "false";
    } catch { /* recorded as unknown */ }

    // ---------------------------------------- real process restart (second OS process)
    stage = "restart process";
    const expected = readIdentity();
    const restartOut = await new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [scriptPath, "--phase", "restart", "--out", output], {
        env: { ...process.env, PIDOCK_T01_PROJECT_ID: projectId, PIDOCK_T01_EXPECT_IDENTITY: JSON.stringify(expected),
          PIDOCK_T01_EXPECT_SAVED: JSON.stringify(savedIdentity) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (data) => { stdout += data; process.stdout.write(`[t01-restart] ${data}`); });
      child.stderr.on("data", (data) => { stderr += data; process.stderr.write(`[t01-restart] ${data}`); });
      child.on("error", reject);
      child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    });
    check("the restart phase exited 0", restartOut.code === 0, JSON.stringify({ code: restartOut.code, stderr: restartOut.stderr.slice(-600) }));
    const restartLog = JSON.parse(readFileSync(join(output, "restart-log.json"), "utf8"));
    check("restart process reported a different pid", restartLog.pid !== process.pid, `${process.pid} -> ${restartLog.pid}`);
    const after = restartLog.identity;
    check("restart identity matches workspace id/name", after.projectId === expected.projectId && after.projectName === expected.projectName);
    check("restart identity matches source ids", JSON.stringify(after.repositories) === JSON.stringify(expected.repositories) &&
      JSON.stringify(after.directories) === JSON.stringify(expected.directories));
    check("restart identity matches associations", JSON.stringify(after.associations) === JSON.stringify(expected.associations), JSON.stringify(after.associations));
    const restartBody = `${restartLog.pageText ?? ""} ${restartLog.pageTextTail ?? ""}`;
    check("post-restart UI still names the workspace", restartBody.includes(PROJECT_NAME));
    check("post-restart UI still draws the missing-source badge", restartBody.includes("来源缺失"));
    check("post-restart UI still lists both assigned tasks", restartBody.includes("结算对账分页边界") && restartBody.includes("运单查询服务联调"));
    check("post-restart UI still names the unassigned task count", restartBody.includes("另有 1 个任务尚未归属任何工作空间"));
    check("the restart process ran the post-restart capture set", JSON.stringify(restartLog.shots.map((shot) => shot.state)) === JSON.stringify(["workspace-overview-after-restart", "workspace-overview-after-restart", "workspace-overview-after-restart-saved", "workspace-overview-after-restart-saved"]), JSON.stringify(restartLog.shots.map((shot) => shot.file)));
    // Cross-process rendering identity: the SAME view, captured by the same code with focus
    // settled, from two different OS processes over the same on-disk data. The comparison is
    // per pixel, because Chromium's LCD text antialiasing can move a channel by one even when
    // the layout and the strings are identical; the measured delta is recorded, not hidden.
    const restartPixelDiffs = [];
    for (const [width, height] of [[1440, 900], [720, 560]]) {
      const beforeName = shotFile(width, height, "workspace-overview-before-restart");
      const afterName = shotFile(width, height, "workspace-overview-after-restart");
      const beforeShot = shots.find((shot) => shot.file === beforeName);
      const afterShot = restartLog.shots.find((shot) => shot.file === afterName);
      const diff = screenshotDiff(readFileSync(join(output, beforeName)), readFileSync(join(output, afterName)));
      restartPixelDiffs.push({ size: `${width}x${height}`, byteIdentical: beforeShot?.sha256 === afterShot?.sha256,
        beforeSha256: beforeShot?.sha256, afterSha256: afterShot?.sha256, ...diff });
      check(`post-restart ${width}x${height} screenshot matches the pre-restart one except for sub-pixel text antialiasing`,
        diff.differingPixels / diff.totalPixels <= 0.00001 && diff.maxChannelDelta <= 2, JSON.stringify(diff));
    }
    // The workspace the UI wrote is re-read in the new process and compared field by field.
    const restartIdentityFile = JSON.parse(readFileSync(join(output, "restart-identity.json"), "utf8"));
    check("the restart process re-read the UI-created workspace under the same id",
      restartIdentityFile.savedAfter?.projectId === savedId, JSON.stringify(restartIdentityFile.savedAfter?.projectId));
    check("the restart process re-read the UI-created workspace with identical name/sources/env/template",
      JSON.stringify(restartIdentityFile.savedAfter) === JSON.stringify(savedIdentity), JSON.stringify(restartIdentityFile.savedAfter));

    const log = {
      ticket: "#136 S07 workspace overview / S10 create-edit dialog / 未归属任务 / delete blockers — real Electron evidence (T01)",
      command, repoRoot, revision, trackedFilesDirty,
      generatedBy: "scripts/electron-pencil-v1-t01-capture.mjs",
      phase: "primary",
      pid: process.pid,
      seeded: {
        registry: "ProjectRegistry.create/claim (real projects.json under isolated userData)",
        project: expected,
        otherWorkspace: "Docs 归档 (empty workspace, real transfer target)",
        missingSource: `${MISSING_REPO_NAME} directory deleted AFTER registration; verifyProjectSources reported missing`,
        unassigned: ["task-bbbb2222"],
        taskRecords: "production task-store serializer (no renderer-free create API in this checkout)",
      },
      restart: {
        kind: "real OS process restart of the capture harness wiring (still not dist/main/main.js lifecycle)",
        pidBefore: process.pid,
        pidAfter: restartLog.pid,
        identityBefore: expected,
        identityAfter: after,
        savedBefore: savedIdentity,
        savedAfter: restartIdentityFile.savedAfter,
        screenshotComparison: restartPixelDiffs,
        shots: restartLog.shots,
        assertions: restartLog.assertions,
      },
      // (f)/(g): the ONLY writes this capture performs through the product UI. Everything
      // above is read-only; these two are real submissions of the real S10 dialog.
      saveFlows: {
        driven: "typed into the real S10 dialog and submitted through its primary button (main's real projectOps create/update wrote projects.json)",
        registryIdsBefore: projectsBeforeSave,
        registryIdsAfter: registryIds(),
        blockedEmptyName: {
          typedName: "",
          inlineAlert: nameRefusal,
          dialogStayedOpen: true,
          draftRetained: { repository: "save-check-repo", directory: "save-check-dir", environmentKey: SAVE_ENV.key, branchTemplate: SAVE_TEMPLATE },
          registryUnchanged: true,
        },
        created: { projectId: savedId, ...createdIdentity, projectName: SAVE_NAME, sourcesVerified: "ok (both directories exist on disk)" },
        renamed: { projectIdBefore: savedId, projectIdAfter: renamedRecord.id, nameBefore: SAVE_NAME, nameAfter: SAVE_RENAMED, identity: savedIdentity,
          sourcesEnvironmentTemplateUnchanged: true },
      },
      assertions,
      shots,
    };
    writeFileSync(join(output, "capture-log.json"), `${JSON.stringify(log, null, 2)}\n`);
    for (const shot of shots) console.log("T01_CAPTURE=" + JSON.stringify({ state: shot.state, file: shot.file, sha256: shot.sha256 }));
    console.log("T01_CAPTURE_LOG=" + JSON.stringify({ revision, trackedFilesDirty, shots: shots.map((shot) => shot.file), restartShots: restartLog.shots.map((shot) => shot.file), savedId }));
  } catch (error) {
    console.error(`T01_CAPTURE_FAILED [${phase}]`, stage, error);
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    const cleanupFailures = await shutdownTestRegistry(registry, {
      origin: views ? { kind: "shell-ui", senderWebContentsId: views.shellView.webContents.id } : undefined,
      label: `PencilV1 T01 capture cleanup (${phase})`,
    });
    for (const child of children) child.kill();
    if (views?.shellView.webContents.debugger.isAttached()) views.shellView.webContents.debugger.detach();
    views?.window.destroy();
    if (phase !== "restart") rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    if (cleanupFailures.length) { console.error(`T01_CAPTURE_CLEANUP_FAILED [${phase}] ` + JSON.stringify(cleanupFailures)); process.exitCode = process.exitCode ?? 1; }
    exitNow(process.exitCode ?? 0, "done");
  }
}
void run();
