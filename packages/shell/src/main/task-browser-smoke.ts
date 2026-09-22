import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import path from "node:path";
import { app, BrowserWindow, WebContentsView } from "electron";
import type { Session, WebPreferences } from "electron";
import { TaskBrowser, type TaskTab } from "./task-browser.js";
import { TrustDomainRegistry } from "./trust-domain.js";

export type TaskBrowserSmokePhase = "prepare" | "verify";

type MaybeCheck = boolean | null;

export interface TaskBrowserSmokeChecks {
  distinctPartitions: MaybeCheck;
  pageHandlesBound: MaybeCheck;
  tabsShareTaskPartition: MaybeCheck;
  popupSharesTaskPartition: MaybeCheck;
  sameTaskStorageShared: MaybeCheck;
  popupReturnedToOpener: MaybeCheck;
  closeViewKeepsPartition: MaybeCheck;
  tabSwitch: MaybeCheck;
  closeTaskDoesNotAffectOther: MaybeCheck;
  restartRestored: MaybeCheck;
}

export interface TaskBrowserSmokeEvidence {
  origin: string;
  partitions: { alpha: string; beta: string };
  states: { alpha: string; beta: string; alphaCookie: string; betaCookie: string };
  tabWebContentsIds: { alpha: number[]; beta: number[] };
  popupWebContentsId: number | null;
}

export interface TaskBrowserSmokeSuccess {
  schema: "pidock.shell.s3-smoke.v1";
  ok: true;
  phase: TaskBrowserSmokePhase;
  electron: string;
  checks: TaskBrowserSmokeChecks;
  evidence: TaskBrowserSmokeEvidence;
}

export interface TaskBrowserSmokeFailure {
  schema: "pidock.shell.s3-smoke.v1";
  ok: false;
  phase: TaskBrowserSmokePhase;
  error: { stage: string; message: string };
  evidence: TaskBrowserSmokeEvidence;
}

export type TaskBrowserSmokeReport =
  | TaskBrowserSmokeSuccess
  | TaskBrowserSmokeFailure;

interface FixtureServer {
  origin: string;
  server: Server;
}

interface WindowStage {
  window: BrowserWindow;
  shellView: WebContentsView;
  registry: TrustDomainRegistry;
  alpha: TaskBrowser;
  beta: TaskBrowser;
}

const SAFE_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
} satisfies WebPreferences;

const PAGE_SCRIPT = String.raw`
(function () {
  function readAccount() {
    return localStorage.getItem("pidock.account") || "";
  }
  function readCookie() {
    var match = document.cookie.match(/(?:^|; )pidock_account=([^;]*)/);
    return match ? decodeURIComponent(match[1]) : "";
  }
  function render() {
    document.body.dataset.account = readAccount();
    document.body.dataset.cookieAccount = readCookie();
    document.body.textContent = "account=" + readAccount() + " cookie=" + readCookie();
  }
  window.addEventListener("message", function (event) {
    if (event.origin !== location.origin) return;
    if (!event.data || event.data.type !== "pidock-login") return;
    render();
  });
  render();
})();
`;

const LOGIN_SCRIPT = String.raw`
(function () {
  var account = new URLSearchParams(location.search).get("account") || "unknown";
  localStorage.setItem("pidock.account", account);
  document.cookie = "pidock_account=" + encodeURIComponent(account) + "; path=/; max-age=3600";
  location.replace("/page");
})();
`;

const POPUP_SCRIPT = String.raw`
(function () {
  var account = new URLSearchParams(location.search).get("account") || "unknown";
  localStorage.setItem("pidock.account", account);
  document.cookie = "pidock_account=" + encodeURIComponent(account) + "; path=/; max-age=3600";
  document.body.dataset.account = account;
  document.body.textContent = "popup account=" + account;
  if (window.opener) {
    window.opener.postMessage({ type: "pidock-login", account: account }, location.origin);
  }
})();
`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  label: string,
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 6000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined && value !== null && value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(50);
  }
  throw new Error(
    `${label} timed out${lastError ? `: ${errorMessage(lastError)}` : ""}`,
  );
}

function html(title: string, script: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${title}</title></head><body><script>${script}</script></body></html>`;
}

function fixtureResponse(pathname: string): string {
  if (pathname === "/login") return html("PiDock S3 Login", LOGIN_SCRIPT);
  if (pathname === "/popup") return html("PiDock S3 Popup", POPUP_SCRIPT);
  return html("PiDock S3 Page", PAGE_SCRIPT);
}

async function startFixtureServer(
  phase: TaskBrowserSmokePhase,
  originFile: string,
): Promise<FixtureServer> {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    });
    response.end(fixtureResponse(requestUrl.pathname));
  });

  let port = 0;
  if (phase === "verify") {
    const previousOrigin = readFileSync(originFile, "utf8").trim();
    const parsed = new URL(previousOrigin);
    port = Number(parsed.port);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`invalid persisted fixture origin: ${previousOrigin}`);
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server did not expose an IP address");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  if (phase === "prepare") {
    writeFileSync(originFile, `${origin}\n`, "utf8");
  }
  return { origin, server };
}

async function stopFixtureServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function shellPlaceholderUrl(): string {
  return `data:text/html,<title>PiDock S3 Shell</title><h1>PiDock S3</h1>`;
}

async function createStage(workspaceId: string): Promise<WindowStage> {
  const window = new BrowserWindow({
    width: 1400,
    height: 800,
    show: true,
    webPreferences: SAFE_WEB_PREFERENCES,
  });
  const shellView = new WebContentsView({ webPreferences: SAFE_WEB_PREFERENCES });
  const registry = new TrustDomainRegistry();
  registry.registerShell({
    webContentsId: shellView.webContents.id,
    viewId: "s3-shell-view",
    workspaceId,
  });
  window.contentView.addChildView(shellView);
  shellView.setBounds({ x: 0, y: 0, width: 240, height: 800 });
  shellView.setVisible(true);
  await shellView.webContents.loadURL(shellPlaceholderUrl());

  const alpha = new TaskBrowser({
    window,
    workspaceId,
    taskId: "s3-alpha",
    bounds: { x: 240, y: 0, width: 580, height: 800 },
    registry,
  });
  const beta = new TaskBrowser({
    window,
    workspaceId,
    taskId: "s3-beta",
    bounds: { x: 820, y: 0, width: 580, height: 800 },
    registry,
  });
  return { window, shellView, registry, alpha, beta };
}

interface PageState {
  account: string;
  cookie: string;
}

async function readPageState(tab: TaskTab): Promise<PageState> {
  const raw = await tab.view.webContents.executeJavaScript(
    String.raw`({
      account: localStorage.getItem("pidock.account") || "",
      cookie: (document.cookie.match(/(?:^|; )pidock_account=([^;]*)/) || [])[1] || ""
    })`,
    true,
  );
  if (!isRecord(raw)) throw new Error("fixture page state was not an object");
  const account = typeof raw["account"] === "string" ? raw["account"] : "";
  const cookie = typeof raw["cookie"] === "string" ? raw["cookie"] : "";
  return { account, cookie };
}

async function waitForPageState(
  tab: TaskTab,
  expected: string,
): Promise<PageState> {
  return waitFor(`page ${tab.pageId} state ${expected}`, async () => {
    const state = await readPageState(tab);
    return state.account === expected && state.cookie === expected
      ? state
      : undefined;
  });
}

async function readCookie(taskSession: Session, origin: string): Promise<string> {
  const cookies = await taskSession.cookies.get({ url: `${origin}/` });
  return cookies.find((cookie) => cookie.name === "pidock_account")?.value ?? "";
}

function responseEvidence(
  origin: string,
  alpha: TaskBrowser,
  beta: TaskBrowser,
): TaskBrowserSmokeEvidence {
  return {
    origin,
    partitions: { alpha: alpha.partition, beta: beta.partition },
    states: { alpha: "", beta: "", alphaCookie: "", betaCookie: "" },
    tabWebContentsIds: {
      alpha: alpha.tabs.map((tab) => tab.webContentsId),
      beta: beta.tabs.map((tab) => tab.webContentsId),
    },
    popupWebContentsId: null,
  };
}

async function prepareScenario(
  stage: WindowStage,
  origin: string,
): Promise<TaskBrowserSmokeSuccess> {
  const { alpha, beta } = stage;
  const evidence = responseEvidence(origin, alpha, beta);
  const alphaMain = await alpha.openTab(`${origin}/login?account=alpha`, "alpha-main");
  await waitForPageState(alphaMain, "alpha");
  const alphaTab = await alpha.openTab(`${origin}/page`, "alpha-tab");
  await waitForPageState(alphaTab, "alpha");

  const alphaMainBinding = stage.registry.requireTaskBinding(
    alphaMain.webContentsId,
    { taskId: alpha.taskId, pageId: alphaMain.pageId },
  );
  const alphaTabBinding = stage.registry.requireTaskBinding(
    alphaTab.webContentsId,
    { taskId: alpha.taskId, pageId: alphaTab.pageId },
  );
  const alphaHandlesBound =
    alphaMainBinding.taskId === alpha.taskId &&
    alphaTabBinding.pageId === "alpha-tab";

  const tabsShareTaskPartition =
    alphaMain.view.webContents.session === alpha.session &&
    alphaTab.view.webContents.session === alpha.session &&
    alphaMain.view.webContents.session === alphaTab.view.webContents.session;
  const firstAlphaState = await readPageState(alphaMain);
  const secondAlphaState = await readPageState(alphaTab);
  const sameTaskStorageShared =
    firstAlphaState.account === "alpha" &&
    firstAlphaState.cookie === "alpha" &&
    secondAlphaState.account === "alpha" &&
    secondAlphaState.cookie === "alpha";

  await alphaTab.view.webContents.executeJavaScript(
    String.raw`window.open("/popup?account=alpha-popup", "pidock-login", "width=420,height=320"); true`,
    true,
  );
  const popup = await waitFor("task popup creation", () => alpha.popups[0]);
  const popupBinding = stage.registry.requireTaskBinding(popup.webContentsId, {
    taskId: alpha.taskId,
    pageId: popup.pageId,
  });
  const popupSharesTaskPartition =
    popup.window.webContents.session === alpha.session &&
    popupBinding.taskId === alpha.taskId;
  await waitForPageState(alphaTab, "alpha-popup");
  const popupReturnedToOpener =
    popup.openerPageId === "alpha-tab" &&
    (await readPageState(alphaTab)).account === "alpha-popup";
  popup.window.close();
  await waitFor("task popup closure", () => alpha.popups.length === 0 || undefined);

  const alphaBeforeReopen = await readPageState(alphaTab);
  alpha.closeTab("alpha-main");
  alpha.closeTab("alpha-tab");
  const alphaHandlesRemoved =
    stage.registry.get(alphaMain.webContentsId) === undefined &&
    stage.registry.get(alphaTab.webContentsId) === undefined;
  const alphaReopened = await alpha.openTab(`${origin}/page`, "alpha-reopened");
  const alphaAfterReopen = await waitForPageState(alphaReopened, "alpha-popup");
  const alphaReopenedBinding = stage.registry.requireTaskBinding(
    alphaReopened.webContentsId,
    { taskId: alpha.taskId, pageId: alphaReopened.pageId },
  );
  const alphaExtra = await alpha.openTab(`${origin}/page`, "alpha-extra");
  await waitForPageState(alphaExtra, "alpha-popup");
  const alphaExtraBinding = stage.registry.requireTaskBinding(
    alphaExtra.webContentsId,
    { taskId: alpha.taskId, pageId: alphaExtra.pageId },
  );
  const closeViewKeepsPartition =
    alphaHandlesRemoved &&
    alphaBeforeReopen.account === alphaAfterReopen.account &&
    alphaBeforeReopen.cookie === alphaAfterReopen.cookie;

  alpha.activateTab("alpha-reopened");
  const activeAlpha = alpha.activeTab;
  const tabSwitch =
    activeAlpha?.pageId === "alpha-reopened" &&
    alphaReopened.view.getVisible() === true &&
    alphaExtra.view.getVisible() === false;
  alpha.activateTab("alpha-extra");

  const betaMain = await beta.openTab(`${origin}/login?account=beta`, "beta-main");
  await waitForPageState(betaMain, "beta");
  const alphaState = await readPageState(alphaReopened);
  const betaState = await readPageState(betaMain);
  const alphaCookie = await readCookie(alpha.session, origin);
  const betaCookie = await readCookie(beta.session, origin);

  alpha.close();
  const alphaAllHandlesRemoved = [
    alphaMain.webContentsId,
    alphaTab.webContentsId,
    alphaReopened.webContentsId,
    alphaExtra.webContentsId,
    popup.webContentsId,
  ].every((webContentsId) => stage.registry.get(webContentsId) === undefined);
  const betaSurvived =
    !betaMain.view.webContents.isDestroyed() &&
    (await readPageState(betaMain)).account === "beta" &&
    alpha.tabs.length === 0;
  await Promise.all([
    alpha.session.flushStorageData(),
    beta.session.flushStorageData(),
  ]);

  evidence.states = {
    alpha: alphaState.account,
    beta: betaState.account,
    alphaCookie,
    betaCookie,
  };
  evidence.tabWebContentsIds = {
    alpha: [
      alphaMain.webContentsId,
      alphaTab.webContentsId,
      alphaReopened.webContentsId,
      alphaExtra.webContentsId,
    ],
    beta: [betaMain.webContentsId],
  };
  evidence.popupWebContentsId = popup.webContentsId;
  const checks: TaskBrowserSmokeChecks = {
    distinctPartitions: alpha.partition !== beta.partition && alpha.session !== beta.session,
    pageHandlesBound:
      alphaHandlesBound &&
      alphaHandlesRemoved &&
      alphaReopenedBinding.taskId === alpha.taskId &&
      alphaExtraBinding.taskId === alpha.taskId &&
      alphaAllHandlesRemoved,
    tabsShareTaskPartition,
    popupSharesTaskPartition,
    sameTaskStorageShared,
    popupReturnedToOpener,
    closeViewKeepsPartition,
    tabSwitch,
    closeTaskDoesNotAffectOther: betaSurvived,
    restartRestored: null,
  };

  assert(
    checks.distinctPartitions &&
      checks.pageHandlesBound &&
      checks.tabsShareTaskPartition &&
      checks.popupSharesTaskPartition &&
      checks.sameTaskStorageShared &&
      checks.popupReturnedToOpener &&
      checks.closeViewKeepsPartition &&
      checks.tabSwitch &&
      checks.closeTaskDoesNotAffectOther,
    `prepare checks failed: ${JSON.stringify(checks)}`,
  );
  return {
    schema: "pidock.shell.s3-smoke.v1",
    ok: true,
    phase: "prepare",
    electron: process.versions["electron"] ?? "unknown",
    checks,
    evidence,
  };
}

async function verifyScenario(
  stage: WindowStage,
  origin: string,
): Promise<TaskBrowserSmokeSuccess> {
  const { alpha, beta } = stage;
  const alphaTab = await alpha.openTab(`${origin}/page`, "alpha-verify");
  const betaTab = await beta.openTab(`${origin}/page`, "beta-verify");
  const alphaState = await waitForPageState(alphaTab, "alpha-popup");
  const betaState = await waitForPageState(betaTab, "beta");
  const alphaBinding = stage.registry.requireTaskBinding(alphaTab.webContentsId, {
    taskId: alpha.taskId,
    pageId: alphaTab.pageId,
  });
  const betaBinding = stage.registry.requireTaskBinding(betaTab.webContentsId, {
    taskId: beta.taskId,
    pageId: betaTab.pageId,
  });
  const pageHandlesBound =
    alphaBinding.taskId === alpha.taskId && betaBinding.taskId === beta.taskId;
  const alphaCookie = await readCookie(alpha.session, origin);
  const betaCookie = await readCookie(beta.session, origin);
  const distinctPartitions = alpha.partition !== beta.partition && alpha.session !== beta.session;
  const tabsShareTaskPartition =
    alphaTab.view.webContents.session === alpha.session &&
    betaTab.view.webContents.session === beta.session;
  const sameTaskStorageShared =
    alphaState.cookie === alphaState.account &&
    betaState.cookie === betaState.account;
  const restartRestored =
    alphaState.account === "alpha-popup" &&
    alphaState.cookie === "alpha-popup" &&
    betaState.account === "beta" &&
    betaState.cookie === "beta" &&
    alphaCookie === "alpha-popup" &&
    betaCookie === "beta";
  await Promise.all([
    alpha.session.flushStorageData(),
    beta.session.flushStorageData(),
  ]);

  const checks: TaskBrowserSmokeChecks = {
    distinctPartitions,
    pageHandlesBound,
    tabsShareTaskPartition,
    popupSharesTaskPartition: null,
    sameTaskStorageShared,
    popupReturnedToOpener: null,
    closeViewKeepsPartition: null,
    tabSwitch: null,
    closeTaskDoesNotAffectOther: null,
    restartRestored,
  };
  assert(
    checks.distinctPartitions &&
      checks.pageHandlesBound &&
      checks.tabsShareTaskPartition &&
      checks.sameTaskStorageShared &&
      checks.restartRestored,
    `verify checks failed: ${JSON.stringify(checks)}`,
  );

  return {
    schema: "pidock.shell.s3-smoke.v1",
    ok: true,
    phase: "verify",
    electron: process.versions["electron"] ?? "unknown",
    checks,
    evidence: {
      origin,
      partitions: { alpha: alpha.partition, beta: beta.partition },
      states: {
        alpha: alphaState.account,
        beta: betaState.account,
        alphaCookie,
        betaCookie,
      },
      tabWebContentsIds: {
        alpha: [alphaTab.webContentsId],
        beta: [betaTab.webContentsId],
      },
      popupWebContentsId: null,
    },
  };
}

export async function runTaskBrowserSmoke(
  workspaceId: string,
  phase: TaskBrowserSmokePhase,
): Promise<TaskBrowserSmokeReport> {
  const originFile =
    process.env["PIDOCK_S3_ORIGIN_FILE"] ??
    path.join(app.getPath("userData"), "s3-origin.txt");
  const evidence: TaskBrowserSmokeEvidence = {
    origin: "pending",
    partitions: { alpha: "pending", beta: "pending" },
    states: { alpha: "", beta: "", alphaCookie: "", betaCookie: "" },
    tabWebContentsIds: { alpha: [], beta: [] },
    popupWebContentsId: null,
  };
  let stage = "fixture-server";
  let fixture: FixtureServer | undefined;
  let windowStage: WindowStage | undefined;

  try {
    fixture = await startFixtureServer(phase, originFile);
    evidence.origin = fixture.origin;

    stage = "window-stage";
    windowStage = await createStage(workspaceId);
    evidence.partitions = {
      alpha: windowStage.alpha.partition,
      beta: windowStage.beta.partition,
    };

    if (phase === "prepare") {
      return await prepareScenario(windowStage, fixture.origin);
    }
    return await verifyScenario(windowStage, fixture.origin);
  } catch (error) {
    return {
      schema: "pidock.shell.s3-smoke.v1",
      ok: false,
      phase,
      error: { stage, message: errorMessage(error) },
      evidence,
    };
  } finally {
    windowStage?.alpha.close();
    windowStage?.beta.close();
    windowStage?.window.destroy();
    await stopFixtureServer(fixture?.server).catch(() => undefined);
  }
}
