// #162: built production Electron, real preload/IPC/Host/registry/disk; isolated fixtures only.
// Run after pnpm --filter @pidock/shell build. Each viewport is a fresh real window.
import { app, utilityProcess } from "electron";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createUnavailableHostClient } from "./unavailable-host-client.mjs";
import { shutdownTestRegistry } from "./shutdown-test-registry.mjs";

delete process.env.PIDOCK_RENDERER_URL;
delete process.env.PIDOCK_TASK_URL;
const arg = (key, fallback) =>
  process.argv.includes(key)
    ? process.argv[process.argv.indexOf(key) + 1]
    : fallback;
const [width, height] = arg("--size", "1440x900").split("x").map(Number);
const scenario = "full";
const theme = arg("--theme", "light");
const restart = process.argv.includes("--restart");
const repo = resolve(import.meta.dirname, "../../..");
const output = join(
  repo,
  "docs/evidence/pencil-ui-u07",
  arg("--output", "electron"),
);
const root = arg("--root", mkdtempSync(join(tmpdir(), "pidock-ui-u07-")));
const profile = join(root, "profile");
const taskRoot = join(root, "tasks");
const agentDir = join(
  root,
  "agent",
  "long-native-configuration-path-for-readable-settings",
);
for (const path of [profile, taskRoot, agentDir, output])
  mkdirSync(path, { recursive: true });
app.setPath("userData", profile);
process.env.PIDOCK_AGENT_DIR = agentDir;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const assertions = [],
  shots = [],
  calls = [],
  consoleErrors = [];
let views, registry;
const children = [];
/** @param {string} name @param {unknown} condition @param {unknown} detail */
const check = (name, condition, detail = "") => {
  assertions.push({ name, passed: Boolean(condition), detail });
  if (!condition)
    throw Error(`ASSERT FAILED: ${name}: ${JSON.stringify(detail)}`);
};
let exiting = false;
const finish = (code, error) => {
  if (exiting) return;
  exiting = true;
  const sourcePaths = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "packages/renderer/src",
      "packages/shell/src",
      "packages/shell/scripts/electron-pencil-ui-u07-capture.mjs",
      "pnpm-lock.yaml",
    ],
    { cwd: repo, encoding: "utf8" },
  )
    .trim()
    .split("\n");
  const under = (dir) =>
    readdirSync(join(repo, dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? under(`${dir}/${entry.name}`)
        : [`${dir}/${entry.name}`],
    );
  const manifest = (paths) =>
    Object.fromEntries(
      [...new Set(paths)].sort().map((path) => [path, hash(join(repo, path))]),
    );
  writeFileSync(
    join(
      output,
      `${width}x${height}-${restart ? "restart" : "full"}-identity.json`,
    ),
    JSON.stringify(
      {
        source: manifest(sourcePaths),
        build: manifest(under("packages/shell/dist")),
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(output, `${width}x${height}-${restart ? "restart" : "full"}-log.json`),
    JSON.stringify(
      {
        scenario,
        restart,
        theme,
        size: [width, height],
        root,
        sourceDiffSha256: createHash("sha256")
          .update(
            execFileSync(
              "git",
              [
                "diff",
                "HEAD",
                "--",
                "packages/renderer/src",
                "packages/shell/src",
                "packages/shell/scripts/electron-pencil-ui-u07-capture.mjs",
              ],
              { cwd: repo },
            ),
          )
          .digest("hex"),
        source: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: repo,
          encoding: "utf8",
        }).trim(),
        designSha256: hash(join(repo, "docs/design/PiDock.pen")),
        buildSha256: hash(
          join(repo, "packages/shell/dist/renderer/index.html"),
        ),
        node: process.versions.node,
        electron: process.versions.electron,
        assertions,
        shots,
        calls,
        consoleErrors,
        error: error ?? null,
      },
      null,
      2,
    ),
  );
  console.log(
    `U07_CAPTURE ${width}x${height} ${scenario} ${code} ${error ?? "PASS"}`,
  );
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* already exited */
    }
  }
  app.exit(code);
};
const hash = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
setTimeout(() => finish(1, "watchdog timeout"), 180000).unref();
process.on("uncaughtException", (error) => finish(1, error.stack));
process.on("unhandledRejection", (error) =>
  finish(1, String(error instanceof Error ? error.stack : error)),
);
app.on("window-all-closed", () => {});

async function run() {
  const { buildHostEnv } = await import("../dist/host/host-guards.js");
  const { TaskRootIndex } = await import("../dist/main/task-root-index.js");
  const { ProjectRegistry } = await import("../dist/main/project-registry.js");
  const { ServiceCatalog, serviceCatalogAuthority } =
    await import("../dist/main/service-catalog.js");
  const {
    createTrustedWindow,
    loadTrustedViews,
    PerTaskHostRegistry,
    registerIpc,
  } = await import("../dist/main/runtime.js");
  const { CreationIntentStore, ProjectTaskCreation } =
    await import("../dist/main/project-task-creation.js");
  const { ProviderProfileStore } =
    await import("../dist/main/provider-profile-store.js");
  const { ProviderSecretStore, createTestSafeStorage } =
    await import("../dist/main/provider-secret-store.js");
  const { ProviderWiring } = await import("../dist/main/provider-ipc.js");
  const { HostClient } = await import("../dist/rpc/host-client.js");
  const git = (dir, ...args) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  await app.whenReady();
  const index = new TaskRootIndex(profile, taskRoot),
    projects = new ProjectRegistry(profile);
  const source = join(root, "original-repository"),
    remote = join(root, "origin.git"),
    shared = join(root, "ordinary-shared-directory");
  if (!restart) {
    mkdirSync(source, { recursive: true });
    mkdirSync(shared, { recursive: true });
    git(root, "init", "--bare", "-b", "main", remote);
    git(source, "init", "-b", "main");
    git(source, "config", "user.name", "PiDock fixture");
    git(source, "config", "user.email", "fixture@pidock.local");
    writeFileSync(join(source, "README.md"), "original source protected\n");
    writeFileSync(join(shared, "keep.txt"), "shared source protected\n");
    git(source, "add", ".");
    git(source, "commit", "-m", "fixture baseline");
    git(source, "remote", "add", "origin", remote);
    git(source, "push", "-u", "origin", "main");
    await projects.create({
      name: "PiDock 核心开发",
      description: "U07 native wiring",
      branchTemplate: "ticket/{taskId}-{slug}",
      repositories: [
        { name: "long-repository-name-for-source-protection", path: source },
      ],
      directories: [{ name: "shared", path: shared }],
    });
  }
  views = await createTrustedWindow("pencil-ui-u07", "production");
  views.window.setContentSize(width, height);
  registry = new PerTaskHostRegistry(
    "pencil-ui-u07",
    async (workspaceId, task) => {
      const child = utilityProcess.fork(
        join(import.meta.dirname, "../dist/host/host-entry.js"),
        [],
        {
          serviceName: "pencil-ui-u07-host",
          env: buildHostEnv(process.env, workspaceId, task, profile),
          stdio: "pipe",
        },
      );
      children.push(child);
      child.stderr?.on("data", (data) => process.stderr.write(data));
      return { child, client: new HostClient(child) };
    },
    (id) => index.resolve(id),
    undefined,
    index,
  );
  const route = registry.routeTaskOp.bind(registry);
  registry.routeTaskOp = async (request) => {
    const answer = await route(request);
    calls.push({
      taskId: request.taskId,
      op: request.op,
      ok: answer.ok,
      error: answer.error,
    });
    return answer;
  };
  const profiles = new ProviderProfileStore(profile),
    secrets = new ProviderSecretStore(profile, createTestSafeStorage());
  const providers = new ProviderWiring(
    profiles,
    async (taskId, provider, senderWebContentsId) => {
      await registry.routeTaskOp({
        taskId,
        op: "task/sdkProvider",
        payload:
          provider === null
            ? { provider: null }
            : {
                provider: {
                  config: profiles.config(provider.profileId, provider.modelId),
                  credential: provider.credential,
                },
              },
        origin: { kind: "shell-ui", senderWebContentsId },
      });
    },
    process.env,
    { secrets },
  );
  const creation = new ProjectTaskCreation(
    new CreationIntentStore(profile),
    projects,
    index,
    registry,
    taskRoot,
  );
  if (!restart)
    creation.saveDeliverySettings({
      branchTemplate: "ticket/{taskId}-{slug}",
      remote: "origin",
    });
  registerIpc(
    createUnavailableHostClient(),
    views.registry,
    registry,
    projects,
    index,
    undefined,
    creation,
    providers,
    new ServiceCatalog(profile, serviceCatalogAuthority(index, projects)),
  );
  const origin = {
    kind: "shell-ui",
    senderWebContentsId: views.shellView.webContents.id,
  };
  const taskOp = (taskId, op, payload = {}) =>
    registry.routeTaskOp({ taskId, op, payload, origin });
  const wc = views.shellView.webContents;
  wc.setBackgroundThrottling(false);
  wc.on("console-message", (event) => {
    if (event.level === "error") consoleErrors.push(event.message);
  });
  wc.debugger.attach();
  const evaluate = async (expression) => {
    const result = await wc.debugger.sendCommand("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async (expression, label) => {
    for (let n = 0; n < 300; n++) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await wait(50);
    }
    throw Error(
      `timeout ${label}: ${await evaluate("document.body.innerText")}`,
    );
  };
  const click = async (label) => {
    check(
      `reachable ${label}`,
      await evaluate(
        `(()=>{const el=[...document.querySelectorAll('button')].find(e=>(e.getAttribute('aria-label')??e.textContent.trim())===${JSON.stringify(label)}&&!e.disabled&&e.getBoundingClientRect().width);if(!el)return false;el.focus();el.click();return true;})()`,
      ),
    );
    await wait(100);
  };
  const capture = async (state) => {
    views.window.show();
    app.focus({ steal: true });
    views.window.moveTop();
    views.window.focus();
    wc.focus();
    wc.invalidate();
    await wait(350);
    const metrics = await evaluate(
      `(()=>{const box=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};const page=document.querySelector('[data-testid=desktop-schedules-page]')??document.querySelector('[data-testid=desktop-archive-page]');return {viewport:[innerWidth,innerHeight],theme:document.documentElement.dataset.theme,page:box(page),master:box(document.querySelector('section[aria-label=定时任务规则]')),detail:box(document.querySelector('[data-testid=schedule-detail]')),dialog:box(document.querySelector('[role=dialog]')),overflow:document.documentElement.scrollWidth>innerWidth,focus:document.activeElement?.textContent?.slice(0,100)};})()`,
    );
    check(
      `${state}: viewport`,
      JSON.stringify(metrics.viewport) === JSON.stringify([width, height]),
      metrics,
    );
    check(`${state}: no horizontal overflow`, !metrics.overflow, metrics);
    if (metrics.master && width === 1440)
      check(
        `${state}: S04 360px rule list`,
        metrics.master.width === 360,
        metrics,
      );
    if (metrics.dialog)
      check(
        `${state}: dialog inside viewport`,
        metrics.dialog.x >= 0 &&
          metrics.dialog.y >= 0 &&
          metrics.dialog.x + metrics.dialog.width <= width + 1 &&
          metrics.dialog.y + metrics.dialog.height <= height + 1,
        metrics,
      );
    const file = `${width}x${height}-${state}.png`;
    const shot = await wc.debugger.sendCommand("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    writeFileSync(join(output, file), Buffer.from(shot.data, "base64"));
    shots.push({ file, sha256: hash(join(output, file)), metrics });
  };
  const chooseTheme = async () => {
    if (width < 960) await click("展开导航");
    await click("设置");
    await until(
      "document.querySelector('[data-appearance-option=light]')",
      "appearance settings",
    );
    await evaluate(
      `document.querySelector('[data-appearance-option=${theme}]').click()`,
    );
    await until(
      `document.documentElement.dataset.theme===${JSON.stringify(theme)}`,
      "actual theme",
    );
    await click("返回任务工作区");
  };
  if (process.argv.includes("--empty")) {
    await loadTrustedViews(views);
    await until(
      "window.pidock && document.querySelector('[data-testid=desktop-sidebar]')",
      "empty app ready",
    );
    await chooseTheme();
    await click("定时任务");
    await until(
      "document.body.innerText.includes('当前筛选下没有定时任务')",
      "empty S04",
    );
    await capture(`${theme}-s04-empty`);
    if (width < 960) await click("展开导航");
    await click("已归档");
    await until(
      "document.body.innerText.includes('还没有归档任务')",
      "empty archive",
    );
    await capture(`${theme}-archive-empty`);
    const stopped = await shutdownTestRegistry(registry, {
      label: "u07 empty capture",
      origin,
    });
    check("empty registry clean shutdown", stopped.length === 0, stopped);
    finish(0);
    return;
  }
  let taskId, scheduleId, taskDir, repoDir;
  const statePath = join(root, "state.json");
  if (!restart) {
    const providerServer = createServer((request, response) => {
      let body = "";
      request.on("data", (c) => (body += c));
      request.on("end", () => {
        if (!request.url?.endsWith("/chat/completions")) {
          response.writeHead(404).end();
          return;
        }
        const message = {
          id: "u07",
          object: "chat.completion.chunk",
          model: "u07-loopback",
          choices: [
            {
              index: 0,
              delta: { content: "真实 SDK 回环定时执行完成。" },
              finish_reason: null,
            },
          ],
        };
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify(message)}\n\n`);
        setTimeout(() => {
          response.write(
            `data: ${JSON.stringify({ ...message, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 } })}\n\ndata: [DONE]\n\n`,
          );
          response.end();
        }, 800);
      });
    });
    await new Promise((done) =>
      providerServer.listen(0, "127.0.0.1", () => done(undefined)),
    );
    const address = providerServer.address();
    if (!address || typeof address === "string")
      throw Error("missing loopback address");
    const saved = profiles.save({
      name: "仅本机回环验收",
      protocol: "openai-completions",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      credentials: { kind: "store", revision: 1 },
      modelId: "u07-loopback",
      models: [
        {
          id: "u07-loopback",
          name: "本机回环",
          contextWindow: 131072,
          maxTokens: 8192,
          reasoning: false,
        },
      ],
    });
    secrets.set(saved.id, "u07-private-loopback-fixture");
    const project = projects.list().projects[0];
    const intent = await creation.prepare({
      projectId: project.id,
      name: "每日依赖漏洞与安全巡检 · 长规则长路径核对",
      repositories: [
        {
          sourceId: project.repositories[0].id,
          remote: "origin",
          remoteBranch: "main",
        },
      ],
      directoryIds: [project.directories[0].id],
      sharedWriteConfirmed: true,
      override: false,
      workspaceMode: "worktree",
      kind: "scheduled",
      schedule: {
        name: "每日依赖漏洞与安全巡检",
        ruleText: "0 9 * * *",
        timezone: "Asia/Shanghai",
        prompt: "检查依赖并生成审计结果。仅回环 SDK 验收，不读取用户凭据。",
        providerId: saved.id,
        model: "u07-loopback",
        permission: "read",
        enabled: true,
      },
    });
    const committed = await creation.commit(intent.id);
    taskId = committed.taskId;
    taskDir = intent.taskDir;
    repoDir = join(taskDir, intent.repos[0].repoDir);
    scheduleId = (await taskOp(taskId, "task/scheduleList")).payload
      .schedules[0].scheduleId;
    writeFileSync(
      statePath,
      JSON.stringify({ taskId, scheduleId, taskDir, repoDir }),
    );
    await loadTrustedViews(views);
    await until(
      "window.pidock && document.querySelector('[data-testid=desktop-sidebar]')",
      "app ready",
    );
    check(
      "unconfigured execution names credential failure",
      (
        await taskOp(taskId, "task/scheduleRunNow", {
          scheduleId,
          label: "unconfigured fixture",
        })
      ).payload.run.result === "failed",
    );
    const select = await evaluate(
      `window.pidock.providerOp(${JSON.stringify({ taskId, op: "select", profileId: saved.id, modelId: "u07-loopback" })})`,
    );
    check("native provider installed", select.ok, select);
    if (width < 960) await click("展开导航");
    await click("设置");
    await until(
      "document.querySelector('[data-appearance-option=light]')",
      "appearance settings",
    );
    await evaluate(
      `document.querySelector('[data-appearance-option=${theme}]').click()`,
    );
    await until(
      `document.documentElement.dataset.theme===${JSON.stringify(theme)}`,
      "persisted actual theme",
    );
    await click("返回任务工作区");
    await click("定时任务");
    await until(
      "document.querySelector('[data-testid=schedule-detail]')",
      "S04 loaded",
    );
    await click("＋ 新建定时规则");
    await until(
      "document.querySelector('input[aria-label=定时任务]')?.checked",
      "new dedicated scheduled task entry",
    );
    check(
      "new rule creates dedicated scheduled task",
      await evaluate(
        "document.querySelector('input[aria-label=定时任务]').checked",
      ),
    );
    await capture(`${theme}-s04-create`);
    await click("取消");
    await click("定时任务");
    await until(
      "document.querySelector('[data-testid=schedule-detail]')",
      "S04 return",
    );
    await click("编辑 每日依赖漏洞与安全巡检");
    await until(
      "document.querySelector('[aria-label=编辑定时任务]')",
      "rule editor",
    );
    await evaluate(
      `(()=>{const el=document.querySelector('input[aria-label=规则]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify("每日 " + "长规则校验".repeat(24))});el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await click("校验并预览");
    await until(
      "document.querySelector('[role=alert]')",
      "long rule native refusal",
    );
    await capture(`${theme}-s04-long-rule-refusal`);
    await click("取消");
    await click("立即运行 每日依赖漏洞与安全巡检");
    const overlap = await taskOp(taskId, "task/scheduleRunNow", {
      scheduleId,
      label: "overlap fixture",
    });
    check(
      "overlap skipped without a new session",
      overlap.payload.run.result === "skipped" &&
        !overlap.payload.run.sessionId,
      overlap,
    );
    let completed;
    for (let n = 0; n < 300; n++) {
      completed = (await taskOp(taskId, "task/scheduleRuns")).payload.runs.find(
        (r) => r.result === "completed",
      );
      if (completed) break;
      await wait(50);
    }
    check(
      "real SDK scheduled execution completed with actual model and session",
      completed?.actualModel === "u07-loopback" && Boolean(completed.sessionId),
      completed,
    );
    await taskOp(taskId, "task/scheduleRunNow", {
      scheduleId,
      label: "u07 second run",
    });
    let runs;
    for (let n = 0; n < 300; n++) {
      runs = (await taskOp(taskId, "task/scheduleRuns")).payload.runs;
      if (runs.filter((r) => r.result === "completed").length === 2) break;
      await wait(50);
    }
    check(
      "two executions use distinct sessions in same task workspace",
      runs.filter((r) => r.result === "completed").length === 2 &&
        new Set(
          runs.filter((r) => r.result === "completed").map((r) => r.sessionId),
        ).size === 2 &&
        runs.every((r) => r.taskId === taskId),
      runs,
    );
    providerServer.close();
    await click("刷新");
    await until(
      "document.querySelectorAll('[data-schedule-run]').length===4",
      "runs rendered",
    );
    for (const selectedTheme of [theme]) {
      void selectedTheme;
      await capture(`${theme}-s04-runs`);
    }
    if (width < 960) {
      await evaluate(
        "document.querySelector('[data-schedule-run]:last-child').scrollIntoView({block:'end'})",
      );
      await capture(`${theme}-s04-history-scroll`);
    }
    await evaluate(
      `document.querySelector('[data-schedule-run="${completed.runId}"] button').click()`,
    );
    await until(
      "document.querySelector('[data-testid=desktop-conversation]') || document.querySelector('[aria-label=消息]')",
      "real session result",
    );
    check(
      "result navigation selects the original task/session",
      await evaluate(
        `document.body.innerText.includes(${JSON.stringify(completed.sessionId)})`,
      ),
    );
    const rootsReply = await taskOp(taskId, "task/fileRoots");
    const directoryRoot = rootsReply.payload.roots.find(
      (row) => row.kind === "shared-dir",
    );
    check(
      "real ordinary-directory root reported",
      Boolean(directoryRoot),
      rootsReply,
    );
    if (directoryRoot) {
      const diffReply = await evaluate(
        `window.pidock.taskOp(${JSON.stringify(taskId)},"task/fileDiff",{rootId:${JSON.stringify(directoryRoot.id)}}).catch(error=>({ok:false,error:String(error)}))`,
      );
      check(
        "plain directory names unsupported Git diff",
        !diffReply.ok && diffReply.error.includes("plain-dir-no-diff"),
        diffReply,
      );
    }
    await click("任务操作");
    await evaluate(
      "[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent.includes('归档当前任务')).click()",
    );
    await until(
      "document.querySelector('[aria-label=归档当前任务]')",
      "S05 archive choices",
    );
    for (const selectedTheme of [theme]) {
      void selectedTheme;
      await capture(`${theme}-s05-archive`);
    }
    await click("确认归档");
    await until(
      "document.querySelector('[data-testid=desktop-archive-page]')",
      "archive page",
    );
    check(
      "archive pauses schedule",
      (await taskOp(taskId, "task/scheduleList")).payload.schedules.every(
        (r) => !r.enabled,
      ),
    );
    writeFileSync(
      join(repoDir, "dirty-fixture.txt"),
      "uncommitted temporary worktree change\n",
    );
    await click("清理…");
    await click("生成清单");
    await until(
      "document.body.innerText.includes('未提交：有')",
      "real dirty risk",
    );
    await capture(`${theme}-s05-risk-blocked`);
    await evaluate(
      "[...document.querySelectorAll('input[type=radio]')].find(e=>e.parentElement.textContent.trim()==='清理').click()",
    );
    await click("生成清单");
    await until(
      "[...document.querySelectorAll('button')].some(e=>e.textContent==='确认清理')",
      "blocked clean preview",
    );
    await click("确认清理");
    await click("执行清理");
    await until(
      "document.body.innerText.includes('cleanup-repo-blocked')",
      "risk refusal",
    );
    check(
      "dirty cleanup refused and worktree retained",
      existsSync(join(repoDir, "dirty-fixture.txt")),
    );
    await capture(`${theme}-s05-risk-refused`);
    rmSync(join(repoDir, "dirty-fixture.txt"));
    git(repoDir, "branch", "--set-upstream-to=origin/main");
    await click("生成清单");
    await until(
      "document.body.innerText.includes('未提交：无')",
      "clean facts",
    );
    await evaluate(
      "[...document.querySelectorAll('input[type=radio]')].find(e=>e.parentElement.textContent.trim()==='清理').click()",
    );
    await click("生成清单");
    await until(
      "document.querySelector('button') && [...document.querySelectorAll('button')].some(e=>e.textContent==='确认清理')",
      "new preview",
    );
    await click("确认清理");
    await until(
      "document.querySelector('[data-testid=archive-cleanup-confirm]')",
      "cleanup confirm",
    );
    check(
      "cancel receives native confirmation focus",
      await evaluate("document.activeElement.textContent==='取消'"),
    );
    for (const selectedTheme of [theme]) {
      void selectedTheme;
      await capture(`${theme}-s05-cleanup`);
    }
    await click("取消");
    check("cancel did not remove worktree", existsSync(repoDir));
    await click("确认清理");
    await click("执行清理");
    await until(
      "document.body.innerText.includes('清理已执行')",
      "cleanup receipt",
    );
    check(
      "managed worktree removed and original checkout/shared directory retained",
      !existsSync(repoDir) &&
        existsSync(join(source, "README.md")) &&
        existsSync(join(shared, "keep.txt")) &&
        existsSync(join(remote, "HEAD")),
      { repoDir, source, shared },
    );
    const ready = (await taskOp(taskId, "task/lifecycleState")).payload
      .lifecycle.restore;
    check(
      "cleaned restore readiness truthful",
      ready.cleaned === true && ready.ready === false,
      ready,
    );
    await capture(`${theme}-s05-cleaned`);
  } else {
    ({ taskId, scheduleId, taskDir, repoDir } = JSON.parse(
      readFileSync(statePath, "utf8"),
    ));
    await loadTrustedViews(views);
    await until(
      "window.pidock && document.querySelector('[data-testid=desktop-sidebar]')",
      "cold app ready",
    );
    if (width < 960) await click("展开导航");
    await click("已归档");
    await until(
      `document.querySelector('[data-archived-task="${taskId}"]')`,
      "archived row after cold process restart",
    );
    check(
      "cold restart archive row and not-ready state",
      await evaluate("document.body.innerText.includes('该任务已清理')"),
    );
    for (const selectedTheme of [theme]) {
      void selectedTheme;
      await capture(`${theme}-restart-archived`);
    }
    await click("恢复");
    await wait(300);
    check(
      "restore does not enable schedule",
      (await taskOp(taskId, "task/scheduleList")).payload.schedules.every(
        (r) => !r.enabled,
      ),
    );
    check(
      "source preserved after restore",
      existsSync(join(source, "README.md")) &&
        existsSync(join(shared, "keep.txt")) &&
        !existsSync(repoDir),
    );
  }
  writeFileSync(join(output, `${width}x${height}-restart-root.txt`), root);
  const stopped = await shutdownTestRegistry(registry, {
    label: "u07 capture",
    origin,
  });
  check("all real Hosts released", stopped.length === 0, stopped);
  finish(0);
}
run().catch((error) => finish(1, error.stack));
